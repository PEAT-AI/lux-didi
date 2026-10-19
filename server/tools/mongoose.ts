import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { MongooseEvidence, MongooseResult, MongooseTool } from '../connectors/mongoose.js';
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

const CREDENTIAL_CODES = new Set(['credential-missing', 'credential-unreadable', 'credential-insufficient-scope', 'credential-revoked', 'credential-refresh-failed']);

/** Markdown projection of the bounded MCP result. Never returns the full body unbounded. */
export function boundedProjection(text: string, bound = MONGOOSE_PROJECTION_CHARS): MongooseProjection {
  if (text.length <= bound) return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0 };
  return { text: text.slice(0, bound), partial: true, originalCharacters: text.length, omittedCharacters: text.length - bound };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reconstruct the bounded stored MCP payload, verifying its hash, never inventing bytes. */
export function readMongoosePayload(port: McpPort, evidence: ConnectorEvidence): { ok: true; text: string } | { ok: false; reason: string } {
  const payload: StoredPayload = evidence.response;
  if (payload.state !== 'available' || payload.encoding !== 'http-response-entity' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 1 || !/^[a-f0-9]{64}$/.test(payload.sha256) || payload.expiresAt <= Date.now()) return { ok: false, reason: 'entity_unavailable_or_oversize' };
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength;) {
    const length = Math.min(512, payload.byteLength - offset);
    const slice = port.readSlice({ handle: payload.handle, endpointId: evidence.source.endpointId, generation: evidence.source.generation, account: evidence.source.account, resource: evidence.source.resource, offset, length });
    if (slice.state !== 'available' || slice.bytes.byteLength !== length) return { ok: false, reason: 'entity_slice_incomplete' };
    chunks.push(slice.bytes.slice()); offset += length;
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== payload.byteLength || sha256(bytes) !== payload.sha256) return { ok: false, reason: 'entity_hash_mismatch' };
  return decodeMcpContentText(evidence.decodedResult);
}

/** Extracts the first text content item from the stored envelope (full JSON-RPC message or bare result). */
export function decodeMcpContentText(parsed: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: 'unsupported_mcp_envelope' };
  const result = isRecord(parsed['result']) ? parsed['result'] : parsed;
  const content = result['content'];
  if (!Array.isArray(content) || content.length < 1 || !isRecord(content[0]) || typeof content[0]['text'] !== 'string') return { ok: false, reason: 'unsupported_mcp_envelope' };
  return { ok: true, text: content[0]['text'] as string };
}

/** The helper's typed credential error is a tool-error whose text starts with a stable code. */
export function credentialFailure(text: string): boolean {
  const separator = text.indexOf(':');
  const code = (separator === -1 ? text : text.slice(0, separator)).trim();
  return CREDENTIAL_CODES.has(code);
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
  const entity = scalar(item['entity_type']) ?? group;
  const fields: string[] = [];
  if (entity) fields.push(`entity: ${entity}`);
  for (const key of ['id', 'ref', 'number', 'company_name', 'slug', 'domain', 'status', 'type']) {
    const value = scalar(item[key]); if (value !== undefined) fields.push(`${key}: ${value}`);
  }
  for (const key of ['snippet_truncated', 'name_truncated']) if (item[key] === true) fields.push(`${key}: true`);
  const snippet = scalar(item['snippet']) ?? scalar(item['excerpt']) ?? scalar(item['summary']);
  if (snippet) fields.push(snippet.replace(/\s+/gu, ' ').trim());
  const url = scalar(item['url']) ?? scalar(item['item_url']);
  return [`- ${title}${fields.length ? ` | ${fields.join(' | ')}` : ''}`, ...(url ? [`  source: ${url}`] : [])];
}

function hitLines(data: Record<string, unknown>): string[] | undefined {
  for (const key of ['items', 'results', 'hits']) {
    const value = data[key];
    if (Array.isArray(value)) return value.flatMap(entry => isRecord(entry) ? itemLine(entry, data['scope'] === 'knowledge' ? 'knowledge' : undefined) : [`- ${String(entry)}`]);
    if (isRecord(value)) {
      if (key === 'results') { const nested = hitLines(value); if (nested !== undefined) return nested; }
      if (key === 'hits') {
        const groups = Object.entries(value);
        if (groups.every(([, entries]) => Array.isArray(entries))) return groups.flatMap(([group, entries]) => (entries as unknown[]).flatMap(entry => isRecord(entry) ? itemLine(entry, group) : []));
      }
    }
  }
  return undefined;
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
    for (const key of ['found', 'answer_state', 'response_mode', 'has_more', 'total', 'total_estimate', 'next_cursor', 'complete', 'whole_body', 'body_complete', 'body_char_count', 'returned_chars', 'cursor', 'body_offset', 'next_body_offset', 'hits_total', 'hits_truncated', 'omitted_due_to_char_budget']) add(`${prefix}${key === 'found' ? 'answerable' : key}`, value[key]);
    const cursor = value['next_cursor'];
    partial ||= value['has_more'] === true || value['complete'] === false || value['whole_body'] === false || value['body_complete'] === false || value['hits_truncated'] === true || (typeof value['omitted_due_to_char_budget'] === 'number' && value['omitted_due_to_char_budget'] > 0) || (cursor !== undefined && cursor !== null && cursor !== '') || value['next_body_offset'] !== undefined;
    const hits = value['hits'];
    const items = Array.isArray(value['results']) ? value['results'] : Array.isArray(value['items']) ? value['items'] : Array.isArray(hits) ? hits : isRecord(hits) ? Object.values(hits).flatMap(entries => Array.isArray(entries) ? entries : []) : [];
    partial ||= items.some(item => isRecord(item) && (item['snippet_truncated'] === true || item['name_truncated'] === true));
  };
  visit(data);
  if (isRecord(data['results'])) visit(data['results'], 'results.');
  if (isRecord(data['answerability'])) {
    add('answerability.decision', data['answerability']['decision']);
    add('answerability.next_tool', data['answerability']['next_tool']);
  }
  if (data['_truncation'] !== undefined) { add('upstream_truncation', data['_truncation']); partial = true; }
  return { lines, partial };
}

/** Preserves source identity and coverage while bounding only the displayed projection. */
export function renderMongooseTool(tool: string, data: unknown): MongooseProjection {
  if (typeof data === 'string') return boundedProjection(data);
  if (!isRecord(data)) return boundedProjection(JSON.stringify(data));
  const items = hitLines(data);
  const coverage = coverageLines(data);
  let text: string;
  if (items !== undefined) text = items.join('\n');
  else if (tool === 'read_knowledge_body' && typeof data['body'] === 'string') text = data['body'];
  else if (tool === 'get_company_profile' && typeof data['profile'] === 'string') text = data['profile'];
  else text = JSON.stringify(data);
  const fullTrailer = coverage.lines.length ? `\ncoverage: ${coverage.lines.join(' | ')}` : '';
  const trailer = fullTrailer.length <= 1500 ? fullTrailer : `${fullTrailer.slice(0, 1450)} [coverage metadata clipped]`;
  const projected = boundedProjection(text, MONGOOSE_PROJECTION_CHARS - trailer.length);
  return { text: `${projected.text}${trailer}`, partial: projected.partial || coverage.partial || fullTrailer.length > trailer.length, originalCharacters: text.length + fullTrailer.length, omittedCharacters: projected.omittedCharacters + Math.max(0, fullTrailer.length - trailer.length) };
}

/** Full projection of a completed Mongoose read: decode, render, report partial. Never throws on a bad envelope. */
export function projectMongooseResult(port: McpPort, evidence: ConnectorResult): { ok: true; projection: MongooseProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: `tool-error: ${evidence.state}` };
  const payload = readMongoosePayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  let data: unknown = payload.text;
  try { data = JSON.parse(payload.text); } catch { data = payload.text; }
  return { ok: true, projection: renderMongooseTool(evidence.tool, data) };
}

export type { MongooseEvidence, MongooseResult, MongooseTool };
