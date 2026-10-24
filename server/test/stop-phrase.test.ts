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
  // STOP-R2 O1: he speaks politely, so a filler around the phrase still ends the call.
  ['Naya, please stop listening', 'stop listening'],
  ['Naya stop listening now', 'stop listening'],
  ['Naya kannst du bitte aufhören zuzuhören', 'aufhoren zuzuhoren'],
  ['Naya, can you shut down?', 'shut down'],
  ['could you end the call Naya', 'end the call'],
  ['Naya, okay, thanks, goodbye', 'goodbye'],
];

test('the stop phrase table ends the call on the owner saying it, however the recognizer spells it', () => {
  for (const [spoken, expected] of ACCEPTED) {
    assert.equal(stopPhrase(spoken), expected, `"${spoken}" is the ${expected} end phrase`);
  }
});

test('a bare command, a mid-sentence name or a question about the phrase never ends the call', () => {
  const rejected = [
    'stop listening to podcasts',
    'shut down the server',
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
    // STOP-R2 O1: the question reject outlives the filler allowance.
    'Naya what happens if you stop listening',
    'Naya, please be quiet',
    'Naya thanks',
    'can you stop listening to podcasts',
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

test('#606 the last ten words admit a nearby name and ignore earlier room speech', () => {
  for (const spoken of [
    'Nayas. Okay, Naya, stop listening now',
    `${'room '.repeat(60)}naya stop listening`,
    'Please Naya stop listening', 'Naja stop listening', 'Nayah stop listening',
    'Naia stop listening', 'Nia stop listening', 'Nayla stop listening', 'Nayer stop listening',
    'stop listening please Naya',
  ]) assert.equal(stopPhrase(spoken), 'stop listening', spoken);
  for (const spoken of ['Naya stop', 'Naya, stop', 'stop Naya']) assert.equal(stopPhrase(spoken), 'stop', spoken);
  assert.equal(stopPhrase('Naya stop now'), 'stop now');
  assert.equal(stopPhrase('Naya stop, please'), 'stop please');
  for (const spoken of [
    'Naya, what should I stop listening to?', 'Naya said stop listening',
    'stop listening to podcasts', 'nayas said stop listening', 'Naya please stop',
    'Naya please okay thanks now stop listening to podcasts', 'stop listening please okay Naya',
  ]) assert.equal(stopPhrase(spoken), null, spoken);
});

test('R1 zero of twenty quoted, negated or unrelated phrases are stops', () => {
  const negatives = [
    'what happens if I say Naya stop listening', 'Naya said stop listening',
    'Naya says stop listening', 'Naya do not stop listening', "Naya don't stop",
    'Naya never stop listening', 'Naya what should I stop listening to',
    'Naya why stop listening', 'Naya how do I stop listening',
    'Naya when should I stop listening', 'tell Maya to stop listening to podcasts',
    'Maya said stop listening', 'Nadia said stop listening', 'nayas said stop listening',
    'stop listening to podcasts', 'stop', 'please stop listening to podcasts', 'Naya stop listening to podcasts',
    'Naya please do not shut down', 'Naya if you stop listening',
  ];
  assert.equal(negatives.length, 20);
  assert.deepEqual(negatives.filter(text => stopPhrase(text) !== null), []);
});


test('R3 bare end phrases need no name, but standalone stop still does', () => {
  const accepted: [string, string][] = [
    ['stop listening', 'stop listening'], ['stop listening to me', 'stop listening'],
    ['stop listening to me please', 'stop listening'], ['shut down', 'shut down'],
    ['stop now', 'stop now'], ['Okay, like stop listening. You need to shut down now.', 'shut down'],
    ['aus', 'aus'], ['hör auf zuzuhören', 'hor auf zuzuhoren'],
    ['aufhören zuzuhören bitte', 'aufhoren zuzuhoren'], ['schalt dich aus', 'schalt dich aus'],
    ['tschüss', 'tschuss'], ['Naya stop listening to me', 'stop listening'],
  ];
  for (const [text, expected] of accepted) assert.equal(stopPhrase(text), expected, text);
  for (const text of ['stop', 'please stop', 'stop please', 'what happens if I say stop listening',
    'do not stop listening', "don't shut down", 'tell Maya to stop listening to podcasts',
    'Naya said stop listening', 'why stop listening']) assert.equal(stopPhrase(text), null, text);
});
