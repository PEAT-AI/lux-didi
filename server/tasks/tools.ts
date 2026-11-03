import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { TRELLO_READ_PARAMETERS, TRELLO_WRITE_PARAMETERS, validateTrelloRead, validateTrelloWrite } from '../tools/trello.js';
import type { Authority, Effect, Identity } from './authority.js';
import { failed, type ToolResult } from './results.js';
export type Schema = Record<string, unknown>;
export interface TaskTool {
  name: string; description: string; parameters: Schema; effect: Effect; outside_text: boolean;
  validate?(args: Record<string, unknown>): boolean;
  run(args: Record<string, unknown>, identity: Identity, signal: AbortSignal): Promise<ToolResult>;
}
export interface ToolPorts {
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  authority: Authority;
}
const string: Schema = { type: 'string', minLength: 1 };
const optionalString: Schema = { type: ['string', 'null'] };
const strings: Schema = { type: 'array', items: string };
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
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
  return valid && (!tool.validate || tool.validate(pruneNulls(value) as Record<string, unknown>)) ? { ok: true, args: pruneNulls(value) as Record<string, unknown> } : { ok: false, repair: `Call ${tool.name} with exactly its declared fields and types. Use null for optional fields.` };
}
export interface Definition { name: string; description: string; fields: Record<string, Schema>; effect?: Effect; outside?: boolean; validate?: (args: Record<string, unknown>) => boolean }
const definitions: Definition[] = [
  { name: 'trello_read', description: 'Read the configured board.', fields: strictSchema(TRELLO_READ_PARAMETERS).properties as Record<string, Schema>, validate: validateTrelloRead },
  { name: 'trello_write', description: 'Write the configured board.', fields: strictSchema(TRELLO_WRITE_PARAMETERS).properties as Record<string, Schema>, effect: 'external', outside: false, validate: validateTrelloWrite },
  ...['mail', 'chat', 'knowledge', 'company', 'drive', 'memory'].map(source => ({ name: `search_${source}`, description: `Search ${source}; put mail and chat time operators inside query.`, fields: { query: string } })),
  ...['mail', 'knowledge', 'drive'].map(source => ({ name: `read_${source}`, description: `Open ${source} whole; use returned cursor to continue.`, fields: { id: string, cursor: optionalString } })),
  ...['thread', 'company', 'memory'].map(source => ({ name: `read_${source}`, description: `Open ${source} whole; use returned cursor to continue.`, fields: { ref: string, cursor: optionalString } })),
  { name: 'calendar_events', description: 'List events in the owner time window.', fields: { start: string, end: string } },
  { name: 'people_lookup', description: 'Look up configured people.', fields: { query: string } },
  { name: 'search_web', description: 'Search the web.', fields: { query: string } },
  { name: 'remember_note', description: 'Remember a local note.', fields: { text: string }, effect: 'local', outside: false },
  { name: 'stage_lux_note', description: 'Stage a local knowledge note.', fields: { title: string, text: string }, effect: 'local', outside: false },
  { name: 'save_to_vault', description: 'Save a local document.', fields: { title: string, text: string }, effect: 'local', outside: false },
  { name: 'draft_email', description: 'Create an email draft, not send.', fields: { to: strings, subject: string, body: string }, effect: 'local', outside: false },
  { name: 'draft_chat', description: 'Create a local chat draft, not send.', fields: { target: string, text: string }, effect: 'local', outside: false },
  { name: 'create_event', description: 'Create a calendar event.', fields: { title: string, start: string, end: string, calendar_id: optionalString }, effect: 'external', outside: false },
  { name: 'delete_event', description: 'Delete a calendar event.', fields: { id: string }, effect: 'destructive', outside: false },
  // Distinct schemas avoid action-dependent optional fields and model guessing.
  { name: 'alarm_create', description: 'Create a local alarm.', fields: { text: string, at: string }, effect: 'local', outside: false },
  { name: 'alarm_list', description: 'List local alarms.', fields: {}, outside: false },
  { name: 'alarm_cancel', description: 'Cancel a local alarm.', fields: { id: string }, effect: 'local', outside: false },
  { name: 'alarm_update', description: 'Update a local alarm.', fields: { id: string, text: optionalString, at: optionalString }, effect: 'local', outside: false },
  { name: 'open', description: 'Open a specific configured target in the native surface.', fields: { kind: { type: 'string', enum: ['mail', 'calendar', 'chat', 'web', 'document'] }, target: string }, effect: 'local', outside: false },
];
export function createRegistry(ports: ToolPorts, configured: readonly Definition[] = []): Map<string, TaskTool> {
  const registry = new Map<string, TaskTool>();
  for (const definition of [...definitions, ...configured]) {
    const effect = definition.effect ?? 'none';
    const tool: TaskTool = {
      name: definition.name, description: definition.description, parameters: object(definition.fields), effect, outside_text: definition.outside ?? true, ...(definition.validate ? { validate: definition.validate } : {}),
      async run(args, identity, signal) {
        const validation = validateArguments(tool, args);
        if (!validation.ok) return failed(validation.repair);
        if (signal.aborted) return failed('Use the current task revision. This call was not admitted.');
        const execute = () => ports.execute(tool.name, validation.args, signal);
        return effect === 'none' ? execute() : ports.authority.authorize({ ...identity, tool: tool.name, effect, args: validation.args, outside_text: tool.outside_text }, execute, signal);
      },
    };
    if (registry.has(tool.name)) throw new Error(`Duplicate task tool ${tool.name}`);
    registry.set(tool.name, tool);
  }
  return registry;
}
