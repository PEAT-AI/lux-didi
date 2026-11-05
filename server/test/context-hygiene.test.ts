import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { fixtureUntil, deferred } from './live-voice-fixture.js';
import { documentResult } from '../tasks/results.js';
import { commentaryResults } from './commentary-test.js';

// Retrieved work lives in the host task, not in a provider research-context byte counter.
test('host task context carries captured evidence and continuation into the next worker step', async t => {
  const inputs: string[] = [], outputs: string[] = [];
  const f = await liveTaskFixture(t, async request => {
    inputs.push(request.input); outputs.push(JSON.stringify(request.outputs));
    return inputs.length === 1 ? { text: '', calls: [{ id: 'synthetic-search_knowledge',  name: 'search_knowledge', args: { query: 'synthetic context' } }] }
      : { text: 'The synthetic context is retained.', calls: [] };
  }, { executors: { search_knowledge: async () => ({ ...documentResult('Synthetic captured context record.', 'synthetic-context'), next_cursor: 'synthetic-next-page' }) } });
  f.bind(); f.finalize('Find the synthetic context record.');
  assert.equal((await f.answer()).text, 'The synthetic context is retained.');
  assert.equal(inputs.length, 2);
  assert.match(outputs[1]!, /Synthetic captured context record/);
  assert.equal(inputs[1]!.includes('Synthetic captured context record'), false, 'outside text stays in tool output, not owner instructions');
  assert.match(outputs[1]!, /synthetic-next-page/);
  assert.equal(f.voice.sessionsOpened, 1, 'the helper evidence does not manufacture a voice context rebuild');
});

test('task persistence correlates the worker revision and each operation without provider call ids', async t => {
  let steps = 0;
  const f = await liveTaskFixture(t, async () => ++steps === 1
    ? { text: '', calls: [{ id: 'synthetic-save_to_vault',  name: 'save_to_vault', args: { title: 'Synthetic context', text: 'Synthetic retained note.' } }] }
    : { text: 'The synthetic note is staged locally.', calls: [] });
  f.bind(); f.finalize('Stage a synthetic local note.'); await f.answer();
  const operations = f.store.transaction(tx => tx.all('SELECT task_id,task_revision,operation_id,tool FROM task_operations'));
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.tool, 'save_to_vault');
  assert.match(String(operations[0]?.task_id), /^[a-f0-9-]{36}$/);
  assert.match(String(operations[0]?.operation_id), /^[a-f0-9-]{36}$/);
  const revision = f.store.transaction(tx => tx.get('SELECT task_id,task_revision FROM task_revisions'));
  assert.equal(operations[0]?.task_id, revision?.task_id);
  assert.equal(operations[0]?.task_revision, revision?.task_revision);
});

test('a pending helper does not rebuild, emit progress filler or repeat inference at voice turn boundaries', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The synthetic work is complete.', calls: [] }; });
  f.bind(); f.finalize('Do the synthetic work.'); await fixtureUntil(() => calls === 1, 'pending helper');
  f.voice.emit({ type: 'generationComplete' }); f.voice.emit({ type: 'turnComplete' }); await f.flush();
  assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.taskAnswers.length, 0); assert.equal(f.voice.texts.length, 0);
  release.resolve(); assert.equal((await f.answer()).text, 'The synthetic work is complete.'); assert.equal(calls, 1);
});

test('newer owner words supersede pending work while retaining their ordered context', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); const inputs: string[] = [];
  const f = await liveTaskFixture(t, async request => {
    inputs.push(request.input);
    if (inputs.length === 1) { await release.promise; return { text: 'The superseded synthetic result.', calls: [] }; }
    return { text: 'The corrected synthetic result.', calls: [] };
  });
  f.bind('original'); f.finalize('Use the original synthetic selection.'); await fixtureUntil(() => inputs.length === 1, 'first owner revision');
  f.bind('corrected'); f.finalize('Correction: use the second synthetic selection.');
  await fixtureUntil(() => inputs.length === 2, 'corrected owner revision');
  assert.ok(inputs[1]!.indexOf('original synthetic selection') < inputs[1]!.indexOf('second synthetic selection'));
  release.resolve(); assert.equal((await f.answer()).text, 'The corrected synthetic result.'); await f.flush();
  const envelopes = commentaryResults(f.voice.taskAnswers);
  assert.equal(envelopes.length, 1); assert.equal(envelopes[0]?.delegationId, 'corrected');
});
