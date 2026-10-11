import type { McpPort, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { MongooseResult, MongooseTool } from '../connectors/mongoose.js';

/** Owner-safe Markdown projection of one bounded Mongoose read. */
export interface MongooseProjection {
  text: string;
  sources: readonly string[];
  bounded: boolean;
  omittedCharacters: number;
}

const URL_RE = /https?:\/\/[^\s)\]"'<>]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reconstruct the exact stored JSON-RPC entity from the result store, verify its hash and
 * join the bounded text contents. A missing or tampered byte range never becomes evidence.
 */
export function readMongooseEnvelope(evidence: { response: StoredPayload; source: ResultScope }, port: McpPort): string {
  const payload = evidence.response;
  if (payload.state !== 'available' || payload.encoding !== 'http-response-entity' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 1 || !/^[a-f0-9]{64}$/.test(payload.sha256) || payload.expiresAt <= Date.now()) throw Error('entity_unavailable_or_oversize');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength;) {
    const length = Math.min(512, payload.byteLength - offset);
    const slice = port.readSlice({ handle: payload.handle, endpointId: evidence.source.endpointId, generation: evidence.source.generation, account: evidence.source.account, resource: evidence.source.resource, offset, length });
    if (slice.state !== 'available' || slice.byteLength !== payload.byteLength || slice.sha256 !== payload.sha256 || slice.bytes.byteLength !== length || slice.expiresAt !== payload.expiresAt || slice.expiresAt <= Date.now()) throw Error('entity_slice_incomplete');
    chunks.push(slice.bytes.slice()); offset += length;
  }
  const packet: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!isRecord(packet) || packet['jsonrpc'] !== '2.0' || !isRecord(packet['result'])) throw Error('unsupported_mcp_envelope');
  const content = (packet['result'] as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) throw Error('unsupported_mcp_result');
  const texts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'text' || typeof item['text'] !== 'string') throw Error('unsupported_mcp_content');
    texts.push(item['text']);
  }
  return texts.join('\n');
}

/** Render a structured hit list as Markdown links; an already-Markdown answer passes through. */
function renderHits(tool: MongooseTool, raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  const container = Array.isArray(parsed) ? { items: parsed } : parsed;
  if (!isRecord(container)) return raw;
  const items = container['items'] ?? container['results'] ?? container['hits'];
  if (!Array.isArray(items)) return raw;
  const lines = items.map(item => {
    if (!isRecord(item)) return `- ${String(item)}`;
    const title = typeof item['title'] === 'string' ? item['title'] : (typeof item['name'] === 'string' ? item['name'] : 'item');
    const url = typeof item['url'] === 'string' ? item['url'] : undefined;
    if (url) return `- [${title}](${url})`;
    const id = typeof item['id'] === 'string' ? item['id'] : undefined;
    return id ? `- ${title} (${id})` : `- ${title}`;
  });
  return [`Mongoose ${tool} results:`, ...lines].join('\n');
}

/**
 * Project one completed Mongoose read to bounded Markdown with the hit URLs as sources.
 * Text past `maxChars` is marked as partial, never silently invented.
 */
export function projectMongooseResult(evidence: MongooseResult, port: McpPort, maxChars = 16384): MongooseProjection {
  if (evidence.state !== 'completed') throw Error('result_not_completed');
  const raw = renderHits(evidence.tool, readMongooseEnvelope(evidence, port));
  const sources = [...new Set(raw.match(URL_RE) ?? [])];
  const bounded = raw.length > maxChars;
  const text = bounded ? `${raw.slice(0, maxChars)}\n\n[partial: ${raw.length - maxChars} characters omitted]` : raw;
  return { text, sources, bounded, omittedCharacters: bounded ? raw.length - maxChars : 0 };
}
