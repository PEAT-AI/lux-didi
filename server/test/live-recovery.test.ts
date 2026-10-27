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
  /** C-CONTINUITY R-08: the outcome the session settles with, so a test can hand it a transport receipt. */
  die(drop?: { errorKind: string; closeCode: number | null; closeReason: string; bufferedAmount: number; writesFailed: number; sessionMs: number }): void;
}

/** A port whose every open can be made to die before its ready event, which is the failure at issue (#525). */
function drivenPort() {
  const sessions: DrivenSession[] = [];
  const openedAt: number[] = [];
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
    open(_request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      opens += 1;
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
        die: drop => { rejectReady(new Error('provider setup refused'));
          resolveDone({ status: 'failed', code: 'transport_error', recoverable: true, ...(drop === undefined ? {} : { upstream: drop }) }); end(); },
      });
      openedAt.push(sessions.length);
      return session;
    },
  } as unknown as LiveVoicePort;
  return { port, sessions, openedAt, toolResponses, emit: (event: LiveVoiceEvent) => events({ ...event, sequence: ++sequence }),
    refuse: (...errors: Error[]) => { refusals.push(...errors); }, get opens() { return opens; } };
}

/** Every `tools/call` the fake knowledge connector answered, in order. */
type ConnectorHook = { calls: { name: string; args: Record<string, unknown> | undefined }[]; hold(): void; release(): void;
  /** The run's acceptance the delivery gate reads: `false` refuses the gate for the batches inside the window. */
  authority(up: boolean): void };

/** One fake knowledge connector, its tool call counted: a dispatch the test can see, never a real endpoint. */
async function toolsFixture(t: TestContext, store: Store, profile: ReturnType<typeof validateLiveProfile>): Promise<{ tools: LiveToolsComposition; hook: ConnectorHook }> {
  const schemas = [{ name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, detail: { type: 'string', enum: ['snippets', 'bodies'] }, max_chars: { type: 'integer' }, deadline_ms: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } }];
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
    return { content: [{ type: 'text', text: 'synthetic knowledge answer' }] };
  });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(request);
  });
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10_000, maxSliceBytes: 512 }),
    resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: 12_000, projectionChars: 10, timeoutMs: 5_000 } });
  const toolOwner = createToolsOwner({ grantMode: 'owner-trusted-reads', store, ownerId: store.assistantId, registry, port,
    lookupAuthority: async runId => authorityUp ? ownerRef?.lookupAuthority(runId) ?? ownerRef?.lookupJobAuthority(runId) ?? null : null });
  toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge'], schemaDigest: canonicalToolDigest(schemas),
    sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 80, maxSearchLimit: 8, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
  assert.equal((await port.discover(endpoint.id)).state, 'discovered');
  toolOwner.projectConnection('lux');
  t.after(async () => { await port.close(); await transport.close(); await sdk.close(); });
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

async function harness(t: TestContext): Promise<Harness> {
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
    now: () => clock.now, timeZone: 'Asia/Kolkata', schedule: clock.schedule });
  ownerRef = owner;
  t.after(() => { sink(); ownerRef = undefined; rmSync(dir, { recursive: true, force: true }); });
  return { owner, store, port, clock, ctx, receipts, connectorCalls: hook.calls, holdTool: hook.hold, releaseTool: hook.release, authority: hook.authority,
    advance: async ms => { clock.now += ms; clock.runDue(); await flush(); } };
}

/** The provider session at \`index\`, waiting out its backoff when the host has not opened it yet. */
async function sessionAt(h: Harness, index: number): Promise<DrivenSession | undefined> {
  for (let i = 0; i < 60; i++) { if (h.port.sessions.length > index) return h.port.sessions[index]; await flush(); }
  for (let round = 0; round < 4; round += 1) {
    await h.advance(10_000);
    if (h.port.sessions.length > index) return h.port.sessions[index];
  }
  return undefined;
}

/** The receipt the client reads when the call is over, plus the terminal frame the orb leaves live on. */
async function ended(t: TestContext, attachment: { done: Promise<{ terminal: unknown }>; output: AsyncIterable<{ kind: string; marker?: { kind: string } }> }): Promise<{ terminal: unknown; terminalFrame: boolean }> {
  let terminalFrame = false;
  const reader = (async () => {
    for await (const chunk of attachment.output) {
      if (chunk.kind === 'marker' && chunk.marker?.kind === 'terminal') { terminalFrame = true; return; }
    }
  })();
  const snapshot = await attachment.done;
  await Promise.race([reader, new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
  t.diagnostic('terminal frame delivered');
  return { terminal: snapshot.terminal, terminalFrame };
}

test('#525/L18: a socket that dies right after open keeps reopening inside the 60 s budget, then settles', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'death-loop', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  // The attach is ready only once the provider says ready, so the opening socket goes live first.
  const first = (await sessionAt(h, 0))!;
  first.live();
  await attachment.ready;
  await flush();
  // The session goes live, then dies, and every recovery socket dies before its ready event.
  const dropAt = h.clock.now;
  const died: number[] = [dropAt];
  first.die();
  await flush();
  let index = 1;
  while (h.clock.now - dropAt < 60_000 && index <= 20) {
    // Each attempt pays its backoff (0, 2, 4, 8, then 8 s) before the next socket opens.
    h.clock.now += 8_000; h.clock.runDue();
    await flush();
    if (h.clock.now - dropAt >= 60_000) break;
    const next = await sessionAt(h, index);
    if (!next) break;
    died.push(h.clock.now);
    next.die();
    await flush();
    index += 1;
  }
  // The budget ends the episode on the next attempt after 60 s; let its timer fire.
  for (let round = 0; round < 10; round += 1) { await h.advance(10_000); await flush(); }
  const end = await ended(t, attachment as never);
  assert.ok(died.length > 4, `the old three-attempt cap is gone, got ${died.length} attempts`);
  const recovery = h.receipts.filter(entry => entry['event'] === 'live_recovery');
  assert.ok(recovery.length > 3, 'every attempt is logged');
  assert.deepEqual(recovery.map(entry => entry['code']), recovery.map(() => 'open_failed'), 'each dead socket is a failed attempt, never an opening');
  assert.deepEqual(recovery.map(entry => entry['attempt']), recovery.map((_, position) => position + 1), 'and the count is consecutive');
  assert.ok(recovery.every(entry => typeof entry['msSinceDrop'] === 'number' && Number(entry['msSinceDrop']) >= 0),
    'every line names how long the episode had been running when it opened');
  assert.ok(Number(recovery.at(-1)!['msSinceDrop']) >= 40_000, 'the budget, not a count, is what ended it');
  assert.equal(h.receipts.filter(entry => entry['event'] === 'live_recovery' && entry['code'] === 'opened').length, 0, 'a socket that never said ready is never an opening');
  assert.deepEqual(end.terminal, { state: 'failed', code: 'resume_failed' }, 'the call settles with a visible reason');
  assert.equal(end.terminalFrame, true, 'and the terminal frame reaches the client, so the orb leaves live');
});

test('acceptance 1: an outage that ends at 21 s reopens the call on the next attempt', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'blip-21', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  const first = (await sessionAt(h, 0))!;
  first.live();
  await attachment.ready;
  await flush();
  const dropAt = h.clock.now;
  first.die();
  await flush();
  let index = 1;
  while (h.clock.now - dropAt < 21_000) {
    h.clock.now += 8_000; h.clock.runDue(); await flush();
    if (h.clock.now - dropAt >= 21_000) break;
    const refused = await sessionAt(h, index);
    if (!refused) break;
    refused.die();
    await flush();
    index += 1;
  }
  const back = await sessionAt(h, index);
  assert.ok(back, 'the call reopened after the network returned');
  back!.live();
  await flush();
  assert.ok(!h.owner.get(created.liveSessionId).terminal, 'the call is up, never settled failed');
  const opened = h.receipts.filter(entry => entry['event'] === 'live_recovery' && entry['code'] === 'opened');
  assert.ok(opened.length >= 1, 'the reopen is a receipt');
  assert.ok(Number(opened.at(-1)!['msSinceDrop']) < 60_000, 'and it happened inside the budget');
  h.owner.revoke(created.liveSessionId);
});

test('#527/L18: a long healthy stretch starts a fresh recovery episode after the drop', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'healthy-then-dead', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  // The attach is ready only once the provider says ready, so the opening socket goes live first.
  const first = (await sessionAt(h, 0))!;
  first.live();
  await attachment.ready;
  await flush();
  // 90 s of health, moved without firing the session window: the drop itself is what the host reacts to.
  h.clock.now += 90_000; h.clock.runDue();
  first.die();
  await flush();
  const before = h.receipts.filter(entry => entry['event'] === 'live_recovery').length;
  const next = (await sessionAt(h, 1))!;
  next.die();
  await flush();
  h.clock.now += 8_000; h.clock.runDue();
  await flush();
  const recovery = h.receipts.filter(entry => entry['event'] === 'live_recovery').slice(before);
  assert.equal(recovery[0]?.['msSinceDrop'], 0, 'the healthy stretch cleared the episode, so the drop starts at zero');
  const terminal = h.owner.get(created.liveSessionId).terminal;
  assert.ok(!terminal, 'two dead recoveries after a healthy stretch do not end the call');
  h.owner.revoke(created.liveSessionId);
  void attachment;
});

/** Wait until the host has answered the model this many times. */
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

test('F1: a research call after a rebuild reaches the connector instead of being denied', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'research-rebuild', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  const first = (await sessionAt(h, 0))!;
  first.live();
  await attachment.ready;
  await flush();
  await ownerSpoke(h);
  // One lookup runs on generation 0, which is where the session's research scheduler is built.
  h.port.emit(research('r0'));
  await answered(h, 1);
  // The socket dies and the host rebuilds it: the session is now generation 1.
  first.die();
  await flush();
  const second = (await sessionAt(h, 1))!;
  second.live();
  await flush();
  await ownerSpoke(h, 'what do we know about the budget');
  h.port.emit(research('r1', 'what do we know about the budget'));
  await answered(h, 2);
  const reply = h.port.toolResponses[1]![0]!;
  const seen = JSON.stringify({ reply: reply.response, connectorCalls: h.connectorCalls, receipts: h.receipts.filter(entry => String(entry['event']).startsWith('research')).slice(-6) });
  assert.notEqual(reply.response['error'], 'tool_result_denied', `the rebuilt session runs its lookup: ${seen}`);
  assert.equal(h.connectorCalls.filter(call => call.name === 'search_knowledge').length, 2, `both lookups dispatched to the connector: ${seen}`);
});

test('F1: a lookup refused before the owner spoke never poisons the session', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'research-opener', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  (await sessionAt(h, 0))!.live();
  await attachment.ready;
  await flush();
  h.port.emit(research('r0'));
  await answered(h, 1);
  assert.equal(h.port.toolResponses[0]![0]!.response['error'], 'opener_not_fetched', 'the opener lookup is refused, never dispatched');
  assert.equal(h.connectorCalls.length, 0, 'the refused opener reached no connector');
  await ownerSpoke(h, 'what do we know about the budget');
  h.port.emit(research('r1', 'what do we know about the budget'));
  await answered(h, 2);
  const reply = h.port.toolResponses[1]![0]!;
  const seen = JSON.stringify({ reply: reply.response, connectorCalls: h.connectorCalls, receipts: h.receipts.filter(entry => String(entry['event']).startsWith('research')).slice(-6) });
  assert.notEqual(reply.response['error'], 'tool_result_denied', `the next lookup runs on the same session: ${seen}`);
  assert.ok(h.connectorCalls.some(call => call.name === 'search_knowledge'), `the second lookup dispatched to the connector: ${seen}`);
});

test('F5/F3: tool_output_sent measures the span from the frame that asked for it', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'tool-latency', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  (await sessionAt(h, 0))!.live();
  await attachment.ready;
  await flush();
  h.holdTool();
  h.port.emit({ type: 'toolCall', calls: [{ id: 'k1', name: 'search_knowledge', args: { query: 'plan', limit: 3 } }], sequence: 0 } as LiveVoiceEvent);
  await flush();
  await h.advance(1_200);
  h.releaseTool();
  await answered(h, 1);
  const receipt = h.receipts.find(entry => entry['event'] === 'tool_output_sent');
  assert.ok(receipt, 'the output write was receipted');
  assert.equal(receipt['msSinceArrived'], 1_200, 'the span is measured from the call that arrived, not from a lost clock');
});

test('F1: a lookup the gate denied never withholds the next allowed one', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'research-gate', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  (await sessionAt(h, 0))!.live();
  await attachment.ready;
  await flush();
  await ownerSpoke(h);
  // The delivery gate refuses every dispatch of this batch: the run answers with nothing fetched.
  h.authority(false);
  h.port.emit(research('r0'));
  await answered(h, 1);
  assert.equal(h.connectorCalls.length, 0, 'the refused batch reached no connector');
  // The gate is healthy again, and the owner asks something new: this lookup must be able to dispatch.
  h.authority(true);
  await ownerSpoke(h, 'what do we know about the budget');
  h.port.emit(research('r1', 'what do we know about the budget'));
  await answered(h, 2);
  assert.equal(h.connectorCalls.filter(call => call.name === 'search_knowledge').length, 1,
    'the allowed lookup dispatched even though the batch that built the scheduler was denied');
});

// C-LIVE R2: a recovery open that throws is logged by class and closed key, then gets one fresh open after a short
// backoff; a second failure ends the call with a terminal the client can read, and the next call starts clean.

test('R2: a recovery open that throws logs its class and tries one fresh open after a short backoff', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'r2-retry', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  (await sessionAt(h, 0))!.live();
  await attachment.ready;
  await flush();
  h.port.refuse(new TypeError('synthetic_open_refused'));
  h.port.sessions[0]!.die();
  await flush();
  const failure = h.receipts.find(entry => entry['event'] === 'live_recovery_failed');
  assert.ok(failure, `the thrown open is a receipt, never swallowed: ${JSON.stringify(h.receipts.map(entry => entry['event']))}`);
  assert.equal(failure!['errorClass'], 'TypeError');
  assert.equal(failure!['messageKey'], 'synthetic_open_refused');
  assert.equal(failure!['liveSessionId'], created.liveSessionId, 'the session correlation id rides with it');
  assert.equal(failure!['cause'], 'transport_error', 'and the cause that started the recovery');
  assert.ok(['resume', 'fresh_seeded'].includes(String(failure!['mode'])), 'and the recovery mode');
  assert.equal(h.owner.get(created.liveSessionId).terminal, null, 'one refused open does not end the call');
  const opensBefore = h.port.opens;
  await h.advance(2_000);
  assert.equal(h.port.opens, opensBefore + 1, 'one fresh open follows the short backoff');
  h.port.sessions.at(-1)!.live();
  await flush();
  assert.equal(h.owner.get(created.liveSessionId).terminal, null, 'and the call carries on');
  h.owner.revoke(created.liveSessionId);
});

test('R2: when the fresh open fails too, the call ends as provider_recovery_exhausted and the next call starts clean', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'r2-exhausted', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  (await sessionAt(h, 0))!.live();
  await attachment.ready;
  await flush();
  h.port.refuse(new Error('synthetic open refused with words'), new TypeError('synthetic_open_refused'));
  h.port.sessions[0]!.die();
  await flush();
  await h.advance(2_000);
  await h.advance(2_000);
  const end = await ended(t, attachment as never);
  assert.deepEqual(end.terminal, { state: 'failed', code: 'provider_recovery_exhausted' }, 'the end names the exhausted recovery');
  assert.equal(end.terminalFrame, true, 'the client hears the terminal before the socket closes');
  const failures = h.receipts.filter(entry => entry['event'] === 'live_recovery_failed');
  assert.equal(failures.length, 2, 'both refused opens are receipts');
  assert.equal(failures[0]!['messageKey'], 'unrecognized', 'a free-text message never reaches the log');
  assert.equal(h.port.opens, 3, 'the first open, the refused recovery and the one fresh retry: no loop');
  const next = h.owner.create({ idempotencyKey: 'r2-next', inputClass: 'ordinary' }, h.ctx);
  const again = h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  (await sessionAt(h, 1))!.live();
  await again.ready;
  assert.equal(h.owner.get(next.liveSessionId).lifecycle, 'active', 'the next attach starts clean');
  h.owner.revoke(next.liveSessionId);
});

// C-CONTINUITY R-02/R-08/R-09: a rebuild that follows a transport drop reads its cause, its close code and its
// sanitized reason off the receipt the adapter left, so `cause=network` is evidence and not a label.
test('C-CONTINUITY R-02: a rebuild after a transport drop logs cause=network with its close code and reason', async t => {
  const h = await harness(t);
  const created = h.owner.create({ idempotencyKey: 'continuity-drop', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  const first = (await sessionAt(h, 0))!;
  first.live();
  await attachment.ready;
  await flush();
  first.die({ errorKind: 'write_error', closeCode: 1006, closeReason: 'upstream reset', bufferedAmount: 0, writesFailed: 1, sessionMs: 900 });
  await flush();
  // The recovery line is written once the new socket is live, so the fixture takes it past its ready event.
  for (let round = 0; round < 12 && h.port.sessions.length < 2; round += 1) await flush();
  const second = await sessionAt(h, 1);
  assert.ok(second !== undefined, 'the host opened a second provider session');
  second.live();
  await flush();
  const rebuilds = h.receipts.filter(entry => entry['event'] === 'live_rebuild');
  assert.ok(rebuilds.length >= 1, 'the drop rebuilt the session');
  const rebuild = rebuilds[0]!;
  assert.equal(rebuild['trigger'], 'line_dropped', 'a transport drop is a line drop');
  assert.equal(rebuild['cause'], 'network', 'and its cause is the network, because a transport receipt exists');
  assert.equal(rebuild['closeCode'], 1006, 'the close code rides the rebuild line');
  assert.equal(rebuild['closeReason'], 'upstream reset', 'and so does its sanitized reason');
  const recovery = h.receipts.find(entry => entry['event'] === 'live_recovery');
  assert.ok(recovery !== undefined, 'and the recovery line is written');
  assert.equal(recovery['cause'], 'network');
  assert.equal(recovery['closeReason'], 'upstream reset', 'the recovery line carries the same reason');
});
