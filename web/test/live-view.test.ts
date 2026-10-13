import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStateLabel, liveVoiceState, liveToolName, liveLabel, liveDelay, mergeLive, liveTranscript, liveResult, liveMarkup } from '../src/live-view.ts';
import './connector-status.test.ts';
import { pollLiveView } from '../src/live-view.ts';
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

test('liveLabel is the one label main.ts and the panel share', () => {
  assert.equal(liveLabel(undefined), 'Ready when you are');
  assert.equal(liveLabel({ state: 'listening', cursor: 0, entries: [] }), 'Listening');
  assert.equal(liveLabel({ state: 'speaking', cursor: 0, entries: [] }), 'Speaking');
  assert.equal(liveLabel({ state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'search', status: 'called' } }] }), 'Thinking (search)');
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
  assert.equal(liveVoiceState('rebuilding'), 'RECONNECTING');
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


test('background job results remain in the page without starting audio, including failures', () => {
  const current = { state: 'ended', entries: [], cursor: 0, jobs: [
    { id: 'job1', originSessionId: 'old', state: 'completed', createdAt: 1, markdown: '**Actual answer**', delivered: false },
    { id: 'job2', originSessionId: 'old', state: 'failed', createdAt: 2, markdown: '<script>bad()</script>Actual failure', delivered: false },
  ] } as LiveCurrent;
  const markup = liveMarkup(current);
  assert.match(markup, /Actual answer/);
  assert.match(markup, /Actual failure/);
  assert.match(markup, /Call Naya back/);
  assert.doesNotMatch(markup, /<script>|<audio|autoplay/);
  assert.match(liveMarkup({ ...current, jobs: [] } as LiveCurrent), /No live transcription yet/);
});


test('new session replaces prior entries while same session pages accumulate', () => {
  const next = { ...speaking, since: '2026-10-12T16:00:00Z', cursor: 4, entries: [{ seq: 4, kind: 'inputTranscription' as const, text: 'new conversation' }] };
  assert.deepEqual(mergeLive(speaking, next).entries, next.entries);
  assert.equal(mergeLive(speaking, { ...next, since: speaking.since }).entries.length, 4);
});

test('every tool result is inspectable and errors never show markdown', () => {
  const live: LiveCurrent = { ...speaking, entries: [...speaking.entries,
    { seq: 4, kind: 'toolResult', tool: { name: 'second', status: 'completed', markdown: 'Second answer', sources: [{ title: 'second source' }] } },
    { seq: 5, kind: 'toolResult', tool: { name: 'failed', status: 'error', markdown: 'DO NOT DISPLAY' } },
  ] };
  const html = liveMarkup(live);
  assert.equal((html.match(/<details/g) ?? []).length, 3);
  assert.match(html, /Answer/); assert.match(html, /second source/); assert.match(html, /failed.*error/s);
  assert.doesNotMatch(html, /DO NOT DISPLAY/);
});

test('rejected live poll preserves transcript, shows last success, recovery clears and 404 empties', async () => {
  const success = await pollLiveView({}, async () => speaking, () => new Date('2026-10-12T14:52:00Z'));
  const stale = await pollLiveView(success, async () => { throw new Error('private error'); });
  assert.equal(stale.live, success.live);
  assert.equal(stale.stale, true);
  assert.match(liveMarkup(stale.live, stale), /Live view stale since/);
  assert.match(liveMarkup(stale.live, stale), /hello/);
  assert.doesNotMatch(liveMarkup(stale.live, stale), /private error/);
  const recovered = await pollLiveView(stale, async () => speaking);
  assert.equal(recovered.stale, false);
  assert.doesNotMatch(liveMarkup(recovered.live, recovered), /Live view stale/);
  const empty = await pollLiveView(stale, async () => { throw Object.assign(new Error('missing'), { status: 404 }); });
  assert.equal(empty.live, undefined); assert.equal(empty.stale, false);
});

test('rebuilding is a non-error voice status and restoration is not transcript text', () => {
  const live = { state: 'rebuilding', cursor: 1, entries: [{ seq: 1, kind: 'continuity', event: 'rebuilding', reason: 'go_away' }] } as unknown as LiveCurrent;
  assert.equal(liveStateLabel(live.state), 'Reconnecting to the voice service');
  assert.notEqual(liveVoiceState(live.state), 'ERROR');
  assert.match(liveMarkup(live), /Reconnecting to the voice service/);
  assert.doesNotMatch(liveMarkup(live), /session has stopped/);
  assert.deepEqual(liveTranscript(live), []);
});

for (const [outcome, phrase] of [['failed', 'ended with an error'], ['closed', 'ended'], ['unknown', 'has an unknown end']] as const) {
  test(`past Live ${outcome} is not a current failure`, () => {
    const time = Date.UTC(2026, 9, 12, 21, 52);
    const live = { state: 'ended' as const, cursor: 0, entries: [], pastSession: { outcome, endedAt: outcome === 'unknown' ? null : time, lastObservedAt: time } };
    const label = liveLabel(live);
    assert.match(label, new RegExp(`Last Live session ${phrase}`));
    const displayTime = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.ok(label.includes(displayTime));
    assert.doesNotMatch(liveMarkup(live), /Something went wrong/);
    assert.ok(liveMarkup(live).includes(label));
    assert.match(liveMarkup(live), /id="live-panel"/);
  });
}
test('active Live error remains a current error', () => {
  assert.equal(liveLabel({ state: 'error', cursor: 0, entries: [] }), 'Something went wrong');
});

test('a remembered note renders one evidence card with the saved words', () => {
  const live: LiveCurrent = { ...speaking, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'Naya, remember that the spare key is under the third pot' },
    { seq: 2, kind: 'toolCall', tool: { name: 'remember_note', status: 'called' } },
    { seq: 3, kind: 'toolResult', tool: { name: 'remember_note', status: 'completed', markdown: 'the spare key is under the third pot' } },
  ] };
  const html = liveMarkup(live);
  assert.equal((html.match(/class="live-remember"/g) ?? []).length, 1);
  assert.match(html, /Remembered/);
  assert.match(html, /the spare key is under the third pot/);
  assert.equal((html.match(/<details/g) ?? []).length, 0);
});

test('every declined remember code renders one honest reason line', () => {
  for (const code of ['already_remembered', 'private_memory_unsupported', 'owner_transcript_not_final', 'owner_text_mismatch']) {
    const live: LiveCurrent = { ...speaking, entries: [
      { seq: 1, kind: 'toolResult', tool: { name: 'remember_note', status: 'completed', markdown: code } },
    ] };
    const html = liveMarkup(live);
    assert.equal((html.match(/class="live-remember declined"/g) ?? []).length, 1, code);
    assert.doesNotMatch(html, /Remembered/, code);
    assert.match(html, /not saved|did not save|already had|not final|did not match/i, code);
  }
  const errored: LiveCurrent = { ...speaking, entries: [
    { seq: 1, kind: 'toolResult', tool: { name: 'remember_note', status: 'error', markdown: '' } },
  ] };
  assert.match(liveMarkup(errored), /not saved|did not save/i);
});

test('the observed projection shape neither confirms nor denies the saved note', () => {
  // The service projects a completed remember_note with markdown 'handler_outcome' for a saved OR
  // declined note (server/tools/declarations.ts:78, server/live/index.ts:655), so the card must not
  // claim either outcome from it.
  for (const markdown of ['handler_outcome', 'some_future_code']) {
    const live: LiveCurrent = { ...speaking, entries: [
      { seq: 1, kind: 'toolResult', tool: { name: 'remember_note', status: 'completed', markdown } },
    ] };
    const html = liveMarkup(live);
    assert.equal((html.match(/class="live-remember"/g) ?? []).length, 1, markdown);
    assert.equal((html.match(/class="live-remember declined"/g) ?? []).length, 0, markdown);
    assert.doesNotMatch(html, /Remembered/, markdown);
    assert.match(html, /did not report whether the note was saved/i, markdown);
  }
});

test('other tool results still render as inspectable detail cards', () => {
  const live: LiveCurrent = { ...speaking, entries: [
    { seq: 1, kind: 'toolResult', tool: { name: 'search', status: 'completed', markdown: 'answer' } },
    { seq: 2, kind: 'toolResult', tool: { name: 'remember_note', status: 'completed', markdown: 'a saved note' } },
  ] };
  const html = liveMarkup(live);
  assert.equal((html.match(/class="live-tool-result"/g) ?? []).length, 1);
  assert.equal((html.match(/class="live-remember"/g) ?? []).length, 1);
});

test('remembered note text is escaped and never rendered as raw markup', () => {
  const live: LiveCurrent = { ...speaking, entries: [
    { seq: 1, kind: 'toolResult', tool: { name: 'remember_note', status: 'completed', markdown: '<img src=x onerror=alert(1)>' } },
  ] };
  const html = liveMarkup(live);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
