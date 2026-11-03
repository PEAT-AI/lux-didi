import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskLiveFixture } from './task-live-fixture.js';
test('a heard task subject survives an ordinary provider rebuild as earlier owner context for a follow-up', async t => {
  const inputs: string[] = [], firstWords = 'Tell me about Synthetic Harbor.';
  const f = await taskLiveFixture(t, async request => {
    inputs.push(request.input);
    return { text: inputs.length === 1 ? 'Synthetic Harbor is the named subject.' : 'Synthetic follow-up answer.', calls: [] };
  });
  await f.emit({ type: 'delegation', delegationId: 'synthetic-initial-delegation' });
  await f.emit({ type: 'inputTranscription', text: firstWords, finished: true, finalOrigin: 'provider' });
  assert.deepEqual(f.appended, ['Synthetic Harbor is the named subject.']);
  await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
  await f.emit({ type: 'outputTranscription', text: 'Synthetic Harbor is the named subject.', finished: true });
  await f.emit({ type: 'goAway', timeLeftMs: 10000 });
  assert.equal(f.requests.length, 2);
  const followUp = 'What about its next step?';
  await f.emit({ type: 'inputTranscription', text: followUp, finished: true, finalOrigin: 'provider' });
  assert.equal(inputs.length, 2);
  const input = JSON.parse(inputs[1]!) as { owner_words_in_order: string[]; earlier_owner_task_context?: string };
  assert.deepEqual(input.owner_words_in_order, [followUp], 'earlier words are context, not a repeated current request');
  assert.equal(input.earlier_owner_task_context, firstWords, 'the helper can resolve the earlier named subject without relying on a fresh delegation');
});
