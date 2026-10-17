import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { controlled, Interrupted } from '../adapters/model/control.js';
import { isToolFailureCode } from '../adapters/model/types.js';
import { hostLogEvent } from './host-events.js';
import type { Authority, DataClass, FunctionDeclaration, HostContext, JsonObject, ModelControl, Part, ToolCallIntent, ToolCallJournal, ToolCallRefusal, ToolDefinition, ToolOutcome, ToolRecord, ToolResultBinding, ToolResultGate, ToolResultRef, LoopResult } from '../adapters/model/types.js';

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
  /** Per-call abort signals, keyed by call id, so a provider cancellation aborts exactly its call. */
  signals?: ReadonlyMap<string, AbortSignal>;
  /** Text's gate runs on the complete continuation in the next loop iteration. */
  authorize?: boolean;
}
const validRef = (ref: ToolResultRef | undefined): ref is ToolResultRef =>
  !!ref && typeof ref.id === 'string' && !!ref.id && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256);

const invalidAttempts = new WeakMap<Set<string>, Map<string, number>>();
function recordInvalidAttempt(seenIds: Set<string>, key: string): number {
  let counts = invalidAttempts.get(seenIds);
  if (counts === undefined) { counts = new Map(); invalidAttempts.set(seenIds, counts); }
  const count = (counts.get(key) ?? 0) + 1; counts.set(key, count); return count;
}
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
/** Metadata only: top-level keys and each value's JSON type, never a value. */
function logArgumentsRejected(name: string, args: unknown): void {
  const record = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const fields = Object.keys(record).slice(0, 24).map(key => `${key}:${jsonTypeOf(record[key])}`);
  hostLogEvent({ event: 'tool_arguments_rejected', tool: name, fields });
}
/** For every declared tool: the tool name and its expected argument shape, never the bad values. */
function invalidArgumentsGuidance(name: string, guidance: string | undefined, parameters: Record<string, unknown>): string {
  if (guidance !== undefined && guidance.length > 0) return `Invalid arguments for ${name}. ${guidance}`;
  const properties = (parameters['properties'] ?? {}) as Record<string, { type?: unknown; items?: unknown }>;
  const shape = Object.entries(properties).map(([key, schema]) => {
    const items = schema?.items as { type?: unknown } | undefined;
    const type = schema?.type === 'array' ? `array of ${String(items?.type ?? 'value')}` : String(schema?.type ?? 'value');
    return `${key} (${type})`;
  }).join(', ');
  return `Invalid arguments for ${name}. Expected an object with ${shape}.`;
}
export interface ToolBatch { tools: ToolRecord[]; bindings: ToolResultBinding[]; responses: Part[]; error: { status: LoopResult['status']; reason: string } | undefined; accepted: readonly { binding: ToolResultBinding; response: JsonObject; dataClasses?: readonly DataClass[] }[] }
interface CallOutcome { record: ToolRecord; binding?: ToolResultBinding; response?: Part; fatal?: { status: LoopResult['status']; reason: string } }
export async function runToolCalls(owner: { journal: ToolCallJournal; resultGate: ToolResultGate }, calls: readonly { id?: string; name: string; args: JsonObject }[], ctx: ToolCallsContext): Promise<ToolBatch> {
  const { registry, host, seenIds } = ctx;
  const runOne = async (index: number, call: { id?: string; name: string; args: JsonObject }): Promise<CallOutcome> => {
      const executionId = `${host.runId}:${ctx.step}:${index}`;
      const record: ToolRecord = { ...(call.id !== undefined ? { callId: call.id } : {}), name: call.name, executionId, status: 'refused', reason: 'unknown_tool' };
      const tool = registry.find(t => t.name === call.name);
      const refusal: ToolCallRefusal = {
        runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch, revision: host.revision,
        executionId, toolName: call.name, argumentsHash: createHash('sha256').update(JSON.stringify(call.args)).digest('hex'),
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
          if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args) || !tool.validate(call.args)) {
            const attempts = recordInvalidAttempt(seenIds, `${call.name}:${createHash('sha256').update(JSON.stringify(call.args)).digest('hex').slice(0, 16)}`);
            const guidance = invalidArgumentsGuidance(call.name, tool.guidance, tool.parameters);
            record.reason = attempts >= 3 ? `${guidance} Stop retrying this tool in this turn.` : guidance;
            logArgumentsRejected(call.name, call.args);
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
            journalState = owner.journal.intent(structuredClone(intent));
            if (journalState !== 'fresh' && journalState !== 'existing') throw Error('invalid_journal_intent');
          } catch { journalState = 'failed'; return; }
          if (journalState === 'existing') return;
          if (callSignal.aborted || ctx.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= ctx.control.deadlineMs) throw new Interrupted('deadline');
          dispatched = true;
          return tool.execute(call.args, { runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch,
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
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && isToolFailureCode(error.code) ? error.code : 'handler_outcome';
        // A sub-call that never dispatched names the real reason: an interrupted round says which one,
        // and every other path keeps the reason already recorded on the record (unknown_tool,
        // grant_not_permitted, the validation guidance), never a bare wildcard.
        record.reason = dispatched
          ? (error instanceof Interrupted ? 'handler_interrupted_or_failed' : code)
          : (error instanceof Interrupted ? (error.status === 'deadline' ? 'round_deadline' : 'round_cancelled') : record.reason);
        if (error instanceof Interrupted) interrupted = error;
      }
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
