import type { OwnerProfileSnapshot } from '../prompt/types.js';
import type { StorePort, Transaction } from '../contracts/storage.js';
import type { DomainContext, DomainPort, SourceRef, RoutingLabel, RoutingLabelCorrection } from '../contracts/domain.js';
import type { DataClass, ModelControl, ModelPort, ModelRequest, ModelStatus, ToolDefinition, ToolResultRef } from '../adapters/model/types.js';
import type { LoopResult } from '../adapters/model/types.js';
import type { CredentialBindingReceipt } from '../config/index.js';
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
  /** Durable tool result references projected from the accepted owner journal; never transient MCP buffers. */
  toolReferences: ToolResultRef[];
  /** Plain trusted source identifiers derived by the owning projection, never a model-supplied URL. */
  sourceIds: string[];
  /** Accepted tool binding hash for this run, or '' when the run advertised no tools. */
  toolBindingHash: string;
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
  /** Explicit bounded connection selection for this turn; trusted in-process only, never model text or HTTP-supplied authority. */
  selectedConnectionIds?: readonly string[];
}
/** Immutable accepted-run binding passed to the trusted owner assembly. */
export interface RunBinding {
  runId: string; sessionId: string; actorId: string; authorityEpoch: string; revision: number;
  connectionIds: readonly string[];
  route: { identity: string; provider: string; model: string; allowedClasses: readonly DataClass[] };
  /** Absolute deadline on the injected clock; set at dispatch, absent at acceptance. */
  deadlineMs?: number;
}
/** Chat-owned synchronous current-authority snapshot reused by the final-egress guard. */
export interface CurrentAuthority {
  policyVersion: number; consentRevision: number; routeIdentity: string;
  selectedLabels: { kind: 'session' | 'entry'; id: string; revision: number; dataClass: string }[];
  bindingHash: string;
}
/** A per-run loop runner over the accepted tool set; ordinary ModelPort semantics are preserved underneath. */
export interface RunRunner { run(request: ModelRequest, control: ModelControl): Promise<LoopResult> }
/** Immutable completed-call receipt projected from the owner: ref + call association + validated connection provenance. */
export interface ToolReceipt {
  executionId: string; name: string;
  result: { id: string; sha256: string };
  connection: { connectionId: string; generation: number; sha256: string };
}
/** Narrow trusted composition seam. The Host owns it; Chat only calls it and never parses model text for authority. */
export interface ChatToolComposition {
  /** Inside the caller acceptance transaction: write the accepted snapshot/link atomically. */
  accept(tx: Transaction, binding: RunBinding): { hash: string; credential: CredentialBindingReceipt | null };
  /** Detached accepted definitions after commit; never a fresh live catalog. */
  definitions(runId: string): ToolDefinition[];
  /** Read-only immutable completed-call receipts for the accepted run; no authority, no provider ids. */
  receipts(runId: string): ToolReceipt[];
  /** Per-run runner bound to the accepted run and its synchronous current-authority callback. */
  runner(runId: string, deadlineMs: number, current: () => CurrentAuthority): RunRunner;
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
  /** Trusted Host composition seam. Absent means a text-only turn with no tool capability. */
  tools?: ChatToolComposition;
  now?: () => number; id?: () => string; schedule?: (work: () => void) => void;
  deadlineMs?: number; subscriberCapacity?: number; maxPartialChars?: number;
}
export type ChatErrorCode = 'invalid_input' | 'unauthorized' | 'epoch_mismatch' | 'not_found' | 'idempotency_conflict' | 'active_run' | 'unavailable' | 'recovery_required' | 'invalid_retry' | 'consent_required' | 'consent_revoked' | 'route_changed' | 'selection_too_large';
export class ChatError extends Error {
  readonly localCapture = false;
  constructor(readonly code: ChatErrorCode) { super(`Chat request rejected: ${code}; no local capture by this request`); this.name = 'ChatError'; }
}
