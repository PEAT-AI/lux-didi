import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceSession } from '../../adapters/live-voice/types.js';
import {
  formatProbeCost, formatVariant, probeCost, probeEstimate, PROBE_ASKS, PROBE_VARIANTS, runPostToolProbe,
  selectProbeCases, type ProbeVariant, type ProbeVariantResult,
} from '../../eval/post-tool-probe.js';
import type { EvalCase } from '../../eval/types.js';

const toolMapPath = fileURLToPath(new URL('../../../eval/tool-map.json', import.meta.url));

const syntheticCase = (id: string): EvalCase => ({
  id, category: 'post-tool-probe', priority: 'P3', source: 'synthetic', public_ok: true,
  finals: ['Look up the synthetic note.'],
  setup: { clock_T0: '2026-10-30T15:00:00+08:00', timezone: 'Asia/Singapore', seeded_state: { calendar: [] } },
  expected_tools: [{ tool: 'research', args: { q: 'synthetic' }, writes: false }],
  expected_state: {}, spoken_must: [], spoken_must_not: [], red_today: false,
} as unknown as EvalCase);

type Step = LiveVoiceEvent | (() => void);
const audio = (sequence: number): LiveVoiceEvent =>
  ({ sequence, type: 'audio', pcm: new Uint8Array(2), rate: 24_000, audible: true } as LiveVoiceEvent);

const stubSession = (steps: readonly Step[]): LiveVoiceSession => ({
  ready: Promise.resolve(),
  done: Promise.resolve({ status: 'closed', code: 'closed' } as LiveVoiceOutcome),
  events: {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () => {
          while (index < steps.length) {
            const step = steps[index++]!;
            if (typeof step === 'function') { step(); continue; }
            return { done: false, value: step };
          }
          return { done: true, value: undefined };
        },
      };
    },
  },
  sendToolResponse: () => 'sent',
  sendAudio: () => {},
  sendText: () => {},
  endAudioStream: () => {},
  close: () => {},
});

/** The scenario's steps: who speaks, and when a create is written relative to that speech. */
const stepsOf = (plan: readonly ('create' | 'speak')[], tap: { creates: number[] }): Step[] => [
  { sequence: 1, type: 'toolCall', calls: [{ id: 'call_1', name: 'research', args: { q: 'synthetic' } }] } as LiveVoiceEvent,
  ...plan.map((step, index): Step => (step === 'create'
    ? () => { tap.creates.push(Date.now() + index); }
    : audio(index + 2))),
  { sequence: 99, type: 'turnComplete' } as LiveVoiceEvent,
];

const portFactory = (plan: readonly ('create' | 'speak')[]) =>
  (_input: unknown, _variant: ProbeVariant, tap: { creates: number[] }) => ({
    capabilities: {} as LiveVoicePort['capabilities'],
    open: () => stubSession(stepsOf(plan, tap)),
  } as unknown as LiveVoicePort);

const depsFor = (dir: string, plan: readonly ('create' | 'speak')[], extra: { asks?: number; log?: (line: string) => void; variants?: readonly ProbeVariant[] } = {}) => ({
  casesDir: dir,
  toolMapPath,
  system: { text: 'Synthetic persona', dataClass: 'ordinary' as const },
  port: {
    modelId: 'gpt-live-1', voice: 'marin', keyReference: 'openai-primary', resolveKey: async () => 'synthetic',
    route: { provider: 'gemini' as const, modelId: 'gpt-live-1', dataClasses: ['ordinary' as const] },
  },
  portFactory: portFactory(plan),
  ...extra,
});

test('the probe refuses to start without --go and prints the estimate first', () => {
  const estimate = probeEstimate(PROBE_ASKS, PROBE_VARIANTS.length);
  assert.match(estimate, /^post-tool probe: 4 variants x 12 asks = 48 sessions/);
  assert.match(estimate, /estimated cost \$\d+\.\d\d/);
  assert.match(estimate, /pass --go to start/);
  assert.match(estimate, /no audio, no transcript, no device/);
});

test('the probe cost is one session per ask per variant', () => {
  const cost = probeCost(3, 2);
  assert.equal(cost.modelCalls, 6);
  assert.equal(formatProbeCost(cost, 3, 2).startsWith('post-tool probe: 2 variants x 3 asks = 6 sessions'), true);
});

test('the probe selects only public cases that expect a tool call', () => {
  const cases = [syntheticCase('a'), { ...syntheticCase('b'), expected_tools: [] }, { ...syntheticCase('c'), public_ok: false }];
  assert.deepEqual(selectProbeCases(cases as unknown as EvalCase[], 12).map(entry => entry.id), ['a']);
});

test('a variant line is counts only', () => {
  const line = formatVariant({
    variant: PROBE_VARIANTS[0]!,
    stopped: null,
    asks: [
      { caseId: 'a', firstResponseAudio: true, toolOutputToAudioMs: 120, silentRescueUsed: false, postToolCreates: 1, audibleResponses: 1, audioDeltas: 9, textTokens: 40 },
      { caseId: 'b', firstResponseAudio: false, toolOutputToAudioMs: null, silentRescueUsed: true, postToolCreates: 2, audibleResponses: 1, audioDeltas: 4, textTokens: 60 },
    ],
  });
  assert.equal(line, 'variant baseline: asks 2, first response audio 1/2, tool output to first audio p50 120 ms, '
    + 'silent rescues 1, audible responses 2, audio deltas 13, text tokens 100');
});

test('the first post-tool response counts as audible when it speaks before any second create', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-post-tool-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'probe.jsonl'), `${JSON.stringify(syntheticCase('probe-01'))}\n`);
  const results = await runPostToolProbe(depsFor(dir, ['create', 'speak'], { asks: 1 }));
  const record = results[0]!.asks[0]!;
  assert.equal(record.firstResponseAudio, true);
  assert.equal(record.silentRescueUsed, false);
  assert.equal(record.postToolCreates, 1);
  assert.equal(record.audibleResponses, 1);
  assert.equal(typeof record.toolOutputToAudioMs, 'number');
  assert.equal(record.stopped, undefined);
});

test('a silent first response and a second create read as the silent rescue', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-post-tool-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'probe.jsonl'), `${JSON.stringify(syntheticCase('probe-01'))}\n`);
  const results = await runPostToolProbe(depsFor(dir, ['create', 'create', 'speak'], { asks: 1 }));
  const record = results[0]!.asks[0]!;
  assert.equal(record.firstResponseAudio, false);
  assert.equal(record.silentRescueUsed, true);
  assert.equal(record.audibleResponses, 1);
  assert.equal(record.stopped, undefined);
});

test('the probe stops a variant on duplicate speech', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-post-tool-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'probe.jsonl'), `${JSON.stringify(syntheticCase('probe-01'))}\n${JSON.stringify(syntheticCase('probe-02'))}\n`);
  const lines: string[] = [];
  const results: ProbeVariantResult[] = await runPostToolProbe(depsFor(dir, ['create', 'speak', 'create', 'speak'], {
    asks: 2, log: line => lines.push(line), variants: [PROBE_VARIANTS[0]!],
  }));
  const variant = results[0]!;
  assert.equal(variant.stopped, 'probe-01: duplicate_speech');
  assert.equal(variant.asks.length, 1, 'the variant stops on the first ask that speaks twice');
  assert.equal(variant.asks[0]!.audibleResponses, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /STOPPED probe-01: duplicate_speech/);
});
