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
function playback(attachment: Awaited<ReturnType<typeof attached>>['attachment'], receipt: string, seq: number, now: number, segment = 1): void {
  attachment.playbackReceipt(JSON.stringify({ type: 'playback_receipt', receipt, segment_seq: segment,
    source_instance_id: 'synthetic-playback', source_seq: seq, mono_ms: 900 + seq, wall_ms: now }));
}
const candidate = { title: 'Synthetic plan', body: `The team chose the blue plan. Supporting detail.

The budget is twelve units. Final detail.`, evidenceRefs: [] };
async function stagedHost(t: TestContext, unavailable = false, crashAfterInsert = false) {
  const clock = new RememberClock();
  const h = await harness(t, { tools: true, scheduler: clock, vaultUnavailable: unavailable, crashAfterInsert });
  const attachedSession = await attached(h);
  for (const [owner, assistant] of [['Compare the plans', 'The blue plan fits.'], ['Explain the cost', 'It costs twelve units.'], ['What is the conclusion', 'The blue plan is the recommendation.']]) {
    await ownerBlock(h, owner!); await assistantBlock(h, assistant!);
  }
  await ownerBlock(h, 'save all');
  await ownerBlock(h, 'of this in great detail');
  const result = await call(h, 'stage_lux_note', candidate);
  assert.equal(result['staged'], true, JSON.stringify(result));
  return { h, clock, ...attachedSession, result };
}

for (const confirmation of ['yes', 'split', 'split_no', 'wrong_readback', 'unarmed', 'early', 'unavailable', 'read_all', 'crash'] as const) {
  test(`C-LUXSAVE11 host: delayed synthesis, tool-output readback and ${confirmation}`, async t => {
    const { h, clock, attachment, session, result } = await stagedHost(t, confirmation === 'unavailable', confirmation === 'crash');
    assert.equal(h.requests[0]!.tools?.some(tool => tool.name === 'remember_note' || tool.name === 'save_to_vault'), false);
    assert.equal(h.requests[0]!.tools?.some(tool => tool.name === 'stage_lux_note'), true);
    const readback = String(result['readBack']);
    assert.ok(readback.includes('The budget is twelve units.'));
    assert.ok(String(result['instruction']).includes('verbatim'));
    const frames = h.f.frames as Record<string, unknown>[];
    assert.ok(frames.some(frame => (frame['toolResponse'] as { functionResponses?: { response: Record<string, unknown> }[] } | undefined)?.functionResponses?.some(entry => entry.response['readBack'] === readback)), 'host readback reaches the model inside the tool output');
    assert.equal(frames.some(frame => JSON.stringify(frame['clientContent'] ?? {}).includes('The budget is twelve units.')), false, 'readback never rides a user frame');
    if (confirmation === 'yes') {
      // Feed this actual host-produced result through the other provider's real wire adapter.
      const declaration = h.requests[0]!.tools!.find(tool => tool.name === 'stage_lux_note')!;
      const other = await openAiReady(t, {}, { tools: [declaration] });
      other.f.send({ type: 'session.delegation.created', delegation: { id: 'synthetic-delegation', response_id: 'synthetic-response', offset_ms: 0 } });
      other.f.send({ type: 'response.event', delegation_id: 'synthetic-item', event: { type: 'response.created', response: { id: 'synthetic-call-response' } } });
      other.f.send({ type: 'response.event', delegation_id: 'synthetic-item', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'synthetic-stage', name: 'stage_lux_note', arguments: JSON.stringify(candidate) } } });
      other.f.send({ type: 'response.event', delegation_id: 'synthetic-item', event: { type: 'response.done', response: { id: 'synthetic-call-response' } } });
      await until(() => other.captured.events.some(event => event.type === 'toolCall'));
      other.session.sendToolResponse({ responses: [{ id: 'synthetic-stage', name: 'stage_lux_note', response: result as import('../adapters/model/types.js').JsonObject }] });
      await until(() => other.f.frames.some(frame => (frame['item'] as { type?: string } | undefined)?.type === 'function_call_output'));
      const output = other.f.frames.find(frame => (frame['item'] as { type?: string } | undefined)?.type === 'function_call_output')!;
      const item = output['item'] as { output: string; call_id: string };
      assert.equal(item.call_id, 'synthetic-stage');
      assert.equal(JSON.parse(item.output).readBack, readback);
      assert.ok(JSON.parse(item.output).instruction.includes('verbatim'));
      assert.equal(other.f.frames.some(frame => {
        const message = frame['item'] as { role?: string; content?: { text?: string }[] } | undefined;
        return message?.role === 'user' && message.content?.some(part => part.text?.includes('The budget is twelve units.'));
      }), false, 'OpenAI readback is never a user item');
    }

    h.advance(100); clock.advance(100);
    if (confirmation === 'early') await ownerBlock(h, 'yes', false);
    if (confirmation !== 'unarmed') {
      await assistantBlock(h, confirmation === 'wrong_readback' ? 'Would you like to discuss a different question?' : readback);
      playback(attachment, 'received', 1, NOW + 100);
      playback(attachment, 'started', 2, NOW + 100);
      h.advance(100); clock.advance(100);
      playback(attachment, 'drained', 3, NOW + 200);
      if (['yes', 'split', 'unavailable', 'read_all', 'crash'].includes(confirmation)) {
        const armed = h.store.transaction(tx => tx.get('SELECT state,code,staged_at FROM lux_note_stages WHERE live_session_id=?', [session.liveSessionId]));
        const seen = h.store.transaction(tx => tx.all("SELECT kind,text FROM live_journal WHERE live_session_id=? AND kind IN ('outputTranscription','turnComplete') ORDER BY journal_id", [session.liveSessionId]));
        assert.equal(armed?.['state'], 'armed', JSON.stringify({ armed, seen, trace: h.trace }));
      }
    }
    if (confirmation === 'read_all') {
      await ownerBlock(h, 'read it all');
      await assistantBlock(h, `${candidate.title}\n${candidate.body}`);
      h.advance(100); clock.advance(100);
      playback(attachment, 'received', 4, NOW + 300, 2);
      playback(attachment, 'started', 5, NOW + 300, 2);
      playback(attachment, 'drained', 6, NOW + 300, 2);
    }
    await ownerBlock(h, confirmation === 'early' ? '' : 'yes');
    if (confirmation === 'split' || confirmation === 'split_no') {
      await ownerBlock(h, 'save it');
      if (confirmation === 'split_no') await ownerBlock(h, 'no');
    }
    h.advance(2_000); clock.advance(2_000); await drain();
    const expected = ['yes', 'split', 'unavailable', 'read_all', 'crash'].includes(confirmation) ? 1 : 0;
    const state = h.store.transaction(tx => tx.all('SELECT state,code,armed_at,confirmation_text,settle_at FROM lux_note_stages WHERE live_session_id=?', [session.liveSessionId]));
    assert.equal(h.saved.length, expected, JSON.stringify({ saved: h.saved, state }));
    if (expected) assert.equal(h.saved[0]!.content, candidate.body);
    const rows = h.store.transaction(tx => tx.all('SELECT * FROM lux_note_stages WHERE live_session_id=?', [session.liveSessionId]));
    assert.equal(rows.length, 1);
    if (confirmation === 'wrong_readback') assert.equal(rows[0]!['code'], 'readback_mismatch');
    if (confirmation === 'early') assert.equal(rows[0]!['code'], 'speech_before_readback_end');
    assert.equal(h.store.transaction(tx => tx.all('SELECT * FROM entries')).length, 0, 'no local memory fallback');
    if (expected) await until(() => JSON.stringify(h.f.frames).includes(confirmation === 'unavailable' ? 'vault_unavailable' : confirmation === 'crash' ? 'outcome_unknown' : 'synthetic-81'));
    const spokenInstructions = JSON.stringify(h.f.frames);
    if (confirmation === 'unavailable') {
      assert.ok(spokenInstructions.includes('vault_unavailable'));
      assert.ok(!spokenInstructions.includes('Saved \\"Synthetic plan'));
    } else if (confirmation === 'crash') {
      assert.ok(spokenInstructions.includes('outcome_unknown'));
      await ownerBlock(h, 'yes'); h.advance(2_000); clock.advance(2_000); await drain();
      assert.equal(h.saved.length, 1, 'a retry after an uncertain commit cannot dispatch a second insert');
    } else if (expected) {
      assert.ok(spokenInstructions.includes('synthetic-81'));
      assert.ok(spokenInstructions.includes('Synthetic plan'));
    }
    attachment.close();
  });
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

test('C-LUXSAVE11 host: existing local memories remain readable after retiring the write tool', async t => {
  const h = await harness(t, { tools: true });
  const { session, attachment } = await attached(h);
  await ownerBlock(h, 'remember that the synthetic launch is Friday');
  const seeded = h.store.transaction(tx => rememberOwnerNote(tx, session.liveSessionId, { text: 'the synthetic launch is Friday', kind: 'task' }, NOW));
  assert.equal(seeded['remembered'], true, 'seed a pre-existing local memory through its existing domain boundary');
  attachment.close();
  await until(() => h.owner.lookupAuthority(session.liveSessionId) === null);
  const next = h.owner.create({ idempotencyKey: 'recall-next', inputClass: 'ordinary' }, h.ctx);
  assert.ok(next.liveSessionId);
  assert.equal(h.saved.length, 0);
  const snapshot = JSON.stringify(h.owner.get(next.liveSessionId));
  assert.ok(snapshot.includes('liveSessionId'));
  const nextAttachment = h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  // Source recall is assembled before the transport handshake; no second real server is started.
  await drain();
  assert.ok(JSON.stringify(h.requests).includes('the synthetic launch is Friday'));
  nextAttachment.close();
});

for (const order of ['read_then_save', 'read_then_save_tool', 'save_then_read'] as const) {
  test(`C-LUXSAVE11 host: ${order} controls authority while external results always taint`, async t => {
    const clock = new RememberClock();
    const h = await harness(t, { tools: true, scheduler: clock });
    const { session, attachment } = await attached(h);
    await ownerBlock(h, order === 'save_then_read' ? 'save all of this' : 'find the synthetic record');
    const heldToolRef = `tool:synthetic-call-${h.f.frames.length}-research`;
    const external = await call(h, 'research', { action: 'start', question: 'What does Lux knowledge say about the synthetic plan?', topic: 'synthetic plan', sources: 'knowledge', lookups: [{ source: 'knowledge', query: 'synthetic plan' }] });
    assert.ok(external);
    assert.ok(h.calls.some(call => call.name === 'search_knowledge'), `the external read actually executes: ${JSON.stringify(external)}`);
    if (order !== 'save_then_read') { await assistantBlock(h, 'The synthetic record has twelve budget units.'); await ownerBlock(h, 'save all of this'); }
    const journal = h.store.transaction(tx => tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription'", [session.liveSessionId]));
    const result = await call(h, 'stage_lux_note', { ...candidate, evidenceRefs: order === 'read_then_save_tool' ? [heldToolRef] : [`journal:${journal!['id']}`] });
    if (order === 'save_then_read') assert.equal(result['code'], 'authorization_missing');
    else {
      assert.equal(result['staged'], true, JSON.stringify(result));
      assert.ok(String(result['readBack']).includes('Provenance: this note includes content from mail, web or chat read in that session.'));
      assert.ok(String(result['body']).endsWith('Provenance: this note includes content from mail, web or chat read in that session.'));
      const row = h.store.transaction(tx => tx.get('SELECT external_context_present FROM lux_note_stages WHERE live_session_id=?', [session.liveSessionId]));
      assert.equal(row?.['external_context_present'], 1, 'owner-only citations cannot clear host taint');
      await assistantBlock(h, String(result['readBack']));
      playback(attachment, 'received', 1, NOW);
      playback(attachment, 'started', 2, NOW);
      playback(attachment, 'drained', 3, NOW);
      await ownerBlock(h, 'yes');
      h.advance(2_000); clock.advance(2_000);
      await until(() => h.saved.length === 1);
      assert.equal(h.saved[0]!.content, result['body']);
      const receipt = h.store.transaction(tx => tx.get('SELECT external_context_present,candidate_digest FROM vault_writes WHERE live_session_id=?', [session.liveSessionId]));
      const digest = h.store.transaction(tx => tx.get('SELECT payload_sha256 FROM lux_note_stages WHERE live_session_id=?', [session.liveSessionId]));
      assert.equal(receipt?.['external_context_present'], 1);
      assert.equal(receipt?.['candidate_digest'], digest?.['payload_sha256']);

    }
    assert.equal(h.saved.length, order !== 'save_then_read' ? 1 : 0);
    attachment.close();
  });
}

for (const shape of ['optional_evidence', 'body_limit', 'too_long'] as const) {
  test(`C-LUXSAVE11 host: candidate boundary ${shape}`, async t => {
    const h = await harness(t, { tools: true });
    const { attachment } = await attached(h);
    await ownerBlock(h, 'save all of this');
    const args = shape === 'optional_evidence' ? { title: 'Synthetic', body: 'Synthetic body.' }
      : { title: 'Synthetic', body: 'x'.repeat(shape === 'body_limit' ? 4_000 : 4_001), evidenceRefs: [] };
    const result = await call(h, 'stage_lux_note', args);
    if (shape === 'too_long') {
      assert.equal(result['staged'], false, JSON.stringify(result));
      assert.equal(result['code'], 'too_long');
      assert.ok(String(result['guidance']).includes('split'));
    } else assert.equal(result['staged'], true, JSON.stringify(result));
    assert.equal(h.saved.length, 0, 'staging is not a write');
    attachment.close();
  });
}
