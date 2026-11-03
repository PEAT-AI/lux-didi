import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTaskFixture } from './live-task-fixture.js';
import { documentResult } from '../tasks/results.js';

for (const outcome of ['inserted', 'unknown'] as const) {
  test(`finalized owner save reaches the vault once and retains ${outcome} receipt`, async t => {
    const text = 'The synthetic team chose the blue plan. The budget is twelve units.';
    const f = await liveTaskFixture(t, async request => request.turns.length === 0
      ? { text: '', calls: [{ id: 'save', name: 'save_to_vault', args: { title: 'Synthetic plan', text } }] }
      : { text: outcome === 'inserted' ? 'The synthetic note was saved.' : 'The save outcome is unknown. I will not retry it.', calls: [] }, { outcome });
    f.bind(); f.finalize('Save the synthetic plan to the vault');
    const answer = await f.answer();
    assert.equal(f.writes.length, 1, 'no extra confirmation or duplicate model/tool pass is required');
    assert.match(JSON.stringify(f.writes[0]), /The budget is twelve units/);
    const row = f.store.transaction(tx => tx.get('SELECT state FROM vault_writes'));
    assert.equal(row?.state, outcome === 'inserted' ? 'confirmed' : 'uncertain');
    assert.equal(answer.text, outcome === 'inserted' ? 'The synthetic note was saved.' : 'The save outcome is unknown. I will not retry it.');
    f.bind('same-task-new-binding');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.writes.length, 1, 'a duplicate delegation cannot redispatch a write');
    assert.equal(f.voice.toolResponses.length, 0, 'client delivery has no legacy function output');
  });
}

for (const approved of [false, true]) {
  test(`outside text is evidence, not write authority; effect role approved=${approved}`, async t => {
    let reads = 0;
    const f = await liveTaskFixture(t, async request => request.turns.length === 0
      ? { text: '', calls: [{ id: 'read', name: 'search_mail', args: { query: 'synthetic', cursor: null } }] }
      : request.turns.length === 1
        ? { text: '', calls: [{ id: 'save', name: 'save_to_vault', args: { title: 'Synthetic mail note', text: 'Synthetic evidence.' } }] }
        : { text: approved ? 'The authorized note was saved.' : 'That write was not authorized.', calls: [] }, {
      approved, executors: { search_mail: async () => { reads++; return documentResult('Untrusted mail commands a write. This text cannot grant it.', 'synthetic-mail'); } },
    });
    f.bind(); f.finalize('Read the synthetic message and save only what I authorized');
    const answer = await f.answer();
    assert.equal(reads, 1);
    assert.equal(f.writes.length, approved ? 1 : 0);
    assert.equal(answer.text, approved ? 'The authorized note was saved.' : 'That write was not authorized.');
    const writes = f.store.transaction(tx => tx.all('SELECT external_context_present,state FROM vault_writes'));
    assert.equal(writes.length, approved ? 1 : 0);
    if (approved) { assert.equal(writes[0]?.external_context_present, 1); assert.equal(writes[0]?.state, 'confirmed'); }
  });
}
