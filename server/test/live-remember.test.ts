import { ready as openAiReady } from './openai-live-voice-fixture.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { randomUUID } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { FRESH_OPENING } from '../adapters/live-voice/openai.js';
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
  trace: unknown[];
  saved: import('../tools/vault-write.js').VaultSaveArgs[];
  remoteRememberGranted(): boolean;
  advance(ms: number): void;
}

async function harness(t: TestContext, overrides: {
  scheduler?: RememberClock;
  limits?: Record<string, number>;
  adapterLimits?: Partial<LiveVoiceLimits>;
  credentials?: { resolve(reference: string): Promise<string | undefined> };
  model?: string;
  tools?: boolean;
  remoteRemember?: boolean;
  grantMode?: 'explicit' | 'owner-trusted-reads';
  /** W7: a board service for the Trello gateway tools. */
  trello?: import('../tools/trello.js').TrelloBoard;
  beforeTool?: () => Promise<void>;
  toolError?: boolean;
  system?: string;
  overlay?: { schemaVersion: 1; text: string; accent?: string };
  memoryFailure?: boolean;
  vaultUnavailable?: boolean;
  composedNotes?: boolean;
  crashAfterInsert?: boolean;
} = {}): Promise<Harness> {
  const trace: unknown[] = [];
  const detach = attachHostLogSink({ event: raw => { if (raw && typeof raw === 'object' && ['live_trace_rejected', 'lux_note_readback', 'lux_note_stage'].includes(String((raw as { event?: unknown }).event))) trace.push(raw); } });
  t.after(detach);
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-session-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations, ...(overrides.tools ? toolsMigrations : [])]);
  let clock = NOW;
  const profile = validateLiveProfile({ ...profileInput(overrides.limits, overrides.model), ...(overrides.composedNotes === undefined ? {} : { features: { composedNotes: overrides.composedNotes } }), ...(overrides.overlay ? { overlay: overrides.overlay } : {}), ...(overrides.system !== undefined ? { prompt: { text: overrides.system, dataClass: 'ordinary' } } : {}) });
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
    const toolOwner = createToolsOwner({ ...{ grantMode: overrides.grantMode ?? 'owner-trusted-reads' }, ...(overrides.trello ? { trello: overrides.trello } : {}), store, ownerId: store.assistantId, registry, port, lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? owner?.lookupJobAuthority(runId) ?? null });
    toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
      endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(schemas),
      sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
      route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
      bounds: { maxQueryChars: 512, maxSearchLimit: 20, maxGetIds: 20, maxEntityBytes: 4096, maxResultBytes: 4096 } });
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
  const saved: import('../tools/vault-write.js').VaultSaveArgs[] = [];
  const vaultTransport: import('../adapters/lux-write/client.js').LuxWriteTransport = {
    nearDuplicate: async () => undefined,
    save: async args => { saved.push(args); if (overrides.crashAfterInsert) throw Error('synthetic crash after insert'); return overrides.vaultUnavailable ? { outcome: 'unavailable' } : { outcome: 'inserted', insightId: 'synthetic-81' }; },
  };
  owner = createLiveSessionOwner({ store, voice, profile, vaultTransport, ...{ memorySource }, ...(tools ? { tools } : {}), now: () => overrides.scheduler?.now ?? clock, ...(overrides.scheduler ? { schedule: overrides.scheduler.schedule } : {}) });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { requests, calls, saved, trace, remoteRememberGranted, f, store, owner, ctx: context(store), dir, advance: ms => { clock += ms; } };
}

async function attached(h: Harness, key = 'k1') {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  assert.equal(h.owner.current().state, 'idle', 'accepted without an attachment is not listening');
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  await h.f.frame(2);
  assert.deepEqual(h.f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: FRESH_OPENING }] }], turnComplete: true } });
  h.f.frames.splice(1, 1);
  return { session, attachment };
}


class RememberClock {
  now = NOW;
  pending = new Set<{ at: number; callback: () => void }>();
  schedule = (callback: () => void, ms: number) => {
    const item = { at: this.now + ms, callback };
    this.pending.add(item);
    return { unref() {}, cancel: () => { this.pending.delete(item); } };
  };
  advance(ms: number) {
    this.now += ms;
    for (const item of [...this.pending]) if (item.at <= this.now) {
      this.pending.delete(item); item.callback();
    }
  }
}
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'fixture reached the observable boundary');
}

// C-LUXSAVE11 replaces the retired live local-memory-write workflow. Local memory unit coverage
// remains in live-memory-note.test.ts; this file exercises the real host and Gemini wire.
async function ownerBlock(h: Harness, text: string, finished = true): Promise<void> {
  const before = Number(h.store.transaction(tx => tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE kind='inputTranscription'"))?.['id'] ?? 0);
  h.f.send({ serverContent: { inputTranscription: { text, finished } } });
  await until(() => Number(h.store.transaction(tx => tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE kind='inputTranscription'"))?.['id'] ?? 0) > before);
}
async function assistantBlock(h: Harness, text: string): Promise<void> {
  const before = Number(h.store.transaction(tx => tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE kind='turnComplete'"))?.['id'] ?? 0);
  h.f.send({ serverContent: { outputTranscription: { text, finished: true }, turnComplete: true } });
  await until(() => Number(h.store.transaction(tx => tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE kind='turnComplete'"))?.['id'] ?? 0) > before);
}
async function call(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = `synthetic-call-${h.f.frames.length}-${name}`;
  h.f.send({ toolCall: { functionCalls: [{ id, name, args }] } });
  const result = () => h.f.frames.flatMap(frame => {
    const responses = (frame as { toolResponse?: { functionResponses?: { id: string; response: Record<string, unknown> }[] } }).toolResponse?.functionResponses ?? [];
    return responses.filter(response => response.id === id);
  });
  await until(() => result().length === 1);
  return result()[0]!.response;
}
test('C-LUXSAVE11 host: legacy live calls are absent and fail closed even with valid owner words', async t => {
  const h = await harness(t, { tools: true });
  const { attachment } = await attached(h);
  await ownerBlock(h, 'save this to lux and remember this synthetic note');
  for (const [name, args] of [['remember_note', { text: 'Synthetic note', kind: 'note' }], ['save_to_vault', { content: 'Synthetic note' }]] as const) {
    const result = await call(h, name, args);
    assert.equal(result['code'], 'tool_retired');
  }
  assert.equal(h.saved.length, 0);
  assert.equal(h.store.transaction(tx => tx.all('SELECT * FROM entries')).length, 0);
  attachment.close();
});

for (const kind of ['task', 'fact', 'preference'] as const) {
for (const composedNotes of [undefined, false]) {
test(`C-LUXSAVE11 F1: legacy ${kind} remains readable without teardown export (composedNotes=${composedNotes ?? 'default'})`, async t => {
  const h = await harness(t, { tools: true, ...(composedNotes === undefined ? {} : { composedNotes }) });
  const { session, attachment } = await attached(h);
  await ownerBlock(h, 'remember that the synthetic launch is Friday');
  const seeded = h.store.transaction(tx => rememberOwnerNote(tx, session.liveSessionId, { text: 'the synthetic launch is Friday', kind }, NOW));
  assert.equal(seeded['remembered'], true, 'seed a pre-existing local memory through its existing domain boundary');
  attachment.close();
  await until(() => h.owner.lookupAuthority(session.liveSessionId) === null);
  const next = h.owner.create({ idempotencyKey: 'recall-next', inputClass: 'ordinary' }, h.ctx);
  assert.ok(next.liveSessionId);
  await drain();
  assert.equal(h.saved.length, 0, 'legacy recall does not authorize a vault insert on teardown');
  assert.equal(h.store.transaction(tx => tx.all('SELECT * FROM lux_note_stages').length), 0, 'no confirmed candidate exists');
  const snapshot = JSON.stringify(h.owner.get(next.liveSessionId));
  assert.ok(snapshot.includes('liveSessionId'));
  const nextAttachment = h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  // Source recall is assembled before the transport handshake; no second real server is started.
  await drain();
  assert.ok(JSON.stringify(h.requests).includes('the synthetic launch is Friday'));
  nextAttachment.close();
  await until(() => h.owner.lookupAuthority(next.liveSessionId!) === null);
  await drain();
  assert.equal(h.store.transaction(tx => tx.all("SELECT journal_id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription'", [next.liveSessionId!]).length), 0, 'the recall session had no owner request at all');
  assert.equal(h.saved.length, 0, 'closing a request-free recall session never exports the legacy note');
});
}
}


const candidate = { title: 'Synthetic plan', body: 'The team chose the blue plan. The budget is twelve units.', evidenceRefs: [] };

for (const outcome of ['saved', 'unavailable', 'unknown'] as const) {
  test(`direct102 real host: direct Lux save commits without yes, outcome ${outcome}`, async t => {
    const h = await harness(t, { tools: true, vaultUnavailable: outcome === 'unavailable', crashAfterInsert: outcome === 'unknown' });
    const { attachment } = await attached(h);
    await ownerBlock(h, 'save a summary of this into Lux');
    await assistantBlock(h, 'On it.');
    const result = await call(h, 'stage_lux_note', candidate);
    assert.equal(h.saved.length, 1, 'the real transport was called before any yes or readback');
    assert.equal(result['saved'], outcome === 'saved', JSON.stringify(result));
    if (outcome === 'saved') {
      assert.equal(result['insightId'], 'synthetic-81');
      assert.match(String(result['say']), /Saved: Synthetic plan.*synthetic-81/);
      assert.match(h.saved[0]!.content, /Provenance: request request-\d+; source counts/);
      const retry = await call(h, 'stage_lux_note', candidate);
      assert.equal(retry['insightId'], 'synthetic-81');
      assert.equal(h.saved.length, 1, 'same candidate is idempotent');
      const second = await call(h, 'stage_lux_note', { ...candidate, title: 'Different note' });
      assert.equal(second['code'], 'grant_spent');
    } else {
      assert.equal(result['insightId'], undefined);
      assert.doesNotMatch(String(result['say']), /Saved:/);
    }
    await drain(); attachment.close();
  });
}

for (const words of ['he said save this into Lux', 'if I say save this into Lux', 'what is in my calendar?']) {
  test(`direct102 real host: non-save request cannot authorize a note: ${words}`, async t => {
    const h = await harness(t, { tools: true });
    const { attachment } = await attached(h);
    await ownerBlock(h, words);
    const result = await call(h, 'stage_lux_note', candidate);
    assert.equal(result['code'], 'no_owner_request');
    assert.equal(h.saved.length, 0);
    attachment.close();
  });
}

for (const length of [4000, 4001]) {
  test(`direct102 real host: note body boundary ${length}`, async t => {
    const h = await harness(t, { tools: true });
    const { attachment } = await attached(h);
    await ownerBlock(h, 'save this into Lux');
    const result = await call(h, 'stage_lux_note', { title: 'Synthetic', body: 'x'.repeat(length) });
    assert.equal(result['saved'], length === 4000, JSON.stringify(result));
    assert.equal(h.saved.length, length === 4000 ? 1 : 0);
    attachment.close();
  });
}

for (const order of ['read_then_save', 'save_then_read'] as const) {
  test(`direct102 real host: source provenance follows this request: ${order}`, async t => {
    const h = await harness(t, { tools: true });
    const { attachment } = await attached(h);
    await ownerBlock(h, order === 'save_then_read' ? 'save this into Lux' : 'find the synthetic record');
    await call(h, 'research', { action: 'start', question: 'What does Lux knowledge say about the synthetic plan?', lookups: [{ source: 'knowledge', query: 'synthetic plan' }] });
    assert.ok(h.calls.some(call => call.name === 'search_knowledge'));
    if (order === 'read_then_save') await ownerBlock(h, 'save this into Lux');
    const result = await call(h, 'stage_lux_note', candidate);
    assert.equal(result['saved'], true, JSON.stringify(result));
    assert.match(h.saved[0]!.content, order === 'save_then_read' ? /source counts \{"knowledge":1\}/ : /source counts \{\}/);
    attachment.close();
  });
}
