/**
 * Owner memory import and the ranked standing-memory read model.
 *
 * The import writes a reviewed JSONL of distilled owner notes into the domain
 * store as `ordinary` entries, so they reach every Live and Chat prompt. This
 * module is content-free by construction: every plan and result carries counts,
 * ids and stable codes, never note text.
 */
import { createHash } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import type { Transaction } from '../contracts/storage.js';

/** Idempotency scope of an imported note, and the standing-memory selector. */
export const IMPORT_PROVIDER = 'import-history';
/** Provider of an imported note's own provenance rows; never the idempotency scope. */
export const IMPORT_PROVENANCE_PROVIDER = 'import-history-provenance';
/** One session per import run; it holds the run's entries so a rollback can find them. */
export const IMPORT_SESSION_TITLE = 'Imported history';
const IMPORT_TIME_ZONE = 'UTC';

export type ImportErrorCode = 'invalid_input' | 'invalid_arguments' | 'run_not_found' | 'writer_locked' | 'backup_failed';
export class MemoryImportError extends Error {
  constructor(readonly code: ImportErrorCode, detail?: string) {
    super(`memory import: ${code}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'MemoryImportError';
  }
}

export type MemoryKind = 'fact' | 'preference' | 'task';
export type MemoryStatus = 'current' | 'dated' | 'open';
export type MemoryConfidence = 'high' | 'medium' | 'low';
export interface ImportProvenance { readonly sessionId: string; readonly date: string; readonly key: string }
export interface ImportItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly label: string;
  readonly topic: string;
  readonly status: MemoryStatus;
  readonly importance: 1 | 2 | 3;
  readonly confidence: MemoryConfidence;
  readonly capturedAt: string;
  readonly text: string;
  readonly sources: readonly ImportProvenance[];
}
export interface ImportRejection { readonly line: number; readonly code: string }
export interface ParsedImport { readonly items: readonly ImportItem[]; readonly rejected: readonly ImportRejection[] }

const itemKeys = ['id', 'kind', 'label', 'topic', 'status', 'importance', 'confidence', 'capturedAt', 'text', 'sources'] as const;
const provenanceKeys = ['sessionId', 'date', 'key'] as const;
const kinds: readonly MemoryKind[] = ['fact', 'preference', 'task'];
const statuses: readonly MemoryStatus[] = ['current', 'dated', 'open'];
const confidences: readonly MemoryConfidence[] = ['high', 'medium', 'low'];
/**
 * The classified-content detector already applied by `rememberOwnerNote`
 * (server/live/index.ts): a note the owner marked private or sensitive never
 * becomes an ordinary entry through an import either.
 */
const classified = /^(?:privately\b|(?:this\s+)?(?:is\s+|as\s+)?(?:private|sensitive)\b)/i;

export interface ScreenedText {
  /** The text to store: what the import writes, never the raw input. */
  readonly text: string;
  /** A refusal code, or null when the text may be stored. */
  readonly refused: string | null;
}

/**
 * The one content seam every imported note text passes through, and the only
 * place the import decides what may be stored. K1's secret redactor is pointed
 * at this function when it lands, so returning the screened text here is enough
 * for every import path to inherit it. Today the text is unchanged and the
 * classified detector refuses it.
 */
export function screenImportText(text: string): ScreenedText {
  return classified.test(text.trim()) ? { text, refused: 'private_memory_unsupported' } : { text, refused: null };
}
const control = /[\u0000-\u001f\u007f]/;
const dateShape = /^\d{4}-\d{2}-\d{2}$/;
const itemIdShape = /^[0-9a-f]{16}$/;
const topicShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TEXT_CHARS = 500;
const MAX_TAG_CHARS = 64;
const MAX_PROVENANCE = 8;

/** A calendar date, not a rolled-over one: `2026-02-31` is rejected, not coerced. */
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !dateShape.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function isTag(value: unknown, max = MAX_TAG_CHARS): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !control.test(value) && value.trim() === value;
}

/** The note text is stored and sent to the model as one line, so it never carries breaks. */
function isNoteText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_TEXT_CHARS
    && !control.test(value) && value.trim().length >= 1;
}

function exactlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(raw);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

function item(raw: unknown): ImportItem | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid_field';
  const value = raw as Record<string, unknown>;
  if (!exactlyKeys(value, itemKeys)) return 'unknown_field';
  if (typeof value['id'] !== 'string' || !itemIdShape.test(value['id'])) return 'invalid_field';
  if (typeof value['kind'] !== 'string' || !kinds.includes(value['kind'] as MemoryKind)) return 'invalid_field';
  if (typeof value['status'] !== 'string' || !statuses.includes(value['status'] as MemoryStatus)) return 'invalid_field';
  if (typeof value['confidence'] !== 'string' || !confidences.includes(value['confidence'] as MemoryConfidence)) return 'invalid_field';
  if (!isTag(value['label'])) return 'invalid_field';
  // A topic is a single token: the source note carries it as `topic:<topic>`, so a space would end it.
  if (typeof value['topic'] !== 'string' || !topicShape.test(value['topic'])) return 'invalid_field';
  const importance = value['importance'];
  if (typeof importance !== 'number' || !Number.isInteger(importance) || importance < 1 || importance > 3) return 'invalid_field';
  if (!isDate(value['capturedAt'])) return 'invalid_field';
  if (!isNoteText(value['text'])) return 'invalid_field';
  const screened = screenImportText(value['text'] as string);
  if (screened.refused !== null) return screened.refused;
  const rawSources = value['sources'];
  if (!Array.isArray(rawSources) || rawSources.length > MAX_PROVENANCE) return 'invalid_field';
  const sources: ImportProvenance[] = [];
  for (const source of rawSources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return 'invalid_field';
    const entry = source as Record<string, unknown>;
    if (!exactlyKeys(entry, provenanceKeys)) return 'unknown_field';
    if (!isTag(entry['sessionId'], 128) || !isTag(entry['key'], 128) || !isDate(entry['date'])) return 'invalid_field';
    sources.push({ sessionId: entry['sessionId'] as string, date: entry['date'], key: entry['key'] as string });
  }
  return Object.freeze({
    id: value['id'] as string, kind: value['kind'] as MemoryKind, label: value['label'] as string,
    topic: value['topic'] as string, status: value['status'] as MemoryStatus,
    importance: importance as 1 | 2 | 3, confidence: value['confidence'] as MemoryConfidence,
    capturedAt: value['capturedAt'] as string, text: screened.text, sources: Object.freeze(sources),
  });
}

/** Parse one JSON object per line. A rejected line is reported by number and code only. */
export function parseImportFile(content: string): ParsedImport {
  const items: ImportItem[] = [], rejected: ImportRejection[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { rejected.push({ line: index + 1, code: 'invalid_json' }); continue; }
    const parsed = item(raw);
    if (typeof parsed === 'string') { rejected.push({ line: index + 1, code: parsed }); continue; }
    if (seen.has(parsed.id)) { rejected.push({ line: index + 1, code: 'duplicate_id' }); continue; }
    seen.add(parsed.id);
    items.push(parsed);
  }
  return { items: Object.freeze(items), rejected: Object.freeze(rejected) };
}

/**
 * The entry id is derived from the idempotency key, never random: after an owner
 * deletion the source reference is gone, so only the id ties a re-import to the
 * tombstone that must keep the note deleted.
 */
export function importedEntryId(itemId: string): string {
  const hex = createHash('sha256').update(`${IMPORT_PROVIDER}:${itemId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const capturedAtMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface ImportPlan {
  readonly runId: string;
  /** Items this run writes, in file order. */
  readonly accepted: readonly ImportItem[];
  /** Older item of a repeated topic+label: reported, never written. */
  readonly superseded: readonly string[];
  /** Already present under `(provider='import-history', externalId)`. */
  readonly existing: readonly string[];
  /** Deleted by the owner: a tombstone keeps it out. */
  readonly tombstoned: readonly string[];
  /** Past the `--max-items` cap: not written by this run. */
  readonly limited: readonly string[];
  readonly rejected: readonly ImportRejection[];
}

function present(tx: Transaction, externalId: string): boolean {
  return tx.get(
    `SELECT 1 AS hit FROM source_references WHERE owner_kind='entry' AND provider=? AND external_id=? LIMIT 1`,
    [IMPORT_PROVIDER, externalId],
  ) !== undefined;
}

function tombstoned(tx: Transaction, entryId: string): boolean {
  return tx.get('SELECT 1 AS hit FROM entry_tombstones WHERE entry_id=?', [entryId]) !== undefined;
}

/**
 * Decide what a run would write, reading only. Supersession is by topic+label,
 * newest `capturedAt` wins; ties keep the earlier line, so a re-run of the same
 * file is stable.
 */
export function planImport(tx: Transaction, parsed: ParsedImport, runId: string, maxItems: number | undefined): ImportPlan {
  const newest = new Map<string, ImportItem>();
  for (const entry of parsed.items) {
    const key = `${entry.topic}\u0000${entry.label}`;
    const prior = newest.get(key);
    if (prior === undefined || entry.capturedAt > prior.capturedAt) newest.set(key, entry);
  }
  const accepted: ImportItem[] = [], superseded: string[] = [], existing: string[] = [], killed: string[] = [], limited: string[] = [];
  for (const entry of parsed.items) {
    if (tombstoned(tx, importedEntryId(entry.id))) { killed.push(entry.id); continue; }
    if (present(tx, entry.id)) { existing.push(entry.id); continue; }
    if (newest.get(`${entry.topic}\u0000${entry.label}`) !== entry) { superseded.push(entry.id); continue; }
    if (maxItems !== undefined && accepted.length >= maxItems) { limited.push(entry.id); continue; }
    accepted.push(entry);
  }
  return {
    runId, accepted: Object.freeze(accepted), superseded: Object.freeze(superseded),
    existing: Object.freeze(existing), tombstoned: Object.freeze(killed), limited: Object.freeze(limited),
    rejected: parsed.rejected,
  };
}

export interface ImportWrite { readonly sessionId: string; readonly entryIds: readonly string[] }

/**
 * Write an accepted plan through the domain module: one ordinary session per run
 * and one ordinary entry per item, each carrying its note as a source reference.
 */
export function applyImport(tx: Transaction, plan: ImportPlan, clock: memory.Clock): ImportWrite {
  const startedAt = clock.now();
  const session = memory.createSession(tx, { title: IMPORT_SESSION_TITLE, startedAt, timeZone: IMPORT_TIME_ZONE }, clock);
  labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'ordinary' }, startedAt);
  const entryIds: string[] = [];
  for (const entry of plan.accepted) {
    const capturedAt = capturedAtMs(entry.capturedAt);
    const written = memory.appendEntry(tx, {
      sessionId: session.id, text: entry.text, capturedAt, timeZone: IMPORT_TIME_ZONE, role: 'system',
      source: {
        label: `${IMPORT_PROVIDER} ${plan.runId}`, provider: IMPORT_PROVIDER, externalId: entry.id,
        sourceTimestamp: capturedAt, availability: 'present',
        note: `kind:${entry.kind} topic:${entry.topic} status:${entry.status} importance:${entry.importance}`,
      },
    }, clock, importedEntryId(entry.id));
    labels.correct(tx, { subject: { kind: 'entry', id: written.id }, expectedRevision: 0, dataClass: 'ordinary' }, startedAt);
    // The item's own history stays a source reference: it is never sent to a model.
    for (const source of entry.sources) {
      memory.addSourceReference(tx, {
        ownerKind: 'entry', ownerId: written.id, label: `${IMPORT_PROVENANCE_PROVIDER} ${plan.runId}`,
        provider: IMPORT_PROVENANCE_PROVIDER, accountId: source.sessionId, externalId: `${entry.id}:${source.key}`,
        sourceTimestamp: capturedAtMs(source.date), availability: 'present', note: null,
      });
    }
    entryIds.push(written.id);
  }
  return { sessionId: session.id, entryIds: Object.freeze(entryIds) };
}

/** Every entry one run wrote, found by the run label on its import source references. */
export function runEntryIds(tx: Transaction, runId: string): string[] {
  return tx.all(
    `SELECT DISTINCT owner_id FROM source_references
      WHERE owner_kind='entry' AND provider=? AND source_label=? ORDER BY owner_id ASC`,
    [IMPORT_PROVIDER, `${IMPORT_PROVIDER} ${runId}`],
  ).map(row => String(row['owner_id']));
}

export interface StandingMemoryItem {
  readonly id: string;
  readonly text: string;
  readonly status: MemoryStatus;
  readonly capturedAt: string;
  readonly kind: MemoryKind;
  readonly topic: string;
  readonly importance: number;
}

const noteShape = /^kind:(fact|preference|task) topic:(\S+) status:(current|dated|open) importance:([1-3])$/;
const statusRank: Record<MemoryStatus, number> = { open: 0, current: 1, dated: 2 };

/**
 * The standing-memory set: ordinary imported notes, ranked by importance, then
 * status (open, current, dated), then newest capture. Entry id breaks ties, so
 * the order never depends on uuid order.
 */
export function listStandingMemory(tx: Transaction): StandingMemoryItem[] {
  const items: StandingMemoryItem[] = [];
  const rows = tx.all(
    `SELECT e.id AS entry_id, e.session_id AS session_id, e.text AS text, e.captured_at AS captured_at, s.note AS note
       FROM entries e JOIN source_references s ON s.owner_id = e.id AND s.owner_kind = 'entry'
      WHERE s.provider = ? ORDER BY e.id ASC`,
    [IMPORT_PROVIDER],
  );
  for (const row of rows) {
    const note = noteShape.exec(String(row['note'] ?? ''));
    if (!note) continue;
    const id = String(row['entry_id']);
    if (labels.current(tx, { kind: 'entry', id }).dataClass !== 'ordinary') continue;
    if (labels.current(tx, { kind: 'session', id: String(row['session_id']) }).dataClass !== 'ordinary') continue;
    items.push({
      id, text: String(row['text']), status: note[3] as MemoryStatus, capturedAt: toDate(Number(row['captured_at'])),
      kind: note[1] as MemoryKind, topic: note[2]!, importance: Number(note[4]),
    });
  }
  return items.sort((a, b) => b.importance - a.importance || statusRank[a.status] - statusRank[b.status]
    || (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
