import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authority, authorizeWebOpen, assertRegistryExposure } from '../tasks/authority.js';
import { normalizeTrelloWrite } from '../tools/trello.js';
import { publicQueryOf, searchQueryAfterExposure } from '../tools/web-search.js';

for (const target of ['http://example.com/article', 'https://example.com/article']) {
  test(`SD7 public HTTP(S) opens clean and from exact outside evidence: ${target}`, () => {
    assert.deepEqual(authorizeWebOpen({ target, exposed: false }), { allow: true });
    assert.deepEqual(authorizeWebOpen({ target, exposed: true, toolResultURLs: [target] }), { allow: true });
  });
}
for (const target of ['http://localhost/preview', 'https://localhost/a', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://[fc00::1]/', 'https://[::ffff:127.0.0.1]/']) {
  test(`SD7 trusted private destination is allowed, exact outside destination refused: ${target}`, () => {
    assert.deepEqual(authorizeWebOpen({ target, exposed: false }), { allow: true });
    const result = authorizeWebOpen({ target, exposed: true, toolResultURLs: [target], canonicalURLs: [target] });
    assert.equal(result.allow, false);
    if (!result.allow) { assert.equal(result.code, 'egress_blocked'); assert.ok(result.repair); }
  });
}
for (const target of ['http://user:pass@example.com/', 'https://user:pass@example.com/', 'file:///synthetic/path', 'javascript:alert(1)']) {
  test(`SD7 unsafe scheme or credentials are refused in both contexts: ${target}`, () => {
    for (const exposed of [false, true]) assert.equal(authorizeWebOpen({ target, exposed, toolResultURLs: [target] }).allow, false);
  });
}

test('AUTH-R2 clean spoken ask needs no URL provenance; no rewriting', () => {
  assert.deepEqual(authorizeWebOpen({ target: 'https://example.com/a?q=two', exposed: false }), { allow: true });
});

test('after exposure only byte-exact result or canonical URL is eligible, never synthesized or extended', () => {
  const target = 'https://example.com/article';
  for (const input of [{ toolResultURLs: [target] }, { canonicalURLs: [target] }]) {
    assert.deepEqual(authorizeWebOpen({ target, exposed: true, ...input }), { allow: true });
    for (const changed of [target + '?secret=value', target + '/extra', target.toUpperCase()]) {
      const denied = authorizeWebOpen({ target: changed, exposed: true, ...input });
      assert.equal(denied.allow, false);
      if (!denied.allow) assert.equal(denied.code, 'egress_blocked');
    }
  }
  assert.equal(authorizeWebOpen({ target, exposed: true }).allow, false);
});

test('exposed open applies normal owner effect check, independently of exact link provenance', async () => {
  const target = 'https://example.com/article';
  for (const answer of [false, true]) {
    const seen: unknown[] = [];
    const authority = new Authority({ checkEffect: async input => { seen.push(input); return answer; }, log: () => {}, journal: { get: async () => undefined, put: async () => {} } });
    authority.expose('synthetic-task', 'mail');
    const request = { task: { id: 'synthetic-task', revision: 1, ownerWords: 'Open The Verge' }, effect: 'open' as const, arguments: { target }, validate: () => true, webTarget: target, toolResultURLs: [target] };
    const result = await authority.authorize(request);
    assert.equal(result.allow, answer);
    if (!result.allow) assert.equal(result.code, 'not_owner_asked');
    assert.deepEqual(seen, [{ ownerWords: 'Open The Verge', effect: 'open' }]);
    assert.equal((await authority.authorize({ ...request, webTarget: target + '?secret=value' })).allow, false);
  }
});

test('registry exposure completeness is parameterized and renamed read tools cannot fail open', () => {
  assert.doesNotThrow(() => assertRegistryExposure([{ name: 'read_mail', effect: null, exposure: 'mail' }, { name: 'calendar', effect: null, exposure: 'calendar' }, { name: 'draft', effect: 'draft_email' }]));
  assert.throws(() => assertRegistryExposure([{ name: 'renamed_read', effect: null }]), /renamed_read/);
  assert.throws(() => assertRegistryExposure([{ name: 'unknown_read', effect: null, exposure: 'unknown' }]), /unknown_read/);
});

for (const token of [
  'https://example.com/a;outside', 'https://example.com/a,outside',
  '(HTTPS://example.com/a)', '[ftp://example.com/a]', 'prefix(https://example.com/a)suffix',
  'www.example.com', '(WWW.example.com/a)', 'prefix[www.example.com/a]suffix',
  'site:example.com', '(SITE:example.com)', 'prefix[site:example.com]suffix',
  '"site:example.com"', "'https://example.com/a'", 'arbitrary://value',
]) {
  test(`AUTH-R6 exposed search drops the entire unsafe token: ${token}`, () => {
    assert.equal(searchQueryAfterExposure(`release ${token} notes`, true), 'release notes');
    assert.equal(searchQueryAfterExposure(`release ${token} notes`, false), `release ${token} notes`);
  });
}

test('AUTH-R6 ordinary exposed question passes whole and clean task retains a site operator', () => {
  const ordinary = 'What is the latest (stable) release of TypeScript?';
  assert.equal(searchQueryAfterExposure(ordinary, true), ordinary);
  assert.equal(searchQueryAfterExposure('release site:example.com', false), 'release site:example.com');
  assert.equal(searchQueryAfterExposure('  release (SITE:example.com)  ', false), '  release (SITE:example.com)  ');
  assert.equal(searchQueryAfterExposure('(site:example.com) https://example.com www.example.com', true), '');
});

test('Trello strips mentions and never retains a member assignment', () => {
  const result = normalizeTrelloWrite({ action: 'create', list: 'Inbox', name: 'Review @board release', description: 'Ask @synthetic-person about this', idMembers: ['synthetic-member'] });
  assert.equal(result.args.name, 'Review release');
  assert.equal(result.args.description, 'Ask about this');
  assert.equal(result.args.idMembers, undefined);
  assert.equal(normalizeTrelloWrite({ action: 'create', list: 'Inbox', name: 'Review release', description: 'Ask about this' }).args.name, 'Review release');
});

test('ordinary asks remain public queries while pasted passages and addresses stay local', () => {
  assert.equal(publicQueryOf('What is the latest stable release of TypeScript?'), 'What is the latest stable release of TypeScript?');
  assert.equal(publicQueryOf('person@example.com'), undefined);
  assert.equal(publicQueryOf('1234567890123456'), undefined);
  assert.equal(publicQueryOf('word '.repeat(25)), undefined);
});
