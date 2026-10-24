/** Pure, bounded matching for the deterministic host stop gate. */
export const STOP_NAME = 'naya';
export const STOP_NAMES = ['naya', 'naja', 'nayah', 'naia', 'nia', 'nayla', 'nayer'] as const;
export const STOP_WORD_LIMIT = 10;

const END_PHRASES = [
  'stop listening', 'shut down', 'shutdown', 'end the call', 'hang up', 'goodbye', 'good night',
  'turn off', 'switch off', 'stop now', 'stop please',
];
const END_PHRASES_AFTER_NAME = ['aus', 'hor auf zuzuhoren', 'aufhoren zuzuhoren', 'schalt dich aus', 'tschuss'];
const BARE_END_PHRASES = ['stop listening', 'shut down', 'stop now', ...END_PHRASES_AFTER_NAME].sort((a, b) => b.length - a.length);
const FILLER_WORDS = new Set(['please', 'now', 'okay', 'ok', 'thanks', 'bitte', 'jetzt']);
const QUESTION_WORDS = new Set(['what', 'how', 'if', 'when', 'why', 'was', 'wie', 'wenn']);
const QUOTATION_WORDS = new Set(['say', 'said', 'says', 'quote', 'quoted', 'repeat', 'repeated']);
const NEGATION_WORDS = new Set(['not', 'never', 'dont', 'don', 'nicht', 'kein']);

export function normalizeStopSpeech(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Only ids, never recognizer text, cross into the diagnostic log. */
export function stopNameId(word: string): number {
  return (STOP_NAMES as readonly string[]).indexOf(word);
}

function politeGap(words: string[]): boolean {
  if (words.some(word => QUESTION_WORDS.has(word) || NEGATION_WORDS.has(word))) return false;
  const rest = words.filter(word => !FILLER_WORDS.has(word)).join(' ');
  return rest === '' || rest === 'can you' || rest === 'could you' || rest === 'kannst du';
}

/** The last ten words may contain a direct address, never a quoted or negated instruction. */
export function stopPhrase(text: string): string | null {
  const words = normalizeStopSpeech(text).split(' ').filter(Boolean).slice(-STOP_WORD_LIMIT);
  for (let name = 0; name < words.length; name++) {
    if (stopNameId(words[name]!) < 0) continue;
    if (words.slice(0, name).some(word => QUOTATION_WORDS.has(word) || NEGATION_WORDS.has(word))) continue;
    for (const phrase of [...END_PHRASES, ...END_PHRASES_AFTER_NAME, 'stop']) {
      const parts = phrase.split(' ');
      for (let start = 0; start <= words.length - parts.length; start++) {
        if (!parts.every((word, i) => word === words[start + i])) continue;
        const end = start + parts.length;
        const before = name < start;
        if (!before && name < end) continue;
        if (before ? start - name > 4 : name - end > 1) continue;
        if (!before && END_PHRASES_AFTER_NAME.includes(phrase)) continue;
        const gap = before ? words.slice(name + 1, start) : words.slice(end, name);
        if (phrase === 'stop' ? gap.length !== 0 : !politeGap(gap)) continue;
        const tail = words.slice(before ? end : name + 1);
        if (!tail.every(word => FILLER_WORDS.has(word))) continue;
        if (phrase === 'stop' && tail.length !== 0) continue;
        return phrase;
      }
    }
  }
  for (const phrase of BARE_END_PHRASES) {
    const parts = phrase.split(' ');
    for (let start = 0; start <= words.length - parts.length; start++) {
      if (!parts.every((word, i) => word === words[start + i])) continue;
      const prefix = words.slice(0, start);
      if (prefix.some(word => QUESTION_WORDS.has(word) || QUOTATION_WORDS.has(word) || NEGATION_WORDS.has(word))) continue;
      const tail = words.slice(start + parts.length).filter(word => !FILLER_WORDS.has(word)).join(' ');
      if (tail === '' || tail === 'to me') return phrase;
    }
  }
  return null;
}
