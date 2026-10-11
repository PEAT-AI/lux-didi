import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { controlled, Interrupted } from '../adapters/model/control.js';
import type { Authority, DataClass, FunctionDeclaration, HostContext, JsonObject, ModelControl, Part, ToolCallIntent, ToolCallJournal, ToolCallRefusal, ToolDefinition, ToolOutcome, ToolRecord, ToolResultBinding, ToolResultGate, ToolResultRef, LoopResult } from '../adapters/model/types.js';

/** Provider schemas are presentation only. Validation and approval retain the originals. */
export function declarationsFor(registry: readonly ToolDefinition[]): { declarations: FunctionDeclaration[]; originalByName: Map<string, ToolDefinition['parameters']> } {
  const originalByName = new Map(registry.map(t => [t.name, structuredClone(t.parameters)]));
  const flatten = (value: unknown): JsonObject => {
    const schema = value as JsonObject;
    const type = String(schema.type ?? 'OBJECT').toUpperCase();
    if (type === 'ARRAY' || type === 'BOOLEAN' || schema.enum !== undefined) return { type: 'STRING', description: [schema.description, `Original schema: ${JSON.stringify(schema)}`].filter(Boolean).join(' ') };
    const result: JsonObject = { ...structuredClone(schema), type };
    if (schema.properties && typeof schema.properties === 'object') result.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, flatten(v)]));
    return result;
  };
  return { originalByName, declarations: registry.map(t => ({ name: t.name, description: t.description, parameters: flatten(t.parameters) })) };
}
export interface ToolCallsContext {
  registry: readonly ToolDefinition[]; host: HostContext; authority: Authority; control: ModelControl;
  step: number; contentIndex: number; seenIds: Set<string>; baseClasses: readonly DataClass[];
  /** Text's gate runs on the complete continuation in the next loop iteration. */
  authorize?: boolean;
}
const validRef = (ref: ToolResultRef | undefined): ref is ToolResultRef =>
  !!ref && typeof ref.id === 'string' && !!ref.id && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256);
export interface ToolBatch { tools: ToolRecord[]; bindings: ToolResultBinding[]; responses: Part[]; error: { status: LoopResult['status']; reason: string } | undefined; accepted: readonly { binding: ToolResultBinding; response: JsonObject; dataClasses?: readonly DataClass[] }[] }
export async function runToolCalls(owner: { journal: ToolCallJournal; resultGate: ToolResultGate }, calls: readonly { id?: string; name: string; args: JsonObject }[], ctx: ToolCallsContext): Promise<ToolBatch> {
  const { registry, host, seenIds } = ctx;
  const tools: ToolRecord[] = [], bindings: ToolResultBinding[] = [], responses: Part[] = [];
  const fatal = (status: LoopResult['status'], reason: string) => ({ tools, bindings, responses, error: { status, reason }, accepted: [] as { binding: ToolResultBinding; response: JsonObject }[] });
    for (const [index, call] of calls.entries()) {
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
          if (!tool) return;
          if (call.id !== undefined && seenIds.has(call.id)) { record.reason = 'duplicate_call_id'; return; }
          if (call.id !== undefined) seenIds.add(call.id);
          if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args) || !tool.validate(call.args)) { record.reason = 'invalid_arguments'; return; }
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
          if (signal.aborted || ctx.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= ctx.control.deadlineMs) throw new Interrupted('deadline');
          dispatched = true;
          return tool.execute(call.args, { runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch,
            revision: host.revision, executionId, accountId: tool.accountId, resourceId: tool.resourceId, signal });
        });
        if (dispatched) {
          if (!outcome || !['completed', 'failed', 'unknown'].includes(outcome.status)) throw Error('invalid_tool_outcome');
          record.status = outcome.status; record.reason = 'handler_outcome';
        }
      } catch (error) {
        record.status = dispatched ? (tool?.effect === 'write' ? 'unknown' : 'failed') : 'refused';
        record.reason = dispatched ? 'handler_interrupted_or_failed' : 'authority_or_validation_failed';
        if (error instanceof Interrupted) interrupted = error;
      }
      tools.push(record);
      if (journalState === 'failed') return fatal('error', 'tool_journal_failed');
      if (journalState === 'existing') { record.status = 'unknown'; record.reason = 'tool_intent_exists'; return fatal('uncertain', 'tool_intent_exists'); }
      let ref: ToolResultRef;
      try {
        ref = record.status === 'completed' && outcome?.status === 'completed' ? outcome.result :
          record.status === 'refused' ? owner.journal.refuse(structuredClone(refusal), record.reason) :
          owner.journal.fail(structuredClone(intent!), record.status as 'failed' | 'unknown', record.reason);
      } catch { return fatal('error', 'tool_journal_failed'); }
      if (!validRef(ref)) return fatal('denied', 'tool_result_denied');
      if (interrupted) return fatal(interrupted.status, interrupted.status);
      if (record.status === 'unknown') return fatal('uncertain', 'unknown_tool_outcome');
      // Empty host-only placeholder; only the gate may reconstruct provider JSON.
      const binding: ToolResultBinding = { executionId, name: call.name, ...(call.id !== undefined ? { callId: call.id } : {}),
        contentIndex: ctx.contentIndex, partIndex: responses.length, result: structuredClone(ref) };
      bindings.push(binding);
      responses.push({ functionResponse: { ...(call.id !== undefined ? { id: call.id } : {}), name: call.name, response: {} } });
    }
  const batch: ToolBatch = { tools, bindings, responses, error: undefined, accepted: [] };
  return ctx.authorize ? authorizeToolBatch(owner, batch, ctx) : batch;
}

/** The same result reconstruction boundary serves inline and explicitly picked-up jobs. */
export async function authorizeToolBatch(owner: { resultGate: ToolResultGate }, batch: ToolBatch,
  ctx: Pick<ToolCallsContext, 'host' | 'control' | 'baseClasses'>): Promise<ToolBatch> {
  const { tools, bindings, responses } = batch, { host } = ctx;
  const fatal = (): ToolBatch => ({ tools, bindings, responses, error: { status: 'denied', reason: 'tool_result_denied' }, accepted: [] });
  try {
    const gate = await controlled(ctx.control, signal => owner.resultGate.authorize(structuredClone(host), structuredClone(bindings), ctx.baseClasses, signal));
    if (gate.state !== 'allowed' || gate.results.length !== bindings.length) return fatal();
    const checked = new Set<ToolResultBinding>();
    for (const result of gate.results) {
      const binding = bindings.find(b => b.executionId === result.binding.executionId);
      if (!binding || checked.has(binding) || !isDeepStrictEqual(binding, result.binding)
          || !result.response || typeof result.response !== 'object' || Array.isArray(result.response)) return fatal();
      const bytes = JSON.stringify(result.response);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== binding.result.sha256) return fatal();
      checked.add(binding);
    }
    return { tools, bindings, responses, error: batch.error, accepted: gate.results };
  } catch { return fatal(); }
}
