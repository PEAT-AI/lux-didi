import assert from 'node:assert/strict';
import test from 'node:test';
import { answer } from './math.mjs';

test('the module answers', () => {
  assert.equal(answer, 42);
});
