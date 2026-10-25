import { validInsightId, VAULT_REMOTE_TOOL, type VaultSaveArgs, type VaultTransport, type VaultTransportResult } from '../../tools/vault-write.js';

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

interface VaultPayload { action: string; insight_id?: unknown }
function vaultPayload(result: unknown): VaultPayload | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as { structuredContent?: unknown; content?: unknown; isError?: unknown };
  if (value.isError === true) return undefined;
  const candidates: unknown[] = [value.structuredContent];
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') candidates.push(parseMessage(String((item as { text?: unknown }).text ?? '')));
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const payload = candidate as Record<string, unknown>;
    if (typeof payload['action'] === 'string') return { action: payload['action'], ...(payload['insight_id'] === undefined ? {} : { insight_id: payload['insight_id'] }) };
  }
  return undefined;
}

export interface LuxWriteTransport extends VaultTransport {
  /** W6 item 12: the closest existing lux row's word overlap, or undefined when the probe cannot answer. */
  nearDuplicate(text: string): Promise<number | undefined>;
}

const tokensOf = (text: string): Set<string> => new Set(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(word => word.length > 1));
/** How much of the shorter text the longer one already holds, which is what a near duplicate is. */
export function wordOverlap(a: string, b: string): number {
  const left = tokensOf(a), right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** One minimal MCP-over-HTTP client: initialize, initialized, then exactly one save_insight. No retry at any layer. */
export function createLuxWriteTransport(endpoint: LuxWriteEndpoint, fetchImpl: typeof fetch = fetch): LuxWriteTransport {
  const allowed = localEndpoint(endpoint.url);
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
    catch { return false; }
    if (!init.ok) return false;
    try { await post({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch { return false; }
    return true;
  };

  return {
    /** A read probe only: search_knowledge is asked, and nothing is ever written here. */
    async nearDuplicate(text: string): Promise<number | undefined> {
      if (!allowed) return undefined;
      if (!(await initialize())) return undefined;
      let call: { ok: boolean; json: unknown };
      try { call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_knowledge', arguments: { query: text, limit: 5 } } }); }
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
      if (!allowed || VAULT_REMOTE_TOOL !== 'save_insight') return { outcome: 'unavailable' };
      if (!(await initialize())) return { outcome: 'unavailable' };
      let call: { ok: boolean; json: unknown };
      try {
        call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: VAULT_REMOTE_TOOL, arguments: { content: args.content, insight_title: args.title, insight_type: args.insightType, project: args.project } } });
      } catch { return { outcome: 'unknown' }; }
      if (!call.ok) return { outcome: 'failed' };
      if (!call.json || typeof call.json !== 'object' || 'error' in (call.json as Record<string, unknown>)) return { outcome: 'failed' };
      const payload = vaultPayload((call.json as { result?: unknown }).result);
      if (!payload) return { outcome: 'failed' };
      if (payload.action === 'inserted' && validInsightId(payload.insight_id)) return { outcome: 'inserted', insightId: payload.insight_id };
      if (payload.action === 'duplicate') return { outcome: 'duplicate' };
      return { outcome: 'failed' };
    },
  };
}
