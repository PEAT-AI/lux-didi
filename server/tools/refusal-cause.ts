/**
 * C-TOOLTRUTH (10.8): the one plain cause sentence per closed refusal code, plus what will or will not happen
 * next. F7: a refusal that names no cause left her to invent one, so every code she is handed now carries the
 * cause the host actually holds. F6: no line here reads as work in progress; the running state comes from the
 * host's own record through `runningStateLine`, so a rebuilt session cannot tell her something is happening
 * when nothing is. A code whose honest cause the host does not hold says exactly that and never guesses.
 */
import type { AdmissionBlockReason, ResearchRefusalReason } from './research.js';

export interface RefusalCause {
  /** One plain statement of why this call was refused, repeatable by the model as it stands. */
  readonly cause: string;
  /** What will or will not happen next, so no refusal can be read as successful or as still running. */
  readonly next: string;
}

/** The one sentence a code with no honest cause on record gets, in the brief's own words. */
export const CAUSE_NOT_KNOWN = 'the reason is not known';

const NOTHING_SEARCHED = 'Nothing was searched.';

export const REFUSAL_CAUSES: Readonly<Record<AdmissionBlockReason | ResearchRefusalReason, RefusalCause>> = Object.freeze({
  // The admission blocks (C-RESEARCH-CONTRACT T-03 codes, unchanged): one research operation per owner turn.
  no_owner_turn: {
    cause: 'No owner turn has started in this session, so there is no ask to research.',
    next: 'Nothing starts until the owner speaks.',
  },
  turn_spent: {
    cause: 'This owner turn already spent its one research operation on a result delivered earlier in the turn.',
    next: 'Nothing further runs this turn: a new research needs the owner to speak again.',
  },
  no_turn_since_result: {
    cause: 'That result was already delivered and the owner has not spoken since.',
    next: 'Nothing new starts, and the delivered result is what this turn answers from.',
  },
  answer_already_given: {
    cause: 'This owner turn has already been answered in this session.',
    next: 'Nothing new starts until the owner speaks again.',
  },
  // The argument-shape refusals: the call never reached a source, so the cause is the shape itself.
  root_type: { cause: 'The arguments were not one object, so no argument could be read.', next: NOTHING_SEARCHED },
  unknown_fields: { cause: 'The call named fields this tool does not have, so it was refused before any read.', next: NOTHING_SEARCHED },
  action_missing: { cause: 'The call named no action, and every research call names start, continue or stop.', next: NOTHING_SEARCHED },
  action_invalid: { cause: 'The action was not one of start, continue or stop.', next: NOTHING_SEARCHED },
  question_type: { cause: 'The question was not sent as one string.', next: NOTHING_SEARCHED },
  question_required: { cause: 'The call carried a question field with no question in it.', next: NOTHING_SEARCHED },
  question_length: { cause: 'The question was longer than the host reads in one call.', next: NOTHING_SEARCHED },
  topic_type: { cause: 'The topic was not sent as one string of names and nouns.', next: NOTHING_SEARCHED },
  topic_required: { cause: 'A start needs the topic, the names and nouns to search for, and none was sent.', next: NOTHING_SEARCHED },
  topic_length: { cause: 'The topic was longer than the host reads in one call.', next: NOTHING_SEARCHED },
  entity_rewrite: { cause: 'The topic replaced a name the question is about with a different name.', next: NOTHING_SEARCHED },
  research_id_type: { cause: 'The researchId was not sent as a string.', next: NOTHING_SEARCHED },
  research_id_required: { cause: 'This action needs the researchId of a run this session returned, and none was sent.', next: NOTHING_SEARCHED },
  sources_type: { cause: 'The sources were not sent as a list.', next: NOTHING_SEARCHED },
  direction_type: { cause: 'The direction was not sent as a string.', next: NOTHING_SEARCHED },
  cursor_type: { cause: 'The cursor was not sent in the shape the host pages with.', next: NOTHING_SEARCHED },
  cursor_action: { cause: 'A cursor pages the run this session already returned, so only a continue reads one.', next: NOTHING_SEARCHED },
  cursor_lookups_conflict: { cause: 'A cursor pages a run that was already read, so it cannot carry new lookups.', next: NOTHING_SEARCHED },
  cursor_page_conflict: { cause: 'A pageCursor is itself the page pointer, so a cursor cannot travel with it.', next: NOTHING_SEARCHED },
  lookups_type: { cause: 'The lookups were not sent as a list.', next: NOTHING_SEARCHED },
  lookups_count: { cause: 'The call carried more lookups than one call reads.', next: NOTHING_SEARCHED },
  lookups_stop: { cause: 'Lookups are read on a start, or as history lookups that page an answered continue.', next: NOTHING_SEARCHED },
  lookup_type: { cause: 'A lookup entry was not sent as an object.', next: NOTHING_SEARCHED },
  lookup_unknown_fields: { cause: 'A lookup entry named fields this tool does not have.', next: NOTHING_SEARCHED },
  lookup_source: { cause: 'A lookup named no source, or a source this host does not have.', next: NOTHING_SEARCHED },
  lookup_query_required: { cause: 'A lookup needs its query and none was sent.', next: NOTHING_SEARCHED },
  lookup_query_length: { cause: 'A lookup query was longer than the host sends to one source.', next: NOTHING_SEARCHED },
  lookup_history: { cause: 'A history lookup must read memory alone, with no query and no mail, and this one did not.', next: NOTHING_SEARCHED },
  lookup_mail: { cause: 'A mail lookup must read mail alone, with no query, and this one did not.', next: NOTHING_SEARCHED },
  no_owner_input: { cause: 'No owner turn is open in this session, so there is nothing to research against.', next: 'Nothing starts until the owner speaks.' },
});

/** The cause and the next line for a closed code, or the honest unknown for a code this host cannot explain. */
export function refusalCauseOf(code: string): RefusalCause {
  const known = (REFUSAL_CAUSES as Readonly<Record<string, RefusalCause | undefined>>)[code];
  if (known !== undefined) return known;
  return { cause: CAUSE_NOT_KNOWN, next: 'Nothing ran for this call, and no cause is invented for it.' };
}

/**
 * C-TOOLTRUTH: what the host's own record says is running, so a refusal never implies work that does not exist.
 * An empty record is the sentence she can repeat verbatim after a rebuild.
 */
export function runningStateLine(running: readonly string[]): string {
  return running.length === 0 ? 'Nothing is running now.' : `Running now: ${running.join(', ')}.`;
}
