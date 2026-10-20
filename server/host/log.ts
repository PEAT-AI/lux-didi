import { RESEARCH_ARGUMENT_FIELDS, RESEARCH_ARGUMENT_TYPES, RESEARCH_REFUSAL_REASONS } from '../tools/research.js';
import { clientDiagnostic } from '../http/routes.js';
import { TOOL_FAILURE_CODES } from '../adapters/model/types.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { ConfigError } from '../config/files.js';
import { LIVE_INSTRUCTION_SECTION_IDS } from '../prompt/live-persona.js';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// The closed sets a metadata-only host diagnostic may name. Anything outside these is dropped.
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_CALL_ID = /^[A-Za-z0-9_.:~-]{1,128}$/;
const RESEARCH_SOURCES = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose', 'memory'];
const RESEARCH_CANDIDATES = ['knowledge_search', 'calendar_window', 'mail_search', 'mail_open', 'chat_search', 'chat_thread', 'brief', 'stop_answer', 'stop_insufficient', 'memory_search'];
const RESEARCH_STOPS = ['answered', 'selector_stop', 'insufficient', 'rounds_exhausted', 'no_candidates', 'voi_stop', 'ops_exhausted', 'deadline', 'cancelled', 'fallback', 'stop', 'failed', 'refused'];
const RESEARCH_PHASES = ['started', 'round', 'done', 'stopped'];
// #280: `routed` is the routed start's own driver; it never goes through the selector loop.
const RESEARCH_DRIVERS = ['selector', 'fallback', 'single-source-hint', 'routed'];
const RESEARCH_DISPOSITIONS = ['completed', 'skipped'];
// R7, 1015: the warm calendar digest's own closed vocabulary. `timeout` and `stale` are states in
// their own right, so a cut-off or old read is never reported as an empty day.
const CALENDAR_DIGEST_STATES = ['present', 'empty', 'failed', 'timeout', 'unconfigured', 'stale'];
// The projected Live state enum, mirrored from LivePageProjection['state'].
const LIVE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'rebuilding', 'ended', 'error'];
/** GL2-R1: why a projected state changed, a closed set, so host.log can say what moved the orb. */
export const LIVE_STATE_CAUSES = ['created', 'input', 'model_turn_start', 'audio', 'silence', 'turn_complete', 'interrupted',
  'tool', 'settle', 'rebuild', 'poll'] as const;
const RESEARCH_WINDOW_KINDS = ['today', 'tomorrow', 'week', 'date'];
/** K6: the layers a routed research call may name, in the model's own words. */
const ROUTED_SOURCES = ['memory', 'knowledge', 'company', 'calendar', 'mail', 'chat', 'replies'];
/** R6: how a late finding reached the voice model, and why it did or did not reach the owner. */
const LATE_DELIVERIES = ['commentary', 'thinking', 'dropped'];
const LATE_REASONS = ['quiet', 'no_new_findings', 'source_failed', 'session_closed', 'no_thinking_channel',
  'no_commentary_channel', 'already_spoken', 'window_elapsed', 'owner_speaking', 'new_question', 'answer_playing', 'send_failed'];
const ROUTED_OUTCOMES = ['ok', 'empty', 'unavailable', 'failed', 'timeout'];
// W13 distillation outcomes and the closed reason/error tokens they may name, never any summary text.
const SUMMARY_EVENTS = new Set(['conversation_summary_started', 'conversation_summary_completed', 'conversation_summary_failed', 'conversation_summary_skipped']);
const SUMMARY_REASONS = ['non_ordinary', 'too_few_turns', 'model_skip', 'no_text_model'];
/** S4a: why a progress line was sent, as a closed set (never free text). */
const PROGRESS_REASONS = ['dead_air', 'stalled', 'lookup'];
/** S4a-R2 (a): how a call settled at the host ceiling, and how a late callback reported itself. A call the
 *  provider cancelled never settles at the ceiling: its own `tool_cancelled` receipt names it, with no answer. */
const CEILING_OUTCOMES = ['timeout', 'uncertain'];
const LATE_OUTCOMES = ['completed', 'failed'];
/** S4a-R4: the command families a rejected client event id can name. */
const COMMAND_KINDS = ['tool_out', 'cont', 'cmt', 'thk', 'other'];
const isSafeToken = (value: unknown): value is string => typeof value === 'string' && SAFE_TOKEN.test(value);
const isSafeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);
/**
 * Z1: a research line whose id fails SAFE_ID used to be dropped whole, so a run that really happened left
 * no receipt and read as a run that never happened. The replacement names the event and the field only,
 * never the value.
 */
const rejectResearchId = (event: string): Record<string, unknown> => ({ event: 'research_id_rejected', kind: event, field: 'researchId' });
const isSafeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** A provider frame name: lowercase dots and underscores, as the Live reference writes them, never free text. */
const UNKNOWN_FRAME_TYPE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
const isSafeMember = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value);
const isSafeMembers = (value: unknown, allowed: readonly string[]): value is string[] => Array.isArray(value) && value.length <= 16 && value.every(item => isSafeMember(item, allowed));
/** A closed shape: exactly these keys, so no field a later caller adds can slip through the whitelist. */
const closedKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Only the existing diagnostic schemas cross this boundary, never arbitrary console text.
export function safeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
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
  if (value.event === 'native_action') {
    // Closed receipt: the action, its ack code and a scheme or extension, never the target.
    const allowed = ['action', 'code', 'detail', 'event'];
    if (Object.keys(value).sort().join(',') !== allowed.join(',')) return;
    if (typeof value.action !== 'string' || !['open_url', 'open_file', 'open_app'].includes(value.action)) return;
    if (typeof value.code !== 'string' || !['opened', 'not_allowed', 'not_found', 'failed'].includes(value.code)) return;
    if (typeof value.detail !== 'string' || !/^[a-z0-9]{1,16}$/.test(value.detail)) return;
    return { event: 'native_action', action: value.action, code: value.code, detail: value.detail };
  }
  if (value.event === 'tool_redaction') {
    // The receipt names the tool and the count of secrets, never the value.
    if (Object.keys(value).sort().join(',') !== ['count', 'event', 'tool'].sort().join(',')) return;
    if (!SAFE_TOKEN.test(String(value.tool)) || typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1 || value.count > 1_000_000) return;
    return { event: 'tool_redaction', tool: value.tool, count: value.count };
  }
  if (value.event === 'live_trace_rejected') {
    // O1b-A: the trace store's own receipt for a refused write: the kind and the store's typed code only,
    // never a payload. It replaces the debug journal's error receipt in the same slot in this whitelist.
    if (Object.keys(value).sort().join(',') !== ['code', 'event', 'kind'].sort().join(',')) return;
    if (!isSafeToken(value.kind) || !isSafeToken(value.code)) return;
    return { event: 'live_trace_rejected', kind: value.kind, code: value.code };
  }
  if (value.event === 'connector_failure') {
    // Closed connect-time stage only, never a message, a URL or a credential value. The diagnostic
    // fields are bounded tokens; a free-text reason or an out-of-vocabulary attempt drops the event.
    const stages = ['credential', 'spawn', 'handshake', 'first_call'];
    const attempts = ['first-connect', 'refresh'];
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    const hasReason = Object.prototype.hasOwnProperty.call(value, 'reason');
    const hasException = Object.prototype.hasOwnProperty.call(value, 'exceptionCode');
    const hasEndpoint = Object.prototype.hasOwnProperty.call(value, 'endpointId');
    const hasAttempt = Object.prototype.hasOwnProperty.call(value, 'attempt');
    const allowed = ['connector', 'event', 'stage', ...(hasReason ? ['reason'] : []), ...(hasException ? ['exceptionCode'] : []), ...(hasEndpoint ? ['endpointId'] : []), ...(hasAttempt ? ['attempt'] : [])];
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) return;
    if (!token(value.connector) || typeof value.stage !== 'string' || !stages.includes(value.stage)) return;
    if (hasReason && !token(value.reason)) return;
    if (hasException && !token(value.exceptionCode)) return;
    if (hasEndpoint && !isSafeId(value.endpointId)) return;
    if (hasAttempt && (typeof value.attempt !== 'string' || !attempts.includes(value.attempt))) return;
    return { event: 'connector_failure', connector: value.connector, stage: value.stage, ...(hasReason ? { reason: value.reason } : {}), ...(hasException ? { exceptionCode: value.exceptionCode } : {}), ...(hasEndpoint ? { endpointId: value.endpointId } : {}), ...(hasAttempt ? { attempt: value.attempt } : {}) };
  }
  if (value.event === 'connector_identity') {
    // Closed identity proof only: a connector name and two booleans, never the identity itself.
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
    if (Object.keys(value).sort().join(',') !== ['connector', 'event', 'match', 'proven'].sort().join(',')) return;
    if (!token(value.connector) || typeof value.proven !== 'boolean') return;
    if (value.match !== null && typeof value.match !== 'boolean') return;
    return { event: 'connector_identity', connector: value.connector, proven: value.proven, match: value.match };
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
  if (value.event === 'live_attach_rejected' && typeof value.code === 'string' && /^[A-Za-z0-9_]{1,107}$/.test(value.code)) {
    return { event: value.event, ...(typeof value.liveSessionId === 'string' && /^[0-9a-f-]{36}$/i.test(value.liveSessionId) ? { liveSessionId: value.liveSessionId } : {}), code: value.code };
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
  if (value.event === 'memory_note') {
    // Closed shape: whether the note was saved, its code, the note's content word count and the share
    // of those words one owner turn supported. Never the note text.
    if (Object.keys(value).sort().join(',') !== ['event', 'remembered', 'code', 'words', 'supportRatio'].sort().join(',')) return;
    if (typeof value.remembered !== 'boolean') return;
    if (typeof value.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.code)) return;
    if (!Number.isSafeInteger(value.words) || Number(value.words) < 0 || Number(value.words) > 10_000) return;
    if (typeof value.supportRatio !== 'number' || !Number.isFinite(value.supportRatio) || value.supportRatio < 0 || value.supportRatio > 1) return;
    return { event: 'memory_note', remembered: value.remembered, code: value.code, words: value.words, supportRatio: value.supportRatio };
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
    // Closed shape: tool name and argument key:type paths only, never a value.
    if (Object.keys(value).sort().join(',') !== ['event', 'tool', 'fields'].sort().join(',')) return;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}:(string|number|boolean|array|object|null|undefined)$/;
    if (!token(value.tool)) return;
    if (!Array.isArray(value.fields) || value.fields.length > 24 || value.fields.some(field => typeof field !== 'string' || !fieldPattern.test(field))) return;
    return { event: 'tool_arguments_rejected', tool: value.tool, fields: value.fields };
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
  if (value.event === 'live_recovery') {
    // Closed shape: one metadata-only record per recovery attempt. Never audio, text or a provider payload;
    // seedTurns/seedChars are the rebuilt journal seed's size, path is the transport chosen.
    if (Object.keys(value).sort().join(',') !== ['event', 'path', 'attempt', 'code', 'closeCode', 'reason', 'seedTurns', 'seedChars'].sort().join(',')) return;
    if (!isSafeMember(value.path, ['resume', 'fresh_seeded'])) return;
    if (!isSafeCount(value.attempt) || Number(value.attempt) < 1) return;
    if (!isSafeToken(value.code)) return;
    if (!(value.closeCode === null || (Number.isSafeInteger(value.closeCode) && Number(value.closeCode) >= 0 && Number(value.closeCode) <= 65535))) return;
    if (!(value.reason === null || isSafeToken(value.reason))) return;
    if (!isSafeCount(value.seedTurns) || !isSafeCount(value.seedChars)) return;
    return { event: 'live_recovery', path: value.path, attempt: value.attempt, code: value.code, closeCode: value.closeCode, reason: value.reason, seedTurns: value.seedTurns, seedChars: value.seedChars };
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
    // Closed shape (3o): mic frame bytes shed from the front of the uplink queue, and the peak backlog of the
    // window. One record per UPLINK_SHED_RECEIPT_MS at most, never one per shed frame.
    if (!closedKeys(value, ['event', 'bytes', 'bufferedPeak'])) return;
    if (!isSafeCount(value.bytes) || !isSafeCount(value.bufferedPeak)) return;
    return { event: 'uplink_shed', bytes: value.bytes, bufferedPeak: value.bufferedPeak };
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
    if (value.reason !== 'user_stop' && value.reason !== 'consumer_closed') return;
    if (!isSafeCount(value.msAfterStop)) return;
    return { event: 'session_end', reason: value.reason, msAfterStop: value.msAfterStop };
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
    if (Object.keys(value).sort().join(',') === stallKeys) {
      if (!isSafeCount(value.msSinceTool)) return;
      if (!(value.msSinceAudible === null || isSafeCount(value.msSinceAudible))) return;
      return { event: 'live_dead_air', msSinceTool: value.msSinceTool, msSinceAudible: value.msSinceAudible };
    }
    if (Object.keys(value).sort().join(',') !== ['event', 'deadAirMs'].sort().join(',')) return;
    if (!isSafeCount(value.deadAirMs)) return;
    return { event: 'live_dead_air', deadAirMs: value.deadAirMs };
  }
  if (value.event === 'live_turn_open') {
    // #303: the provider streamed model audio and then went quiet without a turnComplete.
    // One duration, never any turn content.
    if (Object.keys(value).sort().join(',') !== ['event', 'msSinceLastModelAudio'].sort().join(',')) return;
    if (!isSafeCount(value.msSinceLastModelAudio)) return;
    return { event: 'live_turn_open', msSinceLastModelAudio: value.msSinceLastModelAudio };
  }
  if (value.event === 'live_watchdog') {
    // 3j: the response watchdog, one record per phase change. Phase, turn age and connection generation only.
    if (Object.keys(value).sort().join(',') !== ['event', 'generation', 'phase', 'turnAgeMs'].sort().join(',')) return;
    if (!isSafeMember(value.phase, ['armed', 'nudged', 'recovered', 'settled'])) return;
    if (!isSafeCount(value.turnAgeMs) || !isSafeCount(value.generation)) return;
    return { event: 'live_watchdog', phase: value.phase, turnAgeMs: value.turnAgeMs, generation: value.generation };
  }
  if (value.event === 'live_turn_script') {
    // E1: which script the model spoke this turn, in closed buckets and code-point counts. Never text.
    if (Object.keys(value).sort().join(',') !== ['event', 'liveSessionId', 'script', 'latinChars', 'devanagariChars', 'afterTool', 'interrupted'].sort().join(',')) return;
    if (typeof value.liveSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.liveSessionId)) return;
    if (!isSafeMember(value.script, ['latin', 'devanagari', 'mixed'])) return;
    if (!isSafeCount(value.latinChars) || !isSafeCount(value.devanagariChars)) return;
    if (typeof value.afterTool !== 'boolean' || typeof value.interrupted !== 'boolean') return;
    return { event: 'live_turn_script', liveSessionId: value.liveSessionId, script: value.script, latinChars: value.latinChars, devanagariChars: value.devanagariChars, afterTool: value.afterTool, interrupted: value.interrupted };
  }
  if (value.event === 'live_state') {
    // F7/GL2-R1: one closed-shape transition record per projected state change, with the state it came from
    // and the cause, so the orb timeline is reconstructable from host.log. Enums and an epoch millisecond
    // only, never any turn content.
    const hasFrom = Object.prototype.hasOwnProperty.call(value, 'from');
    if (!closedKeys(value, [...(hasFrom ? ['event', 'state', 'from', 'cause', 'at'] : ['event', 'state', 'cause', 'at'])])) return;
    if (!isSafeMember(value.state, LIVE_STATES) || !isSafeMember(value.cause, LIVE_STATE_CAUSES)) return;
    if (hasFrom && !isSafeMember(value.from, LIVE_STATES)) return;
    if (!isSafeCount(value.at)) return;
    return { event: 'live_state', state: value.state, ...(hasFrom ? { from: value.from } : {}), cause: value.cause, at: value.at };
  }
  // GL2-R1: the adapter receipts are metadata only (names, counts and milliseconds), so they cross the same
  // boundary as live_state instead of sitting on stderr where no log could prove them.
  if (value.event === 'openai_instructions_size') {
    if (!closedKeys(value, ['event', 'chars', 'bytes'])) return;
    if (!isSafeCount(value.chars) || !isSafeCount(value.bytes)) return;
    return { event: 'openai_instructions_size', chars: value.chars, bytes: value.bytes };
  }
  if (value.event === 'gptlive_unknown_frame') {
    // N1: an unread provider frame name, counted once per session. Bounded to a protocol token, never a body.
    if (!closedKeys(value, ['event', 'type', 'count'])) return;
    if (typeof value.type !== 'string' || value.type.length > 64 || !UNKNOWN_FRAME_TYPE.test(value.type)) return;
    if (!isSafeCount(value.count) || value.count < 1) return;
    return { event: 'gptlive_unknown_frame', type: value.type, count: value.count };
  }
  if (value.event === 'gptlive_turn_complete') {
    if (!closedKeys(value, ['event', 'idleMs', 'drained'])) return;
    if (!isSafeCount(value.idleMs) || value.drained !== true) return;
    return { event: 'gptlive_turn_complete', idleMs: value.idleMs, drained: true };
  }
  if (value.event === 'live_provider_error') {
    if (!closedKeys(value, ['event', 'type', 'code', 'param'])) return;
    if (!isSafeToken(value.type) || !isSafeToken(value.code) || !isSafeToken(value.param)) return;
    return { event: 'live_provider_error', type: value.type, code: value.code, param: value.param };
  }
  if (value.event === 'gptlive_tool_output') {
    // 3r: one tool answer per delegated response, its call count and whether a continuation reached the wire.
    if (!closedKeys(value, ['event', 'calls', 'responseCreate'])) return;
    if (!isSafeCount(value.calls)) return;
    if (value.responseCreate !== 'sent' && value.responseCreate !== 'retried' && value.responseCreate !== 'failed') return;
    return { event: 'gptlive_tool_output', calls: value.calls, responseCreate: value.responseCreate };
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
  if (value.event === 'research_refused') {
    if (!closedKeys(value, ['event', 'state', 'sequence', 'reason', 'action', 'fields', 'unknownFieldCount', 'lookupCount'])) return;
    if (value.state !== 'refused' || !(value.sequence === null || isSafeCount(value.sequence))) return;
    if (!(RESEARCH_REFUSAL_REASONS as readonly unknown[]).includes(value.reason) || !['start', 'continue', 'stop', 'missing', 'invalid'].includes(String(value.action))) return;
    if (!isSafeCount(value.unknownFieldCount) || !isSafeCount(value.lookupCount)) return;
    if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) return;
    const fields = value.fields as Record<string, unknown>;
    if (!closedKeys(fields, [...RESEARCH_ARGUMENT_FIELDS]) || !Object.values(fields).every(type => (RESEARCH_ARGUMENT_TYPES as readonly unknown[]).includes(type))) return;
    return { event: 'research_refused', state: 'refused', sequence: value.sequence, reason: value.reason, action: value.action,
      fields: Object.fromEntries(RESEARCH_ARGUMENT_FIELDS.map(key => [key, fields[key]])), unknownFieldCount: value.unknownFieldCount, lookupCount: value.lookupCount };
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
  if (value.event === 'research_progress') {
    // 241: run phase and source kinds only, never question text, evidence or item ids.
    if (Object.keys(value).sort().join(',') !== ['event', 'researchId', 'phase', 'sourcesDone', 'sourcesPending', 'elapsedMs'].sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_progress');
    if (!isSafeMember(value.phase, RESEARCH_PHASES) || !isSafeCount(value.elapsedMs)) return;
    if (!isSafeMembers(value.sourcesDone, RESEARCH_SOURCES) || !isSafeMembers(value.sourcesPending, RESEARCH_SOURCES)) return;
    return { event: 'research_progress', researchId: value.researchId, phase: value.phase, sourcesDone: value.sourcesDone, sourcesPending: value.sourcesPending, elapsedMs: value.elapsedMs };
  }
  if (value.event === 'research_run') {
    // 241: run metadata only (rounds, candidate kinds, pUseful, dispositions, latencies, selector timing),
    // never question text, evidence or item ids.
    const keys = ['event', 'researchId', 'questionClass', 'rounds', 'perRound', 'stopReason', 'status', 'ops', 'sources', 'elapsedMs', 'deadAirMs', 'selectorMs', 'fallbackUsed', 'replyBytes', 'unchecked', 'canContinue', 'findingChars'];
    // #260: the run's own driver is optional (a stop line makes no selection) but is admitted only as
    // one of the four; any other value refuses the whole event, as the closed sets above do. #280:
    // a routed start writes its own line and names `routed`.
    const hasDriver = Object.prototype.hasOwnProperty.call(value, 'driver');
    if (hasDriver && !isSafeMember(value.driver, RESEARCH_DRIVERS)) return;
    if (Object.keys(value).sort().join(',') !== (hasDriver ? [...keys, 'driver'] : keys).sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_run');
    if (!isSafeMember(value.questionClass, ['quick_fact', 'cross_source', 'explicit_continue'])) return;
    if (!isSafeMember(value.stopReason, RESEARCH_STOPS) || !isSafeMember(value.status, ['answered', 'partial', 'stopped', 'unavailable', 'failed'])) return;
    if (typeof value.fallbackUsed !== 'boolean') return;
    if (!isSafeCount(value.rounds) || !isSafeCount(value.ops) || !isSafeCount(value.elapsedMs) || !isSafeCount(value.deadAirMs) || !isSafeCount(value.selectorMs) || !isSafeCount(value.replyBytes)) return;
    const pUseful = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!Array.isArray(value.perRound) || value.perRound.length > 8) return;
    const perRound: { candidates: { kind: string; pUseful: number }[]; chosen: string[] }[] = [];
    for (const round of value.perRound) {
      if (!round || typeof round !== 'object' || Array.isArray(round)) return;
      const row = round as Record<string, unknown>;
      if (Object.keys(row).sort().join(',') !== ['candidates', 'chosen'].sort().join(',')) return;
      if (!Array.isArray(row.chosen) || !row.chosen.every(kind => isSafeMember(kind, RESEARCH_CANDIDATES))) return;
      if (!Array.isArray(row.candidates) || row.candidates.length > 16) return;
      const candidates: { kind: string; pUseful: number }[] = [];
      for (const candidate of row.candidates) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
        const cell = candidate as Record<string, unknown>;
        if (Object.keys(cell).sort().join(',') !== ['kind', 'pUseful'].sort().join(',')) return;
        if (!isSafeMember(cell.kind, RESEARCH_CANDIDATES) || !pUseful(cell.pUseful)) return;
        candidates.push({ kind: cell.kind, pUseful: cell.pUseful });
      }
      perRound.push({ candidates, chosen: row.chosen });
    }
    if (!Array.isArray(value.sources) || value.sources.length > 16) return;
    const sources: { kind: string; disposition: string; latencyMs: number }[] = [];
    for (const source of value.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return;
      const row = source as Record<string, unknown>;
      if (Object.keys(row).sort().join(',') !== ['kind', 'disposition', 'latencyMs'].sort().join(',')) return;
      if (!isSafeMember(row.kind, RESEARCH_SOURCES) || !isSafeMember(row.disposition, RESEARCH_DISPOSITIONS) || !isSafeCount(row.latencyMs)) return;
      sources.push({ kind: row.kind, disposition: row.disposition, latencyMs: row.latencyMs });
    }
    if (!Array.isArray(value.unchecked) || value.unchecked.length > 8 || !isSafeMembers(value.unchecked, RESEARCH_SOURCES)) return;
    if (typeof value.canContinue !== 'boolean') return;
    if (!Array.isArray(value.findingChars) || value.findingChars.length > 32 || value.findingChars.some(count => !isSafeCount(count))) return;
    return { event: 'research_run', researchId: value.researchId, questionClass: value.questionClass, rounds: value.rounds, perRound, stopReason: value.stopReason, status: value.status, ops: value.ops, sources, elapsedMs: value.elapsedMs, deadAirMs: value.deadAirMs, selectorMs: value.selectorMs, fallbackUsed: value.fallbackUsed, replyBytes: value.replyBytes, unchecked: value.unchecked, canContinue: value.canContinue, findingChars: value.findingChars, ...(hasDriver ? { driver: value.driver } : {}) };
  }
  if (value.event === 'research_routed') {
    // K6: which layers the model named, how many lookups, per-source ms and outcome. Never a query.
    const keys = ['event', 'researchId', 'sources', 'lookups', 'ms', 'outcomes'];
    if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_routed');
    if (!isSafeCount(value.lookups)) return;
    if (!Array.isArray(value.sources) || value.sources.length > 4 || !isSafeMembers(value.sources, ROUTED_SOURCES)) return;
    if (!Array.isArray(value.outcomes) || value.outcomes.length !== value.sources.length || !isSafeMembers(value.outcomes, ROUTED_OUTCOMES)) return;
    if (!Array.isArray(value.ms) || value.ms.length !== value.sources.length || value.ms.some(ms => !isSafeCount(ms))) return;
    return { event: 'research_routed', researchId: value.researchId, sources: value.sources, lookups: value.lookups, ms: value.ms, outcomes: value.outcomes };
  }
  if (value.event === 'research_source') {
    // N3/P5: one receipt per source read: the layer, its outcome, its wall time and the deadline it was
    // given, so a read cut short can be judged against the time the source really had. Never a query.
    // K1: a knowledge read also reports the body window it asked for, so a named-layer read can be told
    // apart from a snippet lookup. Optional, a token and counts only; without this the whole receipt, the
    // deadline and coalesced count included, was refused and never reached host.log.
    const keys = ['event', 'researchId', 'source', 'outcome', 'ms', 'deadlineMs', 'coalesced'];
    const hasKnowledge = Object.prototype.hasOwnProperty.call(value, 'knowledge');
    if (Object.keys(value).sort().join(',') !== [...keys, ...(hasKnowledge ? ['knowledge'] : [])].sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_source');
    if (typeof value.source !== 'string' || !ROUTED_SOURCES.includes(value.source)) return;
    if (typeof value.outcome !== 'string' || !ROUTED_OUTCOMES.includes(value.outcome)) return;
    if (!isSafeCount(value.ms) || !isSafeCount(value.deadlineMs) || !isSafeCount(value.coalesced)) return;
    let knowledge: { detail: string; maxChars: number; deadlineMs: number; truncated: boolean } | undefined;
    if (hasKnowledge) {
      const row = value.knowledge as Record<string, unknown> | null | undefined;
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
      if (Object.keys(row).sort().join(',') !== ['detail', 'maxChars', 'deadlineMs', 'truncated'].sort().join(',')) return;
      if (!isSafeToken(row['detail']) || !isSafeCount(row['maxChars']) || !isSafeCount(row['deadlineMs']) || typeof row['truncated'] !== 'boolean') return;
      knowledge = { detail: row['detail'], maxChars: row['maxChars'], deadlineMs: row['deadlineMs'], truncated: row['truncated'] };
    }
    return { event: 'research_source', researchId: value.researchId, source: value.source, outcome: value.outcome, ms: value.ms, deadlineMs: value.deadlineMs, coalesced: value.coalesced, ...(knowledge !== undefined ? { knowledge } : {}) };
  }
  if (value.event === 'research_first_answer') {
    // R6: when a call answered with sources still reading: the elapsed ms, the sources already in the
    // reply and the ones it named as pending. Never a query, never a finding.
    if (!closedKeys(value, ['event', 'researchId', 'ms', 'settled', 'pending'])) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_first_answer');
    if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < 0 || value.ms > 120_000) return;
    if (!isSafeMembers(value.settled, RESEARCH_SOURCES) || !isSafeMembers(value.pending, RESEARCH_SOURCES)) return;
    return { event: 'research_first_answer', researchId: value.researchId, ms: value.ms, settled: value.settled, pending: value.pending };
  }
  if (value.event === 'research_late_findings') {
    // R6: one line per source that settled after the first answer: how long it took, how many items it
    // really returned, and how the host delivered them. Never the text of one.
    if (!closedKeys(value, ['event', 'researchId', 'source', 'ms', 'items', 'delivered', 'reason'])) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_late_findings');
    if (!isSafeMember(value.source, RESEARCH_SOURCES)) return;
    if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < 0 || value.ms > 120_000) return;
    if (typeof value.items !== 'number' || !Number.isInteger(value.items) || value.items < 0 || value.items > 16) return;
    if (!isSafeMember(value.delivered, LATE_DELIVERIES) || !isSafeMember(value.reason, LATE_REASONS)) return;
    return { event: 'research_late_findings', researchId: value.researchId, source: value.source, ms: value.ms, items: value.items, delivered: value.delivered, reason: value.reason };
  }
  if (value.event === 'research_subcall') {
    // Q1: one metadata-only record per internal sub-call, never the query or result text. A calendar
    // sub-call also carries the resolved window kind, a closed enum, never a time or title.
    const subKeys = ['event', 'researchId', 'kind', 'tool', 'ok', 'items', 'rawBytes', 'keptBytes', 'queryChars', 'queryAuthor'];
    const hasError = Object.prototype.hasOwnProperty.call(value, 'errorCode');
    const hasWindow = Object.prototype.hasOwnProperty.call(value, 'window');
    const hasUnread = Object.prototype.hasOwnProperty.call(value, 'unread');
    const allowed = [...subKeys, ...(hasError ? ['errorCode'] : []), ...(hasWindow ? ['window'] : []), ...(hasUnread ? ['unread'] : [])];
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_subcall');
    if (!isSafeMember(value.kind, RESEARCH_CANDIDATES) || !isSafeToken(value.tool)) return;
    if (typeof value.ok !== 'boolean') return;
    if (hasError && !isSafeToken(value.errorCode)) return;
    if (hasWindow && !isSafeMember(value.window, RESEARCH_WINDOW_KINDS)) return;
    if (hasUnread && !isSafeCount(value.unread)) return;
    if (!isSafeCount(value.items) || !isSafeCount(value.rawBytes) || !isSafeCount(value.keptBytes) || !isSafeCount(value.queryChars)) return;
    if (!isSafeMember(value.queryAuthor, ['selector', 'fallback', 'routed'])) return;
    return { event: 'research_subcall', researchId: value.researchId, kind: value.kind, tool: value.tool, ok: value.ok, ...(hasError ? { errorCode: value.errorCode } : {}), items: value.items, rawBytes: value.rawBytes, keptBytes: value.keptBytes, queryChars: value.queryChars, queryAuthor: value.queryAuthor, ...(hasWindow ? { window: value.window } : {}), ...(hasUnread ? { unread: value.unread } : {}) };
  }
  if (value.event === 'conversation_summary_recovery') {
    // OUTCOME 3: the host-start recovery sweep, a count of rows re-queued and rows left for later only.
    if (Object.keys(value).sort().join(',') !== ['event', 'requeued', 'skipped'].sort().join(',')) return;
    if (!isSafeCount(value.requeued) || !isSafeCount(value.skipped)) return;
    return { event: 'conversation_summary_recovery', requeued: value.requeued, skipped: value.skipped };
  }
  if (typeof value.event === 'string' && SUMMARY_EVENTS.has(value.event)) {
    // W13: the distiller's outcome, session id, character counts, milliseconds and reason codes only.
    const counts = ['inputChars', 'outputChars', 'durationMs', 'retryCount'] as const;
    const allowed = ['event', 'liveSessionId', ...counts, 'truncated', 'errorCode', 'reason'];
    if (Object.keys(value).some(key => !allowed.includes(key))) return;
    if (!isSafeId(value.liveSessionId)) return;
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
  if (value.event === 'responses_validation_failed') {
    // S4a-R4: the backend refused its own delegation config. The refused field, once per session.
    if (!closedKeys(value, ['event', 'param'])) return;
    if (!isSafeToken(value.param)) return;
    return { event: 'responses_validation_failed', param: value.param };
  }
  if (value.event === 'research_joined') {
    // Metadata only: the run id a second start joined. No question, no result text.
    if (Object.keys(value).sort().join(',') !== ['event', 'researchId'].sort().join(',')) return;
    if (!isSafeId(value.researchId)) return rejectResearchId('research_joined');
    return { event: 'research_joined', researchId: value.researchId };
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

export class HostLog {
  private readonly path: string;
  constructor(dataDir: string, private readonly limit = 5 * 1024 * 1024) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const root = lstatSync(dataDir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid diagnostics state directory');
    const directory = join(dataDir, 'logs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid diagnostics directory');
    this.path = join(directory, 'host.log');
  }
  event(raw: unknown): void { const event = safeEvent(raw); if (event) this.append(event); }
  terminal(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const state = (raw as { state?: unknown }).state;
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) return;
    if (state === 'closed') { this.append({ event: 'live_terminal', state, code }); return; }
    this.append({ event: 'host_error', class: 'LiveTerminal', code });
  }
  error(error: unknown): void {
    // Class is a closed token. Exception messages and stacks are deliberately never read.
    this.append({ event: 'host_error', class: error instanceof ConfigError ? 'ConfigError' : 'Error', ...(error instanceof ConfigError ? { code: error.code } : {}) });
  }
  private append(event: Record<string, unknown>): void {
    const line = Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...event }) + '\n');
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
