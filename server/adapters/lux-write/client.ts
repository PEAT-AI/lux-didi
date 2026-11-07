import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { ToolDefinition } from '../mcp/port.js';
import { LUX_TOOLS, LUX_PARAMS, LUX_FORBIDDEN_TOOLS, luxWriteAdmitted } from '../../connectors/lux-names.js';
import { hostLogEvent } from '../../tools/host-events.js';
import type { VaultTransportPhase, VaultSaveArgs, VaultTransport, VaultTransportResult, VaultWriteResult } from '../../tools/vault-write.js';

export interface LuxWriteEndpoint { readonly url: string; readonly token?: string }
export function luxWriteEndpoint(env: NodeJS.ProcessEnv = process.env): LuxWriteEndpoint {
  const token = env['LUX_KNOWLEDGE_TOKEN'];
  return { url: env['LUX_KNOWLEDGE_URL'] ?? 'http://127.0.0.1:8765/mcp', ...(token ? { token } : {}) };
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function localEndpoint(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname) && parsed.username === '' && parsed.password === ''; }
  catch { return false; }
}
const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 8000;
function parseMessage(text: string): unknown {
  try { return JSON.parse(text); } catch { /* MCP SSE carries JSON in data lines. */ }
  for (const line of text.split('\n')) if (line.startsWith('data:')) {
    try { return JSON.parse(line.slice(5).trim()); } catch { /* Ignore non-JSON progress frames. */ }
  }
  return undefined;
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function decoded(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(record).filter(item => item?.type === 'text').map(item => String(item!.text ?? '')).join('\n');
  return parseMessage(text) ?? text;
}
export interface LuxWriteTransport extends VaultTransport {
  write(tool: string, args: Record<string, unknown>, authorized?: () => boolean): Promise<VaultWriteResult>;
  nearDuplicate(text: string): Promise<number | undefined>;
}
const tokensOf = (text: string): Set<string> => new Set(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(word => word.length > 1));
function wordOverlap(a: string, b: string): number {
  const left = tokensOf(a), right = tokensOf(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** Existing write path: each operation gets its own MCP session, discovery and one mutation, never a retry. */
export function createLuxWriteTransport(endpoint: LuxWriteEndpoint, fetchImpl: typeof fetch = fetch): LuxWriteTransport {
  const allowed = localEndpoint(endpoint.url), validator = new AjvJsonSchemaValidator();
  const phase = (value: VaultTransportPhase): void => hostLogEvent({ event: 'vault_transport', phase: value });
  const refused = (reason: string): VaultWriteResult => ({ disposition: 'refused', reason });
  const session = async (): Promise<{ tools: readonly ToolDefinition[]; post(body: Record<string, unknown>): Promise<Record<string, unknown>> } | undefined> => {
    if (!allowed) { phase('endpoint_rejected'); return; }
    let sessionId: string | undefined;
    const post = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await fetchImpl(endpoint.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify(body) });
      const id = response.headers.get('mcp-session-id'); if (id) sessionId = id;
      if (!response.ok) throw Error('http');
      const text = await response.text();
      if (body.method === 'notifications/initialized') return {};
      const message = record(parseMessage(text));
      if (!message || message.error || !record(message.result)) throw Error('protocol');
      return record(message.result)!;
    };
    try { await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'didi-vault-write', version: '1' } } }); }
    catch (error) { phase(error instanceof Error && error.message === 'http' ? 'initialize_http' : 'initialize_transport'); return; }
    try { await post({ jsonrpc: '2.0', method: 'notifications/initialized' }); }
    catch { phase('initialized_notify'); return; }
    try {
      const result = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      if (!Array.isArray(result.tools) || result.nextCursor !== undefined) { phase('schema_rejected'); return; }
      const tools = result.tools.filter(tool => { const item = record(tool); return item && typeof item.name === 'string' && record(item.inputSchema); }) as ToolDefinition[];
      if (tools.length !== result.tools.length) { phase('schema_rejected'); return; }
      return { tools, post };
    } catch { phase('schema_rejected'); return; }
  };
  const write = async (tool: string, args: Record<string, unknown>, authorized?: () => boolean): Promise<VaultWriteResult> => {
    if ((LUX_FORBIDDEN_TOOLS as readonly string[]).includes(tool)) return refused('tool_missing_or_forbidden');
    const connection = await session();
    if (!connection) return refused('transport_unavailable');
    const declaration = connection.tools.find(item => item.name === tool);
    if (!declaration || !luxWriteAdmitted(declaration)) { phase('schema_rejected'); return refused('tool_missing_or_forbidden'); }
    const properties = record(declaration.inputSchema.properties);
    if (Object.keys(args).some(key => !properties || !Object.hasOwn(properties, key))) return refused('unknown_wire_parameter');
    if (!validator.getValidator(declaration.inputSchema)(args).valid) return refused('invalid_arguments');
    if (authorized && !authorized()) return refused('write_grant_revoked');
    let result: Record<string, unknown>;
    try { result = await connection.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } }); }
    catch (error) { phase(error instanceof Error && error.message === 'http' ? 'call_http' : 'call_transport'); return refused('outcome_unknown'); }
    if (result.isError === true) return refused('upstream_error');
    const body = decoded(result), receipt = record(body);
    if (tool === LUX_TOOLS.feedback && typeof body === 'string') {
      const match = /^Recorded (useful|wrong|stale|irrelevant) feedback on insight (\d+) as row (\d+)\.$/.exec(body);
      return match && match[1] === args[LUX_PARAMS.verdict] && Number(match[2]) === args[LUX_PARAMS.insightId]
        ? { disposition: 'recorded', insight_id: Number(match[2]) } : refused('invalid_receipt');
    }
    if (!receipt) { phase('schema_rejected'); return refused('invalid_receipt'); }
    if (tool === LUX_TOOLS.create) {
      if (!['created', 'duplicate_of', 'refused'].includes(String(receipt.disposition))) return refused('invalid_receipt');
      if (receipt.disposition !== 'refused' && (!Number.isSafeInteger(receipt.insight_id) || Number(receipt.insight_id) < 1)) return refused('invalid_receipt');
      return receipt as VaultWriteResult;
    }
    if (tool === LUX_TOOLS.update) return { ...receipt, disposition: receipt.action === 'updated' && receipt.insight_id === args[LUX_PARAMS.insightId] ? 'updated' : 'refused', ...(receipt.action !== 'updated' ? { reason: String(receipt.action ?? 'invalid_receipt') } : {}) } as VaultWriteResult;
    if (tool === LUX_TOOLS.link) return { ...receipt, disposition: ['created', 'exists'].includes(String(receipt.action)) && Number.isSafeInteger(receipt.link_id) ? 'linked' : 'refused', insight_id: Number(args[LUX_PARAMS.sourceInsightId]) } as VaultWriteResult;
    if (['created', 'updated', 'linked', 'recorded', 'duplicate_of', 'refused'].includes(String(receipt.disposition))) return receipt as VaultWriteResult;
    return refused('invalid_receipt');
  };
  return {
    write,
    async nearDuplicate(text) {
      const connection = await session();
      if (!connection) return undefined;
      const declaration = connection.tools.find(item => item.name === LUX_TOOLS.search);
      if (!declaration || record(declaration.annotations)?.readOnlyHint !== true) return undefined;
      const args = { [LUX_PARAMS.query]: text, [LUX_PARAMS.limit]: 5, ...(record(declaration.inputSchema.properties)?.[LUX_PARAMS.includeSensitive] ? { [LUX_PARAMS.includeSensitive]: true } : {}) };
      if (!validator.getValidator(declaration.inputSchema)(args).valid) return undefined;
      try { const result = await connection.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: declaration.name, arguments: args } }); return result.isError === true ? undefined : wordOverlap(text, JSON.stringify(decoded(result))); }
      catch { return undefined; }
    },
    async save(args: VaultSaveArgs): Promise<VaultTransportResult> {
      const receipt = await write(LUX_TOOLS.create, { [LUX_PARAMS.content]: args.content, [LUX_PARAMS.title]: args.title, [LUX_PARAMS.category]: args.insightType, [LUX_PARAMS.project]: args.project, ...args.source });
      if (receipt.disposition === 'created') return { outcome: 'inserted', insightId: String(receipt.insight_id) };
      if (receipt.disposition === 'duplicate_of') return { outcome: 'duplicate' };
      return { outcome: receipt.reason === 'outcome_unknown' ? 'unknown' : receipt.reason === 'transport_unavailable' ? 'unavailable' : 'failed' };
    },
  };
}
