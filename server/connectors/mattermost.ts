import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The only Mattermost tools this connector may ever read, in fixed order. Posting, reacting
 * and editing are absent: the stdio child holds its own session token and no caller can widen
 * the read envelope.
 */
export const MATTERMOST_TOOLS = [
  'mattermost_whoami',
  'mattermost_get_channel_history',
  'mattermost_get_thread',
  'mattermost_search',
  'mattermost_list_channels',
] as const;
export type MattermostTool = (typeof MATTERMOST_TOOLS)[number];

/** Bounded argument defaults; a caller may only narrow these, never widen them. */
export const MATTERMOST_DEFAULTS = { limit: 12, maxLimit: 60, queryChars: 200 } as const;

/** The one label a caller shows when the child has no usable session. Never an empty success. */
export const MATTERMOST_AUTH_NEEDED = 'auth needed: run mattermost_login once';

export interface MattermostConfig {
  endpointId: string;
  account: string;
  resource: string;
  /** Reviewed discovery digest the trusted owner approved for this endpoint. */
  schemaDigest: string;
  /** Approved read-grant generation; must match the current registry grant. */
  generation: number;
  /** Largest `limit` any caller may select. Defaults 60, never above 60. */
  maxLimit?: number;
  /** Bound on a query or identifier in characters. Defaults 200, never above 200. */
  queryChars?: number;
}

/** Opaque local evidence, mirroring the Lux knowledge connector shape. */
export interface MattermostEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  tool: MattermostTool;
  source: ResultScope;
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}
export interface MattermostRefused { state: 'refused'; reason: string }
export interface MattermostUnknown { state: 'unknown'; reason: string }
export type MattermostResult = MattermostEvidence | MattermostRefused | MattermostUnknown;

export interface BoundedInput { limit?: number }
export interface ChannelInput { channel: string; limit?: number }
export interface ThreadInput { postId: string; limit?: number }
export interface QueryInput { query: string; limit?: number }

export interface MattermostReader {
  whoami(signal?: AbortSignal): Promise<MattermostResult>;
  getChannelHistory(input: ChannelInput, signal?: AbortSignal): Promise<MattermostResult>;
  getThread(input: ThreadInput, signal?: AbortSignal): Promise<MattermostResult>;
  search(input: QueryInput, signal?: AbortSignal): Promise<MattermostResult>;
  listChannels(input: BoundedInput, signal?: AbortSignal): Promise<MattermostResult>;
}

export interface MattermostOptions { port: McpPort; registry: McpRegistry; config: MattermostConfig }

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MATTERMOST_TOOLS);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One channel as the list_channels result describes it; the id is absent in some fixtures. */
export interface MattermostChannel { id?: string; name?: string; displayName?: string }

/**
 * The reader's channel index: the list_channel result is stable for minutes, so one internal read
 * serves every name this reader resolves until the short TTL lapses. The instance dies with the reader.
 */
class ChannelIndexCache {
  #channels: MattermostChannel[] | undefined;
  #at = 0;
  constructor(private readonly ttlMs: number = 10 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}
  get(): MattermostChannel[] | undefined {
    if (!this.#channels) return undefined;
    if (this.now() - this.#at >= this.ttlMs) { this.#channels = undefined; return undefined; }
    return this.#channels;
  }
  set(channels: MattermostChannel[]): void { this.#channels = channels; this.#at = this.now(); }
}

/** Decode the channels array out of a completed mattermost_list_channels content envelope. */
export function parseChannelList(parsed: unknown): MattermostChannel[] | undefined {
  const result = isRecord(parsed) && isRecord(parsed['result']) ? parsed['result'] : parsed;
  const content = isRecord(result) ? result['content'] : undefined;
  const text = Array.isArray(content) && content.length > 0 && isRecord(content[0]) && typeof content[0]['text'] === 'string'
    ? content[0]['text'] as string
    : typeof parsed === 'string' ? parsed : undefined;
  if (text === undefined) return undefined;
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data['channels']) ? data['channels'] : undefined;
  if (!list) return undefined;
  return list.filter(isRecord).map(entry => ({
    ...(typeof entry['id'] === 'string' ? { id: entry['id'] } : {}),
    ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
    ...(typeof entry['display_name'] === 'string' ? { displayName: entry['display_name'] }
      : typeof entry['displayName'] === 'string' ? { displayName: entry['displayName'] } : {}),
  }));
}

/**
 * Resolve a caller's channel reference (id, name, or display name) against the known channel list.
 * Ambiguous and unknown references fail loud with the closest known names, never a silent empty read.
 */
export function resolveChannelReference(reference: string, channels: readonly MattermostChannel[]): { channel: string } | { error: string } {
  const wanted = reference.trim().replace(/^#/, '');
  if (wanted === '') return { error: 'invalid-channel' };
  const lower = wanted.toLowerCase();
  const exactId = channels.find(channel => channel.id === wanted);
  if (exactId?.id) return { channel: exactId.id };
  const matches = channels.filter(channel =>
    (channel.name !== undefined && channel.name.toLowerCase() === lower) ||
    (channel.displayName !== undefined && channel.displayName.toLowerCase() === lower));
  const label = (channel: MattermostChannel) => channel.displayName ?? channel.name ?? channel.id ?? '';
  if (matches.length === 1) { const only = matches[0]!; return { channel: only.id ?? only.name ?? wanted }; }
  if (matches.length > 1) return { error: `channel-ambiguous: ${wanted} matches ${matches.map(label).join(', ')}` };
  const prefix = channels.filter(channel => label(channel).toLowerCase().startsWith(lower[0] ?? ''));
  const closest = (prefix.length ? prefix : channels).map(label).filter(Boolean).slice(0, 5);
  return { error: `channel-not-found: ${wanted}; closest names: ${closest.join(', ') || 'none'}` };
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  maxLimit: number; queryChars: number;
}

/** Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change. */
function preflight(registry: McpRegistry, settings: Settings, tool: MattermostTool): string | undefined {
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

export function createMattermostReader(options: MattermostOptions): MattermostReader {
  const { port, registry, config } = options;
  const settings: Settings = {
    endpointId: config.endpointId,
    account: config.account,
    resource: config.resource,
    schemaDigest: config.schemaDigest,
    generation: requirePositiveSafeInteger(config.generation),
    maxLimit: Math.min(positive(config.maxLimit, MATTERMOST_DEFAULTS.maxLimit), MATTERMOST_DEFAULTS.maxLimit),
    queryChars: Math.min(positive(config.queryChars, MATTERMOST_DEFAULTS.queryChars), MATTERMOST_DEFAULTS.queryChars),
  };

  const schemaValidator = new AjvJsonSchemaValidator();

  async function dispatch(tool: MattermostTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<MattermostResult> {
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
    const evidence: MattermostEvidence = {
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

  function boundedText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= settings.queryChars ? value : undefined;
  }
  function limited(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return { limit: Math.min(MATTERMOST_DEFAULTS.limit, settings.maxLimit) };
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > settings.maxLimit) return undefined;
    return { limit: value as number };
  }

  /** One list_channels read per session serves every channel name this reader resolves. */
  const channelIndex = new ChannelIndexCache();
  async function loadChannels(signal?: AbortSignal): Promise<MattermostChannel[] | { error: string }> {
    const cached = channelIndex.get();
    if (cached) return cached;
    const denied = preflight(registry, settings, 'mattermost_list_channels');
    if (denied) return { error: denied };
    const evidence = await dispatch('mattermost_list_channels', limited(undefined)!, signal);
    if (evidence.state === 'refused' || evidence.state === 'unknown') return { error: evidence.reason };
    if (evidence.state !== 'completed') return { error: `channel-list-${evidence.state}` };
    const channels = parseChannelList(evidence.decodedResult);
    if (!channels) return { error: 'channel-list-unreadable' };
    channelIndex.set(channels);
    return channels;
  }
  async function resolveChannel(reference: string, signal?: AbortSignal): Promise<string | { error: string }> {
    // A 26 character Mattermost id is already dispatchable; anything else is a name or display name.
    if (/^[a-z0-9]{26}$/.test(reference)) return reference;
    const channels = await loadChannels(signal);
    if (!Array.isArray(channels)) return channels;
    const resolved = resolveChannelReference(reference, channels);
    return 'channel' in resolved ? resolved.channel : { error: resolved.error };
  }

  return {
    async whoami(signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_whoami');
      if (denied) return { state: 'refused', reason: denied };
      return dispatch('mattermost_whoami', {}, signal);
    },
    async getChannelHistory(input: ChannelInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_get_channel_history');
      if (denied) return { state: 'refused', reason: denied };
      const reference = boundedText(input.channel);
      if (reference === undefined) return { state: 'refused', reason: 'invalid-channel' };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      const channel = await resolveChannel(reference, signal);
      if (typeof channel !== 'string') return { state: 'refused', reason: channel.error };
      return dispatch('mattermost_get_channel_history', { channel, ...bounded }, signal);
    },
    async getThread(input: ThreadInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_get_thread');
      if (denied) return { state: 'refused', reason: denied };
      const postId = boundedText(input.postId);
      if (postId === undefined) return { state: 'refused', reason: 'invalid-post-id' };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('mattermost_get_thread', { post_id: postId, ...bounded }, signal);
    },
    async search(input: QueryInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_search');
      if (denied) return { state: 'refused', reason: denied };
      const query = boundedText(input.query);
      if (query === undefined) return { state: 'refused', reason: 'invalid-query' };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('mattermost_search', { query, ...bounded }, signal);
    },
    async listChannels(input: BoundedInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_list_channels');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('mattermost_list_channels', bounded, signal);
    },
  };
}
