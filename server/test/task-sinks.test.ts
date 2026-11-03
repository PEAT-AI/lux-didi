import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWebOpen } from '../tools/open.js';
import { publicQueryOf, searchQueryAfterExposure } from '../tools/web-search.js';

for (const target of ['https://example.com/leak?text=secret', 'http://localhost/a', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'https://user:pass@example.com/']) {
  test(`open rejects unproven or private URL: ${target}`, async () => {
    const result = await resolveWebOpen({ kind: 'site', target }, `Open ${target.includes('example.com/leak') ? 'the documentation' : target}`, new AbortController().signal);
    assert.ok('code' in result);
    if ('code' in result) assert.equal(result.code, 'egress_blocked');
  });
}

test('exact public URL in finalized owner words opens without rewriting', async () => {
  const target = 'https://example.com/a?q=two';
  const result = await resolveWebOpen({ kind: 'site', target }, `Open ${target}`, new AbortController().signal);
  assert.ok('target' in result);
  if ('target' in result) assert.equal(result.target.target, target);
});

test('query exposure removes invented URL and site operator but preserves owner tokens', () => {
  assert.equal(searchQueryAfterExposure('release https://evil.example/a site:evil.example', 'Find release notes', true), 'release');
  assert.equal(searchQueryAfterExposure('release site:example.com', 'Search site:example.com for release', true), 'release site:example.com');
  assert.equal(searchQueryAfterExposure('release site:example.com', 'Find releases', false), 'release site:example.com');
  assert.equal(searchQueryAfterExposure('https://evil.example', 'Find releases', true), '');
});

test('ordinary asks remain public queries while pasted passages and addresses stay local', () => {
  assert.equal(publicQueryOf('What is the latest stable release of TypeScript?'), 'What is the latest stable release of TypeScript?');
  assert.equal(publicQueryOf('person@example.com'), undefined);
  assert.equal(publicQueryOf('1234567890123456'), undefined);
  assert.equal(publicQueryOf('word '.repeat(25)), undefined);
});
