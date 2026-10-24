#!/usr/bin/env node
// Synthetic stdio MCP child for check-company-connectors.sh (Mattermost connector).
// No real accounts, network access, credentials, sessions or application files are touched.
// argv[2] = mode (ok | auth-needed | empty). The child never reads ~/.local/share/mattermost-mcp.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'ok';
const logPath = process.env.DIDI_FAKE_MATTERMOST_LOG;
const READS = ['mattermost_whoami', 'mattermost_get_channel_history', 'mattermost_get_thread', 'mattermost_search', 'mattermost_list_channels'];
const WRITES = ['mattermost_post_message', 'mattermost_react', 'mattermost_edit_post'];

// Per-tool input schemas mirroring the real mattermost-mcp child (src/mcp/tools.ts):
// mattermost_get_thread takes only post_id and format and closes the object, so an undeclared
// limit is rejected; mattermost_get_channel_history and mattermost_search do declare limit.
const READ_SCHEMAS = {
  mattermost_whoami: { type: 'object' },
  mattermost_get_channel_history: { type: 'object', additionalProperties: false, required: ['channel'], properties: { channel: { type: 'string' }, limit: { type: 'integer' }, format: { type: 'string', enum: ['concise', 'detailed'] } } },
  mattermost_get_thread: { type: 'object', additionalProperties: false, required: ['post_id'], properties: { post_id: { type: 'string' }, format: { type: 'string', enum: ['concise', 'detailed'] } } },
  mattermost_search: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, from_date: { type: 'string' }, to_date: { type: 'string' }, sort: { type: 'string' } } },
  mattermost_list_channels: { type: 'object' },
};

const posts = [
  { channel: 'town-square', author: 'Rob', time: '2026-10-11T10:00:00Z', text: 'Standup at ten', permalink: 'https://chat.peat-cloud.com/team/pl/abcdef1234567890abcdefghij' },
  { channel: 'town-square', author: 'Dana', time: '2026-10-11T10:01:00Z', text: 'On it', permalink: 'https://chat.peat-cloud.com/team/pl/0987654321fedcba0987654321' },
  // Longer than the 600-character per-field bound so the projection clip is exercised.
  { channel: 'town-square', author: 'Rob', time: '2026-10-11T10:02:00Z', text: 'L'.repeat(700), permalink: 'https://chat.peat-cloud.com/team/pl/longbody0000000000000000000000' },
];

const server = new Server({ name: 'stdio-mattermost-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({
  tools: [...READS, ...WRITES].map(name => ({ name, description: `Synthetic ${name}`, inputSchema: READ_SCHEMAS[name] ?? { type: 'object' } })),
}));
server.setRequestHandler('tools/call', request => {
  const name = request.params.name;
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ name, arguments: request.params.arguments ?? {} })}\n`);
  const schema = READ_SCHEMAS[name];
  if (schema?.additionalProperties === false) {
    const declared = Object.keys(schema.properties ?? {});
    const extra = Object.keys(request.params.arguments ?? {}).filter(key => !declared.includes(key));
    if (extra.length > 0) return { isError: true, content: [{ type: 'text', text: `unexpected argument(s): ${extra.join(', ')}` }] };
  }
  if (WRITES.includes(name)) {
    return { isError: true, content: [{ type: 'text', text: `forbidden write tool ${name} was called` }] };
  }
  if (mode === 'auth-needed') {
    return { isError: true, content: [{ type: 'text', text: 'not authenticated: no session found; run mattermost_login' }] };
  }
  let text = '{}';
  if (name === 'mattermost_whoami') text = JSON.stringify({ username: 'robert', display_name: 'Robert Peat' });
  else if (name === 'mattermost_list_channels') text = JSON.stringify({ channels: [{ name: 'town-square', display_name: 'Town Square' }] });
  else if (mode === 'empty') text = JSON.stringify({ posts: [] });
  else text = JSON.stringify({ posts });
  return { content: [{ type: 'text', text }] };
});
await server.connect(new StdioServerTransport());
