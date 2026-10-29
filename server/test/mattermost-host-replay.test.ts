// Synthetic finalized-turn replay through the actual classified host and model delivery gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { EndpointConfig } from '../adapters/mcp/port.js';
import { createMattermostReader, connectionEnvelope, composedGrantedNames, MATTERMOST_CHAT_TOOL } from '../connectors/index.js';
import { installPeople, parsePeople } from '../people/index.js';
import { Store } from '../runtime/store.js';
import { hostMigrations } from '../host/runtime.js';
import { createToolsOwner } from '../tools/index.js';
import { runToolCalls } from '../tools/declarations.js';
import type { LiveAuthority, RunAcceptance } from '../tools/types.js';
const FIXTURE_NOW = Date.parse('2026-10-25T09:00:00Z');
const ACCOUNT = 'local';
const RESOURCE = 'mattermost';
const child = join(process.cwd(), 'server/test/fixtures/stdio-mattermost-people-child.mjs');
const fixtureDaysAgo = (days: number): string => new Date(FIXTURE_NOW - days * 86400000).toISOString().slice(0, 10);
type Call = { name: string; arguments: Record<string, unknown> };
async function setup(t: { after(fn: () => Promise<void> | void): void }, mode: 'people' | 'legacy', grant?: (names: string[]) => string[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-people-'));
  const log = join(dir, 'calls.log');
  const registry = new McpRegistry();
  const config: EndpointConfig = {
    id: 'mattermost', transport: 'stdio', command: process.execPath, args: [child, mode],
    env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', DIDI_FAKE_MATTERMOST_LOG: log, DIDI_FAKE_MATTERMOST_NOW: String(FIXTURE_NOW), LOGNAME: '', SHELL: '', TERM: '', USER: '', ...extraEnv },
    account: ACCOUNT, resource: RESOURCE,
  };
  registry.register(config);
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  t.after(async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); });
  const discovery = await adapter.discover('mattermost');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  // The host grants the connector envelope intersected with what this child publishes (owner-trusted-reads).
  const published = discovery.tools.map(tool => tool.name);
  const envelope = connectionEnvelope('mattermost', { resource: RESOURCE });
  const names = (grant ?? (list => list))(envelope.filter(name => published.includes(name)));
  registry.approve({ endpointId: 'mattermost', schemaDigest: discovery.schemaDigest, toolNames: names, effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  const reader = createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest: discovery.schemaDigest, generation: 1, maxLimit: 50, queryChars: 200, names: [...names, ...composedGrantedNames('mattermost', names)] } });
  const calls = (): Call[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
  return { adapter, registry, reader, calls, published, names, dir, config, discovery };
}

// MM-3 / original 15:29-15:31 regression: one owner, one accepted host run, five executions.
test('MM-3: channel topic, person topic, overview and two recency reads all publish in ONE host run', async t => {
  const f = await setup(t, 'people', undefined, { DIDI_FAKE_MATTERMOST_NIGHT: 'yes' });
  installPeople(parsePeople({ version: 1, people: [{ id: 'person-a', name: 'Ada Moss', aliases: ['Ada'], role: 'Engineer', circle: 'plantix', tier: 1, email: ['person-a@example.invalid'], mattermost: 'ada.moss' }] }));
  t.after(() => installPeople(null));
  const store = new Store(join(f.dir, 'synthetic-host'), hostMigrations);
  t.after(() => store.close());
  // Match dispatch-gate.test.ts: real source provenance requires a classified live session.
  store.transaction(tx => {
    tx.run('INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['chat-sequence', store.assistantId, store.authorityEpoch, 'synthetic-key', 'synthetic-fingerprint', 'synthetic-client', 'synthetic-audit', 'synthetic-profile', 'synthetic-prompt', 'active', 0, 1, 0, 0, 1, 'attached', 0, 0]);
    tx.run('INSERT INTO history_sessions(live_session_id,owner_id,data_class,revision,created_at) VALUES(?,?,?,?,?)', ['chat-sequence', store.assistantId, 'ordinary', 1, 0]);
  });
  let live: LiveAuthority | null = null;
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry: f.registry, port: f.adapter, lookupAuthority: async () => live });
  owner.applyConnection({
    schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mattermost', generation: 2, enabled: true, connector: 'mattermost',
    endpoint: { ...f.config, credentialRef: null }, toolNames: f.names, schemaDigest: f.discovery.schemaDigest,
    sourcePolicy: { id: 'mattermost-read', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'voice', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 200, maxSearchLimit: 50, maxGetIds: 10, maxEntityBytes: 20000, maxResultBytes: 200000 },
  } as never);
  assert.equal((await f.adapter.discover('mattermost')).state, 'discovered');
  owner.projectConnection('mattermost');
  const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: 'actor', runId: 'chat-sequence', authorityEpoch: store.authorityEpoch, revision: 1,
    route: { identity: 'voice', provider: 'gemini', modelId: 'gemini-2.5-flash', allowedClasses: ['ordinary'] }, allowedClasses: ['ordinary'], connectionIds: ['mattermost'] };
  const accepted = store.transaction(tx => owner.snapshotRun(tx, acceptance));
  live = { ...acceptance, acceptedRunHash: accepted.sha256 };
  const host = { ...live, grants: [...f.names, MATTERMOST_CHAT_TOOL].map(tool => ({ tool, effect: 'read', accountId: ACCOUNT, resourceId: RESOURCE })) };
  const definitions = owner.definitions('chat-sequence');
  const sequence = [
    { intent: 'channel', channel: 'Builders', query: 'pilot' },
    { intent: 'person', person: 'Ada', query: 'pilot' },
    { intent: 'overview', person: 'Ada', channel: 'stale-channel', query: 'stale-topic' },
    { intent: 'person', person: 'Ada', query: 'latest messages' },
    { intent: 'person', person: 'Ada', query: 'recent messages' },
  ];
  for (const [step, args] of sequence.entries()) {
    await t.test(`original-sequence-${step}`, async () => {
    const batch = await runToolCalls(owner, [{ id: `chat-${step}`, name: MATTERMOST_CHAT_TOOL, args: { ...args, from_date: fixtureDaysAgo(7) } }], {
      registry: definitions, host: host as never, authority: { isCurrent: async () => true } as never,
      control: { signal: new AbortController().signal, deadlineMs: Date.now() + 5000 }, step, contentIndex: 0, seenIds: new Set<string>(), authorize: true, baseClasses: ['ordinary'],
    });
    assert.equal(batch.error, undefined, `step ${step}: ${JSON.stringify(batch.tools)}`);
    assert.equal(batch.tools[0]?.status, 'completed', `step ${step}: ${JSON.stringify(batch.tools)}`);
    if (step === 1) {
      assert.ok(f.calls().some(call => call.name === 'mattermost_list_channels' && call.arguments['query'] === undefined), 'the person read really populated the reusable channel index');
      const dispatches = store.transaction(tx => tx.all("SELECT tool_name,state,reason,source_json IS NOT NULL AS sealed FROM tool_dispatches WHERE run_id=?", ['chat-sequence']));
      assert.ok(dispatches.some(row => row['tool_name'] === 'mattermost_list_channels' && row['sealed'] === 1), JSON.stringify(dispatches));
    }
    assert.match(JSON.stringify(batch.accepted), /pilot/iu, `step ${step} delivers actual post bodies`);
    assert.doesNotMatch(JSON.stringify(batch.accepted), /dispatch_reference_denied|no messages/iu);
    });
  }

  // A deterministic provider replay: each recognizer final is observed separately,
  // then its recorded tool intent crosses the real host dispatch and result gate.
  const replays = [
    { id: 'MM-1', finals: [' And like, can you like check in the', ' Alpha Alpha Alpha channel and metamorph what Ada was yelling at me', ', about like', ' deploying something'], args: { intent: 'channel', channel: 'Alpha Alpha Alpha', query: 'deploying' }, body: /deployed sandbox/u },
    { id: 'MM-2', finals: [" That's the name in MetaMask"], clarification: 'Is Alpha Alpha Alpha the channel name?', args: { intent: 'channel', channel: 'Alpha Alpha Alpha', query: 'deploying' }, body: /deployed sandbox/u },
    { id: 'MM-3', finals: [' Can you check my d- -w- w', ' What is my- about my DMs with Ada, what do you find about them? What would this we discussed lately'], args: { intent: 'overview', person: 'Ada' }, body: /pilot/u },
    { id: 'MM-4', finals: [' Can you get the latest messages', ' between me and Person A'], args: { intent: 'person', person: '@person.a', query: 'latest messages' }, body: /entry 1/u },
    { id: 'MM-5', finals: ['recent discussions with Ada'], args: { intent: 'overview', person: 'Ada' }, body: /pilot/u },
    { id: 'MM-6', finals: [" I mean like there's a thread where Ada and I have been discussing stuff, right? And um", ', Um, and he shared he shared an article you can from university, I think', " It's not it's not", ', yeah', ", It's not in it's not it's in there, there's a channel called Alpha Alpha Alpha Alpha"], args: { intent: 'channel', channel: 'Alpha Alpha Alpha Alpha', query: 'university' }, body: /https:\/\/example.invalid\/article/u },
    { id: 'MM-7', finals: [' understand. But can you access uhh Metamos', ' Slack channel', ', Metamos'], args: { intent: 'channel', channel: 'Alpha Alpha Alpha' }, body: /deployed sandbox/u },
    { id: 'MM-8', finals: [' Yes, um', ', check', ' Metamos, uh what we need to discuss with Ada. T-Is he all of the past conversations that we have been having'], args: { intent: 'overview', person: 'Ada' }, body: /pilot/u },
  ];
  let step = sequence.length;
  for (const replay of replays) {
    await t.test(replay.id, async () => {
    for (const [index, words] of replay.finals.entries()) owner.observeAlarmOwner('chat-sequence', `${replay.id}-final-${index}`, words, FIXTURE_NOW);
    const batch = await runToolCalls(owner, [{ id: replay.id, name: MATTERMOST_CHAT_TOOL, args: { ...replay.args, from_date: fixtureDaysAgo(7) } }], {
      registry: definitions, host: host as never, authority: { isCurrent: async () => true } as never,
      control: { signal: new AbortController().signal, deadlineMs: Date.now() + 5000 }, step: step++, contentIndex: 0, seenIds: new Set<string>(), authorize: true, baseClasses: ['ordinary'],
    });
    assert.equal(batch.error, undefined, replay.id);
    assert.equal(batch.tools[0]?.status, 'completed', `${replay.id}: ${JSON.stringify(batch.tools)}`);
    assert.match(JSON.stringify(batch.accepted), replay.body, `${replay.id}: actual model-visible post bodies`);
    assert.doesNotMatch(JSON.stringify(batch.accepted), /dispatch_reference_denied|no messages/iu, replay.id);
    });
  }
});

