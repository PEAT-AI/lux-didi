import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import type { CompletedResult, McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { GoogleEvidence, GoogleResult, GoogleTool } from '../connectors/google.js';
import { HOST_EVIDENCE, type ConnectionEndpoint, type HostEvidenceRef } from './types.js';
import { sha256 } from './canonical.js';
import { shapeDriveFile, shapeDriveSearch, shapeGcalCalendars, shapeGcalList, shapeGmailList, shapeGmailRead, receivedGmailBody, type ShapedResult, type ShapedSource } from './live-shape.js';

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

/** A content-free line for a failure Didi must log: a code or a hashed code head, never helper text. */
export interface GoogleStatusLog {
  event: 'tool_failure'; code: 'connector_error';
  tool: string; connector: 'google'; errorClass: 'Error'; messageHead: string;
}

export interface GoogleStatus {
  state: 'configured' | 'error';
  /** The closed reason: the helper's own code, unknown_helper_code, or a local reason for a bodiless error. */
  code: string;
  /** The one clause Naya says for this failure; never an empty result. */
  reason: string;
  log?: GoogleStatusLog;
}

export type GoogleErrorClass = 'credential' | 'identity' | 'caller' | 'transient' | 'provider';
/** What the host does about one failure class: nothing while pinned, one retry on the next ask, or a logged defect. */
export type GoogleErrorRecovery = 'none' | 'retry_next_ask' | 'log_defect';

/** One row of the helper's published failure vocabulary (lux-cli tools/google-mcp/error-contract.json). */
export interface GoogleErrorEntry {
  readonly class: GoogleErrorClass;
  /** A pinned refusal cannot be changed by a fresh retry in this process until the credential file changes. */
  readonly pinned: boolean;
  /** The one clause Naya says; AUTHORIZE becomes the helper's own authorize command for this family. */
  readonly ownerLine: string;
  readonly recovery: GoogleErrorRecovery;
}

const AUTHORIZE = '{authorize}';

/**
 * Didi's one source of truth for the Google helper's closed failure vocabulary. Every emitted code of
 * the published contract has a row, so a code the helper adds is unknown until this table grows.
 * Provenance: lux-cli candidate 6ee466f0bce423ce76102970efa9909bfd697530 on train/google-ipc-1024,
 * pinned as a candidate because it is source-reviewed but not yet installed.
 */
export const GOOGLE_ERROR_TABLE: Readonly<Record<string, GoogleErrorEntry>> = {
  'account-mismatch': { class: 'identity', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} for the account you configured`, recovery: 'none' },
  'binding-unknown': { class: 'caller', pinned: false, ownerLine: 'the Google helper was started without the account family I asked for, so I stopped and logged it', recovery: 'log_defect' },
  'credential-missing': { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to sign in again`, recovery: 'none' },
  'credential-overwrite-refused': { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to replace a sign-in file that belongs to another account`, recovery: 'none' },
  'credential-refresh-failed': { class: 'transient', pinned: false, ownerLine: 'the Google sign-in could not be refreshed just now, ask me again and I will retry', recovery: 'retry_next_ask' },
  'credential-revoked': { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to sign in again`, recovery: 'none' },
  'credential-scope-mismatch': { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to grant the read scopes again`, recovery: 'none' },
  'credential-unreadable': { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to sign in again`, recovery: 'none' },
  'family-unknown': { class: 'caller', pinned: false, ownerLine: 'the Google helper does not serve that account family, so I stopped and logged it', recovery: 'log_defect' },
  'google-helper-error': { class: 'provider', pinned: false, ownerLine: 'the Google helper could not write its sign-in file, so I stopped and logged it', recovery: 'log_defect' },
  'identity-unverified': { class: 'identity', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} and sign in as the account you configured`, recovery: 'none' },
  'provider-failure': { class: 'provider', pinned: false, ownerLine: 'the Google service failed just now, ask me again and I will retry', recovery: 'retry_next_ask' },
  'tool-argument': { class: 'caller', pinned: false, ownerLine: 'I built the wrong arguments for the Google helper, so I stopped and logged it', recovery: 'log_defect' },
  'tool-unknown': { class: 'caller', pinned: false, ownerLine: 'the Google helper does not have that tool, so I stopped and logged it', recovery: 'log_defect' },
  // The two spellings the installed helper still emits. Delete both rows, and the test that pins
  // them, when the lux-cli release carrying error-contract.json 6ee466f0 is installed.
  'credential-missing-env': { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to sign in again`, recovery: 'none' },
  credential_missing: { class: 'credential', pinned: true, ownerLine: `auth needed: run ${AUTHORIZE} to sign in again`, recovery: 'none' },
  // C-OPEN 2: the Drive family's two typed refusals (lux-cli drive family, C-DRIVE.md).
  scope_missing: { class: 'credential', pinned: true, ownerLine: `Drive needs a one-time consent first: run ${AUTHORIZE} once`, recovery: 'none' },
  not_found: { class: 'caller', pinned: false, ownerLine: 'that Drive file is not there any more, or it is not shared with him', recovery: 'none' },
};

/** The closed reason for a code outside the table: never silent, never a raw helper line. */
export const UNKNOWN_HELPER_REASON = 'unknown_helper_code';
export const UNKNOWN_HELPER_OWNER_LINE = 'the Google helper answered with an error I do not know, say the word and I will try again later';

export function googleErrorEntry(code: string): GoogleErrorEntry | undefined {
  return Object.hasOwn(GOOGLE_ERROR_TABLE, code) ? GOOGLE_ERROR_TABLE[code] : undefined;
}

/** The owner line for one row, with the helper's own consent command filled in for this family. */
export function googleOwnerLine(entry: GoogleErrorEntry, family: string, endpoint?: ConnectionEndpoint): string {
  return entry.ownerLine.split(AUTHORIZE).join(authorizeCommandFor(family, endpoint));
}

/** A code outside the table is logged by its first 32 characters, hashed, so no helper text travels. */
export function googleUnknownLog(code: string, tool: string): GoogleStatusLog {
  return { event: 'tool_failure', code: 'connector_error', tool, connector: 'google', errorClass: 'Error', messageHead: sha256(code.slice(0, 32)) };
}

/** A caller-class code is a Didi defect: the closed code and the tool name, nothing else. */
export function googleDefectLog(code: string, tool: string): GoogleStatusLog {
  return { event: 'tool_failure', code: 'connector_error', tool, connector: 'google', errorClass: 'Error', messageHead: code };
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

/** The stable leading code of one helper error text; the rest of the message is never read. */
function codeOf(text: string): string {
  const separator = text.indexOf(':');
  return (separator === -1 ? text : text.slice(0, separator)).trim();
}

/**
 * Status for a completed-but-failed tool call, driven by the one vocabulary table. Only a pinned
 * credential or identity row is `configured`, the one status that stops the reads until the credential
 * file changes; every other failure, and a code outside the table, is `error`, so one failed call never
 * marks the endpoint dead. Either way the status names the helper's code and its own line, never a state
 * word and never an empty success.
 */
export function googleToolStatus(evidence: ConnectorResult, endpoint?: ConnectionEndpoint): GoogleStatus | undefined {
  if (evidence.state === 'completed') return undefined;
  // Ruling TR4-R8: a refused call speaks the closed code in the owner's words instead of answering
  // silently. The latch and refusal carry identity codes with an underscore where the helper's own
  // vocabulary uses a hyphen, and the one table above is the only place those words live.
  if (evidence.state === 'refused') {
    const refused = codeOf(evidence.reason).replace(/_/g, '-');
    const row = googleErrorEntry(refused);
    if (row !== undefined) {
      // A refused result carries no tool name, so the endpoint names the family for the consent command.
      const named = `${endpoint?.id ?? ''} ${endpoint?.resource ?? ''}`.toLowerCase();
      const family = /gmail/.test(named) ? 'gmail' : /drive/.test(named) ? 'drive' : 'calendar';
      return { state: row.pinned ? 'configured' : 'error', code: refused, reason: googleOwnerLine(row, family, endpoint) };
    }
  }
  // Past the refused branch the result is a completed envelope, and only that shape carries a tool.
  const record = evidence as ConnectorEvidence;
  const content = decodeMcpContentText(record.decodedResult);
  if (!content.ok) return { state: 'error', code: 'no_content', reason: 'tool call failed; no content' };
  const code = codeOf(content.text);
  const entry = googleErrorEntry(code);
  if (entry === undefined) {
    return { state: 'error', code: UNKNOWN_HELPER_REASON, reason: UNKNOWN_HELPER_OWNER_LINE, log: googleUnknownLog(code, record.tool) };
  }
  const log = entry.recovery === 'log_defect' ? googleDefectLog(code, record.tool) : undefined;
  return { state: entry.pinned ? 'configured' : 'error', code, reason: googleOwnerLine(entry, googleFamilyOf(record), endpoint), ...(log ? { log } : {}) };
}

/** The two variables the helper reads its own binding from (lux-cli google_mcp/binding.py). */
const HELPER_ACCOUNT_ENV = 'LUX_GOOGLE_MCP_ACCOUNT';
const HELPER_TOKEN_ENV = 'LUX_GOOGLE_MCP_TOKEN';
/** One argv word: no space, no quote, no shell metacharacter, so the owner line stays one command. */
const SAFE_BINDING = /^[A-Za-z0-9._@+/-]{1,512}$/;

/**
 * The helper's own consent command for this family. With a configured stdio endpoint the command also
 * names the binding the helper itself reads: the token *path* and the account, never a token value, so
 * the owner can run it once without looking anything up. A word that is not a plain path or address is
 * left out, so the line never becomes a second command.
 */
function authorizeCommandFor(family: string, endpoint?: ConnectionEndpoint): string {
  const command = `lux-google-mcp authorize --family ${family}`;
  if (endpoint === undefined || !('transport' in endpoint)) return command;
  const account = endpoint.env?.[HELPER_ACCOUNT_ENV];
  const token = endpoint.env?.[HELPER_TOKEN_ENV];
  if (account === undefined || token === undefined || !SAFE_BINDING.test(account) || !SAFE_BINDING.test(token)) return command;
  return `${command} --token ${token} --account ${account}`;
}

function googleFamilyOf(evidence: ConnectorEvidence): string {
  if (typeof evidence.tool !== 'string') return 'calendar';
  return evidence.tool.startsWith('gmail') ? 'gmail' : evidence.tool.startsWith('drive') ? 'drive' : 'calendar';
}

/** Rich, clean projection of one tool's decoded envelope data (see live-shape.ts). */
export function renderGoogleTool(tool: string, data: unknown): GoogleProjection {
  const dataRecord = isRecord(data) ? data : {};
  const shaped: ShapedResult = tool === 'gmail_search_messages' ? shapeGmailList(dataRecord)
    : tool === 'gmail_read_message' ? shapeGmailRead(dataRecord)
    : tool === 'calendar_list_calendars' ? shapeGcalCalendars(dataRecord)
    : tool === 'drive_search_files' ? shapeDriveSearch(dataRecord)
    : tool === 'drive_get_file' ? shapeDriveFile(dataRecord)
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
