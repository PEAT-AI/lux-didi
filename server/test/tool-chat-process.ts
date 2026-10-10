import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { chatMigrations, type RunSnapshot } from '../chat/index.js';
import { toolsMigrations } from '../tools/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { ToolDefinition as McpTool } from '../adapters/mcp/port.js';
import { composeChat, type ToolChatAssembly } from '../host/connected.js';
import { requestCredentialsFor, credentialReceiptFor } from '../config/index.js';
import { listenService } from '../http/server.js';
import type { DomainContext } from '../contracts/domain.js';
import type { DataClass, Transport } from '../adapters/model/types.js';

// These are proposed narrow Host integration pins, not an implementation or a
// replacement tools authorization service. Missing exports are baseline RED.
export const syntheticKey = 'tool-chat-synthetic-key-one';
export const rotatedKey = 'tool-chat-synthetic-key-two';
export const answer = 'Synthetic insight 731 supports one small next step.';
export const untrustedURL = 'https://model-link.invalid/not-a-source';
export const sourceId = 'lux-knowledge:731';
export const scope = {
  provider: 'gemini' as const, modelId: 'gemini-tool-chat-synthetic',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-tool-chat-synthetic:streamGenerateContent?alt=sse',
  apiVersion: 'v1beta', keyReference: 'gemini-primary', allowedClasses: ['ordinary'] as DataClass[]
};
export function barrier() {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, pause: async () => { enter(); await released; } };
}
export interface FixtureOptions {
  legacy?: boolean; deadlineMs?: number;
  beforeResolve?: () => Promise<void>; afterResolve?: () => Promise<void>;
  beforeContinuation?: () => Promise<void>; afterEachResolve?: (number: number) => Promise<void>;
  afterText?: () => Promise<void>; unknownEffect?: boolean; multiStep?: boolean;
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export async function fixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-tool-chat-'));
  const configDir = join(dir, 'provider-config'); mkdirSync(configDir, { mode: 0o700 });
  const recordPath = join(configDir, 'gemini-primary.json');
  const profile = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: scope.modelId,
    keyReference: scope.keyReference, dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'balanced' } };
  const record = { schemaVersion: 2, keyReference: scope.keyReference, key: syntheticKey,
    configuredAccount: 'operator-asserted-synthetic-account', routeScope: scope, bindingGeneration: 'synthetic-generation-1' };
  const writeRecord = (patch: Partial<typeof record> = {}) => writeFileSync(recordPath,
    JSON.stringify({ ...record, ...patch }), { mode: 0o600 });
  writeFileSync(join(configDir, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  if (options.legacy) writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, keyReference: scope.keyReference, key: syntheticKey }), { mode: 0o600 });
  else writeRecord();
  const cleanups: (() => void | Promise<void>)[] = []; let closed = false;
  const close = async () => {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
    rmSync(dir, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Synthetic fixture cleanup failed');
  };
  try {
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...toolsMigrations]);
  cleanups.push(() => store.close());
  const context: DomainContext = { assistantId: store.assistantId, clientId: 'tool-chat-synthetic-actor',
    authorityEpoch: store.authorityEpoch, now: new Date(0).toISOString() };
  const sdk = new Server({ name: 'synthetic-tool-chat', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  cleanups.push(() => sdk.close());
  const sdkTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  cleanups.push(() => sdkTransport.close());
  const definitions: McpTool[] = [
    { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false } },
    { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } }, required: ['ids'], additionalProperties: false } }
  ];
  let liveDefinitions = structuredClone(definitions);
  const sdkCalls: unknown[] = [];
  sdk.setRequestHandler('tools/list', () => ({ tools: liveDefinitions }) as never);
  sdk.setRequestHandler('tools/call', request => {
    sdkCalls.push(structuredClone(request.params));
    const ids = (request.params.arguments as { ids?: number[] }).ids ?? [731];
    return { content: [{ type: 'text', text: `# Insight ${ids[0]}\nSynthetic nonempty evidence for one small next step.` }] } as never;
  });
  await sdk.connect(sdkTransport);
  const sdkServer = createServer((req, res) => { void (async () => {
    const bytes = await body(req);
    const response = await sdkTransport.handleRequest(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? 'POST', headers: req.headers as Record<string, string>,
      ...(bytes.length ? { body: new Uint8Array(bytes) } : {})
    }));
    if (options.unknownEffect && bytes.length && (JSON.parse(bytes.toString()) as { method?: string }).method === 'tools/call') {
      // SDK handler executed, but no response reaches its caller: unknown effect.
      res.destroy(); return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })().catch(() => { res.writeHead(500); res.end('synthetic SDK failure'); }); });
  cleanups.push(() => sdkServer.listening ? new Promise<void>((resolve, reject) => sdkServer.close(error => error ? reject(error) : resolve())) : undefined);
  sdkServer.listen(0, '127.0.0.1'); await once(sdkServer, 'listening');
  const address = sdkServer.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = { id: 'synthetic-lux', url: `http://127.0.0.1:${address.port}/mcp`, account: 'synthetic-mcp-account', resource: 'synthetic-corpus', credentialRef: 'synthetic-mcp-reference' };
  const registry = new McpRegistry(); registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 16000, maxSliceBytes: 2048 }),
    resolveCredential: async () => 'synthetic-mcp-token', budgets: { maxResponseBytes: 16000, projectionChars: 2000, timeoutMs: 1000 } });
  cleanups.push(() => port.close());
  assert.equal((await port.discover(endpoint.id)).state, 'discovered');
  // Policy identity comes from the same exact route canonicalization used by
  // Chat. The test reads the consent row after enrollment, never reconstructs
  // authorization from model text or a key reference.
  let policy: ConnectionPolicy = { schemaVersion: 1, ownerId: store.assistantId, connectionId: 'synthetic-lux', generation: 1, enabled: true,
    endpoint, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(definitions),
    sourcePolicy: { id: 'synthetic-source-policy', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'pending-enrollment', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 300, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 8000, maxResultBytes: 16000 } };
  const modelCalls: { body: string; key: string | null }[] = [];
  let requestCount = 0; let clock = Date.now();
  const lowerTransport: Transport = async (_url, init) => {
    const key = new Headers(init.headers).get('x-goog-api-key');
    const requestBody = String(init.body); modelCalls.push({ body: requestBody, key });
    const continuation = requestBody.includes('functionResponse');
    if (!requestBody.includes('functionDeclarations') || (continuation && (!options.multiStep || (requestBody.match(/functionResponse/g)?.length ?? 0) >= 2))) {
      if (continuation) assert.match(requestBody, /Synthetic nonempty evidence/);
      if (options.afterText) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({ start: async controller => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Provisional synthetic answer.' }] } }] })}\n\n`));
          await options.afterText!();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: ' Final synthetic answer.' }] }, finishReason: 'STOP' }] })}\n\n`));
          controller.close();
        } });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `${answer} ${untrustedURL}` }] }, finishReason: 'STOP' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    const insightId = continuation || requestBody.includes('Synthetic second evidence') ? 732 : 731;
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_insight', args: { ids: [insightId] }, id: `synthetic-call-${insightId}` } }] }, finishReason: 'STOP' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const assembly: ToolChatAssembly = { registry, port, connections: [] };
  const composed = composeChat(store, domain, configDir, {
    transport: lowerTransport, deadlineMs: options.deadlineMs ?? 4000,
    ...(!options.legacy ? { requestCredentials: () => {
      const credentials = requestCredentialsFor(configDir, scope);
      return { resolvedReceipt: () => credentials.resolvedReceipt(), resolve: async (reference: string) => {
        const number = ++requestCount;
        if (number === 1) await options.beforeResolve?.();
        const key = await credentials.resolve(reference);
        assert.ok(credentials.resolvedReceipt(), 'Protected resolver parsed key and receipt before any post-resolve barrier');
        if (number === 1) await options.afterResolve?.();
        await options.afterEachResolve?.(number);
        if (number === 2) await options.beforeContinuation?.();
        return key;
      } };
    } } : {})
  }, () => clock, assembly);
  const { chat, tools } = composed;
  cleanups.push(() => chat.shutdown());
  const enroll = (title = 'Synthetic tool chat') => {
    const conversation = chat.enroll({ title, timeZone: 'UTC', idempotencyKey: randomUUID() }, context);
    const consent = store.transaction(tx => tx.get('SELECT route_identity FROM chat_consents WHERE session_id = ?', [conversation.sessionId]));
    assert.equal(typeof consent?.route_identity, 'string');
    policy = { ...policy, route: { ...policy.route, identity: String(consent!.route_identity) } };
    tools.applyConnection(policy); tools.projectConnection(policy.connectionId);
    return conversation.sessionId;
  };
  const accept = (sessionId: string, key = randomUUID(), connectionIds = ['synthetic-lux'], selectedMemoryEntryIds: string[] = [], text = 'Use synthetic insight 731.') =>
    chat.accept({ sessionId, text, idempotencyKey: key, selectedConnectionIds: connectionIds, selectedMemoryEntryIds }, context);
  const terminal = async (run: RunSnapshot) => {
    for await (const event of chat.subscribe(run.runId, context)) {
      if (event.type === 'snapshot' && event.run.state === 'terminal') return chat.get(run.runId, context);
    }
    const snapshot = chat.get(run.runId, context);
    assert.equal(snapshot.state, 'terminal', 'Subscription must not silently end before a terminal result');
    return snapshot;
  };
  const counts = () => store.transaction(tx => Object.fromEntries(tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .map(row => [String(row.name), Number(tx.get(`SELECT count(*) AS n FROM "${String(row.name).replaceAll('"', '""')}"`)!.n)])));
  const updatePolicy = (patch: Partial<ConnectionPolicy>) => { policy = { ...policy, ...patch }; tools.applyConnection(policy); };
  return { dir, configDir, recordPath, writeRecord, store, context, chat, tools, registry, port, enroll, accept, terminal, counts, updatePolicy,
    modelCalls, sdkCalls, close, profile, scope, policy: () => policy, setLiveDefinitions: () => { liveDefinitions = []; },
    receipt: () => credentialReceiptFor(configDir, scope), advance: (ms: number) => { clock += ms; } };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Synthetic setup and cleanup failed'); }
    throw error;
  }
}

// A separate process exercises real authenticated HTTP and the built browser.
// IPC is test-local parent/child communication, not the orchestration bus.
async function browserProcess() {
  const f = await fixture();
  const sessionId = f.enroll();
  const service = await listenService({ store: f.store, domain: createDomainPort({ outbox: Outbox }), chat: f.chat,
    modelStatus: { status: 'configured', provider: 'gemini', model: scope.modelId }, port: 0,
    webRoot: resolve(process.env.DIDI_TOOL_CHAT_WEB_ROOT!) });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await service.close(); await f.close(); process.disconnect?.();
  };
  process.on('message', message => { void (async () => {
    if (message === 'stop') { await stop(); return; }
    if (message === 'proof') process.send?.({ phase: 'proof', modelCalls: f.modelCalls.map(c => ({ body: c.body })), sdkCalls: f.sdkCalls,
      counts: f.counts() });
  })().catch(() => { process.exitCode = 1; void stop(); }); });
  process.on('disconnect', () => { void stop(); });
  process.send?.({ phase: 'ready', origin: service.origin, sessionId, credential: f.store.adminCredential });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2] === 'browser') {
  void browserProcess().catch(() => { console.error('Synthetic tool-chat process setup failed'); process.exitCode = 1; });
}
