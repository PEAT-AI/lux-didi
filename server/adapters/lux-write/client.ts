import { LUX_TOOLS, LUX_WRITE_TOOLS } from '../../connectors/lux-names.js';
import { hostLogEvent } from '../../tools/host-events.js';
import { type VaultTransportPhase, type VaultSaveArgs, type VaultTransport, type VaultTransportResult, type VaultWriteResult } from '../../tools/vault-write.js';

/** The local lux-knowledge MCP endpoint a vault write may reach, and nothing else. */
export interface LuxWriteEndpoint { readonly url: string; readonly token?: string }
export function luxWriteEndpoint(env: NodeJS.ProcessEnv = process.env): LuxWriteEndpoint {
  const token = env['LUX_KNOWLEDGE_TOKEN'];
  return { url: env['LUX_KNOWLEDGE_URL'] ?? 'http://127.0.0.1:8765/mcp', ...(token ? { token } : {}) };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function localEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname) && parsed.username === '' && parsed.password === '';
  } catch { return false; }
}

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 8000;

function parseMessage(text: string): unknown {
  const body = text.trim();
  if (!body) return undefined;
  if (body.startsWith('{')) { try { return JSON.parse(body); } catch { return undefined; } }
  for (const line of body.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (data.startsWith('{')) { try { return JSON.parse(data); } catch { return undefined; } }
  }
  return undefined;
}

export interface LuxWriteTransport extends VaultTransport {
  write(tool: string, args: Record<string, unknown>): Promise<VaultWriteResult>;
  /** W6 item 12: the closest existing lux row's word overlap, or undefined when the probe cannot answer. */
  nearDuplicate(text: string): Promise<number | undefined>;
}

const tokensOf = (text: string): Set<string> => new Set(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(word => word.length > 1));
/** How much of the shorter text the longer one already holds, which is what a near duplicate is. */
function wordOverlap(a: string, b: string): number {
  const left = tokensOf(a), right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** One minimal MCP-over-HTTP client: initialize, initialized, then exactly one save_insight. No retry at any layer. */
export function createLuxWriteTransport(endpoint: LuxWriteEndpoint, fetchImpl: typeof fetch = fetch): LuxWriteTransport {
  const allowed = localEndpoint(endpoint.url);
  const phase = (value: VaultTransportPhase): void => hostLogEvent({ event: 'vault_transport', phase: value });
  const base: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) };
  let session: string | undefined;

  const post = async (body: Record<string, unknown>): Promise<{ ok: boolean; json: unknown }> => {
    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: session ? { ...base, 'mcp-session-id': session } : base,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const id = response.headers.get('mcp-session-id');
    if (id) session = id;
    const text = await response.text();
    return { ok: response.ok, json: parseMessage(text) };
  };

  const initialize = async (): Promise<boolean> => {
    let init: { ok: boolean; json: unknown };
    try { init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'didi-vault-write', version: '1' } } }); }
    catch { phase('initialize_transport'); return false; }
    if (!init.ok) { phase('initialize_http'); return false; }
    try { const notice = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }); if (!notice.ok) { phase('initialized_notify'); return false; } } catch { phase('initialized_notify'); return false; }
    return true;
  };

  const write = async (tool: string, args: Record<string, unknown>): Promise<VaultWriteResult> => {
    if (!allowed || !(LUX_WRITE_TOOLS as readonly string[]).includes(tool)) return { disposition: 'refused', reason: 'tool_not_allowed' };
    if (!(await initialize())) return { disposition: 'refused', reason: 'transport_unavailable' };
    try {
      const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
      if (!call.ok || !call.json || typeof call.json !== 'object' || 'error' in call.json) return { disposition: 'refused', reason: 'upstream_error' };
      const result = (call.json as { result?: { structuredContent?: unknown; content?: { type?: string; text?: string }[]; isError?: boolean } }).result;
      if (!result || result.isError) return { disposition: 'refused', reason: 'upstream_error' };
      const payload = result.structuredContent ?? parseMessage(result.content?.find(item => item.type === 'text')?.text ?? '');
      if (!payload || typeof payload !== 'object') return { disposition: 'refused', reason: 'invalid_receipt' };
      const receipt = payload as VaultWriteResult;
      if (tool === LUX_TOOLS.create && !['created', 'duplicate_of', 'refused'].includes(receipt.disposition)) return { disposition: 'refused', reason: 'invalid_receipt' };
      return receipt;
    } catch { return { disposition: 'refused', reason: 'outcome_unknown' }; }
  };

  return {
    write,
    /** A read probe only: search_knowledge is asked, and nothing is ever written here. */
    async nearDuplicate(text: string): Promise<number | undefined> {
      if (!allowed) return undefined;
      if (!(await initialize())) return undefined;
      let call: { ok: boolean; json: unknown };
      try { call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: LUX_TOOLS.search, arguments: { query: text, limit: 5 } } }); }
      catch { return undefined; }
      if (!call.ok) return undefined;
      const bodies: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === 'string') { bodies.push(value); return; }
        if (Array.isArray(value)) { for (const item of value) collect(item); return; }
        if (value && typeof value === 'object') { for (const item of Object.values(value)) collect(item); }
      };
      const result = (call.json as { result?: unknown } | undefined)?.result;
      if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) return undefined;
      collect(result);
      let closest = 0;
      for (const body of bodies) closest = Math.max(closest, wordOverlap(text, body));
      return closest;
    },
    async save(args: VaultSaveArgs): Promise<VaultTransportResult> {
      const receipt = await write(LUX_TOOLS.create, { content: args.content, insight_title: args.title, insight_type: args.insightType, project: args.project });
      if (receipt.disposition === 'created' && Number.isSafeInteger(receipt.insight_id) && Number(receipt.insight_id) > 0) return { outcome: 'inserted', insightId: String(receipt.insight_id) };
      if (receipt.disposition === 'duplicate_of') return { outcome: 'duplicate' };
      return { outcome: receipt.reason === 'outcome_unknown' ? 'unknown' : receipt.reason === 'transport_unavailable' ? 'unavailable' : 'failed' };
    },
  };
}
