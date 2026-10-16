import { createSourceFile, ScriptTarget, SyntaxKind } from 'typescript';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { liveStateLabel, liveVoiceState, pendingToolNames, liveLabel, liveDelay, mergeLive, liveTranscript, liveResult, liveMarkup, liveActivity, activityMarkup, jobStateLabel, SLOW_TOOL_MS } from '../src/live-view.ts';
import { posture } from '../src/orb-level.ts';
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

test('voice landing keeps the latest turn readable and secondary activity in a stable disclosure', () => {
  const live: LiveCurrent = { ...speaking, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'What should I do next?' },
    { seq: 2, kind: 'turnComplete' },
    { seq: 3, kind: 'outputTranscription', text: 'Take one small step.' },
    { seq: 4, kind: 'toolResult', tool: { name: 'search', status: 'completed', markdown: 'Source detail' } },
  ] };
  const closed = liveMarkup(live);
  assert.match(closed, /Take one small step\./);
  assert.doesNotMatch(closed, /live-latest-turn|live-result/,'no duplicate answer surface in the lane');
  assert.doesNotMatch(closed, /<details id="live-details"/,'no history disclosure in the lane');
});

test('the thinking label never names a tool; the activity line carries the phrase', () => {
  const thinking: LiveCurrent = { state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'search_knowledge', status: 'called' } }] };
  assert.deepEqual(pendingToolNames(thinking), ['search_knowledge']);
  assert.equal(liveLabel(thinking), 'Thinking');
  assert.doesNotMatch(liveLabel(thinking), /search_knowledge/);
  assert.match(activityMarkup(liveActivity(thinking)), /activity-line/, 'the activity line carries the phrase, the label lives in the stage');
  assert.doesNotMatch(activityMarkup(liveActivity(thinking)), /search_knowledge/, 'the activity line never names a raw tool');
  assert.doesNotMatch(liveMarkup(thinking), /Thinking \(/);
});

test('liveLabel is the one label main.ts and the panel share', () => {
  assert.equal(liveLabel(undefined), 'Ready when you are');
  assert.equal(liveLabel({ state: 'listening', cursor: 0, entries: [] }), 'Listening');
  assert.equal(liveLabel({ state: 'speaking', cursor: 0, entries: [] }), 'Speaking');
  assert.equal(liveLabel({ state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'search', status: 'called' } }] }), 'Thinking');
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

test('poll interval is 250 ms when active and 4 s when idle, paused when hidden', () => {
  assert.equal(liveDelay('idle', false), 4000);
  assert.equal(liveDelay(undefined, false), 4000);
  assert.equal(liveDelay('speaking', false), 250);
  assert.equal(liveDelay('listening', false), 250);
  assert.equal(liveDelay('thinking', false), 250);
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

test('transcript folds exact same-role fragments until a truthful turn boundary', () => {
  const live: LiveCurrent = { state: 'speaking', cursor: 11, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'what is ' },
    { seq: 2, kind: 'inputTranscription', text: 'on your mind?' },
    { seq: 3, kind: 'outputTranscription', text: 'I am ' },
    { seq: 4, kind: 'toolCall', tool: { name: 'search', status: 'called' } },
    { seq: 5, kind: 'outputTranscription', text: 'ready' },
    { seq: 6, kind: 'turnComplete' },
    { seq: 7, kind: 'outputTranscription', text: 'Next' },
    { seq: 8, kind: 'interrupted' },
    { seq: 9, kind: 'outputTranscription', text: 'After' },
    { seq: 10, kind: 'terminal' },
    { seq: 11, kind: 'outputTranscription', text: 'Terminal tail' },
  ] };
  assert.deepEqual(liveTranscript(live), [
    { role: 'user', text: 'what is on your mind?' },
    { role: 'naya', text: 'I am ready' },
    { role: 'naya', text: 'Next' },
    { role: 'naya', text: 'After' },
    { role: 'naya', text: 'Terminal tail' },
  ]);
  const html = liveMarkup(live);
  assert.doesNotMatch(html, /<ol class="entries live-transcript"/);
  assert.equal((html.match(/class="entry assistant"/g) ?? []).length, 4);
});

test('a typed turn interleaved with streamed Naya fragments joins one Naya card in journal order', () => {
  const live: LiveCurrent = { state: 'speaking', cursor: 6, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'What should I focus on today?' },
    { seq: 2, kind: 'turnComplete' },
    { seq: 3, kind: 'outputTranscription', text: 'Hel' },
    { seq: 4, kind: 'inputTranscription', text: 'Tell me more' },
    { seq: 5, kind: 'outputTranscription', text: 'lo there' },
    { seq: 6, kind: 'turnComplete' },
  ] };
  assert.deepEqual(liveTranscript(live), [
    { role: 'user', text: 'What should I focus on today?' },
    { role: 'naya', text: 'Hello there' },
    { role: 'user', text: 'Tell me more' },
  ]);
  const html = liveMarkup(live);
  assert.match(html, /class="entry assistant"[^>]*><div class="markdown"><p>Hello there/);
});

test('transcript preserves exact fragment deltas without spaces or deduplication', () => {
  const live: LiveCurrent = { state: 'speaking', cursor: 7, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Hel' },
    { seq: 2, kind: 'outputTranscription', text: 'lo' },
    { seq: 3, kind: 'turnComplete' },
    { seq: 4, kind: 'outputTranscription', text: 'ha' },
    { seq: 5, kind: 'outputTranscription', text: 'ha' },
    { seq: 6, kind: 'turnComplete' },
    { seq: 7, kind: 'inputTranscription', text: 'ok' },
  ] };
  assert.deepEqual(liveTranscript(live), [
    { role: 'naya', text: 'Hello' },
    { role: 'naya', text: 'haha' },
    { role: 'user', text: 'ok' },
  ]);
});

test('result picks the newest accepted toolResult markdown and sources', () => {
  const result = liveResult(speaking);
  assert.equal(result?.markdown, 'Hi there','the answer is the model output transcript, never a tool body');
  assert.equal(result?.sources[0].title, 'lux 123');
});

test('result ignores a tool result that errored', () => {
  const errored: LiveCurrent = { state: 'thinking', entries: [{ seq: 1, kind: 'toolResult', tool: { name: 'x', status: 'error', markdown: '**nope**' } }], cursor: 1 };
  assert.equal(liveResult(errored), undefined);
});

test('no transcript line carries a speaker label; the owner speaks in the shared bubble', () => {
  const html = liveMarkup({ state: 'speaking', cursor: 3, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'what should I focus on?' },
    { seq: 2, kind: 'outputTranscription', text: '**Start** with the release checklist' },
    { seq: 3, kind: 'turnComplete' },
  ] });
  assert.match(html, /<article class="entry user"[^>]*><p class="bubble">what should I focus on\?<\/p><\/article>/, 'the owner speaks in the shared chat bubble');
  assert.match(html, /<article class="entry assistant"[^>]*><div class="markdown">/, 'Naya answers without a bubble');
  assert.match(html, /<strong>Start<\/strong> with the release checklist/, 'markdown still renders');
  assert.equal((html.match(/>You<|>Naya</g) ?? []).length, 0, 'no speaker labels in either lane');
  assert.equal((html.match(/class="entry user"/g) ?? []).length, 1);
  assert.equal((html.match(/class="entry assistant"/g) ?? []).length, 1);
});

test('markup renders the answer as markdown with a source anchor', () => {
  const html = liveMarkup(speaking);
  assert.match(html, /<strong>Answer<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.org" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /lux 123/);
});

test('markup never claims heard or done and keeps an honest state label', () => {
  const html = liveMarkup({ state: 'error', cursor: 0, entries: [] });
  assert.equal(/heard/i.test(html), false);
  assert.equal(liveLabel({ state: 'error', cursor: 0, entries: [] }), 'Something went wrong');
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
  assert.match(liveMarkup({ ...current, jobs: [] } as LiveCurrent), /transcript-placeholder/, 'an empty transcript shows the one calm placeholder line');
});


test('new session replaces prior entries while same session pages accumulate', () => {
  const next = { ...speaking, since: '2026-10-12T16:00:00Z', cursor: 4, entries: [{ seq: 4, kind: 'inputTranscription' as const, text: 'new conversation' }] };
  assert.deepEqual(mergeLive(speaking, next).entries, next.entries);
  assert.equal(mergeLive(speaking, { ...next, since: speaking.since }).entries.length, 4);
});

test('cursor page replay replaces matching seq and a new session resets it', () => {
  const first: LiveCurrent = { state: 'speaking', since: 'session-a', cursor: 2, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Hel' },
    { seq: 2, kind: 'outputTranscription', text: 'l' },
  ] };
  const replay: LiveCurrent = { state: 'speaking', since: 'session-a', cursor: 3, entries: [
    { seq: 2, kind: 'outputTranscription', text: 'lo' },
    { seq: 3, kind: 'turnComplete' },
  ] };
  const merged = mergeLive(first, replay);
  assert.deepEqual(liveTranscript(merged), [{ role: 'naya', text: 'Hello' }]);
  const reset: LiveCurrent = { state: 'listening', since: 'session-b', cursor: 1, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'new' },
  ] };
  assert.deepEqual(mergeLive(merged, reset).entries, reset.entries);
});

test('every tool result is inspectable and errors never show markdown', () => {
  const live: LiveCurrent = { ...speaking, entries: [...speaking.entries,
    { seq: 4, kind: 'toolResult', tool: { name: 'second', status: 'completed', markdown: 'Second answer', sources: [{ title: 'second source' }] } },
    { seq: 5, kind: 'toolResult', tool: { name: 'failed', status: 'error', markdown: 'DO NOT DISPLAY' } },
  ] };
  const html = liveMarkup(live);
  assert.equal((html.match(/<details class="live-tool-result"/g) ?? []).length, 3);
  assert.match(html, /Answer/); assert.match(html, /second source/); assert.match(html, /Using Failed \(error\)/);
  assert.doesNotMatch(html, /DO NOT DISPLAY/);
});

test('the transcript tool disclosure uses the human phrase', () => {
  const live: LiveCurrent = { ...speaking, entries: [
    { seq: 1, kind: 'toolResult', tool: { name: 'gmail_list', status: 'completed', markdown: 'mail' } },
  ] };
  const html = liveMarkup(live);
  assert.match(html, /Searching your mail/);
  assert.doesNotMatch(html, /gmail_list/);
});

test('liveActivity names the phrases of a pending batch and never the raw id', () => {
  const live: LiveCurrent = { state: 'thinking', cursor: 2, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'gmail_list', status: 'called' } },
    { seq: 2, kind: 'toolCall', tool: { name: 'mattermost_search', status: 'called' } },
  ] };
  assert.deepEqual(liveActivity(live), { kind: 'tools', text: 'Searching your mail and Mattermost' });
});

test('thinking without tools is a subtle Thinking activity', () => {
  const live: LiveCurrent = { state: 'thinking', cursor: 0, entries: [] };
  assert.deepEqual(liveActivity(live), { kind: 'thinking', text: 'Thinking' });
  assert.match(activityMarkup(liveActivity(live)), /activity-thinking[\s\S]*>Thinking</);
  assert.doesNotMatch(activityMarkup(liveActivity(live)), /activity-tools|activity-done/);
});

test('outcomes are one calm sentence: done, failed, and a quiet barged-in done', () => {
  const result = (tool: object): LiveCurrent => ({ state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolResult', tool } as never] });
  const done = liveActivity(result({ name: 'gmail_list', status: 'completed', markdown: 'mail' }))!;
  assert.deepEqual(done, { kind: 'done', text: 'Done' });
  assert.match(activityMarkup(done), /activity-done/);
  const failed = liveActivity(result({ name: 'mattermost_search', status: 'error' }))!;
  assert.deepEqual(failed, { kind: 'failed', text: 'Mattermost did not answer' });
  const bargedIn = liveActivity(result({ name: 'mattermost_search', status: 'completed', disposition: 'after_barge_in' }))!;
  assert.deepEqual(bargedIn, { kind: 'done', text: 'Found it, ask if you want it' });
  assert.match(activityMarkup(bargedIn), /activity-done/);
  assert.doesNotMatch(activityMarkup(bargedIn), /activity-failed/);
});

test('a slow pending call adds elapsed seconds only after the threshold', () => {
  const live: LiveCurrent = { state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'gmail_list', status: 'called' } }] };
  const activity = liveActivity(live)!;
  assert.doesNotMatch(activityMarkup(activity, SLOW_TOOL_MS - 1), /\d+s/);
  assert.match(activityMarkup(activity, SLOW_TOOL_MS), /Searching your mail \(4s\)/);
  assert.match(activityMarkup(activity, 9000), /Searching your mail \(9s\)/);
});

test('a batch of two calls renders one combined activity line', () => {
  const live: LiveCurrent = { state: 'thinking', cursor: 2, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'gmail_list', status: 'called' } },
    { seq: 2, kind: 'toolCall', tool: { name: 'mattermost_search', status: 'called' } },
  ] };
  const html = activityMarkup(liveActivity(live));
  assert.equal((html.match(/activity-line/g) ?? []).length, 1);
  assert.match(html, /Searching your mail and Mattermost/);
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
  assert.match(liveLabel(live), /Reconnecting to the voice service/);
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
    assert.equal(liveLabel(live), label);
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
  assert.equal((html.match(/<details class="live-remember"/g) ?? []).length, 0);
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


test('terminal Live uses idle cadence while active and hidden cadence stay unchanged', () => {
  assert.equal(liveDelay('ended', false), 4000);
  assert.equal(liveDelay('error', false), 4000);
  assert.equal(liveDelay('rebuilding', false), 250);
  assert.equal(liveDelay('ended', true), undefined);
});

test('unchanged empty cursor page retains complete Live projection without traversing entries', () => {
  const entries = new Proxy([{seq:1,kind:'outputTranscription',text:'retained'}], {
    get(target, key, receiver) { if (key === Symbol.iterator) throw new Error('retained-entry iteration'); return Reflect.get(target,key,receiver); },
  }) as LiveCurrent['entries'];
  const previous: LiveCurrent = {state:'ended',since:'session-a',cursor:1,entries};
  const next: LiveCurrent = {...previous,entries:[]};
  assert.equal(mergeLive(previous,next),previous);
});

test('empty cursor pages preserve entries while equal-cursor projection changes remain visible', () => {
  const previous: LiveCurrent = {state:'ended',since:'session-a',cursor:1,entries:[{seq:1,kind:'outputTranscription',text:'retained'}]};
  const changes: Partial<LiveCurrent>[] = [
    {state:'error'}, {muted:true}, {cursor:2},
    {pastSession:{outcome:'failed',endedAt:1,lastObservedAt:1}},
    {jobs:[{id:'synthetic-job',originSessionId:'session-a',state:'completed',createdAt:1,markdown:'**Complete**',delivered:false}]},
  ];
  for (const change of changes) {
    const merged=mergeLive(previous,{...previous,...change,entries:[]});
    assert.notEqual(merged,previous);
    assert.equal(merged.entries,previous.entries);
    for (const [key,value] of Object.entries(change)) assert.deepEqual(merged[key as keyof LiveCurrent],value);
  }
  const previousExtra={...previous,memory:{status:'empty'}};
  assert.notEqual(mergeLive(previousExtra,{...previousExtra,memory:{status:'selected'},entries:[]} as LiveCurrent),previousExtra);
});


test('unchanged terminal polling updates successful time without changing projection identity', async () => {
  const live: LiveCurrent={state:'ended',since:'session-a',cursor:1,entries:[{seq:1,kind:'terminal'}]};
  const previous={live,lastSuccess:new Date(1000),stale:false};
  const next=await pollLiveView(previous,async cursor=>{assert.equal(cursor,1);return {...live,entries:[]};},()=>new Date(2000));
  assert.equal(next.live,live);assert.equal(next.lastSuccess?.getTime(),2000);
  const stale=await pollLiveView(next,async()=>{throw new Error('synthetic unavailable');});
  const staleAgain=await pollLiveView(stale,async()=>{throw new Error('synthetic unavailable');});
  assert.equal(staleAgain.live,live);assert.equal(staleAgain.lastSuccess,stale.lastSuccess);
  assert.equal(staleAgain.stale,true);
});

test('new session fetches an uncursored initial page before resetting retained projection', async () => {
  const previous={live:{state:'ended' as const,since:'session-a',cursor:900,entries:[{seq:900,kind:'terminal' as const}]}};
  const cursors:(string|number|undefined)[]=[];
  const next=await pollLiveView(previous,async cursor=>{
    cursors.push(cursor);
    return {state:'listening',since:'session-b',cursor:cursor===undefined?1:900,entries:cursor===undefined?[{seq:1,kind:'inputTranscription',text:'new initial entry'}]:[]};
  });
  assert.deepEqual(cursors,[900,undefined]);
  assert.equal(next.live?.since,'session-b');assert.equal(next.live?.entries.length,1);
  assert.equal(next.live?.entries[0]?.text,'new initial entry');
});

for (const kind of ['authority', 'offline-success', 'offline-failure', 'logout']) {
  test(`held Live response cannot overwrite ${kind} reset`, async () => {
    const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
    const poll=source.slice(source.indexOf('async function pollLive(){'),source.indexOf('async function pollConnections(){'));
    const prefix=kind==='authority'?'onAuthorityChanged(':kind==='logout'?"  button('logout',":"window.addEventListener('offline',";
    const parsed=createSourceFile('main.ts',source,ScriptTarget.Latest,true);
    const authority=parsed.statements.find(node=>node.kind===SyntaxKind.ExpressionStatement&&node.getText(parsed).startsWith('onAuthorityChanged('))!.getText(parsed);
    const resetSource=kind==='authority'?authority:source.split('\n').find(line=>line.startsWith(prefix));
    assert(resetSource);
    const original={live:{state:'ended' as const,since:'synthetic-session',cursor:1,entries:[{seq:1,kind:'terminal' as const}]},stale:false};
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let callback!:()=>void,ownerReset!:(reason:string)=>void,version={},scheduled=0,liveTimerArmed=false;
    const paints:unknown[]=[];
    const context:any={document:{hidden:false},pairingRequired:false,liveBusy:false,liveTimer:1,pollTimer:1,connectionsTimer:1,
      livePoll:original,live:original.live,pollLiveView,AbortSignal,clearTimeout:()=>{},authorityVersion:()=>version,
      readGeneration:0,controller:undefined,busy:false,readBusy:false,pairingBusy:false,connectionsBusy:false,schedulePoll:()=>{},
      fetchLive:async()=>{await gate;if(kind==='authority'||kind==='offline-failure')throw new Error('synthetic unavailable');return {...original.live,entries:[]};},
      scheduleLive:()=>{scheduled++;liveTimerArmed=!context.pairingRequired;},
      paintLive:()=>{paints.push(context.live);},render:()=>{paints.push(context.live);},
      onAuthorityChanged:(fn:(reason:string)=>void)=>{ownerReset=fn;callback=()=>{version={};fn('changed');};},window:{addEventListener:(_name:string,fn:()=>void)=>{callback=fn;}},
      button:(_name:string,fn:()=>void)=>{callback=fn;},logout:async()=>{version={};ownerReset('logout');},
      mutate:(action:()=>Promise<void>)=>{context.mutation=action().then(()=>context.render());},
      connectedView:{reset:()=>{},detach:()=>{}},connections:[],connectionsStale:false,statusUnavailable:false,status:{},
      sessions:[],entries:[],session:undefined,plan:undefined,recall:undefined,recent:[],connection:'Connected'};
    createContext(context);runInContext(poll+(kind==='logout'?authority:'')+resetSource,context);
    const pending=context.pollLive();assert.equal(context.liveBusy,true);
    callback();if(kind==='logout')await context.mutation;
    const reset=context.livePoll;assert.notEqual(reset,original);
    const paintCount=paints.length;
    if(kind==='authority'||kind==='logout')assert.equal(paints.at(-1),undefined);
    else assert.equal(context.livePoll.stale,true);
    release();await pending;
    assert.equal(context.livePoll,reset);assert.equal(paints.length,paintCount);
    assert.equal(context.liveBusy,false);assert.equal(scheduled,kind==='authority'||kind==='logout'?0:1);
    if(kind==='logout')assert.equal(liveTimerArmed,false);
  });
}


test('manual Live refresh cancels the scheduled handle before held logout', async () => {
  const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const poll=source.slice(source.indexOf('async function pollLive(){'),source.indexOf('async function pollConnections(){'));
  const schedule=source.slice(source.indexOf('function scheduleLive(){'),source.indexOf('function paintLive(){'));
  let id=0,release!:()=>void;const timers=new Map<number,{fn:()=>void,delay:number}>();
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const version={};
  const projection:LiveCurrent={state:'listening',since:'synthetic-timer-session',cursor:0,entries:[]};
  const context:any={document:{hidden:false},pairingRequired:false,liveBusy:false,liveTimer:undefined,
    livePoll:{live:projection},live:projection,liveDelay,pollLiveView,AbortSignal,authorityVersion:()=>version,
    setTimeout:(fn:()=>void,delay:number)=>{const handle=++id;timers.set(handle,{fn,delay});return handle;},
    clearTimeout:(handle:number)=>{timers.delete(handle);},fetchLive:async()=>{await gate;return projection;},paintLive:()=>{}};
  createContext(context);runInContext(poll+schedule,context);
  context.scheduleLive();assert.equal(timers.size,1);
  const pending=context.pollLive();assert.equal(context.liveBusy,true);
  const timerCountDuringManualPoll=timers.size;
  context.pairingRequired=true;context.livePoll={};context.live=undefined;
  release();await pending;
  assert.equal(timerCountDuringManualPoll,0,'manual refresh owns cancellation of the pending poll');
  assert.equal(timers.size,0,'logout must leave no lost Live timer');
  assert.equal(context.liveTimer,undefined);assert.equal(context.liveBusy,false);
});

// --- Web Live state machine (issue #255 items 2, 10, 11). ---
import { LIVE_CONSENT, LiveMachine, liveErrorText, pillVisible, startAvailable, stopAvailable } from '../src/live-view.ts';
import { createBridge, createFakeNative } from '../src/native-bridge.ts';

const harness = (seed = {}) => {
  const posted: { type: string }[] = [];
  const machine = new LiveMachine((message) => posted.push(message as { type: string }), seed);
  return { posted, machine };
};

test('the first Start opens the consent popover and sends nothing to native', () => {
  const { posted, machine } = harness();
  machine.requestStart();
  assert.equal(machine.view.consentOpen, true);
  assert.equal(machine.view.pendingStart, true);
  assert.deepEqual(posted, [], 'no start reaches native before Allow');
  assert.match(LIVE_CONSENT.body, /Audio goes to the Live provider while Live is on/);
});

test('a native requestStart also shows the consent popover, so a shortcut cannot bypass it', () => {
  const { machine } = harness();
  const bridge = createBridge();
  const fake = createFakeNative((message) => bridge.receive(message));
  bridge.useTransport((message) => fake.handle(message));
  bridge.onNative((message) => machine.receive(message));
  fake.requestStart();
  assert.equal(machine.view.consentOpen, true);
  assert.equal(machine.view.pendingStart, true);
});

test('after Allow the pending Start runs once with consentGranted first', () => {
  const { posted, machine } = harness();
  machine.requestStart();
  machine.grantConsent();
  assert.deepEqual(posted, [{ type: 'consentGranted' }, { type: 'start' }]);
  assert.equal(machine.view.consent, true);
  assert.equal(machine.view.state, 'starting');
});

test('once consent is granted, Start is one click', () => {
  const { posted, machine } = harness({ consent: true });
  machine.requestStart();
  assert.deepEqual(posted, [{ type: 'start' }]);
});

test('native requestStart and requestStop drive the same state machine', () => {
  const { posted, machine } = harness({ consent: true });
  machine.receive({ type: 'requestStart' });
  assert.equal(machine.view.state, 'starting');
  machine.receive({ type: 'liveState', state: 'live' });
  machine.receive({ type: 'requestStop' });
  assert.equal(machine.view.state, 'stopping');
  assert.deepEqual(posted.map((message) => message.type), ['start', 'stop']);
});

test('mic denied shows a clear error line and leaves Start available, never a dead button', () => {
  const { posted, machine } = harness({ consent: true });
  machine.requestStart();
  machine.receive({ type: 'liveState', state: 'error', error: 'micDenied' });
  assert.equal(startAvailable(machine.view), true);
  assert.match(liveErrorText(machine.view.error, machine.view.reason)!, /Microphone access is blocked/);
  machine.requestStart();
  assert.equal(posted.filter((message) => message.type === 'start').length, 2, 'Start retries after an error');
});

test('the pill is visible while live or muted only', () => {
  const { machine } = harness({ consent: true });
  assert.equal(pillVisible(machine.view), false);
  machine.receive({ type: 'liveState', state: 'live' });
  assert.equal(pillVisible(machine.view), true);
  machine.receive({ type: 'liveState', state: 'muted' });
  assert.equal(pillVisible(machine.view), true);
  machine.receive({ type: 'liveState', state: 'idle' });
  assert.equal(pillVisible(machine.view), false);
});

test('Stop responds immediately during a live session, ignoring levels churn', () => {
  const { posted, machine } = harness({ consent: true });
  machine.receive({ type: 'liveState', state: 'live' });
  for (let i = 0; i < 50; i += 1) machine.receive({ type: 'levels', input: [0.1], output: [0.2] });
  assert.equal(stopAvailable(machine.view), true);
  machine.requestStop();
  assert.equal(machine.view.state, 'stopping');
  assert.deepEqual(posted.map((message) => message.type), ['stop']);
});

test('hydrate settles consent, mic, theme and last-session time and closes the popover', () => {
  const { machine } = harness();
  machine.receive({ type: 'hydrate', consent: true, mic: 'granted', live: { state: 'idle' }, route: null, theme: 'light', lastSessionEndedAt: '2026-10-15T08:31:00Z' });
  assert.equal(machine.view.consent, true);
  assert.equal(machine.view.mic, 'granted');
  assert.equal(machine.view.theme, 'light');
  assert.equal(machine.view.consentOpen, false);
  assert.equal(machine.view.lastSessionEndedAt, '2026-10-15T08:31:00Z');
});
test('no visible Live text carries a raw url or a markdown heading marker', () => {
  const live: LiveCurrent = { state: 'speaking', cursor: 2, entries: [
    { seq: 1, kind: 'outputTranscription', text: "# Knowledge Search: 'q'\n\nsee https://www.google.com/calendar/event?eid=abc" },
    { seq: 2, kind: 'toolResult', tool: { name: 'search_knowledge', status: 'completed', markdown: '# raw tool heading\n\ngo https://example.org/x', sources: [{ title: 'Calendar: Standup', url: 'https://www.google.com/calendar/event?eid=abc' }] } },
  ] };
  const visible = liveMarkup(live).replace(/<[^>]+>/g, '\n');
  for (const node of visible.split('\n').map(text => text.trim()).filter(Boolean)) {
    assert.equal(/https?:\/\//.test(node), false, `raw url visible in: ${node}`);
    assert.equal(node.startsWith('#'), false, `raw heading visible in: ${node}`);
  }
});

test('output transcript chunks join with a space at a sentence boundary (V2-R2 item 1)', () => {
  const live: LiveCurrent = { state: 'speaking', cursor: 2, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Ship the three-lane UI and the live pill.' },
    { seq: 2, kind: 'outputTranscription', text: 'I checked the calendar.' }
  ] };
  const lines = liveTranscript(live);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Ship the three-lane UI and the live pill. I checked the calendar.');
});

test('the PROCESSING override follows the playback band, never the owner capture (F6)', () => {
  assert.equal(posture('PROCESSING', { level: 0.9, playback: 0 }), 'thinking', 'the owner talking does not make the orb speak');
  assert.equal(posture('PROCESSING', { level: 0, playback: 0.9 }), 'speaking', 'audible playback during a tool turn still speaks');
  assert.equal(posture('SPEAKING', { level: 0, playback: 0 }), 'speaking');
  assert.equal(posture('LISTENING', { level: 0, playback: 0 }), 'listening');
  assert.equal(posture('CONNECTING', { level: 0, playback: 0 }), 'thinking');
  assert.equal(posture('ERROR', { level: 0, playback: 0 }), 'quiet');
});

test('a job state renders as a plain human sentence, never the raw enum token (M1)', () => {
  assert.equal(jobStateLabel('in_progress'), 'Background task in progress');
  assert.equal(jobStateLabel('completed'), 'Background task finished');
  assert.equal(jobStateLabel('failed'), 'Background task failed');
  assert.equal(jobStateLabel('unknown'), 'Background task was interrupted before its result was known');
  for (const state of ['in_progress', 'completed', 'failed', 'unknown'] as const) {
    assert.equal(jobStateLabel(state).includes('unknown'), false, 'the raw state word never reaches the panel');
  }
});

test('a live job card shows the plain sentence, not "Background task unknown" (M1)', () => {
  const live = { state: 'idle', entries: [], cursor: 0, jobs: [{ id: 'j1', originSessionId: 's1', state: 'unknown', createdAt: 0, markdown: 'result', delivered: false }] } as LiveCurrent;
  const html = liveMarkup(live);
  assert.match(html, /Background task was interrupted before its result was known/);
  assert.equal(html.includes('Background task unknown'), false);
});
