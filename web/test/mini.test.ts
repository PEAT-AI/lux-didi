import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isMiniRoute, miniMarkup, miniModeButtonMarkup, miniState } from '../src/mini.ts';

test('the mini route is a query on the one built page', () => {
  assert.equal(isMiniRoute('?view=mini'), true);
  assert.equal(isMiniRoute(''), false);
  assert.equal(isMiniRoute('?view=full'), false);
  assert.equal(isMiniRoute('?something=1&view=mini'), true);
});

test('one glance state folds voice and tool activity, error wins', () => {
  assert.equal(miniState('LISTENING', undefined), 'listening');
  assert.equal(miniState('CONNECTING', undefined), 'thinking');
  assert.equal(miniState('SPEAKING', undefined), 'speaking');
  assert.equal(miniState('PROCESSING', { kind: 'tools', text: 'Searching your mail' }), 'tool');
  assert.equal(miniState('CONNECTED', { kind: 'thinking', text: 'Thinking' }), 'thinking');
  assert.equal(miniState('ERROR', { kind: 'tools', text: 'x' }), 'error');
  assert.equal(miniState('CONNECTED', undefined), 'idle');
});

test('mini markup is orb-only with the shared caption and no transcript', () => {
  const caption = '<p class="orb-label">Listening</p><p class="activity-line">Searching your mail</p>';
  const html = miniMarkup('tool', caption);
  assert.match(html, /id="didi-orb"/);
  assert.match(html, /class="orb-stage mini-stage"/);
  assert.match(html, /data-mini-state="tool"/);
  assert.ok(html.includes(caption));
  assert.doesNotMatch(html, /conversation-history|data-tab|voice-text|draft|transcript|sidebar/i);
});

test('mini markup carries each glance state and only glows while active', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'tool', 'error'] as const) {
    assert.match(miniMarkup(state, ''), new RegExp(`data-mini-state="${state}"`));
  }
  assert.match(miniMarkup('speaking', ''), /presence-glow visible/);
  assert.match(miniMarkup('idle', ''), /presence-glow"/);
  assert.doesNotMatch(miniMarkup('error', ''), /presence-glow visible/);
});

test('the FULL window offers one visible, labelled mode button', () => {
  assert.equal(miniModeButtonMarkup(false), '', 'a browser shell has no native surface to move');
  const markup = miniModeButtonMarkup(true);
  assert.match(markup, /^<button id="mini-mode"/, 'the button is a real control, not a link');
  assert.match(markup, /aria-label="Show the mini orb"/, 'the button carries an accessible label');
  assert.match(markup, />mini</, 'the visible label is mini');
});

test('the mini route renders no control, no audio element and no text field', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'tool', 'error'] as const) {
    const markup = miniMarkup(state, 'Listening');
    for (const forbidden of ['<button', '<input', '<textarea', '<audio', '<video', 'href=', 'contenteditable']) {
      assert.equal(markup.includes(forbidden), false, `the mini stage must not render ${forbidden}`);
    }
  }
});

test('the mini route opens no audio context, no microphone and no Live socket', () => {
  // A source guard: the compact route is presentation only, so it cannot reach
  // the voice or Live paths even by accident.
  const source = readFileSync(new URL('../src/mini.ts', import.meta.url), 'utf8');
  for (const forbidden of ['AudioContext', 'getUserMedia', 'mediaDevices', 'MediaRecorder', 'RTCPeerConnection', 'WebSocket', 'fetch(', 'EventSource', "from './api'"]) {
    assert.equal(source.includes(forbidden), false, `mini.ts must not reference ${forbidden}`);
  }
  const imports = source.split('\n').filter((line) => line.startsWith('import '));
  assert.ok(imports.length > 0, 'the mini route still names the types it renders');
  assert.ok(imports.every((line) => line.startsWith('import type ')), 'every mini route import is type only, so no runtime module reaches it');
  // A runtime guard: painting the mini route constructs no audio or Live
  // transport, so the surface cannot open a session of its own.
  const touched: string[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  // navigator is a getter-only global here, so the microphone guard above (the
  // source scan for getUserMedia and mediaDevices) is the one that covers it.
  const names = ['AudioContext', 'webkitAudioContext', 'WebSocket', 'EventSource', 'RTCPeerConnection'];
  const saved = names.map((name) => [name, globals[name]] as const);
  for (const name of names) {
    globals[name] = function Forbidden(this: unknown) { touched.push(name); throw new Error(`${name} must not be opened by the mini route`); };
  }
  try {
    miniMarkup(miniState('LISTENING', undefined), 'Listening');
    miniModeButtonMarkup(true);
  } finally {
    for (const [name, value] of saved) globals[name] = value;
  }
  assert.deepEqual(touched, [], 'the mini route opened no audio or Live transport');
});
