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
export interface LiveVoiceRequest {
  system: { text: string; dataClass: DataClass };
  history?: readonly { role: 'user' | 'model'; text: string; dataClass: DataClass }[];
  dataClasses: readonly DataClass[];
}
export interface LiveVoiceControl { signal: AbortSignal; deadlineMs: number }
export type LiveVoiceErrorCode =
  | 'closed' | 'cancelled' | 'deadline' | 'invalid_settings' | 'invalid_request' | 'route_denied'
  | 'credential_unavailable' | 'not_ready' | 'invalid_audio' | 'transport_error' | 'provider_error'
  | 'remote_closed' | 'protocol_error' | 'unsupported_tool' | 'incoming_limit' | 'outgoing_limit'
  | 'backpressure' | 'event_limit' | 'handshake_timeout' | 'idle_timeout' | 'session_timeout' | 'go_away';
export interface LiveVoiceOutcome {
  status: 'closed' | 'cancelled' | 'deadline' | 'failed'; code: LiveVoiceErrorCode;
}
export type LiveVoiceEvent = { sequence: number } & (
  | { type: 'ready' }
  | { type: 'audio'; pcm: Uint8Array; mimeType: 'audio/pcm;rate=24000' }
  | { type: 'inputTranscription' | 'outputTranscription'; text: string; finished?: boolean }
  | { type: 'modelText'; text: string; thought: boolean }
  | { type: 'generationComplete' | 'turnComplete' | 'interrupted' }
  | { type: 'waitingForInput'; value: boolean }
  | { type: 'interactionStatus'; value: string }
  | { type: 'goAway'; timeLeft: string }
  | { type: 'resumptionAvailability'; available: boolean }
  | { type: 'outcome'; outcome: LiveVoiceOutcome }
);
export interface LiveVoiceSession {
  readonly ready: Promise<void>;
  readonly events: AsyncIterable<LiveVoiceEvent>;
  readonly done: Promise<LiveVoiceOutcome>;
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
