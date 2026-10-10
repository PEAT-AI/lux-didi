import type { ResolvedEntry } from '../contracts/domain.js';
import { ChatError, type MemorySelectionSnapshot } from './types.js';

/** One explicit bounded batch of local records selected for a turn. */
export const MAX_SELECTED_MEMORY_ENTRIES = 32;
/** Explicit storage capacity in serialized UTF-8 bytes; records are never silently capped. */
export const MAX_SERIALIZED_SELECTION_BYTES = 100000;
/** Evidence id prefix that keeps selected records distinguishable in the run trace. */
export const SELECTED_EVIDENCE_PREFIX = 'selected:';
export const selectedEvidenceId = (entryId: string): string => `${SELECTED_EVIDENCE_PREFIX}${entryId}`;

export interface RunSelection {
  requestedIds: string[];
  records: ResolvedEntry[];
}

/**
 * Canonical selection: bounded array of non-empty canonical ids, duplicates
 * coalesced and sorted. Absent and `[]` both mean empty. An invalid shape is
 * refused before any capture; duplicate values are normalized, never rejected.
 */
export function normalizeSelectedMemory(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SELECTED_MEMORY_ENTRIES) throw new ChatError('invalid_input');
  const unique = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ChatError('invalid_input');
    unique.add(value);
  }
  return [...unique].sort();
}

/**
 * Safe requested/used/omitted metadata for a run. `manifest` is the frozen
 * compiler manifest, or null until the prompt has frozen; used/omitted ids are
 * derived only from that manifest, never from re-read record content.
 */
export function memorySelectionSnapshot(
  requestedIds: readonly string[],
  manifest: { selectedIds?: readonly string[]; omitted?: readonly { id: string; reason: string }[] } | null,
): MemorySelectionSnapshot {
  const selected = new Set(manifest?.selectedIds ?? []);
  const reasons = new Map((manifest?.omitted ?? []).map((o) => [o.id, o.reason] as const));
  const usedIds: string[] = [];
  const omitted: MemorySelectionSnapshot['omitted'] = [];
  for (const id of requestedIds) {
    if (selected.has(selectedEvidenceId(id))) usedIds.push(id);
    else {
      const reason = reasons.get(selectedEvidenceId(id));
      omitted.push({ id, reason: reason === 'oversized' ? 'oversized' : reason === 'budget' ? 'budget' : 'not_included' });
    }
  }
  return {
    schemaVersion: 1,
    requestedIds: [...requestedIds],
    usedIds,
    omitted,
    counts: { requested: requestedIds.length, used: usedIds.length, omitted: omitted.length },
    frozen: manifest !== null,
  };
}
