import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { composeMcpRuntime, type McpRuntimeComposition } from '../host/mcp.js';
import { GOOGLE_TOOLS } from '../connectors/google.js';
import { COMPOSE_CONSENT } from '../tools/compose.js';

// W1030: every fixture, address and id below is synthetic. No real account, token or Mattermost
// server is touched: the children are local stdio fakes that record what they were asked for.
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test', 'fixtures');
const googleWriteChild = join(fixtures, 'google-write-child.mjs');
const mattermostChild = join(fixtures, 'host-compose-mattermost-child.mjs');
const remember = (): { remembered: boolean; code: string } => ({ remembered: false, code: 'owner_transcript_not_final' });

interface Host { dir: string; store: Store; mcp: McpRuntimeComposition; identity: { connector: string; proven: boolean; endpointId?: string }[]; pid: (id: string) => string }

const endpoint = (options: { id: string; connector: string; file: string; args: string[]; pidFile?: string }) => ({
  id: options.id, transport: 'stdio' as const, command: process.execPath, args: [options.file, ...options.args, ...(options.pidFile === undefined ? [] : [options.pidFile])],
  env: { HOME: join(tmpdir(), 'didi-compose-wire-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
  connector: options.connector, account: 'owner', resource: options.id, credentialRef: null,
  enabled: true, allowEgress: true, unknownClass: 'ordinary' as const,
});

async function host(t: TestContext, build: (pid: (id: string) => string) => readonly unknown[], options: { catalog?: boolean } = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-compose-wire-'));
  const pid = (id: string): string => join(dir, `${id}.pid`);
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (options.catalog !== false) writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: build(pid) }), { mode: 0o600 });
  const store = new Store(join(dir, 'data'), toolsMigrations);
  const identity: Host['identity'] = [];
  const mcp = await composeMcpRuntime({
    store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null,
    identityLog: (connector, proven, _match, endpointId) => { identity.push({ connector, proven, ...(endpointId === undefined ? {} : { endpointId }) }); },
  });
  t.after(async () => { await mcp.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, mcp, identity, pid };
}

/** The recorded wire arguments of one fake child, one line per call. */
const callsOf = (pidFile: string): { tool: string; args: Record<string, unknown> }[] => {
  const file = `${pidFile}.args`;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(line => line !== '').map(line => {
    const space = line.indexOf(' ');
    return { tool: line.slice(0, space), args: JSON.parse(line.slice(space + 1)) as Record<string, unknown> };
  });
};
const toolNames = (pidFile: string): string[] => callsOf(pidFile).map(call => call.tool);
const ownerTools = (h: Host): string[] => h.mcp.owner.liveDefinitions('run-compose-wire', remember).map(tool => tool.name);

/** The three endpoints a configured host needs: both google write families and the Mattermost draft. */
const configured = (pid: (id: string) => string, mode = 'ok'): unknown[] => [
  endpoint({ id: 'gmail_draft', connector: 'google', file: googleWriteChild, args: ['gmail_draft', mode], pidFile: pid('gmail_draft') }),
  endpoint({ id: 'calendar_write', connector: 'google', file: googleWriteChild, args: ['calendar_write', mode], pidFile: pid('calendar_write') }),
  endpoint({ id: 'mattermost', connector: 'mattermost', file: mattermostChild, args: [mode], pidFile: pid('mattermost') }),
];

test('W1030: the real host composition offers the four write tools when the families are configured', async t => {
  const h = await host(t, pid => configured(pid));
  const names = ownerTools(h);
  for (const name of ['draft_email', 'draft_chat', 'create_event', 'delete_event']) assert.ok(names.includes(name), `${name} is offered`);
  // The write names ride in the grant and are still never model-facing reads.
  for (const name of ['gmail_create_draft', 'gmail_create_reply_draft', 'calendar_create_event', 'calendar_delete_event', 'mattermost_save_draft', 'google_identity']) {
    assert.equal(names.includes(name), false, `${name} is never a model-facing read tool`);
  }
  const connected = h.mcp.status().endpoints.map(report => `${report.id}:${report.state}`);
  assert.deepEqual([...connected].sort(), ['calendar_write:connected', 'gmail_draft:connected', 'mattermost:connected']);
  // The write family's read-only probe is the only call any google child saw at connect time.
  assert.deepEqual(toolNames(h.pid('gmail_draft')), ['google_identity'], 'the compose family proves itself with google_identity');
  assert.deepEqual(toolNames(h.pid('calendar_write')), ['google_identity'], 'the calendar_write family proves itself with google_identity');
  // That proof is the connector_identity line, and it names the family it proved.
  const proven = h.identity.filter(line => line.connector === 'google' && line.proven).map(line => line.endpointId).sort();
  assert.deepEqual(proven, ['calendar_write', 'gmail_draft']);
  // A write family is not a read envelope: the granted names of that endpoint are its write family.
  const grant = h.mcp.registry.currentGrant('gmail_draft');
  assert(grant);
  assert.deepEqual([...grant!.toolNames].sort(), ['gmail_create_draft', 'google_identity']);
  assert.equal(grant!.toolNames.includes('gmail_send'), false);
});

test('W1030: each write tool reaches its fake child through that composition with the closed arguments', async t => {
  const h = await host(t, pid => configured(pid));
  const draft = await h.mcp.compose.draftEmail({ to: 'sam@example.test', subject: 'Synthetic subject', body: 'Synthetic body', clientRequestId: 'req-draft' });
  assert.equal(draft.state, 'done');
  if (draft.state !== 'done') throw new Error('not done');
  assert.equal(draft.response['status'], 'draft_ready');
  const sent = callsOf(h.pid('gmail_draft')).find(call => call.tool === 'gmail_create_draft');
  assert(sent, 'gmail_create_draft reached the child');
  assert.deepEqual(sent!.args, { to: ['sam@example.test'], subject: 'Synthetic subject', body: 'Synthetic body', client_request_id: 'req-draft' });
  for (const forbidden of ['send', 'sent', 'attachments', 'invite']) assert.equal(forbidden in sent!.args, false, `a draft carries no ${forbidden}`);

  const created = await h.mcp.compose.createEvent({ summary: 'Synthetic block', startUtc: Date.UTC(2026, 10, 30, 9, 0), endUtc: Date.UTC(2026, 10, 30, 10, 0), timeZone: 'UTC', description: 'Synthetic note', clientRequestId: 'req-event' });
  assert.equal(created.state, 'done');
  if (created.state !== 'done') throw new Error('not done');
  assert.equal(created.response['status'], 'event_created');
  assert.equal(created.response['attendees'], 0);
  assert.equal(created.response['invitations'], 'none');
  const event = callsOf(h.pid('calendar_write')).find(call => call.tool === 'calendar_create_event');
  assert(event, 'calendar_create_event reached the child');
  assert.equal(event!.args['summary'], 'Synthetic block');
  assert.equal(event!.args['start'], '2026-11-30T09:00:00.000Z');
  assert.equal(event!.args['end'], '2026-11-30T10:00:00.000Z');
  assert.equal(event!.args['time_zone'], 'UTC');
  // Zero attendees and no update notification are the absence of either field in a schema that closes
  // the object, so the wire can never carry an invitation.
  for (const forbidden of ['attendees', 'attendee', 'sendUpdates', 'send_updates', 'invite', 'guests']) {
    assert.equal(forbidden in event!.args, false, `an event carries no ${forbidden}`);
  }

  const removed = await h.mcp.compose.deleteEvent({ eventId: 'event-synthetic', clientRequestId: 'req-delete' });
  assert.equal(removed.state, 'done');
  const deletion = callsOf(h.pid('calendar_write')).find(call => call.tool === 'calendar_delete_event');
  assert(deletion, 'calendar_delete_event reached the child');
  assert.deepEqual(deletion!.args, { event_id: 'event-synthetic' });

  const chat = await h.mcp.compose.draftChat({ person: 'Sam', message: 'Synthetic reply', clientRequestId: 'req-chat' });
  assert.equal(chat.state, 'done');
  if (chat.state !== 'done') throw new Error('not done');
  assert.equal(chat.response['status'], 'draft_ready');
  assert.equal(chat.response['posted'], false);
  const draftCall = callsOf(h.pid('mattermost')).find(call => call.tool === 'mattermost_save_draft');
  assert(draftCall, 'mattermost_save_draft reached the child');
  assert.deepEqual(draftCall!.args, { message: 'Synthetic reply', dm_username: 'Sam' });
  for (const forbidden of ['send', 'post', 'posted', 'reply_to_thread']) assert.equal(forbidden in draftCall!.args, false, `a chat draft carries no ${forbidden}`);
});

test('W1030: a write family whose child answers scope_missing is not_authorized with the authorize line', async t => {
  const h = await host(t, pid => configured(pid, 'scope_missing'));
  const created = await h.mcp.compose.createEvent({ summary: 'Synthetic block', startUtc: Date.UTC(2026, 10, 30, 9, 0), endUtc: Date.UTC(2026, 10, 30, 10, 0), timeZone: 'UTC', description: '', clientRequestId: 'req-event' });
  assert.deepEqual(created, { state: 'not_authorized', family: 'the calendar_write family', command: COMPOSE_CONSENT.create_event });
  assert.match(COMPOSE_CONSENT.create_event, /lux-google-mcp authorize --family calendar_write/);
  const chat = await h.mcp.compose.draftChat({ person: 'Sam', message: 'Synthetic reply', clientRequestId: 'req-chat' });
  assert.deepEqual(chat, { state: 'not_authorized', family: 'the Mattermost drafts family', command: 'auth needed: run mattermost_login once' });
  // The consent probe never writes, so it still succeeded and both endpoints stayed connected.
  assert.deepEqual(toolNames(h.pid('calendar_write')).slice(0, 1), ['google_identity']);
  assert.equal(h.mcp.status().endpoints.every(report => report.state === 'connected'), true);
});

test('W1030: a host with no write family answers connector_not_authorized and spawns nothing', async t => {
  const h = await host(t, () => [], { catalog: false });
  const names = ownerTools(h);
  // The four names are the shipped surface and stay offered; what changes without a family is the answer.
  for (const name of ['draft_email', 'draft_chat', 'create_event', 'delete_event']) assert.ok(names.includes(name), `${name} stays offered`);
  const draft = await h.mcp.compose.draftEmail({ to: 'sam@example.test', subject: 'Synthetic subject', body: 'Synthetic body', clientRequestId: 'req-draft' });
  assert.deepEqual(draft, { state: 'not_authorized', family: 'the gmail_draft family', command: COMPOSE_CONSENT.draft_email });
  const event = await h.mcp.compose.createEvent({ summary: 'Synthetic block', startUtc: Date.UTC(2026, 10, 30, 9, 0), endUtc: Date.UTC(2026, 10, 30, 10, 0), timeZone: 'UTC', description: '', clientRequestId: 'req-event' });
  assert.equal(event.state, 'not_authorized');
  assert.deepEqual(h.mcp.status().endpoints, []);
  assert.equal(h.mcp.connectionIds().length, 0);
});

test('W1030: a connect with only the read families is the read surface it always was', async t => {
  const readChild = join(fixtures, 'google-mcp-child.mjs');
  const h = await host(t, pid => [endpoint({ id: 'gmail', connector: 'google', file: readChild, args: ['ok'], pidFile: pid('gmail') })]);
  const grant = h.mcp.registry.currentGrant('gmail');
  assert(grant);
  assert.deepEqual([...grant!.toolNames].sort(), [...GOOGLE_TOOLS].sort());
  assert.equal(grant!.effect, 'read');
  const report = h.mcp.status().endpoints.find(endpoint => endpoint.id === 'gmail');
  assert.equal(report?.state, 'connected');
  assert.equal(report?.tools, GOOGLE_TOOLS.length);
  const names = ownerTools(h);
  for (const name of ['gmail_get_profile', 'gmail_search_messages', 'calendar_list_events']) assert.ok(names.includes(name), `${name} is still offered`);
  for (const name of ['gmail_create_draft', 'calendar_create_event', 'mattermost_save_draft']) assert.equal(names.includes(name), false, `${name} is not`);
  // The compose tools are offered and honest about the family this host does not have.
  const draft = await h.mcp.compose.draftEmail({ to: 'sam@example.test', subject: 'Synthetic subject', body: 'Synthetic body', clientRequestId: 'req-draft' });
  assert.equal(draft.state, 'not_authorized');
});
