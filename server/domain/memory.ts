import { forgetHistorySessions } from './history-lifecycle.js';
import { notFound, badRequest } from './contract.js';
import type { Transaction, SQLRow, SQLValue } from './contract.js';
import { historySessionEvidence, type HistoryEligibility } from './history-lifecycle.js';
import { searchItems, ftsExpression } from './memory-items.js';
import type { DataClass } from '../adapters/model/types.js';
import { assertLimit, assertTimeZone, fold, newId, requireText, tokenize } from './util.js';

export type EntryRole = 'user' | 'assistant' | 'system';
export type SourceAvailability = 'present' | 'missing';
export type OwnerKind = 'session' | 'entry' | 'commitment';

export interface SessionRecord {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  timeZone: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface EntryRecord {
  id: string;
  sessionId: string;
  sequence: number;
  role: EntryRole;
  text: string;
  capturedAt: number;
  timeZone: string;
  revision: number;
}

export interface SourceRefRecord {
  id: string;
  ownerKind: OwnerKind;
  ownerId: string;
  label: string;
  provider: string | null;
  accountId: string | null;
  externalId: string | null;
  sourceTimestamp: number | null;
  availability: SourceAvailability;
  note: string | null;
}

export interface RecallHit {
  sessionId: string;
  entryId: string;
  snippet: string;
  score: number;
  sourceRefs: SourceRefRecord[];
  sourceTimestamp: number;
}

export interface RecallResult {
  hits: RecallHit[];
  totalMatches: number;
  truncated: boolean;
}

export interface Clock {
  /** UTC epoch ms. */
  now(): number;
}

type Row = SQLRow;

function mapSession(r: Row): SessionRecord {
  return {
    id: String(r.id),
    title: String(r.title),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    timeZone: String(r.time_zone),
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapEntry(r: Row): EntryRecord {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    sequence: Number(r.sequence),
    role: String(r.role) as EntryRole,
    text: String(r.text),
    capturedAt: Number(r.captured_at),
    timeZone: String(r.time_zone),
    revision: Number(r.revision),
  };
}

function mapSourceRef(r: Row): SourceRefRecord {
  return {
    id: String(r.id),
    ownerKind: String(r.owner_kind) as OwnerKind,
    ownerId: String(r.owner_id),
    label: String(r.source_label),
    provider: r.provider === null ? null : String(r.provider),
    accountId: r.account_id === null ? null : String(r.account_id),
    externalId: r.external_id === null ? null : String(r.external_id),
    sourceTimestamp: r.source_timestamp === null ? null : Number(r.source_timestamp),
    availability: String(r.availability) as SourceAvailability,
    note: r.note === null ? null : String(r.note),
  };
}

export interface CreateSessionInput {
  title: string;
  startedAt: number;
  endedAt?: number | null;
  timeZone: string;
}

export function createSession(
  tx: Transaction,
  input: CreateSessionInput,
  clock: Clock,
  id: string = newId(),
): SessionRecord {
  const title = requireText(input.title, 'title');
  assertTimeZone(input.timeZone);
  const now = clock.now();
  tx.run(
    `INSERT INTO sessions (id,title,started_at,ended_at,time_zone,revision,created_at,updated_at)
     VALUES (?,?,?,?,?,1,?,?)`,
    [id, title, input.startedAt, input.endedAt ?? null, input.timeZone, now, now],
  );
  return readSession(tx, id);
}

// The list is complete and deterministic: the wire operation exposes no cursor
// input, so a truncated list with nextCursor:null would present partial durable
// history as exhausted. Pagination is a future continuation contract.
export function listSessions(tx: Transaction): SessionRecord[] {
  return tx.all(`SELECT * FROM sessions ORDER BY started_at DESC, id ASC`, []).map(mapSession);
}

export function readSession(tx: Transaction, id: string): SessionRecord {
  const row = tx.get(`SELECT * FROM sessions WHERE id = ?`, [id]);
  if (!row) notFound(`unknown session ${id}`, { id });
  return mapSession(row);
}

export function readEntry(tx: Transaction, id: string): EntryRecord {
  const row = tx.get(`SELECT * FROM entries WHERE id = ?`, [id]);
  if (!row) notFound(`unknown entry ${id}`, { id });
  return mapEntry(row);
}

export function entries(tx: Transaction, sessionId: string): EntryRecord[] {
  readSession(tx, sessionId);
  return tx
    .all(`SELECT * FROM entries WHERE session_id = ? ORDER BY sequence ASC`, [sessionId])
    .map(mapEntry);
}

export interface AddSourceRefInput {
  ownerKind: OwnerKind;
  ownerId: string;
  label: string;
  externalId?: string | null | undefined;
  sourceTimestamp?: number | null | undefined;
  availability: SourceAvailability;
  provider?: string | null | undefined;
  accountId?: string | null | undefined;
  note?: string | null | undefined;
}

export interface AppendEntryInput {
  sessionId: string;
  text: string;
  capturedAt: number;
  timeZone: string;
  role?: EntryRole | undefined;
  source?: (Omit<AddSourceRefInput, 'ownerKind' | 'ownerId'> & { id?: string | undefined }) | undefined;
}

export function appendEntry(
  tx: Transaction,
  input: AppendEntryInput,
  clock: Clock,
  id: string = newId(),
): EntryRecord {
  void clock;
  const text = requireText(input.text, 'text');
  assertTimeZone(input.timeZone);
  readSession(tx, input.sessionId);
  const role = input.role ?? 'user';
  const next = tx.get(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM entries WHERE session_id = ?`,
    [input.sessionId],
  );
  const sequence = Number(next?.next ?? 1);
  tx.run(
    `INSERT INTO entries (id,session_id,sequence,role,text,captured_at,time_zone,revision)
     VALUES (?,?,?,?,?,?,?,1)`,
    [id, input.sessionId, sequence, role, text, input.capturedAt, input.timeZone],
  );
  if (input.source) {
    addSourceReference(
      tx,
      { ...input.source, ownerKind: 'entry', ownerId: id },
      input.source.id,
    );
  }
  return mapEntry(tx.get(`SELECT * FROM entries WHERE id = ?`, [id])!);
}

export function addSourceReference(
  tx: Transaction,
  input: AddSourceRefInput,
  id: string = newId(),
): SourceRefRecord {
  const label = requireText(input.label, 'label');
  if (input.availability !== 'present' && input.availability !== 'missing') {
    badRequest('availability must be present or missing');
  }
  tx.run(
    `INSERT INTO source_references
       (id,owner_kind,owner_id,source_label,provider,account_id,external_id,source_timestamp,availability,note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.ownerKind,
      input.ownerId,
      label,
      input.provider ?? null,
      input.accountId ?? null,
      input.externalId ?? null,
      input.sourceTimestamp ?? null,
      input.availability,
      input.note ?? null,
    ],
  );
  return mapSourceRef(tx.get(`SELECT * FROM source_references WHERE id = ?`, [id])!);
}

/** One read for a whole page of hits, in the same order the single-owner read returns. */
function sourceReferencesFor(tx: Transaction, ownerIds: readonly string[]): Map<string, SourceRefRecord[]> {
  const byOwner = new Map<string, SourceRefRecord[]>();
  if (ownerIds.length === 0) return byOwner;
  const rows = tx.all(
    `SELECT * FROM source_references WHERE owner_id IN (${ownerIds.map(() => '?').join(',')}) ORDER BY owner_id ASC, id ASC`,
    ownerIds,
  );
  for (const row of rows) {
    const ref = mapSourceRef(row);
    const list = byOwner.get(ref.ownerId) ?? [];
    list.push(ref);
    byOwner.set(ref.ownerId, list);
  }
  return byOwner;
}

export function sourceReferences(tx: Transaction, ownerId: string): SourceRefRecord[] {
  return tx
    .all(`SELECT * FROM source_references WHERE owner_id = ? ORDER BY id ASC`, [ownerId])
    .map(mapSourceRef);
}

/** A real remember kind when the owner gave one, `note` when none was given. */
export type EntryKind = 'fact' | 'preference' | 'task' | 'note';
/** Where a stored memory came from, read once from the domain's own source reference. */
export type EntryOrigin = 'live-voice' | 'chat' | 'page' | 'unknown';

const REMEMBER_KIND = /(?:^|\s)kind:(fact|preference|task)(?:\s|$)/i;
const originToken = (token: string, value: string) =>
  new RegExp(`(?:^|[^a-z])${value}(?:[^a-z]|$)`).test(token);

/**
 * The real remember kind carried by the Live `remember_note` source note, or
 * `note` when no source recorded one. Derived once here, never in the client.
 */
export function entryKind(sourceRefs: readonly SourceRefRecord[]): EntryKind {
  for (const ref of sourceRefs) {
    const match = REMEMBER_KIND.exec(ref.note ?? '');
    if (match) return match[1]!.toLowerCase() as EntryKind;
  }
  return 'note';
}

/**
 * The entry's origin from its stored source reference: Live voice, chat, page,
 * or `unknown` when no source reference records one.
 */
export function entryOrigin(sourceRefs: readonly SourceRefRecord[]): EntryOrigin {
  for (const ref of sourceRefs) {
    if (ref.provider === 'live-voice') return 'live-voice';
    const token = `${ref.provider ?? ''} ${ref.label}`.toLowerCase();
    if (originToken(token, 'chat')) return 'chat';
    if (originToken(token, 'page')) return 'page';
  }
  return 'unknown';
}

/** Upper bound on one trusted batch resolution request. */
export const MAX_RESOLVE_ENTRIES = 32;

export interface ResolvedEntryRecord {
  entryId: string;
  sessionId: string;
  text: string;
  role: EntryRole;
  capturedAt: number;
  sourceTimestamp: number | null;
  sourceRefs: SourceRefRecord[];
}

/**
 * Indexed batch resolution by exact id for one trusted in-process selection.
 * Two `IN` reads plus one parent-session `IN` read: never a full entries scan and
 * never a per-record transaction loop. A requested id is never dropped; an
 * unknown entry id or a missing parent session is a typed NOT_FOUND.
 */
export function resolveEntries(tx: Transaction, ids: readonly string[]): ResolvedEntryRecord[] {
  if (!Array.isArray(ids) || ids.length > MAX_RESOLVE_ENTRIES) badRequest('entryIds must be a bounded array');
  if (ids.length === 0) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim().length === 0) badRequest('entry ids must be non-empty strings');
    if (seen.has(id)) badRequest('entry ids must be unique');
    seen.add(id);
  }
  const marks = ids.map(() => '?').join(',');
  const found = new Map(tx.all(`SELECT * FROM entries WHERE id IN (${marks})`, ids).map((r) => [String(r.id), mapEntry(r)] as const));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) notFound('unknown entry ids', { ids: missing });
  const sessionIds = [...new Set(ids.map((id) => found.get(id)!.sessionId))];
  const sessionMarks = sessionIds.map(() => '?').join(',');
  const sessions = new Set(tx.all(`SELECT id FROM sessions WHERE id IN (${sessionMarks})`, sessionIds).map((r) => String(r.id)));
  const missingSessions = sessionIds.filter((id) => !sessions.has(id));
  if (missingSessions.length) notFound('unknown parent sessions', { ids: missingSessions });
  const refs = new Map<string, SourceRefRecord[]>();
  for (const row of tx.all(`SELECT * FROM source_references WHERE owner_kind='entry' AND owner_id IN (${marks}) ORDER BY id ASC`, ids)) {
    const ref = mapSourceRef(row);
    const list = refs.get(ref.ownerId) ?? [];
    list.push(ref);
    refs.set(ref.ownerId, list);
  }
  return ids.map((id) => {
    const entry = found.get(id)!;
    const sourceRefs = refs.get(id) ?? [];
    return {
      entryId: entry.id,
      sessionId: entry.sessionId,
      text: entry.text,
      role: entry.role,
      capturedAt: entry.capturedAt,
      // The Domain owns no single source timestamp; an aggregate is left null so
      // an earliest source-ref time is never presented as the record's time.
      sourceTimestamp: null,
      sourceRefs,
    };
  });
}

function snippetFor(text: string, tokens: string[]): string {
  const folded = fold(text);
  let at = -1;
  for (const t of tokens) {
    const i = folded.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (text.length <= 160) return text;
  const from = at < 0 ? 0 : Math.max(0, at - 40);
  const to = Math.min(text.length, from + 160);
  return `${from > 0 ? '\u2026' : ''}${text.slice(from, to)}${to < text.length ? '\u2026' : ''}`;
}

export interface RecallOptions {
  readonly eligibility?: 'ordinary-entry-and-parent';
  /** The data classes the caller's route admits; the entry's and its parent's own labels decide. */
  readonly classes?: readonly DataClass[];
}

/** A search reads at most this many matching rows; the count of matches still covers the whole index. */
export const RECALL_CANDIDATES = 200;

/** The start block's own admission rule, kept as one predicate so the count and the hits agree. */
const ENTRY_AND_PARENT_ORDINARY = "el.data_class='ordinary' AND pl.data_class='ordinary'";

/** An entry is admitted by the most restrictive of its own and its parent's current label, never by an absent one. */
function classPredicate(classes: readonly DataClass[]): { sql: string; params: SQLValue[] } {
  return {
    sql: `(CASE WHEN el.data_class IS NULL OR pl.data_class IS NULL THEN 'unknown'
        WHEN el.data_class='sensitive' OR pl.data_class='sensitive' THEN 'sensitive'
        WHEN el.data_class='private' OR pl.data_class='private' THEN 'private'
        ELSE 'ordinary' END) IN (${classes.map(() => '?').join(',')})`,
    params: [...classes],
  };
}

/**
 * Deterministic keyword + recency recall. Eligibility precedes ranking and the result limit.
 * D8: the candidates come from the entries FTS index, bounded, instead of a fold over every entry.
 */
export function recall(tx: Transaction, query: string, limit = 20, options: RecallOptions = {}): RecallResult {
  assertLimit(limit);
  const tokens = tokenize(typeof query === 'string' ? query : '');
  if (tokens.length === 0) return { hits: [], totalMatches: 0, truncated: false };
  const from = `FROM entries_fts
      JOIN entries e ON e.rowid = entries_fts.rowid
      JOIN sessions s ON s.id = e.session_id
      LEFT JOIN routing_labels el ON el.subject_kind='entry' AND el.subject_id=e.id
        AND el.revision=(SELECT MAX(revision) FROM routing_labels WHERE subject_kind='entry' AND subject_id=e.id)
      LEFT JOIN routing_labels pl ON pl.subject_kind='session' AND pl.subject_id=s.id
        AND pl.revision=(SELECT MAX(revision) FROM routing_labels WHERE subject_kind='session' AND subject_id=s.id)`;
  const params: SQLValue[] = [ftsExpression(tokens)];
  const predicates: string[] = [];
  if (options.eligibility === 'ordinary-entry-and-parent') predicates.push(ENTRY_AND_PARENT_ORDINARY);
  if (options.classes !== undefined) {
    const predicate = classPredicate(options.classes);
    predicates.push(predicate.sql);
    params.push(...predicate.params);
  }
  const where = `WHERE entries_fts MATCH ?${predicates.map((predicate) => ` AND ${predicate}`).join('')}`;
  const totalMatches = Number(tx.get(`SELECT COUNT(*) AS n ${from} ${where}`, params)?.['n'] ?? 0);
  if (totalMatches === 0) return { hits: [], totalMatches: 0, truncated: false };

  const scored = tx
    .all(`SELECT e.* ${from} ${where} ORDER BY e.captured_at DESC, e.id LIMIT ?`, [...params, RECALL_CANDIDATES])
    .map((row) => {
      const entry = mapEntry(row);
      const folded = fold(entry.text);
      return { entry, score: tokens.filter((t) => folded.includes(t)).length };
    })
    .filter((row) => row.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.entry.capturedAt - a.entry.capturedAt ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  const selected = scored.slice(0, limit);
  const references = sourceReferencesFor(tx, selected.map(({ entry }) => entry.id));
  const hits: RecallHit[] = selected.map(({ entry, score }) => {
    const refs = references.get(entry.id) ?? [];
    const stamped = refs.map((r) => r.sourceTimestamp).filter((t): t is number => t !== null);
    return {
      sessionId: entry.sessionId,
      entryId: entry.id,
      snippet: snippetFor(entry.text, tokens),
      score,
      sourceRefs: refs,
      sourceTimestamp: stamped.length > 0 ? Math.min(...stamped) : entry.capturedAt,
    };
  });
  return { hits, totalMatches, truncated: totalMatches > limit };
}

export interface MemorySearchHit {
  readonly source: 'entry' | 'memory_item';
  readonly id: string;
  readonly text: string;
  readonly score: number;
  /** Epoch ms the hit is about: an entry's own source time, an item's event or valid-from time. */
  readonly date: number;
}

export interface MemorySearchResult {
  readonly hits: MemorySearchHit[];
  readonly totalMatches: number;
  readonly truncated: boolean;
}

const CLASS_ORDER = ['ordinary', 'private', 'sensitive', 'unknown'] as const;

/** The start block's rule for a typed fact: its sources' most restrictive class, unknown without a source. */
function itemClass(tx: Transaction, sourceSessionIds: readonly string[], memo: HistoryEligibility): DataClass | 'unknown' {
  const classes = sourceSessionIds.map((id) => historySessionEvidence(tx, id, memo)?.dataClass ?? 'unknown');
  if (classes.length === 0) return 'unknown';
  return CLASS_ORDER[Math.max(...classes.map((value) => CLASS_ORDER.indexOf(value)))]!;
}

/**
 * D2/D3: the helper's memory tool reads the same two stores the start block reads. The word
 * `passport` finds what the dreaming pass learned as well as what the owner said, each hit
 * carries its source and date, and only the classes the route admits are returned.
 * An explicit owner entry outranks a derived fact on the same score.
 */
export function searchMemory(tx: Transaction, query: string, limit = 20, options: RecallOptions = {}): MemorySearchResult {
  assertLimit(limit);
  const entries = recall(tx, query, limit, options);
  const typed = searchItems(tx, query, limit);
  const memo: HistoryEligibility = new Map();
  // Only an admitted fact is a fact: a withheld class is neither a hit nor a reported match.
  const admitted = typed.hits.flatMap((item) => {
    const dataClass = itemClass(tx, item.sourceSessionIds, memo);
    if (dataClass === 'unknown' || (options.classes !== undefined && !options.classes.includes(dataClass))) return [];
    return [{ source: 'memory_item' as const, id: item.id, text: item.text, score: item.score, date: item.date }];
  });
  const merged: MemorySearchHit[] = [
    ...entries.hits.map((hit) => ({ source: 'entry' as const, id: hit.entryId, text: hit.snippet, score: hit.score, date: hit.sourceTimestamp })),
    ...admitted,
  ];
  merged.sort(
    (a, b) =>
      b.score - a.score ||
      (a.source === 'entry' ? 0 : 1) - (b.source === 'entry' ? 0 : 1) ||
      b.date - a.date ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    hits: merged.slice(0, limit),
    // The entry count covers the whole index; the typed count covers what one bounded read admitted.
    totalMatches: entries.totalMatches + admitted.length,
    truncated: entries.truncated || typed.totalMatches > limit || merged.length > limit,
  };
}

export interface PreferenceRecord {
  id: string;
  key: string;
  value: string;
  revision: number;
  updatedAt: number;
}

function mapPreference(r: Row): PreferenceRecord {
  return {
    id: String(r.id),
    key: String(r.key),
    value: String(r.value),
    revision: Number(r.revision),
    updatedAt: Number(r.updated_at),
  };
}

export function setPreference(
  tx: Transaction,
  key: string,
  value: string,
  clock: Clock,
): PreferenceRecord {
  const k = requireText(key, 'key');
  if (typeof value !== 'string') badRequest('value must be a string');
  const now = clock.now();
  const existing = tx.get(`SELECT * FROM preferences WHERE key = ?`, [k]);
  if (existing) {
    tx.run(`UPDATE preferences SET value=?, revision=revision+1, updated_at=? WHERE key=?`, [
      value,
      now,
      k,
    ]);
  } else {
    tx.run(`INSERT INTO preferences (id,key,value,revision,updated_at) VALUES (?,?,?,1,?)`, [
      newId(),
      k,
      value,
      now,
    ]);
  }
  return preference(tx, k);
}

export function preference(tx: Transaction, key: string): PreferenceRecord {
  const row = tx.get(`SELECT * FROM preferences WHERE key = ?`, [key]);
  if (!row) notFound(`unknown preference ${key}`, { key });
  return mapPreference(row);
}

export function preferenceOrNull(tx: Transaction, key: string): PreferenceRecord | null {
  const row = tx.get(`SELECT * FROM preferences WHERE key = ?`, [key]);
  return row ? mapPreference(row) : null;
}

/** Content-free deletion journal; runtime transaction owns atomicity. */
export function deleteEntry(tx: Transaction, id: string, deletedAt: string, actor: string): import('../contracts/domain.js').EntryTombstone {
  const existing = tx.get('SELECT * FROM entry_tombstones WHERE entry_id = ?', [id]);
  if (existing) return { entryId: id, deletedAt: String(existing.deleted_at), actor: String(existing.actor), reasonCode: 'owner_request' };
  readEntry(tx, id);
  // Live owns exactly one source identity per remembered note: the canonical
  // UUID:sequence:note-digest identity, never arbitrary source labels or text.
  const source = tx.get("SELECT external_id FROM source_references WHERE owner_kind = 'entry' AND owner_id = ? AND provider = 'live-voice'", [id]);
  const key = source?.external_id;
  const sourceKey = typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+:[0-9a-f]{8}$/.test(key) ? key : null;
  tx.run("DELETE FROM source_references WHERE owner_kind = 'entry' AND owner_id = ?", [id]);
  tx.run('DELETE FROM entries WHERE id = ?', [id]);
  tx.run('INSERT INTO entry_tombstones(entry_id, deleted_at, actor, reason_code, source_kind, source_key) VALUES (?, ?, ?, ?, ?, ?)', [id, deletedAt, actor, 'owner_request', sourceKey ? 'live-voice' : null, sourceKey]);
  if (sourceKey) forgetHistorySessions(tx, [sourceKey.slice(0, 36)], Date.parse(deletedAt));
  return { entryId: id, deletedAt, actor, reasonCode: 'owner_request' };
}


/** Source-turn identity survives deletion so a retained transcript cannot recreate a note. */
export function rememberedLiveEntry(tx: Transaction, sourceKey: string): string | null {
  const active = tx.get("SELECT owner_id FROM source_references WHERE owner_kind = 'entry' AND provider = 'live-voice' AND external_id = ?", [sourceKey]);
  if (active) return String(active.owner_id);
  const deleted = tx.get("SELECT entry_id FROM entry_tombstones WHERE source_kind = 'live-voice' AND source_key = ?", [sourceKey]);
  return deleted ? String(deleted.entry_id) : null;
}
