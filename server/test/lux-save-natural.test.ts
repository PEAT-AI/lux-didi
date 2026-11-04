import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { fixtureUntil } from './live-voice-fixture.js';

for (const call of ['save_to_vault', 'remember_note'] as const) {
  test(`natural finalized words reach ${call} through task inference and persist the full note`, async t => {
    const body = `Synthetic dictated note. ${'Full retained evidence. '.repeat(40)}`.trim();
    let inputs = '';
    const f = await liveTaskFixture(t, async request => {
      inputs = request.input;
      return request.turns.length === 0
        ? { text: '', calls: [{ id: 'local-note', name: call, args: call === 'save_to_vault' ? { title: 'Synthetic note', text: body } : { text: body } }] }
        : { text: call === 'save_to_vault' ? 'The full synthetic note is saved to the configured vault.' : 'The full synthetic note is remembered locally.', calls: [] };
    });
    f.bind(); f.finalize('Remember this synthetic note');
    const answer = await f.answer();
    const rows = f.store.transaction(tx => tx.all('SELECT text FROM entries'));
    assert.equal(rows.length, call === 'save_to_vault' ? 0 : 1);
    if (call === 'remember_note') assert.equal(rows[0]?.text, body, 'the speech chunk limit is not a retained-note truncation limit');
    else assert.equal((f.writes[0] as { content: string } | undefined)?.content, body, 'the actual vault transport receives the full note');
    assert.match(inputs, /Remember this synthetic note/);
    assert.equal(f.writes.length, call === 'save_to_vault' ? 1 : 0, 'vault writes and local memory remain distinct destinations');
    assert.equal(answer.text, call === 'save_to_vault' ? 'The full synthetic note is saved to the configured vault.' : 'The full synthetic note is remembered locally.');
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
