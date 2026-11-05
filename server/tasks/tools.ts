import { MATTERMOST_ATTENTION_PARAMETERS, MATTERMOST_CHAT_PARAMETERS } from '../connectors/index.js';
import { redactTaskResult } from './results.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { TRELLO_READ_PARAMETERS, TRELLO_WRITE_PARAMETERS, validateTrelloRead, validateTrelloWrite } from '../tools/trello.js';
import type { AuthorityPort, Effect, Identity } from './authority.js';
import { OPEN_SCHEMA, executeOpen, nativeActions } from '../tools/open.js';
import { FIND_FILE_SCHEMA, findFile } from '../tools/find-file.js';
import { failed, type ToolResult } from './results.js';
export type Schema = Record<string, unknown>;
export interface TaskTool {
  name: string; description: string; parameters: Schema; effect: Effect; outside_text: boolean;
  validate?(args: Record<string, unknown>): boolean;
  run(args: Record<string, unknown>, identity: Identity, signal: AbortSignal, outsideTextSeen?: boolean): Promise<ToolResult>;
}
export interface ToolPorts {
  nativeSessionId?: string;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal, outsideTextSeen?: boolean, identity?: Identity): Promise<ToolResult>;
  authority: AuthorityPort;
}
const string: Schema = { type: 'string', minLength: 1 };
const optionalString: Schema = { type: ['string', 'null'] };
const strings: Schema = { type: 'array', items: string };
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const alarmRecurrence: Schema = { type: ['object', 'null'], properties: { kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly'] }, weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } }, hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 }, tz: string }, required: ['kind', 'weekdays', 'hour', 'minute', 'tz'], additionalProperties: false };
/** Optional fields remain required and nullable at the provider boundary. */
export function strictSchema(schema: Schema): Schema {
  const result: Schema = { ...schema };
  if (schema.type === 'object') {
    const required = new Set(schema.required as string[] ?? []);
    const properties = Object.fromEntries(Object.entries(schema.properties as Record<string, Schema> ?? {}).map(([key, value]) => {
      const child = strictSchema(value);
      if (!required.has(key)) {
        child.type = Array.isArray(child.type) ? [...new Set([...child.type, 'null'])] : [child.type, 'null'];
        if (Array.isArray(child.enum)) child.enum = [...child.enum, null];
      }
      return [key, child];
    }));
    return { ...result, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (schema.items) result.items = strictSchema(schema.items as Schema);
  return result;
}
const schemaValidator = new AjvJsonSchemaValidator();
export function pruneNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(item => item !== null).map(pruneNulls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, pruneNulls(item)]));
  return value;
}
export function validateArguments(tool: TaskTool, value: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; repair: string } {
  const valid = schemaValidator.getValidator(tool.parameters as Parameters<AjvJsonSchemaValidator['getValidator']>[0])(value).valid;
  return valid && (!tool.validate || tool.validate(pruneNulls(value) as Record<string, unknown>)) ? { ok: true, args: structuredClone(value) as Record<string, unknown> } : { ok: false, repair: `Call ${tool.name} with exactly its declared fields and types. Use null for optional fields.` };
}
export interface Definition { name: string; description: string; fields: Record<string, Schema>; effect?: Effect; outside: boolean; validate?: (args: Record<string, unknown>) => boolean }
// Reuse native field bounds and nullable normal form, but keep each capability's schema distinct.
const chatFields = strictSchema({ type: 'object', ...MATTERMOST_CHAT_PARAMETERS }).properties as Record<string, Schema>;
const chatPage = Object.fromEntries(['from_date', 'to_date', 'offset', 'limit', 'order'].map(key => [key, chatFields[key]!]));
const topicPage = Object.fromEntries(['from_date', 'to_date', 'offset', 'limit'].map(key => [key, chatFields[key]!]));
const definitions: Definition[] = [
  { outside: true, name: 'chat_attention', description: 'Read what is waiting for the owner: mentions, direct/group messages and open threads awaiting a reply, newest first within the requested days.', fields: strictSchema({ type: 'object', ...MATTERMOST_ATTENTION_PARAMETERS }).properties as Record<string, Schema> },
  { outside: true, name: 'chat_person', description: 'Read a named person or username and their direct conversation. Choose both sides or only their messages, with explicit dates and paging.', fields: { person: string, sides: chatFields.sides!, ...chatPage } },
  { outside: true, name: 'chat_channel', description: 'Read a named channel chronologically, with explicit dates and paging. This is not a relevance search.', fields: { channel: string, ...chatPage } },
  { outside: true, name: 'chat_group', description: 'Read the group conversation containing the named people, with explicit dates and paging.', fields: { people: { ...chatFields.people!, type: 'array' }, ...chatPage } },
  { outside: true, name: 'chat_overview', description: 'Read a person overview across direct, group and shared-channel conversations, without substituting a relevance search.', fields: { person: string, from_date: chatFields.from_date!, to_date: chatFields.to_date! } },
  { outside: true, name: 'chat_person_topics', description: 'List a person direct conversation threads with counts and latest activity. Use the returned root ids with read_thread.', fields: { person: string, ...topicPage } },
  { outside: true, name: 'chat_channel_topics', description: 'List a channel threads with counts and latest activity. Use the returned root ids with read_thread.', fields: { channel: string, ...topicPage } },
  { outside: true, name: 'trello_read', description: 'Read the configured board.', fields: strictSchema(TRELLO_READ_PARAMETERS).properties as Record<string, Schema>, validate: validateTrelloRead },
  { name: 'trello_write', description: 'Write the configured board.', fields: strictSchema(TRELLO_WRITE_PARAMETERS).properties as Record<string, Schema>, effect: 'external', outside: false, validate: validateTrelloWrite },
  { outside: true, name: 'search_mail', description: 'Search mail with time operators inside query. Use null cursor for the first page, then the returned next_cursor to continue the same query.', fields: { query: string, cursor: optionalString } },
  { outside: true, name: 'vault_meetings', description: 'Find vault meetings by participant and date rather than topic search. Use who and when, then read the returned meeting id.', fields: { cursor: optionalString, participant: optionalString, date_from: optionalString, date_to: optionalString, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
  { outside: true, name: 'read_vault_meeting', description: 'Read a known vault meeting card, sources and entries. Follow the returned paging information.', fields: { cursor: optionalString, meeting_id: string, limit: { type: 'integer', minimum: 1, maximum: 20 }, offset: { type: 'integer', minimum: 0 } } },
  { outside: true, name: 'list_vault', description: 'Use for all vault entries or how many, not ranked search. Returns a true total and bounded page. Continue with offset for complete coverage.', fields: { cursor: optionalString, project: optionalString, participant: optionalString, meeting_date_from: optionalString, meeting_date_to: optionalString, count_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, offset: { type: 'integer', minimum: 0 } } },
  { outside: true, name: 'search_knowledge', description: 'Search the private vault with a few core terms using his names. Expand common nouns from owner context; inspect snippets and open plausible current hits. Try different terms before claiming absence.', fields: { query: string } },
  ...['chat', 'company', 'drive', 'memory'].map(source => ({ outside: source !== 'memory', name: `search_${source}`, description: `Search ${source}; put mail and chat time operators inside query.`, fields: { query: string } })),
  { outside: true, name: 'read_knowledge', description: 'Read several vault insight ids together, with linked rationale. Prefer current replacements over superseded facts and say when a fact was replaced.', fields: { ids: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'integer', minimum: 1 } }, include_links: { type: 'boolean' }, cursor: optionalString } },
  ...['mail', 'drive'].map(source => ({ outside: source !== 'memory', name: `read_${source}`, description: `Read ${source} using the exact id returned by search_${source}. ${source === 'knowledge' ? 'Knowledge is authoritative for retained insights, not current company records.' : source === 'mail' ? 'Mail is authoritative for the retrieved message.' : 'Drive is authoritative for the retrieved document.'} Use returned cursor to continue.`, fields: { id: string, cursor: optionalString } })),
  ...['thread', 'company', 'memory'].map(source => ({ outside: source !== 'memory', name: `read_${source}`, description: `Read ${source} using the exact ${source === 'company' ? 'ref from search_company' : source === 'memory' ? 'entry id from search_memory, passed as ref' : 'thread ref from search_chat'}. ${source === 'company' ? 'Company is authoritative for current connected company records; pass ref verbatim, never substitute a numeric id.' : source === 'memory' ? 'Memory is authoritative for retained local entries.' : 'Chat is authoritative for the retrieved thread.'} Use returned cursor to continue.`, fields: { ref: string, cursor: optionalString, ...(source === 'company' ? { depth: { type: ['string', 'null'], enum: ['summary', 'full', 'all', null] } } : {}) } })),
  { outside: false, name: 'calendar_events', description: 'List events in the owner time window.', fields: { start: string, end: string } },
  { outside: false, name: 'people_lookup', description: 'Look up configured people.', fields: { query: string } },
  { outside: true, name: 'search_web', description: 'Search the web.', fields: { query: string } },
  { name: 'remember_note', description: 'Remember a local note.', fields: { text: string }, effect: 'local', outside: false },
  { name: 'save_to_vault', description: 'Save a note to the configured Lux vault and return its real connector receipt.', fields: { title: string, text: string }, effect: 'local', outside: false },
  { name: 'draft_email', description: 'Create an email draft, not send.', fields: { to: strings, subject: string, body: string }, effect: 'local', outside: false },
  { name: 'draft_chat', description: 'Save a draft in the configured Mattermost reply box, never post it. Resolve the target to @username, #channel or thread:<channel-id>:<root-post-id>.', fields: { target: string, text: string }, effect: 'local', outside: false },
  { name: 'create_event', description: 'Create a calendar event.', fields: { title: string, start: string, end: string, calendar_id: optionalString }, effect: 'external', outside: false },
  { name: 'delete_event', description: 'Delete a calendar event.', fields: { id: string }, effect: 'destructive', outside: false },
  // Distinct schemas avoid action-dependent optional fields and model guessing.
  { name: 'alarm_create', description: 'Create a local alarm.', fields: { text: string, at: string, recurrence: alarmRecurrence }, effect: 'local', outside: false },
  { name: 'alarm_list', description: 'List local alarms.', fields: {}, outside: false },
  { name: 'alarm_cancel', description: 'Cancel a local alarm.', fields: { id: string, scope: { type: ['string', 'null'], enum: ['occurrence', 'series', null] } }, effect: 'local', outside: false },
  { name: 'alarm_update', description: 'Update a local alarm.', fields: { id: string, text: optionalString, at: optionalString, recurrence: alarmRecurrence }, effect: 'local', outside: false },
  { name: OPEN_SCHEMA.name, description: OPEN_SCHEMA.description, fields: OPEN_SCHEMA.parameters.properties, effect: 'local', outside: false },
  { name: FIND_FILE_SCHEMA.name, description: FIND_FILE_SCHEMA.description, fields: FIND_FILE_SCHEMA.parameters.properties, outside: false },
];
function integerSchema(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  return !value || typeof value !== 'object' || Object.values(value).every(integerSchema);
}
export const TASK_ACCOUNT = 'gateway:tasks';
export const TASK_RESOURCE = 'owner-task-tools';
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([...definitions.map(tool => tool.name), 'query_company']);
export function createRegistry(ports: ToolPorts, configured: readonly Definition[] = []): Map<string, TaskTool> {
  const registry = new Map<string, TaskTool>();
  for (const definition of [...definitions, ...configured]) {
    const effect = definition.effect ?? 'none';
    const tool: TaskTool = {
      name: definition.name, description: definition.description, parameters: object(definition.fields), effect, outside_text: definition.outside, ...(definition.validate ? { validate: definition.validate } : {}),
      async run(args, identity, signal, outsideTextSeen = false) {
        const validation = validateArguments(tool, args);
        if (!validation.ok) {
          if (tool.name === 'alarm_create' && !signal.aborted) {
            const active = await ports.execute('alarm_list', {}, signal, outsideTextSeen, identity);
            return failed(`${validation.repair} Already armed alarms: ${active.text}`);
          }
          return failed(validation.repair);
        }
        if (signal.aborted) return failed('Use the current task revision. This call was not admitted.');
        const execute = async (): Promise<ToolResult> => {
          if (tool.name === OPEN_SCHEMA.name) {
            const result = await executeOpen(nativeActions, ports.nativeSessionId ?? '', validation.args);
            return result.code === 'opened' ? { status: 'ok', text: 'Opened.', references: [], next_cursor: null, coverage: 'Native open acknowledged.', repair: null } : failed(`Opening failed: ${result.code}.`);
          }
          if (tool.name === FIND_FILE_SCHEMA.name) {
            const result = await findFile(validation.args);
            if (result.code === 'unavailable' || result.code === 'invalid_arguments') return failed(`File search: ${result.code}.`);
            return { status: result.code === 'empty' ? 'empty' : 'ok', text: JSON.stringify(result.files),
              references: result.files.map(file => ({ id: file.path, title: file.name })), next_cursor: null,
              coverage: 'At most 20 local file metadata matches, no file bodies.', repair: null,
              exposures: result.files.some(file => file.outsideText) ? ['drive'] : [] };
          }
          return ports.execute(tool.name, pruneNulls(validation.args) as Record<string, unknown>, signal, outsideTextSeen, identity);
        };
        return redactTaskResult(await (effect === 'none' ? execute() : ports.authority.authorize({ ...identity, tool: tool.name, effect, args: validation.args, outside_text: outsideTextSeen }, async () => redactTaskResult(await execute(), tool.name), signal)), tool.name);
      },
    };
    if (!integerSchema(tool.parameters)) throw new Error(`Non-integer numeric schema literal in ${tool.name}`);
    if (registry.has(tool.name)) throw new Error(`Duplicate task tool ${tool.name}`);
    registry.set(tool.name, tool);
  }
  return registry;
}
