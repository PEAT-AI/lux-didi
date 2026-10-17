/**
 * The context a silent Naya keeps ready (council 2026-10-17, option C, item 4).
 *
 * While the presence machine is COLD or HOT_MUTED the host assembles the next
 * session's context locally: persona, memory, the recent conversation summary and
 * today's calendar digest when the connector is configured. The assembly is bounded
 * by the caller's instruction budget and kept for at most ten minutes; a session
 * start either uses the sections as they stand or assembles them from the store,
 * never both. Nothing here talks to a model, so silence stays silent.
 */
export const warmContextMaxAgeMs = 10 * 60 * 1000;

export type WarmContextSources = {
  readonly persona: () => string | undefined;
  readonly memory: () => readonly string[];
  readonly summary: () => string | undefined;
  readonly calendar: () => string | undefined;
};

/** One summary candidate dropped while the section was built. */
export type WarmContextOmission = { readonly id: string; readonly reason: 'budget' | 'stale' };

/** One assembly's parts, kept apart so a session start can consume them by slot. */
export type WarmContextSections = {
  readonly persona: string | undefined;
  readonly memory: readonly string[];
  readonly summary: string | undefined;
  /** The summary ids the section was built from, so a warm start keeps true provenance. */
  readonly summaryIds: readonly string[];
  /** The summaries the section left out, with why. Carried, never re-derived. */
  readonly summaryOmitted: readonly WarmContextOmission[];
  readonly calendar: string | undefined;
};

export type WarmContext = {
  readonly sections: WarmContextSections;
  readonly text: string;
  readonly assembledAt: number;
};

/** Read every source once. This is the only place a source is consulted. */
export function collectSections(sources: WarmContextSources): WarmContextSections {
  return { persona: sources.persona(), memory: [...sources.memory()], summary: sources.summary(),
    summaryIds: [], summaryOmitted: [], calendar: sources.calendar() };
}

/** Sections in priority order, each trimmed to what the instruction budget has left. */
export function assembleContext(sections: WarmContextSections, budget: number): string {
  const blocks: string[] = [];
  const persona = sections.persona?.trim();
  if (persona) blocks.push('Persona: ' + persona);
  const memory = sections.memory.map(entry => entry.trim()).filter(entry => entry.length > 0);
  if (memory.length) blocks.push('Remembered:\n' + memory.map(entry => '- ' + entry).join('\n'));
  const summary = sections.summary?.trim();
  if (summary) blocks.push('Recent conversation: ' + summary);
  const calendar = sections.calendar?.trim();
  if (calendar) blocks.push('Today: ' + calendar);
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const separator = kept.length ? 2 : 0;
    if (used + separator >= budget) break;
    const room = budget - used - separator;
    const piece = block.length <= room ? block : block.slice(0, room);
    kept.push(piece);
    used += separator + piece.length;
    if (piece.length < block.length) break;
  }
  return kept.join('\n\n');
}

/**
 * The session-start decision (P1-R1): a warm assembly younger than ten minutes
 * supplies the sections as they stand, so the store is not read a second time. Only
 * a stale or absent one is assembled, and the caller adopts that result so the next
 * start inside the window reuses it. One source of the block, never both.
 */
export function chooseStartContext(warm: WarmContext | undefined, assemble: () => WarmContextSections):
  { readonly sections: WarmContextSections; readonly warm: boolean } {
  if (warm !== undefined) return { sections: warm.sections, warm: true };
  return { sections: assemble(), warm: false };
}

/**
 * One local assembly, kept for ten minutes. `now` is injected so the age bound and
 * the refresh bound are proven without waiting on a real clock.
 */
export class WarmContextCache {
  readonly #sources: WarmContextSources | undefined;
  readonly #budget: number;
  readonly #now: () => number;
  #current: WarmContext | undefined;
  #assemblies = 0;

  constructor(input: { budget: number; now?: () => number; sources?: WarmContextSources }) {
    this.#budget = Math.max(0, Math.trunc(input.budget));
    this.#now = input.now ?? (() => Date.now());
    this.#sources = input.sources;
  }

  /** How many times a context was actually assembled, for the receipt and the tests. */
  get assemblies(): number { return this.#assemblies; }

  get ageMs(): number | undefined {
    return this.#current === undefined ? undefined : this.#now() - this.#current.assembledAt;
  }

  /** Keep sections that the caller assembled, so the next start inside the window reuses them. */
  adopt(sections: WarmContextSections): WarmContext | undefined {
    const text = assembleContext(sections, this.#budget);
    this.#assemblies += 1;
    this.#current = text.length ? { sections, text, assembledAt: this.#now() } : undefined;
    return this.#current;
  }

  /**
   * Assemble from the configured sources when the current assembly is missing or ten
   * minutes old, and now when `force` is set (the app forces on wake). The owner has no
   * sources of its own, so this refreshes nothing unless it was given them.
   */
  refresh(force = false): WarmContext | undefined {
    if (!force && this.#current !== undefined && this.ageMs! < warmContextMaxAgeMs) return this.#current;
    const sources = this.#sources;
    if (sources === undefined) return this.#current;
    return this.adopt(collectSections(sources));
  }

  /** What a session may start from: undefined once the assembly is ten minutes old. */
  take(): WarmContext | undefined {
    const current = this.#current;
    if (current === undefined) return undefined;
    return this.ageMs! < warmContextMaxAgeMs ? current : undefined;
  }
}
