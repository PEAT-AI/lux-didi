import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { installMiniMeter, isMiniRoute, miniBarHeights, miniMarkup, miniMeter, miniModeButtonMarkup, miniState, type PillLevelHost } from '../src/mini.ts';
import { singleKeyRow, singleKeyState } from '../src/settings-view.ts';

test('the mini route is a query on the one built page', () => {
  assert.equal(isMiniRoute('?view=mini'), true);
  assert.equal(isMiniRoute(''), false);
  assert.equal(isMiniRoute('?view=full'), false);
  assert.equal(isMiniRoute('?something=1&view=mini'), true);
});

test('one glance state folds voice and tool activity, error wins', () => {
  assert.equal(miniState('LISTENING', undefined), 'listening');
  // MINI2: muted and connecting are their own pill states, not the thinking
  // shimmer, because the pill dims for one and spins for the other.
  assert.equal(miniState('LISTENING', undefined, true), 'muted');
  assert.equal(miniState('SPEAKING', undefined, true), 'muted', 'muted outranks the voice states');
  assert.equal(miniState('LISTENING', { kind: 'tools', text: 'Searching' }, true), 'tool', 'a running tool still shows while muted');
  assert.equal(miniState('CONNECTING', undefined), 'connecting');
  assert.equal(miniState('SPEAKING', undefined), 'speaking');
  assert.equal(miniState('PROCESSING', { kind: 'tools', text: 'Searching your mail' }), 'tool');
  assert.equal(miniState('CONNECTED', { kind: 'thinking', text: 'Thinking' }), 'thinking');
  assert.equal(miniState('ERROR', { kind: 'tools', text: 'x' }), 'error');
  assert.equal(miniState('CONNECTED', undefined), 'idle');
});

test('the pill is an orb and five level bars with no text at all', () => {
  const caption = '<p class="orb-label">Listening</p>';
  const html = miniMarkup('tool', caption);
  assert.match(html, /class="mini-stage mini-pill"/);
  assert.match(html, /data-mini-state="tool"/);
  assert.match(html, /id="didi-orb"/);
  assert.equal((html.match(/<i data-bar="\d"><\/i>/g) ?? []).length, 5, 'exactly five level bars');
  assert.match(html, /class="mini-level"/);
  // No text: the caption the caller still passes is dropped, and nothing else
  // in the markup is a character the owner could read.
  assert.equal(html.includes(caption), false, 'the pill renders no caption');
  const text = html.replace(/<[^>]*>/g, '').trim();
  assert.equal(text, '', `the pill carries no text, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(html, /conversation-history|data-tab|voice-text|draft|transcript|sidebar|orb-caption/i);
});

test('mini markup carries each glance state', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'muted', 'connecting', 'tool', 'error'] as const) {
    assert.match(miniMarkup(state, ''), new RegExp(`data-mini-state="${state}"`));
  }
  assert.match(miniMarkup('speaking', ''), /presence-glow/, 'the glow is a state-independent element the CSS lights');
  assert.doesNotMatch(miniMarkup('error', ''), /presence-glow visible/);
});

test('the level meter follows the input level and its curve is bounded', () => {
  assert.equal(miniBarHeights(0.5).length, 5, 'one height per bar');
  assert.ok(miniBarHeights(1).every(height => height > 0.9 && height <= 1), 'a loud level fills the meter');
  assert.ok(miniBarHeights(0).every(height => height > 0 && height <= 0.1), 'a silent level keeps a visible floor');
  assert.deepEqual(miniBarHeights(2), miniBarHeights(1), 'a level above one is clamped');
  assert.deepEqual(miniBarHeights(-1), miniBarHeights(0), 'a negative level is silence');
  assert.deepEqual(miniBarHeights(Number.NaN), miniBarHeights(0), 'a non-number is silence');
  assert.notDeepEqual(miniBarHeights(0.4), miniBarHeights(0.9), 'the bars track the level');
});

test('the native level hook writes the bars and flags the stage', () => {
  const bars = [0, 1, 2, 3, 4].map(() => ({ style: { height: '' } }));
  const added: string[] = [];
  const stage = {
    classList: { add: (name: string) => added.push(name) },
    querySelectorAll: () => bars,
  };
  miniMeter(stage as unknown as Element, 0.6);
  assert.deepEqual(added, ['has-level'], 'the stage is flagged so the CSS drops the keyframe fallback');
  for (const bar of bars) assert.match(bar.style.height, /^\d+(\.\d+)?%$/, 'every bar gets a height');
  miniMeter(null, 0.6);
  const host: PillLevelHost = {};
  installMiniMeter(host);
  assert.equal(typeof host.didiPillLevel, 'function', 'the app evaluates window.didiPillLevel');
  host.didiPillLevel?.(0.4);
});

test('the settings view names the single key, its on/off and why it can be inactive', () => {
  assert.deepEqual(singleKeyState(undefined), { enabled: true, granted: false }, 'on by default, inactive until a grant');
  assert.deepEqual(singleKeyState({ enabled: true, granted: true }), { enabled: true, granted: true });
  assert.deepEqual(singleKeyState({ enabled: false, granted: true }), { enabled: false, granted: true });
  assert.deepEqual(singleKeyState('nonsense'), { enabled: true, granted: false }, 'a malformed push reads as the default');
  assert.match(singleKeyRow({ enabled: false, granted: false }), /Right Command tap<\/strong> off/, 'the row states off');
  assert.match(singleKeyRow({ enabled: false, granted: false }), /menu bar menu/, 'the row says where to turn it back on');
  assert.match(singleKeyRow({ enabled: true, granted: false }), /Inactive: macOS has not granted Accessibility/, 'the row says why the key is inactive');
  assert.match(singleKeyRow({ enabled: true, granted: false }), /Control Option Space still works/, 'the chord works without the grant');
  assert.match(singleKeyRow({ enabled: true, granted: true }), /Active: a tap starts and stops Naya/);
  for (const row of [singleKeyRow({ enabled: true, granted: true }), singleKeyRow({ enabled: true, granted: false })]) {
    assert.match(row, /Right Option belongs to SuperWhisper and is never used/, 'Right Option is never claimed');
  }
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

test('the mini boot functions in main.ts reach no audio, microphone or Live path', () => {
  // F1 from the review: the mini route's real boot is main.ts, not only mini.ts,
  // so the guard walks the three functions that boot and repaint the mini stage.
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const bodyOf = (name: string): string => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > -1, `main.ts must still define ${name}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    throw new Error(`unbalanced body for ${name}`);
  };
  const forbidden = ['AudioContext', 'getUserMedia', 'mediaDevices', 'MediaRecorder', 'RTCPeerConnection',
    'WebSocket', 'EventSource', 'fetch(', 'new LiveMachine', 'liveMachine.request'];
  for (const name of ['renderMini', 'paintMiniStage', 'miniCaptionMarkup']) {
    const body = bodyOf(name);
    for (const needle of forbidden) {
      assert.equal(body.includes(needle), false, `${name} must not reference ${needle}`);
    }
  }
});
