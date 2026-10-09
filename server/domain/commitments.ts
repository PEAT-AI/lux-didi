import { notFound, conflict, badRequest } from './contract.ts';
import type { Transaction, SQLRow } from './contract.ts';
import { assertTimeZone, newId, requireText, localDayBounds } from './util.ts';
import type { Clock } from './memory.ts';

export type CommitmentStatus = 'active' | 'completed' | 'cancelled';
export type CommitmentOperation = 'captured' | 'corrected' | 'completed' | 'reopened' | 'cancelled';

export interface CommitmentRecord {
  id: string;
  title: string;
  notes: string;
  dueAt: number | null;
  dueTimeZone: string | null;
  status: CommitmentStatus;
  revision: number;
  sourceSessionId: string | null;
  sourceEntryId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryRecord {
  commitmentId: string;
  revision: number;
  title: string;
  notes: string;
  dueAt: number | null;
  dueTimeZone: string | null;
  status: CommitmentStatus;
  operation: CommitmentOperation;
  recordedAt: number;
}

type Row = SQLRow;

function mapCommitment(r: Row): CommitmentRecord {
  return {
    id: String(r.id),
    title: String(r.title),
    notes: String(r.notes),
    dueAt: r.due_at === null ? null : Number(r.due_at),
    dueTimeZone: r.due_time_zone === null ? null : String(r.due_time_zone),
    status: String(r.status) as CommitmentStatus,
    revision: Number(r.revision),
    sourceSessionId: r.source_session_id === null ? null : String(r.source_session_id),
    sourceEntryId: r.source_entry_id === null ? null : String(r.source_entry_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapHistory(r: Row): HistoryRecord {
  return {
    commitmentId: String(r.commitment_id),
    revision: Number(r.revision),
    title: String(r.title),
    notes: String(r.notes),
    dueAt: r.due_at === null ? null : Number(r.due_at),
    dueTimeZone: r.due_time_zone === null ? null : String(r.due_time_zone),
    status: String(r.status) as CommitmentStatus,
    operation: String(r.operation) as CommitmentOperation,
    recordedAt: Number(r.recorded_at),
  };
}

export function readCommitment(tx: Transaction, id: string): CommitmentRecord {
  const row = tx.get(`SELECT * FROM commitments WHERE id = ?`, [id]);
  if (!row) notFound(`unknown commitment ${id}`, { id });
  return mapCommitment(row);
}

export function listCommitments(tx: Transaction, status?: CommitmentStatus): CommitmentRecord[] {
  const rows =
    status === undefined
      ? tx.all(`SELECT * FROM commitments ORDER BY created_at DESC, id ASC`, [])
      : tx.all(`SELECT * FROM commitments WHERE status = ? ORDER BY created_at DESC, id ASC`, [
          status,
        ]);
  return rows.map(mapCommitment);
}

export function commitmentHistory(tx: Transaction, id: string): HistoryRecord[] {
  return tx
    .all(`SELECT * FROM commitment_revisions WHERE commitment_id = ? ORDER BY revision ASC`, [id])
    .map(mapHistory);
}

function appendHistory(
  tx: Transaction,
  c: CommitmentRecord,
  operation: CommitmentOperation,
  recordedAt: number,
): void {
  tx.run(
    `INSERT INTO commitment_revisions
       (commitment_id,revision,title,notes,due_at,due_time_zone,status,operation,recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [c.id, c.revision, c.title, c.notes, c.dueAt, c.dueTimeZone, c.status, operation, recordedAt],
  );
}

/** Revision guard: the stored revision must equal the caller's expectation. */
function guard(tx: Transaction, id: string, expectedRevision: number): CommitmentRecord {
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
    badRequest('expectedRevision must be an integer');
  }
  const current = readCommitment(tx, id);
  if (current.revision !== expectedRevision) conflict(id, expectedRevision, current.revision);
  return current;
}

export interface CaptureCommitmentInput {
  title: string;
  notes?: string | undefined;
  dueAt?: number | null | undefined;
  timeZone: string;
  sourceSessionId?: string | null | undefined;
  sourceEntryId?: string | null | undefined;
}

export function captureCommitment(
  tx: Transaction,
  input: CaptureCommitmentInput,
  clock: Clock,
  id: string = newId(),
): CommitmentRecord {
  const title = requireText(input.title, 'title');
  assertTimeZone(input.timeZone);
  const now = clock.now();
  tx.run(
    `INSERT INTO commitments
       (id,title,notes,due_at,due_time_zone,status,revision,source_session_id,source_entry_id,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',1,?,?,?,?)`,
    [
      id,
      title,
      input.notes ?? '',
      input.dueAt ?? null,
      input.timeZone,
      input.sourceSessionId ?? null,
      input.sourceEntryId ?? null,
      now,
      now,
    ],
  );
  const created = readCommitment(tx, id);
  appendHistory(tx, created, 'captured', now);
  return created;
}

export interface CorrectCommitmentPatch {
  title?: string | undefined;
  notes?: string | undefined;
  dueAt?: number | null | undefined;
  timeZone?: string | undefined;
}

export function correctCommitment(
  tx: Transaction,
  id: string,
  expectedRevision: number,
  patch: CorrectCommitmentPatch,
  clock: Clock,
): CommitmentRecord {
  const current = guard(tx, id, expectedRevision);
  if (current.status !== 'active') {
    badRequest('only an active commitment can be corrected', { status: current.status });
  }
  if (patch.title !== undefined) requireText(patch.title, 'title');
  if (patch.timeZone !== undefined) assertTimeZone(patch.timeZone);
  const now = clock.now();
  const next: CommitmentRecord = {
    ...current,
    title: patch.title ?? current.title,
    notes: patch.notes ?? current.notes,
    dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
    dueTimeZone: patch.timeZone ?? current.dueTimeZone,
    revision: current.revision + 1,
    updatedAt: now,
  };
  tx.run(
    `UPDATE commitments SET title=?,notes=?,due_at=?,due_time_zone=?,revision=?,updated_at=? WHERE id=?`,
    [next.title, next.notes, next.dueAt, next.dueTimeZone, next.revision, now, id],
  );
  appendHistory(tx, next, 'corrected', now);
  return next;
}

function terminate(
  tx: Transaction,
  id: string,
  expectedRevision: number,
  status: Exclude<CommitmentStatus, 'active'>,
  operation: CommitmentOperation,
  clock: Clock,
): CommitmentRecord {
  const current = guard(tx, id, expectedRevision);
  if (current.status !== 'active') {
    badRequest(`commitment is already ${current.status}`, { status: current.status });
  }
  const now = clock.now();
  const next: CommitmentRecord = {
    ...current,
    status,
    revision: current.revision + 1,
    updatedAt: now,
  };
  tx.run(`UPDATE commitments SET status=?,revision=?,updated_at=? WHERE id=?`, [
    status,
    next.revision,
    now,
    id,
  ]);
  appendHistory(tx, next, operation, now);
  return next;
}

export function completeCommitment(
  tx: Transaction,
  id: string,
  expectedRevision: number,
  clock: Clock,
): CommitmentRecord {
  return terminate(tx, id, expectedRevision, 'completed', 'completed', clock);
}

export function cancelCommitment(
  tx: Transaction,
  id: string,
  expectedRevision: number,
  clock: Clock,
): CommitmentRecord {
  return terminate(tx, id, expectedRevision, 'cancelled', 'cancelled', clock);
}

/** Reopen keeps identity; a genuinely new promise gets a new identity. */
export function reopenCommitment(
  tx: Transaction,
  id: string,
  expectedRevision: number,
  clock: Clock,
): CommitmentRecord {
  const current = guard(tx, id, expectedRevision);
  if (current.status === 'active') badRequest('commitment is already active', { status: current.status });
  const now = clock.now();
  const next: CommitmentRecord = {
    ...current,
    status: 'active',
    revision: current.revision + 1,
    updatedAt: now,
  };
  tx.run(`UPDATE commitments SET status='active',revision=?,updated_at=? WHERE id=?`, [
    next.revision,
    now,
    id,
  ]);
  appendHistory(tx, next, 'reopened', now);
  return next;
}

export interface PlanItem {
  commitment: CommitmentRecord;
  isOverdue: boolean;
}

export interface DailyPlan {
  date: string;
  timeZone: string;
  items: PlanItem[];
  unscheduled: CommitmentRecord[];
}

export function dailyPlan(tx: Transaction, dateLocal: string, timeZone: string): DailyPlan {
  const { start, end } = localDayBounds(dateLocal, timeZone);
  const rows = tx.all(`SELECT * FROM commitments WHERE status = 'active' ORDER BY due_at ASC, id ASC`, []);
  const items: PlanItem[] = [];
  const unscheduled: CommitmentRecord[] = [];
  for (const row of rows) {
    const c = mapCommitment(row);
    if (c.dueAt === null) unscheduled.push(c);
    else if (c.dueAt < end) items.push({ commitment: c, isOverdue: c.dueAt < start });
  }
  return { date: dateLocal, timeZone, items, unscheduled };
}
