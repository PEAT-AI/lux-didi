import type { SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
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
  const existing = getBySession(tx, input.liveSessionId);
  if (existing) return existing;
  const id = newId();
  tx.run(
    `INSERT INTO conversation_summaries
       (id, live_session_id, status, summary, open_loop, prompt_version, skip_reason, ended_at, model, input_chars, input_truncated, injected_summary_ids, retry_count, error_code, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.liveSessionId, input.status, input.summary ?? null, input.openLoop ?? null, input.promptVersion ?? null,
      input.skipReason ?? null, input.endedAt ?? null, input.model ?? null,
      input.inputChars ?? null, input.inputTruncated ? 1 : 0, JSON.stringify([...(input.injectedSummaryIds ?? [])]),
      input.retryCount ?? 0, input.errorCode ?? null, input.now],
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

/** Ended sessions that still have no summary row, oldest first; the reconciler's work list. */
export function endedSessionsWithoutSummary(tx: Transaction): EndedSession[] {
  const rows = tx.all(
    `SELECT s.live_session_id AS id, s.terminal_at AS ended_at, s.terminal_outcome AS outcome
       FROM live_sessions s
       LEFT JOIN conversation_summaries c ON c.live_session_id = s.live_session_id
      WHERE s.lifecycle = 'terminal' AND c.id IS NULL
      ORDER BY (s.terminal_at IS NULL), s.terminal_at ASC, s.created_at ASC`,
  );
  return rows.map(row => ({ liveSessionId: String(row['id']), endedAt: row['ended_at'] === null || row['ended_at'] === undefined ? null : Number(row['ended_at']),
    deadHost: deadHostOutcome(row['outcome']) }));
}

export interface FailedSummaryCandidate { liveSessionId: string; endedAt: number | null }

/**
 * Failed-deadline rows whose session journal still exists, newest first; the host-start requeue list.
 * A row whose journal was already pruned or deleted cannot be distilled again and is never returned.
 */
export function failedDeadlineSessionsWithJournal(tx: Transaction, limit: number): FailedSummaryCandidate[] {
  if (!hasTable(tx)) return [];
  return tx.all(
    `SELECT c.live_session_id AS id, c.ended_at AS ended_at
       FROM conversation_summaries c
      WHERE c.status = 'failed' AND c.error_code = 'deadline'
        AND EXISTS (SELECT 1 FROM live_journal j WHERE j.live_session_id = c.live_session_id)
      ORDER BY (c.ended_at IS NULL), c.ended_at DESC, c.rowid DESC
      LIMIT ?`, [limit],
  ).map(row => ({ liveSessionId: String(row['id']), endedAt: row['ended_at'] === null || row['ended_at'] === undefined ? null : Number(row['ended_at']) }));
}

/** Total failed-deadline rows with a surviving journal, so the requeue can report what it left for later. */
export function countFailedDeadlineSessionsWithJournal(tx: Transaction): number {
  if (!hasTable(tx)) return 0;
  const row = tx.get(
    `SELECT COUNT(*) AS n FROM conversation_summaries c
      WHERE c.status = 'failed' AND c.error_code = 'deadline'
        AND EXISTS (SELECT 1 FROM live_journal j WHERE j.live_session_id = c.live_session_id)`);
  return Number(row?.['n'] ?? 0);
}

/** Remove a failed row so distillation may run once more for its session; refuses any non-failed row. */
export function removeFailed(tx: Transaction, liveSessionId: string): boolean {
  const row = tx.get("SELECT id FROM conversation_summaries WHERE live_session_id=? AND status='failed'", [liveSessionId]);
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

export interface InjectionCandidate { id: string; endedAt: number; summary: string }

/** Every complete summary that could be injected, newest first. The budget is applied by the prompt builder. */
export function injectionCandidates(tx: Transaction): InjectionCandidate[] {
  if (!hasTable(tx)) return [];
  return tx.all("SELECT id, ended_at, summary FROM conversation_summaries WHERE status='complete' AND summary IS NOT NULL ORDER BY ended_at DESC, rowid DESC")
    .map(row => ({ id: String(row['id']), endedAt: Number(row['ended_at']), summary: String(row['summary']) }))
    .filter(row => Number.isFinite(row.endedAt));
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
export function deleteSummary(tx: Transaction, id: string): { deletedIds: string[]; notFound: boolean } {
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
  for (const deletedId of deleted) tx.run('DELETE FROM conversation_summaries WHERE id=?', [deletedId]);
  return { deletedIds: [...deleted], notFound: false };
}
