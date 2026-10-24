import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeStopSpeech, stopPhrase } from '../live/stop-phrase.js';

// #589: the deterministic stop gate. The owner's own finalized sentence, her name at an edge, ends the
// call. Nothing here carries the phrase to the model, so these are the whole rule.

const ACCEPTED: [string, string][] = [
  ['Naya, stop listening.', 'stop listening'],
  ['Naya shut down!', 'shut down'],
  ['stop listening Naya', 'stop listening'],
  ['Naya aus', 'aus'],
  ['Naya, hör auf zuzuhören', 'hor auf zuzuhoren'],
  ['goodbye Naya', 'goodbye'],
  ['NAYA. HANG UP.', 'hang up'],
  ['Naya,  shut   down', 'shut down'],
  ['Naya, schalt dich aus.', 'schalt dich aus'],
  ['Naya, good night.', 'good night'],
  ['end the call Naya', 'end the call'],
];

test('the stop phrase table ends the call on the owner saying it, however the recognizer spells it', () => {
  for (const [spoken, expected] of ACCEPTED) {
    assert.equal(stopPhrase(spoken), expected, `"${spoken}" is the ${expected} end phrase`);
  }
});

test('a bare command, a mid-sentence name or a question about the phrase never ends the call', () => {
  const rejected = [
    'stop listening',
    'shut down',
    'aus Naya',
    'Naya be quiet',
    'Naya quiet',
    'Naya pause',
    'what happens if I say Naya shut down',
    'how do I tell Naya to shut down',
    'wenn ich Naya aus sage',
    'and then Naya said shut down the server for me please now',
    'Naya shut down the server for me please now and then tell me what happened next',
    'Naya',
    '',
    '   ',
  ];
  for (const spoken of rejected) assert.equal(stopPhrase(spoken), null, `"${spoken}" does not end the call`);
});

test('normalization folds unicode, lowercases and drops the punctuation the recognizer adds', () => {
  assert.equal(normalizeStopSpeech('  Naya,  STOP   listening! '), 'naya stop listening');
  assert.equal(normalizeStopSpeech('Hör auf zuzuhören'), 'hor auf zuzuhoren');
  assert.equal(normalizeStopSpeech('tschüss'), 'tschuss');
  assert.equal(normalizeStopSpeech('…'), '');
});

test('a German phrase is only how it is said, after the name, never before it', () => {
  assert.equal(stopPhrase('Naya aus'), 'aus');
  assert.equal(stopPhrase('aus Naya'), null);
  assert.equal(stopPhrase('Naya tschüss'), 'tschuss');
  assert.equal(stopPhrase('tschüss Naya'), null);
});
