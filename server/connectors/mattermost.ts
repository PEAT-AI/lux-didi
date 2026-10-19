import { SOURCE_DISPATCH, SOURCE_CHILD_DISPATCHES, type SourceDispatchEvidence, type SourceDispatchRef } from '../adapters/mcp/port.js';
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

/** The connector's own view name: one synthesized digest over several child reads. */
export const MATTERMOST_ATTENTION_TOOL = 'mattermost_attention';

/** Attention window and read bounds; a caller may only narrow `days` and `limit`. */
export const MATTERMOST_ATTENTION = { days: 7, maxDays: 30, limit: 20, maxDmChannels: 4, maxThreads: 8, historyLimit: 20, snippet: 160 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** General search looks back 90 days unless the caller names an older period. */
const SEARCH_WINDOW_MS = 90 * DAY_MS;

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

/** A child tool read, or the connector's own synthesized digest over several reads. */
export type MattermostEvidenceTool = MattermostTool | typeof MATTERMOST_ATTENTION_TOOL;

/** Opaque local evidence, mirroring the Lux knowledge connector shape. */
export interface MattermostEvidence extends SourceDispatchEvidence {
  decodedResult: unknown;
  state: 'completed' | 'tool-error' | 'protocol-error';
  tool: MattermostEvidenceTool;
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
export interface ThreadInput { postId: string }
export interface QueryInput { query: string; limit?: number; after?: string; before?: string }
export interface AttentionInput { days?: number; limit?: number }
export type AttentionReason = 'mention' | 'dm' | 'thread';

/** One item that may be waiting on the owner, with the reason it surfaced. */
export interface AttentionItem {
  reason: AttentionReason;
  channel: string;
  author: string;
  time: string;
  permalink: string;
  snippet: string;
}
/** The digest the attention view renders: newest first, one line per item. */
export interface MattermostAttention { after: string; items: AttentionItem[] }

export interface MattermostReader {
  whoami(signal?: AbortSignal): Promise<MattermostResult>;
  getChannelHistory(input: ChannelInput, signal?: AbortSignal): Promise<MattermostResult>;
  getThread(input: ThreadInput, signal?: AbortSignal): Promise<MattermostResult>;
  search(input: QueryInput, signal?: AbortSignal): Promise<MattermostResult>;
  listChannels(input: BoundedInput, signal?: AbortSignal): Promise<MattermostResult>;
  attention(input: AttentionInput, signal?: AbortSignal): Promise<MattermostResult>;
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
export interface MattermostChannel { id?: string; name?: string; displayName?: string; type?: string }

/**
 * The reader's channel index: the list_channel result is stable for minutes, so one internal read
 * serves every name this reader resolves until the short TTL lapses. The instance dies with the reader.
 */
class ChannelIndexCache {
  #channels: MattermostChannel[] | undefined;
  #at = 0;
  origin: SourceDispatchRef | undefined;
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
    ...(typeof entry['type'] === 'string' ? { type: entry['type'] } : {}),
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

/** The text a completed child read carries inside its MCP content envelope. */
function contentText(decoded: unknown): string | undefined {
  const result = isRecord(decoded) && isRecord(decoded['result']) ? decoded['result'] : decoded;
  const content = isRecord(result) ? result['content'] : undefined;
  if (Array.isArray(content) && content.length > 0 && isRecord(content[0]) && typeof content[0]['text'] === 'string') return content[0]['text'] as string;
  return typeof decoded === 'string' ? decoded : undefined;
}

/** The parsed JSON body of a completed child read; undefined when the child sent no JSON. */
function contentJson(decoded: unknown): unknown {
  const text = contentText(decoded);
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function firstText(source: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** One post as the child describes it, carrying its own instant so every rule compares numbers. */
interface ChildPost { id?: string; rootId?: string; channel: string; author: string; text: string; at: number; permalink: string }

function childPost(raw: Record<string, unknown>): ChildPost | undefined {
  const text = typeof raw['text'] === 'string' ? raw['text'] : typeof raw['message'] === 'string' ? raw['message'] : '';
  const stamp = firstText(raw, ['time', 'timestamp', 'create_at']);
  const parsed = stamp === '' ? Number.NaN : Date.parse(stamp);
  const at = Number.isNaN(parsed) ? Number(stamp) : parsed;
  if (text.trim() === '' || !Number.isFinite(at) || at <= 0) return undefined;
  const id = firstText(raw, ['id', 'post_id']);
  const rootId = firstText(raw, ['root_id', 'rootId']);
  return {
    ...(id !== '' ? { id } : {}),
    ...(rootId !== '' ? { rootId } : {}),
    channel: firstText(raw, ['channel', 'channel_name', 'channel_id']),
    author: firstText(raw, ['author', 'author_name', 'user_name', 'username']),
    text,
    at,
    permalink: firstText(raw, ['permalink', 'url']),
  };
}

/** The post list of any shape a child read carries: a bare array, a `posts` list or map, or `items`. */
function postsIn(decoded: unknown): Record<string, unknown>[] | undefined {
  const data = contentJson(decoded);
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return undefined;
  const list = data['posts'] ?? data['items'];
  if (Array.isArray(list)) return list.filter(isRecord);
  if (isRecord(list)) return Object.values(list).filter(isRecord);
  return undefined;
}

interface Owner { id: string; username: string; displayName: string }

function isOwnerPost(owner: Owner, author: string): boolean {
  const value = author.trim().toLowerCase();
  if (value === '') return false;
  return value === owner.username.toLowerCase() || (owner.displayName !== '' && value === owner.displayName.toLowerCase());
}

/** A mention is the owner's handle marked with @, never a bare matching word. */
function mentionsOwner(owner: Owner, text: string): boolean {
  const name = owner.username.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (name === '') return false;
  return new RegExp(`(?:^|[^\\w@])@${name}(?![\\w])`, 'iu').test(text);
}

/** A direct or group conversation: the child's type letter, or the two-account channel name. */
function isDirectChannel(channel: MattermostChannel, owner: Owner): boolean {
  if (channel.type === 'D' || channel.type === 'G') return true;
  const parts = (channel.name ?? '').split('__');
  return parts.length === 2 && owner.id !== '' && parts.includes(owner.id);
}

function snippetOf(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length <= MATTERMOST_ATTENTION.snippet ? line : `${line.slice(0, MATTERMOST_ATTENTION.snippet - 1)}...`;
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
      ...(result[SOURCE_DISPATCH] ? {[SOURCE_DISPATCH]:result[SOURCE_DISPATCH]} : {}),
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
    if (cached) { port.recordReuse?.(channelIndex.origin); return cached; }
    const denied = preflight(registry, settings, 'mattermost_list_channels');
    if (denied) return { error: denied };
    const evidence = await dispatch('mattermost_list_channels', limited(undefined)!, signal);
    if (evidence.state === 'refused' || evidence.state === 'unknown') return { error: evidence.reason };
    if (evidence.state !== 'completed') return { error: `channel-list-${evidence.state}` };
    const channels = parseChannelList(evidence.decodedResult);
    if (!channels) return { error: 'channel-list-unreadable' };
    channelIndex.set(channels);
    channelIndex.origin = evidence[SOURCE_DISPATCH];
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

  /** The owner identity: one whoami per process, dropped as soon as a read reports the session changed. */
  let identity: { owner: Owner; evidence: MattermostEvidence } | undefined;

  /** One internal read with its own preflight, so a composed digest never bypasses the grant. */
  async function read(tool: MattermostTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true; evidence: MattermostEvidence } | { ok: false; result: MattermostResult }> {
    const denied = preflight(registry, settings, tool);
    const evidence = denied === undefined ? await dispatch(tool, args, signal) : { state: 'refused' as const, reason: denied };
    if (evidence.state === 'completed') return { ok: true, evidence };
    // Any refused, failed or unknown read may mean the session changed, so the cached identity goes.
    identity = undefined;
    return { ok: false, result: evidence };
  }

  async function ownerIdentity(signal?: AbortSignal): Promise<{ ok: true; owner: Owner; evidence: MattermostEvidence } | { ok: false; result: MattermostResult }> {
    if (identity) { port.recordReuse?.(identity.evidence[SOURCE_DISPATCH]); return { ok: true, ...identity }; }
    const whoami = await read('mattermost_whoami', {}, signal);
    if (!whoami.ok) return whoami;
    const data = contentJson(whoami.evidence.decodedResult);
    const username = isRecord(data) ? firstText(data, ['username', 'user_name']) : '';
    if (!isRecord(data) || username === '') return { ok: false, result: { state: 'refused', reason: 'identity-unreadable' } };
    identity = {
      owner: { id: firstText(data, ['id', 'user_id']), username, displayName: firstText(data, ['display_name', 'displayName']) },
      evidence: whoami.evidence,
    };
    return { ok: true, ...identity };
  }

  /** The search window: the last 90 days by default, forwarded only for arguments the child declares. */
  function searchWindow(after: unknown, before: unknown): Record<string, string> | undefined {
    const lower = after === undefined ? new Date(Date.now() - SEARCH_WINDOW_MS).toISOString() : boundedText(after);
    if (lower === undefined) return undefined;
    const window: Record<string, string> = { after: lower };
    if (before !== undefined) {
      const upper = boundedText(before);
      if (upper === undefined) return undefined;
      window['before'] = upper;
    }
    const definition = port.visibleTools(settings.endpointId).find(entry => entry.name === 'mattermost_search');
    const schema = definition?.inputSchema;
    const declared = isRecord(schema) && isRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
    for (const key of Object.keys(window)) if (!declared.includes(key)) delete window[key];
    return window;
  }

  /** What needs a reply: mentions, direct and group messages, and threads whose newest post is not the owner's. */
  async function attention(input: AttentionInput, signal?: AbortSignal): Promise<MattermostResult> {
    const days = input.days === undefined ? MATTERMOST_ATTENTION.days : input.days;
    if (!Number.isSafeInteger(days) || days < 1 || days > MATTERMOST_ATTENTION.maxDays) return { state: 'refused', reason: 'invalid-days' };
    const limit = input.limit === undefined ? MATTERMOST_ATTENTION.limit : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > settings.maxLimit) return { state: 'refused', reason: 'limit-out-of-budget' };
    const who = await ownerIdentity(signal);
    if (!who.ok) return who.result;
    const children: SourceDispatchRef[] = who.evidence[SOURCE_DISPATCH] ? [who.evidence[SOURCE_DISPATCH]!] : [];
    const capture = (evidence: MattermostEvidence): void => { if (evidence[SOURCE_DISPATCH]) children.push(evidence[SOURCE_DISPATCH]!); };
    const cutoff = Date.now() - days * DAY_MS;
    const scored: { item: AttentionItem; at: number }[] = [];
    const seen = new Set<string>();
    const push = (reason: AttentionReason, post: ChildPost): void => {
      const item: AttentionItem = { reason, channel: post.channel, author: post.author, time: new Date(post.at).toISOString(), permalink: post.permalink, snippet: snippetOf(post.text) };
      const key = `${item.time}|${item.author}|${item.snippet}`;
      if (seen.has(key)) return;
      seen.add(key);
      scored.push({ item, at: post.at });
    };
    const threads = new Set<string>();
    const threadCandidate = (post: ChildPost): void => {
      const root = post.rootId ?? post.id;
      if (root !== undefined) threads.add(root);
    };
    // Threads the owner wrote in anywhere: the child's own-author search seeds them whatever the
    // channel, because a thread nobody mentioned the owner in never reaches the handle search.
    const written = await read('mattermost_search', { query: `from:${who.owner.username}`, limit: settings.maxLimit }, signal);
    if (!written.ok) return written.result;
    capture(written.evidence);
    for (const raw of postsIn(written.evidence.decodedResult) ?? []) {
      const post = childPost(raw);
      if (post !== undefined && post.at >= cutoff) threadCandidate(post);
    }
    // Mentions: the child's own handle search, with the window and the handle itself checked here.
    const mentions = await read('mattermost_search', { query: `@${who.owner.username}`, limit: settings.maxLimit }, signal);
    if (!mentions.ok) return mentions.result;
    capture(mentions.evidence);
    for (const raw of postsIn(mentions.evidence.decodedResult) ?? []) {
      const post = childPost(raw);
      if (post === undefined || post.at < cutoff) continue;
      if (isOwnerPost(who.owner, post.author)) { threadCandidate(post); continue; }
      if (!mentionsOwner(who.owner, post.text)) continue;
      push('mention', post);
      threadCandidate(post);
    }
    // Direct and group conversations: the owner's own posts await no reply, but they seed the thread rule.
    const channels = await loadChannels(signal);
    if (!Array.isArray(channels)) return { state: 'refused', reason: channels.error };
    if (channelIndex.origin) children.push(channelIndex.origin);
    for (const channel of channels.filter(entry => isDirectChannel(entry, who.owner)).slice(0, MATTERMOST_ATTENTION.maxDmChannels)) {
      const reference = channel.name ?? channel.id;
      if (reference === undefined) continue;
      const history = await read('mattermost_get_channel_history', { channel: reference, limit: MATTERMOST_ATTENTION.historyLimit }, signal);
      if (!history.ok) return history.result;
    capture(history.evidence);
      for (const raw of postsIn(history.evidence.decodedResult) ?? []) {
        const post = childPost(raw);
        if (post === undefined || post.at < cutoff) continue;
        if (!isOwnerPost(who.owner, post.author)) push('dm', post);
        threadCandidate(post);
      }
    }
    // Threads the owner started or joined: only a newest post from someone else awaits a reply.
    for (const rootId of [...threads].slice(0, MATTERMOST_ATTENTION.maxThreads)) {
      const thread = await read('mattermost_get_thread', { post_id: rootId }, signal);
      if (!thread.ok) continue;
      capture(thread.evidence);
      const posts = (postsIn(thread.evidence.decodedResult) ?? []).map(childPost).filter((post): post is ChildPost => post !== undefined);
      const newest = posts.reduce<ChildPost | undefined>((latest, post) => (latest === undefined || post.at > latest.at ? post : latest), undefined);
      if (newest === undefined || newest.at < cutoff || isOwnerPost(who.owner, newest.author)) continue;
      push('thread', newest);
    }
    const items = scored.sort((left, right) => right.at - left.at).slice(0, limit).map(entry => entry.item);
    // The digest stands on the identity read: its provenance is what the projection reports.
    const composed = {...who.evidence};
    delete composed[SOURCE_DISPATCH];
    return { ...composed, [SOURCE_CHILD_DISPATCHES]: children, tool: MATTERMOST_ATTENTION_TOOL, decodedResult: { after: new Date(cutoff).toISOString(), items } satisfies MattermostAttention };
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
      // The child's mattermost_get_thread schema declares only post_id (and format) and closes the
      // object, so the pre-dispatch schema check refuses any extra key; send post_id alone.
      return dispatch('mattermost_get_thread', { post_id: postId }, signal);
    },
    async search(input: QueryInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_search');
      if (denied) return { state: 'refused', reason: denied };
      const query = boundedText(input.query);
      if (query === undefined) return { state: 'refused', reason: 'invalid-query' };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      const window = searchWindow(input.after, input.before);
      if (window === undefined) return { state: 'refused', reason: 'invalid-window' };
      return dispatch('mattermost_search', { query, ...bounded, ...window }, signal);
    },
    async listChannels(input: BoundedInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_list_channels');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('mattermost_list_channels', bounded, signal);
    },
    attention,
  };
}
