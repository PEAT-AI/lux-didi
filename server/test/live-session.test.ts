import { createHash, randomUUID } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { composeLive, resolveLiveMemory } from '../host/live.js';
import { captureHostDiagnostics, HostLog, safeEvent } from '../host/log.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { WebSocket } from 'ws';
import { onceDetach, pumpOutput } from '../http/live-upgrade.js';
// Side-effect import: register the intent-tool suite in this process so a declared check runs it
// (live-session is in the contract scope; the check scripts are not).
import './intent-tools.test.js';
// Side-effect import: register the research-loop suite in this process so a declared check runs it.
import './research.test.js';
// Side-effect import: register the host-log allowlist suite in the declared live-session check (F7).
import './host-log.test.js';
// Side-effect import: register the 3j response-watchdog suite in the declared live-session check,
// the same way the host-log allowlist suite is registered here.
import './live-watchdog.test.js';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { McpRegistry, canonicalToolDigest } from '../adapters/mcp/registry.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import { declarationsFor, runToolCalls } from '../tools/declarations.js';
import { shapeGcalCalendars, shapeGcalList, shapeGmailList } from '../tools/live-shape.js';
import { LiveToolJobs, type ToolJob, type ToolJobResult, type JobTimer } from '../tools/jobs.js';
import type { LiveAuthority } from '../tools/types.js';
import { parseSelector, type ResearchSelector } from '../tools/research.js';
import { liveProfileIdentity } from '../live/config.js';
import type { ToolDefinition, HostContext } from '../adapters/model/types.js';
import { PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, LIVE_INSTRUCTION_TARGET_CHARS } from '../prompt/index.js';
import * as summaries from '../domain/summaries.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLiveConfig, liveSetupLanguage } from '../config/live.js';
import { NAYA_LIVE_BASE, NAYA_TOOLS, NAYA_BACKEND_PROCEDURE, MEMORY_SECTION_CHAR_LIMIT, LIVE_INSTRUCTION_HARD_LIMIT, LIVE_RECOVERY_PICKUP, composeLiveInstruction, composeLiveSessionInstruction } from '../prompt/live-persona.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions, LiveVoiceControl, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession, LiveToolResponse } from '../adapters/live-voice/index.js';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { traceMigrations } from '../trace/schema.js';
import type { Transaction } from '../contracts/storage.js';
import { createLiveSessionOwner, feedJobs, LiveConfigError, LiveError, liveMigrations, openerFromJournal, openersNote, OPENER_CONTEXT_CHARS, RESPONSE_WATCHDOG_NUDGE_MS, RESPONSE_WATCHDOG_RECOVERY_MS, TURN_FAILED_LINE, validateLiveProfile, type LiveContext, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import { CANARY, control, deferred, fixture, options, pcm } from './live-voice-fixture.js';
import { fixture as openAiFixture } from './openai-live-voice-fixture.js';
import { OPENAI_BACKEND_BREVITY, OPENAI_BACKEND_TEMPLATE } from '../adapters/live-voice/openai.js';
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
  toolRegistry?: McpRegistry;
  toolOwner?: ReturnType<typeof createToolsOwner>;
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
  history?: boolean;
  mattermost?: boolean;
  calendar?: boolean;
  mail?: boolean;
  research?: ResearchSelector;
  mailData?: (name: string, args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  mongoose?: boolean;
  mongooseData?: unknown;
  knowledgeSearchLimit?: number;
  calendarData?: (name: string, args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  beforeTool?: () => Promise<void>;
  knowledgeContent?: string;
  recover?: () => Promise<void>;
  beforeGate?: () => Promise<void>;
  /** R6: the work one Mattermost read does, so a test can hold a chat source open across a clock advance. */
  mattermostWork?: () => Promise<void>;
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
  let toolRegistry: McpRegistry | undefined;
  let exposedToolOwner: ReturnType<typeof createToolsOwner> | undefined;
  if (overrides.tools) {
    const schemas = [
      { name: 'search_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, detail: { type: 'string', enum: ['snippets', 'bodies'] }, max_chars: { type: 'integer' }, deadline_ms: { type: 'integer' } }, required: ['query', 'limit'], additionalProperties: false } },
      { name: 'get_insight', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } }, required: ['ids', 'include_links'], additionalProperties: false } },
    ];
    const registry = new McpRegistry(); toolRegistry = registry;
    const endpoint = { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'account', resource: 'resource' };
    registry.register(endpoint); registry.enable(endpoint.id); registry.allowEgress(endpoint.id);
    const sdk = new Server({ name: 'live-tools-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(schemas) }) as never);
    sdk.setRequestHandler('tools/call', async req => {
      calls.push({ name: req.params.name, args: req.params.arguments });
      await overrides.beforeTool?.();
      return { content: [{ type: 'text', text: overrides.knowledgeContent ?? '#123: Synthetic insight\n[Evidence](https://example.test/evidence)' }], ...(overrides.toolError ? { isError: true } : {}) };
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
      mattermostSdk.setRequestHandler('tools/call', async req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        await overrides.mattermostWork?.();
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
      calendarSdk.setRequestHandler('tools/call', async req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        const raw = overrides.calendarData ? await overrides.calendarData(req.params.name, req.params.arguments ?? {}) : req.params.name === 'gcal_list'
          ? { events: [{ summary: `Event on ${String(req.params.arguments?.['calendarId'] ?? 'primary')}` }] }
          : { calendars: [{ id: 'primary', summary: 'Primary' }, { id: 'work', summary: 'Work' }] };
        const { nextPageToken, ...data } = raw;
        return { content: [{ type: 'text', text: JSON.stringify({ family: 'calendar', tool: req.params.name, data, coverage: { complete: !nextPageToken, next_page_token: nextPageToken ?? null } }) }] };
      });
      await calendarSdk.connect(calendarTransport);
    }
    let mailSdk: Server | undefined;
    let mailTransport: WebStandardStreamableHTTPServerTransport | undefined;
    const mailEndpoint = { id: 'mail', url: 'https://fixture.invalid/mail', account: 'synthetic-mail-account', resource: 'synthetic-mailbox' };
    const mailSchemas = [
      { name: 'gmail_list', inputSchema: { type: 'object', properties: { q: { type: 'string' }, maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
      { name: 'gmail_read', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string', enum: ['full', 'metadata'] } }, required: ['id'], additionalProperties: false } },
    ];
    if (overrides.mail) {
      registry.register(mailEndpoint); registry.enable('mail'); registry.allowEgress('mail');
      mailSdk = new Server({ name: 'live-mail-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      mailTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      mailSdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(mailSchemas) }) as never);
      mailSdk.setRequestHandler('tools/call', async req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        const raw = await overrides.mailData!(req.params.name, req.params.arguments ?? {});
        const { nextPageToken, ...data } = raw;
        return { content: [{ type: 'text', text: JSON.stringify({ family: 'gmail', tool: req.params.name, data, coverage: { complete: !nextPageToken, next_page_token: nextPageToken ?? null } }) }] };
      });
      await mailSdk.connect(mailTransport);
    }
    let mongooseSdk: Server | undefined;
    let mongooseTransport: WebStandardStreamableHTTPServerTransport | undefined;
    const mongooseEndpoint = { id: 'mongoose', url: 'https://fixture.invalid/mongoose', account: 'account', resource: 'resource' };
    const mongooseSchemas = [{ name: 'search_mongoose', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false } }];
    if (overrides.mongoose) {
      registry.register(mongooseEndpoint); registry.enable(mongooseEndpoint.id); registry.allowEgress(mongooseEndpoint.id);
      mongooseSdk = new Server({ name: 'live-mongoose-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      mongooseTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      mongooseSdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(mongooseSchemas) }) as never);
      mongooseSdk.setRequestHandler('tools/call', req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        return { content: [{ type: 'text', text: JSON.stringify(overrides.mongooseData ?? { results: [{ entity_type: 'knowledge', id: 'synthetic-company-item', title: 'Synthetic company evidence', snippet: 'A current source answer.' }] }) }] };
      });
      await mongooseSdk.connect(mongooseTransport);
    }
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (mailTransport && request.url === mailEndpoint.url) return mailTransport.handleRequest(request);
      if (mongooseTransport && request.url === mongooseEndpoint.url) return mongooseTransport.handleRequest(request);
      if (mattermostTransport && mattermostEndpoint && request.url === mattermostEndpoint.url) return mattermostTransport.handleRequest(request);
      if (calendarTransport && calendarEndpoint && request.url === calendarEndpoint.url) return calendarTransport.handleRequest(request);
      return transport.handleRequest(request);
    });
    const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: (overrides.mail || overrides.knowledgeContent) ? 262144 : 10000, maxSliceBytes: 512 }), resolveCredential: async () => 'synthetic-token', budgets: { maxResponseBytes: (overrides.mail || overrides.knowledgeContent) ? 65536 : 12000, projectionChars: 10, timeoutMs: 1000 } });
    const toolOwner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, ...(overrides.history ? { grantMode: 'owner-trusted-reads' as const } : {}), lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? owner?.lookupJobAuthority(runId) ?? null });
    exposedToolOwner = toolOwner;
    if (overrides.beforeGate) {
      const authorize = toolOwner.resultGate.authorize.bind(toolOwner.resultGate);
      t.mock.method(toolOwner.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => { await overrides.beforeGate!(); return authorize(...args); });
    }
    toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'lux', generation: 1, enabled: true, connector: 'lux-knowledge',
      endpoint: { ...endpoint, credentialRef: null }, toolNames: ['search_knowledge', 'get_insight'], schemaDigest: canonicalToolDigest(schemas),
      sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
      route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
      bounds: { maxQueryChars: 80, maxSearchLimit: overrides.knowledgeSearchLimit ?? 3, maxGetIds: 3, maxEntityBytes: overrides.knowledgeContent ? 65536 : 4096, maxResultBytes: overrides.knowledgeContent ? 65536 : 4096 } });
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
    if (overrides.mail) {
      toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mail', generation: 1, enabled: true, connector: 'google',
        endpoint: { ...mailEndpoint, credentialRef: null }, toolNames: ['gmail_list', 'gmail_read'], schemaDigest: canonicalToolDigest(mailSchemas),
        sourcePolicy: { id: 'live-mail-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
        route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
        bounds: { maxQueryChars: 2048, maxSearchLimit: 50, maxGetIds: 3, maxEntityBytes: 65536, maxResultBytes: 65536 } });
      assert.equal((await port.discover('mail')).state, 'discovered'); toolOwner.projectConnection('mail');
    }
    if (overrides.mongoose) {
      toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mongoose', generation: 1, enabled: true, connector: 'mongoose',
        endpoint: { ...mongooseEndpoint, credentialRef: null }, toolNames: ['search_mongoose'], schemaDigest: canonicalToolDigest(mongooseSchemas),
        sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
        route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
        bounds: { maxQueryChars: 200, maxSearchLimit: 10, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
      assert.equal((await port.discover('mongoose')).state, 'discovered');
      toolOwner.projectConnection('mongoose');
    }
    toolOwner.projectConnection('lux');
    tools = { ...(overrides.recover ? { recover: overrides.recover } : {}), owner: toolOwner, connectionIds: () => ['lux', ...(overrides.mattermost ? ['mattermost'] : []), ...(overrides.calendar ? ['calendar'] : []), ...(overrides.mail ? ['mail'] : []), ...(overrides.mongoose ? ['mongoose'] : [])] };
    if (overrides.onSessionTerminal) tools = Object.assign({ ...tools }, { onSessionTerminal: overrides.onSessionTerminal });
    t.after(async () => { await port.close(); await transport.close(); await sdk.close(); if (mattermostSdk) await mattermostSdk.close(); if (calendarSdk) await calendarSdk.close(); if (mongooseSdk) await mongooseSdk.close(); if (mailSdk) await mailSdk.close(); });
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
  owner = createLiveSessionOwner({ store, voice, profile, ...{ memorySource }, ...(overrides.research ? { research: overrides.research } : {}), ...(tools ? { tools } : {}), now: () => overrides.scheduler?.now ?? clock, timeZone: 'Asia/Kolkata', ...(overrides.scheduler ? { schedule: overrides.scheduler.schedule } : {}) });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...(toolRegistry ? { toolRegistry } : {}), ...(exposedToolOwner ? { toolOwner: exposedToolOwner } : {}), requests, calls, get memorySelections() { return memorySelections; }, f, store, owner, ctx: context(store), dir, advance: ms => { if (overrides.scheduler) overrides.scheduler.now += ms; else clock += ms; } };
}

/** Attach a session on a custom port: `attached` speaks the Gemini fixture's frames, which a fake port never sees. */
async function openPort(h: Harness, key: string) {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  await settlePort();
  return { session, attachment };
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
  // 3p: the client closing the session is the Stop, and the Stop has its own reason.
  assert.deepEqual(terminal.terminal, { state: 'closed', code: 'user_stop' });
  assert.equal(terminal.journal.complete, true);
});

// 3o: the app let go at 19:23:49Z and the host kept the model speaking to a detached client for 62 s.
// 3p: a socket that closed with no Stop is a call that ended, so the end is one second, not five.
test('a consumer whose socket closed ends the session within one second as consumer_closed and keeps its journal', async t => {
  const scheduler = new DeadlineClock();
  const receipts: Record<string, unknown>[] = [];
  const detachSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => detachSink());
  // Only the detach countdown is under test: the idle, session and call ceilings stay far away.
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const { session, attachment } = await attached(h);
  attachment.detach();
  h.advance(999); scheduler.runDue();
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'a re-attach still has its second');
  h.advance(1); scheduler.runDue();
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'cancelled', code: 'consumer_closed' });
  assert.equal(terminal.journal.complete, true, 'the journal is kept');
  assert.ok(terminal.journal.events > 0, 'and it still holds what was said');
  const end = receipts.filter(record => record.event === 'session_end');
  assert.equal(end.length, 1, 'one receipt for the end');
  assert.deepEqual(end[0], { event: 'session_end', reason: 'consumer_closed', msAfterStop: 1_000 });
  assert.ok(safeEvent(end[0]), 'the host log whitelist accepts the end receipt');
  // The five second rule stays behind it as the last net and never fires once the session is settled.
  h.advance(10_000); scheduler.runDue();
  assert.equal(receipts.filter(record => record.event === 'consumer_gone_end').length, 0, 'no second end');
  assert.equal(receipts.filter(record => record.event === 'session_end').length, 1, 'no second receipt');
});

// Release 3x / call 1019: the app's socket went CLOSING mid-answer and the host kept a response and a
// delegation open for 28 s, because the output pump's throwing send left an empty catch and only the
// socket's own close watcher could detach. The pump now detaches once, on the socket, not on the send.
type PumpSocket = Parameters<typeof pumpOutput>[0];
const closingSocket = (mode: 'throw' | 'closing', onSend: () => void): PumpSocket => {
  const socket = { OPEN: 1, readyState: mode === 'throw' ? 1 : 2, bufferedAmount: 0,
    send(): void { onSend(); socket.readyState = 2; if (mode === 'throw') throw new Error('socket closing'); },
    close(): void { socket.readyState = 3; } };
  return socket as unknown as PumpSocket;
};

async function pumpIntoDeadSocket(t: TestContext, openDelegation: boolean): Promise<void> {
  const scheduler = new DeadlineClock();
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  // Only the detach countdown is under test: the idle, session and call ceilings stay far away.
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 },
    ...(openDelegation ? { tools: true, beforeTool: () => work } : {}) });
  const { attachment } = await attached(h);
  if (openDelegation) {
    h.f.send({ toolCall: { functionCalls: [{ id: 'open1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
    while (!h.calls.length) await tick();
  }
  // A response is streaming into the socket the app already cancelled.
  h.f.send({ serverContent: { modelTurn: { parts: [audio()] } } });
  let sends = 0;
  const detach = onceDetach(attachment);
  await pumpOutput(closingSocket(openDelegation ? 'closing' : 'throw', () => { sends += 1; }), attachment, detach, 1_024);
  detach(); // the socket's own close arrives after the pump and must not detach a second time
  h.advance(1_000); scheduler.runDue();
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'cancelled', code: 'consumer_closed' },
    'the end lands on the consumer-closed bound, not on the five second net');
  assert.equal(receipts.filter(record => record.event === 'consumer_detach').length, 1, 'one detach, one host line');
  assert.deepEqual(receipts.filter(record => record.event === 'session_end'),
    [{ event: 'session_end', reason: 'consumer_closed', msAfterStop: 1_000 }]);
  await h.f.closed; // resolves only when the host closed the provider session's own socket
  assert.notEqual(h.f.clients[0]!.readyState, WebSocket.OPEN, 'the provider session is closed');
  assert.equal(sends, openDelegation ? 0 : 1, 'a CLOSING socket is never written to; a throwing one is written once');
  h.advance(10_000); scheduler.runDue();
  assert.equal(receipts.filter(record => record.event === 'consumer_gone_end').length, 0, 'the five second net never fires');
}

test('an output pump whose socket goes CLOSING mid-answer detaches once and ends the session as consumer_closed', async t => {
  await pumpIntoDeadSocket(t, false);
});

test('the same socket death with an open delegation detaches once and ends the session as consumer_closed', async t => {
  await pumpIntoDeadSocket(t, true);
});

test('a user Stop ends the live session at once as user_stop and keeps its journal', async t => {
  const scheduler = new DeadlineClock();
  const receipts: Record<string, unknown>[] = [];
  const stopSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => stopSink());
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const { session, attachment } = await attached(h);
  h.f.send({ serverContent: { inputTranscription: { text: 'what the owner said' } } });
  await drain(h, session.liveSessionId, 2);
  // No clock advance: a Stop is felt now, not after a countdown.
  attachment.close();
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'closed', code: 'user_stop' });
  assert.equal(terminal.journal.complete, true, 'the journal is kept');
  assert.ok(terminal.journal.events > 0, 'and it still holds what was said');
  const end = receipts.filter(record => record.event === 'session_end');
  assert.equal(end.length, 1, 'one receipt for the end');
  assert.deepEqual(end[0], { event: 'session_end', reason: 'user_stop', msAfterStop: 0 });
  assert.ok(safeEvent(end[0]), 'the host log whitelist accepts the end receipt');
  // The socket closing right behind the Stop is the same end, never a second one.
  attachment.detach();
  h.advance(10_000); scheduler.runDue();
  assert.equal(receipts.filter(record => record.event === 'session_end').length, 1, 'no second receipt');
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'user_stop' }, 'the first reason stands');
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

test('a failed detach write is logged to the host log and a later read no longer reports the session attached', async t => {
  const lines: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { lines.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const h = await harness(t, { failingWrite: "consumer_state='ended'" });
  const { attachment } = await attached(h, 'detach-write-fail');
  assert.equal(h.owner.get(attachment.liveSessionId).consumerState, 'attached');
  attachment.detach();
  assert.deepEqual(lines.map(line => line.event).filter(event => event === 'consumer_detach' || event === 'live_detach_write_failed'),
    ['consumer_detach', 'live_detach_write_failed'],
    'one detach line, then the failed write, both in the host log');
  assert.equal(lines.find(line => line.event === 'consumer_detach')!['consumerState'], 'attached', 'the detach line names the state it found');
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
  // 3p: the client closing the session is the Stop, and the Stop has its own reason.
  assert.deepEqual(after.terminal, { state: 'closed', code: 'user_stop' });
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
    [chatMigrations, domainMigrations, liveMigrations, traceMigrations].map(migrations => [migrations[0]!.owner, Math.max(...migrations.map(migration => migration.version))]));
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
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness(t, { tools: true, beforeTool: () => work });
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
  finish();
  await h.f.frame(2);
  const ended = await waitFor(steps => (steps ?? [])[0]?.phase === 'end');
  assert.equal(ended![0]!.ok, true);
  assert.equal(ended![0]!.resultCount, undefined, 'no fabricated count: this shape carries none, and the citation count is not the item count');
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

test('PV1: the host accent block opens the head even with no overlay accent, and the terminal anchor still closes it', async t => {
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
  const parse = (line: string): Record<string, unknown> | undefined => {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  };
  const diagnostics = (): Record<string, unknown>[] => lines.map(parse).filter((entry): entry is Record<string, unknown> => entry?.event === 'live_session_diagnostics');
  for (let attempt = 0; attempt < 60 && diagnostics().length === 0; attempt++) await tick();
  const matches = (): Record<string, unknown> | undefined => diagnostics().find(entry => entry.headVoiceChars === sectionChars('voice-head')
    && entry.terminalVoiceChars === sectionChars('voice'));
  for (let attempt = 0; attempt < 60 && matches() === undefined; attempt++) await tick();
  const emitted = matches();
  assert.ok(emitted, `the diagnostics is emitted; saw ${JSON.stringify(diagnostics())}`);
  assert.ok(sectionChars('voice-head') > 0, 'the accent block alone gives the head its chars');
  assert.equal(emitted.headVoiceChars, sectionChars('voice-head'), 'the head count is the serialised head, accent block included');
  assert.equal('toolAnchorChars' in emitted, false, 'the tool-anchor diagnostic is gone');
  assert.equal(emitted.terminalVoiceChars, sectionChars('voice'), 'the terminal count is the serialised anchor plus the accent tail');
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


/** Read the output stream until one marker of `kind` arrives, and return the sequence the Mac sees. */
async function markerSequence(output: AsyncIterator<import('../live/types.js').LiveOutputChunk>, kind: string): Promise<number> {
  for (;;) {
    const item = await output.next();
    assert.equal(item.done, false, 'consumer remains attached across the rebuild');
    const chunk = item.value;
    if (chunk.kind === 'marker' && chunk.marker.kind === kind && chunk.marker.sequence !== null) return chunk.marker.sequence;
  }
}

test('a provider rebuild never lowers the marker sequence the Mac sees', async t => {
  const h = await harness(t);
  const { attachment } = await attached(h, 'resume-sequence');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ serverContent: { inputTranscription: { text: 'before the rebuild', finished: true } } });
  const before = await markerSequence(output, 'inputTranscription');
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-sequence-resumption-secret' }, goAway: { timeLeft: '10s' } });
  await h.f.frame(2);
  h.f.send({ setupComplete: {} });
  await continuity(output, 'resumed');
  // The rebuilt provider session counts its own events from one again; the sequence the Mac sees must not.
  h.f.send({ serverContent: { inputTranscription: { text: 'after the rebuild', finished: true } } });
  const after = await markerSequence(output, 'inputTranscription');
  assert.ok(after > before, `marker sequence ${after} after the rebuild must exceed ${before}`);
  attachment.close(); await attachment.done;
});

test('a judged no_pong receipt is a closed metadata-only host log shape', () => {
  const accepted = safeEvent({ event: 'live_no_pong', lastInboundAgeMs: 9_000, missedPongs: 2, bufferedAmount: 49_450 });
  assert.deepEqual(accepted, { event: 'live_no_pong', lastInboundAgeMs: 9_000, missedPongs: 2, bufferedAmount: 49_450 });
  assert.equal(safeEvent({ event: 'live_no_pong', lastInboundAgeMs: -1, missedPongs: 2, bufferedAmount: 0 }), undefined, 'a negative age is refused');
  assert.equal(safeEvent({ event: 'live_no_pong', lastInboundAgeMs: 9_000, missedPongs: 2, bufferedAmount: 0, text: 'leak' }), undefined, 'the shape stays closed');
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

// 3p: a list-first read went out before the real calendar lookup on the owner's morning call.
test('the calendar declarations never invite a list before an event read', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 60 } } as never;
  const descriptions = new Map(CONNECTOR_DESCRIPTORS['google']!.declarations(policy).map(declaration => [declaration.name, declaration.description]));
  assert.match(descriptions.get('gcal_calendars')!, /Call it only when the owner asks which calendars exist; an event read needs no calendar list\./);
  assert.match(descriptions.get('gcal_list')!, /Omit both for today in the host timezone\./);
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

test('F4: a barge-in keeps THINKING while the call is still in flight, and her answer ends it', async t => {
  const started = deferred<void>(), finish = deferred<void>();
  const h = await harness(t, { tools: true, beforeTool: async () => { started.resolve(); await finish.promise; } });
  const { session, attachment } = await attached(h, 'f4-barge');
  h.f.send({ toolCall: { functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  await started.promise;
  assert.equal(h.owner.current().state, 'thinking');
  h.f.send({ serverContent: { interrupted: true } });
  await drain(h, session.liveSessionId, 3);
  // D5 amendment C: a barge-in is the owner talking over her, not a hung tool forgetting its own call. The
  // open work still reads THINKING; the result and her first audible frame are what end it.
  assert.equal(h.owner.current().state, 'thinking', 'a barge-in never erases a call still in flight');
  finish.resolve();
  for (let i = 0; i < 200 && h.f.frames.length < 2; i++) await tick();
  h.f.send({ serverContent: { modelTurn: { parts: [audio()] } } });
  for (let i = 0; i < 200 && h.owner.current().state !== 'speaking'; i++) await tick();
  assert.equal(h.owner.current().state, 'speaking', 'her answer ends THINKING');
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

// R9: a research call refused at dispatch never reaches the research tool, so before this receipt it left no
// run line at all and a refused lookup read as a silent no-op in host.log.
test('R9: a research call refused at dispatch writes one failed run receipt', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-refused-research-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const h = await harness(t, { tools: true });
  await attached(h, 'refused-research');
  await settleLiveTool(h, 'ref1', 'research', { action: 'not_an_action' });
  const lines = readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event?: string; status?: string; stopReason?: string });
  const runs = lines.filter(line => line.event === 'research_run');
  assert.equal(runs.length, 1, 'the refused call leaves exactly one run receipt');
  assert.equal(runs[0]!.status, 'failed');
  assert.equal(runs[0]!.stopReason, 'refused');
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

test('a tool call in flight owns the silence, so the response watchdog never fires over it', async t => {
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const scheduler = new DeadlineClock();
  const h = await harness(t, { tools: true, beforeTool: () => slow, scheduler, limits: { idleMs: 600_000, sessionMs: 1_200_000 } });
  await attached(h);
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_watchdog' || record.event === 'live_dead_air_nudge') receipts.push(record);
  } });
  t.after(detach);
  h.f.send({ toolCall: { functionCalls: [{ id: 'watchdog1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] } });
  while (!h.calls.length) await tick();
  h.advance(RESPONSE_WATCHDOG_NUDGE_MS + RESPONSE_WATCHDOG_RECOVERY_MS + 20_000);
  scheduler.runDue(); await tick();
  const fired = receipts.filter(record => record.event === 'live_watchdog' && record['phase'] !== 'armed').map(record => record['phase']);
  assert.deepEqual(fired, [], 'a working tool is not silence: the watchdog never nudges or recovers over it');
  assert.ok(!receipts.some(record => record.event === 'live_dead_air_nudge'), 'the tool has not returned, so even the dead-air nudge has not fired');
  assert.equal(h.requests.length, 1, 'no recovery while the tool is in flight');
  finish();
  await h.f.frame(2);
  assert.ok(h.f.frames.some(frame => 'toolResponse' in (frame as object)), 'the tool response still reaches the provider');
  assert.equal(h.requests.length, 1, 'a delivered tool response returns to the same session');
});

test('a model turn start enters THINKING and every live_state change is written as it happens', async t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_state') receipts.push(record);
  } });
  t.after(() => detach());
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, language: 'en-IN' });
  const session = h.owner.create({ idempotencyKey: 'live-state-receipts', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const transitions = () => receipts.map(record => `${record.from === undefined ? '-' : String(record.from)}>${String(record.state)}@${String(record.cause)}`);
  const settle = async () => { for (let attempt = 0; attempt < 6; attempt += 1) await tick(); };
  await settle();
  assert.deepEqual(transitions(), ['->listening@created'], 'the opening state is written at the start, with no poll');
  fake.emit({ type: 'inputTranscription', text: 'plan my week', finished: true });
  fake.emit({ type: 'modelTurnStarted' });
  await settle();
  assert.deepEqual(transitions(), ['->listening@created', 'listening>thinking@model_turn_start'], 'a generation start is the think time');
  fake.emit({ type: 'audio', pcm, rate: 24_000 });
  await settle();
  fake.emit({ type: 'turnComplete' });
  await settle();
  assert.deepEqual(transitions(),
    ['->listening@created', 'listening>thinking@model_turn_start', 'thinking>speaking@audio', 'speaking>listening@turn_complete'],
    'each change is written once, when it happens, with the state it came from and why');
  for (const record of receipts) assert.ok(safeEvent(record), 'the host log whitelist accepts the exact transition shape');
  assert.equal(h.owner.get(session.liveSessionId).consumerState, 'attached', 'the owner is still attached and listening');
  attachment.close();
  await settle();
  assert.deepEqual(transitions().slice(-1), ['listening>ended@settle'], 'the end is written without a poll too');
});

test('an owner turn that ends arms the watchdog, and the next turn arms it again', async t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_watchdog') receipts.push(record);
  } });
  t.after(() => detach());
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, language: 'en-IN' });
  const session = h.owner.create({ idempotencyKey: 'watchdog-rearm', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const phases = () => receipts.map(record => String(record.phase));
  const ownerTurnEnd = async (text: string) => {
    fake.emit({ type: 'inputTranscription', text, finished: true });
    fake.emit({ type: 'modelTurnStarted' });
    for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  };
  await ownerTurnEnd('what is on my plate');
  assert.deepEqual(phases(), ['armed'], 'the ended owner turn owes a reply');
  fake.emit({ type: 'turnComplete' });
  // The second turn arms through the synthesized generation start alone, which is the event the real adapter
  // emits when a plain owner episode ends: that is what stops the watchdog going blind after the first turn.
  fake.emit({ type: 'modelTurnStarted' });
  for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  assert.deepEqual(phases(), ['armed', 'armed'], 'the second turn is watched as well, so the watchdog is never blind');
  attachment.close();
});

test('a delegated response with no audible output is nudged, and audible progress restarts the clock', async t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_watchdog') receipts.push(record);
  } });
  t.after(() => detach());
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  // Long timers: this test walks 19 s of wall clock, so only the response watchdog may fire.
  const h = await harness(t, { port: fake.port, scheduler, language: 'en-IN', limits: { idleMs: 600_000, sessionMs: 1_200_000 } });
  const session = h.owner.create({ idempotencyKey: 'delegated-busy', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const phases = () => receipts.map(record => String(record.phase));
  const advance = async (ms: number) => { h.advance(ms); scheduler.runDue(); for (let attempt = 0; attempt < 6; attempt += 1) await tick(); };
  // The fake port's event union does not declare the tool events the host already handles, so the shape is named here.
  fake.emit({ type: 'toolCall', calls: [{ id: 'call_1', name: 'research_lookup', args: { q: 'plate' } }] } as unknown as Parameters<typeof fake.emit>[0]);
  await advanceUntil(ms => h.advance(ms), scheduler, () => fake.toolResponses.length === 1);
  fake.emit({ type: 'modelTurnStarted' });
  for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  assert.deepEqual(phases(), ['armed'], 'the delegated response is watched from its start');
  for (let second = 0; second < 10; second += 1) await advance(1_000);
  // Amendment B: the result completed at t=0, so ten seconds of silence after it is the defect, not a slow
  // tool. The nudge is the first stage of the obligation, not a rebuild.
  assert.deepEqual(phases(), ['armed', 'nudged'], 'silence after the completed result earns the nudge');
  assert.equal(fake.sessionsOpened, 1, 'the working session is not rebuilt by a nudge');
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'the call is still up');
  // Audible progress speech is output, so it defers the deadline to 8 s from that frame (amendment A).
  fake.emit({ type: 'audio', pcm, rate: 24_000 });
  for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  for (let second = 0; second < 9; second += 1) await advance(1_000);
  assert.deepEqual(phases(), ['armed', 'nudged', 'armed', 'nudged'], 'a reply that went silent again is watched again');
  assert.equal(fake.sessionsOpened, 1, 'a nudge is not a recovery');
  attachment.close();
});

// P3: gpt-live-1 streams output frames for the whole call (48 kB/s in session 1018), so a frame is speech only
// when its level says so; a silent frame must leave the orb alone, and its playback milliseconds belong in the
// turn receipt.
test('P3: an inaudible output frame never puts the orb in SPEAKING, and the turn receipt counts it', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'p3-inaudible', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  assert.equal(h.owner.current().state, 'listening');
  // The fill that arrives before any word: 100 ms of digital silence.
  fake.emit({ type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: false, rmsDbfs: -120 });
  for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  assert.equal(h.owner.current().state, 'listening', 'a silent fill frame never puts the orb in SPEAKING');
  fake.emit({ type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 });
  for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  assert.equal(h.owner.current().state, 'speaking', 'her first audible frame is the start');
  fake.emit({ type: 'turnComplete' });
  for (let attempt = 0; attempt < 6; attempt += 1) await tick();
  attachment.close();
  // O1b-A: the turn's own trace row carries the fact instead of a journal line, and it says the silent fill
  // never became the turn's first audible frame.
  const turn = h.store.transaction(tx => tx.all('SELECT first_audible_at, close_reason FROM trace_turn WHERE live_session_id=?', [session.liveSessionId]));
  assert.equal(turn.length, 0, 'a turn opens on her words, not on an output frame: this call never spoke an owner turn');
});

/** Every journal line this data dir holds, fixture data only: the day directory is not pinned to a test clock. */

// --- Q5-R4: a fresh call never repeats the last calls' openers --------------------------------

test('Q5-R4: the opener context names at most three earlier openers, one or two sentences each, and stays under 450 chars', () => {
  assert.equal(openersNote([]), undefined, 'no earlier call means no context at all');
  const one = openersNote(['Morning. The release branch merged cleanly. A third line follows.']);
  assert.equal(one!.includes('Morning. The release branch merged cleanly.'), true, 'two short sentences are carried so the subject shows');
  assert.equal(one!.includes('A third line'), false, 'a third sentence is not carried');
  const three = openersNote(['Morning. Then more.', 'Evening. Then more.', 'Night. A third call.', 'Dawn. A fourth call.']);
  assert.equal(three!.split('"').length - 1, 6, 'only the three most recent openers are quoted');
  assert.equal(three!.includes('Dawn.'), false, 'the fourth call is beyond the three the host passes');
  assert.ok(three!.startsWith('Open on a different subject and different words than these earlier openers:'), 'the note asks for a different subject, not only different words');
  const long = openersNote([`${'A'.repeat(200)} first.`, `${'B'.repeat(200)} second.`, `${'C'.repeat(200)} third.`]);
  assert.ok(long!.length <= OPENER_CONTEXT_CHARS, `the note is bounded at ${OPENER_CONTEXT_CHARS} chars (${long!.length})`);
  assert.ok(!long!.includes('B'), 'an opener that does not fit is dropped whole, never cut mid sentence');
});

test('3u: the anti-repeat note names the topic each earlier opener came from, still under the cap', () => {
  const note = openersNote(['Morning. The release branch merged cleanly.'], ['the release branch merge']);
  assert.ok(note!.includes('"Morning. The release branch merged cleanly."'), 'the sentence is still quoted');
  assert.ok(note!.includes('(about the release branch merge)'), 'the topic the earlier plan offered is named beside it');
  assert.ok(note!.length <= OPENER_CONTEXT_CHARS, `the note stays bounded (${note!.length})`);
  const unnamed = openersNote(['Morning. Then more.'], [undefined]);
  assert.equal(unnamed!.includes('(about'), false, 'no topic is invented for an opener the plan cannot name');
  const long = openersNote([`${'A'.repeat(200)} first.`, `${'B'.repeat(200)} second.`], [`${'C'.repeat(200)} topic.`, undefined]);
  assert.ok(long!.length <= OPENER_CONTEXT_CHARS, `a long topic never breaks the cap (${long!.length})`);
  const full = openersNote([`${'A'.repeat(150)} first.`], [`${'T'.repeat(150)} topic.`]);
  assert.ok(full!.includes(`(about ${'T'.repeat(60)})`), 'the topic is clipped to one short clause');
});

test('3u: consecutive starts offer different stored open loops and record the plan as metadata', async t => {
  const h = await harness(t);
  // O1b-A removed the debug journal, so the plan receipt is a host log line, one per start, and the
  // sink keeps them in start order.
  const plans: Record<string, unknown>[] = [];
  const detachPlanSink = attachHostLogSink({ event: raw => { const record = raw as Record<string, unknown>; if (record['event'] === 'opener_plan') plans.push(record); } });
  t.after(() => detachPlanSink());
  h.store.transaction(tx => {
    summaries.insertSummary(tx, { liveSessionId: 'synthetic-shared-loop', status: 'complete', summary: 'The owner said the tax form is still to be filed.',
      endedAt: NOW - 3_600_000, now: NOW });
    summaries.insertSummary(tx, { liveSessionId: 'synthetic-accountant-loop', status: 'complete', summary: 'The owner said he still has to call the accountant.',
      endedAt: NOW - 7_200_000, now: NOW });
  });
  const snapshot = (liveSessionId: string): string => {
    const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [liveSessionId]))!;
    return (JSON.parse(String(row['accepted_prompt_snapshot'])) as { system: string }).system;
  };
  const first = h.owner.create({ idempotencyKey: 'opener-rotation-1', inputClass: 'ordinary' }, h.ctx);
  const second = h.owner.create({ idempotencyKey: 'opener-rotation-2', inputClass: 'ordinary' }, h.ctx);
  const loops = [first, second].map(session => /^- open loop: (.+)$/mu.exec(snapshot(session.liveSessionId))?.[1]);
  assert.ok(loops[0] !== undefined && loops[1] !== undefined, 'both starts compose an open loop from the stored summaries');
  assert.notEqual(loops[0], loops[1], `consecutive starts offer different loops (${loops.join(' / ')})`);
  assert.ok(snapshot(first.liveSessionId).includes('# Opening options'), 'the plan is one section of the instruction');
  assert.equal(plans.length, 2, 'each start records its own plan');
  assert.deepEqual(plans.map(plan => Object.keys(plan).sort().join(',')), ['event,kinds,rotation', 'event,kinds,rotation'], 'the receipt carries kinds and rotation only');
  assert.deepEqual(plans.map(plan => plan['kinds']), [['open-loop', 'recent-thread'], ['open-loop', 'recent-thread']], 'an empty calendar offers no calendar kind');
  assert.equal((plans[0]!['rotation'] as number) + 1, plans[1]!['rotation'], 'the persisted start counter advances by one');
});

test('S4b: an opener is assembled from its ordered fragments up to the first finished fragment or turn boundary', () => {
  const rows = (entries: [string, string | null, number | null][]) => entries.map(([kind, text, finished]) => ({ kind, text, finished }));
  assert.equal(openerFromJournal(rows([['outputTranscription', 'Morning.', 0], ['outputTranscription', ' The release', 0], ['outputTranscription', ' merged cleanly.', 1], ['outputTranscription', ' Later.', 0]])),
    'Morning. The release merged cleanly.', 'stops at the first finished fragment');
  assert.equal(openerFromJournal(rows([['outputTranscription', 'Morning.', 0], ['turnComplete', null, null], ['outputTranscription', ' Later.', 0]])),
    'Morning.', 'stops at a turn boundary');
  assert.equal(openerFromJournal(rows([['interrupted', null, null], ['outputTranscription', 'Morning.', 0]])),
    'Morning.', 'a boundary before the first speech does not hide the opener');
});

test('Q5-R4: a fresh call carries the previous opener assembled from its fragments, and the first call carries none', async t => {
  const h = await harness(t);
  const first = h.owner.create({ idempotencyKey: 'opener-first', inputClass: 'ordinary' }, h.ctx);
  assert.equal(accepted(h, first.liveSessionId).system.includes('earlier openers'), false, 'the first call has no earlier opener to avoid');
  // S4b: the first journal row is one streamed fragment, so the opener is assembled until the finished fragment.
  h.store.transaction(tx => {
    for (const [text, finished] of [['Morning.', 0], [' The release branch', 0], [' merged cleanly last night.', 1], [' A trailing line.', 0]] as const) {
      tx.run("INSERT INTO live_journal(live_session_id,kind,text,finished,payload_bytes,arrived_at) VALUES (?, 'outputTranscription', ?, ?, ?, 0)", [first.liveSessionId, text, finished, text.length]);
    }
  });
  const second = h.owner.create({ idempotencyKey: 'opener-second', inputClass: 'ordinary' }, h.ctx);
  const text = accepted(h, second.liveSessionId).system;
  assert.equal(text.includes('"Morning. The release branch merged cleanly last night."'), true, 'the assembled opener is named');
  assert.equal(text.includes('A trailing line'), false, 'a fragment after the finished fragment is not carried');
  assert.equal(text.split('earlier openers').length - 1, 1, 'the context appears once');
});

test('S4b: composeLive gives the OpenAI backend the procedure and Gemini keeps the shared voice conduct', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-backend-procedure-'));
  const domain = createDomainPort({ outbox: Outbox });
  const store = new Store(dir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-backend-log-'));
  const stopDiagnostics = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stopDiagnostics(); rmSync(captureDir, { recursive: true, force: true }); });

  // A native prompt places the public base and the tool conduct; a bare frozen prompt would replace them.
  const profile = (provider: 'gemini' | 'openai') => validateLiveProfile({
    ...profileInput(undefined, provider === 'openai' ? 'gpt-live-1' : MODEL, provider),
    prompt: { text: NAYA_LIVE_BASE, dataClass: 'ordinary' },
  });
  const openAi = await openAiFixture(t);
  const openAiLive = composeLive(store, dir, {
    profile: profile('openai'),
    credentials: { resolve: async () => CANARY }, socketFactory: openAi.socketFactory,
  }).service;
  t.after(() => openAiLive.shutdown());
  const openAiSession = openAiLive.create('ordinary', 'backend-procedure-openai', context(store));
  const openAiAttachment = openAiLive.attach(openAiSession.liveSessionId, context(store));
  await openAi.frame(1);
  openAi.send({ type: 'session.started', session: { id: 'sess_fake' } });
  await openAiAttachment.ready;
  const start = openAi.frames[0] as unknown as { session: Record<string, unknown> };
  const responses = (start.session['delegation'] as { responses: Record<string, unknown> }).responses;
  assert.equal(responses['instructions'], `${OPENAI_BACKEND_TEMPLATE}\n\n${OPENAI_BACKEND_BREVITY}\n\n${NAYA_BACKEND_PROCEDURE}`, 'the OpenAI backend instructions are the template, the brevity rule and the lookup procedure');
  assert.equal(String(start.session['instructions']).includes(NAYA_BACKEND_PROCEDURE), false, 'the OpenAI voice instructions never carry the procedure');

  const gemini = await fixture(t);
  const geminiLive = composeLive(store, dir, {
    profile: profile('gemini'),
    credentials: { resolve: async () => CANARY }, socketFactory: gemini.socketFactory,
  }).service;
  t.after(() => geminiLive.shutdown());
  const geminiSession = geminiLive.create('ordinary', 'backend-procedure-gemini', context(store));
  const geminiAttachment = geminiLive.attach(geminiSession.liveSessionId, context(store));
  await gemini.frame(1);
  gemini.send({ setupComplete: {} });
  await geminiAttachment.ready;
  const setup = (gemini.frames[0] as { setup: { systemInstruction: { parts: { text: string }[] }; delegation?: unknown } }).setup;
  assert.ok(setup.systemInstruction.parts[0]!.text.includes(NAYA_LIVE_BASE), 'the Gemini setup carries the shared voice instruction');
  assert.equal(setup.systemInstruction.parts[0]!.text.includes(NAYA_BACKEND_PROCEDURE), false, 'the Gemini setup never carries the delegated procedure');
  assert.equal('delegation' in setup, false, 'the Gemini setup carries no delegated backend');
});

/** D3/D5 receipts are read from the host log itself, so the test proves the operator-visible record. */
function hostLines(dir: string): Record<string, unknown>[] {
  const text = readFileSync(join(dir, 'logs', 'host.log'), 'utf8').trim();
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}
const phasesOf = (dir: string): unknown[] => hostLines(dir).filter(line => line.event === 'live_watchdog').map(line => line.phase);
const fillFrame = { type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: false, rmsDbfs: -120 } as const;
const audibleFrame = { type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 } as const;
/** The fixture port forwards any port event; its declared union predates tool calls and the silence model. */
const portEvent = (event: unknown) => event as never;
const settlePort = async (): Promise<void> => { for (let i = 0; i < 12; i++) await tick(); };

test('D3: fill frames never disarm the watchdog, so a tool result with no audible answer is nudged at 8 s and recovered at 15 s', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-fill-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'd3-fill', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'toolCall', calls: [{ id: 'k1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] }));
  await settlePort();
  assert.equal(fake.toolResponses.length, 1, 'the lookup answered at t=0');
  // The provider streams a fill frame every 100 ms and never a frame above the audible threshold.
  for (let elapsed = 0; elapsed < 16_000; elapsed += 100) {
    fake.emit(fillFrame);
    await settlePort();
    h.advance(100);
    scheduler.runDue();
  }
  assert.deepEqual(phasesOf(captureDir), ['armed', 'nudged', 'recovered'], 'one clock: the nudge at 8 s and the recovery at 15 s');
  const stall = hostLines(captureDir).find(line => line.event === 'live_dead_air' && line.msSinceTool !== undefined);
  assert.ok(stall, 'the stall leaves a live_dead_air receipt');
  assert.equal(stall!['msSinceTool'], 8_000, 'the answer had been owed for eight seconds');
  assert.equal(stall!['msSinceAudible'], null, 'and no audible frame had ever played');
  assert.equal(hostLines(captureDir).filter(line => line.event === 'live_dead_air_nudge').length, 1, 'exactly one nudge');
  assert.equal(fake.sessionsOpened, 2, 'the recovery opens one fresh session');
  attachment.close();
});

test('D3: one audible frame restarts the deadline from that frame, never from the tool result', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-refill-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'd3-refill', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'toolCall', calls: [{ id: 'k2', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] }));
  await settlePort();
  for (let elapsed = 0; elapsed < 18_100; elapsed += 100) {
    fake.emit(elapsed === 3_000 ? audibleFrame : fillFrame);
    await settlePort();
    h.advance(100);
    scheduler.runDue();
  }
  const nudges = hostLines(captureDir).filter(line => line.event === 'live_dead_air');
  assert.equal(nudges.length, 1, 'one stall receipt for the one nudge');
  assert.equal(nudges[0]!['msSinceTool'], 11_000, 'the clock runs from the audible frame at 3 s');
  assert.deepEqual(phasesOf(captureDir), ['armed', 'nudged', 'recovered'], 'and the recovery follows 7 s after that nudge');
  assert.equal(fake.sessionsOpened, 2);
  attachment.close();
});

test('D3: a progress line followed by silence still recovers on the same clock', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-progress-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'd3-progress', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'toolCall', calls: [{ id: 'k3', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] }));
  await settlePort();
  // Progress speech: audible, then silence again with no answer.
  fake.emit(audibleFrame);
  for (let elapsed = 0; elapsed < 16_000; elapsed += 1_000) {
    h.advance(1_000);
    scheduler.runDue();
    await settlePort();
  }
  const stall = hostLines(captureDir).find(line => line.event === 'live_dead_air' && line.msSinceTool !== undefined);
  assert.ok(stall, 'progress speech is not fulfilment, so the stall is still witnessed');
  assert.equal(stall!['msSinceAudible'], 8_000, 'the receipt counts the audible progress frame');
  assert.deepEqual(phasesOf(captureDir), ['armed', 'nudged', 'recovered'], 'the deadline still ends in the fresh-seeded recovery');
  assert.equal(fake.sessionsOpened, 2);
  attachment.close();
});

test('D5: a lookup is THINKING through the silence model and a barge-in until the result and her first audible frame', async t => {
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { port: fake.port, scheduler, tools: true, beforeTool: () => gate, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'd5-thinking', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  assert.equal(h.owner.current().state, 'listening');
  fake.emit(portEvent({ type: 'toolCall', calls: [{ id: 'k4', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] }));
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'the tool call itself enters THINKING');
  fake.emit(portEvent({ type: 'waitingForInput', value: true }));
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'the adapter silence model never clears a call in flight');
  fake.emit({ type: 'interrupted' });
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'a barge-in leaves the open call thinking');
  release();
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'the answer is owed from the result until her first audible frame');
  fake.emit(audibleFrame);
  await settlePort();
  assert.equal(h.owner.current().state, 'speaking', 'her first audible frame ends THINKING');
  attachment.close();
});

test('D6: the adapter silence model between her sentences never drops the orb out of SPEAKING', async t => {
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'd6-speaking', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit({ type: 'modelTurnStarted' });
  fake.emit(audibleFrame);
  await settlePort();
  assert.equal(h.owner.current().state, 'speaking');
  // The adapter's 500 ms output-silence model reports the between-sentence gap as waiting for input.
  h.advance(500);
  scheduler.runDue();
  fake.emit(portEvent({ type: 'waitingForInput', value: true }));
  await settlePort();
  assert.equal(h.owner.current().state, 'speaking', 'half a second of silence is not the end of the turn');
  h.advance(999);
  scheduler.runDue();
  await settlePort();
  assert.equal(h.owner.current().state, 'speaking', '1,499 ms after her last audible frame it is still speaking');
  h.advance(1);
  scheduler.runDue();
  await settlePort();
  assert.equal(h.owner.current().state, 'listening', '1,500 ms of audible silence ends it');
  attachment.close();
});

/**
 * S4a: a GPT-Live shaped fake port. It records the two appends the host can send (progress commentary and silent
 * thinking), so the openai path is exercised with no network, no model and no real clock.
 */
function progressPort() {
  const commentary: string[] = [];
  const thinking: string[] = [];
  /** W4: whether the transport can carry a commentary at all, which the real adapter answers per delegation. */
  let commentaryDelivered = true;
  /** Every text input the host pushed: the OpenAI path must never send the `Continue.` user turn (review F2). */
  const texts: string[] = [];
  const toolResponses: LiveToolResponse[][] = [];
  let emit: (event: unknown) => void = () => {};
  let sessionsOpened = 0;
  const port: LiveVoicePort = {
    capabilities: { ...fakeLiveVoicePort().port.capabilities, provider: 'openai', supportsResumption: true },
    open(_request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      sessionsOpened += 1;
      let closed = false;
      let resolveDone: (value: LiveVoiceOutcome) => void = () => {};
      const done = new Promise<LiveVoiceOutcome>(resolve => { resolveDone = resolve; });
      const pending: LiveVoiceEvent[] = [];
      let waiter: (() => void) | undefined;
      const wake = () => { const waiting = waiter; waiter = undefined; if (waiting) waiting(); };
      let sequence = 0;
      emit = event => { pending.push({ ...(event as Record<string, unknown>), sequence: ++sequence } as unknown as LiveVoiceEvent); wake(); };
      control.signal.addEventListener('abort', () => {
        if (closed) return;
        closed = true; wake(); resolveDone({ status: 'cancelled', code: 'cancelled' });
      }, { once: true });
      let readySeen = false;
      const events: AsyncIterable<LiveVoiceEvent> = {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (!readySeen) { readySeen = true; yield { sequence: ++sequence, type: 'ready' }; continue; }
            if (!pending.length) { await new Promise<void>(resolve => { waiter = resolve; }); continue; }
            yield pending.shift()!;
          }
        },
      };
      return {
        ready: Promise.resolve(), events, done,
        sendToolResponse(input: { responses: LiveToolResponse[] }): void { toolResponses.push(input.responses); },
        sendAudio(): void {}, sendText(input: { text: string }): void { texts.push(input.text); }, endAudioStream(): void {},
        sendCommentary(input: { text: string }): boolean {
          if (!commentaryDelivered) return false;
          commentary.push(input.text);
          return true;
        },
        sendThinking(input: { text: string }): void { thinking.push(input.text); },
        close(): void { if (closed) return; closed = true; wake(); resolveDone({ status: 'closed', code: 'closed' }); },
      };
    },
  };
  return { port, commentary, thinking, texts, toolResponses, emit: (event: unknown) => emit(event),
    /** W4: a transport with no open delegation refuses the append, exactly as the GPT-Live wire does. */
    refuseCommentary: () => { commentaryDelivered = false; },
    get sessionsOpened() { return sessionsOpened; } };
}

const openaiLimits = { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 };

test('progress speech fires once about 6 s into an open delegation, and not before', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'progress-first');
  // The lookup is still running: this is the delegation the owner is waiting on.
  fake.emit({ type: 'toolCall', calls: [{ id: 'svc1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  assert.deepEqual(fake.thinking, ['Reading knowledge. Nothing has been sent or booked while that runs.'], 'one silent line says what is running');
  assert.equal(receipts.filter(entry => entry['event'] === 'thinking_sent').length, 1);
  h.advance(5_999); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, [], 'nothing is said before the first deadline');
  h.advance(1); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, ['Still reading the knowledge.'], 'one factual line, built from the ledger');
  assert.deepEqual(receipts.filter(entry => entry['event'] === 'commentary_sent').map(entry => entry['reason']), ['dead_air']);
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});

test('progress speech is suppressed while the owner speaks', async t => {
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'progress-suppressed');
  fake.emit({ type: 'toolCall', calls: [{ id: 'svc2', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  // The owner is talking over the lookup: the line would step on her.
  h.advance(5_000); scheduler.runDue();
  fake.emit({ type: 'inputTranscription', text: 'wait a moment', finished: false });
  await settlePort();
  h.advance(1_000); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, [], 'no progress speech over a speaking owner');
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});




// --- W4: no long silence while a call is in flight ------------------------------------------------

test('W4: a turn gets at most two progress lines, and never two inside six seconds', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // A held chat source keeps real work in flight past three beats, which no tool ceiling cuts short.
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mattermost: true, mattermostWork: () => held, scheduler, limits: openaiLimits });
  const { session } = await openPort(h, 'progress-cap');
  fake.emit({ type: 'toolCall', calls: [{ id: 'cap1', name: 'research', args: { action: 'start', question: 'Synthetic progress cap', lookups: [{ source: 'chat', query: 'Synthetic progress cap' }] } }] });
  await settlePort();
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 1, 'the first line goes out about six seconds into the call');
  h.advance(5_999); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 1, 'a second line waits the full six seconds');
  h.advance(1); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 2, 'the second line is six seconds after the first');
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 2, 'a turn never speaks a third progress line');
  const skips = receipts.filter(entry => entry['event'] === 'commentary_skipped').map(entry => entry['reason']);
  assert.ok(skips.includes('budget'), `the refused line leaves a receipt, not silence: ${JSON.stringify(skips)}`);
  assert.deepEqual(fake.texts, [], 'the fake owner turn is never sent on the GPT-Live path');
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});

test('W4: no progress line once the tool result has been sent', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits });
  const { session } = await openPort(h, 'progress-after-result');
  fake.emit({ type: 'toolCall', calls: [{ id: 'done1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  assert.equal(fake.toolResponses.length, 1, 'the result is already with the model');
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, [], 'a turn with nothing in flight never says it is still reading');
  assert.ok(receipts.some(entry => entry['event'] === 'commentary_skipped'), 'the decision is on the record');
  h.owner.revoke(session.liveSessionId);
});

test('W4: a refused commentary is a receipt, never a claimed send', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'progress-refused');
  fake.refuseCommentary();
  fake.emit({ type: 'toolCall', calls: [{ id: 'ref1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, [], 'the transport refused it, so the owner heard nothing');
  const refused = receipts.filter(entry => entry['event'] === 'commentary_skipped').map(entry => entry['reason']);
  assert.ok(refused.includes('no_delegation'), `the skip names why: ${JSON.stringify(refused)}`);
  assert.equal(receipts.filter(entry => entry['event'] === 'commentary_sent').length, 0, 'and nothing claims it was sent');
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});

// --- R6: late findings reach the voice model, and are spoken only on a quiet turn -----------------

/** The owner's memory answers in process and the chat read is held, so 4.5 s arrives with one source open. */
const LATE_LOOKUPS = [{ source: 'memory', query: 'dentist' }, { source: 'chat', query: 'standup' }];

test('R6: a source that settles after the first answer is appended once, and said once on a quiet turn', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mattermost: true, scheduler, limits: openaiLimits, mattermostWork: () => held });
  note(h, 'r6-mem', 'he asked me to remember the dentist on Friday');
  const { session } = await openPort(h, 'late-quiet');
  fake.emit({ type: 'toolCall', calls: [{ id: 'lr1', name: 'research', args: { action: 'start', question: 'what did he ask me to remember', lookups: LATE_LOOKUPS } }] });
  await settlePort();
  h.advance(4_500); scheduler.runDue(); await settlePort();
  assert.equal(fake.toolResponses.length, 1, 'the tool output is written with a source still reading');
  const reply = (fake.toolResponses[0]![0]!.response) as Record<string, unknown>;
  assert.deepEqual(reply['pending'], ['chat'], `the reply names the source it is still reading: ${JSON.stringify(reply).slice(0, 500)}`);
  assert.ok((reply['findings'] as unknown[]).length > 0, 'and carries what is already in hand');
  assert.equal(receipts.filter(entry => entry['event'] === 'research_first_answer').length, 1, 'one receipt for the answer point');
  assert.deepEqual(fake.thinking.filter(text => text.startsWith('Later findings from')), [], 'nothing is appended before the reader lands');
  release();
  await settlePort();
  const late = receipts.filter(entry => entry['event'] === 'research_late_findings');
  assert.equal(late.length, 1, 'one receipt for the source that landed later');
  assert.equal(late[0]!['source'], 'chat');
  assert.equal(late[0]!['delivered'], 'commentary', 'a quiet turn hears it once');
  assert.equal(fake.thinking.filter(text => text.startsWith('Later findings from chat')).length, 1, 'the model is always told');
  assert.deepEqual(fake.commentary.map(text => text.split(':')[0]), ['One more thing from chat'], 'one spoken line, naming the source');
  h.owner.revoke(session.liveSessionId);
});

test('R6: a late finding speaks nothing over an owner who has started a new question', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mattermost: true, scheduler, limits: openaiLimits, mattermostWork: () => held });
  note(h, 'r6-mem-busy', 'he asked me to remember the dentist on Friday');
  const { session } = await openPort(h, 'late-busy');
  fake.emit({ type: 'toolCall', calls: [{ id: 'lr2', name: 'research', args: { action: 'start', question: 'what did he ask me to remember', lookups: LATE_LOOKUPS } }] });
  await settlePort();
  h.advance(4_500); scheduler.runDue(); await settlePort();
  assert.deepEqual(((fake.toolResponses[0]![0]!.response) as Record<string, unknown>)['pending'], ['chat']);
  // The owner talks over the answer: the block is context only from here on.
  h.advance(500); scheduler.runDue(); await settlePort();
  fake.emit({ type: 'inputTranscription', text: 'and what about the other thing', finished: false });
  await settlePort();
  release();
  await settlePort();
  const late = receipts.filter(entry => entry['event'] === 'research_late_findings');
  assert.equal(late.length, 1);
  assert.equal(late[0]!['delivered'], 'thinking', 'silent context only');
  assert.notEqual(late[0]!['reason'], 'quiet', 'and the receipt says why it stayed silent');
  assert.equal(fake.thinking.filter(text => text.startsWith('Later findings from chat')).length, 1, 'the model still carries it');
  assert.deepEqual(fake.commentary, [], 'the owner hears nothing over herself');
  h.owner.revoke(session.liveSessionId);
});


test('R6/B1: a late finding stays silent while the owner speech that began before the answer runs on', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mattermost: true, scheduler, limits: openaiLimits, mattermostWork: () => held });
  note(h, 'r6-mem-speech', 'he asked me to remember the dentist on Friday');
  const { session } = await openPort(h, 'late-owner-speech');
  fake.emit({ type: 'toolCall', calls: [{ id: 'lr3', name: 'research', args: { action: 'start', question: 'what did he ask me to remember', lookups: LATE_LOOKUPS } }] });
  await settlePort();
  // She started talking before any answer could go out, and no turn boundary has arrived yet.
  h.advance(3_500); scheduler.runDue(); await settlePort();
  fake.emit({ type: 'inputTranscription', text: 'so about that', finished: false });
  await settlePort();
  h.advance(1_000); scheduler.runDue(); await settlePort();
  assert.deepEqual(((fake.toolResponses[0]![0]!.response) as Record<string, unknown>)['pending'], ['chat'], 'the answer went out while she was still speaking');
  release();
  await settlePort();
  const late = receipts.filter(entry => entry['event'] === 'research_late_findings');
  assert.equal(late.length, 1);
  assert.equal(late[0]!['delivered'], 'thinking', 'silent context only');
  assert.equal(late[0]!['reason'], 'owner_speaking', 'her own voice, not the model\'s answer audio');
  assert.deepEqual(fake.commentary, [], 'nothing is said over the owner');
  assert.equal(fake.thinking.filter(text => text.startsWith('Later findings from chat')).length, 1, 'the model still carries it');
  h.owner.revoke(session.liveSessionId);
});

test('R6: Gemini has no thinking channel on this path, so a late finding is dropped with a receipt', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { tools: true, mattermost: true, scheduler, limits: openaiLimits, mattermostWork: () => held });
  note(h, 'r6-mem-gemini', 'he asked me to remember the dentist on Friday');
  await attached(h, 'late-gemini');
  const before = toolResponseCount(h);
  h.f.send({ toolCall: { functionCalls: [{ id: 'gr1', name: 'research', args: { action: 'start', question: 'what did he ask me to remember', lookups: LATE_LOOKUPS } }] } });
  await settlePort();
  h.advance(4_500); scheduler.runDue(); await settlePort();
  for (let i = 0; i < 400 && toolResponseCount(h) === before; i++) await tick();
  assert.equal(toolResponseCount(h), before + 1, `the first answer still reaches the backend: ${JSON.stringify({ calls: h.calls, receipts }).slice(0, 600)}`);
  assert.equal(receipts.filter(entry => entry['event'] === 'research_first_answer').length, 1);
  release();
  for (let i = 0; i < 400; i++) { if (receipts.some(entry => entry['event'] === 'research_late_findings')) break; await tick(); }
  const late = receipts.filter(entry => entry['event'] === 'research_late_findings');
  assert.equal(late.length, 1, 'one receipt, and nothing appended');
  assert.equal(late[0]!['delivered'], 'dropped');
  assert.equal(late[0]!['reason'], 'no_thinking_channel');
});

test('a tool past the host ceiling is answered once with a timeout and one continuation', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => new Promise<void>(() => {}) });
  const { session } = await openPort(h, 'ceiling');
  fake.emit({ type: 'toolCall', calls: [{ id: 'ceil1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  assert.equal(fake.toolResponses.length, 0, 'the tool has not answered on its own');
  h.advance(12_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.toolResponses.length, 1, 'exactly one answer reaches the backend');
  assert.deepEqual(fake.toolResponses[0], [{ id: 'ceil1', name: 'search_knowledge', response: { error: 'timeout' } }]);
  assert.deepEqual(receipts.filter(entry => entry['event'] === 'tool_ceiling_hit'), [
    { event: 'tool_ceiling_hit', tool: 'search_knowledge', ms: 12_000, outcome: 'timeout' },
  ]);
  h.advance(1_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.toolResponses.length, 1, 'and only one continuation, never a second answer');
  h.owner.revoke(session.liveSessionId);
});

test('a delegation still open at 25 s logs its stall, speaks once and is not rebuilt', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'stall');
  fake.emit({ type: 'resumptionHandle', handle: 'synthetic-stall-handle' });
  await settlePort();
  fake.emit({ type: 'toolCall', calls: [{ id: 'stall1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  release();
  await settlePort();
  h.advance(25_000); scheduler.runDue(); await settlePort();
  const stalls = receipts.filter(entry => entry['event'] === 'gptlive_delegation_stalled');
  assert.equal(stalls.length, 1, 'one stall receipt, not a stream of them');
  assert.deepEqual(stalls[0], { event: 'gptlive_delegation_stalled', ms: 25_000 });
  assert.deepEqual(fake.commentary.at(-1), 'the knowledge lookup is done.', 'the line names the execution receipt');
  // S4a-R2 (b): the stall deadline is diagnostic. Escalation is S2's, so the receipts show its recovery and the
  // session count shows the stall started nothing of its own.
  const recoveries = receipts.filter(entry => entry['event'] === 'live_recovery');
  assert.equal(fake.sessionsOpened, 1 + recoveries.length, 'the stall added no session of its own');
  assert.ok(receipts.some(entry => entry['event'] === 'live_watchdog' && entry['phase'] === 'nudged'), 'S2 keeps its own escalation');
  h.owner.revoke(session.liveSessionId);
});

test('S4a-R2 (a): a write past the ceiling settles as uncertain, and a late callback never answers twice', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'ceiling-write');
  // The note waits for the owner's transcript, so the batch is dispatched once that lands.
  fake.emit({ type: 'inputTranscription', text: 'remember this', finished: true });
  await settlePort();
  fake.emit({ type: 'toolCall', calls: [
    { id: 'w1', name: 'remember_note', args: { text: 'synthetic note', kind: 'note' } },
    { id: 'r1', name: 'search_knowledge', args: { query: 'x', limit: 1 } },
  ] });
  await settlePort();
  h.advance(12_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.toolResponses.length, 1, 'one settlement reaches the backend');
  // A read that ran past the ceiling timed out; a write the host cannot prove is uncertain, never a plain timeout.
  assert.deepEqual(fake.toolResponses[0], [
    { id: 'w1', name: 'remember_note', response: { error: 'outcome_uncertain' } },
    { id: 'r1', name: 'search_knowledge', response: { error: 'timeout' } },
  ]);
  // The settlements are distinct statuses, and none of them claims the remote side stopped.
  const hits = receipts.filter(entry => entry['event'] === 'tool_ceiling_hit');
  assert.deepEqual(hits, [
    { event: 'tool_ceiling_hit', tool: 'remember_note', ms: 12_000, outcome: 'uncertain' },
    { event: 'tool_ceiling_hit', tool: 'search_knowledge', ms: 12_000, outcome: 'timeout' },
  ]);
  // The callback lands after the settlement: it may not rewrite it or write a second output.
  release();
  await settlePort();
  assert.deepEqual(receipts.filter(entry => entry['event'] === 'tool_ceiling_late').map(entry => entry['outcome']), ['completed', 'completed'],
    'a late callback is a receipt, never a second answer');
  assert.equal(fake.toolResponses.length, 1, 'a late callback never produces a second output');
  assert.deepEqual(fake.toolResponses[0]?.[0], { id: 'w1', name: 'remember_note', response: { error: 'outcome_uncertain' } });
  h.owner.revoke(session.liveSessionId);
});

test('S4a-R2 (a): a call cancelled before execution keeps its own receipt and is never answered', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => new Promise<void>(() => {}) });
  const { session } = await openPort(h, 'ceiling-cancelled');
  fake.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  // The provider cancels the call before the ceiling: its abort signal is set, so the host knows it never ran.
  fake.emit({ type: 'toolCallCancellation', ids: ['c1'] });
  await settlePort();
  h.advance(12_000); scheduler.runDue(); await settlePort();
  // S4a-R2 (a): "cancelled before execution" is the provider cancellation's own receipt, and such a call is owed no
  // answer at all, so it never settles at the ceiling (3r keeps that behaviour).
  assert.equal(receipts.filter(entry => entry['event'] === 'tool_ceiling_hit').length, 0, 'no ceiling settlement for a cancelled call');
  assert.deepEqual(receipts.filter(entry => entry['event'] === 'tool_cancelled').map(entry => entry['tool']), ['search_knowledge']);
  assert.deepEqual(fake.toolResponses, [], 'a provider-cancelled call is never answered (3r)');
  h.owner.revoke(session.liveSessionId);
});

test('S4a-R2 (e): thinking never claims nothing changed around a write, and the line names execution state', async t => {
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'thinking-write');
  fake.emit({ type: 'toolCall', calls: [{ id: 'w2', name: 'remember_note', args: { text: 'synthetic note', kind: 'note' } }] });
  await settlePort();
  assert.deepEqual(fake.thinking, ['Reading memory.'], 'a write in the batch means no claim about what changed');
  h.advance(6_000); scheduler.runDue(); await settlePort();
  // S4a-R2 (e): the host waits for the owner transcript before a remember_note is dispatched, so the honest
  // word is queued, never "reading".
  assert.deepEqual(fake.commentary, ['waiting on the memory.'], 'a queued call is never described as being read');
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});

test('S4a-R2 (f): a commentary ack never satisfies the answer watchdog', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const nudges = (): number => receipts.filter(entry => entry['event'] === 'live_dead_air_nudge').length;

  // The ack path: the progress line goes out and the debt is still owed, so the watchdog escalates anyway.
  const acked = await openPort(h, 'ack-watchdog');
  fake.emit({ type: 'toolCall', calls: [{ id: 'a1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  // W4: a progress line only goes out while the call is in flight, so the ack under test is spoken here.
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 1, 'the progress line went out: that is the ack under test');
  assert.equal(nudges(), 0, 'the ack is not a delivery and the watchdog has not spoken yet');
  release();
  await settlePort();
  h.advance(8_000); scheduler.runDue(); await settlePort();
  assert.equal(nudges(), 1, 'the watchdog still escalated after the commentary ack');
  acked.attachment.close();
  await settlePort();

  // The delivery path: the answer's own audible audio is the one thing that ends the debt, so no deadline escalates.
  const before = nudges();
  const answered = await openPort(h, 'audio-delivery');
  fake.emit({ type: 'toolCall', calls: [{ id: 'a2', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  h.advance(6_000); scheduler.runDue(); await settlePort();
  fake.emit({ type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 });
  await settlePort();
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.equal(nudges(), before, 'audible audio, not an ack, is what the watchdog accepts');
  answered.attachment.close();
});

test('W4: a research-only batch still gets its silent line', async t => {
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mattermost: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'research-thinking');
  // W4-R2: the tool-call handler used to hand #sendThinking a list it had already stripped of the research call,
  // so a batch of nothing but research looked like a batch of nothing at all and no line went out.
  fake.emit({ type: 'toolCall', calls: [{ id: 'w4r2', name: 'research', args: { action: 'start', question: 'Synthetic research batch', sources: ['chat'] } }] });
  await settlePort();
  assert.equal(fake.thinking.length, 1, 'the research lookup reaches the silent channel');
  assert.match(fake.thinking[0]!, /Running a lookup across your sources/, 'and the line names the fan-out, not a source');
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});

test('review F1/F2: the research lookup, the one the model can call, speaks and thinks', async t => {
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // `research` is the only lookup the production model is declared, so this is the reachable path (review F2).
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mattermost: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { session } = await openPort(h, 'research-progress');
  fake.emit({ type: 'toolCall', calls: [{ id: 'r1', name: 'research', args: { action: 'start', question: 'what did the team say about the budget', sources: ['chat'] } }] });
  await settlePort();
  assert.equal(fake.thinking.length, 1, 'silent truth goes out for a research lookup');
  assert.match(fake.thinking[0]!, /Running a lookup across your sources\. Nothing has been sent or booked while that runs\./);
  h.advance(6_000); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 1, 'progress speech goes out for a research lookup');
  // The line names a source the run actually opened and its settled receipt, never the requested list.
  assert.match(fake.commentary[0]!, /chat/, 'the research source is named from its own step');
  assert.match(fake.commentary[0]!, /is done|failed|Still reading/, 'with the status the run reported');
  // Review F2: the OpenAI path never sends the dead-air user turn.
  assert.deepEqual(fake.texts, [], 'no Continue. user message on the Responses-delegation path');
  release();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
});

// O1b-N: the app's playback receipts ride the live socket the call already holds. One closed frame
// shape in, native trace rows out; a malformed frame is refused with a typed receipt, never stored.
test('O1b-N: a forwarded playback receipt records native rows and a refused frame writes none', async t => {
  const h = await harness(t);
  const rejected: Record<string, unknown>[] = [];
  const detachSink = attachHostLogSink({ event: raw => { const record = raw as Record<string, unknown>; if (record['event'] === 'live_trace_rejected') rejected.push(record); } });
  t.after(() => detachSink());
  const { session, attachment } = await attached(h, 'playback-receipts');
  const frame = (receipt: string, seq: number, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'playback_receipt', receipt, segment_seq: 1, source_instance_id: 'inst-b2', source_seq: seq,
      mono_ms: 900 + seq, wall_ms: 1_700_000_000_000 + seq, ...extra });

  attachment.playbackReceipt(frame('received', 1));
  attachment.playbackReceipt(frame('enqueued', 2));
  attachment.playbackReceipt(frame('started', 3));
  attachment.playbackReceipt(frame('drained', 4));
  const events = h.store.transaction(tx => tx.all('SELECT kind, source, source_seq FROM trace_event WHERE live_session_id=? ORDER BY seq', [session.liveSessionId]));
  assert.deepEqual(events.map(row => row['kind']), ['playback.received', 'playback.enqueued', 'playback.started', 'playback.drained']);
  assert.ok(events.every(row => row['source'] === 'native'));
  const row = h.store.transaction(tx => tx.get('SELECT * FROM trace_playback WHERE playback_key=?', [`${session.liveSessionId}:inst-b2:1`]))!;
  assert.equal(row['drained_at'], 1_700_000_000_004, 'the producer wall ms lands in the summary row');
  assert.equal(row['turn_id'], null, 'the host never guesses the turn it does not know');

  const before = h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM trace_event')!['n']));
  attachment.playbackReceipt(frame('drained', 5, { note: 'free text never reaches a column' }));
  attachment.playbackReceipt('{ not json');
  assert.equal(h.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM trace_event')!['n'])), before, 'a refused frame writes nothing');
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, null, 'a refused frame cannot end the call');

  assert.deepEqual(rejected.map(record => record['code']), ['unknown_field', 'not_json'], 'each refusal is a typed host.log receipt');
  attachment.close();
  await attachment.done;
});
test('S5: the orb never reads listening while a call obligation is open, whatever the adapter reports', async t => {
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, beforeTool: () => held });
  const { attachment } = await openPort(h, 'orb-honest');
  fake.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x', limit: 1 } }] });
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'a call in flight is open work, never listening');
  // The adapter's own silence model, and a duplicated end of turn, cannot clear an open obligation.
  fake.emit({ type: 'waitingForInput', value: true });
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'silence does not close an open call');
  fake.emit({ type: 'turnComplete' });
  await settlePort();
  assert.equal(h.owner.current().state, 'thinking', 'a duplicated end of turn does not close an open call');
  release();
  await settlePort();
  fake.emit({ type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 });
  await settlePort();
  assert.equal(h.owner.current().state, 'speaking', 'the answered turn speaks before it idles');
  attachment.close();
  await settlePort();
});

test('S5: a failed backend turn settles typed, says one honest line, and is never rebuilt', async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits });
  const { session } = await openPort(h, 'failed-turn');
  fake.emit({ type: 'turnFailed', code: 'backend_unavailable' });
  await settlePort();
  // The typed disposition is immediate and metadata only.
  assert.deepEqual(receipts.filter(entry => entry['event'] === 'turn_failed'), [{ event: 'turn_failed', code: 'backend_unavailable' }]);
  assert.deepEqual(fake.commentary, [TURN_FAILED_LINE], 'one honest line: lost the thread, asked to repeat, offered the retry');
  assert.equal(fake.sessionsOpened, 1, 'a backend turn failure is never a rebuild');
  // The line never becomes audible here, so the turn is settled failed instead of left owing, and no rebuild follows.
  h.advance(1_000); scheduler.runDue(); await settlePort();
  assert.equal(h.owner.get(session.liveSessionId).lifecycle, 'terminal', 'an unanswered turn failure settles instead of owing forever');
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'failed', code: 'backend_failed' },
    'the terminal disposition is typed, and it names the failure class the receipt details');
  assert.equal(fake.sessionsOpened, 1, 'still no rebuild');
  assert.deepEqual(fake.texts, [], 'no Continue. user turn on the failure path either');
});

// --- O1b-A: every step of a call leaves one receipt ------------------------------------------------

test('O1b-A: a synthetic tool turn writes one turn, ordered utterances, a tool result and no debug directory', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true });
  const session = h.owner.create({ idempotencyKey: 'o1ba-tool-turn', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'inputTranscription', text: 'What is on my plate?', finished: true }));
  await settlePort();
  fake.emit(portEvent({ type: 'toolCall', calls: [{ id: 'call_o1ba', name: 'search_knowledge', args: { query: 'plate', limit: 1 } }] }));
  await settlePort();
  fake.emit(portEvent({ type: 'outputTranscription', text: 'Nothing is on your plate.', finished: true }));
  fake.emit(portEvent(audibleFrame));
  fake.emit(portEvent({ type: 'turnComplete' }));
  await settlePort();

  const turns = h.store.transaction(tx => tx.all('SELECT turn_id, close_reason, outcome FROM trace_turn WHERE live_session_id=?', [session.liveSessionId]));
  assert.equal(turns.length, 1, 'one owner turn, opened at her words and closed on the answer');
  assert.equal(turns[0]!['close_reason'], 'completed');
  assert.equal(turns[0]!['outcome'], 'answered');
  const turnId = String(turns[0]!['turn_id']);
  const utterances = h.store.transaction(tx => tx.all('SELECT role, text FROM trace_utterance WHERE turn_id=? ORDER BY at, rowid', [turnId]));
  assert.deepEqual(utterances.map(row => row['role']), ['owner', 'model'], 'her words, then the answer');
  assert.deepEqual(utterances.map(row => row['text']), ['What is on my plate?', 'Nothing is on your plate.']);
  // O1b-A: the JSONL journal wrote under <dataDir>/debug and nothing writes it any more.
  assert.equal(existsSync(join(h.dir, 'debug')), false, 'a live session creates no debug/ directory');
  attachment.close();
});

// The dead-air stall the watchdog sees is projected onto the open turn (stall_reason no_audible_output) and the
// typed GAP a stalled turn prints are covered by trace.test.ts, which drives the store directly; the watchdog's
// own nudge path is exercised by the D3 tests above.


test('fluency: cached Live metadata cannot bypass suspended or revoked connector authority', async t => {
  for (const revoked of [false, true]) {
    const h = await harness(t, { tools: true, calendar: true });
    await attached(h, `cache-authority-${revoked}`);
    await settleLiveTool(h, 'before', 'gcal_calendars', {});
    assert.equal(h.calls.filter(call => call.name === 'gcal_calendars').length, 1);
    if (revoked) h.toolRegistry!.revoke('calendar'); else h.toolRegistry!.suspend('calendar');
    await settleLiveTool(h, 'after', 'gcal_calendars', {});
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    assert.ok(frame.toolResponse.functionResponses[0]!.response['error'], 'cached success must not outlive canonical authority');
    assert.equal(h.calls.filter(call => call.name === 'gcal_calendars').length, 1, 'denied cache does not dispatch');
  }
});


test('fluency: demand recovery belongs to new owner input and not repeated model tools', async t => {
  let demands = 0;
  const h = await harness(t, { tools: true, calendar: true, recover: async () => { demands++; } });
  await attached(h, 'distinct-recovery-demand');
  h.f.send({ serverContent: { inputTranscription: { text: 'Synthetic request', finished: true } } });
  await settleLiveTool(h, 'first', 'gcal_calendars', {});
  await settleLiveTool(h, 'model-retry', 'gcal_calendars', {});
  assert.equal(demands, 1);
  h.f.send({ serverContent: { inputTranscription: { text: 'A distinct synthetic request', finished: true } } });
  await settleLiveTool(h, 'new-request', 'gcal_calendars', {});
  assert.equal(demands, 2);
});


test('fluency R2: cached metadata is denied after revocation during sibling work or its final authorization microtask', async t => {
  for (const boundary of ['revoke', 'suspend', 'final-microtask'] as const) {
    const started = deferred<void>(), finish = deferred<void>();
    const h = await harness(t, { tools: true, calendar: true, beforeTool: async () => { started.resolve(); await finish.promise; } });
    const { session } = await attached(h, `cache-delivery-${boundary}`);
    await settleLiveTool(h, 'prime-calendar', 'gcal_calendars', {});
    await settleLiveTool(h, 'prime-calendar-small', 'gcal_calendars', { maxResults: 1 });
    if (boundary === 'final-microtask') {
      const gate = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
      t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof gate>) => {
        const outcome = await gate(...args);
        if (outcome.state === 'allowed' && args[1].some(binding => binding.name === 'search_knowledge')) queueMicrotask(() => h.toolRegistry!.revoke('calendar'));
        return outcome;
      });
    }
    const before = toolResponseCount(h);
    h.f.send({ toolCall: { functionCalls: [
      { id: 'cached-calendar', name: 'gcal_calendars', args: {} },
      { id: 'cached-calendar-small', name: 'gcal_calendars', args: { maxResults: 1 } },
      { id: 'slow', name: 'search_knowledge', args: { query: 'synthetic', limit: 1 } },
    ] } });
    await started.promise;
    if (boundary === 'revoke') h.toolRegistry!.revoke('calendar');
    if (boundary === 'suspend') h.toolRegistry!.suspend('calendar');
    finish.resolve();
    for (let i = 0; i < 2000 && toolResponseCount(h) === before; i++) await tick();
    assert.equal(toolResponseCount(h), before + 1);
    const frame = h.f.frames.filter(value => typeof value === 'object' && value !== null && 'toolResponse' in value).at(-1) as { toolResponse: { functionResponses: { id: string; response: Record<string, unknown> }[] } };
    const cached = frame.toolResponse.functionResponses.find(response => response.id === 'cached-calendar')!.response;
    assert.equal(h.toolRegistry!.currentGrant('calendar'), undefined, boundary);
    assert.ok(cached['error'], boundary);
    assert.equal(cached['text'], undefined, 'no metadata body reaches provider');
    const projections = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 100 }).fragments.filter(fragment => fragment.kind === 'toolResult');
    assert.equal(projections.at(-3)?.tool?.status, 'error', 'local receipt must deny too');
    assert.equal(h.calls.filter(call => call.name === 'gcal_calendars').length, 2, 'neither completed calendar read replays');
    const rows = h.store.transaction(tx => tx.all("SELECT state FROM tool_calls WHERE run_id=? AND json_extract(intent_json,'$.toolName')='gcal_calendars'", [session.liveSessionId]));
    assert.deepEqual(rows.map(row => row.state), ['completed', 'completed'], 'original completed journal is unchanged');
  }
});

test('calendar integration: actual Google projector and Live ledger deliver every page and local remainder with original authority', async t => {
  const events = Array.from({ length: 15 }, (_, n) => ({ id: `calendar-event-${n}`, start: `2023-11-${String(14 + Math.floor(n / 5)).padStart(2, '0')}T10:00:00Z`, summary: `Synthetic event ${n}`, description: n === 0 ? 'Long description. '.repeat(40) : '' }));
  for (const revoked of [false, true]) {
    const h = await harness(t, { tools: true, calendar: true, calendarData: (name, args) => name === 'gcal_calendars'
      ? { calendars: [{ id: 'primary', summary: 'Main' }], nextPageToken: 'more-calendars' }
      : args['pageToken'] ? { events: events.slice(12) } : { events: events.slice(0, 12), nextPageToken: 'next-events' } });
    await attached(h, `calendar-complete-${revoked}`);
    await settleLiveTool(h, 'calendar-start', 'research', { action: 'start', question: 'Synthetic calendar this week', lookups: [{ source: 'calendar', query: 'this week' }] });
    const last = (): Record<string, unknown> => {
      const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
      return frame.toolResponse.functionResponses[0]!.response;
    };
    const reply = last();
    assert.equal(reply['canContinue'], true);
    const coverage = reply['calendarCoverage'] as Record<string, unknown>;
    assert.equal(coverage['received'], 15); assert.equal(coverage['shown'], 8); assert.equal(coverage['localRemaining'], 7);
    assert.equal(coverage['bodyTruncated'], true); assert.equal(coverage['calendarListComplete'], false);
    const calls = h.calls.filter(call => call.name === 'gcal_list');
    assert.equal(calls.length, 2);
    const first = calls[0]!.args as Record<string, unknown>, second = calls[1]!.args as Record<string, unknown>;
    assert.equal(first['calendarId'], 'primary'); assert.equal(first['timeMin'], '2023-11-12T18:30:00.000Z');
    assert.equal(second['timeMin'], first['timeMin']); assert.equal(second['timeMax'], first['timeMax']);
    assert.equal(second['pageToken'], 'next-events');
    assert.doesNotMatch(JSON.stringify(reply), /next-events|more-calendars/, 'opaque page tokens stay inside the host ledger');
    if (revoked) h.toolRegistry!.revoke('calendar');
    await settleLiveTool(h, 'calendar-continue', 'research', { action: 'continue', researchId: reply['researchId'] });
    if (revoked) { assert.deepEqual(last()['findings'], []); assert.equal(last()['canContinue'], false); }
    else { assert.match(JSON.stringify(last()['findings']), /Synthetic event 14/); assert.equal(last()['canContinue'], false); }
    assert.equal(h.calls.filter(call => call.name === 'gcal_list').length, 2, 'neither retained delivery nor denial rereads completed pages');
  }
});

test('calendar integration: revocation during a sibling await or final microtask denies retained results at publication', async t => {
  for (const boundary of ['sibling', 'final-microtask'] as const) {
    const started = deferred<void>(), finish = deferred<void>(), calendarAccepted = deferred<void>();
    const h = await harness(t, { tools: true, calendar: true, knowledgeSearchLimit: 6, beforeTool: async () => { started.resolve(); await finish.promise; }, calendarData: name => name === 'gcal_calendars' ? { calendars: [{ id: 'primary' }] } : { events: [{ id: 'exact-retained', start: '2023-11-15T10:00:00Z', summary: 'Calendar publication must be gated' }] } });
    await attached(h, `calendar-delivery-race-${boundary}`);
    const authorize = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
    t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => {
      const result = await authorize(...args);
      if (args[1].some(binding => binding.name === 'gcal_list')) calendarAccepted.resolve();
      if (boundary === 'final-microtask' && args[1].some(binding => binding.name === 'search_knowledge')) queueMicrotask(() => h.toolRegistry!.revoke('calendar'));
      return result;
    });
    const response = settleLiveTool(h, 'calendar-race', 'research', { action: 'start', question: 'Synthetic calendar and knowledge', lookups: [{ source: 'calendar', query: 'this week' }, { source: 'knowledge', query: 'synthetic' }] });
    let entered = false, collected = false;
    void started.promise.then(() => { entered = true; }); void calendarAccepted.promise.then(() => { collected = true; });
    t.after(() => finish.resolve());
    for (let n = 0; n < 1000 && !(entered && collected); n++) await tick();
    assert.ok(entered && collected, `calendar and sibling reached their real gates: ${JSON.stringify(h.calls.map(call => call.name))}`);
    if (boundary === 'sibling') h.toolRegistry!.revoke('calendar');
    finish.resolve();
    await response;
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    assert.equal(frame.toolResponse.functionResponses[0]!.response['error'], 'tool_result_denied');
    assert.doesNotMatch(JSON.stringify(frame), /Calendar publication must be gated/);
    assert.equal(h.calls.filter(call => call.name === 'gcal_list').length, 1);
  }
});

test('Mongoose current contract: approved company research reaches the actual SDK through Live source discovery', async t => {
  const h = await harness(t, { tools: true, mongoose: true });
  await attached(h, 'mongoose-configured-research');
  await settleLiveTool(h, 'company-start', 'research', { action: 'start', question: 'Synthetic company evidence', lookups: [{ source: 'company', query: 'synthetic' }] });
  assert.equal(h.calls.filter(call => call.name === 'search_mongoose').length, 1, 'an approved company source must be dispatched');
  const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
  assert.equal((frame.toolResponse.functionResponses[0]!.response['sources'] as Record<string, unknown>)['company'], 'ok');
  assert.match(JSON.stringify(frame), /Synthetic company evidence/);
});

test('history integration: Live canonical research reads exact sixty-day evidence and stable bounded continuation', async t => {
  const h = await harness(t, { tools: true, history: true, routeClasses: ['ordinary', 'private', 'sensitive'] });
  const text = 'Mira decided violet flags. ' + 'Retained synthetic detail. '.repeat(550) + 'Exact final decision.';
  h.store.transaction(tx => {
    memory.createSession(tx, { title: 'Synthetic sixty-day discussion', startedAt: NOW - 60 * 86400000, timeZone: 'UTC' }, { now: () => NOW }, 'history-source');
    memory.appendEntry(tx, { sessionId: 'history-source', text, capturedAt: NOW - 60 * 86400000, timeZone: 'UTC' }, { now: () => NOW }, 'history-entry');
    for (const subject of [{ kind: 'session' as const, id: 'history-source' }, { kind: 'entry' as const, id: 'history-entry' }]) labels.correct(tx, { subject, expectedRevision: 0, dataClass: 'sensitive' }, NOW);
  });
  await attached(h, 'history-research');
  const reply = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'history-search', 'research', { action: 'start', question: 'What did Mira decide?', lookups: [{ source: 'memory', history: { query: 'Mira', limit: 1 } }, { source: 'knowledge', query: 'synthetic' }] });
  const search = reply(), pages = search['historyPages'] as Record<string, unknown>[];
  assert.ok(pages, JSON.stringify(search)); assert.equal(pages.length, 1);
  const hits = pages[0]!['hits'] as Record<string, unknown>[];
  assert.equal(hits[0]!['dataClass'], 'sensitive'); assert.match(String(hits[0]!['snippet']), /violet flags/);
  assert.equal(hits[0]!['date'], new Date(NOW - 60 * 86400000).toISOString());
  const researchId = String(search['researchId']);
  await settleLiveTool(h, 'history-detail', 'research', { action: 'continue', researchId, lookups: [{ source: 'memory', history: { recordRef: hits[0]!['recordRef'] } }] });
  let page = (reply()['historyPages'] as Record<string, unknown>[])[0]!;
  let full = String(page['text']); const firstCursor = page['nextCursor'];
  assert.equal(full.length, 6000); assert.equal(page['complete'], false);
  await settleLiveTool(h, 'history-next', 'research', { action: 'continue', researchId, lookups: [{ source: 'memory', history: { cursor: firstCursor } }] });
  const second = (reply()['historyPages'] as Record<string, unknown>[])[0]!;
  await settleLiveTool(h, 'history-repeat', 'research', { action: 'continue', researchId, lookups: [{ source: 'memory', history: { cursor: firstCursor } }] });
  assert.equal((reply()['historyPages'] as Record<string, unknown>[])[0]!['text'], second['text']);
  page = second; full += page['text'];
  while (page['nextCursor']) {
    await settleLiveTool(h, `history-offset-${full.length}`, 'research', { action: 'continue', researchId, lookups: [{ source: 'memory', history: { cursor: page['nextCursor'] } }] });
    page = (reply()['historyPages'] as Record<string, unknown>[])[0]!; full += page['text'];
  }
  assert.equal(full, text);
  const rows = h.store.transaction(tx => tx.all("SELECT result_json FROM tool_calls WHERE json_extract(intent_json,'$.toolName')='conversation_history'"));
  assert.ok(rows.length >= 5); assert.ok(rows.every(row => !String(row['result_json']).includes('fingerprint')));
  await settleLiveTool(h, 'history-stop', 'research', { action: 'stop', researchId });
  await settleLiveTool(h, 'history-stopped-read', 'research', { action: 'continue', researchId, lookups: [{ source: 'memory', history: { recordRef: hits[0]!['recordRef'] } }] });
  assert.doesNotMatch(JSON.stringify(reply()), /violet flags|Retained synthetic detail/);
});

test('history integration: parallel sibling await cannot publish deleted or relabeled local evidence', async t => {
  for (const mutation of ['none', 'delete', 'relabel'] as const) {
    const started = deferred<void>(), release = deferred<void>(), collected = deferred<void>();
    const h = await harness(t, { tools: true, history: true, knowledgeSearchLimit: 6, beforeTool: async () => { started.resolve(); await release.promise; } });
    h.store.transaction(tx => {
      memory.createSession(tx, { title: 'Synthetic', startedAt: NOW, timeZone: 'UTC' }, { now: () => NOW }, 'history-parent');
      memory.appendEntry(tx, { sessionId: 'history-parent', text: 'Mira private decision', capturedAt: NOW, timeZone: 'UTC' }, { now: () => NOW }, 'history-race');
      for (const subject of [{ kind: 'session' as const, id: 'history-parent' }, { kind: 'entry' as const, id: 'history-race' }]) labels.correct(tx, { subject, expectedRevision: 0, dataClass: 'ordinary' }, NOW);
    });
    await attached(h, `history-race-${mutation}`);
    const authorize = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
    t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => {
      const result = await authorize(...args); if (args[1].some(binding => binding.name === 'conversation_history')) collected.resolve(); return result;
    });
    const running = settleLiveTool(h, 'history-race-call', 'research', { action: 'start', question: 'Mira and project', lookups: [{ source: 'memory', query: 'Mira' }, { source: 'knowledge', query: 'synthetic' }] });
    let local = false, remote = false; void collected.promise.then(() => { local = true; }); void started.promise.then(() => { remote = true; });
    t.after(() => release.resolve());
    for (let n = 0; n < 1000 && !(local && remote); n++) await tick();
    assert.ok(local && remote, JSON.stringify({ local, remote, calls: h.calls.map(call => call.name), states: h.store.transaction(tx => tx.all('SELECT state FROM tool_calls')) }));
    if (mutation === 'delete') h.store.transaction(tx => memory.deleteEntry(tx, 'history-race', new Date(NOW).toISOString(), 'synthetic'));
    if (mutation === 'relabel') h.store.transaction(tx => labels.correct(tx, { subject: { kind: 'session', id: 'history-parent' }, expectedRevision: 1, dataClass: 'sensitive' }, NOW));
    release.resolve(); await running;
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1);
    if (mutation === 'none') assert.match(JSON.stringify(frame), /Mira private decision/);
    else assert.doesNotMatch(JSON.stringify(frame), /Mira private decision/);
  }

});

test('Mongoose evidence projection: grouped SDK hits survive actual Live research adaptation', async t => {
  const h = await harness(t, { tools: true, mongoose: true, mongooseData: { hits: { company: [], offering: [], knowledge: [{ id: 'kb-17', title: 'Synthetic grouped evidence', snippet: 'Synthetic launch delayed to Monday.', status: 'active' }], ticket: [] }, has_more: false, total: 1 } });
  await attached(h, 'mongoose-grouped-research');
  await settleLiveTool(h, 'grouped-start', 'research', { action: 'start', question: 'Synthetic company evidence', lookups: [{ source: 'company', query: 'synthetic' }] });
  const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
  assert.equal((frame.toolResponse.functionResponses[0]!.response['sources'] as Record<string, unknown>)['company'], 'ok');
  assert.match(JSON.stringify(frame), /kb-17/); assert.match(JSON.stringify(frame), /Synthetic launch delayed to Monday/);

});


test('mail integration: exact native query pages and retained remainder reach later messages without replay', async t => {
  const messages = Array.from({ length: 13 }, (_, n) => ({ id: `mail-id-${n}`, threadId: 'shared-thread', internalDate: String(1700000000000 - n), headers: [{ name: 'Subject', value: `Synthetic mail ${n}` }], snippet: `Snippet ${n}` }));
  const h = await harness(t, { tools: true, mail: true, mailData: (_name, args) => args['pageToken'] ? { messages: messages.slice(8) } : { messages: messages.slice(0, 8), nextPageToken: 'private-native-mail-next' } });
  await attached(h, 'mail-all-pages');
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'mail-start', 'research', { action: 'start', question: 'List synthetic mail', lookups: [{ source: 'mail', mail: { q: 'from:sender@example.invalid subject:"precise phrase"', maxResults: 8 } }] });
  const first = last(); assert.equal(first['error'], undefined); assert.equal(first['canContinue'], true);
  const coverage = first['mailCoverage'] as Record<string, unknown>; assert(coverage); assert.equal(coverage['received'], 13); assert.equal(coverage['shown'], 8); assert.equal(coverage['localRemaining'], 5);
  assert.doesNotMatch(JSON.stringify(first), /private-native-mail-next/);
  const sourceCalls = h.calls.filter(call => call.name === 'gmail_list'); assert.equal(sourceCalls.length, 2);
  assert.equal((sourceCalls[0]!.args as Record<string, unknown>)['q'], 'from:sender@example.invalid subject:"precise phrase"');
  assert.equal((sourceCalls[1]!.args as Record<string, unknown>)['pageToken'], 'private-native-mail-next');
  assert.equal((sourceCalls[1]!.args as Record<string, unknown>)['maxResults'], 8);
  await settleLiveTool(h, 'mail-next', 'research', { action: 'continue', researchId: first['researchId'], cursor: first['nextCursor'] });
  assert.match(JSON.stringify(last()['findings']), /Synthetic mail 12/); assert.equal(last()['canContinue'], false);
  assert.equal(h.calls.filter(call => call.name === 'gmail_list').length, 2);
});


test('mail integration: delivered consumer cursors are idempotent and Stop invalidates retained pages', async t => {
  for (const stop of [false, true]) {
    const messages = Array.from({ length: 13 }, (_, n) => ({ id: `cursor-message-${n}`, headers: [{ name: 'Subject', value: `Cursor evidence ${n}` }] }));
    const h = await harness(t, { tools: true, mail: true, mailData: () => ({ messages }) }); await attached(h, `mail-cursor-${stop}`);
    const last = (): Record<string, unknown> => {
      const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
      return frame.toolResponse.functionResponses[0]!.response;
    };
    await settleLiveTool(h, 'start', 'research', { action: 'start', question: 'List synthetic mail', lookups: [{ source: 'mail', mail: { q: 'subject:cursor', maxResults: 13 } }] });
    const first = last(), researchId = first['researchId'], cursor = first['nextCursor']; assert.equal(typeof cursor, 'string');
    await settleLiveTool(h, 'bad-cursor', 'research', { action: 'continue', researchId, cursor: 'not-this-run-cursor' });
    assert.equal(last()['error'], 'continuation_unavailable');
    if (stop) await settleLiveTool(h, 'stop', 'research', { action: 'stop', researchId });
    await settleLiveTool(h, 'next', 'research', { action: 'continue', researchId, cursor });
    if (stop) { assert.deepEqual(last()['findings'], []); assert.equal(last()['canContinue'], false); }
    else {
      assert.match(JSON.stringify(last()['findings']), /Cursor evidence 12/);
      await settleLiveTool(h, 'repeat', 'research', { action: 'continue', researchId, cursor });
      assert.equal(last()['alreadyDelivered'], true); assert.deepEqual(last()['findings'], []); assert.equal(last()['canContinue'], false);
      assert.deepEqual(last()['deliveredMessageIds'], messages.slice(8).map(message => message.id));
    }
    assert.equal(h.calls.filter(call => call.name === 'gmail_list').length, 1, 'no source replay for retained, denied or repeated consumer pages');
  }
});

test('mail integration: a failed dispatched native page is terminal and truthful', async t => {
  const messages = Array.from({ length: 8 }, (_, n) => ({ id: `failure-message-${n}`, headers: [{ name: 'Subject', value: `Received before failure ${n}` }] }));
  const h = await harness(t, { tools: true, mail: true, mailData: (_name, args) => {
    if (args['pageToken']) throw Error('synthetic_source_unavailable');
    return { messages, nextPageToken: 'failed-native-page' };
  } }); await attached(h, 'mail-failed-page');
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'start', 'research', { action: 'start', question: 'List synthetic mail', lookups: [{ source: 'mail', query: 'synthetic' }] });
  const reply = last(); assert.equal(reply['status'], 'partial'); assert.equal(reply['canContinue'], false);
  assert.equal((reply['mailCoverage'] as Record<string, unknown>)['failed'], true); assert.match(JSON.stringify(reply['findings']), /Received before failure 7/);
  await settleLiveTool(h, 'continue', 'research', { action: 'continue', researchId: reply['researchId'] });
  assert.equal(h.calls.filter(call => call.name === 'gmail_list').length, 2, 'the failed native page is not replayed');
});


test('mail integration: actual selector parsing shares the native page collector', async t => {
  const messages = Array.from({ length: 13 }, (_, n) => ({ id: `selector-mail-${n}`, headers: [{ name: 'Subject', value: `Selector mail ${n}` }] }));
  const h = await harness(t, { tools: true, mail: true, knowledgeSearchLimit: 6,
    research: { async select(input) { return parseSelector(JSON.stringify({ questionClass: 'cross_source', actions: input.completed.some(entry => entry.kind === 'mail_search') ? [] : [{ kind: 'mail_search', query: 'from:selector@example.invalid' }], pUseful: { mail_search: 0.99 } })); } },
    mailData: (_name, args) => args['pageToken'] ? { messages: messages.slice(8) } : { messages: messages.slice(0, 8), nextPageToken: 'selector-native-next' },
  }); await attached(h, 'mail-selector');
  try { await settleLiveTool(h, 'selector-start', 'research', { action: 'start', question: 'List synthetic mail' }); }
  catch (error) { throw new Error(`Selector source calls: ${JSON.stringify(h.calls)}; ${String(error)}`); }
  const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
  const reply = frame.toolResponse.functionResponses[0]!.response;
  const calls = h.calls.filter(call => call.name === 'gmail_list'); assert.equal(calls.length, 2);
  assert.equal((calls[0]!.args as Record<string, unknown>)['q'], 'from:selector@example.invalid');
  assert.equal((calls[1]!.args as Record<string, unknown>)['pageToken'], 'selector-native-next');
  assert.equal((reply['mailCoverage'] as Record<string, unknown>)['received'], 13); assert.equal(reply['canContinue'], true);
});

test('mail integration: revocation during a sibling await or final microtask denies original retained bindings', async t => {
  for (const boundary of ['sibling', 'final-microtask'] as const) {
    const started = deferred<void>(), finish = deferred<void>(), mailAccepted = deferred<void>();
    const h = await harness(t, { tools: true, mail: true, knowledgeSearchLimit: 6, beforeTool: async () => { started.resolve(); await finish.promise; }, mailData: () => ({ messages: [{ id: 'guarded-mail', headers: [{ name: 'Subject', value: 'Mail publication must be gated' }] }] }) });
    await attached(h, `mail-race-${boundary}`);
    const authorize = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
    t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => {
      const result = await authorize(...args);
      if (args[1].some(binding => binding.name === 'gmail_list')) mailAccepted.resolve();
      if (boundary === 'final-microtask' && args[1].some(binding => binding.name === 'search_knowledge')) queueMicrotask(() => h.toolRegistry!.revoke('mail'));
      return result;
    });
    const pending = settleLiveTool(h, 'mail-race', 'research', { action: 'start', question: 'Synthetic mail and notes', lookups: [{ source: 'mail', query: 'synthetic' }, { source: 'knowledge', query: 'synthetic' }] });
    let entered = false, collected = false; void started.promise.then(() => { entered = true; }); void mailAccepted.promise.then(() => { collected = true; });
    t.after(() => finish.resolve());
    for (let n = 0; n < 2000 && !(entered && collected); n++) await tick();
    assert(entered && collected, 'both actual source gates must be reached');
    if (boundary === 'sibling') h.toolRegistry!.revoke('mail'); finish.resolve(); await pending;
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    assert.equal(frame.toolResponse.functionResponses[0]!.response['error'], 'tool_result_denied'); assert.doesNotMatch(JSON.stringify(frame), /Mail publication must be gated/);
    assert.equal(h.calls.filter(call => call.name === 'gmail_list').length, 1);
  }
});


test('mail integration: an unused cursor keeps its original message coordinates after another continuation', async t => {
  const messages = Array.from({ length: 21 }, (_, n) => ({ id: `immutable-mail-${n}`, headers: [{ name: 'Subject', value: `Immutable evidence ${n}` }] }));
  const h = await harness(t, { tools: true, mail: true, mailData: () => ({ messages }) }); await attached(h, 'immutable-mail-cursor');
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'start', 'research', { action: 'start', question: 'List synthetic mail', lookups: [{ source: 'mail', mail: { q: 'subject:immutable', maxResults: 21 } }] });
  const first = last(), researchId = first['researchId'], cursor = first['nextCursor'];
  await settleLiveTool(h, 'advance-without-cursor', 'research', { action: 'continue', researchId }); const nextCursor = last()['nextCursor'];
  assert.deepEqual((last()['mailMessages'] as { id: string }[]).map(message => message.id), messages.slice(8, 16).map(message => message.id));
  await settleLiveTool(h, 'original-cursor', 'research', { action: 'continue', researchId, cursor });
  assert.equal(last()['alreadyDelivered'], true, 'an old cursor must not retarget the latest remainder');
  assert.deepEqual(last()['deliveredMessageIds'], messages.slice(8, 16).map(message => message.id)); assert.equal(last()['nextCursor'], nextCursor); assert.deepEqual(last()['findings'], []);
  await settleLiveTool(h, 'final-cursor', 'research', { action: 'continue', researchId, cursor: nextCursor });
  assert.deepEqual((last()['mailMessages'] as { id: string }[]).map(message => message.id), messages.slice(16).map(message => message.id));
  assert.equal(last()['canContinue'], false); assert.equal(h.calls.filter(call => call.name === 'gmail_list').length, 1);
});


test('mail body integration: full received text continues locally once with exact UTF16 coordinates', async t => {
  const body = `Latest evidence.\nOn Monday, Synthetic Sender wrote:\n> ${'🍃'.repeat(11000)}\nFinal retained evidence.`;
  const h = await harness(t, { tools: true, mail: true, mailData: (_name, args) => ({ id: args['id'], format: args['format'], headers: { Subject: 'Synthetic full received body' }, body: args['format'] === 'metadata' ? null : body, bodyCoverage: { complete: true } }) });
  const { session } = await attached(h, 'mail-full-received-body');
  let received = '';
  const authorize = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
  t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => {
    const result = await authorize(...args);
    const binding = args[1].find(binding => binding.name === 'gmail_read');
    if (binding && result.state === 'allowed') {
      const consumed = h.toolOwner!.consumeEvidence(args[0], binding, h.owner.lookupAuthority(session.liveSessionId), args[3]);
      if (consumed.state === 'allowed' && consumed.evidence.kind === 'remote-body') received = consumed.evidence.body;
    }
    return result;
  });
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'body-start', 'research', { action: 'start', question: 'Read the full synthetic message', lookups: [{ source: 'mail', mail: { id: 'full-message' } }] });
  assert(received.length > 22000, 'actual canonical producer must retain the acquired source text'); assert.match(received, /On Monday/);
  const calls = h.calls.filter(call => call.name === 'gmail_read'); assert.equal(calls.length, 1); assert.equal((calls[0]!.args as Record<string, unknown>)['format'], 'full');
  const researchId = last()['researchId']; let joined = '', count = 0, next = last()['nextCursor'];
  for (;;) {
    const slices = last()['bodySlices'] as { text: string; offset: number; end: number; total: number; unit: string; source: string }[];
    assert(Array.isArray(slices) && slices.length > 0, 'the full acquired body must have an authorized local consumer');
    for (const slice of slices) {
      assert.equal(slice.unit, 'utf16'); assert.equal(slice.source, 'mail'); assert.equal(slice.offset, joined.length); assert.equal(slice.end - slice.offset, slice.text.length); assert.equal(slice.total, received.length);
      assert(!/[\uDC00-\uDFFF]/u.test(slice.text.slice(0, 1)), 'slice must not begin inside a surrogate pair'); assert(!/[\uD800-\uDBFF]/u.test(slice.text.slice(-1)), 'slice must not end inside a surrogate pair'); joined += slice.text;
    }
    assert.doesNotMatch(JSON.stringify(last()), /bodySha256|entitySha256|hostEvidenceRequired/);
    if (!last()['canContinue']) break;
    assert.equal(typeof next, 'string'); assert(++count < 30, 'continuation must make bounded progress');
    await settleLiveTool(h, `body-next-${count}`, 'research', { action: 'continue', researchId, cursor: next }); next = last()['nextCursor'];
  }
  assert.equal(joined, received); assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 1, 'local body remainder must not re-fetch the message');
});

test('mail body integration: completed research Stop releases the canonical host evidence', async t => {
  const h = await harness(t, { tools: true, mail: true, mailData: (_name, args) => ({ id: args['id'], format: args['format'], headers: { Subject: 'Synthetic stop evidence' }, body: 'retained body '.repeat(1800), bodyCoverage: { complete: true } }) });
  const { session } = await attached(h, 'mail-stop-releases-body');
  const original = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
  let captured: Parameters<typeof original> | undefined;
  t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof original>) => { const result = await original(...args); if (args[1].some(binding => binding.name === 'gmail_read') && result.state === 'allowed') captured = args; return result; });
  await settleLiveTool(h, 'body-start', 'research', { action: 'start', question: 'Read the full synthetic message', lookups: [{ source: 'mail', mail: { id: 'stop-message' } }] });
  const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
  const researchId = frame.toolResponse.functionResponses[0]!.response['researchId']; assert(captured);
  const binding = captured[1].find(binding => binding.name === 'gmail_read')!;
  assert.equal(h.toolOwner!.consumeEvidence(captured[0], binding, h.owner.lookupAuthority(session.liveSessionId), new AbortController().signal).state, 'allowed');
  await settleLiveTool(h, 'body-stop', 'research', { action: 'stop', researchId });
  assert.equal(h.toolOwner!.consumeEvidence(captured[0], binding, h.owner.lookupAuthority(session.liveSessionId), new AbortController().signal).state, 'refused', 'Stop must release the actual original source ref, not just a private ledger flag');
  assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 1);
});

test('mail body integration: immutable receipt, metadata opt-out and new-start cleanup use the real owner', async t => {
  const h = await harness(t, { tools: true, mail: true, mailData: (_name, args) => ({ id: args['id'], headers: { Subject: 'Body identity' }, body: args['format'] === 'metadata' ? null : 'Sentence evidence. '.repeat(1600), bodyCoverage: { complete: true } }) });
  const { session } = await attached(h, 'mail-body-lifecycle');
  const original = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate); let captured: Parameters<typeof original> | undefined;
  t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof original>) => { const result = await original(...args); if (args[1].some(binding => binding.name === 'gmail_read') && result.state === 'allowed') captured = args; return result; });
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'first-body', 'research', { action: 'start', question: 'Read full mail', lookups: [{ source: 'mail', mail: { id: 'identity' } }] });
  const researchId = last()['researchId'], cursor = last()['nextCursor']; assert(captured); const held = captured;
  await settleLiveTool(h, 'next-body', 'research', { action: 'continue', researchId, cursor }); const nextCursor = last()['nextCursor'];
  await settleLiveTool(h, 'replay-body', 'research', { action: 'continue', researchId, cursor });
  assert.equal(last()['alreadyDelivered'], true); assert.equal(last()['nextCursor'], nextCursor); assert.equal(last()['bodySlices'], undefined); assert.deepEqual(last()['findings'], []);
  await settleLiveTool(h, 'metadata-only', 'research', { action: 'start', question: 'Read metadata', lookups: [{ source: 'mail', mail: { id: 'identity', format: 'metadata' } }] });
  assert.equal(last()['bodySlices'], undefined); assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 2);
  assert.equal((h.calls.filter(call => call.name === 'gmail_read')[1]!.args as Record<string, unknown>)['format'], 'metadata');
  assert.equal(h.toolOwner!.consumeEvidence(held[0], held[1].find(binding => binding.name === 'gmail_read')!, h.owner.lookupAuthority(session.liveSessionId), new AbortController().signal).state, 'refused');
  await settleLiveTool(h, 'old-body-cursor', 'research', { action: 'continue', researchId, cursor: nextCursor }); assert.equal(last()['error'], 'continuation_unavailable');
});

test('mail body integration: revocation during sibling await and final microtask blocks every body slice', async t => {
  for (const boundary of ['sibling', 'final-microtask'] as const) {
    const started = deferred<void>(), finish = deferred<void>(), mailAccepted = deferred<void>();
    const h = await harness(t, { tools: true, mail: true, knowledgeSearchLimit: 6, beforeTool: async () => { started.resolve(); await finish.promise; }, mailData: (_name, args) => ({ id: args['id'], headers: { Subject: 'Never publish revoked full body' }, body: 'Revoked body evidence. '.repeat(1400), bodyCoverage: { complete: true } }) });
    await attached(h, `body-race-${boundary}`);
    const authorize = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
    t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof authorize>) => {
      const result = await authorize(...args); if (args[1].some(binding => binding.name === 'gmail_read')) mailAccepted.resolve();
      if (boundary === 'final-microtask' && args[1].some(binding => binding.name === 'search_knowledge')) queueMicrotask(() => h.toolRegistry!.revoke('mail'));
      return result;
    });
    const pending = settleLiveTool(h, 'body-race', 'research', { action: 'start', question: 'Read mail and notes', lookups: [{ source: 'mail', mail: { id: 'revoked-body' } }, { source: 'knowledge', query: 'synthetic' }] });
    let entered = false, collected = false; void started.promise.then(() => { entered = true; }); void mailAccepted.promise.then(() => { collected = true; }); t.after(() => finish.resolve());
    for (let n = 0; n < 2000 && !(entered && collected); n++) await tick(); assert(entered && collected);
    if (boundary === 'sibling') h.toolRegistry!.revoke('mail'); finish.resolve(); await pending;
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    assert.equal(frame.toolResponse.functionResponses[0]!.response['error'], 'tool_result_denied'); assert.doesNotMatch(JSON.stringify(frame), /Revoked body evidence/); assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 1);
  }
});

test('mail body integration: a source completion after research Stop cannot resurrect canonical evidence', async t => {
  const entered = deferred<void>(), release = deferred<void>(); const scheduler = new DeadlineClock();
  const h = await harness(t, { tools: true, mail: true, calendar: true, calendarData: name => name === 'gcal_calendars' ? { calendars: [{ id: 'primary' }] } : { events: [{ id: 'ready-calendar', start: '2023-11-15T10:00:00Z', summary: 'Synthetic ready calendar event' }] }, scheduler, limits: { idleMs: 60000, sessionMs: 600000 }, mailData: async (_name, args) => { entered.resolve(); await release.promise; return { id: args['id'], headers: { Subject: 'Late stopped body' }, body: 'Never retain stopped evidence. '.repeat(1000), bodyCoverage: { complete: true } }; } });
  const { session } = await attached(h, 'body-stop-pending'); t.after(() => release.resolve());
  const original = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate); let captured: Parameters<typeof original> | undefined; let siblingReady = false;
  t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof original>) => { const result = await original(...args); if (args[1].some(binding => binding.name === 'gcal_list') && result.state === 'allowed') siblingReady = true; if (args[1].some(binding => binding.name === 'gmail_read') && result.state === 'allowed') captured = args; return result; });
  h.f.send({ toolCall: { functionCalls: [{ id: 'pending-body-start', name: 'research', args: { action: 'start', question: 'Read full synthetic mail', lookups: [{ source: 'calendar', query: 'this week' }, { source: 'mail', mail: { id: 'late-stopped' } }] } }] } });
  let dispatched = false; void entered.promise.then(() => { dispatched = true; }); for (let n = 0; n < 2000 && !dispatched; n++) await tick(); assert(dispatched);
  const progress = h.owner.listFragments({ liveSessionId: session.liveSessionId, limit: 500 }).fragments.find(fragment => fragment.kind === 'researchProgress'); assert(progress?.text);
  const researchId = (JSON.parse(progress.text) as { researchId: string }).researchId;
  for (let n = 0; n < 2000 && !siblingReady; n++) await tick(); assert(siblingReady); for (let n = 0; n < 50; n++) await tick(); h.advance(4_500); scheduler.runDue();
  for (let n = 0; n < 2000 && toolResponseCount(h) === 0; n++) await tick(); assert.equal(toolResponseCount(h), 1, 'ready calendar releases a first answer while mail remains pending');
  h.f.send({ toolCall: { functionCalls: [{ id: 'pending-body-stop', name: 'research', args: { action: 'stop', researchId } }] } });
  const replies = () => h.f.frames.flatMap(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame ? (frame as { toolResponse: { functionResponses: { id: string; response: Record<string, unknown> }[] } }).toolResponse.functionResponses : []);
  for (let n = 0; n < 2000 && !replies().some(reply => reply.id === 'pending-body-stop'); n++) await tick(); assert(replies().some(reply => reply.id === 'pending-body-stop'));
  release.resolve(); for (let n = 0; n < 2000 && (!captured || !replies().some(reply => reply.id === 'pending-body-start')); n++) await tick(); assert(captured); assert(replies().some(reply => reply.id === 'pending-body-start'));
  const binding = captured[1].find(binding => binding.name === 'gmail_read')!;
  assert.equal(h.toolOwner!.consumeEvidence(captured[0], binding, h.owner.lookupAuthority(session.liveSessionId), new AbortController().signal).state, 'refused');
  assert.doesNotMatch(JSON.stringify(replies()), /Never retain stopped evidence/); assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 1);
});

test('mail body integration: actual source expiry denies local continuation without another remote read', async t => {
  const h = await harness(t, { tools: true, mail: true, mailData: (_name, args) => ({ id: args['id'], headers: { Subject: 'Expired full body' }, body: 'Expiring received evidence. '.repeat(1300), bodyCoverage: { complete: true } }) });
  const { session } = await attached(h, 'body-expiry'); let expiresAt = 0; let captured: Parameters<NonNullable<Harness['toolOwner']>['resultGate']['authorize']> | undefined;
  const original = h.toolOwner!.resultGate.authorize.bind(h.toolOwner!.resultGate);
  t.mock.method(h.toolOwner!.resultGate, 'authorize', async (...args: Parameters<typeof original>) => {
    const result = await original(...args); const binding = args[1].find(binding => binding.name === 'gmail_read');
    if (binding && result.state === 'allowed') { captured = args; const value = h.toolOwner!.consumeEvidence(args[0], binding, h.owner.lookupAuthority(session.liveSessionId), args[3]); if (value.state === 'allowed' && value.evidence.kind === 'remote-body') expiresAt = value.evidence.expiresAt; }
    return result;
  });
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'expiry-start', 'research', { action: 'start', question: 'Read full message', lookups: [{ source: 'mail', mail: { id: 'expiring' } }] });
  const researchId = last()['researchId'], cursor = last()['nextCursor']; assert(expiresAt > Date.now());
  assert(captured); const changedClock = t.mock.method(Date, 'now', () => expiresAt + 1);
  assert.equal(h.toolOwner!.consumeEvidence(captured[0], captured[1].find(binding => binding.name === 'gmail_read')!, h.owner.lookupAuthority(session.liveSessionId), new AbortController().signal).state, 'refused');
  changedClock.mock.restore();
  await settleLiveTool(h, 'expiry-next', 'research', { action: 'continue', researchId, cursor });
  assert.equal(last()['bodySlices'], undefined); assert.equal(last()['canContinue'], false); assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 1);
});

test('mail body integration: body consumption preserves simultaneous calendar evidence and its local remainder', async t => {
  const events = Array.from({ length: 12 }, (_, n) => ({ id: `body-sibling-${n}`, start: '2023-11-15T10:00:00Z', summary: `Body sibling event ${n}` }));
  const h = await harness(t, { tools: true, mail: true, calendar: true, calendarData: name => name === 'gcal_calendars' ? { calendars: [{ id: 'primary' }] } : { events }, mailData: (_name, args) => ({ id: args['id'], headers: { Subject: 'Mixed body' }, body: 'Mixed-source body evidence. '.repeat(600), bodyCoverage: { complete: true } }) }); await attached(h, 'mixed-body-calendar');
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'mixed-start', 'research', { action: 'start', question: 'Read full mail and calendar', lookups: [{ source: 'mail', mail: { id: 'mixed' } }, { source: 'calendar', query: 'this week' }] });
  const seen = new Set<string>(), researchId = last()['researchId']; let count = 0;
  for (;;) {
    for (const match of JSON.stringify(last()['findings']).matchAll(/Body sibling event (\d+)/g)) seen.add(match[1]!);
    assert(JSON.stringify(last()).length <= 6000, 'combined actual model response respects its existing bound');
    if (!last()['canContinue']) break; assert(++count < 20);
    await settleLiveTool(h, `mixed-next-${count}`, 'research', { action: 'continue', researchId, ...(last()['nextCursor'] ? { cursor: last()['nextCursor'] } : {}) });
  }
  assert.equal(seen.size, 12); assert.equal(h.calls.filter(call => call.name === 'gmail_read').length, 1); assert.equal(h.calls.filter(call => call.name === 'gcal_list').length, 1);
});

test('Lux body integration: exact received opaque content reaches its retained tail without another get', async t => {
  const raw = JSON.stringify({ id: 42, title: 'Synthetic Lux body', content: 'Lux received evidence. '.repeat(1400) + 'LUX_LOCAL_TAIL' });
  const h = await harness(t, { tools: true, knowledgeContent: raw }); await attached(h, 'lux-local-tail');
  const last = (): Record<string, unknown> => {
    const frame = h.f.frames.filter(frame => typeof frame === 'object' && frame !== null && 'toolResponse' in frame).at(-1) as { toolResponse: { functionResponses: { response: Record<string, unknown> }[] } };
    return frame.toolResponse.functionResponses[0]!.response;
  };
  await settleLiveTool(h, 'lux-start', 'research', { action: 'start', question: 'Read full insight 42', lookups: [{ source: 'knowledge', query: 'Read full insight 42' }] });
  const researchId = last()['researchId']; let collected = '', count = 0;
  for (;;) {
    const slices = last()['bodySlices'] as { source: string; text: string; offset: number; upstreamComplete: unknown; upstreamOmitted: unknown }[]; assert(Array.isArray(slices) && slices.length, JSON.stringify({ count, calls: h.calls, response: last() }).slice(0, 1800));
    for (const slice of slices) { assert.equal(slice.source, 'knowledge'); assert.equal(slice.offset, collected.length); assert.equal(slice.upstreamComplete, 'unknown'); assert.equal(slice.upstreamOmitted, 'unknown'); collected += slice.text; }
    assert.equal(last()['bodyProjection'], 'preview'); assert(JSON.stringify(last()).length <= 24000);
    if (!last()['canContinue']) break; assert(++count < 25);
    await settleLiveTool(h, `lux-next-${count}`, 'research', { action: 'continue', researchId, cursor: last()['nextCursor'] });
  }
  assert.equal(collected, raw); assert.equal(last()['status'], 'partial', 'all received bytes does not prove upstream completeness'); assert.equal(h.calls.filter(call => call.name === 'get_insight').length, 1); assert.equal(h.calls.filter(call => call.name === 'search_knowledge').length, 0);
});

for (const route of ['typed', 'selector'] as const) test(`progress recovery: ${route} research speaks only verified work at six seconds`, async t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => receipts.push(raw as Record<string, unknown>) }); t.after(detach);
  let selectCalls = 0;
  const scheduler = new DeadlineClock(), fake = progressPort();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, knowledgeSearchLimit: 20, mattermost: true, mattermostWork: () => held, scheduler, limits: openaiLimits, ...(route === 'selector' ? { research: { async select() { selectCalls++; return parseSelector(JSON.stringify({ questionClass: 'cross_source', actions: [{ kind: 'chat_search', query: 'Synthetic progress lookup' }], pUseful: { chat_search: 0.99 } })); } } } : {}) });
  const { session } = await openPort(h, `progress-${route}`);
  fake.emit({ type: 'toolCall', calls: [{ id: 'typed-read', name: 'research', args: { action: 'start', question: 'Synthetic progress lookup', ...(route === 'typed' ? { lookups: [{ source: 'chat', query: 'Synthetic progress lookup' }] } : {}) } }] });
  for (let n = 0; n < 50 && !h.calls.length; n++) await settlePort();
  assert.equal(h.calls.filter(call => call.name.startsWith('mattermost_')).length, 1, 'one actual SDK chat read');
  assert.equal(h.calls.length, route === 'typed' ? 1 : 2, 'selector also reads its canonical prime knowledge source');
  if (route === 'selector') assert.ok(selectCalls > 0, 'actual selector path ran');
  h.advance(5_999); scheduler.runDue(); await settlePort(); assert.deepEqual(fake.commentary, []);
  h.advance(1); scheduler.runDue(); await settlePort();
  assert.equal(fake.commentary.length, 1); assert.match(fake.commentary[0]!, /Still reading the chat/);
  const progress = receipts.filter(entry => entry['event'] === 'research_progress');
  assert.ok(progress.some(entry => (entry['sourcesPending'] as string[]).includes('chat')));
  assert.ok(progress.every(entry => !(entry['sourcesPending'] as string[]).includes('calendar')), 'configured but undispatched calendar is never pending');
  release(); for (let n = 0; n < 50 && !fake.toolResponses.length; n++) await settlePort();
  assert.equal(fake.toolResponses.length, 1); assert.equal(fake.toolResponses[0]![0]!.response['error'], undefined);
  h.advance(5_999); scheduler.runDue(); await settlePort(); assert.equal(fake.commentary.length, 1, 'result does not reset the six-second speech interval');
  h.advance(1); scheduler.runDue(); await settlePort(); assert.equal(fake.commentary.length, 1, 'a result cannot cause a six-second repeat');
  // W4: the turn's only lookup has answered, so no line may claim one is still running.
  h.advance(2_000); scheduler.runDue(); await settlePort(); assert.equal(fake.commentary.length, 1, `a finished lookup is not progress: ${JSON.stringify(fake.commentary)}`);
  h.owner.revoke(session.liveSessionId);
});

test('progress recovery: a new owner question retires pending research speech and late steps', async t => {
  const scheduler = new DeadlineClock(), fake = progressPort();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, knowledgeSearchLimit: 20, mattermost: true, mattermostWork: () => held, scheduler, limits: openaiLimits });
  const { session } = await openPort(h, 'progress-new-question');
  fake.emit({ type: 'toolCall', calls: [{ id: 'old-read', name: 'research', args: { action: 'start', question: 'Old synthetic question', lookups: [{ source: 'chat', query: 'Old synthetic question' }] } }] });
  for (let n = 0; n < 50 && !h.calls.length; n++) await settlePort(); assert.equal(h.calls.length, 1);
  h.advance(5_000); scheduler.runDue();
  fake.emit({ type: 'inputTranscription', text: 'A different synthetic question', finished: true }); await settlePort();
  h.advance(1_000); scheduler.runDue(); await settlePort();
  h.advance(8_000); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, [], 'old research does not narrate after the owner asks something else');
  release(); for (let n = 0; n < 50 && !fake.toolResponses.length; n++) await settlePort();
  assert.ok(!(h.owner.current().steps ?? []).some(step => step.callId === 'old-read'), 'late source end cannot resurrect the previous question step');
  h.owner.revoke(session.liveSessionId);
});

for (const source of ['mail', 'calendar'] as const) test(`progress recovery: actual ${source} pages publish steps and retained continuation does not`, async t => {
  const scheduler = new DeadlineClock(), fake = progressPort();
  const messages = Array.from({ length: 13 }, (_, n) => ({ id: `progress-mail-${n}`, headers: [{ name: 'Subject', value: `Synthetic progress mail ${n}` }] }));
  const events = Array.from({ length: 13 }, (_, n) => ({ id: `progress-event-${n}`, start: '2023-11-15T10:00:00Z', summary: `Synthetic progress event ${n}` }));
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits,
    ...(source === 'mail' ? { mail: true, mailData: (_name: string, args: Record<string, unknown>) => args['pageToken'] ? { messages: messages.slice(8) } : { messages: messages.slice(0, 8), nextPageToken: 'next' } }
      : { calendar: true, calendarData: (name: string, args: Record<string, unknown>) => name === 'gcal_calendars' ? { calendars: [{ id: 'primary' }] } : args['pageToken'] ? { events: events.slice(8) } : { events: events.slice(0, 8), nextPageToken: 'next' } }),
  });
  const { session } = await openPort(h, `progress-pages-${source}`);
  const args = { action: 'start', question: 'Synthetic pages', lookups: [{ source, query: source === 'calendar' ? 'week' : 'subject:synthetic' }] };
  fake.emit({ type: 'toolCall', calls: [{ id: 'pages', name: 'research', args }] });
  for (let n = 0; n < 100 && !fake.toolResponses.length; n++) await settlePort();
  assert.equal(fake.toolResponses.length, 1); const first = fake.toolResponses[0]![0]!.response;
  assert.equal(first['canContinue'], true, JSON.stringify(first));
  const steps = h.owner.current().steps ?? [];
  assert.equal(steps.length, 2, 'one retained terminal step for each actual upstream page');
  assert.ok(steps.every(step => step.source === source && step.phase === 'end' && step.ok));
  assert.equal(new Set(steps.map(step => step.stepId)).size, 2);
  const calls = h.calls.length;
  fake.emit({ type: 'toolCall', calls: [{ id: 'retained', name: 'research', args: { action: 'continue', researchId: first['researchId'], ...(first['nextCursor'] ? { cursor: first['nextCursor'] } : {}) } }] });
  for (let n = 0; n < 100 && fake.toolResponses.length < 2; n++) await settlePort();
  assert.equal(fake.toolResponses.length, 2); assert.match(JSON.stringify(fake.toolResponses[1]![0]!.response['findings']), /Synthetic progress/);
  assert.equal(h.calls.length, calls); assert.deepEqual(h.owner.current().steps ?? [], []);
  assert.deepEqual(fake.commentary, [], 'fast pages and retained delivery need no waiting speech');
  h.owner.revoke(session.liveSessionId);
});

test('progress recovery: actual local history is represented and fast work stays quiet', async t => {
  const scheduler = new DeadlineClock(), fake = progressPort();
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, history: true, scheduler, limits: openaiLimits });
  h.store.transaction(tx => {
    memory.createSession(tx, { title: 'Synthetic progress history', startedAt: NOW, timeZone: 'UTC' }, { now: () => NOW }, 'progress-history-parent');
    memory.appendEntry(tx, { sessionId: 'progress-history-parent', text: 'Synthetic violet flags decision', capturedAt: NOW, timeZone: 'UTC' }, { now: () => NOW }, 'progress-history-entry');
    for (const subject of [{ kind: 'session' as const, id: 'progress-history-parent' }, { kind: 'entry' as const, id: 'progress-history-entry' }]) labels.correct(tx, { subject, expectedRevision: 0, dataClass: 'ordinary' }, NOW);
  });
  const { session } = await openPort(h, 'progress-history');
  fake.emit({ type: 'toolCall', calls: [{ id: 'history', name: 'research', args: { action: 'start', question: 'Synthetic history', lookups: [{ source: 'memory', query: 'violet flags' }] } }] });
  for (let n = 0; n < 100 && !fake.toolResponses.length; n++) await settlePort();
  assert.equal(fake.toolResponses.length, 1); assert.match(JSON.stringify(fake.toolResponses[0]![0]!.response), /violet flags/);
  assert.deepEqual((h.owner.current().steps ?? []).map(step => [step.source, step.phase, step.ok]), [['memory', 'end', true]]);
  assert.deepEqual(fake.commentary, []); h.owner.revoke(session.liveSessionId);
});

test('progress recovery: a slow next mail page is running rather than simultaneously done', async t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => receipts.push(raw as Record<string, unknown>) }); t.after(detach);
  const scheduler = new DeadlineClock(), fake = progressPort();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, mail: true, scheduler, limits: openaiLimits,
    mailData: async (_name, args) => { if (args['pageToken']) await held; return { messages: [{ id: args['pageToken'] ? 'second-mail' : 'first-mail', headers: { Subject: 'Synthetic progress evidence' } }], ...(!args['pageToken'] ? { nextPageToken: 'second' } : {}) }; },
  });
  const { session } = await openPort(h, 'progress-next-mail-page');
  fake.emit({ type: 'toolCall', calls: [{ id: 'mail-pages', name: 'research', args: { action: 'start', question: 'Synthetic mail pages', lookups: [{ source: 'mail', query: 'synthetic' }] } }] });
  for (let n = 0; n < 100 && h.calls.length < 2; n++) await settlePort(); assert.equal(h.calls.length, 2);
  h.advance(5_999); scheduler.runDue(); await settlePort(); assert.deepEqual(fake.commentary, []);
  h.advance(1); scheduler.runDue(); await settlePort();
  assert.deepEqual(fake.commentary, ['Still reading the mail.']);
  const progress = receipts.filter(entry => entry['event'] === 'research_progress');
  assert.ok(progress.every(entry => !(entry['sourcesPending'] as string[]).some(source => (entry['sourcesDone'] as string[]).includes(source))), 'a source cannot be both pending and done');
  release(); for (let n = 0; n < 50 && (h.owner.current().steps ?? []).some(step => step.phase === 'start'); n++) await settlePort();
  h.owner.revoke(session.liveSessionId);
});


test('research 469: known stopped run projects error and retained no-wire delivery projects completed', async t => {
  const fake = progressPort(), scheduler = new DeadlineClock();
  const messages = Array.from({ length: 13 }, (_, n) => ({ id: `continuation-${n}`, headers: [{ name: 'Subject', value: `Synthetic continuation ${n}` }] }));
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits, mail: true, mailData: () => ({ messages }) });
  await openPort(h, 'research-469');
  const call = async (id: string, args: Record<string, unknown>) => {
    const before = fake.toolResponses.length;
    fake.emit({ type: 'toolCall', calls: [{ id, name: 'research', args }] });
    for (let n = 0; n < 100 && fake.toolResponses.length === before; n++) await settlePort();
    assert.equal(fake.toolResponses.length, before + 1);
    const response = fake.toolResponses.at(-1)![0]!.response;
    const journalEntry = h.owner.current().entries.filter(entry => entry.kind === 'toolResult').at(-1);
    const projection = journalEntry?.tool;
    assert(projection);
    return { response, projection, journalEntry };
  };
  const first = await call('start', { action: 'start', question: 'List synthetic continuation', lookups: [{ source: 'mail', mail: { q: 'subject:synthetic', maxResults: 13 } }] });
  assert.equal(first.response['status'], 'partial'); assert.equal(first.projection.status, 'completed');
  assert.equal(h.calls.length, 1); assert.equal(h.owner.current().steps?.length, 1);
  const researchId = first.response['researchId'], cursor = first.response['nextCursor'];
  const next = await call('next', { action: 'continue', researchId, cursor });
  assert.match(JSON.stringify(next.response['findings']), /Synthetic continuation 12/);
  const retained = await call('retained', { action: 'continue', researchId, cursor });
  assert.equal(retained.response['alreadyDelivered'], true); assert.deepEqual(retained.response['findings'], []);
  assert.equal(retained.projection.status, 'completed'); assert.deepEqual(h.owner.current().steps ?? [], []);
  const stopped = await call('stop', { action: 'stop', researchId });
  assert.equal(stopped.response['status'], 'stopped'); assert.equal(stopped.projection.status, 'completed');
  const unavailable = await call('unavailable', { action: 'continue', researchId });
  assert.equal(unavailable.response['status'], 'unavailable'); assert.deepEqual(unavailable.response['findings'], []);
  assert.equal(unavailable.response['canContinue'], false); assert.deepEqual(h.owner.current().steps ?? [], []);
  const unknown = await call('unknown', { action: 'continue', researchId: 'unknown-synthetic' });
  assert.equal(unknown.response['error'], 'unknown_research_run'); assert.equal(unknown.projection.status, 'error');
  assert.equal(h.calls.length, 1, 'no automatic retry or fabricated source execution');
  t.diagnostic(JSON.stringify({ regression: 'research-469-journal', retained: retained.journalEntry, unavailable: unavailable.journalEntry }));
  const partial = await call('partial', { action: 'start', question: 'Synthetic unavailable calendar', lookups: [{ source: 'calendar', query: 'today' }] });
  assert.equal(partial.response['status'], 'partial'); assert.equal(partial.response['error'], undefined); assert.equal(partial.projection.status, 'completed');
  assert.equal(h.calls.length, 1); assert.deepEqual(h.owner.current().steps ?? [], []);
  assert.deepEqual({ error: unavailable.response['error'], projection: unavailable.projection }, { error: 'continuation_unavailable', projection: { name: 'research', status: 'error', markdown: 'research: error', sources: [] } });
});
