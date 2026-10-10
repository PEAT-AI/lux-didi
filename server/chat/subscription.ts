/** One bounded queue per subscriber; no global replay or provider-part buffer. */
export class Subscription<T> implements AsyncIterableIterator<T> {
  #queue: T[] = [];
  #waiting: ((value: IteratorResult<T>) => void) | undefined;
  #closed = false;
  constructor(readonly capacity: number, readonly detach: () => void, readonly overflow: (last: T) => T) {}
  [Symbol.asyncIterator]() { return this; }
  push(event: T) {
    if (this.#closed) return;
    if (this.#waiting) { const resolve = this.#waiting; this.#waiting = undefined; resolve({ value: event, done: false }); }
    else if (this.#queue.length < this.capacity) this.#queue.push(event);
    else {
      this.#queue = [this.overflow(event)];
      this.close();
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.detach();
    if (this.#waiting) { this.#waiting({ value: undefined, done: true }); this.#waiting = undefined; }
  }
  next(): Promise<IteratorResult<T>> {
    const value = this.#queue.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.#waiting = resolve; });
  }
  return(): Promise<IteratorResult<T>> {
    this.#queue = []; this.close(); return Promise.resolve({ value: undefined, done: true });
  }
}
