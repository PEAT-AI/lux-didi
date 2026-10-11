import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStateLabel, liveVoiceState, liveToolName, liveDelay, mergeLive, liveTranscript, liveResult, liveMarkup } from '../src/live-view.ts';
import type { LiveCurrent } from '../src/protocol.ts';

const speaking: LiveCurrent = {
  state: 'speaking',
  since: '2026-10-11T16:00:00Z',
  cursor: 3,
  entries: [
    { seq: 1, kind: 'inputTranscription', text: 'hello' },
    { seq: 2, kind: 'outputTranscription', text: 'Hi there' },
    { seq: 3, kind: 'toolResult', tool: { name: 'search', status: 'completed', markdown: '**Answer** see [source](https://example.org)', sources: [{ title: 'lux 123', url: 'https://example.org' }] } },
  ],
};

test('maps each projection state to a truthful label', () => {
  assert.equal(liveStateLabel('idle'), 'Ready when you are');
  assert.equal(liveStateLabel('listening'), 'Listening');
  assert.equal(liveStateLabel('thinking'), 'Thinking');
  assert.equal(liveStateLabel('speaking'), 'Speaking');
  assert.equal(liveStateLabel('ended'), 'Session ended');
  assert.equal(liveStateLabel('error'), 'Something went wrong');
});

test('the label vocabulary never says recording', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'ended', 'error'] as const) {
    assert.equal(/record/i.test(liveStateLabel(state)), false);
  }
  assert.equal(/record/i.test(liveMarkup({ state: 'listening', cursor: 0, entries: [] })), false);
});

test('the thinking label names the tool in flight', () => {
  const thinking: LiveCurrent = { state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'search', status: 'called' } }] };
  assert.equal(liveToolName(thinking), 'search');
  assert.match(liveMarkup(thinking), /Thinking \(search\)/);
  assert.match(liveMarkup({ state: 'thinking', cursor: 0, entries: [] }), /Thinking<\/p>/);
});

test('a muted indicator appears only when the projection reports it', () => {
  assert.match(liveMarkup({ state: 'listening', muted: true, cursor: 0, entries: [] }), /Microphone muted/);
  assert.equal(/Microphone muted/.test(liveMarkup({ state: 'listening', cursor: 0, entries: [] })), false);
});

test('maps live state to the orb VoiceState', () => {
  assert.equal(liveVoiceState('idle'), 'CONNECTED');
  assert.equal(liveVoiceState('listening'), 'LISTENING');
  assert.equal(liveVoiceState('thinking'), 'PROCESSING');
  assert.equal(liveVoiceState('speaking'), 'SPEAKING');
  assert.equal(liveVoiceState('ended'), 'DISCONNECTED');
  assert.equal(liveVoiceState('error'), 'ERROR');
});

test('poll interval is 1 s when active and 4 s when idle, paused when hidden', () => {
  assert.equal(liveDelay('idle', false), 4000);
  assert.equal(liveDelay(undefined, false), 4000);
  assert.equal(liveDelay('speaking', false), 1000);
  assert.equal(liveDelay('listening', false), 1000);
  assert.equal(liveDelay('speaking', true), undefined);
});

test('merge appends new entries by seq and keeps the latest cursor', () => {
  const first: LiveCurrent = { state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'inputTranscription', text: 'a' }] };
  const next: LiveCurrent = { state: 'speaking', cursor: 2, entries: [{ seq: 2, kind: 'outputTranscription', text: 'b' }] };
  const merged = mergeLive(first, next);
  assert.equal(merged.entries.length, 2);
  assert.equal(merged.cursor, 2);
  assert.equal(merged.state, 'speaking');
});

test('merge replaces an entry with the same seq', () => {
  const prev: LiveCurrent = { state: 'idle', cursor: 5, entries: [{ seq: 1, kind: 'inputTranscription', text: 'old' }] };
  const next: LiveCurrent = { state: 'idle', cursor: 5, entries: [{ seq: 1, kind: 'inputTranscription', text: 'new' }] };
  const merged = mergeLive(prev, next);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].text, 'new');
});

test('transcript labels user and Naya lines', () => {
  assert.deepEqual(liveTranscript(speaking), [{ role: 'user', text: 'hello' }, { role: 'naya', text: 'Hi there' }]);
});

test('result picks the newest accepted toolResult markdown and sources', () => {
  const result = liveResult(speaking);
  assert.equal(result?.markdown, '**Answer** see [source](https://example.org)');
  assert.equal(result?.sources[0].title, 'lux 123');
});

test('result ignores a tool result that errored', () => {
  const errored: LiveCurrent = { state: 'thinking', entries: [{ seq: 1, kind: 'toolResult', tool: { name: 'x', status: 'error', markdown: '**nope**' } }], cursor: 1 };
  assert.equal(liveResult(errored), undefined);
});

test('markup renders the state label in a live region and the answer as markdown with a source anchor', () => {
  const html = liveMarkup(speaking);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, />Speaking</);
  assert.match(html, /<strong>Answer<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.org" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /lux 123/);
});

test('markup never claims heard or done and reports an error honestly', () => {
  const html = liveMarkup({ state: 'error', cursor: 0, entries: [] });
  assert.match(html, /Something went wrong/);
  assert.equal(/heard/i.test(html), false);
});
