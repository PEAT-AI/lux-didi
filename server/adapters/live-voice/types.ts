import type { FunctionDeclaration, JsonObject } from '../model/types.js';
import type { Credentials, DataClass } from '../model/types.js';
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
export interface LiveVoiceAdapterOptions {
  modelId: string; voice: string; keyReference: string; credentials: Credentials;
  route: LiveVoiceRoute; limits?: Partial<LiveVoiceLimits>; socketFactory?: LiveSocketFactory;
}
export interface LiveToolCall { id: string; name: string; args: JsonObject }
export interface LiveToolResponse { id: string; name: string; response: JsonObject }
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
export interface LiveVoiceControl { signal: AbortSignal; deadlineMs: number; limits?: Partial<LiveVoiceLimits>; idleResetMs?: number }
export type LiveVoiceErrorCode =
  | 'closed' | 'cancelled' | 'deadline' | 'invalid_settings' | 'invalid_request' | 'route_denied'
  | 'credential_unavailable' | 'not_ready' | 'invalid_audio' | 'transport_error' | 'provider_error'
  | 'remote_closed' | 'provider_setup_rejected' | 'protocol_error' | 'unsupported_tool' | 'incoming_limit' | 'outgoing_limit'
  | 'backpressure' | 'event_limit' | 'handshake_timeout' | 'idle_timeout' | 'session_timeout' | 'go_away'
  | 'unsupported_provider';
// Metadata of one upstream (host to provider) write drop, never audio, text or credentials.
// closeCode is filled from the socket close event after the drop is detected, so it may be null until then.
export interface LiveVoiceUpstreamDrop {
  errorKind: string; closeCode: number | null; bufferedAmount: number; writesFailed: number; sessionMs: number;
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
}
export type LiveVoiceEvent = { sequence: number } & (
  | { type: 'ready' }
  | { type: 'modelTurnStarted' }
  | { type: 'toolCall'; calls: LiveToolCall[] }
  | { type: 'toolCallCancellation'; ids: string[] }
  | { type: 'audio'; pcm: Uint8Array; rate: number }
  | { type: 'inputTranscription' | 'outputTranscription'; text: string; finished?: boolean }
  | { type: 'modelText'; text: string; thought: boolean }
  | { type: 'generationComplete' | 'turnComplete' | 'interrupted' }
  | { type: 'waitingForInput'; value: boolean }
  | { type: 'interactionStatus'; value: string }
  | { type: 'goAway'; timeLeftMs: number }
  | { type: 'contextUsage'; totalTokens: number; promptTokens?: number; responseTokens?: number }
  | { type: 'upstreamQueue'; bufferedBytes: number }
  | { type: 'resumptionHandle'; handle: string | null }
  | { type: 'outcome'; outcome: LiveVoiceOutcome }
);
export interface LiveVoiceSession {
  readonly ready: Promise<void>;
  readonly events: AsyncIterable<LiveVoiceEvent>;
  readonly done: Promise<LiveVoiceOutcome>;
  // Includes informational empty serverContent frames after readiness.
  readonly unknownTopLevelKeys?: number;
  readonly diagnostics?: () => Readonly<LiveVoiceDiagnostics>;
  sendToolResponse(input: { responses: LiveToolResponse[] }): void;
  sendAudio(input: { pcm: Uint8Array; dataClass: DataClass }): void;
  sendText(input: { text: string }): void;
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
