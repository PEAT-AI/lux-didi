import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { luxWriteEndpoint } from '../adapters/lux-write/client.js';
import type { Store } from '../runtime/store.js';
import type { LiveService } from '../http/live-upgrade.js';
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
  pending: Set<string>; step: number; completedStep: number; lastResultStep: number;
}

/** Only the authenticated canary opener calls open. Frame properties cannot grant authority. */
export class CanarySessions {
  readonly #now: () => number;
  #active: CanaryState | undefined;
  constructor(now: () => number = Date.now) { this.#now = now; }
  open(id: string): void {
    if (this.#active) throw new Error('canary_already_live');
    this.#active = { id, deadline: this.#now() + 350_000, emitted: new Set(), acknowledged: new Set(), calls: new Map(), turns: 0, completed: 0, streaming: false, pending: new Set(), step: 0, completedStep: 0, lastResultStep: 0 };
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
      if (property === 'events') return { async *[Symbol.asyncIterator]() {
        for await (const event of target.events) {
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
        }
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

/** Administrative cleanup of only a confirmed insight created by THIS canary session. */
async function forgetCanaryNote(id: string, title: string, signal: AbortSignal): Promise<boolean> {
  if (!/^[1-9][0-9]*$/.test(id)) return false;
  const endpoint = luxWriteEndpoint();
  const url = new URL(endpoint.url);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) return false;
  const client = new Client({ name: 'lux-didi-canary-cleanup', version: '1' });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: (input, init) => fetch(input, { ...init, signal, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) } }),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => result.structuredContent ? JSON.stringify(result.structuredContent) : result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const containsId = (body: string) => new RegExp(`(?:#|\\bid["' ]*[:=]\\s*)${id}(?![0-9])`).test(body);
  try {
    await client.connect(transport);
    const before = await client.callTool({ name: 'get_insight', arguments: { ids: [Number(id)] } }, { signal });
    if (before.isError || !containsId(text(before)) || !text(before).includes(title)) return false;
    const deleted = await client.callTool({ name: 'delete_insight', arguments: { ids: [Number(id)] } }, { signal });
    if (deleted.isError) return false;
    const after = await client.callTool({ name: 'list_insights', arguments: { status: 'archived', term: title, limit: 100 } }, { signal });
    return !after.isError && containsId(text(after));
  } finally { await client.close(); }
}

type RawCall = { key: string; tool: string; result: Record<string, unknown>; ms: number };
/** Only called from the bearer-authenticated local canary opener, never a model tool. */
export class InstalledCanary {
  #session: { id: string; clientId: string; asks: CanaryAsk[]; timer: ReturnType<typeof setTimeout>; abort: AbortController; running: boolean } | undefined;
  constructor(private readonly store: Store, private readonly live: LiveService, private readonly wait: (signal: AbortSignal) => Promise<void> = async signal => { await pause(50, undefined, { signal }); }, private readonly now: () => number = Date.now) {}
  shutdown(): void {
    if (!this.#session) return;
    const { id, timer, abort } = this.#session;
    clearTimeout(timer); abort.abort(); this.live.revoke(id); canarySessions.close(id); this.#session = undefined;
  }
  open(value: unknown, context: LiveContext, deadline = Date.now() + 350_000): LiveSessionSnapshot {
    const asks = validateCanaryAsks(value);
    const remaining = deadline - Date.now();
    if (!Number.isFinite(deadline) || remaining <= 0 || remaining > 350_000) throw new Error('invalid_canary_deadline');
    if (this.#session || this.store.transaction(tx => tx.get("SELECT live_session_id FROM live_sessions WHERE lifecycle IN ('accepted','opening','active') LIMIT 1"))) throw new Error('call_live');
    const snapshot = this.live.create('ordinary', `canary:${randomUUID()}`, context);
    const id = snapshot.liveSessionId;
    canarySessions.open(id);
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort(); this.live.revoke(id);
      if (this.#session?.id === id && !this.#session.running) { canarySessions.close(id); this.#session = undefined; }
    }, remaining);
    timer.unref();
    this.#session = { id, clientId: context.clientId, asks, timer, abort, running: false };
    return snapshot;
  }
  #calls(id: string): RawCall[] {
    return this.store.transaction(tx => {
      const calls: RawCall[] = [...(canarySessions.progress(id)?.calls ?? [])];
      // Source calls inside research have their own canonical reply; ignore the stored state.
      for (const row of tx.all('SELECT execution_id,intent_json,result_json FROM tool_calls WHERE run_id=? AND result_json IS NOT NULL ORDER BY rowid', [id])) {
        const intent: unknown = JSON.parse(String(row.intent_json));
        const reply: unknown = JSON.parse(String(row.result_json));
        if (record(intent) && record(reply)) calls.push({ key: `tool:${String(row.execution_id)}`, tool: String(intent['toolName']), result: record(reply['response']) ? reply['response'] : reply, ms: 0 });
      }
      return calls;
    });
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
    let prior = new Set<string>();
    let started = 0;
    let ackBefore = 0;
    let completedBefore = 0;
    const cleaned = new Set<string>();
    const port: CanaryPort = {
      inject: finals => {
        if (!this.live.providerReady?.(id)) throw new Error('provider_unavailable');
        prior = new Set(this.#calls(id).map(row => row.key)); started = Date.now(); ackBefore = canarySessions.nativeAckCount(id);
        completedBefore = canarySessions.progress(id)?.completed ?? 0;
        for (const text of finals) this.live.text(text);
      },
      observe: async (_ask, signal) => {
        const deadline = Math.min(started + 25_000, Date.now() + 25_000);
        let calls: RawCall[] = [];
        while (!signal.aborted && Date.now() < deadline) {
          calls = this.#calls(id).filter(row => !prior.has(row.key));
          const progress = canarySessions.progress(id);
          if (progress && progress.completed > completedBefore && !progress.streaming && progress.pending === 0 && progress.completedStep > progress.lastResultStep) return calls.map(row => ({ ...row, ms: Date.now() - started }));
          if (this.live.snapshot(id).terminal) break;
          try { await this.wait(signal); } catch { break; }
        }
        return (calls.length ? calls : [{ tool: 'none', result: {}, ms: 0 }]).map(row => ({ ...row, ms: Date.now() - started, timedOut: true }));
      },
      verifyAndCleanup: async (ask, observations) => {
        const cleanupSignal = AbortSignal.timeout(8_000);
        let effect: CanaryObservation['sideEffect'];
        // Include the last committed reply even if a provider timeout interrupted observation.
        const replies = [...observations, ...this.#calls(id).filter(row => !prior.has(row.key))];
        for (const item of replies) {
          const reply = item.result;
          if (['set_alarm', 'snooze_alarm'].includes(item.tool) && typeof reply['id'] === 'string' && !cleaned.has(reply['id'])) {
            const alarmId = reply['id'];
            const observed = this.store.transaction(tx => Boolean(tx.get("SELECT a.id FROM alarms a JOIN tool_calls c ON c.execution_id=a.id WHERE a.id=? AND a.state='pending' AND c.run_id=? AND json_extract(c.intent_json,'$.toolName') IN ('set_alarm','snooze_alarm')", [alarmId, id])));
            const removed = observed && this.store.transaction(tx => { tx.run("UPDATE alarms SET state='cancelled' WHERE id=? AND state='pending'", [alarmId]); return Boolean(tx.get("SELECT id FROM alarms WHERE id=? AND state='cancelled'", [alarmId])); });
            cleaned.add(alarmId);
            if (ask.expect.sideEffect === 'alarm' || !removed) effect = { kind: 'alarm', observed, cleaned: removed };
          }
          if (item.tool === 'stage_lux_note' && reply['saved'] === true && (typeof reply['insightId'] === 'string' || typeof reply['insightId'] === 'number')) {
            const insightId = String(reply['insightId']);
            if (cleaned.has(`note:${insightId}`)) continue;
            const note = this.store.transaction(tx => tx.get("SELECT title FROM vault_writes WHERE live_session_id=? AND insight_id=? AND state='confirmed'", [id, insightId]));
            let removed = false;
            try { removed = note !== undefined && await forgetCanaryNote(insightId, String(note.title), cleanupSignal); } catch { /* failure stays FAIL, never a skip */ }
            cleaned.add(`note:${insightId}`);
            if (ask.expect.sideEffect === 'note' || !removed) effect = { kind: 'note', observed: note !== undefined, cleaned: removed };
          }
        }
        if (ask.expect.sideEffect === 'open') effect = { kind: 'open', observed: canarySessions.nativeAckCount(id) > ackBefore, cleaned: true };
        return effect;
      },
      providerTurns: () => canarySessions.progress(id)?.turns ?? 0,
      close: () => this.shutdown(),
    };
    return runCanaryAsks(session.asks, port, session.abort.signal);
  }
}
