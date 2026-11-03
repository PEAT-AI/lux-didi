import { taskMigrations, pruneTaskContent, type TaskRecord, type OperationRecord } from './task-schema.js';
import { backfillHistoryTurns } from '../domain/history-turns.js';
import { DatabaseSync, constants } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ServiceError } from '../contracts/errors.js';
import type { SchemaMigration, SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
import { traceMigrations } from '../trace/schema.js';
import { pruneTraceContent, type TraceExec } from '../trace/record.js';
export type { SchemaMigration, SQLRow, SQLValue, Transaction } from '../contracts/storage.js';

function privateFile(path: string): void {
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('State file must be a regular non-symlink file');
  chmodSync(path, 0o600);
}
// The schema upgrade and the credential admission are one unit: a refused
// admission rolls the migration back, so a failed upgrade never commits a
// newer schema that strands the previous app.
function admitCredential(directory: string): string {
  const credentialPath = join(directory, 'admin-credential');
  if (!existsSync(credentialPath)) writeFileSync(credentialPath, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  privateFile(credentialPath);
  const credential = readFileSync(credentialPath, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new ServiceError('CREDENTIAL_ADMISSION_FAILED', 'Invalid local admin credential', 500);
  return credential;
}
// SQLite parses the first statement (including compound triggers); sourceSQL is
// its exact original consumed prefix, not parameter-expanded/normalized SQL.
function singleStatement(sql: string, sourceSQL: string): void {
  if (!sourceSQL || !sql.startsWith(sourceSQL)) throw new Error('Invalid SQL source prefix');
  for (let i = sourceSQL.length; i < sql.length;) {
    if (' \t\n\f\r'.includes(sql[i]!)) { i++; continue; }
    if (sql.startsWith('--', i)) { const n = sql.indexOf('\n', i + 2); i = n < 0 ? sql.length : n + 1; continue; }
    if (sql.startsWith('/*', i)) { const n = sql.indexOf('*/', i + 2); if (n < 0) throw new Error('Unterminated SQL comment'); i = n + 2; continue; }
    throw new Error('Exactly one SQL statement is allowed');
  }
}
class Tx implements Transaction {
  #active = true;
  #prepareStatement: (sql: string) => StatementSync;
  constructor(prepareStatement: (sql: string) => StatementSync) { this.#prepareStatement = prepareStatement; }
  expire(): void { this.#active = false; }
  private prepare(sql: string): StatementSync {
    if (!this.#active) throw new ServiceError('TRANSACTION_EXPIRED', 'Transaction handle expired');
    if (sql.includes('\0')) throw new Error('Embedded NUL in SQL');
    if (Buffer.from(sql, 'utf8').toString('utf8') !== sql) throw new Error('Non-roundtripping Unicode in SQL');
    const statement = this.#prepareStatement(sql);
    singleStatement(sql, statement.sourceSQL);
    return statement;
  }
  run(sql: string, params: readonly SQLValue[] = []): number { return Number(this.prepare(sql).run(...params).changes); }
  all(sql: string, params: readonly SQLValue[] = []): SQLRow[] {
    const statement = this.prepare(sql);
    const names = statement.columns().map(column => column.name);
    if (new Set(names).size !== names.length) throw new Error('Ambiguous column names; use aliases');
    return statement.all(...params);
  }
  get(sql: string, params: readonly SQLValue[] = []): SQLRow | undefined {
    const statement = this.prepare(sql);
    const names = statement.columns().map(column => column.name);
    if (new Set(names).size !== names.length) throw new Error('Ambiguous column names; use aliases');
    return statement.get(...params);
  }
}
const runtimeSchema = [
  'CREATE TABLE IF NOT EXISTS runtime_migrations(owner TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(owner,version))',
  'CREATE TABLE IF NOT EXISTS runtime_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS runtime_outbox(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, entity_revision INTEGER NOT NULL, authority_epoch TEXT NOT NULL, required_grant TEXT NOT NULL, payload TEXT NOT NULL, source_timezone TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','claimed','acknowledged','failed','unknown','superseded')), claim_token TEXT, lease_until INTEGER)`,
  'CREATE INDEX IF NOT EXISTS runtime_outbox_due ON runtime_outbox(state,due_at,id)',
  'CREATE TABLE IF NOT EXISTS runtime_requests(assistant_id TEXT NOT NULL, client_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(assistant_id,client_id,request_key))',
  'CREATE TABLE IF NOT EXISTS runtime_sessions(token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL)',
];
export class Store {
  #db: DatabaseSync | undefined;
  #lock: DatabaseSync | undefined;
  #inTransaction = false;
  #allowControl = true;
  readonly authorityEpoch: string;
  readonly assistantId: string;
  readonly adminCredential: string;
  constructor(readonly directory: string, migrations: readonly SchemaMigration[] = []) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('State directory must not be a symlink');
    chmodSync(directory, 0o700);
    privateFile(join(directory, 'writer.sqlite'));
    try {
      this.#lock = new DatabaseSync(join(directory, 'writer.sqlite'), { timeout: 0 });
      this.#lock.exec('CREATE TABLE IF NOT EXISTS writer_lock(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
    } catch (error) {
      this.#lock?.close(); this.#lock = undefined;
      if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(error))) throw new ServiceError('WRITER_LOCKED', 'Another process owns this state directory', 409);
      throw error;
    }
    try {
      privateFile(join(directory, 'state.sqlite'));
      this.#db = new DatabaseSync(join(directory, 'state.sqlite'), { timeout: 0, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      const denied = new Set<number>([constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT, constants.SQLITE_PRAGMA, constants.SQLITE_ATTACH, constants.SQLITE_DETACH]);
      this.#db.setAuthorizer((action, arg1, arg2) => !this.#allowControl && ((denied.has(action) && !(action === constants.SQLITE_PRAGMA && arg1 === 'data_version' && arg2 === null)) || (action === constants.SQLITE_FUNCTION && arg2 === 'load_extension')) ? constants.SQLITE_DENY : constants.SQLITE_OK);
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        for (const sql of runtimeSchema) this.#db.exec(sql);
        // Trace tables are owned by the same Store and applied on every host: a debugger reads
        // one state.sqlite, never a second database with its own connection.
        this.applyMigrations([...migrations, ...traceMigrations, ...taskMigrations]);
        // Trace content retention: 30 days for owner content, nulled in place; 90 days for the
        // metadata rows that may be deleted. The run happens at host start, never inside a live call.
        const traceExec: TraceExec = {
          run: (sql, params = []) => Number(this.#db!.prepare(sql).run(...params).changes),
          all: (sql, params = []) => this.#db!.prepare(sql).all(...params) as SQLRow[],
        };
        const memoryTx = new Tx(sql => this.#db!.prepare(sql));
        try { backfillHistoryTurns(memoryTx); pruneTaskContent(memoryTx, Date.now()); } finally { memoryTx.expire(); }
        pruneTraceContent(traceExec, Date.now());
        this.#db.prepare("UPDATE task_operations SET state='unknown' WHERE state='pending'").run();
        this.#db.prepare("UPDATE runtime_outbox SET state='unknown', claim_token=NULL, lease_until=NULL WHERE state='claimed'").run();
        // Data hygiene at host start: a settled Live job row past its expiry is a delivered result from an
        // older run, and nothing reads it again. Purging it here keeps old feed text out of every surface.
        this.#db.prepare("DELETE FROM runtime_outbox WHERE entity_id LIKE 'live-job:%' AND state<>'pending' AND state<>'claimed' AND expires_at<=?").run(Date.now());
        for (const key of ['authorityEpoch', 'assistantId']) this.#db.prepare('INSERT OR IGNORE INTO runtime_meta VALUES (?,?)').run(key, randomUUID());
        this.authorityEpoch = String(this.#db.prepare('SELECT value FROM runtime_meta WHERE key=?').get('authorityEpoch')!.value);
        this.assistantId = String(this.#db.prepare('SELECT value FROM runtime_meta WHERE key=?').get('assistantId')!.value);
        this.adminCredential = admitCredential(directory);
        this.#db.exec('COMMIT');
      } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
      // Fold the WAL back after the retention run committed, so pruning 11 MB of owner content does not
      // leave a week of frames to be copied again on the next start. A checkpoint cannot run inside the
      // write transaction above.
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) { this.close(); throw error; }
  }
  private applyMigrations(migrations: readonly SchemaMigration[]): void {
    const owners = new Map<string, SchemaMigration[]>();
    for (const migration of migrations) {
      if (migration.owner === 'runtime') throw new Error('runtime migration owner is reserved');
      if (!/^[a-z][a-z0-9_-]*$/.test(migration.owner)) throw new Error('Invalid migration owner');
      const entries = owners.get(migration.owner) ?? []; entries.push(migration); owners.set(migration.owner, entries);
    }
    for (const entries of owners.values()) {
      entries.sort((a, b) => a.version - b.version);
      entries.forEach((entry, index) => { if (entry.version !== index + 1) throw new Error('Migrations must be contiguous from version 1'); });
    }
    const applied = this.#db!.prepare('SELECT owner, MAX(version) AS version FROM runtime_migrations GROUP BY owner').all();
    for (const row of applied) if ((owners.get(String(row.owner))?.length ?? 0) < Number(row.version)) throw new Error('Migration downgrade refused');
    for (const [owner, entries] of owners) {
      const current = Number(applied.find(row => row.owner === owner)?.version ?? 0);
      for (const migration of entries.slice(current)) {
        const tx = new Tx(sql => this.#db!.prepare(sql));
        this.#allowControl = false;
        try { for (const sql of migration.statements) tx.run(sql); } finally { tx.expire(); this.#allowControl = true; }
        this.#db!.prepare('INSERT INTO runtime_migrations VALUES (?,?)').run(owner, migration.version);
      }
    }
  }
  transaction<T>(body: (tx: Transaction) => T extends PromiseLike<unknown> ? never : T): T {
    if (!this.#db) throw new ServiceError('STORE_CLOSED', 'Store closed');
    if (this.#inTransaction) throw new Error('Nested transactions are forbidden');
    if (body.constructor.name === 'AsyncFunction') throw new Error('Transaction callback must be synchronous');
    this.#inTransaction = true;
    const tx = new Tx(sql => this.#db!.prepare(sql));
    try {
      this.#db.exec('BEGIN IMMEDIATE'); this.#allowControl = false;
      const result = body(tx);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') throw new Error('Transaction callback must be synchronous');
      tx.expire(); this.#allowControl = true; this.#db.exec('COMMIT');
      return result;
    } catch (error) { tx.expire(); this.#allowControl = true; if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#inTransaction = false; }
  }
  /** Content capture is explicitly supplied by the host gate, never inferred from model text. */
  saveTaskRevision(identity: TaskRecord, ownerWords: readonly string[], evidence: unknown, contentAllowed: boolean, now = Date.now()): void {
    this.transaction(tx => {
      tx.run(`INSERT INTO tasks(task_id,created_at,updated_at,current_revision,status) VALUES (?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET updated_at=excluded.updated_at,current_revision=excluded.current_revision,status=excluded.status`,
        [identity.task_id, now, now, identity.task_revision, 'running']);
      tx.run('INSERT INTO task_revisions(task_id,task_revision,connection_generation,created_at,owner_words,evidence) VALUES (?,?,?,?,?,?)',
        [identity.task_id, identity.task_revision, identity.connection_generation, now, contentAllowed ? JSON.stringify(ownerWords) : null, contentAllowed ? JSON.stringify(evidence) : null]);
    });
  }
  saveTaskOperation(operation: OperationRecord, contentAllowed: boolean, now = Date.now()): void {
    this.transaction(tx => {
      tx.run(`INSERT INTO task_operations(operation_id,task_id,task_revision,connection_generation,tool,effect,state,arguments,result,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,result=excluded.result,updated_at=excluded.updated_at`,
        [operation.operation_id, operation.task_id, operation.task_revision, operation.connection_generation, operation.tool, operation.effect, operation.state,
          contentAllowed ? JSON.stringify(operation.args) : null, contentAllowed ? JSON.stringify(operation.result) : null, now, now]);
      if (operation.effect !== 'none' && operation.state !== 'pending') tx.run(`INSERT INTO task_receipts(operation_id,state,receipt,created_at) VALUES (?,?,?,?)
        ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,receipt=excluded.receipt`,
        [operation.operation_id, operation.state, contentAllowed ? JSON.stringify(operation.result) : null, now]);
    });
  }
  finishTask(identity: TaskRecord, status: string, answer: unknown, contentAllowed: boolean, now = Date.now()): boolean {
    return this.transaction(tx => tx.run('UPDATE tasks SET status=?,final_answer=?,updated_at=? WHERE task_id=? AND current_revision=? AND EXISTS (SELECT 1 FROM task_revisions r WHERE r.task_id=tasks.task_id AND r.task_revision=tasks.current_revision AND r.connection_generation=?)',
      [status, contentAllowed ? JSON.stringify(answer) : null, now, identity.task_id, identity.task_revision, identity.connection_generation]) === 1);
  }
  saveTaskDelivery(identity: TaskRecord, attemptId: string, state: 'attached' | 'pending' | 'delivered' | 'closed' | 'failed', now = Date.now()): void {
    this.transaction(tx => { tx.run(`INSERT INTO task_deliveries(attempt_id,task_id,task_revision,connection_generation,state,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`,
      [attemptId, identity.task_id, identity.task_revision, identity.connection_generation, state, now]); });
  }
  /** Sole durable writer for permission commits; argument-bearing identity strings are hashed at entry. */
  taskEffectJournal(contentAllowed: () => boolean): import('../tasks/authority.js').AuthorityPorts['journal'] {
    const key = (identity: string): string => createHash('sha256').update(identity).digest('hex');
    const redacted = { status: 'ok', text: '', references: [], next_cursor: null, coverage: 'Previously committed; content not retained.', repair: null };
    return {
      get: async identity => this.transaction(tx => {
        const row = tx.get('SELECT status,value FROM task_effect_journal WHERE identity_hash=?', [key(identity)]);
        if (!row) return undefined;
        if (row.status === 'pending') return { status: 'pending' as const };
        if (row.status === 'failed') return { status: 'failed' as const };
        return { status: 'succeeded' as const, value: row.value === null ? redacted : JSON.parse(String(row.value)) as unknown };
      }),
      put: async (identity, record) => this.transaction(tx => {
        const value = record.status === 'succeeded' && contentAllowed() ? JSON.stringify(record.value) : null;
        tx.run('INSERT INTO task_effect_journal(identity_hash,status,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(identity_hash) DO UPDATE SET status=excluded.status,value=excluded.value,updated_at=excluded.updated_at',
          [key(identity), record.status, value, Date.now()]);
      }),
    };
  }
  pruneTasks(now = Date.now()): void { this.transaction(tx => pruneTaskContent(tx, now)); }
  close(): void {
    if (this.#inTransaction) throw new Error('Cannot close during transaction');
    this.#db?.close(); this.#db = undefined;
    this.#lock?.close(); this.#lock = undefined;
  }
}

/** Keep replay fingerprints, but replace owner responses containing deleted content. */
export function scrubDeletedMemoryResponses(tx: Transaction, assistantId: string, text: string | undefined): void {
  if (text === undefined) return;
  const contains = (value: unknown): boolean => typeof value === 'string' ? value.includes(text)
    : Array.isArray(value) ? value.some(contains)
    : value !== null && typeof value === 'object' ? Object.values(value).some(contains) : false;
  for (const row of tx.all('SELECT client_id,request_key,response FROM runtime_requests WHERE assistant_id=?', [assistantId])) {
    const response = JSON.parse(String(row.response)) as { requestId: string };
    if (!contains(response)) continue;
    tx.run('UPDATE runtime_requests SET response=? WHERE assistant_id=? AND client_id=? AND request_key=?',
      [JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Cached response removed after memory deletion' }, requestId: response.requestId }),
        assistantId, String(row.client_id), String(row.request_key)]);
  }
}
