import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { main } from './cli.js';
import { loadScenarios } from './plan.js';
import { loadRecording } from './replay.js';
import { runScenario } from './runner.js';
import { recordingsDir, scenariosDir } from './locate.js';

const run = (file: string, id: string) => {
  const scenario = loadScenarios(join(scenariosDir(), file)).find(entry => entry.id === id);
  assert.ok(scenario, `${file} has no ${id}`);
  return runScenario({ scenario, recording: loadRecording(join(recordingsDir(), scenario.recording)), timeoutMs: 8_000 });
};

test('a scripted good run passes through the real adapter', async () => {
  for (const scenario of loadScenarios(join(scenariosDir(), 'release.jsonl'))) {
    const outcome = await runScenario({ scenario, recording: loadRecording(join(recordingsDir(), scenario.recording)), timeoutMs: 8_000 });
    assert.equal(outcome.reasons.join('; '), '', `${scenario.id} should pass`);
    assert.ok(outcome.events > 0, `${scenario.id} saw no adapter event`);
  }
});

test('the split-final scenario is one ask, not two', async () => {
  const outcome = await run('release.jsonl', 'calendar-split');
  assert.deepEqual(outcome.calls.map(call => call.tool), ['calendar.read']);
  assert.match(outcome.spoken, /design review/);
});

test('the clarify answer is a second turn over the same session', async () => {
  const outcome = await run('release.jsonl', 'clarify-mail');
  assert.match(outcome.spoken, /Which Sam/);
  assert.deepEqual(outcome.calls.map(call => call.tool), ['mail.create_draft']);
});

test('a wrong tool fails the scenario', async () => {
  const outcome = await run('bad.jsonl', 'wrong-tool');
  assert.equal(outcome.pass, false);
  assert.ok(outcome.reasons.some(reason => reason.startsWith('wrong_call:calendar.read')), outcome.reasons.join('; '));
});

test('a false empty claim fails the scenario', async () => {
  const outcome = await run('bad.jsonl', 'false-empty');
  assert.equal(outcome.pass, false);
  assert.deepEqual(outcome.reasons, ['claim_without_receipt:empty']);
});

test('a dry run prints the plan and makes no network call', async () => {
  const original = globalThis.fetch;
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  globalThis.fetch = (() => { throw new Error('a dry run opened the network'); }) as typeof globalThis.fetch;
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await main(['--dry-run']), 0);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = original;
  }
  const text = written.join('');
  assert.match(text, /dry run, no socket, no model call/);
  assert.match(text, /total price: UNSET/);
  assert.match(text, /calendar-split/);
});

test('a real run refuses without a price confirmation', async () => {
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(await main(['--real']), 2);
    assert.equal(await main(['--real', '--confirm-price', '0.01']), 2);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
});
