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
import * as memory from '../domain/memory.js';
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
  return openSession(dir(t), rows);
}

/** A store on its own directory, so a test can close it and open it again. */
function dir(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'live-memory-note-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function openSession(path: string, rows: readonly Row[]): Store {
  const f = openMemoryFixture(path, model, {}, [...chatMigrations, ...liveMigrations]);
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

/** A refusal carries the guidance she must say; the code and shape are asserted exactly, so it is stripped here. */
function refusal(result: Record<string, unknown>): Record<string, unknown> {
  const { guidance, ...rest } = result;
  assert.equal(typeof guidance, 'string', 'every refusal carries guidance she must say');
  return rest;
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
  assert.match(String(stored.externalId), new RegExp(`^${SESSION}:\\d+:[0-9a-f]{8}$`), 'the supporting owner turn journal seq and a note discriminator are the provenance');
});

test('a note whose content only appears in the model output transcript is refused', async t => {
  const store = liveSession(t, [
    { text: 'what is worth remembering here', finished: true },
    { kind: 'outputTranscription', text: 'Rob prefers short answers in the morning', finished: true },
  ]);
  assert.deepEqual(refusal(await remember(store, 'Rob prefers short answers in the morning')), { remembered: false, code: 'owner_text_mismatch' });
});

test('a note copied from a tool result is refused', async t => {
  const store = liveSession(t, [{ text: 'what does the mint entry say', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'Mongoose mint is due Friday and shipped to Lisbon')), { remembered: false, code: 'owner_text_mismatch' });
});

test('a support ratio below 60 percent is refused, and exactly 60 percent is accepted', async t => {
  const store = liveSession(t, [{ text: 'the plumber comes on tuesday morning with a ladder', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'plumber tuesday drill attachment hammer wrench')), { remembered: false, code: 'owner_text_mismatch' },
    'two of five content words is 40 percent');
  assert.equal((await remember(store, 'plumber tuesday morning ladder drill')).remembered, true, 'three of five content words is 60 percent');
});

test('an owner turn older than the ten minute window is refused', async t => {
  const store = liveSession(t, deltas(LONG_TURN, NOW - 11 * MINUTE));
  assert.deepEqual(refusal(await remember(store, 'Rob prefers short answers in the morning')), { remembered: false, code: 'owner_text_mismatch' });
});

test('the same supporting owner turn is remembered once', async t => {
  const store = liveSession(t, deltas(LONG_TURN));
  const first = await remember(store, 'Rob prefers short answers in the morning');
  assert.equal(first.remembered, true);
  assert.deepEqual(refusal(await remember(store, 'Rob prefers short answers in the morning')), { remembered: false, code: 'already_remembered', entryId: first.entryId });
});

const SHARED_TURN = 'rob prefers short answers in the morning and takes the early train to the office on tuesdays';

test('two distinct notes supported by the same owner turns are both stored', async t => {
  const store = liveSession(t, [{ text: SHARED_TURN, finished: true }]);
  const first = await remember(store, 'Rob prefers short answers in the morning');
  const second = await remember(store, 'Rob takes the early train to the office on tuesdays');
  assert.equal(first.remembered, true);
  assert.equal(second.remembered, true, 'a second distinct note over the same owner turns is kept, not refused');
  assert.notEqual(second.entryId, first.entryId);
  assert.notEqual(entry(store, first.entryId).externalId, entry(store, second.entryId).externalId,
    'each note carries its own source identity');
});

test('forgetting one of two notes from the same turns leaves the other, and it stays gone after a reopen', async t => {
  const path = dir(t);
  let store = openSession(path, [{ text: SHARED_TURN, finished: true }]);
  const first = await remember(store, 'Rob prefers short answers in the morning');
  const second = await remember(store, 'Rob takes the early train to the office on tuesdays');
  assert.equal(first.remembered, true);
  assert.equal(second.remembered, true);
  store.transaction(tx => memory.deleteEntry(tx, String(first.entryId), new Date(NOW).toISOString(), 'principal-a'));
  const tombstones = store.transaction(tx => tx.all("SELECT source_key AS key FROM entry_tombstones WHERE source_kind='live-voice'"));
  assert.equal(tombstones.length, 1, 'only the forgotten note is tombstoned');
  assert.notEqual(String(tombstones[0]?.key), String(entry(store, second.entryId).externalId));
  store.close();
  store = openSession(path, []);
  t.after(() => store.close());
  assert.ok(store.transaction(tx => tx.get('SELECT 1 AS one FROM entries WHERE id=?', [String(second.entryId)])),
    'the other note survives the reopen');
  assert.deepEqual(refusal(await remember(store, 'Rob prefers short answers in the morning')),
    { remembered: false, code: 'already_remembered', entryId: first.entryId }, 'the forgotten note stays forgotten');
});

test('a note the owner marked private stays refused', async t => {
  const store = liveSession(t, [{ text: 'remember this as private: the mint is Friday', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'the mint is Friday')), { remembered: false, code: 'private_memory_unsupported' });
});

test('a third-person paraphrase of one owner sentence is stored', async t => {
  // The owner never says their own name: "Rob" and "prefers" are framing the note adds, not content.
  const store = liveSession(t, [{ text: 'i take tea first thing, tea and the crossword', finished: true }]);
  const result = await remember(store, 'Rob prefers tea and the crossword');
  assert.equal(result.remembered, true, 'the note\'s content words are the owner\'s own');
});

test('an ask split across two consecutive owner turns is stored', async t => {
  // Neither turn reaches 60 percent alone: two of five words is 40 percent in each, four in the union.
  const store = liveSession(t, [
    { text: 'remember the plumber comes on tuesday', finished: true },
    { text: 'and there is a ladder and a wrench ready', finished: true },
  ]);
  const result = await remember(store, 'the plumber brings a ladder and a wrench on tuesday');
  assert.equal(result.remembered, true, 'the union of the window\'s turns supports the note');
});

test('a note combining words from no owner turn is still refused', async t => {
  const store = liveSession(t, [
    { text: 'remember the plumber comes on tuesday', finished: true },
    { text: 'and there is a ladder and a wrench ready', finished: true },
  ]);
  assert.deepEqual(refusal(await remember(store, 'the dentist needs a passport in lisbon')), { remembered: false, code: 'owner_text_mismatch' });
});

test('a note that negates what the owner affirmed is refused', async t => {
  // Every content word is spoken, but the claim is the opposite one: the ratio cannot see polarity.
  const store = liveSession(t, [{ text: 'i want the tuesday plumber to come with a ladder', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'Rob does not want the tuesday plumber to come with a ladder')),
    { remembered: false, code: 'owner_text_mismatch' });
});

test('a note stitched from two non-adjacent turns is refused', async t => {
  // One ask spans adjacent turns, never a turn and another one three turns later.
  const store = liveSession(t, [
    { text: 'remember the plumber comes on tuesday', finished: true },
    { text: 'i will be out of the house most of the day', finished: true },
    { text: 'the bins go out on thursday evening', finished: true },
    { text: 'and there is a ladder and a wrench ready', finished: true },
  ]);
  assert.deepEqual(refusal(await remember(store, 'the plumber brings a ladder and a wrench on tuesday')),
    { remembered: false, code: 'owner_text_mismatch' }, 'those words are two asks apart');
});

test('a note that turns the owner\'s love into hate is refused', async t => {
  // The polarity verb is the word the note must be supported by, so it cannot be framing.
  const store = liveSession(t, [{ text: 'i love brussels sprouts with butter', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'Rob hates brussels sprouts')), { remembered: false, code: 'owner_text_mismatch' });
});

test('a contracted negation in the owner\'s ask is read as negation', async t => {
  // "don't" tokenizes to don and t; a negation the reader cannot see is a flip it cannot refuse.
  const store = liveSession(t, [{ text: "i don't want the tuesday plumber to come with a ladder", finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'Rob wants the tuesday plumber to come with a ladder')),
    { remembered: false, code: 'owner_text_mismatch' });
});

test('a note keeping the owner\'s own preference verb still stores', async t => {
  // The positive control: retaining the verb must not make an honest paraphrase fail.
  const store = liveSession(t, [{ text: 'i prefer short answers in the morning', finished: true }]);
  assert.equal((await remember(store, 'Rob prefers short answers in the morning')).remembered, true);
});

test('a short ordinary note stores against the preference the owner stated', async t => {
  // The owner's defect: a two-word-ish note was refused because "prefers" is not "prefer". The
  // polarity verb decides direction, not support, so it must not dilute the ratio either.
  const store = liveSession(t, [{ text: 'i prefer tea first thing', finished: true }]);
  assert.equal((await remember(store, 'Rob prefers tea')).remembered, true);
});

test('the same short note stores when the owner stated it without a preference verb', async t => {
  // The reviewer's second acceptance payload: "just tea for me first thing" says nothing about
  // preference, so the note's verb must not be refused for want of a matching one.
  const store = liveSession(t, [{ text: 'just tea for me first thing', finished: true }]);
  assert.equal((await remember(store, 'Rob prefers tea')).remembered, true);
});

test('that same short note is still refused when it flips the preference', async t => {
  // The paired guard: with the verb out of the ratio the support is 1 of 1, so only polarity refuses.
  const store = liveSession(t, [{ text: 'i prefer tea first thing', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'Rob hates tea')), { remembered: false, code: 'owner_text_mismatch' });
});

test('a session with no owner transcription reports the transcript was never final', async t => {
  const store = liveSession(t, [{ kind: 'outputTranscription', text: 'Naya said something about tea', finished: true }]);
  assert.deepEqual(refusal(await remember(store, 'Rob prefers tea and the crossword')), { remembered: false, code: 'owner_transcript_not_final' });
});

test('the memory_note receipt is a closed shape of counts and no text', async () => {
  const receipt = { event: 'memory_note', remembered: false, code: 'owner_text_mismatch', words: 4, supported: 1, supportRatio: 0.25, turns: 2 };
  assert.deepEqual(safeEvent(receipt), receipt, 'the refusal is debuggable from counts alone');
  assert.equal(safeEvent({ ...receipt, text: 'mint is Friday' }), undefined, 'no note text');
  assert.equal(safeEvent({ ...receipt, supportRatio: 2 }), undefined, 'a ratio is a share');
  assert.equal(safeEvent({ event: 'memory_note', remembered: false, code: 'owner_text_mismatch', words: 4, supportRatio: 0.25 }), undefined,
    'the window turn count is part of the receipt');
});

test('a mismatch says the note was not saved and asks for one sentence', async t => {
  const store = liveSession(t, [{ text: 'i take tea with milk', finished: true }]);
  const result = await remember(store, 'the dentist needs a passport in lisbon');
  assert.equal(result.remembered, false);
  assert.equal(result.code, 'owner_text_mismatch');
  assert.match(String(result.guidance), /not saved/i);
  assert.match(String(result.guidance), /one sentence/i);
});

test('a note keeping under a fifth of a long request returns partial and says what was saved', async t => {
  const request = 'remember that i want the blue folder carried to the upstairs office before the plumber comes on tuesday '
    + 'and that the spare key stays in the kitchen drawer by the back door so nobody has to wait outside in the rain again '
    + 'because the last time the bell was broken and nobody heard it from the garden';
  const store = liveSession(t, [{ text: request, finished: true }]);
  const result = await remember(store, 'blue folder');
  assert.equal(result.remembered, true);
  assert.equal(result.status, 'partial', 'two words of a long request is a fragment');
  assert.match(String(result.guidance), /blue folder/);
  assert.match(String(result.guidance), /one sentence/i);
});
