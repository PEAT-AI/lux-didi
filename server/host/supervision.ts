import type { ReadStream } from 'node:tty';
import { NATIVE_END_REASONS } from './log.js';

/** The one argv flag the installed app passes to mark a supervised start; nothing else grants it. */
export const SUPERVISION_FLAG = '--supervised';
/** True when this start carries the supervision marker, so the app itself spawned the host. */
export function supervisionRequested(argv: readonly string[] = process.argv): boolean { return argv.includes(SUPERVISION_FLAG); }

/** C-LABELS 1: the reason the one supervised pipe named at its end, or `shell_lost` when it named none at
 *  all. One process holds one supervision pipe, and the host's ordered close reads this cell at the moment
 *  it runs, so a crash is provable: a clean Quit writes its stop frame first and EOF alone never does. */
let pipeEndReason: string | undefined;
/** The end reason this process's supervised shell named, or `shell_lost` once stdin closed without one. */
export function supervisionEndReason(): string | undefined { return pipeEndReason; }

// Anonymous-pipe rendezvous only: nonce is nonsecret and grants no HTTP authority.
export function supervise(input: ReadStream = process.stdin) {
  let buffer = Buffer.alloc(0), parsed = false, ended = false, reason: string | undefined;
  pipeEndReason = undefined;
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
    // C-LABELS 1: nothing was said about why, so the shell is gone rather than the app asking.
    if (!parsed || reason === undefined) { reason = 'shell_lost'; pipeEndReason = reason; }
    close?.(); clearTimeout(timer);
  }
  function data(chunk: Buffer) {
    if (parsed) { stopFrame(chunk); return; }
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
  /** C-LABELS 1: the app's own closed `live_end` reason, sent once before it closes stdin. Exactly this one
   *  frame is legal after the start frame; any other byte is still a supervision failure, so a broken pipe
   *  is never read as a clean end. */
  function stopFrame(chunk: Buffer) {
    if (reason !== undefined) { fail(new Error('Unexpected supervision input')); return; }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 256) { fail(new Error('Supervision stop frame exceeds limit')); return; }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    try {
      if (end !== buffer.length - 1) throw new Error('Invalid supervision stop frame');
      const frame: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid supervision stop frame');
      const value = frame as Record<string, unknown>;
      if (Object.keys(value).length !== 3 || value.type !== 'stop' || value.schemaVersion !== 1
          || typeof value.reason !== 'string' || !(NATIVE_END_REASONS as readonly string[]).includes(value.reason)) throw new Error('Invalid supervision stop frame');
      reason = value.reason; pipeEndReason = reason; buffer = Buffer.alloc(0);
    } catch { fail(new Error('Invalid supervision stop frame')); }
  }
  input.on('data', data); input.on('end', eof); input.on('error', fail); input.resume();
  return { nonce, get ended() { return ended; }, get failure() { return failure; }, get endReason() { return reason; }, watch(callback: (error?: Error) => void) { close = callback; if (ended) callback(failure); }, dispose };
}
