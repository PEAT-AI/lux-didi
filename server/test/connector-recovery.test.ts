import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/index.js';
import { composeMcpRuntime, CONNECTOR_RECOVERY_DELAYS_MS, createRecoverySchedule, identityFailureRetryable } from '../host/mcp.js';
import { connectionReasonCode } from '../http/server.js';
import { proveIdentity, type IdentitySource } from '../connectors/identity.js';
import { mongooseCredentialAtStart } from '../connectors/mongoose.js';
import type { ConnectorResult } from '../connectors/index.js';

const ACCOUNT = 'owner@example.test';
const RESOURCE = 'company';
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
}

async function fixture(options: FixtureOptions = {}) {
  let requests = 0;
  const listener = createServer(async (req, res) => {
    try {
      const bytes = await body(req);
      if ((req.method ?? 'GET') === 'DELETE') { res.writeHead(200); res.end(); return; }
      const sdk = new Server({ name: 'synthetic-mongoose', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      sdk.setRequestHandler('tools/list', () => {
        requests += 1;
        return { tools: options.tools ?? [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } as never;
      });
      sdk.setRequestHandler('tools/call', async request => {
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
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests: () => requests,
    async close() { await new Promise<void>(resolve => listener.close(() => resolve())); },
  };
}

function configDirFor(url: string, credentialRef: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'didi-connect-recovery-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads',
    endpoints: [{ id: 'mongoose', transport: 'streamable-http', url, connector: 'mongoose', account: ACCOUNT, resource: RESOURCE, credentialRef, enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
  }), { mode: 0o600 });
  return configDir;
}

function oauthRecord(configDir: string, fields: { refreshToken: string; expiresAt: number; consentStartedAt: number }): void {
  writeFileSync(join(configDir, 'mongoose-mcp.json'), JSON.stringify({
    schemaVersion: 2, base: 'https://mongoose.example.test', clientId: 'client', redirectPort: 45871,
    account: ACCOUNT, accessToken: 'current-access', refreshToken: fields.refreshToken,
    expiresAt: fields.expiresAt, consentStartedAt: fields.consentStartedAt,
  }), { mode: 0o600 });
}

test('a retryable failure gets exactly the bounded recovery round, one probe at a time', async () => {
  const ran: number[] = [];
  const schedule = createRecoverySchedule(FAST);
  const probe = (): void => { ran.push(ran.length + 1); };
  schedule.next('mongoose', probe);
  assert.equal(schedule.pending('mongoose'), true);
  assert.equal(schedule.attempts('mongoose'), 1);
  // A second request while one is pending never starts a second timer.
  schedule.next('mongoose', probe);
  assert.equal(schedule.attempts('mongoose'), 1);
  assert.equal(schedule.pending('mongoose'), true);
  await new Promise(resolve => setTimeout(resolve, FAST[0]! + 20));
  assert.deepEqual(ran, [1]);
  assert.equal(schedule.pending('mongoose'), false);
  assert.equal(schedule.attempts('mongoose'), 1);
  // Stop is the explicit reconnect: the counter starts over.
  schedule.stop('mongoose');
  assert.equal(schedule.attempts('mongoose'), 0);
  assert.equal(CONNECTOR_RECOVERY_DELAYS_MS.length, 3);
});

test('the schedule gives up after every delay and stays stopped', async () => {
  const schedule = createRecoverySchedule([1, 1, 1]);
  let runs = 0;
  const step = (): void => { runs += 1; if (schedule.next('mongoose', step)) return; };
  schedule.next('mongoose', step);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(runs, 3, 'three attempts after the failure, never more');
  assert.equal(schedule.pending('mongoose'), false);
  assert.equal(schedule.next('mongoose', () => { runs += 1; }), false, 'the round is spent');
  schedule.stopAll();
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
  const configDir = configDirFor(f.url, 'mongoose-mcp');
  oauthRecord(configDir, { refreshToken: '   ', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() });
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
  const configDir = configDirFor(f.url, 'mongoose-mcp');
  oauthRecord(configDir, { refreshToken: 'refresh-material', expiresAt: Date.now() - 60_000, consentStartedAt: Date.now() });
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
  const configDir = configDirFor(f.url, 'mongoose-mcp');
  oauthRecord(configDir, { refreshToken: 'refresh-material', expiresAt: Date.now() + 3_600_000, consentStartedAt: Date.now() - 91 * 24 * 60 * 60 * 1000 });
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
  const configDir = configDirFor(f.url, null);
  const dir = mkdtempSync(join(tmpdir(), 'didi-recovery-store-'));
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryDelaysMs: FAST });
  t.after(() => runtime.close());
  const failed = runtime.status().endpoints[0]!;
  assert.equal(failed.state, 'error', 'the endpoint did not connect');
  assert.equal(failed.retrying, true, 'a retry is scheduled');
  assert.equal(f.requests(), 1);
  await new Promise(resolve => setTimeout(resolve, FAST[0]! * 3 + 120));
  const settled = runtime.status().endpoints[0]!;
  assert.equal(settled.retrying, false, 'the round is over and no further attempt is pending');
  assert.equal(f.requests(), 4, 'the first connect plus exactly three bounded retries');
});

/** Two Google endpoints of one owner account, each proving itself with its own family's tool. */
function googleConfig(url: string, connector: 'gmail' | 'calendar', id: string, resource: string): Record<string, unknown> {
  return { id, transport: 'streamable-http', url, connector, account: ACCOUNT, resource, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' };
}

const GMAIL_TOOLS = [{ name: 'gmail_get_profile', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
const CALENDAR_TOOLS = [{ name: 'calendar_list_calendars', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];

test('a gmail proof that runs out of time is retried until it proves the account, and calendar is never touched', async t => {
  let gmailProbes = 0;
  const gmail = await fixture({ tools: GMAIL_TOOLS, call: () => {
    gmailProbes += 1;
    // The first probe is the late one the owner's session lost the endpoint to; the retry answers.
    return gmailProbes === 1 ? { delayMs: 400, payload: { emailAddress: ACCOUNT } } : { payload: { emailAddress: ACCOUNT } };
  } });
  t.after(() => gmail.close());
  const calendar = await fixture({ tools: CALENDAR_TOOLS, call: () => ({ payload: { calendars: [{ id: ACCOUNT, primary: true }] } }) });
  t.after(() => calendar.close());
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-recovery-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: ACCOUNT, ownerChatUsername: ACCOUNT,
    endpoints: [googleConfig(gmail.url, 'gmail', 'gmail', 'mail'), googleConfig(calendar.url, 'calendar', 'calendar', 'calendar')],
  }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const identity: Array<{ connector: string; proven: boolean; match: boolean | null }> = [];
  const runtime = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    callDeadlineMs: 200, recoveryDelaysMs: FAST,
    identityLog: (connector, proven, match) => { identity.push({ connector, proven, match }); },
  });
  t.after(() => runtime.close());
  const first = runtime.status().endpoints;
  const calendarFirst = first.find(row => row.connector === 'calendar')!;
  const gmailFirst = first.find(row => row.connector === 'gmail')!;
  assert.equal(gmailFirst.state, 'error', 'the slow proof left gmail unproven');
  assert.equal(gmailFirst.reasonCode, 'identity_timeout', 'and the code names a timeout, never a mismatch');
  assert.equal(gmailFirst.retrying, true, 'so recovery is scheduled');
  assert.equal(connectionReasonCode({ state: gmailFirst.state, error: gmailFirst.error ?? '', signIn: false }), 'unreachable');
  assert.equal(calendarFirst.state, 'connected', 'calendar proved itself and never depended on gmail');
  assert.equal(calendarFirst.error, undefined);
  // The retry answers immediately: gmail ends connected and calendar keeps its own state and handshake.
  await new Promise(resolve => setTimeout(resolve, FAST[0]! + 600));
  const settled = runtime.status().endpoints;
  const gmailAfter = settled.find(row => row.connector === 'gmail')!;
  const calendarAfter = settled.find(row => row.connector === 'calendar')!;
  assert.equal(gmailAfter.state, 'connected');
  assert.equal(gmailAfter.retrying, false);
  assert.equal(gmailAfter.error, undefined);
  assert.ok(runtime.registry.currentGrant('gmail'), 'the retried proof published a grant');
  assert.deepEqual({ state: calendarAfter.state, lastHandshakeAt: calendarAfter.lastHandshakeAt },
    { state: calendarFirst.state, lastHandshakeAt: calendarFirst.lastHandshakeAt }, 'calendar was never re-probed');
  // One receipt per endpoint and per probe: gmail's timed out proof is unproven, and its own retry proved it.
  assert.deepEqual(identity.filter(entry => entry.proven).map(entry => entry.connector).sort(), ['calendar', 'gmail']);
  assert.equal(identity.some(entry => entry.connector === 'gmail' && !entry.proven), true);
});
