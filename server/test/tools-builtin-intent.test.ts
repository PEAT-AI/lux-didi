import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations, validateLiveProfile } from '../live/index.js';
import { composeLive } from '../host/live.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { noteOwnerWords, nativeActions } from '../tools/open.js';
import type { LiveAuthority } from '../tools/types.js';
import type { ToolCallIntent } from '../adapters/model/types.js';
import { fixture } from './live-voice-fixture.js';

test('A2: each live builtin executes against its exact stored intent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-builtin-intent-'));
  const store = new Store(join(dir, 'state'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = await fixture(t);
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => undefined });
  t.after(() => port.close());
  let lookup: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, lookupAuthority: async (runId, signal) => lookup?.(runId, signal) ?? null });
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: 'models/synthetic', voice: 'Synthetic', keyReference: 'synthetic', route: { enabled: true, provider: 'gemini', modelId: 'models/synthetic', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic', dataClass: 'ordinary' } });
  const { service } = composeLive(store, dir, { profile, socketFactory: f.socketFactory, credentials: { resolve: async () => 'synthetic' } }, undefined, undefined,
    { owner, connectionIds: () => [], registerAuthoritySource: source => { lookup = source; } });
  t.after(() => service.shutdown());
  const context = { clientId: 'synthetic-actor', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = service.create('ordinary', randomUUID(), context);
  const attachment = service.attach(session.liveSessionId, context);
  await f.frame(1); f.send({ setupComplete: {} }); await attachment.ready;
  const signal = new AbortController().signal;
  const authority = await lookup!(session.liveSessionId, signal);
  assert.ok(authority);
  // No OS opener or native timeout: the receipt port is the unit-test boundary.
  t.mock.method(nativeActions, 'dispatch', async () => 'opened' as const);
  noteOwnerWords(session.liveSessionId, 'open plantix dot net and my gmail and Synthetic');
  const argumentsByName: Record<string, Record<string, unknown>> = {
    research: { action: 'start', question: 'what is the synthetic scope', topic: 'synthetic scope', lookups: [{ source: 'knowledge', query: 'synthetic scope' }] }, remember: { text: 'Synthetic fact', kind: 'fact' },
    people_lookup: { name: 'Synthetic' }, open_source: { handle: 'L9999' },
    open_home: { app: 'gmail' }, open_file: { path: '~/synthetic' },
    open_app: { name: 'Synthetic' }, open_web: { kind: 'site', target: 'plantix dot net' },
  };
  for (const definition of owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }))) {
    const args = argumentsByName[definition.name];
    assert.ok(args, `valid fixture required for ${definition.name}`);
    assert.equal(definition.validate(args), true, `${definition.name} fixture validates`);
    const intent: ToolCallIntent = { runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision,
      executionId: randomUUID(), callId: randomUUID(), toolName: definition.name,
      argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      ...(definition.accountId !== undefined ? { accountId: definition.accountId } : {}),
      ...(definition.resourceId !== undefined ? { resourceId: definition.resourceId } : {}) };
    assert.equal(owner.journal.intent(intent), 'fresh', definition.name);
    await assert.doesNotReject(() => definition.execute(args, { ...intent, signal }), `${definition.name} must accept its stored intent`);
  }
});
