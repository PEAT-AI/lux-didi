/**
 * C-TOOLTRUTH (10.8): the one plain cause sentence per closed refusal code, plus what will or will not happen
 * next. F7: a refusal that names no cause left her to invent one, so every code she is handed now carries the
 * cause the host actually holds. F6: no line here reads as work in progress; the running state comes from the
 * host's own record through `runningStateLine`, so a rebuilt session cannot tell her something is happening
 * when nothing is. A code whose honest cause the host does not hold says exactly that and never guesses.
 */

export interface RefusalCause {
  /** One plain statement of why this call was refused, repeatable by the model as it stands. */
  readonly cause: string;
  /** What will or will not happen next, so no refusal can be read as successful or as still running. */
  readonly next: string;
}

/** The one sentence a code with no honest cause on record gets, in the brief's own words. */
export const CAUSE_NOT_KNOWN = 'the reason is not known';

/**
 * The live layer's own replay refusals. The host holds the cause for both, so neither may fall to the unknown.
 * Every other code a tool refuses with that is not in this closed table is reported as unknown.
 */
export const HOST_REFUSAL_CODES = ['replay_identity_mismatch', 'recorded_result_unavailable'] as const;
export type HostRefusalCode = typeof HOST_REFUSAL_CODES[number];

export const REFUSAL_CAUSES: Readonly<Record<HostRefusalCode, RefusalCause>> = Object.freeze({
  replay_identity_mismatch: {
    cause: 'This call id was already recorded for a different tool, so this call was refused rather than replayed.',
    next: 'Nothing ran for this call.',
  },
  recorded_result_unavailable: {
    cause: 'The result this call id was recorded with is not available to this session any more.',
    next: 'Nothing ran for this call.',
  },
});

/** The cause and the next line for a closed code, or the honest unknown for a code this host cannot explain. */
export function refusalCauseOf(code: string): RefusalCause {
  const known = (REFUSAL_CAUSES as Readonly<Record<string, RefusalCause | undefined>>)[code];
  if (known !== undefined) return known;
  // The code is metadata, never arbitrary prose: only a closed-shape token is repeated to the model.
  const named = /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : 'an unnamed code';
  return { cause: CAUSE_NOT_KNOWN, next: `Nothing ran for this call: the host refused it with ${named} and holds no plain cause for it.` };
}

/**
 * C-TOOLTRUTH: what the host's own record says is running, so a refusal never implies work that does not exist.
 * An empty record is the sentence she can repeat verbatim after a rebuild.
 */
export function runningStateLine(running: readonly string[]): string {
  return running.length === 0 ? 'Nothing is running now.' : `Running now: ${running.join(', ')}.`;
}
