import type { Delivery, RevisionIdentity } from './controller.js';
import type { WorkerResult } from './worker.js';
/** A delivery receipt is not audibility. Only matching output transcription proves heard. */
export const DELIVERY_HEARD_MS = 15_000;
export type DeliveryState = 'sent' | 'accepted' | 'heard' | 'rejected' | 'reconnecting' | 'undelivered';
export interface DeliveryPorts {
  isCurrent(identity: RevisionIdentity): boolean;
  append(delegationId: string, text: string): string | undefined;
  reconnect(text: string, identity: RevisionIdentity): boolean;
  state(identity: RevisionIdentity, state: DeliveryState, chunk: number): void;
  after?(ms: number, callback: () => void): () => void;
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
const normalized = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
interface Pending {
  identity: RevisionIdentity; answer: WorkerResult; chunks: string[]; chunk: number;
  command: string | undefined; attempt: number; reconnect: boolean; seeded: boolean; transcript: string;
}
export class TaskDelivery implements Delivery {
  #pending: Pending | undefined;
  #binding: { generation: number; id: string } | undefined;
  #quiet = true;
  #owner = false;
  #cancel: (() => void) | undefined;
  #undelivered: { identity: RevisionIdentity; answer: WorkerResult } | undefined;
  constructor(readonly ports: DeliveryPorts) {}
  get undelivered() { return this.#undelivered; }
  #current(): Pending | undefined {
    const pending = this.#pending;
    if (pending && !this.ports.isCurrent(pending.identity)) { this.#stopTimer(); this.#pending = undefined; return undefined; }
    return pending;
  }
  attach(identity: RevisionIdentity, binding: string): void {
    if (!this.ports.isCurrent(identity)) return;
    this.#binding = { generation: identity.connection_generation, id: binding }; this.#drain();
  }
  progress(_identity: RevisionIdentity): void {}
  deliver(identity: RevisionIdentity, answer: WorkerResult): void {
    if (!this.ports.isCurrent(identity) || answer.status === 'no_action' || !answer.text.trim()) return;
    this.#stopTimer(); this.#undelivered = undefined;
    this.#pending = { identity, answer, chunks: splitSpokenText(answer.text), chunk: 0, command: undefined, attempt: 0, reconnect: false, seeded: false, transcript: '' };
    this.#drain();
  }
  activity(input: { outputQuiet: boolean; ownerSpeaking: boolean }): void {
    this.#quiet = input.outputQuiet; this.#owner = input.ownerSpeaking;
    if (this.#owner) this.#stopTimer();
    else { this.#drain(); if (this.#current()?.command || this.#current()?.seeded) this.#arm(); }
  }
  accepted(command: string): void {
    const pending = this.#current();
    if (pending?.command === command) this.ports.state(pending.identity, 'accepted', pending.chunk);
  }
  rejected(command: string): void {
    const pending = this.#current();
    if (pending?.command !== command) return;
    this.ports.state(pending.identity, 'rejected', pending.chunk); this.#fallback();
  }
  transcript(text: string): void {
    const pending = this.#current(); if (!pending) return;
    pending.transcript = `${pending.transcript} ${text}`;
    const expected = pending.seeded ? pending.answer.text : pending.chunks[pending.chunk];
    if (!expected || !normalized(pending.transcript).includes(normalized(expected))) return;
    this.#stopTimer(); this.ports.state(pending.identity, 'heard', pending.chunk);
    if (pending.seeded || ++pending.chunk >= pending.chunks.length) { this.#pending = undefined; return; }
    pending.command = undefined; pending.transcript = ''; pending.attempt = 0; this.#drain();
  }
  /** Socket loss only clears the binding. The task and finished answer remain owned by the call. */
  closed(_identity: RevisionIdentity): void { this.#binding = undefined; }
  dispose(): void { this.#stopTimer(); this.#pending = undefined; this.#binding = undefined; }
  #stopTimer(): void { this.#cancel?.(); this.#cancel = undefined; }
  #arm(): void {
    if (this.#cancel || this.#owner || !this.#current()) return;
    const after = this.ports.after ?? ((ms: number, callback: () => void) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); });
    this.#cancel = after(DELIVERY_HEARD_MS, () => { this.#cancel = undefined; this.#fallback(); });
  }
  #drain(): void {
    const pending = this.#current();
    if (!pending || this.#owner || !this.#quiet || pending.command || pending.seeded) return;
    const binding = this.#binding;
    if (!binding || binding.generation !== pending.identity.connection_generation) { this.#reconnect(); return; }
    const text = pending.chunks[pending.chunk]; if (!text) return;
    pending.command = this.ports.append(binding.id, text);
    if (!pending.command) { this.#fallback(); return; }
    this.ports.state(pending.identity, 'sent', pending.chunk); this.#arm();
  }
  #fallback(): void {
    this.#stopTimer(); const pending = this.#current(); if (!pending || this.#owner) return;
    if (pending.seeded) { this.#fail(); return; }
    if (pending.attempt++ === 0) { pending.command = undefined; pending.transcript = ''; this.#drain(); return; }
    this.#reconnect();
  }
  #reconnect(): void {
    const pending = this.#current(); if (!pending || this.#owner || !this.#quiet) return;
    if (pending.reconnect) { this.#fail(); return; }
    pending.reconnect = true; pending.seeded = true; pending.command = undefined; pending.transcript = '';
    this.ports.state(pending.identity, 'reconnecting', pending.chunk);
    if (!this.ports.reconnect(pending.answer.text, pending.identity)) { this.#fail(); return; }
    this.#arm();
  }
  #fail(): void {
    const pending = this.#current(); if (!pending) return;
    this.#stopTimer(); this.#undelivered = { identity: pending.identity, answer: pending.answer };
    this.ports.state(pending.identity, 'undelivered', pending.chunk); this.#pending = undefined;
  }
}
