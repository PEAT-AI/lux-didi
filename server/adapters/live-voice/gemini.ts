import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { DataClass, LiveVoiceAdapterOptions, LiveVoiceCapabilities, LiveVoiceControl, LiveVoiceDiagnostics, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession, LiveSocketFactory, LiveVoiceErrorCode, LiveVoiceUpstreamDrop, LiveToolResponse, LiveToolCall } from './types.js';
import { LiveVoiceError, liveVoiceTimerDefaults } from './types.js';
import { geminiDialect } from '../../tools/declarations.js';
import { effectiveLanguageCode } from '../../prompt/live-persona.js';

// Fixed official v1beta endpoint. Neither destination nor credentials are public events.
const networkErrors = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const FRESH_OPENING = 'Open the conversation now with one fresh, specific line.';
// The model-first opening nudge is provider-neutral and accent-free: the accent lives in the system
// instruction, the voice and the language in the setup frame, for every provider.
// Upstream liveness limits for the send path (release 3g-c). The hard ceiling (half the send buffer held for
// `upstreamStallMs`) is joined by two earlier signals and a websocket ping, so a stalled socket reaches the
// owner recovery path before the provider session is lost.
const STALL_QUEUE_BYTES = 128 * 1024; // queued bytes held above this for STALL_QUIET_MS counts as a stall
// A no-drain stall needs a real backlog behind it. One audio frame is ~2-3 KB (2217 bytes sat on an idle local
// queue in the 3h-b smoke that R1 dropped), while the 10-16 forensics held ~1.07 MB for many seconds. 64 KB is
// ~20 frames (about 2 s of 16 kHz PCM16 audio) and 16x below that evidence: a healthy socket drains
// continuously and never parks that much, so bytes above it mean the upstream stopped draining.
const STALL_DRAIN_FLOOR_BYTES = 64 * 1024;
const STALL_QUIET_MS = 2_000;         // queue held above STALL_QUEUE_BYTES this long counts as a stall
const STALL_DRAIN_QUIET_MS = 5_000;   // sustained no-drain window above the floor, well short of the 10-16 stall
const PING_INTERVAL_MS = 5_000;        // websocket ping cadence
const PING_MISSED_LIMIT = 2;           // missed pongs before the socket is declared stalled
// Observability (release 3g-c): while the send queue is elevated, surface its depth about once a second.
const QUEUE_LOG_BYTES = 64 * 1024;
const QUEUE_LOG_INTERVAL_MS = 1_000;
// Issue 1014: the one Live write tool. It is declared NON_BLOCKING and its reply is scheduled SILENT,
// so a memory save never interrupts the turn; every read tool stays BLOCKING.
const MEMORY_TOOL = 'remember_note';
const live38Pattern = /gemini-3\.8[^/]*live/;
const DEFAULTS: Readonly<LiveVoiceLimits> = Object.freeze({
  maxIncomingBytes: 1024 * 1024, maxOutgoingBytes: 1024 * 1024, maxBufferedBytes: 2 * 1024 * 1024, upstreamStallMs: 400,
  maxEventBytes: 1024 * 1024, maxEvents: 128, maxRequestBytes: 256 * 1024, maxHistoryTurns: 128,
  ...liveVoiceTimerDefaults,
});
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];

// Google Live API automatic activity detection defaults for setup.realtimeInputConfig.automaticActivityDetection.
// prefixPaddingMs keeps the first syllables, silenceDurationMs tolerates a mid-sentence thinking pause,
// and the LOW end sensitivity stops a brief pause from ending the turn.
// https://ai.google.dev/api/live (AutomaticActivityDetection: prefixPaddingMs, silenceDurationMs, startOfSpeechSensitivity, endOfSpeechSensitivity)
// prefixPaddingMs 700 (was 300): release 3a echo-analysis (Argon round 2, lux 89995) measured a brief
// >= 300 ms non-lexical event (residual echo on loud prosody) cutting Naya off, so absorb a longer pre-roll.
export const liveVoiceActivityDefaults = Object.freeze({
  prefixPaddingMs: 700, silenceDurationMs: 800,
  startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
} as const);


// The only place a model id is read. It derives this adapter's own capability values; every wire decision
// below reads a capability, never the id. `gemini-3.8 live` takes the provider default thinking level and
// carries the per-tool blocking hint and the empty-ready tolerance; older live models request the minimum.
function capabilitiesOf(modelId: string): LiveVoiceCapabilities {
  const live38 = live38Pattern.test(modelId);
  return Object.freeze({
    provider: 'gemini' as const,
    supportsResumption: true,
    supportsGoAway: true,
    supportsInterruption: true,
    supportsServerVadConfig: true,
    inputRates: Object.freeze([16000]),
    outputRates: Object.freeze([24000]),
    outputModalities: Object.freeze(['audio'] as const),
    thinking: live38 ? 'provider_default' : 'minimal',
    supportsToolScheduling: live38,
    toleratesEmptyReadyLifecycle: live38,
  });
}
const timerNames = ['handshakeMs', 'idleMs', 'sessionMs', 'closeMs'] as const;
// Gemini Live provider field names, used only to name the rejected frame kind, never its values.
const frameKeys = ['error', 'toolCall', 'toolCallCancellation', 'setupComplete', 'serverContent', 'voiceActivity', 'sessionResumptionUpdate', 'goAway', 'usageMetadata'];
function keyName(key: string): boolean { return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key); }
// A write failure's kind is its error code when it is a safe token, else a constant. Never a message.
function upstreamErrorKind(error: unknown): string {
  const code = object(error) ? error.code : undefined;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : 'write_error';
}
// Bounded shape walk: key names only, never a value, text, audio or id.
function shapePaths(value: unknown, out: string[], prefix: string, depth: number): void {
  if (out.length >= 24 || depth > 4 || !object(value)) return;
  for (const key of Object.keys(value)) {
    if (out.length >= 24) return;
    if (!keyName(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    const child = value[key];
    if (Array.isArray(child)) { if (child.length && object(child[0])) shapePaths(child[0], out, `${path}[]`, depth + 1); }
    else if (object(child)) shapePaths(child, out, path, depth + 1);
  }
}
type ObjectValue = Record<string, unknown>;
type EventBody = LiveVoiceEvent extends infer E ? E extends LiveVoiceEvent ? Omit<E, 'sequence'> : never : never;
function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fail(code: LiveVoiceErrorCode): never { throw new LiveVoiceError(code); }
function classList(value: unknown, code: LiveVoiceErrorCode): DataClass[] {
  if (!Array.isArray(value) || !value.length || value.some(c => !classes.includes(c)) || new Set(value).size !== value.length) fail(code);
  return [...value];
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: LiveVoiceError) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface Settings {
  modelId: string; voice: string; enabled: boolean; allowed: readonly DataClass[];
  keyReference: string; resolve: (reference: string) => Promise<string | undefined>;
  limits: Readonly<LiveVoiceLimits>; socketFactory: LiveSocketFactory;
}

export class GeminiLiveVoiceAdapter implements LiveVoicePort {
  private readonly settings: Settings;
  readonly capabilities: LiveVoiceCapabilities;
  constructor(options: LiveVoiceAdapterOptions) {
    if (!object(options) || typeof options.modelId !== 'string' || !/^models\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.modelId)
      || typeof options.voice !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.voice)
      || typeof options.keyReference !== 'string' || !options.keyReference.trim() || options.keyReference.length > 256
      || !options.credentials || typeof options.credentials.resolve !== 'function'
      || (options.socketFactory !== undefined && typeof options.socketFactory !== 'function')) fail('invalid_settings');
    if (options.limits !== undefined && !object(options.limits)) fail('invalid_settings');
    const limits = { ...DEFAULTS, ...options.limits };
    for (const name of Object.keys(limits)) {
      if (!(name in DEFAULTS)) fail('invalid_settings');
      const value = limits[name as keyof LiveVoiceLimits];
      if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_settings');
    }
    for (const name of timerNames) if (limits[name] > 2_147_483_647) fail('invalid_settings');
    const route = options.route;
    if (!object(route) || typeof route.enabled !== 'boolean' || route.provider !== 'gemini' || route.modelId !== options.modelId) fail('route_denied');
    const socketFactory: LiveSocketFactory = options.socketFactory ?? ((url, config) => new WebSocket(url, config));
    this.settings = Object.freeze({
      modelId: options.modelId, voice: options.voice, keyReference: options.keyReference,
      enabled: route.enabled, allowed: Object.freeze(classList(route.dataClasses, 'route_denied')),
      resolve: options.credentials.resolve.bind(options.credentials), limits: Object.freeze(limits),
      socketFactory,
    });
    this.capabilities = capabilitiesOf(options.modelId);
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
    if (request.resumptionHandle !== undefined && (typeof request.resumptionHandle !== 'string' || !request.resumptionHandle.length || request.resumptionHandle.length > 8192)) fail('invalid_request');
    const opening = request.opening ?? 'user_first';
    const declared = classList(request.dataClasses, 'invalid_request');
    if (declared.some(c => !settings.allowed.includes(c))) fail('route_denied');
    const checkClass = (value: unknown) => {
      if (!classes.includes(value as DataClass)) fail('invalid_request');
      if (!declared.includes(value as DataClass)) fail('route_denied');
    };
    checkClass(request.system.dataClass);
    const suppliedHistory = request.history ?? [];
    if (suppliedHistory.length > settings.limits.maxHistoryTurns) fail('invalid_request');
    const history = suppliedHistory.map(turn => {
      if (!object(turn) || (turn.role !== 'user' && turn.role !== 'model') || typeof turn.text !== 'string' || !turn.text.length) fail('invalid_request');
      checkClass(turn.dataClass);
      return { role: turn.role, parts: [{ text: turn.text }] };
    });
    // BCP-47 language or language-region: a bare primary subtag ("en") or a primary subtag plus region ("en-IN").
    if (request.languageCode !== undefined && !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(request.languageCode)) fail('invalid_request');
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 128 || request.tools.some(t => !object(t) || typeof t.name !== 'string' || !t.name || !object(t.parameters)))) fail('invalid_request');
    const system = request.system.text;
    if (Buffer.byteLength(JSON.stringify({ system, history, tools: request.tools })) > settings.limits.maxRequestBytes) fail('invalid_request');
    // The port carries the original JSON schemas; this adapter owns its own wire dialect.
    const declarations = request.tools?.map(declaration => ({
      ...declaration, parameters: geminiDialect(declaration.parameters),
      ...(this.capabilities.supportsToolScheduling
        ? { behavior: declaration.name === MEMORY_TOOL ? 'NON_BLOCKING' : 'BLOCKING' } : {}),
    }));
    const setup = JSON.stringify({ setup: {
      model: settings.modelId,
      sessionResumption: request.resumptionHandle ? { handle: request.resumptionHandle } : {},
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { ...(request.languageCode ? { languageCode: effectiveLanguageCode(request.languageCode) } : {}), voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
        ...(this.capabilities.thinking === 'minimal' ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}) },
      ...(declarations?.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
      contextWindowCompression: { slidingWindow: { targetTokens: 32000 } },
      realtimeInputConfig: { automaticActivityDetection: { ...liveVoiceActivityDefaults } },
      systemInstruction: { parts: [{ text: system }] }, inputAudioTranscription: {}, outputAudioTranscription: {},
    } });
    const initial = request.resumptionHandle ? undefined
      : request.openingText !== undefined
        ? JSON.stringify({ clientContent: { turns: [...history, { role: 'user', parts: [{ text: request.openingText }] }], turnComplete: opening === 'model_first' } })
      : history.length
        ? JSON.stringify({ clientContent: { turns: history, turnComplete: opening === 'model_first' } })
        : opening === 'model_first' ? JSON.stringify({ realtimeInput: { text: FRESH_OPENING } }) : undefined;
    if (Buffer.byteLength(setup) > settings.limits.maxOutgoingBytes || (initial && Buffer.byteLength(initial) > settings.limits.maxOutgoingBytes)) fail('outgoing_limit');
    if (!object(control) || !(control.signal instanceof AbortSignal) || !Number.isSafeInteger(control.deadlineMs)
      || control.deadlineMs <= 0 || control.deadlineMs - Date.now() > 2_147_483_647) fail('invalid_request');
    return new Session(settings, declared, setup, initial, control.signal, control.deadlineMs, control.idleResetMs ?? settings.limits.idleMs, this.capabilities);
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
  private lastQueuedBytes: number | undefined;
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
  private pendingCalls: LiveToolCall[] = [];
  private informationalKeys = new Set<string>();
  unknownTopLevelKeys = 0;
  private initialTurnComplete = false;
  private readonly diagnostic = {
    audioCalls: 0, audioBytes: 0, drainingDropCalls: 0, drainingDropBytes: 0,
    localWriteEnqueuedCalls: 0, localWriteEnqueuedPCMBytes: 0, localWriteCallbackSuccessCalls: 0, localWriteCallbackSuccessPCMBytes: 0,
    localWriteCallbackErrorCalls: 0, localWriteCallbackErrorPCMBytes: 0, localWriteCallbackPendingCalls: 0, localWriteCallbackPendingPCMBytes: 0,
    inputTranscriptionEvents: 0, inputTranscriptionCharacters: 0, generationCompleteEvents: 0, turnCompleteEvents: 0,
    outputAudioFrames: 0, outputAudioPCMBytes: 0, outputAudioAfterInitialTurnFrames: 0, outputAudioAfterInitialTurnPCMBytes: 0,
  } satisfies LiveVoiceDiagnostics;
  readonly diagnostics = (): Readonly<LiveVoiceDiagnostics> => Object.freeze({ ...this.diagnostic });
  private creatingSocket = false;
  constructor(private readonly settings: Settings, private readonly declared: readonly DataClass[], setup: string, initial: string | undefined,
    private readonly signal: AbortSignal, private readonly deadlineMs: number, private readonly idleResetMs: number,
    private readonly capabilities: LiveVoiceCapabilities) {
    // Failure remains observable through ready/done/events, without an unhandled rejection.
    void this.ready.catch(() => {});
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
    void this.connect(setup, initial);
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
  private async connect(setup: string, initial: string | undefined) {
    let key: string | undefined;
    try { if (!this.checkpoint()) return; key = await this.settings.resolve(this.settings.keyReference); }
    catch { if (this.checkpoint()) this.finish('credential_unavailable'); return; }
    if (!this.checkpoint()) return;
    if (typeof key !== 'string' || !key.trim() || key.length > 8192) { this.finish('credential_unavailable'); return; }
    this.secret = key;
    const destination = new URL(ENDPOINT); destination.searchParams.set('key', key);
    if (!this.checkpoint()) return;
    this.handshake = this.timer(this.settings.limits.handshakeMs, 'handshake_timeout');
    this.initial = initial;
    try {
      this.creatingSocket = true;
      const socket = this.settings.socketFactory(destination.href, {
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
      socket.once('open', this.onOpen = () => { if (this.checkpoint()) this.write(setup); });
      // The trusted seam/resolver can invalidate authority synchronously too.
      if (!this.checkpoint()) this.shutdownSocket();
    } catch {
      this.creatingSocket = false;
      this.finish('transport_error');
      if (this.terminal) this.shutdownSocket();
    }
  }
  private initial: string | undefined;
  private onOpen: () => void = () => {};
  private socketFailure(error: unknown): void {
    if (this.terminal) return;
    const code = object(error) ? error.code : undefined;
    this.finish(code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'incoming_limit'
      : typeof code === 'string' && code.startsWith('WS_ERR_') ? 'protocol_error'
      : typeof code === 'string' && networkErrors.has(code) ? 'transport_error'
      : this.isReady ? 'provider_error' : 'provider_setup_rejected');
  }
  // A dead upstream: the first failed audio write, or a socket whose bufferedAmount stays past half the
  // send-buffer budget for longer than upstreamStallMs. Stop sending at once and hand a recoverable
  // outcome to the owner resumption path; shutdownSocket closes the dead socket.
  private dropUpstream(errorKind: string, socket: WebSocket): void {
    if (this.terminal) return;
    this.upstreamDrop = { errorKind, closeCode: null, bufferedAmount: socket.bufferedAmount, writesFailed: this.diagnostic.localWriteCallbackErrorCalls, sessionMs: Math.max(0, Date.now() - this.startedAt) };
    this.finish('transport_error', this.upstreamDrop);
  }
  private watchUpstreamStall(socket: WebSocket): void {
    if (this.terminal || socket !== this.socket) return;
    const now = Date.now();
    const buffered = socket.bufferedAmount;
    const half = Math.max(1, Math.floor(this.settings.limits.maxBufferedBytes / 2));
    // Deferred so a detected stall never throws out of the audio send that observed it.
    const drop = (errorKind: string) => queueMicrotask(() => { if (socket === this.socket) this.dropUpstream(errorKind, socket); });
    // Hard ceiling: the queue held past half the send-buffer budget for upstreamStallMs (existing rule).
    if (buffered > half) {
      if (this.stalledSince === undefined) this.stalledSince = now;
      else if (now - this.stalledSince >= this.settings.limits.upstreamStallMs) { drop('stalled'); return; }
    } else this.stalledSince = undefined;
    // Earlier signal: queued bytes held above 128 KB for STALL_QUIET_MS.
    if (buffered > STALL_QUEUE_BYTES) {
      if (this.queueStalledSince === undefined) this.queueStalledSince = now;
      else if (now - this.queueStalledSince >= STALL_QUIET_MS) { drop('queue_stalled'); return; }
    } else this.queueStalledSince = undefined;
    // Earlier signal: a real backlog above the floor never drains for STALL_DRAIN_QUIET_MS. A small idle
    // queue is not evidence of a stall, so it never counts (#291).
    if (this.lastQueuedBytes === undefined || buffered < this.lastQueuedBytes) { this.lastQueuedBytes = buffered; this.lastDrainAt = now; }
    else this.lastQueuedBytes = buffered;
    if (buffered > STALL_DRAIN_FLOOR_BYTES && now - this.lastDrainAt >= STALL_DRAIN_QUIET_MS) { drop('no_drain'); return; }
    // Observability: report an elevated queue depth about once a second while it is above 64 KB.
    if (buffered > QUEUE_LOG_BYTES && (this.lastQueueLogAt === undefined || now - this.lastQueueLogAt >= QUEUE_LOG_INTERVAL_MS)) {
      this.lastQueueLogAt = now;
      this.emit({ type: 'upstreamQueue', bufferedBytes: buffered });
    }
  }
  // Websocket ping liveness: ping every PING_INTERVAL_MS, and two missed pongs declare the socket stalled.
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
  private readonly onError = (error: Error) => { this.socketFailure(error); };
  private readonly onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
    // Classify the HTTP refusal before ws can replace it with an untyped error/1006.
    this.finish('provider_setup_rejected');
    response.resume(); // Discard the body; never turn provider text into diagnostics.
  };
  private readonly onClose = (code: number) => {
    if (this.upstreamDrop && this.upstreamDrop.closeCode === null) this.upstreamDrop.closeCode = code;
    if (!this.terminal) {
      this.recoverable = code === 1006 || code === 1011 || this.draining && code === 1000;
      this.finish(this.draining && this.recoverable ? 'go_away' : code === 1008 || code === 1007 && !this.isReady ? 'provider_setup_rejected' : 'remote_closed');
    }
    this.cleanup();
  };
  private readonly onMessage = (data: RawData) => {
    if (!this.checkpoint()) return;
    let message: unknown;
    let byteLength = 0;
    let parsed = false;
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      byteLength = bytes.length;
      if (byteLength > this.settings.limits.maxIncomingBytes) { this.finish('incoming_limit'); return; }
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
      parsed = true;
      if (!object(message)) fail('protocol_error');
      if (!Object.keys(message).length) {
        if (this.capabilities.toleratesEmptyReadyLifecycle && this.isReady) return;
        fail('protocol_error');
      }
      if ('error' in message) fail('provider_error');
      if ('toolCall' in message) {
        if (!this.isReady || this.pendingCalls.length || !object(message.toolCall) || !Array.isArray(message.toolCall.functionCalls) || !message.toolCall.functionCalls.length || message.toolCall.functionCalls.length > 16) fail('protocol_error');
        const calls = message.toolCall.functionCalls;
        if (calls.some(c => !object(c) || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name || !object(c.args)) || new Set(calls.map(c => c.id)).size !== calls.length) fail('protocol_error');
        this.pendingCalls = structuredClone(calls) as LiveToolCall[];
        this.emit({ type: 'modelTurnStarted' });
        this.emit({ type: 'toolCall', calls: structuredClone(this.pendingCalls) });
      }
      if ('toolCallCancellation' in message) {
        if (!object(message.toolCallCancellation) || !Array.isArray(message.toolCallCancellation.ids) || message.toolCallCancellation.ids.some(id => typeof id !== 'string')) fail('protocol_error');
        const ids = message.toolCallCancellation.ids as string[];
        this.pendingCalls = this.pendingCalls.filter(c => !ids.includes(c.id));
        this.emit({ type: 'toolCallCancellation', ids });
      }
      if ('setupComplete' in message) {
        if (this.isReady || !object(message.setupComplete)) fail('protocol_error');
        this.clear(this.handshake); this.isReady = true;
        if (this.initial && !this.write(this.initial)) return;
        this.initial = undefined;
        if (!this.checkpoint() || !this.emit({ type: 'ready' })) return;
        this.readiness.resolve();
      }
      if (!this.isReady && ('serverContent' in message || 'goAway' in message || 'sessionResumptionUpdate' in message)) fail('protocol_error');
      const events: EventBody[] = [];
      if ('voiceActivity' in message) {
        const activity = message.voiceActivity;
        if (!object(activity)) fail('protocol_error');
        if ((activity.type ?? activity.voiceActivityType) === 'ACTIVITY_START') events.push({ type: 'waitingForInput', value: true });
        if ((activity.type ?? activity.voiceActivityType) === 'ACTIVITY_END') events.push({ type: 'waitingForInput', value: false });
      }
      const knownKeys = ['error', 'toolCall', 'toolCallCancellation', 'setupComplete', 'serverContent', 'voiceActivity', 'sessionResumptionUpdate', 'goAway'];
      for (const key of Object.keys(message)) {
        if (knownKeys.includes(key) && !(key === 'serverContent' && object(message.serverContent) && !Object.keys(message.serverContent).length)) continue;
        this.unknownTopLevelKeys = Math.min(65535, this.unknownTopLevelKeys + 1);
        // Bound both retained names and stderr. Never log a value or arbitrary text.
        if (this.informationalKeys.size < 32 && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !this.informationalKeys.has(key)) {
          this.informationalKeys.add(key);
          console.error(JSON.stringify({ event: 'live_provider_informational_key', key }));
        }
      }
      if ('serverContent' in message) this.content(message.serverContent, events, 'voiceActivity' in message);
      if ('sessionResumptionUpdate' in message) {
        const update = message.sessionResumptionUpdate;
        if (!object(update) || typeof update.resumable !== 'boolean' || ('newHandle' in update && typeof update.newHandle !== 'string')) fail('protocol_error');
        if (update.resumable && (typeof update.newHandle !== 'string' || !update.newHandle.length)) fail('protocol_error');
        events.push({ type: 'resumptionHandle', handle: update.resumable ? update.newHandle as string : null });
      }
      if ('goAway' in message) {
        const away = message.goAway;
        if (!object(away) || typeof away.timeLeft !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(away.timeLeft)
          || !Number.isFinite(Number(away.timeLeft.slice(0, -1)))) fail('protocol_error');
        this.draining = true;
        events.push({ type: 'goAway', timeLeftMs: Number(away.timeLeft.slice(0, -1)) * 1000 });
        this.timer(Math.max(1, Math.ceil(Number(away.timeLeft.slice(0, -1)) * 1000)), 'go_away');
      }
      if ('usageMetadata' in message) {
        const usage = message.usageMetadata;
        if (object(usage) && typeof usage.totalTokenCount === 'number' && Number.isSafeInteger(usage.totalTokenCount) && usage.totalTokenCount >= 0) {
          const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
          const promptTokens = count(usage.promptTokenCount), responseTokens = count(usage.responseTokenCount);
          events.push({ type: 'contextUsage', totalTokens: usage.totalTokenCount,
            ...(promptTokens !== undefined ? { promptTokens } : {}), ...(responseTokens !== undefined ? { responseTokens } : {}) });
        }
      }
      for (const event of events) { if (!this.checkpoint() || !this.emit(event)) return; }
      this.touch(events.some(event => event.type !== 'ready' && event.type !== 'resumptionHandle' && event.type !== 'goAway' && event.type !== 'contextUsage'));

    } catch (error) {
      const code = error instanceof LiveVoiceError ? error.code : 'protocol_error';
      this.reportRejectedFrame(message, byteLength, parsed, code, error);
      // A frame that genuinely cannot be decoded (invalid JSON, invalid UTF-8, or any unexpected
      // decode error) is dropped once the turn is live, so the next valid frame still plays; a
      // recognized but invalid payload stays fail-closed.
      if (this.isReady && !(error instanceof LiveVoiceError)) return;
      this.finish(code);
    }
  };
  // One bounded, privacy-safe line at the exact parser rejection point: frame kind, top-level
  // and nested key names and byte length, never a value, text, audio or id.
  private reportRejectedFrame(message: unknown, byteLength: number, parsed: boolean, code: LiveVoiceErrorCode, error: unknown): void {
    const kind = !parsed ? 'invalid_json' : object(message) ? frameKeys.filter(key => Object.hasOwn(message, key)).sort().join('+') || 'unknown' : 'non_object';
    const keys: string[] = [];
    if (object(message)) shapePaths(message, keys, '', 0);
    // Bounded classifier: the error constructor name only, never the message, payload or stack.
    const named = error instanceof Error ? error.name : 'nonerror';
    const classifier = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(named) ? named : 'unknown';
    console.error(JSON.stringify({ event: 'live_frame_rejected', code, error: classifier, kind, bytes: byteLength, keys }));
  }
  private text(value: unknown): string {
    if (typeof value !== 'string' || (this.secret && (value.includes(this.secret) || value.includes(encodeURIComponent(this.secret))))) fail('protocol_error');
    return value;
  }
  private content(value: unknown, events: EventBody[], activityFrame = false) {
    if (!object(value)) fail('protocol_error');
    if ('modelTurn' in value) {
      const turn = value.modelTurn;
      if (!object(turn) || ('role' in turn && turn.role !== 'model') || !Array.isArray(turn.parts) || (!activityFrame && !turn.parts.length)) fail('protocol_error');
      for (const part of turn.parts) {
        if (!object(part) || !Object.keys(part).length) fail('protocol_error');
        if ('functionCall' in part || 'functionResponse' in part) fail('unsupported_tool');
        if ('thought' in part && typeof part.thought !== 'boolean') fail('protocol_error');
        if ('inlineData' in part) {
          const blob = part.inlineData;
          if (!object(blob) || blob.mimeType !== 'audio/pcm;rate=24000' || typeof blob.data !== 'string'
            || !blob.data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob.data)) fail('protocol_error');
          const pcm = Buffer.from(blob.data, 'base64');
          if (!pcm.length || pcm.length % 2 || pcm.toString('base64') !== blob.data) fail('protocol_error');
          this.diagnostic.outputAudioFrames++; this.diagnostic.outputAudioPCMBytes += pcm.length;
          if (this.initialTurnComplete) { this.diagnostic.outputAudioAfterInitialTurnFrames++; this.diagnostic.outputAudioAfterInitialTurnPCMBytes += pcm.length; }
          events.push({ type: 'audio', pcm: new Uint8Array(pcm), rate: 24000 });
        }
        if ('text' in part) events.push({ type: 'modelText', text: this.text(part.text), thought: part.thought === true });
      }
    }
    for (const type of ['inputTranscription', 'outputTranscription'] as const) {
      if (type in value) {
        const transcription = value[type];
        if (!object(transcription) || ('finished' in transcription && typeof transcription.finished !== 'boolean')
          || ('text' in transcription && typeof transcription.text !== 'string')) fail('protocol_error');
        // Gemini's Transcription.text is optional: a carrier frame may hold the audio modelTurn and a
        // text-less outputTranscription together. Skipping the empty transcription keeps the audio.
        if ('text' in transcription) {
          const text = this.text(transcription.text);
          if (type === 'inputTranscription') { this.diagnostic.inputTranscriptionEvents++; this.diagnostic.inputTranscriptionCharacters += text.length; }
          events.push({ type, text, ...('finished' in transcription ? { finished: transcription.finished as boolean } : {}) });
        }
      }
    }
    if (events.some(event => event.type === 'audio' || event.type === 'modelText' || event.type === 'outputTranscription')) events.push({ type: 'modelTurnStarted' });
    for (const type of ['interrupted', 'generationComplete', 'turnComplete'] as const) {
      if (type in value) {
        if (typeof value[type] !== 'boolean') fail('protocol_error');
        if (value[type]) {
          if (type === 'generationComplete') this.diagnostic.generationCompleteEvents++;
          if (type === 'turnComplete') { this.diagnostic.turnCompleteEvents++; this.initialTurnComplete = true; }
          events.push({ type });
        }
      }
    }
    if ('waitingForInput' in value) {
      if (typeof value.waitingForInput !== 'boolean') fail('protocol_error');
      events.push({ type: 'waitingForInput', value: value.waitingForInput });
    }
    if ('interactionStatus' in value) {
      if (!['INTERACTION_STATUS_UNSPECIFIED', 'IN_PROGRESS', 'REQUIRES_ACTION', 'IDLE'].includes(value.interactionStatus as string)) fail('protocol_error');
      events.push({ type: 'interactionStatus', value: value.interactionStatus as string });
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
    // Reserve a single fixed terminal event even when the application queue is full.
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
    // A closing socket is not evidence of a network failure: let onClose classify it.
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
          // Only a ready owner-audio write is an upstream drop worth rebuilding for; setup, opening and
          // tool frames keep the terminal socketFailure classification.
          if (pcmBytes && this.isReady) this.dropUpstream(upstreamErrorKind(error), socket); else this.socketFailure(error);
        }
      });
      if (pcmBytes) {
        this.diagnostic.localWriteEnqueuedCalls++; this.diagnostic.localWriteEnqueuedPCMBytes += pcmBytes;
        this.watchUpstreamStall(socket);
      }
      this.touch(); return !this.terminal;
    } catch (error) {
      if (pcmBytes) { this.diagnostic.localWriteCallbackPendingCalls--; this.diagnostic.localWriteCallbackPendingPCMBytes -= pcmBytes; }
      if (pcmBytes && this.isReady) this.dropUpstream(upstreamErrorKind(error), socket); else this.socketFailure(error);
      return false;
    }
  }
  sendToolResponse(input: { responses: LiveToolResponse[] }): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || !Array.isArray(input.responses) || !this.pendingCalls.length || input.responses.length !== this.pendingCalls.length ||
      new Set(input.responses.map(r => r.id)).size !== input.responses.length || input.responses.some(r => !object(r) || !object(r.response) || !this.pendingCalls.some(c => c.id === r.id && c.name === r.name))) fail('invalid_request');
    // 3.8 Live only: a per-tool scheduling hint keeps a memory save from interrupting the turn; other
    // models keep the exact response object. The host remains the sole executor either way.
    const responses = this.capabilities.supportsToolScheduling
      ? input.responses.map(({ id, name, response }) => ({ id, name, ...(name === MEMORY_TOOL ? { scheduling: 'SILENT' } : {}), response }))
      : input.responses;
    const frame = JSON.stringify({ toolResponse: { functionResponses: responses } });
    if (this.write(frame)) this.pendingCalls = [];
  }
  sendAudio(input: { pcm: Uint8Array; dataClass: DataClass }): void {
    if (this.draining) {
      if (object(input) && input.pcm instanceof Uint8Array && input.pcm.byteLength > 0) { this.diagnostic.drainingDropCalls++; this.diagnostic.drainingDropBytes += input.pcm.byteLength; }
      return;
    }
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || !(input.pcm instanceof Uint8Array) || !input.pcm.byteLength || input.pcm.byteLength % 2) fail('invalid_audio');
    if (!classes.includes(input.dataClass) || !this.declared.includes(input.dataClass)) fail('route_denied');
    this.diagnostic.audioCalls++; this.diagnostic.audioBytes += input.pcm.byteLength;
    // Wire-38 confirmed Gemini 3.8 Live accepts realtimeInput while a BLOCKING call is pending
    // and answers the new question, so every frame is forwarded live in order (issue 210).
    // Size bound precedes the owned copy/base64 allocation. Never queue or resend audio.
    const overhead = Buffer.byteLength(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: '' } } }));
    if (Math.ceil(input.pcm.byteLength / 3) * 4 + overhead > this.settings.limits.maxOutgoingBytes) { this.finish('outgoing_limit'); fail('outgoing_limit'); }
    const data = Buffer.from(input.pcm).toString('base64');
    if (!this.write(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } }), input.pcm.byteLength)) fail(this.terminal!.code);
  }
  sendText(input: { text: string }): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!object(input) || typeof input.text !== 'string' || !input.text.length || input.text.length > 4000) fail('invalid_request');
    // Same frame as the model-first greeting text: a text turn the model answers by voice.
    if (!this.write(JSON.stringify({ realtimeInput: { text: input.text } }))) fail(this.terminal!.code);
  }
  endAudioStream(): void {
    if (this.draining) return;
    if (!this.checkpoint()) fail(this.terminal!.code);
    if (!this.isReady) fail('not_ready');
    if (!this.write(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))) fail(this.terminal!.code);
  }
  close(): void { if (this.checkpoint()) this.finish('closed'); }
  private finish(code: LiveVoiceErrorCode, upstream?: LiveVoiceUpstreamDrop) {
    if (this.terminal) return;
    const status = code === 'closed' ? 'closed' : code === 'cancelled' ? 'cancelled' : code === 'deadline' ? 'deadline' : 'failed';
    // A post-ready provider-side failure is recoverable through the owner resumption path; pre-ready,
    // auth, route and config failures stay terminal.
    const providerSideFailure = this.isReady && code === 'protocol_error';
    this.terminal = Object.freeze({ status, code, ...(this.recoverable || code === 'go_away' || code === 'transport_error' || providerSideFailure ? { recoverable: true } : {}), ...(upstream ? { upstream } : {}) });
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.signal.removeEventListener('abort', this.onAbort);
    this.initial = undefined; this.secret = '';
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
      socket.off('open', this.onOpen); socket.off('message', this.onMessage); socket.off('close', this.onClose);
      socket.off('unexpected-response', this.onUnexpectedResponse);
      // Keep the owned error guard until termination's close event has fired.
      if (socket.readyState === WebSocket.CLOSED) socket.off('error', this.onError);
      else socket.once('close', () => socket.off('error', this.onError));
    }
    this.completion.resolve(this.terminal!);
  }
}
