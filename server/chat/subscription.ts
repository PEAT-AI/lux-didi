import type { ChatEvent } from './types.js';

/** One bounded queue per subscriber; no global replay or provider-part buffer. */
export class Subscription implements AsyncIterableIterator<ChatEvent> {
  #queue: ChatEvent[] = [];
  #waiting: ((value: IteratorResult<ChatEvent>) => void) | undefined;
  #closed = false;
  constructor(readonly capacity: number, readonly detach: () => void) {}
  [Symbol.asyncIterator]() { return this; }
  push(event: ChatEvent) {
    if (this.#closed) return;
    if (this.#waiting) { const resolve = this.#waiting; this.#waiting = undefined; resolve({ value: event, done: false }); }
    else if (this.#queue.length < this.capacity) this.#queue.push(event);
    else {
      this.#queue = [{ type: 'resync_required', sequence: event.sequence, reason: 'backpressure' }];
      this.close();
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.detach();
    if (this.#waiting) { this.#waiting({ value: undefined, done: true }); this.#waiting = undefined; }
  }
  next(): Promise<IteratorResult<ChatEvent>> {
    const event = this.#queue.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.#waiting = resolve; });
  }
  return(): Promise<IteratorResult<ChatEvent>> {
    this.#queue = []; this.close(); return Promise.resolve({ value: undefined, done: true });
  }
}
