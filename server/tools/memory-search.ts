import type { Transaction } from '../contracts/storage.js';
import { recall } from '../domain/memory.js';
import { listSummaries } from '../domain/summaries.js';
import { fold, tokenize } from '../domain/util.js';

/**
 * K6: Naya's own memory as a research source. A local read over what she already has, no network:
 * conversation entries labelled ordinary (the notes the owner asked her to keep), conversation
 * summaries of any age, and imported standing memory when a reader for it is supplied (the K5
 * `import-history` wagon). Ranked by match then recency and bounded like the other sources.
 */
export const MEMORY = Object.freeze({ lines: 12, lineChars: 240, pool: 40 });

export type MemoryKind = 'entry' | 'summary' | 'imported';

/** One candidate memory line before ranking: its text, where it came from and when. */
export interface MemoryRecord { kind: MemoryKind; text: string; at: number }

/** The bounded result one memory lookup returns, shaped like a research source's block. */
export interface MemoryLookup { text: string; lines: string[]; total: number }

/**
 * Imported standing memory: K5's `import-history` entries. Supplied by the composition that holds
 * that store, so a build without it reads entries and summaries only.
 */
export type ImportedMemory = (tx: Transaction, query: string, limit: number) => readonly MemoryRecord[];

function stamp(at: number): string {
  return new Date(Number.isFinite(at) ? at : 0).toISOString().slice(0, 10);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function line(record: MemoryRecord): string {
  return `${stamp(record.at)} ${record.kind}: ${clip(record.text, MEMORY.lineChars)}`;
}

/**
 * Match then recency: records sharing more query tokens lead, ties go to the newer one. A query
 * whose tokens match nothing falls back to the newest, so "what did we talk about" still answers.
 */
export function rankMemory(records: readonly MemoryRecord[], query: string, limit: number = MEMORY.lines): MemoryRecord[] {
  const tokens = tokenize(query);
  const scored = records.map(record => {
    const folded = fold(record.text);
    return { record, score: tokens.filter(token => folded.includes(token)).length };
  });
  scored.sort((left, right) => right.score - left.score || right.record.at - left.record.at);
  const matched = scored.filter(entry => entry.score > 0);
  return (matched.length > 0 ? matched : scored).slice(0, Math.max(0, limit)).map(entry => entry.record);
}

/** The bounded lookup: ordinary conversation entries, every summary, and imported memory if given. */
export function memoryLookup(tx: Transaction, query: string, opts: { imported?: ImportedMemory | undefined; limit?: number | undefined } = {}): MemoryLookup {
  const records: MemoryRecord[] = [];
  for (const hit of recall(tx, query, MEMORY.pool, { eligibility: 'ordinary-entry-and-parent' }).hits) {
    records.push({ kind: 'entry', text: hit.snippet, at: hit.sourceTimestamp });
  }
  for (const summary of listSummaries(tx)) {
    if (summary.status !== 'complete' || summary.summary === null) continue;
    records.push({ kind: 'summary', text: summary.summary, at: summary.endedAt ?? summary.createdAt });
  }
  if (opts.imported !== undefined) records.push(...opts.imported(tx, query, MEMORY.pool));
  const lines = rankMemory(records, query, opts.limit ?? MEMORY.lines).map(line);
  return { text: lines.join('\n'), lines, total: records.length };
}
