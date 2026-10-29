import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freezeNote, validateStageNote, STAGE_NOTE_PARAMETERS } from '../tools/lux-note.js';

// Confirmation lifecycle tests are replaced because direct owner asks now commit without a yes round.
test('direct102 note payload is frozen whole, with title and body normalized only at the boundary', () => {
  const frozen = freezeNote({ title: ' Synthetic   plan ', body: '  The blue plan costs twelve units.  ' });
  assert.equal(frozen.state, 'frozen');
  if (frozen.state !== 'frozen') return;
  const payload = JSON.parse(frozen.payload);
  assert.equal(payload.content, 'The blue plan costs twelve units.');
  assert.equal(payload.insight_title, 'Synthetic plan');
  assert.equal(payload.insight_type, 'MEETING');
  assert.equal(frozen.payloadSha.length, 64);
  assert.deepEqual(freezeNote({ title: 'Synthetic plan', body: 'The blue plan costs twelve units.' }), frozen);
});

test('direct102 note boundary refuses empty and oversized payloads without truncation', () => {
  assert.equal(freezeNote({ title: '', body: 'body' }).state, 'refused');
  assert.equal(freezeNote({ title: 'title', body: '  ' }).state, 'refused');
  assert.equal(freezeNote({ title: 'x'.repeat(121), body: 'body' }).state, 'refused');
  assert.equal(freezeNote({ title: 'title', body: 'x'.repeat(4001) }).state, 'refused');
  assert.equal(freezeNote({ title: 'title', body: 'x'.repeat(4000) }).state, 'frozen');
});

test('direct102 stage tool accepts only its declared model fields, not authority or confirmation', () => {
  const candidate = { title: 'Synthetic', body: 'The model may compose this body.' };
  assert.equal(validateStageNote(candidate), true);
  for (const extra of [{ confirmed: true }, { requestId: 'invented' }, { ownerWords: 'save this' }, { sources: { mail: 1 } }]) {
    assert.equal(validateStageNote({ ...candidate, ...extra }), false);
  }
  assert.equal(validateStageNote({ title: 'Synthetic', body: 42 }), false);
  assert.equal(validateStageNote({ ...candidate, evidenceRefs: ['bad ref with spaces'] }), false);
  assert.equal(STAGE_NOTE_PARAMETERS.additionalProperties, false);
});
