import { Client, ProtocolError, SdkError, SdkErrorCode, StreamableHTTPClientTransport, isJSONRPCErrorResponse } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { McpRegistry } from './registry.js';
import { isStdioEndpoint } from './port.js';
import type { CallRequest, CallResult, CompletedResult, DiscoveryResult, EndpointConfig, McpBudgets, McpPort, ResultScope, ResultStorePort, SliceRequest, SliceResult, StoredPayload, ToolDefinition } from './port.js';

export interface McpAdapterOptions {
  registry: McpRegistry;
  store: ResultStorePort;
  resolveCredential?: (reference: string) => Promise<string>;
  budgets?: Partial<McpBudgets>;
  callTimeoutMsByEndpoint?: ReadonlyMap<string, number>;
  assertCredentialCurrent?: (reference: string) => void;
}
class PolicyError extends Error { constructor(readonly reason: string) { super(reason); } }
interface ChildExit { readonly exitCode: number | null; readonly signalCode: string | null; readonly stdout?: { once(event: string, listener: () => void): unknown } | null }
/** The SDK discards the child's exit code; hold the ChildProcess it spawned for classification only. */
function childProcess(transport: unknown): ChildExit | undefined {
  const candidate = (transport as unknown as { _process?: unknown })._process;
  return candidate !== null && typeof candidate === 'object' ? candidate as ChildExit : undefined;
}
function decodeSseResponse(bytes: Uint8Array, requestId: unknown): Uint8Array {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    for (const frame of text.split(/\r\n\r\n|\n\n|\r\r/)) {
      const data: string[] = [];
      for (const line of frame.split(/\r\n|\n|\r/)) {
        if (line === 'data') data.push('');
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      const packet: unknown = JSON.parse(data.join('\n'));
      if (packet !== null && typeof packet === 'object' && !Array.isArray(packet)) {
        const record = packet as Record<string, unknown>;
        if (record['jsonrpc'] === '2.0' && record['id'] === requestId && ('result' in record || 'error' in record)) {
          return new TextEncoder().encode(JSON.stringify(packet));
        }
      }
    }
  } catch { throw new PolicyError('sdk_protocol_rejected'); }
  throw new PolicyError('sdk_protocol_rejected');
}
interface Operation { scope: ResultScope; signal: AbortSignal; timeoutMs: number; dispatched: boolean; bytes?: Uint8Array; requestId?: string | number; explicitErrorCode?: number; explicitError?: unknown; receivedResult?: boolean }
interface Session { client: Client; config: EndpointConfig; operation?: Operation; child?: ChildExit; pipeClosed?: boolean; dead?: boolean }
/** Two respawns per connector per session; the third child death suspends with a logged stage. */
const MAX_RESPAWNS = 2;
/**
 * One closed, privacy-safe stage for a dispatched call failure; never an SDK or remote message.
 * External cancellation and the local deadline are distinguished before the SDK's own errors.
 */
function failureStage(error: unknown, operation: Operation, session: Session, cancelled: boolean, timedOut: boolean): string {
  const exited = session.child !== undefined && (session.child.exitCode !== null || session.child.signalCode !== null);
  if (error instanceof PolicyError) {
    if (error.reason !== 'timeout-or-cancelled') return error.reason;
    if (cancelled) return 'cancelled';
    if (exited) return 'child_exited';
    if (session.pipeClosed) return 'pipe_closed';
    return 'timeout';
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.ConnectionClosed) return exited ? 'child_exited' : 'pipe_closed';
    if (error.code === SdkErrorCode.RequestTimeout) return cancelled ? 'cancelled' : 'timeout';
    if (error.code === SdkErrorCode.InvalidResult || error.code === SdkErrorCode.UnsupportedResultType) return 'invalid_result';
  }
  if (error instanceof ProtocolError) return 'sdk_protocol_rejected';
  if (cancelled) return 'cancelled';
  if (timedOut) return 'timeout';
  if (session.pipeClosed) return 'pipe_closed';
  if (operation.receivedResult) return 'invalid_result';
  return 'sdk_protocol_rejected';
}
const allowedHeaders = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'mcp-method', 'mcp-name']);

/** All HTTP egress passes this supported SDK fetch seam; native Host, no global patch. */
function guardedFetch(session: Session, options: McpAdapterOptions, budgets: McpBudgets): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const config = options.registry.endpoint(session.config.id);
    if (isStdioEndpoint(config) || isStdioEndpoint(session.config)) throw new PolicyError('destination-refused');
    if (request.url !== config.url || config.url !== session.config.url) throw new PolicyError('destination-refused');
    for (const name of request.headers.keys()) if (!allowedHeaders.has(name)) throw new PolicyError('header-refused');
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new PolicyError('method-refused');
    const packet = request.method === 'POST' ? await request.clone().json() as { method?: string; id?: string | number } : undefined;
    const isCall = packet?.method === 'tools/call';
    const operation = isCall ? session.operation : undefined;
    if (isCall && (!operation || operation.dispatched)) throw new PolicyError('call-replay-refused');
    if (operation && !options.registry.authorizesScope(operation.scope)) throw new PolicyError('grant-revoked-before-dispatch');
    // Cancellation notification gets its own short deadline, not the already aborted call signal.
    const timeout = AbortSignal.timeout(packet?.method === 'notifications/cancelled' ? Math.min(200, budgets.timeoutMs) : operation?.timeoutMs ?? budgets.timeoutMs);
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
    if (config.credentialRef) options.assertCredentialCurrent?.(config.credentialRef);
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
    // Bound the entity before decoding SSE; JSON entities retain their exact bytes.
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
    const isSse = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
    const decoded = isSse ? decodeSseResponse(bytes, packet?.id) : bytes;
    if (operation) operation.bytes = bytes;
    const responseHeaders = new Headers(response.headers);
    if (isSse) { responseHeaders.set('content-type', 'application/json'); responseHeaders.delete('content-length'); }
    return new Response(new Uint8Array(decoded), { status: response.status, statusText: response.statusText, headers: responseHeaders });
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
  const callTimeouts = new Map(options.callTimeoutMsByEndpoint);
  for (const timeout of callTimeouts.values()) if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('invalid-adapter-budget');
  const sessions = new Map<string, Session>(); const busy = new Set<string>();
  const deaths = new Map<string, number>();
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
    const existing = sessions.get(config.id);
    if (existing && !existing.dead) return existing;
    if (existing) await retire(config.id);
    const client = new Client({ name: 'lux-didi-optional-mcp', version: '0.1.0' }, { enforceStrictCapabilities: true });
    const session: Session = { client, config };
    // A dropped transport marks the session dead for respawn. A soft policy breach (the call's own
    // timeout or an oversize result) is not fatal; any other transport policy breach suspends.
    client.onerror = (error: unknown) => {
      const soft = error instanceof PolicyError && (error.reason === 'timeout-or-cancelled' || error.reason === 'response-oversize');
      if (!soft && error instanceof PolicyError) suspend(config.id); else session.dead = true;
    };
    client.onclose = () => { session.dead = true; };
    client.setNotificationHandler('notifications/tools/list_changed', async () => { suspend(config.id); });
    const transport = isStdioEndpoint(config)
      ? new StdioClientTransport({ command: config.command, args: [...config.args], ...(config.env ? { env: { ...config.env } } : {}), stderr: 'pipe' })
      : new StreamableHTTPClientTransport(new URL(config.url), { fetch: guardedFetch(session, options, budgets), redirectPolicy: 'follow', reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    sessions.set(config.id, session);
    await bounded(client.connect(transport, { timeout: budgets.timeoutMs }), AbortSignal.timeout(budgets.timeoutMs));
    if (isStdioEndpoint(config)) { const child = childProcess(transport); if (child) { session.child = child; child.stdout?.once('end', () => { session.pipeClosed = true; }); } }
    // Observe the SDK transport's parsed messages, then forward unchanged. A local
    // decode/validation ProtocolError is not proof of an explicit remote rejection.
    const onmessage = transport.onmessage;
    transport.onmessage = message => {
      const operation = session.operation;
      if (operation && isJSONRPCErrorResponse(message) && message.id === operation.requestId) { operation.explicitErrorCode = message.error.code; operation.explicitError = structuredClone(message.error); }
      if (operation && 'id' in message && message.id === operation.requestId && 'result' in message) operation.receivedResult = true;
      onmessage?.(message);
    };
    if (!client.getServerCapabilities()?.tools) throw new PolicyError('tools-unavailable');
    return session;
  }
  function completed(scope: ResultScope, bytes: Uint8Array, result: unknown, state: CompletedResult['state'], protocolErrorCode?: number, decodedResult: unknown = result): CompletedResult {
    const full = JSON.stringify(result); const text = full.slice(0, budgets.projectionChars);
    let payload: StoredPayload;
    try { payload = options.store.put(scope, bytes); } catch { payload = { state: 'unavailable', reason: 'store-unavailable' }; }
    return {
      state, decodedResult: structuredClone(decodedResult), ...(protocolErrorCode === undefined ? {} : { protocolErrorCode }), source: scope,
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
        const className = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown';
        const localCodes = ['discovery-invalidated', 'source-egress-not-approved', 'invalid-endpoint-config', 'unknown-endpoint'];
        const code = error instanceof PolicyError ? error.reason
          : error instanceof Error && error.constructor === Error && localCodes.includes(error.message) ? error.message : 'unknown';
        return { state: 'unavailable', reason: error instanceof PolicyError ? error.reason : 'discovery-unavailable', exception: { class: className, code } };
      } finally { busy.delete(endpointId); }
    },
    visibleTools(endpointId: string) { return options.registry.visibleTools(endpointId); },
    async call(request: CallRequest, signal?: AbortSignal): Promise<CallResult> {
      if (closed || busy.has(request.endpointId) || signal?.aborted) return { state: 'refused', reason: closed ? 'adapter-closed' : signal?.aborted ? 'cancelled-before-dispatch' : 'endpoint-busy' };
      let scope: ResultScope;
      try { scope = options.registry.authorize(request); } catch { return { state: 'refused', reason: 'local-read-grant-refused' }; }
      const config = options.registry.endpoint(request.endpointId);
      busy.add(request.endpointId);
      let session = sessions.get(request.endpointId);
      if (session?.dead) { await retire(request.endpointId); session = undefined; }
      if (!session) {
        try { session = await sessionFor(config); }
        catch { busy.delete(request.endpointId); return { state: 'refused', reason: 'discovery-required' }; }
      }
      const timeoutMs = callTimeouts.get(request.endpointId) ?? budgets.timeoutMs;
      const deadline = AbortSignal.timeout(timeoutMs);
      const localSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const operation: Operation = { scope, signal: localSignal, timeoutMs, dispatched: false }; session.operation = operation;
      try {
        // Supported SDK request API avoids callTool's automatic header-mismatch refresh/retry.
        if (isStdioEndpoint(session.config)) operation.dispatched = true;
        const result = await bounded(session.client.request({ method: 'tools/call', params: { name: request.toolName, arguments: request.arguments } }, { signal: localSignal, timeout: timeoutMs }), localSignal);
        if (!options.registry.authorizesScope(scope)) throw new PolicyError('grant-revoked-after-dispatch');
        if (!operation.bytes) {
          // A stdio child has no HTTP response entity; the parsed JSON-RPC result is the entity.
          if (!isStdioEndpoint(session.config)) throw new PolicyError('original-response-unavailable');
          operation.bytes = new TextEncoder().encode(JSON.stringify(result));
        }
        return completed(scope, operation.bytes, result, result.isError ? 'tool-error' : 'completed');
      } catch (error) {
        if (operation.dispatched) {
          if (error instanceof ProtocolError && operation.explicitErrorCode !== undefined && operation.bytes && options.registry.authorizesScope(scope)) return completed(scope, operation.bytes, { error: { code: operation.explicitErrorCode } }, 'protocol-error', operation.explicitErrorCode, operation.explicitError);
          // Classify before retiring the child, so a local shutdown never rewrites the cause.
          const stage = failureStage(error, operation, session, signal?.aborted === true, deadline.aborted);
          // HTTP SDK cancellation aborts the request, rather than notifying. Use its
          // supported notification API with the SDK-owned id; never wait indefinitely.
          if (localSignal.aborted && operation.requestId !== undefined) await bounded(session.client.notification({ method: 'notifications/cancelled', params: { requestId: operation.requestId, reason: 'local cancellation' } }), AbortSignal.timeout(200)).catch(() => {});
          // A dead transport is retired; the stdio child respawns on the next call, up to two deaths.
          // A soft failure (timeout, cancellation, invalid_result) leaves the connector usable. Never retry this call.
          if (stage === 'sdk_protocol_rejected') { suspend(request.endpointId); await retire(request.endpointId); }
          else if (stage === 'child_exited' || stage === 'pipe_closed') {
            const count = (deaths.get(request.endpointId) ?? 0) + 1; deaths.set(request.endpointId, count);
            if (count > MAX_RESPAWNS) suspend(request.endpointId);
            await retire(request.endpointId);
          }
          return { state: 'unknown', reason: stage };
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
