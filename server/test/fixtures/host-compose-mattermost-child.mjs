#!/usr/bin/env node
// W1030 synthetic stdio MCP child for the Mattermost endpoint of the host compose-wire test.
// It publishes one base read (mattermost_whoami, the connector's own-account probe), one channel
// read and the draft family's mattermost_save_draft, and nothing that could post, reply, react or
// invite. No server, account, token file or network call is touched.
// argv[2] = pid file (optional), argv[3] = 'auth_needed' to answer the child's own sign-in refusal.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const pidFile = process.argv[2];
const mode = process.argv[3] ?? 'ok';

const TOOLS = [
  { name: 'mattermost_whoami', description: 'Read the signed-in Mattermost account.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'mattermost_list_channels', description: 'List the visible channels.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  {
    name: 'mattermost_save_draft',
    description: 'Write one message into the owner\'s own Mattermost reply box, never posted to anyone.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['message'],
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 16384 },
        channel_id: { type: 'string', minLength: 1, maxLength: 64 },
        dm_username: { type: 'string', minLength: 1, maxLength: 64 },
        root_id: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  },
];

function envelopeFor(name, args) {
  if (name === 'mattermost_whoami') return { id: 'synthetic-user', username: 'owner', email: 'owner@example.test' };
  // Three synthetic channels: two share the spoken stem 'build', so the host's own resolver has a real
  // ambiguity to ask about, and one is an exact name the host must resolve to its id.
  if (name === 'mattermost_list_channels') {
    return { count: 3, channels: [
      { id: 'chan-town', name: 'town-square', display_name: 'Town Square' },
      { id: 'chan-build-logs', name: 'build-logs', display_name: 'Build Logs' },
      { id: 'chan-build-alerts', name: 'build-alerts', display_name: 'Build Alerts' },
    ] };
  }
  return { draft: { channel_id: args.channel_id ?? null, dm_username: args.dm_username ?? null, root_id: args.root_id ?? null, message: args.message }, saved: true };
}

const server = new Server({ name: 'synthetic-mattermost-compose-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));
server.setRequestHandler('tools/call', request => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (pidFile) appendFileSync(`${pidFile}.calls`, `${name}\n`);
  if (pidFile) appendFileSync(`${pidFile}.args`, `${name} ${JSON.stringify(args)}\n`);
  if (!TOOLS.some(tool => tool.name === name)) return { content: [{ type: 'text', text: `tool_unknown: the draft family does not publish ${name}` }], isError: true };
  if (mode === 'auth_needed' && name === 'mattermost_save_draft') {
    return { content: [{ type: 'text', text: 'not authenticated: run mattermost_login once' }], isError: true };
  }
  const envelope = envelopeFor(name, args);
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: false };
});

await server.connect(new StdioServerTransport());
