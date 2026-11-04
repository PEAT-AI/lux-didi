import { TaskRuntime } from '../tasks/runtime.js';
import { connectorExecutor } from '../tasks/connectors.js';
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
import { randomUUID } from 'node:crypto';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { claimsWithoutCall, liveMigrations, validateLiveProfile } from '../live/index.js';
import { composeLive } from '../host/live.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { noteModelOutput, noteOwnerWords, noteOwnerPartial, ownerTurnWords, ownerWords, webOwnerWords, resolveWebOpen, NativeActionBus, openWebFailure, nativeActions, validateOpenWeb, openTarget } from '../tools/open.js';
import type { LiveAuthority } from '../tools/types.js';
import { beginHandleSession, endHandleSession, mintOpenLine, exposeHandles } from '../tools/open-handles.js';
import { fixture } from './live-voice-fixture.js';
import { createRegistry } from '../tasks/tools.js';
import { documentResult } from '../tasks/results.js';
import { parseAlarmTime, readTimeSpec } from '../tools/alarm.js';
import { alarmHarness } from './alarm-atomic.test.js';
import { Authority, FakeAuthority, type JournalRecord } from '../tasks/authority.js';
import { CONNECTOR_COMPOSED_TOOLS } from '../connectors/index.js';
import { argumentViolations, argumentViolationsOf } from '../tools/declarations.js';
import { normalizeArguments, type ToolDeclaration } from '../tools/normalize.js';
import { claimsEmptyResult } from '../live/index.js';

// Task workers own the catalog and effect journal. Voice exposes only delegate;
// liveDefinitions and per-builtin ToolCallIntent records no longer exist.
test('A2: task builtins reject undeclared arguments before any effect', async t => {
  const h = alarmHarness(t);
  let dispatched = 0;
  t.mock.method(nativeActions, 'dispatch', async () => { dispatched++; return 'opened' as const; });
  for (const tool of h.tools.values()) {
    const result = await h.call(tool.name, { synthetic_undeclared: true }, 'synthetic owner task');
    assert.equal(result.status, 'failed', tool.name);
    assert.match(result.repair ?? '', /declared fields/);
  }
  assert.equal(dispatched, 0);
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 0);
});

test('A2: current builtin declarations dispatch exact arguments through the task port', async () => {
  const authority = new FakeAuthority();
  const dispatched: { name: string; args: Record<string, unknown> }[] = [];
  const tools = createRegistry({ authority, execute: async (name, args) => {
    dispatched.push({ name, args }); return documentResult('synthetic receipt', 'synthetic');
  } });
  const fixtures: Record<string, Record<string, unknown>> = {
    search_mail: { query: 'synthetic', cursor: null }, search_chat: { query: 'synthetic' },
    search_knowledge: { query: 'synthetic' }, search_company: { query: 'synthetic' }, search_drive: { query: 'synthetic' }, search_memory: { query: 'synthetic' },
    read_mail: { id: 'synthetic-mail', cursor: null }, read_knowledge: { id: 'synthetic-knowledge', cursor: null }, read_drive: { id: 'synthetic-drive', cursor: null },
    read_thread: { ref: 'synthetic-thread', cursor: null }, read_company: { ref: 'synthetic-company', cursor: null }, read_memory: { ref: 'synthetic-memory', cursor: null },
    calendar_events: { start: '2026-03-05T09:00:00Z', end: '2026-03-05T10:00:00Z' }, people_lookup: { query: 'Synthetic' },
    remember_note: { text: 'synthetic fact' }, save_to_vault: { title: 'synthetic title', text: 'synthetic note' },
    draft_email: { to: ['synthetic@example.invalid'], subject: 'synthetic', body: 'synthetic draft' },
    draft_chat: { target: '#synthetic', text: 'synthetic draft' },
    create_event: { title: 'synthetic event', start: '2026-03-05T09:00:00Z', end: '2026-03-05T10:00:00Z', calendar_id: null },
    delete_event: { id: 'synthetic-event' },
  };
  const identity = { task_id: 'synthetic-builtin-task', task_revision: 1, operation_id: 'synthetic-operation', connection_generation: 1 };
  for (const [name, args] of Object.entries(fixtures)) {
    const tool = tools.get(name); assert.ok(tool, name);
    const result = await tool.run(args, identity, new AbortController().signal);
    assert.equal(result.status, 'ok', `${name}: ${result.repair}`);
    assert.deepEqual(dispatched.at(-1), { name, args: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null)) });
    if (tool.effect !== 'none') {
      const request = authority.requests.at(-1); assert.ok(request);
      assert.equal(request.tool, name); assert.deepEqual(request.args, args);
      assert.equal(request.task_id, identity.task_id); assert.equal(request.task_revision, identity.task_revision);
    }
  }
  // Renamed tool spellings are deliberately absent, not silently routed to aliases.
  for (const retired of ['research', 'stage_lux_note', 'open_web', 'set_alarm', 'snooze_alarm']) assert.equal(tools.has(retired), false, retired);
});

test('A2: current task identity and exact alarm arguments own the durable intent', async t => {
  const h = alarmHarness(t);
  const at = new Date(Date.now() + 60_000).toISOString();
  const first = await h.call('alarm_create', { text: 'synthetic first', at }, 'set an alarm in one minute');
  assert.equal(first.status, 'ok');
  const same = await h.call('alarm_create', { text: 'synthetic first', at }, 'set an alarm in one minute');
  assert.deepEqual(same.references, first.references);
  const other = await h.call('alarm_create', { text: 'synthetic second', at }, 'also a second alarm');
  assert.notDeepEqual(other.references, first.references, 'changed arguments are a distinct operation, not a replay');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 2);
  const tool = h.tools.get('alarm_create'); assert.ok(tool);
  const refused = await tool.run({ text: 'synthetic stale', at }, { task_id: h.task.id, task_revision: 0, operation_id: 'synthetic-stale', connection_generation: 1 }, new AbortController().signal);
  assert.equal(refused.status, 'failed');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 2);
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await tool.run({ text: 'synthetic cancelled', at }, { task_id: h.task.id, task_revision: 1, operation_id: 'synthetic-cancelled', connection_generation: 1 }, stopped.signal)).status, 'failed');
});

test('A2: unified task open routes each kind and replays only the exact target', async t => {
  const h = alarmHarness(t);
  const actions: { action: string; target: string }[] = [];
  t.mock.method(nativeActions, 'dispatch', async (_id: string, action: string, target: string) => { actions.push({ action, target }); return 'opened' as const; });
  beginHandleSession(h.task.id); t.after(() => endHandleSession(h.task.id));
  const line = mintOpenLine({ title: 'Synthetic email', url: 'https://mail.google.com/mail/u/0/#all/synthetic', sourceType: 'gmail' });
  assert.ok(line); exposeHandles(line);
  const handle = line.match(/L[0-9]+/)![0];
  const cases = [
    { kind: 'web', target: 'https://example.invalid/', action: 'open_url' },
    { kind: 'app', target: 'Synthetic', action: 'open_app' },
    { kind: 'file', target: '/tmp/synthetic-document.txt', action: 'open_file' },
    { kind: 'source', target: handle, action: 'open_url' },
  ];
  for (const row of cases) {
    const args = { kind: row.kind, target: row.target };
    const first = await h.call('open', args, 'open the synthetic item');
    assert.equal(first.status, 'ok', `${row.kind}: ${first.repair}`);
    assert.equal(actions.at(-1)?.action, row.action);
    const count = actions.length;
    assert.equal((await h.call('open', args, 'open the synthetic item')).status, 'ok');
    assert.equal(actions.length, count, 'a replay never dispatches a second native action');
  }
  const before = actions.length;
  assert.equal((await h.call('open', { kind: 'source', target: 'L999999' }, 'open the source')).status, 'failed');
  assert.equal((await h.call('open', { kind: 'web', target: 'file:///synthetic' }, 'open the site')).status, 'failed');
  assert.equal(actions.length, before, 'host refusals never reach native');
});

test('A2: native failure is a closed task failure and never announced as opened', async t => {
  const h = alarmHarness(t);
  t.mock.method(nativeActions, 'dispatch', async () => 'browser_not_running' as const);
  const result = await h.call('open', { kind: 'web', target: 'https://example.invalid/' }, 'open the synthetic site');
  assert.equal(result.status, 'failed');
  assert.match(result.repair ?? '', /browser_not_running/);
  assert.doesNotMatch(result.text, /Opened\./);
});

interface OwnerCorpusRow {
  id: string; finals: string[]; expectedSay?: string; nativeCode?: string; toolDelayMs?: number; now?: number; clarifyAfter?: number[]; finalOffsetsMs?: number[];
  call: Record<string, unknown> & { tool: string }; code: string; fire_at_utc: number | null;
}
const ownerCorpus: OwnerCorpusRow[] = JSON.parse(readFileSync(new URL('../../test/fixtures/owner-utterances.json', import.meta.url), 'utf8'));

// Scripted helper proposals, independent from each row's expected durable timestamp.
// These are model inputs, not an assertion that a deterministic parser infers every spoken form.
const corpusAlarmProposals: Readonly<Record<string, string>> = {
  'AL-1': '2026-10-30T23:40:00Z',
  'AL-3': '2026-10-30T03:10:00Z',
  'AL-4': '2026-10-30T17:10:00Z',
  'AL-3-part-0': '2026-10-30T03:10:00Z',
  'AL-3-part-1': '2026-10-30T03:10:00Z',
  'AL-3-part-2': '2026-10-30T03:10:00Z',
  'alarm-model-fallback': '2026-10-30T06:10:00Z',
  'alarm-owner-conflict': '2026-10-30T06:10:00Z',
};

test('A2 owner corpus: alarm interpretation and real task persistence', async t => {
  for (const row of ownerCorpus.filter(row => row.call.tool === 'set_alarm')) await t.test(row.id, async rowT => {
    const now = row.now ?? Date.UTC(2026, 9, 30, 6);
    const words = row.finals.join(' ');
    const h = alarmHarness(rowT, () => {}, () => now + (row.toolDelayMs ?? 0), 'UTC');
    if (row.code === 'no_owner_request') {
      const tool = h.tools.get('alarm_create'); assert.ok(tool);
      assert.equal((await tool.run({ text: 'synthetic missing task', at: new Date(now + 60_000).toISOString() }, { task_id: 'synthetic-absent-task', task_revision: 1, operation_id: row.id, connection_generation: 1 }, new AbortController().signal)).status, 'failed');
      return;
    }
    const proposedAt = corpusAlarmProposals[row.id];
    const proposal = proposedAt === undefined ? undefined : readTimeSpec({ mode: 'wall', date: proposedAt.slice(0, 10), local_time: proposedAt.slice(11, 16), timezone: 'UTC' });
    if (proposal) assert.equal(proposal.state, 'read', 'the helper proposed a valid typed time');
    const parsed = parseAlarmTime(words, now + (row.finalOffsetsMs?.at(-1) ?? 0), 'UTC', proposal?.state === 'read' ? proposal.spec : undefined);
    if (row.code !== 'ready') {
      assert.equal(parsed.status, 'clarify');
      assert.equal(parsed.status === 'clarify' ? parsed.reason : undefined, row.code);
      assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 0, 'unresolved time never arms a guessed alarm');
      return;
    }
    assert.equal(parsed.status, 'ready', JSON.stringify(parsed));
    if (parsed.status !== 'ready') throw new Error('Expected a resolved owner corpus time');
    assert.equal(parsed.fireAtUtc, row.fire_at_utc);
    const args = { text: 'synthetic corpus reminder', at: proposedAt ?? new Date(parsed.fireAtUtc).toISOString(), recurrence: null };
    let result;
    if (row.id === 'turn-time-not-dispatch-time') {
      const runtime = new TaskRuntime({ store: h.store, now: () => now, timeZone: 'UTC',
        execute: connectorExecutor([], h.owner.taskExecutors('synthetic-corpus-task')),
        authority: new Authority({ journal: h.store.taskEffectJournal(() => true), checkEffect: async () => true, log() {} }),
        infer: async () => ({ text: '', calls: [], no_action: true }), contentAllowed: () => true,
        delivery: { attach() {}, progress() {}, deliver() {}, closed() {} } });
      const revision = runtime.begin(words, 1);
      try { result = await runtime.runTool('alarm_create', args, { ...revision.identity, operation_id: 'synthetic-alarm-create' }, revision.signal); }
      finally { runtime.close(); }
    } else result = await h.call('alarm_create', args, words);
    assert.equal(result.status, 'ok', result.repair ?? result.text);
    assert.equal(h.store.transaction(tx => tx.get('SELECT fire_at_utc FROM alarms WHERE id=?', [result.references[0]!.id])?.fire_at_utc), row.fire_at_utc);
  });
});

test('alarm helper proposals cannot override a clear owner time or manufacture an unresolved time', async t => {
  const now = Date.UTC(2030, 0, 1);
  const h = alarmHarness(t, () => {}, () => now, 'UTC');
  const result = await h.call('alarm_create', { text: 'Synthetic clear owner time', at: new Date(now + 60 * 60_000).toISOString() }, 'Set an alarm in five minutes');
  assert.equal(result.status, 'ok', result.repair ?? result.text);
  assert.equal(h.store.transaction(tx => tx.get('SELECT fire_at_utc FROM alarms WHERE id=?', [result.references[0]!.id])?.fire_at_utc), now + 5 * 60_000, 'clear owner words beat the conflicting helper proposal');
  const unresolved = 'Set an alarm at 7:45 and at 8:45';
  assert.equal(parseAlarmTime(unresolved, now, 'UTC').status, 'clarify', 'conflicting words without a valid proposal do not settle one time');
  const invalid = await h.call('alarm_create', { text: 'Synthetic unresolved time', at: 'not a valid proposal' }, unresolved);
  assert.equal(invalid.status, 'failed');
  assert.equal(h.store.transaction(tx => tx.get('SELECT COUNT(*) AS n FROM alarms')?.n), 1, 'the unresolved negative case commits nothing');
});

test('A2 owner corpus: named opens use the unified task operation and native receipts', async t => {
  for (const row of ownerCorpus.filter(row => row.call.tool.startsWith('open_'))) await t.test(row.id, async rowT => {
    const h = alarmHarness(rowT);
    let dispatched = 0;
    rowT.mock.method(nativeActions, 'dispatch', async () => { dispatched++; return row.nativeCode === 'native_timeout' ? 'native_timeout' as const : row.nativeCode ? 'failed' as const : 'opened' as const; });
    beginHandleSession(h.task.id); rowT.after(() => endHandleSession(h.task.id));
    const line = mintOpenLine({ title: 'Synthetic email', url: 'https://mail.google.com/mail/u/0/#all/synthetic', sourceType: 'gmail' });
    assert.ok(line); exposeHandles(line);
    const { tool, ...args } = row.call;
    let kind: string, target: string;
    if (tool === 'open_web') {
      assert.ok(validateOpenWeb(args));
      const resolved = await resolveWebOpen(args, row.finals.join(' '), new AbortController().signal);
      if (!('target' in resolved)) {
        // A forbidden scheme is a host refusal, never a native action. The old
        // target_not_authorized label is replaced by the closed task failure.
        assert.equal(row.code, 'target_not_authorized'); assert.equal(dispatched, 0); return;
      }
      kind = 'web'; target = resolved.target.target;
    } else if (tool === 'open_source') { kind = 'source'; target = line.match(/L[0-9]+/)![0]; }
    else if (tool === 'open_app') { kind = 'app'; assert.equal(typeof args.name, 'string'); target = String(args.name); }
    else if (tool === 'open_file') { kind = 'file'; assert.equal(typeof args.path, 'string'); target = String(args.path); }
    else {
      assert.equal(tool, 'open_home');
      const resolved = openTarget('open_home', { app: String(args.app) });
      assert.ok('target' in resolved); kind = 'web'; target = resolved.target.target;
    }
    const result = await h.call('open', { kind, target }, row.finals.join(' '));
    const expected = row.nativeCode || row.code === 'target_not_authorized' ? 'failed' : 'ok';
    assert.equal(result.status, expected, result.repair ?? result.text);
    assert.equal(dispatched, 1);
    if (result.status === 'failed') {
      assert.ok(result.repair); assert.doesNotMatch(result.text, /Opened\./);
    }
  });
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
for (const provider of ['gemini', 'openai'] as const) test(`voice ${provider} declares only the host delegation boundary`, async t => {
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
  const frame = f.frames[0] as { setup?: { tools?: { functionDeclarations: { name: string }[] }[] }; session?: { delegation: { type: string; responses?: unknown }; tools?: unknown } };
  if (provider === 'gemini') assert.deepEqual(frame.setup!.tools!.flatMap(group => group.functionDeclarations).map(tool => tool.name), ['delegate']);
  else { assert.equal(frame.session!.delegation.type, 'client'); assert.equal(frame.session!.delegation.responses, undefined); assert.equal(frame.session!.tools, undefined); }
  f.send(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.started', session: { id: 'synthetic-catalog' } });
  await attachment.ready;
});

// C-DIAG109 review F1: the read-back clock and the minutes away are the execution clock's, never the ask
// stamp's. The owner asks at 12:00, the tool runs at 12:03, and his words still resolve the alarm at 12:05,
// so the receipt must say 12:03 and 2 minutes, and the confirmation repeats no computed figure.
test('SOURCE DEFECT C-DIAG109: delayed tasks preserve the ask-time target and read back from execution time', async t => {
  const askAt = Date.parse('2026-03-05T11:00:00Z');
  let now = askAt;
  const h = alarmHarness(t, () => {}, () => now, 'Europe/Berlin');
  const runtime = new TaskRuntime({ store: h.store, now: () => now, timeZone: 'Europe/Berlin',
    execute: connectorExecutor([], h.owner.taskExecutors('synthetic-readback-task')),
    authority: new Authority({ journal: h.store.taskEffectJournal(() => true), checkEffect: async () => true, log() {} }),
    infer: async () => ({ text: '', calls: [], no_action: true }), contentAllowed: () => true,
    delivery: { attach() {}, progress() {}, deliver() {}, closed() {} } });
  const revision = runtime.begin('wake me in five minutes', 1);
  assert.equal(revision.askAtUtc, askAt, 'the real task captures ask time before dispatch advances');
  now += 3 * 60_000;
  let result;
  try { result = await runtime.runTool('alarm_create', { text: 'synthetic reminder', at: new Date(askAt + 5 * 60_000).toISOString(), recurrence: null },
    { ...revision.identity, operation_id: 'synthetic-readback' }, revision.signal); }
  finally { runtime.close(); }
  assert.equal(result.status, 'ok');
  const reply = JSON.parse(result.text);
  assert.equal(Date.parse(reply.at), askAt + 5 * 60_000);
  assert.equal(reply.now_local_time, '12:03');
  assert.equal(reply.minutes_from_now, 2);
  assert.match(reply.confirmation, /12:05/);
});

// #795: the clarify-then-answer shape on the real call path. The model answers his calendar ask with a
// question, so the live call site hands that answer to the owner request and his one-line reply keeps the
// write grant. Without the question in that call, the same reply carries nothing (the paired case below).
test('#795 task authority keeps finalized ask context across a clarification', async () => {
  const seen: unknown[] = [];
  const journal = new Map<string, JournalRecord>();
  const authority = new Authority({ journal: { get: async id => journal.get(id), put: async (id, row) => { journal.set(id, row); } },
    checkEffect: async input => { seen.push(input); return input.precedingOwnerWords === 'put a block on my calendar'; }, log() {} });
  authority.expose('synthetic-calendar-task', 'web');
  const request = { effect: 'create_event' as const, arguments: {}, validate: () => true,
    task: { id: 'synthetic-calendar-task', revision: 2, ownerWords: 'tomorrow at noon', precedingOwnerWords: 'put a block on my calendar' } };
  assert.deepEqual(await authority.authorize(request), { allow: true });
  assert.deepEqual(seen, [{ effect: 'create_event', ownerWords: 'tomorrow at noon', precedingOwnerWords: 'put a block on my calendar' }]);
  const unrelated = await authority.authorize({ ...request, task: { id: 'synthetic-unrelated-task', revision: 1, ownerWords: 'tomorrow at noon' } });
  // Free unexposed writes do not require an intent classifier. The paired exposed
  // case is the boundary that must refuse borrowing another task's ask.
  assert.deepEqual(unrelated, { allow: true });
  authority.expose('synthetic-unrelated-task', 'web');
  const refused = await authority.authorize({ ...request, task: { id: 'synthetic-unrelated-task', revision: 2, ownerWords: 'tomorrow at noon' } });
  assert.equal(refused.allow, false);
});

// #797: the retry claim is only checkable after a refused write, and a call that did happen silences it.
for (const [said, writeRefused, toolSeen, flagged] of [
  ['I tried again and it still did not go through.', true, false, true],
  ['Let me retry that, still nothing.', false, false, false],
  ['I retried it and it went through.', true, true, false],
  ['It is still on your calendar.', true, false, false],
  ['Let me check your calendar.', true, false, true],
] as const) {
  test(`#797 "${said}" refused=${writeRefused} callSeen=${toolSeen} -> ${flagged ? 'flagged' : 'left alone'}`, () => {
    assert.equal(claimsWithoutCall({ text: said, writeRefused, toolSeen }), flagged);
  });
}

// C-ARGS/D5: the argument normalizer, the violation list and the empty-result claim guard, against the
// real mattermost_chat declaration the connector publishes.
/** The real `mattermost_chat` declaration, exactly as the connector publishes it: no copy in the test. */
const chat = CONNECTOR_COMPOSED_TOOLS['mattermost']!.find(tool => tool.name === 'mattermost_chat')!;
const declaration: ToolDeclaration = {
  name: chat.name, effect: 'read', parameters: { type: 'object', ...chat.parameters },
  ...(chat.rejection === undefined ? {} : { rejection: chat.rejection }),
};

/** C-ARGS test 1: the call the realtime model made on 10-31, all twelve optional keys beside the person's name. */
test('the twelve-key person read normalizes and dispatches instead of refusing', () => {
  const sent = {
    intent: 'person', person: 'Maya', people: [] as string[], channel: '', query: '', post_id: '',
    order: 'newest', from_date: '2026-10-01', to_date: '2026-10-31', sides: 'both', offset: 0, limit: 8,
  };
  const { args, dropped } = normalizeArguments(declaration, sent);
  // Every key this intent does not read is dropped, named as an absent value or as another intent's key,
  // and the reason is always one of the closed set.
  for (const key of ['people', 'post_id', 'channel', 'query']) {
    assert.equal(dropped.some(token => token.startsWith(`${key}:`)), true, `${key} is dropped: ${dropped.join(',')}`);
  }
  assert.equal(dropped.every(token => /:(?:undeclared|not_read|absent)$/u.test(token)), true);
  assert.equal(chat.rejection!(args), undefined, 'nothing a person read does not read may refuse it');
  assert.deepEqual(Object.keys(args).sort(), ['from_date', 'intent', 'limit', 'offset', 'order', 'person', 'sides', 'to_date']);
  assert.equal(args['person'], 'Maya', 'the value the intent reads is never rewritten');
});

test('a non-empty value of a key the intent reads is kept and refused, and every violation is listed', () => {
  const sent = { intent: 'person', person: 'Maya', limit: 100, from_date: 'yesterday' };
  const { args } = normalizeArguments(declaration, sent);
  assert.equal(args['limit'], 100);
  assert.equal(args['from_date'], 'yesterday');
  const violations = argumentViolationsOf(chat, args);
  assert.deepEqual(violations, ['from_date:format', 'limit:range'], 'both violations come back in one answer');
  const fields = argumentViolations(`Invalid arguments for mattermost_chat. Rejected arguments: ${violations.join(', ')}. Expected an object with intent (string).`);
  assert.deepEqual(fields, [{ field: 'from_date', reason: 'format' }, { field: 'limit', reason: 'range' }]);
  assert.equal(JSON.stringify(violations).includes('yesterday'), false, 'a violation carries a rule, never a value');
  assert.equal(JSON.stringify(violations).includes('100'), false);
});

/** C-ARGS test 5: an empty-result claim over a lookup that never ran is corrected, a real empty result is not. */
test('the claim guard flags an empty result only after a rejected lookup, never after a real empty result', () => {
  for (const said of ['It came back empty.', 'Nothing found.', 'There are no results.', 'I found nothing.']) {
    assert.equal(claimsEmptyResult(said, true), true, `${said} is a claim over a read that never ran`);
    assert.equal(claimsEmptyResult(said, false), false, `${said} after a real empty result is the truth, not a claim`);
  }
  assert.equal(claimsEmptyResult('I found three messages from Maya.', true), false, 'a real finding is never corrected');
});

// C-ARGS F2: the filler rule matches research.ts, so only an absent value is a filler. A whitespace-only
// string is a value of his, it is kept, and the tool's own rule refuses it as `query:empty`.
test('the normalizer drops only the absent value research.ts calls a filler', () => {
  const sent = { intent: 'channel', channel: 'synthetic-channel', query: '   ', people: [], extra: '', empty: {} };
  const { args, dropped } = normalizeArguments(declaration, sent);
  assert.equal(args['query'], '   ', 'a whitespace-only value is never dropped');
  assert.equal(args['channel'], 'synthetic-channel');
  assert.deepEqual(Object.keys(args).sort(), ['channel', 'intent', 'query'], 'only what this read reads survives');
  assert.equal(dropped.length, 3, `each key that does not belong to this read is reported: ${dropped.join(',')}`);
  assert.equal(dropped.every(token => /^(?:people|extra|empty):(?:undeclared|not_read|absent)$/u.test(token)), true, dropped.join(','));
  // `{}` and an empty array are fillers at the top level too, but only for keys the tool declares.
  assert.equal(chat.rejection!(args), 'query:empty', 'the tool still refuses the whitespace it was sent');
  // Only the absent values the tool itself refuses are dropped. A tool that never names the empty value
  // keeps it, because the reader may need the key present, and an empty object is kept for a tool with
  // no refusal rule of its own.
  const noRefusal = { name: 'conversation_history', effect: 'read' as const, parameters: { type: 'object', properties: { query: {}, limit: {} } } };
  const kept = normalizeArguments(noRefusal, { query: '', limit: 5 });
  assert.deepEqual(kept.args, { query: '', limit: 5 }, 'a filler no rule refuses stays as it was sent');
  assert.deepEqual(kept.dropped, []);
  const own = normalizeArguments({ name: 'trello_read', effect: 'read', parameters: { type: 'object', properties: { view: {}, card: {}, offset: {} } } },
    { view: 'list', card: {}, offset: 0, wider: 'kept' });
  assert.deepEqual(own.args, { view: 'list', card: {}, offset: 0, wider: 'kept' }, 'a validate-only tool keeps its fillers and its wider keys');
  assert.deepEqual(own.dropped, [], 'and nothing is dropped without a rule of the tool to say so');
  // The one tool that calls an undeclared key unknown has it dropped, and the count is on the closed event.
  assert.deepEqual(normalizeArguments(declaration, { intent: 'overview', query: 'synthetic', wider: 'x' }).dropped, ['wider:undeclared']);
});

test('C-FREEDOM: her own sentence never clears the open she was asked for', () => {
  // C-OPEN built the window as "the turns since the model last spoke", so her own answer to him threw
  // the ask away and a later open needed him to repeat it. The session keeps the ask instead.
  const run = 'freedom-open-window';
  noteOwnerWords(run, 'open my inbox in the browser');
  noteModelOutput(run);
  assert.equal(ownerWords(run), 'open my inbox in the browser', 'her sentence leaves the ask in place');
  noteOwnerWords(run, 'and the second folder too');
  noteModelOutput(run);
  assert.match(ownerWords(run), /open my inbox in the browser/, 'a session long ask still opens');
});

// The canary floor is a retained safety requirement, not a retired wire detail.
test('SOURCE DEFECT C-SAFETY: a one-second alarm cannot bypass the sixty-second canary floor', async t => {
  const now = Date.parse('2030-01-02T00:00:00Z');
  const h = alarmHarness(t, () => {}, () => now);
  await h.call('alarm_create', { text: 'synthetic canary', at: new Date(now + 1_000).toISOString() }, 'wake me in one second');
  const alarm = h.store.transaction(tx => tx.get('SELECT fire_at_utc FROM alarms'));
  assert.ok(alarm, 'the canary remains an alarm creation, not a silently dropped request');
  assert.ok(Number(alarm.fire_at_utc) >= now + 60_000, 'the owner must not get an alarm less than sixty seconds after the canary ask');
});
