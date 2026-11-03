import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { cases, setMutation, dispatchScenario, historyScenario, multiReadScenario, injectedScenario, invalidReadScenario } from './harness.js';

const directory = new URL('../../../test/fixtures/live-boundary/', import.meta.url);
type Scenario = { id: string; case: string; tool: string; args: Record<string, unknown>; words: string | string[]; count: number; source: string; allowed: boolean; completeArguments?: boolean };
const scenarios: { name: string; run: () => Promise<void> }[] = [];
for (const file of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
  const data = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
  if (file === 'tasks.json') {
    for (const name of data as string[]) {
      const run = cases[name]; assert.ok(run, `No executable scenario: ${name}`); scenarios.push({ name, run });
    }
    continue;
  }
  const entries = (Array.isArray(data) ? data : data.scenarios) as Scenario[];
  assert.ok(Array.isArray(entries), `Fixture has no scenarios: ${file}`);
  for (const scenario of entries) {
    let run: () => Promise<void>;
    switch (scenario.case ?? 'dispatch') {
      case 'dispatch': run = () => dispatchScenario({ ...scenario, words: scenario.words as string }); break;
      case 'history': run = () => historyScenario(scenario.words as string[]); break;
      case 'multi-read': run = () => multiReadScenario(scenario.count); break;
      case 'injected': run = () => injectedScenario(scenario.source, scenario.allowed); break;
      case 'invalid-read': run = () => invalidReadScenario(scenario.tool); break;
      default: {
        const execute = cases[scenario.case]; assert.ok(execute, `No executable scenario: ${scenario.case}`); run = execute;
      }
    }
    scenarios.push({ name: scenario.id, run });
  }
}
assert.equal(new Set(scenarios.map(s => s.name)).size, scenarios.length, 'Scenario ids must be unique');
let failures = 0;
for (const { name, run } of scenarios) {
  try {
    await run(); console.log(`PASS ${name}`);
    // Invert one concrete equality expectation and observe red, then restore.
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
