import type { EntryRecord, RecallResult, ResolvedEntryRecord, SessionRecord, SourceRefRecord } from './memory.js';
import type { CommitmentRecord, CommitmentStatus, DailyPlan, HistoryRecord } from './commitments.js';
import type { ResolvedEntry } from './contract.js';
import { toIso } from './util.js';

// Transport-blind DTO serializers. Shapes follow SERVICE-CONTRACT and
// server/contracts/domain.ts exactly: instants are ISO8601 UTC strings, ids are
// UUID strings, revision a positive integer, timeZone an IANA name.

export interface SessionDTO {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  timeZone: string;
  revision: number;
}

export interface SourceRefDTO {
  id: string;
  label: string;
  provider?: string;
  accountId?: string;
  externalId?: string;
  sourceTimestamp: string | null;
  availability: 'present' | 'missing';
  note?: string;
}

export interface EntryDTO {
  id: string;
  sessionId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  capturedAt: string;
  sourceRefs: SourceRefDTO[];
}

export interface CommitmentDTO {
  id: string;
  title: string;
  notes: string;
  dueAt: string | null;
  timeZone: string;
  status: CommitmentStatus;
  revision: number;
  sourceSessionId: string | null;
  sourceEntryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryDTO {
  revision: number;
  operation: string;
  recordedAt: string;
  title: string;
  notes: string;
  dueAt: string | null;
  timeZone: string;
  status: CommitmentStatus;
}

export interface RecallHitDTO {
  sessionId: string;
  entryId?: string;
  snippet: string;
  sourceRefs: SourceRefDTO[];
  sourceTimestamp: string | null;
}

export interface RecallDTO {
  hits: RecallHitDTO[];
  totalMatches: number;
  truncated: boolean;
  nextCursor: null;
}

export interface PlanDTO {
  date: string;
  timeZone: string;
  items: { commitment: CommitmentDTO; isOverdue: boolean }[];
  unscheduled: CommitmentDTO[];
  nextCursor: null;
}

function optionalString(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

export function toSourceRefDTO(ref: SourceRefRecord): SourceRefDTO {
  const dto: SourceRefDTO = {
    id: ref.id,
    label: ref.label,
    sourceTimestamp: toIso(ref.sourceTimestamp),
    availability: ref.availability,
  };
  const provider = optionalString(ref.provider);
  const accountId = optionalString(ref.accountId);
  const externalId = optionalString(ref.externalId);
  const note = optionalString(ref.note);
  if (provider !== undefined) dto.provider = provider;
  if (accountId !== undefined) dto.accountId = accountId;
  if (externalId !== undefined) dto.externalId = externalId;
  if (note !== undefined) dto.note = note;
  return dto;
}

export function toSessionDTO(s: SessionRecord): SessionDTO {
  return {
    id: s.id,
    title: s.title,
    startedAt: toIso(s.startedAt)!,
    endedAt: toIso(s.endedAt),
    timeZone: s.timeZone,
    revision: s.revision,
  };
}

export function toEntryDTO(e: EntryRecord, sourceRefs: SourceRefRecord[]): EntryDTO {
  return {
    id: e.id,
    sessionId: e.sessionId,
    sequence: e.sequence,
    role: e.role,
    text: e.text,
    capturedAt: toIso(e.capturedAt)!,
    sourceRefs: sourceRefs.map(toSourceRefDTO),
  };
}

export function toResolvedEntryDTO(r: ResolvedEntryRecord): ResolvedEntry {
  return {
    entryId: r.entryId,
    sessionId: r.sessionId,
    text: r.text,
    role: r.role,
    capturedAt: toIso(r.capturedAt)!,
    sourceTimestamp: toIso(r.sourceTimestamp),
    sourceRefs: r.sourceRefs.map(toSourceRefDTO),
  };
}

export function toCommitmentDTO(c: CommitmentRecord): CommitmentDTO {
  return {
    id: c.id,
    title: c.title,
    notes: c.notes,
    dueAt: toIso(c.dueAt),
    timeZone: c.dueTimeZone ?? 'UTC',
    status: c.status,
    revision: c.revision,
    sourceSessionId: c.sourceSessionId,
    sourceEntryId: c.sourceEntryId,
    createdAt: toIso(c.createdAt)!,
    updatedAt: toIso(c.updatedAt)!,
  };
}

export function toHistoryDTO(h: HistoryRecord): HistoryDTO {
  return {
    revision: h.revision,
    operation: h.operation,
    recordedAt: toIso(h.recordedAt)!,
    title: h.title,
    notes: h.notes,
    dueAt: toIso(h.dueAt),
    timeZone: h.dueTimeZone ?? 'UTC',
    status: h.status,
  };
}

export function toRecallDTO(result: RecallResult): RecallDTO {
  return {
    hits: result.hits.map((h) => ({
      sessionId: h.sessionId,
      entryId: h.entryId,
      snippet: h.snippet,
      sourceRefs: h.sourceRefs.map(toSourceRefDTO),
      sourceTimestamp: toIso(h.sourceTimestamp),
    })),
    totalMatches: result.totalMatches,
    truncated: result.truncated,
    nextCursor: null,
  };
}

export function toPlanDTO(plan: DailyPlan): PlanDTO {
  return {
    date: plan.date,
    timeZone: plan.timeZone,
    items: plan.items.map((i) => ({
      commitment: toCommitmentDTO(i.commitment),
      isOverdue: i.isOverdue,
    })),
    unscheduled: plan.unscheduled.map(toCommitmentDTO),
    nextCursor: null,
  };
}
