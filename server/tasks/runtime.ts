import { hostLogEvent } from '../tools/host-events.js';
import type { Identity as OperationIdentity } from './authority.js';
import { failed, redactTaskResult } from './results.js';
import { redactSecrets } from '../tools/redact.js';
import { randomUUID } from 'node:crypto';
import type { Store } from '../runtime/store.js';
import { safeEvent } from '../host/log.js';
import { TaskController, workerInput, type Delivery, type Revision, type RevisionIdentity } from './controller.js';
import { runWorker, type FailureRecord, type Infer, type WorkerResult } from './worker.js';
import { createRegistry, type TaskTool, type ToolPorts, type Definition } from './tools.js';
import { Authority, createTaskAuthority, type Exposure } from './authority.js';
import type { ToolResult } from './results.js';
export interface TaskRuntimeOptions {
  nativeSessionId?: string;
  store: Store; execute: ToolPorts["execute"]; authority: Authority; configuredTools?: Definition[]; infer: Infer; delivery: Delivery;
  timeZone?: string; now?: () => number;
  log?(event: Record<string, unknown>): void;
}
/** Host-owned runtime shared by live voice and text chat. */
export class TaskRuntime {
  readonly controller: TaskController;
  readonly registry: Map<string, TaskTool>;
  #isCurrent: () => boolean = () => true;
  bindCurrent(check: () => boolean): void { this.#isCurrent = check; }
  readonly #toolsUsed = new Set<string>();
  /** Closed failure codes per task, so the helper can name what failed and why. */
  readonly #started = new Map<string, number>();
  readonly #taskFailures = new Map<string, { tool: string; code: string }[]>();
  #lastTask: { failure?: WorkerResult['failure']; status: string; failed_tools: { tool: string; code: string }[] } | undefined;
  usedTool(identity: RevisionIdentity): boolean { return this.#toolsUsed.has(identity.task_id); }
  readonly #contexts = new Map<string, { exposures: Set<Exposure>; urls: Set<string> }>();
  taskContext(taskId: string) {
    const task = this.controller.taskContext(taskId);
    return task ? { ...task, exposures: [...(this.#contexts.get(taskId)?.exposures ?? [])] } : undefined;
  }
  hostUrls(taskId: string): readonly string[] { return [...(this.#contexts.get(taskId)?.urls ?? [])]; }
  #capture(taskId: string, result: ToolResult, tool?: TaskTool): void {
    let context = this.#contexts.get(taskId);
    if (!context) { context = { exposures: new Set(), urls: new Set() }; this.#contexts.set(taskId, context); }
    const exposures = result.exposures ?? (tool?.outside_text && result.status !== 'failed' ? ['company' as const] : []);
    for (const source of exposures) context.exposures.add(source);
    result.exposures = [...exposures];
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) context!.urls.add(match[0]);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(result);
  }
  hostStatus: () => { rebuilt: boolean; rebuild_cause: 'host' | 'network' | 'provider' | null } = () => ({ rebuilt: false, rebuild_cause: null });
  #failures: readonly FailureRecord[] = [];
  deliveryState(identity: RevisionIdentity, state: 'sent' | 'accepted' | 'retry' | 'undelivered', chunk: number): void {
    this.options.store.saveTaskDelivery(identity, `${identity.task_id}:${identity.task_revision}:chunk:${chunk}`,
      state === 'accepted' ? 'delivered' : state === 'undelivered' ? 'failed' : 'pending');
  }
  constructor(readonly options: TaskRuntimeOptions) {
    const delivery: Delivery = {
      said: () => options.delivery.said?.(),
      attach: (identity, binding) => { options.store.saveTaskDelivery(identity, binding, 'attached'); options.delivery.attach(identity, binding); },
      progress: identity => options.delivery.progress(identity),
      deliver: (identity, answer) => {
        try { options.delivery.deliver(identity, answer); }
        catch { options.store.saveTaskDelivery(identity, randomUUID(), 'failed'); }
      },
      closed: identity => { options.store.saveTaskDelivery(identity, randomUUID(), 'closed'); options.delivery.closed(identity); },
    };
    this.controller = new TaskController(delivery);
    const authority = createTaskAuthority(options.authority, {
      isCurrent: (id, revision) => this.#isCurrent() && this.controller.isCurrentTask(id, revision),
      taskContext: id => this.taskContext(id), hostUrls: id => this.hostUrls(id), registry: () => this.registry,
    });
    this.registry = createRegistry({ execute: options.execute, authority, ...(options.nativeSessionId ? { nativeSessionId: options.nativeSessionId } : {}) }, options.configuredTools);
  }
  log(phase: string, revision: number, count = 0, ms = 0, identity = this.controller.current?.identity): void {
    const event = safeEvent({ event: 'task_lifecycle', phase, taskId: identity?.task_id, generation: identity?.connection_generation, revision, count, ms });
    if (event) this.options.log?.(event);
  }
  // #1013: the runtime's own native session names the call a task belongs to, so the row carries it.
  #liveSessionId(): string | undefined {
    const id = this.options.nativeSessionId;
    return typeof id === 'string' && id !== '' ? id : undefined;
  }
  begin(words: string, generation: number, ownerTurn = 0, overlapped = false): Revision {
    const revision = this.controller.finalize(words, generation, ownerTurn, overlapped), { identity } = revision;
    revision.askAtUtc = (this.options.now ?? Date.now)();
    this.#started.set(`${identity.task_id}:${identity.task_revision}`, revision.askAtUtc);
    for (const evidence of revision.evidence) this.#capture(identity.task_id, evidence);
    this.options.store.saveTaskRevision(identity, revision.ownerWords, { receipts: revision.receipts, evidence: revision.evidence }, Date.now(), this.#liveSessionId());
    this.log(identity.task_revision === 1 ? 'start' : 'revision', identity.task_revision);
    return revision;
  }
  async runTool(name: string, args: Record<string, unknown>, identity: OperationIdentity, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted || !this.#isCurrent() || !this.controller.isCurrentTask(identity.task_id, identity.task_revision)) return failed('Use the current task revision. This read or write was not dispatched.');
    signal = AbortSignal.any([signal, this.controller.current!.signal]);
    const tool = this.registry.get(name); if (!tool) return failed('Use an available task tool.');
    this.recordOperation(identity, name, args, null);
    let result: ToolResult;
    try { result = await tool.run(args, identity, signal, (this.taskContext(identity.task_id)?.exposures.length ?? 0) > 0); }
    catch { result = { ...failed('The tool returned no acknowledged result. Do not assume an effect happened or retry it blindly.'), ...(tool.effect === 'none' ? {} : { receipt: { operation_id: identity.operation_id, state: 'unknown' as const } }) }; }
    this.recordOperation(identity, name, args, result); return result;
  }
  recordOperation(operation: OperationIdentity, tool: string, args: Record<string, unknown>, output: ToolResult | null): void {
    // Failed reads have no successful findings, but an admitted tool still owns an outcome.
    if (output === null) this.#toolsUsed.add(operation.task_id);
    const effect = this.registry.get(tool)!.effect;
    const state = output === null ? 'pending' : effect === 'none' ? output.status === 'failed' ? 'failed' : 'committed' : output.receipt?.state ?? 'unknown';
    this.options.store.saveTaskOperation({ ...operation, tool, effect, state, args, result: output });
    if (output) this.#capture(operation.task_id, output, this.registry.get(tool));
    if (output?.status === 'failed') {
      const failures = this.#taskFailures.get(operation.task_id) ?? [];
      failures.push({ tool, code: output.failure_category ?? 'upstream_error' });
      this.#taskFailures.set(operation.task_id, failures.slice(-8));
    }
    if (output?.receipt) this.controller.recordReceipt(output);
  }
  settle(identity: RevisionIdentity, answer: WorkerResult): WorkerResult {
    this.#failures = answer.failures ?? [];
    answer = { ...answer, text: redactSecrets(answer.text), findings: answer.findings.map(result => redactTaskResult(result, 'task_answer')),
      ...(answer.receipts ? { receipts: answer.receipts.map(result => redactTaskResult(result, 'task_answer')) } : {}) };
    this.#lastTask = { ...(answer.failure ? { failure: answer.failure } : {}), status: answer.status, failed_tools: [...(this.#taskFailures.get(identity.task_id) ?? [])] };
    if (this.controller.isCurrent(identity)) {
      this.options.store.finishTask(identity, answer.status, answer);
      this.controller.complete(identity, answer);
      hostLogEvent({ event: 'task_settled', taskId: identity.task_id, revision: identity.task_revision, status: answer.status, reason_code: answer.failure?.reason_code, findings: answer.findings.length, elapsed_ms: Math.max(0, (this.options.now ?? Date.now)() - (this.#started.get(`${identity.task_id}:${identity.task_revision}`) ?? (this.options.now ?? Date.now)())) });
      this.log(answer.status === 'complete' || answer.status === 'no_action' ? 'complete' : answer.status, identity.task_revision, answer.findings.length, 0, identity);
    } else this.log('stale', identity.task_revision, 0, 0, identity);
    return answer;
  }
  /** Verified host facts about work: never a claim that this run is running. */
  verifiedStatus(identity: RevisionIdentity): string {
    return JSON.stringify({ other_work_running: this.controller.runningOther(identity), last_task: this.#lastTask ?? null,
      ...this.hostStatus(), staged_deletion: this.options.authority.stagedDeletion() ?? null, failures: this.#failures });
  }
  finalize(words: string, generation: number, ownerTurn = 0, overlapped = false): { revision: Revision; result: Promise<WorkerResult> } {
    const revision = this.begin(words, generation, ownerTurn, overlapped), { identity } = revision;
    const result = runWorker({ registry: this.registry, infer: this.options.infer, identity, input: workerInput(revision, this.verifiedStatus(identity), { now_utc: new Date(revision.askAtUtc!).toISOString(), owner_time_zone: this.options.timeZone ?? 'UTC' }), signal: revision.signal,
      reads: revision.reads, outsideTextSeen: revision.evidence.length > 0, event: (phase, count, ms) => this.log(phase, identity.task_revision, count, ms, identity), isCurrent: () => this.controller.isCurrent(identity),
      operation: (operation, tool, args, output) => this.recordOperation(operation, tool, args, output),
    }).then(answer => this.settle(identity, answer), () => {
      hostLogEvent({ event: 'task_runtime_rejected', taskId: identity.task_id, revision: identity.task_revision, reason_code: 'runtime_rejected' });
      return this.settle(identity, { status: 'incomplete', text: '', findings: [], failure: { stage: 'inference', reason_code: 'runtime_rejected', detail: '' } });
    });
    return { revision, result };
  }
  attach(identity: RevisionIdentity, binding: string): boolean { return this.controller.attach(identity, binding); }
  ownerSpeaking(): void { this.controller.ownerSpeaking(); }
  close(): void { this.controller.disconnect(); this.options.authority.endCall(); }
}
