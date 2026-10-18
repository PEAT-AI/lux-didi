import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  connectorState, limitMinutes, micModeLabel, micModePicker, micModePromptMarkup, micModeRow, micModeState,
  settingsMarkup, MIC_MODE_SENTENCE, type MicModeMessage,
} from '../src/settings-view.ts';

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
  // OV1-R6: exactly this order; cedar is a Realtime voice and is absent. nira, the documented Hindi
  // voice, joins the list last in PV2.
  assert.deepEqual(voices, ['marin', 'vesper', 'ripple', 'willow', 'gleam', 'meridian', 'stone', 'quartz', 'beacon', 'delta', 'cinder', 'nira']);
  assert.equal(voices[0], 'marin', 'marin is the default and comes first');
  assert.equal(voices.includes('cedar'), false);
  assert.equal(voices.includes('nira'), true);
  assert.equal(html.includes('"marin" selected') || html.includes('value="marin"'), true);
  // Gemini keeps its own list.
  const gemini = settingsMarkup({ summary: { ...summary, provider: 'gemini', voice: 'Aoede' } });
  const geminiList = gemini.slice(gemini.indexOf('<datalist'), gemini.indexOf('</datalist>'));
  assert.deepEqual([...geminiList.matchAll(/<option value="([A-Za-z]+)"><\/option>/g)].map(match => match[1]), ['Aoede']);
});

test('PV2: a stored custom voice id shows as "Custom voice" plus the id, and a preset never does', () => {
  const custom = 'voice_0123456789abcdef';
  const html = settingsMarkup({ status, summary: { ...summary, provider: 'openai', voice: custom } });
  const input = html.slice(html.indexOf('id="live-voice"'), html.indexOf('>', html.indexOf('id="live-voice"')));
  assert.ok(input.includes(`value="${custom}"`), 'the whole id is the switch value, never truncated away');
  assert.ok(html.includes(`Custom voice: <code>${custom}</code>`), 'the label names it a custom voice and shows the id');
  const list = html.slice(html.indexOf('<datalist id="live-voices">'), html.indexOf('</datalist>'));
  assert.ok(list.includes(`<option value="${custom}">Custom voice</option>`), 'the picker offers it as a custom voice');
  const preset = settingsMarkup({ status, summary: { ...summary, provider: 'openai', voice: 'nira' } });
  assert.equal(preset.includes('Custom voice'), false, 'a preset is never labelled a custom voice');
});

test('PV1: the Accent row renders the three choices and selects the running one', () => {
  const html = settingsMarkup({ status, summary: { ...summary, accent: 'indian-light' } });
  assert.match(html, /<dt>Accent for the next call<\/dt><dd>Indian English, light<\/dd>/, 'the row says which call it describes');
  const at = html.indexOf('id="live-accent"');
  assert.ok(at > 0, 'the accent select is in the switch form');
  const select = html.slice(at, html.indexOf('</select>', at));
  assert.deepEqual([...select.matchAll(/<option value="([a-z-]+)"/g)].map(match => match[1]), ['indian-strong', 'indian-light', 'voice-default']);
  assert.match(select, /<option value="indian-light" selected>/);
});

test('PV1: an absent accent shows the default choice, never a blank select', () => {
  const html = settingsMarkup({ status, summary });
  const at = html.indexOf('id="live-accent"');
  const select = html.slice(at, html.indexOf('</select>', at));
  assert.match(select, /<option value="indian-strong" selected>/);
  assert.match(html, /<dt>Accent for the next call<\/dt><dd><span class="settings-unavailable">Unavailable<\/span><\/dd>/);
});

test('PV1: a saved accent that differs from the running one shows a pending notice', () => {
  const html = settingsMarkup({ status, summary: { ...summary, accent: 'indian-strong' },
    saved: { provider: 'gemini', voice: 'Aoede', accent: 'indian-light', appliesAt: 'next_start' } });
  assert.match(html, /Saved: gemini\/Aoede, accent Indian English, light, applies on next start/);
  const running = { ...summary, provider: 'gemini', voice: 'Aoede', accent: 'indian-light' };
  const same = settingsMarkup({ status, summary: running, saved: { provider: 'gemini', voice: 'Aoede', accent: 'indian-light', appliesAt: 'next_start' } });
  assert.doesNotMatch(same, /Saved: /, 'the same selection is not a pending change');
});

test('#352: the one line appears only when native says so, once, and its button asks for the picker', () => {
  assert.equal(micModePromptMarkup(false), '', 'nothing at all when the bridge withholds it');
  const html = micModePromptMarkup(true);
  assert.equal(html.split(MIC_MODE_SENTENCE).length - 1, 1, 'the sentence appears exactly once');
  assert.equal(html.split('data-mic-mode="picker"').length - 1, 1, 'one button, not two');
  assert.match(html, /id="mic-mode-dismiss"/, 'the line is dismissible');
  const sent: MicModeMessage[] = [];
  micModePicker(message => sent.push(message));
  assert.deepEqual(sent, [{ type: 'showMicrophoneModes' }], 'the button sends the bridge picker request');
  micModePicker(undefined);
});

test('#352: the settings row is read-only and carries the same button', () => {
  assert.equal(micModeLabel('voiceIsolation'), 'Voice Isolation');
  assert.equal(micModeLabel(undefined), 'Unknown');
  const row = micModeRow({ preferred: 'wideSpectrum', active: 'wideSpectrum' });
  assert.match(row, /<dt>Mic Mode<\/dt><dd>Wide Spectrum\./);
  assert.match(row, /data-mic-mode="picker"/);
  assert.doesNotMatch(row, /<select|<input/, 'no control here changes a mode');
  const html = settingsMarkup({ status, summary, micMode: { preferred: 'standard', active: 'voiceIsolation' } });
  assert.match(html, /<dt>Mic Mode<\/dt><dd>Voice Isolation\./);
  assert.match(settingsMarkup({ status, summary }), /<dt>Mic Mode<\/dt><dd>Unknown\./);
});

test('#352: only the native mic mode messages carry a mode, and Voice Isolation never prompts', () => {
  assert.equal(micModeState({ type: 'liveState', state: 'idle' }), undefined);
  assert.equal(micModeState(undefined), undefined);
  assert.deepEqual(micModeState({ type: 'micMode', preferred: 'standard', active: 'standard', prompt: true }),
    { preferred: 'standard', active: 'standard', prompt: true });
  assert.deepEqual(micModeState({ type: 'hydrate', micMode: { preferred: 'standard', active: 'voiceIsolation' } }),
    { preferred: 'standard', active: 'voiceIsolation', prompt: false }, 'a reload never prompts');
  assert.deepEqual(micModeState({ type: 'micMode', preferred: 'voiceIsolation', active: 'voiceIsolation', prompt: true }),
    { preferred: 'voiceIsolation', active: 'voiceIsolation', prompt: false }, 'Voice Isolation is never prompted');
});
