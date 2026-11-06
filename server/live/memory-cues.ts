/**
 * FR1: a deterministic read of the owner's finished words. A cue only decides whether the host spends its
 * own bounded local read before the helper answers; it never decides what she says, so the lists are plain
 * lowercase words and phrases matched on a whole word, in English only, and an uncued final is untouched.
 */
export type CueClass = 'memory' | 'calendar';

/** Finals that point at something already said: the past, or a plan he told her about. */
export const MEMORY_CUES: readonly string[] = Object.freeze([
  'last time', 'i told you', 'you said', 'we talked', 'we discussed', 'remember', 'my trip', 'my flight',
  'my plan', 'the other day', 'yesterday', 'last week', 'last month',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Finals that point at his calendar: today's digest is the host's own cached read. */
export const CALENDAR_CUES: readonly string[] = Object.freeze([
  'today', 'tomorrow', 'this week', 'next week', 'meeting', 'calendar', 'schedule', 'appointment',
]);

const pattern = (cues: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${cues.map(cue => cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

const MEMORY = pattern(MEMORY_CUES);
const CALENDAR = pattern(CALENDAR_CUES);

/** The cue classes this final carries, in a fixed order; an empty list means an ordinary turn. */
export function classifyCue(text: string): readonly CueClass[] {
  const cues: CueClass[] = [];
  if (MEMORY.test(text)) cues.push('memory');
  if (CALENDAR.test(text)) cues.push('calendar');
  return cues;
}
