
import { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { chatMigrations } from '../chat/index.js';
import { toolsMigrations } from '../tools/index.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile } from '../live/index.js';
import type { LiveVoiceEvent, LiveVoicePort } from '../adapters/live-voice/types.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import type { Inference, Infer } from '../tasks/worker.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
type ProviderEvent<T = LiveVoiceEvent> = T extends { sequence: number } ? Omit<T, 'sequence'> : never;
export const flushTaskLive = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
export async function taskLiveFixture(t: TestContext, infer?: Infer, timeContext: { timeZone?: string; now?: () => number } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const directory = mkdtempSync(join(tmpdir(), 'task-correction-synthetic-'));
  const store = new Store(directory, [...domainMigrations, ...chatMigrations, ...toolsMigrations, ...liveMigrations]);
  const fake = fakeLiveVoicePort({ provider: 'openai' }), appended: string[] = [], receipts: Record<string, unknown>[] = [];
  const inference: ((value: Inference) => void)[] = [];
  const voice: LiveVoicePort = { capabilities: fake.port.capabilities, open: (request, control) => ({ ...fake.port.open(request, control),
    sendTaskAnswer: ({ text }) => { appended.push(text); return `synthetic-command-${appended.length}`; },
  }) };
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  const profile = validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'cedar', keyReference: 'synthetic-reference',
    audio: { inputRate: 8000, outputRate: 24000 }, route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic task voice', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600000, sessionMs: 1200000, closeMs: 50 } });
  const owner = createLiveSessionOwner({ store, voice, profile, timeZone: 'UTC',
    createTaskRuntime: hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined), bindings: () => [],
      contentAllowed: () => false, timeZone: 'UTC', effectCheck: async () => true,
      infer: infer ?? (async () => new Promise<Inference>(resolve => { inference.push(resolve); })), ...timeContext,
    }),
  });
  t.after(async () => { try { await owner.shutdown(); } finally { sink(); store.close(); rmSync(directory, { recursive: true, force: true }); } });
  const context = { clientId: 'synthetic-client', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = owner.create({ inputClass: 'ordinary', idempotencyKey: 'synthetic-correction' }, context);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, context); await attachment.ready; await flushTaskLive();
  // The shared synthetic queue carries the new delegation receipts without changing its transport behavior.
  const emit = async (event: ProviderEvent) => { (fake.emit as (event: ProviderEvent) => void)(event); await flushTaskLive();
    if (event.type === 'inputTranscription' && event.finished) { t.mock.timers.tick(1_200); await flushTaskLive(); }
  };
  return { emit, appended, receipts, inference, requests: fake.requests, store };
}
