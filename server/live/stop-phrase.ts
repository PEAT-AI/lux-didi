/**
 * #589: the deterministic host phrase gate. The owner's own finalized sentence, with her name at an
 * edge, ends the call. Pure normalization and matching only, so the live loop stays the one place a
 * call ends and nothing here can speak, log or touch audio.
 */
export const STOP_NAME = 'naya';

/** English end phrases, valid on either side of the name. */
const END_PHRASES: readonly string[] = [
  'stop listening', 'shut down', 'shutdown', 'end the call', 'hang up', 'goodbye', 'good night',
  'turn off', 'switch off',
];

/** German end phrases, valid only after the name, because only that order is how they are said. */
const END_PHRASES_AFTER_NAME: readonly string[] = ['aus', 'hor auf zuzuhoren', 'schalt dich aus', 'tschuss'];

/** A question about the phrase is never the phrase: "what happens if I say Naya shut down" ends nothing. */
const QUESTION_WORDS: ReadonlySet<string> = new Set(['what', 'how', 'if', 'when', 'why', 'was', 'wie', 'wenn']);

/** Past this the sentence is a story or an advert that mentions the phrase, not the owner asking. */
export const STOP_WORD_LIMIT = 8;

/**
 * Unicode fold and lowercase, then every mark that is not a letter or a digit becomes a space: the
 * recognizer's commas, quotes and full stops never decide whether the owner is ending a call.
 */
export function normalizeStopSpeech(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The canonical end phrase this finalized owner turn says, or null when it does not end the call. */
export function stopPhrase(text: string): string | null {
  const normalized = normalizeStopSpeech(text);
  if (normalized.length === 0) return null;
  const words = normalized.split(' ');
  if (words.length > STOP_WORD_LIMIT) return null;
  if (words.some(word => QUESTION_WORDS.has(word))) return null;
  const nameFirst = words[0] === STOP_NAME;
  const nameLast = words[words.length - 1] === STOP_NAME;
  if (!nameFirst && !nameLast) return null;
  const rest = (nameFirst ? words.slice(1) : words.slice(0, -1)).join(' ');
  if (rest.length === 0) return null;
  if (END_PHRASES.includes(rest)) return rest;
  if (nameFirst && END_PHRASES_AFTER_NAME.includes(rest)) return rest;
  return null;
}
