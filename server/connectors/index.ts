import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { SourceDispatchEvidence, CompletedResult, McpPort, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { DataClass } from '../adapters/model/types.js';
import { HOST_EVIDENCE, type ConnectionEndpoint, type ConnectionPolicy, type ModelSnapshot, type ToolFailureEvent } from '../tools/types.js';
import { createLuxKnowledgeReader, isCalendarDay, KNOWLEDGE_BODY_MAX_CHARS, KNOWLEDGE_BODY_MIN_CHARS, KNOWLEDGE_DEADLINE_MAX_MS, KNOWLEDGE_DEADLINE_MIN_MS, KNOWLEDGE_SNIPPET_MAX_CHARS, KNOWLEDGE_SNIPPET_MIN_CHARS, LUX_KNOWLEDGE_TOOLS } from './lux-knowledge.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import { createGoogleReader, GOOGLE_TOOLS } from './google.js';
import type { GcalCalendarsInput, GcalListInput, GmailListInput, GmailReadInput, GoogleFamily } from './google.js';
import { googleToolStatus, projectGoogleResult } from '../tools/google.js';
import { createMongooseReader, mongooseEndpointName, MONGOOSE_ENDPOINT_TOOLS, MONGOOSE_READ_TOOLS, type MongooseEndpoint, type SearchInput } from './mongoose.js';
import { createMattermostReader, MATTERMOST_ATTENTION_TOOL, MATTERMOST_DEFAULTS, MATTERMOST_TOOLS } from './mattermost.js';
import { createHash } from 'node:crypto';

import { projectMongooseResult } from '../tools/mongoose.js';
import { projectMattermostResult } from '../tools/mattermost.js';
import { calendarIdentityValues, gmailIdentityValues, mattermostIdentityValues, mongooseIdentityValues, type IdentitySource } from './identity.js';

export * from './lux-knowledge.js';
export * from './google.js';
export * from './mongoose.js';
export * from './mattermost.js';

/**
 * The locally maintained read candidate list per connector. The host approves exactly these names
 * under owner-trusted-reads, and for Mongoose the discovery-time annotation classifier narrows the
 * list further. One line per connector.
 */
export const CONNECTOR_ENVELOPES: Readonly<Record<string, readonly string[]>> = {
  'lux-knowledge': LUX_KNOWLEDGE_TOOLS,
  'google': GOOGLE_TOOLS,
  'mongoose': MONGOOSE_READ_TOOLS,
  'mattermost': MATTERMOST_TOOLS,
};

/** Transport-neutral evidence handed from a connector reader to its projector. */
export interface ConnectorEvidence extends SourceDispatchEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  tool: string;
  source: ResultScope;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
  /** The verified second read a reader asked for after a hit (Mongoose depth reads only). */
  followUp?: { tool: string; decodedResult: unknown; payload: StoredPayload };
}
export type ConnectorResult = ConnectorEvidence | { state: 'refused' | 'unknown'; reason: string };

export interface ConnectorReader {
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectorResult>;
}
export interface ConnectorToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: 'read';
  /** One-try guidance shown when the model sends an unusable argument shape. */
  guidance?: string;
  /** Boundary normalization applied before validation and dispatch; undefined refuses the shape. */
  normalize?(args: unknown): { args: Record<string, unknown>; notice?: string } | undefined;
  validate(args: unknown): boolean;
}
export interface ConnectorDescriptor {
  id: string;
  envelope: readonly string[];
  /** The connector's tool table for one approved policy (bounds may shape the schemas). */
  declarations(policy: ConnectionPolicy): readonly ConnectorToolDeclaration[];
  /** A per-connection reader bound to the approved endpoint, digest and generation. */
  createReader(input: { port: McpPort; registry: McpRegistry; endpoint: ConnectionEndpoint; schemaDigest: string; generation: number; policy: ConnectionPolicy }): ConnectorReader;
  /** Model-visible projection of one completed result, using only locally accepted data. */
  project(evidence: ConnectorEvidence, port: McpPort, policy: ConnectionPolicy): ModelSnapshot;
  /** Connection status for a non-completed result, when the connector can classify it (R4). A classified
   * failure may also carry the one content-free log line the host must write for it. */
  status?(evidence: ConnectorEvidence): { state: 'configured'; reason: string; log?: ToolFailureEvent } | undefined;
  /** The connector's own-account identity probe for one approved policy, when it has one (release 3f). */
  identity?(policy: ConnectionPolicy): IdentitySource | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toInsightId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value === 'string') {
    // Accept an integer-valued numeric string, and the `#123`/`lux 123` forms the search result text uses.
    const match = /^(?:#\s*|lux\s+)?(\d+)(?:\.0+)?$/i.exec(value.trim());
    if (!match) return undefined;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

/** Split a string that holds several ids: JSON array text, or comma/semicolon/whitespace separated tokens. */
function splitInsightIdText(text: string): unknown[] | undefined {
  const trimmed = text.trim();
  let tokens: unknown[] | undefined;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) tokens = parsed;
    } catch { /* not JSON array text; fall back to a delimiter split */ }
  }
  if (tokens === undefined) tokens = trimmed.split(/[,;\s]+/);
  // Only a string carrying several ids is split; a single value (or single-element array text) stays whole.
  return tokens.length >= 2 ? tokens : undefined;
}

/** A bounded, value-free label for one dropped argument, so the model can correct itself. */
function droppedLabel(value: unknown): string {
  const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) ?? String(value); } catch { return 'unreadable'; } })();
  return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}

/** Normalize get_insight arguments before validation: accept an id array, a single id, or the `id` alias. */
/** Normalize get_insight arguments before validation: accept an id array, a single id, the `id` alias
 * or a bare id in any servable form, pass `include_links` through, and drop unknown read keys or
 * unreadable ids with a visible notice instead of refusing. */
export function normalizeGetInsightArgs(args: unknown, maxGetIds: number): { args: { ids: number[]; include_links?: boolean }; notice?: string } | undefined {
  let candidate: unknown;
  let includeLinks: boolean | undefined;
  const droppedKeys: string[] = [];
  if (Array.isArray(args) || typeof args === 'number' || typeof args === 'string') candidate = args;
  else if (isRecord(args)) {
    for (const key of Object.keys(args)) if (key !== 'ids' && key !== 'id' && key !== 'include_links') droppedKeys.push(key);
    if ('include_links' in args) {
      if (typeof args['include_links'] === 'boolean') includeLinks = args['include_links'];
      else droppedKeys.push('include_links');
    }
    if ('ids' in args && 'id' in args) return undefined;
    if ('ids' in args) candidate = args['ids'];
    else if ('id' in args) candidate = args['id'];
    else return undefined;
  } else return undefined;
  const list = Array.isArray(candidate)
    ? candidate
    : typeof candidate === 'string' && toInsightId(candidate) === undefined
      ? splitInsightIdText(candidate) ?? [candidate]
      : [candidate];
  const ids: number[] = [];
  const droppedIds: unknown[] = [];
  for (const item of list) {
    const id = toInsightId(item);
    if (id === undefined) { droppedIds.push(item); continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return undefined;
  const notices: string[] = [];
  if (droppedIds.length > 0) notices.push(`Ignored ${droppedIds.length} unreadable id${droppedIds.length === 1 ? '' : 's'}: ${droppedIds.map(droppedLabel).join(', ')}.`);
  if (droppedKeys.length > 0) notices.push(`Ignored unknown argument${droppedKeys.length === 1 ? '' : 's'}: ${droppedKeys.join(', ')}.`);
  let capped = ids;
  if (ids.length > maxGetIds) {
    capped = ids.slice(0, maxGetIds);
    notices.push(`Only the first ${maxGetIds} of ${ids.length} requested ids were fetched.`);
  }
  const prepared: { ids: number[]; include_links?: boolean } = includeLinks === undefined ? { ids: capped } : { ids: capped, include_links: includeLinks };
  return notices.length === 0 ? { args: prepared } : { args: prepared, notice: notices.join(' ') };
}

const luxKnowledgeDescriptor: ConnectorDescriptor = {
  id: 'lux-knowledge',
  envelope: LUX_KNOWLEDGE_TOOLS,
  declarations(policy) {
    const bounds = policy.bounds;
    return [
      {
        name: 'search_knowledge',
        description: 'Search the owner knowledge base. Pass 2 to 5 core terms, not a sentence; returns matching entry ids with short excerpts. Fetch an entry by id with get_insight for the full body. Returns the top 3 entries with 400-character bodies; call get_insight only to read one entry in full.',
        effect: 'read',
        parameters: {
          type: 'object', additionalProperties: false, required: ['query', 'limit'],
          properties: { query: { type: 'string', minLength: 1, maxLength: bounds.maxQueryChars, description: 'Two to five core terms: names, projects and exact technical words, never conversational filler.' }, limit: { type: 'integer', minimum: 1, maximum: bounds.maxSearchLimit, description: 'How many results to return, within the configured search cap.' } },
        },
        validate(args) {
          if (!isRecord(args)) return false;
          const keys = Object.keys(args);
          // 3r K1: the bounded-body fields are accepted from the research path, which is the voice
          // lookup. They are not offered in `parameters`, so the text-chat call shape is unchanged.
          // K4 (#1021): a project tag or hint from the research path travels the same way, and never
          // widens the text-chat call shape, because neither key is offered in `parameters`.
          // MED-1022: the voice shape and the meeting day travel the same way, accepted here and never
          // offered in `parameters`, so the text-chat call shape is unchanged.
          if (!keys.every(key => key === 'query' || key === 'limit' || key === 'detail' || key === 'max_chars' || key === 'deadline_ms' || key === 'project' || key === 'project_hint'
            || key === 'snippet_chars' || key === 'meeting_date_from' || key === 'meeting_date_to')) return false;
          if (!keys.includes('query') || !keys.includes('limit')) return false;
          const query = args['query']; const limit = args['limit'];
          if (!(typeof query === 'string' && query.trim().length > 0 && query.length <= bounds.maxQueryChars && Number.isSafeInteger(limit) && (limit as number) > 0 && (limit as number) <= bounds.maxSearchLimit)) return false;
          const detail = args['detail']; const maxChars = args['max_chars']; const deadlineMs = args['deadline_ms'];
          if (detail !== undefined && detail !== 'snippets' && detail !== 'bodies' && detail !== 'voice') return false;
          if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || (maxChars as number) < KNOWLEDGE_BODY_MIN_CHARS || (maxChars as number) > KNOWLEDGE_BODY_MAX_CHARS)) return false;
          if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || (deadlineMs as number) < KNOWLEDGE_DEADLINE_MIN_MS || (deadlineMs as number) > KNOWLEDGE_DEADLINE_MAX_MS)) return false;
          // K4: a tag is one corpus project name, never a pattern the model composed.
          const projectName = (value: unknown): boolean => value === undefined || (typeof value === 'string' && /^[\w.@-]{1,64}$/u.test(value));
          if (!projectName(args['project']) || !projectName(args['project_hint'])) return false;
          const snippetChars = args['snippet_chars'];
          if (snippetChars !== undefined && (!Number.isSafeInteger(snippetChars) || (snippetChars as number) < KNOWLEDGE_SNIPPET_MIN_CHARS || (snippetChars as number) > KNOWLEDGE_SNIPPET_MAX_CHARS)) return false;
          // MED-1022: the day bounds are two calendar days, never a date expression.
          if (!isCalendarDay(args['meeting_date_from']) || !isCalendarDay(args['meeting_date_to'])) return false;
          return true;
        },
      },
      {
        name: 'get_insight',
        description: 'Read full knowledge-base entries by id. Pass one to three entry ids from a knowledge search; requested ids are unverified input. Returns each whole entry.',
        effect: 'read',
        guidance: 'Needs ids as a list of entry ids from the knowledge search results, like {"ids": [89820, 89933]}.',
        parameters: {
          // A read tool drops an unknown key instead of refusing it, so the schema admits extra
          // keys and names `include_links`; the validator accepts exactly these and drops the rest.
          type: 'object', additionalProperties: true, required: ['ids'],
          properties: {
            ids: { type: 'array', minItems: 1, maxItems: bounds.maxGetIds, uniqueItems: true, items: { type: 'integer', minimum: 1 }, description: 'One or more entry ids from a knowledge search. A single id, an integer-valued numeric string, the "#123"/"lux 123" form, or one such string holding several ids separated by comma, semicolon or whitespace (or JSON array text) is accepted; unreadable ids are dropped and named.' },
            include_links: { type: 'boolean', description: 'Ask the knowledge server to include linked entries in the result.' },
          },
        },
        normalize(args) { return normalizeGetInsightArgs(args, bounds.maxGetIds); },
        validate(args) { return normalizeGetInsightArgs(args, bounds.maxGetIds) !== undefined; },
      },
    ];
  },
  createReader({ port, registry, policy }) {
    const reader = createLuxKnowledgeReader({
      port, registry,
      config: { endpointId: policy.endpoint.id, account: policy.endpoint.account, resource: policy.endpoint.resource, schemaDigest: policy.schemaDigest, generation: policy.generation, includeSensitive: policy.sourcePolicy.unknownClass === 'sensitive' && policy.sourcePolicy.allowedClasses.includes('sensitive') && policy.route.allowedClasses.includes('sensitive'), ...policy.bounds },
    });
    return {
      async call(tool, args, signal) {
        if (tool !== 'search_knowledge') return await reader.get(args as { ids: number[]; include_links?: boolean }, signal);
        // The declaration speaks the wire names; the reader takes the connector's own field names.
        const search = args as {
          query: string; limit: number; detail?: 'snippets' | 'bodies' | 'voice'; max_chars?: number; deadline_ms?: number;
          project?: string; project_hint?: string; snippet_chars?: number; meeting_date_from?: string; meeting_date_to?: string;
        };
        return await reader.search({
          query: search.query, limit: search.limit,
          ...(search.detail === undefined ? {} : { detail: search.detail }),
          ...(search.max_chars === undefined ? {} : { maxChars: search.max_chars }),
          ...(search.deadline_ms === undefined ? {} : { deadlineMs: search.deadline_ms }),
          ...(search.project === undefined ? {} : { project: search.project }),
          ...(search.project_hint === undefined ? {} : { projectHint: search.project_hint }),
          ...(search.snippet_chars === undefined ? {} : { snippetChars: search.snippet_chars }),
          ...(search.meeting_date_from === undefined ? {} : { meetingDateFrom: search.meeting_date_from }),
          ...(search.meeting_date_to === undefined ? {} : { meetingDateTo: search.meeting_date_to }),
        }, signal);
      },
    };
  },
  project(evidence, port, policy) {
    return projectLuxResult(evidence, policy, port);
  },
};

function googleFamily(toolNames: readonly string[]): GoogleFamily {
  return toolNames.some(name => name.startsWith('calendar_')) ? 'calendar' : 'gmail';
}
function googleProject(evidence: ConnectorEvidence, port: McpPort, policy: ConnectionPolicy): ModelSnapshot {
  const projection = projectGoogleResult(port, evidence);
  if (!projection.ok) throw Error('result_projection_failed');
  const unknownClass = policy.sourcePolicy.unknownClass;
  if (!unknownClass) throw Error('unknown_source_denied');
  return {
    response: {
      tool: evidence.tool,
      ...(projection.projection.mailPage ? { mailPage: projection.projection.mailPage } : {}),
      ...(projection.projection.calendarPage ? { calendarPage: projection.projection.calendarPage } : {}),
      ...(projection.projection.calendarScope ? { calendarScope: projection.projection.calendarScope } : {}),
      text: projection.projection.text,
      partial: projection.projection.partial,
      originalCharacters: projection.projection.originalCharacters,
      omittedCharacters: projection.projection.omittedCharacters,
      ...(projection.projection.sources ? { sources: projection.projection.sources } : {}),
    },
    dataClasses: [unknownClass] as DataClass[],
    ...(projection.projection[HOST_EVIDENCE] ? { [HOST_EVIDENCE]: projection.projection[HOST_EVIDENCE] } : {}),
  };
}
function googleStatus(evidence: ConnectorEvidence): { state: 'configured'; reason: string; log?: ToolFailureEvent } | undefined {
  const status = googleToolStatus(evidence);
  return status && status.state === 'configured' ? { state: 'configured', reason: status.reason, ...(status.log ? { log: status.log } : {}) } : undefined;
}
const googleDescriptor: ConnectorDescriptor = {
  id: 'google',
  envelope: GOOGLE_TOOLS,
  declarations() {
    const listProps = { maxResults: { type: 'integer', minimum: 1, maximum: 50 }, pageToken: { type: 'string', minLength: 1 } };
    return [
      { name: 'gmail_get_profile', description: 'Read the Gmail profile of the selected binding.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: {} }, validate: args => isRecord(args) && Object.keys(args).length === 0 },
      { name: 'gmail_search_messages', description: 'List Gmail messages matching a Gmail query, newest first. q uses Gmail operators, for example from:name after:2026/10/07 or subject:(board deck) is:unread. Returns message ids; read the full message with gmail_read_message. Returns at most 5 messages with 300-character excerpts.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, q: { type: 'string', minLength: 1, description: 'Gmail search query using Gmail operators.' } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'q'].includes(key)) },
      { name: 'gmail_read_message', description: 'Read one full Gmail message by id from gmail_search_messages: subject, from, date and body. Returns the body up to 1500 characters.', effect: 'read', parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 }, format: { type: 'string', enum: ['metadata', 'full'] } } }, validate: args => isRecord(args) && typeof args['id'] === 'string' && (args['id'] as string).length > 0 && Object.keys(args).every(key => ['id', 'format'].includes(key)) },
      { name: 'calendar_list_calendars', description: 'List the calendars visible to the selected binding. Returns names only, no events. Call it only when the owner asks which calendars exist; an event read needs no calendar list.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: listProps }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken'].includes(key)) },
      { name: 'calendar_list_events', description: 'List events on one calendar in a time window. timeMin and timeMax are RFC3339 timestamps with the offset from the runtime context; pass exact start and end instead of asking for a date. Omit both for today in the host timezone. Returns time, title, location, attendees and organizer. Returns at most 8 events of 300 characters with up to eight attendee names, without dial-in text.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, calendarId: { type: 'string', minLength: 1, description: 'Calendar id; defaults to the primary calendar.' }, timeMin: { type: 'string', minLength: 1, description: 'Window start, RFC3339 with the runtime timezone offset.' }, timeMax: { type: 'string', minLength: 1, description: 'Window end, RFC3339 with the runtime timezone offset.' }, deadlineAt: { type: 'number', description: "Internal: the caller's remaining source budget as an absolute epoch ms. The host sets it; a model call never needs it." } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'calendarId', 'timeMin', 'timeMax', 'deadlineAt'].includes(key)) },
    ];
  },
  createReader({ port, registry, policy }) {
    const reader = createGoogleReader({
      port, registry,
      config: { endpointId: policy.endpoint.id, account: policy.endpoint.account, resource: policy.endpoint.resource, schemaDigest: policy.schemaDigest, generation: policy.generation, family: googleFamily(policy.toolNames) },
    });
    return {
      async call(tool, args, signal) {
        if (tool === 'gmail_get_profile') return await reader.gmailProfile(signal);
        if (tool === 'gmail_search_messages') return await reader.gmailList(args as GmailListInput, signal);
        if (tool === 'gmail_read_message') return await reader.gmailRead(args as unknown as GmailReadInput, signal);
        if (tool === 'calendar_list_calendars') return await reader.gcalCalendars(args as GcalCalendarsInput, signal);
        return await reader.gcalList(args as GcalListInput, signal);
      },
    };
  },
  project: googleProject,
  status: googleStatus,
  identity(policy) {
    return googleFamily(policy.toolNames) === 'calendar'
      ? { tool: 'calendar_list_calendars', args: {}, values: calendarIdentityValues, strict: true }
      : { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues, strict: true };
  },
};

/** A local composition defect, distinct from a remote connector failure. */
export class ConnectorCompositionError extends Error {
  constructor(public readonly code: 'unknown_connector' | 'unknown_connector_tool' | 'ambiguous_model_tool_name', public readonly connectionId: string, public readonly connector: string) {
    super(`Connector composition error: ${code} (${connectionId}, ${connector})`);
    this.name = 'ConnectorCompositionError';
  }
}

/** Company readers accept only an optional bounded limit and one required text field. */
const isText = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const isCount = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** A declaration whose tool takes more than one text field and a limit: the Mattermost read surface. */
/**
 * #604: a connector's own composite view. It is granted under its own name only when every child
 * read it stands on is granted, and never by a server publishing a name that looks like it.
 */
export interface ConnectorComposedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: { properties: Record<string, unknown>; required: readonly string[] };
  /** The child reads it needs; every one must be granted for the composite to be granted. */
  readonly requires: readonly string[];
  readonly validate: (args: Record<string, unknown>) => boolean;
}

function mattermostDeclaration(name: string, description: string, properties: Record<string, unknown>, required: readonly string[], validate: (args: Record<string, unknown>) => boolean, extra: Pick<ConnectorToolDeclaration, 'normalize' | 'guidance'> = {}): ConnectorToolDeclaration {
  return {
    name, description, effect: 'read',
    parameters: { type: 'object', additionalProperties: false, required: [...required], properties },
    validate(args) { return isRecord(args) && validate(args); },
    ...extra,
  };
}

/** research.ts sends the thread id as post_id; the thread tool takes either spelling of that id. */
function threadPostId(args: Record<string, unknown>): string {
  const value = args['postId'] ?? args['post_id'];
  return typeof value === 'string' ? value.trim() : '';
}
function threadArgs(args: Record<string, unknown>): boolean {
  return Object.keys(args).every(key => key === 'postId' || key === 'post_id') && threadPostId(args) !== '';
}
function searchArgs(args: Record<string, unknown>, maxText: number, maxLimit: number): boolean {
  if (!Object.keys(args).every(key => ['query', 'limit', 'after', 'before', 'channel'].includes(key))) return false;
  if (args['channel'] !== undefined && !isText(args['channel'], 60)) return false;
  if (!isText(args['query'], maxText)) return false;
  if (args['limit'] !== undefined && !isCount(args['limit'], 1, maxLimit)) return false;
  return ['after', 'before'].every(key => args[key] === undefined || isText(args[key], 40));
}
/** The declaration a composed tool publishes; the host digests exactly these fields. */
function composedDeclaration(tool: ConnectorComposedTool): ConnectorToolDeclaration {
  return mattermostDeclaration(tool.name, tool.description, tool.parameters.properties, tool.parameters.required, tool.validate);
}

/** The composed tools each connector may be granted, beside the read tools it publishes. */
export const CONNECTOR_COMPOSED_TOOLS: Readonly<Record<string, readonly ConnectorComposedTool[]>> = {
  mattermost: [{
    name: MATTERMOST_ATTENTION_TOOL,
    description: 'What needs a reply from the owner, newest first: mentions, direct and group messages, and threads the owner posted in or was mentioned in where the newest post is not theirs. Each item carries channel, author, ISO time, permalink and one line. Use it for "do I need to reply", "anything new for me", "what did I miss".',
    parameters: {
      required: [],
      properties: { days: { type: 'integer', minimum: 1, maximum: 30, description: 'Window in days; 7 by default.' }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    },
    requires: MATTERMOST_TOOLS,
    validate: args => attentionArgs(args),
  }],
};

/**
 * The read names one connection may be granted. Mongoose serves three separate endpoints of one
 * connector, each with its own disjoint envelope, so a knowledge grant never names a data or crm
 * read and the three connections declare no shared tool.
 */
export function connectionEnvelope(connector: string, endpoint: { resource: string; url?: unknown } | undefined): readonly string[] {
  if (connector !== 'mongoose') return CONNECTOR_ENVELOPES[connector] ?? [];
  if (endpoint === undefined) return [];
  const byResource = mongooseEndpointName(endpoint.resource);
  const name = byResource ?? (typeof endpoint.url === 'string' ? mongooseEndpointName(endpoint.url) : undefined);
  return name === undefined ? [] : MONGOOSE_ENDPOINT_TOOLS[name];
}

/** The composed names a connector may hold, given the child names it already holds. */
export function composedGrantedNames(connector: string, granted: readonly string[]): string[] {
  const present = new Set(granted);
  return (CONNECTOR_COMPOSED_TOOLS[connector] ?? []).filter(tool => tool.requires.every(name => present.has(name))).map(tool => tool.name);
}

/** One composed tool's declaration, by name; absent for a name the connector does not own. */
export function composedToolDeclaration(connector: string, name: string): ConnectorToolDeclaration | undefined {
  const tool = (CONNECTOR_COMPOSED_TOOLS[connector] ?? []).find(candidate => candidate.name === name);
  return tool === undefined ? undefined : composedDeclaration(tool);
}

/**
 * #604: the host-computed digest of a composed declaration, so a changed composite is a catalog
 * change the owner approval covers and a later review can compare.
 */
export function composedDeclarationDigest(tool: ConnectorComposedTool): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, canonical(entry)]));
    return value;
  };
  const body = { name: tool.name, description: tool.description, parameters: tool.parameters, requires: [...tool.requires], effect: 'read' };
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

function attentionArgs(args: Record<string, unknown>): boolean {
  if (!Object.keys(args).every(key => key === 'days' || key === 'limit')) return false;
  if (args['days'] !== undefined && !isCount(args['days'], 1, 30)) return false;
  return args['limit'] === undefined || isCount(args['limit'], 1, 20);
}

function companyDeclaration(name: string, description: string, maxText: number, textField?: string, maxLimit?: number): ConnectorToolDeclaration {
  const properties: Record<string, unknown> = {};
  if (textField) properties[textField] = { type: 'string', minLength: 1, maxLength: maxText };
  if (maxLimit !== undefined) properties['limit'] = { type: 'integer', minimum: 1, maximum: maxLimit };
  return {
    name, description, effect: 'read',
    parameters: { type: 'object', additionalProperties: false, properties, ...(textField ? { required: [textField] } : {}) },
    validate(args) {
      if (!isRecord(args) || Object.keys(args).some(key => !Object.hasOwn(properties, key))) return false;
      if (textField && (typeof args[textField] !== 'string' || !(args[textField] as string).trim() || (args[textField] as string).length > maxText)) return false;
      return args['limit'] === undefined || (Number.isSafeInteger(args['limit']) && (args['limit'] as number) >= 1 && (args['limit'] as number) <= maxLimit!);
    },
  };
}
function companyProjection(evidence: ConnectorEvidence, policy: ConnectionPolicy, projection: ReturnType<typeof projectMattermostResult>): ModelSnapshot {
  if (!projection.ok) throw Error('result_projection_failed');
  const unknownClass = policy.sourcePolicy.unknownClass;
  if (!unknownClass) throw Error('unknown_source_denied');
  return {
    response: { tool: evidence.tool, text: projection.projection.text, coverage: evidence.coverage, projection: evidence.projection, partial: projection.projection.partial, originalCharacters: projection.projection.originalCharacters, omittedCharacters: projection.projection.omittedCharacters, ...(projection.projection.sources ? { sources: projection.projection.sources } : {}) },
    dataClasses: [unknownClass],
  };
}
const mattermostDescriptor: ConnectorDescriptor = {
  id: 'mattermost', envelope: MATTERMOST_TOOLS,
  declarations(policy) {
    const text = Math.min(200, policy.bounds.maxQueryChars);
    const limit = Math.min(MATTERMOST_DEFAULTS.maxLimit, policy.bounds.maxSearchLimit);
    return [
      companyDeclaration('mattermost_whoami', 'Read the authenticated Mattermost identity.', text),
      companyDeclaration('mattermost_get_channel_history', 'Read bounded history from a Mattermost channel, newest first. channel is a channel name or display name; no channel list needed. An id still works. Returns at most 8 posts, 250 characters each.', text, 'channel', limit),
      mattermostDeclaration('mattermost_get_thread', 'Read a bounded Mattermost thread. postId is a post id taken from a channel history, and post_id is accepted as the same id. Returns at most 8 posts, 250 characters each.',
        { postId: { type: 'string', minLength: 1, maxLength: text }, post_id: { type: 'string', minLength: 1, maxLength: text } }, ['postId'], threadArgs,
        { normalize: args => (isRecord(args) && threadPostId(args) !== '' ? { args: { postId: threadPostId(args) } } : undefined) }),
      mattermostDeclaration('mattermost_search', 'Search bounded Mattermost messages by query, newest first, over the last 90 days unless after names an older start. No channel id needed: search first, no channel list needed. Put filters inside the query: From:<user>, After:<date>, In:<channel>, so "what did X say about Y" or "what happened in channel Z this week" is one call. Results are shaped newest first, at most 8 posts of 250 characters, not whole threads.',
        { query: { type: 'string', minLength: 1, maxLength: text }, limit: { type: 'integer', minimum: 1, maximum: limit }, after: { type: 'string', minLength: 1, maxLength: 40, description: 'ISO instant the window starts at; 90 days before now by default.' }, before: { type: 'string', minLength: 1, maxLength: 40 }, channel: { type: 'string', minLength: 1, maxLength: 60, description: 'One channel name, display name or id the ask names; resolved through the channel list.' } }, ['query'], args => searchArgs(args, text, limit)),
      // #604: the composite's own declaration, so one table feeds the grant and the dispatch.
      composedDeclaration(CONNECTOR_COMPOSED_TOOLS['mattermost']![0]!),
    ];
  },
  createReader({ port, registry, endpoint, schemaDigest, generation, policy }) {
    const reader = createMattermostReader({ port, registry, config: { endpointId: endpoint.id, account: endpoint.account, resource: endpoint.resource, schemaDigest, generation, maxLimit: Math.min(MATTERMOST_DEFAULTS.maxLimit, policy.bounds.maxSearchLimit), queryChars: Math.min(200, policy.bounds.maxQueryChars), names: policy.toolNames } });
    return { async call(tool, args, signal) {
      switch (tool) {
        case 'mattermost_whoami': return reader.whoami(signal);
        case 'mattermost_get_channel_history': return reader.getChannelHistory(args as { channel: string; limit?: number }, signal);
        case 'mattermost_get_thread': return reader.getThread(args as { postId: string }, signal);
        case 'mattermost_search': return reader.search(args as { query: string; limit?: number; after?: string; before?: string }, signal);
        case 'mattermost_attention': return reader.attention(args as { days?: number; limit?: number }, signal);
        case 'mattermost_list_channels': return reader.listChannels(args, signal);
        default: throw new ConnectorCompositionError('unknown_connector_tool', endpoint.id, 'mattermost');
      }
    } };
  },
  project(evidence, port, policy) { return companyProjection(evidence, policy, projectMattermostResult(port, evidence)); },
  identity() { return { tool: 'mattermost_whoami', args: {}, values: mattermostIdentityValues }; },
};
/**
 * One pass-through model declaration for a read tool this connector carries no typed shape for.
 * The argument schema belongs to the Mongoose server and the reader validates against it.
 */
function mongooseForwardDeclaration(name: string): ConnectorToolDeclaration {
  return {
    name,
    description: `Read company knowledge with the Mongoose tool ${name}. Pass the arguments that tool defines.`,
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    validate(args) { return isRecord(args) && JSON.stringify(args).length <= 4000; },
  };
}
const mongooseSchemaValidator = new AjvJsonSchemaValidator();
function mongooseDeclaration(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ConnectorToolDeclaration {
  const parameters = { type: 'object', additionalProperties: false, properties, required };
  const validate = mongooseSchemaValidator.getValidator(parameters as Parameters<AjvJsonSchemaValidator['getValidator']>[0]);
  return { name, description, effect: 'read', parameters, validate: args => isRecord(args) && JSON.stringify(args).length <= 4000 && validate(args).valid };
}

/** The endpoint one connection speaks to, from its resource; undefined for an endpoint this build does not serve. */
function mongooseEndpointOf(policy: ConnectionPolicy): MongooseEndpoint | undefined {
  const endpoint = (policy as { endpoint?: ConnectionEndpoint }).endpoint;
  if (endpoint === undefined) return undefined;
  const byResource = mongooseEndpointName(endpoint.resource);
  if (byResource !== undefined) return byResource;
  const url = (endpoint as { url?: unknown }).url;
  return typeof url === 'string' ? mongooseEndpointName(url) : undefined;
}

/** The typed declarations that carry a real argument schema; every other envelope name is pass-through. */
function mongooseTypedDeclarations(endpoint: MongooseEndpoint, policy: ConnectionPolicy): readonly ConnectorToolDeclaration[] {
  const text = { type: 'string', minLength: 1, maxLength: Math.min(500, policy.bounds.maxQueryChars) };
  const limit = { type: 'integer', minimum: 1, maximum: Math.min(50, policy.bounds.maxSearchLimit) };
  if (endpoint === 'knowledge') return [
    mongooseDeclaration('search', 'Search curated company knowledge. mode answer answers a question and mode browse lists entities; read the ref a hit returns for depth.', {
      query: text, mode: { type: 'string', enum: ['answer', 'browse'] }, limit, cursor: { type: 'string' }, verbose: { type: 'boolean' },
    }, ['query']),
    mongooseDeclaration('read', 'Read one company entity by the exact ref a search returned. depth selects summary, full or all.', {
      ref: text, depth: { type: 'string', enum: ['summary', 'full', 'all'] }, cursor: { type: 'string' }, verbose: { type: 'boolean' },
    }, ['ref']),
    mongooseDeclaration('list_companies', 'List the companies Mongoose tracks, one bounded page at a time. The company profile is read on the ref this returns.', { limit }, []),
  ];
  return [];
}

const mongooseDescriptor: ConnectorDescriptor = {
  id: 'mongoose', envelope: MONGOOSE_READ_TOOLS,
  declarations(policy) {
    const endpoint = mongooseEndpointOf(policy);
    if (endpoint === undefined) return [];
    // The typed few carry real argument schemas; every other envelope name of this one endpoint stays a
    // pass-through, so a knowledge grant can never reach a data or crm tool.
    const typed = mongooseTypedDeclarations(endpoint, policy);
    const other = MONGOOSE_ENDPOINT_TOOLS[endpoint]
      .filter(name => !typed.some(declaration => declaration.name === name))
      .map(name => mongooseForwardDeclaration(name));
    return [...typed, ...other];
  },
  createReader({ port, registry, endpoint, schemaDigest, generation, policy }) {
    const name = mongooseEndpointOf(policy);
    if (name === undefined) throw new Error('mongoose-endpoint-unrecognised');
    const reader = createMongooseReader({ port, registry, config: {
      endpointId: endpoint.id, endpoint: name, account: endpoint.account, resource: endpoint.resource, schemaDigest, generation,
      maxSearchLimit: Math.min(50, policy.bounds.maxSearchLimit), maxListLimit: Math.min(100, policy.bounds.maxSearchLimit), queryChars: Math.min(500, policy.bounds.maxQueryChars) } });
    return { async call(tool, args, signal) {
      switch (tool) {
        case 'search': return reader.searchCompany(args as unknown as SearchInput, signal);
        case 'read': return reader.read(args as { ref: string; depth?: 'summary' | 'full' | 'all'; cursor?: string }, signal);
        case 'list_companies': return reader.listCompanies(args as { limit?: number; filter?: Record<string, unknown> }, signal);
        default: return reader.call(tool, args, signal);
      }
    } };
  },
  project(evidence, port, policy) { return companyProjection(evidence, policy, projectMongooseResult(port, evidence)); },
  identity() { return { tool: 'get_started', args: {}, values: mongooseIdentityValues }; },
};

export const CONNECTOR_DESCRIPTORS: Readonly<Record<string, ConnectorDescriptor>> = {
  'lux-knowledge': luxKnowledgeDescriptor,
  'google': googleDescriptor,
  'mattermost': mattermostDescriptor,
  'mongoose': mongooseDescriptor,
};

export function connectorDescriptor(id: string): ConnectorDescriptor | undefined {
  return Object.hasOwn(CONNECTOR_DESCRIPTORS, id) ? CONNECTOR_DESCRIPTORS[id] : undefined;
}
