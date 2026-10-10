/**
 * Temporary per-principal conversation selection: a routing hint the paired browser
 * principal publishes for its native peer. Volatile service memory only — never a
 * database row, token or persisted column. Bounded by live authenticated principals.
 */
export type Selection = { sessionId: string; title: string };
export const NO_SELECTION: { sessionId: null; title: null } = Object.freeze({ sessionId: null, title: null });

export class ConversationSelection {
  readonly #byClient = new Map<string, Selection>();
  /** Last explicit write by this principal wins; a different principal is never touched. */
  set(clientId: string, selection: Selection): void { this.#byClient.set(clientId, { ...selection }); }
  get(clientId: string): Selection | undefined { return this.#byClient.get(clientId); }
  clear(clientId: string): void { this.#byClient.delete(clientId); }
  /** Drop records whose principal no longer holds an unexpired session. */
  prune(live: ReadonlySet<string>): void { for (const clientId of [...this.#byClient.keys()]) if (!live.has(clientId)) this.#byClient.delete(clientId); }
  get size(): number { return this.#byClient.size; }
}
