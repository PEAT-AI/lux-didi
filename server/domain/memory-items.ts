// Typed memory: the facts the dreaming pass writes and the start block reads.
//
// Every operation runs inside the caller's transaction (the domain never opens
// a database). Provenance is turn ids only: the words live in history_turns
// and are joined at read time, so a forgotten session takes its words with it.
import { badRequest, notFound } from './contract.js';
import type { Transaction, SQLRow, SQLValue } from './contract.js';
import { assertLimit, fold, newId, requireText, tokenize } from './util.js';

export const MEMORY_KINDS = [
  'durable_fact', 'preference', 'person_role', 'transient_state',
  'plan', 'promise', 'open_question', 'correction', 'decision',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryAuthority = 'explicit_owner' | 'derived';
export type MemoryStatus = 'active' | 'superseded' | 'invalid' | 'expired';
export type MemoryJobState = 'pending' | 'running' | 'done' | 'failed';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  subject: string;
  validFrom: number;
  validUntil: number | null;
  eventAt: number | null;
  eventTz: string | null;
  eventText: string | null;
  place: string | null;
  authority: MemoryAuthority;
  status: MemoryStatus;
  supersededBy: string | null;
  salience: number;
  createdAt: number;
  createdBy: string;
  generation: number;
}

export interface MemorySourceInput {
  sessionId: string;
  turnStartId: number;
  turnEndId: number;
}

export interface NewMemoryItem {
  kind: MemoryKind;
  text: string;
  subject: string;
  /** When the fact became true, epoch ms. */
  validFrom: number;
  /** When it was written, epoch ms. */
  createdAt: number;
  /** `remember_note`, `dreaming:<version>`, `backfill:<version>`, `import:<manifest>`. */
  createdBy: string;
  validUntil?: number | null;
  eventAt?: number | null;
  eventTz?: string | null;
  eventText?: string | null;
  place?: string | null;
  authority?: MemoryAuthority;
  salience?: number;
  sources?: readonly MemorySourceInput[];
}

export interface MemorySourceTurn {
  memoryId: string;
  sessionId: string;
  turnStartId: number;
  turnEndId: number;
  turnId: number;
  role: string;
  text: string;
  at: number;
}

export interface ActiveItemQuery {
  kinds?: readonly MemoryKind[];
  /** Only items that became true at or after this epoch ms. */
  since?: number;
  limit?: number;
  orderBy?: 'salience';
}

export interface ForgetScope {
  sessionIds?: readonly string[];
  itemIds?: readonly string[];
  all?: boolean;
  now: number;
}

export interface MemoryJob {
  id: string;
  sessionId: string;
  watermark: number | null;
  extractorVersion: string;
  state: MemoryJobState;
  attempts: number;
  generation: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

function mapItem(row: SQLRow): MemoryItem {
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryKind,
    text: String(row.text),
    subject: String(row.subject),
    validFrom: Number(row.valid_from),
    validUntil: row.valid_until === null ? null : Number(row.valid_until),
    eventAt: row.event_at === null ? null : Number(row.event_at),
    eventTz: row.event_tz === null ? null : String(row.event_tz),
    eventText: row.event_text === null ? null : String(row.event_text),
    place: row.place === null ? null : String(row.place),
    authority: String(row.authority) as MemoryAuthority,
    status: String(row.status) as MemoryStatus,
    supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
    salience: Number(row.salience),
    createdAt: Number(row.created_at),
    createdBy: String(row.created_by),
    generation: Number(row.generation),
  };
}

function mapJob(row: SQLRow): MemoryJob {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    watermark: row.watermark === null ? null : Number(row.watermark),
    extractorVersion: String(row.extractor_version),
    state: String(row.state) as MemoryJobState,
    attempts: Number(row.attempts),
    generation: Number(row.generation),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    error: row.error === null ? null : String(row.error),
  };
}

/** The generation every job and import must still match at commit. */
export function generationNow(tx: Transaction): number {
  const row = tx.get('SELECT generation FROM memory_generation WHERE id = 1');
  return row ? Number(row.generation) : 1;
}

function item(tx: Transaction, id: string): MemoryItem {
  const row = tx.get('SELECT * FROM memory_items WHERE id = ?', [id]);
  if (!row) notFound(`unknown memory item ${id}`, { id });
  return mapItem(row);
}

export function insertItem(tx: Transaction, input: NewMemoryItem): MemoryItem {
  const text = requireText(input.text, 'text');
  const subject = requireText(input.subject, 'subject');
  if (!MEMORY_KINDS.includes(input.kind)) badRequest(`unknown memory kind ${String(input.kind)}`);
  const salience = input.salience ?? 1;
  if (!Number.isInteger(salience) || salience < 0 || salience > 3) badRequest('salience must be 0..3');
  const id = newId();
  tx.run(
    `INSERT INTO memory_items
       (id,kind,text,subject,valid_from,valid_until,event_at,event_tz,event_text,place,
        authority,status,superseded_by,salience,created_at,created_by,generation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',NULL,?,?,?,?)`,
    [
      id, input.kind, text, subject, input.validFrom, input.validUntil ?? null,
      input.eventAt ?? null, input.eventTz ?? null, input.eventText ?? null, input.place ?? null,
      input.authority ?? 'derived', salience, input.createdAt,
      requireText(input.createdBy, 'createdBy'), generationNow(tx),
    ],
  );
  for (const source of input.sources ?? []) {
    tx.run(
      'INSERT INTO memory_sources(memory_id,session_id,turn_start_id,turn_end_id) VALUES (?,?,?,?)',
      [id, requireText(source.sessionId, 'sessionId'), source.turnStartId, source.turnEndId],
    );
  }
  return item(tx, id);
}

/** The new fact replaces the old one; the old row stays as history, never served. */
export function supersedeItem(tx: Transaction, oldId: string, newId: string, at: number): void {
  item(tx, oldId);
  item(tx, newId);
  const changed = tx.run(
    "UPDATE memory_items SET status='superseded', valid_until=?, superseded_by=? WHERE id=? AND status='active'",
    [at, newId, oldId],
  );
  if (changed === 0) badRequest(`memory item ${oldId} is not active`, { id: oldId });
}

export function invalidateItem(tx: Transaction, id: string, reason: string): void {
  item(tx, id);
  requireText(reason, 'reason');
  tx.run("UPDATE memory_items SET status='invalid' WHERE id=? AND status='active'", [id]);
}

/** Expires what was only true until a date: transient states, never a durable fact. */
export function expireDue(tx: Transaction, now: number): number {
  return tx.run(
    "UPDATE memory_items SET status='expired' WHERE status='active' AND kind='transient_state' AND valid_until IS NOT NULL AND valid_until <= ?",
    [now],
  );
}

export function activeItems(tx: Transaction, query: ActiveItemQuery = {}): MemoryItem[] {
  const limit = assertLimit(query.limit ?? 50, 'limit');
  const params: SQLValue[] = [];
  let sql = "SELECT * FROM memory_items WHERE status='active'";
  if (query.kinds && query.kinds.length > 0) {
    sql += ` AND kind IN (${query.kinds.map(() => '?').join(',')})`;
    params.push(...query.kinds);
  }
  if (query.since !== undefined) { sql += ' AND valid_from >= ?'; params.push(query.since); }
  sql += query.orderBy === 'salience'
    ? ' ORDER BY salience DESC, created_at DESC, id'
    : ' ORDER BY created_at DESC, id';
  sql += ' LIMIT ?';
  params.push(limit);
  return tx.all(sql, params).map(mapItem);
}

/** One FTS5 expression for a query's tokens: each token is a prefix of a stored word. */
export function ftsExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' OR ');
}

export interface ItemHit {
  readonly id: string;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly score: number;
  /** Epoch ms the fact is about: its event date, else when it became true. */
  readonly date: number;
  readonly sourceSessionIds: readonly string[];
}

export interface ItemSearchResult {
  readonly hits: ItemHit[];
  readonly totalMatches: number;
}

/** A search reads an indexed candidate set, never the table. */
export const ITEM_CANDIDATES = 200;

/**
 * D2: the index the dreaming pass already writes is the helper's memory search. Only an active
 * item is a fact, so a superseded, invalid or expired row is never returned. The caller decides
 * the route's classes from `sourceSessionIds`; this function has no opinion on access.
 */
export function searchItems(tx: Transaction, query: string, limit: number): ItemSearchResult {
  assertLimit(limit);
  const tokens = tokenize(typeof query === 'string' ? query : '');
  if (tokens.length === 0) return { hits: [], totalMatches: 0 };
  const expression = ftsExpression(tokens);
  const from = `FROM memory_items_fts JOIN memory_items i ON i.rowid = memory_items_fts.rowid
      WHERE memory_items_fts MATCH ? AND i.status='active'`;
  const totalMatches = Number(tx.get(`SELECT COUNT(*) AS n ${from}`, [expression])?.['n'] ?? 0);
  if (totalMatches === 0) return { hits: [], totalMatches: 0 };
  const scored = tx
    .all(`SELECT i.* ${from} ORDER BY i.created_at DESC, i.id LIMIT ?`, [expression, Math.max(limit, ITEM_CANDIDATES)])
    .map(mapItem)
    .map((item) => ({ item, score: tokens.filter((token) => fold(`${item.text} ${item.subject}`).includes(token)).length }))
    .filter((row) => row.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.createdAt - a.item.createdAt ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  const top = scored.slice(0, limit);
  const sources = new Map<string, string[]>();
  if (top.length > 0) {
    const ids = top.map(({ item }) => item.id);
    for (const row of tx.all(
      `SELECT memory_id, session_id FROM memory_sources WHERE memory_id IN (${ids.map(() => '?').join(',')}) ORDER BY memory_id, session_id`,
      ids,
    )) {
      const memoryId = String(row['memory_id']);
      const sessionId = String(row['session_id']);
      const list = sources.get(memoryId) ?? [];
      if (!list.includes(sessionId)) list.push(sessionId);
      sources.set(memoryId, list);
    }
  }
  return {
    hits: top.map(({ item, score }) => ({
      id: item.id, text: item.text, kind: item.kind, score,
      date: item.eventAt ?? item.validFrom,
      sourceSessionIds: sources.get(item.id) ?? [],
    })),
    totalMatches,
  };
}

export function itemsForSubject(tx: Transaction, subject: string): MemoryItem[] {
  return tx.all('SELECT * FROM memory_items WHERE subject = ? ORDER BY created_at DESC, id', [subject]).map(mapItem);
}

/** The turns a fact came from, with their text joined at read time. */
export function sources(tx: Transaction, id: string): MemorySourceTurn[] {
  return tx.all(
    `SELECT s.memory_id, s.session_id, s.turn_start_id, s.turn_end_id, t.id AS turn_id, t.role, t.text, t.at
       FROM memory_sources s
       JOIN history_turns t ON t.live_session_id = s.session_id AND t.id BETWEEN s.turn_start_id AND s.turn_end_id
      WHERE s.memory_id = ?
      ORDER BY t.id`,
    [id],
  ).map(row => ({
    memoryId: String(row.memory_id),
    sessionId: String(row.session_id),
    turnStartId: Number(row.turn_start_id),
    turnEndId: Number(row.turn_end_id),
    turnId: Number(row.turn_id),
    role: String(row.role),
    text: String(row.text),
    at: Number(row.at),
  }));
}

/**
 * The forget path: deletes the items and sources in scope, bumps the generation
 * so a job started before the forget is refused at commit, and rebuilds the FTS
 * index. An item derived from a forgotten session is not served, even when it
 * also cites a kept session: the owner asked for that conversation to go.
 */
export function forgetScope(tx: Transaction, scope: ForgetScope): number {
  const doomed = new Set<string>();
  if (scope.all) {
    for (const row of tx.all('SELECT id FROM memory_items')) doomed.add(String(row.id));
  }
  const sessionIds = scope.sessionIds ?? [];
  if (sessionIds.length > 0) {
    const marks = sessionIds.map(() => '?').join(',');
    for (const row of tx.all(`SELECT DISTINCT memory_id FROM memory_sources WHERE session_id IN (${marks})`, sessionIds)) {
      doomed.add(String(row.memory_id));
    }
  }
  const itemIds = scope.itemIds ?? [];
  if (itemIds.length > 0) {
    const marks = itemIds.map(() => '?').join(',');
    for (const row of tx.all(`SELECT id FROM memory_items WHERE id IN (${marks})`, itemIds)) doomed.add(String(row.id));
  }
  for (const id of doomed) {
    tx.run('DELETE FROM memory_sources WHERE memory_id = ?', [id]);
    tx.run('DELETE FROM memory_items WHERE id = ?', [id]);
  }
  if (scope.all) {
    tx.run('DELETE FROM memory_sources');
    tx.run('DELETE FROM memory_jobs');
  }
  tx.run(
    "INSERT INTO memory_generation(id,generation,bumped_at,reason) VALUES (1,1,?,'forget') " +
      "ON CONFLICT(id) DO UPDATE SET generation=generation+1, bumped_at=excluded.bumped_at, reason='forget'",
    [scope.now],
  );
  tx.run("INSERT INTO memory_items_fts(memory_items_fts) VALUES ('rebuild')");
  return doomed.size;
}

export function job(tx: Transaction, sessionId: string, version: string): MemoryJob | null {
  const row = tx.get('SELECT * FROM memory_jobs WHERE session_id = ? AND extractor_version = ?', [sessionId, version]);
  return row ? mapJob(row) : null;
}

/** Takes the session's job for this extractor version under the current generation. */
export function claimJob(tx: Transaction, sessionId: string, version: string, now: number): MemoryJob {
  tx.run(
    `INSERT INTO memory_jobs(id,session_id,watermark,extractor_version,state,attempts,generation,started_at)
     VALUES (?,?,NULL,?,'running',1,?,?)
     ON CONFLICT(session_id,extractor_version) DO UPDATE SET
       state='running', attempts=attempts+1, generation=excluded.generation,
       started_at=excluded.started_at, finished_at=NULL, error=NULL`,
    [newId(), requireText(sessionId, 'sessionId'), requireText(version, 'version'), generationNow(tx), now],
  );
  return job(tx, sessionId, version)!;
}

/** False when the store forgot while this job ran: its writes must not commit. */
export function completeJob(tx: Transaction, id: string, watermark: number, now: number): boolean {
  const row = tx.get('SELECT generation FROM memory_jobs WHERE id = ?', [id]);
  if (!row) notFound(`unknown memory job ${id}`, { id });
  if (Number(row.generation) !== generationNow(tx)) return false;
  tx.run("UPDATE memory_jobs SET state='done', watermark=?, finished_at=? WHERE id=?", [watermark, now, id]);
  return true;
}

export function failJob(tx: Transaction, id: string, error: string, now: number): void {
  const changed = tx.run("UPDATE memory_jobs SET state='failed', finished_at=?, error=? WHERE id=?", [now, requireText(error, 'error'), id]);
  if (changed === 0) notFound(`unknown memory job ${id}`, { id });
}
