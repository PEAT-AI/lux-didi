import { randomUUID } from 'node:crypto';
import type { Store } from '../runtime/store.js';
import { safeEvent } from '../host/log.js';
import { TaskController, workerInput, type Delivery, type Revision, type RevisionIdentity } from './controller.js';
import { runWorker, type Infer, type WorkerResult } from './worker.js';
import type { TaskTool } from './tools.js';
export interface TaskRuntimeOptions {
  store: Store; registry: Map<string, TaskTool>; infer: Infer; delivery: Delivery;
  /** Host's existing content capture gate, evaluated at each write. */
  contentAllowed(): boolean;
  log?(event: Record<string, unknown>): void;
}
/** Host composition only. Nothing in the live-session path imports or invokes this runtime yet. */
export class TaskRuntime {
  readonly controller: TaskController;
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
  }
  log(phase: string, revision: number, count = 0, ms = 0): void {
    const event = safeEvent({ event: 'task_lifecycle', phase, revision, count, ms });
    if (event) this.options.log?.(event);
  }
  finalize(words: string, generation: number): { revision: Revision; result: Promise<WorkerResult> } {
    const revision = this.controller.finalize(words, generation), { identity } = revision;
    this.options.store.saveTaskRevision(identity, revision.ownerWords, { receipts: revision.receipts, evidence: revision.evidence }, this.options.contentAllowed());
    this.log(identity.task_revision === 1 ? 'start' : 'revision', identity.task_revision);
    const result = runWorker({ registry: this.options.registry, infer: this.options.infer, identity, input: workerInput(revision, 'running'), signal: revision.signal,
      reads: revision.reads, isCurrent: () => this.controller.isCurrent(identity),
      operation: (operation, tool, args, output) => {
        const effect = this.options.registry.get(tool)!.effect;
        // An unacknowledged effect is unknown, never proof of failure and never an automatic retry.
        const state = output === null ? 'pending' : effect === 'none' ? output.status === 'failed' ? 'failed' : 'committed' : output.receipt?.state ?? 'unknown';
        this.options.store.saveTaskOperation({ ...operation, tool, effect, state, args, result: output }, this.options.contentAllowed());
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
  close(): void { this.controller.disconnect(); }
}
