import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as persona from '../prompt/live-persona.js';

// Freeze the shipped persona prose. M3 owns the depth line, FR2 owns NAYA_WORK_DELIVERY and
// M0/M11 own the composer, the yield code and the memory section constants, so the freeze covers
// the prose constants those owners did not touch, not the module code.
test('persona prose outside the owned regions is byte-identical to base ab76c393', () => {
  const root = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const source = readFileSync(resolve(root, '../prompt/live-persona.ts'), 'utf8');
  const character = /export const NAYA_CHARACTER = `([\s\S]*?)`;/.exec(source)?.[1] ?? '';
  const voice = /export const NAYA_VOICE_SURFACE = `([\s\S]*?)`;/.exec(source)?.[1] ?? '';
  const prose = [character.replace(/^Depth follows the ask\..*\n?/m, ''), voice].join('\n\n');
  assert.equal(createHash('sha256').update(prose).digest('hex'), '15ae06f1a597f9b24e69dcae24ae58f527e16b8fcfbb525e44c53984e938ce38');
});test('delivery speaks provisional findings now, corrects plainly and stays within base budget', () => {
  const value = persona.NAYA_WORK_DELIVERY;
  assert.ok(value.length <= 3817, `delivery grew to ${value.length}`);
  assert.match(value, /Acknowledge each ask at once/);
  assert.match(value, /provisional or local recall/);
  assert.match(value, /what changed, the new fact and what it replaces/);
  assert.match(value, /at most one clause or nothing/);
  assert.match(value, /never fill the wait/);
  assert.doesNotMatch(value, /Collect every part through final:true before speaking/);
});
