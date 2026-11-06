import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as persona from '../prompt/live-persona.js';

const base = {};
test('other exported persona constants remain byte-identical to base ab76c393', () => {
  for (const [name, value] of Object.entries(base)) assert.equal((persona as unknown as Record<string, unknown>)[name], value, name);
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
