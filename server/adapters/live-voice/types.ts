import type { FunctionDeclaration, JsonObject } from '../model/types.js';
import type { Credentials, DataClass } from '../model/types.js';
import type { LiveTracePort } from '../../trace/record.js';
import type WebSocket from 'ws';
import type { ClientOptions } from 'ws';
export type { Credentials, DataClass } from '../model/types.js';

// The checked provider union: the one place a provider name is written. A new provider joins this array
// with its adapter and factory case, never as a bare literal at a call site.
export const liveVoiceProviders = ['gemini', 'openai'] as const;
export type LiveVoiceProvider = (typeof liveVoiceProviders)[number];
export function isLiveVoiceProvider(value: unknown): value is LiveVoiceProvider {
  return typeof value === 'string' && (liveVoiceProviders as readonly string[]).includes(value);
}
/** Audio modality an adapter can emit or accept on the wire. */
export type LiveVoiceModality = 'audio' | 'text';
/**
 * What an adapter declares about itself through the port. The host reads these flags instead of inferring
 * provider behaviour from a model id. There is deliberately no accent capability (the accent is a prompt
 * input every provider receives) and no tool-execution capability: the host is the sole executor of tools.
 */
export interface LiveVoiceCapabilities {
  readonly provider: LiveVoiceProvider;
  readonly supportsResumption: boolean;
  readonly supportsGoAway: boolean;
  readonly supportsInterruption: boolean;
  readonly supportsServerVadConfig: boolean;
  readonly inputRates: readonly number[];
  readonly outputRates: readonly number[];
  readonly outputModalities: readonly LiveVoiceModality[];
  /** Reasoning control the adapter requests: 'minimal' asks for the provider minimum, 'provider_default' sends none. */
  readonly thinking: 'minimal' | 'provider_default';
  /** Whether tool declarations carry a per-tool blocking hint. A scheduling hint only; the host always executes tools. */
  readonly supportsToolScheduling: boolean;
  /** Whether a ready frame carrying no model turn is harmless. */
  readonly toleratesEmptyReadyLifecycle: boolean;
}
export interface LiveVoiceRoute {
  enabled: boolean; provider: LiveVoiceProvider; modelId: string; dataClasses: readonly DataClass[];
}
export interface LiveVoiceLimits {
  maxIncomingBytes: number; maxOutgoingBytes: number; maxBufferedBytes: number; upstreamStallMs: number;
  maxEventBytes: number; maxEvents: number; maxRequestBytes: number; maxHistoryTurns: number;
  handshakeMs: number; idleMs: number; sessionMs: number; closeMs: number;
}
export type LiveSocketFactory = (destination: string, options: ClientOptions) => WebSocket;
/**
 * An adapter's own time source for its turn-taking windows (input episode quiet, presentation idle, the
 * modelled playback queue), so a test can drive whole seconds without sleeping.
 */
export interface LiveVoiceClock {
  now(): number;
  setTimer(ms: number, fire: () => void): unknown;
  clearTimer(handle: unknown): void;
}
export interface LiveVoiceAdapterOptions {
  modelId: string; voice: string; keyReference: string; credentials: Credentials;
  route: LiveVoiceRoute; limits?: Partial<LiveVoiceLimits>; socketFactory?: LiveSocketFactory;
  clock?: LiveVoiceClock;
  /** The task procedure a delegated backend is given after the adapter's own voice-backend template under a
   *  blank line (wagon S4b fills it). Absent, the backend sees the template alone. */
  backendProcedure?: string;
}
export interface LiveToolCall { id: string; name: string; args: JsonObject }
export interface LiveToolResponse { id: string; name: string; response: JsonObject }
/** What a tool answer did to the backend: a socket write is not provider acceptance (3r amendment A).
 *  `sent` is a `response.create` on the wire, `deferred` an answer recorded while its response was still
 *  active (the gate sends the continuation on the next terminal event), `failed` nothing written at all. */
export type LiveToolSendOutcome = 'sent' | 'deferred' | 'failed';
/** #538: the closed reason set a failed answer carries. The voice speaks one line for any of them, and the reason
 *  itself is metadata: the provider's own word never reaches the host log. */
export const TURN_FAILED_REASONS = ['provider_error', 'delegation_stalled', 'send_failed', 'recreate_failed'] as const;
export type TurnFailedReason = (typeof TURN_FAILED_REASONS)[number];
export const liveVoiceTimerDefaults = Object.freeze({ handshakeMs: 15_000, idleMs: 300_000, sessionMs: 3_600_000, closeMs: 1000 });
export interface LiveVoiceRequest {
  resumptionHandle?: string;
  opening?: 'user_first' | 'model_first';
  tools?: FunctionDeclaration[];
  languageCode?: string;
  /**
   * The opening input used instead of the fresh-call greeting: a fresh setup with no handle sends it as the
   * owner's first words (after any history), so a seeded recovery continues instead of greeting. Generated
   * host text only, never owner content, and carried to the wire only.
   */
  openingText?: string;
  system: { text: string; dataClass: DataClass };
  history?: readonly { role: 'user' | 'model'; text: string; dataClass: DataClass }[];
  dataClasses: readonly DataClass[];
}
export interface LiveVoiceControl {
  signal: AbortSignal; deadlineMs: number; limits?: Partial<LiveVoiceLimits>; idleResetMs?: number;
  /** O1b-A: the typed receipt door, bound by the host to this session's id, its connection epoch and its open
   *  turn. An adapter that is handed none records nothing; the Gemini adapter never reads it. */
  trace?: LiveTracePort;
}
export type LiveVoiceErrorCode =
  | 'closed' | 'cancelled' | 'deadline' | 'invalid_settings' | 'invalid_request' | 'route_denied'
  | 'credential_unavailable' | 'not_ready' | 'invalid_audio' | 'transport_error' | 'provider_error'
  | 'remote_closed' | 'provider_setup_rejected' | 'protocol_error' | 'unsupported_tool' | 'incoming_limit' | 'outgoing_limit'
  | 'backpressure' | 'event_limit' | 'handshake_timeout' | 'idle_timeout' | 'session_timeout' | 'go_away'
  | 'unsupported_provider';
// Metadata of one upstream (host to provider) write drop, never audio, text or credentials.
// closeCode is filled from the socket close event after the drop is detected, so it may be null until then.
// C-CONTINUITY R-08: closeReason is that close event's own reason, stripped of URLs and tokens.
export interface LiveVoiceUpstreamDrop {
  errorKind: string; closeCode: number | null; closeReason: string; bufferedAmount: number; writesFailed: number; sessionMs: number;
}
export interface LiveVoiceOutcome {
  recoverable?: boolean;
  upstream?: LiveVoiceUpstreamDrop;
  status: 'closed' | 'cancelled' | 'deadline' | 'failed'; code: LiveVoiceErrorCode;
}
export interface LiveVoiceDiagnostics {
  audioCalls: number; audioBytes: number;
  drainingDropCalls: number; drainingDropBytes: number;
  localWriteEnqueuedCalls: number; localWriteEnqueuedPCMBytes: number;
  localWriteCallbackSuccessCalls: number; localWriteCallbackSuccessPCMBytes: number;
  localWriteCallbackErrorCalls: number; localWriteCallbackErrorPCMBytes: number;
  localWriteCallbackPendingCalls: number; localWriteCallbackPendingPCMBytes: number;
  inputTranscriptionEvents: number; inputTranscriptionCharacters: number;
  generationCompleteEvents: number; turnCompleteEvents: number;
  outputAudioFrames: number; outputAudioPCMBytes: number;
  outputAudioAfterInitialTurnFrames: number; outputAudioAfterInitialTurnPCMBytes: number;
  /** W3: the quality the adapter derives from its own uplink measurements, and the bytes the socket drained.
   *  `weakAt` is the last moment it observed the link weak, which is what the watchdog compares with its wait. */
  connection?: { quality: 'ok' | 'weak'; uploadKbps: number; weakAt?: number };
}
export type TranscriptFinalOrigin = 'provider' | 'app_quiet' | 'app_model_start' | 'app_response_end' | 'typed' | 'unknown';
export type LiveVoiceEvent = { sequence: number } & (
  | { type: 'ready' }
  | { type: 'modelTurnStarted' }
  | { type: 'toolCall'; calls: LiveToolCall[] }
  | { type: 'toolCallCancellation'; ids: string[] }
  /** `audible` and `rmsDbfs` are the adapter's own level classification of this chunk (16-bit PCM in, dBFS
   *  against full scale), from the one rule in audio-level.ts. `audible` is required so no route can leave the
   *  host guessing: an unclassified frame would reset the idle clock as if the model had spoken (C-LIVE N-2). */
  | { type: 'audio'; pcm: Uint8Array; rate: number; audible: boolean; rmsDbfs?: number }
  | { type: 'inputTranscription' | 'outputTranscription'; text: string; finished?: boolean; providerEventId?: string; providerStartMs?: number; providerEndMs?: number; finalOrigin?: TranscriptFinalOrigin }
  | { type: 'modelText'; text: string; thought: boolean }
  | { type: 'generationComplete' | 'turnComplete' | 'interrupted' }
  | { type: 'waitingForInput'; value: boolean }
  | { type: 'interactionStatus'; value: string }
  | { type: 'goAway'; timeLeftMs: number }
  | { type: 'contextUsage'; totalTokens: number; promptTokens?: number; responseTokens?: number }
  | { type: 'upstreamQueue'; bufferedBytes: number }
  | { type: 'resumptionHandle'; handle: string | null }
  /** S5: one delegated backend response ended failed, incomplete or errored. `code` is the provider's own word,
   *  bounded to a metadata-safe token. The session itself is still healthy: this is a failed turn, not transport. */
  | { type: 'turnFailed'; code: string }
  | { type: 'outcome'; outcome: LiveVoiceOutcome }
);
export interface LiveVoiceSession {
  readonly ready: Promise<void>;
  readonly events: AsyncIterable<LiveVoiceEvent>;
  readonly done: Promise<LiveVoiceOutcome>;
  // Includes informational empty serverContent frames after readiness.
  readonly unknownTopLevelKeys?: number;
  readonly diagnostics?: () => Readonly<LiveVoiceDiagnostics>;
  sendToolResponse(input: { responses: LiveToolResponse[] }): LiveToolSendOutcome;
  sendAudio(input: { pcm: Uint8Array; dataClass: DataClass }): void;
  sendText(input: { text: string }): void;
  /** Speakable progress under Responses delegation, paraphrased by the voice model (GPT-Live only). An adapter
   *  that cannot carry progress speech leaves it out and the host keeps its own continuation nudge. Returns
   *  `false` when the adapter refused the append; a host that hears `false` must not claim the line was spoken. */
  sendCommentary?(input: { text: string }): boolean | void;
  endAudioStream(): void;
  close(): void;
}
export interface LiveVoicePort {
  /** The adapter's declared capabilities; the host reads these, never a model name. */
  readonly capabilities: LiveVoiceCapabilities;
  open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession;
}
export class LiveVoiceError extends Error {
  constructor(readonly code: LiveVoiceErrorCode) { super(code); this.name = 'LiveVoiceError'; }
}
