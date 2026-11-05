import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.env.DIDI_TEST_SOURCE_ROOT ?? 'server/test', '../..');
const runner = join(root, 'scripts/eval-sources.mjs');
const question = { id: 'synthetic', question: 'Synthetic question?', expected_sources: ['vault'], expected_refs: ['synthetic-ref'], required_facts: [['synthetic fact']], forbidden_facts: ['synthetic forbidden'], kind: 'fact' };

test('fake run keeps question and answer private and writes owner-only output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json');
    const output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify([question]));
    const result = spawnSync(process.execPath, [runner, '--questions', input, '--out', output, '--fake'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Synthetic question|synthetic fact/);
    assert.match(result.stdout, /synthetic/);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.ok(JSON.parse(readFileSync(output, 'utf8')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects private trace paths in a checkout and invalid question schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json');
    writeFileSync(input, JSON.stringify([question]));
    const inside = spawnSync(process.execPath, [runner, '--questions', input, '--out', join(root, 'never-write-eval.json'), '--fake'], { encoding: 'utf8' });
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /checkout|repository|git/i);
    writeFileSync(input, JSON.stringify([{ ...question, kind: 'unknown' }]));
    const invalid = spawnSync(process.execPath, [runner, '--questions', input, '--out', join(dir, 'output.json'), '--fake'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid|schema|kind/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects invalid token budgets and nonexistent selected ids before execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json');
    const output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify([question]));
    for (const args of [['--max-tokens', '0'], ['--only', 'absent']]) {
      const result = spawnSync(process.execPath, [runner, '--questions', input, '--out', output, '--fake', ...args], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /token|budget|unknown|absent|id/i);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
