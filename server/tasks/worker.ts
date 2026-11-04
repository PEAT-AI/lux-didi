import { hostLogEvent } from '../tools/host-events.js';
import { randomUUID } from 'node:crypto';
import type { Identity } from './authority.js';
import { failed, readerFailure, type ToolResult } from './results.js';
import { validateArguments, type TaskTool } from './tools.js';
import { workerInstructions } from './instructions.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';
export const REVISION_ABORT = Symbol('task-revision');
export const CONNECTOR_DEADLINE_MS = 12000;
export const INFERENCE_DEADLINE_MS = 12000;
export const REVISION_DEADLINE_MS = 36000;
export const FINAL_INFERENCE_DEADLINE_MS = 24000;
const pendingReads = new WeakMap<Map<string, ToolResult>, Map<string, Promise<ToolResult>>>();
import { DEFAULT_WORKER_MODEL, DEFAULT_WORKER_EFFORT } from './model.js';
export { DEFAULT_WORKER_MODEL, DEFAULT_WORKER_EFFORT } from './model.js';
export interface ToolCall { id: string; name: string; args: unknown }
export interface Output { id: string; name: string; result: ToolResult }
export interface Inference { text: string; calls: ToolCall[]; no_action?: boolean; continuation?: { provider: 'openai' | 'gemini'; items: unknown[] } }
export interface InferRequest {
  instructions: string; input: string; outputs: Output[]; turns: Inference[];
  tools: TaskTool[]; model: string; effort: string;
}
export type Infer = (request: InferRequest, signal: AbortSignal) => Promise<Inference>;
export interface WorkerResult { status: 'complete' | 'no_action' | 'incomplete' | 'cancelled'; text: string; findings: ToolResult[]; receipts?: ToolResult[] }
export interface Clock {
  now(): number;
  timer(callback: () => void, ms: number): () => void;
}
const realClock: Clock = { now: Date.now, timer: (callback, ms) => { const handle = setTimeout(callback, ms); return () => clearTimeout(handle); } };
export interface WorkerOptions {
  registry: Map<string, TaskTool>; identity: Omit<Identity, 'operation_id'>; input: string; signal: AbortSignal; infer: Infer;
  model?: string; effort?: string; clock?: Clock;
  profile?: OwnerProfileSnapshot;
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
  const findings: ToolResult[] = [], outputs: Output[] = [], turns: Inference[] = [];
  const current = (): boolean => !abort.signal.aborted && (options.isCurrent?.() ?? true) && clock.now() - start < REVISION_DEADLINE_MS;
  const failureText = "I couldn't finish that request. I don't have a complete answer yet.";
  const partialText = (): string => findings.map(item => item.text).filter(Boolean).join('\n');
  const incomplete = (): WorkerResult => ({ status: 'incomplete', text: [failureText, partialText()].filter(Boolean).join('\n'), findings, receipts });
  const finish = (): WorkerResult => expired ? incomplete() : { status: 'cancelled', text: partialText(), findings, receipts };
  async function compose(): Promise<WorkerResult> {
    if (options.signal.aborted || !(options.isCurrent?.() ?? true)) return finish();
    if (!findings.length) return incomplete();
    const finalAbort = new AbortController();
    const stopped = new Promise<never>((_, reject) => {
      finalAbort.signal.addEventListener('abort', () => reject(new Error('Final inference stopped')), { once: true });
    });
    const cancel = (): void => finalAbort.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    const clear = clock.timer(cancel, FINAL_INFERENCE_DEADLINE_MS);
    try {
      const answer = await Promise.race([options.infer({ instructions: workerInstructions(options.profile),
        input: options.input + '\nTool work stopped before completion. Answer only from verified outputs, state unfinished coverage plainly, and do not claim completeness.',
        outputs: [...outputs, ...findings.filter(result => !outputs.some(output => output.result === result)).map((result, index) => ({ id: `completed-${index}`, name: 'completed_read', result }))], turns: [...turns], tools: [], model: options.model ?? DEFAULT_WORKER_MODEL, effort: options.effort ?? DEFAULT_WORKER_EFFORT }, finalAbort.signal), stopped]);
      if (options.signal.aborted || !(options.isCurrent?.() ?? true)) return finish();
      return { status: 'incomplete', text: answer.text || incomplete().text, findings, receipts };
    } catch { return options.signal.aborted ? finish() : incomplete(); }
    finally { clear(); options.signal.removeEventListener('abort', cancel); }
  }
  async function readBounded(body: (signal: AbortSignal) => Promise<ToolResult>): Promise<ToolResult> {
    const local = new AbortController();
    let rejectTimeout!: (reason: Error) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const stopRead = (): void => { if (options.signal.reason !== REVISION_ABORT) { local.abort(); rejectTimeout(new Error('Task stopped')); } };
    options.signal.addEventListener('abort', stopRead, { once: true });
    if (options.signal.aborted) stopRead();
    const clear = clock.timer(() => { local.abort(); rejectTimeout(new Error('Read deadline')); if (current()) expire(); }, Math.min(CONNECTOR_DEADLINE_MS, REVISION_DEADLINE_MS - (clock.now() - start)));
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
    const tool = options.registry.get(call.name);
    if (!tool) return { id: call.id, name: call.name, result: failed(`Unknown tool. Choose one of: ${[...options.registry.keys()].join(', ')}.`) };
    const validation = validateArguments(tool, call.args);
    if (!validation.ok) return { id: call.id, name: call.name, result: failed(validation.repair) };
    if (!current()) return { id: call.id, name: call.name, result: failed('This revision has stopped; use verified findings only.') };
    const key = canonical([tool.name, validation.args]);
    const operationId = randomUUID(), toolStart = clock.now();
    let cache: 'miss' | 'hit' | 'join' = 'miss';
    const telemetry = (result: ToolResult): void => hostLogEvent({ event: 'task_tool', taskId: options.identity.task_id,
      revision: options.identity.task_revision, operationId, tool: tool.name, durationMs: Math.max(0, Math.round(clock.now() - toolStart)),
      category: result.status === 'failed' ? result.failure_category ?? 'upstream_error' : result.status, cache });
    const execute = async (): Promise<ToolResult> => {
      const identity = { ...options.identity, operation_id: operationId };
      options.operation?.(identity, tool.name, validation.args, null);
      let result: ToolResult;
      try { result = tool.effect === 'none'
        ? await readBounded(signal => tool.run(validation.args, identity, signal, outsideTextSeen))
        : await bounded(signal => tool.run(validation.args, identity, signal, outsideTextSeen), CONNECTOR_DEADLINE_MS); }
      catch {
        result = tool.effect === 'none' ? readerFailure(tool.name, options.signal.aborted && options.signal.reason !== REVISION_ABORT ? 'cancelled' : 'timeout') : failed('Write outcome is unverified. Reconcile its operation receipt before any retry.', options.signal.aborted ? 'cancelled' : 'timeout');
        if (tool.effect !== 'none') result.receipt = { operation_id: identity.operation_id, state: 'unknown' };
      }
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
        result = await work;
        if (result.status !== 'failed' && !findings.includes(result)) findings.push(result);
      }
    } else result = await execute();
    telemetry(result);
    return { id: call.id, name: call.name, result };
  }
  try {
    while (current()) {
      let inference: Inference;
      try {
        options.event?.('inference', 1, clock.now() - start);
        inference = await bounded(signal => options.infer({ instructions: workerInstructions(options.profile), input: options.input, outputs: [...outputs], turns: [...turns], tools: [...options.registry.values()], model: options.model ?? DEFAULT_WORKER_MODEL, effort: options.effort ?? DEFAULT_WORKER_EFFORT }, signal), INFERENCE_DEADLINE_MS);
      } catch { return options.signal.aborted ? finish() : compose(); }
      if (!current()) return finish();
      turns.push(inference);
      if (!inference.calls.length) return { status: inference.no_action ? 'no_action' : 'complete', text: inference.text, findings, receipts };
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
        for (const item of outstanding.values()) outputs.push({ id: item.id, name: item.name, result: failed('This tool did not finish; no result is available. Do not infer absence.') });
        return options.signal.aborted ? finish() : compose();
      }
    }
    return options.signal.aborted ? finish() : compose();
  } finally { clearRevision(); options.signal.removeEventListener('abort', stop); }
}
