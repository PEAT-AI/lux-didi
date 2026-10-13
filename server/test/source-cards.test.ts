import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceCards } from '../tools/source-cards.js';

test('approved display sources retain Unicode, order, dedup and separate references', () => {
  assert.deepEqual(sourceCards({ text: '[Überblick 🌱](https://example.com/a#42) insight 42 #42 [repeat](https://example.com/a#42)\nsource: https://example.com/b' }), [
    { title: 'Überblick 🌱', url: 'https://example.com/a#42' }, { title: '42' }, { title: 'https://example.com/b', url: 'https://example.com/b' },
  ]);
  assert.deepEqual(sourceCards({ text: 'https://example.com/a#99' }), [{ title: 'https://example.com/a#99', url: 'https://example.com/a#99' }]);
  assert.deepEqual(sourceCards({ text: 'insight 42' }), [{ title: '42' }], 'references are local to each tool card');
});

test('structured and extracted sources enforce the same HTTPS destination rules', () => {
  const bad = ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/\\evil', 'https://example.com/\u0001', `https://example.com/${'x'.repeat(2048)}`];
  for (const url of bad) {
    assert.deepEqual(sourceCards({ sources: [{ title: 'Unsafe', url }] }), []);
    assert.deepEqual(sourceCards({ text: `[Unsafe](${url})` }), []);
  }
  assert.deepEqual(sourceCards({ sources: [{ title: 'Ref' }, { title: '🌱'.repeat(300), url: 'https://example.com' }] }), [
    { title: 'Ref' }, { title: '🌱'.repeat(256), url: 'https://example.com' },
  ]);
});

test('only approved text, markdown and structured sources supply cards', () => {
  const input = { text: 'No sources', rawPayload: '[raw](https://example.com/raw)', decodedResult: { text: '[decoded](https://example.com/decoded)' } };
  assert.deepEqual(sourceCards(input), []);
  assert.deepEqual(sourceCards({ text: '#42', markdown: '[approved](https://example.com/approved)' }), [{ title: 'approved', url: 'https://example.com/approved' }]);
});

test('chat keeps eight cards while Live preserves its existing uncapped card count', () => {
  const text = Array.from({ length: 12 }, (_, i) => `[${i}](https://example.com/${i})`).join(' ');
  assert.equal(sourceCards({ text }).length, 8);
  assert.equal(sourceCards({ text }, Infinity).length, 12);
});

test('repeated unmatched brackets are scanned once without losing the final link', () => {
  const text = '['.repeat(200_000) + '[last](https://example.com/last) insight 42';
  assert.deepEqual(sourceCards({ text }), [{ title: 'last', url: 'https://example.com/last' }, { title: '42' }]);
});
