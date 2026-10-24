import type { JsonObject, ToolResultRef } from '../adapters/model/types.js';

export const RECEIVED_BODY = { name: 'read_received_body', accountId: 'gateway:received-body', resourceId: 'current-run' } as const;
export const RECEIVED_BODY_TOOLS: ReadonlySet<string> = new Set(['get_insight', 'gmail_read_message', 'read', 'get_company', 'list_tickets']);
export const RECEIVED_BODY_PARAMETERS = { type: 'object', properties: { cursor: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['cursor'], additionalProperties: false };
export interface RemoteResultLineage { executionId: string; name: string; callId?: string; result: ToolResultRef }
export interface ReceivedBodyPage {
  runId: string; maxResultBytes: number; rootCursor: string; parent: RemoteResultLineage; argumentsHash: string;
  offset: number; end: number; nextCursor?: string; completed?: ToolResultRef;
}
export function receivedBodyArguments(value: unknown): value is { cursor: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'cursor') && typeof (value as { cursor?: unknown }).cursor === 'string' && (value as { cursor: string }).cursor.length > 0 && (value as { cursor: string }).cursor.length <= 128;
}
export function receivedBodyEnd(body: string, offset: number, maxResultBytes: number): number {
  let end = Math.min(body.length, offset + Math.max(2, Math.min(16000, Math.floor((maxResultBytes - 1536) / 8))));
  if (end < body.length && /[\uD800-\uDBFF]/u.test(body.slice(end - 1, end))) end--;
  return end;
}
/** Canonical preparation is distinct from receipt by a model or a person. */
function record(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function receivedBodyCoverage(responses: readonly JsonObject[], observed: readonly JsonObject[] = []): JsonObject[] {
  const parents = new Map<string, JsonObject>();
  for (const response of responses) {
    const original = response['bodyContinuation'];
    if (record(original) && typeof original['cursor'] === 'string') parents.set(original['cursor'], { ...original, preparedEnd: 0, modelContextEnd: 0 });
  }
  for (const response of responses) {
    const coverage = response['bodyCoverage'];
    if (!record(coverage) || typeof coverage['rootCursor'] !== 'string' || !Number.isSafeInteger(coverage['offset']) || !Number.isSafeInteger(coverage['end'])) continue;
    const parent = parents.get(coverage['rootCursor']);
    if (parent && Number(coverage['offset']) === Number(parent['preparedEnd'])) parent['preparedEnd'] = coverage['end'];
  }
  for (const response of observed) {
    const coverage = response['bodyCoverage'];
    if (!record(coverage) || typeof coverage['rootCursor'] !== 'string' || !Number.isSafeInteger(coverage['offset']) || !Number.isSafeInteger(coverage['end'])) continue;
    const parent = parents.get(coverage['rootCursor']);
    if (parent && Number(coverage['offset']) === Number(parent['modelContextEnd'])) parent['modelContextEnd'] = coverage['end'];
  }
  return [...parents.values()].map(parent => ({ ...parent, stage: 'canonical-preparation', modelContextStage: 'response-observed', preparedRemaining: Math.max(0, Number(parent['total']) - Number(parent['preparedEnd'])), remaining: Math.max(0, Number(parent['total']) - Number(parent['modelContextEnd'])), remainingRange: { offset: parent['modelContextEnd'], end: parent['total'], unit: 'utf16' } }));
}
