import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './runtime/store.js';
import { listenService } from './http/server.js';
// Deliberately no domain import until sibling domain is integrated and verified.
export async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('No CLI arguments supported; configure DIDI_STATE_DIR and DIDI_PORT, never tokens in argv');
  const directory = process.env.DIDI_STATE_DIR;
  if (!directory) throw new Error('DIDI_STATE_DIR must identify a private single-user state directory');
  const rawPort = process.env.DIDI_PORT ?? '8765';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid DIDI_PORT');
  const store = new Store(resolve(directory));
  try {
    const service = await listenService({ store, port: Number(rawPort) });
    console.log(`Didi runtime ${service.origin}; domain unavailable; credential in private state directory`);
    let closing = false;
    const stop = () => { if (closing) return; closing = true; void service.close().then(() => { store.close(); }).catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { store.close(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error instanceof Error ? error.message : 'Service startup failed'); process.exitCode = 1; });
