import { CONNECTOR_DESCRIPTORS } from '../connectors/index.js';
import { VAULT_TRANSPORT_PHASES } from '../tools/vault-write.js';
import { MONGOOSE_REQUEST_STAGES } from '../connectors/mongoose.js';
import { APPROVAL_REFUSAL_REASONS } from './events.js';
import { STOP_NAMES, STOP_WORD_LIMIT } from '../live/stop-phrase.js';
import { TRELLO_CALL_TOOLS, TRELLO_WRITE_ARGUMENT_FIELDS } from '../tools/trello.js';
import { clientDiagnostic } from '../http/routes.js';
import { ALARM_LOG_REASONS } from './events.js';
import { TOOL_FAILURE_CODES } from '../adapters/model/types.js';
import { TURN_FAILED_REASONS } from '../adapters/live-voice/types.js';
import { DEBT_PHASES, DEBT_REASONS } from '../trace/kinds.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { ConfigError } from '../config/files.js';
import { LOG_CAUSES, TOOL_CALL_OUTCOMES, clearLogContext, envelopeContext, monoMilliseconds, nextSeq, severityOf } from './events.js';
import { LIVE_INSTRUCTION_SECTION_IDS } from '../prompt/live-persona.js';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// The closed sets a metadata-only host diagnostic may name. Anything outside these is dropped.
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_CALL_ID = /^[A-Za-z0-9_.:~-]{1,128}$/;
/** R7: what owned a silence the owner heard: a tool call, the provider generating, or the owner's own speech. */
const SILENCE_OWNERS = ['tool', 'provider', 'owner'];
const RESEARCH_CANDIDATES = ['knowledge_search', 'calendar_window', 'mail_search', 'mail_open', 'chat_search', 'chat_thread', 'company_search', 'web_search', 'brief', 'stop_answer', 'stop_insufficient', 'memory_search'];
// R7, 1015: the warm calendar digest's own closed vocabulary. `timeout` and `stale` are states in
// their own right, so a cut-off or old read is never reported as an empty day.
const CALENDAR_DIGEST_STATES = ['present', 'empty', 'failed', 'timeout', 'unconfigured', 'stale', 'absent'];
/** L2: why the digest was read again, the same closed set the host binds its refresh hooks with. */
const CALENDAR_DIGEST_REFRESH_REASONS = ['start', 'timer', 'recovered', 'first_connect'];
// The projected Live state enum, mirrored from LivePageProjection['state'].
const LIVE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'rebuilding', 'ended', 'error'];
/** GL2-R1: why a projected state changed, a closed set, so host.log can say what moved the orb. */
export const LIVE_STATE_CAUSES = ['created', 'input', 'model_turn_start', 'audio', 'silence', 'turn_complete', 'interrupted',
  'tool', 'settle', 'rebuild', 'poll', 'ready'] as const;
/** #591: why a provider session was rebuilt, a closed set. The two watchdog tokens split a silent model from a
 *  model that owes the owner an answer; the other two name the transport causes that rebuild on their own. */
export const LIVE_REBUILD_TRIGGERS = ['no_output_after_ambient', 'no_output_after_owner', 'line_dropped', 'session_window', 'research_context'] as const;
/** C-HEADPHONES 5: the native app's closed `live_end` reasons, verbatim from NativeLiveJournal. A Stop
 *  carries one and this log repeats it, so an audio route change is never written down as the owner's
 *  own stop. A closed set: the log never prints a word the app did not send. */
export const NATIVE_END_REASONS = ['invalid_output', 'child_exit', 'logout', 'shutdown', 'user_stop', 'app_quit',
  'idle_limit', 'session_limit', 'host_failed', 'host_closed', 'audio_interruption', 'route_change',
  // C-LABELS 1: the supervised shell ended the host instead of the app asking. A crash closes stdin with
  // no stop frame, so the app never sent a word for it and the host names the loss itself.
  'shell_lost',
  // C-LABELS 2: the app held a call whose socket closed with no terminal frame. Nothing was pressed, so
  // neither the owner's Stop nor the app's Quit describes it.
  'session_lost'] as const;
/** The provider handshake steps, in the order the adapter walks them. */
const LIVE_HANDSHAKE_STEPS = ['credential_resolved', 'socket_open', 'session_start_sent', 'session_started'] as const;
/** #538: the send outcome, a closed set. The debt phases and reasons live with the trace kinds, one definition. */
const LIVE_TOOL_SEND_OUTCOMES = ['sent', 'deferred', 'failed'] as const;
const SESSION_ID = /^[0-9a-f-]{36}$/i;
/** C-LOG-ENVELOPE: the provider's own id shape, the same bound the transcription metadata already trusts. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const isProviderId = (value: unknown): boolean => typeof value === 'string' && PROVIDER_ID.test(value);
const RESEARCH_WINDOW_KINDS = ['today', 'tomorrow', 'week', 'date'];
// W13 distillation outcomes and the closed reason/error tokens they may name, never any summary text.
const SUMMARY_EVENTS = new Set(['conversation_summary_started', 'conversation_summary_completed', 'conversation_summary_failed', 'conversation_summary_skipped']);
const SUMMARY_REASONS = ['non_ordinary', 'too_few_turns', 'model_skip', 'no_text_model', 'history_provenance_unavailable', 'summary_route_class_denied'];
/** C-SUMMARY8: the only phase a summary line may name; the per-call schedule names none. */
const SUMMARY_PHASES = ['at_start'];
/** S4a: why a progress line was sent, as a closed set (never free text). */
const PROGRESS_REASONS = ['dead_air', 'stalled', 'lookup'];
/** W4: why a progress decision stayed silent, as a closed set (never free text, never the line itself). */
const PROGRESS_SKIP_REASONS = ['settled', 'no_channel', 'budget', 'interval', 'no_call_in_flight', 'owner_speaking',
  'answer_playing', 'no_content', 'send_failed', 'no_delegation'];
/** S4a-R2 (a): how a call settled at the host ceiling, and how a late callback reported itself. A call the
 *  provider cancelled never settles at the ceiling: its own `tool_cancelled` receipt names it, with no answer. */
const CEILING_OUTCOMES = ['timeout', 'uncertain'];
const LATE_OUTCOMES = ['completed', 'failed'];
/** S4a-R4: the command families a rejected client event id can name. */
const COMMAND_KINDS = ['tool_out', 'cont', 'cmt', 'thk', 'other'];
const isSafeToken = (value: unknown): value is string => typeof value === 'string' && SAFE_TOKEN.test(value);
/** W1: the Mongoose sign-in hops and the closed outcomes each may name (MongooseSignInHop in host/mongoose-login.ts). */
const SIGNIN_ENDPOINTS = ['knowledge', 'data', 'crm', 'trello'];
const SIGNIN_OUTCOMES: Record<string, readonly string[]> = {
  signin_requested: ['started', 'reopened', 'in_progress', 'not_configured'],
  signin_discovery: ['ok', 'config_invalid', 'unreachable', 'redirected', 'http_status', 'not_json', 'resource_mismatch', 'server_untrusted', 'metadata_unreachable', 'metadata_invalid', 'issuer_mismatch', 'endpoint_off_origin', 'timeout'],
  signin_registration: ['ok', 'port_in_use', 'refused', 'timeout'],
  signin_browser_handoff: ['ok', 'unavailable', 'timeout'],
  signin_callback: ['ok', 'state_mismatch', 'authorization_refused', 'account_mismatch', 'timeout'],
  signin_token: ['ok', 'refused', 'unreachable', 'timeout', 'identity_mismatch', 'identity_unverified'],
  signin_stored: ['ok', 'failed'],
  // H20: one closing line per attempt, whether it signed in or failed on a closed reason.
  signin_finished: ['signed_in', 'discovery_unreachable', 'discovery_refused', 'registration_refused', 'port_in_use',
    'browser_unavailable', 'callback_failed', 'callback_timeout', 'account_mismatch', 'token_refused', 'store_failed', 'did_not_finish'],
  // C-SIGNIN-LIVE: a sign-in that landed but left its endpoint unconnected in place, and why. The
  // reason is the endpoint row's own closed code, never free text, so a relaunch is never silent.
  signin_needs_restart: ['not_signed_in', 'needs_sign_in', 'credential_missing', 'credential-missing', 'credential-refresh-failed',
    'credential-consent-expired', 'credential-unavailable', 'credential-identity-mismatch', 'credential-identity-unverified',
    'identity_mismatch', 'handshake_failed', 'discovery_failed', 'unreachable', 'transport_unavailable', 'not_connected', 'schema_unsanitizable', 'connect_timeout'],
};
const SIGNIN_OAUTH_ERRORS = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'invalid_target', 'access_denied'];
/**
 * W7: the Trello board tool actions and the closed reasons a call may name (TRELLO_GUIDANCE in tools/trello.ts).
 * F12: the tool names are built from the tool module's own closed lists, so a new read view or write action
 * is logged instead of being dropped here without a trace.
 */
const TRELLO_CALL_TOOL = new RegExp(`^(?:${TRELLO_CALL_TOOLS.map(tool => tool.replace('.', '\\.')).join('|')})$`);
const TRELLO_CALL_REASONS = ['not_configured', 'not_signed_in', 'auth_failed', 'credential_revoked', 'credential_mismatch', 'rate_limited', 'unavailable', 'board_not_found', 'board_ambiguous', 'unsupported', 'result_unrecognized', 'outside_scope',
  'list_unknown', 'list_ambiguous', 'card_unknown', 'card_ambiguous', 'label_unknown', 'item_unknown', 'invalid_due', 'description_full', 'not_owner_requested', 'no_change', 'write_failed', 'outcome_unknown', 'replayed',
  'plan_no_tool', 'plan_bad_args', 'plan_no_action', 'dispatch_not_allowed',
  ...['not_signed_in', 'auth_failed', 'credential_revoked', 'credential_mismatch', 'rate_limited', 'unavailable', 'unknown', 'protocol_error', 'not_allowed'].map(code => `server_${code}`),
  'server_tool_error:unknown',
  // HTTP status is a bounded integer, never response text, a path or an account value.
  ...['tool_error', 'credential_revoked', 'rate_limited', 'unavailable'].flatMap(code => Array.from({ length: 200 }, (_, offset) => `server_${code}:http_${400 + offset}`))];
const isSafeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);
/**
 * #689: the live owner stamps a research event's callKey with `scopedTraceKey`, `call:` plus the 64 lowercase hex
 * of a sha256. That shape is closed, so it can carry no text and no provider id can imitate it; SAFE_ID stays as it
 * is for every other field. A plain safe id is still accepted, because the ledger also carries provider call ids.
 */
const SCOPED_CALL_KEY = /^call:[0-9a-f]{64}$/;
const isCallKey = (value: unknown): value is string => isSafeId(value) || (typeof value === 'string' && SCOPED_CALL_KEY.test(value));
/**
 * Z1: a research line whose id fails SAFE_ID used to be dropped whole, so a run that really happened left
 * no receipt and read as a run that never happened. The replacement names the event and the field only,
 * never the value.
 */
const rejectResearchId = (event: string): Record<string, unknown> => ({ event: 'research_id_rejected', kind: event, field: 'researchId' });
const isTrelloNormalizedPaths = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
  && value.every(path => typeof path === 'string' && TRELLO_WRITE_ARGUMENT_FIELDS.includes(path));
const isSafeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** C-PITCH: a fundamental frequency in Hz, or null when the response had no voiced frames. */
const isSafeHz = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 20 && value <= 2000);
/** C-PITCH: a measurement ratio (voiced frames over analyzed frames, a pitch over a pitch). */
const isSafeRatio = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000;
/** C-CONTINUITY R-09: a socket close code, the range the protocol allows, or null before the socket answered. */
const isSafeCloseCode = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 65535);
/** C-CONTINUITY R-09: a sanitized close reason: one bounded line of ordinary text, never free payload. */
const isSafeCloseReason = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value);
/** A provider frame name: lowercase dots and underscores, as the Live reference writes them, never free text. */
const UNKNOWN_FRAME_TYPE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
const isSafeMember = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value);
/** C-LOGS11: why one latency field is absent. A closed set, so "missing" is never printed as a duration. */
const AUDIBLE_MISSING_REASONS = ['no_owner_final', 'no_native_receipt'];
/** LAT-1022: the closed rule that declared the owner's speech over: the plain quiet rule, or the longer one a
 *  hesitation buys. A bound the host never reaches writes no line at all. */
const SPEECH_END_REASONS = ['quiet', 'hesitation'];
const isSafeMembers = (value: unknown, allowed: readonly string[]): value is string[] => Array.isArray(value) && value.length <= 16 && value.every(item => isSafeMember(item, allowed));

/** A closed shape: exactly these keys, so no field a later caller adds can slip through the whitelist. */
const isSafeWord = (value: unknown): value is string => typeof value === 'string' && SAFE_TOKEN.test(value);
const closedKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
/**
 * C-DIAG109: the closed pair a stall or rebuild line may carry about the response the owner final earned.
 * The two fields arrive together or not at all: a created response has an age, an absent one has none.
 */
const responsePair = (value: Record<string, unknown>): { responseCreated: boolean; msSinceResponseCreated: number | null } | Record<string, never> | undefined => {
  if (!Object.hasOwn(value, 'responseCreated')) return {};
  if (typeof value.responseCreated !== 'boolean') return undefined;
  if (value.responseCreated) {
    return isSafeCount(value.msSinceResponseCreated) ? { responseCreated: true, msSinceResponseCreated: value.msSinceResponseCreated } : undefined;
  }
  return value.msSinceResponseCreated === null ? { responseCreated: false, msSinceResponseCreated: null } : undefined;
};
/** #613: the launch paths the app can report, mirrored from LaunchKind, so no free text crosses. */
const LAUNCH_KINDS = ['interactive', 'login_item', 'install_relaunch', 'installed_proof', 'self_check', 'ui_proof', 'verification', 'alarm_relaunch'];
/** W5: the closed error classes a thrown tool handler may name (tools/declarations.ts). */
const TOOL_HANDLER_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'SqliteError', 'Unknown'];

/** C-ALARMSPEECH: the closed reasons an alarm call can fail to open. The shell and the host log name the
 * same small set, so a silent release is impossible and no free text reaches the log. */
export const ALARM_SPEECH_FAILED_REASONS = ['snapshot_mismatch', 'create_refused', 'create_unknown', 'audio_failed', 'socket_lost', 'already_live', 'start_refused'] as const;
export type AlarmSpeechFailedReason = typeof ALARM_SPEECH_FAILED_REASONS[number];

// Only the existing diagnostic schemas cross this boundary, never arbitrary console text.
export function safeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (value.event === 'task_delivery') {
    if (!closedKeys(value, ['event', 'taskId', 'revision', 'state']) ||
      typeof value.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.taskId) || !isSafeCount(value.revision) ||
      !['sent', 'accepted', 'heard', 'retry', 'reconnect', 'undelivered'].includes(String(value.state))) return;
    return { event: 'task_delivery', taskId: value.taskId, revision: value.revision, state: value.state };
  }
  if (value.event === 'task_lifecycle') {
    if (!closedKeys(value, ['event', 'phase', 'taskId', 'revision', 'generation', 'count', 'ms']) ||
      !['start', 'revision', 'inference', 'calls', 'dedupe', 'deadline', 'cancel', 'complete', 'stale', 'delivery'].includes(String(value.phase)) ||
      typeof value.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.taskId) || !isSafeCount(value.generation) ||
      !isSafeCount(value.revision) || !isSafeCount(value.count) || !isSafeCount(value.ms)) return;
    return { event: 'task_lifecycle', phase: value.phase, taskId: value.taskId, generation: value.generation, revision: value.revision, count: value.count, ms: value.ms };
  }
  if (value.event === 'host_ready_ms') {
    if (!closedKeys(value, ['event', 'ms']) || !isSafeCount(value.ms)) return;
    return { event: 'host_ready_ms', ms: value.ms };
  }
  if (value.event === 'alarm_model_time_ignored') {
    if (!closedKeys(value, ['event', 'skewMs']) || !Number.isSafeInteger(value.skewMs)) return;
    return { event: 'alarm_model_time_ignored', skewMs: value.skewMs };
  }
  if (value.event === 'alarm_time_corrected') {
    // C-TIME: which source settled the instant, as closed words only, never a time or a label.
    if (!closedKeys(value, ['event', 'corrected', 'source']) || !isSafeWord(value.corrected) || !isSafeWord(value.source)) return;
    return { event: 'alarm_time_corrected', corrected: value.corrected, source: value.source };
  }
  if (value.event === 'alarm_scheduler_started') {
    // #751: a count only. A label or a time here would be the owner's schedule in the diagnostic log.
    if (!closedKeys(value, ['event', 'pending']) || !isSafeCount(value.pending)) return;
    return { event: 'alarm_scheduler_started', pending: value.pending };
  }
  if (value.event === 'alarm_set' || value.event === 'alarm_due' || value.event === 'alarm_ring_started'
    || value.event === 'alarm_acknowledged' || value.event === 'alarm_missed' || value.event === 'alarm_degraded') {
    if (typeof value.alarmId !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(value.alarmId)
      || typeof value.scheduledMs !== 'number' || !Number.isFinite(value.scheduledMs)
      || typeof value.actualMs !== 'number' || !Number.isFinite(value.actualMs)
      || !ALARM_LOG_REASONS.some(reason => reason === value.reason)) return;
    // #108: a refused idle sleep assertion carries the IOKit status, a count and never a label.
    const assertionCode = value.event === 'alarm_degraded' && value.reason === 'assertion_failed'
      && typeof value.assertionCode === 'number' && Number.isInteger(value.assertionCode) ? value.assertionCode : undefined;
    return { event: value.event, alarmId: value.alarmId, scheduledMs: value.scheduledMs, actualMs: value.actualMs, reason: value.reason,
      ...(assertionCode === undefined ? {} : { assertionCode }) };

  }
  if (value.event === 'alarm_announced') {
    // #107: the alarm block reached the provider. The proof that she was asked to speak, and how.
    if (!closedKeys(value, ['alarmId', 'event', 'mode'])) return;
    if (typeof value.alarmId !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(value.alarmId)) return;
    if (value.mode !== 'new_session' && value.mode !== 'in_call') return;
    return { event: 'alarm_announced', alarmId: value.alarmId, mode: value.mode };
  }
  if (value.event === 'alarm_speech_failed') {
    // C-ALARMSPEECH: she could not open, so the line names the alarm and one closed reason, never the label.
    if (!closedKeys(value, ['alarmId', 'event', 'reason'])) return;
    if (typeof value.alarmId !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(value.alarmId)) return;
    if (!ALARM_SPEECH_FAILED_REASONS.some(reason => reason === value.reason)) return;
    return { event: 'alarm_speech_failed', alarmId: value.alarmId, reason: value.reason };
  }
  if (value.event === 'alarm_relaunch_scheduled') {
    // #107: the one relaunch agent is armed for the next due time, in seconds from now.
    if (!closedKeys(value, ['dueInS', 'event'])) return;
    if (!Number.isSafeInteger(value.dueInS) || (value.dueInS as number) < 0) return;
    return { event: 'alarm_relaunch_scheduled', dueInS: value.dueInS };
  }
  if (value.event === 'alarm_relaunch_removed') {
    // #107: nothing is pending, so the relaunch agent is gone.
    if (!closedKeys(value, ['event'])) return;
    return { event: 'alarm_relaunch_removed' };
  }
  if (value.event === 'alarm_relaunch_failed') {
    // #107: launchd refused the agent, so a quit app would not come back for the next alarm.
    if (!closedKeys(value, ['event'])) return;
    return { event: 'alarm_relaunch_failed' };
  }
  if (value.event === 'tool_diagnostic_capture') {
    const reasons = ['context_absent','coverage_write_failed','insert_write_failed','seal_write_failed','reuse_context_absent','reuse_write_failed','execution_not_active_or_scope_changed','insert_failed_wire_observed','insert_failed_pre_wire_refused','insert_failed_dispatch_unknown','wire_observed_context_absent','pre_wire_context_absent','dispatch_unknown_context_absent'];
    const identity = (v: unknown): boolean => v === null || (typeof v === 'string' && /^[a-zA-Z0-9:_-]{1,256}$/.test(v));
    if (typeof value.reason !== 'string' || !reasons.includes(value.reason) || !identity(value.runId) || !identity(value.executionId)) return;
    return {event:'tool_diagnostic_capture',reason:value.reason,runId:value.runId,executionId:value.executionId};
  }
  if (value.event === 'tool_failure') {
    const codes: readonly string[] = TOOL_FAILURE_CODES;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    if (typeof value.code !== 'string' || !codes.includes(value.code) || !token(value.tool) || !token(value.connector)
      || !['Error', 'SyntaxError', 'UnknownThrow', 'McpResultError'].includes(String(value.errorClass))
      || value.messageHead !== value.code || String(value.messageHead).length > 120) return;
    return { event: 'tool_failure', code: value.code, tool: value.tool, connector: value.connector, errorClass: value.errorClass, messageHead: value.messageHead };
  }
  if (value.event === 'chat_timing') {
    // Timing receipts: milliseconds and counts only, never text, never a tool argument or result.
    const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/.test(v);
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    const ms = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 900_000;
    if (!id(value.runId) || !['answered', 'fenced'].includes(String(value.outcome))) return;
    if (!Array.isArray(value.rounds) || value.rounds.length > 8 || !value.rounds.every(ms)) return;
    if (!Array.isArray(value.tools) || value.tools.length > 32) return;
    const tools: { tool: string; ok: boolean; ms: number }[] = [];
    for (const entry of value.tools) {
      const item = entry as Record<string, unknown>;
      if (!token(item.tool) || typeof item.ok !== 'boolean' || !ms(item.ms)) return;
      tools.push({ tool: item.tool, ok: item.ok, ms: item.ms });
    }
    if (!ms(value.fenceMs) || !ms(value.acquireMs) || !ms(value.answerMs)) return;
    return { event: 'chat_timing', runId: value.runId, outcome: value.outcome, rounds: [...value.rounds],
      tools, fenceMs: value.fenceMs, acquireMs: value.acquireMs, answerMs: value.answerMs };
  }
  if (value.event === 'people_loaded') {
    // W15: the roster receipt is counts and bytes only, never a name from the file.
    if (!closedKeys(value, ['bytes', 'chars', 'count', 'event'])) return;
    if (![value.count, value.bytes, value.chars].every(entry => Number.isSafeInteger(entry) && (entry as number) >= 0)) return;
    return { event: 'people_loaded', count: value.count, bytes: value.bytes, chars: value.chars };
  }
  if (value.event === 'people_invalid') {
    // W15: a malformed roster fails loud with its closed reason code, and the roster stays absent.
    if (!closedKeys(value, ['event', 'reason'])) return;
    if (typeof value.reason !== 'string' || !/^[a-z0-9_]{1,40}$/.test(value.reason)) return;
    return { event: 'people_invalid', reason: value.reason };
  }
  if (value.event === 'lux_note_stage') {
    // W5: one composed-note stage receipt. The digest of the frozen payload, or the closed refusal
    // code, and nothing of the note itself.
    const hasDigest = value.digest !== undefined;
    if (!closedKeys(value, ['event', 'staged', ...(hasDigest ? ['digest'] : ['code'])])) return;
    if (typeof value.staged !== 'boolean') return;
    if (value.staged === true && (typeof value.digest !== 'string' || !/^[a-f0-9]{12}$/.test(value.digest))) return;
    if (value.staged === false && !isSafeToken(value.code)) return;
    return value.staged === true
      ? { event: 'lux_note_stage', staged: true, digest: value.digest }
      : { event: 'lux_note_stage', staged: false, code: value.code };
  }
  if (value.event === 'lux_note_readback' || value.event === 'lux_note_confirm') {
    // W5: the note's state machine and its closed reason code, never the note. An empty code is the
    // confirm path's "no code yet" and keeps its own shape.
    if (!closedKeys(value, ['code', 'event', 'state'])) return;
    if (!isSafeToken(value.state)) return;
    if (typeof value.code !== 'string' || (value.code !== '' && !isSafeToken(value.code))) return;
    return { event: value.event, state: value.state, code: value.code };
  }
  if (value.event === 'lux_note_saved') {
    // W5: whether the frozen payload reached the vault, and the closed code that says why not.
    if (!closedKeys(value, ['code', 'event', 'saved'])) return;
    if (typeof value.saved !== 'boolean' || !isSafeToken(value.code)) return;
    return { event: 'lux_note_saved', saved: value.saved, code: value.code };
  }
  if (value.event === 'tool_handler_error') {
    // W5: a handler threw after dispatch. A tool name, an error class from a closed list and the
    // recorded closed reason; never the error's message, stack or a provider string.
    if (!closedKeys(value, ['class', 'event', 'reason', 'tool'])) return;
    if (!isSafeToken(value.tool) || !isSafeToken(value.reason)) return;
    if (typeof value.class !== 'string' || !TOOL_HANDLER_CLASSES.includes(value.class)) return;
    return { event: 'tool_handler_error', tool: value.tool, class: value.class, reason: value.reason };
  }
  if (value.event === 'notes_export') {
    // W5: the exporter's own counts and an 8 hex run id, never a note or a path.
    if (!closedKeys(value, ['event', 'exported', 'failed', 'id', 'remaining', 'skipped', 'unknown'])) return;
    if (![value.exported, value.skipped, value.failed, value.unknown, value.remaining].every(isSafeCount)) return;
    if (typeof value.id !== 'string' || !/^[a-f0-9]{8}$/.test(value.id)) return;
    return { event: 'notes_export', exported: value.exported, skipped: value.skipped, failed: value.failed,
      unknown: value.unknown, remaining: value.remaining, id: value.id };
  }
  if (value.event === 'consumer_detach') {
    // W5: the consumer's state, whether an answer was owed, and how many calls stayed open.
    if (!closedKeys(value, ['awaitingAnswer', 'consumerState', 'event', 'openCalls'])) return;
    if (!isSafeMember(value.consumerState, ['detached', 'attached', 'ended', 'backpressure'])) return;
    if (typeof value.awaitingAnswer !== 'boolean' || !isSafeCount(value.openCalls)) return;
    return { event: 'consumer_detach', consumerState: value.consumerState, awaitingAnswer: value.awaitingAnswer, openCalls: value.openCalls };
  }
  if (value.event === 'late_findings_sent') {
    // W5: which delegation was late and the closed reason it was sent under.
    if (!closedKeys(value, ['delegationKey', 'event', 'reason'])) return;
    if (!isSafeId(value.delegationKey) || !isSafeToken(value.reason)) return;
    return { event: 'late_findings_sent', delegationKey: value.delegationKey, reason: value.reason };
  }
  if (value.event === 'live_detach_write_failed') {
    // W5: the session whose detach row failed to write, and the closed class of the failure.
    if (!closedKeys(value, ['class', 'event', 'liveSessionId'])) return;
    if (!isSafeId(value.liveSessionId) || !isSafeToken(value.class)) return;
    return { event: 'live_detach_write_failed', liveSessionId: value.liveSessionId, class: value.class };
  }
  if (value.event === 'people_trimmed') {
    // W15: how many roster lines the section ceiling dropped, and how many of them were tier 2.
    if (!closedKeys(value, ['dropped', 'event', 'tier2'])) return;
    if (![value.dropped, value.tier2].every(entry => Number.isSafeInteger(entry) && (entry as number) >= 0)) return;
    return { event: 'people_trimmed', dropped: value.dropped, tier2: value.tier2 };
  }
  if (value.event === 'launch_kind') {
    // #613: which launch opened the app and the two flags it decides. Closed set, metadata only.
    const allowed = ['autoConnects', 'event', 'kind', 'windowShown'];
    if (!closedKeys(value, allowed)) return;
    if (typeof value.kind !== 'string') return;
    if (!LAUNCH_KINDS.includes(value.kind)) return;
    if (typeof value.autoConnects !== 'boolean' || typeof value.windowShown !== 'boolean') return;
    return { event: 'launch_kind', kind: value.kind, autoConnects: value.autoConnects, windowShown: value.windowShown };
  }
  if (value.event === 'knowledge_autopen') {
    // C-POLISH10: whether the knowledge leg opened a hit nobody asked for, as a decision, a score bucket and a
    // closed reason, never the ask or the entry's title.
    if (!closedKeys(value, ['bucket', 'decision', 'event', 'reason'])) return;
    if (value.decision !== 'opened' && value.decision !== 'skipped') return;
    if (!['high', 'medium', 'low', 'unknown'].includes(String(value.bucket))) return;
    if (!['low_score', 'no_overlap', 'none'].includes(String(value.reason))) return;
    return { event: 'knowledge_autopen', decision: value.decision, bucket: value.bucket, reason: value.reason };
  }
  if (value.event === 'gate_decision') {
    // C-NOTEGATE (#828): the free gate's answer as closed fields: which tool, which decision, which closed
    // code, the two fence positions and whether any owner final existed. Never a word of his.
    if (!closedKeys(value, ['code', 'decision', 'event', 'exposure', 'owner', 'ownerFinal', 'tool'])) return;
    if (!isSafeWord(value.tool) || !isSafeWord(value.code)) return;
    if (value.decision !== 'allowed' && value.decision !== 'refused') return;
    if (!isSafeCount(value.owner) || !isSafeCount(value.exposure)) return;
    if (typeof value.ownerFinal !== 'boolean') return;
    return { event: 'gate_decision', tool: value.tool, decision: value.decision, code: value.code,
      owner: value.owner, exposure: value.exposure, ownerFinal: value.ownerFinal };
  }
  // W1030/WT-R2: the write tools' grant and its spend reach the audit trail beside the read tools'.
  if (['open_audit', 'alarm_audit', 'lux_note_audit', 'compose_audit'].includes(String(value.event)) && 'grantKind' in value) {
    if (Object.keys(value).sort().join(',') !== ['event', 'ownerFinals', 'requestAgeMs', 'grantKind', 'grantState', 'refusalCode'].sort().join(',')) return;
    if (!Number.isInteger(value.ownerFinals) || Number(value.ownerFinals) < 0 || !Number.isFinite(value.requestAgeMs) || Number(value.requestAgeMs) < 0) return;
    if (!['open', 'set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm', 'lux_note', 'draft_email', 'draft_chat', 'create_event', 'delete_event'].includes(String(value.grantKind))) return;
    if (!['absent', 'available', 'spent'].includes(String(value.grantState))) return;
    if (typeof value.refusalCode !== 'string' || !/^[a-z_]{1,64}$/.test(value.refusalCode)) return;
    return { event: value.event, ownerFinals: value.ownerFinals, requestAgeMs: value.requestAgeMs, grantKind: value.grantKind, grantState: value.grantState, refusalCode: value.refusalCode };
  }

  if (value.event === 'native_action') {
    // Closed receipt: the action, its ack code and a scheme or extension, never the target.
    const allowed = ['action', 'code', 'detail', 'event'];
    if (Object.keys(value).sort().join(',') !== allowed.join(',')) return;
    if (typeof value.action !== 'string' || !['open_url', 'open_file', 'open_app'].includes(value.action)) return;
    if (typeof value.code !== 'string' || !['opened', 'not_allowed', 'not_found', 'failed', 'no_open_intent', 'kind_mismatch'].includes(value.code)) return;
    if (typeof value.detail !== 'string' || !/^[a-z0-9]{1,16}$/.test(value.detail)) return;
    return { event: 'native_action', action: value.action, code: value.code, detail: value.detail };
  }
  if (value.event === 'open_resolve') {
    // F6a: what the resolver answered and how long it took, in closed words only.
    if (Object.keys(value).sort().join(',') !== ['event', 'ms', 'outcome', 'target'].join(',')) return;
    if (!Number.isSafeInteger(value.ms) || Number(value.ms) < 0 || Number(value.ms) > 600_000) return;
    if (!['web', 'source', 'file'].includes(String(value.target))) return;
    if (!['opened', 'not_found', 'ambiguous', 'not_allowed', 'no_open_intent', 'not_owner_words', 'failed'].includes(String(value.outcome))) return;
    return { event: 'open_resolve', target: value.target, outcome: value.outcome, ms: value.ms };
  }
  if (value.event === 'live_claim_without_call') {
    // C-TURN8: a claim the turn never acted on is counted from the turn's sequence and its bound, nothing else.
    if (Object.keys(value).sort().join(',') !== ['event', 'ms', 'sequence'].join(',')) return;
    if (!isSafeCount(value.sequence) || !isSafeCount(value.ms)) return;
    return { event: 'live_claim_without_call', sequence: value.sequence, ms: value.ms };
  }
  if (value.event === 'live_tool_refused') {
    // C-TURN8: a tool the host refused before the owner spoke, by name and closed reason, never an argument.
    if (Object.keys(value).sort().join(',') !== ['event', 'reason', 'sequence', 'tool'].join(',')) return;
    if (!isSafeCount(value.sequence) || !SAFE_TOKEN.test(String(value.tool)) || value.reason !== 'no_owner_input') return;
    return { event: 'live_tool_refused', sequence: value.sequence, tool: value.tool, reason: value.reason };
  }
  if (value.event === 'owner_final') {
    // C-LOGS11: when the owner's final transcription of a turn landed, on the wall clock, as epoch ms. The
    // turn it belongs to is the envelope's turnId; no word of what he said is on the line.
    // LAT-1022: and, when the capture path had already declared the end of speech, how long after it the final
    // landed, so the first segment of the turn is measured instead of inferred from the quiet rule's constant.
    const hasSpeechMs = Object.prototype.hasOwnProperty.call(value, 'msSinceSpeechEnd');
    if (!closedKeys(value, ['event', 'ownerFinalAt', ...(hasSpeechMs ? ['msSinceSpeechEnd'] : [])])) return;
    if (!isSafeCount(value.ownerFinalAt)) return;
    if (hasSpeechMs && !isSafeCount(value.msSinceSpeechEnd)) return;
    return { event: 'owner_final', ownerFinalAt: value.ownerFinalAt, ...(hasSpeechMs ? { msSinceSpeechEnd: value.msSinceSpeechEnd as number } : {}) };
  }
  if (value.event === 'owner_speech_end') {
    // LAT-1022: the capture path's own voice-activity end of speech, on the monotonic clock the audio path runs
    // on and on the wall clock beside it, with the closed rule that declared it. The session and the turn are
    // the envelope's; no audio, no level and no word ever rides this line.
    if (!closedKeys(value, ['event', 'monoMs', 'wallMs', 'reason'])) return;
    if (!isSafeCount(value.monoMs) || !isSafeCount(value.wallMs)) return;
    if (!isSafeMember(value.reason, SPEECH_END_REASONS)) return;
    return { event: 'owner_speech_end', monoMs: value.monoMs, wallMs: value.wallMs, reason: value.reason };
  }
  if (value.event === 'tool_call_admitted' || value.event === 'tool_call_dispatched') {
    // C-LOGS11: one tool call entering the host and leaving toward its source, by call key and tool name,
    // never an argument. The key is stable across admit, dispatch and outcome.
    if (!closedKeys(value, ['callKey', 'event', 'tool'])) return;
    if (typeof value.callKey !== 'string' || !SAFE_CALL_ID.test(value.callKey)) return;
    if (typeof value.tool !== 'string' || !SAFE_TOKEN.test(value.tool)) return;
    return { event: value.event, callKey: value.callKey, tool: value.tool };
  }
  if (value.event === 'tool_call_outcome') {
    // Business outcomes have bounded tool-owned codes, including clarification and handler failures.
    // A missing code stays absent. `ms` is the host's own
    // measured duration when it has one, and the field is absent when it does not, never a zero.
    const withCode = value.refusalCode !== undefined;
    const withMs = value.ms !== undefined;
    if (!closedKeys(value, ['callKey', 'event', 'outcome', 'tool', ...(withMs ? ['ms'] : []), ...(withCode ? ['refusalCode'] : [])])) return;
    if (typeof value.callKey !== 'string' || !SAFE_CALL_ID.test(value.callKey)) return;
    if (typeof value.tool !== 'string' || !SAFE_TOKEN.test(value.tool)) return;
    if (!isSafeMember(value.outcome, TOOL_CALL_OUTCOMES)) return;
    if (withMs && !isSafeCount(value.ms)) return;
    if (withCode && (typeof value.refusalCode !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value.refusalCode))) return;
    // Success and empty results carry no refusal or failure code.
    if (withCode && (value.outcome === 'completed' || value.outcome === 'empty')) return;
    return { event: 'tool_call_outcome', callKey: value.callKey, tool: value.tool, outcome: value.outcome,
      ...(withMs ? { ms: value.ms } : {}), ...(withCode ? { refusalCode: value.refusalCode } : {}) };
  }
  if (value.event === 'live_first_audible') {
    // C-LOGS11: the native audibility receipt for a turn's first audible segment, as a duration from the
    // owner's final words. A turn whose final was never recorded says why, never zero.
    if (!closedKeys(value, ['event', 'finalToAudibleMs', 'missingReason'])) return;
    if (!(value.finalToAudibleMs === null || isSafeCount(value.finalToAudibleMs))) return;
    if (!(value.missingReason === null || isSafeMember(value.missingReason, AUDIBLE_MISSING_REASONS))) return;
    return { event: 'live_first_audible', finalToAudibleMs: value.finalToAudibleMs, missingReason: value.missingReason };
  }
  if (value.event === 'open_claim_corrected') {
    // Open2: the correction is counted, never quoted: one closed reason, no words of hers.
    if (Object.keys(value).sort().join(',') !== ['event', 'reason'].join(',')) return;
    if (!['no_receipt', 'kind_mismatch'].includes(String(value.reason))) return;
    return { event: 'open_claim_corrected', reason: value.reason };
  }
  if (value.event === 'tool_redaction') {
    // The receipt names the tool and the count of secrets, never the value.
    if (Object.keys(value).sort().join(',') !== ['count', 'event', 'tool'].sort().join(',')) return;
    if (!SAFE_TOKEN.test(String(value.tool)) || typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1 || value.count > 1_000_000) return;
    return { event: 'tool_redaction', tool: value.tool, count: value.count };
  }
  if (value.event === 'debug_journal_removed') {
    // #487: the retired JSONL journal (transcripts and full instructions) is removed at start. The
    // receipt carries the size removed and never a path, a session id or a byte of its content.
    if (!closedKeys(value, ['bytes', 'event'])) return;
    if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) return;
    return { event: 'debug_journal_removed', bytes: value.bytes };
  }
  if (value.event === 'debug_journal_removal_failed') {
    // #487: a sweep that could not finish is one closed line with an errno token, never a path.
    if (!closedKeys(value, ['code', 'event'])) return;
    if (typeof value.code !== 'string' || !/^[a-z0-9]{1,16}$/.test(value.code)) return;
    return { event: 'debug_journal_removal_failed', code: value.code };
  }
  if (value.event === 'clock_sync') {
    // C-LOG-ENVELOPE: one line per host start and per call open. append adds the wall time and this
    // process's monoMs, so the line carries only which clock event it dates.
    if (!closedKeys(value, ['event', 'reason'])) return;
    if (value.reason !== 'host_start' && value.reason !== 'call_open') return;
    return { event: 'clock_sync', reason: value.reason };
  }
  if (value.event === 'live_trace_rejected') {
    // O1b-A: the trace store's own receipt for a refused write: the kind and the store's typed code only,
    // never a payload. It replaces the debug journal's error receipt in the same slot in this whitelist.
    if (Object.keys(value).sort().join(',') !== ['code', 'event', 'kind'].sort().join(',')) return;
    if (!isSafeToken(value.kind) || !isSafeToken(value.code)) return;
    return { event: 'live_trace_rejected', kind: value.kind, code: value.code };
  }
  if (value.event === 'mongoose_tool_schema_refused') {
    if (!closedKeys(value, ['event', 'endpointId', 'tool'])) return;
    if (!isSafeId(value.endpointId)) return;
    if (typeof value.tool !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(value.tool)) return;
    return { event: value.event, endpointId: value.endpointId, tool: value.tool };
  }
  if (value.event === 'live_tools_incomplete') {
    if (Object.keys(value).sort().join(',') !== 'event,groups' || !Array.isArray(value.groups)
      || value.groups.length === 0 || value.groups.length > Object.keys(CONNECTOR_DESCRIPTORS).length) return;
    const seen = new Set<string>();
    for (const group of value.groups) {
      if (!group || typeof group !== 'object' || Object.keys(group).sort().join(',') !== 'connector,missingEndpoints,missingTools,reason'
        || typeof group.connector !== 'string' || !Object.hasOwn(CONNECTOR_DESCRIPTORS, group.connector) || seen.has(group.connector)
        || !Number.isSafeInteger(group.missingEndpoints) || group.missingEndpoints < 1
        || !Number.isSafeInteger(group.missingTools) || group.missingTools < 0
        || !['deadline', 'failed'].includes(group.reason)) return;
      seen.add(group.connector);
    }
    return { event: 'live_tools_incomplete', groups: value.groups.map(group => ({ connector: group.connector,
      missingEndpoints: group.missingEndpoints, missingTools: group.missingTools, reason: group.reason })) };
  }
  if (value.event === 'connector_failure') {
    // Closed connect-time stage only, never a message, a URL or a credential value. The diagnostic
    // fields are bounded tokens; a free-text reason or an out-of-vocabulary attempt drops the event.
    const stages = ['config', 'credential', 'spawn', 'handshake', 'first_call'];
    const attempts = ['first-connect', 'refresh'];
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    const hasReason = Object.prototype.hasOwnProperty.call(value, 'reason');
    const hasExceptionClass = Object.prototype.hasOwnProperty.call(value, 'exceptionClass');
    const hasException = Object.prototype.hasOwnProperty.call(value, 'exceptionCode');
    const hasEndpoint = Object.prototype.hasOwnProperty.call(value, 'endpointId');
    const hasAttempt = Object.prototype.hasOwnProperty.call(value, 'attempt');
    const allowed = ['connector', 'event', 'stage', ...(hasExceptionClass ? ['exceptionClass'] : []), ...(hasReason ? ['reason'] : []), ...(hasException ? ['exceptionCode'] : []), ...(hasEndpoint ? ['endpointId'] : []), ...(hasAttempt ? ['attempt'] : [])];
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) return;
    if (!token(value.connector) || typeof value.stage !== 'string' || !stages.includes(value.stage)) return;
    if (hasExceptionClass && !['refused', 'dns', 'tls', 'timeout', 'http_4xx', 'http_5xx', 'transport', 'unknown'].includes(String(value.exceptionClass))) return;
    if (hasReason && !token(value.reason)) return;
    if (hasException && !token(value.exceptionCode)) return;
    if (hasEndpoint && !isSafeId(value.endpointId)) return;
    if (hasAttempt && (typeof value.attempt !== 'string' || !attempts.includes(value.attempt))) return;
    return { event: 'connector_failure', connector: value.connector, stage: value.stage, ...(hasExceptionClass ? { exceptionClass: value.exceptionClass } : {}), ...(hasReason ? { reason: value.reason } : {}), ...(hasException ? { exceptionCode: value.exceptionCode } : {}), ...(hasEndpoint ? { endpointId: value.endpointId } : {}), ...(hasAttempt ? { attempt: value.attempt } : {}) };
  }
  if (value.event === 'tool_classified_failure') {
    // W14 (LOGS.md L-08): one row per call the connector itself refused with a typed code, so host.log
    // tells a failed read from an empty one. The endpoint id, the connector, the tool and the code only:
    // never an argument, a payload, a query or a line of helper text.
    if (!closedKeys(value, ['code', 'connector', 'endpointId', 'event', 'tool'])) return;
    if (!isSafeId(value.endpointId) || !isSafeToken(value.tool) || !isSafeToken(value.connector) || !isSafeToken(value.code)) return;
    return { event: 'tool_classified_failure', endpointId: value.endpointId, connector: value.connector, tool: value.tool, code: value.code };
  }
  if (value.event === 'connector_identity') {
    // Closed identity proof only: a connector name, two booleans and the proof's own closed code, never
    // the identity itself. The endpoint id is optional so one proof names which endpoint of the account
    // it was (#533). #671-R2: the code is what says why an unproven proof was unproven.
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    const hasEndpoint = Object.prototype.hasOwnProperty.call(value, 'endpointId');
    const hasCode = Object.prototype.hasOwnProperty.call(value, 'code');
    const allowed = ['connector', 'event', 'match', 'proven', ...(hasEndpoint ? ['endpointId'] : []), ...(hasCode ? ['code'] : [])];
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) return;
    if (!token(value.connector) || typeof value.proven !== 'boolean') return;
    if (value.match !== null && typeof value.match !== 'boolean') return;
    if (hasEndpoint && !isSafeId(value.endpointId)) return;
    if (hasCode && !token(value.code)) return;
    return { event: 'connector_identity', connector: value.connector, proven: value.proven, match: value.match,
      ...(hasEndpoint ? { endpointId: value.endpointId } : {}), ...(hasCode ? { code: value.code } : {}) };
  }
  if (value.event === 'gmail_account_unknown') {
    // C-OPEN 4: a Gmail link fell back to account index 0 because the connector proved no account.
    return closedKeys(value, ['event']) ? { event: 'gmail_account_unknown' } : undefined;
  }
  if (value.event === 'google_mcp_path_unsafe') {
    // C-OPEN 6: the Google helper runs from the reports folder; the endpoint id only, never the path.
    if (!closedKeys(value, ['endpointId', 'event']) || !isSafeId(value.endpointId)) return;
    return { event: 'google_mcp_path_unsafe', endpointId: value.endpointId };
  }
  if (value.event === 'connector_connected' || value.event === 'connector_recovered'
    || value.event === 'connector_retry'
    || value.event === 'connector_recovery_exhausted' || value.event === 'connector_unavailable'
    || value.event === 'connector_latched'
    || value.event === 'connector_helper_stderr') {
    // #533: a connect that landed used to be silent, so silent meant unknown. #671: the mark that turns a
    // read into an instant `unavailable` was silent too. These lines are closed counts, ids and codes only:
    // no url, no account, no helper text.
    const ms = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 900_000;
    const count = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    if (!isSafeId(value.endpointId)) return;
    if (value.event === 'connector_connected') {
      // W2-R1: the granted read count is optional, so a producer without it still writes a valid line, and
      // the install gate can tell a connect with no readable tool from a real one.
      const withTools = Object.prototype.hasOwnProperty.call(value, 'tools');
      if (!closedKeys(value, withTools ? ['connectMs', 'endpointId', 'event', 'tools'] : ['connectMs', 'endpointId', 'event']) || !ms(value.connectMs)) return;
      if (!withTools) return { event: 'connector_connected', endpointId: value.endpointId, connectMs: value.connectMs };
      if (!count(value.tools, 4096)) return;
      return { event: 'connector_connected', endpointId: value.endpointId, connectMs: value.connectMs, tools: value.tools };
    }
    if (value.event === 'connector_recovered') {
      // A transient failure is retried every two minutes for the host's life, so an attempt count is not
      // bounded by the delay ladder any more.
      if (!closedKeys(value, ['attempts', 'connectMs', 'endpointId', 'event']) || !count(value.attempts, 100_000) || !ms(value.connectMs)) return;
      return { event: 'connector_recovered', endpointId: value.endpointId, attempts: value.attempts, connectMs: value.connectMs };
    }
    if (value.event === 'connector_retry') {
      if (!closedKeys(value, ['attempt', 'connector', 'endpointId', 'event', 'outcome'])
        || !count(value.attempt, 100_000) || !token(value.connector) || !token(value.outcome)) return;
      return { event: 'connector_retry', connector: value.connector, endpointId: value.endpointId, attempt: value.attempt, outcome: value.outcome };
    }
    if (value.event === 'connector_recovery_exhausted') {
      if (!closedKeys(value, ['attempts', 'endpointId', 'event', 'reason']) || !count(value.attempts, 100_000) || !token(value.reason)) return;
      return { event: 'connector_recovery_exhausted', endpointId: value.endpointId, attempts: value.attempts, reason: value.reason };
    }
    if (value.event === 'connector_unavailable') {
      if (!closedKeys(value, ['endpointId', 'event', 'reason']) || !token(value.reason)) return;
      return { event: 'connector_unavailable', endpointId: value.endpointId, reason: value.reason };
    }
    if (value.event === 'connector_latched') {
      // One line per latch: a closed identity code and the endpoint id, never an address.
      if (!closedKeys(value, ['code', 'endpointId', 'event']) || !token(value.code)) return;
      return { event: 'connector_latched', endpointId: value.endpointId, code: value.code };
    }
    if (!closedKeys(value, ['bytes', 'endpointId', 'event']) || !count(value.bytes, 16_777_216)) return;
    return { event: 'connector_helper_stderr', endpointId: value.endpointId, bytes: value.bytes };
  }
  if (value.event === 'connector_envelope_widened') {
    // W2-R1: the reviewed read names this connect added. Names only: never a schema, a description or a
    // declaration a child published.
    if (!closedKeys(value, ['addedToolNames', 'endpointId', 'event']) || !isSafeId(value.endpointId)) return;
    if (!Array.isArray(value.addedToolNames) || value.addedToolNames.length < 1 || value.addedToolNames.length > 64) return;
    const added: string[] = [];
    for (const name of value.addedToolNames) {
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) return;
      added.push(name);
    }
    return { event: 'connector_envelope_widened', endpointId: value.endpointId, addedToolNames: added };
  }
  if (value.event === 'connector_endpoint_changed') {
    // W2-R1: which fields of a rebuilt child's own endpoint moved, never a value, a path or a token.
    if (!closedKeys(value, ['endpointId', 'event', 'fields']) || !isSafeId(value.endpointId)) return;
    if (!isSafeMembers(value.fields, ['command', 'args', 'env']) || value.fields.length < 1) return;
    return { event: 'connector_endpoint_changed', endpointId: value.endpointId, fields: value.fields };
  }
  if (value.event === 'connector_approval_refused') {
    // W2-R1: one closed refusal reason, so the install gate and an owner read which condition held.
    if (!closedKeys(value, ['endpointId', 'event', 'reason']) || !isSafeId(value.endpointId)) return;
    if (!isSafeMember(value.reason, APPROVAL_REFUSAL_REASONS)) return;
    return { event: 'connector_approval_refused', endpointId: value.endpointId, reason: value.reason };
  }
  if (value.event === 'mattermost_shape') {
    // Closed shape: tool, recognised shape kind and sizes only, never any message content.
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    const sizes = ['rawCharacters', 'shapedCharacters', 'itemCount'] as const;
    if (Object.keys(value).sort().join(',') !== ['event', 'tool', 'shape', ...sizes].sort().join(',')
      || !token(value.tool) || !token(value.shape)
      || sizes.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) return;
    return { event: 'mattermost_shape', tool: value.tool, shape: value.shape, rawCharacters: value.rawCharacters, shapedCharacters: value.shapedCharacters, itemCount: value.itemCount };
  }
  if (value.event === 'gptlive_setup_error') {
    // A refused GPT-Live setup: the provider's own type, code and param and 300 characters of redacted
    // message, the only record that names the field it refused. Never any instruction or request text.
    if (Object.keys(value).sort().join(',') !== ['code', 'event', 'message', 'param', 'type'].sort().join(',')) return;
    const bounded = (field: unknown): field is string => typeof field === 'string' && field.length <= 300 && !/[\u0000-\u001f\u007f]/.test(field);
    if (![value.type, value.code, value.param, value.message].every(bounded)) return;
    return { event: 'gptlive_setup_error', type: value.type, code: value.code, param: value.param, message: value.message };
  }
  if (value.event === 'client_diagnostic' && value.source === 'native' && typeof value.receivedAt === 'string' && Number.isFinite(Date.parse(value.receivedAt)) && value.diagnostic && typeof value.diagnostic === 'object' && !Array.isArray(value.diagnostic)) {
    try { return { event: value.event, source: value.source, receivedAt: value.receivedAt, diagnostic: clientDiagnostic(value.diagnostic as Record<string, unknown>) }; } catch { return; }
  }
  if (value.event === 'host_started' && typeof value.releaseCommit === 'string' && /^(?:[0-9a-f]{40}|unknown)$/.test(value.releaseCommit) && (value.configDir === 'effective' || value.configDir === 'seeded') && Number.isSafeInteger(value.endpoints) && Number(value.endpoints) >= 0 && Number(value.endpoints) <= 65535) {
    return { event: value.event, releaseCommit: value.releaseCommit, configDir: value.configDir, endpoints: value.endpoints };
  }
  if (value.event === 'live_started' && (value.provider === 'openai' || value.provider === 'gemini')
    && typeof value.modelId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value.modelId)
    // A custom voice id is `voice_` plus up to 64 hex characters (PV2); ids are not secret.
    && typeof value.voice === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,69}$/.test(value.voice)
    && (value.voiceKind === 'preset' || value.voiceKind === 'custom')) {
    // Names only: what the running Live service will call, never a key, reference or prompt.
    return { event: 'live_started', provider: value.provider, modelId: value.modelId, voice: value.voice, voiceKind: value.voiceKind };
  }
  if (value.event === 'host_exit' && ['descriptor', 'log', 'store', 'owner', 'listen', 'ready'].includes(String(value.stage))
    && (value.reason === 'close' || value.reason === 'exit')
    && (value.signal === undefined || value.signal === 'SIGINT' || value.signal === 'SIGTERM')
    && (value.code === undefined || (Number.isSafeInteger(value.code) && Number(value.code) >= 0))) {
    return { event: 'host_exit', stage: value.stage, reason: value.reason,
      ...(value.signal !== undefined ? { signal: value.signal } : {}),
      ...(value.code !== undefined ? { code: value.code } : {}) };
  }
  if (value.event === 'config_seeded' && ['live.json', 'mcp.json', 'providers.json'].includes(String(value.file)) && value.from === 'provider-config') {
    return { event: value.event, file: value.file, from: value.from };
  }
  if (value.event === 'mongoose_catalogue_replaced' && value.endpoints === 3) {
    return { event: 'mongoose_catalogue_replaced', endpoints: 3 };
  }
  if (typeof value.event === 'string' && Object.hasOwn(SIGNIN_OUTCOMES, value.event)) {
    // W1: one line per sign-in hop: endpoint, an opaque attempt id and a closed outcome, never a URL,
    // code, state, verifier, token or registration payload.
    const outcomes = SIGNIN_OUTCOMES[value.event]!;
    const keys = value.oauthError === undefined ? ['attemptId', 'endpoint', 'event', 'outcome'] : ['attemptId', 'endpoint', 'event', 'oauthError', 'outcome'];
    if (Object.keys(value).sort().join(',') !== keys.join(',')) return;
    if (!isSafeMember(value.endpoint, value.event === 'signin_requested' ? [...SIGNIN_ENDPOINTS, 'unknown'] : SIGNIN_ENDPOINTS)) return;
    if (typeof value.attemptId !== 'string' || !/^[0-9a-f]{16}$/.test(value.attemptId) || !isSafeMember(value.outcome, outcomes)) return;
    if (value.oauthError !== undefined && !(value.event === 'signin_token' && value.outcome === 'refused' && isSafeMember(value.oauthError, SIGNIN_OAUTH_ERRORS))) return;
    return { event: value.event, endpoint: value.endpoint, attemptId: value.attemptId, outcome: value.outcome, ...(value.oauthError !== undefined ? { oauthError: value.oauthError } : {}) };
  }
  if (value.event === 'live_attach_rejected' && typeof value.code === 'string' && /^[A-Za-z0-9_]{1,107}$/.test(value.code)) {
    // C-LIVE behaviour 7: the exception class is a bare identifier and the one known detail token, never text.
    return { event: value.event, ...(typeof value.liveSessionId === 'string' && /^[0-9a-f-]{36}$/i.test(value.liveSessionId) ? { liveSessionId: value.liveSessionId } : {}), code: value.code,
      ...(typeof value.class === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.class) ? { class: value.class } : {}),
      ...(value.detail === 'connection_policy_missing_or_corrupt' ? { detail: value.detail } : {}) };
  }
  if (value.event === 'live_recovery_failed') {
    // C-LIVE R2: a refused recovery open, by class and closed key, with the mode and the cause that started it.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'mode', 'cause', 'errorClass', 'messageKey', 'attempt'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId) || !isSafeCount(value.generation) || !isSafeCount(value.attempt)) return;
    if (!isSafeMember(value.mode, ['resume', 'fresh_seeded']) || !isSafeToken(value.cause)) return;
    if (typeof value.errorClass !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.errorClass)) return;
    if (typeof value.messageKey !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.messageKey)) return;
    return { event: 'live_recovery_failed', liveSessionId: value.liveSessionId, generation: value.generation, mode: value.mode, cause: value.cause,
      errorClass: value.errorClass, messageKey: value.messageKey, attempt: value.attempt };
  }
  if (value.event === 'research_query_token_dropped') {
    if (!closedKeys(value, ['event', 'dropped'])) return;
    if (!Number.isInteger(value.dropped) || (value.dropped as number) < 1) return undefined;
    return { event: 'research_query_token_dropped', dropped: value.dropped };
  }
  if (value.event === 'research_operation_deadline') {
    // C-LIVE behaviour 4: the host answered an operation its loop had not answered by the deadline.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'ms'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId) || !isSafeCount(value.generation) || !isSafeCount(value.ms)) return;
    return { event: 'research_operation_deadline', liveSessionId: value.liveSessionId, generation: value.generation, ms: value.ms };
  }
  if (value.event === 'live_session_diagnostics') {
    const numeric = ['adapterGenerations','ownerAudioCalls','ownerAudioBytes','ownerRebuildingDropCalls','ownerRebuildingDropBytes',
      'adapterAudioCalls','adapterAudioBytes','drainingDropCalls','drainingDropBytes',
      'localWriteEnqueuedCalls','localWriteEnqueuedPCMBytes','localWriteCallbackSuccessCalls','localWriteCallbackSuccessPCMBytes',
      'localWriteCallbackErrorCalls','localWriteCallbackErrorPCMBytes','localWriteCallbackPendingCalls','localWriteCallbackPendingPCMBytes',
      'inputTranscriptionEvents','inputTranscriptionCharacters','generationCompleteEvents','turnCompleteEvents','outputAudioFrames','outputAudioPCMBytes',
      'outputAudioAfterInitialTurnFrames','outputAudioAfterInitialTurnPCMBytes','headVoiceChars','terminalVoiceChars'];
    const keys = ['event','terminalCode',...numeric].sort();
    if (Object.keys(value).sort().join(',') !== keys.join(',') || typeof value.terminalCode !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(value.terminalCode)
      || numeric.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) return;
    return Object.fromEntries(['event','terminalCode',...numeric].map(key => [key, value[key]]));
  }
  if (value.event === 'live_instruction_sizes') {
    // Closed shape: a total, per-section character counts (every id a known section), the effective
    // languageCode (or `unset`) and the voice name; never any text.
    if (Object.keys(value).sort().join(',') !== ['event','total','sections','languageCode','voice'].sort().join(',')) return;
    if (!Number.isSafeInteger(value.total) || Number(value.total) < 0) return;
    if (!isSafeToken(value.voice)) return;
    if (value.languageCode !== 'unset' && (typeof value.languageCode !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(value.languageCode))) return;
    const sections = value.sections;
    if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return;
    const ids = Object.keys(sections);
    if (ids.length > 16 || ids.some(id => !(LIVE_INSTRUCTION_SECTION_IDS as readonly string[]).includes(id)
      || !Number.isSafeInteger((sections as Record<string, unknown>)[id]) || Number((sections as Record<string, unknown>)[id]) < 0)) return;
    return { event: 'live_instruction_sizes', total: value.total, sections: Object.fromEntries(ids.map(id => [id, (sections as Record<string, unknown>)[id]])), languageCode: value.languageCode, voice: value.voice };
  }
  if (value.event === 'conversation_summary_injection') {
    // Closed shape: how many summaries were injected, how many were dropped, and the section size.
    // Counts and one size only, never a summary id or any text.
    if (Object.keys(value).sort().join(',') !== ['event','injected','omitted','chars'].sort().join(',')) return;
    for (const key of ['injected', 'omitted', 'chars'] as const) {
      if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return;
    }
    return { event: 'conversation_summary_injection', injected: value.injected, omitted: value.omitted, chars: value.chars };
  }
  if (value.event === 'connector_call' && value.connector === 'trello') {
    // W7: one line per Trello board call phase: Didi's own tool and action, the phase and a closed outcome. Never card text.
    const hasReason = value.reason !== undefined;
    // C-FILLER: a normalised line names the write properties it dropped; a name is never a value.
    const normalized = value.normalized === undefined ? undefined : value.normalized;
    if (!closedKeys(value, ['event', 'connector', 'tool', 'phase', 'outcome', ...(hasReason ? ['reason'] : []), ...(normalized === undefined ? [] : ['normalized'])])) return;
    if (normalized !== undefined && !isTrelloNormalizedPaths(normalized)) return;
    if (typeof value.tool !== 'string' || !TRELLO_CALL_TOOL.test(value.tool)) return;
    if (!isSafeMember(value.phase, ['admit', 'dispatch', 'settle']) || !isSafeMember(value.outcome, ['ok', 'refused', 'failed', 'unknown'])) return;
    if (hasReason && !isSafeMember(value.reason, TRELLO_CALL_REASONS)) return;
    return { event: 'connector_call', connector: 'trello', tool: value.tool, phase: value.phase, outcome: value.outcome, ...(hasReason ? { reason: value.reason } : {}),
      ...(normalized === undefined ? {} : { normalized: normalized.slice(0, TRELLO_WRITE_ARGUMENT_FIELDS.length) }) };
  }
  if (value.event === 'vault_transport') {
    if (!closedKeys(value, ['event', 'phase']) || !isSafeMember(value.phase, VAULT_TRANSPORT_PHASES)) return;
    return { event: 'vault_transport', phase: value.phase };
  }
  if (value.event === 'vault_write') {
    // Closed shape: the attempt outcome, the closed failure code, the vault's own insight id on a confirmed save, and the wire latency. Never text.
    const hasInsight = value.insightId !== undefined;
    const hasCode = value.code !== undefined;
    if (!closedKeys(value, ['event', 'state', ...(hasCode ? ['code'] : []), ...(hasInsight ? ['insightId'] : []), 'latencyMs'])) return;
    if (typeof value.state !== 'string' || !['confirmed', 'failed', 'uncertain', 'unavailable'].includes(value.state)) return;
    if (hasCode && !['not_owner_requested', 'write_failed', 'outcome_unknown', 'vault_unavailable'].includes(String(value.code))) return;
    if ((value.state === 'confirmed') !== hasInsight) return;
    if (hasInsight && !isSafeToken(value.insightId)) return;
    if (!Number.isSafeInteger(value.latencyMs) || Number(value.latencyMs) < 0) return;
    return { event: 'vault_write', state: value.state, ...(hasCode ? { code: value.code } : {}), ...(hasInsight ? { insightId: value.insightId } : {}), latencyMs: value.latencyMs };
  }
  if (value.event === 'memory_note') {
    // Closed shape: whether the note was saved, its code, the note's content word count, how many of
    // those words the window's owner turns carried, and how many turns the window held. Never text.
    if (!closedKeys(value, ['event', 'remembered', 'code', 'words', 'supported', 'supportRatio', 'turns'])) return;
    if (typeof value.remembered !== 'boolean') return;
    if (typeof value.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.code)) return;
    if (!Number.isSafeInteger(value.words) || Number(value.words) < 0 || Number(value.words) > 10_000) return;
    if (!Number.isSafeInteger(value.supported) || Number(value.supported) < 0 || Number(value.supported) > Number(value.words)) return;
    if (typeof value.supportRatio !== 'number' || !Number.isFinite(value.supportRatio) || value.supportRatio < 0 || value.supportRatio > 1) return;
    if (!Number.isSafeInteger(value.turns) || Number(value.turns) < 0 || Number(value.turns) > 10_000) return;
    return { event: 'memory_note', remembered: value.remembered, code: value.code, words: value.words, supported: value.supported, supportRatio: value.supportRatio, turns: value.turns };
  }
  if (value.event === 'standing_memory_selection') {
    // Counts and one size only: how many whole notes the build selected and left out, and the section's
    // character size. Never a note id or any text.
    if (!closedKeys(value, ['event', 'selected', 'omitted', 'chars'])) return;
    for (const key of ['selected', 'omitted', 'chars'] as const) {
      if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return;
    }
    return { event: 'standing_memory_selection', selected: value.selected, omitted: value.omitted, chars: value.chars };
  }
  if (value.event === 'live_frame_rejected') {
    // Closed shape: code, error constructor name, frame kind, byte length and key-name paths only, never a value or id.
    if (Object.keys(value).sort().join(',') !== ['event','code','error','kind','bytes','keys'].sort().join(',')) return;
    const codes = ['protocol_error', 'provider_error', 'unsupported_tool'];
    const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9_]{0,63}(?:\[\])?)*$/;
    if (typeof value.code !== 'string' || !codes.includes(value.code)) return;
    if (typeof value.error !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.error)) return;
    if (typeof value.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_+]{0,80}$/.test(value.kind)) return;
    if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > 64 * 1024 * 1024) return;
    if (!Array.isArray(value.keys) || value.keys.length > 24 || value.keys.some(key => typeof key !== 'string' || !keyPattern.test(key))) return;
    return { event: 'live_frame_rejected', code: value.code, error: value.error, kind: value.kind, bytes: value.bytes, keys: value.keys };
  }
  if (value.event === 'tool_arguments_rejected') {
    // C-ARGS: closed shape. One `path:keyword` token per violation, together, and never a value: the
    // keyword is a rule name the tool's own predicate declares, the path is the argument key it names.
    const shapeKeys = Object.keys(value).sort().join(',');
    const plainKeys = ['event', 'tool', 'violations', 'reason'].sort().join(',');
    const fieldKeys = ['event', 'tool', 'violations', 'reason', 'argumentFields'].sort().join(',');
    if (shapeKeys !== plainKeys && shapeKeys !== fieldKeys) return;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    const violationPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}:[a-z][a-z0-9_]{0,47}$/u;
    /** The closed keyword set: the rule names the live tools' own rejection predicates declare. A new rule
     *  name belongs here, so an unknown word can never carry a value into the line. */
    const VIOLATION_KEYWORDS: ReadonlySet<string> = new Set(['unknown_key', 'unknown', 'not_object', 'type', 'empty', 'long',
      'placeholder', 'min2', 'format', 'range', 'required', 'not_for_person', 'not_for_channel', 'not_for_intent',
      'needs_conversation', 'one_conversation', 'undeclared', 'date_unreadable', 'clock_format', 'amount_range', 'refused',
      'unit_value', 'timezone_value', 'mode_unknown', 'mode_ambiguous']);
    const named = (violation: string): boolean => violationPattern.test(violation)
      && VIOLATION_KEYWORDS.has(violation.slice(violation.indexOf(':') + 1));
    if (!token(value.tool)) return;
    if (!Array.isArray(value.violations) || value.violations.length > 24 || value.violations.some(violation => typeof violation !== 'string' || !named(violation))) return;
    if (!['arguments_not_object', 'schema_validation_failed'].includes(String(value.reason))) return;
    // C-ALARM: the key names and value types of the refused arguments, closed to a `path:type` token,
    // so a later audit sees which field the model guessed and never what his own words were. It carries
    // its own closed name: `fields` was the declared-shape list a past decision removed for good.
    const argumentsField = (v: unknown): v is string => typeof v === 'string'
      && /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}\.)?[A-Za-z_][A-Za-z0-9_]{0,63}:(?:string|number|boolean|object|array|null|empty)$/u.test(v);
    if (value.argumentFields !== undefined && (!Array.isArray(value.argumentFields) || value.argumentFields.length > 32 || value.argumentFields.some(field => !argumentsField(field)))) return;
    return { event: 'tool_arguments_rejected', tool: value.tool, violations: value.violations, reason: value.reason,
      ...(value.argumentFields !== undefined ? { argumentFields: value.argumentFields } : {}) };
  }
  if (value.event === 'tool_arguments_normalized') {
    // C-ARGS: the dropped-key telemetry, a closed event of its own: `path:reason`, the reason from the
    // closed set `undeclared`, `not_read` or `absent`, and never a value.
    if (Object.keys(value).sort().join(',') !== ['event', 'tool', 'dropped'].sort().join(',')) return;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    const droppedPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}:(?:undeclared|not_read|absent)$/u;
    if (!token(value.tool)) return;
    if (!Array.isArray(value.dropped) || value.dropped.length > 24 || value.dropped.some(dropped => typeof dropped !== 'string' || !droppedPattern.test(dropped))) return;
    return { event: 'tool_arguments_normalized', tool: value.tool, dropped: value.dropped };
  }
  if (value.event === 'live_session_superseded') {
    // Closed shape: the superseded session id only, never any owner or transcript detail.
    if (Object.keys(value).sort().join(',') !== ['event', 'liveSessionId'].sort().join(',')) return;
    if (typeof value.liveSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.liveSessionId)) return;
    return { event: 'live_session_superseded', liveSessionId: value.liveSessionId };
  }
  if (value.event === 'live_resumption_fresh') {
    // Closed shape: the tool-call count at which a fresh session was forced, never any handle or content.
    if (Object.keys(value).sort().join(',') !== ['event', 'toolCalls'].sort().join(',')) return;
    if (!Number.isSafeInteger(value.toolCalls) || Number(value.toolCalls) < 0) return;
    return { event: 'live_resumption_fresh', toolCalls: value.toolCalls };
  }
  if (value.event === 'live_upstream_drop') {
    // Closed shape: one metadata-only record per dead upstream (host to provider) audio write drop.
    if (Object.keys(value).sort().join(',') !== ['event', 'errorKind', 'closeCode', 'bufferedAmount', 'writesFailed', 'sessionMs', 'rebuilt'].sort().join(',')) return;
    if (typeof value.errorKind !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.errorKind)) return;
    if (!(value.closeCode === null || (Number.isSafeInteger(value.closeCode) && Number(value.closeCode) >= 0 && Number(value.closeCode) <= 65535))) return;
    const numeric: readonly [string, number][] = [['bufferedAmount', 64 * 1024 * 1024], ['writesFailed', Number.MAX_SAFE_INTEGER], ['sessionMs', 24 * 60 * 60 * 1000]];
    for (const [name, max] of numeric) {
      const field = value[name];
      if (!Number.isSafeInteger(field) || Number(field) < 0 || Number(field) > max) return;
    }
    if (value.rebuilt !== true && value.rebuilt !== false) return;
    return { event: 'live_upstream_drop', errorKind: value.errorKind, closeCode: value.closeCode, bufferedAmount: value.bufferedAmount, writesFailed: value.writesFailed, sessionMs: value.sessionMs, rebuilt: value.rebuilt };
  }
  if (value.event === 'live_no_pong') {
    // Closed shape: the pong gap an adapter judged fatal, with the inbound traffic it measured against it, so
    // a `no_pong` in the log is readable as a real silence rather than a dropped socket frame (3o).
    if (Object.keys(value).sort().join(',') !== ['event', 'lastInboundAgeMs', 'missedPongs', 'bufferedAmount'].sort().join(',')) return;
    const numeric: readonly [string, number][] = [['lastInboundAgeMs', 24 * 60 * 60 * 1000], ['missedPongs', 1_000], ['bufferedAmount', 64 * 1024 * 1024]];
    for (const [name, max] of numeric) {
      const field = value[name];
      if (!Number.isSafeInteger(field) || Number(field) < 0 || Number(field) > max) return;
    }
    return { event: 'live_no_pong', lastInboundAgeMs: value.lastInboundAgeMs, missedPongs: value.missedPongs, bufferedAmount: value.bufferedAmount };
  }
  if (value.event === 'live_unspoken_delivered') {
    // #660/#667: how many results a replaced session was handed as one text item, and which attempt landed.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'results', 'attempt'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation) || !isSafeCount(value.results) || !isSafeCount(value.attempt)) return;
    if (Number(value.attempt) < 1 || Number(value.attempt) > 2) return;
    return { event: 'live_unspoken_delivered', liveSessionId: value.liveSessionId, generation: value.generation,
      results: value.results, attempt: value.attempt };
  }
  if (value.event === 'live_recovery') {
    // Closed shape: one metadata-only record per recovery attempt. Never audio, text or a provider payload;
    // seedTurns/seedChars are the rebuilt journal seed's size, path is the transport chosen.
    if (Object.keys(value).sort().join(',') !== ['event', 'path', 'attempt', 'code', 'cause', 'closeCode', 'closeReason', 'reason', 'seedTurns', 'seedChars', 'msSinceDrop', 'pickup', 'liveSessionId', 'generation'].sort().join(',')) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation)) return;
    if (!isSafeMember(value.path, ['resume', 'fresh_seeded'])) return;
    if (!isSafeCount(value.attempt) || Number(value.attempt) < 1) return;
    if (!isSafeCount(value.msSinceDrop)) return;
    if (!isSafeToken(value.code)) return;
    // C-CONTINUITY R-02/R-10: the cause is the outcome's, never the event name's static label.
    if (!isSafeMember(value.cause, LOG_CAUSES)) return;
    if (!(value.closeCode === null || (Number.isSafeInteger(value.closeCode) && Number(value.closeCode) >= 0 && Number(value.closeCode) <= 65535))) return;
    if (!(value.reason === null || isSafeToken(value.reason))) return;
    if (!isSafeCloseReason(value.closeReason)) return;
    if (!isSafeCount(value.seedTurns) || !isSafeCount(value.seedChars)) return;
    // C-PICKUP: which pickup the rebuilt session was opened with; a closed set, so no spoken text rides here.
    if (!isSafeMember(value.pickup, ['mute', 'connection', 'quiet', 'none'])) return;
    return { event: 'live_recovery', path: value.path, attempt: value.attempt, code: value.code, cause: value.cause, closeCode: value.closeCode, closeReason: value.closeReason, reason: value.reason, seedTurns: value.seedTurns, seedChars: value.seedChars, msSinceDrop: value.msSinceDrop, pickup: value.pickup, liveSessionId: value.liveSessionId, generation: value.generation };
  }
  if (value.event === 'live_terminal') {
    if (!closedKeys(value, ['event', 'liveSessionId', 'code'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    // The administrative canary close is the only terminal sent through this event channel.
    if (value.code !== 'revoked') return;
    return { event: 'live_terminal', liveSessionId: value.liveSessionId, code: value.code };
  }
  if (value.event === 'live_provider_open' || value.event === 'live_provider_ready') {
    // Closed shape: which session and generation the provider socket was opened for, how big the setup was
    // and, for the ready half, how long the provider took to acknowledge it.
    const ready = value.event === 'live_provider_ready';
    const keys = ready
      ? ['event', 'liveSessionId', 'generation', 'msSinceOpen', 'closeCode']
      : ['event', 'liveSessionId', 'generation', 'instructionChars', 'seedChars', 'tools'];
    if (!closedKeys(value, keys)) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation)) return;
    if (ready) {
      if (!isSafeCount(value.msSinceOpen)) return;
      if (!(value.closeCode === null || (Number.isSafeInteger(value.closeCode) && Number(value.closeCode) >= 0 && Number(value.closeCode) <= 65535))) return;
      return { event: 'live_provider_ready', liveSessionId: value.liveSessionId, generation: value.generation, msSinceOpen: value.msSinceOpen, closeCode: value.closeCode };
    }
    if (!isSafeCount(value.instructionChars) || !isSafeCount(value.seedChars) || !isSafeCount(value.tools)) return;
    return { event: 'live_provider_open', liveSessionId: value.liveSessionId, generation: value.generation, instructionChars: value.instructionChars, seedChars: value.seedChars, tools: value.tools };
  }
  if (value.event === 'live_handshake') {
    // Closed shape: one step of the provider handshake and the monotonic milliseconds it took to reach it.
    if (!closedKeys(value, ['event', 'step', 'ms'])) return;
    if (!isSafeMember(value.step, LIVE_HANDSHAKE_STEPS)) return;
    if (!isSafeCount(value.ms)) return;
    return { event: 'live_handshake', step: value.step, ms: value.ms };
  }
  if (value.event === 'live_first_audio' || value.event === 'live_answer_audio') {
    // Closed shape: when the provider's first audible frame of a turn arrived, measured from the open and
    // from the ready event, never any audio itself. C-LOGS11 adds the owner-facing latency: the wait from
    // his final words to this frame, or the closed reason it cannot be measured.
    const plain = closedKeys(value, ['event', 'liveSessionId', 'generation', 'msSinceReady', 'msSinceOpen']);
    const audit = closedKeys(value, ['event', 'liveSessionId', 'generation', 'msSinceReady', 'msSinceOpen', 'finalToProviderFirstAudioMs', 'missingReason']);
    if (!plain && !audit) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation) || !isSafeCount(value.msSinceReady) || !isSafeCount(value.msSinceOpen)) return;
    const base = { event: value.event, liveSessionId: value.liveSessionId, generation: value.generation, msSinceReady: value.msSinceReady, msSinceOpen: value.msSinceOpen };
    if (plain) return base;
    if (!(value.finalToProviderFirstAudioMs === null || isSafeCount(value.finalToProviderFirstAudioMs))) return;
    if (!(value.missingReason === null || isSafeMember(value.missingReason, AUDIBLE_MISSING_REASONS))) return;
    return { ...base, finalToProviderFirstAudioMs: value.finalToProviderFirstAudioMs, missingReason: value.missingReason };
  }
  if (value.event === 'research_call_arrived' || value.event === 'tool_output_sent') {
    // Closed shape: the frame arrival and the answer write, with the milliseconds between them.
    if (value.event === 'research_call_arrived') {
      // #667: the call's own shape, never the owner's words: the declared action, an id present, the question
      // length and the lookup count. Free text has no column, and the question itself never enters the log.
      if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'calls', 'action', 'researchIdPresent', 'questionChars', 'lookups'])) return;
      if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
      if (!isSafeCount(value.generation) || !isSafeCount(value.calls)) return;
      if (!isSafeMember(value.action, ['start', 'continue', 'stop', 'other'])) return;
      if (typeof value.researchIdPresent !== 'boolean') return;
      if (!isSafeCount(value.questionChars) || !isSafeCount(value.lookups)) return;
      return { event: 'research_call_arrived', liveSessionId: value.liveSessionId, generation: value.generation, calls: value.calls,
        action: value.action, researchIdPresent: value.researchIdPresent, questionChars: value.questionChars, lookups: value.lookups };
    }
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'tools', 'msSinceArrived', 'outcome'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation) || !isSafeCount(value.tools) || !isSafeCount(value.msSinceArrived)) return;
    // #538: what the adapter reported for the write, from the closed outcome set.
    if (!isSafeMember(value.outcome, LIVE_TOOL_SEND_OUTCOMES)) return;
    return { event: 'tool_output_sent', liveSessionId: value.liveSessionId, generation: value.generation, tools: value.tools, msSinceArrived: value.msSinceArrived, outcome: value.outcome };
  }
  if (value.event === 'live_go_away') {
    // Closed shape: the draining deadline the provider announced, in milliseconds.
    if (Object.keys(value).sort().join(',') !== ['event', 'timeLeftMs'].sort().join(',')) return;
    if (!isSafeCount(value.timeLeftMs)) return;
    return { event: 'live_go_away', timeLeftMs: value.timeLeftMs };
  }
  if (value.event === 'live_upstream_queue') {
    // Closed shape: the upstream send queue depth while it is elevated, sampled about once a second.
    if (Object.keys(value).sort().join(',') !== ['event', 'bufferedBytes'].sort().join(',')) return;
    if (!isSafeCount(value.bufferedBytes)) return;
    return { event: 'live_upstream_queue', bufferedBytes: value.bufferedBytes };
  }
  if (value.event === 'uplink_shed') {
    // Closed shape (3o, W3, release 3): mic frame bytes shed from the front of the uplink queue, the peak backlog
    // of the window, how many contiguous runs went, the bytes the socket drained per second, the frames lost
    // while the socket was not open, and the speech and silence split of the shed. One record per
    // UPLINK_SHED_RECEIPT_MS at most, never one per shed frame.
    if (!closedKeys(value, ['event', 'bytes', 'bufferedPeak', 'shedRuns', 'drainBytesPerSec', 'notOpenBytes',
      'lostMs', 'speechShedMs', 'silenceShedMs', 'speechShedBytes', 'silenceShedBytes'])) return;
    if (!isSafeCount(value.bytes) || !isSafeCount(value.bufferedPeak) || !isSafeCount(value.shedRuns)) return;
    if (!isSafeCount(value.drainBytesPerSec) || !isSafeCount(value.notOpenBytes)) return;
    if (!isSafeCount(value.lostMs) || !isSafeCount(value.speechShedMs) || !isSafeCount(value.silenceShedMs)) return;
    if (!isSafeCount(value.speechShedBytes) || !isSafeCount(value.silenceShedBytes)) return;
    return { event: 'uplink_shed', bytes: value.bytes, bufferedPeak: value.bufferedPeak, shedRuns: value.shedRuns,
      drainBytesPerSec: value.drainBytesPerSec, notOpenBytes: value.notOpenBytes, lostMs: value.lostMs,
      speechShedMs: value.speechShedMs, silenceShedMs: value.silenceShedMs, speechShedBytes: value.speechShedBytes,
      silenceShedBytes: value.silenceShedBytes };
  }
  if (value.event === 'connection_quality') {
    // Closed shape (W3): one record when the adapter's own uplink measurement flips between ok and weak, with
    // the drained upload as counts only. The words the owner reads are never in the log.
    if (!closedKeys(value, ['event', 'quality', 'uploadKbps'])) return;
    if (value.quality !== 'ok' && value.quality !== 'weak') return;
    if (!isSafeCount(value.uploadKbps)) return;
    return { event: 'connection_quality', quality: value.quality, uploadKbps: value.uploadKbps };
  }
  if (value.event === 'live_stall') {
    // The same recovery path owns inbound silence and bounded outbound no-progress. Each receipt carries only the
    // local duration that selected it. Socket depth and content stay out of the terminal receipt.
    if (closedKeys(value, ['event', 'silentMs']) && isSafeCount(value.silentMs)) return { event: 'live_stall', silentMs: value.silentMs };
    if (closedKeys(value, ['event', 'noProgressMs']) && isSafeCount(value.noProgressMs)) return { event: 'live_stall', noProgressMs: value.noProgressMs };
    return;
  }
  if (value.event === 'playback_rearm') {
    // Closed shape (3o): head starts re-armed after a drain, counted per turn.
    if (!closedKeys(value, ['event', 'count'])) return;
    if (!isSafeCount(value.count)) return;
    return { event: 'playback_rearm', count: value.count };
  }
  if (value.event === 'consumer_gone_end') {
    // Closed shape (3o): how long the consumer had been away when the session ended itself.
    if (!closedKeys(value, ['event', 'detachedMs'])) return;
    if (!isSafeCount(value.detachedMs)) return;
    return { event: 'consumer_gone_end', detachedMs: value.detachedMs };
  }
  if (value.event === 'session_end') {
    // Closed shape (3p): why the call ended and how long the stop took to be felt. Never text, never audio.
    if (!closedKeys(value, ['event', 'reason', 'msAfterStop'])) return;
    if (!['user_stop', 'consumer_closed', 'app_quit'].includes(String(value.reason))
      && !(NATIVE_END_REASONS as readonly string[]).includes(String(value.reason))) return;
    if (!isSafeCount(value.msAfterStop)) return;
    return { event: 'session_end', reason: value.reason, msAfterStop: value.msAfterStop };
  }
  if (value.event === 'voice_stop_candidate') {
    if (Object.keys(value).sort().join(',') !== ['event', 'aliasId', 'windowWords', 'matched', 'finished'].sort().join(',')) return;
    if (!isSafeCount(value.aliasId) || value.aliasId >= STOP_NAMES.length) return;
    if (!isSafeCount(value.windowWords) || value.windowWords < 1 || value.windowWords > STOP_WORD_LIMIT) return;
    if (typeof value.matched !== 'boolean' || typeof value.finished !== 'boolean') return;
    return { event: value.event, aliasId: value.aliasId, windowWords: value.windowWords, matched: value.matched, finished: value.finished };
  }
  if (value.event === 'voice_stop') {
    // #589: the owner's own sentence ended the call on the host's phrase gate. No words, no audio, no code.
    if (!closedKeys(value, ['event'])) return;
    return { event: 'voice_stop' };
  }
  if (value.event === 'live_context_usage') {
    // Closed shape: provider-neutral token counts only; no behaviour reads them yet (release 3g-c).
    const keys = Object.keys(value).sort().join(',');
    if (keys !== ['event', 'totalTokens'].sort().join(',') && keys !== ['event', 'totalTokens', 'promptTokens'].sort().join(',') && keys !== ['event', 'totalTokens', 'promptTokens', 'responseTokens'].sort().join(',') && keys !== ['event', 'totalTokens', 'responseTokens'].sort().join(',')) return;
    if (!isSafeCount(value.totalTokens)) return;
    if (!(value.promptTokens === undefined || isSafeCount(value.promptTokens))) return;
    if (!(value.responseTokens === undefined || isSafeCount(value.responseTokens))) return;
    return { event: 'live_context_usage', totalTokens: value.totalTokens, ...(value.promptTokens !== undefined ? { promptTokens: value.promptTokens } : {}), ...(value.responseTokens !== undefined ? { responseTokens: value.responseTokens } : {}) };
  }
  if (value.event === 'live_reply_unjournalled') {
    // Closed shape: a spoken reply that left no output transcript row. Never text, only the two ids.
    if (Object.keys(value).sort().join(',') !== ['event', 'liveSessionId', 'generation'].sort().join(',')) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation)) return;
    return { event: 'live_reply_unjournalled', liveSessionId: value.liveSessionId, generation: value.generation };
  }
  if (value.event === 'live_dead_air_nudge') {
    // Closed shape: the elapsed dead air before a single neutral continuation input was sent.
    if (Object.keys(value).sort().join(',') !== ['event', 'elapsedMs'].sort().join(',')) return;
    if (!isSafeCount(value.elapsedMs)) return;
    return { event: 'live_dead_air_nudge', elapsedMs: value.elapsedMs };
  }
  if (value.event === 'live_read_cache') {
    // Closed shape: the cached tool name and cache-hit flag only, never a request or result body.
    if (Object.keys(value).sort().join(',') !== ['event', 'tool', 'cached'].sort().join(',')) return;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    if (!token(value.tool) || value.cached !== true) return;
    return { event: 'live_read_cache', tool: value.tool, cached: true };
  }
  if (value.event === 'live_interrupted') {
    // E1: one metadata-only record per provider barge-in, never audio, text or a provider payload.
    if (Object.keys(value).sort().join(',') !== ['event', 'liveSessionId', 'turnCompleteSeen', 'msSinceLastModelAudio'].sort().join(',')) return;
    if (typeof value.liveSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.liveSessionId)) return;
    if (typeof value.turnCompleteSeen !== 'boolean') return;
    if (!(value.msSinceLastModelAudio === null || isSafeCount(value.msSinceLastModelAudio))) return;
    return { event: 'live_interrupted', liveSessionId: value.liveSessionId, turnCompleteSeen: value.turnCompleteSeen, msSinceLastModelAudio: value.msSinceLastModelAudio };
  }
  if (value.event === 'live_dead_air') {
    // Two waits, both durations and never any turn content: E1's gap between input final and first audio,
    // and D3's stall receipt, how long the answer was owed and how long since any audible output.
    const stallKeys = ['event', 'msSinceTool', 'msSinceAudible'].sort().join(',');
    const response = responsePair(value);
    if (response === undefined) return;
    const stalled = ['event', 'msSinceTool', 'msSinceAudible',
      ...(Object.hasOwn(value, 'responseCreated') ? ['responseCreated', 'msSinceResponseCreated'] : [])].sort().join(',');
    if (Object.keys(value).sort().join(',') === stallKeys || Object.keys(value).sort().join(',') === stalled) {
      if (!isSafeCount(value.msSinceTool)) return;
      if (!(value.msSinceAudible === null || isSafeCount(value.msSinceAudible))) return;
      return { event: 'live_dead_air', msSinceTool: value.msSinceTool, msSinceAudible: value.msSinceAudible, ...response };
    }
    if (Object.keys(value).sort().join(',') !== ['event', 'deadAirMs'].sort().join(',')) return;
    if (!isSafeCount(value.deadAirMs)) return;
    return { event: 'live_dead_air', deadAirMs: value.deadAirMs };
  }
  if (value.event === 'live_voice_profile') {
    // C-PITCH: the voice the owner just heard, per response, measured on the output PCM the host already
    // forwarded to playback: a closed response id, audible milliseconds, the median F0 and its 10th and 90th
    // percentile, the voiced-frame ratio and the RMS level. Never the audio, never a word of it.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'responseId', 'audibleMs', 'f0Hz', 'f0P10Hz', 'f0P90Hz', 'voicedRatio', 'rmsDbfs'])) return;
    if (!isSafeId(value.liveSessionId) || !isSafeId(value.responseId)) return;
    if (!isSafeCount(value.generation) || !isSafeCount(value.audibleMs)) return;
    if (!isSafeHz(value.f0Hz) || !isSafeHz(value.f0P10Hz) || !isSafeHz(value.f0P90Hz)) return;
    if (!isSafeRatio(value.voicedRatio)) return;
    if (typeof value.rmsDbfs !== 'number' || !Number.isFinite(value.rmsDbfs) || value.rmsDbfs > 0 || value.rmsDbfs < -200) return;
    return { event: 'live_voice_profile', liveSessionId: value.liveSessionId, generation: value.generation, responseId: value.responseId, audibleMs: value.audibleMs, f0Hz: value.f0Hz, f0P10Hz: value.f0P10Hz, f0P90Hz: value.f0P90Hz, voicedRatio: value.voicedRatio, rmsDbfs: value.rmsDbfs };
  }
  if (value.event === 'live_voice_shift') {
    // C-PITCH: this response's median F0 sits beyond the configured ratio from the session's running median.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'responseId', 'ratio', 'medianHz', 'sessionMedianHz'])) return;
    if (!isSafeId(value.liveSessionId) || !isSafeId(value.responseId)) return;
    if (!isSafeCount(value.generation)) return;
    if (!isSafeRatio(value.ratio) || !isSafeHz(value.medianHz) || !isSafeHz(value.sessionMedianHz)) return;
    return { event: 'live_voice_shift', liveSessionId: value.liveSessionId, generation: value.generation, responseId: value.responseId, ratio: value.ratio, medianHz: value.medianHz, sessionMedianHz: value.sessionMedianHz };
  }
  if (value.event === 'live_heard_silence') {
    // L-04/R7: the silence the owner heard, from the end of the last audible frame to the next model audio, with
    // what really owned it: a tool call, the provider generating, or the owner. A duration and one word, never
    // turn content. The old boolean said "tool pending" even when the provider was simply generating.
    if (Object.keys(value).sort().join(',') !== ['event', 'ms', 'silence'].sort().join(',')) return;
    if (!isSafeCount(value.ms) || !SILENCE_OWNERS.includes(String(value.silence))) return;
    return { event: 'live_heard_silence', ms: value.ms, silence: value.silence as string };
  }
  if (value.event === 'uplink_speech_shed') {
    if (!closedKeys(value, ['event', 'ms', 'silenceFramesBeforeSpeechShed']) || !isSafeCount(value.ms) || !isSafeCount(value.silenceFramesBeforeSpeechShed)) return;
    return { event: 'uplink_speech_shed', ms: value.ms, silenceFramesBeforeSpeechShed: value.silenceFramesBeforeSpeechShed };
  }
  if (value.event === 'live_response_latency') {
    // C-DEADAIR: the provider's share of a wait, kept apart from the host's dead-air clock. Three durations and
    // the session they belong to, never any turn content.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'msSinceOwnerFinal', 'msSinceToolOutput'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
    if (!isSafeCount(value.generation) || !isSafeCount(value.msSinceOwnerFinal)) return;
    if (!(value.msSinceToolOutput === null || isSafeCount(value.msSinceToolOutput))) return;
    return { event: 'live_response_latency', liveSessionId: value.liveSessionId, generation: value.generation,
      msSinceOwnerFinal: value.msSinceOwnerFinal, msSinceToolOutput: value.msSinceToolOutput };
  }
  if (value.event === 'live_turn_open') {
    // #303: the provider streamed model audio and then went quiet without a turnComplete.
    // One duration, never any turn content.
    if (Object.keys(value).sort().join(',') !== ['event', 'msSinceLastModelAudio'].sort().join(',')) return;
    if (!isSafeCount(value.msSinceLastModelAudio)) return;
    return { event: 'live_turn_open', msSinceLastModelAudio: value.msSinceLastModelAudio };
  }
  if (value.event === 'live_idle_arm') {
    // #592: which closed cause last restarted the idle clock, and how long the clock now runs.
    const causes = ['opened', 'unmuted', 'tool_result', 'turn_failed', 'typed', 'owner_speech', 'model_audio'];
    if (!closedKeys(value, ['event', 'idleMs', 'resetBy'])) return;
    if (typeof value.resetBy !== 'string' || !causes.includes(value.resetBy)) return;
    if (!isSafeCount(value.idleMs)) return;
    return { event: 'live_idle_arm', resetBy: value.resetBy, idleMs: value.idleMs };
  }
  if (value.event === 'live_mute') {
    // The owner's mute, one record per change: which session and generation, whether the provider
    // session was still open after it, and how long the mute had lasted. A held answer that could
    // not be offered in its window is the same record with the skip and its reason.
    if (closedKeys(value, ['event', 'liveSessionId', 'generation', 'muted', 'warm', 'msSinceMute', 'offer', 'reason'])) {
      if (!isSafeId(value.liveSessionId) || !isSafeCount(value.generation) || !isSafeCount(value.msSinceMute)) return;
      if (typeof value.muted !== 'boolean' || typeof value.warm !== 'boolean') return;
      if (value.offer !== 'offer_skipped') return;
      if (!isSafeMember(value.reason, ['owner_spoke', 'send_failed'])) return;
      return { event: 'live_mute', liveSessionId: value.liveSessionId, generation: value.generation,
        muted: value.muted, warm: value.warm, msSinceMute: value.msSinceMute, offer: value.offer, reason: value.reason };
    }
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation', 'muted', 'warm', 'msSinceMute'])) return;
    if (!isSafeId(value.liveSessionId) || !isSafeCount(value.generation) || !isSafeCount(value.msSinceMute)) return;
    if (typeof value.muted !== 'boolean' || typeof value.warm !== 'boolean') return;
    return { event: 'live_mute', liveSessionId: value.liveSessionId, generation: value.generation,
      muted: value.muted, warm: value.warm, msSinceMute: value.msSinceMute };
  }
  if (value.event === 'live_input_dead') {
    // C-MICWATCH 4: a provider session expired with zero owner audio, so the call ended instead of rebuilding.
    if (!closedKeys(value, ['event', 'liveSessionId', 'generation'])) return;
    if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId) || !isSafeCount(value.generation)) return;
    return { event: 'live_input_dead', liveSessionId: value.liveSessionId, generation: value.generation };
  }
  if (value.event === 'live_watchdog') {
    // 3j: the response watchdog, one record per phase change. Phase, turn age, connection generation and whether
    // the wait began at a tool result (C-WATCH), so a post-tool wait is never read as an owner-turn wait. A settle
    // that knows the last tool result also carries its age, which is the decision W4-R1 turns on.
    const keys = ['event', 'generation', 'phase', 'turnAgeMs', 'sinceTool'];
    const extended = Object.hasOwn(value, 'msSinceToolResult') ? [...keys, 'msSinceToolResult'] : keys;
    if (Object.keys(value).sort().join(',') !== [...extended].sort().join(',')) return;
    if (!isSafeMember(value.phase, ['armed', 'nudged', 'closed', 'recovering', 'recovered', 'settled'])) return;
    if (!isSafeCount(value.turnAgeMs) || !isSafeCount(value.generation) || typeof value.sinceTool !== 'boolean') return;
    if (Object.hasOwn(value, 'msSinceToolResult') && !isSafeCount(value.msSinceToolResult)) return;
    return { event: 'live_watchdog', phase: value.phase, turnAgeMs: value.turnAgeMs, generation: value.generation, sinceTool: value.sinceTool,
      ...(Object.hasOwn(value, 'msSinceToolResult') ? { msSinceToolResult: value.msSinceToolResult } : {}) };
  }
  if (value.event === 'live_debt') {
    // #538: the audible debt clock, one record per phase change. Enums only, so no duration, no text, no provider word.
    if (!closedKeys(value, ['event', 'phase', 'reason'])) return;
    if (!isSafeMember(value.phase, DEBT_PHASES) || !isSafeMember(value.reason, DEBT_REASONS)) return;
    return { event: 'live_debt', phase: value.phase, reason: value.reason };
  }
  if (value.event === 'turn_failed') {
    // #538: the typed failed turn the voice can name, from the closed reason set.
    if (!closedKeys(value, ['event', 'reason'])) return;
    if (!isSafeMember(value.reason, TURN_FAILED_REASONS)) return;
    return { event: 'turn_failed', reason: value.reason };
  }
  if (value.event === 'live_late_note_ledger') {
    // C-REBUILD B: a held late finding whose response was torn down stays in the research ledger. Named, counted,
    // and never a send.
    if (!closedKeys(value, ['event', 'reason', 'generation'])) return;
    if (!isSafeMember(value.reason, ['generation_torn_down'])) return;
    if (!isSafeCount(value.generation)) return;
    return { event: 'live_late_note_ledger', reason: value.reason, generation: value.generation };
  }
  if (value.event === 'live_watchdog_hold') {
    // C-REBUILD: a watchdog deadline held back, with the reason it was held. Counts and enums only.
    if (!closedKeys(value, ['event', 'reason', 'generation', 'delayMs'])) return;
    if (!isSafeMember(value.reason, ['owner_speaking'])) return;
    for (const field of ['generation', 'delayMs']) if (!isSafeCount(value[field])) return;
    return { event: 'live_watchdog_hold', reason: value.reason, generation: value.generation, delayMs: value.delayMs };
  }
  if (value.event === 'live_rebuild_held') {
    // C-REBUILD A: a rebuild that stood down because a response was in flight, with its named reason, that
    // response's age, the wait it took instead and how many times this call has held. A count, never an absence.
    if (!closedKeys(value, ['event', 'reason', 'generation', 'ageMs', 'holdMs', 'heldCount'])) return;
    if (!isSafeMember(value.reason, ['response_in_flight'])) return;
    for (const field of ['generation', 'ageMs', 'holdMs', 'heldCount']) if (!isSafeCount(value[field])) return;
    return { event: 'live_rebuild_held', reason: value.reason, generation: value.generation, ageMs: value.ageMs,
      holdMs: value.holdMs, heldCount: value.heldCount };
  }
  if (value.event === 'live_rebuild_removed') {
    // C-REBUILD C: the owner turn whose rebuild was removed. The reason is the council's own: no tool work and no
    // response created, so nothing was owed to the provider and a dead socket waits for him to speak again.
    if (!closedKeys(value, ['event', 'reason', 'generation', 'turnAgeMs', 'removedCount'])) return;
    if (!isSafeMember(value.reason, ['owner_turn_no_tool_no_response'])) return;
    for (const field of ['generation', 'turnAgeMs', 'removedCount']) if (!isSafeCount(value[field])) return;
    return { event: 'live_rebuild_removed', reason: value.reason, generation: value.generation,
      turnAgeMs: value.turnAgeMs, removedCount: value.removedCount };
  }
  if (value.event === 'live_rebuild') {
    // #591: every rebuild names its trigger from the closed set, so a silent model and a quiet room are told
    // apart. C-CONTINUITY R-01/R-02: the trigger and the cause are the outcome's, and a transport receipt's close
    // code and sanitized reason ride along when the socket left one. Metadata only, never owner text.
    const keys = ['event', 'trigger', 'liveSessionId', 'generation', 'cause'];
    const response = responsePair(value);
    if (response === undefined) return;
    const base = Object.hasOwn(value, 'closeCode') ? [...keys, 'closeCode', 'closeReason'] : keys;
    const extended = Object.hasOwn(value, 'responseCreated') ? [...base, 'responseCreated', 'msSinceResponseCreated'] : base;
    if (!closedKeys(value, extended)) return;
    if (!isSafeMember(value.trigger, LIVE_REBUILD_TRIGGERS)) return;
    if (!isSafeMember(value.cause, LOG_CAUSES)) return;
    if (!isSafeId(value.liveSessionId) || !isSafeCount(value.generation)) return;
    if (Object.hasOwn(value, 'closeCode')) {
      if (!isSafeCloseCode(value.closeCode) || !isSafeCloseReason(value.closeReason)) return;
      return { event: 'live_rebuild', trigger: value.trigger, cause: value.cause, liveSessionId: value.liveSessionId,
        generation: value.generation, closeCode: value.closeCode, closeReason: value.closeReason, ...response };
    }
    return { event: 'live_rebuild', trigger: value.trigger, cause: value.cause, liveSessionId: value.liveSessionId, generation: value.generation, ...response };
  }
  if (value.event === 'research_context_rebuild') {
    // C-CONTINUITY R-14: the planned rebuild reaches host.log with sizes only: what the call had retained, what the
    // ledger kept, how much transcript the seed carried, and the call's total context, refusals included.
    if (!closedKeys(value, ['event', 'retainedChars', 'ledgerChars', 'seedTranscriptChars', 'rebuilds', 'totalContextChars'])) return;
    for (const field of ['retainedChars', 'ledgerChars', 'seedTranscriptChars', 'rebuilds', 'totalContextChars']) {
      if (!isSafeCount(value[field])) return;
    }
    return { event: 'research_context_rebuild', retainedChars: value.retainedChars, ledgerChars: value.ledgerChars,
      seedTranscriptChars: value.seedTranscriptChars, rebuilds: value.rebuilds, totalContextChars: value.totalContextChars };
  }
  if (value.event === 'live_turn_script') {
    // E1: which script the model spoke this turn, in closed buckets and code-point counts. Never text.
    if (Object.keys(value).sort().join(',') !== ['event', 'liveSessionId', 'script', 'latinChars', 'devanagariChars', 'teluguChars', 'kannadaChars', 'afterTool', 'interrupted'].sort().join(',')) return;
    if (typeof value.liveSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.liveSessionId)) return;
    if (!isSafeMember(value.script, ['latin', 'devanagari', 'telugu', 'kannada', 'mixed'])) return;
    if (!isSafeCount(value.latinChars) || !isSafeCount(value.devanagariChars) || !isSafeCount(value.teluguChars) || !isSafeCount(value.kannadaChars)) return;
    if (typeof value.afterTool !== 'boolean' || typeof value.interrupted !== 'boolean') return;
    return { event: 'live_turn_script', liveSessionId: value.liveSessionId, script: value.script, latinChars: value.latinChars, devanagariChars: value.devanagariChars, teluguChars: value.teluguChars, kannadaChars: value.kannadaChars, afterTool: value.afterTool, interrupted: value.interrupted };
  }
  if (value.event === 'live_state') {
    // F7/GL2-R1: one closed-shape transition record per projected state change, with the state it came from
    // and the cause, so the orb timeline is reconstructable from host.log. Enums and an epoch millisecond
    // only, never any turn content.
    const hasFrom = Object.prototype.hasOwnProperty.call(value, 'from');
    // A state line names the session and the connection generation it belongs to, so a rebuild reads from
    // the log alone; a poll with no live handle in this process writes neither.
    const hasSession = Object.prototype.hasOwnProperty.call(value, 'liveSessionId');
    const sessionKeys = hasSession ? ['liveSessionId', 'generation'] : [];
    if (!closedKeys(value, [...(hasFrom ? ['event', 'state', 'from', 'cause', 'at'] : ['event', 'state', 'cause', 'at']), ...sessionKeys])) return;
    if (hasSession) {
      if (typeof value.liveSessionId !== 'string' || !SESSION_ID.test(value.liveSessionId)) return;
      if (!isSafeCount(value.generation)) return;
    }
    if (!isSafeMember(value.state, LIVE_STATES) || !isSafeMember(value.cause, LIVE_STATE_CAUSES)) return;
    if (hasFrom && !isSafeMember(value.from, LIVE_STATES)) return;
    if (!isSafeCount(value.at)) return;
    return { event: 'live_state', state: value.state, ...(hasFrom ? { from: value.from } : {}), cause: value.cause, at: value.at, ...(hasSession ? { liveSessionId: value.liveSessionId, generation: value.generation } : {}) };
  }
  // GL2-R1: the adapter receipts are metadata only (names, counts and milliseconds), so they cross the same
  // boundary as live_state instead of sitting on stderr where no log could prove them.
  if (value.event === 'openai_instructions_size') {
    if (!closedKeys(value, ['event', 'chars', 'bytes'])) return;
    if (!isSafeCount(value.chars) || !isSafeCount(value.bytes)) return;
    return { event: 'openai_instructions_size', chars: value.chars, bytes: value.bytes };
  }
  if (value.event === 'gptlive_append_ack') {
    // #438: the provider acknowledging an append is a known frame, named by kind alone.
    if (!closedKeys(value, ['event', 'kind'])) return;
    if (!isSafeMember(value.kind, ['thinking', 'commentary'])) return;
    return { event: 'gptlive_append_ack', kind: value.kind };
  }
  if (value.event === 'gptlive_unknown_frame') {
    // N1: an unread provider frame name, counted once per session. Bounded to a protocol token, never a body.
    if (!closedKeys(value, ['event', 'type', 'count'])) return;
    if (typeof value.type !== 'string' || value.type.length > 64 || !UNKNOWN_FRAME_TYPE.test(value.type)) return;
    if (!isSafeCount(value.count) || value.count < 1) return;
    return { event: 'gptlive_unknown_frame', type: value.type, count: value.count };
  }
  if (value.event === 'gptlive_turn_complete') {
    // C-LOG-ENVELOPE: the provider ids this turn already carries, as ids only, so a turn joins the
    // provider's own record without one word of its content.
    const ids = ['responseId', 'itemId', 'eventId'].filter(key => Object.prototype.hasOwnProperty.call(value, key));
    const keys = ['event', 'idleMs', 'drained', ...ids];
    if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) return;
    if (!isSafeCount(value.idleMs) || value.drained !== true) return;
    if (!ids.every(key => isProviderId(value[key]))) return;
    return { event: 'gptlive_turn_complete', idleMs: value.idleMs, drained: true, ...Object.fromEntries(ids.map(key => [key, value[key]])) };
  }
  if (value.event === 'live_provider_error') {
    if (!closedKeys(value, ['event', 'type', 'code', 'param'])) return;
    if (!isSafeToken(value.type) || !isSafeToken(value.code) || !isSafeToken(value.param)) return;
    return { event: 'live_provider_error', type: value.type, code: value.code, param: value.param };
  }
  if (value.event === 'live_continuation_timing') {
    const times = ['toolOutputAt', 'createAt', 'createdAt', 'firstItemAt', 'firstAudioAt'] as const;
    if (!times.every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0))) return;
    if (!['b', 'b-second', 'c', 'd-chain'].includes(String(value.class))) return;
    return { event: 'live_continuation_timing', ...Object.fromEntries(times.map(key => [key, value[key]])), class: value.class };
  }
  if (value.event === 'gptlive_tool_output') {
    // 3r: one tool answer per delegated response, its call count and whether a continuation reached the wire.
    // C-LOG-ENVELOPE adds the provider's ids, ids only.
    const ids = ['responseId', 'itemId', 'eventId'].filter(key => Object.prototype.hasOwnProperty.call(value, key));
    if (Object.keys(value).sort().join(',') !== [...['event', 'calls', 'responseCreate'], ...ids].sort().join(',')) return;
    if (!isSafeCount(value.calls)) return;
    if (value.responseCreate !== 'sent' && value.responseCreate !== 'retried' && value.responseCreate !== 'failed') return;
    if (!ids.every(key => isProviderId(value[key]))) return;
    return { event: 'gptlive_tool_output', calls: value.calls, responseCreate: value.responseCreate, ...Object.fromEntries(ids.map(key => [key, value[key]])) };
  }
  if (value.event === 'gptlive_delegation_stalled') {
    // 3r D4: detection only, so this is a receipt and never a command. Milliseconds since the outputs went out.
    if (!closedKeys(value, ['event', 'ms'])) return;
    if (!isSafeCount(value.ms)) return;
    return { event: 'gptlive_delegation_stalled', ms: value.ms };
  }
  if (value.event === 'delegation_open' || value.event === 'delegation_closed') {
    // 3r D4: the provider's own delegation window, in milliseconds from its stream offset or from its open, and on
    // the close, how many responses its chain named (S1-R1).
    if (value.event === 'delegation_closed') {
      if (!closedKeys(value, ['event', 'ms', 'responses'])) return;
      if (!isSafeCount(value.ms) || !isSafeCount(value.responses)) return;
      return { event: value.event, ms: value.ms, responses: value.responses };
    }
    if (!closedKeys(value, ['event', 'ms'])) return;
    if (!isSafeCount(value.ms)) return;
    return { event: value.event, ms: value.ms };
  }
  if (value.event === 'live_tool_turn') {
    // O1/F6: per-turn tool metrics, tool names, millisecond latency and per-endpoint peak concurrency only.
    const base = ['event', 'sequence', 'toolCallsThisTurn', 'toolLatencyMs', 'toolResponseWhileGenerating'];
    const hasPeak = Object.prototype.hasOwnProperty.call(value, 'peakInFlight');
    if (Object.keys(value).sort().join(',') !== [...base, ...(hasPeak ? ['peakInFlight'] : [])].sort().join(',')) return;
    if (!(value.sequence === null || isSafeCount(value.sequence))) return;
    if (!isSafeCount(value.toolCallsThisTurn) || typeof value.toolResponseWhileGenerating !== 'boolean') return;
    if (!Array.isArray(value.toolLatencyMs) || value.toolLatencyMs.length > 16) return;
    const latencies: { tool: string; ms: number }[] = [];
    for (const entry of value.toolLatencyMs) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const row = entry as Record<string, unknown>;
      if (Object.keys(row).sort().join(',') !== ['tool', 'ms'].sort().join(',')) return;
      if (!isSafeToken(row.tool) || !isSafeCount(row.ms)) return;
      latencies.push({ tool: row.tool, ms: row.ms });
    }
    let peakInFlight: { endpoint: string; peak: number }[] | undefined;
    if (hasPeak) {
      if (!Array.isArray(value.peakInFlight) || value.peakInFlight.length > 16) return;
      peakInFlight = [];
      for (const entry of value.peakInFlight) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        const row = entry as Record<string, unknown>;
        if (Object.keys(row).sort().join(',') !== ['endpoint', 'peak'].sort().join(',')) return;
        if (!isSafeToken(row.endpoint) || !isSafeCount(row.peak)) return;
        peakInFlight.push({ endpoint: row.endpoint, peak: row.peak });
      }
    }
    return { event: 'live_tool_turn', sequence: value.sequence, toolCallsThisTurn: value.toolCallsThisTurn, toolLatencyMs: latencies, toolResponseWhileGenerating: value.toolResponseWhileGenerating, ...(peakInFlight !== undefined ? { peakInFlight } : {}) };
  }
  if (value.event === 'tool_cancelled') {
    // O1: the cancelled tool, its call id and time in flight only, never arguments or results.
    if (Object.keys(value).sort().join(',') !== ['event', 'tool', 'id', 'msInFlight'].sort().join(',')) return;
    if (!isSafeToken(value.tool) || typeof value.id !== 'string' || !SAFE_CALL_ID.test(value.id)) return;
    if (!(value.msInFlight === null || isSafeCount(value.msInFlight))) return;
    return { event: 'tool_cancelled', tool: value.tool, id: value.id, msInFlight: value.msInFlight };
  }
  if (value.event === 'research_answer') {
    // R7: a call whose sources all settled before its answer point: how it answered and how long the owner waited.
    if (!closedKeys(value, ['event', 'researchId', 'kind', 'elapsedMs'])) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_answer');
    if (value.kind !== 'full') return;
    if (typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 120_000) return;
    return { event: 'research_answer', researchId: value.researchId, kind: 'full', elapsedMs: value.elapsedMs };
  }
  if (value.event === 'research_still_searching') {
    // R2/R7: the one short line an owner waiting on a research call hears at 10 s, and whether it was spoken.
    if (!closedKeys(value, ['event', 'researchId', 'elapsedMs', 'spoken'])) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_still_searching');
    if (typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 120_000) return;
    if (typeof value.spoken !== 'boolean') return;
    return { event: 'research_still_searching', researchId: value.researchId, elapsedMs: value.elapsedMs, spoken: value.spoken };
  }
  if (value.event === 'research_subcall') {
    // Q1: one metadata-only record per internal sub-call, never the query or result text. A calendar
    // sub-call also carries the resolved window kind, a closed enum, never a time or title.
    const subKeys = ['event', 'researchId', 'kind', 'tool', 'ok', 'items', 'rawBytes', 'keptBytes', 'queryChars', 'queryAuthor'];
    const hasError = Object.prototype.hasOwnProperty.call(value, 'errorCode');
    const hasWindow = Object.prototype.hasOwnProperty.call(value, 'window');
    const hasUnread = Object.prototype.hasOwnProperty.call(value, 'unread');
    const hasCall = Object.prototype.hasOwnProperty.call(value, 'callKey');
    const hasFrom = Object.prototype.hasOwnProperty.call(value, 'windowFrom');
    const hasTo = Object.prototype.hasOwnProperty.call(value, 'windowTo');
    const allowed = [...subKeys, ...(hasError ? ['errorCode'] : []), ...(hasWindow ? ['window'] : []), ...(hasUnread ? ['unread'] : []),
      ...(hasCall ? ['callKey'] : []), ...(hasFrom ? ['windowFrom'] : []), ...(hasTo ? ['windowTo'] : [])];
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_subcall');
    if (!isSafeMember(value.kind, RESEARCH_CANDIDATES) || !isSafeToken(value.tool)) return;
    if (typeof value.ok !== 'boolean') return;
    if (hasError && !isSafeToken(value.errorCode)) return;
    if (hasWindow && !isSafeMember(value.window, RESEARCH_WINDOW_KINDS)) return;
    if (hasUnread && !isSafeCount(value.unread)) return;
    if (!isSafeCount(value.items) || !isSafeCount(value.rawBytes) || !isSafeCount(value.keptBytes) || !isSafeCount(value.queryChars)) return;
    if (!isSafeMember(value.queryAuthor, ['routed', 'fallback', 'hint'])) return;
    // A resolved window is two calendar dates in the id form, never a query and never an event title.
    if (hasFrom !== hasTo) return;
    if (hasFrom && (!isSafeId(value.windowFrom) || !isSafeId(value.windowTo))) return;
    if (hasCall && !isCallKey(value.callKey)) return;
    return { event: 'research_subcall', researchId: value.researchId, ...(hasCall ? { callKey: value.callKey } : {}), kind: value.kind, tool: value.tool, ok: value.ok, ...(hasError ? { errorCode: value.errorCode } : {}), items: value.items, rawBytes: value.rawBytes, keptBytes: value.keptBytes, queryChars: value.queryChars, queryAuthor: value.queryAuthor, ...(hasWindow ? { window: value.window } : {}), ...(hasUnread ? { unread: value.unread } : {}), ...(hasFrom ? { windowFrom: value.windowFrom, windowTo: value.windowTo } : {}) };
  }
  if (value.event === 'conversation_summary_recovery') {
    // OUTCOME 3: the host-start recovery sweep, a count of rows re-queued and rows left for later only.
    if (Object.keys(value).sort().join(',') !== ['event', 'requeued', 'skipped'].sort().join(',')) return;
    if (!isSafeCount(value.requeued) || !isSafeCount(value.skipped)) return;
    return { event: 'conversation_summary_recovery', requeued: value.requeued, skipped: value.skipped };
  }
  if (typeof value.event === 'string' && SUMMARY_EVENTS.has(value.event)) {
    // W13: the distiller's outcome, session id, character counts, milliseconds and reason codes only.
    // C-SUMMARY8: phase names the start-up pass; the per-call schedule carries no phase.
    const counts = ['inputChars', 'outputChars', 'durationMs', 'retryCount'] as const;
    const allowed = ['event', 'liveSessionId', ...counts, 'truncated', 'errorCode', 'reason', 'phase'];
    if (Object.keys(value).some(key => !allowed.includes(key))) return;
    if (!isSafeId(value.liveSessionId)) return;
    if ('phase' in value && !isSafeMember(value.phase, SUMMARY_PHASES)) return;
    for (const name of counts) if (name in value && !isSafeCount(value[name])) return;
    if ('truncated' in value && typeof value.truncated !== 'boolean') return;
    if ('errorCode' in value && !isSafeToken(value.errorCode)) return;
    if ('reason' in value && !isSafeMember(value.reason, SUMMARY_REASONS)) return;
    return value;
  }
  if (value.event === 'commentary_sent') {
    // S4a: progress speech went out. Which delegation asked for it and why, never the line that was spoken.
    if (!closedKeys(value, ['event', 'delegationKey', 'reason'])) return;
    if (!isSafeId(value.delegationKey) || !isSafeMember(value.reason, PROGRESS_REASONS)) return;
    return { event: 'commentary_sent', delegationKey: value.delegationKey, reason: value.reason };
  }
  if (value.event === 'commentary_skipped') {
    // W4: a progress line was refused. Which delegation asked, and why it stayed silent; never any text.
    if (!closedKeys(value, ['event', 'delegationKey', 'reason'])) return;
    if (!isSafeId(value.delegationKey) || !isSafeMember(value.reason, PROGRESS_SKIP_REASONS)) return;
    return { event: 'commentary_skipped', delegationKey: value.delegationKey, reason: value.reason };
  }
  if (value.event === 'thinking_sent') {
    // S4a: silent context went out; the count alone, since the text is what the owner must never see in a log.
    if (!closedKeys(value, ['event', 'chars'])) return;
    if (!isSafeCount(value.chars)) return;
    return { event: 'thinking_sent', chars: value.chars };
  }
  if (value.event === 'tool_ceiling_hit') {
    // S4a: the host ceiling answered a call instead of the tool. The tool name, the wait and the settlement,
    // never its args: a read times out, a write is uncertain, and a cancelled one never ran.
    if (!closedKeys(value, ['event', 'tool', 'ms', 'outcome'])) return;
    if (!isSafeToken(value.tool) || !isSafeCount(value.ms) || !isSafeMember(value.outcome, CEILING_OUTCOMES)) return;
    return { event: 'tool_ceiling_hit', tool: value.tool, ms: value.ms, outcome: value.outcome };
  }
  if (value.event === 'tool_ceiling_late') {
    // S4a-R2 (a): a callback that landed after the ceiling settled the call. A receipt only: the settled output
    // stands, and this never writes a second one.
    if (!closedKeys(value, ['event', 'tool', 'outcome'])) return;
    if (!isSafeToken(value.tool) || !isSafeMember(value.outcome, LATE_OUTCOMES)) return;
    return { event: 'tool_ceiling_late', tool: value.tool, outcome: value.outcome };
  }
  if (value.event === 'command_rejected') {
    // S4a-R4: a provider error that names a client command. Code, param and the command family only.
    if (!closedKeys(value, ['event', 'code', 'param', 'kind'])) return;
    if (!isSafeToken(value.code) || !isSafeToken(value.param) || !isSafeMember(value.kind, COMMAND_KINDS)) return;
    return { event: 'command_rejected', code: value.code, param: value.param, kind: value.kind };
  }
  if (value.event === 'continuation_deferred') {
    // S5: a continuation is owed but a call of its batch has no output yet. The response it answers and how many
    // call outputs it waits for, never a call id and never an argument.
    if (!closedKeys(value, ['event', 'responseKey', 'awaiting'])) return;
    if (!isSafeToken(value.responseKey) || !isSafeCount(value.awaiting)) return;
    return { event: 'continuation_deferred', responseKey: value.responseKey, awaiting: value.awaiting };
  }

  if (value.event === 'response_first_audio') {
    // LAT-1022: a response's own decomposition, the same one a continuation already had, now for the first
    // response of a turn too: the response it belongs to, when its create went out, its first output-item
    // envelope and its first audible PCM, and whether it was the turn's first response or a continuation.
    // An audio-first response delivers its PCM BEFORE the item envelope, so `firstItemAt` is absent when the
    // item never preceded the end, and the pair is written as measured: nothing here is clamped to be positive.
    const hasItem = Object.prototype.hasOwnProperty.call(value, 'firstItemAt');
    if (!closedKeys(value, ['event', 'responseKey', 'createdAt', 'firstAudioAt', 'kind', ...(hasItem ? ['firstItemAt'] : [])])) return;
    if (!isSafeToken(value.responseKey) || !isSafeMember(value.kind, ['first', 'continuation'])) return;
    if (!isSafeCount(value.createdAt) || !isSafeCount(value.firstAudioAt)) return;
    if (hasItem && !isSafeCount(value.firstItemAt)) return;
    return { event: 'response_first_audio', responseKey: value.responseKey, createdAt: value.createdAt,
      ...(hasItem ? { firstItemAt: value.firstItemAt as number } : {}), firstAudioAt: value.firstAudioAt, kind: value.kind };
  }
  if (value.event === 'connector_request') {
    // LAT-1022: one line at the end of every connector request, so a slow connector is its own segment instead
    // of a number hidden inside the tool's total. The connector and the stage are closed words, the duration a
    // count and the outcome the call's own closed state. `callKey` is named when the caller has one; the
    // envelope already names the turn and the endpoint, so nothing here is ever an argument or a result.
    const hasKey = Object.prototype.hasOwnProperty.call(value, 'callKey');
    if (!closedKeys(value, ['event', 'connector', 'stage', 'ms', 'outcome', ...(hasKey ? ['callKey'] : [])])) return;
    if (hasKey && !isCallKey(value.callKey)) return;
    if (!isSafeId(value.connector) || !isSafeMember(value.stage, MONGOOSE_REQUEST_STAGES) || !isSafeCount(value.ms)) return;
    if (!isSafeMember(value.outcome, ['ok', 'refused', 'failed', 'unknown'])) return;
    return { event: 'connector_request', ...(hasKey ? { callKey: value.callKey } : {}), connector: value.connector,
      stage: value.stage, ms: value.ms, outcome: value.outcome };
  }
  if (value.event === 'provider_output_ack') {
    // LAT-1022: the provider acknowledged a function output, so the wait between writing the output and the
    // provider taking it is its own segment. The call and a count, never the output.
    if (!closedKeys(value, ['event', 'callKey', 'ms'])) return;
    // The provider's own call id is the key here (`call_...`), never the host's scoped trace key, so the closed
    // shape is the provider-id shape: no dot, slash or space, and a bounded length.
    if (typeof value.callKey !== 'string' || !SAFE_CALL_ID.test(value.callKey) || !isSafeCount(value.ms)) return;
    return { event: 'provider_output_ack', callKey: value.callKey, ms: value.ms };
  }
  if (value.event === 'turn_failed') {
    // S5: a backend response ended failed, incomplete or errored. The provider's code, nothing else.
    if (!closedKeys(value, ['event', 'code'])) return;
    if (!isSafeToken(value.code)) return;
    return { event: 'turn_failed', code: value.code };
  }
  if (value.event === 'provider_error_unclassified') {
    // S4a-R2 (c): a provider error no disposition map entry claimed. Its own type, code and param, nothing else.
    if (!closedKeys(value, ['event', 'type', 'code', 'param'])) return;
    if (!isSafeToken(value.type) || !isSafeToken(value.code) || !isSafeToken(value.param)) return;
    return { event: 'provider_error_unclassified', type: value.type, code: value.code, param: value.param };
  }
  if (value.event === 'first_response_audio_unsupported') {
    // C-POSTTOOL switch a: the provider refused the delegated audio output, at most once per session, so the
    // field, its code and its parameter are the whole receipt.
    if (!closedKeys(value, ['event', 'type', 'code', 'param'])) return;
    if (!isSafeToken(value.type) || !isSafeToken(value.code) || !isSafeToken(value.param)) return;
    return { event: 'first_response_audio_unsupported', type: value.type, code: value.code, param: value.param };
  }
  if (value.event === 'responses_validation_failed') {
    // S4a-R4: the backend refused its own delegation config. The refused field, once per session.
    if (!closedKeys(value, ['event', 'param'])) return;
    if (!isSafeToken(value.param)) return;
    return { event: 'responses_validation_failed', param: value.param };
  }
  if (value.event === 'warm_prewarm') {
    // 338: the owner's forced warm refresh. Two ages and whether an assembly replaced the old one:
    // never the calendar digest, the summary or any prompt text. Which source that assembly came from is
    // on the receipt the caller holds (R7), not on this line.
    if (!closedKeys(value, ['event', 'ageBeforeMs', 'ageAfterMs', 'assembled'])) return;
    const age = (field: unknown): boolean => field === null || isSafeCount(field);
    if (!age(value.ageBeforeMs) || !age(value.ageAfterMs)) return;
    if (typeof value.assembled !== 'boolean') return;
    return { event: 'warm_prewarm', ageBeforeMs: value.ageBeforeMs, ageAfterMs: value.ageAfterMs, assembled: value.assembled };
  }
  if (value.event === 'calendar_digest') {
    // R7: the warm digest used to be silent when it was suppressed or failed. One closed line says which
    // of four states it reached, how many events rode it and how old it was, never an event's text.
    if (!closedKeys(value, ['event', 'state', 'items', 'ageMs'])) return;
    if (!CALENDAR_DIGEST_STATES.includes(value.state as typeof CALENDAR_DIGEST_STATES[number])) return;
    if (!isSafeCount(value.items) || !isSafeCount(value.ageMs)) return;
    return { event: 'calendar_digest', state: value.state, items: value.items, ageMs: value.ageMs };
  }
  if (value.event === 'calendar_digest_refreshed') {
    // L2: which edge read the digest again and how long the read took, never a day or an event.
    if (!closedKeys(value, ['event', 'reason', 'ms'])) return;
    if (!isSafeMember(value.reason, CALENDAR_DIGEST_REFRESH_REASONS)) return;
    if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < 0 || value.ms > 900_000) return;
    return { event: 'calendar_digest_refreshed', reason: value.reason, ms: Math.round(value.ms) };
  }
  if (value.event === 'calendar_digest_timeout') {
    // 556: the read the ten second deadline cut, with the edge that owed it and how long it held, never a day.
    if (!closedKeys(value, ['event', 'reason', 'ms'])) return;
    if (!isSafeMember(value.reason, CALENDAR_DIGEST_REFRESH_REASONS)) return;
    if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < 0 || value.ms > 900_000) return;
    return { event: 'calendar_digest_timeout', reason: value.reason, ms: Math.round(value.ms) };
  }
  if (value.event === 'host_resources') {
    // L12d: this process's own footprint while a call is live. Megabytes to one decimal, CPU as a
    // percentage of one core over the last window: numbers only, never a device or a person.
    if (!closedKeys(value, ['event', 'rssMb', 'heapUsedMb', 'cpuPct'])) return;
    const mb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_048_576;
    const pct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 6400;
    if (!mb(value.rssMb) || !mb(value.heapUsedMb) || !pct(value.cpuPct)) return;
    return { event: 'host_resources', rssMb: value.rssMb, heapUsedMb: value.heapUsedMb, cpuPct: value.cpuPct };
  }
  if (value.event === 'opener_plan') {
    // M1's plan receipt, which rode the debug journal until O1b-A removed it: the kinds offered and the
    // start counter that chose them, never the owner's text.
    if (!closedKeys(value, ['event', 'kinds', 'rotation'])) return;
    const kinds = value.kinds;
    if (!Array.isArray(kinds) || kinds.length > 4 || kinds.some(kind => !isSafeToken(kind))) return;
    if (!isSafeCount(value.rotation)) return;
    return { event: 'opener_plan', kinds, rotation: value.rotation };
  }
}

/** H-07: the end codes that are the call finishing, not the host failing. */
const NORMAL_END_CODES = new Set(['closed', 'voice_stop', 'user_stop', 'idle_timeout']);

export class HostLog {
  private readonly path: string;
  private readyLogged = false;
  constructor(dataDir: string, private readonly limit = 5 * 1024 * 1024,
    private readonly startup?: { startedAt: number; now: () => number }) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const root = lstatSync(dataDir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid diagnostics state directory');
    const directory = join(dataDir, 'logs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid diagnostics directory');
    this.path = join(directory, 'host.log');
  }
  event(raw: unknown): void {
    const event = safeEvent(raw);
    if (!event) return;
    this.append(event);
    if (event.event === 'live_provider_ready' && this.startup && !this.readyLogged) {
      this.readyLogged = true;
      this.append({ event: 'host_ready_ms', ms: Math.max(0, Math.round(this.startup.now() - this.startup.startedAt)) });
    }
  }
  terminal(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const state = (raw as { state?: unknown }).state;
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) return;
    // H-07: a normal end is not a fault, so it is not a host_error. Only a failing end stays one.
    // C-LOG-ENVELOPE F2: the terminal line is the call's last line, so the call context ends with it and the
    // host's own aftermath (resources, idle arms, connector lines) is never attributed to a closed call.
    try {
      if (state === 'closed' || NORMAL_END_CODES.has(code)) this.append({ event: 'live_terminal', state, code });
      else this.append({ event: 'host_error', class: 'LiveTerminal', code });
    } finally { clearLogContext(); }
  }
  error(error: unknown): void {
    // Class is a closed token, and so is a code when the error carries one: a rejected live write names its own
    // class instead of surfacing as a bare Error. Exception messages and stacks are deliberately never read.
    const code = error instanceof ConfigError ? error.code : (error as { code?: unknown } | null | undefined)?.code;
    const closed = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? { code } : {};
    this.append({ event: 'host_error', class: error instanceof ConfigError ? 'ConfigError' : 'Error', ...closed });
  }
  private append(event: Record<string, unknown>): void {
    // C-LOG-ENVELOPE: one envelope, written here and nowhere else. A field the event already carries keeps
    // its own value, so no existing event shape changes meaning; the call context fills only what is absent.
    const name = typeof event.event === 'string' ? event.event : '';
    const severity = severityOf(name, event);
    // A line whose name says nothing about its domain carries no cause; an event that already names its
    // own cause keeps it, so no existing shape changes meaning.
    const record = { timestamp: new Date().toISOString(), monoMs: monoMilliseconds(), pid: process.pid, seq: nextSeq(),
      level: severity.level, ...(severity.cause === undefined ? {} : { cause: severity.cause }), ...envelopeContext(), ...event };
    const line = Buffer.from(JSON.stringify(record) + '\n');
    if (line.length > this.limit) return;
    let fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid diagnostics file');
      fchmodSync(fd, 0o600);
      if (info.size + line.length > this.limit) {
        closeSync(fd); fd = -1;
        if (existsSync(this.path + '.2')) unlinkSync(this.path + '.2');
        if (existsSync(this.path + '.1')) renameSync(this.path + '.1', this.path + '.2');
        renameSync(this.path, this.path + '.1');
        fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const rotated = fstatSync(fd);
        if (!rotated.isFile() || rotated.nlink !== 1 || (process.getuid && rotated.uid !== process.getuid())) throw new Error('Invalid diagnostics file');
        fchmodSync(fd, 0o600);
      }
      writeSync(fd, line);
    } finally { if (fd >= 0) closeSync(fd); }
  }
}

let installed = false;
const sinks = new Set<HostLog>();

// The host log event API lives in the tool layer so the tool call sites can emit diagnostics
// without importing the host; this module registers the durable sinks behind it.
export { hostLogEvent } from '../tools/host-events.js';
/** C-LOG-ENVELOPE: the live layer names its call once, and every line it emits while live carries it. */
export { clockSync, clearLogContext, logContext, setLogContext } from './events.js';

export function captureHostDiagnostics(log: HostLog): () => void {
  sinks.add(log);
  const detachHub = attachHostLogSink(log);
  if (!installed) {
    installed = true;
    // Captured only before the wrappers are installed, so unstructured console output can be sent
    // to stderr without recursing through the wrappers or reaching the protocol pipe.
    const toStderr = console.error.bind(console);
    for (const method of ['log', 'error', 'warn'] as const) {
      console[method] = (...args: unknown[]) => {
        for (const sink of sinks) {
          try {
            let event: unknown;
            if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
              try { event = JSON.parse(args[0]); } catch { /* not a structured event */ }
            }
            if (event) sink.event(event);
            else if (method !== 'log') sink.error(undefined);
          } catch { toStderr('diagnostics_unavailable'); }
        }
        toStderr(...args);
      };
    }
  }
  return () => { sinks.delete(log); detachHub(); };
}
