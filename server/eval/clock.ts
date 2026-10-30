import { createRequire } from 'node:module';
import type { AlarmClock } from '../host/alarm-scheduler.js';

/** A virtual clock behind the host's own AlarmClock seam: nothing in eval mode ever waits on wall time. */
export interface VirtualClock extends AlarmClock {
  advanceTo(utc: number): number;
  advanceBy(ms: number): number;
  pending(): number;
}

interface Timer { at: number; fn: () => void; cancelled: boolean }

export function virtualClock(startUtc: number): VirtualClock {
  let now = startUtc;
  const timers: Timer[] = [];
  const fire = (): number => {
    let fired = 0;
    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= now).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next) return fired;
      next.cancelled = true;
      now = Math.max(now, next.at);
      next.fn();
      fired++;
    }
  };
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const timer: Timer = { at: now + Math.max(0, ms), fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle: unknown) {
      if (handle && typeof handle === 'object' && 'cancelled' in handle) (handle as Timer).cancelled = true;
    },
    advanceTo(utc: number) { now = Math.max(now, utc); return fire(); },
    advanceBy(ms: number) { now += Math.max(0, ms); return fire(); },
    pending: () => timers.filter(timer => !timer.cancelled).length,
  };
}

export interface GuardReport {
  /** Calls the guard refused: a socket connect, a fetch, a DNS lookup, a child process launch. */
  blocked(): number;
  /** Real timers armed during eval mode. A non-zero count means wall time leaked into a case. */
  realTimers(): number;
  /** Text the eval path tried to route to an audio device. Always zero: there is no device. */
  audioOutputs(): number;
}

const require = createRequire(import.meta.url);
const BLOCKED = [
  ['network', 'eval mode has no network: every connector is a fake'],
  ['process', 'eval mode launches no process: no audio player, no MCP child'],
] as const;

let report: GuardReport | undefined;

/**
 * Installs the eval-mode guards once per process. Network and process launch are refused at the module
 * boundary, so an unfaked connector or an audio player fails loudly instead of reaching the owner's Mac.
 */
export function installEvalGuards(): GuardReport {
  if (report) return report;
  let blocked = 0;
  let realTimers = 0;
  const refuse = (what: string): never => {
    blocked++;
    throw new Error(`eval_guard: ${what}`);
  };
  const net = require('node:net') as { Socket: { prototype: { connect: unknown } }; createConnection: unknown; connect?: unknown };
  net.Socket.prototype.connect = function connect() { return refuse(BLOCKED[0][1]); };
  (net as { createConnection: unknown }).createConnection = () => refuse(BLOCKED[0][1]);
  const dns = require('node:dns') as { lookup: unknown; promises: { lookup: unknown } };
  dns.lookup = () => refuse(BLOCKED[0][1]);
  dns.promises.lookup = async () => refuse(BLOCKED[0][1]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { refuse(BLOCKED[0][1]); }) as unknown as typeof originalFetch;
  const cp = require('node:child_process') as Record<string, unknown>;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) {
    cp[name] = () => refuse(BLOCKED[1][1]);
  }
  const globalTimers = globalThis as { setTimeout: typeof setTimeout };
  const realSetTimeout = globalTimers.setTimeout;
  globalTimers.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    realTimers++;
    return realSetTimeout(fn as never, ms, ...(rest as never[]));
  }) as typeof setTimeout;
  report = { blocked: () => blocked, realTimers: () => realTimers, audioOutputs: () => 0 };
  return report;
}

/** The one audio route an eval run could take: opening the real device-backed adapter. It never happens. */
let realAdapterOpens = 0;
export function noteRealAdapterOpen(): void { realAdapterOpens++; }
export function realAdapterOpenCount(): number { return realAdapterOpens; }
