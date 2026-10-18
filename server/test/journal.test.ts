import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { attachHostLogSink, hostLogEvent } from '../tools/host-events.js';
import {
  capJournalText, configureDebugJournal, currentDebugJournal, DebugJournal, JOURNAL_RESULT_LIMIT, journalRecord, resetDebugJournal,
} from '../host/journal.js';
import { safeEvent } from '../host/log.js';
import { randomUUID } from 'node:crypto';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { openMemoryFixture } from './memory-context-process.js';
import { openFixture, result } from './chat-process.js';
import { loadLiveConfig } from '../config/live.js';
import { ChatService } from '../chat/index.js';
import { composeMcpRuntime } from '../host/mcp.js';
import { toolsMigrations } from '../tools/index.js';
import type { LiveAuthority } from '../tools/types.js';
import { fixture, options } from './live-voice-fixture.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile } from '../live/index.js';
import { chatMigrations } from '../chat/index.js';
import type { ModelPort, ModelRequest } from '../adapters/model/types.js';

// Synthetic fixtures only. This suite never touches the owner's own data directory: every journal
// it writes lives under a fresh mkdtemp directory and the installed journal is reset afterwards.

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY_LENGTH = 86_400_000;
const dayName = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const tempDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const records = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

test('one 0600 jsonl file per session under a 0700 day directory', t => {
  const dir = tempDir(t);
  const journal = new DebugJournal(dir, { now: () => NOW });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-1', event: 'session_start', provider: 'gemini', instructions: 'Synthetic instructions' });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-1', event: 'session_end', code: 'closed', by: 'ended' });

  const dayDirectory = join(dir, 'debug', dayName(NOW));
  const path = join(dayDirectory, 'live-live-synthetic-1.jsonl');
  assert.equal(existsSync(path), true, 'the session file exists');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the file is owner read/write only');
  assert.equal(statSync(dayDirectory).mode & 0o077, 0, 'the day directory admits no group or other');
  assert.equal(statSync(join(dir, 'debug')).mode & 0o077, 0, 'the journal root admits no group or other');

  const lines = records(path);
  assert.deepEqual(lines.map(line => line['event']), ['session_start', 'session_end']);
  assert.equal(lines[0]!['kind'], 'live');
  assert.equal(lines[0]!['sessionId'], 'live-synthetic-1');
  assert.equal(lines[0]!['mono'], 0, 'the first record is the session baseline');
  assert.equal(lines[1]!['mono'], 0, 'a same-instant record carries the same offset');
  assert.equal(typeof lines[0]!['t'], 'string');
});

test('a session end carries the terminal code and who ended it', t => {
  const dir = tempDir(t);
  const journal = new DebugJournal(dir, { now: () => NOW });
  journal.write({ kind: 'chat', sessionId: 'chat-synthetic-1', event: 'session_start', instructions: 'Synthetic' });
  journal.write({ kind: 'chat', sessionId: 'chat-synthetic-1', event: 'session_end', code: 'deadline', by: 'host' });
  const lines = records(join(dir, 'debug', dayName(NOW), 'chat-chat-synthetic-1.jsonl'));
  assert.deepEqual({ code: lines[1]!['code'], by: lines[1]!['by'] }, { code: 'deadline', by: 'host' });
});

test('records rotate into the day directory of their own timestamp', t => {
  const dir = tempDir(t);
  let now = NOW;
  const journal = new DebugJournal(dir, { now: () => now });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-2', event: 'session_start', instructions: 'one' });
  now = NOW + DAY_LENGTH;
  journal.write({ kind: 'live', sessionId: 'live-synthetic-2', event: 'session_end', code: 'closed', by: 'ended' });
  const days = readdirSync(join(dir, 'debug')).sort();
  assert.deepEqual(days, [dayName(NOW), dayName(NOW + DAY_LENGTH)]);
  assert.equal(records(join(dir, 'debug', days[0]!, 'live-live-synthetic-2.jsonl')).length, 1);
  assert.equal(records(join(dir, 'debug', days[1]!, 'live-live-synthetic-2.jsonl')).length, 1);
});

test('retention keeps 30 days and drops the oldest day once past the cap', t => {
  const dir = tempDir(t);
  const oldDay = join(dir, 'debug', dayName(NOW - 31 * DAY_LENGTH));
  mkdirSync(oldDay, { recursive: true, mode: 0o700 });
  const stale = join(oldDay, 'live-live-stale.jsonl');
  const fd = openSync(stale, 'w', 0o600);
  writeSync(fd, `${JSON.stringify({ t: new Date(NOW - 31 * DAY_LENGTH).toISOString(), event: 'session_start' })}\n`);
  closeSync(fd);
  // Pruning runs at start: a day past the window is gone before the first new record.
  new DebugJournal(dir, { now: () => NOW });
  assert.equal(existsSync(oldDay), false, 'a day past 30 days is pruned at start');

  // The byte cap deletes the oldest remaining day first.
  let now = NOW;
  const capped = new DebugJournal(dir, { now: () => now, maxBytes: 200 });
  capped.write({ kind: 'live', sessionId: 'live-synthetic-3', event: 'session_start', instructions: 'x'.repeat(150) });
  now = NOW + DAY_LENGTH;
  capped.write({ kind: 'live', sessionId: 'live-synthetic-4', event: 'session_start', instructions: 'y'.repeat(150) });
  const days = readdirSync(join(dir, 'debug')).sort();
  assert.deepEqual(days, [dayName(NOW + DAY_LENGTH)], 'the older day is deleted when the cap is exceeded');
});

test('a journal write failure never throws and is counted in host.log', t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const dir = tempDir(t);
  // A regular file where the journal directory must be: every directory write fails.
  const fd = openSync(join(dir, 'debug'), 'w', 0o600);
  closeSync(fd);
  const journal = new DebugJournal(dir, { now: () => NOW });
  assert.doesNotThrow(() => journal.write({ kind: 'live', sessionId: 'live-synthetic-5', event: 'session_start', instructions: 'x' }));
  assert.doesNotThrow(() => journal.write({ kind: 'live', sessionId: 'live-synthetic-5', event: 'transcript', speaker: 'owner', text: 'x' }));
  assert.equal(journal.failures > 0, true, 'every failure is counted');
  const counted = receipts.filter(receipt => receipt['event'] === 'debug_journal_error');
  assert.equal(counted.length >= 1, true, 'the failure reaches host.log');
  // The host log keeps only the closed shape: the stage code, never a path or a message.
  assert.deepEqual(safeEvent({ event: 'debug_journal_error', code: 'write' }), { event: 'debug_journal_error', code: 'write' });
  assert.equal(safeEvent({ event: 'debug_journal_error', code: 'write', path: '/tmp/x' }), undefined);
  assert.equal(safeEvent({ event: 'debug_journal_error', code: 'unknown_stage' }), undefined);
});

test('tool results are redacted and capped, and instructions are logged once per session', t => {
  const dir = tempDir(t);
  const journal = new DebugJournal(dir, { now: () => NOW });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-6', event: 'session_start', instructions: 'Synthetic instructions' });
  // The composed instructions are the same large block on every create path; only the first is kept.
  journal.write({ kind: 'live', sessionId: 'live-synthetic-6', event: 'session_start', instructions: 'Synthetic instructions, again' });
  const huge = `password=hunter2 ${'z'.repeat(JOURNAL_RESULT_LIMIT * 2)}`;
  journal.write({ kind: 'live', sessionId: 'live-synthetic-6', event: 'tool', tool: 'calendar_window', args: { kind: 'today' }, ms: 12, outcome: 'completed', resultChars: huge.length, result: huge });

  const lines = records(join(dir, 'debug', dayName(NOW), 'live-live-synthetic-6.jsonl'));
  assert.equal(lines.filter(line => line['event'] === 'session_start').length, 1, 'the instructions are written once');
  assert.equal(lines[0]!['instructions'], 'Synthetic instructions');
  const tool = lines.find(line => line['event'] === 'tool')!;
  assert.equal(String(tool['result']).includes('hunter2'), false, 'a keyed secret never reaches the journal');
  assert.equal(String(tool['result']).includes('[redacted]'), true);
  assert.equal(String(tool['result']).length < huge.length, true, 'the result text is capped');
  assert.equal(String(tool['result']).includes('[truncated'), true, 'the cut is marked');
  assert.deepEqual(tool['args'], { kind: 'today' }, 'the full arguments are kept');
  assert.equal(tool['ms'], 12);
  assert.equal(tool['outcome'], 'completed');
});

test('capJournalText keeps short text and marks a cut', () => {
  assert.equal(capJournalText('short'), 'short');
  const capped = capJournalText('x'.repeat(JOURNAL_RESULT_LIMIT + 5));
  assert.equal(capped.startsWith('x'.repeat(JOURNAL_RESULT_LIMIT)), true);
  assert.equal(capped.endsWith('[truncated 5 chars]'), true);
});

test('an out-of-vocabulary record is dropped without a receipt', t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const dir = tempDir(t);
  const journal = new DebugJournal(dir, { now: () => NOW });
  journal.write({ kind: 'live', sessionId: '../escape', event: 'session_start' });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-7', event: 'Not An Event' });
  assert.equal(journal.failures, 0);
  assert.deepEqual(receipts, []);
  assert.deepEqual(existsSync(join(dir, 'debug', dayName(NOW))) ? readdirSync(join(dir, 'debug', dayName(NOW))) : [], []);
});

test('a chat session journals its instructions, both transcripts, its model round and its end', async t => {
  const dir = tempDir(t);
  resetDebugJournal();
  // The day directory is read under dayName(NOW), so the journal must be on the same clock as the fixture.
  configureDebugJournal(dir, true, { now: () => NOW });
  t.after(resetDebugJournal);
  const work: (() => void)[] = [];
  const requests: ModelRequest[] = [];
  const f = openMemoryFixture(dir, {
    generate: async request => {
      requests.push(request);
      return {
        status: 'complete', text: 'Synthetic chat answer', reason: 'synthetic',
        providerContent: { role: 'model', parts: [{ text: 'Synthetic chat answer' }] },
        prompt: { version: request.promptVersion, hash: 'synthetic', omittedContextIds: [] },
        timings: { kind: 'measured', totalMs: 40, firstTextMs: 12 },
      };
    },
  }, { schedule: task => work.push(task), now: () => NOW }, chatMigrations);
  const conversation = f.enroll();
  const run = f.chat.accept({ sessionId: conversation.id, text: 'Synthetic owner question', idempotencyKey: 'journal' }, f.context);
  const stream = f.chat.subscribe(run.runId, f.context);
  const finished = (async () => { for await (const event of stream) { if (event.type === 'snapshot' && event.run.state === 'terminal') return; } })();
  work.shift()!();
  await finished;

  const path = join(dir, 'debug', dayName(NOW), `chat-${run.runId}.jsonl`);
  assert.equal(existsSync(path), true, 'a chat run writes its own journal file');
  const lines = records(path);
  const start = lines.find(line => line['event'] === 'session_start')!;
  assert.equal(start['provider'], 'synthetic');
  assert.equal(String(start['instructions']).length > 0, true, 'the composed instructions are kept');
  assert.equal(start['instructionChars'], String(start['instructions']).length);
  const transcript = lines.filter(line => line['event'] === 'transcript');
  assert.deepEqual(transcript.map(line => line['speaker']), ['owner', 'model']);
  assert.equal(transcript[0]!['text'], 'Synthetic owner question');
  assert.equal(transcript[1]!['text'], 'Synthetic chat answer');
  const round = lines.find(line => line['event'] === 'model_round')!;
  assert.equal(round['responseMs'], 40);
  assert.equal(round['requestMs'], 12);
  assert.equal(round['stopReason'], 'complete');
  assert.equal(lines.find(line => line['event'] === 'session_end')!['code'], 'complete');
  assert.equal(requests.length, 1);
});

test('a live session journals its instructions, provider ack, transcripts and its end', async t => {
  const dir = tempDir(t);
  resetDebugJournal();
  // The day directory is read under dayName(NOW), so the journal must be on the same clock as the fixture.
  configureDebugJournal(dir, true, { now: () => NOW });
  t.after(resetDebugJournal);
  const work: (() => void)[] = [];
  const f = openMemoryFixture(dir, {
    generate: async request => ({
      status: 'complete', text: 'Synthetic', reason: 'synthetic',
      providerContent: { role: 'model', parts: [{ text: 'Synthetic' }] },
      prompt: { version: request.promptVersion, hash: 'synthetic', omittedContextIds: [] },
      timings: { kind: 'measured', totalMs: 1, firstTextMs: 1 },
    }),
  }, { schedule: task => work.push(task) }, [...chatMigrations, ...liveMigrations]);
  const ws = await fixture(t);
  const profile = validateLiveProfile({
    enabled: true, provider: 'gemini', liveModelId: 'models/live-session-test', voice: 'Aoede', keyReference: 'fixture-key',
    route: { enabled: true, provider: 'gemini', modelId: 'models/live-session-test', dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic live instructions', dataClass: 'ordinary' },
  });
  const adapter = new GeminiLiveVoiceAdapter(options({ socketFactory: ws.socketFactory, modelId: profile.liveModelId,
    voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: ['ordinary'] } }));
  // Every timer is parked: the session's own deadlines never fire in this test.
  const schedule = (callback: () => void) => {
    work.push(callback);
    return { unref(): void { /* parked */ }, cancel(): void { /* parked */ } };
  };
  const owner = createLiveSessionOwner({
    store: f.store, profile, now: () => NOW, schedule,
    voice: { capabilities: adapter.capabilities, open: (request, control) => adapter.open(request, control) },
  });
  owner.recover();
  const ctx = { clientId: f.context.clientId, auditId: 'journal', authorityEpoch: f.store.authorityEpoch };
  const accepted = owner.create({ idempotencyKey: 'journal-live', inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: accepted.liveSessionId }, ctx);
  await ws.frame(1);
  ws.send({ setupComplete: {} });
  await attachment.ready;
  // Both sides of the conversation, as the provider reports them.
  ws.send({ serverContent: { inputTranscription: { text: 'Synthetic owner speech', finished: true } } });
  ws.send({ serverContent: { outputTranscription: { text: 'Synthetic model speech' } } });
  ws.send({ serverContent: { turnComplete: true } });
  for (let i = 0; i < 40; i++) await tick();
  attachment.close();

  const path = join(dir, 'debug', dayName(NOW), `live-${accepted.liveSessionId}.jsonl`);
  assert.equal(existsSync(path), true, 'a live session writes its own journal file');
  for (let i = 0; i < 100 && !records(path).some(line => line['event'] === 'session_end'); i++) await tick();
  const lines = records(path);
  const start = lines.find(line => line['event'] === 'session_start')!;
  assert.equal(start['provider'], 'gemini');
  assert.equal(start['voice'], 'Aoede');
  assert.equal(String(start['instructions']).includes('Synthetic live instructions'), true, 'the full composed instructions are kept');
  assert.equal(typeof start['build'], 'string');
  assert.equal(lines.filter(line => line['event'] === 'session_start').length, 1, 'the instructions are written once');
  const ack = lines.find(line => line['event'] === 'provider_setup' && line['stage'] === 'ready');
  assert.equal(ack !== undefined, true, 'the provider ack is journaled');
  assert.equal(typeof ack!['responseMs'], 'number');
  const transcript = lines.filter(line => line['event'] === 'transcript');
  assert.equal(transcript.some(line => line['speaker'] === 'owner' && line['text'] === 'Synthetic owner speech'), true);
  assert.equal(transcript.some(line => line['speaker'] === 'model' && line['text'] === 'Synthetic model speech'), true);
  assert.equal(lines.some(line => line['event'] === 'turn_start' && line['speaker'] === 'owner'), true);
  assert.equal(lines.some(line => line['event'] === 'turn_end' && line['speaker'] === 'model'), true);
  const end = lines.find(line => line['event'] === 'session_end')!;
  assert.equal(typeof end['code'], 'string');
  assert.equal(typeof end['by'], 'string');
});

test('a chat tool loop journals the call at the tools layer', async t => {
  const dir = tempDir(t);
  resetDebugJournal();
  configureDebugJournal(dir, true);
  t.after(resetDebugJournal);
  // The shape is chat-tools': a real tools owner over an in-process MCP endpoint, driven by a chat turn.
  const seen: { declarations: string[]; responses: number }[] = [];
  const toolModel: ModelPort = {
    generate: async (request: ModelRequest) => {
      seen.push({ declarations: (request.declarations ?? []).map(declaration => declaration.name), responses: request.contents.filter(content => content.parts.some(part => part.functionResponse !== undefined)).length });
      if (request.declarations?.some(declaration => declaration.name === 'search_knowledge')
        && !request.contents.some(content => content.parts.some(part => part.functionResponse !== undefined))) {
        return {
          ...result(request, 'complete', ''),
          providerContent: { role: 'model', parts: [{ functionCall: { name: 'search_knowledge', args: { query: 'synthetic question', limit: 3 }, id: randomUUID() } }] },
        };
      }
      return result(request, 'complete', 'Synthetic answer from evidence');
    },
  };
  const f = openFixture(dir, toolModel, { now: Date.now }, undefined, toolsMigrations);
  const endpoint = { id: 'journal-endpoint', url: 'https://fixture.invalid/mcp', account: 'fixture-account', resource: 'fixture-resource' };
  const sdk = new Server({ name: 'journal-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: false });
  // The endpoint's own declaration, which the connector validates the call against.
  const schema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false };
  sdk.setRequestHandler('tools/list', () => ({ tools: [{ name: 'search_knowledge', inputSchema: schema }] }) as never);
  sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: 'Synthetic knowledge result' }], structuredContent: { synthetic: true } }) as never);
  await sdk.connect(transport);
  t.after(async () => { await transport.close(); await sdk.close(); });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(request);
  });
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    schemaVersion: 1, grantMode: 'owner-trusted-reads',
    endpoints: [{ ...endpoint, connector: 'lux-knowledge', transport: 'streamable-http', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' }],
  }), { mode: 0o600 });
  let authority: ((runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>) | undefined;
  const mcp = await composeMcpRuntime({
    store: f.store, ownerId: f.store.assistantId, configDir: dir,
    lookupAuthority: async (runId, signal) => authority?.(runId, signal) ?? null, log: () => {},
  });
  t.after(async () => { await mcp.close(); });
  assert.deepEqual(mcp.connectionIds(), [endpoint.id], 'the fixture endpoint is published');
  const composition = { owner: mcp.owner, connectionIds: () => mcp.connectionIds(), registerAuthoritySource: (source: typeof authority) => { authority = source; } };
  const chat = new ChatService({ ...f.config, tools: composition });
  chat.recover(f.recoveryContext);
  // The host registers the chat's own authority lookup with the tools composition; the test does the same.
  composition.registerAuthoritySource(async (id: string, signal: AbortSignal) => signal.aborted ? null : chat.lookupAuthority(id));
  t.after(() => chat.shutdown());
  const sessionId = chat.enroll({ title: 'Synthetic tools', timeZone: 'UTC', idempotencyKey: randomUUID() }, f.context).sessionId;
  const accepted = chat.accept({ sessionId, text: 'Synthetic owner question', idempotencyKey: randomUUID() }, f.context);
  for await (const event of chat.subscribe(accepted.runId, f.context)) if (event.type === 'snapshot' && event.run.state === 'terminal') break;

  const path = join(dir, 'debug', dayName(Date.now()), `chat-${accepted.runId}.jsonl`);
  assert.equal(existsSync(path), true, 'the chat run wrote its journal file');
  const calls = records(path).filter(line => line['event'] === 'tool');
  assert.equal(calls.length, 1, `the tool call reaches the session journal from the tools layer (model saw ${JSON.stringify(seen)})`);
  assert.equal(calls[0]!['tool'], 'search_knowledge');
  assert.equal(typeof calls[0]!['ms'], 'number');
  assert.equal(typeof calls[0]!['outcome'], 'string');
  assert.deepEqual(calls[0]!['args'], { query: 'synthetic question', limit: 3 });
  assert.equal(calls[0]!['outcome'], 'completed', 'the call was authorized and executed');
});

test('the journal defaults on when live.json is absent and the file can turn it off', t => {
  const dir = tempDir(t);
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  resetDebugJournal();
  t.after(resetDebugJournal);
  // No live.json at all: the preference defaults on and the journal is installed at the data directory.
  assert.deepEqual(loadLiveConfig({ configDir, ownerId: 'synthetic-owner' }), { status: 'unconfigured' });
  assert.equal(currentDebugJournal()?.enabled, true, 'default ON with no live.json');
  assert.equal(currentDebugJournal()?.dataDir, dir, 'the journal root is the data directory');
  // An explicit false is the one thing that turns it off.
  writeFileSync(join(configDir, 'live.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'brief', debugJournal: false },
  }), { mode: 0o600 });
  const status = loadLiveConfig({ configDir, ownerId: 'synthetic-owner' });
  assert.equal(status.status, 'configured');
  assert.equal(status.status === 'configured' ? status.config.debugJournal : null, false);
  assert.equal(currentDebugJournal()?.enabled, false);
});

test('a disabled journal writes nothing and counts no failure', t => {
  const dir = tempDir(t);
  const journal = new DebugJournal(dir, { now: () => NOW, enabled: false });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-8', event: 'session_start', instructions: 'x' });
  journal.write({ kind: 'live', sessionId: 'live-synthetic-8', event: 'transcript', speaker: 'owner', text: 'x' });
  assert.equal(existsSync(join(dir, 'debug')), false, 'a disabled journal creates no directory');
  assert.equal(journal.failures, 0, 'nothing is written, so nothing fails');
});

test('a native receipt the host already received lands in the current session journal', t => {
  const dir = tempDir(t);
  resetDebugJournal();
  t.after(resetDebugJournal);
  configureDebugJournal(dir, true);
  journalRecord({ kind: 'live', sessionId: 'live-synthetic-9', event: 'session_start', instructions: 'x' });
  hostLogEvent({ event: 'native_action', action: 'open_url', code: 'opened', detail: 'https' });
  const lines = records(join(dir, 'debug', dayName(Date.now()), 'live-live-synthetic-9.jsonl'));
  const native = lines.find(line => line['event'] === 'native')!;
  assert.equal(native['name'], 'native_action');
  assert.equal(native['action'], 'open_url');
  assert.equal(native['code'], 'opened');
});
