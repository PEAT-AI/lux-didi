import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The remote tools this connector carries a typed projection for, in fixed order.
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

/** The read prefixes the classifier accepts when a server ships no MCP annotations. */
export const MONGOOSE_READ_PREFIXES = ['get_', 'list_', 'search_', 'ask_', 'read_', 'lookup_', 'check_'] as const;

/**
 * The widest read envelope this connector will ever call: every read-only tool of the published
 * 64-tool surface, plus the Lightdash reads, whose mutability the server takes from Lightdash.
 * A write is absent, and the discovery-time classifier below narrows this list to what the server
 * itself annotates as read-only before anything is granted.
 */
export const MONGOOSE_READ_TOOLS = [
  ...MONGOOSE_TOOLS,
  'check_data_capability',
  'get_commercial_paths',
  'get_company_crm',
  'get_knowledge_graph',
  'get_knowledge_versions',
  'get_market_profile',
  'get_reach',
  'get_schema',
  'get_started',
  'inbound_lead_events',
  'lint_knowledge',
  'list_companies',
  'list_company_products',
  'list_data_capabilities',
  'list_inbound_leads',
  'list_knowledge_domains',
  'list_knowledge_edges',
  'list_knowledge_items',
  'list_markets',
  'list_offerings',
  'list_seed_conflicts',
  'list_user_handles',
  'list_users',
  'lookup_efficacy_evidence',
  'summarize_email_engagements',
  'lightdash_find_content',
  'lightdash_generate_hashes',
  'lightdash_get_context',
  'lightdash_get_current_project',
  'lightdash_get_lightdash_version',
  'lightdash_get_metadata',
  'lightdash_get_query_result',
  'lightdash_grep_fields',
  'lightdash_list_content',
  'lightdash_list_explores',
  'lightdash_list_projects',
  'lightdash_list_verified_content',
  'lightdash_read_content',
  'lightdash_resolve_url',
  'lightdash_run_metric_query',
  'lightdash_run_sql',
  'lightdash_search_field_values',
] as const;

/**
 * The known write surface of the published catalog. A write is never auto-approved, whatever the
 * remote's advisory annotation says; it stays behind the existing explicit grant.
 */
export const MONGOOSE_KNOWN_WRITES = [
  'claim_ticket',
  'create_knowledge_item',
  'create_ticket',
  'patch_knowledge_body',
  'provision_user',
  'resolve_seed_conflict',
  'set_knowledge_edge',
  'set_knowledge_item_status',
  'set_user_access',
  'update_knowledge_item',
  'update_ticket',
  'lightdash_create_content',
  'lightdash_create_scheduled_delivery',
  'lightdash_edit_content',
  'lightdash_set_project',
] as const;

/**
 * One tool's read classification. A known write is never a read. Otherwise the remote's own MCP
 * annotations decide when it sends any: only `readOnlyHint: true` is a read, and annotations
 * without a read hint never authorize a name on its spelling alone. A server that sends no
 * annotations at all falls back to the read prefixes above.
 */
export function mongooseReadOnly(tool: { name: string; annotations?: unknown }): boolean {
  if ((MONGOOSE_KNOWN_WRITES as readonly string[]).includes(tool.name)) return false;
  const annotations = tool.annotations;
  if (annotations !== undefined && annotations !== null) {
    if (typeof annotations !== 'object' || Array.isArray(annotations)) return false;
    const hint = (annotations as Record<string, unknown>)['readOnlyHint'];
    return typeof hint === 'boolean' ? hint : false;
  }
  return MONGOOSE_READ_PREFIXES.some(prefix => tool.name.startsWith(prefix));
}

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
  /** The remote tool the server answered; every granted read tool, not only the typed seven. */
  tool: string;
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
  /** Any other granted read tool, with the model's own arguments; the server schema validates them. */
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult>;
}

export interface MongooseOptions { port: McpPort; registry: McpRegistry; config: MongooseConfig }

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MONGOOSE_READ_TOOLS);
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
function preflight(registry: McpRegistry, settings: Settings, tool: string): string | undefined {
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

  async function dispatch(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult> {
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
    async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult> {
      // Only a read name the local envelope carries is forwarded; the grant is checked in preflight.
      if (!ELIGIBLE.has(tool)) return { state: 'refused', reason: 'tool-not-in-envelope' };
      const denied = preflight(registry, settings, tool);
      if (denied) return { state: 'refused', reason: denied };
      return dispatch(tool, args, signal);
    },
  };
}
