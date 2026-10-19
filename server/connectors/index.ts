import type { CompletedResult, McpPort, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { DataClass } from '../adapters/model/types.js';
import type { ConnectionEndpoint, ConnectionPolicy, ModelSnapshot } from '../tools/types.js';
import { createLuxKnowledgeReader, KNOWLEDGE_BODY_MAX_CHARS, KNOWLEDGE_BODY_MIN_CHARS, KNOWLEDGE_DEADLINE_MAX_MS, KNOWLEDGE_DEADLINE_MIN_MS, LUX_KNOWLEDGE_TOOLS } from './lux-knowledge.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import { createGoogleReader, GOOGLE_TOOLS } from './google.js';
import type { GcalCalendarsInput, GcalListInput, GmailListInput, GmailReadInput, GoogleFamily } from './google.js';
import { googleToolStatus, projectGoogleResult } from '../tools/google.js';
import { createMongooseReader, MONGOOSE_READ_TOOLS } from './mongoose.js';
import { createMattermostReader, MATTERMOST_TOOLS } from './mattermost.js';

import { projectMongooseResult } from '../tools/mongoose.js';
import { projectMattermostResult } from '../tools/mattermost.js';
import { calendarIdentityValues, gmailIdentityValues, mattermostIdentityValues, type IdentitySource } from './identity.js';

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
export interface ConnectorEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  tool: string;
  source: ResultScope;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
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
  /** Connection status for a non-completed result, when the connector can classify it (R4). */
  status?(evidence: ConnectorEvidence): { state: 'configured'; reason: string } | undefined;
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
          if (!keys.every(key => key === 'query' || key === 'limit' || key === 'detail' || key === 'max_chars' || key === 'deadline_ms')) return false;
          if (!keys.includes('query') || !keys.includes('limit')) return false;
          const query = args['query']; const limit = args['limit'];
          if (!(typeof query === 'string' && query.trim().length > 0 && query.length <= bounds.maxQueryChars && Number.isSafeInteger(limit) && (limit as number) > 0 && (limit as number) <= bounds.maxSearchLimit)) return false;
          const detail = args['detail']; const maxChars = args['max_chars']; const deadlineMs = args['deadline_ms'];
          if (detail !== undefined && detail !== 'snippets' && detail !== 'bodies') return false;
          if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || (maxChars as number) < KNOWLEDGE_BODY_MIN_CHARS || (maxChars as number) > KNOWLEDGE_BODY_MAX_CHARS)) return false;
          if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || (deadlineMs as number) < KNOWLEDGE_DEADLINE_MIN_MS || (deadlineMs as number) > KNOWLEDGE_DEADLINE_MAX_MS)) return false;
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
      config: { endpointId: policy.endpoint.id, account: policy.endpoint.account, resource: policy.endpoint.resource, schemaDigest: policy.schemaDigest, generation: policy.generation, ...policy.bounds },
    });
    return {
      async call(tool, args, signal) {
        if (tool !== 'search_knowledge') return await reader.get(args as { ids: number[]; include_links?: boolean }, signal);
        // The declaration speaks the wire names; the reader takes the connector's own field names.
        const search = args as { query: string; limit: number; detail?: 'snippets' | 'bodies'; max_chars?: number; deadline_ms?: number };
        return await reader.search({
          query: search.query, limit: search.limit,
          ...(search.detail === undefined ? {} : { detail: search.detail }),
          ...(search.max_chars === undefined ? {} : { maxChars: search.max_chars }),
          ...(search.deadline_ms === undefined ? {} : { deadlineMs: search.deadline_ms }),
        }, signal);
      },
    };
  },
  project(evidence, port, policy) {
    return projectLuxResult(evidence, policy, port);
  },
};

function googleFamily(toolNames: readonly string[]): GoogleFamily {
  return toolNames.some(name => name.startsWith('gcal_')) ? 'calendar' : 'gmail';
}
function googleProject(evidence: ConnectorEvidence, port: McpPort, policy: ConnectionPolicy): ModelSnapshot {
  const projection = projectGoogleResult(port, evidence);
  if (!projection.ok) throw Error('result_projection_failed');
  const unknownClass = policy.sourcePolicy.unknownClass;
  if (!unknownClass) throw Error('unknown_source_denied');
  return {
    response: {
      tool: evidence.tool,
      ...(projection.projection.calendarPage ? { calendarPage: projection.projection.calendarPage } : {}),
      ...(projection.projection.calendarScope ? { calendarScope: projection.projection.calendarScope } : {}),
      text: projection.projection.text,
      partial: projection.projection.partial,
      originalCharacters: projection.projection.originalCharacters,
      omittedCharacters: projection.projection.omittedCharacters,
      ...(projection.projection.sources ? { sources: projection.projection.sources } : {}),
    },
    dataClasses: [unknownClass] as DataClass[],
  };
}
function googleStatus(evidence: ConnectorEvidence): { state: 'configured'; reason: string } | undefined {
  const status = googleToolStatus(evidence);
  return status && status.state === 'configured' ? { state: 'configured', reason: status.reason } : undefined;
}
const googleDescriptor: ConnectorDescriptor = {
  id: 'google',
  envelope: GOOGLE_TOOLS,
  declarations() {
    const listProps = { maxResults: { type: 'integer', minimum: 1, maximum: 50 }, pageToken: { type: 'string', minLength: 1 } };
    return [
      { name: 'gmail_get_profile', description: 'Read the Gmail profile of the selected binding.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: {} }, validate: args => isRecord(args) && Object.keys(args).length === 0 },
      { name: 'gmail_list', description: 'List Gmail messages matching a Gmail query, newest first. q uses Gmail operators, for example from:name after:2026/10/07 or subject:(board deck) is:unread. Returns message ids; read the full message with gmail_read. Returns at most 5 messages with 300-character excerpts.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, q: { type: 'string', minLength: 1, description: 'Gmail search query using Gmail operators.' } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'q'].includes(key)) },
      { name: 'gmail_read', description: 'Read one full Gmail message by id from gmail_list: subject, from, date and body. Returns the body up to 1500 characters.', effect: 'read', parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 }, format: { type: 'string', enum: ['metadata', 'full'] } } }, validate: args => isRecord(args) && typeof args['id'] === 'string' && (args['id'] as string).length > 0 && Object.keys(args).every(key => ['id', 'format'].includes(key)) },
      { name: 'gcal_calendars', description: 'List the calendars visible to the selected binding. Returns names only, no events. Call it only when the owner asks which calendars exist; an event read needs no calendar list.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: listProps }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken'].includes(key)) },
      { name: 'gcal_list', description: 'List events on one calendar in a time window. timeMin and timeMax are RFC3339 timestamps with the offset from the runtime context; pass exact start and end instead of asking for a date. Omit both for today in the host timezone. Returns time, title and location. Returns at most 8 events of 150 characters, without dial-in text.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, calendarId: { type: 'string', minLength: 1, description: 'Calendar id; defaults to the primary calendar.' }, timeMin: { type: 'string', minLength: 1, description: 'Window start, RFC3339 with the runtime timezone offset.' }, timeMax: { type: 'string', minLength: 1, description: 'Window end, RFC3339 with the runtime timezone offset.' } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'calendarId', 'timeMin', 'timeMax'].includes(key)) },
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
        if (tool === 'gmail_list') return await reader.gmailList(args as GmailListInput, signal);
        if (tool === 'gmail_read') return await reader.gmailRead(args as unknown as GmailReadInput, signal);
        if (tool === 'gcal_calendars') return await reader.gcalCalendars(args as GcalCalendarsInput, signal);
        return await reader.gcalList(args as GcalListInput, signal);
      },
    };
  },
  project: googleProject,
  status: googleStatus,
  identity(policy) {
    return googleFamily(policy.toolNames) === 'calendar'
      ? { tool: 'gcal_calendars', args: {}, values: calendarIdentityValues }
      : { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues };
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
  if (!Object.keys(args).every(key => ['query', 'limit', 'after', 'before'].includes(key))) return false;
  if (!isText(args['query'], maxText)) return false;
  if (args['limit'] !== undefined && !isCount(args['limit'], 1, maxLimit)) return false;
  return ['after', 'before'].every(key => args[key] === undefined || isText(args[key], 40));
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
    const limit = Math.min(60, policy.bounds.maxSearchLimit);
    return [
      companyDeclaration('mattermost_whoami', 'Read the authenticated Mattermost identity.', text),
      companyDeclaration('mattermost_get_channel_history', 'Read bounded history from a Mattermost channel, newest first. channel is a channel name or display name; no channel list needed. An id still works. Returns at most 8 posts, 250 characters each.', text, 'channel', limit),
      mattermostDeclaration('mattermost_get_thread', 'Read a bounded Mattermost thread. postId is a post id taken from a channel history, and post_id is accepted as the same id. Returns at most 8 posts, 250 characters each.',
        { postId: { type: 'string', minLength: 1, maxLength: text }, post_id: { type: 'string', minLength: 1, maxLength: text } }, ['postId'], threadArgs,
        { normalize: args => (isRecord(args) && threadPostId(args) !== '' ? { args: { postId: threadPostId(args) } } : undefined) }),
      mattermostDeclaration('mattermost_search', 'Search bounded Mattermost messages by query, newest first, over the last 90 days unless after names an older start. No channel id needed: search first, no channel list needed. Put filters inside the query: From:<user>, After:<date>, In:<channel>, so "what did X say about Y" or "what happened in channel Z this week" is one call. Results are shaped newest first, at most 8 posts of 250 characters, not whole threads.',
        { query: { type: 'string', minLength: 1, maxLength: text }, limit: { type: 'integer', minimum: 1, maximum: limit }, after: { type: 'string', minLength: 1, maxLength: 40, description: 'ISO instant the window starts at; 90 days before now by default.' }, before: { type: 'string', minLength: 1, maxLength: 40 } }, ['query'], args => searchArgs(args, text, limit)),
      mattermostDeclaration('mattermost_attention', 'What needs a reply from the owner, newest first: mentions, direct and group messages, and threads the owner posted in or was mentioned in where the newest post is not theirs. Each item carries channel, author, ISO time, permalink and one line. Use it for "do I need to reply", "anything new for me", "what did I miss".',
        { days: { type: 'integer', minimum: 1, maximum: 30, description: 'Window in days; 7 by default.' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, [], args => attentionArgs(args)),
    ];
  },
  createReader({ port, registry, endpoint, schemaDigest, generation, policy }) {
    const reader = createMattermostReader({ port, registry, config: { endpointId: endpoint.id, account: endpoint.account, resource: endpoint.resource, schemaDigest, generation, maxLimit: Math.min(60, policy.bounds.maxSearchLimit), queryChars: Math.min(200, policy.bounds.maxQueryChars) } });
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
const mongooseTypedDeclarations = (policy: ConnectionPolicy): readonly ConnectorToolDeclaration[] => {
    const text = Math.min(500, policy.bounds.maxQueryChars);
    const search = Math.min(50, policy.bounds.maxSearchLimit);
    const list = Math.min(100, policy.bounds.maxSearchLimit);
    return [
      companyDeclaration('ask_mongoose', 'Ask a bounded question of company knowledge.', text, 'question', search),
      companyDeclaration('search_mongoose', 'Search bounded company knowledge.', text, 'query', search),
      companyDeclaration('get_knowledge_item', 'Read a company knowledge item by id.', text, 'id'),
      companyDeclaration('read_knowledge_body', 'Read a company knowledge body by id.', text, 'id'),
      companyDeclaration('get_company_profile', 'Read the company profile.', text),
      companyDeclaration('list_tickets', 'List bounded company tickets.', text, undefined, list),
      companyDeclaration('get_ticket', 'Read a company ticket by id.', text, 'id'),
    ];
};
const mongooseDescriptor: ConnectorDescriptor = {
  id: 'mongoose', envelope: MONGOOSE_READ_TOOLS,
  declarations(policy) {
    // The typed seven first, then one pass-through declaration for every other tool of the read
    // envelope: the model table in tools/index.ts keeps only the granted names, and the reader
    // validates each call's arguments against the schema the server discovered.
    const typed = mongooseTypedDeclarations(policy);
    const other = MONGOOSE_READ_TOOLS
      .filter(name => !typed.some(declaration => declaration.name === name))
      .map(name => mongooseForwardDeclaration(name));
    return [...typed, ...other];
  },
  createReader({ port, registry, endpoint, schemaDigest, generation, policy }) {
    const reader = createMongooseReader({ port, registry, config: { endpointId: endpoint.id, account: endpoint.account, resource: endpoint.resource, schemaDigest, generation, maxSearchLimit: Math.min(50, policy.bounds.maxSearchLimit), maxListLimit: Math.min(100, policy.bounds.maxSearchLimit), queryChars: Math.min(500, policy.bounds.maxQueryChars) } });
    return { async call(tool, args, signal) {
      switch (tool) {
        case 'ask_mongoose': return reader.ask(args as { question: string; limit?: number }, signal);
        case 'search_mongoose': return reader.search(args as { query: string; limit?: number }, signal);
        case 'get_knowledge_item': return reader.getKnowledgeItem(args as { id: string }, signal);
        case 'read_knowledge_body': return reader.readKnowledgeBody(args as { id: string }, signal);
        case 'get_company_profile': return reader.companyProfile(signal);
        case 'list_tickets': return reader.listTickets(args, signal);
        case 'get_ticket': return reader.getTicket(args as { id: string }, signal);
        default: return reader.call(tool, args, signal);
      }
    } };
  },
  project(evidence, port, policy) { return companyProjection(evidence, policy, projectMongooseResult(port, evidence)); },
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
