import type { JsonObject } from '../adapters/model/types.js';
import { LIVE_RESULT_CHARS, type ShapedResult } from './live-shape.js';

/**
 * Coarse Live intent tools (#241). Gemini 3.8 Live emits one functionCall per model message, so a
 * fine-grained surface costs a whole spoken micro-turn per lookup step. These five intents are the
 * only read tools the Live model sees; each is answered by one host-side fan-out over the internal
 * connector reads, combined into one capped digest. The old fine-grained tools stay internal to
 * the connectors and are never declared to the model.
 */
export const INTENT_TOOL_NAMES = ['search', 'mail', 'calendar', 'chat', 'brief'] as const;
export type IntentToolName = (typeof INTENT_TOOL_NAMES)[number];
const INTENT_SET: ReadonlySet<string> = new Set<string>(INTENT_TOOL_NAMES);
export function isIntentTool(name: string): name is IntentToolName {
  return INTENT_SET.has(name);
}

/** One internal read the host issues on the model's behalf. `key` is the sub-call id used on the wire. */
export interface IntentSubCall { key: string; name: string; args: JsonObject }
/** The shaped outcome of one internal read, already capped by the connector shaping. */
export interface IntentSubResult { key: string; name: string; ok: boolean; text: string; originalCharacters: number; omittedCharacters: number; code?: string }
export interface IntentPlan {
  calls: readonly IntentSubCall[];
  /** Combine the sub-results into the one model-visible digest. */
  combine(results: readonly IntentSubResult[]): ShapedResult;
}

/** A declaration is provider-facing metadata plus the validator the read boundary uses. */
export interface IntentDeclaration {
  name: IntentToolName;
  description: string;
  parameters: JsonObject;
  guidance: string;
  validate(args: unknown): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** The only keys each intent accepts, and the one REQUIRED text key when there is one. */
const ACCEPTED: Readonly<Record<IntentToolName, readonly string[]>> = {
  search: ['query'],
  mail: ['query', 'id'],
  calendar: [],
  chat: ['query'],
  brief: [],
};

export function validateIntent(name: IntentToolName, args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (!Object.keys(args).every(key => ACCEPTED[name].includes(key))) return false;
  if (name === 'search') return nonEmptyString(args['query']);
  if (name === 'mail') {
    const hasId = args['id'] !== undefined;
    const hasQuery = args['query'] !== undefined;
    if (hasId === hasQuery) return false; // exactly one of id or query
    return hasId ? nonEmptyString(args['id']) : nonEmptyString(args['query']);
  }
  if (name === 'chat') return nonEmptyString(args['query']);
  return true;
}

const stringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');
const integerOrEmpty = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined);

/** The model-facing declarations. One line of guidance each; the system instruction names no schema. */
export function intentDeclarations(): IntentDeclaration[] {
  return [
    {
      name: 'search',
      description: 'Search the owner knowledge base. One call answers the question: it returns the most relevant entries with their bodies, so do not fetch anything afterwards. Pass 2 to 5 core terms, not a sentence.',
      guidance: 'Needs a short core-term query, like {"query": "didi release status"}.',
      parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, description: 'Two to five core terms; not a sentence.' } } },
      validate: args => validateIntent('search', args),
    },
    {
      name: 'mail',
      description: 'Answer a mail question in one call: list the few most recent matching messages with excerpts, or read one message in full when you pass its id from an earlier mail result.',
      guidance: 'Needs either a Gmail search query like {"query": "from:rob after:2026/10/07"} or one message id like {"id": "18c..."}.',
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, description: 'Gmail query using Gmail operators.' }, id: { type: 'string', minLength: 1, description: 'One message id from an earlier mail result.' } } },
      validate: args => validateIntent('mail', args),
    },
    {
      name: 'calendar',
      description: 'Answer a schedule question in one call: the owner\'s upcoming events plus the list of calendars, merged server-side. No parameters.',
      guidance: 'Takes no parameters; never pass a calendar name or id.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      validate: args => validateIntent('calendar', args),
    },
    {
      name: 'chat',
      description: 'Answer a team-chat question in one call: search the team chat and return the matching posts with their thread context. Channels are never listed.',
      guidance: 'Needs a query; put any filter in the query, like {"query": "from:asha about release"}.',
      parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, description: 'A search query; filters go inside it.' } } },
      validate: args => validateIntent('chat', args),
    },
    {
      name: 'brief',
      description: 'One catch-up over everything at once: calendar, mail, team chat and open loops, gathered in parallel and returned as a single short digest.',
      guidance: 'Takes no parameters; use it for "catch me up" or "what did I miss".',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      validate: args => validateIntent('brief', args),
    },
  ];
}

export function declarationFor(name: IntentToolName): IntentDeclaration {
  const found = intentDeclarations().find(declaration => declaration.name === name);
  if (!found) throw Error('unknown_intent');
  return found;
}

/** Internal sub-call names, kept here so the Live surface never names a connector. */
export const INTERNAL = {
  knowledgeSearch: 'search_knowledge',
  knowledgeRead: 'get_insight',
  mailList: 'gmail_list',
  mailRead: 'gmail_read',
  calendars: 'gcal_calendars',
  calendarList: 'gcal_list',
  chatSearch: 'mattermost_search',
} as const;

function callsFor(name: IntentToolName, args: Record<string, unknown>): IntentSubCall[] {
  const call = (key: string, tool: string, toolArgs: JsonObject): IntentSubCall => ({ key, name: tool, args: toolArgs });
  if (name === 'search') return [call('0', INTERNAL.knowledgeSearch, { query: stringOrEmpty(args['query']), limit: 5 })];
  if (name === 'mail') {
    if (nonEmptyString(args['id'])) return [call('0', INTERNAL.mailRead, { id: stringOrEmpty(args['id']) })];
    const list: JsonObject = { q: stringOrEmpty(args['query']) };
    const max = integerOrEmpty(args['maxResults']);
    if (max !== undefined) list['maxResults'] = max;
    return [call('0', INTERNAL.mailList, list)];
  }
  if (name === 'chat') return [call('0', INTERNAL.chatSearch, { query: stringOrEmpty(args['query']) })];
  if (name === 'calendar') return [call('0', INTERNAL.calendars, { maxResults: 20 }), call('1', INTERNAL.calendarList, {})];
  // brief fans out in parallel over every source at once.
  return [
    call('0', INTERNAL.calendars, { maxResults: 20 }),
    call('1', INTERNAL.mailList, { q: 'newer_than:2d' }),
    call('2', INTERNAL.chatSearch, { query: 'after:yesterday' }),
    call('3', INTERNAL.knowledgeSearch, { query: 'open loop follow up', limit: 3 }),
  ];
}

function sourceLabel(name: string): string {
  switch (name) {
    case INTERNAL.calendars: return 'calendar';
    case INTERNAL.mailList: return 'mail';
    case INTERNAL.chatSearch: return 'chat';
    case INTERNAL.knowledgeSearch: return 'knowledge';
    default: return 'source';
  }
}

/** One line naming which sources answered and which timed out; never error text. */
function sourceLine(results: readonly IntentSubResult[]): string {
  const answered = [...new Set(results.filter(result => result.ok).map(result => sourceLabel(result.name)))];
  const missing = [...new Set(results.filter(result => !result.ok).map(result => sourceLabel(result.name)))];
  return `${answered.length ? `Answered: ${answered.join(', ')}.` : 'Nothing answered.'}${missing.length ? ` Timed out or unavailable: ${missing.join(', ')}.` : ''}`;
}

/** Cap the digest at the Live result ceiling, cutting at a sentence boundary with an omission note. */
function capDigest(text: string, original: number, nestedOmitted: number): ShapedResult {
  if (text.length <= LIVE_RESULT_CHARS) return { text, partial: nestedOmitted > 0, originalCharacters: original, omittedCharacters: nestedOmitted };
  const window = text.slice(0, Math.max(0, LIVE_RESULT_CHARS - 120));
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
  const cut = stop > 0 ? window.slice(0, stop + 1) : window;
  const omitted = text.length - cut.length;
  return { text: `${cut.trimEnd()}\n\n[omitted ${omitted} characters; the full result is on screen]`, partial: true, originalCharacters: original, omittedCharacters: nestedOmitted + omitted };
}

function digestFrom(results: readonly IntentSubResult[], heading: boolean): ShapedResult {
  const answered = results.filter(result => result.ok && result.text.trim().length > 0);
  const bodies = answered.map(result => heading ? `## ${sourceLabel(result.name)}\n${result.text}` : result.text);
  const original = results.reduce((sum, result) => sum + result.originalCharacters, 0);
  const nestedOmitted = results.reduce((sum, result) => sum + result.omittedCharacters, 0);
  const body = bodies.join('\n\n');
  const sources = results.length > 1 ? `${body ? '\n\n' : ''}${sourceLine(results)}` : '';
  return capDigest(`${body}${sources}`, original, nestedOmitted);
}

export function planIntent(name: IntentToolName, args: unknown): IntentPlan {
  if (!validateIntent(name, args)) throw Error('invalid_intent_arguments');
  const accepted = args as Record<string, unknown>;
  const calls = callsFor(name, accepted);
  return {
    calls,
    combine: results => digestFrom(results, name === 'brief'),
  };
}

/** Metadata carried on the combined response, mirroring the connector response shape. */
export function intentResponse(digest: ShapedResult, intent: IntentToolName): JsonObject {
  return { tool: intent, text: digest.text, partial: digest.partial, originalCharacters: digest.originalCharacters, omittedCharacters: digest.omittedCharacters };
}
