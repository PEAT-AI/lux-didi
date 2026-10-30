#!/usr/bin/env node
// W1030 synthetic stdio MCP child for the two write families.
// It publishes exactly one recorded family from google-tools-list.json (GW-R4 recording at
// lux-cli feat/google-write-1030), so a test can drive the recorded names through real discovery and
// then through the connector's preflight. No account, network or token file is touched.
// argv[2] = recorded family key (gmail_draft | calendar_write), argv[3] = pid file (optional).
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const family = process.argv[2] ?? 'gmail_draft';
const pidFile = process.argv[3];
// argv[4] = 'scope_missing' makes every write (never the consent probe) answer the helper's own
// credential refusal, so the host's not_authorized path can be driven without any real token.
const mode = process.argv[4] ?? 'ok';
const recording = JSON.parse(readFileSync(new URL('./google-tools-list.json', import.meta.url), 'utf8'));
const TOOLS = recording.families[family].tools;

function envelopeFor(name, args) {
  if (name === 'google_identity') {
    return { family, tool: name, method: name, account: { configured: 'configured', provider: null },
      data: { email: 'owner@example.invalid', family: family === 'gmail_draft' ? 'gmail_draft' : 'calendar_write', scopes: ['https://www.googleapis.com/auth/gmail.compose'] },
      coverage: { returned: 1, complete: true, next_page_token: null }, diagnostics: [], received: args };
  }
  const data = name === 'gmail_create_draft'
    ? { draft_id: 'draft-synthetic', message_id: 'message-synthetic', thread_id: 'thread-synthetic' }
    : name === 'calendar_create_event'
      ? { event_id: 'event-synthetic', html_link: 'https://example.invalid/event-synthetic', start: args.start, end: args.end, time_zone: args.time_zone }
      : { deleted: true };
  return { family, tool: name, method: name, account: { configured: 'configured', provider: null }, data,
    coverage: { returned: 1, complete: true, next_page_token: null }, diagnostics: [], received: args };
}

const server = new Server({ name: 'synthetic-google-write-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));
server.setRequestHandler('tools/call', request => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (pidFile) appendFileSync(`${pidFile}.calls`, `${name}\n`);
  // The exact wire arguments, one line per call, so a test can prove what was and was not sent.
  if (pidFile) appendFileSync(`${pidFile}.args`, `${name} ${JSON.stringify(args)}\n`);
  const published = TOOLS.some(tool => tool.name === name);
  if (!published) return { content: [{ type: 'text', text: `tool_unknown: the ${family} family does not publish ${name}` }], isError: true };
  if (mode === 'scope_missing' && name !== 'google_identity') {
    return { content: [{ type: 'text', text: `scope_missing: the ${family} token lacks the scope this call needs` }], isError: true };
  }
  const envelope = envelopeFor(name, args);
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: false };
});

await server.connect(new StdioServerTransport());
