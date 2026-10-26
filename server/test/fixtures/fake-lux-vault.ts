import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

/** The fake lux-knowledge MCP child's own answers: the vault's real reply shapes, plus a dropped wire. */
export type FakeLuxMode = 'inserted' | 'duplicate' | 'fail' | 'drop';
export interface FakeLux { url: string; calls: { name?: unknown; arguments?: unknown }[] }

/** One MCP-over-HTTP server on loopback: initialize, the initialized notice, then the tools/call it records. */
export async function fakeLux(t: TestContext, mode: FakeLuxMode, insightId = 'insight-7'): Promise<FakeLux> {
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
      if (message.method === 'tools/call') {
        calls.push(message.params ?? {});
        if (mode === 'drop') { request.socket.destroy(); return; }
        if (mode === 'fail') { reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'vault refused' } }); return; }
        const payload = mode === 'duplicate' ? { action: 'duplicate' } : { action: 'inserted', insight_id: insightId };
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
