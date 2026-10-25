import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/index.js';
import { composeMcpRuntime, CONNECTOR_REARM_INTERVAL_MS, CONNECTOR_RECOVERY_DELAYS_MS, createRecoverySchedule, identityFailureRetryable } from '../host/mcp.js';
import { connectionReasonCode } from '../http/server.js';
import { bindCalendarFirstConnect, bindCalendarRecovery } from '../host/runtime.js';
import { CalendarDigestCache } from '../live/warm-context.js';
import { safeEvent } from '../host/log.js';
import { proveIdentity, type IdentitySource } from '../connectors/identity.js';
import { MONGOOSE_ENDPOINTS, mongooseCredentialAtStart } from '../connectors/mongoose.js';
import type { ConnectorResult } from '../connectors/index.js';

const ACCOUNT = 'owner@example.test';
const FAST = [10, 10, 10];

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * A synthetic, stateless Mongoose endpoint that counts every discovery request. Stateless on purpose: the
 * host retires a failed session, and a per-session transport would stop answering after that retirement.
 */
interface FixtureOptions {
  tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
  /** Per tool call: how long the answer takes and the JSON payload it carries. */
  call?: (tool: string) => { delayMs?: number; payload: unknown };
  /** The endpoint's own token route, so a refresh can be made to fail the way the owner's Mac saw it. */
  token?: (res: ServerResponse) => void;
  /** #671: which tool call answers 503, the transient unavailability the owner's Mac reported. */
  unavailableCall?: (index: number) => boolean;
}

async function fixture(options: FixtureOptions = {}) {
  let requests = 0;
  let calls = 0;
  const listener = createServer(async (req, res) => {
    try {
      const bytes = await body(req);
      if ((req.method ?? 'GET') === 'DELETE') { res.writeHead(200); res.end(); return; }
      if (req.url === '/oauth/token') { options.token?.(res); return; }
      const sdk = new Server({ name: 'synthetic-mongoose', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      sdk.setRequestHandler('tools/list', () => {
        requests += 1;
        return { tools: options.tools ?? [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } as never;
      });
      sdk.setRequestHandler('tools/call', async request => {
        calls += 1;
        if (options.unavailableCall?.(calls) === true) { res.writeHead(503); res.end(); return {} as never; }
        const tool = (request.params as { name: string }).name;
        const answer = options.call?.(tool) ?? { payload: {} };
        await new Promise(resolve => setTimeout(resolve, answer.delayMs ?? 0));
        return { content: [{ type: 'text', text: JSON.stringify(answer.payload) }] } as never;
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await sdk.connect(transport);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? 'POST', headers, ...(bytes.length ? { body: new Uint8Array(bytes) } : {}) });
      const response = await transport.handleRequest(request);
      const text = await response.text();
      await sdk.close().catch(() => {});
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  // No keep-alive: a pooled socket would make close() wait out Node's five second keep-alive timeout.
  listener.keepAliveTimeout = 0;
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests: () => requests,
    async close() {
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    },
  };
}

/** Poll a real state change instead of sleeping a fixed span: the recovery round is the thing awaited. */
async function until(done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the recovery round');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * The three release-1023b endpoints at the fixture origin; the knowledge endpoint is the one these
 * recovery tests exercise, so it carries the reference under test and the other two are parked.
 */
function configDirFor(url: string, credentialRef: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'didi-connect-recovery-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads',
    endpoints: MONGOOSE_ENDPOINTS.map(endpoint => ({
      id: `mongoose-${endpoint}`, transport: 'streamable-http', url: `${url}/${endpoint}`, connector: 'mongoose',
      account: ACCOUNT, resource: `mongoose:${endpoint}`, credentialRef: endpoint === 'knowledge' ? credentialRef : `mongoose-${endpoint}`,
      enabled: true, allowEgress: true, unknownClass: 'ordinary',
    })),
  }), { mode: 0o600 });
  return configDir;
}

/** One schemaVersion 2 record, bound to the knowledge endpoint the seeded reference names. */
function oauthRecord(configDir: string, reference: string, fields: { refreshToken: string; expiresAt: number; consentStartedAt: number }): void {
  writeFileSync(join(configDir, `${reference}.json`), JSON.stringify({
    schemaVersion: 2, base: 'https://mongoose.example.test', clientId: 'client', redirectPort: 45871,
    account: ACCOUNT, endpoint: 'knowledge', audience: 'mongoose:knowledge', accessToken: 'current-access',
    refreshToken: fields.refreshToken, expiresAt: fields.expiresAt, consentStartedAt: fields.consentStartedAt,
  }), { mode: 0o600 });
}

test('a retryable failure gets exactly the bounded recovery round, one probe at a time', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ran: number[] = [];
    const schedule = createRecoverySchedule(FAST);
    const probe = (): void => { ran.push(ran.length + 1); };
    assert.equal(schedule.next('mongoose', probe), true);
    assert.equal(schedule.pending('mongoose'), true);
    assert.equal(schedule.attempts('mongoose'), 1);
    // A second request while one is pending never starts a second timer.
    assert.equal(schedule.next('mongoose', probe), true);
    assert.equal(schedule.attempts('mongoose'), 1);
    mock.timers.tick(FAST[0]!);
    assert.deepEqual(ran, [1]);
    assert.equal(schedule.pending('mongoose'), false);
    assert.equal(schedule.attempts('mongoose'), 1);
    // Stop is the explicit reconnect: the counter starts over.
    schedule.stop('mongoose');
    assert.equal(schedule.attempts('mongoose'), 0);
    assert.equal(CONNECTOR_RECOVERY_DELAYS_MS.length, 3);
  } finally { mock.timers.reset(); }
});

test('the schedule gives up after every delay and stays stopped', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const schedule = createRecoverySchedule([1, 1, 1]);
    let runs = 0;
    const step = (): void => { runs += 1; schedule.next('mongoose', step); };
    schedule.next('mongoose', step);
    mock.timers.tick(1); mock.timers.tick(1); mock.timers.tick(1); mock.timers.tick(1);
    assert.equal(runs, 3, 'three attempts after the failure, never more');
    assert.equal(schedule.pending('mongoose'), false);
    assert.equal(schedule.next('mongoose', () => { runs += 1; }), false, 'the round is spent');
    schedule.stopAll();
  } finally { mock.timers.reset(); }
});

test('an identity probe that ran out of time is inconclusive and retryable, a mismatch is not', async () => {
  const source: IdentitySource = { tool: 'get_profile', args: {}, values: decoded => [String((decoded as { id?: unknown }).id)] };
  const slow = await proveIdentity({ source, expected: [ACCOUNT], timeoutMs: 5, call: () => new Promise<ConnectorResult>(() => {}) });
  assert.equal(slow.proven, false);
  assert.equal(slow.code, 'identity_timeout', 'a timeout is its own closed code, never a mismatch');
  assert.equal(identityFailureRetryable(slow), true, 'and it schedules recovery');
  const mismatch = await proveIdentity({ source, expected: [ACCOUNT], timeoutMs: 50, call: async () => ({ state: 'completed', decodedResult: { id: 'other@example.test' } } as unknown as ConnectorResult) });
  assert.equal(mismatch.match, false);
  assert.equal(identityFailureRetryable(mismatch), false, 'a mismatch stays failed until the next reconnect');
});

test('a transport timeout is unreachable, a known cancellation is not, and nothing falls through to unknown', () => {
  assert.equal(connectionReasonCode({ state: 'error', error: 'timeout-or-cancelled', signIn: true }), 'unreachable');
  assert.equal(connectionReasonCode({ state: 'error', error: 'identity_timeout', signIn: false }), 'unreachable');
  assert.equal(connectionReasonCode({ state: 'error', error: 'ECONNREFUSED', signIn: false }), 'unreachable');
  assert.equal(connectionReasonCode({ state: 'error', error: 'cancelled', signIn: false }), 'unknown');
  assert.equal(connectionReasonCode({ state: 'error', error: 'not_signed_in', signIn: true }), 'needs_sign_in');
  assert.equal(connectionReasonCode({ state: 'error', error: 'credential-refresh-failed', signIn: true }), 'needs_sign_in');
  assert.equal(connectionReasonCode({ state: 'error', error: 'identity_mismatch', signIn: false }), 'identity_mismatch');
});

test('a mongoose credential verdict needs refresh material and no expired consent, and never reads an access token expiry', () => {
  assert.equal(mongooseCredentialAtStart('mongoose', { hasRefreshMaterial: true, consentExpired: false }), 'probe');
  assert.equal(mongooseCredentialAtStart('mongoose', { hasRefreshMaterial: false, consentExpired: false }), 'not_signed_in');
  assert.equal(mongooseCredentialAtStart('mongoose', { hasRefreshMaterial: true, consentExpired: true }), 'not_signed_in');
  assert.equal(mongooseCredentialAtStart('gmail', { hasRefreshMaterial: false, consentExpired: true }), 'probe');
});

test('a mongoose record with no refresh material is parked for sign-in and the transport is never called', async t => {
  const f = await fixture(); t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: '   ', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-store-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
  t.after(() => runtime.close());
  const report = runtime.status().endpoints[0]!;
  assert.equal(report.state, 'error');
  assert.equal(report.reasonCode, 'not_signed_in');
  assert.equal(report.retrying, false);
  assert.equal(connectionReasonCode({ state: report.state, error: report.error ?? '', signIn: true }), 'needs_sign_in');
  assert.equal(f.requests(), 0, 'conclusive local evidence costs no wire call');
});

test('an expired access token with refresh material is not a local sign-in verdict', async t => {
  const f = await fixture(); t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: 'refresh-material', expiresAt: Date.now() - 60_000, consentStartedAt: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-store-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
  t.after(() => runtime.close());
  const report = runtime.status().endpoints[0]!;
  assert.notEqual(report.reasonCode, 'not_signed_in', 'an expired token alone is not conclusive, so nothing parked it locally');
  assert.match(String(report.error ?? ''), /^credential/, 'the refresh path ran, which is the only thing that can decide it');
});

test('a consent family past its cap is parked for sign-in with no wire call', async t => {
  const f = await fixture(); t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: 'refresh-material', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() - 91 * 24 * 60 * 60 * 1000 });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-store-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
  t.after(() => runtime.close());
  const report = runtime.status().endpoints[0]!;
  assert.equal(report.reasonCode, 'not_signed_in');
  assert.equal(connectionReasonCode({ state: report.state, error: report.error ?? '', signIn: true }), 'needs_sign_in');
  assert.equal(f.requests(), 0);
});

test('a retryable first call failure retries a bounded number of times and then stops', async t => {
  // A discovery timeout is a five second wait by construction, which no test here may take; the timeout
  // cause itself is asserted at the projection above. This drives the same retryable first_call path with
  // a fast closed cause: a tool definition the client refuses.
  const f = await fixture({ tools: [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: [], required: 'not-an-array' } }] }); t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: 'refresh-material', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-store-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryDelaysMs: FAST });
  t.after(() => runtime.close());
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.state, 'error', 'the endpoint did not connect');
  assert.equal(failed.retrying, true, 'a retry is scheduled');
  assert.equal(f.requests(), 1);
  // Wait on the wire, not on the flag: `retrying` is briefly false between two scheduled attempts.
  await until(() => f.requests() === 4, 2000);
  assert.equal(f.requests(), 4, 'the first connect plus exactly three bounded retries');
  await until(() => runtime.status().endpoints[0]!.retrying === false, 2000);
  assert.equal(runtime.status().endpoints[0]!.retrying, false, 'the round is over and no further attempt is pending');
});

/** Two Google endpoints of one owner account, each proving itself with its own family's tool. */
function googleConfig(url: string, id: string, resource: string): Record<string, unknown> {
  return { id, transport: 'streamable-http', url, connector: 'google', account: ACCOUNT, resource, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' };
}

const GMAIL_TOOLS = [{ name: 'gmail_get_profile', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
const CALENDAR_TOOLS = [{ name: 'calendar_list_calendars', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];

test('a gmail proof that runs out of time is retried until it proves the account, and calendar is never touched', async t => {
  let gmailProbes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => {
    gmailProbes += 1;
    // The first probe comes back without an account, which is what the owner's session saw; the retry answers.
    return gmailProbes === 1 ? { payload: {} } : { payload: { emailAddress: ACCOUNT } };
  } });
  t.after(() => gmail.close());
  const calendar = await fixture({ tools: CALENDAR_TOOLS, call: () => ({ payload: { calendars: [{ id: ACCOUNT, primary: true }] } }) });
  t.after(() => calendar.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-recovery-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail'), googleConfig(calendar.url, 'calendar', 'calendar')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const identity: Array<{ connector: string; proven: boolean; match: boolean | null; endpointId: string }> = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 2000, recoveryDelaysMs: FAST,
    identityLog: (connector, proven, match, endpointId) => { identity.push({ connector, proven, match, endpointId: endpointId ?? '' }); },
  });
  t.after(() => runtime.close());
  const first = runtime.status().endpoints;
  const calendarFirst = first.find(row => row.id === 'calendar')!;
  const gmailFirst = first.find(row => row.id === 'gmail')!;
  assert.equal(gmailFirst.state, 'error', 'the slow proof left gmail unproven');
  assert.equal(gmailFirst.reasonCode, 'identity_unverified', 'an unproven proof, never a mismatch');
  assert.equal(gmailFirst.retrying, true, 'so recovery is scheduled instead of staying down all session');
  assert.equal(calendarFirst.state, 'connected', 'calendar proved itself and never depended on gmail');
  assert.equal(calendarFirst.error, undefined);
  // The retry answers immediately: gmail ends connected and calendar keeps its own state and handshake.
  await until(() => runtime.status().endpoints.some(row => row.id === 'gmail' && row.state === 'connected'));
  const settled = runtime.status().endpoints;
  const gmailAfter = settled.find(row => row.id === 'gmail')!;
  const calendarAfter = settled.find(row => row.id === 'calendar')!;
  assert.equal(gmailAfter.state, 'connected');
  assert.equal(gmailAfter.retrying, false);
  assert.equal(gmailAfter.error, undefined);
  assert.ok(runtime.registry.currentGrant('gmail'), 'the retried proof published a grant');
  assert.deepEqual({ state: calendarAfter.state, lastHandshakeAt: calendarAfter.lastHandshakeAt },
    { state: calendarFirst.state, lastHandshakeAt: calendarFirst.lastHandshakeAt }, 'calendar was never re-probed');
  // One receipt per probe: gmail's unproven proof, then gmail's own retry, and calendar's single proof.
  assert.equal(identity.length, 3, 'calendar once, gmail twice');
  assert.equal(identity.filter(entry => !entry.proven).length, 1, 'only gmail was unproven, and only once');
  assert.equal(identity.filter(entry => entry.proven).length, 2);
});

// --- 671: an inconclusive proof at host start recovers in the same bounded round, and every unavailable
// source says which state marked it ---

test('671: a start-time identity proof that runs out of time is retried and proves the account', async t => {
  let gmailProbes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => {
    gmailProbes += 1;
    // The first proof never answers inside the call deadline, which is what the host saw at start;
    // the retry answers with the owner's own address.
    return gmailProbes === 1 ? { payload: {}, delayMs: 400 } : { payload: { emailAddress: ACCOUNT } };
  } });
  t.after(() => gmail.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-probe-timeout-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const identity: Array<{ proven: boolean; endpointId: string }> = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 120, recoveryDelaysMs: FAST,
    identityLog: (_connector, proven, _match, endpointId) => { identity.push({ proven, endpointId: endpointId ?? '' }); },
  });
  t.after(() => runtime.close());
  const first = runtime.status().endpoints[0]!;
  assert.equal(first.state, 'error', 'the timed out proof left gmail unproven');
  assert.equal(first.retrying, true, 'an inconclusive proof enters the bounded round instead of staying down');
  await until(() => runtime.status().endpoints[0]!.state === 'connected', 4000);
  const after = runtime.status().endpoints[0]!;
  assert.equal(after.state, 'connected', 'the retry reached connected');
  assert.equal(after.retrying, false);
  assert.ok(runtime.registry.currentGrant('gmail'), 'the retried proof published a grant');
  assert.ok(gmailProbes >= 2, 'the retry reached the wire again');
  assert.deepEqual(identity.filter(row => !row.proven).map(row => row.endpointId), ['gmail'], 'one unproven receipt at start');
  assert.equal(identity[identity.length - 1]!.proven, true, 'and the retried proof is the one that stuck');
});

test('671: a transport loss on a connected endpoint marks the source unavailable on one closed log line', async t => {
  // The second wire call (the first read after the proof) answers 503: the transient unavailability the
  // owner saw as a read that came back unavailable at 0 ms.
  const gmail = await fixture({ tools: GMAIL_TOOLS, unavailableCall: index => index === 2, call: () => ({ payload: { emailAddress: ACCOUNT } }) });
  t.after(() => gmail.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-transport-loss-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  // Typed loosely on purpose: the line is new, so this test is the one that admits it.
  const lifecycle: Array<{ event: string; endpointId?: string; reason?: string }> = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 2000, recoveryDelaysMs: FAST,
    lifecycleLog: event => { lifecycle.push(event as unknown as { event: string; endpointId?: string; reason?: string }); },
  });
  t.after(() => runtime.close());
  const connected = runtime.status().endpoints[0]!;
  assert.equal(connected.state, 'connected', 'the proof landed and published a read grant');
  const grant = runtime.registry.currentGrant('gmail')!;
  const read = await runtime.port.call({ endpointId: 'gmail', toolName: 'gmail_get_profile', arguments: {}, generation: grant.generation, account: grant.account, resource: grant.resource });
  assert.equal(read.state, 'unknown', 'the 503 is a transport failure, not a protocol answer');
  const unavailable = lifecycle.filter(entry => entry.event === 'connector_unavailable');
  assert.equal(unavailable.length, 1, `one line per mark, not one per read: saw ${JSON.stringify(lifecycle)}`);
  assert.deepEqual(unavailable[0], { event: 'connector_unavailable', endpointId: 'gmail', reason: 'transport_unavailable' });
  // The log admits the new line only with its closed keys, and never free text or a url.
  assert.deepEqual(safeEvent({ event: 'connector_unavailable', endpointId: 'gmail', reason: 'transport_unavailable' }),
    { event: 'connector_unavailable', endpointId: 'gmail', reason: 'transport_unavailable' });
  assert.equal(safeEvent({ event: 'connector_unavailable', endpointId: 'gmail', reason: 'transport_unavailable', url: 'http://x' }), undefined,
    'closed keys only');
  // The loss was transient: the same bounded round brings the source back.
  await until(() => runtime.status().endpoints[0]!.state === 'connected', 4000);
  assert.equal(runtime.status().endpoints[0]!.state, 'connected');
});

// --- 671-R2: every recovery attempt says its closed reason, and a read earns one fresh attempt after
// a round spent on a retryable reason ---

test('671-R2: a recovery attempt writes its own closed reason line, first connect and retry alike', async t => {
  // The probe never answers inside the call deadline, so every attempt times out: the closed code is the
  // one thing the owner's 10-22 log could not show.
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => ({ payload: {}, delayMs: 400 }) });
  t.after(() => gmail.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-attempt-reason-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const failures: Array<{ stage: string; attempt?: string; reason?: string; endpointId?: string }> = [];
  const identity: Array<{ proven: boolean; code?: string }> = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 120, recoveryDelaysMs: FAST,
    connectorLog: (_connector, stage, detail) => { failures.push({ stage, ...(detail ?? {}) }); },
    identityLog: (_connector, proven, _match, _endpointId, code) => { identity.push({ proven, ...(code === undefined ? {} : { code }) }); },
  });
  t.after(() => runtime.close());
  await until(() => failures.length >= 1 + FAST.length, 4000);
  assert.equal(failures.length, 1 + FAST.length, 'the first connect and every retry, not only the first');
  assert.equal(failures[0]!.attempt, 'first-connect');
  assert.deepEqual(failures.slice(1).map(row => row.attempt), ['refresh', 'refresh', 'refresh'], 'each retry names its own pass');
  assert.deepEqual([...new Set(failures.map(row => row.reason))], ['identity_timeout'], 'a timed out probe says so, never a bare identity_unverified');
  assert.deepEqual([...new Set(failures.map(row => row.stage))], ['handshake']);
  assert.equal(identity.filter(row => !row.proven && row.code === 'identity_timeout').length, 1 + FAST.length, 'every receipt carries the closed code');
  // The log admits the code on the receipt, and a non-token code is refused.
  assert.deepEqual(safeEvent({ event: 'connector_identity', connector: 'google', proven: false, match: null, endpointId: 'gmail', code: 'identity_timeout' }),
    { event: 'connector_identity', connector: 'google', proven: false, match: null, endpointId: 'gmail', code: 'identity_timeout' });
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'google', proven: false, match: null, endpointId: 'gmail', code: 'not a code' }), undefined,
    'a closed token only');
});

test('671-R2: a read earns one fresh attempt per interval after a round spent on a retryable reason', async t => {
  let probes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => { probes += 1; return { payload: {} }; } });
  t.after(() => gmail.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-rearm-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  // The clock is injected, so the two minute window is measured, never waited out.
  let clock = 5_000_000;
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    now: () => clock, recoveryDelaysMs: FAST,
  });
  t.after(() => runtime.close());
  // Enough probes for the first connect plus the whole bounded round, every one of them unproven.
  const spent = 1 + FAST.length;
  await until(() => probes >= spent, 4000);
  assert.equal(runtime.status().endpoints[0]!.retrying, false, 'the bounded round is spent');
  assert.equal(CONNECTOR_REARM_INTERVAL_MS, 120_000, 'the interval is two minutes');
  // A read one millisecond short of the interval earns nothing.
  clock += CONNECTOR_REARM_INTERVAL_MS - 1;
  runtime.connectionIds();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(probes, spent, 'a read inside the interval never re-arms');
  // A read at the interval earns exactly one fresh attempt, and a second read earns none.
  clock += 1;
  runtime.connectionIds();
  await until(() => probes === spent + 1, 4000);
  assert.equal(probes, spent + 1, 'one fresh attempt, no more');
  runtime.connectionIds();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(probes, spent + 1, 'a second read in the same window earns nothing');
  // The fresh attempt failed retryably, so the next window is two minutes after that attempt.
  clock += CONNECTOR_REARM_INTERVAL_MS;
  runtime.connectionIds();
  await until(() => probes === spent + 2, 4000);
  assert.equal(probes, spent + 2, 'the endpoint is not left down for the rest of the session');
});

test('671-R2: a non-retryable reason never re-arms, however often a read asks', async t => {
  let probes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => { probes += 1; return { payload: { emailAddress: 'someone-else@example.test' } }; } });
  t.after(() => gmail.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-rearm-refused-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  let clock = 7_000_000;
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    now: () => clock, recoveryDelaysMs: FAST,
  });
  t.after(() => runtime.close());
  const first = runtime.status().endpoints[0]!;
  assert.equal(first.reasonCode, 'identity_mismatch', 'a mismatch is conclusive');
  assert.equal(first.retrying, false, 'and it never schedules a round');
  for (let window = 0; window < 3; window += 1) {
    clock += CONNECTOR_REARM_INTERVAL_MS * 2;
    runtime.connectionIds();
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(probes, 1, 'no read ever re-runs a refused proof');
});

// --- 1022: a sign-in is never asked for a network blip, a recovery says so, and a pinned helper is replaced ---

/** The same record the login writer produces, pointed at the fixture's own token route. */
function oauthRecordAt(configDir: string, base: string): void {
  writeFileSync(join(configDir, 'mongoose-knowledge.json'), JSON.stringify({
    schemaVersion: 2, base, clientId: 'client', redirectPort: 45871,
    account: ACCOUNT, endpoint: 'knowledge', audience: 'mongoose:knowledge',
    accessToken: 'current-access', refreshToken: 'refresh-token-1', expiresAt: 1, consentStartedAt: Date.now(),
  }), { mode: 0o600 });
}

type Lifecycle = { event: string; endpointId: string; attempts?: number; reason?: string; connectMs?: number; bytes?: number };

async function mongooseRuntime(t: { after: (fn: () => void) => void }, f: { url: string; close: () => Promise<void> }) {
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecordAt(configDir, f.url.replace(/\/mcp$/, ''));
  const dir = mkdtempSync(join(tmpdir(), 'didi-mongoose-unreachable-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    recoveryDelaysMs: FAST, lifecycleLog: event => { lifecycle.push(event as Lifecycle); } });
  t.after(() => { void runtime.close(); });
  return { runtime, lifecycle };
}

test('1022: an unreachable token endpoint is retried and recovers, it never asks for a sign-in', async t => {
  let tokens = 0;
  const f = await fixture({ token: res => {
    tokens += 1;
    if (tokens === 1) { res.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'access-token-refreshed', refresh_token: 'refresh-token-2', token_type: 'Bearer', expires_in: 3600 }));
  } });
  t.after(() => f.close());
  const { runtime, lifecycle } = await mongooseRuntime(t, f);
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.error, 'credential-refresh-unavailable', 'a network blip is its own closed code');
  assert.equal(failed.retrying, true, 'and it stays on the bounded recovery schedule');
  await until(() => runtime.status().endpoints[0]!.state === 'connected');
  const recovered = lifecycle.filter(entry => entry.event === 'connector_recovered');
  assert.equal(recovered.length, 1, 'one line for the recovery that landed');
  assert.equal(recovered[0]!.endpointId, 'mongoose-knowledge');
  assert.equal(recovered[0]!.attempts, 1, 'the first recovery round proved it');
  assert.ok(Number.isFinite(recovered[0]!.connectMs), 'and the line carries how long it took');
});

test('1022: a token endpoint that refuses the refresh still parks the connector for a sign-in', async t => {
  const f = await fixture({ token: res => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); } });
  t.after(() => f.close());
  const { runtime, lifecycle } = await mongooseRuntime(t, f);
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.error, 'credential-refresh-failed', 'a real refusal keeps its own code');
  assert.equal(failed.retrying, false, 'and is never retried behind the owner');
  assert.equal(lifecycle.filter(entry => entry.event === 'connector_recovered').length, 0);
});

test('1022: a recovery round that never succeeds says so once, with the reason', async t => {
  const f = await fixture({ tools: [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: [], required: 'not-an-array' } }] });
  t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: 'refresh-material', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-exhausted-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    recoveryDelaysMs: FAST, lifecycleLog: event => { lifecycle.push(event as Lifecycle); } });
  t.after(() => { void runtime.close(); });
  assert.equal(runtime.status().endpoints[0]!.retrying, true);
  await until(() => lifecycle.some(entry => entry.event === 'connector_recovery_exhausted'), 4000);
  const exhausted = lifecycle.filter(entry => entry.event === 'connector_recovery_exhausted');
  assert.equal(exhausted.length, 1, 'one line when the bounded round is spent');
  assert.equal(exhausted[0]!.endpointId, 'mongoose-knowledge');
  assert.equal(exhausted[0]!.attempts, FAST.length, 'every delay was used');
  assert.ok((exhausted[0]!.reason ?? '').length > 0, 'and it names the closed reason it gave up on');
});

/** A helper that refuses the identity probe for the life of one process and proves it in a fresh one. */
const HELPER = `
import { existsSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const marker = process.argv[2]; const owner = process.argv[3];
const first = !existsSync(marker);
if (first) writeFileSync(marker, 'seen');
const sdk = new Server({ name: 'fake-google', version: '1' }, { capabilities: { tools: { listChanged: false } } });
sdk.setRequestHandler('tools/list', () => ({ tools: [
  { name: 'gmail_get_profile', inputSchema: { type: 'object', properties: {} } },
  { name: 'gmail_search', inputSchema: { type: 'object', properties: {} } },
] }));
sdk.setRequestHandler('tools/call', request => {
  if (request.params.name !== 'gmail_get_profile') return { content: [{ type: 'text', text: JSON.stringify({ messages: [] }) }] };
  if (first) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'identity_unverified' }) }] };
  return { content: [{ type: 'text', text: JSON.stringify({ emailAddress: owner }) }] };
});
await sdk.connect(new StdioServerTransport());
`;

test('1022: a stdio helper that pins a refused identity is replaced before the recovery probe', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-stdio-pinned-'));
  // Beside the compiled test so the child resolves the same node_modules the test itself does.
  const helper = join(dirname(fileURLToPath(import.meta.url)), `pinned-helper-${randomUUID()}.mjs`);
  writeFileSync(helper, HELPER);
  t.after(() => { rmSync(helper, { force: true }); });
  const marker = join(dir, 'started');
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT,
    endpoints: [{ id: 'gmail', transport: 'stdio', command: process.execPath, args: [helper, marker, ACCOUNT],
      env: { HOME: join(dir, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
      connector: 'google', account: 'local', resource: 'google-gmail', credentialRef: null,
      enabled: true, allowEgress: true, unknownClass: 'private' }],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    recoveryDelaysMs: FAST, lifecycleLog: event => { lifecycle.push(event as Lifecycle); } });
  t.after(() => { void runtime.close(); });
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.state, 'error', 'the pinned helper refused the proof');
  assert.equal(failed.retrying, true, 'so one bounded round is scheduled');
  await until(() => runtime.status().endpoints[0]!.state === 'connected');
  const recovered = lifecycle.filter(entry => entry.event === 'connector_recovered');
  assert.equal(recovered.length, 1, 'the recovery round proved the account');
  assert.equal(recovered[0]!.attempts, 1, 'on its first attempt, because the retry got a fresh helper');
});

test('1022: an unreachable refresh reads as unreachable in the browser, never as a sign-in', () => {
  assert.equal(connectionReasonCode({ state: 'error', error: 'credential-refresh-unavailable', signIn: true }), 'unreachable',
    'a network blip is not a reason to show the sign-in step');
  assert.equal(connectionReasonCode({ state: 'error', error: 'credential-refresh-failed', signIn: true }), 'needs_sign_in',
    'a real refusal still asks for the sign-in');
});

test('L2: the first calendar connect of a run re-reads a digest the start raced, and only once', async () => {
  const reads: string[] = [];
  let snapshot = { state: 'unconfigured', fetchedAt: 1_000 };
  const digest = {
    forStart: async () => snapshot,
    refresh: async () => { reads.push('refresh'); return undefined; },
  };
  const endpoints = () => [{ id: 'gmail', connector: 'google' }, { id: 'calendar', connector: 'google' }];
  const grants = new Map<string, { endpointId: string; toolNames: readonly string[] }>([
    ['gmail', { endpointId: 'gmail', toolNames: ['gmail_search'] }],
    ['calendar', { endpointId: 'calendar', toolNames: ['calendar_list_events'] }],
  ]);
  const logged: Array<{ event: string; reason?: string; ms?: number }> = [];
  let clock = 2_000;
  const onConnected = bindCalendarFirstConnect({
    digest, endpoints, grantOf: id => grants.get(id), startedAt: 1_000, now: () => (clock += 100),
    log: event => { logged.push(event); },
  });

  onConnected('gmail');
  onConnected('calendar');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ['refresh'], 'the first calendar connect reads the digest the start raced, once');
  assert.deepEqual(logged.map(event => event.reason), ['first_connect'], 'and says which edge owed the read');

  snapshot = { state: 'failed', fetchedAt: 1_000 };
  onConnected('calendar');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ['refresh'], 'a second connected event owes no second read');
});

test('L2: a first connect that finds the digest already read after the start reads nothing', async () => {
  const reads: number[] = [];
  const digest = {
    forStart: async () => ({ state: 'present', fetchedAt: 5_000 }),
    refresh: async () => { reads.push(1); return undefined; },
  };
  const onConnected = bindCalendarFirstConnect({
    digest,
    endpoints: () => [{ id: 'calendar', connector: 'google' }],
    grantOf: id => ({ endpointId: id, toolNames: ['calendar_list_events'] }),
    startedAt: 1_000, now: () => 6_000,
    log: () => { reads.push(2); },
  });
  onConnected('calendar');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, [], 'a digest whose read finished after the start is the answer, never a second read');
});

test('L2: a recovered calendar connector reports the refresh it owed, with its own reason', async () => {
  const logged: Array<{ event: string; reason?: string; ms?: number }> = [];
  let clock = 10_000;
  const run = bindCalendarRecovery({
    digest: { refresh: async () => { clock += 240; return undefined; } },
    endpoints: () => [{ id: 'gmail', connector: 'google' }, { id: 'calendar', connector: 'google' }],
    grantOf: id => ({ endpointId: id, toolNames: id === 'calendar' ? ['calendar_list_events'] : ['gmail_search'] }),
    now: () => clock,
    log: event => { logged.push(event); },
  });
  run('gmail');
  assert.deepEqual(logged, [], 'a mail endpoint of the same account owes no calendar read');
  run('calendar');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(logged, [{ event: 'calendar_digest_refreshed', reason: 'recovered', ms: 240 }],
    'the recovered read names its edge and how long it took');
});

test('L2: the background owner reports its start read and its timer read, and a joined read only once', async () => {
  const receipts: Array<{ event: string; reason?: string; ms?: number }> = [];
  let clock = 50_000;
  let reads = 0;
  const cache = new CalendarDigestCache(
    async () => { reads += 1; clock += 300; return { state: 'present', text: 'one line', items: 1, fetchedAt: clock }; },
    { now: () => clock, timeZone: 'UTC', intervalMs: 60_000, log: event => { receipts.push(event); } });
  cache.begin();
  // The interval is armed but never fires inside this test: the timer edge is driven directly below,
  // once the start read has settled, so the two edges are two reads rather than one joined read.
  await new Promise(resolve => setImmediate(resolve));
  await cache.refresh('timer');
  cache.stop();
  assert.equal(reads, 2, 'one read at begin and one asked for by the timer');
  assert.deepEqual(receipts, [
    { event: 'calendar_digest_refreshed', reason: 'start', ms: 300 },
    { event: 'calendar_digest_refreshed', reason: 'timer', ms: 300 },
  ], 'each edge names itself, with the read it paid for');
  assert.equal(safeEvent(receipts[0])?.reason, 'start', 'the receipt passes the closed allowlist');
  assert.equal(safeEvent(receipts[1])?.reason, 'timer');

  const joined: Array<{ event: string; reason?: string; ms?: number }> = [];
  const solo = new CalendarDigestCache(
    async () => { await new Promise(resolve => setImmediate(resolve)); return { state: 'present', text: 'one line', items: 1, fetchedAt: 1 }; },
    { now: () => 1, timeZone: 'UTC', log: event => { joined.push(event); } });
  const firstRead = solo.refresh('start');
  const secondRead = solo.refresh('timer');
  await Promise.all([firstRead, secondRead]);
  assert.deepEqual(joined.map(event => event.reason), ['start'], 'a read a caller joined is reported by the edge that started it');
});
