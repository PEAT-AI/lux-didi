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
import { CONNECTOR_SIGN_IN_REASONS } from '../prompt/runtime-context.js';

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

/** The one closed set the runtime line and this note share, so the two can never name different codes. */
export const SIGN_IN_REASONS = CONNECTOR_SIGN_IN_REASONS;

/**
 * The one line at call start when a connector waits on a sign-in only the owner can finish. It is said
 * once, in the instruction, so a later turn never repeats it.
 */
export function signInNote(endpoints: readonly unknown[]): string | undefined {
  const waiting = endpoints.some(value => {
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    // Mongoose is the one connector the owner can sign in to, so no other connector is announced.
    if (row.connector !== 'mongoose') return false;
    // The host report names one of these closed codes; the browser projection names needs_sign_in.
    return SIGN_IN_REASONS.has(String(row.reasonCode)) || SIGN_IN_REASONS.has(String(row.error));
  });
  if (!waiting) return undefined;
  return 'Mongoose is waiting on a sign-in, so company knowledge cannot be read yet. Mention it only when an answer needs company knowledge, and say the Sign in button is in Settings.';
}

/** The three Mongoose endpoint names, as the owner hears them. Closed, never a provider payload. */
const MONGOOSE_LABELS: Readonly<Record<string, string>> = { crm: 'Mongoose CRM', knowledge: 'Mongoose knowledge', data: 'Mongoose data' };

/** The owner's first name from the proven account, for the one sentence; never the whole address. */
function firstName(identity: unknown): string | undefined {
  const row = identity && typeof identity === 'object' ? identity as Record<string, unknown> : {};
  const value = typeof row['value'] === 'string' && row['proven'] === true && row['match'] !== false ? row['value'] : undefined;
  const local = value?.split('@')[0]?.split(/[.+_-]/)[0];
  return local !== undefined && local.length > 0 ? local[0]!.toUpperCase() + local.slice(1) : undefined;
}

/** "a", "a and b", "a, b and c": one closed list, so the sentence never carries a name a model wrote. */
function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/**
 * C-SIGNIN-LIVE: the one sentence Naya says on the call after a Mongoose endpoint came up, and never
 * again. Each call compares the Mongoose rows with the previous call's, so a connector that connected
 * between two calls is announced once, and the first call of a session learns silently.
 */
export class ConnectorNotes {
  #connected: Set<string> | undefined;

  take(endpoints: readonly unknown[]): string | undefined {
    const rows = (Array.isArray(endpoints) ? endpoints : []).flatMap(value => {
      const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      if (row['connector'] !== 'mongoose') return [];
      const name = typeof row['id'] === 'string' ? row['id'].replace(/^mongoose-/, '') : undefined;
      const label = name !== undefined ? MONGOOSE_LABELS[name] : undefined;
      return label === undefined ? [] : [{ label, connected: row['state'] === 'connected', identity: row['identity'] }];
    });
    const connected = new Set(rows.filter(row => row.connected).map(row => row.label));
    const before = this.#connected;
    this.#connected = connected;
    if (before === undefined) return undefined;
    const fresh = rows.filter(row => row.connected && !before.has(row.label));
    if (fresh.length === 0) return undefined;
    const as = firstName(fresh[0]!.identity);
    const said = fresh.map(row => `${row.label} is now connected${as === undefined ? '' : ` as ${as}`}`);
    const already = rows.filter(row => row.connected && before.has(row.label)).map(row => row.label.replace('Mongoose ', ''));
    const rest = already.length === 0 ? '' : `; ${andList(already)} ${already.length === 1 ? 'was' : 'were'} already connected`;
    return `${said.join(' and ')}${rest}.`;
  }
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
export type CalendarDigestState = CalendarDigestReadState | 'stale' | 'absent';
/** One cached read and the state a start reports for it. `stale` text never rides an assembly. */
export type CalendarDigestSnapshot = Omit<CalendarDigestReadResult, 'state'> & { readonly state: CalendarDigestState };

/** How long a cached digest may answer a call start. */
export const calendarDigestFreshMs = 30 * 60 * 1000;
/** How often the background owner refreshes the digest. */
export const calendarDigestRefreshMs = 15 * 60 * 1000;
/** 556: the longest one background digest read may hold the owner before it is cut and said to have timed out. */
export const calendarDigestReadMs = 10 * 1000;
/** L2: the closed reasons a background digest read is reported under, and the receipt one read leaves in host.log. */
export type CalendarDigestRefreshReason = 'start' | 'timer' | 'retry';
export type CalendarDigestRefreshReceipt = { readonly event: 'calendar_digest_refreshed'; readonly reason: CalendarDigestRefreshReason; readonly ms: number };
/** 556: the read that outlived its deadline, reported as one closed line rather than silence. */
export type CalendarDigestTimeoutReceipt = { readonly event: 'calendar_digest_timeout'; readonly reason: CalendarDigestRefreshReason; readonly ms: number };
export type CalendarDigestLogReceipt = CalendarDigestRefreshReceipt | CalendarDigestTimeoutReceipt;

export class CalendarDigestCache {
  readonly #read: (signal: AbortSignal) => Promise<CalendarDigestReadResult>;
  readonly #now: () => number;
  readonly #timeZone: string;
  readonly #intervalMs: number;
  readonly #log: ((receipt: CalendarDigestLogReceipt) => void) | undefined;
  #snapshot: CalendarDigestReadResult | undefined;
  #inflight: Promise<CalendarDigestReadResult> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #readAbort: AbortController | undefined;
  #retried = false;
  #closed = false;

  constructor(read: (signal: AbortSignal) => Promise<CalendarDigestReadResult>, options: { readonly now: () => number; readonly timeZone: string; readonly intervalMs?: number; readonly log?: (receipt: CalendarDigestLogReceipt) => void }) {
    this.#read = read;
    this.#now = options.now;
    this.#timeZone = options.timeZone;
    this.#intervalMs = options.intervalMs ?? calendarDigestRefreshMs;
    this.#log = options.log;
  }

  /** The host's background owner: one read now, then every 15 minutes until `stop`. Off the request path. */
  begin(): void {
    if (this.#timer !== undefined) return;
    void this.refresh('start');
    this.#timer = setInterval(() => { void this.refresh('timer'); }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    // 556: the host's exit also ends the read it started, so the connector has nothing left to answer.
    this.#readAbort?.abort();
    this.#readAbort = undefined;
  }

  /** One read, deduplicated: every caller inside the same window shares the read already in flight. */
  refresh(reason?: CalendarDigestRefreshReason): Promise<CalendarDigestReadResult> {
    const inflight = this.#inflight;
    if (inflight !== undefined) return inflight;
    const startedAt = this.#now();
    const abort = new AbortController();
    this.#readAbort = abort;
    let expired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise<CalendarDigestReadResult>(resolve => {
      deadline = setTimeout(() => { expired = true; abort.abort(); }, calendarDigestReadMs);
      deadline.unref?.();
      abort.signal.addEventListener('abort', () => resolve({ state: 'timeout', text: undefined, items: 0, fetchedAt: this.#now() }), { once: true });
    });
    const read = this.#read(abort.signal)
      .catch((): CalendarDigestReadResult => ({ state: 'failed', text: undefined, items: 0, fetchedAt: this.#now() }));
    const pending = Promise.race([read, cut])
      .then(result => {
        if (deadline !== undefined) clearTimeout(deadline);
        if (this.#readAbort === abort) this.#readAbort = undefined;
        if (this.#closed) return result;
        this.#snapshot = result; this.#inflight = undefined;
        // L2: only the caller that started this read reports it, so a joined read never doubles a line
        // and every line names the edge that owed the read.
        if (reason === undefined) return result;
        // 556: a read the deadline cut says so, instead of passing for a read that answered `failed`.
        if (expired) {
          this.#log?.({ event: 'calendar_digest_timeout', reason, ms: Math.max(0, this.#now() - startedAt) });
          // C-CAL8: the call started with no day, so one background read is asked for at once and the digest
          // it lands with answers the next assembly rather than waiting out the refresh timer.
          if (!this.#retried) {
            this.#retried = true;
            void this.refresh('retry').catch(() => undefined);
          }
        } else {
          this.#retried = false;
          this.#log?.({ event: 'calendar_digest_refreshed', reason, ms: Math.max(0, this.#now() - startedAt) });
        }
        return result;
      });
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
   * What a call start uses: the digest the cache already holds, with no wait at all. A connector read in
   * flight at create belongs to the next start, never to this one, so a start that finds no snapshot says
   * `absent` instead of an empty day, and one that finds an aged out snapshot says `stale` with its own
   * fetch time and kicks a refresh for the next start.
   */
  async forStart(): Promise<CalendarDigestSnapshot> {
    return this.current() ?? { state: 'absent', text: undefined, items: 0, fetchedAt: this.#now() };
  }
}
