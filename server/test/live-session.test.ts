import { taskMigrations } from '../runtime/task-schema.js';
import './tasks-lifecycle.test.js';
import './tasks-store.test.js';
import './task-vault.test.js';
import './task-call.test.js';
import './task-delivery.test.js';
import './tasks-contract.test.js';
import './task-authority.test.js';
import type { ExistingExecutors } from '../tasks/connectors.js';
import { syntheticTaskFactory } from './synthetic-task.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import type { Infer } from '../tasks/worker.js';
import { InstalledCanary, canarySessions } from '../live/canary.js';
import { AlarmScheduler, AlarmSessionCoordinator } from '../host/alarm-scheduler.js';
import { createHash, randomUUID } from 'node:crypto';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { composeLive, resolveLiveMemory } from '../host/live.js';
import { captureHostDiagnostics, HostLog, safeEvent } from '../host/log.js';
import { readSessionTranscript } from '../services/summarize.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { WebSocket } from 'ws';
import { onceDetach, pumpOutput } from '../http/live-upgrade.js';
// Side-effect import: register the intent-tool suite in this process so a declared check runs it
// (live-session is in the contract scope; the check scripts are not).
// Side-effect import: register the research-loop suite in this process so a declared check runs it.
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
import type { ComposeDispatch } from '../tools/types.js';
import { declarationsFor, runToolCalls } from '../tools/declarations.js';
import { shapeGcalCalendars, shapeGcalList, shapeGmailList } from '../tools/live-shape.js';
import { LiveToolJobs, type ToolJob, type ToolJobResult, type JobTimer } from '../tools/jobs.js';
import type { LiveAuthority } from '../tools/types.js';
import { liveProfileIdentity } from '../live/config.js';
import type { ToolDefinition, HostContext } from '../adapters/model/types.js';
import { PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, LIVE_INSTRUCTION_TARGET_CHARS } from '../prompt/index.js';
import * as summaries from '../domain/summaries.js';
import { recordHistorySession } from '../domain/history-lifecycle.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLiveConfig, liveSetupLanguage } from '../config/live.js';
import { NAYA_LIVE_BASE, NAYA_TOOLS, NAYA_BACKEND_PROCEDURE, MEMORY_SECTION_CHAR_LIMIT, LIVE_INSTRUCTION_HARD_LIMIT, LIVE_RECOVERY_PICKUP, composeLiveInstruction, composeLiveSessionInstruction } from '../prompt/live-persona.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoiceAdapterOptions, LiveVoiceControl, LiveVoiceEvent, LiveVoiceLimits, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession, LiveToolResponse, LiveToolSendOutcome } from '../adapters/live-voice/index.js';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createDomainPort } from '../domain/facade.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { traceMigrations } from '../trace/schema.js';
import { record, scopedTraceKey } from '../trace/record.js';
import type { Transaction } from '../contracts/storage.js';
import { announcesLookup, lateFindingsText, researchProjection, createLiveSessionOwner, feedJobs, LiveConfigError, LiveError, liveMigrations, openerFromJournal, previousOpeners, openersNote, OPENER_CONTEXT_CHARS, TURN_FAILED_LINE, journalToolStatus, stripNonLexicalTags, LIVE_DROPPED_LINE_MARK, openerCancelled, validateLiveProfile, type LiveContext, type LiveSessionOwner, type LiveSessionSnapshot } from '../live/index.js';
import { CANARY, control, deferred, fixture, fixtureUntil, fixtureSettled, options, pcm } from './live-voice-fixture.js';
import { fixture as openAiFixture, options as openAiOptions, FakeClock as OpenAiClock } from './openai-live-voice-fixture.js';
import { FRESH_OPENING, OpenAiLiveVoiceAdapter } from '../adapters/live-voice/openai.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';
import { CONNECTOR_DESCRIPTORS, MATTERMOST_TOOLS } from '../connectors/index.js';
import { admissionBlocked } from '../tools/research.js';
import { buildRuntimeContext } from '../prompt/index.js';
import { luxNoteMigrations } from '../tools/lux-note.js';
import { notesExportMigrations } from '../live/schema.js';

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
// Model output the host hears: -12 dBFS samples, so the adapter's own level rule counts the frame as audible.
// A zeroed payload is digital silence under that rule (C-LIVE N-2), which is not what these tests mean.
const speechPcm = () => Uint8Array.from({ length: 8 }, (_unused, index) => index % 2 === 0 ? 0x40 : 0x1f);
const audio = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(speechPcm()).toString('base64') } });

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

function profileInput(limits?: Record<string, number>, model: string | undefined = undefined, provider: 'gemini' | 'openai' = 'gemini') {
  model ??= provider === 'openai' ? 'gpt-live-1' : MODEL;
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
  /** W10: publishes the calendar grant the way the host does after a slow connector finishes. */
  publishCalendar?(): Promise<void>;
}

async function harness(t: TestContext, overrides: {
  portFactory?: (socketFactory: Awaited<ReturnType<typeof fixture>>['socketFactory']) => LiveVoicePort;
  taskInfer?: Infer;
  taskExecutors?: ExistingExecutors;
  limits?: Record<string, number>;
  adapterLimits?: Partial<LiveVoiceLimits>;
  socketFactory?: NonNullable<LiveVoiceAdapterOptions['socketFactory']>;
  port?: LiveVoicePort;
  credentials?: { resolve(reference: string): Promise<string | undefined> };
  model?: string;
  provider?: 'gemini' | 'openai';
  tools?: boolean;
  /** #107: the host's compose port stands in for the connector families, so a write's log is what it asked them to do. */
  compose?: ComposeDispatch;
  /** #107: the owner's configured grant mode; owner writes need `owner-trusted-reads`, as production does. */
  grantMode?: 'explicit' | 'owner-trusted-reads';
  /** #107: the posts one chat read returns, so an injected ask can arrive in a message body. */
  mattermostData?: Record<string, unknown>;
  /** #669: the channels the fixture lists, so a miss can carry three closest names. */
  mattermostChannels?: readonly Record<string, unknown>[];
  /** #669 F1: the child declares the query and types properties, as the real people-mode child does. */
  mattermostListProperties?: boolean;
  releaseEvidenceError?: boolean;
  history?: boolean;
  mattermost?: boolean;
  calendar?: boolean;
  /**
   * W10 (behaviour 1): the calendar connection's policy is already durable, but the transport has not
   * come up when the call starts; `publishCalendar` brings it up 300 ms into the call.
   */
  lateCalendar?: boolean;
  /** W10 (behaviour 2): the calendar endpoint reports connected while no read grant exists at all. */
  ungrantedCalendar?: boolean;
  mail?: boolean;
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
  calendarDigest?: import('../live/index.js').CalendarDigestOwner;
  acceptedPrompt?: (ownerId: string) => NonNullable<ReturnType<typeof validateLiveProfile>['acceptedPrompt']>;
  routeClasses?: readonly ('ordinary' | 'private' | 'sensitive')[];
  overlay?: { schemaVersion: 1; text: string; accent?: string };
  onSessionTerminal?: (liveSessionId: string) => void;
  memoryFailure?: boolean;
  failingWrite?: string;
  researchWeb?: import('../tools/web-search.js').WebSearchPort;
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
  const voice = overrides.port ?? overrides.portFactory?.(f.socketFactory) ?? new GeminiLiveVoiceAdapter(options({
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
  let publishCalendar: (() => Promise<void>) | undefined;
  if (overrides.tools) {
    // W10: the configured endpoint report the live host always supplies, so a start can name a
    // connector that is not usable yet instead of silently narrowing its sources.
    const endpointStates: { id: string; connector: string; state: string }[] = [];
    // W10: the two are not the same thing. A connector can report `connected` while its read grant
    // is still unpublished; only `published` carries the grant the run may actually dispatch.
    const published: string[] = [];
    const mark = (id: string, connector: string): void => {
      const entry = endpointStates.find(state => state.id === id);
      if (entry) entry.state = 'connected'; else endpointStates.push({ id, connector, state: 'connected' });
      if (!published.includes(id)) published.push(id);
    };
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
    const mattermostSchemas = MATTERMOST_TOOLS.map(name => ({ name, inputSchema: overrides.mattermostListProperties && name === 'mattermost_list_channels'
      ? { type: 'object', properties: { query: { type: 'string' }, types: { type: 'array', items: { type: 'string' } } } }
      : { type: 'object' } }));
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
          // #669 F1: a child that ranks its own list answers a query it cannot place with no rows at all.
          ? JSON.stringify({ channels: overrides.mattermostListProperties && typeof (req.params.arguments as Record<string, unknown> | undefined)?.['query'] === 'string'
            ? [] : overrides.mattermostChannels ?? [{ name: 'town-square', display_name: 'Town Square' }] })
          : req.params.name === 'mattermost_whoami'
            ? JSON.stringify({ username: 'owner-chat', display_name: 'Owner Example' })
            : JSON.stringify(overrides.mattermostData ?? { posts: [{ channel: 'town-square', author: 'Rob', time: '2026-10-11T10:00:00Z', text: 'Standup at ten', permalink: 'https://chat.peat-cloud.com/team/pl/abcdef1234567890abcdefghij' }] });
        return { content: [{ type: 'text', text }] };
      });
      await mattermostSdk.connect(mattermostTransport);
    }
    let calendarEndpoint: { id: string; url: string; account: string; resource: string } | undefined;
    let calendarSdk: Server | undefined;
    let calendarTransport: WebStandardStreamableHTTPServerTransport | undefined;
    const calendarSchemas = [{ name: 'calendar_list_calendars', inputSchema: { type: 'object' } }, { name: 'calendar_list_events', inputSchema: { type: 'object' } }];
    if (overrides.calendar) {
      calendarEndpoint = { id: 'calendar', url: 'https://fixture.invalid/calendar', account: 'account', resource: 'resource' };
      registry.register(calendarEndpoint); registry.enable(calendarEndpoint.id); registry.allowEgress(calendarEndpoint.id);
      calendarSdk = new Server({ name: 'live-calendar-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      calendarTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      calendarSdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(calendarSchemas) }) as never);
      calendarSdk.setRequestHandler('tools/call', async req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        const raw = overrides.calendarData ? await overrides.calendarData(req.params.name, req.params.arguments ?? {}) : req.params.name === 'calendar_list_events'
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
      { name: 'gmail_search_messages', inputSchema: { type: 'object', properties: { q: { type: 'string' }, maxResults: { type: 'integer' }, pageToken: { type: 'string' } }, additionalProperties: false } },
      { name: 'gmail_read_message', inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string', enum: ['full', 'metadata'] } }, required: ['id'], additionalProperties: false } },
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
    const mongooseEndpoint = { id: 'mongoose-knowledge', url: 'https://fixture.invalid/mcp/knowledge', account: 'account', resource: 'mongoose:knowledge' };
    const mongooseSchemas = [
      { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, mode: { type: 'string' }, limit: { type: 'integer' }, cursor: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['query'], additionalProperties: false } },
      { name: 'read', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, depth: { type: 'string' }, cursor: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['ref'], additionalProperties: false } },
    ];
    if (overrides.mongoose) {
      registry.register(mongooseEndpoint); registry.enable(mongooseEndpoint.id); registry.allowEgress(mongooseEndpoint.id);
      mongooseSdk = new Server({ name: 'live-mongoose-fixture', version: '1' }, { capabilities: { tools: { listChanged: false } } });
      mongooseTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      mongooseSdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(mongooseSchemas) }) as never);
      mongooseSdk.setRequestHandler('tools/call', req => {
        calls.push({ name: req.params.name, args: req.params.arguments });
        return { content: [{ type: 'text', text: JSON.stringify(overrides.mongooseData ?? { outcome: 'evidence', items: [{ type: 'knowledge_item', ref: 'knowledge/synthetic-company-item', name: 'Synthetic company evidence', url: 'https://source.example.invalid/knowledge/synthetic' }], next_cursor: null, next_tool: null, restriction: null, request_id: 'req-fixture' }) }] };
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
    const toolOwner = createToolsOwner({ store, ownerId: store.assistantId, registry, port, ...(overrides.compose ? { compose: overrides.compose } : {}),
      ...(overrides.grantMode ? { grantMode: overrides.grantMode } : {}), ...(overrides.history ? { grantMode: 'owner-trusted-reads' as const } : {}), lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? owner?.lookupJobAuthority(runId) ?? null });
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
      mark('mattermost', 'mattermost');
    }
    if (overrides.calendar && calendarEndpoint) {
      const apply = (): void => {
        toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'calendar', generation: 1, enabled: true, connector: 'google',
          endpoint: { ...calendarEndpoint!, credentialRef: null }, toolNames: ['calendar_list_calendars', 'calendar_list_events'], schemaDigest: canonicalToolDigest(calendarSchemas),
          sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
          route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
          bounds: { maxQueryChars: 200, maxSearchLimit: 60, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
      };
      const connect = async (): Promise<void> => {
        apply();
        assert.equal((await port.discover(calendarEndpoint!.id)).state, 'discovered');
        toolOwner.projectConnection('calendar');
        mark('calendar', 'google');
      };
      if (overrides.lateCalendar) {
        // The grant is durable, the transport is not up yet: exactly the host-start race on E1.
        apply();
        endpointStates.push({ id: 'calendar', connector: 'google', state: 'connecting' });
        publishCalendar = connect;
      } else if (overrides.ungrantedCalendar) {
        // Connected per the endpoint report, with no read grant published at all.
        endpointStates.push({ id: 'calendar', connector: 'google', state: 'connected' });
        publishCalendar = connect;
      } else {
        await connect();
      }
    }
    if (overrides.mail) {
      toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mail', generation: 1, enabled: true, connector: 'google',
        endpoint: { ...mailEndpoint, credentialRef: null }, toolNames: ['gmail_search_messages', 'gmail_read_message'], schemaDigest: canonicalToolDigest(mailSchemas),
        sourcePolicy: { id: 'live-mail-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
        route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
        bounds: { maxQueryChars: 2048, maxSearchLimit: 50, maxGetIds: 3, maxEntityBytes: 65536, maxResultBytes: 65536 } });
      assert.equal((await port.discover('mail')).state, 'discovered'); toolOwner.projectConnection('mail');
      mark('mail', 'google');
    }
    if (overrides.mongoose) {
      toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: 'mongoose', generation: 1, enabled: true, connector: 'mongoose',
        endpoint: { ...mongooseEndpoint, credentialRef: null }, toolNames: ['search', 'read'], schemaDigest: canonicalToolDigest(mongooseSchemas),
        sourcePolicy: { id: 'live-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
        route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] },
        bounds: { maxQueryChars: 200, maxSearchLimit: 10, maxGetIds: 3, maxEntityBytes: 4096, maxResultBytes: 4096 } });
      assert.equal((await port.discover('mongoose-knowledge')).state, 'discovered');
      toolOwner.projectConnection('mongoose');
      mark('mongoose', 'mongoose');
    }
    toolOwner.projectConnection('lux');
    mark('lux', 'lux-knowledge');
    if (overrides.releaseEvidenceError) toolOwner.releaseEvidence = () => { throw new Error('synthetic evidence release failure'); };
    tools = { ...(overrides.recover ? { recover: overrides.recover } : {}), owner: toolOwner,
      connectionIds: () => [...published],
      status: () => ({ endpoints: endpointStates.map(state => ({ ...state })) }) };
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
  owner = createLiveSessionOwner({ store, voice, profile,
    createTaskRuntime: hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined), bindings: () => [],
      contentAllowed: () => true, timeZone: 'UTC', executors: () => overrides.taskExecutors ?? {}, infer: overrides.taskInfer ?? (async () => ({ text: '', calls: [], no_action: true })), effectCheck: async () => true }), ...(overrides.calendarDigest ? { calendarDigest: overrides.calendarDigest } : {}), ...{ memorySource }, ...(tools ? { tools } : {}), ...(overrides.researchWeb ? { researchWeb: overrides.researchWeb } : {}), now: () => overrides.scheduler?.now ?? clock, timeZone: 'Asia/Kolkata', ...(overrides.scheduler ? { schedule: overrides.scheduler.schedule } : {}) });
  t.after(async () => { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...(toolRegistry ? { toolRegistry } : {}), ...(exposedToolOwner ? { toolOwner: exposedToolOwner } : {}), ...(publishCalendar ? { publishCalendar } : {}), requests, calls, get memorySelections() { return memorySelections; }, f, store, owner, ctx: context(store), dir, advance: ms => { if (overrides.scheduler) overrides.scheduler.now += ms; else clock += ms; } };
}

/** Attach a session on a custom port: `attached` speaks the Gemini fixture's frames, which a fake port never sees. */
async function openPort(h: Harness, key: string) {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  await settlePort();
  return { session, attachment };
}

async function attached(h: Harness, key = 'k1', opening = FRESH_OPENING) {
  const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary' }, h.ctx);
  assert.equal(h.owner.current().state, 'idle', 'accepted without an attachment is not listening');
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  await h.f.frame(2);
  // 1023-N3: the opening directive is a completed user turn, so the provider answers it instead of waiting for VAD.
  assert.deepEqual(h.f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: opening }] }], turnComplete: true } });
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
  assert.deepEqual(h.f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: FRESH_OPENING }] }], turnComplete: true } });
  const persisted = JSON.stringify(h.store.transaction(tx => tx.all('SELECT kind,text FROM live_journal WHERE live_session_id=?', [session.liveSessionId])));
  assert.equal(persisted.includes(FRESH_OPENING), false, 'the server-owned directive is not user transcription or history');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('1023-R1: the opening directive is a completed user turn to the provider, never the owner speaking', async t => {
  const h = await harness(t);
  const rows = (liveSessionId: string) => h.store.transaction(tx => tx.all('SELECT kind, text FROM live_journal WHERE live_session_id=?', [liveSessionId])
    .map(row => ({ kind: String(row['kind']), text: row['text'] === null ? null : String(row['text']) })));
  const first = await attached(h, 'directive-not-owner');
  assert.deepEqual(rows(first.session.liveSessionId).filter(row => row.kind === 'inputTranscription'), [],
    'the host never journals its own directive as owner transcription');
  assert.equal(JSON.stringify(rows(first.session.liveSessionId)).includes(FRESH_OPENING), false,
    'and never as any other journal row, so no summary or memory read can find it');
  assert.equal(h.owner.current().entries.some(entry => entry.kind === 'inputTranscription'), false,
    'the owner transcript stays empty on a call that only received the directive');
  // The same query #ownerSpoke runs: a call that only carried the directive still counts as the owner not speaking.
  const ownerSpoke = (liveSessionId: string): boolean => h.store.transaction(tx => !!tx.get("SELECT journal_id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' LIMIT 1",
    [liveSessionId]));
  assert.equal(ownerSpoke(first.session.liveSessionId), false, 'the owner-speaks-first probe stays false');
  h.owner.revoke(first.session.liveSessionId);
  await first.attachment.done;
  h.f.frames.length = 0;
  const second = await attached(h, 'directive-not-owner-2');
  const seeded = h.requests.at(-1)!;
  assert.deepEqual(seeded.history, [], 'the next call seeds no owner turn for a call that only carried the directive');
  assert.equal(JSON.stringify(seeded).includes(FRESH_OPENING), false, 'the directive never reaches the next call as history');
  assert.deepEqual(rows(second.session.liveSessionId).filter(row => row.kind === 'inputTranscription'), [], 'and the second call journals none either');
  // Positive control, same harness and same queries: a real owner turn does reach the journal, so the emptiness
  // above is the directive being kept out and not the journal path being blind.
  h.f.send({ serverContent: { inputTranscription: { text: 'Synthetic owner words on this call.', finished: true } } });
  await drain(h, second.session.liveSessionId, 2);
  assert.deepEqual(rows(second.session.liveSessionId).filter(row => row.kind === 'inputTranscription').map(row => row.text),
    ['Synthetic owner words on this call.'], 'the same journal records a real owner turn, verbatim');
  assert.equal(ownerSpoke(second.session.liveSessionId), true, 'and the owner-speaks-first probe sees it');
  assert.equal(rows(second.session.liveSessionId).some(row => row.text !== null && row.text.includes(FRESH_OPENING)), false,
    'a real owner turn and the directive never appear together as owner speech');
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

test('L8-10: the runtime context names web search when the session can search the web, and only then', async t => {
  const web = { search: async () => { throw new Error('not called at start'); } };
  const native = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' }).text;
  const withWeb = await harness(t, { tools: true, researchWeb: web, system: native });
  const { attachment: withAttachment } = await attached(withWeb);
  const connected = /^Connected now: (.*)\.$/mu.exec(withWeb.requests[0]!.system.text)?.[1] ?? '';
  assert.ok(connected.split(', ').includes('web search'), `the declared web read is named: ${connected}`);
  assert.ok(connected.split(', ').includes('his private notes'), `the knowledge read stays named: ${connected}`);
  withAttachment.close(); await withAttachment.done;
  const without = await harness(t, { tools: true, system: native });
  const { attachment } = await attached(without);
  assert.match(without.requests[0]!.system.text, /^Connected now: /mu, 'the runtime context is composed');
  assert.equal(/^Connected now: .*web search/mu.test(without.requests[0]!.system.text), false, 'no web read, no web claim');
  attachment.close(); await attachment.done;
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
  let taskStarted = false;
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  // Only the detach countdown is under test: the idle, session and call ceilings stay far away.
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 },
    ...(openDelegation ? { taskInfer: async () => { taskStarted = true; await work; return { text: '', calls: [], no_action: true }; } } : {}) });
  const { attachment } = await attached(h);
  if (openDelegation) {
    await ownerSpoke(h);
    h.f.send({ toolCall: { functionCalls: [{ id: 'open1', name: 'delegate', args: { request: 'Synthetic owner request' } }] } });
    // Bounded, so a refused call fails here instead of spinning past the test timeout and holding the file open.
    await fixtureUntil(() => taskStarted, 'pending helper task');
    assert.equal(taskStarted, true, 'the delegation is open while controlled inference is pending');
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

// C-LABELS 2, F-3: a session the app declared lost is over as surely as a Stop, so the pump must treat its
// terminal the same way: the terminal goes out first and the queued speech behind it is never delivered.
test('C-LABELS 2: a session_lost terminal outranks queued speech the way a Stop does', async () => {
  const frames: unknown[] = [];
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (frame: unknown) => { frames.push(frame); },
    close: () => { socket.readyState = 3; } };
  const attachment = {
    output: (async function* () { for (let i = 0; i < 20; i++) yield { kind: 'audio', pcm: new Uint8Array([1, 0]), rate: 24000 }; })(),
    done: Promise.resolve({ ready: true, terminal: { state: 'closed', code: 'session_lost' }, journal: { complete: true } }),
    overflow: () => { assert.fail('a lost session outranks queued speech and backpressure'); },
  };
  await pumpOutput(socket as unknown as PumpSocket, attachment as unknown as Parameters<typeof pumpOutput>[1], () => { assert.fail('not detached'); }, 1_000);
  assert.deepEqual(frames.map(frame => JSON.parse(String(frame))),
    [{ type: 'terminal', state: 'closed', code: 'session_lost', complete: true }], 'the lost terminal is the only frame, with no queued audio behind it');
});

test('an output pump whose socket goes CLOSING mid-answer detaches once and ends the session as consumer_closed', async t => {
  await pumpIntoDeadSocket(t, false);
});

test('the same socket death with an open delegation detaches once and ends the session as consumer_closed', async t => {
  await pumpIntoDeadSocket(t, true);
});

test('a Quit ends the live session as app_quit, never as the Stop button', async t => {
  const scheduler = new DeadlineClock();
  const receipts: Record<string, unknown>[] = [];
  const quitSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => quitSink());
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const { session } = await attached(h, 'quit-reason');
  h.f.send({ serverContent: { inputTranscription: { text: 'what the owner said' } } });
  await drain(h, session.liveSessionId, 2);
  await h.owner.shutdown();
  const end = receipts.filter(record => record.event === 'session_end');
  assert.equal(end.length, 1, 'one receipt for the Quit');
  assert.deepEqual(end[0], { event: 'session_end', reason: 'app_quit', msAfterStop: 0 });
});

// C-LABELS 1: the app names its end on the wire before stdin closes; a shell that vanished names nothing, and
// EOF with no stop frame is the shell's loss rather than the owner's Quit.
test('C-LABELS 1: a shell that vanished ends the live session as shell_lost, never as app_quit', async t => {
  const scheduler = new DeadlineClock();
  const receipts: Record<string, unknown>[] = [];
  const quitSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => quitSink());
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const { session, attachment } = await attached(h, 'shell-lost');
  h.f.send({ serverContent: { inputTranscription: { text: 'what the owner said' } } });
  await drain(h, session.liveSessionId, 2);
  await h.owner.shutdown('shell_lost');
  assert.deepEqual(receipts.filter(record => record.event === 'session_end'), [{ event: 'session_end', reason: 'shell_lost', msAfterStop: 0 }]);
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'shell_lost' }, 'the terminal names the shell, not the owner');
});

// C-LABELS 2: a session the app could not vouch for is named apart from the owner's own Stop, and the host
// repeats the word the app sent instead of inventing its own.
test('C-LABELS 2: a Stop naming a lost session logs session_lost, never user_stop', async t => {
  const receipts: Record<string, unknown>[] = [];
  const stopSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => stopSink());
  const h = await harness(t, {});
  const { attachment } = await attached(h);
  attachment.close('session_lost');
  // C-LABELS 2, F-1: the terminal code is the fact the audit reads, so it names the lost session too. A
  // `session_end` that says session_lost over a `live_terminal` that says user_stop is two labels for one end.
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'session_lost' });
  assert.deepEqual(receipts.filter(record => record.event === 'session_end'), [{ event: 'session_end', reason: 'session_lost', msAfterStop: 0 }]);
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

// C-HEADPHONES 5: the app's native `live_end` reason travels with the Stop, so a route change is
// recorded as a route change and never as the owner's own stop.
test('a Stop carrying the native route_change reason logs session_end reason route_change', async t => {
  const receipts: Record<string, unknown>[] = [];
  const stopSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => stopSink());
  const h = await harness(t, {});
  const { session, attachment } = await attached(h);
  attachment.close('route_change');
  const terminal = await attachment.done;
  assert.deepEqual(terminal.terminal, { state: 'closed', code: 'user_stop' }, 'the call still ends at once');
  const end = receipts.filter(record => record.event === 'session_end');
  assert.deepEqual(end, [{ event: 'session_end', reason: 'route_change', msAfterStop: 0 }]);
  assert.ok(safeEvent(end[0]), 'the host log whitelist accepts the native reason');
  assert.equal(h.owner.get(session.liveSessionId).terminal?.state, 'closed');
});

// An unknown word from the app is never invented into the log: it stays the owner's stop.
test('a Stop carrying an unknown reason still logs session_end reason user_stop', async t => {
  const receipts: Record<string, unknown>[] = [];
  const stopSink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => stopSink());
  const h = await harness(t, {});
  const { attachment } = await attached(h);
  attachment.close('made_up_reason');
  await attachment.done;
  assert.deepEqual(receipts.filter(record => record.event === 'session_end'),
    [{ event: 'session_end', reason: 'user_stop', msAfterStop: 0 }]);
});

// #589: the deterministic host phrase gate. The owner's own finalized sentence with her name at an edge
// ends the call at once, with no model turn and no generation in the stop path.
type VoiceStopSocket = Parameters<typeof pumpOutput>[0];
const recordingSocket = (frames: string[]): VoiceStopSocket => {
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send(data: unknown): void { frames.push(typeof data === 'string' ? data : 'binary'); },
    close(): void { socket.readyState = 3; } };
  return socket as unknown as VoiceStopSocket;
};

const sayStopPhrase = async (fake: ReturnType<typeof fakeLiveVoicePort>, finalOrigin?: string): Promise<void> => {
  fake.emit({ type: 'inputTranscription', text: 'Naya, stop ', finished: false, ...(finalOrigin ? { finalOrigin } : {}) });
  await tick();
  fake.emit({ type: 'inputTranscription', text: 'listening.', finished: false, ...(finalOrigin ? { finalOrigin } : {}) });
  await tick();
  fake.emit({ type: 'inputTranscription', text: '', finished: true, ...(finalOrigin ? { finalOrigin } : {}) });
};

test('#589 a spoken "Naya, stop listening" ends the call as voice_stop and sends one end frame', async t => {
  const scheduler = new DeadlineClock();
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'voice-stop', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const frames: string[] = [];
  const pump = pumpOutput(recordingSocket(frames), attachment, () => {}, 1_000_000);
  await sayStopPhrase(fake);
  // No clock advance: the stop is felt on the finalized turn, not after a countdown.
  await pump;
  const end = frames.map(frame => JSON.parse(frame) as { type: string; state?: string; code?: string })
    .filter(frame => frame.type === 'terminal');
  assert.equal(end.length, 1, 'one end frame, and it is the terminal the app acts on');
  assert.deepEqual([end[0]?.state, end[0]?.code], ['closed', 'voice_stop']);
  const snapshot = h.owner.get(session.liveSessionId);
  assert.deepEqual(snapshot.terminal, { state: 'closed', code: 'voice_stop' }, 'the terminal is the voice stop');
  assert.equal(snapshot.consumerState, 'ended', 'the mic stream is closed with the call');
  assert.equal(receipts.filter(record => record.event === 'voice_stop').length, 1, 'one voice_stop receipt');
  assert.equal(receipts.filter(record => record.event === 'session_end').length, 0,
    'a voice stop is not the Stop button, so it is not logged as one');
  scheduler.runDue();
});

test('#589 a stop phrase mid-answer cancels the running response before the goodbye', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'voice-stop-mid-answer', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const frames: string[] = [];
  const pump = pumpOutput(recordingSocket(frames), attachment, () => {}, 1_000_000);
  // She is answering: the model turn opened and one chunk of it already reached the app.
  fake.emit({ type: 'modelTurnStarted' });
  fake.emit({ type: 'audio', pcm: new Uint8Array([1, 0]), rate: 24000 });
  await tick();
  await sayStopPhrase(fake);
  // The rest of the answer is still arriving when the owner's words land: it must never reach the app.
  fake.emit({ type: 'audio', pcm: new Uint8Array([2, 0]), rate: 24000 });
  fake.emit({ type: 'generationComplete' });
  await pump;
  const kinds = frames.map(frame => {
    if (typeof frame !== 'string') return 'audio';
    return frame === 'binary' ? 'audio' : (JSON.parse(frame) as { type: string }).type;
  });
  assert.equal(kinds.at(-1), 'terminal', 'the end frame is the last frame the app receives');
  assert.equal(kinds.filter(kind => kind === 'audio').length, 1, 'only the chunk that arrived before the stop was played');
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
});

test('#589 a muted call and a typed turn never end on the stop phrase', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'voice-stop-muted', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  void (async () => { for await (const chunk of attachment.output) { void chunk; } })();
  await attachment.setInputMuted(true);
  await sayStopPhrase(fake);
  await tick();
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'a muted turn is never the owner asking to stop');
  await attachment.setInputMuted(false);
  await sayStopPhrase(fake, 'typed');
  await tick();
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'a typed turn is never the owner speaking');
  attachment.close();
  await attachment.done;
});

test('#589 with no consumer confirmation the host records the voice stop itself', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'voice-stop-silent', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  // No output consumer ever reads: native is silent, so nothing confirms the stop.
  await sayStopPhrase(fake);
  const snapshot = await waitTerminal(h, session.liveSessionId);
  assert.deepEqual(snapshot.terminal, { state: 'closed', code: 'voice_stop' },
    'the host settles the call itself, no clock advance and no native frame');
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
  assert.deepEqual(h.f.frames[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: FRESH_OPENING }] }], turnComplete: true } });
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
    // W4: the runtime context now names the live connector state, so the expectation carries the
    // one endpoint this harness publishes.
    runtimeContext: buildRuntimeContext({ now: new Date(NOW), timeZone: 'Asia/Kolkata', connected: ['his private notes', 'memory'],
      vault: { dictation: true, composed: false }, connectors: [{ connector: 'lux-knowledge', state: 'connected' }] }) }).text);
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
  assert.deepEqual({ ...current, liveSessions: current.liveSessions.map(({ memory_provenance: _newColumn, resumption_handle: _handle, connection_generation: _generation,
    diagnostic_metadata_state: _dm, diagnostic_content_state: _dc, native_receipt_state: _nr, diagnostic_failures: _df,
    diagnostic_last_reason: _dl, diagnostic_unattributed_transcripts: _du, diagnostic_clock_domain: _dcd, ...legacy }) => legacy) }, { ...prior, liveSessions: prior.liveSessions.map(row => ({ ...row })) }, 'all pre-existing Live, CHAT and Domain values stay byte-identical');
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
    [chatMigrations, domainMigrations, liveMigrations, luxNoteMigrations, notesExportMigrations, taskMigrations, traceMigrations].map(migrations => [migrations[0]!.owner, Math.max(...migrations.map(migration => migration.version))]));
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
  const recoverOwner = (store: Store) => createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(store),
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
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'app_quit' }, 'a host shutdown names the end app_quit');
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
  const terminal = h.owner.create({ idempotencyKey: 'history-template', inputClass: 'ordinary' }, h.ctx);
  h.owner.revoke(terminal.liveSessionId);
  // Build unrelated history in one fixture transaction, not 1000 prompt compilations and revocations.
  const columns = h.store.transaction(tx => Object.keys(tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [terminal.liveSessionId])!));
  const projection = columns.map(name => name === 'live_session_id' || name === 'idempotency_key' ? '?' : `"${name}"`).join(',');
  for (const target of [100, 1000]) {
    const start = target === 100 ? 1 : 100;
    h.store.transaction(tx => {
      for (let i = start; i < target; i++) tx.run(`INSERT INTO live_sessions SELECT ${projection} FROM live_sessions WHERE live_session_id=?`,
        [`history-${i}`, `history-${i}`, terminal.liveSessionId]);
    });
    measure(target);
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
    import { lateFindingsText, researchProjection, createLiveSessionOwner, validateLiveProfile, liveMigrations } from ${JSON.stringify(new URL('../live/index.js', import.meta.url).href)};
    import { domainMigrations } from ${JSON.stringify(new URL('../domain/schema.js', import.meta.url).href)};
    const store = new Store(${JSON.stringify(dir)}, [...domainMigrations, ...liveMigrations]);
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
  const store = new Store(dir, [...domainMigrations, ...liveMigrations]);
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
  assert.throws(() => createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(h.store), store: h.store, voice: { capabilities: fakeLiveVoicePort().port.capabilities, open() { throw new Error('unexpected open'); } }, profile: validateLiveProfile(profileInput()), now: () => NOW + 0.5 }), { code: 'invalid_config' });
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
  const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(h.store), store: h.store,
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
    const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(h.store), store: h.store, profile: validateLiveProfile({ ...profileInput(),
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
  const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(h.store), store: h.store, profile, voice, now: () => NOW }); t.after(() => owner.shutdown());
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














test('a response the owner barges in on is measured on its own, so two voices never mix (#1027 F1)', async t => {
  const events: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(() => sink());
  const h = await harness(t, {});
  const { session, attachment } = await attached(h);
  void (async () => { for await (const _chunk of attachment.output) { /* drain playback */ } })();
  // 2000 samples of a 110 Hz tone at 24 kHz: a real voiced frame, not the 8-byte stub.
  const samples = new Int16Array(2000);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 110 * index) / 24000));
  const voiced = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(samples.buffer).toString('base64') } };
  const handled = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [voiced] } } });
  h.f.send({ serverContent: { interrupted: true } });
  h.f.send({ serverContent: { outputTranscription: { text: 'after the barge-in', finished: true } } });
  await drain(h, session.liveSessionId, handled + 2);
  const profiles = events.filter(line => line.event === 'live_voice_profile');
  assert.equal(profiles.length, 1, 'the interrupted response logged its own profile');
  assert.equal(profiles[0]!.responseId, 'resp-1');
  assert.ok(Number(profiles[0]!.audibleMs) > 0, `audible ms ${String(profiles[0]!.audibleMs)}`);
  assert.ok(Math.abs(Number(profiles[0]!.f0Hz) - 110) < 5, `measured ${String(profiles[0]!.f0Hz)} Hz`);
  h.owner.revoke(session.liveSessionId);
});












test('Live revocation invalidates authority and discards an in-flight result', async t => {
  const p = progressPort(); const started = deferred<void>(), finish = deferred<void>();
  let signal: AbortSignal | undefined;
  const h = await harness(t, { port: p.port, provider: 'openai', taskInfer: async (_request, current) => {
    signal = current; started.resolve(); await finish.promise;
    return { text: 'Synthetic result that must not escape revocation.', calls: [] };
  } });
  const { session, attachment } = await openPort(h, 'task-revocation');
  p.emit({ type: 'delegation', delegationId: 'synthetic-binding' });
  p.emit({ type: 'inputTranscription', text: 'Read the synthetic record', finished: true, finalOrigin: 'provider' });
  await fixtureSettled(started.promise, 'controlled task inference');
  assert.equal(signal?.aborted, false);
  h.owner.invalidate('profile');
  assert.equal(signal?.aborted, true, 'revocation cancels the worker, not only its speech');
  finish.resolve(); await settlePort();
  assert.equal(p.taskAnswers.length, 0, 'a late answer cannot reach the revoked provider binding');
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'revoked' });
  await attachment.done;
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
  const owner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(h.store), store: h.store, profile, voice, now: () => NOW, timeZone: 'Asia/Kolkata' }); t.after(() => owner.shutdown());
  const accepted = owner.create({ idempotencyKey: 'wire-naya', inputClass: 'ordinary' }, h.ctx);
  const attachment = owner.attach({ liveSessionId: accepted.liveSessionId }, h.ctx);
  await h.f.frame(1);
  const frame = JSON.parse(JSON.stringify(h.f.frames[0]));
  const expectedWithRuntime = composeLiveSessionInstruction({ text: composed.text, tools: [], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    runtimeContext: buildRuntimeContext({ now: new Date(NOW), timeZone: 'Asia/Kolkata', connected: [], vault: { dictation: true, composed: false } }) }).text;
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
  const first = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(store), store, profile: status.config.profile, voice: adapter(), now: () => NOW, timeZone: 'Asia/Kolkata' });
  const created = first.create({ idempotencyKey: 'owner-create', inputClass: 'ordinary' }, context(store));
  const persisted = store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [created.liveSessionId])!['accepted_prompt_snapshot'])));
  const expectedWithRuntime = composeLiveSessionInstruction({ text: expected, tools: [], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    runtimeContext: buildRuntimeContext({ now: new Date(NOW), timeZone: 'Asia/Kolkata', connected: [], vault: { dictation: true, composed: false } }) }).text;
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



test('L14: non-lexical transcript tags never reach the journal, and other brackets are the owner\'s own', async t => {
  // The closed list, terminated or not, is a breath and never a word; anything else in brackets stays.
  assert.equal(stripNonLexicalTags('so [inhale'), 'so ');
  assert.equal(stripNonLexicalTags('a [breath] b [sigh] c'), 'a  b  c');
  assert.equal(stripNonLexicalTags('keep [the folder] and [2] as they are'), 'keep [the folder] and [2] as they are');
  // C-PICKUP: every cue the model writes is a cue, and an ordinary bracket stays the owner's own.
  assert.equal(stripNonLexicalTags('[chuckle] hi [Q3]'), ' hi [Q3]', 'a chuckle cue is stripped, a question number is not');
  assert.equal(stripNonLexicalTags('a [chuckles] b [giggle] c [giggles] d [laughter] e [smile] f [smiles] g'), 'a  b  c  d  e  f  g');
  const h = await harness(t);
  const { session } = await attached(h, 'tags');
  h.f.send({ serverContent: { inputTranscription: { text: 'the plan holds [inhale' } } });
  h.f.send({ serverContent: { inputTranscription: { text: ' and the folder [breath] stays', finished: true } } });
  h.f.send({ serverContent: { outputTranscription: { text: 'all set [sigh] here', finished: true } } });
  await drain(h, session.liveSessionId, 4);
  const rows = h.store.transaction(tx => tx.all("SELECT kind,text FROM live_journal WHERE live_session_id=? AND kind IN ('inputTranscription','outputTranscription') ORDER BY journal_id", [session.liveSessionId]));
  const input = rows.filter(row => row['kind'] === 'inputTranscription').map(row => String(row['text'])).join('');
  const output = rows.filter(row => row['kind'] === 'outputTranscription').map(row => String(row['text'])).join('');
  assert.equal(/\[(?:inhale|breath|sigh)/i.test(input), false, 'no tag survives in what the owner said');
  assert.equal(/\[(?:inhale|breath|sigh)/i.test(output), false, 'and none in what she said');
  assert.ok(input.includes('the plan holds') && input.includes('and the folder'), 'the words are still there');
});

test('L7: a response that began under the mute is dropped at unmute, and the muted time is not dead air', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session, attachment } = await attached(h, 'mute-stale');
  const events: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(() => sink());
  const played: string[] = [];
  void (async () => { for await (const chunk of attachment.output) if (chunk.kind === 'audio') played.push(chunk.kind); })();
  attachment.setInputMuted(true);
  // The answer starts under the mute: its frame is dropped and the answer is held. The transcription sent
  // after it is an ordered receipt on the same socket: a later journal event proves the host has handled
  // the frame, so no wall-clock tick is asked to stand in for delivery.
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  let handled = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { outputTranscription: { text: 'held answer', finished: true } } });
  await drain(h, session.liveSessionId, handled + 1);
  h.advance(25_000); scheduler.runDue();
  attachment.setInputMuted(false);
  // The same response streams on after the unmute: not one frame of it is played.
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  handled = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { outputTranscription: { text: 'stale answer', finished: true } } });
  await drain(h, session.liveSessionId, handled + 1);
  assert.equal(played.length, 0, 'a stale answer is never played at unmute');
  // The dropped response ends before the next turn begins.
  h.f.send({ serverContent: { turnComplete: true } });
  await tick();
  void session;
});

test('L7: the muted time is excluded from live_dead_air', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { attachment } = await attached(h, 'mute-dead-air');
  const events: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(() => sink());
  // The owner's turn ends, then she is muted for 25 s before the answer becomes audible.
  h.f.send({ serverContent: { inputTranscription: { text: 'what now', finished: true } } });
  await tick();
  attachment.setInputMuted(true);
  h.advance(25_000); scheduler.runDue();
  attachment.setInputMuted(false);
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  for (let i = 0; i < 40 && !events.some(entry => entry.event === 'live_dead_air' && typeof entry['deadAirMs'] === 'number'); i++) await tick();
  const deadAir = events.find(entry => entry.event === 'live_dead_air' && typeof entry['deadAirMs'] === 'number');
  assert.ok(deadAir, 'the first audible frame logs the dead air it followed');
  assert.ok(Number(deadAir!['deadAirMs']) < 5_000, `the 25 s mute is not dead air the owner heard, got ${deadAir!['deadAirMs']}`);
});

// #720: a burst of the owner's own fragments used to anchor the receipt at the first one, so the receipt named the
// length of his sentence instead of the wait that followed it.
test('#720: dead air is measured from the owner last fragment, not the first', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session, attachment } = await attached(h, 'dead-air-last-fragment');
  const events: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(() => sink());
  // Each fragment is journaled before the clock moves, so its arrival time is the one the test intends.
  const say = async (text: string, advanceMs: number): Promise<void> => {
    const before = h.owner.get(session.liveSessionId).journal.events;
    h.f.send({ serverContent: { inputTranscription: { text, finished: true } } });
    await drain(h, session.liveSessionId, before + 1);
    h.advance(advanceMs);
  };
  await say('synthetic one', 1_000);
  await say('synthetic two', 1_000);
  await say('synthetic three', 4_000);
  // Four seconds after his last fragment, the answer becomes audible.
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  for (let i = 0; i < 40 && !events.some(entry => entry.event === 'live_dead_air' && typeof entry['deadAirMs'] === 'number'); i++) await tick();
  const deadAir = events.find(entry => entry.event === 'live_dead_air' && typeof entry['deadAirMs'] === 'number');
  assert.ok(deadAir, 'the first audible frame logs the dead air it followed');
  const ms = Number(deadAir!['deadAirMs']);
  assert.ok(ms >= 3_900 && ms <= 4_100, `the wait after his last fragment is about 4 s, not the 6 s from his first, got ${ms}`);
  attachment.close();
  await attachment.done;
});

// #720: the mute sits between his last fragment and the answer, so it belongs to the span and must be excluded.
test('#720: a mute inside the span is excluded from live_dead_air', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session, attachment } = await attached(h, 'dead-air-muted-span');
  const events: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(() => sink());
  const say = async (text: string, advanceMs: number): Promise<void> => {
    const before = h.owner.get(session.liveSessionId).journal.events;
    h.f.send({ serverContent: { inputTranscription: { text, finished: true } } });
    await drain(h, session.liveSessionId, before + 1);
    h.advance(advanceMs);
  };
  await say('synthetic first', 1_000);
  await say('synthetic last', 500);
  attachment.setInputMuted(true);
  h.advance(14_500);
  scheduler.runDue();
  attachment.setInputMuted(false);
  h.advance(1_000);
  h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
  for (let i = 0; i < 40 && !events.some(entry => entry.event === 'live_dead_air' && typeof entry['deadAirMs'] === 'number'); i++) await tick();
  const deadAir = events.find(entry => entry.event === 'live_dead_air' && typeof entry['deadAirMs'] === 'number');
  assert.ok(deadAir, 'the first audible frame logs the dead air it followed');
  const ms = Number(deadAir!['deadAirMs']);
  assert.ok(ms >= 1_400 && ms <= 1_600, `the 14.5 s mute is not dead air the owner heard, got ${ms}`);
  attachment.close();
  await attachment.done;
});

test('L19: a call seeded after a dead one marks its last answer heard and never repeats it', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session } = await attached(h, 'dead-line-seed');
  h.f.send({ serverContent: { outputTranscription: { text: 'the answer that never reached her', finished: true } } });
  await drain(h, session.liveSessionId, 2);
  // The call is lost to a refused recovery and settles resume_failed.
  h.f.refuseUpgrades(401);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-seed-resumption-secret' }, goAway: { timeLeft: '10s' } });
  let settled = false;
  for (let i = 0; i < 90 && !settled; i++) {
    h.advance(1000); scheduler.runDue(); await tick();
    settled = h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.some(row => row.kind === 'terminal');
  }
  assert.equal(settled, true, 'the dead call ended');
  // The next call in the same conversation seeds that history.
  const next = h.owner.create({ idempotencyKey: 'dead-line-next', inputClass: 'ordinary' }, h.ctx);
  h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  await tick();
  const request = h.requests.at(-1)!;
  const history = request.history ?? [];
  assert.ok(history.some(turn => turn.role === 'model' && turn.text.includes('never reached her')), 'the dead answer is still history');
  assert.equal(history.at(-1)?.role, 'user', 'and the seed closes it as heard');
  assert.match(history.at(-1)!.text, /line dropped/i, 'the seed says the line dropped instead of inviting a repeat');
  h.owner.revoke(next.liveSessionId);
});

test('L19: after a dead call the silent owner hears the drop line, and one who already spoke is answered', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session } = await attached(h, 'dead-line-branches');
  h.f.send({ serverContent: { outputTranscription: { text: 'the answer that never reached her', finished: true } } });
  await drain(h, session.liveSessionId, 2);
  h.f.refuseUpgrades(401);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-branches-resumption' }, goAway: { timeLeft: '10s' } });
  let settled = false;
  for (let i = 0; i < 90 && !settled; i++) {
    h.advance(1000); scheduler.runDue(); await tick();
    settled = h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.some(row => row.kind === 'terminal');
  }
  assert.equal(settled, true, 'the dead call ended');
  // Branch 1: the owner has not spoken, so the opener names the drop and offers to continue.
  const silent = h.owner.create({ idempotencyKey: 'dead-line-silent', inputClass: 'ordinary' }, h.ctx);
  h.owner.attach({ liveSessionId: silent.liveSessionId }, h.ctx);
  await tick();
  const silentRequest = h.requests.at(-1)!;
  assert.equal(silentRequest.openingText, LIVE_DROPPED_LINE_MARK, 'the silent owner gets the drop line, never a repeat');
  assert.equal((silentRequest.history ?? []).at(-1)?.role, 'user', 'and the dead answer is closed as heard');
  // R7: the owner is silent here, so the opener is the one-line drop acknowledgement, not a repeat.
  assert.match(String(silentRequest.openingText), /line dropped/i, 'the opener names the dropped line');
  h.owner.revoke(silent.liveSessionId);
});

test('L19: the first spoken reply of a call is never unjournalled without a receipt', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const events: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(() => sink());
  const { session } = await attached(h, 'reply-receipt');
  // The provider speaks with no output transcript at all, which is exactly the missing-row case. The
  // opening turn can speak too, so this counts its own reply instead of the first one in the log.
  const audible = (): number => events.filter(entry => entry.event === 'live_first_audio').length;
  const before = audible();
  for (let i = 0; i < 40 && audible() === before; i++) {
    h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } });
    await tick();
  }
  assert.ok(audible() > before, 'the reply was audible');
  h.f.send({ serverContent: { turnComplete: true } });
  // The receipt is written from the provider's turn-complete path, so wait for the pump itself rather than for a
  // fixed number of ticks: under a loaded host the two ticks used to arrive before the turn was handled.
  for (let i = 0; i < 40 && events.every(entry => entry.event !== 'live_reply_unjournalled'); i++) await tick();
  // The reply is never unjournalled: its own row exists, so no reader has to infer what was said.
  const rows = h.store.transaction(tx => tx.all("SELECT text FROM live_journal WHERE live_session_id=? AND kind='outputTranscription'", [session.liveSessionId]));
  // The provider sent no output transcript at all: the reply is receipted, never silent.
  assert.equal(rows.length, 0, 'the fake provider sent no transcript row');
  assert.equal(events.filter(entry => entry.event === 'live_reply_unjournalled').length, 1, 'the spoken reply is receipted');
});

test('L14: a tag split across two deltas is stripped from the assembled seed, and other brackets survive', async t => {
  const h = await harness(t);
  const { session } = await attached(h, 'split-tag');
  h.f.send({ serverContent: { inputTranscription: { text: 'meet at [10:30] and bring [DRAFT] plus [bre' } } });
  h.f.send({ serverContent: { inputTranscription: { text: 'ath] the folder', finished: true } } });
  await drain(h, session.liveSessionId, 3);
  const rows = h.store.transaction(tx => tx.all("SELECT text FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' ORDER BY journal_id", [session.liveSessionId]));
  const assembled = stripNonLexicalTags(rows.map(row => String(row['text'])).join(''));
  assert.equal(assembled.includes('[breath]'), false, 'the split tag never assembles into the text');
  assert.ok(assembled.includes('[10:30]') && assembled.includes('[DRAFT]'), 'other brackets are the owner\'s own');
});

test('R7: an owner who has already spoken keeps his own words as the last seed turn, so nothing repeats', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session } = await attached(h, 'drop-opener-spoken');
  h.f.send({ serverContent: { outputTranscription: { text: 'the answer that never reached her', finished: true } } });
  await drain(h, session.liveSessionId, 2);
  // The dead call's own last turn is the owner's words, so the seed never needs the helper line.
  h.f.send({ serverContent: { inputTranscription: { text: 'and the folder goes upstairs', finished: true } } });
  await drain(h, session.liveSessionId, 3);
  h.f.refuseUpgrades(401);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-spoken-resumption' }, goAway: { timeLeft: '10s' } });
  let settled = false;
  for (let i = 0; i < 90 && !settled; i++) {
    h.advance(1000); scheduler.runDue(); await tick();
    settled = h.owner.listFragments({ liveSessionId: session.liveSessionId }).fragments.some(row => row.kind === 'terminal');
  }
  assert.equal(settled, true, 'the dead call ended');
  const next = h.owner.create({ idempotencyKey: 'drop-opener-spoken-next', inputClass: 'ordinary' }, h.ctx);
  h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  await tick();
  const request = h.requests.at(-1)!;
  const history = request.history ?? [];
  assert.equal(history.at(-1)?.role, 'user', 'the owner has the last word in the seed');
  assert.ok(history.at(-1)!.text.includes('the folder goes upstairs'), 'and those are his words, not a canned line');
  assert.equal(history.some(turn => turn.text.includes('line dropped')), false, 'no helper line rides over his own turn');
  h.owner.revoke(next.liveSessionId);
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
  // #656: the frame is held across the rebuild instead of dropped, so nothing reaches the old session.
  assert.equal(h.f.frames.length, 3, 'capture during rebuilding is held for the new session');
  h.f.send({ setupComplete: {}, serverContent: { modelTurn: { parts: [audio()] } } });
  await continuity(output, 'resumed');
  const resumedAudio = await output.next();
  assert.equal(resumedAudio.value.kind, 'audio');
  // #656: the held capture reaches the new session once it is ready. Which opportunity delivers it is not the
  // claim, so the mic is allowed to speak again until it lands: every frame the owner sent reaches the adapter.
  for (let attempt = 0; attempt < 10 && h.f.frames.length < 4; attempt++) { attachment.sendAudio({ pcm }); await h.f.frame(4); }
  assert.ok(h.f.frames.length >= 4, 'the held capture reaches the new session');
  attachment.close(); const finalSnapshot = await attachment.done;
  let matching: Record<string, number | string>[] = [];
  for (let attempt = 0; attempt < 20 && matching.length === 0; attempt++) {
    await tick();
    matching = diagnosticLines.map(line => JSON.parse(line) as Record<string, number | string>)
      .filter(value => Number(value.ownerAudioCalls) >= 2 && value.ownerRebuildingDropCalls === 0);
  }
  assert.equal(matching.length, 1);
  const diagnostics = matching[0]!;
  const terminalCode = finalSnapshot.terminal && 'code' in finalSnapshot.terminal ? finalSnapshot.terminal.code : finalSnapshot.terminal?.state;
  assert.equal(diagnostics.event, 'live_session_diagnostics'); assert.equal(diagnostics.terminalCode, terminalCode);
  assert.equal(diagnostics.adapterGenerations, 2);
  assert.equal(diagnostics.ownerRebuildingDropCalls, 0); assert.equal(diagnostics.ownerRebuildingDropBytes, 0);
  // #656: nothing the owner said into the gap is lost, so every frame the owner sent reaches the adapter.
  assert.equal(diagnostics.adapterAudioCalls, diagnostics.ownerAudioCalls);
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


for (const status of [401, 403, 429]) test(`resumed HTTP upgrade refusal ${status} falls back to fresh then ends inside the 60 s budget`, async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const { session, attachment } = await attached(h, `resume-refused-${status}`);
  h.f.refuseUpgrades(status);
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-refused-resumption-secret' }, goAway: { timeLeft: '10s' } });
  // Drive the injected scheduler through the 0/2/4/8 s backoff until the 60 s episode budget settles it.
  let settled = false;
  for (let i = 0; i < 90 && !settled; i++) {
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
  assert.match(descriptions.get('mattermost_search')!, /author/);
  assert.match(descriptions.get('mattermost_search')!, /from_date.*to_date/);
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
  assert.match(descriptions.get('calendar_list_calendars')!, /Call it only when the owner asks which calendars exist; an event read needs no calendar list\./);
  assert.match(descriptions.get('calendar_list_events')!, /Omit both for today in the host timezone\./);
});



/** #451: the owner's first turn. Before it, a research start is opener work and reaches no source. */
async function ownerSpoke(h: Harness, text = 'synthetic owner turn'): Promise<void> {
  h.f.send({ serverContent: { inputTranscription: { text, finished: true } } });
  await settlePort();
}

/** The same first turn on the OpenAI-shaped port, which reports events instead of socket frames. */
async function ownerInput(fake: { emit(event: unknown): void }, text = 'synthetic owner turn'): Promise<void> {
  fake.emit({ type: 'inputTranscription', text, finished: true });
  await settlePort();
}








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
    { summary: 'Standup', start: { dateTime: '2024-01-01T09:00:00Z' }, htmlLink: 'https://www.google.com/calendar/event?eid=e1' },
    { start: { dateTime: '2024-01-02T09:00:00Z' }, htmlLink: 'https://www.google.com/calendar/event?eid=e2' },
  ] });
  assert.equal(/https?:\/\//.test(calendar.text), false, 'calendar model text carries no raw url');
  assert.equal(calendar.text.includes('source:'), false);
  assert.deepEqual(calendar.sources, [
    { title: 'Calendar: Standup', url: 'https://www.google.com/calendar/event?eid=e1', sourceType: 'calendar' },
    { title: 'Open in Google Calendar', url: 'https://www.google.com/calendar/event?eid=e2', sourceType: 'calendar' },
  ]);
  const mail = shapeGmailList({ messages: [
    { id: 'm1', snippet: 'hello', labelIds: [], headers: { Subject: 'Budget' } },
  ] });
  assert.equal(/https?:\/\//.test(mail.text), false, 'gmail model text carries no raw url');
  assert.deepEqual(mail.sources, [{ title: 'Gmail: Budget', url: 'https://mail.google.com/mail/u/0/#all/m1', sourceType: 'gmail' }]);
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
test('a finalized request produces one task answer without a provider tool batch', async t => {
  const p = progressPort(), finish = deferred<void>(); let inferences = 0;
  const h = await harness(t, { port: p.port, provider: 'openai', taskInfer: async () => {
    inferences++; await finish.promise; return { text: 'Synthetic records were checked.', calls: [] };
  } });
  const { attachment } = await openPort(h, 'helper-answer');
  consumeTaskPort(t, attachment);
  p.emit({ type: 'inputTranscription', text: 'Check the synthetic records', finished: true, finalOrigin: 'provider' });
  await settlePort();
  assert.equal(inferences, 1); assert.equal(p.taskAnswers.length, 0, 'work starts before a binding but cannot speak there');
  p.emit({ type: 'delegation', delegationId: 'binding-answer' });
  await settlePort(); finish.resolve(); await settlePort();
  assert.equal(inferences, 1, 'a provider delegation attaches to current work, not a second inference');
  assert.equal(p.taskAnswers.length, 1);
  assert.equal(p.taskAnswers[0]?.delegationId, 'binding-answer');
  assert.equal(p.taskAnswers[0]?.text, 'Synthetic records were checked.');
  assert.equal(p.toolResponses.length, 0, 'client mode has no function-call output carrier');
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







// #651: a chat read the connector refused for a channel it does not know keeps its own closed code
// through the live research hop, so the reply names the channel instead of an unreachable source.




// #669: a named channel the connector does not know voices up to three closest names, so the owner hears the
// channel she probably meant instead of only hearing that the name is unknown.


// #669 F1: the real child declares query and types, so its own ranked list answers a miss with no rows; the
// refusal still has to voice the three closest names from the channel index.


// #651 FAILREASON-R1: a read the connector cut at its own budget is said as a timeout, never as a source
// that failed for no stated reason, so the owner hears why nothing came back.




// R9: a research call refused at dispatch never reaches the research tool, so before this receipt it left no
// run line at all and a refused lookup read as a silent no-op in host.log.








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

/** Session memory v1: a summary is injectable only from a recorded history session with matching provenance. */
function seedSummary(tx: Parameters<typeof summaries.insertSummary>[0], liveSessionId: string, summary: string, endedAt: number, ownerId: string, now: number,
  openLoop?: string): void {
  recordHistorySession(tx, liveSessionId, ownerId, ['ordinary'], [], now);
  summaries.insertSummary(tx, { liveSessionId, status: 'complete', summary, endedAt, now, dataClass: 'ordinary', sourceRevision: 1,
    ...(openLoop === undefined ? {} : { openLoop }) });
}

test('the earlier-conversations section fills the space under the target in a real session', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const h = await harness(t);
  h.store.transaction(tx => {
    for (let i = 0; i < 20; i++) seedSummary(tx, `synthetic-past-${String(i).padStart(2, '0')}`,
      `Synthetic past conversation ${i} about the Mongoose mint delivery window and the Friday schedule.`, NOW - i * 3_600_000, h.store.assistantId, NOW);
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

test('C-CONVO9: earlier openers carry only closed topic classes, never sentences or free text', () => {
  assert.equal(openersNote([]), undefined);
  const note = openersNote(['Morning. The synthetic branch merged.', 'My tools failed again.'], ['the synthetic branch merge', 'tool_failure']);
  assert.ok(note);
  assert.doesNotMatch(note, /Morning|synthetic|My tools|branch merge/);
  assert.match(note, /tool_failure/);
  assert.ok(note.length <= OPENER_CONTEXT_CHARS);
});

test('3u: consecutive starts offer different stored open loops and record the plan as metadata', async t => {
  const h = await harness(t);
  // O1b-A removed the debug journal, so the plan receipt is a host log line, one per start, and the
  // sink keeps them in start order.
  const plans: Record<string, unknown>[] = [];
  const detachPlanSink = attachHostLogSink({ event: raw => { const record = raw as Record<string, unknown>; if (record['event'] === 'opener_plan') plans.push(record); } });
  t.after(() => detachPlanSink());
  h.store.transaction(tx => {
    seedSummary(tx, 'synthetic-shared-loop', 'The owner said the tax form is still to be filed.', NOW - 3_600_000, h.store.assistantId, NOW,
      'The owner said the tax form is still to be filed.');
    seedSummary(tx, 'synthetic-accountant-loop', 'The owner said he still has to call the accountant.', NOW - 7_200_000, h.store.assistantId, NOW,
      'The owner said he still has to call the accountant.');
  });
  const snapshot = (liveSessionId: string): string => {
    const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [liveSessionId]))!;
    return (JSON.parse(String(row['accepted_prompt_snapshot'])) as { system: string }).system;
  };
  const first = h.owner.create({ idempotencyKey: 'opener-rotation-1', inputClass: 'ordinary' }, h.ctx);
  // W5-R2: a start inside the 12 h cooldown after an offered open loop offers the kind not at all, so the second
  // start is placed past it; the rotation still walks the stored loops, which is what this test is about.
  h.advance(13 * 3_600_000);
  const second = h.owner.create({ idempotencyKey: 'opener-rotation-2', inputClass: 'ordinary' }, h.ctx);
  const loops = [first, second].map(session => /^- open loop: (.+)$/mu.exec(snapshot(session.liveSessionId))?.[1]);
  assert.ok(loops[0] !== undefined && loops[1] !== undefined, 'both starts compose an open loop from the stored column');
  assert.notEqual(loops[0], loops[1], `consecutive starts offer different loops (${loops.join(' / ')})`);
  assert.ok(snapshot(first.liveSessionId).includes('# Opening options'), 'the plan is one section of the instruction');
  assert.equal(plans.length, 2, 'each start records its own plan');
  assert.deepEqual(plans.map(plan => Object.keys(plan).sort().join(',')), ['event,kinds,rotation', 'event,kinds,rotation'], 'the receipt carries kinds and rotation only');
  assert.deepEqual(plans.map(plan => plan['kinds']), [['recent-thread', 'open-loop'], ['recent-thread', 'open-loop']],
    'the newest call leads, the empty calendar offers no calendar kind');
  assert.equal((plans[0]!['rotation'] as number) + 1, plans[1]!['rotation'], 'the persisted start counter advances by one');
});

// Release 7 W5: the loop renewal. A call that opens on a stored loop gets a summary that stores the same loop
// again, so before this rule the next call opened on it once more, call after call. The plan each start recorded is
// the record, so a loop a previous plan offered is not offered as an opener again; it stays in the earlier
// conversations as context and only the owner raises it.
test('W5: a stored open loop a previous call opened on is not offered again', async t => {
  const h = await harness(t);
  const loop = 'The owner said the company website lookup is still to be done.';
  h.store.transaction(tx => seedSummary(tx, 'synthetic-loop-source', loop, NOW - 3_600_000, h.store.assistantId, NOW, loop));
  const snapshot = (liveSessionId: string): string => {
    const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [liveSessionId]))!;
    return (JSON.parse(String(row['accepted_prompt_snapshot'])) as { system: string }).system;
  };
  const first = h.owner.create({ idempotencyKey: 'opener-once-1', inputClass: 'ordinary' }, h.ctx);
  assert.match(snapshot(first.liveSessionId), /^- open loop: the company website lookup is still to be done /mu,
    'the first call opens on the stored loop');
  // The call that opened on it ends and its own summary stores the same loop again: the renewal.
  h.store.transaction(tx => {
    tx.run('DELETE FROM conversation_summaries WHERE live_session_id=?', [first.liveSessionId]);
    summaries.insertSummary(tx, { liveSessionId: first.liveSessionId, status: 'complete', summary: loop, endedAt: NOW - 60_000, now: NOW, openLoop: loop });
  });
  const second = h.owner.create({ idempotencyKey: 'opener-once-2', inputClass: 'ordinary' }, h.ctx);
  assert.equal(/^- open loop:/mu.test(snapshot(second.liveSessionId)), false, 'the loop a previous call opened on is not offered again');
});

// W5-R2 (master review): the distillation re-words the loop between calls, so "website lookup for Acmeworks" comes
// back as "find the Acmeworks homepage" and the exact-topic rule alone cannot see the same loop twice. A call whose
// plan offered any open-loop option therefore starts no other call on one for 12 hours; other kinds are untouched.
test('W5-R2: a call that offered an open loop cools every open-loop opener for 12 hours', async t => {
  const h = await harness(t);
  const first = 'The owner said the Acmeworks website lookup is still to be done.';
  h.store.transaction(tx => seedSummary(tx, 'synthetic-cooldown-source', first, NOW - 3_600_000, h.store.assistantId, NOW, first));
  const snapshot = (liveSessionId: string): string => {
    const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [liveSessionId]))!;
    return (JSON.parse(String(row['accepted_prompt_snapshot'])) as { system: string }).system;
  };
  const call1 = h.owner.create({ idempotencyKey: 'cooldown-1', inputClass: 'ordinary' }, h.ctx);
  assert.match(snapshot(call1.liveSessionId), /^- open loop: /mu, 'the first call offers the stored loop');
  // t = 20 min: the call that opened on it ends and its summary stores the same loop in other words.
  h.advance(20 * 60_000);
  const reworded = 'The owner said he still has to find the Acmeworks homepage.';
  h.store.transaction(tx => {
    tx.run('DELETE FROM conversation_summaries WHERE live_session_id=?', [call1.liveSessionId]);
    summaries.insertSummary(tx, { liveSessionId: call1.liveSessionId, status: 'complete', summary: reworded, endedAt: NOW + 20 * 60_000 - 60_000, now: NOW + 20 * 60_000, openLoop: reworded });
  });
  const call2 = h.owner.create({ idempotencyKey: 'cooldown-2', inputClass: 'ordinary' }, h.ctx);
  assert.equal(/^- open loop:/mu.test(snapshot(call2.liveSessionId)), false, 'inside the cooldown the re-worded loop is not offered');
  // t = 13 h: the cooldown is over, so a stored loop is an opener again.
  h.advance(13 * 3_600_000 - 20 * 60_000);
  h.store.transaction(tx => seedSummary(tx, 'synthetic-cooldown-later', 'The owner said the Acmeworks invoice is still to be sent.',
    NOW + 13 * 3_600_000 - 3_600_000, h.store.assistantId, NOW + 13 * 3_600_000));
  const call3 = h.owner.create({ idempotencyKey: 'cooldown-3', inputClass: 'ordinary' }, h.ctx);
  assert.match(snapshot(call3.liveSessionId), /^- open loop: /mu, 'past the cooldown a stored loop is offered again');
});

test('1023-N8: a start right after a call that just ended names his last topic while the summary is pending', async t => {
  const h = await harness(t);
  const first = await attached(h, 'pending-summary-1');
  h.f.send({ serverContent: { inputTranscription: { text: 'Fine. The Mongoose mint delivery window moves to Friday. Nothing else.', finished: true } } });
  await drain(h, first.session.liveSessionId, 2);
  assert.match(h.store.transaction(tx => tx.all("SELECT text FROM live_journal WHERE live_session_id=? AND kind='inputTranscription'", [first.session.liveSessionId])
    .map(row => String(row['text'] ?? '')).join('')), /Mongoose/, 'the owner words reached the journal before the call ended');
  h.owner.revoke(first.session.liveSessionId);
  await first.attachment.done;
  h.store.transaction(tx => {
    tx.run('DELETE FROM conversation_summaries WHERE live_session_id=?', [first.session.liveSessionId]);
  });
  const second = h.owner.create({ idempotencyKey: 'pending-summary-2', inputClass: 'ordinary' }, h.ctx);
  const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [second.liveSessionId]))!;
  const system = (JSON.parse(String(row['accepted_prompt_snapshot'])) as { system: string }).system;
  assert.match(system, /^- recent thread: The Mongoose mint delivery window moves to Friday$/mu,
    'the call that just ended supplies the subject, so the next line does not fall back to the calendar');
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
  assert.equal(text.includes('Morning. The release branch merged cleanly last night.'), false, 'earlier sentences never enter the instruction');
  assert.equal(text.includes('A trailing line'), false, 'a fragment after the finished fragment is not carried');
  assert.equal(text.split('Earlier opener topic classes').length - 1, 1, 'the context appears once');
});

test('composeLive uses client delegation and keeps worker procedure out of both voice sessions', async t => {
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
  assert.deepEqual(start.session['delegation'], { type: 'client' }, 'the helper owns inference, not a provider responses backend');
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

// #538: a tool turn's silence is the audible debt clock's, and the watchdog reports only the rebuild it runs.
const audibleFrame = { type: 'audio', pcm: new Uint8Array(4_800), rate: 24_000, audible: true, rmsDbfs: -14 } as const;
/** The fixture port forwards any port event; its declared union predates tool calls and the silence model. */
const portEvent = (event: unknown) => event as never;
const settlePort = async (): Promise<void> => { for (let i = 0; i < 12; i++) await tick(); };







// L8-11/L11-06: the owner talked over her answer three times while she kept speaking, and the store held no
// receipt of it. gpt-live-1 owns barge-in and the host never cuts her (lux 90488, ruling W1-R1), so the host
// records the overlap as a content-free receipt: counts only, and whether output was cut (never, here).
test('L8-11: owner words over her audible answer leave one content-free overlap receipt per owner turn', async t => {
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'overlap-receipt', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(audibleFrame);
  await settlePort();
  fake.emit(portEvent({ type: 'inputTranscription', text: 'Synthetic', finished: false }));
  await settlePort();
  const rows = (): Record<string, unknown>[] => h.store.transaction(tx => tx.all(
    "SELECT turn_id, detail FROM trace_event WHERE live_session_id=? AND kind='owner.overlap' ORDER BY seq", [session.liveSessionId]));
  assert.equal(rows().length, 0, 'one word over her is not yet an overlap');
  fake.emit(audibleFrame);
  fake.emit(portEvent({ type: 'inputTranscription', text: ' overlap words here', finished: false }));
  await settlePort();
  fake.emit(portEvent({ type: 'inputTranscription', text: ' you', finished: false }));
  await settlePort();
  const seen = rows();
  assert.equal(seen.length, 1, 'two owner words while she is audible write one receipt for the turn');
  const detail = JSON.parse(String(seen[0]!['detail'])) as Record<string, unknown>;
  assert.deepEqual(Object.keys(detail).sort(), ['at', 'cut', 'msSinceAudible', 'words'], 'a time, counts and a flag, never text');
  assert.ok(Number(detail['words']) >= 2, `the receipt counts the words: ${JSON.stringify(detail)}`);
  assert.equal(detail['cut'], false, 'the host cut nothing (ruling W1-R1)');
  assert.ok(typeof seen[0]!['turn_id'] === 'string', 'the receipt belongs to the owner turn');
  assert.equal(JSON.stringify(seen).includes('overlap words'), false, 'no owner word reaches the metadata row');
  attachment.close(); await attachment.done.catch(() => undefined);
});

// L8-Q01/Q05/Q06: a research call with a web read left trace_call unlinked, its question and run id
// nowhere, and the web read with no row at all.








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
  const taskAnswers: { delegationId: string; text: string; commandId: string }[] = [];
  const thinking: string[] = [];
  /** W4: whether the transport can carry a commentary at all, which the real adapter answers per delegation. */
  let commentaryDelivered = true;
  /** Every text input the host pushed: the OpenAI path must never send the `Continue.` user turn (review F2). */
  const texts: string[] = [];
  /** #660: every text input tagged with the provider session that received it, and how often one was refused. */
  const textInputs: { session: number; text: string }[] = [];
  let textRefusals = 0;
  let refuseText = 0;
  /** #660: every request the host asked for, so a test can read the opening the fresh session was given. */
  const requests: LiveVoiceRequest[] = [];
  const toolResponses: LiveToolResponse[][] = [];
  /** #656: every owner frame the host handed a provider session, tagged with which session received it. */
  const audioInput: { session: number; pcm: Uint8Array }[] = [];
  let emit: (event: unknown) => void = () => {};
  let sessionsOpened = 0;
  /** #656: a rebuild held half open, so the owner audio that arrives between the close and the new ready is seen. */
  let readyGate: Promise<void> | undefined;
  let releaseReady: () => void = () => {};
  /** #538: what the adapter reports back for the next tool answer, so a failed write can be driven here. */
  let sendOutcome: LiveToolSendOutcome = 'sent';
  let closes = 0;
  const port: LiveVoicePort = {
    capabilities: { ...fakeLiveVoicePort().port.capabilities, provider: 'openai', supportsResumption: true },
    open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      sessionsOpened += 1;
      requests.push(request);
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
      // #660/B2: readiness follows the ready event, so a held gate holds `session.ready` exactly as the adapter does.
      let readyResolve: () => void = () => {};
      const ready = new Promise<void>(resolve => { readyResolve = resolve; });
      const events: AsyncIterable<LiveVoiceEvent> = {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (!readySeen) {
              readySeen = true;
              const gate = readyGate;
              if (gate !== undefined) await gate;
              yield { sequence: ++sequence, type: 'ready' };
              readyResolve();
              continue;
            }
            if (!pending.length) { await new Promise<void>(resolve => { waiter = resolve; }); continue; }
            yield pending.shift()!;
          }
        },
      };
      return {
        ready, events, done,
        sendToolResponse(input: { responses: LiveToolResponse[] }): LiveToolSendOutcome { toolResponses.push(input.responses); return sendOutcome; },
        sendAudio(input: { pcm: Uint8Array }): void { audioInput.push({ session: sessionsOpened, pcm: input.pcm }); },
        sendText(input: { text: string }): void {
          // #660: a fresh session answers not_ready before its ready event, exactly as the adapter does.
          if (refuseText > 0) { refuseText -= 1; textRefusals += 1; throw new Error('not_ready'); }
          texts.push(input.text); textInputs.push({ session: sessionsOpened, text: input.text });
        }, endAudioStream(): void {},
        sendTaskAnswer(input: { text: string; delegationId: string }): string | undefined {
          if (!commentaryDelivered || closed) return undefined;
          const commandId = `synthetic-commentary-${taskAnswers.length + 1}`;
          taskAnswers.push({ ...input, commandId }); commentary.push(input.text); return commandId;
        },
        sendCommentary(input: { text: string }): boolean {
          if (!commentaryDelivered) return false;
          commentary.push(input.text);
          return true;
        },
        close(): void { if (closed) return; closed = true; closes += 1; readyResolve(); wake(); resolveDone({ status: 'closed', code: 'closed' }); },
      };
    },
  };
  return { port, commentary, taskAnswers, thinking, texts, textInputs, requests, toolResponses, audioInput, emit: (event: unknown) => emit(event),
    /** #660: the next text inputs meet a session that is not ready; one retry is all the host gives. */
    refuseText: (times = 1) => { refuseText = times; },
    refuseTextOnce: () => { refuseText = 1; },
    get textRefusals() { return textRefusals; },
    /** #656: hold the next rebuilt session short of ready; the returned release lets it open. */
    holdNextReady: () => {
      const gate = new Promise<void>(resolve => { releaseReady = resolve; });
      readyGate = gate;
      return () => { readyGate = undefined; releaseReady(); };
    },
    /** #538: what the next tool answer reports, and how many provider sessions the host closed. */
    reportToolSend: (outcome: LiveToolSendOutcome) => { sendOutcome = outcome; },
    get closes() { return closes; },
    /** W4: a transport with no open delegation refuses the append, exactly as the GPT-Live wire does. */
    refuseCommentary: () => { commentaryDelivered = false; },
    get sessionsOpened() { return sessionsOpened; } };
}

const openaiLimits = { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 };








// --- W4: no long silence while a call is in flight ------------------------------------------------







// --- R6: late findings reach the voice model, and are spoken only on a quiet turn -----------------




// #472 at the drop point the reviewer named: a run the model has closed is no longer "current", and base
// dropped its late result at index.ts:2379 before the delivery authority was ever asked. The reader returns
// lines after the stop, so the model must receive them.


// #472: the delivery half. A source that lands after the first answer must reach the model through the
// later-findings path while the session is live, and a calendar answer supplies the first answer here so
// the assertion stands on a source the base suite serves (the memory-backed R6 cases are base-red).





































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
// C-LOGS11: the native audibility receipt is the only proof the owner could hear her, so the turn's first one
// closes the wait from his final words. One turn logs one measurement, and a turn with no final says so.
test('C-LOGS11: the first audible receipt logs the owner-final-to-audible wait once per turn', async t => {
  const h = await harness(t);
  const logged: Record<string, unknown>[] = [];
  const detachSink = attachHostLogSink({ event: raw => { const record = raw as Record<string, unknown>; if (record['event'] === 'live_first_audible') logged.push(record); } });
  t.after(() => detachSink());
  const { session, attachment } = await attached(h, 'audible-latency');
  const frame = (receipt: string, seq: number): string =>
    JSON.stringify({ type: 'playback_receipt', receipt, segment_seq: 1, source_instance_id: 'inst-lat', source_seq: seq,
      mono_ms: 900 + seq, wall_ms: 1_700_000_000_000 + seq });
  // The owner's final opens the turn, so the turn's first audibility receipt has an anchor to measure from.
  h.f.send({ serverContent: { inputTranscription: { text: 'Synthetic owner words on this call.', finished: true } } });
  await settlePort();
  attachment.playbackReceipt(frame('received', 1));
  attachment.playbackReceipt(frame('audible', 2));
  await settlePort();
  assert.equal(logged.length, 1, 'the turn logs one measurement');
  assert.equal(typeof logged[0]!['finalToAudibleMs'], 'number');
  assert.equal(logged[0]!['missingReason'], null);
  // A second segment of the same turn is not a second measurement.
  attachment.playbackReceipt(frame('audible', 3));
  await settlePort();
  assert.equal(logged.length, 1);
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'a receipt never ends the call');
  attachment.close();
  await attachment.done;
});



for (const failureCode of ['backend_unavailable', 'provider_error'] as const) test(`S5: ${failureCode} settles typed, says one honest line, and is never rebuilt`, async t => {
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  t.after(() => sink());
  const scheduler = new DeadlineClock();
  const fake = progressPort();
  const h = await harness(t, { provider: 'openai', model: 'gpt-live-1', port: fake.port, tools: true, scheduler, limits: openaiLimits });
  const { session } = await openPort(h, 'failed-turn');
  fake.emit({ type: 'turnFailed', code: failureCode });
  await settlePort();
  // The typed disposition is immediate and metadata only.
  assert.deepEqual(receipts.filter(entry => entry['event'] === 'turn_failed'), [{ event: 'turn_failed', reason: 'provider_error' }],
    'the reason comes from the closed set; the provider word stays in the adapter receipt');
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



// L2-R1: live_journal keeps its fragments and its empty closing row, so every concatenating reader is
// unchanged; the audit row is where the assembled utterance belongs, and it answers "what was said".
test('C-LOG-ENVELOPE: the closing utterance row carries the whole sentence, once', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'envelope-utterance', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'inputTranscription', text: 'what is on', finished: false }));
  fake.emit(portEvent({ type: 'inputTranscription', text: ' my plate', finished: false }));
  await settlePort();
  fake.emit(portEvent({ type: 'inputTranscription', text: '', finished: true }));
  fake.emit(portEvent({ type: 'outputTranscription', text: 'nothing is on', finished: false }));
  fake.emit(portEvent({ type: 'outputTranscription', text: ' your plate.', finished: false }));
  fake.emit(portEvent(audibleFrame));
  fake.emit(portEvent({ type: 'outputTranscription', text: '', finished: true }));
  fake.emit(portEvent({ type: 'turnComplete' }));
  await settlePort();
  const turnId = String(h.store.transaction(tx => tx.get('SELECT turn_id FROM trace_turn WHERE live_session_id=?', [session.liveSessionId]))!['turn_id']);
  const finals = h.store.transaction(tx => tx.all('SELECT role, text FROM trace_utterance WHERE turn_id=? AND final=1 ORDER BY at, rowid', [turnId]));
  assert.deepEqual(finals.map(row => row['role']), ['owner', 'model']);
  assert.deepEqual(finals.map(row => row['text']), ['what is on my plate', 'nothing is on your plate.']);
  // The journal itself did not change shape: fragments, then an empty closing row per kind.
  const journal = h.store.transaction(tx => tx.all("SELECT text, finished FROM live_journal WHERE live_session_id=? AND kind LIKE '%Transcription' ORDER BY journal_id", [session.liveSessionId]));
  const closing = journal.filter(row => Number(row['finished']) === 1);
  assert.deepEqual(closing.map(row => row['text']), ['', ''], 'the closing journal rows stay empty');
  // A concatenating reader still sees the utterance exactly once.
  const transcript = h.store.transaction(tx => readSessionTranscript(tx, session.liveSessionId));
  assert.deepEqual(transcript.turns.map(turn => [turn.speaker, turn.text]),
    [['owner', 'what is on my plate'], ['assistant', 'nothing is on your plate.']]);
  attachment.close();
});

// The dead-air stall the watchdog sees is projected onto the open turn (stall_reason no_audible_output) and the
// typed GAP a stalled turn prints are covered by trace.test.ts, which drives the store directly; the watchdog's
// own nudge path is exercised by the D3 tests above.







































// W1-R4: a reader follows pageCursor for the rest of a page and the reply's own nextCursor for the rest of the
// body. The reply's own canContinue is copied unchanged onto every page, so it alone can never end a loop; a
// continuation this reader already used is the other end.

















// C-CONTINUITY T-11: with every research reply capped at 3,000 characters, a 16,800-character body costs more
// replies than it used to, and every character still arrives exactly once.





for (const {} of ['mail', 'calendar'] as const) 








test('W6/H12: a second owner utterance closes the open turn as superseded and names it on the next', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'supersede-turn');
  // An utterance opens a turn; the finished frame ends that utterance, not the turn, because the
  // provider has not sent turnComplete yet. The next utterance therefore arrives while it is open.
  const baseline = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { inputTranscription: { text: 'first question' } } });
  await drain(h, session.liveSessionId, baseline + 1);
  h.f.send({ serverContent: { inputTranscription: { text: '', finished: true } } });
  h.f.send({ serverContent: { inputTranscription: { text: 'second question' } } });
  await drain(h, session.liveSessionId, baseline + 3);
  const turns = h.store.transaction(tx => tx.all(
    'SELECT turn_id, turn_index, closed_at, close_reason, supersedes_turn_id FROM trace_turn WHERE live_session_id=? ORDER BY turn_index',
    [session.liveSessionId]));
  assert.equal(turns.length, 2, 'the second utterance is its own turn');
  assert.equal(turns[0]!['close_reason'], 'superseded', 'the replaced turn is closed, never orphaned open');
  assert.ok(turns[0]!['closed_at'] !== null);
  assert.equal(turns[1]!['supersedes_turn_id'], turns[0]!['turn_id'], 'the new turn names the one it replaced');
  assert.equal(turns[1]!['closed_at'], null, 'the new turn stays open until its own close');
  attachment.close();
  await attachment.done;
});

test('W6/H12: a session that ends closes its last turn, so no normal turn is left open', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'session-end-turn');
  const baseline = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { inputTranscription: { text: 'only question' } } });
  await drain(h, session.liveSessionId, baseline + 1);
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
  const turns = h.store.transaction(tx => tx.all('SELECT close_reason, closed_at FROM trace_turn WHERE live_session_id=?', [session.liveSessionId]));
  assert.deepEqual(turns.map(turn => [turn['close_reason'], turn['closed_at'] !== null]), [['session_end', true]]);
});

test('W6/H13: a playback receipt names the turn and the response open when its first chunk went out', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'playback-attribution');
  const baseline = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { inputTranscription: { text: 'how long was that call' } } });
  await drain(h, session.liveSessionId, baseline + 1);
  const open = h.store.transaction(tx => tx.get('SELECT turn_id FROM trace_turn WHERE live_session_id=? AND closed_at IS NULL', [session.liveSessionId]))!;
  const turnId = String(open['turn_id']);
  const responseKey = scopedTraceKey(session.liveSessionId, 'e0', 'response', 'resp-fixture');
  record(h.store, 'response.created', { liveSessionId: session.liveSessionId, connectionEpoch: 'e0', turnId, responseKey },
    { createdAt: 1_700_000_000_000, status: 'streaming', providerResponseId: 'resp-fixture' });
  const frame = (receipt: string, seq: number): string =>
    JSON.stringify({ type: 'playback_receipt', receipt, segment_seq: 1, source_instance_id: 'inst-e2', source_seq: seq,
      mono_ms: 900 + seq, wall_ms: 1_700_000_000_000 + seq });
  attachment.playbackReceipt(frame('received', 1));
  attachment.playbackReceipt(frame('enqueued', 2));
  attachment.playbackReceipt(frame('started', 3));
  const row = h.store.transaction(tx => tx.get('SELECT turn_id, response_key, received_at FROM trace_playback WHERE playback_key=?', [`${session.liveSessionId}:inst-e2:1`]))!;
  assert.equal(row['turn_id'], turnId, 'the segment is tied to the turn that was open when its first chunk was sent');
  assert.equal(row['response_key'], responseKey, 'and to the response that was current then');
  attachment.close();
  await attachment.done;
});

test('W6/H13: a segment keeps the turn it started in even when its later receipts land after the close', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'playback-late-receipts');
  const baseline = h.owner.get(session.liveSessionId).journal.events;
  h.f.send({ serverContent: { inputTranscription: { text: 'first question' } } });
  await drain(h, session.liveSessionId, baseline + 1);
  const first = String(h.store.transaction(tx => tx.get('SELECT turn_id FROM trace_turn WHERE live_session_id=? AND closed_at IS NULL', [session.liveSessionId]))!['turn_id']);
  const frame = (receipt: string, seq: number): string =>
    JSON.stringify({ type: 'playback_receipt', receipt, segment_seq: 1, source_instance_id: 'inst-late', source_seq: seq,
      mono_ms: 900 + seq, wall_ms: 1_700_000_000_000 + seq });
  // The first receipt names the turn the segment opened in; the rest land after that turn closes.
  attachment.playbackReceipt(frame('enqueued', 1));
  h.f.send({ serverContent: { inputTranscription: { text: 'second question' } } });
  await drain(h, session.liveSessionId, baseline + 2);
  attachment.playbackReceipt(frame('received', 2));
  attachment.playbackReceipt(frame('started', 3));
  const row = h.store.transaction(tx => tx.get('SELECT turn_id FROM trace_playback WHERE playback_key=?', [`${session.liveSessionId}:inst-late:1`]))!;
  assert.equal(row['turn_id'], first, 'the segment stays with the turn it started in, not the turn open when the row was written');
  attachment.close();
  await attachment.done;
});



test('W6/Q8: one status definition, so an error result is the only thing the journal calls error', () => {
  assert.equal(journalToolStatus({ error: 'tool_result_denied' }), 'error',
    'an error result is an error status');
  assert.equal(journalToolStatus({ error: 'continuation_unavailable', researchId: 'r1', findings: [], canContinue: false }), 'error',
    'a reply that names a failure is a failure, whatever else it carries');
  assert.equal(journalToolStatus({ status: 'partial', researchId: 'r1', findings: [{ text: 'a source answered' }] }), 'completed',
    'a reply that carries an answer is completed: error is never inferred from anywhere else');
});







test('MUTE: the owner who speaks right after the unmute gets no held answer offered over him', async t => {
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const texts: string[] = [];
  const port = {
    capabilities: fake.port.capabilities,
    open: (liveRequest: Parameters<LiveVoicePort['open']>[0], liveControl: Parameters<LiveVoicePort['open']>[1]) => {
      const opened = fake.port.open(liveRequest, liveControl);
      return { ...opened, sendText: (input: { text: string }) => { texts.push(input.text); } } as unknown as LiveVoiceSession;
    },
  } as LiveVoicePort;
  const h = await harness(t, { port, scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'mute-held-answer-spoken', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;

  attachment.setInputMuted(true);
  fake.emit(portEvent(audibleFrame));
  await settlePort();
  attachment.setInputMuted(false);
  await settlePort();
  scheduler.now += 500; scheduler.runDue(); await settlePort();
  fake.emit(portEvent({ type: 'inputTranscription', text: 'one more thing first', finished: true }));
  await settlePort();
  scheduler.now += 3_000; scheduler.runDue(); await settlePort();
  assert.deepEqual(texts, [], 'the owner spoke first, so no held answer is offered over him');
  attachment.close();
  await attachment.done;
});

// C-TURN8: on 10-28 a trello read and a research start ran 0.7 s into a call, before the owner said
// anything. Research was refused; every other owner-data tool went as far as its argument check.


// F1: on 10-30 the model called mattermost_chat twice before the owner's first word, because the gate held
// intent names (chat, mail, ...) and not the names of the tools it actually calls. Every connector family is
// covered by its registry class now, and the same call is admitted once he has spoken.


// C-TURN8: a save is owner data too, so the same gate answers it before he has spoken, rather than letting
// it reach the note or vault gates that name a different cause.


// C-CLAIMS9 outcome 1: the announcement is a class of first-person lookup promises, not a list of exact
// sentences. Every positive was said on the 10-28 call or belonged to the old list; every negative is a
// sentence that promises no lookup of her own.
test('C-CLAIMS9: a first-person lookup announcement is recognised by its class', () => {
  for (const said of [
    'Let me look into that.',
    "I'll try that.",
    'Let me look into it.',
    "I'll look into it.",
    'Give me a moment to check.',
    "I'll find out.",
    'Let me find that.',
    'Let me see what I can find.',
    'Yeah, I am checking on that now.',
    "I'm going to search the thread.",
    'Let me pull up the thread.',
    "I'm digging through the archive.",
    'I will see what the calendar says.',
    'Let me check that.',
    'I am looking into it.',
    'Working on that now.',
    // F1: the base detector tolerated a missing apostrophe, and a voice transcript may carry the typographic one.
    'Im checking on that now.',
    'ill check that.',
    'I\u2019ll look into it.',
    'I\u2019m going to search the thread.',
    // W3-R2/W3-R1: the ruling names the "let's" form in every spelling.
    "Let's check that.",
    'Let\u2019s look into it.',
    'lets check the thread.',
  ]) assert.equal(announcesLookup(said), true, `an announced lookup: ${said}`);
  for (const said of [
    'I checked the calendar at nine.',
    'You can check that in the app.',
    'Let me know when you want it.',
    'I will see you at six.',
    "I'm trying to explain what changed.",
    'She is checking the archive.',
    'Nothing in the archive matched.',
    'Checked, and there is nothing there.',
  ]) assert.equal(announcesLookup(said), false, `no lookup announced: ${said}`);
});

// C-TURN8: three times on 10-28 she said she was checking and no call followed. The host gives the call
// one beat (CLAIM_WITHOUT_CALL_MS) and then says so once, inside the owner's turn.
// C-ARGS: a lookup the host refused executed nothing, so a claim that its result came back empty is a
// claim about a read that never ran, and the existing claim guard corrects it once, in its own words.





for (const progress of ['Checking.', 'On it.', 'One sec.']) test(`C-TURN8: ${progress} with no call gets exactly one correction, and only once per owner turn`, async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-claim-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const { session } = await attached(h, 'claim-without-call');
  const advance = async (ms: number): Promise<void> => { h.advance(ms); scheduler.runDue(); await settlePort(); };
  const corrections = () => h.f.frames.filter(frame => {
    const text = (frame as { realtimeInput?: { text?: string } }).realtimeInput?.text;
    return typeof text === 'string' && text.startsWith('[host note, not the owner] Correction:');
  });
  const counted = () => readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').split('\n').filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as { event: string; ms?: number }).filter(line => line.event === 'live_claim_without_call');
  const armed = (): boolean => [...scheduler.pending].some(entry => entry.due === scheduler.now + 3_000);
  const turnOpen = (): boolean => h.owner.current().entries.some(entry => entry.kind === 'inputTranscription');
  h.f.send({ serverContent: { inputTranscription: { text: 'what did Priya send me about the synthetic contract', finished: true } } });
  for (let attempt = 0; attempt < 200 && !turnOpen(); attempt++) await tick();
  assert.ok(turnOpen(), 'the owner turn is open before she answers it');
  h.f.send({ serverContent: { outputTranscription: { text: progress, finished: true }, turnComplete: true } });
  for (let attempt = 0; attempt < 300 && !armed(); attempt++) await tick();
  assert.ok(armed(), 'the announced lookup armed its three-second bound');
  await advance(2_000);
  assert.equal(corrections().length, 0, 'nothing is said before the bound has passed');
  assert.deepEqual(counted(), [], 'and nothing is logged yet');
  await advance(1_000);
  assert.deepEqual(counted().map(line => line.ms), [3_000], 'the claim is counted with its bound');
  assert.equal(corrections().length, 1, 'exactly one correction for the announcement');
  assert.match((corrections()[0] as { realtimeInput: { text: string } }).realtimeInput.text, /say plainly that you are not checking anything/);
  h.f.send({ serverContent: { outputTranscription: { text: "I'm checking that again now.", finished: true }, turnComplete: true } });
  const againSaid = (): boolean => h.owner.current().entries.some(entry => entry.kind === 'outputTranscription'
    && String((entry as { text?: string }).text ?? '').includes('again'));
  for (let attempt = 0; attempt < 200 && !againSaid(); attempt++) await tick();
  await advance(3_000);
  assert.equal(corrections().length, 1, 'the turn spends its one correction and never a second');
  assert.equal(counted().length, 1, 'and it is logged once');
  h.owner.revoke(session.liveSessionId);
});



// C-CLAIMS9 outcome 1, live path: at 10:23:49Z she said "Let me look into that." and made no call for thirty
// seconds. The host gives the announcement the same beat and corrects it once.
test('C-CLAIMS9: "Let me look into that." with no call gets the correction inside the deadline', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, tools: true, limits: { idleMs: 600_000, sessionMs: 600_000, callMaxMs: 600_000 } });
  const { session } = await attached(h, 'claim-look-into');
  const corrections = () => h.f.frames.filter(frame => {
    const text = (frame as { realtimeInput?: { text?: string } }).realtimeInput?.text;
    return typeof text === 'string' && text.includes('Correction:');
  });
  const advance = async (ms: number): Promise<void> => { h.advance(ms); scheduler.runDue(); await settlePort(); };
  h.f.send({ serverContent: { inputTranscription: { text: 'what did the synthetic partner say about the contract', finished: true } } });
  await settlePort();
  h.f.send({ serverContent: { outputTranscription: { text: 'Let me look into that.', finished: true }, turnComplete: true } });
  await settlePort();
  assert.equal(corrections().length, 0, 'the announcement is given its beat before anything is said');
  await advance(2_999);
  assert.equal(corrections().length, 0, 'the deterministic clock has not reached the correction deadline');
  await advance(1);
  assert.equal(corrections().length, 1, 'the announced lookup with no call behind it is corrected inside the deadline');
  assert.match((corrections()[0] as { realtimeInput: { text: string } }).realtimeInput.text, /make the call now/i, 'and it offers the call');
  assert.match((corrections()[0] as { realtimeInput: { text: string } }).realtimeInput.text, /^\[host note, not the owner\] Correction:/u, 'W6 keeps the W3 correction separate from owner speech');
  await advance(3_000);
  assert.equal(corrections().length, 1, 'the same announcement is corrected only once');
  h.owner.revoke(session.liveSessionId);
});

// #451 / RECON-RESEARCH Q6: six opener lookups (35 s) ran before the owner ever spoke, one cancelling the
// next. A start before the first owner input is answered at once and reaches no source at all.



test('OPEN2-5: an open claim the turn did not make gets one correction, never two', async t => {
  const captureDir = mkdtempSync(join(tmpdir(), 'didi-live-openclaim-'));
  const stop = captureHostDiagnostics(new HostLog(captureDir));
  t.after(() => { stop(); rmSync(captureDir, { recursive: true, force: true }); });
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'open-claim');
  const output = attachment.output[Symbol.asyncIterator]();
  h.f.send({ serverContent: { inputTranscription: { text: 'open the OCP alignment deck', finished: true } } });
  await transcription(output, 'open the OCP alignment deck');
  h.f.send({ serverContent: { outputTranscription: { text: "I found it, it's open now, the OCP alignment deck.", finished: true }, turnComplete: true } });
  const corrections = () => h.f.frames.filter(frame => {
    const text = (frame as { realtimeInput?: { text?: string } }).realtimeInput?.text;
    return typeof text === 'string' && text.startsWith('[host note, not the owner] Correction:');
  });
  for (let attempt = 0; attempt < 40 && corrections().length === 0; attempt++) await tick();
  assert.equal(corrections().length, 1, 'exactly one correction for the turn');
  assert.match((corrections()[0] as { realtimeInput: { text: string } }).realtimeInput.text, /nothing opened/);
  // A second completed response with no new claim is never corrected again.
  h.f.send({ serverContent: { outputTranscription: { text: 'Anything else?', finished: true }, turnComplete: true } });
  for (let attempt = 0; attempt < 20; attempt++) await tick();
  assert.equal(corrections().length, 1, 'the claim was corrected once for good');
  const lines = readFileSync(join(captureDir, 'logs', 'host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; reason?: string });
  const received = lines.filter(line => line.event === 'open_claim_corrected');
  assert.deepEqual(received.map(line => line.reason), ['no_receipt']);
  h.owner.revoke(session.liveSessionId);
});

test('R7: the dropped-line opener is cancelled only before its own audio starts', async () => {
  // The decision the mute-free opener takes on the owner's first words (b210596e).
  assert.equal(openerCancelled(true, false), true, 'the owner spoke before the opener was audible: cancel it');
  assert.equal(openerCancelled(true, true), false, 'the opener is already speaking: let it finish');
  assert.equal(openerCancelled(false, false), false, 'a call with no dropped-line opener cancels nothing');
});

test('R7: the owner\'s final turn frees the answer after a cancelled opener', async t => {
  const h = await harness(t);
  const { attachment } = await attached(h, 'opener-free-answer');
  const played: string[] = [];
  void (async () => { for await (const chunk of attachment.output) if (chunk.kind === 'audio') played.push(chunk.kind); })();
  // The owner speaks and finishes his turn, which is when a cancelled opener stops applying.
  h.f.send({ serverContent: { inputTranscription: { text: 'the folder goes upstairs', finished: true } } });
  await tick();
  for (let i = 0; i < 40 && played.length === 0; i++) { h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } }); await tick(); }
  assert.ok(played.length >= 1, 'his answer is audible, never silenced by an earlier cancel');
});

test('R9: a cancelled dropped-line opener never plays, its late frames stay dropped, and the owner is answered', async t => {
  const scheduler = new DeadlineClock();
  const h = await harness(t, { scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const next = h.owner.create({ idempotencyKey: 'r9-next', inputClass: 'ordinary' }, h.ctx);
  const deadAt = scheduler.now - 120_000;
  const conversationId = h.store.transaction(tx => String(tx.get('SELECT conversation_id FROM live_conversations WHERE owner_assistant_id=?', [h.store.assistantId])!['conversation_id']));
  h.store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
        journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
      VALUES (?,?,?,?,?,?,?,?,?,'terminal',0,0,2,120,1,'ended',?,?,?,?,NULL)`,
      ['r9-dead-session', h.store.assistantId, h.store.authorityEpoch, 'key-r9-dead', 'fp-r9-dead', 'client', 'audit', 'profile', 'prompt',
        JSON.stringify({ state: 'failed', code: 'resume_failed' }), deadAt, deadAt, deadAt]);
    tx.run('INSERT INTO live_session_conversations(live_session_id,conversation_id) VALUES(?,?)', ['r9-dead-session', conversationId]);
    tx.run("INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,payload_bytes,arrived_at) VALUES(?,?,?,?,1,?,?)",
      ['r9-dead-session', 1, 'outputTranscription', 'the last answer of the dead call', 60, deadAt]);
  });
  const attachment = h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  await h.f.frame(2);
  const request = h.requests.at(-1)!;
  assert.equal(request.openingText, LIVE_DROPPED_LINE_MARK, 'the new call opens with the dropped-line marker');
  assert.equal((request.history ?? []).at(-1)?.role, 'user', 'the dead answer is closed as heard');
  assert.ok((request.history ?? []).some(turn => turn.text.includes('the last answer of the dead call')), 'and it is still history');
  const played: string[] = [];
  void (async () => { for await (const chunk of attachment.output) if (chunk.kind === 'audio') played.push(chunk.kind); })();
  // The owner speaks before any opener audio.
  h.f.send({ serverContent: { inputTranscription: { text: 'tell me about the folder', finished: false } } });
  await tick(); await tick();
  for (let i = 0; i < 5; i++) { h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } }); await tick(); }
  assert.equal(played.length, 0, 'zero opener audio frames reach the device');
  // The provider ends the cancelled opener; the owner's turn is final; then the answer.
  h.f.send({ serverContent: { interrupted: true } });
  await tick();
  h.f.send({ serverContent: { inputTranscription: { text: 'tell me about the folder', finished: true } } });
  await tick();
  for (let i = 0; i < 40 && played.length === 0; i++) { h.f.send({ serverContent: { modelTurn: { role: 'model', parts: [audio()] } } }); await tick(); }
  assert.ok(played.length >= 1, 'the answer frames reach the device');
  h.f.send({ serverContent: { outputTranscription: { text: 'here is the folder answer', finished: true } } });
  await tick(); await tick();
  const rows = h.store.transaction(tx => tx.all("SELECT text FROM live_journal WHERE live_session_id=? AND kind='outputTranscription'", [next.liveSessionId]));
  const said = rows.map(row => String(row['text'])).join(' ');
  assert.equal(said.includes('the last answer of the dead call'), false, 'the answer never repeats the dead call');
  assert.ok(said.includes('here is the folder answer'), 'and it answers the owner');
  h.owner.revoke(next.liveSessionId);
});

test('#589 a finished owner turn on a superseded generation never ends the call', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h);
  const first = h.f.clients[0]!;
  // The host goes away and rebuilds from the saved handle, so the session is generation 1.
  h.f.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'synthetic-stop-resumption' } });
  h.f.send({ goAway: { timeLeft: '10s' } });
  await h.f.frame(2);
  h.f.send({ setupComplete: {} });
  // The public committed marker, not a timer, is the resumption acknowledgement.
  const output = attachment.output[Symbol.asyncIterator]();
  await continuity(output, 'resumed');
  assert.equal(h.owner.current().state, 'listening', 'the rebuilt generation is live');
  // A finished turn on the socket the host already left is not the owner's live words.
  first.emit('message', Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: 'Naya, stop listening', finished: true } } })));
  await tick();
  await tick();
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'a superseded generation never ends the call');
  // The live generation is still armed, so the gate itself is not simply dead.
  h.f.send({ serverContent: { inputTranscription: { text: 'Naya, stop listening', finished: true } } });
  await tick();
  await tick();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' },
    'the current generation ends the call on the same words');
});

// TOPIC (#565): the query shape of every source call is persisted through the trace writer, so the
// next forensic review can prove what a search was built from without storing a single word.


test('#606 unfinished fragments stop immediately across recognizer noise and a 700 ms pause', async t => {
  const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'stop-fragments', inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
  const frames: string[] = [];
  const pump = pumpOutput(recordingSocket(frames), attachment, () => {}, 1_000_000);
  for (const text of ['Nayas.', 'Okay, Naya,']) {
    fake.emit({ type: 'inputTranscription', text, finished: false });
    await settlePort();
    assert.equal(h.owner.get(session.liveSessionId).terminal, null);
    scheduler.now += 700; scheduler.runDue();
  }
  fake.emit({ type: 'inputTranscription', text: 'stop listening now', finished: false });
  await settlePort();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
  await pump;
  assert.equal(h.owner.get(session.liveSessionId).consumerState, 'ended');
  assert.equal(frames.filter(frame => frame !== 'binary' && JSON.parse(frame).type === 'terminal').length, 1);
});

test('#606 long unfinished room speech cannot hide a stop at the end', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'stop-room', inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
  fake.emit({ type: 'inputTranscription', text: `${'room '.repeat(60)}naya stop listening`, finished: false });
  await settlePort();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
});

test('#606 the stop window expires after three seconds and resets on model output', async t => {
  for (const reset of ['silence', 'output'] as const) {
    const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
    const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
    const session = h.owner.create({ idempotencyKey: `stop-reset-${reset}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    fake.emit({ type: 'inputTranscription', text: 'Naya', finished: false });
    await settlePort();
    if (reset === 'silence') { scheduler.now += 3_000; scheduler.runDue(); }
    else fake.emit({ type: 'outputTranscription', text: 'yes', finished: false });
    await settlePort();
    fake.emit({ type: 'inputTranscription', text: 'stop', finished: false });
    await settlePort();
    assert.equal(h.owner.get(session.liveSessionId).terminal, null, reset);
    attachment.close(); await attachment.done;
  }
});

test('R1 twenty direct requests stop on unfinished fragments with a fake clock', async t => {
  const positives = [
    'Naya, stop listening', 'Naya stop listening', 'stop listening Naya',
    'Naya shut down', 'Naya please stop listening', 'Naya stop', 'Naya hör auf zuzuhören',
    'Naya, stop', 'Naja stop listening', 'Nayah stop listening', 'Naia stop listening',
    'Nia stop listening', 'Nayer stop listening', 'Nayla stop listening', 'NAYA STOP LISTENING!',
    'Naya could you stop listening now please', 'Could you stop listening Naya',
    'Please Naya stop listening', 'Naya bitte hör auf zuzuhören', 'Naya schalt dich aus',
  ];
  assert.equal(positives.length, 20);
  for (const [i, text] of positives.entries()) {
    const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
    const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
    const session = h.owner.create({ idempotencyKey: `positive-${i}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    fake.emit({ type: 'inputTranscription', text, finished: false });
    await settlePort();
    assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' }, text);
    await attachment.done;
  }
});

test('R1 a name at a fragment edge keeps its grace across quiet finals for under three seconds', async t => {
  const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'name-grace', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit({ type: 'inputTranscription', text: 'Naja', finished: false });
  fake.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin: 'app_quiet' });
  await settlePort();
  scheduler.now += 2_999; scheduler.runDue();
  fake.emit({ type: 'inputTranscription', text: 'stop', finished: false });
  await settlePort();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
});

test('#606 modelTurnStarted finalization admits a phrase only visible after joining provider deltas', async t => {
  const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
  const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'stop-fallback', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit({ type: 'inputTranscription', text: 'Na', finished: false });
  fake.emit({ type: 'inputTranscription', text: 'ya stop', finished: false });
  await settlePort();
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'the fragment word boundary hides the name until finalization');
  fake.emit({ type: 'modelTurnStarted' });
  await settlePort();
  scheduler.now += 300; scheduler.runDue(); await settlePort();
  assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
  await attachment.done;
});

test('R1 terminal delivery survives a provider close failure and a store failure', async t => {
  for (const failure of ['provider', 'store'] as const) {
    const fake = fakeLiveVoicePort();
    let closed = false;
    const port: LiveVoicePort = { capabilities: fake.port.capabilities, open: (request, control) => {
      const session = fake.port.open(request, control);
      return { ...session, close: () => { closed = true; session.close(); if (failure === 'provider') throw new Error('synthetic close failure'); } };
    } };
    const h = await harness(t, { port, limits: { idleMs: 600_000, sessionMs: 600_000 } });
    const session = h.owner.create({ idempotencyKey: `stop-failure-${failure}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    const frames: string[] = [];
    const pump = pumpOutput(recordingSocket(frames), attachment, () => { assert.fail('terminal delivery was skipped'); }, 1_000_000);
    const transaction = h.store.transaction.bind(h.store);
    if (failure === 'store') h.store.transaction = () => { throw new Error('synthetic store failure'); };
    fake.emit({ type: 'inputTranscription', text: 'Naya stop listening', finished: false });
    const snapshot = await attachment.done;
    h.store.transaction = transaction;
    await pump;
    assert.equal(closed, true, 'provider close was attempted despite cleanup failure');
    assert.deepEqual(snapshot.terminal, { state: 'closed', code: 'voice_stop' });
    assert.equal(frames.filter(frame => frame !== 'binary' && JSON.parse(frame).type === 'terminal').length, 1);
    if (failure === 'store') assert.equal(snapshot.journal.complete, false, 'no durable success is fabricated');
  }
});

test('R1 no false stop from typed or assistant speech, negation, quotation or an expired name', async t => {
  const cases: { text: string; origin?: 'typed'; output?: boolean; expired?: boolean }[] = [
    { text: 'what happens if I say Naya stop listening' }, { text: 'Naya said stop listening' },
    { text: 'Naya do not stop listening' }, { text: "Naya don't stop" },
    { text: 'tell Maya to stop listening to podcasts' }, { text: 'stop listening to podcasts' },
    { text: 'Naya stop listening', origin: 'typed' }, { text: 'Naya stop listening', output: true },
    { text: 'stop', expired: true }, { text: 'Naya why stop listening' },
    { text: 'Naya what should I stop listening to' }, { text: 'Naya never stop listening' },
    { text: 'Naya how do I stop listening' }, { text: 'Naya when should I stop listening' },
    { text: 'Nadia said stop listening' }, { text: 'nayas said stop listening' },
    { text: 'please stop listening to podcasts' }, { text: 'Naya stop listening to podcasts' },
    { text: 'Naya please do not shut down' }, { text: 'Naya if you stop listening' },
  ];
  assert.equal(cases.length, 20);
  for (const [i, input] of cases.entries()) {
    const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
    const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
    const session = h.owner.create({ idempotencyKey: `negative-${i}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    if (input.expired) {
      fake.emit({ type: 'inputTranscription', text: 'Naya ', finished: false }); await settlePort();
      scheduler.now += 4_000; scheduler.runDue(); await settlePort();
    }
    fake.emit(input.output ? { type: 'outputTranscription', text: input.text, finished: true }
      : { type: 'inputTranscription', text: input.text, finished: true, ...(input.origin ? { finalOrigin: input.origin } : {}) });
    await settlePort();
    assert.equal(h.owner.get(session.liveSessionId).terminal, null, `case ${i}: ${input.text}`);
    attachment.close(); await attachment.done;
  }
});

test('R1 admission precedes journal overflow and drops queued host audio', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, limits: { journalMaxEvents: 2, idleMs: 600_000, sessionMs: 600_000 } });
  const session = h.owner.create({ idempotencyKey: 'stop-full-journal', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit({ type: 'audio', pcm: new Uint8Array([1, 0]), rate: 24000 }); await settlePort();
  fake.emit({ type: 'inputTranscription', text: 'Naya stop listening', finished: false }); await settlePort();
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'voice_stop' });
  const chunks = [];
  for await (const chunk of attachment.output) chunks.push(chunk);
  assert.equal(chunks.some(chunk => chunk.kind === 'audio'), false, 'previously queued speech is purged');
});

test('R2 the three named forensic stop shapes terminate before any final marker', async t => {
  for (const scenario of ['question-after-command', 'recognizer-prefix', 'long-room-turn'] as const) {
    const fake = fakeLiveVoicePort(), scheduler = new DeadlineClock();
    const h = await harness(t, { port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 600_000 } });
    const session = h.owner.create({ idempotencyKey: `forensic-${scenario}`, inputClass: 'ordinary' }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    const fragments = scenario === 'question-after-command' ? ['Naya,', 'stop listening.', 'Can you react to stop listening?']
      : scenario === 'recognizer-prefix' ? ['Nayas.', 'Okay, Naya,', 'stop listening now']
      : [...Array.from({ length: 21 }, (_, i) => 'room '.repeat(i < 12 ? 4 : 3)), 'naya stop listening now'];
    for (const text of fragments) {
      fake.emit({ type: 'inputTranscription', text, finished: false });
      await settlePort();
      scheduler.now += scenario === 'long-room-turn' ? 2_000 : 300;
      scheduler.runDue();
    }
    assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'voice_stop' }, scenario);
  }
});


test('R1 evidence release cannot skip provider close or the typed terminal', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, releaseEvidenceError: true });
  const session = h.owner.create({ idempotencyKey: 'stop-evidence-failure', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const frames: string[] = [];
  const pump = pumpOutput(recordingSocket(frames), attachment, () => { assert.fail('terminal was skipped'); }, 1_000_000);
  fake.emit({ type: 'inputTranscription', text: 'Naya stop listening', finished: false });
  await pump;
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'voice_stop' });
  assert.equal(frames.filter(frame => frame !== 'binary' && JSON.parse(frame).type === 'terminal').length, 1);
});

test('R1 a failed terminal write with working reads still delivers the in-memory terminal', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'stop-write-only-failure', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  h.store.transaction(tx => tx.run("CREATE TRIGGER synthetic_terminal_failure BEFORE UPDATE OF terminal_outcome ON live_sessions WHEN NEW.terminal_outcome IS NOT NULL BEGIN SELECT RAISE(FAIL,'synthetic terminal write failure'); END"));
  const frames: string[] = [];
  const pump = pumpOutput(recordingSocket(frames), attachment, () => { assert.fail('terminal was skipped'); }, 1_000_000);
  fake.emit({ type: 'inputTranscription', text: 'Naya stop listening', finished: false });
  await pump;
  const snapshot = await attachment.done;
  assert.deepEqual(snapshot.terminal, { state: 'closed', code: 'voice_stop' });
  assert.equal(snapshot.journal.complete, false, 'a failed write is never reported as durable');
  assert.equal(frames.filter(frame => frame !== 'binary' && JSON.parse(frame).type === 'terminal').length, 1);
});

test('R1 a candidate diagnostic sink cannot prevent admitted stop teardown', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'stop-log-failure', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const detach = attachHostLogSink({ event: raw => {
    if ((raw as { event?: string }).event === 'voice_stop_candidate') throw new Error('synthetic log failure');
  } });
  t.after(detach);
  fake.emit({ type: 'inputTranscription', text: 'Naya stop listening', finished: false });
  assert.deepEqual((await attachment.done).terminal, { state: 'closed', code: 'voice_stop' });
});


test('R3 bare commands close the real fake-provider socket and consumer, not the host owner', async t => {
  for (const [i, text] of ['stop listening', 'Okay, like stop listening. You need to shut down now.'].entries()) {
    const h = await harness(t);
    const { session, attachment } = await attached(h, `bare-stop-${i}`);
    const provider = h.f.clients[0]!;
    const closed = new Promise<void>(resolve => provider.once('close', () => resolve()));
    const frames: string[] = [];
    const pump = pumpOutput(recordingSocket(frames), attachment, () => { assert.fail('terminal was skipped'); }, 1_000_000);
    h.f.send({ serverContent: { inputTranscription: { text, finished: false } } });
    await settlePort();
    assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
    await pump; await closed;
    assert.equal(provider.readyState, 3, 'no provider socket remains open after admission');
    assert.equal(h.f.clients.every(client => client.readyState === 3), true);
    assert.equal((await attachment.done).consumerState, 'ended', 'the microphone uplink consumer is closed');
    assert.deepEqual(h.owner.get(session.liveSessionId).terminal, { state: 'closed', code: 'voice_stop' });
    const next = h.owner.create({ idempotencyKey: `host-still-running-${i}`, inputClass: 'ordinary' }, h.ctx);
    assert.equal(next.terminal, null, 'ending a call does not shut down the host owner');
    assert.equal(frames.filter(frame => frame !== 'binary' && JSON.parse(frame).type === 'terminal').length, 1);
  }
});




















test('W4-R1: a genuine second mute with no tool result still ends the call', async t => {
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const record = raw as Record<string, unknown>;
    if (record.event === 'live_watchdog') receipts.push(record);
  } });
  t.after(() => detach());
  const fake = fakeLiveVoicePort();
  const scheduler = new DeadlineClock();
  const h = await harness(t, { tools: true, port: fake.port, scheduler, limits: { idleMs: 600_000, sessionMs: 1_200_000 } });
  const { session } = await openPort(h, 'watchdog-note-window');
  // No tool is called at all, so nothing forges a wait the model never had. C-REBUILD C: the provider created a
  // response for that turn, which keeps the first mute recoverable; the repeated mute is what this test guards.
  await ownerInput(fake);
  fake.emit({ type: 'modelTurnStarted' });
  await advanceUntil(ms => h.advance(ms), scheduler, () => receipts.some(record => record.phase === 'recovered'));
  await ownerInput(fake);
  await advanceUntil(ms => h.advance(ms), scheduler, () => receipts.some(record => record.phase === 'settled'));
  const settled = receipts.find(record => record.phase === 'settled');
  assert.equal(settled?.['sinceTool'], false, 'the owner-turn wait says it did not begin at a tool result');
  assert.equal(settled?.['msSinceToolResult'], undefined, 'no tool result ever reached the model');
  const terminal = h.owner.get(session.liveSessionId).terminal;
  assert.equal(terminal !== null && 'code' in terminal ? terminal.code : undefined, 'model_unresponsive',
    'a real repeated mute keeps its honest terminal');
});





// C-RESEARCH-CONTRACT (T-03, T-04, Q-08): the block reply names the closed reason the admission applied, a
// continue that pages the run the session already answered from spends that run's grant, and a start after the
// answer was spoken is the orphan run, refused by name rather than as one more spent turn.


// R9-W5: the own-results allowance belongs to an owner turn, never to the session.



test('R9-W5 refusal retains delivered findings and projection uses closed refusal code', () => {
  const delivered = { findings: [{ source: 'web', text: 'Web: 3 of 3 shown\nalpha\nbeta\ngamma' }] };
  const reply = admissionBlocked('turn_spent', delivered);
  assert.equal(reply['deliveredCount'], 3);
  assert.doesNotMatch(String(reply['directive']), /nothing|empty|blocked/iu);
  assert.equal(reply['status'], 'blocked', 'W5-R2 preserves accepted admission envelope');
  assert.match(researchProjection(reply, 'completed'), /refused:turn_spent/u);
  assert.match(researchProjection({ findings: [{ source: 'calendar', text: 'Calendar: 1 of 1 shown\nSynthetic meeting' }] }, 'completed'), /findings from calendar; 1 delivered item/u);
});

test('R9-W5 late findings all retain source and lookup provenance', () => {
  const line = lateFindingsText('web', ['alpha', 'beta', 'gamma']);
  assert.match(line, /not supplied by the owner/u);
  for (const item of ['alpha', 'beta', 'gamma']) assert.ok(line.includes(`from the web: ${item}`));
  assert.equal(lateFindingsText('mail', ['synthetic mail']).includes('from your mail:'), true);
  assert.ok(lateFindingsText('web', ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)]).length <= 280);
});



test('C-AUDIO10: a long continuation survives a completed preamble and later barge-in in trace', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'audio10-long-trace', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'inputTranscription', text: 'Explain the synthetic plan.', finished: true }));
  fake.emit(portEvent({ type: 'outputTranscription', text: 'Okay, I am on it.', finished: true }));
  fake.emit(portEvent({ type: 'turnComplete' }));
  await settlePort();
  const parts = Array.from({ length: 90 }, (_, index) => `Synthetic second ${index}: the plan continues. `);
  fake.emit(portEvent({ type: 'modelTurnStarted' }));
  for (const text of parts) fake.emit(portEvent({ type: 'outputTranscription', text, finished: false }));
  fake.emit(portEvent({ type: 'outputTranscription', text: '', finished: true }));
  fake.emit(portEvent({ type: 'interrupted' }));
  await settlePort();
  const finals = h.store.transaction(tx => tx.all("SELECT text FROM trace_utterance WHERE role='model' AND final=1 ORDER BY rowid"));
  assert.deepEqual(finals.map(row => row['text']), ['Okay, I am on it.', parts.join('').trim()]);
  attachment.close();
});

test('C-AUDIO10: repeated start notifications do not duplicate first audio for a response', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const events: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => events.push(raw as Record<string, unknown>) });
  t.after(detach);
  const session = h.owner.create({ idempotencyKey: 'audio10-first-audio', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const start = (responseId: string) => portEvent({ type: 'modelTurnStarted', ...{ responseId } });
  fake.emit(start('synthetic-response-1'));
  fake.emit(portEvent(audibleFrame));
  await settlePort();
  fake.emit(start('synthetic-response-1'));
  fake.emit(portEvent(audibleFrame));
  await settlePort();
  assert.equal(events.filter(row => row.event === 'live_first_audio').length, 1);
  fake.emit(start('synthetic-response-2'));
  fake.emit(portEvent(audibleFrame));
  await settlePort();
  assert.equal(events.filter(row => row.event === 'live_first_audio').length, 2);
  attachment.close();
});

test('C-AUDIO10: the opening model utterance has its own assistant trace turn', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'audio10-opener-trace', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'outputTranscription', text: 'Synthetic welcome.', finished: true }));
  fake.emit(portEvent({ type: 'turnComplete' }));
  await settlePort();
  const rows = h.store.transaction(tx => tx.all("SELECT u.text, t.origin FROM trace_utterance u JOIN trace_turn t USING(turn_id) WHERE t.live_session_id=? AND u.role='model' AND u.final=1", [session.liveSessionId]));
  assert.deepEqual(rows.map(row => [row['text'], row['origin']]), [['Synthetic welcome.', 'assistant']]);
  attachment.close();
});




test('C-AUDIO10 F2: a rebuilt greeting opens a new assistant trace turn', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port });
  const session = h.owner.create({ idempotencyKey: 'audio10-rebuilt-trace', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit(portEvent({ type: 'outputTranscription', text: 'Synthetic first greeting.', finished: true }));
  fake.emit(portEvent({ type: 'turnComplete' }));
  await settlePort();
  fake.emit({ type: 'goAway', timeLeftMs: 1 });
  for (let index = 0; index < 100 && fake.sessionsOpened < 2; index += 1) await tick();
  assert.equal(fake.sessionsOpened, 2);
  await settlePort();
  fake.emit(portEvent({ type: 'outputTranscription', text: 'Synthetic rebuilt greeting.', finished: true }));
  fake.emit(portEvent({ type: 'turnComplete' }));
  await settlePort();
  const rows = h.store.transaction(tx => tx.all("SELECT u.turn_id,u.text,t.origin FROM trace_utterance u JOIN trace_turn t USING(turn_id) WHERE t.live_session_id=? AND u.role='model' AND u.final=1 ORDER BY u.rowid", [session.liveSessionId]));
  assert.deepEqual(rows.map(row => row['text']), ['Synthetic first greeting.', 'Synthetic rebuilt greeting.']);
  assert.notEqual(rows[0]!['turn_id'], rows[1]!['turn_id'], 'rebuild must not attribute its greeting to the old closed turn');
  assert.deepEqual(rows.map(row => row['origin']), ['assistant', 'assistant']);
  attachment.close();
});

// C-POLISH10: the open audit is asserted through the real tool definition and registry, so a wrong or missing
// call-site value cannot pass on the helper's own arguments. No native peer is bound, so the open fails and the audit
// line is the only record of what was asked to open.



// C-WAKE104: real scheduler/store boundaries, synthetic clock and provider only.
test('alarm session speaks its reminder, repeats after silence and acknowledges only its alarm', async t => {
  const clock = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, scheduler: clock, limits: { idleMs: 300000, sessionMs: 900000 } });
  const scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => clock.now, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
  t.after(() => scheduler.stop());
  const first = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'call the bank', createdJournalId: 'synthetic-alarm' });
  const other = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'other reminder', createdJournalId: 'synthetic-other' });
  const alarm = { alarmId: first.id, ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00', label: first.label, ringDeadlineUtc: clock.now + 600000 };
  const session = h.owner.create({ idempotencyKey: 'wake-104', inputClass: 'ordinary', alarm }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  await settlePort();
  assert.match(fake.requests[0]!.system.text, /call the bank/);
  assert.match(fake.requests[0]!.system.text, /Synthetic system/);
  clock.now += 29999; clock.runDue();
  assert.equal(fake.texts.length, 0);
  clock.now += 1; clock.runDue();
  assert.match(fake.texts[0]!, /Alarm wake reminder 1/);
  fake.emit({ type: 'inputTranscription', text: 'mm', finished: true });
  await settlePort();
  assert.equal(scheduler.list().find(row => row.id === first.id)!.state, 'ringing');
  fake.emit({ type: 'inputTranscription', text: "I'm awake", finished: true });
  await settlePort();
  assert.equal(scheduler.list().find(row => row.id === first.id)!.state, 'done');
  assert.ok(fake.texts.some(text => text.includes('This alarm is acknowledged')));
  assert.ok(fake.texts.every(text => text.startsWith('[host note, not the owner] ')), 'wake and acknowledgement guidance are marked host notes');
  assert.equal(scheduler.list().find(row => row.id === other.id)!.state, 'ringing');
  const count = fake.texts.length;
  clock.now += 30000; clock.runDue();
  assert.equal(fake.texts.length, count, 'acknowledgement stops wake prompts');
  assert.equal(h.owner.current().state, 'listening', 'acknowledgement leaves the call open');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('alarm due during a live call injects once and unrelated earlier speech cannot acknowledge it', async t => {
  const clock = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, scheduler: clock, limits: { idleMs: 300000, sessionMs: 900000 } });
  const { session, attachment } = await openPort(h, 'wake-existing');
  const scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => clock.now, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
  t.after(() => scheduler.stop());
  const alarm = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'call the bank', createdJournalId: 'synthetic-live-alarm' });
  fake.emit({ type: 'inputTranscription', text: "I'm awake", finished: true });
  await settlePort();
  assert.equal(scheduler.list()[0]!.state, 'ringing', 'speech in an unrelated call cannot acknowledge a due alarm');
  const coordinator = new AlarmSessionCoordinator({ store: h.store, hasLiveSession: () => true, now: () => clock.now,
    open: setup => h.owner.announceAlarm(setup)!.liveSessionId, degraded: () => assert.fail('unexpected degradation') });
  assert.equal(coordinator.attempt(alarm.id, 'Synthetic Owner', 'synthetic-alarm-key').liveSessionId, session.liveSessionId);
  // The retry replays the session this key already opened, and a different key opens none.
  const retried = coordinator.attempt(alarm.id, 'Synthetic Owner', 'synthetic-alarm-key');
  assert.equal(retried.status, 'attempted');
  assert.equal(retried.liveSessionId, session.liveSessionId);
  // A different key names the same occurrence, so it is refused at the route, never opened again.
  assert.equal(coordinator.attempt(alarm.id, 'Synthetic Owner', 'synthetic-other-key').status, 'attempted');
  assert.equal(fake.sessionsOpened, 1);
  assert.equal(fake.texts.length, 1);
  assert.match(fake.texts[0]!, /call the bank/);
  assert.equal(scheduler.list()[0]!.state, 'ringing');
  fake.emit({ type: 'inputTranscription', text: 'got it', finished: true });
  await settlePort();
  assert.equal(scheduler.list()[0]!.state, 'done');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('an alarm permits one provider rebuild while its ring deadline is open', async t => {
  const clock = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, scheduler: clock, limits: { idleMs: 300000, sessionMs: 900000 } });
  const scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => clock.now, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
  t.after(() => scheduler.stop());
  const alarm = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'call the bank', createdJournalId: 'synthetic-rebuild' });
  const session = h.owner.create({ idempotencyKey: 'wake-rebuild', inputClass: 'ordinary', alarm: { alarmId: alarm.id, ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00', label: alarm.label, ringDeadlineUtc: clock.now + 600000 } }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  fake.emit({ type: 'goAway', timeLeftMs: 5000 });
  await settlePort();
  assert.equal(fake.sessionsOpened, 2);
  fake.emit({ type: 'goAway', timeLeftMs: 5000 });
  await settlePort();
  assert.equal(fake.sessionsOpened, 2, 'no second rebuild');
  clock.now += 6000; clock.runDue();
  await settlePort();
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});


test('overview alarms compose the same cached calendar digest and normal memory prompt', async t => {
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, system: `${NAYA_LIVE_BASE}\n\n${NAYA_TOOLS}`, calendarDigest: {
    forStart: async () => ({ state: 'present', text: 'Synthetic day: 09:00 Project review', items: 1, fetchedAt: NOW }), refresh: () => {} } });
  await h.owner.prepareCalendar();
  const session = h.owner.create({ idempotencyKey: 'wake-overview', inputClass: 'ordinary', alarm: { ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00', label: 'give me an overview' } }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  assert.match(fake.requests[0]!.system.text, /09:00 Project review/);
  assert.ok(fake.requests[0]!.system.text.includes(NAYA_LIVE_BASE));
  assert.match(fake.requests[0]!.system.text, /calendar digest/);
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});


for (const finalization of ['provider-empty-final', 'app-model-start'] as const) {
  test(`alarm acknowledgement accepts accumulated speech at ${finalization}`, async t => {
    const clock = new DeadlineClock();
    const fake = fakeLiveVoicePort();
    const h = await harness(t, { port: fake.port, tools: true, scheduler: clock, limits: { idleMs: 300000, sessionMs: 900000 } });
    const scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => clock.now, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
    t.after(() => scheduler.stop());
    const alarm = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'call the bank', createdJournalId: 'synthetic-fragments' });
    const session = h.owner.create({ idempotencyKey: finalization, inputClass: 'ordinary', alarm: { alarmId: alarm.id, ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00', label: alarm.label, ringDeadlineUtc: clock.now + 600000 } }, h.ctx);
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await attachment.ready;
    fake.emit({ type: 'inputTranscription', text: "I'm " });
    fake.emit({ type: 'inputTranscription', text: 'awake' });
    await settlePort();
    assert.equal(scheduler.list()[0]!.state, 'ringing', 'partial speech alone is not acknowledgement');
    if (finalization === 'provider-empty-final') fake.emit({ type: 'inputTranscription', text: '', finished: true });
    else fake.emit({ type: 'modelTurnStarted' });
    await settlePort();
    clock.now += 300; clock.runDue();
    await settlePort();
    assert.equal(scheduler.list()[0]!.state, 'done');
    h.owner.revoke(session.liveSessionId);
    await attachment.done;
  });
}

test('alarm audio keeps one timer until the last-audible silence window expires', async t => {
  const clock = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, scheduler: clock, limits: { idleMs: 300000, sessionMs: 900000 } });
  const scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => clock.now, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
  t.after(() => scheduler.stop());
  const alarm = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'call the bank', createdJournalId: 'synthetic-silence-window' });
  const session = h.owner.create({ idempotencyKey: 'wake-window', inputClass: 'ordinary', alarm: { alarmId: alarm.id, ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00', label: alarm.label, ringDeadlineUtc: clock.now + 600000 } }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await attachment.ready;
  const output = attachment.output[Symbol.asyncIterator]();
  const startedAt = clock.now;
  const timer = [...clock.pending].find(entry => entry.due === startedAt + 30000);
  assert.ok(timer, 'one initial silence timer');
  for (const elapsed of [10000, 20000]) {
    clock.now = startedAt + elapsed;
    for (let frame = 0; frame < 10; frame++) {
      fake.emit({ type: 'audio', pcm, rate: 24000, audible: true });
      let chunk = await output.next();
      while (!chunk.done && chunk.value.kind !== 'audio') chunk = await output.next();
      assert.equal(chunk.value?.kind, 'audio', 'observe every frame before advancing the fake clock');
    }
    fake.emit({ type: 'turnComplete' });
    await settlePort();
    assert.ok(clock.pending.has(timer), 'audio updates a timestamp, not the existing timer');
  }
  clock.now = startedAt + 30000; clock.runDue();
  assert.equal(fake.texts.length, 0, 'the original timer cannot nudge ten seconds after the last audio');
  assert.equal([...clock.pending].filter(entry => entry.due === startedAt + 50000).length, 1, 'exactly one timer for remaining silence');
  clock.now = startedAt + 49999; clock.runDue();
  assert.equal(fake.texts.length, 0);
  clock.now += 1; clock.runDue();
  assert.match(fake.texts[0]!, /Alarm wake reminder 1/);
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('confirmation targets the alarm announced most recently by time after a reannouncement', async t => {
  const clock = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const h = await harness(t, { port: fake.port, tools: true, scheduler: clock, limits: { idleMs: 300000, sessionMs: 900000 } });
  const { session, attachment } = await openPort(h, 'wake-announcement-order');
  const scheduler = new AlarmScheduler({ store: h.store, clock: { now: () => clock.now, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
  t.after(() => scheduler.stop());
  const first = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'first reminder', createdJournalId: 'synthetic-first-announcement' });
  const second = scheduler.set({ fireAtUtc: clock.now, tz: 'UTC', label: 'second reminder', createdJournalId: 'synthetic-second-announcement' });
  const setup = { ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00', ringDeadlineUtc: clock.now + 600000 };
  h.owner.announceAlarm({ ...setup, alarmId: first.id, label: first.label });
  clock.now += 1;
  h.owner.announceAlarm({ ...setup, alarmId: second.id, label: second.label });
  clock.now += 1;
  h.owner.announceAlarm({ ...setup, alarmId: first.id, label: first.label });
  fake.emit({ type: 'inputTranscription', text: 'got it', finished: true });
  await settlePort();
  assert.equal(scheduler.list().find(row => row.id === first.id)!.state, 'done', 'the reannounced first alarm owns this confirmation');
  assert.equal(scheduler.list().find(row => row.id === second.id)!.state, 'ringing');
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});




test('canary revoke emits a validated terminal paired to its provider open', async t => {
  const h = await harness(t);
  const { session, attachment } = await attached(h, 'canary-close');
  const receipts: unknown[] = [];
  const stop = attachHostLogSink({ event: raw => { const event = safeEvent(raw); if (event) receipts.push(event); } });
  canarySessions.open(session.liveSessionId);
  try {
    h.owner.revoke(session.liveSessionId);
    await attachment.done;
    assert.ok(receipts.some(raw => {
      const row = raw as Record<string, unknown>;
      return row['event'] === 'live_terminal' && row['liveSessionId'] === session.liveSessionId && row['code'] === 'revoked';
    }));
  } finally { stop(); canarySessions.close(session.liveSessionId); }
});

test('typed owner text refuses before provider setup completes without sending', async t => {
  const h = await harness(t);
  const session = h.owner.create({ idempotencyKey: 'typed-before-ready', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
  await h.f.frame(1);
  assert.equal(h.owner.providerReady(session.liveSessionId), false);
  const before = h.f.frames.length;
  assert.throws(() => h.owner.text('synthetic early owner text'), /not_ready/);
  assert.equal(h.f.frames.length, before);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  assert.equal(h.owner.providerReady(session.liveSessionId), true);
  h.owner.revoke(session.liveSessionId);
  await attachment.done;
});

test('production Live wrapper forwards delayed provider readiness', async t => {
  const h = await harness(t);
  const live = composeLive(h.store, h.dir, {
    profile: validateLiveProfile(profileInput()),
    credentials: { resolve: async () => CANARY }, socketFactory: h.f.socketFactory,
  }).service;
  t.after(() => live.shutdown());
  const session = live.create('ordinary', 'wrapper-ready', h.ctx);
  const attachment = live.attach(session.liveSessionId, h.ctx);
  await h.f.frame(1);
  assert.equal(live.providerReady?.(session.liveSessionId), false);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  assert.equal(live.providerReady?.(session.liveSessionId), true);
  live.revoke(session.liveSessionId);
  await attachment.done;
  assert.equal(live.providerReady?.(session.liveSessionId), false);
});

test('actual InstalledCanary never-ready close releases production session and logs terminal', async t => {
  const h = await harness(t);
  const live = composeLive(h.store, h.dir, {
    profile: validateLiveProfile(profileInput()),
    credentials: { resolve: async () => CANARY }, socketFactory: h.f.socketFactory,
  }).service;
  t.after(() => live.shutdown());
  let clock = 0;
  const host = new InstalledCanary(h.store, live, async () => { clock += 5000; }, () => clock);
  t.after(() => host.shutdown());
  const asks = [{ id: 'synthetic-ready', finals: ['synthetic owner text'], expect: { tool: 'search', codeClass: 'success' as const, nonEmpty: true } }];
  const session = host.open(asks, h.ctx);
  const attachment = live.attach(session.liveSessionId, h.ctx);
  await h.f.frame(1);
  const receipts: Record<string, unknown>[] = [];
  const stop = attachHostLogSink({ event: raw => { const event = safeEvent(raw); if (event) receipts.push(event); } });
  try {
    const report = await host.run(session.liveSessionId, h.ctx.clientId);
    assert.match(report.lines[0]!, /code=provider_not_ready ms=10000/);
    assert.equal(live.snapshot(session.liveSessionId).terminal?.state, 'revoked');
    await attachment.done;
    assert.equal(canarySessions.isCanary(session.liveSessionId), false);
    assert.equal(receipts.filter(row => row['event'] === 'live_terminal' && row['liveSessionId'] === session.liveSessionId).length, 1);
    const next = host.open(asks, h.ctx);
    assert.notEqual(next.liveSessionId, session.liveSessionId);
    host.shutdown();
  } finally { stop(); }
});








// F2: on 10-30 the owner's call opened on the canary's own thread because the canary session wrote an ordinary
// summary row. A canary session is marked by the key it creates, so it distils nothing and offers nothing.
test('F2: a canary session distils nothing and its summary reaches no owner opener', async t => {
  const terminal: string[] = [];
  const h = await harness(t, { tools: true, onSessionTerminal: liveSessionId => { terminal.push(liveSessionId); } });
  const canary = h.owner.create({ idempotencyKey: 'canary:synthetic-canary-1', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: canary.liveSessionId }, h.ctx);
  await h.f.frame(1);
  h.f.send({ setupComplete: {} });
  await Promise.all([attachment.ready, h.f.frame(2)]);
  await ownerSpoke(h);
  h.owner.revoke(canary.liveSessionId);
  assert.deepEqual(terminal, [], 'a marked canary session schedules no distillation');
  // The rows already in his store look like this one: a summary written for a canary session, which the
  // canary's own history row marks, so it reaches no owner opener.
  h.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId: canary.liveSessionId, status: 'complete',
    summary: 'The canary asked about the synthetic lighthouse thread.', endedAt: NOW - 60_000, now: NOW - 60_000,
    dataClass: 'ordinary', sourceRevision: 1 }));
  const session = h.owner.create({ idempotencyKey: 'owner-after-canary', inputClass: 'ordinary' }, h.ctx);
  const row = h.store.transaction(tx => tx.get('SELECT memory_provenance FROM live_sessions WHERE live_session_id=?', [session.liveSessionId]))!;
  assert.deepEqual((JSON.parse(String(row['memory_provenance'])) as { injectedSummaryIds: string[] }).injectedSummaryIds, [],
    'the owner session is offered no canary summary');
});

// CB-R1(a): the settled projection once read "findings from ;" with an empty source list. It now names the
// sources when the findings carry them, and otherwise omits the clause instead of leaving it empty.


// CB-R1(b): a file-open ask reads no calendar. The call's own start uses the cached digest once (1015), and the
// ask that follows, "open the synthetic deck", adds no digest read and no calendar_list_events dispatch.


// F2 widening (call 8be5d80f): every session of the day shared one conversation id, so a canary's typed asks
// reached owner calls. A canary session now owns its conversation, and the seed reads owner sessions only.
test('F2 widening: a canary turn never seeds an owner call, even inside one conversation id', async t => {
  const h = await harness(t);
  const turn = async (key: string, kind: 'owner' | 'canary', asked: string, answered: string) => {
    const session = h.owner.create({ idempotencyKey: key, inputClass: 'ordinary', sessionKind: kind }, h.ctx);
    // The fixture counts frames across every connection, so each call waits for its own setup frame.
    const base = h.f.frames.length;
    const attachment = h.owner.attach({ liveSessionId: session.liveSessionId }, h.ctx);
    await h.f.frame(base + 1);
    h.f.send({ setupComplete: {} });
    await attachment.ready;
    await h.f.frame(base + 2);
    h.f.send({ serverContent: { inputTranscription: { text: asked, finished: true } } });
    h.f.send({ serverContent: { outputTranscription: { text: answered, finished: true } } });
    await drain(h, session.liveSessionId, 2);
    h.owner.revoke(session.liveSessionId);
    await attachment.done;
    return session.liveSessionId;
  };
  await turn('owner-before-canary', 'owner', 'TOKEN-OWNER-ASK what time is the budget meeting', 'TOKEN-OWNER-ANSWER at noon');
  const canary = await turn('canary:typed-ask', 'canary', 'TOKEN-CANARY-ASK what time is the budget meeting', 'TOKEN-CANARY-ANSWER at noon');
  // The shape of 2026-10-30: one conversation id for every session of the day.
  const shared = h.store.transaction(tx => {
    const owner = tx.get('SELECT conversation_id FROM live_conversations WHERE owner_assistant_id=?', [h.store.assistantId]);
    const conversationId = String(owner?.['conversation_id'] ?? 'shared-conversation');
    tx.run('INSERT OR REPLACE INTO live_session_conversations(live_session_id,conversation_id) VALUES(?,?)', [canary, conversationId]);
    return conversationId;
  });
  const next = h.owner.create({ idempotencyKey: 'owner-after-canary', inputClass: 'ordinary' }, h.ctx);
  const base = h.f.frames.length;
  const attachment = h.owner.attach({ liveSessionId: next.liveSessionId }, h.ctx);
  await h.f.frame(base + 1);
  h.f.send({ setupComplete: {} });
  await attachment.ready;
  await h.f.frame(base + 2);
  const history = JSON.stringify(h.requests.at(-1)!.history);
  assert.equal(h.store.transaction(tx => tx.get('SELECT conversation_id FROM live_session_conversations WHERE live_session_id=?', [canary]))!['conversation_id'], shared,
    'the canary really was in the owner\'s conversation for this check');
  assert.match(history, /TOKEN-OWNER-ASK/u, 'the owner\'s own earlier call still seeds the new one');
  assert.equal(history.includes('TOKEN-CANARY'), false, 'no canary turn reaches an owner call');
  h.owner.revoke(next.liveSessionId);
  await attachment.done;
});

// #107 (10.7): the live grant set carries the compose family, so a direct owner ask reaches its
// connector once with the arguments the ask implies. At 65be81d5 every one of these is refused
// grant_not_permitted before any connector is asked, so each positive below is red at base.

















// DESK-R5 / #874: FREE create_event dispatches despite negation; guarded deletion still refuses.















/** P-R9 (F1-5), at the live-session level: a mail result fences the turn, so the write the model makes next
 *  is refused external_text_only; the owner's own next final opens the very next call again. */




// --- OP-R3: the thirty-minute opening memory reaches past the newest three calls ---------------------

test('C-OPENER: a used opener stays remembered after three calls that opened plainly', async t => {
  const h = await harness(t);
  h.store.transaction(tx => seedSummary(tx, 'synthetic-recent-loop', 'The owner said the deposit is still to be paid.',
    NOW - 3_600_000, h.store.assistantId, NOW, 'The owner said the deposit is still to be paid.'));
  const snapshotOf = (liveSessionId: string): string => {
    const row = h.store.transaction(tx => tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [liveSessionId]))!;
    return (JSON.parse(String(row['accepted_prompt_snapshot'])) as { system: string }).system;
  };
  const spoke = (liveSessionId: string, text: string): void => { h.store.transaction(tx => tx.run(
    'INSERT INTO live_journal(live_session_id,kind,text,payload_bytes,arrived_at) VALUES(?,?,?,0,?)',
    [liveSessionId, 'outputTranscription', text, NOW])); };
  const used = h.owner.create({ idempotencyKey: 'recent-used-1', inputClass: 'ordinary' }, h.ctx);
  const loop = /^- open loop: (.+)$/mu.exec(snapshotOf(used.liveSessionId))?.[1];
  assert.ok(loop !== undefined, 'the first call opens on the stored loop');
  spoke(used.liveSessionId, `You mentioned ${loop}`);
  const plainly = [1, 2, 3].map(index => h.owner.create({ idempotencyKey: `recent-plain-${index}`, inputClass: 'ordinary' }, h.ctx));
  for (const session of plainly) spoke(session.liveSessionId, 'Morning.');
  const history = h.store.transaction(tx => previousOpeners(tx, h.store.assistantId, ['ordinary'], NOW - 30 * 60 * 1000));
  assert.equal(history.previous.length, 3, 'the note still carries the three newest openers');
  assert.equal(history.recent.length, 1, 'and the opening used four calls ago is still inside the window');
});


test('finalized owner input invokes the task worker without a delegation or promise', async t => {
  const p = progressPort(); const inputs: string[] = [];
  const h = await harness(t, { port: p.port, provider: 'openai', taskInfer: async request => { inputs.push(request.input); return { text: '', calls: [], no_action: true }; } });
  const { session } = await openPort(h, 'task-final');
  p.emit({ type: 'inputTranscription', text: 'Synthetic finalized request', finished: true, finalOrigin: 'provider' });
  await settlePort();
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0]?.includes('Synthetic finalized request'));
  assert.equal(h.owner.get(session.liveSessionId).terminal, null);
});


test('live deletion cannot confirm in its staging owner turn', async t => {
  let deletes = 0; const p = progressPort();
  const h = await harness(t, { port: p.port, provider: 'openai',
    taskExecutors: { delete_event: async () => { deletes++; return { status: 'ok', text: 'Deleted.', references: [], next_cursor: null, coverage: 'Synthetic deletion.', repair: null }; } },
    taskInfer: async request => request.turns.length < 2 ? { text: '', calls: [{ id: `delete-${request.turns.length}`, name: 'delete_event', args: { id: 'synthetic-event' } }] } : { text: 'Please confirm the synthetic event.', calls: [] },
  });
  await openPort(h, 'task-same-turn'); p.emit({ type: 'inputTranscription', text: 'Delete the synthetic event', finished: true, finalOrigin: 'provider' });
  await settlePort(); assert.equal(deletes, 0);
});
test('live deletion confirmation on a later finalized owner turn commits once', async t => {
  let deletes = 0; const p = progressPort();
  const h = await harness(t, { port: p.port, provider: 'openai',
    taskExecutors: { delete_event: async () => { deletes++; return { status: 'ok', text: 'Deleted.', references: [], next_cursor: null, coverage: 'Synthetic deletion.', repair: null }; } },
    taskInfer: async request => request.turns.length === 0 ? { text: '', calls: [{ id: 'delete', name: 'delete_event', args: { id: 'synthetic-event' } }] } : { text: 'Synthetic task settled.', calls: [] },
  });
  await openPort(h, 'task-later-turn'); p.emit({ type: 'inputTranscription', text: 'Delete the synthetic event', finished: true, finalOrigin: 'provider' });
  await settlePort(); assert.equal(deletes, 0);
  p.emit({ type: 'inputTranscription', text: 'Yes, delete it', finished: true, finalOrigin: 'provider' });
  await settlePort(); assert.equal(deletes, 1);
});

test('a pending task owns silence without an old tool batch or background job', async t => {
  const p = progressPort(), scheduler = new DeadlineClock(), entered = deferred<void>(), release = deferred<void>();
  const h = await harness(t, { port: p.port, provider: 'openai', scheduler,
    limits: { idleMs: 60000, sessionMs: 120000 }, taskInfer: async () => {
      entered.resolve(); await release.promise; return { text: 'The synthetic work finished.', calls: [] };
    } });
  const { session, attachment } = await openPort(h, 'task-silence');
  consumeTaskPort(t, attachment);
  p.emit({ type: 'delegation', delegationId: 'pending-binding' });
  p.emit({ type: 'inputTranscription', text: 'Check the synthetic facts', finished: true, finalOrigin: 'provider' });
  await fixtureSettled(entered.promise, 'pending worker');
  h.advance(3000); scheduler.runDue(); await settlePort();
  assert.equal(h.owner.get(session.liveSessionId).terminal, null, 'a pending worker is not a lost model response');
  assert.equal(p.sessionsOpened, 1, 'the watchdog must not recreate a socket during worker inference');
  assert.equal(p.taskAnswers.length, 0);
  release.resolve(); await settlePort();
  assert.equal(p.taskAnswers[0]?.text, 'The synthetic work finished.');
});

test('barge-in and a finalized correction suppress the old answer and keep only current work', async t => {
  const p = progressPort(), entered = deferred<void>(), release = deferred<void>();
  const signals: AbortSignal[] = []; let inferences = 0;
  const h = await harness(t, { port: p.port, provider: 'openai', taskInfer: async (_request, signal) => {
    signals.push(signal); inferences++;
    if (inferences === 1) { entered.resolve(); await release.promise; return { text: 'STALE synthetic answer.', calls: [] }; }
    return { text: 'The corrected synthetic answer.', calls: [] };
  } });
  const { attachment } = await openPort(h, 'task-correction');
  consumeTaskPort(t, attachment);
  p.emit({ type: 'delegation', delegationId: 'old-binding' });
  p.emit({ type: 'inputTranscription', text: 'Check the first synthetic fact', finished: true, finalOrigin: 'provider' });
  await fixtureSettled(entered.promise, 'first worker');
  p.emit({ type: 'interrupted' });
  p.emit({ type: 'inputTranscription', text: 'No, check the corrected fact', finished: true, finalOrigin: 'provider' });
  p.emit({ type: 'delegation', delegationId: 'corrected-binding' });
  await settlePort(); release.resolve(); await settlePort();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(inferences, 2);
  assert.equal(p.taskAnswers.length, 1);
  assert.equal(p.taskAnswers[0]?.text, 'The corrected synthetic answer.');
  assert.equal(p.taskAnswers[0]?.delegationId, 'corrected-binding');
});

test('a socket rebuild retains pending work and answers only the fresh delegation', async t => {
  const p = fakeLiveVoicePort({ provider: 'openai', supportsGoAway: true, supportsInterruption: true }), scheduler = new DeadlineClock(), entered = deferred<void>(), release = deferred<void>();
  let inferences = 0;
  const h = await harness(t, { port: p.port, provider: 'openai', scheduler,
    limits: { idleMs: 60000, sessionMs: 120000 }, taskInfer: async () => {
      inferences++; entered.resolve(); await release.promise; return { text: 'The retained synthetic result.', calls: [] };
    } });
  const { attachment } = await openPort(h, 'task-rebuild');
  consumeTaskPort(t, attachment);
  p.emit({ type: 'delegation', delegationId: 'old-binding' });
  p.emit({ type: 'inputTranscription', text: 'Read the synthetic record', finished: true, finalOrigin: 'provider' });
  await fixtureSettled(entered.promise, 'retained worker');
  p.emit({ type: 'goAway', timeLeftMs: 10000 });
  await advanceUntil(h.advance, scheduler, () => p.sessionsOpened === 2);
  assert.equal(p.sessionsOpened, 2);
  p.emit({ type: 'delegation', delegationId: 'fresh-binding' });
  await settlePort(); release.resolve(); await settlePort();
  assert.equal(inferences, 1, 'socket rebuild must not redispatch a task or an effect');
  assert.equal(p.taskAnswers.length, 1);
  assert.equal(p.taskAnswers[0]?.delegationId, 'fresh-binding');
  assert.equal(p.taskAnswers[0]?.text, 'The retained synthetic result.');
});

function consumeTaskPort(t: TestContext, attachment: Awaited<ReturnType<typeof openPort>>['attachment']): void {
  const drained = (async () => { for await (const chunk of attachment.output) void chunk; })();
  t.after(() => drained);
}


test('real OpenAI wire: finalized owner speech starts the helper and client commentary carries its exact answer', async t => {
  const clock = new OpenAiClock(); let inferences = 0;
  const h = await harness(t, { provider: 'openai',
    portFactory: socketFactory => new OpenAiLiveVoiceAdapter(openAiOptions({ socketFactory, clock })),
    taskInfer: async request => { inferences++; assert.match(request.input, /synthetic wire question/); return { text: 'The exact synthetic wire answer.', calls: [] }; },
  });
  const session = h.owner.create({ idempotencyKey: 'real-openai-task-wire', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach(session.liveSessionId, h.ctx); consumeTaskPort(t, attachment);
  await h.f.frame(1); h.f.send({ type: 'session.started', session: { id: 'synthetic-wire-session' } });
  await fixtureSettled(attachment.ready, 'real OpenAI session started');
  assert.deepEqual((h.f.frames[0] as unknown as { session: { delegation: unknown } }).session.delegation, { type: 'client' });
  h.f.send({ type: 'session.delegation.created', delegation: { id: 'synthetic-wire-binding' } });
  h.f.send({ type: 'session.input_transcript.delta', delta: 'Answer the synthetic wire question.' });
  await fixtureUntil(() => h.store.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM live_events WHERE kind='inputTranscription'")?.n)) > 0, 'owner transcript on real wire');
  // The actual adapter's ordinary sentence-ending quiet window is 700 ms, advanced virtually.
  clock.advance(700);
  await fixtureUntil(() => h.f.frames.some(frame => (frame as unknown as { type?: string }).type === 'session.commentary.append'), 'real OpenAI helper answer');
  const command = h.f.frames.find(frame => (frame as unknown as { type?: string }).type === 'session.commentary.append') as unknown as Record<string, unknown>;
  assert.equal(command['content'], 'The exact synthetic wire answer.'); assert.equal(command['delegation_id'], 'synthetic-wire-binding'); assert.equal(inferences, 1);
  assert.equal(h.f.frames.some(frame => /^response\./.test(String((frame as unknown as { type?: string }).type))), false);
  h.f.send({ type: 'session.commentary.appended', client_event_id: command['event_id'] });
  h.f.send({ type: 'session.output_transcript.delta', delta: 'The exact synthetic wire answer.' });
  await fixtureUntil(() => h.store.transaction(tx => Number(tx.get("SELECT COUNT(*) AS n FROM live_events WHERE kind='outputTranscription'")?.n)) > 0, 'heard answer on real wire');
});
