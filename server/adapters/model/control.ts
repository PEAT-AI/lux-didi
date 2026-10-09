import type { ModelControl } from './types.js';

export class Interrupted extends Error {
  constructor(readonly status: 'cancelled' | 'deadline') { super(status); }
}
/** Includes non-cooperative injected ports. Ports must honor the supplied signal
 * at their own effect boundary; this cannot undo an already dispatched effect. */
export async function controlled<T>(control: ModelControl, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (control.signal.aborted) throw new Interrupted('cancelled');
  const remaining = control.deadlineMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Interrupted('deadline');
  const controller = new AbortController();
  let rejectInterrupt: (error: Interrupted) => void = () => {};
  const interruption = new Promise<never>((_resolve, reject) => { rejectInterrupt = reject; });
  const interrupt = (status: 'cancelled' | 'deadline') => {
    controller.abort(); rejectInterrupt(new Interrupted(status));
  };
  const abort = () => interrupt('cancelled');
  control.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => interrupt('deadline'), Math.min(remaining, 2_147_483_647));
  try {
    const value = await Promise.race([interruption, body(controller.signal)]);
    if (control.signal.aborted) throw new Interrupted('cancelled');
    if (Date.now() >= control.deadlineMs) throw new Interrupted('deadline');
    return value;
  } finally {
    clearTimeout(timer);
    control.signal.removeEventListener('abort', abort);
  }
}
