import type { CallRequest, CompletedResult, McpPort, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';

/**
 * The only Mattermost tools this connector may ever read, in fixed order. Posting,
 * reacting and editing are deliberately absent: the child holds its own session token
 * and no caller can widen the read envelope.
 */
export const MATTERMOST_TOOLS = [
  'mattermost_whoami',
  'mattermost_get_channel_history',
  'mattermost_get_thread',
  'mattermost_search',
  'mattermost_list_channels',
] as const;
export type MattermostTool = (typeof MATTERMOST_TOOLS)[number];

export interface MattermostConfig {
  endpointId: string;
  account: string;
  resource: string;
  schemaDigest: string;
  generation: number;
  /** Batch budget: largest `limit` a bounded read caller may select. */
  maxLimit: number;
  /** Bound on query or identifier length in characters. */
  maxQueryChars: number;
}

export interface MattermostEvidence {
  classification: 'unknown';
  capability: 'local-only';
  tool: MattermostTool;
  source: CompletedResult['source'];
  observedAt: number;
  coverage: CompletedResult['coverage'];
  projection: CompletedResult['projection'];
  response: StoredPayload;
}
export interface MattermostRefused { state: 'refused'; reason: string }
export interface MattermostUnknown { state: 'unknown'; reason: string }
export type MattermostResult =
  | (MattermostEvidence & { state: 'completed' | 'tool-error' | 'protocol-error' })
  | MattermostRefused
  | MattermostUnknown;

/** The one label a caller shows when the child has no usable session. Never an empty success. */
export const MATTERMOST_AUTH_NEEDED = 'auth needed: run mattermost_login once';

export interface MattermostReader {
  whoami(signal?: AbortSignal): Promise<MattermostResult>;
  getChannelHistory(channel: string, limit: number, signal?: AbortSignal): Promise<MattermostResult>;
  getThread(postId: string, limit: number, signal?: AbortSignal): Promise<MattermostResult>;
  search(query: string, limit: number, signal?: AbortSignal): Promise<MattermostResult>;
  listChannels(limit: number, signal?: AbortSignal): Promise<MattermostResult>;
  status(signal?: AbortSignal): Promise<string>;
}

export interface MattermostOptions {
  port: McpPort;
  registry: McpRegistry;
  config: MattermostConfig;
}

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MATTERMOST_TOOLS);
const AUTH_MARKER = /not authenticated|unauthorized|no session|mattermost_login|token (?:missing|expired)/i;

/** Distinguishes the adapter's non-completed outcomes from a completed protocol result. */
type FailedCall = { state: 'refused' | 'unknown'; reason: string };
function isFailed(result: { state: string }): result is FailedCall {
  return result.state === 'refused' || result.state === 'unknown';
}

function positiveSafeInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  maxLimit: number; maxQueryChars: number;
}

function preflight(registry: McpRegistry, settings: Settings, tool: MattermostTool): string | undefined {
  let grant;
  try {
    registry.endpoint(settings.endpointId);
    grant = registry.currentGrant(settings.endpointId);
  } catch { return 'source-unavailable'; }
  if (!grant) return 'grant-absent';
  if (grant.schemaDigest !== settings.schemaDigest) return 'schema-drift';
  if (grant.generation !== settings.generation) return 'grant-generation-mismatch';
  if (grant.account !== settings.account || grant.resource !== settings.resource) return 'grant-scope-mismatch';
  const visible = registry.visibleTools(settings.endpointId).map(definition => definition.name);
  if (visible.some(name => !ELIGIBLE.has(name))) return 'ineligible-tool-granted';
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
    generation: config.generation,
    maxLimit: config.maxLimit,
    maxQueryChars: config.maxQueryChars,
  };

  async function dispatch(tool: MattermostTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<MattermostResult> {
    const denied = preflight(registry, settings, tool);
    if (denied) return { state: 'refused', reason: denied };
    if (signal?.aborted) return { state: 'refused', reason: 'cancelled-before-dispatch' };
    const request: CallRequest = {
      endpointId: settings.endpointId,
      toolName: tool,
      arguments: args,
      generation: settings.generation,
      account: settings.account,
      resource: settings.resource,
    };
    const result = await port.call(request, signal);
    if (isFailed(result)) return { state: result.state, reason: result.reason };
    // A child with no session answers with a tool error, not a silent empty success.
    if (result.state === 'tool-error' && AUTH_MARKER.test(result.projection.text)) {
      return { state: 'unknown', reason: MATTERMOST_AUTH_NEEDED };
    }
    const evidence: MattermostEvidence = {
      classification: 'unknown',
      capability: 'local-only',
      tool,
      source: structuredClone(result.source),
      observedAt: result.freshness.receivedAt,
      coverage: structuredClone(result.coverage),
      projection: structuredClone(result.projection),
      response: structuredClone(result.payload),
    };
    return { state: result.state, ...evidence };
  }

  return {
    async whoami(signal) { return dispatch('mattermost_whoami', {}, signal); },
    async getChannelHistory(channel, limit, signal) {
      if (!boundedText(channel, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-channel' };
      if (!positiveSafeInteger(limit, settings.maxLimit)) return { state: 'refused', reason: 'history-limit-out-of-budget' };
      return dispatch('mattermost_get_channel_history', { channel, limit }, signal);
    },
    async getThread(postId, limit, signal) {
      if (!boundedText(postId, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-post-id' };
      if (!positiveSafeInteger(limit, settings.maxLimit)) return { state: 'refused', reason: 'thread-limit-out-of-budget' };
      return dispatch('mattermost_get_thread', { post_id: postId, limit }, signal);
    },
    async search(query, limit, signal) {
      if (!boundedText(query, settings.maxQueryChars)) return { state: 'refused', reason: 'invalid-query' };
      if (!positiveSafeInteger(limit, settings.maxLimit)) return { state: 'refused', reason: 'search-limit-out-of-budget' };
      return dispatch('mattermost_search', { query, limit }, signal);
    },
    async listChannels(limit, signal) {
      if (!positiveSafeInteger(limit, settings.maxLimit)) return { state: 'refused', reason: 'list-limit-out-of-budget' };
      return dispatch('mattermost_list_channels', { limit }, signal);
    },
    async status(signal) {
      const result = await dispatch('mattermost_whoami', {}, signal);
      if (result.state === 'completed' && result.projection.text.trim().length > 0) return 'ready';
      if (result.state === 'unknown' && result.reason === MATTERMOST_AUTH_NEEDED) return MATTERMOST_AUTH_NEEDED;
      if (result.state === 'completed') return MATTERMOST_AUTH_NEEDED;
      return `unavailable: ${result.state === 'refused' ? result.reason : 'mattermost-unreachable'}`;
    },
  };
}
