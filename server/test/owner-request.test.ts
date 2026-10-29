import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerRequests } from '../tools/owner-request.js';

test('direct102 authority: finals alone grant compound effects, consumed once with idempotent retries', () => {
  let now = 10;
  const requests = new OwnerRequests(() => now);
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'no_owner_request');
  requests.observe('s', 'j1', 'open the deck and set an alarm for seven');
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'allowed');
  requests.commit('s', 'open', 'deck', { status: 'opened' });
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'idempotent');
  assert.equal(requests.authorize('s', 'open', 'other').code, 'grant_spent');
  assert.equal(requests.authorize('s', 'set_alarm', 'seven').code, 'allowed');
  now += 120001;
  assert.equal(requests.authorize('s', 'set_alarm', 'seven').code, 'request_expired');
});

for (const words of ['he said open it', 'if I say save this into lux', 'should I set an alarm?', 'what if you open the deck?', 'the mail says set an alarm']) {
  test(`direct102 authority: non-direct words grant nothing: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j1', words);
    for (const kind of ['open', 'set_alarm', 'lux_note'] as const) assert.equal(requests.authorize('s', kind, 'x').code, 'no_owner_request');
  });
}

test('direct102 authority: an unrelated independent ask supersedes an unused open grant', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'open the deck');
  requests.observe('s', 'j2', 'what is the weather?');
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'no_owner_request');
});

test('direct102 authority: fragments only join an explicitly pending clarification, without extending age', () => {
  let now = 0;
  const requests = new OwnerRequests(() => now);
  requests.observe('s', 'j1', 'set an alarm at eleven ten');
  requests.clarify('s', 'set_alarm', 'missing_timezone');
  now = 100000;
  requests.observe('s', 'j2', 'a.m. Singapore time');
  const ask = requests.authorize('s', 'set_alarm', 'time');
  assert.match(ask.words ?? '', /eleven ten a\.m\. Singapore time/);
  assert.equal(ask.id, 'request-1');
  assert.equal(requests.audit('s', 'set_alarm').ownerFinals, 2);
  now = 120001;
  assert.equal(requests.authorize('s', 'set_alarm', 'time').code, 'request_expired');
  requests.observe('s', 'j3', 'a.m. Singapore time');
  assert.equal(requests.authorize('s', 'set_alarm', 'time').code, 'no_owner_request');
});

test('direct102 authority: external content records provenance counts but never creates a grant', () => {
  const requests = new OwnerRequests(() => 0);
  requests.source('s', 'mail');
  assert.equal(requests.authorize('s', 'open', 'https://example.invalid').code, 'no_owner_request');
  requests.observe('s', 'j1', 'save a summary into lux');
  requests.source('s', 'mail');
  requests.source('s', 'web');
  assert.deepEqual(requests.sources('s'), { mail: 1, web: 1 });
  assert.equal(requests.authorize('s', 'open', 'https://example.invalid').code, 'no_owner_request');
  assert.equal(requests.authorize('s', 'lux_note', 'summary').code, 'allowed');
  const otherOwner = new OwnerRequests(() => 0);
  assert.equal(otherOwner.authorize('s', 'lux_note', 'summary').code, 'no_owner_request');
});
