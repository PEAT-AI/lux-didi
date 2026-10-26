import type { Credentials } from '../adapters/model/types.js';

/**
 * WEB-1021: one typed action, no provider abstraction. Gemini `gemini-3.8-flash` generateContent with
 * the `google_search` tool answers one public query and returns citation-linked evidence Naya speaks
 * from. The query is the only thing that egresses; claims ride with their sources and never a URL in
 * the spoken text.
 */
export const WEB_SEARCH_ACTION = 'web_search';
export const WEB_MODEL = 'gemini-3.8-flash';
/**
 * The council's hard deadline: the transport is cancelled at this point, never left running.
 * #670: 78 live grounded reads (2026-10-25) took 5.2 s median, 7.9 s p95, 10.3 s p99 and 11.5 s at worst,
 * and the headers arrive at 5.06 s, so an 8 s budget cut about one read in twenty. 12 s cut none of them.
 * R1 (owner order 2026-10-26): call 01c4bd89 lost a web read that finished at 10.1 s while the call answered at
 * 5.5 s, so the budget is 14 s now: it fits inside the research call's 15 s patience budget, with the read's own
 * outer cut one second past it, so this timer is still the one that fires and says timeout (#645).
 */
export const WEB_DEADLINE_MS = 14_000;

/** The one place the web budget is read, so the research row and this module cannot drift apart. */
export function webDeadlineMs(_query: string): number { return WEB_DEADLINE_MS; }
export const WEB_SOURCE_CAP = 5;
export const WEB_WORDS_CAP = 220;
export const WEB_QUERY_CHARS = 200;

const origin = 'https://generativelanguage.googleapis.com';
const attribution =
  'Answer in at most 220 words of plain sentences, using only what the search results support. '
  + 'Never write a URL, never greet the reader, never add a list of links.';

export type WebFailureCode = 'web_timeout' | 'web_unavailable' | 'web_rate_limited' | 'web_private_question';

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

export type WebInsufficientReason = 'empty' | 'ungrounded' | 'capped' | 'reply_budget';
export type WebOutcome = { ok: true; evidence: WebEvidence } | { ok: false; code: WebFailureCode }
  | { ok: false; code: 'web_insufficient'; reason: WebInsufficientReason };

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
/** Keep whole sentences only; an unfinished supported claim is not evidence. */
export function sentencePrefix(value: string, max: number): string {
  const prefix = value.slice(0, Math.max(0, max));
  const sentences = [...prefix.matchAll(/[.!?](?=\s|$)/gu)];
  const last = sentences.at(-1);
  return last?.index === undefined ? '' : prefix.slice(0, last.index + 1).trim();
}

const QUERY_FILLERS = /^(?:a|an|the|what|is|are|was|were|please|could|would|can|you|tell|me|find|search|for|about|of|in|on|at|to|and|latest|current|today|how|much|price|date|when|did|who)$/iu;
/** Drop fillers before bounding a query; never split a name or date token. */
export function broaderWebQuery(value: string, max = WEB_QUERY_CHARS): string {
  const tokens = value.replace(/[?!,]/gu, '').split(/\s+/u).filter(token => token && !QUERY_FILLERS.test(token));
  const priority = tokens.map((token, index) => ({ token, index, entity: /[A-Z0-9]/u.test(token) }));
  const kept = new Set<number>();
  let length = 0;
  for (const { token, index } of priority.sort((a, b) => Number(b.entity) - Number(a.entity))) {
    if (length + token.length + (kept.size ? 1 : 0) <= max) { kept.add(index); length += token.length + (kept.size > 1 ? 1 : 0); }
  }
  return tokens.filter((_token, index) => kept.has(index)).join(' ');
}

/** Shrink the web finding as evidence, never by popping its only multi-line result. */
export function clipWebEvidence(value: string, max: number): string | undefined {
  if (value.length <= max) return value;
  const lines = value.split('\n');
  const head = lines[0]?.startsWith('web answer:') ? '' : lines.shift()! + '\n';
  const sourceLine = lines.find(line => line.startsWith('web sources:'))?.split(' | ')[0];
  const claims = lines.filter(line => line.startsWith('web claim:'));
  if (!sourceLine || claims.length === 0) return undefined;
  const note = 'You may ask for the full result.';
  const first = claims[0]!.match(/^web claim: (.*) (\[[^\]]*\])$/u);
  if (!first) return undefined;
  const prefix = head + 'web answer: ';
  const suffix = ` ${first[2]}\n${sourceLine}\n${note}`;
  const room = Math.floor((max - prefix.length - '\nweb claim: '.length - suffix.length) / 2);
  const supported = sentencePrefix(first[1]!, room);
  if (supported) return `${prefix}${supported}\nweb claim: ${supported}${suffix}`;
  return undefined;
}

function capped(answer: string, sources: readonly WebSource[], claims: readonly WebClaim[]): { answer: string; sources: WebSource[]; claims: WebClaim[] } {
  const words = answer.split(/\s+/);
  const spoken = words.length > WEB_WORDS_CAP ? sentencePrefix(words.slice(0, WEB_WORDS_CAP).join(' '), answer.length) : answer;
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
  if (!answer) return { ok: false, code: 'web_insufficient', reason: 'empty' };
  if (metadata === undefined) return { ok: false, code: 'web_insufficient', reason: 'ungrounded' };
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
  if (answer.length === 0 || sources.length === 0) return { ok: false, code: 'web_insufficient', reason: 'ungrounded' };
  const searchEntryPoint = text(metadata['searchEntryPoint'] && object(metadata['searchEntryPoint']) ? metadata['searchEntryPoint']['renderedContent'] : undefined);
  const trimmed = capped(answer, sources, claims);
  if (trimmed.claims.length === 0 || trimmed.sources.length === 0) return { ok: false, code: 'web_insufficient', reason: 'capped' };
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
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (signal.aborted || cut.signal.aborted) return { ok: false, code: 'web_timeout' };
          const body = {
            systemInstruction: { parts: [{ text: attribution }] },
            contents: [{ role: 'user', parts: [{ text: attempt === 0 ? publicQuery : broaderWebQuery(publicQuery) }] }],
            tools: [{ google_search: {} }],
            generationConfig: { candidateCount: 1, maxOutputTokens: 1100, thinkingConfig: { thinkingLevel: 'low' } },
          };
          const response = await transport(`${origin}/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, cut.signal]),
          });
          if (response.status === 429) return { ok: false, code: 'web_rate_limited' };
          if (!response.ok) return { ok: false, code: 'web_unavailable' };
          const result = grounded(await response.json(), new Date(now()).toISOString());
          if (result.ok || result.code !== 'web_insufficient' || attempt === 1) return result;
        }
        return { ok: false, code: 'web_insufficient', reason: 'empty' };
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
  lines.push('The source links are on screen; never read a link or a URL aloud. You may ask for the full result.');
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
