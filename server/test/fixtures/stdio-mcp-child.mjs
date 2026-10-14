#!/usr/bin/env node
// Synthetic stdio MCP child for check-mcp-stdio.sh.
// No real accounts, network access, credentials or application files are touched.
// argv[2] = mode (ok | hang-call | exit-on-call | signal-on-call | close-pipe-on-call | invalid-result | malformed | silent | crash)
// argv[3] = optional pid file; argv[4] = tools/call payload (default 'stdio-pong').
// When argv[3] is given the child also dumps its resolved environment to "<pid>.env".
import { closeSync, existsSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'ok';
const pidFile = process.argv[3];
const payload = process.argv[4] ?? 'stdio-pong';
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
  writeFileSync(`${pidFile}.env`, JSON.stringify(process.env));
}

if (mode === 'crash') process.exit(7);
if (mode === 'invalid-result') {
  // Raw JSON-RPC child: the SDK Server refuses to emit a malformed result, so a hand-driven
  // server is required to exercise the client's invalid-result rejection. Synthetic only.
  let buf = '';
  process.stdin.on('data', chunk => {
    buf += chunk.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-synthetic-raw-fixture', version: '1' } } }) + '\n');
      else if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Synthetic raw stdio echo', inputSchema: { type: 'object' } }] } }) + '\n');
      else if (msg.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'not-a-content-type', text: payload }] } }) + '\n');
    }
  });
  await new Promise(() => {});
} else if (mode === 'silent' || mode === 'malformed') {
  if (mode === 'malformed') process.stdout.write('not-json-handshake\n');
  // Stay alive but never complete a handshake.
  setInterval(() => {}, 1000);
} else {
  const server = new Server({ name: 'stdio-synthetic-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'echo', description: 'Synthetic stdio echo', inputSchema: { type: 'object' } }] }));
  let calls = 0;
  server.setRequestHandler('tools/call', () => {
    if (mode === 'hang-call') return new Promise(() => {});
    // Fail the first dispatched call only, then answer: proves a soft failure leaves the connector usable.
    if (mode === 'hang-first-call') { calls += 1; return calls === 1 ? new Promise(() => {}) : { content: [{ type: 'text', text: payload }] }; }
    if (mode === 'slow-call') return new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: payload }] }), 5400));
    if (mode === 'exit-on-call') process.exit(7);
    // Crash only the first child's first call; a respawned child sees the marker and serves.
    if (mode === 'exit-once') { if (!existsSync(`${pidFile}.exited`)) { writeFileSync(`${pidFile}.exited`, '1'); process.exit(7); } return { content: [{ type: 'text', text: payload }] }; }
    if (mode === 'signal-on-call') process.kill(process.pid, 'SIGKILL');
    // Close stdout but stay alive: a pipe closure, not a child exit.
    if (mode === 'close-pipe-on-call') { setInterval(() => {}, 1000); closeSync(1); return new Promise(() => {}); }
    return { content: [{ type: 'text', text: payload }] };
  });
  await server.connect(new StdioServerTransport());
}
