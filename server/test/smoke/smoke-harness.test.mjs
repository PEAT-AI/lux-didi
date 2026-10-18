// Harness tests for #258: the smoke test must never run stale code, and a host launch timeout under load
// must say so. These tests never start the real host, make no model turn and print no credential.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { READY_TIMEOUT_MS, spawnSupervised, stopSupervised, waitForReady } from './strict-supervisor.mjs';
import { awaitRunReceipt, launchTimeoutMs, noHostResults, researchDriver, researchFailureNote, RESEARCH_DRIVERS, RESEARCH_PROBES, researchTurnResult, sourceSummary, stageProviderConfig, supervisorNote } from './probes.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const smokeSource = join(repoRoot, 'scripts/smoke.sh');

// A child that holds its stdout silent and stays alive: the host that never reaches the ready frame.
test('a launch that never readies names the timeout and load and skips the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-smoke-harness-'));
  try {
    const silent = join(dir, 'silent.mjs');
    await writeFile(silent, 'setInterval(() => {}, 1000);\n');
    const host = spawnSupervised({ serverEntry: silent, dataDir: dir, webRoot: dir });
    const launch = await waitForReady(host, 300);
    try {
      assert.equal(launch.status, 'timeout');
      assert.ok(launch.ms >= 300, `elapsed ${launch.ms} ms`);
      assert.match(supervisorNote(launch, host), /^launch=timeout after=0\.[0-9] load=\d+\.\d+\/\d+\.\d+\/\d+\.\d+$/);
      const skips = noHostResults();
      assert.deepEqual(skips.map(row => row.id), ['probe2-connectors', 'probe3-text-turn', 'probe4-voice-turn', 'probe5-research', 'probe6-meetings', 'probe7-mail', 'probe8-chat', 'probe9-knowledge', 'probe10-calendar']);
      for (const row of skips) {
        assert.equal(row.ok, false);
        assert.equal(row.skip, true);
        assert.equal(row.note, '(no host)');
      }
    } finally { await stopSupervised(host); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the launch budget is SMOKE_LAUNCH_TIMEOUT_S seconds, defaulting to the current 6 s', () => {
  assert.equal(READY_TIMEOUT_MS, 6000);
  assert.equal(launchTimeoutMs({}), READY_TIMEOUT_MS);
  assert.equal(launchTimeoutMs({ SMOKE_LAUNCH_TIMEOUT_S: '1' }), 1000);
  assert.equal(launchTimeoutMs({ SMOKE_LAUNCH_TIMEOUT_S: '2.5' }), 2500);
  assert.equal(launchTimeoutMs({ SMOKE_LAUNCH_TIMEOUT_S: 'nonsense' }), READY_TIMEOUT_MS);
  assert.equal(launchTimeoutMs({ SMOKE_LAUNCH_TIMEOUT_S: '-1' }), READY_TIMEOUT_MS);
});

// Build a throwaway repo whose scripts/smoke.sh is the real script, with a fake npm and node on PATH so no
// real build runs and no probe host starts. The fake npm records its argv and rewrites the dist entry.
async function smokeFixture({ distTime, sourceTime, buildOk = true, nodeExit = 0 }) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-smoke-build-'));
  const bin = join(dir, 'bin');
  const npmLog = join(dir, 'npm.log');
  const nodeLog = join(dir, 'node.log');
  const distEntry = join(dir, 'server/dist/host/index.js');
  await mkdir(bin, { recursive: true });
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await mkdir(join(dir, 'server/dist/host'), { recursive: true });
  await writeFile(join(dir, 'scripts/smoke.sh'), await readFile(smokeSource));
  await writeFile(join(dir, 'server/src.ts'), 'export {};\n');
  if (distTime) await writeFile(distEntry, '// built\n');
  if (distTime) await utimes(distEntry, distTime, distTime);
  await utimes(join(dir, 'server/src.ts'), sourceTime, sourceTime);
  const npm = join(bin, 'npm');
  await writeFile(npm, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${npmLog}'\n: > '${distEntry}'\nexit ${buildOk ? 0 : 1}\n`);
  const node = join(bin, 'node');
  // smoke.sh reads the probes' declared deadlines through one module import before it runs anything (#364);
  // the stub answers that call with a budget and the ids a run owes, and answers it successfully even when the
  // probe run itself is meant to fail, then stays silent for every probe run.
  await writeFile(node, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${nodeLog}'\ncase "$*" in *--input-type=module*) printf '600000\\nprobe1-strict-supervisor\\n'; exit 0 ;; esac\nexit ${nodeExit}\n`);
  await chmod(npm, 0o755);
  await chmod(node, 0o755);
  return { dir, bin, npmLog, nodeLog, distEntry };
}

function runSmoke(fixture) {
  return spawnSync('bash', ['scripts/smoke.sh'], {
    cwd: fixture.dir,
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, NODE: join(fixture.bin, 'node'), TMPDIR: fixture.dir },
    encoding: 'utf8',
  });
}

test('smoke.sh builds a missing or stale server/dist before any probe', async () => {
  const older = new Date('2024-01-01T00:00:00Z');
  const newer = new Date('2026-01-01T00:00:00Z');
  const fixtures = [
    await smokeFixture({ distTime: older, sourceTime: newer }), // stale dist
    await smokeFixture({ distTime: null, sourceTime: newer }), // missing dist
    await smokeFixture({ distTime: newer, sourceTime: older }), // fresh dist
  ];
  try {
    const [stale, missing, fresh] = fixtures.map(runSmoke);
    assert.equal(stale.status, 0, stale.stderr);
    assert.ok(existsSync(fixtures[0].npmLog), 'stale dist must trigger the build');
    assert.equal(missing.status, 0, missing.stderr);
    assert.ok(existsSync(fixtures[1].npmLog), 'missing dist must trigger the build');
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(existsSync(fixtures[2].npmLog), false, 'a fresh dist must not rebuild');
    for (const [index, result] of [stale, missing, fresh].entries()) {
      assert.ok(existsSync(fixtures[index].nodeLog), 'probes run only once the dist is proven');
    }
  } finally {
    for (const fixture of fixtures) await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('smoke.sh reports a FAIL line and runs no probe when the dist cannot be built', async () => {
  const fixture = await smokeFixture({ distTime: null, sourceTime: new Date(), buildOk: false });
  try {
    const result = runSmoke(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^FAIL probe0-build /m);
    assert.equal(existsSync(fixture.nodeLog), false, 'no probe runs on a failed build');
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

// #260: probe5 must read the run's own driver, never re-derive it from selectorMs and fallbackUsed.
// #280: the routed start writes its own run line, so `routed` joins the closed driver set.
test('probe5 accepts only the four drivers and fails on a missing one', () => {
  assert.deepEqual(RESEARCH_DRIVERS, ['selector', 'fallback', 'single-source-hint', 'routed']);
  assert.equal(researchDriver({ driver: 'selector' }), 'selector');
  assert.equal(researchDriver({ driver: 'fallback' }), 'fallback');
  assert.equal(researchDriver({ driver: 'single-source-hint' }), 'single-source-hint');
  assert.equal(researchDriver({ driver: 'routed' }), 'routed');
  assert.equal(researchDriver({}), null, 'a run line without a driver must fail');
  assert.equal(researchDriver({ driver: 'owner secret' }), null);
  assert.equal(researchDriver({ selectorMs: 20, fallbackUsed: false }), null, 'the old derivation must not pass');
});

// #260: the failure note keeps the not-called metadata, so a skipped research call is explainable.
test('probe5 failure note keeps the not-called metadata', () => {
  const note = researchFailureNote({ stage: 'call', calls: 0, runs: 0, outputFragments: 3, outputChars: 120, otherToolNames: ['search_knowledge'], otherToolCalls: 1, turnCompleteMs: 412 });
  assert.match(note, /stage=call/);
  assert.match(note, /calls=0/);
  assert.match(note, /output_fragments=3/);
  assert.match(note, /output_chars=120/);
  assert.match(note, /other_tools=search_knowledge/);
  assert.match(note, /other_tool_calls=1/);
  assert.match(note, /turn_complete_ms=412/);
});

// #260: a failed run keeps the smoke data dir and prints its path; a green run keeps nothing new.
test('smoke.sh keeps a failed run and prints its path', async () => {
  const fixture = await smokeFixture({ distTime: null, sourceTime: new Date(), nodeExit: 1 });
  try {
    const result = runSmoke(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^KEEP /m);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

// #271: a turn may make more than one research call (start then continue, or two researchIds). The probe
// must aggregate the real items of every research subcall in the turn, name the call count in its line, and
// still fail when research was never called.
const chatProbe = RESEARCH_PROBES.find(spec => spec.id === 'probe8-chat');

test('probe8 aggregates chat items across two research calls on one researchId', () => {
  const runs = [{ researchId: 'r1', status: 'answered', rounds: 2, replyBytes: 2600, sources: [{ disposition: 'completed' }], driver: 'selector' }];
  const subcalls = [
    { tool: 'mattermost_search', items: 12, keptBytes: 2600, queryAuthor: 'user' },
    { tool: 'mattermost_search', items: 4, keptBytes: 400, queryAuthor: 'user' },
  ];
  const turn = researchTurnResult({ calls: 2, runs, subcalls, enforce: false });
  const summary = sourceSummary(turn, 'chat');
  assert.equal(summary.items, 16, 'both subcalls of the turn must count');
  assert.equal(summary.calls, 2, 'the probe line must name the call count');
  assert.equal(chatProbe.check(summary), true);
});

test('probe8 counts chat items when the turn made two researchIds', () => {
  const runs = [
    { researchId: 'r1', status: 'answered', rounds: 1, replyBytes: 2600, sources: [{ disposition: 'completed' }], driver: 'selector' },
    { researchId: 'r2', status: 'answered', rounds: 1, replyBytes: 2600, sources: [{ disposition: 'completed' }], driver: 'selector' },
  ];
  const subcalls = [{ tool: 'mattermost_search', items: 7, keptBytes: 2600, queryAuthor: 'user' }];
  const turn = researchTurnResult({ calls: 2, runs, subcalls, enforce: false });
  const summary = sourceSummary(turn, 'chat');
  assert.equal(summary.items, 7, 'chat items from the first researchId must count');
  assert.equal(summary.calls, 2);
  assert.equal(chatProbe.check(summary), true);
});

test('probe8 still fails when research was never called', () => {
  const turn = researchTurnResult({ calls: 0, runs: [], subcalls: [], enforce: false });
  const summary = sourceSummary(turn, 'chat');
  assert.equal(turn.ok, false);
  assert.equal(summary.items, 0);
  assert.equal(chatProbe.check(summary), false);
});

// #420: the routed run writes its terminal research_run line from the tool's finally, after every source
// settles, so the first answer always lands before the receipt. A probe that reads host.log once at the first
// answer reports runs=0 on a good run, so it keeps polling the appended log on the same tick instead.
const answeredReceipt = (researchId) => `${JSON.stringify({ event: 'research_run', researchId, questionClass: 'lookup', rounds: 1, perRound: [], stopReason: 'answered', status: 'answered', replyBytes: 1800, sources: [{ source: 'mattermost', disposition: 'completed' }], driver: 'selector' })}\n`;

function syntheticLog({ receiptAtMs, line }) {
  const clock = { ms: 0 };
  return {
    clock,
    readAppended: async () => (clock.ms >= receiptAtMs ? line : ''),
    now: () => clock.ms,
    sleep: async ms => { clock.ms += ms; },
  };
}

test('probe5 waits out the run receipt that lands after the first answer and classifies it as a run', async () => {
  const log = syntheticLog({ receiptAtMs: 6000, line: answeredReceipt('r5') });
  const receipt = await awaitRunReceipt({ ...log, deadline: 90000, tickMs: 1000 });
  assert.equal(receipt.runs.length, 1, 'the receipt written 6 s after the answer must still be read');
  assert.equal(log.clock.ms, 6000, 'the poll stops on the tick the receipt appears, not at the deadline');
  const turn = researchTurnResult({ calls: 1, runs: receipt.runs, subcalls: receipt.subcalls, outputChars: 900, outputAtResult: 100 });
  assert.equal(turn.ok, true, JSON.stringify(turn));
  assert.equal(turn.stage, 'turn');
  assert.equal(turn.rounds, 1, 'the answered run of this session is what the turn reports');
  assert.equal(turn.driver, 'selector');
});

test('probe5 still fails at stage=runs when no run line arrives before the question deadline', async () => {
  const log = syntheticLog({ receiptAtMs: Infinity, line: '' });
  const receipt = await awaitRunReceipt({ ...log, deadline: 4000, tickMs: 1000 });
  assert.equal(receipt.runs.length, 0);
  assert.equal(log.clock.ms, 4000, 'the wait is bounded by the question deadline, never open ended');
  const turn = researchTurnResult({ calls: 1, runs: receipt.runs });
  assert.equal(turn.ok, false);
  assert.equal(turn.stage, 'runs');
});

// #397: a probe host must never be handed the installed app's own provider config, so the probes stage a
// private copy first and run against it. Key file modes survive the copy and no key material is printed.
test('probes stage the installed provider config into a private temp copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-smoke-config-copy-'));
  const source = join(dir, 'installed', 'provider-config');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'mcp.json'), '{"schemaVersion":1,"endpoints":[]}\n');
  await writeFile(join(source, 'openai-primary.json'), '{"schemaVersion":1,"keyReference":"openai-primary","key":"synthetic_NEVER_PRINT"}\n');
  await chmod(join(source, 'openai-primary.json'), 0o600);
  const staged = await stageProviderConfig(source);
  try {
    assert.notEqual(staged.configDir, source, 'the host is never pointed at the installed config dir');
    assert.ok(staged.configDir.startsWith(tmpdir()), 'the copy is a temp dir');
    assert.deepEqual((await readdir(staged.configDir)).sort(), ['mcp.json', 'openai-primary.json']);
    const key = join(staged.configDir, 'openai-primary.json');
    assert.equal((await stat(key)).mode & 0o777, 0o600, 'the key file keeps its owner-only mode');
    assert.equal(await readFile(key, 'utf8'), await readFile(join(source, 'openai-primary.json'), 'utf8'));
    assert.equal((await stat(staged.configDir)).mode & 0o777, 0o700, 'the copy directory is private');
  } finally { await staged.remove(); await rm(dir, { recursive: true, force: true }); }
  assert.equal(existsSync(staged.configDir), false, 'the copy is removed, key material is not left behind');
  // The shipping path, not just the helper: the probes stage once and hand that copy to the host.
  const probeSource = await readFile(join(repoRoot, 'server/test/smoke/probes.mjs'), 'utf8');
  assert.equal((probeSource.match(/stageProviderConfig\(/g) ?? []).length, 2, 'probes.mjs defines the staging step and calls it once');
  assert.match(probeSource, /configDir: config\.configDir/, 'the host spawn takes the staged copy, never the installed dir');
});
