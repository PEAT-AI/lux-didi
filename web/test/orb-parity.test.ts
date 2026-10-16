import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { levelFrame } from '../src/orb-level.ts';
import { Orb, posture } from '../src/orb.ts';

const source = readFileSync(new URL('../src/orb-classic.ts', import.meta.url), 'utf8');
const style = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('classic renderer retains the pinned layer order', () => {
  const draw = source.slice(source.indexOf('  draw('), source.indexOf('  private drawAmbientCorona('));
  const layers = [
    'drawAmbientCorona', 'drawLuminousGlow', 'drawRadialFlares', 'drawDancingSparkles',
    'drawBrightFlares', 'drawLuminousProminences', 'drawTechRings', 'drawWobblyCore',
    'drawSparkleBurst', 'drawTwinklingRing', 'drawHotCore',
  ];
  let cursor = -1;
  for (const layer of layers) {
    const next = draw.indexOf(`this.${layer}(`);
    assert.ok(next > cursor, `${layer} follows the pinned classic order`);
    cursor = next;
  }
});

test('classic renderer preserves Vicuna layer inputs without Didi-specific band modulation', () => {
  const draw = source.slice(source.indexOf('  draw('), source.indexOf('  private drawAmbientCorona('));
  for (const layer of ['drawRadialFlares', 'drawDancingSparkles', 'drawBrightFlares', 'drawLuminousProminences', 'drawTechRings', 'drawWobblyCore', 'drawSparkleBurst', 'drawTwinklingRing']) {
    const call = draw.split(`this.${layer}(`)[1]?.split(');')[0] ?? '';
    assert.ok(call.endsWith('activity') || call.endsWith('flare, activity'), `${layer} uses the shared Vicuna activity`);
  }
  assert.doesNotMatch(draw, /activity\s*\+\s*(mid|high|flux)/);
  for (const name of ['lowAttack', 'midAttack', 'highAttack', 'fluxAttack', 'playbackAttack']) {
    assert.match(source, new RegExp(`${name}: [0-9]`));
  }
});

test('inactive orb composes Vicuna disabled and neutral canvas opacity', () => {
  assert.match(style, /data-state=IDLE[^}]+grayscale\(\.82\) brightness\(\.96\) opacity\(\.9\)/);
});

test('a native level sample folds into a bounded five-band frame', () => {
  const frame = levelFrame({ level: 2, low: -1 });
  assert.equal(frame.level, 1);
  assert.equal(frame.low, 0);
  assert.equal(frame.mid, 1, 'a missing band defaults to the scalar level');
  assert.equal(frame.high, 1);
  assert.equal(frame.flux, 0);
  assert.equal(levelFrame({ level: 0.5 }).mid, 0.5);
  assert.equal(levelFrame({ level: Number.NaN }).level, 0, 'a non-finite level is clamped to silence');
});

test('the renderer accepts a posted level frame and exposes the Vicuna presence glow', () => {
  const orb = readFileSync(new URL('../src/orb.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(orb, /didiOrbLevel/);
  assert.match(main, /class="presence-glow/);
  assert.match(style, /\.orb-stage \.presence-glow\{/);
  assert.match(style, /@keyframes presence-glow-pulse/);
});

test('the orb canvas matches the Vicuna narrow size proportion', () => {
  assert.match(style, /\.orb-stage canvas\{width:min\(300px,72vw\);height:min\(300px,72vw\);margin:-48px 0\}/);
});

test('the orb stage uses the Vicuna dark gradient and a visible presence glow', () => {
  assert.match(style, /\.orb-stage\{[^}]*linear-gradient\(180deg,var\(--stage-a\) 0%,var\(--stage-b\) 100%\)/);
  assert.match(style, /\.orb-stage \.presence-glow\{width:420px;height:420px\}/);
});

test('the connected consent wall is a closed disclosure', () => {
  const connected = readFileSync(new URL('../src/connected.ts', import.meta.url), 'utf8');
  assert.match(connected, /<details class="connected-chat"><summary><span>Connected text chat<\/span>/);
  assert.match(connected, /id="connected-disclosure"|class="connected-disclosure"/);
  assert.match(connected, /<\/details>/);
});

test('typed text to Naya is an input under the voice card that posts to the live text endpoint', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /id="live-text-form"/);
  assert.match(main, /id="live-text"/);
  assert.ok(main.includes("request<{ sent: boolean }>('/live/text'"));
});

test('the PROCESSING override follows the playback band, never the owner capture (F6)', () => {
  assert.equal(posture('PROCESSING', { level: 0.9, playback: 0 }), 'thinking', 'the owner talking does not make the orb speak');
  assert.equal(posture('PROCESSING', { level: 0, playback: 0.9 }), 'speaking', 'audible playback during a tool turn still speaks');
  assert.equal(posture('SPEAKING', { level: 0, playback: 0 }), 'speaking');
  assert.equal(posture('LISTENING', { level: 0, playback: 0 }), 'listening');
  assert.equal(posture('CONNECTING', { level: 0, playback: 0 }), 'thinking');
  assert.equal(posture('ERROR', { level: 0, playback: 0 }), 'quiet');
});

test('a state change draws the transition frame with the smoothed activity, not the target (F5)', () => {
  const { canvas, restore } = stubDom();
  try {
    const orb = new Orb(canvas as unknown as HTMLCanvasElement, 'CONNECTED');
    orb.setState('SPEAKING');
    const stats = (canvas as { didiFrameStats(): { activity: number; target: number } }).didiFrameStats();
    assert.equal(typeof stats.activity, 'number');
    assert.equal(typeof stats.target, 'number');
    assert.notEqual(stats.activity, stats.target, 'the first frame after a state change crossfades from the smoothed activity');
  } finally {
    restore();
  }
});

// Minimal DOM so the Canvas Orb runs headless under node --test; it renders through a no-op context.
function stubDom() {
  const saved: Record<string, unknown> = {
    matchMedia: (globalThis as Record<string, unknown>).matchMedia,
    ResizeObserver: (globalThis as Record<string, unknown>).ResizeObserver,
    document: (globalThis as Record<string, unknown>).document,
    requestAnimationFrame: (globalThis as Record<string, unknown>).requestAnimationFrame,
    cancelAnimationFrame: (globalThis as Record<string, unknown>).cancelAnimationFrame,
    devicePixelRatio: (globalThis as Record<string, unknown>).devicePixelRatio,
  };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get: (target, key) => (Reflect.has(target, key) ? Reflect.get(target, key) : () => gradient),
    set: (target, key, value) => { Reflect.set(target, key, value); return true; },
  });
  const canvas = { width: 0, height: 0, clientWidth: 220, dataset: {} as Record<string, string>, getContext: () => ctx };
  const globals = globalThis as Record<string, unknown>;
  globals.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globals.ResizeObserver = class { observe() {} disconnect() {} };
  globals.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  globals.requestAnimationFrame = () => 1;
  globals.cancelAnimationFrame = () => {};
  globals.devicePixelRatio = 1;
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  };
  return { canvas, restore };
}
