import type { SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
import type { DataClass } from '../adapters/model/types.js';
import { historyForgotten, forgetHistorySessions, historySessionEvidence, type HistoryEligibility } from './history-lifecycle.js';
import { newId } from './util.js';

/**
 * Conversation summaries (W13): one distilled row per ended Live session.
 *
 * The domain never decides when to distil and never calls a model; the service
 * (`server/services/summarize.ts`) owns those. Here we own the durable shape,
 * the injection candidate read and the cascade delete.
 */
export type SummaryStatus = 'complete' | 'skipped' | 'failed';

export interface SummaryRecord {
  dataClass: DataClass | null;
  sourceRevision: number | null;
  id: string;
  liveSessionId: string;
  status: SummaryStatus;
  summary: string | null;
  /** Something the owner explicitly said was still to do, at most 120 characters, or null. */
  openLoop: string | null;
  /** The distillation prompt version the row was written under; null on rows from before v2. */
  promptVersion: string | null;
  /** Why the row was skipped; null when it was not skipped or the reason was never recorded. */
  skipReason: string | null;
  endedAt: number | null;
  model: string | null;
  inputChars: number | null;
  inputTruncated: boolean;
  injectedSummaryIds: string[];
  retryCount: number;
  errorCode: string | null;
  createdAt: number;
}

export interface EndedSession {
  liveSessionId: string;
  endedAt: number | null;
  /** True when a dead host process left the session non-terminal and recovery sealed it. */
  deadHost: boolean;
}

function parseIds(value: SQLValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(row: SQLRow): SummaryRecord {
  return {
    id: String(row['id']),
    dataClass: row['data_class'] as DataClass | null ?? null,
    sourceRevision: row['source_revision'] === null || row['source_revision'] === undefined ? null : Number(row['source_revision']),
    liveSessionId: String(row['live_session_id']),
    status: String(row['status']) as SummaryStatus,
    summary: row['summary'] === null || row['summary'] === undefined ? null : String(row['summary']),
    openLoop: row['open_loop'] === null || row['open_loop'] === undefined ? null : String(row['open_loop']),
    promptVersion: row['prompt_version'] === null || row['prompt_version'] === undefined ? null : String(row['prompt_version']),
    skipReason: row['skip_reason'] === null || row['skip_reason'] === undefined ? null : String(row['skip_reason']),
    endedAt: row['ended_at'] === null || row['ended_at'] === undefined ? null : Number(row['ended_at']),
    model: row['model'] === null || row['model'] === undefined ? null : String(row['model']),
    inputChars: row['input_chars'] === null || row['input_chars'] === undefined ? null : Number(row['input_chars']),
    inputTruncated: Number(row['input_truncated']) === 1,
    injectedSummaryIds: parseIds(row['injected_summary_ids']),
    retryCount: Number(row['retry_count']),
    errorCode: row['error_code'] === null || row['error_code'] === undefined ? null : String(row['error_code']),
    createdAt: Number(row['created_at']),
  };
}

export interface InsertSummaryInput {
  dataClass?: DataClass;
  sourceRevision?: number;
  liveSessionId: string;
  status: SummaryStatus;
  summary?: string | null;
  openLoop?: string | null;
  promptVersion?: string | null;
  skipReason?: string | null;
  endedAt?: number | null;
  model?: string | null;
  inputChars?: number | null;
  inputTruncated?: boolean;
  injectedSummaryIds?: readonly string[];
  retryCount?: number;
  errorCode?: string | null;
  now: number;
}

export function getBySession(tx: Transaction, liveSessionId: string): SummaryRecord | null {
  const row = tx.get('SELECT * FROM conversation_summaries WHERE live_session_id=?', [liveSessionId]);
  return row ? toRecord(row) : null;
}

/** Idempotent insert keyed by the unique live_session_id; returns the stored row. */
export function insertSummary(tx: Transaction, input: InsertSummaryInput): SummaryRecord {
  if (historyForgotten(tx, input.liveSessionId)) throw new Error('history_forgotten');
  if (input.dataClass !== undefined || input.sourceRevision !== undefined) {
    const source = historySessionEvidence(tx, input.liveSessionId);
    if (!source || source.dataClass !== input.dataClass || source.revision !== input.sourceRevision) throw new Error('history_source_changed');
  }
  const existing = getBySession(tx, input.liveSessionId);
  if (existing) {
    // The in-flight marker is not an outcome: the row this call is about to write replaces it.
    if (!(existing.status === 'failed' && existing.errorCode === PENDING_SUMMARY_ERROR_CODE)) return existing;
    tx.run('DELETE FROM conversation_summaries WHERE id=?', [existing.id]);
  }
  const id = newId();
  tx.run(
    `INSERT INTO conversation_summaries
       (id, live_session_id, status, summary, open_loop, prompt_version, skip_reason, ended_at, model, input_chars, input_truncated, injected_summary_ids, retry_count, error_code, created_at, data_class, source_revision)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.liveSessionId, input.status, input.summary ?? null, input.openLoop ?? null, input.promptVersion ?? null,
      input.skipReason ?? null, input.endedAt ?? null, input.model ?? null,
      input.inputChars ?? null, input.inputTruncated ? 1 : 0, JSON.stringify([...(input.injectedSummaryIds ?? [])]),
      input.retryCount ?? 0, input.errorCode ?? null, input.now, input.dataClass ?? null, input.sourceRevision ?? null],
  );
  return getBySession(tx, input.liveSessionId)!;
}

/** Update the recorded outcome of an already-inserted row (retry bookkeeping). */
export function updateSummary(
  tx: Transaction,
  liveSessionId: string,
  patch: { status?: SummaryStatus; summary?: string | null; model?: string | null; inputChars?: number | null;
    inputTruncated?: boolean; retryCount?: number; errorCode?: string | null },
): SummaryRecord | null {
  const current = getBySession(tx, liveSessionId);
  if (!current) return null;
  tx.run(
    `UPDATE conversation_summaries SET status=?, summary=?, model=?, input_chars=?, input_truncated=?, retry_count=?, error_code=? WHERE live_session_id=?`,
    [patch.status ?? current.status, patch.summary === undefined ? current.summary : patch.summary,
      patch.model === undefined ? current.model : patch.model,
      patch.inputChars === undefined ? current.inputChars : patch.inputChars,
      (patch.inputTruncated === undefined ? current.inputTruncated : patch.inputTruncated) ? 1 : 0,
      patch.retryCount === undefined ? current.retryCount : patch.retryCount,
      patch.errorCode === undefined ? current.errorCode : patch.errorCode, liveSessionId],
  );
  return getBySession(tx, liveSessionId);
}

export function listSummaries(tx: Transaction): SummaryRecord[] {
  return tx.all('SELECT * FROM conversation_summaries ORDER BY created_at DESC, rowid DESC').map(toRecord);
}

/** Ended sessions the reconciler may still distil, oldest first: no row, or a row skipped only for a missing text model. */
export function endedSessionsWithoutSummary(tx: Transaction): EndedSession[] {
  const rows = tx.all(
    `SELECT s.live_session_id AS id, s.terminal_at AS ended_at, s.terminal_outcome AS outcome
       FROM live_sessions s
       LEFT JOIN conversation_summaries c ON c.live_session_id = s.live_session_id
      WHERE s.lifecycle = 'terminal'
        AND NOT EXISTS (SELECT 1 FROM history_exclusions h WHERE h.source_kind='live' AND h.source_id=s.live_session_id)
        AND (c.id IS NULL OR (c.status = 'skipped' AND c.skip_reason = 'no_text_model'))
      ORDER BY (s.terminal_at IS NULL), s.terminal_at ASC, s.created_at ASC`,
  );
  return rows.map(row => ({ liveSessionId: String(row['id']), endedAt: row['ended_at'] === null || row['ended_at'] === undefined ? null : Number(row['ended_at']),
    deadHost: deadHostOutcome(row['outcome']) }));
}

/** The code an in-flight summary carries: written before the model call, replaced by the outcome, retried at the next start. */
export const PENDING_SUMMARY_ERROR_CODE = 'pending';

/** The failure classes a later host start may retry; a refusal, a denied route or unparsable output is sealed.
 *  `error` is the class the host wrote before this list named it, so those rows are retried once like any transient one. */
export const RETRYABLE_FAILURE_CODES = ['deadline', 'cancelled', 'network', 'credential_unavailable', 'provider', 'model_error', 'error', PENDING_SUMMARY_ERROR_CODE] as const;

export interface FailedSummaryCandidate { liveSessionId: string; endedAt: number | null; retryCount: number }

/**
 * Failed rows a later host start may retry, newest first: only a transient failure class, and only where the
 * session journal still exists. A row whose journal was pruned cannot be distilled again and is never returned.
 */
export function failedRetryableSessionsWithJournal(tx: Transaction, limit: number): FailedSummaryCandidate[] {
  if (!hasTable(tx)) return [];
  return tx.all(
    `SELECT c.live_session_id AS id, c.ended_at AS ended_at, c.retry_count AS retry_count
       FROM conversation_summaries c
      WHERE c.status = 'failed' AND c.error_code IN (${RETRYABLE_FAILURE_CODES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM history_exclusions h WHERE h.source_kind='live' AND h.source_id=c.live_session_id)
        AND EXISTS (SELECT 1 FROM live_journal j WHERE j.live_session_id = c.live_session_id)
      ORDER BY (c.ended_at IS NULL), c.ended_at DESC, c.rowid DESC
      LIMIT ?`, [...RETRYABLE_FAILURE_CODES, limit],
  ).map(row => ({ liveSessionId: String(row['id']), retryCount: Number(row['retry_count'] ?? 0),
    endedAt: row['ended_at'] === null || row['ended_at'] === undefined ? null : Number(row['ended_at']) }));
}

/** Total retryable failed rows with a surviving journal, so a requeue can report what it left for later. */
export function countFailedRetryableSessionsWithJournal(tx: Transaction): number {
  if (!hasTable(tx)) return 0;
  const row = tx.get(
    `SELECT COUNT(*) AS n FROM conversation_summaries c
      WHERE c.status = 'failed' AND c.error_code IN (${RETRYABLE_FAILURE_CODES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM history_exclusions h WHERE h.source_kind='live' AND h.source_id=c.live_session_id)
        AND EXISTS (SELECT 1 FROM live_journal j WHERE j.live_session_id = c.live_session_id)`, [...RETRYABLE_FAILURE_CODES]);
  return Number(row?.['n'] ?? 0);
}

/** Close a failed row that spent its retry budget or its age, so no later start retries it again. */
export function closeFailedRetry(tx: Transaction, liveSessionId: string): boolean {
  const row = tx.get("SELECT id FROM conversation_summaries WHERE live_session_id=? AND status='failed'", [liveSessionId]);
  if (!row) return false;
  tx.run("UPDATE conversation_summaries SET error_code='retry_exhausted' WHERE live_session_id=? AND status='failed'", [liveSessionId]);
  return true;
}

/** Mark a session's summary as in flight: the row a host that dies mid-call leaves for the next start to retry. */
export function markSummaryPending(tx: Transaction, liveSessionId: string, now: number, provenance: { dataClass: DataClass; sourceRevision: number }): void {
  if (getBySession(tx, liveSessionId)) return;
  insertSummary(tx, { liveSessionId, ...provenance, status: 'failed', errorCode: PENDING_SUMMARY_ERROR_CODE, retryCount: 0, now });
}

/** Remove a failed row so distillation may run once more for its session; refuses any non-failed row. */
export function removeFailed(tx: Transaction, liveSessionId: string): boolean {
  const row = tx.get("SELECT id FROM conversation_summaries WHERE live_session_id=? AND status='failed'", [liveSessionId]);
  if (!row) return false;
  tx.run('DELETE FROM conversation_summaries WHERE live_session_id=?', [liveSessionId]);
  return true;
}

/** Remove a row skipped only because no text model was configured, so a later start distils it; any other row is refused. */
export function reopenNoModelSkip(tx: Transaction, liveSessionId: string): boolean {
  const row = tx.get("SELECT id FROM conversation_summaries WHERE live_session_id=? AND status='skipped' AND skip_reason='no_text_model'", [liveSessionId]);
  if (!row) return false;
  tx.run('DELETE FROM conversation_summaries WHERE live_session_id=?', [liveSessionId]);
  return true;
}

/** Recovery seals a dead host's non-terminal sessions as `not_started` or `outcome_unknown`. */
export function deadHostOutcome(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value) as { state?: unknown };
    return parsed.state === 'not_started' || parsed.state === 'outcome_unknown';
  } catch {
    return false;
  }
}

export interface InjectionCandidate { id: string; liveSessionId: string; endedAt: number; summary: string; dataClass: DataClass; sourceRevision: number }
export function summarySelection(tx: Transaction, allowedClasses: readonly DataClass[]) {
  const candidates: InjectionCandidate[] = [];
  const eligibility: HistoryEligibility = new Map();
  const coverage = { legacyUnavailable: 0, sourceUnavailable: 0, classFiltered: 0 };
  if (!hasTable(tx)) return { candidates, coverage };
  for (const row of listSummaries(tx)) {
    if (row.status !== 'complete' || row.summary === null) continue;
    if (row.dataClass === null || row.sourceRevision === null) { coverage.legacyUnavailable++; continue; }
    const source = historySessionEvidence(tx, row.liveSessionId, eligibility);
    if (!source || source.dataClass !== row.dataClass || source.revision !== row.sourceRevision) { coverage.sourceUnavailable++; continue; }
    if (!allowedClasses.includes(row.dataClass)) { coverage.classFiltered++; continue; }
    if (row.endedAt === null || !Number.isFinite(row.endedAt)) continue;
    candidates.push({ id: row.id, liveSessionId: row.liveSessionId, endedAt: row.endedAt, summary: row.summary, dataClass: row.dataClass, sourceRevision: row.sourceRevision });
  }
  candidates.sort((a, b) => b.endedAt - a.endedAt || a.id.localeCompare(b.id));
  return { candidates, coverage };
}

/** Unknown legacy provenance never defaults to ordinary. */
export function injectionCandidates(tx: Transaction, allowedClasses: readonly DataClass[] = ['ordinary']): InjectionCandidate[] {
  return summarySelection(tx, allowedClasses).candidates;
}

/** The domain migration owns this table; a store built without it has no summaries. */
export function hasTable(tx: Transaction): boolean {
  return !!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'");
}

/** The injected summary ids recorded on a live session's own create-time provenance. */
export function injectedSummaryIdsForSession(tx: Transaction, liveSessionId: string): string[] {
  const row = tx.get('SELECT memory_provenance FROM live_sessions WHERE live_session_id=?', [liveSessionId]);
  if (!row || typeof row['memory_provenance'] !== 'string') return [];
  try {
    const parsed = JSON.parse(row['memory_provenance']) as { injectedSummaryIds?: unknown };
    return Array.isArray(parsed.injectedSummaryIds) ? parsed.injectedSummaryIds.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Delete summary `id` and every summary that recorded it as injected (they may repeat it).
 * Returns the ids actually removed.
 */
export function deleteSummary(tx: Transaction, id: string, now = Date.now()): { deletedIds: string[]; notFound: boolean } {
  const exists = tx.get('SELECT id FROM conversation_summaries WHERE id=?', [id]);
  if (!exists) return { deletedIds: [], notFound: true };
  const all = listSummaries(tx);
  const deleted = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of all) {
      if (deleted.has(record.id)) continue;
      if (record.injectedSummaryIds.some(injected => deleted.has(injected))) { deleted.add(record.id); grew = true; }
    }
  }
  const sessions = all.filter(record => deleted.has(record.id)).map(record => record.liveSessionId);
  const removed = forgetHistorySessions(tx, sessions, now);
  return { deletedIds: removed, notFound: false };
}
