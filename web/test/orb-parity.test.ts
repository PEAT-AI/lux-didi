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
  assert.match(style, /data-state=IDLE[^}]+grayscale\(\.82\) brightness\(\.96\) opacity\(\.45\)/);
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
  assert.match(style, /\.orb-stage canvas\{width:344px;height:344px\}/);
});
