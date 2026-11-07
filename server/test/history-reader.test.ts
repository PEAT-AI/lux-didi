/**
 * The history search reranks its whole candidate pool before the five-session cut.
 *
 * The pool used to be ordered by kind, not by relevance: five verbatim turn hits led it whatever their
 * score, so the call whose summary is all about the question was cut at whatever position it held.
 * The sessions here are numbered in the pool's own `ORDER BY id` order, gold last (position nine).
 * Synthetic store, no model, no network.
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
    recordHistorySession(tx, id, store.assistantId, ['ordinary' as DataClass], [], at);
  });
}

function seedTurn(store: Store, id: string, text: string, at: number): void {
  store.transaction(tx => tx.run(
    'INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,1,?,?)',
    [id, 'inputTranscription', text, text.length, at]));
}

function seedSummary(store: Store, id: string, text: string, endedAt: number): void {
  store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: id, status: 'complete', summary: text,
    dataClass: 'ordinary', sourceRevision: 1, endedAt, now: endedAt }));
}

/**
 * Nine past calls, numbered in the pool's own `ORDER BY id` order.
 *
 * Five of them mention the dentist only in a turn, which is what the verbatim turn index reaches, and
 * they are the newest. The ninth is the one that is about the appointment: it says so twice in its
 * summary, never in its turns, and it is the oldest, so a kind-then-recency cut leaves it at position six.
 */
function seedPool(store: Store): void {
  for (let index = 1; index <= 9; index += 1) {
    const id = `call-${String(index).padStart(2, '0')}`;
    // The ninth call is the oldest; the five turn hits are the newest five.
    const at = NOW + (index === 9 ? 0 : index + 9) * DAY;
    seedSession(store, id, at);
    seedSummary(store, id, `Call ${index} covered the weather and the walk to the shop.`, at);
    store.transaction(tx => tx.run('UPDATE conversation_summaries SET id=? WHERE live_session_id=?', [`summary-${index}`, id]));
  }
  for (let index = 1; index <= 5; index += 1) {
    const id = `call-${String(index).padStart(2, '0')}`;
    seedTurn(store, id, 'I asked about the dentist again and nothing moved.', NOW + (index + 9) * DAY);
  }
  store.transaction(tx => {
    tx.run('UPDATE conversation_summaries SET summary=? WHERE live_session_id=?',
      ['The dentist is booked for the twelfth; the dentist said half past eight.', 'call-09']);
  });
  seedTurn(store, 'call-09', 'Half past eight on the twelfth is fine.', NOW);
  store.transaction(tx => { backfillHistoryTurns(tx); });
}

function read(store: Store, query: string): string[] {
  const reader = createHistoryReader(() => NOW + 10 * DAY);
  const scope = {
    ownerId: store.assistantId, runId: 'reader-test', routeIdentity: 'synthetic',
    authorityEpoch: store.authorityEpoch, revision: 1, allowedClasses: ['ordinary' as DataClass],
  };
  const result = store.transaction(tx => reader.read(tx, scope, { query, limit: 5 }));
  return (result.response['hits'] as { sessionId: string }[]).map(hit => hit.sessionId);
}

function readHits(store: Store, query: string): Record<string, unknown>[] {
  const reader = createHistoryReader(() => NOW + 10 * DAY);
  const scope = {
    ownerId: store.assistantId, runId: 'reader-test', routeIdentity: 'synthetic',
    authorityEpoch: store.authorityEpoch, revision: 1, allowedClasses: ['ordinary' as DataClass],
  };
  const result = store.transaction(tx => reader.read(tx, scope, { query, limit: 5 }));
  return result.response['hits'] as Record<string, unknown>[];
}

test('the ninth session in the pool survives the five-session cut when it is the one about the question', () => {
  const f = open();
  try {
    seedPool(f.store);
    const hits = read(f.store, 'when is the dentist');
    assert.equal(hits.length, 5, 'the output shape stays five sessions');
    assert.equal(new Set(hits).size, 5, `one slot per call, never the same call twice: ${hits.join(',')}`);
    assert.ok(hits.includes('call-09'), `the call about the appointment is in the top five: ${hits.join(',')}`);
  } finally { f.cleanup(); }
});

test('a call reached by its turns keeps its place at the top', () => {
  const f = open();
  try {
    seedPool(f.store);
    seedTurn(f.store, 'call-03', 'The rear brake pads are gone and the shop had none.', NOW + 12 * DAY);
    f.store.transaction(tx => { backfillHistoryTurns(tx); });
    const hits = read(f.store, 'where did the brake pads go');
    assert.equal(hits[0], 'call-03', `the verbatim turn hit still leads: ${hits.join(',')}`);
  } finally { f.cleanup(); }
});

test('a pool with no matching term still answers with the newest five calls in order', () => {
  const f = open();
  try {
    seedPool(f.store);
    const hits = read(f.store, 'what did we talk about');
    assert.equal(hits.length, 5);
    // The five calls that carry turns are the newest by their own turn time, and keep that order.
    assert.deepEqual(hits, ['call-05', 'call-04', 'call-03', 'call-02', 'call-01'], 'no term to rank on keeps recency order');
  } finally { f.cleanup(); }
});

test('every hit carries the excerpt of the call it names, even when one call arrives twice', () => {
  const f = open();
  try {
    for (let index = 1; index <= 6; index += 1) {
      const id = `call-0${index}`, at = NOW + index * DAY;
      seedSession(f.store, id, at);
      seedSummary(f.store, id, `Call ${index} covered the weather and the walk.`, at);
      seedTurn(f.store, id, `I asked about the dentist again, call ${index}, and nothing moved.`, at);
    }
    // call-04's own summary says the word three times, so it outranks that call's turn hit and both views
    // reach the top five. One call takes one slot, and the slot keeps the text of the call it names.
    f.store.transaction(tx => tx.run('UPDATE conversation_summaries SET summary=? WHERE live_session_id=?',
      ['Call 4: dentist on Thursday; the dentist said so; the dentist again.', 'call-04']));
    f.store.transaction(tx => { backfillHistoryTurns(tx); });

    const hits = readHits(f.store, 'when is the dentist');
    assert.equal(hits.length, 5, 'the output shape stays five sessions');
    assert.equal(new Set(hits.map(hit => hit['sessionId'])).size, 5, 'one slot per call');
    for (const hit of hits) {
      const session = String(hit['sessionId']), snippet = String(hit['snippet']);
      const index = Number(session.slice('call-'.length));
      const own = hit['sourceKind'] === 'summary' ? `Call ${index}` : `call ${index}`;
      assert.ok(snippet.includes(own), `hit ${session} (${String(hit['sourceKind'])}) carries its own excerpt: ${snippet}`);
    }
  } finally { f.cleanup(); }
});

test('calls that tie on score and on date are cut by the call, never by the summary insert', () => {
  const f = open();
  try {
    // Five calls share one ended_at, so the five-session cut falls inside that tie. Their summary ids run
    // opposite to their call ids: a pool ordered by the summary id keeps call-05 and drops call-01, and the
    // summary id is generated at insert time, so the answer would depend on an insert and not on the calls.
    const tied = ['call-01', 'call-02', 'call-03', 'call-04', 'call-05'];
    for (const [index, id] of tied.entries()) {
      seedSession(f.store, id, NOW + index * DAY);
      seedSummary(f.store, id, `Call ${index + 1} covered the weather and the walk.`, NOW + 3 * DAY);
      seedTurn(f.store, id, 'Mm hm, right.', NOW + index * DAY);
      f.store.transaction(tx => tx.run('UPDATE conversation_summaries SET id=? WHERE live_session_id=?',
        [`zz-${tied.length - index}`, id]));
    }
    seedSession(f.store, 'call-09', NOW + 4 * DAY);
    seedSummary(f.store, 'call-09', 'Call 9 covered the weather and the walk.', NOW + 4 * DAY);
    seedSession(f.store, 'call-08', NOW);
    seedSummary(f.store, 'call-08', 'Call 8 covered the weather and the walk.', NOW + 1 * DAY);
    f.store.transaction(tx => { backfillHistoryTurns(tx); });

    const hits = read(f.store, 'the weather');
    assert.deepEqual(hits, ['call-09', 'call-01', 'call-02', 'call-03', 'call-04'],
      `the oldest of the tied calls keeps its slot: ${hits.join(',')}`);
    assert.deepEqual(read(f.store, 'the weather'), hits, 'the same store answers the same question the same way');
  } finally { f.cleanup(); }
});
