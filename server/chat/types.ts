import type { StorePort } from '../contracts/storage.js';
import type { DomainContext, DomainPort, SourceRef } from '../contracts/domain.js';
import type { DataClass, ModelPort, ModelStatus } from '../adapters/model/types.js';
import type { CompileInput, SourceAvailability, ValidatedPreferences } from '../prompt/index.js';

export type Outcome = ModelStatus | 'not_dispatched' | 'outcome_unknown' | 'unavailable' | 'input_too_large' | 'compile_failed' | 'persistence_failed';
export interface RunSnapshot {
  runId: string; sessionId: string; userEntryId: string; finalEntryId: string | null;
  /** Read from the durable Domain entry, never the provisional buffer. */
  finalText: string | null;
  retryOf: string | null; authorityEpoch: string; provider: string; model: string;
  promptVersion: string; state: 'accepted' | 'dispatch_intent' | 'terminal'; outcome: Outcome | null;
  sequence: number; partialText: string; partialTruncated: boolean;
  acceptedAt: string; intentAt: string | null; terminalAt: string | null;
}
export type ChatEvent = { type: 'snapshot'; sequence: number; run: RunSnapshot }
  | { type: 'text'; sequence: number; text: string; provisional: true }
  | { type: 'resync_required'; sequence: number; reason: 'backpressure' | 'storage_unavailable' };
export interface AcceptInput { sessionId: string; text: string; idempotencyKey: string; retryOf?: string }
export interface ChatPort {
  recover(context: DomainContext): RunSnapshot[];
  accept(input: AcceptInput, context: DomainContext): RunSnapshot;
  get(runId: string, context: DomainContext): RunSnapshot;
  cancel(runId: string, context: DomainContext): RunSnapshot;
  subscribe(runId: string, context: DomainContext): AsyncIterable<ChatEvent>;
}
export interface ClassificationSubject {
  kind: 'session' | 'entry' | 'recall' | 'commitment'; id: string;
  sourceRefs?: readonly SourceRef[];
}
export interface ChatConfig {
  store: StorePort & { readonly assistantId: string }; domain: DomainPort; model: ModelPort;
  route: { provider: string; model: string; available: boolean; allows(classes: readonly DataClass[]): boolean };
  preferences: ValidatedPreferences;
  classify(subject: ClassificationSubject): { ownerId: string; dataClass: DataClass } | null;
  context: { budgets: CompileInput['budgets']; sources: readonly SourceAvailability[];
    recall?: { q: string; limit: number }; today?: { date: string; timeZone: string } };
  now?: () => number; id?: () => string; schedule?: (work: () => void) => void;
  deadlineMs?: number; subscriberCapacity?: number; maxPartialChars?: number;
}
export type ChatErrorCode = 'invalid_input' | 'unauthorized' | 'epoch_mismatch' | 'not_found' | 'idempotency_conflict' | 'active_run' | 'unavailable' | 'recovery_required' | 'invalid_retry';
export class ChatError extends Error {
  readonly localCapture = false;
  constructor(readonly code: ChatErrorCode) { super(`Chat request rejected: ${code}; no local capture by this request`); this.name = 'ChatError'; }
}
