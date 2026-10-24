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
import { connectorDescriptor, createMattermostReader, MATTERMOST_ATTENTION, MATTERMOST_ATTENTION_TOOL, MATTERMOST_TOOLS } from '../connectors/index.js';
import type { AttentionItem, MattermostAttention } from '../connectors/index.js';
import { projectMattermostResult, renderAttention } from '../tools/mattermost.js';
import { INTENT_TOOL_NAMES, INTERNAL, planIntent, validateIntent } from '../tools/intent.js';
import { RESEARCH, ResearchLedger, runResearch, type ResearchDeps, type ResearchSourceLog } from '../tools/research.js';
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
  const calls = (): { name: string; arguments: Record<string, unknown>; at?: number }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown>; at?: number }) : [];
  return { dir, log, registry, adapter, calls };
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

function reader(adapter: ReturnType<typeof createMcpAdapter>, registry: McpRegistry, schemaDigest: string, names: readonly string[] = [...MATTERMOST_TOOLS, MATTERMOST_ATTENTION_TOOL]) {
  // #604: the registry grant holds the published child names; the approved policy names the composite.
  return createMattermostReader({ port: adapter, registry, config: { endpointId: 'mattermost', account: ACCOUNT, resource: RESOURCE, schemaDigest, generation: 1, maxLimit: 50, queryChars: 200, names } });
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
    'mention dana @robert can you confirm the 3k release?',
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

// #610: the scan's independent reads run under one budget. A child that answers a second late
// cannot fit a serial scan of its twelve children in 8 s.
test('#610: the attention scan reads its independent children concurrently', async t => {
  const f = setup('slow');
  t.after(async () => { await f.adapter.close(); rmSync(f.dir, { recursive: true, force: true }); });
  const r = reader(f.adapter, f.registry, await approve(f.registry, f.adapter));
  const started = Date.now();
  const view = digest(await r.attention({}));
  const elapsed = Date.now() - started;
  assert.equal(view.items.length, 4, 'the concurrent scan still finds every item');
  // Twelve serial child reads at a second each is twelve seconds; three concurrent stages are four.
  assert.ok(elapsed < 8_000, `a concurrent scan finishes inside 8 s, took ${elapsed} ms`);
  const calls = f.calls();
  const searches = calls.filter(call => call.name === 'mattermost_search').map(call => call.at ?? 0);
  const firstHistory = calls.find(call => call.name === 'mattermost_get_channel_history')?.at ?? 0;
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
  const limits = f.calls().filter(call => call.name === 'mattermost_search').map(call => Number(call.arguments['limit']));
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

// #610: a channel named in the question is the connector's own filter, not a broader archive search.
test('#610: a question that names a channel searches that channel only', async () => {
  const planned: { name: string; args: Record<string, unknown> }[] = [];
  const deps: ResearchDeps = {
    now: () => Date.now(), configured: ['mail', 'chat', 'calendar'],
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => {
      planned.push({ name: call.name, args: call.args as Record<string, unknown> });
      return { key: call.key, name: call.name, ok: true, text: 'a line', originalCharacters: 6, omittedCharacters: 0 };
    }),
    emit: () => {}, log: () => {}, ledger: new ResearchLedger(),
  };
  await runResearch(deps, { action: 'start', question: 'latest topics in the dogcation channel' }, new AbortController().signal);
  const search = planned.find(call => call.name === INTERNAL.chatSearch);
  assert.ok(search, 'the chat read is a search');
  assert.equal(search.args['channel'], 'dogcation');
  assert.equal(planned.some(call => call.name === INTERNAL.chatAttention), false, 'a channel ask is not the whole-account scan');
});

// #610: the chat receipt carries the query's shape, never its words.
test('#610: the chat research_source line carries the query shape and no query text', async () => {
  const logged: Record<string, unknown>[] = [];
  const deps: ResearchDeps = {
    now: () => Date.now(), configured: ['mail', 'chat', 'calendar'],
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => ({ key: call.key, name: call.name, ok: true, text: 'a line', originalCharacters: 6, omittedCharacters: 0 })),
    emit: () => {},
    log: () => {},
    logSource: (event: ResearchSourceLog) => { logged.push(event as unknown as Record<string, unknown>); },
    ledger: new ResearchLedger(),
  };
  await runResearch(deps, { action: 'start', question: 'latest topics in the dogcation channel' }, new AbortController().signal);
  const receipt = logged.find(event => event['event'] === 'research_source' && event['source'] === 'chat');
  assert.ok(receipt, 'the chat read is receipted');
  const shape = receipt['chat'] as { terms: number; operators: string[]; limit: number; sort: string } | undefined;
  assert.ok(shape, 'the receipt carries a chat query shape');
  assert.ok(Number.isSafeInteger(shape.terms) && shape.terms > 0, 'the receipt reports a word count');
  assert.deepEqual(shape.operators, []);
  assert.equal(shape.limit, RESEARCH.chatLines);
  assert.equal(shape.sort, 'newest');
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes('dogcation'), 'no query word reaches the receipt');
  assert.ok(!serialized.includes('latest'), 'no query word reaches the receipt');
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
