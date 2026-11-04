import { createResultScope } from '../adapters/mcp/lifecycle.js';
import { isToolFailureCode, type ToolFailureCode } from '../adapters/model/types.js';
import { TASK_CONNECTOR_FAILURE_CODE } from './results.js';
import { composedGrantedNames } from '../connectors/index.js';
import { TASK_CONNECTOR_FAILURE, connectorFailures, TASK_DISCLOSURE } from './results.js';
import type { Identity } from './authority.js';
import { CONNECTOR_DESCRIPTORS, type ConnectorReader } from '../connectors/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { cleanMailBody } from './clean.js';
import { documentResult, failed, readerFailure, failureCategory, rankedResult, type RankedItem, type ToolResult } from './results.js';
import { strictSchema, type Definition, type ToolPorts } from './tools.js';
export interface BoundConnector { connector: string; reader: ConnectorReader; policy: ConnectionPolicy; reportFailure?: (tool: string, code: ToolFailureCode) => void; project?: (evidence: import('../connectors/index.js').ConnectorEvidence) => import('./results.js').TaskDisclosure }
export interface TaskExecutionContext { identity: Identity | undefined; outsideTextSeen: boolean }
export interface ExistingExecutors {
  /** Bound existing executors for local effects, web, memory, people and Trello. No model interpretation. */
  [tool: string]: ((args: Record<string, unknown>, signal: AbortSignal, context: TaskExecutionContext) => Promise<ToolResult>) | undefined;
}
interface Mapping { connector: string; tool: string; args(args: Record<string, unknown>, parameters: Record<string, unknown>): Record<string, unknown> }
const mappings: Record<string, Mapping> = {
  chat_attention: { connector: 'mattermost', tool: 'mattermost_attention', args: a => ({ ...a }) },
  chat_person: { connector: 'mattermost', tool: 'mattermost_chat', args: a => ({ ...a, intent: 'person' }) },
  chat_channel: { connector: 'mattermost', tool: 'mattermost_chat', args: a => ({ ...a, intent: 'channel' }) },
  chat_group: { connector: 'mattermost', tool: 'mattermost_chat', args: a => ({ ...a, intent: 'group' }) },
  chat_overview: { connector: 'mattermost', tool: 'mattermost_chat', args: a => ({ ...a, intent: 'overview' }) },
  chat_person_topics: { connector: 'mattermost', tool: 'mattermost_chat', args: a => ({ ...a, intent: 'topics' }) },
  chat_channel_topics: { connector: 'mattermost', tool: 'mattermost_chat', args: a => ({ ...a, intent: 'topics' }) },
  search_mail: { connector: 'google', tool: 'gmail_search_messages', args: a => ({ q: a.query, ...(a.cursor === undefined ? {} : { pageToken: a.cursor }) }) },
  read_mail: { connector: 'google', tool: 'gmail_read_message', args: a => ({ id: a.id, format: 'full' }) },
  calendar_events: { connector: 'google', tool: 'calendar_list_events', args: a => ({ timeMin: a.start, timeMax: a.end }) },
  search_drive: { connector: 'google', tool: 'drive_search_files', args: a => ({ query: a.query }) },
  read_drive: { connector: 'google', tool: 'drive_get_file', args: a => ({ file_id: a.id }) },
  search_chat: { connector: 'mattermost', tool: 'mattermost_search', args: a => ({ query: a.query }) },
  read_thread: { connector: 'mattermost', tool: 'mattermost_get_thread', args: a => ({ postId: a.ref }) },
  search_knowledge: { connector: 'lux-knowledge', tool: 'search_knowledge', args: (a, parameters) => ({ query: a.query, limit: (parameters.properties as { limit: { maximum: number } }).limit.maximum }) },
  read_knowledge: { connector: 'lux-knowledge', tool: 'get_insight', args: a => ({ ids: [Number(a.id)] }) },
  search_company: { connector: 'mongoose', tool: 'search', args: a => ({ query: a.query }) },
  read_company: { connector: 'mongoose', tool: 'read', args: a => ({ ref: a.ref, depth: a.depth ?? 'all', ...(typeof a.cursor === 'string' ? { cursor: a.cursor } : {}) }) },
};
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
/** MCP's transport wrapper, then the helper's data wrapper, not arbitrary field traversal. */
function payload(value: unknown): unknown {
  const root = record(value);
  if (root.structuredContent !== undefined) return payload(root.structuredContent);
  if (Array.isArray(root.content)) {
    const joined = root.content.map(raw => text(record(raw).text)).join('\n');
    try { return payload(JSON.parse(joined)); } catch { return joined; }
  }
  return root.data !== undefined ? root.data : value;
}
function posts(root: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(root.posts)) return root.posts.map(record);
  if (root.posts && typeof root.posts === 'object') {
    const map = record(root.posts), order = Array.isArray(root.order) ? root.order : Object.keys(map);
    return order.map(id => record(map[String(id)]));
  }
  return [root.root, ...(Array.isArray(root.replies) ? root.replies : [])].filter(Boolean).map(record);
}
/** The knowledge service's Markdown row header is a structural wire format, not query interpretation. */
function rankedText(raw: string): RankedItem[] {
  return raw.split('\n').flatMap(line => {
    const match = /^\*\*#(\d+)\*\*\s+(?:\[[^\]]+\]\s+)?(.+)$/.exec(line);
    return match ? [{ id: match[1]!, title: match[2]!.trim() }] : [];
  });
}
function eventTime(value: unknown): string {
  return typeof value === 'string' ? value : text(record(value).dateTime ?? record(value).date);
}
export function projectTaskPayload(name: string, raw: unknown, args: Record<string, unknown>): ToolResult {
  const data = payload(raw), root = record(data);
  const id = text(args.id ?? args.ref) || name;
  if (typeof data === 'string' && !name.startsWith('read_')) {
    const rows = name === 'search_knowledge' || name === 'search_company' ? rankedText(data) : [];
    return rows.length ? rankedResult(text(args.query), rows) : { status: 'partial', text: data, references: [], next_cursor: null, coverage: 'source_text_without_ranked_ids', repair: 'No structured candidate ids were supplied. Do not invent ids or claim corpus absence.' };
  }
  if (name.startsWith('read_')) {
    const thread = name === 'read_thread' ? posts(root).map(post => `${text(post.id)} ${text(post.user_id ?? post.author)} ${text(post.create_at ?? post.timestamp)}\n${text(post.message ?? post.text)}`).join('\n\n') : '';
    const body = typeof data === 'string' ? data : thread || text(root.body ?? root.text ?? root.content);
    if (!body) return failed('No document body was returned. Search again for a readable identifier; metadata is not a full read.');
    if (name === 'read_company') {
      const cursor = text(root.next_cursor) || null;
      const complete = record(root.coverage).complete;
      return { status: cursor || complete === false ? 'partial' : 'ok', text: body, references: [{ id }], next_cursor: cursor,
        coverage: cursor || complete === false ? 'Remote read is incomplete; continue with the returned native cursor when available.' : 'Remote page returned; only the supplied source content is verified.', repair: cursor ? 'Continue read_company with the same ref and depth and the returned cursor verbatim.' : null };
    }
    return documentResult(name === 'read_mail' ? cleanMailBody(body) : body, id, text(args.cursor) || '0');
  }
  const list = Array.isArray(data) ? data : [root.items, root.results, root.hits, root.messages, root.files, root.events, root.posts].find(Array.isArray) ?? (name === 'search_chat' ? posts(root) : undefined);
  if (!Array.isArray(list)) return failed('The connector returned no recognized result list. Try another configured source; do not infer absence.');
  const items: RankedItem[] = list.flatMap(raw => {
    const item = record(raw), itemId = String((name === 'search_company' ? item.ref ?? item.id : item.id ?? item.ref) ?? item.file_id ?? '');
    if (!itemId) return [];
    return [{ id: itemId, title: text(item.title ?? item.name ?? item.subject ?? item.summary ?? item.author), text: (name === 'calendar_events' ? `${eventTime(item.start)} to ${eventTime(item.end)} ${text(item.location)}` : text(item.snippet ?? item.excerpt ?? item.text ?? item.message)).slice(0, 500), ...(text(item.url ?? item.permalink) ? { url: text(item.url ?? item.permalink) } : {}) }];
  });
  if (name === 'search_knowledge' || name === 'search_company') return rankedResult(text(args.query), items);
  const next = text(root.nextPageToken ?? root.next_cursor);
  const cursor = name === 'search_mail' ? next : '';
  const incomplete = !!next || root.sourceIncomplete === true;
  return { status: incomplete ? 'partial' : items.length ? 'ok' : 'empty', text: items.map(item => `${item.id}: ${item.title}\n${item.text ?? ''}`).join('\n'), references: items.map(({ id, title, url }) => ({ id, title, ...(url ? { url } : {}) })), next_cursor: cursor || null,
    coverage: `${items.length} returned items.${cursor ? ' More results exist; continue the same query with the returned cursor.' : incomplete ? ' Coverage incomplete. Source paging is not exposed by this tool; narrow the query or time window instead.' : ' Connector returned no continuation.'}`, repair: null };
}
export function nativeTaskReadGranted(policy: BoundConnector['policy'], tool: string): boolean {
  return policy.toolNames.includes(tool) || composedGrantedNames(policy.connector, policy.toolNames).includes(tool);
}
/** Capability-specific query tools avoid a free-form filters blob. Every field comes from configuration. */
export function configuredCompanyTools(bindings: readonly BoundConnector[]): Definition[] {
  const capabilities = bindings.filter(binding => binding.connector === 'mongoose').flatMap(binding => CONNECTOR_DESCRIPTORS.mongoose!.declarations(binding.policy));
  if (!capabilities.length) return [];
  return [{ outside: true, name: 'query_company', description: 'Query a configured company resource with its declared filters.', fields: {
    resource: { type: 'string', enum: [...new Set(capabilities.map(item => item.name))] },
    filters: { anyOf: capabilities.map(item => strictSchema(item.parameters)) },
  }, validate: args => capabilities.some(item => item.name === args.resource && item.validate(args.filters)) }];
}
export function isConnectorTaskRead(name: string): boolean { return Object.hasOwn(mappings, name) || name === 'query_company'; }
export function nativeTaskReadTool(name: string, connector: string, args?: Record<string, unknown>): string | undefined {
  if (name === 'query_company' && connector === 'mongoose' && typeof args?.resource === 'string') return args.resource;
  const mapping = mappings[name];
  return mapping?.connector === connector ? mapping.tool : undefined;
}
export function connectorExecutor(bindings: readonly BoundConnector[], existing: ExistingExecutors = {}): ToolPorts['execute'] {
  return async (name, args, signal, outsideTextSeen = false, identity) => {
    if (existing[name]) return existing[name]!(args, signal, { identity, outsideTextSeen });
    const mapping = mappings[name] ?? (name === 'query_company' && typeof args.resource === 'string' ? { connector: 'mongoose', tool: args.resource, args: (a: Record<string, unknown>) => a.filters as Record<string, unknown> } : undefined);
    if (!mapping) return failed('This tool has no configured executor. Use a configured tool or report that capability is unavailable.');
    const binding = bindings.find(binding => binding.connector === mapping.connector && nativeTaskReadGranted(binding.policy, mapping.tool) && CONNECTOR_DESCRIPTORS[binding.connector]?.declarations(binding.policy).some(declaration => declaration.name === mapping.tool));
    if (!binding) return failed('This connector capability is not configured. Use another available source or report the missing capability.');
    const declaration = CONNECTOR_DESCRIPTORS[binding.connector]!.declarations(binding.policy).find(declaration => declaration.name === mapping.tool)!;
    const mapped = mapping.args(args, declaration.parameters);
    if (!declaration.validate(mapped)) return readerFailure(name, 'invalid_argument');
    const scope = createResultScope();
    try {
      return await scope.run(async () => {
        const result = await binding.reader.call(mapping.tool, mapped, signal);
        const failure = (repair: string, code: ToolFailureCode, tool = name): ToolResult => { binding.reportFailure?.(tool, code); const shaped = readerFailure(name, failureCategory('reason' in result ? result.reason : code)); return { ...shaped, [TASK_CONNECTOR_FAILURE_CODE]: code, [TASK_CONNECTOR_FAILURE]: shaped.repair ?? repair }; };
        if (scope.failureCode) return failure('The connector result could not be retained. Reduce the read size or retry after other reads finish.', scope.failureCode, mapping.tool);
        const hostRepair = connectorFailures.get(result);
        if (hostRepair) return failure(hostRepair.repair, hostRepair.code);
        if (result.state !== 'completed') return failure('The connector did not complete this read. Try another source or repair its configuration; do not claim absence.', 'reason' in result && isToolFailureCode(result.reason) ? result.reason : 'reason' in result && result.reason === 'response-oversize' ? 'invalid_result' : 'connector_error');
        if (binding.project) {
          try {
            const snapshot = binding.project(result);
            const shaped = projectTaskPayload(name, binding.connector === 'mattermost' && name === 'search_chat' ? result.decodedResult : snapshot.response.text ?? snapshot.response, args);
            if (shaped.status === 'failed') return failure(shaped.repair ?? 'Restart this source read with cursor null.', 'invalid_result');
            return { ...shaped, dataClasses: snapshot.dataClasses, [TASK_DISCLOSURE]: snapshot };
          } catch { return failure('The connector result could not be safely disclosed. Repair its source policy or use another approved source.', 'invalid_result'); }
        }
        return projectTaskPayload(name, result.decodedResult, args);
      });
    } catch { return readerFailure(name, signal.aborted ? 'cancelled' : 'upstream_error'); } finally { scope.release(); }
  };
}
