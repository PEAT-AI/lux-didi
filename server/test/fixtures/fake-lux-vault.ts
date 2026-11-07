import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

/** The fake lux-knowledge MCP child's own answers: the vault's real reply shapes, plus a dropped wire. */
export type FakeLuxMode = 'inserted' | 'duplicate' | 'fail' | 'drop';
export interface FakeLux { url: string; calls: { name?: unknown; arguments?: unknown }[] }

/** One MCP-over-HTTP server on loopback: initialize, the initialized notice, then the tools/call it records. */
/** Real lux ids are integers, and the client refuses any other receipt shape. */
const writeTool = { name: 'create_insight', description: 'Create an insight', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string' }, insight_title: { type: 'string' }, insight_type: { type: 'string' },
    project: { type: 'string' }, source_kind: { type: 'string' }, source_ref: { type: 'object' }, idempotency_key: { type: 'string' }, quote: { type: 'string' },
    follow_up_state: { type: 'string' }, insight_id: { type: 'integer' } } } };
const readTool = { name: 'search_insights', description: 'Search insights', annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } } } };
export async function fakeLux(t: TestContext, mode: FakeLuxMode, insightId = 7): Promise<FakeLux> {
  const calls: FakeLux['calls'] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: unknown; method?: string; params?: { name?: unknown; arguments?: unknown } };
      const reply = (payload: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload)); };
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 'fake-session');
        reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-lux', version: '1' } } });
        return;
      }
      if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); return; }
      if (message.method === 'tools/list') {
        // The write client re-reads the daemon's own discovery: the write is admitted by its annotations.
        reply({ jsonrpc: '2.0', id: message.id, result: { tools: [writeTool, readTool] } });
        return;
      }
      if (message.method === 'tools/call') {
        calls.push(message.params ?? {});
        if (mode === 'drop') { request.socket.destroy(); return; }
        if (mode === 'fail') { reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'vault refused' } }); return; }
        const payload = mode === 'duplicate' ? { disposition: 'duplicate_of', insight_id: insightId } : { disposition: 'created', insight_id: insightId };
        reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
        return;
      }
      response.statusCode = 404; response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls };
}
