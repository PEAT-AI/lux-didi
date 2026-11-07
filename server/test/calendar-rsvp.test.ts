import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { McpPort } from '../adapters/mcp/port.js';
import { createGoogleReader } from '../connectors/google.js';
import type { GoogleReader } from '../connectors/google.js';
import { calendarResponseStatus, calendarRsvpRefusal, CALENDAR_RSVP_SCHEMA, CALENDAR_RSVP_REFUSAL } from '../tools/calendar-rsvp.js';
import { createRegistry, TASK_TOOL_NAMES } from '../tasks/tools.js';
import type { ToolPorts } from '../tasks/tools.js';
import { FakeAuthority } from '../tasks/authority.js';
import type { Identity } from '../tasks/authority.js';

interface SentCall { toolName: string; arguments: Record<string, unknown> }

/** The calendar_write endpoint, its granted responder tool and the helper's own answer. */
function wire(helperReason = 'synthetic-capture'): { reader: GoogleReader; calls: SentCall[] } {
  const registry = new McpRegistry();
  const endpointId = 'synthetic-calendar-rsvp';
  registry.register({ id: endpointId, transport: 'stdio', command: process.execPath, args: [], env: { HOME: '/tmp/synthetic-calendar-rsvp', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'synthetic', resource: 'synthetic' });
  registry.enable(endpointId); registry.allowEgress(endpointId);
  const tools = [{ name: 'calendar_respond_event', inputSchema: { type: 'object' } }];
  const digest = registry.observed(endpointId, tools, registry.revision(endpointId));
  registry.approve({ endpointId, schemaDigest: digest, toolNames: ['calendar_respond_event'], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const calls: SentCall[] = [];
  const port = { call: async (request: SentCall) => { calls.push(request); return { state: 'refused', reason: helperReason }; } } as unknown as McpPort;
  const reader = createGoogleReader({ port, registry, config: { endpointId, account: 'synthetic', resource: 'synthetic', schemaDigest: digest, generation: 1, family: 'calendar_write' } });
  return { reader, calls };
}

const identity: Identity = { task_id: 'synthetic-task', task_revision: 1, operation_id: 'synthetic-operation', connection_generation: 1 };

test('an invited event is answered with one connector call carrying the accept status', async () => {
  const { reader, calls } = wire();
  await reader.calendarRespondEvent({ eventId: 'synthetic-event-1', response: 'accepted' });
  assert.equal(calls.length, 1, 'one write reaches the helper');
  assert.equal(calls[0]?.toolName, 'calendar_respond_event');
  assert.deepEqual(calls[0]?.arguments, { event_id: 'synthetic-event-1', response_status: 'accepted' });
});

test('a decline carries his note and no attendee list or update request', async () => {
  const { reader, calls } = wire();
  await reader.calendarRespondEvent({ eventId: 'synthetic-event-2', response: 'declined', note: '  Synthetic conflict.  ' });
  assert.equal(calls.length, 1);
  const sent = calls[0]?.arguments ?? {};
  assert.equal('attendees' in sent, false, 'no attendee list is sent');
  assert.equal('sendUpdates' in sent, false, 'no update notification is requested');
  assert.equal('send_updates' in sent, false);
  assert.deepEqual(sent, { event_id: 'synthetic-event-2', response_status: 'declined', note: 'Synthetic conflict.' });
});

test('an event that is not his invitation answers with one closed refusal and no second call', async () => {
  const { reader, calls } = wire('not_an_invitation');
  const result = await reader.calendarRespondEvent({ eventId: 'synthetic-event-3', response: 'tentative' });
  assert.equal(result.state, 'refused');
  assert.equal(calls.length, 1, 'the helper was asked once and never retried');
  const reason = 'reason' in result ? result.reason : '';
  assert.equal(calendarRsvpRefusal(reason), CALENDAR_RSVP_REFUSAL);
  assert.equal(calendarRsvpRefusal('not_attendee'), CALENDAR_RSVP_REFUSAL);
  assert.equal(calendarRsvpRefusal('grant-absent'), undefined, 'an unrelated refusal keeps its own cause');
});

test('an unusable response word or empty id never reaches the wire', async () => {
  const { reader, calls } = wire();
  const word = await reader.calendarRespondEvent({ eventId: 'synthetic-event-4', response: 'maybe' as 'accepted' });
  assert.deepEqual(word, { state: 'refused', reason: 'invalid-response-status' });
  const empty = await reader.calendarRespondEvent({ eventId: '', response: 'accepted' });
  assert.deepEqual(empty, { state: 'refused', reason: 'invalid-event-id' });
  assert.equal(calls.length, 0);
  assert.equal(calendarResponseStatus('accept'), 'accepted');
  assert.equal(calendarResponseStatus('decline'), 'declined');
  assert.equal(calendarResponseStatus('tentative'), 'tentative');
  assert.equal(calendarResponseStatus('maybe'), undefined);
});

test('after outside text the authority port decides the write before the connector is called', async () => {
  assert.ok(TASK_TOOL_NAMES.has(CALENDAR_RSVP_SCHEMA.name), 'the responder is a registered task tool');
  const { reader, calls } = wire();
  const authority = new FakeAuthority();
  const order: string[] = [];
  const ports: ToolPorts = {
    authority,
    execute: async (name, args) => {
      order.push('execute');
      await reader.calendarRespondEvent({ eventId: String(args.id), response: calendarResponseStatus(String(args.response)) ?? 'accepted', ...(typeof args.note === 'string' ? { note: args.note } : {}) });
      return { status: 'ok', text: 'Answered.', references: [], next_cursor: null, coverage: 'Synthetic responder.', repair: null };
    },
  };
  const tool = createRegistry(ports).get(CALENDAR_RSVP_SCHEMA.name);
  assert.ok(tool, 'the responder is in the task registry');
  const result = await tool.run({ id: 'synthetic-event-5', response: 'accept', note: null }, identity, new AbortController().signal, true);
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(authority.requests.length, 1, 'the write is admitted by the authority port after outside text');
  assert.equal(authority.requests[0]?.tool, CALENDAR_RSVP_SCHEMA.name);
  assert.equal(authority.requests[0]?.effect, 'external');
  assert.equal(authority.requests[0]?.outside_text, true);
  assert.deepEqual(order, ['execute']);
});
