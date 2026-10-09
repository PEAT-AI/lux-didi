import type { ReadStream } from 'node:tty';

// Anonymous-pipe rendezvous only: nonce is nonsecret and grants no HTTP authority.
export function supervise(input: ReadStream = process.stdin) {
  let buffer = Buffer.alloc(0), parsed = false, ended = false;
  let close: ((error?: Error) => void) | undefined, failure: Error | undefined;
  let accept!: (nonce: string) => void, reject!: (error: Error) => void;
  const nonce = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
  const timer = setTimeout(() => fail(new Error('Supervision startup frame timed out')), 5000);
  timer.unref();
  function dispose() {
    clearTimeout(timer); input.off('data', data); input.off('end', eof); input.off('error', fail); input.destroy();
  }
  function fail(error: Error) {
    failure = error;
    if (parsed) close?.(error); else reject(error);
    ended = true; dispose();
  }
  function eof() {
    ended = true;
    if (!parsed) reject(new Error('Supervision input ended before startup frame'));
    close?.(); clearTimeout(timer);
  }
  function data(chunk: Buffer) {
    if (parsed) { fail(new Error('Unexpected supervision input')); return; }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 1024) { fail(new Error('Supervision startup frame exceeds limit')); return; }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    try {
      if (end !== buffer.length - 1) throw new Error('Invalid supervision startup frame');
      const frame: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid supervision startup frame');
      const value = frame as Record<string, unknown>;
      if (Object.keys(value).length !== 3 || value.type !== 'start' || value.schemaVersion !== 1 || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce)) throw new Error('Invalid supervision startup frame');
      parsed = true; clearTimeout(timer); buffer = Buffer.alloc(0); accept(value.nonce);
    } catch { fail(new Error('Invalid supervision startup frame')); }
  }
  input.on('data', data); input.on('end', eof); input.on('error', fail); input.resume();
  return { nonce, get ended() { return ended; }, get failure() { return failure; }, watch(callback: (error?: Error) => void) { close = callback; if (ended) callback(failure); }, dispose };
}
