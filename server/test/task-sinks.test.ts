import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authority, authorizeWebOpen, assertRegistryExposure } from '../tasks/authority.js';
import { normalizeTrelloWrite } from '../tools/trello.js';
import { publicQueryOf, searchQueryAfterExposure } from '../tools/web-search.js';

for (const target of ['http://example.com/', 'https://localhost/a', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://[fc00::1]/', 'https://[::ffff:127.0.0.1]/', 'https://user:pass@example.com/']) {
  test(`new task sink rejects nonpublic URL, paired with a public URL: ${target}`, () => {
    const result = authorizeWebOpen({ target, exposed: false });
    assert.equal(result.allow, false);
    if (!result.allow) { assert.equal(result.code, 'egress_blocked'); assert.ok(result.repair); }
    assert.deepEqual(authorizeWebOpen({ target: 'https://example.com/article', exposed: false }), { allow: true });
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

test('query exposure removes invented URL and site operator but preserves owner tokens', () => {
  assert.equal(searchQueryAfterExposure('release https://evil.example/a site:evil.example', 'Find release notes', true), 'release');
  assert.equal(searchQueryAfterExposure('release site:example.com', 'Search site:example.com for release', true), 'release site:example.com');
  assert.equal(searchQueryAfterExposure('release site:example.com', 'Find releases', false), 'release site:example.com');
  assert.equal(searchQueryAfterExposure('https://evil.example', 'Find releases', true), '');
});

for (const expression of ['site:example.com', 'https://example.com/a']) {
  for (const [left, right] of [['(', ')'], ['[', ']'], ['"', '"'], ["'", "'"]] as const) {
    test(`F1 exposed search strips punctuated invented expression and preserves owner-authorized expression: ${left}${expression}${right}`, () => {
      const query = `release ${left}${expression}${right}`;
      assert.equal(searchQueryAfterExposure(query, 'Find release notes', true), 'release');
      assert.equal(searchQueryAfterExposure(query, `Find release notes ${expression}`, true), query);
      assert.equal(searchQueryAfterExposure(`release ${expression}`, `Find release notes ${left}${expression}${right}`, true), `release ${expression}`);
      assert.equal(searchQueryAfterExposure(query, 'Find release notes', false), query);
      assert.equal(searchQueryAfterExposure(query, `Find release notes ${expression}/different`, true), 'release');
    });
  }
}

test('F1 search recognizes expressions attached to ordinary punctuation without losing adjacent words', () => {
  assert.equal(searchQueryAfterExposure('release,(site:evil.example)', 'Find release notes', true), 'release,');
  assert.equal(searchQueryAfterExposure('release,(https://evil.example/a)', 'Find release notes', true), 'release,');
  assert.equal(searchQueryAfterExposure('website:examples release', 'Find release notes', true), 'website:examples release');
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
