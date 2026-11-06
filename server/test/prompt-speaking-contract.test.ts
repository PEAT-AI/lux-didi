import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as persona from '../prompt/live-persona.js';

// Freeze the whole source outside the one allowed constant, including template constants.
test('every other persona line is byte-identical to base ab76c393', () => {
  const root = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const source = readFileSync(resolve(root, '../prompt/live-persona.ts'), 'utf8');
  const unchanged = source.replace(/export const NAYA_WORK_DELIVERY = "[^\n]*";/, '');
  assert.equal(createHash('sha256').update(unchanged).digest('hex'), '55b5199dacb52e80f99000ec36b53ae09dd153c0cbc2fc24a23ba7d90b357329');
});
test('delivery speaks provisional findings now, corrects plainly and stays within base budget', () => {
  const value = persona.NAYA_WORK_DELIVERY;
  assert.ok(value.length <= 3817, `delivery grew to ${value.length}`);
  assert.match(value, /Acknowledge each ask at once/);
  assert.match(value, /provisional or local recall/);
  assert.match(value, /what changed, the new fact and what it replaces/);
  assert.match(value, /at most one clause or nothing/);
  assert.match(value, /never fill the wait/);
  assert.doesNotMatch(value, /Collect every part through final:true before speaking/);
});
