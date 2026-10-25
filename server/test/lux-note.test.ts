import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginStage, composedAsk, confirmAsk, CONFIRM_MAX_TOKENS, CONFIRM_WINDOW_MS, freezeNote, NOTE_MAX_CHARS,
  noteOwnerFragment, noteOwnerUtterance, noteReadback, noteSettle, validateStageNote,
} from '../tools/lux-note.js';

const HELD = new Set(['journal:11', 'journal:12']);
const EVIDENCE = ['journal:11', 'journal:12'];

function staged(over: { ownerText?: string; title?: string; body?: string; enabled?: boolean; now?: number } = {}) {
  const outcome = beginStage({
    stageId: 'stage-1', sessionId: 'session-1', now: over.now ?? 1_000,
    ownerText: over.ownerText ?? 'save that to lux', title: over.title ?? 'Trip plan', body: over.body ?? 'Fly to Lisbon on the third.',
    evidence: EVIDENCE, heldEvidence: HELD, enabled: over.enabled ?? true,
  });
  assert.equal(outcome.state, 'staged', `staged: ${JSON.stringify(outcome)}`);
  return outcome.state === 'staged' ? outcome.note : (undefined as never);
}

/** Stage, let the read-back drain, and come back with an armed note. */
function armed(now = 2_000) {
  const note = noteReadback(staged(), now, 'drained');
  assert.equal(note.state, 'armed');
  return note;
}

test('an imperative with an explicit lux destination is the only form that authorizes a composed note', () => {
  for (const text of ['save that to lux', 'remember in lux knowledge that Lisbon is booked', 'put this in my vault', 'add that to the knowledge base']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
});

test('negated, reported, quoted, conditional and ambiguous save asks are refused with a clarification', () => {
  const refusals: [string, string][] = [
    ['do not save that to lux', 'negated'],
    ["don't remember it in lux", 'negated'],
    ['never put that in my vault', 'negated'],
    ['he said save that to lux', 'reported'],
    ['the email says remember this in lux knowledge', 'reported'],
    ['save "that to lux"', 'quoted'],
    ['if you want, save that to lux', 'conditional'],
    ['maybe save that to lux', 'ambiguous'],
    ['save that to lux or to memory', 'ambiguous'],
    ['how do I save something to lux', 'reported'],
  ];
  for (const [text, reason] of refusals) {
    assert.deepEqual(composedAsk(text), { decision: 'clarify', reason }, text);
  }
  assert.deepEqual(composedAsk('what is on my calendar'), { decision: 'none' });
});

test('an append or edit ask is answered as unsupported, never turned into a create', () => {
  for (const text of ['add that to the Simone note in lux', 'update the Lisbon note in lux', 'delete the Lisbon note from my vault', 'link that to the Lisbon note in lux']) {
    assert.deepEqual(composedAsk(text), { decision: 'append' }, text);
  }
});

test('the confirm word is an exact affirmative allowlist under normalisation, at most six tokens, with disqualifiers', () => {
  for (const text of ['yes', 'Yes.', 'yeah do it', 'correct', 'that is right', 'ok save it', 'yes, save it']) {
    assert.equal(confirmAsk(text), 'affirm', text);
  }
  for (const text of ['no', 'not yet', 'yes but change the date', 'yes wait make it fifty', 'cancel', 'no do not', 'yes cancel that', 'yes and please also add a hotel line', 'hold on']) {
    assert.equal(confirmAsk(text), 'cancel', text);
  }
  assert.equal(CONFIRM_MAX_TOKENS, 6);
});

test('the frozen payload never truncates, and an oversized title plus body is refused whole', () => {
  const over = freezeNote({ title: 'Trip', body: 'x'.repeat(NOTE_MAX_CHARS + 1) });
  assert.deepEqual(over, { state: 'refused', code: 'payload_too_long' });
  const empty = freezeNote({ title: 'Trip', body: '' });
  assert.deepEqual(empty, { state: 'refused', code: 'payload_empty' });
  const frozen = freezeNote({ title: 'Trip', body: 'Fly on the third.' });
  assert.equal(frozen.state, 'frozen');
  if (frozen.state !== 'frozen') return;
  assert.deepEqual(JSON.parse(frozen.payload), { content: 'Fly on the third.', insight_title: 'Trip', insight_type: 'UNCATEGORIZED', project: 'didi-voice' });
});

test('a stage needs the switch, the owner grammar and evidence the host holds', () => {
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'save that to lux', title: 'T', body: 'B', evidence: EVIDENCE, heldEvidence: HELD, enabled: false }),
    { state: 'refused', code: 'not_enabled' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'do not save that to lux', title: 'T', body: 'B', evidence: EVIDENCE, heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'authorization_refused' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'what is on my calendar', title: 'T', body: 'B', evidence: EVIDENCE, heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'authorization_missing' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'save that to lux', title: 'T', body: 'B', evidence: ['journal:99'], heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'evidence_unknown' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'save that to lux', title: 'T', body: 'B', evidence: [], heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'evidence_missing' });
});

test('unknown tool arguments are rejected, never coerced', () => {
  assert.equal(validateStageNote({ title: 'T', body: 'B', evidenceRefs: ['journal:1'] }), true);
  assert.equal(validateStageNote({ title: 'T', body: 'B', evidenceRefs: ['journal:1'], commit: true }), false);
  assert.equal(validateStageNote({ title: 'T', body: 'B' }), false);
  assert.equal(validateStageNote({ title: 'T', body: 7, evidenceRefs: [] }), false);
  assert.equal(validateStageNote(null), false);
});

test('the lifecycle is stage, drained, affirmative, settle, commit, and nothing commits before the read-back drained', () => {
  const note = staged();
  assert.equal(noteOwnerUtterance(note, { text: 'yes', now: 1_500 }).state, 'staged');
  const armedNote = armed();
  const settling = noteOwnerUtterance(armedNote, { text: 'yes', now: 3_000 });
  assert.equal(settling.state, 'settling');
  const committed = noteSettle(settling, 4_500);
  assert.equal(committed.state, 'committed');
  assert.equal(noteSettle(committed, 4_000).state, 'committed');
});

test('a VAD split affirmative that keeps talking never commits', () => {
  const settling = noteOwnerUtterance(armed(), { text: 'yes', now: 3_000 });
  assert.equal(settling.state, 'settling');
  const cancelled = noteOwnerFragment(settling, 3_400);
  assert.deepEqual({ state: cancelled.state, code: cancelled.code }, { state: 'cancelled', code: 'late_fragment' });
  assert.equal(noteSettle(cancelled, 5_000).state, 'cancelled');
});

test('an interrupted read-back invalidates the stage, and nothing else can revive it', () => {
  const note = noteReadback(staged(), 2_000, 'interrupted');
  assert.deepEqual({ state: note.state, code: note.code }, { state: 'invalidated', code: 'readback_interrupted' });
  assert.equal(noteOwnerUtterance(note, { text: 'yes', now: 3_000 }).state, 'invalidated');
  assert.equal(noteReadback(note, 4_000, 'drained').state, 'invalidated');
});

test('a confirmation after the thirty second window cancels, and a mismatch cancels with its reason', () => {
  const late = noteOwnerUtterance(armed(), { text: 'yes', now: 2_000 + CONFIRM_WINDOW_MS + 1 });
  assert.deepEqual({ state: late.state, code: late.code }, { state: 'cancelled', code: 'confirm_expired' });
  const mismatch = noteOwnerUtterance(armed(), { text: 'no', now: 3_000 });
  assert.deepEqual({ state: mismatch.state, code: mismatch.code }, { state: 'cancelled', code: 'not_affirmative' });
  assert.equal(noteOwnerUtterance(armed(), { text: 'what time is it', now: 3_000 }).state, 'cancelled');
});

test('a stage that never hears a read-back will not take a confirmation forever', () => {
  const expired = noteOwnerUtterance(staged(), { text: 'yes', now: 1_000 + CONFIRM_WINDOW_MS + 1 });
  assert.deepEqual({ state: expired.state, code: expired.code }, { state: 'cancelled', code: 'not_armed' });
});
