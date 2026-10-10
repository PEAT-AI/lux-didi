import { Store } from '../runtime/store.js';
import { Outbox } from '../runtime/outbox.js';
import { createDomainPort } from '../domain/facade.js';
import { ChatService, chatMigrations, type ChatConfig } from '../chat/index.js';
import { validatePreferences } from '../prompt/index.js';
import type { ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';
import type { DomainContext } from '../contracts/domain.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function result(request: ModelRequest, status: ModelResult['status'] = 'complete', text = 'Answer'): ModelResult {
  return { status, text, providerContent: { role: 'model', parts: [{ text, thoughtSignature: 'must-not-persist' }] },
    reason: 'synthetic', prompt: { version: request.promptVersion, hash: 'synthetic', omittedContextIds: [] },
    timings: { kind: 'synthetic', totalMs: 0, firstTextMs: null } };
}
export function openFixture(dir: string, model: ModelPort, overrides: Partial<ChatConfig> = {}, faultCheck?: string) {
  const domain = createDomainPort({ outbox: Outbox });
  // Keep the actual owned migration/Store. Faults are real SQLite constraints
  // on initial CREATE: runtime intentionally guards trigger bodies and ALTER.
  const ownedMigrations = chatMigrations.map(migration => ({ ...migration,
    statements: migration.statements.map(statement => faultCheck && statement.startsWith('CREATE TABLE chat_runs')
      ? statement.replace(/\)\s*$/, `, CHECK (${faultCheck}))`) : statement) }));
  const store = new Store(dir, [...domain.migrations, ...ownedMigrations]);
  const context: DomainContext = { assistantId: store.assistantId, clientId: 'test-actor', authorityEpoch: store.authorityEpoch, now: new Date(0).toISOString() };
  const config: ChatConfig = { store, domain, model,
    route: { provider: 'synthetic', model: 'counting', available: true, allows: () => true, endpoint: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', keyReference: 'gemini-primary', allowedClasses: ['ordinary', 'private'] },
    preferences: validatePreferences({ schemaVersion: 1, ownerId: store.assistantId, dataClass: 'ordinary', language: 'de-DE', register: 'plain', humor: 'off', verbosity: 'brief' }, store.assistantId),
    classify: () => ({ ownerId: store.assistantId, dataClass: 'ordinary', revision: 1 }),
    context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 }, sources: [] },
    now: () => 0, ...overrides };
  const recoveryContext = { assistantId: store.assistantId, authorityEpoch: store.authorityEpoch };
  const chat = new ChatService(config); chat.recover(recoveryContext);
  const createSession = () => {
    // Enrollment is a valid setup action; availability tests subsequently use
    // their deliberately unavailable dispatch route with the same identity.
    const enrolling = new ChatService({ ...config, route: { ...config.route, available: true, allows: () => true } });
    enrolling.recover(recoveryContext);
    const grant = enrolling.enroll({ title: 'Synthetic', timeZone: 'UTC', idempotencyKey: randomUUID() }, context);
    return store.transaction(tx => domain.execute(tx, 'getSession', { id: grant.sessionId }, context)).session;
  };
  return { store, domain, context, recoveryContext, chat, config, createSession };
}

// Only the spawned child executes this branch. Synthetic files/IPC; no network.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'child') {
  const [dir, mode, sessionId] = process.argv.slice(3);
  if (!dir || !mode || !sessionId) throw Error('child arguments required');
  const model: ModelPort = { generate: async request => {
    appendFileSync(`${dir}/calls`, 'called\n'); process.send?.({ phase: 'called' });
    await new Promise<void>(() => {}); return result(request);
  } };
  const work: (() => void)[] = [];
  const f = openFixture(dir, model, { schedule: task => work.push(task) });
  const run = f.chat.accept({ sessionId, text: 'Synthetic child turn', idempotencyKey: 'child' }, f.context);
  process.send?.({ phase: 'accepted', runId: run.runId });
  if (mode === 'intent') {
    const stream = f.chat.subscribe(run.runId, f.context);
    void (async () => { for await (const event of stream) {
      if (event.type === 'snapshot' && event.run.state === 'dispatch_intent') {
        process.send?.({ phase: 'intent' });
        // Blocking seam makes intent observable before any provider invocation.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    } })();
  }
  if (mode !== 'accepted') work[0]?.();
  process.on('message', () => {});
}
