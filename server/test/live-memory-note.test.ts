// OUTCOME 2/3: a spoken note is remembered when ONE recent owner turn supports it, either as a
// substring (the provider may keep the words) or by 60 percent of the note's content words, which
// is how a paraphrase is supported. The supporting turn is assembled from the session's own input
// transcription over a 10 minute window, so the many small deltas of gpt-live-1 form one turn.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chatMigrations } from '../chat/index.js';
import { liveMigrations, rememberOwnerNote } from '../live/index.js';
import { safeEvent } from '../host/log.js';
import { openMemoryFixture } from './memory-context-process.js';
import type { Store } from '../runtime/store.js';

const NOW = 1_700_000_000_000;
const SESSION = 'live-memory-note';
const MINUTE = 60 * 1000;

/** The suite never calls a model: `rememberOwnerNote` reads the journal, not provider arguments. */
const model = { generate: async (): Promise<never> => { throw new Error('the memory note suite never calls the model'); } };

interface Row { kind?: 'inputTranscription' | 'outputTranscription'; text: string; finished?: boolean; at?: number }

function liveSession(t: TestContext, rows: readonly Row[]): Store {
  const dir = mkdtempSync(join(tmpdir(), 'live-memory-note-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = openMemoryFixture(dir, model, {}, [...chatMigrations, ...liveMigrations]);
  f.store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events,
        journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',1,1,?,0,0,'attached',NULL,NULL,?,?)`,
      [SESSION, f.store.assistantId, f.store.authorityEpoch, 'key-note', 'fp-note', 'client', 'audit', 'profile', 'prompt', rows.length, NOW, NOW]);
    for (const row of rows) {
      tx.run('INSERT INTO live_journal (live_session_id, kind, text, finished, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?)',
        [SESSION, row.kind ?? 'inputTranscription', row.text, row.finished === false ? 0 : 1, row.text.length, row.at ?? NOW]);
    }
  });
  return f.store;
}

function remember(store: Store, text: string, now = NOW) {
  return store.transaction(tx => rememberOwnerNote(tx, SESSION, { text, kind: 'preference' }, now));
}

function entry(store: Store, entryId: unknown) {
  return store.transaction(tx => tx.get('SELECT e.text AS text, s.external_id AS externalId FROM entries e JOIN source_references s ON s.owner_id=e.id WHERE e.id=?', [String(entryId)])!);
}

/** One character per delta, the shape gpt-live-1 streams; the note's words sit in the FIRST delta. */
const deltas = (owner: string, at = NOW): Row[] => [...owner].map(text => ({ text, finished: false, at }));

const LONG_TURN = 'rob prefers short answers in the morning and no meetings before nine because the school run takes the early school slot every weekday';

test('a paraphrased note supported by a long delta-assembled owner turn is remembered', async t => {
  assert.ok(LONG_TURN.length > 100, 'the owner turn arrives as more than 100 deltas');
  const store = liveSession(t, deltas(LONG_TURN));
  const result = await remember(store, 'Rob prefers short answers in the morning');
  assert.equal(result.remembered, true, 'the paraphrase is supported by the owner turn');
  const stored = entry(store, result.entryId);
  assert.equal(stored.text, 'Rob prefers short answers in the morning', 'the model note text is what is stored, not the raw delta soup');
  assert.match(String(stored.externalId), new RegExp(`^${SESSION}:\\d+$`), 'the supporting owner turn journal seq is the provenance');
});

test('a note whose content only appears in the model output transcript is refused', async t => {
  const store = liveSession(t, [
    { text: 'what is worth remembering here', finished: true },
    { kind: 'outputTranscription', text: 'Rob prefers short answers in the morning', finished: true },
  ]);
  assert.deepEqual(await remember(store, 'Rob prefers short answers in the morning'), { remembered: false, code: 'owner_text_mismatch' });
});

test('a note copied from a tool result is refused', async t => {
  const store = liveSession(t, [{ text: 'what does the mint entry say', finished: true }]);
  assert.deepEqual(await remember(store, 'Mongoose mint is due Friday and shipped to Lisbon'), { remembered: false, code: 'owner_text_mismatch' });
});

test('a support ratio below 60 percent is refused, and exactly 60 percent is accepted', async t => {
  const store = liveSession(t, [{ text: 'the plumber comes on tuesday morning with a ladder', finished: true }]);
  assert.deepEqual(await remember(store, 'plumber tuesday drill attachment hammer wrench'), { remembered: false, code: 'owner_text_mismatch' },
    'two of five content words is 40 percent');
  assert.equal((await remember(store, 'plumber tuesday morning ladder drill')).remembered, true, 'three of five content words is 60 percent');
});

test('an owner turn older than the ten minute window is refused', async t => {
  const store = liveSession(t, deltas(LONG_TURN, NOW - 11 * MINUTE));
  assert.deepEqual(await remember(store, 'Rob prefers short answers in the morning'), { remembered: false, code: 'owner_text_mismatch' });
});

test('the same supporting owner turn is remembered once', async t => {
  const store = liveSession(t, deltas(LONG_TURN));
  const first = await remember(store, 'Rob prefers short answers in the morning');
  assert.equal(first.remembered, true);
  assert.deepEqual(await remember(store, 'Rob prefers short answers in the morning'), { remembered: false, code: 'already_remembered', entryId: first.entryId });
});

test('a note the owner marked private stays refused', async t => {
  const store = liveSession(t, [{ text: 'remember this as private: the mint is Friday', finished: true }]);
  assert.deepEqual(await remember(store, 'the mint is Friday'), { remembered: false, code: 'private_memory_unsupported' });
});

test('the memory_note receipt is a closed shape of counts and no text', async () => {
  assert.deepEqual(safeEvent({ event: 'memory_note', remembered: false, code: 'owner_text_mismatch', words: 4, supportRatio: 0.25 }),
    { event: 'memory_note', remembered: false, code: 'owner_text_mismatch', words: 4, supportRatio: 0.25 });
  assert.equal(safeEvent({ event: 'memory_note', remembered: true, code: 'remembered', words: 4, supportRatio: 1, text: 'mint is Friday' }), undefined, 'no note text');
  assert.equal(safeEvent({ event: 'memory_note', remembered: true, code: 'remembered', words: 4, supportRatio: 2 }), undefined, 'a ratio is a share');
});
