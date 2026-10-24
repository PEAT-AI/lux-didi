import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import type { EndpointConfig } from '../adapters/mcp/port.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { connectorDescriptor, createMattermostReader, MATTERMOST_ATTENTION, MATTERMOST_TOOLS } from '../connectors/index.js';
import type { AttentionItem, MattermostAttention } from '../connectors/index.js';
import { projectMattermostResult, renderAttention } from '../tools/mattermost.js';
import { INTENT_TOOL_NAMES, INTERNAL, planIntent, validateIntent } from '../tools/intent.js';
import { ResearchLedger, runResearch, type ResearchDeps } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'fixtures', 'stdio-mattermost-attention-child.mjs');
const ACCOUNT = 'local';
const RESOURCE = 'mattermost';
const DAY = 24 * 60 * 60 * 1000;

function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-mattermost-attention-'));
  const log = join(dir, 'calls.log');
  const registry = new McpRegistry();
  const config: EndpointConfig = {
    id: 'mattermost', transport: 'stdio', command: process.execPath, args: [child, mode],
    env: { HOME: dir, PATH: process.env.PATH ?? '/usr/bin', DIDI_FAKE_MATTERMOST_LOG: log, LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    account: ACCOUNT, resource: RESOURCE,
  };
  registry.register(config);
  registry.enable('mattermost'); registry.allowEgress('mattermost');
  const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
  const calls = (): { name: string; arguments: Record<string, unknown> }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> }) : [];
  return { dir, log, registry, adapter, calls };
}

async function approve(registry: McpRegistry, adapter: ReturnType<typeof createMcpAdapter>) {
  const discovery = await adapter.discover('mattermost');
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId: 'mattermost', schemaDigest: discovery.schemaDigest, toolNames: [...MATTERMOST_TOOLS], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return discovery.schemaDigest;
}

function reader(adapter: ReturnType<typeof createMcpAdapter>, registry: McpRegistry, schemaDigest: string) {
  return createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxLimit: 60, queryChars: 200 } });
}

function digest(result: { state: string; decodedResult?: unknown }): MattermostAttention {
  assert.equal(result.state, 'completed');
  return result.decodedResult as MattermostAttention;
}

const summaries = (items: readonly AttentionItem[]) => items.map(item => `${item.reason} ${item.author} ${item.snippet}`);

test('the attention view lists mentions, direct messages and open threads newest first', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const view = digest(await r.attention({}));
  assert.deepEqual(summaries(view.items), [
    'thread Dana I can take it tomorrow morning',
    'thread Dana done, they line up',
    'dm Dana sent you the deck for review',
    'mention Dana @robert can you confirm the 3k release?',
  ]);
  const mention = view.items.find(item => item.reason === 'mention');
  assert.ok(mention);
  assert.equal(mention.channel, 'team-release');
  assert.equal(mention.permalink, 'https://chat.example/m/mention-recent');
  assert.match(mention.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(view.after) < Date.now() - 6 * DAY, 'the digest reports the window it applied');
});

test('a public channel thread the owner opened is seeded from the owner\'s own posts', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const view = digest(await r.attention({}));
  const publicThread = view.items.find(item => item.snippet === 'I can take it tomorrow morning');
  assert.ok(publicThread, 'a thread nobody mentioned the owner in still surfaces');
  assert.equal(publicThread.reason, 'thread');
  assert.equal(publicThread.channel, 'team-release', 'a channel the owner never wrote a mention in');
  assert.ok(f.calls().some(call => call.name === 'mattermost_search' && String(call.arguments['query']).startsWith('from:')), 'seeded by the owner\'s own posts, not by a mention');
});

test('the window is enforced against the post time, not the child result order', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const week = digest(await r.attention({ days: 7 }));
  assert.ok(!summaries(week.items).some(line => line.includes('did you see this last week')), 'a ten day old mention is outside seven days');
  const month = digest(await r.attention({ days: 30 }));
  assert.ok(summaries(month.items).some(line => line.includes('did you see this last week')), 'the same mention is inside thirty days');
  assert.equal((await r.attention({ days: 0 })).state, 'refused');
  assert.equal((await r.attention({ days: 31 })).state, 'refused');
});

test('a thread whose newest post is the owner does not await a reply', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const view = digest(await r.attention({}));
  const threads = view.items.filter(item => item.reason === 'thread');
  assert.deepEqual(threads.map(item => item.snippet), ['I can take it tomorrow morning', 'done, they line up']);
  assert.ok(f.calls().some(call => call.name === 'mattermost_get_thread' && call.arguments['post_id'] === 'threadDoneRoot'), 'the answered thread is read and then dropped');
  assert.ok(!threads.some(item => item.snippet === 'shipped it'), 'the owner was the newest poster there');
});

test('the owner identity is read once per process across attention calls', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  await r.attention({});
  await r.attention({ days: 30 });
  assert.equal(f.calls().filter(call => call.name === 'mattermost_whoami').length, 1);
});

test('the attention digest is composed from child reads, never dispatched as one call', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  await r.attention({ days: 7, limit: 5 });
  const sent = f.calls().filter(call => call.name === 'mattermost_attention');
  assert.deepEqual(sent, [], 'the digest is composed locally, never dispatched as one child call');
  const search = f.calls().filter(call => call.name === 'mattermost_search');
  assert.ok(search.length > 0);
  for (const call of search) assert.deepEqual(Object.keys(call.arguments).sort(), ['limit', 'query']);
});

test('the attention view projects one line per item with its permalink', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const result = await r.attention({});
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  const lines = projected.projection.text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? '', /^- \[thread\] team-release \| Dana \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| I can take it tomorrow morning \| https:\/\/chat\.example\/m\/public-thread-reply$/u);
  assert.match(lines[1] ?? '', /^- \[thread\] direct-dana \| Dana \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| done, they line up \| https:\/\/chat\.example\/m\/thread-open-reply$/u);
  assert.equal(projected.projection.itemCount, 4);
});

test('an empty digest says so instead of returning nothing', () => {
  const projection = renderAttention({ after: '2026-01-01T00:00:00.000Z', items: [] });
  assert.match(projection.text, /Nothing is waiting on a reply since 2026-01-01T00:00:00.000Z/u);
  assert.equal(projection.itemCount, 0);
});

test('general search looks back ninety days by default and to the period the caller names', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const before = Date.now();
  assert.equal((await r.search({ query: 'release' })).state, 'completed');
  const [first] = f.calls().filter(call => call.name === 'mattermost_search');
  const after = typeof first?.arguments['after'] === 'string' ? Date.parse(first.arguments['after'] as string) : 0;
  assert.ok(Math.abs(after - (before - 90 * DAY)) < 60_000, `default window is ninety days: ${String(first?.arguments['after'])}`);
  assert.equal(first?.arguments['before'], undefined);
  assert.equal((await r.search({ query: 'release', after: '2016-01-01T00:00:00.000Z', before: '2025-01-01T00:00:00.000Z' })).state, 'completed');
  const named = f.calls().filter(call => call.name === 'mattermost_search').at(-1);
  assert.deepEqual(named?.arguments, { query: 'release', limit: 12, after: '2016-01-01T00:00:00.000Z', before: '2025-01-01T00:00:00.000Z' });
  assert.equal((await r.search({ query: 'release', after: 'x'.repeat(260) })).state, 'refused', 'an over-long window string is refused locally, never sent');
});

test('a child schema without a window column receives no window argument', async t => {
  const f = setup('no-window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  assert.equal((await r.search({ query: 'release' })).state, 'completed');
  const [first] = f.calls().filter(call => call.name === 'mattermost_search');
  assert.deepEqual(Object.keys(first?.arguments ?? {}).sort(), ['limit', 'query']);
});

test('search results reach the model newest first', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const result = await r.search({ query: 'release' });
  const projected = projectMattermostResult(f.adapter, result);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  const text = projected.projection.text;
  assert.ok(text.indexOf('can you confirm the 3k release') >= 0 && text.indexOf('can you confirm the 3k release') < text.indexOf('did you see this last week'), 'the newer mention leads the older one');
});

test('the thread tool accepts the id research sends and normalizes it for the reader', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 60, maxGetIds: 10, maxEntityBytes: 1024, maxResultBytes: 1024 } } as unknown as ConnectionPolicy;
  const descriptor = connectorDescriptor('mattermost');
  assert.ok(descriptor);
  const declaration = descriptor.declarations(policy).find(candidate => candidate.name === 'mattermost_get_thread');
  assert.ok(declaration);
  assert.equal(declaration.validate({ postId: 'abcdef1234567890abcdefghij' }), true);
  assert.equal(declaration.validate({ post_id: 'abcdef1234567890abcdefghij' }), true, 'research.ts sends post_id');
  assert.equal(declaration.validate({ post_id: '  ' }), false);
  assert.equal(declaration.validate({ post_id: 'abc', limit: 5 }), false, 'the child declares no other argument');
  assert.equal(declaration.validate({}), false);
  assert.deepEqual(declaration.normalize?.({ post_id: 'abcdef1234567890abcdefghij' }), { args: { postId: 'abcdef1234567890abcdefghij' } });
});

test('the attention tool is declared for text and voice, with its window bounds', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 60, maxGetIds: 10, maxEntityBytes: 1024, maxResultBytes: 1024 } } as unknown as ConnectionPolicy;
  const descriptor = connectorDescriptor('mattermost');
  assert.ok(descriptor);
  const declaration = descriptor.declarations(policy).find(candidate => candidate.name === 'mattermost_attention');
  assert.ok(declaration);
  assert.equal(declaration.effect, 'read');
  assert.equal(declaration.validate({}), true);
  assert.equal(declaration.validate({ days: 30, limit: 20 }), true);
  assert.equal(declaration.validate({ days: 0 }), false);
  assert.equal(declaration.validate({ days: 31 }), false);
  assert.equal(declaration.validate({ limit: 21 }), false);
  assert.equal(declaration.validate({ query: 'reply' }), false);
  assert.match(declaration.description, /do I need to reply/u);
  assert.ok(INTENT_TOOL_NAMES.includes('attention'));
  assert.equal(validateIntent('attention', {}), true);
  const plan = planIntent('attention', { days: 3 });
  assert.deepEqual(plan.calls, [{ key: '0', name: INTERNAL.chatAttention, args: { days: 3 } }]);
  assert.equal(MATTERMOST_ATTENTION.days, 7);
});

// #572: "anything urgent" was answered from relevance-ranked posts dated 2025 while the archive is
// current. A chat triage ask is the attention read over its own window, newest first.
test('#572: a chat triage ask reads what needs an answer in the window, and the old post never wins', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const dispatched: string[] = [];
  const execute = async (subs: readonly IntentSubCall[]): Promise<IntentSubResult[]> => Promise.all(subs.map(async call => {
    dispatched.push(call.name);
    if (call.name !== INTERNAL.chatAttention) return { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 };
    const result = await r.attention({ days: Number(call.args['days']) });
    const projected = projectMattermostResult(f.adapter, result);
    const text = projected.ok ? projected.projection.text : '';
    return { key: call.key, name: call.name, ok: projected.ok, text, originalCharacters: text.length, omittedCharacters: 0 };
  }));
  const deps: ResearchDeps = {
    now: () => Date.now(), configured: ['mail', 'chat', 'calendar'], execute, emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'anything urgent came in?' }, new AbortController().signal);
  assert.ok(dispatched.includes(INTERNAL.chatAttention), 'the triage read is the attention digest, never a relevance search');
  const findings = JSON.stringify(reply['findings'] ?? []);
  assert.ok(findings.includes('can you confirm the 3k release'), 'the fresh post is in the answer');
  assert.ok(!findings.includes('did you see this last week'), 'the ten-day-old post is outside the window');
});

// #572: an empty triage window is a window, never a bare "nothing urgent".
test('#572: an empty chat triage names the window it read', async () => {
  const deps: ResearchDeps = {
    now: () => 0, configured: ['mail', 'chat', 'calendar'],
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => ({ key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0 })),
    emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'anything urgent came in?' }, new AbortController().signal);
  assert.match(String(reply['note']), /I searched your team chat in the last 7 days and found nothing matching\./u);
});
