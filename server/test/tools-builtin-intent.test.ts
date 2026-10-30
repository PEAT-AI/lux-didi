import './alarm.test.js';
import './alarm-scheduler.test.js';
import './alarm-authority.test.js';
import './alarm-shell.test.js';
import './alarm-mode.test.js';
import './alarm-logs.test.js';
import './alarm-atomic.test.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
import { LIVE_NOT_MODEL_FACING, runToolCalls } from '../tools/declarations.js';
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
  let alarmNow = Date.now();
  const owner = createToolsOwner({ alarms: { now: () => alarmNow, recheck() {}, health: () => ({ degraded: false, reasons: [] }) }, grantMode: 'owner-trusted-reads', store, ownerId: store.assistantId, registry, port, lookupAuthority: async (runId, signal) => lookup?.(runId, signal) ?? null });
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
    set_alarm: {}, list_alarms: {}, cancel_alarm: { id: 'synthetic-alarm' }, snooze_alarm: { id: 'synthetic-alarm' },
  };
  const live = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true);
  for (const enabled of [undefined, true, false]) {
    const surface = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), enabled);
    assert.equal(surface.some(tool => tool.name === 'stage_lux_note'), enabled !== false, 'an explicit owner feature disable remains authoritative');
  }
  assert.ok(live.some(tool => tool.name === 'stage_lux_note'), 'stage owns its own registry intent name');
  assert.equal(live.some(tool => tool.name === 'remember_note' || tool.name === 'save_to_vault'), false, 'retired write tools are not catalog capabilities');
  for (const name of ['set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm']) assert.ok(live.some(tool => tool.name === name), `registered ${name}`);
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
    { name: 'open_file', args: { path: '~/synthetic' }, ask: 'open the local file ~/synthetic' },
    { name: 'open_app', args: { name: 'Synthetic' }, ask: 'open Synthetic app' },
    { name: 'open_web', args: { kind: 'site', target: 'economist.com' }, ask: 'open economist.com in a new tab' },
  ];
  for (const entry of openCases) for (const mode of ['no ask', 'ask', 'split ask', 'cue-free ask'] as const) {
    await t.test(`${entry.name}: ${mode}`, async () => {
      owner.ownerRequests.answered?.(session.liveSessionId);
      noteModelOutput(session.liveSessionId);
      if (mode !== 'no ask') {
        noteOwnerWords(session.liveSessionId, mode === 'ask' ? entry.ask : 'this is the synthetic item');
        owner.observeAlarmOwner(session.liveSessionId, randomUUID(), mode === 'ask' ? entry.ask : 'this is the synthetic item', Date.now());
      }
      const definition = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true).find(d => d.name === entry.name)!;
      const intent: ToolCallIntent = { runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision,
        executionId: randomUUID(), callId: randomUUID(), toolName: entry.name,
        argumentsHash: createHash('sha256').update(JSON.stringify(entry.args)).digest('hex'), accountId: definition.accountId, resourceId: definition.resourceId };
      assert.equal(owner.journal.intent(intent), 'fresh');
      const before = dispatched;
      // Finalized microphone authority is explicit; a tool call cannot wait out an absent request.
      if (mode === 'split ask') {
        const words = entry.ask;
        noteOwnerWords(session.liveSessionId, words);
        owner.observeAlarmOwner(session.liveSessionId, randomUUID(), words, Date.now());
      }
      const pending = definition.execute(entry.args, { ...intent, signal });
      const outcome = await pending;
      assert.equal(outcome.status, 'completed');
      assert.equal(dispatched - before, mode === 'no ask' ? 0 : 1, `${entry.name} ${mode} reaches native only with owner intent`);
    });
  }
  const definitions = owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }), undefined, () => ({ code: 'staged' }), true);
  const web = definitions.find(definition => definition.name === 'open_web')!;
  // A5: three owner asks share one unfinished answer, but not an open receipt.
  owner.ownerRequests.answered!(session.liveSessionId);
  const urls: unknown[] = [];
  t.mock.method(nativeActions, 'dispatch', async (_run: string, _action: string, target: string) => { urls.push(target); return 'opened' as const; });
  const cases = [
    { kind: 'site', target: 'plantix dot net', words: ['but can you open', 'plantix dot net in my browser'], url: 'https://plantix.net/' },
    { kind: 'maps', target: 'Odemira', words: ['open the map of Odemira'], url: 'https://www.google.com/maps/search/?api=1&query=Odemira' },
    { kind: 'search', target: 'drip irrigation', words: ['search for drip irrigation'], url: 'https://www.google.com/search?q=drip+irrigation' },
  ];
  let openStep = 100;
  for (const entry of cases) {
    for (const words of entry.words) { noteOwnerWords(session.liveSessionId, words); owner.observeAlarmOwner(session.liveSessionId, randomUUID(), words, Date.now()); }
    const args = { kind: entry.kind, target: entry.target };
    const execute = async () => {
      const batch = await runToolCalls(owner, [{ id: randomUUID(), name: 'open_web', args }], {
        registry: [web], host: { ...authority, grants: [{ tool: web.name, effect: 'read', accountId: web.accountId, resourceId: web.resourceId }] },
        authority: { isCurrent: async () => true }, control: { signal, deadlineMs: Date.now() + 5000 },
        step: openStep++, contentIndex: 0, seenIds: new Set(), baseClasses: ['ordinary'], authorize: true,
      });
      assert.equal(batch.error, undefined);
      return batch.accepted.map(entry => entry.response);
    };
    const first = await execute();
    assert.equal(JSON.stringify(first).includes('"code":"opened"'), true, `${entry.kind}: ${JSON.stringify(first)}`);
    assert.equal(urls.at(-1), entry.url, entry.kind);
    assert.deepEqual(await execute(), first, 'same target returns its own receipt');
  }
  assert.deepEqual(urls, cases.map(entry => entry.url), 'one native action per distinct target');
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

  // F6a: a site the resolver could not find is the site-not-found payload, never an authorization refusal.
  const notFoundEvents: Record<string, unknown>[] = [];
  const detachNotFound = attachHostLogSink({ event: event => notFoundEvents.push(event as Record<string, unknown>) });
  t.after(detachNotFound);
  noteOwnerWords(session.liveSessionId, 'open zzsyntheticnotasite');
  owner.observeAlarmOwner(session.liveSessionId, randomUUID(), 'open zzsyntheticnotasite', Date.now());
  const notFound = await runToolCalls(owner, [{ id: 'synthetic-not-found', name: 'open_web', args: { kind: 'site', target: 'zzsyntheticnotasite' } }], {
    registry: [web], host: { ...authority, grants: [{ tool: web.name, effect: 'read', accountId: web.accountId, resourceId: web.resourceId }] },
    authority: { isCurrent: async () => true }, control: { signal, deadlineMs: Date.now() + 5000 }, step: 200, contentIndex: 0,
    seenIds: new Set(), baseClasses: ['ordinary'], authorize: true,
  } as never);
  const notFoundText = JSON.stringify(notFound.accepted);
  assert.match(notFoundText, /"not_found"/, 'the resolver answer is reported as itself');
  assert.doesNotMatch(notFoundText, /target_not_authorized/, 'a missing site is never relabelled as an unauthorized target');
  assert.match(notFoundText, /could not find that site/u, 'she is told what to say: the site was not found');
  assert.ok(notFoundEvents.some(event => event['event'] === 'open_resolve' && event['target'] === 'web' && event['outcome'] === 'not_found' && typeof event['ms'] === 'number'),
    'the resolver outcome and duration are logged');

  // F6b: a link that needs a Chrome that is not running is a closed refusal with the line she says, and the
  // host never gets a launch order for it.
  t.mock.method(nativeActions, 'dispatch', async () => 'browser_not_running' as const);
  const noBrowser = await runToolCalls(owner, [{ id: 'synthetic-no-browser', name: 'open_web', args: { kind: 'site', target: 'plantix dot net' } }], {
    registry: [web], host: { ...authority, grants: [{ tool: web.name, effect: 'read', accountId: web.accountId, resourceId: web.resourceId }] },
    authority: { isCurrent: async () => true }, control: { signal, deadlineMs: Date.now() + 5000 }, step: 201, contentIndex: 0,
    seenIds: new Set(), baseClasses: ['ordinary'], authorize: true,
  } as never);
  const noBrowserText = JSON.stringify(noBrowser.accepted);
  assert.match(noBrowserText, /browser_not_running/);
  assert.match(noBrowserText, /Chrome is not open, could you open it for me\?/u);
  assert.doesNotMatch(noBrowserText, /opening plantix\.net/u, 'nothing opened, so nothing is announced as opening');
  // F13: an open that never reached the native side is a host refusal, not a native action line.
  const nativeLines = notFoundEvents.filter(event => event['event'] === 'native_action');
  assert.deepEqual(nativeLines, [], 'a request that never reached the native side writes no native_action line');
  assert.ok(notFoundEvents.some(event => event['event'] === 'open_audit' && event['refusalCode'] === 'not_found'), 'the host refusal is the audit line');

  // Replay the same speech corpus through stored intents, real alarm transactions and native receipts.
  const corpus = JSON.parse(readFileSync(new URL('../../test/fixtures/owner-utterances.json', import.meta.url), 'utf8')) as {
    id: string; finals: string[]; expectedSay?: string; nativeCode?: string; toolDelayMs?: number; now?: number; clarifyAfter?: number[]; finalOffsetsMs?: number[];
    call: Record<string, unknown> & { tool: string }; code: string; fire_at_utc: number | null;
  }[];
  const oldTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; });
  for (const row of corpus.filter(row => row.call.tool === 'set_alarm' || row.call.tool.startsWith('open_'))) {
    await t.test(`wire corpus ${row.id}`, async () => {
      owner.ownerRequests.release(session.liveSessionId);
      alarmNow = row.now ?? Date.UTC(2026, 9, 30, 6);
      for (const [i, words] of row.finals.entries()) {
        owner.observeAlarmOwner(session.liveSessionId, randomUUID(), words, alarmNow + (row.finalOffsetsMs?.[i] ?? 0));
        if (row.clarifyAfter?.includes(i)) {
          owner.ownerRequests.clarify(session.liveSessionId, 'set_alarm', 'missing_time');
          owner.ownerRequests.answered?.(session.liveSessionId);
        }
      }
      alarmNow += row.toolDelayMs ?? 0;
      t.mock.method(nativeActions, 'dispatch', async (_run: string, _action: string, target: string) => { urls.push(target); return row.nativeCode ?? 'opened'; });
      const { tool, ...raw } = row.call;
      const args = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
      if (tool === 'open_source') args.handle = handle;
      const definition = definitions.find(entry => entry.name === tool)!;
      const intent: ToolCallIntent = { runId: authority.runId, actorId: authority.actorId, authorityEpoch: authority.authorityEpoch, revision: authority.revision, executionId: randomUUID(), callId: randomUUID(), toolName: tool,
        argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
        accountId: definition.accountId, resourceId: definition.resourceId };
      assert.equal(owner.journal.intent(intent), 'fresh');
      const before = urls.length;
      const outcome = await definition.execute(args, { ...intent, signal });
      assert.equal(outcome.status, 'completed');
      if (outcome.status !== 'completed') return;
      const gate = await owner.resultGate.authorize({ ...authority, grants: [] }, [{ executionId: intent.executionId,
        name: tool, callId: intent.callId!, contentIndex: 0, partIndex: 0, result: outcome.result }], ['ordinary'], signal);
      assert.equal(gate.state, 'allowed');
      if (gate.state !== 'allowed') return;
      const result = gate.results[0]!.response;
      if (row.expectedSay !== undefined) assert.equal(result.say, row.expectedSay, `${row.id}: exact spoken failure receipt`);
      const expected = row.code === 'ready' ? 'set' : row.code === 'allowed' ? 'opened' : row.code;
      assert.equal(result.code ?? result.reason ?? result.status, expected, JSON.stringify(result));
      if (expected === 'set') {
        const stored = store.transaction(tx => tx.get('SELECT fire_at_utc FROM alarms WHERE id=?', [intent.executionId]));
        assert.equal(stored?.fire_at_utc, row.fire_at_utc);
        assert.equal(result.fire_at_utc, row.fire_at_utc);
        assert.match(String(result.say), /Alarm set for/);
      } else if (expected === 'opened') {
        assert.equal(urls.length - before, 1);
      } else {
        assert.equal(urls.length - before, row.nativeCode ? 1 : 0);
        assert.equal(typeof result.say, 'string', 'HON-2: the real refusal carries one spoken failure line');
        assert.doesNotMatch(String(result.say), /I'll try|sure|\n/i);
      }
    });
  }

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

test('A3: absent owner transcript returns no authority without a timeout', async () => {
  assert.equal(await webOwnerWords(randomUUID(), new AbortController().signal), '');
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

test('C-OPEN11: an unfinalized partial supplies no authority and starts no timeout', async () => {
  const runId = randomUUID();
  noteOwnerPartial(runId, 'open the deck');
  assert.equal(await webOwnerWords(runId, new AbortController().signal), '');
});

test('C-OPEN11: the shared acquisition merges two finalized owner turns', async () => {
  const runId = randomUUID();
  noteOwnerWords(runId, 'please open');
  noteOwnerWords(runId, 'this email in my browser');
  assert.equal(await webOwnerWords(runId, new AbortController().signal), 'please open this email in my browser');
});

// C-ALARMFIX: compare the real host catalog with the provider's first wire frame.
for (const provider of ['gemini', 'openai'] as const) test(`live owner catalog reaches ${provider} wire declarations`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-catalog-'));
  const store = new Store(join(dir, 'synthetic'), [...domainMigrations, ...liveMigrations, ...toolsMigrations]);
  const f = await fixture(t);
  const registry = new McpRegistry();
  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic' });
  t.after(() => port.close());
  let lookup: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const owner = createToolsOwner({ grantMode: 'owner-trusted-reads', store, ownerId: store.assistantId, registry, port, lookupAuthority: async (id, signal) => lookup?.(id, signal) ?? null });
  const profile = validateLiveProfile({ provider, liveModelId: provider === 'gemini' ? 'models/synthetic' : 'gpt-live-1', voice: provider === 'gemini' ? 'Synthetic' : 'marin', keyReference: 'synthetic', route: { enabled: true, provider, modelId: provider === 'gemini' ? 'models/synthetic' : 'gpt-live-1', dataClasses: ['ordinary'] }, prompt: { text: 'Synthetic', dataClass: 'ordinary' } });
  const { service } = composeLive(store, dir, { profile, socketFactory: f.socketFactory, credentials: { resolve: async () => 'synthetic' } }, undefined, undefined,
    { owner, connectionIds: () => [], registerAuthoritySource: source => { lookup = source; } });
  t.after(async () => { await service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const context = { clientId: 'synthetic-actor', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const session = service.create('ordinary', randomUUID(), context);
  const attachment = service.attach(session.liveSessionId, context);
  await f.frame(1);
  const frame = f.frames[0] as { setup?: { tools?: { functionDeclarations: { name: string }[] }[] }; session?: { delegation: { responses: { tools?: { name: string }[] } } } };
  const declarations = provider === 'gemini' ? frame.setup!.tools!.flatMap(group => group.functionDeclarations) : frame.session!.delegation.responses.tools!;
  const names = declarations.map(tool => tool.name);
  for (const tool of owner.liveDefinitions(session.liveSessionId, () => ({ code: 'remembered' }))) {
    if (!Object.hasOwn(LIVE_NOT_MODEL_FACING, tool.name)) assert.ok(names.includes(tool.name), `${provider} omitted registered owner tool ${tool.name}`);
  }
  for (const name of ['set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm']) assert.ok(names.includes(name), `${provider}: ${name}`);
  assert.ok(!names.includes('remember_note') && !names.includes('save_to_vault'));
  f.send(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.started', session: { id: 'synthetic-catalog' } });
  await attachment.ready;
  if (provider === 'gemini') {
    // The fake provider selects only an advertised tool; the host receives real wire events,
    // parses the owner's words, journals the call and commits the alarm in a synthetic store.
    await f.frame(2); // startup nudge
    f.send({ serverContent: { inputTranscription: { text: 'wake me at 7 tomorrow morning', finished: true } } });
    f.send({ toolCall: { functionCalls: [{ id: 'synthetic-wake', name: 'set_alarm', args: {} }] } });
    await f.frame(3);
    const response = f.frames[2] as { toolResponse: { functionResponses: { name: string; response: unknown }[] } };
    assert.equal(response.toolResponse.functionResponses[0]!.name, 'set_alarm');
    assert.equal(store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1, JSON.stringify(response));
    assert.equal(store.transaction(tx => tx.get("SELECT COUNT(*) AS n FROM tool_calls WHERE json_extract(intent_json, '$.toolName')='set_alarm'")?.n), 1);
  }
});
