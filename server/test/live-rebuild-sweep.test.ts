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
    f.voice.emit({ type: 'goAway', timeLeftMs: 0 });
    await fixtureUntil(() => f.voice.sessionsOpened === 2, 'fresh boundary socket');
    f.bind('fresh-binding'); await f.flush();
    if (boundary === 'before input') f.finalize('Find the synthetic boundary result.');
    release.resolve();
    const answer = await f.answer();
    assert.equal(answer.delegationId, 'fresh-binding'); assert.equal(answer.text, 'The retained synthetic boundary result.');
    assert.equal(inferences, 1, 'rebuilding transport must not repeat the worker');
    assert.equal(f.voice.taskAnswers.length, 1, 'no stale-socket append');
  });
}

for (const boundary of ['sent', 'accepted', 'partly heard']) {
  test(`task rebuild boundary: ${boundary} resends the held result, never its work`, async t => {
    let inferences = 0;
    const f = await liveTaskFixture(t, async () => { inferences++; return { text: 'The complete synthetic boundary answer.', calls: [] }; });
    f.bind('old-binding'); f.finalize('Give the synthetic boundary answer.'); const first = await f.answer();
    if (boundary !== 'sent') f.voice.emit({ type: 'commentaryAccepted', commandId: first.commandId });
    if (boundary === 'partly heard') f.voice.emit({ type: 'outputTranscription', text: 'The complete', finished: false });
    await f.flush(); f.voice.emit({ type: 'goAway', timeLeftMs: 0 });
    await fixtureUntil(() => f.voice.sessionsOpened === 2, 'fresh answer socket');
    f.bind('fresh-binding');
    await fixtureUntil(() => f.voice.taskAnswers.length === 2, 'held result on fresh binding');
    assert.equal(f.voice.taskAnswers[1]?.delegationId, 'fresh-binding');
    assert.equal(f.voice.taskAnswers[1]?.text, first.text); assert.equal(inferences, 1);
  });
}

test('task rebuild boundary: a heard result is conversation history, not a second answer', async t => {
  let inferences = 0;
  const f = await liveTaskFixture(t, async () => { inferences++; return { text: 'The synthetic result is already heard.', calls: [] }; });
  f.bind('heard-binding'); f.finalize('Give the synthetic result.'); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId });
  f.voice.emit({ type: 'outputTranscription', text: answer.text, finished: true }); f.voice.emit({ type: 'turnComplete' }); await f.flush();
  f.voice.emit({ type: 'goAway', timeLeftMs: 0 }); await fixtureUntil(() => f.voice.sessionsOpened === 2, 'post-heard socket');
  f.bind('fresh-binding'); await f.flush();
  assert.equal(f.voice.taskAnswers.length, 1); assert.equal(inferences, 1);
  assert.match(JSON.stringify(f.voice.requests[1]?.history), /synthetic result is already heard/);
});

test('task rebuild boundary: a finished unbound result reconnects with its answer, not a new inference', async t => {
  let inferences = 0;
  const f = await liveTaskFixture(t, async () => { inferences++; return { text: 'Read this retained synthetic answer.', calls: [] }; });
  f.finalize('Give the retained synthetic answer.');
  await fixtureUntil(() => f.voice.sessionsOpened === 2, 'finished-result reconnect');
  assert.match(f.voice.requests[1]!.system.text, /Read this retained synthetic answer/);
  assert.equal(inferences, 1); assert.equal(f.voice.taskAnswers.length, 0, 'a fresh seed is not an append to the dead binding');
});

test('task rebuild boundary: closing the consumer cancels late delivery and leaves no worker rerun', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let inferences = 0;
  const f = await liveTaskFixture(t, async () => { inferences++; await release.promise; return { text: 'A late synthetic answer.', calls: [] }; });
  f.bind(); f.finalize('Start the synthetic pending task.'); await fixtureUntil(() => inferences === 1, 'consumer-close pending task');
  f.attachment.close(); await fixtureSettled(f.attachment.done, 'consumer-close terminal receipt');
  release.resolve(); await f.flush();
  assert.equal(f.voice.taskAnswers.length, 0); assert.equal(inferences, 1); assert.equal(f.voice.closes, 1);
});
