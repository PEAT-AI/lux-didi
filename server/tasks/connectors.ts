import { CONNECTOR_DESCRIPTORS, type ConnectorReader } from '../connectors/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
import { cleanMailBody } from './clean.js';
import { documentResult, failed, rankedResult, type RankedItem, type ToolResult } from './results.js';
import { strictSchema, type Definition, type Schema, type ToolPorts } from './tools.js';
export interface BoundConnector { connector: string; reader: ConnectorReader; policy: ConnectionPolicy }
export interface ExistingExecutors {
  /** Bound existing executors for local effects, web, memory, people and Trello. No model interpretation. */
  [tool: string]: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>) | undefined;
}
interface Mapping { connector: string; tool: string; args(args: Record<string, unknown>): Record<string, unknown> }
const mappings: Record<string, Mapping> = {
  search_mail: { connector: 'google', tool: 'gmail_search_messages', args: a => ({ q: a.query }) },
  read_mail: { connector: 'google', tool: 'gmail_read_message', args: a => ({ id: a.id, format: 'full' }) },
  calendar_events: { connector: 'google', tool: 'calendar_list_events', args: a => ({ timeMin: a.start, timeMax: a.end }) },
  search_drive: { connector: 'google', tool: 'drive_search_files', args: a => ({ query: a.query }) },
  read_drive: { connector: 'google', tool: 'drive_get_file', args: a => ({ file_id: a.id }) },
  search_chat: { connector: 'mattermost', tool: 'mattermost_search', args: a => ({ query: a.query }) },
  read_thread: { connector: 'mattermost', tool: 'mattermost_get_thread', args: a => ({ postId: a.ref }) },
  search_knowledge: { connector: 'lux-knowledge', tool: 'search_knowledge', args: a => ({ query: a.query }) },
  read_knowledge: { connector: 'lux-knowledge', tool: 'get_insight', args: a => ({ ids: [Number(a.id)] }) },
  search_company: { connector: 'mongoose', tool: 'search', args: a => ({ query: a.query }) },
  read_company: { connector: 'mongoose', tool: 'read', args: a => ({ ref: a.ref }) },
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
export function projectTaskPayload(name: string, raw: unknown, args: Record<string, unknown>): ToolResult {
  const data = payload(raw), root = record(data);
  const id = text(args.id ?? args.ref) || name;
  if (name.startsWith('read_')) {
    const body = typeof data === 'string' ? data : text(root.body ?? root.text ?? root.content);
    if (!body) return failed('No document body was returned. Search again for a readable identifier; metadata is not a full read.');
    return documentResult(name === 'read_mail' ? cleanMailBody(body) : body, id, text(args.cursor) || '0');
  }
  const list = Array.isArray(data) ? data : [root.items, root.results, root.hits, root.messages, root.files, root.events, root.posts].find(Array.isArray);
  if (!Array.isArray(list)) return failed('The connector returned no recognized result list. Try another configured source; do not infer absence.');
  const items: RankedItem[] = list.flatMap(raw => {
    const item = record(raw), itemId = String(item.id ?? item.ref ?? item.file_id ?? '');
    if (!itemId) return [];
    return [{ id: itemId, title: text(item.title ?? item.name ?? item.subject), text: text(item.snippet ?? item.excerpt ?? item.text).slice(0, 500), ...(text(item.url ?? item.permalink) ? { url: text(item.url ?? item.permalink) } : {}) }];
  });
  if (name === 'search_knowledge' || name === 'search_company') return rankedResult(text(args.query), items);
  const next = text(root.nextPageToken ?? root.next_cursor);
  return { status: next ? 'partial' : items.length ? 'ok' : 'empty', text: items.map(item => `${item.id}: ${item.title}\n${item.text ?? ''}`).join('\n'), references: items.map(({ id, title, url }) => ({ id, title, ...(url ? { url } : {}) })), next_cursor: next || null,
    coverage: `${items.length} returned items.${next ? ' More results exist; continue with the returned cursor.' : ' Connector returned no continuation.'}`, repair: null };
}
/** Capability-specific query tools avoid a free-form filters blob. Every field comes from configuration. */
export function configuredCompanyTools(bindings: readonly BoundConnector[]): Definition[] {
  return bindings.filter(binding => binding.connector === 'mongoose').flatMap(binding => {
    const descriptor = CONNECTOR_DESCRIPTORS[binding.connector]!;
    return descriptor.declarations(binding.policy).filter(declaration => !['search', 'read'].includes(declaration.name)).map(declaration => {
      const strict = strictSchema(declaration.parameters);
      return { name: `query_company_${declaration.name}`, description: declaration.description, fields: strict.properties as Record<string, Schema> };
    });
  });
}
export function connectorExecutor(bindings: readonly BoundConnector[], existing: ExistingExecutors = {}): ToolPorts['execute'] {
  return async (name, args, signal) => {
    if (existing[name]) return existing[name]!(args, signal);
    const mapping = mappings[name] ?? (name.startsWith('query_company_') ? { connector: 'mongoose', tool: name.slice('query_company_'.length), args: (a: Record<string, unknown>) => a } : undefined);
    if (!mapping) return failed('This tool has no configured executor. Use a configured tool or report that capability is unavailable.');
    const binding = bindings.find(binding => binding.connector === mapping.connector && CONNECTOR_DESCRIPTORS[binding.connector]?.declarations(binding.policy).some(declaration => declaration.name === mapping.tool));
    if (!binding) return failed('This connector capability is not configured. Use another available source or report the missing capability.');
    const declaration = CONNECTOR_DESCRIPTORS[binding.connector]!.declarations(binding.policy).find(declaration => declaration.name === mapping.tool)!;
    const mapped = mapping.args(args);
    if (!declaration.validate(mapped)) return failed(`The connector rejected these fields. Repair the ${name} arguments before retrying.`);
    const result = await binding.reader.call(mapping.tool, mapped, signal);
    if (result.state !== 'completed') return failed('The connector did not complete this read. Try another source or repair its configuration; do not claim absence.');
    return projectTaskPayload(name, result.decodedResult, args);
  };
}
