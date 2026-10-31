/**
 * The tier 2 release eval entry point, run by `scripts/eval-release.sh`.
 *
 *   --dry-run     print the call plan, the token estimate and the price, and open nothing
 *   --fake-model  replay the committed synthetic model turns against the real adapter, at no cost
 *   --real        the owner's priced run: refused without --confirm-price within 20 percent of the estimate
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { audioPlan, readUtteranceFile, runAudioProbe, synthUtterance } from './audio.js';
import { judgePrompt } from './judge.js';
import { buildPlan, confirmPrice, formatPlan, loadRates, loadScenarios, type ReleaseScenario } from './plan.js';
import { loadRecording } from './replay.js';
import { runScenario } from './runner.js';

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const USAGE = `eval-release.sh [--dry-run | --fake-model | --real --confirm-price <usd>] [--scenarios <file>] [--json]

  --dry-run     print the call plan, the token estimate and the price; no socket, no model call
  --fake-model  replay the recorded synthetic model turns through the real adapter, at no cost
  --real        the priced run; needs --confirm-price within 20 percent of the estimate
  --scenarios   a scenario file (default: the good release set)
  --json        machine-readable output
`;

const value = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
};

/** A bare file name is a name in the scenarios folder, so a probe names `bad.jsonl` and not a long path. */
const scenarioPath = (given: string | undefined): string =>
  given === undefined ? here('./scenarios/release.jsonl')
    : given.includes('/') ? given : here(`./scenarios/${given}`);

interface Options {
  readonly mode: 'dry-run' | 'fake-model' | 'real';
  readonly scenarios: string;
  readonly json: boolean;
  readonly confirm: number | undefined;
  /** `--audio-probe` swaps the text path for the synthetic utterance path; `--pcm` names a say capture. */
  readonly audio: boolean;
  readonly pcm: string | undefined;
}

function parse(argv: readonly string[]): Options {
  const modes = ['--dry-run', '--fake-model', '--real'].filter(mode => argv.includes(mode));
  if (modes.length > 1) throw new Error(`pick one mode, got ${modes.join(' ')}`);
  const confirmRaw = value(argv, '--confirm-price');
  const confirm = confirmRaw === undefined ? undefined : Number(confirmRaw);
  return {
    mode: modes[0] === '--fake-model' ? 'fake-model' : modes[0] === '--real' ? 'real' : 'dry-run',
    scenarios: scenarioPath(value(argv, '--scenarios')),
    json: argv.includes('--json'),
    confirm,
    audio: argv.includes('--audio-probe'),
    pcm: value(argv, '--pcm'),
  };
}

/** The recordings sit next to the scenarios, so a scenario file copied for a probe keeps its own turns. */
const recordingFor = (scenario: ReleaseScenario, scenariosPath: string): string =>
  join(dirname(scenariosPath), '..', 'recordings', scenario.recording);

async function runFakeModel(scenarios: readonly ReleaseScenario[], scenariosPath: string): Promise<number> {
  let failures = 0;
  const rows: unknown[] = [];
  for (const scenario of scenarios) {
    const outcome = await runScenario({ scenario, recording: loadRecording(recordingFor(scenario, scenariosPath)) });
    if (!outcome.pass) failures += 1;
    rows.push({ id: outcome.id, pass: outcome.pass, reasons: outcome.reasons, calls: outcome.calls.map(call => call.tool), spoken: outcome.spoken });
    process.stdout.write(`${outcome.pass ? 'PASS' : 'FAIL'} ${outcome.id}: ${outcome.calls.map(call => call.tool).join(', ') || '(no tool call)'}`
      + `${outcome.reasons.length === 0 ? '' : ` :: ${outcome.reasons.join('; ')}`}\n`);
  }
  process.stdout.write(`fake-model: ${scenarios.length - failures} PASS, ${failures} FAIL (no provider call, $0)\n`);
  process.stdout.write(`MACHINE ${JSON.stringify({ mode: 'fake-model', pass: failures === 0, rows })}\n`);
  return failures === 0 ? 0 : 1;
}

/** The audio probe: the same gates, the same adapter, an utterance instead of an ask. */
async function runAudio(options: Options): Promise<number> {
  const pcm = options.pcm === undefined ? synthUtterance() : readUtteranceFile(options.pcm);
  const source = options.pcm ?? 'synthetic tone generated in code';
  if (options.mode !== 'fake-model') {
    process.stdout.write(`${audioPlan({ bytes: pcm.length, source })}\n`);
    return 0;
  }
  const outcome = await runAudioProbe({ pcm, recording: loadRecording(join(dirname(options.scenarios), '..', 'recordings', 'audio-probe.json')) });
  const pass = outcome.connections === 1 && outcome.outputAudioFrames > 0 && outcome.uploadedBytes === pcm.length;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} audio probe: `
    + `${outcome.chunks} chunk(s), ${outcome.uploadedBytes} bytes up, ${outcome.outputAudioFrames} provider audio frame(s) dropped, `
    + `transcripts ${JSON.stringify(outcome.transcripts)}\n`);
  process.stdout.write(`MACHINE ${JSON.stringify({ mode: 'audio-probe', pass, ...outcome })}\n`);
  return pass ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const options = parse(argv);
  const scenarios = loadScenarios(options.scenarios);
  const rates = loadRates(here('../../../../config/eval-rates.json'));
  const judge = judgePrompt();
  const plan = buildPlan({ scenarios, rates, judgePrompt: judge });

  if (options.audio) return runAudio(options);

  if (options.mode === 'dry-run') {
    const text = formatPlan(plan);
    process.stdout.write(options.json ? `${JSON.stringify(plan)}\n` : `${text}\n`);
    // A dry run must not have touched the network: it built a plan and printed it.
    return 0;
  }

  if (options.mode === 'fake-model') return runFakeModel(scenarios, options.scenarios);

  const refusal = confirmPrice(plan, options.confirm);
  if (refusal !== undefined) {
    process.stderr.write(`eval-release: refusing the real run: ${refusal}\n`);
    return 2;
  }
  const key = process.env['OPENAI_API_KEY'];
  if (key === undefined || key.length === 0) {
    process.stderr.write('eval-release: refusing the real run: OPENAI_API_KEY is not set in this shell\n');
    return 2;
  }
  process.stderr.write('eval-release: the real transport is the owner\'s priced decision and is not wired in this wagon; '
    + 'the price gate above is what a real run must pass first\n');
  return 3;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`eval-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
