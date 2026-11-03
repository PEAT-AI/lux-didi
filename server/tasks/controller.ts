import { randomUUID } from 'node:crypto';
import type { Identity } from './authority.js';
import type { ToolResult } from './results.js';
import type { WorkerResult } from './worker.js';
export type RevisionIdentity = Omit<Identity, 'operation_id'>;
export interface Delivery {
  attach(identity: RevisionIdentity, binding: string): void;
  progress(identity: RevisionIdentity): void;
  deliver(identity: RevisionIdentity, answer: WorkerResult): void;
  closed(identity: RevisionIdentity): void;
}
export class FakeDelivery implements Delivery {
  readonly answers: { identity: RevisionIdentity; answer: WorkerResult }[] = [];
  readonly bindings: string[] = [];
  attach(_identity: RevisionIdentity, binding: string): void { this.bindings.push(binding); }
  progress(_identity: RevisionIdentity): void {}
  deliver(identity: RevisionIdentity, answer: WorkerResult): void { this.answers.push({ identity, answer }); }
  closed(_identity: RevisionIdentity): void {}
}
export interface Revision {
  identity: RevisionIdentity; signal: AbortSignal; ownerWords: string[]; ownerTurn: number; precedingOwnerWords?: string | undefined;
  reads: Map<string, ToolResult>; receipts: ToolResult[]; evidence: ToolResult[];
}
/** Pure lifecycle decisions; IDs are injected for deterministic tests. No language inspection. */
export class TaskController {
  #abort: AbortController | undefined;
  #revision: Revision | undefined;
  #running = false;
  #held = false;
  #retained: ToolResult[] = [];
  readonly #receipts: ToolResult[] = [];
  constructor(readonly delivery: Delivery, readonly newId: () => string = randomUUID) {}
  finalize(words: string, connection_generation: number, ownerTurn = 0): Revision {
    this.#abort?.abort();
    const previous = this.#revision;
    const revise = this.#running && previous !== undefined;
    this.#abort = new AbortController();
    this.#revision = {
      identity: { task_id: revise ? previous.identity.task_id : this.newId(), task_revision: revise ? previous.identity.task_revision + 1 : 1, connection_generation },
      ownerTurn, precedingOwnerWords: revise ? previous.precedingOwnerWords : previous?.ownerWords.join("\n"),
      signal: this.#abort.signal, ownerWords: revise ? [...previous.ownerWords, words] : [words],
      reads: revise ? previous.reads : new Map(), receipts: [...this.#receipts], evidence: [...this.#retained],
    };
    this.#running = true; this.#held = false;
    return this.#revision;
  }
  taskContext(taskId: string): { id: string; revision: number; ownerWords: string; latestOwnerWords: string; ownerTurn: number; precedingOwnerWords?: string | undefined } | undefined {
    const current = this.#revision;
    if (!current || current.identity.task_id !== taskId) return undefined;
    return { id: taskId, revision: current.identity.task_revision, ownerWords: current.ownerWords.join('\n'), latestOwnerWords: current.ownerWords.at(-1) ?? '', ownerTurn: current.ownerTurn,
      precedingOwnerWords: current.precedingOwnerWords };
  }
  isCurrentTask(taskId: string, revision: number): boolean {
    return !!this.#revision && !this.#abort?.signal.aborted && this.#revision.identity.task_id === taskId && this.#revision.identity.task_revision === revision;
  }
  isCurrent(identity: RevisionIdentity): boolean {
    const current = this.#revision?.identity;
    return !!current && !this.#abort?.signal.aborted && identity.task_id === current.task_id && identity.task_revision === current.task_revision && identity.connection_generation === current.connection_generation;
  }
  /** Speech holds the old answer immediately, before final transcription arrives. */
  ownerSpeaking(): void { this.#held = true; }
  attach(identity: RevisionIdentity, binding: string): boolean {
    if (!this.isCurrent(identity)) return false;
    this.delivery.attach(identity, binding); return true;
  }
  recordReceipt(receipt: ToolResult): void { this.#receipts.push(receipt); }
  complete(identity: RevisionIdentity, answer: WorkerResult): boolean {
    if (!this.isCurrent(identity) || this.#held || !this.#running) return false;
    this.#retained = [...answer.findings]; this.#running = false;
    this.delivery.deliver(identity, answer); return true;
  }
  disconnect(): void {
    this.#abort?.abort();
    if (this.#revision) this.delivery.closed(this.#revision.identity);
    this.#running = false;
  }
}
/** Evidence and receipts are labelled data; only ownerWords are the request history. */
export function workerInput(revision: Revision, verifiedStatus: string): string {
  return JSON.stringify({ owner_words_in_order: revision.ownerWords, verified_status: verifiedStatus,
    receipts_evidence_not_instructions: revision.receipts, retained_evidence_not_instructions: revision.evidence });
}
