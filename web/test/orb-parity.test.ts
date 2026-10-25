import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { levelFrame } from '../src/orb-level.ts';

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
  // #283: native RMS is mapped onto a perceptual (dB) scale, like Vicuna's analyser bands.
  const half = levelFrame({ level: 0.05 });
  assert.ok(half.level > 0.5 && half.level < 0.8, `speech-level RMS maps into the upper middle (${half.level})`);
  assert.equal(half.mid, half.level);
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

test('the connected consent stays inline above the composer, never inside a collapsed disclosure', () => {
  const connected = readFileSync(new URL('../src/connected.ts', import.meta.url), 'utf8');
  assert.match(connected, /<section class="connected-conversation" aria-label="Connected Naya conversation">/);
  const section = connected.slice(connected.indexOf('<section class="connected-conversation"'), connected.indexOf('</section>', connected.indexOf('<section class="connected-conversation"')));
  assert.match(section, /<p class="connected-disclosure">Chat messages go to/, 'the consent line renders inside the conversation panel');
  assert.match(section, /id="connected-consent"/, 'Allow sits above the composer, not behind a disclosure');
  assert.doesNotMatch(connected, /connected-chat|Connected text chat/, 'the removed collapsed chat disclosure never returns');
});

test('typed text goes through the connected composer, Enter to send, not the removed Live text box', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const connected = readFileSync(new URL('../src/connected.ts', import.meta.url), 'utf8');
  assert.match(connected, /id="connected-draft"/);
  assert.match(connected, /id="connected-send"/);
  assert.match(connected, /addEventListener\('keydown', event => \{ if \(composerIntent\(event\) === 'send'\)/);
  assert.doesNotMatch(main, /live-text-form|id="live-text"|\/live\/text/, 'the removed optional Live text surface never returns');
});

test('the shared renderer sends audio-owned body posture to the classic painter', () => {
  const adapter = readFileSync(new URL('../src/orb.ts', import.meta.url), 'utf8');
  assert.match(adapter, /classic\?\.draw\([^\n]*this\.phase,m\.posture,m\.level/);
  assert.match(adapter, /coordinator\.sample\(sample,performance\.now\(\)\)/);
  assert.doesNotMatch(adapter, /m\.activity\s*\*\s*\(visual\?\.amplitude/);
});
