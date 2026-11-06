/**
 * FR1: the host's own first line of evidence. On a cued final it turns what she already has locally (the
 * bounded history read and the cached calendar digest) into ONE provisional commentary group, marked as
 * local recall, so her first words can carry a real fact while the helper is still working. No model, no
 * network, no text when nothing matched, and never a claim that the helper answered.
 */
import type { RecentHit, RecentSearch } from '../domain/history-reader.js';
import type { Commentary } from '../tasks/delivery.js';
import type { CueClass } from './memory-cues.js';

/** The whole local read, both sources included, is bounded by this many milliseconds. */
export const FAST_EVIDENCE_BUDGET_MS = 100;
/** The plain marker her words can quote: local, provisional, and the helper is still checking. */
export const FAST_EVIDENCE_MARKER = 'Local recall, provisional, the helper is still checking:';
const MAX_FACTS = 5;
const FACT_CHARS = 240;

export type FastEvidenceOutcome = 'found' | 'empty' | 'unavailable' | 'none';

export interface FastEvidenceInput {
  /** The owner's finished words, which are also the search query. */
  readonly text: string;
  /** The cue classes the classifier found; an empty list means an ordinary turn, which reads nothing. */
  readonly cues: readonly CueClass[];
  /** The host's bounded history read. Called only for a memory cue. */
  readonly history: (query: string) => RecentSearch;
  /** The session's cached calendar digest, absent when the host holds no fresh one. */
  readonly calendar: string | undefined;
  /** Trusted clock, so the budget is a seam rather than a real timer in a test. */
  readonly now: () => number;
  readonly budgetMs?: number;
}

export interface FastEvidenceResult {
  readonly commentary: Commentary | null;
  readonly outcome: FastEvidenceOutcome;
  readonly hits: number;
  readonly elapsedMs: number;
}

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** One spoken line per fact: flat, dated, bounded, never a paragraph. */
const flat = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > FACT_CHARS ? `${line.slice(0, FACT_CHARS - 3)}...` : line;
};

export function buildFastEvidence(input: FastEvidenceInput): FastEvidenceResult {
  if (!input.cues.length) return { commentary: null, outcome: 'none', hits: 0, elapsedMs: 0 };
  const budgetMs = input.budgetMs ?? FAST_EVIDENCE_BUDGET_MS;
  const started = input.now();
  const elapsed = (): number => Math.max(0, input.now() - started);
  const facts: string[] = [];
  let hits = 0, unavailable = false;
  if (input.cues.includes('memory')) {
    let search: RecentSearch | undefined;
    try { search = input.history(input.text); } catch { unavailable = true; }
    if (search?.outcome === 'unavailable') unavailable = true;
    else if (search?.outcome === 'found') {
      hits = search.hits.length;
      for (const hit of search.hits.slice(0, MAX_FACTS)) facts.push(factOf(hit));
    }
  }
  if (input.cues.includes('calendar') && input.calendar?.trim()) facts.push(`today: ${flat(input.calendar)}`);
  const elapsedMs = elapsed();
  if (unavailable) return { commentary: null, outcome: 'unavailable', hits, elapsedMs };
  if (elapsedMs > budgetMs) return { commentary: null, outcome: 'unavailable', hits, elapsedMs };
  const content = [FAST_EVIDENCE_MARKER, ...facts.slice(0, MAX_FACTS).filter(fact => fact.length)].join('\n');
  if (content === FAST_EVIDENCE_MARKER) return { commentary: null, outcome: 'empty', hits, elapsedMs };
  return {
    commentary: { kind: 'partial', exact: [], content, cause: '', what_failed: '', next_step: '' },
    outcome: 'found', hits, elapsedMs,
  };
}

const factOf = (hit: RecentHit): string => {
  const excerpt = flat(hit.excerpt);
  return excerpt ? `${day(hit.at)}: ${excerpt}` : '';
};
