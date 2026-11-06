import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as persona from '../prompt/live-persona.js';

// Freeze the whole source outside the two owned regions (M3's depth line, FR2's NAYA_WORK_DELIVERY).
test('every other persona line is byte-identical to base ab76c393', () => {
  const root = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../../test/', import.meta.url));
  const source = readFileSync(resolve(root, '../prompt/live-persona.ts'), 'utf8');
  // M3 owns the depth paragraph on line 18, FR2 owns NAYA_WORK_DELIVERY: both regions are the allowed change.
  const unchanged = source.replace(/export const NAYA_WORK_DELIVERY = "[^\n]*";/, '')
    .replace(/^Depth follows the ask\.[^\n]*$/m, '');
  assert.equal(createHash('sha256').update(unchanged).digest('hex'), '03ecf4a355fb47147964436170b34c94e86b239796423784da8f027dbf3ed569');
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
