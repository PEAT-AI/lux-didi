import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installEvalGuards } from './clock.js';
import { loadCases, loadToolMap, runCase, runSuite, formatSummary } from './runner.js';
import { brokenPlans, scriptedProvider, type TurnPlan, type TurnProvider } from './scripted.js';
import type { EvalCase } from './types.js';

const root = process.argv[2] ?? process.cwd();
const casesDir = join(root, 'server/eval/cases');
const toolMapPath = join(root, 'server/eval/tool-map.json');
/**
 * The case the synthetic probes are cut from, named so the self-test never depends on which file loads
 * first. It is a real ported case: a scripted ask with a resolvable contact and one mail thread.
 */
const SEED_CASE_ID = 'email-01';
/** The four red cases that assert a clarifying or refusing answer with an empty store: testable today. */
const EXERCISED_RED_CASES = ['email-09', 'email-10', 'mattermost-07', 'mattermost-08'];

const lines: string[] = [];
const check = (name: string, body: () => void | Promise<void>): Promise<void> =>
  Promise.resolve().then(body).then(() => { lines.push(`ok ${name}`); }, error => {
    lines.push(`not ok ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });

function seedCase(cases: readonly EvalCase[]): EvalCase {
  const found = cases.find(entry => entry.id === SEED_CASE_ID);
  if (!found) throw new Error(`the self-test seed case ${SEED_CASE_ID} is not in the catalogue`);
  return found;
}

function synthetic(cases: readonly EvalCase[], id: string, overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    ...seedCase(cases), id, category: 'email', finals: ['synthetic probe'],
    expected_tools: [], expected_state: {}, spoken_must: [], spoken_must_not: [], red_today: false,
    ...overrides,
  };
}

const providerOf = (plan: TurnPlan): TurnProvider => ({ mode: 'scripted', plan: async () => plan });

/** Scores one utterance against an empty world, for the speech rules that stand on their own. */
async function speechOutcome(cases: readonly EvalCase[], spoken: string, overrides: Partial<EvalCase> = {}) {
  const toolMap = loadToolMap(toolMapPath);
  const probe = synthetic(cases, 'probe-shell', { ...overrides, spoken_must: overrides.spoken_must ?? [] });
  const run = await runCase(probe, { toolMap, provider: providerOf({ calls: [], reply: spoken }) });
  return run.outcome;
}

async function main() {
  const guards = installEvalGuards();
  const toolMap = loadToolMap(toolMapPath);
  const cases = loadCases(casesDir);
  seedCase(cases);

  await check('the 118 public cases are ported and only public_ok cases are here', () => {
    assert.equal(cases.length, 118);
    assert.ok(cases.every(entry => entry.public_ok === true));
  });

  await check('eval mode refuses a network connect and a child process', () => {
    const net = (globalThis as unknown as { fetch: typeof fetch }).fetch;
    assert.throws(() => net('https://example.invalid/'), /eval_guard/);
    assert.ok(guards.blocked() >= 1);
  });

  // F3: the transport both realtime adapters use is the global WebSocket, not node:net.
  await check('eval mode refuses the global WebSocket the realtime adapters open', () => {
    const Socket = (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket;
    assert.throws(() => new Socket('ws://127.0.0.1:9/'), /eval_guard/);
  });

  const blockedBefore = guards.blocked();
  const suite = await runSuite({ casesDir, toolMapPath, provider: scriptedProvider() });
  const blockedDuringSuite = guards.blocked() - blockedBefore;
  await check('no case in a scripted run attempts a network socket', async () => {
    assert.equal(blockedDuringSuite, 0, 'a case tried to open a socket');
  });

  await check('scripted mode: every case whose capability exists passes', () => {
    assert.equal(suite.fail, 0, formatSummary(suite));
    assert.equal(suite.pass + suite.expectedRed, suite.total);
  });
  await check('scripted mode: a case is red only while a capability it needs is planned', async () => {
    const red = cases.filter(entry => entry.red_today);
    assert.equal(red.length, 39);
    for (const entry of red) {
      const run = await runCase(entry, { toolMap, provider: scriptedProvider() });
      if (EXERCISED_RED_CASES.includes(entry.id)) {
        assert.equal(run.outcome.outcome, 'PASS', `${entry.id} must be exercised, not parked as red: ${run.outcome.reasons.join('; ')}`);
        continue;
      }
      assert.equal(run.outcome.outcome, 'EXPECTED_RED', `${entry.id}: ${run.outcome.reasons.join('; ')}`);
      assert.ok((run.outcome.redReason ?? '').length > 0, `${entry.id} carries no red reason`);
    }
    assert.equal(suite.expectedRed, 39 - EXERCISED_RED_CASES.length);
  });
  await check('nothing is audible: every spoken frame in the whole run is recording-only', () => {
    // The sink reports a sink per spoken frame, so a frame that ever went to an audio device would carry
    // another value; the whole suite must produce frames and every one of them must be recording-only.
    assert.ok(suite.spokenSinks.length > 0, 'the run spoke nothing at all');
    assert.deepEqual([...new Set(suite.spokenSinks)], ['recording-only']);
  });
  await check('a wake rings into the recording sink and reaches the alarm state', async () => {
    const wake = cases.find(entry => entry.id === 'wake-01');
    assert.ok(wake);
    const run = await runCase(wake, { toolMap, provider: scriptedProvider() });
    assert.equal(run.outcome.outcome, 'PASS', run.outcome.reasons.join('; '));
    assert.deepEqual(run.outcome.spokenSinks, ['recording-only']);
    assert.ok(run.outcome.spoken.length > 0, 'the wake spoke nothing');
  });
  await check('no real timer is armed by the harness', () => {
    assert.equal(guards.realTimers(), 0);
  });

  // F1: the claim, both ways. "no invites were sent" is the honest sentence A3 requires.
  await check('an invitation claim fails and the honest denial passes', async () => {
    const denied = await speechOutcome(cases, 'Alex, the block is on your calendar, no invites were sent', { spoken_must: ['no invites were sent'] });
    assert.equal(denied.outcome, 'PASS', `the A3 sentence must pass: ${denied.reasons.join('; ')}`);
    const deniedInvitations = await speechOutcome(cases, 'Alex, no invitations were sent for that block');
    assert.equal(deniedInvitations.outcome, 'PASS', deniedInvitations.reasons.join('; '));
    const claimed = await speechOutcome(cases, 'Alex, I invited Stewart to the block');
    assert.equal(claimed.outcome, 'FAIL');
    assert.ok(claimed.reasons.includes('speech_claims_invitation'), claimed.reasons.join('; '));
    const claimedSent = await speechOutcome(cases, 'Alex, invitations were sent to the team');
    assert.equal(claimedSent.outcome, 'FAIL');
    assert.ok(claimedSent.reasons.includes('speech_claims_invitation'), claimedSent.reasons.join('; '));
  });

  const broken = [
    { name: 'a claimed draft with no store object fails', plan: brokenPlans.draftWithoutObject('here is your reply', []) },
    { name: 'a finished meeting spoken as upcoming fails', plan: brokenPlans.finishedMeetingAsUpcoming('morning review', [], 'Morning review') },
    { name: 'an alarm set from a non-alarm turn fails', plan: brokenPlans.alarmFromNonAlarmTurn([], { fire_at: '2026-10-31T07:00:00+08:00', label: null }) },
  ];
  for (const entry of broken) {
    await check(entry.name, async () => {
      const run = await runCase(synthetic(cases, `broken-${entry.name.split(' ')[0]}`), { toolMap, provider: providerOf(entry.plan) });
      assert.equal(run.outcome.outcome, 'FAIL', `expected a failure, got ${run.outcome.outcome}`);
    });
  }

  await check('an unfaked connector call fails the case loudly', async () => {
    const run = await runCase(synthetic(cases, 'broken-unfaked'), { toolMap, provider: providerOf({ calls: [{ tool: 'gmail_send_message', args: {} }], reply: '' }) });
    assert.equal(run.outcome.outcome, 'FAIL');
    assert.ok(run.outcome.reasons.some(reason => /eval_tool_unmapped|call_aborted/.test(reason)), run.outcome.reasons.join('; '));
  });

  await check('a red case flips to a hard failure once its capability exists', async () => {
    const red = cases.find(entry => entry.id === SEED_CASE_ID);
    assert.ok(red);
    const shipped = await runCase(red, { toolMap, implemented: ['email_draft'], provider: providerOf({ calls: [], reply: 'nothing to report' }) });
    assert.notEqual(shipped.outcome.outcome, 'EXPECTED_RED', 'the case stayed EXPECTED_RED with the capability declared');
    assert.equal(shipped.outcome.outcome, 'FAIL');
  });

  await check('the scripted answer only claims a draft the fake store holds', async () => {
    const draftCase = cases.find(entry => entry.id === SEED_CASE_ID);
    assert.ok(draftCase);
    const run = await runCase(draftCase, { toolMap, implemented: ['email_draft'], provider: scriptedProvider() });
    assert.equal(run.outcome.outcome, 'PASS', `${SEED_CASE_ID} under a shipped draft capability: ${run.outcome.reasons.join('; ')}`);
  });

  console.log(lines.join('\n'));
  console.log(`\n${formatSummary(suite)}`);
}

main().catch(error => {
  console.log(lines.join('\n'));
  console.error(`\nSELFTEST FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
