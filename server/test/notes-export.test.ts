import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPORT_DAY_LIMIT, EXPORT_FLUSH_LIMIT, exportKey, exportPlan, provenanceLine,
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
