export interface SourceCard { title: string; url?: string }
export interface ApprovedSourceProjection { text?: unknown; markdown?: unknown; sources?: unknown }

const TITLE_CHARS = 256;
const URL_CHARS = 2048;

function safeURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > URL_CHARS || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? value : undefined;
  } catch { return undefined; }
}

function urlLabel(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./iu, '');
  const segment = parsed.pathname.split('/').find(Boolean);
  return segment ? `${host}/${segment}` : host;
}

/** Receives only gate-approved display fields, never raw connector evidence. */
export function sourceCards(projection: ApprovedSourceProjection, maxSources = 8): SourceCard[] {
  const cards: SourceCard[] = [];
  const seen = new Set<string>();
  const add = (title: string, url?: string) => {
    const label = url && title === url ? urlLabel(url) : title;
    const key = url === undefined ? `reference:${title}` : `url:${url}`;
    if (!label || seen.has(key) || cards.length >= maxSources) return;
    seen.add(key);
    cards.push({ title: Array.from(label).slice(0, TITLE_CHARS).join(''), ...(url === undefined ? {} : { url }) });
  };
  if (Array.isArray(projection.sources)) for (const source of projection.sources) {
    if (!source || typeof source !== 'object' || typeof source.title !== 'string') continue;
    if (source.url === undefined) add(source.title);
    else { const url = safeURL(source.url); if (url) add(source.title, url); }
  }
  const text = typeof projection.markdown === 'string' ? projection.markdown : typeof projection.text === 'string' ? projection.text : '';
  let label = -1;
  // Each URL is consumed once; an unmatched '[' replaces the pending label in constant time.
  for (let i = 0; i < text.length && cards.length < maxSources; i++) {
    if (text[i] === '[') { label = i; continue; }
    if (text[i] === ']' && label >= 0) {
      const start = label; label = -1;
      if (text[i + 1] === '(') {
        let end = i + 2;
        while (end < text.length && !/[\s)]/u.test(text[end]!)) end++;
        if (text[end] === ')') {
          const url = safeURL(text.slice(i + 2, end));
          if (url) add(text.slice(start + 1, i), url);
        }
        i = end;
      }
      continue;
    }
    if (label >= 0) continue;
    if (text.startsWith('https://', i)) {
      let end = i + 8;
      while (end < text.length && !/[\s)<>\]]/u.test(text[end]!)) end++;
      const url = safeURL(text.slice(i, end).replace(/[.,;:!?]+$/u, ''));
      if (url) add(url, url);
      i = end - 1; continue;
    }
    let start = -1;
    if (text[i] === '#') start = i + 1;
    else if (text.slice(i, i + 7).toLowerCase() === 'insight' && /\s/u.test(text[i + 7] ?? '')) {
      start = i + 7;
      while (start < text.length && /\s/u.test(text[start]!)) start++;
    }
    if (start >= 0) {
      let end = start;
      while (end < text.length && /[0-9]/u.test(text[end]!)) end++;
      if (end > start) add(`KB: ${text.slice(start, end)}`);
      i = Math.max(i, end - 1);
    }
  }
  return cards;
}
