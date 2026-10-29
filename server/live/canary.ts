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
const successCodes = new Set(['ok', 'success', 'opened', 'saved', 'scheduled', 'found', 'created', 'cancelled', 'forgotten']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasData = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasData);
  if (record(value)) return Object.entries(value).some(([key, item]) => !['code', 'ok', 'outcome', 'status', 'error', 'guidance', 'say', 'fixNotForSpeech'].includes(key) && hasData(item));
  return false;
};
export function assertCanaryResult(ask: CanaryAsk, observation: CanaryObservation): { ok: boolean; code: string } {
  const fail = (code: string) => ({ ok: false, code });
  if (observation.timedOut) return fail('provider_timeout');
  if (observation.tool !== ask.expect.tool) return fail('wrong_tool');
  const code = typeof observation.result['code'] === 'string' ? observation.result['code'] : 'missing_code';
  if (!successCodes.has(code) || observation.result['ok'] === false || observation.result['error']) return fail(code);
  if (ask.expect.nonEmpty && !hasData(observation.result)) return fail('empty_payload');
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

/** Only the authenticated canary opener calls open. Frame properties cannot grant authority. */
export class CanarySessions {
  readonly #now: () => number;
  #active: { id: string; deadline: number } | undefined;
  constructor(now: () => number = Date.now) { this.#now = now; }
  open(id: string): void {
    if (this.#active) throw new Error('canary_already_live');
    this.#active = { id, deadline: this.#now() + 360_000 };
  }
  close(id: string): void { if (this.#active?.id === id) this.#active = undefined; }
  nativeFrame<T extends { type: string; id: string; action: string; target: string; origin?: string }>(id: string, frame: T): { type: string; id: string; action: string; target: string; origin?: string } {
    // Rebuild, never spread an untrusted frame or forward an unrecognized native action.
    if (!['open_url', 'open_file', 'open_app'].includes(frame.action)) throw new Error('invalid_native_action');
    if (this.#active?.id === id) {
      if (this.#now() >= this.#active.deadline) throw new Error('canary_timeout');
      return { type: 'native_action', id: frame.id, action: 'canary_ack', target: frame.target };
    }
    return { type: 'native_action', id: frame.id, action: frame.action, target: frame.target, ...(frame.origin === undefined ? {} : { origin: frame.origin }) };
  }
}
export const canarySessions = new CanarySessions();
