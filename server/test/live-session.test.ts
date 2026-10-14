import { createHash, randomUUID } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { resolveLiveMemory } from '../host/live.js';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { declarationsFor, runToolCalls } from '../tools/declarations.js';
import { LiveToolJobs, type ToolJobResult, type JobTimer } from '../tools/jobs.js';
import type { LiveAuthority } from '../tools/types.js';
import { liveProfileIdentity } from '../live/config.js';
import type { ToolDefinition, HostContext } from '../adapters/model/types.js';
import { PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT } from '../prompt/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLiveConfig } from '../config/live.js';
import { NAYA_BASE, NAYA_TOOLS, composeLiveInstruction, composeLiveSessionInstruction } from '../prompt/live-persona.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceLimits, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import type { Transaction } from '../contracts/storage.js';
import { createLiveSessionOwner, LiveConfigError, LiveError, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import { CANARY, control, deferred, fixture, options, pcm } from './live-voice-fixture.js';

const MODEL = 'models/live-session-test';
const NOW = 1_700_000_000_000;
const context = (store: Store): LiveContext => ({ clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } });

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
  readonly memorySelections: number;
  advance(ms: number): void;
}

async function harness(t: TestContext, overrides: {
  limits?: Record<string, number>;
  adapterLimits?: Partial<LiveVoiceLimits>;
  credentials?: { resolve(reference: string): Promise<string | undefined> };
  model?: string;
  tools?: boolean;
  beforeTool?: () => Promise<void>;
  beforeGate?: () => Promise<void>;
  toolError?: boolean;
  scheduler?: DeadlineClock;
  system?: string;
  acceptedPrompt?: (ownerId: string) => NonNullable<ReturnType<typeof validateLiveProfile>['acceptedPrompt']>;
  routeClasses?: readonly ('ordinary' | 'private' | 'sensitive')[];
  overlay?: { schemaVersion: 1; text: string; accent?: string };
  memoryFailure?: boolean;
} = {}): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-session-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations, ...(overrides.tools ? toolsMigrations : [])]);
  let clock = NOW;
  let memorySelections = 0;
  const initialProfile = profileInput({ handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50, ...Object.fromEntries(Object.entries(overrides.adapterLimits ?? {}).filter(([key]) => ['handshakeMs', 'idleMs', 'sessionMs', 'closeMs'].includes(key))), ...overrides.limits }, overrides.model);
  const profile = validateLiveProfile({ ...initialProfile,
    ...(overrides.routeClasses ? { route: { ...initialProfile.route, dataClasses: overrides.routeClasses } } : {}),
    ...(overrides.overlay ? { overlay: overrides.overlay } : {}), ...(overrides.system !== undefined ? { prompt: { text: overrides.system, dataClass: 'ordinary' } } : {}),
    ...(overrides.acceptedPrompt ? { acceptedPrompt: overrides.acceptedPrompt(store.assistantId) } : {}) });
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
    if (input.resumptionHandle) {
      assert.equal(store.transaction(tx => tx.get("SELECT resumption_handle FROM live_sessions WHERE lifecycle='active'"))?.resumption_handle === input.resumptionHandle, true, 'handle is durable before open');
      assert.ok(ctl.limits!.handshakeMs! <= profile.limits.handshakeMs, 'profile handshake override reaches resumed setup');
    }
    requests.push(structuredClone(input)); return open(input, ctl);
  });
  let owner!: LiveSessionOwner;
  let tools: import('../live/types.js').LiveToolsComposition | undefined;
  if (overrides.tools) {
    const schemas = [
      { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } },
      { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
    ];
    const registry = new McpRegistry();
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
    const toolOwner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? owner?.lookupJobAuthority(runId) ?? null });
    if (overrides.beforeGate) {
      const authorize = toolOwner.resultGate.authorize.bind(toolOwner.resultGate);
      t.mock.method(toolOwner.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => { await overrides.beforeGate!(); return authorize(...args); });
    }
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
    memorySelections += 1;
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
  owner = createLiveSessionOwner({ store, voice, profile, ...{ memorySource }, ...(tools ? { tools } : {}), now: () => overrides.scheduler?.now ?? clock, ...(overrides.scheduler ? { schedule: overrides.scheduler.schedule } : {}) });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { requests, calls, get memorySelections() { return memorySelections; }, f, store, owner, ctx: context(store), dir, advance: ms => { if (overrides.scheduler) overrides.scheduler.now += ms; else clock += ms; } };
}

async function attached(h: Harness, key = 'k1') {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  assert.equal(h.owner.current().state, 'idle', 'accepted without an attachment is not listening');
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  await h.f.frame(2);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: 'Greet the person briefly to begin the conversation.' } });
  h.f.frames.splice(1, 1);
  return { session, attachment };
}

test('fresh owner Start selects model-first with no fabricated history', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'fresh-opening', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  assert.equal(h.requests[0]!.opening, 'model_first');
  assert.deepEqual(h.requests[0]!.history, []);
  h.f.send({ setupComplete: {} });
  await Promise.all([attachment.ready, h.f.frame(2)]);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: 'Greet the person briefly to begin the conversation.' } });
  const persisted = JSON.stringify(h.store.transaction(tx => tx.all('SELECT kind,text FROM live_journal WHERE live_session_id=?', [session.liveSessionId])));
  assert.equal(persisted.includes('Greet the person'), false, 'the server-owned directive is not user transcription or history');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

function accepted(h: Harness, id: string): { system: string; memory: { status: string; selectedIds: string[]; omitted: { id: string; reason: string }[] }; pickup?: { jobId: string; identity: string } } {
  return h.store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [id])!['accepted_prompt_snapshot'])));
}

function assertFrozenInstruction(h: Harness, id: string, request: number) {
  const snapshot = accepted(h, id);
  assert.equal(h.requests[request]!.system.text, snapshot.system);
  const digest = createHash('sha256').update(JSON.stringify({ text: snapshot.system, dataClass: 'ordinary' })).digest('hex');
  assert.equal(h.owner.get(id).promptIdentity, digest);
}

function note(h: Harness, id: string, text: string, entryClass = 'ordinary', parentClass = 'ordinary') {
  h.store.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', [`parent-${id}`, 'Fixture', NOW, 'UTC', NOW, NOW]);
    tx.run('INSERT INTO entries VALUES (?,?,1,?,?,?, ?,1)', [id, `parent-${id}`, 'user', text, NOW, 'UTC']);
    for (const [kind, subject, dataClass] of [['entry', id, entryClass], ['session', `parent-${id}`, parentClass]]) {
      tx.run('INSERT INTO routing_labels VALUES (?,?,1,?,?,?)', [kind!, subject!, dataClass!, 'owner_review', NOW]);
    }
  });
}

test('Live memory is frozen at CREATE, fresh at the next CREATE, and covered by the fingerprint', async t => {
  const h = await harness(t);
  note(h, 'note-a', 'Fixture old owner note');
  const first = h.owner.create({ idempotencyKey: 'memory-old', inputClass: 'ordinary' }, h.ctx);
  h.store.transaction(tx => tx.run('UPDATE entries SET text=?, revision=2 WHERE id=?', ['Fixture revised owner note', 'note-a']));
  assert.equal(h.owner.create({ idempotencyKey: 'memory-old', inputClass: 'ordinary' }, h.ctx).liveSessionId, first.liveSessionId, 'same-key replay never re-resolves memory');
  const attachment = h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx);
  await h.f.frame(1); h.f.send({ setupComplete: {} }); await attachment.ready;
  assertFrozenInstruction(h, first.liveSessionId, 0);
  assert.match(h.requests[0]!.system.text, /Fixture old owner note/);
  assert.ok(!h.requests[0]!.system.text.includes('Fixture revised owner note'));
  h.owner.revoke(first.liveSessionId); await attachment.done;
  const fresh = h.owner.create({ idempotencyKey: 'memory-new', inputClass: 'ordinary' }, h.ctx);
  assert.match(accepted(h, fresh.liveSessionId).system, /Fixture revised owner note/);
  assert.notEqual(fresh.promptIdentity, first.promptIdentity);
  assert.equal(h.store.transaction(tx => tx.get('SELECT fingerprint FROM live_sessions WHERE live_session_id=?', [first.liveSessionId])!['fingerprint']), createHash('sha256').update(JSON.stringify({ inputClass: 'ordinary', profile: first.profileIdentity, prompt: first.promptIdentity, pickupJobId: null })).digest('hex'));
});

test('Live memory recalls ordinary entries only, including parent labels, and reports an empty selection', async t => {
  const h = await harness(t);
  const empty = h.owner.create({ idempotencyKey: 'empty-memory', inputClass: 'ordinary' }, h.ctx);
  assert.equal(accepted(h, empty.liveSessionId).memory.status, 'empty');
  note(h, 'ordinary', 'Fixture ordinary note');
  note(h, 'private', 'Fixture private canary', 'private');
  note(h, 'sensitive', 'Fixture sensitive canary', 'sensitive');
  note(h, 'private-parent', 'Fixture parent private canary', 'ordinary', 'private');
  const session = h.owner.create({ idempotencyKey: 'class-memory', inputClass: 'ordinary' }, h.ctx);
  const snapshot = accepted(h, session.liveSessionId);
  assert.match(snapshot.system, /Fixture ordinary note/);
  for (const forbidden of ['Fixture private canary', 'Fixture sensitive canary', 'Fixture parent private canary']) assert.ok(!snapshot.system.includes(forbidden));
  assert.deepEqual(snapshot.memory.selectedIds, ['ordinary']);
  assert.deepEqual(h.store.transaction(resolveLiveMemory).map(record => record.id), ['ordinary']);
  assert.deepEqual(h.owner.profileProjection().memory, { status: 'selected', selected: 1, omitted: 0 });
  assert.deepEqual(h.owner.current().memory, { status: 'selected', selected: 1, omitted: 0 });
});

test('Live memory budget keeps whole records, reports overflow, and rejects oversized static instructions and resolution failure', async t => {
  const h = await harness(t);
  note(h, 'a', 'Fixture whole note');
  const initial = h.owner.create({ idempotencyKey: 'measure-memory', inputClass: 'ordinary' }, h.ctx);
  const remaining = TRUSTED_SYSTEM_CODE_UNIT_LIMIT - accepted(h, initial.liveSessionId).system.length;
  h.store.transaction(tx => tx.run('UPDATE entries SET text=? WHERE id=?', ['Fixture whole note' + 'x'.repeat(remaining), 'a']));
  note(h, 'b', 'Fixture overflow note');
  const boundary = h.owner.create({ idempotencyKey: 'boundary-memory', inputClass: 'ordinary' }, h.ctx);
  const snapshot = accepted(h, boundary.liveSessionId);
  assert.equal(snapshot.system.length, TRUSTED_SYSTEM_CODE_UNIT_LIMIT);
  assert.deepEqual(snapshot.memory.selectedIds, ['a']);
  assert.deepEqual(snapshot.memory.omitted, [{ id: 'b', reason: 'budget' }]);
  assert.ok(!snapshot.system.includes('Fixture overflow note'));
  assert.ok(snapshot.system.includes(JSON.stringify({ id: 'a', text: 'Fixture whole note' + 'x'.repeat(remaining) })), 'the selected record survives byte for byte');
  const failed = await harness(t, { memoryFailure: true });
  assert.throws(() => failed.owner.create({ idempotencyKey: 'failed-memory', inputClass: 'ordinary' }, failed.ctx), (error: unknown) => error instanceof LiveError && String(error.code) === 'memory_unavailable');
  assert.equal(failed.requests.length, 0);
});

test('Live transcripts and completion, interruption and terminal events stay journal-only', async t => {
  const h = await harness(t);
  note(h, 'existing', 'Fixture existing note');
  const { session, attachment } = await attached(h, 'journal-only');
  const before = h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n']));
  h.f.send({ serverContent: { inputTranscription: { text: 'Fixture voice input', finished: true }, outputTranscription: { text: 'Fixture voice output', finished: true }, turnComplete: true } });
  await drain(h, session.liveSessionId, 4);
  h.f.send({ serverContent: { interrupted: true } });
  await drain(h, session.liveSessionId, 5);
  h.owner.revoke(session.liveSessionId); await attachment.done;
  const kinds = h.store.transaction(tx => tx.all('SELECT kind FROM live_journal WHERE live_session_id=?', [session.liveSessionId]).map(row => row['kind']));
  for (const kind of ['inputTranscription', 'outputTranscription', 'turnComplete', 'interrupted', 'terminal']) assert.ok(kinds.includes(kind));
  assert.equal(h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n'])), before);
});

test('a session with a tool declaration carries the tools conduct; without one composes exactly as before', async t => {
  const withTools = await harness(t, { tools: true });
  const { session: withSession, attachment: withAttachment } = await attached(withTools);
  assertFrozenInstruction(withTools, withSession.liveSessionId, 0);
  assert.equal(withTools.requests.length, 1);
  assert.ok(withTools.requests[0]!.system.text.includes(NAYA_TOOLS),
    'the authored tools conduct is in the attached system instruction');
  withAttachment.close(); await withAttachment.done;

  const withoutTools = await harness(t, {});
  const { attachment: withoutAttachment } = await attached(withoutTools);
  assert.equal(withoutTools.requests.length, 1);
  assert.equal(withoutTools.requests[0]!.system.text, 'Synthetic system', 'no declarations compose exactly as before');
  assert.ok(!withoutTools.requests[0]!.system.text.includes('# Tools'));
  withoutAttachment.close(); await withoutAttachment.done;
});

async function drain(h: Harness, liveSessionId: string, expected: number): Promise<LiveSessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = h.owner.get(liveSessionId);
    if (snapshot.journal.events >= expected) return snapshot;
    if (Date.now() > deadline) throw new Error(`journal did not reach ${expected} events`);
    await tick();
  }
}

async function waitTerminal(h: Harness, liveSessionId: string): Promise<LiveSessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = h.owner.get(liveSessionId);
    if (snapshot.terminal !== null) return snapshot;
    if (Date.now() > deadline) throw new Error('session never terminated');
    await tick();
  }
}

test('many-turn journal preserves provider order, late input, and an interrupted turn without generationComplete', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  // Ordered output consumer: committed markers must not accumulate and trip unified backpressure.
  void (async () => { for await (const chunk of attachment.output) { void chunk; } })();
  const turns = 140;
  for (let i = 0; i < turns; i++) {
    h.f.send({ serverContent: { outputTranscription: { text: `out-${i}`, finished: true }, generationComplete: true, turnComplete: true } });
    h.f.send({ serverContent: { inputTranscription: { text: `in-${i}` } } });
    await drain(h, session.liveSessionId, 1 + (i + 1) * 4);
  }
  h.f.send({ serverContent: { outputTranscription: { text: 'cut off' } } });
  h.f.send({ serverContent: { interrupted: true, turnComplete: true } });
  h.f.send({ serverContent: { inputTranscription: { text: 'late final input', finished: true } } });
  const live = await drain(h, session.liveSessionId, 1 + turns * 4 + 4);
  assert.equal(live.lifecycle, 'active');
  assert.equal(live.ready, true, 'the durable ready fact survives later journal writes');
  assert.ok(live.journal.events > 128, 'the adapter 128-event queue is not a lifetime journal cap');
  assert.equal(h.f.attempts, 1);

  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.equal(page.fragments[0]?.kind, 'ready');
  assert.deepEqual(page.fragments.slice(1, 5).map(fragment => fragment.kind), ['outputTranscription', 'generationComplete', 'turnComplete', 'inputTranscription']);
  assert.equal(page.fragments[1]?.text, 'out-0');
  assert.equal(page.fragments[4]?.text, 'in-0');
  assert.equal(page.fragments[4]?.finished, null);
  const tail = h.owner.listFragments({ liveSessionId: session.liveSessionId, cursor: 2 + turns * 4 });
  assert.deepEqual(tail.fragments.map(fragment => fragment.kind), ['outputTranscription', 'interrupted', 'turnComplete', 'inputTranscription']);
  assert.equal(tail.fragments[3]?.text, 'late final input');
  assert.equal(tail.fragments[3]?.finished, true);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).interruptions, 1);
  const keys = ['arrivedAt', 'finished', 'journalSequence', 'kind', 'liveSessionId', 'providerSequence', 'rejectedKind', 'rejectedSequence', 'text', 'value'].sort();
  for (const fragment of page.fragments) assert.deepEqual(Object.keys(fragment).sort(), keys);
  attachment.close();
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'closed', code: 'closed' });
  assert.equal(terminal.journal.complete, true);
});

test('excluded transport facts and raw secrets never persist; Domain and CHAT stay untouched', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio(), { text: 'unspoken thought', thought: true }] }, outputTranscription: { text: 'Spoken text' }, turnComplete: true } });
  await drain(h, session.liveSessionId, 3);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: CANARY } });
  await tick();
  h.f.send({ serverContent: { inputTranscription: { text: 'synced' } } });
  await drain(h, session.liveSessionId, 4);
  attachment.close();
  await attachment.done;

  const journal = h.store.transaction(tx => tx.all('SELECT * FROM live_journal'));
  const dump = JSON.stringify(journal);
  assert.equal(dump.includes(CANARY), false, 'resolved credential and resumption handle never persist');
  assert.equal(dump.includes('unspoken thought'), false, 'modelText and thoughts are not transcripts');
  assert.equal(dump.includes(Buffer.from(pcm).toString('base64')), false, 'no PCM bytes persist');
  assert.equal(journal.some(row => String(row['kind']) === 'modelText' || String(row['kind']) === 'audio'), false);
  assert.ok(journal.some(row => String(row['text']) === 'Spoken text'));
  const tables = h.store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => String(row['name'])));
  for (const table of ['live_sessions', 'live_grants', 'live_journal', 'sessions', 'entries', 'chat_runs', 'chat_consents']) assert.ok(tables.includes(table), table);
  const writes = h.store.transaction(tx => ({
    sessions: Number(tx.get('SELECT COUNT(*) AS n FROM sessions')!['n']),
    entries: Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n']),
    chatRuns: Number(tx.get('SELECT COUNT(*) AS n FROM chat_runs')!['n']),
    chatConsents: Number(tx.get('SELECT COUNT(*) AS n FROM chat_consents')!['n']),
  }));
  assert.deepEqual(writes, { sessions: 0, entries: 0, chatRuns: 0, chatConsents: 0 });
});

test('audio is rejected before ready and PCM never reaches the store', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'ready-order', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  assert.throws(() => attachment.sendAudio({ pcm }), (error: unknown) => error instanceof LiveError && error.code === 'not_ready');
  assert.throws(() => attachment.endAudioStream(), (error: unknown) => error instanceof LiveError && error.code === 'not_ready');
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await Promise.all([attachment.ready, h.f.frame(2)]);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: 'Greet the person briefly to begin the conversation.' } });
  attachment.sendAudio({ pcm });
  await h.f.frame(3);
  assert.deepEqual(h.f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });
  attachment.endAudioStream();
  await h.f.frame(4);
  assert.deepEqual(h.f.frames[3], { realtimeInput: { audioStreamEnd: true } });
  attachment.close();
  await attachment.done;
});

test('single attach, idempotent create replay, conflict, and a terminal session that never reopens', async t => {
  const h = await harness(t);
  const first = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  const replay = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  assert.equal(replay.liveSessionId, first.liveSessionId);
  assert.equal(h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM live_sessions')!['n'])), 1);
  assert.throws(() => h.owner.create({ idempotencyKey: 'dup', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'idempotency_conflict');
  assert.throws(() => h.owner.create({ idempotencyKey: 'class', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalid_request');

  const attachment = h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx);
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'already_attached');
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  attachment.close();
  const terminal = await attachment.done;
  assert.equal(terminal.lifecycle, 'terminal');

  const after = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  assert.equal(after.lifecycle, 'terminal');
  assert.equal(after.dispatchIntent, true);
  assert.deepEqual(after.terminal, { state: 'closed', code: 'closed' });
  assert.equal(h.f.attempts, 1, 'replaying a terminal create never dispatches');
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'terminal');
});

test('an unused accepted session expires without ever opening the adapter', async t => {
  const h = await harness(t, { limits: { unusedMs: 1000 } });
  const session = h.owner.create({ idempotencyKey: 'unused', inputClass: 'ordinary' }, h.ctx);
  assert.equal(session.lifecycle, 'accepted');
  h.advance(2000);
  assert.throws(() => h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'expired');
  const after = h.owner.get(session.liveSessionId);
  assert.equal(after.lifecycle, 'terminal');
  assert.deepEqual(after.terminal, { state: 'expired' });
  assert.equal(after.journal.complete, false);
  assert.equal(h.f.attempts, 0);
});

test('durable tool jobs defer without replay and retain completed or failed outcomes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-jobs-'));
  const migrations = createDomainPort({ outbox: Outbox }).migrations;
  let store = new Store(dir, migrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const host: HostContext = { runId: 'origin', actorId: 'client', authorityEpoch: store.authorityEpoch, revision: 1, grants: [] };
  // The execution owner validates this snapshot; the receipt owner stores it without granting authority.
  const authority = { runId: 'origin' } as LiveAuthority;
  let expire = () => {};
  const schedule: JobTimer = callback => { expire = callback; return { unref() {}, cancel() {} }; };
  const batch: ToolJobResult = { tools: [], bindings: [], responses: [], error: undefined, accepted: [] };
  let finish!: (value: ToolJobResult) => void;
  let executions = 0;
  let jobs = new LiveToolJobs(store, () => NOW);
  const waiting = jobs.run(host, authority, 4000, schedule, () => { executions++; return new Promise(resolve => { finish = resolve; }); });
  expire();
  const deferred = await waiting;
  assert.equal(deferred.result, undefined);
  assert.equal(jobs.pending()[0]!.state, 'in_progress');
  finish(batch);
  await tick();
  assert.equal(jobs.pending()[0]!.state, 'completed');
  assert.deepEqual(jobs.pending()[0]!.result, JSON.parse(JSON.stringify(batch)));
  const failed = await jobs.run(host, authority, 4000, schedule, async () => { throw new Error('synthetic failure'); });
  assert.equal(failed.job.state, 'failed');
  const interrupted = jobs.run(host, authority, 4000, schedule, () => { executions++; return new Promise(() => {}); });
  expire();
  await interrupted;
  store.close();
  store = new Store(dir, migrations);
  jobs = new LiveToolJobs(store, () => NOW);
  assert.equal(jobs.pending().filter(job => job.state === 'unknown').length, 1);
  assert.equal(jobs.pending().filter(job => job.state === 'completed').length, 1);
  assert.equal(executions, 2, 'reopening never replays a dispatched tool');
});

test('expired job leases become unknown without replay or accepting late completion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-job-lease-'));
  const store = new Store(dir, createDomainPort({ outbox: Outbox }).migrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = NOW, expire = () => {}, executions = 0;
  const jobs = new LiveToolJobs(store, () => clock);
  const host: HostContext = { runId: 'origin', actorId: 'client', authorityEpoch: store.authorityEpoch, revision: 1, grants: [] };
  let finish!: (result: ToolJobResult) => void;
  const waiting = jobs.run(host, { runId: 'origin' } as LiveAuthority, 4000,
    callback => { expire = callback; return { unref() {}, cancel() {} }; },
    () => { executions++; return new Promise(resolve => { finish = resolve; }); });
  expire(); await waiting;
  clock += 86_400_000;
  assert.equal(jobs.pending()[0]!.state, 'unknown');
  finish({ tools: [], bindings: [], responses: [], error: undefined, accepted: [] });
  await tick();
  assert.equal(jobs.pending()[0]!.state, 'unknown');
  assert.equal(jobs.pending()[0]!.result, undefined);
  assert.equal(executions, 1);
});

test('tool deferral budget defaults to four seconds and accepts only bounded integer milliseconds', () => {
  assert.equal((validateLiveProfile(profileInput()).limits as unknown as Record<string, number>).toolDeferralMs, 4000);
  for (const value of [1000, 4000, 30000]) {
    assert.equal((validateLiveProfile(profileInput({ toolDeferralMs: value })).limits as unknown as Record<string, number>).toolDeferralMs, value);
  }
  for (const value of [0, 999, 30001, 1000.5, NaN, Infinity]) {
    assert.throws(() => validateLiveProfile(profileInput({ toolDeferralMs: value })), LiveConfigError);
  }
});

test('profile validation rejects text-model fallback and bounds, and validation precedes credentials', async t => {
  const cases: unknown[] = [
    { ...profileInput(), provider: 'openai' },
    { ...profileInput(), liveModelId: 'gemini-2.0-flash' },
    { ...profileInput(), route: { enabled: false, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] } },
    { ...profileInput(), route: { enabled: true, provider: 'gemini', modelId: 'models/other', dataClasses: ['ordinary'] } },
    { ...profileInput(), route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: [] } },
    { ...profileInput(), prompt: { text: 'x', dataClass: 'private' } },
    { ...profileInput(), limits: { journalMaxEvents: 0 } },
    { ...profileInput(), limits: { journalMaxBytes: 2 ** 40 } },
  ];
  for (const value of cases) assert.throws(() => validateLiveProfile(value), (error: unknown) => error instanceof LiveConfigError);
  const input = profileInput();
  const profile = validateLiveProfile(input);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.route) && Object.isFrozen(profile.route.dataClasses) && Object.isFrozen(profile.limits));
  (input.route.dataClasses as unknown as string[]).push('private');
  assert.deepEqual(profile.route.dataClasses, ['ordinary']);

  let resolves = 0;
  const h = await harness(t, { credentials: { resolve: async () => { resolves += 1; return CANARY; } } });
  const session = h.owner.create({ idempotencyKey: 'validated', inputClass: 'ordinary' }, h.ctx);
  assert.throws(() => h.owner.attach({ liveSessionId: session.liveSessionId }, { ...h.ctx, authorityEpoch: 'stale' }), (error: unknown) => error instanceof LiveError && error.code === 'stale_authority');
  assert.equal(resolves, 0);
  assert.equal(h.f.attempts, 0);
  assert.throws(() => h.owner.create({ idempotencyKey: 'class', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalid_request');
});

test('accepted complete system uses the shared 60k bound while generic prompt text stays at 4096', () => {
  const ownerProfile = { schemaVersion: 1 as const, kind: 'default' as const, ownerId: 'assistant-test', displayName: 'Lux Didi' as const };
  const acceptedPrompt = { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION, system: 'A'.repeat(60_000), dataClasses: ['ordinary'] };
  assert.equal(validateLiveProfile({ ...profileInput(), acceptedPrompt }).acceptedPrompt?.system.length, 60_000);
  assert.throws(() => validateLiveProfile({ ...profileInput(), acceptedPrompt: { ...acceptedPrompt, system: 'A'.repeat(60_001) } }), LiveConfigError);
  assert.throws(() => validateLiveProfile({ ...profileInput(), prompt: { text: 'A'.repeat(4097), dataClass: 'ordinary' } }), LiveConfigError);
});

test('tool-enabled Live CREATE freezes an expanded classified owner system byte for byte', async t => {
  const style = `SYNTHETIC style ${'S'.repeat(10_000)}`;
  const lore = `SYNTHETIC lore ${'L'.repeat(13_955)}`;
  let expectedSystem = '';
  const h = await harness(t, { tools: true, routeClasses: ['ordinary', 'private', 'sensitive'], acceptedPrompt: ownerId => {
    const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId, profileVersion: 'fixture', displayName: 'Example',
      style: { text: style, dataClass: 'private' as const }, lore: { text: lore, dataClass: 'sensitive' as const } };
    expectedSystem = composeLiveInstruction({ base: NAYA_BASE, ownerProfile, language: 'en' }).text;
    return { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION,
      system: expectedSystem, dataClasses: ['ordinary', 'private', 'sensitive'] };
  } });
  const created = h.owner.create({ idempotencyKey: 'expanded-owner-tools', inputClass: 'ordinary' }, h.ctx);
  const frozen = h.store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [created.liveSessionId])!['accepted_prompt_snapshot'])));
  assert.ok(frozen.system.length > 20_000);
  assert.equal(frozen.system, composeLiveSessionInstruction({ text: expectedSystem, tools: ['search_knowledge', 'get_insight'], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT }).text);
  assert.equal(frozen.system.split(style).length - 1, 1);
  assert.equal(frozen.system.split(lore).length - 1, 1);
  assert.deepEqual(frozen.dataClasses, ['ordinary', 'private', 'sensitive']);
});

test('tool-enabled Live CREATE rejects a complete system whose required tool conduct exceeds the shared ceiling', async t => {
  const h = await harness(t, { tools: true, acceptedPrompt: ownerId => ({
    schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: 'A'.repeat(TRUSTED_SYSTEM_CODE_UNIT_LIMIT), dataClasses: ['ordinary'],
  }) });
  assert.throws(() => h.owner.create({ idempotencyKey: 'expanded-tools-overflow', inputClass: 'ordinary' }, h.ctx),
    (error: unknown) => error instanceof LiveError && error.code === 'instruction_too_large');
  assert.equal(h.requests.length, 0);
});

test('waitingForInput keeps its boolean and ready stays a durable fact', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: { waitingForInput: true, turnComplete: true } });
  await drain(h, session.liveSessionId, 3);
  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.equal(page.fragments.find(fragment => fragment.kind === 'waitingForInput')?.value, true);
  assert.equal(h.owner.get(session.liveSessionId).ready, true);
  h.f.send({ serverContent: { waitingForInput: false } });
  await drain(h, session.liveSessionId, 4);
  const later = h.owner.listFragments({ liveSessionId: session.liveSessionId, cursor: 4, limit: 10 });
  assert.equal(later.fragments[0]?.value, false);
  attachment.close();
  const terminal = await attachment.done;
  assert.equal(terminal.ready, true);
  assert.equal(terminal.journal.complete, true);
});

test('returned snapshots and fragments are mutation-proof copies', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'frozen', inputClass: 'ordinary' }, h.ctx);
  const first = h.owner.get(session.liveSessionId);
  first.grant.permittedClasses.push('sensitive');
  first.grant.model = 'models/tampered';
  const second = h.owner.get(session.liveSessionId);
  assert.deepEqual(second.grant.permittedClasses, ['ordinary']);
  assert.equal(second.grant.model, MODEL);
  assert.notEqual(first.grant, second.grant);
});

test('revocation aborts the adapter while silent, during model output, and during deferred credentials', async t => {
  const silent = await harness(t);
  const quiet = await attached(silent);
  silent.owner.invalidate('revoked');
  assert.deepEqual((await quiet.attachment.done).terminal, { state: 'revoked' });
  assert.throws(() => quiet.attachment.sendAudio({ pcm }), (error: unknown) => error instanceof LiveError && error.code === 'invalidated');
  await silent.f.closed;
  assert.equal(silent.f.frames.length, 1);

  const output = await harness(t);
  const speaking = await attached(output);
  output.f.send({ serverContent: { outputTranscription: { text: 'ongoing', finished: false } } });
  await drain(output, speaking.session.liveSessionId, 2);
  output.owner.invalidate('authority');
  assert.deepEqual((await speaking.attachment.done).terminal, { state: 'revoked' });
  await output.f.closed;
  assert.equal(output.owner.get(speaking.session.liveSessionId).journal.events, 2);

  const deferred = await harness(t, { credentials: { resolve: () => new Promise<string>(() => {}) } });
  const pending = deferred.owner.create({ idempotencyKey: 'deferred', inputClass: 'ordinary' }, deferred.ctx);
  const attachment = deferred.owner.attach({ liveSessionId: pending.liveSessionId }, deferred.ctx);
  deferred.owner.invalidate('profile');
  assert.deepEqual(deferred.owner.get(pending.liveSessionId).terminal, { state: 'revoked' });
  assert.equal(deferred.f.attempts, 0, 'no socket opens after invalidation during deferred credentials');
  await assert.rejects(attachment.ready);
  assert.equal(deferred.f.frames.length, 0);
});

test('attach after invalidation is refused, and both journal limits terminate durably', async t => {
  const invalidated = await harness(t);
  const accepted = invalidated.owner.create({ idempotencyKey: 'late', inputClass: 'ordinary' }, invalidated.ctx);
  invalidated.owner.invalidate('profile');
  assert.throws(() => invalidated.owner.attach({ liveSessionId: accepted.liveSessionId }, invalidated.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalidated');

  const counted = await harness(t, { limits: { journalMaxEvents: 3 } });
  const countedSession = await attached(counted, 'count');
  counted.f.send({ serverContent: { outputTranscription: { text: 'one' }, generationComplete: true, turnComplete: true } });
  const limit = await waitTerminal(counted, countedSession.session.liveSessionId);
  assert.deepEqual(limit.terminal, { state: 'journal_limit' });
  assert.equal(limit.journal.complete, false);
  assert.equal(limit.journal.events, 3, 'committed fragments are preserved');
  const page = counted.owner.listFragments({ liveSessionId: countedSession.session.liveSessionId, limit: 100 });
  assert.equal(page.counts.total, 4, 'the terminal record is counted so pages reconcile');
  assert.ok(page.counts.returned <= page.counts.total);
  const terminalRow = page.fragments.at(-1)!;
  assert.equal(terminalRow.kind, 'terminal');
  assert.equal(terminalRow.rejectedKind, 'turnComplete');
  assert.equal(terminalRow.text, null, 'the rejected fragment text is never stored');
  assert.ok(terminalRow.rejectedSequence !== null);

  const bytes = await harness(t, { limits: { journalMaxBytes: 10 } });
  const bytesSession = await attached(bytes, 'bytes');
  bytes.f.send({ serverContent: { inputTranscription: { text: 'x'.repeat(64) } } });
  const byteLimit = await waitTerminal(bytes, bytesSession.session.liveSessionId);
  assert.deepEqual(byteLimit.terminal, { state: 'journal_limit' });
  assert.equal(byteLimit.journal.events, 1);
  const bytePage = bytes.owner.listFragments({ liveSessionId: bytesSession.session.liveSessionId });
  assert.equal(bytePage.fragments.at(-1)!.rejectedKind, 'inputTranscription');
});

test('an undrained consumer channel terminates visibly instead of buffering without bound', async t => {
  const h = await harness(t, { limits: { consumerQueueEvents: 2 } });
  const { session, attachment } = await attached(h);
  for (let i = 0; i < 3; i++) h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  const snapshot = await waitTerminal(h, session.liveSessionId);
  assert.deepEqual(snapshot.terminal, { state: 'consumer_backpressure' });
  assert.equal(snapshot.consumerState, 'backpressure');
  await h.f.closed;
  assert.equal(snapshot.journal.events, 1, 'audio is never journaled');
  await attachment.done;
});

test('a bounded cursor traverses every retained fragment without silent truncation', async t => {
  const h = await harness(t);
  const { session } = await attached(h);
  for (let i = 0; i < 12; i++) h.f.send({ serverContent: { inputTranscription: { text: `fragment-${i}` } } });
  await drain(h, session.liveSessionId, 13);
  const seen: number[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 10; page++) {
    const read = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(read.fragments.length <= 3);
    seen.push(...read.fragments.map(fragment => fragment.journalSequence));
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(new Set(seen).size, seen.length);
  const one = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 500 });
  assert.equal(one.counts.total, 13);
  assert.equal(one.nextCursor, null);
  const texts = one.fragments.filter(fragment => fragment.kind === 'inputTranscription').map(fragment => fragment.text);
  assert.deepEqual(texts, Array.from({ length: 12 }, (_value, i) => `fragment-${i}`));
});

test('live migrations preserve a populated accepted Store byte-for-byte', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const domain = createDomainPort({ outbox: Outbox });
  const before = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations.filter(migration => migration.version < 3)]);
  before.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)', ['s1', 'Prior session', 1, null, 'UTC', 1, 1, 1]);
    tx.run('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)', ['e1', 's1', 1, 'user', 'preserved text', 2, 'UTC', 1]);
    tx.run('INSERT INTO chat_consents(session_id,owner_assistant_id,provider,model,route_identity,revision,permitted_classes,granted_at,revoked_at,idempotency_key,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?)', ['s1', before.assistantId, 'gemini', MODEL, 'route', 1, '["ordinary"]', '2026-01-01T00:00:00.000Z', null, 'consent-key', 'fingerprint']);
  });
  const journalColumns = 'journal_id,live_session_id,provider_sequence,kind,text,finished,value,terminal_outcome,rejected_kind,rejected_sequence,payload_bytes,arrived_at';
  before.transaction(tx => {
    tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'terminal',1,1,3,10,1,'ended',?,1,1,1)`,
      ['legacy-live', before.assistantId, before.authorityEpoch, 'legacy-key', 'fingerprint', 'client', 'audit', 'profile', 'prompt', JSON.stringify({ state: 'closed' })]);
    tx.run(`INSERT INTO live_journal(${journalColumns}) VALUES (41,'legacy-live',1,'inputTranscription','hello',1,NULL,NULL,NULL,NULL,5,1)`);
    tx.run(`INSERT INTO live_journal(${journalColumns}) VALUES (42,'legacy-live',2,'outputTranscription','world',0,NULL,NULL,NULL,NULL,5,2)`);
    tx.run(`INSERT INTO live_journal(${journalColumns}) VALUES (43,'legacy-live',NULL,'terminal',NULL,NULL,NULL,?,NULL,NULL,0,3)`, [JSON.stringify({ state: 'closed' })]);
  });
  const prior = before.transaction(tx => ({
    liveSessions: tx.all('SELECT * FROM live_sessions ORDER BY live_session_id'),
    liveJournal: tx.all(`SELECT ${journalColumns} FROM live_journal ORDER BY journal_id`),
    sessions: tx.all('SELECT * FROM sessions ORDER BY id'),
    entries: tx.all('SELECT * FROM entries ORDER BY id'),
    consents: tx.all('SELECT * FROM chat_consents ORDER BY session_id'),
    outbox: tx.all('SELECT * FROM runtime_outbox ORDER BY id'),
  }));
  before.close();

  const migrated = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => migrated.close());
  const current = migrated.transaction(tx => ({
    liveSessions: tx.all('SELECT * FROM live_sessions ORDER BY live_session_id'),
    liveJournal: tx.all(`SELECT ${journalColumns} FROM live_journal ORDER BY journal_id`),
    sessions: tx.all('SELECT * FROM sessions ORDER BY id'),
    entries: tx.all('SELECT * FROM entries ORDER BY id'),
    consents: tx.all('SELECT * FROM chat_consents ORDER BY session_id'),
    outbox: tx.all('SELECT * FROM runtime_outbox ORDER BY id'),
  }));
  assert.ok(current.liveSessions.every(row => row['resumption_handle'] === null && row['connection_generation'] === 0));
  assert.ok(current.liveSessions.every(row => row['memory_provenance'] === null), 'additive v4 provenance is null on legacy rows');
  assert.deepEqual({ ...current, liveSessions: current.liveSessions.map(({ memory_provenance: _newColumn, resumption_handle: _handle, connection_generation: _generation, ...legacy }) => legacy) }, { ...prior, liveSessions: prior.liveSessions.map(row => ({ ...row })) }, 'all pre-existing Live, CHAT and Domain values stay byte-identical');
  assert.deepEqual(migrated.transaction(tx => tx.all('SELECT journal_id,tool_json FROM live_journal ORDER BY journal_id').map(row => ({ ...row }))),
    [41, 42, 43].map(journal_id => ({ journal_id, tool_json: null })));
  migrated.transaction(tx => {
    tx.run(`INSERT INTO live_journal(live_session_id,kind,tool_json,payload_bytes,arrived_at) VALUES ('legacy-live','toolCall','{}',2,4)`);
    tx.run(`INSERT INTO live_journal(live_session_id,kind,tool_json,payload_bytes,arrived_at) VALUES ('legacy-live','toolResult','{}',2,5)`);
    assert.deepEqual(tx.all('SELECT journal_id,kind FROM live_journal WHERE journal_id>43 ORDER BY journal_id').map(row => ({ ...row })),
      [{ journal_id: 44, kind: 'toolCall' }, { journal_id: 45, kind: 'toolResult' }]);
  });
  migrated.transaction(tx => {
    const id = String(current.liveSessions[0]!['live_session_id']);
    tx.run("INSERT INTO live_journal(live_session_id,kind,text,payload_bytes,arrived_at) VALUES (?,'remember_deferred','299',3,?)", [id, NOW]);
    const row = tx.get("SELECT kind,text FROM live_journal WHERE live_session_id=? AND kind='remember_deferred'", [id]);
    assert.deepEqual({ ...row }, { kind: 'remember_deferred', text: '299' });
    assert.throws(() => tx.run("INSERT INTO live_journal(live_session_id,kind,payload_bytes,arrived_at) VALUES (?,'unknown_kind',0,?)", [id, NOW]));
  });
  const owners = migrated.transaction(tx => tx.all('SELECT owner, MAX(version) AS version FROM runtime_migrations GROUP BY owner ORDER BY owner'));
  assert.deepEqual(owners.map(row => [String(row['owner']), Number(row['version'])]),
    [chatMigrations, domainMigrations, liveMigrations].map(migrations => [migrations[0]!.owner, Math.max(...migrations.map(migration => migration.version))]));
});

test('a failed store write aborts visibly and never fabricates a durable outcome', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.store.close();
  h.f.send({ serverContent: { inputTranscription: { text: 'after close' } } });
  await h.f.closed;
  const reopened = new Store(h.dir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
  assert.equal(reopened.transaction(tx => String(tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!['lifecycle'])), 'active');
  assert.equal(reopened.transaction(tx => tx.get('SELECT terminal_outcome FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!['terminal_outcome']), null);
  assert.equal(reopened.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM live_journal WHERE kind='terminal'")!['n'])), 0);
  reopened.close();
  await assert.rejects(attachment.done);
});

test('real SIGKILL before dispatch intent sweeps to not_started and after intent to outcome_unknown', async t => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const address = f.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const domain = createDomainPort({ outbox: Outbox });
  const migrations = [...domain.migrations, ...chatMigrations, ...liveMigrations];
  const profile = validateLiveProfile(profileInput());
  const recoverOwner = (store: Store) => createLiveSessionOwner({
    store, voice: new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })), profile,
  });

  const before = await killChild(f, dir, port, 'accepted', 'before-intent');
  assert.equal(f.connections, 0, 'a session killed before intent never opened the adapter');
  let store = new Store(dir, migrations);
  let owner = recoverOwner(store);
  const swept = owner.get(before.liveSessionId);
  assert.deepEqual(swept.terminal, { state: 'not_started' });
  assert.equal(swept.journal.complete, false);
  assert.ok(owner.listFragments({ liveSessionId: before.liveSessionId }).fragments.some(fragment => fragment.kind === 'terminal'));
  await owner.shutdown();
  store.close();

  const afterIntent = await killChild(f, dir, port, 'intent', 'after-intent');
  assert.equal(f.connections, 1, 'exactly one adapter open before the crash');
  store = new Store(dir, migrations);
  owner = recoverOwner(store);
  const recovered = owner.get(afterIntent.liveSessionId);
  assert.deepEqual(recovered.terminal, { state: 'outcome_unknown' });
  assert.equal(recovered.dispatchIntent, true);
  assert.equal(f.connections, 1, 'recovery never opens a second adapter');
  assert.ok(owner.listFragments({ liveSessionId: afterIntent.liveSessionId }).fragments.length >= 1, 'a recovered session stays locally readable');
  await owner.shutdown();
  store.close();
});

async function killChild(f: Awaited<ReturnType<typeof fixture>>, dir: string, port: number, mode: string, key: string): Promise<{ liveSessionId: string }> {
  const child = fork(new URL('./live-session-process.js', import.meta.url), [mode, dir, String(port), key], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    const created = await nextMessage(child, 'created');
    const liveSessionId = String(created['liveSessionId']);
    if (mode === 'intent') {
      await f.frame(1);
      f.send({ setupComplete: {} });
      await nextMessage(child, 'intent');
    }
    return { liveSessionId };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
}

function nextMessage(child: ReturnType<typeof fork>, phase: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${phase} message`)), 10_000);
    child.on('message', (message: Record<string, unknown>) => { if (message['phase'] === phase) { clearTimeout(timer); resolve(message); } });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`child exited before ${phase}`)); });
  });
}

test('the owner disposes before Store.close and refuses work afterwards', async t => {
  const h = await harness(t);
  const { attachment } = await attached(h);
  await h.owner.shutdown();
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'closed' });
  assert.throws(() => h.owner.get('missing'), (error: unknown) => error instanceof LiveError);
  await h.owner.shutdown();
});

test('accepted unused observations and same-key replay expire without attach, strictly past the boundary', async t => {
  let resolutions = 0;
  const h = await harness(t, { limits: { unusedMs: 20 }, credentials: { resolve: async () => { resolutions++; return CANARY; } } });
  const create = (key: string) => h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  const read = create('unused-read'), replay = create('unused-replay'), fragments = create('unused-fragments');
  h.advance(20);
  assert.equal(h.owner.get(read.liveSessionId).lifecycle, 'accepted');
  assert.equal(create('unused-replay').lifecycle, 'accepted');
  h.advance(1);
  assert.equal(h.owner.get(read.liveSessionId).terminal?.state, 'expired');
  assert.equal(create('unused-replay').terminal?.state, 'expired');
  assert.equal(h.owner.listFragments({ liveSessionId: fragments.liveSessionId }).fragments.length, 1);
  assert.equal(h.owner.get(fragments.liveSessionId).terminal?.state, 'expired');
  assert.throws(() => h.owner.create({ idempotencyKey: 'unused-replay', inputClass: 'private' }, h.ctx), { code: 'idempotency_conflict' });
  for (const row of [read, replay, fragments]) {
    assert.equal(h.owner.get(row.liveSessionId).terminal?.state, 'expired');
    assert.equal(h.owner.listFragments({ liveSessionId: row.liveSessionId }).fragments.length, 1);
    assert.throws(() => h.owner.attach({ liveSessionId: row.liveSessionId }, h.ctx), { code: 'terminal' });
  }
  assert.equal(resolutions, 0);
  assert.equal(h.f.attempts, 0);
});


/** Trusted scheduler: callbacks run only when the shared injected clock is advanced explicitly. */
class DeadlineClock {
  now = NOW;
  unrefs = 0;
  maxPending = 0;
  callbacks = 0;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  lastCallback: (() => void) | undefined;
  schedule = (callback: () => void, delayMs: number) => {
    assert.ok(delayMs > 0, 'strict boundary must not cause a zero-delay loop');
    const entry = { due: this.now + delayMs, callback };
    this.pending.add(entry);
    this.maxPending = Math.max(this.maxPending, this.pending.size);
    this.lastCallback = callback;
    return { unref: () => { this.unrefs++; }, cancel: () => { this.pending.delete(entry); } };
  };
  runDue(): void {
    for (;;) {
      const entry = [...this.pending].find(item => item.due <= this.now);
      if (!entry) return;
      assert.ok(++this.callbacks < 100, 'bounded callbacks, no busy loop');
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

test('one unref timer autonomously settles multiple deadlines and survives invalidation', async t => {
  const scheduler = new DeadlineClock();
  let credentials = 0;
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 }, credentials: { resolve: async () => { credentials++; return CANARY; } } });
  const first = h.owner.create({ idempotencyKey: 'deadline-first', inputClass: 'ordinary' }, h.ctx);
  h.advance(5);
  const later = h.owner.create({ idempotencyKey: 'deadline-later', inputClass: 'ordinary' }, h.ctx);
  assert.equal(scheduler.pending.size, 1);
  h.advance(15); scheduler.runDue();
  assert.equal(scheduler.callbacks, 0);
  h.advance(1); scheduler.runDue();
  const counts = () => h.store.transaction(tx => tx.all("SELECT live_session_id, COUNT(*) AS n FROM live_journal WHERE kind='terminal' GROUP BY live_session_id"));
  assert.deepEqual(counts().map(row => ({ ...row })), [{ live_session_id: first.liveSessionId, n: 1 }]);
  assert.equal(scheduler.pending.size, 1);
  h.owner.invalidate('authority');
  h.advance(5); scheduler.runDue();
  assert.equal(counts().length, 2);
  assert.equal(h.owner.get(later.liveSessionId).terminal?.state, 'expired');
  assert.equal(h.owner.get(first.liveSessionId).terminal?.state, 'expired');
  assert.equal(scheduler.pending.size, 0);
  assert.equal(scheduler.maxPending, 1);
  assert.equal(scheduler.callbacks, 2);
  assert.ok(scheduler.unrefs >= 2);
  assert.equal(credentials, 0);
  assert.equal(h.f.attempts, 0);
});

test('expiry transactions roll back real storage failure on observation and autonomous timer', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  const row = h.owner.create({ idempotencyKey: 'deadline-fault', inputClass: 'ordinary' }, h.ctx);
  const failure = new Error('synthetic transaction storage failure');
  const original = h.store.transaction.bind(h.store);
  let fail = true;
  t.mock.method(h.store, 'transaction', (body: (tx: Transaction) => unknown) => original(tx => {
    const result = body(tx);
    if (fail) throw failure;
    return result;
  }));
  h.advance(21);
  assert.throws(() => h.owner.get(row.liveSessionId), error => error === failure);
  assert.throws(() => scheduler.runDue(), error => error === failure);
  assert.equal(scheduler.pending.size, 0, 'a failed callback must not silently retry');
  fail = false;
  assert.equal(original(tx => tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [row.liveSessionId]))?.['lifecycle'], 'accepted');
  assert.equal(original(tx => tx.all("SELECT * FROM live_journal WHERE kind='terminal'")).length, 0);
  assert.equal(h.owner.get(row.liveSessionId).terminal?.state, 'expired');
  assert.equal(h.f.attempts, 0);
});

test('shutdown cancels the deadline synchronously and fences already queued callbacks after Store close', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  h.owner.create({ idempotencyKey: 'deadline-shutdown', inputClass: 'ordinary' }, h.ctx);
  assert.equal(scheduler.pending.size, 1);
  const queued = scheduler.lastCallback!;
  const closing = h.owner.shutdown();
  assert.equal(scheduler.pending.size, 0);
  await closing;
  h.store.close();
  h.advance(21);
  assert.doesNotThrow(queued);
  assert.equal(scheduler.pending.size, 0);
  assert.equal(h.f.attempts, 0);
});

test('current deadline query plan measures unrelated terminal history without a cap', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  const measurements: Array<{ history: number; elapsedMs: number; accepted: number; due: number }> = [];
  const measure = (history: number) => {
    const start = performance.now();
    const result = h.store.transaction(tx => ({
      accepted: tx.all("SELECT live_session_id FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0", [h.store.assistantId]).length,
      due: tx.all("SELECT live_session_id FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0 AND created_at < ?", [h.store.assistantId, scheduler.now - 20]).length,
    }));
    measurements.push({ history, elapsedMs: performance.now() - start, ...result });
  };
  measure(0);
  for (let i = 0; i < 1000; i++) {
    const row = h.owner.create({ idempotencyKey: `history-${i}`, inputClass: 'ordinary' }, h.ctx);
    h.owner.revoke(row.liveSessionId);
    if (i === 99 || i === 999) measure(i + 1);
  }
  const accepted = h.owner.create({ idempotencyKey: 'plan-accepted', inputClass: 'ordinary' }, h.ctx);
  const plans = h.store.transaction(tx => ({
    next: tx.all("EXPLAIN QUERY PLAN SELECT MIN(created_at) AS created_at FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0", [h.store.assistantId]),
    due: tx.all("EXPLAIN QUERY PLAN SELECT * FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0 AND created_at < ?", [h.store.assistantId, scheduler.now - 20]),
  }));
  t.diagnostic(JSON.stringify({ terminalHistory: 1000, measurements, plans }));
  assert.ok(plans.next.every(row => String(row['detail']).includes('INDEX')));
  assert.ok(plans.due.every(row => String(row['detail']).includes('INDEX')));
  h.advance(21); scheduler.runDue();
  assert.equal(h.owner.get(accepted.liveSessionId).terminal?.state, 'expired');
  assert.equal(h.store.transaction(tx => tx.all("SELECT live_session_id FROM live_sessions WHERE lifecycle='terminal'")).length, 1001);
  assert.equal(scheduler.maxPending, 1);
});


test('timer storage failure is a causal uncaught process failure with durable rollback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-expiry-fault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `
    import { Store } from ${JSON.stringify(new URL('../runtime/store.js', import.meta.url).href)};
    import { createLiveSessionOwner, validateLiveProfile, liveMigrations } from ${JSON.stringify(new URL('../live/index.js', import.meta.url).href)};
    const store = new Store(${JSON.stringify(dir)}, liveMigrations);
    let clock = ${NOW}, callback;
    const owner = createLiveSessionOwner({ store, profile: validateLiveProfile(${JSON.stringify(profileInput({ unusedMs: 20 }))}),
      now: () => clock, voice: { open() { throw new Error('unexpected provider open'); } },
      schedule(fn) { callback = fn; return { unref() {}, cancel() {} }; } });
    const row = owner.create({ idempotencyKey: 'child-fault', inputClass: 'ordinary' }, { clientId: 'tester', auditId: 'fault', authorityEpoch: store.authorityEpoch });
    process.stdout.write(row.liveSessionId);
    const transaction = store.transaction.bind(store);
    store.transaction = body => transaction(tx => { const result = body(tx); throw new Error('LIVE-EXPIRY-CAUSAL-STORAGE-FAILURE'); });
    clock += 21;
    setImmediate(() => callback());
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.match(stderr, /LIVE-EXPIRY-CAUSAL-STORAGE-FAILURE/);
  assert.match(stdout, /^[a-f0-9-]{36}$/);
  const store = new Store(dir, liveMigrations);
  t.after(() => store.close());
  assert.equal(store.transaction(tx => tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [stdout]))?.['lifecycle'], 'accepted');
  assert.equal(store.transaction(tx => tx.all('SELECT * FROM live_journal')).length, 0);
  t.diagnostic('isolated child exit=1 signal=null; causal storage error preserved; transaction rolled back');
});

test('attach wins before deadline including opening, and expiry wins after it without open', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  const row = h.owner.create({ idempotencyKey: 'deadline-attach', inputClass: 'ordinary' }, h.ctx);
  h.advance(20);
  const original = GeminiLiveVoiceAdapter.prototype.open;
  t.mock.method(GeminiLiveVoiceAdapter.prototype, 'open', function(this: GeminiLiveVoiceAdapter, ...args: Parameters<typeof original>) {
    h.advance(1); scheduler.runDue();
    assert.equal(h.owner.get(row.liveSessionId).lifecycle, 'opening');
    return original.apply(this, args);
  });
  const attachment = h.owner.attach({ liveSessionId: row.liveSessionId }, h.ctx);
  assert.equal(h.owner.get(row.liveSessionId).lifecycle, 'active');
  await h.f.connected;
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  h.advance(100); scheduler.runDue();
  assert.equal(h.owner.get(row.liveSessionId).lifecycle, 'active');
  assert.equal(scheduler.pending.size, 2, 'only active session and idle budgets remain');
  t.mock.restoreAll();
  const past = h.owner.create({ idempotencyKey: 'deadline-attach-late', inputClass: 'ordinary' }, h.ctx);
  h.advance(21);
  assert.throws(() => h.owner.attach({ liveSessionId: past.liveSessionId }, h.ctx), { code: 'expired' });
  assert.equal(h.f.attempts, 1);
  await h.owner.shutdown();
  assert.equal(scheduler.pending.size, 0);
  assert.equal((await attachment.done).terminal?.state, 'closed');
});


test('trusted clock rejects fractional milliseconds and maximum timer delay stays bounded', async t => {
  const h = await harness(t);
  assert.throws(() => createLiveSessionOwner({ store: h.store, voice: { open() { throw new Error('unexpected open'); } }, profile: validateLiveProfile(profileInput()), now: () => NOW + 0.5 }), { code: 'invalid_config' });
  const scheduler = new DeadlineClock();
  const max = await harness(t, { scheduler, limits: { unusedMs: 2_147_483_647 } });
  const row = max.owner.create({ idempotencyKey: 'deadline-max', inputClass: 'ordinary' }, max.ctx);
  assert.equal([...scheduler.pending][0]!.due - scheduler.now, 2_147_483_647);
  max.advance(2_147_483_647); scheduler.runDue();
  assert.equal(max.owner.get(row.liveSessionId).lifecycle, 'accepted');
  assert.equal([...scheduler.pending][0]!.due - scheduler.now, 1);
  max.advance(1); scheduler.runDue();
  assert.equal(max.owner.get(row.liveSessionId).terminal?.state, 'expired');
  assert.equal(scheduler.callbacks, 2);
});

test('Live persists the exact typed accepted instruction before intent and corrupt records fail before provider open', async t => {
  const h = await harness(t);
  let calls = 0;
  const ownerProfile = { schemaVersion: 1, kind: 'profile', ownerId: h.store.assistantId, profileVersion: 'fixture-a', displayName: 'Example',
    style: { text: 'SYNTHETIC A', dataClass: 'ordinary' }, lore: { text: 'SYNTHETIC lore', dataClass: 'ordinary' } };
  const acceptedPrompt = { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION, system: 'SYNTHETIC exact accepted A', dataClasses: ['ordinary'] };
  const owner = createLiveSessionOwner({ store: h.store,
    profile: validateLiveProfile({ ...profileInput(), acceptedPrompt }),
    voice: { open() { calls++; throw new Error('synthetic unavailable'); } }, now: () => NOW });
  t.after(() => owner.shutdown());
  const run = owner.create({ idempotencyKey: 'owner-frozen', inputClass: 'ordinary' }, h.ctx);
  const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,dispatch_intent FROM live_sessions WHERE live_session_id=?', [run.liveSessionId]))!;
  assert.equal(row.dispatch_intent, 0);
  assert.deepEqual(JSON.parse(String(row.accepted_prompt_snapshot)), { ...acceptedPrompt, memory: { status: 'empty', selectedIds: [], omitted: [] } });
  acceptedPrompt.system = 'SYNTHETIC B';
  assert.equal(JSON.parse(String(h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [run.liveSessionId]))!.accepted_prompt_snapshot)).system, 'SYNTHETIC exact accepted A');
  h.store.transaction(tx => tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=? WHERE live_session_id=?', ['{"schemaVersion":999}', run.liveSessionId]));
  assert.throws(() => owner.attach({ liveSessionId: run.liveSessionId }, h.ctx));
  assert.equal(calls, 0);
});


test('private style alone and sensitive lore alone deny voice before adapter or socket creation', async t => {
  const h = await harness(t);
  for (const [styleClass, loreClass] of [['private', 'ordinary'], ['ordinary', 'sensitive']] as const) {
    let calls = 0;
    const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: h.store.assistantId, profileVersion: 'fixture', displayName: 'Example',
      style: { text: 'SYNTHETIC style', dataClass: styleClass }, lore: { text: 'SYNTHETIC lore', dataClass: loreClass } };
    const owner = createLiveSessionOwner({ store: h.store, profile: validateLiveProfile({ ...profileInput(),
      acceptedPrompt: { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION, system: 'SYNTHETIC instruction', dataClasses: ['ordinary', styleClass, loreClass].filter((c, i, cs) => cs.indexOf(c) === i) } }),
      voice: { open() { calls++; throw Error('must not open'); } }, now: () => NOW });
    assert.throws(() => owner.create({ idempotencyKey: `denied-${styleClass}-${loreClass}`, inputClass: 'ordinary' }, h.ctx));
    assert.equal(calls, 0); await owner.shutdown();
  }
});

test('Live emits exact accepted A setup, not a changed caller B instruction', async t => {
  const h = await harness(t);
  const acceptedPrompt = { schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId: h.store.assistantId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: 'SYNTHETIC exact wire A', dataClasses: ['ordinary'] };
  const profile = validateLiveProfile({ ...profileInput(), acceptedPrompt });
  const voice = new GeminiLiveVoiceAdapter(options({ socketFactory: h.f.socketFactory,
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: { resolve: async () => CANARY } }));
  const owner = createLiveSessionOwner({ store: h.store, profile, voice, now: () => NOW }); t.after(() => owner.shutdown());
  const accepted = owner.create({ idempotencyKey: 'wire-a', inputClass: 'ordinary' }, h.ctx);
  acceptedPrompt.system = 'SYNTHETIC current B';
  const attachment = owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx);
  await h.f.frame(1);
  const frame = JSON.parse(JSON.stringify(h.f.frames[0]));
  assert.equal(frame.setup.systemInstruction.parts[0].text, 'SYNTHETIC exact wire A');
  attachment.close();
});

test('legacy null and unsupported accepted Live bindings refuse honestly before dispatch intent', async t => {
  const h = await harness(t);
  for (const snapshot of [null, JSON.stringify({ schemaVersion: 1, compilerVersion: 'unsupported', system: 'synthetic', dataClasses: ['ordinary'],
    ownerProfile: { schemaVersion: 1, kind: 'default', ownerId: h.store.assistantId, displayName: 'Lux Didi' } })]) {
    const accepted = h.owner.create({ idempotencyKey: `legacy-${snapshot === null}`, inputClass: 'ordinary' }, h.ctx);
    h.store.transaction(tx => tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=? WHERE live_session_id=?', [snapshot, accepted.liveSessionId]));
    assert.throws(() => h.owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx), { code: 'invalidated' });
    assert.equal(h.owner.get(accepted.liveSessionId).dispatchIntent, false);
    assert.equal(h.f.frames.length, 0);
  }
});

test('completion after hangup remains delivery pending even before the deferral budget expires', async t => {
  const scheduler = new DeadlineClock();
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness(t, { tools: true, scheduler, beforeTool: () => work });
  const { session } = await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'detached1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  h.owner.revoke(session.liveSessionId);
  finish();
  const jobs = new LiveToolJobs(h.store, () => NOW);
  while (jobs.list()[0]!.state === 'in_progress') await tick();
  await tick();
  assert.equal(jobs.pending().length, 1, 'a returned batch is not delivered when the original call has ended');
  assert.equal(jobs.pending()[0]!.state, 'completed');
  assert.equal(jobs.pending()[0]!.delivered, false);
  assert.match(h.owner.pendingJobs()[0]!.markdown, /Synthetic insight/);
  assert.equal(h.f.frames.length, 1, 'completion cannot send to the ended Gemini session');
});

test('Live answers a slow tool batch truthfully, continues the turn, and retains a durable pending result', async t => {
  const scheduler = new DeadlineClock();
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness(t, { tools: true, scheduler, limits: { toolDeferralMs: 1000 }, beforeTool: () => slow });
  const { session } = await attached(h);
  assert.equal((h.requests[0] as LiveVoiceRequest & { opening?: string }).opening, 'model_first');
  h.f.send({ toolCall: { functionCalls: [{ id: 'slow1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  h.advance(1000); scheduler.runDue();
  await tick();
  assert.equal(new LiveToolJobs(h.store, () => NOW).pending().length, 1, 'dispatch must create a durable job before deferral');
  await h.f.frame(2);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { response: { status: string; jobId: string } }[] } };
  assert.equal(response.toolResponse.functionResponses[0]!.response.status, 'in progress');
  assert.ok(response.toolResponse.functionResponses[0]!.response.jobId);
  assert.equal(h.owner.current().state, 'listening');
  assert.equal(new LiveToolJobs(h.store, () => NOW).pending()[0]!.state, 'in_progress');
  h.owner.revoke(session.liveSessionId);
  await tick();
  assert.equal(h.owner.lookupAuthority(session.liveSessionId), null);
  finish();
  while (new LiveToolJobs(h.store, () => NOW).pending()[0]!.state === 'in_progress') await tick();
  assert.equal(new LiveToolJobs(h.store, () => NOW).pending()[0]!.state, 'completed');
  assert.equal(h.f.frames.length, 2, 'completion must not inject a late result into Gemini');
  assert.match(h.owner.pendingJobs()[0]!.markdown, /Synthetic insight/);
  h.owner.revoke(session.liveSessionId);
  await tick();
  assert.equal(h.owner.lookupAuthority(session.liveSessionId), null);
  const callback = h.owner.createWithPending({ inputClass: 'ordinary', idempotencyKey: 'callback' }, h.ctx);
  const frozenJob = new LiveToolJobs(h.store, () => NOW).forSession(callback.liveSessionId)!;
  assert.equal(accepted(h, callback.liveSessionId).pickup?.jobId, frozenJob.id);
  frozenJob.state = 'failed'; new LiveToolJobs(h.store, () => NOW).save(frozenJob);
  assert.throws(() => h.owner.attach({ liveSessionId: callback.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && String(error.code) === 'pickup_changed');
  assert.equal(h.requests.length, 1, 'changed pickup state is rejected before dispatch');
  frozenJob.state = 'completed'; new LiveToolJobs(h.store, () => NOW).save(frozenJob);
  const pickedUp = h.owner.attach({ liveSessionId: callback.liveSessionId }, h.ctx);
  await h.f.frame(3);
  h.f.send({ setupComplete: {} });
  await pickedUp.ready;
  await h.f.frame(4);
  const history = h.f.frames[3] as { clientContent: { turns: { parts: { text: string }[] }[] } };
  assert.match(history.clientContent.turns[0]!.parts[0]!.text, /Synthetic insight/);
  assert.equal((history.clientContent as typeof history.clientContent & { turnComplete: boolean }).turnComplete, true);
  assert.equal((h.requests[1] as LiveVoiceRequest & { opening?: string }).opening, 'model_first');
  assertFrozenInstruction(h, callback.liveSessionId, 1);
  assert.match(accepted(h, callback.liveSessionId).system, /user has just picked up/i);
  assert.match(h.requests[1]!.system.text, /user has just picked up/i);
  assert.match(h.requests[1]!.system.text, /briefly/i);
  h.f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] },
    outputTranscription: { text: 'Synthetic insight is ready.', finished: true }, turnComplete: true } });
  await drain(h, callback.liveSessionId, 3);
  const output = pickedUp.output[Symbol.asyncIterator]();
  const openingChunks = [(await output.next()).value, (await output.next()).value, (await output.next()).value];
  assert.ok(openingChunks.some(chunk => chunk?.kind === 'audio'), 'the completed opening produces a first spoken turn in the fixture');
  assert.ok(h.owner.current().entries.some(entry => entry.kind === 'outputTranscription' && entry.text === 'Synthetic insight is ready.'));
  assert.equal(h.f.frames.length, 4, 'pickup needs no microphone input or nudge frame');
  assert.equal(h.owner.pendingJobs().length, 0, 'only explicit pickup consumes the pending result');
});

test('Live accepts a frozen real tool snapshot and projects only result-gated Markdown', async t => {
  const h = await harness(t, { tools: true });
  const { session, attachment } = await attached(h);
  assert.equal(h.owner.lookupAuthority(session.liveSessionId)?.actorId, h.ctx.clientId);
  const setup = (h.f.frames[0] as { setup: { tools: { functionDeclarations: { name: string; parameters: any }[] }[] } }).setup;
  assert.deepEqual(setup.tools[0]!.functionDeclarations.map(tool => tool.name).sort(), ['get_insight', 'remember_note', 'search_knowledge']);
  const derived = setup.tools[0]!.functionDeclarations.find(d => d.name === 'get_insight')!;
  assert.equal(derived.parameters.properties.ids.type, 'STRING');
  const outputs = attachment.output[Symbol.asyncIterator]();
  assert.equal((await outputs.next()).value?.marker.kind, 'ready');
  h.f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }, { id: 'c2', name: 'get_insight', args: { ids: [123] } }] } });
  await h.f.frame(2);
  assert.equal(h.calls.length, 2);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string }[] } };
  assert.deepEqual(response.toolResponse.functionResponses.map(r => r.id), ['c1', 'c2']);
  assert.equal(h.owner.current().state, 'listening');
  const page = h.owner.current();
  assert.equal(page.entries.filter(e => e.kind === 'toolCall').length, 2);
  const result = page.entries.find(e => e.kind === 'toolResult')!.tool!;
  assert.equal(result.status, 'completed'); assert.match(result.markdown!, /Synthetic insight/);
  assert.deepEqual(result.sources, [{ title: '123' }, { title: 'Evidence', url: 'https://example.test/evidence' }], 'cards follow first occurrence in approved evidence');
  assert.equal(JSON.stringify(page).includes('liveSessionId'), false);
  assert.equal(JSON.stringify(page).includes('args'), false);
  assert.equal(JSON.stringify(page).includes(CANARY), false);
  const marker = (await outputs.next()).value;
  assert.equal(marker?.marker.kind, 'toolCall');
  attachment.close(); await attachment.done;
  assert.equal(h.owner.lookupAuthority(session.liveSessionId), null);
});

test('Live refuses undeclared tools and original-schema-invalid arguments without dispatch', async t => {
  const h = await harness(t, { tools: true }); const { attachment } = await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'bad1', name: 'get_insight', args: { ids: '[123]', include_links: 'false' } }, { id: 'bad2', name: 'not_granted', args: {} }] } });
  await h.f.frame(2); assert.equal(h.calls.length, 0);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { response: { error: string } }[] } };
  assert.deepEqual(response.toolResponse.functionResponses.map(r => r.response.error), ['invalid_arguments', 'unknown_tool']);
  assert.equal(h.owner.current().entries.filter(e => e.kind === 'toolResult' && e.tool?.status === 'error').length, 2);
  attachment.close(); await attachment.done;
});

test('Live revocation invalidates authority and discards an in-flight result', async t => {
  const started = deferred<void>(), finish = deferred<void>();
  const h = await harness(t, { tools: true, beforeTool: async () => { started.resolve(); await finish.promise; } });
  const { session, attachment } = await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'late', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await started.promise; assert.equal(h.owner.current().state, 'thinking');
  h.owner.revoke(session.liveSessionId); assert.equal(h.owner.lookupAuthority(session.liveSessionId), null);
  finish.resolve(); await attachment.done;
  assert.equal(h.f.frames.length, 1);
  assert.equal(h.owner.current().entries.filter(e => e.kind === 'toolResult').length, 0);
});

test('shared declarations retain original schemas and tool policy refuses before invocation', async () => {
  let invoked = 0; const ref = { id: 'r', sha256: 'a'.repeat(64) };
  const tool: ToolDefinition = { name: 'test', description: 'Test', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] }, enabled: { type: 'boolean' }, ids: { type: 'array', items: { type: 'integer' } } } },
    effect: 'read', accountId: 'a', resourceId: 'r', validate: args => typeof (args as { enabled?: unknown }).enabled === 'boolean', execute: async () => { invoked++; return { status: 'completed', result: ref }; } };
  const { declarations, originalByName } = declarationsFor([tool]);
  assert.deepEqual(originalByName.get('test'), tool.parameters); assert.notDeepEqual(declarations[0]!.parameters, tool.parameters);
  const host: HostContext = { runId: 'run', actorId: 'actor', authorityEpoch: 'epoch', revision: 0, grants: [] };
  const owner = { journal: { intent: () => 'fresh' as const, refuse: () => ref, fail: () => ref }, resultGate: { authorize: async (_host: HostContext, bindings: readonly import('../adapters/model/types.js').ToolResultBinding[]) => ({ state: 'allowed' as const, results: bindings.map(binding => ({ binding, response: { text: 'Accepted' }, dataClasses: [] })) }) } };
  const ctx = { registry: [tool], host, authority: { isCurrent: async () => false }, control: control(), step: 1, contentIndex: 0, seenIds: new Set<string>(), baseClasses: [] as const, authorize: true };
  const grant = await runToolCalls(owner, [{ id: 'g', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(grant.tools[0]!.reason, 'grant_not_permitted'); assert.equal(invoked, 0);
  host.grants.push({ tool: 'test', effect: 'read', accountId: 'a', resourceId: 'r' });
  const revoked = await runToolCalls(owner, [{ id: 'r', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(revoked.tools[0]!.reason, 'stale_or_revoked_authority'); assert.equal(invoked, 0);
  ctx.authority.isCurrent = async () => true;
  const completed = await runToolCalls(owner, [{ id: 'c', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(completed.tools[0]!.status, 'completed'); assert.equal(invoked, 1);
  tool.execute = async () => { throw Error(CANARY); };
  const failed = await runToolCalls(owner, [{ id: 'f', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(failed.tools[0]!.status, 'failed'); assert.equal(JSON.stringify(failed).includes(CANARY), false);
});

function writePrivate(dir: string, name: string, text: string): void {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('Live attach setup carries the composed Naya instruction and the bare language code', async t => {
  const h = await harness(t);
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC local overlay persona', greeting: 'Synthetic greeting' };
  const composed = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'de' });
  assert.ok(composed.text.startsWith(NAYA_BASE), 'composed instruction starts with the public base');
  const acceptedPrompt = { schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId: h.store.assistantId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: composed.text, dataClasses: ['ordinary'] };
  const profile = validateLiveProfile({ ...profileInput(), language: 'de', acceptedPrompt });
  const voice = new GeminiLiveVoiceAdapter(options({ socketFactory: h.f.socketFactory,
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: { resolve: async () => CANARY } }));
  const owner = createLiveSessionOwner({ store: h.store, profile, voice, now: () => NOW }); t.after(() => owner.shutdown());
  const accepted = owner.create({ idempotencyKey: 'wire-naya', inputClass: 'ordinary' }, h.ctx);
  const attachment = owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx);
  await h.f.frame(1);
  const frame = JSON.parse(JSON.stringify(h.f.frames[0]));
  assert.equal(frame.setup.systemInstruction.parts[0].text, composed.text);
  assert.equal(frame.setup.generationConfig.speechConfig.languageCode, 'de');
  attachment.close();
});

test('loadLiveConfig keeps public prompt bytes and composes classified owner sections into the accepted Live system', async t => {
  const root = mkdtempSync(join(tmpdir(), 'didi-live-config-'));
  const dataDir = join(root, 'data'); const configDir = join(dataDir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700); chmodSync(configDir, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
    dataClasses: ['ordinary', 'private', 'sensitive'], preferences: { dataClass: 'ordinary', language: 'de-de', register: 'plain', humor: 'dry', verbosity: 'brief' } };
  writePrivate(configDir, 'live.json', `${JSON.stringify(live)}\n`);
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC local overlay persona', greeting: 'Synthetic greeting', accent: 'Synthetic accent' };
  writePrivate(dataDir, 'persona-overlay.json', JSON.stringify(overlay));
  const style = `SYNTHETIC owner style ${'S'.repeat(3000)}`;
  const lore = `SYNTHETIC owner lore ${'L'.repeat(13_955)}`;
  const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: style, dataClass: 'private' as const }, lore: { text: lore, dataClass: 'sensitive' as const } };
  const status = loadLiveConfig({ configDir, ownerId: 'synthetic-owner', ownerProfile });
  assert.equal(status.status, 'configured');
  if (status.status === 'configured') {
    const expected = composeLiveInstruction({ base: NAYA_BASE, accent: overlay.accent, language: 'de' });
    const accepted = composeLiveInstruction({ base: NAYA_BASE, ownerProfile, accent: overlay.accent, language: 'de' });
    assert.deepEqual(status.config.profile.overlay, overlay);
    assert.equal(status.config.profile.language, 'de');
    assert.equal(status.config.profile.prompt.text, expected.text);
    assert.equal(status.config.profile.acceptedPrompt?.system, accepted.text);
    assert.ok(accepted.text.length > 4096);
    assert.equal(accepted.text.split(style).length - 1, 1); assert.equal(accepted.text.split(lore).length - 1, 1);
    assert.deepEqual(status.config.profile.acceptedPrompt?.dataClasses, ['ordinary', 'private', 'sensitive']);
  }
  writePrivate(dataDir, 'persona-overlay.json', '{ not json');
  const bad = loadLiveConfig({ configDir, ownerId: 'synthetic-owner', ownerProfile });
  assert.equal(bad.status, 'error');
  if (bad.status === 'error') assert.equal(bad.code, 'invalid_overlay');
});

test('configured owner system survives CREATE and attach open byte for byte before provider setup', async t => {
  const f = await fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'didi-live-owner-reopen-'));
  const dataDir = join(root, 'data'); const configDir = join(dataDir, 'provider-config'); const storeDir = join(root, 'store');
  mkdirSync(configDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700); chmodSync(configDir, 0o700);
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(storeDir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
    dataClasses: ['ordinary', 'private'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } };
  writePrivate(configDir, 'live.json', JSON.stringify(live));
  const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: store.assistantId, profileVersion: 'fixture', displayName: 'Example',
    style: { text: 'SYNTHETIC reopen style', dataClass: 'private' as const }, lore: { text: 'SYNTHETIC reopen lore', dataClass: 'ordinary' as const } };
  const status = loadLiveConfig({ configDir, ownerId: store.assistantId, ownerProfile });
  assert.equal(status.status, 'configured'); if (status.status !== 'configured') return;
  const expected = status.config.profile.acceptedPrompt!.system;
  const adapter = () => new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory,
    modelId: status.config.profile.liveModelId, voice: status.config.profile.voice, keyReference: status.config.profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: status.config.profile.liveModelId, dataClasses: status.config.profile.route.dataClasses },
    credentials: { resolve: async () => CANARY } }));
  const first = createLiveSessionOwner({ store, profile: status.config.profile, voice: adapter(), now: () => NOW });
  const created = first.create({ idempotencyKey: 'owner-create', inputClass: 'ordinary' }, context(store));
  const persisted = store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [created.liveSessionId])!['accepted_prompt_snapshot'])));
  assert.equal(persisted.system, expected); assert.deepEqual(persisted.dataClasses, ['ordinary', 'private']);
  const attachment = first.attach({ liveSessionId: created.liveSessionId }, context(store));
  await f.frame(1);
  const frame = JSON.parse(JSON.stringify(f.frames[0]));
  assert.equal(frame.setup.systemInstruction.parts[0].text, expected);
  attachment.close(); await attachment.done; await first.shutdown();
});

test('provider voice activity journals listening and thinking without retaining its payload', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: {}, voiceActivity: { voiceActivityType: 'ACTIVITY_END', synthetic: 'not-journalled' } });
  await drain(h, session.liveSessionId, 2);
  assert.equal(h.owner.current().state, 'thinking');
  h.f.send({ serverContent: {}, voiceActivity: { voiceActivityType: 'ACTIVITY_START' } });
  await drain(h, session.liveSessionId, 3);
  assert.equal(h.owner.current().state, 'listening');
  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.deepEqual(page.fragments.filter(f => f.kind === 'waitingForInput').map(f => f.value), [false, true]);
  assert.equal(JSON.stringify(page).includes('not-journalled'), false);
  attachment.close();
  await attachment.done;
});

test('resumption keeps journal identity and frozen authority with the real adapter', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-identity');
  const frozen = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,memory_provenance FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]));
  const handle = 'synthetic-owner-resumption-secret';
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(2);
  const setup = (h.f.frames[1] as { setup: { sessionResumption: { handle: string } } }).setup;
  assert.equal(setup.sessionResumption.handle === handle, true);
  const saved = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,memory_provenance,resumption_handle,connection_generation FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!;
  assert.deepEqual({ accepted_prompt_snapshot: saved.accepted_prompt_snapshot, memory_provenance: saved.memory_provenance }, { ...frozen });
  assert.equal(saved.resumption_handle === handle, true);
  assert.equal(saved.connection_generation, 1);
  assert.equal(h.memorySelections, 1, 'memory selection is never re-run');
  assert.deepEqual(h.requests[1]!.tools, h.requests[0]!.tools);
  assert.deepEqual(h.requests[1]!.system, h.requests[0]!.system);
  assert.equal(h.owner.current().state, 'rebuilding');
  const beforeLate = h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.length;
  h.f.clients[0]!.emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-stale-secret' }, toolCall: { functionCalls: [{ id: 'stale-call', name: 'not_admitted', args: {} }] }, serverContent: { inputTranscription: { text: 'stale row' } } })));
  h.f.clients[0]!.emit('close', 1008);
  await tick();
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.length, beforeLate, 'old callbacks cannot append or settle');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle === handle, true, 'old handle cannot replace the current candidate');
  assert.equal(JSON.stringify(h.owner.current()).includes(handle), false);
  h.f.send({ setupComplete: {} });
  // The public committed marker, not a timer, is the resumption acknowledgement.
  const output = attachment.output[Symbol.asyncIterator]();
  await continuity(output, 'resumed');
  assert.equal(h.owner.current().state, 'listening');
  attachment.close(); await attachment.done;
  const rows = h.store.transaction(tx => tx.all('SELECT journal_id,kind FROM live_journal WHERE live_session_id=? ORDER BY journal_id', [session.liveSessionId]));
  assert.equal(rows.filter(r => r.kind === 'terminal').length, 1);
  assert.equal(rows.filter(r => r.kind === 'continuity').length, 2);
  assert.equal(new Set(rows.map(r => r.journal_id)).size, rows.length);
});

test('pending tool call at the resume cut gets one lost result and never dispatches on the new connection', async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const h = await harness(t, { tools: true, beforeGate: async () => { entered.resolve(); await release.promise; } });
  t.after(() => release.resolve());
  const { session, attachment } = await attached(h, 'resume-lost-tool');
  const acceptance = h.store.transaction(tx => tx.get('SELECT acceptance_json,accepted_run_hash FROM live_tool_acceptances WHERE live_session_id=?', [session.liveSessionId]));
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-tool-resumption-secret' }, toolCall: { functionCalls: [{ id: 'lost-call', name: 'lux_search_knowledge', args: { query: 'test', limit: 1 } }] } });
  await entered.promise;
  assert.equal(h.calls.length, 0);
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(2);
  assert.equal(h.owner.current().state, 'rebuilding');
  const cut = h.owner.listFragments({ liveSessionId: session.liveSessionId });
  const lost = cut.fragments.filter(row => row.tool?.code === 'tool_call_lost_on_resume');
  assert.equal(lost.length, 1);
  assert.equal(lost[0]!.tool!.callId, 'lost-call');
  const rebuilding = cut.fragments.find(row => row.kind === 'continuity');
  assert.equal(rebuilding?.event, 'rebuilding');
  assert.equal(rebuilding?.text, null, 'continuity is typed, not transcript text');
  assert.deepEqual(h.store.transaction(tx => tx.get('SELECT acceptance_json,accepted_run_hash FROM live_tool_acceptances WHERE live_session_id=?', [session.liveSessionId])), acceptance);
  h.f.send({ setupComplete: {} });
  const output = attachment.output[Symbol.asyncIterator]();
  await continuity(output, 'resumed');
  release.resolve();
  // Let the rejected old dispatch gate and its catch finish without a clock wait.
  await tick(); await tick();
  assert.equal(h.calls.length, 0, 'old pending call is never dispatched');
  assert.equal(h.f.frames.some(frame => 'toolResponse' in (frame as object)), false);
  const after = h.owner.listFragments({ liveSessionId: session.liveSessionId });
  assert.equal(after.fragments.filter(row => row.tool?.code === 'tool_call_lost_on_resume').length, 1);
  assert.equal(after.fragments.length, cut.fragments.length + 1, 'only the resumed row crosses the generation fence');
  attachment.close(); await attachment.done;
});

async function continuity(output: AsyncIterator<import('../live/types.js').LiveOutputChunk>, event: 'rebuilding' | 'resumed') {
  for (;;) {
    const item = await output.next();
    assert.equal(item.done, false, 'consumer remains attached across the resume');
    if (item.value.kind === 'marker' && item.value.marker.kind === 'continuity' && item.value.marker.event === event) return item.value.marker;
  }
}

test('resumed setup policy rejection ends once with resume_failed', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-policy');
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-policy-resumption-secret' }, goAway: { timeLeft: '10s' } });
  await h.f.frame(2); h.f.remoteClose('', 1008);
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 1);
});

test('third recoverable loss ends the same session without a fourth connection', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-attempts');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-attempt-resumption-secret' } });
  for (let connection = 2; connection <= 3; connection++) {
    h.f.send({ goAway: { timeLeft: '10s' } }); await h.f.frame(connection);
    h.f.send({ setupComplete: {} }); await continuity(output, 'resumed');
  }
  h.f.remoteClose('', 1011);
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.f.connections, 3);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 1);
});

test('revoked resumption handle is cleared before a recoverable loss', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-cleared');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-cleared-resumption-secret' }, serverContent: { inputTranscription: { text: 'saved' } } });
  await transcription(output, 'saved');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle !== null, true);
  h.f.send({ sessionResumptionUpdate: { resumable: false }, serverContent: { inputTranscription: { text: 'cleared' } } });
  await transcription(output, 'cleared');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle, null);
  h.f.remoteClose('', 1011);
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.f.connections, 1);
});

test('resumption cannot extend the original session budget or idle expiry', async t => {
  for (const limit of ['sessionMs', 'idleMs'] as const) {
    const scheduler = new DeadlineClock();
    const h = await harness(t, { scheduler, limits: { sessionMs: 1000, idleMs: 1000, [limit]: 100 } });
    const { attachment } = await attached(h, `resume-${limit}`);
    const output = attachment.output[Symbol.asyncIterator]();
    h.advance(60);
    h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-budget-resumption-secret' }, goAway: { timeLeft: '10s' } });
    await h.f.frame(2); h.f.send({ setupComplete: {} }); await continuity(output, 'resumed');
    h.advance(40); scheduler.runDue();
    const terminal = (await attachment.done).terminal!;
    assert.equal(terminal.state, 'failed');
    assert.equal('code' in terminal && terminal.code, limit === 'sessionMs' ? 'session_timeout' : 'idle_timeout');
    assert.equal(h.f.connections, 2);
  }
});

async function transcription(output: AsyncIterator<import('../live/types.js').LiveOutputChunk>, text: string) {
  for (;;) {
    const item = await output.next(); assert.equal(item.done, false);
    if (item.value.kind === 'marker' && item.value.marker.text === text) return;
  }
}


test('queued PCM is dropped at the cut and capture during rebuilding is never replayed', async t => {
  const diagnosticLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('live_session_diagnostics')) diagnosticLines.push(args[0]);
  });
  const h = await harness(t);
  const { attachment } = await attached(h, 'resume-media');
  attachment.sendAudio({ pcm }); await h.f.frame(2);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-media-resumption-secret' }, serverContent: { modelTurn: { parts: [audio()] } }, goAway: { timeLeft: '10s' } });
  await h.f.frame(3);
  const output = attachment.output[Symbol.asyncIterator]();
  for (;;) {
    const item = await output.next(); assert.equal(item.done, false);
    assert.notEqual(item.value.kind, 'audio', 'old queued output PCM is discarded');
    if (item.value.kind === 'marker' && item.value.marker.kind === 'continuity') break;
  }
  attachment.sendAudio({ pcm }); attachment.endAudioStream();
  assert.equal(h.f.frames.length, 3, 'capture during rebuilding is dropped');
  h.f.send({ setupComplete: {}, serverContent: { modelTurn: { parts: [audio()] } } });
  await continuity(output, 'resumed');
  const resumedAudio = await output.next();
  assert.equal(resumedAudio.value.kind, 'audio');
  assert.equal(h.f.frames.length, 3, 'no old PCM replay follows setupComplete');
  attachment.close(); const finalSnapshot = await attachment.done;
  let matching: Record<string, number | string>[] = [];
  for (let attempt = 0; attempt < 20 && matching.length === 0; attempt++) {
    await tick();
    matching = diagnosticLines.map(line => JSON.parse(line) as Record<string, number | string>)
      .filter(value => value.ownerAudioCalls === 2 && value.ownerRebuildingDropCalls === 1);
  }
  assert.equal(matching.length, 1);
  const diagnostics = matching[0]!;
  const terminalCode = finalSnapshot.terminal && 'code' in finalSnapshot.terminal ? finalSnapshot.terminal.code : finalSnapshot.terminal?.state;
  assert.equal(diagnostics.event, 'live_session_diagnostics'); assert.equal(diagnostics.terminalCode, terminalCode);
  assert.equal(diagnostics.adapterGenerations, 2);
  assert.equal(diagnostics.ownerAudioCalls, 2); assert.equal(diagnostics.ownerAudioBytes, pcm.byteLength * 2);
  assert.equal(diagnostics.ownerRebuildingDropCalls, 1); assert.equal(diagnostics.ownerRebuildingDropBytes, pcm.byteLength);
  assert.equal(diagnostics.adapterAudioCalls, 1); assert.equal(diagnostics.adapterAudioBytes, pcm.byteLength);
  assert.equal(diagnostics.outputAudioFrames, 2); assert.equal(diagnostics.outputAudioPCMBytes, pcm.byteLength * 2);
});


test('an exhausted original budget never opens a replacement connection', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 100, idleMs: 1000 } });
  const { attachment } = await attached(h, 'resume-exhausted');
  h.advance(100); // Recoverable loss wins before the fake timer callback runs.
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-exhausted-resumption-secret' }, goAway: { timeLeft: '10s' } });
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.f.connections, 1);
});

for (const outcome of ['failed', 'closed', 'unknown'] as const) {
  test(`page projects past Live ${outcome} with truthful timing`, async t => {
    const h = await harness(t);
    const session = h.owner.create({ idempotencyKey: 'past', inputClass: 'ordinary' }, h.ctx);
    const terminal = outcome === 'unknown' ? null : JSON.stringify({ state: outcome, code: 'fixture' });
    h.store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='active',terminal_outcome=?,terminal_at=?,updated_at=? WHERE live_session_id=?", [terminal, outcome === 'unknown' ? null : NOW + 1000, NOW + 2000, session.liveSessionId]));
    const page = h.owner.current();
    assert.equal(page.state, 'ended');
    assert.deepEqual((page as typeof page & { pastSession?: unknown }).pastSession, { outcome, endedAt: outcome === 'unknown' ? null : NOW + 1000, lastObservedAt: NOW + 2000 });
  });
}
test('active page does not carry past session metadata', async t => {
  const h = await harness(t);
  await attached(h);
  assert.equal(h.owner.current().state, 'listening');
  assert.equal((h.owner.current() as { pastSession?: unknown }).pastSession, undefined);
});


for (const status of [401, 403, 429]) test(`resumed HTTP upgrade refusal ${status} ends without another recovery attempt`, async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, `resume-refused-${status}`);
  h.f.refuseUpgrades(status);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-refused-resumption-secret' }, goAway: { timeLeft: '10s' } });
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.f.attempts, 2, 'one original connection and one rejected resume, never a second recovery');
  assert.equal(h.f.connections, 1);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(row => row.kind === 'terminal').length, 1);
});

test('established WebSocket protocol error ends without resumption despite a saved handle', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-protocol-final');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-protocol-resumption-secret' } });
  h.f.send({ serverContent: { inputTranscription: { text: 'protocol sentinel' } } });
  await transcription(output, 'protocol sentinel');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle !== null, true);
  // If the defect reconnects, refuse setup immediately rather than waiting a real timeout.
  h.f.refuseUpgrades(403); h.f.invalidOpcode();
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'protocol_error' });
  assert.equal(h.f.attempts, 1);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(row => row.kind === 'terminal').length, 1);
});
