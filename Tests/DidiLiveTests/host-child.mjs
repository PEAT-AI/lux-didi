// Trusted test-only host child. Never exposed through CLI/environment/config of the production host.
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from '../../server/node_modules/ws/wrapper.mjs';
import { startHost } from '../../server/dist/host/runtime.js';
import { defaultLiveLimits } from '../../server/dist/live/index.js';
const [dataDir, configDir, webRoot] = process.argv.slice(2);
const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(provider, 'listening');
provider.on('connection', socket => {
  socket.on('error', () => {});
  socket.on('message', raw => {
    if (JSON.parse(raw.toString()).setup) socket.send(JSON.stringify({ setupComplete: {} }));
  });
});
const profile = { provider: 'gemini', liveModelId: 'models/native-live-synthetic', voice: 'SyntheticVoice', keyReference: 'fixture-only',
  route: { enabled: true, provider: 'gemini', modelId: 'models/native-live-synthetic', dataClasses: ['ordinary', 'private'] },
  prompt: { text: 'Synthetic silent protocol test', dataClass: 'ordinary' },
  limits: { ...defaultLiveLimits, unusedMs: 10000, handshakeMs: 2000, closeMs: 100, sessionMs: 20000, idleMs: 200 } };
const host = await startHost({ dataDir, configDir, webRoot, port: 0, liveTesting: { profile,
  credentials: { resolve: async () => 'SYNTHETIC-NONACCOUNT-NATIVE-LIVE' },
  socketFactory: () => new WebSocket(`ws://127.0.0.1:${provider.address().port}`),
} });
// Profile identity comes from the safe frozen profile, not a credential payload.
const { liveProfileIdentity } = await import('../../server/dist/live/config.js');
process.stdout.write(JSON.stringify({ ...host.descriptor, profileIdentity: liveProfileIdentity(profile) }) + '\n');
await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume(); });
await host.close();
for (const peer of provider.clients) peer.terminate();
await new Promise(resolve => provider.close(resolve));
process.exit(0);
