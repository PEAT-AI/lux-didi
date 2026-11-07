import { commentaryPart, commentaryResults } from './commentary-test.js';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { chatMigrations } from '../chat/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveOutputChunk } from '../live/index.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import type { Infer } from '../tasks/worker.js';
import type { BoundConnector, ExistingExecutors } from '../tasks/connectors.js';
import { VaultWriter } from '../tools/vault-write.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
import { fixtureUntil } from './live-voice-fixture.js';

/** Real host, Store, task worker and authority, with only model and external transport controlled. */
export async function liveTaskFixture(t: TestContext, infer: Infer, options: {
  clock?: boolean; approved?: boolean; outcome?: 'inserted' | 'unknown'; executors?: ExistingExecutors;
  bindings?: readonly BoundConnector[];
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-live-task-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const voice = fakeLiveVoicePort({ provider: 'openai', supportsGoAway: true, supportsInterruption: true });
  const writes: unknown[] = [];
  const vault = new VaultWriter({ store, now: () => 1000, log: () => {}, transport: { save: async input => {
    writes.push(input);
    return options.outcome === 'unknown' ? { outcome: 'unknown' } : { outcome: 'inserted', insightId: 'synthetic-insight' };
  } } });
  const owner = createLiveSessionOwner({ store, voice: voice.port,
    profile: validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'marin', keyReference: 'synthetic',
      route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
      prompt: { text: 'Synthetic persona', dataClass: 'ordinary' } }),
    createTaskRuntime: hostTaskFactory({ store, vault, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
      bindings: () => options.bindings ?? (options.executors?.['search_insights'] ? [discoveredSearchBinding()] : []), timeZone: 'UTC', infer,
      executors: () => options.executors ?? {}, effectCheck: async () => options.approved ?? true }),
  });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const context = { clientId: 'synthetic-client', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = owner.create({ idempotencyKey: 'synthetic-call', inputClass: 'ordinary' }, context);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, context);
  const chunks: LiveOutputChunk[] = [];
  const drained = (async () => { for await (const chunk of attachment.output) chunks.push(chunk); })();
  t.after(() => drained);
  await attachment.ready;
  let pendingQuiet = false;
  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve));
    if (pendingQuiet) { pendingQuiet = false; t.mock.timers.tick(1_200); }
    for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { store, owner, voice, writes, chunks, session, attachment, context,
    finalize(text: string) { pendingQuiet = true; voice.emit({ type: 'inputTranscription', text, finished: true, finalOrigin: 'provider' }); void flush(); },
    bind(id = 'synthetic-binding') { voice.emit({ type: 'delegation', delegationId: id }); },
    flush,
    async answer() {
      await flush(); await fixtureUntil(() => voice.taskAnswers.length > 0, 'current task answer');
      const id = commentaryPart(voice.taskAnswers.at(-1)!.text).id;
      while (!commentaryPart(voice.taskAnswers.at(-1)!.text).final) {
        const count = voice.taskAnswers.length;
        voice.emit({ type: 'commentaryAccepted', commandId: voice.taskAnswers.at(-1)!.commandId }); await flush();
        await fixtureUntil(() => voice.taskAnswers.length > count, 'next commentary part');
      }
      return commentaryResults(voice.taskAnswers.filter(item => commentaryPart(item.text).id === id))[0]!;
    },
  };
}

/** The discovered search the host declares whenever the fixture supplies its executor. */
export const discoveredSearch = { name: 'search_insights', description: 'Search the synthetic knowledge source.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } } };
export function discoveredSearchBinding(): BoundConnector {
  return { connector: 'lux-knowledge', policy: { toolNames: [discoveredSearch.name], endpoint: { account: 'synthetic-account', resource: 'lux-knowledge:vault' } },
    reader: { discovery: () => [discoveredSearch], call: async () => ({ state: 'completed', decodedResult: { text: 'synthetic insight' } }) } } as unknown as BoundConnector;
}
/** The discovered lux write the host projects as vault_save: annotations admit it, the schema is its payload. */
export const discoveredCreate = { name: 'create_insight', description: 'Create an insight the owner asked for.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: { type: 'object', required: ['content', 'insight_title'], properties: { content: { type: 'string' }, insight_title: { type: 'string' }, insight_type: { type: 'string' }, project: { type: 'string' } } } };
export function luxVaultBinding(decodedResult: unknown = { insight_id: 7, disposition: 'created' }): BoundConnector {
  return { connector: 'lux-knowledge', policy: { toolNames: [discoveredCreate.name], endpoint: { account: 'synthetic-account', resource: 'lux-knowledge:vault' } },
    reader: { discovery: () => [discoveredCreate], call: async () => ({ state: 'completed', decodedResult }) } } as unknown as BoundConnector;
}
