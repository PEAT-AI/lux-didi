import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, pairLocal, startHost, type HostConfig } from './runtime.js';
import { supervise } from './supervision.js';
import { ServiceError } from '../contracts/errors.js';
import { MongooseLoginError, runMongooseLogin, type MongooseLoginCode } from './mongoose-login.js';
import { loadMcpEndpoints } from '../config/mcp.js';

/** One owner line per login failure: a closed code and a plain sentence, never a URL or a token. */
const LOGIN_LINES: Record<MongooseLoginCode, string> = {
  'metadata-unavailable': 'the Mongoose server did not publish its OAuth metadata, so sign-in cannot start',
  'registration-refused': 'the Mongoose server refused to register the Lux Didi sign-in client',
  'port-in-use': 'port 8768 is already in use, so the sign-in callback could not listen',
  'state-mismatch': 'the sign-in reply did not match this request, so nothing was saved',
  'authorization-refused': 'the browser sign-in did not finish',
  'token-refused': 'the Mongoose server did not return a usable session',
  'browser-unavailable': 'the default browser could not be opened',
};

/**
 * The one stdout writer for the supervised protocol. The native supervisor treats every byte after
 * the ready frame as invalid output, so nothing but this named writer may reach process.stdout while
 * supervised. Callers must pass a single bounded protocol frame.
 */
function writeProtocolFrame(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: node server/dist/host/index.js [pair] [--mongoose-login] [--supervised] [--data-dir PATH] [--web-root BUILD] [--port 0..65535] [--descriptor PATH.json] [--config-dir PATH] [--owner-profile PATH]\nForeground, loopback-only; no bearer argument. Defaults: platform application data, repository web/dist, port 8765.\npair verifies current local service identity and prints a single-use browser pairing code, never a bearer.\n--mongoose-login runs the owner sign-in in the default browser once, then writes the private Mongoose session record.\n--supervised requires one bounded nonce JSON line on stdin, emits ready JSON, and closes on stdin EOF.\n');
    return;
  }
  const pairing = argv[0] === 'pair';
  if (pairing) argv = argv.slice(1);
  const login = argv.includes('--mongoose-login');
  if (login && pairing) throw new Error('Invalid sign-in configuration');
  argv = argv.filter(arg => arg !== '--mongoose-login');
  const supervised = argv.includes('--supervised');
  if (argv.filter(arg => arg === '--supervised').length > 1 || ((pairing || login) && supervised)) throw new Error('Invalid supervision configuration');
  argv = argv.filter(arg => arg !== '--supervised');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!['--data-dir', '--web-root', '--port', '--descriptor', '--config-dir', '--owner-profile'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Invalid host configuration; see --help');
    values.set(key, value);
  }
  const rawPort = values.get('--port') ?? process.env.DIDI_PORT ?? '8765';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid local port');
  const config: HostConfig = {
    dataDir: resolve(values.get('--data-dir') ?? process.env.DIDI_STATE_DIR ?? defaultDataDir()),
    webRoot: resolve(values.get('--web-root') ?? process.env.DIDI_WEB_ROOT ?? fileURLToPath(new URL('../../../web/dist', import.meta.url))),
    port: Number(rawPort),
  };
  if (values.has('--owner-profile')) config.ownerProfilePath = resolve(values.get('--owner-profile')!);
  if (values.has('--config-dir')) config.configDir = resolve(values.get('--config-dir')!);
  const descriptor = values.get('--descriptor') ?? process.env.DIDI_DESCRIPTOR;
  if (descriptor) config.descriptor = resolve(descriptor);
  if (pairing) { process.stdout.write(`${await pairLocal(config.dataDir, config.descriptor)}\n`); return; }
  if (login) { await runOwnerLogin(config); return; }
  // The supervised protocol writes its ready frame before any connector handshake; the connector
  // round starts from `host.start()` after the frame. Non-supervised starts keep the awaited shape.
  config.deferConnectors = supervised;
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
      writeProtocolFrame(frame);
    } else process.stdout.write(`Didi host ${host.descriptor.origin}; local memory/commitments available; model/notifications unavailable\n`);
    // The ready frame is on the wire; connector initialization starts here, each independently.
    void host.start().catch(() => { /* the host status reports each connector failure */ });
  } catch (error) {
    if (supervision && error instanceof ServiceError) {
      try { writeProtocolFrame({ type: 'error', schemaVersion: 1, code: error.code }); } catch { /* the exit status is the remaining signal */ }
    }
    supervision?.dispose();
    throw error;
  }

/**
 * The owner sign-in: one browser round, one atomic record write, one owner line. It never starts the
 * host, never opens a browser before the loopback listener is bound and never prints a token.
 */
async function runOwnerLogin(config: HostConfig): Promise<void> {
  const configDir = resolve(config.configDir ?? join(config.dataDir, 'provider-config'));
  const selection = loadMcpEndpoints({ configDir });
  const entry = selection.state === 'configured'
    ? selection.catalog.endpoints.find(candidate => candidate.connector === 'mongoose' && candidate.transport !== 'stdio' && candidate.credentialRef && candidate.url)
    : undefined;
  if (!entry || entry.transport === 'stdio' || !entry.credentialRef || !entry.url) throw new Error('Mongoose sign-in needs a configured mongoose endpoint with a credential reference');
  try {
    await runMongooseLogin({ configDir, reference: entry.credentialRef, resourceUrl: entry.url, account: entry.account, openBrowser: openInDefaultBrowser });
  } catch (error) {
    const code = error instanceof MongooseLoginError ? error.code : undefined;
    console.error(code ? `Mongoose sign-in failed: ${LOGIN_LINES[code]}.` : 'Mongoose sign-in failed.');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Mongoose sign-in complete. Restart Lux Didi to use it.\n');
}

function openInDefaultBrowser(url: string): void {
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}
}
// Node 26 main-module identity handles symlink spellings and stays false on import.
// https://nodejs.org/api/esm.html#importmetamain
if (import.meta.main) {
  void main().catch(error => {
    const code = error instanceof ServiceError ? error.code : undefined;
    console.error(error instanceof Error ? (code ? `${code}: ${error.message}` : error.message) : 'Host startup failed');
    process.exitCode = 1;
  });
}
