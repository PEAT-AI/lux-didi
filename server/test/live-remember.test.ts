import { randomUUID } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { liveProfileIdentity } from '../live/config.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceLimits, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { chatMigrations } from '../chat/index.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { createLiveSessionOwner, rememberOwnerNote, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { CANARY, fixture, options } from './live-voice-fixture.js';

const MODEL = 'models/live-session-test';
const NOW = 1_700_000_000_000;
const context = (store: Store): LiveContext => ({ clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch });

function profileInput(limits?: Record<string, number>, model = MODEL) {
  return {
    provider: 'gemini', liveModelId: model, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: model, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    ...(limits ? { limits } : {}),
  };
}

interface Harness {
  requests: LiveVoiceRequest[];
  f: Awaited<ReturnType<typeof fixture>>;
  store: Store;
  owner: LiveSessionOwner;
  ctx: LiveContext;
  dir: string;
  calls: { name: string; args: unknown }[];
  remoteRememberGranted(): boolean;
  advance(ms: number): void;
}

async function harness(t: TestContext, overrides: {
  limits?: Record<string, number>;
  adapterLimits?: Partial<LiveVoiceLimits>;
  credentials?: { resolve(reference: string): Promise<string | undefined> };
  model?: string;
  tools?: boolean;
  remoteRemember?: boolean;
  grantMode?: 'explicit' | 'owner-trusted-reads';
  beforeTool?: () => Promise<void>;
  toolError?: boolean;
  system?: string;
  overlay?: { schemaVersion: 1; text: string; accent?: string };
  memoryFailure?: boolean;
} = {}): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-session-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations, ...(overrides.tools ? toolsMigrations : [])]);
  let clock = NOW;
  const profile = validateLiveProfile({ ...profileInput(overrides.limits, overrides.model), ...(overrides.overlay ? { overlay: overrides.overlay } : {}), ...(overrides.system !== undefined ? { prompt: { text: overrides.system, dataClass: 'ordinary' } } : {}) });
  const voice = new GeminiLiveVoiceAdapter(options({
    socketFactory: f.socketFactory, modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: overrides.credentials ?? { resolve: async () => CANARY },
    limits: { handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50, ...overrides.adapterLimits },
  }));
  const calls: { name: string; args: unknown }[] = [];
  const requests: LiveVoiceRequest[] = [];
  const open = voice.open.bind(voice);
  t.mock.method(voice, 'open', (input: LiveVoiceRequest, ctl: Parameters<typeof voice.open>[1]) => {
    requests.push(structuredClone(input)); return open(input, ctl);
  });
  let owner!: LiveSessionOwner;
  let tools: import('../live/types.js').LiveToolsComposition | undefined;
  let remoteRememberGranted = () => false;
  if (overrides.tools) {
    const schemas: { name: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }[] = [
      { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } },
      { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
    ];
    if (overrides.remoteRemember) schemas.push({ name: 'remember_note', inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string' } }, required: ['text', 'kind'], additionalProperties: false } });
    const registry = new McpRegistry();
    remoteRememberGranted = () => registry.currentGrant('lux')?.toolNames.includes('remember_note') ?? false;
    const endpoint = { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'account', resource: 'resource' };
    registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
    const sdk = new Server({ name: 'live-tools-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(schemas) }) as never);
    sdk.setRequestHandler('tools/call', async req => {
      calls.push({ name: req.params.name, args: req.params.arguments });
      await overrides.beforeTool?.();
      return { content: [{ type: 'text', text: '#123: Synthetic insight\n[Evidence](https://example.test/evidence)' }], ...(overrides.toolError ? { isError: true } : {}) };
    });
    await sdk.connect(transport);
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      return transport.handleRequest(request);
    });
    const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: 12000, projectionChars: 10, timeoutMs: 1000 } });
    const toolOwner = createToolsOwner({ ...{ grantMode: overrides.grantMode ?? 'owner-trusted-reads' }, store, ownerId: store.assistantId, registry, port, lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? owner?.lookupJobAuthority(runId) ?? null });
    toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
      endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(schemas),
      sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
      route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
    assert.equal((await port.discover(endpoint.id)).state, 'discovered');
    toolOwner.projectConnection('lux');
    tools = { owner: toolOwner, connectionIds: () => ['lux'] };
    t.after(async () => { await port.close(); await transport.close(); await sdk.close(); });
  }
  const memorySource = (tx: import('../contracts/storage.js').Transaction) => {
    if (overrides.memoryFailure) throw new Error('synthetic memory failure');
    const ids = tx.all('SELECT id FROM entries ORDER BY id').map(row => String(row['id']));
    return ids.flatMap(id => memory.resolveEntries(tx, [id])).map(record => {
      const entry = labels.current(tx, { kind: 'entry', id: record.entryId }).dataClass;
      const parent = labels.current(tx, { kind: 'session', id: record.sessionId }).dataClass;
      const dataClass = entry === 'unknown' || parent === 'unknown' ? 'unknown' as const
        : entry === 'sensitive' || parent === 'sensitive' ? 'sensitive' as const
        : entry === 'private' || parent === 'private' ? 'private' as const : 'ordinary' as const;
      return { id: record.entryId, text: record.text, dataClass };
    });
  };
  owner = createLiveSessionOwner({ store, voice, profile, ...{ memorySource }, ...(tools ? { tools } : {}), now: () => clock });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { requests, calls, remoteRememberGranted, f, store, owner, ctx: context(store), dir, advance: ms => { clock += ms; } };
}

async function attached(h: Harness, key = 'k1') {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  assert.equal(h.owner.current().state, 'idle', 'accepted without an attachment is not listening');
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  return { session, attachment };
}


function rows(h: Harness) { return h.store.transaction(tx => tx.all('SELECT * FROM entries')); }
function frozen(h: Harness, id: string) {
  return h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,prompt_identity FROM live_sessions WHERE live_session_id=?', [id]));
}
async function remember(h: Harness, text: string | undefined, args: Record<string, unknown>, frame: number) {
  if (text !== undefined) h.f.send({ serverContent: { inputTranscription: { text, finished: true } } });
  h.f.send({ toolCall: { functionCalls: [{ id: `remember-${frame}`, name: 'remember_note', args }] } });
  await h.f.frame(frame);
  const response = h.f.frames[frame - 1] as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
  assert.equal(response.toolResponse.functionResponses.length, 1);
  return response.toolResponse.functionResponses[0]!.response;
}

test('Live remember writes owner words once, freezes the current prompt and recalls at next CREATE', async t => {
  const h = await harness(t, { tools: true });
  const { session, attachment } = await attached(h);
  assert.ok(h.requests[0]?.tools?.some(tool => tool.name === 'remember_note'), 'Live request declares the built-in');
  const before = frozen(h, session.liveSessionId);
  const sentences = [
    ['Naya, remember that the Mongoose mint is due Friday', 'the Mongoose mint is due Friday', 'task'],
    ['remember: I prefer short answers in the morning', 'I prefer short answers in the morning', 'preference'],
  ] as const;
  for (let i = 0; i < sentences.length; i++) {
    const [utterance, payload, kind] = sentences[i]!;
    const result = await remember(h, utterance, { text: payload, kind }, i + 2);
    assert.equal(result.remembered, true);
    assert.equal(typeof result.entryId, 'string');
    assert.deepEqual(Object.keys(result).sort(), ['entryId', 'remembered']);
    const entry = rows(h)[i]!;
    assert.equal(entry.text, payload);
    const provenance = h.store.transaction(tx => tx.get("SELECT * FROM source_references WHERE owner_kind='entry' AND owner_id=?", [String(entry.id)]));
    assert.equal(provenance?.provider, 'live-voice');
    assert.equal(provenance?.note, `kind:${kind}`);
    assert.equal(provenance?.account_id, session.liveSessionId);
    assert.equal(h.store.transaction(tx => labels.current(tx, { kind: 'entry', id: String(entry.id) }).dataClass), 'ordinary');
    assert.deepEqual(frozen(h, session.liveSessionId), before);
  }
  const duplicate = await remember(h, undefined, { text: sentences[1][1], kind: 'preference' }, 4);
  assert.equal(duplicate.remembered, false);
  assert.equal(duplicate.code, 'already_remembered');
  assert.equal(duplicate.entryId, String(rows(h)[1]!.id));
  assert.equal(rows(h).length, 2);
  await attachment.close();
  const next = h.owner.create({ idempotencyKey: 'next-memory', inputClass: 'ordinary' }, h.ctx);
  const snapshot = String(frozen(h, next.liveSessionId)?.accepted_prompt_snapshot);
  for (const [, payload] of sentences) assert.ok(snapshot.includes(payload));
});

test('Live remember provenance refusals do not write memory', async t => {
  for (const [utterance, text, code] of [
    [undefined, 'model invention', 'owner_transcript_not_final'],
    ['What is on my calendar?', 'model invention', 'owner_transcript_not_final'],
    ['remember that mint is Friday', 'mint is Monday', 'owner_text_mismatch'],
    ['remember this as private: mint is Friday', 'mint is Friday', 'private_memory_unsupported'],
    ['remember privately mint is Friday', 'mint is Friday', 'private_memory_unsupported'],
    ['remember this as sensitive: mint is Friday', 'mint is Friday', 'private_memory_unsupported'],
    ['remember: this is private', 'this is private', 'private_memory_unsupported'],
    ['remember that this is private', 'this is private', 'private_memory_unsupported'],
    ['remember that this is sensitive', 'this is sensitive', 'private_memory_unsupported'],
  ] as const) {
    await t.test(code, async st => {
      const h = await harness(st, { tools: true });
      await attached(h);
      const result = await remember(h, utterance, { text, kind: 'fact' }, 2);
      assert.deepEqual(result, { remembered: false, code });
      assert.equal(rows(h).length, 0);
    });
  }
});

test('Live remember retains schema limits and explicit mode denies the write', async t => {
  for (const explicit of [false, true]) await t.test(String(explicit), async st => {
    const h = await harness(st, { tools: true, grantMode: explicit ? 'explicit' : 'owner-trusted-reads' });
    await attached(h);
    const result = await remember(h, 'remember that mint is Friday', { text: explicit ? 'mint is Friday' : 'x'.repeat(501), kind: 'fact' }, 2);
    assert.notEqual(result.remembered, true);
    assert.equal(rows(h).length, 0);
  });
});


test('Live remember reserves the gateway identity when MCP exposes the same name', async t => {
  const h = await harness(t, { tools: true, remoteRemember: true });
  await attached(h);
  assert.equal(h.remoteRememberGranted(), false, 'MCP name receives no part of built-in approval');
  assert.equal(h.requests[0]?.tools?.filter(tool => tool.name === 'remember_note').length, 1);
  const result = await remember(h, 'remember mint is Friday', { text: 'mint is Friday', kind: 'fact' }, 2);
  assert.equal(result.remembered, true);
  assert.equal(h.calls.length, 0, 'gateway does not execute the remote endpoint');
});

test('Live remember normalizes commands and pointers but stores the entire owner payload', async t => {
  const h = await harness(t, { tools: true });
  await attached(h);
  const result = await remember(h, 'NAYA REMEMBER That Mint is Friday, after lunch.', { text: '  MINT  IS FRIDAY ', kind: 'fact' }, 2);
  assert.equal(result.remembered, true);
  assert.equal(rows(h)[0]?.text, 'Mint is Friday, after lunch.');
});

test('Live remember waits for finalized owner turns and assembles transcript fragments', async t => {
  const h = await harness(t, { tools: true });
  await attached(h);
  h.f.send({ serverContent: { inputTranscription: { text: 'remember that mint ', finished: false } } });
  assert.deepEqual(await remember(h, undefined, { text: 'mint is Friday', kind: 'fact' }, 2), { remembered: false, code: 'owner_transcript_not_final' });
  h.f.send({ serverContent: { inputTranscription: { text: 'is Friday', finished: true } } });
  assert.equal((await remember(h, undefined, { text: 'mint is Friday', kind: 'fact' }, 3)).remembered, true);
  assert.equal(rows(h)[0]?.text, 'mint is Friday');
});


test('Live memory port writes ordinary owner payload with the real domain transaction', async t => {
  const h = await harness(t, { tools: true });
  const { session } = await attached(h);
  // A refused pointer still finalizes and journals the owner turn before this direct port check.
  assert.deepEqual(await remember(h, 'remember that mint is Friday', { text: 'Monday', kind: 'task' }, 2), { remembered: false, code: 'owner_text_mismatch' });
  const result = h.store.transaction(tx => rememberOwnerNote(tx, session.liveSessionId, { text: 'mint is Friday', kind: 'task' }, NOW));
  assert.equal(result.remembered, true);
  assert.equal(rows(h)[0]?.text, 'mint is Friday');
});

test('deleted remember_note entry is absent from the next Live CREATE', async t => {
  const h = await harness(t, { tools: true });
  const { attachment } = await attached(h);
  const payload = 'synthetic forgotten apricot reminder';
  const result = await remember(h, `remember: ${payload}`, { text: payload, kind: 'task' }, 2);
  assert.equal(result.remembered, true);
  const id = String(result.entryId);
  const domain = createDomainPort({ outbox: Outbox });
  h.store.transaction(tx => domain.execute(tx, 'deleteEntry', { id }, { assistantId: h.store.assistantId, clientId: h.ctx.clientId, authorityEpoch: h.store.authorityEpoch, now: new Date(NOW).toISOString() }));
  await attachment.close();
  const next = h.owner.create({ idempotencyKey: 'after-deletion', inputClass: 'ordinary' }, h.ctx);
  assert.equal(String(frozen(h, next.liveSessionId)?.accepted_prompt_snapshot).includes(payload), false);
  assert.equal(rows(h).some(row => row.id === id), false);
});

test('a later remember_note cannot recreate a deleted note from the retained voice turn', async t => {
  const h = await harness(t, { tools: true });
  await attached(h);
  const payload = 'synthetic discarded plum task';
  const result = await remember(h, `remember: ${payload}`, { text: payload, kind: 'task' }, 2);
  assert.equal(result.remembered, true);
  const domain = createDomainPort({ outbox: Outbox });
  h.store.transaction(tx => domain.execute(tx, 'deleteEntry', { id: String(result.entryId) }, { assistantId: h.store.assistantId, clientId: h.ctx.clientId, authorityEpoch: h.store.authorityEpoch, now: new Date(NOW).toISOString() }));
  await remember(h, undefined, { text: payload, kind: 'task' }, 3);
  assert.equal(rows(h).some(row => row.text === payload), false, 'retained voice turn must not resurrect deleted memory');
});
