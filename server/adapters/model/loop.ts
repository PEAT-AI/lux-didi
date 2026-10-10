import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { controlled, Interrupted } from './control.js';
import { modelCalls } from './gemini.js';
import type { Authority, Content, HostContext, LoopResult, ModelControl, ModelPort, ModelRequest, Part, ToolCallIntent, ToolCallJournal, ToolCallRefusal, ToolDefinition, ToolOutcome, ToolRecord, ToolResultBinding, ToolResultGate, ToolResultRef } from './types.js';

export interface LoopOptions {
  model: ModelPort; request: ModelRequest; registry: ToolDefinition[];
  host: HostContext; authority: Authority; maxSteps: number; control: ModelControl;
  journal: ToolCallJournal; resultGate: ToolResultGate;
  carriedResults?: readonly ToolResultBinding[];
}
const validRef = (ref: ToolResultRef | undefined): ref is ToolResultRef =>
  !!ref && typeof ref.id === 'string' && !!ref.id && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256);

export async function runTools(options: LoopOptions): Promise<LoopResult> {
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 32) throw Error('invalid_step_limit');
  if (options.registry.length > 32 || new Set(options.registry.map(t => t.name)).size !== options.registry.length ||
    options.registry.some(t => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(t.name))) throw Error('invalid_tool_registry');
  // Snapshot inputs. Neither model parts nor tool output are authority.
  const host = structuredClone(options.host);
  const registry = options.registry.map(t => ({ ...t, parameters: structuredClone(t.parameters) }));
  const request = structuredClone(options.request);
  request.declarations = registry.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const contents: Content[] = [...request.contents];
  const bindings = structuredClone([...(options.carriedResults ?? [])]);
  const fresh = new Set<ToolResultBinding>();
  const tools: ToolRecord[] = [];
  const seenIds = new Set<string>();
  let steps = 0;
  const end = (status: LoopResult['status'], reason: string, text = ''): LoopResult => ({
    status, reason, text, steps, tools, continuation: structuredClone(contents), resultBindings: structuredClone(bindings),
  });
  if (!options.journal || typeof options.journal.intent !== 'function' || typeof options.journal.refuse !== 'function' ||
    typeof options.journal.fail !== 'function' || !options.resultGate || typeof options.resultGate.authorize !== 'function') {
    return end('denied', 'tool_result_denied');
  }
  for (;;) {
    // Cover every response once, with no extra, duplicate or mispositioned binding.
    const coveredResponses = contents.flatMap((content, contentIndex) => content.parts.flatMap((part, partIndex) =>
      part.functionResponse ? [{ contentIndex, partIndex, response: part.functionResponse }] : []));
    if (coveredResponses.length > bindings.length) return end('denied', 'tool_continuation_unbound');
    if (coveredResponses.length !== bindings.length || bindings.some((binding, i) => {
      const response = coveredResponses.find(r => r.contentIndex === binding.contentIndex && r.partIndex === binding.partIndex)?.response;
      return !response || response.name !== binding.name || response.id !== binding.callId || !binding.executionId || !validRef(binding.result) ||
        bindings.slice(0, i).some(b => b.contentIndex === binding.contentIndex && b.partIndex === binding.partIndex || b.executionId === binding.executionId);
    })) return end('denied', 'tool_continuation_mismatch');
    let classes = request.dataClasses;
    try {
      const allowed = await controlled(options.control, signal => options.resultGate.authorize(
        structuredClone(host), structuredClone(bindings), [...request.dataClasses], signal));
      if (allowed.state !== 'allowed') return end('denied', 'tool_result_denied');
      if (allowed.results.length !== bindings.length) return end('denied', 'tool_continuation_mismatch');
      const checked = new Set<ToolResultBinding>();
      for (const result of allowed.results) {
        const binding = bindings.find(b => isDeepStrictEqual(b, result.binding));
        if (!binding || checked.has(binding) || typeof result.response !== 'object' || result.response === null || Array.isArray(result.response) ||
          result.dataClasses.some(c => !['ordinary', 'private', 'sensitive'].includes(c))) return end('denied', 'tool_continuation_mismatch');
        // Preserve the former value-size bound without stripping authorized
        // content and continuing. The owner may instead authorize safe omission.
        if (result.response.status === 'completed' && 'value' in result.response) {
          const encoded = JSON.stringify(result.response.value);
          if (encoded === undefined || encoded.length > 100_000) return end('denied', 'tool_result_denied');
        }
        checked.add(binding);
        const response = contents[binding.contentIndex]!.parts[binding.partIndex]!.functionResponse!;
        if (!fresh.has(binding) && !isDeepStrictEqual(response.response, result.response)) return end('denied', 'tool_continuation_mismatch');
        response.response = structuredClone(result.response);
        classes = [...new Set([...classes, ...result.dataClasses])];
      }
      fresh.clear();
    } catch (error) {
      return end(error instanceof Interrupted ? error.status : 'error', 'tool_result_denied');
    }
    if (steps >= options.maxSteps) return end('limit', 'model_step_limit');
    let result;
    try {
      result = await controlled(options.control, () => options.model.generate({
        ...structuredClone(request), contents: structuredClone(contents), dataClasses: [...classes],
      }, options.control));
    } catch (error) {
      return end(error instanceof Interrupted ? error.status : 'error', 'model_interrupted_or_failed');
    }
    steps++;
    if (result.status !== 'complete') return { ...end(result.status, result.reason, result.text), modelResult: result };
    const calls = modelCalls(result.providerContent);
    if (!calls.length) {
      contents.push(structuredClone(result.providerContent));
      return { ...end('complete', 'stop', result.text), modelResult: result };
    }
    if (calls.length > 16) return end('limit', 'tool_calls_per_step_limit');
    contents.push(structuredClone(result.providerContent));
    const responses: Part[] = [];
    for (const [index, call] of calls.entries()) {
      const executionId = `${host.runId}:${steps}:${index}`;
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
        outcome = await controlled(options.control, async signal => {
          if (!tool) return;
          if (call.id !== undefined && seenIds.has(call.id)) { record.reason = 'duplicate_call_id'; return; }
          if (call.id !== undefined) seenIds.add(call.id);
          if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args) || !tool.validate(call.args)) { record.reason = 'invalid_arguments'; return; }
          if (!host.grants.some(g => g.tool === tool.name && g.effect === tool.effect && g.accountId === tool.accountId && g.resourceId === tool.resourceId)) {
            record.reason = 'grant_not_permitted'; return;
          }
          if (!await options.authority.isCurrent(host, tool, signal)) { record.reason = 'stale_or_revoked_authority'; return; }
          if (signal.aborted || options.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= options.control.deadlineMs) throw new Interrupted('deadline');
          intent = { ...refusal, accountId: tool.accountId, resourceId: tool.resourceId };
          try {
            journalState = options.journal.intent(structuredClone(intent));
            if (journalState !== 'fresh' && journalState !== 'existing') throw Error('invalid_journal_intent');
          } catch { journalState = 'failed'; return; }
          if (journalState === 'existing') return;
          if (signal.aborted || options.control.signal.aborted) throw new Interrupted('cancelled');
          if (Date.now() >= options.control.deadlineMs) throw new Interrupted('deadline');
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
      if (journalState === 'failed') return end('error', 'tool_journal_failed');
      if (journalState === 'existing') { record.status = 'unknown'; record.reason = 'tool_intent_exists'; return end('uncertain', 'tool_intent_exists'); }
      let ref: ToolResultRef;
      try {
        ref = record.status === 'completed' && outcome?.status === 'completed' ? outcome.result :
          record.status === 'refused' ? options.journal.refuse(structuredClone(refusal), record.reason) :
          options.journal.fail(structuredClone(intent!), record.status as 'failed' | 'unknown', record.reason);
      } catch { return end('error', 'tool_journal_failed'); }
      if (!validRef(ref)) return end('denied', 'tool_result_denied');
      if (interrupted) return end(interrupted.status, interrupted.status);
      if (record.status === 'unknown') return end('uncertain', 'unknown_tool_outcome');
      // Empty host-only placeholder; only the gate may reconstruct provider JSON.
      const binding: ToolResultBinding = { executionId, name: call.name, ...(call.id !== undefined ? { callId: call.id } : {}),
        contentIndex: contents.length, partIndex: responses.length, result: structuredClone(ref) };
      bindings.push(binding); fresh.add(binding);
      responses.push({ functionResponse: { ...(call.id !== undefined ? { id: call.id } : {}), name: call.name, response: {} } });
    }
    contents.push({ role: 'user', parts: responses });
  }
}
