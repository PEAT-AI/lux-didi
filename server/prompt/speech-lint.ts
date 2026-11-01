import { createHash } from 'node:crypto';

/**
 * C-HOSTFACTS BUILD-07: one small inspector for authored text, so a speech specimen or a compulsory delivery
 * slot is found mechanically instead of by reading thousands of lines. It is not a natural language judge:
 * it flags the shapes that make a line recitable (quoted replies, delivery imperatives, unquoted punchlines
 * and demonstration words) and leaves the sentence alone otherwise.
 *
 * Two things are deliberately separate:
 *
 *  - An exactness allowlist names a narrow span of text whose exact shape is required (a supported control
 *    token, a protocol string, a truth value). It is keyed by the span's own fingerprint, so changing the
 *    content invalidates the approval; there is no whole-file or style-wide exemption.
 *  - A migration baseline records findings that are already known debt, per location, fingerprint and count,
 *    with the obligation that will end them. A baseline is not a claim the text is safe and it never exempts
 *    a new or changed finding.
 *
 * Diagnostics never carry the text: a finding exposes its rule, its offset and a shape of at most twelve
 * words, so a private corpus can be reported without publishing it.
 */

export type SpeechRule = 'quoted_speech' | 'delivery_slot' | 'punchline_bullet' | 'demonstration';

export interface SpeechFinding {
  /** Which shape was found. */
  readonly rule: SpeechRule;
  /** Where in the text it starts. */
  readonly at: number;
  /** At most twelve words, never the whole line. */
  readonly shape: string;
  /** The fingerprint of the exact span, so an allowlist or baseline entry can name it without the text. */
  readonly fingerprint: string;
}

/** The most words a diagnostic may expose. */
export const SHAPE_WORDS = 12;

const DELIVERY = /(?:^|[.!?;:]\s+|\n\s*[-*]?\s*)(?:Please\s+)?(?:say|tell|ask|announce|speak|reply|greet|respond|read\s+(?:this|that)\s+aloud)\b/iu;
const DEMONSTRATION = /\b(?:for\s+example,\s*say|say\s+something\s+like|such\s+as\s+"|demonstrat\w*\s+(?:the\s+word|by\s+saying))\b/iu;
const QUOTED = /"([^"\n]{2,200})"|'([^'\n]{2,200})'|\u201c([^\u201d\n]{2,200})\u201d/gu;
const SPEECHISH = /\b(?:I|I'm|I've|I'll|you|you're|your)\b|\b(?:hello|hi|good morning|good evening|sure|certainly)\b/iu;
const PUNCHLINE = /^\s*[-*]\s+(?!")[A-Z][^\n]{8,200}[.!?]\s*$/u;

/** The first twelve words of a span, so a diagnostic describes a shape and never republishes a line. */
export function shapeOf(span: string): string {
  const words = span.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, SHAPE_WORDS);
  return words.join(' ');
}

/** The fingerprint of one exact span: approval or a baseline entry names the content, not the location. */
export function fingerprintOf(span: string): string {
  return createHash('sha256').update(span).digest('hex').slice(0, 16);
}

/** Every recitable shape in one authored text, in order. Line numbers are the caller's to derive. */
export function lintSpeech(text: string): SpeechFinding[] {
  const findings: SpeechFinding[] = [];
  const add = (rule: SpeechRule, at: number, span: string): void => {
    findings.push({ rule, at, shape: shapeOf(span), fingerprint: fingerprintOf(span) });
  };
  for (const match of text.matchAll(QUOTED)) {
    const inner = match[1] ?? match[2] ?? match[3] ?? '';
    if (SPEECHISH.test(inner)) add('quoted_speech', match.index ?? 0, inner);
  }
  for (const match of text.matchAll(new RegExp(DELIVERY.source, 'giu'))) add('delivery_slot', match.index ?? 0, match[0]!);
  for (const match of text.matchAll(new RegExp(DEMONSTRATION.source, 'giu'))) add('demonstration', match.index ?? 0, match[0]!);
  let offset = 0;
  for (const line of text.split('\n')) {
    if (PUNCHLINE.test(line)) add('punchline_bullet', offset + (line.length - line.trimStart().length), line.trim());
    offset += line.length + 1;
  }
  return findings.sort((left, right) => left.at - right.at);
}

/** An exactness approval: one narrow span whose exact shape a supported control, token or truth requires. */
export interface ExactnessEntry {
  readonly id: string;
  readonly source: string;
  readonly fingerprint: string;
  readonly reason: string;
  readonly reviewer: string;
}

/** One known finding, with the obligation that ends it. Debt stays visible and never covers new text. */
export interface BaselineEntry {
  readonly id: string;
  readonly source: string;
  readonly rule: SpeechRule;
  readonly fingerprint: string;
  readonly count: number;
  readonly destination: 'HELD' | 'FILED';
  readonly obligation: string;
}

export interface LintReport {
  /** Findings that no exactness entry and no baseline entry covers: these fail. */
  readonly untriaged: readonly (SpeechFinding & { readonly source: string })[];
  /** Known debt this run walked past, reported so it cannot be forgotten. */
  readonly debt: readonly (SpeechFinding & { readonly source: string })[];
  /** Findings an exactness entry names, which pass because the exact shape is required. */
  readonly exact: readonly (SpeechFinding & { readonly source: string })[];
}

/** One source of authored text: a file id and its content. */
export interface SpeechSource {
  readonly source: string;
  readonly text: string;
}

/**
 * The gate: exactness first, then the baseline, then debt. A finding covered by an entry that names a
 * different fingerprint is untriaged, so changed content fails instead of inheriting an old approval.
 */
export function lintSources(
  sources: readonly SpeechSource[],
  options: { readonly exactness?: readonly ExactnessEntry[]; readonly baseline?: readonly BaselineEntry[] } = {},
): LintReport {
  const exactness = options.exactness ?? [];
  const baseline = options.baseline ?? [];
  const exact: (SpeechFinding & { source: string })[] = [];
  const debt: (SpeechFinding & { source: string })[] = [];
  const untriaged: (SpeechFinding & { source: string })[] = [];
  for (const source of sources) {
    const remaining = new Map<string, number>();
    for (const entry of baseline) {
      if (entry.source !== source.source) continue;
      remaining.set(`${entry.rule}:${entry.fingerprint}`, (remaining.get(`${entry.rule}:${entry.fingerprint}`) ?? 0) + entry.count);
    }
    for (const finding of lintSpeech(source.text)) {
      const approved = exactness.some(entry => entry.source === source.source && entry.fingerprint === finding.fingerprint);
      const row = { ...finding, source: source.source };
      if (approved) { exact.push(row); continue; }
      const key = `${finding.rule}:${finding.fingerprint}`;
      const left = remaining.get(key) ?? 0;
      if (left > 0) { remaining.set(key, left - 1); debt.push(row); continue; }
      untriaged.push(row);
    }
  }
  return { untriaged, debt, exact };
}
