import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { alarmWorld } from './alarms.js';
import { installEvalGuards } from './clock.js';
import { recordingSink } from './sink.js';
import { scoreCase } from './scorer.js';
import { scriptedProvider, type TurnProvider } from './scripted.js';
import type { CaseOutcome, EvalCase, Outcome, SuiteSummary } from './types.js';
import { fakeWorld, type ToolMap } from './world.js';

export interface RunOptions {
  readonly casesDir: string;
  readonly toolMapPath: string;
  readonly provider?: TurnProvider;
  readonly implemented?: readonly string[];
  readonly id?: string;
  readonly category?: string;
}

export function loadToolMap(path: string): ToolMap {
  return JSON.parse(readFileSync(path, 'utf8')) as ToolMap;
}

export function loadCases(dir: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      cases.push(JSON.parse(line) as EvalCase);
    }
  }
  return cases;
}

export interface CaseRun { outcome: CaseOutcome; seconds: number }

export async function runCase(evalCase: EvalCase, options: { toolMap: ToolMap; provider: TurnProvider; implemented?: readonly string[] }): Promise<CaseRun> {
  const started = process.hrtime.bigint();
  const startUtc = Date.parse(evalCase.setup.clock_T0);
  const sinkText: string[] = [];
  const done = (outcome: Outcome, reasons: readonly string[], redReason: string | undefined, calls: readonly { didi: string }[]): CaseRun => ({
    outcome: { id: evalCase.id, category: evalCase.category, outcome, reasons, ...(redReason ? { redReason } : {}), toolCalls: calls.map(call => call.didi), spoken: sinkText.join(' ') },
    seconds: Number(process.hrtime.bigint() - started) / 1e9,
  });
  if (!Number.isFinite(startUtc)) return done('FAIL', ['setup_clock_invalid'], undefined, []);

  const env = alarmWorld(startUtc);
  const sink = recordingSink(env.clock);
  try {
    const world = fakeWorld({ case: evalCase, clock: env.clock, alarms: env.world, toolMap: options.toolMap, ...(options.implemented ? { implemented: options.implemented } : {}) });
    const reasons: string[] = [];
    let plan;
    try {
      plan = await options.provider.plan({ case: evalCase, world, toolMap: options.toolMap });
    } catch (error) {
      return done('FAIL', [`provider_failed:${error instanceof Error ? error.message : String(error)}`], undefined, []);
    }
    for (const call of plan.calls) {
      try {
        // A refused or unusable answer is the world's own result: the state assertions decide, not this loop.
        world.call(call);
      } catch (error) {
        reasons.push(`call_aborted:${call.tool}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const alarmStates: Record<string, { status: string; fireAtUtc: number; label: string }> = {};
    for (const alarm of world.alarms.list()) {
      const alias = world.alarmAlias(alarm.id) ?? alarm.id;
      alarmStates[alias] = { status: alarm.state === 'pending' ? 'scheduled' : alarm.state, fireAtUtc: alarm.fireAtUtc, label: alarm.label };
    }
    const ringExpected = evalCase.expected_state.at_fire !== undefined;
    if (ringExpected) {
      const next = world.alarms.list().filter(alarm => alarm.state === 'pending' || alarm.state === 'ringing').sort((a, b) => a.fireAtUtc - b.fireAtUtc)[0];
      if (next) {
        const due = world.alarms.advanceTo(next.fireAtUtc);
        const spoken = due.length > 0 ? (plan.ring ?? plan.reply) : '';
        sink.speak(due.length > 0 ? 'wake' : 'silent', spoken);
        sinkText.push(spoken);
      } else {
        reasons.push('at_fire_without_alarm');
      }
    } else {
      sink.speak('reply', plan.reply);
      sinkText.push(plan.reply);
    }
    const scored = scoreCase({
      case: evalCase, world, calls: world.calls, spoken: sinkText.join(' '), toolMap: options.toolMap, alarmStates,
      ...(options.implemented ? { implemented: options.implemented } : {}),
    });
    // An aborted call is the harness saying the case could not run as written, which is never a pass.
    const aborted = reasons.some(reason => /^(call_aborted|harness_error|provider_failed):/.test(reason));
    const outcome = aborted && scored.outcome === 'PASS' ? 'FAIL' : scored.outcome;
    return done(outcome, [...reasons, ...scored.reasons], scored.redReason, world.calls);
  } catch (error) {
    return done('FAIL', [`harness_error:${error instanceof Error ? error.message : String(error)}`], undefined, []);
  } finally {
    env.world.close();
  }
}

export async function runSuite(options: RunOptions): Promise<SuiteSummary> {
  installEvalGuards();
  const toolMap = loadToolMap(options.toolMapPath);
  const provider = options.provider ?? scriptedProvider();
  const all = loadCases(options.casesDir);
  const selected = all.filter(entry =>
    (options.id === undefined || entry.id === options.id) &&
    (options.category === undefined || entry.category === options.category));
  const byCategory: Record<string, { PASS: number; FAIL: number; EXPECTED_RED: number }> = {};
  const failures: CaseOutcome[] = [];
  let pass = 0;
  let fail = 0;
  let expectedRed = 0;
  for (const evalCase of selected) {
    const { outcome } = await runCase(evalCase, { toolMap, provider, ...(options.implemented ? { implemented: options.implemented } : {}) });
    const bucket = byCategory[evalCase.category] ?? { PASS: 0, FAIL: 0, EXPECTED_RED: 0 };
    bucket[outcome.outcome]++;
    byCategory[evalCase.category] = bucket;
    if (outcome.outcome === 'PASS') pass++;
    else if (outcome.outcome === 'EXPECTED_RED') expectedRed++;
    else { fail++; failures.push(outcome); }
  }
  return { total: selected.length, pass, fail, expectedRed, byCategory, failures };
}

export function formatSummary(summary: SuiteSummary): string {
  const rows = Object.entries(summary.byCategory).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([category, counts]) => `  ${category.padEnd(18)} PASS ${counts.PASS}  FAIL ${counts.FAIL}  EXPECTED_RED ${counts.EXPECTED_RED}`);
  const failures = summary.failures.map(entry => `  FAIL ${entry.id}: ${entry.reasons.join('; ')}`);
  return [
    `cases ${summary.total}: ${summary.pass} PASS, ${summary.fail} FAIL, ${summary.expectedRed} EXPECTED_RED`,
    ...rows,
    ...(failures.length > 0 ? ['failures:', ...failures] : []),
  ].join('\n');
}
