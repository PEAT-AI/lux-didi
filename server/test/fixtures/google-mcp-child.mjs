#!/usr/bin/env node
// Synthetic stdio MCP child for check-google-connector.sh.
// No real account, network, credential or application file is touched. It exposes the five
// Gmail/Calendar read tools plus a decoy write tool so a test can prove the write is never granted.
// argv[2] = mode (ok | credential | flaky), argv[3] = optional pid file.
// flaky fails the first gcal_list call with the credential error and succeeds afterwards.
import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const mode = process.argv[2] ?? 'ok';
const pidFile = process.argv[3];
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
  writeFileSync(`${pidFile}.env`, JSON.stringify(process.env));
}

const BASE_TOOLS = [
  { name: 'gmail_get_profile', description: 'Synthetic profile read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'gmail_list', description: 'Synthetic message list', inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' }, pageToken: { type: 'string' }, q: { type: 'string' } }, additionalProperties: false } },
  { name: 'gmail_read', description: 'Synthetic message read', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'gcal_calendars', description: 'Synthetic calendar list', inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
  { name: 'gcal_list', description: 'Synthetic event list', inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
];
const DECOY = { name: 'gmail_send', description: 'Decoy write tool that must never be granted', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false } };
const TOOLS = mode === 'decoy' ? [...BASE_TOOLS, DECOY] : BASE_TOOLS;

const headers = { Subject: 'Synthetic subject line', From: 'Synthetic Sender <sender@example.invalid>', Date: 'Mon, 1 Jan 2024 00:00:00 +0000' };

function dataFor(name, args) {
  if (name === 'gmail_get_profile') return { emailAddress: 'owner@example.invalid', messagesTotal: 3, threadsTotal: 2 };
  if (name === 'gmail_list') {
    // 'ramp' models the real child: messages.list returns up to maxResults ids and the child then
    // issues one metadata GET per id, so the listed count equals the upstream round trips.
    if (mode !== 'ramp') return { messages: [{ id: 'm1', threadId: 't1', headers }, { id: 'm2', threadId: 't2', headers }] };
    const count = Math.max(1, Math.min(Number.isInteger(args.maxResults) ? args.maxResults : 10, 10));
    return { messages: Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`, threadId: `t${index + 1}`, headers })) };
  }
  if (name === 'gmail_read') return { id: args.id ?? 'm1', threadId: 't1', headers, body: 'b'.repeat(20000) };
  if (name === 'gcal_calendars') return { calendars: [{ id: 'primary', summary: 'Primary' }, { id: 'work', summary: 'Work' }] };
  if (name === 'gcal_list') return { events: [{ id: 'e1', summary: 'Synthetic standup', location: 'Room 1', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e1' }] };
  return { written: true };
}

function envelopeFor(name, args) {
  return {
    family: name.startsWith('gmail') ? 'gmail' : 'calendar',
    tool: name,
    method: name,
    account: { configured: 'configured', provider: null },
    data: dataFor(name, args),
    coverage: { returned: 1, complete: true, next_page_token: null },
    diagnostics: [],
    received: args,
  };
}

const server = new Server({ name: 'synthetic-google-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });
let calendarCalls = 0;
server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));
server.setRequestHandler('tools/call', request => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  const failsFirst = mode === 'flaky' && name === 'gcal_list' && calendarCalls++ === 0;
  if (name === 'gcal_list' && (mode === 'credential' || failsFirst)) {
    return { content: [{ type: 'text', text: 'credential-missing: no calendar token is available; run the interactive login once' }], isError: true };
  }
  const envelope = envelopeFor(name, args);
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: false };
});

await server.connect(new StdioServerTransport());
