import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { deferred, fixtureUntil, fixtureSettled } from './live-voice-fixture.js';

for (const boundary of ['before input', 'pending without a binding', 'pending with an old binding']) {
  test(`task rebuild boundary: ${boundary} retains one inference and answers only the fresh binding`, async t => {
    const release = deferred<void>(); t.after(() => release.resolve()); let inferences = 0;
    const f = await liveTaskFixture(t, async () => { inferences++; await release.promise; return { text: 'The retained synthetic boundary result.', calls: [] }; });
    if (boundary !== 'before input') {
      if (boundary === 'pending with an old binding') f.bind('old-binding');
      f.finalize('Find the synthetic boundary result.'); await fixtureUntil(() => inferences === 1, 'pending boundary inference');
    }
    f.voice.emit({ type: 'goAway', timeLeftMs: 10_000 });
    await fixtureUntil(() => f.voice.sessionsOpened === 2, 'fresh boundary socket');
    f.bind('fresh-binding'); await f.flush();
    if (boundary === 'before input') f.finalize('Find the synthetic boundary result.');
    release.resolve();
    const answer = await f.answer();
    assert.equal(answer.delegationId, 'fresh-binding'); assert.equal(answer.text, 'The retained synthetic boundary result.');
    assert.equal(inferences, 1, 'rebuilding transport must not repeat the worker');
    assert.equal(f.voice.taskAnswers.length, 2, 'no stale-socket append');
  });
}

for (const boundary of ['sent', 'accepted', 'partly heard']) {
  test(`task rebuild boundary: ${boundary} restores complete unfinished envelopes, never repeats work`, async t => {
    let inferences = 0;
    const f = await liveTaskFixture(t, async () => { inferences++; return { text: 'The complete synthetic boundary answer.', calls: [] }; });
    f.finalize('Give the synthetic boundary answer.'); f.bind('old-binding'); const first = await f.answer();
    if (boundary !== 'sent') f.voice.emit({ type: 'commentaryAccepted', commandId: first.commandId });
    if (boundary === 'partly heard') f.voice.emit({ type: 'outputTranscription', text: 'The complete', finished: false });
    await f.flush(); f.voice.emit({ type: 'goAway', timeLeftMs: 10_000 });
    await fixtureUntil(() => f.voice.sessionsOpened === 2, 'fresh answer socket');
    f.bind('fresh-binding'); await f.flush();
    assert.equal(f.voice.taskAnswers.length, boundary === 'sent' ? 3 : 2);
    if (boundary === 'sent') {
      assert.equal(f.voice.taskAnswers[2]?.delegationId, null, 'complete pending envelope restarts on the new line without a delegation');
      assert.equal(f.voice.taskAnswers[2]?.text, f.voice.taskAnswers[0]!.text);
    }
    assert.equal(inferences, 1);
    assert.doesNotMatch(f.voice.requests[1]!.system.text, /first spoken output must be exactly/);
    assert.match(JSON.stringify(f.voice.requests[1]!.history), /synthetic boundary answer/);
  });
}

test('task rebuild boundary: a heard result is conversation history, not a second answer', async t => {
  let inferences = 0;
  const f = await liveTaskFixture(t, async () => { inferences++; return { text: 'The synthetic result is already heard.', calls: [] }; });
  f.finalize('Give the synthetic result.'); f.bind('heard-binding'); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId });
  f.voice.emit({ type: 'outputTranscription', text: answer.text, finished: true }); f.voice.emit({ type: 'turnComplete' }); await f.flush();
  f.voice.emit({ type: 'goAway', timeLeftMs: 10_000 }); await fixtureUntil(() => f.voice.sessionsOpened === 2, 'post-heard socket');
  f.bind('fresh-binding'); await f.flush();
  assert.equal(f.voice.taskAnswers.length, 2); assert.equal(inferences, 1);
  assert.match(JSON.stringify(f.voice.requests[1]?.history), /synthetic result is already heard/);
});

test('task rebuild boundary: a finished unbound result stays on the healthy line', async t => {
  let inferences = 0;
  const f = await liveTaskFixture(t, async () => { inferences++; return { text: 'Read this retained synthetic answer.', calls: [] }; });
  f.finalize('Give the retained synthetic answer.'); const answer = await f.answer();
  assert.equal(f.voice.sessionsOpened, 1); assert.equal(answer.delegationId, null);
  assert.equal(answer.text, 'Read this retained synthetic answer.'); assert.equal(inferences, 1);
});

test('task rebuild boundary: closing the consumer cancels late delivery and leaves no worker rerun', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let inferences = 0;
  const f = await liveTaskFixture(t, async () => { inferences++; await release.promise; return { text: 'A late synthetic answer.', calls: [] }; });
  f.finalize('Start the synthetic pending task.'); f.bind(); await fixtureUntil(() => inferences === 1, 'consumer-close pending task');
  f.attachment.close(); await fixtureSettled(f.attachment.done, 'consumer-close terminal receipt');
  release.resolve(); await f.flush();
  assert.equal(f.voice.taskAnswers.length, 0); assert.equal(inferences, 1); assert.equal(f.voice.closes, 1);
});

test('recovery commentary preserves mid-answer state before the host clears playback', async t => {
  const f = await liveTaskFixture(t, async () => ({ text: 'A synthetic interrupted answer.', calls: [] }));
  f.finalize('Give the synthetic answer.'); f.bind(); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId });
  f.voice.emit({ type: 'modelTurnStarted' });
  f.voice.emit({ type: 'audio', pcm: new Uint8Array(480), rate: 24000, audible: true }); await f.flush();
  f.voice.emit({ type: 'goAway', timeLeftMs: 10000 });
  await fixtureUntil(() => f.voice.sessionsOpened === 2, 'interrupted-answer recovery');
  const opening = f.voice.requests[1]!.openingText!;
  assert.match(opening, /^```COMMENTARY\n/);
  assert.equal(JSON.parse(opening.slice(14, -4)).mid_answer, true);
});
