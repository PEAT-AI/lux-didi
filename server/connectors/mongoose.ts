import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The only remote tools this connector may ever call, in fixed order. A name outside this
 * envelope is refused even when the remote lists it: the local read classification is the
 * authority, never the remote's readOnlyHint. Ticket writes and authoring tools are absent.
 */
export const MONGOOSE_TOOLS = [
  'ask_mongoose',
  'search_mongoose',
  'get_knowledge_item',
  'read_knowledge_body',
  'get_company_profile',
  'list_tickets',
  'get_ticket',
] as const;
export type MongooseTool = (typeof MONGOOSE_TOOLS)[number];

/** Bounded argument defaults; a caller may only narrow these, never widen them. */
export const MONGOOSE_DEFAULTS = { searchLimit: 5, maxSearchLimit: 50, listLimit: 10, maxListLimit: 100, queryChars: 500 } as const;

/**
 * Closed connect-time stage for a mongoose call that never reached a dispatched tool call.
 * The mongoose server is external, so the stage is reported, never repaired here, and never
 * carries a message, a URL or a credential value.
 */
export const MONGOOSE_FAILURE_STAGES = ['credential', 'spawn', 'handshake', 'first_call'] as const;
export type MongooseFailureStage = (typeof MONGOOSE_FAILURE_STAGES)[number];

/**
 * Classify a closed adapter reason (or a discovery exception code) into the connect stage where
 * the call stopped. Local refusals and a dispatched-call failure fall to `first_call`.
 */
export function mongooseFailureStage(reason: string, exceptionCode?: string): MongooseFailureStage {
  const token = exceptionCode ?? reason;
  if (token.includes('credential')) return 'credential';
  if (token === 'child_exited' || token === 'pipe_closed' || token === 'transport' || token === 'invalid-endpoint-config') return 'spawn';
  if (token === 'discovery-required' || token === 'discovery-unavailable' || token.includes('handshake')) return 'handshake';
  return 'first_call';
}

export interface MongooseConfig {
  endpointId: string;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  /** Largest `limit` any answer/search caller may select. Defaults 50, never above 50. */
  maxSearchLimit?: number;
  /** Largest `limit` any list caller may select. Defaults 100, never above 100. */
  maxListLimit?: number;
  /** Bound on a question or identifier in characters. Defaults 500, never above 500. */
  queryChars?: number;
}

/** Opaque local evidence, mirroring the Lux knowledge connector shape. */
export interface MongooseEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  tool: MongooseTool;
  source: ResultScope;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}
export interface MongooseRefused { state: 'refused'; reason: string }
export interface MongooseUnknown { state: 'unknown'; reason: string }
export type MongooseResult = MongooseEvidence | MongooseRefused | MongooseUnknown;

export interface AskInput { question: string; limit?: number }
export interface SearchInput { query: string; limit?: number }
export interface IdInput { id: string }
export interface ListInput { limit?: number }

export interface MongooseReader {
  ask(input: AskInput, signal?: AbortSignal): Promise<MongooseResult>;
  search(input: SearchInput, signal?: AbortSignal): Promise<MongooseResult>;
  getKnowledgeItem(input: IdInput, signal?: AbortSignal): Promise<MongooseResult>;
  readKnowledgeBody(input: IdInput, signal?: AbortSignal): Promise<MongooseResult>;
  companyProfile(signal?: AbortSignal): Promise<MongooseResult>;
  listTickets(input: ListInput, signal?: AbortSignal): Promise<MongooseResult>;
  getTicket(input: IdInput, signal?: AbortSignal): Promise<MongooseResult>;
}

export interface MongooseOptions { port: McpPort; registry: McpRegistry; config: MongooseConfig }

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MONGOOSE_TOOLS);
type FailedCall = { state: 'refused' | 'unknown'; reason: string };
function isFailed(result: CallResult): result is FailedCall {
  return result.state === 'refused' || result.state === 'unknown';
}
function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('invalid-connector-budget');
  return value as number;
}
function requirePositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('invalid-connector-config');
  return value as number;
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  maxSearchLimit: number; maxListLimit: number; queryChars: number;
}

/** Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change. */
function preflight(registry: McpRegistry, settings: Settings, tool: MongooseTool): string | undefined {
  let grant: ReadGrant | undefined;
  try {
    registry.endpoint(settings.endpointId);
    grant = registry.currentGrant(settings.endpointId);
  } catch { return 'source-unavailable'; }
  if (!grant) return 'grant-absent';
  if (grant.schemaDigest !== settings.schemaDigest) return 'schema-drift';
  if (grant.generation !== settings.generation) return 'grant-stale';
  if (grant.effect !== 'read') return 'grant-not-read';
  const visible = registry.visibleTools(settings.endpointId).map(definition => definition.name);
  if (visible.some(name => !ELIGIBLE.has(name))) return 'ineligible-tool-granted';
  if (!grant.toolNames.includes(tool)) return 'tool-not-granted';
  if (!visible.includes(tool)) return 'required-definition-absent';
  return undefined;
}

export function createMongooseReader(options: MongooseOptions): MongooseReader {
  const { port, registry, config } = options;
  const settings: Settings = {
    endpointId: config.endpointId,
    account: config.account,
    resource: config.resource,
    schemaDigest: config.schemaDigest,
    generation: requirePositiveSafeInteger(config.generation),
    maxSearchLimit: Math.min(positive(config.maxSearchLimit, MONGOOSE_DEFAULTS.maxSearchLimit), MONGOOSE_DEFAULTS.maxSearchLimit),
    maxListLimit: Math.min(positive(config.maxListLimit, MONGOOSE_DEFAULTS.maxListLimit), MONGOOSE_DEFAULTS.maxListLimit),
    queryChars: Math.min(positive(config.queryChars, MONGOOSE_DEFAULTS.queryChars), MONGOOSE_DEFAULTS.queryChars),
  };

  const schemaValidator = new AjvJsonSchemaValidator();

  async function dispatch(tool: MongooseTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult> {
    const request: CallRequest = {
      endpointId: settings.endpointId,
      toolName: tool,
      arguments: args,
      generation: settings.generation,
      account: settings.account,
      resource: settings.resource,
    };
    if (signal?.aborted) return { state: 'refused', reason: 'cancelled-before-dispatch' };
    // Validate the actual bounded dispatch arguments against the original discovered schema.
    const original = port.visibleTools(settings.endpointId).find(definition => definition.name === tool);
    if (!original || !schemaValidator.getValidator(original.inputSchema)(args).valid) return { state: 'refused', reason: 'original-schema-arguments-refused' };
    const result = await port.call(request, signal);
    if (isFailed(result)) return { state: result.state, reason: result.reason };
    if (signal?.aborted) return { state: 'unknown', reason: 'cancelled-after-dispatch' };
    const evidence: MongooseEvidence = {
      state: result.state,
      tool,
      source: { ...result.source },
      observedAt: result.freshness.receivedAt,
      coverage: structuredClone(result.coverage),
      decodedResult: structuredClone(result.decodedResult),
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
    return evidence;
  }

  function boundedQuestion(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= settings.queryChars ? value : undefined;
  }
  function limited(value: unknown, fallback: number, max: number): Record<string, unknown> | undefined {
    if (value === undefined) return { limit: Math.min(fallback, max) };
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) return undefined;
    return { limit: value as number };
  }

  return {
    async ask(input: AskInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'ask_mongoose');
      if (denied) return { state: 'refused', reason: denied };
      const question = boundedQuestion(input.question);
      if (question === undefined) return { state: 'refused', reason: 'invalid-question' };
      const bounded = limited(input.limit, MONGOOSE_DEFAULTS.searchLimit, settings.maxSearchLimit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('ask_mongoose', { question, ...bounded }, signal);
    },
    async search(input: SearchInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'search_mongoose');
      if (denied) return { state: 'refused', reason: denied };
      const query = boundedQuestion(input.query);
      if (query === undefined) return { state: 'refused', reason: 'invalid-query' };
      const bounded = limited(input.limit, MONGOOSE_DEFAULTS.searchLimit, settings.maxSearchLimit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('search_mongoose', { query, ...bounded }, signal);
    },
    async getKnowledgeItem(input: IdInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'get_knowledge_item');
      if (denied) return { state: 'refused', reason: denied };
      const id = boundedQuestion(input.id);
      if (id === undefined) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('get_knowledge_item', { id }, signal);
    },
    async readKnowledgeBody(input: IdInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'read_knowledge_body');
      if (denied) return { state: 'refused', reason: denied };
      const id = boundedQuestion(input.id);
      if (id === undefined) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('read_knowledge_body', { id }, signal);
    },
    async companyProfile(signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'get_company_profile');
      if (denied) return { state: 'refused', reason: denied };
      return dispatch('get_company_profile', {}, signal);
    },
    async listTickets(input: ListInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'list_tickets');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = limited(input.limit, MONGOOSE_DEFAULTS.listLimit, settings.maxListLimit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('list_tickets', bounded, signal);
    },
    async getTicket(input: IdInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'get_ticket');
      if (denied) return { state: 'refused', reason: denied };
      const id = boundedQuestion(input.id);
      if (id === undefined) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('get_ticket', { id }, signal);
    },
  };
}
