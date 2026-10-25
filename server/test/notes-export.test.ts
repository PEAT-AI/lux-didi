import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { JsonObject } from '../adapters/model/types.js';
import { Store } from '../runtime/store.js';
import type { VaultSaveArgs, VaultTransportResult } from '../tools/vault-write.js';
import {
  EXPORT_DAY_LIMIT, EXPORT_FLUSH_LIMIT, exportKey, exportPlan, NotesExporter, notesExportMigrations, provenanceLine,
} from '../tools/notes-export.js';

const candidate = (id: string, text: string, kind: 'fact' | 'preference' | 'task' = 'fact') => ({ id, text, kind });

test('only fact and preference notes are exported; a task never is', () => {
  const plan = exportPlan({
    candidates: [candidate('1', 'Rob prefers morning calls', 'preference'), candidate('2', 'Rob lives in Lisbon', 'fact'), candidate('3', 'Call the bank', 'task')],
    exportedKeys: new Set(), nearDuplicates: new Map(), flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: EXPORT_DAY_LIMIT,
  });
  assert.deepEqual(plan.selected.map(item => item.id), ['1', '2']);
  assert.equal(plan.skipped, 1);
});

test('the dedupe key ignores case, whitespace and punctuation, and an exported key is never sent twice', () => {
  assert.equal(exportKey('  Rob PREFERS morning-calls. '), exportKey('rob prefers morning calls'));
  const plan = exportPlan({
    candidates: [candidate('1', 'Rob lives in Lisbon'), candidate('2', 'rob lives in lisbon.'), candidate('3', 'Rob lives in Porto')],
    exportedKeys: new Set([exportKey('Rob lives in Lisbon')]), nearDuplicates: new Map(),
    flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: EXPORT_DAY_LIMIT,
  });
  assert.deepEqual(plan.selected.map(item => item.id), ['3']);
  assert.equal(plan.skipped, 2);
});

test('a near duplicate above 0.95 is skipped, and an exactly 0.95 match is sent', () => {
  const plan = exportPlan({
    candidates: [candidate('1', 'Rob lives in Lisbon now'), candidate('2', 'Rob lives in Lisbon today')],
    exportedKeys: new Set(), nearDuplicates: new Map([[exportKey('Rob lives in Lisbon now'), 0.97], [exportKey('Rob lives in Lisbon today'), 0.95]]),
    flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: EXPORT_DAY_LIMIT,
  });
  assert.deepEqual(plan.selected.map(item => item.id), ['2']);
  assert.equal(plan.skipped, 1);
});

test('at most ten rows leave in one flush and at most twenty a day', () => {
  const many = Array.from({ length: 14 }, (_, index) => candidate(String(index), `Note number ${index}`));
  const flush = exportPlan({ candidates: many, exportedKeys: new Set(), nearDuplicates: new Map(), flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: EXPORT_DAY_LIMIT });
  assert.equal(flush.selected.length, 10);
  assert.equal(flush.remaining, 4);
  const day = exportPlan({ candidates: many, exportedKeys: new Set(), nearDuplicates: new Map(), flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: 2 });
  assert.equal(day.selected.length, 2);
  assert.equal(day.remaining, 12);
  const none = exportPlan({ candidates: many, exportedKeys: new Set(), nearDuplicates: new Map(), flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: 0 });
  assert.equal(none.selected.length, 0);
  assert.equal(none.remaining, 14);
});

test('the provenance line names the source, the session and the timestamp, so a reader knows where the row came from', () => {
  const line = provenanceLine({ sessionId: 'session-9', at: Date.UTC(2026, 9, 25, 12, 0, 0) });
  assert.match(line, /^Source: didi-voice remember_note, session session-9, 2026-10-25T12:00:00\.000Z$/u);
});

test('a plan with nothing eligible is a no-op, not an empty write', () => {
  const plan = exportPlan({ candidates: [], exportedKeys: new Set(), nearDuplicates: new Map(), flushRemaining: EXPORT_FLUSH_LIMIT, dayRemaining: EXPORT_DAY_LIMIT });
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.remaining, 0);
});

function ledger(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'notes-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...notesExportMigrations]);
  t.after(() => store.close());
  return store;
}

const transportOf = (outcomes: VaultTransportResult[]) => {
  const calls: VaultSaveArgs[] = [];
  return { calls, transport: { async save(args: VaultSaveArgs) { calls.push(args); return outcomes.shift() ?? { outcome: 'inserted', insightId: 'insight-1' }; } } };
};

test('the exporter writes one row per note through the ledger, and the second flush sends nothing twice', async t => {
  const store = ledger(t);
  const fake = transportOf([{ outcome: 'inserted', insightId: 'insight-1' }, { outcome: 'inserted', insightId: 'insight-2' }]);
  const events: JsonObject[] = [];
  const exporter = new NotesExporter({ store, sessionId: 'session-7', transport: fake.transport, nearDuplicate: async () => undefined, now: () => Date.UTC(2026, 9, 25, 12, 0, 0), log: event => events.push(event), enabled: true });
  const candidates = [candidate('1', 'Rob prefers morning calls', 'preference'), candidate('2', 'Rob lives in Lisbon')];
  const first = await exporter.flush(candidates);
  assert.deepEqual(first, { exported: 2, skipped: 0, failed: 0, unknown: 0, remaining: 0 });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]?.insightType, 'USER_PREFERENCE');
  assert.equal(fake.calls[1]?.insightType, 'UNCATEGORIZED');
  assert.match(fake.calls[1]?.content ?? '', /^Rob lives in Lisbon\n\nSource: didi-voice remember_note, session session-7, 2026-10-25T12:00:00\.000Z$/u);
  const second = await exporter.flush(candidates);
  assert.deepEqual(second, { exported: 0, skipped: 2, failed: 0, unknown: 0, remaining: 0 });
  assert.equal(fake.calls.length, 2, 'a replay sends nothing');
  assert.deepEqual(Object.keys(events[0] ?? {}).filter(key => key !== 'event').sort(), ['exported', 'failed', 'id', 'remaining', 'skipped', 'unknown']);
});

test('the switch off exports nothing, and the ledger is untouched', async t => {
  const store = ledger(t);
  const fake = transportOf([]);
  const exporter = new NotesExporter({ store, sessionId: 'session-8', transport: fake.transport, nearDuplicate: async () => undefined, now: () => 1_000, log: () => {}, enabled: false });
  const summary = await exporter.flush([candidate('1', 'Rob lives in Lisbon')]);
  assert.equal(summary.exported, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM note_exports', [])?.['n'] ?? -1)), 0);
});

test('a flush leaves at most ten rows, and a rolling day refuses the twenty first', async t => {
  const store = ledger(t);
  const fake = transportOf([]);
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  const exporter = new NotesExporter({ store, sessionId: 'session-9', transport: fake.transport, nearDuplicate: async () => undefined, now: () => now, log: () => {}, enabled: true });
  const many = Array.from({ length: 25 }, (_, index) => candidate(String(index), `Note number ${index}`));
  const first = await exporter.flush(many.slice(0, 15));
  assert.equal(first.exported, 10);
  assert.equal(first.remaining, 5);
  const second = await exporter.flush(many.slice(10, 25));
  assert.equal(second.exported, 10, 'the day budget stops at twenty');
  const third = await exporter.flush(many.slice(20, 25));
  assert.equal(third.exported, 0);
  assert.equal(fake.calls.length, 20);
});

test('an attempt whose outcome is unknown is never retried on the next flush', async t => {
  const store = ledger(t);
  const calls: VaultSaveArgs[] = [];
  const transport = { async save(args: VaultSaveArgs): Promise<VaultTransportResult> { calls.push(args); throw new Error('socket reset'); } };
  const exporter = new NotesExporter({ store, sessionId: 'session-10', transport, nearDuplicate: async () => undefined, now: () => 5_000, log: () => {}, enabled: true });
  const first = await exporter.flush([candidate('1', 'Rob lives in Lisbon')]);
  assert.deepEqual(first, { exported: 0, skipped: 0, failed: 0, unknown: 1, remaining: 0 });
  const second = await exporter.flush([candidate('1', 'Rob lives in Lisbon')]);
  assert.equal(second.skipped, 1, 'the attempted key is never sent again');
  assert.equal(calls.length, 1);
  assert.equal(store.transaction(tx => String(tx.get('SELECT state FROM note_exports', [])?.['state'])), 'unknown');
});

test('a vault outage is a failed row with its code, never a CHECK violation that loses the key', async t => {
  const store = ledger(t);
  const fake = transportOf([{ outcome: 'unavailable' }, { outcome: 'inserted', insightId: 'insight-9' }]);
  const exporter = new NotesExporter({ store, sessionId: 'session-11', transport: fake.transport, nearDuplicate: async () => undefined, now: () => 7_000, log: () => {}, enabled: true });
  const first = await exporter.flush([candidate('1', 'Rob lives in Lisbon')]);
  assert.deepEqual(first, { exported: 0, skipped: 0, failed: 1, unknown: 0, remaining: 0 });
  const state = store.transaction(tx => ({ state: String(tx.get('SELECT state FROM note_exports', [])?.['state']), code: tx.get('SELECT code FROM note_exports', [])?.['code'] }));
  assert.equal(state.state, 'failed');
  assert.equal(state.code, 'vault_unavailable');
  const second = await exporter.flush([candidate('1', 'Rob lives in Lisbon')]);
  assert.equal(second.skipped, 1, 'the attempted key stays spent');
  assert.equal(fake.calls.length, 1);
});
