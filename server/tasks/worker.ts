import { randomUUID } from 'node:crypto';
import type { Identity } from './authority.js';
import { failed, type ToolResult } from './results.js';
import { validateArguments, type TaskTool } from './tools.js';
import { WORKER_INSTRUCTIONS } from './instructions.js';
export const CONNECTOR_DEADLINE_MS = 12000;
export const INFERENCE_DEADLINE_MS = 12000;
export const REVISION_DEADLINE_MS = 36000;
import { DEFAULT_WORKER_MODEL } from './model.js';
export { DEFAULT_WORKER_MODEL } from './model.js';
export const DEFAULT_WORKER_EFFORT = 'low';
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
  const pending = new Map<string, Promise<ToolResult>>();
  const receipts: ToolResult[] = [];
  const findings: ToolResult[] = [], outputs: Output[] = [], turns: Inference[] = [];
  const current = (): boolean => !abort.signal.aborted && (options.isCurrent?.() ?? true) && clock.now() - start < REVISION_DEADLINE_MS;
  const finish = (): WorkerResult => ({ status: expired ? 'incomplete' : 'cancelled', text: findings.map(item => item.text).filter(Boolean).join('\n'), findings, receipts });
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
    const execute = async (): Promise<ToolResult> => {
      const identity = { ...options.identity, operation_id: randomUUID() };
      options.operation?.(identity, tool.name, validation.args, null);
      let result: ToolResult;
      try { result = await bounded(signal => tool.run(call.args as Record<string, unknown>, identity, signal, outsideTextSeen), CONNECTOR_DEADLINE_MS); }
      catch {
        result = failed(tool.effect === 'none' ? 'Read did not complete. Retry in a current revision or use other verified findings.' : 'Write outcome is unverified. Reconcile its operation receipt before any retry.');
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
      if (cached) { options.event?.('dedupe', 1, clock.now() - start); result = cached; if (!findings.includes(cached)) findings.push(cached); }
      else {
        let work = pending.get(key);
        if (!work) { work = execute(); pending.set(key, work); }
        result = await work;
      }
    } else result = await execute();
    return { id: call.id, name: call.name, result };
  }
  try {
    while (current()) {
      let inference: Inference;
      try {
        options.event?.('inference', 1, clock.now() - start);
        inference = await bounded(signal => options.infer({ instructions: WORKER_INSTRUCTIONS, input: options.input, outputs: [...outputs], turns: [...turns], tools: [...options.registry.values()], model: options.model ?? DEFAULT_WORKER_MODEL, effort: options.effort ?? DEFAULT_WORKER_EFFORT }, signal), INFERENCE_DEADLINE_MS);
      } catch { return expired || options.signal.aborted ? finish() : { ...finish(), status: 'incomplete' }; }
      if (!current()) return finish();
      turns.push(inference);
      if (!inference.calls.length) return { status: inference.no_action ? 'no_action' : 'complete', text: inference.text, findings, receipts };
      options.event?.('calls', inference.calls.length, clock.now() - start);
      const completed = await Promise.all(inference.calls.map(call));
      if (completed.some(output => output.result.status !== 'failed' && options.registry.get(output.name)?.outside_text)) outsideTextSeen = true;
      outputs.push(...completed);
    }
    return finish();
  } finally { clearRevision(); options.signal.removeEventListener('abort', stop); }
}
