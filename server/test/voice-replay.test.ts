import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { deferred, fixtureUntil } from './live-voice-fixture.js';
import { documentResult, failed } from '../tasks/results.js';
import { sanitize } from './voice-replay/sanitize.js';

// Replay the host task lifecycle, not the removed provider response/tool continuation engine.
test('task replay: silent fill and native turn boundaries cannot settle pending work', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; await release.promise; return { text: 'The pending synthetic result.', calls: [] }; });
  f.finalize('Find the synthetic result.'); f.bind(); await fixtureUntil(() => calls === 1, 'replay pending inference');
  f.voice.emit({ type: 'audio', pcm: new Uint8Array(960), rate: 24000, audible: false });
  f.voice.emit({ type: 'generationComplete' }); f.voice.emit({ type: 'turnComplete' }); await f.flush();
  assert.equal(f.voice.taskAnswers.length, 0); assert.equal(calls, 1);
  release.resolve(); assert.equal((await f.answer()).text, 'The pending synthetic result.');
});

test('task replay: barge-in and finalized correction replace the stale result with one current answer', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let calls = 0;
  const f = await liveTaskFixture(t, async () => {
    if (++calls === 1) { await release.promise; return { text: 'The stale synthetic answer.', calls: [] }; }
    return { text: 'The corrected synthetic answer.', calls: [] };
  });
  f.finalize('Use the first synthetic selection.'); f.bind('old'); await fixtureUntil(() => calls === 1, 'old inference');
  f.voice.emit({ type: 'interrupted' }); f.voice.emit({ type: 'inputTranscription', text: 'Correction', finished: false }); await f.flush();
  f.finalize('Correction: use the second synthetic selection.'); f.bind('new');
  assert.equal((await f.answer()).text, 'The corrected synthetic answer.'); release.resolve(); await f.flush();
  assert.equal(f.voice.taskAnswers.length, 1); assert.equal(f.voice.taskAnswers[0]?.delegationId, 'new');
});

test('task replay: parallel reads with mixed outcomes preserve both operations and produce one answer', async t => {
  const release = deferred<void>(); t.after(() => release.resolve()); let steps = 0, reads = 0;
  const f = await liveTaskFixture(t, async () => ++steps === 1
    ? { text: '', calls: [{ id: 'synthetic-search_knowledge',  name: 'search_knowledge', args: { query: 'synthetic parallel' } }, { id: 'synthetic-read_mail',  name: 'read_mail', args: { id: 'synthetic-mail', cursor: null } }] }
    : { text: 'One synthetic source was available; the other failed.', calls: [] }, { executors: {
      search_knowledge: async () => { reads++; await release.promise; return documentResult('Synthetic knowledge evidence.', 'synthetic-knowledge'); },
      read_mail: async () => { reads++; release.resolve(); return failed('Synthetic mail source refused the read.'); },
    } });
  f.finalize('Compare the two synthetic sources.'); f.bind(); await f.answer();
  assert.equal(reads, 2); assert.equal(f.voice.taskAnswers.length, 1);
  const rows = f.store.transaction(tx => tx.all('SELECT tool,state FROM task_operations ORDER BY tool'));
  assert.deepEqual(rows.map(row => [row.tool, row.state]), [['read_mail', 'failed'], ['search_knowledge', 'committed']]);
});

test('task replay: a newer completed owner turn starts fresh work rather than repeating an old result', async t => {
  let steps = 0, reads = 0;
  const f = await liveTaskFixture(t, async () => {
    steps++;
    return steps % 2 ? { text: '', calls: [{ id: 'synthetic-search_knowledge',  name: 'search_knowledge', args: { query: steps === 1 ? 'first synthetic query' : 'second synthetic query' } }] }
      : { text: steps === 2 ? 'The first synthetic answer.' : 'The second synthetic answer.', calls: [] };
  }, { executors: { search_knowledge: async () => { reads++; return documentResult('Synthetic evidence.', `synthetic-${reads}`); } } });
  f.finalize('Find the first synthetic record.'); f.bind('first'); const first = await f.answer();
  f.voice.emit({ type: 'outputTranscription', text: first.text, finished: true }); f.voice.emit({ type: 'turnComplete' }); await f.flush();
  f.finalize('Find the second synthetic record.'); f.bind('second'); await fixtureUntil(() => f.voice.taskAnswers.length === 2, 'second owner answer');
  assert.equal(f.voice.taskAnswers[1]?.text, 'The second synthetic answer.'); assert.equal(reads, 2);
});

test('task replay: duplicate bindings and acknowledgements do not repeat task work or its append', async t => {
  let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; return { text: 'The synthetic deduplicated answer.', calls: [] }; });
  f.bind('same'); f.finalize('Give the synthetic deduplicated answer.'); f.bind('same'); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId });
  f.voice.emit({ type: 'generationComplete' }); f.voice.emit({ type: 'turnComplete' }); f.bind('same'); await f.flush();
  assert.equal(calls, 1); assert.equal(f.voice.taskAnswers.length, 1);
});

test('task replay: the worker result does not wait for a provider inference terminal event', async t => {
  const f = await liveTaskFixture(t, async () => ({ text: 'The synthetic terminal-independent answer.', calls: [] }));
  f.finalize('Give the synthetic answer.'); f.bind();
  assert.equal((await f.answer()).text, 'The synthetic terminal-independent answer.');
  assert.equal(f.voice.toolResponses.length, 0); assert.equal(f.voice.texts.length, 0);
});

test('task replay: repeated rejection fails on the same line; stale acknowledgements never rerun work', async t => {
  let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; return { text: 'The synthetic retained answer.', calls: [] }; }, { clock: true });
  f.finalize('Give the synthetic retained answer.'); f.bind('old'); const answer = await f.answer();
  f.voice.emit({ type: 'commentaryRejected', commandId: answer.commandId }); await fixtureUntil(() => f.voice.taskAnswers.length === 2, 'one bounded append retry');
  f.voice.emit({ type: 'commentaryRejected', commandId: f.voice.taskAnswers[1]!.commandId }); await f.flush();
  f.voice.emit({ type: 'commentaryRejected', commandId: answer.commandId }); f.voice.emit({ type: 'commentaryAccepted', commandId: answer.commandId }); await f.flush();
  t.mock.timers.tick(15_000); await f.flush();
  assert.equal(calls, 1); assert.equal(f.voice.sessionsOpened, 1); assert.equal(f.voice.taskAnswers.length, 2);
});

for (const noAction of [false, true]) {
  test(`task replay: worker failure is explicit and no-action releases an open delegation; noAction=${noAction}`, async t => {
    let calls = 0;
    const f = await liveTaskFixture(t, async () => { calls++; if (!noAction) throw new Error('SYNTHETIC_RAW_PROVIDER_ERROR'); return { text: '', calls: [], no_action: true }; });
    f.finalize('Handle the synthetic request.'); f.bind();
    if (noAction) { await f.flush(); await fixtureUntil(() => f.store.transaction(tx => tx.get('SELECT status FROM tasks'))?.status === 'no_action', 'no-action terminal worker'); await f.flush(); assert.equal(f.voice.taskAnswers.length, 1); assert.match(f.voice.taskAnswers[0]!.text, /No lookup is needed/); }
    else { await fixtureUntil(() => f.store.transaction(tx => tx.get('SELECT status FROM tasks'))?.status === 'incomplete', 'failed worker terminal disposition'); const answer = await f.answer(); assert.ok(answer.text.length > 0 && answer.text.length <= 450); assert.equal(answer.text.includes('SYNTHETIC_RAW_PROVIDER_ERROR'), false); }
    assert.equal(calls, 1);
    assert.equal(f.store.transaction(tx => tx.get('SELECT status FROM tasks'))?.status, noAction ? 'no_action' : 'incomplete');
  });
}

test('task replay: helper completion preserves PCM order through the host output stream', async t => {
  const f = await liveTaskFixture(t, async () => ({ text: 'The synthetic spoken answer.', calls: [] }));
  f.finalize('Speak the synthetic answer.'); f.bind(); await f.answer();
  f.voice.emit({ type: 'audio', pcm: new Uint8Array([0x40, 0x1f]), rate: 24000, audible: true });
  f.voice.emit({ type: 'audio', pcm: new Uint8Array([0x28, 0x23]), rate: 24000, audible: true }); f.voice.emit({ type: 'turnComplete' }); await f.flush();
  const bytes = f.chunks.flatMap(chunk => chunk.kind === 'audio' ? [...chunk.pcm] : []);
  assert.deepEqual(bytes, [0x40, 0x1f, 0x28, 0x23]);
});

test('task replay host: bracket cues are omitted while literal citations remain byte-identical', async t => {
  const f = await liveTaskFixture(t, async () => ({ text: '', calls: [], no_action: true }));
  f.voice.emit({ type: 'outputTranscription', text: '[chuckle]', finished: false });
  f.voice.emit({ type: 'outputTranscription', text: ' okay [Q3]', finished: true });
  await fixtureUntil(() => f.chunks.some(chunk => chunk.kind === 'marker' && chunk.marker.kind === 'outputTranscription' && chunk.marker.text?.includes('[Q3]')), 'literal citation transcript');
  const said = f.chunks.flatMap(chunk => chunk.kind === 'marker' && chunk.marker.kind === 'outputTranscription' ? [chunk.marker.text ?? ''] : []).join('');
  assert.equal(said.includes('chuckle'), false); assert.equal(said, ' okay [Q3]');
});
test('the sanitizer replaces every free text field and keeps the frame order and the provider identifiers', () => {
  const recorded = [
    { at_ms: 0, direction: 'in', event: { type: 'session.input_transcript.delta', delta: 'She said my private words', start_ms: 0, end_ms: 900 } },
    { at_ms: 1_000, direction: 'in', event: { type: 'response.event', delegation_id: 'd_1', event: { type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'search_knowledge', arguments: '{"query":"private query","limit":2}' } } } },
  ];
  const steps = sanitize(recorded);
  const text = JSON.stringify(steps);
  assert.equal(text.includes('private'), false, `a sanitized trace still carries owner words: ${text}`);
  assert.deepEqual(steps.map(step => step.at_ms), [0, 1_000], 'the frame ordering is preserved');
  assert.equal(text.includes('call_1') && text.includes('d_1'), true, 'a provider identifier survives, so a call still joins its output');
  assert.equal((steps[0]!.event as Record<string, unknown>)['start_ms'], 0, 'a numeric field is untouched');
});

test('the sanitizer reads a recorded log as one JSON array and as one frame per line', () => {
  const oneLineEach = [
    '{"at_ms":0,"direction":"in","event":{"type":"session.input_transcript.delta","delta":"owner private words"}}',
    '{"at_ms":900,"direction":"in","event":{"type":"session.started","session":{"id":"sess_1"}}}',
  ].join('\n');
  const steps = sanitize(oneLineEach);
  assert.equal(steps.length, 2, `both frames survived: ${JSON.stringify(steps)}`);
  assert.equal(JSON.stringify(steps).includes('private'), false, 'no owner word survives the line-separated form either');
  assert.deepEqual(steps.map(step => step.at_ms), [0, 900]);
});