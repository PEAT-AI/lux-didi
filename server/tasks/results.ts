import type { ToolFailureCode } from '../adapters/model/types.js';
import { hostLogEvent } from '../tools/host-events.js';
import { createHash } from 'node:crypto';
import { HOST_EVIDENCE } from '../tools/types.js';
import { redactSecrets, redactSecretsWithCount } from '../tools/redact.js';
export const TASK_DISCLOSURE: unique symbol = Symbol('task-disclosure');
/** Host-classified connector failures, never raw connector text or a model field. */
export const TASK_CONNECTOR_FAILURE = Symbol('task-connector-failure');
export const TASK_CONNECTOR_FAILURE_CODE = Symbol('task-connector-outcome');
export const connectorFailures = new WeakMap<object, { code: ToolFailureCode; repair: string; nativeCode?: string }>();
/** Content-free connector diagnostics. Raw reason strings never cross the log boundary. */
export type ConnectorFailureKind = 'grant_missing' | 'bad_reference' | 'not_found' | 'upstream_unavailable' | 'upstream_rejected' | 'unknown';
export function connectorFailureKind(reason: unknown): ConnectorFailureKind {
  const code = typeof reason === 'string' ? reason.replace(/-/g, '_') : '';
  if (['grant_absent', 'grant_stale', 'grant_not_read', 'tool_not_granted'].includes(code)) return 'grant_missing';
  if (['invalid_message_id', 'invalid_file_id', 'wrong_source_id', 'bad_reference'].includes(code)) return 'bad_reference';
  if (['not_found', 'message_not_found', 'file_not_found'].includes(code)) return 'not_found';
  if (['source_unavailable', 'connector_error', 'provider_failure', 'network_error', 'timeout', 'native_timeout', 'child_exited', 'pipe_closed'].includes(code)) return 'upstream_unavailable';
  if (['tool_argument', 'tool_unknown', 'upstream_rejected'].includes(code)) return 'upstream_rejected';
  return 'unknown';
}
/** The only model-facing tool result. Text is evidence, never an instruction source. */
export const FAILURE_CATEGORIES = ['not_found', 'wrong_source_id', 'invalid_argument', 'unauthorized', 'timeout', 'unavailable', 'upstream_error', 'cancelled'] as const;
export type FailureCategory = typeof FAILURE_CATEGORIES[number];
/**
 * Council (standard round): one closed reason per failed result. A search that matches nothing is a normal
 * outcome rather than a failure, an empty read is a failure with its own reason, and raw connector text
 * never becomes a reason. Every value is a plain word, so it survives JSON where a symbol does not.
 */
export const REASON_CODES = ['no_access', 'sign_in_needed', 'not_found', 'wrong_id', 'bad_argument', 'timeout', 'rate_limited',
  'source_down', 'empty_content', 'not_configured', 'cancelled', 'invalid_result', 'unknown'] as const;
export type ReasonCode = typeof REASON_CODES[number];
export function isReasonCode(value: unknown): value is ReasonCode { return (REASON_CODES as readonly string[]).includes(String(value)); }
const CATEGORY_REASON: Record<FailureCategory, ReasonCode> = { not_found: 'not_found', wrong_source_id: 'wrong_id', invalid_argument: 'bad_argument',
  unauthorized: 'no_access', timeout: 'timeout', unavailable: 'source_down', upstream_error: 'unknown', cancelled: 'cancelled' };
export function reasonForCategory(category: FailureCategory): ReasonCode { return CATEGORY_REASON[category]; }
/** The meaning a connector refusal code or reason string already carries, before any category folds it. */
const REASON_MEANING: readonly (readonly [string, ReasonCode])[] = [
  ['not_granted', 'no_access'], ['restricted', 'no_access'], ['endpoint_not_allowed', 'no_access'], ['unauthorized', 'no_access'],
  ['not_allowed', 'no_access'], ['forbidden', 'no_access'], ['permission_denied', 'no_access'], ['not_owner_words', 'no_access'],
  ['not_signed_in', 'sign_in_needed'], ['sign_in_needed', 'sign_in_needed'], ['auth_failed', 'sign_in_needed'], ['needs_login', 'sign_in_needed'],
  ['credential_revoked', 'sign_in_needed'], ['credential_mismatch', 'sign_in_needed'], ['reauth_required', 'sign_in_needed'],
  ['rate_limited', 'rate_limited'], ['too_many_requests', 'rate_limited'],
  ['timeout', 'timeout'], ['native_timeout', 'timeout'], ['timed_out', 'timeout'], ['deadline_exceeded', 'timeout'],
  ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['aborted', 'cancelled'],
  ['not_found', 'not_found'], ['channel_not_found', 'not_found'], ['no_such_channel', 'not_found'], ['missing_result', 'not_found'],
  ['wrong_source_id', 'wrong_id'], ['wrong_id', 'wrong_id'], ['id_mismatch', 'wrong_id'], ['ref_mismatch', 'wrong_id'],
  ['invalid_arguments', 'bad_argument'], ['invalid_argument', 'bad_argument'], ['invalid_args', 'bad_argument'], ['bad_argument', 'bad_argument'],
  ['cursor_invalid', 'bad_argument'], ['cursor_stale', 'bad_argument'], ['kind_mismatch', 'bad_argument'], ['no_open_intent', 'bad_argument'],
  ['executor_intent_mismatch', 'bad_argument'], ['ambiguous', 'bad_argument'],
  ['empty_content', 'empty_content'], ['no_content', 'empty_content'], ['empty_body', 'empty_content'],
  ['not_configured', 'not_configured'], ['unknown_connector', 'not_configured'], ['unknown_connector_tool', 'not_configured'],
  ['missing_credential', 'not_configured'], ['missing_configuration', 'not_configured'],
  ['unavailable', 'source_down'], ['source_down', 'source_down'], ['connector_error', 'source_down'], ['child_exited', 'source_down'],
  ['pipe_closed', 'source_down'], ['open_web_failed', 'source_down'], ['result_store_unavailable', 'source_down'],
  ['network_error', 'source_down'], ['econnrefused', 'source_down'], ['enotfound', 'source_down'], ['connection_reset', 'source_down'],
  ['invalid_result', 'invalid_result'], ['sdk_protocol_rejected', 'invalid_result'], ['handler_outcome', 'invalid_result'],
  ['result_store_full', 'invalid_result'], ['result_store_oversize', 'invalid_result'], ['schema_rejected', 'invalid_result'],
];
/** A connector status line arrives as prose; only a decisive marker in it changes the meaning. */
const REASON_PROSE: readonly (readonly [RegExp, ReasonCode])[] = [
  [/\bsign(ing)?[ _-]?in\b|\breauth/, 'sign_in_needed'],
  [/\brate[ _-]?limit|\b429\b/, 'rate_limited'],
  [/\btimed? out?\b/, 'timeout'],
  [/\bnot granted\b|\bno access\b|\bpermission\b|\bforbidden\b/, 'no_access'],
  [/\bnot configured\b|\bno configuration\b|\bnot set up\b/, 'not_configured'],
  [/\bnot found\b|\bno such\b/, 'not_found'],
  [/\bunavailable\b|\boffline\b|\bconnection\b|\bchild exited\b/, 'source_down'],
  [/\binvalid\b|\bmalformed\b/, 'invalid_result'],
];
export function reasonCodeFor(reason: unknown): ReasonCode {
  const value = typeof reason === 'string' ? reason.trim().toLocaleLowerCase('en') : '';
  for (const [token, code] of REASON_MEANING) if (value === token) return code;
  if (value.startsWith('invalid_')) return 'bad_argument';
  if (value.startsWith('missing_')) return 'bad_argument';
  for (const [pattern, code] of REASON_PROSE) if (pattern.test(value)) return code;
  return 'unknown';
}
export function failureCategory(reason: unknown): FailureCategory {
  switch (reason) {
    case 'not_found': case 'not-found': return 'not_found';
    case 'wrong_source_id': return 'wrong_source_id';
    case 'invalid_arguments': case 'invalid-arguments': case 'invalid_argument': case 'cursor_invalid': case 'cursor_stale': return 'invalid_argument';
    case 'restricted': case 'not_granted': case 'unauthorized': case 'endpoint_not_allowed': return 'unauthorized';
    case 'timeout': case 'native_timeout': return 'timeout';
    case 'cancelled': case 'aborted': return 'cancelled';
    case 'data_not_connected': case 'unavailable': case 'result_store_unavailable': return 'unavailable';
    default: return 'upstream_error';
  }
}
export function readerFailure(name: string, category: FailureCategory, reason: ReasonCode = reasonForCategory(category)): ToolResult {
  const identifier = category === 'wrong_source_id' ? 'Search again and read an id the search returned.'
    : name === 'read_memory' ? 'Use an entry id returned by search_memory, passed as ref.'
    : name === 'read_company' ? 'Use the ref returned by search_company and pass that ref verbatim, never a numeric record id.'
    : 'Search this source again and use its returned identifier verbatim.';
  const action = category === 'unauthorized' ? 'Check this source permission or use another approved source.'
    : category === 'timeout' || category === 'unavailable' || category === 'upstream_error' ? 'Retry this source or use other verified findings.'
    : category === 'cancelled' ? 'Continue in the current task using verified findings.' : 'Repair the identifier or cursor before retrying.';
  hostLogEvent({ event: 'tool_failure', tool: name, category });
  return failed(`${category === 'not_found' ? 'Search again and read an id the search returned. ' : ''}${identifier} ${action} This read did not complete; do not infer absence.`, category, reason);
}
export type ResultStatus = 'ok' | 'empty' | 'no_match' | 'partial' | 'failed';
export interface Reference { id: string; title?: string; url?: string; match?: 'exact' | 'neighbour'; rank?: number; snippet_status?: 'not_supplied' }
export type TaskDisclosure = import('../tools/types.js').ModelSnapshot & { recordReuse?(): void; recordRedaction?(tool: string, count: number): void };
export interface ToolResult {
  [TASK_DISCLOSURE]?: TaskDisclosure;
  [TASK_CONNECTOR_FAILURE]?: string;
  [TASK_CONNECTOR_FAILURE_CODE]?: ToolFailureCode;
  dataClasses?: readonly import('../adapters/model/types.js').DataClass[];
  exposures?: import('./authority.js').Exposure[];
  failure_category?: FailureCategory;
  /** The closed reason a failure names, and nothing at all on a resolved read or a search. */
  reason_code?: ReasonCode;
  status: ResultStatus;
  text: string;
  references: Reference[];
  next_cursor: string | null;
  coverage: string;
  repair: string | null;
  receipt?: { operation_id: string; state: 'committed' | 'failed' | 'unknown' };
}
export const DOCUMENT_CHARS = 24000;
export function failed(repair: string, category: FailureCategory = 'upstream_error', reason: ReasonCode = reasonForCategory(category)): ToolResult {
  return { failure_category: category, reason_code: reason, status: 'failed', text: '', references: [], next_cursor: null, coverage: 'No verified result.', repair };
}
/** A failed result that arrived without a reason still names one, so no reader has to guess at it. */
export function closedFailure(result: ToolResult): ToolResult {
  return result.status === 'failed' && !isReasonCode(result.reason_code) ? { ...result, reason_code: 'unknown' } : result;
}
export function documentResult(text: string, id: string, cursor = '0'): ToolResult {
  const version = createHash('sha256').update(id).update('\0').update(text).digest('hex');
  const continuation = /^v1:([a-f0-9]{64}):(\d+)$/.exec(cursor);
  if (cursor !== '0' && (!continuation || continuation[1] !== version)) return failed('The document or continuation changed. Restart with cursor null; never combine pages from different versions.', 'invalid_argument');
  if (!text.trim()) return failed('The read returned no usable text. Search again for a readable identifier; do not infer absence.', 'upstream_error', 'empty_content');
  const start = cursor === '0' ? 0 : Number(continuation![2]);
  if (!Number.isSafeInteger(start) || start > text.length) return failed('Use the next_cursor returned by this document, or null to restart.', 'invalid_argument');
  const end = Math.min(start + DOCUMENT_CHARS, text.length);
  return { status: end < text.length ? 'partial' : text.length ? 'ok' : 'empty', text: text.slice(start, end), references: [{ id }],
    next_cursor: end < text.length ? `v1:${version}:${end}` : null, coverage: `Characters ${start} to ${end} of ${text.length}; ${end < text.length ? 'continue with next_cursor' : 'complete'}.`, repair: null };
}
export interface RankedItem { id: string; title: string; text?: string; url?: string; snippet_status?: 'not_supplied' }
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
export function redactTaskResult(result: ToolResult, tool: string): ToolResult {
  const { value: safe, count } = redactSecretsWithCount(result), disclosure = result[TASK_DISCLOSURE];
  if (count) {
    if (disclosure?.recordRedaction) disclosure.recordRedaction(tool, count);
    else hostLogEvent({ event: 'tool_redaction', tool, count });
  }
  if (result[TASK_CONNECTOR_FAILURE]) safe[TASK_CONNECTOR_FAILURE] = safe.repair ?? redactSecrets(result[TASK_CONNECTOR_FAILURE]!);
  if (result[TASK_CONNECTOR_FAILURE_CODE]) safe[TASK_CONNECTOR_FAILURE_CODE] = result[TASK_CONNECTOR_FAILURE_CODE];
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
