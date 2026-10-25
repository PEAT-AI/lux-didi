import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';
import { createHostResourceSampler } from '../host/runtime.js';

// The known Live instruction section ids, mirrored from ComposedSection.
const SECTIONS = ['voice-head', 'base', 'runtime', 'tools', 'owner-style', 'owner-lore', 'overlay', 'pickup', 'memory', 'earlier-conversations', 'voice'];
const LIVE_SESSION_ID = '11111111-2222-4333-8444-555555555555';

const SIZE = { event: 'live_instruction_sizes', total: 100, sections: { 'voice-head': 30, base: 70 }, languageCode: 'unset', voice: 'Aoede' };

// Release 3: the shed receipt carries the speech and silence split of what the uplink dropped, counts only.
const SHED = { event: 'uplink_shed', bytes: 42_528, bufferedPeak: 123_904, shedRuns: 1, drainBytesPerSec: 19_200, notOpenBytes: 0,
  lostMs: 660, speechShedMs: 0, silenceShedMs: 660, speechShedBytes: 0, silenceShedBytes: 42_528 };

test('uplink_shed keeps its closed receipt including the speech and silence split', () => {
  assert.deepEqual(safeEvent(SHED), SHED);
  assert.equal(safeEvent({ ...SHED, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...SHED, lostMs: 1.5 }), undefined, 'a fractional count is refused');
  assert.equal(safeEvent({ ...SHED, speechShedMs: -1 }), undefined, 'a negative count is refused');
  assert.equal(safeEvent({ ...SHED, speechShedBytes: 'many' }), undefined, 'a non-numeric count is refused');
  assert.equal(safeEvent({ ...SHED, silenceShedMs: undefined }), undefined, 'a missing split field is refused');
});

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
  const identified = { ...event, liveSessionId: LIVE_SESSION_ID, generation: 2 };
  assert.deepEqual(safeEvent(identified), identified, 'a state line names the session and its generation');
  assert.equal(safeEvent({ ...identified, generation: -1 }), undefined, 'a negative generation is refused');
  assert.equal(safeEvent({ ...identified, liveSessionId: 'not-a-session' }), undefined, 'a non-uuid session is refused');
  assert.equal(safeEvent({ event: 'live_state', state: 'listening', cause: 'ready', at: 1_700_000_000_000, liveSessionId: LIVE_SESSION_ID, generation: 0 })?.cause,
    'ready', 'the provider ready event is a legal state cause (#451)');
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
  const base = { event: 'research_subcall', researchId: 'r1', kind: 'calendar_window', tool: 'calendar_list_events', ok: true, items: 1, rawBytes: 10, keptBytes: 8, queryChars: 0, queryAuthor: 'routed' };
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
  const base = { event: 'research_subcall', researchId: 'r1', kind: 'calendar_window', tool: 'calendar_list_events', ok: false, items: 0, rawBytes: 0, keptBytes: 0, queryChars: 0, queryAuthor: 'routed' };
  assert.equal(safeEvent({ ...base, errorCode: 'unknown_tool' })?.errorCode, 'unknown_tool');
  assert.equal(safeEvent({ ...base, errorCode: 'invalid_arguments' })?.errorCode, 'invalid_arguments');
  assert.equal(safeEvent({ ...base, errorCode: 'has space' }), undefined);
});
const RECOVERY = { event: 'live_recovery', path: 'fresh_seeded', attempt: 1, code: 'opened', closeCode: null, reason: 'transport_error', seedTurns: 3, seedChars: 120, msSinceDrop: 21_000, liveSessionId: LIVE_SESSION_ID, generation: 4 };
test('live_recovery keeps a closed metadata-only shape', () => {
  assert.deepEqual(safeEvent(RECOVERY), RECOVERY);
  assert.equal(safeEvent({ ...RECOVERY, extra: 1 }), undefined, 'an extra key fails closed');
  assert.equal(safeEvent({ ...RECOVERY, path: 'carrier_pigeon' }), undefined, 'an unknown path is refused');
  assert.equal(safeEvent({ ...RECOVERY, closeCode: 70000 }), undefined, 'an out-of-range close code is refused');
  assert.equal(safeEvent({ ...RECOVERY, seedChars: -1 }), undefined, 'a negative seed size is refused');
  assert.equal(safeEvent({ ...RECOVERY, liveSessionId: 'nope' }), undefined, 'a recovery line names a real session (#527)');
});
test('the timing waterfall lines keep closed, count-only shapes (#451)', () => {
  const open = { event: 'live_provider_open', liveSessionId: LIVE_SESSION_ID, generation: 1, instructionChars: 40_000, seedChars: 900, tools: 2 };
  assert.deepEqual(safeEvent(open), open);
  assert.equal(safeEvent({ ...open, instructionChars: -1 }), undefined, 'a negative size is refused');
  const ready = { event: 'live_provider_ready', liveSessionId: LIVE_SESSION_ID, generation: 1, msSinceOpen: 3_600, closeCode: null };
  assert.deepEqual(safeEvent(ready), ready);
  assert.equal(safeEvent({ ...ready, msSinceOpen: -1 }), undefined, 'a negative span is refused');
  assert.equal(safeEvent({ ...ready, closeCode: 70_000 }), undefined, 'an out-of-range close code is refused');
  const step = { event: 'live_handshake', step: 'socket_open', ms: 120 };
  assert.deepEqual(safeEvent(step), step);
  assert.equal(safeEvent({ ...step, step: 'prayed' }), undefined, 'an unknown handshake step is refused');
  const first = { event: 'live_first_audio', liveSessionId: LIVE_SESSION_ID, generation: 1, msSinceReady: 700, msSinceOpen: 4_300 };
  assert.deepEqual(safeEvent(first), first);
  const answer = { event: 'live_answer_audio', liveSessionId: LIVE_SESSION_ID, generation: 1, msSinceReady: 700, msSinceOpen: 4_300 };
  assert.deepEqual(safeEvent(answer), answer);
  const arrived = { event: 'research_call_arrived', liveSessionId: LIVE_SESSION_ID, generation: 1, calls: 2,
    action: 'start', researchIdPresent: false, questionChars: 42, lookups: 3 };
  assert.deepEqual(safeEvent(arrived), arrived);
  // #667: the call's shape is a closed set, and the question text itself has no column.
  assert.equal(safeEvent({ ...arrived, action: 'look' }), undefined, 'an unknown action fails closed');
  assert.equal(safeEvent({ ...arrived, researchIdPresent: 'yes' }), undefined, 'presence is a boolean, never an id');
  assert.equal(safeEvent({ ...arrived, question: 'where is the invoice' }), undefined, 'the question text never enters the log');
  const delivered = { event: 'live_unspoken_delivered', liveSessionId: LIVE_SESSION_ID, generation: 2, results: 2, attempt: 2 };
  assert.deepEqual(safeEvent(delivered), delivered);
  assert.equal(safeEvent({ ...delivered, attempt: 3 }), undefined, 'the one retry is the last attempt there is');
  assert.equal(safeEvent({ ...delivered, results: -1 }), undefined, 'a delivery count is never negative');
  const output = { event: 'tool_output_sent', liveSessionId: LIVE_SESSION_ID, generation: 1, tools: 2, msSinceArrived: 1_400, outcome: 'sent' };
  assert.deepEqual(safeEvent(output), output);
  assert.equal(safeEvent({ ...output, msSinceArrived: -5 }), undefined, 'a negative span is refused');
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
test('#538: the debt clock, the typed turn failure and the tool send outcome are closed shapes', () => {
  // The debt clock records phase changes as enums, never a duration, a reason string or any content.
  assert.deepEqual(safeEvent({ event: 'live_debt', phase: 'start', reason: 'tool_output' }),
    { event: 'live_debt', phase: 'start', reason: 'tool_output' });
  assert.deepEqual(safeEvent({ event: 'live_debt', phase: 'clear', reason: 'audible' }),
    { event: 'live_debt', phase: 'clear', reason: 'audible' });
  assert.deepEqual(safeEvent({ event: 'live_debt', phase: 'rung', reason: 'send_failed' }),
    { event: 'live_debt', phase: 'rung', reason: 'send_failed' });
  assert.equal(safeEvent({ event: 'live_debt', phase: 'started', reason: 'tool_output' }), undefined, 'an unknown phase fails closed');
  assert.equal(safeEvent({ event: 'live_debt', phase: 'start', reason: 'the model said nothing' }), undefined, 'free text has no column');
  assert.equal(safeEvent({ event: 'live_debt', phase: 'start', reason: 'tool_output', ms: 8_000 }), undefined, 'a duration is not part of the shape');
  // The typed turn failure names a reason from the closed set.
  for (const reason of ['provider_error', 'delegation_stalled', 'send_failed', 'recreate_failed']) {
    assert.deepEqual(safeEvent({ event: 'turn_failed', reason }), { event: 'turn_failed', reason });
  }
  assert.equal(safeEvent({ event: 'turn_failed', reason: 'mystery_error' }), undefined, 'the provider word never reaches the log');
  assert.equal(safeEvent({ event: 'turn_failed', code: 'provider_error' }), undefined, 'the old open field is gone');
  // The tool answer names what the adapter reported, and nothing else.
  const answered = { event: 'tool_output_sent', liveSessionId: '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11', generation: 2, tools: 1, msSinceArrived: 12 };
  for (const outcome of ['sent', 'deferred', 'failed'] as const) {
    assert.deepEqual(safeEvent({ ...answered, outcome }), { ...answered, outcome });
  }
  assert.equal(safeEvent({ ...answered, outcome: 'unknown' }), undefined, 'the outcome is a closed set');
  assert.equal(safeEvent(answered), undefined, 'a send receipt without its outcome is refused');
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

test('1022: the connector lifecycle lines carry closed fields and nothing else', () => {
  assert.deepEqual(safeEvent({ event: 'connector_connected', endpointId: 'gmail', connectMs: 2569 }),
    { event: 'connector_connected', endpointId: 'gmail', connectMs: 2569 });
  assert.equal(safeEvent({ event: 'connector_connected', endpointId: 'gmail', connectMs: 2569, url: 'https://x' }), undefined, 'a url never rides a connect line');
  assert.deepEqual(safeEvent({ event: 'connector_recovered', endpointId: 'gmail', attempts: 1, connectMs: 900 }),
    { event: 'connector_recovered', endpointId: 'gmail', attempts: 1, connectMs: 900 });
  assert.deepEqual(safeEvent({ event: 'connector_recovery_exhausted', endpointId: 'gmail', attempts: 3, reason: 'identity_unverified' }),
    { event: 'connector_recovery_exhausted', endpointId: 'gmail', attempts: 3, reason: 'identity_unverified' });
  assert.equal(safeEvent({ event: 'connector_recovery_exhausted', endpointId: 'gmail', attempts: 3, reason: 'the helper said no' }), undefined, 'a free text reason is refused');
  assert.deepEqual(safeEvent({ event: 'connector_helper_stderr', endpointId: 'gmail', bytes: 4096 }),
    { event: 'connector_helper_stderr', endpointId: 'gmail', bytes: 4096 });
  assert.equal(safeEvent({ event: 'connector_helper_stderr', endpointId: 'gmail', bytes: 4096, text: 'boom' }), undefined, 'never the helper text');
  assert.deepEqual(safeEvent({ event: 'connector_identity', connector: 'google', proven: true, match: true, endpointId: 'gmail' }),
    { event: 'connector_identity', connector: 'google', proven: true, match: true, endpointId: 'gmail' }, '#533: one proof names its endpoint');
  assert.deepEqual(safeEvent({ event: 'calendar_digest', state: 'absent', items: 0, ageMs: 0 }),
    { event: 'calendar_digest', state: 'absent', items: 0, ageMs: 0 }, 'an absent digest is stated as absent');
});

test('C-R2: both skip reasons the summarizer already logs pass the sanitizer', () => {
  for (const reason of ['history_provenance_unavailable', 'summary_route_class_denied']) {
    assert.deepEqual(safeEvent({ event: 'conversation_summary_skipped', liveSessionId: LIVE_SESSION_ID, reason }),
      { event: 'conversation_summary_skipped', liveSessionId: LIVE_SESSION_ID, reason }, `C-R2: ${reason} reaches host.log`);
  }
  assert.equal(safeEvent({ event: 'conversation_summary_skipped', liveSessionId: LIVE_SESSION_ID, reason: 'free text reason' }), undefined, 'and the closed set still refuses anything else');
});

// MED-1022/T-R2: a knowledge receipt names the query's term count, whether the day filter was applied
// and what became of the chat date operator, as counts and closed tokens, never the query text.
test('MED-1022: the knowledge receipt keeps its counts and closed tokens and refuses anything else', () => {
  const base = {
    event: 'research_source', researchId: 'r1', source: 'knowledge', outcome: 'ok', ms: 12, deadlineMs: 12_000, coalesced: 1,
    knowledge: { detail: 'voice', maxChars: 3_000, deadlineMs: 8_000, truncated: false, queryTerms: 7, dayFilter: 'past_window', chatDateOperator: 'compiled', deduped: 1 },
  };
  const kept = safeEvent(base);
  assert.ok(kept !== undefined, 'a receipt with the three new fields is kept');
  assert.deepEqual(kept!['knowledge'], base.knowledge, 'and every field survives unchanged');
  const row = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...base, knowledge: { ...base.knowledge, ...patch } });
  const without = (key: string): Record<string, unknown> => {
    const knowledge: Record<string, unknown> = { ...base.knowledge };
    delete knowledge[key];
    return { ...base, knowledge };
  };
  assert.equal(safeEvent(without('queryTerms')), undefined, 'a receipt missing the term count is refused');
  assert.equal(safeEvent(without('deduped')), undefined, 'a receipt missing the dedup count is refused');
  assert.equal(safeEvent(row({ queryTerms: -1 })), undefined, 'a negative term count is refused');
  assert.equal(safeEvent(row({ queryTerms: 'seven' })), undefined, 'the term count is never text');
  assert.equal(safeEvent(row({ dayFilter: 'yes' })), undefined, 'the day filter is a closed token, never a word');
  for (const token of ['none', 'past_window', 'dropped_on_empty']) assert.ok(safeEvent(row({ dayFilter: token })) !== undefined, `${token} is a closed token`);
  assert.equal(safeEvent(row({ deduped: -1 })), undefined, 'a negative dedup count is refused');
  assert.equal(safeEvent(row({ chatDateOperator: 'after:2026-10-21' })), undefined, 'the date itself never rides the receipt');
  for (const token of ['compiled', 'dropped', 'none']) assert.ok(safeEvent(row({ chatDateOperator: token })) !== undefined, `${token} is a closed token`);
  assert.equal(safeEvent(row({ note: 'extra' })), undefined, 'an unknown field is refused');
});

// ROUTE-1022 K5: a receipt names the plan a brief actually ran, as one closed token and nothing else.
test('ROUTE-1022: the brief plan token reaches the log only from its closed set', () => {
  const source = { event: 'research_source', researchId: 'r1', source: 'knowledge', outcome: 'ok', ms: 12, deadlineMs: 12_000, coalesced: 1 };
  for (const plan of ['knowledge_only', 'named_sources']) {
    assert.deepEqual(safeEvent({ ...source, plan }), { ...source, plan }, `${plan} reaches host.log`);
  }
  assert.equal(safeEvent({ ...source, plan: 'read everything' }), undefined, 'an unknown plan token is refused');
  const run = {
    event: 'research_run', researchId: 'r1', questionClass: 'cross_source', rounds: 1, perRound: [], stopReason: 'answered', status: 'answered',
    ops: 2, sources: [{ kind: 'knowledge', disposition: 'completed', latencyMs: 12 }], elapsedMs: 100, deadAirMs: 0, selectorMs: 0,
    fallbackUsed: false, replyBytes: 400, unchecked: [], canContinue: false, findingChars: [10],
  };
  assert.deepEqual(safeEvent({ ...run, plan: 'knowledge_only' }), { ...run, plan: 'knowledge_only' }, 'the run receipt names the plan');
  assert.equal(safeEvent({ ...run, plan: 'brief' }), undefined, 'and refuses a token outside it');
});

test('L2: a digest refresh receipt says which edge read it and how long, never a day', () => {
  const base = { event: 'calendar_digest_refreshed', reason: 'first_connect', ms: 2402 };
  assert.deepEqual(safeEvent(base), base, 'the first-connect read keeps its reason and its timing');
  for (const reason of ['start', 'timer', 'recovered', 'first_connect']) {
    assert.equal(safeEvent({ ...base, reason })?.reason, reason, `${reason} is a closed reason`);
  }
  assert.equal(safeEvent({ ...base, reason: 'manual' }), undefined, 'a reason outside the closed set is refused');
  assert.equal(safeEvent({ ...base, extra: 'text' }), undefined, 'an extra field fails closed');
  assert.equal(safeEvent({ ...base, ms: -1 }), undefined, 'a negative duration is refused');
  assert.equal(safeEvent({ ...base, ms: 'fast' }), undefined, 'a non numeric duration is refused');
  assert.equal(safeEvent({ event: 'calendar_digest_refreshed', reason: 'first_connect' }), undefined, 'a receipt with no duration is refused');
});

// 556: the read the deadline cut is one closed line of its own, with no day and no event on it.
test('556: a digest timeout receipt names the edge and the time it held, never a day', () => {
  const base = { event: 'calendar_digest_timeout', reason: 'timer', ms: 10_000 };
  assert.deepEqual(safeEvent(base), base, 'the timed out read keeps its reason and its timing');
  assert.equal(safeEvent({ ...base, reason: 'manual' }), undefined, 'a reason outside the closed set is refused');
  assert.equal(safeEvent({ ...base, digest: '10:00 standup' }), undefined, 'the calendar text never reaches the log');
  assert.equal(safeEvent({ ...base, ms: -1 }), undefined, 'a negative duration is refused');
  assert.equal(safeEvent({ event: 'calendar_digest_timeout', reason: 'timer' }), undefined, 'a receipt with no duration is refused');
});

test('L12d: host_resources is numbers only, megabytes and a CPU percentage', () => {
  const base = { event: 'host_resources', rssMb: 412.5, heapUsedMb: 83.2, cpuPct: 12.4 };
  assert.deepEqual(safeEvent(base), base, 'one resource window survives unchanged');
  assert.equal(safeEvent({ ...base, cpuPct: 120.5 })?.cpuPct, 120.5, 'a call spanning cores may pass one hundred percent');
  assert.equal(safeEvent({ ...base, extra: 'device' }), undefined, 'an extra field fails closed');
  assert.equal(safeEvent({ ...base, rssMb: -1 }), undefined, 'a negative footprint is refused');
  assert.equal(safeEvent({ ...base, heapUsedMb: Number.NaN }), undefined, 'a NaN footprint is refused');
  assert.equal(safeEvent({ ...base, cpuPct: 100_000 }), undefined, 'an impossible CPU percentage is refused');
  assert.equal(safeEvent({ event: 'host_resources', rssMb: 412.5, heapUsedMb: 83.2 }), undefined, 'a receipt with no CPU is refused');
});

test('L12d: one host_resources receipt per sixty second window, on the host clock', () => {
  let at = 1_000_000;
  let cpu = { user: 0, system: 0 };
  const logged: Array<Record<string, unknown>> = [];
  const sampler = createHostResourceSampler({
    log: event => { logged.push(event); },
    now: () => at,
    memoryUsage: () => ({ rss: 432 * 1_048_576, heapUsed: 100.5 * 1_048_576 }),
    cpuUsage: () => cpu,
  });
  assert.equal(sampler.sample(), false, 'the first read is the baseline, not a window');
  at += 59_000;
  assert.equal(sampler.sample(), false, 'under a window nothing is logged');
  cpu = { user: 3_000_000, system: 0 };
  at += 1_000;
  assert.equal(sampler.sample(), true, 'a full window logs once');
  assert.deepEqual(logged, [{ event: 'host_resources', rssMb: 432, heapUsedMb: 100.5, cpuPct: 5 }],
    'the window covers the sixty seconds it just closed: three CPU seconds of sixty, megabytes to one decimal');
  assert.deepEqual(safeEvent(logged[0]), logged[0], 'the receipt passes the closed allowlist');
  at += 1_000;
  assert.equal(sampler.sample(), false, 'a second read inside the same window stays silent');
  assert.equal(logged.length, 1);
});

// Release 4: a partial mail read carries a closed marker and a page count, and an unresolved window
// reason is its own token, so neither reads as an outage.
test('release 4: the partial source receipt and the window reason reach host.log', () => {
  const source = { event: 'research_source', researchId: 'r1', source: 'mail', outcome: 'ok', ms: 730, deadlineMs: 12_000, coalesced: 1 };
  assert.deepEqual(safeEvent({ ...source, partial: 'pages_failed', failedPages: 1 }), { ...source, partial: 'pages_failed', failedPages: 1 }, 'the partial marker and its count reach host.log');
  assert.equal(safeEvent({ ...source, partial: 'lost everything', failedPages: 1 }), undefined, 'an unknown partial token is refused');
  assert.equal(safeEvent({ ...source, partial: 'pages_failed' }), undefined, 'the marker never travels without its count');
  const run = { event: 'research_run', researchId: 'r1', questionClass: 'cross_source', rounds: 1, perRound: [], stopReason: 'answered', status: 'answered', ops: 1, sources: [] as Record<string, unknown>[], elapsedMs: 0, deadAirMs: 0, selectorMs: 0, fallbackUsed: false, replyBytes: 10, unchecked: ['calendar'], canContinue: true, findingChars: [] };
  const row = { kind: 'calendar', disposition: 'skipped', latencyMs: 0, reason: 'window_unparsed' };
  assert.ok(safeEvent({ ...run, sources: [row] }) !== undefined, 'the window reason reaches host.log');
  assert.equal(safeEvent({ ...run, sources: [{ ...row, reason: 'whatever' }] }), undefined, 'and the closed set still refuses anything else');
});
// L8-Q07: a failed read names its closed reason in host.log, and nothing outside the set passes.
test('L8-Q07: a research_source receipt carries a closed failure reason', () => {
  const source = { event: 'research_source', researchId: 'r1', source: 'mail', outcome: 'failed', ms: 0, deadlineMs: 12_000, coalesced: 1 };
  assert.deepEqual(safeEvent({ ...source, reason: 'no_query' }), { ...source, reason: 'no_query' }, 'the reason reaches host.log');
  assert.deepEqual(safeEvent({ ...source, reason: 'timed_out' }), { ...source, reason: 'timed_out' });
  assert.equal(safeEvent({ ...source, reason: 'the mail server said no' }), undefined, 'a free text reason is refused');
});
test('W7: a Trello connector_call line keeps its closed shape and a Trello sign-in names its own row', () => {
  const settled = { event: 'connector_call', connector: 'trello', tool: 'write.move', phase: 'settle', outcome: 'unknown', reason: 'outcome_unknown' };
  assert.deepEqual(safeEvent(settled), settled);
  const read = { event: 'connector_call', connector: 'trello', tool: 'read.due', phase: 'settle', outcome: 'ok' };
  assert.deepEqual(safeEvent(read), read);
  assert.equal(safeEvent({ ...read, tool: 'write.delete' }), undefined, 'no tool outside the closed set');
  assert.equal(safeEvent({ ...read, card: 'Call the plumber' }), undefined, 'never card text');
  assert.equal(safeEvent({ ...settled, reason: 'Call the plumber' }), undefined, 'a reason is a closed code');
  assert.equal(safeEvent({ ...read, connector: 'mongoose' }), undefined);
  const hop = { event: 'signin_callback', endpoint: 'trello', attemptId: '0123456789abcdef', outcome: 'ok' };
  assert.deepEqual(safeEvent(hop), hop);
});

test('vault_write keeps its closed shape: a state token, an insight id on a save, latency, never text', () => {
  const saved = { event: 'vault_write', state: 'confirmed', insightId: 'insight-7', latencyMs: 42 };
  assert.deepEqual(safeEvent(saved), saved, 'the confirmed receipt passes the allowlist');
  const failed = { event: 'vault_write', state: 'failed', latencyMs: 42 };
  assert.deepEqual(safeEvent(failed), failed, 'a failed write carries no insight id');
  const uncertain = { event: 'vault_write', state: 'uncertain', latencyMs: 9000 };
  assert.deepEqual(safeEvent(uncertain), uncertain, 'an uncertain write is a state and a latency');
  assert.equal(safeEvent({ ...saved, content: 'the boat survey is on Tuesday' }), undefined, 'a note never crosses the log boundary');
  assert.equal(safeEvent({ ...saved, state: 'saved' }), undefined, 'only the closed state tokens are allowed');
  assert.equal(safeEvent({ event: 'vault_write', state: 'confirmed', latencyMs: 42 }), undefined, 'a confirmed save without an id is not a receipt');
  assert.equal(safeEvent({ event: 'vault_write', state: 'failed', insightId: 'insight-7', latencyMs: 42 }), undefined, 'a failed write carries no id');
});

test('LAT-1023: a run receipt carries the round cap and the compaction counts as closed values', () => {
  const run = {
    event: 'research_run', researchId: 'r1', questionClass: 'cross_source', rounds: 2, perRound: [], stopReason: 'rounds_exhausted', status: 'partial',
    ops: 2, sources: [{ kind: 'knowledge', disposition: 'completed', latencyMs: 12 }], elapsedMs: 100, deadAirMs: 0, selectorMs: 0,
    fallbackUsed: false, replyBytes: 400, unchecked: ['mail'], canContinue: true, findingChars: [10],
  };
  const admitted = safeEvent({ ...run, roundCapHit: 2, answerCompacted: { items: 4, chars: 400 } });
  assert.deepEqual(admitted, { ...run, roundCapHit: 2, answerCompacted: { items: 4, chars: 400 } }, 'both closed counts reach host.log');
  assert.equal(safeEvent({ ...run, roundCapHit: -1 }), undefined, 'a negative round count is refused');
  assert.equal(safeEvent({ ...run, roundCapHit: 'two' }), undefined, 'a round count is never text');
  assert.equal(safeEvent({ ...run, answerCompacted: { items: 4 } }), undefined, 'a compaction needs both counts');
  assert.equal(safeEvent({ ...run, answerCompacted: { items: 4, chars: 400, text: 'the mail said' } }), undefined, 'and never carries content');
  assert.equal(safeEvent({ ...run, answerCompacted: { items: 1.5, chars: 400 } }), undefined, 'a count is a whole number');
});

test('#606 stop candidates carry only bounded alias ids, counts and flags', () => {
  const candidate = { event: 'voice_stop_candidate', aliasId: 1, windowWords: 10, matched: false, finished: false };
  assert.deepEqual(safeEvent(candidate), candidate);
  assert.equal(safeEvent({ ...candidate, text: 'synthetic transcript' }), undefined);
  assert.equal(safeEvent({ ...candidate, aliasId: 'naya' }), undefined);
  assert.equal(safeEvent({ ...candidate, aliasId: 7 }), undefined);
  assert.equal(safeEvent({ ...candidate, windowWords: 11 }), undefined);
});

// F7 / #610: the chat read's own shape rides the receipt, so a slow chat search can be judged from
// the log. Counts, operator names and closed tokens only; the query words never arrive.
test('#610: the chat query shape reaches the log, and a stray key still refuses the receipt', () => {
  const source = { event: 'research_source', researchId: 'r1', source: 'chat', outcome: 'ok', ms: 4_800, deadlineMs: 12_000, coalesced: 1 };
  const shape = { terms: 3, operators: ['in', 'after'], limit: 8, sort: 'newest' };
  const admitted = safeEvent({ ...source, chat: shape });
  assert.ok(admitted !== undefined, 'a chat receipt with its shape is admitted');
  assert.deepEqual((admitted as { chat?: unknown }).chat, shape);
  for (const bad of [{ ...shape, terms: -1 }, { ...shape, terms: 1.5 }, { ...shape, operators: ['subject'] }, { ...shape, limit: 0 }, { ...shape, sort: 'relevance-x' }, { ...shape, query: 'dogcation' }]) {
    assert.equal(safeEvent({ ...source, chat: bad }), undefined, `a malformed chat shape is refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(safeEvent({ ...source, chat: 'terms=3' }), undefined, 'a string is never a chat shape');
  // R3: a refused chat read records the reason it really failed with, as one closed token.
  const refused = safeEvent({ ...source, outcome: 'failed', chat: { reason: 'credential-refresh-failed' } });
  assert.equal((refused as { chat?: { reason?: string } } | undefined)?.chat?.reason, 'credential-refresh-failed', 'a refusal reason reaches the log');
  assert.equal(safeEvent({ ...source, outcome: 'failed', chat: { reason: 'whatever_dana_said' } }), undefined, 'a reason outside the closed set is refused');
  assert.equal(safeEvent({ ...source, chat: { ...shape, reason: 'tool-not-granted' } }), undefined, 'a reason never rides a search shape');
  assert.equal(safeEvent({ ...source, note: 'extra' }), undefined, 'an unknown field beside a chat shape still refuses the receipt');
  const serialized = JSON.stringify(admitted);
  assert.ok(!serialized.includes('dogcation'), 'no query word reaches the log');
});

test('launch_kind carries the kind and its two flags, and nothing else', () => {
  const launch = { event: 'launch_kind', kind: 'interactive', autoConnects: true, windowShown: false };
  assert.deepEqual(safeEvent(launch), launch);
  // Every kind the app can report is accepted, so a new launch path is never a silent gap.
  for (const kind of ['interactive', 'login_item', 'install_relaunch', 'installed_proof', 'self_check', 'ui_proof', 'verification']) {
    assert.deepEqual(safeEvent({ ...launch, kind }), { ...launch, kind }, `${kind} is a known launch kind`);
  }
  assert.equal(safeEvent({ ...launch, kind: 'the owner opened it' }), undefined, 'a free text kind is refused');
  assert.equal(safeEvent({ ...launch, autoConnects: 'yes' }), undefined, 'a flag is never text');
  assert.equal(safeEvent({ ...launch, windowShown: 1 }), undefined, 'a flag is never a count');
  assert.equal(safeEvent({ ...launch, windowTitle: 'Naya' }), undefined, 'no window text crosses this boundary');
});

// #639: the company read is a candidate like the others, so the run receipt that names it is kept rather
// than refused by the closed set.
test('#639: a research_run row naming the company search candidate is accepted', () => {
  const run = { event: 'research_run', researchId: 'r1', questionClass: 'cross_source', rounds: 1, perRound: [{ candidates: [{ kind: 'company_search', pUseful: 0.4 }, { kind: 'knowledge_search', pUseful: 0.4 }], chosen: ['knowledge_search', 'company_search'] }], stopReason: 'answered', status: 'answered', ops: 2, sources: [{ kind: 'mongoose', disposition: 'completed', latencyMs: 12 }], elapsedMs: 100, deadAirMs: 0, selectorMs: 0, fallbackUsed: false, replyBytes: 400, unchecked: [], canContinue: false, findingChars: [] };
  assert.deepEqual(safeEvent(run), run, 'the round names the company read and the receipt keeps it');
});

test('W1: every Mongoose sign-in hop keeps its closed content-free line, and nothing else gets through', () => {
  const attemptId = '0123456789abcdef';
  const lines = [
    { event: 'signin_requested', endpoint: 'data', attemptId, outcome: 'started' },
    { event: 'signin_requested', endpoint: 'unknown', attemptId, outcome: 'not_configured' },
    { event: 'signin_discovery', endpoint: 'knowledge', attemptId, outcome: 'ok' },
    { event: 'signin_discovery', endpoint: 'knowledge', attemptId, outcome: 'resource_mismatch' },
    { event: 'signin_registration', endpoint: 'crm', attemptId, outcome: 'port_in_use' },
    { event: 'signin_browser_handoff', endpoint: 'crm', attemptId, outcome: 'ok' },
    { event: 'signin_callback', endpoint: 'crm', attemptId, outcome: 'timeout' },
    { event: 'signin_token', endpoint: 'data', attemptId, outcome: 'refused', oauthError: 'invalid_target' },
    { event: 'signin_stored', endpoint: 'data', attemptId, outcome: 'ok' },
  ];
  for (const line of lines) assert.deepEqual(safeEvent(line), line, line.event);
  const base = { event: 'signin_token', endpoint: 'data', attemptId, outcome: 'refused' };
  for (const leak of [{ url: 'https://mongoose.test/oauth/authorize?state=x' }, { code: 'auth-code' }, { state: 'state' }, { accessToken: 'token' }, { verifier: 'v' }, { body: '{}' }]) {
    assert.equal(safeEvent({ ...base, ...leak }), undefined, `${Object.keys(leak)[0]} is never written`);
  }
  assert.equal(safeEvent({ ...base, outcome: 'refused because of x' }), undefined, 'outcomes are a closed set');
  assert.equal(safeEvent({ ...base, oauthError: 'server says no' }), undefined, 'only an RFC 6749 error code');
  assert.equal(safeEvent({ ...base, endpoint: 'admin' }), undefined, 'admin is never a sign-in endpoint');
  assert.equal(safeEvent({ ...base, attemptId: 'not an id' }), undefined, 'the attempt id is opaque hex');
  assert.equal(safeEvent({ event: 'signin_discovery', endpoint: 'data', attemptId, outcome: 'refused' }), undefined, 'each hop has its own outcomes');

// C-LIVE behaviour 7: the error class of a refused attach and of a failed recovery open survives the writer,
// content-free, and the new admission and deadline receipts are closed shapes.
test('C-LIVE: live_attach_rejected keeps its class, and a recovery failure keeps class, key, mode and cause', () => {
  const id = '9a1f1c9e-0b7a-4c22-9d2e-8f0b6c3d5e11';
  assert.deepEqual(safeEvent({ event: 'live_attach_rejected', liveSessionId: id, code: 'internal', class: 'TypeError' }),
    { event: 'live_attach_rejected', liveSessionId: id, code: 'internal', class: 'TypeError' });
  assert.deepEqual(safeEvent({ event: 'live_attach_rejected', liveSessionId: id, code: 'internal', class: 'Error', detail: 'connection_policy_missing_or_corrupt' }),
    { event: 'live_attach_rejected', liveSessionId: id, code: 'internal', class: 'Error', detail: 'connection_policy_missing_or_corrupt' });
  assert.deepEqual(safeEvent({ event: 'live_attach_rejected', code: 'internal', class: 'not a class name' }), { event: 'live_attach_rejected', code: 'internal' },
    'a class that is not a bare identifier is dropped');
  const failure = { event: 'live_recovery_failed', liveSessionId: id, generation: 2, mode: 'fresh_seeded', cause: 'model_mute', errorClass: 'TypeError', messageKey: 'synthetic_open_refused', attempt: 1 };
  assert.deepEqual(safeEvent(failure), failure);
  assert.equal(safeEvent({ ...failure, messageKey: 'free text from a provider' }), undefined, 'a free-text message never reaches the log');
  assert.deepEqual(safeEvent({ event: 'research_blocked', liveSessionId: id, generation: 0, action: 'continue', reason: 'no_turn_since_result' }),
    { event: 'research_blocked', liveSessionId: id, generation: 0, action: 'continue', reason: 'no_turn_since_result' });
  assert.deepEqual(safeEvent({ event: 'research_operation_deadline', liveSessionId: id, generation: 0, ms: 7_000 }),
    { event: 'research_operation_deadline', liveSessionId: id, generation: 0, ms: 7_000 });
});
