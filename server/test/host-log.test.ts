import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';

// The known Live instruction section ids, mirrored from ComposedSection.
const SECTIONS = ['voice-head', 'base', 'runtime', 'tools', 'owner-style', 'owner-lore', 'overlay', 'pickup', 'memory', 'earlier-conversations', 'voice'];

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
  const event = { event: 'live_state', state: 'speaking', from: 'thinking', cause: 'audio', at: 1_700_000_000_000 };
  assert.deepEqual(safeEvent(event), event);
  assert.deepEqual(safeEvent({ event: 'live_state', state: 'listening', cause: 'created', at: 1_700_000_000_000 }),
    { event: 'live_state', state: 'listening', cause: 'created', at: 1_700_000_000_000 }, 'the opening state has no from');
  assert.equal(safeEvent({ ...event, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ event: 'live_state', state: 'speaking', at: 1_700_000_000_000 }), undefined,
    'a transition without its cause is refused (GL2-R1)');
  assert.equal(safeEvent({ ...event, state: 'confused' }), undefined, 'a state outside the projection enum is refused');
  assert.equal(safeEvent({ ...event, from: 'confused' }), undefined, 'a previous state outside the enum is refused');
  assert.equal(safeEvent({ ...event, cause: 'guess' }), undefined, 'a cause outside the closed set is refused');
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
  const base = { event: 'research_subcall', researchId: 'r1', kind: 'calendar_window', tool: 'calendar_list_events', ok: true, items: 1, rawBytes: 10, keptBytes: 8, queryChars: 0, queryAuthor: 'selector' };
  assert.deepEqual(safeEvent({ ...base, window: 'tomorrow' }), { ...base, window: 'tomorrow' });
  assert.equal(safeEvent({ ...base, window: 'date' })?.window, 'date');
  assert.equal(safeEvent({ ...base, window: '2026-10-16' }), undefined, 'a real date is refused');
  assert.equal(safeEvent({ ...base, window: 'yesterday' }), undefined, 'an unknown window is refused');
  assert.equal(safeEvent({ ...base, window: 'tomorrow', extra: 1 }), undefined, 'an extra key fails closed');
});

test('conversation_summary events keep the session id, counts, ms and reason codes only', () => {
  const started = { event: 'conversation_summary_started', liveSessionId: 's-1', inputChars: 120, truncated: false };
  assert.deepEqual(safeEvent(started), started);
  assert.equal(safeEvent({ ...started, summary: 'the owner said something private' }), undefined, 'summary text is refused');
  assert.equal(safeEvent({ ...started, liveSessionId: 'not a safe id' }), undefined, 'a malformed id is refused');
  assert.equal(safeEvent({ ...started, inputChars: -1 }), undefined, 'a negative count is refused');

  const completed = { event: 'conversation_summary_completed', liveSessionId: 's-1', inputChars: 120, outputChars: 40, durationMs: 12, truncated: false, retryCount: 0 };
  assert.deepEqual(safeEvent(completed), completed);
  assert.equal(safeEvent({ ...completed, durationMs: -1 }), undefined, 'a negative duration is refused');
  assert.equal(safeEvent({ ...completed, transcript: 'leak' }), undefined, 'an unknown key fails closed');

  const failed = { event: 'conversation_summary_failed', liveSessionId: 's-1', errorCode: 'deadline', retryCount: 2 };
  assert.deepEqual(safeEvent(failed), failed);
  assert.equal(safeEvent({ ...failed, errorCode: 'the model said no' }), undefined, 'a free-text error is refused');

  const skipped = { event: 'conversation_summary_skipped', liveSessionId: 's-1', reason: 'too_few_turns' };
  assert.deepEqual(safeEvent(skipped), skipped);
  assert.equal(safeEvent({ ...skipped, reason: 'because the owner said X' }), undefined, 'a free-text reason is refused');

  const recovery = { event: 'conversation_summary_recovery', requeued: 3, skipped: 7 };
  assert.deepEqual(safeEvent(recovery), recovery);
  assert.equal(safeEvent({ ...recovery, skipped: -1 }), undefined, 'a negative count is refused');
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
  assert.deepEqual(safeEvent({ event: 'research_joined', researchId: 'has space' }), { event: 'research_id_rejected', kind: 'research_joined', field: 'researchId' }, 'Z1: the rejected id is reported, never silent');
});

test('research_subcall keeps a real error code but drops a free-text one', () => {
  const base = { event: 'research_subcall', researchId: 'r1', kind: 'calendar_window', tool: 'calendar_list_events', ok: false, items: 0, rawBytes: 0, keptBytes: 0, queryChars: 0, queryAuthor: 'selector' };
  assert.equal(safeEvent({ ...base, errorCode: 'unknown_tool' })?.errorCode, 'unknown_tool');
  assert.equal(safeEvent({ ...base, errorCode: 'invalid_arguments' })?.errorCode, 'invalid_arguments');
  assert.equal(safeEvent({ ...base, errorCode: 'has space' }), undefined);
});
const RECOVERY = { event: 'live_recovery', path: 'fresh_seeded', attempt: 1, code: 'opened', closeCode: null, reason: 'transport_error', seedTurns: 3, seedChars: 120 };
test('live_recovery keeps a closed metadata-only shape', () => {
  assert.deepEqual(safeEvent(RECOVERY), RECOVERY);
  assert.equal(safeEvent({ ...RECOVERY, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...RECOVERY, path: 'carrier_pigeon' }), undefined, 'an unknown path is refused');
  assert.equal(safeEvent({ ...RECOVERY, closeCode: 70000 }), undefined, 'an out-of-range close code is refused');
  assert.equal(safeEvent({ ...RECOVERY, seedChars: -1 }), undefined, 'a negative seed size is refused');
});
test('live_go_away and live_upstream_queue keep counts only', () => {
  assert.deepEqual(safeEvent({ event: 'live_go_away', timeLeftMs: 30000 }), { event: 'live_go_away', timeLeftMs: 30000 });
  assert.equal(safeEvent({ event: 'live_go_away', timeLeftMs: -1 }), undefined, 'a negative deadline is refused');
  assert.deepEqual(safeEvent({ event: 'live_upstream_queue', bufferedBytes: 70000 }), { event: 'live_upstream_queue', bufferedBytes: 70000 });
  assert.equal(safeEvent({ event: 'live_upstream_queue', bufferedBytes: 'x' }), undefined, 'a non-integer depth is refused');
});
test('live_stall distinguishes inbound silence from outbound no-progress', () => {
  assert.deepEqual(safeEvent({ event: 'live_stall', silentMs: 8_000 }), { event: 'live_stall', silentMs: 8_000 });
  assert.deepEqual(safeEvent({ event: 'live_stall', noProgressMs: 30_000 }), { event: 'live_stall', noProgressMs: 30_000 });
  assert.equal(safeEvent({ event: 'live_stall', silentMs: 8_000, noProgressMs: 30_000 }), undefined, 'the receipt has exactly one local clock');
});
test('live_context_usage and live_dead_air_nudge carry numbers only', () => {
  assert.deepEqual(safeEvent({ event: 'live_context_usage', totalTokens: 15 }), { event: 'live_context_usage', totalTokens: 15 });
  assert.deepEqual(safeEvent({ event: 'live_context_usage', totalTokens: 15, promptTokens: 10, responseTokens: 5 }), { event: 'live_context_usage', totalTokens: 15, promptTokens: 10, responseTokens: 5 });
  assert.equal(safeEvent({ event: 'live_context_usage', totalTokens: 15, extra: 1 }), undefined, 'an extra key fails closed');
  assert.deepEqual(safeEvent({ event: 'live_dead_air_nudge', elapsedMs: 8000 }), { event: 'live_dead_air_nudge', elapsedMs: 8000 });
  assert.equal(safeEvent({ event: 'live_dead_air_nudge', elapsedMs: -1 }), undefined, 'a negative elapsed is refused');
});
test('live_turn_open carries the silence duration only (#303)', () => {
  assert.deepEqual(safeEvent({ event: 'live_turn_open', msSinceLastModelAudio: 42 }), { event: 'live_turn_open', msSinceLastModelAudio: 42 });
  assert.equal(safeEvent({ event: 'live_turn_open', msSinceLastModelAudio: null }), undefined, 'a null duration is refused');
  assert.equal(safeEvent({ event: 'live_turn_open', msSinceLastModelAudio: -1 }), undefined, 'a negative duration is refused');
  assert.equal(safeEvent({ event: 'live_turn_open', msSinceLastModelAudio: 42, text: 'x' }), undefined, 'an extra key fails closed');
});

test('live_turn_script is a closed enum of script buckets with character counts only', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const turn = { event: 'live_turn_script', liveSessionId: UUID, script: 'mixed', latinChars: 40, devanagariChars: 3, afterTool: true, interrupted: false };
  assert.deepEqual(safeEvent(turn), turn);
  assert.equal(safeEvent({ ...turn, script: 'cyrillic' }), undefined, 'only the three script buckets exist');
  assert.equal(safeEvent({ ...turn, text: 'SYNTHETIC-SPOKEN-TEXT' }), undefined, 'any key that could carry text fails closed');
  assert.equal(safeEvent({ ...turn, latinChars: 1.5 }), undefined, 'a non-integer count is refused');
  assert.equal(safeEvent({ ...turn, afterTool: 'yes' }), undefined, 'the flags are booleans');
  assert.equal(safeEvent({ ...turn, liveSessionId: 'not-a-session' }), undefined, 'a foreign id is refused');
});

test('conversation_summary_injection keeps counts and a size, never ids or text', () => {
  const injection = { event: 'conversation_summary_injection', injected: 12, omitted: 8, chars: 3_400 };
  assert.deepEqual(safeEvent(injection), injection);
  assert.equal(safeEvent({ event: 'conversation_summary_injection', injected: 12, omitted: 8 }), undefined, 'a partial shape fails closed');
  assert.equal(safeEvent({ ...injection, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...injection, text: 'owner words' }), undefined, 'never the summary text');
  assert.equal(safeEvent({ ...injection, ids: ['a'] }), undefined, 'never summary ids');
  assert.equal(safeEvent({ ...injection, injected: 1.5 }), undefined, 'a non-integer count is refused');
  assert.equal(safeEvent({ ...injection, omitted: -1 }), undefined, 'a negative count is refused');
});

test('warm_prewarm keeps two ages and one flag, and nothing the calendar carried', () => {
  const receipt = { event: 'warm_prewarm', ageBeforeMs: 1_000, ageAfterMs: 0, assembled: true };
  assert.deepEqual(safeEvent(receipt), receipt);
  assert.deepEqual(safeEvent({ event: 'warm_prewarm', ageBeforeMs: null, ageAfterMs: null, assembled: false }),
    { event: 'warm_prewarm', ageBeforeMs: null, ageAfterMs: null, assembled: false }, 'no assembly yet is a valid receipt');
  assert.equal(safeEvent({ ...receipt, digest: '10:00 standup with the board' }), undefined, 'the calendar text never reaches the log');
  assert.equal(safeEvent({ ...receipt, ageAfterMs: -1 }), undefined, 'a negative age is refused');
  assert.equal(safeEvent({ ...receipt, assembled: 'yes' }), undefined, 'the flag is a boolean');
  assert.equal(safeEvent({ event: 'warm_prewarm', assembled: true }), undefined, 'both ages are always present');
});

test('Z1: a research line with an unsafe id reports the rejection instead of vanishing', () => {
  const progress = { event: 'research_progress', researchId: '\u2014', phase: 'round', sourcesDone: [], sourcesPending: [], elapsedMs: 3 };
  assert.deepEqual(safeEvent(progress), { event: 'research_id_rejected', kind: 'research_progress', field: 'researchId' });
  assert.equal(safeEvent({ event: 'research_joined', researchId: 'a.b' })?.event, 'research_id_rejected', 'every research line reports its own rejection');
  assert.equal(JSON.stringify(safeEvent(progress)).includes('\u2014'), false, 'the line never carries the value');
  assert.deepEqual(safeEvent({ ...progress, researchId: 'ok-id' }), { ...progress, researchId: 'ok-id' }, 'a safe id still writes its own line');
});
