/**
 * Tier 2 release eval: the scenario file, the rates table, and the dry-run plan.
 *
 * A scenario is one synthetic owner conversation: the ask, split into the fragments a realtime transcript
 * delivers, and the tool calls a correct answer needs. The plan is what a run would send, how many tokens
 * that is, and what it would cost at the owner's own rates. Nothing here opens a socket or reads a key.
 */

import { readFileSync } from 'node:fs';
import type { SeededState } from '../../eval/types.js';

/** One owner turn, as the fragments the realtime transcript hands over. A split final is two or more. */
export interface ScenarioTurn { readonly fragments: readonly string[] }

export interface ExpectedTool { readonly tool: string; readonly args?: Record<string, unknown> }

export interface ScenarioExpect {
  readonly tools: readonly ExpectedTool[];
  readonly spoken_must?: readonly string[];
  readonly spoken_must_not?: readonly string[];
}

export interface ReleaseScenario {
  readonly id: string;
  readonly category: string;
  /** The synthetic persona the evaluator's own system prompt stands in for; never the owner's. */
  readonly system: string;
  readonly clock_T0: string;
  readonly timezone: string;
  readonly seeded_state: SeededState;
  readonly owner_turns: readonly ScenarioTurn[];
  readonly expect: ScenarioExpect;
  /** The recorded synthetic model turns replayed in `--fake-model` mode, relative to the recordings folder. */
  readonly recording: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

function parseScenario(raw: unknown, where: string): ReleaseScenario {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where}: not an object`);
  const value = raw as Record<string, unknown>;
  const id = text(value['id']);
  if (id === undefined) throw new Error(`${where}: id is required`);
  const turns = list(value['owner_turns']).map((turn, at): ScenarioTurn => {
    if (!Array.isArray(turn) || turn.length === 0) throw new Error(`${where}: owner_turns[${at}] must be a list of fragments`);
    const fragments = turn.map(fragment => { const line = text(fragment); if (line === undefined) throw new Error(`${where}: empty fragment`); return line; });
    return { fragments };
  });
  if (turns.length === 0) throw new Error(`${where}: at least one owner turn is required`);
  const expect = (value['expect'] ?? {}) as Record<string, unknown>;
  const tools = list(expect['tools']).map((entry, at): ExpectedTool => {
    const tool = typeof entry === 'object' && entry !== null ? text((entry as Record<string, unknown>)['tool']) : undefined;
    if (tool === undefined) throw new Error(`${where}: expect.tools[${at}].tool is required`);
    const args = (entry as Record<string, unknown>)['args'];
    return args === undefined ? { tool } : { tool, args: args as Record<string, unknown> };
  });
  const spokenMust = list(expect['spoken_must']).map(entry => String(entry));
  const spokenMustNot = list(expect['spoken_must_not']).map(entry => String(entry));
  const recording = text(value['recording']);
  if (recording === undefined) throw new Error(`${where}: recording is required`);
  const seeded = value['seeded_state'];
  if (typeof seeded !== 'object' || seeded === null) throw new Error(`${where}: seeded_state is required`);
  return {
    id,
    category: text(value['category']) ?? 'release',
    system: text(value['system']) ?? 'Synthetic persona for the release eval.',
    clock_T0: text(value['clock_T0']) ?? '2026-11-02T08:00:00.000-08:00',
    timezone: text(value['timezone']) ?? 'America/Los_Angeles',
    seeded_state: seeded as SeededState,
    owner_turns: turns,
    expect: { tools, spoken_must: spokenMust, spoken_must_not: spokenMustNot },
    recording,
  };
}

/** Read a JSONL scenario file. One scenario per line, so a diff names exactly one conversation. */
export function loadScenarios(path: string): ReleaseScenario[] {
  const scenarios: ReleaseScenario[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const [at, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { throw new Error(`${path}:${at + 1}: not JSON`); }
    scenarios.push(parseScenario(raw, `${path}:${at + 1}`));
  }
  return scenarios;
}

/** A rate the owner has not filled in yet. `UNSET` is a placeholder, never a zero that quietly prices nothing. */
export type Rate = number | 'UNSET';

export interface ModelRate { readonly name: string; readonly inputUsdPerMTok: Rate; readonly outputUsdPerMTok: Rate }
export interface Rates { readonly model: ModelRate; readonly judge: ModelRate }

function rate(value: unknown): Rate { return typeof value === 'number' && Number.isFinite(value) ? value : 'UNSET'; }

export function loadRates(path: string): Rates {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const group = (key: string): ModelRate => {
    const entry = (raw[key] ?? {}) as Record<string, unknown>;
    return { name: typeof entry['name'] === 'string' ? entry['name'] : 'UNSET',
      inputUsdPerMTok: rate(entry['inputUsdPerMTok']), outputUsdPerMTok: rate(entry['outputUsdPerMTok']) };
  };
  return { model: group('model'), judge: group('judge') };
}

/** Characters per token, the usual English rule of thumb. It is an estimate, and the plan says so. */
export const CHARS_PER_TOKEN = 4;
/** A realtime session carries more than the transcript: instructions, tool declarations, provider preamble. */
export const SESSION_OVERHEAD_TOKENS = { input: 4_000, output: 400 } as const;

export interface ScenarioPlan {
  readonly id: string;
  readonly ownerTurns: number;
  readonly fragments: number;
  readonly expectedCalls: number;
  /** The frames a run sends: one ask per owner turn, one answer per expected tool call. */
  readonly wire: readonly string[];
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface CallPlan {
  readonly scenarios: readonly ScenarioPlan[];
  readonly modelCalls: number;
  readonly judgeCalls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** `null` when the owner has not filled a rate: a price that cannot be computed is not a price. */
  readonly estimatedUsd: number | null;
  readonly unset: readonly string[];
}

/** What a run would do, with no socket and no model. The judge prompt's own length is in the estimate. */
export function buildPlan(input: { readonly scenarios: readonly ReleaseScenario[]; readonly rates: Rates; readonly judgePrompt: string }): CallPlan {
  const plans: ScenarioPlan[] = input.scenarios.map(scenario => {
    const fragments = scenario.owner_turns.reduce((sum, turn) => sum + turn.fragments.length, 0);
    const asks = scenario.owner_turns.length;
    const calls = scenario.expect.tools.length;
    const wire = [
      ...Array.from({ length: asks }, () => 'response.item.create + response.create'),
      ...Array.from({ length: calls }, () => 'function_call_output + response.create'),
    ];
    const promptChars = scenario.system.length + scenario.owner_turns.flatMap(turn => turn.fragments).join(' ').length
      + input.judgePrompt.length + scenario.expect.tools.length * 120;
    return { id: scenario.id, ownerTurns: asks, fragments, expectedCalls: calls, wire,
      tokensIn: Math.ceil(promptChars / CHARS_PER_TOKEN) + SESSION_OVERHEAD_TOKENS.input,
      tokensOut: SESSION_OVERHEAD_TOKENS.output + calls * 60 };
  });
  const tokensIn = plans.reduce((sum, plan) => sum + plan.tokensIn, 0);
  const tokensOut = plans.reduce((sum, plan) => sum + plan.tokensOut, 0);
  const unset: string[] = [];
  if (input.rates.model.inputUsdPerMTok === 'UNSET') unset.push('model.inputUsdPerMTok');
  if (input.rates.model.outputUsdPerMTok === 'UNSET') unset.push('model.outputUsdPerMTok');
  if (input.rates.judge.inputUsdPerMTok === 'UNSET') unset.push('judge.inputUsdPerMTok');
  if (input.rates.judge.outputUsdPerMTok === 'UNSET') unset.push('judge.outputUsdPerMTok');
  const usd = unset.length === 0
    ? (tokensIn / 1e6) * (input.rates.model.inputUsdPerMTok as number)
      + (tokensOut / 1e6) * (input.rates.model.outputUsdPerMTok as number)
    : null;
  return { scenarios: plans, modelCalls: plans.reduce((sum, plan) => sum + plan.ownerTurns, 0),
    judgeCalls: input.scenarios.reduce((sum, scenario) => sum + scenario.owner_turns.length, 0),
    tokensIn, tokensOut, estimatedUsd: usd, unset };
}

/** The dry run's whole output: the call plan, the token estimate and the price, or why there is none. */
export function formatPlan(plan: CallPlan): string {
  const lines = ['tier 2 release eval: dry run, no socket, no model call'];
  for (const scenario of plan.scenarios) {
    lines.push(`  ${scenario.id}: ${scenario.ownerTurns} owner turn(s) in ${scenario.fragments} fragment(s), `
      + `${scenario.expectedCalls} expected tool call(s), ${scenario.tokensIn} prompt / ${scenario.tokensOut} response tokens`);
    for (const frame of scenario.wire) lines.push(`    wire: ${frame}`);
  }
  lines.push(`model calls: ${plan.modelCalls}, judge calls: ${plan.judgeCalls}, `
    + `${plan.tokensIn} prompt and ${plan.tokensOut} response tokens (estimated)`);
  lines.push(plan.estimatedUsd === null
    ? `total price: UNSET, fill ${plan.unset.join(', ')} in config/eval-rates.json`
    : `total price: $${plan.estimatedUsd.toFixed(2)}`);
  return lines.join('\n');
}

/** The price gate. A real run starts only with a confirmation within 20 percent of the estimate. */
export const PRICE_CONFIRM_TOLERANCE = 0.2;

export function confirmPrice(plan: CallPlan, confirmed: number | undefined): string | undefined {
  if (plan.estimatedUsd === null) return `price is UNSET (${plan.unset.join(', ')}): fill config/eval-rates.json first`;
  if (confirmed === undefined) return `a real run needs --confirm-price <usd>; the estimate is $${plan.estimatedUsd.toFixed(2)}`;
  if (!Number.isFinite(confirmed) || confirmed <= 0) return '--confirm-price must be a positive number of dollars';
  const delta = Math.abs(confirmed - plan.estimatedUsd) / Math.max(plan.estimatedUsd, 0.01);
  if (delta > PRICE_CONFIRM_TOLERANCE) {
    return `--confirm-price $${confirmed.toFixed(2)} is not within ${PRICE_CONFIRM_TOLERANCE * 100} percent of `
      + `the estimate $${plan.estimatedUsd.toFixed(2)}`;
  }
  return undefined;
}
