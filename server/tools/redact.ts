// Secrets never leave a tool result. This module is the one pure redactor applied to tool
// values before they reach the model, the owner UI, evidence/source cards or storage.
// Every rule is linear over its input window: the format patterns are single unbounded
// character classes with no nested quantifiers, and the labelled-neighbourhood rule only
// ever inspects a line it has already bounded.

export const REDACTED = '[redacted]';

/** Per line scan window. A line longer than this is redacted only through its first window. */
const MAX_LINE = 64 * 1024;
/** The neighbourhood rule needs a line that is a single token, so its lines are short by shape. */
const MAX_TOKEN = 64;

// Keyed assignments: password: ..., "api_key": "...", token=... The value run is one greedy
// character class, so a match costs one pass over the value and never backtracks.
const KEYED = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b(["']?[ \t]*[:=][ \t]*)(["']?)([^\s"',;&]+)/gi;
// Known token formats, one alternation so a line costs a single pass.
const FORMAT = /\bBearer[ \t]+[A-Za-z0-9._~+/-]{8,}=*|\b(?:sk-|ghp_|gho_|github_pat_|xox[abp]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/;
// A line that names a credential, or a line that is an email address, arms the next lines.
const LABEL = /(?:^|[^A-Za-z])(?:username|user|login|password|passwd|pass|pwd|credentials)\b|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i;

const classes = (token: string): number => {
  let seen = 0;
  if (/[a-z]/.test(token)) seen++;
  if (/[A-Z]/.test(token)) seen++;
  if (/[0-9]/.test(token)) seen++;
  if (/[^A-Za-z0-9]/.test(token)) seen++;
  return seen;
};

const redactLine = (line: string): { text: string; hits: number } => {
  let hits = 0;
  let out = line.replace(KEYED, (_all, key: string, sep: string, quote: string) => {
    hits++;
    return `${key}${sep}${quote}${REDACTED}`;
  });
  out = out.replace(FORMAT, (match: string) => {
    hits++;
    return match.startsWith('Bearer') ? `Bearer ${REDACTED}` : REDACTED;
  });
  return { text: out, hits };
};

interface Count {
  count: number;
}

/** The leak shape: a bare token on its own line under a credential or email line. */
const neighbourhoodToken = (line: string, previous: readonly string[]): boolean => {
  const token = line.trim();
  if (token.length < 8 || token.length > MAX_TOKEN || /\s/.test(token)) return false;
  if (classes(token) < 3) return false;
  return previous.some(seen => LABEL.test(seen));
};

const redactText = (text: string, count: Count): string => {
  const lines = text.split('\n');
  let inPem = false;
  let changed = false;
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (inPem) {
      changed = true;
      if (PEM_END.test(line)) inPem = false;
      continue;
    }
    if (PEM_BEGIN.test(line)) {
      inPem = !PEM_END.test(line);
      changed = true;
      count.count++;
      out.push(REDACTED);
      continue;
    }
    const window = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
    const tail = line.length > MAX_LINE ? line.slice(MAX_LINE) : '';
    const scanned = redactLine(window);
    count.count += scanned.hits;
    if (scanned.hits > 0) changed = true;
    let next = scanned.text + tail;
    if (neighbourhoodToken(next, lines.slice(Math.max(0, index - 3), index))) {
      next = REDACTED;
      count.count++;
      changed = true;
    }
    out.push(next);
  }
  return changed ? out.join('\n') : text;
};

export interface Redaction<T> { value: T; count: number; }

/** Walk a JSON value: only strings change, keys and structure are preserved. */
const walk = <T>(value: T, count: Count): T => {
  if (typeof value === 'string') return redactText(value, count) as unknown as T;
  if (Array.isArray(value)) return value.map(item => walk(item, count)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item, count);
    return out as T;
  }
  return value;
};

/** The redacted copy of any JSON value, and how many secrets it held. */
export function redactSecretsWithCount<T>(value: T): Redaction<T> {
  const count: Count = { count: 0 };
  const copy = walk(value, count);
  return { value: copy, count: count.count };
}

export function redactSecrets<T>(value: T): T {
  return redactSecretsWithCount(value).value;
}
