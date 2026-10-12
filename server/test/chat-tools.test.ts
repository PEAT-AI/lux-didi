import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { openFixture, result } from './chat-process.js';
import { ChatService, type RunSnapshot } from '../chat/index.js';
import { composeMcpRuntime } from '../host/mcp.js';
import type { LiveAuthority } from '../tools/types.js';
import type { ModelPort, ModelRequest } from '../adapters/model/types.js';

const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } }, required: ['query', 'limit', 'include_sensitive'], additionalProperties: false };
const tools = [{ name: 'search_knowledge', inputSchema: schema }];
const ACCEPTED = 'ACCEPTED mail-style synthetic evidence';
const REJECTED = 'REJECTED connector diagnostic never disclosed';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-tools-'));
  const requests: ModelRequest[] = [];
  let ask = true;
  const model: ModelPort = { generate: async request => {
    requests.push(structuredClone(request));
    if (ask && request.declarations?.some(d => d.name === 'search_knowledge') && !request.contents.some(c => c.parts.some(p => p.functionResponse))) {
      return { ...result(request, 'complete', ''), providerContent: { role: 'model', parts: [{ functionCall: { name: 'search_knowledge', args: { query: 'which emails arrived', limit: 1 }, id: randomUUID() } }] } };
    }
    return result(request, 'complete', 'Answer from evidence');
  } };
  const f = openFixture(dir, model, { route: { provider: 'gemini', model: 'fixture', available: true, allows: () => true, endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'fixture', allowedClasses: ['ordinary', 'private'] } });
  t.after(() => { f.chat.shutdown(); f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const endpoint = { id: 'fixture-endpoint', url: 'https://fixture.invalid/mcp', account: 'fixture-account', resource: 'fixture-resource' };
  const sdk = new Server({ name: 'chat-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  let executions = 0;
  sdk.setRequestHandler('tools/list', () => ({ tools }) as never);
  sdk.setRequestHandler('tools/call', () => { executions++; return { content: [{ type: 'text', text: ACCEPTED }], diagnostic: REJECTED } as never; });
  await sdk.connect(transport);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); assert.equal(req.url, endpoint.url);
    if (req.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(req);
  });
  let authority: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: [{ ...endpoint, connector: 'lux-knowledge', transport: 'streamable-http', credentialRef: null, enabled: true, allowEgress: true }] }), { mode: 0o600 });
  // Use actual host policy construction, including its current denial, never a matching fixture route.
  const mcp = await composeMcpRuntime({ store: f.store, ownerId: f.store.assistantId, configDir: dir, lookupAuthority: async (id, signal) => authority?.(id, signal) ?? null });
  const { owner, registry } = mcp;
  assert.deepEqual(mcp.connectionIds(), [endpoint.id]);
  t.after(async () => { await mcp.close(); await transport.close(); await sdk.close(); });
  const composition = { owner, connectionIds: () => mcp.connectionIds(), registerAuthoritySource: (source: typeof authority) => { authority = source; } };
  const chat = new ChatService(Object.assign({}, f.config, { tools: composition }));
  chat.recover(f.recoveryContext);
  // This mirrors the host's trusted authority-source registration seam.
  composition.registerAuthoritySource(async (id, signal) => signal.aborted ? null : (chat as ChatService & { lookupAuthority?(id: string): LiveAuthority | null }).lookupAuthority?.(id) ?? null);
  t.after(() => chat.shutdown());
  const session = () => chat.enroll({ title: 'Tools', timeZone: 'UTC', idempotencyKey: randomUUID() }, f.context).sessionId;
  const turn = async (sessionId: string) => {
    const accepted = chat.accept({ sessionId, text: 'Which emails arrived?', idempotencyKey: randomUUID() }, f.context);
    for await (const event of chat.subscribe(accepted.runId, f.context)) if (event.type === 'snapshot' && event.run.state === 'terminal') return event.run;
    throw Error('no terminal snapshot');
  };
  return { ...f, chat, owner, registry, requests, endpoint, mcp, session, turn, executions: () => executions, noCalls: () => { ask = false; } };
}

test('real chat declares approved reads, journals execution, and discloses only gated evidence', async t => {
  const f = await fixture(t); const run = await f.turn(f.session());
  assert.ok(f.requests[0]?.declarations?.some(d => d.name === 'search_knowledge'), 'approved read declaration must reach text chat');
  assert.equal(f.executions(), 1);
  const rows = f.store.transaction(tx => tx.all('SELECT state,intent_json,result_json FROM tool_calls WHERE run_id=?', [run.runId]));
  assert.equal(rows.length, 1); assert.equal(rows[0]?.state, 'completed');
  assert.ok(f.requests.length >= 2);
  assert.match(JSON.stringify(f.requests[1]), /ACCEPTED/); assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
  const evidence = (run as RunSnapshot & { toolEvidence?: unknown }).toolEvidence;
  assert.match(JSON.stringify(evidence) ?? '', /ACCEPTED/); assert.doesNotMatch(JSON.stringify(run), /REJECTED/);
  assert.match(JSON.stringify(f.chat.get(run.runId, f.context)), /ACCEPTED/, 'evidence survives snapshot retrieval');
});

test('frozen declarations cannot authorize a revoked registry grant', async t => {
  const f = await fixture(t); const session = f.session(); await f.turn(session);
  const count = f.executions(); f.registry.revoke(f.endpoint.id);
  await f.turn(session);
  assert.equal(f.executions(), count, 'revoked read never reaches the connector');
  assert.doesNotMatch(JSON.stringify(f.requests), /REJECTED/);
});

test('revoked provider consent prevents any model request', async t => {
  const f = await fixture(t); const session = f.session(); f.chat.revoke(session, f.context);
  assert.throws(() => f.chat.accept({ sessionId: session, text: 'mail', idempotencyKey: randomUUID() }, f.context));
  assert.equal(f.requests.length, 0);
});
