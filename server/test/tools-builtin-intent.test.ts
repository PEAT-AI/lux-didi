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
import { noteModelOutput, noteOwnerWords, noteOwnerPartial, ownerTurnWords, webOwnerWords, resolveWebOpen, NativeActionBus, openWebFailure, nativeActions } from '../tools/open.js';
import type { LiveAuthority } from '../tools/types.js';
import type { ToolCallIntent } from '../adapters/model/types.js';
import { runToolCalls } from '../tools/declarations.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { beginHandleSession, endHandleSession, mintOpenLine, exposeHandles } from '../tools/open-handles.js';
import { fixture } from './live-voice-fixture.js';

test('A2: each live builtin executes against its exact stored intent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-builtin-intent-'));
  const store = new Store(join(dir, 'state'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);

  const f = await fixture(t);
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic' });
  t.after(() => port.close());
  let lookup: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const owner = createToolsOwner({ grantMode: 'owner-trusted-reads', store, ownerId: store.assistantId, registry, port, lookupAuthority: async (runId, signal) => lookup?.(runId, signal) ?? null });
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: 'models/synthetic', voice: 'Synthetic', keyReference: 'synthetic', route: { enabled: true, provider: 'gemini', modelId: 'models/synthetic', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic', dataClass: 'ordinary' } });
  const { service } = composeLive(store, dir, { profile, socketFactory: f.socketFactory, credentials: { resolve: async () => 'synthetic' } }, undefined, undefined,
    { owner, connectionIds: () => [], registerAuthoritySource: source => { lookup = source; } });
  t.after(async () => { await service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const context = { clientId: 'synthetic-actor', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = service.create('ordinary', randomUUID(), context);
  const attachment = service.attach(session.liveSessionId, context);
  await f.frame(1); f.send({ setupComplete: {} }); await attachment.ready;
  const signal = new AbortController().signal;
  const authority = await lookup!(session.liveSessionId, signal);
  assert.ok(authority);
  // No OS opener or native timeout: the receipt port is the unit-test boundary.
  let dispatched = 0;
  t.mock.method(nativeActions, 'dispatch', async () => { dispatched++; return 'opened' as const; });
  noteOwnerWords(session.liveSessionId, 'open plantix dot net and my gmail and Synthetic');
  const argumentsByName: Record<string, Record<string, unknown>> = {
    research: { action: 'start', question: 'what is the synthetic scope', topic: 'synthetic scope', lookups: [{ source: 'knowledge', query: 'synthetic scope' }] }, remember_note: { text: 'Synthetic fact', kind: 'fact' },
    // history-chat-tool.integration.mjs and vault-write.test.ts synthetic arguments.
    conversation_history: { query: 'Mira violet flags' }, save_to_vault: { content: 'the boat survey is on Tuesday' },
    stage_lux_note: { title: 'T', body: 'B', evidenceRefs: ['journal:1'] },
    people_lookup: { name: 'Synthetic' }, open_source: { handle: 'L9999' },
    open_home: { app: 'gmail' }, open_file: { path: '~/synthetic' },
    open_app: { name: 'Synthetic' }, open_web: { kind: 'site', target: 'plantix dot net' },
  };
  const live = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true);
  assert.ok(live.some(tool => tool.name === 'stage_lux_note'), 'stage owns its own registry intent name');
  assert.equal(live.some(tool => tool.name === 'remember_note' || tool.name === 'save_to_vault'), false, 'retired write tools are not catalog capabilities');
  for (const definition of live) {
    const args = argumentsByName[definition.name];
    assert.ok(args, `valid fixture required for ${definition.name}`);
    assert.equal(definition.validate(args), true, `${definition.name} fixture validates`);
    const intent: ToolCallIntent = { runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision,
      executionId: randomUUID(), callId: randomUUID(), toolName: definition.name,
      argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      accountId: definition.accountId, resourceId: definition.resourceId };
    // Research is a live-loop protocol declaration, not a durable builtin executor.
    // Its placeholder intentionally has no tool intent identity and is intercepted by Live.
    if (definition.name === 'research') {
      assert.equal((await definition.execute(args, { ...intent, signal })).status, 'failed');
      continue;
    }
    // journal.intent invokes callDTO, the same canonicalization used by the gateway.
    assert.doesNotThrow(() => assert.equal(owner.journal.intent(intent), 'fresh'), `${definition.name} stores its intent`);
    await assert.doesNotReject(async () => {
      const outcome = await definition.execute(args, { ...intent, signal });
      assert.equal(outcome.status, 'completed', `${definition.name} reaches its receipt transaction`);
    }, `${definition.name} must accept its stored intent`);
  }
  // Every open name exercises the real registry executor, not an alias of open_web.
  beginHandleSession(session.liveSessionId);
  t.after(() => endHandleSession(session.liveSessionId));
  const line = mintOpenLine({ title: 'Synthetic email', url: 'https://mail.google.com/mail/u/0/#all/abc123', sourceType: 'gmail' })!;
  exposeHandles(line);
  const handle = line.match(/L[0-9]+/)![0];
  const openCases = [
    { name: 'open_source', args: { handle }, ask: 'open this email in my browser' },
    { name: 'open_home', args: { app: 'gmail' }, ask: 'open my gmail' },
    { name: 'open_file', args: { path: '~/synthetic' }, ask: 'open this local file' },
    { name: 'open_app', args: { name: 'Synthetic' }, ask: 'open Synthetic app' },
    { name: 'open_web', args: { kind: 'site', target: 'economist.com' }, ask: 'open economist.com in a new tab' },
  ];
  for (const entry of openCases) for (const mode of ['no ask', 'ask', 'split ask'] as const) {
    await t.test(`${entry.name}: ${mode}`, async () => {
      noteModelOutput(session.liveSessionId);
      noteOwnerWords(session.liveSessionId, mode === 'ask' ? entry.ask : 'this is the synthetic item');
      const definition = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true).find(d => d.name === entry.name)!;
      const intent: ToolCallIntent = { runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision,
        executionId: randomUUID(), callId: randomUUID(), toolName: entry.name,
        argumentsHash: createHash('sha256').update(JSON.stringify(entry.args)).digest('hex'), accountId: definition.accountId, resourceId: definition.resourceId };
      assert.equal(owner.journal.intent(intent), 'fresh');
      const before = dispatched;
      const pending = definition.execute(entry.args, { ...intent, signal });
      // A second finalization releases the one bounded wait without a real clock delay.
      if (mode !== 'ask') await new Promise<void>(resolve => setImmediate(resolve));
      if (mode !== 'ask') noteOwnerWords(session.liveSessionId, mode === 'split ask' ? entry.ask : 'nothing else');
      const outcome = await pending;
      assert.equal(outcome.status, 'completed');
      assert.equal(dispatched - before, mode === 'no ask' ? 0 : 1, `${entry.name} ${mode} reaches native only with owner intent`);
    });
  }
  const definitions = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true);
  const web = definitions.find(definition => definition.name === 'open_web')!;
  const events: unknown[] = [];
  const detach = attachHostLogSink({ event: event => events.push(event) });
  t.after(detach);
  const batch = await runToolCalls(owner, [{ id: 'synthetic-mismatch', name: 'open_web', args: { kind: 'site', target: 'plantix dot net' } }], {
    registry: [{ ...web, execute: (args, ctx) => web.execute({ ...args, target: 'different' }, ctx) }],
    host: { ...authority, grants: [{ tool: web.name, effect: 'read', accountId: web.accountId, resourceId: web.resourceId }] }, authority: { isCurrent: async () => true },
    control: { signal, deadlineMs: Date.now() + 5000 }, step: 0, contentIndex: 0,
    seenIds: new Set(), baseClasses: ['ordinary'], authorize: true,
  });
  assert.equal(batch.error, undefined);
  const response = JSON.stringify(batch.accepted);
  assert.match(response, /executor_intent_mismatch/);
  assert.match(response, /"say"/);
  assert.match(response, /nothing is open/);
  assert.ok(events.some(event => { const row = event as Record<string, unknown>; return row.event === 'tool_handler_error' && row.reason === 'executor_intent_mismatch'; }));

});


test('A3: partial owner transcription accumulates without borrowing tool text', async () => {
  const runId = randomUUID();
  noteOwnerPartial(runId, 'open ');
  noteOwnerPartial(runId, 'plantix ');
  noteOwnerPartial(runId, 'dot net');
  assert.equal(ownerTurnWords(runId).trim(), 'open plantix dot net');
  const result = await resolveWebOpen({ kind: 'site', target: 'plantix dot net' }, ownerTurnWords(runId), new AbortController().signal);
  assert.ok('target' in result);
});

test('A3: absent owner transcript waits once for at most 1500 ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = webOwnerWords(randomUUID(), new AbortController().signal).then(words => { settled = true; return words; });
  t.mock.timers.tick(1499);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, '');
});

test('A3: finalized uppercase verbs do not wait for another transcript', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const text of ['OPEN plantix dot net', 'ÖFFNE die Karte von Odemira', 'SEARCH FOR drip irrigation']) {
    const runId = randomUUID();
    noteOwnerWords(runId, text);
    let settled = false;
    const pending = webOwnerWords(runId, new AbortController().signal).then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, true, text);
    await pending;
  }
});


test('web native timeout has a closed speech-safe receipt, older opens keep failed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bus = new NativeActionBus(5000);
  const runId = randomUUID();
  const unbind = bus.bind(runId, () => true); t.after(unbind);
  const web = bus.dispatch(runId, 'open_url', 'https://plantix.net/', 'native_timeout');
  const old = bus.dispatch(runId, 'open_url', 'https://mail.google.com/mail/u/0/');
  t.mock.timers.tick(5000);
  assert.equal(await web, 'native_timeout');
  assert.equal(await old, 'failed');
  for (const code of ['no_open_intent', 'not_owner_words', 'not_allowed', 'not_found', 'ambiguous', 'executor_intent_mismatch', 'native_timeout', 'failed']) {
    const receipt = openWebFailure(code);
    assert.equal(receipt.code, code);
    assert.ok(receipt.say.length > 0);
    assert.ok(receipt.fixNotForSpeech.length > 0);
  }
});

test('C-OPEN11: partial owner words wait for finalization and cannot authorize an open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runId = randomUUID();
  noteOwnerPartial(runId, 'open gmail');
  let settled = false;
  const pending = webOwnerWords(runId, new AbortController().signal).then(words => { settled = true; return words; });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1500);
  assert.equal(await pending, '', 'an unfinalized partial never authorizes a native open');
});

test('C-OPEN11: the shared acquisition merges two finalized owner turns', async () => {
  const runId = randomUUID();
  noteOwnerWords(runId, 'please open');
  noteOwnerWords(runId, 'this email in my browser');
  assert.equal(await webOwnerWords(runId, new AbortController().signal), 'please open this email in my browser');
});
