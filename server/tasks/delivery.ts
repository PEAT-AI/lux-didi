import type { Delivery, RevisionIdentity } from './controller.js';
import type { WorkerResult } from './worker.js';
/** Acceptance confirms timeline receipt, not wording or audibility. */
export type DeliveryState = 'sent' | 'accepted' | 'retry' | 'undelivered';
export const NO_LOOKUP_COMMENTARY = 'No lookup is needed. This is yours to answer from your own mind and the conversation.';
export interface DeliveryPorts {
  isCurrent(identity: RevisionIdentity): boolean;
  append(delegationId: string | null, text: string): string | undefined;
  state(identity: RevisionIdentity, state: DeliveryState, chunk: number): void;
}
export function splitSpokenText(text: string): string[] {
  const chunks: string[] = [];
  for (let sentence of text.trim().split(/(?<=[.!?])\s+/u)) {
    while (sentence.length > 450) {
      const space = sentence.lastIndexOf(' ', 450), end = space > 0 ? space : 450;
      chunks.push(sentence.slice(0, end)); sentence = sentence.slice(end).trimStart();
    }
    if (!sentence) continue;
    const last = chunks.at(-1);
    if (last && last.length + sentence.length + 1 <= 450) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}
interface Pending {
  identity: RevisionIdentity; answer: WorkerResult; chunks: string[]; chunk: number;
  command?: string | undefined; attempt: number; started: boolean;
}
export class TaskDelivery implements Delivery {
  #pending: Pending | undefined;
  #binding: string | null = null;
  #ready = true;
  #quiet = true;
  #owner = false;
  #undelivered: { identity: RevisionIdentity; answer: WorkerResult } | undefined;
  constructor(readonly ports: DeliveryPorts) {}
  get undelivered() { return this.#undelivered; }
  waitingAnswer(): { identity: RevisionIdentity; text: string } | undefined {
    const pending = this.#current();
    return pending ? { identity: pending.identity, text: pending.chunks.slice(pending.chunk).join(' ') } : undefined;
  }
  #current(): Pending | undefined {
    if (this.#pending && !this.ports.isCurrent(this.#pending.identity)) this.#pending = undefined;
    return this.#pending;
  }
  socket(_generation: number, ready = true): void {
    this.#binding = null; this.#ready = ready; this.#quiet = true;
    const pending = this.#current(); if (pending) { pending.command = undefined; pending.attempt = 0; pending.started = false; }
    this.#drain();
  }
  ready(): void { this.#ready = true; this.#drain(); }
  attach(identity: RevisionIdentity, binding: string): void {
    if (!this.ports.isCurrent(identity)) return;
    this.#binding = binding; this.#drain();
  }
  progress(_identity: RevisionIdentity): void {}
  deliver(identity: RevisionIdentity, answer: WorkerResult): void {
    if (!this.ports.isCurrent(identity) || answer.status === 'cancelled') return;
    const text = answer.status === 'no_action' ? (this.#binding ? NO_LOOKUP_COMMENTARY : '') : answer.text;
    if (!text.trim()) return;
    this.#undelivered = undefined;
    this.#pending = { identity, answer, chunks: splitSpokenText(text), chunk: 0, attempt: 0, started: false };
    this.#drain();
  }
  activity(input: { outputQuiet: boolean; ownerSpeaking: boolean }): void {
    this.#quiet = input.outputQuiet; this.#owner = input.ownerSpeaking; this.#drain();
  }
  accepted(command: string): void {
    const pending = this.#current(); if (!pending || pending.command !== command) return;
    this.ports.state(pending.identity, 'accepted', pending.chunk);
    if (++pending.chunk === pending.chunks.length) { this.#pending = undefined; return; }
    pending.command = undefined; pending.attempt = 0; this.#drain();
  }
  rejected(command: string): void {
    const pending = this.#current(); if (!pending || pending.command !== command) return;
    pending.command = undefined; this.#retry();
  }
  /** Socket loss preserves only the unacknowledged remainder, never accepted chunks. */
  closed(_identity: RevisionIdentity): void { this.disconnected(); }
  disconnected(): void {
    this.#ready = false; this.#binding = null;
    const pending = this.#current(); if (pending) pending.command = undefined;
  }
  dispose(): void { this.#pending = undefined; this.#binding = null; this.#ready = false; }
  #drain(): void {
    const pending = this.#current();
    if (!pending || !this.#ready || this.#owner || (!this.#quiet && !pending.started) || pending.command) return;
    pending.command = this.ports.append(this.#binding, pending.chunks[pending.chunk]!);
    if (!pending.command) { this.#retry(); return; }
    pending.started = true; this.ports.state(pending.identity, 'sent', pending.chunk);
  }
  #retry(): void {
    const pending = this.#current(); if (!pending) return;
    if (pending.attempt++ === 0) { this.ports.state(pending.identity, 'retry', pending.chunk); this.#drain(); return; }
    this.#undelivered = { identity: pending.identity, answer: pending.answer };
    this.ports.state(pending.identity, 'undelivered', pending.chunk); this.#pending = undefined;
  }
}
