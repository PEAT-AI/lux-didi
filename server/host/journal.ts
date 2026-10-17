import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../tools/redact.js';
import { hostLogEvent } from '../tools/host-events.js';

// The private debug journal: one local JSONL file per session under <dataDir>/debug/<day>/.
// It holds owner content (transcripts, instruction text, tool results), so it is owner-only:
// mode 0600 files in mode 0700 directories, verified the same way host.log verifies its own file,
// and never read back by the host. host.log stays content-free; this journal is its content twin.
// A journal failure is counted in host.log as debug_journal_error and never reaches the session.

export type JournalKind = 'live' | 'chat';
export const JOURNAL_KINDS: readonly JournalKind[] = ['live', 'chat'];
/** A tool result is capped here so one call can never flood a day file. */
export const JOURNAL_RESULT_LIMIT = 16 * 1024;
/** Retention: 30 days, and never more than 2 GB across the whole journal. */
export const JOURNAL_KEEP_DAYS = 30;
export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface JournalRecord {
  /** Omitted by callers that reach the journal from the tool layer; resolved from the session registry. */
  kind?: JournalKind;
  sessionId: string;
  generation?: number;
  event: string;
  [field: string]: unknown;
}

interface SessionState { kind: JournalKind; base: number; instructions: boolean }

/** Cut a long string to the journal limit, keeping the tail marker so the truncation is visible. */
export function capJournalText(text: string, limit = JOURNAL_RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

let buildSha: string | undefined;

/** The installed release commit, read exactly where the host reads its own runtime manifest. */
export function journalBuildSha(): string {
  if (buildSha !== undefined) return buildSha;
  buildSha = 'unknown';
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../../../../../didi-runtime.json', import.meta.url), 'utf8')) as { releaseCommit?: unknown };
    if (typeof manifest.releaseCommit === 'string' && /^[0-9a-f]{40}$/.test(manifest.releaseCommit)) buildSha = manifest.releaseCommit;
  } catch { /* A source start has no installed release metadata. */ }
  return buildSha;
}

/**
 * One private debug journal rooted at <dataDir>/debug. Writes are synchronous and best effort:
 * a rejected write is counted in host.log and dropped, never thrown into the session that wrote it.
 */
export class DebugJournal {
  readonly #root: string;
  readonly #dataDir: string;
  readonly #now: () => number;
  readonly #enabled: boolean;
  readonly #sessions = new Map<string, SessionState>();
  #day: string | undefined;
  #failures = 0;

  constructor(dataDir: string, options: { now?: () => number; enabled?: boolean } = {}) {
    this.#dataDir = dataDir;
    this.#root = join(dataDir, 'debug');
    this.#now = options.now ?? Date.now;
    this.#enabled = options.enabled !== false;
    this.#prepareRoot();
    this.prune();
  }

  get enabled(): boolean { return this.#enabled; }
  get dataDir(): string { return this.#dataDir; }
  get root(): string { return this.#root; }
  get failures(): number { return this.#failures; }

  /** The day directory the journal is currently writing into, always in ISO date form. */
  currentDay(): string { return dayOf(this.#now()); }

  write(record: JournalRecord): void {
    if (!this.#enabled) return;
    // An out-of-vocabulary record is dropped, not counted: only a filesystem failure is a journal error.
    if (!record || !SESSION_ID.test(record.sessionId) || !EVENT_NAME.test(record.event)) return;
    const generation = record.generation;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) return;
    const { kind, sessionId, event, ...rest } = record;
    const key = `${kind}:${sessionId}`;
    const now = this.#now();
    let state = this.#sessions.get(key);
    if (!state) {
      if (kind === undefined) return;
      state = { kind, base: now, instructions: false };
      this.#sessions.set(key, state);
    }
    // The composed instructions are the largest content block in the journal: once per session.
    if (event === 'session_start') {
      if (state.instructions) return;
      state.instructions = true;
    }
    const fields: Record<string, unknown> = event === 'session_start' ? { build: journalBuildSha() } : {};
    for (const [name, value] of Object.entries(rest)) {
      fields[name] = name === 'result' && typeof value === 'string' ? capJournalText(value) : value;
    }
    const line = JSON.stringify({
      t: new Date(now).toISOString(), mono: now - state.base, kind: state.kind, sessionId,
      ...(generation === undefined ? {} : { generation }), event, ...redactSecrets(fields),
    }) + '\n';
    this.#append(dayOf(now), `${state.kind}-${sessionId}.jsonl`, line);
  }

  /** Keep 30 days and at most 2 GB by deleting whole day directories, oldest first. */
  prune(): void {
    if (!this.#enabled) return;
    try {
      const days = this.#days();
      const cutoff = dayOf(this.#now() - JOURNAL_KEEP_DAYS * 86_400_000);
      for (const day of days) if (day < cutoff) this.#removeDay(day);
      let total = this.#days().reduce((sum, day) => sum + this.#dayBytes(day), 0);
      for (const day of this.#days()) {
        if (total <= JOURNAL_MAX_BYTES) break;
        total -= this.#dayBytes(day);
        this.#removeDay(day);
      }
    } catch { this.#fail('prune'); }
  }

  #prepareRoot(): void {
    if (!this.#enabled) return;
    try {
      mkdirSync(this.#root, { recursive: true, mode: 0o700 });
      const root = lstatSync(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('invalid journal directory');
    } catch { this.#fail('open'); }
  }

  #days(): string[] {
    return readdirSync(this.#root).filter(name => DAY.test(name)).sort();
  }

  #dayBytes(day: string): number {
    const directory = join(this.#root, day);
    try {
      return readdirSync(directory).reduce((sum, name) => {
        try { const stat = lstatSync(join(directory, name)); return sum + (stat.isFile() ? stat.size : 0); } catch { return sum; }
      }, 0);
    } catch { return 0; }
  }

  #removeDay(day: string): void {
    const directory = join(this.#root, day);
    for (const name of readdirSync(directory)) {
      try { unlinkSync(join(directory, name)); } catch { this.#fail('prune'); }
    }
    try { rmdirSync(directory); } catch { this.#fail('prune'); }
  }

  #append(day: string, file: string, line: string): void {
    try {
      if (this.#day !== day) {
        const directory = join(this.#root, day);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid journal day');
        // Retention runs at start and once per day, on the first write of the new day.
        if (this.#day !== undefined) this.prune();
        this.#day = day;
      }
      const path = join(this.#root, day, file);
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('invalid journal file');
        fchmodSync(fd, 0o600);
        writeSync(fd, line);
      } finally { closeSync(fd); }
    } catch { this.#fail('write'); }
  }

  #fail(code: 'open' | 'write' | 'prune'): void {
    this.#failures++;
    // Counted in host.log through the closed receipt; the journal never throws into a session.
    hostLogEvent({ event: 'debug_journal_error', code });
  }
}

let installed: DebugJournal | undefined;

/** Install the process journal. Called once, when the owner's live profile resolves the data directory. */
export function configureDebugJournal(dataDir: string, enabled: boolean, options: { now?: () => number } = {}): DebugJournal {
  // The profile reloads on every save; the installed journal keeps its session baselines.
  if (installed && installed.dataDir === dataDir && installed.enabled === enabled) return installed;
  installed = new DebugJournal(dataDir, { enabled, ...options });
  return installed;
}

export function currentDebugJournal(): DebugJournal | undefined { return installed; }

/** Route one record to the installed journal, if any. Silent when no journal is installed or enabled. */
export function journalRecord(record: JournalRecord): void { installed?.write(record); }

/** Test seam: drop the installed journal so a test never writes through the owner's own directory. */
export function resetDebugJournal(): void { installed = undefined; }
