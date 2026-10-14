import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
