import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  clickStep, installMiniClick, installMiniVisuals, isMiniRoute, miniAriaLabel, miniMarkup,
  miniModeButtonMarkup, miniState, pillState, startMiniOrbVisuals, visualState,
  type MiniState, type PillClickHost, type PillVisualHost, type PresenceStep,
} from '../src/mini.ts';
import { ORB_VISUALS, TRANSITION_MS, DEBOUNCE_MS, type OrbVisual } from '../src/orb-states.ts';
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
  assert.equal(miniState('LISTENING', { kind: 'tools', text: 'Searching' }, true), 'muted', 'muted opacity wins over a pending tool');
  assert.equal(miniState('CONNECTING', undefined), 'connecting');
  assert.equal(miniState('SPEAKING', undefined), 'speaking');
  assert.equal(miniState('PROCESSING', { kind: 'tools', text: 'Searching your mail' }), 'tool');
  assert.equal(miniState('CONNECTED', { kind: 'thinking', text: 'Thinking' }), 'thinking');
  assert.equal(miniState('ERROR', { kind: 'tools', text: 'x' }), 'error');
  assert.equal(miniState('CONNECTED', undefined), 'idle');
});

test('the floating surface is only the canonical orb with no visible text', () => {
  const caption = '<p class="orb-label">Listening</p>';
  const html = miniMarkup('tool', caption);
  assert.match(html, /class="mini-pill"/);
  assert.match(html, /class="mini-stage"/);
  assert.match(html, /data-mini-state="tool"/);
  assert.match(html, /id="didi-orb"/);
  assert.doesNotMatch(html, /mini-level|data-bar/, 'the orb carries no capsule meter');
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
  // M3-R4: the stage is the orb and its rings. The wash and the bars are pill chrome,
  // so a stage captured on its own shows one orb.
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'muted', 'connecting', 'tool', 'error'] as MiniState[]) {
    const stage = /<section class="mini-stage"[^>]*>(.*?)<\/section>/.exec(miniMarkup(state, ''))?.[1] ?? '';
    assert.equal((stage.match(/<canvas/g) ?? []).length, 1, `${state} stage holds exactly one orb canvas`);
    assert.doesNotMatch(stage, /mini-level|data-bar|presence-glow/, `${state} stage holds no pill dot or bars`);
  }
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
  assert.match(markup, />Mini</, 'the visible label is mini');
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
  // M3: the state machine and its visual store are pure (no audio, no transport), so
  // they are the one runtime module the pill loads; every other import stays a type.
  const valueImports = imports.filter((line) => !line.startsWith('import type '));
  assert.deepEqual(valueImports, ["import { createOrbStateMachine, publishOrbVisual, type MiniVisualState, type OrbVisual } from './orb-states.ts';"],
    'orb-states is the only runtime module the mini route reaches');
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

/// M3: a pill stage and its one canvas, enough of the DOM for the loop to read and paint.
function fakePill(state: MiniState, bars = [0, 1, 2, 3, 4].map(() => ({ style: { height: '' } }))) {
  const style = { vars: new Map<string, string>(), setProperty(name: string, value: string) { this.vars.set(name, value); } };
  const stage = {
    style,
    attributes: new Map([['data-mini-state', state]]),
    getAttribute(name: string) { return this.attributes.get(name) ?? null; },
    setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    classList: { add: () => undefined },
    querySelectorAll: () => bars,
    querySelector: (selector: string) => (selector === 'canvas' ? { canvas: true } : null),
  };
  // The pill is the chrome around the stage: the wash and the bars live there.
  const pillStyle = { vars: new Map<string, string>(), setProperty(name: string, value: string) { this.vars.set(name, value); } };
  const pill = {
    style: pillStyle,
    classList: { add: () => undefined },
    querySelectorAll: () => bars,
    querySelector: (selector: string) => (selector === 'canvas' ? { canvas: true } : null),
  };
  return { stage, pill, bars, style, pillStyle };
}

test('the mini markup and the pill carry no text in any state, only an aria label', () => {
  const states: MiniState[] = ['idle', 'listening', 'thinking', 'speaking', 'muted', 'connecting', 'tool', 'error'];
  const labels = new Set<string>();
  for (const state of states) {
    const html = miniMarkup(state, '<p class="orb-label">Listening</p>');
    const text = html.replace(/<[^>]*>/g, '').trim();
    assert.equal(text, '', `${state} renders no text, got ${JSON.stringify(text)}`);
    assert.doesNotMatch(html, /orb-caption|orb-label|voice-honesty|activity-line/, `${state} carries no label element`);
    const label = /aria-label="([^"]+)"/.exec(html)?.[1];
    assert.equal(label, miniAriaLabel(state), `${state} keeps the stage aria-label in step`);
    labels.add(label ?? '');
  }
  assert.equal(labels.size, states.length, 'every state says something different to a screen reader');
});

test('one press, three steps, per state', () => {
  // M3-R2: the click on the orb and the Right Command tap are the same press.
  const expected: Record<MiniState, PresenceStep> = {
    idle: 'connect', error: 'connect', connecting: 'connect',
    listening: 'hot-mute', thinking: 'hot-mute', tool: 'hot-mute', speaking: 'hot-mute',
    muted: 'live',
  };
  for (const [state, step] of Object.entries(expected) as [MiniState, PresenceStep][]) {
    assert.equal(clickStep(state), step, `${state} means ${step}`);
  }
  const host: PillClickHost = {};
  installMiniClick(host);
  assert.equal(typeof host.didiClickStep, 'function', 'native asks window.didiClickStep');
  const saved = (globalThis as { document?: unknown }).document;
  try {
    const { stage } = fakePill('muted');
    (globalThis as { document?: unknown }).document = { querySelector: () => stage };
    assert.equal(host.didiClickStep?.(), 'live', 'the page answers for the state it paints');
    assert.equal(pillState(null), 'idle', 'no stage is the cold state');
  } finally {
    (globalThis as { document?: unknown }).document = saved;
  }
});

test('every pill state has one visual', () => {
  assert.equal(visualState('listening'), 'listening');
  assert.equal(visualState('muted'), 'hot-muted', 'M3-R2: muted is hot-muted, the microphone is live and off');
  assert.equal(visualState('tool'), 'tool');
  // M3-R5: the orb renders the connecting moment as its own visual; error stays cold.
  assert.equal(visualState('connecting'), 'connecting');
  for (const quiet of ['idle', 'error'] as MiniState[]) {
    assert.equal(visualState(quiet), 'cold', `${quiet} shows the cold state`);
  }
});

test('the pill loop eases to the state and gates the microphone', () => {
  const { stage, pill, bars, style, pillStyle } = fakePill('idle');
  let host: PillVisualHost = {};
  let clock = 0;
  const published: OrbVisual[] = [];
  const queued: Array<() => void> = [];
  const stop = startMiniOrbVisuals({
    doc: {
      querySelector: (selector: string) => (selector === '.mini-pill' ? pill : stage) as unknown as Element,
    },
    now: () => clock,
    reducedMotion: () => false,
    frame: (tick) => { queued.push(tick); return queued.length; },
    cancel: () => undefined,
    publish: (_canvas, visual) => published.push(visual),
  });
  const step = () => { const next = queued.shift(); assert.ok(next, 'the loop keeps a frame queued'); next(); };
  step();                                   // the first frame reads the pill
  assert.equal(published.at(-1)?.state, 'cold');
  // State opacity is fixed; the canonical renderer owns geometric breathing.
  const coldOpacity = Number.parseFloat(style.vars.get('--mini-orb-opacity') ?? '1');
  assert.equal(coldOpacity, 0.30, 'cold canvas opacity is exactly the requested value');
  assert.ok(Number.parseFloat(style.vars.get('--mini-orb-grey') ?? '0') > 0.9, 'cold is grey');
  stage.setAttribute('data-mini-state', 'listening');
  step();                                   // requests listening
  clock += DEBOUNCE_MS + TRANSITION_MS / 2; // commit lands, the ease is half way
  step();
  const half = published.at(-1)!;
  // M3-R6: no hue is walked; the two state layers crossfade instead.
  assert.equal(half.hue, ORB_VISUALS.listening.hue, 'the layer being faded in is the listening teal');
  assert.ok(half.mixing && Math.abs(half.mixing.t - 0.5) < 0.01, `half way across the crossfade, got ${JSON.stringify(half.mixing)}`);
  assert.equal(half.mixing?.from, ORB_VISUALS.cold.hue);
  assert.equal(half.followsMic, true);
  clock += TRANSITION_MS;
  step();
  assert.equal(published.at(-1)?.hue, ORB_VISUALS.listening.hue, 'it lands on the listening teal');
  assert.equal(style.vars.get('--mini-orb-grey'), '0.000', 'a live listening orb carries its colour');
  assert.ok(Number.parseFloat(style.vars.get('--mini-wash') ?? '0') > 0.3, 'the wash follows the eased glow, on the stage');
  assert.equal(style.vars.get('--mini-orb-bright'), '1.000', 'a live orb is at full brightness');
  host = {};
  installMiniVisuals(host);
  assert.equal(typeof host.didiOrbVisual, 'function', 'the strip reads the painted visual');
  stage.setAttribute('data-mini-state', 'thinking');
  step();
  clock += DEBOUNCE_MS + TRANSITION_MS;
  step();
  assert.equal(published.at(-1)?.followsMic, false, 'thinking ignores the microphone');
  stop();
  const pending = queued.length;
  queued.splice(0).forEach((tick) => tick());
  assert.equal(queued.length, 0, 'a stopped loop never queues another frame');
});
