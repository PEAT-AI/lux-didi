import { createHash, randomUUID } from 'node:crypto';
import type { ResultScope, ResultStorePort, SliceRequest, SliceResult, StoredPayload } from './port.js';
export interface MemoryStoreOptions {
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  maxSliceBytes?: number;
  now?: () => number;
}
interface Entry { scope: ResultScope; bytes: Uint8Array; sha256: string; expiresAt: number }
/** Bounded ephemeral store, injected through Didi's port; no database or memory writes. */
export class MemoryResultStore implements ResultStorePort {
  private readonly entries = new Map<string, Entry>();
  private used = 0;
  private readonly options: Required<MemoryStoreOptions>;
  constructor(options: MemoryStoreOptions = {}) {
    this.options = { maxBytes: options.maxBytes ?? 4 * 1024 * 1024, maxEntries: options.maxEntries ?? 64, ttlMs: options.ttlMs ?? 60_000, maxSliceBytes: options.maxSliceBytes ?? 16_384, now: options.now ?? Date.now };
    for (const value of [this.options.maxBytes, this.options.maxEntries, this.options.ttlMs, this.options.maxSliceBytes]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid-store-budget');
  }
  put(scope: ResultScope, bytes: Uint8Array): StoredPayload {
    const now = this.options.now();
    for (const [handle, entry] of this.entries) if (entry.expiresAt <= now) { this.used -= entry.bytes.length; this.entries.delete(handle); }
    if (bytes.length > this.options.maxBytes) return { state: 'unavailable', reason: 'oversize' };
    if (this.entries.size >= this.options.maxEntries || this.used + bytes.length > this.options.maxBytes) return { state: 'unavailable', reason: 'capacity' };
    const handle = randomUUID(); const sha256 = createHash('sha256').update(bytes).digest('hex'); const expiresAt = now + this.options.ttlMs;
    this.entries.set(handle, { scope: structuredClone(scope), bytes: bytes.slice(), sha256, expiresAt }); this.used += bytes.length;
    return { state: 'available', handle, sha256, byteLength: bytes.length, expiresAt, encoding: 'http-response-entity' };
  }
  read(request: SliceRequest, authorize: (scope: ResultScope) => boolean): SliceResult {
    const entry = this.entries.get(request.handle);
    if (!entry) return { state: 'unavailable', reason: 'unknown-or-evicted-handle' };
    const scope = entry.scope;
    if (request.endpointId !== scope.endpointId || request.generation !== scope.generation || request.account !== scope.account || request.resource !== scope.resource || !authorize(structuredClone(scope))) return { state: 'refused', reason: 'handle-scope-or-grant-refused' };
    if (entry.expiresAt <= this.options.now()) return { state: 'expired', reason: 'handle-expired' };
    if (!Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.length) || request.offset < 0 || request.length <= 0 || request.length > this.options.maxSliceBytes || request.offset + request.length > entry.bytes.length) return { state: 'unavailable', reason: 'slice-out-of-bounds' };
    return { state: 'available', bytes: entry.bytes.slice(request.offset, request.offset + request.length), byteLength: entry.bytes.length, sha256: entry.sha256, expiresAt: entry.expiresAt };
  }
}
