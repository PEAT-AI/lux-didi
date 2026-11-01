import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { controlled, Interrupted } from '../adapters/model/control.js';
import { isToolFailureCode } from '../adapters/model/types.js';
import { hostLogEvent } from './host-events.js';
import { logArgumentsNormalized, normalizeArguments } from './normalize.js';
import type { Authority, DataClass, FunctionDeclaration, HostContext, JsonObject, ModelControl, Part, ToolCallIntent, ToolCallJournal, ToolCallRefusal, ToolDefinition, ToolOutcome, ToolRecord, ToolResultBinding, ToolResultGate, ToolResultRef, LoopResult } from '../adapters/model/types.js';

/** Internal reads remain dispatchable by research, not directly callable by the voice model.
 * The provider-wire catalog guard requires every omitted registered name to be explained here. */
export const LIVE_NOT_MODEL_FACING: Readonly<Record<string, string>> = Object.freeze({
  conversation_history: 'Research owns local conversation recall.',
  read_received_body: 'Research owns paging of authorized received bodies.',
  people_lookup: 'Research resolves people against the host roster.',
  search_knowledge: 'Research owns knowledge search.',
  get_insight: 'Research owns knowledge detail.',
  gmail_get_profile: 'Research owns mailbox identity reads.',
  gmail_search_messages: 'Research owns mail search.',
  gmail_read_message: 'Research owns mail detail.',
  calendar_list_calendars: 'Research owns calendar discovery.',
  calendar_list_events: 'Research owns calendar reads.',
  drive_search_files: 'Research owns Drive search.',
  drive_get_file: 'Research owns Drive detail.',
  mattermost_whoami: 'Research owns team-chat identity reads.',
  mattermost_get_channel_history: 'Research owns channel reads.',
  mattermost_get_thread: 'Research owns thread reads.',
  mattermost_search: 'Research owns team-chat search.',
  mattermost_list_channels: 'Research owns channel discovery.',
  mattermost_resolve_person: 'Research owns team-chat person resolution.',
  mattermost_conversation_overview: 'Research owns person conversation reads.',
  ask_mongoose: 'Research owns company knowledge questions.',
  search_mongoose: 'Research owns company knowledge search.',
  get_knowledge_item: 'Research owns company knowledge detail.',
  get_knowledge_item_schema: 'Research owns company knowledge schema reads.',
  read_knowledge_body: 'Research owns company knowledge body reads.',
});

/** Provider schemas are presentation only. Validation and approval retain the originals. */
/**
 * The Gemini provider dialect: uppercase scalar type names, ARRAY/BOOLEAN/enum collapsed to STRING, and the
 * original schema appended to the description. Shared by the text model payload and the Gemini Live adapter,
 * which each decide to apply it; other providers get the original JSON schema through the port.
 */
export function geminiDialect(value: unknown): JsonObject {
  const schema = value as JsonObject;
  const type = String(schema.type ?? 'OBJECT').toUpperCase();
  if (type === 'ARRAY' || type === 'BOOLEAN' || schema.enum !== undefined) return { type: 'STRING', description: [schema.description, `Original schema: ${JSON.stringify(schema)}`].filter(Boolean).join(' ') };
  // Build the restricted provider dialect, never copy arbitrary original keys.
  const result: JsonObject = { type: ['STRING', 'NUMBER', 'INTEGER', 'OBJECT'].includes(type) ? type : 'STRING' };
  for (const key of ['description', 'required', 'nullable'] as const) if (schema[key] !== undefined) result[key] = structuredClone(schema[key]);
  const presentation = new Set(['type', 'properties', 'description', 'required', 'nullable', '$schema', '$id', 'title', 'default', 'examples']);
  if (type !== result.type || Object.keys(schema).some(key => !presentation.has(key))) {
    result.description = [schema.description, `Original schema: ${JSON.stringify(schema)}`].filter(Boolean).join(' ');
  }
  if (schema.properties && typeof schema.properties === 'object') result.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, geminiDialect(v)]));
  return result;
}
export function declarationsFor(registry: readonly ToolDefinition[]): { declarations: FunctionDeclaration[]; originalByName: Map<string, ToolDefinition['parameters']> } {
  return {
    originalByName: new Map(registry.map(t => [t.name, structuredClone(t.parameters)])),
    declarations: registry.map(t => ({ name: t.name, description: t.description, parameters: geminiDialect(t.parameters) })),
  };
}
export interface ToolCallsContext {
  registry: readonly ToolDefinition[]; host: HostContext; authority: Authority; control: ModelControl;
  step: number; contentIndex: number; seenIds: Set<string>; baseClasses: readonly DataClass[];
  /** The counter scope of one owner turn; the live session replaces it when a turn opens. Omitted, this run's call ids scope it. */
  invalidAttempts?: Map<string, number>;
  /** Per-call abort signals, keyed by call id, so a provider cancellation aborts exactly its call. */
  signals?: ReadonlyMap<string, AbortSignal>;
  /** Text's gate runs on the complete continuation in the next loop iteration. */
  authorize?: boolean;
}
const validRef = (ref: ToolResultRef | undefined): ref is ToolResultRef =>
  !!ref && typeof ref.id === 'string' && !!ref.id && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256);

const invalidAttempts = new WeakMap<object, Map<string, number>>();
/** C-ARGS: the rejected calls of one task scope, keyed by tool and normalized arguments. */
const rejections = new WeakMap<object, Map<string, string>>();
/** The closed set an error class may name in host.log: a class, never a message or a stack. */
const HANDLER_ERROR_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'SqliteError'];
const handlerErrorClass = (error: unknown): string => {
  const name = error instanceof Error ? error.constructor.name : '';
  return HANDLER_ERROR_CLASSES.includes(name) ? name : 'Unknown';
};
function recordInvalidAttempt(scope: object, key: string): number {
  let counts = invalidAttempts.get(scope);
  if (counts === undefined) { counts = new Map(); invalidAttempts.set(scope, counts); }
  const count = (counts.get(key) ?? 0) + 1; counts.set(key, count); return count;
}
function logArgumentsRejected(name: string, violations: readonly string[], reason: string): void {
  // C-ARGS: one `path:keyword` token per violation, always together, never a value.
  hostLogEvent({ event: 'tool_arguments_rejected', tool: name, violations: violations.slice(0, 24), reason });
}
/** The rejection cache of one task scope, so a repeat arrives without a second validation. */
function rejectedCalls(scope: object): Map<string, string> {
  let cache = rejections.get(scope);
  if (cache === undefined) { cache = new Map(); rejections.set(scope, cache); }
  return cache;
}
/**
 * Every violation the tool's own predicate names, not just the first. Each token is `path:keyword`, so
 * removing that one key lets the next rule speak; the loop is bounded and a token that names no key the
 * call carries (a structural rule) ends it. A token is a rule name, never a value.
 */
export function argumentViolationsOf(tool: { rejection?: (args: unknown) => string | undefined }, args: Record<string, unknown>): string[] {
  if (tool.rejection === undefined) return [];
  const tokens: string[] = [];
  const rest: Record<string, unknown> = { ...args };
  for (let step = 0; step < 8; step++) {
    const token = tool.rejection(rest);
    if (token === undefined || tokens.includes(token)) break;
    tokens.push(token);
    const field = token.slice(0, token.indexOf(':'));
    if (field.length === 0 || !Object.hasOwn(rest, field)) break;
    delete rest[field];
  }
  return tokens;
}
/** The one line the model may speak when a call is refused for its arguments: owner-facing, no host prose. */
export const INVALID_ARGUMENTS_SPEECH = 'That lookup failed on my side.';
/** C-ARGS: what a rejected call is, so a model can never narrate it as a search that came back empty. */
export const NOTHING_RAN_RULE = 'Nothing ran, so there is no result and no finding: a rejected lookup found nothing because nothing ran, never because the result was empty or because it came back empty.';
/** C-ARGS: an identical rejected call is answered from this cache, and its branch ends until he adds facts. */
export const BRANCH_CLOSED = 'This branch is closed until the owner adds facts: the same call with the same arguments is not sent again.';
/** Every violation the tool's own refusal names, as the `{field, reason}` pairs the host and the model both read. */
export function argumentViolations(reason: string): { field: string; reason: string }[] {
  const named = /Rejected arguments?: ([^.]+)\./u.exec(reason)?.[1];
  if (named === undefined) return [];
  return named.split(', ').filter(token => token.length > 0).map(token => {
    const cut = token.indexOf(':');
    return cut <= 0 ? { field: 'arguments', reason: token } : { field: token.slice(0, cut), reason: token.slice(cut + 1) };
  });
}
/** The closed tool response for an invalid-arguments refusal: the fix is for the model alone, never read aloud. */
export function invalidArgumentsResponse(reason: string): JsonObject | undefined {
  if (!reason.startsWith('Invalid arguments for ')) return undefined;
  return {
    status: 'rejected',
    executed: false,
    resultEvidence: 'none',
    error: 'invalid_arguments',
    violations: argumentViolations(reason),
    fixNotForSpeech: reason,
    say: INVALID_ARGUMENTS_SPEECH,
    resultRule: NOTHING_RAN_RULE,
    speakingRule: 'Never read fixNotForSpeech aloud; it is instruction for you. Say only the say line, once.',
  };
}
/** For every declared tool: the tool name and its expected argument shape, never the bad values. */
function invalidArgumentsGuidance(name: string, guidance: string | undefined, parameters: Record<string, unknown>, violations: readonly string[]): string {
  const token = violations.length === 0 ? '' : violations.length === 1
    ? ` Rejected argument: ${violations[0]}.` : ` Rejected arguments: ${violations.join(', ')}.`;
  if (guidance !== undefined && guidance.length > 0) return `Invalid arguments for ${name}.${token} ${guidance}`;
  const properties = (parameters['properties'] ?? {}) as Record<string, { type?: unknown; items?: unknown }>;
  const shape = Object.entries(properties).map(([key, schema]) => {
    const items = schema?.items as { type?: unknown } | undefined;
    const type = schema?.type === 'array' ? `array of ${String(items?.type ?? 'value')}` : String(schema?.type ?? 'value');
    return `${key} (${type})`;
  }).join(', ');
  return `Invalid arguments for ${name}.${token} Expected an object with ${shape}.`;
}
export interface ToolBatch { tools: ToolRecord[]; bindings: ToolResultBinding[]; responses: Part[]; error: { status: LoopResult['status']; reason: string } | undefined; accepted: readonly { binding: ToolResultBinding; response: JsonObject; dataClasses?: readonly DataClass[] }[] }
interface CallOutcome { record: ToolRecord; binding?: ToolResultBinding; response?: Part; fatal?: { status: LoopResult['status']; reason: string } }
export async function runToolCalls(owner: { journal: ToolCallJournal; resultGate: ToolResultGate }, calls: readonly { id?: string; name: string; args: JsonObject }[], ctx: ToolCallsContext): Promise<ToolBatch> {
  const { registry, host, seenIds } = ctx;
  const runOne = async (index: number, call: { id?: string; name: string; args: JsonObject }): Promise<CallOutcome> => {
      const executionId = `${host.runId}:${ctx.step}:${index}`;
      const record: ToolRecord = { ...(call.id !== undefined ? { callId: call.id } : {}), name: call.name, executionId, status: 'refused', reason: 'unknown_tool' };
      const tool = registry.find(t => t.name === call.name);
      // C-ARGS/D5: the declaration-driven normalizer runs before any validation, for every tool. It drops
      // only another intent's keys, undeclared keys and absent-value fillers, so a real value of a key this
      // intent reads still reaches the tool's own refusal. It runs before the call is journaled because the
      // executor re-derives `argumentsHash` from the arguments it is handed: one form, one hash.
      const normalized = tool === undefined ? undefined : normalizeArguments(tool, call.args);
      const args = normalized === undefined ? call.args : normalized.args;
      const refusal: ToolCallRefusal = {
        runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch, revision: host.revision,
        executionId, toolName: call.name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
        ...(call.id !== undefined ? { callId: call.id } : {}), ...(tool ? { accountId: tool.accountId, resourceId: tool.resourceId } : {}),
      };
      let intent: ToolCallIntent | undefined;
      let outcome: ToolOutcome | undefined;
      let dispatched = false;
      let journalState: 'fresh' | 'existing' | 'failed' | undefined;
      let interrupted: Interrupted | undefined;
      try {
        outcome = await controlled(ctx.control, async signal => {
          const callSignal = ctx.signals?.get(call.id ?? '') ?? signal;
          if (!tool) return;
          if (call.id !== undefined && seenIds.has(call.id)) { record.reason = 'duplicate_call_id'; return; }
          if (call.id !== undefined) seenIds.add(call.id);
          if (normalized !== undefined) logArgumentsNormalized(call.name, normalized.dropped);
          const shape = typeof call.args !== 'object' || call.args === null || Array.isArray(call.args);
          const callKey = `${call.name}:${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)}`;
          const rejections = rejectedCalls(ctx.invalidAttempts ?? seenIds);
          const cached = rejections.get(callKey);
          // The same rejected call with the same arguments in the same task is answered from the cache: it is
          // not validated again, and its branch ends until the owner adds facts.
          if (!shape && cached !== undefined) { record.reason = `${cached} ${BRANCH_CLOSED}`; return; }
          const violations = shape ? [] : argumentViolationsOf(tool, args);
          if (shape || violations.length > 0 || !tool.validate(args)) {
            const attempts = recordInvalidAttempt(ctx.invalidAttempts ?? seenIds, callKey);
            const guidance = invalidArgumentsGuidance(call.name, tool.guidance, tool.parameters, violations);
            record.reason = attempts >= 3 ? `${guidance} Stop retrying this tool in this turn.` : guidance;
            rejections.set(callKey, record.reason);
            logArgumentsRejected(call.name, violations, shape ? 'arguments_not_object' : 'schema_validation_failed');
            return;
          }
          if (!host.grants.some(g => g.tool === tool.name && g.effect === tool.effect && g.accountId === tool.accountId && g.resourceId === tool.resourceId)) {
            record.reason = 'grant_not_permitted'; return;
          }
          if (!await ctx.authority.isCurrent(host, tool, signal)) { record.reason = 'stale_or_revoked_authority'; return; }
          if (signal.aborted || ctx.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= ctx.control.deadlineMs) throw new Interrupted('deadline');
          intent = { ...refusal, accountId: tool.accountId, resourceId: tool.resourceId };
          try {
            journalState = owner.journal.intent(structuredClone(intent), structuredClone(args));
            if (journalState !== 'fresh' && journalState !== 'existing') throw Error('invalid_journal_intent');
          } catch { journalState = 'failed'; return; }
          if (journalState === 'existing') return;
          if (callSignal.aborted || ctx.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= ctx.control.deadlineMs) throw new Interrupted('deadline');
          dispatched = true;
          return tool.execute(args, { runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch,
            revision: host.revision, executionId, accountId: tool.accountId, resourceId: tool.resourceId, signal: callSignal });
        });
        if (dispatched) {
          if (!outcome || !['completed', 'failed', 'unknown'].includes(outcome.status)) throw Error('invalid_tool_outcome');
          record.status = outcome.status;
          const code = outcome.status === 'completed' ? undefined : outcome.code;
          record.reason = code && isToolFailureCode(code) ? code : 'handler_outcome';
        }
      } catch (error) {
        record.status = dispatched ? (tool?.effect === 'write' ? 'unknown' : 'failed') : 'refused';
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && isToolFailureCode(error.code) ? error.code : call.name === 'open_web' && error instanceof Error && isToolFailureCode(error.message) ? error.message : call.name === 'open_web' ? 'open_web_failed' : 'handler_outcome';
        // A sub-call that never dispatched names the real reason: an interrupted round says which one,
        // and every other path keeps the reason already recorded on the record (unknown_tool,
        // grant_not_permitted, the validation guidance), never a bare wildcard.
        record.reason = dispatched
          ? (error instanceof Interrupted ? 'handler_interrupted_or_failed' : code)
          : (error instanceof Interrupted ? (error.status === 'deadline' ? 'round_deadline' : 'round_cancelled') : record.reason);
        // W5: a handler that throws is never silent. One closed-shape line, the tool name and the error
        // class from a closed list, never a message, a stack or a provider string.
        if (!(error instanceof Interrupted)) {
          hostLogEvent({ event: 'tool_handler_error', tool: call.name, class: handlerErrorClass(error), reason: record.reason });
        }
        if (error instanceof Interrupted) interrupted = error;
      }
      if (process.env.DIDI_PROBE) console.error('PROBE record', call.name, JSON.stringify({ status: record.status, reason: record.reason, dispatched, journalState, tool: Boolean(tool) }));
      if (journalState === 'failed') return { record, fatal: { status: 'error', reason: 'tool_journal_failed' } };
      if (journalState === 'existing') { record.status = 'unknown'; record.reason = 'tool_intent_exists'; return { record, fatal: { status: 'uncertain', reason: 'tool_intent_exists' } }; }
      let ref: ToolResultRef;
      try {
        ref = record.status === 'completed' && outcome?.status === 'completed' ? outcome.result :
          record.status === 'refused' ? owner.journal.refuse(structuredClone(refusal), record.reason) :
          owner.journal.fail(structuredClone(intent!), record.status as 'failed' | 'unknown', record.reason);
      } catch { return { record, fatal: { status: 'error', reason: 'tool_journal_failed' } }; }
      if (!validRef(ref)) return { record, fatal: { status: 'denied', reason: 'tool_result_denied' } };
      if (interrupted) return { record, fatal: { status: interrupted.status, reason: interrupted.status } };
      if (record.status === 'unknown') return { record, fatal: { status: 'uncertain', reason: record.reason === 'handler_outcome' ? 'unknown_tool_outcome' : record.reason } };
      // Empty host-only placeholder; only the gate may reconstruct provider JSON.
      const binding: ToolResultBinding = { executionId, name: call.name, ...(call.id !== undefined ? { callId: call.id } : {}),
        contentIndex: ctx.contentIndex, partIndex: 0, result: structuredClone(ref) };
      return { record, binding, response: { functionResponse: { ...(call.id !== undefined ? { id: call.id } : {}), name: call.name, response: {} } } };
  };
  // Dispatch the whole batch concurrently; the adapter bounds each endpoint and queues beyond its limit.
  // Results keep their original batch order because each runOne writes its own index.
  const outcomes: CallOutcome[] = new Array(calls.length);
  await Promise.all(calls.map(async (_, index) => { outcomes[index] = await runOne(index, calls[index]!); }));
  const tools: ToolRecord[] = [], bindings: ToolResultBinding[] = [], responses: Part[] = [];
  const fatal = (status: LoopResult['status'], reason: string) => ({ tools, bindings, responses, error: { status, reason }, accepted: [] as { binding: ToolResultBinding; response: JsonObject }[] });
  for (const result of outcomes) {
    tools.push(result.record);
    if (result.fatal) return fatal(result.fatal.status, result.fatal.reason);
    bindings.push({ ...result.binding!, partIndex: responses.length });
    responses.push(result.response!);
  }
  const batch: ToolBatch = { tools, bindings, responses, error: undefined, accepted: [] };
  return ctx.authorize ? authorizeToolBatch(owner, batch, ctx) : batch;
}

/** The same result reconstruction boundary serves inline and explicitly picked-up jobs. */
export async function authorizeToolBatch(owner: { resultGate: ToolResultGate }, batch: ToolBatch,
  ctx: Pick<ToolCallsContext, 'host' | 'control' | 'baseClasses'>): Promise<ToolBatch> {
  if (batch.error) return batch;
  const { tools, bindings, responses } = batch, { host } = ctx;
  const fatal = (): ToolBatch => ({ tools, bindings, responses, error: { status: 'denied', reason: 'tool_result_denied' }, accepted: [] });
  try {
    const gate = await controlled(ctx.control, signal => owner.resultGate.authorize(structuredClone(host), structuredClone(bindings), ctx.baseClasses, signal));
    if (gate.state !== 'allowed' || gate.results.length !== bindings.length) return fatal();
    const checked = new Set<ToolResultBinding>();
    for (const result of gate.results) {
      const binding = bindings.find(b => isDeepStrictEqual(b, result.binding));
      if (!binding || checked.has(binding) || !result.response || typeof result.response !== 'object' || Array.isArray(result.response)) return fatal();
      checked.add(binding);
    }
    return { tools, bindings, responses, error: batch.error, accepted: gate.results };
  } catch { return fatal(); }
}
