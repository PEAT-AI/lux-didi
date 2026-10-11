import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/index.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { EndpointConfig, McpPort } from '../adapters/mcp/port.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { GOOGLE_FAMILIES, GOOGLE_TOOLS, createGoogleReader, type GoogleConfig, type GoogleEvidence, type GoogleResult } from '../connectors/index.js';
import { credentialFailure, decodeGoogleEnvelope, googleToolStatus, readGooglePayload, renderGoogleTool } from '../tools/google.js';

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
  assert.deepEqual([...GOOGLE_TOOLS], ['gmail_get_profile', 'gmail_list', 'gmail_read', 'gcal_calendars', 'gcal_list']);
  assert.deepEqual([...GOOGLE_FAMILIES.gmail], ['gmail_get_profile', 'gmail_list', 'gmail_read']);
  assert.deepEqual([...GOOGLE_FAMILIES.calendar], ['gcal_calendars', 'gcal_list']);
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
    assert.equal((listEnvelope['received'] as Record<string, unknown>)['maxResults'], 10);
    const listProjection = renderGoogleTool('gmail_list', (listEnvelope['data'] as Record<string, unknown>));
    assert.equal(listProjection.partial, false);
    assert.match(listProjection.text, /Synthetic subject line, Synthetic Sender, Mon, 1 Jan 2024/);
    assert.match(listProjection.text, /source: https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/m1/);

    const outOfBudget = await gmail.gmailList({ maxResults: 999 });
    assert.equal(outOfBudget.state, 'refused');
    assert.equal(outOfBudget.state === 'refused' ? outOfBudget.reason : '', 'max-results-out-of-budget');

    const read = completed(await gmail.gmailRead({ id: 'm1', format: 'full' }));
    payloadPorts.set(read, adapter);
    const readEnvelope = envelopeOf(read);
    const readProjection = renderGoogleTool('gmail_read', (readEnvelope['data'] as Record<string, unknown>));
    assert.equal(readProjection.partial, true);
    assert.match(readProjection.text, /subject: Synthetic subject line/);
    assert.match(readProjection.text, /body truncated/);

    const events = completed(await calendar.gcalList({}));
    payloadPorts.set(events, adapter);
    const calendarEnvelope = envelopeOf(events);
    const received = calendarEnvelope['received'] as Record<string, unknown>;
    assert.equal(received['calendarId'], 'primary');
    assert.equal(typeof received['timeMin'], 'string');
    assert.equal(typeof received['timeMax'], 'string');
    const eventProjection = renderGoogleTool('gcal_list', (calendarEnvelope['data'] as Record<string, unknown>));
    assert.match(eventProjection.text, /2024-01-01T09:00:00Z, Synthetic standup, Room 1/);
    assert.match(eventProjection.text, /source: https:\/\/calendar\.google\.com\/event\?eid=e1/);
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
  const entry = { id: 'gmail', transport: 'stdio', command: process.execPath, args: [child, 'decoy', pidFile], env, connector: 'google', account: ACCOUNT, resource: RESOURCE, credentialRef: null, enabled: true, allowEgress: true };
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
    assert.deepEqual(status, { state: 'configured', reason: 'auth needed: run gcal --auth' });
    assert.equal(credentialFailure('credential-missing: no token'), true);
    assert.equal(credentialFailure('provider-failure: http 500'), false);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
