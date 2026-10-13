import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { MattermostEvidence, MattermostResult, MattermostTool } from '../connectors/mattermost.js';
import { MATTERMOST_AUTH_NEEDED } from '../connectors/mattermost.js';
import { sha256 } from './canonical.js';

/** Hard projection bound for one Mattermost read. */
export const MATTERMOST_PROJECTION_CHARS = 4000;
/** Per-field bound so one long message can never crowd out the rest of a channel read. */
export const MATTERMOST_FIELD_CHARS = 600;

export interface MattermostProjection {
  text: string;
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
}

export interface ConnectorStatus { state: 'configured' | 'error'; reason: string }

const AUTH_MARKER = /not authenticated|unauthorized|no session|mattermost_login|token (?:missing|expired)/i;

export function boundedProjection(text: string, bound = MATTERMOST_PROJECTION_CHARS): MattermostProjection {
  if (text.length <= bound) return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0 };
  return { text: text.slice(0, bound), partial: true, originalCharacters: text.length, omittedCharacters: text.length - bound };
}

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

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > MATTERMOST_FIELD_CHARS ? `${text.slice(0, MATTERMOST_FIELD_CHARS)}...` : text;
}

function renderPost(post: Record<string, unknown>): string[] {
  const channel = clip(post['channel'] ?? post['channel_name'] ?? post['channel_id']);
  const author = clip(post['author'] ?? post['author_name'] ?? post['user_name']);
  const time = clip(post['time'] ?? post['create_at'] ?? post['timestamp']);
  const header = [channel, author, time].filter(part => part.length > 0).join(' | ');
  const body = clip(post['text'] ?? post['message']);
  const permalink = typeof post['permalink'] === 'string' ? post['permalink'] : undefined;
  return [`**${header || 'message'}**`, body, ...(permalink ? [`source: ${permalink}`] : [])];
}

/** Pure Markdown projection of one Mattermost tool's decoded data. */
export function renderMattermostTool(tool: string, data: unknown): MattermostProjection {
  if (typeof data === 'string') return boundedProjection(data);
  if (!isRecord(data)) return boundedProjection(JSON.stringify(data));
  if (tool === 'mattermost_whoami') {
    const name = typeof data['username'] === 'string' ? data['username'] : '';
    const display = typeof data['display_name'] === 'string' ? data['display_name'] : '';
    return boundedProjection([name, display].filter(part => part.length > 0).join(' | ') || 'authenticated');
  }
  if (tool === 'mattermost_list_channels') {
    const channels = Array.isArray(data['channels']) ? data['channels'] : [];
    const lines = channels.map(entry => (isRecord(entry) ? `- ${clip(entry['display_name'] ?? entry['name'])}` : `- ${String(entry)}`));
    return boundedProjection(lines.join('\n'));
  }
  const posts = Array.isArray(data['posts']) ? data['posts'] : (Array.isArray(data['items']) ? data['items'] : []);
  return boundedProjection(posts.flatMap(entry => (isRecord(entry) ? renderPost(entry) : [`- ${String(entry)}`])).join('\n\n'));
}

export function projectMattermostResult(port: McpPort, evidence: ConnectorResult): { ok: true; projection: MattermostProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: `tool-error: ${evidence.state}` };
  const payload = readMattermostPayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  let data: unknown = payload.text;
  try { data = JSON.parse(payload.text); } catch { data = payload.text; }
  return { ok: true, projection: renderMattermostTool(evidence.tool, data) };
}

export type { MattermostEvidence, MattermostResult, MattermostTool };
