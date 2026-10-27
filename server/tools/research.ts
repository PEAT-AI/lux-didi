import type { HostEvidenceRef } from './types.js';
import { HISTORY_IDENTITY, HISTORY_PARAMETERS, validateHistory } from './history.js';
import type { HistoryArguments } from '../domain/history-reader.js';
import { fold, tokenize } from '../domain/util.js';
import { calendarRange } from './calendar-window.js';
import { randomUUID } from 'node:crypto';
import type { ToolResultBinding, JsonObject } from '../adapters/model/types.js';
import type { CalendarEvent as RetainedCalendarEvent, CalendarScope, MailMessage } from './live-shape.js';
import { INTERNAL, calendarIds, type IntentSubCall, type IntentSubResult } from './intent.js';
import { chatAsk, chatIntent, chatSubs } from './chat-intent.js';
import { bindPerson, peopleSnapshot } from '../people/index.js';
import { MAIL_QUERY_OPERATORS } from '../contracts/mail-operators.js';
import { hostLogEvent, liveToolStep, stepSubject, type LiveToolStepBody } from './host-events.js';
import { WEB_DEADLINE_MS, WEB_SEARCH_ACTION, broaderWebQuery, clipWebEvidence, sentencePrefix, webAttribution, webDeadlineMs, webEvidenceText, webFooter, webSourceCards, type WebOutcome, type WebSearchPort } from './web-search.js';

/**
 * The one declared Live read tool (#241). The model may answer with no tool at all; when it looks
 * something up it calls `research` once and the host runs a bounded, value-of-information loop:
 * a host-built closed candidate set, a same-provider selector round, and a stop rule that spends
 * one more read only while it is worth the wait. O1's five intent tools are the internal actions
 * this loop fans out over; they are never declared to the model.
 */
export const RESEARCH_TOOL_NAME = 'research';

export type ResearchAction = 'start' | 'continue' | 'stop';
export type QuestionClass = 'quick_fact' | 'cross_source' | 'explicit_continue';
export type SourceKind = 'memory' | 'knowledge' | 'calendar' | 'mail' | 'chat' | 'mongoose' | 'data' | 'web' | 'drive';
export type CandidateKind =
  | 'knowledge_search' | 'calendar_window' | 'mail_search' | 'mail_open'
  | 'chat_search' | 'chat_thread' | 'company_search' | 'company_metric' | 'web_search' | 'drive_search' | 'brief' | 'stop_answer' | 'stop_insufficient';

/** The closed candidate set. A candidate reads exactly one internal action; nothing is invented. */
export interface Candidate {
  kind: CandidateKind;
  source: SourceKind | null;
  /** A prerequisite candidate must have completed before this one may be chosen. */
  requires?: CandidateKind;
}

export const CANDIDATES: readonly Candidate[] = Object.freeze([
  { kind: 'knowledge_search', source: 'knowledge' },
  { kind: 'calendar_window', source: 'calendar' },
  { kind: 'mail_search', source: 'mail' },
  { kind: 'mail_open', source: 'mail', requires: 'mail_search' },
  { kind: 'chat_search', source: 'chat' },
  { kind: 'chat_thread', source: 'chat', requires: 'chat_search' },
  // #639: the company read is one candidate, so a company ask reads Mongoose in the same loop as the rest.
  { kind: 'company_search', source: 'mongoose' },
  // W3-R1: a number question is its own candidate. Its read is the data endpoint's field search and
  // then one metric query, so a count never rides on a knowledge search.
  { kind: 'company_metric', source: 'data' },
  { kind: 'web_search', source: 'web' },
  // C-OPEN 2: the owner's Drive files by name, offered only when a Drive endpoint is configured.
  { kind: 'drive_search', source: 'drive' },
  { kind: 'brief', source: null },
  { kind: 'stop_answer', source: null },
  { kind: 'stop_insufficient', source: null },
]);

/** LAT-1023: the round cap, shared by every run kind so a continuation never buys a third round. */
const ROUND_CAP_ROUNDS = 2;

/** #581: the number of mail lines one reply shows, and so the number a read must collect before it pages again. */
const MAIL_LINES_SHOWN = 8;

/** Every constant of the loop lives in this one exported object, the calibration record's basis. */
export const RESEARCH = Object.freeze({
  tool: RESEARCH_TOOL_NAME,
  /** E7: one live turn window. A start that repeats a question answered inside it joins that run. */
  coalesceWindowMs: 60_000,
  startDeadlineMs: 15_000,
  continueDeadlineMs: 30_000,
  /**
   * LAT-1023: one run reads in at most two tool-bearing rounds, the parallel first round plus one
   * continuation round, and then composes its answer from what it holds. A third round is what made an
   * owner's ask wait 26 s for his own mail while the context grew to 44k tokens.
   */
  startRounds: ROUND_CAP_ROUNDS,
  continueRounds: ROUND_CAP_ROUNDS,
  maxOps: 8,
  maxConcurrent: 4,
  /**
   * F2: one question reads at most this many pages of one mail query, and a rate-limited page waits this
   * long before its single retry. Four pages is 100 messages at the 25 page size the connector serves.
   */
  mailPageCap: 4,
  rateLimitRetryMs: 1_000,
  /** Dead air: the longest the model may wait without a progress line, whatever the run is doing. */
  progressEveryMs: 3_000,
  /**
   * R6: the first answer point. A call answers while its reads are still running, at this many ms after it
   * started, as long as one source has findings by then. The readers still working are never cut for it:
   * they keep going to their own deadlines and each one that settles later is reported once.
   */
  firstAnswerMs: 4_500,
  /** R6: how many late lines one source may hand the host, so a block stays short and speakable. */
  lateItems: 6,
  /**
   * P5: the time each source really needs. One 4 s cut for every source equalled the chat connector's
   * own latency: Mattermost answered at 3,803 ms and was cut at 4,001 ms in the same call, and the
   * first calendar read took 4.4 s. P5-R1 is the owner's order that depth beats speed: every connector
   * read (knowledge, company, chat, calendar, mail) gets 12 s, and the in-process memory read 8 s.
   * This is the single table every per-source bound reads.
   * #655: the web row reads the web module's own constant, so the row that reports the budget and the
   * timer that cuts the read cannot disagree again; the derivation is written at that constant.
   * #635: the chat read is its own row instead of the connector's 12 s, and a read cut here returns what
   * arrived as a partial timeout and says so in the header and the voice.
   * #645: that row was 6 s, under the 5 to 12 s a real chat read takes on this host (release 10 and 11
   * evals), so 27 of 30 chat reads were cut at 6 s with nothing arrived. It is 10 s: above the real read,
   * above the 4.5 s plus 0.5 s the session releases at, and under the 12 s connector timeout, so a cut is
   * the exception and a late chat finding still lands the way mail's 12 s does.
   */
  sourceDeadline: Object.freeze({
    memory: 8_000, knowledge: 12_000, calendar: 12_000, mail: 12_000, chat: 10_000, mongoose: 12_000, data: 12_000, web: WEB_DEADLINE_MS, drive: 12_000,
  } as Record<SourceKind, number>),
  /** P5: a candidate that names no single source (`brief`) never gets less than the local reads. */
  defaultSourceDeadlineMs: 8_000,
  /**
   * P5-R1: the whole research call is the slowest source it reads plus this slack, and never more than
   * the cap, so a call cannot hang on a source that never answers and cannot outlast what it reads.
   */
  answerSlackMs: 2_000,
  /** #670: the read's outer cut, this far above a web ask's own budget, so a cut web read says timeout. */
  webCutSlackMs: 1_000,
  /**
   * P5-R5 (F4): the cap is a guard, not a bound in force: with the largest table row at 12 s the budget
   * tops out at 14 s, and a start call's ledger deadline is the older `startDeadlineMs` 15 s, which the
   * budget nests inside. A future row would need both numbers raised together.
   */
  answerCapMs: 20_000,
  /** Selector wall time charged to the value-of-information decision, in seconds. */
  tSelSeconds: 1.0,
  /** Seconds of owner patience one useful answer class is worth. */
  value: Object.freeze({ quick_fact: 8, cross_source: 16, explicit_continue: 30 } as Record<QuestionClass, number>),
  /** Median seconds per source, from the release-3a wire facts. K8: her own knowledge reads measured p50
   * 1,425 ms inside a 1,531 ms dispatch, so the old 2.2 understated the dead-air ladder's cost. */
  p50Seconds: Object.freeze({ knowledge: 2.9, chat: 3.6, calendar: 4.7, gmail: 10.0 } as Record<'knowledge' | 'chat' | 'calendar' | 'gmail', number>),
  /** Selector cost multiplier by elapsed seconds: cheap early, expensive late. */
  lambda: Object.freeze([{ upToMs: 4_000, value: 0 }, { upToMs: 8_000, value: 0.5 }, { upToMs: Number.POSITIVE_INFINITY, value: 1.5 }]),
  /**
   * C-DEPTH item 1 (council decision-how-much-retrieved-evidence-a-r-bd8a, owner order 2026-10-25): the whole
   * answer a Live model receives, envelope included, is at most one of three chars. LAT-1023 caps the answer
   * because a call grew from 15k to 44k tokens in 3.5 minutes on 6,000 char replies; the owner asked for depth
   * over tokens, so the tiers replace one flat cap and item 5 rebuilds the session when the sum over a call is
   * large. The full bodies stay readable inside the run through their cursors; Live hears the answer.
   * #634: the coverage header counts inside the same cap, so the prose shrinks by the header's length and
   * the whole answer the voice receives stays under one bound.
   */
  budgets: Object.freeze({ default: 12_000, analytical: 16_000, depth: 20_000 }),
  /** C-DEPTH item 2: the header and metadata share of a budget, trimmed before any evidence is. */
  envelopeShareChars: 1_000,
  /** C-DEPTH item 2: the substantive evidence one non-empty source keeps before the remainder is shared. */
  sourceFloorChars: 1_000,
  /** C-DEPTH item 5: the extractive ledger that replaces the raw tool items on a rebuild, at most this long. */
  ledgerChars: 6_000,
  /** C-DEPTH item 5: the retained research payload this call may hold before a rebuild is due. */
  rebuildThresholdChars: 24_000,
  /**
   * LAT-1023 ruling R1: a body the owner asked to read keeps its own page bound. The compaction targets
   * composed answers; paging a requested 16,800-char body at the Live budget would double the round trips
   * this release exists to cut, so a body page is sized by this and the answer text never is.
   */
  bodyLimitChars: 6_000,
  /** Hard cap on a selector-authored query, and the per-source reply bounds. */
  queryLimitChars: 200,
  mailLines: 8, chatLines: 8, knowledgeLines: 40,
  /**
   * E8: ask for the whole reply-worthy page in one call, so no loop pages a window or a query at a time.
   * 50 is the connector's own ceiling (GOOGLE_DEFAULTS.maxListResults); asking more is refused outright.
   */
  pageResults: Object.freeze({ calendar: 50, mail: 25 }),
  /**
   * P5-R1: a knowledge lookup keeps the body the connector sends instead of forty snippets that cut
   * the evidence short. 3r K1: six hits, because each hit now carries a bounded body rather than a
   * 400-character excerpt. `knowledgeLines` stays the reply's per-source line bound: it caps what the
   * answer shows, never what the search may return.
   */
  knowledgeHits: 6,
  /**
   * 3r K1: a voice lookup asks for a bounded stored body with a deadline instead of snippets, so a hit
   * arrives as text the owner can be read without a get_insight round trip. The cap is the server's
   * default body window; a hit the server cut at it says so in the reply line.
   * MED-1022: the connector's `voice` shape answers the best hit at `max_chars` and names the rest at
   * `snippet_chars`, which is one body plus five leads instead of six half-filled panes.
   */
  knowledgeDetail: 'voice' as const,
  knowledgeSnippetChars: 300,
  knowledgeDeadlineMs: 8_000,
  /**
   * K3: the selector writes keywords, and a long string costs ranker score, so the query is clipped.
   * MED-1022: five terms dropped the person and the topic behind the filler, so the knowledge budget is
   * ten, and filler is dropped before the budget is counted.
   */
  knowledgeQueryTerms: 10,
  /**
   * K2: a search snippet stays short, and the body a hit is opened for is shown at three thousand
   * characters: a quarter of the corpus is longer than the old 1,200 window, and the read is cheap.
   */
  knowledgeBodyChars: 2_000,
  /**
   * C-DEPTH item 3 (W10-R7): the second stage. The search answers with summaries; the host then fetches the
   * full bodies of this many hits, the ones naming the owner's people or documents first, in one batched read
   * inside the round already dispatched and inside the operation deadline.
   */
  knowledgeReadEntries: 3,
  /** C-DEPTH item 3: the time one stage two read may take, so the operation deadline is never eaten by it. */
  knowledgeReadMs: 1_500,
  /** R5 (RESCAP-R5): the fewest characters of an evidence line worth keeping when it is clipped to fit. */
  clipFloorChars: 60,
  /** ROUTE-1022 (#526): the search reply carries the body, so no id is opened in a second hop. */
  knowledgeOpenIds: 0,
  /** ROUTE-1022 (#526): what a reply tells the model in plain words, so it never re-asks, and a cut run names its readers. */
  completeNote: 'Nothing more to fetch for this question.',
  /** R4: a source still reading is still searching; the reply never calls it a timeout while it is arriving. */
  stillReadingNote: 'Still searching: ',
  /** R3/R4: a source the hard stop left behind did not return in time, which is what the reply says. */
  hardStopNote: 'Did not return in time: ',
  /** R2: the one short line an owner hears at 10 s while a research call is still reading. */
  stillSearchingLine: 'Still searching, one moment.',
  /**
   * LAT-1023: one short clause, so an answer that ran out of rounds or of room never reads as a whole
   * record and never lets the model claim a record does not exist.
   */
  moreAvailableNote: 'Partial: answer now, offer the rest; read on only if asked.',
  /**
   * Q5-R1: an explicit read by id is answered with the entry's whole body, and the connector's own
   * knowledge body cap is 20,000 chars, so that reply is sized for the body instead of the search
   * budget, which would drop the very text the owner asked for.
   */
  readReplyChars: 24_000,
  /** K6: how many memory lines one routed memory lookup may show. */
  memoryLines: 12,
  mailSnippetChars: 200, chatTextChars: 300, openedBodyChars: 1_500,
  /**
   * #663: the receipt a second identical start gets inside the turn window. The model is handed the answer
   * it already has, never the same findings twice, so a backend loop cannot spend a turn on one lookup.
   */
  repeatNote: 'You already have this answer; give it to the owner now.',
  /**
   * #664: how many research calls one delegation may make. The backend re-asked one lookup eight times in
   * 14 seconds, so the fourth call is told to answer from what it holds instead of reading again.
   */
  delegationCeiling: 3,
  ceilingNote: 'Answer the owner with what you have.',
  /** #663: a web part that failed or timed out leaves the model its own knowledge, and the reply says so. */
  generalKnowledgeNote: 'Anything you add about it yourself is general knowledge, so say so.',
});

export const RESEARCH_SOURCES: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose', 'data', 'web'];

/**
 * K6: the layers a routed start may name. `company` is the Mongoose organisation read and `replies`
 * is the Mattermost attention digest; `memory` is her own remembered conversations, read locally.
 */
export type LookupSource = 'memory' | 'knowledge' | 'company' | 'data' | 'calendar' | 'mail' | 'chat' | 'replies' | 'drive' | 'web';
export const LOOKUP_SOURCES: readonly LookupSource[] = ['memory', 'knowledge', 'company', 'data', 'calendar', 'mail', 'chat', 'replies', 'drive', 'web'];
/** At most four lookups per call; duplicates collapse, so one call is one short, wide read. */
export const MAX_LOOKUPS = 4;

/**
 * RESEARCHFIX-R1: the lookup limit and the allowed keys are stated once, and the number comes from the
 * constant, so the declaration, the repair text and the refusal can never drift apart.
 */
const LOOKUP_LIMIT_TEXT = `at most ${MAX_LOOKUPS} lookups, each with source (${LOOKUP_SOURCES.slice(0, -1).join(', ')} or ${LOOKUP_SOURCES[LOOKUP_SOURCES.length - 1]}) plus one of query, mail or history`;

export type MailLookup = { id: string; format?: 'full' | 'metadata' } | { q: string; maxResults?: number };
export interface ResearchLookup { source: LookupSource; query: string; history?: HistoryArguments; mail?: MailLookup }
/**
 * Per-source outcome of a routed call: read something, read nothing, unreachable, the read failed, or
 * the read was cut short by a deadline. `timeout` is its own value because a cut read is not an empty
 * one: the audit found aborted knowledge reads reported as `empty` and voiced as "nothing matched".
 */
export type LookupOutcome = 'ok' | 'empty' | 'unavailable' | 'failed' | 'timeout';

export interface ResearchRoutedLog {
  event: 'research_routed'; researchId: string; sources: LookupSource[]; lookups: number; callKey?: string;
  ms: number[]; outcomes: LookupOutcome[];
}

/**
 * P5: one receipt per source read: which layer, what became of it, how long it took, and the deadline it
 * was given. Never a query. The deadline travels with the receipt so a cut read can be judged against the
 * time the source was actually allowed.
 */
/** L8-Q07: the closed reasons a source receipt may give for a read that did not answer. */
export const RESEARCH_SOURCE_REASONS = ['no_query', 'never_ran', 'timed_out', 'not_connected', 'not_configured', 'grant_missing', 'provider_failed', 'skipped_by_route', 'channel_not_found', 'still_reading', 'needs_clarification', 'name_not_found', 'count_needs_date_window'] as const;
export type ResearchSourceReason = (typeof RESEARCH_SOURCE_REASONS)[number];

function sourceReasonOf(run: RunState, outcome: { source: SourceKind | 'memory'; outcome: LookupOutcome; mail?: MailQueryInfo | undefined }): ResearchSourceReason {
  if (outcome.mail !== undefined && mailQueryShape(outcome.mail.q).terms === 0) return 'no_query';
  if (outcome.source !== 'memory' && run.neverRan?.has(outcome.source) === true) return 'never_ran';
  if (outcome.outcome === 'timeout') return 'timed_out';
  const code = outcome.source === 'memory' ? undefined : run.unavailableReasons.get(outcome.source);
  return code === undefined ? 'provider_failed' : unsearchedReasonOf(code);
}

export interface ResearchSourceLog {
  event: 'research_source'; researchId: string; source: LookupSource; outcome: LookupOutcome; ms: number;
  /** ROUTE-1022 K5: the same plan token, so a per-source receipt shows a knowledge-only brief too. */
  plan?: 'knowledge_only' | 'named_sources';
  deadlineMs: number;
  /** 3r R1: how many lookups of this call shared the one source execution this receipt describes. */
  coalesced: number;
  /** L8-Q07: why a read did not answer, a closed token; absent on ok and empty. */
  reason?: ResearchSourceReason;
  /** 3r K1: the knowledge lookup's bounded-body request, metadata only and never a query. */
  knowledge?: { detail: string; maxChars: number; deadlineMs: number; truncated: boolean; queryTerms: number; dayFilter: DayFilter; chatDateOperator: ChatDateOperator; deduped: number };
  /** #610: the chat read's shape, or R3: the closed reason a refused chat read records. Never a word. */
  chat?: ChatReceipt;
  /** E5: the mail search's shape, and the one broader retry's shape when it ran. Counts, never words. */
  mail?: MailQueryShape & { retried?: MailQueryShape };
  /** Release 4: a read that delivered its pages but lost a later one, and how many pages it lost. */
  partial?: MailPartialReason;
  failedPages?: number;
}

/** Release 4: the closed reasons a source result carries a partial marker. */
export const MAIL_PARTIAL_REASONS = ['pages_failed'] as const;
export type MailPartialReason = typeof MAIL_PARTIAL_REASONS[number];

/** A source that cannot serve a read right now, with the reason its connector gave. */
export interface UnavailableSource { source: SourceKind; reason: string }

/** The endpoint report fields an unreachable source name may read: closed codes only. */
export interface ConfiguredEndpointStatus {
  id?: string; connector: string; state: string; reasonCode?: string; configurationError?: string; exception?: { code: string };
}

/** A routed lookup list, parsed defensively: unknown sources and empty queries are dropped. */
/**
 * C-DEPTH item 1: the owner asking to go deep is the owner ordering the long answer, and a comparison or a
 * synthesis across sources is the analytical tier. Everything else is the default tier.
 */
const DEEP_TIER_ASK = /\b(?:go deep|in depth|deep dive|in detail|every detail|all the detail|everything|the full (?:entries|bodies|detail)|all of it|thorough|thoroughly)\b/iu;
const ANALYTICAL_ASK = /\b(?:compare|comparison|versus|vs|difference between|implications|synthes\w*|analyse|analyze|analysis|team implications)\b/iu;
/** Words that open a sentence or a clause, never a requested person or document. */
const ENTITY_STOP = new Set(['The', 'What', 'Who', 'When', 'Where', 'Which', 'Why', 'How', 'Does', 'Did', 'Can', 'Could', 'Would', 'Should', 'Tell', 'Show', 'Give', 'Please', 'And', 'But', 'For', 'Any', 'All', 'Is', 'Are', 'Was', 'Were', 'Do', 'Has', 'Have', 'Summarise', 'Summarize', 'Also', 'Then', 'Now']);
const QUOTED_ENTITY = /"([^"]{2,80})"/gu;
const CAPITALISED_ENTITY = /\b([A-Z][a-z]{1,}[\w'-]*)\b/gu;
/** An ask that refers to a past conversation may use her memory even when it names someone. */
const PAST_CONVERSATION = /\b(?:last time|last we|we said|we discussed|we talked|what did we|did we say|earlier we|remember when)\b/iu;

export function pastConversationAsk(question: string): boolean { return PAST_CONVERSATION.test(question); }

/**
 * C-DEPTH item 2: the people and documents the owner named, read off the question itself. Deterministic, so
 * the allocator and the ledger agree without a model call, and a confidence line can never stand in for one.
 */
export function requestedEntities(question: string): string[] {
  const found: string[] = [];
  const push = (entity: string): void => {
    const clean = entity.trim();
    if (clean.length > 1 && !found.includes(clean)) found.push(clean);
  };
  for (const quoted of question.matchAll(QUOTED_ENTITY)) push(quoted[1] ?? '');
  for (const match of question.matchAll(CAPITALISED_ENTITY)) {
    const at = match.index ?? 0;
    if (at === 0) continue;
    if (ENTITY_STOP.has(match[1] ?? '')) continue;
    if (/[.!?]\s+$/u.test(question.slice(0, at))) continue;
    push(match[1] ?? '');
  }
  return found;
}

/** C-DEPTH item 1: the tier an owner question asks for, classified before the run reads anything. */
export function budgetFor(question: string, topic?: string): number {
  const asked = topic === undefined ? question : `${question} ${topic}`;
  if (DEEP_TIER_ASK.test(asked)) return RESEARCH.budgets.depth;
  if (ANALYTICAL_ASK.test(asked)) return RESEARCH.budgets.analytical;
  if (requestedEntities(question).length > 0) return RESEARCH.budgets.analytical;
  return RESEARCH.budgets.default;
}

/** C-DEPTH item 1: classification may raise a budget during retrieval and never lower it. */
export function raiseBudget(current: number, question: string, topic?: string): number {
  return Math.max(current, budgetFor(question, topic));
}

export function normalizeLookups(value: unknown): ResearchLookup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const lookups: ResearchLookup[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const raw = typeof entry['source'] === 'string' ? entry['source'].trim().toLowerCase() : '';
    if (raw === 'memory' && isRecord(entry['history']) && validateHistory(entry['history'])) {
      const history = entry['history'] as HistoryArguments, key = JSON.stringify(history);
      if (!seen.has(key)) { seen.add(key); lookups.push({ source: 'memory', query: typeof history.query === 'string' ? history.query : '', history }); }
      if (lookups.length === MAX_LOOKUPS) break;
      continue;
    }
    if (raw === 'mail' && validMailLookup(entry['mail'])) {
      const mail = entry['mail'] as MailLookup, key = `mail:${JSON.stringify(mail)}`;
      if (!seen.has(key)) { seen.add(key); lookups.push({ source: 'mail', query: 'q' in mail ? mail.q : '', mail }); }
      if (lookups.length === MAX_LOOKUPS) break;
      continue;
    }
    const text = optionalString(entry['query']);
    if (text === undefined || !(LOOKUP_SOURCES as readonly string[]).includes(raw)) continue;
    const query = text.trim().slice(0, RESEARCH.queryLimitChars);
    const key = `${raw}:${query.toLowerCase()}`;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    lookups.push({ source: raw as LookupSource, query });
    if (lookups.length === MAX_LOOKUPS) break;
  }
  return lookups;
}

/** #675: the one inbox scan a status mail check reads, the same bare scan the mail route uses. */
const STATUS_MAIL_SCAN = 'in:inbox newer_than:2d';

/**
 * #657 item 1: the lookups a status or test-all ask reads, one batch of MAX_LOOKUPS sources at a time.
 * A lookup the model wrote for a source in this batch is kept as it is, the sources it left out are
 * filled in by the host, and the rest stay on the run so the next call reads them instead of the ask
 * being refused whole.
 */
function toolBatch(run: RunState, configured: readonly SourceKind[], given: readonly ResearchLookup[]): ResearchLookup[] {
  const rest = [...(run.deferredSources ?? configured.filter(source => source !== 'memory'))];
  const batch: ResearchLookup[] = [];
  for (const lookup of given) {
    const source = (lookup.source === 'company' ? 'mongoose' : lookup.source) as SourceKind;
    if (batch.length >= MAX_LOOKUPS || !rest.includes(source)) continue;
    rest.splice(rest.indexOf(source), 1);
    batch.push(lookup);
  }
  // A status ask asks about the tools, so the host's own read carries no search words.
  while (batch.length < MAX_LOOKUPS && rest.length > 0) batch.push({ source: lookupSourceOf(rest.shift()!), query: '' });
  run.deferredSources = rest;
  return batch;
}

/**
 * #675: the status probe set, used only on a status ask and only for the read shape. A status ask asks
 * whether a source answers, so each read takes the shape that source's own ask takes: her words for the
 * text reads, today's window for the calendar, because the routed calendar plan refuses an unnamed
 * window (routedRead, `window_unparsed`) while the calendar's own read defaults to today (candidateSubs,
 * calendar_window), and one inbox page for mail, never a topic scan (#657 item 2). The batch and what it
 * defers stay the host's own, so a probe never reshapes which sources one call reads.
 */
function statusProbeOf(lookup: ResearchLookup, question: string): ResearchLookup {
  const source = (lookup.source === 'company' ? 'mongoose' : lookup.source) as SourceKind;
  if (source === 'calendar') return { source: lookup.source, query: 'today' };
  if (source === 'mail') return { source: lookup.source, query: STATUS_MAIL_SCAN, mail: { q: STATUS_MAIL_SCAN } };
  return { source: lookup.source, query: source === 'memory' ? lookup.query : question };
}

/** The declared calendar window grammar; the resolver accepts these forms and refuses every other one. */
const CALENDAR_WINDOW = /^(?:today|tomorrow|week|this week|next week|(?:next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?: this week)?|\d{4}-\d{2}-\d{2})$/u;

/** #5: the same grammar found anywhere in the owner's sentence, longest form first, never a bare
 *  `week` on its own, since "the week after next" names no window this grammar can read. */
/** #5: a window or date word that is present but not in the grammar, so it is unparsed, never today. */
const CALENDAR_WINDOW_WORD = /\b(?:week|weeks|month|months|weekend|year|after next)\b/u;
const CALENDAR_WINDOW_IN_TEXT = /\b(?:next week|this week|today|tomorrow|(?:next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?: this week)?|\d{4}-\d{2}-\d{2})\b/gu;

/**
 * #5: recognize only explicit supported calendar grammar, read out of the owner's own sentence. Two
 * window words in one sentence name no single window, and a sentence with none returns the fallback,
 * so a caller that needs today asks for it and a read never silently widens to today.
 */
export function calendarWindowOf(query: string, fallback = ''): string {
  const value = query.trim().toLowerCase().replace(/[?.!]+$/, '').replace(/^(?:what is on|what's on|show me|what meetings do i have) /, '').replace(/^(?:my )?(?:meetings|events|calendar|schedule)(?: on| for)?(?: |$)/, '');
  if (CALENDAR_WINDOW.test(value)) return value;
  const found = [...new Set([...value.matchAll(CALENDAR_WINDOW_IN_TEXT)].map(match => match[0]))];
  if (found.length === 0) {
    // #5: a date or window word the grammar cannot resolve ("the week after next") is unparsed, not
    // today; only a sentence that names no window at all takes the caller's fallback.
    return CALENDAR_WINDOW_WORD.test(value) ? '' : fallback;
  }
  return found.length === 1 ? found[0]! : '';
}

/**
 * The closed code for a sub-call that never dispatched. The dispatch record's reason is already a
 * code for the machine paths; a free-text argument-shape guidance collapses to `invalid_arguments`,
 * so a refused sub-call is never logged as a bare failure.
 */
export function refusalCode(reason: string): string {
  if (reason === 'unknown_tool' || reason === 'duplicate_call_id' || reason === 'grant_not_permitted'
    || reason === 'stale_or_revoked_authority' || reason === 'round_deadline' || reason === 'round_cancelled') return reason;
  return reason.startsWith('Invalid arguments for ') ? 'invalid_arguments' : 'refused';
}

/** The p50 of a source kind, in seconds; a source with no table entry uses the slowest configured. */
export function p50SecondsOf(source: SourceKind): number {
  if (source === 'knowledge' || source === 'chat' || source === 'calendar') return RESEARCH.p50Seconds[source];
  if (source === 'mail') return RESEARCH.p50Seconds.gmail;
  return RESEARCH.p50Seconds.gmail;
}

/** P5: the lookup layer a source kind reports as, so a receipt and a routed reply name the same layer. */
export function lookupSourceOf(source: SourceKind): LookupSource {
  return source === 'mongoose' ? 'company' : source;
}

export function lambdaAt(elapsedMs: number): number {
  for (const band of RESEARCH.lambda) if (elapsedMs <= band.upToMs) return band.value;
  return 1.5;
}

/**
 * P5: the longest one read may run, from the per-source table. A read that fans out over several
 * sources (`brief`) gets the slowest source it touches, never a sum: they run in parallel.
 */
export function sourceDeadlineMs(sources: readonly SourceKind[]): number {
  if (sources.length === 0) return RESEARCH.defaultSourceDeadlineMs;
  return Math.max(...sources.map(source => RESEARCH.sourceDeadline[source]));
}

/**
 * P5-R1: the whole research call, as the owner ordered it: the slowest source the call reads plus two
 * seconds, capped at 20 s. A call of local reads is short, and a call that reads nothing slow is never
 * given a slow source's budget. R1: no call's answer budget is wider than the patience budget itself.
 */
export function researchCallBudgetMs(sources: readonly SourceKind[]): number {
  return Math.min(RESEARCH.answerCapMs, RESEARCH_OPERATION.deadlineMs, sourceDeadlineMs(sources) + RESEARCH.answerSlackMs);
}

/** pUseful(S) = 1 - product(1 - p_a) over the chosen actions. */
export function pUsefulOf(ps: readonly number[]): number {
  return 1 - ps.reduce((remaining, p) => remaining * (1 - Math.min(1, Math.max(0, p))), 1);
}

export interface WorthInput {
  pUseful: number;
  questionClass: QuestionClass;
  elapsedMs: number;
  /** The slowest p50 in the subset S, in milliseconds. */
  subsetP50Ms: number;
  deadlineMs: number;
  tSelMs?: number;
}

/** Argon round 3 stop rule, in seconds exactly as specified. */
export function worthContinuing(input: WorthInput): boolean {
  const tSel = (input.tSelMs ?? RESEARCH.tSelSeconds * 1_000) / 1_000;
  const gain = input.pUseful * RESEARCH.value[input.questionClass];
  const cost = (1 + lambdaAt(input.elapsedMs)) * (tSel + input.subsetP50Ms / 1_000);
  const inTime = input.elapsedMs + tSel * 1_000 + input.subsetP50Ms <= input.deadlineMs;
  return gain > cost && inTime;
}

// ---------------------------------------------------------------------------------------------
// Selector


export interface SelectorAction {
  kind: CandidateKind;
  requirement?: string;
  /** The query the selector authored for this search action, validated and length-capped. */
  query?: string;
  /** Calendar only: the window the selector asked for. */
  window?: string;
}

export interface SelectorOutput {
  questionClass: QuestionClass;
  actions: SelectorAction[];
  pUseful: Partial<Record<CandidateKind, number>>;
}

// ---------------------------------------------------------------------------------------------
// Candidate planning

const STOP_WORDS = new Set(['a', 'an', 'and', 'any', 'anything', 'are', 'around', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'check', 'could', 'did', 'do', 'does', 'find', 'for', 'from', 'get', 'give', 'had', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'just', 'know', 'latest', 'like', 'look', 'me', 'more', 'most', 'my', 'need', 'new', 'newest', 'of', 'on', 'or', 'our', 'out', 'over', 'please', 'said', 'say', 'search', 'see', 'show', 'so', 'some', 'tell', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'want', 'was', 'we', 'were', 'what', 'whats', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'anything', 'calendar', 'chat', 'email', 'emails', 'gmail', 'important', 'inbox', 'knowledge', 'mail', 'mattermost', 'messages', 'notes', 'recent', 'slack', 'something', 'team', 'things', 'today', 'tomorrow', 'unread', 'urgent', 'yesterday', 'week', 'month', 'day',
  // ROUTE-1022 K7: instruction words the model writes into a query; never content in this product.
  'wait', 'continue', 'verify', 'verified', 'findings', 'finding', 'exact', 'reliable', 'specific', 'detailed', 'lookup', 'lookups', 'searching', 'requested',
  // #617: the action and depth words of an ask are how she should answer, never what to search for.
  'write', 'writes', 'draft', 'formulate', 'deeper', 'detail', 'summary', 'summaries', 'summarize', 'summarise']);
/**
 * Release 4: the words a continuation hop writes about its own search, never about the owner's question.
 * They are filler to every source, so no hop spends a search term on them.
 */
const META_WORDS = new Set(['remaining', 'remain', 'remains', 'metadata', 'meta', 'business-relevant',
  'other', 'others', 'through', 'retain', 'retained', 'retaining', 'earlier', 'action-needed']);
/**
 * #654: a continuation or a status word describes the call, never a thing a source holds, so it is
 * never a mail, chat or knowledge term even when it arrives as the model's own query.
 */
const CONTINUATION_WORDS = new Set(['continue', 'continuation', 'finish', 'finished', 'read', 'reading', 'result', 'results', 'remainder', 'status', 'complete', 'completed', 'alive', 'working']);
const WORD_SHAPE = /[^a-z0-9@._:-]+/g;

/** The content keywords of a spoken question: stop words and filler removed, 3 to 8 of them. */
export function contentKeywords(question: string, max = 8, skip?: ReadonlySet<string>): string[] {
  const words = question.toLowerCase().replace(WORD_SHAPE, ' ').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    // K7: a spoken question's punctuation is not a word, so `findings.` is the filler `findings`.
    const bare = word.replace(/\.+$/u, '');
    if (STOP_WORDS.has(bare) || META_WORDS.has(bare) || bare.length < 3 || kept.includes(bare) || (skip?.has(bare) ?? false)) continue;
    kept.push(bare);
    if (kept.length >= max) break;
  }
  return kept;
}

/**
 * MED-1022: words that carry no meaning to a ranker. The owner's first search spent four of five terms
 * on them ("lux meeting transcript results about"), so a knowledge query drops them before the budget
 * is counted. Other sources keep the shared stop list: `status` and `update` are mail and chat terms.
 */
const KNOWLEDGE_FILLER = new Set([
  'about', 'regarding', 're', 'results', 'result', 'info', 'information', 'details', 'detail', 'owner', 'rob',
  'stuff', 'things', 'related', 'update', 'updates', 'status',
  // ROUTE-1022 K7: the instruction words that could be content in mail, so knowledge only. #631: the
  // layer's own name is the phrase "the web", which every source drops; the bare word stays here.
  'records', 'official', 'content', 'web',
  // and the instruction words above, so the model's own keyword fallback drops them too.
  'wait', 'continue', 'verify', 'verified', 'findings', 'finding', 'exact', 'reliable', 'specific',
  'detailed', 'lookup', 'lookups', 'searching', 'requested',
  // ONE-1023: the model's own direction words rode into the search text and spent its terms.
  'read', 'reads', 'reading', 'full', 'body', 'bodies', 'post', 'posts', 'current', 'currently',
  'available', 'retrieve', 'retrieves', 'retrieved', 'retrieving', 'especially', 'useful', 'usefully', 'later',
]);

/** The names a spoken question carries: a capitalised word past the first, never a stop word. */
function spokenNames(question: string): string[] {
  const names: string[] = [];
  for (const sentence of question.split(/[.!?]+/u)) {
    const words = sentence.replace(WORD_SHAPE, ' ').split(/\s+/).filter(Boolean);
    for (const word of words.slice(1)) {
      const name = word.toLowerCase();
      if (!/^[A-Z]/u.test(word) || name.length < 3 || STOP_WORDS.has(name) || names.includes(name)) continue;
      names.push(name);
    }
  }
  return names;
}

/** The RFC3339 window in the session timezone, independent of the process timezone. */
export function windowRange(window: string, nowMs: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): { timeMin: string; timeMax: string } {
  return calendarRange(window, nowMs, timeZone);
}

/** The resolved window kind, a closed enum for the host log: today, tomorrow, week or a single date. */
export type WindowKind = 'today' | 'tomorrow' | 'week' | 'date';
export function windowKind(window: string): WindowKind {
  return window === 'today' || window === 'tomorrow' || window === 'week' ? window : 'date';
}

// ---------------------------------------------------------------------------------------------
// Mail query compilation (E4/E5)

/** A Gmail operator the owner or a model authored: a query that carries one is already Gmail syntax. */
const MAIL_AUTHORED_OPERATOR = /\b(?:from|to|cc|bcc|subject|after|before|newer_than|older_than|is|has|label|in|filename|larger|smaller|list|deliveredto|rfc822msgid):/iu;
/** The instruction words a spoken mail question carries; Gmail ANDs them and matches nothing. */
const MAIL_FILLER = new Set([
  'about', 'regarding', 'concerning', 'sent', 'send', 'sending', 'received', 'receive', 'wrote', 'writing', 'written',
  'emailed', 'emailing', 'reply', 'replied', 'message', 'mail', 'mails', 'morning', 'afternoon', 'evening', 'night',
  'week', 'weeks', 'month', 'months', 'day', 'days', 'last', 'past', 'ago', 'since', 'today', 'yesterday', 'tomorrow',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'whether', 'if', 'actually', 'someone', 'anyone', 'still', 'currently', 'recently', 'earlier', 'later', 'think',
  'mention', 'mentioning', 'mentions', 'mentioned', 'thread', 'threads', 'share', 'shared', 'shares', 'sharing', 'next', 'before', 'after',
  'came', 'come', 'coming', 'went', 'gone', 'arrived', 'thanks', 'thank', 'cheers', 'regards', 'hello', 'hi', 'hey',
  // INTEG-R2: the instruction words of an inbox ask are never Gmail search terms, so
  // 'show me anything in my email' compiles to the plain recent-inbox scan instead.
  'list', 'show', 'anything', 'everything', 'recent', 'latest', 'new',
]);
/** The correspondence verbs that make "mail from or to that person" explicit. */
const MAIL_DIRECTION = /\b(?:from|to|sent|send|received|receive|reply|replied|wrote|written|email|emails|emailed|mailed|hear from|heard from)\b/iu;
/** Words capitalised for another reason than being a name. */
const NOT_A_NAME = new Set([
  'gmail', 'google', 'slack', 'mattermost', 'lux', 'didi', 'i',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);
const MAIL_ARTICLES = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their']);
/**
 * ROUTE-1022 K6: the owner's own names. The host knows no owner identity in this layer, so the set is the
 * spoken forms of his own name; a possessive of one is never a person to filter mail by.
 */
const OWNER_MAIL_NAMES = new Set(['rob', "rob's", 'robs', 'my', 'me', 'myself']);

/**
 * W15: the roster's addresses for the spoken person, so the mail query names an address rather than a
 * word. An unknown name keeps the connector's own text path exactly as before.
 */
function mailPersonClause(person: string | undefined): string[] {
  if (person === undefined) return [];
  const snapshot = peopleSnapshot();
  const binding = snapshot === null ? undefined : bindPerson(snapshot, person);
  const addresses = binding?.kind === 'resolved' ? binding.person.email : [];
  if (addresses.length === 0) return [`from:${person} OR to:${person}`];
  return [addresses.map(address => `from:${address} OR to:${address}`).join(' OR ')];
}

/** The person a question asks about, when it asks about mail from or to them. */
function mailPersonName(question: string): string | undefined {
  const words = question.split(/\s+/);
  for (let n = 1; n < words.length; n += 1) {
    const bare = words[n]!.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/gu, '');
    if (!/^[A-Z][A-Za-z'’-]+$/u.test(bare)) continue;
    if (NOT_A_NAME.has(bare.toLowerCase()) || OWNER_MAIL_NAMES.has(bare.toLowerCase())) continue;
    if (MAIL_ARTICLES.has(words[n - 1]!.toLowerCase().replace(/[^a-z]/gu, ''))) continue;
    return bare.toLowerCase();
  }
  return undefined;
}

/** At most four salient terms: names, words and numbers survive; filler and time words do not. */
export function mailTerms(text: string, max = 4, skip?: ReadonlySet<string>): string[] {
  const words = text.toLowerCase().replace(WORD_SHAPE, ' ').split(/\s+/).filter(Boolean);
  const terms: string[] = [];
  for (const word of words) {
    // K6: the owner's own name is in every thread, so it is never a term to search for.
    if (STOP_WORDS.has(word) || META_WORDS.has(word) || MAIL_FILLER.has(word) || OWNER_MAIL_NAMES.has(word) || skip?.has(word) === true) continue;
    if (/^[a-z_]+:$/u.test(word)) continue;
    if (!/\d/u.test(word) && word.length < 3) continue;
    if (terms.includes(word)) continue;
    terms.push(word);
    if (terms.length >= max) break;
  }
  return terms;
}

const MAIL_RELATIVE_WINDOWS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:today|this morning|this afternoon|this evening)\b/u, 'newer_than:1d'],
  [/\b(?:yesterday|last night)\b/u, 'newer_than:2d'],
  [/\b(?:this week|past week)\b/u, 'newer_than:7d'],
  [/\blast week\b/u, 'newer_than:14d'],
  [/\b(?:this month|past month)\b/u, 'newer_than:30d'],
  [/\blast month\b/u, 'newer_than:60d'],
];
const DAY_MS = 86_400_000;

/** The local calendar day an instant names, in the zone the window was resolved for. */
function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function dayShift(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!) + days * DAY_MS).toISOString().slice(0, 10);
}
function gmailDate(day: string): string { return day.replaceAll('-', '/'); }

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAY_NAMES = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';

/**
 * Release 4: what a hop plans from. The owner's question stands as it was asked, and a continuation still
 * plans from its direction; a direction that is nothing but instruction words has no search in it, so the
 * question the run was opened with is the text instead of an empty or meta query.
 */
function planText(question: string, run: { direction?: string | undefined; question?: string | undefined }): string {
  if (question.trim() !== '') return question;
  const direction = (run.direction ?? '').trim();
  const words = direction.toLowerCase().replace(WORD_SHAPE, ' ').split(/\s+/).filter(Boolean);
  const metaOnly = words.length > 0 && words.every(word => META_WORDS.has(word.replace(/\.+$/u, '')));
  return metaOnly || direction === '' ? run.question ?? direction : direction;
}

/** The owner's calendar year at an instant, in the zone the window is resolved for. */
function localYear(nowMs: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(new Date(nowMs)));
}
function monthStart(monthIndex: number, year: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}
/** One resolved local day as Gmail's exclusive day bounds. */
function dayWindow(day: string, nowMs: number, timeZone: string, shiftDays = 0): string {
  const range = windowRange(calendarWindowOf(day, day), nowMs, timeZone);
  const after = dayShift(localDay(range.timeMin, timeZone), -1 + shiftDays);
  const before = dayShift(localDay(range.timeMax, timeZone), shiftDays);
  return `after:${gmailDate(after)} before:${gmailDate(before)}`;
}
/** The year of the most recent occurrence of a month that has already begun in the owner's zone. */
function monthYear(monthIndex: number, nowMs: number, timeZone: string): number {
  const year = localYear(nowMs, timeZone);
  return Date.parse(`${monthStart(monthIndex, year)}T00:00:00Z`) > nowMs ? year - 1 : year;
}
/** The month a question names as Gmail's exclusive day bounds over that whole month. */
function monthWindow(monthIndex: number, year: number, nowMs: number, timeZone: string): string {
  const start = windowRange(monthStart(monthIndex, year), nowMs, timeZone).timeMin;
  const endIndex = monthIndex === 11 ? 0 : monthIndex + 1;
  const end = windowRange(monthStart(endIndex, monthIndex === 11 ? year + 1 : year), nowMs, timeZone).timeMin;
  return `after:${gmailDate(dayShift(localDay(start, timeZone), -1))} before:${gmailDate(localDay(end, timeZone))}`;
}
function monthNamed(text: string, name: string): boolean {
  // "may" is also a verb, so it only counts as a month behind a time preposition.
  return name === 'may'
    ? /\b(?:in|during|since|after|before) may\b/u.test(text)
    : new RegExp(`\\b${name}\\b`, 'u').test(text);
}

/**
 * The window a question asked for, resolved in the owner's own zone when it names a calendar day or a
 * month, and nothing when it named none. Every time word the question carries is answered here rather
 * than deleted, so "in September" and "before October" reach the mails they name. Gmail's `after:` and
 * `before:` are exclusive day bounds. ROUTE-1022 K6: the implicit two weeks is the caller's own
 * fallback, so a question with content terms is never narrowed to the last fortnight.
 */
export function mailWindow(question: string, nowMs = Date.now(), timeZone?: string): string | undefined {
  const text = question.toLowerCase();
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(text)?.[1];
    if (iso !== undefined) return dayWindow(iso, nowMs, zone);
    const nextWeekday = new RegExp(`\\bnext (${WEEKDAY_NAMES})\\b`, 'u').exec(text)?.[1];
    if (nextWeekday !== undefined) return dayWindow(`next ${nextWeekday}`, nowMs, zone);
    const lastWeekday = new RegExp(`\\blast (${WEEKDAY_NAMES})\\b`, 'u').exec(text)?.[1];
    if (lastWeekday !== undefined) return dayWindow(lastWeekday, nowMs, zone, -7);
    const onWeekday = new RegExp(`\\bon (${WEEKDAY_NAMES})\\b`, 'u').exec(text)?.[1];
    if (onWeekday !== undefined) return dayWindow(onWeekday, nowMs, zone);
    const monthIndex = MONTH_NAMES.findIndex(name => monthNamed(text, name));
    if (monthIndex >= 0) {
      const name = MONTH_NAMES[monthIndex]!;
      const year = monthYear(monthIndex, nowMs, zone);
      // "before October" is the day October begins; "since/after September" is the day it ended.
      if (new RegExp(`\\bbefore (?:the )?${name}\\b`, 'u').test(text)) return `before:${gmailDate(monthStart(monthIndex, localYear(nowMs, zone)))}`;
      if (new RegExp(`\\b(?:since|after) (?:the )?${name}\\b`, 'u').test(text)) {
        return `after:${gmailDate(dayShift(monthStart(monthIndex, year), -1))}`;
      }
      return monthWindow(monthIndex, year, nowMs, zone);
    }
  } catch { /* an unresolved day or month keeps the rolling window below */ }
  // E6 (#609): Gmail has no hour operator, so a short hours window is the day that holds it, and the
  // read filters the messages by their own date afterwards.
  const hours = mailHours(question);
  if (hours !== undefined) return hours <= 24 ? 'newer_than:1d' : 'newer_than:2d';
  for (const [pattern, window] of MAIL_RELATIVE_WINDOWS) if (pattern.test(text)) return window;
  return undefined;
}

/** E6 (#609): the hours an ask named when it is under two days, so the read can bound the day it compiled. */
export function mailHours(question: string): number | undefined {
  const match = /\b(?:in )?(?:the )?(?:last|past) (\d{1,2}) hours?\b/u.exec(question.toLowerCase());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  return Number.isFinite(hours) && hours > 0 && hours < 48 ? hours : undefined;
}

/**
 * E4: a spoken mail question becomes Gmail syntax. Plain words reduce to at most four salient terms,
 * a person the question is about becomes `from:<name> OR to:<name>`, and the window the question names
 * is added. ROUTE-1022 K6: an implicit two weeks is added only to a bare inbox scan, because it hid a
 * July thread from a question that carried its own terms. Explicit Gmail syntax is never rewritten.
 */
/** #565: the topic is names and nouns, at most eight words, as the declaration promises. */
export const TOPIC_MAX_WORDS = 8;
export const TOPIC_MAX_CHARS = 200;

/**
 * #576: a number enters a query only when the owner said that number. `spokenWords` is what the owner
 * said in this run, so a later hop never re-filters the run's own topic through its own question.
 */
export function ownerDigits(text: string, spokenWords: string): string {
  const spoken = new Set(spokenWords.match(/\d+/gu) ?? []);
  return text.split(/\s+/u).filter(word => (word.match(/\d+/gu) ?? []).every(run => spoken.has(run))).join(' ');
}

/**
 * #631: a source name is the route's word, never the ask's subject. Every name and spoken form of a
 * source this run may read is dropped from the topic before any source compiles it; a name whose source
 * this run cannot read is content (an ask about "the Mongoose release" keeps Mongoose when the company
 * layer is off the route). "Lux Didi" is the product's own name, so a bare Lux is kept inside it.
 */
const ROUTE_WORDS: Partial<Record<SourceKind, RegExp>> = {
  // The lookbehind keeps a Gmail operator's own value ("in:inbox") out of the strip.
  knowledge: /(?<!:)\blux\b(?!\s+didi\b)|\bknowledge base\b|\bknowledge\b|\b(?:the )?vault\b|\b(?:google drive|the drive|drive files?)\b/giu,
  mail: /(?<!:)\b(?:the )?(?:e-?mails?|gmail|inbox(?:es)?|mails?)\b/giu,
  chat: /(?<!:)\bteam chats?\b|\bmattermost\b/giu,
  calendar: /(?<!:)\b(?:the )?calendar\b/giu,
  web: /(?<!:)\bthe web\b/giu,
  mongoose: /(?<!:)\bmongoose\b/giu,
};

/** #565: the topic is the only text whose words become search terms, within the owner's own numbers. */
/** #631: the routing words removed from any search text, the owner's topic or a model-written query. */
function withoutRouteWords(text: string, sources: readonly SourceKind[]): string {
  let out = text;
  for (const source of sources) {
    const words = ROUTE_WORDS[source];
    if (words !== undefined) out = out.replace(words, ' ');
  }
  return out.replace(/\s+/gu, ' ').trim();
}

export function topicTerms(topic: string | undefined, spokenWords: string, sources: readonly SourceKind[] = RESEARCH_SOURCES): string | undefined {
  if (topic === undefined) return undefined;
  const text = withoutRouteWords(ownerDigits(topic, spokenWords), sources);
  return text === '' ? undefined : text;
}

/** #654: a continuation or status word is never a mail term, even when the model wrote it into a query. */
function stripContinuationWords(query: string): string {
  return query.split(/\s+/u).filter(word => !CONTINUATION_WORDS.has(word.replace(/[^a-z0-9-]+$/giu, '').toLowerCase())).join(' ').trim();
}

export function compileMailQuery(question: string, query: string | undefined, nowMs = Date.now(), timeZone?: string, topic?: string, ownerWords?: string, fallbackWindow?: string, sources: readonly SourceKind[] = RESEARCH_SOURCES): string {
  // #564: a triage ask reads the unread inbox itself, so the host's own generic inbox scan, a prose
  // question and a topic all give way to it; its own prose is never a term and no drop-a-term retry
  // follows an empty scan, so "anything important" cannot be answered from one old thread.
  if (triageAsk(question)) return TRIAGE_MAIL_QUERY;
  // #631: a model-written query names the layer as often as the topic it was written from.
  const authored = withoutRouteWords((query ?? '').replace(/\s+/gu, ' ').trim(), sources);
  const person = MAIL_DIRECTION.test(question) ? mailPersonName(question) : undefined;
  const asked = mailWindow(question, nowMs, timeZone);
  const gated = topicTerms(topic, ownerWords ?? question, sources);
  const topicText = gated !== undefined && contentKeywords(gated, 1).length > 0 ? gated : undefined;
  // #565: an authored query that already carries Gmail syntax is the model's own per-source search, and
  // the owner's instruction prose never reaches it because the question is not a text this compiles.
  if (authored && (MAIL_AUTHORED_OPERATOR.test(authored) || authored.includes('"'))) return stripContinuationWords(authored).slice(0, RESEARCH.queryLimitChars);
  // #576: a date the owner said is already the window; it is never also a term Gmail has to match.
  // E6 (#609): an hours phrase is already the window, never also a term.
  const text = (topicText ?? '').replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ').replace(/\b(?:in\s+)?(?:the\s+)?(?:last|past)\s+\d{1,2}\s+hours?\b/giu, ' ');
  const lower = question.toLowerCase();
  const flags = [/\bunread\b/u.test(lower) ? 'is:unread' : '', /\bimportant\b/u.test(lower) ? 'is:important' : ''].filter(Boolean);
  // E6 (#609): three AND terms at most, and the rest of the words joined with OR, so a five word
  // question no longer asks Gmail for five coincidences at once and matches nothing.
  const words = mailTerms(text, 8, person === undefined ? undefined : new Set([person]));
  const terms = words.length > 3 ? [...words.slice(0, 3), words.slice(3).join(' OR ')] : words;
  const leading = [...flags, ...mailPersonClause(person)];
  // E6 (#609): the window the caller's own recipe asked for, so a fallback search is compiled here once.
  const window = asked ?? fallbackWindow;
  // E6 (#609): the fallback recipe keeps its own order, the inbox and its window first, because that is the
  // shape the live step and the receipt already speak.
  if (fallbackWindow !== undefined) return ['in:inbox', ...(window === undefined ? [] : [window]), ...leading, ...terms].join(' ').slice(0, RESEARCH.queryLimitChars);
  if (leading.length === 0 && terms.length === 0) return `in:inbox ${window ?? 'newer_than:14d'}`.slice(0, RESEARCH.queryLimitChars);
  return [...leading, ...terms, ...(window === undefined ? [] : [window])].join(' ').slice(0, RESEARCH.queryLimitChars);
}

/** The shape of one mail query for a receipt: term count, operators and window, never the words. */
export interface MailQueryShape { terms: number; operators: string[]; window?: string }
// E5 (#612): an excluding filter is an operator, never a content term.
const OPERATOR_TOKEN = /^-?([a-z_]+):(.+)$/iu;
const WINDOW_OPERATORS = new Set(['newer_than', 'older_than', 'after', 'before']);
const isOperatorToken = (token: string): boolean => OPERATOR_TOKEN.test(token) || token.toUpperCase() === 'OR';

/**
 * #610: the shape of one chat query for a receipt: how many words, which closed operator names, the
 * page size and the sort. The words themselves never leave the plan.
 */
export interface ChatQueryShape { terms: number; operators: string[]; limit: number; sort: string }
/**
 * #610/F7: the closed operator names a chat query may name. Exported so the host log admits exactly
 * the tokens the planner can produce, and nothing else.
 */
export const CHAT_QUERY_OPERATORS: readonly string[] = ['in', 'from', 'after', 'before'];
const CHAT_OPERATORS = new Set(CHAT_QUERY_OPERATORS);
export function chatQueryShape(call: IntentSubCall | undefined): ChatQueryShape | undefined {
  if (call === undefined) return undefined;
  const query = typeof call.args['query'] === 'string' ? call.args['query'] : '';
  const operators: string[] = [];
  let terms = 0;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    const match = /^([a-z_]+):(.+)$/iu.exec(token);
    if (match === null) { terms += 1; continue; }
    const operator = match[1]!.toLowerCase();
    if (CHAT_OPERATORS.has(operator) && !operators.includes(operator)) operators.push(operator);
  }
  const limit = typeof call.args['limit'] === 'number' ? call.args['limit'] : RESEARCH.chatLines;
  // The connector asks for the newest sort on every windowed read, so a receipt names what it asked.
  return { terms, operators, limit, sort: 'newest' };
}
/**
 * R3: the chat read's receipt. A search records its shape; a refused triage read records the closed
 * reason it really failed with. The two never ride together, so a shape is never mistaken for a cause.
 */
export interface ChatReceipt { terms?: number; operators?: string[]; limit?: number; sort?: string; reason?: string }
export function chatReceiptField(served: readonly IntentSubCall[], results: readonly IntentSubResult[]): { chat?: ChatReceipt } {
  const failed = results.find(result => !result.ok);
  if (failed !== undefined) return { chat: { reason: chatAttentionReason(results) } };
  // C-CHAT: the person, group and channel read records the same shape: its topic words, never the name.
  const shape = chatQueryShape(served.find(call => call.name === INTERNAL.chatSearch || call.name === INTERNAL.chatRead));
  return shape === undefined ? {} : { chat: shape };
}

export function mailQueryShape(q: string): MailQueryShape {
  const operators: string[] = [];
  let terms = 0, window: string | undefined;
  for (const token of q.split(/\s+/).filter(Boolean)) {
    const match = OPERATOR_TOKEN.exec(token);
    if (match === null) { if (token.toUpperCase() !== 'OR') terms += 1; continue; }
    const operator = match[1]!.toLowerCase();
    if (!operators.includes(operator)) operators.push(operator);
    if (WINDOW_OPERATORS.has(operator) && window === undefined) window = token;
  }
  return { terms, operators, ...(window === undefined ? {} : { window }) };
}

const WINDOW_STEPS: Record<string, string> = { '1d': '7d', '2d': '7d', '7d': '14d', '14d': '30d', '30d': '60d' };

/**
 * E5: the one broader query a search that matched nothing may run: drop the least salient term, else
 * widen the window by one step. Undefined when nothing widens, so a narrow authored filter never loops.
 */
/**
 * How much a term is worth keeping: a number or an acronym is the least droppable, a long word next, a
 * short word last. Ties are broken toward the later term, so a trailing modifier goes before its noun.
 */
function termSalience(term: string): number {
  if (/\d/u.test(term)) return 4;
  if (/^[a-z]{2,4}$/u.test(term)) return 3;
  return term.length >= 5 ? 2 : 1;
}

export function broaderMailQuery(q: string): string | undefined {
  const tokens = q.split(/\s+/).filter(Boolean);
  // E6 (#609): a joined OR clause is the least specific part of the query, so dropping it is the one
  // broader try; Gmail binds OR tighter than the implicit AND, so the rest of the query is untouched.
  const orAt = tokens.findIndex((token, index) => token === 'OR' && index > 0
    && !isOperatorToken(tokens[index - 1]!) && !isOperatorToken(tokens[index + 1] ?? ''));
  if (orAt > 1) return tokens.slice(0, orAt - 1).join(' ').slice(0, RESEARCH.queryLimitChars);
  const termIndexes = tokens.map((token, index) => isOperatorToken(token) ? -1 : index).filter(index => index >= 0);
  const windowIndex = tokens.findIndex(token => /^newer_than:[a-z0-9]+$/u.test(token));
  const step = windowIndex >= 0 ? WINDOW_STEPS[/^newer_than:(.+)$/u.exec(tokens[windowIndex]!)?.[1] ?? ''] : undefined;
  // ROUTE-1022 K6: a query with no window to widen broadens by dropping its one term instead of
  // returning nothing, so a person-and-topic search still gets exactly one wider try.
  if (termIndexes.length > 1 || (termIndexes.length > 0 && step === undefined && windowIndex < 0)) {
    let dropped = termIndexes[0]!;
    for (const index of termIndexes) if (termSalience(tokens[index]!) <= termSalience(tokens[dropped]!)) dropped = index;
    return tokens.filter((_, index) => index !== dropped).join(' ').slice(0, RESEARCH.queryLimitChars);
  }
  if (windowIndex >= 0) {
    if (step !== undefined) {
      const widened = [...tokens];
      widened[windowIndex] = `newer_than:${step}`;
      return widened.join(' ').slice(0, RESEARCH.queryLimitChars);
    }
  }
  return undefined;
}

const WINDOW_PHRASE: Record<string, string> = {
  '1d': 'in the last day', '2d': 'in the last two days', '7d': 'in the last week',
  '14d': 'in the last two weeks', '30d': 'in the last month', '60d': 'in the last two months',
};

/**
 * E5: how the reply says it searched: the words it matched and the window it used. The model voices
 * this so an empty search reads as "nothing matching X in the last two weeks", never as a bare no.
 */
export function mailSearchPhrase(q: string): string {
  const shape = mailQueryShape(q);
  const words = q.split(/\s+/).filter(token => token.length > 0 && !isOperatorToken(token));
  let phrase = words.length > 0 ? ` for "${words.join(' ')}"` : ' with a keyword filter';
  if (shape.window !== undefined) {
    const relative = /^newer_than:(.+)$/u.exec(shape.window)?.[1];
    if (relative !== undefined) phrase += ` ${WINDOW_PHRASE[relative] ?? `within ${relative}`}`;
    else {
      const after = /after:(\S+)/u.exec(q)?.[1], before = /before:(\S+)/u.exec(q)?.[1];
      if (after !== undefined && before !== undefined) phrase += ` between ${after} and ${before}`;
      else if (after !== undefined) phrase += ` after ${after}`;
      else if (before !== undefined) phrase += ` before ${before}`;
      else phrase += ` within ${shape.window}`;
    }
  }
  return phrase;
}

/** The deterministic fallback query per source: never the raw sentence. */
export function fallbackQuery(kind: CandidateKind, question: string, nowMs = Date.now(), sources: readonly SourceKind[] = RESEARCH_SOURCES): { query?: string; window?: string } {
  const text = question.toLowerCase();
  const keywords = contentKeywords(question);
  const terms = keywords.join(' ');
  if (kind === 'knowledge_search') return terms ? { query: terms } : {};
  // #639: the company search takes the same short terms the knowledge read takes, never the sentence.
  if (kind === 'company_search') return terms ? { query: terms } : {};
  if (kind === 'drive_search') return terms ? { query: terms } : {};
  if (kind === 'web_search') { const query = broaderWebQuery(question, 120); return query ? { query } : {}; }
  if (kind === 'mail_search') {
    // E6 (#609): the fallback recipe hands the compiler its own window and its own words, so the query
    // Gmail reads is compiled once here and never handed back to the model as already authored syntax.
    const window = /\btoday\b/.test(text) ? 'newer_than:1d'
      : /\b(this week|week)\b/.test(text) ? 'newer_than:7d'
      : /\byesterday\b/.test(text) ? 'newer_than:2d'
      : 'newer_than:14d';
    return { query: compileMailQuery(question, undefined, nowMs, undefined, question, question, window, sources) };
  }
  // ONE-1023: the day operator is the owner's own day. DATES-R1 F3: the no-operator rule applies to
  // content terms, and with none left the base recency window stays, never an empty query.
  if (kind === 'chat_search') {
    const dated = DATE_WORD.test(question);
    return { query: dated || terms === '' ? `after:yesterday${terms ? ` ${terms}` : ''}` : terms };
  }
  if (kind === 'calendar_window') {
    // #5: an unparseable window names no window at all, rather than reading today's by default.
    const window = calendarWindowOf(question, 'today');
    return window === '' ? {} : { window };
  }
  return {};
}

/** ROUTE-1022: the owner's own schedule, in the words a spoken question uses. One deterministic rule, no classifier. */
/**
 * F8: the forcing rule reads schedule vocabulary only. A time word alone (today, tomorrow, calls) is the
 * product's daily language, so it never pulls the calendar into a question that did not ask for it.
 */
const OWNER_SCHEDULE = /\b(calendar|schedule|agenda|appointments?|meetings?|itinerary|out of office)\b/u;
/**
 * F8: the router's calendar class is the same schedule vocabulary, plus the temporal phrases that are only
 * ever a schedule. A bare today, tomorrow or "calls" is the product's daily language and routes nothing.
 */
const SCHEDULE_WORDS = new RegExp(`${OWNER_SCHEDULE.source}|\\b(next week|weekdays?|sunday|monday|tuesday|wednesday|thursday|friday|saturday|travel|trip|flight|itinerary|out of office)\\b`, 'u');

export function ownerScheduleQuestion(question: string): boolean {
  return OWNER_SCHEDULE.test(question.toLowerCase());
}

/** Whether a question asks what came in, rather than naming something to look up. */
export function triageAsk(question: string): boolean {
  const ask = question.toLowerCase();
  if (!TRIAGE_ASK.test(ask)) return false;
  return contentKeywords(ask.replace(TRIAGE_ASK, ' '), 8).every(word => TRIAGE_REST.has(word));
}

/** Whether a question asks her to recall something the two of them already said. */
export function recallQuestion(question: string): boolean {
  return MEMORY_WORDS.test(question.toLowerCase()) || NAMED_DISCUSSION.test(question);
}

/**
 * #657 item 1 and #653: a status or test-all ask is about the tools themselves, not about their
 * contents, so the host reads every source and reports what each one actually did.
 */
const STATUS_THING = 'tools?|sources?|connectors?|inbox|mail|emails?|gmail|calendar|chat|mattermost|slack|knowledge|memory|web|mongoose';
/** A status word answers "is the source working", never "is it up to Friday" or "working out" (review F1). */
const STATUS_STATE = 'working|alive|connected';
// Review G1: only "is<source> <state>" asks the status, never "<source> ... <state>" as content ("the mail
// thread we were working on", "the calendar ... the working group").
const STATUS_ASK = new RegExp(`\\b(?:are|is)\\b[^?.]{0,30}\\b(?:${STATUS_THING})\\b[^?.]{0,6}\\b(?:${STATUS_STATE})\\b|\\b(?:test|check)\\s+(?:all\\s+|the\\s+|every\\s+)?(?:tools?|sources?|connectors?)\\b|\\ball (?:the\\s+)?tools\\b`, 'iu');
export function statusAsk(question: string): boolean {
  return STATUS_ASK.test(question);
}

/** ROUTE-1022: the word classes a spoken question is routed by, shared by the fallback recipe and the router. */
// E1 (#605): a message is a chat word, never a mail word, so one word no longer pulls two sources.
const MAIL_WORDS = /\b(mails?|emails?|e-mails?|gmail|inbox(?:es)?|wrote|sent|repl(?:y|ies|ied))\b/u;
// #617: a birthday is a calendar day like a meeting, so naming one reads the calendar.
const CALENDAR_WORDS = /\b(calendar|schedule|meetings?|agenda|birthdays?|free|busy)\b/u;
/**
 * #579: a time word is the product's daily language. The router's own class (SCHEDULE_WORDS) never carries
 * one; only this fallback recipe does, and only when no mail or chat word named a source.
 */
const CALENDAR_TIME_WORDS = /\b(tomorrow|today|week)\b/u;
/**
 * TRIAGE-R3: a recall ask is her own remembered history, in the words a spoken recall uses. It reads the
 * memory layer, never the knowledge store.
 */
const MEMORY_WORDS = /\b(?:did we say|last time we (?:talked|spoke)|you told me|do you remember|remember when|recall when|our (?:last )?conversation|what did we (?:discuss|talk about)|we (?:talked|spoke) about)\b/u;
/** E2 (#605): two capitalised names and a discussion verb is a recall ask, whatever the names are. */
const NAMED_DISCUSSION = /\b(?:what did|did)\s+[A-Z][\w'’-]*\s+and\s+[A-Z][\w'’-]*\s+(?:discuss|talk about|say about)\b/u;
const CHAT_WORDS = /\b(chats?|team|channels?|slack|mattermost|messages?|dms?|said|posted|discussed)\b/u;
/**
 * #639: the company words. The owner's own organisation lives in Mongoose, so an ask about a customer, a
 * client, a prospect, a deal, a product or the CRM is a company ask, as is naming Mongoose itself and
 * asking what the company sells. "do we know <name>" names the company too, never "what do we know", which
 * is the generic knowledge ask.
 */
const COMPANY_WORDS = /\b(?:mongoose|company(?: knowledge)?|customers?|clients?|prospects?|crm|deals?|our (?:products?|offerings?)|what do we sell|(?<!\bwhat )do we know)\b/u;
/** #635: the writing verbs. A summarise, draft or reply ask has a chat word as its subject, not as a source. */
const WRITING_WORDS = /\b(?:write|writes|writing|written|wrote|draft|drafts|summari[sz]e|summari[sz]ed|summaries|summary|compose|composes|reply|replies|replying|respond)\b/u;
/** #635: the pure recall forms. A recall ask reads her own history, and the chat only when the ask names it. */
const RECALL_WORDS = /\b(?:what did i (?:say|tell|mention)|remind me|recall|do you remember)\b/u;
/**
 * #635: the ask naming the chat surface itself, so a writing or a recall ask about the chat still reads it:
 * a chat, a channel, Mattermost, Slack, a dm, or a message from a named person.
 */
const CHAT_SURFACE = /\b(?:chats?|channels?|mattermost|slack|dms?)\b|\b(?:message|post)s? (?:from|by) \p{L}+|\p{L}+['\u2019]s (?:message|post)\b/u;

/**
 * #635: which word classes decide a chat read. The chat surface words route the chat on their own; a writing
 * verb or a pure recall phrase means the chat word is only the ask's subject, so without a named surface the
 * ask reads her memory and no chat leg runs.
 * #646: this one rule decides the chat leg for every path: the run's own recall branch, the router and the
 * fallback. It reads the whole recall test, not only the recall phrases, because "what did we discuss with
 * the team" is a recall ask whose chat word (team) is its subject, and the run's branch offered it a chat
 * read on the discussion forms alone and waited on it.
 */
export function chatQuestionWords(ask: string): boolean {
  const text = ask.toLowerCase();
  // C-CHAT: a person, group or channel chat ask ("what did Ada write me", "what did I discuss with Ada")
  // names the chat by its shape, whatever writing or recall verb it carries.
  if (chatAsk(ask)) return true;
  if (!CHAT_WORDS.test(text)) return false;
  if (recallQuestion(ask) && !CHAT_SURFACE.test(text)) return false;
  return !(WRITING_WORDS.test(text) || RECALL_WORDS.test(text)) || CHAT_SURFACE.test(text);
}

/**
 * #564/#572: a triage ask is "what came in", never a keyword search. The host runs the fixed read below
 * instead of the question's prose, so a relevance ranker can never answer it from an old thread.
 */
// E2 (#605): "what needs <name>" and "needs <name>'s attention" are the same ask as "what needs me".
const TRIAGE_ASK = /\b(?:anything (?:new|important|urgent|unread)|any (?:new|important|urgent|unread)|what came in|came in|what needs me|needs me|needs? (?:[a-z][\w'’-]*'s )?attention|what needs [a-z][\w'’-]*(?:'s)?|what did i miss|unread)\b/u;
/** The only words a triage ask may add beside the phrase itself, so a question with a real noun stays a lookup. */
const TRIAGE_REST = new Set(['anything', 'any', 'new', 'important', 'urgent', 'unread', 'came', 'come', 'comes', 'in', 'what', 'needs', 'need', 'needed', 'me', 'reply', 'replies', 'respond', 'attention', 'miss', 'missed', 'did', 'i', 'today', 'tomorrow', 'yesterday', 'week', 'this', 'last', 'morning', 'afternoon', 'evening', 'my', 'mail', 'mails', 'email', 'emails', 'e-mail', 'e-mails', 'gmail', 'inbox', 'inboxes', 'message', 'messages', 'chat', 'chats', 'dm', 'dms', 'team', 'channel', 'channels', 'slack', 'mattermost', 'posted', 'said', 'discussed', 'wrote', 'sent', 'from', 'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'on', 'at', 'it', 'there', 'anything', 'has', 'have', 'got', 'get', 'arrived', 'landed', 'waiting', 'act', 'action', 'reaction', 'you', 'please']);
/** #564: the one inbox scan a triage read runs, with no prose term and no drop-a-term retry. */
// E5 (#612): promotions, social and forum mail are not what needs him, so the scan never reads them.
const TRIAGE_MAIL_QUERY = 'in:inbox is:unread newer_than:2d -category:promotions -category:social -category:forums';
/** #572: the window a chat triage read rolls back over. */
const TRIAGE_DAYS = 7;
/** #564/#572/TRIAGE-R1 6: what came in is a mail, a chat and a calendar read alike, plus her own memory. */
const TRIAGE_SOURCES: readonly SourceKind[] = ['mail', 'chat', 'calendar'];
/** TRIAGE-R1 5 (#578): a weekday or an exact date is a calendar window in the words a spoken ask uses. */
const CALENDAR_DAY_WORDS = /\b(?:(?:next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|\d{4}-\d{2}-\d{2})\b/u;
/** MED-1022: a web read is for explicit public intent only. `latest`, `cost` and `price` are how the
 * owner asks about his own work (the 18:34 call spent a web read on "the latest" and got a soap
 * result), so only the public list below offers the web. */
const WEB_WORDS = /\b(news|headlines|weather|forecast|opening hours|search the web|on the internet|google it)\b/u;
const KNOWLEDGE_WORDS = /\b(knowledge|notes?|decisions?|decided|documents?|docs?|specs?|reminders?|recorded)\b/u;

/** C-OPEN 2: an ask to open or find a deck, doc or sheet, or one that names his Drive; a question about a deck is not one. */
const DRIVE_ASK = /\b(?:open|show|find|pull up|bring up)\b[^.?!]*\b(?:decks?|slides?|presentations?|spreadsheets?|sheets?|docs?|documents?|pptx?|xlsx?)\b|\b(?:google drive|my drive|in drive|from drive)\b/u;

/**
 * The source a question is about, in the order the first answer waits for them. The word classes are the one
 * place a route is decided: `words` is the source's own vocabulary, and a route that also carries `needed` is
 * reached only when the ask needs it, which for the chat is the #635 writing and pure recall rule.
 * #639: the company source sits last, so an ask that also names mail, calendar or chat keeps the two source
 * cap it had before a company word existed, and only a company ask with room left reads Mongoose.
 */
/** C-CHAT: the chat's own vocabulary is its words plus the person, group and channel ask shapes. */
const CHAT_ROUTE_WORDS = { test: (text: string): boolean => CHAT_WORDS.test(text) || chatAsk(text) };
const ROUTE_CLASSES: readonly { source: SourceKind; words: { test(text: string): boolean }; needed?: (text: string) => boolean }[] = [
  { source: 'calendar', words: SCHEDULE_WORDS }, { source: 'mail', words: MAIL_WORDS }, { source: 'drive', words: DRIVE_ASK },
  { source: 'chat', words: CHAT_ROUTE_WORDS, needed: chatQuestionWords }, { source: 'mongoose', words: COMPANY_WORDS },
];

/** Whether an ask's words route this source, its own word class and its own need rule together. */
function routeWanted(route: { words: { test(text: string): boolean }; needed?: (text: string) => boolean }, question: string): boolean {
  return route.words.test(question.toLowerCase()) && (route.needed?.(question) ?? true);
}

/**
 * ROUTE-1022 (#526): the sources a question is about. The first answer waits for these instead of a
 * flat first-answer point, so a calendar question answers with the calendar and not with what was quick.
 */
export function requiredSources(question: string): SourceKind[] {
  const text = question.toLowerCase();
  if (WEB_WORDS.test(text)) return [];
  // TRIAGE-R3: a recall ask reads her own remembered history, whatever day or word it also carries.
  // E2 (#605): a discussion ask reads the chat beside it, because that is where the exchange was said.
  // #635: the chat beside it only when the ask names the chat surface, because a recall ask about the chat
  // is the exception, not the rule. #646: the need rule decides it, the same rule the run's recall branch reads.
  if (recallQuestion(question)) return chatQuestionWords(question) ? ['memory', 'chat'] : ['memory'];
  const named = ROUTE_CLASSES.filter(route => routeWanted(route, question)).slice(0, 2).map(route => route.source);
  if (named.length > 0) return named;
  // #564/#572: "anything urgent" names no source, and what came in is a mail and a chat read alike.
  if (triageAsk(text)) return [...TRIAGE_SOURCES];
  // #578: a weekday or an exact date names the calendar when the ask names no other source.
  return CALENDAR_DAY_WORDS.test(text) ? ['calendar'] : [];
}

/**
 * ROUTE-1022 (#526): the deterministic selection for an unambiguous question, so the selector call is
 * never spent on it. Unambiguous means one or two of calendar, mail and chat matched, or her own
 * knowledge words with nothing else, and never a web word.
 */
export function routedSelection(question: string, configured: readonly SourceKind[], nowMs = Date.now()): SelectorOutput | undefined {
  const text = question.toLowerCase().trim();
  if (!text || WEB_WORDS.test(text)) return undefined;
  // TRIAGE-R3: a recall ask is the memory lookup the run builds, so the router claims no candidate for
  // it; without this, the word "said" would turn it into a chat search.
  if (recallQuestion(text)) return undefined;
  const matched = ROUTE_CLASSES.filter(route => routeWanted(route, question) && configured.includes(route.source));
  if (matched.length > 2) return undefined;
  if (matched.length > 0) {
    const selection = fallbackSelection(question, configured, nowMs);
    return selection.actions.some(action => sourceKindOf(action.kind) !== 'knowledge') ? selection : undefined;
  }
  // #564/#572: "anything urgent" named no source at all, and the triage read is what answers it.
  if (triageAsk(text)) {
    const selection = fallbackSelection(question, configured, nowMs);
    return selection.actions.some(action => sourceKindOf(action.kind) !== 'knowledge') ? selection : undefined;
  }
  // #578: a weekday or an exact date is the calendar window the ask named.
  if (CALENDAR_DAY_WORDS.test(text)) {
    const selection = fallbackSelection(question, configured, nowMs);
    return selection.actions.some(action => action.kind === 'calendar_window') ? selection : undefined;
  }
  if (!KNOWLEDGE_WORDS.test(text)) return undefined;
  return {
    questionClass: 'cross_source',
    actions: [{ kind: 'knowledge_search', ...fallbackQuery('knowledge_search', question, nowMs, configured) }],
    pUseful: { knowledge_search: 0.6 },
  };
}

/** The keyword fallback: used when the selector times out or answers invalidly, and with no selector. */
export function fallbackSelection(question: string, configured: readonly SourceKind[], nowMs = Date.now()): SelectorOutput {
  const text = question.toLowerCase();
  const actions: SelectorAction[] = [];
  const pUseful: Partial<Record<CandidateKind, number>> = {};
  const offer = (kind: CandidateKind, p: number, source: SourceKind | null): void => {
    if (source !== null && !configured.includes(source)) return;
    actions.push({ kind, ...fallbackQuery(kind, question, nowMs, configured) });
    pUseful[kind] = p;
  };
  const webWords = !/\b(?:mail|calendar|chat|our|my|we)\b/u.test(text)
    && (WEB_WORDS.test(text) || /\b(?:price of|how much is|latest version|who is \p{L}+|when did|release date|population of|exchange rate|score|results of)\b/u.test(text));
  const mailWords = MAIL_WORDS.test(text);
  // #579: a time word alone never replaces the source the ask named with the calendar.
  const calendarWords = CALENDAR_WORDS.test(text) || (!mailWords && !CHAT_WORDS.test(text) && (CALENDAR_DAY_WORDS.test(text) || CALENDAR_TIME_WORDS.test(text)));
  const chatWords = chatQuestionWords(question);
  const triage = triageAsk(text) && !mailWords && !chatWords;
  // #639: a company ask names a source, so it takes the same branch the mail, calendar and chat words take.
  const companyWords = COMPANY_WORDS.test(text);
  const driveWords = DRIVE_ASK.test(text);
  const matched = mailWords || calendarWords || chatWords || companyWords || driveWords || triage;
  if (!matched) {
    offer('brief', 0.5, null); offer('knowledge_search', 0.4, 'knowledge');
    if (webWords) offer('web_search', 0.45, 'web');
    return { questionClass: 'cross_source', actions, pUseful };
  }
  offer('knowledge_search', 0.4, 'knowledge');
  if (mailWords || triage) offer('mail_search', 0.4, 'mail');
  if (calendarWords || triage) offer('calendar_window', 0.4, 'calendar');
  if (chatWords || triage) offer('chat_search', 0.4, 'chat');
  // #639: the company layer answers a company ask beside the knowledge base, and is offered only when the
  // ask names it, never as a default read of every question.
  if (companyWords) offer('company_search', 0.4, 'mongoose');
  if (driveWords) offer('drive_search', 0.5, 'drive');
  if (webWords) offer('web_search', 0.45, 'web');
  return { questionClass: 'cross_source', actions, pUseful };
}

/** Candidates the selector may choose, closed over configuration and prerequisites. */
export function offerableCandidates(configured: readonly SourceKind[], completed: readonly CandidateKind[]): CandidateKind[] {
  return CANDIDATES.filter(candidate => {
    if (candidate.kind === 'stop_answer' || candidate.kind === 'stop_insufficient') return false;
    if (completed.includes(candidate.kind)) return false;
    if (candidate.kind === 'brief') return configured.length > 1;
    if (candidate.source === null) return false;
    if (!configured.includes(candidate.source)) return false;
    if (candidate.requires !== undefined && !completed.includes(candidate.requires)) return false;
    return true;
  }).map(candidate => candidate.kind);
}

/**
 * Q5-R1: the three asks that want one entry's whole body rather than another search: a named entry,
 * a request for the full text, and going deeper on something a previous lookup already returned.
 */
const NAMED_ID_LIST = /\bids?\s*=\s*\[([\d,\s]+)\]/giu;
const NAMED_ID = /(?:\bids?\s+|\binsight\s+)(\d{1,12})\b/giu;
const HASH_ID = /#(\d{1,12})\b/gu;
const FULL_READ_ASK = /\b(?:full|whole|entire|complete|in full)\b|\bdeeper?\b/iu;

/** Q5-R1: the insight ids a question names outright, to be read through `get_insight`, not searched. */
export function namedInsightIds(question: string, query?: string): number[] {
  const text = `${question}\n${query ?? ''}`;
  const ids = [...text.matchAll(NAMED_ID_LIST)].flatMap(match => (match[1] ?? '').split(',').map(Number));
  ids.push(...[...text.matchAll(NAMED_ID)].map(match => Number(match[1])));
  // A bare `#123` is only an id here when the question also asks for the whole entry: an issue number
  // in passing still deserves a search, never a read of whatever insight happens to carry that number.
  if (FULL_READ_ASK.test(text)) ids.push(...[...text.matchAll(HASH_ID)].map(match => Number(match[1])));
  return [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, RESEARCH.knowledgeHits);
}

/**
 * K4: the owner's project names, from the corpus's own project tags, matched whole-word and
 * case-insensitively. A name the question says out loud becomes a ranking hint, never a hard filter.
 */
const KNOWN_PROJECTS: readonly string[] = Object.freeze([
  'Mosquito', 'llama', 'Wriggler', 'plantix', 'lux-harness', 'mongoose', 'dagster-dp-wriggler-pipeline',
  'dogtation', 'vicuna', 'the-lux-emissary', 'Hawk', 'freya', 'macaca', 'lux-didi', 'claude-lux-knowledge',
]);

/** K4: the project the question names, written the way the corpus tags it, or nothing. */
export function projectHintOf(question: string): string | undefined {
  const spoken = question.toLowerCase();
  return KNOWN_PROJECTS.find(project => new RegExp(`(^|[^a-z0-9-])${project.toLowerCase()}([^a-z0-9-]|$)`, 'u').test(spoken));
}

/**
 * K3: the model writes sentences, and a long string costs ranker score, so the query is keywords.
 * MED-1022: a model query keeps its own terms first, then the name and the words of the owner's
 * question that it dropped, because the owner's question is the one text that holds who and what.
 */
export function knowledgeQuery(text: string, question?: string): string {
  const terms = contentKeywords(text, RESEARCH.knowledgeQueryTerms, KNOWLEDGE_FILLER);
  if (question !== undefined) {
    for (const word of [...spokenNames(question), ...contentKeywords(question, RESEARCH.knowledgeQueryTerms, KNOWLEDGE_FILLER)]) {
      if (terms.length >= RESEARCH.knowledgeQueryTerms) break;
      if (!terms.includes(word)) terms.push(word);
    }
  }
  if (terms.length > 0) return terms.join(' ');
  if (question === undefined) return '';
  // A query the model wrote is already keywords: `team` or `notes` is a stop word for a spoken
  // question, never for a search string, so it is clipped and kept instead of dropped.
  // K7: a spoken question's punctuation is not a word, so `findings.` is the filler `findings`.
  const bare = (word: string): string => word.replace(/[.:]+$/u, '') || word;
  return text.toLowerCase().replace(/[^a-z0-9@._:-]+/gu, ' ').trim().split(/\s+/).filter(word => Boolean(word) && !KNOWLEDGE_FILLER.has(bare(word)) && !META_WORDS.has(bare(word))).slice(0, RESEARCH.knowledgeQueryTerms).join(' ');
}

/** 3r K1: the voice lookup's bounded-body arguments, named once so the wire and the receipt cannot disagree.
 * MED-1022: the body answers the best hit and the rest arrive as leads, and a named meeting day narrows
 * the corpus through the connector's own ISO meeting bounds. */
function knowledgeSearchArgs(query: string, projectHint?: string, meeting?: { from: string; to: string }): JsonObject {
  return {
    query, limit: RESEARCH.knowledgeHits,
    detail: RESEARCH.knowledgeDetail,
    max_chars: RESEARCH.knowledgeBodyChars,
    snippet_chars: RESEARCH.knowledgeSnippetChars,
    deadline_ms: RESEARCH.knowledgeDeadlineMs,
    ...(meeting === undefined ? {} : { meeting_date_from: meeting.from, meeting_date_to: meeting.to }),
    ...(projectHint === undefined ? {} : { project_hint: projectHint }),
  };
}

const DATE_WORD = /\b(yesterday|today|tomorrow|this week|last week|next week|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(\d{4}-\d{2}-\d{2})\b/iu;
const MEETING_WORD = /\b(meetings?|calls?|transcripts?|notes?)\b/iu;

/** #576: "last meeting with X" asks for the newest notes, whatever the ranker returned. */
const LAST_MEETING = /\b(?:last|latest|previous|most recent|recent)\b[\s\S]{0,24}?\b(?:meeting|call|sync|1:1|standup|transcript)s?\b/iu;
export function lastMeetingQuestion(question: string): boolean { return LAST_MEETING.test(question); }

/** #576: dated notes read newest first; a line with no date keeps the place it came in at. */
export function newestDatedFirst(lines: readonly string[]): string[] {
  const dated = lines.map(line => ({ line, at: Date.parse(/(\d{4}-\d{2}-\d{2})/u.exec(line)?.[1] ?? '') }));
  // E3 (#611): the confidence line and any other undated line are not a reason to keep the whole list in
  // the ranker's order, so only the dated lines move.
  const sorted = dated.filter(entry => !Number.isNaN(entry.at)).sort((left, right) => right.at - left.at);
  let next = 0;
  return dated.map(entry => (Number.isNaN(entry.at) ? entry.line : sorted[next++]!.line));
}

/**
 * MED-1022: a question that names a meeting and a day asks the corpus about that day. The connector's
 * meeting bounds are ISO days in the owner's zone; a wrong name would empty the result, so a name never
 * becomes the participant filter and only the day narrows anything.
 */
export function meetingBounds(question: string, query: string | undefined, nowMs: number, timeZone: string): { from: string; to: string } | undefined {
  const text = `${question} ${query ?? ''}`;
  if (!MEETING_WORD.test(text)) return undefined;
  const word = DATE_WORD.exec(text)?.[0].toLowerCase();
  const today = localDay(new Date(nowMs).toISOString(), timeZone);
  // E3 (#611): "last meeting" names no day, so the note read is bounded to the last sixty days rather
  // than the whole corpus.
  if (word === undefined) return lastMeetingQuestion(question) ? { from: dayShift(today, -60), to: today } : undefined;
  // Notes exist only for meetings that already happened, so a day that has not passed yet narrows nothing.
  if (word === 'yesterday' || word === 'today' || word === 'tomorrow') {
    if (word !== 'yesterday') return undefined;
    const day = dayShift(today, -1);
    return { from: day, to: day };
  }
  try {
    // windowRange reads today, tomorrow, this and next week, a weekday and an ISO day, never yesterday
    // and never last week, so the previous week is this week's own Monday..Sunday moved back seven days.
    // It already moves next week by seven, so weeks counts last week alone.
    const range = windowRange(word === 'last week' ? 'this week' : word, nowMs, timeZone);
    const weeks = word === 'last week' ? -7 : 0;
    const from = dayShift(localDay(range.timeMin, timeZone), weeks);
    const to = dayShift(localDay(range.timeMax, timeZone), weeks - 1);
    return to < today ? { from, to } : undefined;
  } catch { return undefined; }
}

/**
 * 3r K1 and K1-R3: the knowledge receipt's metadata, the same on the routed and the selector path.
 * `truncated` reads the mark `insightItems` writes on a hit the server cut at the asked-for window.
 * MED-1022/T-R2: the receipt also names the query's term count, whether the day filter was applied and
 * what became of the chat date operator. Counts and closed tokens only, never the query text.
 * ONE-1023: the day filter is a closed token, and `deduped` counts the reads a shared dispatch served.
 */
function knowledgeReceipt(lines: readonly string[], chatDate: ChatDateOperator, search?: IntentSubCall, options: { droppedFilters?: ReadonlySet<string> | undefined; deduped?: number | undefined } = {}): {
  detail: string; maxChars: number; deadlineMs: number; truncated: boolean;
  queryTerms: number; dayFilter: DayFilter; chatDateOperator: ChatDateOperator; deduped: number;
} {
  const query = search === undefined ? undefined : search.args['query'];
  return {
    detail: RESEARCH.knowledgeDetail, maxChars: RESEARCH.knowledgeBodyChars, deadlineMs: RESEARCH.knowledgeDeadlineMs,
    truncated: lines.some(line => line.endsWith(`cut at ${RESEARCH.knowledgeBodyChars} chars`)),
    queryTerms: typeof query === 'string' ? query.split(/\s+/u).filter(Boolean).length : 0,
    dayFilter: dayFilterOf(search, options.droppedFilters?.has(dayFilterKey(search)) ?? false),
    chatDateOperator: chatDate,
    deduped: options.deduped ?? 0,
  };
}

/** The closed token for the day filter decision: none sent, a past window sent, or a window dropped on empty. */
export type DayFilter = 'none' | 'past_window' | 'dropped_on_empty';
function dayFilterOf(search: IntentSubCall | undefined, dropped: boolean): DayFilter {
  if (search === undefined || search.args['meeting_date_from'] === undefined) return 'none';
  return dropped ? 'dropped_on_empty' : 'past_window';
}

/** The identity of one day-filtered read, so the drop is recorded on the read that earned it. */
function dayFilterKey(search: IntentSubCall | undefined): string {
  return search === undefined ? '' : JSON.stringify(search.args);
}

/** The same search with its day bounds removed, for the one retry an empty filtered search earns. */
function withoutDayFilter(sub: IntentSubCall): IntentSubCall | undefined {
  if (sub.name !== INTERNAL.knowledgeSearch || sub.args['meeting_date_from'] === undefined) return undefined;
  const args: JsonObject = {};
  for (const [key, value] of Object.entries(sub.args)) if (key !== 'meeting_date_from' && key !== 'meeting_date_to') args[key] = value;
  return { key: sub.key, name: sub.name, args };
}

/** A day-filtered knowledge search that matched nothing asks the same query once more without the filter. */
async function droppedDayFilterRetry(deps: ResearchDeps, subs: readonly IntentSubCall[], results: readonly IntentSubResult[], signal: AbortSignal, dropped: Set<string>): Promise<void> {
  for (let index = 0; index < subs.length; index++) {
    const sub = subs[index]!;
    const result = results[index];
    if (result === undefined || !result.ok || result.text.trim() !== '') continue;
    const bare = withoutDayFilter(sub);
    if (bare === undefined) continue;
    try {
      const [retried] = await deps.execute([bare], signal);
      if (retried?.ok !== true || retried.text.trim() === '') continue;
      (results as IntentSubResult[])[index] = retried;
      dropped.add(dayFilterKey(sub));
    } catch { /* keep the empty first answer */ }
  }
}

const CHAT_DATE_OPERATOR = /\b(after|before|on):([^\s]+)/giu;

/**
 * MED-1022: the Mattermost index reads `After:`/`Before:`/`On:` with an ISO day and ignores any other
 * word, so `after:yesterday` returned the whole archive. A date word is compiled to the day it names in
 * the owner's zone, and an operator no calendar can resolve is dropped instead of sent.
 * ONE-1023: the model's direction words are the same filler knowledge drops, so they never ride a chat
 * search either; an operator and a quoted phrase survive.
 */
export function chatQuery(query: string, nowMs = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return query.replace(CHAT_DATE_OPERATOR, (_operator: string, kind: string, value: string): string => {
    const day = isoDay(value, nowMs, timeZone);
    return day === undefined ? '' : `${kind[0]!.toUpperCase()}${kind.slice(1)}:${day}`;
  }).split(/\s+/u).filter(Boolean)
    .filter(word => /^(?:after|before|on):/iu.test(word) || !(KNOWLEDGE_FILLER.has(word.replace(/[.:]+$/u, '').toLowerCase()) || META_WORDS.has(word.replace(/[.:]+$/u, '').toLowerCase()) || CONTINUATION_WORDS.has(word.replace(/[.:]+$/u, '').toLowerCase())))
    .join(' ');
}

/** MED-1022/T-R2: the closed token for a chat date operator, so the receipt never carries query text. */
export type ChatDateOperator = 'compiled' | 'dropped' | 'none';

/** Whether the chat wire carries an ISO day, lost one the caller wrote, or had none. */
export function chatDateOperator(original: string | undefined, compiled: string, windowDay?: string): ChatDateOperator {
  if (windowDay !== undefined && windowDay !== '') return 'compiled';
  if (/\b(?:after|before|on):/iu.test(compiled)) return 'compiled';
  return original !== undefined && /\b(?:after|before|on):/iu.test(original) ? 'dropped' : 'none';
}

// #647: a keyword search requires every term, so a paraphrased ask can miss where hybrid guessed. One
// broadened retry carries the single most specific word of the query instead of falling back to an
// embedding mode the chat budget cannot afford.

/** The longest content word of a chat query, or nothing when one term is all the query holds. */
function broadestChatTerm(query: string): string | undefined {
  const content = contentKeywords(query.replace(CHAT_DATE_OPERATOR, ' '), 8);
  if (content.length < 2) return undefined;
  return content.reduce((longest, word) => (word.length > longest.length ? word : longest));
}

/** A chat answer that named no post: the shaper's own closed phrase for a search that matched nothing. */
function chatSearchFoundNothing(text: string): boolean {
  const answer = text.trim();
  return answer === '' || answer === 'No messages matched.';
}

/** One empty multi-term chat read earns one retry with its single most specific term, and the reply says so. */
async function broadenedChatRetry(execute: (subs: readonly IntentSubCall[], signal: AbortSignal) => Promise<IntentSubResult[]>, subs: readonly IntentSubCall[], results: readonly IntentSubResult[], signal: AbortSignal, broadened: Map<string, string>): Promise<IntentSubResult[]> {
  let merged: readonly IntentSubResult[] = results;
  for (let index = 0; index < subs.length; index++) {
    const sub = subs[index]!;
    const result = merged[index];
    if (sub.name !== INTERNAL.chatSearch || broadened.has(sub.key) || result === undefined || !result.ok || !chatSearchFoundNothing(result.text)) continue;
    const term = broadestChatTerm(typeof sub.args['query'] === 'string' ? sub.args['query'] : '');
    if (term === undefined) continue;
    const args: JsonObject = { ...sub.args, query: term };
    try {
      const [retried] = await execute([{ key: sub.key, name: sub.name, args }], signal);
      // The retry ran, so the answer says the match was broadened either way, never that chat held nothing.
      broadened.set(sub.key, term);
      if (retried?.ok === true && !chatSearchFoundNothing(retried.text)) merged = merged.map((entry, at) => (at === index ? retried : entry));
    } catch { /* keep the empty first answer */ }
  }
  return [...merged];
}

/**
 * C-CHAT: what a chat read says beside its posts, kept for the reply: the conversation and window it read,
 * a capability the child lacks, the question it asks back, and the next page when it matched more than it
 * returned. The connector writes these as closed lead lines (tools/mattermost.ts `renderChatRead`).
 */
function noteChatReads(run: RunState, subs: readonly IntentSubCall[], results: readonly IntentSubResult[]): void {
  const add = (clause: string): void => { if (!run.chatNotes.includes(clause)) run.chatNotes.push(clause); };
  subs.forEach((sub, index) => {
    const result = results[index];
    if (result === undefined || !result.ok || !sub.name.startsWith('mattermost')) return;
    const lead = (name: string): string | undefined => new RegExp(`^${name}: (.+)$`, 'mu').exec(result.text)?.[1]?.trim();
    const read = lead('read');
    const missing = lead('note');
    const clarify = lead('clarify');
    const notFound = lead('not found');
    if (read !== undefined && clarify === undefined && notFound === undefined) add(`I read ${read}.`);
    if (missing !== undefined) add(`Say once: ${missing}.`);
    if (clarify !== undefined) { add(`Ask him: ${clarify}`); run.chatUnresolved = 'needs_clarification'; }
    if (notFound !== undefined) { add(notFound); run.chatUnresolved ??= 'name_not_found'; }
    const matched = Number(lead('matched') ?? Number.NaN);
    const returned = (result.text.match(/^\*\*.+\*\*$/gmu) ?? []).length;
    const offset = typeof sub.args['offset'] === 'number' ? sub.args['offset'] : 0;
    if (Number.isSafeInteger(matched) && returned > 0 && offset + returned < matched) run.chatPage = { sub, next: offset + returned, total: matched };
    else if (Number.isSafeInteger(matched)) delete run.chatPage;
  });
}

/** The ISO day a date word names, or nothing when it names none. */
function isoDay(word: string, nowMs: number, timeZone: string): string | undefined {
  const lower = word.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(lower)) return lower;
  const today = localDay(new Date(nowMs).toISOString(), timeZone);
  if (lower === 'today') return today;
  if (lower === 'yesterday') return dayShift(today, -1);
  if (lower === 'tomorrow') return dayShift(today, 1);
  if (!new RegExp(`^(?:this |last |next )?(?:${WEEKDAY_NAMES})$|^(?:this|last|next) week$`, 'iu').test(lower)) return undefined;
  try { return localDay(windowRange(lower.replace(/^this /u, ''), nowMs, timeZone).timeMin, timeZone); } catch { return undefined; }
}

/** The internal sub-calls one candidate issues. `brief` fans out over every configured source. */
export function candidateSubs(kind: CandidateKind, config: { question: string; topic?: string | undefined; ownerWords?: string | undefined; configured: readonly SourceKind[]; evidence: ReadonlyMap<CandidateKind, string>; query?: string | undefined; window?: string | undefined; nowMs?: number | undefined; timeZone?: string | undefined }): IntentSubCall[] {
  const search = (name: string, args: JsonObject, key: string): IntentSubCall => ({ key, name, args });
  // #565: the topic's words, and only the numbers the owner said in this run, are what a source may search.
  const ownerWords = config.ownerWords ?? config.question;
  const topicText = topicTerms(config.topic, ownerWords, config.configured);
  if (kind === 'knowledge_search') {
    // Q5-R1: a named entry is read by id through the connector's get_insight path, never searched for
    // again; the connector returns its whole body up to the knowledge body cap.
    const ids = namedInsightIds(config.question, config.query);
    if (ids.length) return [search(INTERNAL.knowledgeRead, { ids } as JsonObject, 'kr0')];
    // K3: a clipped keyword query, never the owner's sentence or the selector's paraphrase of it.
    // K6: with no model query, a question of pure filler is no question to search at all.
    // E1 (#605): the topic is the search text; a model written query only fills in when no topic was named.
    const modelQuery = config.query === undefined ? undefined : withoutRouteWords(ownerDigits(config.query, ownerWords), config.configured);
    const fromTopic = topicText === undefined ? '' : knowledgeQuery(topicText);
    const query = fromTopic !== '' ? fromTopic : knowledgeQuery(modelQuery ?? '', '');
    if (!query) return [];
    const meeting = meetingBounds(config.question, config.query, config.nowMs ?? Date.now(), config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    return [search(INTERNAL.knowledgeSearch, knowledgeSearchArgs(query, projectHintOf(config.question), meeting), 'k0')];
  }
  if (kind === 'calendar_window') {
    // Research keeps the declared primary-calendar scope. #5: the window is the owner's own, and a
    // window the grammar cannot parse dispatches nothing instead of silently reading today.
    let range: { timeMin: string; timeMax: string };
    // A question that names no window reads today, the connector's own default; an ambiguous or
    // unreadable one dispatches nothing.
    try { range = windowRange(config.window ?? calendarWindowOf(config.question, 'today'), config.nowMs ?? Date.now(), config.timeZone); }
    catch { return []; }
    return [search(INTERNAL.calendarList, { calendarId: 'primary', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.pageResults.calendar }, 'cal0')];
  }
  if (kind === 'company_metric') {
    // W3-R1: a count question is the data endpoint's two calls, on the topic's words. A count the ask
    // leaves undated is refused by the host, never dispatched as the all-time sum the fixture recorded.
    const asked = config.query === undefined ? '' : withoutRouteWords(config.query, config.configured).trim();
    const words = asked !== '' ? asked : (topicText ?? '').trim();
    if (words === '' || !config.configured.includes('data')) return [];
    const metric = companyMetricSubs(words, config.question, config.nowMs ?? Date.now());
    return 'refusal' in metric ? [] : metric.subs;
  }
  if (kind === 'company_search') {
    // #639: the company read is the typed lookup's own read, on the topic's words and its mode, so the
    // question-only path answers with the same entity read the model's `company` lookup answers with.
    const asked = config.query === undefined ? '' : withoutRouteWords(config.query, config.configured).trim();
    const words = asked !== '' ? asked : (topicText ?? '').trim();
    if (words === '' || !config.configured.includes('mongoose')) return [];
    return companySubs(words);
  }
  if (kind === 'mail_search') {
    // #565: a bare inbox scan stays a scan; a topic or a model query is compiled from the topic.
    // #564: a triage ask is never a bare scan, whatever prose the selector or the model wrote for it.
    const bare = config.query === undefined && topicText === undefined && !triageAsk(config.question);
    return [search(INTERNAL.mailList, { q: bare ? 'in:inbox newer_than:2d' : compileMailQuery(config.question, config.query, config.nowMs ?? Date.now(), config.timeZone, config.topic, ownerWords, undefined, config.configured), maxResults: RESEARCH.pageResults.mail }, 'm0')];
  }
  if (kind === 'mail_open') { const id = config.evidence.get('mail_search'); return id ? [search(INTERNAL.mailRead, { id }, 'mo0')] : []; }
  if (kind === 'chat_search') {
    // DATES-R1 F3 and DATES-R2 F4: with no content term left, the recency window is the only useful thing
    // to send, so an empty query is never dispatched, whoever wrote the query text.
    // #572: a triage ask reads what needs an answer, newest first over its own window, never a search
    // ranked by relevance over the whole archive.
    if (triageAsk(config.question)) return [search(INTERNAL.chatAttention, { days: TRIAGE_DAYS } as JsonObject, 'ca0')];
    // E1 (#605): the topic is the chat search text; a model written query only fills in when no topic
    // was named, so the question's own prose never becomes the search.
    const chatModelQuery = config.query === undefined ? undefined : ownerDigits(config.query, ownerWords);
    const fromTopic = topicText === undefined ? '' : chatQuery(topicText, config.nowMs, config.timeZone);
    const compiled = fromTopic !== '' ? fromTopic : chatQuery(chatModelQuery ?? 'after:yesterday', config.nowMs, config.timeZone);
    const terms = compiled.replace(CHAT_DATE_OPERATOR, '').replace(/\s+/gu, ' ').trim();
    // C-CHAT: the ask's shape picks the read: a person, the overview with a person, a channel, a group chat,
    // or a plain topic search. The window looks backwards and both of its ends ride the tool's own arguments.
    const intent = chatIntent(config.question, { terms, nowMs: config.nowMs ?? Date.now(), timeZone: config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
    return chatSubs(intent, RESEARCH.chatLines, chatQuery('after:yesterday', config.nowMs, config.timeZone));
  }
  if (kind === 'chat_thread') { const id = config.evidence.get('chat_search'); return id ? [search('mattermost_get_thread', { post_id: id }, 'ct0')] : []; }
  if (kind === 'drive_search') return config.configured.includes('drive') ? driveSubs(config.query ?? topicText ?? '', ownerWords) : [];
  if (kind === 'web_search') return config.configured.includes('web')
    ? [search(WEB_SEARCH_ACTION, { query: config.query === undefined ? (topicText ?? '') : ownerDigits(config.query, ownerWords) }, 'w0')] : [];
  if (kind === 'brief') {
    const subs: IntentSubCall[] = [];
    // ROUTE-1022 K5: a brief reads his own knowledge, and the layers the question itself names. The
    // router's own source words decide, so a question about the business model reads no inbox at all.
    const named = new Set(ROUTE_CLASSES.filter(route => routeWanted(route, config.question)).map(route => route.source));
    // A brief reads primary events; calendar names alone are not findings.
    if (config.configured.includes('calendar') && named.has('calendar')) {
      const range = windowRange('today', config.nowMs ?? Date.now(), config.timeZone);
      subs.push(search(INTERNAL.calendarList, { calendarId: 'primary', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.pageResults.calendar }, 'b0'));
    }
    if (config.configured.includes('mail') && named.has('mail')) subs.push(search(INTERNAL.mailList, { q: 'newer_than:2d' }, 'b1'));
    if (config.configured.includes('chat') && named.has('chat')) subs.push(search(INTERNAL.chatSearch, { query: chatQuery('after:yesterday', config.nowMs, config.timeZone), limit: RESEARCH.chatLines }, 'b2'));
    // K3: the brief's knowledge read is shaped the same way, so no dispatch carries a sentence.
    // K5: the question's own terms. A question with no compiled term still reads his knowledge once,
    // on its own words, so a vague question never leaves every read to another action; a pure
    // instruction start ("wait findings.") has nothing to search and reads nothing.
    const query = knowledgeQuery(topicText ?? '');
    const asked = query === '' && !metaOnlyQuestion(config.question) ? (topicText ?? '') : query;
    if (config.configured.includes('knowledge') && asked !== '') subs.push(search(INTERNAL.knowledgeSearch, knowledgeSearchArgs(asked, projectHintOf(config.question)), 'b3'));
    return subs;
  }
  return [];
}

const MAIL_ID_TAG = /\[id ([A-Za-z0-9_-]+)\]/;
const POST_ID_TAG = /\[post ([A-Za-z0-9_-]+)\]/;

/** The first mail or chat id the shaped list line carried, for a follow-up read. */
export function extractId(kind: CandidateKind, text: string): string | undefined {
  if (kind === 'mail_search') return text.match(MAIL_ID_TAG)?.[1] ?? text.match(/\b([0-9a-f]{16})\b/i)?.[1];
  if (kind === 'chat_search') return text.match(POST_ID_TAG)?.[1] ?? text.match(/\b([A-Za-z0-9]{20,})\b/)?.[1];
  return undefined;
}

/** Every insight id the shaped or raw knowledge text carried, in order, for hydration. Handles the
 * shaped `[id N]` form, the raw `## #N [type]` heading form and the real `**#N** [TYPE] title` item. */
export function extractInsightIds(text: string, max = 3): number[] {
  const ids: number[] = [];
  const push = (value: string | undefined): void => {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  };
  for (const line of text.split('\n')) {
    if (ids.length >= max) break;
    push(line.match(/\[id (\d+)\]/)?.[1] ?? line.match(/^#{2,3}\s*#(\d+)\b/)?.[1] ?? line.match(/\*\*#(\d+)\*\*/)?.[1]);
  }
  return ids;
}


// ---------------------------------------------------------------------------------------------
// Ledger

export type LedgerKind = CandidateKind | 'memory_search';

export interface LedgerEntry { bodyOnly?: boolean; kind: LedgerKind; source: SourceKind | null; summary: string; lines?: string[]; total?: number }
interface MailRead {
  args: JsonObject; messages: Map<string, MailMessage>; bindings: ToolResultBinding[];
  tokens: Set<string>; nextPageToken?: string; exhausted: boolean; failed: boolean;
  received: number; invalid: number; upstreamIncomplete?: boolean; inflight?: boolean;
  /** Release 4: pages a later page lost, so a read that already delivered is partial, never failed. */
  failedPages?: number;
  /** F2: pages this read has already taken, so one question never pages a mailbox without end. */
  pages: number;
  /** A connector answer that carried text but no page envelope is one read, kept whole. */
  plain?: string;
  /** The connector's own failure code, kept so the sub-call log names the real reason. */
  code?: string;
  /** E5: the one broader read a search that matched nothing ran, so the receipt can name both shapes. */
  retry?: MailRead;
  /** C-LIVE: the last page's own duration, the totals pages reported, and a page the operation bound did not start. */
  lastPageMs?: number; pageTotals?: number[]; boundStop?: boolean;
}
type RemoteBody = Extract<HostEvidenceRef, { kind: 'remote-body' }>;
interface ReceivedBody { evidence: RemoteBody; binding: ToolResultBinding; source: SourceKind; offset: number }
interface BodyCursor { key: string; offset: number; end: number; nextCursor?: string; canContinue?: boolean; delivered: boolean }
const bodyDelivery = Symbol('bodyDelivery');
interface BodyDelivery { researchId: string; runId: number; cursor: string }
type BodyReply = JsonObject & { [bodyDelivery]?: BodyDelivery };
type CompactionReply = JsonObject & { [compactionDelivery]?: { items: number } };
interface MailCursor { signature: string; scope: string; sourceState?: string; delivered: boolean; ids: string[]; nextCursor?: string; partial?: boolean }
const mailDelivery = Symbol('mailDelivery');
/** LAT-1023: whole items this reply dropped to fit the Live budget, carried on the reply and never serialized. */
const compactionDelivery = Symbol('compactionDelivery');
interface MailDelivery { researchId: string; runId: number; keys: string[]; cursor?: string; nextCursor?: string }
type MailReply = JsonObject & { [mailDelivery]?: MailDelivery };
const calendarDelivery = Symbol('calendarDelivery');
interface CalendarDelivery { researchId: string; runId: number; keys: string[] }
type CalendarReply = JsonObject & { [calendarDelivery]?: CalendarDelivery };
/**
 * E8: one live session's completed calendar reads and its calendar list. Keyed by the exact read arguments
 * of a session bound to one owner; it is never persisted and never outlives the live session that made it.
 */
export interface ResearchMemo {
  calendar: Map<string, { at: number; events: Map<string, RetainedCalendarEvent> }>;
  calendarList?: { scope: CalendarScope; notRead?: string };
  /** F2: one mail read per query for the live session, so a follow-up continues from its cursor. */
  mail?: Map<string, MailRead>;
  /** F6: an identical internal read this session already completed inside the turn window. */
  reads?: Map<string, { at: number; result: IntentSubResult }>;
}
interface CalendarRead {
  args: JsonObject; events: Map<string, RetainedCalendarEvent>; bindings: ToolResultBinding[];
  tokens: Set<string>; nextPageToken?: string; exhausted: boolean; failed: boolean;
  bodyTruncated: boolean; unread: number; upstreamIncomplete?: boolean; inflight?: boolean;
  /** The connector's own failure code, kept so the sub-call log names the real reason. */
  code?: string;
  /** C-LIVE: the last page's own duration, and a page the operation bound did not start. */
  lastPageMs?: number; boundStop?: boolean;
  /** LOGS.md L-01: the words a page carried when it brought no event, so a refusal is never an empty window. */
  plain?: string;
}
export interface RunState {
  /** C-LIVE: the moment this operation must have answered by; no page starts that cannot finish before it. */
  operationDeadlineAt?: number;
  /** L8-06: the sources this call is reading right now (the first answer's own set, the web read included). */
  reading?: Set<SourceKind>;
  /** #575: the start of the call before this one, so her own lines from the last two calls stay out of memory evidence. */
  previousCallAt?: number;
  /** #575: finding texts this session already delivered, shared by every run of the session. */
  deliveredFindings: Set<string>;
  bodies: Map<string, ReceivedBody>; bodyCursors: Map<string, BodyCursor>; bodyCursorRequested?: string;
  mail: Map<string, MailRead>; mailDelivered: Set<string>; mailCursors: Map<string, MailCursor>; mailCursorRequested?: string; mailDeadlineAt?: number; mailRateRetried?: boolean;
  historyBindings: ToolResultBinding[]; historyTokens: Set<string>;
  /** F2: the owner's own words behind each compiled Gmail query, so a live step speaks them. */
  ownerQueries: Map<string, string>;
  /** E6 (#609): the message date a read may not go behind, for an ask that named only hours. */
  mailSince: Map<string, number>;
  /** ONE-1023: the day-filtered knowledge reads whose filter was dropped for a retry, by their own args. */
  droppedDayFilters: Set<string>;
  /** #647: the chat reads a broadened retry answered, by their sub key, with the one term that was sent. */
  broadenedChat: Map<string, string>;
  calendarScopeAttempted?: boolean;
  /** N3: the counted note the calendar list supports, for the routed answer that carries no raw list. */
  calendarNotRead?: string;
  calendar: Map<string, CalendarRead>; calendarDelivered: Set<string>; calendarScope?: CalendarScope;

  researchId: string; runId: number; questionClass: QuestionClass; direction: string | undefined;
  /** #565: the call signatures whose query shape was already recorded, so one call is one row. */
  shaped: Set<string>;
  /** #565: the names and nouns this run was opened with, and the only text whose words reach a source. */
  topic?: string;
  /** Release 4: the question this run was opened with, so a continuation hop never searches on the model's meta words alone. */
  question?: string;
  /** #451 H22: the model call this run answers, the adapter's own call id (ruling W6-R1). */
  callKey?: string;
  /** #1020: the moment the call answered ahead of its readers, so a later cut is logged partial, not failed. */
  answeredAt?: number;
  /** #1020: the owner's zone, so a calendar coverage line names the days the owner lives in. */
  timeZone?: string;
  /** MED-1022: the chat date operator this run compiled, dropped or never wrote, for the receipt. */
  chatDate?: ChatDateOperator;
  startedAt: number; deadlineMs: number; rounds: number; maxRounds: number; ops: number;
  progressAbort: AbortController;
  cancelled: boolean; ended: boolean; stopped: boolean; ledger: Map<string, LedgerEntry>;
  evidence: Map<CandidateKind, string>; readKinds: Set<CandidateKind>; sourcesDone: Set<SourceKind>; sourcesFailed: Set<SourceKind>;
  /** K8b: sources whose read is in flight right now, so a later call can wait for them and never calls the run complete. */
  pending: Set<SourceKind>;
  /** K8a: this run was opened by a contentless start that stood in for a continue. */
  metaStartAsContinue: boolean;
  /** K14: whole-body replies this run sent, so one body costs one round trip each page. */
  bodyReplies: number;
  /** L10: dispatches this run aborted because a new start replaced it. */
  supersededAborts: number;
  /** K8b: calls waiting on this run's in-flight reads, woken when the last one settles. */
  pendingWaiters: Set<() => void>;
  /** WEB: the transcript cards and retrieval time of the web read this run made, so the chat keeps the links. */
  web: { title: string; url: string; retrievedAt: string }[];
  /** WEB: Gemini's search entry point links, shown in the transcript as the grounding attribution. */
  webAttribution: { title: string; url: string }[];
  /** Read signatures already issued this run, so an identical duplicate read is never executed twice. */
  calls: Set<string>;
  /** Per source, the query shape a search that matched nothing used, for a line the model can voice. */
  emptySearches: Map<SourceKind, string>;
  /** N3: sources whose read a deadline cut short, so the reply can say so instead of "nothing matched". */
  cutShort: Set<SourceKind>;
  /** L8-13: a source whose latest read never dispatched a page, so its label is never a timeout. */
  neverRan?: Set<SourceKind>;
  /** P5: why a source cannot serve a read right now, so the reply names the cause and never guesses. */
  unavailableReasons: Map<SourceKind, string>;
  /** LOGS.md L-01: the owner line one source's classified failure spoke, so the reply can say it. */
  failureLines: Map<SourceKind, string>;
  /** #637: the channel the ask named, kept so an unknown one is said in the owner's own words. */
  chatChannel?: string;
  /** #663: the closest channel names the connector's refusal carried, so the reply can voice them. */
  chatChannelClosest: string[];
  /** C-CHAT: what each chat read said it read, a capability it lacks, or the question it asks back. Said once. */
  chatNotes: string[];
  /** C-CHAT: a chat read asked which person, channel or group was meant, or knew nobody by that name. */
  chatUnresolved?: 'needs_clarification' | 'name_not_found';
  /** C-CHAT: the next page of the last chat read that matched more than it returned. */
  chatPage?: { sub: IntentSubCall; next: number; total: number };
  /** #621: the sources this ask routed to, whether or not the session configured them, for the header. */
  route: Set<SourceKind>;
  /** #621: sources that already spent their one broadened retry, so a zero-hit read retries exactly once. */
  retried: Set<SourceKind>;
  /** #657 item 1: the sources a status ask has not read yet, so the next call in this run reads them. */
  deferredSources?: SourceKind[];
  /** #654: this run was opened fresh because an old researchId carried a new source or topic. */
  startedFresh?: boolean;
  /** C-DEPTH item 3 (W10-R6): the full entry read of this run was cut, so the summaries are what shipped. */
  knowledgeFetchCut?: boolean;
}

function invalidateEvidence(run: RunState): void {
  run.bodies.clear(); run.bodyCursors.clear();
  run.mail.clear(); run.mailDelivered.clear(); run.mailCursors.clear();
  run.calendar.clear(); run.calendarDelivered.clear(); run.historyBindings = []; run.historyTokens.clear();
  for (const [key, entry] of run.ledger) if (entry.source === 'calendar' || entry.source === 'mail') run.ledger.delete(key);
}

/** Session-local in-memory ledger. Nothing here is persisted or logged beyond its metadata. */
export class ResearchLedger {
  #runs = new Map<string, RunState>();
  #counter = 0;
  #activeId: string | undefined;
  #last: RunState | undefined;
  /** #575: what this session already told the model, so a repeat costs one line instead of a block. */
  readonly deliveredFindings = new Set<string>();
  constructor(private readonly releaseEvidence?: (bindings: readonly ToolResultBinding[]) => void) {}

  begin(input: { researchId?: string | undefined; questionClass: QuestionClass; direction?: string | undefined; question?: string | undefined; topic?: string | undefined; deadlineMs: number; maxRounds: number; now: number; callKey?: string | undefined }): RunState {
    const researchId = input.researchId ?? randomUUID();
    const previousCallAt = this.#last?.startedAt;
    const run: RunState = {
      ...(previousCallAt === undefined ? {} : { previousCallAt }), deliveredFindings: this.deliveredFindings,
      researchId, runId: ++this.#counter, shaped: new Set<string>(), questionClass: input.questionClass, direction: input.direction,
      ...(input.question === undefined ? {} : { question: input.question }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.callKey === undefined ? {} : { callKey: input.callKey }),
      startedAt: input.now, deadlineMs: input.deadlineMs, rounds: 0, maxRounds: input.maxRounds, ops: 0,
      progressAbort: new AbortController(), cancelled: false, ended: false, stopped: false,
      bodies: new Map(), bodyCursors: new Map(), mail: new Map(), mailDelivered: new Set(), mailCursors: new Map(),
      historyBindings: [], historyTokens: new Set(), calendar: new Map(), calendarDelivered: new Set(), ledger: new Map(), evidence: new Map(), readKinds: new Set(), sourcesDone: new Set(), sourcesFailed: new Set(),
      calls: new Set(), emptySearches: new Map(), cutShort: new Set(), unavailableReasons: new Map(), failureLines: new Map(), chatChannelClosest: [], chatNotes: [], route: new Set(), retried: new Set(), ownerQueries: new Map(), mailSince: new Map(), droppedDayFilters: new Set(), broadenedChat: new Map(), web: [], webAttribution: [], pending: new Set(), metaStartAsContinue: false, bodyReplies: 0, supersededAborts: 0, pendingWaiters: new Set(),
    };
    this.#runs.set(researchId, run);
    this.#activeId = researchId;
    this.#last = run;
    return run;
  }

  /** Continue inherits the completed ledger with a fresh budget and the optional direction. */
  resume(researchId: string, input: { direction?: string | undefined; deadlineMs: number; maxRounds: number; now: number }): RunState | undefined {
    const existing = this.#runs.get(researchId);
    if (!existing || existing.cancelled || existing.stopped) return undefined;
    // K8b: a continue while a read is still in flight keeps that very run, so the read lands in the state
    // this call reads instead of a discarded copy.
    if (!existing.ended) {
      existing.startedAt = input.now; existing.deadlineMs = input.deadlineMs; existing.maxRounds = Math.max(existing.rounds, input.maxRounds);
      existing.direction = input.direction ?? existing.direction; existing.ended = false; existing.stopped = false;
      delete existing.bodyCursorRequested; delete existing.mailCursorRequested;
      this.#activeId = researchId; this.#last = existing;
      return existing;
    }
    const run: RunState = {
      ...existing, bodies: new Map([...existing.bodies].map(([key, body]) => [key, { ...body }])), bodyCursors: new Map([...existing.bodyCursors].map(([key, page]) => [key, { ...page }])), runId: ++this.#counter, direction: input.direction ?? existing.direction,
      startedAt: input.now, deadlineMs: input.deadlineMs, maxRounds: input.maxRounds,
      rounds: 0, ops: 0, progressAbort: new AbortController(), cancelled: false, ended: false, stopped: false,
      mail: new Map([...existing.mail].map(([key, read]) => [key, { ...read, messages: new Map(read.messages), bindings: [...read.bindings], tokens: new Set(read.tokens), failed: read.failed || Boolean(read.inflight), inflight: false }])), mailDelivered: new Set(existing.mailDelivered), mailCursors: new Map([...existing.mailCursors].map(([key, cursor]) => [key, { ...cursor, ids: [...cursor.ids] }])),
      historyBindings: [...existing.historyBindings], historyTokens: new Set(existing.historyTokens),
      calendar: new Map([...existing.calendar].map(([key, read]) => [key, { ...read, events: new Map(read.events), bindings: [...read.bindings], tokens: new Set(read.tokens), failed: read.failed || Boolean(read.inflight), inflight: false }])), calendarDelivered: new Set(existing.calendarDelivered),
      ledger: new Map(existing.ledger), evidence: new Map(existing.evidence), readKinds: new Set(existing.readKinds), sourcesDone: new Set(existing.sourcesDone), sourcesFailed: new Set(existing.sourcesFailed), pending: new Set(existing.pending), pendingWaiters: new Set(),
      calls: new Set(existing.calls), emptySearches: new Map(existing.emptySearches), cutShort: new Set(existing.cutShort),
      unavailableReasons: new Map(existing.unavailableReasons), failureLines: new Map(existing.failureLines), chatChannelClosest: [], chatNotes: [], web: [...existing.web], webAttribution: [...existing.webAttribution],
    };
    delete run.bodyCursorRequested; delete run.mailDeadlineAt; delete run.mailCursorRequested;
    existing.cancelled = true; existing.progressAbort.abort();
    this.#runs.set(researchId, run);
    this.#activeId = researchId;
    this.#last = run;
    return run;
  }

  find(researchId: string): RunState | undefined { return this.#runs.get(researchId); }
  last(): RunState | undefined { return this.#last; }
  /** A new `start` cancels the previous active run. */
  cancelActive(): void {
    const active = this.#activeId ? this.#runs.get(this.#activeId) : undefined;
    if (active) { this.releaseEvidence?.(this.evidenceBindings(active.researchId)); active.cancelled = true; active.progressAbort.abort(); invalidateEvidence(active); }
  }
  stop(researchId?: string): RunState | undefined {
    const run = researchId === undefined ? this.#last : this.#runs.get(researchId);
    if (run) { this.releaseEvidence?.(this.evidenceBindings(run.researchId)); run.stopped = true; run.ended = true; run.progressAbort.abort(); invalidateEvidence(run); }
    return run;
  }
  close(): void { for (const run of this.#runs.values()) { this.releaseEvidence?.(this.evidenceBindings(run.researchId)); run.cancelled = true; run.progressAbort.abort(); invalidateEvidence(run); } }
  evidenceBindings(researchId: string): ToolResultBinding[] {
    const run = this.#runs.get(researchId);
    return run && !run.cancelled && !run.stopped ? [...[...run.bodies.values()].map(body => body.binding), ...run.historyBindings, ...[...run.mail.values()].flatMap(read => read.bindings), ...[...run.calendar.values()].flatMap(read => read.bindings)] : [];
  }
  evidenceCurrent(researchId: string): boolean { const run = this.#runs.get(researchId); return Boolean(run && !run.cancelled && !run.stopped); }
  discardEvidence(bindings: readonly ToolResultBinding[]): void { this.releaseEvidence?.(bindings); }
  deliveredBody(delivery: BodyDelivery): void {
    const run = this.#runs.get(delivery.researchId);
    if (!run || run.runId !== delivery.runId || run.cancelled || run.stopped) return;
    const page = run.bodyCursors.get(delivery.cursor), body = page && run.bodies.get(page.key);
    if (!page || !body || body.offset !== page.offset) return;
    body.offset = page.end; page.delivered = true;
  }
  deliveredMail(delivery: MailDelivery): void {
    const run = this.#runs.get(delivery.researchId);
    if (!run || run.runId !== delivery.runId || run.cancelled || run.stopped) return;
    for (const key of delivery.keys) if ([...run.mail.values()].some(read => read.messages.has(key))) run.mailDelivered.add(key);
    for (const page of run.mailCursors.values()) if (page.ids.length > 0 && page.ids.every(id => run.mailDelivered.has(id))) page.delivered = true;
    const cursor = delivery.cursor ? run.mailCursors.get(delivery.cursor) : undefined;
    if (cursor && cursor.ids.length === 0) cursor.delivered = true;
  }
  delivered(researchId: string, runId: number, keys: readonly string[]): void {
    const run = this.#runs.get(researchId);
    if (!run || run.runId !== runId || run.cancelled || run.stopped) return;
    for (const key of keys) if ([...run.calendar.values()].some(read => read.events.has(key))) run.calendarDelivered.add(key);
  }
}

// ---------------------------------------------------------------------------------------------
// Run

/** #451 H22 (W6-R1): the model call a run answers, the adapter's own call id, which is the value
 *  `trace_call.provider_call_id` already holds, so one call reads across host.log and the trace. */
const callKeyOf = (run: RunState): { callKey?: string } => (run.callKey === undefined ? {} : { callKey: run.callKey });
/** The resolved calendar window as two dates, never the query that produced it. */
const windowDates = (window: string, now: number, timeZone: string): { windowFrom?: string; windowTo?: string } => {
  const range = windowRange(window, now, timeZone);
  return { windowFrom: range.timeMin.slice(0, 10), windowTo: range.timeMax.slice(0, 10) };
};

/** R6: one metadata-only line for the moment a call answered ahead of the sources still reading. */
export interface ResearchFirstAnswer {
  event: 'research_first_answer'; researchId: string; ms: number; settled: SourceKind[]; pending: SourceKind[];
  /** R3/R7: how the answer was reached, and how long the owner waited for it. A full answer logs `research_answer`. */
  kind: 'early' | 'hard_stop'; elapsedMs: number;
}

/** R6: one event per source that settles after the first answer. Only what the source really returned. */
export interface ResearchLateFindings {
  researchId: string; runId?: number; calendarKeys?: string[]; mailKeys?: string[]; source: SourceKind; ms: number; items: string[]; ok: boolean;
  /** #472: the run was cut (cancelled or stopped) before this source settled, so silence here is a cut, not a failure. */
  cut?: boolean;
}

export interface ResearchProgress {
  researchId: string; phase: 'started' | 'round' | 'done' | 'stopped';
  /** #451 H22: the model call this run answers, the id `trace_call.provider_call_id` records. */
  callKey?: string;
  sourcesDone: SourceKind[]; sourcesPending: SourceKind[]; elapsedMs: number;
}
export type ResearchDriver = 'selector' | 'fallback' | 'single-source-hint' | 'routed';

/** ROUTE-R2: the closed reason a run log gives for a skipped source, so a grant gap never reads as an outage. */
export const SKIP_REASONS = ['not_configured', 'not_granted', 'endpoint_unavailable', 'window_unparsed', 'timeout', 'read_failed'] as const;
export type SkipReason = typeof SKIP_REASONS[number];

/** N6 (#569): a cut web read is its own closed reason, so a deadline never reads as an endpoint outage. */
function webReasonOf(code: string, reason?: string): string {
  if (code === 'web_insufficient') return `web_insufficient:${reason ?? 'ungrounded'}`;
  return code === 'web_timeout' ? 'timeout' : code;
}

export function skipReasonOf(rawReason: string | undefined, outcome: LookupOutcome): SkipReason {
  if (rawReason === 'not_configured') return 'not_configured';
  if (rawReason === 'source_not_granted') return 'not_granted';
  // Release 4: a window the grammar cannot resolve is its own closed reason, never an endpoint outage.
  if (rawReason === 'window_unparsed') return 'window_unparsed';
  // N6 (#569): a reason the read itself stored as timeout is a timeout, never an endpoint outage.
  if (outcome === 'timeout' || rawReason === 'timeout' || rawReason === 'deadline_exhausted' || rawReason === 'cancelled') return 'timeout';
  if (outcome === 'unavailable' || rawReason !== undefined) return 'endpoint_unavailable';
  return 'read_failed';
}

/**
 * #663: which branch of the scheduler answered a call, so the host log says why a research call read nothing:
 * a fresh start, a join of a run in flight, a repeat of an answer already in the turn window, a continuation,
 * a status or stop answer, or the delegation ceiling.
 */
export const RESEARCH_BRANCHES = ['start', 'join', 'recent', 'continue', 'status', 'ceiling'] as const;
export type ResearchBranch = typeof RESEARCH_BRANCHES[number];

export interface ResearchRunLog {
  event: 'research_run'; researchId: string; questionClass: QuestionClass; rounds: number;
  perRound: { candidates: { kind: CandidateKind; pUseful: number }[]; chosen: CandidateKind[] }[];
  stopReason: string; status: 'answered' | 'partial' | 'stopped' | 'unavailable' | 'failed'; ops: number;
  sources: { kind: SourceKind; disposition: string; latencyMs: number; reason?: SkipReason }[];
  elapsedMs: number; deadAirMs: number; selectorMs: number; fallbackUsed: boolean; replyBytes: number;
  driver?: ResearchDriver;
  unchecked?: SourceKind[]; canContinue?: boolean; findingChars?: number[];
  /** LAT-1023: the round cap ended the run at this many rounds with evidence left unread. */
  roundCapHit?: number;
  /** LAT-1023: the answer was compacted to its character budget, whole items dropped and the bytes sent. */
  answerCompacted?: { items: number; chars: number };
  /** ROUTE-1022 K5: the plan a brief actually ran, closed token only. */
  plan?: 'knowledge_only' | 'named_sources';
  bodyReplies?: number; metaStartAsContinue?: boolean; supersededAborts?: number;
}

/** Q1: one metadata-only record per internal sub-call: counts and bytes, never the query or text. */
export interface ResearchSubcallLog {
  event: 'research_subcall'; researchId: string; kind: LedgerKind; tool: string; ok: boolean; callKey?: string;
  /** Calendar reads only: the resolved window as two dates, never the query that produced it. */
  windowFrom?: string; windowTo?: string;
  errorCode?: string; items: number; rawBytes: number; keptBytes: number; queryChars: number;
  queryAuthor: 'routed' | 'fallback' | 'hint';
  /** Calendar sub-calls only: the resolved window kind, a closed enum, never a time or title. */
  window?: WindowKind;
  /** Calendar sub-calls only: how many selected calendars the read did not reach before the deadline. */
  unread?: number;
}

/** A one-shot timer seam, so a test drives progress beats with a fake clock instead of wall time. */
export type ResearchTimer = (callback: () => void, delayMs: number) => { unref(): void; cancel(): void };

const scheduleTimer: ResearchTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return { unref: () => { timer.unref(); }, cancel: () => { clearTimeout(timer); } };
};

/**
 * RUN-R7: a read's own deadline is cut on the run's clock, never on wall time, so a run settles inside its
 * budget whatever the reads do. The caller releases the timer when the read it bounds settles.
 */
function cutAfter(ms: number, schedule: ResearchTimer = scheduleTimer): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = schedule(() => controller.abort(new DOMException('Source deadline elapsed', 'TimeoutError')), Math.max(1, ms));
  return { signal: controller.signal, done: () => { timer.cancel(); } };
}

/** #565: the shape one source call searched with: counts and closed operator tokens, never a word. */
export interface ResearchQueryShape { source: Exclude<SourceKind | LookupSource, 'drive'>; terms: number; operators: readonly string[]; topicWords: number }

export interface ResearchDeps {
  timeZone?: string;
  /** C-DEPTH item 3: the stage two bound for this run, so a test drives it without a real wait. */
  knowledgeReadMs?: number | undefined;
  /** C-DEPTH item 3 (W10-R6): the full entry read was cut, so the summaries are what shipped. */
  /** L11-03: the live call this research runs in. Its own rows are never memory, by identity. */
  liveSessionId?: string | undefined;
  /**
   * #565: one row per source call's query shape, so the next forensic review can prove what a search was
   * built from. The Live owner binds it to the trace store; absent means nothing is persisted.
   */
  queryShape?: ((shape: ResearchQueryShape & { researchId: string; at: number }) => void) | undefined;
  /** L8-Q06: one row per web read, which leaves no canonical dispatch row; the query text stays in the store. */
  sourceRead?: ((read: ResearchSourceRead) => void) | undefined;
  authorizeEvidence?: (bindings: readonly ToolResultBinding[], signal: AbortSignal) => boolean;
  now(): number;
  /** Defaults to a real timer; a test supplies a fake clock to prove the progress cadence. */
  schedule?: ResearchTimer | undefined;
  configured: readonly SourceKind[];
  /** Re-resolved per run so a connector that comes up or down mid-session is reported truthfully. */
  configuredNow?: (() => readonly SourceKind[]) | undefined;
  /** WEB: the public web read. Present means the web part is configured; absent means it is not offered. */
  web?: WebSearchPort | undefined;
  /**
   * #351: the sources whose connector cannot serve a read right now. A lookup settles `unavailable` at
   * once instead of spending its deadline on sub-calls that cannot reach a stopped connector. P5: an
   * entry may carry its reason (a credential failure, a stop), so the reply names the cause.
   */
  unavailableNow?: (() => readonly (SourceKind | UnavailableSource)[]) | undefined;
  execute(subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]>;
  emit(event: ResearchProgress): void;
  log(event: ResearchRunLog): void;
  /** One metadata-only line per research call, naming the branch that answered it. */
  logJoined?: ((researchId: string, branch: ResearchBranch) => void) | undefined;
  /** Metadata-only per-sub-call log; defaults to the host log sink. Never the query or result text. */
  logSubcall?: ((event: ResearchSubcallLog) => void) | undefined;

  /** One live step per source as it starts and ends; defaults to the host event the Live owner
   *  forwards to the voice view. Never a message body, never an id. */
  step?: ((step: LiveToolStepBody) => void) | undefined;
  /** R6: one receipt for the first answer point, metadata only; defaults to the host log sink. */
  logFirstAnswer?: ((event: ResearchFirstAnswer) => void) | undefined;
  /**
   * R6: a source settled after the first answer went out. The host builds the block and decides how it is
   * delivered; the loop itself never speaks and never cancels a reader for it.
   */
  late?: ((event: ResearchLateFindings) => void) | undefined;
  /** R6: the readers a first answer left running, handed over so their completion can be awaited. */
  background?: ((done: Promise<void>) => void) | undefined;
  /** K6: one metadata-only receipt per routed call; defaults to the host log sink. */
  logRouted?: ((event: ResearchRoutedLog) => void) | undefined;
  /** N3/P5: one metadata-only receipt per source read, so its outcome, ms and deadline survive in the host log. */
  logSource?: ((event: ResearchSourceLog) => void) | undefined;

  ledger: ResearchLedger;
  replyLimit?: number;
  /** E8: the one live session's read memo, supplied by the scheduler so a repeat or a superseded read is free. */
  memo?: ResearchMemo | undefined;
}

export interface ResearchCall { cursor?: string; action: ResearchAction; question?: string; /** #565: the names and nouns to search for, the only text whose words reach a source. */ topic?: string; researchId?: string; sources?: string; direction?: string; lookups?: unknown; /** The model call this run answers, stamped by the Live owner so a step can name it. Never from model arguments. */ callId?: string }


const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

export const RESEARCH_ARGUMENT_FIELDS = ['action', 'question', 'topic', 'researchId', 'sources', 'direction', 'lookups', 'cursor'] as const;
export const RESEARCH_ARGUMENT_TYPES = ['absent', 'null', 'string', 'number', 'boolean', 'array', 'object', 'other'] as const;
export const RESEARCH_REFUSAL_REASONS = ['root_type', 'unknown_fields', 'action_missing', 'action_invalid', 'question_type', 'question_required', 'topic_type', 'topic_required', 'topic_length', 'research_id_type', 'research_id_required', 'sources_type', 'direction_type', 'cursor_type', 'cursor_action', 'cursor_lookups_conflict', 'lookups_type', 'lookups_count', 'lookups_stop', 'lookup_type', 'lookup_unknown_fields', 'lookup_source', 'lookup_query_required', 'lookup_query_length', 'lookup_history', 'lookup_mail'] as const;
export type ResearchRefusalReason = typeof RESEARCH_REFUSAL_REASONS[number];
export interface ResearchArgumentShape {
  action: ResearchAction | 'missing' | 'invalid';
  fields: Record<typeof RESEARCH_ARGUMENT_FIELDS[number], typeof RESEARCH_ARGUMENT_TYPES[number]>;
  unknownFieldCount: number;
  lookupCount: number;
}
export type ParsedResearch = { ok: true; call: ResearchCall } | { ok: false; reason: ResearchRefusalReason; shape: ResearchArgumentShape };

function argumentType(value: unknown, present: boolean): typeof RESEARCH_ARGUMENT_TYPES[number] {
  if (!present) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'object' ? type : 'other';
}

/** One parser owns validity and closed refusal metadata; submitted values never enter its diagnostic. */
export function parseResearch(args: unknown): ParsedResearch {
  const given = isRecord(args) ? args : {};
  // 52fa54cc repaired the arguments the model really sends: a one-item array is the same single-source hint.
  const record = Array.isArray(given['sources']) && given['sources'].length === 1 && typeof given['sources'][0] === 'string'
    ? { ...given, sources: given['sources'][0] as string } : given;
  const action = record['action'];
  const shape: ResearchArgumentShape = {
    action: action === 'start' || action === 'continue' || action === 'stop' ? action : Object.hasOwn(record, 'action') ? 'invalid' : 'missing',
    fields: Object.fromEntries(RESEARCH_ARGUMENT_FIELDS.map(key => [key, argumentType(record[key], Object.hasOwn(record, key))])) as ResearchArgumentShape['fields'],
    unknownFieldCount: Object.keys(record).filter(key => !(RESEARCH_ARGUMENT_FIELDS as readonly string[]).includes(key)).length,
    lookupCount: Array.isArray(record['lookups']) ? record['lookups'].length : 0,
  };
  const refuse = (reason: ResearchRefusalReason): ParsedResearch => ({ ok: false, reason, shape });
  if (!isRecord(args)) return refuse('root_type');
  if (shape.unknownFieldCount) return refuse('unknown_fields');
  if (!Object.hasOwn(record, 'action')) return refuse('action_missing');
  if (action !== 'start' && action !== 'continue' && action !== 'stop') return refuse('action_invalid');
  for (const [key, reason] of [['question', 'question_type'], ['topic', 'topic_type'], ['researchId', 'research_id_type'], ['sources', 'sources_type'], ['direction', 'direction_type']] as const) {
    if (Object.hasOwn(record, key) && typeof record[key] !== 'string') return refuse(reason);
  }
  if (record['question'] !== undefined && optionalString(record['question']) === undefined) return refuse('question_required');
  if (record['researchId'] !== undefined && optionalString(record['researchId']) === undefined) return refuse('research_id_required');
  if (action === 'start' && optionalString(record['question']) === undefined) return refuse('question_required');
  // #565: a start without a topic has no search text at all, so it is refused before it reads anything.
  if (action === 'start' && optionalString(record['topic']) === undefined) return refuse('topic_required');
  if (record['topic'] !== undefined && (String(record['topic']).length > TOPIC_MAX_CHARS || String(record['topic']).trim().split(/\s+/u).filter(Boolean).length > TOPIC_MAX_WORDS)) return refuse('topic_length');
  if (action !== 'start' && optionalString(record['researchId']) === undefined) return refuse('research_id_required');
  if (Object.hasOwn(record, 'cursor')) {
    if (typeof record['cursor'] !== 'string' || !record['cursor'].length || record['cursor'].length > 128) return refuse('cursor_type');
    if (action !== 'continue') return refuse('cursor_action');
    if (Object.hasOwn(record, 'lookups')) return refuse('cursor_lookups_conflict');
  }
  if (Object.hasOwn(record, 'lookups')) {
    // K6: a routed start names its own layers. A continue may only carry the local history lookups
    // that page an already-answered run; every other lookup belongs to a start.
    if (action !== 'start' && !(action === 'continue' && historyLookupsOnly(record['lookups']))) return refuse('lookups_stop');
    if (!Array.isArray(record['lookups'])) return refuse('lookups_type');
    // #657 item 1: a status or test-all ask names more sources than one batch holds, and the host serves
    // it in batches, so its lookup list is never a count or unknown-field refusal.
    const hostBatched = statusAsk(typeof record['question'] === 'string' ? record['question'] : '');
    if (!hostBatched && record['lookups'].length > MAX_LOOKUPS) return refuse('lookups_count');
    for (const entry of record['lookups']) {
      if (!isRecord(entry)) return refuse('lookup_type');
      if (!Object.keys(entry).every(key => key === 'source' || key === 'query' || key === 'history' || key === 'mail')) return refuse('lookup_unknown_fields');
      if (typeof entry['source'] !== 'string' || !(LOOKUP_SOURCES as readonly string[]).includes(entry['source'])) return refuse('lookup_source');
      if (Object.hasOwn(entry, 'history')) {
        if (entry['source'] !== 'memory' || Object.hasOwn(entry, 'query') || Object.hasOwn(entry, 'mail') || !validateHistory(entry['history'])) return refuse('lookup_history');
      } else if (Object.hasOwn(entry, 'mail')) {
        if (entry['source'] !== 'mail' || Object.hasOwn(entry, 'query') || !validMailLookup(entry['mail'])) return refuse('lookup_mail');
      } else {
        if (optionalString(entry['query']) === undefined) return refuse('lookup_query_required');
        if (String(entry['query']).length > RESEARCH.queryLimitChars) return refuse('lookup_query_length');
      }
    }
  }
  return { ok: true, call: record as unknown as ResearchCall };
}

export function validateResearch(args: unknown): boolean { return parseResearch(args).ok; }

/** F9: the one repair line a refused call gets, so a repeat attempt changes what was wrong, not just the words. */
const REPAIR_GUIDANCE: Partial<Record<ResearchRefusalReason, string>> = {
  topic_required: 'A start needs the topic: the names and nouns to search for, at most eight words, e.g. {"action":"start","question":"the question","topic":"Wilmar pilot"}. The question itself is never searched.',
  topic_type: 'The topic is one short string of names and nouns, at most eight words.',
  topic_length: `The topic is at most ${TOPIC_MAX_WORDS} words: keep only the names and nouns, and shorten anything past ${TOPIC_MAX_CHARS} characters.`,
  lookup_query_length: `The query was too long: keep it under ${RESEARCH.queryLimitChars} characters and shorten the words after source.`,
  lookup_mail: 'A mail lookup is {"source":"mail","mail":{"q":"search words"}} or {"source":"mail","mail":{"id":"message id"}}, with maxResults 1 to 50 optional; a mail lookup carries no query.',
  lookup_query_required: 'This lookup needs a query: add {"source":"the source","query":"the words to search"}.',
  lookup_source: 'The source must be one of knowledge, mail, chat, web, memory.',
  lookup_history: 'A memory lookup is {"source":"memory","history":{"topic":"..."}}; the history fields are topic and optional limit.',
  lookups_count: `Send ${LOOKUP_LIMIT_TEXT}; anything more cannot be read before the answer is due.`,
  unknown_fields: 'Remove the fields not in the tool schema; only action, question, topic, researchId, sources, direction, cursor and lookups exist.',
};

export function researchRepair(reason: ResearchRefusalReason): JsonObject {
  return {
    error: 'invalid_research_arguments', state: 'refused', reason,
    guidance: REPAIR_GUIDANCE[reason] ?? 'No lookup started. Use {"action":"start","question":"the question","topic":"the names and nouns"}; optional lookups need source and query, or memory with history, or mail with mail. Continue needs the returned researchId. Stop needs researchId and no lookups. Cursor is only for continue, without lookups. Omit unused fields; null is not supported.',
  };
}

/** R9: a call refused before dispatch still leaves exactly one run receipt, in the run line's own shape. */
export function refusedResearchRunLog(): ResearchRunLog {
  return {
    event: 'research_run', researchId: newResearchId(), questionClass: 'cross_source', rounds: 0, perRound: [],
    stopReason: 'refused', status: 'failed', ops: 0, sources: [], elapsedMs: 0, deadAirMs: 0, selectorMs: 0,
    fallbackUsed: false, replyBytes: 0, unchecked: [], canContinue: false, findingChars: [],
  };
}

/** K6: a continue carries only the local history lookups that page an answered run. */
function historyLookupsOnly(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every(entry => isRecord(entry) && entry['source'] === 'memory' && !Object.hasOwn(entry, 'query') && validateHistory(entry['history']) && !Object.hasOwn(entry, 'mail'));
}

function validMailLookup(value: unknown): value is MailLookup {
  if (!isRecord(value)) return false;
  if ('id' in value) return Object.keys(value).every(key => key === 'id' || key === 'format') && typeof value['id'] === 'string' && value['id'].length > 0 && (value['format'] === undefined || value['format'] === 'full' || value['format'] === 'metadata');
  return Object.keys(value).every(key => key === 'q' || key === 'maxResults') && typeof value['q'] === 'string' && value['q'].trim().length > 0 && value['q'].length <= 2048
    && (value['maxResults'] === undefined || Number.isSafeInteger(value['maxResults']) && Number(value['maxResults']) > 0 && Number(value['maxResults']) <= 50);
}

/** The display order and human name of every research source the host loop can read today (R2-R2). */
const SOURCE_LABELS: readonly (readonly [SourceKind, string])[] = [
  ['web', 'the web'],
  ['calendar', 'calendar'],
  ['mail', 'mail'],
  ['chat', 'team chat'],
  ['knowledge', 'knowledge base'],
  ['mongoose', 'company knowledge'],
  ['data', 'company numbers'],
  ['drive', 'Drive files'],
  ['memory', 'memory'],
];

/** The connector tool whose presence means a source is configured. Same four names the research loop fans out over. */
const SOURCE_TOOLS: Readonly<Record<string, SourceKind>> = {
  conversation_history: 'memory', search_knowledge: 'knowledge', search: 'mongoose', read: 'mongoose', search_fields: 'data', run_metric_query: 'data', calendar_list_events: 'calendar', gmail_search_messages: 'mail', mattermost_search: 'chat', drive_search_files: 'drive',
};

/** Map the tool names a session actually configured to the research sources they expose, in display order. */
/** The closed reason a connected endpoint carries when this session cannot call its reads yet. */
export const UNPUBLISHED_SOURCE_REASON = 'tools-unpublished';

/**
 * W9/B1: a session's configured sources are what its published reads serve plus every source a
 * configured endpoint covers, so a session opened before the connect round still names what it
 * cannot reach instead of silently narrowing.
 */
export function configuredSourcesForSession(published: readonly SourceKind[], endpoints: readonly ConfiguredEndpointStatus[]): SourceKind[] {
  const sources = [...published];
  for (const endpoint of endpoints) {
    for (const source of researchSourcesForEndpoint(endpoint)) if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

/**
 * W9/B1: the sources this session cannot read, with a closed reason each. `served` is what the
 * session's own tool set can call, so a connected endpoint whose reads were not published into this
 * session is named as unpublished rather than vanishing.
 */
export function unreachableSourcesForSession(served: readonly SourceKind[],
  endpoints: readonly ConfiguredEndpointStatus[]): UnavailableSource[] {
  const sources: UnavailableSource[] = [];
  for (const endpoint of endpoints) {
    const reason = endpoint.state === 'connected'
      ? UNPUBLISHED_SOURCE_REASON
      : endpoint.reasonCode ?? endpoint.configurationError ?? endpoint.exception?.code ?? endpoint.state;
    for (const source of researchSourcesForEndpoint(endpoint)) {
      if (served.includes(source) || sources.some(entry => entry.source === source)) continue;
      sources.push({ source, reason });
    }
  }
  return sources;
}

export function researchSourcesFromToolNames(names: Iterable<string>): SourceKind[] {
  const present = new Set(names);
  const found = new Set<SourceKind>();
  for (const [tool, source] of Object.entries(SOURCE_TOOLS)) if (present.has(tool)) found.add(source);
  return SOURCE_LABELS.map(([source]) => source).filter(source => found.has(source));
}

/** ROUTE-1022: the two Google endpoints the host registry keys, each serving its own source. */
const ENDPOINT_SOURCES: Readonly<Record<string, readonly SourceKind[]>> = {
  gmail: ['mail'], calendar: ['calendar'], drive: ['drive'],
  // W3: the three Mongoose endpoints are three connections, so one unsigned endpoint hides only its
  // own reads. crm carries no research source at all, and never stands for knowledge or data.
  'mongoose-knowledge': ['mongoose'], 'mongoose-data': ['data'], 'mongoose-crm': [],
};

/**
 * ROUTE-1022: availability is per endpoint. gmail and the calendar are two endpoints on one connector,
 * so a failed gmail proof never marks the calendar unreachable, and the reverse holds too.
 */
export function researchSourcesForEndpoint(endpoint: ConfiguredEndpointStatus): SourceKind[] {
  const named = ENDPOINT_SOURCES[endpoint.id ?? ''];
  return named === undefined ? researchSourcesForConnector(endpoint.connector) : [...named];
}

/**
 * The research sources one approved connector covers. Used to keep a connector that is down in the
 * configured set so its sources can be reported unreachable rather than silently vanishing.
 */
export function researchSourcesForConnector(connector: string): SourceKind[] {
  if (connector === 'google') return ['calendar', 'mail'];
  if (connector === 'mattermost') return ['chat'];
  if (connector === 'lux-knowledge') return ['knowledge'];
  if (connector === 'mongoose') return ['mongoose'];
  return [];
}

/**
 * W9-R3: the configured sources one endpoint set covers, and the closed reason for every endpoint
 * that did not connect, so a source the owner configured is spoken as unreachable instead of
 * vanishing. Only a closed code travels: never the free-text error, a url or a credential.
 * W10: `grantedTools` is the read tools the session's current registry offers. A connected endpoint
 * whose source has no granted read tool has published no usable grant yet, so that source is named
 * too, with `source_not_granted`, instead of being silently absent from both lists.
 */
export function configuredSourcesForEndpoints(endpoints: readonly ConfiguredEndpointStatus[], grantedTools?: Iterable<string>): UnavailableSource[] {
  const sources: UnavailableSource[] = [];
  const push = (source: SourceKind, reason: string): void => { if (!sources.some(entry => entry.source === source)) sources.push({ source, reason }); };
  for (const endpoint of endpoints) {
    if (endpoint.state === 'connected') continue;
    // #636: `configured` is the report's state for a connector whose own credential is dead, and the
    // state word is never a reason: the owner hears the closed code for a sign-in, not "configured".
    const reason = endpoint.reasonCode ?? endpoint.configurationError ?? endpoint.exception?.code ?? (endpoint.state === 'configured' ? 'not_signed_in' : endpoint.state);
    for (const source of researchSourcesForEndpoint(endpoint)) push(source, reason);
  }
  if (grantedTools === undefined) return sources;
  const granted = new Set(grantedTools);
  const reachable = new Set<SourceKind>();
  for (const [tool, source] of Object.entries(SOURCE_TOOLS)) if (granted.has(tool)) reachable.add(source);
  for (const endpoint of endpoints) {
    if (endpoint.state !== 'connected') continue;
    for (const source of researchSourcesForEndpoint(endpoint)) if (!reachable.has(source)) push(source, 'source_not_granted');
  }
  return sources;
}

/** The configured sources named for the model, joined as "a, b and c". */
function sourceListText(sources: readonly SourceKind[]): string {
  const labels = SOURCE_LABELS.filter(([source]) => sources.includes(source)).map(([, label]) => label);
  if (labels.length === 0) return 'configured sources';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}`;
}

/** The declaration description names the sources this session actually configured, never a source it lacks. */
export function researchDescription(sources: readonly SourceKind[]): string {
  return `One lookup of the owner's ${sourceListText(sources)}: at most ${MAX_LOOKUPS} lookups per call, each with a source (memory, knowledge, company, data, calendar, mail, chat, replies, drive or web) plus query, mail or history. Use it when answering needs evidence beyond the conversation. Call start with the question and a topic of names and nouns, at most eight words: only the topic is searched. Its result carries the researchId; continue and stop copy it.`;
}

export function researchDeclaration(configured: readonly SourceKind[] = RESEARCH_SOURCES): { name: string; description: string; guidance: string; parameters: JsonObject; validate(args: unknown): boolean } {
  return {
    name: RESEARCH_TOOL_NAME,
    description: researchDescription(configured),
    guidance: 'Omit unused properties; null is not supported. Each generic lookup requires source and query; typed memory.history and mail.mail omit query. Cursor is continue-only and excludes lookups; stop excludes lookups and cursor. start needs {"action":"start","question":"the question"} and its result carries the researchId the host minted; continue needs {"action":"continue","researchId":"<the id from that result>"}, copied, never invented. An optional "sources" hint of exactly one source makes the first round deterministic; an optional "direction" steers a continue. A mail lookup query is short keywords in Gmail operators with a window, not the spoken question, e.g. from:dana newer_than:14d invoice, or newer_than:2d is:unread.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      // #565: a start is declared to carry its topic, never merely described as carrying one.
      anyOf: [
        { properties: { action: { enum: ['start'] } }, required: ['question', 'topic'] },
        { properties: { action: { enum: ['continue', 'stop'] } }, required: ['researchId'] },
      ],
      properties: {
        action: { type: 'string', enum: ['start', 'continue', 'stop'], description: 'start requires question and topic; continue and stop require the researchId returned by start. Stop must omit lookups and cursor.' },
        question: { type: 'string', minLength: 1, description: 'The owner question; required for start.' },
        topic: { type: 'string', minLength: 1, maxLength: 200, description: 'Required for start. The names and nouns to search for, at most eight words, for example Wilmar pilot. Only these words become a search; the question never does.' },
        researchId: { type: 'string', minLength: 1, description: 'The id a previous reply carried; required for continue and stop.' },
        sources: { type: 'string', description: 'Optional single-source hint; valid values: calendar, mail, chat, knowledge.' },
        cursor: { type: 'string', maxLength: 128, description: 'Consumer continuation copied from nextCursor on the same researchId. This is not a source-native page token. Omit lookups when using it.' },
        direction: { type: 'string', description: 'Optional steer for a continue, e.g. "look in mail".' },
        lookups: {
          type: 'array', maxItems: MAX_LOOKUPS,
description: 'Optional: ' + LOOKUP_LIMIT_TEXT + '. When present the host skips its own source choice and reads every lookup in parallel; when absent the host selects the sources. memory: retained conversations, remembered notes and imported notes, within the accepted permissions. knowledge: his knowledge base of decisions, project status, technical notes, meeting transcripts and work sessions. company: permissioned company, product and commercial records; this does not guarantee directory coverage. calendar: primary calendar only; query must be today, tomorrow, week (rolling seven days), this week (Monday start), next week, a weekday (next occurrence including today), next Wednesday (next Monday-start week), Wednesday this week (may be past), or a valid YYYY-MM-DD. Unknown or contradictory windows are unresolved, never widened. Calendar coverage separates received events, shown events, retained remainder, unread pages and truncated descriptions; continue returns retained remainder before reading more pages. mail: his mail; lookup.mail supports an exact Gmail q/maxResults search or exact id/format read. Search coverage counts received metadata messages, not full bodies or complete threads. Source order is preserved. continue returns retained metadata before requesting another page. An exact full-message read returns bodySlices with immutable UTF16 offsets, received total and separate upstream completeness. Continue nextCursor to consume received body remainder without another source read; quoted history remains included. Metadata format deliberately omits bodies. alreadyDelivered is a model-context receipt, not a claim that the owner heard it. chat: his team chat; keep the person, group or channel in the question as he said it (what a person wrote him, what he discussed with a person, the newest in a named channel, his group chat with some people), because the host resolves the name strictly and its reply names what it read, over which days, or asks which one he means. replies: what is waiting on him in the team chat. drive: his own Drive files by name, for a document, deck or sheet he wants opened; query id: and a returned file id reads that one file again.',
          items: {
            type: 'object', additionalProperties: false, required: ['source'],
            anyOf: [
              { required: ['source', 'query'], properties: { source: { type: 'string', enum: [...LOOKUP_SOURCES] }, query: { type: 'string', minLength: 1, maxLength: RESEARCH.queryLimitChars } }, additionalProperties: false },
              { required: ['source', 'history'], properties: { source: { type: 'string', enum: ['memory'] }, history: HISTORY_PARAMETERS }, additionalProperties: false },
              { required: ['source', 'mail'], properties: { source: { type: 'string', enum: ['mail'] }, mail: { type: 'object' } }, additionalProperties: false },
            ],
            properties: {
              mail: { type: 'object', additionalProperties: false, anyOf: [
                { required: ['id'], properties: { id: { type: 'string' }, format: { type: 'string' } }, additionalProperties: false },
                { required: ['q'], properties: { q: { type: 'string' }, maxResults: { type: 'integer' } }, additionalProperties: false },
              ], description: 'Only for mail. Exact source search {q,maxResults?} or precise message {id,format?}, mutually exclusive. Omit query. Full message is the default; metadata must be deliberate. IDs come from source evidence, never prose guesses.', properties: { q: { type: 'string', minLength: 1, maxLength: 2048 }, maxResults: { type: 'integer', minimum: 1, maximum: 50 }, id: { type: 'string', minLength: 1 }, format: { type: 'string', enum: ['full', 'metadata'] } } },
              history: { ...HISTORY_PARAMETERS, description: 'Only for memory. Canonical local search/date bounds, exact recordRef, or source-native cursor copied from historyPages. Use continue with the same researchId for recordRef or cursor. This cursor is not the top-level consumer continuation cursor. Omit query when history is present.' },
              source: { type: 'string', enum: [...LOOKUP_SOURCES], description: 'The layer this lookup reads.' },
              query: { type: 'string', minLength: 1, maxLength: RESEARCH.queryLimitChars, description: 'A short search string written for that source.' },
            },
          },
        },
      },
    },
    validate: validateResearch,
  };
}

/** One source hint is a fast deterministic path: skip the round-1 selector entirely. */
function hintedSources(hint: unknown, configured: readonly SourceKind[]): SourceKind[] {
  if (typeof hint !== 'string') return [];
  const value = hint.trim().toLowerCase();
  if (!value) return [];
  const aliases: Record<string, SourceKind> = { knowledge: 'knowledge', memory: 'knowledge', calendar: 'calendar', schedule: 'calendar', mail: 'mail', email: 'mail', gmail: 'mail', chat: 'chat', channel: 'chat', mattermost: 'chat', mongoose: 'mongoose' };
  const matched = new Set<SourceKind>();
  for (const token of value.split(/[^a-z]+/)) { const source = aliases[token]; if (source) matched.add(source); }
  return [...matched].filter(source => configured.includes(source));
}

function sourceKindOf(kind: CandidateKind): SourceKind | null {
  return CANDIDATES.find(candidate => candidate.kind === kind)?.source ?? null;
}

/** The sources one candidate's results belong to, one group per source: `brief` fans out over several. */
function creditableSources(kind: CandidateKind, results: readonly IntentSubResult[]): { source: SourceKind | null; results: IntentSubResult[] }[] {
  const own = sourceKindOf(kind);
  if (own !== null) return [{ source: own, results: [...results] }];
  const named = [...new Set(results.map(result => sourceKindOfKindName(result.name)))];
  return named.map(source => ({ source, results: results.filter(result => sourceKindOfKindName(result.name) === source) }));
}

/** The candidate kind that owns a source, so a `brief` part is shaped the way that source reads. */
function shapeKindOf(source: SourceKind | null, fallback: CandidateKind): CandidateKind {
  return CANDIDATES.find(candidate => candidate.source === source && candidate.requires === undefined)?.kind ?? fallback;
}

/** One read's identity: the same tool with the same arguments is the same read for this run. */
function callSignature(call: IntentSubCall): string {
  return `${call.name}:${JSON.stringify(call.args)}`;
}

/**
 * The query shape a search that matched nothing used, for the line the model voices. Words only:
 * provider operators and argument keys are dropped, and matched content is never carried here.
 */
function queryShapeOf(subs: readonly IntentSubCall[]): string {
  const raw = subs[0]?.args['query'] ?? subs[0]?.args['q'] ?? subs[0]?.args['window'];
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const words = raw.replace(/\b[\w-]+:[\w"/.-]+/gu, ' ').replace(/\b[\w-]+_[\w-]+\b/gu, ' ').replace(/\s+/gu, ' ').trim();
  return words ? ` for "${clip(words, 60)}"` : ' with a keyword filter';
}

const OMITTED_NOTE = /^\[omitted:/u;
const SOURCE_LABEL: Record<SourceKind, string> = { memory: 'memory', knowledge: 'knowledge', calendar: 'calendar', mail: 'mail', chat: 'chat', mongoose: 'company knowledge', data: 'company numbers', web: 'the web', drive: 'Drive' };
/** #635: the name a source is spoken by, so a clause says "team chat" and never the bare id. */
const spokenLabelOf = (source: SourceKind): string => SOURCE_LABELS.find(([name]) => name === source)?.[1] ?? SOURCE_LABEL[source];
/** Findings order: her own memory and the owner's knowledge base lead, company sources follow. */
const SOURCE_ORDER: readonly SourceKind[] = ['memory', 'knowledge', 'calendar', 'mail', 'chat', 'mongoose', 'data', 'drive', 'web'];
/** #621: the smallest room a floor clip may leave, so one source's last line always fits the bound. */
const FLOOR_CLIP_CHARS = 8;
const LINE_CAP: Partial<Record<CandidateKind, number>> = {
  mail_search: RESEARCH.mailLines, mail_open: 2,
  chat_search: RESEARCH.chatLines, chat_thread: 12,
  knowledge_search: RESEARCH.knowledgeLines,
  brief: RESEARCH.mailLines,
};

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = flat.slice(0, Math.max(0, max - 1)).trimEnd();
  // #621: a clip never leaves half a word, because the voice reads its last token as content. A single
  // unbroken token has no boundary to honour, so there the cut stays where the room ends.
  const whole = room.replace(/\s+\S*$/u, '').trimEnd();
  return `${whole.length * 2 >= room.length ? whole : room}\u2026`;
}

/**
 * #621: the E3 states a reply must keep apart, and the E4 reason a source was never searched. C-LIVE behaviour 2
 * (F3): `partial_failed` is a read whose later page failed after one arrived, never `complete`, whatever the
 * counts add up to, because the header is what the voice repeats aloud.
 */

export type CoverageStatus = 'complete' | 'partial_timeout' | 'truncated_to_budget' | 'empty_after_retry' | 'partial_failed';
export type UnsearchedReason = 'not_connected' | 'not_configured' | 'grant_missing' | 'provider_failed' | 'skipped_by_route' | 'timed_out' | 'still_reading' | 'channel_not_found' | 'needs_clarification' | 'name_not_found' | 'never_ran' | 'count_needs_date_window';
export interface CoverageSearched { source: SourceKind; status: CoverageStatus; shown: number; total: number; confidence?: string }
export interface CoverageUnsearched { source: SourceKind; reason: UnsearchedReason }

/** The status words a searched source says aloud, where the word alone would be read as a whole read. */
const SEARCHED_CLAUSE: Partial<Record<CoverageStatus, (label: string) => string>> = {
  partial_failed: label => `${label} stopped after a later page failed`,
};

/** The one clause the voice can say about a source it could not read, keyed by the closed reason. */
const UNSEARCHED_CLAUSE: Record<UnsearchedReason, (label: string, source: SourceKind) => string> = {
  not_connected: label => `${label} is not connected`,
  not_configured: label => `${label} is not set up`,
  grant_missing: label => `${label} needs permission`,
  provider_failed: label => `${label} failed when I asked`,
  skipped_by_route: label => `I did not read ${label} this time`,
  // #635, #653: a read that ran out of its budget did not answer, and how long it was given is the reason.
  timed_out: (label, source) => `${label} did not answer within ${Math.round(RESEARCH.sourceDeadline[source] / 1000)} seconds`,
  still_reading: label => `I am still reading ${label}`,
  // #637: the ask named a channel the chat connector does not know, so nothing was searched.
  channel_not_found: () => 'I do not know that channel',
  // C-CHAT: the name fits several people, channels or groups, so she asks which one before reading.
  needs_clarification: () => 'ask which one he means',
  name_not_found: () => 'I do not know that name',
  // L8-13: the latest ask ran no new read of this source, so nothing about it took too long.
  never_ran: label => `I did not run a new ${label} read this time`,
  // W3: a count without a date window is an all-time sum, which is not a user count. The repair is
  // the line the planner needs, so it names the missing window and nothing else.
  count_needs_date_window: label => `${label} refused this count: add a date window (a date dimension or an inThePast filter) and ask again`,
};

/** A not-searched reason code from the host, narrowed to the closed set the header publishes. */
export function unsearchedReasonOf(code: string): UnsearchedReason {
  const text = code.toLowerCase();
  // W3: the count guard's own code, before any spelling heuristic can read it as a failure.
  if (text === 'count_needs_date_window') return 'count_needs_date_window';
  if (/grant|permission|scope|forbidden|unauthori[sz]ed|not_connected|signin|sign_in|sign-in|login|credential|token/u.test(text)) {
    return /not_connected|signin|sign_in|sign-in|login|credential|token|disconnect/u.test(text) ? 'not_connected' : 'grant_missing';
  }
  // #635: a timeout says it timed out, whatever the connector called it.
  if (/timeout|timed_out/u.test(text)) return 'timed_out';
  if (/unparsed|no_query|skipped|deadline|history_reference/u.test(text)) return 'skipped_by_route';
  return 'provider_failed';
}

/** #634: the header's own share of the reply cap, so it can never eat the prose it rides with. */
const HEADER_SHARE_OF_CAP = 4;

/**
 * #621: the deterministic header every reply opens with. It names each searched source with its status and
 * the hits it returned over the hits it matched, and each source the route wanted but never read with the
 * reason, so an empty findings list never stands for any of them.
 * #634: past a quarter of the cap in force the header keeps each source's status word and drops only the
 * counts and the spoken clauses, so no source ever vanishes from it and it never eats the prose.
 */
export function coverageLine(searched: readonly CoverageSearched[], unsearched: readonly CoverageUnsearched[], limit: number = RESEARCH.budgets.default): string {
  const bound = Math.floor(limit / HEADER_SHARE_OF_CAP);
  const line = (entries: readonly string[]): string => entries.length === 0 ? 'coverage: none' : `coverage: ${entries.join('; ')}`;
  const detailed = line([
    ...searched.map(entry => {
      const say = SEARCHED_CLAUSE[entry.status];
      return `${entry.source} ${entry.status} ${entry.shown} of ${entry.total} shown${entry.confidence === undefined ? '' : ` confidence=${entry.confidence}`}${say === undefined ? '' : ` (say: ${say(spokenLabelOf(entry.source))})`}`;
    }),
    ...unsearched.map(entry => `${entry.source} ${entry.reason} (say: ${UNSEARCHED_CLAUSE[entry.reason](spokenLabelOf(entry.source), entry.source)})`),
  ]);
  if (detailed.length <= bound) return detailed;
  return line([
    ...searched.map(entry => `${entry.source} ${entry.status}`),
    ...unsearched.map(entry => `${entry.source} ${entry.reason}`),
  ]);
}

/** The fields the header reads off a finding: which source it came from and the count line it leads with. */
interface FindingLike { source?: string; text?: string }

/** `Source: 3 of 9 shown`, the head every finding line group carries. */
const FINDING_HEAD = /^\S[^:\n]*: (\d+) of (\d+) shown$/mu;
/** L11-01: a label line under a finding head (the ranker's confidence, a nothing-matched verdict), never an item. */
const FINDING_META_LINE = /^knowledge: (?:confidence=|nothing matched)/u;

/**
 * #621: the header of a reply with findings, derived from the findings the voice will actually hear, so the
 * counts can never drift from the evidence after a trim.
 */
/**
 * C-DEPTH item 4: what the header owes beyond counts. Per source, whether the reader got it all or an
 * excerpt, so an excerpt is never called full; and which of the people and documents the owner named are
 * covered by the evidence that is actually in the reply. Deterministic, from the reply text alone.
 */
function depthClauseOf(question: string, findings: readonly FindingLike[]): string {
  const text = findings.map(entry => entry.text ?? '').join('\n');
  const entities = requestedEntities(question);
  const covered = entities.filter(name => text.includes(name));
  const missing = entities.filter(name => !text.includes(name));
  // W10-R15 P3: a body the connector windowed, or a full entry read the host cut, is an excerpt even when
  // every hit came back, because what the reply carries is not the whole entry.
  const windowed = findings.some(entry => KNOWLEDGE_CUT_AT.test(entry.text ?? ''));
  const shape = findings.filter(entry => typeof entry.text === 'string' && typeof entry.source === 'string').map(entry => {
    const head = FINDING_HEAD.exec(entry.text ?? '');
    const shown = head === null ? 0 : Number(head[1]);
    const total = head === null ? 0 : Number(head[2]);
    const whole = shown === total && !(entry.source === 'knowledge' && windowed);
    return `${SOURCE_LABEL[entry.source as SourceKind] ?? entry.source} ${whole ? 'full' : 'excerpt'}`;
  });
  const parts: string[] = [];
  if (shape.length > 0) parts.push(shape.join(', '));
  if (entities.length > 0) {
    parts.push(`entities ${covered.length} of ${entities.length} covered`);
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  }
  return parts.length === 0 ? '' : `; ${parts.join('; ')}`;
}

function coverageTextOf(run: RunState, configured: readonly SourceKind[], findings: readonly FindingLike[], totals: ReadonlyMap<SourceKind, number>, limit: number): string {
  // C-LIVE behaviour 2 / F3: a read that lost a later page never counts as a whole read, whatever the totals say.
  // Mail is the one source whose reads carry their own page-failure flag (see operationCoverage).
  const failedPage = (source: SourceKind): boolean => source === 'mail' && [...run.mail.values()].some(read => read.failed);
  const searched: CoverageSearched[] = [];
  for (const source of SOURCE_ORDER) {
    if (!configured.includes(source)) continue;
    // A routed read that matched nothing records the empty search, never sourcesDone, so the header reads
    // the three the same way.
    const wasSearched = run.sourcesDone.has(source) || run.emptySearches.has(source);
    // #635: a read that was cut with nothing arrived is named by its reason below as timed_out, never as a
    // searched source with an empty count.
    if (!wasSearched) continue;
    // L8-13: a read that never dispatched this time is named by that outcome below, never as a timeout.
    if (run.neverRan?.has(source) === true && !run.cutShort.has(source)) continue;
    const finding = findings.find(entry => entry.source === source && typeof entry.text === 'string');
    // C-CHAT: a chat read that asked back read nothing yet, so the header says so instead of an empty count.
    if (source === 'chat' && run.chatUnresolved !== undefined && finding === undefined) continue;
    const text = finding?.text ?? '';
    const head = FINDING_HEAD.exec(text);
    const shown = head === null ? 0 : Number(head[1]);
    const total = Math.max(shown, totals.get(source) ?? (head === null ? 0 : Number(head[2])));
    const status: CoverageStatus = run.cutShort.has(source) ? 'partial_timeout'
      : failedPage(source) && shown > 0 ? 'partial_failed'
      : total > shown ? 'truncated_to_budget' : shown === 0 ? 'empty_after_retry' : 'complete';
    const confidence = source === 'knowledge' && finding !== undefined ? knowledgeConfidenceOf(text.split('\n'))?.confidence : undefined;
    searched.push({ source, status, shown, total, ...(confidence === undefined ? {} : { confidence }) });
  }
  const unsearched: CoverageUnsearched[] = [];
  for (const source of SOURCE_ORDER) {
    const unresolved = source === 'chat' && !searched.some(entry => entry.source === source) ? run.chatUnresolved : undefined;
    if (!run.route.has(source) && unresolved === undefined && run.neverRan?.has(source) !== true) continue;
    if (searched.some(entry => entry.source === source)) continue;
    const neverRan = run.neverRan?.has(source) === true && !run.cutShort.has(source);
    unsearched.push({ source, reason: unresolved ?? (neverRan ? 'never_ran' : unsearchedReasonGiven(run, configured, source)) });
  }
  return coverageLine(searched, unsearched, limit);
}

/** #653: what a source that never answered did, once its run is closed, so a closed reply never says still reading. */
function closedOutcomeOf(run: RunState, source: SourceKind): UnsearchedReason {
  if (run.cutShort.has(source)) return 'timed_out';
  const code = run.unavailableReasons.get(source);
  // #635: a source whose own reason was a timeout is a timeout, never a provider failure.
  if (code !== undefined && TIMED_OUT.has(code)) return 'timed_out';
  // #637: a channel the ask named and the chat connector does not know is its own closed reason, so the
  // header says the channel is unknown instead of reporting the chat as a provider failure.
  if (code !== undefined && code.startsWith('channel_not_found')) return 'channel_not_found';
  if (run.sourcesFailed.has(source)) return 'provider_failed';
  if (code !== undefined) return unsearchedReasonOf(code);
  if (run.stopped || run.cancelled) return 'skipped_by_route';
  // A reader still pending when the run closed used all of its deadline and answered nothing.
  return run.pending.has(source) || (run.reading?.has(source) === true && !run.sourcesDone.has(source)) ? 'timed_out' : 'skipped_by_route';
}

function unsearchedReasonGiven(run: RunState, configured: readonly SourceKind[], source: SourceKind): UnsearchedReason {
  if (!configured.includes(source)) return 'not_configured';
  // #635: a read still in flight is neither skipped nor failed, so it says so, the same thing the note says.
  // #653: but a closed run has no read in flight, so the same source is named by its closed outcome.
  // L8-06: a read still running is still reading, whichever path runs it: the web read never passes the
  // execute wrapper that fills `pending`, so the call's own reading set counts too.
  if ((run.pending.has(source) || (run.reading?.has(source) === true && !run.sourcesDone.has(source))) && !run.ended && !run.stopped && !run.cancelled) return 'still_reading';
  return closedOutcomeOf(run, source);
}

/**
 * #675: the closed codes that mean she is signed out of a source, so a status line says that in words
 * instead of calling a source that never ran a failure. A named set, never a substring match: an
 * exhausted token budget is not a sign-out.
 */
const SIGNED_OUT_CODES = new Set([
  'not_signed_in', 'signed_out', 'not_connected', 'signin_required', 'login_required',
  'credential_missing', 'credential-missing', 'credential_refresh_failed', 'credential-refresh-failed',
  'credential_consent_expired', 'credential-consent-expired', 'credential_revoked', 'data_not_connected',
]);

/**
 * #653: the status answer names what each source did, in plain words, and a source is called working
 * only when its read answered. It reads the same closed reason set the coverage header uses.
 */
function statusReport(run: RunState, configured: readonly SourceKind[]): string {
  const sources = [...new Set<SourceKind>([...run.route, ...configured])].filter(source => source !== 'memory');
  return sources.map(source => {
    const label = spokenLabelOf(source);
    if (run.sourcesDone.has(source)) return `${label} answered`;
    if (run.emptySearches.has(source)) return `${label} answered, nothing this time`;
    // #675: a source she is not signed in to is its own status, never a failure and never a timeout.
    const code = run.unavailableReasons.get(source);
    if (code !== undefined && SIGNED_OUT_CODES.has(code.toLowerCase())) return `${label} is signed out`;
    return UNSEARCHED_CLAUSE[unsearchedReasonGiven(run, configured, source)](label, source);
  }).join('; ');
}

function itemLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line && !OMITTED_NOTE.test(line));
}

/** Open2: an `open:` line a shaper attached to its item stays with that item when the reply is rebuilt. */
function withItemOpenLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const last = kept.at(-1);
    if (line.startsWith('open: ') && last !== undefined && last.startsWith('- ')) kept[kept.length - 1] = `${last}\n${line}`;
    else kept.push(line);
  }
  return kept;
}

/** A knowledge heading, shaped `### title (kind | date) [id N]` or raw markdown `## #N [type] title`. */
function knowledgeHeadingOf(line: string): { id: string | undefined; title: string } {
  const id = line.match(/\[id (\d+)\]/)?.[1] ?? line.match(/^#{2,3}\s*#(\d+)\b/)?.[1];
  const title = line.replace(/^#{2,3}\s*/, '').replace(/\[id \d+\]/gu, '').replace(/^#\d+\b\s*/, '').replace(/\s+/g, ' ').trim();
  return { id, title };
}

const KNOWLEDGE_BULLET = /^\s*(?:-\s+)?\*\*#(\d+)\*\*\s*(.*)$/;
const KNOWLEDGE_MD_HEADING = /^#{2,3}\s+/;
/** K7: the server's two score scales in one line; they are not comparable, so neither is voiced. */
const KNOWLEDGE_SCORE = /^Score: /u;
/** K5: the ranker's own confidence line, so a weak match is hedged instead of stated with certainty. */
const KNOWLEDGE_CONFIDENCE_META = /^_.*(?:confidence:|top score:|relevant candidate:).*$/u;
interface KnowledgeConfidence { confidence: string; top?: string; candidates?: string }

function knowledgeConfidenceOf(lines: readonly string[]): KnowledgeConfidence | undefined {
  for (const line of lines) {
    if (!KNOWLEDGE_CONFIDENCE_META.test(line)) continue;
    const confidence = /confidence:\s*([a-z]+)/u.exec(line)?.[1];
    if (confidence === undefined) continue;
    const top = /top score:\s*([\d.]+)/u.exec(line)?.[1];
    const candidates = /relevant candidate:\s*([a-z]+)/u.exec(line)?.[1];
    return { confidence, ...(top === undefined ? {} : { top }), ...(candidates === undefined ? {} : { candidates }) };
  }
  return undefined;
}

/** The one machine line the voice model reads: the match's strength, not the corpus's totals. */
function knowledgeConfidenceLine(confidence: KnowledgeConfidence): string {
  return `knowledge: confidence=${confidence.confidence}${confidence.top === undefined ? '' : ` top=${confidence.top}`}${confidence.candidates === undefined ? '' : ` candidates=${confidence.candidates}`}`;
}

/** The server's own bounded-body flag: `truncated: yes (5,432 chars stored)` under a hit. */
const KNOWLEDGE_TRUNCATED = /^truncated: (yes|no)\b/u;

/** Knowledge headings collapse to `#id title | body`, one per insight, in the shaped and raw forms. */
function insightItems(raw: readonly string[], bodyWindow?: number, carried?: KnowledgeConfidence): string[] {
  const items: string[] = [];
  // K5: the ranker's confidence line leads the finding, so the model can hedge a weak match.
  // #6: the shape reads the line before stripping it and carries it here; the raw text is the fallback.
  const confidence = carried ?? knowledgeConfidenceOf(raw);
  if (confidence !== undefined) {
    items.push(knowledgeConfidenceLine(confidence));
    // #6: a weak match with no relevant candidate is voiced as nothing matching, never as a hit.
    if (confidence.confidence !== 'high' && confidence.confidence !== 'medium' && confidence.candidates !== 'yes') items.push('knowledge: nothing matched this ask');
  }
  let heading: { id: string | undefined; title: string } | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (heading === undefined) { body = []; return; }
    // P5-R1: the body is kept whole: the connector's own result bounds are the only cap on a hit.
    // 3r K1: a hit the server cut at the asked-for window says so, in place of the server's own flag.
    // K2: an opened body is shown at the wider read window; a search snippet keeps the short one.
    let cut = false;
    const kept = body.filter(line => {
      const flag = KNOWLEDGE_TRUNCATED.exec(line);
      if (flag) { cut = flag[1] === 'yes'; return false; }
      // K7: the per-hit `Score:` line carries two incomparable scales, so it is never voiced.
      return !KNOWLEDGE_SCORE.test(line);
    });
    const joined = kept.join(' ');
    const bounded = bodyWindow === undefined ? joined : clip(joined, bodyWindow);
    const text = `${heading.id ? `#${heading.id} ` : ''}${heading.title}${bounded ? ` | ${bounded}` : ''}`;
    const window = bodyWindow ?? RESEARCH.knowledgeBodyChars;
    items.push(cut || bounded !== joined ? `${text} | cut at ${window} chars` : text);
    heading = undefined; body = [];
  };
  for (const line of raw) {
    const bullet = KNOWLEDGE_BULLET.exec(line);
    if (bullet) { flush(); heading = { id: bullet[1], title: bullet[2]!.replace(/\s+/g, ' ').trim() }; continue; }
    if (KNOWLEDGE_MD_HEADING.test(line)) { flush(); heading = knowledgeHeadingOf(line); continue; }
    body.push(line);
  }
  flush();
  return items;
}

/** One calendar event line: its id (when the shaped list carries one), start and rendered line. */
interface CalendarEvent { id: string; start: string; line: string }

function calendarEvents(raw: readonly string[]): CalendarEvent[] {
  const items: CalendarEvent[] = [];
  let current: CalendarEvent | undefined;
  let attendees: string | undefined;
  let open: string | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    // Open2: the item's own handle line stays with it, as a segment the day line can carry.
    // #574: who is in the meeting rides with the event, already capped at eight names by the shape.
    items.push({ ...current, line: `${current.line}${attendees !== undefined ? ` | ${attendees}` : ''}${open !== undefined ? ` ; ${open}` : ''}` });
    current = undefined; attendees = undefined; open = undefined;
  };
  for (const line of raw) {
    if (line.startsWith('- ')) {
      flush();
      let body = line.slice(2);
      // The merged connector line tags the event `... | <calendar>` before the `[id ...]`.
      let calendar = '';
      const pipeAt = body.indexOf(' | ');
      if (pipeAt >= 0) { calendar = body.slice(pipeAt + 3); body = body.slice(0, pipeAt); }
      const idMatch = / \[id ([^\]\s]+)\]\s*$/.exec(calendar || body);
      const id = idMatch?.[1] ?? '';
      if (idMatch) { if (calendar) calendar = calendar.slice(0, idMatch.index).trim(); else body = body.slice(0, idMatch.index).trimEnd(); }
      const parts = body.split(', ');
      const start = parts[0] ?? '';
      const title = parts[1] ?? '(no title)';
      const location = parts.slice(2).join(', ');
      // One grammar for a calendar line, the connector's: `start, title, location | calendar`, so a reader
      // never has to guess whether a pipe segment is a place or a calendar name.
      current = { id, start, line: `${start}, ${title}${location ? `, ${location}` : ''}${calendar ? ` | ${calendar}` : ''}` };
    } else if (line.startsWith('attendees: ') && current !== undefined) {
      attendees = line.trim();
    } else if (line.startsWith('open: ') && current !== undefined) {
      open = line;
    }
  }
  flush();
  return items;
}

/**
 * Merge the connector's shaped event lines and lay the whole window out one line per day, never a silent cut:
 * the only bound is the reply budget, and a trimmed block names how many events it left out (E8, U2).
 */
function shapeCalendarBlock(results: readonly IntentSubResult[], zone: string | undefined, limit = RESEARCH.budgets.default): { text: string; source: SourceKind | null; lines: string[]; total: number } {
  const merged: RetainedCalendarEvent[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (!result.ok || result.name !== INTERNAL.calendarList || !result.text.trim()) continue;
    for (const event of calendarEvents(itemLines(result.text))) {
      const dedupe = event.id || `${event.start}|${event.line}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      merged.push({ ...event, bodyTruncated: false });
    }
  }
  merged.sort((a, b) => a.start.localeCompare(b.start));
  const notRead = calendarNotRead(results);
  let kept = merged.length;
  let lines = calendarDayLines(compactCalendarWindow(merged, zone));
  const render = (): string => `calendar: ${kept} of ${merged.length} shown\n${lines.join('\n')}${kept === merged.length ? '' : `\nI left out ${merged.length - kept} calendar ${merged.length - kept === 1 ? 'event' : 'events'} to keep this answer short.`}${notRead ? `\n${notRead}` : ''}`;
  while (kept > 1 && render().length > limit) {
    kept -= 1;
    lines = calendarDayLines(compactCalendarWindow(merged.slice(0, kept), zone));
  }
  if (kept === 0) return { text: '', source: 'calendar', lines: [], total: 0 };
  return { text: render(), source: 'calendar', lines, total: merged.length };
}

/**
 * N3: a routed calendar read is the primary calendar only, so the result says plainly what it did not
 * read. Counting rather than naming, because the connector's list carries no primary marker.
 */
function calendarNotRead(results: readonly IntentSubResult[]): string | undefined {
  const listed = results.find(result => result.ok && result.name === INTERNAL.calendars);
  if (listed === undefined) return undefined;
  const others = Math.max(0, calendarIds(listed.text).length - 1);
  if (others === 0) return 'this read covers the primary calendar only; the calendar list does not establish that no other calendars exist';
  return `not read: ${others} other ${others === 1 ? 'calendar' : 'calendars'}, this read covers the primary calendar only`;
}

/**
 * Q5-R2: the cut notes a connector already writes in its own text. They are parsed rather than trusted
 * to reach the model, because `itemLines` drops them and a cut body must never read as a whole one.
 */
const OMITTED_CHARS = /\[omitted:?\s*(\d+) characters?\b/gu;
const OMITTED_ITEMS = /\[omitted:?\s*(\d+) more\b/gu;
const EXTRA_CHARS = /\[\+(\d+) chars\]/gu;

/** Q5-R2: one machine line for text that was cut, withheld or omitted, or nothing when nothing was. */
export function cutLineOf(results: readonly IntentSubResult[]): string | undefined {
  let cut = 0, shown = 0, withheld = 0;
  for (const result of results) {
    if (!result.ok || !result.text.trim()) continue;
    shown += result.text.length;
    for (const match of result.text.matchAll(OMITTED_CHARS)) cut += Number(match[1]);
    for (const match of result.text.matchAll(EXTRA_CHARS)) cut += Number(match[1]);
    for (const match of result.text.matchAll(OMITTED_ITEMS)) withheld += Number(match[1]);
  }
  const parts = [
    ...(cut > 0 ? [`cut: ${cut} of ${shown + cut} chars`] : []),
    ...(withheld > 0 ? [`withheld: ${withheld} ${withheld === 1 ? 'entry' : 'entries'}`] : []),
  ];
  return parts.length ? parts.join('; ') : undefined;
}

/**
 * Q1-R0: one telegraphic line per item, a per-source count line, never prose. Item ids ride in the
 * shaped line so the host can open the top mail or fetch the top chat thread without a second search.
 */
/** E5 (#612): rank 0 when the owner already wrote in the thread, 1 for a person, 2 for bulk or machine mail. */
function mailReplyNeed(messages: readonly MailMessage[]): (bullet: string) => number {
  const byId = new Map(messages.map(message => [message.id, message]));
  const ownerThreads = new Set(messages.filter(message => message.sent === true).map(message => message.threadId));
  return (bullet: string): number => {
    const id = /\[id ([A-Za-z0-9_-]+)\]/u.exec(bullet)?.[1];
    const message = id === undefined ? undefined : byId.get(id);
    if (message === undefined) return 2;
    if (ownerThreads.has(message.threadId)) return 0;
    return message.bulk === true ? 2 : 1;
  };
}

/**
 * W3: the dated rows of one metric query, newest first, as the reply voices them. The projection the
 * connector built carries each row's own date, so the latest loaded day is read here, never inferred.
 */
const DATED_ROW = /(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z)?[^\n0-9]*(\d[\d,]*)/u;
function metricRowLines(text: string): string[] {
  const rows = text.split('\n').flatMap(line => {
    const match = DATED_ROW.exec(line);
    return match?.[1] === undefined || match[2] === undefined ? [] : [{ date: match[1], value: match[2] }];
  });
  if (rows.length === 0) return [];
  const latest = rows.reduce((newest, row) => (row.date > newest.date ? row : newest));
  return [`${latest.value} on ${latest.date}, the latest day loaded`];
}

export function shapeBlock(kind: CandidateKind, results: readonly IntentSubResult[], zone?: string, options?: { newestFirst?: boolean }): { text: string; source: SourceKind | null; lines: string[]; total: number } {
  if (kind === 'company_metric') {
    // W3: a number never travels alone. The newest dated row leads, so the answer says "about 2,400 on
    // 25 October, the latest day loaded" instead of a figure with no day under it.
    const lines = results.filter(result => result.ok).flatMap(result => metricRowLines(result.text));
    if (lines.length === 0) return { text: '', source: 'data', lines: [], total: 0 };
    return { text: `${SOURCE_LABEL.data}: ${lines.join('; ')}`, source: 'data', lines, total: lines.length };
  }
  if (kind === 'web_search') {
    const ok = results.filter(result => result.ok && result.text.trim());
    const lines = ok.flatMap(result => result.text.split('\n').filter(Boolean));
    return { text: ok.map(result => result.text).join('\n'), source: 'web', lines, total: lines.length };
  }
  if (kind === 'drive_search') {
    // C-OPEN 3: a file line keeps its own handle line, and a listing of several keeps the question it asks.
    const raw = results.filter(result => result.ok && result.text.trim()).flatMap(result => withItemOpenLines(itemLines(result.text)));
    const files = raw.filter(line => line.startsWith('- ')).length;
    if (files === 0) return { text: '', source: 'drive', lines: [], total: 0 };
    return { text: `${SOURCE_LABEL.drive}: ${files} ${files === 1 ? 'file' : 'files'}\n${raw.join('\n')}`, source: 'drive', lines: raw, total: files };
  }
  if (kind === 'calendar_window') {
    const block = shapeCalendarBlock(results, zone);
    const cutLine = cutLineOf(results);
    return cutLine === undefined ? block : { ...block, text: `${block.text}\n${cutLine}` };
  }
  const ok = results.filter(result => result.ok && result.text.trim());
  const source = sourceKindOf(kind) ?? (ok.length ? sourceKindOfKindName(ok[0]!.name) : null);
  const lines: string[] = [];
  let total = 0;
  for (const result of ok) {
    const raw = itemLines(result.text);
    if (result.name === INTERNAL.mailList) {
      // E5 (#612): a triage read ranks before the cap, so what needs an answer is never pushed out by
      // newsletters and machine notice; the shaper carried the two facts the rank reads.
      const need = mailReplyNeed(result.mailPage?.messages ?? []);
      const shown: { text: string; rank: number }[] = [];
      for (const line of withItemOpenLines(raw).filter(entry => entry.startsWith('- '))) {
        // Open2: the handle line the shaper attached stays on the message line it belongs to.
        const open = line.indexOf('\nopen: ') < 0 ? '' : line.slice(line.indexOf('\nopen: '));
        const bullet = open === '' ? line : line.slice(0, line.indexOf('\nopen: '));
        const parts = bullet.slice(2).replace(/\s*\[id [^\]]+\]/g, '').trim().split(' | ');
        const subject = parts[0] ?? '';
        let sender = ''; let date = '';
        const rest: string[] = [];
        for (const part of parts.slice(1)) {
          if (part.startsWith('from: ')) sender = part.slice(6).trim();
          else if (part.startsWith('date: ')) date = part.slice(6).trim();
          else rest.push(part);
        }
        const excerpt = clip(rest.join(' | '), RESEARCH.mailSnippetChars);
        shown.push({ text: `${[sender, subject, date, excerpt].filter(value => value !== '').join(' | ')}${open}`, rank: need(bullet) });
      }
      for (const entry of shown.sort((left, right) => left.rank - right.rank)) {
        lines.push(entry.text);
        total += 1;
      }
    } else if (result.name === INTERNAL.mailRead) {
      const head: Record<string, string> = {};
      let index = 0;
      for (; index < raw.length; index++) {
        const match = /^(subject|from|to|date|cc|labels|attachments): (.*)$/.exec(raw[index]!);
        if (!match) break;
        if (match[1] === 'subject' || match[1] === 'from' || match[1] === 'date') head[match[1]!] = match[2]!;
      }
      const body = clip(raw.slice(index).join(' '), RESEARCH.openedBodyChars);
      lines.push([head['from'] ?? '', head['subject'] ?? '(no subject)', head['date'] ?? '', body].filter(value => value !== '').join(' | '));
      total += 1;
    } else if (result.name === INTERNAL.knowledgeSearch || result.name === INTERNAL.knowledgeRead) {
      // K2: a search snippet stays short, the hydration hop's body gets the wider window, and an
      // explicit read by id stays whole, as Q5-R1 promises.
      const items = insightItems(raw, undefined, result.knowledgeConfidence);
      lines.push(...items); total += items.length;
    } else if (result.name === INTERNAL.calendarList) {
      const items = calendarEvents(raw).map(event => event.line);
      lines.push(...items); total += items.length;
    } else if (result.name === INTERNAL.calendars) {
      // Calendar names are not events; the per-calendar follow-up carries them and names each line.
    } else {
      const cap = result.name.startsWith('mattermost') ? RESEARCH.chatTextChars : 400;
      // Q1-R5: a mattermost search renders each post as a `**header**` line plus its text, a channel
      // list as `- name` lines. Keep both; the old `- `-only filter dropped every search post.
      let heading: string | undefined;
      let body: string[] = [];
      // C-CHAT (AUD-002): the archive's own match count, so the header says "8 of 71", never "8 of 8".
      const matched = result.name.startsWith('mattermost') ? Number(/^matched: (\d+)$/mu.exec(result.text)?.[1] ?? 0) : 0;
      const before = total;
      const flush = (): void => {
        if (heading === undefined) { body = []; return; }
        lines.push(clip(`${heading.replace(/\s*\[post [^\]]+\]/g, '').trim()}${body.length ? ` | ${body.join(' ')}` : ''}`, cap));
        total += 1; heading = undefined; body = [];
      };
      for (const line of raw) {
        const bold = /^\*\*(.+?)\*\*$/.exec(line);
        if (bold) { flush(); heading = bold[1]!; continue; }
        if (line.startsWith('- ')) { flush(); lines.push(clip(line.slice(2).replace(/\s*\[post [^\]]+\]/g, '').trim(), cap)); total += 1; continue; }
        if (heading !== undefined) body.push(line);
      }
      flush();
      total = Math.max(total, before + matched);
    }
  }
  // #576: a "last meeting" ask reads the newest notes first, before the relevance order.
  if (options?.newestFirst === true && (source === 'knowledge' || source === 'memory')) {
    const ordered = newestDatedFirst(lines);
    lines.length = 0;
    lines.push(...ordered);
  }
  const cap = LINE_CAP[kind] ?? lines.length;
  const shown = lines.slice(0, cap);
  if (!shown.length) return { text: '', source, lines: [], total: 0 };
  const label = SOURCE_LABEL[source ?? 'knowledge'];
  const cutLine = cutLineOf(results);
  // E5 (#612): what the eight line cap left behind is counted, so a triage read is never mistaken for a
  // clear inbox.
  const shown0 = Math.max(total, shown.length);
  const leftOut = kind === 'mail_search' && lines.length > shown.length ? `\n${lines.length - shown.length} left out` : '';
  return { text: `${label}: ${shown.length} of ${shown0} shown\n${shown.join('\n')}${cutLine !== undefined ? `\n${cutLine}` : ''}${leftOut}`, source, lines: shown, total: shown0 };
}


/**
 * LOGS.md L-01: a connector-classified failure reaches research as a completed result whose text is
 * the owner's own line (the tool layer's "never an empty success"), so an ok read that carries words
 * while its shape has no line is a failed read, never a search that matched nothing. A read that
 * really matched nothing carries no words, so a true empty stays empty. Bracket-only notes (an
 * upstream continuation, an incomplete window) are metadata, not a reason.
 */
export function classifiedFailureText(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const words = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !/^\[[^\]]*\]$/u.test(line)).join(' ').trim();
    if (words !== '') return words;
  }
  return undefined;
}

/**
 * LOGS.md L-01: the tool layer marks the projection it builds for a classified connector failure with that
 * failure's own closed code, so the reader classifies by that mark, never by the words a read happened to
 * carry. The words are still the line the owner hears, and a read that matched nothing carries no mark.
 */
export function classifiedProjectionText(results: readonly IntentSubResult[]): string | undefined {
  for (const result of results) {
    if (!result.ok) continue;
    const code = (result as IntentSubResult & { classified?: unknown }).classified;
    if (typeof code === 'string' && code !== '') return result.text.trim();
  }
  return undefined;
}

/**
 * #565: the shape of a dispatched batch, one row per distinct call. Counts, the closed operator names and
 * the topic's word count only, so a search word has no field to land in.
 */
function queryShapeOfSubs(call: IntentSubCall, topic: string | undefined): ResearchQueryShape | undefined {
  const source = sourceKindOfKindName(call.name);
  // A Drive read writes no query shape row: the trace table's source set is closed and a name search has no operators.
  if (source === null || source === 'drive') return undefined;
  const raw = call.args['q'] ?? call.args['query'];
  const text = typeof raw === 'string' ? raw : '';
  const shape = mailQueryShape(text);
  return {
    source, terms: shape.terms,
    operators: shape.operators.filter(operator => (MAIL_QUERY_OPERATORS as readonly string[]).includes(operator)),
    topicWords: (topic ?? '').split(/\s+/u).filter(Boolean).length,
  };
}

/** L8-Q06: what one in-process read (the web) did: its outcome, time, result count, closed reason and query. */
export interface ResearchSourceRead { source: 'web'; outcome: 'ok' | 'failed' | 'timeout'; ms: number; results: number; reason?: string; query: string; researchId: string; at: number }

function recordWebRead(deps: ResearchDeps, run: RunState, query: string, outcome: WebOutcome, started: number, now: () => number): void {
  const write = deps.sourceRead;
  if (write === undefined) return;
  try {
    write({ source: 'web', outcome: outcome.ok ? 'ok' : outcome.code === 'web_timeout' ? 'timeout' : 'failed', ms: Math.max(0, now() - started),
      results: outcome.ok ? webSourceCards(outcome.evidence).length : 0, ...(outcome.ok ? {} : { reason: outcome.code }), query, researchId: run.researchId, at: now() });
  } catch { /* the receipt is never the answer */ }
}

/** #565: one trace row per source call this run dispatched, and a repeated signature is one row. */
function recordShapes(deps: ResearchDeps, run: RunState, calls: readonly IntentSubCall[], now: () => number): void {
  const write = deps.queryShape;
  if (write === undefined) return;
  for (const call of calls) {
    const signature = callSignature(call);
    if (run.shaped.has(signature)) continue;
    const shape = queryShapeOfSubs(call, run.topic);
    if (shape === undefined) continue;
    run.shaped.add(signature);
    try { write({ ...shape, researchId: run.researchId, at: now() }); } catch { /* the receipt is never the answer */ }
  }
}

function sourceKindOfKindName(name: string): SourceKind | null {
  switch (name) {
    case WEB_SEARCH_ACTION: return 'web';
    case INTERNAL.knowledgeSearch:
    case INTERNAL.knowledgeRead: return 'knowledge';
    case INTERNAL.calendars:
    case INTERNAL.calendarList: return 'calendar';
    case INTERNAL.mailList:
    case INTERNAL.mailRead: return 'mail';
    case HISTORY_IDENTITY.name: return 'memory';
    case INTERNAL.mongooseSearch: return 'mongoose';
    // W3: the data endpoint's two reads belong to the numbers source, never to company knowledge.
    case INTERNAL.mongooseSearchFields:
    case INTERNAL.mongooseMetricQuery: return 'data';
    case INTERNAL.driveSearch:
    case INTERNAL.driveGet: return 'drive';
    case INTERNAL.chatSearch:
    case INTERNAL.chatAttention:
    case INTERNAL.chatRead:
    case 'mattermost_get_thread': return 'chat';
    default: return null;
  }
}

/** ROUTE-1022: a continuation the run cannot serve says what to do next, so the model never stalls on it. */
export const CONTINUATION_UNAVAILABLE_NOTE = 'That earlier result is no longer available. Ask a fresh research question about the same thing.';

function bodyCursor(run: RunState, key: string, offset: number, width: number): string {
  const existing = [...run.bodyCursors].find(([, page]) => page.key === key && page.offset === offset)?.[0];
  if (existing) return existing;
  const body = run.bodies.get(key)!.evidence.body;
  let end = Math.min(body.length, offset + width);
  if (end < body.length && /[\uD800-\uDBFF]/u.test(body.slice(end - 1, end))) end--;
  const cursor = randomUUID();
  run.bodyCursors.set(cursor, { key, offset, end, delivered: false });
  return cursor;
}
function receivedBodyReply(run: RunState, configured: readonly SourceKind[], limit: number): BodyReply | undefined {
  const selected = run.bodyCursorRequested ? run.bodyCursors.get(run.bodyCursorRequested) : undefined;
  const entry = selected ? [selected.key, run.bodies.get(selected.key)] as const : [...run.bodies].find(([, body]) => body.offset < body.evidence.body.length);
  if (!entry || !entry[1]) return undefined;
  const [key, body] = entry;
  if (body.evidence.expiresAt <= Date.now()) return { researchId: run.researchId, error: 'continuation_unavailable', findings: [], canContinue: false, note: CONTINUATION_UNAVAILABLE_NOTE };
  // F7: the body is sized by the real serialized reply, escaping included, so a reply never outgrows its budget
  // and a long body costs as few round trips as the budget allows.
  const base = buildReply(run, 'answered', configured, false, limit, undefined, true);
  const envelope = JSON.stringify(base).length;
  // F7: a slice's room is the limit minus the reply it rides in and minus what the slice, its cursor and
  // its delivery receipt add; the text is measured escaped, so a body full of newlines still fits.
  const id = '00000000-0000-0000-0000-000000000000';
  const fields = JSON.stringify({
    source: body.source, tool: body.evidence.tool, text: '', offset: body.offset, end: body.offset,
    total: body.evidence.body.length, unit: 'utf16', upstreamComplete: body.evidence.upstreamComplete,
    upstreamOmitted: body.evidence.upstreamOmitted,
  }).length + JSON.stringify({ bodyProjection: 'preview', cursor: id, nextCursor: id, canContinue: false, [bodyDelivery]: { researchId: run.researchId, runId: run.runId, cursor: id } }).length;
  const room = Math.max(0, limit - envelope - fields - 8);
  let width = 0;
  let spent = 0;
  for (const char of body.evidence.body.slice(body.offset)) {
    spent += JSON.stringify(char).length - 2;
    if (spent > room) break;
    width += char.length;
  }
  if (width === 0) width = [...body.evidence.body.slice(body.offset)][0]?.length ?? 0;
  const cursor = run.bodyCursorRequested ?? bodyCursor(run, key, body.offset, width), page = run.bodyCursors.get(cursor)!;
  if (page.end < body.evidence.body.length) page.nextCursor ??= bodyCursor(run, key, page.end, width);
  else {
    const next = [...run.bodies].find(([other, value]) => other !== key && value.offset < value.evidence.body.length);
    if (next) page.nextCursor ??= bodyCursor(run, next[0], next[1].offset, width);
  }
  const otherPending = base['canContinue'] === true;
  if (!page.nextCursor && typeof base['nextCursor'] === 'string') page.nextCursor = base['nextCursor'];
  page.canContinue = Boolean(page.nextCursor) || otherPending;
  const partial = Boolean(page.nextCursor) || otherPending || body.evidence.upstreamComplete !== true || body.evidence.upstreamOmitted !== false;
  return { ...base, researchId: run.researchId, status: partial ? 'partial' : 'complete', bodyProjection: 'preview',
    bodySlices: [{ source: body.source, tool: body.evidence.tool, text: body.evidence.body.slice(page.offset, page.end), offset: page.offset, end: page.end, total: body.evidence.body.length, unit: 'utf16', upstreamComplete: body.evidence.upstreamComplete, upstreamOmitted: body.evidence.upstreamOmitted }],
    cursor, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), canContinue: Boolean(page.nextCursor) || otherPending,
    [bodyDelivery]: { researchId: run.researchId, runId: run.runId, cursor } };
}

interface ReplyFinding { source: string; text: string; chars: number }

/**
 * Q1-R0 packing: a count line plus telegraphic lines per source, at least one line per source with
 * hits, then fill by recency; omitted calendar events remain in the current authorized run.
 */
/** #1020 behaviour 1: the plain words a source's failure gets, never a bare code and never silence. */
const REASON_WORDS: Record<string, string> = {
  not_configured: 'not configured',
  // ROUTE-1022 K1: the web source the model asked for is not offered in this session.
  web_not_available: 'not available',
  // C-OPEN 2: no Drive endpoint is configured yet; never a fake empty listing.
  drive_not_available: 'Drive is not set up for me yet',
  not_signed_in: 'not signed in',
  // #502: a refresh the identity server refused means one thing to the owner: sign in again.
  'credential-refresh-failed': 'sign in again',
  // #500: a source the identity server will not publish a read grant for.
  source_not_granted: 'read grant not published',
  // F17: the chat triage read is the connector's own composite, which the approved policy may not grant.
  'tool-not-granted': 'tool not granted',
  window_unparsed: 'could not resolve that date or window, ask for a day or a week',
  history_unavailable: 'unavailable',
  history_reference_unavailable: 'unavailable',
  cancelled: 'the run stopped before it was read',
  // Mongoose 1023b carries closed reasons of its own; restricted is a state, never an empty answer.
  restricted: 'restricted for this account, not missing',
  not_found: 'not in the company knowledge base',
  data_not_connected: 'the Lightdash token is not connected in Mongoose settings',
  endpoint_not_allowed: 'this account is not in the Mongoose CRM teams',
  cursor_stale: 'that page of results expired, search again',
  cursor_invalid: 'that page of results was not readable, search again',
  // #637: the ask named a channel the chat connector does not know, so no read was made at all.
  channel_not_found: 'no channel by that name',
};
/**
 * ROUTE-1022 K5: the plan a brief actually ran, as one closed token. A brief that read nothing but
 * knowledge (and memory) is `knowledge_only`; one whose question named a layer is `named_sources`.
 */
function briefPlanField(run: RunState): { plan?: 'knowledge_only' | 'named_sources' } {
  if (!run.readKinds.has('brief')) return {};
  const touched = [...run.sourcesDone, ...run.sourcesFailed, ...run.cutShort, ...run.emptySearches.keys()];
  return { plan: touched.every(source => source === 'knowledge' || source === 'memory') ? 'knowledge_only' : 'named_sources' };
}

/** The plain words a closed failure code gets in a reply, never a bare code. */
/**
 * F17/R3: the closed reason a refused chat triage read carries. The sub-call names the failure it
 * really returned, so a composite the policy never granted and a connector that refused the session
 * stay apart: only `unknown_tool` and `grant_not_permitted` mean the read was not granted.
 */
const CHAT_NOT_GRANTED_CODES: readonly string[] = ['unknown_tool', 'grant_not_permitted'];
/**
 * R3: the closed reasons a refused chat read may record on its receipt. One token each, never a
 * sentence: a not-granted read, a refused session, a cut read, drift, a protocol refusal, or no answer.
 */
export const CHAT_RECEIPT_REASONS: readonly string[] = [
  'tool-not-granted', 'credential-refresh-failed', 'source_not_granted', 'not_signed_in', 'timeout',
  'deadline', 'timed_out', 'schema-drift', 'grant-stale', 'source-unavailable', 'sdk_protocol_rejected',
  'connector_error', 'invalid_result', 'unavailable', 'refused',
  // Council 2026-10-26: a read routed to an endpoint latched by an identity failure names that code.
  'identity_mismatch', 'identity_unverified',
  // F3 (#637): a channel the ask named and the connector does not know is its own receipt reason.
  'channel_not_found',
];
export function chatAttentionReason(results: readonly IntentSubResult[]): string {
  const failed = results.find(result => !result.ok);
  const code = failed?.code;
  if (code === undefined) return 'unavailable';
  if (CHAT_NOT_GRANTED_CODES.includes(code)) return 'tool-not-granted';
  // R4: the emitted reason is clamped to the closed vocabulary the host log admits, so a code this
  // build does not know still produces a receipt instead of being refused there.
  return CHAT_RECEIPT_REASONS.includes(code) ? code : 'refused';
}
/** #637: the code a chat read carries when the ask named a channel the connector does not know. */
/** #637: the channel words the ask put in the connector's own channel argument, for the reply's clause. */
export function channelWordsOf(subs: readonly IntentSubCall[]): string | undefined {
  const arg = subs.find(sub => typeof sub.args['channel'] === 'string')?.args['channel'];
  return typeof arg === 'string' ? arg : undefined;
}
export function channelMissCode(results: readonly IntentSubResult[]): string | undefined {
  // #637: the tool layer hands a refused read the one closed code for a channel it does not know, so the
  // words are the ones the ask named, kept on the run by the chat search plan.
  return results.some(result => !result.ok && result.code !== undefined && result.code.startsWith('channel_not_found'))
    ? 'channel_not_found'
    : undefined;
}
/**
 * #663: the closest channel names a refusal carries, at most three, or none when it carries none. The
 * connector writes them into its own failure detail, so the reply can name the channel the owner meant.
 */
export function channelClosestNames(code: string | undefined): string[] {
  if (code === undefined) return [];
  const detail = /closest names:\s*([^;]*)/iu.exec(code)?.[1] ?? /^channel_not_found\s*:\s*(.+)$/u.exec(code)?.[1];
  if (detail === undefined) return [];
  return detail.split(',').map(name => name.trim()).filter(name => name !== '' && !/^none$/iu.test(name)).slice(0, 3);
}
export function plainReason(code: string): string { return REASON_WORDS[code] ?? code.replace(/_/gu, ' '); }
const TIMED_OUT = new Set(['timeout', 'deadline', 'deadline_exhausted', 'timed_out']);
const secondsOfSource = (source: SourceKind): number => Math.round((RESEARCH.sourceDeadline[source] ?? RESEARCH.defaultSourceDeadlineMs) / 1000);

/**
 * #1020 behaviour 1: every source this run failed, timed out or never read names itself, and why, in one
 * plain line, so the model cannot voice the surviving sources as if the read had been complete.
 */
function sourceTroubleLine(run: RunState): string | undefined {
  const parts: string[] = [];
  for (const [source, label] of SOURCE_LABELS) {
    if (run.sourcesDone.has(source)) continue;
    const cut = run.cutShort.has(source);
    if (!cut && !run.sourcesFailed.has(source)) continue;
    const code = run.unavailableReasons.get(source);
    // K1: a web lookup this session cannot serve says so in the owner's words, never as a chat answer.
    // R4: a read cut short by its own budget is a timeout; the hard stop names what it left behind in the note.
    if (code === 'web_not_available') parts.push('web: not available');
    else if (cut || (code !== undefined && TIMED_OUT.has(code))) parts.push(`${label}: not read (timed out after ${secondsOfSource(source)} s)`);
    else parts.push(`${label}: unavailable (${(code !== undefined ? plainReason(code) : undefined) ?? 'no answer'})`);
  }
  return parts.length === 0 ? undefined : parts.join('; ');
}

/** A covered day in the owner's zone, so a coverage line reads like the calendar the owner saw. */
const coveredDay = (ms: number, zone: string | undefined): string => {
  try { return new Intl.DateTimeFormat('en-GB', { ...(zone !== undefined ? { timeZone: zone } : {}), weekday: 'short', day: 'numeric', month: 'short' }).format(ms); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
};

/**
 * #1020 behaviour 2: a calendar answer states the window it actually covered, so a read whose events sit in
 * one day of a wider request is never spoken as "the rest of the week is clear", and the partiality of a cut
 * or paged read is never left implicit. A clean read that covers its whole request adds no line.
 */
function calendarCoverageLine(run: RunState): string | undefined {
  if (run.calendar.size === 0) return undefined;
  const zone = run.timeZone;
  const spans: [number, number][] = [];
  for (const read of run.calendar.values()) {
    const from = Date.parse(String(read.args['timeMin'])), to = Date.parse(String(read.args['timeMax']));
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) spans.push([from, to]);
  }
  if (spans.length === 0) return undefined;
  const from = Math.min(...spans.map(([at]) => at)), to = Math.max(...spans.map(([, at]) => at));
  const span = (a: number, b: number): string => coveredDay(a, zone) === coveredDay(b, zone) ? `${coveredDay(a, zone)} only` : `${coveredDay(a, zone)} to ${coveredDay(b, zone)}`;
  const requested = span(from, to - 1);
  const starts = [...run.calendar.values()].flatMap(read => [...read.events.values()].map(event => Date.parse(event.start))).filter(at => Number.isFinite(at) && at >= from && at < to);
  const covered = starts.length === 0 ? undefined : span(Math.min(...starts), Math.max(...starts));
  const narrower = covered !== undefined && (coveredDay(Math.min(...starts), zone) !== coveredDay(from, zone) || coveredDay(Math.max(...starts), zone) !== coveredDay(to - 1, zone));
  const partial = [...run.calendar.values()].some(read => read.failed || read.unread > 0 || read.nextPageToken !== undefined || !read.exhausted);
  if (narrower) return `calendar: covers ${covered}; the rest of ${requested} was NOT read${partial ? ', and part of that window was not read either' : ''}`;
  if (partial) return `calendar: covers ${covered ?? requested}, and part of ${requested} was not read`;
  // F7: a calendar list with a further page is true of every read on this account, so it says nothing about
  // the window the owner asked for and no longer takes the completion line's place.
  return undefined;
}

/**
 * E8: a whole calendar window in one line per day. The date is written once per day instead of once per
 * event, so a week of 23 events fits the reply budget and the model never re-asks the window day by day.
 */
function compactCalendarWindow(events: readonly RetainedCalendarEvent[], zone: string | undefined): { day: string; entries: string[] }[] {
  const format = (options: Intl.DateTimeFormatOptions, at: number): string | undefined => {
    try { return new Intl.DateTimeFormat('en-GB', { ...(zone !== undefined ? { timeZone: zone } : {}), ...options }).format(at); }
    catch { return undefined; }
  };
  const days = new Map<string, string[]>();
  const calendarStamp = (start: string, allDay: boolean): string | undefined => {
    const at = allDay ? Date.parse(`${start}T12:00:00Z`) : Date.parse(start);
    if (!Number.isFinite(at)) return undefined;
    return format({ year: 'numeric', month: 'numeric', day: 'numeric', ...(allDay ? { timeZone: 'UTC' } : {}) }, at);
  };
  // One day of timed events means the owner asked for that day; a multi-day window names several.
  const timed = new Set(events.filter(event => !/^\d{4}-\d{2}-\d{2}$/u.test(event.start)).map(event => calendarStamp(event.start, false)).filter((stamp): stamp is string => stamp !== undefined));
  const singleDay = timed.size === 1 ? [...timed][0] : undefined;
  for (const event of events) {
    // One grammar: `start, title, location | calendar`, so the comma fields are the event and the last
    // pipe segment is the calendar it came from, never a title.
    const body = event.line.replace(/^- /u, '').replace(/ \[id [^\]\s]+\]$/u, '');
    const pipeAt = body.indexOf(' | ');
    const fields = (pipeAt < 0 ? body : body.slice(0, pipeAt)).split(', ');
    const head = fields[0] ?? '';
    const rest = fields.slice(1).filter(part => part.length > 0).join(', ');
    // #7: an all-day entry starts as a bare date; reading it as a UTC instant would shift it into the
    // previous day west of UTC, so its own calendar day is written directly and it carries no time.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(event.start);
    const at = dateOnly ? Date.parse(`${event.start}T12:00:00Z`) : Date.parse(event.start);
    const day = dateOnly
      ? format({ weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }, at) ?? head
      : Number.isFinite(at) ? format({ weekday: 'short', day: 'numeric', month: 'short' }, at) ?? head : head;
    const time = dateOnly ? '' : Number.isFinite(at) ? format({ hour: '2-digit', minute: '2-digit', hour12: false }, at) ?? '' : '';
    // #7: a single-day read answers for the one day its timed events fall on, so an all-day entry from
    // another day (the overlap the helper returns) is that day's, not this answer's, and is dropped.
    if (dateOnly && singleDay !== undefined && calendarStamp(event.start, true) !== singleDay) continue;
    const entries = days.get(day) ?? [];
    entries.push([time, rest].filter(part => part.length > 0).join(' '));
    days.set(day, entries);
  }
  return [...days].map(([day, entries]) => ({ day, entries }));
}

const calendarDayLines = (days: readonly { day: string; entries: string[] }[]): string[] => days.map(entry => `- ${entry.day}: ${entry.entries.join('; ')}`);

/** LAT-1023: the two counted ways an answer comes back short, shared by every run receipt. */
function receiptCounts(reply: JsonObject | undefined, run: RunState, configured: readonly SourceKind[]): { roundCapHit?: number; answerCompacted?: { items: number; chars: number } } {
  const leftUnread = configured.filter(source => !run.sourcesDone.has(source) && !run.sourcesFailed.has(source));
  const compacted = (reply as CompactionReply | undefined)?.[compactionDelivery];
  return {
    ...(run.rounds >= ROUND_CAP_ROUNDS && (leftUnread.length > 0 || run.pending.size > 0) ? { roundCapHit: run.rounds } : {}),
    ...(compacted === undefined ? {} : { answerCompacted: { items: compacted.items, chars: JSON.stringify(reply ?? {}).length } }),
  };
}

const ALREADY_GIVEN = 'already given';
/** #575: two findings are the same when their text is, whatever the JSON escaping. */
const findingKey = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** #575: the one ask where her own earlier words are the evidence the owner wants. */
const ASKS_WHAT_SHE_SAID = /\bwhat (?:did|do|have) (?:you|she) (?:say|said)\b|\bwhat (?:you|she) (?:said|answered)\b/iu;

/** #615: the same words whatever the spacing or case, so the owner's own question is recognized as this turn. */
const memoryWords = (text: string): string => fold(text).replace(/\s+/gu, ' ').trim();

/**
 * #615: the sessions this call is writing to. A row of the live session is the conversation in progress, whatever
 * its role, so every row of that session is excluded by identity rather than by its own timestamp.
 */
function liveSessionIds(hits: readonly JsonObject[], question: string, history: number): Set<string> {
  const asked = new Set([question].filter(text => text.trim().length > 0).map(memoryWords));
  const ids = new Set<string>();
  for (const hit of hits) {
    const id = hit['sessionId'];
    if (typeof id !== 'string') continue;
    const at = Date.parse(String(hit['date'] ?? ''));
    if (asked.has(memoryWords(String(hit['snippet'] ?? ''))) || (Number.isFinite(at) && at >= history)) ids.add(id);
  }
  return ids;
}

/** #638: memory evidence is ordered by its kind of line as well as its match, never narrowed to one role. */
const memoryKind = (hit: JsonObject): number => (hit['sourceKind'] === 'summary' ? 0 : hit['sourceKind'] === 'live' ? 2 : 1);

/**
 * #638: every matching line is evidence, ranked by how many of the question's words it matches, then a summary
 * before an entry before a live transcript line, then newest, so a single owner line never removes the summaries.
 */
function rankMemoryEvidence(hits: readonly JsonObject[], tokens: readonly string[]): JsonObject[] {
  const scored = hits.map(hit => {
    const words = fold(String(hit['snippet'] ?? ''));
    const at = Date.parse(String(hit['date'] ?? ''));
    return { hit, kind: memoryKind(hit), score: tokens.filter(token => words.includes(token)).length, at: Number.isFinite(at) ? at : 0 };
  });
  scored.sort((left, right) => right.score - left.score || left.kind - right.kind || right.at - left.at);
  return scored.map(entry => entry.hit);
}

/**
 * #575/#615: what a memory lookup may show as earlier conversation. The owner's current question and every row
 * of the live session are never its own memory, and a row dated at or after the call before this one is the
 * live conversation, so only older rows survive unless the owner asked what she said.
 */
function memoryEvidence(hits: readonly JsonObject[], question: string, run: RunState, asked: boolean, currentSessionId?: string): JsonObject[] {
  const keys = new Set([question, run.question ?? ''].filter(text => text.trim().length > 0).map(memoryWords));
  const history = run.previousCallAt ?? run.startedAt;
  const live = asked ? new Set<string>() : liveSessionIds(hits, question, history);
  const kept = hits.filter(hit => {
    if (keys.has(memoryWords(String(hit['snippet'] ?? '')))) return false;
    if (asked) return true;
    // A remembered note is memory even when it was written in this call; the recording of the
    // conversation itself, and every summary of it, never is.
    if (hit['sourceKind'] === 'entry') return true;
    const id = hit['sessionId'];
    // L11-03: the call in progress is excluded by its own id, whatever a row's time says.
    if (typeof id === 'string' && (live.has(id) || id === currentSessionId)) return false;
    const at = Date.parse(String(hit['date'] ?? ''));
    return !Number.isFinite(at) || at < history;
  });
  return rankMemoryEvidence(kept, tokenize(question));
}

/** Citation metadata has its own 12,000 character envelope, outside the spoken reply budget. */
function spokenReplySize(reply: JsonObject): number {
  // #634: the coverage header is part of what the voice reads, so it is measured with the prose.
  const { markdown: _markdown, webSources: _sources, webAttribution: _attribution, ...spoken } = reply;
  return JSON.stringify(spoken).length;
}

function webInsufficient(reply: JsonObject, reason: string): void {
  reply['webInsufficient'] = { code: 'web_insufficient', reason };
  reply['sources'] = { ...(isRecord(reply['sources']) ? reply['sources'] : {}), web: 'web_insufficient' };
}

function capWebMetadata(reply: JsonObject): void {
  const sources = Array.isArray(reply['webSources']) ? reply['webSources'] : [];
  const attribution = Array.isArray(reply['webAttribution']) ? reply['webAttribution'] : [];
  const size = (): number => JSON.stringify({ markdown: reply['markdown'], webSources: sources, webAttribution: attribution }).length;
  while (size() > 12_000 && (sources.length || attribution.length)) {
    if (attribution.length) attribution.pop(); else sources.pop();
    reply['markdown'] = webFooter(sources as { title: string; url: string }[], attribution as { title: string; url: string }[]);
  }
}

/**
 * N4 (#567): the budget is measured on the whole serialized reply, after every section is attached, so a
 * block appended after the trim loop can never overrun it. Duplicated evidence goes first, the history
 * page hits the findings already carry, then the last lines of the widest finding; no structure is cut.
 * F1/F2 (RESCAP-R3): a finding is dropped whole rather than left as a header over nothing, the reply is
 * hard-bounded, and the state and the note are derived after the cut so they always agree.
 */
export function capReply(reply: JsonObject, limit: number, refresh?: () => void): JsonObject {
  // A requested body read and a record read page at their own 6,000 char room, so neither is held to the
  // search budget.
  if (reply['bodyProjection'] !== undefined) return reply;
  if (Array.isArray(reply['historyPages']) && (reply['historyPages'] as JsonObject[]).some(page => typeof page['text'] === 'string')) return reply;
  capWebMetadata(reply);
  const rawWebReason = isRecord(reply['unavailable']) ? reply['unavailable']['web'] : undefined;
  if (typeof rawWebReason === 'string' && rawWebReason.startsWith('web_insufficient:')) webInsufficient(reply, rawWebReason.slice('web_insufficient:'.length));
  // #634: the header counts inside the cap, so a caller that can rebuild it hands over `refresh` and every
  // pass measures the header it would ship. A status word can lengthen when a trim drops a source's last
  // line, so the header is never measured once and reused.
  const size = (): number => spokenReplySize(reply);
  const hitsOf = (page: JsonObject): unknown[] => Array.isArray(page['hits']) ? page['hits'] as unknown[] : [];
  let trimmed = false;
  // F1 (review): the state and the note are derived with every cut, so a capped reply never says nothing is
  // left while it offers the continuation that would fetch the rest.
  const settle = (): void => {
    if (!trimmed) return;
    if (reply['status'] === 'complete') reply['status'] = 'partial';
    reply['canContinue'] = true;
    const note = typeof reply['note'] === 'string' ? reply['note'] : undefined;
    reply['note'] = note === undefined || note.includes(RESEARCH.completeNote) ? RESEARCH.moreAvailableNote
      : note.includes(RESEARCH.moreAvailableNote) ? note : `${note} ${RESEARCH.moreAvailableNote}`;
  };
  let guard = 4096;
  while (guard-- > 0) {
    settle();
    refresh?.();
    if (size() <= limit) break;
    const pages = Array.isArray(reply['historyPages']) ? reply['historyPages'] as JsonObject[] : [];
    const widestPage = pages.reduce<JsonObject | undefined>((best, page) => best === undefined || hitsOf(page).length > hitsOf(best).length ? page : best, undefined);
    if (widestPage !== undefined && hitsOf(widestPage).length > 0) { hitsOf(widestPage).pop(); trimmed = true; continue; }
    const findings = (Array.isArray(reply['findings']) ? reply['findings'] as { source?: string; text?: string; chars?: number }[] : [])
      .filter(finding => typeof finding.text === 'string' && finding.text.includes('\n'))
      .sort((left, right) => (right.text ?? '').length - (left.text ?? '').length);
    const widest = findings[0];
    const lines = widest?.text?.split('\n') ?? [];
    if (widest === undefined || lines.length <= 1) break;
    const head = lines.shift() ?? '';
    // L11-01: a label line under the head is part of the head: it is never the last item left standing.
    const meta: string[] = [];
    while (lines.length > 0 && FINDING_META_LINE.test(lines[0]!)) meta.push(lines.shift()!);
    if (lines.length === 0) { reply['findings'] = (reply['findings'] as JsonObject[]).filter(finding => finding !== widest); trimmed = true; continue; }
    if (widest.source === 'web') {
      const kept = clipWebEvidence(widest.text!, widest.text!.length - (size() - limit) - RESEARCH.moreAvailableNote.length - 80);
      if (kept !== undefined) { widest.text = kept; widest.chars = kept.length; }
      else {
        reply['findings'] = (reply['findings'] as JsonObject[]).filter(finding => finding !== widest);
        webInsufficient(reply, 'reply_budget');
      }
      trimmed = true; continue;
    }
    if (lines.length === 1) {
      // R5 (RESCAP-R5): the last evidence line is clipped to the room left, so a long best hit still answers.
      // #5: the clipped hit is still shown, so the header it keeps counts it.
      const room = lines[0]!.length - (size() - limit) - 1;
      const kept = sentencePrefix(lines[0]!, room) || clip(lines[0]!, room);
      if (kept.length >= RESEARCH.clipFloorChars) { widest.text = [head, ...meta, kept].join('\n'); widest.chars = kept.length; trimmed = true; continue; }
    }
    // #5: only a line this pass really removes is counted out of the header, never one it clipped.
    const counted = head.replace(/: (\d+) of (\d+) shown$/u, (_match, shown: string, total: string) => `: ${Math.max(0, Number(shown) - 1)} of ${total} shown`);
    // L11-03: the coverage header carries the same count, so a trim after it was built never leaves them apart.
    if (refresh === undefined && typeof reply['coverage'] === 'string' && typeof widest.source === 'string') {
      const own = /: (\d+) of (\d+) shown$/u.exec(head);
      if (own) reply['coverage'] = String(reply['coverage']).replace(new RegExp(`\\b${widest.source} (\\S+) ${own[1]} of ${own[2]} shown`, 'u'),
        (_match, status: string) => `${widest.source} ${status === 'complete' ? 'truncated_to_budget' : status} ${Math.max(0, Number(own[1]) - 1)} of ${own[2]} shown`);
    }
    lines.pop();
    // F2 (review): a header that claims a count over no evidence line is a lie, so the finding goes whole.
    if (lines.length === 0) reply['findings'] = (reply['findings'] as JsonObject[]).filter(finding => finding !== widest);
    else { widest.text = [counted, ...meta, ...lines].join('\n'); widest.chars = lines.join('\n').length; }
    trimmed = true;
  }
  // F2 (review): the hard bound. The page envelopes carry the same evidence as the findings, so they go last.
  if (size() > limit && reply['historyPages'] !== undefined) { delete reply['historyPages']; trimmed = true; }
  if (size() > limit) {
    // The last bound: only the identity, the honest state and the note survive, because nothing else can be
    // cut without breaking the structure, and the note already says the rest was left out.
    const researchId = reply['researchId'];
    const lostWeb = Array.isArray(reply['findings']) && reply['findings'].some(finding => isRecord(finding) && finding['source'] === 'web');
    const insufficiency = reply['webInsufficient'];
    for (const key of Object.keys(reply)) if (!['markdown', 'webSources', 'webAttribution'].includes(key)) delete reply[key];
    if (lostWeb || insufficiency !== undefined) webInsufficient(reply, isRecord(insufficiency) ? String(insufficiency['reason']) : 'reply_budget');
    reply['researchId'] = researchId;
    reply['status'] = 'partial';
    reply['canContinue'] = true;
    reply['findings'] = [];
    trimmed = true;
  }
  settle();
  return reply;
}

function buildReply(run: RunState, status: 'answered' | 'partial' | 'stopped' | 'unavailable', configured: readonly SourceKind[], canContinue: boolean, limit: number, sources?: JsonObject, skipBodies = false, bodyLimit = RESEARCH.bodyLimitChars): JsonObject {
  const bodyReply = skipBodies ? undefined : receivedBodyReply(run, configured, bodyLimit);
  if (bodyReply) { if (Array.isArray((bodyReply as JsonObject)['bodySlices'])) run.bodyReplies += 1; return bodyReply; }
  const groups: { source: SourceKind; label: string; lines: string[]; total: number; days?: { day: string; entries: string[] }[]; meta?: string[] }[] = [];
  const shownLines = new Set<string>();
  for (const entry of run.ledger.values()) {
    if (entry.bodyOnly || !entry.lines || entry.lines.length === 0 || entry.source === null || (entry.source === 'calendar' && run.calendar.size > 0) || (entry.source === 'mail' && run.mail.size > 0)) continue;
    const existing = groups.find(group => group.source === entry.source);
    const target = existing ?? { source: entry.source, label: SOURCE_LABEL[entry.source], lines: [], total: 0 };
    // L11-01: the ranker's confidence label rides with the finding but is no item, so no trim can leave it
    // standing in for the hits and no count includes it.
    const meta = entry.lines.filter(line => FINDING_META_LINE.test(line));
    const items = entry.lines.filter(line => !FINDING_META_LINE.test(line));
    if (meta.length > 0) target.meta = [...new Set([...(target.meta ?? []), ...meta])];
    // C-DEPTH item 2: a hit two reads both returned is shown once, and the number of dropped copies is no
    // new evidence, so the count of what was returned keeps the read's own total.
    for (const line of items) {
      const key = line.trim();
      if (key === '' || shownLines.has(key)) continue;
      shownLines.add(key);
      target.lines.push(line);
    }
    target.total += entry.total === undefined ? items.length : entry.total === entry.lines.length ? items.length : entry.total;
    if (!existing) groups.push(target);
  }
  // C-DEPTH item 2: an ask that names a person or a document gives her memory no allocation at all, unless
  // it refers to a past conversation, so her own notes can never crowd out the evidence she was asked for.
  if (requestedEntities(run.question ?? '').length > 0 && !pastConversationAsk(run.question ?? '')) {
    const at = groups.findIndex(group => group.source === 'memory');
    if (at >= 0) groups.splice(at, 1);
  }
  const calendarEvents = new Map<string, RetainedCalendarEvent>();
  for (const read of run.calendar.values()) for (const [key, event] of read.events) calendarEvents.set(key, event);
  const remaining = [...calendarEvents].filter(([key]) => !run.calendarDelivered.has(key)).sort(([, a], [, b]) => a.start.localeCompare(b.start));
  // E8: the whole window comes back, one line per day, so a week is never re-asked day by day.
  const calendarDays = compactCalendarWindow(remaining.map(([, event]) => event), run.timeZone);
  if (remaining.length > 0) groups.push({ source: 'calendar', label: SOURCE_LABEL.calendar, lines: calendarDayLines(calendarDays), days: calendarDays, total: Math.max(calendarEvents.size, remaining.length) });
  const calendarReads = [...run.calendar.values()];
  const calendarUpstream = calendarReads.some(read => !read.failed && !read.exhausted);
  const calendarPartial = calendarReads.some(read => read.failed || read.unread > 0 || read.upstreamIncomplete || !read.exhausted);
  // A source that delivered part of its answer makes a routed answer partial. A source that read
  // nothing and is named unreachable does not, when another layer answered the call.
  if (calendarPartial && status === 'answered' && (sources === undefined || calendarEvents.size > 0)) status = 'partial';
  const calendarCoverage = calendarReads.length === 0 ? undefined : {
    scope: 'primary', received: calendarEvents.size, remaining: remaining.length,
    upstreamRemaining: calendarReads.some(read => !read.failed && !read.exhausted),
    failed: calendarReads.some(read => read.failed), upstreamIncomplete: calendarReads.some(read => read.upstreamIncomplete), bodyTruncated: calendarReads.some(read => read.bodyTruncated),
    calendarListComplete: run.calendarScope ? !run.calendarScope.partial : false,
  };
  const receivedMail = mailMessages(run);
  const allMailRemaining = [...receivedMail].filter(([key]) => !run.mailDelivered.has(key));
  const cursorPage = run.mailCursorRequested ? run.mailCursors.get(run.mailCursorRequested) : undefined;
  const mailRemaining = cursorPage?.ids.length ? allMailRemaining.filter(([key]) => cursorPage.ids.includes(key)) : allMailRemaining;
  const mailReads = [...run.mail.values()];
  if (mailRemaining.length) groups.push({ source: 'mail', label: SOURCE_LABEL.mail, lines: mailRemaining.slice(0, MAIL_LINES_SHOWN).map(([, message]) => message.line), total: receivedMail.size });
  const mailUpstream = mailReads.some(read => !read.failed && !read.exhausted);
  const mailIncomplete = mailReads.some(read => read.failed || read.upstreamIncomplete || read.invalid > 0 || [...read.messages.values()].some(message => message.bodyTruncated));
  if ((mailIncomplete || mailUpstream || mailRemaining.length > 8) && status === 'answered' && (sources === undefined || receivedMail.size > 0)) status = 'partial';
  const readSources = new Set(run.sourcesDone);
  const unchecked = configured.filter(source => !readSources.has(source));
  // Outcome 2: name the sources this run could not reach, in one short clause the model can voice,
  // so an outage is never hidden behind a narrow answer. `knowledge` leads the findings.
  groups.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  // #635: a chat read that failed by timing out is said as a timeout with its budget, never as a chat out of
  // reach. #569 keeps its timeout reason on the web's endpoint; #655 says that timeout as the web taking too long.
  const chatTimedOut = run.sourcesFailed.has('chat') && TIMED_OUT.has(run.unavailableReasons.get('chat') ?? '');
  // #655: a web read cut at its budget says the web took too long, never that the web could not be reached.
  const webTimedOut = run.sourcesFailed.has('web') && TIMED_OUT.has(run.unavailableReasons.get('web') ?? '');
  const unreachable = SOURCE_LABELS.filter(([source]) => run.sourcesFailed.has(source) && !(chatTimedOut && source === 'chat')
    // #637: a channel it does not know is said in its own clause below, never as a chat out of reach.
    && !(source === 'chat' && (run.unavailableReasons.get('chat') ?? '').startsWith('channel_not_found'))
    // #655: the web's own clause below says it took too long, so it is never also called unreachable.
    && !(webTimedOut && source === 'web')).map(([, label]) => label);
  // C-CHAT: a chat read that asked which one was meant, or knew no such name, read nothing by design, never "nothing matching".
  const searchedNothing = SOURCE_LABELS.filter(([source]) => run.emptySearches.has(source) && !run.sourcesFailed.has(source) && !(source === 'chat' && run.chatUnresolved !== undefined))
    .map(([source, label]) => `I searched your ${label}${run.emptySearches.get(source) ?? ''} and found nothing matching.`);
  // N3: a read cut short is not a read that found nothing, and the reply must not blur the two.
  const cutShort = SOURCE_LABELS.filter(([source]) => run.cutShort.has(source) && !run.sourcesFailed.has(source) && run.sourcesDone.has(source))
    .map(([, label]) => `My ${label} read took too long, so I say what I have and ask one precise follow-up.`);
  // #1020: the coverage line and the named failures ride with the clauses the model voices, so a partial
  // read is never a sentence the model has to infer from a count or from silence.
  const coverage = calendarCoverageLine(run);
  const trouble = sourceTroubleLine(run);
  // F2: a mail read that failed or stopped at its page cap says so in plain words, so a partial mailbox
  // is never read as the whole one.
  const mailCoverageNote = mailReads.length === 0 ? undefined
    : mailReads.some(read => read.failed) ? 'The mail search stopped before the end, so there may be more mail than this.'
    : mailReads.some(read => !read.exhausted) ? 'The mail search stopped at its page limit, so there may be more mail than this.'
    : undefined;
  // #647: a broadened chat retry matched on one word, so the answer says the match was broadened.
  const chatBroadenedNote = run.broadenedChat.size === 0 ? undefined
    : `The chat search matched nothing on every word, so I broadened it to ${[...new Set(run.broadenedChat.values())].join(' and ')}.`;
  const clauses = [
    ...(webTimedOut ? ['The web took too long to answer, so that part is missing.'] : []),
    // #663: a web part that never arrived is missing, and whatever the model adds from itself about it is its
    // own knowledge, not a read, so the reply says which it is.
    ...(run.sourcesFailed.has('web') ? [RESEARCH.generalKnowledgeNote] : []),
    ...(unreachable.length === 0 ? [] : [`I could not reach ${unreachable.length === 1 ? unreachable[0]! : `${unreachable.slice(0, -1).join(', ')} and ${unreachable[unreachable.length - 1]!}`} right now.`]),
    // LOGS.md L-01: a source that failed with a classified reason says that reason verbatim, so the
    // owner hears the helper's own line (for Drive consent: the exact authorize command) and not a
    // search that found nothing.
    ...[...run.failureLines.values()],
    ...cutShort,
    ...searchedNothing,
    ...(coverage !== undefined ? [coverage] : []),
    ...(trouble !== undefined ? [trouble] : []),
    ...(mailCoverageNote !== undefined ? [mailCoverageNote] : []),
    ...(chatBroadenedNote !== undefined ? [chatBroadenedNote] : []),
    // C-CHAT: the chat read names who or which channel it read and over which window, or asks which one.
    ...run.chatNotes,
  ];
  if (run.unavailableReasons.get('calendar') === 'window_unparsed') clauses.push('I could not resolve that calendar date or window. Give a supported weekday, today, tomorrow, week, this week, next week, or an exact valid date.');
  // #637: a channel the ask names and the chat connector does not know is said in the owner's words,
  // never as a search that found nothing and never as a chat that could not be reached.
  if (run.unavailableReasons.get('chat') === 'channel_not_found') {
    // #663: the connector's refusal names the closest channels, so the owner hears the one she probably meant.
    const closest = run.chatChannelClosest;
    const hint = closest.length === 0 ? ''
      : ` The closest names I have are ${closest.length === 1 ? closest[0]! : `${closest.slice(0, -1).join(', ')} and ${closest[closest.length - 1]!}`}.`;
    clauses.push(`I do not know a channel called ${run.chatChannel ?? 'that'}.${hint}`);
  }
  let note = clauses.length === 0 ? undefined : clauses.join(' ');
  // P5: a source that could not be read names its own reason, so an outage is never read as "nothing
  // found" and never as a timeout.
  const unavailableReasons = run.unavailableReasons.size === 0 ? undefined : Object.fromEntries(run.unavailableReasons);
  let dropped = 0;
  let droppedEvents = 0;
  const shownOf = (group: { lines: string[]; days?: { day: string; entries: string[] }[] }): number => group.days === undefined ? group.lines.length : group.days.reduce((n, day) => n + day.entries.length, 0);
  // A calendar trim drops one event, never a whole day, so a full window loses as little as the budget needs.
  const trimCalendarEvent = (group: { lines: string[]; days?: { day: string; entries: string[] }[] }): boolean => {
    const days = group.days;
    if (days === undefined || days.length === 0) return false;
    days[days.length - 1]!.entries.pop();
    while (days.length > 0 && days[days.length - 1]!.entries.length === 0) days.pop();
    group.lines.splice(0, group.lines.length, ...calendarDayLines(days));
    droppedEvents += 1;
    return true;
  };
  // #621: the hits each source matched with, kept apart from what a trim leaves, so the header can say
  // `2 of 9 shown` truthfully after the reply is bounded.
  const totals = new Map<SourceKind, number>();
  for (const group of groups) totals.set(group.source, Math.max(group.total, group.lines.length));
  // C-DEPTH item 3 (W10-R6): a full entry read that was cut is named in the header, so the reply says the
  // knowledge it carries is the summaries rather than a silent drop.
  const coverageOf = (findings: readonly FindingLike[]): string =>
    `${coverageTextOf(run, configured, findings, totals, limit)}${run.knowledgeFetchCut === true ? '; knowledge entries excerpt' : ''}${depthClauseOf(run.question ?? '', findings)}`;
  const render = (): { findings: ReplyFinding[]; reply: JsonObject } => {
    const calendarShown = shownOf(groups.find(group => group.source === 'calendar') ?? { lines: [] });
    const calendarPending = calendarUpstream || calendarShown < remaining.length;
    if (calendarPending && status === 'answered' && (sources === undefined || calendarEvents.size > 0)) status = 'partial';
    const mailShown = groups.find(group => group.source === 'mail')?.lines.length ?? 0;
    const mailPending = (cursorPage?.ids.length ? Boolean(cursorPage.nextCursor) : mailUpstream) || mailRemaining.length > mailShown;
    const mailFields = mailReads.length ? {
      mailMessages: mailRemaining.slice(0, mailShown).map(([, message]) => ({ id: message.id, threadId: message.threadId, internalDate: message.internalDate })),
      mailCoverage: { view: 'metadata', metadataTruncated: mailReads.some(read => [...read.messages.values()].some(message => message.bodyTruncated)), received: receivedMail.size, receivedOccurrences: mailReads.reduce((n, read) => n + read.received, 0), shown: mailShown, localRemaining: Math.max(0, allMailRemaining.length - mailShown), upstreamRemaining: mailUpstream, invalid: mailReads.reduce((n, read) => n + read.invalid, 0), failed: mailReads.some(read => read.failed), upstreamIncomplete: mailReads.some(read => read.upstreamIncomplete) },
      ...(mailPending ? { nextCursor: '00000000-0000-0000-0000-000000000000' } : {}),
      ...(run.mailCursorRequested ? { cursor: run.mailCursorRequested } : {}),
    } : {};
    const findings: ReplyFinding[] = groups.filter(group => group.lines.length > 0)
      .map(group => {
        // N3: the primary-calendar answer says what it did not read, from the list it carried.
        const note = run.calendarNotRead !== undefined && group.source === 'calendar' && !group.lines.includes(run.calendarNotRead) ? `\n${run.calendarNotRead}` : '';
        const text = `${group.label}: ${shownOf(group)} of ${Math.max(group.total, group.lines.length)} shown\n${[...(group.meta ?? []), ...group.lines].join('\n')}${note}`;
        // #575: a block this session already gave is one line, never a second copy of the same evidence.
        if (run.deliveredFindings.has(findingKey(text))) return { source: group.source, text: `${group.label}: already given earlier in this session.`, chars: 0 };
        return { source: group.source, text, chars: group.lines.join('\n').length };
      });
    // ROUTE-1022 (#526): a reply says whether it is the whole answer. A complete one says so in plain
    // words, so the model never spends another call fetching what is already in hand.
    const trimmed = dropped > 0 || calendarPending || mailPending;
    // K8b: a source still reading is named in the note and keeps the reply partial, so the model never
    // hears "nothing more" while a read it asked for is still in flight.
    // #653: a closed run has no read in flight, so no source is named as still reading once it ended.
    const closed = run.ended || run.stopped || run.cancelled;
    const stillReading = closed ? [] : configured.filter(source => run.pending.has(source));
    const complete = status === 'answered' && !trimmed && stillReading.length === 0 && [...run.sourcesDone].some(source => configured.includes(source));
    // LAT-1023: evidence left unread is named in one short clause, so a capped answer is never read as the
    // whole record. A source this run never reached and a page it dropped both count as unread.
    // #3: a read that found nothing was still made, so it never rides the "did not search" note.
    const unsearched = configured.filter(source => !run.sourcesDone.has(source) && !run.sourcesFailed.has(source) && !run.emptySearches.has(source) && !run.pending.has(source));
    const moreAvailable = trimmed || unsearched.length > 0;
    // N5 (#568): the note offers a continuation only when this reply can serve one, so the model never
    // spends a round on a continue the run answers with continuation_unavailable.
    // #657: a status ask wider than one batch names the sources it left for the next call.
    const deferred = run.deferredSources ?? [];
    const canRepeat = complete && deferred.length === 0 ? false : canContinue || trimmed || deferred.length > 0;
    // #4: the left-out count is derived inside the measured reply, so the header's total and this sentence
    // never drift apart when a later trim takes one more event out.
    const calendarGroup = groups.find(group => group.source === 'calendar');
    const calendarLeftOut = calendarGroup === undefined ? 0 : Math.max(0, calendarGroup.total - shownOf(calendarGroup));
    const spokenNote = calendarLeftOut === 0 ? note
      : note === undefined ? `I left out ${calendarLeftOut} calendar ${calendarLeftOut === 1 ? 'event' : 'events'} to keep this answer short.`
        : `${note} I left out ${calendarLeftOut} calendar ${calendarLeftOut === 1 ? 'event' : 'events'} to keep this answer short.`;
    // R4: this note is composed when the run has stopped waiting, so a source still in `pending` did not return in
    // time; only the first answer point, which answers while the readers keep going, says "still searching".
    let settledNote = complete ? (spokenNote === undefined ? RESEARCH.completeNote : `${spokenNote} ${RESEARCH.completeNote}`)
      : stillReading.length > 0 ? `${RESEARCH.hardStopNote}${stillReading.map(source => SOURCE_LABEL[source]).join(', ')}`
        // #634: an unread source is named once, in the coverage header, never again in the note.
        : canRepeat && moreAvailable ? (spokenNote === undefined ? RESEARCH.moreAvailableNote : `${spokenNote} ${RESEARCH.moreAvailableNote}`) : spokenNote;
    // #653: a status ask hears each source's own outcome in plain words, never a guess about it.
    if (statusAsk(run.question ?? '')) settledNote = statusReport(run, configured);
    // #654: a run the host opened fresh says so, so the model never reads it as the old run continued.
    if (run.startedFresh === true) settledNote = settledNote === undefined ? 'This is a fresh lookup, not a continuation.' : `This is a fresh lookup, not a continuation. ${settledNote}`;
    if (deferred.length > 0) {
      const rest = `The rest come next: ${deferred.map(source => SOURCE_LABEL[source]).join(', ')}.`;
      settledNote = settledNote === undefined ? rest : `${settledNote} ${rest}`;
    }
    return { findings, reply: { coverage: coverageOf(findings), ...coverageRows(operationCoverage(run, findings)), researchId: run.researchId, status: status !== 'answered' ? status : complete ? 'complete' : 'partial', findings, unchecked, canContinue: canRepeat, ...(run.web.length > 0 ? { markdown: webFooter(run.web, run.webAttribution), webSources: run.web.map(({ title, url }) => ({ title, url })), ...(run.webAttribution.length === 0 ? {} : { webAttribution: run.webAttribution }) } : {}), ...mailFields, ...(calendarCoverage ? { calendarCoverage: { ...calendarCoverage, shown: calendarShown, localRemaining: Math.max(0, remaining.length - calendarShown) } } : {}), ...(settledNote !== undefined ? { note: settledNote } : {}), ...(sources !== undefined ? { sources } : {}), ...(unavailableReasons !== undefined ? { unavailable: unavailableReasons } : {}) } };
  };
  // Trim the longest source first, down to a source's last line: the Live budget is a hard bound, so a kept
  // line wider than the budget is dropped whole rather than left to overrun it (LAT-1023 B3). R5 (RESCAP-R5):
  // when that line is a source's only evidence, it is clipped to the room left instead, because dropping it
  // emptied the answer for a long best hit.
  let webDropped = false;
  let guard = 4096;
  // #621: two passes. The floor first, which is one whole finding line per source that returned a hit, so a
  // capped reply never hides a source; then proportional fill, which takes from the source furthest above its
  // share of the room. Only when even the floor overruns is that last line clipped, at a word boundary.
  while (guard-- > 0) {
    const rendered = spokenReplySize(render().reply);
    if (rendered <= limit) break;
    // C-DEPTH item 2: a source keeps about its floor of substantive evidence, so one line is not "shown".
    const charsOf = (group: { lines: string[] }): number => group.lines.reduce((sum, line) => sum + line.length + 1, 0);
    const fillable = groups.filter(group => shownOf(group) > (group.days === undefined ? 1 : 2)
      && charsOf(group) > RESEARCH.sourceFloorChars);
    if (fillable.length > 0) {
      const kept = (group: { lines: string[]; total: number }): number => shownOf(group) / Math.max(1, group.total);
      // L11-01: memory the ask did not name yields first, so it can never starve a source that answered beside it.
      // C-DEPTH item 2: an ask that names a person or a document gives her memory no allocation at all, unless
      // the ask refers to a past conversation, so her own notes can never crowd out the evidence she was asked for.
      const names = requestedEntities(run.question ?? '').length > 0 && !pastConversationAsk(run.question ?? '');
      const memory = names || !run.route.has('memory') ? fillable.find(group => group.source === 'memory') : undefined;
      const trimmed = memory !== undefined && groups.some(group => group.source !== 'memory' && shownOf(group) > 0) ? memory
        : fillable.reduce((worst, group) => (kept(group) > kept(worst) ? group : worst));
      // #4: a calendar day line is a list of whole events, so it loses one event at a time, the count it
      // reports is the count of events it really dropped, and it is never clipped: a clip would swallow an
      // event while the header still claimed it. Its last event stays, so the answer keeps the day it read.
      if (trimmed.days !== undefined) { trimCalendarEvent(trimmed); continue; }
      const last = trimmed.lines[trimmed.lines.length - 1]!;
      if (trimmed.source === 'web') {
        const keptLine = clipWebEvidence(last, last.length - (rendered - limit) - RESEARCH.moreAvailableNote.length - 80);
        if (keptLine !== undefined) trimmed.lines[trimmed.lines.length - 1] = keptLine;
        else { trimmed.lines.pop(); webDropped = true; dropped += 1; }
        continue;
      }
      trimmed.lines.pop(); dropped += 1;
      continue;
    }
    // The floor: one line per source. A line wider than the whole room is clipped, never left half a word.
    const widest = groups.filter(group => shownOf(group) > 0).sort((a, b) => b.lines.join(' ').length - a.lines.join(' ').length)[0];
    if (widest === undefined) break;
    const last = widest.lines[widest.lines.length - 1]!;
    const room = last.length - (rendered - limit) - 1;
    const clipped = room >= FLOOR_CLIP_CHARS ? sentencePrefix(last, room) || clip(last, room) : '';
    // C-DEPTH item 2: a shortened line is still a compacted answer, so the receipt records it as one even
    // though no whole item was dropped: the floor protects short sources and the widest one is cut instead.
    if (clipped.length >= FLOOR_CLIP_CHARS) { widest.lines[widest.lines.length - 1] = clipped; dropped += 1; continue; }
    // LAT-1023 B3 under C-DEPTH item 2: the budget is a hard bound, so when the floor can neither shorten the
    // widest line usefully nor spare a second one, that last line goes whole and the header counts it out.
    if (shownOf(widest) <= 1) { widest.lines.pop(); dropped += 1; continue; }
    widest.lines.pop(); dropped += 1;
  }
  const compactItems = dropped + droppedEvents;
  const { findings, reply } = render();
  const result: CalendarReply & MailReply = { ...reply, findings };
  if (mailReads.length) {
    const shown = groups.find(group => group.source === 'mail')?.lines.length ?? 0;
    const tail = cursorPage?.ids.length ? cursorPage.nextCursor : mailSourceCursor(run);
    const nextCursor = mailMessageCursor(run, mailRemaining.slice(shown).map(([key]) => key), tail);
    if (nextCursor) result['nextCursor'] = nextCursor;
    else delete result['nextCursor'];
    if (cursorPage && cursorPage.ids.length === 0) {
      cursorPage.ids = mailRemaining.slice(0, shown).map(([key]) => key);
      if (nextCursor) cursorPage.nextCursor = nextCursor;
      cursorPage.partial = status === 'partial';
    }
    result[mailDelivery] = { researchId: run.researchId, runId: run.runId, keys: mailRemaining.slice(0, shown).map(([key]) => key), ...(run.mailCursorRequested ? { cursor: run.mailCursorRequested } : {}), ...(nextCursor ? { nextCursor } : {}) };
  }
  if (compactItems > 0) (result as CompactionReply)[compactionDelivery] = { items: compactItems };
  if (calendarReads.length > 0) result[calendarDelivery] = { researchId: run.researchId, runId: run.runId, keys: remaining.slice(0, shownOf(groups.find(group => group.source === 'calendar') ?? { lines: [] })).map(([key]) => key) };
  if (webDropped && !findings.some(finding => finding.source === 'web')) webInsufficient(result, 'reply_budget');
  // #634: the header is rebuilt inside every measured pass, so its counts match the evidence that ships and
  // the reply is measured with the header it carries.
  const capped = capReply(result, limit, () => {
    if (typeof result['coverage'] === 'string') result['coverage'] = coverageOf(Array.isArray(result['findings']) ? result['findings'] as unknown as FindingLike[] : []);
    if (typeof result['coverage'] === 'string') {
      const rows = operationCoverage(run, Array.isArray(result['findings']) ? result['findings'] as unknown as FindingLike[] : []);
      if (rows.length === 0) delete result['sourceCoverage']; else result['sourceCoverage'] = rows;
    }
  });
  // #575: what this reply actually carried is what the session must not hand over again.
  for (const finding of (Array.isArray(capped['findings']) ? capped['findings'] as { text?: string }[] : [])) {
    if (typeof finding.text === 'string' && finding.text.length > 0 && !finding.text.includes(ALREADY_GIVEN)) run.deliveredFindings.add(findingKey(finding.text));
  }
  return capped;
}

/** A listing ask browses entities; anything else is a question the answer mode answers. */
const COMPANY_LISTING = /\b(?:list|which|what|who)\b[^?]{0,60}\b(?:companies|company|products|markets|offerings|tickets)\b/iu;
export function companyLookupMode(query: string): 'answer' | 'browse' {
  return COMPANY_LISTING.test(query) ? 'browse' : 'answer';
}

/**
 * W3-R1: the count metrics the data endpoint serves, in the published shape the live fixture carries.
 * A metric question is one `search_fields` for the field names and one `run_metric_query` for the rows.
 */
const COMPANY_METRICS: readonly {
  words: RegExp; exploreName: string; metric: string; dateField: string; countryField: string;
}[] = [{
  words: /\b(?:active users?|users?|dau|daily active|monthly active)\b/iu,
  exploreName: 'active_users_daily',
  metric: 'active_users_daily_n_active_users',
  dateField: 'active_users_daily_event_date_day',
  countryField: 'active_users_daily_country',
}];

/** The country the owner named, spelled as the owner spelled it, or none when the ask names no place. */
function metricCountryOf(question: string): string | undefined {
  const match = /\bin ([\p{Lu}][\p{L}]+(?: [\p{Lu}][\p{L}]+)*)/u.exec(question);
  return match?.[1]?.trim();
}

/**
 * W3: the days the ask names. A count over no window is the all-time sum of daily distinct users, which
 * the live endpoint answered with 948,541 and which is not a user count, so no window is a refusal.
 */
function metricWindowDays(question: string): number | undefined {
  if (/\btoday\b/iu.test(question)) return 1;
  if (/\byesterday\b/iu.test(question)) return 2;
  const counted = /\b(?:last|past) (\d+) days?\b/iu.exec(question);
  if (counted?.[1] !== undefined) {
    const days = Number(counted[1]);
    if (Number.isSafeInteger(days) && days >= 1 && days <= 90) return days;
  }
  if (/\b(?:this|last) week\b/iu.test(question)) return 7;
  return undefined;
}

/**
 * W3-R1: the data read of one count question. `search_fields` names the fields, `run_metric_query` asks
 * for the rows, both in the exact published argument shape of the live fixture. A count with no date
 * dimension and no date filter is refused here with the closed code, never dispatched as an all-time sum.
 */
export function companyMetricSubs(query: string, question: string, nowMs: number): { subs: IntentSubCall[] } | { refusal: 'count_needs_date_window' } {
  const metric = COMPANY_METRICS.find(entry => entry.words.test(query) || entry.words.test(question)) ?? COMPANY_METRICS[0]!;
  const days = metricWindowDays(question);
  if (days === undefined) return { refusal: 'count_needs_date_window' };
  const country = metricCountryOf(question);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const where = country ?? 'all countries';
  const dimensions = [
    ...(country === undefined ? [] : [{ fieldId: metric.countryField, operator: 'equals', values: [country] }]),
    { fieldId: metric.dateField, operator: 'inThePast', values: [days], settings: { unitOfTime: 'days' } },
  ];
  return { subs: [
    { key: 'm0', name: INTERNAL.mongooseSearchFields, args: { patterns: [query.trim()], exploreName: metric.exploreName } },
    { key: 'm1', name: INTERNAL.mongooseMetricQuery, args: {
      title: `${where} daily active users as of ${day}`,
      description: `Daily active users ${country === undefined ? '' : `in ${country} `}per day over the last ${days} day${days === 1 ? '' : 's'}.`,
      queryConfig: {
        exploreName: metric.exploreName,
        metrics: [metric.metric],
        dimensions: [metric.dateField],
        filters: { dimensions, type: 'and' },
        sorts: [{ fieldId: metric.dateField, descending: true }],
        limit: 10,
      },
    } },
  ] };
}

/**
 * The company lookup: one search, and for a question one read of the top hit's ref, so the finding
 * carries the entity behind the answer instead of a title alone.
 */
function companySubs(query: string): IntentSubCall[] {
  return [{ key: 'co0', name: INTERNAL.mongooseSearch, args: { query, mode: companyLookupMode(query) } }];
}

/** C-OPEN 2: the file types each spoken kind noun means, so an ask for the deck never lists a sheet. */
export const DRIVE_MIME_TYPES: Readonly<Record<'deck' | 'doc' | 'sheet', readonly string[]>> = {
  deck: ['application/vnd.google-apps.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'],
  doc: ['application/vnd.google-apps.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'],
  sheet: ['application/vnd.google-apps.spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
};
const DRIVE_KIND_WORDS: readonly { kind: keyof typeof DRIVE_MIME_TYPES; words: RegExp }[] = [
  { kind: 'deck', words: /\b(?:decks?|slides?|presentations?|pptx?|powerpoints?)\b/u },
  { kind: 'sheet', words: /\b(?:sheets?|spreadsheets?|xlsx?|excel)\b/u },
  { kind: 'doc', words: /\b(?:docs?|documents?|docx)\b/u },
];
/** The words that name the kind, the app or the act, never the file; what is left is the name searched. */
const DRIVE_FILLER = /\b(?:the|a|an|my|our|his|open|opening|show|find|pull|bring|up|please|in|on|chrome|browser|google|drive|file|files|decks?|slides?|presentations?|pptx?|powerpoints?|sheets?|spreadsheets?|xlsx?|excel|docs?|documents?|docx|word|link|from|of|for|that|this|it|me|can|you|could|would)\b/gu;
/** The reread of one file he picked: `id:` and the id a listing carried. */
const DRIVE_FILE_ID = /^id:\s*([A-Za-z0-9_-]{10,256})$/u;

/** C-OPEN 2 and 3: a name search typed by the kind he named, or the fresh read of one file by its id. */
function driveSubs(query: string, ownerWords: string): IntentSubCall[] {
  const id = DRIVE_FILE_ID.exec(query.trim())?.[1];
  if (id !== undefined) return [{ key: 'dr0', name: INTERNAL.driveGet, args: { file_id: id } }];
  const text = query.toLowerCase();
  const kind = (DRIVE_KIND_WORDS.find(entry => entry.words.test(text)) ?? DRIVE_KIND_WORDS.find(entry => entry.words.test(ownerWords.toLowerCase())))?.kind;
  const name = text.replace(DRIVE_FILLER, ' ').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
  if (name === '') return [];
  return [{ key: 'dr0', name: INTERNAL.driveSearch, args: { query: name, ...(kind === undefined ? {} : { mime_types: [...DRIVE_MIME_TYPES[kind]] }), limit: 5 } as JsonObject }];
}

/**
 * K6: one routed lookup. `memory` is read in process; every other layer becomes the internal read that
 * source already owns, under its own per-source deadline. Nothing here consults the selector.
 */
function routedRead(lookup: ResearchLookup, context: { question: string; topic?: string | undefined; ownerWords?: string | undefined; configured: readonly SourceKind[]; run: RunState; now: () => number; timeZone?: string }): { unresolved?: boolean; reason?: string; source: SourceKind | 'memory'; kind: LedgerKind; subs: IntentSubCall[] } {
  const query = lookup.query;
  if (lookup.source === 'memory') return { source: 'memory', kind: 'memory_search', subs: [{ key: 'history', name: HISTORY_IDENTITY.name, args: { ...(lookup.history ?? { query }) } }] };
  if (lookup.source === 'company') return { source: 'mongoose', kind: 'knowledge_search', subs: companySubs(query) };
  if (lookup.source === 'data') {
    // W3-R1: the numbers source is the data endpoint's field search and one metric query. A count with
    // no date window settles refused under its own closed code and the one-line repair.
    const metric = companyMetricSubs(query, context.question, context.now());
    return 'refusal' in metric
      ? { source: 'data', kind: 'company_metric', subs: [], unresolved: true, reason: metric.refusal }
      : { source: 'data', kind: 'company_metric', subs: metric.subs };
  }
  // The attention digest answers "what is waiting on him"; it takes no query of its own.
  if (lookup.source === 'replies') return { source: 'chat', kind: 'chat_search', subs: [{ key: 'at0', name: INTERNAL.chatAttention, args: {} as JsonObject }] };
  const subsConfig = { question: context.question, topic: context.topic, ownerWords: context.ownerWords, configured: context.configured, evidence: context.run.evidence, query, nowMs: context.now(), timeZone: context.timeZone };
  // N3: a voice turn reads the primary calendar only, one bounded call. The merged read is one remote
  // call per visible calendar (22 on the smoke account) and can never finish inside the run deadline, so
  // it always came back empty and the owner heard nothing; the full merge stays on the calendar intent.
  // The calendar list rides along only so the result can say what it did not read.
  if (lookup.source === 'calendar') {
    let range: { timeMin: string; timeMax: string };
    // An unnamed window is unresolved, never widened: only the declared grammar resolves here.
    try { range = windowRange(calendarWindowOf(query) || calendarWindowOf(context.question), context.now(), context.timeZone); }
    catch { return { source: 'calendar', kind: 'calendar_window', subs: [], unresolved: true, reason: 'window_unparsed' }; }
    return { source: 'calendar', kind: 'calendar_window', subs: [
      { key: 'cal0', name: INTERNAL.calendarList, args: { calendarId: 'primary', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.pageResults.calendar } as JsonObject },
      { key: 'cal1', name: INTERNAL.calendars, args: { maxResults: 20 } as JsonObject },
    ] };
  }
  if (lookup.source === 'knowledge') return { source: 'knowledge', kind: 'knowledge_search', subs: candidateSubs('knowledge_search', subsConfig) };
  if (lookup.source === 'mail') {
    const plan = lookup.mail
      ? {
        source: 'mail' as const, kind: 'id' in lookup.mail ? 'mail_open' as const : 'mail_search' as const,
        subs: [{
          key: 'mail0', name: 'id' in lookup.mail ? INTERNAL.mailRead : INTERNAL.mailList,
          args: 'id' in lookup.mail ? { ...lookup.mail } : { ...mailPageArgs(lookup.mail as JsonObject, context.question), q: compileMailQuery(context.question, lookup.mail.q, context.now(), context.timeZone, context.topic, context.ownerWords, undefined, context.configured) },
        }],
      }
      : { source: 'mail' as const, kind: 'mail_search' as const, subs: candidateSubs('mail_search', subsConfig) };
    // F2: the live step speaks the owner's words, never the compiled Gmail query.
    const owned = lookup.mail === undefined || !('q' in lookup.mail) ? lookup.query : lookup.mail.q;
    for (const sub of plan.subs) {
      const compiled = (sub.args as JsonObject)['q'];
      if (typeof compiled === 'string' && owned !== undefined) context.run.ownerQueries.set(compiled, owned);
      // E6 (#609): an hours ask became a day window above, so the read keeps its own finer bound here.
      const hours = mailHours(context.question);
      if (typeof compiled === 'string' && hours !== undefined) context.run.mailSince.set(compiled, context.now() - hours * 3_600_000);
    }
    return plan;
  }
  if (lookup.source === 'drive') return { source: 'drive', kind: 'drive_search', subs: driveSubs(query, context.ownerWords ?? context.question) };
  // K1: the web is a layer of its own, and a question that asked for it is never answered by chat.
  if (lookup.source === 'web') return { source: 'web', kind: 'web_search', subs: candidateSubs('web_search', subsConfig) };
  if (lookup.source === 'chat') {
    const chat = candidateSubs('chat_search', subsConfig);
    recordChatDate(context.run, lookup.query, chat);
    return { source: 'chat', kind: 'chat_search', subs: chat };
  }
  // Every other name is a layer this routing cannot serve. It settles unavailable under its own name,
  // with its own reason, and never as a chat search.
  return { source: lookup.source as SourceKind, kind: 'chat_search', subs: [], unresolved: true, reason: 'endpoint_unavailable' };
}

/** MED-1022: the run remembers what became of its chat date operator, strongest token first. */
function recordChatDate(run: RunState, original: string | undefined, subs: readonly IntentSubCall[]): void {
  const sub = subs.find(call => call.name === INTERNAL.chatSearch || call.name === INTERNAL.chatRead);
  if (sub === undefined) return;
  const status = chatDateOperator(original, String(sub.args['query'] ?? ''), String(sub.args['after'] ?? sub.args['from_date'] ?? ''));
  if (status === 'compiled' || run.chatDate === undefined) run.chatDate = status;
}

interface RoutedOutcome {
  bodyOnly?: boolean;
  lookup: ResearchLookup; kind: LedgerKind; tool: string; source: SourceKind | 'memory';
  outcome: LookupOutcome; ms: number; historyPage?: JsonObject; lines: string[]; total: number;
  /** E5: the mail queries this read ran, so the receipt carries their shape and the reply their words. */
  mail?: MailQueryInfo;
  /** Release 4: the pages this read lost after it had already delivered, so the receipt says partial. */
  partial?: { reason: MailPartialReason; failedPages: number };
  /** MED-1022: the one sub-call this read issued, so the knowledge receipt counts its own query terms. */
  sub?: IntentSubCall;
  /** ONE-1023: identical reads this one dispatch served, so the receipt counts them. */
  deduped?: number;
  /** #635: the read answered in part and was then cut at its budget, so it is a partial timeout. */
  cut?: true;
}

interface RoutedPlan { lookup: ResearchLookup; read: { unresolved?: boolean; reason?: string; source: SourceKind | 'memory'; kind: LedgerKind; subs: IntentSubCall[] } }

/**
 * N3: the wall-clock one coalesced batch may take. It grows with the number of lookups the batch
 * carries, so coalescing never shrinks the time each lookup gets, except for the calendar: that read
 * has its own budget which sits inside the start deadline, and multiplying it would put the calendar
 * back on the deadline this change exists to keep it off. Never above what the run has left.
 * P5: the per-read budget comes from the one per-source table.
 */
export function lookupBound(source: SourceKind, lookups: number, remainingMs: number): number {
  const perRead = RESEARCH.sourceDeadline[source];
  const wanted = source === 'calendar' || source === 'mail' ? perRead : perRead * Math.max(1, lookups);
  return Math.min(wanted, remainingMs);
}

/**
 * N3: one source, one execution. Same-source lookups of one call are coalesced into a single batch
 * carrying every query, because three knowledge searches issued at once contended for the same 4 s
 * and all three were aborted, while a lone one returned in 2.2 s. The budget is `lookupBound`, sized by
 * the number of lookups in the batch. Each lookup still settles on its own outcome from its own
 * sub-results, so a cut or failed read never takes the others down.
 */
function evidenceAllowed(deps: ResearchDeps, run: RunState, signal: AbortSignal): boolean {
  return !signal.aborted && authorizedEvidence(deps, run, signal);
}
/** The authority half alone: a cut read still reports what it read under this run's own grants. */
function authorizedEvidence(deps: ResearchDeps, run: RunState, signal: AbortSignal): boolean {
  if (run.cancelled || run.stopped) return false;
  try { return deps.authorizeEvidence?.(deps.ledger.evidenceBindings(run.researchId), signal) ?? true; }
  catch { return false; }
}
function deniedEvidence(deps: ResearchDeps, run: RunState): JsonObject {
  if (deps.ledger.find(run.researchId) === run) deps.ledger.stop(run.researchId);
  invalidateEvidence(run); run.cancelled = true;
  return { researchId: run.researchId, error: 'tool_result_denied', status: 'unavailable', findings: [], canContinue: false, note: 'Research evidence is no longer authorized. Start a new lookup.' };
}
export function markCalendarReply(ledger: ResearchLedger, reply: JsonObject): void {
  const body = (reply as BodyReply)[bodyDelivery];
  if (body) ledger.deliveredBody(body);
  const mail = (reply as MailReply)[mailDelivery];
  if (mail) ledger.deliveredMail(mail);
  const delivery = (reply as CalendarReply)[calendarDelivery];
  if (delivery) ledger.delivered(delivery.researchId, delivery.runId, delivery.keys);
}

function mailScope(run: RunState): string { return JSON.stringify([...run.mail.keys()]); }
function mailSourceState(run: RunState): string {
  return JSON.stringify([...run.mail].filter(([, read]) => !read.failed && !read.exhausted).map(([key, read]) => [key, read.nextPageToken ?? null]));
}
function mailSourceCursor(run: RunState): string | undefined {
  const state = mailSourceState(run);
  if (state === '[]') return undefined;
  const scope = mailScope(run), signature = JSON.stringify(['source', scope, state]);
  const existing = [...run.mailCursors].find(([, page]) => page.signature === signature)?.[0];
  if (existing) return existing;
  const cursor = randomUUID();
  run.mailCursors.set(cursor, { signature, scope, sourceState: state, delivered: false, ids: [] });
  return cursor;
}
function mailMessageCursor(run: RunState, ids: readonly string[], tail?: string): string | undefined {
  let next = tail;
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += 8) chunks.push(ids.slice(offset, offset + 8));
  for (const keys of chunks.reverse()) {
    const scope = mailScope(run), signature = JSON.stringify(['messages', scope, keys, next ?? null]);
    const existing = [...run.mailCursors].find(([, page]) => page.signature === signature)?.[0];
    if (existing) { next = existing; continue; }
    const cursor = randomUUID();
    run.mailCursors.set(cursor, { signature, scope, ids: keys, delivered: keys.every(id => run.mailDelivered.has(id)), ...(next ? { nextCursor: next } : {}) });
    next = cursor;
  }
  return next;
}

function mailMessages(run: RunState): Map<string, MailMessage> {
  const messages = new Map<string, MailMessage>();
  for (const read of run.mail.values()) for (const [key, message] of read.messages) if (!messages.has(key)) messages.set(key, message);
  return messages;
}
/** F2: one read per query, whatever page size the caller asked for, so a follow-up continues the same read. */
function mailReadKey(args: JsonObject): string {
  const normalized: JsonObject = { ...args };
  delete normalized['maxResults'];
  return JSON.stringify(normalized);
}
/**
 * ROUTE-1022 K11: one model-written lookup reads one page, never the whole mailbox in a single request.
 * The remainder arrives through the existing continue path, which reads the same query's next token.
 */
function mailPageArgs(args: JsonObject, question = ''): JsonObject {
  const asked = Number(args['maxResults']);
  const cap = RESEARCH.pageResults.mail;
  const size = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), cap) : cap;
  // #657 item 2: a status or check read wants a page, not one message per call, and 25 is the page the
  // connector serves; any other read keeps the size the model asked for, capped at that page.
  return { ...args, maxResults: statusAsk(question) ? cap : size };
}
function mailRead(run: RunState, args: JsonObject, memo?: ResearchMemo): MailRead {
  const key = mailReadKey(args);
  let read = run.mail.get(key) ?? memo?.mail?.get(key);
  if (!read) {
    read = { args: { ...args }, messages: new Map(), bindings: [], tokens: new Set(), exhausted: false, failed: false, received: 0, invalid: 0, pages: 0 };
  }
  if (run.mail.get(key) !== read) run.mail.set(key, read);
  if (memo !== undefined) {
    memo.mail ??= new Map();
    memo.mail.set(key, read);
  }
  return read;
}

/** The mail queries one read ran, in order: the words stay local to the reply, the shape goes in the receipt. */
interface MailQueryInfo { q: string; retried?: string }
function mailQueryInfo(read: MailRead): MailQueryInfo | undefined {
  const q = read.args['q'];
  if (typeof q !== 'string' || q.length === 0) return undefined;
  const retried = read.retry?.args['q'];
  return { q, ...(typeof retried === 'string' ? { retried } : {}) };
}

/** E5: the receipt names both queries by shape, never by word. */
function mailReceiptField(info: MailQueryInfo | undefined): { mail?: MailQueryShape & { retried?: MailQueryShape } } {
  if (info === undefined) return {};
  return { mail: { ...mailQueryShape(info.q), ...(info.retried === undefined ? {} : { retried: mailQueryShape(info.retried) }) } };
}

/** E5: how an empty mail search is voiced, naming the words and the window it really used. */
function mailEmptyPhrase(info: MailQueryInfo | undefined, fallback: string): string {
  // #564: the triage scan names its own window and its own filter, never "nothing urgent".
  if (info?.q === TRIAGE_MAIL_QUERY) return ' for anything unread in the last two days';
  return info === undefined ? fallback : mailSearchPhrase(info.retried ?? info.q);
}

/**
 * E5: one mail read, then exactly one broader retry when a search matched nothing. The wider query
 * shares the source's own deadline and ops budget, and its hits are credited to the first read.
 */
/** F2: the connector's own rate-limit failure, recognised from its text because the code set has no such word. */
function rateLimited(result: IntentSubResult | undefined): boolean {
  return result !== undefined && !result.ok && /rate.?limit|\b429\b/iu.test(result.text);
}

/** A wait on the injected timer seam, so a test drives the rate-limit delay instead of sleeping. */
function pause(deps: ResearchDeps, ms: number): Promise<void> {
  return new Promise<void>(resolve => { (deps.schedule ?? scheduleTimer)(resolve, ms); });
}

/**
 * Release 4: a page this read lost is counted, so a read that already delivered its earlier pages is
 * reported partial instead of failed.
 */
function failMailPage(read: MailRead): void { read.failed = true; read.failedPages = (read.failedPages ?? 0) + 1; }

async function collectMailWithRetry(deps: ResearchDeps, run: RunState, reads: readonly MailRead[], parent: AbortSignal, remainingMs: number, now: () => number): Promise<void> {
  await collectMail(deps, run, parent, remainingMs, now);
  if (parent.aborted) return;
  const retries = reads.map(read => {
    if (read.messages.size > 0 || read.failed) return undefined;
    const q = read.args['q'];
    // Only a keyword search is broadened: a bare filter has nothing further to ask.
    if (typeof q !== 'string' || mailQueryShape(q).terms === 0) return undefined;
    const broader = broaderMailQuery(q);
    if (broader === undefined || broader === q) return undefined;
    const retry = mailRead(run, { ...read.args, q: broader });
    read.retry = retry;
    return retry;
  });
  if (retries.every(retry => retry === undefined)) return;
  await collectMail(deps, run, parent, remainingMs, now);
  reads.forEach((read, index) => {
    const retry = retries[index];
    if (retry === undefined) return;
    for (const [key, message] of retry.messages) if (!read.messages.has(key)) read.messages.set(key, message);
  });
}

/** Each source page is dispatched once under one source deadline; received identities stay local. */
async function collectMail(deps: ResearchDeps, run: RunState, parent: AbortSignal, remainingMs: number, now: () => number): Promise<void> {
  run.mailDeadlineAt ??= now() + Math.min(RESEARCH.sourceDeadline.mail, remainingMs);
  const left = run.mailDeadlineAt - now();
  // L8-13: a deadline already spent means no page is dispatched at all, which is not a read that took too long.
  if (left <= 0 || remainingMs <= 0) { (run.neverRan ??= new Set()).add('mail'); return; }
  run.neverRan?.delete('mail');
  // RUN-R7: the mail deadline is cut on the run's clock, released when the collector ends.
  const cut = cutAfter(Math.min(left, remainingMs), deps.schedule);
  const signal = AbortSignal.any([parent, cut.signal]);
  try {
  while (now() < run.mailDeadlineAt && run.ops < RESEARCH.maxOps && evidenceAllowed(deps, run, signal)) {
    // #581: a page answers the read unless the lines this reply shows still need more, so four pages are
    // never spent to show four lines.
    const candidates = [...run.mail.values()].filter(read => !read.exhausted && !read.failed && !read.inflight && read.pages < RESEARCH.mailPageCap && read.messages.size < MAIL_LINES_SHOWN);
    const reads = boundedPages(run, 'mail', candidates, now()).slice(0, RESEARCH.maxOps - run.ops);
    if (reads.length === 0) break;
    const pageStartedAt = now();
    const calls = reads.map((read, n) => ({ key: `mail${run.ops + n}`, name: INTERNAL.mailList, args: { ...read.args, ...(read.nextPageToken ? { pageToken: read.nextPageToken } : {}) } }));
    if (!evidenceAllowed(deps, run, signal)) break;
    for (const read of reads) { read.inflight = true; if (read.nextPageToken) read.tokens.add(read.nextPageToken); }
    run.ops += calls.length;
    let results: IntentSubResult[];
    recordShapes(deps, run, calls, now);
    try { results = await deps.execute(calls, signal); }
    catch { for (const read of reads) { read.inflight = false; failMailPage(read); } if (signal.aborted) run.cutShort.add('mail'); break; }
    if (parent.aborted || run.cancelled || run.stopped) { for (const read of reads) read.inflight = false; invalidateEvidence(run); break; }
    if (signal.aborted || now() >= run.mailDeadlineAt) { for (const read of reads) { read.inflight = false; failMailPage(read); } run.cutShort.add('mail'); break; }
    // Q1-R3(e): one retry for a transient failed page, inside this source's own deadline.
    // A native page that failed is terminal for its source, so only a first page is retried.
    // F2: a rate-limited page never takes that immediate retry; it waits once, then the read is closed.
    const failed = calls.map((_, index) => index).filter(index => !results[index]?.ok);
    const limited = failed.filter(index => rateLimited(results[index]));
    const retried = failed.filter(index => !calls[index]!.args['pageToken'] && !limited.includes(index));
    if (retried.length > 0) {
      try {
        const again = await deps.execute(retried.map(index => calls[index]!), signal);
        retried.forEach((index, position) => { const result = again[position]; if (result) results[index] = { ...result, key: calls[index]!.key }; });
      } catch { /* the first answer stands */ }
    }
    if (limited.length > 0 && run.mailRateRetried !== true) {
      run.mailRateRetried = true;
      await pause(deps, RESEARCH.rateLimitRetryMs);
      try {
        const again = await deps.execute(limited.map(index => calls[index]!), signal);
        limited.forEach((index, position) => { const result = again[position]; if (result) results[index] = { ...result, key: calls[index]!.key }; });
      } catch { /* the delayed retry is the last word on this page */ }
    }
    reads.forEach((read, n) => {
      read.inflight = false;
      read.lastPageMs = Math.max(0, now() - pageStartedAt);
      const result = results[n];
      if (!result?.ok || deps.authorizeEvidence && !result.binding) { failMailPage(read); if (result?.code !== undefined) read.code = result.code; return; }
      read.pages += 1;
      // A search that answered with text but no page envelope is still that search's answer: each tagged
      // line is one message, so the follow-up read and the reply carry it like any other page.
      if (!result.mailPage) {
        for (const line of withItemOpenLines(itemLines(result.text)).filter(entry => entry.startsWith('- '))) {
          const id = /\[id ([A-Za-z0-9_-]+)\]/.exec(line)?.[1];
          if (id && !read.messages.has(id)) read.messages.set(id, { id, threadId: '', internalDate: '', line, bodyTruncated: false });
        }
        if (read.messages.size === 0) read.plain = [read.plain, result.text].filter(Boolean).join('\n');
        read.exhausted = true;
        return;
      }
      if (result.binding) read.bindings.push(result.binding);
      if (!evidenceAllowed(deps, run, parent)) { run.cancelled = true; return; }
      const page = result.mailPage;
      // E6 (#609): an hours ask is a day query upstream, so the day's earlier messages are dropped here.
      const since = run.mailSince.get(String(read.args['q'] ?? ''));
      const inWindow = (message: MailMessage): boolean => since === undefined || !(Date.parse(message.internalDate) < since);
      for (const message of page.messages) if (inWindow(message) && !read.messages.has(message.id)) read.messages.set(message.id, message);
      read.received += page.received; read.invalid += page.invalid; read.upstreamIncomplete ||= page.upstreamIncomplete === true;
      if (typeof page.total === 'number') (read.pageTotals ??= []).push(page.total);
      const next = page.nextPageToken;
      if (next && (next.length > 4096 || read.tokens.has(next))) { failMailPage(read); return; }
      if (next) read.nextPageToken = next;
      else { delete read.nextPageToken; read.exhausted = true; }
    });
    if (run.cancelled) { invalidateEvidence(run); break; }
  }
  } finally { cut.done(); }
  if (signal.aborted) run.cutShort.add('mail');
}

async function mailGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], signal: AbortSignal, remainingMs: number, now: () => number): Promise<RoutedOutcome[]> {
  const started = now();
  const reads = plans.map(plan => mailRead(run, plan.read.subs[0]!.args, deps.memo));
  // K11: the first page of a voice turn ends at the first-answer cut, so one slow page never holds the
  // whole answer; the rest of the window arrives on the continue path with the source's own deadline.
  const firstPage = reads.every(read => read.pages === 0);
  await collectMailWithRetry(deps, run, reads, signal, firstPage ? Math.min(remainingMs, RESEARCH.firstAnswerMs) : remainingMs, now);
  return plans.map((plan, n) => {
    const read = reads[n]!, lines = [...read.messages.values()].map(message => message.line);
    // Release 4: a read that already delivered its pages keeps them; a later lost page makes it partial,
    // and only a read that delivered nothing at all is a failed read.
    const delivered = lines.length > 0;
    // LOGS.md L-01: a page that carried only the helper's own reason line is a failed read, not an empty one.
    const classified = delivered || read.failed ? undefined : classifiedFailureText([read.plain ?? '']);
    if (classified !== undefined) run.failureLines.set('mail', classified);
    const outcome: LookupOutcome = delivered ? 'ok' : signal.aborted || run.cutShort.has('mail') ? 'timeout' : read.failed || classified !== undefined ? 'failed' : 'empty';
    const failedPages = read.failedPages ?? 0;
    const info = mailQueryInfo(read);
    return { lookup: plan.lookup, kind: plan.read.kind, tool: INTERNAL.mailList, source: 'mail', outcome, ms: now() - started, lines, total: read.messages.size, ...(info === undefined ? {} : { mail: info }), ...(delivered && failedPages > 0 ? { partial: { reason: 'pages_failed' as const, failedPages } } : {}) };
  });
}

/**
 * E8: a whole window one superseded run paid for is kept for the live session, so the run that replaced it
 * reuses the answer instead of fetching the same days again. Only a first page that finished its window is kept.
 */
function rememberCalendarWindow(deps: ResearchDeps, reads: readonly CalendarRead[], results: readonly IntentSubResult[], slots: readonly number[], at: number): void {
  const memo = deps.memo;
  if (memo === undefined) return;
  reads.forEach((read, n) => {
    if (read.failed || read.nextPageToken !== undefined) return;
    const result = results[slots[n]!];
    const page = result?.calendarPage;
    // A round the caller cut still carries the page it paid for, so the next run reuses it instead of refetching.
    if ((result?.ok !== true && result?.code !== 'round_cancelled') || page === undefined || page.nextPageToken !== undefined || page.unread > 0) return;
    const events = new Map<string, RetainedCalendarEvent>();
    for (const [index, event] of page.events.entries()) {
      const instant = Date.parse(event.start);
      const start = Number.isFinite(instant) ? new Date(instant).toISOString() : event.start;
      const key = event.id && event.start ? `${event.id}:${start}` : JSON.stringify([read.args, null, index]);
      events.set(key, event);
    }
    memo.calendar.set(JSON.stringify(read.args), { at, events });
  });
}

/** One run owns each exact primary/window/page dispatch and retains its authorized normalized events. */
async function collectCalendar(deps: ResearchDeps, run: RunState, parent: AbortSignal, remainingMs: number, now: () => number): Promise<void> {
  if (remainingMs <= 0) { run.cutShort.add('calendar'); return; }
  // E8: the calendar list is one per live session, not one per run.
  const listed = deps.memo?.calendarList;
  if (listed !== undefined && run.calendarScope === undefined) {
    run.calendarScope = listed.scope;
    if (listed.notRead !== undefined) run.calendarNotRead = listed.notRead;
    run.calendarScopeAttempted = true;
  }
  const sourceDeadlineAt = now() + Math.min(RESEARCH.sourceDeadline.calendar, remainingMs);
  // RUN-R7: the calendar deadline is cut on the run's clock, released when the collector ends.
  const cut = cutAfter(Math.min(RESEARCH.sourceDeadline.calendar, remainingMs), deps.schedule);
  const signal = AbortSignal.any([parent, cut.signal]);
  try {
  while (now() < sourceDeadlineAt && run.ops < RESEARCH.maxOps && evidenceAllowed(deps, run, signal)) {
    // E8: a window this session already read inside the turn window costs no transport call.
    for (const [key, read] of run.calendar) {
      if (read.exhausted || read.failed || read.inflight || read.nextPageToken !== undefined) continue;
      const hit = deps.memo?.calendar.get(key);
      if (hit === undefined || now() - hit.at > RESEARCH.coalesceWindowMs) continue;
      for (const [eventKey, event] of hit.events) read.events.set(eventKey, event);
      read.exhausted = true;
    }
    const pending = boundedPages(run, 'calendar', [...run.calendar.values()].filter(read => !read.exhausted && !read.failed && !read.inflight), now());
    if (pending.length === 0) break;
    const reads = pending.slice(0, RESEARCH.maxOps - run.ops);
    const pageStartedAt = now();
    // W2: the connector plans inside this run's remaining source budget, never its own 40 s constant.
    const calls: IntentSubCall[] = [];
    const slots: number[] = [];
    const listScope = !run.calendarScopeAttempted && reads.length < RESEARCH.maxOps - run.ops;
    let scopeSlot: number | undefined;
    reads.forEach((read, n) => {
      slots.push(calls.length);
      calls.push({ key: `calendar${run.ops + n}`, name: INTERNAL.calendarList, args: { ...read.args, ...(read.nextPageToken ? { pageToken: read.nextPageToken } : {}), deadlineAt: sourceDeadlineAt } });
      // N3: the list rides in the same batch as the read it qualifies, so the answer can count what it
      // did not read and the batch is the read, its list, then any further window.
      if (n === 0 && listScope) {
        scopeSlot = calls.length;
        calls.push({ key: 'calendarScope', name: INTERNAL.calendars, args: { maxResults: 20 } });
        run.calendarScopeAttempted = true;
      }
    });
    if (!evidenceAllowed(deps, run, signal)) break;
    for (const read of reads) { read.inflight = true; if (read.nextPageToken) read.tokens.add(read.nextPageToken); }
    run.ops += calls.length;
    let results: IntentSubResult[];
    recordShapes(deps, run, calls, now);
    try { results = await deps.execute(calls, signal); }
    catch { for (const read of reads) { read.failed = true; read.inflight = false; } if (signal.aborted) run.cutShort.add('calendar'); break; }
    // E8: the window this batch paid for is kept for the session, so the run that superseded it never pays again.
    if (deps.authorizeEvidence?.(deps.ledger.evidenceBindings(run.researchId), new AbortController().signal) ?? true) rememberCalendarWindow(deps, reads, results, slots, now());
    if (parent.aborted || run.cancelled || run.stopped) { run.cancelled = true; invalidateEvidence(run); break; }
    if (signal.aborted || now() >= sourceDeadlineAt) { for (const read of reads) { read.failed = true; read.inflight = false; } run.cutShort.add('calendar'); break; }
    if (!evidenceAllowed(deps, run, parent)) { run.cancelled = true; invalidateEvidence(run); break; }
    if (scopeSlot !== undefined) {
      const scope = results[scopeSlot];
      if (scope?.ok && scope.calendarScope) run.calendarScope = scope.calendarScope;
      const notRead = scope === undefined ? undefined : calendarNotRead([scope]);
      if (notRead !== undefined) run.calendarNotRead = notRead; else delete run.calendarNotRead;
      if (scope?.binding && reads[0]) reads[0].bindings.push(scope.binding);
      if (deps.memo !== undefined && scope?.ok && scope.calendarScope) deps.memo.calendarList = { scope: scope.calendarScope, ...(notRead !== undefined ? { notRead } : {}) };
    }
    reads.forEach((read, n) => {
      read.inflight = false;
      read.lastPageMs = Math.max(0, now() - pageStartedAt);
      const result = results[slots[n]!];      if (!result?.ok || (deps.authorizeEvidence && !result.binding)) { read.failed = true; if (result?.code !== undefined) read.code = result.code; return; }
      // A calendar answer with text but no page envelope is still that source's answer: each tagged
      // line is one event, so the brief fan-out and the reply carry it like any other page.
      if (!result.calendarPage) {
        for (const [index, line] of itemLines(result.text).filter(entry => entry.startsWith('- ')).entries()) {
          const id = /\[id ([A-Za-z0-9_-]+)\]/.exec(line)?.[1];
          read.events.set(id ? `${id}:${line}` : JSON.stringify([read.args, read.nextPageToken ?? null, index]), { id: id ?? '', start: line.slice(2).split(',')[0]!.trim(), line, bodyTruncated: false });
        }
        // LOGS.md L-01: a page that named no event keeps its own words, so a refused window is a
        // failed read and its owner line can be spoken, never an empty window.
        if (read.events.size === 0) read.plain = [read.plain, result.text].filter(Boolean).join('\n');
        read.exhausted = true;
        return;
      }
      if (result.binding) read.bindings.push(result.binding);
      if (!evidenceAllowed(deps, run, parent)) { run.cancelled = true; return; }
      const page = result.calendarPage;
      for (const [index, event] of page.events.entries()) {
        const instant = Date.parse(event.start);
        const start = Number.isFinite(instant) ? new Date(instant).toISOString() : event.start;
        const key = event.id && event.start ? `${event.id}:${start}` : JSON.stringify([read.args, read.nextPageToken ?? null, index]);
        read.events.set(key, event);
        read.bodyTruncated ||= event.bodyTruncated;
      }
      read.unread += page.unread;
      read.upstreamIncomplete ||= page.upstreamIncomplete === true;
      const next = page.nextPageToken;
      if (next && (next.length > 4096 || read.tokens.has(next))) { read.failed = true; return; }
      if (next) read.nextPageToken = next;
      else { delete read.nextPageToken; read.exhausted = true; }
    });
    if (!run.cancelled && authorizedEvidence(deps, run, parent)) rememberCalendarWindow(deps, reads, results, slots, now());
    if (run.cancelled) { invalidateEvidence(run); break; }
    if (now() - run.startedAt >= run.deadlineMs) break;
  }
  } finally { cut.done(); }
  if (signal.aborted) run.cutShort.add('calendar');
}

async function calendarGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], signal: AbortSignal, remainingMs: number, now: () => number): Promise<RoutedOutcome[]> {
  const started = now();
  const owned = new Map<RoutedPlan, string>();
  for (const plan of plans) {
    const call = plan.read.subs.find(sub => sub.name === INTERNAL.calendarList);
    if (!call || plan.read.unresolved) { run.unavailableReasons.set('calendar', 'window_unparsed'); continue; }
    const key = JSON.stringify(call.args);
    owned.set(plan, key);
    if (!run.calendar.has(key)) run.calendar.set(key, { args: { ...call.args }, events: new Map(), bindings: [], tokens: new Set(), exhausted: false, failed: false, bodyTruncated: false, unread: 0 });
  }
  await collectCalendar(deps, run, signal, remainingMs, now);
  const credited = new Set<string>();
  return plans.map(plan => {
    const key = owned.get(plan);
    const read = key === undefined ? undefined : run.calendar.get(key);
    const lines = read && !credited.has(key!) ? [...read.events.values()].map(event => event.line) : [];
    if (key) credited.add(key);
    // LOGS.md L-01: a refused calendar read carries the owner's line and no event, so it is failed.
    const classified = !read || read.events.size > 0 || read.failed ? undefined : classifiedFailureText([read.plain ?? '']);
    if (classified !== undefined) run.failureLines.set('calendar', classified);
    const outcome: LookupOutcome = !read ? 'unavailable' : read.events.size > 0 ? 'ok' : read.failed || classified !== undefined ? 'failed' : read.exhausted ? 'empty' : 'timeout';
    return { lookup: plan.lookup, kind: plan.read.kind, tool: INTERNAL.calendarList, source: 'calendar', outcome, ms: now() - started, lines, total: read?.events.size ?? 0 };
  });
}

/**
 * ROUTE-1022 K1: the web layer's own routed read. The port answers in process, so a routed web lookup
 * keeps its links, its evidence and its attribution exactly as the selector's web action does.
 */
async function webGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], signal: AbortSignal, now: () => number): Promise<RoutedOutcome[]> {
  const started = now();
  run.ops += plans.length;
  const results = await Promise.all(plans.map(async (plan): Promise<{ plan: RoutedPlan; line?: string }> => {
    const call = plan.read.subs[0];
    const query = String(call?.args['query'] ?? plan.lookup.query);
    const readStarted = now();
    const outcome = await deps.web!.search({ query, signal, deadlineMs: webDeadlineMs(query) });
    recordWebRead(deps, run, query, outcome, readStarted, now);
    if (!outcome.ok) { run.unavailableReasons.set('web', webReasonOf(outcome.code, outcome.code === 'web_insufficient' ? outcome.reason : undefined)); return { plan }; }
    run.web.push(...webSourceCards(outcome.evidence).map(card => ({ ...card, retrievedAt: outcome.evidence.retrievedAt })));
    run.webAttribution.push(...webAttribution(outcome.evidence.searchEntryPoint));
    run.evidence.set('web_search', outcome.evidence.answer);
    return { plan, line: webEvidenceText(outcome.evidence) };
  }));
  return results.map(({ plan, line }) => ({ lookup: plan.lookup, kind: plan.read.kind, tool: WEB_SEARCH_ACTION, source: 'web', outcome: line === undefined ? 'failed' : 'ok', ms: now() - started, lines: line === undefined ? [] : [line], total: line === undefined ? 0 : 1 }));
}

async function routedGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], context: { question: string; configured: readonly SourceKind[]; unavailable: readonly SourceKind[]; unavailableReason?: ((source: SourceKind) => string) | undefined; signal: AbortSignal; now: () => number }): Promise<RoutedOutcome[]> {
  const at = context.now();
  const settle = (plan: RoutedPlan, outcome: LookupOutcome, lines: string[] = [], total = 0, deduped = 0, cut = false): RoutedOutcome =>
    ({ lookup: plan.lookup, kind: plan.read.kind, tool: plan.read.subs[0]?.name ?? plan.read.kind, source: plan.read.source, outcome, ms: context.now() - at, lines, total, ...(deduped > 0 ? { deduped } : {}), ...(plan.read.subs[0] === undefined ? {} : { sub: plan.read.subs[0] }), ...(cut ? { cut: true as const } : {}) });
  const done: RoutedOutcome[] = [];
  for (const plan of plans.filter(entry => entry.read.source === 'memory')) {
    const args = plan.lookup.history ?? { query: plan.lookup.query };
    const reference = args.cursor ?? args.recordRef;
    if (reference && !run.historyTokens.has(reference)) {
      run.unavailableReasons.set('memory', 'history_reference_unavailable'); done.push(settle(plan, 'unavailable')); continue;
    }
    if (!evidenceAllowed(deps, run, context.signal)) { done.push(settle(plan, 'unavailable')); continue; }
    // RUN-R7: the memory read is cut on the run's clock, released when the read settles.
    const cut = cutAfter(RESEARCH.sourceDeadline.memory, deps.schedule);
    const signal = AbortSignal.any([context.signal, cut.signal]);
    try {
      run.ops++;
      recordShapes(deps, run, plan.read.subs, () => at);
      const [result] = await deps.execute(plan.read.subs, signal);
      if (!result?.ok || !result.binding || !result.historyPage || run.cancelled || run.stopped || signal.aborted) {
        run.unavailableReasons.set('memory', result?.code ?? 'history_unavailable'); done.push(settle(plan, signal.aborted ? 'timeout' : 'unavailable')); continue;
      }
      run.historyBindings.push(result.binding);
      if (!evidenceAllowed(deps, run, signal)) { done.push(settle(plan, 'unavailable')); continue; }
      const page = result.historyPage;
      if (page['status'] !== 'ok') {
        run.unavailableReasons.set('memory', String(page['status'] ?? 'history_unavailable'));
        done.push({ ...settle(plan, 'unavailable'), historyPage: page }); continue;
      }
      if (typeof page['nextCursor'] === 'string') run.historyTokens.add(page['nextCursor']);
      // #575: her own spoken turn from this call or the last one confirms a past answer instead of being
      // new evidence, so it is dropped unless the owner asked what she said.
      const askedWhatSheSaid = ASKS_WHAT_SHE_SAID.test(context.question);
      const raw = Array.isArray(page['hits']) ? page['hits'].filter(isRecord) : [];
      const hits = memoryEvidence(raw, context.question, run, askedWhatSheSaid, deps.liveSessionId);
      const kept = { ...page, hits };
      for (const hit of hits) if (typeof hit['recordRef'] === 'string') run.historyTokens.add(hit['recordRef']);
      const lines = typeof page['text'] === 'string' ? [page['text']] : hits.map(hit => String(hit['snippet'] ?? ''));
      // #615: a page trimmed to the rows this call may read never reports the rows it dropped as matches.
      const total = hits.length === raw.length ? Number(page['totalMatches'] ?? lines.length) : hits.length;
      done.push({ ...settle(plan, lines.length ? 'ok' : 'empty', lines, total), historyPage: kept });
    } catch { done.push(settle(plan, signal.aborted ? 'timeout' : 'failed')); } finally { cut.done(); }
  }
  const reads = plans.filter(entry => entry.read.source !== 'memory' && !entry.read.unresolved);
  // N3: an unresolvable window reads nothing and says why, instead of spending the batch deadline.
  // K1: a lookup this routing cannot serve settles under its own name and reason, never as another layer.
  for (const plan of plans.filter(entry => entry.read.unresolved)) {
    run.unavailableReasons.set(plan.read.source as SourceKind, plan.read.reason ?? 'window_unparsed');
    done.push(settle(plan, 'unavailable'));
  }
  if (reads.length === 0) return done;
  const source = reads[0]!.read.source as SourceKind;
  const all = (outcome: LookupOutcome): RoutedOutcome[] => reads.map(plan => settle(plan, outcome));
  /** P5: an unreachable source names its reason in the reply, so an outage is never read as "nothing found". */
  const unserved = (outcome: LookupOutcome, reason: string): RoutedOutcome[] => {
    run.unavailableReasons.set(source, reason);
    return [...done, ...all(outcome)];
  };
  if (!context.configured.includes(source)) return unserved('unavailable', source === 'web' ? 'web_not_available' : source === 'drive' ? 'drive_not_available' : 'not_configured');
  // #351: a connector that cannot serve a read right now settles at once, never spending the batch deadline.
  if (context.unavailable.includes(source)) return unserved('unavailable', context.unavailableReason?.(source) ?? 'connector_unavailable');
  const remainingMs = run.deadlineMs - (context.now() - run.startedAt);
  if (remainingMs <= 0) return unserved('unavailable', 'deadline_exhausted');
  if (source === 'calendar') return calendarGroup(deps, run, reads, context.signal, remainingMs, context.now);
  if (source === 'web') return webGroup(deps, run, reads, context.signal, context.now);
  if (source === 'mail' && reads.every(plan => plan.read.subs.length === 1 && plan.read.subs[0]?.name === INTERNAL.mailList)) return mailGroup(deps, run, reads, context.signal, remainingMs, context.now);
  const subs: IntentSubCall[] = [];
  const owned: number[][] = reads.map(() => []);
  const reused: number[] = reads.map(() => 0);
  const seen = new Map<string, number>();
  reads.forEach((plan, index) => {
    for (const sub of plan.read.subs) {
      // A sub two lookups would both issue (the calendar list serves every window) is dispatched once.
      const signature = `${sub.name}:${JSON.stringify(sub.args)}`;
      const existing = seen.get(signature);
      if (existing !== undefined) { owned[index]!.push(existing); reused[index]! += 1; continue; }
      subs.push(sub);
      owned[index]!.push(subs.length - 1);
      seen.set(signature, subs.length - 1);
    }
  });
  if (subs.length === 0) return unserved('unavailable', 'no_query');
  // F6: an identical read the live session already paid for inside the turn window is reused, not dispatched again.
  const signatures = subs.map(sub => `${sub.name}:${JSON.stringify(sub.args)}`);
  const remembered = deps.memo?.reads;
  const cached = signatures.map(signature => {
    const hit = remembered?.get(signature);
    return hit !== undefined && context.now() - hit.at <= RESEARCH.coalesceWindowMs ? hit.result : undefined;
  });
  const pending = cached.map((hit, index) => hit === undefined ? index : -1).filter(index => index >= 0);
  run.ops += Math.max(1, pending.length);
  // RUN-R7: the lookup is cut on the run's clock, released when the read settles.
  const cut = cutAfter(lookupBound(source, reads.length, remainingMs), deps.schedule);
  const signal = AbortSignal.any([context.signal, cut.signal]);
  let results: IntentSubResult[];
  try {
    if (pending.length === 0) results = cached.map(hit => hit!);
    else {
      recordShapes(deps, run, subs, context.now);
      const executed = await deps.execute(subs.length === pending.length ? subs : pending.map(index => subs[index]!), signal);
      results = [...cached] as IntentSubResult[];
      pending.forEach((index, position) => {
        const result = executed[position]!;
        results[index] = result;
        if (result.ok && deps.memo !== undefined) {
          deps.memo.reads ??= new Map();
          deps.memo.reads.set(signatures[index]!, { at: context.now(), result });
        }
      });
    }
  }
  catch { return [...done, ...all(signal.aborted ? 'timeout' : 'failed')]; }
  await droppedDayFilterRetry(deps, subs, results, signal, run.droppedDayFilters);
  // The execute contract returns one result per sub, in order, so each lookup keeps its own lines.
  const cutShort = signal.aborted;
  reads.forEach((plan, index) => {
    const own = owned[index]!.map(position => results[position]).filter((result): result is IntentSubResult => result !== undefined);
    const block = shapeBlock(plan.read.kind === 'memory_search' ? 'knowledge_search' : plan.read.kind, own, deps.timeZone, { newestFirst: lastMeetingQuestion(context.question) });
    // P5-R5 (F1): the execute contract resolves `{ok: false, code}` for a sub-call the host did not
    // complete, so a returned failure is a failed read, never a search that matched nothing.
    // LOGS.md L-01: only a projection the tool layer itself classified (it carries the closed code) is a
    // failed read. An ok read that merely carried words and shaped to no line is a search that matched
    // nothing, so the header keeps its counts instead of calling a provider failure.
    const classified = block.lines.length > 0 ? undefined : classifiedProjectionText(own);
    const missed = own.some(result => !result.ok) || classified !== undefined;
    if (classified !== undefined) run.failureLines.set(plan.read.source, classified);
    const outcome: LookupOutcome = block.lines.length > 0 ? 'ok' : cutShort ? 'timeout' : missed ? 'failed' : 'empty';
    // #637: a channel the chat connector does not know keeps its own code, so the reply says the
    // channel is unknown in words instead of collapsing it into a failed read.
    const channelMiss = channelMissCode(own);
    if (channelMiss !== undefined) {
      run.unavailableReasons.set(plan.read.source, channelMiss);
      // #663: the refusal names the channels closest to the one the ask meant, voiced by the reply.
      run.chatChannelClosest = channelClosestNames(own.find(result => !result.ok)?.code);
      const words = channelWordsOf(plan.read.subs);
      if (words !== undefined) run.chatChannel ??= words;
    }
    // #651 FAILREASON-R1: a read the connector cut at its own budget keeps its timeout code, so the reply
    // says the source was not read in time instead of a failure with no stated reason.
    const timedOut = own.find(result => !result.ok && result.code !== undefined && TIMED_OUT.has(result.code))?.code;
    if (timedOut !== undefined) run.unavailableReasons.set(plan.read.source, timedOut);
    // #565: a routed read counts as read, so a continuation of this run never dispatches it again.
    if ((outcome === 'ok' || outcome === 'empty') && plan.read.kind !== 'memory_search') run.readKinds.add(plan.read.kind);
    // #635: a read that answered in part and then ran out of its budget is a partial timeout, so the header
    // counts what arrived and still says the read was cut.
    done.push({ ...settle(plan, outcome, block.lines, block.total, reused[index] ?? 0, cutShort), ...(own.length > 0 && own.every(result => result.ok && result.hostEvidence?.kind === 'remote-body') ? { bodyOnly: true } : {}) });
  });
  cut.done();
  return done;
}

/**
 * #621: the one broader read a source that matched nothing may run: the same query with its fillers dropped,
 * and the owner's names, numbers, window and exclusion kept, because the RETRIEVAL rule says a broaden never
 * removes a sender, recipient, window, exclusion or a pronoun's antecedent.
 */
export function broaderQueryOf(query: string): string | undefined {
  // An authored operator, a quoted phrase or an exclusion is the owner's own predicate, never a filler.
  if (/[:"]|(^|\s)-\S/u.test(query)) return undefined;
  const kept = contentKeywords(query, 8);
  const wider = kept.join(' ');
  return wider.length === 0 || wider === query.trim().toLowerCase() ? undefined : wider;
}

/** The rewritten plans for that one retry, or undefined when this source cannot broaden or already has. */
function broadenedPlans(run: RunState, plans: readonly RoutedPlan[], context: Parameters<typeof routedRead>[1]): RoutedPlan[] | undefined {
  const first = plans[0];
  if (first === undefined) return undefined;
  const source = first.read.source;
  // Mail and the web own their broader query; a calendar window and her own memory have nothing to widen.
  if (source === 'memory' || source === 'mail' || source === 'web' || source === 'calendar' || source === 'mongoose') return undefined;
  if (run.retried.has(source)) return undefined;
  const wider = broaderQueryOf(first.lookup.query ?? '');
  if (wider === undefined) return undefined;
  return plans.map(plan => {
    const lookup: ResearchLookup = { ...plan.lookup, query: wider };
    return { lookup, read: routedRead(lookup, context) };
  });
}

/**
 * #621: an ask that wants the content of a message, not just its subject line.
 */
const DEPTH_ASK = /\b(?:what|which)\b[^.?!]*\b(?:writ(?:e|es|ten)?|wrote|sa(?:y|ys|id)|sen(?:d|ds|t)|mean(?:s|t)?)\b|\bread (?:it|that|this|them)\b|\bfull (?:text|message|thread|mail)\b|\bwhole (?:message|thread|mail)\b/iu;

/**
 * #621: the escalation inside one research call. A mail ask that wants depth and left exactly one top hit
 * gets that message read here, so the voice model never spends a round asking for a body the host can read.
 */
async function depthRead(deps: ResearchDeps, run: RunState, question: string, signal: AbortSignal): Promise<void> {
  if (run.bodies.size > 0 || !DEPTH_ASK.test(question)) return;
  const messages = [...mailMessages(run).values()];
  if (messages.length !== 1) return;
  const top = messages[0]!;
  const key = `depth:mail:${top.id}`;
  if (run.calls.has(key)) return;
  run.calls.add(key);
  try {
    await deps.execute([{ key, name: INTERNAL.mailRead, args: { id: top.id } }], signal);
  } catch {
    // A depth read that fails leaves the search answer intact, and the header still names the source.
  }
}

/**
 * K6: the routed start. Every lookup is dispatched before any is awaited, so the layers the model
 * named are read at once; the reply is shaped as today's, plus a per-source outcome.
 */
async function routedResearch(deps: ResearchDeps, run: RunState, question: string, lookups: readonly ResearchLookup[], configured: readonly SourceKind[], unavailable: readonly SourceKind[], unavailableReason: (source: SourceKind) => string, signal: AbortSignal, now: () => number, limit: number, first: FirstAnswerState): Promise<JsonObject> {
  const started = run.startedAt;
  const logRouted = deps.logRouted ?? ((event: ResearchRoutedLog): void => { hostLogEvent(event); });
  const logLookup = deps.logSource ?? ((event: ResearchSourceLog): void => { hostLogEvent(event); });
  const logSubcall = deps.logSubcall ?? ((event: ResearchSubcallLog): void => hostLogEvent(event));
  const schedule = deps.schedule ?? scheduleTimer;
  deps.emit({ researchId: run.researchId, ...callKeyOf(run), phase: 'started', sourcesDone: [], sourcesPending: [...configured], elapsedMs: 0 });
  // 3r R1 outcome 5: a routed read used to go silent until it returned. It now beats at the same
  // dead-air cadence as the loop, so the model and the owner hear the run is alive inside five seconds.
  const beat = (): void => {
    deps.emit({ researchId: run.researchId, ...callKeyOf(run), phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs: Math.max(0, now() - started) });
  };
  let beatTimer: { unref(): void; cancel(): void } | undefined;
  const arm = (): void => { beatTimer = schedule(() => { beat(); arm(); }, RESEARCH.progressEveryMs); beatTimer.unref(); };
  arm();
  // N3: group by the read a lookup resolves to, so 'company' and 'mongoose', or 'replies' and 'chat',
  // share one execution; the group keeps the order in which each source first appeared.
  // TOPIC-R2 F1: the routed read names the owner's words for this run, never this hop's alone.
  const readContext = { question, topic: run.topic, ownerWords: run.question === undefined ? question : `${run.question} ${question}`.trim(), configured, run, now, ...(deps.timeZone ? { timeZone: deps.timeZone } : {}) };
  const groups = new Map<SourceKind | 'memory', RoutedPlan[]>();
  for (const lookup of lookups) {
    const plan: RoutedPlan = { lookup, read: routedRead(lookup, readContext) };
    const bucket = groups.get(plan.read.source) ?? [];
    bucket.push(plan);
    groups.set(plan.read.source, bucket);
    // #621: the route names what the ask wanted, configured or not, so the header can say why a source
    // the owner asked about was never read.
    if (plan.read.source !== 'memory') run.route.add(plan.read.source);
  }
  for (const source of requiredSources(question)) run.route.add(source);
  let outcomes: RoutedOutcome[] = [];
  let reply: JsonObject | undefined;
  // R6: every layer named below is being read, so a first answer can name the ones still running.
  for (const bucket of groups.values()) first.reading.add(bucket[0]!.read.source);
  // Q5-R1: a read of a named entry widens the reply to the connector's knowledge body cap, the same
  // way the selector path does, so a routed read is never trimmed to a search reply's length.
  if ([...groups.values()].some(plans => plans.some(plan => plan.read.subs.some(sub => sub.name === INTERNAL.knowledgeRead)))) limit = Math.max(limit, RESEARCH.readReplyChars);
  // R6: a layer is credited the moment it settles, so the first answer sees what is already in hand and a
  // layer that lands afterwards is reported late instead of waiting for the slowest one.
  const record = (batch: readonly RoutedOutcome[]): void => {
    // P5: the receipt carries the deadline the read was given, so a cut read is never judged by a bound it
    // never had. A same-source batch shares one bound, so the count is the group's own size.
    const batchSizes = new Map<SourceKind | 'memory', number>();
    for (const outcome of batch) batchSizes.set(outcome.source, (batchSizes.get(outcome.source) ?? 0) + 1);
    for (const outcome of batch) {
      logLookup({
        event: 'research_source', researchId: run.researchId, source: outcome.lookup.source, outcome: outcome.outcome, ms: outcome.ms, ...briefPlanField(run),
        deadlineMs: outcome.source === 'memory' ? RESEARCH.sourceDeadline.memory : lookupBound(outcome.source, batchSizes.get(outcome.source) ?? 1, run.deadlineMs),
        coalesced: batchSizes.get(outcome.source) ?? 1,
        ...(outcome.source === 'knowledge' ? { knowledge: knowledgeReceipt(outcome.lines, run.chatDate ?? 'none', outcome.sub, { droppedFilters: run.droppedDayFilters, deduped: outcome.deduped ?? 0 }) } : {}),
        ...mailReceiptField(outcome.mail),
        ...(outcome.partial === undefined ? {} : { partial: outcome.partial.reason, failedPages: outcome.partial.failedPages }),
        ...(outcome.outcome === 'ok' || outcome.outcome === 'empty' ? {} : { reason: sourceReasonOf(run, outcome) }),
      });
      logSubcall({
        event: 'research_subcall', researchId: run.researchId, ...callKeyOf(run), kind: outcome.kind, tool: outcome.tool,
        ok: outcome.outcome === 'ok' || outcome.outcome === 'empty',
        ...(outcome.outcome === 'ok' || outcome.outcome === 'empty' ? {} : { errorCode: outcome.outcome }),
        items: outcome.lines.length,
        // A routed read returns only the lines it kept, so raw and kept bytes are the same measure.
        rawBytes: outcome.lines.join('\n').length, keptBytes: outcome.lines.join('\n').length,
        queryChars: outcome.lookup.query.length, queryAuthor: 'routed',
      });
      const key = `routed:${outcome.lookup.source}:${outcome.lookup.query}`;
      // Own memory is a finding too, so a memory layer that settles first is a real first answer.
      run.ledger.set(key, { kind: outcome.kind, source: outcome.source, summary: outcome.lines.join('\n'), lines: outcome.lines, total: outcome.total, ...(outcome.bodyOnly ? { bodyOnly: true } : {}) });
      if (outcome.source === 'memory') {
        if (outcome.outcome === 'ok') run.sourcesDone.add('memory');
        else if (outcome.outcome === 'timeout') run.cutShort.add('memory');
        else if (outcome.outcome !== 'empty') run.sourcesFailed.add('memory');
        continue;
      }
      if (outcome.outcome === 'ok') {
        run.sourcesDone.add(outcome.source); run.sourcesFailed.delete(outcome.source); run.emptySearches.delete(outcome.source);
        if (outcome.cut === true) run.cutShort.add(outcome.source); else run.cutShort.delete(outcome.source);
      }
      else if (outcome.outcome === 'empty') {
        // #572: the attention read names its window, so an empty digest is a window, never a bare no.
        run.emptySearches.set(outcome.source, outcome.tool === INTERNAL.chatAttention
          ? ` in the last ${TRIAGE_DAYS} days`
          : mailEmptyPhrase(outcome.mail, ` for "${(outcome.lookup.query ?? '').slice(0, 60)}"`));
      }
      else if (outcome.outcome === 'timeout') { run.cutShort.add(outcome.source); }
      else run.sourcesFailed.add(outcome.source);
    }
  };
  let runStatus: ResearchRunLog['status'] = 'partial';
  let runStop = 'insufficient';
  // #280: the routed start returned without its terminal run line, so every smoke probe read
  // research_run 0 and a routed read that threw left no line at all. The line is written once, from
  // this finally, so an errored or cut run stays visible and a good run is never written twice.
  try {
    try {
      await Promise.all([...groups.values()].map(async plans => {
        const batch = await routedGroup(deps, run, plans, { question, configured, unavailable, unavailableReason, signal, now });
        record(batch);
        outcomes.push(...batch);
        // #621: a source that matched nothing gets exactly one broadened retry inside this same call, so the
        // voice never spends a round asking the same thing with fewer words.
        const retryPlans = broadenedPlans(run, plans, readContext);
        if (retryPlans !== undefined && batch.every(outcome => outcome.outcome === 'empty')) {
          run.retried.add(retryPlans[0]!.read.source as SourceKind);
          const retried = await routedGroup(deps, run, retryPlans, { question, configured, unavailable, unavailableReason, signal, now });
          record(retried);
          outcomes.push(...retried);
        }
        first.historyPages = outcomes.flatMap(outcome => outcome.historyPage ? [outcome.historyPage] : []);
        const source = batch[0]?.source;
        if (source) {
          first.reading.delete(source);
          first.wake?.();
          lateFindingsOf(deps, first, run.researchId, source, Math.max(...batch.map(outcome => outcome.ms)), [...new Set(batch.flatMap(outcome => outcome.lines))], batch.some(outcome => outcome.outcome === 'ok' || outcome.outcome === 'empty'), run.runId, signal.aborted || run.cancelled || run.stopped);
        }
      }));
    } finally {
      beatTimer?.cancel();
    }
    await depthRead(deps, run, question, signal);
    run.ended = true;
    const sources: JsonObject = {};
    for (const outcome of outcomes) sources[outcome.lookup.source] = outcome.outcome;
    const answered = outcomes.some(outcome => outcome.lines.length > 0);
    // #472: a run cut after its first answer still delivered that answer, so its outcome is partial, never
    // failed; only a cut run that answered nothing is a real failure.
    const delivered = answered || run.answeredAt !== undefined || first.at !== undefined;
    const cut = signal.aborted || run.stopped || run.cancelled;
    const status = cut ? (delivered ? 'partial' : 'stopped') : (answered ? 'answered' : 'partial');
    runStatus = cut ? (delivered ? 'partial' : 'failed') : (answered ? 'answered' : 'partial');
    runStop = cut ? 'cancelled' : (answered ? 'answered' : 'insufficient');
    deps.emit({ researchId: run.researchId, ...callKeyOf(run), phase: 'done', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs: now() - started });
    // N3: a read cut by the caller's deadline still answers with what it has; evidence stays gated on
    // cancellation, a host stop and revoked authority, never on the abort that cut the read.
    if (run.cancelled || run.stopped || !authorizedEvidence(deps, run, signal)) return deniedEvidence(deps, run);
    reply = buildReply(run, status, configured, false, limit, sources);
    const historyPages = outcomes.flatMap(outcome => outcome.historyPage ? [outcome.historyPage] : []);
    reply = capReply(withHistoryPages(reply, historyPages), limit);
    logRouted({
      event: 'research_routed', researchId: run.researchId, ...callKeyOf(run), sources: outcomes.map(outcome => outcome.lookup.source),
      lookups: outcomes.length, ms: outcomes.map(outcome => outcome.ms), outcomes: outcomes.map(outcome => outcome.outcome),
    });
    return reply;
  } catch (error) {
    // A routed read that throws is a failed run, and the closed code keeps the exception text out.
    runStatus = 'failed';
    runStop = 'failed';
    throw error;
  } finally {
    const findings = Array.isArray(reply?.['findings']) ? reply['findings'] as { text?: string }[] : [];
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, ...briefPlanField(run), rounds: 1, perRound: [], stopReason: runStop, status: runStatus, ops: run.ops, sources: outcomes.map(outcome => ({ kind: outcome.source, disposition: outcome.outcome === 'ok' || outcome.outcome === 'empty' ? 'completed' : 'skipped', latencyMs: outcome.ms, ...(outcome.outcome === 'ok' || outcome.outcome === 'empty' ? {} : { reason: skipReasonOf(run.unavailableReasons.get(outcome.source as SourceKind), outcome.outcome) }) })), elapsedMs: Math.max(0, now() - started), deadAirMs: 0, selectorMs: 0, fallbackUsed: false, replyBytes: JSON.stringify(reply ?? {}).length, driver: 'routed', unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: reply?.['canContinue'] === true, findingChars: findings.map(finding => (finding.text ?? '').length), ...receiptCounts(reply, run, configured), bodyReplies: run.bodyReplies, metaStartAsContinue: run.metaStartAsContinue, supersededAborts: run.supersededAborts });
  }
}

/**
 * R6: the first answer point's state, shared by the call and its still-running readers. The call answers at
 * `firstAnswerMs` when any source has findings; from that moment on each reader that settles with something
 * the reply did not already carry is reported once, so the host can hand it over without holding the turn.
 */
function withHistoryPages(reply: JsonObject, pages: JsonObject[]): JsonObject {
  if (!pages.length) return reply;
  return { ...reply, historyPages: pages, canContinue: reply['canContinue'] === true || pages.some(page => typeof page['nextCursor'] === 'string') };
}

interface FirstAnswerState {
  historyPages?: JsonObject[];
  mailShown: Set<string>;
  /** When the call answered ahead of its readers; unset until then. */
  at?: number;
  /** Source lines the first reply already carried, so a late block never repeats one. */
  seen: Set<string>;
  /** Sources already reported late: one event per source per call. */
  delivered: Set<string>;
  /** Sources being read right now, which is what the first reply names as pending. */
  reading: Set<SourceKind>;
  /** The loop's live view, published once it holds a run and a reply budget. */
  snapshot?: () => { run: RunState; configured: readonly SourceKind[]; limit: number };
  /** ROUTE-1022: the sources this question is about, which the first answer waits for. */
  required?: ReadonlySet<SourceKind>;
  /** The run's own budget as an absolute time: the first answer never waits past it. */
  releaseAt?: () => number;
  /** Woken when a source settles, so the wait is event-driven and never a poll. */
  wake?: () => void;
  /** Set when the run's own budget cut its reads: nothing more is coming for this reply. */
  cut?: boolean;
}

const lineKey = (line: string): string => line.trim().toLowerCase().replace(/\s+/gu, ' ');

/** R6: what this source returned that the first reply did not already say. Never an invented line. */
function lateFindingsOf(deps: ResearchDeps, first: FirstAnswerState, researchId: string, source: SourceKind, ms: number, lines: readonly string[], ok: boolean, runId?: number, cut = false): void {
  if (first.at === undefined || first.delivered.has(source)) return;
  first.delivered.add(source);
  const items: string[] = [];
  for (const line of lines) {
    const key = lineKey(line);
    if (!key || first.seen.has(key)) continue;
    first.seen.add(key);
    items.push(line);
    if (items.length >= RESEARCH.lateItems) break;
  }
  const run = deps.ledger.find(researchId);
  const mailKeys: string[] = [];
  if (source === 'mail' && run?.mail.size && run.runId === runId) {
    items.length = 0;
    for (const [key, message] of mailMessages(run)) {
      if (run.mailDelivered.has(key) || first.mailShown.has(key)) continue;
      items.push(message.line); mailKeys.push(key);
      if (items.length >= RESEARCH.lateItems) break;
    }
  }
  const calendarKeys: string[] = [];
  if (source === 'calendar' && run && run.runId === runId) for (const item of items) {
    const entry = [...run.calendar.values()].flatMap(read => [...read.events]).find(([key, event]) => event.line === item && !run.calendarDelivered.has(key) && !calendarKeys.includes(key));
    if (entry) calendarKeys.push(entry[0]);
  }
  deps.late?.({ researchId, ...(runId !== undefined ? { runId } : {}), ...(source === 'calendar' ? { calendarKeys } : {}), ...(mailKeys.length ? { mailKeys } : {}), source, ms, items, ok, ...(cut || (run !== undefined && (run.cancelled || run.stopped)) ? { cut: true } : {}) });
}

/**
 * R6: the call answers at the earlier of two moments: every source has settled, or `firstAnswerMs` with at
 * least one source's findings in hand. A call with nothing to say yet waits exactly as it always has.
 */
async function firstAnswerOf(deps: ResearchDeps, first: FirstAnswerState, loop: Promise<JsonObject>): Promise<JsonObject | undefined> {
  const schedule = deps.schedule ?? scheduleTimer;
  const timers: { cancel: () => void }[] = [];
  const stopTimers = (): void => { for (const timer of timers.splice(0)) timer.cancel(); };
  const wait = (ms: number): Promise<'due'> => new Promise<'due'>(resolve => { timers.push(schedule(() => resolve('due'), Math.max(0, ms))); });
  const settled = loop.then(() => 'settled' as const, () => 'settled' as const);
  const raced = await Promise.race([settled, wait(RESEARCH.firstAnswerMs)]);
  stopTimers();
  if (raced === 'settled') return undefined;
  // R3/R4: whether this answer is the hard stop, decided by what ended the wait rather than by arithmetic on the
  // clock: a timer that came due or a budget already spent means the sources were not waited for any longer.
  let budgetSpent = false;
  // ROUTE-1022 (#526): a question about one source answers with that source, so the first answer does
  // not go out on whatever read happened to land first. The wait is inside the run's own budget, and a
  // source that is not being read is never waited for.
  while (first.required !== undefined && first.releaseAt !== undefined) {
    const live = first.snapshot?.();
    if (live === undefined) return undefined;
    const waiting = [...first.required].some(source => first.reading.has(source) && !live.run.sourcesDone.has(source));
    const operationLeft = live.run.operationDeadlineAt === undefined ? Number.POSITIVE_INFINITY : live.run.operationDeadlineAt - RESEARCH_OPERATION.returnReserveMs - deps.now();
    const left = Math.min(first.releaseAt() - deps.now(), operationLeft);
    if (!waiting) break;
    if (left <= 0 || first.cut === true) { budgetSpent = true; break; }
    const woken = new Promise<'woken'>(resolve => { first.wake = () => resolve('woken'); });
    const next = await Promise.race([settled, woken, wait(left)]);
    delete first.wake;
    stopTimers();
    if (next === 'settled') return undefined;
    if (next === 'due') budgetSpent = true;
  }
  const view = first.snapshot?.();
  if (view === undefined) return undefined;
  const found = [...view.run.ledger.values()].flatMap(entry => entry.lines ?? []).concat([...view.run.calendar.values()].flatMap(read => [...read.events.values()].map(event => event.line)), [...mailMessages(view.run).values()].map(message => message.line));
  // No source has findings yet: the call waits for them to the hard stop (R3), where it answers with what it has and
  // the readers still running detach to the late-findings path.
  if (found.length === 0 && !first.historyPages?.some(page => typeof page['text'] === 'string' && page['text'].length > 0 || Array.isArray(page['hits']) && page['hits'].length > 0)) {
    const deadlineAt = view.run.operationDeadlineAt;
    if (deadlineAt === undefined) return loop;
    const left = deadlineAt - RESEARCH_OPERATION.returnReserveMs - deps.now();
    if (left > 0) {
      const next = await Promise.race([settled, wait(left)]);
      stopTimers();
      if (next === 'settled') return undefined;
      if (next === 'due') budgetSpent = true;
    } else budgetSpent = true;
  }
  const pending = [...first.reading].filter(source => !view.run.sourcesDone.has(source));
  // R3/R4: a source the hard stop left behind did not return in time, and only a source still reading when the
  // answer is released early is still searching. Neither is ever called a timeout while its results are arriving.
  const hardStopped = budgetSpent || first.cut === true;
  if (!evidenceAllowed(deps, view.run, new AbortController().signal)) return deniedEvidence(deps, view.run);
  // ROUTE-1022 (#526): an early answer is partial by definition until its readers settle, and it names
  // them; an answer with nothing left reading is complete and says nothing more is to fetch.
  const partial = pending.length > 0;
  const early = capReply(withHistoryPages(buildReply(view.run, 'partial', view.configured, false, view.limit), first.historyPages ?? []), view.limit);
  // #621: the pending note rides after the trim, so the length check runs once more on the reply the voice
  // actually receives.
  const wrapped = capReply({
    ...early,
    status: partial || early['canContinue'] === true ? 'partial' : 'complete',
    canContinue: partial || early['canContinue'] === true,
    note: partial ? `${hardStopped ? RESEARCH.hardStopNote : RESEARCH.stillReadingNote}${pending.join(', ')}.${String(early['note'] ?? '').includes(RESEARCH.moreAvailableNote) ? ` ${RESEARCH.moreAvailableNote}` : ''}` : (typeof early['note'] === 'string' ? early['note'] : RESEARCH.completeNote),
  }, view.limit);
  const reply: JsonObject = wrapped;
  first.mailShown = new Set((reply as MailReply)[mailDelivery]?.keys ?? []);
  const shown = Array.isArray(reply['findings']) ? reply['findings'] as { text?: string }[] : [];
  for (const finding of shown) for (const line of (finding.text ?? '').split('\n').slice(1)) first.seen.add(lineKey(line));
  for (const read of view.run.calendar.values()) for (const event of read.events.values()) if (shown.some(finding => finding.text?.includes(event.line))) first.seen.add(lineKey(event.line));
  for (const page of first.historyPages ?? []) {
    if (typeof page['text'] === 'string') first.seen.add(lineKey(page['text']));
    if (Array.isArray(page['hits'])) for (const hit of page['hits']) if (isRecord(hit) && typeof hit['snippet'] === 'string') first.seen.add(lineKey(hit['snippet']));
  }
  first.at = deps.now();
  view.run.answeredAt = first.at;
  const researchId = typeof reply['researchId'] === 'string' ? reply['researchId'] : '';
  (deps.logFirstAnswer ?? ((event: ResearchFirstAnswer): void => { hostLogEvent(event); }))({ event: 'research_first_answer', researchId, ms: RESEARCH.firstAnswerMs, settled: [...view.run.sourcesDone], pending, kind: hardStopped ? 'hard_stop' : 'early', elapsedMs: Math.max(0, deps.now() - view.run.startedAt) });
  return capReply({ ...reply, pending }, view.limit);
}

/** The bounded loop. One call runs it start to finish within the run deadline. */
export async function runResearch(deps: ResearchDeps, call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
  const first: FirstAnswerState = { mailShown: new Set(), seen: new Set(), delivered: new Set(), reading: new Set() };
  const loop = runResearchLoop(deps, call, signal, first);
  const early = await firstAnswerOf(deps, first, loop);
  if (early === undefined) {
    const reply = await loop;
    if (!deps.authorizeEvidence) markCalendarReply(deps.ledger, reply);
    // R7: a call every one of whose sources settled logs its answer too, so each research call has one answer line
    // and it says the answer was full rather than early.
    const run = first.snapshot?.().run;
    hostLogEvent({ event: 'research_answer', researchId: typeof reply['researchId'] === 'string' ? reply['researchId'] : '', kind: 'full', elapsedMs: Math.max(0, deps.now() - (run?.startedAt ?? deps.now())) });
    return reply;
  }
  // The call answers now. The readers keep going to their own deadlines, so their findings still land.
  // C-LIVE: the detached loop's own closing reply is never handed to the model, so the findings it marks as
  // given are unmarked again; an owner follow-up then hears them instead of "already given".
  const detached = first.snapshot?.().run;
  const given = detached === undefined ? undefined : new Set(detached.deliveredFindings);
  const unmark = (): void => { if (detached === undefined || given === undefined) return; for (const key of [...detached.deliveredFindings]) if (!given.has(key)) detached.deliveredFindings.delete(key); };
  deps.background?.(loop.then(unmark, unmark));
  if (deps.background === undefined) void loop.then(unmark, unmark);
  if (!deps.authorizeEvidence) markCalendarReply(deps.ledger, early);
  return early;
}

/** K8b: waits for a run's in-flight readers, bounded by the first-answer cut and by the call's own signal. */
function waitForPending(run: RunState, deps: ResearchDeps, signal: AbortSignal): Promise<void> {
  if (run.pending.size === 0) return Promise.resolve();
  const schedule = deps.schedule ?? scheduleTimer;
  return new Promise<void>(resolve => {
    let timer: { cancel: () => void } | undefined;
    const done = (): void => { run.pendingWaiters.delete(done); timer?.cancel(); signal.removeEventListener('abort', done); resolve(); };
    run.pendingWaiters.add(done);
    timer = schedule(done, RESEARCH.firstAnswerMs);
    if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
  });
}

/** #654: the word each source is named by in a spoken direction. */
const SOURCE_WORD_KIND: Readonly<Record<string, SourceKind>> = {
  web: 'web', mail: 'mail', email: 'mail', gmail: 'mail', chat: 'chat', mattermost: 'chat', slack: 'chat',
  calendar: 'calendar', knowledge: 'knowledge', memory: 'memory', company: 'mongoose', mongoose: 'mongoose',
};
const SOURCE_WORD = /(?:^|[^a-z])(web|mail|email|gmail|chat|mattermost|slack|calendar|knowledge|memory|company|mongoose)(?:[^a-z]|$)/giu;
/** Words that page or widen a read already under way, so they never make a continuation a new topic. */
const NAVIGATION_WORDS = new Set(['page', 'pages', 'item', 'items', 'thread', 'threads', 'message', 'messages', 'everything', 'rest', 'details', 'detail', 'contents', 'content', 'whole', 'full', 'older', 'newer']);
/**
 * Words that point back at the run instead of naming a new thing, so "explain the prior discussion and the
 * relevant blocker" continues the run it names while "how did the Blackwell contract win go" does not.
 */
const REFERENTIAL_WORDS = new Set(['prior', 'previous', 'previously', 'earlier', 'above', 'former', 'last', 'discussion', 'conversation', 'thread', 'point', 'points', 'blocker', 'blockers', 'explain', 'identify', 'summarize', 'summarise', 'describe', 'clarify', 'relevant', 'related', 'context', 'topic', 'subject', 'thing', 'things', 'issue', 'issues', 'question', 'answer', 'finding', 'findings', 'said', 'mentioned']);
const TOPIC_SKIP = new Set([...KNOWLEDGE_FILLER, ...REFERENTIAL_WORDS, ...CONTINUATION_WORDS]);

/**
 * #654: an id continues its run only for more of the same read. A direction that names a source the run
 * never read, or words about a new topic, is a new ask, whatever id the model passed with it. Only the
 * model's own direction is judged: a continue's question and topic never reach a source (#565).
 */
function continuesRun(run: RunState, call: ResearchCall, question: string): boolean {
  const read = new Set<SourceKind>([...run.route, ...run.sourcesDone, ...run.pending]);
  // A run's own id continues it only for more of what it already read, judged on the words and lookups
  // the call brings. A source the run never read, or words about a new topic, is a new ask (review F2).
  const unread = (text: string): boolean => {
    for (const match of text.matchAll(SOURCE_WORD)) {
      const source = SOURCE_WORD_KIND[match[1]!.toLowerCase()];
      if (source !== undefined && !read.has(source)) return true;
    }
    return false;
  };
  const sameTopic = (text: string): boolean => {
    const known = new Set(contentKeywords(`${run.question ?? ''} ${run.topic ?? ''}`, 40, TOPIC_SKIP));
    return contentKeywords(text, 12, TOPIC_SKIP).every(word => known.has(word) || NAVIGATION_WORDS.has(word));
  };
  const said = (call.direction ?? '').trim();
  if (said !== '') return !unread(said) && sameTopic(said);
  const lookups = normalizeLookups(call.lookups);
  for (const lookup of lookups) {
    const source = (lookup.source === 'company' ? 'mongoose' : lookup.source) as SourceKind;
    if (source !== 'memory' && !read.has(source)) return false;
  }
  if (unread(question)) return false;
  // A continue that names its own lookups is a new search, so its words must be the run's words.
  // Review G2: a question with no lookups and no direction is judged too, so a new topic always starts fresh.
  return question.trim() === '' || sameTopic(question);
}

/** The mark the connector and the host leave on a body cut to its window. */
const KNOWLEDGE_CUT_AT = /cut at \d+ chars/u;

/** The hit id one shaped line or one fetched entry names, if it names one. */
function hitIdOf(line: string): string | undefined {
  return line.match(/\[id (\d+)\]/u)?.[1] ?? line.match(/^\s*\*\*#(\d+)\*\*/u)?.[1] ?? line.match(/^#{2,3}\s*#(\d+)\b/u)?.[1];
}

/** C-DEPTH item 3: the ids a summary names, the hits that mention an asked entity first. */
export function knowledgeReadIds(text: string, asked: readonly string[], limit: number = RESEARCH.knowledgeReadEntries): string[] {
  const ids: string[] = [];
  const named: string[] = [];
  for (const line of text.split('\n')) {
    const id = hitIdOf(line);
    if (id === undefined || ids.includes(id) || named.includes(id)) continue;
    (asked.some(name => line.includes(name)) ? named : ids).push(id);
  }
  return [...named, ...ids].slice(0, limit);
}

/**
 * C-DEPTH item 3 (W10-R7): the full body replaces the summary of the hit it came from, keyed by that hit's own
 * id, so the knowledge shaping still sees one block of hits and no other source learns a second keyed read.
 * An entry that names no hit is left out rather than appended: a fetched entry reaches the reply or was not paid for.
 */
async function withFullEntries(
  execute: (subs: readonly IntentSubCall[], signal: AbortSignal) => Promise<IntentSubResult[]>,
  run: RunState, results: readonly IntentSubResult[], question: string, signal: AbortSignal,
  boundMs: number = RESEARCH.knowledgeReadMs,
): Promise<IntentSubResult[]> {
  const searched = results.find(result => result.name === INTERNAL.knowledgeSearch && result.ok && result.text.trim());
  if (searched === undefined) return [...results];
  // The fetch is for the hits that matter: the ask named a person or a document, or asked for depth.
  const asked = requestedEntities(question);
  if (asked.length === 0 && budgetFor(question) !== RESEARCH.budgets.depth) return [...results];
  const ids = knowledgeReadIds(searched.text, asked);
  if (ids.length === 0) return [...results];
  run.ops += 1;
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(boundMs)]);
    const read = await execute([{ key: 'knowledge_entries', name: INTERNAL.knowledgeRead, args: { ids } }], bounded);
    const bodies = new Map<string, string>();
    for (const entry of read) {
      if (!entry.ok || !entry.text.trim()) continue;
      for (const line of entry.text.split('\n')) {
        const id = hitIdOf(line);
        if (id !== undefined && !bodies.has(id)) bodies.set(id, line.trim().slice(0, RESEARCH.knowledgeBodyChars));
      }
    }
    if (bodies.size === 0) { run.knowledgeFetchCut = true; return [...results]; }
    const enriched = searched.text.split('\n').map(line => {
      const id = hitIdOf(line);
      return id === undefined || !bodies.has(id) ? line : bodies.get(id)!;
    }).join('\n');
    return results.map(result => (result === searched ? { ...result, text: enriched } : result));
  } catch { run.knowledgeFetchCut = true; return [...results]; }
}

/** The loop behind a call: unchanged by the first answer point except for what it reports late. */
async function runResearchLoop(deps: ResearchDeps, call: ResearchCall, signal: AbortSignal, first: FirstAnswerState): Promise<JsonObject> {
  let limit = deps.replyLimit ?? budgetFor(call.question ?? '', call.topic ?? undefined);
  // Q5-R1: a read of a named entry widens the reply to the connector's knowledge body cap, so the
  // body the owner asked for is never trimmed away for the length of a search reply.
  const widenFor = (subs: readonly IntentSubCall[]): void => {
    if (subs.some(sub => sub.name === INTERNAL.knowledgeRead)) limit = Math.max(limit, RESEARCH.readReplyChars);
  };
  const now = () => deps.now();
  const configured = [...new Set([...(deps.configuredNow ?? (() => deps.configured))(), ...(deps.web === undefined ? [] : ['web' as const])])];
  // P5: a source that cannot serve a read says why. The composition may hand over the connector's own
  // reason; a bare source name still reports a cause, never "nothing found".
  const unavailableEntries = (deps.unavailableNow ?? (() => []))().map(entry => typeof entry === 'string' ? { source: entry, reason: 'connector_unavailable' } : entry);
  const unavailable = unavailableEntries.map(entry => entry.source);
  const unavailableReason = (source: SourceKind): string => unavailableEntries.find(entry => entry.source === source)?.reason ?? 'connector_unavailable';
  const logSubcall = deps.logSubcall ?? ((event: ResearchSubcallLog): void => hostLogEvent(event));
  const logSource = deps.logSource ?? ((event: ResearchSourceLog): void => { hostLogEvent(event); });
  const publishStep = deps.step ?? liveToolStep;
  const stepCallId = call.callId ?? '';

  if (call.action === 'stop') {
    const run = deps.ledger.stop(call.researchId);
    if (!run) return { researchId: call.researchId ?? '', status: 'stopped', findings: [], unchecked: configured, canContinue: false };
    deps.emit({ researchId: run.researchId, ...callKeyOf(run), phase: 'stopped', sourcesDone: [...run.sourcesDone], sourcesPending: [], elapsedMs: Math.max(0, now() - run.startedAt) });
    const reply = buildReply(run, 'stopped', configured, false, limit);
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: run.rounds, perRound: [], stopReason: 'stop', status: 'stopped', ops: run.ops, sources: [], elapsedMs: Math.max(0, now() - run.startedAt), deadAirMs: 0, selectorMs: 0, fallbackUsed: false, replyBytes: JSON.stringify(reply).length, unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: false, findingChars: [] });
    return reply;
  }

  const question = call.question?.trim() ?? '';
  // #565 and MAILQ-AUTHOR F3: only a start names a topic, and a continuation reads no new text, so the
  // words that reach a source are the ones the run opened with.
  const topic = call.action === 'start' ? (call.topic?.trim() ?? '') : '';
  // K8a: a start whose question carries no content ("wait findings.", "any results?") is the model asking
  // about the run already reading; cancelling it there threw away the findings it was asking for.
  if (call.action === 'start' && metaOnlyQuestion(question)) {
    const active = deps.ledger.last();
    if (active && !active.cancelled && !active.stopped && (!active.ended || active.pending.size > 0)) {
      call = { ...call, action: 'continue', researchId: active.researchId };
      active.metaStartAsContinue = true;
    }
  }
  let run: RunState;
  if (call.action === 'start') {
    deps.ledger.cancelActive();
    run = deps.ledger.begin({ researchId: call.researchId, questionClass: 'cross_source', deadlineMs: RESEARCH.startDeadlineMs, maxRounds: RESEARCH.startRounds, now: now(), ...(question === '' ? {} : { question }), ...(topic === '' ? {} : { topic }), ...(call.callId === undefined ? {} : { callKey: call.callId }) });
  } else {
    if (call.cursor !== undefined) {
      const prior = deps.ledger.find(call.researchId ?? '');
      const bodyPage = prior?.bodyCursors.get(call.cursor);
      if (prior && bodyPage) {
        if (!evidenceAllowed(deps, prior, signal)) return deniedEvidence(deps, prior);
        const body = prior.bodies.get(bodyPage.key);
        if (!body || body.evidence.expiresAt <= Date.now()) { deps.ledger.stop(prior.researchId); return { researchId: prior.researchId, error: 'continuation_unavailable', findings: [], canContinue: false, note: CONTINUATION_UNAVAILABLE_NOTE }; }
        if (bodyPage.delivered) return { researchId: prior.researchId, status: 'partial', findings: [], alreadyDelivered: true, delivery: 'model-context', cursor: call.cursor, ...(bodyPage.nextCursor ? { nextCursor: bodyPage.nextCursor } : {}), canContinue: bodyPage.canContinue ?? Boolean(bodyPage.nextCursor) };
      } else {
        const page = prior?.mailCursors.get(call.cursor);
      if (!prior || !page || !evidenceAllowed(deps, prior, signal)) return { researchId: call.researchId ?? '', error: 'continuation_unavailable', findings: [], canContinue: false, note: CONTINUATION_UNAVAILABLE_NOTE };
      if (page.scope !== mailScope(prior) || page.ids.length === 0 && !page.delivered && page.sourceState !== mailSourceState(prior)) return { researchId: prior.researchId, error: 'continuation_unavailable', findings: [], canContinue: true, note: 'This source coordinate has already advanced. Use nextCursor from the latest reply or continue this researchId without a cursor for retained evidence.' };
      if (page.delivered) return { researchId: prior.researchId, status: page.partial ? 'partial' : 'complete', findings: [], alreadyDelivered: true, delivery: 'model-context', cursor: call.cursor, deliveredMessageIds: page.ids, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), canContinue: Boolean(page.nextCursor) };
      }
    }
    const priorRun = call.cursor === undefined ? deps.ledger.find(call.researchId ?? '') : undefined;
    if (priorRun !== undefined && !continuesRun(priorRun, call, question)) {
      // #654: an id from an older run never carries a new source or a new topic, so that ask starts fresh.
      deps.ledger.cancelActive();
      const freshTopic = call.topic?.trim() ?? '';
      run = deps.ledger.begin({ researchId: undefined, questionClass: 'cross_source', deadlineMs: RESEARCH.startDeadlineMs, maxRounds: RESEARCH.startRounds, now: now(), ...(question === '' ? {} : { question }), ...(freshTopic === '' ? {} : { topic: freshTopic }), ...(call.callId === undefined ? {} : { callKey: call.callId }) });
      run.startedFresh = true;
    } else {
      const resumed = deps.ledger.resume(call.researchId ?? '', { direction: call.direction, deadlineMs: RESEARCH.continueDeadlineMs, maxRounds: RESEARCH.continueRounds, now: now() });
      if (!resumed) return { researchId: call.researchId ?? '', error: 'continuation_unavailable', status: 'unavailable', findings: [], canContinue: false, note: 'This research run is no longer available. Start a new lookup.' };
      run = resumed;
    }
  }
  run.direction = call.direction ?? run.direction;
  // R3: the readers are bounded by the hard stop, not by the patience budget: a source that has not returned by
  // then is cut, and the call names it. A page never starts unless it fits the patience budget (boundedPages).
  run.operationDeadlineAt = now() + RESEARCH_OPERATION.hardStopMs;
  run.reading = first.reading;
  // #621: the ask's own route, so a source it names but the session never wired still says why.
  for (const source of requiredSources(run.question ?? question)) run.route.add(source);
  if (deps.timeZone === undefined) delete run.timeZone; else run.timeZone = deps.timeZone;
  if (call.cursor !== undefined) { if (run.bodyCursors.has(call.cursor)) run.bodyCursorRequested = call.cursor; else run.mailCursorRequested = call.cursor; }
  first.snapshot = () => ({ run, configured, limit });
  // K8b: a continue on a run whose readers are still working waits for them, bounded by the first-answer cut.
  if (call.action !== 'start' && run.pending.size > 0) await waitForPending(run, deps, signal);
  const executeSource = deps.execute, emitProgress = deps.emit;
  const running = new Map<SourceKind, number>(), completed = new Set<SourceKind>(run.sourcesDone);
  const current = (): boolean => !run.cancelled && !run.stopped && deps.ledger.find(run.researchId) === run;
  const emit = (event: ResearchProgress): void => {
    if (current()) emitProgress({ ...callKeyOf(run), ...event, sourcesDone: [...completed].filter(source => !running.has(source)), sourcesPending: [...running.keys()] });
  };
  const update = (): void => emit({ researchId: run.researchId, phase: 'round', sourcesDone: [], sourcesPending: [], elapsedMs: Math.max(0, now() - run.startedAt) });
  // TOPIC-R2 F1: every digit gate reads the owner's words for this run, so a later hop keeps its numbers.
  const ownerWords = run.question === undefined || run.question === question ? question : `${run.question} ${question}`.trim();
  let invocation = 0;
  /** The host's step sink threw on this run: a host fault the prime read's own catch must not read as an empty source. */
  let stepSinkFailed = false;
  deps = { ...deps, emit, execute: async (subs, sourceSignal) => {
    const mailOnly = subs.length > 0 && subs.every(sub => sub.name === INTERNAL.mailRead || sub.name === INTERNAL.mailList);
    if (mailOnly) run.mailDeadlineAt ??= now() + Math.min(RESEARCH.sourceDeadline.mail, Math.max(1, run.deadlineMs - (now() - run.startedAt)));
    // RUN-R7: the mail read's own deadline is cut upstream on the run's clock, so no wall-clock timer rides here.
    const dispatchSignal = sourceSignal;
    if (!current() || dispatchSignal.aborted) return subs.map(sub => ({ key: sub.key, name: sub.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'round_cancelled' }));
    const at = now(), batch = ++invocation;
    const sources = [...new Set(subs.map(sub => sourceKindOfKindName(sub.name)).filter((source): source is SourceKind => source !== null))];
    const steps = sources.map(source => {
      const sub = subs.find(sub => sourceKindOfKindName(sub.name) === source)!;
      const ownerQuery = run.ownerQueries.get(String(sub.args['q'] ?? ''));
      const subject = stepSubject(ownerQuery === undefined ? sub.args : { query: ownerQuery });
      const action = /search|list|find|history/.test(sub.name) ? 'search' : 'read';
      return { callId: stepCallId, stepId: `${run.researchId}:${run.runId}:${stepCallId}:${batch}:${source}`, source, action, ...(subject ? { subject } : {}) };
    });
    try { for (const step of steps) { running.set(step.source, (running.get(step.source) ?? 0) + 1); run.pending.add(step.source); publishStep({ ...step, phase: 'start' }); } }
    catch (error) { stepSinkFailed = true; throw error; }
    update();
    let ended = false;
    const finish = (results: readonly IntentSubResult[], errorCode?: 'failed' | 'timeout' | 'cancelled'): void => {
      if (ended) return;
      ended = true;
      for (const step of steps) {
        const own = subs.flatMap((sub, index) => sourceKindOfKindName(sub.name) === step.source ? [results[index]] : []);
        const ok = errorCode === undefined && own.length > 0 && own.every(result => result?.ok);
        const code = errorCode ?? (own.some(result => result?.code === 'timeout' || result?.code === 'deadline') ? 'timeout' : ok ? undefined : 'failed');
        const count = (running.get(step.source) ?? 1) - 1;
        if (count > 0) running.set(step.source, count); else { running.delete(step.source); run.pending.delete(step.source); if (run.pending.size === 0) for (const wake of [...run.pendingWaiters]) wake(); }
        if (ok) completed.add(step.source);
        const resultCount = own.reduce((count, result) => count + (result?.ok ? result.mailPage?.messages.length ?? result.calendarPage?.events.length ?? (Array.isArray(result.historyPage?.['hits']) ? result.historyPage['hits'].length : shapeBlock(shapeKindOf(step.source, 'knowledge_search'), [result]).total) : 0), 0);
        publishStep({ ...step, phase: 'end', ok, ...(ok ? { resultCount } : {}), ...(code ? { errorCode: code } : {}), ms: Math.max(0, now() - at) });
      }
      update();
    };
    const progressSignal = AbortSignal.any([dispatchSignal, run.progressAbort.signal]);
    const aborted = (): void => {
      if (!dispatchSignal.aborted && run.cancelled) run.supersededAborts += new Set(subs.map(sub => sourceKindOfKindName(sub.name)).filter(source => source !== null)).size;
      finish([], dispatchSignal.aborted && dispatchSignal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
    };
    progressSignal.addEventListener('abort', aborted, { once: true });
    if (progressSignal.aborted) aborted();
    let results: IntentSubResult[];
    try {
      results = await executeSource(subs, progressSignal);
      // C-DEPTH item 3 (W10-R7): this is the one place every read passes through, so the summaries are enriched
      // with the full bodies of the hits that matter here, batched once, inside the same round.
      results = await withFullEntries(executeSource, run, results, run.question ?? '', progressSignal, deps.knowledgeReadMs ?? RESEARCH.knowledgeReadMs);
      // #647: the one place every read passes through, so a chat read that matched nothing on every word is
      // broadened here once, before the reply and the progress steps read it.
      if (!dispatchSignal.aborted) results = await broadenedChatRetry(executeSource, subs, results, progressSignal, run.broadenedChat);
      noteChatReads(run, subs, results);
      finish(results, current() ? undefined : 'cancelled');
    }
    catch (error) { finish([], 'failed'); throw error; }
    finally { progressSignal.removeEventListener('abort', aborted); }
    const fresh = results.flatMap(result => result.binding ? [result.binding] : []);
    if (run.stopped || run.cancelled || deps.ledger.find(run.researchId) !== run) {
      deps.ledger.discardEvidence(fresh);
      return results.map(result => { const { hostEvidence: _evidence, ...rest } = result; return { ...rest, ok: false, text: '', code: 'round_cancelled' }; });
    }
    // L10: a cut or a deadline drops only what did not arrive; a source that answered keeps its findings
    // and the run is partial, never cancelled.
    if (dispatchSignal.aborted) {
      deps.ledger.discardEvidence(results.flatMap(result => result.ok ? [] : result.binding ? [result.binding] : []));
      return results.map(result => result.ok ? result : { ...result, ok: false, text: '', code: 'round_cancelled' });
    }
    for (const result of results) {
      if (!result.ok || !result.binding || result.hostEvidence?.kind !== 'remote-body') continue;
      const evidence = result.hostEvidence;
      const source: SourceKind = result.name === INTERNAL.mailRead ? 'mail' : result.name === INTERNAL.knowledgeRead ? 'knowledge' : 'mongoose';
      if (!run.bodies.has(result.binding.result.id)) run.bodies.set(result.binding.result.id, { evidence, binding: result.binding, source, offset: 0 });
    }
    return results;
  } };

  if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
  // RUN-R8 F2: L23 stops body-slice paging after a complete reply. A continue that brings a new direction or
  // lookups is a new question, so it dispatches its reads instead of paging the last answer.
  const freshQuestion = call.direction !== undefined || call.lookups !== undefined;
  if (call.action === 'continue' && !freshQuestion && [...run.bodies.values()].some(body => body.offset < body.evidence.body.length) && call.lookups === undefined) return buildReply(run, 'partial', configured, false, limit);
  if (call.action === 'continue' && !freshQuestion && run.mail.size > 0 && call.lookups === undefined) {
    const pendingLocal = [...mailMessages(run).keys()].some(key => !run.mailDelivered.has(key));
    if (!pendingLocal) await collectMail(deps, run, signal, Math.min(RESEARCH.sourceDeadline.mail, run.deadlineMs), now);
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    return buildReply(run, 'answered', configured, false, limit);
  }
  if (call.action === 'continue' && !freshQuestion && run.calendar.size > 0 && call.lookups === undefined) {
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    const pendingLocal = [...run.calendar.values()].some(read => [...read.events].some(([key]) => !run.calendarDelivered.has(key)));
    if (!pendingLocal) await collectCalendar(deps, run, signal, Math.min(RESEARCH.sourceDeadline.calendar, run.deadlineMs), now);
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    return buildReply(run, 'answered', configured, false, limit);
  }

  // C-CHAT: "more" on a chat read that matched more than it returned reads its next page, one page per call.
  if (call.action === 'continue' && !freshQuestion && run.chatPage !== undefined && call.lookups === undefined) {
    const page = run.chatPage;
    const sub: IntentSubCall = { ...page.sub, key: `${page.sub.key}p${page.next}`, args: { ...page.sub.args, offset: page.next } };
    const results = await deps.execute([sub], signal);
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    const block = shapeBlock('chat_search', results, deps.timeZone);
    for (const [key, entry] of run.ledger) if (entry.source === 'chat') run.ledger.delete(key);
    run.ledger.set(`chat_search:page:${page.next}`, { kind: 'chat_search', source: 'chat', summary: block.text, lines: block.lines, total: Math.max(page.total, block.total) });
    run.chatNotes.push(`This is the next page: posts ${page.next + 1} to ${page.next + block.lines.length} of ${page.total}.`);
    if (block.lines.length > 0) { run.sourcesDone.add('chat'); run.emptySearches.delete('chat'); }
    return buildReply(run, 'answered', configured, false, limit);
  }
  // K6: a routed start names its own layers, so the selector is skipped and every lookup runs at once.
  const lookups = normalizeLookups(call.lookups);
  if (call.action === 'continue' && run.historyTokens.size > 0 && lookups.length === 0) return { researchId: run.researchId, status: 'partial', findings: [], canContinue: true, note: 'Continue local history with a memory lookup containing history.recordRef or history.cursor from historyPages.' };
  // #657 item 1: a status or test-all ask names every source, so the host reads the first batch within
  // the limit and leaves the rest for the next call, instead of refusing the whole ask.
  if (statusAsk(question)) {
    const probes = toolBatch(run, configured, lookups).map(lookup => statusProbeOf(lookup, question));
    if (probes.length > 0) return routedResearch(deps, run, question, probes, configured, unavailable, unavailableReason, signal, now, limit, first);
  }
  if (lookups.length > 0) return routedResearch(deps, run, question, lookups, configured, unavailable, unavailableReason, signal, now, limit, first);
  // TRIAGE-R3: a recall ask reads her own remembered history, so it takes the memory lookup the routed
  // path already serves with its binding, page and continuation, never a knowledge search.
  // E2 (#605): a discussion ask reads the chat beside her memory, because that is where it was said.
  // #646: the chat leg here read the discussion forms alone, so a recall ask that only mentioned the team
  // waited on a chat read it never needed. The need rule decides it, as it does for the route and the router.
  if (call.action === 'start' && recallQuestion(question)) {
    const recall = contentKeywords(question, 8).join(' ');
    const lookups: ResearchLookup[] = [{ source: 'memory', query: recall }];
    if (chatQuestionWords(question) && configured.includes('chat')) lookups.push({ source: 'chat', query: recall });
    return routedResearch(deps, run, question, lookups, configured, unavailable, unavailableReason, signal, now, limit, first);
  }

  const perRound: ResearchRunLog['perRound'] = [];
  const sourceLog: ResearchRunLog['sources'] = [];
  let selectorMs = 0;
  // B7: `cut` is not in the closed host-log disposition set, so a cut read is logged `skipped` and the
  // run-level flag below keeps the answer honest as partial.
  let sawCut = false;
  let fallbackUsed = false;
  // #260: how this run chose its sources, recorded where the loop decides it. selector dominates a
  // later fallback; the fixed recipe and the single-source hint never override a selector decision.
  let driver: ResearchDriver | undefined;
  let stopReason = 'rounds_exhausted';
  const started = run.startedAt;
  const deadlineAt = started + run.deadlineMs;

  // RD: dead air is the longest stretch the model hears nothing, measured at every delivery, so the
  // run log states the real silence instead of the whole elapsed time.
  let lastHeardAt = started;
  let worstGapMs = 0;
  const notify = (progress: ResearchProgress): void => {
    const at = now();
    worstGapMs = Math.max(worstGapMs, at - lastHeardAt);
    lastHeardAt = at;
    deps.emit({ ...callKeyOf(run), ...progress });
  };

  notify({ researchId: run.researchId, phase: 'started', sourcesDone: [], sourcesPending: [...configured], elapsedMs: 0 });

  // Dead air: the model is told the run is alive every few seconds. A selector that burns its whole
  // deadline or a slow source read used to leave the model and the owner in silence until the end.
  const schedule = deps.schedule ?? scheduleTimer;
  const beat = (): void => {
    notify({ researchId: run.researchId, phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs: Math.max(0, now() - started) });
    heartbeat = schedule(beat, RESEARCH.progressEveryMs);
  };
  let heartbeat = schedule(beat, RESEARCH.progressEveryMs);

  // RD/P5-R1: a start call answers, or reports its honest partial, inside its own budget. R3: the one cut for the
  // whole run is the hard stop, so a read in flight keeps its full patience instead of dying at the patience
  // budget the owner complained about; the patience budget decides what may still be started.
  const answerCut = new AbortController();
  // ROUTE-1022 (#526): a cut read ends the first answer's wait for the source it is about.
  answerCut.signal.addEventListener('abort', () => { first.cut = true; first.wake?.(); }, { once: true });
  const hint = hintedSources(call.sources, configured);
  const answerMs = RESEARCH_OPERATION.hardStopMs;
  const answerTimer = call.action === 'start' ? schedule(() => answerCut.abort(), answerMs) : { unref: () => {}, cancel: () => {} };
  // ROUTE-1022 (#526): the source classes this question is about, and the run's own budget as the
  // latest moment the first answer may hold for them. Both are read by the first answer point only,
  // and both are set here so the budget is the one this run declared.
  // Release 4: a continuation plans from its own content words, never from the model's meta words.
  const plannedText = planText(question, run);
  const required = new Set(requiredSources(plannedText).filter(source => configured.includes(source)));
  if (required.size > 0) first.required = required;
  first.releaseAt = () => started + RESEARCH_OPERATION.hardStopMs;
  // Outcome 5: the owner's knowledge base is the prime source. Its read starts immediately, in
  // parallel with source selection, unless the owner named one certain non-knowledge source.
  const knowledgeSubs = candidateSubs('knowledge_search', { question, topic: run.topic, ownerWords, configured, evidence: run.evidence, nowMs: now(), timeZone: deps.timeZone });
  widenFor(knowledgeSubs);
  const knowledgeWanted = configured.includes('knowledge') && knowledgeSubs.length > 0 && !run.readKinds.has('knowledge_search')
    && !(hint.length === 1 && hint[0] !== 'knowledge');
  let knowledgeStartedAt = 0;
  let knowledgeEndedAt = 0;
  let knowledgePromise: Promise<IntentSubResult[]> | undefined;
  let knowledgeConsumed = false;
  // R9: the terminal run line is written once, from the finally below, so a throw inside the selector loop
  // still leaves a receipt with a closed stop code, a cut keeps its line, and a good run is never written twice.
  let status: ResearchRunLog['status'] = 'partial';
  let reply: JsonObject | undefined;
  let elapsedMs = 0;
  let runFailed = false;
  try {
    for (let round = 1; round <= run.maxRounds; round++) {
      if (signal.aborted) { run.stopped = true; stopReason = 'cancelled'; break; }
      if (run.cancelled || run.stopped) { stopReason = 'cancelled'; break; }
      const elapsed = now() - started;
      if (elapsed >= run.deadlineMs) { stopReason = 'deadline'; break; }

      // Start the prime-source read right before source selection, so it runs in parallel with the
      // selector rather than behind it.
      if (round === 1 && knowledgeWanted && knowledgePromise === undefined) {
        const remainingMs = deadlineAt - now();
        if (remainingMs > 0) {
          knowledgeStartedAt = now();
          // K8: the read's own span is stamped when it settles, so the source log states the read and
          // never the wait it spent before selection.
          // F4: the prime read is bounded by its own source deadline on the run's clock, never by the
          // answer point, so the first answer cannot cut a read that is still working.
          const prefetchCut = new AbortController();
          const prefetchTimer = schedule(() => prefetchCut.abort(new DOMException('Source deadline elapsed', 'TimeoutError')), Math.min(RESEARCH.sourceDeadline.knowledge, remainingMs));
          recordShapes(deps, run, knowledgeSubs, now);
        knowledgePromise = deps.execute(knowledgeSubs, AbortSignal.any([signal, prefetchCut.signal])).then(async (results: IntentSubResult[]) => {
            // ONE-1023: a past day that matched nothing still asks the topic once, without the day filter.
            await droppedDayFilterRetry(deps, knowledgeSubs, results, AbortSignal.any([signal, prefetchCut.signal]), run.droppedDayFilters);
            knowledgeEndedAt = now();
            return results;
          }).catch((error: unknown) => {
            if (stepSinkFailed) throw error;
            knowledgeEndedAt = now();
            return [] as IntentSubResult[];
          }).finally(() => prefetchTimer.cancel());
        }
      }

      const completedKinds = [...run.readKinds];
      const offerable = offerableCandidates(configured, completedKinds);
      let selection: SelectorOutput;
      let usedFallbackThisRound = false;
      let narrowed: CandidateKind[] | undefined;
      // A single-source hint pins the whole run to that one source, so the selector is never called,
      // in any round: once the source is read there is nothing left to select. W2: one configured source
      // is the same situation, so it takes the same deterministic path (#473).
      const singleSource = hint.length === 1 ? hint[0] : configured.length === 1 ? configured[0] : undefined;
      if (singleSource !== undefined) {
        narrowed = offerable.filter(kind => CANDIDATES.find(c => c.kind === kind)?.source === singleSource);
        if (driver === undefined) driver = hint.length === 1 ? 'single-source-hint' : 'fallback';
      }
      const candidatesForSelector = narrowed ?? offerable;
      // ROUTE-1022 (#526): an unambiguous question is routed here, so the selector call is never spent
      // on it. The router reads the same word classes the fallback recipe does.
      const routed = round === 1 && hint.length === 0 ? routedSelection(plannedText, configured, now()) : undefined;
      if (narrowed !== undefined) {
        // Outcome 6: one certain source is deterministic; skip the selector call entirely.
        selection = fallbackSelection(plannedText, configured, now());
      } else if (routed !== undefined) {
        selection = routed;
        if (driver === undefined) driver = 'routed';
      } else {
        // F-B: the voice path never waits for a selector round; the deterministic recipe answers at once.
        fallbackUsed = true;
        usedFallbackThisRound = true;
        selection = fallbackSelection(plannedText, configured, now());
        if (driver === undefined) driver = 'fallback';
      }

      // F5: which author wrote the query, a closed set: the owner's hint, the router, or the fallback recipe.
      const selectionAuthor: 'routed' | 'fallback' | 'hint' = hint.length > 0 ? 'hint' : routed !== undefined ? 'routed' : 'fallback';

      // A single-source hint must always run that source, even when the question carried no terms
      // the fallback could match (an empty or terse spoken question): seed the hinted searches.
      if (narrowed !== undefined) {
        const text = plannedText;
        for (const kind of narrowed) {
          if (selection.actions.some(action => action.kind === kind)) continue;
          selection.actions.push({ kind, ...fallbackQuery(kind, text, now(), configured) });
          selection.pUseful[kind] = 0.6;
        }
      }

      // ROUTE-1022: a question about the owner's own schedule keeps the calendar read in the plan on
      // the selector path and the fallback path alike, whenever the calendar endpoint can serve it.
      if (ownerScheduleQuestion(plannedText) && selection.actions.length > 0 && candidatesForSelector.includes('calendar_window')
        && !unavailable.includes('calendar') && !selection.actions.some(action => action.kind === 'calendar_window')) {
        selection.actions.push({ kind: 'calendar_window', ...fallbackQuery('calendar_window', plannedText, now(), configured) });
        selection.pUseful['calendar_window'] ??= 0.4;
      }

      if (run.ledger.size === 0 && question) run.questionClass = selection.questionClass;
      run.questionClass = selection.questionClass;

      // One round reads each candidate once: a selector that repeats an action is deduplicated here.
      const chosen = [...new Set(selection.actions.map(action => action.kind).filter(kind => candidatesForSelector.includes(kind)))];
      // Outcome 5: the pre-started knowledge read is included even when the selector did not pick it,
      // so the prime source is always read once and its findings can rank first.
      if (knowledgePromise !== undefined && !knowledgeConsumed && !chosen.includes('knowledge_search') && !chosen.includes('brief') && candidatesForSelector.includes('knowledge_search')) chosen.push('knowledge_search');
      perRound.push({ candidates: offerable.map(kind => ({ kind, pUseful: selection.pUseful[kind] ?? 0 })), chosen: [...chosen] });

      if (chosen.length === 0) { stopReason = selection.actions.some(a => a.kind === 'stop_insufficient') ? 'insufficient' : 'answered'; run.rounds = round; break; }

      // Run this round's chosen actions in parallel, bounded by maxConcurrent and maxOps.
      const toRun: CandidateKind[] = [];
      for (const kind of chosen) {
        if (run.ops >= RESEARCH.maxOps) { stopReason = 'ops_exhausted'; break; }
        toRun.push(kind);
        run.ops += Math.max(1, kind === 'calendar_window' ? 1 : candidateSubs(kind, { question, topic: run.topic, ownerWords, configured, evidence: run.evidence }).length);
      }
      const batches: CandidateKind[][] = [];
      for (let i = 0; i < toRun.length; i += RESEARCH.maxConcurrent) batches.push(toRun.slice(i, i + RESEARCH.maxConcurrent));
      for (const batch of batches) {
        const batchDeadline = deadlineAt;
        // P5: the call's own budget follows the slowest source this batch reads, and only that far.
        const batchSources = batch.flatMap(kind => {
          const named = sourceKindOf(kind);
          return named !== null ? [named] : kind === 'brief' ? [...configured] : [];
        });
        // R1: the batch's sources are read by the same patience budget every call names once.
        for (const source of batchSources) run.route.add(source);
        const remainingMs = batchDeadline - now();
        if (remainingMs <= 0) { stopReason = 'deadline'; break; }
        // RD/P5-R1: a start call answers inside its budget, so the owner hears a reply instead of waiting on
        // the slowest connector. A continue call is an explicit follow-up and keeps the run deadline.
        // RUN-R7: the round is bounded by the batch deadline check and each read's own cut on the run's clock,
        // never by a wall-clock timer that a fake clock cannot reach.
        const roundSignal = signal;
        const latencies = new Map<CandidateKind, number>();
        const readStarted = new Set<CandidateKind>();
        const cutKinds = new Set<CandidateKind>();
        // RD: the round hands the model an answer as soon as one source has something to say. R6: it no
        // longer cuts the readers still working, because the call answers on its own clock (runResearch) and
        // every reader lands on its own deadline. A cut here is always the source's own budget running out.
        let answeredRound = false;
        const reads = batch.map(async kind => {
          const action = selection.actions.find(entry => entry.kind === kind);
          let subs: IntentSubCall[];
          try { subs = candidateSubs(kind, { question, topic: run.topic, ownerWords, configured, evidence: run.evidence, query: action?.query, window: action?.window, nowMs: now(), timeZone: deps.timeZone }); }
          catch { run.unavailableReasons.set('calendar', 'window_unparsed'); run.sourcesFailed.add('calendar'); return; }
          recordChatDate(run, action?.query, subs);
          // F2: the live step speaks the owner's words, never the compiled Gmail query.
          if (kind === 'mail_search' && action?.query !== undefined) for (const sub of subs) run.ownerQueries.set(String(sub.args['q']), action.query);
          // E6 (#609): the same finer bound on the loop path, keyed by the query the read will run.
          const mailHoursAsked = mailHours(question);
          if (mailHoursAsked !== undefined) for (const sub of subs) run.mailSince.set(String(sub.args['q']), now() - mailHoursAsked * 3_600_000);
          if (subs.length === 0) return;
          widenFor(subs);
          readStarted.add(kind);
          const named = sourceKindOf(kind);
          const allSources = named !== null ? [named]
            : [...new Set(subs.map(sub => sourceKindOfKindName(sub.name)).filter((source): source is SourceKind => source !== null))];
          // P5 outcome 3 and P5-R5 (F2): a source that cannot serve a read right now never spends this
          // read's deadline, and it is dropped source by source, so a multi-source read still serves the
          // healthy ones while the reply carries the dead one's reason.
          const startSources = allSources.filter(source => !unavailable.includes(source));
          const deadSources = allSources.filter(source => unavailable.includes(source));
          const sourceDeadlineMsOfRead = sourceDeadlineMs(allSources);
          for (const source of startSources) {
            first.reading.add(source);
          }
          for (const source of deadSources) {
            run.unavailableReasons.set(source, unavailableReason(source));
            run.sourcesFailed.add(source);
            logSource({ event: 'research_source', researchId: run.researchId, source: lookupSourceOf(source), outcome: 'unavailable', ms: 0, deadlineMs: sourceDeadlineMsOfRead, coalesced: 1 });
          }
          if (startSources.length === 0) return;
          // Only the served sub-calls are asked: a dead source's question is never dispatched to it.
          const served = deadSources.length === 0 ? subs : subs.filter(sub => {
            const source = sourceKindOfKindName(sub.name) ?? named;
            return source === null || !deadSources.includes(source);
          });
          // A single source outliving its own deadline is cut, so one slow connector cannot spend the turn.
          const cut = new AbortController();
          const readSignal = AbortSignal.any([roundSignal, cut.signal]);
          // P5: the cut follows this source's own deadline from the table, never one number for every source.
          const webCall = subs.find(sub => sub.name === WEB_SEARCH_ACTION);
          const askedWebDeadline = webCall === undefined ? undefined : webDeadlineMs(String(webCall.args['query'] ?? ''));
          // #670: the web module's own timer must be the one that fires, so this read's outer cut sits a
          // second above the web budget and still under the answer budget (12 s plus its 2 s slack).
          const readDeadlineMs = askedWebDeadline === undefined ? sourceDeadlineMs(startSources) : Math.max(sourceDeadlineMs(startSources), askedWebDeadline + RESEARCH.webCutSlackMs);
          // #635: the cut is recorded the moment it happens, not when the read settles, so a reply composed
      // while the read is being cut still names it a timeout instead of a source nobody read.
      const cutTimer = schedule(() => {
        if (latencies.has(kind)) return;
        cutKinds.add(kind);
        for (const source of startSources) run.cutShort.add(source);
        cut.abort(new DOMException('Source deadline elapsed', 'TimeoutError'));
      }, Math.max(0, Math.min(readDeadlineMs, batchDeadline - now())));
          // Identical duplicate reads are deduplicated: a read this run already issued is reused, never
          // sent twice, so the connector is asked one question once.
          // DATES-R1 F2b: the knowledge reads this run already issued, so the receipt counts them here too.
          const dedupedKnowledge = served.filter(call => call.name === INTERNAL.knowledgeSearch && run.calls.has(callSignature(call))).length;
          const issued = served.filter(call => !run.calls.has(callSignature(call)));
          if (issued.length === 0) { cutTimer.cancel(); return; }
          for (const call of issued) run.calls.add(callSignature(call));
          const consumeKnowledge = kind === 'knowledge_search' && knowledgePromise !== undefined && !knowledgeConsumed;
          const at = consumeKnowledge ? knowledgeStartedAt : now();
          // Q1-R3(e): one retry for a transient failed sub-call, inside the round deadline.
          const executeWithRetry = async (list: IntentSubCall[]): Promise<IntentSubResult[]> => {
            let out: IntentSubResult[] = [];
            recordShapes(deps, run, list, now);
            try { out = await deps.execute(list, readSignal); } catch { out = []; }
            const failed = list.map((_, index) => index).filter(index => list[index]?.name !== INTERNAL.mailRead && !(out[index]?.ok));
            if (failed.length > 0 && !readSignal.aborted && deadlineAt - now() > 1_000) {
              try {
                const retried = await deps.execute(failed.map(index => list[index]!), readSignal);
                failed.forEach((index, position) => { const result = retried[position]; if (result?.ok) out[index] = result; });
              } catch { /* keep the first attempt's result */ }
            }
            return out;
          };
          const calendarCalls = issued.filter(call => call.name === INTERNAL.calendarList);
          const mailCalls = issued.filter(call => call.name === INTERNAL.mailList);
          const ordinaryCalls = issued.filter(call => call.name !== INTERNAL.calendarList && call.name !== INTERNAL.mailList && call.name !== WEB_SEARCH_ACTION);
          // RUN-R2: the pre-started knowledge read is the round's knowledge read, whatever kind the plan
          // filed it under, so a knowledge question stays exactly one search call.
          const prefetchedKnowledge = knowledgePromise !== undefined && !knowledgeConsumed && !consumeKnowledge && ordinaryCalls.some(call => call.name === INTERNAL.knowledgeSearch);
          const dispatched = prefetchedKnowledge ? ordinaryCalls.filter(call => call.name !== INTERNAL.knowledgeSearch) : ordinaryCalls;
          const webCalls = issued.filter(call => call.name === WEB_SEARCH_ACTION);
          const webResults = async (): Promise<IntentSubResult[]> => {
            if (webCalls.length === 0 || deps.web === undefined) return [];
            run.ops -= webCalls.length;
            return Promise.all(webCalls.map(async (call): Promise<IntentSubResult> => {
              const empty = { key: call.key, name: call.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0 };
              const readStarted = now();
              const outcome = await deps.web!.search({ query: String(call.args['query'] ?? ''), signal: readSignal, deadlineMs: webDeadlineMs(String(call.args['query'] ?? '')) });
              recordWebRead(deps, run, String(call.args['query'] ?? ''), outcome, readStarted, now);
              if (!outcome.ok) { run.unavailableReasons.set('web', webReasonOf(outcome.code, outcome.code === 'web_insufficient' ? outcome.reason : undefined)); return empty; }
              run.web.push(...webSourceCards(outcome.evidence).map(card => ({ ...card, retrievedAt: outcome.evidence.retrievedAt })));
              run.webAttribution.push(...webAttribution(outcome.evidence.searchEntryPoint));
              run.evidence.set('web_search', outcome.evidence.answer);
              const text = webEvidenceText(outcome.evidence);
              return { key: call.key, name: call.name, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 };
            }));
          };
          const calendarResults = async (): Promise<IntentSubResult[]> => {
            if (calendarCalls.length === 0) return [];
            run.ops -= calendarCalls.length;
            for (const call of calendarCalls) {
              const key = JSON.stringify(call.args);
              if (!run.calendar.has(key)) run.calendar.set(key, { args: { ...call.args }, events: new Map(), bindings: [], tokens: new Set(), exhausted: false, failed: false, bodyTruncated: false, unread: 0 });
            }
            await collectCalendar(deps, run, signal, Math.min(readDeadlineMs, deadlineAt - now()), now);
            return calendarCalls.map(call => {
              const read = run.calendar.get(JSON.stringify(call.args));
              const text = read ? [...read.events.values()].map(event => event.line).join('\n') : '';
              return { key: call.key, name: call.name, ok: Boolean(read && (read.events.size > 0 || read.exhausted)), text, originalCharacters: text.length, omittedCharacters: 0, ...(read?.code ? { code: read.code } : {}) };
            });
          };
          const mailResults = async (): Promise<IntentSubResult[]> => {
            if (mailCalls.length === 0) return [];
            run.ops -= mailCalls.length;
            const reads = mailCalls.map(call => mailRead(run, call.args));
            await collectMailWithRetry(deps, run, reads, readSignal, Math.min(readDeadlineMs, deadlineAt - now()), now);
            return mailCalls.map((call, n) => {
              const read = reads[n]!;
              const text = [...read.messages.values()].map(message => message.line).concat(read.plain ? [read.plain] : []).join('\n');
              return { key: call.key, name: call.name, ok: read.messages.size > 0 || Boolean(read.plain) || read.exhausted, text, originalCharacters: text.length, omittedCharacters: 0, ...(read.code ? { code: read.code } : {}) };
            });
          };
          let results: IntentSubResult[];
          if (consumeKnowledge) results = [...(knowledgeConsumed = true, await knowledgePromise!), ...await webResults()];
          else {
            const [ordinary, calendar, mail, web] = await Promise.all([dispatched.length ? executeWithRetry(dispatched) : Promise.resolve([]), calendarResults(), mailResults(), webResults()]);
            const byKey = new Map([...ordinary, ...calendar, ...mail, ...web].map(result => [result.key, result]));
            // Production execute keys include the host call id, so preserve source positions for ordinary results.
            dispatched.forEach((call, n) => { if (ordinary[n]) byKey.set(call.key, ordinary[n]!); });
            if (prefetchedKnowledge) {
              const prefetched = await knowledgePromise!;
              knowledgeConsumed = true;
              for (const call of ordinaryCalls) if (call.name === INTERNAL.knowledgeSearch) byKey.set(call.key, prefetched.find(result => result.key === call.key) ?? prefetched[0]!);
            }
            results = issued.map(call => byKey.get(call.key)).filter((result): result is IntentSubResult => result !== undefined);
          }
          // R6: a source with real text is its own credit; the rest of the round still finishes.
          if (!answeredRound && !cut.signal.aborted && results.some(result => result.ok && result.text.trim())) answeredRound = true;
          // Host-side second hops inside the same run: open the top mails when the question asks what a
          // mail says, and fetch the thread of the top chat hit. ROUTE-1022: knowledge has no second hop,
          // because the search reply already carries the body.
          const second: IntentSubCall[] = [];
          const primaryText = results.filter(result => result.ok).map(result => result.text).join('\n');
          if (served.some(call => call.name === INTERNAL.mailList) && /what|who wrote|say|says|read|content|mean|about/i.test(question)) {
            const ids = [...primaryText.matchAll(/\[id ([A-Za-z0-9_-]+)\]/g)].map(match => match[1]!).slice(0, 2);
            ids.forEach((id, index) => second.push({ key: `mo${index}`, name: INTERNAL.mailRead, args: { id } }));
          }
          // C-CHAT: a person, group or channel read is already the conversation; only a topic search hops to a thread.
          if (kind === 'chat_search' && served.some(call => call.name === INTERNAL.chatSearch)) {
            const id = extractId('chat_search', primaryText);
            if (id) second.push({ key: 'ct', name: 'mattermost_get_thread', args: { post_id: id } });
          }
          const freshSecond = second.filter(call => !run.calls.has(callSignature(call)));
          for (const call of freshSecond) run.calls.add(callSignature(call));
          if (freshSecond.length) {
            const extra = await executeWithRetry(freshSecond);
            results.push(...extra);
          }
          latencies.set(kind, now() - at);
          cutTimer.cancel();
          const key = `${kind}:${served.map(sub => JSON.stringify(sub.args)).join(',')}`;
          // Outcome 2: the read is credited per source. `brief` fans out over several sources, so each
          // one is credited and delivered on its own instead of the whole batch going uncredited.
          const parts = creditableSources(kind, results);
          for (const [index, part] of parts.entries()) {
            const block = shapeBlock(shapeKindOf(part.source, kind), part.results, deps.timeZone, { newestFirst: lastMeetingQuestion(question) });
            // E5: the mail read's own queries, for the receipt's shape and the reply's "how I searched".
            const mailInfo = part.source !== 'mail' || mailCalls.length === 0 ? undefined : mailQueryInfo(mailRead(run, mailCalls[0]!.args));
            run.ledger.set(parts.length === 1 ? key : `${key}#${part.source ?? index}`, { kind, source: part.source, summary: block.text, lines: block.lines, total: block.total, ...(part.results.length > 0 && part.results.every(result => result.ok && result.hostEvidence?.kind === 'remote-body') ? { bodyOnly: true } : {}) });
            if (part.source === null) continue;
            if (part.results.some(result => result.ok && result.text.trim())) {
              run.sourcesDone.add(part.source); run.sourcesFailed.delete(part.source); run.emptySearches.delete(part.source);
            } else if (classifiedProjectionText(part.results) !== undefined) {
              // LOGS.md L-01: the tool layer's own code says this read is a classified failure, and the line
              // it carried is the helper's refusal, not an answer, so the source is failed and the reply speaks it.
              run.failureLines.set(part.source, classifiedProjectionText(part.results)!);
              run.sourcesFailed.add(part.source); run.sourcesDone.delete(part.source); run.emptySearches.delete(part.source);
            } else if (part.results.some(result => result.ok)) {
              // The connector answered and matched nothing: that is a search, not an outage.
              run.sourcesDone.add(part.source); run.sourcesFailed.delete(part.source);
              // #572: the attention read names its window, so an empty digest is a window, never a bare no.
              run.emptySearches.set(part.source, served.some(sub => sub.name === INTERNAL.chatAttention)
                ? ` in the last ${TRIAGE_DAYS} days`
                : mailInfo === undefined ? queryShapeOf(served) : mailEmptyPhrase(mailInfo, queryShapeOf(served)));
            } else if (!run.sourcesDone.has(part.source)) {
              // #635: a read this turn cut at its own budget is a timeout, never a source that failed.
              if (cutKinds.has(kind)) run.cutShort.add(part.source); else run.sourcesFailed.add(part.source);
              // #637: a channel the chat connector does not know keeps its own code, so the reply names
              // the unknown channel instead of a chat that could not be reached.
              const missCode = part.source === 'chat' ? channelMissCode(part.results) : undefined;
              if (missCode !== undefined) {
                run.unavailableReasons.set('chat', missCode);
                // #663: the refusal names the channels closest to the one the ask meant, voiced by the reply.
                run.chatChannelClosest = channelClosestNames(part.results.find(result => !result.ok)?.code);
                const words = channelWordsOf(served);
                if (words !== undefined) run.chatChannel ??= words;
              }
              // #651 FAILREASON-R1: a read the connector cut at its own budget keeps its timeout code, so
              // the reply says the source was not read in time instead of a failure with no stated reason.
              const timedOut = part.results.find(result => !result.ok && result.code !== undefined && TIMED_OUT.has(result.code))?.code;
              if (timedOut !== undefined) run.unavailableReasons.set(part.source, timedOut);
              // F17/R3: a chat triage ask rides the connector's own composite. Its reason is the failure
              // the sub-call really returned: only the two availability codes read as not granted, and a
              // credential, timeout or transport failure keeps its own closed reason.
              if (part.source === 'chat' && served.some(sub => sub.name === INTERNAL.chatAttention)) {
                run.unavailableReasons.set('chat', chatAttentionReason(part.results));
              }
            }
            // P5 outcome 4: one receipt per source read, with the deadline it was actually given.
            logSource({
              event: 'research_source', researchId: run.researchId, source: lookupSourceOf(part.source),
              outcome: block.lines.length > 0 ? 'ok' : cut.signal.aborted ? 'timeout' : part.results.some(result => !result.ok) || run.failureLines.has(part.source) ? 'failed' : 'empty',
              // K8: a prime knowledge read reports its own dispatch span, never the selector wait before it,
              // whether this round pulled it through the answer cut or through the prefetched read.
              ms: (consumeKnowledge || prefetchedKnowledge) && knowledgeEndedAt > 0 ? Math.max(0, knowledgeEndedAt - knowledgeStartedAt) : Math.max(0, now() - at),
              deadlineMs: askedWebDeadline ?? sourceDeadlineMsOfRead, coalesced: 1,
              ...(part.source === 'knowledge' ? { knowledge: knowledgeReceipt(block.lines, run.chatDate ?? 'none', served.find(call => call.name === INTERNAL.knowledgeSearch), { droppedFilters: run.droppedDayFilters, deduped: dedupedKnowledge }) } : {}),
              ...(part.source === 'chat' ? chatReceiptField(served, part.results) : {}),
              ...mailReceiptField(mailInfo),
            });
            // R6: this source settled after the call had already answered, so what it found is handed over
            // once, and only if the first reply did not already say it.
            first.reading.delete(part.source);
            first.wake?.();
            lateFindingsOf(deps, first, run.researchId, part.source, Math.max(0, now() - at), block.lines, part.results.some(result => result.ok), run.runId, signal.aborted || run.cancelled || run.stopped);
          }
          // A source that answered counts as read, so an empty result is never re-offered as pending.
          if (results.some(result => result.ok)) run.readKinds.add(kind);
          const id = extractId(kind, results.filter(result => result.ok).map(result => result.text).join('\n'));
          if (id) run.evidence.set(kind, id);
          // Log the primary sub-calls and the host-side second hops (hydrate/open/thread) together:
          // `results` is `[...issued, ...freshSecond]`, so position is the stable key.
          for (const [index, sub] of [...issued, ...freshSecond].entries()) {
            const result = results[index];
            const raw = sub.args['query'] ?? sub.args['q'];
            const calText = result?.text ?? '';
            const partial = /\[calendar read incomplete: (\d+) calendars? not read\]/.exec(calText);
            logSubcall({
              event: 'research_subcall', researchId: run.researchId, ...callKeyOf(run), kind, tool: sub.name,
              ok: result?.ok ?? false, ...(result !== undefined && !result.ok && result.code !== undefined ? { errorCode: result.code } : {}),
              items: result ? itemLines(result.text).length : 0,
              rawBytes: result?.originalCharacters ?? 0, keptBytes: result?.text.length ?? 0,
              queryChars: typeof raw === 'string' ? raw.length : 0, queryAuthor: selectionAuthor,
              ...(kind === 'calendar_window' ? { window: windowKind(action?.window ?? 'today'), ...windowDates(action?.window ?? 'today', now(), deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) } : {}),
              ...(partial ? { unread: Number(partial[1]) } : {}),
            });
          }
        });

        // RD: the round ends when the first sufficient source answers, and the readers still working are cut.
        // R6: no reader is cut because another answered. The call's first answer point is its own race, and
        // every reader here finishes or reaches its own deadline, so a late block has something true to say.
        await Promise.all(reads);
        if (answeredRound) stopReason = 'answered';
        // The answer bound is a cut like any other: the read it stopped is named, and the turn ends partial.
        if (answerCut.signal.aborted) for (const kind of readStarted) if (!latencies.has(kind)) cutKinds.add(kind);
        if (cutKinds.size > 0) sawCut = true;

        for (const kind of batch) {
          const source = sourceKindOf(kind) ?? 'knowledge', skipped = cutKinds.has(kind) || !latencies.has(kind);
          sourceLog.push({ kind: source, disposition: skipped ? 'skipped' : 'completed', latencyMs: latencies.get(kind) ?? 0, ...(skipped ? { reason: skipReasonOf(run.unavailableReasons.get(source), run.unavailableReasons.has(source) ? 'unavailable' : 'timeout') } : {}) });
        }
        // A source that ran out of its own deadline ends the turn as an honest partial: it is named
        // unchecked, and the model can ask to continue instead of another round silently spending time.
        if (cutKinds.size > 0 && !answeredRound) { stopReason = 'deadline'; break; }
        if (signal.aborted) { run.stopped = true; stopReason = 'cancelled'; break; }
        if (run.cancelled || run.stopped) { stopReason = 'cancelled'; break; }
      }
      run.rounds = round;
      notify({ researchId: run.researchId, phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: [], elapsedMs: now() - started });
      if (stopReason === 'deadline' || stopReason === 'ops_exhausted' || stopReason === 'answered') break;
      // A selector timeout or an invalid answer falls back to O1's fixed recipe for one round only.
      if (usedFallbackThisRound) { stopReason = 'fallback'; break; }

      // Value-of-information: run one more round only when it is worth the wait.
      if (round >= run.maxRounds) { stopReason = 'rounds_exhausted'; break; }
      const nextKinds = offerableCandidates(configured, [...run.readKinds]).filter(kind => !chosen.includes(kind));
      if (nextKinds.length === 0) { stopReason = 'no_candidates'; break; }
      const pUseful = pUsefulOf(nextKinds.map(kind => selection.pUseful[kind] ?? 0.3));
      const subsetP50Ms = Math.max(...nextKinds.map(kind => p50SecondsOf(sourceKindOf(kind) ?? 'knowledge'))) * 1_000;
      if (!worthContinuing({ pUseful, questionClass: run.questionClass, elapsedMs: now() - started, subsetP50Ms, deadlineMs: run.deadlineMs })) { stopReason = 'voi_stop'; break; }
    }

    run.ended = true;
    elapsedMs = now() - started;
    status = stopReason === 'cancelled' || run.stopped ? 'stopped' : (run.readKinds.size > 0 ? (elapsedMs >= run.deadlineMs || sawCut ? 'partial' : 'answered') : 'partial');
    // K8b: a read still in flight keeps the answer partial, and the model may ask for it again.
    if (status === 'answered' && run.pending.size > 0) status = 'partial';
    const canContinue = run.pending.size > 0 || (!run.stopped && !run.cancelled && run.rounds < run.maxRounds && configured.some(source => !run.sourcesDone.has(source) && !run.sourcesFailed.has(source)));
    notify({ researchId: run.researchId, phase: 'done', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs });
    reply = buildReply(run, status, configured, canContinue, limit);
    driver ??= 'single-source-hint';
    return reply;
  } catch (error) {
    // A throw inside the loop is a failed run, and the closed code keeps the exception text out.
    runFailed = true;
    throw error;
  } finally {
    heartbeat.cancel();
    answerTimer.cancel();
    if (runFailed) elapsedMs = Math.max(0, now() - started);
    const findings = Array.isArray(reply?.['findings']) ? reply['findings'] as { text?: string }[] : [];
    const replyBytes = JSON.stringify(reply ?? {}).length;
    // LAT-1023: the cap and the trim are the two ways an answer comes back short, each counted by the helper.
    // A run that threw before it selected anything names no driver: the key is omitted, never passed undefined,
    // because the host log refuses a line whose driver is not one of the four.
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, ...briefPlanField(run), rounds: run.rounds, perRound, stopReason: runFailed ? 'failed' : stopReason, status: runFailed ? 'failed' : status, ops: run.ops, sources: sourceLog, elapsedMs, deadAirMs: worstGapMs, selectorMs, fallbackUsed, replyBytes, ...receiptCounts(reply, run, configured), ...(driver === undefined ? {} : { driver }), unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: reply?.['canContinue'] === true, findingChars: findings.map(finding => (finding.text ?? '').length), bodyReplies: run.bodyReplies, metaStartAsContinue: run.metaStartAsContinue, supersededAborts: run.supersededAborts });
  }
}

export function newResearchId(): string { return randomUUID(); }

/** A new research call while another is pending answers the old call with this tiny stub at once. */
export function supersededStub(researchId: string, configured: readonly SourceKind[]): JsonObject {
  return { researchId, status: 'partial', findings: [], unchecked: [...configured], canContinue: true, superseded: true };
}

/** What is known now for a researchId, without waiting on the loop. */
/**
 * C-DEPTH item 5 (W10-R2 light C): the state a call keeps about the research payload it holds in the provider
 * conversation. The host counts what it sent, and a rebuild is due when that count passes the threshold.
 */
export interface ResearchRetention {
  /** Characters of research answer this call has put in the provider conversation since the last rebuild. */
  retainedChars: number;
  /** Rebuilds this call has already run, so the counter can be read honestly in a log. */
  rebuilds: number;
}

/**
 * C-DEPTH item 5: whether the retained payload has passed the rebuild threshold. W10-R20: the host may
 * inject the threshold, so a replay drives a rebuild at a size a call can reach; the shipped constant
 * stays the default and the only value production uses.
 */
export function researchRebuildDue(retention: ResearchRetention, thresholdChars: number = RESEARCH.rebuildThresholdChars): boolean {
  return retention.retainedChars > thresholdChars;
}

/** C-DEPTH item 5: what the call retains after one more research answer is sent. */
export function retainedAfterSend(retention: ResearchRetention, answerChars: number): ResearchRetention {
  return { ...retention, retainedChars: retention.retainedChars + Math.max(0, answerChars) };
}

/** C-DEPTH item 5: the call's own facts a rebuild must never interrupt, and the ones it may wait for. */
export interface ResearchBoundary {
  /** The assistant is speaking: a rebuild here would cut the answer. */
  assistantAudioStreaming: boolean;
  /** A response is pending, so the raw output is still being answered from. */
  responsePending: boolean;
  /** The owner barged in: the rebuild is deferred until the new turn settles. */
  bargeIn: boolean;
  /** A tool operation is in flight, so its output is not on the wire yet. */
  toolInFlight: boolean;
}

/** C-DEPTH item 5: the safe boundary. Nothing is replaced while any of these holds. */
export function researchRebuildAllowed(boundary: ResearchBoundary): boolean {
  return !boundary.assistantAudioStreaming && !boundary.responsePending && !boundary.bargeIn && !boundary.toolInFlight;
}

/**
 * C-DEPTH item 5 (W10-R15 P2): one rebuild decision. A deferral is a deferral: the count and the seed are
 * handed back untouched so the next boundary can spend them, and only the branch that really rebuilds resets.
 */
export type ResearchRebuildStep =
  | { action: 'defer'; retention: ResearchRetention; seedChars: number }
  | { action: 'rebuild'; retention: ResearchRetention; seedChars: number };

export function researchRebuildStep(
  retention: ResearchRetention, seedChars: number, boundary: ResearchBoundary,
  remainingMs: number, idleMs: number,
): ResearchRebuildStep {
  if (!researchRebuildAllowed(boundary)) return { action: 'defer', retention, seedChars };
  if (remainingMs <= 0 || idleMs <= 0) return { action: 'defer', retention, seedChars };
  return { action: 'rebuild', retention: { retainedChars: 0, rebuilds: retention.rebuilds + 1 }, seedChars };
}

/** C-DEPTH item 5: the ledger a rebuild seeds, built from the run's own evidence and never from a model call. */
export interface LedgerInput {
  question: string;
  findings: readonly { source?: string; text?: string }[];
  cursors: readonly string[];
}

/**
 * C-DEPTH item 5: one rolling extractive ledger, at most `ledgerChars`. It carries the entities the owner
 * named, a source id line per source with the dates it read, the factual excerpt lines that survived, the
 * gaps it could not close, and the cursors that recover the original bodies for the rest of the call.
 */
export function researchLedgerOf(input: LedgerInput): string {
  const evidence = input.findings.map(finding => finding.text ?? '').join('\n');
  const asked = requestedEntities(input.question);
  const covered = asked.filter(name => evidence.includes(name));
  const missing = asked.filter(name => !evidence.includes(name));
  const heldIds = [...new Set(input.findings
    .flatMap(finding => (finding.text ?? '').split('\n').map(hitIdOf).filter((id): id is string => id !== undefined)))];
  const perSource = input.findings
    .filter(finding => typeof finding.source === 'string')
    .map(finding => {
      const lines = (finding.text ?? '').split('\n').filter(line => line.trim() !== '');
      const ids = lines.map(hitIdOf).filter((id): id is string => id !== undefined);
      const dates = [...new Set(lines.join(' ').match(/\d{4}-\d{2}-\d{2}/gu) ?? [])];
      return `${finding.source}: ${lines.length} held${ids.length === 0 ? '' : `, ids ${ids.join(',')}`}${dates.length === 0 ? '' : `, dates ${dates.join(',')}`}`;
    });
  const excerpts = input.findings
    .map(finding => (finding.text ?? '').split('\n').find(line => line.trim() !== '' && hitIdOf(line) === undefined && !FINDING_HEAD.test(line)))
    .filter((line): line is string => line !== undefined && line.trim() !== '')
    .map(line => line.trim().slice(0, 200));
  const parts = [
    `evidence ledger (extractive, ${covered.length} of ${asked.length} asked entities covered)`,
    asked.length === 0 ? 'entities: none named' : `entities: ${asked.join(', ')}`,
    // W10-R21: every hit id the run read is in the ledger whatever the finding declares, so a follow-up
    // can recover that detail through get_insight instead of re-reading from the top.
    ...(heldIds.length === 0 ? [] : [`ids: ${heldIds.join(', ')}`]),
    ...perSource,
    ...excerpts,
    missing.length === 0 ? '' : `gaps: no evidence for ${missing.join(', ')}`,
    input.cursors.length === 0 ? '' : `cursors: ${input.cursors.join(', ')}`,
    'the original bodies stay readable by those cursors for the rest of the call',
  ].filter(part => part !== '');
  const text = parts.join('\n');
  return text.length <= RESEARCH.ledgerChars ? text : `${text.slice(0, RESEARCH.ledgerChars - 1)}\u2026`;
}

export function knownReply(ledger: ResearchLedger, researchId: string, configured: readonly SourceKind[], status: 'answered' | 'partial' | 'stopped' | 'unavailable' = 'stopped', limit = RESEARCH.budgets.default): JsonObject {
  const run = ledger.find(researchId);
  if (!run) return { researchId, status, findings: [], unchecked: [...configured], canContinue: false };
  return buildReply(run, status, configured, false, limit);
}

interface Deferred { promise: Promise<JsonObject>; resolve: (reply: JsonObject) => void }
function startSignature(call: ResearchCall): string {
  return JSON.stringify([call.question?.trim() ?? '', call.sources?.trim() ?? '', call.direction?.trim() ?? '', normalizeLookups(call.lookups)]);
}
/**
 * E7: the same intent, ignoring how it was worded. The question normalized and the set of sources it
 * names: one owner question researched once, whatever lookups a model happens to attach to it.
 */
function coalesceKey(call: ResearchCall): string {
  const sources = new Set<string>();
  if (call.sources !== undefined && call.sources.trim() !== '') sources.add(call.sources.trim().toLowerCase());
  for (const lookup of normalizeLookups(call.lookups)) sources.add(lookup.source);
  const question = (call.question ?? '').toLowerCase().replace(/\s+/gu, ' ').replace(/[\s?.!,;:]+$/u, '').trim();
  return JSON.stringify([question, [...sources].sort()]);
}
/** ROUTE-1022 (#526): the words a spoken question carries no meaning in, so two tellings match. */
const QUESTION_STOP_WORDS = new Set(['what', 'whats', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'on', 'in', 'of', 'for', 'to', 'at', 'my', 'me', 'i', 'do', 'does', 'did', 'have', 'has', 'any', 'and', 'with', 'about', 'right', 'now', 'please', 'can', 'you', 'tell', 'show', 'give', 'check', 'there', 'it', 'this', 'that']);

/** The content words of a spoken question, lowercased and stripped of punctuation. */
function questionTerms(question: string): Set<string> {
  const words = question.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  return new Set(words.filter(word => !QUESTION_STOP_WORDS.has(word)));
}

/** K8a: the words a model says to ask after a run it already started, never a new question. */
const META_ONLY_WORDS = new Set(['wait', 'waiting', 'find', 'finding', 'findings', 'found', 'result', 'results', 'answer', 'answers', 'complete', 'completed', 'more', 'ready', 'pending', 'hold', 'holding', 'still', 'reading', 'look', 'looking', 'give', 'tell', 'show', 'let', 'know', 'see', 'ok', 'okay', 'yes', 'then', 'so', 'just', 'now', 'again', 'has', 'have', 'got', 'next']);
function metaOnlyQuestion(question: string): boolean {
  const terms = [...questionTerms(question)];
  return terms.every(term => META_ONLY_WORDS.has(term));
}

/**
 * ROUTE-1022 (#526): the same owner request told twice. A start for a question whose content words
 * are the ones the run in flight is already reading joins that run instead of spending a cancel on it.
 * A genuinely new question still supersedes, and the turn window bounds the join.
 */
function sameQuestion(entry: ActiveRun, call: ResearchCall, nowMs: number): boolean {
  if (entry.question === undefined || entry.at === undefined || nowMs - entry.at > RESEARCH.coalesceWindowMs) return false;
  const mine = questionTerms(entry.question);
  const theirs = questionTerms(call.question ?? '');
  if (mine.size === 0 || theirs.size === 0) return false;
  const shared = [...theirs].filter(word => mine.has(word)).length;
  return shared / Math.max(mine.size, theirs.size) >= 0.6;
}

/**
 * W12/F1: the sources this session can reach right now, as sources and their reachability. A run
 * answered when a source was down is not the same research once that source's grant publishes.
 */
function reachableNow(deps: ResearchDeps): string {
  const configured = [...new Set(deps.configuredNow?.() ?? deps.configured)].sort();
  const down = [...new Set((deps.unavailableNow?.() ?? []).map(entry => typeof entry === 'string' ? entry : entry.source))].sort();
  return JSON.stringify([configured, down]);
}
type ActiveRun = {
  signature?: string;
  key?: string;
  /** ROUTE-1022 (#526): the question as spoken and when the run started, for a repeated start to join. */
  question?: string;
  at?: number;
  /** W12/F1: the reachable set when this run started; a start may only join a run with the same set. */
  reachable?: string;
  superseded: boolean; awaiter: Deferred;
  /** R6/M2: the readers a first answer left running; the run is over when this settles. */
  reading?: Promise<void>;
};
function deferred(): Deferred {
  let resolve!: (reply: JsonObject) => void;
  const promise = new Promise<JsonObject>(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * The per-session research call scheduler (R1-R1, R1-R3, wire facts W1). One run exists per researchId.
 * A new call while a run is pending answers the old call at once with a superseded stub, keeps the
 * run going, and answers the new call with the merged result: `continue` runs on with a fresh budget
 * reusing the ledger, `stop` returns what is known now. A continue or stop with a missing
 * id applies to the single pending run; an explicit id never retargets another run. Stop is never inferred from transcript text.
 */
export class ResearchScheduler {
  readonly #deps: ResearchDeps;
  #active = new Map<string, ActiveRun>();
  /** E7: the live turn window: the run each coalesce key last answered, and when. */
  #recent = new Map<string, { id: string; at: number; reply: JsonObject; reachable: string }>();
  /**
   * #664: how many research calls each delegation has made in the turn window. A delegation is the owner's
   * one ask, which the scheduler sees as the same coalesce key: a keyword, a lookup batch or a reworded
   * question with the same sources is the same delegation, and the window is what ends it.
   */
  #delegation = new Map<string, { at: number; calls: number; id?: string }>();
  /** E8: this live session's completed calendar reads and its calendar list, shared by every run it starts. */
  #memo: ResearchMemo = { calendar: new Map() };
  constructor(deps: ResearchDeps) { this.#deps = deps; }

  call(call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
    if (call.action === 'start') {
      // W12/F1: joining is only safe while the reachable set is the one the run started with, so a
      // source whose grant publishes after the call started is read by the next call instead of being
      // reported unavailable from the run it never joined.
      const reachable = reachableNow(this.#deps);
      const inflight = this.#resolveTarget(undefined);
      if (inflight !== undefined && inflight.entry.reachable === reachable
        && (inflight.entry.signature === startSignature(call) || inflight.entry.key === coalesceKey(call) || sameQuestion(inflight.entry, call, this.#deps.now()))) {
        this.#deps.logJoined?.(inflight.id, 'join');
        return inflight.entry.awaiter.promise;
      }
      // E7: the same question and sources, answered moments ago in this turn, is the same research.
      const recent = this.#recent.get(coalesceKey(call));
      // #664: a delegation reads at most three times. The fourth call was the backend re-asking one lookup
      // eight times in 14 s, so it is told to answer the owner with what it holds and it reads nothing.
      const key = coalesceKey(call);
      const at = this.#deps.now();
      const spent = this.#delegation.get(key);
      const calls = spent === undefined || at - spent.at > RESEARCH.coalesceWindowMs ? 1 : spent.calls + 1;
      this.#delegation.set(key, { at, calls });
      if (calls > RESEARCH.delegationCeiling) {
        const answered = recent?.id ?? spent?.id ?? '';
        this.#deps.logJoined?.(answered, 'ceiling');
        return Promise.resolve({ researchId: answered, status: 'answered', repeat: true, canContinue: false, findings: [], note: RESEARCH.ceilingNote });
      }
      // Behaviour 3: an answer that named a source unavailable is not reusable, so the key is the one
      // buildReply publishes the reasons under, and a recovered source is read again instead.
      if (recent !== undefined && recent.reachable === reachable && recent.reply['unavailable'] === undefined
        && this.#deps.now() - recent.at <= RESEARCH.coalesceWindowMs) {
        // #663: the answer is already in the turn window, so the receipt hands it back and sends the model to
        // the owner instead of handing over the same findings a third time.
        this.#deps.logJoined?.(recent.id, 'recent');
        return Promise.resolve({ researchId: recent.id, status: 'answered', repeat: true, canContinue: false, findings: [], note: RESEARCH.repeatNote });
      }
      for (const [id, entry] of this.#active) {
        this.#deps.ledger.stop(id);
        entry.superseded = true;
        entry.awaiter.resolve({ researchId: id, status: 'stopped', findings: [], canContinue: false, superseded: true });
      }
      this.#active.clear();
      // Z1: the host mints every run id. A researchId the model supplies on a start is ignored, because
      // a model-chosen id that fails the host log's closed id rule takes the run's receipts with it.
      const id = newResearchId();
      for (const [key, entry] of this.#recent) if (this.#deps.now() - entry.at > RESEARCH.coalesceWindowMs) this.#recent.delete(key);
      for (const [entry, spend] of this.#delegation) if (this.#deps.now() - spend.at > RESEARCH.coalesceWindowMs) this.#delegation.delete(entry);
      this.#delegation.set(key, { at, calls, id });
      this.#deps.logJoined?.(id, 'start');
      return this.#drive({ ...call, researchId: id }, signal, id, reachable);
    }
    // An explicit unknown id never selects another run.
    if (call.researchId !== undefined
      && !this.#active.has(call.researchId) && this.#deps.ledger.find(call.researchId) === undefined) {
      return Promise.resolve({ error: 'unknown_research_run' });
    }
    // A missing id may resolve the single pending run; explicit ids are exact.
    const target = this.#resolveTarget(call.researchId);
    if (target !== undefined) {
      // Answer the pending call at once, then take the run over.
      target.entry.superseded = true;
      target.entry.awaiter.resolve(supersededStub(target.id, this.#deps.configured));
      if (call.action === 'stop') {
        this.#deps.ledger.stop(target.id);
        this.#active.delete(target.id);
        this.#deps.emit({ researchId: target.id, phase: 'stopped', sourcesDone: [], sourcesPending: [], elapsedMs: 0 });
        this.#deps.logJoined?.(target.id, 'status');
        return Promise.resolve(knownReply(this.#deps.ledger, target.id, this.#deps.configured));
      }
      // continue: stop the old loop, run on with a fresh budget reusing the ledger.
      this.#deps.logJoined?.(target.id, 'continue');
      return this.#drive({ ...call, action: 'continue', researchId: target.id }, signal, target.id);
    }
    // Zero or several pending runs: current behaviour.
    if (call.action === 'stop') {
      const run = this.#deps.ledger.stop(call.researchId);
      const id = run?.researchId ?? call.researchId ?? '';
      this.#deps.logJoined?.(id, 'status');
      if (run) this.#deps.emit({ researchId: id, phase: 'stopped', sourcesDone: [...run.sourcesDone], sourcesPending: [], elapsedMs: Math.max(0, this.#deps.now() - run.startedAt) });
      return Promise.resolve(knownReply(this.#deps.ledger, id, this.#deps.configured));
    }
    const id = call.researchId ?? newResearchId();
    this.#deps.logJoined?.(id, 'continue');
    return this.#drive({ ...call, researchId: id }, signal, id);
  }

  /** The run a continue or stop applies to: the named run, or the only pending run (R1-R3). */
  #resolveTarget(researchId: string | undefined): { id: string; entry: ActiveRun } | undefined {
    if (researchId !== undefined) { const entry = this.#active.get(researchId); return entry === undefined ? undefined : { id: researchId, entry }; }
    if (this.#active.size === 1) { const [id, entry] = [...this.#active.entries()][0]!; return { id, entry }; }
    return undefined;
  }

  #drive(call: ResearchCall, signal: AbortSignal, id: string, reachable?: string): Promise<JsonObject> {
    const awaiter = deferred();
    const entry: ActiveRun = { superseded: false, awaiter, ...(call.action === 'start' ? { signature: startSignature(call), key: coalesceKey(call), reachable: reachable ?? reachableNow(this.#deps), question: call.question ?? '', at: this.#deps.now() } : {}) };
    this.#active.set(id, entry);
    // R6/M2: a call that answered ahead of its readers is still the run those readers belong to, so stop
    // and continue must find it. The entry leaves the active set only when the run itself has ended.
    const deps: ResearchDeps = { ...this.#deps, memo: this.#memo, background: done => {
      entry.reading = done;
      this.#deps.background?.(done);
    } };
    const settle = (): void => { if (this.#active.get(id) === entry) this.#active.delete(id); };
    runResearch(deps, call, signal).then(reply => {
      if (call.action === 'start') this.#recent.set(coalesceKey(call), { id, at: this.#deps.now(), reply, reachable: reachable ?? reachableNow(this.#deps) });
      if (!entry.superseded) awaiter.resolve(reply);
      if (entry.reading === undefined) settle(); else void entry.reading.then(settle, settle);
    }).catch(() => {
      if (!entry.superseded) awaiter.resolve({ error: 'research_failed' });
      if (entry.reading === undefined) settle(); else void entry.reading.then(settle, settle);
    });
    return awaiter.promise;
  }
}

// ---- C-LIVE (W5): owner-turn admission, the bounded operation and per-source coverage --------------------------

/**
 * R1 (owner order 2026-10-26): research patience, named once. A call waits for the sources its question needs
 * up to `deadlineMs` (15 s) instead of the 6 s that answered call 01c4bd89 while its web read was still
 * running; at `stillSearchingMs` (10 s) an owner still waiting hears one short "still searching" line; and
 * `hardStopMs` (20 s) is the absolute bound, where the call answers with what it has and names the source that
 * did not return in time. A page starts only when its estimate (this read's last page, else the per-source p50)
 * finishes `returnReserveMs` before the patience budget, and `deadlineMs` plus `hostGraceMs` is exactly
 * `hardStopMs`, so the host's own settle bound and the call's own are the same number written once.
 */
export const RESEARCH_OPERATION = Object.freeze({
  deadlineMs: 15_000,
  stillSearchingMs: 10_000,
  hardStopMs: 20_000,
  returnReserveMs: 500,
  hostGraceMs: 5_000,
  pageEstimateMs: Object.freeze({ mail: 2_000, calendar: 1_400 }),
});

/** C-LIVE behaviour 1: the reply to a research call no owner turn admitted. It reaches no source. */
export const ADMISSION_BLOCKED: Readonly<JsonObject> = Object.freeze({
  status: 'blocked', reason: 'owner_turn_required', directive: 'answer_existing_result', retry_without_new_owner_turn: false,
});
export const ADMISSION_BLOCK_REASONS = ['no_owner_turn', 'turn_spent', 'no_turn_since_result'] as const;
export type AdmissionBlockReason = typeof ADMISSION_BLOCK_REASONS[number];
export type AdmissionVerdict = { admitted: true } | { admitted: false; reason: AdmissionBlockReason };

/**
 * C-LIVE behaviour 1: each finalized owner turn grants one research operation. `start` or an admitted `continue`
 * spends it; `continue` also needs an owner turn after the last delivered result; `stop` is always allowed. Only
 * the owner's own finalized words call `ownerTurn`: transcripts in progress, her audio, host nudges, rebuilds and
 * tool results grant nothing. One instance lives for the whole live session, across provider generations.
 */
export class ResearchAdmission {
  #turns = 0;
  #grant: number | undefined;
  #deliveredAt: number | undefined;
  /** R6: the one own-results continue this session may spend without a new owner turn. */
  #ownResults = false;
  ownerTurn(): void { this.#turns += 1; this.#grant = this.#turns; }
  /**
   * R6: `ownResults` is the model asking for the pending results of the research this same turn started, while that
   * research still has sources reading. That one continue spends no owner turn, and a second one is refused.
   */
  admit(action: ResearchAction, ownResults = false): AdmissionVerdict {
    if (action === 'stop') return { admitted: true };
    if (ownResults && action === 'continue' && !this.#ownResults) { this.#ownResults = true; return { admitted: true }; }
    if (this.#turns === 0) return { admitted: false, reason: 'no_owner_turn' };
    if (this.#grant !== this.#turns) return { admitted: false, reason: 'turn_spent' };
    if (action === 'continue' && this.#deliveredAt !== undefined && this.#turns <= this.#deliveredAt) return { admitted: false, reason: 'no_turn_since_result' };
    this.#grant = undefined;
    return { admitted: true };
  }
  /** An admitted research result was handed to the model. */
  delivered(): void { this.#deliveredAt = this.#turns; }
}

/** C-LIVE behaviour 2: the reads whose next page can still finish before the operation must answer. */
function boundedPages<T extends { lastPageMs?: number; boundStop?: boolean }>(run: RunState, source: 'mail' | 'calendar', reads: readonly T[], nowMs: number): T[] {
  if (run.operationDeadlineAt === undefined) return [...reads];
  // R1/R3: an operation may run to the hard stop, but no new page starts that cannot finish inside the patience
  // budget, so the extra grace only serves a page already in flight.
  const patienceAt = Math.min(run.operationDeadlineAt, run.startedAt + RESEARCH_OPERATION.deadlineMs);
  const end = patienceAt - RESEARCH_OPERATION.returnReserveMs;
  return reads.filter(read => {
    const fits = nowMs + (read.lastPageMs ?? RESEARCH_OPERATION.pageEstimateMs[source]) <= end;
    if (!fits) read.boundStop = true;
    return fits;
  });
}

type CoverageStop = 'exhausted' | 'deadline' | 'page_failed' | 'failed' | 'page_cap' | 'page_limit' | 'enough_for_answer' | 'reply_budget' | 'cancelled' | 'not_read';

/** The rows ride the reply only when a source has a gap to name. */
function coverageRows(rows: JsonObject[]): { sourceCoverage?: JsonObject[] } { return rows.length === 0 ? {} : { sourceCoverage: rows }; }

/** How many lines of one source the reply the model hears actually carries. */
function representedOf(findings: readonly FindingLike[], source: SourceKind): number {
  const text = findings.find(entry => entry.source === source && typeof entry.text === 'string')?.text ?? '';
  const head = FINDING_HEAD.exec(text);
  return head === null ? 0 : Number(head[1]);
}

/** Totals reported page by page: one value is a known total, disagreeing values are a changing one. */
function reportedTotal(totals: readonly number[]): number | 'changing' | undefined {
  const distinct = [...new Set(totals)];
  return distinct.length === 0 ? undefined : distinct.length === 1 ? distinct[0]! : 'changing';
}

/**
 * C-LIVE behaviour 2: what each source of this operation really covered, apart from the prose. `examined` is the
 * distinct records read, deduplicated across pages; `total` is known only when the source reported it or was read
 * to its end, `unknown` otherwise, and `changing` when its pages disagreed; `matches` is what matched the query;
 * `represented` is what this reply carries. Per-page totals are never summed.
 */
export function operationCoverage(run: RunState, findings: readonly FindingLike[]): JsonObject[] {
  const closed = run.cancelled || run.stopped;
  const touched = new Set<SourceKind>([...run.route, ...run.sourcesDone, ...run.sourcesFailed, ...run.pending, ...(run.reading ?? []), ...run.emptySearches.keys(), ...run.cutShort]);
  if (run.mail.size > 0) touched.add('mail');
  if (run.calendar.size > 0) touched.add('calendar');
  const rows: JsonObject[] = [];
  for (const source of SOURCE_ORDER) {
    if (!touched.has(source)) continue;
    const represented = representedOf(findings, source);
    let examined = 0;
    let total: number | 'unknown' | 'changing' = 'unknown';
    let matches: number | 'unknown' = 'unknown';
    let readComplete = false;
    let stop: CoverageStop;
    let upstream = false;
    if (source === 'mail' && run.mail.size > 0) {
      const reads = [...run.mail.values()];
      examined = mailMessages(run).size;
      matches = examined;
      readComplete = reads.every(read => read.exhausted && !read.failed);
      upstream = reads.some(read => !read.exhausted && !read.failed);
      const reported = reportedTotal(reads.flatMap(read => read.pageTotals ?? []));
      total = reported === 'changing' ? 'changing' : readComplete ? examined : reported ?? 'unknown';
      stop = run.pending.has('mail') || run.cutShort.has('mail') || reads.some(read => read.inflight === true || (read.boundStop === true && !read.exhausted)) ? 'deadline'
        : reads.some(read => read.failed) ? (examined > 0 ? 'page_failed' : 'failed')
          : readComplete ? 'exhausted'
            : reads.some(read => read.pages >= RESEARCH.mailPageCap) ? 'page_cap' : 'enough_for_answer';
    } else if (source === 'calendar' && run.calendar.size > 0) {
      const reads = [...run.calendar.values()];
      examined = new Set(reads.flatMap(read => [...read.events.keys()])).size;
      matches = examined;
      readComplete = reads.every(read => read.exhausted && !read.failed && read.unread === 0);
      upstream = reads.some(read => !read.exhausted && !read.failed);
      total = readComplete ? examined : 'unknown';
      stop = run.pending.has('calendar') || run.cutShort.has('calendar') || reads.some(read => read.inflight === true || (read.boundStop === true && !read.exhausted)) ? 'deadline'
        : reads.some(read => read.failed) ? (examined > 0 ? 'page_failed' : 'failed') : readComplete ? 'exhausted' : 'enough_for_answer';
    } else {
      const entries = [...run.ledger.values()].filter(entry => entry.source === source && !entry.bodyOnly);
      examined = new Set(entries.flatMap(entry => entry.lines ?? [])).size;
      const reported = reportedTotal(entries.flatMap(entry => typeof entry.total === 'number' ? [entry.total] : []));
      // R1/R4: only a read that really finished may state a total. A read the budget cut did not return, so its
      // total is unknown, and a zero there would claim the source holds no records.
      const answered = run.sourcesDone.has(source) && !run.sourcesFailed.has(source) && !run.cutShort.has(source);
      // Several different queries may overlap, so their totals are never added up.
      if (typeof reported === 'number' && (examined > 0 || answered)) { total = Math.max(reported, examined); matches = total; }
      else if (answered && run.emptySearches.has(source) && examined === 0) { total = 0; matches = 0; }
      readComplete = run.sourcesDone.has(source) || run.emptySearches.has(source);
      stop = run.pending.has(source) || run.cutShort.has(source) || (run.reading?.has(source) === true && !readComplete) ? 'deadline'
        : run.sourcesFailed.has(source) ? 'failed'
          : !readComplete ? (closed ? 'cancelled' : 'not_read')
            : typeof total === 'number' && total > examined ? 'page_limit' : 'exhausted';
      if (stop === 'page_limit') upstream = true;
    }
    if (stop === 'exhausted' && represented < examined) stop = 'reply_budget';
    const complete = stop === 'exhausted';
    // A source read whole is said by the header alone ("truncated_to_budget 9 of 38 shown" when the reply cut it);
    // a row is the measured cost of a gap the header cannot state: a deadline, a failed page, an unknown total.
    if ((complete || stop === 'reply_budget') && typeof total === 'number') continue;
    rows.push({ source, examined, total, matches, represented, state: complete ? 'complete' : 'partial', stop,
      more: upstream || stop === 'deadline' ? 'upstream' : represented < examined ? 'local' : 'none' });
  }
  return rows;
}
