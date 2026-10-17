import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redactSecrets, redactSecretsWithCount } from '../tools/redact.js';

// Synthetic fixtures only: every value below is invented for this test.

test('keyed assignments are redacted and the key survives', () => {
  for (const [input, keyed] of [
    ['password=hunter2', 'password=[redacted]'],
    ['"api_key": "abc123xyz"', '"api_key": "[redacted]"'],
    ['client_secret: s3cr3t-value', 'client_secret: [redacted]'],
    ['token=abc.def.ghi', 'token=[redacted]'],
  ] as const) {
    const out = redactSecrets(input);
    assert.equal(out, keyed, input);
  }
});

test('known token formats are redacted', () => {
  const cases = [
    'Bearer abcdefghijklmnopqrstuvwx',
    'sk-ABCDEFGHIJKLMNOP',
    'sk-proj-ABCDEFGHIJKLMNOPQRST',
    'ghp_ABCDEFGHIJKLMNOPQRST',
    'gho_ABCDEFGHIJKLMNOPQRST',
    'github_pat_ABCDEFGHIJKLMNOPQRSTUVWX',
    'xoxb-123456789012-abcdefghijkl',
    'AKIAABCDEFGHIJKLMNOP',
    `AIza${'A'.repeat(35)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  ];
  for (const secret of cases) {
    const out = redactSecrets(`credential line\n${secret}\nend`);
    assert.equal(out.includes(secret), false, secret);
    assert.match(out, /\[redacted\]/);
    assert.match(out, /credential line\n/);
    assert.match(out, /\nend$/);
  }
});

test('a PEM private key block is redacted as one unit', () => {
  const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nq9Xy7\n-----END RSA PRIVATE KEY-----';
  const out = redactSecrets(`before\n${block}\nafter`);
  assert.equal(out.includes('MIIEpAIBAAKCAQEA'), false);
  assert.equal(out.includes('BEGIN RSA PRIVATE KEY'), false);
  assert.match(out, /^before\n\[redacted\]\nafter$/);
});

test('the leak shape: a bare token under a username and an email line', () => {
  const leaked = 'xK9!mQ2vR7tZ';
  const out = redactSecrets(`wrote on 3 May\nsomeone@example.invalid\nusername: deploybot\n${leaked}\nthanks`);
  assert.equal(out.includes(leaked), false);
  assert.match(out, /username: deploybot\n\[redacted\]\nthanks/);
});

test('a bare token without a credential neighbourhood is left alone', () => {
  const out = redactSecrets('the release notes\nxK9!mQ2vR7tZ\nthanks');
  assert.match(out, /xK9!mQ2vR7tZ/);
});

test('only strings change: keys, structure, numbers and booleans are preserved', () => {
  const input = { password: { note: 'password=leak1', count: 3 }, list: ['token=leak2', 7, null, true], keep: { a: 1 } };
  const out = redactSecretsWithCount(input);
  assert.deepEqual(Object.keys(out.value), ['password', 'list', 'keep']);
  assert.deepEqual(Object.keys(out.value.password as object), ['note', 'count']);
  assert.equal((out.value.password as { count: number }).count, 3);
  assert.equal(out.value.list[1], 7);
  assert.equal(out.value.list[2], null);
  assert.equal(out.value.list[3], true);
  assert.deepEqual(out.value.keep, { a: 1 });
  assert.equal(JSON.stringify(out.value).includes('leak1'), false);
  assert.equal(JSON.stringify(out.value).includes('leak2'), false);
  assert.equal(out.count, 2);
});

test('clean text is returned unchanged with a zero count', () => {
  const input = { tool: 'chat_search', text: 'ACCEPTED [Überblick 🌱](https://example.com/e) insight 42' };
  const out = redactSecretsWithCount(input);
  assert.deepEqual(out.value, input);
  assert.equal(out.count, 0);
});

test('one megabyte of adversarial input finishes under 50 ms', () => {
  const shapes = [
    'username:',
    'aB3!xY9zQ2w!pL5',
    `Bearer ${'A'.repeat(2000)}`,
    `${'x'.repeat(500)}.${'y'.repeat(500)}.${'z'.repeat(500)}`,
    `-----BEGIN ${'K'.repeat(30)}`,
    `password=${'p'.repeat(2000)}`,
    'sk-' + 'Q'.repeat(2000),
    'a'.repeat(4000),
  ].join('\n');
  let adversarial = '';
  while (adversarial.length < 1024 * 1024) adversarial += shapes + '\n';
  assert.ok(adversarial.length >= 1024 * 1024);
  redactSecrets(adversarial);
  // The minimum of several runs is the CPU cost without scheduler noise from the shared host.
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    const out = redactSecrets(adversarial);
    best = Math.min(best, performance.now() - started);
    assert.match(out, /\[redacted\]/);
  }
  assert.ok(best < 50, `redaction took ${best.toFixed(1)} ms`);
});

test('a line longer than the scan window is redacted through its window and keeps its tail', () => {
  const tail = 'z'.repeat(200_000);
  const out = redactSecrets(`password=sekr1t ${tail}`);
  assert.equal(out.includes('sekr1t'), false);
  assert.equal(out.endsWith(tail), true);
});

test('the marker is the documented literal', () => {
  assert.equal(REDACTED, '[redacted]');
});
