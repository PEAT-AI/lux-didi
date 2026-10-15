import { randomUUID } from 'node:crypto';
import type { JsonObject, ModelPort, ModelRequest } from '../adapters/model/types.js';
import { INTERNAL, type IntentSubCall, type IntentSubResult } from './intent.js';

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
  selectorDeadlineMs: 2_000,
  /** Selector wall time charged to the value-of-information decision, in seconds. */
  tSelSeconds: 1.0,
  /** Seconds of owner patience one useful answer class is worth. */
  value: Object.freeze({ quick_fact: 8, cross_source: 16, explicit_continue: 30 } as Record<QuestionClass, number>),
  /** Median seconds per source, from the release-3a wire facts. */
  p50Seconds: Object.freeze({ knowledge: 2.2, chat: 3.6, calendar: 4.7, gmail: 10.0 } as Record<'knowledge' | 'chat' | 'calendar' | 'gmail', number>),
  /** Selector cost multiplier by elapsed seconds: cheap early, expensive late. */
  lambda: Object.freeze([{ upToMs: 4_000, value: 0 }, { upToMs: 8_000, value: 0.5 }, { upToMs: Number.POSITIVE_INFINITY, value: 1.5 }]),
  replyLimitChars: 2_000,
});

export const RESEARCH_SOURCES: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];

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

export interface SelectorOutput {
  questionClass: QuestionClass;
  actions: { kind: CandidateKind; requirement?: string }[];
  pUseful: Partial<Record<CandidateKind, number>>;
}

export interface ResearchSelector {
  select(input: SelectorInput, signal: AbortSignal): Promise<SelectorOutput | null>;
}

export const SELECTOR_SYSTEM = 'You choose which reads are worth running to answer one owner question. '
  + 'Reply with JSON only: {"questionClass":"quick_fact|cross_source|explicit_continue","actions":[{"kind":"...","requirement":"..."}],'
  + '"pUseful":{"kind":0.0}}. Choose only from the offered candidate kinds; never invent a kind, an id or a source. '
  + 'pUseful is your probability (0..1) that the action yields something that changes the answer. Omit an action when it is redundant.';

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
  const actions: { kind: CandidateKind; requirement?: string }[] = [];
  if (Array.isArray(actionsRaw)) {
    for (const entry of actionsRaw) {
      if (entry === null || typeof entry !== 'object') continue;
      const kind = (entry as Record<string, unknown>)['kind'];
      if (typeof kind !== 'string' || !CANDIDATES.some(candidate => candidate.kind === kind)) continue;
      const requirement = (entry as Record<string, unknown>)['requirement'];
      actions.push(typeof requirement === 'string' && requirement.trim() ? { kind: kind as CandidateKind, requirement } : { kind: kind as CandidateKind });
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

/** The keyword fallback: O1's fixed recipe, used when the selector times out or answers invalidly. */
export function fallbackSelection(question: string, configured: readonly SourceKind[]): SelectorOutput {
  const text = question.toLowerCase();
  const actions: { kind: CandidateKind }[] = [];
  const pUseful: Partial<Record<CandidateKind, number>> = {};
  const offer = (kind: CandidateKind, p: number, source: SourceKind | null): void => {
    if (source !== null && !configured.includes(source)) return;
    actions.push({ kind }); pUseful[kind] = p;
  };
  const mailWords = /\b(mail|email|e-mail|inbox|wrote|sent|reply)\b/.test(text);
  const calendarWords = /\b(calendar|schedule|meeting|agenda|free|busy|tomorrow|today)\b/.test(text);
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
export function candidateSubs(kind: CandidateKind, config: { question: string; configured: readonly SourceKind[]; evidence: ReadonlyMap<CandidateKind, string> }): IntentSubCall[] {
  const q = config.question.trim();
  const search = (name: string, args: JsonObject, key: string): IntentSubCall => ({ key, name, args });
  if (kind === 'knowledge_search') return [search(INTERNAL.knowledgeSearch, { query: q, limit: 3 }, 'k0')];
  if (kind === 'calendar_window') return [search(INTERNAL.calendars, { maxResults: 20 }, 'cal0')];
  if (kind === 'mail_search') return [search(INTERNAL.mailList, { q: q || 'newer_than:7d' }, 'm0')];
  if (kind === 'mail_open') { const id = config.evidence.get('mail_search'); return id ? [search(INTERNAL.mailRead, { id }, 'mo0')] : []; }
  if (kind === 'chat_search') return [search(INTERNAL.chatSearch, { query: q || 'after:yesterday' }, 'c0')];
  if (kind === 'chat_thread') { const id = config.evidence.get('chat_search'); return id ? [search('mattermost_get_thread', { postId: id, limit: 12 }, 'ct0')] : []; }
  if (kind === 'brief') {
    const subs: IntentSubCall[] = [];
    if (config.configured.includes('calendar')) subs.push(search(INTERNAL.calendars, { maxResults: 20 }, 'b0'));
    if (config.configured.includes('mail')) subs.push(search(INTERNAL.mailList, { q: 'newer_than:2d' }, 'b1'));
    if (config.configured.includes('chat')) subs.push(search(INTERNAL.chatSearch, { query: 'after:yesterday' }, 'b2'));
    if (config.configured.includes('knowledge')) subs.push(search(INTERNAL.knowledgeSearch, { query: 'open loop follow up', limit: 3 }, 'b3'));
    return subs;
  }
  return [];
}

/** The first calendar/mail/chat id a completed search returned, for a follow-up read. */
export function extractId(kind: CandidateKind, text: string): string | undefined {
  if (kind === 'mail_search') {
    const match = text.match(/\b([0-9a-f]{16})\b/i) ?? text.match(/\bid[:\s]+([A-Za-z0-9_-]{6,})/i);
    return match?.[1];
  }
  if (kind === 'chat_search') {
    const match = text.match(/\bpost[_:\s-]*([A-Za-z0-9]{6,})\b/i) ?? text.match(/\b([A-Za-z0-9]{20,})\b/);
    return match?.[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Ledger

export interface LedgerEntry { kind: CandidateKind; source: SourceKind | null; summary: string }
export interface RunState {
  researchId: string; runId: number; questionClass: QuestionClass; direction: string | undefined;
  startedAt: number; deadlineMs: number; rounds: number; maxRounds: number; ops: number;
  cancelled: boolean; ended: boolean; stopped: boolean; ledger: Map<string, LedgerEntry>;
  evidence: Map<CandidateKind, string>; readKinds: Set<CandidateKind>; sourcesDone: Set<SourceKind>;
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
      ledger: new Map(), evidence: new Map(), readKinds: new Set(), sourcesDone: new Set(),
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
      ledger: new Map(existing.ledger), evidence: new Map(existing.evidence), readKinds: new Set(existing.readKinds), sourcesDone: new Set(existing.sourcesDone),
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
export interface ResearchRunLog {
  event: 'research_run'; researchId: string; questionClass: QuestionClass; rounds: number;
  perRound: { candidates: { kind: CandidateKind; pUseful: number }[]; chosen: CandidateKind[] }[];
  stopReason: string; ops: number; sources: { kind: SourceKind; disposition: string; latencyMs: number }[];
  elapsedMs: number; deadAirMs: number; selectorMs: number; fallbackUsed: boolean;
}

export interface ResearchDeps {
  now(): number;
  configured: readonly SourceKind[];
  selector?: ResearchSelector | undefined;
  execute(subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]>;
  emit(event: ResearchProgress): void;
  log(event: ResearchRunLog): void;
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

export function researchDeclaration(): { name: string; description: string; guidance: string; parameters: JsonObject; validate(args: unknown): boolean } {
  return {
    name: RESEARCH_TOOL_NAME,
    description: 'Look something up for the owner, as deeply as the question deserves. The host decides per question which sources are worth reading and whether one more read is worth the wait. Call start with the question; call continue with the researchId to keep looking; call stop with the researchId to stop.',
    guidance: 'start needs {"action":"start","question":"the question"}; continue needs {"action":"continue","researchId":"..."}. An optional "sources" hint of exactly one source makes the first round deterministic; an optional "direction" steers a continue.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'continue', 'stop'], description: 'start a lookup, continue one, or stop one.' },
        question: { type: 'string', minLength: 1, description: 'The owner question; required for start.' },
        researchId: { type: 'string', minLength: 1, description: 'The id a previous reply carried; required for continue and stop.' },
        sources: { type: 'string', description: 'Optional single-source hint, e.g. mail or calendar.' },
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

function compactSummary(results: readonly IntentSubResult[]): { summary: string; source: SourceKind | null } {
  const ok = results.filter(result => result.ok && result.text.trim());
  const text = ok.map(result => result.text.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 240);
  return { summary: text, source: ok.length ? sourceKindOfKindName(ok[0]!.name) : null };
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

interface ReplyFinding { source: string; text: string }

function buildReply(run: RunState, status: 'answered' | 'partial' | 'stopped' | 'unavailable', configured: readonly SourceKind[], canContinue: boolean, limit: number): JsonObject {
  const findings: ReplyFinding[] = [...run.ledger.values()].filter(entry => entry.summary).map(entry => ({ source: entry.source ?? 'summary', text: entry.summary }));
  const readSources = new Set(run.sourcesDone);
  const unchecked = configured.filter(source => !readSources.has(source));
  const reply: JsonObject = { researchId: run.researchId, status, findings, unchecked, canContinue };
  // The whole serialized response never exceeds the cap: drop trailing findings until it fits.
  while (findings.length && JSON.stringify({ ...reply, findings }).length > limit) {
    findings.pop();
    if (findings.length === 1) findings[0] = { source: findings[0]!.source, text: findings[0]!.text.slice(0, Math.max(0, limit / 2)) };
  }
  return { ...reply, findings };
}

/** The bounded loop. One call runs it start to finish within the run deadline. */
export async function runResearch(deps: ResearchDeps, call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
  const limit = deps.replyLimit ?? RESEARCH.replyLimitChars;
  const now = () => deps.now();
  const configured = deps.configured;

  if (call.action === 'stop') {
    const run = call.researchId ? deps.ledger.stop(call.researchId) : deps.ledger.last();
    if (!run) return { researchId: call.researchId ?? '', status: 'stopped', findings: [], unchecked: configured, canContinue: false };
    deps.emit({ researchId: run.researchId, phase: 'stopped', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(s => !run.sourcesDone.has(s)), elapsedMs: Math.max(0, now() - run.startedAt) });
    deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: run.rounds, perRound: [], stopReason: 'stop', ops: run.ops, sources: [], elapsedMs: Math.max(0, now() - run.startedAt), deadAirMs: 0, selectorMs: 0, fallbackUsed: false });
    return buildReply(run, 'stopped', configured, false, limit);
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
  let stopReason = 'rounds_exhausted';
  const started = run.startedAt;
  const deadlineAt = started + run.deadlineMs;

  deps.emit({ researchId: run.researchId, phase: 'started', sourcesDone: [], sourcesPending: [...configured], elapsedMs: 0 });

  const hint = hintedSources(call.sources, configured);
  for (let round = 1; round <= run.maxRounds; round++) {
    if (signal.aborted) { run.stopped = true; stopReason = 'cancelled'; break; }
    if (run.cancelled || run.stopped) { stopReason = 'cancelled'; break; }
    const elapsed = now() - started;
    if (elapsed >= run.deadlineMs) { stopReason = 'deadline'; break; }

    const completedKinds = [...run.readKinds];
    const offerable = offerableCandidates(configured, completedKinds);
    let selection: SelectorOutput;
    if (run.readKinds.size === 0 && hint.length === 1) {
      const source = hint[0]!;
      const kinds = offerable.filter(kind => CANDIDATES.find(c => c.kind === kind)?.source === source || CANDIDATES.find(c => c.kind === kind)?.source === null);
      selection = { questionClass: 'quick_fact', actions: kinds.map(kind => ({ kind })), pUseful: Object.fromEntries(kinds.map(kind => [kind, 0.6])) };
    } else if (deps.selector === undefined) {
      fallbackUsed = true;
      selection = fallbackSelection(question || run.direction || '', configured);
    } else {
      const selStart = now();
      let output: SelectorOutput | null = null;
      try {
        output = await deps.selector.select({ question, questionClass: run.questionClass, direction: run.direction, configured, completed: [...run.ledger.values()].map(entry => ({ kind: entry.kind, summary: entry.summary })), candidates: offerable }, AbortSignal.any([signal, AbortSignal.timeout(RESEARCH.selectorDeadlineMs)]));
      } catch { output = null; }
      selectorMs += now() - selStart;
      if (output === null) { fallbackUsed = true; selection = fallbackSelection(question || run.direction || '', configured); }
      else if (output.actions.length === 0) { selection = output; stopReason = output.questionClass === 'quick_fact' ? 'answered' : 'selector_stop'; }
      else selection = output;
    }

    if (run.ledger.size === 0 && question) run.questionClass = selection.questionClass;
    run.questionClass = selection.questionClass;

    const chosen = selection.actions.map(action => action.kind).filter(kind => offerable.includes(kind));
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
        const subs = candidateSubs(kind, { question, configured, evidence: run.evidence });
        if (subs.length === 0) return;
        const at = now();
        let results: IntentSubResult[] = [];
        try { results = await deps.execute(subs, roundSignal); } catch { results = []; }
        latencies.set(kind, now() - at);
        const source = sourceKindOf(kind);
        const compact = compactSummary(results);
        const key = `${kind}:${subs.map(sub => JSON.stringify(sub.args)).join(',')}`;
        run.ledger.set(key, { kind, source, summary: compact.summary });
        if (compact.summary) { run.evidence.set(kind, compact.summary); run.readKinds.add(kind); }
        if (source) run.sourcesDone.add(source);
      }));
      for (const kind of batch) sourceLog.push({ kind: sourceKindOf(kind) ?? 'knowledge', disposition: latencies.has(kind) ? 'completed' : 'skipped', latencyMs: latencies.get(kind) ?? 0 });
      if (signal.aborted) { run.stopped = true; stopReason = 'cancelled'; break; }
      if (run.cancelled || run.stopped) { stopReason = 'cancelled'; break; }
    }
    run.rounds = round;
    deps.emit({ researchId: run.researchId, phase: 'round', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(s => !run.sourcesDone.has(s)), elapsedMs: now() - started });
    if (stopReason === 'deadline' || stopReason === 'ops_exhausted') break;

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
  const canContinue = !run.stopped && !run.cancelled && run.rounds < run.maxRounds && configured.some(source => !run.sourcesDone.has(source));
  deps.emit({ researchId: run.researchId, phase: 'done', sourcesDone: [...run.sourcesDone], sourcesPending: configured.filter(source => !run.sourcesDone.has(source)), elapsedMs });
  deps.log({ event: 'research_run', researchId: run.researchId, questionClass: run.questionClass, rounds: run.rounds, perRound, stopReason, ops: run.ops, sources: sourceLog, elapsedMs, deadAirMs: elapsedMs, selectorMs, fallbackUsed });
  return buildReply(run, status, configured, canContinue, limit);
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
function deferred(): Deferred {
  let resolve!: (reply: JsonObject) => void;
  const promise = new Promise<JsonObject>(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * The per-session research call scheduler (R1-R1, wire facts W1). One run exists per researchId.
 * A new call while a run is pending answers the old call at once with a superseded stub, keeps the
 * run going, and answers the new call with the merged result: `continue` runs on with a fresh budget
 * reusing the ledger, `stop` returns what is known now. Stop is never inferred from transcript text.
 */
export class ResearchScheduler {
  readonly #deps: ResearchDeps;
  #active = new Map<string, { superseded: boolean; awaiter: Deferred }>();
  constructor(deps: ResearchDeps) { this.#deps = deps; }

  call(call: ResearchCall, signal: AbortSignal): Promise<JsonObject> {
    const requestedId = call.action === 'start' ? undefined : call.researchId;
    const active = requestedId !== undefined ? this.#active.get(requestedId) : undefined;
    if (active !== undefined && requestedId !== undefined) {
      // Answer the pending call at once, then take the run over.
      active.superseded = true;
      active.awaiter.resolve(supersededStub(requestedId, this.#deps.configured));
      if (call.action === 'stop') {
        this.#deps.ledger.stop(requestedId);
        this.#active.delete(requestedId);
        this.#deps.emit({ researchId: requestedId, phase: 'stopped', sourcesDone: [], sourcesPending: [...this.#deps.configured], elapsedMs: 0 });
        return Promise.resolve(knownReply(this.#deps.ledger, requestedId, this.#deps.configured));
      }
      // continue: stop the old loop, run on with a fresh budget reusing the ledger.
      this.#deps.ledger.cancelActive();
      return this.#drive({ ...call, action: 'continue' }, signal, requestedId);
    }
    const id = call.action === 'start' ? (call.researchId ?? newResearchId()) : call.researchId!;
    return this.#drive({ ...call, researchId: id }, signal, id);
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
