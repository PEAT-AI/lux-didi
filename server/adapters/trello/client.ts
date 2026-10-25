import { TRELLO_SERVER_ALLOW, type TrelloCallCode, type TrelloCallResult, type TrelloServerTool, type TrelloTransport } from '../../tools/trello.js';

/**
 * The one MCP client for the official Trello remote server: streamable HTTP, a bearer from the owner's
 * sign-in record, initialize once per server session, then tools/list or one tools/call. It never
 * retries, never follows a redirect and never returns a body it did not parse.
 */
export const TRELLO_MCP_URL = 'https://mcp.trello.com/v1';
const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 12_000;
const MAX_TOOL_PAGES = 10;

/** The bearer for one request, or the closed reason there is none. Never logged. */
export type TrelloTokenSource = () => Promise<{ ok: true; token: string } | { ok: false; code: 'not_signed_in' | 'auth_failed' | 'unavailable' }>;

function parseMessage(text: string): unknown {
  const body = text.trim();
  if (!body) return undefined;
  if (body.startsWith('{')) { try { return JSON.parse(body); } catch { return undefined; } }
  let found: unknown;
  for (const line of body.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (data.startsWith('{')) { try { const parsed: unknown = JSON.parse(data); if (parsed && typeof parsed === 'object' && 'id' in parsed) found = parsed; } catch { return undefined; } }
  }
  return found;
}

export function createTrelloTransport(options: { url?: string; token: TrelloTokenSource; fetch?: typeof fetch }): TrelloTransport {
  const url = options.url ?? TRELLO_MCP_URL;
  const fetchImpl = options.fetch ?? fetch;
  let session: string | undefined;
  let initialized = false;
  let nextId = 1;

  type Posted = { ok: true; json: unknown } | { ok: false; code: TrelloCallCode; sent: boolean };
  const post = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Posted> => {
    const token = await options.token();
    if (!token.ok) return { ok: false, code: token.code, sent: false };
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token.token}`, 'mcp-protocol-version': PROTOCOL_VERSION, ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      // A request that may have left the machine has no known outcome.
      return { ok: false, code: 'unknown', sent: true };
    }
    if (response.status === 401 || response.status === 403) { session = undefined; initialized = false; return { ok: false, code: 'auth_failed', sent: false }; }
    if (response.status === 429) return { ok: false, code: 'rate_limited', sent: false };
    if (response.status === 404 && session) { session = undefined; initialized = false; return { ok: false, code: 'unavailable', sent: false }; }
    if (response.status >= 500) return { ok: false, code: 'unknown', sent: true };
    if (!response.ok && response.status !== 202) return { ok: false, code: 'protocol_error', sent: true };
    const id = response.headers.get('mcp-session-id');
    if (id && /^[\x21-\x7e]{1,256}$/.test(id)) session = id;
    let text: string;
    try { text = await response.text(); } catch { return { ok: false, code: 'unknown', sent: true }; }
    return { ok: true, json: parseMessage(text) };
  };

  const ensureSession = async (signal?: AbortSignal): Promise<{ ok: true } | { ok: false; code: TrelloCallCode }> => {
    if (initialized) return { ok: true };
    const init = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'lux-didi', version: '1' } } }, signal);
    // Nothing was asked of the board yet, so an unanswered initialize is unavailable, never unknown.
    if (!init.ok) return { ok: false, code: init.code === 'unknown' || init.code === 'protocol_error' ? 'unavailable' : init.code };
    if (!init.json || typeof init.json !== 'object' || !('result' in init.json)) return { ok: false, code: 'unavailable' };
    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    if (!notified.ok) return { ok: false, code: notified.code === 'unknown' || notified.code === 'protocol_error' ? 'unavailable' : notified.code };
    initialized = true;
    return { ok: true };
  };

  const rpcResult = (json: unknown): { ok: true; value: unknown } | { ok: false; code: TrelloCallCode } => {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'protocol_error' };
    const message = json as Record<string, unknown>;
    if ('error' in message) return { ok: false, code: 'tool_error' };
    if (!('result' in message)) return { ok: false, code: 'protocol_error' };
    return { ok: true, value: message.result };
  };

  return {
    async tools(signal?: AbortSignal) {
      const ready = await ensureSession(signal);
      if (!ready.ok) return ready;
      const tools: TrelloServerTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const listed = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: cursor ? { cursor } : {} }, signal);
        if (!listed.ok) return { ok: false, code: listed.code === 'unknown' ? 'unavailable' : listed.code };
        const result = rpcResult(listed.json);
        if (!result.ok) return result;
        const value = result.value as { tools?: unknown; nextCursor?: unknown };
        if (!Array.isArray(value?.tools)) return { ok: false, code: 'protocol_error' };
        for (const tool of value.tools) {
          if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') tools.push({ name: (tool as { name: string }).name, inputSchema: (tool as { inputSchema?: unknown }).inputSchema });
        }
        if (typeof value.nextCursor !== 'string' || !value.nextCursor) return { ok: true, value: tools };
        cursor = value.nextCursor;
      }
      return { ok: false, code: 'protocol_error' };
    },
    async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<TrelloCallResult> {
      const allowed = TRELLO_SERVER_ALLOW[tool];
      if (!allowed || !allowed.includes(String(args['action']))) return { ok: false, code: 'not_allowed' };
      const ready = await ensureSession(signal);
      if (!ready.ok) return ready;
      const called = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } }, signal);
      if (!called.ok) return { ok: false, code: called.code };
      const result = rpcResult(called.json);
      if (!result.ok) return called.json === undefined ? { ok: false, code: 'unknown' } : result;
      if (result.value && typeof result.value === 'object' && (result.value as { isError?: unknown }).isError === true) return { ok: false, code: 'tool_error' };
      return { ok: true, value: result.value };
    },
  };
}
