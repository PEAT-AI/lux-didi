import type { CompletedResult, McpPort, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { DataClass } from '../adapters/model/types.js';
import type { ConnectionEndpoint, ConnectionPolicy, ModelSnapshot } from '../tools/types.js';
import { createLuxKnowledgeReader, LUX_KNOWLEDGE_TOOLS } from './lux-knowledge.js';
import type { LuxKnowledgeResult } from './lux-knowledge.js';
import { projectLuxResult } from '../tools/lux-knowledge.js';
import { createGoogleReader, GOOGLE_TOOLS } from './google.js';
import type { GcalCalendarsInput, GcalListInput, GmailListInput, GmailReadInput, GoogleEvidence, GoogleFamily, GoogleResult } from './google.js';
import { googleToolStatus, projectGoogleResult } from '../tools/google.js';

export * from './lux-knowledge.js';
export * from './google.js';

/**
 * The locally maintained read envelope per connector. The host approves exactly these names
 * under owner-trusted-reads, never the remote's readOnlyHint. One line per connector.
 */
export const CONNECTOR_ENVELOPES: Readonly<Record<string, readonly string[]>> = {
  'lux-knowledge': LUX_KNOWLEDGE_TOOLS,
  'google': GOOGLE_TOOLS,
};

/** Transport-neutral evidence handed from a connector reader to its projector. */
export interface ConnectorEvidence {
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
        description: 'Search bounded Lux knowledge evidence.',
        effect: 'read',
        parameters: {
          type: 'object', additionalProperties: false, required: ['query', 'limit'],
          properties: { query: { type: 'string', minLength: 1, maxLength: bounds.maxQueryChars }, limit: { type: 'integer', minimum: 1, maximum: bounds.maxSearchLimit } },
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
        description: 'Get bounded Lux knowledge evidence; requested IDs are unverified input.',
        effect: 'read',
        parameters: {
          type: 'object', additionalProperties: false, required: ['ids'],
          properties: { ids: { type: 'array', minItems: 1, maxItems: bounds.maxGetIds, uniqueItems: true, items: { type: 'integer', minimum: 1 } } },
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
          : await reader.get(args as { ids: number[] }, signal)) as ConnectorResult;
      },
    };
  },
  project(evidence, port, policy) {
    return projectLuxResult(evidence as unknown as LuxKnowledgeResult, policy, port);
  },
};

function googleFamily(toolNames: readonly string[]): GoogleFamily {
  return toolNames.some(name => name.startsWith('gcal_')) ? 'calendar' : 'gmail';
}
function googleProject(evidence: ConnectorEvidence, port: McpPort, policy: ConnectionPolicy): ModelSnapshot {
  const projection = projectGoogleResult(port, evidence as unknown as GoogleResult);
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
    },
    dataClasses: [unknownClass] as DataClass[],
  };
}
function googleStatus(evidence: ConnectorEvidence): { state: 'configured'; reason: string } | undefined {
  const status = googleToolStatus(evidence as unknown as GoogleEvidence);
  return status && status.state === 'configured' ? { state: 'configured', reason: status.reason } : undefined;
}
const googleDescriptor: ConnectorDescriptor = {
  id: 'google',
  envelope: GOOGLE_TOOLS,
  declarations() {
    const listProps = { maxResults: { type: 'integer', minimum: 1, maximum: 50 }, pageToken: { type: 'string', minLength: 1 } };
    return [
      { name: 'gmail_get_profile', description: 'Read the Gmail profile of the selected binding.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: {} }, validate: args => isRecord(args) && Object.keys(args).length === 0 },
      { name: 'gmail_list', description: 'List bounded Gmail messages (ids, and any headers the helper returns).', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, q: { type: 'string', minLength: 1 } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'q'].includes(key)) },
      { name: 'gmail_read', description: 'Read one Gmail message (subject, from, date, and body for format=full).', effect: 'read', parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 }, format: { type: 'string', enum: ['metadata', 'full'] } } }, validate: args => isRecord(args) && typeof args['id'] === 'string' && (args['id'] as string).length > 0 && Object.keys(args).every(key => ['id', 'format'].includes(key)) },
      { name: 'gcal_calendars', description: 'List the calendars visible to the selected binding.', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: listProps }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken'].includes(key)) },
      { name: 'gcal_list', description: 'List bounded events on one calendar (time, title, location).', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: { ...listProps, calendarId: { type: 'string', minLength: 1 } } }, validate: args => isRecord(args) && Object.keys(args).every(key => ['maxResults', 'pageToken', 'calendarId'].includes(key)) },
    ];
  },
  createReader({ port, registry, policy }) {
    const reader = createGoogleReader({
      port, registry,
      config: { endpointId: policy.endpoint.id, account: policy.endpoint.account, resource: policy.endpoint.resource, schemaDigest: policy.schemaDigest, generation: policy.generation, family: googleFamily(policy.toolNames) },
    });
    return {
      async call(tool, args, signal) {
        if (tool === 'gmail_get_profile') return await reader.gmailProfile(signal) as ConnectorResult;
        if (tool === 'gmail_list') return await reader.gmailList(args as GmailListInput, signal) as ConnectorResult;
        if (tool === 'gmail_read') return await reader.gmailRead(args as unknown as GmailReadInput, signal) as ConnectorResult;
        if (tool === 'gcal_calendars') return await reader.gcalCalendars(args as GcalCalendarsInput, signal) as ConnectorResult;
        return await reader.gcalList(args as GcalListInput, signal) as ConnectorResult;
      },
    };
  },
  project: googleProject,
  status: googleStatus,
};

export const CONNECTOR_DESCRIPTORS: Readonly<Record<string, ConnectorDescriptor>> = {
  'lux-knowledge': luxKnowledgeDescriptor,
  'google': googleDescriptor,
};

export function connectorDescriptor(id: string): ConnectorDescriptor | undefined {
  return CONNECTOR_DESCRIPTORS[id];
}
