import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { MongooseResult } from '../connectors/mongoose.js';
import { mongooseClosedReason, mongooseOwnerLine } from '../connectors/mongoose.js';
import { sha256 } from './canonical.js';

/** Hard projection bound for one Mongoose answer (list or body). */
export const MONGOOSE_PROJECTION_CHARS = 4000;

export interface MongooseProjection {
  text: string;
  /** True for a local display omission or a source-reported body, hit or page omission. */
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
}

export interface ConnectorStatus { state: 'configured' | 'error'; reason: string }

const CREDENTIAL_CODES = new Set(['credential-missing', 'credential-unreadable', 'credential-insufficient-scope', 'credential-revoked', 'credential-refresh-failed', 'credential-unavailable']);

/** Markdown projection of the bounded MCP result. Never returns the full body unbounded. */
export function boundedProjection(text: string, bound = MONGOOSE_PROJECTION_CHARS): MongooseProjection {
  if (text.length <= bound) return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0 };
  return { text: text.slice(0, bound), partial: true, originalCharacters: text.length, omittedCharacters: text.length - bound };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Verify a bounded stored MCP payload byte for byte against its handle and hash, never inventing bytes. */
function verifyPayload(port: McpPort, source: ConnectorEvidence['source'], payload: StoredPayload): boolean {
  if (payload.state !== 'available' || payload.encoding !== 'http-response-entity' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 1 || !/^[a-f0-9]{64}$/.test(payload.sha256) || payload.expiresAt <= Date.now()) return false;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength;) {
    const length = Math.min(512, payload.byteLength - offset);
    const slice = port.readSlice({ handle: payload.handle, endpointId: source.endpointId, generation: source.generation, account: source.account, resource: source.resource, offset, length });
    if (slice.state !== 'available' || slice.bytes.byteLength !== length) return false;
    chunks.push(slice.bytes.slice()); offset += length;
  }
  const bytes = Buffer.concat(chunks);
  return bytes.byteLength === payload.byteLength && sha256(bytes) === payload.sha256;
}

/** The verified text of one stored payload, decoded from the result the adapter already parsed. */
export function readMongoosePayload(port: McpPort, evidence: ConnectorEvidence): { ok: true; text: string } | { ok: false; reason: string } {
  if (!verifyPayload(port, evidence.source, evidence.response)) return { ok: false, reason: 'entity_unavailable_or_oversize' };
  return decodeMcpContentText(evidence.decodedResult);
}

/** The helper's typed credential error is a tool-error whose text starts with a stable code. */
export function credentialFailure(text: string): boolean {
  const separator = text.indexOf(':');
  const code = (separator === -1 ? text : text.slice(0, separator)).trim();
  return CREDENTIAL_CODES.has(code);
}

function decodeMcpContentText(decoded: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  let parsed: unknown = decoded;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return { ok: true, text: parsed as string }; } }
  if (!isRecord(parsed)) return { ok: false, reason: 'unsupported_mcp_envelope' };
  const result = isRecord(parsed['result']) ? parsed['result'] : parsed;
  const content = result['content'];
  if (!Array.isArray(content) || content.length < 1 || !isRecord(content[0]) || typeof content[0]['text'] !== 'string') return { ok: false, reason: 'unsupported_mcp_envelope' };
  return { ok: true, text: content[0]['text'] as string };
}

/** Configured/auth-needed status for a non-completed read, never an empty success. */
export function mongooseToolStatus(evidence: ConnectorEvidence): ConnectorStatus | undefined {
  if (evidence.state === 'completed') return undefined;
  const content = decodeMcpContentText(evidence.decodedResult);
  if (!content.ok) return { state: 'error', reason: 'tool call failed; no content' };
  return credentialFailure(content.text)
    ? { state: 'configured', reason: 'Mongoose session expired or missing: reconnect Mongoose' }
    : { state: 'error', reason: 'tool call failed' };
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function itemLine(item: Record<string, unknown>, group?: string): string[] {
  const title = scalar(item['title']) ?? scalar(item['name']) ?? scalar(item['company_name']) ?? scalar(item['id']) ?? 'item';
  const entity = scalar(item['type']) ?? scalar(item['entity_type']) ?? group;
  const fields: string[] = [];
  if (entity) fields.push(`entity: ${entity}`);
  for (const key of ['ref', 'id', 'number', 'company_name', 'slug', 'domain', 'status']) {
    const value = scalar(item[key]); if (value !== undefined) fields.push(`${key}: ${value}`);
  }
  for (const key of ['snippet_truncated', 'name_truncated']) if (item[key] === true) fields.push(`${key}: true`);
  const snippet = scalar(item['snippet']) ?? scalar(item['excerpt']) ?? scalar(item['summary']);
  if (snippet) fields.push(snippet.replace(/\s+/gu, ' ').trim());
  // Q-02: a ticket whose own text records a contradiction is voiced as a disagreement, never as a
  // figure. The two figures it names travel with it, so the answer can lead with both sides.
  const contradiction = contradictionOf(`${title} ${snippet ?? ''}`);
  if (contradiction.flagged) fields.push('contradiction: true', ...(contradiction.values.length >= 2 ? [`values: ${contradiction.values[0]} / ${contradiction.values[1]}`] : []));
  const url = scalar(item['url']) ?? scalar(item['item_url']);
  return [`- ${title}${fields.length ? ` | ${fields.join(' | ')}` : ''}`, ...(url ? [`  source: ${url}`] : [])];
}

function hitLines(data: Record<string, unknown>): string[] | undefined {
  for (const key of ['items', 'results', 'hits'] as const) {
    const value = data[key];
    if (Array.isArray(value)) return value.flatMap(entry => isRecord(entry) ? itemLine(entry) : []);
    if (isRecord(value)) {
      if (key === 'hits') {
        const groups = Object.entries(value);
        if (groups.every(([, entries]) => Array.isArray(entries))) return groups.flatMap(([group, entries]) => (entries as unknown[]).flatMap(entry => isRecord(entry) ? itemLine(entry, group) : []));
      }
    }
  }
  return undefined;
}

/** Q-02: the words a contradiction ticket carries, and the two figures inside them. */
const CONTRADICTION_IN_TEXT = /\bcontradiction\b/iu;
function contradictionOf(text: string): { flagged: boolean; values: string[] } {
  if (!CONTRADICTION_IN_TEXT.test(text)) return { flagged: false, values: [] };
  // A year in brackets dates the figure, it is not one of the two sides of the disagreement. A marker the
  // source attached to a figure ("~29K") is part of that figure: an approximation spoken as an exact
  // number is the failure this projection exists to prevent.
  const values = text.replace(/\(\d{4}\)/gu, ' ').match(/[~≈<>+±]?\s?\d[\d,]*(?:\.\d+)?\s?[KkMm]?/gu) ?? [];
  return { flagged: true, values: values.map(value => value.trim()) };
}

/**
 * P-3: one metric query's rows, each with its own date, so the number never travels without the day it
 * belongs to. Rows are the server's own [date, value] arrays under the columns it names.
 */
function rowLines(data: Record<string, unknown>): string[] | undefined {
  const rows = data['rows'];
  if (!Array.isArray(rows)) return undefined;
  const columns = Array.isArray(data['columns']) ? data['columns'].filter(isRecord) : [];
  const labels = columns.map(column => scalar(column['label']) ?? scalar(column['fieldId']) ?? '');
  const lines = rows.flatMap(row => Array.isArray(row)
    ? [row.map((cell, index) => `${labels[index] ?? index}: ${scalar(cell) ?? ''}`).join(' | ')]
    : []);
  if (!lines.length) return undefined;
  // The rows keep their own dates and nothing more: which one is the latest is the research layer's call,
  // read from the dates themselves, so no projection line claims an order the dispatch never asked for.
  return lines;
}

/** The one owner line a closed state carries; absent when the answer is ordinary data. */
export function mongooseOwnerText(data: Record<string, unknown>): string | undefined {
  const code = scalar(data['error_code']) ?? scalar(data['code']);
  if (code === undefined) return undefined;
  const reason = mongooseClosedReason(code);
  return reason === undefined ? undefined : mongooseOwnerLine(reason);
}

/** The restriction block of one envelope, rendered as the closed reason, never as empty data. */
function restrictionText(data: Record<string, unknown>): string | undefined {
  const restriction = data['restriction'];
  const message = isRecord(restriction) ? scalar(restriction['message']) : undefined;
  const code = isRecord(restriction) ? scalar(restriction['code']) ?? 'restricted' : 'restricted';
  if (data['outcome'] !== 'restricted' && restriction === null) return undefined;
  return message === undefined ? `restricted: ${code}` : `restricted: ${message}`;
}

function coverageLines(data: Record<string, unknown>): { lines: string[]; partial: boolean } {
  const lines: string[] = [];
  let partial = false;
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    lines.push(`${key}: ${text}`);
  };
  const visit = (value: Record<string, unknown>, prefix = ''): void => {
    for (const key of ['outcome', 'has_more', 'total', 'next_cursor', 'complete', 'whole_body', 'next_body_offset', 'returned_chars']) add(`${prefix}${key}`, value[key]);
    const coverage = value['coverage'];
    if (isRecord(coverage)) { add(`${prefix}coverage.depth`, coverage['depth']); add(`${prefix}coverage.complete`, coverage['complete']); partial ||= coverage['complete'] === false; }
    const nextTool = value['next_tool'];
    if (isRecord(nextTool)) { add(`${prefix}next_tool.endpoint`, nextTool['endpoint']); add(`${prefix}next_tool.tool`, nextTool['tool']); }
    const cursor = value['next_cursor'];
    partial ||= value['has_more'] === true || value['complete'] === false || value['whole_body'] === false || (cursor !== undefined && cursor !== null && cursor !== '');
  };
  visit(data);
  if (data['_truncation'] !== undefined) { add('upstream_truncation', data['_truncation']); partial = true; }
  return { lines, partial };
}

/** The source card of the second read: the entity behind the top hit, named and attributed. */
function followUpText(followUp: unknown): string | undefined {
  if (!isRecord(followUp)) return undefined;
  const data = followUp['data'];
  if (!isRecord(data)) return undefined;
  const read = hitLines(data);
  const body = scalar(data['body']);
  const head = read !== undefined && read.length ? read.join('\n') : undefined;
  if (head === undefined && body === undefined) return undefined;
  return ['', 'read:', ...(head === undefined ? [] : [head]), ...(body === undefined ? [] : [body])].join('\n');
}

/** Preserves source identity and coverage while bounding only the displayed projection. */
export function renderMongooseTool(data: unknown, followUp?: unknown): MongooseProjection {
  if (typeof data === 'string') return boundedProjection(data);
  if (!isRecord(data)) return boundedProjection(JSON.stringify(data));
  const owner = mongooseOwnerText(data);
  if (owner !== undefined) return boundedProjection(owner);
  const restricted = restrictionText(data);
  const items = hitLines(data);
  const rows = rowLines(data);
  const coverage = coverageLines(data);
  let text: string;
  if (items !== undefined && items.length) text = items.join('\n');
  else if (rows !== undefined) text = rows.join('\n');
  else if (data['outcome'] === 'no_match' && Array.isArray(data['suggestions']) && data['suggestions'].length)
    // Q-02: a search that matched nothing but offers candidates is a pointer, never a failure.
    text = `no direct answer, candidates: ${data['suggestions'].map(value => scalar(value) ?? '').filter(value => value !== '').join(', ')}`;
  else if (data['outcome'] === 'no_match') text = 'no direct answer: nothing matched this ask';
  else if (data['body'] === '') text = 'empty_body: true';
  else if (restricted !== undefined) text = restricted;
  else if (typeof data['body'] === 'string') text = data['body'];
  else if (typeof data['profile'] === 'string') text = data['profile'];
  else text = JSON.stringify(data);
  const card = followUpText(followUp);
  if (card !== undefined) text = `${text}${card}`;
  const fullTrailer = coverage.lines.length ? `\ncoverage: ${coverage.lines.join(' | ')}` : '';
  const trailer = fullTrailer.length <= 1500 ? fullTrailer : `${fullTrailer.slice(0, 1450)} [coverage metadata clipped]`;
  const projected = boundedProjection(text, MONGOOSE_PROJECTION_CHARS - trailer.length);
  return { text: `${projected.text}${trailer}`, partial: projected.partial || coverage.partial, originalCharacters: projected.originalCharacters, omittedCharacters: projected.omittedCharacters };
}

/** One decoded envelope behind its verified payload; a connector that set no follow-up decodes nothing. */
function decodeStored(port: McpPort, source: ConnectorEvidence['source'], payload: StoredPayload, decoded: unknown): { ok: true; data: unknown } | { ok: false; reason: string } {
  if (!verifyPayload(port, source, payload)) return { ok: false, reason: 'entity_unavailable_or_oversize' };
  const read = decodeMcpContentText(decoded);
  if (!read.ok) return { ok: false, reason: read.reason };
  let data: unknown = read.text;
  try { data = JSON.parse(read.text); } catch { data = read.text; }
  return { ok: true, data };
}

/** A completed read: the projection of its envelope, plus the source card of its follow-up read. */
function isCompleted(evidence: ConnectorResult): evidence is ConnectorEvidence {
  return evidence.state === 'completed' || evidence.state === 'tool-error' || evidence.state === 'protocol-error';
}

/** Full projection of a completed Mongoose read: decode, render, report partial. Never throws on a bad envelope. */
export function projectMongooseResult(port: McpPort, result: ConnectorResult): { ok: true; projection: MongooseProjection } | { ok: false; reason: string } {
  if (!isCompleted(result)) return { ok: false, reason: result.reason };
  const payload = readMongoosePayload(port, result);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  let data: unknown = payload.text;
  try { data = JSON.parse(payload.text); } catch { data = payload.text; }
  const followUp = result.followUp === undefined ? undefined : decodeStored(port, result.source, result.followUp.payload, result.followUp.decodedResult);
  const attachment = followUp !== undefined && followUp.ok ? { data: followUp.data } : undefined;
  return { ok: true, projection: renderMongooseTool(data, attachment) };
}

export type { MongooseResult };
