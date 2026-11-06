import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const root = process.env['DIDI_TEST_SOURCE_ROOT'] ?? resolve(process.cwd(), 'test');
const { classifyTiming } = require(resolve(root, '../../scripts/didi-replay-seam'));
const fixture = JSON.parse(readFileSync(resolve(root, 'fixtures/replay-seam/events.json'), 'utf8'));
test('retrieval after first audio is late, not early; retrieval before it is early', () => {
  assert.deepEqual(fixture.map(classifyTiming), ['late', 'early']);
});
test('missing timestamps never imply retrieval was early', () => {
  assert.equal(classifyTiming({ first_audio_at: 1500 }), 'missing:retrieval_returned_at');
  assert.equal(classifyTiming({ retrieval_returned_at: 1400 }), 'missing:first_audio_at');
});
