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
    'Days: 2026-10-11 (Sun), 2026-10-12 (Mon), 2026-10-13 (Tue), 2026-10-14 (Wed, today), 2026-10-15 (Thu), 2026-10-16 (Fri), 2026-10-17 (Sat).',
    'Connected now: knowledge base, calendar.',
    'Naya can read and search, and make the owner-only writes her tools offer: alarms, calendar blocks, unsent drafts, notes and board cards. She cannot send anything to anyone, invite anyone or answer an invitation.',
  ].join('\n'));
});

test('a DST boundary week still names every day three back and three ahead', () => {
  const text = buildRuntimeContext({ now: new Date('2026-03-26T12:00:00Z'), timeZone: 'Europe/Berlin', connected: [] });
  assert.equal(text, [
    '# Runtime context',
    '',
    'Now: Thu, 2026-03-26, 13:00 Europe/Berlin (UTC+01:00)',
    'Days: 2026-03-23 (Mon), 2026-03-24 (Tue), 2026-03-25 (Wed), 2026-03-26 (Thu, today), 2026-03-27 (Fri), 2026-03-28 (Sat), 2026-03-29 (Sun).',
    'Connected now: none.',
    'Naya can read and search, and make the owner-only writes her tools offer: alarms, calendar blocks, unsent drafts, notes and board cards. She cannot send anything to anyone, invite anyone or answer an invitation.',
  ].join('\n'));
});

test('the runtime block carries only the named fields, never an owner line or private content', () => {
  const text = buildRuntimeContext({ now: new Date('2026-10-14T12:35:00Z'), timeZone: 'UTC', connected: ['mail'],
    connectors: [{ connector: 'mongoose', state: 'connected' }] });
  const lines = text.split('\n').filter(line => line.length);
  for (const prefix of ['Now:', 'Days:', 'Connected now:', 'Connectors:']) {
    assert.equal(lines.filter(line => line.startsWith(prefix)).length, 1, `exactly one ${prefix} line`);
  }
  assert.ok(!/^Owner:/m.test(text), 'no owner line');
  assert.ok(lines.every(line => line.startsWith('# Runtime context') || /^(Now|Days|Connected now|Connectors):/.test(line)
    || line === 'Naya can read and search, and make the owner-only writes her tools offer: alarms, calendar blocks, unsent drafts, notes and board cards. She cannot send anything to anyone, invite anyone or answer an invitation.'));
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
  assert.deepEqual(toolGroupNames(['search_insights', 'get_insight', 'gmail_search_messages', 'calendar_list_events', 'mattermost_search', 'remember_note', 'search']),
    ['his private notes', 'mail', 'calendar', 'team chat', 'memory', 'company knowledge']);
  assert.deepEqual(connectorGroupNames('google'), ['calendar', 'mail']);
  assert.deepEqual(connectorGroupNames('mattermost'), ['team chat']);
  assert.deepEqual(connectorGroupNames('lux-knowledge'), ['his private notes'], 'the owner\'s own notes, not a second knowledge base');
  assert.deepEqual(connectorGroupNames('mongoose'), ['company knowledge']);
});

test('#623: the mongoose reads are grouped by the endpoint that serves them, so company knowledge is named', () => {
  // The served names themselves, not a retired prefix: search and read are the knowledge endpoint's own.
  assert.deepEqual(toolGroupNames(['search', 'read', 'search_insights']), ['company knowledge', 'his private notes']);
  assert.deepEqual(toolGroupNames(['ask_data_agent', 'data_agent_job']), ['company numbers'],
    'the numbers endpoint is company numbers, never company knowledge');
  assert.deepEqual(toolGroupNames(['get_company', 'list_inbound_leads']), ['customers']);
  for (const retired of ['ask_mongoose', 'search_mongoose', 'get_knowledge_item', 'read_knowledge_body']) {
    assert.deepEqual(toolGroupNames([retired]), [], `a retired name groups nothing: ${retired}`);
  }
  assert.match(toolGroupNames(['list_companies']).join(', '), /company knowledge/u, 'a company listing is company knowledge');
});

test('L8-10: a session that can search the web names it among what it can reach', () => {
  assert.deepEqual(toolGroupNames(['search_insights', 'gmail_search_messages', 'remember_note', 'web_search']), ['his private notes', 'mail', 'memory', 'web search']);
  assert.deepEqual(toolGroupNames(['search_insights']), ['his private notes'], 'no web group without the web read');
});

test('C-LUXSAVE11: Runtime context never duplicates the generated save capability', () => {
  const base = { now: new Date('2026-10-14T12:35:00Z'), timeZone: 'UTC', connected: [] };
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

 test('C-CONVO9: refused connector is absent from Connected now', () => {
  const text = buildRuntimeContext({ now: new Date('2026-01-01T00:00:00Z'), timeZone: 'UTC', connected: ['team chat', 'web search'],
    connectors: [{ connector: 'mattermost', state: 'refused', reasonCode: 'owner-approval-required' }] });
  assert.equal(text.split('\n').find(line => line.startsWith('Connected now:')), 'Connected now: web search.');
  assert.match(text, /team chat needs approval/);
});

test('a Trello read or write names the board group, so a declared board is never read as not connected', () => {
  assert.deepEqual(toolGroupNames(['trello_read', 'trello_write']), ['Trello board']);
  assert.ok(!toolGroupNames(['search_insights', 'trello_read']).some(group => /Rob/u.test(group)), 'no owner name in a public group label');
});

test('M2: the 2026-11-06 call reads the owner morning, never the UTC hour she said', () => {
  const said = new Date('2026-11-05T23:45:58Z');
  const owner = buildRuntimeContext({ now: said, timeZone: 'Asia/Jakarta', connected: [] });
  const [now] = owner.split('\n').filter(line => line.startsWith('Now:'));
  assert.equal(now, 'Now: Fri, 2026-11-06, 06:45 Asia/Jakarta (UTC+07:00)');
  assert.doesNotMatch(owner, /23:45/u, 'the UTC hour she reported must never reach her');
  assert.match(owner, /2026-11-06 \(Fri, today\)/u, 'the table marks her own day');
  assert.match(owner, /2026-11-03 \(Tue\).*2026-11-09 \(Mon\)/u, 'three days back and three ahead');
});

test('M2: an override zone moves the same instant to that owner day', () => {
  const said = new Date('2026-11-05T23:45:58Z');
  const [now] = buildRuntimeContext({ now: said, timeZone: 'Europe/Berlin', connected: [] })
    .split('\n').filter(line => line.startsWith('Now:'));
  assert.equal(now, 'Now: Fri, 2026-11-06, 00:45 Europe/Berlin (UTC+01:00)');
});

test('M2: every prompt opens with exactly one Now line, and days never count past seven', () => {
  const text = buildRuntimeContext({ now: new Date('2026-11-05T23:45:58Z'), timeZone: 'Asia/Jakarta', connected: ['calendar'] });
  assert.equal(text.split('Now:').length - 1, 1, 'one line per prompt');
  const days = text.split('\n').find(line => line.startsWith('Days:'))!;
  assert.equal(days.replace(/^Days: /u, '').replace(/\.$/u, '').split(', 2026').length, 7, 'seven days');
});
