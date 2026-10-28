import { SOURCE_DISPATCH, SOURCE_CHILD_DISPATCHES, type SourceDispatchEvidence, type SourceDispatchRef } from '../adapters/mcp/port.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { CallRequest, CallResult, CompletedResult, McpPort, ReadGrant, ResultScope, StoredPayload } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import { ambiguityQuestion, currentBinding } from '../people/index.js';

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
/**
 * C-CHAT: the person reads a newer child publishes (mattermost-mcp draft PRs A and B). They join the read
 * envelope so an approval can grant them; a child without them still serves every base read, and each
 * chat read that needs one says once which capability is missing.
 */
export const MATTERMOST_PERSON_TOOLS = ['mattermost_resolve_person', 'mattermost_conversation_overview'] as const;
/** Every name the connector may ever read: the base reads plus the person reads. */
export const MATTERMOST_READ_TOOLS = [...MATTERMOST_TOOLS, ...MATTERMOST_PERSON_TOOLS] as const;
export type MattermostTool = (typeof MATTERMOST_READ_TOOLS)[number];

/** Bounded argument defaults; a caller may only narrow these, never widen them. */
export const MATTERMOST_DEFAULTS = { limit: 12, maxLimit: 50, queryChars: 200 } as const;

/** The one label a caller shows when the child has no usable session. Never an empty success. */
export const MATTERMOST_AUTH_NEEDED = 'auth needed: run mattermost_login once';

/** The connector's own view name: one synthesized digest over several child reads. */
export const MATTERMOST_ATTENTION_TOOL = 'mattermost_attention';
/** C-CHAT: the connector's own person, group and channel read, one composed view over several child reads. */
export const MATTERMOST_CHAT_TOOL = 'mattermost_chat';
/** C-CHAT: the window a person, group or channel read covers when the ask names none, and its page bounds. */
export const MATTERMOST_CHAT = { days: 30, limit: 8, maxOffset: 1000, maxPeople: 4, candidates: 3, overviewPosts: 3, channelRows: 10, groupRows: 200 } as const;

/** Attention window and read bounds; a caller may only narrow `days` and `limit`. */
export const MATTERMOST_ATTENTION = { days: 7, maxDays: 30, limit: 20, maxDmChannels: 10, maxThreads: 8, historyLimit: 20, snippet: 160 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The channel index ceiling: a child that never reports exhaustion must not be paged forever. */
const CHANNEL_INDEX_MAX = 2000;
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
  /** Largest `limit` any caller may select. Defaults 50, never above the child's own 50. */
  maxLimit?: number;
  /** Bound on a query or identifier in characters. Defaults 200, never above 200. */
  queryChars?: number;
  /**
   * #604: the names the approved policy holds. A connector composite is one of these, never a name
   * the endpoint publishes, so it is the policy that authorizes it while the registry grant keeps
   * the published names the child reads stand on.
   */
  names?: readonly string[];
}

/** A child tool read, or the connector's own synthesized digest over several reads. */
export type MattermostEvidenceTool = MattermostTool | typeof MATTERMOST_ATTENTION_TOOL | typeof MATTERMOST_CHAT_TOOL;

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
export interface QueryInput { query: string; limit?: number; after?: string; before?: string; /** A channel the ask names: name, display name or id. */ channel?: string; /** C-CHAT: the page after the ones already read. */ offset?: number }
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
export interface MattermostAttention { after: string; items: AttentionItem[]; /** C-CHAT: a capability this child lacks, said once. */ missing?: string }

/** C-CHAT: which chat read the ask wants: one person, the overview with one person, a channel, a group. */
export type ChatReadIntent = 'person' | 'overview' | 'channel' | 'group';
export interface ChatReadInput {
  intent: ChatReadIntent;
  person?: string; people?: string[]; channel?: string; query?: string;
  /** YYYY-MM-DD local days; a read without `from_date` covers the last `MATTERMOST_CHAT.days`. */
  from_date?: string; to_date?: string;
  /** person: only their posts, or both sides of the direct conversation. */
  sides?: 'theirs' | 'both';
  offset?: number; limit?: number;
}
/** One post a chat read returns, with its attachment text folded after the message. */
export interface ChatReadPost { id: string; channel: string; author: string; time: string; text: string; permalink?: string; rootId?: string; role?: 'you' | 'they' }
/** One section of a person overview: what kind, its name, and its counts in words. */
export interface ChatOverviewSection { kind: 'dm' | 'group' | 'channel'; name: string; counts: string; last?: string }
/**
 * The chat read's own decoded result. `read` says in plain words what was read, so the voice can name it;
 * `total` is the child's own count of matches, never the page; `clarify` is the question to ask back when a
 * person or channel is ambiguous; `missing` names a capability this child lacks.
 */
export interface MattermostChatRead {
  intent: ChatReadIntent;
  read: string;
  window: { from: string; to?: string };
  total?: number; returned: number; offset: number;
  posts: ChatReadPost[];
  sections?: ChatOverviewSection[];
  clarify?: string; notFound?: string; missing?: string;
}

export interface MattermostReader {
  whoami(signal?: AbortSignal): Promise<MattermostResult>;
  getChannelHistory(input: ChannelInput, signal?: AbortSignal): Promise<MattermostResult>;
  getThread(input: ThreadInput, signal?: AbortSignal): Promise<MattermostResult>;
  search(input: QueryInput, signal?: AbortSignal): Promise<MattermostResult>;
  listChannels(input: BoundedInput, signal?: AbortSignal): Promise<MattermostResult>;
  attention(input: AttentionInput, signal?: AbortSignal): Promise<MattermostResult>;
  chat(input: ChatReadInput, signal?: AbortSignal): Promise<MattermostResult>;
}

export interface MattermostOptions { port: McpPort; registry: McpRegistry; config: MattermostConfig }

const ELIGIBLE: ReadonlySet<string> = new Set<string>(MATTERMOST_READ_TOOLS);
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
export interface MattermostChannel { id?: string; name?: string; displayName?: string; type?: string; /** C-CHAT: the server's last post time, on a filtered page. */ lastPostAt?: string; /** C-CHAT: D and G member usernames, on a filtered page. */ members?: string[] }

/** A channel's member usernames, from the filtered page's field or the display name it joins. */
export function groupMembers(channel: MattermostChannel): string[] {
  return channel.members ?? (channel.displayName ?? '').split(/\s*,\s*/u).filter(Boolean);
}

/**
 * W15: a group conversation holds the resolved people when its members include every one of them. A
 * superset is enough: the real conversation carries the owner and often one more colleague.
 */
export function groupHoldsAll(channel: MattermostChannel, wanted: readonly string[]): boolean {
  const members = groupMembers(channel);
  return wanted.every(person => members.includes(person));
}

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
  clear(): void { this.#channels = undefined; }
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
    ...(typeof entry['last_post_at'] === 'string' ? { lastPostAt: entry['last_post_at'] } : {}),
    ...(Array.isArray(entry['members']) ? { members: entry['members'].filter((member): member is string => typeof member === 'string') } : {}),
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
  // #637: an owner names a channel by the words he sees, so "ai" finds "AI Team" and "ai-ml", and
  // "singapore conference" finds "Singapore Conference 2026". Hyphens and underscores are word breaks,
  // and a channel matches when its own words carry every reference word, or when the whole reference is
  // one of its words. Exact equality above stays first, so a word match never overrides it.
  const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word !== '');
  const referenceWords = words(wanted);
  const named = referenceWords.length === 0 ? [] : channels.filter(channel => {
    const own = words(`${channel.name ?? ''} ${channel.displayName ?? ''}`);
    return referenceWords.every(word => own.includes(word)) || own.includes(lower);
  });
  if (named.length === 1) { const only = named[0]!; return { channel: only.id ?? only.name ?? wanted }; }
  if (named.length > 1) return { error: `channel-ambiguous: ${wanted} matches ${named.map(label).join(', ')}` };
  // The refusal carries at most three closest names, so a caller can voice them: a channel sharing
  // more of the reference's words ranks first, then a first letter prefix.
  const closeness = (channel: MattermostChannel): number => {
    const own = words(`${channel.name ?? ''} ${channel.displayName ?? ''}`);
    const shared = referenceWords.filter(word => own.includes(word)).length;
    const prefix = label(channel).toLowerCase().startsWith(lower[0] ?? '') ? 1 : 0;
    return shared === 0 ? prefix : shared * 2 + prefix;
  };
  const closest = [...channels].sort((a, b) => closeness(b) - closeness(a)).map(label).filter(Boolean).slice(0, 3);
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

/** C-CHAT (L4-10): a webhook post carries its words in the attachment; they follow the message. */
function postText(raw: Record<string, unknown>): string {
  const message = typeof raw['text'] === 'string' ? raw['text'] : typeof raw['message'] === 'string' ? raw['message'] : '';
  const attachment = typeof raw['attachmentText'] === 'string' ? raw['attachmentText'].trim() : '';
  return attachment === '' ? message : message.trim() === '' ? attachment : `${message}\n${attachment}`;
}

function childPost(raw: Record<string, unknown>): ChildPost | undefined {
  const text = postText(raw);
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

/**
 * The post list of any shape a child read carries: the installed child's `results` envelope for a
 * search or a channel history, its `root` and `replies` for a thread, and the older bare array,
 * `posts` list or map, or `items` (#614).
 */
function postsIn(decoded: unknown): Record<string, unknown>[] | undefined {
  const data = contentJson(decoded);
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return undefined;
  if (isRecord(data['root']) || Array.isArray(data['replies'])) {
    const replies = Array.isArray(data['replies']) ? data['replies'].filter(isRecord) : [];
    return [...(isRecord(data['root']) ? [data['root']] : []), ...replies];
  }
  const list = data['results'] ?? data['posts'] ?? data['items'];
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

function snippetOf(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length <= MATTERMOST_ATTENTION.snippet ? line : `${line.slice(0, MATTERMOST_ATTENTION.snippet - 1)}...`;
}

interface Settings {
  endpointId: string; account: string; resource: string; schemaDigest: string; generation: number;
  maxLimit: number; queryChars: number; names: readonly string[];
}

/** Pre-dispatch gate over the accepted registry. No discovery, no approval, no egress change. */
function preflight(registry: McpRegistry, settings: Settings, tool: MattermostEvidenceTool): string | undefined {
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
  // #604: the composite is Didi's own view over granted children, never a name the endpoint
  // publishes, so the approved policy name authorizes it and each child read checks its own grant.
  if (tool === MATTERMOST_ATTENTION_TOOL || tool === MATTERMOST_CHAT_TOOL) return settings.names.includes(tool) ? undefined : 'tool-not-granted';
  if (!grant.toolNames.includes(tool)) return 'tool-not-granted';
  if (!visible.includes(tool)) return 'required-definition-absent';
  return undefined;
}

/** C-CHAT: a spoken or written name in one comparable form: case, accents, "&" and "and", plural words. */
export function nameKey(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/gu, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)).join(' ');
}

/** "A", "A or B", "A, B or C": a short spoken list. */
function spokenList(items: readonly string[], joiner: 'or' | 'and' = 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]!}`;
}

/** A candidate person as the owner hears it: the full name and the username that tells two apart. */
function personLabel(candidate: Record<string, unknown>): string {
  const username = firstText(candidate, ['username']);
  const display = firstText(candidate, ['display_name']);
  return display !== '' && display !== username ? `${display} (@${username})` : `@${username}`;
}

function channelLabel(channel: MattermostChannel): string {
  return channel.displayName ?? channel.name ?? channel.id ?? '';
}

/**
 * R8-W9: the owner's own name and handle never ride a chat search. The audit saw the owner's name reach the
 * query, where it matches every post he ever wrote, so the handle, the part before any @, and every word of
 * the identity's display name are dropped as whole words; the rest stays as the owner said it (F2).
 */
export function withoutOwner(text: string, owner: string, display = ''): string {
  const handle = owner.trim().replace(/^@/u, '');
  const local = handle.includes('@') ? handle.slice(0, handle.indexOf('@')) : handle;
  const words = new Set<string>();
  const take = (value: string): void => {
    for (const word of value.split(/[^\p{L}\p{N}]+/u)) if (word.length > 1) words.add(word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  };
  take(local);
  take(display);
  if (words.size === 0) return text;
  const strip = new RegExp(String.raw`(?<![\p{L}\p{N}])@?(?:${[...words].join('|')})(?![\p{L}\p{N}])`, 'giu');
  return text.replace(strip, ' ').replace(/\s+/gu, ' ').trim();
}

/** One child post as a chat read carries it, attachment text after the message. */
function chatPost(raw: Record<string, unknown>, owner?: string): ChatReadPost {
  const permalink = firstText(raw, ['url', 'permalink']);
  const rootId = firstText(raw, ['rootId', 'root_id']);
  const author = firstText(raw, ['username', 'author']);
  return {
    id: firstText(raw, ['id', 'post_id']),
    channel: firstText(raw, ['channel', 'channel_name']),
    author,
    time: firstText(raw, ['timestamp', 'created_at', 'time']),
    text: postText(raw),
    // R8-W9: the voice says whose words these are, so "you" and "they" never need a handle to tell apart.
    ...(owner === undefined || owner === '' ? {} : { role: author === owner ? 'you' as const : 'they' as const }),
    ...(permalink !== '' ? { permalink } : {}),
    ...(rootId !== '' ? { rootId } : {}),
  };
}

/**
 * C-CHAT: the child's conversation overview in the read's own shape: one counted section per conversation,
 * at most three groups and three channels named, and the newest anchor posts across all of them.
 */
function overviewOf(data: unknown, owner: string, span: string): Pick<MattermostChatRead, 'read' | 'total' | 'returned' | 'posts' | 'sections'> {
  const record = isRecord(data) ? data : {};
  const person = isRecord(record['person']) ? record['person'] : {};
  const username = firstText(person, ['username']);
  const display = firstText(person, ['display_name']) || username;
  const first = display.split(' ')[0] ?? display;
  const label = display !== username ? `${display} (@${username})` : `@${username}`;
  const count = (value: unknown): number => (Number.isSafeInteger(value) ? value as number : 0);
  const sections: ChatOverviewSection[] = [];
  const anchors: ChatReadPost[] = [];
  const take = (posts: unknown, where: string): void => {
    for (const post of Array.isArray(posts) ? posts.filter(isRecord) : []) {
      const permalink = firstText(post, ['permalink', 'url']);
      const author = firstText(post, ['author', 'username']);
      anchors.push({ id: firstText(post, ['id']), channel: where, author, time: firstText(post, ['created_at', 'timestamp']), text: postText(post), ...(owner !== '' ? { role: author === owner ? 'you' as const : 'they' as const } : {}), ...(permalink !== '' ? { permalink } : {}) });
    }
  };
  const dm = isRecord(record['dm']) ? record['dm'] : undefined;
  if (dm !== undefined && count(dm['post_count']) > 0) {
    const last = firstText(dm, ['last_post_at']);
    sections.push({ kind: 'dm', name: 'direct messages', counts: `${count(dm['post_count'])} posts`, ...(last !== '' ? { last } : {}) });
    take(dm['posts'], 'direct messages');
  }
  const groups = Array.isArray(record['groups']) ? record['groups'].filter(isRecord) : [];
  for (const group of groups.slice(0, MATTERMOST_CHAT.candidates)) {
    const members = Array.isArray(group['members']) ? group['members'].filter((member): member is string => typeof member === 'string' && member !== owner && member !== username) : [];
    const name = members.length === 0 ? 'group' : `group with ${spokenList(members, 'and')}`;
    const last = firstText(group, ['last_post_at']);
    sections.push({ kind: 'group', name, counts: `${count(group['post_count'])} posts`, ...(last !== '' ? { last } : {}) });
    take(group['posts'], name);
  }
  const channels = Array.isArray(record['channels']) ? record['channels'].filter(isRecord) : [];
  for (const channel of channels.slice(0, MATTERMOST_CHAT.candidates)) {
    const name = firstText(channel, ['display_name']);
    const last = firstText(channel, ['last_post_at']);
    sections.push({ kind: 'channel', name: `channel ${name}`, counts: `you ${count(channel['posts_by_owner'])}, ${first} ${count(channel['posts_by_person'])}`, ...(last !== '' ? { last } : {}) });
    take(channel['posts'], name);
  }
  const totals = isRecord(record['totals']) ? record['totals'] : {};
  const moreGroups = count(totals['groups']) - Math.min(groups.length, MATTERMOST_CHAT.candidates);
  const moreChannels = count(totals['channels']) - Math.min(channels.length, MATTERMOST_CHAT.candidates);
  if (moreGroups > 0) sections.push({ kind: 'group', name: `${moreGroups} more group chats`, counts: 'not named' });
  if (moreChannels > 0) sections.push({ kind: 'channel', name: `${moreChannels} more channels`, counts: 'not named' });
  const posts = anchors.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 5);
  const total = count(totals['dm_posts']) + count(totals['group_posts']) + count(totals['channel_posts_by_owner']) + count(totals['channel_posts_by_person']);
  return { read: `everything you and ${label} exchanged${span}`, total, returned: posts.length, posts, sections };
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
    names: config.names ?? MATTERMOST_READ_TOOLS,
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
  /**
   * A caller may narrow the page, never widen it. A search limit over the maximum is clamped, because
   * the child's own cap is the real one (#610); every other read refuses the budget outright.
   */
  function limited(value: unknown, clamp = false): Record<string, unknown> | undefined {
    if (value === undefined) return { limit: Math.min(MATTERMOST_DEFAULTS.limit, settings.maxLimit) };
    if (!Number.isSafeInteger(value) || (value as number) < 1) return undefined;
    if ((value as number) <= settings.maxLimit) return { limit: value as number };
    return clamp ? { limit: settings.maxLimit } : undefined;
  }

  /** The channel index is built once per session, and rebuilt only by one refresh after a miss. */
  const channelIndex = new ChannelIndexCache();
  /**
   * The complete channel list, read at the child's own declared page size and followed through its
   * own declared paging argument until it runs out (#661: one bounded 12 entry page used to decide
   * every later name). Two thousand channels is the ceiling, so a child that never reports
   * exhaustion cannot spin. Any failed page refuses the whole index, never a silently short one.
   */
  async function readChannels(signal?: AbortSignal): Promise<{ channels: MattermostChannel[]; origin: SourceDispatchRef | undefined } | { error: string }> {
    const definition = port.visibleTools(settings.endpointId).find(entry => entry.name === 'mattermost_list_channels');
    const declared = isRecord(definition?.inputSchema) && isRecord(definition.inputSchema['properties']) ? definition.inputSchema['properties'] : {};
    const limit = isRecord(declared['limit']) && typeof declared['limit']['maximum'] === 'number' && declared['limit']['maximum'] >= 1 ? Math.floor(declared['limit']['maximum']) : undefined;
    const paging = (['offset', 'page'] as const).find(key => isRecord(declared[key]));
    const channels: MattermostChannel[] = [];
    let origin: SourceDispatchRef | undefined;
    let previous = '';
    for (let step = 0; channels.length < CHANNEL_INDEX_MAX; step += 1) {
      const args: Record<string, unknown> = {};
      if (limit !== undefined) args['limit'] = limit;
      if (paging === 'offset') args['offset'] = channels.length;
      if (paging === 'page') args['page'] = step;
      const evidence = await dispatch('mattermost_list_channels', args, signal);
      if (evidence.state === 'refused' || evidence.state === 'unknown') return { error: evidence.reason };
      if (evidence.state !== 'completed') return { error: `channel-list-${evidence.state}` };
      const page = parseChannelList(evidence.decodedResult);
      if (!page) return { error: 'channel-list-unreadable' };
      origin = evidence[SOURCE_DISPATCH] ?? origin;
      const marker = page.map(channel => channel.id ?? channel.name ?? '').join('|');
      if (page.length === 0 || marker === previous) break;
      previous = marker;
      channels.push(...page);
      if (paging === undefined) break;
      if (limit !== undefined && page.length < limit) break;
    }
    return { channels, origin };
  }
  async function loadChannels(signal?: AbortSignal): Promise<MattermostChannel[] | { error: string }> {
    const cached = channelIndex.get();
    if (cached) { port.recordReuse?.(channelIndex.origin); return cached; }
    const denied = preflight(registry, settings, 'mattermost_list_channels');
    if (denied) return { error: denied };
    const loaded = await readChannels(signal);
    if ('error' in loaded) return loaded;
    channelIndex.set(loaded.channels);
    channelIndex.origin = loaded.origin;
    return loaded.channels;
  }
  async function resolveAgainstIndex(reference: string, signal?: AbortSignal): Promise<string | { error: string }> {
    const channels = await loadChannels(signal);
    if (!Array.isArray(channels)) return channels;
    const resolved = resolveChannelReference(reference, channels);
    return 'channel' in resolved ? resolved.channel : { error: resolved.error };
  }
  async function resolveChannel(reference: string, signal?: AbortSignal): Promise<string | { error: string }> {
    // A 26 character Mattermost id is already dispatchable; anything else is a name or display name.
    if (/^[a-z0-9]{26}$/.test(reference)) return reference;
    const built = channelIndex.get() !== undefined;
    const resolved = await resolveAgainstIndex(reference, signal);
    // A channel created after the index was built is found by one refresh before the refusal.
    if (!built || typeof resolved === 'string' || !resolved.error.startsWith('channel-not-found')) return resolved;
    channelIndex.clear();
    return resolveAgainstIndex(reference, signal);
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

  /** The child's own spelling of a search window, in the day shape (`from_date`) the archive takes. */
  function declaredSearchArguments(): string[] {
    const definition = port.visibleTools(settings.endpointId).find(entry => entry.name === 'mattermost_search');
    const schema = definition?.inputSchema;
    return isRecord(schema) && isRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
  }

  /**
   * #647: the child defaults a search to hybrid, which embeds the query on CPU over the whole archive
   * (#647 measured 48 to 57 s per read, keyword 3 ms warm). Every search asks for keyword mode, sent only
   * where the child declares `mode`, so a child without it keeps its own default instead of losing the read.
   */
  function keywordMode(): Record<string, string> {
    return declaredSearchArguments().includes('mode') ? { mode: 'keyword' } : {};
  }

  /**
   * The search window: the last 90 days by default, forwarded only for arguments the child declares.
   * #581: the day travels in the child's own `from_date`/`to_date` arguments, and with it `sort=newest`,
   * so a windowed ask never ranks the whole archive by relevance and filters afterwards.
   */
  function searchWindow(after: unknown, before: unknown): Record<string, string> | undefined {
    const lower = after === undefined ? new Date(Date.now() - SEARCH_WINDOW_MS).toISOString() : boundedText(after);
    if (lower === undefined) return undefined;
    const day = (iso: string): string => iso.slice(0, 10);
    const window: Record<string, string> = { after: lower, from_date: day(lower) };
    if (before !== undefined) {
      const upper = boundedText(before);
      if (upper === undefined) return undefined;
      window['before'] = upper;
      window['to_date'] = day(upper);
    }
    const declared = declaredSearchArguments();
    for (const key of Object.keys(window)) if (!declared.includes(key)) delete window[key];
    // #610: a bounded window is read newest first, and only where the child declares the sort.
    if (declared.includes('sort')) window['sort'] = 'newest';
    return window;
  }

  /**
   * #610: a channel the ask names is resolved through the channel list, so the child's own channel
   * filter carries it. A name that matches nothing is one closed refusal, never a wider archive read.
   */
  async function searchChannel(reference: string, signal?: AbortSignal): Promise<{ channel: string } | { error: string }> {
    const channels = await loadChannels(signal);
    if (!Array.isArray(channels)) return { error: channels.error };
    return resolveChannelReference(reference, channels);
  }

  /** What needs a reply: mentions, direct and group messages, and threads whose newest post is not the owner's. */
  async function attention(input: AttentionInput, signal?: AbortSignal): Promise<MattermostResult> {
    // #604: an ungranted composite refuses here, with its own closed reason, before any child read.
    const denied = preflight(registry, settings, MATTERMOST_ATTENTION_TOOL);
    if (denied) return { state: 'refused', reason: denied };
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
    // #610: the independent reads run under one budget. The two attention searches and the channel
    // list answer on their own, so they go out together at the attention page size, never the maximum.
    const attentionLimit = Math.min(MATTERMOST_ATTENTION.limit, settings.maxLimit);
    // C-CHAT (L4-11): both searches read the window newest first in keyword mode, never the whole archive
    // ranked by the slow default mode and filtered afterwards.
    const windowed = { ...keywordMode(), ...(searchWindow(new Date(cutoff).toISOString(), undefined) ?? {}) };
    delete windowed['after'];
    const written = read('mattermost_search', { query: `from:${who.owner.username}`, limit: attentionLimit, ...windowed }, signal);
    const mentions = read('mattermost_search', { query: `@${who.owner.username}`, limit: attentionLimit, ...windowed }, signal);
    // C-CHAT (L4-04): the direct and group conversations by their last post, never the first few in list
    // order. A child whose channel list has no recency cannot say which ones moved, so that leg is skipped
    // and the digest says which capability is missing.
    const recent = listFilters().types && listFilters().sort
      ? read('mattermost_list_channels', { types: ['D', 'G'], sort: 'recent', limit: MATTERMOST_ATTENTION.maxDmChannels }, signal)
      : Promise.resolve(undefined);
    const [writtenRead, mentionsRead, recentRead] = await Promise.all([written, mentions, recent]);
    // The owner's own-author search seeds threads whatever the channel: a thread nobody mentioned the
    // owner in never reaches the handle search.
    if (!writtenRead.ok) return writtenRead.result;
    capture(writtenRead.evidence);
    for (const raw of postsIn(writtenRead.evidence.decodedResult) ?? []) {
      const post = childPost(raw);
      if (post !== undefined && post.at >= cutoff) threadCandidate(post);
    }
    // Mentions: the child's own handle search, with the window and the handle itself checked here.
    if (!mentionsRead.ok) return mentionsRead.result;
    capture(mentionsRead.evidence);
    for (const raw of postsIn(mentionsRead.evidence.decodedResult) ?? []) {
      const post = childPost(raw);
      if (post === undefined || post.at < cutoff) continue;
      if (isOwnerPost(who.owner, post.author)) { threadCandidate(post); continue; }
      if (!mentionsOwner(who.owner, post.text)) continue;
      push('mention', post);
      threadCandidate(post);
    }
    // Direct and group conversations: the owner's own posts await no reply, but they seed the thread rule.
    let missing: string | undefined;
    if (recentRead === undefined) missing = 'direct messages by recency need the newer chat archive';
    else {
      if (!recentRead.ok) return recentRead.result;
      capture(recentRead.evidence);
      const moved = (parseChannelList(recentRead.evidence.decodedResult) ?? [])
        .filter(channel => channel.id !== undefined && (channel.lastPostAt === undefined || Date.parse(channel.lastPostAt) >= cutoff));
      const reads = await Promise.all(moved.map(async channel => read('mattermost_search', { query: '', channel: channel.id!, limit: MATTERMOST_ATTENTION.historyLimit, ...windowed }, signal)));
      for (const history of reads) {
        if (!history.ok) return history.result;
        capture(history.evidence);
        for (const raw of postsIn(history.evidence.decodedResult) ?? []) {
          const post = childPost(raw);
          if (post === undefined || post.at < cutoff) continue;
          if (!isOwnerPost(who.owner, post.author)) push('dm', post);
          threadCandidate(post);
        }
      }
    }
    // Threads the owner started or joined: only a newest post from someone else awaits a reply. The
    // reads run together, and the cap keeps the scan's tail short.
    const roots = [...threads].slice(0, MATTERMOST_ATTENTION.maxThreads);
    const threadReads = await Promise.all(roots.map(async rootId => read('mattermost_get_thread', { post_id: rootId }, signal)));
    for (const thread of threadReads) {
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
    return { ...composed, [SOURCE_CHILD_DISPATCHES]: children, tool: MATTERMOST_ATTENTION_TOOL, decodedResult: { after: new Date(cutoff).toISOString(), items, ...(missing === undefined ? {} : { missing }) } satisfies MattermostAttention };
  }

  /** C-CHAT: the argument names a child tool declares, so a read sends only what that child understands. */
  function schemaProperties(tool: MattermostTool): string[] {
    const definition = port.visibleTools(settings.endpointId).find(entry => entry.name === tool);
    const schema = definition?.inputSchema;
    return isRecord(schema) && isRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
  }
  /** C-CHAT: a child read this grant allows and this child publishes. */
  function granted(tool: MattermostTool): boolean {
    return preflight(registry, settings, tool) === undefined;
  }
  /** C-CHAT: the filters a newer child's channel list takes (PR-A): words, types, member and recency. */
  function listFilters(): { query: boolean; types: boolean; member: boolean; sort: boolean } {
    const declared = granted('mattermost_list_channels') ? schemaProperties('mattermost_list_channels') : [];
    return { query: declared.includes('query'), types: declared.includes('types'), member: declared.includes('member'), sort: declared.includes('sort') };
  }

  /** C-CHAT: one read of a chat read, with the child's own count, never the page length. */
  async function postsRead(owner: string, filters: Record<string, unknown>, limit: number, offset: number, capture: (evidence: MattermostEvidence) => void, signal?: AbortSignal): Promise<{ ok: true; total?: number; posts: ChatReadPost[] } | { ok: false; result: MattermostResult }> {
    const declared = declaredSearchArguments();
    const args: Record<string, unknown> = { query: typeof filters['query'] === 'string' ? filters['query'] : '', ...keywordMode(), limit };
    if (declared.includes('sort')) args['sort'] = 'newest';
    for (const key of ['channel', 'author', 'from_date', 'to_date'] as const) {
      if (filters[key] === undefined) continue;
      // A filter this child cannot apply would widen the read past what the ask named: refuse it.
      if (!declared.includes(key)) return { ok: false, result: { state: 'refused', reason: `search-filter-missing: ${key}` } };
      args[key] = filters[key];
    }
    if (offset > 0) {
      if (!declared.includes('offset')) return { ok: false, result: { state: 'refused', reason: 'search-filter-missing: offset' } };
      args['offset'] = offset;
    }
    const result = await read('mattermost_search', args, signal);
    if (!result.ok) return result;
    capture(result.evidence);
    const data = contentJson(result.evidence.decodedResult);
    const posts = (postsIn(result.evidence.decodedResult) ?? []).map(post => chatPost(post, owner));
    const total = isRecord(data) && Number.isSafeInteger(data['total']) ? data['total'] as number : undefined;
    return { ok: true, ...(total === undefined ? {} : { total }), posts };
  }

  type PersonOutcome = { kind: 'person'; username: string; display: string; dmChannelId?: string; missing?: string }
    | { kind: 'clarify'; text: string; missing?: string } | { kind: 'not-found'; text: string; missing?: string } | { kind: 'failed'; result: MattermostResult };

  /**
   * C-CHAT R8-W9: the direct conversation that already exists with one handle, read from the channel
   * index. Nothing is created, and a child that grants no channel list says so instead of implying none.
   */
  async function dmChannelOf(username: string, signal?: AbortSignal): Promise<{ channel?: string; missing?: string }> {
    const channels = await loadChannels(signal);
    if (!Array.isArray(channels)) return { missing: 'finding your direct messages needs the channel list this child does not grant' };
    const wanted = username.trim().replace(/^@/u, '').toLowerCase();
    const found = channels.find(channel => channel.type === 'D' && (channel.displayName ?? '').toLowerCase() === wanted);
    return found?.id === undefined ? {} : { channel: found.id };
  }

  /**
   * C-CHAT: a spoken name to one account, strictly. The child's resolve_person matches names; an ambiguous
   * name is a question back, never a pick. A child without it is matched on the direct message channel
   * whose name is that username, and the reply says person lookups need the newer archive.
   */
  async function findPerson(name: string, capture: (evidence: MattermostEvidence) => void, signal?: AbortSignal): Promise<PersonOutcome> {
    // W15: the owner's roster decides who a spoken name is before any child search runs, so an alias
    // such as "Sandy" binds to the colleague itself and the child's prefix match never guesses.
    const known = currentBinding(name);
    if (known.kind === 'resolved') {
      if (known.person.mattermost.length === 0) return { kind: 'not-found', text: `${known.person.name} has no team chat handle in the owner's people list.` };
      // R8-W9: the roster says who the person is, never which conversation, so the existing DM channel is
      // looked up here; without it the read answered "no direct messages" while the conversation held posts.
      const dm = await dmChannelOf(known.person.mattermost, signal);
      return { kind: 'person', username: known.person.mattermost, display: known.person.name, ...(dm.channel === undefined ? {} : { dmChannelId: dm.channel }), ...(dm.missing === undefined ? {} : { missing: dm.missing }) };
    }
    if (known.kind === 'ambiguous') return { kind: 'clarify', text: `Which ${name} do you mean: ${ambiguityQuestion(name, known.people)}` };
    if (granted('mattermost_resolve_person')) {
      const resolved = await read('mattermost_resolve_person', { name }, signal);
      if (!resolved.ok) return { kind: 'failed', result: resolved.result };
      capture(resolved.evidence);
      const data = contentJson(resolved.evidence.decodedResult);
      const candidates = isRecord(data) && Array.isArray(data['candidates']) ? data['candidates'].filter(isRecord) : [];
      if (candidates.length === 0) return { kind: 'not-found', text: `I found nobody called ${name} in the team chat.` };
      if (isRecord(data) && data['ambiguous'] === true) {
        return { kind: 'clarify', text: `Which ${name} do you mean: ${spokenList(candidates.slice(0, MATTERMOST_CHAT.candidates).map(personLabel))}?` };
      }
      const top = candidates[0]!;
      const username = firstText(top, ['username']);
      const dm = firstText(top, ['dm_channel_id']);
      return { kind: 'person', username, display: firstText(top, ['display_name']) || username, ...(dm !== '' ? { dmChannelId: dm } : {}) };
    }
    const missing = 'person lookups by name need the newer chat archive';
    const channels = await loadChannels(signal);
    if (!Array.isArray(channels)) return { kind: 'failed', result: { state: 'refused', reason: channels.error } };
    const wanted = name.trim().replace(/^@/u, '').toLowerCase();
    const direct = channels.filter(channel => channel.type === 'D' && (channel.displayName ?? '').toLowerCase() === wanted);
    if (direct.length === 1 && direct[0]!.id !== undefined) return { kind: 'person', username: wanted, display: wanted, dmChannelId: direct[0]!.id, missing };
    return { kind: 'not-found', text: `I found no direct messages with a user named ${name}.`, missing };
  }

  /** C-CHAT: a person, group or channel read in one call. Ambiguity is a question back, never a guess. */
  async function chat(input: ChatReadInput, signal?: AbortSignal): Promise<MattermostResult> {
    const denied = preflight(registry, settings, MATTERMOST_CHAT_TOOL);
    if (denied) return { state: 'refused', reason: denied };
    const intents: readonly ChatReadIntent[] = ['person', 'overview', 'channel', 'group'];
    if (!intents.includes(input.intent)) return { state: 'refused', reason: 'invalid-intent' };
    const day = /^\d{4}-\d{2}-\d{2}$/u;
    if ([input.from_date, input.to_date].some(value => value !== undefined && (typeof value !== 'string' || !day.test(value)))) return { state: 'refused', reason: 'invalid-window' };
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MATTERMOST_CHAT.maxOffset) return { state: 'refused', reason: 'invalid-offset' };
    const limit = input.limit ?? Math.min(MATTERMOST_CHAT.limit, settings.maxLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > settings.maxLimit) return { state: 'refused', reason: 'limit-out-of-budget' };
    const query = input.query === undefined ? '' : boundedText(input.query);
    if (query === undefined) return { state: 'refused', reason: 'invalid-query' };
    const who = await ownerIdentity(signal);
    if (!who.ok) return who.result;
    // R8-W9: the owner's own name and handle are never a search term; "what Ada and Robert Smith decided"
    // asks about Ada, and searching either finds every post the owner ever wrote (F2: the display name too).
    const asked = withoutOwner(query, who.owner.username, who.owner.displayName);
    const children: SourceDispatchRef[] = who.evidence[SOURCE_DISPATCH] ? [who.evidence[SOURCE_DISPATCH]!] : [];
    const capture = (evidence: MattermostEvidence): void => { if (evidence[SOURCE_DISPATCH]) children.push(evidence[SOURCE_DISPATCH]!); };
    const window = { from: input.from_date ?? new Date(Date.now() - MATTERMOST_CHAT.days * DAY_MS).toISOString().slice(0, 10), ...(input.to_date === undefined ? {} : { to: input.to_date }) };
    const span = window.to === undefined ? ` since ${window.from}` : window.to === window.from ? ` on ${window.from}` : ` from ${window.from} to ${window.to}`;
    const about = asked === '' ? '' : `, about ${asked}`;
    const dates = { from_date: window.from, ...(window.to === undefined ? {} : { to_date: window.to }) };
    const base = { intent: input.intent, window, returned: 0, offset, posts: [] as ChatReadPost[] };
    const finish = (out: MattermostChatRead): MattermostResult => {
      if (channelIndex.origin && !children.includes(channelIndex.origin)) children.push(channelIndex.origin);
      const composed = { ...who.evidence };
      delete composed[SOURCE_DISPATCH];
      return { ...composed, [SOURCE_CHILD_DISPATCHES]: children, tool: MATTERMOST_CHAT_TOOL, decodedResult: out };
    };
    const missingOf = (...notes: (string | undefined)[]): { missing?: string } => {
      const said = notes.filter((note): note is string => note !== undefined);
      return said.length === 0 ? {} : { missing: said.join('; ') };
    };
    const page = (read: string, posts: { total?: number; posts: ChatReadPost[] }, missing?: string): MattermostResult => finish({
      ...base, read: `${read}${span}${about}`, ...(posts.total === undefined ? {} : { total: posts.total }), returned: posts.posts.length, posts: posts.posts, ...missingOf(missing),
    });

    if (input.intent === 'person' || input.intent === 'overview') {
      const name = input.person === undefined ? undefined : boundedText(input.person);
      if (name === undefined) return { state: 'refused', reason: 'invalid-person' };
      // W15: the roster answers first; its usernames go to the child instead of the spoken text.
      const known = currentBinding(name);
      if (known.kind === 'ambiguous') return finish({ ...base, read: `a person called ${name}`, clarify: `Which ${name} do you mean: ${ambiguityQuestion(name, known.people)}` });
      const knownUsername = known.kind === 'resolved' && known.person.mattermost.length > 0 ? known.person.mattermost : undefined;
      if (input.intent === 'overview' && granted('mattermost_conversation_overview')) {
        const asked = await read('mattermost_conversation_overview', { person: knownUsername ?? name, ...dates, per_section_limit: MATTERMOST_CHAT.overviewPosts }, signal);
        if (!asked.ok) {
          // The child refuses an ambiguous or unknown person with a JSON body naming the candidates.
          const body = 'decodedResult' in asked.result ? contentJson(asked.result.decodedResult) : undefined;
          const refusal = isRecord(body) ? firstText(body, ['error']) : '';
          if (refusal === 'ambiguous') {
            const candidates = Array.isArray((body as Record<string, unknown>)['candidates']) ? ((body as Record<string, unknown>)['candidates'] as unknown[]).filter(isRecord) : [];
            return finish({ ...base, read: `a person called ${name}`, clarify: `Which ${name} do you mean: ${spokenList(candidates.slice(0, MATTERMOST_CHAT.candidates).map(personLabel))}?` });
          }
          if (refusal === 'not_found') return finish({ ...base, read: `a person called ${name}`, notFound: `I found nobody called ${name} in the team chat.` });
          return asked.result;
        }
        capture(asked.evidence);
        return finish({ ...base, ...overviewOf(contentJson(asked.evidence.decodedResult), who.owner.username, `${span}${about}`) });
      }
      const person = await findPerson(name, capture, signal);
      if (person.kind === 'failed') return person.result;
      const overviewMissing = input.intent === 'overview' ? 'an overview across group chats and channels needs the newer chat archive' : undefined;
      if (person.kind !== 'person') return finish({ ...base, read: `a person called ${name}`, ...(person.kind === 'clarify' ? { clarify: person.text } : { notFound: person.text }), ...missingOf(person.missing, overviewMissing) });
      const label = person.display !== person.username ? `${person.display} (@${person.username})` : `@${person.username}`;
      const theirs = input.intent === 'person' && input.sides !== 'both';
      if (person.dmChannelId === undefined) {
        // R8-W9 (F1): you have no direct conversation with them, so the answer reads their mentions instead
        // and says both facts: whose mentions these are, and why they are what came back.
        const mentioned = [asked, `@${person.username}`].filter(part => part !== '').join(' ');
        const anywhere = await postsRead(who.owner.username, { query: mentioned, ...dates }, limit, offset, capture, signal);
        if (!anywhere.ok) return anywhere.result;
        return page(`posts mentioning ${label} in every channel, because you have no direct messages with them,`, anywhere, missingOf(person.missing, overviewMissing).missing);
      }
      const direct = await postsRead(who.owner.username, { query: asked, channel: person.dmChannelId, ...(theirs ? { author: person.username } : {}), ...dates }, limit, offset, capture, signal);
      if (!direct.ok) return direct.result;
      return page(theirs ? `direct messages from ${label}` : `your direct messages with ${label}`, direct, missingOf(person.missing, overviewMissing).missing);
    }

    if (input.intent === 'channel') {
      const spoken = input.channel === undefined ? undefined : boundedText(input.channel);
      if (spoken === undefined) return { state: 'refused', reason: 'invalid-channel' };
      const key = nameKey(spoken);
      if (key === '') return { state: 'refused', reason: 'invalid-channel' };
      let rows: MattermostChannel[];
      const filters = listFilters();
      if (filters.query && filters.types) {
        // W2B-R6, W2B-R8: the child ranks the words the owner said, folding case and "&" only, never plurals
        // (mattermost-mcp src/mcp/people.ts `channelWords`), so the spoken words go first and an inflection
        // only the fold resolves earns one retry with the folded key. One extra read, and only on a miss.
        const exact = (list: readonly MattermostChannel[]): boolean => list.some(channel => nameKey(channel.displayName ?? '') === key || nameKey(channel.name ?? '') === key);
        const ask = async (query: string): Promise<MattermostChannel[] | { refused: MattermostResult }> => {
          const listed = await read('mattermost_list_channels', { query, types: ['O', 'P'], limit: MATTERMOST_CHAT.channelRows }, signal);
          if (!listed.ok) return { refused: listed.result };
          capture(listed.evidence);
          return parseChannelList(listed.evidence.decodedResult) ?? [];
        };
        const first = await ask(spoken);
        if (!Array.isArray(first)) return first.refused;
        rows = first;
        if (!exact(rows) && key !== spoken.trim().toLowerCase()) {
          const folded = await ask(key);
          if (!Array.isArray(folded)) return folded.refused;
          rows = folded;
        }
      } else {
        const channels = await loadChannels(signal);
        if (!Array.isArray(channels)) return { state: 'refused', reason: channels.error };
        const wanted = key.split(' ');
        rows = channels.filter(channel => channel.type !== 'D' && channel.type !== 'G').filter(channel => {
          const own = nameKey(`${channel.name ?? ''} ${channel.displayName ?? ''}`).split(' ');
          return wanted.every(word => own.some(part => part.startsWith(word)));
        });
      }
      const strong = rows.filter(channel => nameKey(channel.displayName ?? '') === key || nameKey(channel.name ?? '') === key);
      const target = strong.length === 1 ? strong[0]! : undefined;
      if (target === undefined || target.id === undefined) {
        // #637: a channel nobody has is the connector's closed refusal, which the reply already says in words.
        if (rows.length === 0) return { state: 'refused', reason: `channel-not-found: ${spoken}; closest names: none` };
        const named = (strong.length > 1 ? strong : rows).slice(0, MATTERMOST_CHAT.candidates).map(channelLabel);
        return finish({ ...base, read: `a channel called ${spoken}`, clarify: `Which channel do you mean: ${spokenList(named)}?` });
      }
      const posts = await postsRead(who.owner.username, { query: asked, channel: target.id, ...dates }, limit, offset, capture, signal);
      if (!posts.ok) return posts.result;
      return page(`the channel ${channelLabel(target)}`, posts);
    }

    // group
    const spokenPeople = Array.isArray(input.people) ? input.people.map(boundedText) : [];
    if (spokenPeople.length < 2 || spokenPeople.length > MATTERMOST_CHAT.maxPeople || spokenPeople.some(name => name === undefined)) return { state: 'refused', reason: 'invalid-people' };
    const people: string[] = [];
    const notes: (string | undefined)[] = [];
    for (const name of spokenPeople as string[]) {
      const person = await findPerson(name, capture, signal);
      if (person.kind === 'failed') return person.result;
      notes.push(person.missing);
      if (person.kind !== 'person') return finish({ ...base, read: `a group chat with ${spokenList(spokenPeople as string[], 'and')}`, ...(person.kind === 'clarify' ? { clarify: person.text } : { notFound: person.text }), ...missingOf(...notes) });
      people.push(person.username);
    }
    let rows: MattermostChannel[];
    const filters = listFilters();
    if (filters.member && filters.types) {
      const listed = await read('mattermost_list_channels', { types: ['G'], member: people[0]!, ...(filters.sort ? { sort: 'recent' } : {}), limit: MATTERMOST_CHAT.groupRows }, signal);
      if (!listed.ok) return listed.result;
      capture(listed.evidence);
      rows = parseChannelList(listed.evidence.decodedResult) ?? [];
    } else {
      const channels = await loadChannels(signal);
      if (!Array.isArray(channels)) return { state: 'refused', reason: channels.error };
      rows = channels.filter(channel => channel.type === 'G');
      notes.push('group lookups by member need the newer chat archive');
    }
    const membersOf = (channel: MattermostChannel): string[] => groupMembers(channel);
    // W15: a superset of the resolved people is the conversation, most recent first when several fit.
    const withAll = rows.filter(channel => groupHoldsAll(channel, people));
    const newest = (channel: MattermostChannel): string => channel.lastPostAt ?? '';
    const exact = withAll.filter(channel => membersOf(channel).filter(member => member !== who.owner.username).length === people.length);
    const target = exact.length === 1 ? exact[0]! : [...withAll].sort((a, b) => newest(b).localeCompare(newest(a)))[0];
    const groupLabel = (channel: MattermostChannel): string => spokenList(membersOf(channel).filter(member => member !== who.owner.username), 'and');
    if (target === undefined || target.id === undefined) {
      if (withAll.length === 0) return finish({ ...base, read: `a group chat with ${spokenList(spokenPeople as string[], 'and')}`, notFound: `I found no group chat with ${spokenList(spokenPeople as string[], 'and')}.`, ...missingOf(...notes) });
      return finish({ ...base, read: `a group chat with ${spokenList(spokenPeople as string[], 'and')}`, clarify: `Which group chat do you mean: the one with ${spokenList(withAll.slice(0, MATTERMOST_CHAT.candidates).map(groupLabel))}?`, ...missingOf(...notes) });
    }
    const posts = await postsRead(who.owner.username, { query: asked, channel: target.id, ...dates }, limit, offset, capture, signal);
    if (!posts.ok) return posts.result;
    return page(`the group chat with ${groupLabel(target)}`, posts, missingOf(...notes).missing);
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
      // #610: a search limit over the maximum is clamped to it, never sent as the child would refuse it.
      const bounded = limited(input.limit, true);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      const window = searchWindow(input.after, input.before);
      if (window === undefined) return { state: 'refused', reason: 'invalid-window' };
      // #610/F10: the channel an ask names is only sent where the child declares the filter, so a
      // child without one searches its whole archive rather than refusing the read.
      const named = input.channel === undefined ? undefined : boundedText(input.channel);
      const declaredChannel = declaredSearchArguments().includes('channel');
      // #637: the name is resolved whether or not the child declares the filter, so a channel the list
      // does not know is one closed reason the reply speaks, never a wide archive read voiced as an empty.
      const resolved = named === undefined ? undefined : await searchChannel(named, signal);
      // F2 (#637): the resolver's own code travels unchanged, so the closed `channel-not-found` token
      // and the closest-names hint behind it both stay visible in the refusal.
      if (resolved !== undefined && 'error' in resolved) return { state: 'refused', reason: resolved.error };
      const filter = resolved === undefined || !declaredChannel ? {} : { channel: (resolved as { channel: string }).channel };
      // C-CHAT: the next page of the same search, sent only where the child declares paging.
      if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > MATTERMOST_CHAT.maxOffset)) return { state: 'refused', reason: 'invalid-offset' };
      const page = input.offset !== undefined && input.offset > 0 && declaredSearchArguments().includes('offset') ? { offset: input.offset } : {};
      return dispatch('mattermost_search', { query, ...keywordMode(), ...bounded, ...window, ...filter, ...page }, signal);
    },
    async listChannels(input: BoundedInput, signal?: AbortSignal): Promise<MattermostResult> {
      const denied = preflight(registry, settings, 'mattermost_list_channels');
      if (denied) return { state: 'refused', reason: denied };
      const bounded = limited(input.limit);
      if (!bounded) return { state: 'refused', reason: 'limit-out-of-budget' };
      return dispatch('mattermost_list_channels', bounded, signal);
    },
    attention,
    chat,
  };
}
