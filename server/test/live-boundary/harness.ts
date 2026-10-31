import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpAdapter } from '../../adapters/mcp/adapter.js';
import { canonicalToolDigest, McpRegistry } from '../../adapters/mcp/registry.js';
import { MemoryResultStore } from '../../adapters/mcp/store.js';
import type { JsonObject } from '../../adapters/model/types.js';
import { chatMigrations } from '../../chat/index.js';
import { domainMigrations } from '../../domain/schema.js';
import { liveProfileIdentity } from '../../live/config.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../../live/index.js';
import { Store } from '../../runtime/store.js';
import { createToolsOwner, toolsMigrations } from '../../tools/index.js';
import type { WebEvidence, WebSearchPort } from '../../tools/web-search.js';
import { createLuxWriteTransport } from '../../adapters/lux-write/client.js';
import { attachHostLogSink } from '../../tools/host-events.js';
import { TrelloBoard, type TrelloTransport } from '../../tools/trello.js';
import { trelloSchemas } from '../../adapters/trello/client.js';
import { fakeLiveVoicePort, type FakeLiveVoice } from '../fixtures/fake-live-voice.js';

/**
 * C-EVALS: the live boundary, not the handlers. This harness builds the session the host builds
 * (`createLiveSessionOwner` with its catalogue, grants, declarations, owner-final observation and the
 * dispatch path `runToolCalls`), and replaces exactly two things: the provider transport (a scripted
 * fake realtime port) and the connector I/O (in-process MCP fixtures that record every dispatched call).
 *
 * Nothing here re-implements a decision: a scenario scripts what the provider said and what the model
 * called, and the session under test decides. That is what makes a green unit test unable to hide a
 * refusing live gate.
 */

const MODEL = 'gpt-live-boundary-test';
export const SYNTHETIC_NOW = 1_700_000_000_000;

export type BoundaryConnector = 'calendar' | 'mail' | 'chat' | 'knowledge' | 'trello' | 'vault';
/** The connector families a boundary can publish, by connection id. */
export type FixtureId = 'calendar' | 'calendar-write' | 'mail' | 'drafts' | 'chat' | 'knowledge';
export const DEFAULT_FAMILIES: readonly FixtureId[] = ['calendar', 'mail', 'chat', 'knowledge', 'drafts'];
/** One call a connector actually received: the exact arguments the host dispatched. */
export interface ConnectorCall { readonly connector: BoundaryConnector; readonly tool: string; readonly args: JsonObject }

/** A connector endpoint's answers: keyed by tool name, so a scenario scripts its own synthetic data. */
export type ConnectorData = Record<string, JsonObject>;

export interface BoundaryOptions {
  /** The synthetic data each connector answers with. Absent tools answer a synthetic default. */
  data?: Partial<Record<BoundaryConnector, ConnectorData>>;
  /**
   * The connector families this boundary publishes. One google write family per boundary, because the
   * readonly `google_identity` consent probe may be granted once: the host refuses an ambiguous model
   * tool name, so a calendar-write scenario and a draft scenario each get their own boundary.
   */
  families?: readonly FixtureId[];
  /** `owner-trusted-reads` is the host's own mode; `explicit` withholds the write grants. */
  grantMode?: 'explicit' | 'owner-trusted-reads';
  /**
   * Bind the owner's vault writer over a recording fake fetch, the way server/test/vault-write.test.ts does:
   * the production client, a loopback URL, and no socket. A note save then lands in the recorded call.
   */
  vault?: boolean;
  /** Bind the owner's Trello board service over a recording fake transport, so a trello write can land. */
  trello?: boolean;
  /**
   * Connectors whose I/O is deliberately unreachable: the fixture answers nothing and records nothing, so a
   * scenario that expects its dispatch must fail. The non-vacuity probe uses this, and it holds whatever the
   * grant layer decides, because the break sits at the connector, not at the host's authority.
   */
  breakConnectors?: readonly BoundaryConnector[];
  /** The web answer the research tool's web pass returns, so an injection can arrive as a web result. */
  researchWeb?: WebSearchPort;
}

export interface Boundary {
  readonly store: Store;
  readonly owner: LiveSessionOwner;
  readonly fake: FakeLiveVoice;
  readonly calls: ConnectorCall[];
  /** The tool names the session declared to the provider on the latest request. */
  declarations(): readonly string[];
  /** Every provider request this call opened, so a rebuild is visible as a second one. */
  readonly requests: FakeLiveVoice['requests'];
  ownerFinal(text: string): Promise<void>;
  filler(text?: string): Promise<void>;
  turnComplete(): Promise<void>;
  /** One model tool call; resolves with the response the provider was handed, if any. */
  toolCall(name: string, args: JsonObject, id?: string): Promise<JsonObject | undefined>;
  /**
   * One model tool call that may legitimately stay unanswered (a staged note answers across turns).
   * Bounded: it returns undefined rather than waiting on a response that never comes.
   */
  maybeToolCall(name: string, args: JsonObject, id?: string): Promise<JsonObject | undefined>;
  /** The host's own log events, so a scenario can assert on a decision the session made, not on a proxy. */
  readonly events: readonly Record<string, unknown>[];
  /** Every tool response the provider received, flattened, in the order it was answered. */
  toolResponses(): readonly { id: string; name: string; response: JsonObject }[];
  dispatched(connector: BoundaryConnector, tool: string): readonly ConnectorCall[];
  /** The model's own speech (no audio), as the provider would deliver it. */
  emitTurnText(text: string): Promise<void>;
  /** The provider call id of the last model tool call, so a scenario can replay it. */
  lastCallId(): string | undefined;
  /** The provider dropped the line; the host rebuilds and opens a second provider session. */
  rebuild(timeLeftMs?: number): Promise<void>;
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  /** Settles until the condition holds, or reports the condition as unmet (never a real timer). */
  until(condition: () => boolean, label: string): Promise<void>;
  close(): Promise<void>;
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** The port delivers on microtask boundaries, so every emitted event is settled before the next one. */
async function drain(): Promise<void> { for (let index = 0; index < 24; index += 1) await tick(); }

/** One connector fixture: a real MCP endpoint over an in-process transport, with recorded calls. */
interface FixtureConnector {
  readonly id: string;
  readonly connector: BoundaryConnector;
  readonly family: 'google' | 'mattermost' | 'knowledge';
  /** The host connector this endpoint is a family of: its envelope, its consent probe, its decoder. */
  readonly protocol: 'google' | 'mattermost' | 'lux-knowledge';
  readonly endpoint: { id: string; url: string; account: string; resource: string };
  readonly schemas: readonly { name: string; description?: string; inputSchema: JsonObject }[];
  readonly defaultData: ConnectorData;
}

const schemas = (names: readonly string[]): { name: string; inputSchema: JsonObject }[] =>
  names.map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));

const CONNECTORS: readonly FixtureConnector[] = [
  { id: 'calendar', connector: 'calendar', family: 'google', protocol: 'google', endpoint: { id: 'calendar', url: 'https://fixture.invalid/calendar', account: 'synthetic-account', resource: 'synthetic-calendar' },
    schemas: schemas(['calendar_list_events', 'calendar_list_calendars']),
    defaultData: {
      calendar_list_events: { events: [{ id: 'evt_synthetic_1', summary: 'Synthetic standup', start: '2026-10-12T09:00:00Z', end: '2026-10-12T09:15:00Z' }] },
      calendar_list_calendars: { calendars: [{ id: 'primary', summary: 'Synthetic primary' }] },
    } },
  { id: 'calendar-write', connector: 'calendar', family: 'google', protocol: 'google', endpoint: { id: 'calendar-write', url: 'https://fixture.invalid/calendar-write', account: 'synthetic-account', resource: 'synthetic-calendar-write' },
    schemas: schemas(['google_identity', 'calendar_create_event', 'calendar_delete_event']),
    defaultData: {
      calendar_create_event: { event_id: 'evt_synthetic_created', html_link: 'https://calendar.example/synthetic-created' },
      calendar_delete_event: { event_id: 'evt_synthetic_1' },
      google_identity: { account: 'synthetic.person@example.invalid' },
    } },
  { id: 'mail', connector: 'mail', family: 'google', protocol: 'google', endpoint: { id: 'mail', url: 'https://fixture.invalid/mail', account: 'synthetic-account', resource: 'synthetic-mail' },
    schemas: schemas(['gmail_search_messages', 'gmail_read_message']),
    defaultData: {
      gmail_search_messages: { messages: [{ id: 'msg_synthetic_1', subject: 'Synthetic invoice', from: 'synthetic.person@example.invalid' }] },
      gmail_read_message: { id: 'msg_synthetic_1', subject: 'Synthetic invoice', body: 'A synthetic body for the fixture.' },
    } },
  { id: 'drafts', connector: 'mail', family: 'google', protocol: 'google', endpoint: { id: 'drafts', url: 'https://fixture.invalid/drafts', account: 'synthetic-account', resource: 'synthetic-drafts' },
    schemas: schemas(['google_identity', 'gmail_create_draft', 'gmail_create_reply_draft']),
    defaultData: {
      gmail_create_draft: { draft_id: 'draft_synthetic_1' },
      gmail_create_reply_draft: { draft_id: 'draft_synthetic_reply' },
      google_identity: { account: 'synthetic.person@example.invalid' },
    } },
  { id: 'chat', connector: 'chat', family: 'mattermost', protocol: 'mattermost', endpoint: { id: 'chat', url: 'https://fixture.invalid/chat', account: 'synthetic-account', resource: 'synthetic-chat' },
    schemas: schemas(['mattermost_whoami', 'mattermost_list_channels', 'mattermost_search', 'mattermost_save_draft', 'mattermost_list_drafts']),
    defaultData: {
      mattermost_whoami: { username: 'synthetic', display_name: 'Synthetic Owner' },
      mattermost_list_channels: { channels: [{ id: 'chan_synthetic_1', name: 'synthetic-town', display_name: 'Synthetic Town' }] },
      mattermost_search: { posts: [{ id: 'post_synthetic_1', channel: 'synthetic-town', text: 'A synthetic post.' }] },
      mattermost_save_draft: { draft_id: 'draft_chat_synthetic_1' },
      mattermost_list_drafts: { drafts: [] },
    } },
  { id: 'knowledge', connector: 'knowledge', family: 'knowledge', protocol: 'lux-knowledge', endpoint: { id: 'lux', url: 'https://fixture.invalid/mcp', account: 'synthetic-account', resource: 'synthetic-knowledge' },
    schemas: schemas(['search_knowledge', 'get_insight']),
    defaultData: {
      search_knowledge: { results: [{ id: 1, insight_title: 'Synthetic bridge decision', insight_type: 'PATTERN', updated_at: '2026-10-14', content: 'A synthetic knowledge finding.' }] },
      get_insight: { results: [{ id: 1, insight_title: 'Synthetic bridge decision', insight_type: 'PATTERN', updated_at: '2026-10-14', content: 'A synthetic insight.' }] },
    } },
];

/** The envelope each family answers with, so the host's own decoders read it as a connector result. */
function envelope(fixture: FixtureConnector, tool: string, data: JsonObject): string {
  // Each connector's own decoder reads its own wire shape: mattermost and the knowledge service answer the
  // payload itself, the google helper answers the family envelope its reader decodes.
  if (fixture.family === 'mattermost' || fixture.family === 'knowledge') return JSON.stringify(data);
  return JSON.stringify({ family: 'google', tool, data, coverage: { complete: true } });
}

export async function openBoundary(options: BoundaryOptions = {}): Promise<Boundary> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-boundary-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  const clock = { now: SYNTHETIC_NOW };
  const profile = validateLiveProfile({
    provider: 'openai', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'openai', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const fake = fakeLiveVoicePort({ provider: 'openai' });
  const calls: ConnectorCall[] = [];
  const registry = new McpRegistry();
  const published: string[] = [];
  const endpointStates: { id: string; connector: string; state: string }[] = [];
  const servers: { sdk: Server; transport: WebStandardStreamableHTTPServerTransport }[] = [];
  const byUrl = new Map<string, WebStandardStreamableHTTPServerTransport>();

  for (const fixture of CONNECTORS) {
    registry.register(fixture.endpoint);
    registry.enable(fixture.endpoint.id);
    registry.allowEgress(fixture.endpoint.id);
    const sdk = new Server({ name: `live-boundary-${fixture.id}`, version: '1' }, { capabilities: { tools: { listChanged: false } } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    sdk.setRequestHandler('tools/list', () => ({ tools: structuredClone(fixture.schemas) }) as never);
    const broken = (options.breakConnectors ?? []).includes(fixture.connector);
    sdk.setRequestHandler('tools/call', req => {
      const tool = String(req.params.name);
      const args = (req.params.arguments ?? {}) as JsonObject;
      if (broken) return { isError: true, content: [{ type: 'text', text: 'synthetic connector unreachable' }] };
      calls.push({ connector: fixture.connector, tool, args });
      const scripted = options.data?.[fixture.connector]?.[tool];
      const data = scripted ?? fixture.defaultData[tool] ?? { ok: true };
      return { content: [{ type: 'text', text: envelope(fixture, tool, data) }] };
    });
    await sdk.connect(transport);
    servers.push({ sdk, transport });
    byUrl.set(fixture.endpoint.url, transport);
  }

  const events: Record<string, unknown>[] = [];
  const detachLog = attachHostLogSink({ event: raw => { events.push(raw as Record<string, unknown>); } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const routed = byUrl.get(request.url);
    if (routed) return routed.handleRequest(request);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 1 << 20 }) });
  const trello = options.trello === true ? fakeTrello(calls, (options.breakConnectors ?? []).includes('trello')) : undefined;
  const vaultTransport = options.vault === false ? undefined : vaultWriter(calls);
  let owner: LiveSessionOwner | undefined;
  const toolOwner = createToolsOwner({
    store, ownerId: store.assistantId, registry, port,
    ...(options.grantMode === 'explicit' ? {} : { grantMode: 'owner-trusted-reads' as const }),
    lookupAuthority: async runId => owner?.lookupAuthority(runId) ?? null,
    ...(trello ? { trello } : {}),
  });
  const bounds = { maxQueryChars: 200, maxSearchLimit: 20, maxGetIds: 3, maxEntityBytes: 8192, maxResultBytes: 8192 };
  const families = options.families ?? DEFAULT_FAMILIES;
  const connections = families.map(id => ({ connectionId: id, connector: CONNECTORS.find(item => item.id === id)!.protocol }));
  for (const connection of connections) {
    const fixture = CONNECTORS.find(item => item.id === connection.connectionId)!;
    try { toolOwner.applyConnection({ schemaVersion: 1, ownerId: store.assistantId, connectionId: connection.connectionId, generation: 1, enabled: true,
      connector: connection.connector, endpoint: { ...fixture.endpoint, credentialRef: null }, toolNames: fixture.schemas.map(tool => tool.name),
      schemaDigest: canonicalToolDigest(fixture.schemas),
      sourcePolicy: { id: 'live-boundary-fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
      route: { identity: liveProfileIdentity(profile), allowedClasses: ['ordinary'] }, bounds }); } catch (error) { throw new Error(`connection ${connection.connectionId}: ${String(error)}`); }
    const discovered = await port.discover(fixture.endpoint.id);
    if (discovered.state !== 'discovered') throw new Error(`fixture ${fixture.id} did not discover: ${discovered.state}`);
    toolOwner.projectConnection(connection.connectionId);
    published.push(connection.connectionId);
    endpointStates.push({ id: connection.connectionId, connector: connection.connector, state: 'connected' });
  }

  const context: LiveContext = { clientId: 'synthetic-tester', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  owner = createLiveSessionOwner({
    store, voice: fake.port, profile, now: () => clock.now, timeZone: 'UTC',
    tools: { owner: toolOwner, connectionIds: () => [...published], status: () => ({ endpoints: endpointStates.map(state => ({ ...state })) }) },
    ...(options.researchWeb ? { researchWeb: options.researchWeb } : {}),
    ...(vaultTransport ? { vaultTransport } : {}),
  });
  const session = owner.create({ idempotencyKey: `live-boundary-${randomUUID()}`, inputClass: 'ordinary' }, context);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, context);
  await attachment.ready;
  await drain();

  const close = async (): Promise<void> => {
    detachLog();
    globalThis.fetch = originalFetch;
    await owner!.shutdown();
    for (const { sdk, transport } of servers) { await transport.close(); await sdk.close(); }
    await port.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  const emit = async (event: Record<string, unknown>): Promise<void> => { fake.emit(event as never); await drain(); };
  const latestRequest = (): FakeLiveVoice['requests'][number] => fake.requests[fake.requests.length - 1]!;
  let lastCallId: string | undefined;

  return {
    store, owner, fake, calls, events,
    get requests() { return fake.requests; },
    declarations: () => (latestRequest().tools ?? []).map(tool => tool.name),
    ownerFinal: async text => { await emit({ type: 'inputTranscription', text, finished: true, finalOrigin: 'provider' }); },
    filler: async (text = 'Mm-hm, one moment.') => { await emit({ type: 'modelText', text, thought: false }); await emit({ type: 'turnComplete' }); },
    turnComplete: async () => { await emit({ type: 'turnComplete' }); },
    toolCall: async (name, args, id) => {
      const before = fake.toolResponses.flat().length;
      const callId = id ?? `call-${randomUUID()}`;
      lastCallId = callId;
      await emit({ type: 'toolCall', calls: [{ id: callId, name, args }] });
      await until(() => fake.toolResponses.flat().length > before, `a tool response for ${name}`);
      return fake.toolResponses.flat().find(response => response.id === callId)?.response;
    },
    maybeToolCall: async (name, args, id) => {
      const callId = id ?? `call-${randomUUID()}`;
      lastCallId = callId;
      await emit({ type: 'toolCall', calls: [{ id: callId, name, args }] });
      for (let index = 0; index < 60; index += 1) {
        const answered = fake.toolResponses.flat().find(response => response.id === callId);
        if (answered) return answered.response;
        await tick();
      }
      return undefined;
    },
    toolResponses: () => fake.toolResponses.flat(),
    dispatched: (connector, tool) => calls.filter(call => call.connector === connector && call.tool === tool),
    emitTurnText: async text => { await emit({ type: 'modelText', text, thought: false }); },
    lastCallId: () => lastCallId,
    rebuild: async timeLeftMs => {
      const before = fake.sessionsOpened;
      await emit({ type: 'goAway', timeLeftMs: timeLeftMs ?? 5_000 });
      await until(() => fake.sessionsOpened > before, 'the rebuilt provider session');
    },
    advance: async ms => { clock.now += ms; await drain(); },
    settle: drain,
    until: async (condition, label) => {
      await until(condition, label);
    },
    close,
  };
}

/** Settles until the condition holds. A condition that never holds is a failed scenario, not a wait. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 600; index += 1) {
    if (condition()) return;
    await tick();
  }
  if (condition()) return;
  throw new Error(`live boundary: ${label} never happened`);
}

/** One synthetic web answer, so an injection can arrive as a web result rather than from the fixture. */
export function webAnswer(text: string, source = { title: 'Synthetic web result', url: 'https://synthetic.example/article' }): WebSearchPort {
  const evidence: WebEvidence = { answer: text, claims: [{ text, sourceIndexes: [0] }], sources: [source], retrievedAt: '2026-10-31T09:00:00Z' };
  return { search: async () => ({ ok: true, evidence }) };
}

/** The owner's board service over a recording transport: no REST, no key, one entry per dispatched call. */
function fakeTrello(records: ConnectorCall[], broken = false): TrelloBoard {
  const boardId = 'aabbccddeeff001122334455';
  const board = { id: boardId, name: 'Synthetic Board', closed: false };
  const lists = [{ id: '11223344556677889900aabb', name: 'Backlog', closed: false }, { id: '223344556677889900aabbcc', name: 'Done', closed: false }];
  const transport: TrelloTransport = {
    tools: async () => ({ ok: true, value: trelloSchemas() }),
    call: async (tool, args) => {
      if (broken) return { ok: false, code: 'unavailable' };
      records.push({ connector: 'trello', tool, args });
      if (tool === 'trelloReadMember') return { ok: true, value: { id: '3344556677889900aabbccdd', username: 'synthetic', fullName: 'Synthetic Owner' } };
      if (tool === 'trelloReadBoard') return { ok: true, value: { boards: [board] } };
      if (tool === 'trelloReadList') return { ok: true, value: { lists } };
      if (tool === 'trelloReadCard') return { ok: true, value: { cards: [] } };
      if (tool === 'trelloWriteCard') {
        const card = { id: '445566778899aabbccddeeff', name: String(args['name'] ?? 'Synthetic card'), listId: lists[0]!.id, closed: false, desc: '', due: null, dueComplete: false, labels: [] };
        return { ok: true, value: { ...card, card, cards: [card] } };
      }
      return { ok: true, value: {} };
    },
  };
  return new TrelloBoard({ transport, signedIn: () => true, boardName: 'Synthetic Board', timeZone: 'UTC', now: () => SYNTHETIC_NOW });
}

/** The production vault client over a fake fetch: one recorded entry per tool call the writer dispatches. */
function vaultWriter(records: ConnectorCall[]): ReturnType<typeof createLuxWriteTransport> {
  const fakeFetch: typeof fetch = async (_url, init) => {
    const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-vault-session' };
    if (call['method'] === 'notifications/initialized') return new Response(null, { status: 202, headers });
    const params = (call['params'] ?? {}) as { name?: string; arguments?: JsonObject };
    if (call['method'] === 'tools/call' && typeof params.name === 'string') {
      records.push({ connector: 'vault', tool: params.name, args: params.arguments ?? {} });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call['id'], result: call['method'] === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {} }
      : { content: [{ type: 'text', text: JSON.stringify({ action: 'inserted', insight_id: 4242, candidates: [] }) }] } }), { headers });
  };
  return createLuxWriteTransport({ url: 'http://127.0.0.1:12345/mcp' }, fakeFetch);
}
