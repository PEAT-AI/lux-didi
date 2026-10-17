import type { createToolsOwner } from '../tools/index.js';
import type { ResearchSelector } from '../tools/research.js';
import type { LiveToolStepBody } from '../tools/host-events.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
import type { DataClass, LiveVoiceOutcome, LiveVoicePort, LiveVoiceProvider } from '../adapters/live-voice/index.js';
import type { StorePort } from '../contracts/storage.js';

/** The same canonical Store, which alone exposes the canonical assistant identity. */
export interface LiveStorePort extends StorePort { readonly assistantId: string }

export type LiveProvider = LiveVoiceProvider;
export type LiveLifecycle = 'accepted' | 'opening' | 'active' | 'terminal';
export type LiveConsumerState = 'detached' | 'attached' | 'ended' | 'backpressure';
export type LiveInvalidationReason = 'revoked' | 'authority' | 'profile';
export type LiveErrorCode =
  | 'memory_unavailable' | 'instruction_too_large' | 'pickup_changed'
  | 'invalid_config' | 'invalid_request' | 'invalid_context' | 'stale_authority' | 'not_found'
  | 'idempotency_conflict' | 'terminal' | 'already_attached' | 'not_ready' | 'invalidated'
  | 'expired' | 'invalid_audio' | 'persistence_failed';
export type LiveConfigErrorCode =
  | 'invalid_object' | 'invalid_provider' | 'invalid_model' | 'invalid_voice' | 'invalid_key_reference'
  | 'invalid_route' | 'invalid_classes' | 'invalid_prompt' | 'invalid_limit' | 'invalid_language'
  | 'invalid_accent';

export class LiveError extends Error {
  constructor(readonly code: LiveErrorCode, message: string = code) { super(message); this.name = 'LiveError'; }
}
export class LiveConfigError extends Error {
  constructor(readonly code: LiveConfigErrorCode, message: string = code) { super(message); this.name = 'LiveConfigError'; }
}

export interface LiveLimits {
  sessionMs: number; idleMs: number; unusedMs: number; handshakeMs: number; closeMs: number;
  /** Total call ceiling: only this ceiling and the idle timeout end a call for time (release 3g-c). */
  callMaxMs: number;
  journalMaxEvents: number; journalMaxBytes: number; consumerQueueEvents: number; consumerQueueBytes: number;
  wsBufferedBytes: number;
}

export interface LiveMemoryRecord { readonly id: string; readonly text: string; readonly dataClass: DataClass | 'unknown' }
export type LiveMemorySource = (tx: import('../contracts/storage.js').Transaction) => readonly LiveMemoryRecord[];
export interface LiveMemoryProvenance {
  readonly status: 'empty' | 'selected' | 'partial' | 'omitted';
  readonly selectedIds: readonly string[];
  readonly omitted: readonly { readonly id: string; readonly reason: 'budget' }[];
}
export interface LiveMemoryProjection { readonly status: LiveMemoryProvenance['status']; readonly selected: number; readonly omitted: number }

export interface AcceptedPromptSnapshot {
  readonly memory?: LiveMemoryProvenance;
  readonly pickup?: { readonly jobId: string; readonly identity: string };

  readonly schemaVersion: 1; readonly ownerProfile: OwnerProfileSnapshot;
  readonly compilerVersion: string; readonly system: string; readonly dataClasses: readonly DataClass[];
}
export interface LiveProfile {
  readonly overlay?: import('../prompt/live-persona.js').PersonaOverlay;
  readonly acceptedPrompt?: AcceptedPromptSnapshot;
  readonly provider: LiveProvider;
  readonly liveModelId: string;
  readonly voice: string;
  readonly keyReference: string;
  readonly language?: string;
  readonly route: { readonly enabled: true; readonly provider: LiveProvider; readonly modelId: string; readonly dataClasses: readonly DataClass[] };
  readonly prompt: { readonly text: string; readonly dataClass: DataClass };
  readonly limits: LiveLimits;
}

export type LiveToolsComposition = {
  owner: ReturnType<typeof createToolsOwner>; connectionIds(): string[];
  /** Configured connector endpoints and their state, for the host-generated runtime context. */
  status?(): { endpoints: readonly { id: string; connector: string; state: string }[] };
  registerAuthoritySource?(source: (runId: string, signal: AbortSignal) => Promise<import('../tools/types.js').LiveAuthority | null>): void;
};
export interface LiveToolProjection { code?: 'tool_call_lost_on_resume' | 'after_barge_in'; callId?: string; name: string; status: 'called' | 'completed' | 'error'; markdown: string; sources: { title: string; url?: string }[] }
export interface PendingLiveJob {
  id: string; originSessionId: string; state: 'in_progress' | 'completed' | 'failed' | 'unknown';
  createdAt: number; markdown: string; delivered: boolean;
}
export interface LivePendingService {
  pendingJobs(): PendingLiveJob[];
  createWithPending(inputClass: DataClass, idempotencyKey: string, context: LiveContext, pickupJobId?: string): LiveSessionSnapshot;
}
export interface LivePageProjection {
  pastSession?: { outcome: LiveTerminalOutcome['state'] | 'unknown'; endedAt: number | null; lastObservedAt: number };
  jobs?: PendingLiveJob[];
  memory?: LiveMemoryProjection;
  state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'rebuilding' | 'ended' | 'error'; since: number | null;
  entries: { seq: number; kind: 'continuity' | 'inputTranscription' | 'outputTranscription' | 'toolCall' | 'toolResult' | 'interrupted' | 'turnComplete' | 'terminal' | 'researchProgress'; event?: 'rebuilding' | 'resumed'; reason?: string; text?: string; tool?: { name: string; status: 'called' | 'completed' | 'error'; markdown?: string; sources?: { title: string; url?: string }[] }; progress?: ResearchProgressView }[];
  cursor: number;
  /** The tool steps of the turn in flight, newest last. In memory only: a settled session keeps none,
   *  so the voice view dims them without a schema change. */
  steps?: LiveToolStepBody[];
}

/** Metadata only: the research phase and source kinds, never the question or a result. */
export interface ResearchProgressView {
  researchId: string; phase: 'started' | 'round' | 'done' | 'stopped';
  sourcesDone: string[]; sourcesPending: string[]; elapsedMs: number;
}
export interface LiveOwnerConfig {
  readonly tools?: LiveToolsComposition;
  /** Optional same-provider text selector for the research loop; absent falls back to the fixed recipe. */
  readonly research?: ResearchSelector;
  readonly memorySource?: LiveMemorySource;
  readonly store: LiveStorePort;
  readonly voice: LiveVoicePort;
  readonly profile: LiveProfile;
  /** Trusted clock in safe integer Unix epoch milliseconds, shared with schedule in tests. */
  readonly now?: () => number;
  /** IANA timezone of the host clock, for the runtime context; defaults to the process timezone. */
  readonly timeZone?: string;
  /** Trusted in-process timer seam; not a transport or an error callback. */
  readonly schedule?: (callback: () => void, delayMs: number) => { unref(): void; cancel(): void };
}

export interface LiveContext { readonly clientId: string; readonly auditId: string; readonly authorityEpoch: string }
export interface CreateLiveSession { readonly idempotencyKey: string; readonly inputClass: DataClass; readonly pickupJobId?: string }

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
  memory: LiveMemoryProjection;
  profileIdentity: string; promptIdentity: string; grant: LiveGrantSnapshot; consumerState: LiveConsumerState;
  journal: { events: number; bytes: number; maxEvents: number; maxBytes: number; complete: boolean };
  terminal: LiveTerminalOutcome | null; createdAt: number; updatedAt: number;
}

export type JournalKind =
  | 'toolCall' | 'toolResult' | 'continuity' | 'remember_deferred'
  | 'inputTranscription' | 'outputTranscription' | 'ready' | 'interrupted' | 'generationComplete'
  | 'turnComplete' | 'waitingForInput' | 'terminal' | 'researchProgress';

export interface LiveFragment {
  waitedMs?: number;
  event?: 'rebuilding' | 'resumed'; reason?: string;
  tool?: LiveToolProjection;
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
  readonly event?: 'rebuilding' | 'resumed'; readonly reason?: string;
  readonly tool?: LiveToolProjection;
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
  readonly memory: LiveMemoryProjection;
  readonly provider: LiveProvider;
  readonly model: string;
  readonly voice: string;
  readonly dataClasses: readonly DataClass[];
  readonly profileIdentity: string;
}

/** Adapter outcome narrowed to its fixed sanitized shape. */
export type SanitizedAdapterOutcome = LiveVoiceOutcome;
