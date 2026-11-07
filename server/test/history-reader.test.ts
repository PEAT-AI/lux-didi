/**
 * The history search reranks its candidate pool before the five-session cut.
 *
 * A past call whose summary paraphrases the question does not look relevant to a
 * summary-only score, so its evidence is dropped before the cut even though its
 * turns are exactly what Rob asked about. The pool is built from the summaries in
 * `ORDER BY id` and the ranked list keeps only five, so the ninth session in that
 * order was the one lost. Synthetic store, no model, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/schema.js';
import * as summaries from '../domain/summaries.js';
import { recordHistorySession } from '../domain/history-lifecycle.js';
import { backfillHistoryTurns } from '../domain/history-turns.js';
import { createHistoryReader } from '../domain/history-reader.js';
import type { DataClass } from '../adapters/model/types.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function open(): { store: Store; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'didi-history-reader-'));
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
  return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedSession(store: Store, id: string, at: number): void {
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
        journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,1,'ended',?,?,?,?,NULL)`,
      [id, store.assistantId, store.authorityEpoch, `key-${id}`, `fp-${id}`, 'client', 'audit', 'profile', 'prompt', 'terminal',
        JSON.stringify({ state: 'closed', code: 'normal' }), at, at, at]);
    recordHistorySession(tx, id, 'owner', ['ordinary' as DataClass], [], at);
  });
}

function seedTurn(store: Store, id: string, kind: 'inputTranscription' | 'outputTranscription', text: string, at: number): void {
  store.transaction(tx => tx.run(
    'INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,?,?)',
    [id, kind, text, text.length, at]));
}

function seedSummary(store: Store, id: string, text: string, endedAt: number): void {
  store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: id, status: 'complete', summary: text,
    dataClass: 'ordinary', sourceRevision: 1, endedAt, now: endedAt }));
}

/** Nine past calls whose summaries are numbered in the pool's own `ORDER BY id` order, gold last. */
function seedPool(store: Store): void {
  for (let index = 1; index <= 9; index += 1) {
    const id = `call-${String(index).padStart(2, '0')}`;
    const at = NOW + index * DAY;
    seedSession(store, id, at);
  }
  store.transaction(tx => {
    for (let index = 1; index <= 9; index += 1) {
      const id = `call-${String(index).padStart(2, '0')}`;
      seedSummary(store, id, index === 9
        ? 'The owner had a sore tooth and asked what to do about it.'
        : `Call ${index} covered the weather and the walk to the shop.`, NOW + index * DAY);
      // The pool is read in this order; the ninth row is the one the cut used to drop.
      tx.run('UPDATE conversation_summaries SET id=? WHERE live_session_id=?', [`summary-${index}`, id]);
    }
  });
  // The gold call mentions the dentist only in its turns, never in its summary.
  seedTurn(store, 'call-09', 'inputTranscription', 'I still need the dentist for this tooth.', NOW + 9 * DAY);
  seedTurn(store, 'call-09', 'outputTranscription', 'The dentist can see you on the twelfth.', NOW + 9 * DAY);
  seedTurn(store, 'call-09', 'inputTranscription', 'Then the dentist it is.', NOW + 9 * DAY);
  store.transaction(tx => { backfillHistoryTurns(tx); });
}

function scope(store: Store): Parameters<ReturnType<typeof createHistoryReader>['read']>[1] {
  return {
    ownerId: store.assistantId, runId: 'reader-test', routeIdentity: 'synthetic',
    authorityEpoch: store.authorityEpoch, revision: 1, allowedClasses: ['ordinary' as DataClass],
  };
}

test('the ninth session in the pool survives the five-session cut when its turns hold the answer', () => {
  const f = open();
  try {
    seedPool(f.store);
    const reader = createHistoryReader(() => NOW + 10 * DAY);
    const result = f.store.transaction(tx => reader.read(tx, scope(f.store), { query: 'when is the dentist', limit: 5 }));
    const hits = (result.response['hits'] as { sessionId: string }[]).map(hit => hit.sessionId);
    assert.equal(hits.length, 5, 'the output shape stays five sessions');
    assert.ok(hits.includes('call-09'), `the call whose turns hold the answer is in the top five: ${hits.join(',')}`);
  } finally { f.cleanup(); }
});

test('a call the summary already answers keeps its place in the top five', () => {
  const f = open();
  try {
    seedPool(f.store);
    seedSummary(f.store, 'call-03', 'The dentist is booked for the twelfth of November.', NOW + 3 * DAY);
    const reader = createHistoryReader(() => NOW + 10 * DAY);
    const result = f.store.transaction(tx => reader.read(tx, scope(f.store), { query: 'when is the dentist', limit: 5 }));
    const hits = (result.response['hits'] as { sessionId: string }[]).map(hit => hit.sessionId);
    assert.ok(hits.includes('call-03'), `a summary that names the dentist still reaches the top five: ${hits.join(',')}`);
    assert.ok(hits.includes('call-09'), `and the turn-only call still reaches it too: ${hits.join(',')}`);
  } finally { f.cleanup(); }
});

test('a pool with no matching term still answers with the newest five calls', () => {
  const f = open();
  try {
    seedPool(f.store);
    const reader = createHistoryReader(() => NOW + 10 * DAY);
    const result = f.store.transaction(tx => reader.read(tx, scope(f.store), { query: 'what did we talk about', limit: 5 }));
    const hits = (result.response['hits'] as { sessionId: string }[]).map(hit => hit.sessionId);
    assert.equal(hits.length, 5);
    assert.deepEqual(hits, ['call-09', 'call-08', 'call-07', 'call-06', 'call-05'], 'no term to rank on keeps recency order');
  } finally { f.cleanup(); }
});
