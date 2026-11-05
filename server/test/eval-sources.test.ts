import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.env.DIDI_TEST_SOURCE_ROOT ?? 'server/test', '../..');
const runner = join(root, 'scripts/eval-sources.mjs');
const question = { id: 'synthetic', question: 'Synthetic question?', expected_sources: ['vault'], expected_refs: ['synthetic-ref'], required_facts: [['synthetic fact']], forbidden_facts: ['synthetic forbidden'], kind: 'fact' };

test('fake run keeps question and answer private and writes owner-only output', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json');
    const output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify([question]));
    const result = spawnSync(process.execPath, [runner, '--questions', input, '--out', output, '--fake'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
    assert.doesNotMatch(result.stdout, /Synthetic question|synthetic fact/);
    assert.match(result.stdout, /synthetic/);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.results[0].score.correct, true);
    assert.ok(report.results[0].trace.registry_names.includes('read_knowledge'));
    assert.ok(!report.results[0].trace.registry_names.includes('save_to_vault'));
    assert.ok(!report.results[0].trace.registry_names.includes('open'));
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

async function api() { return import(new URL(`file://${runner}`).href); }
test('scoring distinguishes no match, unavailable, incomplete and forbidden claims', async () => {
  const { score } = await api();
  const trace = { status: 'complete', text: 'synthetic fact', findings: [{ source: 'vault', status: 'ok', refs: [{ id: 'synthetic-ref' }] }], opened: ['synthetic-ref'], writes: 0 };
  assert.equal(score(question, trace).correct, true);
  assert.equal(score(question, { ...trace, text: 'synthetic forbidden' }).hard_fail, true);
  assert.equal(score(question, { ...trace, writes: 1 }).hard_fail, true);
  assert.equal(score(question, { ...trace, status: 'incomplete', text: 'I found everything.' }).hard_fail, true);
  assert.equal(score({ ...question, kind: 'abstain', required_facts: [] }, { ...trace, text: 'No match', findings: [{ source: 'vault', status: 'no_match' }] }).correct, true);
  assert.equal(score({ ...question, kind: 'capability' }, { ...trace, unavailable: true }).outcome, 'unavailable');
  assert.equal(score(question, { ...trace, opened: [] }).correct, false);
});
test('real registry projection excludes every effect tool, including an injected write', async () => {
  const { readRegistry } = await api();
  const tools = new Map([['read_knowledge', { effect: 'none' }], ['write_knowledge', { effect: 'external' }], ['open', { effect: 'none' }]]);
  assert.deepEqual([...readRegistry(tools).keys()], ['read_knowledge']);
});
test('fake ceiling stops subsequent questions and reports measured tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json'), output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify([question, { ...question, id: 'second' }]));
    const result = spawnSync(process.execPath, [runner, '--questions', input, '--out', output, '--fake', '--max-tokens', '1'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.results.length, 1);
    assert.equal(report.stopped, 'token_ceiling');
    assert.ok(report.totals.input_tokens > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A parser exception must not echo malformed private input into public console logs.
test('malformed private JSON never leaks through parser errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json');
    writeFileSync(input, '[{"question":"PRIVATE_SYNTHETIC_SENTINEL",oops}]');
    const result = spawnSync(process.execPath, [runner, '--questions', input, '--out', join(dir, 'output.json'), '--fake'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SYNTHETIC_SENTINEL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ruling default token ceiling and dated per-model prices are enforced', async () => {
  const { options, validatePrices, estimateCost } = await api();
  assert.equal(options(['--questions', 'q', '--out', 'o'])['max-tokens'], 800000);
  assert.equal(options(['--questions', 'q', '--out', 'o', '--prices', 'private.json']).prices, 'private.json');
  const prices = validatePrices({ effective_date: '2026-11-05', models: { synthetic: { input_per_million: 2, output_per_million: 8 } } });
  assert.equal(estimateCost(prices, 'synthetic', { input_tokens: 1000000, output_tokens: 500000 }), 6);
  assert.equal(estimateCost(prices, 'unknown', { input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(estimateCost(undefined, 'synthetic', { input_tokens: 1, output_tokens: 1 }), null);
  assert.throws(() => validatePrices({ models: {} }));
});

test('no match does not excuse a fabricated answer on an abstain case', async () => {
  const { score } = await api();
  const q = { ...question, kind: 'abstain', required_facts: [] };
  const trace = { status: 'complete', findings: [{ source: 'vault', status: 'no_match' }], opened: [], writes: 0 };
  assert.equal(score(q, { ...trace, text: 'No match was found.' }).correct, true);
  assert.equal(score(q, { ...trace, text: 'The answer is a fabricated synthetic fact.' }).correct, false);
  assert.equal(score(q, { ...trace, text: 'No match was found. The answer is a fabricated synthetic fact.' }).correct, false);
});

test('structured job status controls incomplete coverage even when helper says complete', async () => {
  const { score } = await api();
  const trace = { status: 'complete', text: 'Here are all the decisions.', opened: ['synthetic-ref'], findings: [{ source: 'vault', status: 'ok', text: JSON.stringify({ job: { status: 'running' } }) }] };
  assert.equal(score(question, trace).hard_fail, true);
  assert.equal(score(question, { ...trace, text: 'This is the complete answer.' }).hard_fail, true);
  assert.equal(score(question, { ...trace, text: 'Only partial results are available.' }).hard_fail, false);
  assert.equal(score(question, { ...trace, findings: [{ source: 'vault', status: 'ok', job: { status: 'failed' } }] }).hard_fail, true);
});

test('missing provider usage remains fatal outside the real workers exception boundary', async () => {
  const { usageTransport, evaluate } = await api();
  const { runWorker } = await import('../tasks/worker.js');
  const { createRegistry } = await import('../tasks/tools.js');
  const { configuredCompanyTools } = await import('../tasks/connectors.js');
  const usage = { input_tokens: 0, output_tokens: 0 };
  const transport = usageTransport(usage, async () => new Response(JSON.stringify({ output: [] }), { status: 200 }));
  let requests = 0;
  const context = { m: { runWorker, createRegistry, configuredCompanyTools }, bindings: [], execute: async () => { throw new Error('unexpected call'); }, infer: async () => { requests++; await transport('https://synthetic.invalid', {}); return { text: '', calls: [] }; } };
  await assert.rejects(evaluate(question, context, usage, 800000), /usage.*unavailable|missing.*usage/i);
  assert.equal(requests, 1);
});


test('CLI reports dated private prices only for the configured model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sources-test-'));
  try {
    const input = join(dir, 'questions.json'), prices = join(dir, 'prices.json');
    writeFileSync(input, JSON.stringify([question]));
    for (const model of ['synthetic', 'unknown']) {
      writeFileSync(prices, JSON.stringify({ effective_date: '2026-11-05', models: { [model]: { input_per_million: 2, output_per_million: 8 } } }));
      const output = join(dir, model + '.json');
      const result = spawnSync(process.execPath, [runner, '--questions', input, '--out', output, '--fake', '--prices', prices], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      if (model === 'synthetic') {
        assert.equal(report.estimated_usd, 0.00018);
        assert.equal(report.results[0].prices_effective_date, '2026-11-05');
        assert.match(result.stdout, /First question.*estimated_usd=/);
      } else {
        assert.equal(report.estimated_usd, undefined);
        assert.doesNotMatch(result.stdout, /estimated_usd/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
