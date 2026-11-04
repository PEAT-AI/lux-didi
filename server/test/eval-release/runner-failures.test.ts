import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadScenarios, type ReleaseScenario } from './plan.js';
import { loadRecording } from './replay.js';
import { runScenario } from './runner.js';
import { recordingsDir, scenariosDir } from './locate.js';

/**
 * Issue 884's failure paths, pinned. The old runner had no bound and no teardown, so a fixture that never answered
 * held the whole check open for as long as the wall allowed. These rows prove the opposite: each dead end ends by
 * name inside the scenario's bound, and the next scenario runs on a free socket.
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

const STARTED = { trigger: 'start', frames: [{ type: 'session.started', session: { id: 'sess_failure' } }] };
const DELEGATION = (helper?: unknown) => ({
  trigger: 'audio',
  frames: [{ type: 'session.delegation.created', delegation: { id: 'dlg_failure' } }],
  ...(helper === undefined ? {} : { helper }),
});
const ANSWER = { trigger: 'answer', audio_ms: 600, frames: [{ type: 'session.output_transcript.delta', delta: 'Tomorrow you have the design review at 3.' }] };
const HELPER = { calls: [{ tool: 'calendar.read' }], answer: 'Tomorrow you have the design review at 3.' };

test('a provider that never says it started fails readiness inside the bound', async () => {
  // No `session.started`: readiness never settles, which is the exact wall the old runner waited on forever.
  const recording = recordingFor([{ trigger: 'start', frames: [{ type: 'session.usage.updated' }] }, DELEGATION(HELPER), ANSWER]);
  const at = Date.now();
  await assert.rejects(runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300 }));
  const elapsed = Date.now() - at;
  assert.ok(elapsed < 5_000, `readiness took ${elapsed} ms, so it is not bounded by the scenario timeout`);
});

test('a recording that never serves its answer ends red, by name', async () => {
  const recording = recordingFor([STARTED, DELEGATION(HELPER)]);
  const at = Date.now();
  const outcome = await runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300 });
  assert.equal(outcome.pass, false);
  assert.ok(outcome.reasons.includes('turn_not_answered:0'), outcome.reasons.join('; '));
  assert.ok(outcome.reasons.includes('spoken_missing:design review'), outcome.reasons.join('; '));
  const elapsed = Date.now() - at;
  assert.ok(elapsed < 5_000, `the unanswered turn took ${elapsed} ms, so the wait is not bounded`);
});

test('a delegation the fixture does not staff is named, not waited out', async () => {
  const recording = recordingFor([STARTED, DELEGATION(), ANSWER]);
  const outcome = await runScenario({ scenario: scenarioOf('calendar-split'), recording, timeoutMs: 300 });
  assert.equal(outcome.pass, false);
  assert.ok(outcome.reasons.includes('delegation_unfixtured'), outcome.reasons.join('; '));
});

test('a failed scenario releases the socket, so the next one passes', async () => {
  const broken = recordingFor([STARTED, DELEGATION(HELPER)]);
  const failed = await runScenario({ scenario: scenarioOf('calendar-split'), recording: broken, timeoutMs: 300 });
  assert.equal(failed.pass, false);
  const scenario = scenarioOf('calendar-split');
  const good = await runScenario({
    scenario, recording: loadRecording(join(recordingsDir(), scenario.recording)), timeoutMs: 8_000,
  });
  assert.equal(good.pass, true, good.reasons.join('; '));
});
