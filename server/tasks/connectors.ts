import { createResultScope } from '../adapters/mcp/lifecycle.js';
import { isToolFailureCode, type ToolFailureCode } from '../adapters/model/types.js';
import { TASK_CONNECTOR_FAILURE_CODE } from './results.js';
import { mongooseEndpointName } from '../connectors/mongoose.js';
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
  search_company: { connector: 'mongoose', tool: 'search', args: a => ({ query: a.query, mode: a.mode ?? 'answer', ...(typeof a.cursor === 'string' ? { cursor: a.cursor } : {}) }) },
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
/** Preserve native company outcomes instead of forcing documents and jobs into ranked rows. */
function companyPayload(data: unknown): ToolResult {
  const root = record(data), cursor = text(root.next_cursor) || null;
  const incomplete = record(root.coverage).complete === false;
  const outcome = text(root.outcome), running = root.status === 'running';
  const items = Array.isArray(root.items) ? root.items.map(record) : [];
  const references = items.flatMap(item => typeof item.ref === 'string' ? [{ id: item.ref }] : []);
  return {
    status: cursor || incomplete || running ? 'partial' : outcome === 'no_match' ? 'no_match' : 'ok',
    text: typeof data === 'string' ? data : typeof root.text === 'string' && !root.outcome ? root.text : JSON.stringify(data), references, next_cursor: cursor,
    coverage: incomplete || cursor ? 'Native company coverage incomplete; continue with the same ref and depth and the native cursor.' : 'Native company outcome; only returned records are verified.',
    repair: running ? 'The data agent is still running. Continue data_agent_job with op get and the returned job_id; do not recompute the answer.' : null,
  };
}
export function projectTaskPayload(name: string, raw: unknown, args: Record<string, unknown>): ToolResult {
  const data = payload(raw), root = record(data);
  const id = text(args.id ?? args.ref) || name;
  if (name === 'search_company' || name === 'read_company' || name === 'query_company' || Object.hasOwn(companySteps, name)) return companyPayload(data);
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
const companySteps: Readonly<Record<string, string>> = {
  ask_data_agent: 'Ask a business, KPI or metric question. Use only the returned data-agent answer, never lower-level tools or your own calculation. Follow next_step and continue running jobs with data_agent_job.',
  data_agent_job: 'Continue a data-agent job with op get and its job_id. Follow next_step; if still running, say the answer is pending and retain the job_id for a later call. No data is not zero.',
  check_data_capability: 'Check company data coverage before a request that may lie outside coverage. Follow decision, blocker_codes and suggested_tools. Quantitative coverage belongs here, not knowledge search.',
  get_company: 'Look up customer facts, deals and leads on the CRM endpoint by slug or company name first.',
};
function companyEndpoint(binding: BoundConnector): string | undefined {
  return mongooseEndpointName(binding.policy.endpoint.resource) ?? ('url' in binding.policy.endpoint ? mongooseEndpointName(binding.policy.endpoint.url) : undefined);
}
/** Typed company steps preserve each endpoint's published schema and authoritative grants. */
export function configuredCompanyTools(bindings: readonly BoundConnector[]): Definition[] {
  const capabilities = bindings.filter(binding => binding.connector === 'mongoose').flatMap(binding => CONNECTOR_DESCRIPTORS.mongoose!.declarations(binding.policy).filter(item => nativeTaskReadGranted(binding.policy, item.name)));
  const typed = Object.entries(companySteps).flatMap(([name, description]) => {
    const declaration = capabilities.find(item => item.name === name);
    if (!declaration) return [];
    const fields = strictSchema(declaration.parameters).properties as Record<string, Record<string, unknown>>;
    if (name === 'data_agent_job' && fields.op) fields.op = { type: 'string', enum: ['get'] };
    return [{ outside: true, name, description: `${description} ${declaration.description}`, fields, validate: (args: Record<string, unknown>) => (name !== 'data_agent_job' || args.op === 'get') && declaration.validate(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null))) }];
  });
  // Explores and saved content are navigation only, never a route to compute or verify metrics.
  const navigation = capabilities.filter(item => ['search', 'read', 'list_companies', 'search_content', 'read_content', 'list_content', 'list_explores', 'get_metadata', 'list_verified_content'].includes(item.name));
  if (!navigation.length) return typed;
  return [...typed, { outside: true, name: 'query_company', description: 'Browse company records, explores and saved content with declared filters. Never use this to answer or check metrics: use ask_data_agent. Customer records belong to get_company; coverage belongs to check_data_capability.', fields: {
    resource: { type: 'string', enum: [...new Set(navigation.map(item => item.name))] },
    filters: { anyOf: navigation.map(item => strictSchema(item.parameters)) },
  }, validate: args => navigation.some(item => item.name === args.resource && item.validate(args.filters)) }];
}
export function isConnectorTaskRead(name: string): boolean { return Object.hasOwn(mappings, name) || Object.hasOwn(companySteps, name) || name === 'query_company'; }
export function nativeTaskReadTool(name: string, connector: string, args?: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(companySteps, name) && connector === 'mongoose') return name;
  if (name === 'query_company' && connector === 'mongoose' && typeof args?.resource === 'string') return args.resource;
  const mapping = mappings[name];
  return mapping?.connector === connector ? mapping.tool : undefined;
}
export function connectorExecutor(bindings: readonly BoundConnector[], existing: ExistingExecutors = {}, handoffsRemaining = 2): ToolPorts['execute'] {
  if (handoffsRemaining === 2) console.info('company_bindings', JSON.stringify(Object.fromEntries(['knowledge', 'data', 'crm'].map(endpoint => [endpoint, bindings.some(binding => binding.connector === 'mongoose' && companyEndpoint(binding) === endpoint)]))));
  return async (name, args, signal, outsideTextSeen = false, identity) => {
    if (name === 'data_agent_job' && args.op !== 'get') return readerFailure(name, 'invalid_argument');
    if (existing[name]) return existing[name]!(args, signal, { identity, outsideTextSeen });
    const mapping = mappings[name] ?? (Object.hasOwn(companySteps, name) ? { connector: 'mongoose', tool: name, args: (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([, value]) => value !== null)) } : undefined) ?? (name === 'query_company' && typeof args.resource === 'string' ? { connector: 'mongoose', tool: args.resource, args: (a: Record<string, unknown>) => a.filters as Record<string, unknown> } : undefined);
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
        if (hostRepair) {
          const shaped = failure(hostRepair.repair, hostRepair.code);
          const repair = name.startsWith('read_') ? `${hostRepair.repair} ${shaped.repair ?? ''}` : hostRepair.repair;
          return { ...shaped, repair, [TASK_CONNECTOR_FAILURE]: repair };
        }
        if (result.state !== 'completed') return failure('The connector did not complete this read. Try another source or repair its configuration; do not claim absence.', 'reason' in result && isToolFailureCode(result.reason) ? result.reason : 'reason' in result && result.reason === 'response-oversize' ? 'invalid_result' : 'connector_error');
        let snapshot: import('./results.js').TaskDisclosure | undefined;
        if (binding.project) {
          try {
            snapshot = binding.project(result);
            if (binding.connector !== 'mongoose') {
              const shaped = projectTaskPayload(name, binding.connector === 'mattermost' && name === 'search_chat' ? result.decodedResult : snapshot.response.text ?? snapshot.response, args);
              if (shaped.status === 'failed') return failure(shaped.repair ?? 'Restart this source read with cursor null.', 'invalid_result');
              return { ...shaped, dataClasses: snapshot.dataClasses, [TASK_DISCLOSURE]: snapshot };
            }
          } catch { return failure('The connector result could not be safely disclosed. Repair its source policy or use another approved source.', 'invalid_result'); }
        }
        const disclose = (shaped: ToolResult): ToolResult => snapshot ? { ...shaped, dataClasses: snapshot.dataClasses, [TASK_DISCLOSURE]: snapshot } : shaped;
        const admitted = record(snapshot?.response.native);
        const nativeResult = Object.hasOwn(admitted, 'decodedResult') ? admitted.decodedResult : result.decodedResult;
        const native = record(payload(nativeResult)), next = record(native.next_tool);
        if (binding.connector === 'mongoose' && native.outcome === 'handoff' && typeof next.endpoint === 'string' && typeof next.tool === 'string') {
          const target = bindings.filter(candidate => candidate.connector === 'mongoose' && companyEndpoint(candidate) === next.endpoint && nativeTaskReadGranted(candidate.policy, next.tool as string));
          const permitted = Object.hasOwn(companySteps, next.tool) || ['search', 'read', 'get_company'].includes(next.tool);
          if (!target.length || !permitted || !handoffsRemaining) {
            const projected = companyPayload(native);
            return disclose({ ...projected, repair: !target.length ? `Company handoff endpoint ${next.endpoint} is not bound with the requested capability.` : !permitted ? 'Company handoff tool is not an allowed helper step.' : 'Company handoff continuation budget reached; use the returned next_tool with an approved binding.' });
          }
          const nextName = next.tool === 'search' ? 'search_company' : next.tool === 'read' ? 'read_company' : next.tool;
          const routed = await connectorExecutor(target, {}, handoffsRemaining - 1)(nextName, record(next.arguments), signal, outsideTextSeen, identity);
          const targetSnapshot = routed[TASK_DISCLOSURE];
          if (!snapshot || !targetSnapshot) return snapshot ? disclose(routed) : routed;
          const originSnapshot = snapshot;
          const combined = { ...targetSnapshot,
            dataClasses: [...new Set([...originSnapshot.dataClasses, ...targetSnapshot.dataClasses])],
            sourceDispatchRefs: [...new Set([...(originSnapshot.sourceDispatchRefs ?? []), ...(targetSnapshot.sourceDispatchRefs ?? [])])],
            sourcePolicyRefs: [...(originSnapshot.sourcePolicyRefs ?? []), ...(targetSnapshot.sourcePolicyRefs ?? [])],
            recordReuse: () => { originSnapshot.recordReuse?.(); targetSnapshot.recordReuse?.(); },
          };
          return { ...routed, dataClasses: combined.dataClasses, [TASK_DISCLOSURE]: combined };
        }
        const follow = snapshot ? record(admitted.followUp) : record('followUp' in result ? result.followUp : undefined);
        if (binding.connector === 'mongoose' && Array.isArray(follow.pages)) {
          if (follow.pages.length) {
            const pages = follow.pages.map(page => companyPayload(record(page).decodedResult));
            const last = pages.at(-1)!;
            return disclose({ ...last, text: pages.map(page => page.text).join('\n'), references: pages.flatMap(page => page.references), ...(follow.omitted ? { status: 'partial' as const, coverage: 'Native read coverage incomplete; follow-up pages were omitted.' } : {}) });
          }
          if (follow.omitted) return disclose({ ...companyPayload(payload(nativeResult)), status: 'partial', coverage: 'Native read coverage incomplete; follow-up pages were unavailable.' });
        }
        return disclose(projectTaskPayload(name, nativeResult, args));
      });
    } catch { return readerFailure(name, signal.aborted ? 'cancelled' : 'upstream_error'); } finally { scope.release(); }
  };
}
