import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { CompletedResult, McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { GoogleEvidence, GoogleResult, GoogleTool } from '../connectors/google.js';
import { HOST_EVIDENCE, type HostEvidenceRef } from './types.js';
import { sha256 } from './canonical.js';
import { shapeGcalCalendars, shapeGcalList, shapeGmailList, shapeGmailRead, receivedGmailBody, type ShapedResult, type ShapedSource } from './live-shape.js';

export interface GoogleProjection {
  mailPage?: ShapedResult['mailPage'];
  [HOST_EVIDENCE]?: HostEvidenceRef;
  calendarPage?: ShapedResult['calendarPage'];
  calendarScope?: ShapedResult['calendarScope'];
  text: string;
  /** True when the raw projection was longer than the bound and the tail was dropped. */
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
  /** Named link sources, carried out of band so model text never holds a raw url. */
  sources?: ShapedSource[];
}

export interface GoogleStatus { state: 'configured' | 'error'; reason: string }

const CREDENTIAL_CODES = new Set([
  'credential-missing',
  'credential-unreadable',
  'credential-insufficient-scope',
  'credential-revoked',
  'credential-refresh-failed',
  // The pinned-account helper (lux-cli E2) refuses a missing variable with this code; both spellings
  // are accepted so a code is never mistaken for an untyped failure. The message is never read.
  'credential-missing-env',
  'credential_missing',
]);

/** The helper refuses the account itself with these codes: an identity refusal, not a missing grant. */
const IDENTITY_REFUSAL_CODES = new Set(['account_mismatch', 'account-mismatch', 'identity_unverified', 'identity-unverified']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts the original permitted first text content item from the adapter-decoded result.
 * Transport framing is never interpreted by the connector.
 */
export function decodeMcpContentText(parsed: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: 'unsupported_mcp_envelope' };
  const result = isRecord(parsed['result']) ? parsed['result'] : parsed;
  const content = result['content'];
  if (!Array.isArray(content) || content.length < 1 || !isRecord(content[0]) || typeof content[0]['text'] !== 'string') return { ok: false, reason: 'unsupported_mcp_envelope' };
  return { ok: true, text: content[0]['text'] as string };
}

/**
 * Decodes the helper's JSON envelope from the stored MCP payload. Accepts either the full
 * JSON-RPC message or the bare result object, mirroring the adapter's stored bytes.
 */
export function decodeGoogleEnvelope(payloadText: string): { ok: true; envelope: Record<string, unknown> } | { ok: false; reason: string } {
  let envelope: unknown;
  try { envelope = JSON.parse(payloadText); } catch { return { ok: false, reason: 'unsupported_mcp_envelope' }; }
  if (!isRecord(envelope)) return { ok: false, reason: 'unsupported_mcp_envelope' };
  return { ok: true, envelope };
}

/** Verifies the whole original entity, then consumes the separately decoded MCP result. */
export function readGooglePayload(port: McpPort, evidence: ConnectorEvidence): { ok: true; text: string } | { ok: false; reason: string } {
  const payload: StoredPayload = evidence.response;
  if (payload.state !== 'available' || payload.encoding !== 'http-response-entity') return { ok: false, reason: 'payload_unavailable' };
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

/** The helper's typed credential error is a tool-error whose text starts with a stable code. */
export function credentialFailure(text: string): boolean {
  return CREDENTIAL_CODES.has(codeOf(text));
}

/** An identity refusal is the helper's pinned-account gate, never a missing grant. */
export function identityRefusal(text: string): boolean {
  return IDENTITY_REFUSAL_CODES.has(codeOf(text));
}

/** The stable leading code of one helper error text; the rest of the message is never read. */
function codeOf(text: string): string {
  const separator = text.indexOf(':');
  return (separator === -1 ? text : text.slice(0, separator)).trim();
}

/**
 * Status for a completed-but-failed tool call. A typed credential error maps to a visible
 * configured/auth-needed status naming the helper's own authorize command, an identity refusal
 * maps to a named identity error, and any other failure is an error. Never an empty success.
 */
export function googleToolStatus(evidence: ConnectorEvidence): GoogleStatus | undefined {
  if (evidence.state === 'completed') return undefined;
  const content = decodeMcpContentText(evidence.decodedResult);
  if (!content.ok) return { state: 'error', reason: 'tool call failed; no content' };
  if (identityRefusal(content.text)) return { state: 'error', reason: `identity refused: ${codeOf(content.text)}` };
  if (credentialFailure(content.text)) return { state: 'configured', reason: `auth needed: run ${authorizeCommand(evidence)}` };
  return { state: 'error', reason: 'tool call failed' };
}

/** The helper's own consent command for this family: a command name only, never a token path. */
function authorizeCommand(evidence: ConnectorEvidence): string {
  const family = typeof evidence.tool === 'string' && evidence.tool.startsWith('gmail') ? 'gmail' : 'calendar';
  return `lux-google-mcp authorize --family ${family}`;
}

/** Rich, clean projection of one tool's decoded envelope data (see live-shape.ts). */
export function renderGoogleTool(tool: string, data: unknown): GoogleProjection {
  const dataRecord = isRecord(data) ? data : {};
  const shaped: ShapedResult = tool === 'gmail_search_messages' ? shapeGmailList(dataRecord)
    : tool === 'gmail_read_message' ? shapeGmailRead(dataRecord)
    : tool === 'calendar_list_calendars' ? shapeGcalCalendars(dataRecord)
    : shapeGcalList(dataRecord);
  return shaped;
}

/** Full projection of a completed google result: decode, render, report partial. Never throws on a bad envelope. */
export function projectGoogleResult(port: McpPort, evidence: ConnectorResult): { ok: true; projection: GoogleProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: 'tool_error' };
  const payload = readGooglePayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  const decoded = decodeGoogleEnvelope(payload.text);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const data = decoded.envelope['data'];
  if (!isRecord(data)) return { ok: false, reason: 'unsupported_google_data' };
  const coverage = decoded.envelope['coverage'];
  const native = isRecord(coverage) ? coverage : {};
  const token = native['next_page_token'];
  if (token !== undefined && token !== null && (typeof token !== 'string' || token.length === 0 || token.length > 4096)) return { ok: false, reason: 'invalid_google_continuation' };
  if (typeof token === 'string' && data['nextPageToken'] !== undefined && data['nextPageToken'] !== token) return { ok: false, reason: 'conflicting_google_continuation' };
  if (native['complete'] !== undefined && typeof native['complete'] !== 'boolean') return { ok: false, reason: 'invalid_google_coverage' };
  const projection = renderGoogleTool(evidence.tool, { ...data, ...(typeof token === 'string' ? { nextPageToken: token } : {}), ...(native['complete'] === false ? { sourceIncomplete: true } : {}) });
  const body = evidence.tool === 'gmail_read_message' ? receivedGmailBody(data) : undefined;
  if (body !== undefined && evidence.response.state === 'available') {
    const bodyCoverage = isRecord(data['bodyCoverage']) ? data['bodyCoverage'] : {};
    const complete = typeof bodyCoverage['complete'] === 'boolean' ? bodyCoverage['complete'] : 'unknown';
    projection[HOST_EVIDENCE] = { kind: 'remote-body', source: structuredClone(evidence.source), entitySha256: evidence.response.sha256, bodySha256: sha256(body), expiresAt: evidence.response.expiresAt, tool: evidence.tool, body, upstreamComplete: complete, upstreamOmitted: complete === 'unknown' ? 'unknown' : !complete };
  }
  return { ok: true, projection };
}

export type { GoogleEvidence, GoogleResult, GoogleTool, CompletedResult };
