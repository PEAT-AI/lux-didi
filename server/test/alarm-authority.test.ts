import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlarmOwnerGate } from '../tools/alarm.js';

for (const [operation, words] of [
  ['set_alarm', 'wake me at 8'], ['cancel_alarm', 'cancel my alarm'], ['snooze_alarm', 'snooze my alarm for five minutes'],
] as const) {
  test(`alarm authority: ${operation} requires a fresh finalized owner ask`, () => {
    const gate = new AlarmOwnerGate();
    const now = 1000000;
    // Model text, host notes and alarm prompts never call observeOwnerFinal.
    assert.equal(gate.authorize('synthetic', operation, now), undefined);
    gate.observeOwnerFinal('synthetic', 'j1', words, now);
    assert.equal(gate.authorize('synthetic', operation, now)?.words, words);
    assert.equal(gate.authorize('other-session', operation, now), undefined);
    assert.equal(gate.authorize('synthetic', operation, now + 120001), undefined);
    gate.observeOwnerFinal('synthetic', 'j2', 'what is the weather', now + 120002);
    gate.observeOwnerFinal('synthetic', 'j3', 'and tomorrow', now + 120003);
    assert.equal(gate.authorize('synthetic', operation, now + 120003), undefined);
  });
}

test('alarm authority: split finalized turns join, but consumed asks cannot authorize another mutation', () => {
  const gate = new AlarmOwnerGate();
  gate.observeOwnerFinal('s', 'j1', 'wake me', 1000);
  gate.observeOwnerFinal('s', 'j2', 'at eight tomorrow morning', 2000);
  const ask = gate.authorize('s', 'set_alarm', 2000);
  assert.equal(ask?.words, 'wake me at eight tomorrow morning');
  assert.equal(ask?.journalId, 'j2');
  gate.consume('s', 'j2');
  assert.equal(gate.authorize('s', 'set_alarm', 2001), undefined);
  gate.observeOwnerFinal('s', 'j3', 'cancel the alarm', 2002);
  assert.ok(gate.authorize('s', 'cancel_alarm', 2002));
});
