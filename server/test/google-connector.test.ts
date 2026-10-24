import { connectorDescriptor } from '../connectors/index.js';
import { HOST_EVIDENCE } from '../tools/types.js';
import { projectGoogleResult } from '../tools/google.js';
import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { sha256 } from '../tools/canonical.js';
import type { ConnectionPolicy, LiveAuthority, RunAcceptance } from '../tools/types.js';
import type { ConnectorEvidence } from '../connectors/index.js';
import type { ToolCallIntent } from '../adapters/model/types.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { CallResult, CompletedResult, EndpointConfig, McpPort, ResultScope } from '../adapters/mcp/port.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { GOOGLE_FAMILIES, GOOGLE_TOOLS, createGoogleReader, type GoogleConfig, type GoogleEvidence, type GoogleResult } from '../connectors/index.js';
import { buildCalendarDigest, CALENDAR_DIGEST_CHARS, type GcalListInput } from '../connectors/google.js';
import { GOOGLE_ERROR_TABLE, UNKNOWN_HELPER_OWNER_LINE, UNKNOWN_HELPER_REASON, decodeGoogleEnvelope, googleErrorEntry, googleOwnerLine, googleToolStatus, readGooglePayload, renderGoogleTool } from '../tools/google.js';
import { GMAIL_LIST_MESSAGES } from '../tools/live-shape.js';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'google-mcp-child.mjs');
const ACCOUNT = 'local';
const RESOURCE = 'google-fixture';

function config(id: string, mode: string, pidFile: string): EndpointConfig {
  return {
    id, transport: 'stdio', command: process.execPath, args: [child, mode, pidFile],
    env: { HOME: join(tmpdir(), 'didi-google-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    account: ACCOUNT, resource: RESOURCE,
  } as unknown as EndpointConfig;
}
function scratch(): { dir: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-'));
  return { dir, pidFile: join(dir, 'child.pid') };
}
/** The tool names the fake child has been asked for, in order, so a test can count dispatches. */
function callsOf(pidFile: string): string[] {
  try { return readFileSync(`${pidFile}.calls`, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
function adapterFor(registry: McpRegistry, timeoutMs = 4000): McpPort {
  return createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs } });
}
async function discoverAndApprove(registry: McpRegistry, adapter: McpPort, id: string, names: readonly string[]): Promise<string> {
  registry.enable(id); registry.allowEgress(id);
  const discovery = await adapter.discover(id);
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('not discovered');
  registry.approve({ endpointId: id, schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return discovery.schemaDigest;
}
function readerFor(adapter: McpPort, registry: McpRegistry, schemaDigest: string, overrides: Partial<GoogleConfig> = {}) {
  return createGoogleReader({ port: adapter, registry, config: { endpointId: 'local-stdio', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, family: 'gmail', ...overrides } });
}
function completed(result: GoogleResult): GoogleEvidence {
  assert.equal(result.state, 'completed', JSON.stringify(result));
  if (result.state !== 'completed') throw new Error('not completed');
  return result;
}
function envelopeOf(evidence: GoogleEvidence): Record<string, unknown> {
  const payload = readGooglePayload(adapterOf(evidence), evidence);
  if (!payload.ok) assert.fail(payload.reason);
  const decoded = decodeGoogleEnvelope(payload.text);
  if (!decoded.ok) assert.fail(decoded.reason);
  return decoded.envelope;
}
// The port used to read a slice must be the same adapter that stored it; tests keep it in a WeakMap.
const payloadPorts = new WeakMap<GoogleEvidence, McpPort>();
function adapterOf(evidence: GoogleEvidence): McpPort {
  const port = payloadPorts.get(evidence);
  if (!port) throw new Error('no payload port registered for evidence');
  return port;
}

test('google envelope is exactly the five read tools and the family split; a decoy write tool is outside it', () => {
  assert.deepEqual([...GOOGLE_TOOLS], ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message', 'calendar_list_calendars', 'calendar_list_events']);
  assert.deepEqual([...GOOGLE_FAMILIES.gmail], ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message']);
  assert.deepEqual([...GOOGLE_FAMILIES.calendar], ['calendar_list_calendars', 'calendar_list_events']);
  assert.equal((GOOGLE_TOOLS as readonly string[]).includes('gmail_send'), false);
});

test('a granted google endpoint calls the real child with bounded defaults and bounded, partial-marked projections', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ok', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
    const gmail = readerFor(adapter, registry, digest);
    const calendar = readerFor(adapter, registry, digest, { family: 'calendar' });

    const list = completed(await gmail.gmailList({}));
    payloadPorts.set(list, adapter);
    const listEnvelope = envelopeOf(list);
    assert.equal((listEnvelope['received'] as Record<string, unknown>)['maxResults'], GMAIL_LIST_MESSAGES);
    const listProjection = renderGoogleTool('gmail_search_messages', (listEnvelope['data'] as Record<string, unknown>));
    assert.equal(listProjection.partial, false);
    assert.match(listProjection.text, /Synthetic subject line & more \| from: Synthetic Sender \| date: Mon, 1 Jan 2024 00:00:00 \+0000 \| it's <ready> to read/);
    assert.equal(/https?:\/\//.test(listProjection.text), false, 'gmail model text holds no raw url');
    assert.deepEqual(listProjection.sources, [{ title: 'Gmail: Synthetic subject line & more', url: 'https://mail.google.com/mail/u/0/#inbox/m1', sourceType: 'gmail' }, { title: 'Gmail: Synthetic subject line & more', url: 'https://mail.google.com/mail/u/0/#inbox/m2', sourceType: 'gmail' }]);

    const outOfBudget = await gmail.gmailList({ maxResults: 999 });
    assert.equal(outOfBudget.state, 'refused');
    assert.equal(outOfBudget.state === 'refused' ? outOfBudget.reason : '', 'max-results-out-of-budget');

    const read = completed(await gmail.gmailRead({ id: 'm1', format: 'full' }));
    payloadPorts.set(read, adapter);
    const readEnvelope = envelopeOf(read);
    const readProjection = renderGoogleTool('gmail_read_message', (readEnvelope['data'] as Record<string, unknown>));
    assert.equal(readProjection.partial, true);
    assert.match(readProjection.text, /subject: Synthetic subject line/);
    assert.match(readProjection.text, /body truncated|\[omitted: \d+ received characters of body omitted from this display/);

    const events = completed(await calendar.gcalList({ calendarId: 'primary' }));
    payloadPorts.set(events, adapter);
    const calendarEnvelope = envelopeOf(events);
    const received = calendarEnvelope['received'] as Record<string, unknown>;
    assert.equal(received['calendarId'], 'primary');
    assert.equal(typeof received['timeMin'], 'string');
    assert.equal(typeof received['timeMax'], 'string');
    const windowed = completed(await calendar.gcalList({ calendarId: 'primary', timeMin: '2026-10-12T00:00:00+05:30', timeMax: '2026-10-13T00:00:00+05:30' }));
    payloadPorts.set(windowed, adapter);
    const windowReceived = envelopeOf(windowed)['received'] as Record<string, unknown>;
    assert.equal(windowReceived['timeMin'], '2026-10-12T00:00:00+05:30');
    assert.equal(windowReceived['timeMax'], '2026-10-13T00:00:00+05:30');
    const localDefault = completed(await calendar.gcalList({ calendarId: 'primary', timeZone: 'Asia/Kolkata', now: () => Date.parse('2026-10-14T12:00:00Z') }));
    payloadPorts.set(localDefault, adapter);
    const defaultReceived = envelopeOf(localDefault)['received'] as Record<string, unknown>;
    assert.equal(defaultReceived['timeMin'], '2026-10-14T00:00:00+05:30');
    assert.equal(defaultReceived['timeMax'], '2026-10-15T00:00:00+05:30');
    const refused = await calendar.gcalList({ calendarId: 'primary', timeMin: 'not-a-window' });
    assert.equal(refused.state === 'refused' ? refused.reason : '', 'invalid-time-window');
    const eventProjection = renderGoogleTool('calendar_list_events', (calendarEnvelope['data'] as Record<string, unknown>));
    assert.match(eventProjection.text, /2024-01-01T09:00:00Z, Synthetic standup, Room 1/);
    assert.equal(/https?:\/\//.test(eventProjection.text), false, 'calendar model text holds no raw url');
    assert.deepEqual(eventProjection.sources, [{ title: 'Calendar: Synthetic standup', url: 'https://calendar.google.com/event?eid=e1', sourceType: 'calendar' }]);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a merged calendar read stops at its own budget and names the calendars it did not reach', async () => {
  const fake = fakeCalendarPort({
    calendars: [{ id: 'primary', summary: 'Mine', primary: true }, { id: 'b', summary: 'Beta' }, { id: 'c', summary: 'Gamma' }, { id: 'd', summary: 'Delta' }],
    eventsFor: id => ({ id: `e-${id}`, summary: `Event ${id}`, start: { dateTime: '2026-10-16T09:00:00+05:30' } }),
    // The primary answers at once and every other calendar takes longer than the read budget.
    delayFor: id => (id === 'primary' ? undefined : 1500),
  });
  const result = await (await calendarReader(fake.port, { calendarReadMs: 600 })).gcalList({});
  const data = dataOf(result);
  const events = data['events'] as Record<string, unknown>[];
  assert.deepEqual(events.map(event => event['id']), ['e-primary'], 'the calendar read before the budget keeps its event');
  assert.deepEqual(data['partial'], { unread: 3, calendars: ['Beta', 'Gamma', 'Delta'] }, 'the calendars the read did not reach are named, never dropped');
});

test('a default gmail_search_messages asks the child for the batched digest cap of ten messages and renders all ten', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ramp', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
    const gmail = readerFor(adapter, registry, digest);
    const list = completed(await gmail.gmailList({}));
    payloadPorts.set(list, adapter);
    const envelope = envelopeOf(list);
    // The helper now reads the listed messages' metadata in one batched call, so the request is no
    // longer paced by sequential round trips and the digest cap is ten.
    assert.equal(GMAIL_LIST_MESSAGES, 10);
    assert.equal((envelope['received'] as Record<string, unknown>)['maxResults'], GMAIL_LIST_MESSAGES);
    const data = envelope['data'] as Record<string, unknown>;
    assert.equal((data['messages'] as unknown[]).length, GMAIL_LIST_MESSAGES, 'one batched fetch returns every listed message');
    const projection = renderGoogleTool('gmail_search_messages', data);
    assert.equal(projection.text.split('\n').filter(line => line.startsWith('- ')).length, GMAIL_LIST_MESSAGES);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owner-trusted-reads grants exactly the google envelope, never the decoy write tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-host-'));
  const { dir: childDir, pidFile } = scratch();
  const configDir = join(dir, 'provider-config');
  const store = new Store(join(dir, 'data'), toolsMigrations);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const env = { HOME: join(tmpdir(), 'didi-google-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' };
  const entry = { id: 'gmail', transport: 'stdio', command: process.execPath, args: [child, 'decoy', pidFile], env, connector: 'google', account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' };
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [entry] }), { mode: 0o600 });
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null });
  try {
    const grant = runtime.registry.currentGrant('gmail');
    assert(grant);
    assert.deepEqual([...grant!.toolNames].sort(), [...GOOGLE_TOOLS].sort());
    assert.equal(grant!.toolNames.includes('gmail_send'), false);
    assert.equal(grant!.effect, 'read');
    const report = runtime.status().endpoints.find(endpoint => endpoint.id === 'gmail');
    assert.equal(report?.state, 'connected');
    assert.equal(report?.tools, GOOGLE_TOOLS.length);
  } finally {
    await runtime.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(childDir, { recursive: true, force: true });
  }
});

test('a typed credential error becomes a configured/auth-needed status, never an empty success', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'credential', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
    const calendar = readerFor(adapter, registry, digest, { family: 'calendar' });
    const result = await calendar.gcalList({});
    assert.equal(result.state, 'tool-error');
    if (result.state !== 'tool-error') throw new Error('not a tool error');
    const status = googleToolStatus(result);
    assert.deepEqual(status, { state: 'configured', code: 'credential-missing', reason: 'auth needed: run lux-google-mcp authorize --family calendar to sign in again' });
    // The helper's own identity refusal is a pinned refusal too, so it is the same auth-needed status:
    // the owner has to know the account is wrong, and the answer carries the code only, no address and
    // no token path.
    const refused = googleToolStatus({ ...result, decodedResult: { content: [{ type: 'text', text: 'account-mismatch: the credential belongs to another account' }] } } as unknown as ConnectorEvidence);
    assert.deepEqual(refused, { state: 'configured', code: 'account-mismatch', reason: 'auth needed: run lux-google-mcp authorize --family calendar for the account you configured' });
    assert.equal(JSON.stringify(refused).includes('@'), false, 'no address in the status');
    assert.equal(JSON.stringify(refused).includes('/'), false, 'no path in the status');
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The helper's published failure vocabulary, read from the contract fixture the check copies beside the
// compiled test. A code the fixture carries without a table row fails here, and so does a table row that
// disagrees with the contract on pinning.
const CONTRACT = JSON.parse(readFileSync(join(here, 'fixtures', 'google-error-contract-6ee466f0.json'), 'utf8')) as {
  codes: { code: string; pinned: boolean; emitted: boolean; surface: 'call' | 'authorize' | 'both' }[];
};

for (const row of CONTRACT.codes.filter(entry => entry.emitted)) {
  test(`the published helper code ${row.code} maps to its table row, through the fake child`, async () => {
    const { dir, pidFile } = scratch();
    const registry = new McpRegistry();
    registry.register(config('local-stdio', `code:${row.code}`, pidFile));
    const adapter = adapterFor(registry);
    try {
      const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
      const gmail = readerFor(adapter, registry, digest);
      const result = await gmail.gmailList({});
      assert.equal(result.state, 'tool-error');
      if (result.state !== 'tool-error') throw new Error('not a tool error');
      const status = googleToolStatus(result);
      const entry = googleErrorEntry(row.code);
      assert.ok(entry, `the table has a row for ${row.code}`);
      if (!entry) return;
      assert.equal(status?.code, row.code, 'the closed reason is the helper code itself');
      assert.equal(status?.reason, googleOwnerLine(entry, 'gmail'), 'the owner line is the table\'s');
      assert.equal(entry.pinned, row.pinned, 'the table agrees with the published contract on pinning');
      assert.equal(status?.state, 'configured', 'a typed helper failure never empties the answer');
    } finally {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a scope mismatch asks for a re-authorize naming the family, and the old scope code is gone', async () => {
  // credential-insufficient-scope was never a code the helper emitted, so it is no longer in any Didi set.
  assert.equal(googleErrorEntry('credential-insufficient-scope'), undefined);
  assert.equal(Object.keys(GOOGLE_ERROR_TABLE).includes('credential-insufficient-scope'), false);
  assert.equal(GOOGLE_ERROR_TABLE['credential-scope-mismatch']?.pinned, true);
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'code:credential-scope-mismatch', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
    const gmail = readerFor(adapter, registry, digest);
    const result = await gmail.gmailList({});
    if (result.state !== 'tool-error') throw new Error('not a tool error');
    const status = googleToolStatus(result);
    assert.equal(status?.reason, 'auth needed: run lux-google-mcp authorize --family gmail to grant the read scopes again');
    // A pinned refusal is not retried inside this process: the child saw exactly one dispatch.
    assert.equal(callsOf(pidFile).length, 1, 'a pinned code is never retried in the same process');
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transient helper code retries once on the next ask', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'first:provider-failure', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
    const gmail = readerFor(adapter, registry, digest);
    const failed = await gmail.gmailList({});
    if (failed.state !== 'tool-error') throw new Error('not a tool error');
    assert.equal(googleToolStatus(failed)?.reason, 'the Google service failed just now, ask me again and I will retry');
    assert.equal(callsOf(pidFile).length, 1, 'a transient code is not retried inside the same ask');
    const retried = await gmail.gmailList({});
    assert.equal(retried.state, 'completed');
    assert.equal(callsOf(pidFile).length, 2, 'the next ask retries once');
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown helper code is named and logged content free, never a silent empty result', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'code:future-helper-code', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_TOOLS);
    const gmail = readerFor(adapter, registry, digest);
    const result = await gmail.gmailList({});
    if (result.state !== 'tool-error') throw new Error('not a tool error');
    const status = googleToolStatus(result);
    assert.equal(status?.code, UNKNOWN_HELPER_REASON);
    assert.equal(status?.reason, UNKNOWN_HELPER_OWNER_LINE);
    assert.equal(status?.state, 'configured');
    // The log line carries the tool name and the hashed head of the code, never the code or its message.
    assert.deepEqual(status?.log, { event: 'tool_failure', code: 'connector_error', tool: 'gmail_search_messages', connector: 'google', errorClass: 'Error', messageHead: sha256('future-helper-code') });
    assert.equal(JSON.stringify(status).includes('future-helper-code'), false);
    assert.equal(JSON.stringify(status).includes('synthetic helper refusal'), false, 'no helper text anywhere in the status');
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the two legacy credential spellings stay accepted until the lux-cli release retires them', () => {
  // Retire these rows, and this test, when the lux-cli release carrying
  // tools/google-mcp/error-contract.json at 6ee466f0 (train/google-ipc-1024) is installed: both spellings
  // exist only in the helper that is installed today, and the contract emits neither.
  const fresh = GOOGLE_ERROR_TABLE['credential-missing']!;
  for (const legacy of ['credential-missing-env', 'credential_missing']) {
    const entry = googleErrorEntry(legacy);
    assert.ok(entry, `${legacy} is still accepted`);
    if (!entry) continue;
    assert.equal(entry.class, fresh.class);
    assert.equal(entry.pinned, fresh.pinned);
    assert.equal(entry.ownerLine, fresh.ownerLine);
    const status = googleToolStatus({ state: 'tool-error', tool: 'gmail_search_messages', decodedResult: { content: [{ type: 'text', text: `${legacy}: no token is available` }] } } as unknown as ConnectorEvidence);
    assert.equal(status?.code, legacy, 'the legacy spelling is classified, not unknown_helper_code');
  }
  assert.equal(CONTRACT.codes.some(entry => entry.code === 'credential_missing'), false, 'the contract does not spell it this way');
});

test('an ungranted tool name is refused before dispatch even when the remote lists it', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry();
  registry.register(config('local-stdio', 'ok', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', ['gmail_get_profile']);
    const reader = readerFor(adapter, registry, digest);
    const result = await reader.gmailList({});
    assert.equal(result.state, 'refused');
    assert.equal(result.state === 'refused' ? result.reason : '', 'tool-not-granted');
    assert.equal((GOOGLE_TOOLS as readonly string[]).includes('gmail_send'), false);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the owner composes the google tool table and a Live-shaped gmail_search_messages call reaches the fixture and returns projected Markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-owner-'));
  const { dir: childDir, pidFile } = scratch();
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const registry = new McpRegistry();
  const env = { HOME: join(tmpdir(), 'didi-google-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' };
  const command = process.execPath;
  const args = [child, 'ok', pidFile];
  registry.register({ id: 'gmail', transport: 'stdio', command, args, env, account: ACCOUNT, resource: RESOURCE } as unknown as EndpointConfig);
  registry.enable('gmail'); registry.allowEgress('gmail');
  const adapter = adapterFor(registry);
  try {
    const first = await adapter.discover('gmail');
    assert.equal(first.state, 'discovered');
    if (first.state !== 'discovered') throw new Error('not discovered');
    let live: LiveAuthority | null = null;
    const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port: adapter, lookupAuthority: async () => live });
    const policy: ConnectionPolicy = {
      schemaVersion: 1, ownerId: store.assistantId, connectionId: 'gmail', generation: 1, enabled: true, connector: 'google',
      endpoint: { id: 'gmail', transport: 'stdio', command, args, env, account: ACCOUNT, resource: RESOURCE, credentialRef: null },
      toolNames: [...GOOGLE_TOOLS], schemaDigest: first.schemaDigest,
      sourcePolicy: { id: 'google-read', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
      route: { identity: 'voice', allowedClasses: ['private'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
    };
    owner.applyConnection(policy);
    // applyConnection suspends the grant; the owner rediscovery re-observed digest, then projects the grant.
    const second = await adapter.discover('gmail');
    assert.equal(second.state, 'discovered');
    owner.projectConnection('gmail');
    assert.throws(() => owner.applyConnection({ ...policy, toolNames: [...GOOGLE_TOOLS, 'gmail_send'] }), /invalid_read_tools/);
    const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['private'] }, allowedClasses: ['private'], connectionIds: ['gmail'] };
    const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
    live = { ...acceptance, acceptedRunHash: accepted.sha256 };

    const definitions = owner.definitions('run');
    // gmail_read_message carries a remote body, so the owner also admits the local body continuation the run may use.
    assert.deepEqual(definitions.map(definition => definition.name).sort(), [...GOOGLE_TOOLS, 'read_received_body'].sort());
    assert.equal(definitions.some(definition => definition.name === 'gmail_send'), false);

    const callArgs = {};
    const intent: ToolCallIntent = { runId: 'run', actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1, executionId: 'run:1:0', toolName: 'gmail_search_messages', argumentsHash: sha256(JSON.stringify(callArgs)), callId: 'call', accountId: ACCOUNT, resourceId: RESOURCE };
    assert.equal(owner.journal.intent(intent), 'fresh');
    const definition = definitions.find(candidate => candidate.name === 'gmail_search_messages');
    assert(definition?.execute);
    const outcome = await definition!.execute!(callArgs, { ...intent, signal: new AbortController().signal });
    assert.equal(outcome.status, 'completed');
    const row = store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE execution_id=?', ['run:1:0']));
    const stored = JSON.parse(String(row?.result_json)) as { response: Record<string, unknown> };
    assert.equal(stored.response['tool'], 'gmail_search_messages');
    assert.match(String(stored.response['text']), /Synthetic subject line & more \| from: Synthetic Sender \| date: Mon, 1 Jan 2024/);
    assert.equal(/https?:\/\//.test(String(stored.response['text'])), false, 'gmail model text holds no raw url');
    assert.deepEqual(stored.response['sources'], [{ title: 'Gmail: Synthetic subject line & more', url: 'https://mail.google.com/mail/u/0/#inbox/m1', sourceType: 'gmail' }, { title: 'Gmail: Synthetic subject line & more', url: 'https://mail.google.com/mail/u/0/#inbox/m2', sourceType: 'gmail' }]);
  } finally {
    await adapter.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(childDir, { recursive: true, force: true });
  }
});

test('a credential-failing call flips the calendar endpoint to configured/auth-needed and a later success clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-google-status-'));
  const { dir: childDir, pidFile } = scratch();
  const configDir = join(dir, 'provider-config');
  const store = new Store(join(dir, 'data'), toolsMigrations);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const env = { HOME: join(tmpdir(), 'didi-google-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' };
  const command = process.execPath;
  const args = [child, 'flaky', pidFile];
  const entry = { id: 'calendar', transport: 'stdio', command, args, env, connector: 'google', account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' };
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [entry] }), { mode: 0o600 });
  let live: LiveAuthority | null = null;
  const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => live });
  try {
    const first = await runtime.port.discover('calendar');
    assert.equal(first.state, 'discovered');
    if (first.state !== 'discovered') throw new Error('not discovered');
    const policy: ConnectionPolicy = {
      schemaVersion: 1, ownerId: store.assistantId, connectionId: 'calendar', generation: 2, enabled: true, connector: 'google',
      endpoint: { id: 'calendar', transport: 'stdio', command, args, env, account: ACCOUNT, resource: RESOURCE, credentialRef: null },
      toolNames: [...GOOGLE_TOOLS], schemaDigest: first.schemaDigest,
      sourcePolicy: { id: 'google-read', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
      route: { identity: 'voice', allowedClasses: ['private'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
    };
    runtime.owner.applyConnection(policy);
    const second = await runtime.port.discover('calendar');
    assert.equal(second.state, 'discovered');
    runtime.owner.projectConnection('calendar');
    const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['private'] }, allowedClasses: ['private'], connectionIds: ['calendar'] };
    const accepted = store.transaction(tx => runtime.owner.snapshotRun(tx, acceptance));
    live = { ...acceptance, acceptedRunHash: accepted.sha256 };

    const definition = runtime.owner.definitions('run').find(candidate => candidate.name === 'calendar_list_events');
    assert(definition?.execute);
    const callArgs = { calendarId: 'primary' };
    const intent: ToolCallIntent = { runId: 'run', actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1, executionId: 'run:1:0', toolName: 'calendar_list_events', argumentsHash: sha256(JSON.stringify(callArgs)), callId: 'call', accountId: ACCOUNT, resourceId: RESOURCE };
    assert.equal(runtime.owner.journal.intent(intent), 'fresh');
    const failed = await definition!.execute!(callArgs, { ...intent, signal: new AbortController().signal });
    assert.equal(failed.status, 'completed');
    const flipped = runtime.status().endpoints.find(endpoint => endpoint.id === 'calendar');
    assert.equal(flipped?.state, 'configured');
    assert.equal(flipped?.error, 'auth needed: run lux-google-mcp authorize --family calendar');
    const row = store.transaction(tx => tx.get('SELECT result_json FROM tool_calls WHERE execution_id=?', ['run:1:0']));
    const stored = JSON.parse(String(row?.result_json)) as { response: Record<string, unknown> };
    assert.match(String(stored.response['text']), /auth needed: run lux-google-mcp authorize --family calendar/);

    const intentTwo: ToolCallIntent = { ...intent, executionId: 'run:1:1', callId: 'call-2' };
    assert.equal(runtime.owner.journal.intent(intentTwo), 'fresh');
    const succeeded = await definition!.execute!(callArgs, { ...intentTwo, signal: new AbortController().signal });
    assert.equal(succeeded.status, 'completed');
    const cleared = runtime.status().endpoints.find(endpoint => endpoint.id === 'calendar');
    assert.equal(cleared?.state, 'connected');
    assert.equal(cleared?.error, undefined);
  } finally {
    await runtime.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(childDir, { recursive: true, force: true });
  }
});

// Fake MCP HTTP server at the real guarded-fetch seam, no listening socket or corpus.
test('gmail_search_messages projects an SSE MCP entity from separately decodedResult', async t => {
  const sdk = new Server({ name: 'synthetic-sse', version: '1' }, { capabilities: { tools: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: false });
  const tool = { name: 'gmail_search_messages', inputSchema: { type: 'object' } };
  sdk.setRequestHandler('tools/list', () => ({ tools: [tool] }) as never);
  sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ family: 'gmail', tool: 'gmail_search_messages', method: 'gmail_search_messages', account: { configured: 'synthetic', provider: null }, data: { messages: [{ id: 'sse-id', headers: { Subject: 'Synthetic SSE', From: 'sse@example.invalid', Date: 'synthetic-date' } }] } }) }], structuredContent: { marker: 'synthetic-unclassified' }, isError: false }) as never);
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.method === 'GET' ? new Response(null, { status: 405 }) : transport.handleRequest(request);
  });
  const registry = new McpRegistry();
  registry.register({ id: 'sse', url: 'http://127.0.0.1:18766/mcp', account: 'synthetic', resource: 'synthetic' });
  registry.enable('sse'); registry.allowEgress('sse');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  t.after(async () => { await adapter.close(); await sdk.close(); });
  const discovery = await adapter.discover('sse'); assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw Error('discovery failed');
  registry.approve({ endpointId: 'sse', schemaDigest: discovery.schemaDigest, toolNames: ['gmail_search_messages'], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const result = await createGoogleReader({ port: adapter, registry, config: { endpointId: 'sse', account: 'synthetic', resource: 'synthetic', schemaDigest: discovery.schemaDigest, generation: 1, family: 'gmail' } }).gmailList({ maxResults: 1 });
  assert.equal(result.state, 'completed');
  if (result.state !== 'completed' || result.response.state !== 'available') throw Error('missing result');
  const wire = adapter.readSlice({ ...result.source, handle: result.response.handle, offset: 0, length: 16 });
  assert.equal(wire.state, 'available');
  if (wire.state === 'available') assert.match(new TextDecoder().decode(wire.bytes), /^event:|^data:/);
  const projected = projectGoogleResult(adapter, result); assert.equal(projected.ok, true);
  if (!projected.ok) throw Error('projection failed');
  assert(projected.projection.text.includes('Synthetic SSE'));
  assert(!projected.projection.text.includes('synthetic-unclassified'));
});

// --- F4-R2: the connector resolves the selected calendars and merges in bounded parallel ---------

const CALENDAR_DIGEST = 'synthetic-calendar-digest';

async function calendarReader(port: McpPort, overrides: Partial<GoogleConfig> = {}, eventProperties?: Record<string, unknown>) {
  const registry = new McpRegistry();
  const endpoint = config('calendar-fake', 'ok', join(tmpdir(), 'calendar-fake.pid'));
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const tools = [{ name: 'calendar_list_calendars', inputSchema: { type: 'object' } }, { name: 'calendar_list_events', inputSchema: { type: 'object', ...(eventProperties === undefined ? {} : { properties: eventProperties }) } }];
  const digest = registry.observed('calendar-fake', tools, registry.revision('calendar-fake'));
  registry.approve({ endpointId: 'calendar-fake', schemaDigest: digest, toolNames: ['calendar_list_calendars', 'calendar_list_events'], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return createGoogleReader({ port, registry, config: { endpointId: 'calendar-fake', account: ACCOUNT, resource: RESOURCE, schemaDigest: digest, generation: 1, ...overrides, family: 'calendar' } });
}
function dataOf(result: GoogleResult): Record<string, unknown> {
  if (result.state !== 'completed') throw new Error(`not completed: ${JSON.stringify(result)}`);
  const content = (result.decodedResult as { content?: { text?: string }[] }).content;
  const envelope = JSON.parse(content?.[0]?.text ?? '{}') as { data?: Record<string, unknown> };
  return envelope.data ?? {};
}
function fakeCalendarPort(options: { calendars: { id: string; summary: string; primary?: boolean }[]; eventsFor: (id: string, index: number) => Record<string, unknown>; delayFor?: (id: string) => number | undefined; defer?: boolean; delayMs?: number }): { port: McpPort; listArgs: Record<string, unknown>[]; peak: () => number; pending: () => number; release: () => void } {
  const scope = { endpointId: 'calendar-fake', url: 'https://fake.invalid', schemaDigest: CALENDAR_DIGEST, toolName: 'calendar_list_events', generation: 1, account: ACCOUNT, resource: RESOURCE } as unknown as ResultScope;
  const completed = (data: unknown): CompletedResult => ({
    state: 'completed', decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data }) }] },
    source: scope, coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
    freshness: { receivedAt: 0, sourceVersion: 'unknown' },
    projection: { text: '', omitted: false, originalCharacters: 0, omittedCharacters: 0 },
    payload: { state: 'unavailable', reason: 'capacity' },
  });
  const listArgs: Record<string, unknown>[] = [];
  const gates: (() => void)[] = [];
  let inFlight = 0, peak = 0, index = 0;
  const port: McpPort = {
    discover: async () => ({ state: 'discovered', endpointId: 'calendar-fake', schemaDigest: CALENDAR_DIGEST, tools: [{ name: 'calendar_list_calendars', inputSchema: { type: 'object' } }, { name: 'calendar_list_events', inputSchema: { type: 'object' } }], observedAt: 0 }),
    visibleTools: () => [],
    whenSuspended: async () => undefined,
    close: async () => undefined,
    readSlice: () => ({ state: 'unavailable', reason: 'synthetic' }),
    async call(request, signal): Promise<CallResult> {
      if (request.toolName === 'calendar_list_calendars') return completed({ calendars: options.calendars });
      const id = String(request.arguments['calendarId']);
      listArgs.push({ ...request.arguments });
      const at = index++;
      const delay = options.delayFor?.(id) ?? options.delayMs;
      if (delay !== undefined) await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      if (options.defer) {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise<void>(resolve => gates.push(resolve));
        inFlight -= 1;
      }
      return completed({ events: [options.eventsFor(id, at)] });
    },
  };
  return { port, listArgs, peak: () => peak, pending: () => gates.length, release: () => { for (const gate of gates.splice(0)) gate(); } };
}

test('R5: an older helper without an include property is never sent one', async () => {
  const fake = fakeCalendarPort({ calendars: [{ id: 'a', summary: 'Alpha' }], eventsFor: () => timedEvent });
  await (await calendarReader(fake.port)).gcalList({});
  assert.equal(fake.listArgs.length, 1);
  assert.equal('include' in fake.listArgs[0]!, false, 'the old helper refuses any argument it does not declare');
});

test('R5/R6: a helper that advertises include is asked for attendees and organizer', async () => {
  const fake = fakeCalendarPort({ calendars: [{ id: 'a', summary: 'Alpha' }], eventsFor: () => timedEvent });
  await (await calendarReader(fake.port, {}, { include: { type: 'array', items: { type: 'string' } } })).gcalList({});
  assert.equal(fake.listArgs.length, 1);
  assert.deepEqual(fake.listArgs[0]!['include'], ['attendees', 'organizer']);
});

test('a calendar read with no id resolves every selected calendar and merges, sorts, dedupes and tags', async () => {
  const shared = { id: 'e-shared', summary: 'Standup', start: { dateTime: '2026-10-16T09:00:00+05:30' } };
  const later = { id: 'e-later', summary: 'Review', start: { dateTime: '2026-10-16T11:00:00+05:30' } };
  const fake = fakeCalendarPort({ calendars: [{ id: 'a', summary: 'Alpha' }, { id: 'b', summary: 'Beta' }, { id: 'c', summary: 'Gamma' }], eventsFor: (id) => (id === 'c' ? later : shared) });
  const result = await (await calendarReader(fake.port)).gcalList({});
  const data = dataOf(result);
  const events = data['events'] as Record<string, unknown>[];
  assert.equal(events.length, 2, 'a shared event is deduped by id across calendars');
  assert.deepEqual(events.map(event => [event['id'], event['calendar']]), [['e-shared', 'Alpha'], ['e-later', 'Gamma']]);
  assert.deepEqual(fake.listArgs.map(args => args['calendarId']).sort(), ['a', 'b', 'c']);
  const projection = renderGoogleTool('calendar_list_events', data);
  assert.match(projection.text, /2026-10-16T09:00:00\+05:30, Standup \| Alpha/);
  assert.match(projection.text, /2026-10-16T11:00:00\+05:30, Review \| Gamma/);
});

test('per-calendar reads run concurrently inside the connector, bounded at six, with no sleeps', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const fake = fakeCalendarPort({
    calendars: ids.map((id, i) => ({ id, summary: id.toUpperCase() + String(i) })),
    eventsFor: (id, index) => ({ id: `e-${id}`, summary: `Event ${id}`, start: { dateTime: `2026-10-16T0${index}:00:00+05:30` } }),
    defer: true,
  });
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const run = (await calendarReader(fake.port)).gcalList({});
  let done = false; void run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200 && !done && fake.pending() < 6; i += 1) await tick();
  assert.equal(fake.peak(), 6, 'at most six per-calendar reads are in flight');
  for (let i = 0; i < 200 && !done; i += 1) { fake.release(); await tick(); }
  fake.release();
  const result = await run;
  const events = dataOf(result)['events'] as Record<string, unknown>[];
  assert.equal(events.length, 8);
  assert.deepEqual(events.map(event => event['calendar']), ids.map(id => id.toUpperCase() + String(ids.indexOf(id))));
});

// --- F9-R1: the primary calendar is always read; unread calendars are reported, never dropped --------

test('a calendar read returns the primary and counts the calendars the deadline cut off', async () => {
  const calendars = [{ id: 'primary', summary: 'Me', primary: true }, ...Array.from({ length: 9 }, (_, i) => ({ id: `other-${i}`, summary: `Other ${i}` }))];
  // 3.5 s per calendar read; the sub-deadline fires at 3.6 s, after the primary has answered.
  const fake = fakeCalendarPort({ calendars, eventsFor: id => ({ id: `event-${id}`, summary: id, start: { dateTime: '2026-10-16T09:00:00+05:30' } }), delayMs: 3_500 });
  const controller = new AbortController();
  const reader = await calendarReader(fake.port);
  const run = reader.gcalList({ timeMin: '2026-10-16T00:00:00+05:30', timeMax: '2026-10-17T00:00:00+05:30' }, controller.signal);
  setTimeout(() => controller.abort(), 3_600);
  const result = await run;
  const data = dataOf(result);
  assert.deepEqual(data['partial'], { unread: 9, calendars: Array.from({ length: 9 }, (_, i) => `Other ${i}`) }, 'the nine calendars the deadline cut off are named, not dropped');
  const events = data['events'] as Record<string, unknown>[];
  assert.equal(events.some(event => event['id'] === 'event-primary' && event['calendar'] === 'Me'), true, 'the primary calendar is always returned');
});

// --- W2: the caller's remaining source budget bounds the fan-out ---------------------------------

/** The absolute source deadline a caller passes, the field behaviour 1 adds to the read input. */
function budgeted(input: GcalListInput, deadlineAt: number): GcalListInput {
  return { ...input, deadlineAt } as GcalListInput;
}

test('a caller-budgeted calendar read keeps every calendar it can reach inside that budget', async () => {
  const ids = ['primary', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const fake = fakeCalendarPort({
    calendars: ids.map((id, n) => ({ id, summary: n === 0 ? 'Mine' : id.toUpperCase(), ...(n === 0 ? { primary: true } : {}) })),
    eventsFor: id => ({ id: `e-${id}`, summary: `Event ${id}`, start: { dateTime: '2026-10-16T09:00:00+05:30' } }),
    // The audit's shape, compressed to keep the test short: primary 0.6 s, eight others 0.5 to 3 s.
    delayFor: id => (id === 'primary' ? 60 : 50 + 10 * (ids.indexOf(id) - 1)),
  });
  const started = Date.now();
  const result = await (await calendarReader(fake.port)).gcalList(budgeted({}, Date.now() + 1_000));
  const elapsed = Date.now() - started;
  const data = dataOf(result);
  assert.equal((data['events'] as unknown[]).length, ids.length, 'every calendar inside the budget is read, concurrently not serially');
  assert.equal(data['partial'], undefined, 'nothing was cut off, so nothing is reported unread');
  assert.ok(elapsed <= 1_000, `the read finished inside the caller budget: ${elapsed}`);
});

test('a hanging calendar returns at the caller deadline, with the rest and that one named unread', async () => {
  const fake = fakeCalendarPort({
    calendars: [{ id: 'primary', summary: 'Me', primary: true }, { id: 'b', summary: 'Beta' }, { id: 'c', summary: 'Gamma' }],
    eventsFor: id => ({ id: `e-${id}`, summary: `Event ${id}`, start: { dateTime: '2026-10-16T09:00:00+05:30' } }),
    delayFor: id => (id === 'c' ? 1_200 : 60),
  });
  const started = Date.now();
  const result = await (await calendarReader(fake.port)).gcalList(budgeted({}, Date.now() + 500));
  const elapsed = Date.now() - started;
  const data = dataOf(result);
  assert.deepEqual((data['events'] as Record<string, unknown>[]).map(event => event['id']), ['e-primary', 'e-b'], 'the calendars read inside the budget keep their events');
  assert.deepEqual(data['partial'], { unread: 1, calendars: ['Gamma'] }, 'the calendar the budget cut off is named, never dropped');
  assert.ok(elapsed >= 400 && elapsed <= 900, `the read returned at the caller deadline: ${elapsed}`);
});

// 339: the warm context's calendar digest. One bounded primary-calendar read, local host time, no
// model call; unconfigured, empty or failed leaves the slot out so a session start never fails.
type DigestReader = { calls: GcalListInput[]; gcalList(input: GcalListInput): Promise<GoogleResult> };
function digestReader(events: readonly Record<string, unknown>[] | 'refused'): DigestReader {
  const calls: GcalListInput[] = [];
  return {
    calls,
    async gcalList(input: GcalListInput): Promise<GoogleResult> {
      calls.push(input);
      if (events === 'refused') return { state: 'refused', reason: 'tool-not-granted' };
      const data = { events: [...events] };
      const evidence: GoogleEvidence = {
        state: 'completed', tool: 'calendar_list_events', observedAt: 1_760_000_000_000,
        decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data }) }] },
        source: {} as ResultScope, coverage: {} as GoogleEvidence['coverage'],
        projection: {} as GoogleEvidence['projection'], response: {} as GoogleEvidence['response'],
      };
      return evidence;
    },
  };
}
const digestNow = Date.parse('2026-10-18T10:00:00Z');
const timedEvent = { id: 'e1', summary: 'standup', start: { dateTime: '2026-10-18T09:00:00Z' }, end: { dateTime: '2026-10-18T09:15:00Z' } };

test('the warm calendar digest leaves the slot out when the connector is unconfigured', async () => {
  assert.equal(await buildCalendarDigest(undefined, { now: digestNow, timeZone: 'UTC' }), undefined);
});

test('the warm calendar digest reads the primary calendar once and renders the empty day as absent', async () => {
  const read = digestReader([]);
  assert.equal(await buildCalendarDigest(read, { now: digestNow, timeZone: 'UTC' }), undefined);
  assert.equal(read.calls.length, 1, 'exactly one bounded read');
  assert.equal(read.calls[0]!.calendarId, 'primary', 'the primary calendar only');
  assert.equal(read.calls[0]!.timeMin, '2026-10-18T00:00:00+00:00');
  assert.equal(read.calls[0]!.timeMax, '2026-10-19T00:00:00+00:00');
  assert.equal(read.calls[0]!.maxResults, 10);
});

test('the warm calendar digest keeps one bounded line and trims a day that does not fit', async () => {
  const busy = Array.from({ length: 30 }, (_, index) => ({ id: 'e' + index, summary: 'review with the whole team ' + index, start: { dateTime: '2026-10-18T0' + (index % 10) + ':00:00Z' } }));
  const digest = await buildCalendarDigest(digestReader(busy), { now: digestNow, timeZone: 'UTC' });
  assert.equal(typeof digest, 'string');
  assert.ok((digest ?? '').length <= CALENDAR_DIGEST_CHARS, 'the digest never exceeds the bound');
  assert.match(digest ?? '', /^00:00 review with the whole team 0/, 'the first event keeps its local clock time');
  assert.match(digest ?? '', /team 10$/, 'the last event that fits is kept whole');
  assert.equal((digest ?? '').endsWith(', '), false, 'a trimmed digest never ends on a separator');
});

test('the warm calendar digest renders the day in the host time zone', async () => {
  const utc = await buildCalendarDigest(digestReader([timedEvent]), { now: digestNow, timeZone: 'UTC' });
  const kolkata = await buildCalendarDigest(digestReader([timedEvent]), { now: digestNow, timeZone: 'Asia/Kolkata' });
  assert.equal(utc, '09:00 standup');
  assert.equal(kolkata, '14:30 standup', 'the same instant, the host zone');
  const refused = await buildCalendarDigest(digestReader('refused'), { now: digestNow, timeZone: 'UTC' });
  assert.equal(refused, undefined, 'a refused read leaves the slot out rather than failing the start');
});

test('Gmail precise body read defaults to full and preserves deliberate metadata requests through the actual SDK child', async () => {
  const { dir, pidFile } = scratch();
  const registry = new McpRegistry(); registry.register(config('local-stdio', 'ok', pidFile));
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_FAMILIES.gmail);
    const gmail = readerFor(adapter, registry, digest);
    for (const input of [{ id: 'synthetic-message' }, { id: 'synthetic-message', format: 'metadata' as const }]) {
      const evidence = completed(await gmail.gmailRead(input)); payloadPorts.set(evidence, adapter);
      const received = envelopeOf(evidence)['received'] as Record<string, unknown>;
      assert.equal(received['id'], 'synthetic-message');
      assert.equal(received['format'], input.format ?? 'full');
    }
    assert.equal((await gmail.gmailRead({ id: 'synthetic-message', format: 'invalid' as 'full' })).state, 'refused');
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const family of ['gmail', 'calendar'] as const) test(`Google native envelope: ${family} outer coverage cursor survives the actual SDK projector`, async t => {
  const name = family === 'gmail' ? 'gmail_search_messages' : 'calendar_list_events';
  const sdk = new Server({ name: 'native-google-envelope', version: '1' }, { capabilities: { tools: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  sdk.setRequestHandler('tools/list', () => ({ tools: [{ name, inputSchema: { type: 'object' } }] }) as never);
  sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ family, tool: name, method: name, account: { configured: 'synthetic', provider: null }, data: family === 'gmail' ? { messages: Array.from({ length: 8 }, (_, n) => ({ id: `native-message-${n}`, threadId: 'native-thread', internalDate: String(1792368000000 - n), headers: [{ name: 'Subject', value: `Native page evidence ${n}` }], snippet: `Received native snippet ${n}` })) } : { events: [{ id: 'native-event', summary: 'Native page evidence', start: { dateTime: '2026-10-19T10:00:00Z' } }] }, coverage: { returned: 1, complete: false, next_page_token: 'native-next', ...(family === 'calendar' ? { visibility: 'unverified' } : {}) }, diagnostics: [] }) }] }) as never);
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => { const request = new Request(input, init); return request.method === 'GET' ? new Response(null, { status: 405 }) : transport.handleRequest(request); });
  const registry = new McpRegistry(); registry.register({ id: 'native', url: 'http://127.0.0.1:18769/mcp', account: 'synthetic', resource: 'synthetic' }); registry.enable('native'); registry.allowEgress('native');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() }); t.after(async () => { await adapter.close(); await sdk.close(); });
  const discovery = await adapter.discover('native'); assert.equal(discovery.state, 'discovered'); if (discovery.state !== 'discovered') throw Error('discovery failed');
  registry.approve({ endpointId: 'native', schemaDigest: discovery.schemaDigest, toolNames: [name], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const source = createGoogleReader({ port: adapter, registry, config: { endpointId: 'native', account: 'synthetic', resource: 'synthetic', schemaDigest: discovery.schemaDigest, generation: 1, family } });
  const result = family === 'gmail' ? await source.gmailList({ q: 'subject:evidence' }) : await source.gcalList({ calendarId: 'primary' });
  const projected = projectGoogleResult(adapter, result); assert.equal(projected.ok, true); if (!projected.ok) return;
  assert.equal(projected.projection.partial, true);
  if (family === 'calendar') assert.equal(projected.projection.calendarPage?.nextPageToken, 'native-next');
  else {
    assert.match(projected.projection.text, /upstream continuation available/);
    const page = (projected.projection as unknown as { mailPage?: { messages: { id: string; threadId: string; internalDate: string }[]; nextPageToken?: string } }).mailPage;
    assert(page, 'received mail page must survive projection'); assert.equal(page.nextPageToken, 'native-next'); assert.equal(page.messages.length, 8, 'presentation cap must not discard received message identities');
    assert.equal(page.messages[7]!.id, 'native-message-7'); assert.equal(page.messages[0]!.threadId, 'native-thread'); assert.equal(page.messages[0]!.internalDate, '1792368000000');
  }
});

test('Gmail retained evidence: actual SDK full received body is host-only and keeps upstream completeness unknown', async () => {
  const { dir, pidFile } = scratch(); const registry = new McpRegistry(); const endpoint = config('local-stdio', 'quoted', pidFile); registry.register(endpoint);
  const adapter = adapterFor(registry);
  try {
    const digest = await discoverAndApprove(registry, adapter, 'local-stdio', GOOGLE_FAMILIES.gmail);
    const evidence = completed(await readerFor(adapter, registry, digest).gmailRead({ id: 'm1' }));
    const policy: ConnectionPolicy = { schemaVersion: 1, ownerId: 'synthetic-owner', connectionId: 'local-stdio', generation: 1, enabled: true, connector: 'google', endpoint: { ...endpoint, credentialRef: null } as ConnectionPolicy['endpoint'], toolNames: [...GOOGLE_FAMILIES.gmail], schemaDigest: digest, sourcePolicy: { id: 'source', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'synthetic-route', allowedClasses: ['ordinary'] }, bounds: { maxQueryChars: 2048, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 65536, maxResultBytes: 65536 } };
    const snapshot = connectorDescriptor('google')!.project(evidence, adapter, policy);
    const retained = snapshot[HOST_EVIDENCE]; assert(retained && retained.kind === 'remote-body');
    assert.equal(snapshot.response['partial'], true, 'quoted received text omitted by display cleaning remains explicit');
    assert(Number(snapshot.response['omittedCharacters']) > 20000);
    assert(retained.body.endsWith('b'.repeat(20000))); assert.match(retained.body, /Synthetic retained historical evidence/); assert.equal(retained.upstreamComplete, 'unknown'); assert.equal(retained.upstreamOmitted, 'unknown');
    assert.equal(retained.tool, 'gmail_read_message'); assert.equal(retained.expiresAt, evidence.response.state === 'available' ? evidence.response.expiresAt : 0);
    assert(!JSON.stringify(snapshot).includes('b'.repeat(1600)), 'full body and private reference never serialize');
    assert.doesNotMatch(String(snapshot.response['text']), /final, a single message has no partial re-read/);
    const metadata = completed(await readerFor(adapter, registry, digest).gmailRead({ id: 'm1', format: 'metadata' }));
    const metadataSnapshot = connectorDescriptor('google')!.project(metadata, adapter, policy);
    assert.equal(metadataSnapshot[HOST_EVIDENCE], undefined); assert.match(String(metadataSnapshot.response['text']), /Metadata-only view requested/);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('#574: one named calendar asks for attendees and organizer too, and an older helper is never sent it', async () => {
  const advertised = fakeCalendarPort({ calendars: [{ id: 'a', summary: 'Alpha' }], eventsFor: () => timedEvent });
  await (await calendarReader(advertised.port, {}, { include: { type: 'array', items: { type: 'string' } } })).gcalList({ calendarId: 'a' });
  assert.equal(advertised.listArgs.length, 1);
  assert.deepEqual(advertised.listArgs[0]!['include'], ['attendees', 'organizer'], 'the day read names who is in the meeting');
  const old = fakeCalendarPort({ calendars: [{ id: 'a', summary: 'Alpha' }], eventsFor: () => timedEvent });
  await (await calendarReader(old.port)).gcalList({ calendarId: 'a' });
  assert.equal('include' in old.listArgs[0]!, false, 'the old helper refuses any argument it does not declare');
});
