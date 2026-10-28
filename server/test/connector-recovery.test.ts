import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/index.js';
import { composeMcpRuntime, CONNECTOR_REARM_INTERVAL_MS, CONNECTOR_RECOVERY_DELAYS_MS, CONNECTOR_RECOVERY_REPEAT_MS, createRecoverySchedule } from '../host/mcp.js';
import { connectionReasonCode } from '../http/server.js';
import { bindCalendarFirstConnect, bindCalendarRecovery, connectorLifecycleSink } from '../host/runtime.js';
import { CalendarDigestCache } from '../live/warm-context.js';
import { safeEvent } from '../host/log.js';
import { identityFailureRetryable, proveIdentity, type IdentitySource } from '../connectors/identity.js';
import { MONGOOSE_ENDPOINTS, mongooseCredentialAtStart } from '../connectors/mongoose.js';
import type { ConnectorResult } from '../connectors/index.js';

const ACCOUNT = 'owner@example.test';
const FAST = [10, 10, 10, 10];

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
  /**
   * TRAIN8-R8: from this 1-based request on, the answer never lands, so the recovery attempt's own
   * deadline is what ends it. Request 1 is the first connect, which stays fast on purpose.
   */
  hangFrom?: number;
}

async function fixture(options: FixtureOptions = {}, port = 0) {
  let requests = 0;
  let calls = 0;
  let served = 0;
  let hung = 0;
  const listener = createServer(async (req, res) => {
    try {
      const bytes = await body(req);
      if ((req.method ?? 'GET') === 'DELETE') { res.writeHead(200); res.end(); return; }
      if (req.url === '/oauth/token') { options.token?.(res); return; }
      // The attempt that never answers: the response is left open on purpose, so only the recovery
      // attempt's own deadline can end it. Closed by listener.closeAllConnections().
      served += 1;
      if (options.hangFrom !== undefined && served >= options.hangFrom) { hung += 1; return; }
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
  listener.listen(port, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests: () => requests,
    hung: () => hung,
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

/** One schemaVersion 3 record, bound to the knowledge endpoint the catalogue in this directory configures. */
function oauthRecord(configDir: string, reference: string, fields: { refreshToken: string; expiresAt: number; consentStartedAt: number }): void {
  const catalogue = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoints: { id: string; url: string }[] };
  const resource = catalogue.endpoints.find(entry => entry.id === 'mongoose-knowledge')!.url;
  const issuer = new URL(resource).origin;
  writeFileSync(join(configDir, `${reference}.json`), JSON.stringify({
    schemaVersion: 3, endpoint: 'knowledge', resource, issuer, tokenEndpoint: `${issuer}/oauth/token`, clientId: 'client', redirectPort: 45871,
    account: ACCOUNT, accessToken: 'current-access',
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
    assert.equal(CONNECTOR_RECOVERY_DELAYS_MS.length, 4);
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

test('a transient failure keeps retrying on the steady interval, so a late network or server still recovers', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const schedule = createRecoverySchedule([1, 1], CONNECTOR_RECOVERY_REPEAT_MS);
    let runs = 0;
    const step = (): void => { runs += 1; schedule.next('google', step); };
    schedule.next('google', step);
    mock.timers.tick(1); mock.timers.tick(1);
    assert.equal(runs, 2, 'the delays ran in order');
    assert.equal(schedule.pending('google'), true, 'a transient round never ends while the host lives');
    assert.equal(CONNECTOR_RECOVERY_REPEAT_MS, 120_000);
    for (let round = 0; round < 3; round += 1) mock.timers.tick(CONNECTOR_RECOVERY_REPEAT_MS);
    assert.equal(runs, 5, 'then once per steady interval');
    schedule.stop('google');
    assert.equal(schedule.pending('google'), false, 'an explicit reconnect stops it');
  } finally { mock.timers.reset(); }
});

test('an inconclusive identity probe keeps the ladder, a definite failure is terminal per endpoint', async () => {
  const source: IdentitySource = { tool: 'get_profile', args: {}, values: decoded => [String((decoded as { id?: unknown }).id)] };
  const slow = await proveIdentity({ source, expected: [ACCOUNT], timeoutMs: 5, call: () => new Promise<ConnectorResult>(() => {}) });
  assert.equal(slow.proven, false);
  assert.equal(slow.code, 'identity_timeout', 'a timeout is its own closed code, never a mismatch');
  assert.equal(identityFailureRetryable(slow), true, 'TR4-R8: the proof did not answer, so it is inconclusive and earns the bounded ladder');
  // lux-cli reports a refresh that failed for a reason other than a refusal (the network, DNS, a 5xx) as
  // credential_refresh_failed, and a refused grant as credential_revoked. Only the first can clear itself.
  assert.equal(identityFailureRetryable({ proven: false, match: null, value: null, code: 'credential_refresh_failed' }), true, 'a refresh the network broke earns the retry ladder');
  assert.equal(identityFailureRetryable({ proven: false, match: null, value: null, code: 'credential_revoked' }), false, 'a refused grant latches until sign-in');
  // An answered "no account" is definite, never inconclusive: only a proof that did not answer is retried.
  assert.equal(identityFailureRetryable({ proven: false, match: null, value: null, code: 'identity_unverified' }), false, 'a definite unproven answer latches until an explicit sign-in');
  const mismatch = await proveIdentity({ source, expected: [ACCOUNT], timeoutMs: 50, call: async () => ({ state: 'completed', decodedResult: { id: 'other@example.test' } } as unknown as ConnectorResult) });
  assert.equal(mismatch.match, false);
  assert.equal(identityFailureRetryable(mismatch), false, 'a mismatch stays failed until the next reconnect');
});

// TR4-R8: an inconclusive probe is retryable but its ladder is spent once, so one call of any length
// probes it at most once plus the ladder, never once per owner turn.
test('TR4-R8: an identity that times out every time is probed at most once plus the ladder, over 50 owner turns', async t => {
  let probes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => { probes += 1; return { payload: {}, delayMs: 400 }; } });
  t.after(() => gmail.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-probe-cap-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(gmail.url, 'gmail', 'mail')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  let clock = 9_000_000;
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 120, recoveryDelaysMs: FAST, recoveryRepeatMs: false, now: () => clock,
  });
  t.after(() => runtime.close());
  // FAST mirrors CONNECTOR_RECOVERY_DELAYS_MS, so the ladder is the real one, driven in tens of ms.
  const capped = 1 + CONNECTOR_RECOVERY_DELAYS_MS.length;
  await until(() => probes >= capped, 4000);
  await until(() => runtime.status().endpoints[0]!.retrying === false, 4000);
  assert.equal(runtime.status().endpoints[0]!.reasonCode, 'identity_timeout', 'the ladder ended on the inconclusive code');
  for (let turn = 0; turn < 50; turn += 1) {
    clock += 30 * 60_000 / 50;
    runtime.connectionIds();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(probes <= capped, `fifty owner turns over thirty simulated minutes add no probe, saw ${probes}`);
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
  // The record now refreshes at the fixture's own origin, so its token route answers instead of hanging.
  const f = await fixture({ token: res => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); } }); t.after(() => f.close());
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

test('a retryable first call failure retries a bounded number of times and then stops', { timeout: 45000 }, async t => {
  // A discovery timeout is a five second wait by construction, which no test here may take; the timeout
  // cause itself is asserted at the projection above. This drives the same retryable first_call path with
  // a fast closed cause: a tool definition the client refuses.
  const f = await fixture({ tools: [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: [], required: 'not-an-array' } }] }); t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: 'refresh-material', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-store-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  // TRAIN8-R9: the claim is the number of ATTEMPTS and that the round stops. An attempt the per-attempt
  // deadline cuts before `tools/list` is still an attempt, so the count is read from the closed
  // `connector_retry` lines the recovery writes; the wire count stays as a sanity bound.
  const retries: Array<{ event?: string; outcome?: string; attempt?: number }> = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryDelaysMs: FAST, recoveryRepeatMs: false, lifecycleLog: event => { if ((event as { event?: string }).event === 'connector_retry') retries.push(event as { event?: string; outcome?: string; attempt?: number }); } });
  t.after(() => runtime.close());
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.state, 'error', 'the endpoint did not connect');
  assert.equal(failed.retrying, true, 'a retry is scheduled');
  assert.equal(f.requests(), 1);
  // The attempt count: the first connect plus the bounded retries. The wait bound is only a guard against
  // a hung round, and the test carries its own timeout above it because check-host.sh runs the suite with
  // --test-timeout=15000.
  // The schedule's bound is the first connect plus one attempt per configured delay; FAST mirrors
  // CONNECTOR_RECOVERY_DELAYS_MS, so that is 1 + FAST.length attempts and the round then stops.
  const bounded = 1 + FAST.length;
  const attempts = () => 1 + retries.length;
  await until(() => attempts() >= bounded, 28000);
  assert.equal(attempts(), bounded, `the first connect plus exactly ${FAST.length} bounded retries`);
  // The wire sanity bound: at least one attempt reached the tools, and none exceeded the attempt count.
  assert.ok(f.requests() >= 1, `at least one attempt reached the tools (${f.requests()})`);
  assert.ok(f.requests() <= attempts(), `no wire read outnumbers the attempts (${f.requests()} <= ${attempts()})`);
  // The round stops: `retrying` is briefly false between two scheduled attempts, so wait for a stop that
  // holds for at least one more full delay, then prove no further attempt was issued.
  await until(() => runtime.status().endpoints[0]!.retrying === false, 28000);
  await new Promise(resolve => setTimeout(resolve, Math.max(...FAST) * 2));
  assert.equal(runtime.status().endpoints[0]!.retrying, false, 'the round is over and no further attempt is pending');
  assert.equal(attempts(), bounded, 'no further attempt is issued after the round stops');
  assert.ok(f.requests() <= attempts(), `the stopped round issues no wire read beyond its attempts (${f.requests()} <= ${attempts()})`);
});

test('TRAIN8-R8: an attempt that never answers is cut by its own deadline, so the round advances and stops', { timeout: 30000 }, async t => {
  // The ruling's case: a connect whose answer never lands. Without a per-attempt deadline this round never
  // issues another attempt, which is exactly the stall the release train measured. The fixture leaves every
  // answer open from the second wire request on, so the attempt deadline is what ends each attempt, and the
  // ladder still walks its bounded count and stops. The first connect rides the SDK's own five second
  // connect bound, which is why this test runs a little over five seconds; every attempt after it is cut at
  // the 50ms test seam.
  const f = await fixture({ hangFrom: 2, tools: [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: [], required: 'not-an-array' } }] }); t.after(() => f.close());
  const configDir = configDirFor(f.url, 'mongoose-knowledge');
  oauthRecord(configDir, 'mongoose-knowledge', { refreshToken: 'refresh-material', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-hang-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const retries: Array<{ event?: string; outcome?: string }> = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryDelaysMs: FAST, recoveryRepeatMs: false, recoveryAttemptDeadlineMs: 50, lifecycleLog: event => { const line = event as { event?: string; outcome?: string }; if (line.event === 'connector_retry') retries.push(line); } });
  t.after(() => runtime.close());
  await runtime.start();
  // The cut is read on the retry line it writes, not on the projection: a later attempt sets the
  // projection back to connecting before its own answer arrives.
  const cut = () => retries.some(line => line.outcome === 'identity_timeout');
  await until(cut, 20000);
  assert.ok(cut(), 'the attempt that never answered was cut and logged as the closed transient identity_timeout');
  // The round advances past the cut and stops at its bounded count: the first connect plus one attempt per
  // configured delay. No further attempt follows once it has stopped.
  const attempts = () => 1 + retries.length;
  await until(() => attempts() >= 2, 20000);
  assert.ok(attempts() >= 2, `the round advances past the cut attempt (${attempts()})`);
  let stable = 0;
  for (let poll = 0; poll < 300 && stable < 5; poll += 1) {
    const before = attempts();
    await new Promise(resolve => setTimeout(resolve, 20));
    stable = attempts() === before ? stable + 1 : 0;
  }
  assert.equal(runtime.status().endpoints[0]!.retrying, false, 'the round is over and no attempt is pending');
  assert.ok(attempts() <= 1 + FAST.length, `the round stops at its bounded count (${attempts()} <= 1 + ${FAST.length})`);
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
    // TR4-R8: the first proof never answers inside the call deadline, so it is inconclusive (retryable)
    // rather than a definite refusal; the retry answers with the owner's own address.
    return gmailProbes === 1 ? { payload: {}, delayMs: 400 } : { payload: { emailAddress: ACCOUNT } };
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
    callDeadlineMs: 120, recoveryDelaysMs: FAST,
    identityLog: (connector, proven, match, endpointId) => { identity.push({ connector, proven, match, endpointId: endpointId ?? '' }); },
  });
  t.after(() => runtime.close());
  const first = runtime.status().endpoints;
  const calendarFirst = first.find(row => row.id === 'calendar')!;
  const gmailFirst = first.find(row => row.id === 'gmail')!;
  assert.equal(gmailFirst.state, 'error', 'the slow proof left gmail unproven');
  assert.equal(gmailFirst.reasonCode, 'identity_timeout', 'the proof did not answer, so it is inconclusive, never a mismatch');
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

// --- C-CONNECT8: a transient failure at host start recovers on its own; a permanent one still latches ---

/** One google calendar endpoint, so a recovery owes the calendar digest a read. */
function calendarOnlyConfig(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'didi-calendar-recovery-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [googleConfig(url, 'calendar', 'calendar')],
  }), { mode: 0o600 });
  return configDir;
}

test('C-CONNECT8: a transient refresh failure twice, then a proof, connects and rebuilds the calendar digest', async t => {
  let probes = 0;
  const calendar = await fixture({ tools: CALENDAR_TOOLS, call: () => {
    probes += 1;
    // What the owner's Mac saw at 02:26Z: the helper could not reach Google to refresh, so it answered
    // the closed code for a refresh that failed for a reason other than a refusal. The third probe is
    // the one the network let through.
    return probes <= 2 ? { payload: { error: 'credential-refresh-failed' } } : { payload: { calendars: [{ id: ACCOUNT, primary: true }] } };
  } });
  t.after(() => calendar.close());
  const configDir = calendarOnlyConfig(calendar.url);
  const dir = mkdtempSync(join(tmpdir(), 'didi-calendar-digest-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  let refreshes = 0;
  let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
  runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 200, recoveryDelaysMs: FAST, recoveryRepeatMs: false,
    lifecycleLog: connectorLifecycleSink({
      log: event => { lifecycle.push(event as Lifecycle); },
      onRecovered: bindCalendarRecovery({
        digest: { refresh: async () => { refreshes += 1; return {}; } },
        endpoints: () => runtime?.status().endpoints ?? [],
        grantOf: id => ({ endpointId: id, toolNames: ['calendar_list_events'] }),
      }),
    }),
  });
  t.after(() => runtime!.close());
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.state, 'error', 'the refresh the network broke never proves the account');
  assert.equal(failed.reasonCode, 'credential_refresh_failed');
  assert.equal(failed.retrying, true, 'a transient failure earns the retry ladder instead of a latch');
  await until(() => runtime!.status().endpoints[0]!.state === 'connected', 4000);
  assert.equal(probes, 3, 'two failed refreshes, then the proof that landed');
  await until(() => refreshes === 1, 2000);
  const retries = lifecycle.filter(event => event.event === 'connector_retry');
  assert.deepEqual(retries.map(event => event.outcome), ['credential_refresh_failed', 'connected'], 'one closed line per retry outcome');
  assert.equal(lifecycle.filter(event => event.event === 'connector_latched').length, 0, 'nothing translatable latched');
  assert.equal(lifecycle.filter(event => event.event === 'connector_recovered').length, 1);
});

test('C-CONNECT8: a refused grant (invalid_grant) stays latched with no retry, as today', async t => {
  let probes = 0;
  const calendar = await fixture({ tools: CALENDAR_TOOLS, call: () => {
    probes += 1;
    // lux-cli answers invalid_grant with credential_revoked: the provider refused the credential, so no
    // amount of retrying can clear it.
    return { payload: { error: 'credential-revoked' } };
  } });
  t.after(() => calendar.close());
  const configDir = calendarOnlyConfig(calendar.url);
  const dir = mkdtempSync(join(tmpdir(), 'didi-calendar-latched-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 200, recoveryDelaysMs: FAST, recoveryRepeatMs: false,
    lifecycleLog: event => { lifecycle.push(event as Lifecycle); },
  });
  t.after(() => runtime.close());
  const row = runtime.status().endpoints[0]!;
  assert.equal(row.state, 'error');
  assert.equal(row.reasonCode, 'credential_revoked');
  assert.equal(row.retrying, false, 'a definite refusal never schedules a retry');
  assert.equal(lifecycle.find(event => event.event === 'connector_latched')?.code, 'credential_revoked');
  // Longer than the first ladder delay: a retry that was wrongly scheduled would have fired by now.
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(probes, 1, 'the refused grant is never probed again');
  assert.equal(lifecycle.filter(event => event.event === 'connector_retry').length, 0);
});

const KNOWLEDGE_TOOLS = [{ name: 'search_knowledge', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];

test('C-CONNECT8: lux-knowledge refusing connections at start connects once it listens, without a restart', async t => {
  // Take a free port, then hand it back: the first discovery is a real connection refused.
  const pickup = await fixture({});
  const port = Number(new URL(pickup.url).port);
  await pickup.close();
  const dir = mkdtempSync(join(tmpdir(), 'didi-knowledge-late-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: 'owner',
    endpoints: [{ id: 'lux-knowledge', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`, connector: 'lux-knowledge',
      account: ACCOUNT, resource: 'lux-knowledge', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 300, recoveryDelaysMs: [20, 20, 20], recoveryRepeatMs: 40,
    lifecycleLog: event => { lifecycle.push(event as Lifecycle); },
  });
  t.after(() => runtime.close());
  await until(() => runtime.status().endpoints[0]!.retrying === true, 2000);
  assert.equal(runtime.status().endpoints[0]!.state, 'error', 'the local server was not listening yet');
  const knowledge = await fixture({ tools: KNOWLEDGE_TOOLS }, port);
  t.after(() => knowledge.close());
  await until(() => runtime.status().endpoints[0]!.state === 'connected', 5000);
  assert.ok(lifecycle.some(event => event.event === 'connector_retry'), 'the retry that connected wrote its own line');
  assert.ok(lifecycle.some(event => event.event === 'connector_recovered'), 'the recovery is the same host, not a restart');
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
    callDeadlineMs: 120, recoveryDelaysMs: FAST, recoveryRepeatMs: false,
    connectorLog: (_connector, stage, detail) => { failures.push({ stage, ...(detail ?? {}) }); },
    identityLog: (_connector, proven, _match, _endpointId, code) => { identity.push({ proven, ...(code === undefined ? {} : { code }) }); },
  });
  t.after(() => runtime.close());
  await until(() => failures.length >= 1 + FAST.length, 4000);
  assert.equal(failures.length, 1 + FAST.length, 'the first connect and every retry, not only the first');
  assert.equal(failures[0]!.attempt, 'first-connect');
  assert.deepEqual(failures.slice(1).map(row => row.attempt), FAST.map(() => 'refresh'), 'each retry names its own pass');
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
  // TR4-R8: the re-arm a read earns belongs to a retryable non-identity reason (an inconclusive
  // identity is never re-armed by a read), so this drives main's per-interval attempt with a tool
  // definition the client refuses, the same fast closed cause the bounded round above uses.
  let attempts = 0;
  const gmail = await fixture({ tools: [...GMAIL_TOOLS, { name: 'gmail_search_messages', inputSchema: { type: 'object', properties: [], required: 'not-an-array' } }], call: () => ({ payload: { emailAddress: ACCOUNT } }) });
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
    now: () => clock, recoveryDelaysMs: FAST, recoveryRepeatMs: false,
    connectorLog: (_connector: string, _stage: string, detail?: { endpointId?: string }) => { if (detail?.endpointId === 'gmail') attempts += 1; },
  });
  t.after(() => runtime.close());
  // Enough attempts for the first connect plus the whole bounded round, every one of them unproven.
  const spent = 1 + FAST.length;
  await until(() => attempts >= spent, 4000);
  assert.equal(runtime.status().endpoints[0]!.retrying, false, 'the bounded round is spent');
  assert.equal(CONNECTOR_REARM_INTERVAL_MS, 120_000, 'the interval is two minutes');
  // A read one millisecond short of the interval earns nothing.
  clock += CONNECTOR_REARM_INTERVAL_MS - 1;
  runtime.connectionIds();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(attempts, spent, 'a read inside the interval never re-arms');
  // A read at the interval earns exactly one fresh attempt, and a second read earns none.
  clock += 1;
  runtime.connectionIds();
  await until(() => attempts === spent + 1, 4000);
  assert.equal(attempts, spent + 1, 'one fresh attempt, no more');
  runtime.connectionIds();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(attempts, spent + 1, 'a second read in the same window earns nothing');
  // The fresh attempt failed retryably, so the next window is two minutes after that attempt.
  clock += CONNECTOR_REARM_INTERVAL_MS;
  runtime.connectionIds();
  await until(() => attempts === spent + 2, 4000);
  assert.equal(attempts, spent + 2, 'the endpoint is not left down for the rest of the session');
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
    schemaVersion: 3, endpoint: 'knowledge', resource: `${base}/mcp/knowledge`, issuer: base, tokenEndpoint: `${base}/oauth/token`,
    clientId: 'client', redirectPort: 45871, account: ACCOUNT,
    accessToken: 'current-access', refreshToken: 'refresh-token-1', expiresAt: 1, consentStartedAt: Date.now(),
  }), { mode: 0o600 });
}

type Lifecycle = { event: string; endpointId: string; attempts?: number; reason?: string; connectMs?: number; bytes?: number; connector?: string; attempt?: number; outcome?: string; code?: string };

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
    recoveryDelaysMs: FAST, recoveryRepeatMs: false, lifecycleLog: event => { lifecycle.push(event as Lifecycle); } });
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
// TR4-R8: the helper is correctly pinned to the owner, so its one failure is a retryable first_call
// discovery refusal (a definition the client will not accept), never an identity one; D1's own test
// covers the refused pin.
const sdk = new Server({ name: 'fake-google', version: '1' }, { capabilities: { tools: { listChanged: false } } });
sdk.setRequestHandler('tools/list', () => ({ tools: [
  { name: 'gmail_get_profile', inputSchema: { type: 'object', properties: {} } },
  { name: 'gmail_search', inputSchema: { type: 'object', properties: {} } },
  // One refused definition on the very first child is a first_call discovery failure: retryable, so a
  // fresh helper is spawned, and that child's catalogue is clean.
  ...(first ? [{ name: 'gmail_search_messages', inputSchema: { type: 'object', properties: [], required: 'not-an-array' } }] : []),
] }));
sdk.setRequestHandler('tools/call', request => {
  if (request.params.name !== 'gmail_get_profile') return { content: [{ type: 'text', text: JSON.stringify({ messages: [] }) }] };
  return { content: [{ type: 'text', text: JSON.stringify({ emailAddress: owner }) }] };
});
await sdk.connect(new StdioServerTransport());
`;

test('1022: a correctly pinned stdio helper that fails discovery once is replaced before the recovery probe', async t => {
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
      // TR4-R8: a stdio Google child is refused unless it pins the owner account, so this helper, which
      // proves the identity it pins, carries the pin the catalogue declares.
      env: { HOME: join(dir, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '', LUX_GOOGLE_MCP_ACCOUNT: ACCOUNT },
      connector: 'google', account: 'local', resource: 'google-gmail', credentialRef: null,
      enabled: true, allowEgress: true, unknownClass: 'private' }],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const lifecycle: Lifecycle[] = [];
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    recoveryDelaysMs: FAST, lifecycleLog: event => { lifecycle.push(event as Lifecycle); } });
  t.after(() => { void runtime.close(); });
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.state, 'error', 'the first child refused its catalogue');
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

test('C-START10: identity proof survives startup recovery passes but not a changed credential or a new host', async t => {
  let probes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => { probes += 1; return { payload: { emailAddress: ACCOUNT } }; } });
  const dir = mkdtempSync(join(tmpdir(), 'didi-start-identity-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const credential = (token: string) => writeFileSync(join(configDir, 'synthetic-seat.json'), JSON.stringify({ schemaVersion: 1, token }), { mode: 0o600 });
  credential('synthetic-token-one');
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT,
    endpoints: [{ ...googleConfig(gmail.url, 'gmail', 'mail'), credentialRef: 'synthetic-seat' }],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  let runtime: Awaited<ReturnType<typeof composeMcpRuntime>> | undefined;
  t.after(async () => { await runtime?.close(); store.close(); await gmail.close(); rmSync(dir, { recursive: true, force: true }); });
  const compose = () => composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryRepeatMs: false });
  runtime = await compose();
  assert.equal(runtime.status().endpoints[0]!.state, 'connected');
  await runtime.recover();
  await runtime.refresh();
  await runtime.recover();
  assert.equal(probes, 1, 'one host reuses its proven identity across real reconnect and recover passes');
  credential('synthetic-token-two');
  await runtime.refresh();
  assert.equal(probes, 2, 'a changed credential must prove its own identity');
  await runtime.close();
  runtime = await compose();
  assert.equal(probes, 3, 'proofs do not leak across host starts');
});
