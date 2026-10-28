/**
 * C-DEPTH11: the Google calendar read takes the owner's own calendars and leaves the subscribed ones
 * alone, and a mail helper that answers with no payload is a failure with a closed code, never an
 * empty inbox.
 *
 * Fixtures are synthetic. Field shapes follow Google's published reference:
 * - calendarList entry `accessRole` / `primary`:
 *   https://developers.google.com/workspace/calendar/api/v3/reference/calendarList#resource
 * - events.list returns entries of `events`:
 *   https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 * - Gmail messages.list returns `messages`:
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { CallResult, CompletedResult, EndpointConfig, McpPort, ResultScope } from '../adapters/mcp/port.js';
import { createGoogleReader, type GoogleConfig, type GoogleResult } from '../connectors/index.js';
import { renderGoogleTool } from '../tools/google.js';
import { noEmptyResult, shapeGmailList } from '../tools/live-shape.js';

const ACCOUNT = 'local';
const RESOURCE = 'google-fixture';
const DIGEST = 'synthetic-calendar-digest';

function scopeFor(tool: string): ResultScope {
  return { endpointId: 'depth-fake', url: 'https://fake.invalid', schemaDigest: DIGEST, toolName: tool, generation: 1, account: ACCOUNT, resource: RESOURCE } as unknown as ResultScope;
}

function completed(data: unknown, tool: string): CompletedResult {
  return {
    state: 'completed', decodedResult: { content: [{ type: 'text', text: JSON.stringify({ data }) }] },
    source: scopeFor(tool), coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
    freshness: { receivedAt: 0, sourceVersion: 'unknown' },
    projection: { text: '', omitted: false, originalCharacters: 0, omittedCharacters: 0 },
    payload: { state: 'unavailable', reason: 'capacity' },
  };
}

function readOf(result: GoogleResult): Record<string, unknown> {
  if (result.state !== 'completed') throw new Error(`not completed: ${JSON.stringify(result)}`);
  const content = (result.decodedResult as { content?: { text?: string }[] }).content;
  const envelope = JSON.parse(content?.[0]?.text ?? '{}') as { data?: Record<string, unknown> };
  return envelope.data ?? {};
}

function readerFor(port: McpPort, toolNames: string[], family: GoogleConfig['family'], overrides: Partial<GoogleConfig> = {}) {
  const id = 'depth-fake';
  const registry = new McpRegistry();
  const endpoint = {
    id, transport: 'stdio', command: process.execPath, args: ['fixture'],
    env: { HOME: join(tmpdir(), 'didi-depth-home'), PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    account: ACCOUNT, resource: RESOURCE,
  } as unknown as EndpointConfig;
  registry.register(endpoint);
  registry.enable(id);
  registry.allowEgress(id);
  const tools = toolNames.map(name => ({ name, inputSchema: { type: 'object' } }));
  const digest = registry.observed(id, tools, registry.revision(id));
  registry.approve({ endpointId: id, schemaDigest: digest, toolNames: [...toolNames], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return createGoogleReader({ port, registry, config: { endpointId: id, account: ACCOUNT, resource: RESOURCE, schemaDigest: digest, generation: 1, ...overrides, family } });
}

const CALENDAR_TOOLS = ['calendar_list_calendars', 'calendar_list_events'];

function calendarPort(calendars: Record<string, unknown>[], seen: string[], event?: (id: string) => Record<string, unknown>): McpPort {
  return {
    discover: async () => ({ state: 'discovered', endpointId: 'depth-fake', schemaDigest: DIGEST, tools: CALENDAR_TOOLS.map(name => ({ name, inputSchema: { type: 'object' } })), observedAt: 0 }),
    visibleTools: () => [],
    whenSuspended: async () => undefined,
    close: async () => undefined,
    readSlice: () => ({ state: 'unavailable', reason: 'synthetic' }),
    async call(request): Promise<CallResult> {
      if (request.toolName === 'calendar_list_calendars') return completed({ calendars }, 'calendar_list_calendars');
      const id = String(request.arguments['calendarId']);
      seen.push(id);
      const entry = event === undefined ? { id: `e-${id}`, summary: `Event ${id}`, start: { dateTime: '2026-10-16T09:00:00+05:30' } } : event(id);
      return completed({ events: [entry] }, 'calendar_list_events');
    },
  };
}

test('C-DEPTH11: the default calendar read takes the owner calendars and leaves the subscribed ones out', async () => {
  const seen: string[] = [];
  const port = calendarPort([
    { id: 'owner@example.invalid', summary: 'Owner', primary: true, accessRole: 'owner' },
    { id: 'work@example.invalid', summary: 'Work', accessRole: 'owner' },
    { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in the United States', accessRole: 'reader' },
    { id: '#weeknum@group.v.calendar.google.com', summary: 'Week Numbers', accessRole: 'reader' },
    { id: '#contacts@group.v.calendar.google.com', summary: "Contacts' birthdays and events", accessRole: 'reader' },
  ], seen);
  const result = await readerFor(port, CALENDAR_TOOLS, 'calendar').gcalList({});
  assert.deepEqual(seen, ['owner@example.invalid', 'work@example.invalid'], 'a holiday, week-number or contacts calendar is never read by default');
  const events = readOf(result)['events'] as Record<string, unknown>[];
  assert.deepEqual(events.map(event => event['calendar']), ['Owner', 'Work'], 'only the owner calendars contribute events');
});

test('C-DEPTH11: a subscribed calendar is still read when the ask names it', async () => {
  const seen: string[] = [];
  const port = calendarPort([
    { id: 'owner@example.invalid', summary: 'Owner', primary: true, accessRole: 'owner' },
    { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in the United States', accessRole: 'reader' },
  ], seen);
  const result = await readerFor(port, CALENDAR_TOOLS, 'calendar').gcalList({ calendarIds: ['en.usa#holiday@group.v.calendar.google.com'] });
  assert.deepEqual(seen, ['en.usa#holiday@group.v.calendar.google.com'], 'an asked-for calendar is read, subscribed or not');
  assert.equal((readOf(result)['events'] as unknown[]).length, 1);
});

test('C-DEPTH11/#648: a mail helper that answers with no payload is a failure with a closed code', async () => {
  const port: McpPort = {
    discover: async () => ({ state: 'discovered', endpointId: 'depth-fake', schemaDigest: DIGEST, tools: [], observedAt: 0 }),
    visibleTools: () => [],
    whenSuspended: async () => undefined,
    close: async () => undefined,
    readSlice: () => ({ state: 'unavailable', reason: 'synthetic' }),
    async call(): Promise<CallResult> {
      // The shape a half-written or crashed helper leaves behind: one text item with an empty body.
      return { ...completed({}, 'gmail_search_messages'), decodedResult: { content: [{ type: 'text', text: '' }] } };
    },
  };
  const result = await readerFor(port, ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message'], 'gmail').gmailList({ q: 'newer_than:2d is:unread' });
  assert.equal(result.state, 'unknown', 'no payload is a failure, never a completed empty search');
  assert.equal(result.state === 'unknown' ? result.reason : '', 'invalid_result', 'the closed code names the no-payload case');
});

test('C-DEPTH11: the calendar tool output frame carries the attendees the fake connector returned', async () => {
  const seen: string[] = [];
  const port = calendarPort([{ id: 'owner@example.invalid', summary: 'Owner', primary: true, accessRole: 'owner' }], seen, id => ({
    id: `e-${id}`, summary: 'Design review', start: { dateTime: '2026-10-19T15:00:00Z' },
    organizer: { email: 'robin.vale@example.invalid' },
    attendees: [
      { email: 'robin.vale@example.invalid', responseStatus: 'accepted' },
      { displayName: 'Ari Andor', email: 'ari.andor@example.invalid', responseStatus: 'declined' },
    ],
  }));
  const result = await readerFor(port, CALENDAR_TOOLS, 'calendar').gcalList({});
  // The frame builder the connector owner uses for every Google result (server/connectors/index.ts googleProject).
  const frame = renderGoogleTool('calendar_list_events', readOf(result));
  assert.match(frame.text, /attendees: 2 people: robin\.vale \(organizer, accepted\), Ari Andor \(declined\)/u, 'the people and their answers reach the tool output frame');
});

test('C-DEPTH11: a calendar list with only subscribed calendars reads no events instead of a public holiday', async () => {
  const seen: string[] = [];
  const port = calendarPort([
    { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in the United States', accessRole: 'reader' },
    { id: '#weeknum@group.v.calendar.google.com', summary: 'Week Numbers', accessRole: 'reader' },
  ], seen);
  const result = await readerFor(port, CALENDAR_TOOLS, 'calendar').gcalList({});
  assert.deepEqual(seen, [], 'no subscribed calendar is read for a plain schedule question');
  assert.deepEqual(readOf(result)['events'], [], 'and no holiday is served as the owner schedule');
});

test('C-DEPTH11/#648: an honest empty is the paired opposite, and it carries the query it ran', () => {
  const shaped = shapeGmailList({ messages: [] });
  const words = noEmptyResult(shaped.text, 'mail', 'newer_than:2d is:unread');
  assert.match(words, /came back empty/u, 'a search that matched nothing is said in words');
  assert.match(words, /newer_than:2d is:unread/u, 'the words name the query that ran, so an empty can be checked');
  assert.doesNotMatch(words, /invalid_result/u, 'an honest empty never borrows the failure code');
});
