/**
 * 10.21: his answer to one calendar invitation. The words are the model's own ("accept the Thursday
 * invite"); Google's three response statuses and the absent invitation are decided here, in one place.
 */
export const CALENDAR_RESPONSES = ['accept', 'decline', 'tentative'] as const;
export type CalendarResponse = (typeof CALENDAR_RESPONSES)[number];
const RESPONSE_STATUS: Readonly<Record<CalendarResponse, 'accepted' | 'declined' | 'tentative'>> =
  { accept: 'accepted', decline: 'declined', tentative: 'tentative' };
export const CALENDAR_RSVP_SCHEMA = {
  name: 'respond_event',
  description: 'Answer one calendar invitation for the owner: accept, decline or tentative, by event id, with an optional note. Sets his own response status and tells nobody; never creates, deletes or invites.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      response: { type: 'string', enum: [...CALENDAR_RESPONSES] },
      note: { type: ['string', 'null'] },
    },
    required: ['id', 'response', 'note'],
    additionalProperties: false,
  },
} as const;
/** Google's status for one answer, undefined for any other word so nothing is guessed. */
export function calendarResponseStatus(word: unknown): 'accepted' | 'declined' | 'tentative' | undefined {
  return typeof word === 'string' && Object.hasOwn(RESPONSE_STATUS, word) ? RESPONSE_STATUS[word as CalendarResponse] : undefined;
}
/** The helper's own codes for an event he was not invited to: one closed answer, never a retry or a guess. */
const NOT_HIS_INVITATION: ReadonlySet<string> = new Set(['not-attendee', 'not-an-invitation']);
export const CALENDAR_RSVP_REFUSAL = 'That event is not an invitation to the owner, so there was nothing to answer.';
/** The closed refusal for an event that is not his invitation, and undefined for every other cause. */
export function calendarRsvpRefusal(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  return NOT_HIS_INVITATION.has(reason.split(':')[0]!.trim().replace(/_/g, '-').toLowerCase()) ? CALENDAR_RSVP_REFUSAL : undefined;
}
