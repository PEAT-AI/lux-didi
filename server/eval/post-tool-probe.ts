import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { ClientOptions } from 'ws';
import type { DataClass } from '../adapters/model/types.js';
import type { LiveSocketFactory, LiveVoiceEvent, LiveVoicePort } from '../adapters/live-voice/types.js';
import { alarmWorld } from './alarms.js';
import { LIVE_PRICES, TOKENS_PER_CASE, livePort, type LiveCost } from './live.js';
import { loadCases, loadToolMap } from './runner.js';
import type { EvalCase } from './types.js';
import { fakeWorld, type ToolMap } from './world.js';

/**
 * C-POSTTOOL wire probe. Synthetic asks, the real adapter, the fake world: the only thing it spends is the
 * provider's own tokens, so it prints the estimate first and refuses without `--go`. It never stores audio,
 * never plays anything and opens no device: each variant's audio deltas are written as counts only.
 *
 * Variants: baseline (both switches off), a (firstResponseAudio), b (backendBrevityTight), ab (both).
 * One ask is one session, so the create count, `silent rescue used` and `audible responses` are exact.
 */
export const PROBE_ASKS = 12;

export interface ProbeVariant {
  readonly name: 'baseline' | 'a' | 'b' | 'ab';
  readonly firstResponseAudio: boolean;
  readonly backendBrevityTight: boolean;
}

export const PROBE_VARIANTS: readonly ProbeVariant[] = [
  { name: 'baseline', firstResponseAudio: false, backendBrevityTight: false },
  { name: 'a', firstResponseAudio: true, backendBrevityTight: false },
  { name: 'b', firstResponseAudio: false, backendBrevityTight: true },
  { name: 'ab', firstResponseAudio: true, backendBrevityTight: true },
];

/** The asks are the public cases that expect a tool call, in catalogue order, capped at `asks`. */
export function selectProbeCases(cases: readonly EvalCase[], asks = PROBE_ASKS): EvalCase[] {
  return cases.filter(entry => entry.public_ok && entry.expected_tools.length > 0).slice(0, asks);
}

export function probeCost(asks: number, variants: number): LiveCost {
  const sessions = asks * variants;
  const tokensIn = sessions * TOKENS_PER_CASE.input;
  const tokensOut = sessions * TOKENS_PER_CASE.output;
  return {
    modelCalls: sessions, tokensIn, tokensOut,
    estimatedUsd: (tokensIn / 1e6) * LIVE_PRICES.inputUsdPerMTok + (tokensOut / 1e6) * LIVE_PRICES.outputUsdPerMTok,
  };
}

export function formatProbeCost(cost: LiveCost, asks: number, variants: number): string {
  return `post-tool probe: ${variants} variants x ${asks} asks = ${cost.modelCalls} sessions, about `
    + `${cost.tokensIn} prompt and ${cost.tokensOut} response tokens, estimated cost $${cost.estimatedUsd.toFixed(2)}`;
}

/** The estimate the probe prints before it starts, and the one line that says what it will never keep. */
export function probeEstimate(asks: number, variants: number): string {
  return `${formatProbeCost(probeCost(asks, variants), asks, variants)}\n`
    + 'pass --go to start. Nothing is stored but counts: no audio, no transcript, no device.';
}

/** What one ask recorded. Audio appears as counts, never as content. */
export interface ProbeAskRecord {
  readonly caseId: string;
  /** Whether the first post-tool response made audio audible, before any later create. */
  readonly firstResponseAudio: boolean;
  /** Tool output write to the first audible delta, ms, or null when nothing became audible. */
  readonly toolOutputToAudioMs: number | null;
  /** A create after a post-tool response that produced no audio: the silent rescue fired. */
  readonly silentRescueUsed: boolean;
  /** Creates the adapter sent after the tool output in this ask. */
  readonly postToolCreates: number;
  /** Audible stretches after the tool output: how many times the owner was spoken to. */
  readonly audibleResponses: number;
  /** Inbound audio delta frames, counted only. */
  readonly audioDeltas: number;
  /** Characters of backend and voice text the voice model would read, as tokens at four characters each. */
  readonly textTokens: number;
  /** Set when the ask was abandoned and the variant stops here. */
  readonly stopped?: string;
}

/** The tap sees outbound command types and inbound audio deltas, and nothing else: no payload is kept. */
interface WireTap { readonly creates: number[]; readonly audibleAt: number[] }

export const tappedSocketFactory = (tap: WireTap): LiveSocketFactory =>
  (destination: string, options: ClientOptions) => {
    const socket = new WebSocket(destination, options);
    const send = socket.send.bind(socket);
    socket.send = ((data: string, callback?: (error?: Error) => void) => {
      if (typeof data === 'string' && data.length && data[0] === '{') {
        const frame = JSON.parse(data) as { type?: string };
        if (frame.type === 'response.create') tap.creates.push(Date.now());
      }
      return send(data, callback);
    }) as typeof socket.send;
    return socket;
  };

export interface ProbePortInput {
  readonly modelId: string; readonly voice: string; readonly keyReference: string;
  readonly resolveKey: () => Promise<string>;
  readonly route: { provider: 'gemini'; modelId: string; dataClasses: readonly DataClass[] };
}

type PortFactory = (input: ProbePortInput, variant: ProbeVariant, tap: WireTap) => LiveVoicePort;

export interface ProbeDeps {
  readonly casesDir: string;
  readonly toolMapPath: string;
  readonly system: { text: string; dataClass: DataClass };
  readonly port: ProbePortInput;
  readonly portFactory: PortFactory;
  readonly timeoutMs?: number;
  readonly asks?: number;
  readonly variants?: readonly ProbeVariant[];
  readonly log?: (line: string) => void;
}

/** Runs one ask end to end and records counts only. */
async function runAsk(
  deps: ProbeDeps, variant: ProbeVariant, evalCase: EvalCase, toolMap: ToolMap,
): Promise<ProbeAskRecord> {
  const tap: WireTap = { creates: [], audibleAt: [] };
  const port = deps.portFactory(deps.port, variant, tap);
  const timeoutMs = deps.timeoutMs ?? 90_000;
  let toolOutputAt: number | null = null;
  let firstAudioAt: number | null = null;
  let audioDeltas = 0;
  let textChars = 0;
  let stopped: string | undefined;
  const startUtc = Date.parse(evalCase.setup.clock_T0);
  const env = alarmWorld(startUtc);
  const world = fakeWorld({ case: evalCase, clock: env.clock, alarms: env.world, toolMap });
  const session = port.open(
    { system: deps.system, dataClasses: [deps.system.dataClass] },
    { signal: AbortSignal.timeout(timeoutMs), deadlineMs: Date.now() + timeoutMs },
  );
  try {
    await session.ready;
    session.sendText({ text: evalCase.finals.join(' ') });
    for await (const event of session.events as AsyncIterable<LiveVoiceEvent>) {
      if (event.type === 'toolCall') {
        const responses = event.calls.map(call => {
          const result = world.call({ tool: call.name, args: call.args as Record<string, unknown> });
          if (!result.ok) stopped = `tool_error:${call.name}`;
          return { id: call.id, name: call.name, response: { ok: result.ok, ...result.data } };
        });
        if (toolOutputAt === null) toolOutputAt = Date.now();
        const outcome = session.sendToolResponse({ responses });
        if (outcome === 'failed') stopped = 'protocol_rejection';
        if (stopped !== undefined) break;
      }
      if (event.type === 'audio') {
        audioDeltas += 1;
        if (event.audible) {
          tap.audibleAt.push(Date.now());
          if (firstAudioAt === null && toolOutputAt !== null) firstAudioAt = Date.now();
        }
      }
      if (event.type === 'outputTranscription' || event.type === 'modelText') textChars += event.text.length;
      if (event.type === 'turnFailed') { stopped = `turn_failed:${event.code}`; break; }
      if (event.type === 'outcome') {
        if (event.outcome.status !== 'closed' && event.outcome.recoverable !== true) stopped = `outcome:${event.outcome.status}`;
        break;
      }
      if (event.type === 'turnComplete') break;
    }
  } catch (error) {
    stopped = `session_error:${error instanceof Error ? error.message : String(error)}`;
  } finally {
    session.close();
  }
  const creates = tap.creates.filter(time => toolOutputAt !== null && time >= toolOutputAt);
  const audible = tap.audibleAt.filter(time => toolOutputAt !== null && time >= toolOutputAt);
  // One audible stretch per create that was followed by audio: a later create starts a new stretch.
  let audibleResponses = 0;
  for (const [index, at] of creates.entries()) {
    const next = creates[index + 1];
    if (audible.some(time => time >= at && (next === undefined || time < next))) audibleResponses += 1;
  }
  const beforeSecondCreate = (time: number) => creates[1] === undefined || time < creates[1];
  const firstResponseAudio = creates.length > 0 && audible.some(time => time >= creates[0]! && beforeSecondCreate(time));
  const silentRescueUsed = creates.length > 1 && !audible.some(time => time >= creates[0]! && time < creates[1]!);
  if (audibleResponses > 1 && stopped === undefined) stopped = 'duplicate_speech';
  return {
    caseId: evalCase.id,
    firstResponseAudio,
    toolOutputToAudioMs: firstAudioAt === null || toolOutputAt === null ? null : Math.max(0, firstAudioAt - toolOutputAt),
    silentRescueUsed,
    postToolCreates: creates.length,
    audibleResponses,
    audioDeltas,
    textTokens: Math.round(textChars / 4),
    ...(stopped === undefined ? {} : { stopped }),
  };
}

export interface ProbeVariantResult {
  readonly variant: ProbeVariant;
  readonly asks: readonly ProbeAskRecord[];
  readonly stopped: string | null;
}

/** The one line per variant: counts only, no audio, no text. */
export function formatVariant(result: ProbeVariantResult): string {
  const rows = result.asks;
  const answered = rows.filter(row => row.firstResponseAudio).length;
  const times = rows.map(row => row.toolOutputToAudioMs)
    .filter((value): value is number => value !== null).sort((a, b) => a - b);
  const p50 = times.length ? times[Math.floor((times.length - 1) / 2)]! : null;
  const silentRescues = rows.filter(row => row.silentRescueUsed).length;
  const audible = rows.reduce((sum, row) => sum + row.audibleResponses, 0);
  const deltas = rows.reduce((sum, row) => sum + row.audioDeltas, 0);
  const tokens = rows.reduce((sum, row) => sum + row.textTokens, 0);
  return `variant ${result.variant.name}: asks ${rows.length}, first response audio ${answered}/${rows.length}, `
    + `tool output to first audio p50 ${p50 === null ? 'none' : `${p50} ms`}, silent rescues ${silentRescues}, `
    + `audible responses ${audible}, audio deltas ${deltas}, text tokens ${tokens}`
    + (result.stopped === null ? '' : `, STOPPED ${result.stopped}`);
}

export async function runPostToolProbe(deps: ProbeDeps): Promise<ProbeVariantResult[]> {
  const asks = deps.asks ?? PROBE_ASKS;
  const variants = deps.variants ?? PROBE_VARIANTS;
  const log = deps.log ?? ((line: string) => console.log(line));
  const toolMap = loadToolMap(deps.toolMapPath);
  const selected = selectProbeCases(loadCases(deps.casesDir), asks);
  const results: ProbeVariantResult[] = [];
  for (const variant of variants) {
    const records: ProbeAskRecord[] = [];
    let stopped: string | null = null;
    for (const evalCase of selected) {
      const record = await runAsk(deps, variant, evalCase, toolMap);
      records.push(record);
      if (record.stopped !== undefined) { stopped = `${evalCase.id}: ${record.stopped}`; break; }
    }
    const result: ProbeVariantResult = { variant, asks: records, stopped };
    results.push(result);
    log(formatVariant(result));
  }
  return results;
}

/**
 * The probe's own entry point. Without `--go` it prints the estimate and stops: the master runs it, and the
 * spend is one explicit word away. It reads the owner's live configuration only for the model and key slot.
 */
export async function postToolProbeMain(argv: readonly string[], root: string): Promise<number> {
  const asks = PROBE_ASKS;
  const estimate = probeEstimate(asks, PROBE_VARIANTS.length);
  if (!argv.includes('--go')) {
    console.log(estimate);
    console.log('refusing to spend: pass --go to run these asks against the real model');
    return 2;
  }
  const { loadLiveConfig } = await import('../config/live.js');
  const configDir = process.env['LUX_DIDI_CONFIG_DIR'] ?? join(process.env['HOME'] ?? '', 'Library', 'Application Support', 'Lux Didi');
  const loaded = loadLiveConfig({ configDir, ownerId: process.env['LUX_DIDI_OWNER_ID'] ?? 'local-owner' });
  if (loaded.status !== 'configured') {
    console.log(`PROBE UNAVAILABLE: the live provider config is ${loaded.status}`);
    return 3;
  }
  const profile = loaded.config.profile;
  const envKey = profile.provider === 'openai' ? process.env['OPENAI_API_KEY'] : process.env['GEMINI_API_KEY'];
  if (!envKey) {
    console.log(`PROBE UNAVAILABLE: set ${profile.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'}`);
    return 3;
  }
  console.log(estimate);
  await runPostToolProbe({
    casesDir: join(root, 'server', 'eval', 'cases'),
    toolMapPath: join(root, 'server', 'eval', 'tool-map.json'),
    system: profile.prompt,
    port: { modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference, resolveKey: async () => envKey, route: profile.route as unknown as ProbePortInput['route'] },
    portFactory: (input, variant, tap) => livePort({
      ...input,
      firstResponseAudio: variant.firstResponseAudio,
      backendBrevityTight: variant.backendBrevityTight,
      socketFactory: tappedSocketFactory(tap),
    }),
  });
  return 0;
}

/** The repo root of the compiled probe: `dist/eval/post-tool-probe.js` sits two levels under it. */
function repoRoot(): string { return resolve(fileURLToPath(import.meta.url), '..', '..', '..'); }
function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
if (process.argv[1] && canonicalPath(resolve(process.argv[1])) === canonicalPath(fileURLToPath(import.meta.url))) {
  void postToolProbeMain(process.argv.slice(2), repoRoot()).then(code => { process.exitCode = code; })
    .catch(error => { console.error(`post-tool probe failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
