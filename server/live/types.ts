import type { OwnerProfileSnapshot } from '../prompt/types.js';
import type { DataClass, LiveVoiceOutcome, LiveVoicePort } from '../adapters/live-voice/index.js';
import type { StorePort } from '../contracts/storage.js';

/** The same canonical Store, which alone exposes the canonical assistant identity. */
export interface LiveStorePort extends StorePort { readonly assistantId: string }

export type LiveProvider = 'gemini';
export type LiveLifecycle = 'accepted' | 'opening' | 'active' | 'terminal';
export type LiveConsumerState = 'detached' | 'attached' | 'ended' | 'backpressure';
export type LiveInvalidationReason = 'revoked' | 'authority' | 'profile';
export type LiveErrorCode =
  | 'invalid_config' | 'invalid_request' | 'invalid_context' | 'stale_authority' | 'not_found'
  | 'idempotency_conflict' | 'terminal' | 'already_attached' | 'not_ready' | 'invalidated'
  | 'expired' | 'invalid_audio' | 'persistence_failed';
export type LiveConfigErrorCode =
  | 'invalid_object' | 'invalid_provider' | 'invalid_model' | 'invalid_voice' | 'invalid_key_reference'
  | 'invalid_route' | 'invalid_classes' | 'invalid_prompt' | 'invalid_limit';

export class LiveError extends Error {
  constructor(readonly code: LiveErrorCode, message: string = code) { super(message); this.name = 'LiveError'; }
}
export class LiveConfigError extends Error {
  constructor(readonly code: LiveConfigErrorCode, message: string = code) { super(message); this.name = 'LiveConfigError'; }
}

export interface LiveLimits {
  sessionMs: number; idleMs: number; unusedMs: number; handshakeMs: number; closeMs: number;
  journalMaxEvents: number; journalMaxBytes: number; consumerQueueEvents: number; consumerQueueBytes: number;
  wsBufferedBytes: number;
}

export interface AcceptedPromptSnapshot {
  readonly schemaVersion: 1; readonly ownerProfile: OwnerProfileSnapshot;
  readonly compilerVersion: string; readonly system: string; readonly dataClasses: readonly DataClass[];
}
export interface LiveProfile {
  readonly acceptedPrompt?: AcceptedPromptSnapshot;
  readonly provider: 'gemini';
  readonly liveModelId: string;
  readonly voice: string;
  readonly keyReference: string;
  readonly route: { readonly enabled: true; readonly provider: 'gemini'; readonly modelId: string; readonly dataClasses: readonly DataClass[] };
  readonly prompt: { readonly text: string; readonly dataClass: DataClass };
  readonly limits: LiveLimits;
}

export interface LiveOwnerConfig {
  readonly store: LiveStorePort;
  readonly voice: LiveVoicePort;
  readonly profile: LiveProfile;
  /** Trusted clock in safe integer Unix epoch milliseconds, shared with schedule in tests. */
  readonly now?: () => number;
  /** Trusted in-process timer seam; not a transport or an error callback. */
  readonly schedule?: (callback: () => void, delayMs: number) => { unref(): void; cancel(): void };
}

export interface LiveContext { readonly clientId: string; readonly auditId: string; readonly authorityEpoch: string }
export interface CreateLiveSession { readonly idempotencyKey: string; readonly inputClass: DataClass }

export interface LiveGrantSnapshot {
  grantId: string; provider: LiveProvider; model: string; voice: string; keyReference: string;
  permittedClasses: DataClass[]; chosenInputClass: DataClass; revision: number; grantedAt: number;
}

/** Sanitized terminal fact. Codes come only from the adapter's fixed enum or this owner. */
export type LiveTerminalOutcome =
  | { state: 'closed' | 'failed' | 'cancelled' | 'deadline'; code: string }
  | { state: 'not_started' | 'outcome_unknown' | 'journal_limit' | 'consumer_backpressure' | 'expired' | 'revoked' };

export interface LiveSessionSnapshot {
  liveSessionId: string; assistantId: string; authorityEpoch: string; idempotencyKey: string;
  clientId: string; auditId: string; lifecycle: LiveLifecycle; dispatchIntent: boolean; ready: boolean;
  profileIdentity: string; promptIdentity: string; grant: LiveGrantSnapshot; consumerState: LiveConsumerState;
  journal: { events: number; bytes: number; maxEvents: number; maxBytes: number; complete: boolean };
  terminal: LiveTerminalOutcome | null; createdAt: number; updatedAt: number;
}

export type JournalKind =
  | 'inputTranscription' | 'outputTranscription' | 'ready' | 'interrupted' | 'generationComplete'
  | 'turnComplete' | 'waitingForInput' | 'terminal';

export interface LiveFragment {
  liveSessionId: string; journalSequence: number; providerSequence: number | null; kind: JournalKind;
  text: string | null; finished: boolean | null; value: boolean | null; rejectedKind: JournalKind | null;
  rejectedSequence: number | null; arrivedAt: number;
}

export interface LiveFragmentPage {
  liveSessionId: string; fragments: LiveFragment[]; nextCursor: number | null;
  counts: { total: number; returned: number; fromCursor: number }; interruptions: number;
  terminal: { outcome: LiveTerminalOutcome; complete: boolean } | null;
}

/** One already-committed journal marker projected for the client. */
export interface LivePublicMarker {
  readonly kind: JournalKind;
  readonly sequence: number | null;
  readonly journalSequence: number;
  readonly text: string | null;
  readonly finished: boolean | null;
  readonly value: boolean | null;
}

/** One ordered output element: ephemeral PCM or one committed public marker. */
export type LiveOutputChunk =
  | { readonly kind: 'audio'; readonly pcm: Uint8Array }
  | { readonly kind: 'marker'; readonly marker: LivePublicMarker };

export interface LiveAttachment {
  readonly liveSessionId: string;
  readonly ready: Promise<LiveSessionSnapshot>;
  readonly output: AsyncIterable<LiveOutputChunk>;
  readonly done: Promise<LiveSessionSnapshot>;
  sendAudio(input: { readonly pcm: Uint8Array }): void;
  endAudioStream(): void;
  close(): void;
  detach(): void;
  /** Durable consumer_backpressure settlement when the socket's bufferedAmount bound is exceeded. */
  overflow(): void;
}

/** Safe operator-visible identity. Never carries key bytes or prompt text. */
export interface LiveProfileProjection {
  readonly provider: LiveProvider;
  readonly model: string;
  readonly voice: string;
  readonly dataClasses: readonly DataClass[];
  readonly profileIdentity: string;
}

/** Adapter outcome narrowed to its fixed sanitized shape. */
export type SanitizedAdapterOutcome = LiveVoiceOutcome;
