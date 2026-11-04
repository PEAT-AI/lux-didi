
import { ALARM_MODE_MARKER } from '../../live/alarm-mode.js';
import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { JsonObject } from '../model/types.js';
import type { DataClass, LiveSocketFactory, LiveToolResponse, LiveToolSendOutcome, LiveVoiceAdapterOptions, LiveVoiceCapabilities, LiveVoiceClock, LiveVoiceControl, LiveVoiceDiagnostics, LiveVoiceErrorCode, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession, LiveVoiceUpstreamDrop } from './types.js';
import { LiveVoiceError, liveVoiceTimerDefaults } from './types.js';
import { Pcm16Upsampler } from './resample.js';
import { AUDIBLE_RMS_DBFS, pcm16RmsDbfs } from './audio-level.js';
import { redactSecrets } from '../../tools/redact.js';
import { hostLogEvent } from '../../tools/host-events.js';
import type { LiveTracePort } from '../../trace/record.js';

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
/** C-POSTTOOL switch b: a tighter brevity line for the same backend, so the response the voice model has to
 *  read is shorter. It changes the line only; no output token cap is set. */
export const OPENAI_BACKEND_BREVITY_TIGHT = 'Telegraphic facts, at most about 60 words; the voice model elaborates.';
/** S4a-R2 (d): the ledger keeps this many command ids, oldest dropped first. */
const COMMAND_LEDGER_LIMIT = 64;
export function openAiBackendInstructions(procedure?: string, tight = false): string {
  const brevity = tight ? OPENAI_BACKEND_BREVITY_TIGHT : OPENAI_BACKEND_BREVITY;
  const base = `${OPENAI_BACKEND_TEMPLATE}\n\n${brevity}`;
  return typeof procedure === 'string' && procedure.length ? `${base}\n\n${procedure}` : base;
}
export const OPENAI_TOOLS_SECTION = 'Tools: call one when the answer depends on the owner\'s world or on current data rather than on general knowledge.';
export const OPENAI_DELIVERY_SECTION = 'Delivery: confident and warm underneath, dry and a little edgy; never sugary or sing-song; keep the wit.';
/** OpenAI's live prompting guide, verbatim: the server owns turn taking, so a stray sound is not a new turn. */
const OPENAI_LISTENING_SECTION = 'Do not treat a cough, music, or nearby conversation as a new request.\nKeep listening while the owner pauses to think.';
/** The shared persona is sent unchanged; the wrapper only appends the provider sections. */
export function openAiInstructions(persona: string): string {
  return `${persona}\n\n${OPENAI_TOOLS_SECTION}\n\n${OPENAI_DELIVERY_SECTION}\n\n${OPENAI_LISTENING_SECTION}`;
}
/** Release 4: Naya opens every new call, seeded history or not, with one short dry and edgy line in her own voice. */
export const FRESH_OPENING = 'Speak one original opening line now. Do not acknowledge these directions. The line is twelve words at most, dry, a little edgy and specific to the moment. Its subject comes from an opening option or earlier conversation, in new words, never the closing lines or stopping, ending or listening. No greeting formula, offer of help, question list or tool call precedes it. Silence follows until the owner speaks; owner speech arriving first takes priority.';
/** Documented startup-history ceiling: 128 messages and 8,192 combined tokens (4 characters per token is the cap proxy). */
const SEED_MESSAGE_LIMIT = 128;
const SEED_CHAR_LIMIT = 8192 * 4;
/** C-RECONNECT #1072: a seeded open hands the new session this call's own transcript, so it is told whose words are
 *  whose before it reads them. Without the framing a rebuilt session narrates the owner in the third person ("he
 *  asked") instead of answering him, because a bare history reads as somebody else's conversation. */
export const SEED_FRAMING = 'The messages after this one are this call, already in progress. A user message is the owner speaking to you directly; an assistant message is your own earlier speech in this same call. Continue it as one conversation and address the owner as "you": never refer to the owner or to what was asked in the third person.';
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
/** Release 3: silence goes first, and one frame of every 200 ms of dropped silence stays queued as a heartbeat so
 *  the provider's silence timing still advances over the gap. */
const UPLINK_SILENCE_HEARTBEAT_MS = 200;
/** Release 3: the newest 500 ms of speech is never shed, so a pinned uplink costs the start of a sentence, never
 *  the end of it. */
const UPLINK_SPEECH_FLOOR_MS = 500;
/** 24 kHz mono PCM16, the rate the mic is upsampled to before the wire (OUTPUT_PCM_BYTES_PER_MS is the same). */
const MIC_PCM_BYTES_PER_MS = 48;
/** The shed receipt is bounded to one host.log record per window (3o). */
const UPLINK_SHED_RECEIPT_MS = 10_000;
/** W3: connection quality is the adapter's own read of the link, over the last three measured seconds. */
const CONNECTION_WINDOW_MS = 3_000;
/** Over a fifth of the captured mic bytes discarded in the window is a weak link (the owner's link: 25% loss). */
const CONNECTION_WEAK_SHARE = 0.2;
/** Five quiet seconds, with no discard and no pinned backlog, make it ok again. */
const CONNECTION_OK_MS = 5_000;
const QUEUE_LOG_BYTES = 64 * 1024;
const QUEUE_LOG_INTERVAL_MS = 1_000;
/** Turn taking: the owner's input episode ends after this much quiet on the input transcript. The episode closes
 *  the journal pair the host needs; it cuts nothing (ruling W1-R1). */
const INPUT_EPISODE_QUIET_MS = 700;
/** Audible silence: SPEAKING ends after this much output quiet with the local playback drained, and the 2000 ms
 *  presentation idle stays the semantic end of the turn. */
const OUTPUT_SILENCE_MS = 500;
/** Presentation idle: the spoken reply is over after this much quiet with the local playback drained. */
const TURN_IDLE_QUIET_MS = 2_000;
/** Forwarded output PCM is 24 kHz s16 mono, so the modelled native queue drains 48 bytes per millisecond. */
const OUTPUT_PCM_BYTES_PER_MS = 48;
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
/** C-LOG-ENVELOPE: the provider's own id shape, the same bound the transcription metadata already trusts. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
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
/** C-CONTINUITY R-08: a socket close reason as a receipt: no URL, no token, one line, bounded. */
function sanitizedCloseReason(reason: Buffer | string | undefined): string {
  if (reason === undefined) return '';
  return setupErrorText((Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason)).replace(/https?:\/\/\S+/giu, '[url]'));
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

interface Settings {
  modelId: string; voice: string; enabled: boolean; allowed: readonly DataClass[];
  keyReference: string; resolve: (reference: string) => Promise<string | undefined>;
  limits: Readonly<LiveVoiceLimits>; socketFactory: LiveSocketFactory;
  clock: LiveVoiceClock | undefined;
  firstResponseAudio: boolean; backendBrevityTight: boolean;
  /** O1b-A: the host's receipt door for this session and connection epoch. Absent, this adapter records nothing. */
  trace: LiveTracePort | undefined;
}
/** 3r F: what a provider error has to name before it counts as a speech cut, and the one rejection that means a
 *  response is still active (which is the retry the continuation gate is allowed). */
const SPEECH_CUT_ERROR = /moderation|content_filter|interrupt|barge|response_cancel|cancel/i;

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
      clock: options.clock,
      firstResponseAudio: options.firstResponseAudio === true, backendBrevityTight: options.backendBrevityTight === true,
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
    // C-RECOVERY (a): a history over the ceiling loses its oldest turns instead of refusing the open, so a long
    // call still reconnects. The shape and data class of every turn that is used are still enforced.
    const ceiling = Math.min(SEED_MESSAGE_LIMIT, settings.limits.maxHistoryTurns);
    const suppliedKept = supplied.length > ceiling ? supplied.slice(-ceiling) : supplied;
    const history = suppliedKept.map((turn): { role: 'user' | 'model'; text: string } => {
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
        delegation: { type: 'client' },
      },
    });
    if (Buffer.byteLength(start) > settings.limits.maxOutgoingBytes
      || Buffer.byteLength(JSON.stringify({ instructions, input: seed.items, tools })) > settings.limits.maxRequestBytes) fail('outgoing_limit');
    // Receipt, metadata only: the size of the instructions exactly as sent, so a log proves nothing was cut.
    hostLogEvent({ event: 'openai_instructions_size', chars: instructions.length, bytes: Buffer.byteLength(instructions) });
    if (!(control.signal instanceof AbortSignal) || !Number.isSafeInteger(control.deadlineMs)
      || control.deadlineMs <= 0 || control.deadlineMs - Date.now() > 2_147_483_647) fail('invalid_request');
    // #1022 D1: a recovery seed carries the pickup, which the provider never answers on its own, so the
    // session asks for that response once it is live. A normal connect seeds no pickup and asks for nothing.
    // Contract 1023 N3: a fresh model-first call owns no seeded line, so the start asks for the opener itself.
    return new Session(settings, start, control.signal, control.deadlineMs, control.idleResetMs ?? settings.limits.idleMs,
      request.openingText !== undefined, request.openingText === undefined && request.opening === 'model_first');
  }

  /**
   * Startup history as the documented `session.input` items, then the opening line. Seeding belongs to
   * `session.start` on this provider: the docs ask for the greeting message to be "included in the
   * session.start event instead of waiting until session.started" (guides/live-conversations).
   */
  private seed(history: readonly { role: 'user' | 'model'; text: string }[], request: LiveVoiceRequest): { items: JsonObject[]; characters: number } {
    const items: JsonObject[] = [];
    let characters = 0;
    const freshOpening = request.openingText === undefined && request.opening === 'model_first' && !request.system.text.includes(ALARM_MODE_MARKER);
    // C-RECOVERY (a): the seed plus every line appended after it stays inside both provider ceilings. The oldest
    // turns go first and the newest turn is condensed, so a 300-fragment call opens instead of being refused.
    const appendedChars = request.openingText !== undefined ? request.openingText.length : freshOpening ? FRESH_OPENING.length : 0;
    // C-RECONNECT #1072: a seeded open carries the framing item first, so it costs one of the documented 128 slots.
    const framed = history.length > 0;
    const room = Math.max(1, SEED_MESSAGE_LIMIT - (appendedChars > 0 ? 1 : 0) - (framed ? 1 : 0));
    let kept = history.slice(Math.max(0, history.length - room));
    const totalOf = (turns: readonly { text: string }[]): number => turns.reduce((sum, turn) => sum + turn.text.length, 0) + appendedChars;
    // The framing is part of the same budget, so the trim reserves it instead of letting a seed that fills the ceiling
    // take it over and be refused at the open.
    const budget = SEED_CHAR_LIMIT - (framed ? SEED_FRAMING.length : 0);
    while (kept.length > 1 && totalOf(kept) > budget) kept = kept.slice(1);
    if (kept.length > 0 && totalOf(kept) > budget) {
      const last = kept[kept.length - 1]!;
      const roomLeft = Math.max(0, budget - (totalOf(kept) - last.text.length));
      const keep = Math.max(roomLeft - 3, 0);
      kept = [...kept.slice(0, -1), { ...last, text: keep > 0 ? `...${last.text.slice(last.text.length - keep)}` : '...' }];
    }
    if (framed) {
      characters += SEED_FRAMING.length;
      items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: SEED_FRAMING }] });
    }
    for (const turn of kept) {
      characters += turn.text.length;
      items.push({ type: 'message', role: turn.role === 'model' ? 'assistant' : 'user',
        content: [{ type: turn.role === 'model' ? 'output_text' : 'input_text', text: turn.text }] });
    }
    if (request.openingText !== undefined) {
      characters += request.openingText.length;
      items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.openingText }] });
    } else if (freshOpening) {
      characters += FRESH_OPENING.length;
      items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: FRESH_OPENING }] });
    }
    if (items.length > SEED_MESSAGE_LIMIT) fail('invalid_request');
    return { items, characters };
  }
}

class Session implements LiveVoiceSession {
  private latestDelegationId: string | undefined;
  private readonly commentaryCommands = new Map<string, string | null>();
  private readonly readiness = deferred<void>();
  private readonly completion = deferred<LiveVoiceOutcome>();
  readonly ready = this.readiness.promise;
  readonly done = this.completion.promise;
  readonly events: AsyncIterable<LiveVoiceEvent>;
  private socket: WebSocket | undefined;
  private terminal: LiveVoiceOutcome | undefined;
  /** C-LOG-ENVELOPE: the provider's own ids for this turn, ids only, so host.log joins the turn. */
  private lastItemId: string | undefined;
  private lastEventId: string | undefined;
  private isReady = false;
  private draining = false;
  private recoverable = false;
  private readonly startedAt = Date.now();
  private upstreamDrop: LiveVoiceUpstreamDrop | undefined;
  private lastInboundAt = Date.now();
  /** Mic frames queued behind a backed-up socket, oldest first: shed from the front (3o). */
  private micPending: { frame: string; bytes: number; speech: boolean }[] = [];
  private micPendingBytes = 0;
  private shedBytes = 0;
  private shedPeak = 0;
  private shedRuns = 0;
  private notOpenBytes = 0;
  /** Release 3: the shed split, in audio milliseconds and frame bytes. `lostMs` is the shed path only; frames lost
   *  with the socket not open stay in `notOpenBytes`. */
  private lostMs = 0;
  private speechShedMs = 0;
  private silenceShedMs = 0;
  private speechShedBytes = 0;
  private silenceShedBytes = 0;
  private shedReportedAt: number | undefined;
  /** One uplink sample per mic flush (W3): what the interval captured, what it discarded, and the bytes the
   *  socket took out of its buffer. Quality and the drain rate are read from these, never from delivery. */
  private uplinkSamples: { at: number; captured: number; discarded: number; accepted: number; backlogged: boolean }[] = [];
  private sampleCaptured = 0;
  private sampleDiscarded = 0;
  private lastBuffered = 0;
  private lastBufferedAt: number | undefined;
  private connectionQuality: 'ok' | 'weak' = 'ok';
  /** The last sample that carried a discard or a pinned backlog: the five quiet seconds are counted from it. */
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
  /** #451: the wall clock the handshake started at, so every step reports a monotonic offset. */
  private handshakeStart = 0;
  private upstreamStallQueued = false;
  private sequence = 0;
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
  /** Generation counter: bumped by every interruption and every new backend response. */
  private generation = 0;
  /** The generation the owner cut off; its remaining audio deltas are dropped until a new response starts. */
  private muted = -1;
  private userTranscriptOpen = false;
  private outputTranscriptOpen = false;
  /** The input episode's quiet timer and its token, which is what a lone journal pair of the owner's turn needs. */
  private episodeQuiet: unknown;
  private episodeToken = 0;
  /** F10: what the owner has said so far in this episode, which decides whether the tail is a finished sentence. */
  private episodeWords = '';
  /** LAT-1022: whether the quiet rule that ended the last input episode was the hesitation one, so the end-of-
   *  speech line names the rule that actually fired instead of the default. */
  private readonly unknownFrames = new Map<string, number>();
  /** Presentation idle: the modelled native playback queue, the last forwarded delta and its idle timer. */
  private playbackUntil = 0;
  private lastForwardedAt = 0;
  private audioSinceCompletion = false;
  private idleQuiet: unknown;
  /** The response this turn is answering, for the receipts that name it (S5). */
  private currentResponse: string | undefined;
  private continuationTiming: { toolOutputAt: number; createAt: number; createdAt: number | null; firstItemAt: number | null; firstAudioAt: number | null; toolCall: boolean; nudged: boolean } | undefined;
  private commandSequence = 0;
  /** S4a-R2 (d): event id to the command it identified. Correlation only. */
  private readonly commands = new Map<string, { kind: CommandKind; sentAt: number; epoch: number }>();
  /** Audible silence of the current speaking stretch: its timer and whether its receipt was already sent. */
  private outputSilence: unknown;
  private silenceSent = false;
  /** A speaking stretch is open between its first delta and its completion, provider error or close. */
  private stretchOpen = false;
  private holding = false;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  /** The part of `heldBytes` that can be heard: fill frames are held for ordering, never counted (3r D2). */
  private heldAudibleBytes = 0;
  private headStartTimer: unknown;
  private readonly clock: LiveVoiceClock;
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
    private readonly signal: AbortSignal, private readonly deadlineMs: number, private readonly idleResetMs: number,
    _answerOnReady = false, _openerOnReady = false) {
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
    this.handshakeStart = Date.now();
    const step = (name: 'credential_resolved' | 'socket_open' | 'session_start_sent' | 'session_started'): void => {
      hostLogEvent({ event: 'live_handshake', step: name, ms: Math.max(0, Date.now() - this.handshakeStart) });
    };
    let key: string | undefined;
    try { if (!this.checkpoint()) return; key = await this.settings.resolve(this.settings.keyReference); }
    catch { if (this.checkpoint()) this.finish('credential_unavailable'); return; }
    if (!this.checkpoint()) return;
    if (typeof key !== 'string' || !key.trim() || key.length > 8192) { this.finish('credential_unavailable'); return; }

    step('credential_resolved');
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
      socket.once('open', () => { if (this.checkpoint()) { step('socket_open'); this.write(this.start); step('session_start_sent'); } });
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
  private readonly onClose = (code: number, reason?: Buffer | string) => {
    const closeReason = sanitizedCloseReason(reason);
    if (this.upstreamDrop) this.upstreamDrop = { ...this.upstreamDrop,
      closeCode: this.upstreamDrop.closeCode ?? code,
      closeReason: this.upstreamDrop.closeReason === '' ? closeReason : this.upstreamDrop.closeReason };
    if (this.terminal) { this.cleanup(); return; }
    // A close before the start barrier is a failed setup; after it, a recoverable drop.
    this.recoverable = this.isReady;
    // C-CONTINUITY R-08: every provider socket close leaves its code and sanitized reason on the outcome, so the
    // next rebuild or recovery line can say how the session really ended instead of guessing at the network.
    const close: LiveVoiceUpstreamDrop = this.upstreamDrop ?? { errorKind: 'remote_close', closeCode: code, closeReason,
      bufferedAmount: 0, writesFailed: this.diagnostic.localWriteCallbackErrorCalls, sessionMs: Math.max(0, Date.now() - this.startedAt) };
    this.finish(this.isReady ? 'remote_closed' : 'provider_setup_rejected', close);
  };

  private dropUpstream(errorKind: string, socket: WebSocket): void {
    if (this.terminal) return;
    const errorKindValue = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorKind) ? errorKind : 'write_error';
    this.upstreamDrop = { errorKind: errorKindValue, closeCode: null, closeReason: '', bufferedAmount: socket.bufferedAmount, writesFailed: this.diagnostic.localWriteCallbackErrorCalls, sessionMs: Math.max(0, Date.now() - this.startedAt) };
    this.recoverable = true;
    this.finish('transport_error', this.upstreamDrop);
  }
  private clearUploadBlock(): void {
    this.uploadBlockedSince = undefined;
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
    // #475: a new low is not progress. A slow drain above the low-water mark refreshes a per-sample deadline
    // forever, which is why the 30 s window could never fire on the measured stall; only a buffer that drains
    // out of the blocked band counts as progress, and that leaves this branch through clearUploadBlock.
    if (this.micPending.length && buffered >= UPLINK_SHED_BYTES) {
      if (this.uploadBlockedSince === undefined) this.uploadBlockedSince = now;
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

      // 3r D4: the provider opening a delegation. Unread until now, so it landed in the unknown-frame counter.
      case 'session.delegation.created': return this.delegationCreated(message);
      // #438: the provider acknowledges an append in the past tense; an unknown frame is a fact of its own and
      // these are known, so they are classified instead of counted as one.

      case 'session.commentary.appended': return this.appendAcknowledged('commentary', message);
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
    hostLogEvent({ event: 'live_handshake', step: 'session_started', ms: Math.max(0, Date.now() - this.handshakeStart) });
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
    this.diagnostic.outputAudioFrames += 1;
    this.diagnostic.outputAudioPCMBytes += pcm.byteLength;
    // Contract invariant (ruling W1-R1): output audio is never dropped. An input transcript never silences the
    // assistant and no gap in the provider's stream cuts her, so every frame is forwarded or held in order.
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
      if (this.continuationTiming && this.continuationTiming.firstAudioAt === null) {
        this.continuationTiming.firstAudioAt = this.clock.now();
      }
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
  }

  private inputTranscript(message: ObjectValue): void {
    if (typeof message.delta !== 'string') fail('protocol_error');
    if (!message.delta.length) return;
    // Ruling GL1-R1: a whitespace-only fragment is still journaled below, but it carries no word, so it starts no
    // episode, takes no word and never touches the barge-in latch.
    // Ruling GL1-R1: a whitespace-only fragment is still journaled, and it starts no episode.
    if (message.delta.trim().length) {
      // F10: the episode's own words decide the quiet window, so they are kept as they arrive.
      this.episodeWords = `${this.episodeWords} ${message.delta}`.trim().slice(-240);
      this.noteInput();
    }
    this.userTranscriptOpen = true;
    if (typeof message.event_id === 'string' && PROVIDER_ID.test(message.event_id)) this.lastEventId = message.event_id;
    this.diagnostic.inputTranscriptionEvents += 1;
    this.diagnostic.inputTranscriptionCharacters += message.delta.length;
    this.emit({ type: 'inputTranscription', text: message.delta, finished: false, ...transcriptMetadata(message) });
    this.touch();
  }

  /**
   * An input episode is the owner's run of input transcript deltas; it ends after INPUT_EPISODE_QUIET_MS of quiet,
   * which is what closes the journal pair the host needs on a plain turn. It cuts nothing: the provider stops
   * generating on real speech by itself (lux 90233) and queued audio plays out (ruling W1-R1).
   */
  private noteInput(): void {
    // Reset on the first real owner fragment, not its quiet tail: a fast provider may start before that tail.
    if (this.episodeQuiet === undefined) {
      this.continuationTiming = undefined;
    }
    if (this.episodeQuiet !== undefined) this.clock.clearTimer(this.episodeQuiet);
    const token = this.episodeToken + 1, epoch = this.socket;
    this.episodeToken = token;
    const quiet = INPUT_EPISODE_QUIET_MS;
    this.episodeQuiet = this.clock.setTimer(quiet, () => {
      if (this.terminal || token !== this.episodeToken || epoch !== this.socket) return;
      this.endInputEpisode();
    });
  }

  private endInputEpisode(): void {
    this.episodeQuiet = undefined;
    this.episodeWords = '';
    // LAT-1022: this is the capture path's own voice-activity verdict that the owner has stopped speaking, so it
    // is stamped here, on the monotonic audio clock and on the wall clock beside it. The session and the turn are
    // the envelope's; the rule that fired is the only other field.
    hostLogEvent({ event: 'owner_speech_end', monoMs: Math.max(0, Math.round(this.clock.now())), wallMs: Date.now(),
      reason: 'quiet' });
    this.ownerTurnEnded();
  }

  /** A new response, a cut or a closed session retires the pending episode, so its quiet timer cannot fire later. */
  private clearInputEpisode(): void {
    this.episodeToken += 1;
    this.episodeWords = '';
    if (this.episodeQuiet !== undefined) { this.clock.clearTimer(this.episodeQuiet); this.episodeQuiet = undefined; }
  }

  /**
   * The owner's episode is over with no assistant audio playing or held, so what comes next is her think time.
   * gpt-live-1 sends no generation-start event on a plain turn, so the adapter synthesizes the pair the host
   * needs: the final input transcript and a model turn start, which is what enters THINKING and resets the turn's
   * completion flag (arming the response watchdog). It cuts nothing (ruling W1-R1).
   */
  private ownerTurnEnded(): void {
    if (this.terminal) return;
    const now = this.clock.now();
    this.endTurnTranscripts();
    if (this.heldAudibleBytes > 0 || this.playbackUntil > now) {
      const token = this.episodeToken, epoch = this.socket;
      this.episodeQuiet = this.clock.setTimer(Math.max(1, this.heldAudibleBytes > 0 ? 100 : this.playbackUntil - now), () => {
        if (this.terminal || token !== this.episodeToken || epoch !== this.socket) return;
        this.endInputEpisode();
      });
      return;
    }
    // Plain owner-end notices have no provider response id: currentResponse may belong to an old delegation.
    this.emit({ type: 'modelTurnStarted' });
    this.touch();
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
    if (this.holding || !this.audioSinceCompletion) return;
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
    hostLogEvent({ event: 'gptlive_turn_complete', idleMs, drained: true, ...this.providerIds() });
    hostLogEvent({ event: 'playback_rearm', count: this.playbackRearms });
    this.playbackRearms = 0;
    this.touch();
  }

  /** The provider ids this turn already carries: response, output item and the last frame's own id. */
  private providerIds(): { responseId?: string; itemId?: string; eventId?: string } {
    return {
      ...(this.currentResponse === undefined ? {} : { responseId: this.currentResponse }),
      ...(this.lastItemId === undefined ? {} : { itemId: this.lastItemId }),
      ...(this.lastEventId === undefined ? {} : { eventId: this.lastEventId }),
    };
  }

  private outputTranscript(message: ObjectValue): void {
    if (typeof message.delta !== 'string') fail('protocol_error');
    // Transcripts are never dropped: the host journals what was actually spoken.
    if (typeof message.event_id === 'string' && PROVIDER_ID.test(message.event_id)) this.lastEventId = message.event_id;
    if (message.delta.length) {
      this.outputTranscriptOpen = true;
      this.emit({ type: 'outputTranscription', text: message.delta, finished: false, ...transcriptMetadata(message) });
    }
    this.touch();
  }

  private endTurnTranscripts(finalOrigin: 'app_quiet' | 'app_model_start' = 'app_quiet'): void {
    if (!this.userTranscriptOpen) return;
    this.userTranscriptOpen = false;
    this.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin });
  }
  private delegationCreated(message: ObjectValue): void {
    const delegation = object(message.delegation) ? message.delegation : message;
    if (typeof delegation.id !== 'string' || !delegation.id.length) { this.touch(); return; }
    this.latestDelegationId = delegation.id;
    this.emit({ type: 'delegation', delegationId: delegation.id }); this.touch();
  }
  private providerError(message: ObjectValue): void {
    const error = object(message.error) ? message.error : {};
    const type = typeof error.type === 'string' ? error.type : 'unknown';
    const errorCode = typeof error.code === 'string' ? error.code : 'none';
    const param = typeof error.param === 'string' ? error.param : 'none';
    hostLogEvent({ event: 'live_provider_error', type, code: errorCode, param });
    const commandId = typeof error.client_event_id === 'string' ? error.client_event_id : undefined;
    if (commandId && this.commentaryCommands.has(commandId)) {
      this.commentaryCommands.delete(commandId); this.emit({ type: 'commentaryRejected', commandId });
      hostLogEvent({ event: 'command_rejected', code: errorCode, param, kind: 'cmt' }); this.touch(); return;
    }
    const disposition = dispositionOf(type, errorCode);
    if (disposition === 'command_rejected') { hostLogEvent({ event: 'command_rejected', code: errorCode, param, kind: 'other' }); this.touch(); return; }
    if ((disposition === 'moderation' || SPEECH_CUT_ERROR.test(type + ' ' + errorCode)) && this.generation !== this.muted) {
      this.clearInputEpisode(); this.generation += 1; this.muted = this.generation;
      this.playbackUntil = this.clock.now(); this.discardHeadStart(); this.audioSinceCompletion = false;
      this.emit({ type: 'interrupted' });
    } else hostLogEvent({ event: 'provider_error_unclassified', type, code: errorCode, param });
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
  sendToolResponse(_input: { responses: LiveToolResponse[] }): LiveToolSendOutcome { return 'failed'; }

  /** One client command id, so a provider error frame can be tied to the command that earned it (3r F, S4a-R4).
   *  The prefix names the command family: a rejected `tool_out_` answer is not the same event as a rejected
   *  `response.create`. */
  private commandId(kind: 'cont' | 'cmt' | 'thk'): string {
    this.commandSequence += 1;
    const id = `${kind}_${this.commandSequence}`;
    this.recordCommand(id, kind);
    return id;
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
    this.micPending.push({ frame, bytes: pcm.byteLength, speech: pcm16RmsDbfs(pcm) >= AUDIBLE_RMS_DBFS });
    this.micPendingBytes += Buffer.byteLength(frame);
    this.sampleCaptured += Buffer.byteLength(frame);
    if (!this.flushMic()) fail(this.terminal?.code ?? 'not_ready');
  }

  /**
   * Send what the uplink can take and shed the rest (3o). The capture path never waits: the queue is bounded by
   * UPLINK_SHED_BYTES plus one frame. Release 3: silence goes first, one frame per 200 ms of it stays as a
   * heartbeat, then the oldest speech goes as one contiguous run.
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
        // Release 3: silence goes first, then the oldest speech as one run. Both steps drop whole frames, so the
        // stretch that stays is consecutive and the model hears runs, never 20 ms islands.
        this.shedMicPending();
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
        drainBytesPerSec: this.drainBytesPerSec, notOpenBytes: this.notOpenBytes,
        lostMs: Math.round(this.lostMs), speechShedMs: Math.round(this.speechShedMs),
        silenceShedMs: Math.round(this.silenceShedMs), speechShedBytes: this.speechShedBytes,
        silenceShedBytes: this.silenceShedBytes });
      this.shedBytes = 0; this.shedPeak = 0; this.shedRuns = 0; this.notOpenBytes = 0;
      this.lostMs = 0; this.speechShedMs = 0; this.silenceShedMs = 0; this.speechShedBytes = 0; this.silenceShedBytes = 0;
    }
    return !this.terminal;
  }

  /**
   * Release 3 shed, in two passes over the queue and no allocation beyond the kept list. Silence goes first, with
   * one frame per 200 ms of dropped silence kept so the provider's timing advances. If the queue is still over
   * the bound, the oldest speech goes as one contiguous run; the newest 500 ms of speech is never touched.
   */
  private speechLossNoted = false;

  private shedMicPending(): void {
    const speechBefore = this.speechShedMs;
    const before = this.micPending.length;
    const afterSilence: { frame: string; bytes: number; speech: boolean }[] = [];
    let droppedSinceHeartbeatMs = 0;
    for (const entry of this.micPending) {
      if (entry.speech) { afterSilence.push(entry); continue; }
      const ms = entry.bytes / MIC_PCM_BYTES_PER_MS;
      if (droppedSinceHeartbeatMs + ms < UPLINK_SILENCE_HEARTBEAT_MS) {
        this.shedMicFrame(entry, false);
        droppedSinceHeartbeatMs += ms;
        continue;
      }
      droppedSinceHeartbeatMs = 0;
      afterSilence.push(entry);
    }
    let pendingWireBytes = afterSilence.reduce((sum, entry) => sum + Buffer.byteLength(entry.frame), 0);
    if (pendingWireBytes > UPLINK_SHED_BYTES) {
      for (let index = 0; index < afterSilence.length;) {
        const entry = afterSilence[index]!;
        if (entry.speech) { index += 1; continue; }
        this.shedMicFrame(entry, false);
        pendingWireBytes -= Buffer.byteLength(entry.frame);
        afterSilence.splice(index, 1);
      }
    }
    let floorMs = 0;
    let protectedSpeech = 0;
    for (let index = afterSilence.length - 1; index >= 0 && floorMs < UPLINK_SPEECH_FLOOR_MS; index -= 1) {
      const entry = afterSilence[index]!;
      if (!entry.speech) continue;
      protectedSpeech += 1;
      floorMs += entry.bytes / MIC_PCM_BYTES_PER_MS;
    }
    let remaining = afterSilence.reduce((sum, entry) => sum + Buffer.byteLength(entry.frame), 0);
    // One contiguous run down to the floor, never the frame or two that would leave 20 ms islands: what stays on
    // the wire after a shed is a run of consecutive speech, which is what the model can hear as words.
    let toShed = remaining > UPLINK_SHED_BYTES ? Math.max(0, afterSilence.filter(entry => entry.speech).length - protectedSpeech) : 0;
    // Sample the queue at the decision, not after it drains: the receipt proves silence-first ordering.
    const silenceFramesBeforeSpeechShed = afterSilence.filter(entry => !entry.speech).length;
    const kept: typeof afterSilence = [];
    for (const entry of afterSilence) {
      if (toShed > 0 && entry.speech) { this.shedMicFrame(entry, true); remaining -= Buffer.byteLength(entry.frame); toShed -= 1; continue; }
      kept.push(entry);
    }
    this.micPending = kept;
    this.micPendingBytes = remaining;
    if (kept.length < before) this.shedRuns += 1;
    if (this.speechShedMs > speechBefore && !this.speechLossNoted) {
      this.speechLossNoted = true;
      this.markUplinkLoss(this.clock.now());
      hostLogEvent({ event: 'uplink_speech_shed', ms: Math.round(this.speechShedMs - speechBefore), silenceFramesBeforeSpeechShed });
      // The existing host-note carrier is a user message. Do not request an extra response mid capture.
      this.write(JSON.stringify({ type: 'response.item.create', event_id: this.commandId('cont'), item: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: '[host note: Part of the owner’s last sentence was lost on a weak connection. Do not answer the truncated question; ask him to repeat the end.]' }],
      } }));
    }
  }

  /** Count one shed frame in its own half of the split: audio milliseconds and wire bytes, counts only. */
  private shedMicFrame(entry: { frame: string; bytes: number }, speech: boolean): void {
    const bytes = Buffer.byteLength(entry.frame);
    const ms = entry.bytes / MIC_PCM_BYTES_PER_MS;
    this.shedBytes += bytes;
    this.sampleDiscarded += bytes;
    this.lostMs += ms;
    if (speech) { this.speechShedMs += ms; this.speechShedBytes += bytes; return; }
    this.silenceShedMs += ms; this.silenceShedBytes += bytes;
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
    while (samples.length && samples[0]!.at < now - CONNECTION_WINDOW_MS) samples.shift();
    const oldest = samples[0]?.at;
    let captured = 0, discarded = 0, accepted = 0, pinned = samples.length > 0;
    for (const sample of samples) {
      captured += sample.captured; discarded += sample.discarded; accepted += sample.accepted;
      if (!sample.backlogged) pinned = false;
    }
    const span = Math.max(1, now - (oldest ?? now));
    this.drainBytesPerSec = Math.round(accepted * 1_000 / span);
    // Both arms need a whole window: one lost frame in a half-filled window is a 100% share and would make the
    // caption cry wolf on the first reconnect of a healthy call.
    const covered = oldest !== undefined && now - oldest >= CONNECTION_WINDOW_MS;
    for (const sample of samples) if (sample.discarded > 0 || sample.backlogged) this.lastUplinkLossAt = sample.at;
    if (covered && captured > 0 && discarded / captured > CONNECTION_WEAK_SHARE) this.markUplinkLoss(now);
    else if (covered && pinned) this.markUplinkLoss(now);
    else if (this.connectionQuality === 'weak' && (this.lastUplinkLossAt === undefined || now - this.lastUplinkLossAt >= CONNECTION_OK_MS)) {
      this.connectionQuality = 'ok';
      this.speechLossNoted = false;
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
  sendText(_input: { text: string }): void { fail('invalid_request'); }
  sendCommentary(input: { text: string }): boolean {
    return this.latestDelegationId !== undefined && this.sendTaskAnswer({ ...input, delegationId: this.latestDelegationId }) !== undefined;
  }
  sendTaskAnswer(input: { text: string; delegationId: string | null }): string | undefined {
    if (this.draining || this.terminal || !this.isReady || input.delegationId !== (this.latestDelegationId ?? null)) return undefined;
    if (!input.text.length || input.text.length > 450) return undefined;
    const commandId = this.commandId('cmt');
    if (!this.write(JSON.stringify({ type: 'session.commentary.append', event_id: commandId, delegation_id: input.delegationId, content: input.text }))) return undefined;
    this.commentaryCommands.set(commandId, input.delegationId);
    return commandId;
  }
  private appendAcknowledged(_kind: 'thinking' | 'commentary', message: ObjectValue): void {
    const commandId = typeof message.client_event_id === 'string' ? message.client_event_id : this.commentaryCommands.keys().next().value;
    if (commandId && this.commentaryCommands.has(commandId)) {
      this.commentaryCommands.delete(commandId); this.emit({ type: 'commentaryAccepted', commandId });
    }
    hostLogEvent({ event: 'gptlive_append_ack', kind: 'commentary' }); this.touch();
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
    this.discardHeadStart();
    // gpt-live-1 owns barge-in and has no cancel/truncate command: cancel is a no-op, stop purges playback and closes.
    this.clearUploadBlock();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.signal.removeEventListener('abort', this.onAbort);
    this.clearInputEpisode();
    if (this.idleQuiet !== undefined) { this.clock.clearTimer(this.idleQuiet); this.idleQuiet = undefined; }
    // A closed session has no speaking stretch: no silence check is still owed to the turn it was in.
    if (this.outputSilence !== undefined) { this.clock.clearTimer(this.outputSilence); this.outputSilence = undefined; }
    this.reportUnknownFrames();

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
