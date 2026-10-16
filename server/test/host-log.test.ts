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
test('connector_failure admits bounded reason, exception, endpoint and attempt, and drops free text', () => {
  const base = { event: 'connector_failure', connector: 'google', stage: 'first_call' };
  assert.deepEqual(safeEvent({ ...base, reason: 'sdk_protocol_rejected', exceptionCode: 'PolicyError', endpointId: 'gcal', attempt: 'first-connect' }),
    { ...base, reason: 'sdk_protocol_rejected', exceptionCode: 'PolicyError', endpointId: 'gcal', attempt: 'first-connect' });
  assert.deepEqual(safeEvent(base), base, 'the detail fields stay optional');
  assert.equal(safeEvent({ ...base, reason: 'a free text reason with spaces' }), undefined, 'a free-text reason is refused');
  assert.equal(safeEvent({ ...base, endpointId: 'has space' }), undefined, 'a non-id endpoint is refused');
  assert.equal(safeEvent({ ...base, attempt: 'third-time' }), undefined, 'an out-of-vocabulary attempt is refused');
  assert.equal(safeEvent({ ...base, message: 'SECRET' }), undefined, 'an extra key fails closed');
});

test('research_joined carries the run id only', () => {
  assert.deepEqual(safeEvent({ event: 'research_joined', researchId: 'r1' }), { event: 'research_joined', researchId: 'r1' });
  assert.equal(safeEvent({ event: 'research_joined', researchId: 'r1', question: 'SECRET' }), undefined);
  assert.equal(safeEvent({ event: 'research_joined', researchId: 'has space' }), undefined);
});

test('research_subcall keeps a real error code but drops a free-text one', () => {
  const base = { event: 'research_subcall', researchId: 'r1', kind: 'calendar_window', tool: 'gcal_list', ok: false, items: 0, rawBytes: 0, keptBytes: 0, queryChars: 0, queryAuthor: 'selector' };
  assert.equal(safeEvent({ ...base, errorCode: 'unknown_tool' })?.errorCode, 'unknown_tool');
  assert.equal(safeEvent({ ...base, errorCode: 'invalid_arguments' })?.errorCode, 'invalid_arguments');
  assert.equal(safeEvent({ ...base, errorCode: 'has space' }), undefined);
});
