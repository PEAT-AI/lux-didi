import { SOURCE_DISPATCH, type SourceDispatchEvidence, type ToolDefinition } from '../adapters/mcp/port.js';
import { tokenIdentity, type IdentityProof, type TokenClaimSpec } from './identity.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The three Mongoose endpoints release 1023b serves, each its own OAuth resource with its own token.
 * `admin` is never here: nothing in this connector can reach it.
 */
export const MONGOOSE_ENDPOINTS = ['knowledge', 'data', 'crm'] as const;
export type MongooseEndpoint = (typeof MONGOOSE_ENDPOINTS)[number];
export const MONGOOSE_ENDPOINT_PATHS: Readonly<Record<MongooseEndpoint, string>> = {
  knowledge: '/mcp/knowledge', data: '/mcp/data', crm: '/mcp/crm',
};
/** The catalogue's resource label per endpoint (also the audience Mongoose mints); never an OAuth resource on the wire. */
export const MONGOOSE_ENDPOINT_AUDIENCES: Readonly<Record<MongooseEndpoint, string>> = {
  knowledge: 'mongoose:knowledge', data: 'mongoose:data', crm: 'mongoose:crm',
};

/**
 * The token claim pair each endpoint mints: the `email` claim and that endpoint's exact `aud` string,
 * read from Mongoose's own mint (`issue_mongoose_access_token`, PEAT-AI/mongoose cade720f) and
 * checked into `server/test/fixtures/mongoose-token-claims.json`.
 */
export const MONGOOSE_TOKEN_CLAIMS: Readonly<Record<MongooseEndpoint, TokenClaimSpec>> = {
  knowledge: { emailClaim: 'email', audience: MONGOOSE_ENDPOINT_AUDIENCES.knowledge },
  data: { emailClaim: 'email', audience: MONGOOSE_ENDPOINT_AUDIENCES.data },
  crm: { emailClaim: 'email', audience: MONGOOSE_ENDPOINT_AUDIENCES.crm },
};

/** Prove one endpoint's minted access token against the owner email and that endpoint's audience. */
export function mongooseTokenIdentity(token: string, endpoint: MongooseEndpoint, expected: readonly string[]): IdentityProof {
  return tokenIdentity(token, MONGOOSE_TOKEN_CLAIMS[endpoint], expected);
}

/**
 * The read envelope of one endpoint at Mongoose aa105bc6, taken from the generated tool file of that
 * endpoint. A name outside this list is refused before dispatch, whatever the remote annotates.
 */
export const MONGOOSE_ENDPOINT_TOOLS: Readonly<Record<MongooseEndpoint, readonly string[]>> = {
  knowledge: ['search', 'read', 'list_companies', 'list_company_products', 'get_market_profile', 'get_commercial_paths', 'list_tickets', 'get_started'],
  data: ['search_content', 'read_content', 'list_content', 'list_explores', 'get_data_context', 'get_metadata', 'list_verified_content', 'run_metric_query', 'search_fields'],
  crm: ['get_company', 'list_inbound_leads', 'list_inbound_lead_events', 'summarize_email_engagements'],
};

/** Every read name the connector carries, in fixed order. The three envelopes are disjoint. */
export const MONGOOSE_READ_TOOLS: readonly string[] = MONGOOSE_ENDPOINTS.flatMap(endpoint => [...MONGOOSE_ENDPOINT_TOOLS[endpoint]]);

/**
 * The known non-read surface of the published catalog, plus every retired name. A name here is denied
 * whatever the remote's advisory annotation says, and no envelope above carries one.
 */
export const MONGOOSE_DENIED_TOOLS: readonly string[] = [
  'claim_ticket', 'create_knowledge_item', 'create_ticket', 'patch_knowledge_item_body', 'set_knowledge_edge',
  'set_knowledge_item_status', 'update_knowledge_item', 'update_ticket',
  'create_content', 'create_scheduled_delivery', 'set_project', 'update_content', 'run_sql',
  'get_access_report', 'list_seed_conflicts', 'list_users', 'provision_user', 'resolve_seed_conflict', 'set_user_access',
  'ask_mongoose', 'search_mongoose', 'get_knowledge_item', 'read_knowledge_body', 'get_company_profile', 'get_company_crm',
  'get_ticket', 'check_data_capability', 'get_efficacy_evidence', 'get_knowledge_graph', 'get_knowledge_item_schema',
  'get_reach', 'lint_knowledge', 'list_data_capabilities', 'list_knowledge_domains', 'list_knowledge_edges',
  'list_knowledge_item_versions', 'list_knowledge_items', 'list_markets', 'list_offerings', 'list_user_handles',
  'get_query_result', 'resolve_url', 'search_field_values', 'get_current_project', 'list_projects',
  'get_service_version',
];

/**
 * One tool's read classification (R2): a denied name is never a read, and otherwise only the server's
 * own `readOnlyHint: true` makes it one. No spelling heuristic: an unannotated name is never a read.
 */
export function mongooseReadOnly(tool: { name: string; annotations?: unknown }): boolean {
  if (MONGOOSE_DENIED_TOOLS.includes(tool.name)) return false;
  const annotations = tool.annotations;
  if (annotations === undefined || annotations === null) return false;
  if (typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  return (annotations as Record<string, unknown>)['readOnlyHint'] === true;
}

/** R2: get_company on crm carries a company profile; knowledge list_companies plus read full is the fallback. */
export const MONGOOSE_PROFILE_ROUTE = {
  carrier: { endpoint: 'crm', tool: 'get_company' },
  fallback: { endpoint: 'knowledge', tool: 'list_companies', then: 'read' },
} as const;

/** Which route a profile read takes, given whether the crm endpoint holds a token for this account. */
export function mongooseProfileRoute(crmAvailable: boolean): { endpoint: MongooseEndpoint; tool: string; then?: string } {
  return crmAvailable
    ? { endpoint: MONGOOSE_PROFILE_ROUTE.carrier.endpoint, tool: MONGOOSE_PROFILE_ROUTE.carrier.tool }
    : { endpoint: MONGOOSE_PROFILE_ROUTE.fallback.endpoint, tool: MONGOOSE_PROFILE_ROUTE.fallback.tool, then: MONGOOSE_PROFILE_ROUTE.fallback.then };
}

/** The endpoint one path or audience names, or undefined for anything else, admin included. */
export function mongooseEndpointName(value: string): MongooseEndpoint | undefined {
  const path = value.startsWith('http') ? new URL(value).pathname.replace(/\/$/, '') : value.replace(/\/$/, '');
  return MONGOOSE_ENDPOINTS.find(endpoint => MONGOOSE_ENDPOINT_AUDIENCES[endpoint] === path || MONGOOSE_ENDPOINT_PATHS[endpoint] === path);
}

/**
 * The closed reasons a Mongoose answer can carry. `data_not_connected` and `endpoint_not_allowed` are
 * upstream wire codes (aa105bc6 tool_errors.py:243-247, access_policy.py:47-48); the rest are ours.
 */
export const MONGOOSE_CLOSED_REASONS = ['restricted', 'not_found', 'invalid_arguments', 'cursor_invalid', 'cursor_stale', 'data_not_connected', 'endpoint_not_allowed'] as const;
export type MongooseClosedReason = (typeof MONGOOSE_CLOSED_REASONS)[number];

const UPSTREAM_REASON: Readonly<Record<string, MongooseClosedReason>> = {
  restricted: 'restricted', not_found: 'not_found', invalid_arguments: 'invalid_arguments',
  cursor_invalid: 'cursor_invalid', cursor_stale: 'cursor_stale',
  data_not_connected: 'data_not_connected', lightdash_reconnect_required: 'data_not_connected',
  endpoint_not_allowed: 'endpoint_not_allowed', access_denied: 'endpoint_not_allowed',
};

/** One upstream code to one closed reason; anything unknown is undefined and stays a plain failure. */
export function mongooseClosedReason(code: string): MongooseClosedReason | undefined {
  return Object.hasOwn(UPSTREAM_REASON, code) ? UPSTREAM_REASON[code] : undefined;
}

/** One owner line per closed reason that is a state, never a failure. */
export const MONGOOSE_OWNER_LINES: Readonly<Partial<Record<MongooseClosedReason, string>>> = {
  data_not_connected: 'your Lightdash token is not connected in Mongoose settings',
  endpoint_not_allowed: 'your account is not in the Mongoose CRM teams',
};

export function mongooseOwnerLine(reason: MongooseClosedReason): string | undefined {
  return Object.hasOwn(MONGOOSE_OWNER_LINES, reason) ? MONGOOSE_OWNER_LINES[reason] : undefined;
}

/** The owner line naming the endpoints that still need a sign-in, in fixed order. */
export function mongooseSignInLine(pending: readonly MongooseEndpoint[]): string | undefined {
  const names = MONGOOSE_ENDPOINTS.filter(endpoint => pending.includes(endpoint));
  if (!names.length) return undefined;
  return `Sign in to Mongoose ${names.join(', ')}`;
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
  /** Which of the three endpoints this reader speaks to; it decides the envelope and the audience. */
  endpoint: MongooseEndpoint;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  /** Largest search window this endpoint may request, narrowed by the policy. */
  maxSearchLimit: number;
  /** Largest list window this endpoint may request, narrowed by the policy. */
  maxListLimit: number;
  /** Longest query text this endpoint may send. */
  queryChars: number;
}

export interface MongooseEvidence extends SourceDispatchEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  /** The remote tool the server answered; every granted read tool, not only the typed ones. */
  tool: string;
  source: ResultScope;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
  /** The verified second read of a hit's ref, when the caller asked for depth. */
  followUp?: { tool: string; decodedResult: unknown; payload: StoredPayload };
}
export interface MongooseRefused { state: 'refused'; reason: string }
export interface MongooseUnknown { state: 'unknown'; reason: string }
export type MongooseResult = MongooseEvidence | MongooseRefused | MongooseUnknown;

/** One company lookup: mode answer answers a question and reads its top hit; mode browse lists entities. */
export interface SearchInput {
  query: string;
  mode?: 'answer' | 'browse';
  limit?: number;
  cursor?: string;
  verbose?: boolean;
}

export interface ReadInput { ref: string; depth?: 'summary' | 'full' | 'all'; cursor?: string }

export interface MongooseReader {
  /** The endpoint this reader speaks to. */
  readonly endpoint: MongooseEndpoint;
  /** A company lookup on the knowledge endpoint. */
  searchCompany(input: SearchInput, signal?: AbortSignal): Promise<MongooseResult>;
  /** One entity by a ref a search returned, passed verbatim. */
  read(input: ReadInput, signal?: AbortSignal): Promise<MongooseResult>;
  /** One company page: the profile is list_companies then read on the returned ref. */
  listCompanies(input: { limit?: number; filter?: Record<string, unknown> }, signal?: AbortSignal): Promise<MongooseResult>;
  /** Any other envelope tool of this endpoint, with the model's own arguments. */
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult>;
}

export interface MongooseOptions { port: McpPort; registry: McpRegistry; config: MongooseConfig }

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
function preflight(registry: McpRegistry, settings: Settings, envelope: readonly string[], tool: string): string | undefined {
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
  // The grant may only carry names this endpoint's own envelope serves: a knowledge-only grant that
  // also carries a data name is one writer or one crossed audience too many.
  if (visible.some(name => !envelope.includes(name))) return 'ineligible-tool-granted';
  if (!grant.toolNames.includes(tool)) return 'tool-not-granted';
  if (!visible.includes(tool)) return 'required-definition-absent';
  return undefined;
}

export function createMongooseReader(options: MongooseOptions): MongooseReader {
  const { port, registry, config } = options;
  const envelope = MONGOOSE_ENDPOINT_TOOLS[config.endpoint];
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
    const result: CallResult = await port.call(request, signal);
    if (isFailed(result)) return { state: result.state, reason: result.reason };
    if (signal?.aborted) return { state: 'unknown', reason: 'cancelled-after-dispatch' };
    return {
      state: result.state,
      tool,
      source: { ...result.source },
      ...(result[SOURCE_DISPATCH] ? { [SOURCE_DISPATCH]: result[SOURCE_DISPATCH] } : {}),
      observedAt: result.freshness.receivedAt,
      coverage: structuredClone(result.coverage),
      decodedResult: structuredClone(result.decodedResult),
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
  }

  function boundedQuery(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= settings.queryChars ? value : undefined;
  }

  function limited(value: unknown, fallback: number, max: number): Record<string, unknown> | undefined {
    if (value === undefined) return { limit: Math.min(fallback, max) };
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) return undefined;
    return { limit: value as number };
  }

  /** The exact outgoing arguments: no key outside the endpoint's own schema reaches the wire. */
  function typedArgs(input: object, keys: readonly string[], textKeys: readonly string[]): Record<string, unknown> | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 4000) return undefined;
    const args = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    if (Object.keys(args).some(key => !keys.includes(key))) return undefined;
    if (textKeys.some(key => args[key] !== undefined && (typeof args[key] !== 'string' || args[key]!.length === 0 || (args[key] as string).length > settings.queryChars))) return undefined;
    return args;
  }

  /** The top hit's ref, read in a second call so the answer carries the entity behind it. */
  async function followUpRead(evidence: MongooseEvidence, depth: ReadInput['depth'], signal?: AbortSignal): Promise<MongooseResult> {
    const ref = topRef(evidence.decodedResult);
    if (ref === undefined) return evidence;
    const read = await dispatch('read', { ref, depth }, signal);
    if (read.state !== 'completed') return read;
    return { ...evidence, followUp: { tool: 'read', decodedResult: read.decodedResult, payload: read.response } };
  }

  return {
    endpoint: config.endpoint,
    async searchCompany(input: SearchInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, envelope, 'search');
      if (denied) return { state: 'refused', reason: denied };
      const query = boundedQuery(input.query);
      if (query === undefined) return { state: 'refused', reason: 'invalid-query' };
      const bounded = limited(input.limit, MONGOOSE_DEFAULTS.searchLimit, settings.maxSearchLimit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      // Only the published search schema's own keys go on the wire: query, mode, limit, cursor, verbose.
      const args = typedArgs(input, ['query', 'mode', 'limit', 'cursor', 'verbose'], ['query', 'cursor']);
      if (!args) return { state: 'refused', reason: 'invalid-search-input' };
      const mode = input.mode ?? 'answer';
      const evidence = await dispatch('search', { ...args, query, mode, ...bounded }, signal);
      // A question reads the hit behind it; a browse lists and never spends a second call.
      if (evidence.state === 'completed' && mode === 'answer') return followUpRead(evidence, 'summary', signal);
      return evidence;
    },
    async read(input: ReadInput, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, envelope, 'read');
      if (denied) return { state: 'refused', reason: denied };
      const args = typedArgs(input, ['ref', 'depth', 'cursor'], ['ref', 'cursor']);
      if (!args || args['ref'] === undefined) return { state: 'refused', reason: 'invalid-ref' };
      return dispatch('read', args, signal);
    },
    async listCompanies(input: { limit?: number; filter?: Record<string, unknown> }, signal?: AbortSignal): Promise<MongooseResult> {
      const denied = preflight(registry, settings, envelope, 'list_companies');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = limited(input.limit, MONGOOSE_DEFAULTS.listLimit, settings.maxListLimit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      const args = typedArgs(input, ['filter', 'limit'], []);
      if (!args) return { state: 'refused', reason: 'invalid-list-input' };
      return dispatch('list_companies', { ...args, ...bounded }, signal);
    },
    async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MongooseResult> {
      // Only a read name this endpoint's envelope carries is forwarded; the grant is checked in preflight.
      if (!envelope.includes(tool)) return { state: 'refused', reason: 'tool-not-in-envelope' };
      const denied = preflight(registry, settings, envelope, tool);
      if (denied) return { state: 'refused', reason: denied };
      if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 4000) return { state: 'refused', reason: 'invalid-arguments' };
      return dispatch(tool, args, signal);
    },
  };
}

/** The first hit's ref in a search envelope, when the server returned one. */
export function topRef(decoded: unknown): string | undefined {
  const envelope = envelopeOf(decoded);
  const items = envelope?.['items'];
  if (!Array.isArray(items) || !items.length) return undefined;
  const first = items[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const ref = (first as Record<string, unknown>)['ref'];
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 512 ? ref : undefined;
}

/** The JSON body of one MCP result: the first text content block, parsed when it is JSON. */
export function envelopeOf(decoded: unknown): Record<string, unknown> | undefined {
  const content = (decoded as { content?: unknown } | undefined)?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text = (first as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/**
 * V7: the published catalogue of one endpoint, as the planner sees it. Mongoose's own tool list carries
the input schema and description of every tool; this connector forwards them instead of an empty
schema, so a planner can build a real `run_metric_query` argument shape.
 */
const PUBLISHED_CATALOGUE = new Map<string, ReadonlyMap<string, { description: string; parameters: Record<string, unknown> }>>();

/** The closed code a catalogue that cannot be sanitized fails with. Never a silent empty schema. */
export const MONGOOSE_SCHEMA_REFUSAL = 'schema_unsanitizable';

export class MongooseSchemaRefusal extends Error {
  override readonly name = 'MongooseSchemaRefusal';
  constructor(readonly path: string, readonly detail: string) {
    super(`${MONGOOSE_SCHEMA_REFUSAL} at ${path}: ${detail}`);
  }
}

/** The keywords the provider accepts. Anything else is refused, never dropped in silence. */
const PROVIDER_KEYWORDS = new Set([
  'type', 'description', 'title', 'format', 'pattern', 'enum', 'properties', 'required', 'items',
  'additionalProperties', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'default', 'const', 'anyOf', 'oneOf', 'allOf',
]);
const INTEGER_KEYWORDS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems',
]);
const TEXT_KEYWORDS = new Set(['description', 'title', 'format', 'pattern']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function sanitizedInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MongooseSchemaRefusal(path, 'not a number');
  // The provider takes integers only: a float bound is rounded toward zero, never dropped.
  return Math.trunc(value);
}

/**
 * V7: one published input schema in the shape the provider accepts. Integers only, no keyword the
 * provider rejects; an unreadable schema throws MongooseSchemaRefusal so the tool is excluded with a closed receipt.
 */
export function mongooseSanitizeParameters(schema: unknown, path = 'schema', root: unknown = schema, refs: ReadonlySet<string> = new Set()): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new MongooseSchemaRefusal(path, 'not an object');
  const row = schema as Record<string, unknown>;
  if (Object.hasOwn(row, '$ref')) {
    const ref = row['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith('#/') || refs.has(ref)) throw new MongooseSchemaRefusal(path, 'unresolvable reference');
    let target: unknown = root;
    for (const part of ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (target === null || typeof target !== 'object' || !Object.hasOwn(target, part)) throw new MongooseSchemaRefusal(path, 'missing reference');
      target = (target as Record<string, unknown>)[part];
    }
    const resolved = mongooseSanitizeParameters(target, path, root, new Set([...refs, ref]));
    const siblings = Object.fromEntries(Object.entries(row).filter(([key]) => !['$ref', '$defs', '$schema'].includes(key)));
    return Object.keys(siblings).length ? { allOf: [resolved, mongooseSanitizeParameters(siblings, path, root, refs)] } : resolved;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '$defs' || key === '$schema') continue;
    const at = `${path}.${key}`;
    if (!PROVIDER_KEYWORDS.has(key)) throw new MongooseSchemaRefusal(at, 'keyword the provider rejects');
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (!Array.isArray(value) || !value.length) throw new MongooseSchemaRefusal(at, 'not a list of schemas');
      out[key] = value.map((member, index) => mongooseSanitizeParameters(member, `${at}.${index}`, root, refs)); continue;
    }
    if (key === 'multipleOf') {
      // F4: truncating a bounded step to zero hands AJV an invalid keyword, so a fractional step is refused
      // loudly instead of being rounded into something the schema never said.
      const step = sanitizedInteger(value, at);
      if (typeof value !== 'number' || !Number.isInteger(value) || step < 1) throw new MongooseSchemaRefusal(at, 'multipleOf must be a whole number');
      out[key] = step; continue;
    }
    if (INTEGER_KEYWORDS.has(key)) { out[key] = sanitizedInteger(value, at); continue; }
    if (TEXT_KEYWORDS.has(key)) {
      if (typeof value !== 'string') throw new MongooseSchemaRefusal(at, 'not a string');
      out[key] = value; continue;
    }
    if (key === 'type') {
      const types = Array.isArray(value) ? value : [value];
      if (!types.length || types.some(entry => typeof entry !== 'string' || !SCHEMA_TYPES.has(entry))) throw new MongooseSchemaRefusal(at, 'unknown type');
      out[key] = Array.isArray(value) ? types : types[0]; continue;
    }
    if (key === 'required') {
      if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new MongooseSchemaRefusal(at, 'not a list of names');
      out[key] = [...value]; continue;
    }
    if (key === 'enum') {
      if (!Array.isArray(value) || !value.length || value.some(entry => typeof entry === 'object' && entry !== null)) throw new MongooseSchemaRefusal(at, 'not a list of literals');
      out[key] = value.map(entry => typeof entry === 'number' ? Math.trunc(entry) : entry); continue;
    }
    if (key === 'properties') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MongooseSchemaRefusal(at, 'not an object');
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, mongooseSanitizeParameters(sub, `${at}.${name}`, root, refs)]));
      continue;
    }
    if (key === 'items') { out[key] = mongooseSanitizeParameters(value, at, root, refs); continue; }
    if (key === 'additionalProperties') {
      out[key] = typeof value === 'boolean' ? value : mongooseSanitizeParameters(value, at, root, refs); continue;
    }
    if (key === 'default' || key === 'const') { out[key] = typeof value === 'number' ? Math.trunc(value) : value; continue; }
  }
  return out;
}

/**
 * V7: one endpoint's published tool list becomes the planner-facing catalogue. Called once per connect
 * from the catalogue intake; a tool whose schema cannot be sanitized is excluded with one receipt.
 */
export function mongoosePublishCatalogue(endpointId: string, tools: readonly ToolDefinition[], refused?: (tool: string) => void): void {
  const published = new Map<string, { description: string; parameters: Record<string, unknown> }>();
  for (const tool of tools) {
    const description = typeof tool.description === 'string' && tool.description.trim() !== '' ? tool.description : `Mongoose tool ${tool.name}`;
    try {
      published.set(tool.name, { description, parameters: mongooseSanitizeParameters(tool.inputSchema, `${endpointId}.${tool.name}`) });
    } catch (error) {
      if (!(error instanceof MongooseSchemaRefusal)) throw error;
      refused?.(tool.name);
    }
  }
  PUBLISHED_CATALOGUE.set(endpointId, published);
}

/** The published declaration of one tool, or undefined when this endpoint's catalogue is not loaded. */
export function mongoosePublishedTool(endpointId: string, name: string): { description: string; parameters: Record<string, unknown> } | undefined {
  return PUBLISHED_CATALOGUE.get(endpointId)?.get(name);
}

export { SOURCE_DISPATCH };
export type { ReadGrant, CompletedResult };
