/**
 * Tier 2 release eval: one scenario, driven through the real realtime adapter in text mode, against the eval
 * harness's fake world and fake connectors. The adapter is the production one; only the socket and the world are
 * fake, so a scenario exercises the real wire protocol, the real turn-taking and the real tool gate.
 *
 * Scoring is deterministic: the tool calls and their arguments, and what the answer said that no receipt covers.
 */

import { readFileSync } from 'node:fs';
import { createLiveVoiceAdapter } from '../../adapters/live-voice/index.js';
import type { LiveVoiceClock, LiveVoiceEvent, LiveVoiceSession } from '../../adapters/live-voice/types.js';
import { alarmWorld } from '../../eval/alarms.js';
import type { EvalCase } from '../../eval/types.js';
import { fakeWorld, type FakeWorld, type ToolMap } from '../../eval/world.js';
import { synthUtterance } from './audio.js';
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

/** 100 ms of synthetic tone per fragment: the owner's uplink, standing in for an ask nobody actually spoke. */
const ASK_PCM = synthUtterance(2_400);

/** The teardown's own bound: a socket close is milliseconds of work, never a scenario's worth of waiting. */
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * The adapter's own clock, driven by the runner: its turn windows are seconds long, so driving them costs no wall
 * time and no test sleeps. `fireNext` runs the earliest armed timer, which is how a turn reaches its quiet window.
 */
function drivenClock(): LiveVoiceClock & { fireNext: () => boolean } {
  let time = Date.now();
  let next = 1;
  const pending: { id: number; at: number; fire: () => void }[] = [];
  return {
    now: () => time,
    setTimer: (ms, fire) => { const id = next; next += 1; pending.push({ id, at: time + Math.max(0, ms), fire }); return id; },
    clearTimer: handle => { const at = pending.findIndex(timer => timer.id === handle); if (at >= 0) pending.splice(at, 1); },
    fireNext: () => {
      const due = [...pending].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) return false;
      pending.splice(pending.indexOf(due), 1);
      time = Math.max(time, due.at);
      due.fire();
      return true;
    },
  };
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
  const clock = drivenClock();
  const receipts: Receipt[] = [];
  const reasons: string[] = [];
  const state = { spoken: '', finished: 0, events: 0 };
  let session: LiveVoiceSession | undefined;
  let pump: Promise<void> | undefined;
  // C-EVALS: the scenario's own teardown. Whatever leaves the driven part, the session, the event pump, the replay
  // socket and the alarm store are released, so a fixture that never arrives fails the run instead of holding the
  // event loop open and stalling the whole check. Every step is bounded and the last one always runs.
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      session?.close();
      if (pump !== undefined) {
        try { await settle(timeoutMs, pump, 'the event pump to end after close'); } catch { reasons.push('pump_never_ended'); }
      }
      try { await settle(CLOSE_TIMEOUT_MS, replay.close(), 'the replay socket to close'); } catch { reasons.push('replay_close_bounded'); }
    } finally {
      env.world.close();
    }
  };

  try {
    session = createLiveVoiceAdapter({
      modelId: 'gpt-live-1', voice: 'marin', keyReference: 'eval-release-fake',
      route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
      credentials: { resolve: async () => 'synthetic-eval-key-never-sent-to-a-provider' },
      limits: { handshakeMs: 4000, idleMs: 4000, sessionMs: 60_000, closeMs: 200 },
      socketFactory: replay.socketFactory,
      clock,
    }).open({
      system: { text: scenario.system, dataClass: 'ordinary' }, dataClasses: ['ordinary'],
      tools: [...declared.entries()].map(([wire, worldName]) => ({ name: wire, description: toolMap.tools[worldName]?.didi ?? wire,
        parameters: { type: 'object', properties: {} } })),
    }, { signal: AbortSignal.timeout(timeoutMs), deadlineMs: Date.now() + timeoutMs });
    const live = session;
    // The provider opens a delegation and the host's helper does the work: the recording stands in for the helper,
    // so these rows prove the adapter and the fixture contract, never the helper's own choice of tool.
    const answer = (delegationId: string): void => {
      const work = replay.takeDelegation();
      if (work === undefined) { reasons.push('delegation_unfixtured'); return; }
      for (const call of work.calls) {
        const result = world.call({ tool: call.tool, ...(call.args === undefined ? {} : { args: call.args }) });
        receipts.push(receiptFor(toolMap, call.tool, result));
      }
      if (live.sendTaskAnswer?.({ delegationId, text: work.answer }) === undefined) reasons.push('answer_refused');
    };
    pump = (async () => {
      for await (const event of live.events as AsyncIterable<LiveVoiceEvent>) {
        state.events += 1;
        if (event.type === 'outputTranscription') {
          if (event.text.length > 0) state.spoken = `${state.spoken} ${event.text}`.trim();
          if (event.finished) state.finished += 1;
        }
        if (event.type === 'delegation') answer(event.delegationId);
        if (event.type === 'turnFailed') reasons.push(`turn_failed:${event.code}`);
      }
    })();

    await settle(timeoutMs, live.ready, 'the session to be ready');
    // The adapter is audio-only after readiness (`client mode is audio-only`, openai-live-voice.test.ts): a typed
    // ask is refused, so each fragment goes up the same uplink a microphone uses. The scenario's text is the ask the
    // synthetic tone stands for; what a row proves is the adapter and the fixture contract over that ask, not the
    // words themselves reaching the model.
    const turns: readonly ScenarioTurn[] = scenario.owner_turns;
    for (const [at, turn] of turns.entries()) {
      // A split final is one ask: every fragment goes up in the same synchronous burst, exactly as a transcript splits.
      for (let fragment = 0; fragment < turn.fragments.length; fragment += 1) live.sendAudio({ pcm: ASK_PCM, dataClass: 'ordinary' });
      if (!await waitFor(() => state.finished > at || reasons.length > 0, timeoutMs, clock)) reasons.push(`turn_not_answered:${at}`);
    }
    if (!await waitFor(() => replay.servedCount() >= replay.totalSteps(), timeoutMs)) reasons.push('recording_not_served');
  } finally {
    await release();
  }

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

  return { id: scenario.id, pass: reasons.length === 0, reasons, calls, spoken: state.spoken, receipts, events: state.events };
}

/** Bounded wait on a condition the fake provider settles at once: every round drains the socket and fires the
 * adapter's next timer, so a turn that never ends fails by name instead of hanging. */
async function waitFor(
  condition: () => boolean, timeoutMs: number, clock?: { fireNext: () => boolean },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
    if (clock !== undefined && !condition()) clock.fireNext();
  }
  return true;
}

/** A bounded await: a fixture that never settles fails the run by name instead of hanging the check. */
async function settle<T>(timeoutMs: number, pending: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`eval timeout: waited ${timeoutMs} ms for ${what}`)), timeoutMs);
  });
  try { return await Promise.race([pending, wall]); } finally { clearTimeout(timer); }
}
