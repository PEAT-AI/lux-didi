#!/usr/bin/env node
// W10 logging overhead measurement (A4). Reports the Node event-loop delay p99 with the
// typed host logger on versus off, over the same synthetic duplex stream. No budget gate.
//
// Usage: node scripts/log-overhead.mjs [durationMs]
// Runs in this process only. It never starts a server, an audio engine or a provider.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLog, captureHostDiagnostics, emitHostEvent } from '../server/dist/host/log.js';

const durationMs = Number(process.argv[2] ?? 5000);

function measure(logging) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-overhead-'));
  const stop = logging ? captureHostDiagnostics(new HostLog(dir)) : () => {};
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const frame = Buffer.alloc(640);
  const deadline = Date.now() + durationMs;
  let frames = 0;
  return new Promise(resolve => {
    const pump = () => {
      // A bounded burst of duplex frames per tick, the same work with and without logging.
      for (let index = 0; index < 64; index += 1) {
        frame[0] = (frame[0] + 1) & 0xff;
        if (logging) emitHostEvent('audio.flow', { side: 'host', final: false, bytesFromNative: frame.length, bytesToProvider: frame.length, bytesFromProvider: 0, bytesToNative: 0 });
        frames += 1;
      }
      if (Date.now() >= deadline) {
        histogram.disable();
        stop();
        rmSync(dir, { recursive: true, force: true });
        resolve({ p99Ms: histogram.percentile(99) / 1e6, meanMs: histogram.mean / 1e6, maxMs: histogram.max / 1e6, frames });
        return;
      }
      setImmediate(pump);
    };
    pump();
  });
}

const off = await measure(false);
const on = await measure(true);
const report = {
  durationMs,
  off: { p99Ms: Number(off.p99Ms.toFixed(3)), meanMs: Number(off.meanMs.toFixed(3)), maxMs: Number(off.maxMs.toFixed(3)), frames: off.frames },
  on: { p99Ms: Number(on.p99Ms.toFixed(3)), meanMs: Number(on.meanMs.toFixed(3)), maxMs: Number(on.maxMs.toFixed(3)), frames: on.frames },
  addedP99Ms: Number((on.p99Ms - off.p99Ms).toFixed(3)),
};
process.stdout.write(JSON.stringify(report, null, 1) + '\n');
