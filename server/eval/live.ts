import { createLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveSocketFactory, LiveVoiceEvent, LiveVoicePort, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import type { DataClass } from '../adapters/model/types.js';
import type { TurnPlan, TurnProvider } from './scripted.js';
import type { EvalCase } from './types.js';
import type { FakeWorld, ToolMap } from './world.js';

/**
 * Live mode: the owner's configured realtime model answers each case's own ask against the fake world.
 * It costs money, so no check and no CI run reaches it; `scripts/run-local-evals.sh --live` is the only
 * caller and it prints the call count and the estimate before the first session opens.
 */
export const LIVE_PRICES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } as const;
/** One case is one session: a text ask in, an answer and at most a handful of tool calls out. */
export const TOKENS_PER_CASE = { input: 6_000, output: 900 } as const;

export interface LiveCost { modelCalls: number; estimatedUsd: number; tokensIn: number; tokensOut: number }

export function estimateLiveCost(cases: readonly EvalCase[]): LiveCost {
  const tokensIn = cases.length * TOKENS_PER_CASE.input;
  const tokensOut = cases.length * TOKENS_PER_CASE.output;
  return {
    modelCalls: cases.length, tokensIn, tokensOut,
    estimatedUsd: (tokensIn / 1e6) * LIVE_PRICES.inputUsdPerMTok + (tokensOut / 1e6) * LIVE_PRICES.outputUsdPerMTok,
  };
}

export function formatLiveCost(cost: LiveCost): string {
  return `live mode: ${cost.modelCalls} model calls, about ${cost.tokensIn} prompt and ${cost.tokensOut} response tokens, estimated $${cost.estimatedUsd.toFixed(2)}`;
}

export interface LiveSessionOptions {
  readonly port: LiveVoicePort;
  readonly system: { text: string; dataClass: DataClass };
  readonly dataClasses: readonly DataClass[];
  readonly ask: string;
  readonly onTool: (call: { name: string; args: Record<string, unknown> }) => Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface LiveTurnResult { reply: string; calls: { tool: string; args: Record<string, unknown> }[]; promptTokens: number; responseTokens: number }

/** One text turn against the real adapter: finals arrive as output transcription, tool calls are answered. */
export async function liveTurn(options: LiveSessionOptions): Promise<LiveTurnResult> {
  const deadline = options.timeoutMs ?? 60_000;
  const request: LiveVoiceRequest = { system: options.system, dataClasses: [...options.dataClasses] };
  const session = options.port.open(request, { signal: AbortSignal.timeout(deadline), deadlineMs: Date.now() + deadline });
  await session.ready;
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let reply = '';
  let promptTokens = 0;
  let responseTokens = 0;
  session.sendText({ text: options.ask });
  for await (const event of session.events as AsyncIterable<LiveVoiceEvent>) {
    if (event.type === 'outputTranscription' && event.text) reply = `${reply} ${event.text}`.trim();
    if (event.type === 'contextUsage') { promptTokens = event.promptTokens ?? 0; responseTokens = event.responseTokens ?? 0; }
    if (event.type === 'toolCall') {
      const responses = event.calls.map(call => {
        const args = (call.args ?? {}) as Record<string, unknown>;
        calls.push({ tool: call.name, args });
        return { id: call.id, name: call.name, response: options.onTool({ name: call.name, args }) };
      });
      session.sendToolResponse({ responses });
    }
    if (event.type === 'turnComplete') { session.close(); break; }
    if (event.type === 'outcome') break;
  }
  return { reply: reply.trim(), calls, promptTokens, responseTokens };
}

export interface LiveProviderOptions {
  readonly port: LiveVoicePort;
  readonly system: { text: string; dataClass: DataClass };
}

export const lastUsage: { caseId: string; promptTokens: number; responseTokens: number }[] = [];

/** The provider used by `--live`: its tool calls execute against the fake world, never a real connector. */
export function liveProvider(options: LiveProviderOptions): TurnProvider {
  return {
    mode: 'live',
    plan: async ({ case: evalCase, world }): Promise<TurnPlan> => {
      const turn = await liveTurn({
        port: options.port, system: options.system, dataClasses: [options.system.dataClass],
        ask: evalCase.finals.join(' '),
        onTool: (call: { name: string; args: Record<string, unknown> }) => {
          const result = world.call({ tool: call.name, args: call.args });
          return { ok: result.ok, ...result.data };
        },
      });
      lastUsage.push({ caseId: evalCase.id, promptTokens: turn.promptTokens, responseTokens: turn.responseTokens });
      return { calls: turn.calls, reply: turn.reply };
    },
  };
}

export function measuredCost(): LiveCost {
  const tokensIn = lastUsage.reduce((sum, entry) => sum + entry.promptTokens, 0);
  const tokensOut = lastUsage.reduce((sum, entry) => sum + entry.responseTokens, 0);
  return {
    modelCalls: lastUsage.length, tokensIn, tokensOut,
    estimatedUsd: (tokensIn / 1e6) * LIVE_PRICES.inputUsdPerMTok + (tokensOut / 1e6) * LIVE_PRICES.outputUsdPerMTok,
  };
}

export interface LivePortInput {
  readonly modelId: string;
  readonly voice: string;
  readonly keyReference: string;
  readonly resolveKey: () => Promise<string>;
  readonly route: { provider: 'gemini'; modelId: string; dataClasses: readonly DataClass[] };
  /** C-POSTTOOL switch a, probe only. */
  readonly firstResponseAudio?: boolean;
  /** C-POSTTOOL switch b, probe only. */
  readonly backendBrevityTight?: boolean;
  /** The probe's counting tap; absent, the adapter opens its own socket. */
  readonly socketFactory?: LiveSocketFactory;
}

/** Builds the adapter the owner's own live configuration selected; the caller resolves the key slot. */
export function livePort(input: LivePortInput): LiveVoicePort {
  return createLiveVoiceAdapter({
    modelId: input.modelId,
    voice: input.voice,
    keyReference: input.keyReference,
    credentials: { resolve: input.resolveKey },
    route: input.route as unknown as Parameters<typeof createLiveVoiceAdapter>[0]['route'],
    // C-POSTTOOL: the probe's switches and its counting wire tap. The ordinary eval run passes neither, so the
    // adapter stays on its documented defaults.
    ...(input.firstResponseAudio === undefined ? {} : { firstResponseAudio: input.firstResponseAudio }),
    ...(input.backendBrevityTight === undefined ? {} : { backendBrevityTight: input.backendBrevityTight }),
    ...(input.socketFactory === undefined ? {} : { socketFactory: input.socketFactory }),
  });
}

export type { FakeWorld, ToolMap };
