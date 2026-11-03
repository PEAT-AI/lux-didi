import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { McpPort } from '../adapters/mcp/port.js';
import { createGoogleReader } from '../connectors/google.js';

test('calendar_create_event dispatch has no attendees and requests no updates even with surplus input', async () => {
  const registry = new McpRegistry();
  const endpointId = 'synthetic-calendar';
  registry.register({ id: endpointId, transport: 'stdio', command: process.execPath, args: [], env: { HOME: '/tmp/synthetic-calendar', PATH: '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' }, account: 'synthetic', resource: 'synthetic' });
  registry.enable(endpointId); registry.allowEgress(endpointId);
  const tools = [{ name: 'calendar_create_event', inputSchema: { type: 'object' } }];
  const digest = registry.observed(endpointId, tools, registry.revision(endpointId));
  registry.approve({ endpointId, schemaDigest: digest, toolNames: ['calendar_create_event'], effect: 'read', account: 'synthetic', resource: 'synthetic', generation: 1 });
  const calls: { toolName: string; arguments: Record<string, unknown> }[] = [];
  const port = { call: async (request: typeof calls[number]) => { calls.push(request); return { state: 'refused', reason: 'synthetic-capture' }; } } as unknown as McpPort;
  const reader = createGoogleReader({ port, registry, config: { endpointId, account: 'synthetic', resource: 'synthetic', schemaDigest: digest, generation: 1, family: 'calendar_write' } });
  await reader.calendarCreateEvent({ summary: 'Synthetic work block', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z', clientRequestId: 'synthetic-action', timeZone: 'UTC', ...{ attendees: ['synthetic@example.com'], sendUpdates: 'all' } });
  assert.equal(calls.length, 1, 'must exercise actual connector dispatch');
  assert.equal(calls[0]?.toolName, 'calendar_create_event');
  assert.equal(calls[0]?.arguments.attendees, undefined);
  assert.equal(calls[0]?.arguments.sendUpdates, undefined);
  assert.equal(calls[0]?.arguments.send_updates, undefined);
  assert.equal(calls[0]?.arguments.summary, 'Synthetic work block');
});
