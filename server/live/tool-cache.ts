import type { JsonObject } from '../adapters/model/types.js';
import { canonicalJSON } from '../tools/canonical.js';

/**
 * Read-only tools whose result cannot change within minutes, so a repeated call inside one Live
 * session may reuse the first result instead of paying a connector round trip and an extra model
 * turn. Searches, histories, mail and calendar event lists, and knowledge reads are deliberately
 * absent: their result changes per query or per minute and a stale copy would be a wrong answer.
 */
export const LIVE_CACHED_READS: readonly string[] = [
  'mattermost_list_channels',
  'gcal_calendars',
  'gmail_get_profile',
];

/** Ten minutes: long enough for one spoken question, short enough that a stale list is not an answer. */
export const LIVE_CACHE_TTL_MS = 10 * 60 * 1000;

interface Entry { at: number; value: unknown }

/**
 * Per-Live-session cache. The instance lives on the session handle, so its key space is exactly
 * (session, tool name, canonical JSON of arguments) and it dies with the session. It stores no
 * payload of its own: callers cache the shaped result they already produced.
 */
export class LiveToolCache {
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number = LIVE_CACHE_TTL_MS, now: () => number = () => Date.now()) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** The exact key the brief pins: tool name plus canonical JSON of the arguments. */
  key(tool: string, args: JsonObject): string {
    return `${tool}\u0000${canonicalJSON(args)}`;
  }

  /** Only allowlisted reads are ever cached; everything else is reported uncacheable. */
  cacheable(tool: string): boolean {
    return LIVE_CACHED_READS.includes(tool);
  }

  get<T>(tool: string, args: JsonObject): T | undefined {
    const key = this.key(tool, args);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#now() - entry.at >= this.#ttlMs) { this.#entries.delete(key); return undefined; }
    return entry.value as T;
  }

  set<T>(tool: string, args: JsonObject, value: T): void {
    this.#entries.set(this.key(tool, args), { at: this.#now(), value });
  }
}
