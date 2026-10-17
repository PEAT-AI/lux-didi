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
const RESEARCH_SOURCES = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];
const RESEARCH_CANDIDATES = ['knowledge_search', 'calendar_window', 'mail_search', 'mail_open', 'chat_search', 'chat_thread', 'brief', 'stop_answer', 'stop_insufficient'];
const RESEARCH_STOPS = ['answered', 'selector_stop', 'insufficient', 'rounds_exhausted', 'no_candidates', 'voi_stop', 'ops_exhausted', 'deadline', 'cancelled', 'fallback', 'stop'];
const RESEARCH_PHASES = ['started', 'round', 'done', 'stopped'];
const RESEARCH_DRIVERS = ['selector', 'fallback', 'single-source-hint'];
const RESEARCH_DISPOSITIONS = ['completed', 'skipped'];
// The projected Live state enum, mirrored from LivePageProjection['state'].
const LIVE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'rebuilding', 'ended', 'error'];
const RESEARCH_WINDOW_KINDS = ['today', 'tomorrow', 'week', 'date'];
// W13 distillation outcomes and the closed reason/error tokens they may name, never any summary text.
const SUMMARY_EVENTS = new Set(['conversation_summary_started', 'conversation_summary_completed', 'conversation_summary_failed', 'conversation_summary_skipped']);
const SUMMARY_REASONS = ['non_ordinary', 'too_few_turns', 'model_skip'];
const isSafeToken = (value: unknown): value is string => typeof value === 'string' && SAFE_TOKEN.test(value);
const isSafeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);
const isSafeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isSafeMember = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value);
const isSafeMembers = (value: unknown, allowed: readonly string[]): value is string[] => Array.isArray(value) && value.length <= 16 && value.every(item => isSafeMember(item, allowed));

// Only the existing diagnostic schemas cross this boundary, never arbitrary console text.
export function safeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (value.event === 'tool_failure') {
    const codes: readonly string[] = TOOL_FAILURE_CODES;
    const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v);
    if (typeof value.code !== 'string' || !codes.includes(value.code) || !token(value.tool) || !token(value.connector)
      || !['Error', 'SyntaxError', 'UnknownThrow', 'McpResultError'].includes(String(value.errorClass))
      || value.messageHead !== value.code || String(value.messageHead).length > 120) return;
    return { event: 'tool_failure', code: value.code, tool: value.tool, connector: value.connector, errorClass: value.errorClass, messageHead: value.messageHead };
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
  if (value.event === 'client_diagnostic' && value.source === 'native' && typeof value.receivedAt === 'string' && Number.isFinite(Date.parse(value.receivedAt)) && value.diagnostic && typeof value.diagnostic === 'object' && !Array.isArray(value.diagnostic)) {
    try { return { event: value.event, source: value.source, receivedAt: value.receivedAt, diagnostic: clientDiagnostic(value.diagnostic as Record<string, unknown>) }; } catch { return; }
  }
  if (value.event === 'host_started' && typeof value.releaseCommit === 'string' && /^(?:[0-9a-f]{40}|unknown)$/.test(value.releaseCommit) && (value.configDir === 'effective' || value.configDir === 'seeded') && Number.isSafeInteger(value.endpoints) && Number(value.endpoints) >= 0 && Number(value.endpoints) <= 65535) {
    return { event: value.event, releaseCommit: value.releaseCommit, configDir: value.configDir, endpoints: value.endpoints };
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
    // E1: the wait between input final and first audio only, never any turn content.
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
    // F7: one closed-shape transition record per projected state change, so the orb timeline is
    // reconstructable from host.log. Enums and an epoch millisecond only, never any turn content.
    if (Object.keys(value).sort().join(',') !== ['event', 'state', 'at'].sort().join(',')) return;
    if (!isSafeMember(value.state, LIVE_STATES)) return;
    if (!isSafeCount(value.at)) return;
    return { event: 'live_state', state: value.state, at: value.at };
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
    if (!isSafeId(value.researchId) || !isSafeMember(value.phase, RESEARCH_PHASES) || !isSafeCount(value.elapsedMs)) return;
    if (!isSafeMembers(value.sourcesDone, RESEARCH_SOURCES) || !isSafeMembers(value.sourcesPending, RESEARCH_SOURCES)) return;
    return { event: 'research_progress', researchId: value.researchId, phase: value.phase, sourcesDone: value.sourcesDone, sourcesPending: value.sourcesPending, elapsedMs: value.elapsedMs };
  }
  if (value.event === 'research_run') {
    // 241: run metadata only (rounds, candidate kinds, pUseful, dispositions, latencies, selector timing),
    // never question text, evidence or item ids.
    const keys = ['event', 'researchId', 'questionClass', 'rounds', 'perRound', 'stopReason', 'status', 'ops', 'sources', 'elapsedMs', 'deadAirMs', 'selectorMs', 'fallbackUsed', 'replyBytes', 'unchecked', 'canContinue', 'findingChars'];
    // #260: the run's own driver is optional (a stop line makes no selection) but is admitted only as
    // one of the three; any other value refuses the whole event, as the closed sets above do.
    const hasDriver = Object.prototype.hasOwnProperty.call(value, 'driver');
    if (hasDriver && !isSafeMember(value.driver, RESEARCH_DRIVERS)) return;
    if (Object.keys(value).sort().join(',') !== (hasDriver ? [...keys, 'driver'] : keys).sort().join(',')) return;
    if (!isSafeId(value.researchId) || !isSafeMember(value.questionClass, ['quick_fact', 'cross_source', 'explicit_continue'])) return;
    if (!isSafeMember(value.stopReason, RESEARCH_STOPS) || !isSafeMember(value.status, ['answered', 'partial', 'stopped', 'unavailable'])) return;
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
  if (value.event === 'research_subcall') {
    // Q1: one metadata-only record per internal sub-call, never the query or result text. A calendar
    // sub-call also carries the resolved window kind, a closed enum, never a time or title.
    const subKeys = ['event', 'researchId', 'kind', 'tool', 'ok', 'items', 'rawBytes', 'keptBytes', 'queryChars', 'queryAuthor'];
    const hasError = Object.prototype.hasOwnProperty.call(value, 'errorCode');
    const hasWindow = Object.prototype.hasOwnProperty.call(value, 'window');
    const hasUnread = Object.prototype.hasOwnProperty.call(value, 'unread');
    const allowed = [...subKeys, ...(hasError ? ['errorCode'] : []), ...(hasWindow ? ['window'] : []), ...(hasUnread ? ['unread'] : [])];
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) return;
    if (!isSafeId(value.researchId) || !isSafeMember(value.kind, RESEARCH_CANDIDATES) || !isSafeToken(value.tool)) return;
    if (typeof value.ok !== 'boolean') return;
    if (hasError && !isSafeToken(value.errorCode)) return;
    if (hasWindow && !isSafeMember(value.window, RESEARCH_WINDOW_KINDS)) return;
    if (hasUnread && !isSafeCount(value.unread)) return;
    if (!isSafeCount(value.items) || !isSafeCount(value.rawBytes) || !isSafeCount(value.keptBytes) || !isSafeCount(value.queryChars)) return;
    if (!isSafeMember(value.queryAuthor, ['selector', 'fallback'])) return;
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
  if (value.event === 'research_joined') {
    // Metadata only: the run id a second start joined. No question, no result text.
    if (Object.keys(value).sort().join(',') !== ['event', 'researchId'].sort().join(',')) return;
    if (!isSafeId(value.researchId)) return;
    return { event: 'research_joined', researchId: value.researchId };
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
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) return;
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
