import { TaskRuntime } from '../tasks/runtime.js';
import { Authority } from '../tasks/authority.js';
import { Store } from '../runtime/store.js';
import { taskChatReader } from './fixtures/task-chat-reader.js';
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
import { connectorDescriptor, createMattermostReader, MATTERMOST_ATTENTION, MATTERMOST_ATTENTION_BUDGET_MS, MATTERMOST_ATTENTION_TOOL, MATTERMOST_TOOLS } from '../connectors/index.js';
import type { AttentionItem, MattermostAttention } from '../connectors/index.js';
import { projectMattermostResult, renderAttention } from '../tools/mattermost.js';

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
  const calls = (): { name: string; arguments: Record<string, unknown>; at?: number }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown>; at?: number }) : [];
  return { dir, log, registry, adapter, calls, endpoint: config };
}

async function approveWithout(registry: McpRegistry, adapter: ReturnType<typeof createMcpAdapter>, toolNames: readonly string[]) {
  const discovery = await adapter.discover('mattermost');
  assert.equal(discovery.state, 'discovered');
  if (discovery.state !== 'discovered') throw new Error('discovery failed');
  registry.approve({ endpointId: 'mattermost', schemaDigest: discovery.schemaDigest, toolNames: [...toolNames], effect: 'read', account: ACCOUNT, resource: RESOURCE, generation: 1 });
  return discovery.schemaDigest;
}
async function approve(registry: McpRegistry, adapter: ReturnType<typeof createMcpAdapter>) {
  return approveWithout(registry, adapter, MATTERMOST_TOOLS);
}

function reader(adapter: ReturnType<typeof createMcpAdapter>, registry: McpRegistry, schemaDigest: string, names: readonly string[] = [...MATTERMOST_TOOLS, MATTERMOST_ATTENTION_TOOL], budgetMs?: number) {
  // #604: the registry grant holds the published child names; the approved policy names the composite.
  return createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxLimit: 50, queryChars: 200, names }, ...(budgetMs === undefined ? {} : { attentionBudgetMs: budgetMs }) });
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
    'thread dana I can take it tomorrow morning',
    'thread dana done, they line up',
    'dm dana sent you the deck for review',
    'mention dana @owner-chat can you confirm the 3k release?',
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
  // C-CHAT (L4-11): the owner's own and handle searches read the window newest first; the conversation reads add their channel.
  for (const call of search) {
    const expected = typeof call.arguments['channel'] === 'string' ? ['channel', 'from_date', 'limit', 'query', 'sort'] : ['from_date', 'limit', 'query', 'sort'];
    assert.deepEqual(Object.keys(call.arguments).sort(), expected);
  }
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
  assert.match(lines[0] ?? '', /^- \[thread\] team-release \| dana \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| I can take it tomorrow morning \| https:\/\/chat\.example\/m\/public-thread-reply$/u);
  assert.match(lines[1] ?? '', /^- \[thread\] direct-dana \| dana \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| done, they line up \| https:\/\/chat\.example\/m\/thread-open-reply$/u);
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
  // The installed child declares the day columns, not the instants, so the window travels as from_date.
  const from = typeof first?.arguments['from_date'] === 'string' ? Date.parse(first.arguments['from_date'] as string) : 0;
  assert.ok(Math.abs(from - (before - 90 * DAY)) < DAY, `default window is ninety days: ${String(first?.arguments['from_date'])}`);
  assert.equal(first?.arguments['to_date'], undefined);
  assert.equal((await r.search({ query: 'release', after: '2016-01-01T00:00:00.000Z', before: '2025-01-01T00:00:00.000Z' })).state, 'completed');
  const named = f.calls().filter(call => call.name === 'mattermost_search').at(-1);
  // #610: the day travels in the child's own date columns, and a window is read newest first.
  assert.deepEqual(named?.arguments, { query: 'release', limit: 12, from_date: '2016-01-01', to_date: '2025-01-01', sort: 'newest' });
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

// #610: the scan's independent reads run under one budget. A child that answers half a second late
// cannot fit a serial scan of its twelve children in 4 s.
test('#610: the attention scan reads its independent children concurrently', async t => {
  const f = setup('slow');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const started = Date.now();
  const view = digest(await r.attention({}));
  const elapsed = Date.now() - started;
  assert.equal(view.items.length, 4, 'the concurrent scan still finds every item');
  // Twelve serial child reads at half a second each is six seconds; three concurrent stages are two.
  assert.ok(elapsed < 4_000, `a concurrent scan finishes inside 4 s, took ${elapsed} ms`);
  const calls = f.calls();
  // C-CHAT: the conversation reads are channel searches now, read after the recency list.
  const searches = calls.filter(call => call.name === 'mattermost_search' && call.arguments['channel'] === undefined).map(call => call.at ?? 0);
  const firstHistory = calls.find(call => call.name === 'mattermost_search' && call.arguments['channel'] !== undefined)?.at ?? 0;
  assert.equal(searches.length, 2, 'both attention searches ran');
  assert.ok(searches.every(start => start > 0 && firstHistory > 0));
  // A serial scan would still be in its first search when the concurrent one has both in flight.
  assert.ok(Math.max(...searches) < firstHistory, 'both searches start before the first channel history');
});

// #610: an attention search asks for its own page, never the connector maximum.
test('#610: the attention searches ask for the attention limit', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  await r.attention({});
  const limits = f.calls().filter(call => call.name === 'mattermost_search' && call.arguments['channel'] === undefined).map(call => Number(call.arguments['limit']));
  assert.deepEqual(limits, [MATTERMOST_ATTENTION.limit, MATTERMOST_ATTENTION.limit]);
});

// #610: the child refuses a limit over its own 50, and the newest sort is a declared argument.
test('#610: a search asks for at most the child maximum and reads newest first', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  assert.equal((await r.search({ query: 'release', limit: 60 })).state, 'completed');
  const [first] = f.calls().filter(call => call.name === 'mattermost_search');
  assert.equal(first?.arguments['limit'], 50, 'a limit over the child maximum is clamped, never sent');
  assert.equal(first?.arguments['sort'], 'newest');
});

// #1016: a slow wave used to end the whole attention read with a task timeout, throwing away every wave
// that had answered. The scan now ends at its own budget and returns what it found, with the gap named.
test('#1016: a stalled child yields the waves that answered, with the missing wave named', async t => {
  const f = setup('stall-thread');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter), undefined, 2_000);
  const started = Date.now();
  const view = digest(await r.attention({}));
  const elapsed = Date.now() - started;
  // The stalled thread read answers after six seconds, so only the scan's own budget can end it here.
  assert.ok(elapsed < 3_000, `the scan ends at its budget, not at the stalled child (${elapsed} ms)`);
  assert.equal(view.sourceIncomplete, true, 'a budget end is partial, never silently complete');
  assert.match(view.missing ?? '', /no answer from threads/u, 'the coverage line names the wave that did not finish');
  // The other threads in the same wave answered: their items are kept, never dropped with the stalled one.
  assert.deepEqual(summaries(view.items), ['thread dana I can take it tomorrow morning', 'dm dana sent you the deck for review', 'mention dana @owner-chat can you confirm the 3k release?'], 'the waves that answered are kept');
  const rendered = renderAttention(view);
  assert.match(rendered.text, /^note: .*no answer from threads/u, 'the model reads the coverage line before the items');
});

// A budget end inside a wave must keep the siblings that answered there, not just the earlier waves.
test('#1016: a stalled conversation keeps the history that answered in the same wave', async t => {
  const f = setup('stall-dm');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter), undefined, 2_000);
  const started = Date.now();
  const view = digest(await r.attention({}));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `the scan ends at its budget, not at the stalled history (${elapsed} ms)`);
  assert.equal(view.sourceIncomplete, true, 'a budget end is partial, never silently complete');
  assert.match(view.missing ?? '', /no answer from moved_conversations/u, 'the coverage line names the stalled wave');
  assert.deepEqual(summaries(view.items), ['dm ravi sent the retest notes', 'mention dana @owner-chat can you confirm the 3k release?'], 'the history that answered is kept');
});

// The identity read is a child call too: the budget is armed before it, so a slow whoami ends the scan
// there, named and partial, instead of running the waves past the task's read stop.
test('#1016: an identity read that spends the budget ends the scan, named', async t => {
  const f = setup('slow-identity');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter), undefined, 1_000);
  const started = Date.now();
  const view = digest(await r.attention({}));
  const elapsed = Date.now() - started;
  // The identity read answers after two seconds, against a 1,000 ms budget and the child's own 5 s stop.
  assert.ok(elapsed < 3_000, `the scan ends at its budget, not after the waves (${elapsed} ms)`);
  assert.equal(view.sourceIncomplete, true, 'a spent budget is partial, never silently complete');
  assert.match(view.missing ?? '', /no answer from the identity read/u, 'the coverage line names the identity read');
  assert.deepEqual(view.items, [], 'no wave ran once the budget was spent');
  assert.deepEqual(f.calls().filter(call => call.name === 'mattermost_search'), [], 'no wave child call follows a spent budget');
});

// The budget must end the scan before the task layer stops the read, or the evidence is thrown away again.
test('#1016: the attention budget ends the scan below the task read stop', () => {
  assert.equal(MATTERMOST_ATTENTION_BUDGET_MS, 10_000, 'the shipped budget');
  // server/tasks/worker.ts stops a connector read after 12 s (CONNECTOR_DEADLINE_MS).
  assert.ok(MATTERMOST_ATTENTION_BUDGET_MS < 12_000, 'the scan ends before the read stop');
});

// Owner rule: direct and group conversations only, never the whole channel list.
test('#1016: attention reads one direct and group page, never the whole channel list', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  await r.attention({});
  const lists = f.calls().filter(call => call.name === 'mattermost_list_channels');
  assert.equal(lists.length, 1, 'one filtered page, never an unfiltered list');
  assert.deepEqual(lists[0]?.arguments, { types: ['D', 'G'], sort: 'recent', limit: MATTERMOST_ATTENTION.maxDmChannels });
});

// A budget end is partial; a child that fails is a failure, and the two are never confused.
test('#1016: a failing child is still a failure, never a partial digest', async t => {
  const f = setup('error-mentions');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const result = await r.attention({});
  assert.notEqual(result.state, 'completed', 'an upstream failure stays a failure');
  assert.equal('decodedResult' in result ? (result.decodedResult as { items?: unknown }).items : undefined, undefined, 'no digest stands in for a failure');
});

// #604: a fixture that does not publish the thread read leaves the composite ungranted, and the
// caller hears the connector's own closed reason instead of an unknown tool.
test('#604: an ungranted composite refuses with tool-not-granted', async t => {
  const f = setup('no-thread');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const digestValue = await approveWithout(f.registry, f.adapter, MATTERMOST_TOOLS.filter(name => name !== 'mattermost_get_thread'));
  // The child publishes four reads, and the policy names the same four: the composite has no grant.
  const names = MATTERMOST_TOOLS.filter(name => name !== 'mattermost_get_thread');
  const r = reader(f.adapter, f.registry, digestValue, [...names]);
  const result = await r.attention({});
  assert.equal(result.state === 'refused' ? result.reason : result.state, 'tool-not-granted');
  assert.ok(!f.calls().some(call => call.name === 'mattermost_search'), 'no child read follows an ungranted composite');
});

test('R29 the helper selects native attention explicitly and keeps its real SDK composition', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const task = taskChatReader(f.adapter, f.registry, { ...f.endpoint, credentialRef: null }, await approve(f.registry, f.adapter), [...MATTERMOST_TOOLS]);
  const result = await task.call('chat_attention', { days: 7, limit: 5 });
  assert.notEqual(result.status, 'failed', JSON.stringify(result));
  assert.ok(result.text);
  assert.equal(task.tools.get('chat_attention')?.outside_text, true);
  assert.ok(f.calls().some(call => call.name === 'mattermost_search'));
  assert.equal(f.calls().some(call => call.name === 'mattermost_attention'), false, 'the existing native reader composes the digest, never a fictional child API');
});

test('R29 attention without its accepted composite grant fails before SDK IO', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const task = taskChatReader(f.adapter, f.registry, { ...f.endpoint, credentialRef: null }, await approve(f.registry, f.adapter), [...MATTERMOST_TOOLS], []);
  const before = f.calls().length;
  assert.equal((await task.call('chat_attention', { days: 7 })).status, 'failed');
  assert.equal(f.calls().length, before);
});

test('R29 attention rejects an invalid native window before SDK IO', async t => {
  const f = setup('window');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const task = taskChatReader(f.adapter, f.registry, { ...f.endpoint, credentialRef: null }, await approve(f.registry, f.adapter), [...MATTERMOST_TOOLS]);
  const before = f.calls().length;
  assert.equal((await task.call('chat_attention', { days: 31 })).status, 'failed');
  assert.equal(f.calls().length, before);
});


test('R29 an actual native attention read advances task exposure, while invalid arguments do not', async t => {
  const f = setup('window');
  const task = taskChatReader(f.adapter, f.registry, { ...f.endpoint, credentialRef: null }, await approve(f.registry, f.adapter), [...MATTERMOST_TOOLS]);
  const store = new Store(join(f.dir, 'task-state'));
  const runtime = new TaskRuntime({ store, execute: task.execute, authority: new Authority({ checkEffect: async () => false, log: () => {}, journal: store.taskEffectJournal() }),
    infer: async () => { throw Error('No inference in an explicit read fixture'); }, delivery: { attach: () => {}, progress: () => {}, deliver: () => {}, closed: () => {} },
  });
  t.after(async () => { runtime.close(); store.close(); await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const revision = runtime.begin('Read what is waiting for me', 1, 1);
  const invalid = await runtime.runTool('chat_attention', { days: 31, limit: null }, { ...revision.identity, operation_id: 'invalid' }, new AbortController().signal);
  assert.equal(invalid.status, 'failed');
  assert.deepEqual(runtime.taskContext(revision.identity.task_id)?.exposures, []);
  const result = await runtime.runTool('chat_attention', { days: 7, limit: 5 }, { ...revision.identity, operation_id: 'native-read' }, new AbortController().signal);
  assert.notEqual(result.status, 'failed', JSON.stringify(result));
  assert.ok(runtime.taskContext(revision.identity.task_id)?.exposures.includes('company'));
});
