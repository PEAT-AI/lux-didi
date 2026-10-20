import { createSourceFile, ScriptTarget, SyntaxKind, transpileModule } from 'typescript';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { connectingBeforeFirstSpeech, liveStateLabel, liveVoiceState, pendingToolNames, liveLabel, liveDelay, mergeLive, liveTranscript, liveResult, liveMarkup, liveActivity, activityMarkup, jobStateLabel, SLOW_TOOL_MS, liveSegments, sessionItems, sessionDividerText, earlierSession, pastSessionsMarkup, pastSessionListMarkup, openSegments, restoreOpen, growingText, joinChunk, liveLineMarkup, TURN_DETAIL_MIN, jobGist, startingReset, turnHeadline, sessionTurnCount, sessionHeadline, FEED_EMPTY, stepListMarkup, stepsFading, stepsAnswered } from '../src/live-view.ts';
import { miniMarkup, miniState } from '../src/mini.ts';
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
  // UI3B-R1 (owner decision): history is a panel, not an inline disclosure. It is closed by default and
  // a past session is reachable only from inside it.
  const withPast = liveMarkup(live, { live, earlier: [{ at: 'Yesterday, 09:15', html: '<p>old session</p>' }] });
  assert.match(withPast, /<details class="feed-sessions" id="past-sessions"><summary/,'the past-sessions panel is closed by default');
  assert.equal(withPast.slice(withPast.indexOf('id="past-sessions"')).startsWith('id="past-sessions"><summary'), true);
  assert.match(withPast, /old session/,'the panel holds the earlier sessions');
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
  assert.equal(liveLabel({ state: 'listening', cursor: 0, entries: [] }), 'Connecting');
  assert.equal(liveLabel({ state: 'speaking', cursor: 0, entries: [] }), 'Speaking');
  assert.equal(liveLabel({ state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'search', status: 'called' } }] }), 'Thinking');
});

test('Q4: the orb and pill say Connecting until the first audible model frame', () => {
  // The projection says `listening` when the microphone opens, up to 4.6 s before Naya's
  // first audio; before that frame the owner is listening to silence.
  const opened = { state: 'listening' as const, cursor: 0, entries: [] };
  assert.equal(connectingBeforeFirstSpeech(opened), true);
  assert.equal(liveLabel(opened), 'Connecting');
  assert.equal(liveVoiceState('listening'), 'LISTENING');
  const ownerSpoke = { state: 'listening' as const, cursor: 1, entries: [{ seq: 1, kind: 'inputTranscription' as const, text: 'Hi Naya' }] };
  assert.equal(liveLabel(ownerSpoke), 'Connecting');
  const heard = { state: 'listening' as const, cursor: 2, entries: [
    { seq: 1, kind: 'inputTranscription' as const, text: 'Hi Naya' },
    { seq: 2, kind: 'outputTranscription' as const, text: 'Of course.' }] };
  assert.equal(connectingBeforeFirstSpeech(heard), false);
  assert.equal(liveLabel(heard), 'Listening');
  // Every other word is unchanged.
  assert.equal(liveLabel({ state: 'speaking', cursor: 2, entries: [] }), 'Speaking');
  assert.equal(liveLabel({ state: 'thinking', cursor: 2, entries: [] }), 'Thinking');
  assert.equal(connectingBeforeFirstSpeech(undefined), false);
  assert.equal(connectingBeforeFirstSpeech({ state: 'speaking', cursor: 3, entries: [] }), false);
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

test('a mid-answer owner line is its own bubble, between two of hers', () => {
  // The typed turn lands while her answer is still streaming; the journal has no turnComplete, so
  // the speaker change itself is the boundary (P7 item 1).
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
    { role: 'naya', text: 'Hel' },
    { role: 'user', text: 'Tell me more' },
    { role: 'naya', text: 'lo there' },
  ]);
  assert.deepEqual(sessionItems(live).map(item => item.key), ['user:1', 'naya:3', 'user:4', 'naya:5'],
    'keys stay role:firstSeq, so an in-place update still finds its row');
});

test('joinChunk puts exactly one space at every boundary', () => {
  assert.equal(joinChunk('hello', 'there'), 'hello there');
  assert.equal(joinChunk('done.', 'Next'), 'done. Next');
  assert.equal(joinChunk('trailing ', 'space'), 'trailing space');
  assert.equal(joinChunk('word', ' leading'), 'word leading');
  assert.equal(joinChunk('', 'fresh'), 'fresh');
  assert.equal(joinChunk('only', ''), 'only');
});

test('P7 a call with no turnComplete renders one bubble per turn, in the order spoken', () => {
  // Owner call 1ea4cc4f row shape: alternating owner and Naya rows, 0 turnComplete, 5 tool results.
  const rows: LiveCurrent['entries'] = [];
  const expected: string[] = [];
  let seq = 0;
  for (let exchange = 1; exchange <= 13; exchange += 1) {
    const role = exchange % 2 === 1 ? 'user' : 'naya';
    seq += 1;
    rows.push({ seq, kind: role === 'user' ? 'inputTranscription' : 'outputTranscription', text: role === 'user' ? `owner line ${seq}` : `her answer ${seq}.` });
    expected.push(`${role}:${seq}`);
    if ([2, 4, 6, 8, 10].includes(exchange)) {
      seq += 1;
      rows.push({ seq, kind: 'toolResult', tool: { name: 'search', status: 'completed', markdown: 'row' } });
    }
  }
  const items = sessionItems({ state: 'speaking', cursor: seq, entries: rows } as LiveCurrent);
  const turns = items.filter(item => /^(user|naya):\d+$/.test(item.key));
  assert.deepEqual(turns.map(item => item.key), expected, '13 bubbles, each keyed by its own first delta');
  assert.equal((liveMarkup({ state: 'speaking', cursor: seq, entries: rows } as LiveCurrent).match(/class="entry (user|assistant)"/g) ?? []).length, 13,
    'no two turns share a bubble');
});

test('transcript joins the fragments of one speaker run with a space', () => {
  const live: LiveCurrent = { state: 'speaking', cursor: 7, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Hello' },
    { seq: 2, kind: 'outputTranscription', text: 'and' },
    { seq: 3, kind: 'turnComplete' },
    { seq: 4, kind: 'inputTranscription', text: 'ok' },
    { seq: 5, kind: 'inputTranscription', text: 'then what' },
    { seq: 6, kind: 'turnComplete' },
  ] };
  assert.deepEqual(liveTranscript(live), [
    { role: 'naya', text: 'Hello and' },
    { role: 'user', text: 'ok then what' },
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
    { seq: 1, kind: 'outputTranscription', text: 'Hello' },
    { seq: 2, kind: 'outputTranscription', text: 'there' },
  ] };
  const replay: LiveCurrent = { state: 'speaking', since: 'session-a', cursor: 3, entries: [
    { seq: 2, kind: 'outputTranscription', text: 'there you go' },
    { seq: 3, kind: 'turnComplete' },
  ] };
  const merged = mergeLive(first, replay);
  assert.deepEqual(liveTranscript(merged), [{ role: 'naya', text: 'Hello there you go' }]);
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
    { seq: 1, kind: 'toolResult', tool: { name: 'gmail_search_messages', status: 'completed', markdown: 'mail' } },
  ] };
  const html = liveMarkup(live);
  assert.match(html, /Searching your mail/);
  assert.doesNotMatch(html, /gmail_search_messages/);
});

test('liveActivity names the phrases of a pending batch and never the raw id', () => {
  const live: LiveCurrent = { state: 'thinking', cursor: 2, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'gmail_search_messages', status: 'called' } },
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
  const done = liveActivity(result({ name: 'gmail_search_messages', status: 'completed', markdown: 'mail' }))!;
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
  const live: LiveCurrent = { state: 'thinking', cursor: 1, entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'gmail_search_messages', status: 'called' } }] };
  const activity = liveActivity(live)!;
  assert.doesNotMatch(activityMarkup(activity, SLOW_TOOL_MS - 1), /\d+s/);
  assert.match(activityMarkup(activity, SLOW_TOOL_MS), /Searching your mail \(4s\)/);
  assert.match(activityMarkup(activity, 9000), /Searching your mail \(9s\)/);
});

test('a batch of two calls renders one combined activity line', () => {
  const live: LiveCurrent = { state: 'thinking', cursor: 2, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'gmail_search_messages', status: 'called' } },
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
    const context:any={document:{hidden:false},pairingRequired:false,liveBusy:false,liveTimer:1,pollTimer:1,connectionsTimer:1,orbSurfaceVisible:()=>true,
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
    createContext(context);runInContext(asScript(poll+(kind==='logout'?authority:'')+resetSource),context);
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


/** main.ts is TypeScript: the slices are transpiled before the vm sees them, as the orb helper already does. */
const asScript = (source: string) => transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;

test('manual Live refresh cancels the scheduled handle before held logout', async () => {
  const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const poll=source.slice(source.indexOf('async function pollLive(){'),source.indexOf('async function pollConnections(){'));
  const schedule=source.slice(source.indexOf('function scheduleLive(){'),source.indexOf('function paintLive(){'));
  let id=0,release!:()=>void;const timers=new Map<number,{fn:()=>void,delay:number}>();
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const version={};
  const projection:LiveCurrent={state:'listening',since:'synthetic-timer-session',cursor:0,entries:[]};
  const context:any={document:{hidden:false},pairingRequired:false,liveBusy:false,liveTimer:undefined,orbSurfaceVisible:()=>true,
    livePoll:{live:projection},live:projection,liveDelay,pollLiveView,AbortSignal,authorityVersion:()=>version,
    setTimeout:(fn:()=>void,delay:number)=>{const handle=++id;timers.set(handle,{fn,delay});return handle;},
    clearTimeout:(handle:number)=>{timers.delete(handle);},fetchLive:async()=>{await gate;return projection;},paintLive:()=>{}};
  createContext(context);runInContext(asScript(poll+schedule),context);
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


// --- FE1: the living feed (large orb, item types, per-session boundary) ---

test('FE1 the live session opens with its dated divider', () => {
  const segments = liveSegments(speaking);
  assert.equal(segments[0]!.key, 'divider:session');
  assert.match(segments[0]!.html, /class="feed-divider"/);
  assert.match(segments[0]!.html, /Today|Yesterday|[A-Z][a-z]{2} \d/);
});

test('FE1 a tool in flight adds one live activity row that resolves in place', () => {
  const pending = { state: 'thinking', since: '2026-10-11T16:00:00Z', cursor: 2, entries: [
    { seq: 1, kind: 'toolCall', tool: { name: 'search_calendar', status: 'pending' } },
  ] } as unknown as LiveCurrent;
  const segs = sessionItems(pending);
  assert.equal(segs.filter(s => s.key === 'activity').length, 1);
  assert.match(segs.find(s => s.key === 'activity')!.html, /feed-activity/);
  const resolved = { ...pending, cursor: 3, entries: [...pending.entries, { seq: 2, kind: 'toolResult', tool: { name: 'search_calendar', status: 'completed', markdown: 'ok' } }] } as unknown as LiveCurrent;
  assert.equal(sessionItems(resolved).filter(s => s.key === 'activity').length, 0, 'the activity row resolves into the result card');
  assert.match(sessionItems(resolved).find(s => s.key === 'tool:2')!.html, /data-feed="tool"/);
});

test('FE1 the session divider names today, yesterday or the short date', () => {
  const now = new Date(2026, 9, 15, 12, 0);
  assert.match(sessionDividerText(new Date(2026, 9, 15, 8, 31).toISOString(), now), /^Today, .*08:31/);
  assert.match(sessionDividerText(new Date(2026, 9, 14, 9, 15).toISOString(), now), /^Yesterday, .*09:15/);
  assert.equal(sessionDividerText(null, now), 'Earlier');
});

test('UI3b a terminal newest session opens on the blank line alone, with nothing from it inline', () => {
  const ended = { state: 'ended', since: '2026-10-11T16:00:00Z', cursor: 3, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'hello' },
    { seq: 2, kind: 'outputTranscription', text: 'Hi there' },
    { seq: 3, kind: 'turnComplete' },
  ], pastSession: { outcome: 'closed', endedAt: '2026-10-11T16:05:00Z', lastObservedAt: '2026-10-11T16:05:00Z' } } as unknown as LiveCurrent;
  const html = liveMarkup(ended);
  assert.match(html, /feed-empty/);
  assert.doesNotMatch(html, /Hi there/, 'a finished session leaves no line in the voice view');
  assert.doesNotMatch(html, /data-seg="past-session"/, 'a finished session is not an inline block');
  assert.doesNotMatch(html, /id="past-sessions"/, 'with no earlier sessions the panel is absent, not an empty box');
});

test('UI3b a new session starts blank and earlier sessions live only in the closed panel', () => {
  const previous = { state: 'ended', since: '2026-10-11T16:00:00Z', cursor: 3, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'old question' },
    { seq: 2, kind: 'outputTranscription', text: 'Old answer' },
    { seq: 3, kind: 'turnComplete' },
  ], pastSession: { outcome: 'closed', endedAt: '2026-10-11T16:05:00Z', lastObservedAt: null } } as unknown as LiveCurrent;
  const block = earlierSession(previous)!;
  assert.match(block.html, /class="feed-session"/);
  assert.match(block.html, /Old answer/);
  const fresh = { state: 'listening', since: '2026-10-12T16:00:00Z', cursor: 1, entries: [{ seq: 1, kind: 'inputTranscription', text: 'new question' }] } as unknown as LiveCurrent;
  const html = liveMarkup(fresh, { live: fresh, earlier: [block] });
  assert.ok(html.indexOf('new question') < html.indexOf('id="past-sessions"'), 'the current session is the feed; the panel sits after it');
  assert.equal(html.includes('Old answer'), true, 'the earlier session is reachable from the panel');
  assert.match(html, /<details class="feed-sessions" id="past-sessions"><summary/, 'the panel carries no open attribute, so it starts closed');
});

test('UI3b the past-sessions panel lists every earlier session and nothing when there is none', () => {
  const previous = { state: 'ended', since: '2026-10-11T16:00:00Z', cursor: 3, entries: [{ seq: 1, kind: 'outputTranscription', text: 'Old answer' }] } as unknown as LiveCurrent;
  const block = earlierSession(previous)!;
  const panel = pastSessionsMarkup([block]);
  assert.match(panel, /id="past-sessions"/);
  assert.match(panel, /Past sessions/);
  assert.doesNotMatch(panel.slice(0, panel.indexOf('>')), /open/);
  assert.equal(pastSessionsMarkup([]), '', 'no earlier sessions means no panel');
  assert.equal(pastSessionListMarkup([block]), block.html);
});

test('FE1 the feed is one surface with headline rows and collapsed detail', () => {
  const html = liveMarkup(speaking);
  assert.equal((html.match(/class="feed live-turns"/g) ?? []).length, 1, 'exactly one feed list');
  assert.match(html, /data-feed="turn"/);
  assert.match(html, /data-feed="tool"/);
  assert.match(html, /<details class="live-tool-result"[^>]*><summary/);
});

test('FE1 the turn row shows a headline and keeps the full answer in a closed detail', () => {
  const answer = 'Ship the UI. Then run the audit against the release branch before the owner tests it, '
    + 'because the transcript shows only the first sentence above the disclosure and everything else '
    + 'has to stay one click away, which is the whole point of keeping the full answer closed here. '
    + 'The threshold is a length, not a sentence count, so a long single sentence still opens a detail.';
  assert.ok(answer.length >= TURN_DETAIL_MIN, 'the fixture is above the disclosure threshold');
  const live = { state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 5, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'what next?' },
    { seq: 2, kind: 'outputTranscription', text: answer },
    { seq: 3, kind: 'turnComplete' },
  ] } as unknown as LiveCurrent;
  const html = liveMarkup(live);
  assert.equal(turnHeadline(answer), 'Ship the UI.');
  assert.match(html, /<article class="entry assistant" data-feed="turn"[^>]*><div class="markdown"><p>Ship the UI\.<\/p>/);
  assert.match(html, /<details class="feed-turn-detail"><summary>Full answer<\/summary>/);
  assert.doesNotMatch(html.slice(0, html.indexOf('feed-turn-detail')), /Then run the audit/, 'only the headline is visible above the detail');
  assert.match(html, /what next\?/, "the owner's verbatim line is kept in the detail");
  // Below the threshold the whole closed answer is the bubble: no disclosure to open for one sentence.
  const short = liveMarkup({ ...live, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'what next?' },
    { seq: 2, kind: 'outputTranscription', text: 'Ship the UI. Then run the audit.' },
    { seq: 3, kind: 'turnComplete' },
  ] } as unknown as LiveCurrent);
  assert.doesNotMatch(short, /feed-turn-detail/);
  assert.match(short, /Then run the audit\./);
});

test('P7 an open bubble is never split into headline plus detail', () => {
  const answer = 'The first thing is the audit. ' + 'Then the transcript work, which is long. '.repeat(10);
  const open = { state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 3, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'what next?' },
    { seq: 2, kind: 'outputTranscription', text: answer },
  ] } as unknown as LiveCurrent;
  const html = liveMarkup(open);
  assert.match(html, /data-live-text>/, 'the growing answer carries the one text node the poll rewrites');
  assert.doesNotMatch(html, /feed-turn-detail/, 'no disclosure while it is still being spoken');
  assert.match(html, /which is long\./, 'the whole answer is visible');
});

test('P7-R1 the growing and the short closed bubble carry the clamp exemption', () => {
  const style = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const clamp = style.slice(style.indexOf('.entry[data-feed="turn"] > .markdown{'), style.indexOf('\n', style.indexOf('.entry[data-feed="turn"] > .markdown{')));
  assert.match(clamp, /-webkit-line-clamp:2/, 'the headline clamp itself stays');
  const exempt = style.slice(style.indexOf('[data-growing]'), style.indexOf('\n', style.indexOf('[data-growing]')));
  assert.match(exempt, /\[data-short\]/, 'a closed answer under the threshold is exempt as well');
  assert.match(exempt, /-webkit-line-clamp:unset/, 'the exemption lifts the clamp');
  assert.match(exempt, /overflow:visible/, 'and stops hiding the rest of the text');
  const growing = liveMarkup({ state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 3, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'One long answer that is still being spoken.' },
  ] } as unknown as LiveCurrent);
  assert.match(growing, /<article class="entry assistant"[^>]*data-growing/);
  const short = liveMarkup({ state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 4, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Ship it. Then check.' },
    { seq: 2, kind: 'turnComplete' },
  ] } as unknown as LiveCurrent);
  assert.match(short, /<article class="entry assistant"[^>]*data-short/);
  const long = liveMarkup({ state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 4, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Ship it. ' + 'And then keep going for a while. '.repeat(12) },
    { seq: 2, kind: 'turnComplete' },
  ] } as unknown as LiveCurrent);
  assert.doesNotMatch(long, /data-short|data-growing/, 'a long closed answer keeps the clamped headline');
});

test('P7 a growing owner bubble carries the same in-place text node', () => {
  const live = { state: 'listening', since: '2026-10-11T16:00:00Z', cursor: 3, entries: [
    { seq: 1, kind: 'outputTranscription', text: 'Sure thing.' },
    { seq: 2, kind: 'turnComplete' },
    { seq: 3, kind: 'inputTranscription', text: 'I want to ask' },
  ] } as unknown as LiveCurrent;
  const owner = sessionItems(live).find(item => item.key === 'user:3')!;
  assert.match(owner.html, /data-growing/, 'the owner transcription is still streaming too');
  assert.equal(growingText(owner.html), 'I want to ask');
  // The owner's words are escaped into their own text node, which innerHTML decodes back once.
  assert.equal(growingText(liveLineMarkup({ role: 'user', text: 'a & b' }, 'user:9', true)), 'a &amp; b');
});

test('P7 the growing bubble keeps its node and an opened detail stays open', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function renderTranscript(');
  assert.ok(start > 0, 'main.ts still renders the transcript in one function');
  // renderTranscript is plain page code, so only its type annotations need stripping for the vm.
  const render = source.slice(start, source.indexOf('function bindTranscript('))
    .replace('(list: HTMLElement)', '(list)').replace(/ as HTMLElement\[\]/g, '').replace(/children\[index\]!/g, 'children[index]');
  const replaced: string[] = [];
  const makeRow = (html: string) => {
    let current = html;
    const seg = /data-seg="([^"]+)"/.exec(html)?.[1];
    const textNode = { innerHTML: growingText(html) ?? '' };
    const row: any = {
      dataset: /data-growing/.test(html) ? { seg, growing: '' } : { seg },
      classList: { add() {} },
      querySelector: (selector: string) => (selector === '[data-live-text]' ? textNode : null),
    };
    Object.defineProperty(row, 'outerHTML', { get: () => current, set: (value: string) => { replaced.push(String(seg)); current = value; } });
    return row;
  };
  const list: any = { children: [] as any[] };
  const context: any = { list, live: undefined, openBySeg: new Map<string, string[]>(), liveSegments, openSegments, restoreOpen, growingText, FEED_EMPTY };
  createContext(context);
  const script = `${render}\nrenderTranscript(list);`;
  const seed = [
    { seq: 1, kind: 'inputTranscription', text: 'what next?' },
    { seq: 2, kind: 'outputTranscription', text: 'The audit is first.' },
    { seq: 3, kind: 'toolResult', tool: { name: 'search', status: 'completed', markdown: 'Found one source.' } },
    { seq: 4, kind: 'outputTranscription', text: 'Start there.' },
  ];
  context.live = { state: 'speaking', since: '2026-10-11T16:00:00Z', cursor: 4, entries: seed } as unknown as LiveCurrent;
  // The reader opened the tool chip before the answer started growing.
  list.children = liveSegments(context.live).map((segment: any) => makeRow(restoreOpen(segment.html, ['tool:3'])));
  const row = (seg: string) => list.children.find((child: any) => child.dataset.seg === seg);
  const growingRow = row('naya:4');
  const toolRow = row('tool:3');
  assert.ok(/data-growing/.test(growingRow.outerHTML), 'the last answer is the growing bubble');
  context.live = { ...context.live, cursor: 5, entries: [...seed, { seq: 5, kind: 'outputTranscription', text: 'Right away.' }] } as unknown as LiveCurrent;
  runInContext(script, context);
  assert.equal(row('naya:4'), growingRow, 'the growing bubble is the same DOM node, never replaced');
  assert.match(growingRow.querySelector('[data-live-text]').innerHTML, /Right away\./, 'its text node grew in place');
  assert.equal(replaced.includes('naya:4'), false, 'the growing row was never rewritten through outerHTML');
  assert.equal(row('tool:3'), toolRow, 'no other row is rebuilt while the answer grows');
  assert.match(toolRow.outerHTML, /live-tool-result[^>]*open>/, 'the opened tool chip is still open');
  assert.equal(replaced.includes('tool:3'), false);
  // When the journal closes the run the row becomes an ordinary closed bubble.
  context.live = { ...context.live, cursor: 6, entries: [...seed, { seq: 5, kind: 'outputTranscription', text: 'Right away.' }, { seq: 6, kind: 'turnComplete' }] } as unknown as LiveCurrent;
  runInContext(script, context);
  assert.equal(growingText(row('naya:4')!.outerHTML), undefined, 'a closed bubble is no longer growing');
  // The owner's own transcription streams as they speak, so that row takes the same in-place path.
  const ownerSeed = [
    { seq: 1, kind: 'outputTranscription', text: 'Sure thing.' },
    { seq: 2, kind: 'turnComplete' },
    { seq: 3, kind: 'inputTranscription', text: 'I want' },
  ];
  context.live = { state: 'listening', since: '2026-10-11T16:00:00Z', cursor: 3, entries: ownerSeed } as unknown as LiveCurrent;
  list.children = liveSegments(context.live).map((segment: any) => makeRow(restoreOpen(segment.html, [])));
  const ownerRow = row('user:3');
  replaced.length = 0;
  context.live = { ...context.live, cursor: 4, entries: [...ownerSeed, { seq: 4, kind: 'inputTranscription', text: 'to ask' }] } as unknown as LiveCurrent;
  runInContext(script, context);
  assert.equal(row('user:3'), ownerRow, 'the growing owner bubble is the same DOM node, never replaced');
  assert.match(ownerRow.querySelector('[data-live-text]').innerHTML, /to ask/, 'its text node grew in place');
  assert.equal(replaced.includes('user:3'), false, 'the owner row was never rewritten through outerHTML');
});

test('FE1-R1 a finished session shows its first turn headline and turn count, collapsed', () => {
  const ended = { state: 'ended', since: '2026-10-11T16:00:00Z', cursor: 6, entries: [
    { seq: 1, kind: 'inputTranscription', text: 'first question' },
    { seq: 2, kind: 'outputTranscription', text: 'Ship the UI. Then run the audit.' },
    { seq: 3, kind: 'turnComplete' },
    { seq: 4, kind: 'inputTranscription', text: 'and then?' },
    { seq: 5, kind: 'outputTranscription', text: 'Thanks for watching.' },
    { seq: 6, kind: 'turnComplete' },
  ], pastSession: { outcome: 'closed', endedAt: '2026-10-11T16:05:00Z', lastObservedAt: '2026-10-11T16:05:00Z' } } as unknown as LiveCurrent;
  // UI3b: the finished session's summary and body live in the past-sessions panel, never in the lane.
  const html = pastSessionsMarkup([earlierSession(ended)!]);
  assert.match(html, /<details class="feed-session" data-seg="earlier:/, 'the finished session is a closed, expandable block');
  assert.match(html, /<summary class="feed-divider"><span class="feed-divider-date">/, 'the divider date leads the summary');
  assert.match(html, /class="feed-session-headline">Ship the UI\.</, 'the first turn headline is shown under the divider');
  assert.match(html, /class="feed-session-count">2 turns</, 'the turn count is shown');
  assert.equal(sessionTurnCount(ended), 2);
  assert.equal(sessionHeadline(ended), 'Ship the UI.');
  assert.match(html, /Ship the UI\. Then run the audit\./, 'the full answer stays in the collapsed body');
  assert.doesNotMatch(liveMarkup(ended), /Ship the UI/, 'and the lane itself stays blank');
});

test('FE1-R1 the orb caption carries the state word only, never the activity row', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const caption = source.slice(source.indexOf('function orbCaptionMarkup()'), source.indexOf('function orbStageMarkup()'));
  assert.doesNotMatch(caption, /activityLineMarkup|activityMarkup|feed-activity/, 'the activity row lives in the feed alone');
  assert.match(caption, /voice-state/);
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

test('UI3b a job result is one clean line: the gist and the state chip, never the raw evidence', () => {
  const live = { state: 'idle', entries: [], cursor: 0, jobs: [{ id: 'j1', originSessionId: 's1', state: 'completed', createdAt: 0,
    markdown: '## Findings\n- **Source A** says `x`\n- Source B says y\n\nMore prose.', delivered: false }] } as LiveCurrent;
  const html = liveMarkup(live);
  assert.match(html, /Background task finished/, 'the state stays a human sentence');
  assert.match(html, /live-job-gist/, 'the gist is its own chip on the same line');
  assert.match(html, /Findings/, 'the gist is the first sentence of the result');
  assert.doesNotMatch(html, /Source B says y/, 'raw evidence bullets never reach the voice view');
  assert.doesNotMatch(html, /<li>|<h2|<code>/, 'nothing of the raw markdown structure survives');
  assert.equal(jobGist('**Done** &amp; dusted.'), 'Done & dusted.', 'entities are decoded and markers stripped');
  assert.equal(jobGist(''), '');
});

test('UI3b an opened detail stays open when a poll repaints its segment', () => {
  const html = '<article data-seg="turn:2"><details class="feed-turn-detail" data-seg="detail:2" open><summary>Full answer</summary>body</details></article>';
  const repaint = '<article data-seg="turn:2"><details class="feed-turn-detail" data-seg="detail:2"><summary>Full answer</summary>body and more</details></article>';
  assert.deepEqual(openSegments(html), ['detail:2']);
  assert.deepEqual(openSegments(repaint), [], 'a closed row reports nothing');
  assert.match(restoreOpen(repaint, openSegments(html)), /<details class="feed-turn-detail" data-seg="detail:2" open>/, 'the reader keeps their open detail');
  assert.equal(restoreOpen(repaint, []), repaint, 'nothing to restore leaves the markup untouched');
});

test('a live job card shows the plain sentence, not "Background task unknown" (M1)', () => {
  const live = { state: 'idle', entries: [], cursor: 0, jobs: [{ id: 'j1', originSessionId: 's1', state: 'unknown', createdAt: 0, markdown: 'result', delivered: false }] } as LiveCurrent;
  const html = liveMarkup(live);
  assert.match(html, /Background task was interrupted before its result was known/);
  assert.equal(html.includes('Background task unknown'), false);
});

test('UI3b N2 the voice view drops to blank on the first starting frame and only then', () => {
  assert.equal(startingReset(undefined, 'starting'), true, 'an app start enters starting and clears the lane');
  assert.equal(startingReset('idle', 'starting'), true, 'a new Live session enters starting and clears the lane');
  assert.equal(startingReset('starting', 'starting'), false, 'a second starting frame clears nothing again');
  for (const state of ['live', 'idle', 'stopping', 'error'] as const) assert.equal(startingReset('idle', state), false, state);
});

// U-k3: the live tool steps under the orb. One line per source, what it is reading and on what,
// then how it ended. The mini orb shows no text beyond its one caption.
const stepsOf = (steps: LiveCurrent['steps']): LiveCurrent => ({
  state: 'thinking', cursor: 0,
  entries: [{ seq: 1, kind: 'toolCall', tool: { name: 'research', status: 'called' } }],
  steps,
});

test('the voice view lists each source being read, with its subject, then its result', () => {
  const html = liveMarkup(stepsOf([
    { callId: 'c1', stepId: 's1', source: 'chat', action: 'search', subject: 'release freeze, last 7 days', phase: 'start' },
    { callId: 'c1', stepId: 's2', source: 'mail', action: 'search', subject: 'release freeze', phase: 'start' },
    { callId: 'c1', stepId: 's1', source: 'chat', action: 'search', subject: 'release freeze, last 7 days', phase: 'end', resultCount: 13, ok: true },
  ]));
  assert.match(html, /data-seg="steps"/);
  assert.match(html, /Searching your mail: release freeze/);
  assert.match(html, /Mattermost: 13 messages/, 'the answered source reports its own count');
  assert.match(html, /step-done/, 'a done source carries a quiet done mark');
  assert.equal(html.includes('Searching Mattermost: release freeze, last 7 days'), false, 'the end step replaces its start line in place');
  assert.equal((html.match(/Mattermost/g) ?? []).length, 1, 'one line per source, never a start line beside its own end');
});

test('a source that failed or timed out says so plainly', () => {
  const html = liveMarkup(stepsOf([
    { callId: 'c1', stepId: 's1', source: 'calendar', action: 'read', subject: 'this week', phase: 'start' },
    { callId: 'c1', stepId: 's1', source: 'calendar', action: 'read', subject: 'this week', phase: 'end', ok: false },
  ]));
  assert.match(html, /Calendar did not answer/);
  assert.match(html, /step-failed/);
  assert.equal(html.includes('this week'), false, 'the failed line replaces its start line, subject and all');
});

test('the step list dims once she starts answering, and carries nothing while nothing runs', () => {
  const steps: LiveCurrent['steps'] = [{ callId: 'c1', stepId: 's1', source: 'chat', action: 'search', subject: 'release freeze', phase: 'end', resultCount: 2, ok: true }];
  assert.equal(stepsFading({ ...stepsOf(steps), state: 'thinking' }), false);
  assert.match(stepListMarkup({ ...stepsOf(steps), state: 'speaking' }), /feed-steps-out/);
  assert.doesNotMatch(stepListMarkup({ ...stepsOf(steps), state: 'thinking' }), /feed-steps-out/);
  assert.equal(stepListMarkup(undefined), '');
  assert.equal(stepListMarkup(stepsOf([])), '');
});

test('F1 the dimmed list stays dimmed once the answer has started, whatever the state says', () => {
  const steps: LiveCurrent['steps'] = [{ callId: 'c1', stepId: 's1', source: 'chat', action: 'search', subject: 'release freeze', phase: 'end', resultCount: 13, ok: true }];
  for (const state of ['speaking', 'listening', 'thinking', 'idle', 'ended'] as const) {
    const live: LiveCurrent = { ...stepsOf(steps), state, entries: [{ seq: 2, kind: 'outputTranscription', text: 'Thirteen messages about the freeze.' }] };
    assert.equal(stepsAnswered(live), true, state);
    assert.equal(stepsFading(live), true, state);
    assert.match(stepListMarkup(live), /feed-steps-out/, state);
  }
  // A new tool turn resets it: the answer of the previous turn does not dim the next read.
  const fresh: LiveCurrent = { ...stepsOf(steps), state: 'thinking', entries: [
    { seq: 2, kind: 'outputTranscription', text: 'Thirteen messages about the freeze.' },
    { seq: 3, kind: 'toolCall', tool: { name: 'mattermost_search', status: 'called' } },
  ] };
  assert.equal(stepsAnswered(fresh), false);
  assert.equal(stepsFading(fresh), false);
});

test('the mini orb renders no step lines, only its one caption', () => {
  const live = stepsOf([
    { callId: 'c1', stepId: 's1', source: 'chat', action: 'search', subject: 'release freeze', phase: 'start' },
    { callId: 'c1', stepId: 's1', source: 'chat', action: 'search', subject: 'release freeze', phase: 'end', resultCount: 13, ok: true },
  ]);
  const mini = miniMarkup(miniState('PROCESSING', liveActivity(live)), 'Searching your mail');
  assert.equal(mini.includes('data-seg="steps"'), false, 'the mini route never renders the step list');
  assert.equal(mini.includes('Mattermost'), false, 'no source line and no count reaches the mini orb');
  assert.equal(mini.includes('release freeze'), false, 'no subject reaches the mini orb');
  assert.match(liveMarkup(live), /Mattermost: 13 messages/, 'the full view is where the steps live');
});

// --- Release 3p: the orb, its label and the control answer a Stop press at once ----------------
import { initialLiveView, machineOwnsOrb as ownsOrb, liveControl as controlOf } from '../src/live-view.ts';
import type { NativeLiveError, NativeLiveState } from '../src/native-bridge.ts';

/** main.ts's real orb state, orb label and control markup, run with only the state they read. */
function orbUnder(machine: NativeLiveState, projection: LiveCurrent['state'] | undefined, extra: { stateError?: NativeLiveError } = {}) {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const line = (marker: string) => { const start = source.indexOf(marker); assert.ok(start > 0, marker); return source.slice(start, source.indexOf('\n', start)); };
  const between = (from: string, to: string) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start > 0 && end > start, `${from} .. ${to}`); return source.slice(start, end); };
  const context: any = {
    connection: 'Ready', pairingRequired: false, miniRoute: false, orbSurfaceVisible: () => true,
    live: projection ? { state: projection, cursor: 0, entries: [] } : undefined,
    liveMachine: { view: { ...initialLiveView(), state: machine, error: extra.stateError } },
    liveVoiceState, liveLabel: (current: LiveCurrent) => liveLabel(current), busy: false, error: undefined,
    connectingBeforeFirstSpeech,
    connectedView: { active: false }, e: (text: string) => text, lookupLineMarkup: () => '',
    machineOwnsOrb: ownsOrb, liveControl: controlOf, startAvailable, liveErrorText,
  };
  createContext(context);
  // The slices are TypeScript, so the annotations come off before the vm runs them.
  runInContext(transpileModule(
    [line('const LIVE_COPY'), line('function liveStateCopy'), between('function orbState():', 'function orbLabel('),
      between('function orbStateLineMarkup(', 'function orbControlsMarkup('),
      between('function orbControlsMarkup(', 'function orbCaptionMarkup(')].join('\n'),
    { compilerOptions: { target: ScriptTarget.ES2020 } },
  ).outputText, context);
  return context as { orbState(): string; orbStateLineMarkup(): string; orbControlsMarkup(): string };
}

test('the machine owns the orb while stopping, idle or error, and the projection only while live or muted', () => {
  const at = (state: NativeLiveState) => ownsOrb({ ...initialLiveView(), state });
  for (const state of ['stopping', 'idle', 'error'] as const) assert.equal(at(state), true, state);
  for (const state of ['live', 'muted', 'starting'] as const) assert.equal(at(state), false, state);
});

test('a Stop press changes the orb label before the server projection catches up', () => {
  const stopping = orbUnder('stopping', 'speaking');
  assert.equal(stopping.orbStateLineMarkup(), 'Stopping', 'the press is on screen, not the stale projection');
  assert.equal(stopping.orbState(), 'CONNECTED', 'the orb leaves the speaking look on the press');
  const idle = orbUnder('idle', 'speaking');
  assert.equal(idle.orbStateLineMarkup(), 'Live is off', 'a stale speaking projection never outlives the session');
  assert.equal(idle.orbState(), 'CONNECTED', 'the idle orb stays the idle orb');
});

test('a live machine still lets the projection name what Naya is doing', () => {
  const live = orbUnder('live', 'thinking');
  assert.equal(live.orbStateLineMarkup(), 'Thinking', 'unchanged behaviour while the machine is live');
  assert.equal(live.orbState(), liveVoiceState('thinking'));
});

test('a failed stop shows the error state and offers Start again', () => {
  const failed = orbUnder('error', 'speaking', { stateError: 'micDenied' });
  assert.equal(failed.orbState(), 'ERROR');
  assert.equal(failed.orbStateLineMarkup(), 'Needs your attention');
  assert.match(failed.orbControlsMarkup(), /id="voice-start"/);
  assert.match(failed.orbControlsMarkup(), /Microphone access is blocked/);
});

test('the Start/Stop control follows the machine, so the press flips it before the server replies', () => {
  const at = (state: NativeLiveState) => controlOf({ ...initialLiveView(), state });
  assert.equal(at('live'), 'stop'); assert.equal(at('muted'), 'stop'); assert.equal(at('starting'), 'stop');
  assert.equal(at('stopping'), 'stopping');
  assert.equal(at('idle'), 'start'); assert.equal(at('error'), 'start');
});

test('the button label and pressed state flip on the press and return to Start at idle', () => {
  assert.match(orbUnder('live', 'listening').orbControlsMarkup(), /id="voice-stop" class="stop-pill" aria-pressed="true">Stop</);
  const pressed = orbUnder('stopping', 'speaking').orbControlsMarkup();
  assert.match(pressed, />Stopping</, 'the press names what is happening');
  assert.doesNotMatch(pressed, /aria-pressed="true">Stop/, 'the control no longer claims the call is on');
  assert.match(orbUnder('idle', 'speaking').orbControlsMarkup(), /id="voice-start"[^>]*aria-pressed="false"[^>]*>Start</,
    'Start comes back though the projection still says speaking');
});

test('D6: the main window paints the orb through the shared debounce, never a raw state', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ createStateDebounce \} from '\.\/orb-states'/, 'main.ts imports the mini pill debounce');
  assert.match(source, /orbReveal\.request\(orbState\(\), at\)/, 'every paint requests through it');
  assert.match(source, /orbReveal\.settled\(at\)/, 'and paints only the settled state');
  assert.equal(source.includes('appliedOrbState=next;orb?.setState(next)'), false, 'no un-debounced set remains');
});

// W3 requirement 4: when the internet is the reason the owner is told, in the existing caption text.
test('a weak uplink is named in the caption, and an uplink-starved end names the internet, not the model', () => {
  const speaking: LiveCurrent = { state: 'speaking', cursor: 1, entries: [{ seq: 1, kind: 'outputTranscription', text: 'Hi there' }] };
  const withConnection = (connection: unknown, state: LiveCurrent['state'] = 'speaking') => ({ ...speaking, state, connection } as LiveCurrent);
  assert.equal(liveLabel(withConnection({ quality: 'weak', uploadKbps: 380 })), 'Weak internet, Naya may not hear you clearly (upload about 380 kbit/s)');
  assert.equal(liveLabel(withConnection({ quality: 'ok', uploadKbps: 380 })), 'Speaking', 'a healthy link says nothing new');
  assert.equal(liveLabel(speaking), 'Speaking');
  assert.equal(liveLabel(withConnection({ quality: 'weak' })), 'Weak internet, Naya may not hear you clearly', 'no number when none was measured');
  assert.equal(liveLabel(withConnection({ quality: 'weak', uploadKbps: 380 }, 'rebuilding')), 'Reconnecting to the voice service', 'reconnecting keeps its own words');
  assert.equal(liveLabel(withConnection({ quality: 'weak', uploadKbps: 12, endedCode: 'uplink_starved' }, 'ended')), 'Call ended: the internet upload was too weak for voice');
});
