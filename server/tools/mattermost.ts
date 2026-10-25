import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { MattermostEvidence, MattermostResult, MattermostTool } from '../connectors/mattermost.js';
import { MATTERMOST_ATTENTION_TOOL, MATTERMOST_AUTH_NEEDED, MATTERMOST_CHAT_TOOL } from '../connectors/mattermost.js';
import { sha256 } from './canonical.js';
import { hostLogEvent } from './host-events.js';
import { MATTERMOST_MESSAGE_CHARS, shapeMattermost, type ShapedSource } from './live-shape.js';

export interface MattermostProjection {
  text: string;
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
  shape?: string;
  itemCount?: number;
  sources?: ShapedSource[];
}

export interface ConnectorStatus { state: 'configured' | 'error'; reason: string }

const AUTH_MARKER = /not authenticated|unauthorized|no session|mattermost_login|token (?:missing|expired)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readMattermostPayload(port: McpPort, evidence: ConnectorEvidence): { ok: true; text: string } | { ok: false; reason: string } {
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

export function decodeMcpContentText(parsed: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: 'unsupported_mcp_envelope' };
  const result = isRecord(parsed['result']) ? parsed['result'] : parsed;
  const content = result['content'];
  if (!Array.isArray(content) || content.length < 1 || !isRecord(content[0]) || typeof content[0]['text'] !== 'string') return { ok: false, reason: 'unsupported_mcp_envelope' };
  return { ok: true, text: content[0]['text'] as string };
}

/** Configured/auth-needed status for a non-completed read: a missing session is never an empty success. */
export function mattermostToolStatus(evidence: ConnectorEvidence): ConnectorStatus | undefined {
  if (evidence.state === 'completed') return undefined;
  const content = decodeMcpContentText(evidence.decodedResult);
  if (!content.ok) return { state: 'error', reason: 'tool call failed; no content' };
  return AUTH_MARKER.test(content.text)
    ? { state: 'configured', reason: MATTERMOST_AUTH_NEEDED }
    : { state: 'error', reason: 'tool call failed' };
}

/** Rich, clean projection of one Mattermost tool's decoded data (see live-shape.ts). */
export function renderMattermostTool(tool: string, data: unknown): MattermostProjection {
  return shapeMattermost(tool, data);
}

/** One line per item, newest first: the reason, then channel, author, ISO time, the line and its permalink. */
export function renderAttention(data: unknown): MattermostProjection {
  const empty = (text: string, shape: string): MattermostProjection => ({ text, partial: false, originalCharacters: 0, omittedCharacters: 0, shape, itemCount: 0 });
  if (!isRecord(data) || !Array.isArray(data['items'])) return empty('No attention digest.', 'unrecognised');
  const after = typeof data['after'] === 'string' ? data['after'] : '';
  const items = data['items'].filter(isRecord);
  // C-CHAT: a capability the child lacks is said once, before the items, never hidden behind them.
  const missing = typeof data['missing'] === 'string' ? `note: ${data['missing']}\n` : '';
  if (items.length === 0) return empty(`${missing}Nothing is waiting on a reply${after ? ` since ${after}` : ''}.`, 'empty');
  const field = (item: Record<string, unknown>, name: string): string => (typeof item[name] === 'string' ? (item[name] as string) : '');
  const lines = items.map(item => {
    const body = [field(item, 'channel'), field(item, 'author'), field(item, 'time'), field(item, 'snippet')].filter(Boolean).join(' | ');
    const permalink = field(item, 'permalink');
    return `- [${field(item, 'reason')}] ${body}${permalink ? ` | ${permalink}` : ''}`;
  });
  const text = `${missing}${lines.join('\n')}`;
  return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0, shape: 'items', itemCount: items.length };
}

/**
 * C-CHAT: the chat read as the voice reads it. Closed lead lines first: `read:` (what was read and over which
 * window), `matched:` (the archive's own count), `note:` (a capability this child lacks), `clarify:` (the
 * question to ask back) or `not found:`; then the overview sections as `- ` lines and the posts as
 * `**channel | author | time [post id]**` with their text, attachment text included.
 */
export function renderChatRead(data: unknown): MattermostProjection {
  if (!isRecord(data) || typeof data['read'] !== 'string' || !Array.isArray(data['posts'])) {
    return { text: 'No chat read.', partial: false, originalCharacters: 0, omittedCharacters: 0, shape: 'unrecognised', itemCount: 0 };
  }
  const field = (record: Record<string, unknown>, name: string): string => (typeof record[name] === 'string' ? (record[name] as string) : '');
  const lines = [`read: ${data['read']}`];
  if (Number.isSafeInteger(data['total'])) lines.push(`matched: ${String(data['total'])}`);
  if (typeof data['missing'] === 'string') lines.push(`note: ${data['missing']}`);
  if (typeof data['clarify'] === 'string') lines.push(`clarify: ${data['clarify']}`);
  if (typeof data['notFound'] === 'string') lines.push(`not found: ${data['notFound']}`);
  for (const section of Array.isArray(data['sections']) ? data['sections'].filter(isRecord) : []) {
    const last = field(section, 'last');
    lines.push(`- ${field(section, 'name')}: ${field(section, 'counts')}${last !== '' ? `, last ${last.slice(0, 10)}` : ''}`);
  }
  const posts = data['posts'].filter(isRecord);
  const sources: ShapedSource[] = [];
  let omitted = 0;
  for (const post of posts) {
    const id = field(post, 'id');
    lines.push(`**${[field(post, 'channel'), field(post, 'author'), field(post, 'time')].filter(Boolean).join(' | ')}${id !== '' ? ` [post ${id}]` : ''}**`);
    const text = field(post, 'text');
    if (text.length > MATTERMOST_MESSAGE_CHARS) omitted += text.length - MATTERMOST_MESSAGE_CHARS;
    lines.push(text.length > MATTERMOST_MESSAGE_CHARS ? `${text.slice(0, MATTERMOST_MESSAGE_CHARS - 3)}...` : text);
    const permalink = field(post, 'permalink');
    if (permalink !== '') sources.push({ title: `Mattermost: #${field(post, 'channel') || 'post'}`, url: permalink, sourceType: 'mattermost' });
  }
  const text = lines.join('\n');
  const shape = typeof data['clarify'] === 'string' || typeof data['notFound'] === 'string' ? 'empty' : 'items';
  return { text, partial: omitted > 0, originalCharacters: text.length + omitted, omittedCharacters: omitted, shape, itemCount: posts.length, ...(sources.length > 0 ? { sources } : {}) };
}

export function projectMattermostResult(port: McpPort, evidence: ConnectorResult): { ok: true; projection: MattermostProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: `tool-error: ${evidence.state}` };
  // The attention digest is synthesized over several reads, so it renders from its decoded items.
  if (evidence.tool === MATTERMOST_ATTENTION_TOOL || evidence.tool === MATTERMOST_CHAT_TOOL) {
    const projection = evidence.tool === MATTERMOST_CHAT_TOOL ? renderChatRead(evidence.decodedResult) : renderAttention(evidence.decodedResult);
    hostLogEvent({ event: 'mattermost_shape', tool: evidence.tool, rawCharacters: 0, shapedCharacters: projection.text.length, itemCount: projection.itemCount ?? 0, shape: projection.shape ?? 'unknown' });
    return { ok: true, projection };
  }
  const payload = readMattermostPayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  let data: unknown = payload.text;
  try { data = JSON.parse(payload.text); } catch { data = payload.text; }
  const projection = renderMattermostTool(evidence.tool, data);
  // Metadata only: which shape the read took, and its sizes. Never any message content.
  hostLogEvent({ event: 'mattermost_shape', tool: evidence.tool, rawCharacters: payload.text.length, shapedCharacters: projection.text.length, itemCount: projection.itemCount ?? 0, shape: projection.shape ?? 'unknown' });
  return { ok: true, projection };
}

export type { MattermostEvidence, MattermostResult, MattermostTool };
