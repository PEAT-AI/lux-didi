import { hostLogEvent } from '../tools/host-events.js';
import { randomUUID } from 'node:crypto';
import type { Identity } from './authority.js';
import { closedFailure, failed, readerFailure, reasonCodeFor, type ReasonCode, type ToolResult } from './results.js';
import { REPORT_PROGRESS_TOOL, validateArguments, type TaskTool } from './tools.js';
import { workerInstructions } from './instructions.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
export const REVISION_ABORT = Symbol('task-revision');
export const CONNECTOR_DEADLINE_MS = 12000;
// A response is not known to be a tool call or spoken composition until it arrives.
export const INFERENCE_DEADLINE_MS = 24000;
export const REVISION_DEADLINE_MS = 36000;
export const FINAL_INFERENCE_DEADLINE_MS = 24000;
class ReadStopped extends Error { constructor(readonly category: 'cancelled' | 'timeout') { super(category); } }
const pendingReads = new WeakMap<Map<string, ToolResult>, Map<string, Promise<ToolResult>>>();
import { ProviderError, DEFAULT_WORKER_MODEL, DEFAULT_WORKER_EFFORT } from './model.js';
export { DEFAULT_WORKER_MODEL, DEFAULT_WORKER_EFFORT } from './model.js';
export interface ToolCall { id: string; name: string; args: unknown }
export interface Output { id: string; name: string; result: ToolResult }
export interface Inference { exact?: string[]; text: string; calls: ToolCall[]; no_action?: boolean; continuation?: { provider: 'openai' | 'gemini'; items: unknown[] } }
export interface InferRequest {
  instructions: string; input: string; outputs: Output[]; turns: Inference[];
  tools: TaskTool[]; model: string; effort: string;
}
export type Infer = (request: InferRequest, signal: AbortSignal) => Promise<Inference>;
/** One failed tool and the closed reason it gave, so the next task can say what happened. */
export interface FailureRecord { tool: string; reason_code: ReasonCode }
export interface WorkerFailure { stage: 'inference' | 'final'; reason_code: string; detail: string }
export interface WorkerResult { progress?: boolean; failure?: WorkerFailure; exact?: string[]; status: 'complete' | 'no_action' | 'incomplete' | 'cancelled'; text: string; findings: ToolResult[]; failures?: FailureRecord[]; receipts?: ToolResult[] }
/** A thrown executor error carries its own closed code when it has one, and otherwise names the source as down. */
const thrownReason = (error: unknown): ReasonCode => {
  const reason = error instanceof Error && 'reason' in error && typeof error.reason === 'string' ? error.reason : '';
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  return reason || code ? reasonCodeFor(reason || code) : 'source_down';
};
export interface Clock {
  now(): number;
  timer(callback: () => void, ms: number): () => void;
}
const realClock: Clock = { now: Date.now, timer: (callback, ms) => { const handle = setTimeout(callback, ms); return () => clearTimeout(handle); } };
export interface WorkerOptions {
  registry: Map<string, TaskTool>; identity: Omit<Identity, 'operation_id'>; input: string; signal: AbortSignal; infer: Infer;
  model?: string; effort?: string; clock?: Clock;
  profile?: OwnerProfileSnapshot;
  reportProgress?: (answer: WorkerResult) => void;
  reads?: Map<string, ToolResult>;
  isCurrent?: () => boolean;
  outsideTextSeen?: boolean;
  event?: (phase: 'inference' | 'calls' | 'dedupe' | 'deadline' | 'cancel', count: number, ms: number) => void;
  operation?: (identity: Identity, name: string, args: Record<string, unknown>, result: ToolResult | null) => void;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** One host-owned revision. Writes never enter the read cache. */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const registry = new Map(options.registry);
  registry.set(REPORT_PROGRESS_TOOL.name, REPORT_PROGRESS_TOOL);
  let reported = false;
  const clock = options.clock ?? realClock, start = clock.now();
  const abort = new AbortController();
  let expired = false;
  let outsideTextSeen = options.outsideTextSeen ?? false;
  const stop = (): void => abort.abort();
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  const expire = (): void => { expired = true; options.event?.('deadline', 0, clock.now() - start); stop(); };
  const clearRevision = clock.timer(expire, REVISION_DEADLINE_MS);
  const reads = options.reads ?? new Map<string, ToolResult>();
  let pending = pendingReads.get(reads);
  if (!pending) { pending = new Map(); pendingReads.set(reads, pending); }
  const receipts: ToolResult[] = [];
  const findings: ToolResult[] = [], failures: FailureRecord[] = [], outputs: Output[] = [], completedOutputs: Output[] = [], turns: Inference[] = [];
  /** One row per tool, first reason wins, so a retry of the same failure does not repeat itself in the status. */
  const recordFailure = (tool: string, result: ToolResult): void => {
    const code = result.reason_code ?? 'unknown';
    if (!failures.some(failure => failure.tool === tool)) failures.push({ tool, reason_code: code });
  };
  const current = (): boolean => !abort.signal.aborted && (options.isCurrent?.() ?? true) && clock.now() - start < REVISION_DEADLINE_MS;
  let failure: WorkerFailure | undefined;
  const inferenceFailed = (error: unknown, stage: WorkerFailure['stage']): void => {
    const provider = error instanceof ProviderError ? error : undefined;
    failure = { stage, reason_code: expired || clock.now() - start >= REVISION_DEADLINE_MS ? 'deadline' : provider?.reason_code ?? 'provider_unavailable', detail: provider?.detail ?? '' };
    hostLogEvent({ event: 'task_inference_failed', taskId: options.identity.task_id, revision: options.identity.task_revision,
      stage, reason_code: failure.reason_code, status: provider?.status, http_status: provider?.status, request_id: provider?.request_id, provider_error_class: provider?.error_class ?? 'unknown', model: options.model ?? DEFAULT_WORKER_MODEL,
      tool_count: options.registry.size, instruction_chars: workerInstructions(options.profile).length, elapsed_ms: Math.max(0, clock.now() - start), detail: failure.detail });
  };
  const partialText = (): string => findings.map(item => [item.text, item.coverage].filter(Boolean).join(' ')).filter(Boolean).join(' ');
  const incomplete = (): WorkerResult => ({ status: 'incomplete', text: partialText(), findings, failures, receipts, ...(failure ? { failure } : expired ? { failure: { stage: 'inference' as const, reason_code: 'deadline', detail: '' } } : {}) });
  const finish = (): WorkerResult => expired ? incomplete() : { status: 'cancelled', text: partialText(), findings, failures, receipts };
  async function compose(): Promise<WorkerResult> {
    if (expired || clock.now() - start >= REVISION_DEADLINE_MS) { expired = true; return incomplete(); }
    if (options.signal.aborted || !(options.isCurrent?.() ?? true)) return finish();
    if (!findings.length) return incomplete();
    const finalAbort = new AbortController();
    const stopped = new Promise<never>((_, reject) => {
      finalAbort.signal.addEventListener('abort', () => reject(new Error('Final inference stopped')), { once: true });
    });
    const cancel = (): void => finalAbort.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    const remaining = REVISION_DEADLINE_MS + 2000 - (clock.now() - start);
    const clear = clock.timer(cancel, Math.min(FINAL_INFERENCE_DEADLINE_MS, remaining));
    try {
      const answer = await Promise.race([options.infer({ instructions: workerInstructions(options.profile),
        input: options.input + '\nTool work stopped before completion. Answer only from verified outputs, state unfinished coverage plainly, and do not claim completeness.',
        outputs: [...outputs.map(output => completedOutputs.find(done => done.id === output.id && done.result.status !== 'failed') ?? output), ...completedOutputs.filter(done => !outputs.some(output => output.id === done.id))], turns: [...turns], tools: [], model: options.model ?? DEFAULT_WORKER_MODEL, effort: options.effort ?? DEFAULT_WORKER_EFFORT }, finalAbort.signal), stopped]);
      if (options.signal.aborted || !(options.isCurrent?.() ?? true)) return finish();
      return { status: 'incomplete', text: answer.text.trim() || incomplete().text, findings, failures, receipts, ...(answer.exact ? { exact: answer.exact } : {}) };
    } catch (error) {
      if (options.signal.aborted && !expired) {
        hostLogEvent({ event: 'task_inference_superseded', taskId: options.identity.task_id,
          revision: options.identity.task_revision, stage: 'final', elapsed_ms: Math.max(0, clock.now() - start) });
        return finish();
      }
      inferenceFailed(error, 'final'); return options.signal.aborted ? finish() : incomplete();
    }
    finally { clear(); options.signal.removeEventListener('abort', cancel); }
  }
  async function readBounded(body: (signal: AbortSignal) => Promise<ToolResult>): Promise<ToolResult> {
    const local = new AbortController();
    let rejectTimeout!: (reason: Error) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const stopRead = (): void => { if (options.signal.reason !== REVISION_ABORT) { local.abort(); rejectTimeout(new ReadStopped('cancelled')); } };
    options.signal.addEventListener('abort', stopRead, { once: true });
    if (options.signal.aborted) stopRead();
    const clear = clock.timer(() => { local.abort(); rejectTimeout(new ReadStopped('timeout')); if (current()) expire(); }, Math.min(CONNECTOR_DEADLINE_MS, REVISION_DEADLINE_MS - (clock.now() - start)));
    try { return await Promise.race([body(local.signal), timeout]); }
    finally { clear(); options.signal.removeEventListener('abort', stopRead); }
  }
  async function bounded<T>(body: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    if (!current()) throw new Error('Revision stopped');
    const local = new AbortController();
    let rejectStop: (reason: Error) => void = () => {};
    const onStop = (): void => { local.abort(); rejectStop(new Error('Revision stopped')); };
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    abort.signal.addEventListener('abort', onStop, { once: true });
    const clear = clock.timer(expire, Math.min(ms, REVISION_DEADLINE_MS - (clock.now() - start)));
    try { return await Promise.race([body(local.signal), stopped]); }
    finally { clear(); abort.signal.removeEventListener('abort', onStop); }
  }
  async function call(call: ToolCall): Promise<Output> {
    const tool = registry.get(call.name);
    if (!tool) return { id: call.id, name: call.name, result: failed(`Unknown tool. Choose one of: ${[...options.registry.keys()].join(', ')}.`, 'invalid_argument') };
    const validation = validateArguments(tool, call.args);
    if (!validation.ok) return { id: call.id, name: call.name, result: failed(validation.repair, 'invalid_argument') };
    if (!current()) return { id: call.id, name: call.name, result: failed('This revision has stopped; use verified findings only.', 'cancelled') };
    if (tool.name === 'report_progress') {
      const acknowledgment = (value: object): Output => ({ id: call.id, name: call.name, result: {
        status: 'ok', text: JSON.stringify(value), references: [], next_cursor: null, coverage: 'Host progress acknowledgment.', repair: null,
      } });
      if (reported) return acknowledgment({ already_reported: true });
      const { findings: facts, still_checking } = validation.args as { findings: { text: string; source: string }[]; still_checking: string };
      const text = `Provisional, still checking ${still_checking}:\n${facts.map(fact => `${fact.text} [${fact.source}]`).join('\n')}`;
      reported = true;
      options.reportProgress?.({ progress: true, status: 'incomplete', text, findings: [] });
      return acknowledgment({ delivered: true });
    }
    const key = canonical([tool.name, validation.args]);
    const operationId = randomUUID(), toolStart = clock.now();
    let cache: 'miss' | 'hit' | 'join' = 'miss';
    const telemetry = (result: ToolResult): void => hostLogEvent({ event: 'task_tool', taskId: options.identity.task_id,
      revision: options.identity.task_revision, operationId, tool: tool.name, durationMs: Math.max(0, Math.round(clock.now() - toolStart)),
      category: result.status === 'failed' ? result.failure_category ?? 'upstream_error' : result.status,
      reason_code: result.status === 'failed' ? result.reason_code ?? 'unknown' : null, cache });
    const execute = async (): Promise<ToolResult> => {
      const identity = { ...options.identity, operation_id: operationId };
      options.operation?.(identity, tool.name, validation.args, null);
      let result: ToolResult;
      try { result = tool.effect === 'none'
        ? await readBounded(signal => tool.run(validation.args, identity, signal, outsideTextSeen))
        : await bounded(signal => tool.run(validation.args, identity, signal, outsideTextSeen), CONNECTOR_DEADLINE_MS); }
      catch (error) {
        result = tool.effect === 'none' ? readerFailure(tool.name, error instanceof ReadStopped ? error.category : 'upstream_error', error instanceof ReadStopped ? error.category : thrownReason(error)) : failed('Write outcome is unverified. Reconcile its operation receipt before any retry.', options.signal.aborted ? 'cancelled' : 'timeout');
        if (tool.effect !== 'none') result.receipt = { operation_id: identity.operation_id, state: 'unknown' };
      }
      result = closedFailure(result);
      if (result.status === 'failed') recordFailure(tool.name, result);
      if (result.receipt) receipts.push(result);
      options.operation?.(identity, tool.name, validation.args, result);
      if (result.status !== 'failed') {
        findings.push(result);
        if (tool.effect === 'none') reads.set(key, result);
      }
      return result;
    };
    let result: ToolResult;
    if (tool.effect === 'none') {
      const cached = reads.get(key);
      if (cached) { cache = 'hit'; options.event?.('dedupe', 1, clock.now() - start); result = cached; if (!findings.includes(cached)) findings.push(cached); }
      else {
        let work = pending!.get(key);
        if (!work) { work = execute(); pending!.set(key, work); void work.finally(() => { pending!.delete(key); }); }
        else cache = 'join';
        result = closedFailure(await work);
        if (result.status !== 'failed' && !findings.includes(result)) findings.push(result);
      }
    } else result = await execute();
    telemetry(result);
    completedOutputs.push({ id: call.id, name: call.name, result });
    return { id: call.id, name: call.name, result };
  }
  try {
    while (current()) {
      let inference: Inference;
      try {
        options.event?.('inference', 1, clock.now() - start);
        inference = await bounded(signal => options.infer({ instructions: workerInstructions(options.profile), input: options.input, outputs: [...outputs], turns: [...turns], tools: [...registry.values()], model: options.model ?? DEFAULT_WORKER_MODEL, effort: options.effort ?? DEFAULT_WORKER_EFFORT }, signal), INFERENCE_DEADLINE_MS);
      } catch (error) {
        if (options.signal.aborted && !expired) {
          hostLogEvent({ event: 'task_inference_superseded', taskId: options.identity.task_id,
            revision: options.identity.task_revision, stage: 'inference', elapsed_ms: Math.max(0, clock.now() - start) });
          return finish();
        }
        inferenceFailed(error, 'inference'); return options.signal.aborted ? finish() : compose();
      }
      if (!current()) return finish();
      turns.push(inference);
      if (!inference.calls.length && !inference.no_action && !inference.text.trim() && findings.length) return compose();
      if (!inference.calls.length) return { status: inference.no_action ? 'no_action' : 'complete', text: inference.text, findings, failures, receipts, ...(inference.exact ? { exact: inference.exact } : {}) };
      options.event?.('calls', inference.calls.length, clock.now() - start);
      const outstanding = new Map(inference.calls.map(item => [item.id, item]));
      let stopCalls!: () => void;
      const stopped = new Promise<void>(resolve => { stopCalls = resolve; });
      abort.signal.addEventListener('abort', stopCalls, { once: true });
      if (abort.signal.aborted) stopCalls();
      try {
        await Promise.race([Promise.all(inference.calls.map(async item => {
          const output = await call(item);
          if (!current()) return;
          outstanding.delete(item.id);
          outputs.push(output);
          if (output.result.status !== 'failed' && options.registry.get(output.name)?.outside_text) outsideTextSeen = true;
        })), stopped]);
      } finally { abort.signal.removeEventListener('abort', stopCalls); }
      if (!current()) {
        for (const item of outstanding.values()) outputs.push({ id: item.id, name: item.name, result: failed('This tool did not finish; no result is available. Do not infer absence.', 'timeout') });
        return options.signal.aborted ? finish() : compose();
      }
    }
    return options.signal.aborted ? finish() : compose();
  } finally { clearRevision(); options.signal.removeEventListener('abort', stop); }
}
