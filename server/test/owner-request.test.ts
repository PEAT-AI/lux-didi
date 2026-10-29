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

for (const [words, kind] of [
  ['he said open it', 'open'], ['if I say save this into lux', 'lux_note'],
  ['should I set an alarm?', 'set_alarm'], ['what if you open the deck?', 'open'],
  ['the mail says set an alarm', 'set_alarm'],
] as const) test(`hear104 owner framing still grants: ${words}`, () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', words);
  assert.equal(requests.authorize('s', kind, 'x').code, 'allowed');
});

test('direct102 authority: an unrelated independent ask supersedes an unused open grant', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'open the deck');
  requests.answered('s');
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
  requests.answered('s');
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

test('hear104 authority: a quoted title in owner input grants an open', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'open the deck called "Synthetic plan"');
  assert.equal(requests.authorize('s', 'open', 'deck').code, 'allowed');
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
  requests.answered('s');
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
  test(`hear104 owner reporting frame grants its action: ${frame}`, () => {
    for (const [kind, command] of reportedActions) {
      const requests = new OwnerRequests(() => 0);
      requests.observe('s', 'j', `${frame} ${command}`);
      assert.equal(requests.authorize('s', kind, 'target').code, 'allowed', `${frame} ${command}`);
    }
  });
}
test('hear104 owner compound framing grants only the cued kinds', () => {
  const reported = new OwnerRequests(() => 0);
  reported.observe('s', 'j', 'Alice said open the deck and set an alarm for seven');
  for (const [kind] of reportedActions) assert.equal(reported.authorize('s', kind, 'target').code, kind === 'open' || kind === 'set_alarm' ? 'allowed' : 'no_owner_request', kind);
  for (const [kind, command] of reportedActions) {
    const direct = new OwnerRequests(() => 0);
    direct.observe('s', 'j', command);
    assert.equal(direct.authorize('s', kind, 'target').code, 'allowed', command);
  }
});

for (const [words, kinds] of [
  ['Alice said open the deck and set an alarm for seven', ['open', 'set_alarm']],
  ['He told me to wait then open the deck', ['open']],
  ['The note reads open the deck and set an alarm for seven', ['open', 'set_alarm']],
  ['The instructions are "open the deck and save this into Lux"', ['open', 'lux_note']],
  ['Naya: open the deck', ['open']], ['open "the deck"', ['open']],
  ['open «the deck»', ['open']], ['open 「the deck」', ['open']], ['open `the deck`', ['open']],
  ['will you open the deck', ['open']], ['launch the browser', []], ['list my alarms', []],
] as const) test(`hear104 owner framing: ${words}`, () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j', words);
  for (const [kind] of reportedActions) assert.equal(requests.authorize('s', kind, 'target').code,
    (kinds as readonly string[]).includes(kind) ? 'allowed' : 'no_owner_request', kind);
});
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

for (const words of [
  'open the deck and if I ask later then set an alarm for seven',
  'open the deck if I say so',
  ...['if', 'unless', 'when I', 'whenever', 'once I', 'in case', 'later', 'after I', 'before I', 'should I', 'would you', 'maybe', 'perhaps', 'suppose', 'WHEN  I']
    .map(condition => `open the deck and ${condition} set an alarm for seven`),
  "don't open the deck",
  'never mind, no alarm',
]) {
  test(`hear104 conditional owner wording does not veto cues: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j', words);
    assert.equal(requests.authorize('s', 'open', 'target').code,
      words === "don't open the deck" || words === 'never mind, no alarm' ? 'no_owner_request' : 'allowed');
    if (words.includes('set an alarm')) assert.equal(requests.authorize('s', 'set_alarm', 'time').code, 'allowed');
  });
}

for (const [words, kind] of [
  ['Naya open the deck', 'open'],
  ['set an alarm for seven thirty tomorrow', 'set_alarm'],
] as const) {
  test(`R8 keeps unconditional direct asks: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j', words);
    assert.equal(requests.authorize('s', kind, 'target').code, 'allowed');
  });
}

for (const words of [
  "don't open the deck", 'never mind, no alarm', 'do not save this',
  ...["don't", 'do not', 'dont', 'never', 'not', 'never mind', 'no need to', 'forget it']
    .map(negation => `open the deck and ${negation} save this into Lux`),
]) {
  test(`hear104 negation voids only its governed cue: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'old', 'open the deck and set an alarm for seven');
    requests.observe('s', 'new', words);
    assert.equal(requests.authorize('s', 'open', 'deck').code, words === "don't open the deck" ? 'no_owner_request' : 'allowed');
    assert.equal(requests.authorize('s', 'set_alarm', 'time').code, 'allowed');
    assert.equal(requests.authorize('s', 'lux_note', 'note').code, 'no_owner_request');
  });
}

for (const [words, kind] of [
  ['Great, okay, like set an alarm in nine minutes', 'set_alarm'],
  ['Well, okay, could you open the', 'open'],
  ['remind me in nine minutes to call the library', 'set_alarm'],
] as const) {
  test(`hear104 owner cue: ${words}`, () => {
    const requests = new OwnerRequests(() => 0);
    requests.observe('s', 'j1', words);
    assert.equal(requests.authorize('s', kind, 'target').code, 'allowed');
  });
}
test('hear104 split finals retain the complete ask', () => {
  const requests = new OwnerRequests(() => 0);
  requests.observe('s', 'j1', 'Okay, can you open the');
  requests.observe('s', 'j2', 'example.com in my browser');
  const ask = requests.authorize('s', 'open', 'example.com');
  assert.equal(ask.code, 'allowed');
  assert.match(ask.words ?? '', /example.com/);
});
