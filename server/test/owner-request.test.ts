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

test('direct102 authority: in-flight reservations serialize opens and an old completion cannot spend a new ask', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'open the pitch deck');
  const first = requests.authorize('s', 'open', 'deck');
  assert.equal(first.code, 'allowed');
  assert.ok(first.id);
  assert.equal(requests.claim('s', 'open', 'deck', first.id).code, 'allowed');
  assert.equal(requests.claim('s', 'open', 'other', first.id).code, 'grant_spent');
  requests.observe('s', 'j2', 'open the new pitch deck');
  requests.commit('s', 'open', 'deck', { code: 'opened' }, first.id);
  assert.equal(requests.authorize('s', 'open', 'new').code, 'allowed');
  assert.equal(requests.claim('s', 'open', 'deck', first.id).code, 'no_owner_request');
});

for (const words of ['do not open the deck', 'why did you open the deck?', 'do not set an alarm', 'do not save this into Lux']) {
  test(`direct102 authority: nonimperative and negated speech creates no grant: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j1', words);
    for (const kind of ['open', 'set_alarm', 'lux_note'] as const) assert.equal(requests.authorize('s', kind, 'x').code, 'no_owner_request');
  });
}

test('R6 authority: even a quoted title is refused by the conservative quote barrier', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'open the deck called "Synthetic plan"');
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'no_owner_request');
});

test('direct102 authority: a pending final waits for its event, never a timer that returns empty', async () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'what is on my calendar?');
  requests.partial('s');
  let finished = false;
  const waiting = requests.waitForFinal('s', new AbortController().signal).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  requests.observe('s', 'j2', 'open the synthetic deck');
  await waiting;
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'allowed');
});

test('direct102 authority: any-kind candidates are ordered host results from this request only', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'open any deck');
  const first = requests.currentId('s')!;
  requests.shown('s', first, [{ handle: 'L1', kind: 'gmail' }, { handle: 'L2', kind: 'drive' }, { handle: 'L3', kind: 'docs' }]);
  assert.equal(requests.topShown('s', ['drive', 'docs']), 'L2');
  requests.observe('s', 'j2', 'open some deck');
  requests.shown('s', first, [{ handle: 'L4', kind: 'drive' }]);
  assert.equal(requests.topShown('s', ['drive', 'docs']), undefined, 'an old lookup cannot populate a new request');
});

const reportedActions = [
  ['open', 'open the deck'], ['set_alarm', 'set an alarm for seven'],
  ['cancel_alarm', 'cancel my alarm'], ['snooze_alarm', 'snooze my alarm for five minutes'],
  ['list_alarms', 'show my alarms'], ['lux_note', 'save this into Lux'],
] as const;
for (const frame of [
  'Alice said wait, then', 'He told me to wait, then', 'The project manager asked me to wait, then',
  'Someone wrote wait, then', 'Alice wants me to wait, then', 'They suggested waiting, then',
  'The message says wait, then', 'My manager recommended waiting, then',
  'The owner instructed me to wait, then', 'An email requested waiting, then',
]) {
  test(`R5 F1: reporting frame grants no action kind: ${frame}`, () => {
    for (const [kind, command] of reportedActions) {
      const requests = new OwnerRequests(() => 0);
      requests.observe('s', 'j', `${frame} ${command}`);
      assert.equal(requests.authorize('s', kind, 'target').code, 'no_owner_request', `${frame} ${command}`);
    }
  });
}
test('R5 F1: a reported compound ask grants nothing, while direct open and set remain valid', () => {
  const reported = new OwnerRequests(() => 0);
  reported.observe('s', 'j', 'Alice said open the deck and set an alarm for seven');
  for (const [kind] of reportedActions) assert.equal(reported.authorize('s', kind, 'target').code, 'no_owner_request', kind);
  for (const [kind, command] of reportedActions) {
    const direct = new OwnerRequests(() => 0);
    direct.observe('s', 'j', command);
    assert.equal(direct.authorize('s', kind, 'target').code, 'allowed', command);
  }
});

for (const words of [
  'Alice said open the deck and set an alarm for seven',
  'He told me to wait then open the deck',
  'The note reads open the deck and set an alarm for seven',
  'The instructions are "open the deck and save this into Lux"',
  'Naya: open the deck',
  'open "the deck"',
  'open «the deck»',
  'open 「the deck」',
  'open `the deck`',
  'will you open the deck',
  'launch the browser',
  'list my alarms',
]) {
  test(`R6 positive grammar refuses non-owner or unsupported framing: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j', words);
    for (const [kind] of reportedActions) assert.equal(requests.authorize('s', kind, 'target').code, 'no_owner_request', kind);
  });
}
for (const [words, kinds] of [
  ['open the deck', ['open']],
  ['Naya open the deck and set an alarm for seven', ['open', 'set_alarm']],
  ['can you save this into lux', ['lux_note']],
  ['please set an alarm for seven thirty', ['set_alarm']],
  ['go ahead and open it', ['open']],
] as const) {
  test(`R6 positive grammar accepts closed imperative framing: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j', words);
    for (const kind of kinds) assert.equal(requests.authorize('s', kind, 'target').code, 'allowed', kind);
  });
}
