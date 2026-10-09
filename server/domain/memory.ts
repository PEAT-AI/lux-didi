import { notFound, badRequest } from './contract.js';
import type { Transaction, SQLRow } from './contract.js';
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

export function sourceReferences(tx: Transaction, ownerId: string): SourceRefRecord[] {
  return tx
    .all(`SELECT * FROM source_references WHERE owner_id = ? ORDER BY id ASC`, [ownerId])
    .map(mapSourceRef);
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

/** Deterministic keyword + recency recall. Honest about empties and limits. */
export function recall(tx: Transaction, query: string, limit = 20): RecallResult {
  assertLimit(limit);
  const tokens = tokenize(typeof query === 'string' ? query : '');
  if (tokens.length === 0) return { hits: [], totalMatches: 0, truncated: false };

  const rows = tx.all(`SELECT * FROM entries`, []);
  const scored: { entry: EntryRecord; score: number }[] = [];
  for (const row of rows) {
    const entry = mapEntry(row);
    const folded = fold(entry.text);
    let score = 0;
    for (const t of tokens) if (folded.includes(t)) score += 1;
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.entry.capturedAt - a.entry.capturedAt ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  const totalMatches = scored.length;
  const hits: RecallHit[] = scored.slice(0, limit).map(({ entry, score }) => {
    const refs = sourceReferences(tx, entry.id);
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
