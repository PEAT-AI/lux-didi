import type { SchemaMigration, Transaction } from '../contracts/storage.js';
export const taskMigrations: readonly SchemaMigration[] = [{ owner: 'tasks', version: 1, statements: [
  `CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    current_revision INTEGER NOT NULL, status TEXT NOT NULL, final_answer TEXT, content_pruned_at INTEGER
  )`,
  `CREATE TABLE task_revisions (
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, task_revision INTEGER NOT NULL,
    connection_generation INTEGER NOT NULL, created_at INTEGER NOT NULL, owner_words TEXT, evidence TEXT,
    PRIMARY KEY(task_id,task_revision)
  )`,
  `CREATE TABLE task_operations (
    operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_revision INTEGER NOT NULL,
    connection_generation INTEGER NOT NULL, tool TEXT NOT NULL, effect TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','committed','failed','unknown')),
    arguments TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,task_revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE task_receipts (
    operation_id TEXT PRIMARY KEY REFERENCES task_operations(operation_id) ON DELETE CASCADE,
    state TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE task_deliveries (
    attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_revision INTEGER NOT NULL,
    connection_generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('attached','pending','delivered','closed','failed')),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,task_revision) ON DELETE CASCADE
  )`,
] }, { owner: 'tasks', version: 2, statements: [
  `CREATE TABLE task_effect_journal (identity_hash TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), value TEXT, updated_at INTEGER NOT NULL)`,
] }];
/** Same 30-day content / 90-day metadata policy as trace. Identities and outcome survive content. */
export function pruneTaskContent(tx: Transaction, now: number): void {
  const contentCutoff = now - 30 * 86400000;
  tx.run('UPDATE task_revisions SET owner_words=NULL,evidence=NULL WHERE task_id IN (SELECT task_id FROM tasks WHERE updated_at < ?)', [contentCutoff]);
  tx.run('UPDATE task_operations SET arguments=NULL,result=NULL WHERE task_id IN (SELECT task_id FROM tasks WHERE updated_at < ?)', [contentCutoff]);
  tx.run('UPDATE task_receipts SET receipt=NULL WHERE operation_id IN (SELECT operation_id FROM task_operations WHERE updated_at < ?)', [contentCutoff]);
  tx.run('UPDATE tasks SET final_answer=NULL,content_pruned_at=? WHERE updated_at < ? AND content_pruned_at IS NULL', [now, contentCutoff]);
  tx.run('UPDATE task_effect_journal SET value=NULL WHERE updated_at < ?', [contentCutoff]);
  tx.run('DELETE FROM task_effect_journal WHERE updated_at < ?', [now - 90 * 86400000]);
  tx.run('DELETE FROM tasks WHERE updated_at < ?', [now - 90 * 86400000]);
}
export interface TaskRecord { task_id: string; task_revision: number; connection_generation: number }
export interface OperationRecord extends TaskRecord {
  operation_id: string; tool: string; effect: string;
  state: 'pending' | 'committed' | 'failed' | 'unknown'; args: unknown; result: unknown;
}
