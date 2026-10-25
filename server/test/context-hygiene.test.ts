import assert from 'node:assert/strict';
import assert_ from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import type { LiveToolsComposition } from '../live/types.js';
import { liveProfileIdentity } from '../live/config.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import type { LiveToolResponse, LiveVoiceControl, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession } from '../adapters/live-voice/index.js';

import {
  RESEARCH, ResearchLedger, researchLedgerOf, researchRebuildAllowed, researchRebuildDue, researchRebuildStep, retainedAfterSend, runResearch,
} from '../tools/research.js';
import type { ResearchBoundary, ResearchRetention, ResearchDeps } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/live-recovery-test';
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** A clock the test moves itself: no test sleeps and no timer fires on its own. */
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
      const entry = [...this.pending].find(item => item.due <= this.now);
      if (!entry) return;
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

/** One provider session the test drives: it never becomes ready and dies on its own, or it goes live. */
interface DrivenSession {
  live(): void;
  die(): void;
}

/** A port whose every open can be made to die before its ready event, which is the failure at issue (#525). */
function drivenPort() {
  const sessions: DrivenSession[] = [];
  const openedAt: number[] = [];
  const requests: LiveVoiceRequest[] = [];
  const toolResponses: LiveToolResponse[][] = [];
  let events: ((event: LiveVoiceEvent) => void) = () => {};
  let sequence = 0;
  /** C-LIVE R2: opens the provider refuses synchronously, the way the 2026-10-25 rebuild threw before its socket. */
  const refusals: Error[] = [];
  let opens = 0;
  const port = {
    capabilities: Object.freeze({ provider: 'gemini', supportsResumption: false, supportsGoAway: false, supportsInterruption: false,
      supportsServerVadConfig: false, inputRates: Object.freeze([8000]), outputRates: Object.freeze([24000]),
      outputModalities: Object.freeze(['audio', 'text'] as const), thinking: 'provider_default', supportsToolScheduling: false,
      toleratesEmptyReadyLifecycle: false }),
    open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      opens += 1;
      requests.push(request);
      const refusal = refusals.shift();
      if (refusal !== undefined) throw refusal;
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
        sendAudio(): void {}, sendText(): void {}, endAudioStream(): void {},
        sendToolResponse(input): 'sent' { toolResponses.push([...input.responses]); return 'sent'; },
        close(): void { if (ended) return; end(); resolveDone({ status: 'cancelled', code: 'cancelled' }); },
      };
      control.signal.addEventListener('abort', () => { if (ended) return; end(); resolveDone({ status: 'cancelled', code: 'cancelled' }); }, { once: true });
      sessions.push({
        live: () => { events({ sequence: ++sequence, type: 'ready' } as LiveVoiceEvent); resolveReady(); },
        die: () => { rejectReady(new Error('provider setup refused')); resolveDone({ status: 'failed', code: 'transport_error', recoverable: true }); end(); },
      });
      openedAt.push(sessions.length);
      return session;
    },
  } as unknown as LiveVoicePort;
  return { port, sessions, openedAt, requests, toolResponses, emit: (event: LiveVoiceEvent) => events({ ...event, sequence: ++sequence }),
    refuse: (...errors: Error[]) => { refusals.push(...errors); }, get opens() { return opens; } };
}

/** Every `tools/call` the fake knowledge connector answered, in order. */
type ConnectorHook = { calls: { name: string; args: Record<string, unknown> | undefined }[]; hold(): void; release(): void;
  /** The run's acceptance the delivery gate reads: `false` refuses the gate for the batches inside the window. */
  authority(up: boolean): void };

/** One fake knowledge connector, its tool call counted: a dispatch the test can see, never a real endpoint. */
/** What the fake knowledge connector answers, in the ranker's own line shape, so the read parses it as hits. */
const answer = { lines: 12, body: 170 };
function knowledgeFixture(): string {
  const hit = (i: number): string => [
    `**#${1000 + i}** [PATTERN] Clifton StrengthsFinder profile ${1000 + i} of the audit team`,
    `[Evidence](https://example.com/${1000 + i})`,
    `the audit team strengths are Achiever, Learner and Input, dated 2026-10-${String((i % 28) + 1).padStart(2, '0')}. ${'more evidence about the team and its plan. '.repeat(4)}`,
  ].join('\n');
  return ['# Knowledge Search', '_confidence: medium \u00b7 mode: reranked \u00b7 top score: 0.37 \u00b7 relevant candidate: yes_',
    ...Array.from({ length: answer.lines }, (_, i) => hit(i))].join('\n');
}
function bodyFixture(id: string): string {
  return `### Clifton profile ${id} (PATTERN | 2026-10-19) [id ${id}] ${'detail of the full entry. '.repeat(answer.body)}`;
}

async function toolsFixture(t: TestContext, store: Store, profile: ReturnType<typeof validateLiveProfile>): Promise<{ tools: LiveToolsComposition; hook: ConnectorHook }> {
  const schemas = [{ name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, detail: { type: 'string', enum: ['snippets', 'bodies'] }, max_chars: { type: 'integer' }, deadline_ms: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } }, { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'], additionalProperties: false } }];
  const calls: ConnectorHook['calls'] = [];
  let authorityUp = true;
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const registry = new McpRegistry();
  const endpoint = { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'account', resource: 'resource' };
  registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const sdk = new Server({ name: 'live-recovery-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(schemas) }) as never);
  sdk.setRequestHandler('tools/call', async request => {
    calls.push({ name: request.params.name, args: request.params.arguments });
    if (held !== undefined) await held;
    if (request.params.name === 'get_insight') return { content: [{ type: 'text', text: bodyFixture(String((request.params.arguments as { ids?: string[] })?.ids?.[0] ?? '1000')) }] };
    return { content: [{ type: 'text', text: knowledgeFixture() }] };
  });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(request);
  });
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10_000, maxSliceBytes: 512 }),
    resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: 200_000, projectionChars: 20_000, timeoutMs: 5_000 } });
  const toolOwner = createToolsOwner({ store, ownerId: store.assistantId, registry, port,
    lookupAuthority: async runId => authorityUp ? ownerRef?.lookupAuthority(runId) ?? ownerRef?.lookupJobAuthority(runId) ?? null : null });
  toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(schemas),
    sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 8, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 200_000 } });
  assert.equal((await port.discover(endpoint.id)).state, 'discovered');
  toolOwner.projectConnection('lux');
  t.after(async () => { await port.close(); });
  return { tools: { owner: toolOwner, connectionIds: () => ['lux'] },
    hook: { calls, hold: () => { held = new Promise<void>(resolve => { release = resolve; }); },
      release: () => { held = undefined; release?.(); release = undefined; }, authority: up => { authorityUp = up; } } };
}

let ownerRef: LiveSessionOwner | undefined;

interface Harness {
  owner: LiveSessionOwner; store: Store; port: ReturnType<typeof drivenPort>; clock: DeadlineClock; ctx: LiveContext;
  receipts: Record<string, unknown>[];
  advance(ms: number): Promise<void>;
  /** Every `tools/call` the fake knowledge connector answered, in order. */
  connectorCalls: { name: string; args: Record<string, unknown> | undefined }[];
  /** Held while set: the fake connector's next answer waits for `releaseTool`. */
  holdTool(): void;
  releaseTool(): void;
  /** Withhold or restore the run acceptance the delivery gate reads, for one batch window. */
  authority(up: boolean): void;
}

async function harness(t: TestContext, options: { rebuildThresholdChars?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-recovery-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const clock = new DeadlineClock();
  const port = drivenPort();
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const { tools, hook } = await toolsFixture(t, store, profile);
  const owner = createLiveSessionOwner({ store, voice: port.port, profile, tools,
    now: () => clock.now, timeZone: 'Asia/Kolkata', schedule: clock.schedule, ...options });
  ownerRef = owner;
  t.after(() => { sink(); ownerRef = undefined; rmSync(dir, { recursive: true, force: true }); });
  return { owner, store, port, clock, ctx, receipts, connectorCalls: hook.calls, holdTool: hook.hold, releaseTool: hook.release, authority: hook.authority,
    advance: async ms => { clock.now += ms; clock.runDue(); await flush(); } };
}
async function sessionAt(h: Harness, index: number): Promise<DrivenSession | undefined> {
  for (let i = 0; i < 60; i++) { if (h.port.sessions.length > index) return h.port.sessions[index]; await flush(); }
  for (let round = 0; round < 4; round += 1) {
    await h.advance(10_000);
    if (h.port.sessions.length > index) return h.port.sessions[index];
  }
  return undefined;
}

async function answered(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < 2000 && h.port.toolResponses.length < count; i++) await flush();
  assert.equal(h.port.toolResponses.length, count, 'the host answered the model');
}

async function ownerSpoke(h: Harness, text = 'what do we know about the plan'): Promise<void> {
  h.port.emit({ type: 'inputTranscription', text, finished: true, sequence: 0 } as LiveVoiceEvent);
  await flush();
}

/** One lookup question per call, so a repeat never hits the session's answer cache instead of the loop. */
const research = (id: string, question = 'what do we know about the plan'): LiveVoiceEvent => ({
  type: 'toolCall', calls: [{ id, name: 'research', args: { action: 'start', question, topic: question } }], sequence: 0,
}) as LiveVoiceEvent;

/** C-DEPTH item 5 (W10-R15 P1): the rebuild driven through the real live layer and a fake provider. */

const turnComplete = { type: 'turnComplete' } as LiveVoiceEvent;
const REBUILD = 'research_context_rebuild';
/**
 * W10-R20: the replay injects the rebuild threshold, so one read that a live knowledge ask really answers
 * can cross it. Production keeps `RESEARCH.rebuildThresholdChars`; the shipped constant is never changed.
 */
const CROSSED = 400;

function rebuilds(h: Harness): Record<string, unknown>[] {
  return h.receipts.filter(entry => entry['event'] === REBUILD);
}

/** The research text the provider was actually sent, which is what the host counts as retained. */
function sent(h: Harness, index: number): string {
  return JSON.stringify(h.port.toolResponses[index] ?? []);
}

/** A live session on the fake provider, ready and past the owner's first words. */
async function live(t: TestContext, rebuildThresholdChars: number): Promise<Harness> {
  const h = await harness(t, { rebuildThresholdChars });
  const created = h.owner.create({ idempotencyKey: `hygiene-${randomUUID()}`, inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  const first = (await sessionAt(h, 0))!;
  first.live();
  await attachment.ready;
  await flush();
  await ownerSpoke(h);
  return h;
}

/** One research answer, on a question that names the entity the fake knowledge read answers for. */
async function oneRead(h: Harness, id = 'r0', question = 'Clifton strengths profile of the audit team'): Promise<void> {
  const before = h.port.toolResponses.length;
  h.port.emit(research(id, question));
  await answered(h, before + 1);
}

test('HYGIENE 10: nothing is rebuilt while the retained research stays under the threshold', async t => {
  const h = await live(t, 50_000);
  await oneRead(h);
  assert.ok(sent(h, 0).length < 50_000, `one answer is under an unreachable threshold, was ${sent(h, 0).length}`);
  h.port.emit(turnComplete);
  await flush();
  assert.deepEqual(rebuilds(h), [], 'no rebuild under the threshold');
  assert.equal(h.port.openedAt.length, 1, 'and the provider session was not reopened');
});

test('HYGIENE 11: exactly one rebuild, at the first safe boundary above the threshold', async t => {
  const h = await live(t, CROSSED);
  await oneRead(h);
  assert.ok(sent(h, 0).length > CROSSED, `the answer the host sent passes the injected threshold, was ${sent(h, 0).length}`);
  assert.equal(rebuilds(h).length, 0, 'no rebuild happened inside a response');
  h.port.emit(turnComplete);
  await flush();
  assert.equal(rebuilds(h).length, 1, 'the first boundary past the threshold rebuilds once');
  assert.equal(h.port.openedAt.length, 2, 'on one fresh provider session');
  h.port.emit(turnComplete);
  await flush();
  assert.equal(rebuilds(h).length, 1, 'and a later boundary does not rebuild again');
  assert.equal(h.port.openedAt.length, 2);
});

test('HYGIENE 12: a boundary during a tool call defers the rebuild to the next boundary', async t => {
  const h = await live(t, CROSSED);
  await oneRead(h);
  h.holdTool();
  h.port.emit(research('r1', 'who owns the audit plan'));
  await flush();
  h.port.emit(turnComplete);
  await flush();
  assert.equal(rebuilds(h).length, 0, 'nothing is rebuilt while a tool call is in flight');
  assert.equal(h.port.openedAt.length, 1, 'and the session in flight is untouched');
  h.releaseTool();
  await answered(h, 2);
  h.port.emit(turnComplete);
  await flush();
  assert.equal(rebuilds(h).length, 1, 'the deferred rebuild happens at the later boundary');
  assert.equal(h.port.openedAt.length, 2);
});

test('HYGIENE 13: the seed is one turn carrying the asked entities and the held hit ids', async t => {
  const h = await live(t, CROSSED);
  await oneRead(h);
  h.port.emit(turnComplete);
  await flush();
  const reopened = h.port.requests[1];
  assert.ok(reopened !== undefined, 'a fresh provider session was opened');
  const history = reopened.history ?? [];
  assert.equal(history.length, 1, 'the ledger seed is exactly one turn');
  assert.equal(history[0]!.role, 'user');
  const seed = history[0]!.text;
  // W10-R20: the entity clause holds once a read's findings carry the asked name; the id clause is
  // what this read can prove, and HYGIENE 4 proves the entity line on a run that supplies the names.
  assert.match(seed, /1000/u, 'the held hit id is in the seed');
  assert.ok(seed.length <= 6_000, `the ledger is capped at 6,000 chars, was ${seed.length}`);
});

test('HYGIENE 14: a follow-up after the rebuild reaches the connector again', async t => {
  const h = await live(t, CROSSED);
  await oneRead(h);
  h.port.emit(turnComplete);
  await flush();
  assert.equal(rebuilds(h).length, 1, 'the rebuild happened first');
  const before = h.connectorCalls.length;
  await oneRead(h, 'r9', 'Clifton strengths profile of the audit follow up');
  assert.equal(h.connectorCalls.length, before + 1, 'the rebuilt session read the connector again');
});

/** C-DEPTH item 5 (W10-R2 light C): the retained payload, the safe boundary and the ledger a rebuild seeds. */

const EMPTY: ResearchRetention = { retainedChars: 0, rebuilds: 0 };
const SAFE: ResearchBoundary = { assistantAudioStreaming: false, responsePending: false, bargeIn: false, toolInFlight: false };

test('HYGIENE 1: nothing is rebuilt under the threshold, and the first answer past it is due', () => {
  assert.equal(researchRebuildDue(EMPTY), false, 'a fresh call owns nothing');
  assert.equal(researchRebuildDue({ retainedChars: RESEARCH.rebuildThresholdChars, rebuilds: 0 }), false,
    'exactly at the threshold the call still reads its own evidence');
  assert.equal(researchRebuildDue({ retainedChars: RESEARCH.rebuildThresholdChars + 1, rebuilds: 0 }), true,
    'one char past it and the rebuild is due');
  assert.equal(RESEARCH.rebuildThresholdChars, 24_000, 'the threshold W10-R2 set');
});

test('HYGIENE 2: the count is what was sent, and a rebuild starts it again at zero', () => {
  let retention = retainedAfterSend(EMPTY, 12_000);
  assert.equal(researchRebuildDue(retention), false, 'one full default answer is still under');
  retention = retainedAfterSend(retention, 12_000);
  assert.equal(researchRebuildDue(retention), false, 'two of them sit exactly on the threshold, which is still under it');
  retention = retainedAfterSend(retention, 1);
  assert.equal(researchRebuildDue(retention), true, 'the next character sent crosses it');
  assert.deepEqual({ ...retention, retainedChars: 0, rebuilds: retention.rebuilds + 1 },
    { retainedChars: 0, rebuilds: 1, }, 'the rebuild the host runs resets the count and records itself');
  assert.equal(researchRebuildDue({ retainedChars: 0, rebuilds: 1 }), false, 'and the next answer starts over');
});

test('HYGIENE 3: no rebuild while audio streams, a response is pending, a barge in runs or a tool is in flight', () => {
  assert.equal(researchRebuildAllowed(SAFE), true, 'a quiet call is the safe boundary');
  for (const fact of ['assistantAudioStreaming', 'responsePending', 'bargeIn', 'toolInFlight'] as const) {
    assert.equal(researchRebuildAllowed({ ...SAFE, [fact]: true }), false, `${fact} holds the rebuild`);
  }
});

test('HYGIENE 4: the ledger carries the asked entities, the source ids, the dates and the cursors', () => {
  const ledger = researchLedgerOf({
    question: 'what do we know about Ana, Ben and Cara Clifton',
    findings: [
      { source: 'knowledge', text: 'knowledge: 3 of 3 shown\n### Ana Clifton (person | 2026-09-14) [id 301]\n### Ben Clifton (person | 2026-09-02) [id 302]' },
      { source: 'mail', text: 'mail: 1 of 2 shown\n- Release note | from: Ana | date: 2026-10-16 [id m1]' },
    ],
    cursors: ['mail:next:abc'],
  });
  assert.match(ledger, /entities: Ana, Ben, Cara, Clifton/u, 'the people the owner asked for are named');
  assert.match(ledger, /knowledge: 3 held, ids 301,302/u, 'the knowledge ids a follow up can read again');
  assert.match(ledger, /dates 2026-09-14,2026-09-02/u, 'the dates the evidence carries');
  assert.match(ledger, /cursors: mail:next:abc/u, 'the cursor that recovers the body');
  assert.match(ledger, /no evidence for Cara/u, 'a gap is named, never invented');
  assert.ok(ledger.length <= RESEARCH.ledgerChars, `the ledger fits its own bound: ${ledger.length}`);
});

test('HYGIENE 5: the ledger never exceeds its bound, and it is deterministic', () => {
  const findings = Array.from({ length: 400 }, (_v, index) => ({
    source: 'knowledge',
    text: `knowledge: 1 of 1 shown\n### Entry ${index} (decision | 2026-10-17) [id ${index}] ${'detail '.repeat(200)}`,
  }));
  const input = { question: 'what did we decide about the release', findings, cursors: [] };
  const first = researchLedgerOf(input);
  assert.ok(first.length <= RESEARCH.ledgerChars, `a huge call still fits its ledger: ${first.length}`);
  assert.equal(researchLedgerOf(input), first, 'no model call, so the same input is the same ledger');
});

function sub(name: string, text: string, key = name): IntentSubResult {
  return { key, name, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 };
}

test('HYGIENE 6 (J2): a fetch that misses its bound still delivers the summaries, and the header says excerpt', async () => {
  // A fake clock, no real wait: the stage two bound is zero, so the bounded read aborts at once.
  const summaries = Array.from({ length: 40 }, (_v, index) =>
    `### Ana Clifton entry ${index} (person | 2026-09-14) [id ${300 + index}] ${'summary detail '.repeat(8)}`).join('\n');
  const executed: string[] = [];
  const deps: ResearchDeps = {
    now: () => 0,
    configured: ['knowledge'] as const,
    knowledgeReadMs: 0,
    execute: async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push(call.name);
      if (subs.every(call => call.name === 'get_insight')) {
        // The slow fetch: it never answers inside the bound.
        await new Promise(resolve => setTimeout(resolve, 10));
        return subs.map(call => sub(call.name, '', call.key));
      }
      return subs.map(call => sub(call.name, summaries, call.key));
    },
    emit: () => {},
    log: () => {},
    ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what do we know about Ana Clifton',
    lookups: [{ source: 'knowledge', query: 'Clifton' }],
  }, new AbortController().signal);
  assert_ok(executed.includes('search_knowledge'), 'the search happened');
  const evidence = ((reply['findings'] ?? []) as { text: string }[]).map(finding => finding.text).join('\n');
  assert_ok(evidence.includes('Ana Clifton'), 'the summaries are delivered when the fetch cannot finish');
  assert_ok(String(reply['coverage']).includes('excerpt'), `the header says the source is an excerpt: ${String(reply['coverage'])}`);
});

function assert_ok(value: unknown, message: string): void { assert_(value, message); }

test('HYGIENE 7 (W10-R15 P2): the seed and the count are reset only on the branch that really rebuilds', () => {
  const due: ResearchRetention = { retainedChars: 26_000, rebuilds: 1 };
  const safe: ResearchBoundary = { ...SAFE };
  const kept = researchRebuildStep(due, 4_000, safe, 30_000, 30_000);
  assert.equal(kept.action, 'rebuild', 'a safe boundary with budget rebuilds');
  assert.deepEqual(kept.retention, { retainedChars: 0, rebuilds: 2 }, 'and only then the count restarts');
  const outOfTime = researchRebuildStep(due, 4_000, safe, 0, 30_000);
  assert.equal(outOfTime.action, 'defer', 'a deadline miss defers');
  assert.deepEqual(outOfTime.retention, due, 'and never drops the count or the seed');
  assert.equal(outOfTime.seedChars, 4_000, 'the seed is still there for the next boundary');
  const outOfIdle = researchRebuildStep(due, 4_000, safe, 30_000, -1);
  assert.equal(outOfIdle.action, 'defer', 'an idle miss defers too');
  assert.deepEqual(outOfIdle.retention, due, 'with the count untouched');
  const busy = researchRebuildStep(due, 4_000, { ...SAFE, responsePending: true }, 30_000, 30_000);
  assert.equal(busy.action, 'defer', 'a pending response defers');
  assert.deepEqual(busy.retention, due, 'and the count is untouched');
});
