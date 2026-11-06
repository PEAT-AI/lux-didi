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
  ABSTENTION_MARKERS, BARS, readAnswers, readGolden, runEval, type MemoryEvalReport,
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

function cli(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [join(ROOT, 'scripts', 'didi-memory-eval'), ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
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
