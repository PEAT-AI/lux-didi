import { createHash } from 'node:crypto';
import { HOST_EVIDENCE } from '../tools/types.js';
import { redactSecrets } from '../tools/redact.js';
export const TASK_DISCLOSURE: unique symbol = Symbol('task-disclosure');
/** The only model-facing tool result. Text is evidence, never an instruction source. */
export type ResultStatus = 'ok' | 'empty' | 'no_match' | 'partial' | 'failed';
export interface Reference { id: string; title?: string; url?: string; match?: 'exact' | 'neighbour' }
export type TaskDisclosure = import('../tools/types.js').ModelSnapshot & { recordReuse?(): void };
export interface ToolResult {
  [TASK_DISCLOSURE]?: TaskDisclosure;
  dataClasses?: readonly import('../adapters/model/types.js').DataClass[];
  exposures?: import('./authority.js').Exposure[];
  status: ResultStatus;
  text: string;
  references: Reference[];
  next_cursor: string | null;
  coverage: string;
  repair: string | null;
  receipt?: { operation_id: string; state: 'committed' | 'failed' | 'unknown' };
}
export const DOCUMENT_CHARS = 24000;
export function failed(repair: string): ToolResult {
  return { status: 'failed', text: '', references: [], next_cursor: null, coverage: 'No verified result.', repair };
}
export function documentResult(text: string, id: string, cursor = '0'): ToolResult {
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) > text.length) return failed('Use the next_cursor returned by this document, or null to start again.');
  const start = Number(cursor), end = Math.min(start + DOCUMENT_CHARS, text.length);
  return { status: end < text.length ? 'partial' : text.length ? 'ok' : 'empty', text: text.slice(start, end), references: [{ id }],
    next_cursor: end < text.length ? String(end) : null, coverage: `Characters ${start} to ${end} of ${text.length}; ${end < text.length ? 'continue with next_cursor' : 'complete'}.`, repair: null };
}
export interface RankedItem { id: string; title: string; text?: string; url?: string }
const normalize = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('en').trim().replace(/\s+/g, ' ');
/** A name is exact only when its complete normalized title equals the query. No language inference. */
export function rankedResult(query: string, items: readonly RankedItem[]): ToolResult {
  const references: Reference[] = items.map(item => ({ id: item.id, title: item.title, ...(item.url ? { url: item.url } : {}), match: normalize(item.title) === normalize(query) ? 'exact' : 'neighbour' }));
  const exact = items.filter((_, index) => references[index]!.match === 'exact');
  return { status: !items.length ? 'empty' : exact.length ? 'ok' : 'no_match',
    text: exact.map(item => `${item.id}: ${item.title}\n${(item.text ?? '').slice(0, 500)}`).join('\n'), references, next_cursor: null,
    coverage: `${items.length} ranked candidates; ${exact.length} exact name matches. Neighbours are not matches and have not been opened.`, repair: null };
}

/** Redact before any task cache, journal, model or owner-facing projection. Host proofs stay host-only. */
export function redactTaskResult(result: ToolResult): ToolResult {
  const safe = redactSecrets(result), disclosure = result[TASK_DISCLOSURE];
  if (disclosure) {
    const snapshot = redactSecrets(disclosure), evidence = disclosure[HOST_EVIDENCE];
    if (evidence?.kind === 'remote-body') {
      const body = redactSecrets(evidence.body);
      snapshot[HOST_EVIDENCE] = { ...evidence, body, bodySha256: createHash('sha256').update(body).digest('hex') };
    } else if (evidence) snapshot[HOST_EVIDENCE] = evidence;
    safe[TASK_DISCLOSURE] = snapshot;
  }
  return safe;
}
