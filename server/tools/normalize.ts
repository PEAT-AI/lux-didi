import { hostLogEvent } from './host-events.js';

/**
 * C-ARGS/D5: one declaration-driven argument normalizer, applied to every live tool before its own
 * validation. It drops only what the declaration says the chosen intent does not read (another
 * intent's keys), keys the tool never declares, and absent-value fillers (an empty string, null or
 * an empty array where the declaration makes the key optional). It never drops or rewrites a
 * non-empty value of a key the intent reads: that stays a violation the tool's own refusal names.
 *
 * The declaration is the tool's own `parameters` object for the key universe, plus the intent matrix
 * below for the tools whose predicates read a different key set per intent. A tool without an entry
 * reads every key it declares, so nothing but undeclared keys and fillers is ever dropped there.
 */
export interface ToolDeclaration {
  readonly name: string;
  readonly effect?: 'read' | 'write';
  readonly parameters?: unknown;
}

export interface IntentMatrix {
  /** The key whose value selects the read set, when the tool has one. */
  readonly intentKey: string;
  /** Keys every intent of this tool reads. */
  readonly common: readonly string[];
  readonly intents: Readonly<Record<string, readonly string[]>>;
}

/**
 * C-ARGS: `mattermost_chat` is the tool whose predicates refuse a key that belongs to another intent
 * (`channel:not_for_person`), so its read set is declared per intent here and matches those predicates
 * and the read executor exactly. Every other live tool reads all of its declared keys.
 */
export const INTENT_MATRICES: Readonly<Record<string, IntentMatrix>> = Object.freeze({
  mattermost_chat: Object.freeze({
    intentKey: 'intent',
    common: Object.freeze(['order', 'from_date', 'to_date', 'sides', 'offset', 'limit']),
    intents: Object.freeze({
      person: Object.freeze(['person', 'query']),
      overview: Object.freeze(['query']),
      channel: Object.freeze(['channel', 'query']),
      group: Object.freeze(['people', 'query']),
      topics: Object.freeze(['person', 'channel', 'query']),
      thread: Object.freeze(['post_id', 'person', 'channel', 'query']),
    }),
  }),
});

/** Why one key was dropped. A closed set: the host log accepts these words and nothing else. */
export const DROP_REASONS = ['undeclared', 'not_read', 'absent'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface NormalizedArguments {
  readonly args: Record<string, unknown>;
  /** `key:reason` tokens, never a value. */
  readonly dropped: string[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface Shape { readonly properties: ReadonlySet<string>; readonly required: ReadonlySet<string> }

function declaredShape(tool: ToolDeclaration): Shape {
  const parameters = isRecord(tool.parameters) ? tool.parameters : {};
  const properties = isRecord(parameters['properties']) ? Object.keys(parameters['properties']) : [];
  const required = Array.isArray(parameters['required'])
    ? parameters['required'].filter((key): key is string => typeof key === 'string') : [];
  return { properties: new Set(properties), required: new Set(required) };
}

/**
 * The absent value the voice model sends for a property it did not use, matching C-FILLER in
 * research.ts: undefined, null, the empty string, an empty array and an empty object. False, 0 and
 * any text at all are real values, so a whitespace-only string is kept and still refused by the tool's
 * own rule. Only a key the declaration makes optional may hold a filler: a required key needs a value.
 */
function isFiller(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (isRecord(value) && Object.keys(value).length === 0);
}

/** The keys this call reads: the matrix row for its intent, or every declared key when it has none. */
function readSet(tool: ToolDeclaration, args: Record<string, unknown>): ReadonlySet<string> | undefined {
  const matrix = INTENT_MATRICES[tool.name];
  const intentKey = matrix?.intentKey;
  if (matrix === undefined || intentKey === undefined) return undefined;
  const intent = args[intentKey];
  const row = typeof intent === 'string' ? matrix.intents[intent] : undefined;
  if (row === undefined) return undefined;
  return new Set([intentKey, ...matrix.common, ...row]);
}

/**
 * The normalized arguments and the dropped keys, for one call. Anything that is not a plain object
 * comes back untouched so the caller's own not-an-object refusal still fires.
 */
export function normalizeArguments(tool: ToolDeclaration, raw: unknown): NormalizedArguments {
  if (!isRecord(raw)) return { args: {}, dropped: [] };
  const shape = declaredShape(tool);
  const reads = readSet(tool, raw);
  const args: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const reason: DropReason | undefined = !KEY.test(key) || (shape.properties.size > 0 && !shape.properties.has(key)) ? 'undeclared'
      : reads !== undefined && !reads.has(key) ? 'not_read'
        : value === undefined || (tool.effect !== 'write' && !shape.required.has(key) && isFiller(value)) ? 'absent'
          : undefined;
    if (reason === undefined) { args[key] = value; continue; }
    dropped.push(`${KEY.test(key) ? key : 'invalid_key'}:${reason}`);
  }
  return { args, dropped };
}

/** The dropped-key telemetry: a separate closed event, one `path:reason` token per dropped key. */
export function logArgumentsNormalized(tool: string, dropped: readonly string[]): void {
  if (dropped.length === 0) return;
  hostLogEvent({ event: 'tool_arguments_normalized', tool, dropped: dropped.slice(0, 24) });
}
