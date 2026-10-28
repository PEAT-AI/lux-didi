import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeContext, connectorGroupNames, toolGroupNames, type ConnectorStateInput } from '../prompt/runtime-context.js';

test('the runtime context block is computed from a frozen clock and an explicit timezone', () => {
  const text = buildRuntimeContext({
    now: new Date('2026-10-14T12:35:00Z'), timeZone: 'Asia/Kolkata',
    connected: ['knowledge base', 'calendar'],
  });
  assert.equal(text, [
    '# Runtime context',
    '',
    'Now: Wed, 2026-10-14, 18:05 Asia/Kolkata (UTC+05:30)',
    'Today: 2026-10-14 (Wed). Tomorrow: 2026-10-15 (Thu). Yesterday: 2026-10-13 (Tue).',
    'This week: 2026-10-12T00:00:00+05:30 to 2026-10-18T23:59:59+05:30.',
    'Connected now: knowledge base, calendar.',
    'Naya can read and search; she cannot send anything to anyone.',
  ].join('\n'));
});

test('a DST boundary week carries each endpoint day’s own offset', () => {
  const text = buildRuntimeContext({ now: new Date('2026-03-26T12:00:00Z'), timeZone: 'Europe/Berlin', connected: [] });
  assert.equal(text, [
    '# Runtime context',
    '',
    'Now: Thu, 2026-03-26, 13:00 Europe/Berlin (UTC+01:00)',
    'Today: 2026-03-26 (Thu). Tomorrow: 2026-03-27 (Fri). Yesterday: 2026-03-25 (Wed).',
    'This week: 2026-03-23T00:00:00+01:00 to 2026-03-29T23:59:59+02:00.',
    'Connected now: none.',
    'Naya can read and search; she cannot send anything to anyone.',
  ].join('\n'));
});

test('the runtime block carries only the named fields, never an owner line or private content', () => {
  const text = buildRuntimeContext({ now: new Date('2026-10-14T12:35:00Z'), timeZone: 'UTC', connected: ['mail'],
    connectors: [{ connector: 'mongoose', state: 'connected' }] });
  const lines = text.split('\n').filter(line => line.length);
  for (const prefix of ['Now:', 'Today:', 'This week:', 'Connected now:', 'Connectors:']) {
    assert.equal(lines.filter(line => line.startsWith(prefix)).length, 1, `exactly one ${prefix} line`);
  }
  assert.ok(!/^Owner:/m.test(text), 'no owner line');
  assert.ok(lines.every(line => line.startsWith('# Runtime context') || /^(Now|Today|This week|Connected now|Connectors):/.test(line)
    || line === 'Naya can read and search; she cannot send anything to anyone.'));
});

test('W4: the runtime context carries one live connector line and the no-denial-without-a-check rule', () => {
  const text = buildRuntimeContext({ now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC', connected: ['company knowledge'],
    connectors: [
      { connector: 'mongoose', state: 'connected' },
      { connector: 'google', state: 'error', reasonCode: 'not_signed_in' },
      { connector: 'mattermost', state: 'error', configurationError: 'owner-approval-required' },
    ] });
  const lines = text.split('\n').filter(line => line.startsWith('Connectors:'));
  assert.equal(lines.length, 1, 'exactly one connector line');
  assert.equal(lines[0], 'Connectors: company knowledge connected; calendar not signed in; mail not signed in; team chat needs approval, and there is no approval control in the app: she cannot fix it from this call. Never deny or claim a sign-in or a capability without this line or a live tool check, and never name a place to change it that this line does not name.');
  const quiet = buildRuntimeContext({ now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC', connected: [] });
  assert.doesNotMatch(quiet, /^Connectors:/mu, 'no connector line without host rows');
});

test('C-CLAIMS9 outcome 2: an approval reason says there is no approval control in the app and names no place to fix it', () => {
  const text = buildRuntimeContext({ now: new Date('2026-10-28T10:21:00Z'), timeZone: 'UTC', connected: [],
    connectors: [{ connector: 'mattermost', state: 'error', configurationError: 'owner-approval-required' }] });
  assert.match(text, /^Connectors: team chat needs approval, and there is no approval control in the app: she cannot fix it from this call\./mu,
    'the closed reason is said in plain words with the fact that she cannot act on it');
  assert.doesNotMatch(text, /settings|preferences|dashboard|control panel/iu, 'no settings location is named in the line');
  assert.match(text, /never name a place to change it that this line does not name/u, 'and her guidance forbids inventing one');
});

test('C-CLAIMS9 outcome 2: a connector the host reports as not connected says so in plain words', () => {
  const text = buildRuntimeContext({ now: new Date('2026-10-28T10:21:00Z'), timeZone: 'UTC', connected: [],
    connectors: [{ connector: 'mattermost', state: 'error', reasonCode: 'not_connected' }] });
  assert.match(text, /^Connectors: team chat not connected\./mu, 'the closed reason is said in plain words');
});

test('W4: every credential or identity code the host reports reads as a sign-in, not as plain unavailability', () => {
  const line = (row: ConnectorStateInput): string =>
    buildRuntimeContext({ now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC', connected: [], connectors: [row] })
      .split('\n').find(entry => entry.startsWith('Connectors:'))!;
  const mongoose = (named: { reasonCode?: string; error?: string }): ConnectorStateInput => ({ connector: 'mongoose', state: 'error', ...named });
  for (const reasonCode of ['credential_missing', 'credential-missing', 'credential-unavailable', 'credential-identity-mismatch',
    'credential-identity-unverified', 'identity_mismatch', 'needs_sign_in', 'not_signed_in']) {
    assert.match(line(mongoose({ reasonCode })), /^Connectors: company knowledge not signed in\./u,
      `the host's own sign-in code reads as a sign-in: ${reasonCode}`);
  }
  assert.match(line(mongoose({ error: 'credential-identity-mismatch' })), /not signed in/u, 'the error field carries the same code');
  for (const reasonCode of ['unreachable', 'transport_unavailable', 'discovery_failed', 'handshake_failed']) {
    assert.match(line(mongoose({ reasonCode })), /^Connectors: company knowledge unavailable\./u,
      `a transport failure is not a sign-in: ${reasonCode}`);
  }
});

test('tool and connector names map to the human group names', () => {
  assert.deepEqual(toolGroupNames(['search_knowledge', 'get_insight', 'gmail_search_messages', 'calendar_list_events', 'mattermost_search', 'remember_note', 'search_mongoose']),
    ['knowledge base', 'mail', 'calendar', 'team chat', 'memory', 'company knowledge']);
  assert.deepEqual(connectorGroupNames('google'), ['calendar', 'mail']);
  assert.deepEqual(connectorGroupNames('mattermost'), ['team chat']);
  assert.deepEqual(connectorGroupNames('lux-knowledge'), ['knowledge base']);
  assert.deepEqual(connectorGroupNames('mongoose'), ['company knowledge']);
});

test('L8-10: a session that can search the web names it among what it can reach', () => {
  assert.deepEqual(toolGroupNames(['search_knowledge', 'gmail_search_messages', 'remember_note', 'web_search']), ['knowledge base', 'mail', 'memory', 'web search']);
  assert.deepEqual(toolGroupNames(['search_knowledge']), ['knowledge base'], 'no web group without the web read');
});

test('C-LUXSAVE11: Runtime context never duplicates the generated save capability', () => {
  for (const vault of [{ dictation: true, composed: false }, { dictation: true, composed: true }, { dictation: false, composed: false }]) {
    assert.doesNotMatch(buildRuntimeContext({ ...base, vault }), /^Vault:/mu);
  }
});

 test('C-CONVO9: refused connector is absent from Connected now', () => {
  const text = buildRuntimeContext({ now: new Date('2026-01-01T00:00:00Z'), timeZone: 'UTC', connected: ['team chat', 'web search'],
    connectors: [{ connector: 'mattermost', state: 'refused', reasonCode: 'owner-approval-required' }] });
  assert.equal(text.split('\n').find(line => line.startsWith('Connected now:')), 'Connected now: web search.');
  assert.match(text, /team chat needs approval/);
});
