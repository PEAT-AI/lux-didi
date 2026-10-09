import type { SchemaMigration, Transaction } from './storage.js';
export interface SourceRef { id: string; label: string; provider?: string; accountId?: string; externalId?: string; sourceTimestamp: string | null; availability: 'present' | 'missing'; note?: string }
export interface Session { id: string; title: string; startedAt: string; endedAt: string | null; timeZone: string; revision: number }
export interface Entry { id: string; sessionId: string; sequence: number; role: 'user' | 'assistant' | 'system'; text: string; capturedAt: string; sourceRefs: SourceRef[] }
export interface Commitment { id: string; title: string; notes: string; dueAt: string | null; timeZone: string; status: 'active' | 'completed' | 'cancelled'; revision: number; sourceSessionId: string | null; sourceEntryId: string | null; createdAt: string; updatedAt: string }
export interface CommitmentHistory { revision: number; operation: string; recordedAt: string; title: string; notes: string; dueAt: string | null; timeZone: string; status: Commitment['status'] }
export interface DomainContext { assistantId: string; clientId: string; authorityEpoch: string; now: string }
export interface DomainOperations {
  createSession: { input: { title: string; timeZone: string }; output: Session };
  listSessions: { input: Record<string, never>; output: { items: Session[]; nextCursor: string | null } };
  getSession: { input: { id: string }; output: { session: Session; entries: Entry[]; nextCursor: string | null } };
  appendEntry: { input: { sessionId: string; text: string; role: 'user'; timeZone: string; sourceRef?: SourceRef }; output: Entry };
  recall: { input: { q: string; limit: number }; output: { hits: { sessionId: string; entryId?: string; snippet: string; sourceRefs: SourceRef[]; sourceTimestamp: string | null }[]; totalMatches: number; truncated: boolean; nextCursor: string | null } };
  createCommitment: { input: { title: string; notes?: string; dueAt: string | null; timeZone: string; sourceSessionId?: string | null; sourceEntryId?: string | null }; output: Commitment };
  listCommitments: { input: { status?: Commitment['status'] }; output: { items: Commitment[]; nextCursor: string | null } };
  getCommitment: { input: { id: string }; output: { commitment: Commitment; history: CommitmentHistory[] } };
  updateCommitment: { input: { id: string; expectedRevision: number; title?: string; notes?: string; dueAt?: string | null; timeZone?: string }; output: Commitment };
  transitionCommitment: { input: { id: string; expectedRevision: number; operation: 'complete' | 'cancel' | 'reopen' }; output: Commitment };
  plan: { input: { date: string; timeZone: string }; output: { date: string; timeZone: string; items: { commitment: Commitment; isOverdue: boolean }[]; unscheduled: Commitment[]; nextCursor: string | null } };
}
export type DomainOperation = keyof DomainOperations;
export interface DomainPort {
  readonly migrations: readonly SchemaMigration[];
  execute<K extends DomainOperation>(tx: Transaction, operation: K, input: DomainOperations[K]['input'], context: DomainContext): DomainOperations[K]['output'];
}
