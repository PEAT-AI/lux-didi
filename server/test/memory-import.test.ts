import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { hostMigrations } from '../host/runtime.js';
import { resolveLiveMemory } from '../host/live.js';
import { IMPORT_PROVIDER, importedEntryId, listStandingMemory, parseImportFile } from '../memory/import.js';
import {
  NAYA_LIVE_BASE, STANDING_MEMORY_CHAR_LIMIT, STANDING_MEMORY_PREFACE, TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
  composeLiveSessionInstruction,
} from '../prompt/live-persona.js';

const cli = fileURLToPath(new URL('../memory/cli.js', import.meta.url));
/** The build copies only `*.mjs` fixtures, so the source tree is the fallback in an unpacked checkout. */
const samplePath = [new URL('./fixtures/memory-import-sample.jsonl', import.meta.url),
  new URL('../../test/fixtures/memory-import-sample.jsonl', import.meta.url)]
  .map(url => fileURLToPath(url)).find(path => existsSync(path));
if (samplePath === undefined) throw new Error('memory-import sample fixture is missing');
const sampleText = readFileSync(samplePath, 'utf8');

interface Run { readonly status: number | null; readonly out: string; readonly err: string; readonly lines: Record<string, unknown>[] }
function cliRun(args: string[]): Run {
  const result = spawnSync(process.execPath, [cli, 'import', ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1' } });
  const out = result.stdout ?? '';
  const lines = out.trim().length ? out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : [];
  return { status: result.status, out, err: result.stderr ?? '', lines };
}
const event = (run: Run, name: string) => run.lines.find(line => line['event'] === name);
const eventValue = (run: Run, name: string): Record<string, unknown> => {
  const found = event(run, name);
  assert.ok(found, `${name} line present`);
  return found;
};

function fixture(t: { after(fn: () => void): void }): { dir: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), 'didi-memory-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The host's own opener and migration list, so the copy is a real state directory.
  new Store(root, hostMigrations).close();
  return { dir: root, db: join(root, 'state.sqlite') };
}

function openStore(dir: string): Store { return new Store(dir, hostMigrations); }
function integrity(db: string): string {
  const handle = new DatabaseSync(db, { readOnly: true });
  try { return String(Object.values(handle.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]); } finally { handle.close(); }
}
function prompt(store: Store): ReturnType<typeof composeLiveSessionInstruction> {
  const records = store.transaction(tx => resolveLiveMemory(tx));
  return composeLiveSessionInstruction({
    text: NAYA_LIVE_BASE, tools: [], records: records.filter(record => record.dataClass === 'ordinary'),
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
  });
}

test('the shipped sample parses to 30 valid synthetic notes', () => {
  const parsed = parseImportFile(sampleText);
  assert.equal(parsed.items.length, 30);
  assert.deepEqual(parsed.rejected, []);
  assert.equal(new Set(parsed.items.map(item => item.id)).size, 30);
  assert.equal(new Set(parsed.items.map(item => `${item.topic}\u0000${item.label}`)).size, 30, 'no intra-file supersession');
});

test('line validation refuses an unknown key, a bad date and a classified note without echoing text', () => {
  const items = parseImportFile(sampleText).items;
  const base = { ...items[0]! } as Record<string, unknown>;
  const line = (patch: Record<string, unknown> | undefined) => JSON.stringify({ ...base, ...(patch ?? {}) });
  const unknown = parseImportFile(line({ extra: 1 }));
  assert.deepEqual(unknown.rejected, [{ line: 1, code: 'unknown_field' }]);
  assert.deepEqual(parseImportFile(line({ capturedAt: '2026-02-31' })).rejected, [{ line: 1, code: 'invalid_field' }]);
  const privateNote = parseImportFile(line({ text: 'This is private: the mint is Friday' }));
  assert.deepEqual(privateNote.rejected, [{ line: 1, code: 'private_memory_unsupported' }]);
  assert.equal(privateNote.items.length, 0);
  assert.deepEqual(parseImportFile(line({ text: 'privately, the mint is Friday' })).rejected, [{ line: 1, code: 'private_memory_unsupported' }]);
});

test('dry run counts the sample, prints no text and writes nothing', t => {
  const f = fixture(t);
  const run = cliRun(['--db', f.db, '--input', samplePath]);
  assert.equal(run.status, 0, run.err);
  const summary = eventValue(run, 'memory_import');
  assert.equal(summary['mode'], 'dry-run');
  assert.equal(summary['items'], 30);
  assert.equal(summary['accepted'], 30);
  assert.equal(summary['superseded'], 0);
  assert.equal(summary['tombstoned'], 0);
  assert.equal(summary['rejected'], 0);
  assert.equal(event(run, 'memory_import_backup'), undefined, 'a dry run takes no backup');
  assert.ok(!`${run.out}${run.err}`.includes('synthetic note'), 'no note text on any stream');
  const store = openStore(f.dir);
  try { assert.equal(store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS c FROM entries')!['c'])), 0); } finally { store.close(); }
  assert.equal(integrity(f.db), 'ok');
});

test('apply writes 30 ordinary entries behind one ordinary session, and a re-run writes nothing', t => {
  const f = fixture(t);
  const first = cliRun(['--db', f.db, '--input', samplePath, '--apply']);
  assert.equal(first.status, 0, first.err);
  const backup = eventValue(first, 'memory_import_backup')['path'];
  assert.ok(typeof backup === 'string' && existsSync(backup), 'the online backup is on disk');
  assert.equal(integrity(String(backup)), 'ok');
  const applied = eventValue(first, 'memory_import_applied');
  assert.equal(applied['entries'], 30);
  assert.ok(!`${first.out}${first.err}`.includes('synthetic note'), 'no note text on any stream');

  const store = openStore(f.dir);
  let rows: Record<string, unknown>[] = [];
  try {
    rows = store.transaction(tx => tx.all(
      `SELECT e.id AS id, e.session_id AS session_id,
         (SELECT data_class FROM routing_labels r WHERE r.subject_kind='entry' AND r.subject_id=e.id ORDER BY revision DESC LIMIT 1) AS data_class,
         (SELECT data_class FROM routing_labels r WHERE r.subject_kind='session' AND r.subject_id=e.session_id ORDER BY revision DESC LIMIT 1) AS session_class,
         (SELECT COUNT(*) FROM source_references s WHERE s.owner_id=e.id AND s.provider=?) AS refs
       FROM entries e`, [IMPORT_PROVIDER]));
  } finally { store.close(); }
  assert.equal(rows.length, 30);
  for (const row of rows) {
    assert.equal(row['data_class'], 'ordinary');
    assert.equal(row['session_class'], 'ordinary');
    assert.equal(Number(row['refs']), 1);
  }

  const again = cliRun(['--db', f.db, '--input', samplePath, '--apply']);
  assert.equal(again.status, 0, again.err);
  const summary = eventValue(again, 'memory_import');
  assert.equal(summary['accepted'], 0);
  assert.equal(summary['existing'], 30);
  assert.equal(eventValue(again, 'memory_import_applied')['entries'], 0);
  const after = openStore(f.dir);
  try { assert.equal(after.transaction(tx => Number(tx.get('SELECT COUNT(*) AS c FROM entries')!['c'])), 30); } finally { after.close(); }
  assert.equal(integrity(f.db), 'ok');
});

test('the standing section is ranked, deterministic and omits the lowest notes for budget', t => {
  const f = fixture(t);
  assert.equal(cliRun(['--db', f.db, '--input', samplePath, '--apply']).status, 0);
  const store = openStore(f.dir);
  let ranked: ReturnType<typeof listStandingMemory>;
  let first: ReturnType<typeof composeLiveSessionInstruction>;
  let second: ReturnType<typeof composeLiveSessionInstruction>;
  let mixed: ReturnType<typeof composeLiveSessionInstruction>;
  try {
    ranked = store.transaction(tx => listStandingMemory(tx));
    first = prompt(store);
    second = prompt(store);
    const records = store.transaction(tx => resolveLiveMemory(tx)).filter(record => record.dataClass === 'ordinary');
    mixed = composeLiveSessionInstruction({
      text: NAYA_LIVE_BASE, tools: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
      records: [{ id: 'plain-note', text: 'a plain voice note' }, ...records],
    });
  } finally { store.close(); }

  assert.equal(ranked.length, 30);
  for (let index = 1; index < ranked.length; index += 1) {
    assert.ok(ranked[index - 1]!.importance >= ranked[index]!.importance, 'importance desc');
  }
  assert.equal(first.text, second.text, 'composition is deterministic');
  const section = first.sections.find(entry => entry.id === 'standing-memory');
  assert.ok(section, 'the standing-memory section is composed');
  assert.ok(section!.chars <= STANDING_MEMORY_CHAR_LIMIT, 'under its own budget');
  assert.ok(first.text.includes(STANDING_MEMORY_PREFACE));
  assert.ok(first.omitted.length > 0 && first.omitted.every(entry => entry.reason === 'budget'));
  assert.deepEqual(first.selectedIds, ranked.slice(0, first.selectedIds.length).map(item => item.id),
    'selected ids are the ranking prefix');
  assert.ok(first.selectedIds.length < 30, 'the lowest notes are omitted');

  const ids = mixed.sections.map(entry => entry.id);
  assert.ok(ids.indexOf('standing-memory') > -1 && ids.indexOf('memory') > -1);
  assert.ok(ids.indexOf('standing-memory') < ids.indexOf('memory'), 'after owner lore, before # Memory');
  assert.ok(mixed.text.indexOf(STANDING_MEMORY_PREFACE) < mixed.text.indexOf('# Memory'));
});

test('a deleted note is tombstoned, never re-imported, and gone from the next prompt', t => {
  const f = fixture(t);
  assert.equal(cliRun(['--db', f.db, '--input', samplePath, '--apply']).status, 0);
  const store = openStore(f.dir);
  let target: { id: string; externalId: string; text: string };
  try {
    const ranked = store.transaction(tx => listStandingMemory(tx));
    const victim = ranked.find(item => item.importance === 3)!;
    const externalId = String(store.transaction(tx => tx.get(
      `SELECT external_id FROM source_references WHERE owner_id=? AND provider=?`, [victim.id, IMPORT_PROVIDER]))!['external_id']);
    target = { id: victim.id, externalId, text: victim.text };
    const domain = createDomainPort({ outbox: Outbox });
    store.transaction(tx => domain.execute(tx, 'deleteEntry', { id: victim.id },
      { assistantId: store.assistantId, clientId: 'test', authorityEpoch: store.authorityEpoch, now: new Date().toISOString() }));
  } finally { store.close(); }

  const rerun = cliRun(['--db', f.db, '--input', samplePath, '--apply']);
  assert.equal(rerun.status, 0, rerun.err);
  const summary = eventValue(rerun, 'memory_import');
  assert.equal(summary['tombstoned'], 1, 'the tombstone keeps the item deleted');
  assert.equal(summary['accepted'], 0);
  assert.equal(eventValue(rerun, 'memory_import_applied')['entries'], 0);

  const after = openStore(f.dir);
  try {
    const tombstone = after.transaction(tx => tx.get('SELECT entry_id FROM entry_tombstones WHERE entry_id=?', [importedEntryId(target.externalId)]));
    assert.ok(tombstone, 'the tombstone is keyed by the derived entry id');
    const next = prompt(after);
    assert.ok(!next.selectedIds.includes(target.id), 'the deleted note never reaches the next prompt');
    assert.ok(!next.text.includes(target.text), 'its text is gone from the composed instruction');
    assert.equal(target.id, importedEntryId(target.externalId), 'the entry id is derived from the idempotency key');
    assert.equal(after.transaction(tx => Number(tx.get('SELECT COUNT(*) AS c FROM entries WHERE id=?', [target.id])!['c'])), 0);
  } finally { after.close(); }
  assert.equal(integrity(f.db), 'ok');
});

test('rollback deletes a run through the owner-delete path', t => {
  const f = fixture(t);
  const applied = cliRun(['--db', f.db, '--input', samplePath, '--apply']);
  assert.equal(applied.status, 0, applied.err);
  const runId = String(eventValue(applied, 'memory_import')['runId']);

  const rolled = cliRun(['--db', f.db, '--rollback', runId]);
  assert.equal(rolled.status, 0, rolled.err);
  const line = eventValue(rolled, 'memory_import_rollback');
  assert.equal(line['runId'], runId);
  assert.equal(line['deleted'], 30);

  const store = openStore(f.dir);
  try {
    assert.equal(store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS c FROM entries')!['c'])), 0);
    assert.equal(store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS c FROM source_references')!['c'])), 0);
    assert.equal(store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS c FROM entry_tombstones')!['c'])), 30);
    assert.equal(prompt(store).sections.some(section => section.id === 'standing-memory'), false);
  } finally { store.close(); }

  const missing = cliRun(['--db', f.db, '--rollback', '00000000-0000-4000-8000-000000000000']);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /run_not_found/);
  assert.equal(integrity(f.db), 'ok');
});

test('the command refuses a relative path, an unknown option and a host that holds the writer', t => {
  const f = fixture(t);
  assert.equal(cliRun(['--db', 'state.sqlite', '--input', samplePath]).status, 1);
  assert.equal(cliRun(['--db', f.db, '--input', samplePath, '--nope', 'x']).status, 1);
  const held = new Store(f.dir, hostMigrations);
  try {
    const run = cliRun(['--db', f.db, '--input', samplePath]);
    assert.equal(run.status, 1);
    assert.match(run.err, /writer_locked/);
  } finally { held.close(); }
});
