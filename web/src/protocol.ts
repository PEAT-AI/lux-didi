// DTOs mirror SERVICE-CONTRACT.md. No scheduling or business rules live here.
export interface SourceRef { id: string; label: string; provider?: string; accountId?: string; externalId?: string; sourceTimestamp: string | null; availability: 'present' | 'missing'; note?: string }
export interface Session { id: string; title: string; startedAt: string; endedAt: string | null; timeZone: string; revision: number }
export interface Entry { id: string; sessionId: string; sequence: number; role: 'user' | 'assistant' | 'system'; text: string; capturedAt: string; sourceRefs: SourceRef[] }
export interface Commitment { id: string; title: string; notes: string; dueAt: string | null; timeZone: string; status: 'active' | 'completed' | 'cancelled'; revision: number; sourceSessionId: string | null; sourceEntryId: string | null; createdAt: string; updatedAt: string }
export interface Plan { date: string; timeZone: string; items: { commitment: Commitment; isOverdue: boolean }[]; unscheduled: Commitment[]; nextCursor: string | null }
export interface Recall { hits: { sessionId: string; entryId?: string; snippet: string; sourceRefs: SourceRef[]; sourceTimestamp: string | null }[]; totalMatches: number; truncated: boolean; nextCursor: string | null }
/** Safe per-run memory-selection metadata: ids, counts and omit reasons only, never note text. */
export interface MemorySelectionSnapshot { schemaVersion: 1; requestedIds: string[]; usedIds: string[]; omitted: { id: string; reason: 'budget' | 'oversized' | 'not_included' }[]; counts: { requested: number; used: number; omitted: number }; frozen: boolean }
export interface Status { assistantId: string; authorityEpoch: string; serviceMode: string; capabilities: { memory: boolean; commitments: boolean; notifications: boolean; model: boolean }; model: { configured: boolean; provider?: string; model?: string }; sources: SourceRef[] }
export interface CommitmentDetail { commitment: Commitment; history: { revision: number; operation: string; recordedAt: string; title: string; notes: string; dueAt: string | null; timeZone: string; status: Commitment['status'] }[] }

/** Safe current presentation only; no authored profile/version/path. */
export interface ConnectedRouteStatus {
  status: 'unconfigured' | 'disabled' | 'error' | 'configured'; provider?: string; model?: string; code?: string;
  displayName?: string;
}
export interface OwnerProfileStatus { status: 'default' | 'configured'; displayName: string }
