import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { domainMigrations } from '../domain/schema.js';
import { ChatService, chatMigrations, type ChatConfig } from '../chat/index.js';
import { validatePreferences } from '../prompt/index.js';
import type { ModelPort, ModelRequest, ModelResult, DataClass } from '../adapters/model/types.js';
import type { DomainContext, Entry, SourceRef } from '../contracts/domain.js';
import type { SchemaMigration } from '../contracts/storage.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function result(request: ModelRequest, status: ModelResult['status'] = 'complete', text = 'Answer'): ModelResult {
  return { status, text, providerContent: { role: 'model', parts: [{ text, thoughtSignature: 'must-not-persist' }] },
    reason: 'synthetic', prompt: { version: request.promptVersion, hash: 'synthetic', omittedContextIds: [] },
    timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
}

/** The synthetic route permits exactly the classes the sending consent enrolls. */
export const ROUTE_CLASSES: readonly DataClass[] = ['ordinary', 'private'];

/**
 * Real canonical Store + Domain + ChatService with a controlled model boundary.
 * Classification reads the actual stored routing label (entry/session), exactly
 * like the connected host, so unknown or corrected labels are observable.
 */
export function openMemoryFixture(dir: string, model: ModelPort, overrides: Partial<ChatConfig> = {}, migrations: readonly SchemaMigration[] = chatMigrations, domainSchema: readonly SchemaMigration[] = domainMigrations) {
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domainSchema, ...migrations]);
  const context: DomainContext = { assistantId: store.assistantId, clientId: 'principal-a', authorityEpoch: store.authorityEpoch, now: new Date(0).toISOString() };
  const config: ChatConfig = { store, domain, model,
    route: { provider: 'synthetic', model: 'counting', available: true,
      allows: classes => classes.every(c => ROUTE_CLASSES.includes(c)),
      endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'synthetic-key',
      allowedClasses: ROUTE_CLASSES },
    preferences: validatePreferences({ schemaVersion: 1, ownerId: store.assistantId, dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'balanced' }, store.assistantId),
    classify: (subject, tx) => {
      if (subject.kind === 'recall') return null;
      const label = domain.getRoutingLabel(tx, { kind: subject.kind, id: subject.id });
      if (label.dataClass === 'unknown') return null;
      return { ownerId: store.assistantId, dataClass: label.dataClass, revision: label.revision };
    },
    context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 }, sources: [] },
    now: () => 0, ...overrides };
  const recoveryContext = { assistantId: store.assistantId, authorityEpoch: store.authorityEpoch };
  const chat = new ChatService(config); chat.recover(recoveryContext);
  const enroll = () => {
    const enrolling = new ChatService({ ...config, route: { ...config.route, available: true, allows: () => true } });
    enrolling.recover(recoveryContext);
    const grant = enrolling.enroll({ title: 'Synthetic', timeZone: 'UTC', idempotencyKey: randomUUID() }, context);
    return store.transaction(tx => domain.execute(tx, 'getSession', { id: grant.sessionId }, context)).session;
  };
  const createSession = (title: string, actor: DomainContext = context) =>
    store.transaction(tx => domain.execute(tx, 'createSession', { title, timeZone: 'UTC' }, actor, { writer: 'capture', dataClass: 'private' }));
  const createUnlabeledSession = (title: string) =>
    store.transaction(tx => domain.execute(tx, 'createSession', { title, timeZone: 'UTC' }, context));
  const append = (sessionId: string, text: string, sourceRef?: SourceRef) =>
    store.transaction(tx => domain.execute(tx, 'appendEntry',
      { sessionId, text, role: 'user', timeZone: 'UTC', ...(sourceRef ? { sourceRef } : {}) }, context, { writer: 'capture', dataClass: 'private' })) as Entry;
  const entries = (sessionId: string) => store.transaction(tx => domain.execute(tx, 'getSession', { id: sessionId }, context)).entries;
  return { store, domain, context, recoveryContext, chat, config, enroll, createSession, createUnlabeledSession, append, entries };
}

// Only the spawned child executes this branch. Synthetic files/IPC; no network.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'child') {
  const [dir, mode, sessionId, entryId] = process.argv.slice(3);
  if (!dir || !mode || !sessionId || !entryId) throw Error('child arguments required');
  const model: ModelPort = { generate: async request => {
    appendFileSync(`${dir}/calls`, 'called\n'); process.send?.({ phase: 'called' });
    await new Promise<void>(() => {}); return result(request);
  } };
  const work: (() => void)[] = [];
  const f = openMemoryFixture(dir, model, { schedule: task => work.push(task) });
  const run = f.chat.accept({ sessionId, text: 'Synthetic selected child turn', idempotencyKey: 'child', selectedMemoryEntryIds: [entryId] }, f.context);
  process.send?.({ phase: 'accepted', runId: run.runId });
  if (mode === 'intent') {
    const stream = f.chat.subscribe(run.runId, f.context);
    void (async () => { for await (const event of stream) {
      if (event.type === 'snapshot' && event.run.state === 'dispatch_intent') {
        process.send?.({ phase: 'intent' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    } })();
  }
  if (mode !== 'accepted') work[0]?.();
  process.on('message', () => {});
}
