import { DatabaseSync, constants } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ServiceError } from '../contracts/errors.js';
import type { SchemaMigration, SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
export type { SchemaMigration, SQLRow, SQLValue, Transaction } from '../contracts/storage.js';

function privateFile(path: string): void {
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('State file must be a regular non-symlink file');
  chmodSync(path, 0o600);
}
// SQLite prepare accepts only the first statement. Reject hidden trailing statements,
// respecting SQL strings, quoted identifiers and comments (not an HTTP parser).
function singleStatement(sql: string): void {
  let quote = '', ended = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      const end = quote === '[' ? ']' : quote;
      if (c === end) { if (sql[i + 1] === end && quote !== '[') i++; else quote = ''; }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { const n = sql.indexOf('\n', i + 2); i = n < 0 ? sql.length : n; continue; }
    if (c === '/' && sql[i + 1] === '*') { const n = sql.indexOf('*/', i + 2); if (n < 0) throw new Error('Unterminated SQL comment'); i = n + 1; continue; }
    if (/\s/.test(c)) continue;
    if (ended) throw new Error('Exactly one SQL statement is allowed');
    if (c === ';') ended = true;
    else if (['\'', '"', '`', '['].includes(c)) quote = c;
  }
}
class Tx implements Transaction {
  #active = true;
  #prepareStatement: (sql: string) => StatementSync;
  constructor(prepareStatement: (sql: string) => StatementSync) { this.#prepareStatement = prepareStatement; }
  expire(): void { this.#active = false; }
  private prepare(sql: string): StatementSync {
    if (!this.#active) throw new ServiceError('TRANSACTION_EXPIRED', 'Transaction handle expired');
    singleStatement(sql);
    return this.#prepareStatement(sql);
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
      this.#db.setAuthorizer((action, _arg1, arg2) => !this.#allowControl && (denied.has(action) || (action === constants.SQLITE_FUNCTION && arg2 === 'load_extension')) ? constants.SQLITE_DENY : constants.SQLITE_OK);
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        for (const sql of runtimeSchema) this.#db.exec(sql);
        this.applyMigrations(migrations);
        this.#db.prepare("UPDATE runtime_outbox SET state='unknown', claim_token=NULL, lease_until=NULL WHERE state='claimed'").run();
        for (const key of ['authorityEpoch', 'assistantId']) this.#db.prepare('INSERT OR IGNORE INTO runtime_meta VALUES (?,?)').run(key, randomUUID());
        this.#db.exec('COMMIT');
      } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
      this.authorityEpoch = String(this.#db.prepare('SELECT value FROM runtime_meta WHERE key=?').get('authorityEpoch')!.value);
      this.assistantId = String(this.#db.prepare('SELECT value FROM runtime_meta WHERE key=?').get('assistantId')!.value);
      const credentialPath = join(directory, 'admin-credential');
      if (!existsSync(credentialPath)) writeFileSync(credentialPath, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
      privateFile(credentialPath);
      this.adminCredential = readFileSync(credentialPath, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(this.adminCredential)) throw new Error('Invalid local admin credential');
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
  close(): void {
    if (this.#inTransaction) throw new Error('Cannot close during transaction');
    this.#db?.close(); this.#db = undefined;
    this.#lock?.close(); this.#lock = undefined;
  }
}
