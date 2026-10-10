#!/usr/bin/env node
// Synthetic stdio MCP child for check-mcp-stdio.sh.
// No real accounts, network access, credentials or application files are touched.
// argv[2] = mode (ok | hang-call | malformed | silent | crash)
// argv[3] = optional pid file; argv[4] = tools/call payload (default 'stdio-pong').
import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'ok';
const pidFile = process.argv[3];
const payload = process.argv[4] ?? 'stdio-pong';
if (pidFile) writeFileSync(pidFile, String(process.pid));

if (mode === 'crash') process.exit(7);
if (mode === 'silent' || mode === 'malformed') {
  if (mode === 'malformed') process.stdout.write('not-json-handshake\n');
  // Stay alive but never complete a handshake.
  setInterval(() => {}, 1000);
} else {
  const server = new Server({ name: 'stdio-synthetic-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'echo', description: 'Synthetic stdio echo', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler('tools/call', () => (mode === 'hang-call' ? new Promise(() => {}) : { content: [{ type: 'text', text: payload }] }));
  await server.connect(new StdioServerTransport());
}
