import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeContext, connectorGroupNames, toolGroupNames } from '../prompt/runtime-context.js';

test('the runtime context block is computed from a frozen clock and an explicit timezone', () => {
  const text = buildRuntimeContext({
    now: new Date('2026-10-14T12:35:00Z'), timeZone: 'Asia/Kolkata',
    connected: ['knowledge base', 'calendar'], unavailable: ['company knowledge'],
  });
  assert.equal(text, [
    '# Runtime context',
    '',
    'Now: Wed, 2026-10-14, 18:05 Asia/Kolkata (UTC+05:30)',
    'Today: 2026-10-14 (Wed). Tomorrow: 2026-10-15 (Thu). Yesterday: 2026-10-13 (Tue).',
    'This week: 2026-10-12T00:00:00+05:30 to 2026-10-18T23:59:59+05:30.',
    'Connected now: knowledge base, calendar.',
    'Not available: company knowledge.',
    'Naya can read and search; she cannot send anything to anyone.',
  ].join('\n'));
});

test('a DST boundary week carries each endpoint day’s own offset', () => {
  const text = buildRuntimeContext({ now: new Date('2026-03-26T12:00:00Z'), timeZone: 'Europe/Berlin', connected: [], unavailable: [] });
  assert.equal(text, [
    '# Runtime context',
    '',
    'Now: Thu, 2026-03-26, 13:00 Europe/Berlin (UTC+01:00)',
    'Today: 2026-03-26 (Thu). Tomorrow: 2026-03-27 (Fri). Yesterday: 2026-03-25 (Wed).',
    'This week: 2026-03-23T00:00:00+01:00 to 2026-03-29T23:59:59+02:00.',
    'Connected now: none.',
    'Not available: none.',
    'Naya can read and search; she cannot send anything to anyone.',
  ].join('\n'));
});

test('the runtime block carries only the named fields, never an owner line or private content', () => {
  const text = buildRuntimeContext({ now: new Date('2026-10-14T12:35:00Z'), timeZone: 'UTC', connected: ['mail'], unavailable: [] });
  const lines = text.split('\n').filter(line => line.length);
  for (const prefix of ['Now:', 'Today:', 'This week:', 'Connected now:', 'Not available:']) {
    assert.equal(lines.filter(line => line.startsWith(prefix)).length, 1, `exactly one ${prefix} line`);
  }
  assert.ok(!/^Owner:/m.test(text), 'no owner line');
  assert.ok(lines.every(line => line.startsWith('# Runtime context') || /^(Now|Today|This week|Connected now|Not available):/.test(line)
    || line === 'Naya can read and search; she cannot send anything to anyone.'));
});

test('tool and connector names map to the human group names', () => {
  assert.deepEqual(toolGroupNames(['search_knowledge', 'get_insight', 'gmail_list', 'gcal_list', 'mattermost_search', 'remember_note', 'search_mongoose']),
    ['knowledge base', 'mail', 'calendar', 'team chat', 'memory', 'company knowledge']);
  assert.deepEqual(connectorGroupNames('google'), ['calendar', 'mail']);
  assert.deepEqual(connectorGroupNames('mattermost'), ['team chat']);
  assert.deepEqual(connectorGroupNames('lux-knowledge'), ['knowledge base']);
  assert.deepEqual(connectorGroupNames('mongoose'), ['company knowledge']);
});
