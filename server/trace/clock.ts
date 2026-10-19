import { randomUUID } from 'node:crypto';

export const hostClockDomain = `host:${randomUUID()}`;
export const hostMonotonicMs = (): number => Math.floor(performance.now());
