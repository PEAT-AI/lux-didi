import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { OpenAiLiveVoiceAdapter } from '../../adapters/live-voice/index.js';
import type { LiveVoiceClock, LiveVoicePort } from '../../adapters/live-voice/index.js';
import { chatMigrations } from '../../chat/index.js';
import { domainMigrations } from '../../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, liveProfileIdentity, validateLiveProfile } from '../../live/index.js';
import type { LiveContext, LiveSessionOwner } from '../../live/index.js';
import { Store } from '../../runtime/store.js';
import { fixture } from '../openai-live-voice-fixture.js';
import { replayTools, toolsMigrations } from './tools.js';
import type { ToolScript } from './tools.js';
import { analyse } from './invariants.js';
import type { Violations } from './invariants.js';

/**
 * The fault-replay driver: the real OpenAI adapter and the real host live session, driven together over a
 * virtual monotonic clock, against a scriptable fake provider socket and scriptable fake tools. No wall
 * sleep, no real provider, no network beyond loopback.
 *
 * Every observation the scenarios assert on is recorded here rather than asserted in place: the outbound
 * command log, the obligation ledger, the orb-state projection timeline and the playback receipts.
 */

/** One trace entry. `direction` is `in` (provider to host), `client` (the driver acts as the owner's app)
 *  or `out` (a recorded adapter command, present only in a recording, never replayed as an input). */
export interface TraceStep { readonly at_ms: number; readonly direction: 'in' | 'client' | 'out'; readonly event: Record<string, unknown> }
export interface Trace {
  readonly scenario: string; readonly deadline_ms: number; readonly steps: readonly TraceStep[];
  /** What the provider does after it reconnects: the host's recovery path, scripted, so a fault is the only fault. */
  readonly recovery?: readonly TraceStep[];
}

export interface Command { readonly seq: number; readonly at: number; readonly type: string; readonly frame: Record<string, unknown>; readonly epoch: number }
export interface Projection { readonly at: number; readonly cause: string; readonly state: string; readonly lifecycle: string }
export interface Receipt { readonly at: number; readonly bytes: number; readonly durationMs: number }
export interface CallObligation {
  readonly callId: string; readonly name: string; readonly at: number; readonly epoch: number;
  /** The delegation whose response emitted the call: a continuation waits for every call of that delegation. */
  readonly delegationId: string;
  outputs: Command[]; terminal: 'answer' | 'error' | 'timeout' | 'cancelled' | undefined;
  continuation: Command | undefined; deliveryAt: number | undefined;
}

/** A virtual monotonic clock without wall sleeps: the one timer queue both the adapter and the host use. */
export class ReplayClock implements LiveVoiceClock {
  readonly #start: number;
  #time: number;
  #next = 1;
  #timers: { id: number; at: number; fire: () => void }[] = [];
  /** Real epoch at construction: the adapter measures its own transport deadline against `Date.now()`, so the
   *  virtual origin is anchored near the real clock and never overtakes it by more than a scenario. */
  constructor() { this.#start = Date.now(); this.#time = this.#start; }
  now(): number { return this.#time; }
  get startedAt(): number { return this.#start; }
  setTimer(ms: number, fire: () => void): unknown {
    const id = this.#next; this.#next += 1;
    this.#timers.push({ id, at: this.#time + Math.max(0, Math.ceil(ms)), fire });
    return id;
  }
  clearTimer(handle: unknown): void { this.#timers = this.#timers.filter(timer => timer.id !== handle); }
  schedule(callback: () => void, delayMs: number): { unref(): void; cancel(): void } {
    const handle = this.setTimer(delayMs, callback);
    return { unref() {}, cancel: () => this.clearTimer(handle) };
  }
  get pending(): number { return this.#timers.length; }
  /** Notified after every timer this clock fires, so the driver can sample the orb between steps. */
  onFire: (() => void) | undefined;
  /** Fire every timer due at or before `target` in (time, id) order, then land on `target`. */
  async advanceTo(target: number, flush: () => Promise<void>): Promise<void> {
    for (;;) {
      const due = this.#timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.#timers = this.#timers.filter(timer => timer !== due);
      this.#time = Math.max(this.#time, due.at);
      due.fire();
      await flush();
      this.onFire?.();
    }
    this.#time = Math.max(this.#time, target);
    await flush();
  }
}

export interface ReplayOptions {
  /** The session ceiling the host enforces, in virtual ms. */
  callMaxMs?: number;
  /** Whether the host gets a scripted tool composition; absent means the adapter's tool turns are refused. */
  tools?: boolean;
  /** The per-call tool scripts, in call order. */
  scripts?: readonly ToolScript[];
  /** A scripted owner utterance: the driver appends the audio and closes the input episode. */
  idempotencyKey?: string;
}

export interface Replay {
  readonly clock: ReplayClock;
  readonly owner: LiveSessionOwner;
  readonly store: Store;
  readonly liveSessionId: string;
  readonly providerFrames: readonly Command[];
  readonly commands: readonly Command[];
  readonly projections: readonly Projection[];
  readonly receipts: readonly Receipt[];
  /** Fill frames the host forwarded to playback; heard by nobody, so never a delivery. */
  readonly inaudibleFrames: number;
  /** The typed dispositions the host itself published for a call it could not finish, for example a call lost
   *  when the voice connection resumed. A typed loss is a disposition; silence is not. */
  readonly dispositions: readonly { readonly at: number; readonly callId: string; readonly code: string }[];
  readonly calls: readonly CallObligation[];
  /** Each run of output submissions and the continuation decision that must follow it. */
  readonly batches: readonly { readonly epoch: number; readonly at: number; readonly callIds: readonly string[]; readonly create: Command | undefined }[];
  readonly toolCalls: readonly { name: string; args: unknown; at: number }[];
  /** The tool journal's refusals: a scenario expecting a real tool result asserts this is empty. */
  readonly journalErrors: readonly string[];
  readonly ctx: LiveContext;
  ready(): Promise<void>;
  /** Deliver one provider frame and let the host consume it. */
  deliver(frame: Record<string, unknown>, cause?: string): Promise<void>;
  /** The owner speaks: one 30 ms capture frame, which is what the host forwards to the provider. */
  speak(samples?: number): Promise<void>;
  /** The owner's input episode ends. */
  endInput(): Promise<void>;
  /** Play or withhold the pending playback: a receipt for every queued audio chunk is scheduled by `play`. */
  playback(): Promise<void>;
  /** Install the provider's post-reconnect script from the trace, before the first fault can arrive. */
  recoverySteps(steps: readonly TraceStep[]): void;
  /** Advance virtual time by `ms`, firing every timer due inside it. */
  advance(ms: number): Promise<void>;
  /** Advance until `condition` holds or the budget runs out, then report whether it held. */
  until(condition: () => boolean, budgetMs?: number): Promise<boolean>;
  release(): Promise<void>;
}

const startedFrame = (): Record<string, unknown> => ({ type: 'session.started', session: { id: 'sess_replay' } });

const tick = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
const flush = async (): Promise<void> => { await tick(); await tick(); };

/** A provider `function_call` item, as the adapter surfaces a delegated tool call. */
const isFunctionCall = (frame: Record<string, unknown>): { callId: string; name: string; delegationId: string } | undefined => {
  const event = frame['event'];
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'response.output_item.done') return undefined;
  const item = record['item'];
  if (!item || typeof item !== 'object') return undefined;
  const entry = item as Record<string, unknown>;
  if (entry['type'] !== 'function_call') return undefined;
  return { callId: String(entry['call_id']), name: String(entry['name']), delegationId: String(frame['delegation_id'] ?? 'unknown') };
};

export async function replay(t: TestContext, options: ReplayOptions = {}): Promise<Replay> {
  const callMaxMs = options.callMaxMs ?? 120_000;
  const dir = mkdtempSync(join(tmpdir(), 'didi-voice-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  t.after(() => store.close());
  const clock = new ReplayClock();
  const f = await fixture(t);
  const profile = validateLiveProfile({
    provider: 'openai', liveModelId: 'gpt-live-1', voice: 'marin', keyReference: 'openai-primary',
    route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
    prompt: { text: 'SYNTHETIC voice replay instructions', dataClass: 'ordinary' },
    limits: { sessionMs: 600_000, idleMs: 600_000, callMaxMs, journalMaxEvents: 4096, journalMaxBytes: 1_048_576 },
  });
  const adapter = new OpenAiLiveVoiceAdapter({
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'openai', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: { resolve: async () => 'SYNTHETIC-REPLAY-KEY' },
    socketFactory: f.socketFactory, clock,
    limits: { handshakeMs: 120_000, idleMs: 600_000, sessionMs: 600_000, closeMs: 60_000 },
  });
  const tools = options.tools ? await replayTools(t, store, clock, liveProfileIdentity(profile)) : undefined;
  for (const script of options.scripts ?? []) tools?.script(script);
  t.after(async () => { await tools?.close(); });

  const providerFrames: Command[] = [];
  const commands: Command[] = [];
  const projections: Projection[] = [];
  const receipts: Receipt[] = [];
  const calls: CallObligation[] = [];
  const batches: { epoch: number; at: number; callIds: string[]; create: Command | undefined }[] = [];
  let seq = 0;
  let epoch = 0;
  const record = (): void => {
    handshakeNewConnections();
    while (providerFrames.length < f.frames.length) {
      const frame = f.frames[providerFrames.length]!;
      seq += 1;
      const type = String(frame['type'] ?? 'unknown');
      // A new `session.start` is a new generation: the host's recovery re-seeds and resumes, so an obligation
      // is scoped to the epoch that owes it, and a re-submission after a reconnect is never a repeat.
      if (type === 'session.start' && providerFrames.length > 0) epoch += 1;
      const command: Command = { seq, at: clock.now(), type, frame, epoch };
      providerFrames.push(command);
      commands.push(command);
      // The obligation ledger: an output submission is one `response.item.create` carrying a function_call_output.
      if (command.type === 'response.item.create') {
        const item = frame['item'] as Record<string, unknown> | undefined;
        const callId = item?.['type'] === 'function_call_output' ? String(item['call_id']) : undefined;
        if (callId !== undefined) {
          const obligation = calls.find(entry => entry.callId === callId && entry.epoch === command.epoch);
          obligation?.outputs.push(command);
          // A batch is the run of output submissions the continuation must follow: the docs say submit results
          // for every pending call, then send `response.create`.
          const last = batches.at(-1);
          if (last && !last.create && last.epoch === command.epoch) last.callIds.push(callId);
          else batches.push({ epoch: command.epoch, at: command.at, callIds: [callId], create: undefined });
        }
      }
      if (command.type === 'response.create') {
        const batch = batches.at(-1);
        if (batch && !batch.create) batch.create = command;
      }
    }
  };
  const sample = (cause: string): void => {
    const snapshot = owner.get(liveSessionId);
    const state = owner.current().state;
    const last = projections.at(-1);
    if (last && last.state === state && last.lifecycle === snapshot.lifecycle) return;
    projections.push({ at: clock.now(), cause, state, lifecycle: snapshot.lifecycle });
  };

  const owner = createLiveSessionOwner({
    store, voice: adapter as LiveVoicePort, profile,
    now: () => clock.now(), schedule: (callback, delayMs) => clock.schedule(callback, delayMs), timeZone: 'UTC',
    ...(tools ? { tools: tools.composition } : {}),
  });
  clock.onFire = () => { if (owner) sample('timer'); };
  const ctx: LiveContext = { clientId: 'replay-driver', auditId: 'replay-audit', authorityEpoch: store.authorityEpoch };
  tools?.setAuthority(async (runId) => owner.lookupAuthority(runId) ?? owner.lookupJobAuthority(runId) ?? null);
  const session = owner.create({ idempotencyKey: options.idempotencyKey ?? 'voice-replay-0001', inputClass: 'ordinary' }, ctx);
  const liveSessionId = session.liveSessionId;
  const attachment = owner.attach({ liveSessionId }, ctx);
  attachment.ready.catch(() => {});
  let readySettled = false;
  void attachment.ready.then(() => { readySettled = true; }, () => { readySettled = true; });
  // The provider handshake is not a fault: the driver answers `session.started` for the fake provider as soon
  // as the adapter's socket is up, so every scenario begins from an open session and scripts only its fault.
  let handshake = false;
  let handshakes = 0;
  // Every new socket is a recovery, and each one needs the provider handshake. The driver answers it here so a
  // recovery is a real provider answer and not a hung socket the scenario would blame on the code.
  const recoveryQueue: { at: number; event: Record<string, unknown> }[] = [];
  let recovery: readonly TraceStep[] = [];
  const handshakeNewConnections = (): void => {
    while (f.connections > handshakes) {
      try { f.send(startedFrame()); } catch { return; }
      handshakes += 1;
      handshake = true;
      for (const step of recovery) recoveryQueue.push({ at: clock.now() + step.at_ms, event: step.event });
    }
  };
  void f.connected.then(() => { handshakeNewConnections(); });
  let outputEnded = false;
  // Playback is the driver's job: it is the owner's application, so it plays what the host emits. A queued
  // chunk is played at the rate of its own duration, which yields a receipt when the audio would be heard.
  let inaudibleFrames = 0;
  const dispositions: { at: number; callId: string; code: string }[] = [];
  const pendingPlay: { bytes: number; at: number }[] = [];
  void (async () => {
    try {
      for await (const chunk of attachment.output) {
        if (chunk.kind === 'marker') {
          const tool = chunk.marker.tool;
          if (tool?.code && tool.callId) dispositions.push({ at: clock.now(), callId: tool.callId, code: tool.code });
          continue;
        }
        // A fill frame is digital silence: it is played, but it is never audibly output, so it never
        // becomes the delivery the turn owes.
        if (!audiblePcm(chunk.pcm)) { inaudibleFrames += 1; continue; }
        pendingPlay.push({ bytes: chunk.pcm.byteLength, at: clock.now() });
      }
    } finally { outputEnded = true; }
  })();

  const playOne = (bytes: number, at: number): void => {
    const durationMs = Math.round((bytes / 2 / 24_000) * 1000);
    receipts.push({ at, bytes, durationMs });
    for (const entry of calls) if (entry.deliveryAt === undefined && entry.outputs.length > 0) entry.deliveryAt = at;
  };

  const api: Replay = {
    clock, owner, store, liveSessionId, providerFrames, commands, projections, receipts, calls, batches, ctx,
    get inaudibleFrames() { return inaudibleFrames; },
    get dispositions() { return dispositions; },
    get toolCalls() { return tools?.calls ?? []; },
    get journalErrors() { return tools?.journalErrors ?? []; },
    async ready() {
      await api.until(() => handshake && readySettled && owner.get(liveSessionId).lifecycle === 'active', 5_000);
      assert.equal(owner.get(liveSessionId).lifecycle, 'active', 'the session never reached active');
      record();
      sample('ready');
    },
    async deliver(frame, cause = 'provider') {
      record();
      const call = isFunctionCall(frame);
      if (call) calls.push({ callId: call.callId, name: call.name, at: clock.now(), epoch, delegationId: call.delegationId, outputs: [], terminal: undefined, continuation: undefined, deliveryAt: undefined });
      f.send(frame);
      await flush();
      record();
      sample(cause);
    },
    async speak(samples = 480) {
      attachment.sendAudio({ pcm: tone(samples) });
      await flush();
      record();
    },
    async endInput() {
      attachment.endAudioStream();
      await flush();
      record();
      sample('endInput');
    },
    recoverySteps(steps) { recovery = steps; },
    async playback() {
      for (const entry of pendingPlay.splice(0)) playOne(entry.bytes, entry.at);
      await flush();
    },
    async advance(ms) {
      const target = clock.now() + Math.max(0, ms);
      for (;;) {
        const due = recoveryQueue.filter(step => step.at <= target).sort((a, b) => a.at - b.at)[0];
        const next = due ? due.at : target;
        await clock.advanceTo(next, flush);
        record();
        if (!due) break;
        recoveryQueue.splice(recoveryQueue.indexOf(due), 1);
        const call = isFunctionCall(due.event);
        if (call) calls.push({ callId: call.callId, name: call.name, at: clock.now(), epoch, delegationId: call.delegationId, outputs: [], terminal: undefined, continuation: undefined, deliveryAt: undefined });
        f.send(due.event);
        await flush();
        record();
        sample('recovery');
      }
      record();
      await api.playback();
      sample('advance');
    },
    async until(condition, budgetMs = 30_000) {
      const limit = clock.now() + budgetMs;
      for (let i = 0; i < 4_000; i++) {
        await api.playback();
        record();
        if (condition()) return true;
        if (clock.now() >= limit) return condition();
        // Step by the nearest scheduled timer, or 50 virtual ms, so a host timer fires at its own time.
        await clock.advanceTo(clock.now() + 50, flush);
        record();
      }
      return condition();
    },
    async release() {
      try { attachment.detach(); } catch { /* already settled */ }
      try { owner.revoke(liveSessionId); } catch { /* already terminal */ }
      await flush();
      await api.until(() => outputEnded, 5_000);
      await owner.shutdown();
      await flush();
    },
  };
  return api;
}

/** Whether a PCM16 chunk carries any signal: the fill frames gpt-live-1 streams are all zeros. */
export function audiblePcm(pcm: Uint8Array): boolean {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index + 1 < pcm.byteLength; index += 2) if (Math.abs(view.getInt16(index, true)) > 64) return true;
  return false;
}

/** A synthetic 16 kHz PCM16 tone; `samples` 480 is the host's 30 ms capture frame. */
export function tone(samples = 480, amplitude = 8_000): Uint8Array {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, Math.round(Math.sin((index / 16) * 2 * Math.PI) * amplitude), true);
  return bytes;
}

/** Assert the recorded outbound command types in order: `expected` is a subsequence of the real log. */
export function expectCommands(log: readonly Command[], expected: readonly string[]): void {
  let cursor = 0;
  for (const command of log) if (cursor < expected.length && command.type === expected[cursor]) cursor += 1;
  assert.equal(cursor, expected.length, `expected the command order ${JSON.stringify(expected)}, saw ${JSON.stringify(log.map(command => command.type))}`);
}

/** The orb projection as a compact list of states, for a clear failure message. */
export const states = (log: readonly Projection[]): string[] => log.map(entry => entry.state);

const tracesDirectory = new URL('../../../test/voice-replay/traces/', import.meta.url);

/** Load one sanitized scenario trace. Synthetic text only: the sanitizer replaced every recorded word. */
export function loadTrace(name: string): Trace {
  const file = new URL(`${name}.json`, tracesDirectory);
  return JSON.parse(readFileSync(file, 'utf8')) as Trace;
}

export interface Played {
  readonly replay: Replay;
  readonly trace: Trace;
  violations(options?: { allowUnanswered?: boolean }): Violations;
}

/**
 * Play one trace end to end: advance virtual time to each step, apply it, then let every owed answer, timer
 * and watchdog run out to the scenario's own deadline.
 */
export async function play(t: TestContext, name: string, options: ReplayOptions = {}): Promise<Played> {
  const trace = loadTrace(name);
  const r = await replay(t, options);
  r.recoverySteps(trace.recovery ?? []);
  await r.ready();
  for (const step of [...trace.steps].sort((a, b) => a.at_ms - b.at_ms)) {
    await r.advance(Math.max(0, step.at_ms - (r.clock.now() - r.clock.startedAt)));
    if (step.direction === 'in') await r.deliver(step.event, `trace ${step.at_ms}`);
    else if (step.direction === 'client') await applyClient(r, step.event);
  }
  // The turn owes an answer to the scenario deadline, so the replay runs past the last step before judging.
  const lastAt = trace.steps.at(-1)?.at_ms ?? 0;
  const target = lastAt + trace.deadline_ms;
  await r.advance(Math.max(0, target - (r.clock.now() - r.clock.startedAt)));
  await r.until(() => r.owner.get(r.liveSessionId).lifecycle === 'terminal', trace.deadline_ms);
  return { replay: r, trace, violations: overrides => analyse({ calls: r.calls, batches: r.batches, commands: r.commands, projections: r.projections, receipts: r.receipts, dispositions: r.dispositions, deadlineMs: trace.deadline_ms, ...overrides }) };
}

async function applyClient(r: Replay, event: Record<string, unknown>): Promise<void> {
  switch (event['type']) {
    case 'speak': await r.speak(Number(event['samples'] ?? 480)); return;
    case 'end_input': await r.endInput(); return;
    case 'playback': await r.playback(); return;
    default: throw new Error(`unknown client step ${String(event['type'])}`);
  }
}
