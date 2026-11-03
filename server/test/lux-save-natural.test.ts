import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { fixtureUntil } from './live-voice-fixture.js';

for (const call of ['stage_lux_note', 'remember_note'] as const) {
  test(`natural finalized words reach ${call} through task inference and persist the full note`, async t => {
    const body = `Synthetic dictated note. ${'Full retained evidence. '.repeat(40)}`;
    let inputs = '';
    const f = await liveTaskFixture(t, async request => {
      inputs = request.input;
      return request.turns.length === 0
        ? { text: '', calls: [{ id: 'local-note', name: call, args: call === 'stage_lux_note' ? { title: 'Synthetic note', text: body } : { text: body } }] }
        : { text: 'The full synthetic note is staged locally. Nothing was sent.', calls: [] };
    });
    f.bind(); f.finalize('Remember this synthetic note');
    const answer = await f.answer();
    const rows = f.store.transaction(tx => tx.all('SELECT text FROM entries'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.text, body, 'the speech chunk limit is not a retained-note truncation limit');
    assert.match(inputs, /Remember this synthetic note/);
    assert.equal(f.writes.length, 0, 'local staging is not an external vault dispatch');
    assert.equal(answer.text, 'The full synthetic note is staged locally. Nothing was sent.');
  });
}

test('plain conversation still runs one task inference but no action or fabricated result', async t => {
  let calls = 0;
  const f = await liveTaskFixture(t, async () => { calls++; return { text: '', calls: [], no_action: true }; });
  f.bind(); f.finalize('That was a pleasant synthetic conversation.');
  await fixtureUntil(() => calls === 1, 'no-action inference');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.voice.taskAnswers.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.transaction(tx => tx.all('SELECT * FROM entries')).length, 0);
  assert.equal(f.owner.get(f.session.liveSessionId).terminal, null);
});
