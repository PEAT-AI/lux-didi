import { runToolCalls } from '../../tools/declarations.js';
import { isDeepStrictEqual } from 'node:util';
import { controlled, Interrupted } from './control.js';
import { modelCalls } from './gemini.js';
import type { Authority, Content, HostContext, LoopResult, ModelControl, ModelPort, ModelRequest, Part, ToolCallJournal, ToolDefinition, ToolRecord, ToolResultBinding, ToolResultGate, ToolResultRef } from './types.js';

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
    const synthesis = steps >= options.maxSteps;
    let result;
    try {
      result = await controlled(options.control, () => options.model.generate({
        ...structuredClone(request), contents: structuredClone(contents), dataClasses: [...classes],
        ...(synthesis ? { declarations: [] } : {}),
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
    if (synthesis) return end('limit', 'model_step_limit');
    if (calls.length > 16) return end('limit', 'tool_calls_per_step_limit');
    contents.push(structuredClone(result.providerContent));
    const responses: Part[] = [];
    const batch = await runToolCalls(options, calls, { registry, host, authority: options.authority, control: options.control,
      step: steps, contentIndex: contents.length, seenIds, baseClasses: request.dataClasses });
    tools.push(...batch.tools);
    for (const binding of batch.bindings) { bindings.push(binding); fresh.add(binding); }
    if (batch.error) return end(batch.error.status, batch.error.reason);
    responses.push(...batch.responses);
    contents.push({ role: 'user', parts: responses });
  }
}
