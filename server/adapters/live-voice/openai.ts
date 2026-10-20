import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { JsonObject } from '../model/types.js';
import type { DataClass, LiveSocketFactory, LiveToolCall, LiveToolResponse, LiveToolSendOutcome, LiveVoiceAdapterOptions, LiveVoiceCapabilities, LiveVoiceClock, LiveVoiceControl, LiveVoiceDiagnostics, LiveVoiceErrorCode, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession, LiveVoiceUpstreamDrop } from './types.js';
import { LiveVoiceError, liveVoiceTimerDefaults } from './types.js';
import { Pcm16Upsampler } from './resample.js';
import { redactSecrets } from '../../tools/redact.js';
import { hostLogEvent } from '../../tools/host-events.js';
import type { LiveTracePort, TraceDetailMap } from '../../trace/record.js';
import type { ResponseStatus, ResponseTerminalReason, TraceEventKind } from '../../trace/kinds.js';
import type { ContinuationOutcome, SkipReason } from '../../trace/kinds.js';

/**
 * The GPT-Live adapter over the provider-neutral voice port.
 *
 * Wire facts, all from developers.openai.com (fetched 2026-10-17, cited in the wagon report):
 * - endpoint `wss://api.openai.com/v1/live/sessions`, no query parameters, `Authorization: Bearer <key>`
 *   (guides/voice-websockets, "Connect to wss://api.openai.com/v1/live/sessions");
 * - `session.start` first, `session.started` before any audio (guides/voice-websockets, start-barrier note);
 * - one PCM16 rate both ways, `audio.format` (guides/voice-websockets example: `{type:"audio/pcm",rate:24000}`);
 * - history is seeded in `session.input` at startup, max 128 messages and 8,192 combined tokens
 *   (guides/live-conversations, "Seed a session with prior conversation");
 * - tool calls arrive as a nested `response.output_item.done` inside a `response.event` envelope, and a
 *   result is `function_call_output` then `response.create` (guides/live-migration, delegation table);
 * - the end of a response is the nested `response.done`; the voice layer itself has no spoken-response
 *   end event (guides/live-migration, "Track audio generation and response completion").
 */
const ENDPOINT = 'wss://api.openai.com/v1/live/sessions';
/** Delegation backend pinned by the docs ("Start with gpt-6-luna", guides/live-delegation). */
export const OPENAI_DELEGATION_MODEL = 'gpt-6-luna';
/** Delegation probe 2026-10-18 (delegation-probe-1018.md): both fields are accepted by delegation.responses on
 *  gpt-live-1, and the final answer arrives 1.6 to 2.3 s sooner per tool turn than the default. `effort: none` is
 *  unreliable and `parallel_tool_calls: false` is the slowest, so the pair below is the pinned shape. */
const DELEGATION_PARALLEL_TOOL_CALLS = true;
const DELEGATION_REASONING_EFFORT = 'low';
/** Documentation default and quality voice ("The default is marin", guides/live-conversations). */
export const OPENAI_DEFAULT_VOICE = 'marin';
/** The documented form of a prompt-designed custom voice (`POST /v1/audio/voices`, type prompt):
 *  `voice_` plus 16 to 64 lowercase hex characters. GPT-Live is the one surface that can speak it, and the
 *  session start frame references it as `audio.output.voice = { id }` rather than by name (PV2). */
const CUSTOM_VOICE_ID = /^voice_[0-9a-f]{16,64}$/;
/** Whether one voice name is a custom voice id rather than a preset name. */
export function isCustomVoiceId(voice: string): boolean { return CUSTOM_VOICE_ID.test(voice); }
/** The voice the session start frame asks for: a preset stays a string, a custom voice travels as an id. */
function voicePayload(voice: string): string | { id: string } { return isCustomVoiceId(voice) ? { id: voice } : voice; }
// PV1: the Language line is gone, because the host's accent block carries the accent and this line competed with it.
/** The delegated backend's own instructions: a generic voice-backend template, no owner content, so the backend
 *  answers in the shape the live voice model has to speak. `backendProcedure` (wagon S4b) appends the task
 *  procedure after it under a blank line; S4a passes none. */
export const OPENAI_BACKEND_TEMPLATE = 'You are helping an assistant in a live voice conversation. Return the relevant facts, the task\'s current status, and the next step.';
/** Brevity rule: the backend's text is read by a model that has to say it out loud. */
export const OPENAI_BACKEND_BREVITY = 'Telegraphic facts, at most about 120 words; the voice model elaborates.';
/** The documented 500 token ceiling on a progress or thinking append, kept as a character bound. */
const APPEND_CHAR_LIMIT = 2_000;
/** S4a-R2 (d): the ledger keeps this many command ids, oldest dropped first. */
const COMMAND_LEDGER_LIMIT = 64;
/** Verbosity of the backend's own prose. Documented low setting, so the second leg stops writing essays. */
const DELEGATION_TEXT_VERBOSITY = 'low';
export function openAiBackendInstructions(procedure?: string): string {
  const base = `${OPENAI_BACKEND_TEMPLATE}\n\n${OPENAI_BACKEND_BREVITY}`;
  return typeof procedure === 'string' && procedure.length ? `${base}\n\n${procedure}` : base;
}
export const OPENAI_TOOLS_SECTION = 'Tools: before a lookup, say one short natural line that you are checking; never go silent for more than a few seconds.';
export const OPENAI_DELIVERY_SECTION = 'Delivery: confident and warm underneath, dry and a little edgy; never sugary or sing-song; keep the wit.';
/** OpenAI's live prompting guide, verbatim: the server owns turn taking, so a stray sound is not a new turn. */
const OPENAI_LISTENING_SECTION = 'Do not treat a cough, music, or nearby conversation as a new request.\nKeep listening while the owner pauses to think.';
/** The shared persona is sent unchanged; the wrapper only appends the provider sections. */
export function openAiInstructions(persona: string): string {
  return `${persona}\n\n${OPENAI_TOOLS_SECTION}\n\n${OPENAI_DELIVERY_SECTION}\n\n${OPENAI_LISTENING_SECTION}`;
}
const FRESH_OPENING = 'Open the conversation now with one fresh, specific line.';
/** Documented startup-history ceiling: 128 messages and 8,192 combined tokens (4 characters per token is the cap proxy). */
const SEED_MESSAGE_LIMIT = 128;
const SEED_CHAR_LIMIT = 8192 * 4;
const PING_INTERVAL_MS = 5_000;
const PING_MISSED_LIMIT = 2;
/** A refused setup keeps 300 characters of the provider's own message: enough to name the field, bounded. */
const SETUP_ERROR_TEXT_LIMIT = 300;
/** Inbound silence and blocked upload progress are separate rules: this limit covers provider frames and pongs. */
const STALL_SILENCE_MS = 8_000;
/** A blocked mic upload gets a separate, longer budget. The pinned 20 s slow-uplink window stays live; only a
 *  full 30 s with no local write completion and no new socket-buffer low uses the existing recovery path. */
const UPLOAD_NO_PROGRESS_MS = 30_000;
/** Mic shedding (3o): above this much buffered upload the oldest queued mic frames go, so the model hears the
 *  newest speech instead of a backlog of seconds. Measured on the lossy-uplink session (peak 275,222 B). */
const UPLINK_SHED_BYTES = 48 * 1024;
/** The shed receipt is bounded to one host.log record per window (3o). */
const UPLINK_SHED_RECEIPT_MS = 10_000;
/** W3: the queue is shed down to this mark, so what reaches the model is runs of consecutive frames, never
 *  isolated 20 ms islands, and the newest speech is still what wins. A quarter of the cap is what keeps a
 *  surviving run from being cut by the next shed before the socket has drained it: at the owner's 3:1 oversupply
 *  half the cap would leave a run of eight frames, and the wire would thin again. */
const UPLINK_SHED_LOW_BYTES = UPLINK_SHED_BYTES / 4;
/** W3: connection quality is the adapter's own read of the link, over the last three measured seconds. */
const CONNECTION_WINDOW_MS = 3_000;
/** Over a fifth of the captured mic bytes discarded in the window is a weak link (the owner's link: 25% loss). */
const CONNECTION_WEAK_SHARE = 0.2;
/** Five quiet seconds, with no discard and no pinned backlog, make it ok again. */
const CONNECTION_OK_MS = 5_000;
const QUEUE_LOG_BYTES = 64 * 1024;
const QUEUE_LOG_INTERVAL_MS = 1_000;
/** Turn taking: the owner's input episode ends after this much quiet on the input transcript. */
const INPUT_EPISODE_QUIET_MS = 700;
/** Audible silence: SPEAKING ends after this much output quiet with the local playback drained, and the 2000 ms
 *  presentation idle stays the semantic end of the turn. */
const OUTPUT_SILENCE_MS = 500;
/** Presentation idle: the spoken reply is over after this much quiet with the local playback drained. */
const TURN_IDLE_QUIET_MS = 2_000;
/** After a barge-in flush the cut answer is dropped until the output shows a gap this long, or this long has
 *  passed since the flush, whichever comes first. Both bounds are fixed, so the drop window never latches. */
const POST_FLUSH_GAP_MS = 400;
const POST_FLUSH_DROP_LIMIT_MS = 2_500;
/** The server decides an interruption. While the owner has an open input episode, a flush waits this long with no
 *  new output delta: a stream that keeps arriving is a backchannel or background speech the server chose to talk
 *  over, and nothing is cut. An answer the server has already finished sending has no delta to push it out, so an
 *  owner who speaks over buffered speech is obeyed after this gap (N1, session 82ab994a). */
const SERVER_YIELD_GAP_MS = 350;
/** Forwarded output PCM is 24 kHz s16 mono, so the modelled native queue drains 48 bytes per millisecond. */
const OUTPUT_PCM_BYTES_PER_MS = 48;
/** Audible speech, in dBFS RMS against 16-bit full scale. -50 dBFS is a peak amplitude of about 100 counts of
 *  32767, far below any intelligible speech (conversational RMS sits around -35 to -12 dBFS) and far above the
 *  all-zero frames gpt-live-1 streams to fill its continuous output (session 1018 kept 48 kB/s for 98.5% of a
 *  339 s call while the state never left SPEAKING). A frame below it is forwarded and heard as nothing. */
export const AUDIBLE_RMS_DBFS = -50;
/** A digital-silent frame measures zero power: -Infinity is clamped here so the level stays a JSON number. */
export const SILENT_RMS_DBFS = -120;

/** The level of one PCM16 little-endian chunk in dBFS RMS, one pass and no per-sample allocation. */
export function pcm16RmsDbfs(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return SILENT_RMS_DBFS;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32_768;
    sum += sample * sample;
  }
  const power = sum / samples;
  return power <= 0 ? SILENT_RMS_DBFS : Math.max(SILENT_RMS_DBFS, 10 * Math.log10(power));
}
/** Standing cushion (3o): 400 ms of audio held back at the start of a stretch and again after every drain, so the
 *  native 80 ms jitter buffer never underruns while the server sends at about real time. Measured on the 163
 *  underruns of session 82ab994a: a 400 ms cushion covers 162 of them (300 ms leaves 6). */
const HEAD_START_MS = 400;
const HEAD_START_BYTES = HEAD_START_MS * OUTPUT_PCM_BYTES_PER_MS;
/** Epoch-anchored monotonic time keeps local windows independent of wall-clock adjustments. */
const REAL_CLOCK: LiveVoiceClock = {
  now: () => Math.floor(performance.timeOrigin + performance.now()),
  setTimer: (ms, fire) => setTimeout(fire, ms),
  clearTimer: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
function transcriptMetadata(message: ObjectValue): { providerEventId?: string; providerStartMs?: number; providerEndMs?: number } {
  const validMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const start = message.start_ms, end = message.end_ms;
  const interval = (!validMs(start) || !validMs(end) || end >= start);
  return {
    ...(typeof message.event_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(message.event_id) ? { providerEventId: message.event_id } : {}),
    ...(interval && validMs(start) ? { providerStartMs: start } : {}),
    ...(interval && validMs(end) ? { providerEndMs: end } : {}),
  };
}
const DEFAULTS: Readonly<LiveVoiceLimits> = Object.freeze({
  maxIncomingBytes: 1024 * 1024, maxOutgoingBytes: 1024 * 1024, maxBufferedBytes: 2 * 1024 * 1024, upstreamStallMs: UPLOAD_NO_PROGRESS_MS,
  maxEventBytes: 1024 * 1024, maxEvents: 128, maxRequestBytes: 256 * 1024, maxHistoryTurns: 128,
  ...liveVoiceTimerDefaults,
});
const timerNames = ['handshakeMs', 'idleMs', 'sessionMs', 'closeMs'] as const;

/** O1b-A: the provider's own terminal status, mapped onto the trace store's closed sets, never passed through. */
const TERMINAL_STATUS: Readonly<Record<string, ResponseStatus>> = {
  completed: 'completed', failed: 'failed', cancelled: 'cancelled', incomplete: 'interrupted', in_progress: 'streaming', queued: 'pending',
};
function terminalReasonOf(status: string | undefined): ResponseTerminalReason {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  // The provider stopped it short of its end: the response is over, but not because it finished speaking.
  if (status === 'incomplete') return 'superseded';
  return 'completed';
}
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
type ObjectValue = Record<string, unknown>;
/** One event body: the union member without its sequence, so `emit` keeps each variant's own fields. */
type EventBody = LiveVoiceEvent extends infer Event ? (Event extends { sequence: number } ? Omit<Event, 'sequence'> : never) : never;

function capabilitiesOf(): LiveVoiceCapabilities {
  return Object.freeze({
    provider: 'openai' as const,
    // No resumption: the docs offer no handle, and a drop uses the host's fresh-seeded path.
    supportsResumption: false,
    supportsGoAway: false,
    supportsInterruption: true,
    // GPT-Live decides when to speak; there is no client VAD configuration in its session config.
    supportsServerVadConfig: false,
    inputRates: Object.freeze([16_000]),
    outputRates: Object.freeze([24_000]),
    outputModalities: Object.freeze(['audio'] as const),
    thinking: 'provider_default',
    supportsToolScheduling: false,
    toleratesEmptyReadyLifecycle: false,
  });
}

function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Words in the assembled input transcript of one episode: punctuation-only and empty text count zero. */
function countWords(text: string): number { return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length; }
function fail(code: LiveVoiceErrorCode): never { throw new LiveVoiceError(code); }
/** S4a-R4: the command family a rejected client command names, as a closed token for the receipt. */
const COMMAND_KINDS = ['tool_out', 'cont', 'cmt', 'thk', 'other'] as const;
type CommandKind = (typeof COMMAND_KINDS)[number];

/** S4a-R2 (c): what a provider error is, decided by its own code or type and never by a field's presence.
 *  `command_rejected` means the command never became a response, so nothing may be emitted as an interruption. */
type ErrorDisposition = 'command_rejected' | 'validation_failed' | 'transport' | 'moderation' | 'backend_failure' | 'unknown';
const ERROR_DISPOSITIONS: Readonly<Record<string, ErrorDisposition>> = {
  invalid_value: 'command_rejected', invalid_request_error: 'command_rejected', unknown_parameter: 'command_rejected',
  missing_required_parameter: 'command_rejected', invalid_type: 'command_rejected', unsupported_parameter: 'command_rejected',
  conversation_already_has_active_response: 'transport', response_already_active: 'transport',
  responses_validation_failed: 'validation_failed',
  connection_error: 'transport', server_error: 'transport', internal_error: 'transport', timeout: 'transport',
  rate_limit_exceeded: 'transport', session_expired: 'transport',
  moderation_error: 'moderation', content_filter: 'moderation',
  backend_error: 'backend_failure', response_failed: 'backend_failure', responses_failed: 'backend_failure',
};
function dispositionOf(type: string, code: string): ErrorDisposition {
  return ERROR_DISPOSITIONS[code] ?? ERROR_DISPOSITIONS[type] ?? 'unknown';
}
/** One field of a provider refusal: redacted, whitespace-collapsed and bounded, never any request text. */
function setupErrorText(value: unknown): string {
  return typeof value === 'string' ? redactSecrets(value).replace(/\s+/g, ' ').trim().slice(0, SETUP_ERROR_TEXT_LIMIT) : '';
}
/** The provider's setup refusal as a metadata receipt: its own type, code and param, and 300 characters of
 *  message. The instructions, the voice payload and the key never cross this boundary. */
function setupErrorReceipt(error: unknown): { type: string; code: string; param: string; message: string } {
  const fields = object(error) ? error : {};
  return { type: setupErrorText(fields['type']), code: setupErrorText(fields['code']), param: setupErrorText(fields['param']), message: setupErrorText(fields['message']) };
}
function classList(value: unknown, code: LiveVoiceErrorCode): DataClass[] {
  if (!Array.isArray(value) || !value.length || value.some(item => !classes.includes(item as DataClass)) || new Set(value).size !== value.length) fail(code);
  return [...value] as DataClass[];
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * The provider's own word for why a backend response ended (S5): its error code when it sent one, else its
 * status. Bounded to the shape a metadata-only receipt may carry, so a provider string is never a free field.
 */
function failureCode(status: string, error: unknown): string {
  const code = object(error) && typeof error.code === 'string' && error.code.length ? error.code : undefined;
  const word = code ?? status;
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(word) ? word : 'failed';
}

interface Settings {
  modelId: string; voice: string; enabled: boolean; allowed: readonly DataClass[];
  keyReference: string; resolve: (reference: string) => Promise<string | undefined>;
  limits: Readonly<LiveVoiceLimits>; socketFactory: LiveSocketFactory;
  clock: LiveVoiceClock | undefined; backendProcedure: string | undefined;
  /** O1b-A: the host's receipt door for this session and connection epoch. Absent, this adapter records nothing. */
  trace: LiveTracePort | undefined;
}

/** 3r D4: a delegation whose calls are all answered and whose outputs are upstream, but which has produced no
 *  delegated response within this window, is stalled. Detection only: the receipt names it, and the host's
 *  recovery is the one rescue, so this timer never sends a command of its own. */
const DELEGATION_STALL_MS = 5_000;
/** 3r F: what a provider error has to name before it counts as a speech cut, and the one rejection that means a
 *  response is still active (which is the retry the continuation gate is allowed). */
const SPEECH_CUT_ERROR = /moderation|content_filter|interrupt|barge|response_cancel|cancel/i;
const ACTIVE_RESPONSE_ERROR = /active[ _]response|response[ _](?:already[ _])?(?:active|in[ _]progress)|already[ _](?:active|in[ _]progress)/i;

interface Delegation {
  readonly id: string;
  readonly openedAt: number;
  /** Response ids this delegation has created, oldest first, so a continuation chain stays readable. */
  readonly responses: string[];
  /** Calls delegated under it that still owe their one terminal output. */
  readonly awaiting: Set<string>;
  /** When the last owed output went upstream and the stall timer armed from there. */
  outputsAt: number | undefined;
  stallTimer: unknown;
  stalled: boolean;
}

export class OpenAiLiveVoiceAdapter implements LiveVoicePort {
  private readonly settings: Settings;
  readonly capabilities = capabilitiesOf();

  constructor(options: LiveVoiceAdapterOptions) {
    if (!object(options) || typeof options.modelId !== 'string' || !/^gpt-live-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.modelId)
      || typeof options.keyReference !== 'string' || !options.keyReference.trim() || options.keyReference.length > 256
      || !options.credentials || typeof options.credentials.resolve !== 'function'
      || (options.socketFactory !== undefined && typeof options.socketFactory !== 'function')
      || (options.clock !== undefined && (typeof options.clock.now !== 'function' || typeof options.clock.setTimer !== 'function' || typeof options.clock.clearTimer !== 'function'))) fail('invalid_settings');
    const voice = options.voice === undefined || options.voice === '' ? OPENAI_DEFAULT_VOICE : options.voice;
    // A `voice_` name is a custom id and must be a well-formed one; every other name is a preset name
    // by shape, and the provider's own list is what decides whether it exists (PV2).
    if (typeof voice !== 'string' || (voice.startsWith('voice_')
      ? !isCustomVoiceId(voice) : !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(voice))) fail('invalid_settings');
    if (options.limits !== undefined && !object(options.limits)) fail('invalid_settings');
    const limits = { ...DEFAULTS, ...options.limits };
    for (const name of Object.keys(limits)) if (!(name in DEFAULTS)) fail('invalid_settings');
    for (const name of timerNames) if (limits[name] > 2_147_483_647) fail('invalid_settings');
    const route = options.route;
    if (!object(route) || typeof route.enabled !== 'boolean' || route.provider !== 'openai' || route.modelId !== options.modelId) fail('route_denied');
    const socketFactory: LiveSocketFactory = options.socketFactory ?? ((url, config) => new WebSocket(url, config));
    this.settings = Object.freeze({
      modelId: options.modelId, voice, keyReference: options.keyReference,
      enabled: route.enabled, allowed: Object.freeze(classList(route.dataClasses, 'route_denied')),
      resolve: options.credentials.resolve.bind(options.credentials), limits: Object.freeze(limits), socketFactory,
      clock: options.clock, backendProcedure: options.backendProcedure,
      trace: undefined,
    });
  }

  open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
    if (!object(control)) fail('invalid_request');
    const settings = { ...this.settings, limits: { ...this.settings.limits, ...control.limits }, trace: control.trace };
    for (const name of timerNames) if (!Number.isSafeInteger(settings.limits[name]) || settings.limits[name] < 1) fail('invalid_request');
    if (control.idleResetMs !== undefined && (!Number.isSafeInteger(control.idleResetMs) || control.idleResetMs < 1 || control.idleResetMs > 2_147_483_647)) fail('invalid_request');
    if (!settings.enabled) fail('route_denied');
    if (!object(request) || !object(request.system) || typeof request.system.text !== 'string' || !request.system.text.length
      || (request.history !== undefined && !Array.isArray(request.history))) fail('invalid_request');
    if (request.opening !== undefined && request.opening !== 'user_first' && request.opening !== 'model_first') fail('invalid_request');
    // No resumption handle exists for this provider: a handle would promise a continuation it cannot honour.
    if (request.resumptionHandle !== undefined) fail('invalid_request');
    const checkClass = (value: unknown): void => {
      if (!classes.includes(value as DataClass)) fail('invalid_request');
      if (!settings.allowed.includes(value as DataClass)) fail('route_denied');
    };
    checkClass(request.system.dataClass);
    const supplied = request.history ?? [];
    if (supplied.length > settings.limits.maxHistoryTurns || supplied.length > SEED_MESSAGE_LIMIT) fail('invalid_request');
    const history = supplied.map((turn): { role: 'user' | 'model'; text: string } => {
      if (!object(turn) || (turn.role !== 'user' && turn.role !== 'model') || typeof turn.text !== 'string' || !turn.text.length) fail('invalid_request');
      checkClass(turn.dataClass);
      return { role: turn.role, text: turn.text };
    });
    if (request.languageCode !== undefined && !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(request.languageCode)) fail('invalid_request');
    if (request.openingText !== undefined && (typeof request.openingText !== 'string' || !request.openingText.length || request.openingText.length > 4000)) fail('invalid_request');
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 128
      || request.tools.some(tool => !object(tool) || typeof tool.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || typeof tool.description !== 'string' || !object(tool.parameters)))) fail('invalid_request');
    const instructions = openAiInstructions(request.system.text);
    const seed = this.seed(history, request);
    if (seed.characters > SEED_CHAR_LIMIT) fail('invalid_request');
    const tools = request.tools?.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters as JsonObject }));
    const start = JSON.stringify({
      type: 'session.start',
      session: {
        model: settings.modelId,
        instructions,
        audio: { format: { type: 'audio/pcm', rate: 24_000 }, output: { voice: voicePayload(settings.voice) } },
        ...(seed.items.length ? { input: seed.items } : {}),
        delegation: { type: 'responses', responses: { model: OPENAI_DELEGATION_MODEL, instructions: openAiBackendInstructions(settings.backendProcedure),
          text: { verbosity: DELEGATION_TEXT_VERBOSITY }, ...(tools?.length ? { tools } : {}), tool_choice: 'auto',
          parallel_tool_calls: DELEGATION_PARALLEL_TOOL_CALLS, reasoning: { effort: DELEGATION_REASONING_EFFORT } } },
      },
    });
    if (Buffer.byteLength(start) > settings.limits.maxOutgoingBytes
      || Buffer.byteLength(JSON.stringify({ instructions, input: seed.items, tools })) > settings.limits.maxRequestBytes) fail('outgoing_limit');
    // Receipt, metadata only: the size of the instructions exactly as sent, so a log proves nothing was cut.
    hostLogEvent({ event: 'openai_instructions_size', chars: instructions.length, bytes: Buffer.byteLength(instructions) });
    if (!(control.signal instanceof AbortSignal) || !Number.isSafeInteger(control.deadlineMs)
      || control.deadlineMs <= 0 || control.deadlineMs - Date.now() > 2_147_483_647) fail('invalid_request');
    return new Session(settings, start, control.signal, control.deadlineMs, control.idleResetMs ?? settings.limits.idleMs);
  }

  /**
   * Startup history as the documented `session.input` items, then the opening line. Seeding belongs to
   * `session.start` on this provider: the docs ask for the greeting message to be "included in the
   * session.start event instead of waiting until session.started" (guides/live-conversations).
   */
  private seed(history: readonly { role: 'user' | 'model'; text: string }[], request: LiveVoiceRequest): { items: JsonObject[]; characters: number } {
    const items: JsonObject[] = [];
    let characters = 0;
    for (const turn of history) {
      characters += turn.text.length;
      items.push({ type: 'message', role: turn.role === 'model' ? 'assistant' : 'user',
        content: [{ type: turn.role === 'model' ? 'output_text' : 'input_text', text: turn.text }] });
    }
    if (request.openingText !== undefined) {
      characters += request.openingText.length;
      items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.openingText }] });
    } else if (request.opening === 'model_first' && !history.length) {
      characters += FRESH_OPENING.length;
      items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: FRESH_OPENING }] });
    }
    if (items.length > SEED_MESSAGE_LIMIT) fail('invalid_request');
    return { items, characters };
  }
}

class Session implements LiveVoiceSession {
  private readonly readiness = deferred<void>();
  private readonly completion = deferred<LiveVoiceOutcome>();
  readonly ready = this.readiness.promise;
  readonly done = this.completion.promise;
  readonly events: AsyncIterable<LiveVoiceEvent>;
  private socket: WebSocket | undefined;
  private terminal: LiveVoiceOutcome | undefined;
  private isReady = false;
  private draining = false;
  private recoverable = false;
  private readonly startedAt = Date.now();
  private upstreamDrop: LiveVoiceUpstreamDrop | undefined;
  private lastInboundAt = Date.now();
  /** Mic frames queued behind a backed-up socket, oldest first: shed from the front (3o). */
  private micPending: { frame: string; bytes: number }[] = [];
  private micPendingBytes = 0;
  private shedBytes = 0;
  private shedPeak = 0;
  private shedRuns = 0;
  private notOpenBytes = 0;
  private shedReportedAt: number | undefined;
  /** One uplink sample per mic flush (W3): what the interval captured, what it discarded, and the bytes the
   *  socket took out of its buffer. Quality and the drain rate are read from these, never from delivery. */
  private uplinkSamples: { at: number; captured: number; discarded: number; accepted: number; backlogged: boolean }[] = [];
  private sampleCaptured = 0;
  private sampleDiscarded = 0;
  private lastBuffered = 0;
  private lastBufferedAt: number | undefined;
  private connectionQuality: 'ok' | 'weak' = 'ok';
  /** The last moment a discard or a pinned backlog was observed: the five quiet seconds are counted from it. */
  private lastUplinkLossAt: number | undefined;
  /** The last moment the link was observed weak: the watchdog compares it with the wait it is judging. */
  private connectionWeakAt: number | undefined;
  private drainBytesPerSec = 0;
  /** Head starts re-armed after a drain in the current turn (3o receipt `playback_rearm`). */
  private playbackRearms = 0;
  private awaitingPong = false;
  /** Whether any inbound frame arrived inside the ping window that is now closing (3o `no_pong`). */
  private inboundThisPing = false;
  private missedPongs = 0;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastQueueLogAt: number | undefined;
  /** One episode in which the newest mic frame is retained behind a full socket. Local progress only: neither a
   *  send callback nor bufferedAmount says the provider consumed the frame. */
  private uploadBlockedSince: number | undefined;
  private uploadBufferedLow: number | undefined;
  private upstreamStallQueued = false;
  private sequence = 0;
  private secret = '';
  private queue: { event: LiveVoiceEvent; bytes: number }[] = [];
  private queueBytes = 0;
  private waiter: ((result: IteratorResult<LiveVoiceEvent>) => void) | undefined;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private cleaned = false;
  private creatingSocket = false;
  private readonly upsampler = new Pcm16Upsampler();
  private pendingCalls: LiveToolCall[] = [];
  /** Answers already received for the pending calls of the current delegated turn, by call id. */
  private readonly answeredCalls = new Map<string, JsonObject>();
  /** Generation counter: bumped by every interruption and every new backend response. */
  private generation = 0;
  /** The generation the owner cut off; its remaining audio deltas are dropped until a new response starts. */
  private muted = -1;
  private userTranscriptOpen = false;
  private outputTranscriptOpen = false;
  /** The owner's assembled input episode, the once-per-episode barge-in latch and its quiet timer. */
  private inputEpisode = '';
  private flushed = false;
  private episodeQuiet: unknown;
  private yieldTimer: unknown;
  private episodeToken = 0;
  private episodeDeadline = 0;
  private episodeClosed = false;
  /** What there was to cut when the episode's first word arrived, so a silent episode reports its own reason. */
  private episodeQueuedMs = 0;
  private readonly unknownFrames = new Map<string, number>();
  /** Presentation idle: the modelled native playback queue, the last forwarded delta and its idle timer. */
  private playbackUntil = 0;
  private lastForwardedAt = 0;
  private audioSinceCompletion = false;
  private idleQuiet: unknown;
  /** True between a delegated `response.created` and its `response.done`. */
  private delegatedOutstanding = false;
  /** Response ids already opened and already ended: a repeated lifecycle event is the same response, not a new one. */
  private readonly openedResponses = new Set<string>();
  private readonly endedResponses = new Set<string>();
  /** The response this turn is answering, for the receipts that name it (S5). */
  private currentResponse: string | undefined;
  /** Calls whose `function_call_output` is already on the wire: no call is ever answered twice (3r B). */
  private readonly outputSent = new Set<string>();
  /** A continuation the gate owes but has not sent, and the single retry an active-response rejection allows
   *  (3r A). A deferred continuation is sent by the next terminal event, never by a timer of its own. */
  private continuationOwed = false;
  /** Every `response.create` this session has written: one per backend response, and the S5 failure rule counts them. */
  private continuationsSent = 0;
  /** The answered batch the owed continuation belongs to, kept with it until it is sent (S1-R1). */
  private continuationCalls = 0;
  /** Outputs of the current backend response already on the wire, across every deferral it needed (S5). */
  private batchAnswers = 0;
  /** The batch of the create that went last, so a rejection can retry with the same count (S1-R1). */
  private lastContinuationCalls = 0;
  /** A provider rejection that a response is still active: the one retry, through the same gate (3r A). */
  private continuationRejected = false;
  private continuationRetries = 0;
  /** The outcome of the last tool answer, returned again for a duplicate completion the adapter ignores. */
  private continuationOutcome: LiveToolSendOutcome = 'failed';
  /** Which delegation carried a call id, so an output can be attributed to it (3r D4). */
  private readonly callDelegation = new Map<string, string>();
  /** Open delegations from `session.delegation.created`, by provider delegation id (3r D4). */
  private readonly delegations = new Map<string, Delegation>();
  private commandSequence = 0;
  private validationRefused = false;
  /** S4a-R2 (d): event id to the command it identified. Correlation only. */
  private readonly commands = new Map<string, { kind: CommandKind; sentAt: number; epoch: number }>();
  /** Audible silence of the current speaking stretch: its timer, whether its receipt was already sent, and the
   *  arrival clock of the last output delta (dropped or forwarded), which is what a post-flush gap is read on. */
  private outputSilence: unknown;
  private silenceSent = false;
  private lastOutputDeltaAt = 0;
  /** When the owner's barge-in flushed the answer, and how much of the cut answer the drop window has discarded. */
  private postFlushAt: number | undefined;
  private postFlushDroppedMs = 0;
  /** Forwarded playback milliseconds since the last barge-in, reported as the post-flush receipt. */
  private postFlushMs: number | undefined;
  /** The head start of the current speaking stretch: PCM held until HEAD_START_MS or HEAD_START_BYTES, and its timer. */
  /** A speaking stretch is open between its first delta and its completion, flush, provider error or close. */
  private stretchOpen = false;
  private holding = false;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  /** The part of `heldBytes` that can be heard: fill frames are held for ordering, never counted (3r D2). */
  private heldAudibleBytes = 0;
  private headStartTimer: unknown;
  private readonly clock: LiveVoiceClock;
  /** O1b-A: the host-minted key of each provider response, so a receipt joins a response to its calls. */
  private readonly responseKeys = new Map<string, string>();
  private responseKeySeq = 0;
  private readonly observedResponses = new Set<string>();
  /** O1b-A: when each call was delegated and by which response, for the executed/written receipts' ms. */
  private readonly callOrigins = new Map<string, { at: number; responseKey?: string }>();
  private readonly diagnostic = {
    audioCalls: 0, audioBytes: 0, drainingDropCalls: 0, drainingDropBytes: 0,
    localWriteEnqueuedCalls: 0, localWriteEnqueuedPCMBytes: 0,
    localWriteCallbackSuccessCalls: 0, localWriteCallbackSuccessPCMBytes: 0,
    localWriteCallbackErrorCalls: 0, localWriteCallbackErrorPCMBytes: 0,
    localWriteCallbackPendingCalls: 0, localWriteCallbackPendingPCMBytes: 0,
    inputTranscriptionEvents: 0, inputTranscriptionCharacters: 0,
    generationCompleteEvents: 0, turnCompleteEvents: 0,
    outputAudioFrames: 0, outputAudioPCMBytes: 0,
    outputAudioAfterInitialTurnFrames: 0, outputAudioAfterInitialTurnPCMBytes: 0,
  };
  readonly diagnostics = (): Readonly<LiveVoiceDiagnostics> => Object.freeze({ ...this.diagnostic,
    connection: { quality: this.connectionQuality, uploadKbps: Math.round(this.drainBytesPerSec * 8 / 1_000),
      ...(this.connectionWeakAt === undefined ? {} : { weakAt: this.connectionWeakAt }) } });

  constructor(private readonly settings: Settings, private readonly start: string,
    private readonly signal: AbortSignal, private readonly deadlineMs: number, private readonly idleResetMs: number) {
    void this.ready.catch(() => {});
    this.clock = settings.clock ?? REAL_CLOCK;
    let consumed = false;
    this.events = { [Symbol.asyncIterator]: () => {
      if (consumed) fail('invalid_request');
      consumed = true;
      return {
        next: () => this.next(),
        return: async () => { this.close(); return { done: true, value: undefined }; },
      };
    } };
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (!this.checkpoint()) return;
    this.timer(Math.max(1, deadlineMs - Date.now()), 'deadline');
    this.timer(settings.limits.sessionMs, 'session_timeout');
    void this.connect();
  }

  private timer(ms: number, code: LiveVoiceErrorCode) {
    const timer = setTimeout(() => { this.timers.delete(timer); this.finish(code); }, ms);
    this.timers.add(timer); return timer;
  }
  private clear(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) { clearTimeout(timer); this.timers.delete(timer); }
  }
  private touch(activity = true) {
    if (!activity && this.idle) return;
    this.clear(this.idle);
    if (this.isReady && !this.terminal) this.idle = this.timer(activity ? this.idleResetMs : this.settings.limits.idleMs, 'idle_timeout');
  }
  private readonly onAbort = () => { this.finish('cancelled'); };
  private checkpoint(): boolean {
    if (this.terminal) return false;
    if (this.signal.aborted) { this.finish('cancelled'); return false; }
    if (Date.now() >= this.deadlineMs) { this.finish('deadline'); return false; }
    return true;
  }

  private async connect(): Promise<void> {
    let key: string | undefined;
    try { if (!this.checkpoint()) return; key = await this.settings.resolve(this.settings.keyReference); }
    catch { if (this.checkpoint()) this.finish('credential_unavailable'); return; }
    if (!this.checkpoint()) return;
    if (typeof key !== 'string' || !key.trim() || key.length > 8192) { this.finish('credential_unavailable'); return; }
    this.secret = key;
    this.handshake = this.timer(this.settings.limits.handshakeMs, 'handshake_timeout');
    try {
      this.creatingSocket = true;
      // The key travels in the header, never in the URL: docs, "Authenticate with Authorization: Bearer".
      const socket = this.settings.socketFactory(ENDPOINT, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: this.settings.limits.maxIncomingBytes, handshakeTimeout: this.settings.limits.handshakeMs,
        perMessageDeflate: false, followRedirects: false,
      });
      this.socket = socket;
      this.creatingSocket = false;
      socket.on('error', this.onError); socket.on('close', this.onClose);
      socket.on('message', this.onMessage);
      socket.on('unexpected-response', this.onUnexpectedResponse);
      socket.on('pong', this.onPong);
      this.schedulePing(socket);
      socket.once('open', () => { if (this.checkpoint()) this.write(this.start); });
      if (!this.checkpoint()) this.shutdownSocket();
    } catch {
      this.creatingSocket = false;
      this.finish('transport_error');
      if (this.terminal) this.shutdownSocket();
    }
  }

  private schedulePing(socket: WebSocket): void {
    this.pingTimer = setTimeout(() => {
      this.pingTimer = undefined;
      if (this.terminal || socket !== this.socket) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      try { socket.ping(); } catch { return; }
      this.watchUpstreamStall(socket);
      if (this.awaitingPong && !this.inboundThisPing) {
        this.missedPongs += 1;
        if (this.missedPongs >= PING_MISSED_LIMIT) {
          // The inbound age is the number that decides this: a pongless window that still carried provider
          // frames is a live transport, and the 3o call was dropped for exactly that reason.
          hostLogEvent({ event: 'live_no_pong', lastInboundAgeMs: Math.max(0, Date.now() - this.lastInboundAt), missedPongs: this.missedPongs, bufferedAmount: socket.bufferedAmount });
          this.dropUpstream('no_pong', socket);
          return;
        }
      }
      this.awaitingPong = true;
      this.inboundThisPing = false;
      this.schedulePing(socket);
    }, PING_INTERVAL_MS);
    this.timers.add(this.pingTimer);
  }
  private readonly onPong = () => { this.awaitingPong = false; this.missedPongs = 0; this.lastInboundAt = Date.now(); };
  private readonly onError = (error: Error) => {
    if (this.terminal) return;
    const code = object(error) ? error.code : undefined;
    this.finish(code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'incoming_limit' : 'transport_error');
  };
  private readonly onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
    this.finish('provider_setup_rejected');
    response.resume();
  };
  private readonly onClose = (code: number) => {
    if (this.upstreamDrop && this.upstreamDrop.closeCode === null) this.upstreamDrop.closeCode = code;
    if (this.terminal) { this.cleanup(); return; }
    // A close before the start barrier is a failed setup; after it, a recoverable drop.
    this.recoverable = this.isReady;
    this.finish(this.isReady ? 'remote_closed' : 'provider_setup_rejected', this.upstreamDrop);
  };

  private dropUpstream(errorKind: string, socket: WebSocket): void {
    if (this.terminal) return;
    const errorKindValue = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorKind) ? errorKind : 'write_error';
    this.upstreamDrop = { errorKind: errorKindValue, closeCode: null, bufferedAmount: socket.bufferedAmount, writesFailed: this.diagnostic.localWriteCallbackErrorCalls, sessionMs: Math.max(0, Date.now() - this.startedAt) };
    this.recoverable = true;
    this.finish('transport_error', this.upstreamDrop);
  }
  private clearUploadBlock(): void {
    this.uploadBlockedSince = undefined;
    this.uploadBufferedLow = undefined;
  }
  private outboundProgress(socket: WebSocket): void {
    if (this.terminal || socket !== this.socket || this.uploadBlockedSince === undefined) return;
    this.uploadBlockedSince = Date.now();
    this.uploadBufferedLow = socket.bufferedAmount;
  }
  private queueUpstreamStall(socket: WebSocket, receipt: { silentMs: number } | { noProgressMs: number }): void {
    if (this.upstreamStallQueued) return;
    this.upstreamStallQueued = true;
    hostLogEvent({ event: 'live_stall', ...receipt });
    queueMicrotask(() => { if (socket === this.socket) this.dropUpstream('stalled', socket); });
  }
  private watchUpstreamStall(socket: WebSocket): void {
    if (this.terminal || socket !== this.socket) return;
    const now = Date.now();
    const buffered = socket.bufferedAmount;
    const silentMs = now - this.lastInboundAt;
    if (silentMs >= STALL_SILENCE_MS) {
      this.queueUpstreamStall(socket, { silentMs });
      return;
    }
    // Shedding always retains the newest mic frame. Arm only while that demand is blocked at the high-water mark.
    // A new low is net local drain across the episode. Comparing with the immediately prior sample would let
    // queue oscillation refresh the deadline forever.
    if (this.micPending.length && buffered >= UPLINK_SHED_BYTES) {
      if (this.uploadBlockedSince === undefined) {
        this.uploadBlockedSince = now;
        this.uploadBufferedLow = buffered;
      } else if (this.uploadBufferedLow !== undefined && buffered < this.uploadBufferedLow) {
        this.uploadBlockedSince = now;
        this.uploadBufferedLow = buffered;
      }
      const noProgressMs = now - this.uploadBlockedSince;
      if (noProgressMs >= this.settings.limits.upstreamStallMs) {
        this.queueUpstreamStall(socket, { noProgressMs });
        return;
      }
    } else {
      this.clearUploadBlock();
    }
    if (buffered > QUEUE_LOG_BYTES && (this.lastQueueLogAt === undefined || now - this.lastQueueLogAt >= QUEUE_LOG_INTERVAL_MS)) {
      this.lastQueueLogAt = now;
      this.emit({ type: 'upstreamQueue', bufferedBytes: buffered });
    }
  }

  private readonly onMessage = (data: RawData) => {
    if (this.terminal) return;
    const byteLength = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
    if (byteLength > this.settings.limits.maxIncomingBytes) { this.finish('incoming_limit'); return; }
    let message: unknown;
    const parts = Array.isArray(data) ? data : [data];
    const text = typeof data === 'string' ? data : Buffer.concat(parts.map(part => (part instanceof ArrayBuffer ? Buffer.from(part) : part))).toString('utf8');
    try { message = JSON.parse(text); }
    catch { this.finish('protocol_error'); return; }
    if (!object(message) || typeof message.type !== 'string') { this.finish('protocol_error'); return; }
    this.lastInboundAt = Date.now();
    this.inboundThisPing = true;
    // Every provider frame is untrusted: a shape refusal becomes a typed outcome, never an uncaught throw.
    try { this.dispatch(message); } catch { this.finish('protocol_error'); }
  };

  private dispatch(message: ObjectValue): void {
    if (!this.isReady && message.type !== 'session.started') {
      // Only the start barrier may precede readiness; an error frame here is a refused setup, and the
      // provider's own words are the only evidence that says which field it refused.
      if (message.type === 'error') {
        hostLogEvent({ event: 'gptlive_setup_error', ...setupErrorReceipt(message['error']) });
        this.finish('provider_setup_rejected'); return;
      }
      this.finish('protocol_error'); return;
    }
    switch (message.type) {
      case 'session.started': return this.started(message);
      case 'session.output_audio.delta': return this.outputAudio(message);
      case 'session.input_transcript.delta': return this.inputTranscript(message);
      case 'session.output_transcript.delta': return this.outputTranscript(message);
      case 'response.event': return this.delegated(message);
      // 3r D4: the provider opening a delegation. Unread until now, so it landed in the unknown-frame counter.
      case 'session.delegation.created': return this.delegationCreated(message);
      case 'session.usage.updated': return this.touch();
      case 'session.closed': return this.sessionClosed(message);
      case 'error': return this.providerError(message);
      // N1: an unread frame may be the yield signal this adapter has no rule for yet, so it is counted by name
      // and reported once per session instead of vanishing into a bare touch.
      default:
        if (typeof message.type === 'string') this.unknownFrames.set(message.type, (this.unknownFrames.get(message.type) ?? 0) + 1);
        this.touch();
        return;
    }
  }

  private started(message: ObjectValue): void {
    if (this.isReady || !object(message.session)) fail('protocol_error');
    this.clear(this.handshake);
    this.isReady = true;
    if (!this.checkpoint() || !this.emit({ type: 'ready' })) return;
    this.readiness.resolve();
    this.touch();
  }

  private audioDelta(message: ObjectValue): Uint8Array | undefined {
    if (typeof message.delta !== 'string') fail('protocol_error');
    const bytes = Buffer.from(message.delta, 'base64');
    if (!bytes.byteLength) return undefined;
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private outputAudio(message: ObjectValue): void {
    const pcm = this.audioDelta(message);
    if (!pcm) return;
    const now = this.clock.now();
    // Only speech is model output: a frame whose level is below the audible threshold is a fill frame, and it
    // neither counts as the server talking for a barge-in (session 1018 sent 48 kB/s for the whole call) nor
    // resets any window that is waiting for the answer to end.
    const level = pcm16RmsDbfs(pcm);
    const audible = level >= AUDIBLE_RMS_DBFS;
    // The arrival clock every post-flush gap is read on: the frames of the cut answer arrive back to back, so a
    // gap this long means the answer that replay would cut is over.
    const gap = now - this.lastOutputDeltaAt;
    if (audible) this.lastOutputDeltaAt = now;
    // A delta during an open episode is the server still talking, so the yield is measured again from this frame.
    if (audible && this.inputEpisode.length) {
      if (now >= this.episodeDeadline) this.clearInputEpisode(true);
      else if (!this.flushed) this.armYield();
    }
    this.diagnostic.outputAudioFrames += 1;
    this.diagnostic.outputAudioPCMBytes += pcm.byteLength;
    // Contract invariant: no permanent frame dropping. Output audio of an open session is forwarded, and an input
    // transcript never silences the assistant. The one bounded exception is the window right after a barge-in
    // flush, where the frames of the answer the owner just cut are discarded so they cannot replay; it ends on an
    // output gap or a fixed deadline and never latches.
    if (this.postFlushAt !== undefined) {
      if (now - this.postFlushAt >= POST_FLUSH_DROP_LIMIT_MS || gap >= POST_FLUSH_GAP_MS) {
        this.postFlushAt = undefined;
        hostLogEvent({ event: 'gptlive_post_flush_dropped_ms', ms: Math.round(this.postFlushDroppedMs) });
        this.postFlushDroppedMs = 0;
      } else {
        this.postFlushDroppedMs += pcm.byteLength / OUTPUT_PCM_BYTES_PER_MS;
        this.touch();
        return;
      }
    }
    // Standing cushion: the hold is armed at the first AUDIBLE audio of a stretch and re-armed whenever the
    // modelled native queue has drained, because after any dry the 80 ms native prebuffer is below one 100 ms
    // delta. Fill frames never open or re-arm a hold: 28 of the 28 flushes in the field call "cut" pure silence
    // (3r D2). A held fill frame keeps its place in the queue, it is only never counted as held speech.
    const drained = this.stretchOpen && !this.holding && now >= this.playbackUntil;
    if (audible && (!this.stretchOpen || drained)) {
      this.stretchOpen = true;
      this.holding = true;
      if (drained) this.playbackRearms += 1;
      this.headStartTimer = this.clock.setTimer(HEAD_START_MS, () => { this.headStartTimer = undefined; this.releaseHeadStart(); });
    }
    if (this.holding) {
      this.held.push(pcm);
      this.heldBytes += pcm.byteLength;
      if (audible) this.heldAudibleBytes += pcm.byteLength;
      if (this.heldAudibleBytes >= HEAD_START_BYTES) this.releaseHeadStart();
      this.touch();
      return;
    }
    this.emitOutput(pcm, level);
    this.touch();
  }

  /**
   * Forward one output chunk to playback. Every byte goes, audible or not: a silent frame still has to play, so
   * nothing is dropped. Only audible speech enters the state machine (SPEAKING, the 500 ms silence rule, the
   * modelled playback queue and the 2000 ms turn idle), which is what lets LISTENING and THINKING appear while the
   * provider keeps streaming.
   */
  private emitOutput(pcm: Uint8Array, rmsDbfs: number = pcm16RmsDbfs(pcm)): void {
    const audible = rmsDbfs >= AUDIBLE_RMS_DBFS;
    if (audible) {
      this.audioSinceCompletion = true;
      this.silenceSent = false;
      this.queuePlayback(pcm.byteLength);
    }
    this.emit({ type: 'audio', pcm, rate: 24_000, audible, rmsDbfs });
    if (!audible) return;
    this.armOutputSilence();
    this.settleTurn();
  }

  /** Forward the held audio as one event, or nothing when the stretch was cut before it filled. */
  private releaseHeadStart(): void {
    if (this.headStartTimer !== undefined) { this.clock.clearTimer(this.headStartTimer); this.headStartTimer = undefined; }
    this.holding = false;
    if (!this.heldBytes) return;
    const pcm = new Uint8Array(this.heldBytes);
    let offset = 0;
    for (const part of this.held) { pcm.set(part, offset); offset += part.byteLength; }
    this.held = [];
    this.heldBytes = 0;
    this.heldAudibleBytes = 0;
    this.emitOutput(pcm);
  }

  /** A barge-in, a provider error or a close discards the head start: that audio is never played. */
  private discardHeadStart(): void {
    if (this.headStartTimer !== undefined) { this.clock.clearTimer(this.headStartTimer); this.headStartTimer = undefined; }
    this.stretchOpen = false;
    this.holding = false;
    this.held = [];
    this.heldBytes = 0;
    this.heldAudibleBytes = 0;
  }

  /**
   * No native playback-drained signal reaches the host (the Swift device drains its own queue and nothing on
   * the port reports it), so the adapter models the queue from forwarded PCM: 24 kHz s16 mono is 48 bytes per
   * millisecond, appended behind whatever is still queued.
   */
  private queuePlayback(bytes: number): void {
    const now = this.clock.now();
    this.lastForwardedAt = now;
    this.playbackUntil = Math.max(this.playbackUntil, now) + bytes / OUTPUT_PCM_BYTES_PER_MS;
    if (this.postFlushMs !== undefined) this.postFlushMs += bytes / OUTPUT_PCM_BYTES_PER_MS;
  }

  private inputTranscript(message: ObjectValue): void {
    if (typeof message.delta !== 'string') fail('protocol_error');
    if (!message.delta.length) return;
    // Ruling GL1-R1: a whitespace-only fragment is still journaled below, but it carries no word, so it starts no
    // episode, takes no word and never touches the barge-in latch.
    if (message.delta.trim().length) this.noteInput(message.delta);
    this.userTranscriptOpen = true;
    this.diagnostic.inputTranscriptionEvents += 1;
    this.diagnostic.inputTranscriptionCharacters += message.delta.length;
    this.emit({ type: 'inputTranscription', text: message.delta, finished: false, ...transcriptMetadata(message) });
    this.touch();
  }

  /**
   * An input episode is the owner's run of input transcript deltas; it ends after INPUT_EPISODE_QUIET_MS of
   * quiet, which resets the assembled transcript and re-arms the once-per-episode barge-in latch. The episode
   * is what makes a split delta of one word still count as one word.
   */
  private noteInput(delta: string): void {
    const now = this.clock.now();
    if (this.inputEpisode.length && now >= this.episodeDeadline) this.clearInputEpisode(true);
    if (this.episodeQuiet !== undefined) this.clock.clearTimer(this.episodeQuiet);
    if (!this.inputEpisode.length) {
      this.episodeToken += 1;
      this.episodeQueuedMs = Math.round(Math.max(0, this.playbackUntil - now) + this.heldAudibleBytes / OUTPUT_PCM_BYTES_PER_MS);
    }
    this.episodeClosed = false;
    this.episodeDeadline = now + INPUT_EPISODE_QUIET_MS;
    const token = this.episodeToken, epoch = this.socket;
    this.episodeQuiet = this.clock.setTimer(INPUT_EPISODE_QUIET_MS, () => {
      if (this.terminal || token !== this.episodeToken || epoch !== this.socket) return;
      this.endInputEpisode();
    });
    this.inputEpisode += delta;
    if (!this.flushed) this.armYield();
  }

  private armYield(): void {
    if (this.episodeClosed || this.clock.now() >= this.episodeDeadline) return;
    if (this.yieldTimer !== undefined) this.clock.clearTimer(this.yieldTimer);
    const token = this.episodeToken, epoch = this.socket, generation = this.generation;
    const timer = this.clock.setTimer(SERVER_YIELD_GAP_MS, () => {
      if (this.terminal || this.yieldTimer !== timer || token !== this.episodeToken || epoch !== this.socket || generation !== this.generation) return;
      this.yieldTimer = undefined;
      if (this.clock.now() <= this.episodeDeadline + SERVER_YIELD_GAP_MS) this.yieldCheck();
      if (this.clock.now() >= this.episodeDeadline) this.clearInputEpisode(true);
    });
    this.yieldTimer = timer;
  }

  private yieldCheck(): void {
    if (this.flushed || !this.inputEpisode.length) return;
    const now = this.clock.now();
    // The server is still sending: it decided this was a backchannel, not an interruption. Its next delta re-arms.
    if (now - this.lastOutputDeltaAt < SERVER_YIELD_GAP_MS) return;
    const queued = Math.max(0, this.playbackUntil - now) + this.heldAudibleBytes / OUTPUT_PCM_BYTES_PER_MS;
    if (queued <= 0) return;
    this.flush(queued, now);
  }

  private flush(queuedMs0: number, now: number): void {
    const words = countWords(this.inputEpisode);
    const queuedMs = Math.round(queuedMs0);
    // The measured quiet that proved the server had yielded, which is what makes this a cut and not a chop.
    const yieldGapMs = Math.round(now - this.lastOutputDeltaAt);
    this.flushed = true;
    this.generation += 1;
    this.muted = this.generation;
    // The cut turn is over at the host, so no idle completion is owed to it; later audio reopens the account.
    this.audioSinceCompletion = false;
    this.outputTranscriptOpen = false;
    // The host flushes its native queue on `interrupted`, so the modelled queue and any head start go with it.
    this.playbackUntil = now;
    this.discardHeadStart();
    this.postFlushMs = 0;
    // The frames of the answer the owner cut keep arriving for a moment; the bounded drop window keeps them out
    // of the port so the cut answer cannot replay.
    this.postFlushAt = this.playbackUntil;
    this.postFlushDroppedMs = 0;
    this.silenceSent = false;
    if (this.outputSilence !== undefined) { this.clock.clearTimer(this.outputSilence); this.outputSilence = undefined; }
    hostLogEvent({ event: 'gptlive_flush', words, queuedMs, yieldGapMs });
    this.emit({ type: 'interrupted' });
  }

  private endInputEpisode(): void {
    this.episodeQuiet = undefined;
    this.episodeClosed = true;
    if (this.yieldTimer === undefined) this.clearInputEpisode(true);
  }

  private clearInputEpisode(finalize: boolean): void {
    this.episodeToken += 1;
    if (this.episodeQuiet !== undefined) { this.clock.clearTimer(this.episodeQuiet); this.episodeQuiet = undefined; }
    if (this.yieldTimer !== undefined) { this.clock.clearTimer(this.yieldTimer); this.yieldTimer = undefined; }
    if (finalize && !this.flushed && this.inputEpisode.length) {
      hostLogEvent({ event: 'gptlive_no_flush', reason: this.episodeQueuedMs > 0 ? 'server_continued' : 'queue_empty', words: countWords(this.inputEpisode) });
    }
    this.inputEpisode = '';
    this.episodeClosed = false;
    this.flushed = false;
    if (finalize) { this.reportPostFlush(); this.ownerTurnEnded(); }
  }

  /**
   * The owner's episode is over with no assistant audio playing or held, so what comes next is her think time.
   * gpt-live-1 sends no generation-start event on a plain turn, so the adapter synthesizes the pair the host
   * needs: the final input transcript and a model turn start, which is what enters THINKING, resets the turn's
   * completion flag (arming the response watchdog) and re-arms the once-per-episode barge-in latch.
   */
  private ownerTurnEnded(): void {
    if (this.terminal) return;
    const now = this.clock.now();
    if (this.heldAudibleBytes > 0 || this.playbackUntil > now) return;
    this.endTurnTranscripts();
    this.emit({ type: 'modelTurnStarted' });
    this.touch();
  }

  /** Receipt, no transcript text: how much audio still arrived after a barge-in, before the next episode. */
  private reportPostFlush(): void {
    const ms = this.postFlushMs;
    if (ms === undefined) return;
    this.postFlushMs = undefined;
    hostLogEvent({ event: 'gptlive_post_flush_audio_ms', ms: Math.round(ms) });
  }

  /** Receipt, once per session: each provider frame name this adapter has no rule for, and how often it came. */
  private reportUnknownFrames(): void {
    for (const [type, count] of this.unknownFrames) hostLogEvent({ event: 'gptlive_unknown_frame', type, count });
    this.unknownFrames.clear();
  }

  /**
   * Audible silence, the end of SPEAKING: OUTPUT_SILENCE_MS of output quiet with the modelled playback drained.
   * The synthesized turnComplete at TURN_IDLE_QUIET_MS stays the semantic end of the turn; the host turns this
   * receipt into LISTENING, and new audio before the completion simply re-enters SPEAKING.
   */
  private armOutputSilence(): void {
    if (this.outputSilence !== undefined) this.clock.clearTimer(this.outputSilence);
    this.outputSilence = this.clock.setTimer(OUTPUT_SILENCE_MS, () => { this.outputSilence = undefined; this.reachOutputSilence(); });
  }

  private reachOutputSilence(): void {
    if (this.terminal || !this.audioSinceCompletion || this.silenceSent) return;
    const drain = Math.ceil(this.playbackUntil - this.clock.now());
    if (drain > 0) {
      this.outputSilence = this.clock.setTimer(drain, () => { this.outputSilence = undefined; this.reachOutputSilence(); });
      return;
    }
    this.silenceSent = true;
    this.emit({ type: 'waitingForInput', value: true });
    this.touch();
  }

  /**
   * Presentation idle, the one end of turn: audio was forwarded since the last completion, the output has been
   * quiet for TURN_IDLE_QUIET_MS, the modelled playback is drained and no delegated response is outstanding.
   * `response.done` clears the outstanding flag and never declares the playback drained by itself.
   */
  private settleTurn(): void {
    if (this.terminal) return;
    if (this.idleQuiet !== undefined) { this.clock.clearTimer(this.idleQuiet); this.idleQuiet = undefined; }
    if (this.holding || this.delegatedOutstanding || this.pendingCalls.length > 0 || !this.audioSinceCompletion) return;
    const now = this.clock.now();
    const wait = Math.max(TURN_IDLE_QUIET_MS - (now - this.lastForwardedAt), Math.ceil(this.playbackUntil - now), 0);
    if (wait <= 0) { this.completeTurn(); return; }
    this.idleQuiet = this.clock.setTimer(wait, () => { this.idleQuiet = undefined; this.settleTurn(); });
  }

  private completeTurn(): void {
    const idleMs = Math.max(0, Math.round(this.clock.now() - this.lastForwardedAt));
    this.audioSinceCompletion = false;
    this.stretchOpen = false;
    // The semantic end of the turn subsumes the audible-silence receipt: no listening flip after the completion.
    this.silenceSent = true;
    if (this.outputSilence !== undefined) { this.clock.clearTimer(this.outputSilence); this.outputSilence = undefined; }
    if (this.outputTranscriptOpen) { this.outputTranscriptOpen = false; this.emit({ type: 'outputTranscription', text: '', finished: true, finalOrigin: 'app_response_end' }); }
    if (this.emit({ type: 'turnComplete' })) { this.diagnostic.turnCompleteEvents += 1; this.diagnostic.generationCompleteEvents += 1; }
    hostLogEvent({ event: 'gptlive_turn_complete', idleMs, drained: true });
    hostLogEvent({ event: 'playback_rearm', count: this.playbackRearms });
    this.playbackRearms = 0;
    this.touch();
  }

  private outputTranscript(message: ObjectValue): void {
    if (typeof message.delta !== 'string') fail('protocol_error');
    // Transcripts are never dropped: the host journals what was actually spoken.
    if (message.delta.length) {
      this.outputTranscriptOpen = true;
      this.emit({ type: 'outputTranscription', text: message.delta, finished: false, ...transcriptMetadata(message) });
    }
    this.touch();
  }

  /** A `response.event` envelope forwards one Responses backend event (`event` carries the nested type). */
  private delegated(message: ObjectValue): void {
    const event = message.event;
    if (!object(event) || typeof event.type !== 'string') fail('protocol_error');
    switch (event.type) {
      case 'response.created': {
        const responseId = object(event.response) && typeof event.response.id === 'string' && event.response.id.length ? event.response.id : undefined;
        if (responseId !== undefined) this.currentResponse = responseId;
        // A repeated `response.created` is the same response: it changes no generation and no completion account.
        if (responseId !== undefined && this.openedResponses.has(responseId)) { this.touch(); return; }
        if (responseId !== undefined) this.openedResponses.add(responseId);
        // O1b-A: the response's own receipt, minted before any output can name it.
        this.receipt('response.created', { responseKey: this.responseKeyOf(responseId) }, {
          createdAt: this.clock.now(), ...(responseId === undefined ? {} : { providerResponseId: responseId }),
        });
        this.clearInputEpisode(false);
        this.endTurnTranscripts('app_model_start');
        this.delegatedOutstanding = true;
        this.generation += 1;
        // 3r D10: the completion account belongs to the response that is answering now, so the audible line of the
        // pre-tool turn can never complete this one before it has spoken.
        this.audioSinceCompletion = false;
        this.responseCreated(event, message);
        this.emit({ type: 'modelTurnStarted' });
        this.touch();
        return;
      }
      case 'response.output_item.done': return this.outputItem(event, message);
      case 'response.done':
      case 'response.completed':
      // 3r E (ruling S1-R1): a response that ends any other way is terminal too. Failed, incomplete and cancelled
      // are the provider's own words for "this response is over and no more of it will come".
      case 'response.failed':
      case 'response.incomplete':
      case 'response.cancelled': {
        const response = object(event.response) ? event.response : undefined;
        const responseId = typeof response?.id === 'string' && response.id.length ? response.id : undefined;
        // A duplicated or out-of-order terminal event is the same end: it neither closes an obligation twice nor
        // moves the presentation (S5).
        if (responseId !== undefined) {
          // A repeat of the same end closes nothing twice and moves no presentation, but an owed continuation
          // still gets its one chance through the gate (3r A retry, 3r E resume): the gate refuses a partial batch.
          if (this.endedResponses.has(responseId)) { this.resumeContinuation(); this.touch(); return; }
          this.endedResponses.add(responseId);
        }
        const usage = response?.usage;
        if (object(usage) && typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0) {
          this.emit({ type: 'contextUsage', totalTokens: usage.total_tokens,
            ...(typeof usage.input_tokens === 'number' ? { promptTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === 'number' ? { responseTokens: usage.output_tokens } : {}) });
        }
        // S5: a backend response that ends failed, incomplete or errored still ends the response, so a batch it
        // answered is flushed and an owed continuation is resumed (3r E). A failure that leaves nothing to say is
        // the turn's failure: one typed disposition with the provider's own code, never a silent stall.
        const status = typeof response?.status === 'string' ? response.status : event.type.replace('response.', '');
        if (status !== 'completed' && status !== 'done') {
          const createsBefore = this.continuationsSent;
          this.endResponse(message);
          if (this.continuationsSent === createsBefore) this.emit({ type: 'turnFailed', code: failureCode(status, response?.error) });
          this.touch();
          return;
        }
        this.endResponse(message);
        this.touch();
        return;
      }
      default: this.touch(); return;
    }
  }

  /**
   * 3r E (ruling S1-R1): one place where a delegated response stops being active, however it stopped. It clears the
   * outstanding flag so the turn can still complete, closes the delegation, and lets an owed continuation through the
   * gate, so a result deferred behind this response is never left unresumable.
   */
  private endResponse(message: ObjectValue | undefined): void {
    this.delegatedOutstanding = false;
    // O1b-A: the response stops being active here whatever stopped it, so its terminal receipt is taken here
    // too, with the provider's own status and the reason this adapter read from it.
    const responseKey = this.currentResponseKey;
    if (responseKey !== undefined) {
      const status = typeof message?.['status'] === 'string' ? message['status'] : undefined;
      this.receipt('response.terminal', { responseKey }, {
        terminalAt: this.clock.now(), status: TERMINAL_STATUS[status ?? ''] ?? 'completed', terminalReason: terminalReasonOf(status),
      });
    }
    if (message) this.responseDone(message);
    if (this.outputTranscriptOpen) { this.outputTranscriptOpen = false; this.emit({ type: 'outputTranscription', text: '', finished: true, finalOrigin: 'app_response_end' }); }
    // End of turn is presentation idle, never these frames: a terminal response does not drain playback.
    this.settleTurn();
    this.writeAnswered();
    this.resumeContinuation();
  }

  private endTurnTranscripts(finalOrigin: 'app_quiet' | 'app_model_start' = 'app_quiet'): void {
    if (!this.userTranscriptOpen) return;
    this.userTranscriptOpen = false;
    this.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin });
  }

  /** A delegated function call: `{call_id, name, arguments}` on the nested output item. */
  private outputItem(event: ObjectValue, message: ObjectValue): void {
    // O1b-A: the first output of a response is the receipt that the provider really is answering. One per
    // response, before the type check, so a spoken answer and a delegated one are both observed.
    const responseKey = this.currentResponseKey;
    if (responseKey !== undefined && !this.observedResponses.has(responseKey)) {
      this.observedResponses.add(responseKey);
      this.receipt('response.observed', { responseKey }, {
        observedAt: this.clock.now(), ...(this.currentResponse === undefined ? {} : { providerResponseId: this.currentResponse }),
      });
    }
    const item = event.item;
    if (!object(item)) fail('protocol_error');
    if (item.type !== 'function_call') { this.touch(); return; }
    let args: JsonObject;
    try { const parsed: unknown = JSON.parse(typeof item.arguments === 'string' && item.arguments.length ? item.arguments : '{}'); args = object(parsed) ? parsed : {}; }
    catch { fail('protocol_error'); }
    const call: LiveToolCall = { id: this.text(item.call_id), name: this.text(item.name), args };
    // 3r A: a repeated call event is the same call, not a second one, and it is answered once.
    if (this.outputSent.has(call.id) || this.pendingCalls.some(pending => pending.id === call.id)) { this.touch(); return; }
    this.pendingCalls = [...this.pendingCalls, call];
    this.noteCallDelegation(call.id, message);
    // O1b-A: the call's own receipt, with the provider call id and the size of its arguments, never their text.
    this.callOrigins.set(call.id, { at: this.clock.now(), ...(responseKey === undefined ? {} : { responseKey }) });
    this.receipt('call.intent', this.callIds(call.id), {
      name: call.name, argsChars: typeof item.arguments === 'string' ? item.arguments.length : 0,
      intentAt: this.clock.now(), providerCallId: call.id,
    });
    this.emit({ type: 'toolCall', calls: [call] });
    this.touch();
  }

  /** Attribute a call to the delegation whose envelope carried it, and let that delegation's chain see it (D4). */
  private noteCallDelegation(callId: string, message: ObjectValue): void {
    const delegationId = typeof message.delegation_id === 'string' && message.delegation_id.length ? message.delegation_id : undefined;
    if (delegationId === undefined) return;
    this.callDelegation.set(callId, delegationId);
    this.delegations.get(delegationId)?.awaiting.add(callId);
  }

  /** `session.delegation.created`: one back-end delegation, its first response id and its stream offset (3r D4). */
  private delegationCreated(message: ObjectValue): void {
    const inner = object(message.delegation) ? message.delegation : message;
    const id = typeof inner.id === 'string' && inner.id.length ? inner.id : undefined;
    if (id === undefined) { this.touch(); return; }
    // A repeated `session.delegation.created` is the same delegation, not a protocol fault (S5): rebuilding a
    // healthy session over a duplicated frame is what turned one duplicate into a lost call.
    if (this.delegations.has(id)) { this.touch(); return; }
    const offsetMs = typeof inner.offset_ms === 'number' && Number.isFinite(inner.offset_ms) && inner.offset_ms >= 0 ? Math.round(inner.offset_ms) : 0;
    // S1-R1: the frame names the response this delegation opens with, so the chain starts here and not at the first
    // nested `response.created`.
    const responseId = typeof inner.response_id === 'string' && inner.response_id.length ? inner.response_id : undefined;
    this.delegations.set(id, { id, openedAt: this.clock.now(), responses: responseId ? [responseId] : [], awaiting: new Set(), outputsAt: undefined, stallTimer: undefined, stalled: false });
    hostLogEvent({ event: 'delegation_open', ms: offsetMs });
    // O1b-A (D12-1): one receipt per delegated response, so a delegation is never only an end-of-session count.
    // The key is minted here and reused by that response's own `response.created`, so the two rows join.
    if (responseId !== undefined) {
      this.receipt('delegation.created', { responseKey: this.responseKeyOf(responseId) }, {
        createdAt: this.clock.now(), providerResponseId: responseId, callCount: 0,
      });
    }
    this.touch();
  }

  /** A delegated `response.created`: it names the response this delegation's chain continues with (D4, D10). */
  private responseCreated(event: ObjectValue, message: ObjectValue): void {
    const delegation = this.delegationOf(message);
    if (!delegation) return;
    const response = object(event.response) && typeof event.response.id === 'string' && event.response.id.length ? event.response.id : undefined;
    if (response !== undefined && !delegation.responses.includes(response)) delegation.responses.push(response);
    // The continuation this delegation was waiting for has arrived, so its stall window is over.
    this.clearStall(delegation);
  }

  /** A delegated terminal `response.done`: a delegation with no call still owing an output is closed (3r D4). */
  private responseDone(message: ObjectValue): void {
    const delegation = this.delegationOf(message);
    if (!delegation || delegation.awaiting.size) return;
    this.clearStall(delegation);
    this.delegations.delete(delegation.id);
    hostLogEvent({ event: 'delegation_closed', ms: Math.round(this.clock.now() - delegation.openedAt), responses: delegation.responses.length });
  }

  private delegationOf(message: ObjectValue): Delegation | undefined {
    return typeof message.delegation_id === 'string' ? this.delegations.get(message.delegation_id) : undefined;
  }

  private clearStall(delegation: Delegation): void {
    if (delegation.stallTimer !== undefined) { this.clock.clearTimer(delegation.stallTimer); delegation.stallTimer = undefined; }
  }

  /** Every call of a delegation now owes nothing, so its window to produce a response starts here (3r D4). */
  private noteDelegationOutputs(callIds: readonly string[]): void {
    const now = this.clock.now();
    for (const callId of callIds) {
      const key = this.callDelegation.get(callId);
      const delegation = key === undefined ? undefined : this.delegations.get(key);
      if (!delegation) continue;
      delegation.awaiting.delete(callId);
      if (delegation.awaiting.size) continue;
      delegation.outputsAt = now;
      if (delegation.stalled) continue;
      this.clearStall(delegation);
      delegation.stallTimer = this.clock.setTimer(DELEGATION_STALL_MS, () => { delegation.stallTimer = undefined; this.delegationStalled(delegation); });
    }
  }

  /** Detection only (ruling 3r-C): the receipt names the stall and the host's recovery is the only rescue. */
  private delegationStalled(delegation: Delegation): void {
    if (this.terminal || delegation.stalled || this.delegations.get(delegation.id) !== delegation) return;
    delegation.stalled = true;
    hostLogEvent({ event: 'gptlive_delegation_stalled', ms: delegation.outputsAt === undefined ? DELEGATION_STALL_MS : Math.round(this.clock.now() - delegation.outputsAt) });
  }

  private text(value: unknown): string {
    if (typeof value !== 'string' || !value.length || (this.secret && value.includes(this.secret))) fail('protocol_error');
    return value;
  }

  private providerError(message: ObjectValue): void {
    // Errors can cut assistant audio without ending the session (docs, "Handle moderation"); the
    // session's end arrives as session.closed, so this only stops the current generation.
    const error = object(message.error) ? message.error : {};
    const type = typeof error.type === 'string' ? error.type : 'unknown';
    const errorCode = typeof error.code === 'string' && error.code.length ? error.code : 'none';
    const param = typeof error.param === 'string' && error.param.length ? error.param : 'none';
    hostLogEvent({ event: 'live_provider_error', type, code: errorCode, param });
    // S4a-R2 (c): the disposition comes from the code or type map, and the client event id is read from the
    // ledger only to name which command it was.
    const disposition = dispositionOf(type, errorCode);
    const clientEventId = typeof error.client_event_id === 'string' && error.client_event_id.length ? error.client_event_id : undefined;
    const command = clientEventId === undefined ? undefined : this.commands.get(clientEventId);
    // 3r F: a rejection that only says a response is already active is the one retry the continuation gate allows
    // (3r A). It is read before the disposition, because its own type is `invalid_request_error`, which the map
    // would otherwise take for a rejected command.
    const retry = ACTIVE_RESPONSE_ERROR.test(`${type} ${errorCode} ${param}`);
    if (disposition === 'command_rejected' && !retry) {
      // The command never became a response, so there is nothing to cut, and a rejection is not a reason to resend.
      hostLogEvent({ event: 'command_rejected', code: errorCode, param, kind: command?.kind ?? 'other' });
      this.touch();
      return;
    }
    if (disposition === 'validation_failed') {
      // The backend refused the delegation config itself: one loud receipt naming the field, and the live session
      // keeps running, because the voice path is unaffected by a refused backend setting.
      if (!this.validationRefused) { this.validationRefused = true; hostLogEvent({ event: 'responses_validation_failed', param }); }
      this.touch();
      return;
    }
    if (disposition === 'unknown') {
      // S4a-R2 (c): an unclassified provider error is a diagnostic trap, never an interruption and never a retry.
      hostLogEvent({ event: 'provider_error_unclassified', type, code: errorCode, param });
      this.endResponse(undefined);
      this.touch();
      return;
    }
    // 3r F: an error is not a speech cut unless what it names says so. A rejection that only says a response is
    // already active is the one retry the continuation gate allows (3r A).
    if (ACTIVE_RESPONSE_ERROR.test(`${type} ${errorCode} ${param}`)) {
      this.continuationOwed = true;
      this.continuationRejected = true;
      // The retry answers the same batch the rejected create answered (S1-R1).
      this.continuationCalls = Math.max(this.continuationCalls, this.lastContinuationCalls);
      this.touch();
      return;
    }
    if ((disposition === 'moderation' || SPEECH_CUT_ERROR.test(`${type} ${errorCode}`)) && this.generation !== this.muted) {
      this.clearInputEpisode(false);
      this.generation += 1;
      this.muted = this.generation;
      // The host flushes its queue on `interrupted`; future audio is still forwarded, never latched off.
      this.playbackUntil = this.clock.now();
      this.discardHeadStart();
      this.audioSinceCompletion = false;
      this.emit({ type: 'interrupted' });
    }
    // 3r E (ruling S1-R1): an error ends the response that earned it, whether or not it cut the audio (3r F decides
    // the cut), so the wait for its next frame does not outlive it and an owed continuation is resumed.
    this.endResponse(undefined);
    this.touch();
  }

  private sessionClosed(message: ObjectValue): void {
    const reason = typeof message.reason === 'string' ? message.reason : 'unknown';
    switch (reason) {
      case 'close_requested': this.finish('closed'); return;
      case 'expired': this.recoverable = true; this.finish('session_timeout'); return;
      case 'content': this.finish('provider_error'); return;
      case 'remote_hangup': this.finish('remote_closed'); return;
      default:
        // connection_lost (and any unknown reason): the host's fresh-seeded path continues the call.
        this.recoverable = true;
        this.finish('remote_closed');
    }
  }

  private next(): Promise<IteratorResult<LiveVoiceEvent>> {
    const item = this.queue.shift();
    if (item) { this.queueBytes -= item.bytes; return Promise.resolve({ done: false, value: item.event }); }
    if (this.terminal) return Promise.resolve({ done: true, value: undefined });
    if (this.waiter) fail('invalid_request');
    return new Promise(resolve => { this.waiter = resolve; });
  }
  private emit(body: EventBody): boolean {
    const event = { ...body, sequence: this.sequence + 1 } as LiveVoiceEvent;
    const bytes = body.type === 'audio' ? body.pcm.byteLength + 128 : Buffer.byteLength(JSON.stringify(event));
    if (body.type !== 'outcome' && (bytes > this.settings.limits.maxEventBytes
      || (!this.waiter && (this.queue.length >= this.settings.limits.maxEvents || this.queueBytes + bytes > this.settings.limits.maxEventBytes)))) {
      this.finish('event_limit'); return false;
    }
    this.sequence++;
    if (this.waiter) { const notify = this.waiter; this.waiter = undefined; notify({ done: false, value: event }); }
    else { this.queue.push({ event, bytes }); this.queueBytes += bytes; }
    return true;
  }

  private write(frame: string, pcmBytes = 0): boolean {
    if (!this.checkpoint()) return false;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.settings.limits.maxOutgoingBytes) { this.finish('outgoing_limit'); return false; }
    if (socket.bufferedAmount + bytes > this.settings.limits.maxBufferedBytes) { this.finish('backpressure'); return false; }
    try {
      if (!this.checkpoint()) return false;
      if (pcmBytes) { this.diagnostic.localWriteCallbackPendingCalls++; this.diagnostic.localWriteCallbackPendingPCMBytes += pcmBytes; }
      socket.send(frame, error => {
        if (!error) this.outboundProgress(socket);
        if (pcmBytes) {
          this.diagnostic.localWriteCallbackPendingCalls--; this.diagnostic.localWriteCallbackPendingPCMBytes -= pcmBytes;
          if (error) { this.diagnostic.localWriteCallbackErrorCalls++; this.diagnostic.localWriteCallbackErrorPCMBytes += pcmBytes; }
          else { this.diagnostic.localWriteCallbackSuccessCalls++; this.diagnostic.localWriteCallbackSuccessPCMBytes += pcmBytes; if (this.micPending.length) this.flushMic(false); }
        }
        if (error && this.checkpoint()) {
          if (pcmBytes && this.isReady) this.dropUpstream('write_error', socket); else this.onError(error);
        }
      });
      if (pcmBytes) {
        this.diagnostic.localWriteEnqueuedCalls++; this.diagnostic.localWriteEnqueuedPCMBytes += pcmBytes;
      }
      this.touch(); return !this.terminal;
    } catch (error) {
      if (pcmBytes) { this.diagnostic.localWriteCallbackPendingCalls--; this.diagnostic.localWriteCallbackPendingPCMBytes -= pcmBytes; }
      if (this.checkpoint()) this.onError(error instanceof Error ? error : new Error('send_failed'));
      return false;
    }
  }

  /**
   * The host answers each delegated call on its own, so an answer is recorded and the turn continues only once
   * every call of the delegated response has one: `function_call_output` per call_id, then one `response.create`.
   * The return says what reached the backend: a socket write is not provider acceptance (3r amendment A).
   */
  sendToolResponse(input: { responses: LiveToolResponse[] }): LiveToolSendOutcome {
    // A retired session takes no answer: its calls are gone and their outputs never enter a later one (3r B).
    if (this.draining || this.terminal) return 'failed';
    if (!this.isReady) fail('not_ready');
    if (!object(input) || !Array.isArray(input.responses) || !input.responses.length
      || new Set(input.responses.map(response => (object(response) ? response.id : undefined))).size !== input.responses.length
      || input.responses.some(response => !object(response) || !object(response.response) || typeof response.id !== 'string')) fail('invalid_request');
    // A call id this turn never delegated, or one whose output is already on the wire, is not a new answer: the
    // first is a protocol fault, the second a duplicate completion the adapter ignores (3r A, B).
    const fresh = input.responses.filter(response => !this.outputSent.has(response.id));
    if (fresh.some(response => !this.pendingCalls.some(call => call.id === response.id && call.name === response.name))) fail('protocol_error');
    for (const { id, response } of fresh) {
      if (this.answeredCalls.has(id)) fail('protocol_error');
      this.answeredCalls.set(id, response);
    }
    if (!fresh.length) return this.continuationOutcome;
    return this.writeAnswered();
  }

  /**
   * The delegation guide's order (S5): each answered call's output is written the moment it is ready, and exactly
   * one `response.create` follows once every call of the backend response has its output. A create never answers a
   * partial batch, because a call emitted after it would have no continuation left to carry it.
   */
  private writeAnswered(): LiveToolSendOutcome {
    if (!this.pendingCalls.length) return this.continuationOutcome;
    const written: string[] = [];
    for (const call of this.pendingCalls) {
      if (!this.answeredCalls.has(call.id)) continue;
      const response = this.answeredCalls.get(call.id)!;
      // `function_call_output` carries the call_id back to the backend (guides/live-migration, delegation table).
      // Exactly one terminal output per call: success, error, timeout and cancellation are all that one object.
      const outputId = `tool_out_${call.id}`;
      this.recordCommand(outputId, 'tool_out');
      // O1b-A: the result the host produced is executed and prepared here, before the wire sees it.
      const preparedAt = this.clock.now();
      this.receipt('call.executed', this.callIds(call.id), { executedAt: preparedAt });
      this.receipt('call.output_prepared', this.callIds(call.id), { outputPreparedAt: preparedAt });
      if (!this.write(JSON.stringify({ type: 'response.item.create', event_id: outputId, item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(response) } }))) {
        this.pendingCalls = this.pendingCalls.filter(pending => !written.includes(pending.id));
        this.receipt('call.output_written', this.callIds(call.id), {
          outputWrittenAt: this.clock.now(), outcome: 'failed', ms: this.clock.now() - (this.callOrigins.get(call.id)?.at ?? this.clock.now()),
          resultChars: JSON.stringify(response).length,
        });
        return this.continuationOutcome = 'failed';
      }
      const writtenAt = this.clock.now();
      this.receipt('call.output_written', this.callIds(call.id), {
        outputWrittenAt: writtenAt, outcome: call.name === 'research' && response.error === 'invalid_research_arguments' && response.state === 'refused' ? 'refused' : 'completed', ms: writtenAt - (this.callOrigins.get(call.id)?.at ?? writtenAt),
        resultChars: JSON.stringify(response).length,
      });
      written.push(call.id);
      this.outputSent.add(call.id);
    }
    this.pendingCalls = this.pendingCalls.filter(call => !written.includes(call.id));
    for (const id of written) this.answeredCalls.delete(id);
    if (written.length) this.noteDelegationOutputs(written);
    // A call of this backend response still has no answer: its output is owed, so no continuation yet.
    // The one continuation answers every output of this backend response, however many rounds delivered them,
    // so the receipt's count is the batch, not the last chunk (S1-R1).
    this.batchAnswers += written.length;
    if (this.pendingCalls.length > 0) {
      this.deferralReceipt();
      // O1b-A: a response.create skipped because another call of this batch still owes its output is a decision
      // with a reason, recorded once per answer batch rather than left as an absence (D12-2).
      this.continuationReceipt('deferred', 'awaiting_calls');
      return this.continuationOutcome = 'deferred';
    }
    return this.continueTurn(this.batchAnswers, 0);
  }

  /** The one gate a continuation passes (3r A): it is owed, and only a terminal event or a rejection resumes it. */
  private continueTurn(calls: number, attempt: 0 | 1): LiveToolSendOutcome {
    // S1-R1: the answered batch a continuation carries survives the wait, so the receipt of a resumed or retried
    // create still says how large the batch it answers was, instead of a bare zero.
    this.continuationCalls = Math.max(this.continuationCalls, calls);
    if (this.delegatedOutstanding || this.pendingCalls.length > 0) {
      // The originating response is still emitting calls, or a call of this batch has no output yet, so a create
      // now would answer a partial batch: defer to the emitted output of the last open call (S5).
      this.continuationOwed = true;
      this.deferralReceipt();
      // O1b-A: the skip is a decision with a reason, not silence. An answer batch that still owes another call's
      // output is already recorded where it defers (writeAnswered), so this names the other wait: the response is
      // still emitting calls, or this connection is retired and can never send the create (epoch_stale).
      if (this.draining) this.continuationReceipt('deferred', 'draining');
      else if (this.terminal !== undefined) this.continuationReceipt('deferred', 'epoch_stale');
      else if (this.delegatedOutstanding) this.continuationReceipt('deferred', 'awaiting_calls');
      return this.continuationOutcome = 'deferred';
    }
    if (!this.write(JSON.stringify({ type: 'response.create', event_id: this.commandId('cont') }))) {
      this.continuationOwed = true;
      this.continuationReceipt('failed');
      return this.continuationOutcome = 'failed';
    }
    this.continuationReceipt('sent');
    this.continuationOwed = false;
    this.continuationRejected = false;
    this.batchAnswers = 0;
    this.continuationsSent += 1;
    if (attempt) this.continuationRetries += 1;
    const answered = this.continuationCalls;
    this.continuationCalls = 0;
    this.lastContinuationCalls = answered;
    hostLogEvent({ event: 'gptlive_tool_output', calls: answered, responseCreate: attempt ? 'retried' : 'sent' });
    return this.continuationOutcome = 'sent';
  }

  /** Resume a deferred continuation after the terminal event the gate was waiting for. Idempotent by `owed`. */
  private resumeContinuation(): void {
    if (!this.continuationOwed) return;    if (!this.continuationRejected) { this.continueTurn(0, 0); return; }
    this.continuationRejected = false;
    // Exactly one retry: a second rejection leaves the continuation owed and nothing more is sent.
    if (this.continuationRetries >= 1) { this.continuationOwed = false; this.continuationOutcome = 'failed'; return; }
    this.continueTurn(0, 1);
  }

  /** One client command id, so a provider error frame can be tied to the command that earned it (3r F, S4a-R4).
   *  The prefix names the command family: a rejected `tool_out_` answer is not the same event as a rejected
   *  `response.create`. */
  private commandId(kind: 'cont' | 'cmt' | 'thk'): string {
    this.commandSequence += 1;
    const id = `${kind}_${this.commandSequence}`;
    this.recordCommand(id, kind);
    return id;
  }

  /**
   * O1b-A: one receipt into the host's trace store. The port binds the session, the connection epoch and the open
   * turn, so this adapter names only its own response and call keys and never a session it was not handed.
   */
  private receipt<K extends TraceEventKind>(kind: K, ids: { responseKey?: string; callKey?: string }, detail: TraceDetailMap[K]): void {
    this.settings.trace?.receipt(kind, ids, detail);
  }

  /** The host key of a provider response, minted once per provider id so every receipt of it joins. */
  private responseKeyOf(providerId: string | undefined): string {
    if (providerId === undefined) return `r${this.responseKeySeq += 1}`;
    const known = this.responseKeys.get(providerId);
    if (known !== undefined) return known;
    const minted = `r${this.responseKeySeq += 1}`;
    this.responseKeys.set(providerId, minted);
    return minted;
  }

  /** The key of the response answering now: a receipt about it can only name it when the provider named itself. */
  private get currentResponseKey(): string | undefined {
    return this.currentResponse === undefined ? undefined : this.responseKeys.get(this.currentResponse);
  }

  /** O1b-A: the continuation owner's decision, written once per attempt against the response it answers. */
  private continuationReceipt(outcome: ContinuationOutcome, skipReason?: SkipReason): void {
    const responseKey = this.currentResponseKey;
    if (responseKey === undefined) return;
    this.receipt('continuation.decided', { responseKey }, {
      decidedAt: this.clock.now(), outcome, ...(skipReason === undefined ? {} : { skipReason }),
    });
  }

  /** O1b-A: a call's own key, its time and the response that emitted it, so its later receipts join both. */
  private callIds(callKey: string): { callKey: string; responseKey?: string } {
    const origin = this.callOrigins.get(callKey)?.responseKey;
    return { callKey, ...(origin === undefined ? {} : { responseKey: origin }) };
  }

  /**
   * S5 receipt, metadata only: a continuation is owed but cannot go yet, so name the response it answers and how
   * many call outputs it still waits for. Never a call id, never an argument.
   */
  private deferralReceipt(): void {
    const awaiting = this.pendingCalls.filter(call => !this.answeredCalls.has(call.id)).length;
    hostLogEvent({ event: 'continuation_deferred', responseKey: this.currentResponse ?? 'none', awaiting });
  }

  /** S4a-R2 (d): a small ledger of what was sent and when, so a correlation is read from the wire and never
   *  guessed from a string. It grants nothing: an id is never permission to resend a command. */
  private recordCommand(eventId: string, kind: CommandKind): void {
    this.commands.set(eventId, { kind, sentAt: this.clock.now(), epoch: this.generation });
    if (this.commands.size > COMMAND_LEDGER_LIMIT) {
      const oldest = this.commands.keys().next();
      if (!oldest.done) this.commands.delete(oldest.value);
    }
  }

  /** A session that ends owes no call an answer and no delegation a stall receipt (3r B). */
  private retireCalls(): void {
    for (const delegation of this.delegations.values()) this.clearStall(delegation);
    this.delegations.clear();
    this.callDelegation.clear();
    this.pendingCalls = [];
    this.answeredCalls.clear();
    this.outputSent.clear();
    this.openedResponses.clear();
    this.endedResponses.clear();
    this.continuationOwed = false;
    this.batchAnswers = 0;
    this.continuationCalls = 0;
    this.lastContinuationCalls = 0;
    this.delegatedOutstanding = false;
  }

  sendAudio(input: { pcm: Uint8Array; dataClass: DataClass }): void {
    if (this.draining) {
      if (object(input) && input.pcm instanceof Uint8Array && input.pcm.byteLength > 0) { this.diagnostic.drainingDropCalls++; this.diagnostic.drainingDropBytes += input.pcm.byteLength; }
      return;
    }
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || !(input.pcm instanceof Uint8Array) || !input.pcm.byteLength || input.pcm.byteLength % 2) fail('invalid_audio');
    if (!classes.includes(input.dataClass) || !this.settings.allowed.includes(input.dataClass)) fail('route_denied');
    this.diagnostic.audioCalls += 1; this.diagnostic.audioBytes += input.pcm.byteLength;
    const pcm = this.upsampler.process(input.pcm);
    if (!pcm.byteLength) return;
    const overhead = Buffer.byteLength(JSON.stringify({ type: 'session.input_audio.append', audio: '' }));
    if (Math.ceil(pcm.byteLength / 3) * 4 + overhead > this.settings.limits.maxOutgoingBytes) { this.finish('outgoing_limit'); fail('outgoing_limit'); }
    const frame = JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
    this.micPending.push({ frame, bytes: pcm.byteLength });
    this.micPendingBytes += Buffer.byteLength(frame);
    this.sampleCaptured += Buffer.byteLength(frame);
    if (!this.flushMic()) fail(this.terminal?.code ?? 'not_ready');
  }

  /**
   * Send what the uplink can take and shed the rest from the front (3o). The capture path never waits: the queue
   * is bounded by UPLINK_SHED_BYTES plus one frame, and the oldest frames go first so the newest speech wins.
   * W3: a shed is one contiguous run down to the low-water mark, so the wire carries runs, never thin islands.
   */
  private flushMic(sample = true): boolean {
    const socket = this.socket;
    const now = this.clock.now();
    const open = socket !== undefined && socket.readyState === WebSocket.OPEN;
    const buffered = socket?.bufferedAmount ?? 0;
    if (!open) {
      // W3: every frame lost because the socket is not open is counted, in its own field and in the share.
      for (const queued of this.micPending) { const bytes = Buffer.byteLength(queued.frame); this.notOpenBytes += bytes; this.sampleDiscarded += bytes; }
      this.micPending = []; this.micPendingBytes = 0;
    } else {
      if (this.micPending.length > 1 && this.micPendingBytes > UPLINK_SHED_BYTES) {
        // W3: one contiguous run of the oldest frames down to the low-water mark, so the frames that follow are
        // consecutive speech rather than every other 20 ms frame. The trigger and the mark are the queued bytes:
        // a socket pinned at the cap cannot shrink, so pricing the shed on the whole queue would drop a frame per
        // arrival and hand back exactly the islands this replaces.
        while (this.micPending.length > 1 && this.micPendingBytes > UPLINK_SHED_LOW_BYTES) {
          const shed = this.micPending.shift()!;
          const bytes = Buffer.byteLength(shed.frame);
          this.micPendingBytes -= bytes;
          this.shedBytes += bytes;
          this.sampleDiscarded += bytes;
        }
        this.shedRuns += 1;
      }
      while (this.micPending.length && socket.bufferedAmount < UPLINK_SHED_BYTES) {
        const next = this.micPending.shift()!;
        this.micPendingBytes -= Buffer.byteLength(next.frame);
        if (!this.write(next.frame, next.bytes)) return false;
      }
      this.shedPeak = Math.max(this.shedPeak, socket.bufferedAmount + this.micPendingBytes);
      this.watchUpstreamStall(socket);
    }
    // The bytes the socket took out of its own buffer since the last flush: acceptance, never delivery. The level
    // is read after the writes, so a flush nested in a write callback records the same socket state, not a guess.
    const accepted = open && this.lastBufferedAt !== undefined ? Math.max(0, this.lastBuffered - buffered) : 0;
    if (!sample) return !this.terminal;
    this.sampleUplink(now, accepted, open, open ? socket.bufferedAmount : buffered);
    this.evaluateConnection(now);
    if ((this.shedBytes || this.notOpenBytes) && (this.shedReportedAt === undefined || now - this.shedReportedAt >= UPLINK_SHED_RECEIPT_MS)) {
      this.shedReportedAt = now;
      hostLogEvent({ event: 'uplink_shed', bytes: this.shedBytes, bufferedPeak: this.shedPeak, shedRuns: this.shedRuns,
        drainBytesPerSec: this.drainBytesPerSec, notOpenBytes: this.notOpenBytes });
      this.shedBytes = 0; this.shedPeak = 0; this.shedRuns = 0; this.notOpenBytes = 0;
    }
    return !this.terminal;
  }

  /** Record what this flush interval captured, discarded and the socket accepted, then start the next interval. */
  private sampleUplink(now: number, accepted: number, open: boolean, buffered: number): void {
    this.uplinkSamples.push({ at: now, captured: this.sampleCaptured, discarded: this.sampleDiscarded, accepted,
      backlogged: open && buffered >= UPLINK_SHED_BYTES });
    this.sampleCaptured = 0;
    this.sampleDiscarded = 0;
    this.lastBuffered = buffered;
    this.lastBufferedAt = now;
  }

  /** W3: weak when over a fifth of the capture was discarded or the backlog never fell below the cap; ok after
   *  five quiet seconds. One source feeds the caption and the watchdog's terminal code. */
  private evaluateConnection(now: number): void {
    const samples = this.uplinkSamples;
    while (samples.length && samples[0]!.at <= now - CONNECTION_WINDOW_MS) samples.shift();
    const oldest = samples[0]?.at;
    let captured = 0, discarded = 0, accepted = 0, pinned = samples.length > 0;
    for (const sample of samples) {
      captured += sample.captured; discarded += sample.discarded; accepted += sample.accepted;
      if (!sample.backlogged) pinned = false;
    }
    const span = Math.max(1, now - (oldest ?? now));
    this.drainBytesPerSec = Math.round(accepted * 1_000 / span);
    const covered = oldest !== undefined && now - oldest >= CONNECTION_WINDOW_MS;
    for (const sample of samples) if (sample.discarded > 0 || sample.backlogged) this.lastUplinkLossAt = sample.at;
    if (captured > 0 && discarded / captured > CONNECTION_WEAK_SHARE) this.markUplinkLoss(now);
    else if (pinned && covered) this.markUplinkLoss(now);
    else if (this.connectionQuality === 'weak' && (this.lastUplinkLossAt === undefined || now - this.lastUplinkLossAt >= CONNECTION_OK_MS)) {
      this.connectionQuality = 'ok';
      hostLogEvent({ event: 'connection_quality', quality: 'ok', uploadKbps: Math.round(this.drainBytesPerSec * 8 / 1_000) });
    }
  }

  private markUplinkLoss(now: number): void {
    if (this.connectionQuality !== 'weak') {
      this.connectionQuality = 'weak';
      hostLogEvent({ event: 'connection_quality', quality: 'weak', uploadKbps: Math.round(this.drainBytesPerSec * 8 / 1_000) });
    }
    this.connectionWeakAt = now;
  }

  sendText(input: { text: string }): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || typeof input.text !== 'string' || !input.text.length || input.text.length > 4000) fail('invalid_request');
    if (!this.write(JSON.stringify({ type: 'response.item.create', event_id: this.commandId('cont'), item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.text }] } }))) fail(this.terminal!.code);
    this.write(JSON.stringify({ type: 'response.create', event_id: this.commandId('cont') }));
  }

  /** Speakable progress: the voice model paraphrases it aloud, so the owner hears that a lookup is still running.
   *  Documented shape (`session.commentary.append`, guides/live-delegation): plain-string `content` under 500
   *  tokens, and a null `delegation_id` under Responses delegation. */
  sendCommentary(input: { text: string }): void {
    this.append('session.commentary.append', 'cmt', input);
  }

  /** Silent context: the model may use it to answer a question about the lookup, and never speaks it on append. */
  sendThinking(input: { text: string }): void {
    this.append('session.thinking.append', 'thk', input);
  }

  private append(type: 'session.commentary.append' | 'session.thinking.append', kind: 'cmt' | 'thk', input: { text: string }): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    // The documented ceiling is 500 tokens per append; a short character bound keeps every line well under it.
    if (!object(input) || typeof input.text !== 'string' || !input.text.length || input.text.length > APPEND_CHAR_LIMIT) fail('invalid_request');
    if (!this.write(JSON.stringify({ type, event_id: this.commandId(kind), delegation_id: null, content: input.text }))) fail(this.terminal!.code);
  }

  endAudioStream(): void {
    // GPT-Live streams continuously and decides when to speak: the docs explicitly drop manual commits
    // ("remove manual audio commits and voice-turn triggers", guides/live-migration).
  }

  close(): void { if (this.checkpoint()) this.finish('closed'); }

  private finish(code: LiveVoiceErrorCode, upstream?: LiveVoiceUpstreamDrop) {
    if (this.terminal) return;
    const status = code === 'closed' ? 'closed' : code === 'cancelled' ? 'cancelled' : code === 'deadline' ? 'deadline' : 'failed';
    const providerSideFailure = this.isReady && code === 'protocol_error';
    this.terminal = Object.freeze({ status, code, ...(this.recoverable || code === 'transport_error' || providerSideFailure ? { recoverable: true } : {}), ...(upstream ? { upstream } : {}) });
    this.clearUploadBlock();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.signal.removeEventListener('abort', this.onAbort);
    this.clearInputEpisode(false);
    if (this.idleQuiet !== undefined) { this.clock.clearTimer(this.idleQuiet); this.idleQuiet = undefined; }
    // 3r B: a closed session retires its calls and delegations, so a late answer reaches no new one.
    this.retireCalls();
    this.discardHeadStart();
    this.reportPostFlush();
    this.reportUnknownFrames();
    this.secret = '';
    this.readiness.reject(new LiveVoiceError(code));
    this.emit({ type: 'outcome', outcome: this.terminal });
    if (!this.creatingSocket) this.shutdownSocket();
  }
  private shutdownSocket() {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) { this.cleanup(); return; }
    if (!this.closeTimer) this.closeTimer = setTimeout(() => { socket.terminate(); }, this.settings.limits.closeMs);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  }
  private cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const socket = this.socket;
    if (socket) {
      socket.off('message', this.onMessage);
      socket.off('close', this.onClose); socket.off('unexpected-response', this.onUnexpectedResponse);
      if (socket.readyState === WebSocket.CLOSED) socket.off('error', this.onError);
      else socket.once('close', () => socket.off('error', this.onError));
    }
    this.completion.resolve(this.terminal!);
  }
}
