import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { CompletedResult, McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { GoogleEvidence, GoogleResult, GoogleTool } from '../connectors/google.js';
import { sha256 } from './canonical.js';

/** Hard projection bound for one rich projection (message body or the whole list). */
export const GOOGLE_PROJECTION_CHARS = 4000;

export interface GoogleProjection {
  text: string;
  /** True when the raw projection was longer than the bound and the tail was dropped. */
  partial: boolean;
  originalCharacters: number;
  omittedCharacters: number;
}

export interface GoogleStatus { state: 'configured' | 'error'; reason: string }

const CREDENTIAL_CODES = new Set([
  'credential-missing',
  'credential-unreadable',
  'credential-insufficient-scope',
  'credential-revoked',
  'credential-refresh-failed',
]);

/** Markdown projection of the bounded MCP result. Never returns the full body unbounded. */
export function boundedProjection(text: string, bound = GOOGLE_PROJECTION_CHARS): GoogleProjection {
  if (text.length <= bound) return { text, partial: false, originalCharacters: text.length, omittedCharacters: 0 };
  return { text: text.slice(0, bound), partial: true, originalCharacters: text.length, omittedCharacters: text.length - bound };
}

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
  const separator = text.indexOf(':');
  const code = (separator === -1 ? text : text.slice(0, separator)).trim();
  return CREDENTIAL_CODES.has(code);
}

/**
 * Status for a completed-but-failed tool call. A typed credential error maps to a visible
 * configured/auth-needed status, never an empty success. Any other failure is an error.
 */
export function googleToolStatus(evidence: ConnectorEvidence): GoogleStatus | undefined {
  if (evidence.state === 'completed') return undefined;
  const content = decodeMcpContentText(evidence.decodedResult);
  if (!content.ok) return { state: 'error', reason: 'tool call failed; no content' };
  return credentialFailure(content.text)
    ? { state: 'configured', reason: 'auth needed: run gcal --auth' }
    : { state: 'error', reason: 'tool call failed' };
}

function headerName(source: Record<string, unknown>): string {
  const from = typeof source['headers'] === 'object' && source['headers'] !== null ? (source['headers'] as Record<string, unknown>)['From'] : undefined;
  if (typeof from !== 'string') return '';
  const match = /^\s*"?([^"<]*?)"?\s*</.exec(from);
  return (match?.[1] ?? from).trim();
}
function headerValue(source: Record<string, unknown>, name: string): string {
  const headers = source['headers'];
  if (!isRecord(headers)) return '';
  const value = headers[name];
  return typeof value === 'string' ? value : '';
}
function messageSubject(message: Record<string, unknown>): string {
  const subject = headerValue(message, 'Subject');
  if (subject) return subject;
  return typeof message['snippet'] === 'string' ? message['snippet'] : '(no subject)';
}
function inboxUrl(id: unknown): string | undefined {
  return typeof id === 'string' && id.length > 0 ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}` : undefined;
}

/** Pure Markdown projection of one tool's decoded envelope data. */
export function renderGoogleTool(tool: string, data: unknown): GoogleProjection {
  const dataRecord = isRecord(data) ? data : {};
  if (tool === 'gmail_list') {
    const messages = Array.isArray(dataRecord['messages']) ? dataRecord['messages'] as unknown[] : [];
    const lines: string[] = [];
    for (const entry of messages) {
      if (!isRecord(entry)) continue;
      lines.push(`- ${messageSubject(entry)}, ${headerName(entry) || 'unknown sender'}, ${headerValue(entry, 'Date') || 'unknown date'}`);
      const url = inboxUrl(entry['id']);
      if (url) lines.push(`  source: ${url}`);
    }
    return boundedProjection(lines.join('\n'));
  }
  if (tool === 'gmail_read') {
    const subject = headerValue(dataRecord, 'Subject') || '(no subject)';
    const from = headerName(dataRecord);
    const date = headerValue(dataRecord, 'Date');
    const body = typeof dataRecord['body'] === 'string' ? dataRecord['body'] : '';
    const head = [`subject: ${subject}`, `from: ${from || 'unknown sender'}`, `date: ${date || 'unknown date'}`, ''].join('\n');
    const combined = head + body;
    const projection = boundedProjection(combined);
    const note = projection.partial ? `\n\n[body truncated: showing ${projection.text.length - head.length} of ${body.length} characters]` : '';
    return { ...projection, text: projection.text + note };
  }
  if (tool === 'gcal_calendars') {
    const calendars = Array.isArray(dataRecord['calendars']) ? dataRecord['calendars'] as unknown[] : [];
    const lines = calendars.flatMap(entry => {
      if (!isRecord(entry)) return [];
      const name = typeof entry['summary'] === 'string' ? entry['summary'] : String(entry['id'] ?? 'calendar');
      return [`- ${name}`];
    });
    return boundedProjection(lines.join('\n'));
  }
  // gcal_list
  const events = Array.isArray(dataRecord['events']) ? dataRecord['events'] as unknown[] : [];
  const lines: string[] = [];
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    const start = isRecord(entry['start']) ? entry['start'] : {};
    const when = typeof start['dateTime'] === 'string' ? start['dateTime'] : (typeof start['date'] === 'string' ? start['date'] : 'time unknown');
    const title = typeof entry['summary'] === 'string' ? entry['summary'] : '(no title)';
    const location = typeof entry['location'] === 'string' ? entry['location'] : '';
    lines.push(`- ${when}, ${title}${location ? `, ${location}` : ''}`);
    if (typeof entry['htmlLink'] === 'string' && entry['htmlLink'].length > 0) lines.push(`  source: ${entry['htmlLink']}`);
  }
  return boundedProjection(lines.join('\n'));
}

/** Full projection of a completed google result: decode, render, report partial. Never throws on a bad envelope. */
export function projectGoogleResult(port: McpPort, evidence: ConnectorResult): { ok: true; projection: GoogleProjection } | { ok: false; reason: string } {
  if (evidence.state === 'refused' || evidence.state === 'unknown') return { ok: false, reason: evidence.reason };
  if (evidence.state !== 'completed') return { ok: false, reason: 'tool_error' };
  const payload = readGooglePayload(port, evidence);
  if (!payload.ok) return { ok: false, reason: payload.reason };
  const decoded = decodeGoogleEnvelope(payload.text);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, projection: renderGoogleTool(evidence.tool, decoded.envelope['data']) };
}

export type { GoogleEvidence, GoogleResult, GoogleTool, CompletedResult };
