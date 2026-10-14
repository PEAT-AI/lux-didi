import type { FunctionDeclaration, JsonObject } from '../model/types.js';
import type { Credentials, DataClass } from '../model/types.js';
import type WebSocket from 'ws';
import type { ClientOptions } from 'ws';
export type { Credentials, DataClass } from '../model/types.js';

export interface LiveVoiceRoute {
  enabled: boolean; provider: 'gemini'; modelId: string; dataClasses: readonly DataClass[];
}
export interface LiveVoiceLimits {
  maxIncomingBytes: number; maxOutgoingBytes: number; maxBufferedBytes: number;
  maxEventBytes: number; maxEvents: number; maxRequestBytes: number; maxHistoryTurns: number;
  handshakeMs: number; idleMs: number; sessionMs: number; closeMs: number;
}
export type LiveSocketFactory = (destination: string, options: ClientOptions) => WebSocket;
export interface GeminiLiveVoiceOptions {
  modelId: string; voice: string; keyReference: string; credentials: Credentials;
  route: LiveVoiceRoute; limits?: Partial<LiveVoiceLimits>; socketFactory?: LiveSocketFactory;
}
export interface LiveToolCall { id: string; name: string; args: JsonObject }
export interface LiveToolResponse { id: string; name: string; response: JsonObject }
export const liveVoiceTimerDefaults = Object.freeze({ handshakeMs: 15_000, idleMs: 300_000, sessionMs: 3_600_000, closeMs: 1000 });
// Google Live API automatic activity detection defaults for setup.realtimeInputConfig.automaticActivityDetection.
// prefixPaddingMs keeps the first syllables, silenceDurationMs tolerates a mid-sentence thinking pause,
// and the LOW end sensitivity stops a brief pause from ending the turn.
// https://ai.google.dev/api/live (AutomaticActivityDetection: prefixPaddingMs, silenceDurationMs, startOfSpeechSensitivity, endOfSpeechSensitivity)
export const liveVoiceActivityDefaults = Object.freeze({
  prefixPaddingMs: 300, silenceDurationMs: 1200,
  startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
} as const);
export interface LiveVoiceRequest {
  resumptionHandle?: string;
  opening?: 'user_first' | 'model_first';
  tools?: FunctionDeclaration[];
  languageCode?: string;
  system: { text: string; dataClass: DataClass };
  history?: readonly { role: 'user' | 'model'; text: string; dataClass: DataClass }[];
  dataClasses: readonly DataClass[];
}
export interface LiveVoiceControl { signal: AbortSignal; deadlineMs: number; limits?: Partial<LiveVoiceLimits>; idleResetMs?: number }
export type LiveVoiceErrorCode =
  | 'closed' | 'cancelled' | 'deadline' | 'invalid_settings' | 'invalid_request' | 'route_denied'
  | 'credential_unavailable' | 'not_ready' | 'invalid_audio' | 'transport_error' | 'provider_error'
  | 'remote_closed' | 'provider_setup_rejected' | 'protocol_error' | 'unsupported_tool' | 'incoming_limit' | 'outgoing_limit'
  | 'backpressure' | 'event_limit' | 'handshake_timeout' | 'idle_timeout' | 'session_timeout' | 'go_away';
export interface LiveVoiceOutcome {
  recoverable?: boolean;
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
  | { type: 'audio'; pcm: Uint8Array; mimeType: 'audio/pcm;rate=24000' }
  | { type: 'inputTranscription' | 'outputTranscription'; text: string; finished?: boolean }
  | { type: 'modelText'; text: string; thought: boolean }
  | { type: 'generationComplete' | 'turnComplete' | 'interrupted' }
  | { type: 'waitingForInput'; value: boolean }
  | { type: 'interactionStatus'; value: string }
  | { type: 'goAway'; timeLeftMs: number }
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
  endAudioStream(): void;
  close(): void;
}
export interface LiveVoicePort {
  open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession;
}
export class LiveVoiceError extends Error {
  constructor(readonly code: LiveVoiceErrorCode) { super(code); this.name = 'LiveVoiceError'; }
}
