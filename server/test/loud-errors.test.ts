// W14: a connector failure is loud. LOGS.md L-01, L-02 and L-08.
//
// L-01: a Drive read that the helper refused with a classified error reached the model as
// "searched Drive, found nothing". The tool layer returns a classified failure as a completed
// result whose text is the owner line (server/tools/index.ts), so research's own classification
// has to read that text as a failed source, for every source family, never as an empty search.
// L-02: `connector_connected drive` proves only that the helper process started; Drive carries no
// consent probe, so nothing shows the missing consent before the first call.
// L-08: a classified failure wrote no host event, so host.log could not tell empty from failed.
//
// Every identity here is synthetic: a fixture account and a fixture token path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { safeEvent } from '../host/log.js';
import { sha256 } from '../tools/canonical.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { noteGmailAccount } from '../tools/open-handles.js';
import type { EndpointConfig } from '../adapters/mcp/port.js';
import type { LiveAuthority, RunAcceptance } from '../tools/types.js';
import type { ToolCallIntent } from '../adapters/model/types.js';
import { ResearchLedger, runResearch, type ResearchDeps, type ResearchSourceLog, type SourceKind } from '../tools/research.js';
import { GOOGLE_ERROR_TABLE, googleOwnerLine, googleToolStatus, type GoogleStatus } from '../tools/google.js';
import { CONNECTOR_DESCRIPTORS } from '../connectors/index.js';
import { GOOGLE_TOOLS } from '../connectors/google.js';
import { classifyIdentity, proveIdentity, type IdentityProof } from '../connectors/identity.js';
import { classifiedFailureEvent } from '../tools/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACCOUNT = 'ravi.example@example.test';
const TOKEN_PATH = '/tmp/synthetic-google-token.json';

/** The endpoint binding the helper itself reads, so the owner action can name its own command. */
function driveEndpoint(): { id: string; transport: 'stdio'; command: string; args: readonly string[]; env: Record<string, string>; account: string; resource: string; credentialRef: null } {
  return {
    id: 'drive', transport: 'stdio', command: 'lux-google-mcp', args: ['--family', 'drive'],
    env: { LUX_GOOGLE_MCP_ACCOUNT: ACCOUNT, LUX_GOOGLE_MCP_TOKEN: TOKEN_PATH },
    account: 'local', resource: 'google-drive', credentialRef: null,
  };
}

/** The owner line the table holds for a missing Drive consent, filled in for this endpoint. */
function driveConsentLine(): string {
  const entry = GOOGLE_ERROR_TABLE['scope_missing'];
  assert.ok(entry, 'the helper contract carries scope_missing');
  return googleOwnerLine(entry, 'drive', driveEndpoint());
}

function subResult(call: IntentSubCall, text: string, ok = true, classified?: string): IntentSubResult {
  // LOGS.md L-01: the tool layer marks the projection it builds for a classified connector failure with
  // that failure's own code, and the fixture carries the same mark the real producer sets.
  return { key: call.key, name: call.name, ok, text, originalCharacters: text.length, omittedCharacters: 0,
    ...(classified === undefined ? {} : { classified }) } as IntentSubResult;
}

function harness(configured: readonly SourceKind[], answer: (call: IntentSubCall) => IntentSubResult): { deps: ResearchDeps; calls: IntentSubCall[]; sources: ResearchSourceLog[] } {
  const calls: IntentSubCall[] = [];
  const sources: ResearchSourceLog[] = [];
  const deps: ResearchDeps = {
    now: () => Date.parse('2026-10-19T12:00:00Z'), timeZone: 'UTC', configured,
    execute: async subs => { calls.push(...subs); return subs.map(answer); },
    emit: () => {}, log: () => {}, logRouted: () => {}, logSource: event => sources.push(event), logSubcall: () => {},
    ledger: new ResearchLedger(),
  };
  return { deps, calls, sources };
}

/** The families a research lookup can name, one per shaped source path. */
const FAMILIES: readonly { source: SourceKind; question: string; query: string }[] = [
  { source: 'drive', question: 'find the harbour review deck', query: 'harbour review' },
  { source: 'mail', question: 'find the harbour review mail', query: 'harbour review' },
  // A calendar lookup resolves its window first, so it asks with one.
  { source: 'calendar', question: 'what is on my calendar this week', query: 'this week' },
  { source: 'chat', question: 'find the harbour review thread', query: 'harbour review' },
  { source: 'knowledge', question: 'find the harbour review note', query: 'harbour review' },
];

/** The calendar scope read answers with the one synthetic calendar; every other sub answers with `text`. */
function answerFor(text: string, classified?: string): (call: IntentSubCall) => IntentSubResult {
  return call => subResult(call, call.name === 'calendar_list_calendars' ? '- Main [primary]' : text, true, classified);
}

for (const family of FAMILIES) {
  test(`L-01 ${family.source}: a classified connector error is a failed source, never an empty search`, async () => {
    const line = driveConsentLine();
    const h = harness([family.source], answerFor(line, 'scope_missing'));
    const reply = await runResearch(h.deps, { action: 'start', question: family.question, topic: 'harbour review', lookups: [{ source: family.source, query: family.query }] }, new AbortController().signal);
    const receipt = h.sources.find(entry => entry.source === family.source);
    assert.ok(receipt, 'the source settled with a receipt');
    assert.equal(receipt.outcome, 'failed', `a classified error is a failed ${family.source} read, not ${receipt.outcome}`);
    const text = JSON.stringify(reply);
    assert.ok(text.includes(line), `the reply carries the owner action verbatim for ${family.source}: ${text}`);
  });

  test(`L-01 ${family.source}: a real empty read still reads as empty`, async () => {
    const h = harness([family.source], answerFor(''));
    const reply = await runResearch(h.deps, { action: 'start', question: family.question, topic: 'harbour review', lookups: [{ source: family.source, query: family.query }] }, new AbortController().signal);
    const receipt = h.sources.find(entry => entry.source === family.source);
    assert.ok(receipt, 'the source settled with a receipt');
    assert.equal(receipt.outcome, 'empty', `a read that returned nothing is empty, not ${receipt.outcome}`);
    assert.equal(JSON.stringify(reply).includes('authorize --family'), false, 'no owner action is invented for an empty read');
  });
}

test('L-01: the classified owner line names the helper command, the fixture account and the token path, as a one-time step', () => {
  const line = driveConsentLine();
  assert.match(line, /lux-google-mcp authorize --family drive/u);
  assert.ok(line.includes(`--account ${ACCOUNT}`), line);
  assert.ok(line.includes(`--token ${TOKEN_PATH}`), line);
  assert.match(line, /one-time/u, 'the owner is told this consent happens once');
  assert.ok(line.startsWith('Drive needs a one-time consent first'), line);
});

test('L-01: without a configured binding the owner line still names the family command and no token', () => {
  const entry = GOOGLE_ERROR_TABLE['scope_missing'];
  assert.ok(entry);
  const line = googleOwnerLine(entry, 'drive');
  assert.match(line, /lux-google-mcp authorize --family drive/u);
  assert.equal(line.includes('--token'), false, 'never a token path the host did not read');
});

test('L-01: the tool layer classifies a scope_missing helper answer as a configured credential failure', () => {
  const evidence = {
    state: 'tool-error', tool: 'drive_search_files',
    decodedResult: { content: [{ type: 'text', text: 'scope_missing: Drive needs its own read consent' }], isError: true },
  } as unknown as ConnectorEvidence;
  const status = googleToolStatus(evidence, driveEndpoint()) as GoogleStatus;
  assert.equal(status.code, 'scope_missing');
  assert.equal(status.state, 'configured');
  assert.ok(status.reason.includes('lux-google-mcp authorize --family drive'));
});

test('L-02: Drive carries a consent probe, so the connect step can show missing consent before any call', () => {
  const descriptor = CONNECTOR_DESCRIPTORS['google'];
  assert.ok(descriptor?.identity, 'the google descriptor probes at connect');
  const policy = {
    schemaVersion: 1, ownerId: 'owner', connectionId: 'drive', generation: 1, enabled: true, connector: 'google',
    endpoint: driveEndpoint(), toolNames: ['drive_search_files', 'drive_get_file'], sourcePolicy: { unknownClass: 'private' },
  } as unknown as ConnectionPolicy;
  const source = descriptor.identity(policy);
  assert.ok(source, 'the drive family has a consent probe');
  assert.equal(source.tool, 'drive_search_files', 'the cheapest real read the helper offers');
  assert.equal(source.strict, true, 'no consent is a refusal, not a silent unverified read');
});

function consentEvidence(text: string): ConnectorResult {
  return {
    state: 'tool-error', tool: 'drive_search_files',
    decodedResult: { content: [{ type: 'text', text }], isError: true },
    source: { endpointId: 'drive', transport: 'stdio', bindingDigest: 'f'.repeat(64), schemaDigest: 'e'.repeat(64), toolName: 'drive_search_files', generation: 1, account: 'local', resource: 'google-drive' },
  } as unknown as ConnectorEvidence;
}

test('L-02: the Drive consent probe reports needs-consent with the helper code, and consent when the read answers', async () => {
  const descriptor = CONNECTOR_DESCRIPTORS['google']!;
  const policy = {
    schemaVersion: 1, ownerId: 'owner', connectionId: 'drive', generation: 1, enabled: true, connector: 'google',
    endpoint: driveEndpoint(), toolNames: ['drive_search_files', 'drive_get_file'], sourcePolicy: { unknownClass: 'private' },
  } as unknown as ConnectionPolicy;
  const source = descriptor.identity!(policy)!;
  const missing: IdentityProof = await proveIdentity({ source, expected: [], call: async () => consentEvidence('scope_missing: Drive needs its own read consent') });
  assert.equal(missing.proven, false);
  assert.equal(missing.code, 'scope_missing', 'the closed reason reaches the status row');
  const granted: IdentityProof = await proveIdentity({ source, expected: [], call: async () => consentEvidence('drive: no files matched') });
  assert.equal(granted.proven, true, 'a consented read proves consent even though Drive reports no own-account identity');
  assert.equal(classifyIdentity(consentEvidence('scope_missing: no consent'), source, []).code, 'scope_missing');
});

test('L-08: a classified failure writes one closed host event, ids and a code and nothing else', () => {
  const event = classifiedFailureEvent({ endpointId: 'drive', connector: 'google', tool: 'drive_search_files', code: 'scope_missing' });
  assert.deepEqual(event, { event: 'tool_classified_failure', endpointId: 'drive', connector: 'google', tool: 'drive_search_files', code: 'scope_missing' });
  assert.equal(Object.hasOwn(event, 'args'), false, 'no arguments ride along');
  assert.equal(Object.hasOwn(event, 'text'), false, 'no helper text rides along');
  assert.equal(classifiedFailureEvent({ endpointId: 'drive', connector: 'google', tool: 'drive_search_files', code: 'not a token' }), undefined, 'a code that is not a closed token is refused');
});

/**
 * L-08, the emitting surface: a real owner dispatch through a real stdio child that refuses with
 * scope_missing must reach an attached host log sink as one closed event, and the host log's own
 * validator must keep it. Deleting the emit at server/tools/index.ts turns this red.
 */
test('L-08: one classified connector failure reaches the host log sink and the host log admits it', async () => {
  noteGmailAccount(undefined);
  const home = mkdtempSync(join(tmpdir(), 'didi-loud-errors-'));
  const child = join(here, 'fixtures', 'google-mcp-child.mjs');
  const args = [child, 'code:scope_missing', join(home, 'child.pid')];
  const store = new Store(join(home, 'data'), toolsMigrations);
  const registry = new McpRegistry();
  const env = { HOME: join(home, 'home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' };
  // The synthetic child answers every tool call with one published helper code; scope_missing is the
  // Drive family's own consent refusal. No account, network or credential file is touched.
  registry.register({ id: 'gmail', transport: 'stdio', command: process.execPath, args, env, account: 'local', resource: 'google-fixture' } as unknown as EndpointConfig);
  registry.enable('gmail'); registry.allowEgress('gmail');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore(), budgets: { timeoutMs: 4000 } });
  const seen: unknown[] = [];
  const detach = attachHostLogSink({ event: raw => { seen.push(raw); } });
  try {
    const discovery = await adapter.discover('gmail');
    assert.equal(discovery.state, 'discovered');
    if (discovery.state !== 'discovered') throw new Error('not discovered');
    const names = [...GOOGLE_TOOLS];
    let live: LiveAuthority | null = null;
    const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port: adapter, lookupAuthority: async () => live });
    const policy: ConnectionPolicy = {
      schemaVersion: 1, ownerId: store.assistantId, connectionId: 'gmail', generation: 1, enabled: true, connector: 'google',
      endpoint: { id: 'gmail', transport: 'stdio', command: process.execPath, args, env, account: 'local', resource: 'google-fixture', credentialRef: null },
      toolNames: names, schemaDigest: discovery.schemaDigest,
      sourcePolicy: { id: 'google-read', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
      route: { identity: 'voice', allowedClasses: ['private'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
    };
    owner.applyConnection(policy);
    // Applying a changed policy suspends the endpoint's approval, exactly as the host does; a fresh
    // discovery of the same catalog restores the digest the applied policy names.
    const again = await adapter.discover('gmail');
    assert.equal(again.state, 'discovered');
    registry.approve({ endpointId: 'gmail', schemaDigest: policy.schemaDigest, generation: 1, account: 'local', resource: 'google-fixture', toolNames: names, effect: 'read' });
    const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: 'actor', runId: 'run', authorityEpoch: store.authorityEpoch, revision: 1, route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['private'] }, allowedClasses: ['private'], connectionIds: ['gmail'] };
    const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
    live = { ...acceptance, acceptedRunHash: accepted.sha256 };
    const callArgs = {};
    const intent: ToolCallIntent = { runId: 'run', actorId: 'actor', authorityEpoch: store.authorityEpoch, revision: 1, executionId: 'run:1:0', toolName: 'gmail_search_messages', argumentsHash: sha256(JSON.stringify(callArgs)), callId: 'call', accountId: 'local', resourceId: 'google-fixture' };
    assert.equal(owner.journal.intent(intent), 'fresh');
    const definition = owner.definitions('run').find(candidate => candidate.name === 'gmail_search_messages');
    assert.ok(definition?.execute);
    const outcome = await definition.execute!(callArgs, { ...intent, signal: new AbortController().signal });
    assert.equal(outcome.status, 'completed', 'a classified failure is still a completed call (its text is the reason)');
    const rows = seen.filter(raw => typeof raw === 'object' && raw !== null && (raw as { event?: unknown }).event === 'tool_classified_failure');
    assert.equal(rows.length, 1, 'exactly one classified-failure row reaches the host log');
    assert.deepEqual(rows[0], { event: 'tool_classified_failure', endpointId: 'gmail', connector: 'google', tool: 'gmail_search_messages', code: 'scope_missing' });
    assert.deepEqual(safeEvent(rows[0]), rows[0], 'the host log admits the row and keeps every field');
    assert.equal(safeEvent({ ...(rows[0] as Record<string, unknown>), args: { q: 'synthetic' } }), undefined, 'the host log refuses a row carrying arguments');
  } finally {
    detach();
    await adapter.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
