import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { startHost } from '../host/runtime.js';

/**
 * Real supervised host child for the live-gateway process case. Uses a local loopback upstream via the
 * trusted liveTesting seam (no Google/network call), announces identity, closes on stdin EOF, exits.
 */
const [mode, dataDir, configDir, webRoot] = process.argv.slice(2);
if (mode !== 'host' || !dataDir || !configDir || !webRoot) throw new Error('usage: live-gateway-process host <data-dir> <config-dir> <web-root>');

const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(upstream, 'listening');
const address = upstream.address();
if (!address || typeof address === 'string') throw new Error('upstream address unavailable');
upstream.on('connection', socket => { socket.on('error', () => {}); socket.on('message', () => {}); });

const host = await startHost({
  dataDir, configDir, webRoot, port: 0,
  liveTesting: {
    credentials: { resolve: async () => 'synthetic-local-key' },
    socketFactory: (_destination, config) => new WebSocket(`ws://127.0.0.1:${address.port}`, config),
  },
});
process.stdout.write(`${JSON.stringify({ origin: host.descriptor.origin, authorityEpoch: host.store.authorityEpoch, assistantId: host.store.assistantId })}\n`);
await new Promise<void>(resolve => { process.stdin.on('end', () => resolve()); process.stdin.resume(); });
await host.close();
for (const socket of upstream.clients) socket.terminate();
await new Promise<void>(resolve => upstream.close(() => resolve()));
process.exit(0);
