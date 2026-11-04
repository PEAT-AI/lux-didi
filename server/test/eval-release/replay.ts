/**
 * The fake provider for `--fake-model`: recorded synthetic model turns, replayed over a loopback socket that
 * the real adapter's own `socketFactory` seam points at. Nothing leaves the machine, no key is read, and the
 * adapter cannot tell the difference between this and the provider's wire.
 *
 * A recording is a list of steps, each with the trigger that serves it: `start` on connect, `audio` on the owner's
 * uplink, `answer` on the host appending the delegated helper's answer, `continuation` on the `response.create` the
 * adapter writes after a host note. Frames are provider frames, verbatim; `audio_ms` is the provider's own
 * synthetic speech, generated here so a fixture carries no base64 blob.
 */

import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import type { LiveSocketFactory } from '../../adapters/live-voice/types.js';

export type ReplayTrigger = 'start' | 'answer' | 'continuation' | 'audio';

/** 24 kHz mono 16-bit PCM, the rate the adapter's own audio path declares. */
export const PROBE_RATE = 24_000;

/** A synthetic utterance: a 440 Hz tone at a fifth of full scale. Nothing recorded, nothing anyone said. */
export function tonePcm(samples: number): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let at = 0; at < samples; at += 1) {
    const amplitude = Math.round(Math.sin((2 * Math.PI * 440 * at) / PROBE_RATE) * 6_500);
    view.setInt16(at * 2, amplitude, true);
  }
  return pcm;
}

/** The calls the helper makes and the answer it hands back to the host, both from the fixture. */
export interface HelperWork {
  readonly calls: readonly { readonly tool: string; readonly args?: Record<string, unknown> }[];
  readonly answer: string;
}

export interface ReplayStep {
  readonly trigger: ReplayTrigger;
  readonly frames: readonly Record<string, unknown>[];
  /** Milliseconds of audible provider speech to send before the frames: the adapter never completes a silent turn. */
  readonly audio_ms?: number;
  /** What the host's helper does for the delegation this step serves: the evaluation's stand-in for the helper. */
  readonly helper?: HelperWork;
}

export interface Recording { readonly provenance?: Readonly<Record<string, unknown>>; readonly steps: readonly ReplayStep[] }

const TRIGGERS: readonly string[] = ['start', 'answer', 'continuation', 'audio'];

export function loadRecording(path: string): Recording {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const steps = Array.isArray(raw['steps']) ? raw['steps'] as Record<string, unknown>[] : [];
  if (steps.length === 0) throw new Error(`${path}: no steps`);
  return {
    steps: steps.map((step, at) => {
      const trigger = step['trigger'];
      if (typeof trigger !== 'string' || !TRIGGERS.includes(trigger)) throw new Error(`${path}: steps[${at}] trigger is not one of ${TRIGGERS.join(', ')}`);
      const frames = Array.isArray(step['frames']) ? step['frames'] as Record<string, unknown>[] : [];
      if (frames.length === 0) throw new Error(`${path}: steps[${at}] has no frames`);
      return {
        trigger: trigger as ReplayTrigger, frames,
        ...(typeof step['audio_ms'] === 'number' ? { audio_ms: step['audio_ms'] } : {}),
        ...(helperWork(step['helper'], `${path}: steps[${at}].helper`) ?? {}),
      };
    }),
  };
}

function helperWork(raw: unknown, where: string): { helper: HelperWork } | undefined {
  if (raw === undefined) return undefined;
  const value = raw as Record<string, unknown>;
  const answer = typeof value['answer'] === 'string' && value['answer'].length > 0 ? value['answer'] : undefined;
  if (answer === undefined) throw new Error(`${where}.answer is required`);
  const calls = (Array.isArray(value['calls']) ? value['calls'] as Record<string, unknown>[] : []).map((call, at) => {
    if (typeof call['tool'] !== 'string' || call['tool'].length === 0) throw new Error(`${where}.calls[${at}].tool is required`);
    return call['args'] === undefined ? { tool: call['tool'] } : { tool: call['tool'], args: call['args'] as Record<string, unknown> };
  });
  return { helper: { calls, answer } };
}

export interface Replay {
  /** The seam the adapter opens its socket through. */
  readonly socketFactory: LiveSocketFactory;
  readonly connections: () => number;
  /** Every frame the adapter wrote, in order: the plan and the assertions both read this. */
  readonly frames: Record<string, unknown>[];
  /** Resolves once every step has been served and its frames handed to the socket. */
  readonly served: () => Promise<void>;
  /** How many steps have been served, and how many the recording holds: a bounded wait reads these. */
  readonly servedCount: () => number;
  readonly totalSteps: () => number;
  /** The work the fixture's helper does for the delegation just served, taken once: undefined means unfixtured. */
  readonly takeDelegation: () => HelperWork | undefined;
  readonly close: () => Promise<void>;
}

/** Serve one recording over 127.0.0.1:0. The caller owns `close`; no external host is ever contacted. */
export async function replayServer(recording: Recording): Promise<Replay> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const frames: Record<string, unknown>[] = [];
  const counters = { connections: 0 };
  let peer: WebSocket | undefined;
  const queue = [...recording.steps];
  const total = queue.length;
  let served = 0;
  let idle: () => void = () => {};
  const settled = new Promise<void>(resolve => { idle = resolve; });

  let started = false;
  let delegated: HelperWork | undefined;
  const next = (trigger: ReplayTrigger): void => {
    const step = queue.shift();
    if (step === undefined || step.trigger !== trigger) { queue.unshift(...(step === undefined ? [] : [step])); return; }
    if (step.audio_ms !== undefined) {
      const pcm = tonePcm(Math.round((step.audio_ms * PROBE_RATE) / 1_000));
      peer?.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') }));
    }
    for (const frame of step.frames) peer?.send(JSON.stringify(frame));
    if (step.helper !== undefined) delegated = step.helper;
    served += 1;
    if (served >= total) idle();
  };

  server.on('connection', socket => {
    counters.connections += 1;
    peer = socket;
    socket.on('error', () => {});
    socket.on('message', (bytes: Buffer) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(bytes.toString()) as Record<string, unknown>; } catch { return; }
      frames.push(frame);
      // The adapter opens the session with its own create frame: the provider greets only after it, as it does live.
      if (!started) { started = true; next('start'); return; }
      // An owner ask reaches the wire as `session.input_audio.append` (the adapter is audio-only), the helper's
      // answer as `session.commentary.append`, and a host-note follow-up as `response.create`. Each one serves the
      // next step recorded with that trigger.
      const trigger = frame['type'] === 'session.input_audio.append' ? 'audio'
        : frame['type'] === 'session.commentary.append' ? 'answer'
          : frame['type'] === 'response.create' ? 'continuation' : undefined;
      if (trigger !== undefined) next(trigger);
    });
  });

  return {
    socketFactory: (_destination, options) => new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, options),
    connections: () => counters.connections,
    frames,
    served: () => settled,
    servedCount: () => served,
    totalSteps: () => total,
    takeDelegation: () => { const work = delegated; delegated = undefined; return work; },
    close: async () => {
      peer?.close(1000, 'replay done');
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
