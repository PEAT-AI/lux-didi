import type { LiveToolCall, LiveToolResponse, LiveToolSendOutcome } from '../adapters/live-voice/types.js';
import type { Delivery, RevisionIdentity } from './controller.js';
import { TaskDelivery, type DeliveryState } from './delivery.js';
import type { TaskRuntime } from './runtime.js';
import type { WorkerResult } from './worker.js';
export interface TaskCallPorts {
  provider: 'openai' | 'gemini';
  createRuntime(delivery: Delivery): TaskRuntime;
  append(generation: number, delegationId: string, text: string): string | undefined;
  respond(generation: number, responses: LiveToolResponse[]): LiveToolSendOutcome;
  reconnect(text: string, identity: RevisionIdentity): boolean;
  state(identity: RevisionIdentity, state: DeliveryState, chunk: number): void;
  working?(active: boolean): void;
}
/** A call owns work. A provider socket only owns the current delivery binding. */
export class TaskCall {
  readonly runtime: TaskRuntime;
  readonly delivery: TaskDelivery;
  #generation = 0;
  #delegation: string | undefined;
  #functions: LiveToolCall[] = [];
  #answer: { identity: RevisionIdentity; answer: WorkerResult } | undefined;
  #closed = false;
  constructor(readonly ports: TaskCallPorts) {
    this.delivery = new TaskDelivery({ isCurrent: identity => !this.#closed && this.runtime.controller.isCurrent(identity),
      append: (id, text) => ports.append(this.#generation, id, text),
      reconnect: (text, identity) => ports.reconnect(text, identity), state: ports.state });
    this.runtime = ports.createRuntime({
      attach: (identity, binding) => { if (ports.provider === 'openai') this.delivery.attach(identity, binding); },
      progress: identity => this.delivery.progress(identity),
      closed: identity => this.delivery.closed(identity),
      deliver: (identity, answer) => {
        this.#answer = { identity, answer };
        if (ports.provider === 'openai') this.delivery.deliver(identity, answer);
        else this.#respond();
      },
    });
  }
  get running(): boolean { return this.runtime.controller.running; }
  socket(generation: number): void {
    this.#generation = generation; this.#delegation = undefined; this.#functions = [];
    this.delivery.socket(generation);
  }
  input(words: string, ownerTurn: number): Promise<WorkerResult> {
    this.#answer = undefined;
    const { revision, result } = this.runtime.finalize(words, this.#generation, ownerTurn);
    if (this.#delegation) this.runtime.attach(revision.identity, this.#delegation);
    for (const call of this.#functions) this.runtime.attach(revision.identity, call.id);
    this.ports.working?.(true);
    return result.finally(() => { if (this.runtime.controller.isCurrent(revision.identity)) this.ports.working?.(false); });
  }
  delegation(id: string): void {
    this.#delegation = id;
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
    this.delivery.activity(input);
  }
  reconnectAnswer(): { identity: RevisionIdentity; text: string } | undefined {
    return this.delivery.waitingAnswer();
  }
  #respond(): void {
    const value = this.#answer;
    if (!value || !this.#functions.length || !this.runtime.controller.isCurrent(value.identity)) return;
    const responses = this.#functions.map(call => ({ id: call.id, name: call.name,
      response: { status: value.answer.status, text: value.answer.text } }));
    if (this.ports.respond(this.#generation, responses) !== 'failed') this.#functions = [];
  }
  close(): void { this.#closed = true; this.delivery.dispose(); this.runtime.close(); this.ports.working?.(false); }
}
