import type { OwnerProfileSnapshot } from '../prompt/types.js';
import type { StorePort, Transaction } from '../contracts/storage.js';
import type { DomainContext, DomainPort, SourceRef, RoutingLabel, RoutingLabelCorrection } from '../contracts/domain.js';
import type { DataClass, ModelPort, ModelStatus } from '../adapters/model/types.js';
import type { CompileInput, SourceAvailability, ValidatedPreferences } from '../prompt/index.js';

export type Outcome = ModelStatus | 'not_dispatched' | 'outcome_unknown' | 'unavailable' | 'input_too_large' | 'compile_failed' | 'persistence_failed';
/**
 * Safe local metadata about an explicit per-turn memory selection. Ids, counts
 * and compiler omit reasons only; never record text and never a whole-archive
 * claim. `frozen` is true only once the prompt has frozen for dispatch.
 */
export interface MemorySelectionSnapshot {
  schemaVersion: 1;
  requestedIds: string[];
  usedIds: string[];
  omitted: { id: string; reason: 'budget' | 'oversized' | 'not_included' }[];
  counts: { requested: number; used: number; omitted: number };
  frozen: boolean;
}
export interface RunSnapshot {
  runId: string; sessionId: string; userEntryId: string; finalEntryId: string | null;
  /** Read from the durable Domain entry, never the provisional buffer. */
  finalText: string | null;
  retryOf: string | null; authorityEpoch: string; provider: string; model: string;
  promptVersion: string; state: 'accepted' | 'dispatch_intent' | 'terminal'; outcome: Outcome | null;
  sequence: number; partialText: string; partialTruncated: boolean;
  acceptedAt: string; intentAt: string | null; terminalAt: string | null;
  mayHaveBeenSent: boolean;
  memorySelection: MemorySelectionSnapshot | null;
}
export type ChatEvent = { type: 'snapshot'; sequence: number; run: RunSnapshot }
  | { type: 'text'; sequence: number; text: string; provisional: true }
  | { type: 'resync_required'; sequence: number; reason: 'backpressure' | 'storage_unavailable' };
/** Conversation-scoped notification: durable run identifiers only, never transcript content. */
export type ConversationEvent = { type: 'run'; sessionId: string; runId: string }
  | { type: 'resync_required'; reason: 'backpressure' };
export interface AcceptInput {
  sessionId: string; text: string; idempotencyKey: string; retryOf?: string;
  /** Explicit bounded local records selected for this turn; trusted in-process only. */
  selectedMemoryEntryIds?: readonly string[];
}
/** Host startup authority, not an authenticated browser/client request. */
export interface ChatRecoveryContext { assistantId: string; authorityEpoch: string }
export interface EnrollInput { title: string; timeZone: string; idempotencyKey: string }
export interface ConversationStatus { sessionId: string; provider: string; model: string; state: 'active' | 'revoked' | 'route_changed'; revision: number; permittedClasses: DataClass[]; latestRunId: string | null }
export interface ChatPort {
  enroll(input: EnrollInput, context: DomainContext): ConversationStatus;
  conversation(sessionId: string, context: DomainContext): ConversationStatus;
  revoke(sessionId: string, context: DomainContext): ConversationStatus;
  correctRoutingLabel(input: RoutingLabelCorrection, context: DomainContext): RoutingLabel;
  shutdown(): void;
  recover(context: ChatRecoveryContext): RunSnapshot[];
  accept(input: AcceptInput, context: DomainContext): RunSnapshot;
  get(runId: string, context: DomainContext): RunSnapshot;
  cancel(runId: string, context: DomainContext): RunSnapshot;
  subscribe(runId: string, context: DomainContext): AsyncIterable<ChatEvent>;
  subscribeConversation(sessionId: string, context: DomainContext): AsyncIterable<ConversationEvent>;
}
export interface ClassificationSubject {
  kind: 'session' | 'entry' | 'recall' | 'commitment'; id: string;
  sourceRefs?: readonly SourceRef[];
}
export interface ChatConfig {
  ownerProfile?: OwnerProfileSnapshot;
  store: StorePort & { readonly assistantId: string }; domain: DomainPort; model: ModelPort | null;
  route: { provider: string; model: string; available: boolean; allows(classes: readonly DataClass[]): boolean;
    endpoint: string; apiVersion: string; keyReference: string; allowedClasses: readonly DataClass[] }; 
  preferences: ValidatedPreferences;
  classify(subject: ClassificationSubject, tx: Transaction): { ownerId: string; dataClass: DataClass; revision: number } | null;
  context: { budgets: CompileInput['budgets']; sources: readonly SourceAvailability[];
    recall?: { q: string; limit: number }; today?: { date: string; timeZone: string } };
  now?: () => number; id?: () => string; schedule?: (work: () => void) => void;
  deadlineMs?: number; subscriberCapacity?: number; maxPartialChars?: number;
}
export type ChatErrorCode = 'invalid_input' | 'unauthorized' | 'epoch_mismatch' | 'not_found' | 'idempotency_conflict' | 'active_run' | 'unavailable' | 'recovery_required' | 'invalid_retry' | 'consent_required' | 'consent_revoked' | 'route_changed' | 'selection_too_large';
export class ChatError extends Error {
  readonly localCapture = false;
  constructor(readonly code: ChatErrorCode) { super(`Chat request rejected: ${code}; no local capture by this request`); this.name = 'ChatError'; }
}
