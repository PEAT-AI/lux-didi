/**
 * The fake provider for `--fake-model`: recorded synthetic model turns, replayed over a loopback socket that
 * the real adapter's own `socketFactory` seam points at. Nothing leaves the machine, no key is read, and the
 * adapter cannot tell the difference between this and the provider's wire.
 *
 * A recording is a list of steps, each with the trigger that serves it: `start` on connect, `owner` on an owner
 * ask, `continuation` on the `response.create` that follows a tool answer. Frames are provider frames, verbatim.
 */

import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import type { LiveSocketFactory } from '../../adapters/live-voice/types.js';

export type ReplayTrigger = 'start' | 'owner' | 'continuation' | 'audio';

export interface ReplayStep { readonly trigger: ReplayTrigger; readonly frames: readonly Record<string, unknown>[] }

export interface Recording { readonly provenance?: Readonly<Record<string, unknown>>; readonly steps: readonly ReplayStep[] }

const TRIGGERS: readonly string[] = ['start', 'owner', 'continuation', 'audio'];

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
      return { trigger: trigger as ReplayTrigger, frames };
    }),
  };
}

export interface Replay {
  /** The seam the adapter opens its socket through. */
  readonly socketFactory: LiveSocketFactory;
  readonly connections: () => number;
  /** Every frame the adapter wrote, in order: the plan and the assertions both read this. */
  readonly frames: Record<string, unknown>[];
  /** Resolves once every step has been served and its frames handed to the socket. */
  readonly served: () => Promise<void>;
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
  const next = (trigger: ReplayTrigger): void => {
    const step = queue.shift();
    if (step === undefined || step.trigger !== trigger) { queue.unshift(...(step === undefined ? [] : [step])); return; }
    for (const frame of step.frames) peer?.send(JSON.stringify(frame));
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
      // An owner ask reaches the wire as `response.item.create`, its audio as `session.input_audio.append`, and the
      // answer's continuation as `response.create`. Each one serves the next step recorded with that trigger.
      const trigger = frame['type'] === 'response.item.create' ? 'owner'
        : frame['type'] === 'session.input_audio.append' ? 'audio'
          : frame['type'] === 'response.create' ? 'continuation' : undefined;
      if (trigger !== undefined) next(trigger);
    });
  });

  return {
    socketFactory: (_destination, options) => new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, options),
    connections: () => counters.connections,
    frames,
    served: () => settled,
    close: async () => {
      peer?.close(1000, 'replay done');
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
