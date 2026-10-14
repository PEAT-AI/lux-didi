import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { MattermostEvidence, MattermostResult, MattermostTool } from '../connectors/mattermost.js';
import { MATTERMOST_AUTH_NEEDED } from '../connectors/mattermost.js';
import { sha256 } from './canonical.js';
import { shapeMattermost } from './live-shape.js';

export interface MattermostProjection {
  text: string;
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
  shape?: string;
  itemCount?: number;
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

export function projectMattermostResult(port: McpPort, evidence: ConnectorResult): { ok: true; projection: MattermostProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: `tool-error: ${evidence.state}` };
  const payload = readMattermostPayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  let data: unknown = payload.text;
  try { data = JSON.parse(payload.text); } catch { data = payload.text; }
  const projection = renderMattermostTool(evidence.tool, data);
  // Metadata only: which shape the read took, and its sizes. Never any message content.
  console.log(JSON.stringify({ event: 'mattermost_shape', tool: evidence.tool, rawCharacters: payload.text.length, shapedCharacters: projection.text.length, itemCount: projection.itemCount ?? 0, shape: projection.shape ?? 'unknown' }));
  return { ok: true, projection };
}

export type { MattermostEvidence, MattermostResult, MattermostTool };
