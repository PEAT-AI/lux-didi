import { controlled, Interrupted } from './control.js';
import { modelCalls } from './gemini.js';
import type { Authority, Content, HostContext, JsonObject, LoopResult, ModelControl, ModelPort, ModelRequest, Part, ToolDefinition, ToolOutcome, ToolRecord } from './types.js';

export interface LoopOptions {
  model: ModelPort; request: ModelRequest; registry: ToolDefinition[];
  host: HostContext; authority: Authority; maxSteps: number; control: ModelControl;
}
export async function runTools(options: LoopOptions): Promise<LoopResult> {
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 32) throw Error('invalid_step_limit');
  if (options.registry.length > 32 || new Set(options.registry.map(t => t.name)).size !== options.registry.length ||
    options.registry.some(t => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(t.name))) throw Error('invalid_tool_registry');
  // Snapshot policy inputs: provider results and handler output never become
  // declarations, grants, actor/account identity or authority revisions.
  const host = structuredClone(options.host);
  const registry = options.registry.map(t => ({ ...t, parameters: structuredClone(t.parameters) }));
  const request = structuredClone(options.request);
  request.declarations = registry.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const contents: Content[] = [...request.contents];
  const tools: ToolRecord[] = [];
  const seenIds = new Set<string>();
  let steps = 0;
  const end = (status: LoopResult['status'], reason: string, text = ''): LoopResult => ({ status, reason, text, steps, tools });
  for (; steps < options.maxSteps;) {
    let result;
    try {
      result = await controlled(options.control, () => options.model.generate({ ...structuredClone(request), contents: structuredClone(contents) }, options.control));
    } catch (error) {
      return end(error instanceof Interrupted ? error.status : 'error', 'model_interrupted_or_failed');
    }
    steps++;
    if (result.status !== 'complete') return { ...end(result.status, result.reason, result.text), modelResult: result };
    const calls = modelCalls(result.providerContent);
    if (!calls.length) return { ...end('complete', 'stop', result.text), modelResult: result };
    if (calls.length > 16) return end('limit', 'tool_calls_per_step_limit');
    contents.push(structuredClone(result.providerContent));
    const responses: Part[] = [];
    for (const [index, call] of calls.entries()) {
      const executionId = `${host.runId}:${steps}:${index}`;
      const record: ToolRecord = { ...(call.id !== undefined ? { callId: call.id } : {}), name: call.name, executionId, status: 'refused', reason: 'unknown_tool' };
      const tool = registry.find(t => t.name === call.name);
      let outcome: ToolOutcome | undefined;
      let dispatched = false;
      try {
        outcome = await controlled(options.control, async signal => {
          if (!tool) return;
          if (call.id !== undefined && seenIds.has(call.id)) { record.reason = 'duplicate_call_id'; return; }
          if (call.id !== undefined) seenIds.add(call.id);
          if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args) || !tool.validate(call.args)) { record.reason = 'invalid_arguments'; return; }
          if (!host.grants.some(g => g.tool === tool.name && g.effect === tool.effect && g.accountId === tool.accountId && g.resourceId === tool.resourceId)) {
            record.reason = 'grant_not_permitted'; return;
          }
          if (!await options.authority.isCurrent(host, tool, signal)) { record.reason = 'stale_or_revoked_authority'; return; }
          // Recheck interruption after asynchronous authority lookup, before dispatch.
          if (signal.aborted || options.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= options.control.deadlineMs) throw new Interrupted('deadline');
          dispatched = true;
          return tool.execute(call.args, { runId: host.runId, actorId: host.actorId, authorityEpoch: host.authorityEpoch,
            revision: host.revision, executionId, accountId: tool.accountId, resourceId: tool.resourceId, signal });
        });
        // Publish only after the controlled operation settles. A late ignored
        // handler resolution cannot mutate an already returned unknown outcome.
        if (dispatched) {
          if (!outcome || !['completed', 'failed', 'unknown'].includes(outcome.status)) throw Error('invalid_tool_outcome');
          record.status = outcome.status; record.reason = 'handler_outcome';
        }
      } catch (error) {
        record.status = dispatched ? (tool?.effect === 'write' ? 'unknown' : 'failed') : 'refused';
        record.reason = dispatched ? 'handler_interrupted_or_failed' : 'authority_or_validation_failed';
        if (error instanceof Interrupted) { tools.push({ ...record }); return end(error.status, error.status); }
      }
      tools.push(record);
      // An uncertain effect is not retried, even if the model asks again. No
      // model continuation/network retry is performed after an unknown outcome.
      if (record.status === 'unknown') return end('uncertain', 'unknown_tool_outcome');
      let response: JsonObject = { status: record.status, reason: record.reason };
      if (outcome?.status === 'completed') {
        try {
          const encoded = JSON.stringify(outcome.value);
          response = encoded !== undefined && Buffer.byteLength(encoded) <= 100_000
            ? { ...response, value: JSON.parse(encoded) as unknown }
            : { ...response, valueOmitted: true };
        } catch { response = { ...response, valueOmitted: true }; }
      }
      responses.push({ functionResponse: { ...(call.id !== undefined ? { id: call.id } : {}), name: call.name, response } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return end('limit', 'model_step_limit');
}
