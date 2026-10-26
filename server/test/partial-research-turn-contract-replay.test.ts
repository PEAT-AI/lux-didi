import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, deadlineResearchId, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import type { LiveToolsComposition } from '../live/types.js';
import { liveProfileIdentity } from '../live/config.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { RESEARCH_OPERATION, ResearchLedger, runResearch, type ResearchDeps, type ResearchTimer } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import type { LiveToolResponse, LiveVoiceControl, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession } from '../adapters/live-voice/index.js';

/**
 * C-LIVE replay eval `partial-research-turn-contract-replay`: the partial-result cascade of 2026-10-25 (one
 * research answer "9 of 38", then five to seven `continue` calls a few ms apart with no audio, a dead-air rebuild
 * and an answer 58 s after the ask), replayed over the fake live voice provider, a fake research backend and a
 * virtual clock. Synthetic text only: no owner speech, no real source.
 *
 * The council's assertions (decision-how-a-voice-assistant-lux-didi-dfc8): one operation per owner turn, no
 * model-initiated continue proceeds, the operation returns by its deadline, coverage equals the deduplicated
 * fixture, a compliant provider answers after the result with no rebuild, a noncompliant provider cannot loop,
 * and a real follow-up from the owner continues the run.
 */

/** R1: the patience budget and the host grace, read from the one place that names them. */
const OPERATION_DEADLINE_MS = RESEARCH_OPERATION.deadlineMs;
const HOST_GRACE_MS = RESEARCH_OPERATION.hostGraceMs;
const BLOCKED = { status: 'blocked', reason: 'owner_turn_required', directive: 'answer_existing_result', retry_without_new_owner_turn: false };

const NOW = 1_700_000_000_000;
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

class DeadlineClock {
  now = NOW;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
    const entry = { due: this.now + delayMs, callback };
    this.pending.add(entry);
    return { unref: () => {}, cancel: () => { this.pending.delete(entry); } };
  };
  runDue(): void {
    for (;;) {
      const entry = [...this.pending].filter(item => item.due <= this.now).sort((a, b) => a.due - b.due)[0];
      if (!entry) return;
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

/** The fake live voice provider: each open is one provider generation the test drives and can kill. */
interface Generation { live(): void; die(): void; toolResponses: LiveToolResponse[][]; texts: string[]; request: LiveVoiceRequest }
function providerPort() {
  const generations: Generation[] = [];
  let events: (event: LiveVoiceEvent) => void = () => {};
  let sequence = 0;
  const port = {
    capabilities: Object.freeze({ provider: 'openai', supportsResumption: false, supportsGoAway: false, supportsInterruption: false,
      supportsServerVadConfig: false, inputRates: Object.freeze([8000]), outputRates: Object.freeze([24000]),
      outputModalities: Object.freeze(['audio', 'text'] as const), thinking: 'provider_default', supportsToolScheduling: false,
      toleratesEmptyReadyLifecycle: false }),
    open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      let resolveReady: () => void = () => {};
      let rejectReady: (error: unknown) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      let resolveDone: (outcome: LiveVoiceOutcome) => void = () => {};
      const done = new Promise<LiveVoiceOutcome>(resolve => { resolveDone = resolve; });
      const pending: LiveVoiceEvent[] = [];
      let waiter: (() => void) | undefined;
      let ended = false;
      const wake = () => { const waiting = waiter; waiter = undefined; waiting?.(); };
      const end = (): void => { ended = true; wake(); };
      events = event => { pending.push(event); wake(); };
      const toolResponses: LiveToolResponse[][] = [];
      const texts: string[] = [];
      const iterator: AsyncIterable<LiveVoiceEvent> = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (ended) return;
            if (!pending.length) { await new Promise<void>(resolve => { waiter = resolve; }); continue; }
            yield pending.shift()!;
          }
        },
      };
      const session: LiveVoiceSession = {
        ready, done, events: iterator,
        sendAudio(): void {}, sendText(input: { text: string }): void { texts.push(input.text); }, endAudioStream(): void {},
        sendToolResponse(input): 'sent' { toolResponses.push([...input.responses]); return 'sent'; },
        close(): void { if (ended) return; end(); resolveDone({ status: 'cancelled', code: 'cancelled' }); },
      };
      control.signal.addEventListener('abort', () => { if (ended) return; end(); resolveDone({ status: 'cancelled', code: 'cancelled' }); }, { once: true });
      generations.push({
        request, toolResponses, texts,
        live: () => { events({ sequence: ++sequence, type: 'ready' } as LiveVoiceEvent); resolveReady(); },
        die: () => { rejectReady(new Error('synthetic transport loss')); resolveDone({ status: 'failed', code: 'transport_error', recoverable: true }); end(); },
      });
      return session;
    },
  } as unknown as LiveVoicePort;
  return { port, generations, emit: (event: Record<string, unknown>) => events({ ...event, sequence: ++sequence } as unknown as LiveVoiceEvent) };
}

/** The fake research backend: one knowledge connector whose answers the test can hold, release or script. */
async function backend(t: TestContext, store: Store, profile: ReturnType<typeof validateLiveProfile>, owner: () => LiveSessionOwner | undefined) {
  const schemas = [{ name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, detail: { type: 'string', enum: ['snippets', 'bodies'] }, max_chars: { type: 'integer' }, deadline_ms: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } }];
  const calls: { name: string; args: Record<string, unknown> | undefined }[] = [];
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const registry = new McpRegistry();
  const endpoint = { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'account', resource: 'resource' };
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const sdk = new Server({ name: 'partial-research-replay', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(schemas) }) as never);
  sdk.setRequestHandler('tools/call', async request => {
    calls.push({ name: request.params.name, args: request.params.arguments });
    if (held !== undefined) await held;
    const lines = Array.from({ length: 12 }, (_, n) => `### Synthetic note ${n + 1} (DECISION | 2026-10-2${n % 9}) [id ${100 + n}]\nSynthetic body ${n + 1}.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(request);
  });
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10_000, maxSliceBytes: 512 }),
    resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: 12_000, projectionChars: 10, timeoutMs: 60_000 } });
  const toolOwner = createToolsOwner({ grantMode: 'owner-trusted-reads', store, ownerId: store.assistantId, registry, port,
    lookupAuthority: async runId => owner()?.lookupAuthority(runId) ?? owner()?.lookupJobAuthority(runId) ?? null });
  toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge'], schemaDigest: canonicalToolDigest(schemas),
    sourcePolicy: { id: 'replay-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 8, maxGetIds: 3, maxEntityBytes: 8192, maxResultBytes: 8192 } });
  assert.equal((await port.discover(endpoint.id)).state, 'discovered');
  toolOwner.projectConnection('lux');
  t.after(async () => { release?.(); await port.close(); await transport.close(); await sdk.close(); });
  const tools: LiveToolsComposition = { owner: toolOwner, connectionIds: () => ['lux'] };
  return { tools, calls, hold: () => { held = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { held = undefined; release?.(); release = undefined; } };
}

interface Harness {
  owner: LiveSessionOwner; store: Store; clock: DeadlineClock; ctx: LiveContext;
  provider: ReturnType<typeof providerPort>;
  receipts: Record<string, unknown>[];
  dispatches: { name: string; args: Record<string, unknown> | undefined }[];
  hold(): void; release(): void;
  liveSessionId: string;
  advance(ms: number): Promise<void>;
}

async function harness(t: TestContext): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-partial-replay-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  const ctx: LiveContext = { clientId: 'replay', auditId: 'replay-audit', authorityEpoch: store.authorityEpoch };
  const clock = new DeadlineClock();
  const provider = providerPort();
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  const model = 'gpt-live-1';
  const profile = validateLiveProfile({
    provider: 'openai', liveModelId: model, voice: 'marin', keyReference: 'openai-primary',
    route: { enabled: true, provider: 'openai', modelId: model, dataClasses: ['ordinary'] },
    prompt: { text: 'SYNTHETIC replay instructions', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  let ownerRef: LiveSessionOwner | undefined;
  const fake = await backend(t, store, profile, () => ownerRef);
  const owner = createLiveSessionOwner({ store, voice: provider.port, profile, tools: fake.tools,
    now: () => clock.now, timeZone: 'UTC', schedule: clock.schedule });
  ownerRef = owner;
  t.after(() => { sink(); rmSync(dir, { recursive: true, force: true }); });
  const created = owner.create({ idempotencyKey: `replay-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: created.liveSessionId }, ctx);
  attachment.ready.catch(() => {});
  for (let i = 0; i < 60 && provider.generations.length === 0; i++) await flush();
  provider.generations[0]!.live();
  await attachment.ready;
  await flush();
  t.after(() => { try { owner.revoke(created.liveSessionId); } catch { /* already terminal */ } });
  return { owner, store, clock, ctx, provider, receipts, dispatches: fake.calls, hold: fake.hold, release: fake.release,
    liveSessionId: created.liveSessionId,
    advance: async ms => { const target = clock.now + ms; while (clock.now < target) { clock.now = Math.min(target, clock.now + 100); clock.runDue(); await flush(); } } };
}

/** The owner finishes one spoken turn: text, then the transcript closes. */
async function ownerSays(h: Harness, text = 'synthetic owner question about the plan'): Promise<void> {
  h.provider.emit({ type: 'inputTranscription', text, finished: false });
  h.provider.emit({ type: 'inputTranscription', text: '', finished: true });
  await flush();
}

/** The model calls research once; `generation` is the provider session the call arrives on. */
async function research(h: Harness, id: string, args: Record<string, unknown>): Promise<void> {
  h.provider.emit({ type: 'toolCall', calls: [{ id, name: 'research', args }] });
  await flush();
}

/** Every research reply the model received, across every provider generation, in order. */
function replies(h: Harness): { id: string; response: Record<string, unknown>; generation: number }[] {
  return h.provider.generations.flatMap((generation, index) => generation.toolResponses.flat()
    .map(entry => ({ id: entry.id, response: entry.response as Record<string, unknown>, generation: index })));
}

async function replyFor(h: Harness, id: string, budgetMs = 15_000): Promise<Record<string, unknown>> {
  for (let waited = 0; waited <= budgetMs; waited += 100) {
    const found = replies(h).find(entry => entry.id === id);
    if (found) return found.response;
    await flush();
    await h.advance(100);
  }
  assert.fail(`no reply for ${id} within ${budgetMs} ms: ${JSON.stringify(replies(h).map(entry => entry.id))}`);
}

/** The compliant provider speaks the answer it was given and ends its turn. */
async function speaks(h: Harness): Promise<void> {
  const pcm = new Uint8Array(4_800);
  for (let i = 0; i < pcm.length; i += 2) { pcm[i] = 0x40; pcm[i + 1] = 0x1f; }
  h.provider.emit({ type: 'modelTurnStarted' });
  h.provider.emit({ type: 'audio', pcm, rate: 24_000, audible: true, rmsDbfs: -12 });
  h.provider.emit({ type: 'turnComplete' });
  await flush();
}

const start = { action: 'start', question: 'what do we know about the plan', topic: 'plan' };
const rebuilds = (h: Harness): number => h.receipts.filter(entry => entry['event'] === 'live_rebuild').length;

test('replay 1: the observed cascade, six model continues after one partial answer, is refused without dispatch and answered without a rebuild', async t => {
  const h = await harness(t);
  await ownerSays(h);
  await research(h, 'r1', start);
  const first = await replyFor(h, 'r1');
  assert.equal(first['status'] === 'blocked', false, `the owner's own ask is one admitted operation: ${JSON.stringify(first)}`);
  const researchId = String(first['researchId']);
  const dispatched = h.dispatches.length;
  assert.ok(dispatched >= 1, 'the admitted start read the source');
  // The observed shape: five continues a few ms apart, then a stop, then one more continue, all with no audio.
  for (const [n, action] of ['continue', 'continue', 'continue', 'continue', 'continue', 'stop', 'continue'].entries()) {
    await research(h, `c${n}`, { action, researchId });
    const reply = await replyFor(h, `c${n}`);
    if (action === 'stop') { assert.notEqual(reply['status'], 'blocked', 'stop is always allowed'); continue; }
    assert.deepEqual(reply, BLOCKED, `a model continue with no owner turn since the answer is refused (call c${n}): ${JSON.stringify(reply)}`);
    await h.advance(20);
  }
  assert.equal(h.dispatches.length, dispatched, 'no refused continue reached a source');
  assert.equal(h.receipts.filter(entry => entry['event'] === 'research_blocked').length, 6, 'every refusal leaves one content-free receipt');
  // The compliant provider answers from the result it has, and nothing rebuilds the session under it.
  await speaks(h);
  await h.advance(30_000);
  assert.equal(rebuilds(h), 0, `a compliant answer after the result needs no rebuild: ${JSON.stringify(h.receipts.filter(entry => String(entry['event']).startsWith('live_rebuild') || entry['event'] === 'live_dead_air'))}`);
  assert.equal(h.provider.generations.length, 1, 'one provider session the whole turn');
});

test('replay 2: a second start in the same owner turn is refused the same way and reads nothing', async t => {
  const h = await harness(t);
  await ownerSays(h);
  await research(h, 's1', start);
  await replyFor(h, 's1');
  const dispatched = h.dispatches.length;
  await research(h, 's2', { action: 'start', question: 'and what about the budget', topic: 'budget' });
  assert.deepEqual(await replyFor(h, 's2'), BLOCKED, 'one operation per owner turn');
  await research(h, 's3', { action: 'start', question: 'and the hiring plan', topic: 'hiring plan' });
  assert.deepEqual(await replyFor(h, 's3'), BLOCKED, 'and every further call in that turn is refused too');
  assert.equal(h.dispatches.length, dispatched, 'no refused start reached a source');
});

test('replay 3: a noncompliant provider that keeps calling cannot loop, and recovery is never disabled', async t => {
  const h = await harness(t);
  await ownerSays(h);
  await research(h, 'n0', start);
  const first = await replyFor(h, 'n0');
  const dispatched = h.dispatches.length;
  for (let n = 1; n <= 20; n += 1) {
    await research(h, `n${n}`, { action: n % 2 === 0 ? 'start' : 'continue', researchId: first['researchId'], question: 'more', topic: 'plan' });
    assert.deepEqual(await replyFor(h, `n${n}`), BLOCKED, `call n${n} is refused`);
    await h.advance(1_000);
  }
  assert.equal(h.dispatches.length, dispatched, 'twenty model calls dispatched nothing');
  // It never speaks: the silence ladder still owns the turn, so the call is rebuilt or ended, never left mute.
  await h.advance(30_000);
  const recovered = h.receipts.some(entry => entry['event'] === 'live_rebuild' || entry['event'] === 'turn_failed')
    || h.owner.get(h.liveSessionId).terminal !== null;
  assert.ok(recovered, `a mute provider is still recovered: ${JSON.stringify(h.receipts.map(entry => entry['event']).filter(name => /dead_air|rebuild|watchdog|debt|turn_failed/u.test(String(name))))}`);
});

test('replay 4: the owner asking for more continues the same run, and the owner stop is always allowed', async t => {
  const h = await harness(t);
  await ownerSays(h);
  await research(h, 'f1', start);
  const first = await replyFor(h, 'f1');
  await speaks(h);
  await ownerSays(h, 'tell me more about that');
  await research(h, 'f2', { action: 'continue', researchId: first['researchId'] });
  const more = await replyFor(h, 'f2');
  assert.notEqual(more['status'], 'blocked', `the owner's follow-up is an admitted operation: ${JSON.stringify(more)}`);
  assert.equal(more['researchId'], first['researchId'], 'and it continues the same run');
  await research(h, 'f3', { action: 'stop', researchId: first['researchId'] });
  const stopped = await replyFor(h, 'f3');
  assert.notEqual(stopped['status'], 'blocked', 'stop needs no owner turn');
});

test('replay 5: an operation whose source stalls returns by its deadline with honest coverage, and the ladder waits for it', async t => {
  const h = await harness(t);
  h.hold();
  await ownerSays(h);
  const askedAt = h.clock.now;
  await research(h, 'd1', start);
  const reply = await replyFor(h, 'd1', OPERATION_DEADLINE_MS + HOST_GRACE_MS);
  const elapsed = h.clock.now - askedAt;
  assert.ok(elapsed <= OPERATION_DEADLINE_MS + HOST_GRACE_MS, `the operation returned by its deadline (${elapsed} ms)`);
  assert.equal(reply['status'], 'partial', `a stalled read is never called complete: ${JSON.stringify(reply)}`);
  const coverage = reply['sourceCoverage'] as Record<string, unknown>[] | undefined;
  const knowledge = coverage?.find(entry => entry['source'] === 'knowledge');
  assert.ok(knowledge, `the reply carries per-source coverage: ${JSON.stringify(reply)}`);
  assert.equal(knowledge!['state'], 'partial');
  assert.equal(knowledge!['examined'], 0, 'nothing arrived, so nothing was examined');
  assert.equal(knowledge!['total'], 'unknown', 'and the total is unknown, never zero');
  assert.equal(rebuilds(h), 0, 'no rebuild fired while the admitted operation was inside its deadline');
  h.release();
  await speaks(h);
  await h.advance(20_000);
  assert.equal(rebuilds(h), 0, 'and none after the compliant answer');
});

test('replay 6: results of an old provider generation reach no new session, and a rebuild grants no research', async t => {
  const h = await harness(t);
  h.hold();
  await ownerSays(h);
  await research(h, 'g1', start);
  await h.advance(500);
  // The provider session dies while the read is in flight; the host opens a new generation.
  h.provider.generations[0]!.die();
  for (let i = 0; i < 40 && h.provider.generations.length < 2; i++) { await flush(); await h.advance(100); }
  assert.equal(h.provider.generations.length, 2, 'the host rebuilt the provider session');
  h.provider.generations[1]!.live();
  await flush();
  h.release();
  await h.advance(8_000);
  assert.equal(h.provider.generations[1]!.toolResponses.flat().some(entry => entry.id === 'g1'), false,
    'the old generation call is never answered into the new session');
  // The rebuilt model reaches for research on its own: nothing the owner said since grants it.
  await research(h, 'g2', { action: 'continue', researchId: '00000000-0000-4000-8000-000000000000' });
  assert.deepEqual(await replyFor(h, 'g2'), BLOCKED, 'a rebuild is not an owner turn');
  await research(h, 'g3', start);
  assert.deepEqual(await replyFor(h, 'g3'), BLOCKED, 'and neither is a replayed opener');
});

// ---- the bounded operation at the research layer: pages, totals and the deadline -------------------------

interface FakeClock { now: () => number; schedule: ResearchTimer; advance: (to: number) => void; at: () => number; set: (to: number) => void }
function fakeClock(): FakeClock {
  let at = 0;
  const timers: { due: number; callback: () => void; done: boolean }[] = [];
  const fire = (): void => {
    for (let guard = 0; guard < 50; guard++) {
      const due = timers.filter(entry => !entry.done && entry.due <= at);
      if (due.length === 0) return;
      for (const entry of due) { entry.done = true; entry.callback(); }
    }
  };
  return {
    now: () => at, at: () => at, set: to => { at = to; },
    schedule: (callback, delayMs) => { const entry = { due: at + delayMs, callback, done: false }; timers.push(entry); return { unref: () => {}, cancel: () => { entry.done = true; } }; },
    advance: to => { at = to; fire(); },
  };
}
const ticks = async (): Promise<void> => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };

const message = (n: number) => ({ id: `m${n}`, threadId: `t${n}`, internalDate: `2026-10-2${n % 9}T10:00:00Z`, line: `- Synthetic message ${n} | from: Synthetic sender [id m${n}]`, bodyTruncated: false });
type MailScript = (page: number, call: IntentSubCall) => Promise<IntentSubResult> | IntentSubResult;
function mailHarness(clock: FakeClock, script: MailScript): { deps: ResearchDeps; pages: () => number } {
  let pages = 0;
  const deps: ResearchDeps = {
    now: clock.now, schedule: clock.schedule, configured: ['mail'], ledger: new ResearchLedger(),
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {}, logFirstAnswer() {}, late() {},
    execute: async subs => Promise.all(subs.map(async call => {
      if (call.name !== 'gmail_search_messages') return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 } as IntentSubResult;
      pages += 1;
      return { ...(await script(pages, call)), key: call.key, name: call.name };
    })),
  };
  return { deps, pages: () => pages };
}
const mailPage = (ids: readonly number[], next?: string, total?: number): IntentSubResult => {
  const messages = ids.map(message);
  return { key: '', name: 'gmail_search_messages', ok: true, text: messages.map(entry => entry.line).join('\n'), originalCharacters: 1, omittedCharacters: 0,
    mailPage: { messages, received: messages.length, invalid: 0, localOmitted: 0, ...(next ? { nextPageToken: next } : {}), ...(total === undefined ? {} : { total }) } } as unknown as IntentSubResult;
};
const coverageOf = (reply: Record<string, unknown>, source: string): Record<string, unknown> | undefined =>
  (reply['sourceCoverage'] as Record<string, unknown>[] | undefined)?.find(entry => entry['source'] === source);
const mailAsk = { action: 'start' as const, question: 'what mail came in', lookups: [{ source: 'mail', query: 'newer_than:2d' }] };

test('replay 7: pages that stall after some succeed return by the deadline with what was examined and the cursor kept', async () => {
  const clock = fakeClock();
  const h = mailHarness(clock, page => page === 1 ? mailPage([1, 2, 3], 'page-2') : new Promise<IntentSubResult>(() => {}));
  const pending = runResearch(h.deps, mailAsk, new AbortController().signal);
  let reply: Record<string, unknown> | undefined;
  void pending.then(value => { reply = value; });
  for (let at = 0; at <= OPERATION_DEADLINE_MS && reply === undefined; at += 250) { await ticks(); clock.advance(at); }
  await ticks();
  assert.ok(reply, 'the operation answered by its deadline although a page never came back');
  const mail = coverageOf(reply!, 'mail');
  assert.ok(mail, `per-source coverage is returned: ${JSON.stringify(reply)}`);
  assert.equal(mail!['examined'], 3, 'the examined count is what arrived');
  assert.equal(mail!['total'], 'unknown', 'a mailbox that was not read to the end has no known total');
  assert.equal(mail!['state'], 'partial');
  assert.equal(mail!['stop'], 'deadline');
  assert.notEqual(mail!['more'], 'none', 'the unread rest stays reachable for an owner follow-up');
});

test('replay 8: a page failure after a success keeps the delivered page and names the stop', async () => {
  const clock = fakeClock();
  const h = mailHarness(clock, page => page === 1 ? mailPage([1, 2, 3], 'page-2')
    : ({ key: '', name: 'gmail_search_messages', ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'upstream_unavailable' } as IntentSubResult));
  const reply = await runResearch(h.deps, mailAsk, new AbortController().signal);
  const mail = coverageOf(reply, 'mail');
  assert.ok(mail, `per-source coverage is returned: ${JSON.stringify(reply)}`);
  assert.equal(mail!['examined'], 3);
  assert.equal(mail!['state'], 'partial');
  assert.equal(mail!['stop'], 'page_failed');
  assert.equal(mail!['represented'], 3, 'every delivered message is in the reply');
  // W5-R2/F3: the header is the field the model repeats aloud, so it never calls a failed page complete.
  const header = String(reply['coverage'] ?? '');
  assert.match(header, /mail partial_failed 3 of 3 shown/u, `the header never calls a failed page complete: ${header}`);
  assert.doesNotMatch(header, /mail complete/u, `the header never calls a failed page complete: ${header}`);
  assert.match(header, /\(say: mail stopped after a later page failed\)/u, `the header says the failure aloud: ${header}`);
});

test('replay 9: overlapping pages are deduplicated and a changing total is reported as changing, never summed', async () => {
  const clock = fakeClock();
  const h = mailHarness(clock, page => page === 1 ? mailPage([1, 2, 3, 4], 'page-2', 40) : mailPage([3, 4, 5, 6], undefined, 38));
  const reply = await runResearch(h.deps, mailAsk, new AbortController().signal);
  const mail = coverageOf(reply, 'mail');
  assert.ok(mail, `per-source coverage is returned: ${JSON.stringify(reply)}`);
  assert.equal(mail!['examined'], 6, 'six distinct messages, never the eight page rows');
  assert.equal(mail!['matches'], 6);
  assert.equal(mail!['total'], 'changing', 'two pages that disagree on the total report a changing total');
  const exhausted = mailHarness(fakeClock(), page => page === 1 ? mailPage([1, 2, 3], 'page-2') : mailPage([2, 3, 4]));
  const read = await runResearch(exhausted.deps, mailAsk, new AbortController().signal);
  assert.equal(coverageOf(read, 'mail'), undefined, 'a mailbox read to its end needs no gap row');
  assert.match(String(read['coverage']), /mail complete 4 of 4 shown/u, 'the header carries the deduplicated count as its total');
});

test('replay 10: no page starts that cannot finish before the deadline', async () => {
  const clock = fakeClock();
  const h = mailHarness(clock, page => {
    // R1: the first page alone takes 8 s, so a second page of the same size cannot finish inside the 15 s
    // patience budget, which is what the page-fit rule is about.
    if (page === 1) { clock.set(clock.at() + 8_000); return mailPage([1, 2], 'page-2'); }
    return mailPage([3, 4]);
  });
  const reply = await runResearch(h.deps, mailAsk, new AbortController().signal);
  assert.equal(h.pages(), 1, 'the second page was never started');
  const mail = coverageOf(reply, 'mail');
  assert.equal(mail?.['stop'], 'deadline');
  assert.equal(mail?.['more'], 'upstream', 'and its cursor is kept for a follow-up');
});

// W5-R3/F4: the host's own deadline reply reads the ledger, so on a start it may name only a run this call
// created. The deadline branch is reachable only when the run never registers before the bound, which no fake at
// the host boundary can stage (the run answers at its first-answer point first), so the decision is pinned here.
test('replay 11: the host deadline reply for a start names only a run this call created', () => {
  assert.equal(deadlineResearchId({}, 'run-earlier', 'run-earlier'), '', "another call's run is never named");
  assert.equal(deadlineResearchId({}, undefined, undefined), '', 'no run at all answers with no run');
  assert.equal(deadlineResearchId({}, 'run-earlier', 'run-new'), 'run-new', 'the run this call created is named');
  assert.equal(deadlineResearchId({ researchId: 'run-named' }, 'run-earlier', 'run-other'), 'run-named', 'a continue keeps the run it named');
});

// L8-06 (verify-8): the web ran 13 of 13 times, yet an early answer said "web skipped_by_route (say: I did not read
// the web this time)" beside pending:["web"], and she told the owner the web did not run. A source still reading
// is said as still reading, never as skipped.
test('L8-06: a web read still running at the first answer is still_reading in the header, never skipped_by_route', async () => {
  const clock = fakeClock();
  const deps: ResearchDeps = {
    now: clock.now, schedule: clock.schedule, configured: ['knowledge'], ledger: new ResearchLedger(),
    emit() {}, log() {}, step() {}, logSource() {}, logSubcall() {}, logRouted() {}, logFirstAnswer() {}, late() {},
    web: { search: () => new Promise(() => {}) },
    execute: async subs => subs.map(call => ({ key: call.key, name: call.name, ok: true, text: '### Synthetic note (DECISION | 2026-10-20) [id 7]\nSynthetic body.', originalCharacters: 40, omittedCharacters: 0 }) as IntentSubResult),
  };
  const pending = runResearch(deps, { action: 'start', question: 'what do we know about the synthetic topic', topic: 'synthetic topic',
    lookups: [{ source: 'knowledge', query: 'synthetic topic' }, { source: 'web', query: 'synthetic topic' }] }, new AbortController().signal);
  let reply: Record<string, unknown> | undefined;
  void pending.then(value => { reply = value; });
  for (let at = 0; at <= OPERATION_DEADLINE_MS && reply === undefined; at += 250) { await ticks(); clock.advance(at); }
  await ticks();
  assert.ok(reply, 'the operation answered');
  assert.deepEqual(reply!['pending'], ['web'], 'the web is named as pending');
  const header = String(reply!['coverage']);
  assert.doesNotMatch(header, /web skipped_by_route/u, `a reading source is never told as skipped (${header})`);
  assert.match(header, /web still_reading/u, `it is told as still reading (${header})`);
});
