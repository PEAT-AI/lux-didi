import type { CompletedResult, McpPort, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { DataClass } from '../adapters/model/types.js';
import type { ConnectionEndpoint, ConnectionPolicy, ModelSnapshot } from '../tools/types.js';
import { createLuxKnowledgeReader, LUX_KNOWLEDGE_TOOLS } from './lux-knowledge.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import { createGoogleReader, GOOGLE_TOOLS } from './google.js';
import type { GcalCalendarsInput, GcalListInput, GmailListInput, GmailReadInput, GoogleFamily } from './google.js';
import { googleToolStatus, projectGoogleResult } from '../tools/google.js';
import { createMongooseReader, MONGOOSE_TOOLS } from './mongoose.js';
import { createMattermostReader, MATTERMOST_TOOLS } from './mattermost.js';

import { projectMongooseResult } from '../tools/mongoose.js';
import { projectMattermostResult } from '../tools/mattermost.js';

export * from './lux-knowledge.js';
export * from './google.js';
export * from './mongoose.js';
export * from './mattermost.js';

/**
 * The locally maintained read envelope per connector. The host approves exactly these names
 * under owner-trusted-reads, never the remote's readOnlyHint. One line per connector.
 */
export const CONNECTOR_ENVELOPES: Readonly<Record<string, readonly string[]>> = {
  'lux-knowledge': LUX_KNOWLEDGE_TOOLS,
  'google': GOOGLE_TOOLS,
  'mongoose': MONGOOSE_TOOLS,
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const luxKnowledgeDescriptor: ConnectorDescriptor = {
  id: 'lux-knowledge',
  envelope: LUX_KNOWLEDGE_TOOLS,
  declarations(policy) {
    const bounds = policy.bounds;
    return [
      {
        name: 'search_knowledge',
        description: 'Search the owner knowledge base. Pass 2 to 5 core terms, not a sentence; returns matching entry ids with short excerpts. Fetch an entry by id with get_insight for the full body.',
        effect: 'read',
        parameters: {
          type: 'object', additionalProperties: false, required: ['query', 'limit'],
          properties: { query: { type: 'string', minLength: 1, maxLength: bounds.maxQueryChars, description: 'Two to five core terms: names, projects and exact technical words, never conversational filler.' }, limit: { type: 'integer', minimum: 1, maximum: bounds.maxSearchLimit, description: 'How many results to return, within the configured search cap.' } },
        },
        validate(args) {
          if (!isRecord(args)) return false;
          const keys = Object.keys(args);
          if (keys.length !== 2 || !keys.includes('query') || !keys.includes('limit')) return false;
          const query = args['query']; const limit = args['limit'];
          return typeof query === 'string' && query.trim().length > 0 && query.length <= bounds.maxQueryChars && Number.isSafeInteger(limit) && (limit as number) > 0 && (limit as number) <= bounds.maxSearchLimit;
        },
      },
      {
        name: 'get_insight',
        description: 'Read full knowledge-base entries by id. Pass one to three entry ids from a knowledge search; requested ids are unverified input.',
        effect: 'read',
        parameters: {
          type: 'object', additionalProperties: false, required: ['ids'],
          properties: { ids: { type: 'array', minItems: 1, maxItems: bounds.maxGetIds, uniqueItems: true, items: { type: 'integer', minimum: 1 }, description: 'One to three entry ids from a knowledge search.' } },
        },
        validate(args) {
          if (!isRecord(args) || Object.keys(args).length !== 1 || !Array.isArray(args['ids'])) return false;
          const ids = args['ids'] as unknown[];
          return ids.length > 0 && ids.length <= bounds.maxGetIds && new Set(ids).size === ids.length && ids.every(id => Number.isSafeInteger(id) && Number(id) > 0);
        },
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
        return (tool === 'search_knowledge'
          ? await reader.search(args as { query: string; limit: number }, signal)
          : await reader.get(args as { ids: number[] }, signal));
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
      text: projection.projection.text,
      partial: projection.projection.partial,
      originalCharacters: projection.projection.originalCharacters,
      omittedCharacters: projection.projection.omittedCharacters,
      sources: projection.projection.sources,
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
      { name: 'gmail_list', description: 'List Gmail messages matching a Gmail query, newest first. q uses Gmail operators, for example from:name after:2026/10/07 or subject:(board deck) is:unread. Returns message ids; read the full message with gmail_read.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, q: { type: 'string', minLength: 1, description: 'Gmail search query using Gmail operators.' } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'q'].includes(key)) },
      { name: 'gmail_read', description: 'Read one full Gmail message by id from gmail_list: subject, from, date and body.', effect: 'read', parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 }, format: { type: 'string', enum: ['metadata', 'full'] } } }, validate: args => isRecord(args) && typeof args['id'] === 'string' && (args['id'] as string).length > 0 && Object.keys(args).every(key => ['id', 'format'].includes(key)) },
      { name: 'gcal_calendars', description: 'List the calendars visible to the selected binding.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: listProps }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken'].includes(key)) },
      { name: 'gcal_list', description: 'List events on one calendar in a time window. timeMin and timeMax are RFC3339 timestamps with the offset from the runtime context; pass exact start and end instead of asking for a date. Omit both for today in the host timezone. Returns time, title and location.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, calendarId: { type: 'string', minLength: 1, description: 'Calendar id; defaults to the primary calendar.' }, timeMin: { type: 'string', minLength: 1, description: 'Window start, RFC3339 with the runtime timezone offset.' }, timeMax: { type: 'string', minLength: 1, description: 'Window end, RFC3339 with the runtime timezone offset.' } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'calendarId', 'timeMin', 'timeMax'].includes(key)) },
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
};

/** A local composition defect, distinct from a remote connector failure. */
export class ConnectorCompositionError extends Error {
  constructor(public readonly code: 'unknown_connector' | 'unknown_connector_tool' | 'ambiguous_model_tool_name', public readonly connectionId: string, public readonly connector: string) {
    super(`Connector composition error: ${code} (${connectionId}, ${connector})`);
    this.name = 'ConnectorCompositionError';
  }
}

/** Company readers accept only an optional bounded limit and one required text field. */
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
    response: { tool: evidence.tool, text: projection.projection.text, coverage: evidence.coverage, projection: evidence.projection, partial: projection.projection.partial, originalCharacters: projection.projection.originalCharacters, omittedCharacters: projection.projection.omittedCharacters, sources: projection.projection.sources },
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
      companyDeclaration('mattermost_get_channel_history', 'Read bounded history from a Mattermost channel. channel is a channel name or display name; no channel list needed. An id still works.', text, 'channel', limit),
      companyDeclaration('mattermost_get_thread', 'Read a bounded Mattermost thread. postId is a post id taken from a channel history.', text, 'postId', limit),
      companyDeclaration('mattermost_search', 'Search bounded Mattermost messages by query. No channel id needed: search first, no channel list needed. Returns messages, not whole threads.', text, 'query', limit),
      companyDeclaration('mattermost_list_channels', 'List bounded Mattermost channels with their ids. Call it at most once per question; its ids stay valid for the whole session, so reuse them.', text, undefined, limit),
    ];
  },
  createReader({ port, registry, endpoint, schemaDigest, generation, policy }) {
    const reader = createMattermostReader({ port, registry, config: { endpointId: endpoint.id, account: endpoint.account, resource: endpoint.resource, schemaDigest, generation, maxLimit: Math.min(60, policy.bounds.maxSearchLimit), queryChars: Math.min(200, policy.bounds.maxQueryChars) } });
    return { async call(tool, args, signal) {
      switch (tool) {
        case 'mattermost_whoami': return reader.whoami(signal);
        case 'mattermost_get_channel_history': return reader.getChannelHistory(args as { channel: string; limit?: number }, signal);
        case 'mattermost_get_thread': return reader.getThread(args as { postId: string; limit?: number }, signal);
        case 'mattermost_search': return reader.search(args as { query: string; limit?: number }, signal);
        case 'mattermost_list_channels': return reader.listChannels(args, signal);
        default: throw new ConnectorCompositionError('unknown_connector_tool', endpoint.id, 'mattermost');
      }
    } };
  },
  project(evidence, port, policy) { return companyProjection(evidence, policy, projectMattermostResult(port, evidence)); },
};
const mongooseDescriptor: ConnectorDescriptor = {
  id: 'mongoose', envelope: MONGOOSE_TOOLS,
  declarations(policy) {
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
        default: throw new ConnectorCompositionError('unknown_connector_tool', endpoint.id, 'mongoose');
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
