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

/** One minimal MCP-over-HTTP client: initialize, initialized, then exactly one save_insight. No retry at any layer. */
export function createLuxWriteTransport(endpoint: LuxWriteEndpoint, fetchImpl: typeof fetch = fetch): VaultTransport {
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

  return {
    async save(args: VaultSaveArgs): Promise<VaultTransportResult> {
      if (!allowed || VAULT_REMOTE_TOOL !== 'save_insight') return { outcome: 'unavailable' };
      let init: { ok: boolean; json: unknown };
      try {
        init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'didi-vault-write', version: '1' } } });
      } catch { return { outcome: 'unavailable' }; }
      if (!init.ok) return { outcome: 'unavailable' };
      try { await post({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch { return { outcome: 'unavailable' }; }
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
