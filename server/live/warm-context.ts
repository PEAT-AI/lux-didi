/**
 * The context a silent Naya keeps ready (council 2026-10-17, option C, item 4).
 *
 * While the presence machine is COLD or HOT_MUTED the host assembles the next
 * session's context locally: persona, memory, the recent conversation summary and
 * today's calendar digest when the connector is configured. Assembly is bounded by
 * the caller's instruction budget and refreshed at most every ten minutes, or on
 * demand after a wake. Nothing here talks to a model, so silence stays silent.
 */
export const warmContextMaxAgeMs = 10 * 60 * 1000;

export type WarmContextSources = {
  readonly persona: () => string | undefined;
  readonly memory: () => readonly string[];
  readonly summary: () => string | undefined;
  readonly calendar: () => string | undefined;
};

export type WarmContext = { readonly text: string; readonly assembledAt: number };

/** Sections in priority order, each trimmed to what the instruction budget has left. */
export function assembleContext(sources: WarmContextSources, budget: number): string {
  const sections: string[] = [];
  const persona = sources.persona()?.trim();
  if (persona) sections.push('Persona: ' + persona);
  const memory = sources.memory().map(entry => entry.trim()).filter(entry => entry.length > 0);
  if (memory.length) sections.push('Remembered:\n' + memory.map(entry => '- ' + entry).join('\n'));
  const summary = sources.summary()?.trim();
  if (summary) sections.push('Recent conversation: ' + summary);
  const calendar = sources.calendar()?.trim();
  if (calendar) sections.push('Today: ' + calendar);
  const kept: string[] = [];
  let used = 0;
  for (const section of sections) {
    const separator = kept.length ? 2 : 0;
    if (used + separator >= budget) break;
    const room = budget - used - separator;
    kept.push(section.length <= room ? section : section.slice(0, room));
    used += separator + Math.min(section.length, room);
    if (kept[kept.length - 1]!.length < section.length) break;
  }
  return kept.join('\n\n');
}

/**
 * One local assembly, refreshed at most every ten minutes. `now` is injected so the
 * age bound and the refresh bound are proven without waiting on a real clock.
 */
export class WarmContextCache {
  readonly #sources: WarmContextSources;
  readonly #budget: number;
  readonly #now: () => number;
  #current: WarmContext | undefined;
  #assemblies = 0;

  constructor(input: { sources: WarmContextSources; budget: number; now?: () => number }) {
    this.#sources = input.sources;
    this.#budget = Math.max(0, Math.trunc(input.budget));
    this.#now = input.now ?? (() => Date.now());
  }

  /** How many times context was actually assembled, for the receipt and the tests. */
  get assemblies(): number { return this.#assemblies; }

  get ageMs(): number | undefined {
    return this.#current === undefined ? undefined : this.#now() - this.#current.assembledAt;
  }

  /**
   * Assemble when the current assembly is missing or ten minutes old, and now when
   * `force` is set (the app forces on wake). Returns undefined when there is nothing
   * to assemble, so a caller never seeds a session with an empty block.
   */
  refresh(force = false): WarmContext | undefined {
    const at = this.#now();
    if (!force && this.#current !== undefined && at - this.#current.assembledAt < warmContextMaxAgeMs) return this.#current;
    const text = assembleContext(this.#sources, this.#budget);
    this.#assemblies += 1;
    this.#current = text.length ? { text, assembledAt: at } : undefined;
    return this.#current;
  }

  /** What a session may start from: undefined once the assembly is ten minutes old. */
  take(): WarmContext | undefined {
    const current = this.#current;
    if (current === undefined) return undefined;
    return this.#now() - current.assembledAt < warmContextMaxAgeMs ? current : undefined;
  }
}
