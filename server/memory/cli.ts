/**
 * `import-memory`: load a reviewed JSONL of distilled owner notes into a stopped
 * host's domain store, and roll one run back through the owner-delete path.
 *
 * Content-free by construction: every line printed carries counts, ids, codes or
 * file paths, never note text. A dry run is the default; `--apply` writes.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { hostMigrations } from '../host/runtime.js';
import { redactDeletedMemoryContext } from '../chat/index.js';
import { redactDeletedMemorySnapshots } from '../live/index.js';
import { scrubDeletedMemoryResponses } from '../runtime/store.js';
import type { DomainContext } from '../contracts/domain.js';
import {
  MemoryImportError, applyImport, parseImportFile, planImport, runEntryIds,
} from './import.js';

const help = `Usage:
  node <compiled-root>/memory/cli.js import --db <absolute state.sqlite> --input <absolute jsonl> [--apply] [--max-items N]
  node <compiled-root>/memory/cli.js import --db <absolute state.sqlite> --rollback <run id>

Dry run is the default and prints counts only. --apply writes through the domain
module: one ordinary session per run, one ordinary entry per item. The host must
be stopped; an online backup is taken and integrity-checked before any write.
`;

interface Options { readonly db: string; readonly input?: string; readonly apply: boolean; readonly maxItems?: number; readonly rollback?: string }

function invalid(message: string): never { throw new MemoryImportError('invalid_arguments', message); }

function requireAbsolute(value: string | undefined, flag: string): string {
  if (value === undefined) invalid(`${flag} is required`);
  if (!isAbsolute(value)) invalid(`${flag} must be an absolute path`);
  return value;
}

function options(args: readonly string[]): Options {
  if (args[0] !== 'import') invalid('the only command is import');
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--apply') { apply = true; continue; }
    if (!['--db', '--input', '--max-items', '--rollback'].includes(flag)) invalid(`unknown option ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) invalid(`${flag} needs a value`);
    if (values.has(flag)) invalid(`${flag} is given twice`);
    values.set(flag, value);
    index += 1;
  }
  const db = requireAbsolute(values.get('--db'), '--db');
  if (basename(db) !== 'state.sqlite') invalid('--db must name the private state.sqlite file');
  const rollback = values.get('--rollback');
  if (rollback !== undefined) {
    if (values.has('--input') || apply || values.has('--max-items')) invalid('--rollback takes no other option');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(rollback)) invalid('--rollback needs a run id');
    return { db, apply: false, rollback };
  }
  const rawMax = values.get('--max-items');
  let maxItems: number | undefined;
  if (rawMax !== undefined) {
    if (!/^[1-9]\d{0,5}$/.test(rawMax)) invalid('--max-items needs a positive integer');
    maxItems = Number(rawMax);
  }
  return { db, input: requireAbsolute(values.get('--input'), '--input'), apply, ...(maxItems !== undefined ? { maxItems } : {}) };
}

const emit = (line: object): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

/**
 * The host holds an exclusive writer lock on `writer.sqlite` for its whole life
 * (server/runtime/store.ts). Probe it the same way before touching state.sqlite.
 */
function assertHostStopped(directory: string): void {
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(join(directory, 'writer.sqlite'), { timeout: 0 });
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
  } catch {
    throw new MemoryImportError('writer_locked', 'the host still holds the writer');
  } finally { probe?.close(); }
}

function integrityCheck(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    return String(Object.values(row ?? {})[0] ?? 'unknown');
  } finally { db.close(); }
}

/** SQLite online backup: a consistent snapshot of an open database, never a file copy. */
function backupDatabase(dbPath: string, directory: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(directory, `state.sqlite.bak-${stamp}`);
  let writer: DatabaseSync | undefined;
  try {
    writer = new DatabaseSync(dbPath);
    writer.prepare('VACUUM INTO ?').run(target);
  } catch (error) {
    throw new MemoryImportError('backup_failed', String((error as Error)?.message ?? error));
  } finally { writer?.close(); }
  if (integrityCheck(target) !== 'ok') throw new MemoryImportError('backup_failed', 'backup failed integrity_check');
  return target;
}

function context(store: Store): DomainContext {
  return { assistantId: store.assistantId, clientId: 'import-memory', authorityEpoch: store.authorityEpoch, now: new Date().toISOString() };
}

function rollback(store: Store, runId: string): number {
  const domain = createDomainPort({ outbox: Outbox });
  const ids = store.transaction(tx => runEntryIds(tx, runId));
  if (ids.length === 0) throw new MemoryImportError('run_not_found', `no imported entries for run ${runId}`);
  let deleted = 0;
  for (const id of ids) {
    // Exactly the HTTP delete route's sequence: tombstone, then scrub every cached surface.
    let publish: () => void = () => {};
    store.transaction(tx => {
      let text: string | undefined;
      try { text = domain.execute(tx, 'resolveEntries', { entryIds: [id] }, context(store)).records[0]?.text; } catch { text = undefined; }
      domain.execute(tx, 'deleteEntry', { id }, context(store));
      redactDeletedMemoryContext(tx, id);
      publish = redactDeletedMemorySnapshots(store, tx, id).publish;
      scrubDeletedMemoryResponses(tx, store.assistantId, text);
    });
    publish();
    deleted += 1;
  }
  return deleted;
}

function main(args: readonly string[]): number {
  const parsed = options(args);
  const directory = dirname(parsed.db);
  assertHostStopped(directory);
  if (integrityCheck(parsed.db) !== 'ok') throw new MemoryImportError('backup_failed', 'state.sqlite failed integrity_check');
  if (parsed.rollback !== undefined) {
    const store = new Store(directory, hostMigrations);
    try { emit({ event: 'memory_import_rollback', runId: parsed.rollback, deleted: rollback(store, parsed.rollback) }); }
    finally { store.close(); }
    return 0;
  }
  const file = parsed.input!;
  const parsedFile = parseImportFile(readFileSync(file, 'utf8'));
  const runId = randomUUID();
  if (parsed.apply) emit({ event: 'memory_import_backup', path: backupDatabase(parsed.db, directory) });
  const store = new Store(directory, hostMigrations);
  try {
    const plan = store.transaction(tx => planImport(tx, parsedFile, runId, parsed.maxItems));
    for (const rejection of plan.rejected) emit({ event: 'memory_import_rejected', line: rejection.line, code: rejection.code });
    emit({
      event: 'memory_import', mode: parsed.apply ? 'apply' : 'dry-run', runId,
      items: parsedFile.items.length, accepted: plan.accepted.length, superseded: plan.superseded.length,
      existing: plan.existing.length, tombstoned: plan.tombstoned.length, limited: plan.limited.length,
      rejected: plan.rejected.length,
    });
    if (!parsed.apply) return 0;
    if (plan.accepted.length > 0) {
      const written = store.transaction(tx => applyImport(tx, plan, { now: () => Date.now() }));
      emit({ event: 'memory_import_applied', runId, sessionId: written.sessionId, entries: written.entryIds.length });
    } else emit({ event: 'memory_import_applied', runId, entries: 0 });
    if (integrityCheck(parsed.db) !== 'ok') throw new MemoryImportError('backup_failed', 'state.sqlite failed integrity_check after the import');
  } finally { store.close(); }
  return 0;
}

if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
  process.stdout.write(help);
} else if (process.argv.slice(2).length === 0) {
  process.stderr.write(help);
  process.exitCode = 2;
} else {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof MemoryImportError ? error.code
      : (error as { code?: string })?.code === 'WRITER_LOCKED' ? 'writer_locked' : 'import_failed';
    process.stderr.write(`${JSON.stringify({ event: 'memory_import_failed', code })}\n`);
    process.exitCode = 1;
  }
}
