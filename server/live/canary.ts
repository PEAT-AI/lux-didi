import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { attachHostLogSink } from '../tools/host-events.js';
import type { Store } from '../runtime/store.js';
import type { LiveService } from '../http/live-upgrade.js';
import { CANARY_SESSION_KEY_PREFIX } from '../domain/history-lifecycle.js';
import type { LiveContext, LiveSessionSnapshot } from './types.js';
import type { LiveVoiceSession } from '../adapters/live-voice/types.js';

/** Canary evidence is deliberately independent of journal outcome labels. */
export interface CanaryAsk {
  id: string;
  finals: string[];
  expect: { tool: string; codeClass: 'success'; nonEmpty: boolean; sideEffect?: 'alarm' | 'open' | 'note' };
}
export interface CanaryObservation {
  tool: string;
  result: Record<string, unknown>;
  ms: number;
  timedOut?: boolean;
  sideEffect?: { kind: 'alarm' | 'open' | 'note'; observed: boolean; cleaned: boolean };
}
const successCodes = new Set(['ok', 'success', 'opened', 'saved', 'set', 'scheduled', 'found', 'created', 'cancelled', 'forgotten', 'answered', 'complete', 'data']);
/** Interpret the reply's own fields, never a tool_calls.state or journal outcome. */
export function canaryResultCode(result: Record<string, unknown>): string {
  if (result['error']) return typeof result['error'] === 'string' ? result['error'] : 'tool_error';
  if (result['saved'] === false || result['ok'] === false || result['isError'] === true) {
    const failure = String(result['code'] ?? result['reason'] ?? 'tool_error');
    return successCodes.has(failure) ? 'invalid_success_shape' : failure;
  }
  if (typeof result['status'] === 'string' && !successCodes.has(result['status'])) return String(result['reason'] ?? result['status']);
  if (typeof result['code'] === 'string') return result['code'];
  if (typeof result['status'] === 'string') return result['status'];
  if (result['saved'] === true) return 'saved';
  if (result['ok'] === true) return 'ok';
  // Read tools can return a typed data envelope instead of a string code.
  if (['items', 'results', 'messages', 'events', 'files', 'cards', 'boards', 'channels', 'posts', 'alarms', 'matches', 'text', 'markdown', 'content', 'body', 'data'].some(key => key in result)) return 'data';
  return 'missing_code';
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasData = (value: unknown): boolean => {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try { return hasData(JSON.parse(text)); } catch { /* ordinary source text, not a JSON envelope */ }
    }
    return text.length > 0;
  }
  if (Array.isArray(value)) return value.some(hasData);
  if (record(value)) return Object.entries(value).some(([key, item]) => !['code', 'ok', 'outcome', 'status', 'error', 'reason', 'query', 'cursor', 'nextCursor', 'type', 'mimeType', 'guidance', 'say', 'fixNotForSpeech'].includes(key) && hasData(item));
  return false;
};
export function assertCanaryResult(ask: CanaryAsk, observation: CanaryObservation): { ok: boolean; code: string } {
  const fail = (code: string) => ({ ok: false, code });
  if (observation.timedOut) return fail('provider_timeout');
  if (observation.tool !== ask.expect.tool) return fail('wrong_tool');
  const code = canaryResultCode(observation.result);
  if (!successCodes.has(code) || observation.result['ok'] === false || observation.result['error']) return fail(code);
  const dataFields = ['items', 'results', 'messages', 'events', 'files', 'cards', 'boards', 'channels', 'posts', 'alarms', 'matches', 'data', 'content', 'body', 'text', 'markdown', 'entries', 'insights', 'companies', 'company', 'history', 'answer', 'topic'].filter(key => key in observation.result);
  const nonEmpty = dataFields.length ? dataFields.some(key => hasData(observation.result[key])) : hasData(observation.result);
  if (ask.expect.nonEmpty && !nonEmpty) return fail('empty_payload');
  if (observation.sideEffect && (!observation.sideEffect.observed || !observation.sideEffect.cleaned)) return fail('side_effect_missing');
  if (ask.expect.sideEffect) {
    const effect = observation.sideEffect;
    if (!effect || effect.kind !== ask.expect.sideEffect || !effect.observed || !effect.cleaned) return fail('side_effect_missing');
  }
  return { ok: true, code };
}
export function canaryPreflight(input: { asksPresent: boolean; live: boolean }): 'run' | 'skip' {
  if (input.live) throw new Error('call_live');
  return input.asksPresent ? 'run' : 'skip';
}
export function validateCanaryAsks(value: unknown): CanaryAsk[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 15) throw new Error('invalid_asks_count');
  const ids = new Set<string>();
  for (const ask of value) {
    if (!record(ask) || typeof ask['id'] !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(ask['id']) || ids.has(ask['id'])) throw new Error('invalid_ask_id');
    ids.add(ask['id']);
    const finals = ask['finals'];
    const expect = ask['expect'];
    if (!Array.isArray(finals) || finals.length === 0 || finals.length > 8 || finals.some(text => typeof text !== 'string' || text.trim().length === 0 || text.length > 4_000)) throw new Error('invalid_finals');
    if (!record(expect) || typeof expect['tool'] !== 'string' || !/^[a-zA-Z0-9_]{1,100}$/.test(expect['tool']) || expect['codeClass'] !== 'success' || typeof expect['nonEmpty'] !== 'boolean' || (expect['sideEffect'] !== undefined && !['alarm', 'open', 'note'].includes(String(expect['sideEffect'])))) throw new Error('invalid_expectation');
  }
  return value as CanaryAsk[];
}

interface CanaryState {
  id: string; deadline: number; emitted: Set<string>; acknowledged: Set<string>;
  calls: Map<string, RawCall>; turns: number; completed: number; streaming: boolean;
  cleanup?: (() => void) | undefined;
  pending: Set<string>; step: number; completedStep: number; lastResultStep: number;
}

/** Only the authenticated canary opener calls open. Frame properties cannot grant authority. */
export class CanarySessions {
  readonly #now: () => number;
  #active: CanaryState | undefined;
  constructor(now: () => number = Date.now) { this.#now = now; }
  open(id: string, cleanup?: () => void): void {
    if (this.#active) throw new Error('canary_already_live');
    this.#active = { id, cleanup, deadline: this.#now() + 350_000, emitted: new Set(), acknowledged: new Set(), calls: new Map(), turns: 0, completed: 0, streaming: false, pending: new Set(), step: 0, completedStep: 0, lastResultStep: 0 };
  }
  close(id: string): void { if (this.#active?.id === id) this.#active = undefined; }
  isCanary(id: string): boolean { return this.#active?.id === id; }
  progress(id: string): { calls: RawCall[]; turns: number; completed: number; streaming: boolean; pending: number; completedStep: number; lastResultStep: number } | undefined {
    const state = this.#active;
    return state?.id === id ? { calls: [...state.calls.values()], turns: state.turns, completed: state.completed, streaming: state.streaming, pending: state.pending.size, completedStep: state.completedStep, lastResultStep: state.lastResultStep } : undefined;
  }
  /** A canary-only boundary tap. Ordinary sessions keep their exact original object/iterator. */
  wrapSession(id: string, session: LiveVoiceSession): LiveVoiceSession {
    const state = this.#active;
    if (!state || state.id !== id) return session;
    const owner = this;
    return new Proxy(session, { get(target, property) {
      if (property === 'close') return () => { if (owner.#active === state) state.cleanup?.(); target.close(); };
      if (property === 'events') return { async *[Symbol.asyncIterator]() {
        try { for await (const event of target.events) {
          if (owner.#active === state) {
            state.step++;
            if (event.type === 'modelTurnStarted') { state.turns++; state.streaming = true; }
            if (event.type === 'toolCall') for (const call of event.calls) state.pending.add(call.id);
            if (event.type === 'toolCallCancellation') for (const id of event.ids) state.pending.delete(id);
            if (event.type === 'turnComplete') {
              state.completed++; state.streaming = false; state.completedStep = state.step;
            }
          }
          yield event;
        } } finally { if (owner.#active === state) state.cleanup?.(); }
      } };
      if (property === 'sendToolResponse') return (input: Parameters<LiveVoiceSession['sendToolResponse']>[0]) => {
        if (owner.#active === state) for (const reply of input.responses) {
          state.lastResultStep = ++state.step;
          state.calls.set(reply.id, { key: `reply:${reply.id}`, tool: reply.name, result: JSON.parse(JSON.stringify(reply.response)) as Record<string, unknown>, ms: owner.#now() });
        }
        const outcome = target.sendToolResponse(input);
        if (owner.#active === state && outcome !== 'failed') for (const reply of input.responses) state.pending.delete(reply.id);
        return outcome;
      };
      // Native adapters use private fields. Bind every ordinary method to the real receiver.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  nativeAckCount(id: string): number { return this.#active?.id === id ? this.#active.acknowledged.size : 0; }
  acknowledgeNative(id: string, frame: unknown): void {
    if (this.#active?.id !== id || !record(frame) || typeof frame['id'] !== 'string') return;
    if (this.#active.emitted.has(frame['id']) && frame['type'] === 'native_action_result' && frame['ok'] === true && frame['code'] === 'opened') this.#active.acknowledged.add(frame['id']);
  }
  nativeFrame<T extends { type: string; id: string; action: string; target: string; origin?: string }>(id: string, frame: T): { type: string; id: string; action: string; target: string; origin?: string } {
    // Rebuild, never spread an untrusted frame or forward an unrecognized native action.
    if (!['open_url', 'open_file', 'open_app'].includes(frame.action)) throw new Error('invalid_native_action');
    if (this.#active?.id === id) {
      if (this.#now() >= this.#active.deadline) throw new Error('canary_timeout');
      this.#active.emitted.add(frame.id);
      return { type: 'native_action', id: frame.id, action: 'canary_ack', target: frame.target };
    }
    return { type: 'native_action', id: frame.id, action: frame.action, target: frame.target, ...(frame.origin === undefined ? {} : { origin: frame.origin }) };
  }
}
export const canarySessions = new CanarySessions();

export interface CanaryPort {
  inject(finals: readonly string[]): void;
  observe(ask: CanaryAsk, signal: AbortSignal): Promise<CanaryObservation[]>;
  verifyAndCleanup(ask: CanaryAsk, observations: readonly CanaryObservation[], signal: AbortSignal): Promise<CanaryObservation['sideEffect']>;
  providerTurns(): number;
  close(): void;
}
export interface CanaryReport { lines: string[]; passed: number; failed: number; providerTurns: number }
/** Same runner for production and recorded fake sessions. No transcript/payload is printed. */
export async function runCanaryAsks(asks: CanaryAsk[], port: CanaryPort, signal: AbortSignal): Promise<CanaryReport> {
  validateCanaryAsks(asks);
  const lines: string[] = [];
  let passed = 0;
  let providerTurns = 0;
  try {
    for (const ask of asks) {
      let observation: CanaryObservation = { tool: ask.expect.tool, result: {}, ms: 0, timedOut: true };
      if (!signal.aborted) {
        try {
          port.inject(ask.finals);
          const observations = await port.observe(ask, signal);
          observation = observations.find(item => item.tool === ask.expect.tool) ?? observations[0] ?? { tool: 'none', result: {}, ms: 0 };
          // Cleanup is attempted even for a wrong tool, refusal or empty reply.
          const effect = await port.verifyAndCleanup(ask, observations, signal);
          if (effect) observation = { ...observation, sideEffect: effect };
        } catch {
          observation = { ...observation, timedOut: true };
        }
      }
      const verdict = assertCanaryResult(ask, observation);
      if (verdict.ok) passed++;
      lines.push(`CANARY ${verdict.ok ? 'PASS' : 'FAIL'} id=${ask.id} tool=${observation.tool} code=${verdict.code.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)} ms=${Math.max(0, Math.round(observation.ms))}`);
    }
  } finally { providerTurns = port.providerTurns(); port.close(); }
  lines.push(`CANARY SUMMARY pass=${passed} fail=${asks.length - passed} asks=${asks.length} providerTurns=${providerTurns}`);
  return { lines, passed, failed: asks.length - passed, providerTurns };
}

type RawCall = { key: string; tool: string; result: Record<string, unknown>; ms: number };
/** Only called from the bearer-authenticated local canary opener, never a model tool. */
export class InstalledCanary {
  #session: { id: string; clientId: string; asks: CanaryAsk[]; timer: ReturnType<typeof setTimeout>; abort: AbortController; running: boolean; expired: boolean } | undefined;
  constructor(private readonly store: Store, private readonly live: LiveService, private readonly wait: (signal: AbortSignal) => Promise<void> = async signal => { await pause(50, undefined, { signal }); }, private readonly now: () => number = Date.now, private readonly cancelAlarm?: (id: string) => boolean) {}
  shutdown(): void {
    if (!this.#session) return;
    const { id, timer, abort } = this.#session;
    clearTimeout(timer); abort.abort();
    this.#cancelAlarms(id);
    this.live.revoke(id); canarySessions.close(id); this.#session = undefined;
  }
  #cancelAlarms(id: string): void {
    if (!this.cancelAlarm) return;
    const rows = this.store.transaction(tx => tx.all("SELECT a.id FROM alarms a JOIN tool_calls c ON c.execution_id=a.id WHERE a.state IN ('pending','ringing') AND c.run_id=? AND json_extract(c.intent_json,'$.toolName') IN ('set_alarm','snooze_alarm')", [id]));
    for (const row of rows) this.cancelAlarm?.(String(row.id));
  }
  open(value: unknown, context: LiveContext, deadline = Date.now() + 350_000): LiveSessionSnapshot {
    const asks = validateCanaryAsks(value);
    const remaining = deadline - Date.now();
    if (!Number.isFinite(deadline) || remaining <= 0 || remaining > 350_000) throw new Error('invalid_canary_deadline');
    if (this.#session || this.store.transaction(tx => tx.get("SELECT live_session_id FROM live_sessions WHERE lifecycle IN ('accepted','opening','active') LIMIT 1"))) throw new Error('call_live');
    // F2: the canary marks its own session kind in the key it creates, so this session is never owner memory:
    // no summary, no opener and no history. `liveSessionKindOf` reads the same prefix back from the store.
    const snapshot = this.live.create('ordinary', `${CANARY_SESSION_KEY_PREFIX}${randomUUID()}`, context);
    const id = snapshot.liveSessionId;
    canarySessions.open(id, () => this.#cancelAlarms(id));
    const abort = new AbortController();
    const timer = setTimeout(() => {
      if (this.#session?.id === id) this.#session.expired = true;
      this.shutdown();
      if (this.#session?.id === id && !this.#session.running) { canarySessions.close(id); this.#session = undefined; }
    }, remaining);
    timer.unref();
    this.#session = { id, clientId: context.clientId, asks, timer, abort, running: false, expired: false };
    return snapshot;
  }
  async run(id: string, clientId: string): Promise<CanaryReport> {
    const session = this.#session;
    if (!session || session.id !== id || session.clientId !== clientId || session.running) throw new Error('invalid_canary_session');
    session.running = true;
    const readyStarted = this.now();
    const readyDeadline = readyStarted + 10_000;
    while (!session.abort.signal.aborted && !this.live.providerReady?.(id) && !this.live.snapshot(id).terminal && this.now() < readyDeadline) {
      try { await this.wait(session.abort.signal); } catch { break; }
    }
    if (!this.live.providerReady?.(id)) {
      const lines = session.asks.map(ask => `CANARY FAIL id=${ask.id} tool=${ask.expect.tool} code=provider_not_ready ms=${Math.max(0, this.now() - readyStarted)}`);
      lines.push(`CANARY SUMMARY pass=0 fail=${session.asks.length} providerTurns=0`);
      this.shutdown();
      return { lines, passed: 0, failed: session.asks.length, providerTurns: 0 };
    }
    // Fixed public read probe: private ask files opt in, but cannot request writes.
    // Task events here only wake the observer. The installed checker verifies the
    // durable host-line liveSessionId and taskId join before declaring success.
    let settled = false;
    const detach = attachHostLogSink({ event: raw => {
      if (record(raw) && (raw['event'] === 'task_settled' || raw['event'] === 'task_inference_failed')) settled = true;
    } });
    const started = this.now();
    try {
      this.live.text('Search the public web for the official RFC 9110 HTTP specification and tell me its title. Use a read-only search tool. Do not create, draft, send, save, open an app, or change anything.');
      while (!settled && !session.abort.signal.aborted && !this.live.snapshot(id).terminal && this.now() - started < 60_000) {
        try { await this.wait(session.abort.signal); } catch { break; }
      }
      // This is observation, not receipt acceptance. The external checker requires
      // tool execution and complete findings belonging to this exact call.
      const lines = [`CANARY SUMMARY pass=0 fail=${settled ? 0 : 1} providerTurns=${canarySessions.progress(id)?.turns ?? 0} callId=${id} shutdownReason=${session.expired ? 'canary_shutdown_timer' : settled ? 'task_observed' : 'observation_timeout'}`];
      return { lines, passed: 0, failed: settled ? 0 : 1, providerTurns: canarySessions.progress(id)?.turns ?? 0 };
    } finally {
      detach();
      // Explicitly end our private call after observation or timeout. A revoked
      // terminal here is cleanup, not a missing-connector preflight rejection.
      this.shutdown();
    }
  }
}
