import type { HostEvidenceRef } from './types.js';
import { HISTORY_IDENTITY, HISTORY_PARAMETERS, validateHistory } from './history.js';
import type { HistoryArguments } from '../domain/history-reader.js';
import { calendarRange } from './calendar-window.js';
import { randomUUID } from 'node:crypto';
import type { ToolResultBinding, JsonObject, ModelPort, ModelRequest } from '../adapters/model/types.js';
import type { CalendarEvent as RetainedCalendarEvent, CalendarScope, MailMessage } from './live-shape.js';
import { INTERNAL, calendarIds, type IntentSubCall, type IntentSubResult } from './intent.js';
import { hostLogEvent, liveToolStep, stepSubject, type LiveToolStepBody } from './host-events.js';

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
export type SourceKind = 'memory' | 'knowledge' | 'calendar' | 'mail' | 'chat' | 'mongoose';
export type CandidateKind =
  | 'knowledge_search' | 'calendar_window' | 'mail_search' | 'mail_open'
  | 'chat_search' | 'chat_thread' | 'brief' | 'stop_answer' | 'stop_insufficient';

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
  { kind: 'brief', source: null },
  { kind: 'stop_answer', source: null },
  { kind: 'stop_insufficient', source: null },
]);

/** Every constant of the loop lives in this one exported object, the calibration record's basis. */
export const RESEARCH = Object.freeze({
  tool: RESEARCH_TOOL_NAME,
  startDeadlineMs: 15_000,
  continueDeadlineMs: 30_000,
  startRounds: 2,
  continueRounds: 3,
  maxOps: 8,
  maxConcurrent: 4,
  /** Q1-R3(b): the real Gemini selector needs ~3 s; the old 2 s deadline denied every selector call. */
  selectorDeadlineMs: 6_000,
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
   */
  sourceDeadline: Object.freeze({
    memory: 8_000, knowledge: 12_000, calendar: 12_000, mail: 12_000, chat: 12_000, mongoose: 12_000,
  } as Record<SourceKind, number>),
  /** P5: a candidate that names no single source (`brief`) never gets less than the local reads. */
  defaultSourceDeadlineMs: 8_000,
  /**
   * P5-R1: the whole research call is the slowest source it reads plus this slack, and never more than
   * the cap, so a call cannot hang on a source that never answers and cannot outlast what it reads.
   */
  answerSlackMs: 2_000,
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
  /** Median seconds per source, from the release-3a wire facts. */
  p50Seconds: Object.freeze({ knowledge: 2.2, chat: 3.6, calendar: 4.7, gmail: 10.0 } as Record<'knowledge' | 'chat' | 'calendar' | 'gmail', number>),
  /** Selector cost multiplier by elapsed seconds: cheap early, expensive late. */
  lambda: Object.freeze([{ upToMs: 4_000, value: 0 }, { upToMs: 8_000, value: 0.5 }, { upToMs: Number.POSITIVE_INFINITY, value: 1.5 }]),
  /** Q1-R0: more data beats token thrift; 6,000 chars of telegraphic lines, never prose. */
  replyLimitChars: 6_000,
  /** Hard cap on a selector-authored query, and the per-source reply bounds. */
  queryLimitChars: 200,
  mailLines: 8, chatLines: 8, knowledgeLines: 40, calendarLines: 12,
  /**
   * P5-R1: a knowledge lookup keeps the body the connector sends instead of forty snippets that cut
   * the evidence short. 3r K1: six hits, because each hit now carries a bounded body rather than a
   * 400-character excerpt. `knowledgeLines` stays the reply's per-source line bound: it caps what the
   * answer shows, never what the search may return.
   */
  knowledgeHits: 6,
  /**
   * 3r K1: a voice lookup asks for bounded stored bodies with a deadline instead of snippets, so a hit
   * arrives as text the owner can be read without a get_insight round trip. The cap is the server's
   * default body window; a hit the server cut at it says so in the reply line.
   */
  knowledgeDetail: 'bodies' as const,
  knowledgeMaxChars: 1_200,
  knowledgeDeadlineMs: 8_000,
  /**
   * Q5-R1: an explicit read by id is answered with the entry's whole body, and the connector's own
   * knowledge body cap is 20,000 chars, so that reply is sized for the body instead of the search
   * budget, which would drop the very text the owner asked for.
   */
  readReplyChars: 24_000,
  /** K6: how many memory lines one routed memory lookup may show. */
  memoryLines: 12,
  mailSnippetChars: 200, chatTextChars: 300, openedBodyChars: 1_500,
});

export const RESEARCH_SOURCES: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];

/**
 * K6: the layers a routed start may name. `company` is the Mongoose organisation read and `replies`
 * is the Mattermost attention digest; `memory` is her own remembered conversations, read locally.
 */
export type LookupSource = 'memory' | 'knowledge' | 'company' | 'calendar' | 'mail' | 'chat' | 'replies';
export const LOOKUP_SOURCES: readonly LookupSource[] = ['memory', 'knowledge', 'company', 'calendar', 'mail', 'chat', 'replies'];
/** At most four lookups per call; duplicates collapse, so one call is one short, wide read. */
export const MAX_LOOKUPS = 4;

export type MailLookup = { id: string; format?: 'full' | 'metadata' } | { q: string; maxResults?: number };
export interface ResearchLookup { source: LookupSource; query: string; history?: HistoryArguments; mail?: MailLookup }
/**
 * Per-source outcome of a routed call: read something, read nothing, unreachable, the read failed, or
 * the read was cut short by a deadline. `timeout` is its own value because a cut read is not an empty
 * one: the audit found aborted knowledge reads reported as `empty` and voiced as "nothing matched".
 */
export type LookupOutcome = 'ok' | 'empty' | 'unavailable' | 'failed' | 'timeout';

export interface ResearchRoutedLog {
  event: 'research_routed'; researchId: string; sources: LookupSource[]; lookups: number;
  ms: number[]; outcomes: LookupOutcome[];
}

/**
 * P5: one receipt per source read: which layer, what became of it, how long it took, and the deadline it
 * was given. Never a query. The deadline travels with the receipt so a cut read can be judged against the
 * time the source was actually allowed.
 */
export interface ResearchSourceLog {
  event: 'research_source'; researchId: string; source: LookupSource; outcome: LookupOutcome; ms: number;
  deadlineMs: number;
  /** 3r R1: how many lookups of this call shared the one source execution this receipt describes. */
  coalesced: number;
  /** 3r K1: the knowledge lookup's bounded-body request, metadata only and never a query. */
  knowledge?: { detail: string; maxChars: number; deadlineMs: number; truncated: boolean };
}

/** A source that cannot serve a read right now, with the reason its connector gave. */
export interface UnavailableSource { source: SourceKind; reason: string }

/** A routed lookup list, parsed defensively: unknown sources and empty queries are dropped. */
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

/** Recognize only explicit supported calendar grammar; unknown text never widens a read. */
export function calendarWindowOf(query: string, fallback = 'today'): string {
  const value = query.trim().toLowerCase().replace(/[?.!]+$/, '').replace(/^(?:what is on|what's on|show me|what meetings do i have) /, '').replace(/^(?:my )?(?:meetings|events|calendar|schedule)(?: on| for)?(?: |$)/, '');
  return value || fallback;
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
 * given a slow source's budget.
 */
export function researchCallBudgetMs(sources: readonly SourceKind[]): number {
  return Math.min(RESEARCH.answerCapMs, sourceDeadlineMs(sources) + RESEARCH.answerSlackMs);
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

export interface SelectorInput {
  question: string;
  questionClass?: QuestionClass | undefined;
  direction?: string | undefined;
  configured: readonly SourceKind[];
  /** Completed operations, so the selector never re-picks what is already known. */
  completed: readonly { kind: CandidateKind; summary: string }[];
  /** Choices the selector is allowed to make, already closed over configuration and prerequisites. */
  candidates: readonly CandidateKind[];
}

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

export interface ResearchSelector {
  select(input: SelectorInput, signal: AbortSignal): Promise<SelectorOutput | null>;
}

export const SELECTOR_SYSTEM = 'You choose which reads are worth running to answer one owner question, and you write the query each read runs. '
  + 'Reply with JSON only: {"questionClass":"quick_fact|cross_source|explicit_continue","actions":[{"kind":"...","requirement":"...","query":"...","window":"..."}],'
  + '"pUseful":{"kind":0.0}}. Choose only from the offered candidate kinds; never invent a kind, an id or a source. '
  + 'pUseful is your probability (0..1) that the action yields something that changes the answer. Omit an action when it is redundant. '
  + 'Write a real query for every search kind, never the whole spoken sentence. '
  + 'mail_search query: Gmail syntax, e.g. in:inbox newer_than:2d is:unread is:important from:alice@example.com subject:invoice "exact phrase". '
  + 'chat_search query: Mattermost keywords (a few words, not a sentence), optional from:, in:, after:YYYY-MM-DD. '
  + 'knowledge_search query: 3 to 8 content keywords, no filler. '
  + 'calendar_window: use today, tomorrow, week (rolling seven days), this week (Monday start), next week, a weekday (next occurrence including today), next Wednesday (next Monday-start week), Wednesday this week (may be past), or a valid YYYY-MM-DD date. Unresolved or contradictory windows are refused; never widen them. ';

export function buildSelectorPrompt(input: SelectorInput): { system: string; user: string } {
  const lines = [
    `Question: ${input.question}`,
    input.direction !== undefined ? `Owner direction: ${input.direction}` : '',
    `Configured sources: ${input.configured.join(', ') || 'none'}`,
    `Candidates: ${input.candidates.join(', ')}`,
    input.completed.length ? `Already read: ${input.completed.map(entry => `${entry.kind}: ${entry.summary}`).join(' | ')}` : 'Already read: nothing',
  ];
  return { system: SELECTOR_SYSTEM, user: lines.filter(Boolean).join('\n') };
}

const QUESTION_CLASSES: readonly QuestionClass[] = ['quick_fact', 'cross_source', 'explicit_continue'];

/** A selector query: one line, trimmed, length-capped, or undefined when empty. */
export function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, RESEARCH.queryLimitChars) : undefined;
}

/** Preserve bounded selector text for the canonical calendar resolver; unknown text is unresolved. */
export function normalizeWindow(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return token && token.length <= RESEARCH.queryLimitChars ? token : undefined;
}

/** Parse selector JSON defensively: any invalid output is `null`, which falls back to the recipe. */
export function parseSelector(text: string): SelectorOutput | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const questionClass = record['questionClass'];
  if (typeof questionClass !== 'string' || !QUESTION_CLASSES.includes(questionClass as QuestionClass)) return null;
  const actionsRaw = record['actions'];
  const actions: SelectorAction[] = [];
  if (Array.isArray(actionsRaw)) {
    for (const entry of actionsRaw) {
      if (entry === null || typeof entry !== 'object') continue;
      const cell = entry as Record<string, unknown>;
      const kind = cell['kind'];
      if (typeof kind !== 'string' || !CANDIDATES.some(candidate => candidate.kind === kind)) continue;
      const action: SelectorAction = { kind: kind as CandidateKind };
      const requirement = cell['requirement'];
      if (typeof requirement === 'string' && requirement.trim()) action.requirement = requirement;
      const query = normalizeQuery(cell['query']);
      if (query !== undefined) action.query = query;
      const window = normalizeWindow(cell['window']);
      if (kind === 'calendar_window') action.window = window ?? 'unresolved';
      else if (window !== undefined) action.window = window;
      actions.push(action);
    }
  }
  const pUseful: Partial<Record<CandidateKind, number>> = {};
  const pRaw = record['pUseful'];
  if (pRaw !== null && typeof pRaw === 'object') {
    for (const [kind, value] of Object.entries(pRaw as Record<string, unknown>)) {
      if (!CANDIDATES.some(candidate => candidate.kind === kind)) continue;
      if (typeof value === 'number' && Number.isFinite(value)) pUseful[kind as CandidateKind] = Math.min(1, Math.max(0, value));
    }
  }
  return { questionClass: questionClass as QuestionClass, actions, pUseful };
}

/** The real selector: the same-provider Gemini text adapter, one structured request, 2 s deadline. */
export function createGeminiSelector(model: ModelPort, promptVersion = 'research-selector-v1'): ResearchSelector {
  return {
    async select(input, signal) {
      const { system, user } = buildSelectorPrompt(input);
      const request: ModelRequest = {
        system, promptVersion,
        contents: [{ role: 'user', parts: [{ text: user }] }],
        dataClasses: ['ordinary'], context: { items: [], selectedIds: [], maxChars: 0 },
      };
      const control = { signal, deadlineMs: Date.now() + RESEARCH.selectorDeadlineMs };
      const result = await model.generate(request, control);
      if (result.status !== 'complete' || typeof result.text !== 'string') return null;
      return parseSelector(result.text);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Candidate planning

const STOP_WORDS = new Set(['a', 'an', 'and', 'any', 'anything', 'are', 'around', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'check', 'could', 'did', 'do', 'does', 'find', 'for', 'from', 'get', 'give', 'had', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'just', 'know', 'latest', 'like', 'look', 'me', 'more', 'most', 'my', 'need', 'new', 'newest', 'of', 'on', 'or', 'our', 'out', 'over', 'please', 'said', 'say', 'search', 'see', 'show', 'so', 'some', 'tell', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'want', 'was', 'we', 'were', 'what', 'whats', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'anything', 'calendar', 'chat', 'email', 'emails', 'gmail', 'important', 'inbox', 'knowledge', 'mail', 'mattermost', 'messages', 'notes', 'recent', 'slack', 'something', 'team', 'things', 'today', 'tomorrow', 'unread', 'urgent', 'yesterday', 'week', 'month', 'day']);
const WORD_SHAPE = /[^a-z0-9@._:-]+/g;

/** The content keywords of a spoken question: stop words and filler removed, 3 to 8 of them. */
export function contentKeywords(question: string, max = 8): string[] {
  const words = question.toLowerCase().replace(WORD_SHAPE, ' ').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || word.length < 3 || kept.includes(word)) continue;
    kept.push(word);
    if (kept.length >= max) break;
  }
  return kept;
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

/** The deterministic fallback query per source: never the raw sentence. */
export function fallbackQuery(kind: CandidateKind, question: string, _nowMs: number): { query?: string; window?: string } {
  const text = question.toLowerCase();
  const keywords = contentKeywords(question);
  const terms = keywords.join(' ');
  if (kind === 'knowledge_search') return terms ? { query: terms } : {};
  if (kind === 'mail_search') {
    const flags: string[] = [];
    if (/\bimportant\b/.test(text)) flags.push('is:important');
    if (/\bunread\b/.test(text)) flags.push('is:unread');
    const window = /\btoday\b/.test(text) ? 'newer_than:1d'
      : /\b(this week|week)\b/.test(text) ? 'newer_than:7d'
      : /\byesterday\b/.test(text) ? 'newer_than:2d'
      : terms ? 'newer_than:14d' : 'newer_than:2d';
    return { query: ['in:inbox', window, ...flags, ...keywords].join(' ') };
  }
  if (kind === 'chat_search') return { query: `after:yesterday${terms ? ` ${terms}` : ''}` };
  if (kind === 'calendar_window') {
    return { window: calendarWindowOf(question) };
  }
  return {};
}

/** The keyword fallback: used when the selector times out or answers invalidly, and with no selector. */
export function fallbackSelection(question: string, configured: readonly SourceKind[], nowMs = Date.now()): SelectorOutput {
  const text = question.toLowerCase();
  const actions: SelectorAction[] = [];
  const pUseful: Partial<Record<CandidateKind, number>> = {};
  const offer = (kind: CandidateKind, p: number, source: SourceKind | null): void => {
    if (source !== null && !configured.includes(source)) return;
    actions.push({ kind, ...fallbackQuery(kind, question, nowMs) });
    pUseful[kind] = p;
  };
  const mailWords = /\b(mail|email|e-mail|inbox|wrote|sent|reply)\b/.test(text);
  const calendarWords = /\b(calendar|schedule|meeting|agenda|free|busy|tomorrow|today|week)\b/.test(text);
  const chatWords = /\b(chat|team|channel|slack|mattermost|said|posted|discussed)\b/.test(text);
  const matched = mailWords || calendarWords || chatWords;
  if (!matched) { offer('brief', 0.5, null); offer('knowledge_search', 0.4, 'knowledge'); return { questionClass: 'cross_source', actions, pUseful }; }
  offer('knowledge_search', 0.4, 'knowledge');
  if (mailWords) offer('mail_search', 0.4, 'mail');
  if (calendarWords) offer('calendar_window', 0.4, 'calendar');
  if (chatWords) offer('chat_search', 0.4, 'chat');
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

/** 3r K1: the voice lookup's bounded-body arguments, named once so the wire and the receipt cannot disagree. */
function knowledgeSearchArgs(query: string): JsonObject {
  return {
    query, limit: RESEARCH.knowledgeHits,
    detail: RESEARCH.knowledgeDetail,
    max_chars: RESEARCH.knowledgeMaxChars,
    deadline_ms: RESEARCH.knowledgeDeadlineMs,
  };
}

/** 3r K1 and K1-R3: the knowledge receipt's metadata, the same on the routed and the selector path.
 * `truncated` reads the mark `insightItems` writes on a hit the server cut at the asked-for window. */
function knowledgeReceipt(lines: readonly string[]): { detail: string; maxChars: number; deadlineMs: number; truncated: boolean } {
  return {
    detail: RESEARCH.knowledgeDetail, maxChars: RESEARCH.knowledgeMaxChars, deadlineMs: RESEARCH.knowledgeDeadlineMs,
    truncated: lines.some(line => line.endsWith(`cut at ${RESEARCH.knowledgeMaxChars} chars`)),
  };
}

/** The internal sub-calls one candidate issues. `brief` fans out over every configured source. */
export function candidateSubs(kind: CandidateKind, config: { question: string; configured: readonly SourceKind[]; evidence: ReadonlyMap<CandidateKind, string>; query?: string | undefined; window?: string | undefined; nowMs?: number | undefined; timeZone?: string | undefined }): IntentSubCall[] {
  const search = (name: string, args: JsonObject, key: string): IntentSubCall => ({ key, name, args });
  const keywords = contentKeywords(config.question).join(' ');
  if (kind === 'knowledge_search') {
    // Q5-R1: a named entry is read by id through the connector's get_insight path, never searched for
    // again; the connector returns its whole body up to the knowledge body cap.
    const ids = namedInsightIds(config.question, config.query);
    if (ids.length) return [search(INTERNAL.knowledgeRead, { ids } as JsonObject, 'kr0')];
    return [search(INTERNAL.knowledgeSearch, knowledgeSearchArgs(config.query ?? (keywords || 'recent notes')), 'k0')];
  }
  if (kind === 'calendar_window') {
    // Research keeps the declared primary-calendar scope.
    const range = windowRange(config.window ?? 'today', config.nowMs ?? Date.now(), config.timeZone);
    return [search(INTERNAL.calendarList, { calendarId: 'primary', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.calendarLines }, 'cal0')];
  }
  if (kind === 'mail_search') return [search(INTERNAL.mailList, { q: config.query ?? 'in:inbox newer_than:2d', maxResults: RESEARCH.mailLines }, 'm0')];
  if (kind === 'mail_open') { const id = config.evidence.get('mail_search'); return id ? [search(INTERNAL.mailRead, { id }, 'mo0')] : []; }
  if (kind === 'chat_search') return [search(INTERNAL.chatSearch, { query: config.query ?? 'after:yesterday', limit: RESEARCH.chatLines }, 'c0')];
  if (kind === 'chat_thread') { const id = config.evidence.get('chat_search'); return id ? [search('mattermost_get_thread', { post_id: id }, 'ct0')] : []; }
  if (kind === 'brief') {
    const subs: IntentSubCall[] = [];
    // A brief reads primary events; calendar names alone are not findings.
    if (config.configured.includes('calendar')) {
      const range = windowRange('today', config.nowMs ?? Date.now(), config.timeZone);
      subs.push(search(INTERNAL.calendarList, { calendarId: 'primary', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.calendarLines }, 'b0'));
    }
    if (config.configured.includes('mail')) subs.push(search(INTERNAL.mailList, { q: 'newer_than:2d' }, 'b1'));
    if (config.configured.includes('chat')) subs.push(search(INTERNAL.chatSearch, { query: 'after:yesterday', limit: RESEARCH.chatLines }, 'b2'));
    if (config.configured.includes('knowledge')) subs.push(search(INTERNAL.knowledgeSearch, knowledgeSearchArgs(keywords || 'open loop follow up'), 'b3'));
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

/** Only an explicitly complete, nonempty returned body can replace a full-read hop. */
function completeKnowledgeIds(results: readonly IntentSubResult[]): ReadonlySet<number> {
  const complete = new Set<number>();
  for (const result of results) {
    if (!result.ok || result.name !== INTERNAL.knowledgeSearch || result.omittedCharacters > 0) continue;
    let id: number | undefined; let body: string[] = [];
    const flush = (): void => {
      const flags = body.filter(line => KNOWLEDGE_TRUNCATED.test(line));
      if (id !== undefined && flags.length === 1 && KNOWLEDGE_TRUNCATED.exec(flags[0]!)?.[1] === 'no'
          && body.some(line => line.trim() && !KNOWLEDGE_TRUNCATED.test(line) && !OMITTED_NOTE.test(line))
          && !body.some(line => OMITTED_NOTE.test(line))) complete.add(id);
      body = [];
    };
    for (const raw of result.text.split('\n')) {
      const line = raw.trim();
      if (KNOWLEDGE_MD_HEADING.test(line) || KNOWLEDGE_BULLET.test(line)) {
        flush(); id = extractInsightIds(line, 1)[0];
      } else body.push(line);
    }
    flush();
  }
  return complete;
}

// ---------------------------------------------------------------------------------------------
// Ledger

export type LedgerKind = CandidateKind | 'memory_search';

export interface LedgerEntry { bodyOnly?: boolean; kind: LedgerKind; source: SourceKind | null; summary: string; lines?: string[]; total?: number }
interface MailRead {
  args: JsonObject; messages: Map<string, MailMessage>; bindings: ToolResultBinding[];
  tokens: Set<string>; nextPageToken?: string; exhausted: boolean; failed: boolean;
  received: number; invalid: number; upstreamIncomplete?: boolean; inflight?: boolean;
}
type RemoteBody = Extract<HostEvidenceRef, { kind: 'remote-body' }>;
interface ReceivedBody { evidence: RemoteBody; binding: ToolResultBinding; source: SourceKind; offset: number }
interface BodyCursor { key: string; offset: number; end: number; nextCursor?: string; canContinue?: boolean; delivered: boolean }
const bodyDelivery = Symbol('bodyDelivery');
interface BodyDelivery { researchId: string; runId: number; cursor: string }
type BodyReply = JsonObject & { [bodyDelivery]?: BodyDelivery };
interface MailCursor { signature: string; scope: string; sourceState?: string; delivered: boolean; ids: string[]; nextCursor?: string; partial?: boolean }
const mailDelivery = Symbol('mailDelivery');
interface MailDelivery { researchId: string; runId: number; keys: string[]; cursor?: string; nextCursor?: string }
type MailReply = JsonObject & { [mailDelivery]?: MailDelivery };
const calendarDelivery = Symbol('calendarDelivery');
interface CalendarDelivery { researchId: string; runId: number; keys: string[] }
type CalendarReply = JsonObject & { [calendarDelivery]?: CalendarDelivery };
interface CalendarRead {
  args: JsonObject; events: Map<string, RetainedCalendarEvent>; bindings: ToolResultBinding[];
  tokens: Set<string>; nextPageToken?: string; exhausted: boolean; failed: boolean;
  bodyTruncated: boolean; unread: number; upstreamIncomplete?: boolean; inflight?: boolean;
}
export interface RunState {
  bodies: Map<string, ReceivedBody>; bodyCursors: Map<string, BodyCursor>; bodyCursorRequested?: string;
  mail: Map<string, MailRead>; mailDelivered: Set<string>; mailCursors: Map<string, MailCursor>; mailCursorRequested?: string; mailDeadlineAt?: number;
  historyBindings: ToolResultBinding[]; historyTokens: Set<string>;
  calendarScopeAttempted?: boolean;
  calendar: Map<string, CalendarRead>; calendarDelivered: Set<string>; calendarScope?: CalendarScope;

  researchId: string; runId: number; questionClass: QuestionClass; direction: string | undefined;
  startedAt: number; deadlineMs: number; rounds: number; maxRounds: number; ops: number;
  progressAbort: AbortController;
  cancelled: boolean; ended: boolean; stopped: boolean; ledger: Map<string, LedgerEntry>;
  evidence: Map<CandidateKind, string>; readKinds: Set<CandidateKind>; sourcesDone: Set<SourceKind>; sourcesFailed: Set<SourceKind>;
  /** Read signatures already issued this run, so an identical duplicate read is never executed twice. */
  calls: Set<string>;
  /** Per source, the query shape a search that matched nothing used, for a line the model can voice. */
  emptySearches: Map<SourceKind, string>;
  /** N3: sources whose read a deadline cut short, so the reply can say so instead of "nothing matched". */
  cutShort: Set<SourceKind>;
  /** P5: why a source cannot serve a read right now, so the reply names the cause and never guesses. */
  unavailableReasons: Map<SourceKind, string>;
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
  constructor(private readonly releaseEvidence?: (bindings: readonly ToolResultBinding[]) => void) {}

  begin(input: { researchId?: string | undefined; questionClass: QuestionClass; direction?: string | undefined; deadlineMs: number; maxRounds: number; now: number }): RunState {
    const researchId = input.researchId ?? randomUUID();
    const run: RunState = {
      researchId, runId: ++this.#counter, questionClass: input.questionClass, direction: input.direction,
      startedAt: input.now, deadlineMs: input.deadlineMs, rounds: 0, maxRounds: input.maxRounds, ops: 0,
      progressAbort: new AbortController(), cancelled: false, ended: false, stopped: false,
      bodies: new Map(), bodyCursors: new Map(), mail: new Map(), mailDelivered: new Set(), mailCursors: new Map(),
      historyBindings: [], historyTokens: new Set(), calendar: new Map(), calendarDelivered: new Set(), ledger: new Map(), evidence: new Map(), readKinds: new Set(), sourcesDone: new Set(), sourcesFailed: new Set(),
      calls: new Set(), emptySearches: new Map(), cutShort: new Set(), unavailableReasons: new Map(),
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
    const run: RunState = {
      ...existing, bodies: new Map([...existing.bodies].map(([key, body]) => [key, { ...body }])), bodyCursors: new Map([...existing.bodyCursors].map(([key, page]) => [key, { ...page }])), runId: ++this.#counter, direction: input.direction ?? existing.direction,
      startedAt: input.now, deadlineMs: input.deadlineMs, maxRounds: input.maxRounds,
      rounds: 0, ops: 0, progressAbort: new AbortController(), cancelled: false, ended: false, stopped: false,
      mail: new Map([...existing.mail].map(([key, read]) => [key, { ...read, messages: new Map(read.messages), bindings: [...read.bindings], tokens: new Set(read.tokens), failed: read.failed || Boolean(read.inflight), inflight: false }])), mailDelivered: new Set(existing.mailDelivered), mailCursors: new Map([...existing.mailCursors].map(([key, cursor]) => [key, { ...cursor, ids: [...cursor.ids] }])),
      historyBindings: [...existing.historyBindings], historyTokens: new Set(existing.historyTokens),
      calendar: new Map([...existing.calendar].map(([key, read]) => [key, { ...read, events: new Map(read.events), bindings: [...read.bindings], tokens: new Set(read.tokens), failed: read.failed || Boolean(read.inflight), inflight: false }])), calendarDelivered: new Set(existing.calendarDelivered),
      ledger: new Map(existing.ledger), evidence: new Map(existing.evidence), readKinds: new Set(existing.readKinds), sourcesDone: new Set(existing.sourcesDone), sourcesFailed: new Set(existing.sourcesFailed),
      calls: new Set(existing.calls), emptySearches: new Map(existing.emptySearches), cutShort: new Set(existing.cutShort),
      unavailableReasons: new Map(existing.unavailableReasons),
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

/** R6: one metadata-only line for the moment a call answered ahead of the sources still reading. */
export interface ResearchFirstAnswer {
  event: 'research_first_answer'; researchId: string; ms: number; settled: SourceKind[]; pending: SourceKind[];
}

/** R6: one event per source that settles after the first answer. Only what the source really returned. */
export interface ResearchLateFindings {
  researchId: string; runId?: number; calendarKeys?: string[]; mailKeys?: string[]; source: SourceKind; ms: number; items: string[]; ok: boolean;
}

export interface ResearchProgress {
  researchId: string; phase: 'started' | 'round' | 'done' | 'stopped';
  sourcesDone: SourceKind[]; sourcesPending: SourceKind[]; elapsedMs: number;
}
export type ResearchDriver = 'selector' | 'fallback' | 'single-source-hint' | 'routed';

export interface ResearchRunLog {
  event: 'research_run'; researchId: string; questionClass: QuestionClass; rounds: number;
  perRound: { candidates: { kind: CandidateKind; pUseful: number }[]; chosen: CandidateKind[] }[];
  stopReason: string; status: 'answered' | 'partial' | 'stopped' | 'unavailable' | 'failed'; ops: number;
  sources: { kind: SourceKind; disposition: string; latencyMs: number }[];
  elapsedMs: number; deadAirMs: number; selectorMs: number; fallbackUsed: boolean; replyBytes: number;
  driver?: ResearchDriver;
  unchecked?: SourceKind[]; canContinue?: boolean; findingChars?: number[];
}

/** Q1: one metadata-only record per internal sub-call: counts and bytes, never the query or text. */
export interface ResearchSubcallLog {
  event: 'research_subcall'; researchId: string; kind: LedgerKind; tool: string; ok: boolean;
  errorCode?: string; items: number; rawBytes: number; keptBytes: number; queryChars: number;
  queryAuthor: 'selector' | 'fallback' | 'routed';
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

export interface ResearchDeps {
  timeZone?: string;
  authorizeEvidence?: (bindings: readonly ToolResultBinding[], signal: AbortSignal) => boolean;
  now(): number;
  /** Defaults to a real timer; a test supplies a fake clock to prove the progress cadence. */
  schedule?: ResearchTimer | undefined;
  configured: readonly SourceKind[];
  /** Re-resolved per run so a connector that comes up or down mid-session is reported truthfully. */
  configuredNow?: (() => readonly SourceKind[]) | undefined;
  /**
   * #351: the sources whose connector cannot serve a read right now. A lookup settles `unavailable` at
   * once instead of spending its deadline on sub-calls that cannot reach a stopped connector. P5: an
   * entry may carry its reason (a credential failure, a stop), so the reply names the cause.
   */
  unavailableNow?: (() => readonly (SourceKind | UnavailableSource)[]) | undefined;
  selector?: ResearchSelector | undefined;
  execute(subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]>;
  emit(event: ResearchProgress): void;
  log(event: ResearchRunLog): void;
  /** One metadata-only line when a second `start` joins a run already in flight. */
  logJoined?: ((researchId: string) => void) | undefined;
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
}

export interface ResearchCall { cursor?: string; action: ResearchAction; question?: string; researchId?: string; sources?: string; direction?: string; lookups?: unknown; /** The model call this run answers, stamped by the Live owner so a step can name it. Never from model arguments. */ callId?: string }


const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

export const RESEARCH_ARGUMENT_FIELDS = ['action', 'question', 'researchId', 'sources', 'direction', 'lookups', 'cursor'] as const;
export const RESEARCH_ARGUMENT_TYPES = ['absent', 'null', 'string', 'number', 'boolean', 'array', 'object', 'other'] as const;
export const RESEARCH_REFUSAL_REASONS = ['root_type', 'unknown_fields', 'action_missing', 'action_invalid', 'question_type', 'question_required', 'research_id_type', 'research_id_required', 'sources_type', 'direction_type', 'cursor_type', 'cursor_action', 'cursor_lookups_conflict', 'lookups_type', 'lookups_count', 'lookups_stop', 'lookup_type', 'lookup_unknown_fields', 'lookup_source', 'lookup_query_required', 'lookup_query_length', 'lookup_history', 'lookup_mail'] as const;
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
  const record = isRecord(args) ? args : {};
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
  if (!Object.hasOwn(args, 'action')) return refuse('action_missing');
  if (action !== 'start' && action !== 'continue' && action !== 'stop') return refuse('action_invalid');
  for (const [key, reason] of [['question', 'question_type'], ['researchId', 'research_id_type'], ['sources', 'sources_type'], ['direction', 'direction_type']] as const) {
    if (Object.hasOwn(args, key) && typeof args[key] !== 'string') return refuse(reason);
  }
  if (args['question'] !== undefined && optionalString(args['question']) === undefined) return refuse('question_required');
  if (args['researchId'] !== undefined && optionalString(args['researchId']) === undefined) return refuse('research_id_required');
  if (action === 'start' && optionalString(args['question']) === undefined) return refuse('question_required');
  if (action !== 'start' && optionalString(args['researchId']) === undefined) return refuse('research_id_required');
  if (Object.hasOwn(args, 'cursor')) {
    if (typeof args['cursor'] !== 'string' || !args['cursor'].length || args['cursor'].length > 128) return refuse('cursor_type');
    if (action !== 'continue') return refuse('cursor_action');
    if (Object.hasOwn(args, 'lookups')) return refuse('cursor_lookups_conflict');
  }
  if (Object.hasOwn(args, 'lookups')) {
    if (action === 'stop') return refuse('lookups_stop');
    if (!Array.isArray(args['lookups'])) return refuse('lookups_type');
    if (args['lookups'].length > MAX_LOOKUPS) return refuse('lookups_count');
    for (const entry of args['lookups']) {
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
  return { ok: true, call: args as unknown as ResearchCall };
}

export function validateResearch(args: unknown): boolean { return parseResearch(args).ok; }

export function researchRepair(reason: ResearchRefusalReason): JsonObject {
  return {
    error: 'invalid_research_arguments', state: 'refused', reason,
    guidance: 'No lookup started. Use {"action":"start","question":"the question"}; optional lookups need source and query, or memory with history, or mail with mail. Continue needs the returned researchId. Stop needs researchId and no lookups. Cursor is only for continue, without lookups. Omit unused fields; null is not supported.',
  };
}

function validMailLookup(value: unknown): value is MailLookup {
  if (!isRecord(value)) return false;
  if ('id' in value) return Object.keys(value).every(key => key === 'id' || key === 'format') && typeof value['id'] === 'string' && value['id'].length > 0 && (value['format'] === undefined || value['format'] === 'full' || value['format'] === 'metadata');
  return Object.keys(value).every(key => key === 'q' || key === 'maxResults') && typeof value['q'] === 'string' && value['q'].trim().length > 0 && value['q'].length <= 2048
    && (value['maxResults'] === undefined || Number.isSafeInteger(value['maxResults']) && Number(value['maxResults']) > 0 && Number(value['maxResults']) <= 50);
}

/** The display order and human name of every research source the host loop can read today (R2-R2). */
const SOURCE_LABELS: readonly (readonly [SourceKind, string])[] = [
  ['calendar', 'calendar'],
  ['mail', 'mail'],
  ['chat', 'team chat'],
  ['knowledge', 'knowledge base'],
  ['mongoose', 'company knowledge'],
  ['memory', 'memory'],
];

/** The connector tool whose presence means a source is configured. Same four names the research loop fans out over. */
const SOURCE_TOOLS: Readonly<Record<string, SourceKind>> = {
  conversation_history: 'memory', search_knowledge: 'knowledge', search_mongoose: 'mongoose', gcal_list: 'calendar', gmail_list: 'mail', mattermost_search: 'chat',
};

/** Map the tool names a session actually configured to the research sources they expose, in display order. */
export function researchSourcesFromToolNames(names: Iterable<string>): SourceKind[] {
  const present = new Set(names);
  const found = new Set<SourceKind>();
  for (const [tool, source] of Object.entries(SOURCE_TOOLS)) if (present.has(tool)) found.add(source);
  return SOURCE_LABELS.map(([source]) => source).filter(source => found.has(source));
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

/** The configured sources named for the model, joined as "a, b and c". */
function sourceListText(sources: readonly SourceKind[]): string {
  const labels = SOURCE_LABELS.filter(([source]) => sources.includes(source)).map(([, label]) => label);
  if (labels.length === 0) return 'configured sources';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}`;
}

/** The declaration description names the sources this session actually configured, never a source it lacks. */
export function researchDescription(sources: readonly SourceKind[]): string {
  return `The owner's ${sourceListText(sources)}, in one lookup. Use it when answering requires external evidence beyond the accepted conversation context. The host decides per question which sources are worth reading and whether one more read is worth the wait. Call start with the question: its result carries the researchId the host minted, and continue and stop copy that id.`;
}

export function researchDeclaration(configured: readonly SourceKind[] = RESEARCH_SOURCES): { name: string; description: string; guidance: string; parameters: JsonObject; validate(args: unknown): boolean } {
  return {
    name: RESEARCH_TOOL_NAME,
    description: researchDescription(configured),
    guidance: 'Omit unused properties; null is not supported. Each generic lookup requires source and query; typed memory.history and mail.mail omit query. Cursor is continue-only and excludes lookups; stop excludes lookups and cursor. start needs {"action":"start","question":"the question"} and its result carries the researchId the host minted; continue needs {"action":"continue","researchId":"<the id from that result>"}, copied, never invented. An optional "sources" hint of exactly one source makes the first round deterministic; an optional "direction" steers a continue.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'continue', 'stop'], description: 'start requires question; continue and stop require the researchId returned by start. Stop must omit lookups and cursor.' },
        question: { type: 'string', minLength: 1, description: 'The owner question; required for start.' },
        researchId: { type: 'string', minLength: 1, description: 'The id a previous reply carried; required for continue and stop.' },
        sources: { type: 'string', description: 'Optional single-source hint; valid values: calendar, mail, chat, knowledge.' },
        cursor: { type: 'string', maxLength: 128, description: 'Consumer continuation copied from nextCursor on the same researchId. This is not a source-native page token. Omit lookups when using it.' },
        direction: { type: 'string', description: 'Optional steer for a continue, e.g. "look in mail".' },
        lookups: {
          type: 'array', maxItems: MAX_LOOKUPS,
          description: 'Optional: the layers to read, one lookup each, at most four. When present the host skips its own source choice and reads every lookup in parallel; when absent the host selects the sources. memory: retained conversations, remembered notes and imported notes, within the accepted permissions. knowledge: his knowledge base of decisions, project status, technical notes, meeting transcripts and work sessions. company: permissioned company, product and commercial records; this does not guarantee directory coverage. calendar: primary calendar only; query must be today, tomorrow, week (rolling seven days), this week (Monday start), next week, a weekday (next occurrence including today), next Wednesday (next Monday-start week), Wednesday this week (may be past), or a valid YYYY-MM-DD. Unknown or contradictory windows are unresolved, never widened. Calendar coverage separates received events, shown events, retained remainder, unread pages and truncated descriptions; continue returns retained remainder before reading more pages. mail: his mail; lookup.mail supports an exact Gmail q/maxResults search or exact id/format read. Search coverage counts received metadata messages, not full bodies or complete threads. Source order is preserved. continue returns retained metadata before requesting another page. An exact full-message read returns bodySlices with immutable UTF16 offsets, received total and separate upstream completeness. Continue nextCursor to consume received body remainder without another source read; quoted history remains included. Metadata format deliberately omits bodies. alreadyDelivered is a model-context receipt, not a claim that the owner heard it. chat: his team chat. replies: what is waiting on him in the team chat.',
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
const SOURCE_LABEL: Record<SourceKind, string> = { memory: 'memory', knowledge: 'knowledge', calendar: 'calendar', mail: 'mail', chat: 'chat', mongoose: 'company knowledge' };
/** Findings order: her own memory and the owner's knowledge base lead, company sources follow. */
const SOURCE_ORDER: readonly SourceKind[] = ['memory', 'knowledge', 'calendar', 'mail', 'chat', 'mongoose'];
const LINE_CAP: Partial<Record<CandidateKind, number>> = {
  mail_search: RESEARCH.mailLines, mail_open: 2,
  chat_search: RESEARCH.chatLines, chat_thread: 12,
  knowledge_search: RESEARCH.knowledgeLines, calendar_window: RESEARCH.calendarLines,
  brief: RESEARCH.mailLines,
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

function itemLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line && !OMITTED_NOTE.test(line));
}

/** A knowledge heading, shaped `### title (kind | date) [id N]` or raw markdown `## #N [type] title`. */
function knowledgeHeadingOf(line: string): { id: string | undefined; title: string } {
  const id = line.match(/\[id (\d+)\]/)?.[1] ?? line.match(/^#{2,3}\s*#(\d+)\b/)?.[1];
  const title = line.replace(/^#{2,3}\s*/, '').replace(/\[id \d+\]/gu, '').replace(/^#\d+\b\s*/, '').replace(/\s+/g, ' ').trim();
  return { id, title };
}

const KNOWLEDGE_BULLET = /^\s*(?:-\s+)?\*\*#(\d+)\*\*\s*(.*)$/;
const KNOWLEDGE_MD_HEADING = /^#{2,3}\s+/;
/** The server's own bounded-body flag: `truncated: yes (5,432 chars stored)` under a hit. */
const KNOWLEDGE_TRUNCATED = /^truncated: (yes|no)\b/u;

/** Knowledge headings collapse to `#id title | body`, one per insight, in the shaped and raw forms. */
function insightItems(raw: readonly string[]): string[] {
  const items: string[] = [];
  let heading: { id: string | undefined; title: string } | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (heading === undefined) { body = []; return; }
    // P5-R1: the body is kept whole: the connector's own result bounds are the only cap on a hit.
    // 3r K1: a hit the server cut at the asked-for window says so, in place of the server's own flag.
    let cut = false;
    const kept = body.filter(line => {
      const flag = KNOWLEDGE_TRUNCATED.exec(line);
      if (!flag) return true;
      cut = flag[1] === 'yes';
      return false;
    });
    const text = `${heading.id ? `#${heading.id} ` : ''}${heading.title}${kept.length ? ` | ${kept.join(' ')}` : ''}`;
    items.push(cut ? `${text} | cut at ${RESEARCH.knowledgeMaxChars} chars` : text);
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
  let attendees: number | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    items.push({ ...current, line: `${current.line}${attendees !== undefined ? ` | ${attendees} attendees` : ''}` });
    current = undefined; attendees = undefined;
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
      current = { id, start, line: `${start} | ${title}${location ? ` | ${location}` : ''}${calendar ? ` | ${calendar}` : ''}` };
    } else if (line.startsWith('attendees: ') && current !== undefined) {
      attendees = line.slice('attendees: '.length).split(',').map(part => part.trim()).filter(Boolean).length;
    }
  }
  flush();
  return items;
}

/** Merge the connector's shaped event lines: dedupe by event id and sort by start (the connector already merged). */
function shapeCalendarBlock(results: readonly IntentSubResult[]): { text: string; source: SourceKind | null; lines: string[]; total: number } {
  const merged: { start: string; line: string }[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (!result.ok || result.name !== INTERNAL.calendarList || !result.text.trim()) continue;
    for (const event of calendarEvents(itemLines(result.text))) {
      const dedupe = event.id || `${event.start}|${event.line}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      merged.push({ start: event.start, line: event.line });
    }
  }
  merged.sort((a, b) => a.start.localeCompare(b.start));
  const lines = merged.map(entry => entry.line);
  const shown = lines.slice(0, RESEARCH.calendarLines);
  const notRead = calendarNotRead(results);
  if (!shown.length) return { text: '', source: 'calendar', lines: [], total: 0 };
  return { text: `calendar: ${shown.length} of ${lines.length} shown\n${shown.join('\n')}${notRead ? `\n${notRead}` : ''}`, source: 'calendar', lines: shown, total: lines.length };
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
export function shapeBlock(kind: CandidateKind, results: readonly IntentSubResult[]): { text: string; source: SourceKind | null; lines: string[]; total: number } {
  if (kind === 'calendar_window') {
    const block = shapeCalendarBlock(results);
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
      for (const line of raw.filter(entry => entry.startsWith('- '))) {
        const parts = line.slice(2).replace(/\s*\[id [^\]]+\]/g, '').trim().split(' | ');
        const subject = parts[0] ?? '';
        let sender = ''; let date = '';
        const rest: string[] = [];
        for (const part of parts.slice(1)) {
          if (part.startsWith('from: ')) sender = part.slice(6).trim();
          else if (part.startsWith('date: ')) date = part.slice(6).trim();
          else rest.push(part);
        }
        const excerpt = clip(rest.join(' | '), RESEARCH.mailSnippetChars);
        lines.push([sender, subject, date, excerpt].filter(value => value !== '').join(' | '));
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
      const items = insightItems(raw);
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
    }
  }
  const cap = LINE_CAP[kind] ?? lines.length;
  const shown = lines.slice(0, cap);
  if (!shown.length) return { text: '', source, lines: [], total: 0 };
  const label = SOURCE_LABEL[source ?? 'knowledge'];
  const cutLine = cutLineOf(results);
  return { text: `${label}: ${shown.length} of ${total} shown\n${shown.join('\n')}${cutLine !== undefined ? `\n${cutLine}` : ''}`, source, lines: shown, total };
}


function sourceKindOfKindName(name: string): SourceKind | null {
  switch (name) {
    case INTERNAL.knowledgeSearch:
    case INTERNAL.knowledgeRead: return 'knowledge';
    case INTERNAL.calendars:
    case INTERNAL.calendarList: return 'calendar';
    case INTERNAL.mailList:
    case INTERNAL.mailRead: return 'mail';
    case HISTORY_IDENTITY.name: return 'memory';
    case INTERNAL.mongooseSearch: return 'mongoose';
    case INTERNAL.chatSearch:
    case INTERNAL.chatAttention:
    case 'mattermost_get_thread': return 'chat';
    default: return null;
  }
}

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
  if (body.evidence.expiresAt <= Date.now()) return { researchId: run.researchId, error: 'continuation_unavailable', findings: [], canContinue: false };
  const width = Math.max(128, Math.min(2500, limit - 1200));
  const cursor = run.bodyCursorRequested ?? bodyCursor(run, key, body.offset, width), page = run.bodyCursors.get(cursor)!;
  if (page.end < body.evidence.body.length) page.nextCursor ??= bodyCursor(run, key, page.end, width);
  else {
    const next = [...run.bodies].find(([other, value]) => other !== key && value.offset < value.evidence.body.length);
    if (next) page.nextCursor ??= bodyCursor(run, next[0], next[1].offset, width);
  }
  const base = buildReply(run, 'answered', configured, false, Math.max(1000, limit - width - 1100), undefined, true);
  const otherPending = base['canContinue'] === true;
  if (!page.nextCursor && typeof base['nextCursor'] === 'string') page.nextCursor = base['nextCursor'];
  page.canContinue = Boolean(page.nextCursor) || otherPending;
  const partial = Boolean(page.nextCursor) || otherPending || body.evidence.upstreamComplete !== true || body.evidence.upstreamOmitted !== false;
  return { ...base, researchId: run.researchId, status: partial ? 'partial' : 'answered', bodyProjection: 'preview',
    bodySlices: [{ source: body.source, tool: body.evidence.tool, text: body.evidence.body.slice(page.offset, page.end), offset: page.offset, end: page.end, total: body.evidence.body.length, unit: 'utf16', upstreamComplete: body.evidence.upstreamComplete, upstreamOmitted: body.evidence.upstreamOmitted }],
    cursor, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), canContinue: Boolean(page.nextCursor) || otherPending,
    [bodyDelivery]: { researchId: run.researchId, runId: run.runId, cursor } };
}

interface ReplyFinding { source: string; text: string; chars: number }

/**
 * Q1-R0 packing: a count line plus telegraphic lines per source, at least one line per source with
 * hits, then fill by recency; omitted calendar events remain in the current authorized run.
 */
function buildReply(run: RunState, status: 'answered' | 'partial' | 'stopped' | 'unavailable', configured: readonly SourceKind[], canContinue: boolean, limit: number, sources?: JsonObject, skipBodies = false): JsonObject {
  const bodyReply = skipBodies ? undefined : receivedBodyReply(run, configured, limit);
  if (bodyReply) return bodyReply;
  const groups: { source: SourceKind; label: string; lines: string[]; total: number }[] = [];
  for (const entry of run.ledger.values()) {
    if (entry.bodyOnly || !entry.lines || entry.lines.length === 0 || entry.source === null || (entry.source === 'calendar' && run.calendar.size > 0) || (entry.source === 'mail' && run.mail.size > 0)) continue;
    const existing = groups.find(group => group.source === entry.source);
    const target = existing ?? { source: entry.source, label: SOURCE_LABEL[entry.source], lines: [], total: 0 };
    target.lines.push(...entry.lines);
    target.total += entry.total ?? entry.lines.length;
    if (!existing) groups.push(target);
  }
  const calendarEvents = new Map<string, RetainedCalendarEvent>();
  for (const read of run.calendar.values()) for (const [key, event] of read.events) calendarEvents.set(key, event);
  const remaining = [...calendarEvents].filter(([key]) => !run.calendarDelivered.has(key)).sort(([, a], [, b]) => a.start.localeCompare(b.start));
  if (remaining.length > 0) groups.push({ source: 'calendar', label: SOURCE_LABEL.calendar, lines: remaining.slice(0, 8).map(([, event]) => event.line), total: calendarEvents.size });
  const calendarReads = [...run.calendar.values()];
  const calendarPending = remaining.length > 8 || calendarReads.some(read => !read.failed && !read.exhausted);
  const calendarPartial = calendarReads.some(read => read.failed || read.unread > 0 || read.upstreamIncomplete || !read.exhausted) || remaining.length > 8;
  if (calendarPartial && status === 'answered') status = 'partial';
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
  if (mailRemaining.length) groups.push({ source: 'mail', label: 'mail messages', lines: mailRemaining.slice(0, 8).map(([, message]) => message.line), total: receivedMail.size });
  const mailUpstream = mailReads.some(read => !read.failed && !read.exhausted);
  const mailIncomplete = mailReads.some(read => read.failed || read.upstreamIncomplete || read.invalid > 0 || [...read.messages.values()].some(message => message.bodyTruncated));
  if ((mailIncomplete || mailUpstream || mailRemaining.length > 8) && status === 'answered') status = 'partial';
  const readSources = new Set(run.sourcesDone);
  const unchecked = configured.filter(source => !readSources.has(source));
  // Outcome 2: name the sources this run could not reach, in one short clause the model can voice,
  // so an outage is never hidden behind a narrow answer. `knowledge` leads the findings.
  groups.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  const unreachable = SOURCE_LABELS.filter(([source]) => run.sourcesFailed.has(source)).map(([, label]) => label);
  const searchedNothing = SOURCE_LABELS.filter(([source]) => run.emptySearches.has(source) && !run.sourcesFailed.has(source))
    .map(([source, label]) => `I searched your ${label}${run.emptySearches.get(source) ?? ''} and found nothing matching.`);
  // N3: a read cut short is not a read that found nothing, and the reply must not blur the two.
  const cutShort = SOURCE_LABELS.filter(([source]) => run.cutShort.has(source) && !run.sourcesFailed.has(source))
    .map(([, label]) => `My ${label} read was cut short before it finished, so I say what I have and ask one precise follow-up.`);
  const clauses = [
    ...(unreachable.length === 0 ? [] : [`I could not reach ${unreachable.length === 1 ? unreachable[0]! : `${unreachable.slice(0, -1).join(', ')} and ${unreachable[unreachable.length - 1]!}`} right now.`]),
    ...cutShort,
    ...searchedNothing,
  ];
  if (run.unavailableReasons.get('calendar') === 'unresolved_window') clauses.push('I could not resolve that calendar date or window. Give a supported weekday, today, tomorrow, week, this week, next week, or an exact valid date.');
  const note = clauses.length === 0 ? undefined : clauses.join(' ');
  // P5: a source that could not be read names its own reason, so an outage is never read as "nothing
  // found" and never as a timeout.
  const unavailableReasons = run.unavailableReasons.size === 0 ? undefined : Object.fromEntries(run.unavailableReasons);
  let dropped = 0;
  const render = (): { findings: ReplyFinding[]; reply: JsonObject } => {
    const mailShown = groups.find(group => group.source === 'mail')?.lines.length ?? 0;
    const mailPending = (cursorPage?.ids.length ? Boolean(cursorPage.nextCursor) : mailUpstream) || mailRemaining.length > mailShown;
    const mailFields = mailReads.length ? {
      mailMessages: mailRemaining.slice(0, mailShown).map(([, message]) => ({ id: message.id, threadId: message.threadId, internalDate: message.internalDate })),
      mailCoverage: { view: 'metadata', metadataTruncated: mailReads.some(read => [...read.messages.values()].some(message => message.bodyTruncated)), received: receivedMail.size, receivedOccurrences: mailReads.reduce((n, read) => n + read.received, 0), shown: mailShown, localRemaining: Math.max(0, allMailRemaining.length - mailShown), upstreamRemaining: mailUpstream, invalid: mailReads.reduce((n, read) => n + read.invalid, 0), failed: mailReads.some(read => read.failed), upstreamIncomplete: mailReads.some(read => read.upstreamIncomplete) },
      ...(mailPending ? { nextCursor: '00000000-0000-0000-0000-000000000000' } : {}),
      ...(run.mailCursorRequested ? { cursor: run.mailCursorRequested } : {}),
    } : {};
    const findings: ReplyFinding[] = groups.filter(group => group.lines.length > 0)
      .map(group => ({ source: group.source, text: `${group.label}: ${group.lines.length} of ${group.total} shown\n${group.lines.join('\n')}`, chars: group.lines.join('\n').length }));
    return { findings, reply: { researchId: run.researchId, status, findings, unchecked, canContinue: canContinue || dropped > 0 || calendarPending || mailPending, ...mailFields, ...(calendarCoverage ? { calendarCoverage: { ...calendarCoverage, shown: groups.find(group => group.source === 'calendar')?.lines.length ?? 0, localRemaining: Math.max(0, remaining.length - (groups.find(group => group.source === 'calendar')?.lines.length ?? 0)) } } : {}), ...(note !== undefined ? { note } : {}), ...(sources !== undefined ? { sources } : {}), ...(unavailableReasons !== undefined ? { unavailable: unavailableReasons } : {}) } };
  };
  // Trim the longest source first, never below one line while any source still has more than one.
  let guard = 4096;
  while (guard-- > 0 && JSON.stringify(render().reply).length > limit) {
    const removable = groups.filter(group => group.lines.length > (groups.length > 1 ? 1 : 0));
    if (removable.length === 0) break;
    removable.sort((a, b) => b.lines.length - a.lines.length);
    removable[0]!.lines.pop(); dropped += 1;
  }
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
  if (calendarReads.length > 0) result[calendarDelivery] = { researchId: run.researchId, runId: run.runId, keys: remaining.slice(0, groups.find(group => group.source === 'calendar')?.lines.length ?? 0).map(([key]) => key) };
  return result;
}

/**
 * K6: one routed lookup. `memory` is read in process; every other layer becomes the internal read that
 * source already owns, under its own per-source deadline. Nothing here consults the selector.
 */
function routedRead(lookup: ResearchLookup, context: { question: string; configured: readonly SourceKind[]; run: RunState; now: () => number; timeZone?: string }): { unresolved?: boolean; source: SourceKind | 'memory'; kind: LedgerKind; subs: IntentSubCall[] } {
  const query = lookup.query;
  if (lookup.source === 'memory') return { source: 'memory', kind: 'memory_search', subs: [{ key: 'history', name: HISTORY_IDENTITY.name, args: { ...(lookup.history ?? { query }) } }] };
  if (lookup.source === 'company') return { source: 'mongoose', kind: 'knowledge_search', subs: [{ key: 'co0', name: INTERNAL.mongooseSearch, args: { query } as JsonObject }] };
  // The attention digest answers "what is waiting on him"; it takes no query of its own.
  if (lookup.source === 'replies') return { source: 'chat', kind: 'chat_search', subs: [{ key: 'at0', name: INTERNAL.chatAttention, args: {} as JsonObject }] };
  const subsConfig = { question: context.question, configured: context.configured, evidence: context.run.evidence, query };
  // N3: a voice turn reads the primary calendar only, one bounded call. The merged read is one remote
  // call per visible calendar (22 on the smoke account) and can never finish inside the run deadline, so
  // it always came back empty and the owner heard nothing; the full merge stays on the calendar intent.
  // The calendar list rides along only so the result can say what it did not read.
  if (lookup.source === 'calendar') {
    let range: { timeMin: string; timeMax: string };
    try { range = windowRange(calendarWindowOf(query, 'week'), context.now(), context.timeZone); }
    catch { return { source: 'calendar', kind: 'calendar_window', subs: [], unresolved: true }; }
    return { source: 'calendar', kind: 'calendar_window', subs: [
      { key: 'cal0', name: INTERNAL.calendarList, args: { calendarId: 'primary', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.calendarLines } as JsonObject },
      { key: 'cal1', name: INTERNAL.calendars, args: { maxResults: 20 } as JsonObject },
    ] };
  }
  if (lookup.source === 'knowledge') return { source: 'knowledge', kind: 'knowledge_search', subs: candidateSubs('knowledge_search', subsConfig) };
  if (lookup.source === 'mail') return lookup.mail
    ? { source: 'mail', kind: 'id' in lookup.mail ? 'mail_open' : 'mail_search', subs: [{ key: 'mail0', name: 'id' in lookup.mail ? INTERNAL.mailRead : INTERNAL.mailList, args: { ...lookup.mail } }] }
    : { source: 'mail', kind: 'mail_search', subs: candidateSubs('mail_search', subsConfig) };
  return { source: 'chat', kind: 'chat_search', subs: candidateSubs('chat_search', subsConfig) };
}

interface RoutedOutcome {
  bodyOnly?: boolean;
  lookup: ResearchLookup; kind: LedgerKind; tool: string; source: SourceKind | 'memory';
  outcome: LookupOutcome; ms: number; historyPage?: JsonObject; lines: string[]; total: number;
}

interface RoutedPlan { lookup: ResearchLookup; read: { unresolved?: boolean; source: SourceKind | 'memory'; kind: LedgerKind; subs: IntentSubCall[] } }

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
  if (run.cancelled || run.stopped || signal.aborted) return false;
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
function mailRead(run: RunState, args: JsonObject): MailRead {
  const key = JSON.stringify(args);
  let read = run.mail.get(key);
  if (!read) { read = { args: { ...args }, messages: new Map(), bindings: [], tokens: new Set(), exhausted: false, failed: false, received: 0, invalid: 0 }; run.mail.set(key, read); }
  return read;
}

/** Each source page is dispatched once under one source deadline; received identities stay local. */
async function collectMail(deps: ResearchDeps, run: RunState, parent: AbortSignal, remainingMs: number, now: () => number): Promise<void> {
  run.mailDeadlineAt ??= now() + Math.min(RESEARCH.sourceDeadline.mail, remainingMs);
  const left = run.mailDeadlineAt - now();
  if (left <= 0 || remainingMs <= 0) { run.cutShort.add('mail'); return; }
  const signal = AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, Math.min(left, remainingMs)))]);
  while (now() < run.mailDeadlineAt && run.ops < RESEARCH.maxOps && evidenceAllowed(deps, run, signal)) {
    const reads = [...run.mail.values()].filter(read => !read.exhausted && !read.failed && !read.inflight).slice(0, RESEARCH.maxOps - run.ops);
    if (reads.length === 0) break;
    const calls = reads.map((read, n) => ({ key: `mail${run.ops + n}`, name: INTERNAL.mailList, args: { ...read.args, ...(read.nextPageToken ? { pageToken: read.nextPageToken } : {}) } }));
    if (!evidenceAllowed(deps, run, signal)) break;
    for (const read of reads) { read.inflight = true; if (read.nextPageToken) read.tokens.add(read.nextPageToken); }
    run.ops += calls.length;
    let results: IntentSubResult[];
    try { results = await deps.execute(calls, signal); }
    catch { for (const read of reads) { read.inflight = false; read.failed = true; } if (signal.aborted) run.cutShort.add('mail'); break; }
    if (parent.aborted || run.cancelled || run.stopped) { invalidateEvidence(run); break; }
    if (signal.aborted || now() >= run.mailDeadlineAt) { for (const read of reads) { read.inflight = false; read.failed = true; } run.cutShort.add('mail'); break; }
    reads.forEach((read, n) => {
      read.inflight = false;
      const result = results[n];
      if (!result?.ok || !result.mailPage || deps.authorizeEvidence && !result.binding) { read.failed = true; return; }
      if (result.binding) read.bindings.push(result.binding);
      if (!evidenceAllowed(deps, run, parent)) { run.cancelled = true; return; }
      const page = result.mailPage;
      for (const message of page.messages) if (!read.messages.has(message.id)) read.messages.set(message.id, message);
      read.received += page.received; read.invalid += page.invalid; read.upstreamIncomplete ||= page.upstreamIncomplete === true;
      const next = page.nextPageToken;
      if (next && (next.length > 4096 || read.tokens.has(next))) { read.failed = true; return; }
      if (next) read.nextPageToken = next;
      else { delete read.nextPageToken; read.exhausted = true; }
    });
    if (run.cancelled) { invalidateEvidence(run); break; }
  }
  if (signal.aborted) run.cutShort.add('mail');
}

async function mailGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], signal: AbortSignal, remainingMs: number, now: () => number): Promise<RoutedOutcome[]> {
  const started = now();
  const reads = plans.map(plan => mailRead(run, plan.read.subs[0]!.args));
  await collectMail(deps, run, signal, remainingMs, now);
  return plans.map((plan, n) => {
    const read = reads[n]!, lines = [...read.messages.values()].map(message => message.line);
    const outcome: LookupOutcome = lines.length > 0 ? 'ok' : signal.aborted || run.cutShort.has('mail') ? 'timeout' : read.failed ? 'failed' : 'empty';
    return { lookup: plan.lookup, kind: plan.read.kind, tool: INTERNAL.mailList, source: 'mail', outcome, ms: now() - started, lines, total: read.messages.size };
  });
}

/** One run owns each exact primary/window/page dispatch and retains its authorized normalized events. */
async function collectCalendar(deps: ResearchDeps, run: RunState, parent: AbortSignal, remainingMs: number, now: () => number): Promise<void> {
  if (remainingMs <= 0) { run.cutShort.add('calendar'); return; }
  const sourceDeadlineAt = now() + Math.min(RESEARCH.sourceDeadline.calendar, remainingMs);
  const signal = AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, Math.min(RESEARCH.sourceDeadline.calendar, remainingMs)))]);
  while (now() < sourceDeadlineAt && run.ops < RESEARCH.maxOps && evidenceAllowed(deps, run, signal)) {
    const pending = [...run.calendar.values()].filter(read => !read.exhausted && !read.failed && !read.inflight);
    if (pending.length === 0) break;
    const reads = pending.slice(0, RESEARCH.maxOps - run.ops);
    const calls: IntentSubCall[] = reads.map((read, n) => ({ key: `calendar${run.ops + n}`, name: INTERNAL.calendarList, args: { ...read.args, ...(read.nextPageToken ? { pageToken: read.nextPageToken } : {}) } }));
    const listScope = !run.calendarScopeAttempted && calls.length < RESEARCH.maxOps - run.ops;
    if (listScope) { calls.push({ key: 'calendarScope', name: INTERNAL.calendars, args: { maxResults: 20 } }); run.calendarScopeAttempted = true; }
    if (!evidenceAllowed(deps, run, signal)) break;
    for (const read of reads) { read.inflight = true; if (read.nextPageToken) read.tokens.add(read.nextPageToken); }
    run.ops += calls.length;
    let results: IntentSubResult[];
    try { results = await deps.execute(calls, signal); }
    catch { for (const read of reads) { read.failed = true; read.inflight = false; } if (signal.aborted) run.cutShort.add('calendar'); break; }
    if (parent.aborted || run.cancelled || run.stopped) { run.cancelled = true; invalidateEvidence(run); break; }
    if (signal.aborted || now() >= sourceDeadlineAt) { for (const read of reads) { read.failed = true; read.inflight = false; } run.cutShort.add('calendar'); break; }
    if (!evidenceAllowed(deps, run, parent)) { run.cancelled = true; invalidateEvidence(run); break; }
    if (listScope) {
      const scope = results[reads.length];
      if (scope?.ok && scope.calendarScope) run.calendarScope = scope.calendarScope;
      if (scope?.binding && reads[0]) reads[0].bindings.push(scope.binding);
    }
    reads.forEach((read, n) => {
      read.inflight = false;
      const result = results[n];
      if (!result?.ok || !result.calendarPage || (deps.authorizeEvidence && !result.binding)) { read.failed = true; return; }
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
    if (run.cancelled) { invalidateEvidence(run); break; }
    if (now() - run.startedAt >= run.deadlineMs) break;
  }
  if (signal.aborted) run.cutShort.add('calendar');
}

async function calendarGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], signal: AbortSignal, remainingMs: number, now: () => number): Promise<RoutedOutcome[]> {
  const started = now();
  const owned = new Map<RoutedPlan, string>();
  for (const plan of plans) {
    const call = plan.read.subs.find(sub => sub.name === INTERNAL.calendarList);
    if (!call || plan.read.unresolved) { run.unavailableReasons.set('calendar', 'unresolved_window'); continue; }
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
    const outcome: LookupOutcome = !read ? 'unavailable' : read.events.size > 0 ? 'ok' : read.failed ? 'failed' : read.exhausted ? 'empty' : 'timeout';
    return { lookup: plan.lookup, kind: plan.read.kind, tool: INTERNAL.calendarList, source: 'calendar', outcome, ms: now() - started, lines, total: read?.events.size ?? 0 };
  });
}

async function routedGroup(deps: ResearchDeps, run: RunState, plans: readonly RoutedPlan[], context: { question: string; configured: readonly SourceKind[]; unavailable: readonly SourceKind[]; unavailableReason?: ((source: SourceKind) => string) | undefined; signal: AbortSignal; now: () => number }): Promise<RoutedOutcome[]> {
  const at = context.now();
  const settle = (plan: RoutedPlan, outcome: LookupOutcome, lines: string[] = [], total = 0): RoutedOutcome =>
    ({ lookup: plan.lookup, kind: plan.read.kind, tool: plan.read.subs[0]?.name ?? plan.read.kind, source: plan.read.source, outcome, ms: context.now() - at, lines, total });
  const done: RoutedOutcome[] = [];
  for (const plan of plans.filter(entry => entry.read.source === 'memory')) {
    const args = plan.lookup.history ?? { query: plan.lookup.query };
    const reference = args.cursor ?? args.recordRef;
    if (reference && !run.historyTokens.has(reference)) {
      run.unavailableReasons.set('memory', 'history_reference_unavailable'); done.push(settle(plan, 'unavailable')); continue;
    }
    if (!evidenceAllowed(deps, run, context.signal)) { done.push(settle(plan, 'unavailable')); continue; }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(RESEARCH.sourceDeadline.memory)]);
    try {
      run.ops++;
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
      const hits = Array.isArray(page['hits']) ? page['hits'].filter(isRecord) : [];
      for (const hit of hits) if (typeof hit['recordRef'] === 'string') run.historyTokens.add(hit['recordRef']);
      const lines = typeof page['text'] === 'string' ? [page['text']] : hits.map(hit => String(hit['snippet'] ?? ''));
      done.push({ ...settle(plan, lines.length ? 'ok' : 'empty', lines, Number(page['totalMatches'] ?? lines.length)), historyPage: page });
    } catch { done.push(settle(plan, signal.aborted ? 'timeout' : 'failed')); }
  }
  const reads = plans.filter(entry => entry.read.source !== 'memory');
  if (reads.length === 0) return done;
  const source = reads[0]!.read.source as SourceKind;
  const all = (outcome: LookupOutcome): RoutedOutcome[] => reads.map(plan => settle(plan, outcome));
  /** P5: an unreachable source names its reason in the reply, so an outage is never read as "nothing found". */
  const unserved = (outcome: LookupOutcome, reason: string): RoutedOutcome[] => {
    run.unavailableReasons.set(source, reason);
    return [...done, ...all(outcome)];
  };
  if (!context.configured.includes(source)) return unserved('unavailable', 'not_configured');
  // #351: a connector that cannot serve a read right now settles at once, never spending the batch deadline.
  if (context.unavailable.includes(source)) return unserved('unavailable', context.unavailableReason?.(source) ?? 'connector_unavailable');
  const remainingMs = run.deadlineMs - (context.now() - run.startedAt);
  if (remainingMs <= 0) return unserved('unavailable', 'deadline_exhausted');
  if (source === 'mail' && reads.every(plan => plan.read.subs.length === 1 && plan.read.subs[0]?.name === INTERNAL.mailList)) return mailGroup(deps, run, reads, context.signal, remainingMs, context.now);
  if (source === 'calendar') return calendarGroup(deps, run, reads, context.signal, remainingMs, context.now);
  const subs: IntentSubCall[] = [];
  const owned: number[][] = reads.map(() => []);
  const seen = new Map<string, number>();
  reads.forEach((plan, index) => {
    for (const sub of plan.read.subs) {
      // A sub two lookups would both issue (the calendar list serves every window) is dispatched once.
      const signature = `${sub.name}:${JSON.stringify(sub.args)}`;
      const existing = seen.get(signature);
      if (existing !== undefined) { owned[index]!.push(existing); continue; }
      subs.push(sub);
      owned[index]!.push(subs.length - 1);
      seen.set(signature, subs.length - 1);
    }
  });
  if (subs.length === 0) return unserved('unavailable', 'no_query');
  run.ops += Math.max(1, subs.length);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(lookupBound(source, reads.length, remainingMs))]);
  let results: IntentSubResult[];
  try { results = await deps.execute(subs, signal); }
  catch { return [...done, ...all(signal.aborted ? 'timeout' : 'failed')]; }
  // The execute contract returns one result per sub, in order, so each lookup keeps its own lines.
  const cutShort = signal.aborted;
  reads.forEach((plan, index) => {
    const own = owned[index]!.map(position => results[position]).filter((result): result is IntentSubResult => result !== undefined);
    const block = shapeBlock(plan.read.kind === 'memory_search' ? 'knowledge_search' : plan.read.kind, own);
    // P5-R5 (F1): the execute contract resolves `{ok: false, code}` for a sub-call the host did not
    // complete, so a returned failure is a failed read, never a search that matched nothing.
    const missed = own.some(result => !result.ok);
    const outcome: LookupOutcome = block.lines.length > 0 ? 'ok' : cutShort ? 'timeout' : missed ? 'failed' : 'empty';
    done.push({ ...settle(plan, outcome, block.lines, block.total), ...(own.length > 0 && own.every(result => result.ok && result.hostEvidence?.kind === 'remote-body') ? { bodyOnly: true } : {}) });
  });
  return done;
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
  deps.emit({ researchId: run.researchId, phase: 'started', sourcesDone: [], sourcesPending: [...configured], elapsedMs: 0 });
  // 3r R1 outcome 5: a routed read used to go silent until it returned. It now beats at the same
  // dead-air cadence as the loop, so the model and the owner hear the run is alive inside five seconds.
  const beat = (): void => {
    deps.emit({ researchId: run.researchId, phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs: Math.max(0, now() - started) });
  };
  let beatTimer: { unref(): void; cancel(): void } | undefined;
  const arm = (): void => { beatTimer = schedule(() => { beat(); arm(); }, RESEARCH.progressEveryMs); beatTimer.unref(); };
  arm();
  // N3: group by the read a lookup resolves to, so 'company' and 'mongoose', or 'replies' and 'chat',
  // share one execution; the group keeps the order in which each source first appeared.
  const readContext = { question, configured, run, now, ...(deps.timeZone ? { timeZone: deps.timeZone } : {}) };
  const groups = new Map<SourceKind | 'memory', RoutedPlan[]>();
  for (const lookup of lookups) {
    const plan: RoutedPlan = { lookup, read: routedRead(lookup, readContext) };
    const bucket = groups.get(plan.read.source) ?? [];
    bucket.push(plan);
    groups.set(plan.read.source, bucket);
  }
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
        event: 'research_source', researchId: run.researchId, source: outcome.lookup.source, outcome: outcome.outcome, ms: outcome.ms,
        deadlineMs: outcome.source === 'memory' ? RESEARCH.sourceDeadline.memory : lookupBound(outcome.source, batchSizes.get(outcome.source) ?? 1, run.deadlineMs),
        coalesced: batchSizes.get(outcome.source) ?? 1,
        ...(outcome.source === 'knowledge' ? { knowledge: knowledgeReceipt(outcome.lines) } : {}),
      });
      logSubcall({
        event: 'research_subcall', researchId: run.researchId, kind: outcome.kind, tool: outcome.tool,
        ok: outcome.outcome === 'ok' || outcome.outcome === 'empty',
        ...(outcome.outcome === 'ok' || outcome.outcome === 'empty' ? {} : { errorCode: outcome.outcome }),
        items: outcome.lines.length,
        // A routed read returns only the lines it kept, so raw and kept bytes are the same measure.
        rawBytes: outcome.lines.join('\n').length, keptBytes: outcome.lines.join('\n').length,
        queryChars: outcome.lookup.query.length, queryAuthor: 'routed',
      });
      const key = `routed:${outcome.lookup.source}:${outcome.lookup.query}`;
      if (outcome.source !== 'memory') run.ledger.set(key, { kind: outcome.kind, source: outcome.source, summary: outcome.lines.join('\n'), lines: outcome.lines, total: outcome.total, ...(outcome.bodyOnly ? { bodyOnly: true } : {}) });
      if (outcome.source === 'memory') {
        if (outcome.outcome === 'ok') run.sourcesDone.add('memory');
        else if (outcome.outcome === 'timeout') run.cutShort.add('memory');
        else if (outcome.outcome !== 'empty') run.sourcesFailed.add('memory');
        continue;
      }
      if (outcome.outcome === 'ok') { run.sourcesDone.add(outcome.source); run.sourcesFailed.delete(outcome.source); run.emptySearches.delete(outcome.source); run.cutShort.delete(outcome.source); }
      else if (outcome.outcome === 'empty') { run.emptySearches.set(outcome.source, ` for "${outcome.lookup.query.slice(0, 60)}"`); }
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
        first.historyPages = outcomes.flatMap(outcome => outcome.historyPage ? [outcome.historyPage] : []);
        const source = batch[0]?.source;
        if (source) {
          first.reading.delete(source);
          lateFindingsOf(deps, first, run.researchId, source, Math.max(...batch.map(outcome => outcome.ms)), [...new Set(batch.flatMap(outcome => outcome.lines))], batch.some(outcome => outcome.outcome === 'ok' || outcome.outcome === 'empty'), run.runId);
        }
      }));
    } finally {
      beatTimer?.cancel();
    }
    run.ended = true;
    const sources: JsonObject = {};
    for (const outcome of outcomes) sources[outcome.lookup.source] = outcome.outcome;
    const answered = outcomes.some(outcome => outcome.lines.length > 0);
    const cut = signal.aborted || run.stopped || run.cancelled;
    const status = cut ? 'stopped' : (answered ? 'answered' : 'partial');
    runStatus = cut ? 'failed' : (answered ? 'answered' : 'partial');
    runStop = cut ? 'cancelled' : (answered ? 'answered' : 'insufficient');
    deps.emit({ researchId: run.researchId, phase: 'done', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs: now() - started });
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    reply = buildReply(run, status, configured, false, limit, sources);
    const historyPages = outcomes.flatMap(outcome => outcome.historyPage ? [outcome.historyPage] : []);
    reply = withHistoryPages(reply, historyPages);
    logRouted({
      event: 'research_routed', researchId: run.researchId, sources: outcomes.map(outcome => outcome.lookup.source),
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
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: 1, perRound: [], stopReason: runStop, status: runStatus, ops: run.ops, sources: outcomes.map(outcome => ({ kind: outcome.source, disposition: outcome.outcome === 'ok' || outcome.outcome === 'empty' ? 'completed' : 'skipped', latencyMs: outcome.ms })), elapsedMs: Math.max(0, now() - started), deadAirMs: 0, selectorMs: 0, fallbackUsed: false, replyBytes: JSON.stringify(reply ?? {}).length, driver: 'routed', unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: reply?.['canContinue'] === true, findingChars: findings.map(finding => (finding.text ?? '').length) });
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
}

const lineKey = (line: string): string => line.trim().toLowerCase().replace(/\s+/gu, ' ');

/** R6: what this source returned that the first reply did not already say. Never an invented line. */
function lateFindingsOf(deps: ResearchDeps, first: FirstAnswerState, researchId: string, source: SourceKind, ms: number, lines: readonly string[], ok: boolean, runId?: number): void {
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
  deps.late?.({ researchId, ...(runId !== undefined ? { runId } : {}), ...(source === 'calendar' ? { calendarKeys } : {}), ...(mailKeys.length ? { mailKeys } : {}), source, ms, items, ok });
}

/**
 * R6: the call answers at the earlier of two moments: every source has settled, or `firstAnswerMs` with at
 * least one source's findings in hand. A call with nothing to say yet waits exactly as it always has.
 */
async function firstAnswerOf(deps: ResearchDeps, first: FirstAnswerState, loop: Promise<JsonObject>): Promise<JsonObject | undefined> {
  const schedule = deps.schedule ?? scheduleTimer;
  let cancel = (): void => {};
  const due = new Promise<'due'>(resolve => { cancel = schedule(() => resolve('due'), RESEARCH.firstAnswerMs).cancel; });
  const raced = await Promise.race([loop.then(() => 'settled' as const, () => 'settled' as const), due]);
  cancel();
  if (raced === 'settled') return undefined;
  const view = first.snapshot?.();
  if (view === undefined) return undefined;
  const found = [...view.run.ledger.values()].flatMap(entry => entry.lines ?? []).concat([...view.run.calendar.values()].flatMap(read => [...read.events.values()].map(event => event.line)), [...mailMessages(view.run).values()].map(message => message.line));
  // No source has findings yet, so there is no answer to give: the call waits, as today, to its own budget.
  if (found.length === 0 && !first.historyPages?.some(page => typeof page['text'] === 'string' && page['text'].length > 0 || Array.isArray(page['hits']) && page['hits'].length > 0)) return loop;
  const pending = [...first.reading].filter(source => !view.run.sourcesDone.has(source));
  if (!evidenceAllowed(deps, view.run, new AbortController().signal)) return deniedEvidence(deps, view.run);
  const reply = withHistoryPages(buildReply(view.run, 'partial', view.configured, false, view.limit), first.historyPages ?? []);
  first.mailShown = new Set((reply as MailReply)[mailDelivery]?.keys ?? []);
  const shown = Array.isArray(reply['findings']) ? reply['findings'] as { text?: string }[] : [];
  for (const finding of shown) for (const line of (finding.text ?? '').split('\n').slice(1)) first.seen.add(lineKey(line));
  for (const read of view.run.calendar.values()) for (const event of read.events.values()) if (shown.some(finding => finding.text?.includes(event.line))) first.seen.add(lineKey(event.line));
  for (const page of first.historyPages ?? []) {
    if (typeof page['text'] === 'string') first.seen.add(lineKey(page['text']));
    if (Array.isArray(page['hits'])) for (const hit of page['hits']) if (isRecord(hit) && typeof hit['snippet'] === 'string') first.seen.add(lineKey(hit['snippet']));
  }
  first.at = deps.now();
  const researchId = typeof reply['researchId'] === 'string' ? reply['researchId'] : '';
  (deps.logFirstAnswer ?? ((event: ResearchFirstAnswer): void => { hostLogEvent(event); }))({ event: 'research_first_answer', researchId, ms: RESEARCH.firstAnswerMs, settled: [...view.run.sourcesDone], pending });
  return { ...reply, pending };
}

/** The bounded loop. One call runs it start to finish within the run deadline. */
export async function runResearch(deps: ResearchDeps, call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
  const first: FirstAnswerState = { mailShown: new Set(), seen: new Set(), delivered: new Set(), reading: new Set() };
  const loop = runResearchLoop(deps, call, signal, first);
  const early = await firstAnswerOf(deps, first, loop);
  if (early === undefined) { const reply = await loop; if (!deps.authorizeEvidence) markCalendarReply(deps.ledger, reply); return reply; }
  // The call answers now. The readers keep going to their own deadlines, so their findings still land.
  deps.background?.(loop.then(() => undefined, () => undefined));
  if (!deps.authorizeEvidence) markCalendarReply(deps.ledger, early);
  return early;
}

/** The loop behind a call: unchanged by the first answer point except for what it reports late. */
async function runResearchLoop(deps: ResearchDeps, call: ResearchCall, signal: AbortSignal, first: FirstAnswerState): Promise<JsonObject> {
  let limit = deps.replyLimit ?? RESEARCH.replyLimitChars;
  // Q5-R1: a read of a named entry widens the reply to the connector's knowledge body cap, so the
  // body the owner asked for is never trimmed away for the length of a search reply.
  const widenFor = (subs: readonly IntentSubCall[]): void => {
    if (subs.some(sub => sub.name === INTERNAL.knowledgeRead)) limit = Math.max(limit, RESEARCH.readReplyChars);
  };
  const now = () => deps.now();
  const configured = (deps.configuredNow ?? (() => deps.configured))();
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
    deps.emit({ researchId: run.researchId, phase: 'stopped', sourcesDone: [...run.sourcesDone], sourcesPending: [], elapsedMs: Math.max(0, now() - run.startedAt) });
    const reply = buildReply(run, 'stopped', configured, false, limit);
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: run.rounds, perRound: [], stopReason: 'stop', status: 'stopped', ops: run.ops, sources: [], elapsedMs: Math.max(0, now() - run.startedAt), deadAirMs: 0, selectorMs: 0, fallbackUsed: false, replyBytes: JSON.stringify(reply).length, unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: false, findingChars: [] });
    return reply;
  }

  const question = call.question?.trim() ?? '';
  let run: RunState;
  if (call.action === 'start') {
    deps.ledger.cancelActive();
    run = deps.ledger.begin({ researchId: call.researchId, questionClass: 'cross_source', deadlineMs: RESEARCH.startDeadlineMs, maxRounds: RESEARCH.startRounds, now: now() });
  } else {
    if (call.cursor !== undefined) {
      const prior = deps.ledger.find(call.researchId ?? '');
      const bodyPage = prior?.bodyCursors.get(call.cursor);
      if (prior && bodyPage) {
        if (!evidenceAllowed(deps, prior, signal)) return deniedEvidence(deps, prior);
        const body = prior.bodies.get(bodyPage.key);
        if (!body || body.evidence.expiresAt <= Date.now()) { deps.ledger.stop(prior.researchId); return { researchId: prior.researchId, error: 'continuation_unavailable', findings: [], canContinue: false }; }
        if (bodyPage.delivered) return { researchId: prior.researchId, status: 'partial', findings: [], alreadyDelivered: true, delivery: 'model-context', cursor: call.cursor, ...(bodyPage.nextCursor ? { nextCursor: bodyPage.nextCursor } : {}), canContinue: bodyPage.canContinue ?? Boolean(bodyPage.nextCursor) };
      } else {
        const page = prior?.mailCursors.get(call.cursor);
      if (!prior || !page || !evidenceAllowed(deps, prior, signal)) return { researchId: call.researchId ?? '', error: 'continuation_unavailable', findings: [], canContinue: false };
      if (page.scope !== mailScope(prior) || page.ids.length === 0 && !page.delivered && page.sourceState !== mailSourceState(prior)) return { researchId: prior.researchId, error: 'continuation_unavailable', findings: [], canContinue: true, note: 'This source coordinate has already advanced. Use nextCursor from the latest reply or continue this researchId without a cursor for retained evidence.' };
      if (page.delivered) return { researchId: prior.researchId, status: page.partial ? 'partial' : 'answered', findings: [], alreadyDelivered: true, delivery: 'model-context', cursor: call.cursor, deliveredMessageIds: page.ids, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), canContinue: Boolean(page.nextCursor) };
      }
    }
    const resumed = deps.ledger.resume(call.researchId ?? '', { direction: call.direction, deadlineMs: RESEARCH.continueDeadlineMs, maxRounds: RESEARCH.continueRounds, now: now() });
    if (!resumed) return { researchId: call.researchId ?? '', status: 'unavailable', findings: [], canContinue: false, note: 'This research run is no longer available. Start a new lookup.' };
    run = resumed;
  }
  run.direction = call.direction ?? run.direction;
  if (call.cursor !== undefined) { if (run.bodyCursors.has(call.cursor)) run.bodyCursorRequested = call.cursor; else run.mailCursorRequested = call.cursor; }
  const executeSource = deps.execute, emitProgress = deps.emit;
  const running = new Map<SourceKind, number>(), completed = new Set<SourceKind>(run.sourcesDone);
  const current = (): boolean => !run.cancelled && !run.stopped && deps.ledger.find(run.researchId) === run;
  const emit = (event: ResearchProgress): void => {
    if (current()) emitProgress({ ...event, sourcesDone: [...completed].filter(source => !running.has(source)), sourcesPending: [...running.keys()] });
  };
  const update = (): void => emit({ researchId: run.researchId, phase: 'round', sourcesDone: [], sourcesPending: [], elapsedMs: Math.max(0, now() - run.startedAt) });
  let invocation = 0;
  deps = { ...deps, emit, execute: async (subs, sourceSignal) => {
    const mailOnly = subs.length > 0 && subs.every(sub => sub.name === INTERNAL.mailRead || sub.name === INTERNAL.mailList);
    if (mailOnly) run.mailDeadlineAt ??= now() + Math.min(RESEARCH.sourceDeadline.mail, Math.max(1, run.deadlineMs - (now() - run.startedAt)));
    const dispatchSignal = mailOnly ? AbortSignal.any([sourceSignal, AbortSignal.timeout(Math.max(1, (run.mailDeadlineAt ?? now()) - now()))]) : sourceSignal;
    if (!current() || dispatchSignal.aborted) return subs.map(sub => ({ key: sub.key, name: sub.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'round_cancelled' }));
    const at = now(), batch = ++invocation;
    const sources = [...new Set(subs.map(sub => sourceKindOfKindName(sub.name)).filter((source): source is SourceKind => source !== null))];
    const steps = sources.map(source => {
      const sub = subs.find(sub => sourceKindOfKindName(sub.name) === source)!;
      const subject = stepSubject(sub.args);
      const action = /search|list|find|history/.test(sub.name) ? 'search' : 'read';
      return { callId: stepCallId, stepId: `${run.researchId}:${run.runId}:${stepCallId}:${batch}:${source}`, source, action, ...(subject ? { subject } : {}) };
    });
    for (const step of steps) { running.set(step.source, (running.get(step.source) ?? 0) + 1); publishStep({ ...step, phase: 'start' }); }
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
        if (count > 0) running.set(step.source, count); else running.delete(step.source);
        if (ok) completed.add(step.source);
        const resultCount = own.reduce((count, result) => count + (result?.ok ? result.mailPage?.messages.length ?? result.calendarPage?.events.length ?? (Array.isArray(result.historyPage?.['hits']) ? result.historyPage['hits'].length : shapeBlock(shapeKindOf(step.source, 'knowledge_search'), [result]).total) : 0), 0);
        publishStep({ ...step, phase: 'end', ok, ...(ok ? { resultCount } : {}), ...(code ? { errorCode: code } : {}), ms: Math.max(0, now() - at) });
      }
      update();
    };
    const progressSignal = AbortSignal.any([dispatchSignal, run.progressAbort.signal]);
    const aborted = (): void => finish([], dispatchSignal.aborted && dispatchSignal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
    progressSignal.addEventListener('abort', aborted, { once: true });
    if (progressSignal.aborted) aborted();
    let results: IntentSubResult[];
    try { results = await executeSource(subs, dispatchSignal); finish(results, current() ? undefined : 'cancelled'); }
    catch (error) { finish([], 'failed'); throw error; }
    finally { progressSignal.removeEventListener('abort', aborted); }
    const fresh = results.flatMap(result => result.binding ? [result.binding] : []);
    if (run.stopped || run.cancelled || dispatchSignal.aborted || deps.ledger.find(run.researchId) !== run) {
      deps.ledger.discardEvidence(fresh);
      return results.map(result => { const { hostEvidence: _evidence, ...rest } = result; return { ...rest, ok: false, text: '', code: 'round_cancelled' }; });
    }
    for (const result of results) {
      if (!result.ok || !result.binding || result.hostEvidence?.kind !== 'remote-body') continue;
      const evidence = result.hostEvidence;
      const source: SourceKind = result.name === INTERNAL.mailRead ? 'mail' : result.name === INTERNAL.knowledgeRead ? 'knowledge' : 'mongoose';
      if (!run.bodies.has(result.binding.result.id)) run.bodies.set(result.binding.result.id, { evidence, binding: result.binding, source, offset: 0 });
    }
    return results;
  } };
  first.snapshot = () => ({ run, configured, limit });

  if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
  if (call.action === 'continue' && [...run.bodies.values()].some(body => body.offset < body.evidence.body.length) && call.lookups === undefined) return buildReply(run, 'partial', configured, false, limit);
  if (call.action === 'continue' && run.mail.size > 0 && call.lookups === undefined) {
    const pendingLocal = [...mailMessages(run).keys()].some(key => !run.mailDelivered.has(key));
    if (!pendingLocal) await collectMail(deps, run, signal, Math.min(RESEARCH.sourceDeadline.mail, run.deadlineMs), now);
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    return buildReply(run, 'answered', configured, false, limit);
  }
  if (call.action === 'continue' && run.calendar.size > 0 && call.lookups === undefined) {
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    const pendingLocal = [...run.calendar.values()].some(read => [...read.events].some(([key]) => !run.calendarDelivered.has(key)));
    if (!pendingLocal) await collectCalendar(deps, run, signal, Math.min(RESEARCH.sourceDeadline.calendar, run.deadlineMs), now);
    if (!evidenceAllowed(deps, run, signal)) return deniedEvidence(deps, run);
    return buildReply(run, 'answered', configured, false, limit);
  }

  // K6: a routed start names its own layers, so the selector is skipped and every lookup runs at once.
  const lookups = normalizeLookups(call.lookups);
  if (call.action === 'continue' && run.historyTokens.size > 0 && lookups.length === 0) return { researchId: run.researchId, status: 'partial', findings: [], canContinue: true, note: 'Continue local history with a memory lookup containing history.recordRef or history.cursor from historyPages.' };
  if (lookups.length > 0) return routedResearch(deps, run, question, lookups, configured, unavailable, unavailableReason, signal, now, limit, first);

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
    deps.emit(progress);
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

  // RD/P5-R1: a start call answers, or reports its honest partial, inside its own budget. The bound is one
  // cut for the whole run, so the prime-source read that starts before the selector is bounded too.
  const answerCut = new AbortController();
  const hint = hintedSources(call.sources, configured);
  let answerMs = researchCallBudgetMs(hint.length > 0 ? hint : []);
  let answerTimer = call.action === 'start' ? schedule(() => answerCut.abort(), answerMs) : { unref: () => {}, cancel: () => {} };
  /**
   * P5-R1: the call budget is the slowest source this call reads plus the slack, capped. A batch that
   * carries a 12 s connector read may not be cut by a local read's smaller budget, and a batch of
   * local reads only is never widened for a slow source it does not read.
   */
  const allowAnswer = (sources: readonly SourceKind[]): void => {
    if (call.action !== 'start') return;
    const wanted = researchCallBudgetMs(sources);
    if (wanted <= answerMs) return;
    answerMs = wanted;
    answerTimer.cancel();
    answerTimer = schedule(() => answerCut.abort(), Math.max(0, answerMs - (now() - started)));
  };
  // Outcome 5: the owner's knowledge base is the prime source. Its read starts immediately, in
  // parallel with source selection, unless the owner named one certain non-knowledge source.
  const knowledgeSubs = candidateSubs('knowledge_search', { question, configured, evidence: run.evidence });
  widenFor(knowledgeSubs);
  const knowledgeWanted = configured.includes('knowledge') && knowledgeSubs.length > 0 && !run.readKinds.has('knowledge_search')
    && !(hint.length === 1 && hint[0] !== 'knowledge');
  let knowledgeStartedAt = 0;
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
          knowledgePromise = deps.execute(knowledgeSubs, AbortSignal.any([signal, AbortSignal.timeout(remainingMs), answerCut.signal])).catch(() => [] as IntentSubResult[]);
        }
      }

      const completedKinds = [...run.readKinds];
      const offerable = offerableCandidates(configured, completedKinds);
      let selection: SelectorOutput;
      let usedFallbackThisRound = false;
      let narrowed: CandidateKind[] | undefined;
      // A single-source hint pins the whole run to that one source, so the selector is never called,
      // in any round: once the source is read there is nothing left to select.
      if (hint.length === 1) {
        const source = hint[0]!;
        narrowed = offerable.filter(kind => CANDIDATES.find(c => c.kind === kind)?.source === source);
        if (driver === undefined) driver = 'single-source-hint';
      }
      const candidatesForSelector = narrowed ?? offerable;
      if (narrowed !== undefined) {
        // Outcome 6: one certain source is deterministic; skip the selector call entirely.
        selection = fallbackSelection(question || run.direction || '', configured, now());
      } else if (deps.selector === undefined) {
        fallbackUsed = true;
        usedFallbackThisRound = true;
        selection = fallbackSelection(question || run.direction || '', configured, now());
        if (driver === undefined) driver = 'fallback';
      } else {
        const selStart = now();
        let output: SelectorOutput | null = null;
        try {
          output = await deps.selector.select({ question, questionClass: run.questionClass, direction: run.direction, configured, completed: [...run.ledger.values()].flatMap(entry => entry.kind === 'memory_search' ? [] : [{ kind: entry.kind, summary: entry.summary }]), candidates: candidatesForSelector }, AbortSignal.any([signal, AbortSignal.timeout(RESEARCH.selectorDeadlineMs)]));
        } catch { output = null; }
        selectorMs += now() - selStart;
        if (output === null) { fallbackUsed = true; usedFallbackThisRound = true; selection = fallbackSelection(question || run.direction || '', configured, now()); if (driver === undefined) driver = 'fallback'; }
        else { if (driver === undefined) driver = 'selector'; if (output.actions.length === 0) { selection = output; stopReason = output.questionClass === 'quick_fact' ? 'answered' : 'selector_stop'; } else selection = output; }
      }

      // A single-source hint must always run that source, even when the question carried no terms
      // the fallback could match (an empty or terse spoken question): seed the hinted searches.
      if (narrowed !== undefined) {
        const text = question || run.direction || '';
        for (const kind of narrowed) {
          if (selection.actions.some(action => action.kind === kind)) continue;
          selection.actions.push({ kind, ...fallbackQuery(kind, text, now()) });
          selection.pUseful[kind] = 0.6;
        }
      }

      if (run.ledger.size === 0 && question) run.questionClass = selection.questionClass;
      run.questionClass = selection.questionClass;

      // One round reads each candidate once: a selector that repeats an action is deduplicated here.
      const chosen = [...new Set(selection.actions.map(action => action.kind).filter(kind => candidatesForSelector.includes(kind)))];
      // Outcome 5: the pre-started knowledge read is included even when the selector did not pick it,
      // so the prime source is always read once and its findings can rank first.
      if (knowledgePromise !== undefined && !knowledgeConsumed && !chosen.includes('knowledge_search') && candidatesForSelector.includes('knowledge_search')) chosen.push('knowledge_search');
      perRound.push({ candidates: offerable.map(kind => ({ kind, pUseful: selection.pUseful[kind] ?? 0 })), chosen: [...chosen] });

      if (chosen.length === 0) { stopReason = selection.actions.some(a => a.kind === 'stop_insufficient') ? 'insufficient' : 'answered'; run.rounds = round; break; }

      // Run this round's chosen actions in parallel, bounded by maxConcurrent and maxOps.
      const toRun: CandidateKind[] = [];
      for (const kind of chosen) {
        if (run.ops >= RESEARCH.maxOps) { stopReason = 'ops_exhausted'; break; }
        toRun.push(kind);
        run.ops += Math.max(1, kind === 'calendar_window' ? 1 : candidateSubs(kind, { question, configured, evidence: run.evidence }).length);
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
        allowAnswer(batchSources);
        const remainingMs = batchDeadline - now();
        if (remainingMs <= 0) { stopReason = 'deadline'; break; }
        // RD/P5-R1: a start call answers inside its budget, so the owner hears a reply instead of waiting on
        // the slowest connector. A continue call is an explicit follow-up and keeps the run deadline.
        const roundSignal = AbortSignal.any([signal, AbortSignal.timeout(remainingMs), answerCut.signal]);
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
          try { subs = candidateSubs(kind, { question, configured, evidence: run.evidence, query: action?.query, window: action?.window, nowMs: now(), timeZone: deps.timeZone }); }
          catch { run.unavailableReasons.set('calendar', 'unresolved_window'); run.sourcesFailed.add('calendar'); return; }
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
          const readDeadlineMs = sourceDeadlineMs(startSources);
          const cutTimer = schedule(() => { if (!latencies.has(kind)) { cutKinds.add(kind); cut.abort(new DOMException('Source deadline elapsed', 'TimeoutError')); } }, Math.max(0, Math.min(readDeadlineMs, batchDeadline - now())));
          // Identical duplicate reads are deduplicated: a read this run already issued is reused, never
          // sent twice, so the connector is asked one question once.
          const issued = served.filter(call => !run.calls.has(callSignature(call)));
          if (issued.length === 0) return;
          for (const call of issued) run.calls.add(callSignature(call));
          const consumeKnowledge = kind === 'knowledge_search' && knowledgePromise !== undefined && !knowledgeConsumed;
          const at = consumeKnowledge ? knowledgeStartedAt : now();
          // Q1-R3(e): one retry for a transient failed sub-call, inside the round deadline.
          const executeWithRetry = async (list: IntentSubCall[]): Promise<IntentSubResult[]> => {
            let out: IntentSubResult[] = [];
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
          const ordinaryCalls = issued.filter(call => call.name !== INTERNAL.calendarList && call.name !== INTERNAL.mailList);
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
              return { key: call.key, name: call.name, ok: Boolean(read && (read.events.size > 0 || read.exhausted)), text, originalCharacters: text.length, omittedCharacters: 0 };
            });
          };
          const mailResults = async (): Promise<IntentSubResult[]> => {
            if (mailCalls.length === 0) return [];
            run.ops -= mailCalls.length;
            const reads = mailCalls.map(call => mailRead(run, call.args));
            await collectMail(deps, run, readSignal, Math.min(readDeadlineMs, deadlineAt - now()), now);
            return mailCalls.map((call, n) => {
              const read = reads[n]!, text = [...read.messages.values()].map(message => message.line).join('\n');
              return { key: call.key, name: call.name, ok: read.messages.size > 0 || read.exhausted, text, originalCharacters: text.length, omittedCharacters: 0 };
            });
          };
          let results: IntentSubResult[];
          if (consumeKnowledge) results = (knowledgeConsumed = true, await knowledgePromise!);
          else {
            const [ordinary, calendar, mail] = await Promise.all([ordinaryCalls.length ? executeWithRetry(ordinaryCalls) : Promise.resolve([]), calendarResults(), mailResults()]);
            const byKey = new Map([...ordinary, ...calendar, ...mail].map(result => [result.key, result]));
            // Production execute keys include the host call id, so preserve source positions for ordinary results.
            ordinaryCalls.forEach((call, n) => { if (ordinary[n]) byKey.set(call.key, ordinary[n]!); });
            results = issued.map(call => byKey.get(call.key)).filter((result): result is IntentSubResult => result !== undefined);
          }
          // R6: a source with real text is its own credit; the rest of the round still finishes.
          if (!answeredRound && !cut.signal.aborted && results.some(result => result.ok && result.text.trim())) answeredRound = true;
          // Host-side second hops inside the same run: hydrate the top knowledge hits, open the top
          // mails when the question asks what a mail says, and fetch the thread of the top chat hit.
          const second: IntentSubCall[] = [];
          const primaryText = results.filter(result => result.ok).map(result => result.text).join('\n');
          if (kind === 'knowledge_search') {
            const complete = completeKnowledgeIds(results);
            const ids = extractInsightIds(primaryText, RESEARCH.knowledgeHits).filter(id => !complete.has(id)).slice(0, 3);
            if (ids.length) second.push({ key: 'kz', name: INTERNAL.knowledgeRead, args: { ids } as JsonObject });
          }
          if (kind === 'mail_search' && /what|who wrote|say|says|read|content|mean|about/i.test(question)) {
            const ids = [...primaryText.matchAll(/\[id ([A-Za-z0-9_-]+)\]/g)].map(match => match[1]!).slice(0, 2);
            ids.forEach((id, index) => second.push({ key: `mo${index}`, name: INTERNAL.mailRead, args: { id } }));
          }
          if (kind === 'chat_search') {
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
            const block = shapeBlock(shapeKindOf(part.source, kind), part.results);
            run.ledger.set(parts.length === 1 ? key : `${key}#${part.source ?? index}`, { kind, source: part.source, summary: block.text, lines: block.lines, total: block.total, ...(part.results.length > 0 && part.results.every(result => result.ok && result.hostEvidence?.kind === 'remote-body') ? { bodyOnly: true } : {}) });
            if (part.source === null) continue;
            if (part.results.some(result => result.ok && result.text.trim())) {
              run.sourcesDone.add(part.source); run.sourcesFailed.delete(part.source); run.emptySearches.delete(part.source);
            } else if (part.results.some(result => result.ok)) {
              // The connector answered and matched nothing: that is a search, not an outage.
              run.sourcesDone.add(part.source); run.sourcesFailed.delete(part.source);
              run.emptySearches.set(part.source, queryShapeOf(served));
            } else if (!run.sourcesDone.has(part.source)) run.sourcesFailed.add(part.source);
            // P5 outcome 4: one receipt per source read, with the deadline it was actually given.
            logSource({
              event: 'research_source', researchId: run.researchId, source: lookupSourceOf(part.source),
              outcome: block.lines.length > 0 ? 'ok' : cut.signal.aborted ? 'timeout' : part.results.some(result => !result.ok) ? 'failed' : 'empty',
              ms: Math.max(0, now() - at), deadlineMs: sourceDeadlineMsOfRead, coalesced: 1,
              ...(part.source === 'knowledge' ? { knowledge: knowledgeReceipt(block.lines) } : {}),
            });
            // R6: this source settled after the call had already answered, so what it found is handed over
            // once, and only if the first reply did not already say it.
            first.reading.delete(part.source);
            lateFindingsOf(deps, first, run.researchId, part.source, Math.max(0, now() - at), block.lines, part.results.some(result => result.ok), run.runId);
          }
          // A source that answered counts as read, so an empty result is never re-offered as pending.
          if (results.some(result => result.ok)) run.readKinds.add(kind);
          const id = extractId(kind, results.filter(result => result.ok).map(result => result.text).join('\n'));
          if (id) run.evidence.set(kind, id);
          const queryAuthor: 'selector' | 'fallback' = usedFallbackThisRound ? 'fallback' : 'selector';
          // Log the primary sub-calls and the host-side second hops (hydrate/open/thread) together:
          // `results` is `[...issued, ...freshSecond]`, so position is the stable key.
          for (const [index, sub] of [...issued, ...freshSecond].entries()) {
            const result = results[index];
            const raw = sub.args['query'] ?? sub.args['q'];
            const calText = result?.text ?? '';
            const partial = /\[calendar read incomplete: (\d+) calendars? not read\]/.exec(calText);
            logSubcall({
              event: 'research_subcall', researchId: run.researchId, kind, tool: sub.name,
              ok: result?.ok ?? false, ...(result !== undefined && !result.ok && result.code !== undefined ? { errorCode: result.code } : {}),
              items: result ? itemLines(result.text).length : 0,
              rawBytes: result?.originalCharacters ?? 0, keptBytes: result?.text.length ?? 0,
              queryChars: typeof raw === 'string' ? raw.length : 0, queryAuthor,
              ...(kind === 'calendar_window' ? { window: windowKind(action?.window ?? 'today') } : {}),
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

        for (const kind of batch) sourceLog.push({ kind: sourceKindOf(kind) ?? 'knowledge', disposition: cutKinds.has(kind) || !latencies.has(kind) ? 'skipped' : 'completed', latencyMs: latencies.get(kind) ?? 0 });
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
    const canContinue = !run.stopped && !run.cancelled && run.rounds < run.maxRounds && configured.some(source => !run.sourcesDone.has(source) && !run.sourcesFailed.has(source));
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
    // A run that threw before it selected anything names no driver: the key is omitted, never passed undefined,
    // because the host log refuses a line whose driver is not one of the four.
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: run.rounds, perRound, stopReason: runFailed ? 'failed' : stopReason, status: runFailed ? 'failed' : status, ops: run.ops, sources: sourceLog, elapsedMs, deadAirMs: worstGapMs, selectorMs, fallbackUsed, replyBytes: JSON.stringify(reply ?? {}).length, ...(driver === undefined ? {} : { driver }), unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: reply?.['canContinue'] === true, findingChars: findings.map(finding => (finding.text ?? '').length) });
  }
}

export function newResearchId(): string { return randomUUID(); }

/** A new research call while another is pending answers the old call with this tiny stub at once. */
export function supersededStub(researchId: string, configured: readonly SourceKind[]): JsonObject {
  return { researchId, status: 'partial', findings: [], unchecked: [...configured], canContinue: true, superseded: true };
}

/** What is known now for a researchId, without waiting on the loop. */
export function knownReply(ledger: ResearchLedger, researchId: string, configured: readonly SourceKind[], status: 'answered' | 'partial' | 'stopped' | 'unavailable' = 'stopped', limit = RESEARCH.replyLimitChars): JsonObject {
  const run = ledger.find(researchId);
  if (!run) return { researchId, status, findings: [], unchecked: [...configured], canContinue: false };
  return buildReply(run, status, configured, false, limit);
}

interface Deferred { promise: Promise<JsonObject>; resolve: (reply: JsonObject) => void }
function startSignature(call: ResearchCall): string {
  return JSON.stringify([call.question?.trim() ?? '', call.sources?.trim() ?? '', call.direction?.trim() ?? '', normalizeLookups(call.lookups)]);
}
type ActiveRun = {
  signature?: string;
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
  constructor(deps: ResearchDeps) { this.#deps = deps; }

  call(call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
    if (call.action === 'start') {
      const inflight = this.#resolveTarget(undefined);
      if (inflight !== undefined && inflight.entry.signature === startSignature(call)) {
        this.#deps.logJoined?.(inflight.id);
        return inflight.entry.awaiter.promise;
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
      return this.#drive({ ...call, researchId: id }, signal, id);
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
        return Promise.resolve(knownReply(this.#deps.ledger, target.id, this.#deps.configured));
      }
      // continue: stop the old loop, run on with a fresh budget reusing the ledger.
      return this.#drive({ ...call, action: 'continue', researchId: target.id }, signal, target.id);
    }
    // Zero or several pending runs: current behaviour.
    if (call.action === 'stop') {
      const run = this.#deps.ledger.stop(call.researchId);
      const id = run?.researchId ?? call.researchId ?? '';
      if (run) this.#deps.emit({ researchId: id, phase: 'stopped', sourcesDone: [...run.sourcesDone], sourcesPending: [], elapsedMs: Math.max(0, this.#deps.now() - run.startedAt) });
      return Promise.resolve(knownReply(this.#deps.ledger, id, this.#deps.configured));
    }
    const id = call.researchId ?? newResearchId();
    return this.#drive({ ...call, researchId: id }, signal, id);
  }

  /** The run a continue or stop applies to: the named run, or the only pending run (R1-R3). */
  #resolveTarget(researchId: string | undefined): { id: string; entry: ActiveRun } | undefined {
    if (researchId !== undefined) { const entry = this.#active.get(researchId); return entry === undefined ? undefined : { id: researchId, entry }; }
    if (this.#active.size === 1) { const [id, entry] = [...this.#active.entries()][0]!; return { id, entry }; }
    return undefined;
  }

  #drive(call: ResearchCall, signal: AbortSignal, id: string): Promise<JsonObject> {
    const awaiter = deferred();
    const entry: ActiveRun = { superseded: false, awaiter, ...(call.action === 'start' ? { signature: startSignature(call) } : {}) };
    this.#active.set(id, entry);
    // R6/M2: a call that answered ahead of its readers is still the run those readers belong to, so stop
    // and continue must find it. The entry leaves the active set only when the run itself has ended.
    const deps: ResearchDeps = { ...this.#deps, background: done => {
      entry.reading = done;
      this.#deps.background?.(done);
    } };
    const settle = (): void => { if (this.#active.get(id) === entry) this.#active.delete(id); };
    runResearch(deps, call, signal).then(reply => {
      if (!entry.superseded) awaiter.resolve(reply);
      if (entry.reading === undefined) settle(); else void entry.reading.then(settle, settle);
    }).catch(() => {
      if (!entry.superseded) awaiter.resolve({ error: 'research_failed' });
      if (entry.reading === undefined) settle(); else void entry.reading.then(settle, settle);
    });
    return awaiter.promise;
  }
}
