import { createHash, randomUUID } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { composeLive, resolveLiveMemory } from '../host/live.js';
import { captureHostDiagnostics, HostLog, safeEvent } from '../host/log.js';
import { attachHostLogSink } from '../tools/host-events.js';
// Side-effect import: register the intent-tool suite in this process so a declared check runs it
// (live-session is in the contract scope; the check scripts are not).
import './intent-tools.test.js';
// Side-effect import: register the research-loop suite in this process so a declared check runs it.
import './research.test.js';
// Side-effect import: register the host-log allowlist suite in the declared live-session check (F7).
import './host-log.test.js';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { declarationsFor, runToolCalls } from '../tools/declarations.js';
import { shapeGcalCalendars, shapeGcalList, shapeGmailList } from '../tools/live-shape.js';
import { LiveToolJobs, type ToolJob, type ToolJobResult, type JobTimer } from '../tools/jobs.js';
import type { LiveAuthority } from '../tools/types.js';
import { liveProfileIdentity } from '../live/config.js';
import type { ToolDefinition, HostContext } from '../adapters/model/types.js';
import { PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, LIVE_INSTRUCTION_TARGET_CHARS } from '../prompt/index.js';
import * as summaries from '../domain/summaries.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLiveConfig, liveSetupLanguage } from '../config/live.js';
import { NAYA_LIVE_BASE, NAYA_TOOLS, MEMORY_SECTION_CHAR_LIMIT, LIVE_INSTRUCTION_HARD_LIMIT, LIVE_RECOVERY_PICKUP, composeLiveInstruction, composeLiveSessionInstruction } from '../prompt/live-persona.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions, LiveVoiceLimits, LiveVoicePort, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import type { Transaction } from '../contracts/storage.js';
import { createLiveSessionOwner, feedJobs, LiveConfigError, LiveError, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import { CANARY, control, deferred, fixture, options, pcm } from './live-voice-fixture.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
import { CONNECTOR_DESCRIPTORS, MATTERMOST_TOOLS } from '../connectors/index.js';
import { buildRuntimeContext } from '../prompt/index.js';

const MODEL = 'models/live-session-test';
const NOW = 1_700_000_000_000;
const context = (store: Store): LiveContext => ({ clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// Drive an injected scheduler until a condition holds: the owner schedules its backoff between
// microtasks, so a single advance can otherwise run before the timer exists.
async function advanceUntil(advance: (ms: number) => void, scheduler: DeadlineClock, condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) { advance(1000); scheduler.runDue(); await new Promise<void>(resolve => setImmediate(resolve)); }
  assert.ok(condition(), 'the expected connection did not open');
}
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } });

/** Wrap a store so one exact SQL write fails, proving the failure path without breaking reads. */
function writeFailingStore(store: Store, marker: string): Store {
  const original = store.transaction.bind(store);
  const wrapped = (callback: Parameters<Store['transaction']>[0]) => original(tx => callback(new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'run') return (sql: string, ...args: unknown[]) => {
        if (typeof sql === 'string' && sql.includes(marker)) throw new Error('synthetic_write_failure');
        return (value as (...a: unknown[]) => unknown).call(target, sql, ...args);
      };
      // Bind every other tx method to the real target so SQLite private fields still resolve.
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  })));
  store.transaction = wrapped as unknown as typeof store.transaction;
  return store;
}

function profileInput(limits?: Record<string, number>, model = MODEL, provider: 'gemini' | 'openai' = 'gemini') {
  return {
    provider, liveModelId: model, voice: 'ExplicitVoice',
    keyReference: provider === 'openai' ? 'openai-primary' : 'test-reference',
    route: { enabled: true, provider, modelId: model, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    ...(limits ? { limits } : {}),
  };
}

interface Harness {
  requests: LiveVoiceRequest[];
  f: Awaited<ReturnType<typeof fixture>>;
  store: Store;
  owner: LiveSessionOwner;
  ctx: LiveContext;
  dir: string;
  calls: { name: string; args: unknown }[];
  readonly memorySelections: number;
  advance(ms: number): void;
}

async function harness(t: TestContext, overrides: {
  limits?: Record<string, number>;
  adapterLimits?: Partial<LiveVoiceLimits>;
  socketFactory?: NonNullable<LiveVoiceAdapterOptions['socketFactory']>;
  port?: LiveVoicePort;
  credentials?: { resolve(reference: string): Promise<string | undefined> };
  model?: string;
  provider?: 'gemini' | 'openai';
  tools?: boolean;
  mattermost?: boolean;
  calendar?: boolean;
  beforeTool?: () => Promise<void>;
  beforeGate?: () => Promise<void>;
  toolError?: boolean;
  scheduler?: DeadlineClock;
  system?: string;
  language?: string;
  acceptedPrompt?: (ownerId: string) => NonNullable<ReturnType<typeof validateLiveProfile>['acceptedPrompt']>;
  routeClasses?: readonly ('ordinary' | 'private' | 'sensitive')[];
  overlay?: { schemaVersion: 1; text: string; accent?: string };
  onSessionTerminal?: (liveSessionId: string) => void;
  memoryFailure?: boolean;
  failingWrite?: string;
} = {}): Promise<Harness> {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-session-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations, ...(overrides.tools ? toolsMigrations : [])]);
  if (overrides.failingWrite) writeFailingStore(store, overrides.failingWrite);
  let clock = NOW;
  let memorySelections = 0;
  const initialProfile = profileInput({ handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50, ...Object.fromEntries(Object.entries(overrides.adapterLimits ?? {}).filter(([key]) => ['handshakeMs', 'idleMs', 'sessionMs', 'closeMs'].includes(key))), ...overrides.limits }, overrides.model, overrides.provider);
  const profile = validateLiveProfile({ ...initialProfile,
    ...(overrides.routeClasses ? { route: { ...initialProfile.route, dataClasses: overrides.routeClasses } } : {}),
    ...(overrides.overlay ? { overlay: overrides.overlay } : {}), ...(overrides.system !== undefined ? { prompt: { text: overrides.system, dataClass: 'ordinary' } } : {}),
    ...(overrides.language !== undefined ? { language: overrides.language } : {}),
    ...(overrides.acceptedPrompt ? { acceptedPrompt: overrides.acceptedPrompt(store.assistantId) } : {}) });
  const voice = overrides.port ?? new GeminiLiveVoiceAdapter(options({
    socketFactory: overrides.socketFactory ?? f.socketFactory, modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: overrides.credentials ?? { resolve: async () => CANARY },
    limits: { handshakeMs: 1000, idleMs: 2000, sessionMs: 4000, closeMs: 50, ...overrides.adapterLimits },
  }));
  const calls: { name: string; args: unknown }[] = [];
  const requests: LiveVoiceRequest[] = [];
  const open = voice.open.bind(voice);
  t.mock.method(voice, 'open', (input: LiveVoiceRequest, ctl: Parameters<typeof voice.open>[1]) => {
    if (input.resumptionHandle) {
      assert.equal(store.transaction(tx => tx.get("SELECT resumption_handle FROM live_sessions WHERE lifecycle='active'"))?.resumption_handle === input.resumptionHandle, true, 'handle is durable before open');
      assert.ok(ctl.limits!.handshakeMs! <= profile.limits.handshakeMs, 'profile handshake override reaches resumed setup');
    }
    requests.push(structuredClone(input)); return open(input, ctl);
  });
  let owner!: LiveSessionOwner;
  let tools: import('../live/types.js').LiveToolsComposition | undefined;
  if (overrides.tools) {
    const schemas = [
      { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } },
      { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
    ];
    const registry = new McpRegistry();
    const endpoint = { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'account', resource: 'resource' };
    registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
    const sdk = new Server({ name: 'live-tools-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(schemas) }) as never);
    sdk.setRequestHandler('tools/call', async req => {
      calls.push({ name: req.params.name, args: req.params.arguments });
      await overrides.beforeTool?.();
      return { content: [{ type: 'text', text: '#123: Synthetic insight\n[Evidence](https://example.test/evidence)' }], ...(overrides.toolError ? { isError: true } : {}) };
    });
    await sdk.connect(transport);
    let mattermostEndpoint: { id: string; url: string; account: string; resource: string } | undefined;
    let mattermostSdk: Server | undefined;
    let mattermostTransport: WebStandardStreamableHTTPServerTransport | undefined;
    const mattermostSchemas = MATTERMOST_TOOLS.map(name => ({ name, inputSchema: { type: 'object' } }));
    if (overrides.mattermost) {
      mattermostEndpoint = { id: 'mattermost', url: 'https://fixture.invalid/mattermost', account: 'account', resource: 'resource' };
      registry.register(mattermostEndpoint); registry.enable(mattermostEndpoint.id); registry.allowEgress(mattermostEndpoint.id);
      mattermostSdk = new Server({ name: 'live-mattermost-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      mattermostTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      mattermostSdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(mattermostSchemas) }) as never);
      mattermostSdk.setRequestHandler('tools/call', req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        const text = req.params.name === 'mattermost_list_channels'
          ? JSON.stringify({ channels: [{ name: 'town-square', display_name: 'Town Square' }] })
          : req.params.name === 'mattermost_whoami'
            ? JSON.stringify({ username: 'robert', display_name: 'Robert Peat' })
            : JSON.stringify({ posts: [{ channel: 'town-square', author: 'Rob', time: '2026-10-11T10:00:00Z', text: 'Standup at ten', permalink: 'https://chat.peat-cloud.com/team/pl/abcdef1234567890abcdefghij' }] });
        return { content: [{ type: 'text', text }] };
      });
      await mattermostSdk.connect(mattermostTransport);
    }
    let calendarEndpoint: { id: string; url: string; account: string; resource: string } | undefined;
    let calendarSdk: Server | undefined;
    let calendarTransport: WebStandardStreamableHTTPServerTransport | undefined;
    const calendarSchemas = [{ name: 'gcal_calendars', inputSchema: { type: 'object' } }, { name: 'gcal_list', inputSchema: { type: 'object' } }];
    if (overrides.calendar) {
      calendarEndpoint = { id: 'calendar', url: 'https://fixture.invalid/calendar', account: 'account', resource: 'resource' };
      registry.register(calendarEndpoint); registry.enable(calendarEndpoint.id); registry.allowEgress(calendarEndpoint.id);
      calendarSdk = new Server({ name: 'live-calendar-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      calendarTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      calendarSdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(calendarSchemas) }) as never);
      calendarSdk.setRequestHandler('tools/call', req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        return { content: [{ type: 'text', text: JSON.stringify({ data: req.params.name === 'gcal_list'
          ? { events: [{ summary: `Event on ${String(req.params.arguments?.['calendarId'] ?? 'primary')}` }] }
          : { calendars: [{ id: 'primary', summary: 'Primary' }, { id: 'work', summary: 'Work' }] } }) }] };
      });
      await calendarSdk.connect(calendarTransport);
    }
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (mattermostTransport && mattermostEndpoint && request.url === mattermostEndpoint.url) return mattermostTransport.handleRequest(request);
      if (calendarTransport && calendarEndpoint && request.url === calendarEndpoint.url) return calendarTransport.handleRequest(request);
      return transport.handleRequest(request);
    });
    const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: 12000, projectionChars: 10, timeoutMs: 1000 } });
    const toolOwner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? owner?.lookupJobAuthority(runId) ?? null });
    if (overrides.beforeGate) {
      const authorize = toolOwner.resultGate.authorize.bind(toolOwner.resultGate);
      t.mock.method(toolOwner.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => { await overrides.beforeGate!(); return authorize(...args); });
    }
    toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
      endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(schemas),
      sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
      route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: 3, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
    assert.equal((await port.discover(endpoint.id)).state, 'discovered');
    if (overrides.mattermost && mattermostEndpoint) {
      toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mattermost', generation: 1, enabled: true, connector: 'mattermost',
        endpoint: { ...mattermostEndpoint, credentialRef: null }, toolNames: [...MATTERMOST_TOOLS], schemaDigest: canonicalToolDigest(mattermostSchemas),
        sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
        route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
        bounds: { maxQueryChars: 200, maxSearchLimit: 60, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
      assert.equal((await port.discover(mattermostEndpoint.id)).state, 'discovered');
      toolOwner.projectConnection('mattermost');
    }
    if (overrides.calendar && calendarEndpoint) {
      toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'calendar', generation: 1, enabled: true, connector: 'google',
        endpoint: { ...calendarEndpoint, credentialRef: null }, toolNames: ['gcal_calendars', 'gcal_list'], schemaDigest: canonicalToolDigest(calendarSchemas),
        sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
        route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
        bounds: { maxQueryChars: 200, maxSearchLimit: 60, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
      assert.equal((await port.discover(calendarEndpoint.id)).state, 'discovered');
      toolOwner.projectConnection('calendar');
    }
    toolOwner.projectConnection('lux');
    tools = { owner: toolOwner, connectionIds: () => ['lux', ...(overrides.mattermost ? ['mattermost'] : []), ...(overrides.calendar ? ['calendar'] : [])] };
    if (overrides.onSessionTerminal) tools = Object.assign({ ...tools }, { onSessionTerminal: overrides.onSessionTerminal });
    t.after(async () => { await port.close(); await transport.close(); await sdk.close(); if (mattermostSdk) await mattermostSdk.close(); if (calendarSdk) await calendarSdk.close(); });
  }
  const memorySource = (tx: import('../contracts/storage.js').Transaction) => {
    memorySelections += 1;
    if (overrides.memoryFailure) throw new Error('synthetic memory failure');
    const ids = tx.all('SELECT id FROM entries ORDER BY id').map(row => String(row['id']));
    return ids.flatMap(id => memory.resolveEntries(tx, [id])).map(record => {
      const entry = labels.current(tx, { kind: 'entry', id: record.entryId }).dataClass;
      const parent = labels.current(tx, { kind: 'session', id: record.sessionId }).dataClass;
      const dataClass = entry === 'unknown' || parent === 'unknown' ? 'unknown' as const
        : entry === 'sensitive' || parent === 'sensitive' ? 'sensitive' as const
        : entry === 'private' || parent === 'private' ? 'private' as const : 'ordinary' as const;
      return { id: record.entryId, text: record.text, dataClass };
    });
  };
  owner = createLiveSessionOwner({ store, voice, profile, ...{ memorySource }, ...(tools ? { tools } : {}), now: () => overrides.scheduler?.now ?? clock, timeZone: 'Asia/Kolkata', ...(overrides.scheduler ? { schedule: overrides.scheduler.schedule } : {}) });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { requests, calls, get memorySelections() { return memorySelections; }, f, store, owner, ctx: context(store), dir, advance: ms => { if (overrides.scheduler) overrides.scheduler.now += ms; else clock += ms; } };
}

async function attached(h: Harness, key = 'k1', opening = 'Open the conversation now with one fresh, specific line.') {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  assert.equal(h.owner.current().state, 'idle', 'accepted without an attachment is not listening');
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  await h.f.frame(2);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: opening } });
  h.f.frames.splice(1, 1);
  return { session, attachment };
}

test('a test-only port with different capabilities drives the live session with no model-name branch', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, language: 'en-IN' });
  const session = h.owner.create({ idempotencyKey: 'fake-port', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  assert.equal(h.owner.current().state, 'listening');
  assert.equal(fake.sessionsOpened, 1, 'the host opened the port once');
  // The host reads the declared capabilities, not a model name; the fake differs from Gemini on every axis.
  assert.equal(fake.port.capabilities.supportsResumption, false);
  assert.equal(fake.port.capabilities.supportsGoAway, false);
  assert.deepEqual(fake.port.capabilities.inputRates, [8000]);
  assert.deepEqual(fake.port.capabilities.outputRates, [24000]);
  assert.deepEqual(fake.port.capabilities.outputModalities, ['audio', 'text']);
  const request = h.requests.at(-1)!;
  assert.equal(request.languageCode, 'en-IN', 'the setup language reaches the port');
  assert.ok(request.system.text.length > 0, 'the system instruction reaches the port');
  assert.equal('modelId' in request, false, 'the port request carries no model name');
  const output = attachment.output[Symbol.asyncIterator]();
  assert.equal((await output.next()).value?.kind, 'marker');
  fake.emit({ type: 'audio', pcm: new Uint8Array([1, 2, 3]), rate: 24000 });
  const chunk = await output.next();
  assert.equal(chunk.value?.kind, 'audio', 'the fake session audio reached the attached consumer');
  assert.deepEqual([...(chunk.value as { pcm: Uint8Array }).pcm], [1, 2, 3]);
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('the host suite drives a port declared as gemini and as openai with no provider branch', async t => {
  for (const provider of ['gemini', 'openai'] as const) {
    const model = provider === 'openai' ? 'gpt-live-1' : MODEL;
    const fake = fakeLiveVoicePort({ provider });
    const h = await harness(t, { port: fake.port, provider, model });
    const session = h.owner.create({ idempotencyKey: `provider-${provider}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    assert.equal(fake.port.capabilities.provider, provider, 'the port declares its own provider');
    assert.equal(fake.sessionsOpened, 1, `the ${provider} port opened once`);
    // The grant the host persists names the provider the profile carries, never a literal.
    const grant = h.store.transaction(tx => tx.get('SELECT provider FROM live_grants WHERE live_session_id=?', [session.liveSessionId]));
    assert.equal(grant?.['provider'], provider);
    assert.equal(h.owner.current().state, 'listening');
    h.owner.revoke(session.liveSessionId);
    await attachment.done;
  }
});

test('the host reuses a resumption handle only when the adapter declares the capability', async t => {
  for (const supportsResumption of [true, false]) {
    const fake = fakeLiveVoicePort({ supportsResumption });
    const h = await harness(t, { port: fake.port, language: 'en-IN' });
    const session = h.owner.create({ idempotencyKey: `resume-cap-${supportsResumption}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    const storedHandle = (): unknown => h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!['resumption_handle'];
    fake.emit({ type: 'resumptionHandle', handle: 'resumption-h1' });
    for (let i = 0; i < 100 && storedHandle() !== 'resumption-h1'; i++) await tick();
    assert.equal(storedHandle(), 'resumption-h1', 'the adapter handle is persisted');
    // A goAway is a recoverable outcome; the host rebuilds and decides from the declared capability whether to reuse the handle.
    fake.emit({ type: 'goAway', timeLeftMs: 5000 });
    for (let i = 0; i < 100 && fake.sessionsOpened < 2; i++) await tick();
    assert.equal(fake.sessionsOpened, 2, 'the host reopened on the recoverable outcome');
    const reopened = h.requests.at(-1)!;
    if (supportsResumption) assert.equal(reopened.resumptionHandle, 'resumption-h1', 'the declared capability reuses the handle');
    else assert.equal(reopened.resumptionHandle, undefined, 'a port without the capability gets no handle');
    h.owner.revoke(session.liveSessionId);
    await attachment.done;
  }
});

test('typed text reaches the adapter as a realtime text turn and journals a You turn', async t => {
  const h = await harness(t);
  await attached(h, 'typed');
  h.owner.text('What is on my plate?');
  await h.f.frame(2);
  assert.deepEqual(h.f.frames.at(-1), { realtimeInput: { text: 'What is on my plate?' } });
  const entry = h.owner.current().entries.findLast(e => e.kind === 'inputTranscription');
  assert.equal(entry?.text, 'What is on my plate?');
});

test('fresh owner Start selects model-first with no fabricated history', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'fresh-opening', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  assert.equal(h.requests[0]!.opening, 'model_first');
  assert.deepEqual(h.requests[0]!.history, []);
  h.f.send({ setupComplete: {} });
  await Promise.all([attachment.ready, h.f.frame(2)]);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: 'Open the conversation now with one fresh, specific line.' } });
  const persisted = JSON.stringify(h.store.transaction(tx => tx.all('SELECT kind,text FROM live_journal WHERE live_session_id=?', [session.liveSessionId])));
  assert.equal(persisted.includes('Open the conversation now'), false, 'the server-owned directive is not user transcription or history');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

function accepted(h: Harness, id: string): { system: string; memory: { status: string; selectedIds: string[]; omitted: { id: string; reason: string }[] }; pickup?: { jobId: string; identity: string } } {
  return h.store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [id])!['accepted_prompt_snapshot'])));
}

function assertFrozenInstruction(h: Harness, id: string, request: number) {
  const snapshot = accepted(h, id);
  assert.equal(h.requests[request]!.system.text, snapshot.system);
  const digest = createHash('sha256').update(JSON.stringify({ text: snapshot.system, dataClass: 'ordinary' })).digest('hex');
  assert.equal(h.owner.get(id).promptIdentity, digest);
}

function note(h: Harness, id: string, text: string, entryClass = 'ordinary', parentClass = 'ordinary') {
  h.store.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,NULL,?,1,?,?)', [`parent-${id}`, 'Fixture', NOW, 'UTC', NOW, NOW]);
    tx.run('INSERT INTO entries VALUES (?,?,1,?,?,?, ?,1)', [id, `parent-${id}`, 'user', text, NOW, 'UTC']);
    for (const [kind, subject, dataClass] of [['entry', id, entryClass], ['session', `parent-${id}`, parentClass]]) {
      tx.run('INSERT INTO routing_labels VALUES (?,?,1,?,?,?)', [kind!, subject!, dataClass!, 'owner_review', NOW]);
    }
  });
}

test('Live memory is frozen at CREATE, fresh at the next CREATE, and covered by the fingerprint', async t => {
  const h = await harness(t);
  note(h, 'note-a', 'Fixture old owner note');
  const first = h.owner.create({ idempotencyKey: 'memory-old', inputClass: 'ordinary' }, h.ctx);
  h.store.transaction(tx => tx.run('UPDATE entries SET text=?, revision=2 WHERE id=?', ['Fixture revised owner note', 'note-a']));
  assert.equal(h.owner.create({ idempotencyKey: 'memory-old', inputClass: 'ordinary' }, h.ctx).liveSessionId, first.liveSessionId, 'same-key replay never re-resolves memory');
  const attachment = h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx);
  await h.f.frame(1); h.f.send({ setupComplete: {} }); await attachment.ready;
  assertFrozenInstruction(h, first.liveSessionId, 0);
  assert.match(h.requests[0]!.system.text, /Fixture old owner note/);
  assert.ok(!h.requests[0]!.system.text.includes('Fixture revised owner note'));
  h.owner.revoke(first.liveSessionId); await attachment.done;
  const fresh = h.owner.create({ idempotencyKey: 'memory-new', inputClass: 'ordinary' }, h.ctx);
  assert.match(accepted(h, fresh.liveSessionId).system, /Fixture revised owner note/);
  assert.notEqual(fresh.promptIdentity, first.promptIdentity);
  assert.equal(h.store.transaction(tx => tx.get('SELECT fingerprint FROM live_sessions WHERE live_session_id=?', [first.liveSessionId])!['fingerprint']), createHash('sha256').update(JSON.stringify({ inputClass: 'ordinary', profile: first.profileIdentity, prompt: first.promptIdentity, pickupJobId: null })).digest('hex'));
});

test('Live memory recalls ordinary entries only, including parent labels, and reports an empty selection', async t => {
  const h = await harness(t);
  const empty = h.owner.create({ idempotencyKey: 'empty-memory', inputClass: 'ordinary' }, h.ctx);
  assert.equal(accepted(h, empty.liveSessionId).memory.status, 'empty');
  note(h, 'ordinary', 'Fixture ordinary note');
  note(h, 'private', 'Fixture private canary', 'private');
  note(h, 'sensitive', 'Fixture sensitive canary', 'sensitive');
  note(h, 'private-parent', 'Fixture parent private canary', 'ordinary', 'private');
  const session = h.owner.create({ idempotencyKey: 'class-memory', inputClass: 'ordinary' }, h.ctx);
  const snapshot = accepted(h, session.liveSessionId);
  assert.match(snapshot.system, /Fixture ordinary note/);
  for (const forbidden of ['Fixture private canary', 'Fixture sensitive canary', 'Fixture parent private canary']) assert.ok(!snapshot.system.includes(forbidden));
  assert.deepEqual(snapshot.memory.selectedIds, ['ordinary']);
  assert.deepEqual(h.store.transaction(resolveLiveMemory).map(record => record.id), ['ordinary']);
  assert.deepEqual(h.owner.profileProjection().memory, { status: 'selected', selected: 1, omitted: 0 });
  assert.deepEqual(h.owner.current().memory, { status: 'selected', selected: 1, omitted: 0 });
});

test('Live memory budget keeps whole records, reports overflow, and rejects oversized static instructions and resolution failure', async t => {
  const h = await harness(t);
  note(h, 'a', 'Fixture whole note');
  const initial = h.owner.create({ idempotencyKey: 'measure-memory', inputClass: 'ordinary' }, h.ctx);
  assert.deepEqual(accepted(h, initial.liveSessionId).memory.selectedIds, ['a']);
  h.store.transaction(tx => tx.run('UPDATE entries SET text=? WHERE id=?', ['Fixture whole note' + 'x'.repeat(MEMORY_SECTION_CHAR_LIMIT), 'a']));
  note(h, 'b', 'Fixture overflow note');
  const boundary = h.owner.create({ idempotencyKey: 'boundary-memory', inputClass: 'ordinary' }, h.ctx);
  const snapshot = accepted(h, boundary.liveSessionId);
  assert.ok(snapshot.system.length <= TRUSTED_SYSTEM_CODE_UNIT_LIMIT);
  assert.deepEqual(snapshot.memory.selectedIds, ['b']);
  assert.deepEqual(snapshot.memory.omitted, [{ id: 'a', reason: 'budget' }]);
  assert.ok(!snapshot.system.includes('x'.repeat(128)));
  assert.ok(snapshot.system.includes('"text":"Fixture overflow note"'), 'the selected record survives byte for byte');
  const failed = await harness(t, { memoryFailure: true });
  assert.throws(() => failed.owner.create({ idempotencyKey: 'failed-memory', inputClass: 'ordinary' }, failed.ctx), (error: unknown) => error instanceof LiveError && String(error.code) === 'memory_unavailable');
  assert.equal(failed.requests.length, 0);
});

test('Live transcripts and completion, interruption and terminal events stay journal-only', async t => {
  const h = await harness(t);
  note(h, 'existing', 'Fixture existing note');
  const { session, attachment } = await attached(h, 'journal-only');
  const before = h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n']));
  h.f.send({ serverContent: { inputTranscription: { text: 'Fixture voice input', finished: true }, outputTranscription: { text: 'Fixture voice output', finished: true }, turnComplete: true } });
  await drain(h, session.liveSessionId, 4);
  h.f.send({ serverContent: { interrupted: true } });
  await drain(h, session.liveSessionId, 5);
  h.owner.revoke(session.liveSessionId); await attachment.done;
  const kinds = h.store.transaction(tx => tx.all('SELECT kind FROM live_journal WHERE live_session_id=?', [session.liveSessionId]).map(row => row['kind']));
  for (const kind of ['inputTranscription', 'outputTranscription', 'turnComplete', 'interrupted', 'terminal']) assert.ok(kinds.includes(kind));
  assert.equal(h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n'])), before);
});

test('a session with a tool declaration carries the tools conduct; without one composes exactly as before', async t => {
  const withTools = await harness(t, { tools: true });
  const { session: withSession, attachment: withAttachment } = await attached(withTools);
  assertFrozenInstruction(withTools, withSession.liveSessionId, 0);
  assert.equal(withTools.requests.length, 1);
  assert.ok(withTools.requests[0]!.system.text.includes(NAYA_TOOLS),
    'the authored tools conduct is in the attached system instruction');
  withAttachment.close(); await withAttachment.done;

  const withoutTools = await harness(t, {});
  const { attachment: withoutAttachment } = await attached(withoutTools);
  assert.equal(withoutTools.requests.length, 1);
  assert.equal(withoutTools.requests[0]!.system.text, 'Synthetic system', 'no declarations compose exactly as before');
  assert.ok(!withoutTools.requests[0]!.system.text.includes('# Tools'));
  withoutAttachment.close(); await withoutAttachment.done;
});

async function drain(h: Harness, liveSessionId: string, expected: number): Promise<LiveSessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = h.owner.get(liveSessionId);
    if (snapshot.journal.events >= expected) return snapshot;
    if (Date.now() > deadline) throw new Error(`journal did not reach ${expected} events`);
    await tick();
  }
}

async function waitTerminal(h: Harness, liveSessionId: string): Promise<LiveSessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = h.owner.get(liveSessionId);
    if (snapshot.terminal !== null) return snapshot;
    if (Date.now() > deadline) throw new Error('session never terminated');
    await tick();
  }
}

test('many-turn journal preserves provider order, late input, and an interrupted turn without generationComplete', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  // Ordered output consumer: committed markers must not accumulate and trip unified backpressure.
  void (async () => { for await (const chunk of attachment.output) { void chunk; } })();
  const turns = 140;
  for (let i = 0; i < turns; i++) {
    h.f.send({ serverContent: { outputTranscription: { text: `out-${i}`, finished: true }, generationComplete: true, turnComplete: true } });
    h.f.send({ serverContent: { inputTranscription: { text: `in-${i}` } } });
    await drain(h, session.liveSessionId, 1 + (i + 1) * 4);
  }
  h.f.send({ serverContent: { outputTranscription: { text: 'cut off' } } });
  h.f.send({ serverContent: { interrupted: true, turnComplete: true } });
  h.f.send({ serverContent: { inputTranscription: { text: 'late final input', finished: true } } });
  const live = await drain(h, session.liveSessionId, 1 + turns * 4 + 4);
  assert.equal(live.lifecycle, 'active');
  assert.equal(live.ready, true, 'the durable ready fact survives later journal writes');
  assert.ok(live.journal.events > 128, 'the adapter 128-event queue is not a lifetime journal cap');
  assert.equal(h.f.attempts, 1);

  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.equal(page.fragments[0]?.kind, 'ready');
  assert.deepEqual(page.fragments.slice(1, 5).map(fragment => fragment.kind), ['outputTranscription', 'generationComplete', 'turnComplete', 'inputTranscription']);
  assert.equal(page.fragments[1]?.text, 'out-0');
  assert.equal(page.fragments[4]?.text, 'in-0');
  assert.equal(page.fragments[4]?.finished, null);
  const tail = h.owner.listFragments({ liveSessionId: session.liveSessionId, cursor: 2 + turns * 4 });
  assert.deepEqual(tail.fragments.map(fragment => fragment.kind), ['outputTranscription', 'interrupted', 'turnComplete', 'inputTranscription']);
  assert.equal(tail.fragments[3]?.text, 'late final input');
  assert.equal(tail.fragments[3]?.finished, true);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).interruptions, 1);
  const keys = ['arrivedAt', 'finished', 'journalSequence', 'kind', 'liveSessionId', 'providerSequence', 'rejectedKind', 'rejectedSequence', 'text', 'value'].sort();
  for (const fragment of page.fragments) assert.deepEqual(Object.keys(fragment).sort(), keys);
  attachment.close();
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'closed', code: 'closed' });
  assert.equal(terminal.journal.complete, true);
});

test('excluded transport facts and raw secrets never persist; Domain and CHAT stay untouched', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio(), { text: 'unspoken thought', thought: true }] }, outputTranscription: { text: 'Spoken text' }, turnComplete: true } });
  await drain(h, session.liveSessionId, 3);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: CANARY } });
  await tick();
  h.f.send({ serverContent: { inputTranscription: { text: 'synced' } } });
  await drain(h, session.liveSessionId, 4);
  attachment.close();
  await attachment.done;

  const journal = h.store.transaction(tx => tx.all('SELECT * FROM live_journal'));
  const dump = JSON.stringify(journal);
  assert.equal(dump.includes(CANARY), false, 'resolved credential and resumption handle never persist');
  assert.equal(dump.includes('unspoken thought'), false, 'modelText and thoughts are not transcripts');
  assert.equal(dump.includes(Buffer.from(pcm).toString('base64')), false, 'no PCM bytes persist');
  assert.equal(journal.some(row => String(row['kind']) === 'modelText' || String(row['kind']) === 'audio'), false);
  assert.ok(journal.some(row => String(row['text']) === 'Spoken text'));
  const tables = h.store.transaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => String(row['name'])));
  for (const table of ['live_sessions', 'live_grants', 'live_journal', 'sessions', 'entries', 'chat_runs', 'chat_consents']) assert.ok(tables.includes(table), table);
  const writes = h.store.transaction(tx => ({
    sessions: Number(tx.get('SELECT COUNT(*) AS n FROM sessions')!['n']),
    entries: Number(tx.get('SELECT COUNT(*) AS n FROM entries')!['n']),
    chatRuns: Number(tx.get('SELECT COUNT(*) AS n FROM chat_runs')!['n']),
    chatConsents: Number(tx.get('SELECT COUNT(*) AS n FROM chat_consents')!['n']),
  }));
  assert.deepEqual(writes, { sessions: 0, entries: 0, chatRuns: 0, chatConsents: 0 });
});

test('audio is rejected before ready and PCM never reaches the store', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'ready-order', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  assert.throws(() => attachment.sendAudio({ pcm }), (error: unknown) => error instanceof LiveError && error.code === 'not_ready');
  assert.throws(() => attachment.endAudioStream(), (error: unknown) => error instanceof LiveError && error.code === 'not_ready');
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await Promise.all([attachment.ready, h.f.frame(2)]);
  assert.deepEqual(h.f.frames[1], { realtimeInput: { text: 'Open the conversation now with one fresh, specific line.' } });
  attachment.sendAudio({ pcm });
  await h.f.frame(3);
  assert.deepEqual(h.f.frames[2], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm).toString('base64') } } });
  attachment.endAudioStream();
  await h.f.frame(4);
  assert.deepEqual(h.f.frames[3], { realtimeInput: { audioStreamEnd: true } });
  attachment.close();
  await attachment.done;
});

test('a late mic frame after settle is dropped and counted, never thrown', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('live_late_frame_dropped')) lines.push(args[0]);
  });
  const h = await harness(t);
  const { attachment } = await attached(h, 'late-frame');
  // Settle the session from the provider, then deliver a frame the app could not have sent before the end.
  h.f.remoteClose('', 1000);
  const terminal = await attachment.done;
  assert.equal(terminal.lifecycle, 'terminal');
  assert.ok(terminal.terminal, 'a settled session carries a terminal fact');
  const providerFrames = h.f.frames.length;
  assert.doesNotThrow(() => attachment.sendAudio({ pcm }), 'a frame after settle must be dropped, not thrown');
  // The drop is counted and reported, and the frame never reaches the adapter.
  assert.equal(h.f.frames.length, providerFrames, 'no late frame reaches the provider');
  assert.equal(lines.length, 1, 'the late drop is counted once');
  const dropped = JSON.parse(lines[0]!);
  assert.equal(dropped.event, 'live_late_frame_dropped');
  assert.equal(dropped.dropCalls, 1);
  assert.equal(dropped.dropBytes, pcm.byteLength);
});

test('a durable terminal write failure still logs the failure and reports the real terminal code', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('live_terminal_write_failed')) lines.push(args[0]);
  });
  const h = await harness(t, { failingWrite: "SET lifecycle='terminal'" });
  const { attachment } = await attached(h, 'settle-write-fail');
  h.owner.revoke(attachment.liveSessionId);
  const snapshot = await attachment.done;
  assert.ok(snapshot.terminal, 'the typed terminal is reported even when the durable write failed');
  assert.equal(snapshot.terminal.state, 'revoked');
  assert.equal(lines.length, 1, 'the durable write failure is logged, not swallowed');
  assert.equal(JSON.parse(lines[0]!).event, 'live_terminal_write_failed');
});

test('a failed detach write is logged and a later read no longer reports the session attached', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('live_detach_write_failed')) lines.push(args[0]);
  });
  const h = await harness(t, { failingWrite: "consumer_state='ended'" });
  const { attachment } = await attached(h, 'detach-write-fail');
  assert.equal(h.owner.get(attachment.liveSessionId).consumerState, 'attached');
  attachment.detach();
  assert.equal(lines.length, 1, 'the failed detach write is logged, not swallowed');
  assert.equal(JSON.parse(lines[0]!).event, 'live_detach_write_failed');
  // Reconcile on read: the row still says attached, but the in-memory handle says ended.
  assert.equal(h.owner.get(attachment.liveSessionId).consumerState, 'ended');
  assert.notEqual(h.owner.current().state, 'listening', 'a detached session is never projected as listening');
});

test('single attach, idempotent create replay, conflict, and a terminal session that never reopens', async t => {
  const h = await harness(t);
  const first = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  const replay = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  assert.equal(replay.liveSessionId, first.liveSessionId);
  assert.equal(h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM live_sessions')!['n'])), 1);
  assert.throws(() => h.owner.create({ idempotencyKey: 'dup', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'idempotency_conflict');
  assert.throws(() => h.owner.create({ idempotencyKey: 'class', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalid_request');

  const attachment = h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx);
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'already_attached');
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  attachment.close();
  const terminal = await attachment.done;
  assert.equal(terminal.lifecycle, 'terminal');

  const after = h.owner.create({ idempotencyKey: 'dup', inputClass: 'ordinary' }, h.ctx);
  assert.equal(after.lifecycle, 'terminal');
  assert.equal(after.dispatchIntent, true);
  assert.deepEqual(after.terminal, { state: 'closed', code: 'closed' });
  assert.equal(h.f.attempts, 1, 'replaying a terminal create never dispatches');
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'terminal');
});

test('an unused accepted session expires without ever opening the adapter', async t => {
  const h = await harness(t, { limits: { unusedMs: 1000 } });
  const session = h.owner.create({ idempotencyKey: 'unused', inputClass: 'ordinary' }, h.ctx);
  assert.equal(session.lifecycle, 'accepted');
  h.advance(2000);
  assert.throws(() => h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'expired');
  const after = h.owner.get(session.liveSessionId);
  assert.equal(after.lifecycle, 'terminal');
  assert.deepEqual(after.terminal, { state: 'expired' });
  assert.equal(after.journal.complete, false);
  assert.equal(h.f.attempts, 0);
});

test('durable tool jobs defer without replay and retain completed or failed outcomes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-jobs-'));
  const migrations = createDomainPort({ outbox: Outbox }).migrations;
  let store = new Store(dir, migrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const host: HostContext = { runId: 'origin', actorId: 'client', authorityEpoch: store.authorityEpoch, revision: 1, grants: [] };
  // The execution owner validates this snapshot; the receipt owner stores it without granting authority.
  const authority = { runId: 'origin' } as LiveAuthority;
  let expire = () => {};
  const schedule: JobTimer = callback => { expire = callback; return { unref() {}, cancel() {} }; };
  const batch: ToolJobResult = { tools: [], bindings: [], responses: [], error: undefined, accepted: [] };
  let finish!: (value: ToolJobResult) => void;
  let executions = 0;
  let jobs = new LiveToolJobs(store, () => NOW);
  const waiting = jobs.run(host, authority, 4000, schedule, () => { executions++; return new Promise(resolve => { finish = resolve; }); });
  expire();
  const deferred = await waiting;
  assert.equal(deferred.result, undefined);
  assert.equal(jobs.pending()[0]!.state, 'in_progress');
  finish(batch);
  await tick();
  assert.equal(jobs.pending()[0]!.state, 'completed');
  assert.deepEqual(jobs.pending()[0]!.result, JSON.parse(JSON.stringify(batch)));
  const failed = await jobs.run(host, authority, 4000, schedule, async () => { throw new Error('synthetic failure'); });
  assert.equal(failed.job.state, 'failed');
  const interrupted = jobs.run(host, authority, 4000, schedule, () => { executions++; return new Promise(() => {}); });
  expire();
  await interrupted;
  store.close();
  store = new Store(dir, migrations);
  jobs = new LiveToolJobs(store, () => NOW);
  // These fixture rows are dated by the synthetic clock, so their one day outbox expiry is long past:
  // host start purges them as stale data (UI3b), and nothing is replayed from them either.
  assert.deepEqual(jobs.pending(), []);
  assert.equal(executions, 2, 'reopening never replays a dispatched tool');
});

test('the feed projects only the current session jobs and never a delivered row past its expiry', () => {
  const job = (id: string, createdAt: number, originSessionId: string, extra: Partial<ToolJob> = {}): ToolJob => ({
    id, originSessionId, state: 'completed', createdAt, delivered: false, deferred: true,
    host: { runId: id } as ToolJob['host'], authority: { runId: id } as ToolJob['authority'], ...extra,
  });
  const jobs = [
    job('here', NOW, 'session-now'),                                                       // this session, undelivered
    job('picked-up', NOW - 5_000, 'session-old', { deliverySessionId: 'session-now' }),     // picked up by this session
    job('elsewhere', NOW, 'session-old'),                                                  // another session
    job('delivered-now', NOW, 'session-now', { delivered: true }),                          // delivered inside the day
    job('delivered-old', NOW - 2 * 86_400_000, 'session-now', { delivered: true }),         // delivered and expired
  ];
  assert.deepEqual(feedJobs(jobs, 'session-now', NOW).map(row => row.id), ['here', 'picked-up', 'delivered-now']);
  assert.deepEqual(feedJobs(jobs, 'session-old', NOW).map(row => row.id), ['elsewhere']);
});

test('host start purges settled job rows past their expiry and keeps the live ones', t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-outbox-purge-'));
  const migrations = createDomainPort({ outbox: Outbox }).migrations;
  const now = Date.now();
  let store = new Store(dir, migrations);
  store.transaction(tx => {
    const rows: [string, string, number][] = [
      ['stale', 'acknowledged', now - 2 * 86_400_000],
      ['unknown-old', 'unknown', now - 86_400_001],
      ['fresh', 'unknown', now + 86_400_000],
      ['waiting', 'pending', now - 86_400_000],
    ];
    for (const [id, state, expires] of rows) {
      tx.run("INSERT INTO runtime_outbox(id,entity_id,entity_revision,authority_epoch,required_grant,payload,source_timezone,due_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [id, `live-job:${id}`, 1, store.authorityEpoch, 'live-tool-job', '{}', 'UTC', expires - 86_400_000, expires, state]);
    }
  });
  store.close();
  store = new Store(dir, migrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(store.transaction(tx => tx.all('SELECT id FROM runtime_outbox ORDER BY id')).map(row => String(row.id)), ['fresh', 'waiting']);
});

test('expired job leases become unknown without replay or accepting late completion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-job-lease-'));
  const store = new Store(dir, createDomainPort({ outbox: Outbox }).migrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = NOW, expire = () => {}, executions = 0;
  const jobs = new LiveToolJobs(store, () => clock);
  const host: HostContext = { runId: 'origin', actorId: 'client', authorityEpoch: store.authorityEpoch, revision: 1, grants: [] };
  let finish!: (result: ToolJobResult) => void;
  const waiting = jobs.run(host, { runId: 'origin' } as LiveAuthority, 4000,
    callback => { expire = callback; return { unref() {}, cancel() {} }; },
    () => { executions++; return new Promise(resolve => { finish = resolve; }); });
  expire(); await waiting;
  clock += 86_400_000;
  assert.equal(jobs.pending()[0]!.state, 'unknown');
  finish({ tools: [], bindings: [], responses: [], error: undefined, accepted: [] });
  await tick();
  assert.equal(jobs.pending()[0]!.state, 'unknown');
  assert.equal(jobs.pending()[0]!.result, undefined);
  assert.equal(executions, 1);
});

test('live timer defaults are a 5 minute idle and a 60 minute session, and an explicit config wins', () => {
  const defaults = validateLiveProfile(profileInput()).limits;
  assert.equal(defaults.idleMs, 300_000);
  assert.equal(defaults.sessionMs, 3_600_000);
  const edited = validateLiveProfile(profileInput({ idleMs: 12_345, sessionMs: 67_890 })).limits;
  assert.equal(edited.idleMs, 12_345);
  assert.equal(edited.sessionMs, 67_890);
});

test('AC2: every Live session sends an explicit setup language: owner tag, locale primary subtag, or en', () => {
  assert.equal(liveSetupLanguage(undefined), 'en', 'no configured locale still sends an explicit language');
  assert.equal(liveSetupLanguage('en'), 'en', 'a configured bare language stays en');
  assert.equal(liveSetupLanguage('en-IN'), 'en-IN', 'a configured regional tag stays end to end (AC1)');
  assert.equal(liveSetupLanguage('EN-in'), 'en-IN', 'the owner tag is case-normalised');
  assert.equal(liveSetupLanguage('zh-Hans-CN'), 'zh', 'a script locale reduces to its bare primary subtag');
  assert.equal(liveSetupLanguage('fil-PH'), 'en', 'a locale with no two-letter primary language falls back to en');
});

test('live profile language accepts a BCP-47 tag with optional region, case-normalised, and fails closed', () => {
  assert.equal(validateLiveProfile(profileInput()).language, undefined, 'no configured language stays unset');
  assert.equal(validateLiveProfile({ ...profileInput(), language: 'en' }).language, 'en');
  assert.equal(validateLiveProfile({ ...profileInput(), language: 'en-IN' }).language, 'en-IN');
  assert.equal(validateLiveProfile({ ...profileInput(), language: 'de-DE' }).language, 'de-DE');
  assert.equal(validateLiveProfile({ ...profileInput(), language: 'EN-in' }).language, 'en-IN');
  for (const bad of ['english', 'e', 'en-IND', 'en_US', '', 'en-', '-IN', 'e1', 'en-IN-x', ' en']) {
    assert.throws(() => validateLiveProfile({ ...profileInput(), language: bad }),
      (error: unknown) => error instanceof LiveConfigError && error.code === 'invalid_language', `rejects ${JSON.stringify(bad)}`);
  }
});

test('profile validation rejects text-model fallback and bounds, and validation precedes credentials', async t => {
  const cases: unknown[] = [
    { ...profileInput(), provider: 'openai' },
    { ...profileInput(), liveModelId: 'gemini-2.0-flash' },
    { ...profileInput(), route: { enabled: false, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] } },
    { ...profileInput(), route: { enabled: true, provider: 'gemini', modelId: 'models/other', dataClasses: ['ordinary'] } },
    { ...profileInput(), route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: [] } },
    { ...profileInput(), prompt: { text: 'x', dataClass: 'private' } },
    { ...profileInput(), limits: { journalMaxEvents: 0 } },
    { ...profileInput(), limits: { journalMaxBytes: 2 ** 40 } },
  ];
  for (const value of cases) assert.throws(() => validateLiveProfile(value), (error: unknown) => error instanceof LiveConfigError);
  const input = profileInput();
  const profile = validateLiveProfile(input);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.route) && Object.isFrozen(profile.route.dataClasses) && Object.isFrozen(profile.limits));
  (input.route.dataClasses as unknown as string[]).push('private');
  assert.deepEqual(profile.route.dataClasses, ['ordinary']);

  let resolves = 0;
  const h = await harness(t, { credentials: { resolve: async () => { resolves += 1; return CANARY; } } });
  const session = h.owner.create({ idempotencyKey: 'validated', inputClass: 'ordinary' }, h.ctx);
  assert.throws(() => h.owner.attach({ liveSessionId: session.liveSessionId }, { ...h.ctx, authorityEpoch: 'stale' }), (error: unknown) => error instanceof LiveError && error.code === 'stale_authority');
  assert.equal(resolves, 0);
  assert.equal(h.f.attempts, 0);
  assert.throws(() => h.owner.create({ idempotencyKey: 'class', inputClass: 'private' }, h.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalid_request');
});

test('accepted complete system uses the shared 60k bound while prompt text is bounded by the live hard limit', () => {
  const ownerProfile = { schemaVersion: 1 as const, kind: 'default' as const, ownerId: 'assistant-test', displayName: 'Lux Didi' as const };
  const acceptedPrompt = { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION, system: 'A'.repeat(60_000), dataClasses: ['ordinary'] };
  assert.equal(validateLiveProfile({ ...profileInput(), acceptedPrompt }).acceptedPrompt?.system.length, 60_000);
  assert.throws(() => validateLiveProfile({ ...profileInput(), acceptedPrompt: { ...acceptedPrompt, system: 'A'.repeat(60_001) } }), LiveConfigError);
  assert.equal(validateLiveProfile({ ...profileInput(), prompt: { text: 'A'.repeat(LIVE_INSTRUCTION_HARD_LIMIT), dataClass: 'ordinary' } }).prompt.text.length, LIVE_INSTRUCTION_HARD_LIMIT);
  assert.throws(() => validateLiveProfile({ ...profileInput(), prompt: { text: 'A'.repeat(LIVE_INSTRUCTION_HARD_LIMIT + 1), dataClass: 'ordinary' } }), LiveConfigError);
});

test('tool-enabled Live CREATE freezes an expanded classified owner system byte for byte', async t => {
  const style = `SYNTHETIC style ${'S'.repeat(8_000)}`;
  const lore = `SYNTHETIC lore ${'L'.repeat(4_000)}`;
  let expectedSystem = '';
  const h = await harness(t, { tools: true, routeClasses: ['ordinary', 'private', 'sensitive'], acceptedPrompt: ownerId => {
    const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId, profileVersion: 'fixture', displayName: 'Example',
      style: { text: style, dataClass: 'private' as const }, lore: { text: lore, dataClass: 'sensitive' as const } };
    expectedSystem = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, language: 'en' }).text;
    return { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION,
      system: expectedSystem, dataClasses: ['ordinary', 'private', 'sensitive'] };
  } });
  const created = h.owner.create({ idempotencyKey: 'expanded-owner-tools', inputClass: 'ordinary' }, h.ctx);
  const frozen = h.store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [created.liveSessionId])!['accepted_prompt_snapshot'])));
  assert.ok(frozen.system.length > 4_096 && frozen.system.length <= LIVE_INSTRUCTION_HARD_LIMIT, 'the frozen system is dense but inside the hard limit');
  assert.equal(frozen.system, composeLiveSessionInstruction({ text: expectedSystem, tools: ['search_knowledge', 'get_insight'], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    runtimeContext: buildRuntimeContext({ now: new Date(NOW), timeZone: 'Asia/Kolkata', connected: ['knowledge base', 'memory'], unavailable: [] }) }).text);
  assert.equal(frozen.system.split(style).length - 1, 1);
  assert.equal(frozen.system.split(lore).length - 1, 1);
  assert.deepEqual(frozen.dataClasses, ['ordinary', 'private', 'sensitive']);
});

test('tool-enabled Live CREATE rejects a complete system whose required tool conduct exceeds the shared ceiling', async t => {
  const h = await harness(t, { tools: true, acceptedPrompt: ownerId => ({
    schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: 'A'.repeat(TRUSTED_SYSTEM_CODE_UNIT_LIMIT), dataClasses: ['ordinary'],
  }) });
  assert.throws(() => h.owner.create({ idempotencyKey: 'expanded-tools-overflow', inputClass: 'ordinary' }, h.ctx),
    (error: unknown) => error instanceof LiveError && error.code === 'instruction_too_large');
  assert.equal(h.requests.length, 0);
});

test('waitingForInput keeps its boolean and ready stays a durable fact', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: { waitingForInput: true, turnComplete: true } });
  await drain(h, session.liveSessionId, 3);
  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.equal(page.fragments.find(fragment => fragment.kind === 'waitingForInput')?.value, true);
  assert.equal(h.owner.get(session.liveSessionId).ready, true);
  h.f.send({ serverContent: { waitingForInput: false } });
  await drain(h, session.liveSessionId, 4);
  const later = h.owner.listFragments({ liveSessionId: session.liveSessionId, cursor: 4, limit: 10 });
  assert.equal(later.fragments[0]?.value, false);
  attachment.close();
  const terminal = await attachment.done;
  assert.equal(terminal.ready, true);
  assert.equal(terminal.journal.complete, true);
});

test('returned snapshots and fragments are mutation-proof copies', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'frozen', inputClass: 'ordinary' }, h.ctx);
  const first = h.owner.get(session.liveSessionId);
  first.grant.permittedClasses.push('sensitive');
  first.grant.model = 'models/tampered';
  const second = h.owner.get(session.liveSessionId);
  assert.deepEqual(second.grant.permittedClasses, ['ordinary']);
  assert.equal(second.grant.model, MODEL);
  assert.notEqual(first.grant, second.grant);
});

test('revocation aborts the adapter while silent, during model output, and during deferred credentials', async t => {
  const silent = await harness(t);
  const quiet = await attached(silent);
  silent.owner.invalidate('revoked');
  assert.deepEqual((await quiet.attachment.done).terminal, { state: 'revoked' });
  assert.throws(() => quiet.attachment.sendAudio({ pcm }), (error: unknown) => error instanceof LiveError && error.code === 'invalidated');
  await silent.f.closed;
  assert.equal(silent.f.frames.length, 1);

  const output = await harness(t);
  const speaking = await attached(output);
  output.f.send({ serverContent: { outputTranscription: { text: 'ongoing', finished: false } } });
  await drain(output, speaking.session.liveSessionId, 2);
  output.owner.invalidate('authority');
  assert.deepEqual((await speaking.attachment.done).terminal, { state: 'revoked' });
  await output.f.closed;
  assert.equal(output.owner.get(speaking.session.liveSessionId).journal.events, 2);

  const deferred = await harness(t, { credentials: { resolve: () => new Promise<string>(() => {}) } });
  const pending = deferred.owner.create({ idempotencyKey: 'deferred', inputClass: 'ordinary' }, deferred.ctx);
  const attachment = deferred.owner.attach({ liveSessionId: pending.liveSessionId }, deferred.ctx);
  deferred.owner.invalidate('profile');
  assert.deepEqual(deferred.owner.get(pending.liveSessionId).terminal, { state: 'revoked' });
  assert.equal(deferred.f.attempts, 0, 'no socket opens after invalidation during deferred credentials');
  await assert.rejects(attachment.ready);
  assert.equal(deferred.f.frames.length, 0);
});

test('attach after invalidation is refused, and both journal limits terminate durably', async t => {
  const invalidated = await harness(t);
  const accepted = invalidated.owner.create({ idempotencyKey: 'late', inputClass: 'ordinary' }, invalidated.ctx);
  invalidated.owner.invalidate('profile');
  assert.throws(() => invalidated.owner.attach({ liveSessionId: accepted.liveSessionId }, invalidated.ctx), (error: unknown) => error instanceof LiveError && error.code === 'invalidated');

  const counted = await harness(t, { limits: { journalMaxEvents: 3 } });
  const countedSession = await attached(counted, 'count');
  counted.f.send({ serverContent: { outputTranscription: { text: 'one' }, generationComplete: true, turnComplete: true } });
  const limit = await waitTerminal(counted, countedSession.session.liveSessionId);
  assert.deepEqual(limit.terminal, { state: 'journal_limit' });
  assert.equal(limit.journal.complete, false);
  assert.equal(limit.journal.events, 3, 'committed fragments are preserved');
  const page = counted.owner.listFragments({ liveSessionId: countedSession.session.liveSessionId, limit: 100 });
  assert.equal(page.counts.total, 4, 'the terminal record is counted so pages reconcile');
  assert.ok(page.counts.returned <= page.counts.total);
  const terminalRow = page.fragments.at(-1)!;
  assert.equal(terminalRow.kind, 'terminal');
  assert.equal(terminalRow.rejectedKind, 'turnComplete');
  assert.equal(terminalRow.text, null, 'the rejected fragment text is never stored');
  assert.ok(terminalRow.rejectedSequence !== null);

  const bytes = await harness(t, { limits: { journalMaxBytes: 10 } });
  const bytesSession = await attached(bytes, 'bytes');
  bytes.f.send({ serverContent: { inputTranscription: { text: 'x'.repeat(64) } } });
  const byteLimit = await waitTerminal(bytes, bytesSession.session.liveSessionId);
  assert.deepEqual(byteLimit.terminal, { state: 'journal_limit' });
  assert.equal(byteLimit.journal.events, 1);
  const bytePage = bytes.owner.listFragments({ liveSessionId: bytesSession.session.liveSessionId });
  assert.equal(bytePage.fragments.at(-1)!.rejectedKind, 'inputTranscription');
});

test('an undrained consumer channel terminates visibly instead of buffering without bound', async t => {
  const h = await harness(t, { limits: { consumerQueueEvents: 2 } });
  const { session, attachment } = await attached(h);
  for (let i = 0; i < 3; i++) h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  const snapshot = await waitTerminal(h, session.liveSessionId);
  assert.deepEqual(snapshot.terminal, { state: 'consumer_backpressure' });
  assert.equal(snapshot.consumerState, 'backpressure');
  await h.f.closed;
  assert.equal(snapshot.journal.events, 1, 'audio is never journaled');
  await attachment.done;
});

test('a bounded cursor traverses every retained fragment without silent truncation', async t => {
  const h = await harness(t);
  const { session } = await attached(h);
  for (let i = 0; i < 12; i++) h.f.send({ serverContent: { inputTranscription: { text: `fragment-${i}` } } });
  await drain(h, session.liveSessionId, 13);
  const seen: number[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 10; page++) {
    const read = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(read.fragments.length <= 3);
    seen.push(...read.fragments.map(fragment => fragment.journalSequence));
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(new Set(seen).size, seen.length);
  const one = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 500 });
  assert.equal(one.counts.total, 13);
  assert.equal(one.nextCursor, null);
  const texts = one.fragments.filter(fragment => fragment.kind === 'inputTranscription').map(fragment => fragment.text);
  assert.deepEqual(texts, Array.from({ length: 12 }, (_value, i) => `fragment-${i}`));
});

test('live migrations preserve a populated accepted Store byte-for-byte', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const domain = createDomainPort({ outbox: Outbox });
  const before = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations.filter(migration => migration.version < 3)]);
  before.transaction(tx => {
    tx.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)', ['s1', 'Prior session', 1, null, 'UTC', 1, 1, 1]);
    tx.run('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)', ['e1', 's1', 1, 'user', 'preserved text', 2, 'UTC', 1]);
    tx.run('INSERT INTO chat_consents(session_id,owner_assistant_id,provider,model,route_identity,revision,permitted_classes,granted_at,revoked_at,idempotency_key,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?)', ['s1', before.assistantId, 'gemini', MODEL, 'route', 1, '["ordinary"]', '2026-01-01T00:00:00.000Z', null, 'consent-key', 'fingerprint']);
  });
  const journalColumns = 'journal_id,live_session_id,provider_sequence,kind,text,finished,value,terminal_outcome,rejected_kind,rejected_sequence,payload_bytes,arrived_at';
  before.transaction(tx => {
    tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'terminal',1,1,3,10,1,'ended',?,1,1,1)`,
      ['legacy-live', before.assistantId, before.authorityEpoch, 'legacy-key', 'fingerprint', 'client', 'audit', 'profile', 'prompt', JSON.stringify({ state: 'closed' })]);
    tx.run(`INSERT INTO live_journal(${journalColumns}) VALUES (41,'legacy-live',1,'inputTranscription','hello',1,NULL,NULL,NULL,NULL,5,1)`);
    tx.run(`INSERT INTO live_journal(${journalColumns}) VALUES (42,'legacy-live',2,'outputTranscription','world',0,NULL,NULL,NULL,NULL,5,2)`);
    tx.run(`INSERT INTO live_journal(${journalColumns}) VALUES (43,'legacy-live',NULL,'terminal',NULL,NULL,NULL,?,NULL,NULL,0,3)`, [JSON.stringify({ state: 'closed' })]);
  });
  const prior = before.transaction(tx => ({
    liveSessions: tx.all('SELECT * FROM live_sessions ORDER BY live_session_id'),
    liveJournal: tx.all(`SELECT ${journalColumns} FROM live_journal ORDER BY journal_id`),
    sessions: tx.all('SELECT * FROM sessions ORDER BY id'),
    entries: tx.all('SELECT * FROM entries ORDER BY id'),
    consents: tx.all('SELECT * FROM chat_consents ORDER BY session_id'),
    outbox: tx.all('SELECT * FROM runtime_outbox ORDER BY id'),
  }));
  before.close();

  const migrated = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => migrated.close());
  const current = migrated.transaction(tx => ({
    liveSessions: tx.all('SELECT * FROM live_sessions ORDER BY live_session_id'),
    liveJournal: tx.all(`SELECT ${journalColumns} FROM live_journal ORDER BY journal_id`),
    sessions: tx.all('SELECT * FROM sessions ORDER BY id'),
    entries: tx.all('SELECT * FROM entries ORDER BY id'),
    consents: tx.all('SELECT * FROM chat_consents ORDER BY session_id'),
    outbox: tx.all('SELECT * FROM runtime_outbox ORDER BY id'),
  }));
  assert.ok(current.liveSessions.every(row => row['resumption_handle'] === null && row['connection_generation'] === 0));
  assert.ok(current.liveSessions.every(row => row['memory_provenance'] === null), 'additive v4 provenance is null on legacy rows');
  assert.deepEqual({ ...current, liveSessions: current.liveSessions.map(({ memory_provenance: _newColumn, resumption_handle: _handle, connection_generation: _generation, ...legacy }) => legacy) }, { ...prior, liveSessions: prior.liveSessions.map(row => ({ ...row })) }, 'all pre-existing Live, CHAT and Domain values stay byte-identical');
  assert.deepEqual(migrated.transaction(tx => tx.all('SELECT journal_id,tool_json FROM live_journal ORDER BY journal_id').map(row => ({ ...row }))),
    [41, 42, 43].map(journal_id => ({ journal_id, tool_json: null })));
  migrated.transaction(tx => {
    tx.run(`INSERT INTO live_journal(live_session_id,kind,tool_json,payload_bytes,arrived_at) VALUES ('legacy-live','toolCall','{}',2,4)`);
    tx.run(`INSERT INTO live_journal(live_session_id,kind,tool_json,payload_bytes,arrived_at) VALUES ('legacy-live','toolResult','{}',2,5)`);
    assert.deepEqual(tx.all('SELECT journal_id,kind FROM live_journal WHERE journal_id>43 ORDER BY journal_id').map(row => ({ ...row })),
      [{ journal_id: 44, kind: 'toolCall' }, { journal_id: 45, kind: 'toolResult' }]);
  });
  migrated.transaction(tx => {
    const id = String(current.liveSessions[0]!['live_session_id']);
    tx.run("INSERT INTO live_journal(live_session_id,kind,text,payload_bytes,arrived_at) VALUES (?,'remember_deferred','299',3,?)", [id, NOW]);
    const row = tx.get("SELECT kind,text FROM live_journal WHERE live_session_id=? AND kind='remember_deferred'", [id]);
    assert.deepEqual({ ...row }, { kind: 'remember_deferred', text: '299' });
    assert.throws(() => tx.run("INSERT INTO live_journal(live_session_id,kind,payload_bytes,arrived_at) VALUES (?,'unknown_kind',0,?)", [id, NOW]));
  });
  const owners = migrated.transaction(tx => tx.all('SELECT owner, MAX(version) AS version FROM runtime_migrations GROUP BY owner ORDER BY owner'));
  assert.deepEqual(owners.map(row => [String(row['owner']), Number(row['version'])]),
    [chatMigrations, domainMigrations, liveMigrations].map(migrations => [migrations[0]!.owner, Math.max(...migrations.map(migration => migration.version))]));
});

test('U1-R2: the v7 live migration preserves every v6 journal row, its index and its foreign key, and admits a researchProgress row', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-v7-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const domain = createDomainPort({ outbox: Outbox });
  const columns = 'journal_id,live_session_id,provider_sequence,kind,text,finished,value,terminal_outcome,rejected_kind,rejected_sequence,payload_bytes,arrived_at';
  const kinds = ['inputTranscription', 'outputTranscription', 'ready', 'interrupted', 'generationComplete', 'turnComplete', 'waitingForInput', 'terminal', 'toolCall', 'toolResult', 'continuity', 'remember_deferred'];
  const v6 = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations.filter(migration => migration.version < 7)]);
  v6.transaction(tx => {
    tx.run(`INSERT INTO live_sessions(live_session_id,owner_assistant_id,authority_epoch,idempotency_key,fingerprint,client_id,audit_id,profile_identity,prompt_identity,lifecycle,dispatch_intent,ready,journal_events,journal_bytes,journal_complete,consumer_state,terminal_outcome,terminal_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'terminal',1,1,12,10,1,'ended',?,1,1,1)`,
      ['v6-live', v6.assistantId, v6.authorityEpoch, 'v6-key', 'fingerprint', 'client', 'audit', 'profile', 'prompt', JSON.stringify({ state: 'closed' })]);
    kinds.forEach((kind, index) => {
      const text = kind === 'inputTranscription' || kind === 'outputTranscription' ? `row ${index}` : kind === 'continuity' ? JSON.stringify({ event: 'resumed' }) : kind === 'remember_deferred' ? '5' : null;
      const outcome = kind === 'terminal' ? JSON.stringify({ state: 'closed' }) : null;
      tx.run(`INSERT INTO live_journal(${columns}) VALUES (?,?,'${index}',?,?,NULL,NULL,?,NULL,NULL,${index},${index})`, [100 + index, 'v6-live', kind, text, outcome]);
    });
  });
  const v6Rows = v6.transaction(tx => tx.all(`SELECT ${columns} FROM live_journal ORDER BY journal_id`));
  assert.equal(v6Rows.length, kinds.length);
  v6.close();

  const migrated = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  const rows = migrated.transaction(tx => tx.all(`SELECT ${columns} FROM live_journal ORDER BY journal_id`));
  assert.deepEqual(rows, v6Rows, 'every v6 journal row survives the v7 rebuild unchanged');
  const index = migrated.transaction(tx => tx.get("SELECT name FROM sqlite_master WHERE type='index' AND name='live_journal_session'"));
  assert.ok(index, 'the live_journal_session index survives the v7 rebuild');
  const tableSql = migrated.transaction(tx => String(tx.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='live_journal'")!['sql']));
  assert.match(tableSql, /REFERENCES live_sessions/, 'the journal foreign key survives the v7 rebuild');
  migrated.transaction(tx => tx.run(`INSERT INTO live_journal(${columns}) VALUES (200,'v6-live',NULL,'researchProgress','{}',NULL,NULL,NULL,NULL,NULL,0,99)`));
  assert.equal(migrated.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM live_journal WHERE kind='researchProgress'")!['n'])), 1, 'the v7 CHECK admits a researchProgress row');
  const migratedRows = migrated.transaction(tx => tx.all(`SELECT ${columns} FROM live_journal ORDER BY journal_id`));
  migrated.close();

  const reopened = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  assert.deepEqual(reopened.transaction(tx => tx.all(`SELECT ${columns} FROM live_journal ORDER BY journal_id`)), migratedRows, 'a second open is idempotent');
  reopened.close();
});

test('a failed store write aborts visibly and never fabricates a durable outcome', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.store.close();
  h.f.send({ serverContent: { inputTranscription: { text: 'after close' } } });
  await h.f.closed;
  const reopened = new Store(h.dir, [...createDomainPort({ outbox: Outbox }).migrations, ...chatMigrations, ...liveMigrations]);
  assert.equal(reopened.transaction(tx => String(tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!['lifecycle'])), 'active');
  assert.equal(reopened.transaction(tx => tx.get('SELECT terminal_outcome FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!['terminal_outcome']), null);
  assert.equal(reopened.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM live_journal WHERE kind='terminal'")!['n'])), 0);
  reopened.close();
  await assert.rejects(attachment.done);
});

test('real SIGKILL before dispatch intent sweeps to not_started and after intent to outcome_unknown', async t => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const address = f.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const domain = createDomainPort({ outbox: Outbox });
  const migrations = [...domain.migrations, ...chatMigrations, ...liveMigrations];
  const profile = validateLiveProfile(profileInput());
  const recoverOwner = (store: Store) => createLiveSessionOwner({
    store, voice: new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })), profile,
  });

  const before = await killChild(f, dir, port, 'accepted', 'before-intent');
  assert.equal(f.connections, 0, 'a session killed before intent never opened the adapter');
  let store = new Store(dir, migrations);
  let owner = recoverOwner(store);
  const swept = owner.get(before.liveSessionId);
  assert.deepEqual(swept.terminal, { state: 'not_started' });
  assert.equal(swept.journal.complete, false);
  assert.ok(owner.listFragments({ liveSessionId: before.liveSessionId }).fragments.some(fragment => fragment.kind === 'terminal'));
  await owner.shutdown();
  store.close();

  const afterIntent = await killChild(f, dir, port, 'intent', 'after-intent');
  assert.equal(f.connections, 1, 'exactly one adapter open before the crash');
  store = new Store(dir, migrations);
  owner = recoverOwner(store);
  const recovered = owner.get(afterIntent.liveSessionId);
  assert.deepEqual(recovered.terminal, { state: 'outcome_unknown' });
  assert.equal(recovered.dispatchIntent, true);
  assert.equal(f.connections, 1, 'recovery never opens a second adapter');
  assert.ok(owner.listFragments({ liveSessionId: afterIntent.liveSessionId }).fragments.length >= 1, 'a recovered session stays locally readable');
  await owner.shutdown();
  store.close();
});

async function killChild(f: Awaited<ReturnType<typeof fixture>>, dir: string, port: number, mode: string, key: string): Promise<{ liveSessionId: string }> {
  const child = fork(new URL('./live-session-process.js', import.meta.url), [mode, dir, String(port), key], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    const created = await nextMessage(child, 'created');
    const liveSessionId = String(created['liveSessionId']);
    if (mode === 'intent') {
      await f.frame(1);
      f.send({ setupComplete: {} });
      await nextMessage(child, 'intent');
    }
    return { liveSessionId };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
}

function nextMessage(child: ReturnType<typeof fork>, phase: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${phase} message`)), 10_000);
    child.on('message', (message: Record<string, unknown>) => { if (message['phase'] === phase) { clearTimeout(timer); resolve(message); } });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`child exited before ${phase}`)); });
  });
}

test('the owner disposes before Store.close and refuses work afterwards', async t => {
  const h = await harness(t);
  const { attachment } = await attached(h);
  await h.owner.shutdown();
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'closed' });
  assert.throws(() => h.owner.get('missing'), (error: unknown) => error instanceof LiveError);
  await h.owner.shutdown();
});

test('accepted unused observations and same-key replay expire without attach, strictly past the boundary', async t => {
  let resolutions = 0;
  const h = await harness(t, { limits: { unusedMs: 20 }, credentials: { resolve: async () => { resolutions++; return CANARY; } } });
  const create = (key: string) => h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  const read = create('unused-read'), replay = create('unused-replay'), fragments = create('unused-fragments');
  h.advance(20);
  assert.equal(h.owner.get(read.liveSessionId).lifecycle, 'accepted');
  assert.equal(create('unused-replay').lifecycle, 'accepted');
  h.advance(1);
  assert.equal(h.owner.get(read.liveSessionId).terminal?.state, 'expired');
  assert.equal(create('unused-replay').terminal?.state, 'expired');
  assert.equal(h.owner.listFragments({ liveSessionId: fragments.liveSessionId }).fragments.length, 1);
  assert.equal(h.owner.get(fragments.liveSessionId).terminal?.state, 'expired');
  assert.throws(() => h.owner.create({ idempotencyKey: 'unused-replay', inputClass: 'private' }, h.ctx), { code: 'idempotency_conflict' });
  for (const row of [read, replay, fragments]) {
    assert.equal(h.owner.get(row.liveSessionId).terminal?.state, 'expired');
    assert.equal(h.owner.listFragments({ liveSessionId: row.liveSessionId }).fragments.length, 1);
    assert.throws(() => h.owner.attach({ liveSessionId: row.liveSessionId }, h.ctx), { code: 'terminal' });
  }
  assert.equal(resolutions, 0);
  assert.equal(h.f.attempts, 0);
});


/** Trusted scheduler: callbacks run only when the shared injected clock is advanced explicitly. */
class DeadlineClock {
  now = NOW;
  unrefs = 0;
  maxPending = 0;
  callbacks = 0;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  lastCallback: (() => void) | undefined;
  schedule = (callback: () => void, delayMs: number) => {
    assert.ok(delayMs > 0, 'strict boundary must not cause a zero-delay loop');
    const entry = { due: this.now + delayMs, callback };
    this.pending.add(entry);
    this.maxPending = Math.max(this.maxPending, this.pending.size);
    this.lastCallback = callback;
    return { unref: () => { this.unrefs++; }, cancel: () => { this.pending.delete(entry); } };
  };
  runDue(): void {
    for (;;) {
      const entry = [...this.pending].find(item => item.due <= this.now);
      if (!entry) return;
      assert.ok(++this.callbacks < 100, 'bounded callbacks, no busy loop');
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

test('one unref timer autonomously settles multiple deadlines and survives invalidation', async t => {
  const scheduler = new DeadlineClock();
  let credentials = 0;
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 }, credentials: { resolve: async () => { credentials++; return CANARY; } } });
  const first = h.owner.create({ idempotencyKey: 'deadline-first', inputClass: 'ordinary' }, h.ctx);
  h.advance(5);
  const later = h.owner.create({ idempotencyKey: 'deadline-later', inputClass: 'ordinary' }, h.ctx);
  assert.equal(scheduler.pending.size, 1);
  h.advance(15); scheduler.runDue();
  assert.equal(scheduler.callbacks, 0);
  h.advance(1); scheduler.runDue();
  const counts = () => h.store.transaction(tx => tx.all("SELECT live_session_id, COUNT(*) AS n FROM live_journal WHERE kind='terminal' GROUP BY live_session_id"));
  assert.deepEqual(counts().map(row => ({ ...row })), [{ live_session_id: first.liveSessionId, n: 1 }]);
  assert.equal(scheduler.pending.size, 1);
  h.owner.invalidate('authority');
  h.advance(5); scheduler.runDue();
  assert.equal(counts().length, 2);
  assert.equal(h.owner.get(later.liveSessionId).terminal?.state, 'expired');
  assert.equal(h.owner.get(first.liveSessionId).terminal?.state, 'expired');
  assert.equal(scheduler.pending.size, 0);
  assert.equal(scheduler.maxPending, 1);
  assert.equal(scheduler.callbacks, 2);
  assert.ok(scheduler.unrefs >= 2);
  assert.equal(credentials, 0);
  assert.equal(h.f.attempts, 0);
});

test('expiry transactions roll back real storage failure on observation and autonomous timer', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  const row = h.owner.create({ idempotencyKey: 'deadline-fault', inputClass: 'ordinary' }, h.ctx);
  const failure = new Error('synthetic transaction storage failure');
  const original = h.store.transaction.bind(h.store);
  let fail = true;
  t.mock.method(h.store, 'transaction', (body: (tx: Transaction) => unknown) => original(tx => {
    const result = body(tx);
    if (fail) throw failure;
    return result;
  }));
  h.advance(21);
  assert.throws(() => h.owner.get(row.liveSessionId), error => error === failure);
  assert.throws(() => scheduler.runDue(), error => error === failure);
  assert.equal(scheduler.pending.size, 0, 'a failed callback must not silently retry');
  fail = false;
  assert.equal(original(tx => tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [row.liveSessionId]))?.['lifecycle'], 'accepted');
  assert.equal(original(tx => tx.all("SELECT * FROM live_journal WHERE kind='terminal'")).length, 0);
  assert.equal(h.owner.get(row.liveSessionId).terminal?.state, 'expired');
  assert.equal(h.f.attempts, 0);
});

test('shutdown cancels the deadline synchronously and fences already queued callbacks after Store close', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  h.owner.create({ idempotencyKey: 'deadline-shutdown', inputClass: 'ordinary' }, h.ctx);
  assert.equal(scheduler.pending.size, 1);
  const queued = scheduler.lastCallback!;
  const closing = h.owner.shutdown();
  assert.equal(scheduler.pending.size, 0);
  await closing;
  h.store.close();
  h.advance(21);
  assert.doesNotThrow(queued);
  assert.equal(scheduler.pending.size, 0);
  assert.equal(h.f.attempts, 0);
});

test('current deadline query plan measures unrelated terminal history without a cap', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  const measurements: Array<{ history: number; elapsedMs: number; accepted: number; due: number }> = [];
  const measure = (history: number) => {
    const start = performance.now();
    const result = h.store.transaction(tx => ({
      accepted: tx.all("SELECT live_session_id FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0", [h.store.assistantId]).length,
      due: tx.all("SELECT live_session_id FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0 AND created_at < ?", [h.store.assistantId, scheduler.now - 20]).length,
    }));
    measurements.push({ history, elapsedMs: performance.now() - start, ...result });
  };
  measure(0);
  for (let i = 0; i < 1000; i++) {
    const row = h.owner.create({ idempotencyKey: `history-${i}`, inputClass: 'ordinary' }, h.ctx);
    h.owner.revoke(row.liveSessionId);
    if (i === 99 || i === 999) measure(i + 1);
  }
  const accepted = h.owner.create({ idempotencyKey: 'plan-accepted', inputClass: 'ordinary' }, h.ctx);
  const plans = h.store.transaction(tx => ({
    next: tx.all("EXPLAIN QUERY PLAN SELECT MIN(created_at) AS created_at FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0", [h.store.assistantId]),
    due: tx.all("EXPLAIN QUERY PLAN SELECT * FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0 AND created_at < ?", [h.store.assistantId, scheduler.now - 20]),
  }));
  t.diagnostic(JSON.stringify({ terminalHistory: 1000, measurements, plans }));
  assert.ok(plans.next.every(row => String(row['detail']).includes('INDEX')));
  assert.ok(plans.due.every(row => String(row['detail']).includes('INDEX')));
  h.advance(21); scheduler.runDue();
  assert.equal(h.owner.get(accepted.liveSessionId).terminal?.state, 'expired');
  assert.equal(h.store.transaction(tx => tx.all("SELECT live_session_id FROM live_sessions WHERE lifecycle='terminal'")).length, 1001);
  assert.equal(scheduler.maxPending, 1);
});


test('timer storage failure is a causal uncaught process failure with durable rollback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-expiry-fault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `
    import { Store } from ${JSON.stringify(new URL('../runtime/store.js', import.meta.url).href)};
    import { createLiveSessionOwner, validateLiveProfile, liveMigrations } from ${JSON.stringify(new URL('../live/index.js', import.meta.url).href)};
    const store = new Store(${JSON.stringify(dir)}, liveMigrations);
    let clock = ${NOW}, callback;
    const owner = createLiveSessionOwner({ store, profile: validateLiveProfile(${JSON.stringify(profileInput({ unusedMs: 20 }))}),
      now: () => clock, voice: { open() { throw new Error('unexpected provider open'); } },
      schedule(fn) { callback = fn; return { unref() {}, cancel() {} }; } });
    const row = owner.create({ idempotencyKey: 'child-fault', inputClass: 'ordinary' }, { clientId: 'tester', auditId: 'fault', authorityEpoch: store.authorityEpoch });
    process.stdout.write(row.liveSessionId);
    const transaction = store.transaction.bind(store);
    store.transaction = body => transaction(tx => { const result = body(tx); throw new Error('LIVE-EXPIRY-CAUSAL-STORAGE-FAILURE'); });
    clock += 21;
    setImmediate(() => callback());
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.match(stderr, /LIVE-EXPIRY-CAUSAL-STORAGE-FAILURE/);
  assert.match(stdout, /^[a-f0-9-]{36}$/);
  const store = new Store(dir, liveMigrations);
  t.after(() => store.close());
  assert.equal(store.transaction(tx => tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [stdout]))?.['lifecycle'], 'accepted');
  assert.equal(store.transaction(tx => tx.all('SELECT * FROM live_journal')).length, 0);
  t.diagnostic('isolated child exit=1 signal=null; causal storage error preserved; transaction rolled back');
});

test('attach wins before deadline including opening, and expiry wins after it without open', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { unusedMs: 20 } });
  const row = h.owner.create({ idempotencyKey: 'deadline-attach', inputClass: 'ordinary' }, h.ctx);
  h.advance(20);
  const original = GeminiLiveVoiceAdapter.prototype.open;
  t.mock.method(GeminiLiveVoiceAdapter.prototype, 'open', function(this: GeminiLiveVoiceAdapter, ...args: Parameters<typeof original>) {
    h.advance(1); scheduler.runDue();
    assert.equal(h.owner.get(row.liveSessionId).lifecycle, 'opening');
    return original.apply(this, args);
  });
  const attachment = h.owner.attach({ liveSessionId: row.liveSessionId }, h.ctx);
  assert.equal(h.owner.get(row.liveSessionId).lifecycle, 'active');
  await h.f.connected;
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  h.advance(100); scheduler.runDue();
  assert.equal(h.owner.get(row.liveSessionId).lifecycle, 'active');
  assert.equal(scheduler.pending.size, 3, 'only the session window, the call deadline and the idle budget remain');
  t.mock.restoreAll();
  const past = h.owner.create({ idempotencyKey: 'deadline-attach-late', inputClass: 'ordinary' }, h.ctx);
  h.advance(21);
  assert.throws(() => h.owner.attach({ liveSessionId: past.liveSessionId }, h.ctx), { code: 'expired' });
  assert.equal(h.f.attempts, 1);
  await h.owner.shutdown();
  assert.equal(scheduler.pending.size, 0);
  assert.equal((await attachment.done).terminal?.state, 'closed');
});


test('trusted clock rejects fractional milliseconds and maximum timer delay stays bounded', async t => {
  const h = await harness(t);
  assert.throws(() => createLiveSessionOwner({ store: h.store, voice: { capabilities: fakeLiveVoicePort().port.capabilities, open() { throw new Error('unexpected open'); } }, profile: validateLiveProfile(profileInput()), now: () => NOW + 0.5 }), { code: 'invalid_config' });
  const scheduler = new DeadlineClock();
  const max = await harness(t, { scheduler, limits: { unusedMs: 2_147_483_647 } });
  const row = max.owner.create({ idempotencyKey: 'deadline-max', inputClass: 'ordinary' }, max.ctx);
  assert.equal([...scheduler.pending][0]!.due - scheduler.now, 2_147_483_647);
  max.advance(2_147_483_647); scheduler.runDue();
  assert.equal(max.owner.get(row.liveSessionId).lifecycle, 'accepted');
  assert.equal([...scheduler.pending][0]!.due - scheduler.now, 1);
  max.advance(1); scheduler.runDue();
  assert.equal(max.owner.get(row.liveSessionId).terminal?.state, 'expired');
  assert.equal(scheduler.callbacks, 2);
});

test('Live persists the exact typed accepted instruction before intent and corrupt records fail before provider open', async t => {
  const h = await harness(t);
  let calls = 0;
  const ownerProfile = { schemaVersion: 1, kind: 'profile', ownerId: h.store.assistantId, profileVersion: 'fixture-a', displayName: 'Example',
    style: { text: 'SYNTHETIC A', dataClass: 'ordinary' }, lore: { text: 'SYNTHETIC lore', dataClass: 'ordinary' } };
  const acceptedPrompt = { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION, system: 'SYNTHETIC exact accepted A', dataClasses: ['ordinary'] };
  const owner = createLiveSessionOwner({ store: h.store,
    profile: validateLiveProfile({ ...profileInput(), acceptedPrompt }),
    voice: { capabilities: fakeLiveVoicePort().port.capabilities, open() { calls++; throw new Error('synthetic unavailable'); } }, now: () => NOW });
  t.after(() => owner.shutdown());
  const run = owner.create({ idempotencyKey: 'owner-frozen', inputClass: 'ordinary' }, h.ctx);
  const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,dispatch_intent FROM live_sessions WHERE live_session_id=?', [run.liveSessionId]))!;
  assert.equal(row.dispatch_intent, 0);
  assert.deepEqual(JSON.parse(String(row.accepted_prompt_snapshot)), { ...acceptedPrompt, memory: { status: 'empty', selectedIds: [], omitted: [] } });
  acceptedPrompt.system = 'SYNTHETIC B';
  assert.equal(JSON.parse(String(h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [run.liveSessionId]))!.accepted_prompt_snapshot)).system, 'SYNTHETIC exact accepted A');
  h.store.transaction(tx => tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=? WHERE live_session_id=?', ['{"schemaVersion":999}', run.liveSessionId]));
  assert.throws(() => owner.attach({ liveSessionId: run.liveSessionId }, h.ctx));
  assert.equal(calls, 0);
});


test('private style alone and sensitive lore alone deny voice before adapter or socket creation', async t => {
  const h = await harness(t);
  for (const [styleClass, loreClass] of [['private', 'ordinary'], ['ordinary', 'sensitive']] as const) {
    let calls = 0;
    const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: h.store.assistantId, profileVersion: 'fixture', displayName: 'Example',
      style: { text: 'SYNTHETIC style', dataClass: styleClass }, lore: { text: 'SYNTHETIC lore', dataClass: loreClass } };
    const owner = createLiveSessionOwner({ store: h.store, profile: validateLiveProfile({ ...profileInput(),
      acceptedPrompt: { schemaVersion: 1, ownerProfile, compilerVersion: PROMPT_VERSION, system: 'SYNTHETIC instruction', dataClasses: ['ordinary', styleClass, loreClass].filter((c, i, cs) => cs.indexOf(c) === i) } }),
      voice: { capabilities: fakeLiveVoicePort().port.capabilities, open() { calls++; throw Error('must not open'); } }, now: () => NOW });
    assert.throws(() => owner.create({ idempotencyKey: `denied-${styleClass}-${loreClass}`, inputClass: 'ordinary' }, h.ctx));
    assert.equal(calls, 0); await owner.shutdown();
  }
});

test('Live emits exact accepted A setup, not a changed caller B instruction', async t => {
  const h = await harness(t);
  const acceptedPrompt = { schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId: h.store.assistantId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: 'SYNTHETIC exact wire A', dataClasses: ['ordinary'] };
  const profile = validateLiveProfile({ ...profileInput(), acceptedPrompt });
  const voice = new GeminiLiveVoiceAdapter(options({ socketFactory: h.f.socketFactory,
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: { resolve: async () => CANARY } }));
  const owner = createLiveSessionOwner({ store: h.store, profile, voice, now: () => NOW }); t.after(() => owner.shutdown());
  const accepted = owner.create({ idempotencyKey: 'wire-a', inputClass: 'ordinary' }, h.ctx);
  acceptedPrompt.system = 'SYNTHETIC current B';
  const attachment = owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx);
  await h.f.frame(1);
  const frame = JSON.parse(JSON.stringify(h.f.frames[0]));
  assert.equal(frame.setup.systemInstruction.parts[0].text, 'SYNTHETIC exact wire A');
  attachment.close();
});

test('legacy null and unsupported accepted Live bindings refuse honestly before dispatch intent', async t => {
  const h = await harness(t);
  for (const snapshot of [null, JSON.stringify({ schemaVersion: 1, compilerVersion: 'unsupported', system: 'synthetic', dataClasses: ['ordinary'],
    ownerProfile: { schemaVersion: 1, kind: 'default', ownerId: h.store.assistantId, displayName: 'Lux Didi' } })]) {
    const accepted = h.owner.create({ idempotencyKey: `legacy-${snapshot === null}`, inputClass: 'ordinary' }, h.ctx);
    h.store.transaction(tx => tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=? WHERE live_session_id=?', [snapshot, accepted.liveSessionId]));
    assert.throws(() => h.owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx), { code: 'invalidated' });
    assert.equal(h.owner.get(accepted.liveSessionId).dispatchIntent, false);
    assert.equal(h.f.frames.length, 0);
  }
});

test('Live keeps no background tool job and never delivers a result to an ended session', async t => {
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness(t, { tools: true, beforeTool: () => work });
  const { session } = await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'detached1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  h.owner.revoke(session.liveSessionId);
  finish();
  await tick(); await tick();
  assert.equal(new LiveToolJobs(h.store, () => NOW).pending().length, 0, 'Live never defers a tool call');
  assert.equal(h.owner.pendingJobs().length, 0);
  assert.equal(h.f.frames.length, 1, 'completion cannot send to the ended Gemini session');
});

test('Live awaits a slow tool call inline and never creates a background job', async t => {
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness(t, { tools: true, beforeTool: () => slow });
  await attached(h);
  assert.equal((h.requests[0] as LiveVoiceRequest & { opening?: string }).opening, 'model_first');
  h.f.send({ toolCall: { functionCalls: [{ id: 'slow1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  assert.equal(new LiveToolJobs(h.store, () => NOW).pending().length, 0, 'Live never defers a tool call');
  finish();
  await h.f.frame(2);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string; response: unknown }[] } };
  assert.equal(response.toolResponse.functionResponses[0]!.id, 'slow1');
  assert.match(JSON.stringify(response.toolResponse.functionResponses[0]!.response), /Synthetic insight/);
  assert.equal(h.owner.pendingJobs().length, 0, 'no background result is retained');
});

test('a tool batch resolving late still completes inline in the same turn', async t => {
  for (const callId of ['late4500', 'late20000']) {
    const h = await harness(t, { tools: true });
    await attached(h);
    h.f.send({ toolCall: { functionCalls: [{ id: callId, name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
    await h.f.frame(2);
    const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string; response: unknown }[] } };
    assert.equal(response.toolResponse.functionResponses[0]!.id, callId);
    assert.match(JSON.stringify(response.toolResponse.functionResponses[0]!.response), /Synthetic insight/);
  }
});

test('F2 the live tool steps retire when the turn completes, never into the next question', async t => {
  const h = await harness(t, { tools: true });
  await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'step1', name: 'search_knowledge', args: { query: 'release freeze', limit: 1 } }] } });
  const waitFor = async (want: (steps: import('../live/types.js').LivePageProjection['steps']) => boolean): Promise<import('../live/types.js').LivePageProjection['steps']> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const steps = h.owner.current().steps;
      if (want(steps)) return steps;
      await tick();
    }
    throw new Error('the step list never reached the expected state');
  };
  const running = await waitFor(steps => (steps ?? []).length > 0);
  assert.equal(running![0]!.phase, 'start', 'the source being read is projected under the orb while it runs');
  assert.equal(running![0]!.callId, 'step1');
  assert.equal(running![0]!.subject, 'release freeze');
  await h.f.frame(2);
  const ended = await waitFor(steps => (steps ?? [])[0]?.phase === 'end');
  assert.equal(ended![0]!.ok, true);
  h.f.send({ serverContent: { outputTranscription: { text: 'Here is the answer.', finished: true }, turnComplete: true } });
  await waitFor(steps => steps === undefined);
  assert.equal(h.owner.current().steps, undefined, 'the finished answer retires the list, so the next question shows nothing stale');
});

test('a tool call past its deadline returns the typed timeout failure stage inline', async t => {
  const h = await harness(t, { tools: true, beforeTool: () => Promise.reject(new Error('connector deadline')) });
  await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'late30', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await h.f.frame(2);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string; response: { error?: string } }[] } };
  assert.ok(response.toolResponse.functionResponses[0]!.response.error, 'the deadline failure is sent inline');
});


test('a tool result after a barge-in interruption is sent once and recorded after_barge_in', async t => {
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness(t, { tools: true, beforeTool: () => slow });
  const { session, attachment } = await attached(h);
  const outputs = attachment.output[Symbol.asyncIterator]();
  assert.equal((await outputs.next()).value?.marker.kind, 'ready');
  h.f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  h.f.send({ serverContent: { interrupted: true } });
  let sawInterrupted = false;
  while (!sawInterrupted) {
    const item = await outputs.next();
    if (item.done) break;
    if (item.value.kind === 'marker' && item.value.marker.kind === 'interrupted') sawInterrupted = true;
  }
  assert.equal(sawInterrupted, true, 'the interrupted fact is journaled before the tool completes');
  finish(); await tick(); await tick();
  await h.f.frame(2);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string }[] } };
  assert.deepEqual(response.toolResponse.functionResponses.map(item => item.id), ['c1'], 'the late result is sent exactly once');
  assert.equal(h.f.frames.filter(frame => 'toolResponse' in (frame as object)).length, 1);
  let marked = false;
  for (let i = 0; i < 20 && !marked; i++) {
    const item = await outputs.next();
    if (item.done) break;
    if (item.value.kind === 'marker' && item.value.marker.kind === 'toolResult'
      && (item.value.marker.tool as { code?: string } | undefined)?.code === 'after_barge_in') marked = true;
  }
  assert.equal(marked, true, 'the batch disposition after_barge_in is recorded');
  h.owner.revoke(session.liveSessionId);
});

test('Live accepts a frozen real tool snapshot and projects only result-gated Markdown', async t => {
  const h = await harness(t, { tools: true });
  const { session, attachment } = await attached(h);
  assert.equal(h.owner.lookupAuthority(session.liveSessionId)?.actorId, h.ctx.clientId);
  const setup = (h.f.frames[0] as { setup: { tools: { functionDeclarations: { name: string; parameters: any }[] }[] } }).setup;
  // OC1 (#228): the host-native open tools are declared beside research and remember_note.
  assert.deepEqual(setup.tools[0]!.functionDeclarations.map(tool => tool.name).sort(), ['open_app', 'open_file', 'open_url', 'remember_note', 'research']);
  const derived = setup.tools[0]!.functionDeclarations.find(d => d.name === 'research')!;
  assert.equal(derived.parameters.properties.question.type, 'STRING');
  const outputs = attachment.output[Symbol.asyncIterator]();
  assert.equal((await outputs.next()).value?.marker.kind, 'ready');
  h.f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }, { id: 'c2', name: 'get_insight', args: { ids: [123] } }] } });
  await h.f.frame(2);
  assert.equal(h.calls.length, 2);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string }[] } };
  assert.deepEqual(response.toolResponse.functionResponses.map(r => r.id), ['c1', 'c2']);
  assert.equal(h.owner.current().state, 'thinking', 'the tool result keeps thinking until the first output audio (F1)');
  const page = h.owner.current();
  assert.equal(page.entries.filter(e => e.kind === 'toolCall').length, 2);
  const result = page.entries.find(e => e.kind === 'toolResult')!.tool!;
  assert.equal(result.status, 'completed'); assert.match(result.markdown!, /Synthetic insight/);
  assert.deepEqual(result.sources, [{ title: 'KB: Synthetic insight' }, { title: 'Evidence', url: 'https://example.test/evidence' }], 'cards follow first occurrence in approved evidence');
  assert.equal(JSON.stringify(page).includes('liveSessionId'), false);
  assert.equal(JSON.stringify(page).includes('args'), false);
  assert.equal(JSON.stringify(page).includes(CANARY), false);
  const marker = (await outputs.next()).value;
  assert.equal(marker?.marker.kind, 'toolCall');
  attachment.close(); await attachment.done;
  assert.equal(h.owner.lookupAuthority(session.liveSessionId), null);
});

test('Live refuses undeclared tools and original-schema-invalid arguments without dispatch', async t => {
  const h = await harness(t, { tools: true }); const { attachment } = await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'bad1', name: 'get_insight', args: { ids: '[123]', include_links: 'false' } }, { id: 'bad2', name: 'not_granted', args: {} }] } });
  await h.f.frame(2); assert.equal(h.calls.length, 0);
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { response: { error: string } }[] } };
  const errors = response.toolResponse.functionResponses.map(r => r.response.error);
  assert.match(errors[0]!, /Invalid arguments for get_insight/, 'an invalid get_insight refusal carries one-try guidance');
  assert.equal(errors[1], 'unknown_tool');
  assert.equal(h.owner.current().entries.filter(e => e.kind === 'toolResult' && e.tool?.status === 'error').length, 2);
  attachment.close(); await attachment.done;
});

test('Live revocation invalidates authority and discards an in-flight result', async t => {
  const started = deferred<void>(), finish = deferred<void>();
  const h = await harness(t, { tools: true, beforeTool: async () => { started.resolve(); await finish.promise; } });
  const { session, attachment } = await attached(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'late', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await started.promise; assert.equal(h.owner.current().state, 'thinking');
  h.owner.revoke(session.liveSessionId); assert.equal(h.owner.lookupAuthority(session.liveSessionId), null);
  finish.resolve(); await attachment.done;
  assert.equal(h.f.frames.length, 1);
  assert.equal(h.owner.current().entries.filter(e => e.kind === 'toolResult').length, 0);
});

test('shared declarations retain original schemas and tool policy refuses before invocation', async () => {
  let invoked = 0; const ref = { id: 'r', sha256: 'a'.repeat(64) };
  const tool: ToolDefinition = { name: 'test', description: 'Test', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] }, enabled: { type: 'boolean' }, ids: { type: 'array', items: { type: 'integer' } } } },
    effect: 'read', accountId: 'a', resourceId: 'r', validate: args => typeof (args as { enabled?: unknown }).enabled === 'boolean', execute: async () => { invoked++; return { status: 'completed', result: ref }; } };
  const { declarations, originalByName } = declarationsFor([tool]);
  assert.deepEqual(originalByName.get('test'), tool.parameters); assert.notDeepEqual(declarations[0]!.parameters, tool.parameters);
  const host: HostContext = { runId: 'run', actorId: 'actor', authorityEpoch: 'epoch', revision: 0, grants: [] };
  const owner = { journal: { intent: () => 'fresh' as const, refuse: () => ref, fail: () => ref }, resultGate: { authorize: async (_host: HostContext, bindings: readonly import('../adapters/model/types.js').ToolResultBinding[]) => ({ state: 'allowed' as const, results: bindings.map(binding => ({ binding, response: { text: 'Accepted' }, dataClasses: [] })) }) } };
  const ctx = { registry: [tool], host, authority: { isCurrent: async () => false }, control: control(), step: 1, contentIndex: 0, seenIds: new Set<string>(), baseClasses: [] as const, authorize: true };
  const grant = await runToolCalls(owner, [{ id: 'g', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(grant.tools[0]!.reason, 'grant_not_permitted'); assert.equal(invoked, 0);
  host.grants.push({ tool: 'test', effect: 'read', accountId: 'a', resourceId: 'r' });
  const revoked = await runToolCalls(owner, [{ id: 'r', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(revoked.tools[0]!.reason, 'stale_or_revoked_authority'); assert.equal(invoked, 0);
  ctx.authority.isCurrent = async () => true;
  const completed = await runToolCalls(owner, [{ id: 'c', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(completed.tools[0]!.status, 'completed'); assert.equal(invoked, 1);
  tool.execute = async () => { throw Error(CANARY); };
  const failed = await runToolCalls(owner, [{ id: 'f', name: 'test', args: { enabled: true } }], ctx);
  assert.equal(failed.tools[0]!.status, 'failed'); assert.equal(JSON.stringify(failed).includes(CANARY), false);
});

function writePrivate(dir: string, name: string, text: string): void {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('Live attach setup carries the composed Naya instruction and the bare language code', async t => {
  const h = await harness(t);
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC local overlay persona', greeting: 'Synthetic greeting' };
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'de' });
  assert.ok(composed.text.includes(NAYA_LIVE_BASE), 'composed instruction carries the public base');
  const acceptedPrompt = { schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId: h.store.assistantId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: composed.text, dataClasses: ['ordinary'] };
  const profile = validateLiveProfile({ ...profileInput(), language: 'de', acceptedPrompt });
  const voice = new GeminiLiveVoiceAdapter(options({ socketFactory: h.f.socketFactory,
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: profile.liveModelId, dataClasses: profile.route.dataClasses },
    credentials: { resolve: async () => CANARY } }));
  const owner = createLiveSessionOwner({ store: h.store, profile, voice, now: () => NOW, timeZone: 'Asia/Kolkata' }); t.after(() => owner.shutdown());
  const accepted = owner.create({ idempotencyKey: 'wire-naya', inputClass: 'ordinary' }, h.ctx);
  const attachment = owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx);
  await h.f.frame(1);
  const frame = JSON.parse(JSON.stringify(h.f.frames[0]));
  const expectedWithRuntime = composeLiveSessionInstruction({ text: composed.text, tools: [], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    runtimeContext: buildRuntimeContext({ now: new Date(NOW), timeZone: 'Asia/Kolkata', connected: [], unavailable: [] }) }).text;
  assert.equal(frame.setup.systemInstruction.parts[0].text, expectedWithRuntime);
  assert.equal(frame.setup.generationConfig.speechConfig.languageCode, 'de');
  attachment.close();
});

test('loadLiveConfig keeps public prompt bytes and composes classified owner sections into the accepted Live system', async t => {
  const root = mkdtempSync(join(tmpdir(), 'didi-live-config-'));
  const dataDir = join(root, 'data'); const configDir = join(dataDir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700); chmodSync(configDir, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
    dataClasses: ['ordinary', 'private', 'sensitive'], preferences: { dataClass: 'ordinary', language: 'de-de', register: 'plain', humor: 'dry', verbosity: 'brief' } };
  writePrivate(configDir, 'live.json', `${JSON.stringify(live)}\n`);
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC local overlay persona', greeting: 'Synthetic greeting', accent: 'Synthetic accent' };
  writePrivate(dataDir, 'persona-overlay.json', JSON.stringify(overlay));
  const style = `SYNTHETIC owner style ${'S'.repeat(3000)}`;
  const lore = `SYNTHETIC owner lore ${'L'.repeat(3_000)}`;
  const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: style, dataClass: 'private' as const }, lore: { text: lore, dataClass: 'sensitive' as const } };
  const status = loadLiveConfig({ configDir, ownerId: 'synthetic-owner', ownerProfile });
  assert.equal(status.status, 'configured');
  if (status.status === 'configured') {
    const expected = composeLiveInstruction({ base: NAYA_LIVE_BASE, accent: overlay.accent, language: 'de' });
    const accepted = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, accent: overlay.accent, language: 'de' });
    assert.deepEqual(status.config.profile.overlay, overlay);
    assert.equal(status.config.profile.language, 'de-DE', 'the owner regional tag is kept for the setup frame');
    assert.equal(status.config.profile.prompt.text, expected.text);
    assert.equal(status.config.profile.acceptedPrompt?.system, accepted.text);
    assert.ok(accepted.text.length > 4096);
    assert.equal(accepted.text.split(style).length - 1, 1); assert.equal(accepted.text.split(lore).length - 1, 1);
    assert.deepEqual(status.config.profile.acceptedPrompt?.dataClasses, ['ordinary', 'private', 'sensitive']);
  }
  writePrivate(dataDir, 'persona-overlay.json', '{ not json');
  const bad = loadLiveConfig({ configDir, ownerId: 'synthetic-owner', ownerProfile });
  assert.equal(bad.status, 'error');
  if (bad.status === 'error') assert.equal(bad.code, 'invalid_overlay');
});

test('loadLiveConfig accepts a base prompt past the 4096 identifier bound while it stays inside the live hard limit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'didi-live-config-big-base-'));
  const dataDir = join(root, 'data'); const configDir = join(dataDir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700); chmodSync(configDir, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
    dataClasses: ['ordinary', 'private', 'sensitive'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } };
  writePrivate(configDir, 'live.json', `${JSON.stringify(live)}\n`);
  // The frozen base character plus a long authored accent is a PROMPT, not a 4096-byte identifier: it is
  // bounded by the live instruction hard limit, the shape P3's enlarged Naya character produces.
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC local overlay persona', greeting: 'Synthetic greeting', accent: `Synthetic accent ${'A'.repeat(1200)}` };
  writePrivate(dataDir, 'persona-overlay.json', JSON.stringify(overlay));
  const status = loadLiveConfig({ configDir, ownerId: 'synthetic-owner' });
  assert.equal(status.status, 'configured');
  if (status.status === 'configured') {
    const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, accent: overlay.accent, language: 'en' });
    assert.ok(composed.text.length > 4_096 && composed.text.length <= LIVE_INSTRUCTION_HARD_LIMIT, `base prompt ${composed.text.length} chars`);
    assert.equal(status.config.profile.prompt.text, composed.text);
  }
});

test('configured owner system survives CREATE and attach open byte for byte before provider setup', async t => {
  const f = await fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'didi-live-owner-reopen-'));
  const dataDir = join(root, 'data'); const configDir = join(dataDir, 'provider-config'); const storeDir = join(root, 'store');
  mkdirSync(configDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700); chmodSync(configDir, 0o700);
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(storeDir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const live = { schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.1-flash-live-preview', voice: 'Aoede', keyReference: 'gemini-primary',
    dataClasses: ['ordinary', 'private'], preferences: { dataClass: 'ordinary', language: 'en', register: 'plain', humor: 'dry', verbosity: 'brief' } };
  writePrivate(configDir, 'live.json', JSON.stringify(live));
  const ownerProfile = { schemaVersion: 1 as const, kind: 'profile' as const, ownerId: store.assistantId, profileVersion: 'fixture', displayName: 'Example',
    style: { text: 'SYNTHETIC reopen style', dataClass: 'private' as const }, lore: { text: 'SYNTHETIC reopen lore', dataClass: 'ordinary' as const } };
  const status = loadLiveConfig({ configDir, ownerId: store.assistantId, ownerProfile });
  assert.equal(status.status, 'configured'); if (status.status !== 'configured') return;
  const expected = status.config.profile.acceptedPrompt!.system;
  const adapter = () => new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory,
    modelId: status.config.profile.liveModelId, voice: status.config.profile.voice, keyReference: status.config.profile.keyReference,
    route: { enabled: true, provider: 'gemini', modelId: status.config.profile.liveModelId, dataClasses: status.config.profile.route.dataClasses },
    credentials: { resolve: async () => CANARY } }));
  const first = createLiveSessionOwner({ store, profile: status.config.profile, voice: adapter(), now: () => NOW, timeZone: 'Asia/Kolkata' });
  const created = first.create({ idempotencyKey: 'owner-create', inputClass: 'ordinary' }, context(store));
  const persisted = store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [created.liveSessionId])!['accepted_prompt_snapshot'])));
  const expectedWithRuntime = composeLiveSessionInstruction({ text: expected, tools: [], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    runtimeContext: buildRuntimeContext({ now: new Date(NOW), timeZone: 'Asia/Kolkata', connected: [], unavailable: [] }) }).text;
  assert.equal(persisted.system, expectedWithRuntime); assert.deepEqual(persisted.dataClasses, ['ordinary', 'private']);
  const attachment = first.attach({ liveSessionId: created.liveSessionId }, context(store));
  await f.frame(1);
  const frame = JSON.parse(JSON.stringify(f.frames[0]));
  assert.equal(frame.setup.systemInstruction.parts[0].text, expectedWithRuntime);
  attachment.close(); await attachment.done; await first.shutdown();
});

test('provider voice activity journals listening and thinking without retaining its payload', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: {}, voiceActivity: { voiceActivityType: 'ACTIVITY_END', synthetic: 'not-journalled' } });
  await drain(h, session.liveSessionId, 2);
  assert.equal(h.owner.current().state, 'thinking');
  h.f.send({ serverContent: {}, voiceActivity: { voiceActivityType: 'ACTIVITY_START' } });
  await drain(h, session.liveSessionId, 3);
  assert.equal(h.owner.current().state, 'listening');
  const page = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 10 });
  assert.deepEqual(page.fragments.filter(f => f.kind === 'waitingForInput').map(f => f.value), [false, true]);
  assert.equal(JSON.stringify(page).includes('not-journalled'), false);
  attachment.close();
  await attachment.done;
});

test('resumption keeps journal identity and frozen authority with the real adapter', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-identity');
  const frozen = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,memory_provenance FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]));
  const handle = 'synthetic-owner-resumption-secret';
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(2);
  const setup = (h.f.frames[1] as { setup: { sessionResumption: { handle: string } } }).setup;
  assert.equal(setup.sessionResumption.handle === handle, true);
  const saved = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot,memory_provenance,resumption_handle,connection_generation FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!;
  assert.deepEqual({ accepted_prompt_snapshot: saved.accepted_prompt_snapshot, memory_provenance: saved.memory_provenance }, { ...frozen });
  assert.equal(saved.resumption_handle === handle, true);
  assert.equal(saved.connection_generation, 1);
  assert.equal(h.memorySelections, 1, 'memory selection is never re-run');
  assert.deepEqual(h.requests[1]!.tools, h.requests[0]!.tools);
  assert.deepEqual(h.requests[1]!.system, h.requests[0]!.system);
  assert.equal(h.owner.current().state, 'rebuilding');
  const beforeLate = h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.length;
  h.f.clients[0]!.emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-stale-secret' }, toolCall: { functionCalls: [{ id: 'stale-call', name: 'not_admitted', args: {} }] }, serverContent: { inputTranscription: { text: 'stale row' } } })));
  h.f.clients[0]!.emit('close', 1008);
  await tick();
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.length, beforeLate, 'old callbacks cannot append or settle');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle === handle, true, 'old handle cannot replace the current candidate');
  assert.equal(JSON.stringify(h.owner.current()).includes(handle), false);
  h.f.send({ setupComplete: {} });
  // The public committed marker, not a timer, is the resumption acknowledgement.
  const output = attachment.output[Symbol.asyncIterator]();
  await continuity(output, 'resumed');
  assert.equal(h.owner.current().state, 'listening');
  attachment.close(); await attachment.done;
  const rows = h.store.transaction(tx => tx.all('SELECT journal_id,kind FROM live_journal WHERE live_session_id=? ORDER BY journal_id', [session.liveSessionId]));
  assert.equal(rows.filter(r => r.kind === 'terminal').length, 1);
  assert.equal(rows.filter(r => r.kind === 'continuity').length, 2);
  assert.equal(new Set(rows.map(r => r.journal_id)).size, rows.length);
});

test('pending tool call at the resume cut gets one lost result and never dispatches on the new connection', async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const h = await harness(t, { tools: true, beforeGate: async () => { entered.resolve(); await release.promise; } });
  t.after(() => release.resolve());
  const { session, attachment } = await attached(h, 'resume-lost-tool');
  const acceptance = h.store.transaction(tx => tx.get('SELECT acceptance_json,accepted_run_hash FROM live_tool_acceptances WHERE live_session_id=?', [session.liveSessionId]));
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-tool-resumption-secret' }, toolCall: { functionCalls: [{ id: 'lost-call', name: 'lux_search_knowledge', args: { query: 'test', limit: 1 } }] } });
  await entered.promise;
  assert.equal(h.calls.length, 0);
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(2);
  assert.equal(h.owner.current().state, 'rebuilding');
  const cut = h.owner.listFragments({ liveSessionId: session.liveSessionId });
  const lost = cut.fragments.filter(row => row.tool?.code === 'tool_call_lost_on_resume');
  assert.equal(lost.length, 1);
  assert.equal(lost[0]!.tool!.callId, 'lost-call');
  const rebuilding = cut.fragments.find(row => row.kind === 'continuity');
  assert.equal(rebuilding?.event, 'rebuilding');
  assert.equal(rebuilding?.text, null, 'continuity is typed, not transcript text');
  assert.deepEqual(h.store.transaction(tx => tx.get('SELECT acceptance_json,accepted_run_hash FROM live_tool_acceptances WHERE live_session_id=?', [session.liveSessionId])), acceptance);
  h.f.send({ setupComplete: {} });
  const output = attachment.output[Symbol.asyncIterator]();
  await continuity(output, 'resumed');
  release.resolve();
  // Let the rejected old dispatch gate and its catch finish without a clock wait.
  await tick(); await tick();
  assert.equal(h.calls.length, 0, 'old pending call is never dispatched');
  assert.equal(h.f.frames.some(frame => 'toolResponse' in (frame as object)), false);
  const after = h.owner.listFragments({ liveSessionId: session.liveSessionId });
  assert.equal(after.fragments.filter(row => row.tool?.code === 'tool_call_lost_on_resume').length, 1);
  assert.equal(after.fragments.length, cut.fragments.length + 1, 'only the resumed row crosses the generation fence');
  attachment.close(); await attachment.done;
});

async function continuity(output: AsyncIterator<import('../live/types.js').LiveOutputChunk>, event: 'rebuilding' | 'resumed') {
  for (;;) {
    const item = await output.next();
    assert.equal(item.done, false, 'consumer remains attached across the resume');
    if (item.value.kind === 'marker' && item.value.marker.kind === 'continuity' && item.value.marker.event === event) return item.value.marker;
  }
}

test('a resumed setup rejection falls back to one fresh seeded session with the journal history and pickup', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 600_000, idleMs: 600_000 } });
  const { session, attachment } = await attached(h, 'resume-policy');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-policy-resumption-secret' } });
  h.f.send({ serverContent: { inputTranscription: { text: 'first turn', finished: true } } });
  await transcription(output, 'first turn');
  h.f.send({ serverContent: { outputTranscription: { text: 'first answer', finished: true } } });
  await transcription(output, 'first answer');
  h.f.send({ serverContent: { inputTranscription: { text: 'second turn', finished: true } } });
  await transcription(output, 'second turn');
  // The resumed socket fails before it is ready, so the owner falls back to one fresh seeded setup.
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(2); h.f.remoteClose('', 1008);
  await advanceUntil(h.advance, scheduler, () => h.requests.length >= 3);
  assert.equal(h.requests[1]!.resumptionHandle, 'synthetic-policy-resumption-secret', 'the first recovery reuses the handle');
  const seeded = h.requests[2]!;
  assert.equal(seeded.resumptionHandle, undefined, 'the fresh seeded setup carries no handle');
  assert.equal(seeded.openingText, LIVE_RECOVERY_PICKUP, 'the pickup line replaces the fresh-call greeting');
  assert.deepEqual(seeded.history!.map(turn => [turn.role, turn.text]), [['user', 'first turn'], ['model', 'first answer'], ['user', 'second turn']], 'the journal turns are in order');
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 0, 'the call did not end');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('provider usage metadata is decoded and logged per turn, numbers only', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-usage-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'usage-log');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 5, totalTokenCount: 15 } });
  h.f.send({ serverContent: { inputTranscription: { text: 'after usage', finished: true } } });
  await transcription(output, 'after usage');
  const lines = readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; totalTokens?: number; promptTokens?: number; responseTokens?: number });
  const usage = lines.filter(line => line.event === 'live_context_usage');
  assert.equal(usage.length, 1);
  assert.deepEqual({ totalTokens: usage[0]!.totalTokens, promptTokens: usage[0]!.promptTokens, responseTokens: usage[0]!.responseTokens }, { totalTokens: 15, promptTokens: 10, responseTokens: 5 });
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('dead air after a tool response earns one neutral continuation input', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-nudge-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session, attachment } = await attached(h, 'dead-air');
  h.f.send({ toolCall: { functionCalls: [{ id: 'n1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await h.f.frame(h.f.frames.length + 1);
  h.advance(8000); scheduler.runDue();
  await h.f.frame(h.f.frames.length + 1);
  const nudges = h.f.frames.filter(frame => (frame as { realtimeInput?: { text?: string } }).realtimeInput?.text === 'Continue.');
  assert.equal(nudges.length, 1, 'exactly one neutral continuation input');
  const lines = readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string });
  assert.equal(lines.filter(line => line.event === 'live_dead_air_nudge').length, 1);
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('three consecutive failed recoveries end the call, each with its own new socket', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 600_000, idleMs: 600_000 } });
  const { session, attachment } = await attached(h, 'recovery-bound');
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-bound-resumption-secret' } });
  // Each recovery socket fails before it is ready; backoff is 0 s, then 2 s, then 5 s.
  h.f.remoteClose('', 1011);
  await h.f.frame(2); h.f.remoteClose('', 1011);
  await advanceUntil(h.advance, scheduler, () => h.f.connections >= 3);
  await h.f.frame(3); h.f.remoteClose('', 1011);
  await advanceUntil(h.advance, scheduler, () => h.f.connections >= 4);
  await h.f.frame(4); h.f.remoteClose('', 1011);
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.f.connections, 4, 'three failed recoveries, each a new socket, then the call ends');
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 1);
});

test('a healthy minute between drops resets the consecutive-failure count', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-reset-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 600_000, idleMs: 600_000 } });
  const { session, attachment } = await attached(h, 'recovery-reset');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-reset-resumption-secret' } });
  // Two failed recoveries, then a healthy minute: the next drop must count as attempt one again.
  h.f.remoteClose('', 1011);
  await h.f.frame(2); h.f.remoteClose('', 1011);
  await advanceUntil(h.advance, scheduler, () => h.f.connections >= 3);
  await h.f.frame(3); h.f.send({ setupComplete: {} }); await continuity(output, 'resumed');
  h.advance(60_000);
  h.f.remoteClose('', 1011);
  await advanceUntil(h.advance, scheduler, () => h.f.connections >= 4);
  await h.f.frame(4);
  const lines = readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; attempt?: number });
  const recoveries = lines.filter(line => line.event === 'live_recovery');
  assert.ok(recoveries.length >= 3, 'the recovery attempts were logged');
  assert.equal(recoveries.at(-1)!.attempt, 1, 'the healthy minute reset the consecutive-failure count');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('a provider session deadline continues in a new seeded window; the call ceiling ends the call', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 1000, callMaxMs: 1500, idleMs: 600_000 } });
  const { session, attachment } = await attached(h, 'session-continue');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ serverContent: { inputTranscription: { text: 'still here', finished: true } } });
  await transcription(output, 'still here');
  h.advance(1000); scheduler.runDue();
  await h.f.frame(2); h.f.send({ setupComplete: {} });
  assert.equal(h.requests[1]!.openingText, LIVE_RECOVERY_PICKUP, 'the session deadline continues through the fresh seeded path');
  assert.deepEqual(h.requests[1]!.history!.map(turn => [turn.role, turn.text]), [['user', 'still here']]);
  h.advance(500); scheduler.runDue();
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'session_timeout' }, 'only the call ceiling ends a call for time');
  assert.equal(h.f.connections, 2);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 1);
});

test('the owner hard deadline ends a call terminally while a continuation is in flight', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 1000, callMaxMs: 1600, idleMs: 600_000 } });
  const { session, attachment } = await attached(h, 'owner-hard-deadline');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ serverContent: { inputTranscription: { text: 'still here', finished: true } } });
  await transcription(output, 'still here');
  // The provider session limit is a window, not a call length: the call continues in a fresh seeded window.
  h.advance(1000); scheduler.runDue();
  await h.f.frame(2);
  assert.equal(h.requests[1]!.openingText, LIVE_RECOVERY_PICKUP, 'the provider session limit continues in a fresh seeded window');
  // Drop the fresh window before it is ready: the continuation is in flight in a recovery backoff.
  h.f.remoteClose('', 1011);
  await tick();
  h.advance(600); scheduler.runDue();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'failed', code: 'session_timeout' }, 'the owner hard deadline ends the call for time');
  assert.equal(h.f.connections, 2, 'the owner hard deadline continues nothing afterwards');
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'session_timeout' });
});

test('an unattended call ends at its session deadline instead of taking another window', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 1000, idleMs: 2000 } });
  const { session, attachment } = await attached(h, 'socket-close-deadline');
  attachment.detach();
  // idleMs exceeds the session deadline, exactly the frozen native profile whose consumer socket closed.
  h.advance(1000); scheduler.runDue(); await tick();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'failed', code: 'session_timeout' }, 'a detached call is durably terminal at its hard deadline, never idle or unknown');
  assert.equal(h.f.connections, 1, 'an unattended call never opens another provider window');
});

test('idle expiry still ends a call after a resume', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 600_000, idleMs: 1000 } });
  const { attachment } = await attached(h, 'idle-after-resume');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-idle-resumption-secret' }, goAway: { timeLeft: '10s' } });
  await h.f.frame(2); h.f.send({ setupComplete: {} }); await continuity(output, 'resumed');
  h.advance(1000); scheduler.runDue();
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'idle_timeout' });
  assert.equal(h.f.connections, 2);
});

test('a post-ready rejected frame resumes the same live session for a seventh turn', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'protocol-resume');
  void (async () => { for await (const chunk of attachment.output) { void chunk; } })();
  const handle = 'synthetic-protocol-resume-secret';
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  for (let i = 0; i < 100; i++) {
    if (h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!['resumption_handle'] === handle) break;
    await tick();
  }
  const base = h.owner.get(session.liveSessionId).journal.events;
  for (let i = 0; i < 6; i++) {
    h.f.send({ serverContent: { outputTranscription: { text: `out-${i}`, finished: true }, generationComplete: true, turnComplete: true } });
    await drain(h, session.liveSessionId, base + (i + 1) * 3);
  }
  assert.equal(h.f.attempts, 1);
  // The rejected frame after ready ends the connection with a recoverable protocol_error.
  h.f.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'not-valid-base64!!' } }] } } });
  await h.f.frame(2);
  assert.equal(h.f.attempts, 2, 'the owner opens one resumption connection');
  assert.equal((h.f.frames[1] as { setup: { sessionResumption: { handle: string } } }).setup.sessionResumption.handle, handle);
  h.f.send({ setupComplete: {} });
  const before = h.owner.get(session.liveSessionId).journal.events;
  // A seventh turn arrives on the same live session id.
  h.f.send({ serverContent: { outputTranscription: { text: 'out-6', finished: true }, turnComplete: true } });
  await drain(h, session.liveSessionId, before + 2);
  assert.equal(h.owner.current().state, 'listening');
  assert.equal(h.store.transaction(tx => tx.all('SELECT live_session_id FROM live_sessions')).length, 1, 'the same live session resumed');
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 0);
  attachment.close(); await attachment.done;
});

test('revoked resumption handle is cleared before a recoverable loss', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-cleared');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-cleared-resumption-secret' }, serverContent: { inputTranscription: { text: 'saved' } } });
  await transcription(output, 'saved');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle !== null, true);
  h.f.send({ sessionResumptionUpdate: { resumable: false }, serverContent: { inputTranscription: { text: 'cleared' } } });
  await transcription(output, 'cleared');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle, null);
  h.f.remoteClose('', 1011);
  await h.f.frame(2);
  const seeded = h.requests.at(-1)!;
  assert.equal(seeded.resumptionHandle, undefined, 'a cleared handle forces a fresh seeded setup');
  assert.equal(seeded.openingText, LIVE_RECOVERY_PICKUP);
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(r => r.kind === 'terminal').length, 0, 'the call did not end');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('a resume does not extend the original idle expiry', async t => {
  const scheduler = new DeadlineClock();
  // The session budget is large so only the idle timeout can end this call.
  const h = await harness(t, { scheduler, limits: { sessionMs: 600_000, idleMs: 1000 } });
  const { attachment } = await attached(h, 'resume-idle');
  const output = attachment.output[Symbol.asyncIterator]();
  h.advance(60);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-budget-resumption-secret' }, goAway: { timeLeft: '10s' } });
  await h.f.frame(2); h.f.send({ setupComplete: {} }); await continuity(output, 'resumed');
  h.advance(1000); scheduler.runDue();
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'idle_timeout' });
  assert.equal(h.f.connections, 2);
});

test('the live recovery path carries no model or provider id literal', () => {
  const source = readFileSync(new URL('../../live/index.ts', import.meta.url), 'utf8');
  assert.equal(/models\//.test(source), false, 'no model resource path');
  assert.equal(/gemini-\d/.test(source), false, 'no model id literal');
});

async function transcription(output: AsyncIterator<import('../live/types.js').LiveOutputChunk>, text: string) {
  for (;;) {
    const item = await output.next(); assert.equal(item.done, false);
    if (item.value.kind === 'marker' && item.value.marker.text === text) return;
  }
}


test('the exact live diagnostics object the owner emits is accepted by the host log whitelist', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('live_session_diagnostics')) lines.push(args[0]);
  });
  const h = await harness(t);
  const { attachment } = await attached(h, 'diagnostics-whitelist');
  attachment.close(); await attachment.done;
  for (let attempt = 0; attempt < 20 && lines.length === 0; attempt++) await tick();
  assert.equal(lines.length, 1);
  const emitted = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(emitted.event, 'live_session_diagnostics');
  const accepted = safeEvent(emitted);
  assert.ok(accepted, 'the host log whitelist accepts the exact emitted diagnostics object, never silently dropping it');
  assert.equal(accepted.terminalCode, emitted.terminalCode);
});

test('the anchor diagnostics report the serialized anchors, not the overlay accent length', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const accent = 'SYNTHETIC-ACCENT-DESCRIPTION';
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC overlay persona', accent };
  // The anchor is composed with the bare primary language (AC1), while the setup frame carries the owner tag.
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'en' });
  const sectionChars = (id: string): number => composed.sections.find(section => section.id === id)?.chars ?? 0;
  const h = await harness(t, { language: 'en-IN', overlay, acceptedPrompt: ownerId => ({
    schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: composed.text, dataClasses: ['ordinary'] }) });
  const { attachment } = await attached(h, 'accent-carried');
  assert.ok(h.requests.at(-1)?.system.text.includes(accent), 'the accent lives in the system instruction, not the request');
  assert.equal(h.requests.at(-1)?.languageCode, 'en-IN', 'the owner tag reaches the adapter as the setup language');
  attachment.close(); await attachment.done;
  const parse = (line: string): Record<string, unknown> => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } };
  const diagnostics = (): Record<string, unknown>[] => lines.map(parse).filter(entry => entry.event === 'live_session_diagnostics');
  for (let attempt = 0; attempt < 60 && diagnostics().length === 0; attempt++) await tick();
  const matches = (): Record<string, unknown> | undefined => diagnostics().find(entry => entry.headVoiceChars === sectionChars('voice-head')
    && entry.terminalVoiceChars === sectionChars('voice'));
  for (let attempt = 0; attempt < 60 && matches() === undefined; attempt++) await tick();
  const emitted = matches();
  assert.ok(emitted, `the accent-bearing diagnostics reports the serialised anchors; saw ${JSON.stringify(diagnostics())}`);
  assert.equal(emitted.headVoiceChars, sectionChars('voice-head'), 'the head count is the serialised head block');
  assert.equal(emitted.terminalVoiceChars, sectionChars('voice'), 'the terminal count is the serialised anchor, not the setup tag spelling');
  assert.equal('toolAnchorChars' in emitted, false, 'the tool-anchor diagnostic is gone');
  assert.notEqual(emitted.terminalVoiceChars, emitted.headVoiceChars, 'the terminal anchor has its own serialised length');
  assert.ok(Number.isSafeInteger(emitted.terminalVoiceChars) && Number(emitted.terminalVoiceChars) > 0, 'the terminal count is a positive integer');
  assert.ok(safeEvent(emitted), 'the host log accepts the accent-bearing diagnostics shape');
  assert.equal(lines.some(line => line.includes(accent)), false, 'the accent text never reaches an emitted line');
});

test('AC2: with no accent the head block is absent while the terminal anchor remains', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const overlay = { schemaVersion: 1 as const, text: 'SYNTHETIC overlay persona' };
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'en' });
  const sectionChars = (id: string): number => composed.sections.find(section => section.id === id)?.chars ?? 0;
  const h = await harness(t, { language: 'en', overlay, acceptedPrompt: ownerId => ({
    schemaVersion: 1, ownerProfile: { schemaVersion: 1, kind: 'default', ownerId, displayName: 'Lux Didi' },
    compilerVersion: PROMPT_VERSION, system: composed.text, dataClasses: ['ordinary'] }) });
  const { attachment } = await attached(h, 'no-accent');
  attachment.close(); await attachment.done;
  const parse = (line: string): Record<string, unknown> => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } };
  const diagnostics = (): Record<string, unknown>[] => lines.map(parse).filter(entry => entry.event === 'live_session_diagnostics');
  for (let attempt = 0; attempt < 60 && diagnostics().length === 0; attempt++) await tick();
  const matches = (): Record<string, unknown> | undefined => diagnostics().find(entry => entry.headVoiceChars === 0
    && entry.terminalVoiceChars === sectionChars('voice'));
  for (let attempt = 0; attempt < 60 && matches() === undefined; attempt++) await tick();
  const emitted = matches();
  assert.ok(emitted, `the diagnostics is emitted; saw ${JSON.stringify(diagnostics())}`);
  assert.equal(emitted.headVoiceChars, 0, 'no accent serialises no head block');
  assert.equal('toolAnchorChars' in emitted, false, 'the tool-anchor diagnostic is gone');
  assert.equal(emitted.terminalVoiceChars, sectionChars('voice'), 'the terminal anchor is still serialised without an accent');
});

test('queued PCM is dropped at the cut and capture during rebuilding is never replayed', async t => {
  const diagnosticLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('live_session_diagnostics')) diagnosticLines.push(args[0]);
  });
  const h = await harness(t);
  const { attachment } = await attached(h, 'resume-media');
  attachment.sendAudio({ pcm }); await h.f.frame(2);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-media-resumption-secret' }, serverContent: { modelTurn: { parts: [audio()] } }, goAway: { timeLeft: '10s' } });
  await h.f.frame(3);
  const output = attachment.output[Symbol.asyncIterator]();
  for (;;) {
    const item = await output.next(); assert.equal(item.done, false);
    assert.notEqual(item.value.kind, 'audio', 'old queued output PCM is discarded');
    if (item.value.kind === 'marker' && item.value.marker.kind === 'continuity') break;
  }
  attachment.sendAudio({ pcm }); attachment.endAudioStream();
  assert.equal(h.f.frames.length, 3, 'capture during rebuilding is dropped');
  h.f.send({ setupComplete: {}, serverContent: { modelTurn: { parts: [audio()] } } });
  await continuity(output, 'resumed');
  const resumedAudio = await output.next();
  assert.equal(resumedAudio.value.kind, 'audio');
  assert.equal(h.f.frames.length, 3, 'no old PCM replay follows setupComplete');
  attachment.close(); const finalSnapshot = await attachment.done;
  let matching: Record<string, number | string>[] = [];
  for (let attempt = 0; attempt < 20 && matching.length === 0; attempt++) {
    await tick();
    matching = diagnosticLines.map(line => JSON.parse(line) as Record<string, number | string>)
      .filter(value => value.ownerAudioCalls === 2 && value.ownerRebuildingDropCalls === 1);
  }
  assert.equal(matching.length, 1);
  const diagnostics = matching[0]!;
  const terminalCode = finalSnapshot.terminal && 'code' in finalSnapshot.terminal ? finalSnapshot.terminal.code : finalSnapshot.terminal?.state;
  assert.equal(diagnostics.event, 'live_session_diagnostics'); assert.equal(diagnostics.terminalCode, terminalCode);
  assert.equal(diagnostics.adapterGenerations, 2);
  assert.equal(diagnostics.ownerAudioCalls, 2); assert.equal(diagnostics.ownerAudioBytes, pcm.byteLength * 2);
  assert.equal(diagnostics.ownerRebuildingDropCalls, 1); assert.equal(diagnostics.ownerRebuildingDropBytes, pcm.byteLength);
  assert.equal(diagnostics.adapterAudioCalls, 1); assert.equal(diagnostics.adapterAudioBytes, pcm.byteLength);
  assert.equal(diagnostics.outputAudioFrames, 2); assert.equal(diagnostics.outputAudioPCMBytes, pcm.byteLength * 2);
});


test('an exhausted original budget never opens a replacement connection', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 100, idleMs: 1000 } });
  const { attachment } = await attached(h, 'resume-exhausted');
  h.advance(100); // Recoverable loss wins before the fake timer callback runs.
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-exhausted-resumption-secret' }, goAway: { timeLeft: '10s' } });
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.equal(h.f.connections, 1);
});

/** Replace a live client's send with one that reports a transport failure on the next write, asynchronously. */
function failUpstream(client: unknown): void {
  (client as { send: (data: string, a?: unknown, b?: unknown) => void }).send = (_data: string, a?: unknown, b?: unknown) => {
    const callback = (typeof a === 'function' ? a : b) as ((error?: Error) => void) | undefined;
    queueMicrotask(() => callback?.(Object.assign(new Error('synthetic upstream write failure'), { code: 'ECONNRESET' })));
  };
}

test('a failed upstream audio write rebuilds the session once and logs one live_upstream_drop', async t => {
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { const record = raw as Record<string, unknown>; if (record.event === 'live_upstream_drop') records.push(record); } });
  t.after(detach);
  const sockets: unknown[] = [];
  let h!: Harness;
  h = await harness(t, { socketFactory: (url, config) => { const client = h.f.socketFactory(url, config); sockets.push(client); return client; } });
  const { session, attachment } = await attached(h, 'upstream-drop');
  const handle = 'synthetic-upstream-drop-handle';
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  for (let i = 0; i < 100; i++) { if (h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!['resumption_handle'] === handle) break; await tick(); }
  const output = attachment.output[Symbol.asyncIterator]();
  attachment.sendAudio({ pcm }); await h.f.frame(2);
  failUpstream(sockets[0]);
  attachment.sendAudio({ pcm });
  await continuity(output, 'rebuilding');
  // Owner audio during the cut is accepted and dropped, never buffered without bound.
  assert.doesNotThrow(() => attachment.sendAudio({ pcm }));
  for (let i = 0; i < 50 && h.f.connections < 2; i++) await tick();
  assert.equal(h.f.connections, 2, 'exactly one rebuild opened exactly one replacement connection');
  h.f.send({ setupComplete: {} });
  await continuity(output, 'resumed');
  assert.equal(records.length, 1, 'one metadata record per occurrence');
  assert.deepEqual(Object.keys(records[0]!).sort(), ['bufferedAmount', 'closeCode', 'errorKind', 'event', 'rebuilt', 'sessionMs', 'writesFailed'].sort());
  assert.equal(records[0]!.errorKind, 'ECONNRESET');
  assert.equal(records[0]!.rebuilt, true);
  assert.ok((records[0]!.writesFailed as number) >= 1);
  assert.ok((records[0]!.sessionMs as number) >= 0);
  attachment.close(); await attachment.done;
});

test('successful upstream rebuilds do not accumulate toward the recovery bound', async t => {
  const sockets: unknown[] = [];
  let h!: Harness;
  h = await harness(t, { socketFactory: (url, config) => { const client = h.f.socketFactory(url, config); sockets.push(client); return client; } });
  const { session, attachment } = await attached(h, 'upstream-bound');
  const handle = 'synthetic-upstream-bound-handle';
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  for (let i = 0; i < 100; i++) { if (h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!['resumption_handle'] === handle) break; await tick(); }
  const output = attachment.output[Symbol.asyncIterator]();
  for (let attempt = 0; attempt < 3; attempt++) {
    attachment.sendAudio({ pcm }); await tick();
    failUpstream(sockets[attempt]);
    attachment.sendAudio({ pcm });
    await continuity(output, 'rebuilding');
    for (let i = 0; i < 50 && h.f.connections < attempt + 2; i++) await tick();
    h.f.send({ setupComplete: {} });
    await continuity(output, 'resumed');
  }
  assert.equal(h.f.connections, 4, 'three successful rebuilds, and the call is still alive');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('a pending tool call is never answered on the rebuilt socket', async t => {
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const sockets: unknown[] = [];
  let h!: Harness;
  h = await harness(t, { tools: true, beforeTool: () => slow, socketFactory: (url, config) => { const client = h.f.socketFactory(url, config); sockets.push(client); return client; } });
  const { session, attachment } = await attached(h, 'upstream-tool');
  const handle = 'synthetic-upstream-tool-handle';
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  for (let i = 0; i < 100; i++) { if (h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!['resumption_handle'] === handle) break; await tick(); }
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ toolCall: { functionCalls: [{ id: 'keep1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  failUpstream(sockets[0]);
  attachment.sendAudio({ pcm });
  await continuity(output, 'rebuilding');
  for (let i = 0; i < 50 && h.f.connections < 2; i++) await tick();
  h.f.send({ setupComplete: {} });
  await continuity(output, 'resumed');
  finish();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(h.f.frames.some(frame => 'toolResponse' in (frame as object)), false, 'the orphaned tool response is never sent on the new socket');
  attachment.close(); await attachment.done;
});

for (const outcome of ['failed', 'closed', 'unknown'] as const) {
  test(`page projects past Live ${outcome} with truthful timing`, async t => {
    const h = await harness(t);
    const session = h.owner.create({ idempotencyKey: 'past', inputClass: 'ordinary' }, h.ctx);
    const terminal = outcome === 'unknown' ? null : JSON.stringify({ state: outcome, code: 'fixture' });
    h.store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='active',terminal_outcome=?,terminal_at=?,updated_at=? WHERE live_session_id=?", [terminal, outcome === 'unknown' ? null : NOW + 1000, NOW + 2000, session.liveSessionId]));
    const page = h.owner.current();
    assert.equal(page.state, 'ended');
    assert.deepEqual((page as typeof page & { pastSession?: unknown }).pastSession, { outcome, endedAt: outcome === 'unknown' ? null : NOW + 1000, lastObservedAt: NOW + 2000 });
  });
}
test('active page does not carry past session metadata', async t => {
  const h = await harness(t);
  await attached(h);
  assert.equal(h.owner.current().state, 'listening');
  assert.equal((h.owner.current() as { pastSession?: unknown }).pastSession, undefined);
});


for (const status of [401, 403, 429]) test(`resumed HTTP upgrade refusal ${status} falls back to fresh then ends after three failures`, async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session, attachment } = await attached(h, `resume-refused-${status}`);
  h.f.refuseUpgrades(status);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-refused-resumption-secret' }, goAway: { timeLeft: '10s' } });
  // Drive the injected scheduler through the 0/2/5 s backoff until the bound settles.
  let settled = false;
  for (let i = 0; i < 60 && !settled; i++) {
    h.advance(1000); scheduler.runDue(); await tick();
    settled = h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.some(row => row.kind === 'terminal');
  }
  assert.deepEqual((await attachment.done).terminal, { state: 'failed', code: 'resume_failed' });
  assert.ok(h.f.attempts >= 3, 'a refused resume falls back to fresh and retries to the bound');
  assert.equal(h.f.connections, 1, 'no refused upgrade ever connects');
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(row => row.kind === 'terminal').length, 1);
});

test('established WebSocket protocol error resumes through the saved handle', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'resume-protocol-final');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-protocol-resumption-secret' } });
  h.f.send({ serverContent: { inputTranscription: { text: 'protocol sentinel' } } });
  await transcription(output, 'protocol sentinel');
  assert.equal(h.store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!.resumption_handle !== null, true);
  // A post-ready protocol error is recoverable, so the owner opens one resumption connection.
  h.f.invalidOpcode();
  await h.f.frame(2);
  assert.equal(h.f.attempts, 2);
  h.f.send({ setupComplete: {} });
  await continuity(output, 'resumed');
  assert.equal(h.owner.current().state, 'listening');
  assert.equal(h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.filter(row => row.kind === 'terminal').length, 0);
  attachment.close(); await attachment.done;
});

test('Mattermost declarations carry the channel-resolution micro-contract', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 60 } } as never;
  const descriptions = new Map(CONNECTOR_DESCRIPTORS['mattermost']!.declarations(policy).map(declaration => [declaration.name, declaration.description]));
  assert.equal(descriptions.has('mattermost_list_channels'), false, 'the model never gets a channel dump');
  assert.match(descriptions.get('mattermost_search')!, /From:<user>/);
  assert.match(descriptions.get('mattermost_search')!, /After:<date>/);
  assert.match(descriptions.get('mattermost_search')!, /In:<channel>/);
  assert.match(descriptions.get('mattermost_search')!, /search first, no channel list needed/);
  assert.match(descriptions.get('mattermost_get_channel_history')!, /channel is a channel name or display name; no channel list needed/);
  assert.match(descriptions.get('mattermost_get_channel_history')!, /newest first/);
  assert.match(descriptions.get('mattermost_get_thread')!, /postId is a post id taken from a channel history/);
});

function toolResponseCount(h: Harness): number {
  return h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).length;
}

async function settleLiveTool(h: Harness, id: string, name: string, args: unknown): Promise<void> {
  const before = toolResponseCount(h);
  h.f.send({ toolCall: { functionCalls: [{ id, name, args }] } });
  for (let i = 0; i < 2000 && toolResponseCount(h) === before; i++) await tick();
  assert.equal(toolResponseCount(h), before + 1, `no tool response for ${id}`);
}

test('a replayed Live question reaches the connector once per allowlisted read', async t => {
  const h = await harness(t, { tools: true, calendar: true, mattermost: true });
  await attached(h, 'cache-replay');
  const channelId = 'abcdefghijklmnopqrstuvwxzy';
  await settleLiveTool(h, 'c1', 'gcal_calendars', {});
  await settleLiveTool(h, 'c2', 'gcal_calendars', {});
  await settleLiveTool(h, 'c3', 'gcal_calendars', {});
  await settleLiveTool(h, 's1', 'mattermost_search', { query: 'standup', limit: 12 });
  await settleLiveTool(h, 's2', 'mattermost_search', { query: 'standup', limit: 12 });
  await settleLiveTool(h, 'h1', 'mattermost_get_channel_history', { channel: channelId, limit: 12 });
  await settleLiveTool(h, 'h2', 'mattermost_get_channel_history', { channel: channelId, limit: 12 });
  const count = (name: string) => h.calls.filter(call => call.name === name).length;
  assert.equal(count('gcal_calendars'), 1, 'three identical list calls reach the connector once');
  assert.equal(count('mattermost_search'), 2, 'a search is never cached');
  assert.equal(count('mattermost_get_channel_history'), 2, 'a history read is never cached');
});

test('a new Live session starts with an empty read cache', async t => {
  const first = await harness(t, { tools: true, calendar: true, mattermost: true });
  await attached(first, 'cache-session-one');
  await settleLiveTool(first, 'o1', 'gcal_calendars', {});
  assert.equal(first.calls.filter(call => call.name === 'gcal_calendars').length, 1);
  const second = await harness(t, { tools: true, calendar: true, mattermost: true });
  await attached(second, 'cache-session-two');
  await settleLiveTool(second, 'o2', 'gcal_calendars', {});
  assert.equal(second.calls.filter(call => call.name === 'gcal_calendars').length, 1, 'the second session reads the connector afresh');
});

test('a cached read expires after ten minutes even inside one session', async t => {
  const h = await harness(t, { tools: true, calendar: true, mattermost: true });
  await attached(h, 'cache-ttl');
  await settleLiveTool(h, 't1', 'gcal_calendars', {});
  assert.equal(h.calls.filter(call => call.name === 'gcal_calendars').length, 1);
  h.advance(10 * 60 * 1000);
  await settleLiveTool(h, 't2', 'gcal_calendars', {});
  assert.equal(h.calls.filter(call => call.name === 'gcal_calendars').length, 2, 'an expired entry is read again');
});

test('creating a second Live session supersedes the first for the owner', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-supersede-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-supersede-log-'));
  const stopDiagnostics = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stopDiagnostics(); rmSync(captureDir, { recursive: true, force: true }); });
  const profile = validateLiveProfile(profileInput());
  const { service } = composeLive(store, dir, { profile, credentials: { resolve: async () => CANARY } });
  t.after(() => service.shutdown());
  const first = service.create('ordinary', 'one', context(store));
  const second = service.create('ordinary', 'two', context(store));
  assert.equal(service.snapshot(first.liveSessionId).lifecycle, 'terminal', 'the first session is terminal once the second is created');
  assert.equal(service.snapshot(second.liveSessionId).lifecycle, 'accepted');
  const events = readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; liveSessionId?: string });
  const superseded = events.filter(line => line.event === 'live_session_superseded');
  assert.equal(superseded.length, 1, 'exactly one supersede event');
  assert.equal(superseded[0]!.liveSessionId, first.liveSessionId);
});

// Contract P1 (issue 1014): the resumption handle is gated at five tool calls, and session start logs section sizes.
test('P1: a session past five tool calls rebuilds with a fresh setup', async t => {
  const h = await harness(t, { tools: true });
  await attached(h, 'p1-gating');
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-gating-secret' } });
  for (let i = 0; i < 5; i++) {
    h.f.send({ toolCall: { functionCalls: [{ id: `g${i}`, name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
    await h.f.frame(h.f.frames.length + 1);
  }
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(h.f.frames.length + 1);
  assert.equal(h.requests.at(-1)!.resumptionHandle, undefined, 'a session past five tool calls must start fresh');
});

test('P1: a session under five tool calls still resumes on the saved handle', async t => {
  const h = await harness(t, { tools: true });
  await attached(h, 'p1-gating-resume');
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-gating-resume-secret' } });
  h.f.send({ toolCall: { functionCalls: [{ id: 'g0', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await h.f.frame(h.f.frames.length + 1);
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(h.f.frames.length + 1);
  assert.equal(h.requests.at(-1)!.resumptionHandle, 'synthetic-gating-resume-secret', 'under five calls the handle is reused');
});

test('P1: session start logs the composed instruction size per section', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const h = await harness(t);
  await attached(h, 'p1-size-log');
  const logged = lines.map(line => { try { return JSON.parse(line) as { event?: string; sections?: Record<string, number>; total?: number; languageCode?: string; voice?: string }; } catch { return {}; } })
    .find(entry => entry.event === 'live_instruction_sizes');
  assert.ok(logged, 'a per-section size line is logged at session start');
  assert.ok(typeof logged.total === 'number' && logged.total > 0);
  assert.ok(logged.sections && Object.values(logged.sections).every(value => typeof value === 'number'), 'only counts are logged');
  assert.equal(logged.languageCode, 'unset', 'no configured language logs unset');
  assert.equal(logged.voice, 'ExplicitVoice', 'the configured voice name is logged');
  assert.ok(safeEvent(logged as unknown as Record<string, unknown>), 'the size line is accepted by the host log whitelist');
});

test('P1: session start logs the effective regional languageCode', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const h = await harness(t, { language: 'en-IN' });
  await attached(h, 'p1-size-language');
  const logged = lines.map(line => { try { return JSON.parse(line) as { event?: string; languageCode?: string; voice?: string }; } catch { return {}; } })
    .find(entry => entry.event === 'live_instruction_sizes');
  assert.ok(logged, 'a per-section size line is logged at session start');
  assert.equal(logged.languageCode, 'en-IN', 'the configured regional tag is logged');
  assert.equal(logged.voice, 'ExplicitVoice', 'the configured voice name is logged');
  assert.equal(h.requests.at(-1)!.languageCode, 'en-IN', 'the profile language reaches the adapter request');
});

test('U1: calendar and Gmail model text carries no raw url and names each source', () => {
  const calendar = shapeGcalList({ events: [
    { summary: 'Standup', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e1' },
    { start: { dateTime: '2024-01-02T09:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=e2' },
  ] });
  assert.equal(/https?:\/\//.test(calendar.text), false, 'calendar model text carries no raw url');
  assert.equal(calendar.text.includes('source:'), false);
  assert.deepEqual(calendar.sources, [
    { title: 'Calendar: Standup', url: 'https://calendar.google.com/event?eid=e1', sourceType: 'calendar' },
    { title: 'Open in Google Calendar', url: 'https://calendar.google.com/event?eid=e2', sourceType: 'calendar' },
  ]);
  const mail = shapeGmailList({ messages: [
    { id: 'm1', snippet: 'hello', labelIds: [], headers: { Subject: 'Budget' } },
  ] });
  assert.equal(/https?:\/\//.test(mail.text), false, 'gmail model text carries no raw url');
  assert.deepEqual(mail.sources, [{ title: 'Gmail: Budget', url: 'https://mail.google.com/mail/u/0/#inbox/m1', sourceType: 'gmail' }]);
  assert.deepEqual(shapeGcalCalendars({ calendars: [{ summary: 'Work' }] }).sources, undefined);
});

test('E1: Live setup carries the 700 ms prefix padding that absorbs residual echo spikes', async t => {
  const h = await harness(t);
  await attached(h, 'padding');
  const frame = JSON.parse(JSON.stringify(h.f.frames[0]));
  const vad = frame.setup.realtimeInputConfig.automaticActivityDetection;
  assert.equal(vad.prefixPaddingMs, 700, 'prefix padding is 700 ms (release 3a echo-analysis, lux 89995)');
  assert.equal(vad.silenceDurationMs, 800, 'silence duration is unchanged at 800 ms');
  assert.equal(vad.startOfSpeechSensitivity, 'START_SENSITIVITY_LOW', 'start sensitivity stays LOW');
  assert.equal(vad.endOfSpeechSensitivity, 'END_SENSITIVITY_LOW', 'end sensitivity stays LOW');
});

test('E1: provider barge-in writes one metadata-only live_interrupted host record', async t => {
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_interrupted') records.push(record);
  } });
  t.after(detach);
  const h = await harness(t);
  const { session } = await attached(h, 'live-interrupted');
  const before = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { modelTurn: { parts: [audio()] }, outputTranscription: { text: 'mid sentence', finished: false } } });
  await drain(h, session.liveSessionId, before + 1);
  h.advance(4200);
  h.f.send({ serverContent: { interrupted: true } });
  await drain(h, session.liveSessionId, before + 2);
  assert.equal(records.length, 1, 'exactly one live_interrupted record per provider interruption');
  const record = records[0]!;
  assert.equal(record.liveSessionId, session.liveSessionId);
  assert.equal(record.turnCompleteSeen, false, 'turnComplete had not arrived before interrupted');
  assert.equal(typeof record.msSinceLastModelAudio, 'number');
  assert.ok((record.msSinceLastModelAudio as number) >= 4200, 'ms since the last output chunk reflects the elapsed turn');
  assert.deepEqual(Object.keys(record).sort(), ['event', 'liveSessionId', 'msSinceLastModelAudio', 'turnCompleteSeen'],
    'metadata only: no audio bytes, text, device label or provider payload');
});
test('an intent call answers with one model tool call from one host-side fan-out', async t => {
  const h = await harness(t, { tools: true });
  await attached(h, 'intent-search');
  h.f.send({ toolCall: { functionCalls: [{ id: 'i1', name: 'search', args: { query: 'lux didi' } }] } });
  while (toolResponseCount(h) === 0) await tick();
  assert.equal(toolResponseCount(h), 1, 'exactly one response for the one intent call');
  const response = h.f.frames[1] as { toolResponse: { functionResponses: { id: string; name: string; response: { text: string } }[] } };
  assert.equal(response.toolResponse.functionResponses.length, 1);
  assert.equal(response.toolResponse.functionResponses[0]!.id, 'i1');
  assert.equal(response.toolResponse.functionResponses[0]!.name, 'search');
  assert.match(response.toolResponse.functionResponses[0]!.response.text, /Synthetic insight/);
  assert.deepEqual(h.calls.map(call => call.name), ['search_knowledge'], 'the intent expands to the internal read');
});

test('a provider cancellation drops exactly the cancelled id and logs tool_cancelled', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { tools: true, beforeTool: () => gate });
  await attached(h, 'cancel-one');
  const events: { event?: string; id?: string; tool?: string }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as { event?: string; id?: string; tool?: string }); } });
  try {
    h.f.send({ toolCall: { functionCalls: [
      { id: 'keep', name: 'search_knowledge', args: { query: 'x', limit: 1 } },
      { id: 'drop', name: 'search_knowledge', args: { query: 'y', limit: 1 } },
    ] } });
    while (!h.calls.length) await tick();
    h.f.send({ toolCallCancellation: { ids: ['drop'] } });
    for (let i = 0; i < 40 && !events.some(entry => entry.event === 'tool_cancelled'); i++) await tick();
    release();
    for (let i = 0; i < 2000 && toolResponseCount(h) === 0; i++) await tick();
  } finally { detach(); }
  assert.equal(toolResponseCount(h), 1, 'only the kept id is answered');
  const response = h.f.frames.find(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame) as { toolResponse: { functionResponses: { id: string }[] } };
  assert.deepEqual(response.toolResponse.functionResponses.map(r => r.id), ['keep'], 'the cancelled id gets no response');
  const cancelled = events.find(entry => entry.event === 'tool_cancelled');
  assert.ok(cancelled, 'tool_cancelled is logged');
  assert.equal(cancelled!.id, 'drop');
  assert.equal(cancelled!.tool, 'search_knowledge');
});

test('a model turn logs tool metrics, metadata only', async t => {
  const h = await harness(t, { tools: true });
  await attached(h, 'tool-metrics');
  const events: { event?: string; toolCallsThisTurn?: number; toolLatencyMs?: unknown[]; toolResponseWhileGenerating?: boolean }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as typeof events[number]); } });
  try {
    h.f.send({ toolCall: { functionCalls: [{ id: 'm1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
    for (let i = 0; i < 2000 && !events.some(entry => entry.event === 'live_tool_turn'); i++) await tick();
  } finally { detach(); }
  const metrics = events.find(entry => entry.event === 'live_tool_turn');
  assert.ok(metrics, 'the per-turn metrics line is logged');
  assert.equal(metrics!.toolCallsThisTurn, 1);
  assert.ok(Array.isArray(metrics!.toolLatencyMs) && metrics!.toolLatencyMs!.length === 1, 'one latency per call');
  assert.equal(typeof metrics!.toolResponseWhileGenerating, 'boolean');
});
test('a turn logs dead air from the owner turn end to the first model audio', async t => {
  const h = await harness(t, { tools: true });
  await attached(h, 'dead-air');
  const events: { event?: string; deadAirMs?: number }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as { event?: string; deadAirMs?: number }); } });
  try {
    h.f.send({ serverContent: { inputTranscription: { text: 'Fixture voice input', finished: true } } });
    for (let i = 0; i < 40 && !events.some(entry => entry.event === 'live_dead_air'); i++) {
      h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
      await tick();
    }
    if (!events.some(entry => entry.event === 'live_dead_air')) { await tick(); }
  } finally { detach(); }
  const dead = events.find(entry => entry.event === 'live_dead_air');
  assert.ok(dead, 'dead air is logged');
  assert.equal(typeof dead!.deadAirMs, 'number');
  assert.ok(dead!.deadAirMs! >= 0);
});
test('a model turn that stops generating without turnComplete is logged open (#303)', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { sessionMs: 600_000, idleMs: 1000 } });
  const { attachment } = await attached(h, 'turn-open');
  const events: { event?: string; msSinceLastModelAudio?: number | null }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as { event?: string; msSinceLastModelAudio?: number | null }); } });
  try {
    // The 3h-a witness shape: the greeting streams audio, then the provider goes quiet without turnComplete.
    const output = attachment.output[Symbol.asyncIterator]();
    h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
    for (let i = 0; i < 200; i++) {
      const next = await output.next();
      if (next.done || (next.value as { kind?: string }).kind === 'audio') break;
    }
    h.advance(1000); scheduler.runDue();
    const terminal = await attachment.done;
    assert.deepEqual(terminal.terminal, { state: 'failed', code: 'idle_timeout' }, 'the idle expiry ends the call');
    for (let i = 0; i < 200 && !events.some(entry => entry.event === 'live_turn_open'); i++) await tick();
  } finally { detach(); }
  const open = events.find(entry => entry.event === 'live_turn_open');
  assert.ok(open, 'a turn that idles out without turnComplete is logged open');
  assert.equal(typeof open!.msSinceLastModelAudio, 'number');
});
test('the calendar intent reads events from every calendar the owner keeps', async t => {
  const h = await harness(t, { tools: true, calendar: true });
  await attached(h, 'calendar-all');
  h.f.send({ toolCall: { functionCalls: [{ id: 'cal', name: 'calendar', args: {} }] } });
  for (let i = 0; i < 2000 && toolResponseCount(h) === 0; i++) await tick();
  assert.equal(toolResponseCount(h), 1, 'one response for the calendar intent');
  assert.ok(h.calls.some(call => call.name === 'gcal_calendars'), 'the calendars are enumerated first');
  const response = h.f.frames.find(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame) as { toolResponse: { functionResponses: { response: { text: string } }[] } };
  const lists = h.calls.filter(call => call.name === 'gcal_list').map(call => (call.args as { calendarId?: string }).calendarId).sort();
  assert.deepEqual(lists, ['primary', 'work'], 'one event read per calendar, all calendars server-side');
  assert.match(response.toolResponse.functionResponses[0]!.response.text, /Event on work/);
});

test('F1: thinking holds between the tool result and the first model audio', async t => {
  const h = await harness(t, { tools: true });
  const { attachment } = await attached(h, 'f1-thinking');
  await settleLiveTool(h, 'c1', 'search_knowledge', { query: 'x', limit: 1 });
  assert.equal(h.owner.current().state, 'thinking', 'the tool result never flashes listening before speech');
  h.f.send({ serverContent: { modelTurn: { parts: [audio()] } } });
  for (let i = 0; i < 200 && h.owner.current().state !== 'speaking'; i++) await tick();
  assert.equal(h.owner.current().state, 'speaking', 'the first output audio ends thinking');
  attachment.close(); await attachment.done;
});

test('F2: speaking holds past generationComplete until the turn completes', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'f2-speaking');
  h.f.send({ serverContent: { modelTurn: { parts: [audio()] }, generationComplete: true } });
  for (let i = 0; i < 200 && h.owner.current().state !== 'speaking'; i++) await tick();
  await drain(h, session.liveSessionId, 2);
  assert.equal(h.owner.current().state, 'speaking', 'generationComplete alone must not end speaking before playback drains');
  h.f.send({ serverContent: { turnComplete: true } });
  await drain(h, session.liveSessionId, 3);
  assert.equal(h.owner.current().state, 'listening', 'turnComplete ends speaking');
  attachment.close(); await attachment.done;
});

test('F4: a barge-in clears thinking for a tool that never resolves', async t => {
  const started = deferred<void>(), finish = deferred<void>();
  const h = await harness(t, { tools: true, beforeTool: async () => { started.resolve(); await finish.promise; } });
  const { session, attachment } = await attached(h, 'f4-barge');
  h.f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await started.promise;
  assert.equal(h.owner.current().state, 'thinking');
  h.f.send({ serverContent: { interrupted: true } });
  await drain(h, session.liveSessionId, 3);
  assert.notEqual(h.owner.current().state, 'thinking', 'a barge-in never leaves THINKING stuck after a hung tool');
  finish.resolve();
  for (let i = 0; i < 200 && h.f.frames.length < 2; i++) await tick();
  attachment.close(); await attachment.done;
});

test('U1: research progress reaches the live channel with metadata only', async t => {
  const h = await harness(t, { tools: true, calendar: true });
  await attached(h, 'lookup-progress');
  await settleLiveTool(h, 'r1', 'research', { action: 'start', question: 'what is on my calendar' });
  const entries = h.owner.current().entries.filter(entry => entry.kind === 'researchProgress');
  assert.ok(entries.length > 0, 'a research progress entry reaches the live channel');
  const progress = entries.at(-1)!.progress as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(progress).sort(), ['elapsedMs', 'phase', 'researchId', 'sourcesDone', 'sourcesPending']);
  assert.ok(['started', 'round', 'done', 'stopped'].includes(String(progress.phase)));
  assert.ok(Array.isArray(progress.sourcesDone) && Array.isArray(progress.sourcesPending));
  assert.equal(typeof progress.elapsedMs, 'number');
  assert.doesNotMatch(JSON.stringify(progress), /what is on my calendar/, 'the question text never reaches the channel');
});

test('F6: three tool calls in one model message run concurrently and return three responses in order', async t => {
  let inFlight = 0; let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { tools: true, beforeTool: async () => { inFlight += 1; peak = Math.max(peak, inFlight); if (inFlight < 3) await gate; else release(); inFlight -= 1; } });
  await attached(h, 'parallel-tools');
  const events: { event?: string; peakInFlight?: unknown }[] = [];
  const detach = attachHostLogSink({ event: raw => { events.push(raw as { event?: string; peakInFlight?: unknown }); } });
  try {
    h.f.send({ toolCall: { functionCalls: [
      { id: 'p1', name: 'search_knowledge', args: { query: 'one', limit: 1 } },
      { id: 'p2', name: 'search_knowledge', args: { query: 'two', limit: 1 } },
      { id: 'p3', name: 'search_knowledge', args: { query: 'three', limit: 1 } },
    ] } });
    for (let i = 0; i < 500 && peak < 3; i++) await tick();
    assert.equal(peak, 3, 'three same-endpoint calls dispatch concurrently');
    release();
    for (let i = 0; i < 2000 && toolResponseCount(h) === 0; i++) await tick();
  } finally { detach(); }
  assert.equal(toolResponseCount(h), 1, 'one batch response frame for the three calls');
  const frame = h.f.frames.find(entry => typeof entry === 'object' && entry !== null && 'toolResponse' in entry) as { toolResponse: { functionResponses: { id: string; name: string }[] } };
  assert.deepEqual(frame.toolResponse.functionResponses.map(response => response.id), ['p1', 'p2', 'p3'], 'responses keep the model call order');
  const turn = events.find(entry => entry.event === 'live_tool_turn');
  assert.deepEqual(turn?.peakInFlight, [{ endpoint: 'lux', peak: 3 }], 'the batch logs one peak-in-flight record per endpoint');
});

test('F6-R1: a successful research call is journaled completed, not error', async t => {
  const h = await harness(t, { tools: true, calendar: true });
  await attached(h, 'research-status');
  await settleLiveTool(h, 'r1', 'research', { action: 'start', question: 'what is on my calendar' });
  const result = h.owner.current().entries.filter(entry => entry.kind === 'toolResult').at(-1);
  assert.equal(result?.tool?.status, 'completed', 'a successful research reply is completed, not error');
});
test('F4: a pending research call is journalled as called, never error', async t => {
  const h = await harness(t, { tools: true, calendar: true });
  await attached(h, 'research-called');
  await settleLiveTool(h, 'r1', 'research', { action: 'start', question: 'what is on my calendar' });
  const rows = h.store.transaction(tx => tx.all("SELECT tool_json FROM live_journal WHERE kind='toolCall'", []));
  const tools = rows.map(row => JSON.parse(String(row['tool_json'])) as { name?: string; status?: string });
  const research = tools.find(tool => tool.name === 'research');
  assert.equal(research?.status, 'called', `a pending research call is called; saw ${JSON.stringify(tools)}`);
});

// --- session memory v1: terminal distillation is scheduled, never awaited by close -------------

test('a terminal Live session schedules distillation without awaiting it and records injected summary ids', async t => {
  const terminal: string[] = [];
  let release: (() => void) | undefined;
  const neverSettles = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { tools: true, onSessionTerminal: liveSessionId => { terminal.push(liveSessionId); return neverSettles as unknown as void; } });
  const session = h.owner.create({ idempotencyKey: 'summary-terminal', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await Promise.all([attachment.ready, h.f.frame(2)]);
  h.owner.revoke(session.liveSessionId);
  // revoke returned while the hook's promise is still pending: close never awaited distillation.
  assert.deepEqual(terminal, [session.liveSessionId]);
  await attachment.done;
  release?.();
  const row = h.store.transaction(tx => tx.get('SELECT memory_provenance FROM live_sessions WHERE live_session_id=?', [session.liveSessionId])!);
  assert.ok(String(row['memory_provenance']).includes('injectedSummaryIds'));
});

test('the earlier-conversations section fills the space under the target in a real session', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const h = await harness(t);
  h.store.transaction(tx => {
    for (let i = 0; i < 20; i++) summaries.insertSummary(tx, { liveSessionId: `synthetic-past-${String(i).padStart(2, '0')}`, status: 'complete',
      summary: `Synthetic past conversation ${i} about the Mongoose mint delivery window and the Friday schedule.`, endedAt: NOW - i * 3_600_000, now: NOW });
  });
  const session = h.owner.create({ idempotencyKey: 'summary-budget', inputClass: 'ordinary' }, h.ctx);
  const row = h.store.transaction(tx => tx.get('SELECT memory_provenance FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!;
  const provenance = JSON.parse(String(row['memory_provenance'])) as { injectedSummaryIds: string[] };
  assert.ok(provenance.injectedSummaryIds.length > 6, `the budget keeps more than the old six (${provenance.injectedSummaryIds.length})`);
  const sizes = lines.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })
    .find(entry => entry?.['event'] === 'live_instruction_sizes');
  const sections = sizes?.['sections'] as Record<string, number> | undefined;
  assert.ok(sections !== undefined && Number(sections['earlier-conversations']) > 0, 'the summary section is recorded per section');
  assert.ok(Number(sizes?.['total']) <= LIVE_INSTRUCTION_TARGET_CHARS, `under the target (${String(sizes?.['total'])})`);
});

test('live.json without a provider is OpenAI GPT-Live by default and fails closed on an empty slot', async t => {
  const h = await harness(t);
  const root = mkdtempSync(join(tmpdir(), 'didi-live-default-'));
  const configDir = join(root, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // OV1-R2: the owner default when live.json names no provider: openai, gpt-live-1, marin.
  writePrivate(configDir, 'live.json', `${JSON.stringify({
    schemaVersion: 1, enabled: true, dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' },
  })}\n`);
  const loaded = loadLiveConfig({ configDir, ownerId: h.store.assistantId });
  assert.equal(loaded.status, 'configured');
  if (loaded.status !== 'configured') return;
  assert.equal(loaded.config.provider, 'openai');
  assert.equal(loaded.config.model, 'gpt-live-1');
  assert.equal(loaded.config.voice, 'marin');
  // TRAIN3J-R3: no OpenAI key slot is a create-time failure, never a silent Gemini session, and the
  // status stays local validation (configured without reading the secret).
  const missing = composeLive(h.store, configDir);
  assert.equal(missing.status.status, 'configured');
  assert.equal(missing.status.provider, 'openai');
  assert.equal(missing.service.enabled, true);
  assert.throws(() => missing.service.create('ordinary', 'ov1-openai-missing', context(h.store)),
    (error: { code?: string }) => error.code === 'key_missing');
  // Gemini stays selectable, but only when live.json says so and its own slot holds the key.
  writePrivate(configDir, 'live.json', `${JSON.stringify({
    schemaVersion: 1, enabled: true, provider: 'gemini', modelId: 'models/gemini-3.8-live', voice: 'Aoede',
    dataClasses: ['ordinary'],
    preferences: { dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'dry', verbosity: 'balanced' },
  })}\n`);
  const geminiMissing = composeLive(h.store, configDir);
  assert.equal(geminiMissing.status.status, 'configured');
  assert.equal(geminiMissing.status.provider, 'gemini', 'the status names the selected provider');
  assert.throws(() => geminiMissing.service.create('ordinary', 'ov1-gemini-missing', context(h.store)),
    (error: { code?: string }) => error.code === 'key_missing');
});
