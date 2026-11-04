import type { LiveToolCall, LiveToolResponse, LiveToolSendOutcome } from '../adapters/live-voice/types.js';
import type { Delivery, RevisionIdentity } from './controller.js';
import { TaskDelivery, type DeliveryState } from './delivery.js';
import type { TaskRuntime } from './runtime.js';
import type { WorkerResult } from './worker.js';
export interface TaskCallPorts {
  provider: 'openai' | 'gemini';
  createRuntime(delivery: Delivery): TaskRuntime;
  append(generation: number, delegationId: string | null, text: string): string | undefined;
  respond(generation: number, responses: LiveToolResponse[]): LiveToolSendOutcome;
  state(identity: RevisionIdentity, state: DeliveryState, chunk: number): void;
  working?(active: boolean): void;
  after?(ms: number, callback: () => void): () => void;
}
/** A call owns work. A provider socket only owns the current delivery binding. */
export class TaskCall {
  readonly runtime: TaskRuntime;
  readonly delivery: TaskDelivery;
  #generation = 0;
  #delegation: string | undefined;
  #latestDelegation: string | undefined;
  #functions: LiveToolCall[] = [];
  #answer: { identity: RevisionIdentity; answer: WorkerResult } | undefined;
  #closed = false;
  #spoken = false;
  #outputQuiet = true;
  #queuedWords = '';
  #queuedTurn = 0;
  #inputPending = false;
  #cancelQuiet: (() => void) | undefined;
  constructor(readonly ports: TaskCallPorts) {
    this.delivery = new TaskDelivery({ isCurrent: identity => !this.#closed && this.runtime.controller.isCurrent(identity),
      append: (id, text) => ports.append(this.#generation, id, text),
      state: (identity, state, chunk) => { this.runtime.deliveryState(identity, state, chunk); ports.state(identity, state, chunk); } });
    this.runtime = ports.createRuntime({
      attach: (identity, binding) => { if (ports.provider === 'openai') this.delivery.attach(identity, binding); },
      progress: identity => this.delivery.progress(identity),
      closed: identity => this.delivery.closed(identity),
      deliver: (identity, answer) => {
        this.#answer = { identity, answer };
        if (ports.provider === 'openai') {
          const requiresDelegation = (answer.status === 'complete' || answer.status === 'incomplete') && !this.runtime.usedTool(identity) && !answer.findings.length && !answer.receipts?.length && this.#spoken && !this.#delegation;
          this.delivery.deliver(identity, answer, requiresDelegation);
        }
        else this.#respond();
      },
    });
  }
  get running(): boolean { return this.runtime.controller.running; }
  socket(generation: number, ready = true): void {
    this.#generation = generation; this.#delegation = undefined; this.#latestDelegation = undefined; this.#functions = [];
    this.#outputQuiet = true; this.delivery.socket(generation, ready);
  }
  ownerWords(): void {
    this.#cancelQuiet?.(); this.#cancelQuiet = undefined; this.#inputPending = true;
    this.#spoken = false; this.#delegation = undefined;
  }
  finalized(words: string, ownerTurn: number, quietForMs = 0): void {
    this.#queuedWords = [this.#queuedWords, words].filter(Boolean).join(' ');
    this.#queuedTurn = ownerTurn; this.#inputPending = true; this.#cancelQuiet?.();
    const after = this.ports.after ?? ((ms: number, callback: () => void) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); });
    const start = () => {
      this.#cancelQuiet = undefined; const input = this.#queuedWords; this.#queuedWords = '';
      const result = this.input(input, this.#queuedTurn);
      this.#inputPending = false;
      this.delivery.activity({ outputQuiet: this.#outputQuiet, ownerSpeaking: false });
      void result.catch(() => {});
    };
    const remaining = Math.max(0, 1_200 - quietForMs);
    // Adapter transcript finalization has already consumed part of this same quiet interval.
    if (remaining === 0) start(); else this.#cancelQuiet = after(remaining, start);
  }
  spoke(): void { this.#spoken = true; }
  input(words: string, ownerTurn: number): Promise<WorkerResult> {
    this.#answer = undefined;
    const { revision, result } = this.runtime.finalize(words, this.#generation, ownerTurn);
    if (this.#latestDelegation) this.runtime.attach(revision.identity, this.#latestDelegation);
    for (const call of this.#functions) this.runtime.attach(revision.identity, call.id);
    this.ports.working?.(true);
    return result.finally(() => { if (this.runtime.controller.isCurrent(revision.identity)) this.ports.working?.(false); });
  }
  delegation(id: string): void {
    this.#delegation = id; this.#latestDelegation = id;
    const revision = this.runtime.controller.current;
    if (revision) this.runtime.attach(revision.identity, id);
  }
  functions(calls: LiveToolCall[]): void {
    for (const call of calls) if (call.name === 'delegate' && !this.#functions.some(pending => pending.id === call.id)) this.#functions.push(call);
    const revision = this.runtime.controller.current;
    if (revision) for (const call of calls) this.runtime.attach(revision.identity, call.id);
    this.#respond();
  }
  cancelFunctions(ids: readonly string[]): void { this.#functions = this.#functions.filter(call => !ids.includes(call.id)); }
  activity(input: { outputQuiet: boolean; ownerSpeaking: boolean }): void {
    if (input.ownerSpeaking) this.runtime.ownerSpeaking();
    this.#outputQuiet = input.outputQuiet;
    this.delivery.activity({ ...input, ownerSpeaking: input.ownerSpeaking || this.#inputPending });
  }
  pendingAnswer(): { identity: RevisionIdentity; text: string } | undefined {
    return this.delivery.waitingAnswer();
  }
  #respond(): void {
    const value = this.#answer;
    if (!value || !this.#functions.length || !this.runtime.controller.isCurrent(value.identity)) return;
    const responses = this.#functions.map(call => ({ id: call.id, name: call.name,
      response: { status: value.answer.status, text: value.answer.text } }));
    if (this.ports.respond(this.#generation, responses) !== 'failed') this.#functions = [];
  }
  close(): void { this.#closed = true; this.#cancelQuiet?.(); this.delivery.dispose(); this.runtime.close(); this.ports.working?.(false); }
}
