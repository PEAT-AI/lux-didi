import WebSocket from 'ws';
import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { chatMigrations } from '../chat/index.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext } from '../live/index.js';

const [mode, dir, port, key] = process.argv.slice(2);
if (!mode || !dir || !port || !key) throw new Error('usage: live-session-process <mode> <dir> <port> <key>');

const domain = createDomainPort({ outbox: Outbox });
const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
const profile = validateLiveProfile({
  provider: 'gemini', liveModelId: 'models/live-session-test', voice: 'ExplicitVoice', keyReference: 'test-reference',
  route: { enabled: true, provider: 'gemini', modelId: 'models/live-session-test', dataClasses: ['ordinary'] },
  prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
});
const voice = new GeminiLiveVoiceAdapter({
  modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
  route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
  credentials: { resolve: async () => 'synthetic-child-credential' },
  limits: { handshakeMs: 2000, idleMs: 3000, sessionMs: 5000, closeMs: 50 },
  socketFactory: (_url, config) => new WebSocket(`ws://127.0.0.1:${port}`, config),
});
const owner = createLiveSessionOwner({ store, voice, profile });
const context: LiveContext = { clientId: 'child', auditId: 'child-audit', authorityEpoch: store.authorityEpoch };
const session = owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, context);
process.send?.({ phase: 'created', liveSessionId: session.liveSessionId });

if (mode === 'intent') {
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, context);
  await attachment.ready;
  process.send?.({ phase: 'intent', liveSessionId: session.liveSessionId });
}

// Stay alive (holding the real Store writer lock) until the parent kills this process.
setInterval(() => {}, 1000);
