// FR1: the host reads his finished words for a cue that the past or the calendar is being asked about.
// A cue only decides whether the host spends its 100 ms local read; it never decides what she says, so the
// classifier must be deterministic, word-boundary exact and honest about an uncued turn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALENDAR_CUES, MEMORY_CUES, classifyCue } from '../live/memory-cues.js';

/** Ten cued finals across both classes and ten uncued ones, each with the exact expected classes. */
const CASES: [string, string[]][] = [
  ['What did I tell you about my trip to Lisbon?', ['memory']],
  ['The last time we talked about the roof, you said it was fine.', ['memory']],
  ['Do you remember my flight?', ['memory']],
  ['What did we discuss yesterday?', ['memory']],
  ['We talked about the plan in March.', ['memory']],
  ['What is on my calendar today?', ['calendar']],
  ['Do I have a meeting tomorrow?', ['calendar']],
  ['What does my schedule look like this week?', ['calendar']],
  ['Is there an appointment next week?', ['calendar']],
  ['Check my calendar for the appointment.', ['calendar']],
  ['Open the garage door.', []],
  ['Play some jazz.', []],
  ['How much is two plus two?', []],
  ['Tell me a joke.', []],
  ['Set a timer for ten minutes.', []],
  ['What is the weather outside?', []],
  ['Turn the lights off.', []],
  ['Read that email to me.', []],
  ['Are you there?', []],
  ['Call me back later.', []],
];

test('FR1: twenty finals classify to the exact cue classes, and the uncued ten stay untouched', () => {
  for (const [text, expected] of CASES) {
    assert.deepEqual(classifyCue(text), expected, text);
  }
});

test('FR1: a cue matches a whole word only, so a longer word carrying it is not a cue', () => {
  for (const text of ['Remembering is hard.', 'The scheduling tool is down.', 'Yesterdayish answers are rare.']) {
    assert.deepEqual(classifyCue(text), [], text);
  }
  assert.deepEqual(classifyCue('The meetings run long.'), [], 'meeting is a whole word, meetings is not');
});

test('FR1: both classes are possible in one final, in a fixed order', () => {
  assert.deepEqual(classifyCue('What did we talk about yesterday, and what is on my calendar today?'), ['memory', 'calendar']);
});

test('FR1: the exported cue lists are unique, lowercase and regex-free so a test can read them', () => {
  for (const list of [MEMORY_CUES, CALENDAR_CUES]) {
    assert.equal(new Set(list).size, list.length, 'no duplicate cue');
    for (const cue of list) {
      assert.equal(cue, cue.toLowerCase(), `${cue} is lowercase`);
      assert.match(cue, /^[a-z ]+$/, `${cue} carries no punctuation and no regex metacharacter`);
    }
  }
  assert.deepEqual(MEMORY_CUES.filter(cue => /^(january|february|march|april|may|june|july|august|september|october|november|december)$/.test(cue)).length, 12);
  assert.deepEqual(MEMORY_CUES.filter(cue => /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(cue)).length, 7);
});
