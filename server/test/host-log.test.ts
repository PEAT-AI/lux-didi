import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';

// The known Live instruction section ids, mirrored from ComposedSection.
const SECTIONS = ['voice-head', 'base', 'runtime', 'tools', 'owner-style', 'owner-lore', 'overlay', 'pickup', 'memory', 'voice'];

const SIZE = { event: 'live_instruction_sizes', total: 100, sections: { 'voice-head': 30, base: 70 }, languageCode: 'unset', voice: 'Aoede' };

test('live_instruction_sizes keeps a closed section schema of counts only', () => {
  assert.deepEqual(safeEvent(SIZE), SIZE);
  assert.equal(safeEvent({ ...SIZE, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...SIZE, sections: { 'unknown-section': 1 } }), undefined, 'an unknown section id is refused');
  assert.equal(safeEvent({ ...SIZE, sections: { base: 'seventy' } }), undefined, 'a non-integer count is refused');
  assert.equal(safeEvent({ ...SIZE, sections: { base: -1 } }), undefined, 'a negative count is refused');
  assert.equal(safeEvent({ ...SIZE, total: 1.5 }), undefined, 'a non-integer total is refused');
  assert.equal(safeEvent({ ...SIZE, total: -1 }), undefined, 'a negative total is refused');
  for (const id of SECTIONS) {
    assert.equal(!!safeEvent({ ...SIZE, total: 1, sections: { [id]: 1 } }), true, `${id} is a known section id`);
  }
});

test('live_instruction_sizes carries the effective languageCode and voice as closed metadata', () => {
  assert.equal(safeEvent({ ...SIZE, languageCode: 'en' })?.languageCode, 'en');
  assert.equal(safeEvent({ ...SIZE, languageCode: 'en-IN' })?.languageCode, 'en-IN');
  assert.equal(safeEvent({ ...SIZE, languageCode: 'unset' })?.languageCode, 'unset');
  assert.equal(safeEvent({ ...SIZE, languageCode: 'en-in' }), undefined, 'an unnormalised tag is refused');
  assert.equal(safeEvent({ ...SIZE, languageCode: 'english' }), undefined, 'a non-tag is refused');
  assert.equal(safeEvent({ ...SIZE, languageCode: 'en-IND' }), undefined, 'a three-letter region is refused');
  assert.equal(safeEvent({ ...SIZE, voice: 'Aoede' })?.voice, 'Aoede');
  assert.equal(safeEvent({ ...SIZE, voice: 'bad voice' }), undefined, 'an unsafe voice name is refused');
  assert.equal(safeEvent({ event: 'live_instruction_sizes', total: 1, sections: { base: 1 } }), undefined, 'a size line without the language field fails closed');
  assert.equal(safeEvent({ event: 'live_instruction_sizes', total: 1, sections: { base: 1 }, languageCode: 'unset' }), undefined, 'a size line without the voice field fails closed');
});

test('an accent string never survives the host-log allowlist', () => {
  const accent = 'SYNTHETIC-ACCENT-DESCRIPTION';
  assert.equal(safeEvent({ ...SIZE, total: 1, sections: { base: 1 }, accent }), undefined);
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
test('live_tool_turn admits a closed per-endpoint peak in-flight field', () => {
  const base = { event: 'live_tool_turn', sequence: 3, toolCallsThisTurn: 2, toolLatencyMs: [{ tool: 'search_knowledge', ms: 12 }], toolResponseWhileGenerating: false };
  const withPeak = { ...base, peakInFlight: [{ endpoint: 'lux', peak: 2 }] };
  assert.deepEqual(safeEvent(withPeak), withPeak);
  assert.equal(safeEvent(base)?.event, 'live_tool_turn', 'the field stays optional');
  assert.equal(safeEvent({ ...base, peakInFlight: [{ endpoint: 'lux', peak: -1 }] }), undefined, 'a negative peak is refused');
  assert.equal(safeEvent({ ...base, peakInFlight: [{ endpoint: 'lux', peak: 2, extra: 1 }] }), undefined, 'an extra peak key fails closed');
  assert.equal(safeEvent({ ...base, peakInFlight: [{ endpoint: 'a b', peak: 1 }] }), undefined, 'a non-token endpoint is refused');
  assert.equal(safeEvent({ ...base, peakInFlight: 'two' }), undefined, 'a non-array field is refused');
});
test('research_subcall carries the calendar window kind as a closed enum', () => {
  const base = { event: 'research_subcall', researchId: 'r1', kind: 'calendar_window', tool: 'gcal_list', ok: true, items: 1, rawBytes: 10, keptBytes: 8, queryChars: 0, queryAuthor: 'selector' };
  assert.deepEqual(safeEvent({ ...base, window: 'tomorrow' }), { ...base, window: 'tomorrow' });
  assert.equal(safeEvent({ ...base, window: 'date' })?.window, 'date');
  assert.equal(safeEvent({ ...base, window: '2026-10-16' }), undefined, 'a real date is refused');
  assert.equal(safeEvent({ ...base, window: 'yesterday' }), undefined, 'an unknown window is refused');
  assert.equal(safeEvent({ ...base, window: 'tomorrow', extra: 1 }), undefined, 'an extra key fails closed');
});
