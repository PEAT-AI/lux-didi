import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cases, setMutation, dispatchScenario } from './harness.js';

const scenarios = JSON.parse(readFileSync(new URL('../../../test/fixtures/live-boundary/tasks.json', import.meta.url), 'utf8')) as string[];
const dispatch = JSON.parse(readFileSync(new URL('../../../test/fixtures/live-boundary/dispatch.json', import.meta.url), 'utf8')) as { id: string; tool: string; args: Record<string, unknown>; words: string }[];
for (const scenario of dispatch) { scenarios.push(scenario.id); cases[scenario.id] = () => dispatchScenario(scenario); }
let failures = 0;
for (const name of scenarios) {
  const run = cases[name];
  if (!run) { console.error(`FAIL ${name}: no executable scenario`); failures++; continue; }
  try {
    await run(); console.log(`PASS ${name}`);
    // Change the first concrete equality expectation, then restore it. A non-assertion
    // failure is not proof that the scenario detected the broken expectation.
    setMutation(true);
    let red = false;
    try { await run(); } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      red = true;
    } finally { setMutation(false); }
    assert.equal(red, true, `${name}: mutated expectation must fail`);
    console.log(`PROVED_RED ${name}: inverted equality expectation; restored`);
  } catch (error) {
    setMutation(false); failures++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`LIVE BOUNDARY: ${failures === 0 ? 'PASS' : 'FAIL'} (${scenarios.length} scenarios, ${failures} failures)`);
console.log('Synthetic provider ports do not prove the real wire or the microphone adapter.');
process.exitCode = failures === 0 ? 0 : 1;
