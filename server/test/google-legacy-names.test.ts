/**
 * C-DEPTH11, W16-R1 F1: the durable pre-rename names. A stored connection policy that still names the old
 * Google read tools (gcal_calendars, gcal_list) was refused whole as `invalid_read_tools`, so every calendar
 * read in that session failed before any dispatch. The owner now resolves those names to the current tools,
 * and anything outside the connector envelope is still refused.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePolicy } from '../tools/index.js';
import type { ConnectionPolicy } from '../tools/types.js';

const stored: ConnectionPolicy = {
  schemaVersion: 1, ownerId: 'owner-fixture', connectionId: 'calendar', generation: 2, enabled: true, connector: 'google',
  endpoint: { id: 'calendar', url: 'https://helper.example.invalid/mcp', account: 'owner@example.invalid', resource: 'calendar', credentialRef: null },
  toolNames: ['gcal_calendars', 'gcal_list'],
  schemaDigest: 'a'.repeat(64),
  sourcePolicy: { id: 'google-read', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
  route: { identity: 'voice', allowedClasses: ['private'] },
  bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 },
} as ConnectionPolicy;

test('C-DEPTH11: a stored policy that still names the pre-rename calendar tools is resolved, never refused whole', () => {
  const policy = validatePolicy(stored);
  assert.deepEqual([...policy.toolNames].sort(), ['calendar_list_calendars', 'calendar_list_events'], 'the old names resolve to the current ones');
  assert.deepEqual([...stored.toolNames], ['gcal_calendars', 'gcal_list'], 'and the caller input is not mutated');
});

test('C-DEPTH11: the envelope still closes on a name no rename explains', () => {
  assert.throws(() => validatePolicy({ ...stored, toolNames: ['gcal_list', 'calendar_create_event'] }), /invalid_read_tools|invalid/u, 'a writer or an unknown name is still refused');
});
