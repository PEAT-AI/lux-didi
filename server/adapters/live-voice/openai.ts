import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { JsonObject } from '../model/types.js';
import type { DataClass, LiveSocketFactory, LiveToolCall, LiveToolResponse, LiveVoiceAdapterOptions, LiveVoiceCapabilities, LiveVoiceClock, LiveVoiceControl, LiveVoiceDiagnostics, LiveVoiceErrorCode, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession, LiveVoiceUpstreamDrop } from './types.js';
import { LiveVoiceError, liveVoiceTimerDefaults } from './types.js';
import { Pcm16Upsampler } from './resample.js';

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
const BACKEND_MODEL = 'gpt-6-luna';
/** Documentation default and quality voice ("The default is marin", guides/live-conversations). */
export const OPENAI_DEFAULT_VOICE = 'marin';
/** `nira` is the documented Hindi voice (guides/live-conversations voice table), which the Language section forbids. */
const REFUSED_VOICES: readonly string[] = ['nira'];
export const OPENAI_LANGUAGE_SECTION = 'Language: speak English with a natural Indian English accent and rhythm throughout the conversation, including after every tool result. Never switch to Hindi unless the owner speaks Hindi first.';
export const OPENAI_TOOLS_SECTION = 'Tools: before a lookup, say one short natural line that you are checking; never go silent for more than a few seconds.';
export const OPENAI_DELIVERY_SECTION = 'Delivery: sound like a quick, sharp young woman: confident, dry and a little edgy, never sugary or sing-song; keep the wit.';
/** OpenAI's live prompting guide, verbatim: the server owns turn taking, so a stray sound is not a new turn. */
const OPENAI_LISTENING_SECTION = 'Do not treat a cough, music, or nearby conversation as a new request.\nKeep listening while the owner pauses to think.';
/** The shared persona is sent unchanged; the wrapper only appends the provider sections. */
export function openAiInstructions(persona: string): string {
  return `${persona}\n\n${OPENAI_LANGUAGE_SECTION}\n\n${OPENAI_TOOLS_SECTION}\n\n${OPENAI_DELIVERY_SECTION}\n\n${OPENAI_LISTENING_SECTION}`;
}
const FRESH_OPENING = 'Open the conversation now with one fresh, specific line.';
/** Documented startup-history ceiling: 128 messages and 8,192 combined tokens (4 characters per token is the cap proxy). */
const SEED_MESSAGE_LIMIT = 128;
const SEED_CHAR_LIMIT = 8192 * 4;
const PING_INTERVAL_MS = 5_000;
const PING_MISSED_LIMIT = 2;
const STALL_QUEUE_BYTES = 128 * 1024;
const STALL_DRAIN_FLOOR_BYTES = 64 * 1024;
const STALL_QUIET_MS = 2_000;
const STALL_DRAIN_QUIET_MS = 5_000;
const QUEUE_LOG_BYTES = 64 * 1024;
const QUEUE_LOG_INTERVAL_MS = 1_000;
/** Turn taking: the owner's input episode ends after this much quiet on the input transcript. */
const INPUT_EPISODE_QUIET_MS = 700;
/** Presentation idle: the spoken reply is over after this much quiet with the local playback drained. */
const TURN_IDLE_QUIET_MS = 2_000;
/** Forwarded output PCM is 24 kHz s16 mono, so the modelled native queue drains 48 bytes per millisecond. */
const OUTPUT_PCM_BYTES_PER_MS = 48;
/** The production clock: the adapter's own windows go through it so a test can drive them without sleeping. */
const REAL_CLOCK: LiveVoiceClock = {
  now: () => Date.now(),
  setTimer: (ms, fire) => setTimeout(fire, ms),
  clearTimer: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
const DEFAULTS: Readonly<LiveVoiceLimits> = Object.freeze({
  maxIncomingBytes: 1024 * 1024, maxOutgoingBytes: 1024 * 1024, maxBufferedBytes: 2 * 1024 * 1024, upstreamStallMs: 400,
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
/** Words in the assembled input transcript of one episode: punctuation-only and empty text count zero. */
function countWords(text: string): number { return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length; }
function fail(code: LiveVoiceErrorCode): never { throw new LiveVoiceError(code); }
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
    if (typeof voice !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(voice) || REFUSED_VOICES.includes(voice)) fail('invalid_settings');
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
    });
  }

  open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
    if (!object(control)) fail('invalid_request');
    const settings = { ...this.settings, limits: { ...this.settings.limits, ...control.limits } };
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
        audio: { format: { type: 'audio/pcm', rate: 24_000 }, output: { voice: settings.voice } },
        ...(seed.items.length ? { input: seed.items } : {}),
        delegation: { type: 'responses', responses: { model: BACKEND_MODEL, ...(tools?.length ? { tools } : {}), tool_choice: 'auto' } },
      },
    });
    if (Buffer.byteLength(start) > settings.limits.maxOutgoingBytes
      || Buffer.byteLength(JSON.stringify({ instructions, input: seed.items, tools })) > settings.limits.maxRequestBytes) fail('outgoing_limit');
    // Receipt, metadata only: the size of the instructions exactly as sent, so a log proves nothing was cut.
    console.error(JSON.stringify({ event: 'openai_instructions_size', chars: instructions.length, bytes: Buffer.byteLength(instructions) }));
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
  private stalledSince: number | undefined;
  private queueStalledSince: number | undefined;
  private lastDrainAt = Date.now();
  private awaitingPong = false;
  private missedPongs = 0;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastQueueLogAt: number | undefined;
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
  /** Generation counter: bumped by every interruption and every new backend response. */
  private generation = 0;
  /** The generation the owner cut off; its remaining audio deltas are dropped until a new response starts. */
  private muted = -1;
  private ownerTurnedAfterInterruption = false;
  private userTranscriptOpen = false;
  private outputTranscriptOpen = false;
  /** The owner's assembled input episode, the once-per-episode barge-in latch and its quiet timer. */
  private inputEpisode = '';
  private flushed = false;
  private episodeQuiet: unknown;
  /** Presentation idle: the modelled native playback queue, the last forwarded delta and its idle timer. */
  private playbackUntil = 0;
  private lastForwardedAt = 0;
  private audioSinceCompletion = false;
  private idleQuiet: unknown;
  /** True between a delegated `response.created` and its `response.done`. */
  private delegatedOutstanding = false;
  /** Forwarded playback milliseconds since the last barge-in, reported as the post-flush receipt. */
  private postFlushMs: number | undefined;
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
  readonly diagnostics = (): Readonly<LiveVoiceDiagnostics> => Object.freeze({ ...this.diagnostic });

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
      if (this.awaitingPong) {
        this.missedPongs += 1;
        if (this.missedPongs >= PING_MISSED_LIMIT) { this.dropUpstream('no_pong', socket); return; }
      }
      this.awaitingPong = true;
      this.schedulePing(socket);
    }, PING_INTERVAL_MS);
    this.timers.add(this.pingTimer);
  }
  private readonly onPong = () => { this.awaitingPong = false; this.missedPongs = 0; };
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
  private watchUpstreamStall(socket: WebSocket): void {
    if (this.terminal || socket !== this.socket) return;
    const now = Date.now();
    const buffered = socket.bufferedAmount;
    const half = Math.max(1, Math.floor(this.settings.limits.maxBufferedBytes / 2));
    const drop = (errorKind: string) => queueMicrotask(() => { if (socket === this.socket) this.dropUpstream(errorKind, socket); });
    if (buffered > half) {
      if (this.stalledSince === undefined) this.stalledSince = now;
      else if (now - this.stalledSince >= this.settings.limits.upstreamStallMs) { drop('stalled'); return; }
    } else this.stalledSince = undefined;
    if (buffered > STALL_QUEUE_BYTES) {
      if (this.queueStalledSince === undefined) this.queueStalledSince = now;
      else if (now - this.queueStalledSince >= STALL_QUIET_MS) { drop('queue_stalled'); return; }
    } else this.queueStalledSince = undefined;
    if (buffered > STALL_DRAIN_FLOOR_BYTES && now - this.lastDrainAt >= STALL_DRAIN_QUIET_MS) { drop('no_drain'); return; }
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
    this.lastDrainAt = Date.now();
    // Every provider frame is untrusted: a shape refusal becomes a typed outcome, never an uncaught throw.
    try { this.dispatch(message); } catch { this.finish('protocol_error'); }
  };

  private dispatch(message: ObjectValue): void {
    if (!this.isReady && message.type !== 'session.started') {
      // Only the start barrier may precede readiness; an error frame here is a refused setup.
      if (message.type === 'error') { this.finish('provider_setup_rejected'); return; }
      this.finish('protocol_error'); return;
    }
    switch (message.type) {
      case 'session.started': return this.started(message);
      case 'session.output_audio.delta': return this.outputAudio(message);
      case 'session.input_transcript.delta': return this.inputTranscript(message);
      case 'session.output_transcript.delta': return this.outputTranscript(message);
      case 'response.event': return this.delegated(message);
      case 'session.usage.updated': return this.touch();
      case 'session.closed': return this.sessionClosed(message);
      case 'error': return this.providerError(message);
      default: this.touch(); return;
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
    this.diagnostic.outputAudioFrames += 1;
    this.diagnostic.outputAudioPCMBytes += pcm.byteLength;
    // Contract invariant: no frame dropping. Output audio of an open session is always forwarded; an input
    // transcript can never silence the assistant, because gpt-live-1 hands turn taking to the server.
    this.audioSinceCompletion = true;
    this.queuePlayback(pcm.byteLength);
    this.emit({ type: 'audio', pcm, rate: 24_000 });
    this.settleTurn();
    this.touch();
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
    // Empty and whitespace-only deltas carry no word: they start no episode, take no word and never flush.
    if (!message.delta.trim().length) return;
    this.noteInput(message.delta);
    this.userTranscriptOpen = true;
    this.diagnostic.inputTranscriptionEvents += 1;
    this.diagnostic.inputTranscriptionCharacters += message.delta.length;
    this.emit({ type: 'inputTranscription', text: message.delta, finished: false });
    this.touch();
  }

  /**
   * An input episode is the owner's run of input transcript deltas; it ends after INPUT_EPISODE_QUIET_MS of
   * quiet, which resets the assembled transcript and re-arms the once-per-episode barge-in latch. The episode
   * is what makes a split delta of one word still count as one word.
   */
  private noteInput(delta: string): void {
    if (this.episodeQuiet !== undefined) this.clock.clearTimer(this.episodeQuiet);
    this.episodeQuiet = this.clock.setTimer(INPUT_EPISODE_QUIET_MS, () => this.endInputEpisode());
    this.inputEpisode += delta;
    const words = countWords(this.inputEpisode);
    // Barge-in: at least two assembled words, at most one flush per episode, and audio actually to flush.
    if (this.flushed || words < 2 || this.clock.now() >= this.playbackUntil) return;
    const queuedMs = Math.max(0, Math.round(this.playbackUntil - this.clock.now()));
    this.flushed = true;
    this.generation += 1;
    this.muted = this.generation;
    this.ownerTurnedAfterInterruption = true;
    // The cut turn is over at the host, so no idle completion is owed to it; later audio reopens the account.
    this.audioSinceCompletion = false;
    this.outputTranscriptOpen = false;
    // The host flushes its native queue on `interrupted`, so the modelled queue starts empty at the same instant.
    this.playbackUntil = this.clock.now();
    this.postFlushMs = 0;
    console.error(JSON.stringify({ event: 'gptlive_flush', words, queuedMs }));
    this.emit({ type: 'interrupted' });
  }

  private endInputEpisode(): void {
    this.episodeQuiet = undefined;
    this.inputEpisode = '';
    this.flushed = false;
    this.reportPostFlush();
  }

  /** Receipt, no transcript text: how much audio still arrived after a barge-in, before the next episode. */
  private reportPostFlush(): void {
    const ms = this.postFlushMs;
    if (ms === undefined) return;
    this.postFlushMs = undefined;
    console.error(JSON.stringify({ event: 'gptlive_post_flush_audio_ms', ms: Math.round(ms) }));
  }

  /**
   * Presentation idle, the one end of turn: audio was forwarded since the last completion, the output has been
   * quiet for TURN_IDLE_QUIET_MS, the modelled playback is drained and no delegated response is outstanding.
   * `response.done` clears the outstanding flag and never declares the playback drained by itself.
   */
  private settleTurn(): void {
    if (this.terminal) return;
    if (this.idleQuiet !== undefined) { this.clock.clearTimer(this.idleQuiet); this.idleQuiet = undefined; }
    if (this.delegatedOutstanding || !this.audioSinceCompletion) return;
    const now = this.clock.now();
    const wait = Math.max(TURN_IDLE_QUIET_MS - (now - this.lastForwardedAt), Math.ceil(this.playbackUntil - now), 0);
    if (wait <= 0) { this.completeTurn(); return; }
    this.idleQuiet = this.clock.setTimer(wait, () => { this.idleQuiet = undefined; this.settleTurn(); });
  }

  private completeTurn(): void {
    const idleMs = Math.max(0, Math.round(this.clock.now() - this.lastForwardedAt));
    this.audioSinceCompletion = false;
    if (this.outputTranscriptOpen) { this.outputTranscriptOpen = false; this.emit({ type: 'outputTranscription', text: '', finished: true }); }
    if (this.emit({ type: 'turnComplete' })) { this.diagnostic.turnCompleteEvents += 1; this.diagnostic.generationCompleteEvents += 1; }
    console.error(JSON.stringify({ event: 'gptlive_turn_complete', idleMs, drained: true }));
    this.touch();
  }

  private outputTranscript(message: ObjectValue): void {
    if (typeof message.delta !== 'string') fail('protocol_error');
    // Transcripts are never dropped: the host journals what was actually spoken.
    if (message.delta.length) {
      this.outputTranscriptOpen = true;
      this.emit({ type: 'outputTranscription', text: message.delta, finished: false });
    }
    this.touch();
  }

  /** A `response.event` envelope forwards one Responses backend event (`event` carries the nested type). */
  private delegated(message: ObjectValue): void {
    const event = message.event;
    if (!object(event) || typeof event.type !== 'string') fail('protocol_error');
    switch (event.type) {
      case 'response.created': {
        this.endTurnTranscripts();
        this.delegatedOutstanding = true;
        this.generation += 1;
        this.emit({ type: 'modelTurnStarted' });
        this.touch();
        return;
      }
      case 'response.output_item.done': return this.outputItem(event);
      case 'response.done':
      case 'response.completed': {
        const usage = object(event.response) ? event.response.usage : undefined;
        if (object(usage) && typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0) {
          this.emit({ type: 'contextUsage', totalTokens: usage.total_tokens,
            ...(typeof usage.input_tokens === 'number' ? { promptTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === 'number' ? { responseTokens: usage.output_tokens } : {}) });
        }
        this.delegatedOutstanding = false;
        if (this.outputTranscriptOpen) { this.outputTranscriptOpen = false; this.emit({ type: 'outputTranscription', text: '', finished: true }); }
        // End of turn is presentation idle, never this frame: a delegated response.done does not drain playback.
        this.settleTurn();
        this.touch();
        return;
      }
      default: this.touch(); return;
    }
  }

  private endTurnTranscripts(): void {
    if (!this.userTranscriptOpen) return;
    this.userTranscriptOpen = false;
    this.emit({ type: 'inputTranscription', text: '', finished: true });
  }

  /** A delegated function call: `{call_id, name, arguments}` on the nested output item. */
  private outputItem(event: ObjectValue): void {
    const item = event.item;
    if (!object(item)) fail('protocol_error');
    if (item.type !== 'function_call') { this.touch(); return; }
    let args: JsonObject;
    try { const parsed: unknown = JSON.parse(typeof item.arguments === 'string' && item.arguments.length ? item.arguments : '{}'); args = object(parsed) ? parsed : {}; }
    catch { fail('protocol_error'); }
    const call: LiveToolCall = { id: this.text(item.call_id), name: this.text(item.name), args };
    if (this.pendingCalls.some(pending => pending.id === call.id)) fail('protocol_error');
    this.pendingCalls = [...this.pendingCalls, call];
    this.emit({ type: 'toolCall', calls: [call] });
    this.touch();
  }

  private text(value: unknown): string {
    if (typeof value !== 'string' || !value.length || (this.secret && value.includes(this.secret))) fail('protocol_error');
    return value;
  }

  private providerError(message: ObjectValue): void {
    // Errors can cut assistant audio without ending the session (docs, "Handle moderation"); the
    // session's end arrives as session.closed, so this only stops the current generation.
    if (this.generation !== this.muted) {
      this.generation += 1;
      this.muted = this.generation;
      // The host flushes its queue on `interrupted`; future audio is still forwarded, never latched off.
      this.playbackUntil = this.clock.now();
      this.audioSinceCompletion = false;
      this.emit({ type: 'interrupted' });
    }
    const error = object(message.error) ? message.error : {};
    console.error(JSON.stringify({ event: 'live_provider_error', type: typeof error.type === 'string' ? error.type : 'unknown',
      code: typeof error.code === 'string' ? error.code : 'none' }));
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
          else { this.diagnostic.localWriteCallbackSuccessCalls++; this.diagnostic.localWriteCallbackSuccessPCMBytes += pcmBytes; }
        }
        if (error && this.checkpoint()) {
          if (pcmBytes && this.isReady) this.dropUpstream('write_error', socket); else this.onError(error);
        }
      });
      if (pcmBytes) {
        this.diagnostic.localWriteEnqueuedCalls++; this.diagnostic.localWriteEnqueuedPCMBytes += pcmBytes;
        this.watchUpstreamStall(socket);
      }
      this.touch(); return !this.terminal;
    } catch (error) {
      if (pcmBytes) { this.diagnostic.localWriteCallbackPendingCalls--; this.diagnostic.localWriteCallbackPendingPCMBytes -= pcmBytes; }
      if (this.checkpoint()) this.onError(error instanceof Error ? error : new Error('send_failed'));
      return false;
    }
  }

  sendToolResponse(input: { responses: LiveToolResponse[] }): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || !Array.isArray(input.responses) || !this.pendingCalls.length || input.responses.length !== this.pendingCalls.length
      || new Set(input.responses.map(r => r.id)).size !== input.responses.length
      || input.responses.some(r => !object(r) || !object(r.response) || !this.pendingCalls.some(c => c.id === r.id && c.name === r.name))) fail('invalid_request');
    for (const { id, response } of input.responses) {
      // `function_call_output` carries the call_id back to the backend (guides/live-migration, delegation table).
      if (!this.write(JSON.stringify({ type: 'response.item.create', item: { type: 'function_call_output', call_id: id, output: JSON.stringify(response) } }))) return;
    }
    this.pendingCalls = [];
    // Council ruling: once the owner has started a new turn after a barge-in, the finished result is
    // recorded without another response.create. The docs add that an accepted response.create waits for
    // the current backend response, so a second one would be refused.
    if (this.generation === this.muted && this.ownerTurnedAfterInterruption) return;
    this.write(JSON.stringify({ type: 'response.create' }));
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
    if (!this.write(frame, pcm.byteLength)) fail(this.terminal?.code ?? 'not_ready');
  }

  sendText(input: { text: string }): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || typeof input.text !== 'string' || !input.text.length || input.text.length > 4000) fail('invalid_request');
    if (!this.write(JSON.stringify({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.text }] } }))) fail(this.terminal!.code);
    this.write(JSON.stringify({ type: 'response.create' }));
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.signal.removeEventListener('abort', this.onAbort);
    if (this.episodeQuiet !== undefined) { this.clock.clearTimer(this.episodeQuiet); this.episodeQuiet = undefined; }
    if (this.idleQuiet !== undefined) { this.clock.clearTimer(this.idleQuiet); this.idleQuiet = undefined; }
    this.reportPostFlush();
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
