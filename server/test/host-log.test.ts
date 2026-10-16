import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';

// The known Live instruction section ids, mirrored from ComposedSection.
const SECTIONS = ['voice-head', 'base', 'runtime', 'tools', 'owner-style', 'owner-lore', 'overlay', 'pickup', 'memory', 'voice'];

test('live_instruction_sizes keeps a closed section schema of counts only', () => {
  const event = { event: 'live_instruction_sizes', total: 100, sections: { 'voice-head': 30, base: 70 } };
  assert.deepEqual(safeEvent(event), event);
  assert.equal(safeEvent({ ...event, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...event, sections: { 'unknown-section': 1 } }), undefined, 'an unknown section id is refused');
  assert.equal(safeEvent({ ...event, sections: { base: 'seventy' } }), undefined, 'a non-integer count is refused');
  assert.equal(safeEvent({ ...event, sections: { base: -1 } }), undefined, 'a negative count is refused');
  assert.equal(safeEvent({ ...event, total: 1.5 }), undefined, 'a non-integer total is refused');
  assert.equal(safeEvent({ ...event, total: -1 }), undefined, 'a negative total is refused');
  for (const id of SECTIONS) {
    assert.equal(!!safeEvent({ event: 'live_instruction_sizes', total: 1, sections: { [id]: 1 } }), true, `${id} is a known section id`);
  }
});

test('an accent string never survives the host-log allowlist', () => {
  const accent = 'SYNTHETIC-ACCENT-DESCRIPTION';
  assert.equal(safeEvent({ event: 'live_instruction_sizes', total: 1, sections: { base: 1 }, accent }), undefined);
  assert.equal(safeEvent({ event: 'live_session_diagnostics', terminalCode: 'closed', accent }), undefined);
});

test('live_state keeps a closed transition shape for the orb timeline', () => {
  const event = { event: 'live_state', state: 'speaking', at: 1_700_000_000_000 };
  assert.deepEqual(safeEvent(event), event);
  assert.equal(safeEvent({ ...event, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...event, state: 'confused' }), undefined, 'a state outside the projection enum is refused');
  assert.equal(safeEvent({ ...event, at: 'now' }), undefined, 'a non-integer timestamp is refused');
  assert.equal(safeEvent({ ...event, at: -1 }), undefined, 'a negative timestamp is refused');
});
