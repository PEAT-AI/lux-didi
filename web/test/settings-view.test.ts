import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorState, limitMinutes, settingsMarkup } from '../src/settings-view.ts';

const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};

const summary = {
  modelId: 'models/gemini-live', voice: 'Aoede', personaName: 'Naya',
  limits: { sessionMs: 900000, idleMs: 60000 }, profileEnabled: true,
};

const connections = [
  { id: 'knowledge', state: 'connected', tools: 4, lastHandshakeAt: '2026-10-12T14:52:00Z', reasonCode: null },
  { id: 'gmail', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'credential_missing' },
  { id: 'maps', state: 'configured', tools: 2, lastHandshakeAt: null, reasonCode: null },
  { id: 'calendar', state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'unreachable' },
];

test('renders the Live model, voice, persona and limits from the summary payload', () => {
  const html = settingsMarkup({ status, summary, connections });
  assert.match(html, /Live model<\/dt><dd>models\/gemini-live/);
  assert.match(html, /Live voice<\/dt><dd>Aoede/);
  assert.match(html, /Persona name<\/dt><dd>Naya/);
  assert.match(html, /Session limit<\/dt><dd>15 min/);
  assert.match(html, /Idle limit<\/dt><dd>1 min/);
});

test('profileEnabled false shows the Live profile disabled note, never invented values', () => {
  const html = settingsMarkup({ status, connections, summary: { modelId: null, voice: null, personaName: null, limits: null, profileEnabled: false } });
  assert.match(html, /Live profile disabled/);
  assert.doesNotMatch(html, /Aoede|gemini-live/);
});

test('a failed summary shows Unavailable for the Live rows and leaves the connectors intact', () => {
  const html = settingsMarkup({ status, connections, summaryUnavailable: true });
  assert.match(html, /Live model<\/dt><dd><span class="settings-unavailable">Unavailable/);
  assert.match(html, /Session limit<\/dt><dd><span class="settings-unavailable">Unavailable/);
  assert.match(html, /knowledge/);
  assert.match(html, /Credential missing/);
});

test('a summary persona still shows when the status route fails', () => {
  const html = settingsMarkup({ statusUnavailable: true, summary, connections });
  assert.match(html, /Persona name<\/dt><dd>Naya/);
  assert.match(html, /Text chat and research model<\/dt><dd><span class="settings-unavailable">Unavailable/);
});

test('maps each connector state to its sentence and one-line next step', () => {
  assert.deepEqual(connectorState(connections[0]), { id: 'knowledge', state: 'Connected', next: 'no action needed' });
  assert.deepEqual(connectorState(connections[2]), { id: 'maps', state: 'Configured', next: 'a Live session connects on demand' });
  assert.equal(connectorState(connections[1])?.state, 'Credential missing');
  assert.match(connectorState(connections[1])!.next, /explicitly selected protected configuration directory/);
  assert.equal(connectorState(connections[3])?.state, 'Failed');
  assert.match(connectorState(connections[3])!.next, /Copy diagnostics/);
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
    summary: { ...summary, keyReference: 'PRIVATE-KEY-REF', profileIdentity: 'PRIVATE-IDENTITY' },
    connections: [{ id: 'gmail', state: 'connected', token: 'PRIVATE TOKEN', config: { secret: 'PRIVATE CONFIG' } }],
  });
  assert.doesNotMatch(html, /PRIVATE|sk-secret|PRIVATE TOKEN|PRIVATE CONFIG/);
  assert.match(html, /Naya/);
});

test('marks every on-disk setting with its file name and a restart note', () => {
  const html = settingsMarkup({ status, connections });
  for (const file of ['live.json', 'profile.json', 'gemini-primary.json', 'provider-config/mcp.json']) assert.match(html, new RegExp(file.replace('.', '\\.')));
  assert.match(html, /need a restart of Lux Didi/);
});

test('connector-specific setup instructions render safely', () => {
  const html = settingsMarkup({ connections: [
    { id: 'calendar', state: 'missing', reasonCode: 'credential_missing' },
    { id: 'mongoose', state: 'missing', reasonCode: 'credential_missing' },
    { id: 'gmail', state: 'error', reasonCode: 'unreachable' },
  ] });
  assert.match(html, /explicitly selected protected configuration directory/);
  assert.equal(html.includes("Copy command"), false);
  assert.match(html, /docs\/user-guide.md/);
  assert.match(html, /Copy diagnostics/);
});

test('settings view puts each section heading in its own section for vertical rhythm', () => {
  const html = settingsMarkup({ status, connections });
  assert.match(html, /<section class="settings-section"><h3>Connectors<\/h3>/);
  assert.match(html, /<section class="settings-section">\s*<h3>Where these settings live<\/h3>/);
});

test('connected settings render the stay-connected switch and connected history from input', () => {
  const html = settingsMarkup({ connected: { remember: true, conversations: [{ title: 'Naya connected conversation', sessionId: 'S1', model: 'gemini-2.5', state: 'active' }], standingRevoke: true, conversationState: 'active' } });
  assert.match(html, /id="connected-remember"[^>]*checked/);
  assert.match(html, /Keep Naya’s text conversations across sessions/);
  assert.match(html, /id="connected-history"/);
  assert.match(html, /Naya connected conversation/);
  assert.match(html, /id="connected-recover"/);
  assert.match(html, /id="connected-standing-revoke"/);
  assert.match(html, /id="connected-revoke"/);
});

test('connected history is absent when no connected state is supplied', () => {
  assert.doesNotMatch(settingsMarkup({ status }), /connected-history/);
});

test('connected history marks the active conversation selected and only that one', () => {
  const html = settingsMarkup({ connected: { remember: true, conversations: [
    { title: 'Native B', sessionId: 'S2', model: 'gemini-connected-test', state: 'active' },
    { title: 'Native A', sessionId: 'S1', model: 'gemini-connected-test', state: 'active', active: true },
  ] } });
  assert.match(html, /<option value="S2" >/);
  assert.match(html, /<option value="S1" selected>/);
});

test('the Live provider switch offers OpenAI first, keeps Gemini selectable and states when it applies', () => {
  const html = settingsMarkup({ summary: { ...summary, provider: 'gemini' } });
  const options = [...html.matchAll(/<option value="([a-z]+)"[^>]*>([^<]+)<\/option>/g)]
    .filter(match => ['openai', 'gemini'].includes(match[1]!));
  assert.deepEqual(options.map(match => match[1]), ['openai', 'gemini'], 'OpenAI leads, Gemini stays selectable');
  assert.deepEqual(options.map(match => match[2]), ['OpenAI GPT-Live', 'Gemini 3.8 Live']);
  assert.equal(options.filter(match => match[0].includes('selected')).length, 1, 'exactly one provider is selected');
  assert.ok(options[1]![0].includes('selected'), 'the current provider is the selected one');
  assert.ok(html.includes('id="live-settings-form"'), 'the switch is a form the page can submit');
  assert.ok(html.includes('name="provider"') && html.includes('name="voice"'));
  assert.ok(html.includes('applies when Lux Didi next starts'), 'the page states when the choice applies');
  assert.ok(html.includes('<dt>Live provider</dt><dd>Gemini 3.8 Live</dd>'), 'the active provider is named');
});

test('a live.json that names no provider shows the OpenAI default and never interpolates a raw value', () => {
  const html = settingsMarkup({ summary: { ...summary, provider: null, voice: null } });
  assert.ok(html.includes('<dt>Live provider</dt><dd><span class="settings-unavailable">Unavailable</span></dd>'));
  const selected = /<option value="openai" selected>/.test(html);
  assert.equal(selected, true, 'the first switch option is the owner default');
  const hostile = settingsMarkup({ summary: { ...summary, provider: '<script>alert(1)</script>', voice: '"><img src=x>' } });
  assert.equal(hostile.includes('<script>alert(1)</script>'), false);
  assert.equal(hostile.includes('<img src=x>'), false);
});

test('the OpenAI voice list is the gpt-live-1 table in its own order, marin first, with no Realtime voice', () => {
  const html = settingsMarkup({ summary: { ...summary, provider: 'openai', voice: 'marin' } });
  const list = html.slice(html.indexOf('<datalist id="live-voices">'), html.indexOf('</datalist>'));
  const voices = [...list.matchAll(/<option value="([a-z]+)"><\/option>/g)].map(match => match[1]!);
  // OV1-R6: exactly this order; cedar is a Realtime voice and nira never appears.
  assert.deepEqual(voices, ['marin', 'vesper', 'ripple', 'willow', 'gleam', 'meridian', 'stone', 'quartz', 'beacon', 'delta', 'cinder']);
  assert.equal(voices[0], 'marin', 'marin is the default and comes first');
  assert.equal(voices.includes('cedar'), false);
  assert.equal(voices.includes('nira'), false);
  assert.equal(html.includes('"marin" selected') || html.includes('value="marin"'), true);
  // Gemini keeps its own list.
  const gemini = settingsMarkup({ summary: { ...summary, provider: 'gemini', voice: 'Aoede' } });
  const geminiList = gemini.slice(gemini.indexOf('<datalist'), gemini.indexOf('</datalist>'));
  assert.deepEqual([...geminiList.matchAll(/<option value="([A-Za-z]+)"><\/option>/g)].map(match => match[1]), ['Aoede']);
});
