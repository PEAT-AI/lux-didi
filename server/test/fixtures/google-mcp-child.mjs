#!/usr/bin/env node
// Synthetic stdio MCP child for check-google-connector.sh.
// No real account, network, credential or application file is touched. It exposes the five
// Gmail/Calendar read tools (decoy mode adds the Drive pair) plus a decoy write tool so a test can prove
// the write is never granted.
// argv[2] = mode (ok | credential | flaky | gmail-only | drive | drive-code:<helper code> | code:<helper code> |
// first:<helper code> | first-mail:<helper code>),
// argv[3] = pid file.
// flaky fails the first calendar_list_events call with the credential error and succeeds afterwards.
// code:<helper code> fails every tool call with that one code, so a test maps each published code
// through the real connector; first:<helper code> fails only the first call, so a test can prove the
// next ask retries. first-mail:<helper code> fails only the first gmail_search_messages call, so a test
// can put one failed mail read in the middle of a sequence of healthy ones (#636).
// Every tool call is appended to <pid file>.calls so a test can count dispatches.
import { appendFileSync, writeFileSync } from 'node:fs';
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
  { name: 'gmail_search_messages', description: 'Synthetic message list', inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' }, pageToken: { type: 'string' }, q: { type: 'string' } }, additionalProperties: false } },
  { name: 'gmail_read_message', description: 'Synthetic message read', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'calendar_list_calendars', description: 'Synthetic calendar list', inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
  { name: 'calendar_list_events', description: 'Synthetic event list', inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
];
// C-DRIVE schemas (lux-cli drive family): read-only metadata, webViewLink only.
const DRIVE_TOOLS = [
  { name: 'drive_search_files', description: 'Synthetic Drive name search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, mime_types: { type: 'array', items: { type: 'string' } }, modified_after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false } },
  { name: 'drive_get_file', description: 'Synthetic Drive file read', inputSchema: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'], additionalProperties: false } },
];
const DECOY = { name: 'gmail_send', description: 'Decoy write tool that must never be granted', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false } };
// gmail-only publishes the mailbox family alone, drive and drive-code:<code> the Drive family alone, as the
// installed helper does per endpoint.
const TOOLS = mode === 'decoy' ? [...BASE_TOOLS, ...DRIVE_TOOLS, DECOY]
  : mode === 'gmail-only' ? BASE_TOOLS.filter(tool => tool.name.startsWith('gmail_'))
  : mode === 'drive' || mode.startsWith('drive-code:') ? DRIVE_TOOLS : BASE_TOOLS;
const DRIVE_OWNERS = [{ displayName: 'Synthetic Owner', emailAddress: 'owner@example.invalid' }];
const DRIVE_FILES = [
  { id: 'SyntheticDeckNew01', name: 'Harbour review deck', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-10-24T08:00:00.000Z', owners: DRIVE_OWNERS, webViewLink: 'https://docs.google.com/presentation/d/SyntheticDeckNew01/edit?usp=drivesdk' },
  { id: 'SyntheticDeckOld01', name: 'Harbour review deck (old)', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-09-02T08:00:00.000Z', owners: DRIVE_OWNERS, webViewLink: 'https://docs.google.com/presentation/d/SyntheticDeckOld01/edit?usp=drivesdk' },
];

const headers = { Subject: 'Synthetic subject line', From: 'Synthetic Sender <sender@example.invalid>', Date: 'Mon, 1 Jan 2024 00:00:00 +0000' };
// The real child's gmail_search_messages builds each entry from a metadata GET: `headers` is an array of
// name/value pairs and the snippet/header text carries HTML entities, unlike a one-message read.
const listHeaders = [
  { name: 'From', value: 'Synthetic Sender &lt;sender@example.invalid&gt;' },
  { name: 'Subject', value: 'Synthetic subject line &amp; more' },
  { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
];
const snippet = 'it&#39;s &lt;ready&gt; to read';

function dataFor(name, args) {
  if (name === 'gmail_get_profile') return { emailAddress: 'owner@example.invalid', messagesTotal: 3, threadsTotal: 2 };
  if (name === 'gmail_search_messages') {
    // 'ramp' models the real child: the batched fetch returns one listed message per requested id in
    // a single upstream call, so the listed count equals the maxResults the connector asked for.
    if (mode !== 'ramp') return { messages: [{ id: 'm1', threadId: 't1', snippet, headers: listHeaders }, { id: 'm2', threadId: 't2', snippet, headers: listHeaders }] };
    const count = Math.max(1, Math.min(Number.isInteger(args.maxResults) ? args.maxResults : 10, 10));
    return { messages: Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`, threadId: `t${index + 1}`, snippet, headers: listHeaders })) };
  }
  if (name === 'gmail_read_message') return { id: args.id ?? 'm1', threadId: 't1', headers, body: args.format === 'full' ? `${mode === 'quoted' ? 'Latest note.\nOn Monday, Synthetic Sender wrote:\n> Synthetic retained historical evidence.\n' : ''}${'b'.repeat(20000)}` : null, format: args.format ?? 'metadata' };
  // The real helper's primary calendar id is the account's own address, which is what the connector
  // reads as the Google identity; the synthetic child answers the same shape.
  if (name === 'calendar_list_calendars') return { calendars: [{ id: 'owner@example.invalid', summary: 'Primary', primary: true }, { id: 'work', summary: 'Work' }] };
  // The real event link shape: host www.google.com, path /calendar/event and an eid (synthetic value).
  if (name === 'calendar_list_events') return { events: [{ id: 'e1', summary: 'Synthetic standup', location: 'Room 1', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://www.google.com/calendar/event?eid=c3ludGhldGljLWUx' }] };
  if (name === 'drive_search_files') {
    const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const files = DRIVE_FILES.filter(file => words.every(word => file.name.toLowerCase().includes(word)));
    return { files: files.slice(0, Number.isInteger(args.limit) ? args.limit : 5), total_hint: files.length };
  }
  if (name === 'drive_get_file') return { ...(DRIVE_FILES.find(file => file.id === args.file_id) ?? DRIVE_FILES[0]), trashed: false };
  return { written: true };
}

function envelopeFor(name, args) {
  return {
    family: name.startsWith('gmail') ? 'gmail' : name.startsWith('drive') ? 'drive' : 'calendar',
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
let toolCalls = 0;
let mailCalls = 0;
server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));
server.setRequestHandler('tools/call', request => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (pidFile) appendFileSync(`${pidFile}.calls`, `${name}\n`);
  const failsFirstMail = mode.startsWith('first-mail:') && name === 'gmail_search_messages' && mailCalls++ === 0;
  if (mode.startsWith('code:') || mode.startsWith('drive-code:') || (mode.startsWith('first:') && toolCalls++ === 0) || failsFirstMail) {
    const code = mode.slice(mode.indexOf(':') + 1);
    return { content: [{ type: 'text', text: `${code}: synthetic helper refusal` }], isError: true };
  }
  const failsFirst = mode === 'flaky' && name === 'calendar_list_events' && calendarCalls++ === 0;
  if (name === 'calendar_list_events' && (mode === 'credential' || failsFirst)) {
    return { content: [{ type: 'text', text: 'credential-missing: no calendar token is available; run the interactive login once' }], isError: true };
  }
  const envelope = envelopeFor(name, args);
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: false };
});

await server.connect(new StdioServerTransport());
