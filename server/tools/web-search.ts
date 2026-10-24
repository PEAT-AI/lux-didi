import type { Credentials } from '../adapters/model/types.js';

/**
 * WEB-1021: one typed action, no provider abstraction. Gemini `gemini-2.5-flash` generateContent with
 * the `google_search` tool answers one public query and returns citation-linked evidence Naya speaks
 * from. The query is the only thing that egresses; claims ride with their sources and never a URL in
 * the spoken text.
 */
export const WEB_SEARCH_ACTION = 'web_search';
export const WEB_MODEL = 'gemini-2.5-flash';
/** The council's hard deadline: the transport is cancelled at this point, never left running. */
export const WEB_DEADLINE_MS = 4_000;
/**
 * N6 (#569): a weather or news read settles in 3.3 to 4.4 s, so those asks get a budget that holds them.
 * The routed lookup kind is `web_search` for every ask, so the ask itself is what names the longer budget.
 */
export const WEB_SLOW_DEADLINE_MS = 8_000;
const SLOW_ASK = /\b(?:weather|forecast|temperature|rain|rains|raining|rainfall|snow|snowing|wind|windy|storm|humidity|sunrise|sunset|air quality|pollen|news|headlines?|breaking)\b/i;

export function webDeadlineMs(query: string): number {
  return SLOW_ASK.test(query) ? WEB_SLOW_DEADLINE_MS : WEB_DEADLINE_MS;
}
export const WEB_SOURCE_CAP = 3;
export const WEB_WORDS_CAP = 150;
export const WEB_QUERY_CHARS = 200;

const origin = 'https://generativelanguage.googleapis.com';
const attribution =
  'Answer in at most 150 words of plain sentences, using only what the search results support. '
  + 'Never write a URL, never greet the reader, never add a list of links.';

export type WebFailureCode = 'web_timeout' | 'web_unavailable' | 'web_rate_limited' | 'web_ungrounded' | 'web_private_question';

export interface WebSource { title: string; url: string; publishedAt?: string }
/** A claim and the sources that ground it, as indexes into `sources`. */
export interface WebClaim { text: string; sourceIndexes: readonly number[] }
export interface WebEvidence {
  answer: string;
  claims: readonly WebClaim[];
  sources: readonly WebSource[];
  /** ISO timestamp of the retrieval, so the reply says when it looked. */
  retrievedAt: string;
  /** Gemini's required search attribution markup, shown in the transcript, never spoken. */
  searchEntryPoint?: string;
}

export type WebOutcome = { ok: true; evidence: WebEvidence } | { ok: false; code: WebFailureCode };

export interface WebSearchPort {
  /** N6: an ask may carry its own deadline, so a slow weather or news read is not held to the short one. */
  search(request: { query: string; signal: AbortSignal; deadlineMs?: number }): Promise<WebOutcome>;
}

export interface WebSearchOptions {
  credentials: Credentials;
  keyReference?: string;
  model?: string;
  now?: () => number;
  transport?: typeof fetch;
  deadlineMs?: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Only the public query egresses. A question that carries an address, a long digit run, a pasted
 * passage or a whole spoken sentence is reported instead of sent.
 */
export function publicQueryOf(value: string): string | undefined {
  const query = value.replace(/\s+/g, ' ').trim();
  if (!query || query.length > WEB_QUERY_CHARS) return undefined;
  if (/@/.test(query)) return undefined;
  if (/\d{12,}/.test(query)) return undefined;
  if (/[<>{}]/.test(query)) return undefined;
  return query.split(' ').length > 24 ? undefined : query;
}

const httpURL = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname ? value : undefined;
  } catch { return undefined; }
};

const publishedOf = (web: Record<string, unknown>): string | undefined => {
  const raw = text(web['publishedAt']) ?? text(web['pubDate']);
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
};

/** Claims trimmed with their citations: a claim outside the spoken answer is dropped, and a source left with no claim goes with it. */
function capped(answer: string, sources: readonly WebSource[], claims: readonly WebClaim[]): { answer: string; sources: WebSource[]; claims: WebClaim[] } {
  const words = answer.split(/\s+/);
  const spoken = words.length > WEB_WORDS_CAP ? words.slice(0, WEB_WORDS_CAP).join(' ') : answer;
  const kept = claims.filter(claim => claim.sourceIndexes.length > 0 && spoken.includes(claim.text));
  const used = [...new Set(kept.flatMap(claim => claim.sourceIndexes))]
    .filter(index => sources[index] !== undefined).sort((a, b) => a - b).slice(0, WEB_SOURCE_CAP);
  const mapping = new Map(used.map((index, next) => [index, next]));
  return {
    answer: spoken,
    sources: used.map(index => sources[index]!),
    claims: kept.flatMap(claim => {
      const sourceIndexes = claim.sourceIndexes.flatMap(index => mapping.has(index) ? [mapping.get(index)!] : []);
      return sourceIndexes.length > 0 ? [{ text: claim.text, sourceIndexes }] : [];
    }),
  };
}

function grounded(body: unknown, retrievedAt: string): WebOutcome {
  const candidate = object(body) && Array.isArray(body['candidates']) && object(body['candidates'][0]) ? body['candidates'][0] : undefined;
  const content = candidate !== undefined && object(candidate['content']) ? candidate['content'] : undefined;
  const parts = content !== undefined && Array.isArray(content['parts']) ? content['parts'] : [];
  const answer = parts.flatMap(part => object(part) ? [text(part['text']) ?? ''] : []).join(' ').trim();
  const metadata = candidate !== undefined && object(candidate['groundingMetadata']) ? candidate['groundingMetadata'] : undefined;
  if (metadata === undefined) return { ok: false, code: 'web_ungrounded' };
  const chunks = Array.isArray(metadata['groundingChunks']) ? metadata['groundingChunks'] : [];
  const sources: WebSource[] = [];
  // A dropped chunk must never re-point a later citation, so every kept chunk remembers where it moved.
  const moved = new Map<number, number>();
  chunks.forEach((chunk, original) => {
    const web = object(chunk) && object(chunk['web']) ? chunk['web'] : undefined;
    if (web === undefined) return;
    const url = httpURL(text(web['uri']) ?? '');
    const title = text(web['title']);
    if (url === undefined || title === undefined) return;
    const publishedAt = publishedOf(web);
    moved.set(original, sources.length);
    sources.push(publishedAt === undefined ? { title, url } : { title, url, publishedAt });
  });
  const supports = Array.isArray(metadata['groundingSupports']) ? metadata['groundingSupports'] : [];
  const claims: WebClaim[] = [];
  for (const support of supports) {
    const segment = object(support) && object(support['segment']) ? support['segment'] : undefined;
    if (segment === undefined) continue;
    const claim = text(segment['text'])
      ?? (typeof segment['startIndex'] === 'number' && typeof segment['endIndex'] === 'number'
        ? answer.slice(segment['startIndex'] as number, segment['endIndex'] as number).trim()
        : undefined);
    const indexes = Array.isArray(support['groundingChunkIndices']) ? support['groundingChunkIndices'] : [];
    if (claim === undefined || claim.length === 0) continue;
    const sourceIndexes = indexes.flatMap(index => typeof index === 'number' && moved.has(index) ? [moved.get(index)!] : []);
    if (sourceIndexes.length === 0) continue;
    claims.push({ text: claim, sourceIndexes });
  }
  if (answer.length === 0 || sources.length === 0) return { ok: false, code: 'web_ungrounded' };
  const searchEntryPoint = text(metadata['searchEntryPoint'] && object(metadata['searchEntryPoint']) ? metadata['searchEntryPoint']['renderedContent'] : undefined);
  const trimmed = capped(answer, sources, claims);
  return {
    ok: true,
    evidence: {
      answer: trimmed.answer, claims: trimmed.claims, sources: trimmed.sources, retrievedAt,
      ...(searchEntryPoint === undefined ? {} : { searchEntryPoint }),
    },
  };
}

export function createWebSearch(options: WebSearchOptions): WebSearchPort {
  const now = options.now ?? Date.now;
  const transport = options.transport ?? fetch;
  const model = options.model ?? WEB_MODEL;
  const defaultDeadlineMs = options.deadlineMs ?? WEB_DEADLINE_MS;
  const keyReference = options.keyReference ?? 'gemini-primary';
  return {
    async search({ query, signal, deadlineMs }): Promise<WebOutcome> {
      const publicQuery = publicQueryOf(query);
      if (publicQuery === undefined) return { ok: false, code: 'web_private_question' };
      const key = await options.credentials.resolve(keyReference).catch(() => '');
      if (!key || /[\r\n]/.test(key)) return { ok: false, code: 'web_unavailable' };
      const cut = new AbortController();
      const timer = setTimeout(() => cut.abort(new Error('web_timeout')), deadlineMs ?? defaultDeadlineMs);
      timer.unref?.();
      const body = {
        systemInstruction: { parts: [{ text: attribution }] },
        contents: [{ role: 'user', parts: [{ text: publicQuery }] }],
        tools: [{ google_search: {} }],
        generationConfig: { candidateCount: 1, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } },
      };
      try {
        const response = await transport(`${origin}/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, cut.signal]),
        });
        if (response.status === 429) return { ok: false, code: 'web_rate_limited' };
        if (!response.ok) return { ok: false, code: 'web_unavailable' };
        return grounded(await response.json(), new Date(now()).toISOString());
      } catch {
        return { ok: false, code: cut.signal.aborted || signal.aborted ? 'web_timeout' : 'web_unavailable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The evidence lines Naya speaks from: the answer, each claim with its source titles, the retrieval time. Never a URL. */
export function webEvidenceText(evidence: WebEvidence): string {
  const titles = (indexes: readonly number[]): string => indexes.map(index => evidence.sources[index]?.title).filter(Boolean).join('; ');
  const lines = [`web answer: ${evidence.answer}`];
  for (const claim of evidence.claims) lines.push(`web claim: ${claim.text} [${titles(claim.sourceIndexes)}]`);
  const listed = evidence.sources.map((source, index) => `${index + 1}. ${source.title}${source.publishedAt === undefined ? '' : ` (${source.publishedAt})`}`);
  lines.push(`web sources: ${listed.join(' | ')}`);
  lines.push(`retrieved: ${evidence.retrievedAt}`);
  lines.push('the source links are on screen, so never read a link or a URL aloud');
  return lines.join('\n');
}

/** The transcript cards: title and link only, so the chat keeps the sources as links. */
export function webSourceCards(evidence: WebEvidence): { title: string; url: string }[] {
  return evidence.sources.map(source => ({ title: source.title, url: source.url }));
}

/**
 * Gemini's grounding attribution, honoured: the search entry point Google returns is markup, so only its
 * https links survive here, and they ride the transcript next to the sources. Never spoken.
 */
export function webAttribution(rendered: string | undefined): { title: string; url: string }[] {
  if (rendered === undefined) return [];
  const links: { title: string; url: string }[] = [];
  for (const match of rendered.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu)) {
    const url = httpURL(match[1]!);
    const title = (match[2] ?? '').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 96);
    if (url === undefined || !title || links.some(link => link.url === url)) continue;
    links.push({ title, url });
    if (links.length >= WEB_SOURCE_CAP) break;
  }
  return links;
}

/** One compact sources line of markdown links, which is what the chat's source cards are read from. */
export function webFooter(cards: readonly { title: string; url: string }[], attribution: readonly { title: string; url: string }[] = []): string {
  const label = (title: string): string => title.replace(/[\[\]]/g, '');
  return [...cards.slice(0, WEB_SOURCE_CAP), ...attribution.slice(0, WEB_SOURCE_CAP)]
    .map(card => `[${label(card.title)}](${card.url})`).join(' · ');
}
