import type { McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { MongooseEvidence, MongooseResult, MongooseTool } from '../connectors/mongoose.js';
import { sha256 } from './canonical.js';

/** Hard projection bound for one Mongoose answer (list or body). */
export const MONGOOSE_PROJECTION_CHARS = 4000;

export interface MongooseProjection {
  text: string;
  /** True when the raw projection was longer than the bound and the tail was dropped. */
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
export function readMongoosePayload(port: McpPort, evidence: MongooseEvidence): { ok: true; text: string } | { ok: false; reason: string } {
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
  return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}

/** Extracts the first text content item from the stored envelope (full JSON-RPC message or bare result). */
export function decodeMcpContentText(payloadText: string): { ok: true; text: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(payloadText); } catch { return { ok: false, reason: 'unsupported_mcp_envelope' }; }
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
export function mongooseToolStatus(evidence: MongooseEvidence): ConnectorStatus | undefined {
  if (evidence.state === 'completed') return undefined;
  const content = decodeMcpContentText(evidence.projection.text);
  if (!content.ok) return { state: 'error', reason: 'tool call failed; no content' };
  return credentialFailure(content.text)
    ? { state: 'configured', reason: 'bearer missing or rejected: provision the mongoose-mcp credential' }
    : { state: 'error', reason: 'tool call failed' };
}

function itemLine(item: Record<string, unknown>): string[] {
  const title = typeof item['title'] === 'string' ? item['title'] : (typeof item['name'] === 'string' ? item['name'] : (typeof item['id'] === 'string' ? item['id'] : 'item'));
  const url = typeof item['url'] === 'string' ? item['url'] : (typeof item['item_url'] === 'string' ? item['item_url'] : undefined);
  const status = typeof item['status'] === 'string' ? `, ${item['status']}` : '';
  const line = `- ${title}${status}`;
  return url ? [line, `  source: ${url}`] : [line];
}

/** Pure Markdown projection of one Mongoose tool's decoded data, with the hit URL as its source. */
export function renderMongooseTool(tool: MongooseTool, data: unknown): MongooseProjection {
  if (typeof data === 'string') return boundedProjection(data);
  if (!isRecord(data)) return boundedProjection(JSON.stringify(data));
  const items = Array.isArray(data['items']) ? data['items'] : (Array.isArray(data['results']) ? data['results'] : (Array.isArray(data['hits']) ? data['hits'] : undefined));
  if (items) return boundedProjection(items.flatMap(entry => (isRecord(entry) ? itemLine(entry) : [`- ${String(entry)}`])).join('\n'));
  if (tool === 'read_knowledge_body' && typeof data['body'] === 'string') return boundedProjection(data['body']);
  if (tool === 'get_company_profile' && typeof data['profile'] === 'string') return boundedProjection(data['profile']);
  return boundedProjection(JSON.stringify(data));
}

/** Full projection of a completed Mongoose read: decode, render, report partial. Never throws on a bad envelope. */
export function projectMongooseResult(port: McpPort, evidence: MongooseResult): { ok: true; projection: MongooseProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: `tool-error: ${evidence.state}` };
  const payload = readMongoosePayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  const content = decodeMcpContentText(payload.text);
  if (!content.ok) return { ok: false, reason: content.reason };
  let data: unknown = content.text;
  try { data = JSON.parse(content.text); } catch { data = content.text; }
  return { ok: true, projection: renderMongooseTool(evidence.tool, data) };
}

export type { MongooseEvidence, MongooseResult, MongooseTool };
