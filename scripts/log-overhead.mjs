#!/usr/bin/env node
// W10 logging overhead measurement (A4). Reports the Node event-loop delay p99 with the
// typed host logger on versus off over the same synthetic duplex stream. No budget gate.
//
// The real audio path does not log per chunk: it logs an audio.flow every 5 s, a provider.turn
// per turn and a tool row per call. The default `periodic` mode mirrors that rate; `--burst`
// is the worst case of one emitHostEvent per simulated frame.
//
// Usage: node scripts/log-overhead.mjs [durationMs] [periodic|burst]
// Runs in this process only. It never starts a server, an audio engine or a provider.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLog, captureHostDiagnostics, emitHostEvent } from '../server/dist/host/log.js';

const durationMs = Number(process.argv[2] ?? 5000);
const mode = process.argv[3] ?? 'periodic';

function measure(logging) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-overhead-'));
  const stop = logging ? captureHostDiagnostics(new HostLog(dir)) : () => {};
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const frame = Buffer.alloc(640);
  const deadline = Date.now() + durationMs;
  let frames = 0;
  let emits = 0;
  return new Promise(resolve => {
    const pump = () => {
      // A bounded burst of duplex frames per tick, the same work with and without logging.
      for (let index = 0; index < 64; index += 1) {
        frame[0] = (frame[0] + 1) & 0xff;
        frames += 1;
      }
      if (logging && (mode === 'burst' || frames % 100_000 < 64)) {
        emitHostEvent('audio.flow', { side: 'host', final: false, bytesFromNative: frame.length, bytesToProvider: frame.length, bytesFromProvider: 0, bytesToNative: 0 });
        emits += 1;
      }
      if (Date.now() >= deadline) {
        histogram.disable();
        stop();
        rmSync(dir, { recursive: true, force: true });
        resolve({ p99Ms: histogram.percentile(99) / 1e6, meanMs: histogram.mean / 1e6, maxMs: histogram.max / 1e6, frames, emits });
        return;
      }
      setImmediate(pump);
    };
    pump();
  });
}

const off = await measure(false);
const on = await measure(true);
const round = value => Number(value.toFixed(3));
const report = {
  durationMs,
  mode,
  off: { p99Ms: round(off.p99Ms), meanMs: round(off.meanMs), maxMs: round(off.maxMs), frames: off.frames, emits: off.emits },
  on: { p99Ms: round(on.p99Ms), meanMs: round(on.meanMs), maxMs: round(on.maxMs), frames: on.frames, emits: on.emits },
  addedP99Ms: round(on.p99Ms - off.p99Ms),
};
process.stdout.write(JSON.stringify(report, null, 1) + '\n');
