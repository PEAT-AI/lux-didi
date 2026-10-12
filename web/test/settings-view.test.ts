import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorState, limitMinutes, settingsMarkup } from '../src/settings-view.ts';

const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};

const live = {
  service: 'live', status: 'configured', provider: 'gemini',
  model: 'models/gemini-live', voice: 'Aoede',
  limits: { sessionMs: 900000, idleMs: 60000 },
};

const connections = [
  { id: 'knowledge', state: 'connected', tools: 4, lastHandshakeAt: '2026-10-12T14:52:00Z', reasonCode: null },
  { id: 'gmail', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'credential_missing' },
  { id: 'maps', state: 'configured', tools: 2, lastHandshakeAt: null, reasonCode: null },
  { id: 'calendar', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'unreachable' },
];

test('renders model, voice, persona and limits from route fixture payloads', () => {
  const html = settingsMarkup({ status, live, connections });
  assert.match(html, /models\/gemini-live/);
  assert.match(html, /Aoede/);
  assert.match(html, /Naya/);
  assert.match(html, /gemini gemini-2\.5/);
  assert.match(html, /15 min/);
  assert.match(html, /1 min/);
});

test('maps each connector state to its sentence and one-line next step', () => {
  assert.deepEqual(connectorState(connections[0]), { id: 'knowledge', state: 'Connected', next: 'no action needed' });
  assert.deepEqual(connectorState(connections[2]), { id: 'maps', state: 'Configured', next: 'a Live session connects on demand' });
  assert.equal(connectorState(connections[1])?.state, 'Credential missing');
  assert.match(connectorState(connections[1])!.next, /credential file under provider-config/);
  assert.equal(connectorState(connections[3])?.state, 'Failed');
  assert.match(connectorState(connections[3])!.next, /start the service/);
  const html = settingsMarkup({ status, connections });
  for (const label of ['Connected', 'Configured', 'Credential missing', 'Failed']) assert.match(html, new RegExp(label));
});

test('renders limits in whole minutes and rejects unsafe values', () => {
  assert.equal(limitMinutes(900000), '15 min');
  assert.equal(limitMinutes(60000), '1 min');
  assert.equal(limitMinutes(0), '0 min');
  assert.equal(limitMinutes(undefined), undefined);
  assert.equal(limitMinutes(-1), undefined);
  assert.equal(limitMinutes(1.5), undefined);
  assert.equal(limitMinutes('900000'), undefined);
});

test('never renders a secret-looking field the whitelist does not name', () => {
  const html = settingsMarkup({
    status: { ...status, authorityEpoch: 'PRIVATE-EPOCH', ownerProfile: { displayName: 'Naya', apiKey: 'sk-secret' } },
    live: { ...live, keyReference: 'PRIVATE-KEY-REF', profileIdentity: 'PRIVATE-IDENTITY' },
    connections: [{ id: 'gmail', state: 'connected', token: 'PRIVATE TOKEN', config: { secret: 'PRIVATE CONFIG' } }],
  });
  assert.doesNotMatch(html, /PRIVATE|sk-secret|PRIVATE TOKEN|PRIVATE CONFIG/);
  assert.match(html, /Naya/);
});

test('a failed route shows unavailable, never stale values', () => {
  const html = settingsMarkup({ status, connections, statusUnavailable: true, connectionsUnavailable: true });
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /Naya|gemini-2\.5|knowledge|gmail|maps|calendar/);
});

test('marks every on-disk setting with its file name and a restart note', () => {
  const html = settingsMarkup({ status, connections });
  for (const file of ['live.json', 'profile.json', 'gemini-primary.json', 'provider-config/mcp.json']) assert.match(html, new RegExp(file.replace('.', '\\.')));
  assert.match(html, /need a restart of Lux Didi/);
});

test('an unconfigured Live service does not invent model or voice', () => {
  const html = settingsMarkup({ status, connections, live: { service: 'live', status: 'unconfigured' } });
  assert.doesNotMatch(html, /Aoede|gemini-live/);
  assert.match(html, /Unavailable/);
});
