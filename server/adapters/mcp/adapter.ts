import { Client, ProtocolError, StreamableHTTPClientTransport, isJSONRPCErrorResponse } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { McpRegistry } from './registry.js';
import type { CallRequest, CallResult, CompletedResult, DiscoveryResult, EndpointConfig, McpBudgets, McpPort, ResultScope, ResultStorePort, SliceRequest, SliceResult, StoredPayload, ToolDefinition } from './port.js';

export interface McpAdapterOptions {
  registry: McpRegistry;
  store: ResultStorePort;
  resolveCredential?: (reference: string) => Promise<string>;
  budgets?: Partial<McpBudgets>;
}
class PolicyError extends Error { constructor(readonly reason: string) { super(reason); } }
interface Operation { scope: ResultScope; signal: AbortSignal; dispatched: boolean; bytes?: Uint8Array; requestId?: string | number; explicitErrorCode?: number }
interface Session { client: Client; config: EndpointConfig; operation?: Operation }
const allowedHeaders = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'mcp-method', 'mcp-name']);

/** All HTTP egress passes this supported SDK fetch seam; native Host, no global patch. */
function guardedFetch(session: Session, options: McpAdapterOptions, budgets: McpBudgets): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const config = options.registry.endpoint(session.config.id);
    if (request.url !== config.url || config.url !== session.config.url) throw new PolicyError('destination-refused');
    for (const name of request.headers.keys()) if (!allowedHeaders.has(name)) throw new PolicyError('header-refused');
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new PolicyError('method-refused');
    const packet = request.method === 'POST' ? await request.clone().json() as { method?: string; id?: string | number } : undefined;
    const isCall = packet?.method === 'tools/call';
    const operation = isCall ? session.operation : undefined;
    if (isCall && (!operation || operation.dispatched)) throw new PolicyError('call-replay-refused');
    if (operation && !options.registry.authorizesScope(operation.scope)) throw new PolicyError('grant-revoked-before-dispatch');
    // Cancellation notification gets its own short deadline, not the already aborted call signal.
    const timeout = AbortSignal.timeout(packet?.method === 'notifications/cancelled' ? Math.min(200, budgets.timeoutMs) : budgets.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout, ...(operation ? [operation.signal] : [])]);
    const headers = new Headers(request.headers);
    if (config.credentialRef) {
      if (!options.resolveCredential) throw new PolicyError('credential-unavailable');
      const token = await bounded(options.resolveCredential(config.credentialRef), signal);
      if (!token || /[\r\n]/.test(token)) throw new PolicyError('credential-unavailable');
      headers.set('authorization', `Bearer ${token}`);
    }
    signal.throwIfAborted();
    // Recheck after asynchronous credential resolution; enablement never implies egress.
    options.registry.endpoint(config.id);
    if (operation && !options.registry.authorizesScope(operation.scope)) throw new PolicyError('grant-revoked-before-dispatch');
    if (operation) {
      operation.dispatched = true;
      if (typeof packet?.id === 'string' || typeof packet?.id === 'number') operation.requestId = packet.id;
    }
    // Bound GET connection establishment without expiring an idle notification stream.
    const connection = new AbortController(); const abortConnection = () => connection.abort();
    if (request.method === 'GET') signal.addEventListener('abort', abortConnection, { once: true });
    let response: Response;
    try {
      response = await bounded(fetch(request, { headers, redirect: 'manual', signal: request.method === 'GET' ? AbortSignal.any([request.signal, connection.signal]) : signal }), signal);
    } finally { signal.removeEventListener('abort', abortConnection); }
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new PolicyError('redirect-refused'); }
    if (request.method === 'GET' && response.body) {
      const reader = response.body.getReader(); let received = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { controller.close(); return; }
            received += chunk.value.length;
            if (received > budgets.maxResponseBytes) throw new PolicyError('notification-stream-budget');
            controller.enqueue(chunk.value);
          } catch (error) { void reader.cancel().catch(() => {}); controller.error(error); }
        },
        cancel() { return reader.cancel(); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    // POST entity capture is bounded, exact, and passed unchanged to the SDK parser.
    if (request.method !== 'POST' || !response.body) return response;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await bounded(reader.read(), signal);
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > budgets.maxResponseBytes) throw new PolicyError('response-oversize');
        chunks.push(chunk.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (operation) operation.bytes = bytes;
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new PolicyError('timeout-or-cancelled')); };
    if (signal.aborted) { abort(); void promise.catch(() => {}); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function validateTool(value: unknown, validator: AjvJsonSchemaValidator): ToolDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError('malformed-tool-definition');
  const tool = value as ToolDefinition;
  if (typeof tool.name !== 'string' || !tool.name || (tool.description !== undefined && typeof tool.description !== 'string') || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new PolicyError('malformed-tool-definition');
  validator.getValidator(tool.inputSchema);
  if (tool.outputSchema !== undefined) {
    if (!tool.outputSchema || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema) || (tool.outputSchema as Record<string, unknown>).type !== 'object') throw new PolicyError('malformed-tool-definition');
    validator.getValidator(tool.outputSchema as Record<string, unknown>);
  }
  return structuredClone(tool);
}

export function createMcpAdapter(options: McpAdapterOptions): McpPort {
  const budgets: McpBudgets = { timeoutMs: 5000, maxResponseBytes: 1024 * 1024, maxPages: 64, maxTools: 1000, projectionChars: 2048, ...options.budgets };
  for (const value of Object.values(budgets)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid-adapter-budget');
  const sessions = new Map<string, Session>(); const busy = new Set<string>();
  const suspended = new Set<string>(); const waiters = new Map<string, Set<() => void>>();
  const schemaValidator = new AjvJsonSchemaValidator();
  let closed = false;
  function suspend(id: string): void {
    options.registry.suspend(id); suspended.add(id);
    for (const resolve of waiters.get(id) ?? []) resolve(); waiters.delete(id);
  }
  async function retire(id: string): Promise<void> {
    const session = sessions.get(id); sessions.delete(id);
    if (session) await bounded(session.client.close(), AbortSignal.timeout(200)).catch(() => {});
  }
  async function sessionFor(config: EndpointConfig): Promise<Session> {
    const existing = sessions.get(config.id); if (existing) return existing;
    const client = new Client({ name: 'lux-didi-optional-mcp', version: '0.1.0' }, { enforceStrictCapabilities: true });
    const session: Session = { client, config };
    client.onerror = () => { suspend(config.id); }; // No remote error/header/body is logged.
    client.onclose = () => { suspend(config.id); };
    client.setNotificationHandler('notifications/tools/list_changed', async () => { suspend(config.id); });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { fetch: guardedFetch(session, options, budgets), redirectPolicy: 'follow', reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    sessions.set(config.id, session);
    await bounded(client.connect(transport, { timeout: budgets.timeoutMs }), AbortSignal.timeout(budgets.timeoutMs));
    // Observe the SDK transport's parsed messages, then forward unchanged. A local
    // decode/validation ProtocolError is not proof of an explicit remote rejection.
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      const operation = session.operation;
      if (operation && isJSONRPCErrorResponse(message) && message.id === operation.requestId) operation.explicitErrorCode = message.error.code;
      onmessage?.(message, extra);
    };
    if (!client.getServerCapabilities()?.tools) throw new PolicyError('tools-unavailable');
    return session;
  }
  function completed(scope: ResultScope, bytes: Uint8Array, result: unknown, state: CompletedResult['state'], protocolErrorCode?: number): CompletedResult {
    const full = JSON.stringify(result); const text = full.slice(0, budgets.projectionChars);
    let payload: StoredPayload;
    try { payload = options.store.put(scope, bytes); } catch { payload = { state: 'unavailable', reason: 'store-unavailable' }; }
    return {
      state, ...(protocolErrorCode === undefined ? {} : { protocolErrorCode }), source: scope,
      coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
      freshness: { receivedAt: Date.now(), sourceVersion: 'unknown' },
      projection: { text, omitted: text.length !== full.length, originalCharacters: full.length, omittedCharacters: full.length - text.length }, payload,
    };
  }
  return {
    async discover(endpointId: string): Promise<DiscoveryResult> {
      if (closed || busy.has(endpointId)) return { state: 'unavailable', reason: closed ? 'adapter-closed' : 'endpoint-busy' };
      busy.add(endpointId);
      try {
        const config = options.registry.endpoint(endpointId); suspend(endpointId);
        const revision = options.registry.revision(endpointId);
        const session = await sessionFor(config);
        const tools: ToolDefinition[] = []; const names = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
        const signal = AbortSignal.timeout(budgets.timeoutMs);
        for (let page = 0; ; page++) {
          if (page >= budgets.maxPages) throw new PolicyError('discovery-page-budget');
          // Raw SDK request avoids v2 auto-aggregation/cache/filtering: validate every definition/page ourselves.
          const result = await bounded(session.client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, { timeout: budgets.timeoutMs, signal }), signal);
          for (const value of result.tools) {
            const tool = validateTool(value, schemaValidator);
            if (names.has(tool.name)) throw new PolicyError('duplicate-tool-name');
            names.add(tool.name); tools.push(tool);
            if (tools.length > budgets.maxTools) throw new PolicyError('discovery-tool-budget');
          }
          if (result.nextCursor === undefined) break;
          if (!result.nextCursor || cursors.has(result.nextCursor)) throw new PolicyError('repeated-or-invalid-cursor');
          cursors.add(result.nextCursor); cursor = result.nextCursor;
        }
        const schemaDigest = options.registry.observed(endpointId, tools, revision); suspended.delete(endpointId);
        return { state: 'discovered', endpointId, schemaDigest, tools: structuredClone(tools), observedAt: Date.now() };
      } catch (error) {
        // Do not leak remote errors, response bodies, credentials or endpoints in diagnostics.
        if (sessions.has(endpointId)) { suspend(endpointId); await retire(endpointId); }
        return { state: 'unavailable', reason: error instanceof PolicyError ? error.reason : 'discovery-unavailable' };
      } finally { busy.delete(endpointId); }
    },
    visibleTools(endpointId: string) { return options.registry.visibleTools(endpointId); },
    async call(request: CallRequest, signal?: AbortSignal): Promise<CallResult> {
      if (closed || busy.has(request.endpointId) || signal?.aborted) return { state: 'refused', reason: closed ? 'adapter-closed' : signal?.aborted ? 'cancelled-before-dispatch' : 'endpoint-busy' };
      let scope: ResultScope;
      try { scope = options.registry.authorize(request); } catch { return { state: 'refused', reason: 'local-read-grant-refused' }; }
      const session = sessions.get(request.endpointId);
      if (!session) return { state: 'refused', reason: 'discovery-required' };
      busy.add(request.endpointId);
      const deadline = AbortSignal.timeout(budgets.timeoutMs);
      const localSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const operation: Operation = { scope, signal: localSignal, dispatched: false }; session.operation = operation;
      try {
        // Supported SDK request API avoids callTool's automatic header-mismatch refresh/retry.
        const result = await bounded(session.client.request({ method: 'tools/call', params: { name: request.toolName, arguments: request.arguments } }, { signal: localSignal, timeout: budgets.timeoutMs }), localSignal);
        if (!options.registry.authorizesScope(scope)) throw new PolicyError('grant-revoked-after-dispatch');
        if (!operation.bytes) throw new PolicyError('original-response-unavailable');
        return completed(scope, operation.bytes, result, result.isError ? 'tool-error' : 'completed');
      } catch (error) {
        if (operation.dispatched) {
          if (error instanceof ProtocolError && operation.explicitErrorCode !== undefined && operation.bytes && options.registry.authorizesScope(scope)) return completed(scope, operation.bytes, { error: { code: operation.explicitErrorCode } }, 'protocol-error', operation.explicitErrorCode);
          // HTTP SDK cancellation aborts the request, rather than notifying. Use its
          // supported notification API with the SDK-owned id; never wait indefinitely.
          if (localSignal.aborted && operation.requestId !== undefined) await bounded(session.client.notification({ method: 'notifications/cancelled', params: { requestId: operation.requestId, reason: 'local cancellation' } }), AbortSignal.timeout(200)).catch(() => {});
          // No call retry or reconnect here. A later explicit discovery can reconnect only.
          suspend(request.endpointId); await retire(request.endpointId);
          return { state: 'unknown', reason: error instanceof PolicyError ? error.reason : 'protocol-or-transport-outcome-unknown' };
        }
        return { state: 'refused', reason: error instanceof PolicyError ? error.reason : 'pre-dispatch-refused' };
      } finally { delete session.operation; busy.delete(request.endpointId); }
    },
    readSlice(request: SliceRequest): SliceResult {
      if (closed) return { state: 'refused', reason: 'adapter-closed' };
      // Authorize even missing/expired handles, before consulting the store.
      try {
        const grant = options.registry.currentGrant(request.endpointId);
        options.registry.endpoint(request.endpointId);
        if (!grant || request.generation !== grant.generation || request.account !== grant.account || request.resource !== grant.resource) return { state: 'refused', reason: 'local-read-grant-refused' };
        return options.store.read(request, scope => options.registry.authorizesScope(scope));
      } catch { return { state: 'refused', reason: 'local-read-grant-refused' }; }
    },
    whenSuspended(endpointId: string): Promise<void> {
      if (suspended.has(endpointId)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const set = waiters.get(endpointId) ?? new Set<() => void>(); waiters.set(endpointId, set);
        const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
        const timer = setTimeout(() => { set.delete(done); if (!set.size) waiters.delete(endpointId); reject(new Error('notification-wait-timeout')); }, budgets.timeoutMs);
        set.add(done);
      });
    },
    async close(): Promise<void> { closed = true; await Promise.all([...sessions.keys()].map(async id => { suspend(id); await retire(id); })); },
  };
}
