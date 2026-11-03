import { randomUUID } from 'node:crypto';
import type { Store } from '../runtime/store.js';
import { safeEvent } from '../host/log.js';
import { TaskController, workerInput, type Delivery, type Revision, type RevisionIdentity } from './controller.js';
import { runWorker, type Infer, type WorkerResult } from './worker.js';
import { createRegistry, type TaskTool, type ToolPorts, type Definition } from './tools.js';
import { Authority, createTaskAuthority, type Exposure } from './authority.js';
import type { ToolResult } from './results.js';
export interface TaskRuntimeOptions {
  store: Store; execute: ToolPorts["execute"]; authority: Authority; configuredTools?: Definition[]; infer: Infer; delivery: Delivery;
  /** Host's existing content capture gate, evaluated at each write. */
  contentAllowed(): boolean;
  log?(event: Record<string, unknown>): void;
}
/** Host composition only. Nothing in the live-session path imports or invokes this runtime yet. */
export class TaskRuntime {
  readonly controller: TaskController;
  readonly registry: Map<string, TaskTool>;
  readonly #contexts = new Map<string, { exposures: Set<Exposure>; urls: Set<string> }>();
  taskContext(taskId: string) {
    const task = this.controller.taskContext(taskId);
    return task ? { ...task, exposures: [...(this.#contexts.get(taskId)?.exposures ?? [])] } : undefined;
  }
  hostUrls(taskId: string): readonly string[] { return [...(this.#contexts.get(taskId)?.urls ?? [])]; }
  #capture(taskId: string, result: ToolResult, tool?: TaskTool): void {
    let context = this.#contexts.get(taskId);
    if (!context) { context = { exposures: new Set(), urls: new Set() }; this.#contexts.set(taskId, context); }
    const exposures = result.exposures ?? (tool?.outside_text ? ['company' as const] : []);
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
  constructor(readonly options: TaskRuntimeOptions) {
    const delivery: Delivery = {
      attach: (identity, binding) => { options.store.saveTaskDelivery(identity, binding, 'attached'); options.delivery.attach(identity, binding); },
      progress: identity => options.delivery.progress(identity),
      deliver: (identity, answer) => {
        const attempt = randomUUID(); options.store.saveTaskDelivery(identity, attempt, 'pending');
        try { options.delivery.deliver(identity, answer); options.store.saveTaskDelivery(identity, attempt, 'delivered'); }
        catch { options.store.saveTaskDelivery(identity, attempt, 'failed'); }
      },
      closed: identity => { options.store.saveTaskDelivery(identity, randomUUID(), 'closed'); options.delivery.closed(identity); },
    };
    this.controller = new TaskController(delivery);
    const authority = createTaskAuthority(options.authority, {
      isCurrent: (id, revision) => this.controller.isCurrentTask(id, revision),
      taskContext: id => this.taskContext(id), hostUrls: id => this.hostUrls(id), registry: () => this.registry,
    });
    this.registry = createRegistry({ execute: options.execute, authority }, options.configuredTools);
  }
  log(phase: string, revision: number, count = 0, ms = 0): void {
    const event = safeEvent({ event: 'task_lifecycle', phase, revision, count, ms });
    if (event) this.options.log?.(event);
  }
  finalize(words: string, generation: number, ownerTurn = 0): { revision: Revision; result: Promise<WorkerResult> } {
    const revision = this.controller.finalize(words, generation, ownerTurn), { identity } = revision;
    for (const evidence of revision.evidence) this.#capture(identity.task_id, evidence);
    this.options.store.saveTaskRevision(identity, revision.ownerWords, { receipts: revision.receipts, evidence: revision.evidence }, this.options.contentAllowed());
    this.log(identity.task_revision === 1 ? 'start' : 'revision', identity.task_revision);
    const result = runWorker({ registry: this.registry, infer: this.options.infer, identity, input: workerInput(revision, JSON.stringify({ status: 'running', staged_deletion: this.options.authority.stagedDeletion() ?? null })), signal: revision.signal,
      reads: revision.reads, outsideTextSeen: revision.evidence.length > 0, event: (phase, count, ms) => this.log(phase, identity.task_revision, count, ms), isCurrent: () => this.controller.isCurrent(identity),
      operation: (operation, tool, args, output) => {
        const effect = this.registry.get(tool)!.effect;
        // An unacknowledged effect is unknown, never proof of failure and never an automatic retry.
        const state = output === null ? 'pending' : effect === 'none' ? output.status === 'failed' ? 'failed' : 'committed' : output.receipt?.state ?? 'unknown';
        this.options.store.saveTaskOperation({ ...operation, tool, effect, state, args, result: output }, this.options.contentAllowed());
        if (output) this.#capture(identity.task_id, output, this.registry.get(tool));
        if (output?.receipt) this.controller.recordReceipt(output);
      },
    }).then(answer => {
      if (this.controller.isCurrent(identity)) {
        this.options.store.finishTask(identity, answer.status, answer, this.options.contentAllowed());
        this.controller.complete(identity, answer);
        this.log('complete', identity.task_revision, answer.findings.length);
      } else this.log('stale', identity.task_revision);
      return answer;
    });
    return { revision, result };
  }
  attach(identity: RevisionIdentity, binding: string): boolean { return this.controller.attach(identity, binding); }
  ownerSpeaking(): void { this.controller.ownerSpeaking(); }
  close(): void { this.controller.disconnect(); this.options.authority.endCall(); }
}
