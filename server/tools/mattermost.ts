import type { McpPort, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { MattermostResult } from '../connectors/mattermost.js';

/** Owner-safe Markdown projection of one bounded Mattermost read. */
export interface MattermostProjection {
  text: string;
  sources: readonly string[];
  bounded: boolean;
  omittedCharacters: number;
}

/** Per-field bound so one long message can never crowd out the rest of a channel read. */
export const MATTERMOST_FIELD_CHARS = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readMattermostEnvelope(evidence: { response: StoredPayload; source: ResultScope }, port: McpPort): string {
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
  if (!isRecord(packet)) throw Error('unsupported_mcp_envelope');
  // HTTP keeps the JSON-RPC envelope; the stdio adapter stores the bare result entity.
  const result = isRecord(packet['result']) ? packet['result'] : packet;
  const content = result['content'];
  if (!Array.isArray(content)) throw Error('unsupported_mcp_result');
  const texts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'text' || typeof item['text'] !== 'string') throw Error('unsupported_mcp_content');
    texts.push(item['text']);
  }
  return texts.join('\n');
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > MATTERMOST_FIELD_CHARS ? `${text.slice(0, MATTERMOST_FIELD_CHARS)}…` : text;
}

/** Render a JSON post list as Markdown blocks (channel, author, time, bounded text); else pass through. */
function renderPosts(raw: string): { text: string; sources: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { text: raw, sources: [] }; }
  const container = Array.isArray(parsed) ? { posts: parsed } : parsed;
  if (!isRecord(container)) return { text: raw, sources: [] };
  const posts = container['posts'] ?? container['items'] ?? container['results'];
  if (!Array.isArray(posts)) return { text: raw, sources: [] };
  const sources: string[] = [];
  const blocks = posts.map(post => {
    if (!isRecord(post)) return `- ${String(post)}`;
    const channel = clip(post['channel'] ?? post['channel_name'] ?? post['channel_id']);
    const author = clip(post['author'] ?? post['author_name'] ?? post['user_name']);
    const time = clip(post['time'] ?? post['create_at'] ?? post['timestamp']);
    const permalink = typeof post['permalink'] === 'string' ? post['permalink'] : undefined;
    if (permalink) sources.push(permalink);
    const header = [channel, author, time].filter(part => part.length > 0).join(' · ');
    const body = clip(post['text'] ?? post['message']);
    return `**[${header || 'message'}]**\n${body}${permalink ? `\n[permalink](${permalink})` : ''}`;
  });
  return { text: blocks.join('\n\n'), sources };
}

export function projectMattermostResult(evidence: MattermostResult, port: McpPort, maxChars = 16384): MattermostProjection {
  if (evidence.state !== 'completed') throw Error('result_not_completed');
  const raw = readMattermostEnvelope(evidence, port);
  const { text: rendered, sources } = renderPosts(raw);
  const bounded = rendered.length > maxChars;
  const text = bounded ? `${rendered.slice(0, maxChars)}\n\n[partial: ${rendered.length - maxChars} characters omitted]` : rendered;
  return { text, sources: [...new Set(sources)], bounded, omittedCharacters: bounded ? rendered.length - maxChars : 0 };
}
