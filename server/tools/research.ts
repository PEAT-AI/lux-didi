import { randomUUID } from 'node:crypto';
import type { JsonObject, ModelPort, ModelRequest } from '../adapters/model/types.js';
import { INTERNAL, type IntentSubCall, type IntentSubResult } from './intent.js';
import { hostLogEvent } from './host-events.js';

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
export type SourceKind = 'knowledge' | 'calendar' | 'mail' | 'chat' | 'mongoose';
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
  mailSnippetChars: 200, chatTextChars: 300, knowledgeBodyChars: 1_200, openedBodyChars: 1_500,
});

export const RESEARCH_SOURCES: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];

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

export function lambdaAt(elapsedMs: number): number {
  for (const band of RESEARCH.lambda) if (elapsedMs <= band.upToMs) return band.value;
  return 1.5;
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
  + 'calendar_window: set window to today, tomorrow, week, or a date as YYYY-MM-DD. ';

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

const WINDOW_NAMES = new Set(['today', 'tomorrow', 'week']);
const WINDOW_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar window: today, tomorrow, week or an ISO date, else undefined. */
export function normalizeWindow(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim().toLowerCase();
  return WINDOW_NAMES.has(token) || WINDOW_DATE.test(token) ? token : undefined;
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
      if (window !== undefined) action.window = window;
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

function localOffset(date: Date): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function isoLocal(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}${localOffset(date)}`;
}

/** The RFC3339 window a calendar read asks for, in the host timezone. */
export function windowRange(window: string, nowMs: number): { timeMin: string; timeMax: string } {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (window === 'tomorrow') { start.setDate(start.getDate() + 1); end.setTime(start.getTime()); end.setDate(end.getDate() + 1); }
  else if (window === 'week') { end.setDate(end.getDate() + 7); }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(window)) {
    const parts = window.split('-').map(Number);
    start.setFullYear(parts[0]!, parts[1]! - 1, parts[2]!);
    end.setTime(start.getTime()); end.setDate(end.getDate() + 1);
  } else { end.setDate(end.getDate() + 1); }
  return { timeMin: isoLocal(start), timeMax: isoLocal(end) };
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
    const text = question.toLowerCase();
    if (/tomorrow/.test(text)) return { window: 'tomorrow' };
    if (/week/.test(text)) return { window: 'week' };
    return { window: 'today' };
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

/** The internal sub-calls one candidate issues. `brief` fans out over every configured source. */
export function candidateSubs(kind: CandidateKind, config: { question: string; configured: readonly SourceKind[]; evidence: ReadonlyMap<CandidateKind, string>; query?: string | undefined; window?: string | undefined; nowMs?: number | undefined }): IntentSubCall[] {
  const search = (name: string, args: JsonObject, key: string): IntentSubCall => ({ key, name, args });
  const keywords = contentKeywords(config.question).join(' ');
  if (kind === 'knowledge_search') return [search(INTERNAL.knowledgeSearch, { query: config.query ?? (keywords || 'recent notes'), limit: RESEARCH.knowledgeLines }, 'k0')];
  if (kind === 'calendar_window') {
    // One call covers every selected calendar: the connector resolves the set and merges the reads.
    const range = windowRange(config.window ?? 'today', config.nowMs ?? Date.now());
    return [search(INTERNAL.calendarList, { timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.calendarLines }, 'cal0')];
  }
  if (kind === 'mail_search') return [search(INTERNAL.mailList, { q: config.query ?? 'in:inbox newer_than:2d', maxResults: RESEARCH.mailLines }, 'm0')];
  if (kind === 'mail_open') { const id = config.evidence.get('mail_search'); return id ? [search(INTERNAL.mailRead, { id }, 'mo0')] : []; }
  if (kind === 'chat_search') return [search(INTERNAL.chatSearch, { query: config.query ?? 'after:yesterday', limit: RESEARCH.chatLines }, 'c0')];
  if (kind === 'chat_thread') { const id = config.evidence.get('chat_search'); return id ? [search('mattermost_get_thread', { post_id: id }, 'ct0')] : []; }
  if (kind === 'brief') {
    const subs: IntentSubCall[] = [];
    // The calendar read is the merged event read, not the calendar-name list: a brief that only
    // named the calendars delivered no calendar finding at all.
    if (config.configured.includes('calendar')) {
      const range = windowRange('today', config.nowMs ?? Date.now());
      subs.push(search(INTERNAL.calendarList, { timeMin: range.timeMin, timeMax: range.timeMax, maxResults: RESEARCH.calendarLines }, 'b0'));
    }
    if (config.configured.includes('mail')) subs.push(search(INTERNAL.mailList, { q: 'newer_than:2d' }, 'b1'));
    if (config.configured.includes('chat')) subs.push(search(INTERNAL.chatSearch, { query: 'after:yesterday', limit: RESEARCH.chatLines }, 'b2'));
    if (config.configured.includes('knowledge')) subs.push(search(INTERNAL.knowledgeSearch, { query: keywords || 'open loop follow up', limit: RESEARCH.knowledgeLines }, 'b3'));
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

export interface LedgerEntry { kind: CandidateKind; source: SourceKind | null; summary: string; lines?: string[]; total?: number }
export interface RunState {
  researchId: string; runId: number; questionClass: QuestionClass; direction: string | undefined;
  startedAt: number; deadlineMs: number; rounds: number; maxRounds: number; ops: number;
  cancelled: boolean; ended: boolean; stopped: boolean; ledger: Map<string, LedgerEntry>;
  evidence: Map<CandidateKind, string>; readKinds: Set<CandidateKind>; sourcesDone: Set<SourceKind>; sourcesFailed: Set<SourceKind>;
  /** Read signatures already issued this run, so an identical duplicate read is never executed twice. */
  calls: Set<string>;
  /** Per source, the query shape a search that matched nothing used, for a line the model can voice. */
  emptySearches: Map<SourceKind, string>;
}

/** Session-local in-memory ledger. Nothing here is persisted or logged beyond its metadata. */
export class ResearchLedger {
  #runs = new Map<string, RunState>();
  #counter = 0;
  #activeId: string | undefined;
  #last: RunState | undefined;

  begin(input: { researchId?: string | undefined; questionClass: QuestionClass; direction?: string | undefined; deadlineMs: number; maxRounds: number; now: number }): RunState {
    const researchId = input.researchId ?? randomUUID();
    const run: RunState = {
      researchId, runId: ++this.#counter, questionClass: input.questionClass, direction: input.direction,
      startedAt: input.now, deadlineMs: input.deadlineMs, rounds: 0, maxRounds: input.maxRounds, ops: 0,
      cancelled: false, ended: false, stopped: false,
      ledger: new Map(), evidence: new Map(), readKinds: new Set(), sourcesDone: new Set(), sourcesFailed: new Set(),
      calls: new Set(), emptySearches: new Map(),
    };
    this.#runs.set(researchId, run);
    this.#activeId = researchId;
    this.#last = run;
    return run;
  }

  /** Continue inherits the completed ledger with a fresh budget and the optional direction. */
  resume(researchId: string, input: { direction?: string | undefined; deadlineMs: number; maxRounds: number; now: number }): RunState | undefined {
    const existing = this.#runs.get(researchId);
    if (!existing) return undefined;
    const run: RunState = {
      ...existing, runId: ++this.#counter, direction: input.direction ?? existing.direction,
      startedAt: input.now, deadlineMs: input.deadlineMs, maxRounds: input.maxRounds,
      rounds: 0, cancelled: false, ended: false, stopped: false,
      ledger: new Map(existing.ledger), evidence: new Map(existing.evidence), readKinds: new Set(existing.readKinds), sourcesDone: new Set(existing.sourcesDone), sourcesFailed: new Set(existing.sourcesFailed),
      calls: new Set(existing.calls), emptySearches: new Map(existing.emptySearches),
    };
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
    if (active) active.cancelled = true;
  }
  stop(researchId: string): RunState | undefined {
    const run = this.#runs.get(researchId);
    if (run) { run.stopped = true; run.ended = true; }
    return run;
  }
  close(): void { for (const run of this.#runs.values()) run.cancelled = true; }
}

// ---------------------------------------------------------------------------------------------
// Run

export interface ResearchProgress {
  researchId: string; phase: 'started' | 'round' | 'done' | 'stopped';
  sourcesDone: SourceKind[]; sourcesPending: SourceKind[]; elapsedMs: number;
}
export type ResearchDriver = 'selector' | 'fallback' | 'single-source-hint';

export interface ResearchRunLog {
  event: 'research_run'; researchId: string; questionClass: QuestionClass; rounds: number;
  perRound: { candidates: { kind: CandidateKind; pUseful: number }[]; chosen: CandidateKind[] }[];
  stopReason: string; status: 'answered' | 'partial' | 'stopped' | 'unavailable'; ops: number;
  sources: { kind: SourceKind; disposition: string; latencyMs: number }[];
  elapsedMs: number; deadAirMs: number; selectorMs: number; fallbackUsed: boolean; replyBytes: number;
  driver?: ResearchDriver;
  unchecked?: SourceKind[]; canContinue?: boolean; findingChars?: number[];
}

/** Q1: one metadata-only record per internal sub-call: counts and bytes, never the query or text. */
export interface ResearchSubcallLog {
  event: 'research_subcall'; researchId: string; kind: CandidateKind; tool: string; ok: boolean;
  errorCode?: string; items: number; rawBytes: number; keptBytes: number; queryChars: number;
  queryAuthor: 'selector' | 'fallback';
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
  now(): number;
  /** Defaults to a real timer; a test supplies a fake clock to prove the progress cadence. */
  schedule?: ResearchTimer | undefined;
  configured: readonly SourceKind[];
  /** Re-resolved per run so a connector that comes up or down mid-session is reported truthfully. */
  configuredNow?: (() => readonly SourceKind[]) | undefined;
  selector?: ResearchSelector | undefined;
  execute(subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]>;
  emit(event: ResearchProgress): void;
  log(event: ResearchRunLog): void;
  /** One metadata-only line when a second `start` joins a run already in flight. */
  logJoined?: ((researchId: string) => void) | undefined;
  /** Metadata-only per-sub-call log; defaults to the host log sink. Never the query or result text. */
  logSubcall?: ((event: ResearchSubcallLog) => void) | undefined;
  ledger: ResearchLedger;
  replyLimit?: number;
}

export interface ResearchCall { action: ResearchAction; question?: string; researchId?: string; sources?: string; direction?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

export function validateResearch(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = new Set(['action', 'question', 'researchId', 'sources', 'direction']);
  if (!Object.keys(args).every(key => keys.has(key))) return false;
  const action = args['action'];
  if (action !== 'start' && action !== 'continue' && action !== 'stop') return false;
  if (action === 'start') return optionalString(args['question']) !== undefined;
  return optionalString(args['researchId']) !== undefined;
}

/** The display order and human name of every research source the host loop can read today (R2-R2). */
const SOURCE_LABELS: readonly (readonly [SourceKind, string])[] = [
  ['calendar', 'calendar'],
  ['mail', 'mail'],
  ['chat', 'team chat'],
  ['knowledge', 'knowledge base'],
];

/** The connector tool whose presence means a source is configured. Same four names the research loop fans out over. */
const SOURCE_TOOLS: Readonly<Record<string, SourceKind>> = {
  search_knowledge: 'knowledge', gcal_list: 'calendar', gmail_list: 'mail', mattermost_search: 'chat',
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
  return `The owner's ${sourceListText(sources)}, in one lookup. Use it for every question about his day, schedule, meetings, mail, messages, notes or past work. The host decides per question which sources are worth reading and whether one more read is worth the wait. Call start with the question; call continue with the researchId to keep looking; call stop with the researchId to stop.`;
}

export function researchDeclaration(configured: readonly SourceKind[] = RESEARCH_SOURCES): { name: string; description: string; guidance: string; parameters: JsonObject; validate(args: unknown): boolean } {
  return {
    name: RESEARCH_TOOL_NAME,
    description: researchDescription(configured),
    guidance: 'start needs {"action":"start","question":"the question"}; continue needs {"action":"continue","researchId":"..."}. An optional "sources" hint of exactly one source makes the first round deterministic; an optional "direction" steers a continue.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'continue', 'stop'], description: 'start a lookup, continue one, or stop one.' },
        question: { type: 'string', minLength: 1, description: 'The owner question; required for start.' },
        researchId: { type: 'string', minLength: 1, description: 'The id a previous reply carried; required for continue and stop.' },
        sources: { type: 'string', description: 'Optional single-source hint; valid values: calendar, mail, chat, knowledge.' },
        direction: { type: 'string', description: 'Optional steer for a continue, e.g. "look in mail".' },
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
const SOURCE_LABEL: Record<SourceKind, string> = { knowledge: 'knowledge', calendar: 'calendar', mail: 'mail', chat: 'chat', mongoose: 'mongoose' };
/** Findings order: the owner's knowledge base leads, company sources follow. */
const SOURCE_ORDER: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];
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

/** Knowledge headings collapse to `#id title | body`, one per insight, in the shaped and raw forms. */
function insightItems(raw: readonly string[]): string[] {
  const items: string[] = [];
  let heading: { id: string | undefined; title: string } | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (heading === undefined) { body = []; return; }
    items.push(`${heading.id ? `#${heading.id} ` : ''}${heading.title}${body.length ? ` | ${clip(body.join(' '), RESEARCH.knowledgeBodyChars)}` : ''}`);
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
  if (!shown.length) return { text: '', source: 'calendar', lines: [], total: 0 };
  return { text: `calendar: ${shown.length} of ${lines.length} shown\n${shown.join('\n')}`, source: 'calendar', lines: shown, total: lines.length };
}

/**
 * Q1-R0: one telegraphic line per item, a per-source count line, never prose. Item ids ride in the
 * shaped line so the host can open the top mail or fetch the top chat thread without a second search.
 */
export function shapeBlock(kind: CandidateKind, results: readonly IntentSubResult[]): { text: string; source: SourceKind | null; lines: string[]; total: number } {
  if (kind === 'calendar_window') return shapeCalendarBlock(results);
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
  return { text: `${label}: ${shown.length} of ${total} shown\n${shown.join('\n')}`, source, lines: shown, total };
}


function sourceKindOfKindName(name: string): SourceKind | null {
  switch (name) {
    case INTERNAL.knowledgeSearch:
    case INTERNAL.knowledgeRead: return 'knowledge';
    case INTERNAL.calendars:
    case INTERNAL.calendarList: return 'calendar';
    case INTERNAL.mailList:
    case INTERNAL.mailRead: return 'mail';
    case INTERNAL.chatSearch:
    case 'mattermost_get_thread': return 'chat';
    default: return null;
  }
}

interface ReplyFinding { source: string; text: string; chars: number }

/**
 * Q1-R0 packing: a count line plus telegraphic lines per source, at least one line per source with
 * hits, then fill by recency; whatever is dropped sets canContinue, and a continue re-reads.
 */
function buildReply(run: RunState, status: 'answered' | 'partial' | 'stopped' | 'unavailable', configured: readonly SourceKind[], canContinue: boolean, limit: number): JsonObject {
  const groups: { source: SourceKind; label: string; lines: string[]; total: number }[] = [];
  for (const entry of run.ledger.values()) {
    if (!entry.lines || entry.lines.length === 0 || entry.source === null) continue;
    const existing = groups.find(group => group.source === entry.source);
    const target = existing ?? { source: entry.source, label: SOURCE_LABEL[entry.source], lines: [], total: 0 };
    target.lines.push(...entry.lines);
    target.total += entry.total ?? entry.lines.length;
    if (!existing) groups.push(target);
  }
  const readSources = new Set(run.sourcesDone);
  const unchecked = configured.filter(source => !readSources.has(source));
  // Outcome 2: name the sources this run could not reach, in one short clause the model can voice,
  // so an outage is never hidden behind a narrow answer. `knowledge` leads the findings.
  groups.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  const unreachable = SOURCE_LABELS.filter(([source]) => run.sourcesFailed.has(source)).map(([, label]) => label);
  const searchedNothing = SOURCE_LABELS.filter(([source]) => run.emptySearches.has(source) && !run.sourcesFailed.has(source))
    .map(([source, label]) => `I searched your ${label}${run.emptySearches.get(source) ?? ''} and found nothing matching.`);
  const clauses = [
    ...(unreachable.length === 0 ? [] : [`I could not reach ${unreachable.length === 1 ? unreachable[0]! : `${unreachable.slice(0, -1).join(', ')} and ${unreachable[unreachable.length - 1]!}`} right now.`]),
    ...searchedNothing,
  ];
  const note = clauses.length === 0 ? undefined : clauses.join(' ');
  let dropped = 0;
  const render = (): { findings: ReplyFinding[]; reply: JsonObject } => {
    const findings: ReplyFinding[] = groups.filter(group => group.lines.length > 0)
      .map(group => ({ source: group.source, text: `${group.label}: ${group.lines.length} of ${group.total} shown\n${group.lines.join('\n')}`, chars: group.lines.join('\n').length }));
    return { findings, reply: { researchId: run.researchId, status, findings, unchecked, canContinue: canContinue || dropped > 0, ...(note !== undefined ? { note } : {}) } };
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
  return { ...reply, findings };
}

/** The bounded loop. One call runs it start to finish within the run deadline. */
export async function runResearch(deps: ResearchDeps, call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
  const limit = deps.replyLimit ?? RESEARCH.replyLimitChars;
  const now = () => deps.now();
  const configured = (deps.configuredNow ?? (() => deps.configured))();
  const logSubcall = deps.logSubcall ?? ((event: ResearchSubcallLog): void => hostLogEvent(event));

  if (call.action === 'stop') {
    const run = call.researchId ? deps.ledger.stop(call.researchId) : deps.ledger.last();
    if (!run) return { researchId: call.researchId ?? '', status: 'stopped', findings: [], unchecked: configured, canContinue: false };
    deps.emit({ researchId: run.researchId, phase: 'stopped', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(s => !run.sourcesDone.has(s)), elapsedMs: Math.max(0, now() - run.startedAt) });
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
    run = deps.ledger.resume(call.researchId ?? '', { direction: call.direction, deadlineMs: RESEARCH.continueDeadlineMs, maxRounds: RESEARCH.continueRounds, now: now() }) ?? deps.ledger.begin({ researchId: call.researchId, questionClass: 'cross_source', deadlineMs: RESEARCH.continueDeadlineMs, maxRounds: RESEARCH.continueRounds, now: now() });
  }
  run.direction = call.direction ?? run.direction;

  const perRound: ResearchRunLog['perRound'] = [];
  const sourceLog: ResearchRunLog['sources'] = [];
  let selectorMs = 0;
  let fallbackUsed = false;
  // #260: how this run chose its sources, recorded where the loop decides it. selector dominates a
  // later fallback; the fixed recipe and the single-source hint never override a selector decision.
  let driver: ResearchDriver | undefined;
  let stopReason = 'rounds_exhausted';
  const started = run.startedAt;
  const deadlineAt = started + run.deadlineMs;

  deps.emit({ researchId: run.researchId, phase: 'started', sourcesDone: [], sourcesPending: [...configured], elapsedMs: 0 });

  // Dead air: the model is told the run is alive every few seconds. A selector that burns its whole
  // deadline or a slow source read used to leave the model and the owner in silence until the end.
  const schedule = deps.schedule ?? scheduleTimer;
  const beat = (): void => {
    deps.emit({ researchId: run.researchId, phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs: Math.max(0, now() - started) });
    heartbeat = schedule(beat, RESEARCH.progressEveryMs);
  };
  let heartbeat = schedule(beat, RESEARCH.progressEveryMs);

  const hint = hintedSources(call.sources, configured);
  // Outcome 5: the owner's knowledge base is the prime source. Its read starts immediately, in
  // parallel with source selection, unless the owner named one certain non-knowledge source.
  const knowledgeSubs = candidateSubs('knowledge_search', { question, configured, evidence: run.evidence });
  const knowledgeWanted = configured.includes('knowledge') && knowledgeSubs.length > 0 && !run.readKinds.has('knowledge_search')
    && !(hint.length === 1 && hint[0] !== 'knowledge');
  let knowledgeStartedAt = 0;
  let knowledgePromise: Promise<IntentSubResult[]> | undefined;
  let knowledgeConsumed = false;
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
        knowledgePromise = deps.execute(knowledgeSubs, AbortSignal.any([signal, AbortSignal.timeout(remainingMs)])).catch(() => [] as IntentSubResult[]);
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
        output = await deps.selector.select({ question, questionClass: run.questionClass, direction: run.direction, configured, completed: [...run.ledger.values()].map(entry => ({ kind: entry.kind, summary: entry.summary })), candidates: candidatesForSelector }, AbortSignal.any([signal, AbortSignal.timeout(RESEARCH.selectorDeadlineMs)]));
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
      run.ops += Math.max(1, candidateSubs(kind, { question, configured, evidence: run.evidence }).length);
    }
    const batches: CandidateKind[][] = [];
    for (let i = 0; i < toRun.length; i += RESEARCH.maxConcurrent) batches.push(toRun.slice(i, i + RESEARCH.maxConcurrent));
    for (const batch of batches) {
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) { stopReason = 'deadline'; break; }
      const roundSignal = AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
      const latencies = new Map<CandidateKind, number>();
      await Promise.all(batch.map(async kind => {
        const action = selection.actions.find(entry => entry.kind === kind);
        const subs = candidateSubs(kind, { question, configured, evidence: run.evidence, query: action?.query, window: action?.window, nowMs: now() });
        if (subs.length === 0) return;
        // Identical duplicate reads are deduplicated: a read this run already issued is reused, never
        // sent twice, so the connector is asked one question once.
        const issued = subs.filter(call => !run.calls.has(callSignature(call)));
        if (issued.length === 0) return;
        for (const call of issued) run.calls.add(callSignature(call));
        const consumeKnowledge = kind === 'knowledge_search' && knowledgePromise !== undefined && !knowledgeConsumed;
        const at = consumeKnowledge ? knowledgeStartedAt : now();
        // Q1-R3(e): one retry for a transient failed sub-call, inside the round deadline.
        const executeWithRetry = async (list: IntentSubCall[]): Promise<IntentSubResult[]> => {
          let out: IntentSubResult[] = [];
          try { out = await deps.execute(list, roundSignal); } catch { out = []; }
          const failed = list.map((_, index) => index).filter(index => !(out[index]?.ok));
          if (failed.length > 0 && deadlineAt - now() > 1_000) {
            try {
              const retried = await deps.execute(failed.map(index => list[index]!), roundSignal);
              failed.forEach((index, position) => { const result = retried[position]; if (result?.ok) out[index] = result; });
            } catch { /* keep the first attempt's result */ }
          }
          return out;
        };
        const results: IntentSubResult[] = consumeKnowledge ? (knowledgeConsumed = true, await knowledgePromise!) : await executeWithRetry(issued);
        // Host-side second hops inside the same run: hydrate the top knowledge hits, open the top
        // mails when the question asks what a mail says, and fetch the thread of the top chat hit.
        const second: IntentSubCall[] = [];
        const primaryText = results.filter(result => result.ok).map(result => result.text).join('\n');
        if (kind === 'knowledge_search') {
          const ids = extractInsightIds(primaryText);
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
        const key = `${kind}:${subs.map(sub => JSON.stringify(sub.args)).join(',')}`;
        // Outcome 2: the read is credited per source. `brief` fans out over several sources, so each
        // one is credited and delivered on its own instead of the whole batch going uncredited.
        const parts = creditableSources(kind, results);
        for (const [index, part] of parts.entries()) {
          const block = shapeBlock(shapeKindOf(part.source, kind), part.results);
          run.ledger.set(parts.length === 1 ? key : `${key}#${part.source ?? index}`, { kind, source: part.source, summary: block.text, lines: block.lines, total: block.total });
          if (part.source === null) continue;
          if (part.results.some(result => result.ok && result.text.trim())) {
            run.sourcesDone.add(part.source); run.sourcesFailed.delete(part.source); run.emptySearches.delete(part.source);
          } else if (part.results.some(result => result.ok)) {
            // The connector answered and matched nothing: that is a search, not an outage.
            run.sourcesDone.add(part.source); run.sourcesFailed.delete(part.source);
            run.emptySearches.set(part.source, queryShapeOf(subs));
          } else if (!run.sourcesDone.has(part.source)) run.sourcesFailed.add(part.source);
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
      }));

      for (const kind of batch) sourceLog.push({ kind: sourceKindOf(kind) ?? 'knowledge', disposition: latencies.has(kind) ? 'completed' : 'skipped', latencyMs: latencies.get(kind) ?? 0 });
      if (signal.aborted) { run.stopped = true; stopReason = 'cancelled'; break; }
      if (run.cancelled || run.stopped) { stopReason = 'cancelled'; break; }
    }
    run.rounds = round;
    deps.emit({ researchId: run.researchId, phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(s => !run.sourcesDone.has(s)), elapsedMs: now() - started });
    if (stopReason === 'deadline' || stopReason === 'ops_exhausted') break;
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
  const elapsedMs = now() - started;
  const status = stopReason === 'cancelled' || run.stopped ? 'stopped' : (run.readKinds.size > 0 ? (elapsedMs >= run.deadlineMs ? 'partial' : 'answered') : 'partial');
  const canContinue = !run.stopped && !run.cancelled && run.rounds < run.maxRounds && configured.some(source => !run.sourcesDone.has(source) && !run.sourcesFailed.has(source));
  heartbeat.cancel();
  deps.emit({ researchId: run.researchId, phase: 'done', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs });
  const reply = buildReply(run, status, configured, canContinue, limit);
  driver ??= 'single-source-hint';
  const replyFindings = Array.isArray(reply['findings']) ? reply['findings'] as { text?: string }[] : [];
  deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: run.rounds, perRound, stopReason, status, ops: run.ops, sources: sourceLog, elapsedMs, deadAirMs: elapsedMs, selectorMs, fallbackUsed, replyBytes: JSON.stringify(reply).length, driver, unchecked: configured.filter(source => !run.sourcesDone.has(source)), canContinue: reply['canContinue'] === true, findingChars: replyFindings.map(finding => (finding.text ?? '').length) });
  return reply;
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
type ActiveRun = { superseded: boolean; awaiter: Deferred };
function deferred(): Deferred {
  let resolve!: (reply: JsonObject) => void;
  const promise = new Promise<JsonObject>(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * The per-session research call scheduler (R1-R1, R1-R3, wire facts W1). One run exists per researchId.
 * A new call while a run is pending answers the old call at once with a superseded stub, keeps the
 * run going, and answers the new call with the merged result: `continue` runs on with a fresh budget
 * reusing the ledger, `stop` returns what is known now. A continue or stop with a missing or unknown
 * id applies to the single pending run. Stop is never inferred from transcript text.
 */
export class ResearchScheduler {
  readonly #deps: ResearchDeps;
  #active = new Map<string, ActiveRun>();
  constructor(deps: ResearchDeps) { this.#deps = deps; }

  call(call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
    if (call.action === 'start') {
      // Outcome 7: a second start while a run is in flight joins that run and returns its result,
      // instead of starting a sequential second run.
      const inflight = this.#resolveTarget(undefined);
      if (inflight !== undefined) {
        this.#deps.logJoined?.(inflight.id);
        return inflight.entry.awaiter.promise;
      }
      const id = call.researchId ?? newResearchId();
      return this.#drive({ ...call, researchId: id }, signal, id);
    }
    // R1-R3: a continue or stop with a missing or unknown id applies to the single pending run.
    const target = this.#resolveTarget(call.researchId);
    if (target !== undefined) {
      // Answer the pending call at once, then take the run over.
      target.entry.superseded = true;
      target.entry.awaiter.resolve(supersededStub(target.id, this.#deps.configured));
      if (call.action === 'stop') {
        this.#deps.ledger.stop(target.id);
        this.#active.delete(target.id);
        this.#deps.emit({ researchId: target.id, phase: 'stopped', sourcesDone: [], sourcesPending: [...this.#deps.configured], elapsedMs: 0 });
        return Promise.resolve(knownReply(this.#deps.ledger, target.id, this.#deps.configured));
      }
      // continue: stop the old loop, run on with a fresh budget reusing the ledger.
      this.#deps.ledger.cancelActive();
      return this.#drive({ ...call, action: 'continue', researchId: target.id }, signal, target.id);
    }
    // Zero or several pending runs: current behaviour.
    if (call.action === 'stop') return Promise.resolve(knownReply(this.#deps.ledger, call.researchId ?? '', this.#deps.configured));
    const id = call.researchId ?? newResearchId();
    return this.#drive({ ...call, researchId: id }, signal, id);
  }

  /** The run a continue or stop applies to: the named run, or the only pending run (R1-R3). */
  #resolveTarget(researchId: string | undefined): { id: string; entry: ActiveRun } | undefined {
    if (researchId !== undefined) { const entry = this.#active.get(researchId); if (entry !== undefined) return { id: researchId, entry }; }
    if (this.#active.size === 1) { const [id, entry] = [...this.#active.entries()][0]!; return { id, entry }; }
    return undefined;
  }

  #drive(call: ResearchCall, signal: AbortSignal, id: string): Promise<JsonObject> {
    const awaiter = deferred();
    const entry = { superseded: false, awaiter };
    this.#active.set(id, entry);
    runResearch(this.#deps, call, signal).then(reply => {
      if (this.#active.get(id) === entry) this.#active.delete(id);
      if (!entry.superseded) awaiter.resolve(reply);
    }).catch(() => {
      if (this.#active.get(id) === entry) this.#active.delete(id);
      if (!entry.superseded) awaiter.resolve({ error: 'research_failed' });
    });
    return awaiter.promise;
  }
}
