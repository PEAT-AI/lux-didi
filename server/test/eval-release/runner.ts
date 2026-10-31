/**
 * Tier 2 release eval: one scenario, driven through the real realtime adapter in text mode, against the eval
 * harness's fake world and fake connectors. The adapter is the production one; only the socket and the world are
 * fake, so a scenario exercises the real wire protocol, the real turn-taking and the real tool gate.
 *
 * Scoring is deterministic: the tool calls and their arguments, and what the answer said that no receipt covers.
 */

import { readFileSync } from 'node:fs';
import { createLiveVoiceAdapter } from '../../adapters/live-voice/index.js';
import type { LiveVoiceEvent, LiveVoiceSession } from '../../adapters/live-voice/types.js';
import { alarmWorld } from '../../eval/alarms.js';
import type { EvalCase } from '../../eval/types.js';
import { fakeWorld, type FakeWorld, type ToolMap } from '../../eval/world.js';
import { unsupportedClaims, type Receipt } from './judge.js';
import { replayServer, type Recording } from './replay.js';
import type { ReleaseScenario, ScenarioTurn } from './plan.js';

export function loadToolMap(path: string): ToolMap {
  return JSON.parse(readFileSync(path, 'utf8')) as ToolMap;
}

const evalCaseOf = (scenario: ReleaseScenario): EvalCase => ({
  id: scenario.id, category: scenario.category, public_ok: true, finals: scenario.owner_turns.flatMap(turn => turn.fragments),
  setup: { clock_T0: scenario.clock_T0, timezone: scenario.timezone, seeded_state: scenario.seeded_state },
  expected_tools: scenario.expect.tools.map(tool => ({ tool: tool.tool, ...(tool.args === undefined ? {} : { args: tool.args }) })),
  expected_state: {}, spoken_must: scenario.expect.spoken_must ?? [], spoken_must_not: scenario.expect.spoken_must_not ?? [],
  red_today: false,
});

/** A read that came back with nothing is an `empty` receipt; everything else a call proved is `completed`. */
const EMPTY_FIELDS = ['events', 'items', 'threads', 'notes', 'contacts', 'series', 'files', 'cards', 'results'] as const;

function receiptFor(toolMap: ToolMap, tool: string, result: { ok: boolean; data: Record<string, unknown> }): Receipt {
  const entry = toolMap.tools[tool];
  const kind = entry?.kind === 'write' ? 'write' : 'read';
  if (!result.ok) return { tool, kind, outcome: 'failed' };
  const arrays = EMPTY_FIELDS.map(field => result.data[field]).filter((value): value is readonly unknown[] => Array.isArray(value));
  const empty = arrays.length > 0 && arrays.every(array => array.length === 0);
  return { tool, kind, outcome: kind === 'read' && empty ? 'empty' : 'completed' };
}

/**
 * The provider's own tool-name rule is `^[A-Za-z][A-Za-z0-9_]{0,63}$`, so a dotted world name is declared with
 * its separators turned into underscores and turned back before it reaches the world. One mapping, both ways.
 */
export function declaredNames(toolMap: ToolMap): Map<string, string> {
  const declared = new Map<string, string>();
  for (const name of Object.keys(toolMap.tools)) {
    const wire = name.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(wire)) throw new Error(`tool name ${name} cannot be declared to the provider`);
    if (declared.has(wire)) throw new Error(`two tools declare as ${wire}`);
    declared.set(wire, name);
  }
  return declared;
}

const matches = (expected: unknown, actual: unknown): boolean => {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((value, at) => matches(value, actual[at]));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.entries(expected as Record<string, unknown>)
      .every(([key, value]) => matches(value, (actual as Record<string, unknown>)[key]));
  }
  return expected === actual;
};

export interface ScenarioRun {
  readonly id: string;
  readonly pass: boolean;
  readonly reasons: readonly string[];
  readonly calls: readonly { readonly tool: string; readonly args: Record<string, unknown> }[];
  readonly spoken: string;
  readonly receipts: readonly Receipt[];
  readonly events: number;
}

export interface RunScenarioOptions {
  readonly scenario: ReleaseScenario;
  readonly recording: Recording;
  /** A guard against a hung replay: the fake provider answers at once, so this never fires in practice. */
  readonly timeoutMs?: number;
}

/** One scenario end to end. The caller owns nothing: the socket and the temp alarm store are closed here. */
export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRun> {
  const { scenario, recording } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const toolMap = loadToolMap(new URL('../../eval/tool-map.json', import.meta.url).pathname);
  const declared = declaredNames(toolMap);
  const t0 = Date.parse(scenario.clock_T0);
  const env = alarmWorld(t0);
  const world: FakeWorld = fakeWorld({ case: evalCaseOf(scenario), clock: { now: () => Date.now() }, alarms: env.world, toolMap });
  const replay = await replayServer(recording);
  const session: LiveVoiceSession = createLiveVoiceAdapter({
    modelId: 'gpt-live-1', voice: 'marin', keyReference: 'eval-release-fake',
    route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
    credentials: { resolve: async () => 'synthetic-eval-key-never-sent-to-a-provider' },
    limits: { handshakeMs: 4000, idleMs: 4000, sessionMs: 60_000, closeMs: 200 },
    socketFactory: replay.socketFactory,
  }).open({
    system: { text: scenario.system, dataClass: 'ordinary' }, dataClasses: ['ordinary'],
    tools: [...declared.entries()].map(([wire, worldName]) => ({ name: wire, description: toolMap.tools[worldName]?.didi ?? wire,
      parameters: { type: 'object', properties: {} } })),
  }, { signal: AbortSignal.timeout(timeoutMs), deadlineMs: Date.now() + timeoutMs });

  const receipts: Receipt[] = [];
  const reasons: string[] = [];
  const state = { spoken: '', finished: 0, events: 0 };
  const dispatch = (calls: readonly { id: string; name: string; args: Record<string, unknown> }[]): void => {
    session.sendToolResponse({ responses: calls.map(call => {
      const name = declared.get(call.name) ?? call.name;
      const result = world.call({ tool: name, args: call.args });
      receipts.push(receiptFor(toolMap, name, result));
      return { id: call.id, name: call.name, response: { ok: result.ok, ...result.data } };
    }) });
  };
  const pump = (async () => {
    for await (const event of session.events as AsyncIterable<LiveVoiceEvent>) {
      state.events += 1;
      if (event.type === 'outputTranscription') {
        if (event.text.length > 0) state.spoken = `${state.spoken} ${event.text}`.trim();
        if (event.finished) state.finished += 1;
      }
      if (event.type === 'toolCall') dispatch(event.calls);
      if (event.type === 'turnFailed') reasons.push(`turn_failed:${event.code}`);
    }
  })();

  await session.ready;
  const turns: readonly ScenarioTurn[] = scenario.owner_turns;
  for (const [at, turn] of turns.entries()) {
    // A split final is one ask: the fragments go in the same synchronous burst, exactly as a transcript splits.
    for (const fragment of turn.fragments) session.sendText({ text: fragment });
    await waitFor(() => state.finished > at || reasons.length > 0, timeoutMs);
  }
  await replay.served();
  session.close();
  await pump;

  const calls = world.calls.map(call => ({ tool: call.tool, args: call.args }));
  for (const [at, expected] of scenario.expect.tools.entries()) {
    const actual = calls[at];
    if (actual === undefined) { reasons.push(`missing_call:${expected.tool}`); continue; }
    if (actual.tool !== expected.tool) { reasons.push(`wrong_call:${expected.tool} got ${actual.tool}`); continue; }
    if (!matches(expected.args, actual.args)) reasons.push(`arg_mismatch:${expected.tool}`);
  }
  if (calls.length > scenario.expect.tools.length) {
    reasons.push(`unexpected_calls:${calls.slice(scenario.expect.tools.length).map(call => call.tool).join(',')}`);
  }
  for (const must of scenario.expect.spoken_must ?? []) if (!state.spoken.toLowerCase().includes(must.toLowerCase())) reasons.push(`spoken_missing:${must}`);
  for (const mustNot of scenario.expect.spoken_must_not ?? []) if (state.spoken.toLowerCase().includes(mustNot.toLowerCase())) reasons.push(`spoken_forbidden:${mustNot}`);
  reasons.push(...unsupportedClaims({ spoken: state.spoken, receipts }));

  await replay.close();
  env.world.close();
  return { id: scenario.id, pass: reasons.length === 0, reasons, calls, spoken: state.spoken, receipts, events: state.events };
}

/** Bounded wait on a condition the fake provider settles at once. No sleep on the happy path. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}
