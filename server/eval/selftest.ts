import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installEvalGuards, realAdapterOpenCount, virtualClock } from './clock.js';
import { loadCases, loadToolMap, runCase, runSuite, formatSummary } from './runner.js';
import { recordingSink } from './sink.js';
import { brokenPlans, scriptedProvider, type TurnPlan, type TurnProvider } from './scripted.js';
import type { EvalCase } from './types.js';

const root = process.argv[2] ?? process.cwd();
const casesDir = join(root, 'server/eval/cases');
const toolMapPath = join(root, 'server/eval/tool-map.json');
const lines: string[] = [];
const check = (name: string, body: () => void | Promise<void>): Promise<void> =>
  Promise.resolve().then(body).then(() => { lines.push(`ok ${name}`); }, error => {
    lines.push(`not ok ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });

function synthetic(id: string, overrides: Partial<EvalCase> = {}): EvalCase {
  const template = loadCases(casesDir)[0] as EvalCase;
  return {
    ...template,
    id,
    category: 'email',
    finals: ['synthetic probe'],
    expected_tools: [],
    expected_state: {},
    spoken_must: [],
    spoken_must_not: [],
    red_today: false,
    ...overrides,
  };
}

const providerOf = (plan: TurnPlan): TurnProvider => ({ mode: 'scripted', plan: async () => plan });

async function main() {
  const guards = installEvalGuards();
  const toolMap = loadToolMap(toolMapPath);
  const cases = loadCases(casesDir);

  await check('the 118 public cases are ported and only public_ok cases are here', () => {
    assert.equal(cases.length, 118);
    assert.ok(cases.every(entry => entry.public_ok === true));
  });

  await check('eval mode refuses a network connect and a child process', () => {
    const net = (globalThis as unknown as { fetch: typeof fetch }).fetch;
    assert.throws(() => net('https://example.invalid/'), /eval_guard/);
    assert.ok(guards.blocked() >= 1);
  });

  const suite = await runSuite({ casesDir, toolMapPath, provider: scriptedProvider() });
  await check('scripted mode: every non-red case passes', () => {
    assert.equal(suite.fail, 0, formatSummary(suite));
    assert.equal(suite.pass + suite.expectedRed, suite.total);
  });
  await check('scripted mode: every red case reports EXPECTED_RED with a reason', async () => {
    const red = cases.filter(entry => entry.red_today);
    assert.equal(red.length, 39);
    for (const entry of red) {
      const run = await runCase(entry, { toolMap, provider: scriptedProvider() });
      assert.equal(run.outcome.outcome, 'EXPECTED_RED', `${entry.id}: ${run.outcome.reasons.join('; ')}`);
      assert.ok((run.outcome.redReason ?? '').length > 0, `${entry.id} carries no red reason`);
    }
  });
  await check('nothing is audible: the ring lands on the recording sink and the real adapter never opens', async () => {
    const clock = virtualClock(Date.parse('2026-10-30T15:00:00+08:00'));
    const sink = recordingSink(clock);
    sink.speak('wake', 'Alex it is seven');
    assert.deepEqual(sink.entries.map(entry => entry.outputSink), ['recording-only']);
    assert.equal(sink.audible, false);
    assert.equal(realAdapterOpenCount(), 0);
  });
  await check('no real timer is armed by the harness', () => {
    assert.equal(guards.realTimers(), 0);
  });

  const broken = [
    { name: 'a claimed draft with no store object fails', plan: brokenPlans.draftWithoutObject('here is your reply', []) },
    { name: 'a finished meeting spoken as upcoming fails', plan: brokenPlans.finishedMeetingAsUpcoming('morning review', [], 'Morning review') },
    { name: 'an alarm set from a non-alarm turn fails', plan: brokenPlans.alarmFromNonAlarmTurn([], { fire_at: '2026-10-31T07:00:00+08:00', label: null }) },
  ];
  for (const entry of broken) {
    await check(entry.name, async () => {
      const run = await runCase(synthetic(`broken-${entry.name.split(' ')[0]}`), { toolMap, provider: providerOf(entry.plan) });
      assert.equal(run.outcome.outcome, 'FAIL', `expected a failure, got ${run.outcome.outcome}`);
    });
  }

  await check('an unfaked connector call fails the case loudly', async () => {
    const run = await runCase(synthetic('broken-unfaked'), { toolMap, provider: providerOf({ calls: [{ tool: 'gmail_send_message', args: {} }], reply: '' }) });
    assert.equal(run.outcome.outcome, 'FAIL');
    assert.ok(run.outcome.reasons.some(reason => /eval_tool_unmapped|call_aborted/.test(reason)), run.outcome.reasons.join('; '));
  });

  await check('a red case flips to a hard failure once its capability exists', async () => {
    const red = cases.find(entry => entry.id === 'email-01');
    assert.ok(red);
    const shipped = await runCase(red, { toolMap, implemented: ['draft_email'], provider: providerOf({ calls: [], reply: 'nothing to report' }) });
    assert.notEqual(shipped.outcome.outcome, 'EXPECTED_RED', 'the case stayed EXPECTED_RED with the capability declared');
    assert.equal(shipped.outcome.outcome, 'FAIL');
  });

  await check('the scripted answer only claims a draft the fake store holds', async () => {
    const draftCase = cases.find(entry => entry.id === 'email-01');
    assert.ok(draftCase);
    const run = await runCase(draftCase, { toolMap, implemented: ['draft_email'], provider: scriptedProvider() });
    assert.equal(run.outcome.outcome, 'PASS', `email-01 under a shipped draft tool: ${run.outcome.reasons.join('; ')}`);
  });

  console.log(lines.join('\n'));
  console.log(`\n${formatSummary(suite)}`);
}

main().catch(error => {
  console.log(lines.join('\n'));
  console.error(`\nSELFTEST FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
