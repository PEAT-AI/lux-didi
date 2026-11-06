/**
 * The memory test (issue #912 part B) on the synthetic fixture.
 *
 * Asserts the two planted defects are reported as misses with the release gate
 * closed, the clean variant passes, a verifier never turns a failure into a pass,
 * and the runner leaves the store copy byte for byte as it found it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ABSTENTION_MARKERS, BARS, openaiVerifier, readAnswers, readGolden, runEval,
  type MemoryEvalReport, type RestoreTool,
} from '../memory/eval-runner.js';
import { GOLDEN_FILE, answersFile, buildEvalStore } from './fixtures/memory-eval/build.js';

const ROOT = process.cwd();

async function withStore<T>(variant: 'defect' | 'clean', body: (store: string, work: string) => Promise<T>): Promise<T> {
  const work = mkdtempSync(join(tmpdir(), `memory-eval-${variant}-`));
  const store = buildEvalStore(join(work, 'store'), variant);
  store.close();
  try {
    return await body(join(work, 'store'), work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function cli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [join(ROOT, 'scripts', 'didi-memory-eval'), ...args], {
      cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? -1, stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') };
  }
}

function readReport(path: string): MemoryEvalReport {
  return JSON.parse(readFileSync(path, 'utf8')) as MemoryEvalReport;
}

test('the planted fixture closes the gate and names both defects', async () => {
  await withStore('defect', async (store, work) => {
    const out = join(work, 'report.json');
    const result = cli(['--store', store, '--golden', GOLDEN_FILE, '--answers', answersFile('defect'), '--out', out]);
    assert.equal(result.status, 1, `the gate must close on the planted fixture:\n${result.stderr}${result.stdout}`);
    const report = readReport(out);
    const stale = report.items_detail.find(item => item.id === 'm4-landline')!;
    assert.deepEqual(stale.misses.filter(miss => miss.startsWith('start_forbidden')), ['start_forbidden:555-0100'],
      'the stale landline number in the start block is the planted defect');
    const denial = report.items_detail.find(item => item.id === 'm5-plumber')!;
    assert.ok(denial.misses.includes('denial_before_search'), `the denial before search must be a miss: ${denial.misses.join(',')}`);
    assert.ok(report.overall.falseMemory >= 1, 'a leaked forbidden fact counts as false memory');
    assert.equal(report.exitCode, 1);
    assert.ok(report.bars.some(bar => bar.id === 'falseMemory' && !bar.met));
    assert.ok(report.bars.some(bar => bar.id === 'correctionsGreen' && !bar.met));
  });
});

test('the clean variant passes every bar', async () => {
  await withStore('clean', async (store, work) => {
    const out = join(work, 'report.json');
    const result = cli(['--store', store, '--golden', GOLDEN_FILE, '--answers', answersFile('clean'), '--out', out]);
    assert.equal(result.status, 0, `the clean variant must pass:\n${result.stderr}${result.stdout}`);
    const report = readReport(out);
    assert.deepEqual(report.bars.filter(bar => !bar.met), []);
    assert.equal(report.overall.falseMemory, 0);
    assert.equal(report.overall.dateErrors, 0);
    assert.equal(report.overall.firstAnswer.ratio, 1);
    assert.ok((report.overall.startCoverage.ratio ?? 0) >= BARS.startCoverage);
    // Every class the fixture covers is scored; class 7's restore tool is absent on base.
    for (const key of ['1', '2', '3', '4', '5', '6', '7']) assert.ok(report.classes[key]!.scored >= 1, `class ${key} has no scored item`);
    assert.equal(report.notRun['restore:tool_missing'], 1);
    assert.ok((report.notRun['answer:no_runner'] ?? 0) >= 1);
  });
});

test('the cutoff keeps a later call from leaking backward', async () => {
  await withStore('clean', async (store, work) => {
    const out = join(work, 'report.json');
    cli(['--store', store, '--golden', GOLDEN_FILE, '--answers', answersFile('clean'), '--out', out]);
    const report = readReport(out);
    const plumber = report.items_detail.find(item => item.id === 'm5-plumber')!;
    assert.equal(plumber.cutoff.session, 'live-08');
    assert.equal(plumber.cutoff.at, '2026-11-02T09:30:00.000Z');
    assert.deepEqual(plumber.misses, [], 'the rate from live-10 sits after the cutoff and must not be scored');
    assert.ok(plumber.start.status === 'not_run');
  });
});

test('the runner never writes to the store it reads', async () => {
  await withStore('clean', async (store, work) => {
    const before = createHash('sha256').update(readFileSync(join(store, 'state.sqlite'))).digest('hex');
    const mtime = statSync(join(store, 'state.sqlite')).mtimeMs;
    cli(['--store', store, '--golden', GOLDEN_FILE, '--out', join(work, 'report.json')]);
    const after = createHash('sha256').update(readFileSync(join(store, 'state.sqlite'))).digest('hex');
    assert.equal(after, before, 'the store copy is unchanged');
    assert.equal(statSync(join(store, 'state.sqlite')).mtimeMs, mtime);
  });
});

test('a verifier error is a failed item, never a pass, and it is only called after a substring miss', async () => {
  const golden = join(mkdtempSync(join(tmpdir(), 'memory-eval-golden-')), 'golden.jsonl');
  const line = {
    id: 'v1', class: 1, query: 'coffee', eval_at: '2026-11-06T08:30:00+00:00', cutoff_session: 'live-10',
    gold_turn_ids: [], required: ['a phrase the block does not carry'], forbidden: [], expect_in_start_block: true,
    expect_search: false, expect_abstain: false, notes: 'verifier seam',
  };
  writeFileSync(golden, `${JSON.stringify(line)}\n`);
  try {
    await withStore('clean', async store => {
      const calls: string[] = [];
      const failed = await runEval({
        store, golden,
        verifier: async input => { calls.push(input.item.id); throw new Error('provider_unavailable'); },
      });
      assert.deepEqual(calls, ['v1'], 'the verifier is called once, only because no substring matched');
      assert.equal(failed.exitCode, 1);
      assert.ok(failed.report.items_detail[0]!.misses.some(miss => miss.startsWith('verifier_error:provider_unavailable')));
      const passed = await runEval({
        store, golden,
        verifier: async () => ({ matched_required: ['a phrase the block does not carry'], leaked_forbidden: [], denied_before_search: false }),
      });
      assert.deepEqual(passed.report.items_detail[0]!.misses, []);
      const untouched = await runEval({ store, golden });
      assert.ok(untouched.report.items_detail[0]!.misses.includes('start_required:a phrase the block does not carry'));
    });
  } finally {
    rmSync(join(golden, '..'), { recursive: true, force: true });
  }
});

test('the golden and answer files are read strictly', () => {
  const items = readGolden(GOLDEN_FILE);
  assert.equal(items.length, 12);
  assert.deepEqual([...new Set(items.map(item => item.class))].sort(), [1, 2, 3, 4, 5, 6, 7]);
  const answers = readAnswers(answersFile('defect'));
  assert.equal(answers.kind, 'recorded-first-answers');
  assert.ok(answers.answers.some(answer => answer.searched === false), 'the defect fixture replays a denial before search');
  assert.ok(ABSTENTION_MARKERS.some(marker => 'I found nothing that says so'.toLowerCase().includes(marker)));
  const dir = mkdtempSync(join(tmpdir(), 'memory-eval-bad-'));
  try {
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, '{"id":"x","class":9}\n');
    assert.throws(() => readGolden(bad), /class 1\.\.7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses an unreadable store and names the missing flags', async () => {
  const work = mkdtempSync(join(tmpdir(), 'memory-eval-cli-'));
  try {
    const out = join(work, 'report.json');
    const missing = cli(['--golden', GOLDEN_FILE]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--golden and --out are required/);
    const missingStore = cli(['--store', join(work, 'not-a-store-there'), '--golden', GOLDEN_FILE, '--out', out]);
    assert.equal(missingStore.status, 2);
    assert.match(missingStore.stderr, /memory_eval_store_unreadable/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('--strict counts a not_run stage as a miss, and --data-dir reads the same copy', async () => {
  await withStore('clean', async (store, work) => {
    const out = join(work, 'report.json');
    const loose = cli(['--store', store, '--golden', GOLDEN_FILE, '--out', out]);
    assert.equal(loose.status, 0);
    const strict = cli(['--store', store, '--golden', GOLDEN_FILE, '--out', out, '--strict']);
    assert.equal(strict.status, 1, 'a not_run stage is a miss under --strict');
    const report = readReport(out);
    assert.equal(report.strict, true);
    assert.equal(report.items_detail.find(item => item.id === 'm7-restore')!.verdict, 'miss');
    const viaDataDir = cli(['--data-dir', store, '--golden', GOLDEN_FILE, '--out', out]);
    assert.equal(viaDataDir.status, 0, '--data-dir names the same store copy');
  });
});

test('the OpenAI verifier sends one temperature-0 structured call and fails closed on a transport error', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ matched_required: ['x'], leaked_forbidden: [], denied_before_search: false }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  const verifier = openaiVerifier({ apiKey: 'test-key', model: 'verifier-model', transport });
  const verdict = await verifier({
    item: {
      id: 'v1', class: 1, query: 'q', eval_at: '2026-11-06T08:30:00+00:00', cutoff_session: 'live-10',
      gold_turn_ids: [], required: ['x'], forbidden: [], expect_in_start_block: true, expect_search: false,
      expect_abstain: false, notes: '',
    },
    stage: 'start', text: 'a text',
  });
  assert.deepEqual(verdict.matched_required, ['x']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.body['temperature'], 0);
  assert.equal(requests[0]!.body['model'], 'verifier-model');
  const failing = openaiVerifier({
    apiKey: 'test-key', model: 'verifier-model',
    transport: (async () => new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => failing({
    item: {
      id: 'v1', class: 1, query: 'q', eval_at: '2026-11-06T08:30:00+00:00', cutoff_session: 'live-10',
      gold_turn_ids: [], required: ['x'], forbidden: [], expect_in_start_block: true, expect_search: false,
      expect_abstain: false, notes: '',
    },
    stage: 'start', text: 'a text',
  }), /verifier_http_500/);
});

test('the CLI refuses --verifier without a key instead of grading silently', async () => {
  const work = mkdtempSync(join(tmpdir(), 'memory-eval-cli-'));
  try {
    const { OPENAI_API_KEY: _dropped, ...withoutKey } = process.env;
    const result = cli(['--store', join(work, 'store'), '--golden', GOLDEN_FILE, '--out', join(work, 'r.json'), '--verifier', 'some-model'], withoutKey);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /memory_eval_verifier_key_missing/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the restore seam calls a registered tool and refuses a wrong conversation', async () => {
  const golden = join(mkdtempSync(join(tmpdir(), 'memory-eval-restore-')), 'golden.jsonl');
  writeFileSync(golden, `${JSON.stringify({
    id: 'r1', class: 7, query: 'continue from the passport conversation', eval_at: '2026-11-06T08:30:00+00:00',
    cutoff_session: 'live-08', gold_turn_ids: ['801'], required: [], forbidden: [], expect_in_start_block: false,
    expect_search: false, expect_abstain: false, notes: 'restore seam',
  })}\n`);
  try {
    await withStore('clean', async store => {
      // No registered tool on base: the stage says so instead of inventing a fidelity.
      const absent = await runEval({ store, golden });
      assert.equal(absent.report.items_detail[0]!.restore.status, 'not_run');
      assert.deepEqual(absent.report.items_detail[0]!.notRun, ['restore:tool_missing']);
      assert.equal(absent.report.overall.restoreFidelity, null);
      // A registered tool is called, and the conversation it names is scored.
      const right: RestoreTool = { resolve: () => ({ sessionId: 'live-08' }) };
      const scored = await runEval({ store, golden, restoreTool: right });
      assert.equal(scored.report.items_detail[0]!.restore.status, 'scored');
      assert.equal(scored.report.items_detail[0]!.restore.fidelity, 1);
      assert.equal(scored.report.overall.restoreFidelity, 1);
      assert.deepEqual(scored.report.items_detail[0]!.misses, []);
      // The wrong conversation is a miss, never a pass.
      const wrong: RestoreTool = { resolve: () => ({ sessionId: 'live-05' }) };
      const failed = await runEval({ store, golden, restoreTool: wrong });
      assert.equal(failed.report.items_detail[0]!.restore.fidelity, 0);
      assert.ok(failed.report.items_detail[0]!.misses.includes('restore_miss'));
      assert.equal(failed.exitCode, 1);
      const nothing: RestoreTool = { resolve: () => null };
      assert.ok((await runEval({ store, golden, restoreTool: nothing })).report.items_detail[0]!.misses.includes('restore_miss'));
    });
  } finally {
    rmSync(join(golden, '..'), { recursive: true, force: true });
  }
});

test('the CLI refuses argv it does not understand, so a typo cannot switch a stage off', async () => {
  await withStore('clean', async (store, work) => {
    const args = ['--store', store, '--golden', GOLDEN_FILE, '--out', join(work, 'report.json')];
    const typo = cli([...args, '--ansers', answersFile('clean')]);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /unknown_option: --ansers/);
    const stray = cli([...args, 'strict']);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /unexpected_argument: strict/);
    const twice = cli([...args, '--strict', '--strict']);
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /option_given_twice: --strict/);
    const valueMissing = cli([...args, '--answers']);
    assert.equal(valueMissing.status, 2);
    assert.match(valueMissing.stderr, /--answers needs a value/);
    const known = cli([...args, '--strict']);
    assert.equal(known.status, 1, 'the known flags still run');
  });
});

test('every bar threshold is a BARS constant, so one place confirms them', () => {
  assert.deepEqual(Object.keys(BARS).sort(),
    ['correctionMisses', 'dateErrors', 'falseMemory', 'onDemandOverall', 'onDemandPerClass', 'restoreMisses', 'startCoverage']);
  const code = readFileSync(join(ROOT, 'server', 'memory', 'eval-runner.ts'), 'utf8');
  assert.equal(/bar:\s*\d/.test(code), false, 'no bar may carry a literal threshold outside BARS');
});
