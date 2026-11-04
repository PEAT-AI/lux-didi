import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadScenarios, type ReleaseScenario } from './plan.js';
import { loadRecording, replayServer } from './replay.js';
import { runScenario, type BoundTimers } from './runner.js';
import { recordingsDir, scenariosDir } from './locate.js';

/**
 * Issue 884's failure paths, pinned. The old runner had no bound and no teardown, so a fixture that never answered
 * held the whole check open for as long as the wall allowed. These rows prove the opposite: every dead end ends by
 * name inside the bound the runner sets, the fake provider is closed afterwards, and none of it waits on a real clock.
 */

const scenarioOf = (id: string): ReleaseScenario => {
  const found = loadScenarios(join(scenariosDir(), 'release.jsonl')).find(entry => entry.id === id);
  assert.ok(found, `release.jsonl has no ${id}`);
  return found;
};

/** A recording written for one test: an unreachable provider is a test fixture, not a file a passing run ships. */
const recordingFor = (steps: readonly unknown[]) => {
  const path = join(mkdtempSync(join(tmpdir(), 'didi-eval-failure-')), 'recording.json');
  writeFileSync(path, JSON.stringify({ steps }));
  return loadRecording(path);
};

/**
 * Time under the test's own hand: `now` only moves when the runner sleeps or arms a timer, so a bound is reached in a
 * few steps and no row spends the timeout it is testing. Nothing here waits on the wall clock.
 */
const drivenBounds = (): BoundTimers => {
  let now = 1_000_000;
  return {
    now: () => now,
    // Ten milliseconds of seam time per step, and the step still yields to the event loop so socket frames arrive.
    tick: () => { now += 10; return new Promise(resolve => { setImmediate(resolve); }); },
  };
};

const STARTED = { trigger: 'start', frames: [{ type: 'session.started', session: { id: 'sess_failure' } }] };
const DELEGATION = (helper?: unknown) => ({
  trigger: 'audio',
  frames: [{ type: 'session.delegation.created', delegation: { id: 'dlg_failure' } }],
  ...(helper === undefined ? {} : { helper }),
});
const ANSWER = { trigger: 'answer', audio_ms: 600, frames: [{ type: 'session.output_transcript.delta', delta: 'Tomorrow you have the design review at 3.' }] };
const HELPER = { calls: [{ tool: 'calendar.read' }], answer: 'Tomorrow you have the design review at 3.' };

test('a provider that says nothing at all fails readiness on the runner bound, by name', async () => {
  // The only step waits on a trigger that never comes, so the provider sends no frame: this is the wall the old
  // runner waited on forever, and the row proves the runner's own bound reaches it.
  const recording = recordingFor([{ trigger: 'continuation', frames: [STARTED.frames[0]] }]);
  const at = Date.now();
  await assert.rejects(
    runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300, bounds: drivenBounds() }),
    /^Error: eval timeout: waited 300 ms for the session to be ready$/,
  );
  const wall = Date.now() - at;
  assert.ok(wall < 300, `the bound took ${wall} ms of wall clock, so the seam did not reach it`);
});

test('a provider that speaks before it starts is refused loudly, not waited on', async () => {
  const recording = recordingFor([{ trigger: 'start', frames: [{ type: 'session.usage.updated' }] }]);
  await assert.rejects(
    runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300, bounds: drivenBounds() }),
    /^LiveVoiceError: protocol_error$/,
  );
});

test('a recording that never serves its answer ends red, by name, without waiting it out', async () => {
  const recording = recordingFor([STARTED, DELEGATION(HELPER)]);
  const at = Date.now();
  const outcome = await runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300, bounds: drivenBounds() });
  assert.equal(outcome.pass, false);
  assert.ok(outcome.reasons.includes('turn_not_answered:0'), outcome.reasons.join('; '));
  assert.ok(outcome.reasons.includes('spoken_missing:design review'), outcome.reasons.join('; '));
  const wall = Date.now() - at;
  assert.ok(wall < 300, `the unanswered turn took ${wall} ms of wall clock, so the bound was waited out`);
});

test('a delegation the fixture does not staff is named, not waited out', async () => {
  const recording = recordingFor([STARTED, DELEGATION(), ANSWER]);
  const outcome = await runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300, bounds: drivenBounds() });
  assert.equal(outcome.pass, false);
  assert.ok(outcome.reasons.includes('delegation_unfixtured'), outcome.reasons.join('; '));
});

test('a failed scenario closes the fake provider it opened', async () => {
  const recording = recordingFor([STARTED, DELEGATION(HELPER)]);
  const replay = await replayServer(recording);
  assert.equal(replay.closed(), false, 'the fake provider is open before the run');
  const outcome = await runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300, bounds: drivenBounds(), replay });
  assert.equal(outcome.pass, false, 'the unanswered turn is the failure under test');
  assert.equal(outcome.release.replayClosed, true, 'teardown reports the provider closed');
  assert.equal(replay.closed(), true, 'the handle itself is closed, not merely abandoned');
});

test('a passing scenario closes the fake provider it opened', async () => {
  const scenario = scenarioOf('calendar-split');
  const replay = await replayServer(loadRecording(join(recordingsDir(), scenario.recording)));
  const outcome = await runScenario({ scenario, recording: loadRecording(join(recordingsDir(), scenario.recording)), replay });
  assert.equal(outcome.pass, true, outcome.reasons.join('; '));
  assert.equal(outcome.release.replayClosed, true, 'teardown reports the provider closed');
  assert.equal(replay.closed(), true, 'the handle itself is closed after a pass');
});
