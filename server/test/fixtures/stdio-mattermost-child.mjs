#!/usr/bin/env node
// Synthetic stdio MCP child for check-company-connectors.sh (Mattermost connector).
// No real accounts, network access, credentials, sessions or application files are touched.
// argv[2] = mode (ok | auth-needed | empty | unknown-channel | no-thread).
// The child never reads ~/.local/share/mattermost-mcp.
// Envelopes are literal copies of the installed child's shapes (mattermost-mcp src/search/serialize.ts):
// search and channel history answer {total, returned, results}, a thread answers {root, replies},
// whoami answers {id, username, email}, list_channels answers {count, channels}. The declared limit
// maxima are the child's own (search 50, channel history 200).
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'ok';
const logPath = process.env.DIDI_FAKE_MATTERMOST_LOG;
const READS = ['mattermost_whoami', 'mattermost_get_channel_history', 'mattermost_get_thread', 'mattermost_search', 'mattermost_list_channels'];
// The write tools the installed child publishes; the connector's envelope never includes one.
const WRITES = ['mattermost_post_message', 'mattermost_reply_to_thread', 'mattermost_add_reaction', 'mattermost_edit_post'];

// Per-tool input schemas mirroring the real mattermost-mcp child (src/mcp/tools.ts):
// mattermost_get_thread takes only post_id and format and closes the object, so an undeclared
// limit is rejected; mattermost_get_channel_history and mattermost_search do declare limit.
const READ_SCHEMAS = {
  mattermost_whoami: { type: 'object' },
  mattermost_get_channel_history: { type: 'object', additionalProperties: false, required: ['channel'], properties: { channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, format: { type: 'string', enum: ['concise', 'detailed'] } } },
  mattermost_get_thread: { type: 'object', additionalProperties: false, required: ['post_id'], properties: { post_id: { type: 'string' }, format: { type: 'string', enum: ['concise', 'detailed'] } } },
  mattermost_search: { type: 'object', properties: { query: { type: 'string' }, channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, from_date: { type: 'string' }, to_date: { type: 'string' }, sort: { type: 'string', enum: ['relevance', 'newest'] } } },
  mattermost_list_channels: { type: 'object' },
};

const CHANNELS = [
  { id: 'chanTownSquare', name: 'town-square', display_name: 'Town Square', type: 'O' },
  { id: 'chanDogcation', name: 'dogcation', display_name: 'Dogcation', type: 'O' },
];

const posts = [
  { id: 'postStandup', username: 'rob', channel: 'town-square', timestamp: '2026-10-11T10:00:00.000Z', message: 'Standup at ten', url: 'https://chat.peat-cloud.com/team/pl/abcdef1234567890abcdefghij' },
  { id: 'postOnIt', username: 'dana', channel: 'town-square', timestamp: '2026-10-11T10:01:00.000Z', message: 'On it', url: 'https://chat.peat-cloud.com/team/pl/0987654321fedcba0987654321' },
  // Longer than the 600-character per-field bound so the projection clip is exercised.
  { id: 'postLongBody', username: 'rob', channel: 'town-square', timestamp: '2026-10-11T10:02:00.000Z', message: 'L'.repeat(700), url: 'https://chat.peat-cloud.com/team/pl/longbody0000000000000000000000' },
];
const envelope = list => ({ total: list.length, returned: list.length, results: list });

// A child that does not publish the thread read: the attention composite can never be granted.
const TOOLS = [...READS.filter(name => !(mode === 'no-thread' && name === 'mattermost_get_thread')), ...WRITES];

const server = new Server({ name: 'stdio-mattermost-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({
  tools: TOOLS.map(name => ({ name, description: `Synthetic ${name}`, inputSchema: READ_SCHEMAS[name] })),
}));
server.setRequestHandler('tools/call', request => {
  const name = request.params.name;
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ name, arguments: request.params.arguments ?? {} })}\n`);
  if (!TOOLS.includes(name)) return { isError: true, content: [{ type: 'text', text: `unsupported tool ${name}` }] };
  if (WRITES.includes(name)) return { isError: true, content: [{ type: 'text', text: `forbidden write tool ${name} was called` }] };
  const schema = READ_SCHEMAS[name];
  if (schema?.additionalProperties === false) {
    const declared = Object.keys(schema.properties ?? {});
    const extra = Object.keys(request.params.arguments ?? {}).filter(key => !declared.includes(key));
    if (extra.length > 0) return { isError: true, content: [{ type: 'text', text: `unexpected argument(s): ${extra.join(', ')}` }] };
  }
  if (mode === 'auth-needed') {
    return { isError: true, content: [{ type: 'text', text: 'not authenticated: no session found; run mattermost_login' }] };
  }
  let value = {};
  if (name === 'mattermost_whoami') value = { id: 'owner0000000000000000000a', username: 'robert', email: 'robert@example.invalid' };
  else if (name === 'mattermost_list_channels') value = { count: CHANNELS.length, channels: CHANNELS };
  else if (name === 'mattermost_get_thread') value = { root: posts[0], replies: posts.slice(1) };
  else if (mode === 'empty') value = envelope([]);
  else value = envelope(posts);
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
});
await server.connect(new StdioServerTransport());
