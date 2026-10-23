import { SOURCE_DISPATCH, type SourceDispatchEvidence } from '../adapters/mcp/port.js';
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
 * The Mongoose ACCESS endpoints. One entry per endpoint, so an id, a URL, an audience and a read
 * allowlist live in exactly one place. The admin endpoint is deliberately absent: this host never
 * holds an admin grant.
 */
export interface MongooseEndpoint {
  readonly id: string;
  readonly name: 'knowledge' | 'data' | 'crm';
  readonly label: string;
  /** OAuth resource audience the server mints into the token for this endpoint. */
  readonly audience: string;
  /** The research source this endpoint answers. */
  readonly source: 'company' | 'data' | 'crm';
  /** Exact endpoint URL, no trailing slash. */
  readonly url: string;
  /** Every tool the ACCESS release publishes on the endpoint, gateway pair included. */
  readonly tools: readonly string[];
  /** The read allowlist this host will forward: a name outside it is refused before egress. */
  readonly reads: readonly string[];
}

/** The two names every endpoint carries by design; the only names three endpoints share. */
export const MONGOOSE_GATEWAY_TOOLS = ['describe_tools', 'call_tool'] as const;

/** Development base; the merge notice pins the release URL. No trailing slash. */
export const MONGOOSE_BASE_URL = 'https://mongoose.dev.peat-cloud.com';

const KNOWLEDGE_READS = [
  'ask_mongoose', 'search_mongoose', 'get_knowledge_item', 'read_knowledge_body', 'get_company_profile',
  'list_tickets', 'get_ticket', 'check_data_capability', 'get_commercial_paths', 'get_knowledge_graph',
  'get_knowledge_versions', 'get_market_profile', 'get_reach', 'get_started', 'lint_knowledge',
  'list_companies', 'list_company_products', 'list_data_capabilities', 'list_knowledge_domains',
  'list_knowledge_edges', 'list_knowledge_items', 'list_markets', 'list_offerings', 'list_seed_conflicts',
  'lookup_efficacy_evidence', 'summarize_email_engagements',
] as const;

const KNOWLEDGE_WRITES = [
  'claim_ticket', 'create_knowledge_item', 'create_ticket', 'patch_knowledge_body', 'resolve_seed_conflict',
  'set_knowledge_edge', 'set_knowledge_item_status', 'update_knowledge_item', 'update_ticket',
] as const;

const DATA_READS = [
  'find_content', 'generate_hashes', 'get_context', 'get_current_project', 'get_lightdash_version',
  'get_metadata', 'get_query_result', 'grep_fields', 'list_content', 'list_explores', 'list_projects',
  'list_verified_content', 'read_content', 'resolve_url', 'run_metric_query', 'run_sql', 'search_field_values',
] as const;

const DATA_WRITES = ['create_content', 'create_scheduled_delivery', 'edit_content', 'set_project'] as const;

const CRM_READS = ['get_company_crm', 'list_inbound_leads', 'inbound_lead_events'] as const;

/**
 * The connected endpoints, in the order the settings panel and the sign-in command use. Knowledge
 * carries the knowledge reads, data the Lightdash reads (renamed without the lightdash_ prefix), crm
 * the HubSpot reads. Nothing admin-typed is listed anywhere.
 */
export const MONGOOSE_ENDPOINTS: readonly MongooseEndpoint[] = [
  {
    id: 'mongoose-knowledge', name: 'knowledge', label: 'Mongoose knowledge', audience: 'mongoose:knowledge',
    source: 'company', url: `${MONGOOSE_BASE_URL}/mcp/knowledge`,
    tools: [...MONGOOSE_GATEWAY_TOOLS, ...KNOWLEDGE_READS, ...KNOWLEDGE_WRITES], reads: KNOWLEDGE_READS,
  },
  {
    id: 'mongoose-data', name: 'data', label: 'Lightdash numbers', audience: 'mongoose:data',
    source: 'data', url: `${MONGOOSE_BASE_URL}/mcp/data`,
    tools: [...MONGOOSE_GATEWAY_TOOLS, ...DATA_READS, ...DATA_WRITES], reads: DATA_READS,
  },
  {
    id: 'mongoose-crm', name: 'crm', label: 'HubSpot companies and leads', audience: 'mongoose:crm',
    source: 'crm', url: `${MONGOOSE_BASE_URL}/mcp/crm`,
    tools: [...MONGOOSE_GATEWAY_TOOLS, ...CRM_READS], reads: CRM_READS,
  },
];

/** One endpoint by its id, or undefined for a name this release does not connect. */
export function mongooseEndpoint(id: string): MongooseEndpoint | undefined {
  return MONGOOSE_ENDPOINTS.find(endpoint => endpoint.id === id);
}

/** Trailing slashes never distinguish two endpoints: the stored URL and the configured URL compare equal. */
function withoutTrailingSlash(url: string): string { return url.replace(/\/+$/, ''); }

/** The endpoint a configured URL names, or undefined for the retired single-endpoint URL. */
export function mongooseEndpointOfUrl(url: string): MongooseEndpoint | undefined {
  const wanted = withoutTrailingSlash(url);
  return MONGOOSE_ENDPOINTS.find(endpoint => withoutTrailingSlash(endpoint.url) === wanted);
}

/**
 * RFC 9728 metadata for one endpoint, at the origin root with the endpoint path inserted. The old
 * origin-root document described the retired single endpoint and is never asked for.
 */
export function mongooseMetadataUrl(endpointUrl: string): string {
  const parsed = new URL(endpointUrl);
  return `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname.replace(/\/+$/, '')}`;
}

/** A tool name two endpoints both grant is model-facing under its endpoint id. */
export function mongooseModelToolName(endpointId: string, tool: string): string {
  return `${endpointId}__${tool}`;
}

/**
 * One closed, spoken reason for a refused Mongoose call. The teams list is what the server sent for
 * endpoint_not_allowed and is empty for every other code, so a spoken line never carries a raw body.
 */
export interface MongooseRefusal {
  readonly code: 'endpoint_not_allowed' | 'lightdash_not_connected' | 'tool_not_on_endpoint' | 'grant_expired' | 'endpoint_unavailable';
  readonly message: string;
  readonly requiredTeams: readonly string[];
  readonly connectUrl?: string;
  readonly retryable: boolean;
}

const REFUSAL_LINES: Readonly<Record<MongooseRefusal['code'], string>> = {
  endpoint_not_allowed: 'that Mongoose endpoint is not allowed for this account',
  lightdash_not_connected: 'Lightdash is not connected in Mongoose; connect it to read numbers',
  tool_not_on_endpoint: 'that tool does not belong to the Mongoose endpoint this source reads',
  grant_expired: 'the Mongoose consent expired; sign in again from Settings',
  endpoint_unavailable: 'that Mongoose endpoint did not answer; the other endpoints are unaffected',
};

/**
 * Decode one denied Mongoose response into a closed reason plus the teams the server named. A code
 * this release does not know, or a body that is not the documented envelope, is endpoint_unavailable.
 */
export function mongooseRefusal(body: unknown): MongooseRefusal {
  const envelope = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['error'] : undefined;
  const detail = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope as Record<string, unknown> : undefined;
  const code = detail?.['code'];
  const known = typeof code === 'string' && code in REFUSAL_LINES ? code as MongooseRefusal['code'] : 'endpoint_unavailable';
  const teams = Array.isArray(detail?.['required_teams'])
    ? (detail['required_teams'] as unknown[]).filter((team): team is string => typeof team === 'string' && team.length > 0 && team.length <= 64)
    : [];
  const connect = detail?.['connect_url'];
  const connectUrl = typeof connect === 'string' && /^https?:\/\/[^\s]{1,512}$/.test(connect) ? connect : undefined;
  return {
    code: known,
    message: teams.length > 0 ? `${REFUSAL_LINES[known]}; it needs the ${teams.join(', ')} team` : REFUSAL_LINES[known],
    requiredTeams: known === 'endpoint_not_allowed' ? teams : [],
    ...(connectUrl === undefined ? {} : { connectUrl }),
    retryable: detail?.['retryable'] === true,
  };
}

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
 * The only stored record fields a local credential verdict may read (key names, never values): whether
 * refresh material exists, and when the consent family started. An access token's own expiry is not
 * one of them, because an expired token alone proves nothing about whether a refresh will work.
 */
export const MONGOOSE_LOCAL_CREDENTIAL_FIELDS = ['refreshToken', 'consentStartedAt'] as const;

export interface MongooseLocalCredential {
  /** A usable refresh token is on disk, so no new sign-in is implied. */
  hasRefreshMaterial: boolean;
  /** The consent family is past its absolute cap, so only a new re-authorisation can succeed. */
  consentExpired: boolean;
}

/**
 * What a start does about this endpoint's stored credential (H19,D4): a mongoose endpoint with no stored
 * credential, or one whose consent family is past its cap, is not signed in, and the host says that once
 * instead of opening the connector to fail at every launch. Every other endpoint is probed as before; a
 * signed-in mongoose endpoint reconnects on the next connect after a login.
 */
export function mongooseCredentialAtStart(connector: string, stored: MongooseLocalCredential): 'probe' | 'not_signed_in' {
  if (connector !== 'mongoose') return 'probe';
  return stored.hasRefreshMaterial && !stored.consentExpired ? 'probe' : 'not_signed_in';
}

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
export interface MongooseEvidence extends SourceDispatchEvidence {
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
export interface SearchInput { query: string; limit?: number; scope?: 'all' | 'knowledge'; domain?: string | null; include?: string | string[] | null; include_strong?: boolean; offset?: number }
export interface KnowledgeItemInput { id?: string; item_id?: string; identifier?: string; detail?: 'summary' | 'full' }
export interface KnowledgeBodyInput { ref: string; cursor?: string; max_chars?: number }
export interface CompanyProfileInput { company_name: string; detail?: 'overview' | 'summary' | 'commercial' | 'full'; sections?: string[] | null; flagship_only?: boolean; launch_year?: number | null }
export interface TicketInput { number: number | string; detail?: 'summary' | 'full'; body_offset?: number; limit?: number; offset?: number }
export interface ListInput { limit?: number }

export interface MongooseReader {
  ask(input: AskInput, signal?: AbortSignal): Promise<MongooseResult>;
  search(input: SearchInput, signal?: AbortSignal): Promise<MongooseResult>;
  getKnowledgeItem(input: KnowledgeItemInput, signal?: AbortSignal): Promise<MongooseResult>;
  readKnowledgeBody(input: KnowledgeBodyInput, signal?: AbortSignal): Promise<MongooseResult>;
  companyProfile(input: CompanyProfileInput, signal?: AbortSignal): Promise<MongooseResult>;
  listTickets(input: ListInput, signal?: AbortSignal): Promise<MongooseResult>;
  getTicket(input: TicketInput, signal?: AbortSignal): Promise<MongooseResult>;
  /** Any other granted read tool, with the model's own arguments; the server schema validates them. */
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult>;
}

export interface MongooseOptions { port: McpPort; registry: McpRegistry; config: MongooseConfig }

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MONGOOSE_READ_TOOLS);

/**
 * The read allowlist of one endpoint: its own declared reads, and the widest envelope only when the
 * endpoint id is one this release does not name (a synthetic test endpoint).
 */
function eligibleFor(endpointId: string): ReadonlySet<string> {
  const declared = mongooseEndpoint(endpointId);
  return declared === undefined ? ELIGIBLE : new Set<string>(declared.reads);
}
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
  const eligible = eligibleFor(settings.endpointId);
  if (visible.some(name => !eligible.has(name))) return 'ineligible-tool-granted';
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
      ...(result[SOURCE_DISPATCH] ? {[SOURCE_DISPATCH]:result[SOURCE_DISPATCH]} : {}),
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

  function typedArgs(input: object, keys: readonly string[], textKeys: readonly string[]): Record<string, unknown> | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 4000) return undefined;
    const args = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    if (Object.keys(args).some(key => !keys.includes(key))) return undefined;
    if (textKeys.some(key => args[key] !== undefined && boundedQuestion(args[key]) === undefined)) return undefined;
    return args;
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
      const args = typedArgs(input, ['query', 'limit', 'scope', 'domain', 'include', 'include_strong', 'offset'], ['query']);
      if (!args) return { state: 'refused', reason: 'invalid-search-input' };
      return dispatch('search_mongoose', { ...args, query, ...bounded }, signal);
    },
    async getKnowledgeItem(input: KnowledgeItemInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'get_knowledge_item');
      if (denied) return { state: 'refused', reason: denied };
      const args = typedArgs(input, ['id', 'item_id', 'identifier', 'detail'], ['id', 'item_id', 'identifier']);
      if (!args || !['id', 'item_id', 'identifier'].some(key => args[key] !== undefined)) return { state: 'refused', reason: 'invalid-id' };
      return dispatch('get_knowledge_item', args, signal);
    },
    async readKnowledgeBody(input: KnowledgeBodyInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'read_knowledge_body');
      if (denied) return { state: 'refused', reason: denied };
      const args = typedArgs(input, ['ref', 'cursor', 'max_chars'], ['ref']);
      if (!args || args['ref'] === undefined) return { state: 'refused', reason: 'invalid-ref' };
      return dispatch('read_knowledge_body', args, signal);
    },
    async companyProfile(input: CompanyProfileInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'get_company_profile');
      if (denied) return { state: 'refused', reason: denied };
      const args = typedArgs(input, ['company_name', 'detail', 'sections', 'flagship_only', 'launch_year'], ['company_name']);
      if (!args || args['company_name'] === undefined) return { state: 'refused', reason: 'invalid-company-name' };
      return dispatch('get_company_profile', args, signal);
    },
    async listTickets(input: ListInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'list_tickets');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = limited(input.limit, MONGOOSE_DEFAULTS.listLimit, settings.maxListLimit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('list_tickets', bounded, signal);
    },
    async getTicket(input: TicketInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, 'get_ticket');
      if (denied) return { state: 'refused', reason: denied };
      const args = typedArgs(input, ['number', 'detail', 'body_offset', 'limit', 'offset'], []);
      if (!args || (typeof args['number'] !== 'number' && boundedQuestion(args['number']) === undefined)) return { state: 'refused', reason: 'invalid-ticket-number' };
      return dispatch('get_ticket', args, signal);
    },
    async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult> {
      // Only a read name the local envelope carries is forwarded; the grant is checked in preflight.
      if (!eligibleFor(settings.endpointId).has(tool)) return { state: 'refused', reason: 'tool-not-in-envelope' };
      const denied = preflight(registry, settings, tool);
      if (denied) return { state: 'refused', reason: denied };
      return dispatch(tool, args, signal);
    },
  };
}
