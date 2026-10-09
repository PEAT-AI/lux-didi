import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, pairLocal, startHost, type HostConfig } from './runtime.js';
import { supervise } from './supervision.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node server/dist/host/index.js [pair] [--supervised] [--data-dir PATH] [--web-root BUILD] [--port 0..65535] [--descriptor PATH.json]\nForeground, loopback-only; no bearer argument. Defaults: platform application data, repository web/dist, port 8765.\npair verifies current local service identity and prints a single-use browser pairing code, never a bearer.\n--supervised requires one bounded nonce JSON line on stdin, emits ready JSON, and closes on stdin EOF.');
    return;
  }
  const pairing = argv[0] === 'pair';
  if (pairing) argv = argv.slice(1);
  const supervised = argv.includes('--supervised');
  if (argv.filter(arg => arg === '--supervised').length > 1 || (pairing && supervised)) throw new Error('Invalid supervision configuration');
  argv = argv.filter(arg => arg !== '--supervised');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!['--data-dir', '--web-root', '--port', '--descriptor'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Invalid host configuration; see --help');
    values.set(key, value);
  }
  const rawPort = values.get('--port') ?? process.env.DIDI_PORT ?? '8765';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid local port');
  const config: HostConfig = {
    dataDir: resolve(values.get('--data-dir') ?? process.env.DIDI_STATE_DIR ?? defaultDataDir()),
    webRoot: resolve(values.get('--web-root') ?? process.env.DIDI_WEB_ROOT ?? fileURLToPath(new URL('../../../web/dist', import.meta.url))),
    port: Number(rawPort),
  };
  const descriptor = values.get('--descriptor') ?? process.env.DIDI_DESCRIPTOR;
  if (descriptor) config.descriptor = resolve(descriptor);
  if (pairing) { console.log(await pairLocal(config.dataDir, config.descriptor)); return; }
  const supervision = supervised ? supervise() : undefined;
  try {
    const nonce = supervision ? await supervision.nonce : undefined;
    if (supervision?.ended) { if (supervision.failure) throw supervision.failure; supervision.dispose(); return; }
    const host = await startHost(config);
    const stop = (error?: Error) => {
      if (error) { console.error(error.message); process.exitCode = 1; }
      void host.close().catch(() => { console.error('Host shutdown failed'); process.exitCode = 1; }).finally(() => supervision?.dispose());
    };
    process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
    supervision?.watch(stop);
    if (supervision?.ended) return;
    if (supervision) {
      const frame = { type: 'ready', schemaVersion: 1, nonce, pid: process.pid, origin: host.descriptor.origin, authorityEpoch: host.descriptor.authorityEpoch, assistantId: host.descriptor.assistantId };
      const output = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(output) > 1024) { stop(new Error('Readiness frame exceeds limit')); return; }
      process.stdout.on('error', stop);
      process.stdout.write(output);
    } else console.log(`Didi host ${host.descriptor.origin}; local memory/commitments available; model/notifications unavailable`);
  } catch (error) { supervision?.dispose(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : 'Host startup failed'); process.exitCode = 1; });
}
