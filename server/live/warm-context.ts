/**
 * The context a silent Naya keeps ready (council 2026-10-17, option C, item 4).
 *
 * While the presence machine is COLD or HOT_MUTED the host assembles the next
 * session's context locally: persona, memory, the recent conversation summary and
 * today's calendar digest when the connector is configured. CREATE selects current
 * completed summaries from its own store read; prewarm never renews them. The local
 * assembly has a ten-minute lifetime. Nothing here talks to a model.
 */
import { localDayWindow, type CalendarDigestReadResult, type CalendarDigestReadState } from '../connectors/google.js';

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

/**
 * A refresh of sections that were already chosen keeps the summary provenance they were chosen
 * with: a source collection can only describe text, and the ids are what `conversation_summary_injection`
 * accounts for. Losing them would silently under-report what the start injected.
 */
export function withProvenance(next: WarmContextSections, previous: WarmContextSections): WarmContextSections {
  return { ...next, summaryIds: [...previous.summaryIds], summaryOmitted: [...previous.summaryOmitted] };
}

/**
 * The one line at call start when a connector waits on a sign-in only the owner can finish. It is said
 * once, in the instruction, so a later turn never repeats it.
 */
export const SIGN_IN_REASONS = new Set(['needs_sign_in', 'not_signed_in', 'credential-missing', 'credential-refresh-failed', 'credential-consent-expired']);
export function signInNote(endpoints: readonly unknown[]): string | undefined {
  const waiting = endpoints.some(value => {
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    // Mongoose is the one connector the owner can sign in to, so no other connector is announced.
    if (row.connector !== 'mongoose') return false;
    // The host report names one of these closed codes; the browser projection names needs_sign_in.
    return SIGN_IN_REASONS.has(String(row.reasonCode)) || SIGN_IN_REASONS.has(String(row.error));
  });
  if (!waiting) return undefined;
  return 'Mongoose is waiting on a sign-in, so company knowledge cannot be read yet. Say that once, briefly, at the start of this call, and say the Sign in button is in Settings.';
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

/**
 * The host's calendar digest owner (1015). It reads the digest in the background and caches it with its
 * fetch time, so a call start answers from the cache with no request-path read. The 5 s per-start abort
 * this replaces cut a 1.7 to 6 s read short and folded the cut into an empty day.
 */
export type CalendarDigestState = CalendarDigestReadState | 'stale';
/** One cached read and the state a start reports for it. `stale` text never rides an assembly. */
export type CalendarDigestSnapshot = Omit<CalendarDigestReadResult, 'state'> & { readonly state: CalendarDigestState };

/** How long a cached digest may answer a call start. */
export const calendarDigestFreshMs = 30 * 60 * 1000;
/** How often the background owner refreshes the digest. */
export const calendarDigestRefreshMs = 15 * 60 * 1000;
/** The longest a call start waits for a read already in flight, then it starts without one. */
export const calendarDigestStartWaitMs = 1_500;

export class CalendarDigestCache {
  readonly #read: () => Promise<CalendarDigestReadResult>;
  readonly #now: () => number;
  readonly #timeZone: string;
  readonly #intervalMs: number;
  #snapshot: CalendarDigestReadResult | undefined;
  #inflight: Promise<CalendarDigestReadResult> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(read: () => Promise<CalendarDigestReadResult>, options: { readonly now: () => number; readonly timeZone: string; readonly intervalMs?: number }) {
    this.#read = read;
    this.#now = options.now;
    this.#timeZone = options.timeZone;
    this.#intervalMs = options.intervalMs ?? calendarDigestRefreshMs;
  }

  /** The host's background owner: one read now, then every 15 minutes until `stop`. Off the request path. */
  begin(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = setInterval(() => { void this.refresh(); }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One read, deduplicated: every caller inside the same window shares the read already in flight. */
  refresh(): Promise<CalendarDigestReadResult> {
    const inflight = this.#inflight;
    if (inflight !== undefined) return inflight;
    const pending = this.#read()
      .catch((): CalendarDigestReadResult => ({ state: 'failed', text: undefined, items: 0, fetchedAt: this.#now() }))
      .then(result => { this.#snapshot = result; this.#inflight = undefined; return result; });
    this.#inflight = pending;
    return pending;
  }

  /**
   * What the cache holds right now, with no wait. A digest older than 30 minutes, or one read before
   * local midnight, is `stale`: it never answers an assembly, and reading it kicks a refresh.
   */
  current(): CalendarDigestSnapshot | undefined {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return undefined;
    // No grant is a property of the connector, not of the day, so it is never cached: a start after the
    // owner connects the calendar asks again instead of reading yesterday's absence for half an hour.
    if (snapshot.state === 'unconfigured') return undefined;
    const now = this.#now();
    const sameDay = localDayWindow(now, this.#timeZone).timeMin === localDayWindow(snapshot.fetchedAt, this.#timeZone).timeMin;
    if (sameDay && now - snapshot.fetchedAt < calendarDigestFreshMs) return snapshot;
    void this.refresh();
    return { state: 'stale', text: undefined, items: 0, fetchedAt: snapshot.fetchedAt };
  }

  /**
   * What a call start uses: the fresh cache as it stands; otherwise at most `waitMs` for the read in
   * flight, asking for one when none is; otherwise the answer the cache already holds. A digest that was
   * aged out is reported `stale` with its own fetch time, which is the one state the receipt can carry for
   * it, and only a start with no snapshot at all reports `timeout`. Never a whole read on the path.
   */
  async forStart(waitMs = calendarDigestStartWaitMs): Promise<CalendarDigestSnapshot> {
    const cached = this.current();
    if (cached !== undefined && cached.state !== 'stale') return cached;
    const pending = this.#inflight ?? this.refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); });
    try {
      const read = await Promise.race([pending, expiry]);
      if (read !== undefined) return read;
      return cached ?? { state: 'timeout', text: undefined, items: 0, fetchedAt: this.#now() };
    } finally { clearTimeout(timer); }
  }
}
