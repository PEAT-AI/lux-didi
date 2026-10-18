import { sourceCards } from '../tools/source-cards.js';
import { noEmptyResult } from '../tools/live-shape.js';
import * as memory from '../domain/memory.js';
import * as summaries from '../domain/summaries.js';
import * as labels from '../domain/labels.js';
import { definitionsInTransaction } from '../tools/index.js';
import { OPEN_TOOL_NAMES } from '../tools/open.js';
import { LiveToolJobs, type JobTimer, type ToolJob } from '../tools/jobs.js';
import { runToolCalls, authorizeToolBatch } from '../tools/declarations.js';
import { isIntentTool, planIntent, intentResponse, type IntentToolName, type IntentSubCall, type IntentSubResult } from '../tools/intent.js';
import { RESEARCH_TOOL_NAME, ResearchLedger, ResearchScheduler, refusalCode, researchSourcesForConnector, validateResearch, type ResearchCall, type ResearchSelector, type SourceKind as ResearchSourceKind, type UnavailableSource } from '../tools/research.js';
import { memoryLookup } from '../tools/memory-search.js';
import { LiveToolCache, LIVE_CACHE_TTL_MS } from './tool-cache.js';
import { WarmContextCache, chooseStartContext, withProvenance, type WarmContextSections } from './warm-context.js';
import type { RunAcceptance, LiveAuthority } from '../tools/types.js';
import type { ToolDefinition, HostContext, JsonObject } from '../adapters/model/types.js';
import type { LiveToolsComposition, LivePageProjection, LiveToolProjection, ResearchProgressView } from './types.js';

import { publicOwnerProfile, PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, buildRuntimeContext, buildEarlierConversationsSection, earlierConversationsBudget, LIVE_INSTRUCTION_TARGET_CHARS, composeLiveSessionInstruction, connectorGroupNames, toolGroupNames } from '../prompt/index.js';
import { capJournalText, journalRecord } from '../host/journal.js';

import { hostLogEvent, LIVE_STATE_CAUSES } from '../host/log.js';
import { liveToolStep, stepSubject, type LiveToolStepBody } from '../tools/host-events.js';
import { validateAcceptedPrompt } from './config.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DataClass, LiveVoiceDiagnostics, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceSession, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { headAnchor, terminalAnchor, canonicalSpeechLanguage, effectiveLanguageCode, LIVE_RECOVERY_PICKUP } from '../prompt/live-persona.js';
import { currentLiveAccent } from '../config/live.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import { liveProfileIdentity, validateLiveProfile } from './config.js';
import { parseTerminal, persistedKinds, readFragmentPage, retainedBytes } from './journal.js';
import {
  LiveError,
  type CreateLiveSession, type JournalKind, type LiveAttachment, type LiveConsumerState, type LiveContext,
  type LiveFragmentPage, type LiveInvalidationReason, type LiveOutputChunk, type LiveOwnerConfig,
  type AcceptedPromptSnapshot, type LiveProfile, type LiveProfileProjection, type LivePublicMarker, type LiveSessionSnapshot, type LiveStorePort,
  type LiveTerminalOutcome,
} from './types.js';

const pickupInstruction = 'The user has just picked up. Deliver the pending job result first, in your own words, then resume the conversation. If the outcome failed or is unknown, state that truthfully.';
/** Q5-R4: the most the earlier calls' first sentences may add to a start instruction. */
export const OPENER_CONTEXT_CHARS = 300;

/** Q5-R4: one earlier call's first sentence, so the note stays a hint rather than a transcript. */
function firstSentenceOf(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const end = flat.search(/[.?!](\s|$)/u);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/**
 * Q5-R4: the previous calls' openers as "do not repeat" context, under 300 chars and absent when no
 * earlier call exists. The journal text stays owner-local: this string is composed into the start
 * instruction and is never written to host.log.
 */
export function openersNote(openers: readonly string[]): string | undefined {
  const note = (lines: readonly string[]): string => `Do not open with any of these earlier openers: ${lines.map(line => `"${line}"`).join(' ')}`;
  const taken: string[] = [];
  for (const opener of openers.map(firstSentenceOf).filter(Boolean).slice(0, 2)) {
    if (note([...taken, opener]).length <= OPENER_CONTEXT_CHARS) taken.push(opener);
  }
  return taken.length ? note(taken) : undefined;
}

/** Q5-R4: the two most recent earlier calls' first spoken lines, read from the owner-local journal. */
function previousOpeners(tx: Transaction, assistantId: string): string[] {
  return tx.all("SELECT (SELECT j.text FROM live_journal j WHERE j.live_session_id=s.live_session_id AND j.kind='outputTranscription' AND trim(j.text)<>'' ORDER BY j.journal_id LIMIT 1) AS opener FROM live_sessions s WHERE s.owner_assistant_id=? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 2", [assistantId])
    .map(row => String(row['opener'] ?? '')).filter(text => text.trim() !== '');
}
// Issue 1014: a session past this many tool calls starts a fresh setup instead of resuming into
// drifted audio; a session under it still reuses the saved resumption handle.
const RESUMPTION_TOOL_CALL_LIMIT = 5;
// Release 3g-c recovery policy (R1-R1). Stalls come in episodes, so the bound is per episode: a session
// that stayed healthy for RECOVERY_HEALTHY_MS resets the consecutive-failure count, and the call ends
// only after RECOVERY_MAX_CONSECUTIVE failed recoveries in a row. Backoff between consecutive attempts.
const RECOVERY_MAX_CONSECUTIVE = 3;
const RECOVERY_HEALTHY_MS = 60_000;
const RECOVERY_BACKOFF_MS = [0, 2_000, 5_000] as const;
/** The seeded history is bounded by dropping whole oldest turns until it fits this many characters. */
/** GL2-R1: the closed set of reasons a projected state changes, shared with the host log whitelist. */
type LiveStateCause = (typeof LIVE_STATE_CAUSES)[number];
const SEED_CHAR_LIMIT = 8_000;
/** After a tool response, this much dead air with no model output earns one neutral continuation input. */
const DEAD_AIR_NUDGE_MS = 8_000;
/** D6: an open model turn holds SPEAKING across the adapter's between-sentence silence for this long. */
export const SPEAKING_HOLD_MS = 1_500;
// 3o: a client that detached is gone, not paused. This much detached and the session ends cleanly (the journal
// stays); the countdown is cancelled by a re-attach. Measured: the app let go at 19:23:49Z and the model kept
// speaking to nobody for 62 s.
const CONSUMER_GONE_MS = 5_000;
// 3p: a socket that closed and sent no Stop is a call that ended, not a pause. One second is the longest a Stop may
// take to be felt by the owner; the 5 s rule above stays behind it as the last net.
const CONSUMER_CLOSED_MS = 1_000;const DEAD_AIR_NUDGE_TEXT = 'Continue.';
// 3j response watchdog. A healthy socket proves nothing about a model that stopped generating: an owner turn
// that ended, or a model turn left open, owes a reply, and only a deadline on that debt recovers it. One nudge
// at RESPONSE_WATCHDOG_NUDGE_MS, then the fresh-seeded recovery at RESPONSE_WATCHDOG_RECOVERY_MS after it.
export const RESPONSE_WATCHDOG_NUDGE_MS = 8_000;
export const RESPONSE_WATCHDOG_RECOVERY_MS = 7_000;
/** At most one watchdog recovery per window; a second mute inside it ends the call honestly instead of looping. */
export const RESPONSE_WATCHDOG_WINDOW_MS = 120_000;
/** 3j: idle is conversational silence, so only an owner speech signal or model output resets it, never a mic frame. */
const IDLE_ACTIVITY: ReadonlySet<string> = new Set(['inputTranscription', 'waitingForInput', 'modelTurnStarted', 'audio', 'modelText', 'outputTranscription', 'turnComplete', 'toolCall']);
/** Every job row is written with a one day expiry (server/tools/jobs.ts); past it the row is stale data. */
const JOB_EXPIRY_MS = 86_400_000;
/** One intent sub-read deadline: a slow source never holds the whole turn past this. */
const INTENT_SUB_DEADLINE_MS = 8_000;
/** S4a ceiling on one non-research tool call: past it the host answers the call itself with a timeout output. */
const TOOL_CEILING_MS = 12_000;
/** S4a progress speech on the GPT-Live path: one speakable line about this long into an open delegation, only
 *  when nothing has been audible for PROGRESS_QUIET_MS, and never more than one every PROGRESS_INTERVAL_MS. */
const PROGRESS_FIRST_MS = 6_000;
const PROGRESS_QUIET_MS = 3_000;
const PROGRESS_INTERVAL_MS = 8_000;
/** S4a: a delegation still open this long after its last call was answered, with no terminal nested event, is
 *  stalled: the receipt names it, one progress line goes out, and the S2 recovery resumes instead of rebuilding. */
const DELEGATION_DEADLINE_MS = 25_000;

/** How many tool steps the voice view keeps for the turn: one line per source, no scrollback. */
const LIVE_STEPS_MAX = 8;

/** The source a direct tool reads, in the same vocabulary research uses, so one phrase table serves both. */
const STEP_SOURCES: Record<string, string> = {
  gmail: 'mail', gcal: 'calendar', mattermost: 'chat', mongoose: 'mongoose',
  lux: 'knowledge', search: 'knowledge', get: 'knowledge', remember: 'memory', open: 'web', research: 'knowledge',
};

function stepSourceOf(name: string): string {
  const prefix = name.split('_')[0] ?? name;
  return STEP_SOURCES[prefix] ?? prefix;
}

/** S4a: a spoken list of at most a handful of sources, in the order the ledger ran them. */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The action word a direct tool asks its source for. */
function stepActionOf(name: string): string {
  const suffix = name.split('_').slice(1).join('_');
  if (/search|list|find/.test(suffix)) return 'search';
  if (/note|remember|save/.test(suffix)) return 'save';
  return 'read';
}

interface ActiveSession {
  inputFinal?: boolean;
  inputAt?: number;
  /** When the owner's turn finished, to measure dead air until the first model audio. */
  inputFinalAt: number | undefined;
  /** First model audio of the current turn; reset at each model turn start. */
  firstAudioAt: number | undefined;
  /** Spoken output script codes of the current turn, counted and then reported as counts only. */
  turnLatin: number; turnDevanagari: number; turnChars: number;
  /** Whether this turn followed tool work and whether the owner cut it off. */
  turnAfterTool: boolean; turnInterrupted: boolean;
  inputJournalId?: number;
  inputFinalTimer?: ReturnType<JobTimer>;
  inputFinalWaiters?: Set<() => void>;
  generation: number; attempts: number; rebuilding: boolean;
  request: LiveVoiceRequest; deadlineMs: number; deadlineAt: number; callDeadlineAt: number; idleAt: number; goAwayUntil: number | undefined;
  /** Consecutive failed recoveries in the current episode; reset after RECOVERY_HEALTHY_MS of health. */
  recoveries: number; lastHealthyAt?: number; lastRecoveryPath?: 'resume' | 'fresh_seeded';
  /** One outstanding answer per user request: set when a tool result is sent, cleared only by the answer's
   *  own audible audio or an ended turn. Inaudible fill and progress speech never clear it (D3, amendment C). */
  awaitingAnswer: boolean; answerAt: number | undefined;
  /** S4a progress speech and the delegation deadline that outlives the S2 watchdog window. */
  progressTimer?: ReturnType<JobTimer> | undefined; progressSentAt?: number | undefined;
  delegationTimer?: ReturnType<JobTimer> | undefined; stalledNoRebuild?: boolean;
  /** 3j response watchdog: the silence clock of the turn that owes a reply, and the last watchdog recovery. */
  watchdogTimer?: ReturnType<JobTimer> | undefined; watchdogSince?: number | undefined;
  watchdogPhase?: 'armed' | 'nudged' | undefined; watchdogRecoveredAt?: number | undefined;
  /** D6: an open model turn holds SPEAKING until turnComplete or 1,500 ms of audible silence. */
  speakingHoldTimer?: ReturnType<JobTimer> | undefined;
  sessionTimer: ReturnType<JobTimer> | undefined; callTimer: ReturnType<JobTimer> | undefined; idleTimer: ReturnType<JobTimer> | undefined;
  pendingCalls: Map<string, string>;
  toolCache: LiveToolCache;
  researchLedger: ResearchLedger;
  researchScheduler?: ResearchScheduler;
  registry: readonly ToolDefinition[];
  host: HostContext | undefined;
  toolStep: number;
  /** The live tool steps of the turn in flight, oldest first; never journalled. */
  liveSteps: LiveToolStepBody[];
  /** How many items each call of this turn returned, so its end step counts items and not citations. */
  liveStepItems: Map<string, number>;
  toolCalls: number;
  seenIds: Set<string>;
  thinking: boolean;
  pendingCallIds: Set<string>;
  bargeInCallIds: Set<string>;
  /** In-flight abort handle per model call id, so a provider cancellation aborts exactly that call. */
  callAborts: Map<string, AbortController>;
  /** Wall-clock start per model call id, for tool_cancelled ms-in-flight and per-turn latency. */
  callStartedAt: Map<string, number>;
  speaking: boolean;
  /** Output audio that arrived below the audible threshold this turn, in playback milliseconds. */
  inaudibleMs: number;
  // E1 interruption telemetry: provider-side facts for the last turn only, never audio or text.
  lastModelAudioAt?: number;
  turnCompleteSeen: boolean;
  /** The last live state this session projected, which is the `from` of its next transition receipt. */
  liveState?: LivePageProjection['state'];
  liveSessionId: string;
  session: LiveVoiceSession;
  abort: AbortController;
  revision: number;
  inputClass: DataClass;
  ready: boolean;
  invalidated: boolean;
  terminal: boolean;
  consumer: OutputChannel;
  consumerState: LiveConsumerState;
  journalEvents: number;
  journalBytes: number;
  /** The sequence the Mac sees, counted once for the whole session: a provider rebuild opens a new adapter
   *  session whose own counter starts again at 1, and the Mac refuses a marker that does not advance. */
  markerSequence: number;
  adapterOutcome: LiveVoiceOutcome | undefined;
  diagnosticSnapshots: Promise<Readonly<LiveVoiceDiagnostics> | undefined>[];
  ownerAudioCalls: number; ownerAudioBytes: number; ownerRebuildingDropCalls: number; ownerRebuildingDropBytes: number;
  terminalOutcome: LiveTerminalOutcome | null;
  diagnosticTerminalCode: string; diagnosticsEmitted: boolean;
  loopDone: { promise: Promise<void>; resolve: () => void };
  done: { promise: Promise<LiveSessionSnapshot>; resolve: (value: LiveSessionSnapshot) => void; reject: (error: unknown) => void };
  resolveDone: () => void;
  persistFailure: unknown;
}

export { liveMigrations } from './schema.js';
export * from './types.js';
export { liveProfileIdentity, validateLiveProfile, defaultLiveLimits } from './config.js';

const keyPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
const maxPage = 500;

/**
 * Trusted in-process hooks wired through the existing tools composition seam:
 * terminal distillation and allowlisted metadata logging. Never accepted from transport.
 */
type SummaryHooks = {
  onSessionTerminal?: (liveSessionId: string) => void;
  log?: (event: { event: string } & Record<string, unknown>) => void;
};

/**
 * The warm-context hook wired through the same composition seam: today's calendar digest, built by
 * the host from the configured connector. Never accepted from transport, and absent means the slot
 * stays out of the assembly (issue 339).
 */
type WarmHooks = { calendarDigest?: () => Promise<string | undefined> };

/** The receipt one forced prewarm returns, and the host logs (issue 338). */
export type WarmPrewarmReceipt = { readonly ageBeforeMs: number | null; readonly ageAfterMs: number | null; readonly assembled: boolean };

function identity(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function journalKind(type: string): JournalKind | null { return (persistedKinds as readonly string[]).includes(type) ? type as JournalKind : null; }

/**
 * The script of what the model actually spoke this turn, counted from the output transcript.
 * Counters only: live_turn_script reports buckets and code-point counts, never any spoken text.
 */
function countTurnScript(handle: ActiveSession, text: string): void {
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    handle.turnChars += 1;
    if (/[\u0900-\u097F]/u.test(character)) handle.turnDevanagari += 1;
    else if (/[A-Za-z]/u.test(character)) handle.turnLatin += 1;
  }
}

function resetTurnScript(handle: ActiveSession): void {
  handle.turnLatin = 0; handle.turnDevanagari = 0; handle.turnChars = 0;
  handle.turnAfterTool = false; handle.turnInterrupted = false; handle.inaudibleMs = 0;
}

/** One metadata-only record per turn. A turn with no spoken output reports nothing. */
function logTurnScript(handle: ActiveSession): void {
  if (handle.turnChars === 0) { resetTurnScript(handle); return; }
  const script = handle.turnLatin > 0 && handle.turnDevanagari > 0 ? 'mixed' : handle.turnDevanagari > 0 ? 'devanagari' : 'latin';
  hostLogEvent({ event: 'live_turn_script', liveSessionId: handle.liveSessionId, script, latinChars: handle.turnLatin, devanagariChars: handle.turnDevanagari, afterTool: handle.turnAfterTool, interrupted: handle.turnInterrupted });
  resetTurnScript(handle);
}
// Wire-38: barge-in sends serverContent.interrupted, never toolCallCancellation, and a late
// toolResponse is accepted silently. A batch dispatched before that interruption is answered
// once, marked after_barge_in so the UI can show why the answer may not match the pending turn.
function markerOf(event: LiveVoiceEvent, kind: JournalKind, journalSequence: number, sequence: number): LivePublicMarker {
  return {
    kind, sequence, journalSequence,
    text: 'text' in event ? event.text : null,
    finished: 'finished' in event && event.finished !== undefined ? event.finished : null,
    value: event.type === 'waitingForInput' ? event.value : null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Bounded single-consumer output channel: ephemeral PCM plus committed public markers, in order. */
class OutputChannel {
  #queue: LiveOutputChunk[] = [];
  #bytes = 0;
  #waiter: ((result: IteratorResult<LiveOutputChunk>) => void) | undefined;
  #closed = false;
  constructor(private readonly maxEvents: number, private readonly maxBytes: number) {}
  push(chunk: LiveOutputChunk): 'ok' | 'backpressure' {
    if (this.#closed) return 'ok';
    const size = chunk.kind === 'audio' ? chunk.pcm.length : 0;
    if (this.#queue.length + 1 > this.maxEvents || this.#bytes + size > this.maxBytes) return 'backpressure';
    const waiter = this.#waiter;
    if (waiter) { this.#waiter = undefined; waiter({ value: chunk, done: false }); return 'ok'; }
    this.#queue.push(chunk); this.#bytes += size; return 'ok';
  }
  dropAudio(): void { this.#queue = this.#queue.filter(chunk => chunk.kind !== 'audio'); this.#bytes = 0; }
  /** Graceful end: already queued committed markers are still delivered, then done. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#queue.length) return;
    const waiter = this.#waiter; this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }
  /** Immediate end for detach/shutdown: drop anything still queued. */
  discard(): void {
    if (this.#closed) return;
    this.#closed = true; this.#queue = []; this.#bytes = 0;
    const waiter = this.#waiter; this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<LiveOutputChunk> {
    return {
      next: () => this.#next(),
      return: () => { this.discard(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
  #next(): Promise<IteratorResult<LiveOutputChunk>> {
    const item = this.#queue.shift();
    if (item) { this.#bytes -= item.kind === 'audio' ? item.pcm.length : 0; return Promise.resolve({ value: item, done: false }); }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.#waiter = resolve; });
  }
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '').trim();
// A leading request phrase is scaffolding, not the note: the qualifier test and the stored text both read past it.
const command = /^(?:naya\s*,?\s+)?(?:(?:please\s+)?remember\b(?:\s+that\b)?|(?:please\s+)?note\s+that\b|(?:please\s+)?keep\s+in\s+mind\b(?:\s+that\b)?)[\s:,]*/i;
const classified = /^(?:privately\b|(?:this\s+)?(?:is\s+|as\s+)?(?:private|sensitive)\b)/i;
// The owner transcript streams as many small deltas on some providers, so a turn is assembled from
// a recent window of rows, never from the handful of arguments a model was handed. A few seconds of
// speech is 64 rows: the window is ten minutes, capped so one session cannot grow it without bound.
const MEMORY_WINDOW_MS = 10 * 60 * 1000;
const MEMORY_WINDOW_ROWS = 2_000;
// A paraphrase is still the owner's memory when this share of the note's content words is spoken.
const MEMORY_SUPPORT_RATIO = 0.6;
const MEMORY_STOP_WORDS = new Set(['the', 'and', 'for', 'but', 'not', 'you', 'your', 'with', 'that', 'this', 'from', 'have', 'has',
  'had', 'are', 'was', 'were', 'will', 'would', 'can', 'could', 'should', 'about', 'into', 'than', 'then', 'they', 'them', 'there',
  'here', 'what', 'when', 'where', 'which', 'who', 'how', 'also', 'just', 'some', 'any', 'all', 'our', 'out', 'its', 'his', 'her',
  'him', 'she', 'need', 'want', 'get', 'got', 'does', 'did', 'please', 'remember', 'note', 'keep', 'mind', 'naya', 'because',
  'before', 'after', 'over', 'under', 'very', 'much', 'more', 'most', 'only', 'own', 'same', 'such', 'too', 'now']);
const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** The note's content words: lower-cased tokens without stop words or two-letter noise. */
const contentWords = (text: string): string[] => tokens(text).filter(word => word.length >= 3 && !MEMORY_STOP_WORDS.has(word));
/** How much of the note one owner turn supports: the share of its content words the turn speaks. */
function supportRatio(note: string, turn: string): number {
  const words = contentWords(note);
  if (!words.length) return 0;
  const spoken = new Set(tokens(turn));
  return words.filter(word => spoken.has(word)).length / words.length;
}

/** All reads and the write share the tool owner's transaction: duplicate calls cannot race. */
export function rememberOwnerNote(tx: Transaction, liveSessionId: string, args: { text: string; kind: 'fact' | 'preference' | 'task' }, now: number): JsonObject {
  // The note is the model's clean paraphrase; the owner's own words are only the support for it.
  const noteText = String(args.text).replace(command, '').replace(/\s+/g, ' ').trim();
  const words = contentWords(noteText);
  const receipt = (result: JsonObject, support: number): JsonObject => {
    hostLogEvent({ event: 'memory_note', remembered: result.remembered === true, code: String(result.code ?? 'remembered'), words: words.length, supportRatio: Math.round(support * 1000) / 1000 });
    return result;
  };
  // A bounded journal window, assembled into owner turns, not provider/model arguments.
  const rows = tx.all("SELECT journal_id,text,finished FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND arrived_at>=? ORDER BY journal_id DESC LIMIT ?", [liveSessionId, now - MEMORY_WINDOW_MS, MEMORY_WINDOW_ROWS]).reverse();
  const turns: { seq: number; text: string }[] = [];
  let pending = '', pendingSeq = 0;
  for (const row of rows) {
    pending += String(row.text ?? ''); pendingSeq = Number(row.journal_id);
    if (Number(row.finished) === 1) { turns.push({ seq: pendingSeq, text: pending }); pending = ''; }
  }
  // The model's tool call is the intent: the latest partial turn is owner speech too, because the
  // provider may never set the finished flag before the call arrives.
  if (pending.trim().length) turns.push({ seq: pendingSeq, text: pending });
  const pointer = normalized(noteText);
  if (!pointer) return receipt({ remembered: false, code: 'owner_text_mismatch' }, 0);
  // The supporting turn is one recent owner turn: it holds the note's words, or enough of them.
  let turn: { seq: number; text: string } | undefined;
  let support = 0;
  for (let index = turns.length - 1; index >= 0 && !turn; index--) {
    const candidate = turns[index]!;
    const ratio = supportRatio(noteText, candidate.text);
    if (normalized(candidate.text).includes(pointer)) { turn = candidate; support = 1; }
    else if (ratio >= MEMORY_SUPPORT_RATIO) { turn = candidate; support = ratio; }
  }
  if (!turn) {
    // An older turn is outside the window rather than unfinished; only a session with no owner
    // speech at all reports that the transcript was never final.
    const spoken = tx.get("SELECT journal_id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' LIMIT 1", [liveSessionId]);
    return receipt({ remembered: false, code: spoken ? 'owner_text_mismatch' : 'owner_transcript_not_final' }, 0);
  }
  const utterance = turn.text.trim();
  if (classified.test(utterance.replace(command, '').trim()) || classified.test(noteText)) return receipt({ remembered: false, code: 'private_memory_unsupported' }, support);
  const externalId = `${liveSessionId}:${turn.seq}`;
  const existing = memory.rememberedLiveEntry(tx, externalId);
  if (existing) return receipt({ remembered: false, code: 'already_remembered', entryId: existing }, support);
  const clock = { now: () => now };
  const session = memory.createSession(tx, { title: 'Live voice memory', startedAt: now, timeZone: 'UTC' }, clock);
  labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  const entry = memory.appendEntry(tx, { sessionId: session.id, text: noteText, capturedAt: now, timeZone: 'UTC',
    source: { label: `live-voice ${liveSessionId}`, provider: 'live-voice', accountId: liveSessionId, externalId, sourceTimestamp: now, availability: 'present', note: `kind:${args.kind}` } }, clock);
  labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  return receipt({ remembered: true, entryId: entry.id }, support);
}

/** Scrub only the deleted record, preserving the rest of the frozen instruction. */
function scrubMemorySnapshots(tx: Transaction, entryId: string): { id: string; system: string }[] {
  const scrubbed: { id: string; system: string }[] = [];
  if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='live_sessions'", [])) return scrubbed;
  for (const row of tx.all('SELECT live_session_id,accepted_prompt_snapshot,prompt_identity,profile_identity FROM live_sessions', [])) {
    if (row['accepted_prompt_snapshot'] === null) continue;
    const snapshot = JSON.parse(String(row['accepted_prompt_snapshot'])) as AcceptedPromptSnapshot;
    let removed = false;
    const system = snapshot.system.replace(/<memory-record>\n([^\n]*)\n<\/memory-record>/g, (block, json: string) => {
      const record = JSON.parse(json) as { id: string };
      if (record.id !== entryId) return block;
      removed = true; return '';
    });
    if (!removed) continue;
    const selectedIds = snapshot.memory?.selectedIds.filter(id => id !== entryId) ?? [];
    const omitted = snapshot.memory?.omitted.filter(record => record.id !== entryId) ?? [];
    const memory = { status: omitted.length ? selectedIds.length ? 'partial' : 'omitted' : selectedIds.length ? 'selected' : 'empty', selectedIds, omitted } as const;
    const updated = { ...snapshot, system, memory };
    const dataClass = classes.find(dataClass => identity({ text: snapshot.system, dataClass }) === row['prompt_identity']);
    if (!dataClass) throw new LiveError('invalidated');
    const promptIdentity = identity({ text: system, dataClass });
    const id = String(row['live_session_id']);
    const grant = tx.get('SELECT chosen_input_class FROM live_grants WHERE live_session_id=?', [id]);
    if (!grant) throw new LiveError('invalidated');
    const fingerprint = identity({ inputClass: String(grant['chosen_input_class']), profile: String(row['profile_identity']), prompt: promptIdentity, pickupJobId: snapshot.pickup?.jobId ?? null });
    tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=?,memory_provenance=?,prompt_identity=?,fingerprint=? WHERE live_session_id=?',
      [JSON.stringify(updated), JSON.stringify(memory), promptIdentity, fingerprint, id]);
    scrubbed.push({ id, system });
  }
  return scrubbed;
}

// Host composition and HTTP share the canonical Store object. Keep active-handle
// ownership here rather than exposing the manager through transport projections.
const memoryOwners = new WeakMap<LiveStorePort, LiveSessionOwner>();

/** Stage redaction in the caller's transaction, then publish active changes after commit. */
export function redactDeletedMemorySnapshots(store: LiveStorePort, tx: Transaction, entryId: string): { liveSessionRetainsUntilRebuild: boolean; publish: () => void } {
  const owner = memoryOwners.get(store);
  if (owner) return owner.redactDeletedMemory(tx, entryId);
  scrubMemorySnapshots(tx, entryId);
  return { liveSessionRetainsUntilRebuild: false, publish: () => {} };
}

/** The feed's job rows (UI3b): only the current session's, and never a delivered row past its
 * one day outbox expiry. A job belongs to the session that picked it up, else the one that started it. */
function jobRow(job: ToolJob): import('./types.js').PendingLiveJob {
  return {
    id: job.id, originSessionId: job.originSessionId, state: job.state, createdAt: job.createdAt, delivered: job.delivered,
    markdown: job.result?.accepted.map(result => typeof result.response.text === 'string' ? result.response.text : JSON.stringify(result.response)).join('\n\n') || '',
  };
}

// Per-second audio counters. Numbers only: the journal never sees a sample. One bucket per second
// per session, flushed on the next bucket so a stall shows as a second with no output. Each output chunk also
// contributes its level (dBFS RMS, computed by the adapter) so a silent stream is visible as a number, not a guess.
const audioBuckets = new WeakMap<ActiveSession, { second: number; input: number; output: number; silent: number; rmsMax: number; rmsPower: number; rmsChunks: number }>();
const audioTotals = new WeakMap<ActiveSession, number>();
/** Output PCM is 24 kHz s16 mono: 48 bytes per millisecond, the same clock the adapter models its queue on. */
const OUTPUT_PCM_BYTES_PER_MS = 48;
function countAudio(handle: ActiveSession, channel: 'input' | 'output', bytes: number, now: number, rmsDbfs?: number): void {
  const second = Math.floor(now / 1000);
  const bucket = audioBuckets.get(handle);
  if (bucket === undefined) { audioBuckets.set(handle, { second, input: channel === 'input' ? bytes : 0, output: channel === 'output' ? bytes : 0, silent: 0, rmsMax: rmsDbfs ?? -Infinity, rmsPower: rmsDbfs === undefined ? 0 : 10 ** (rmsDbfs / 10), rmsChunks: rmsDbfs === undefined ? 0 : 1 }); return; }
  if (bucket.second === second) {
    if (channel === 'input') bucket.input += bytes; else bucket.output += bytes;
    if (rmsDbfs !== undefined) { bucket.rmsMax = Math.max(bucket.rmsMax, rmsDbfs); bucket.rmsPower += 10 ** (rmsDbfs / 10); bucket.rmsChunks += 1; }
    return;
  }
  journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'audio',
    at: bucket.second, inputBytes: bucket.input, outputBytes: bucket.output,
    ...(bucket.rmsChunks ? { outputRms: { max: Math.round(bucket.rmsMax * 10) / 10, mean: Math.round(10 * Math.log10(bucket.rmsPower / bucket.rmsChunks) * 10) / 10 } } : {}) });
  if (bucket.output > 0) audioTotals.set(handle, (audioTotals.get(handle) ?? 0) + bucket.output);
  // A stall marker needs a speaking second followed by three with no playback at all.
  if (bucket.output === 0 && handle.speaking) bucket.silent += 1; else bucket.silent = 0;
  if (bucket.silent === 3) {
    journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'audio_marker', marker: 'stall', silentSeconds: bucket.silent });
  }
  audioBuckets.set(handle, { second, input: channel === 'input' ? bytes : 0, output: channel === 'output' ? bytes : 0, silent: bucket.silent, rmsMax: rmsDbfs ?? -Infinity, rmsPower: rmsDbfs === undefined ? 0 : 10 ** (rmsDbfs / 10), rmsChunks: rmsDbfs === undefined ? 0 : 1 });
}

export function feedJobs(jobs: readonly ToolJob[], liveSessionId: string, now: number): import('./types.js').PendingLiveJob[] {
  return jobs.filter(job => job.deferred
    && (job.deliverySessionId ?? job.originSessionId) === liveSessionId
    && !(job.delivered && job.createdAt + JOB_EXPIRY_MS <= now))
    .map(jobRow);
}

export class LiveSessionOwner {
  readonly #jobs: LiveToolJobs;
  readonly #tools: LiveToolsComposition | undefined;
  readonly #onSessionTerminal: ((liveSessionId: string) => void) | undefined;
  readonly #summaryLog: ((event: { event: string } & Record<string, unknown>) => void) | undefined;
  readonly #memorySource: LiveOwnerConfig['memorySource'];
  readonly #store: LiveStorePort;
  readonly #voice: LiveVoicePort;
  readonly #profile: LiveProfile;
  readonly #now: () => number;
  readonly #timeZone: string;
  readonly #schedule: NonNullable<LiveOwnerConfig['schedule']>;
  readonly #research: ResearchSelector | undefined;
  /** The local, model-free block a silent Naya keeps ready (council-presence-1017, item 4). */
  #warm: WarmContextCache;
  /** The digest the host built at the last prewarm; absent leaves the calendar slot out (issue 339). */
  #calendar: string | undefined;
  /** The sections the last start used, so a forced prewarm refreshes without reading the store again. */
  #sections: WarmContextSections | undefined;
  readonly #calendarDigest: (() => Promise<string | undefined>) | undefined;
  #expiryTimer: ReturnType<NonNullable<LiveOwnerConfig['schedule']>> | undefined;
  readonly #profileIdentity: string;
  readonly #active = new Map<string, ActiveSession>();
  #revision = 1;
  #invalidated = false;
  #providerMemory = new WeakMap<ActiveSession, Map<string, number>>();
  #closed = false;
  /** The last state projected to the web, so one host-log live_state fires per change (F7). */
  #lastProjectedState: LivePageProjection['state'] | undefined;

  constructor(config: LiveOwnerConfig) {
    if (!config || typeof config !== 'object' || !config.store || !config.voice) throw new LiveError('invalid_config');
    this.#tools = config.tools;
    const summaryHooks = config.tools as unknown as SummaryHooks | undefined;
    this.#onSessionTerminal = summaryHooks?.onSessionTerminal;
    this.#summaryLog = summaryHooks?.log;
    this.#memorySource = config.memorySource;
    // The digest hook rides the composition seam; a test may also pass it on the config directly.
    this.#calendarDigest = (config as unknown as WarmHooks).calendarDigest ?? (config.tools as unknown as WarmHooks | undefined)?.calendarDigest;
    this.#warm = new WarmContextCache({ budget: LIVE_INSTRUCTION_TARGET_CHARS, now: () => this.#now() });
    this.#store = config.store;
    this.#voice = config.voice;
    this.#research = config.research;
    this.#profile = validateLiveProfile(config.profile);
    this.#timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = config.now ?? Date.now;
    this.#now = () => {
      const value = now();
      if (!Number.isSafeInteger(value)) throw new LiveError('invalid_config', 'clock must return integer epoch milliseconds');
      return value;
    };
    this.#schedule = config.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return { unref: () => { timer.unref(); }, cancel: () => { clearTimeout(timer); } };
    });
    this.#jobs = new LiveToolJobs(this.#store, this.#now);
    this.#profileIdentity = liveProfileIdentity(this.#profile);
    memoryOwners.set(this.#store, this);
    this.recover();
  }

  get revision(): number { return this.#revision; }

  /** Host-generated runtime context: host clock and timezone, plus the groups this session can reach. */
  #liveRuntimeContext(toolNames: readonly string[]): string {
    const connected = toolGroupNames(toolNames);
    const endpoints = this.#tools?.status?.().endpoints ?? [];
    const unavailable = endpoints.filter(endpoint => endpoint.state !== 'connected')
      .flatMap(endpoint => connectorGroupNames(endpoint.connector))
      .filter((group, index, all) => all.indexOf(group) === index && !connected.includes(group));
    return buildRuntimeContext({ now: new Date(this.#now()), timeZone: this.#timeZone, connected, unavailable });
  }

  /** Safe operator-visible identity. Never carries key bytes or prompt text. */
  get profileIdentity(): string { return this.#profileIdentity; }

  /**
   * R3-R5: the calendar digest belongs to every warm assembly, so the caller that is about to assemble
   * asks for it first: one bounded primary-calendar read, never on the voice turn path. Unconfigured,
   * failed or empty leaves the slot out; nothing here can fail the assembly.
   */
  async prepareCalendar(): Promise<void> {
    if (this.#calendarDigest === undefined) return;
    try { this.#calendar = await this.#calendarDigest(); }
    catch { this.#calendar = undefined; }
  }

  /**
   * The owner's prewarm instruction (issue 338): read today's calendar digest once, then rebuild the
   * warm assembly from the sections the last start used plus that digest, keeping the summary
   * provenance that start recorded (F9). No store is read here, nothing talks to a model, and a
   * connector failure leaves the slot out rather than failing the instruction. Returns the receipt
   * the host logs as `warm_prewarm`.
   */
  async prewarm(): Promise<WarmPrewarmReceipt> {
    const ageBeforeMs = this.#warm.ageMs ?? null;
    await this.prepareCalendar();
    const previous = this.#sections;
    // `adopt` is the cache's own "keep these sections now", which is what a forced refresh assembles;
    // it is not `refresh(true)` because a source collection cannot carry the provenance above.
    const refreshed = previous === undefined ? undefined : this.#warm.adopt(withProvenance({ ...previous, calendar: this.#calendar }, previous));
    if (refreshed !== undefined) this.#sections = refreshed.sections;
    const receipt = { ageBeforeMs, ageAfterMs: this.#warm.ageMs ?? null, assembled: refreshed !== undefined };
    // One closed metadata line per instruction, whichever route asked for it.
    this.#summaryLog?.({ event: 'warm_prewarm', ...receipt });
    return receipt;
  }
  profileProjection(): LiveProfileProjection {
    return {
      provider: this.#profile.provider, model: this.#profile.liveModelId, voice: this.#profile.voice,
      dataClasses: this.#profile.route.dataClasses, profileIdentity: this.#profileIdentity,
      memory: this.#store.transaction(tx => memoryProjection(tx.get('SELECT memory_provenance FROM live_sessions WHERE owner_assistant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [this.#store.assistantId])?.['memory_provenance'])),
    };
  }

  /** Startup sweep: no intent means no possible egress; an intent means possible egress. */
  recover(): number {
    const now = this.#now();
    const recovered = this.#store.transaction(tx => {
      const rows = tx.all("SELECT live_session_id, dispatch_intent FROM live_sessions WHERE lifecycle IN ('accepted','opening','active')");
      for (const row of rows) {
        const outcome: LiveTerminalOutcome = Number(row['dispatch_intent']) === 1 ? { state: 'outcome_unknown' } : { state: 'not_started' };
        this.#terminalInTx(tx, String(row['live_session_id']), outcome, false, now, 'ended', null);
      }
      return rows.length;
    });
    this.#armExpiry();
    return recovered;
  }

  create(input: CreateLiveSession, context: LiveContext): LiveSessionSnapshot {
    this.#guardOpen();
    if (!input || typeof input !== 'object' || typeof input.idempotencyKey !== 'string' || !keyPattern.test(input.idempotencyKey)) throw new LiveError('invalid_request');
    this.#contextShape(context);
    const fingerprintFor = (prompt: string) => identity({ inputClass: input.inputClass, profile: this.#profileIdentity, prompt, pickupJobId: input.pickupJobId ?? null });
    const now = this.#now();
    const assistantId = this.#store.assistantId;
    const snapshot = this.#store.transaction(tx => {
      // Same-key replay is decided on the normalized request meaning before any policy.
      const prior = tx.get('SELECT * FROM live_sessions WHERE owner_assistant_id=? AND idempotency_key=?', [assistantId, input.idempotencyKey]);
      if (prior) {
        if (String(prior['fingerprint']) !== fingerprintFor(String(prior['prompt_identity']))) throw new LiveError('idempotency_conflict');
        return this.#snapshot(tx, this.#expireInTx(tx, prior, now));
      }
      if (context.authorityEpoch !== this.#store.authorityEpoch) throw new LiveError('stale_authority');
      if (!classes.includes(input.inputClass) || !this.#profile.route.dataClasses.includes(input.inputClass)) throw new LiveError('invalid_request');
      const configuredPrompt = validateAcceptedPrompt(this.#profile.acceptedPrompt ?? {
        schemaVersion: 1, ownerProfile: publicOwnerProfile(assistantId), compilerVersion: PROMPT_VERSION,
        system: this.#profile.prompt.text, dataClasses: [this.#profile.prompt.dataClass],
      }, assistantId);
      if (configuredPrompt.dataClasses.some(c => !this.#profile.route.dataClasses.includes(c))) throw new LiveError('invalid_request');
      const liveSessionId = randomUUID();
      let toolNames: string[] = [];
      let toolAcceptance: { acceptance: RunAcceptance; sha256: string } | undefined;
      if (this.#tools) {
        const acceptance: RunAcceptance = { ownerId: assistantId, actorId: context.clientId, runId: liveSessionId,
          authorityEpoch: context.authorityEpoch, revision: this.#revision,
          route: { identity: this.#profileIdentity, provider: this.#profile.provider, modelId: this.#profile.liveModelId, allowedClasses: [...this.#profile.route.dataClasses] },
          allowedClasses: [...this.#profile.route.dataClasses], connectionIds: [...this.#tools.connectionIds()] };
        toolAcceptance = { acceptance, sha256: this.#tools.owner.snapshotRun(tx, acceptance).sha256 };
        toolNames = [...definitionsInTransaction(this.#tools.owner, liveSessionId, tx).map(tool => tool.name).filter(name => name !== 'remember_note'), 'remember_note'];
      }
      const pickupJob = input.pickupJobId ? this.#jobs.pending(tx).find(job => job.id === input.pickupJobId && job.state !== 'in_progress') : undefined;
      if (input.pickupJobId && !pickupJob) throw new LiveError('invalid_request');
      const pickup = pickupJob ? { jobId: pickupJob.id, identity: identity({ state: pickupJob.state, result: pickupJob.result ?? null }) } : undefined;
      type MemoryRecords = ReturnType<NonNullable<LiveOwnerConfig['memorySource']>>;
      type Earlier = ReturnType<typeof buildEarlierConversationsSection>;
      let records: MemoryRecords = [];
      let earlier: Earlier = { section: '', selectedIds: [], omitted: [] };
      // PV1: the accent selection is read at this session start, so a saved accent takes effect without a
      // restart; the session composer replaces whatever block the frozen prompt still carries.
      // Q5-R4: opener variety. The two previous calls' first spoken lines come from the owner-local
      // journal, so this start can name what not to repeat; nothing here reaches host.log.
      const openers = openersNote(previousOpeners(tx, assistantId));
      const composeSession = (earlierSection: string | undefined) => composeLiveSessionInstruction({ text: configuredPrompt.system, tools: toolNames,
        accentSelection: currentLiveAccent(),
        runtimeContext: this.#liveRuntimeContext(toolNames),
        records: records.filter(record => record.dataClass === 'ordinary'), trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
        ...(earlierSection ? { earlierConversations: earlierSection } : {}),
        ...(this.#profile.overlay ? { overlay: this.#profile.overlay } : {}),
        ...(pickup ? { pickupNote: pickupInstruction } : {}), ...(openers !== undefined ? { openersNote: openers } : {}) });
      // Memory is frozen at CREATE and fresh at the next CREATE (R1F/R1G), so it is always read here.
      try { records = this.#memorySource?.(tx) ?? []; }
      catch { throw new LiveError('memory_unavailable'); }
      // P1-R1: one source of the earlier-conversation section. A warm assembly younger than ten
      // minutes supplies it as it stands, so the summary scan and its selection do not run twice; a
      // stale or absent one is assembled here, exactly as before, and adopted for the next start.
      const compose = (): ReturnType<typeof composeLiveSessionInstruction> => {
        let basis: ReturnType<typeof composeLiveSessionInstruction> | undefined;
        const start = chooseStartContext(this.#warm.take(), () => {
          // The summaries fill what the other sections leave under the target, so measure it once.
          basis = composeSession(undefined);
          earlier = buildEarlierConversationsSection(summaries.injectionCandidates(tx),
            { now, timeZone: this.#timeZone, maxChars: earlierConversationsBudget(basis.text.length) });
          return { persona: configuredPrompt.system, memory: [] as readonly string[],
            summary: earlier.section.length ? earlier.section : undefined,
            summaryIds: [...earlier.selectedIds], summaryOmitted: [...earlier.omitted], calendar: this.#calendar };
        });
        if (start.warm) earlier = { section: start.sections.summary ?? '', selectedIds: [...start.sections.summaryIds], omitted: [...start.sections.summaryOmitted] };
        else this.#warm.adopt(start.sections);
        // The sections this start used are what a forced prewarm refreshes, so it re-reads no store.
        this.#sections = start.sections;
        // With no summary section the measured basis is the result, so a start composes once.
        if (!earlier.section) return basis ?? composeSession(undefined);
        return composeSession(earlier.section);
      };
      let composed: ReturnType<typeof composeLiveSessionInstruction>;
      try { composed = compose(); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'instruction_too_large') throw new LiveError('instruction_too_large'); throw error; }
      console.error(JSON.stringify({ event: 'live_instruction_sizes', total: composed.text.length, sections: Object.fromEntries(composed.sections.map(section => [section.id, section.chars])), languageCode: this.#profile.language === undefined ? 'unset' : effectiveLanguageCode(this.#profile.language), voice: this.#profile.voice }));
      // The debug journal's session start: the composed instructions once, then the identity and sizes
      // a debugging session needs. host.log keeps only the content-free sizes line above.
      journalRecord({ kind: 'live', sessionId: liveSessionId, generation: 0, event: 'session_start',
        provider: this.#profile.provider, model: this.#profile.liveModelId, voice: this.#profile.voice,
        instructionChars: composed.text.length, instructionSections: Object.fromEntries(composed.sections.map(section => [section.id, section.chars])),
        inputClass: input.inputClass, pickup: pickupJob !== undefined, instructions: composed.text });
      const memory = { status: composed.omitted.length ? composed.selectedIds.length ? 'partial' : 'omitted' : composed.selectedIds.length ? 'selected' : 'empty',
        selectedIds: composed.selectedIds, omitted: composed.omitted };
      const injectedSummaryIds = composed.earlierConversationsIncluded ? [...earlier.selectedIds] : [];
      if (injectedSummaryIds.length || earlier.omitted.length) this.#summaryLog?.({ event: 'conversation_summary_injection', injected: injectedSummaryIds.length, omitted: earlier.omitted.length, chars: composed.sections.find(section => section.id === 'earlier-conversations')?.chars ?? 0 });
      const acceptedPrompt = validateAcceptedPrompt({ ...configuredPrompt, system: composed.text, memory, ...(pickup ? { pickup } : {}) }, assistantId);
      const promptIdentity = identity({ text: acceptedPrompt.system, dataClass: this.#profile.prompt.dataClass });
      const fingerprint = fingerprintFor(promptIdentity);
      tx.run('INSERT INTO live_sessions(live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint, client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,?,NULL,NULL,?,?)',
        [liveSessionId, assistantId, context.authorityEpoch, input.idempotencyKey, fingerprint, context.clientId, context.auditId, this.#profileIdentity, promptIdentity, 'accepted', 'detached', now, now]);
      tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=?,memory_provenance=? WHERE live_session_id=?', [JSON.stringify(acceptedPrompt), JSON.stringify({ ...memory, injectedSummaryIds }), liveSessionId]);
      if (toolAcceptance) tx.run('INSERT INTO live_tool_acceptances VALUES (?,?,?)', [liveSessionId, JSON.stringify(toolAcceptance.acceptance), toolAcceptance.sha256]);
      if (pickupJob) { pickupJob.deliverySessionId = liveSessionId; this.#jobs.save(pickupJob, tx); }
      tx.run('INSERT INTO live_grants(grant_id, live_session_id, provider, model, voice, key_reference, permitted_classes, chosen_input_class, revision, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), liveSessionId, this.#profile.provider, this.#profile.liveModelId, this.#profile.voice, this.#profile.keyReference,
          JSON.stringify(this.#profile.route.dataClasses), input.inputClass, this.#revision, now]);
      return this.#snapshot(tx, tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [liveSessionId])!);
    });
    this.#armExpiry();
    return snapshot;
  }

  lookupAuthority(runId: string): LiveAuthority | null {
    const handle = this.#active.get(runId);
    if (!handle || this.#settled(handle) || handle.consumerState !== 'attached') return null;
    return this.#store.transaction(tx => {
      const session = tx.get('SELECT authority_epoch,lifecycle FROM live_sessions WHERE live_session_id=?', [runId]);
      if (!session || session.authority_epoch !== this.#store.authorityEpoch || session.lifecycle !== 'active') return null;
      const row = tx.get('SELECT acceptance_json,accepted_run_hash FROM live_tool_acceptances WHERE live_session_id=?', [runId]);
      return row ? { ...JSON.parse(String(row.acceptance_json)) as RunAcceptance, acceptedRunHash: String(row.accepted_run_hash) } : null;
    });
  }

  /** Additional authority source for a dispatched job only; Live session lookup remains unchanged. */
  lookupJobAuthority(runId: string): LiveAuthority | null {
    const job = this.#jobs.list().find(job => job.originSessionId === runId && job.state === 'in_progress');
    return job && job.host.authorityEpoch === this.#store.authorityEpoch ? job.authority : null;
  }

  /** The feed's own job rows: this session's jobs only. A completed job keeps its card until the
   * outbox row expires a day later; after that the row is stale data and never a current line. */
  #feedJobs(tx: Transaction, liveSessionId: string): import('./types.js').PendingLiveJob[] {
    return feedJobs(this.#jobs.list(tx), liveSessionId, this.#now());
  }

  #jobProjection(pendingOnly: boolean): import('./types.js').PendingLiveJob[] {
    return this.#jobs.list().filter(job => job.deferred && (!pendingOnly || !job.delivered)).map(jobRow);
  }

  pendingJobs(): import('./types.js').PendingLiveJob[] { return this.#jobProjection(true); }

  createWithPending(input: CreateLiveSession, context: LiveContext): LiveSessionSnapshot {
    const priorPickup = this.#store.transaction(tx => {
      const prior = tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE owner_assistant_id=? AND idempotency_key=?', [this.#store.assistantId, input.idempotencyKey]);
      return prior ? validateAcceptedPrompt(JSON.parse(String(prior['accepted_prompt_snapshot'])), this.#store.assistantId).pickup?.jobId ?? null : undefined;
    });
    const pickupJobId = input.pickupJobId ?? (priorPickup !== undefined ? priorPickup ?? undefined : this.#jobs.pending().find(job => job.state !== 'in_progress')?.id);
    return this.create({ ...input, ...(pickupJobId ? { pickupJobId } : {}) }, context);
  }

  current(cursor = 0): LivePageProjection {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new LiveError('invalid_request');
    let handle: ActiveSession | undefined;
    const page: LivePageProjection = this.#store.transaction(tx => {
      const row = tx.get('SELECT live_session_id,lifecycle,created_at,updated_at,terminal_at,terminal_outcome,memory_provenance FROM live_sessions WHERE owner_assistant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [this.#store.assistantId]);
      // A fresh origin or session restart opens on a blank voice view: an idle page carries no job rows,
      // and a live page carries only the rows of its own session (UI3b).
      const jobs = row ? this.#feedJobs(tx, String(row.live_session_id)) : [];
      if (!row) return { state: 'idle', since: null, ...(jobs.length ? { jobs } : {}), entries: [], cursor };
      handle = this.#active.get(String(row.live_session_id));
      const terminal = parseTerminal(row.terminal_outcome);
      const pastSession: LivePageProjection['pastSession'] = terminal || !handle
        ? { outcome: terminal?.state ?? 'unknown', endedAt: terminal ? Number(row.terminal_at) : null, lastObservedAt: Number(row.updated_at) } : undefined;
      const state: LivePageProjection['state'] = pastSession ? (!terminal && row.lifecycle === 'accepted' ? 'idle' : 'ended') : handle ? this.#handleState(handle) : 'idle';
      const rows = tx.all('SELECT journal_id,kind,text,tool_json FROM live_journal WHERE live_session_id=? AND journal_id>? ORDER BY journal_id LIMIT 100', [String(row.live_session_id), cursor]);
      const entries: LivePageProjection['entries'] = [];
      for (const item of rows) {
        const seq = Number(item.journal_id), kind = String(item.kind);
        if (kind === 'inputTranscription' || kind === 'outputTranscription') entries.push({ seq, kind, text: String(item.text ?? '') });
        else if (kind === 'toolCall' || kind === 'toolResult') {
          const tool = JSON.parse(String(item.tool_json)) as LiveToolProjection;
          entries.push({ seq, kind, tool: kind === 'toolCall' ? { name: tool.name, status: 'called' } : { name: tool.name, status: tool.status, markdown: tool.markdown, sources: tool.sources.map(source => ({ title: source.title, ...(source.url ? { url: source.url } : {}) })) } });
        } else if (kind === 'continuity') entries.push({ seq, kind, ...JSON.parse(String(item.text)) });
        else if (kind === 'researchProgress') { const p = JSON.parse(String(item.text)) as ResearchProgressView; entries.push({ seq, kind, progress: { researchId: p.researchId, phase: p.phase, sourcesDone: p.sourcesDone, sourcesPending: p.sourcesPending, elapsedMs: p.elapsedMs } }); }
        else if (kind === 'interrupted' || kind === 'turnComplete' || kind === 'terminal') entries.push({ seq, kind });
      }
      const steps = handle !== undefined ? handle.liveSteps.map(step => ({ ...step })) : [];
      return { state, ...(pastSession ? { pastSession } : {}), since: Number(row.created_at), memory: memoryProjection(row['memory_provenance']), ...(jobs.length ? { jobs } : {}), entries, ...(steps.length ? { steps } : {}), cursor: rows.length ? Number(rows[rows.length - 1]!.journal_id) : cursor };
    });
    this.#observeState(handle, page.state, 'poll');
    return page;
  }

  /** One metadata-only host record per projected state change, so the orb timeline is reconstructable
   *  from host.log even though audio is never journalled (F7). */
  #observeState(handle: ActiveSession | undefined, state: LivePageProjection['state'], cause: LiveStateCause): void {
    const from = handle ? handle.liveState : this.#lastProjectedState;
    if (state === from) return;
    if (handle) handle.liveState = state;
    this.#lastProjectedState = state;
    hostLogEvent({ event: 'live_state', state, ...(from === undefined ? {} : { from }), cause, at: this.#now() });
  }

  /** The live state of an open session, the same derivation the web page reads. */
  /** D5: a tool call in flight or an answer owed is open work, so the orb is THINKING through the lookup and
   *  the silence before her reply, whatever the adapter's silence model reports meanwhile. */
  #handleState(handle: ActiveSession): LivePageProjection['state'] {
    const working = handle.pendingCallIds.size > 0 || handle.awaitingAnswer;
    return handle.rebuilding ? 'rebuilding' : working || handle.thinking ? 'thinking' : handle.speaking ? 'speaking' : handle.consumerState === 'attached' ? 'listening' : 'ended';
  }

  /** Every transition is written when it happens, not only when a web page polls for it. */
  #noteState(handle: ActiveSession, cause: LiveStateCause): void {
    this.#observeState(handle, this.#handleState(handle), cause);
  }

  get(liveSessionId: string): LiveSessionSnapshot {
    this.#guardOpen();
    const snapshot = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      return this.#snapshot(tx, this.#expireInTx(tx, row, this.#now()));
    });
    this.#armExpiry();
    return snapshot;
  }

  listFragments(query: { liveSessionId: string; cursor?: number; limit?: number }): LiveFragmentPage {
    this.#guardOpen();
    if (!query || typeof query.liveSessionId !== 'string') throw new LiveError('invalid_request');
    const cursor = query.cursor === undefined ? 0 : query.cursor;
    const limit = query.limit === undefined ? 100 : query.limit;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new LiveError('invalid_request');
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxPage) throw new LiveError('invalid_request');
    const page = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [query.liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      this.#expireInTx(tx, row, this.#now());
      return readFragmentPage(tx, query.liveSessionId, cursor, limit);
    });
    this.#armExpiry();
    return page;
  }

  attach(input: { liveSessionId: string }, context: LiveContext): LiveAttachment {
    this.#guardOpen();
    if (!input || typeof input.liveSessionId !== 'string') throw new LiveError('invalid_request');
    this.#authorize(context);
    if (this.#invalidated) throw new LiveError('invalidated');
    const revision = this.#revision;
    const now = this.#now();
    const prepared = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [input.liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      if (String(row['profile_identity']) !== this.#profileIdentity) throw new LiveError('invalidated');
      if (String(row['lifecycle']) === 'terminal') throw new LiveError('terminal');
      if (String(row['lifecycle']) !== 'accepted') throw new LiveError('already_attached');
      if (this.#expireInTx(tx, row, now) !== row) return 'expired' as const;
      let acceptedPrompt: AcceptedPromptSnapshot;
      // Null is a pre-v2 legacy record. Refuse honestly rather than recompile private current state.
      try { acceptedPrompt = validateAcceptedPrompt(JSON.parse(String(row['accepted_prompt_snapshot'])), this.#store.assistantId); }
      catch { throw new LiveError('invalidated'); }
      if (String(row['prompt_identity']) !== identity({ text: acceptedPrompt.system, dataClass: this.#profile.prompt.dataClass })) throw new LiveError('invalidated');
      const grantClasses = tx.get('SELECT permitted_classes FROM live_grants WHERE live_session_id=?', [input.liveSessionId]);
      const permitted: DataClass[] = JSON.parse(String(grantClasses?.['permitted_classes']));
      if (acceptedPrompt.dataClasses.some(c => !permitted.includes(c) || !this.#profile.route.dataClasses.includes(c))) throw new LiveError('invalidated');
      const job = this.#jobs.forSession(input.liveSessionId, tx);
      if (acceptedPrompt.pickup ? !job || job.id !== acceptedPrompt.pickup.jobId || job.delivered
        || identity({ state: job.state, result: job.result ?? null }) !== acceptedPrompt.pickup.identity : Boolean(job)) throw new LiveError('pickup_changed');
      tx.run("UPDATE live_sessions SET lifecycle='opening', dispatch_intent=1, consumer_state='attached', updated_at=? WHERE live_session_id=?", [now, input.liveSessionId]);
      const grant = tx.get('SELECT chosen_input_class FROM live_grants WHERE live_session_id=?', [input.liveSessionId])!;
      return { inputClass: String(grant['chosen_input_class']) as DataClass, acceptedPrompt };
    });
    this.#armExpiry();
    if (prepared === 'expired') throw new LiveError('expired');
    return this.#open(input.liveSessionId, prepared.inputClass, revision, prepared.acceptedPrompt, context);
  }

  /** The HTTP delete owns the transaction; publish handle changes only after it commits. */
  redactDeletedMemory(tx: Transaction, entryId: string): { liveSessionRetainsUntilRebuild: boolean; publish: () => void } {
    let liveSessionRetainsUntilRebuild = [...this.#active.values()].some(handle => !handle.terminal && this.#providerMemory.get(handle)?.get(entryId) === handle.generation);
    const publish: (() => void)[] = [];
    for (const snapshot of scrubMemorySnapshots(tx, entryId)) {
      const handle = this.#active.get(snapshot.id);
      if (!handle || handle.terminal) continue;
      liveSessionRetainsUntilRebuild = true;
      // A staging handle lets the normal journal path maintain the same counters
      // without changing an active request if another owner subsequently rolls back.
      const staged = { ...handle, request: { ...handle.request, system: { ...handle.request.system, text: snapshot.system } } };
      const sequence = this.#persist(staged, { type: 'continuity', sequence: 0, text: JSON.stringify({ event: 'memory_deleted', entryId }) }, 'continuity', tx);
      if (sequence === 'overflow') throw new LiveError('persistence_failed');
      publish.push(() => {
        handle.request = staged.request;
        handle.journalEvents = staged.journalEvents;
        handle.journalBytes = staged.journalBytes;
        const retained = this.#providerMemory.get(handle) ?? new Map<string, number>();
        retained.set(entryId, handle.generation);
        this.#providerMemory.set(handle, retained);
      });
    }
    return { liveSessionRetainsUntilRebuild, publish: () => { for (const apply of publish) apply(); } };
  }

  /** Explicit host entry point: synchronous in-memory invalidation and adapter abort. */
  invalidate(reason: LiveInvalidationReason): void {
    if (reason !== 'revoked' && reason !== 'authority' && reason !== 'profile') throw new LiveError('invalid_request');
    this.#invalidated = true;
    this.#revision += 1;
    for (const handle of [...this.#active.values()]) {
      handle.invalidated = true;
      if (!handle.terminal) this.#settle(handle, { state: 'revoked' }, false, 'ended', null);
      else handle.consumer?.close();
      handle.abort.abort();
    }
  }

  /** Targeted termination: ends exactly this session/grant durably; other sessions unaffected. */
  revoke(liveSessionId: string): void {
    if (typeof liveSessionId !== 'string' || !liveSessionId) throw new LiveError('invalid_request');
    const handle = this.#active.get(liveSessionId);
    if (!handle) {
      this.#store.transaction(tx => {
        const row = tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [liveSessionId, this.#store.assistantId]);
        if (!row) throw new LiveError('not_found');
        if (String(row['lifecycle']) !== 'terminal') this.#terminalInTx(tx, liveSessionId, { state: 'revoked' }, false, this.#now(), 'detached', null);
      });
      this.#armExpiry();
      return;
    }
    handle.invalidated = true;
    if (!handle.terminal) this.#settle(handle, { state: 'revoked' }, false, 'ended', null);
    else handle.consumer?.close();
    handle.abort.abort();
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#expiryTimer?.cancel();
    this.#expiryTimer = undefined;
    const handles = [...this.#active.values()];
    for (const handle of handles) {
      handle.consumer?.discard();
      handle.session.close();
    }
    await Promise.all(handles.map(handle => handle.loopDone.promise));
    for (const handle of handles) handle.resolveDone();
  }

  #jobHistory(sessionId: string, inputClass: DataClass): readonly { role: 'user'; text: string; dataClass: DataClass }[] | undefined {
    const job = this.#jobs.forSession(sessionId);
    if (!job) return undefined;
    const accepted = job.result?.accepted ?? [];
    // Only gate-reconstructed results can become history; never reconstruct raw references here.
    const text = accepted.length ? accepted.map(result => JSON.stringify({ tool: result.binding.name, result: result.response })).join('\n')
      : job.state === 'completed' ? 'The tool finished, but its result could not be authorized for delivery. Report this delivery failure, not success.'
      : `The background job ${job.id} ${job.state === 'unknown' ? 'has an unknown outcome after interruption; it was not replayed' : 'failed'}. Do not invent a successful result.`;
    const classes = accepted.flatMap(result => result.dataClasses ?? [inputClass]);
    const dataClass: DataClass = classes.includes('sensitive') ? 'sensitive' : classes.includes('private') ? 'private' : inputClass;
    return [{ role: 'user', text, dataClass }];
  }

  #open(liveSessionId: string, inputClass: DataClass, revision: number, acceptedPrompt: AcceptedPromptSnapshot, context: LiveContext): LiveAttachment {
    const abort = new AbortController();
    const dataClasses = classes.filter(c => c === inputClass || acceptedPrompt.dataClasses.includes(c));
    let registry: readonly ToolDefinition[] = [], host: HostContext | undefined;
    if (this.#tools) {
      const saved = this.#store.transaction(tx => tx.get('SELECT acceptance_json FROM live_tool_acceptances WHERE live_session_id=?', [liveSessionId]));
      if (!saved) throw new LiveError('invalidated');
      registry = Object.freeze(this.#tools.owner.liveDefinitions(liveSessionId, (tx, id, args) => rememberOwnerNote(tx, id, args, this.#now())).map(tool => Object.freeze({ ...tool, parameters: structuredClone(tool.parameters) })));
      host = { runId: liveSessionId, actorId: context.clientId, authorityEpoch: context.authorityEpoch, revision,
        grants: registry.filter(tool => tool.effect === 'read' || this.#tools!.owner.liveRememberApproved() && tool.name === 'remember_note' && tool.accountId === 'gateway:live-voice' && tool.resourceId === 'owner-memory').map(tool => ({ tool: tool.name, effect: tool.effect, accountId: tool.accountId, resourceId: tool.resourceId })) };
    }
    const history = this.#jobHistory(liveSessionId, inputClass);
    // Only the coarse intent tools (and remember) are declared to the model; the connector reads stay
    // dispatchable through the registry so the intent fan-out and the session cache keep working.
    const modelFacing = registry.filter(tool => tool.name === RESEARCH_TOOL_NAME || tool.name === 'remember_note' || OPEN_TOOL_NAMES.has(tool.name));
    // The port carries the original JSON schemas; each adapter builds its own provider dialect.
    const declarations = modelFacing.map(tool => ({ name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) }));
    const system = acceptedPrompt.system;
    const request: LiveVoiceRequest = { opening: 'model_first',
      system: { text: system, dataClass: dataClasses[dataClasses.length - 1]! }, history: history ?? [], dataClasses,
      ...(this.#profile.language !== undefined ? { languageCode: this.#profile.language } : {}),
      ...(declarations.length ? { tools: declarations } : {}) };
    const sessionMs = Math.min(this.#profile.limits.sessionMs, this.#profile.limits.callMaxMs);
    const deadlineMs = Date.now() + sessionMs;
    const deadlineAt = this.#now() + sessionMs;
    const callDeadlineAt = this.#now() + this.#profile.limits.callMaxMs;
    let session: LiveVoiceSession;
    // The journal's provider clock: request time to the open call, response time to the ready ack.
    const openedAt = Date.now();
    try {
      // Absolute wall clock for the adapter; the injected clock is the owner's own durable order.
      session = this.#voice.open(request, { signal: abort.signal, deadlineMs, limits: this.#profile.limits });
    } catch (error) {
      this.#store.transaction(tx => this.#terminalInTx(tx, liveSessionId, { state: 'not_started' }, false, this.#now(), 'ended', null));
      throw error;
    }
    this.#store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='active', updated_at=? WHERE live_session_id=?", [this.#now(), liveSessionId]));
    const handle: ActiveSession = {
      generation: 0, attempts: 0, rebuilding: false, request: structuredClone(request),
      deadlineMs, deadlineAt, callDeadlineAt, idleAt: this.#now() + this.#profile.limits.idleMs, goAwayUntil: undefined,
      recoveries: 0, awaitingAnswer: false, answerAt: undefined,
      sessionTimer: undefined, callTimer: undefined, idleTimer: undefined, pendingCalls: new Map(),
      toolCache: new LiveToolCache(LIVE_CACHE_TTL_MS, () => this.#now()),
      researchLedger: new ResearchLedger(),
      registry, host, toolStep: 0, liveSteps: [], liveStepItems: new Map(), toolCalls: 0, seenIds: new Set(), thinking: false, speaking: false, inaudibleMs: 0, pendingCallIds: new Set(), bargeInCallIds: new Set(), turnCompleteSeen: false, callAborts: new Map(), callStartedAt: new Map(), inputFinalAt: undefined, firstAudioAt: undefined, turnLatin: 0, turnDevanagari: 0, turnChars: 0, turnAfterTool: false, turnInterrupted: false,
      liveSessionId, session, abort, revision, inputClass, ready: false, invalidated: false, terminal: false,
      consumer: new OutputChannel(this.#profile.limits.consumerQueueEvents, this.#profile.limits.consumerQueueBytes),
      consumerState: 'attached', journalEvents: 0, journalBytes: 0, markerSequence: 0, adapterOutcome: undefined,
      diagnosticSnapshots: [], ownerAudioCalls: 0, ownerAudioBytes: 0, ownerRebuildingDropCalls: 0, ownerRebuildingDropBytes: 0, terminalOutcome: null,
      diagnosticTerminalCode: 'outcome_unknown', diagnosticsEmitted: false,
      loopDone: deferred<void>(), done: deferred<LiveSessionSnapshot>(), resolveDone: () => {}, persistFailure: undefined,
    };
    handle.resolveDone = () => {
      try { handle.done.resolve(this.#readSnapshot(liveSessionId)); }
      catch (error) { handle.done.reject(error); }
    };
    journalRecord({ kind: 'live', sessionId: liveSessionId, generation: 0, event: 'provider_setup', stage: 'open',
      requestMs: Date.now() - openedAt, requestChars: request.system.text.length, declarations: declarations.length });
    session.ready.then(() => {
      journalRecord({ kind: 'live', sessionId: liveSessionId, generation: handle.generation, event: 'provider_setup', stage: 'ready',
        responseMs: Date.now() - openedAt });
      if (handle.generation !== 0 || this.#settled(handle)) return;
      handle.ready = true;
      const job = this.#jobs.forSession(liveSessionId);
      if (job) { job.delivered = true; this.#jobs.save(job); }
    }, () => {});
    session.done.catch(() => {});
    this.#observeDiagnostics(handle, session);
    this.#active.set(liveSessionId, handle);
    this.#noteState(handle, 'created');
    void handle.done.promise.catch(() => {});
    // Two named deadlines: the provider session window continues an attended call in a fresh seeded window,
    // the owner call ceiling ends the call for time exactly as before. Neither is the other.
    handle.sessionTimer = this.#schedule(() => this.#sessionWindowEnded(handle), sessionMs);
    handle.callTimer = this.#schedule(() => {
      journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'deadline',
        name: 'call_ceiling', configuredMs: this.#profile.limits.callMaxMs });
      this.#settle(handle, { state: 'failed', code: 'session_timeout' }, false, 'ended', null); }, this.#profile.limits.callMaxMs);
    this.#armIdle(handle, this.#profile.limits.idleMs);
    void this.#consume(handle).catch(error => this.#consumeFailed(handle, error));
    const ready = session.ready.then(() => this.#readSnapshot(liveSessionId));
    void ready.catch(() => {});
    return {
      liveSessionId,
      ready,
      output: handle.consumer,
      done: handle.done.promise,
      sendAudio: ({ pcm }) => this.#sendAudio(handle, pcm),
      endAudioStream: () => { if (handle.rebuilding) return; this.#guardHandle(handle); handle.session.endAudioStream(); },
      close: () => this.#stop(handle),
      detach: () => this.#detach(handle),
      overflow: () => {
        if (handle.terminal) return;
        handle.consumerState = 'backpressure';
        this.#settle(handle, { state: 'consumer_backpressure' }, false, 'backpressure', null);
      },
    };
  }

  #armIdle(handle: ActiveSession, remainingMs: number): void {
    if (this.#settled(handle)) return;
    handle.idleTimer?.cancel();
    handle.idleAt = this.#now() + remainingMs;
    handle.idleTimer = this.#schedule(() => {
      // #303: an idle expiry after model audio had streamed, with no turnComplete ever seen, is the shape the
      // 3h-a witness stalled in: the greeting played, then the provider went silent without ending its turn.
      // Record the silence since the last model audio so the next such stall is distinguishable from a
      // turnComplete the adapter failed to map.
      if (handle.lastModelAudioAt !== undefined && !handle.turnCompleteSeen) hostLogEvent({ event: 'live_turn_open',
        msSinceLastModelAudio: this.#now() - handle.lastModelAudioAt });
      this.#settle(handle, { state: 'failed', code: 'idle_timeout' }, false, 'ended', null);
    }, remainingMs);
  }

  /**
   * Class B (R1-R1): after a tool result the answer is owed, so ONE deadline is armed on the response
   * watchdog: the neutral continuation input at 8 s and the fresh-seeded recovery 7 s after it, never 23 s
   * (amendment A). Only the answer's own audible audio or an ended turn clears the obligation, so inaudible
   * fill frames can no longer push the deadline out forever (D3).
   */
  #armDeadAir(handle: ActiveSession): void {
    if (this.#settled(handle)) return;
    // 3j: the tool result is conversational activity, so the idle clock restarts here rather than on mic frames.
    this.#armIdle(handle, this.#profile.limits.idleMs);
    handle.awaitingAnswer = true;
    handle.answerAt = this.#now();
    handle.progressSentAt = undefined;
    this.#armProgress(handle);
    this.#armDelegationDeadline(handle);
    this.#armWatchdog(handle);
  }

  /** S4a: only the GPT-Live path carries progress speech, and only while the adapter declares it. */
  #progressPath(handle: ActiveSession): boolean {
    return this.#profile.provider === 'openai' && typeof handle.session.sendCommentary === 'function';
  }

  /** S4a: a factual line from this turn's step ledger, naming only sources actually running or done. */
  #progressLine(handle: ActiveSession): string | undefined {
    const running: string[] = [];
    const done: string[] = [];
    for (const step of handle.liveSteps) (step.phase === 'end' ? done : running).push(step.source);
    // Never invent progress: a turn with no ledger has nothing truthful to say, so it says nothing.
    if (!running.length && !done.length) return undefined;
    const parts: string[] = [];
    if (running.length) parts.push(`Still reading the ${joinWords([...new Set(running)])}`);
    if (done.length) parts.push(`the ${joinWords([...new Set(done)])} lookup is done`);
    return `${parts.join('; ')}.`;
  }

  /** One progress line, at most one per delegation every 8 s, suppressed while the owner speaks or an answer plays. */
  #sendProgress(handle: ActiveSession, reason: 'dead_air' | 'stalled'): boolean {
    if (this.#settled(handle) || handle.rebuilding || !this.#progressPath(handle)) return false;
    const now = this.#now();
    if (handle.progressSentAt !== undefined && now - handle.progressSentAt < PROGRESS_INTERVAL_MS) return false;
    if (handle.speaking) return false;
    if (handle.inputAt !== undefined && now - handle.inputAt < SPEAKING_HOLD_MS) return false;
    if (handle.lastModelAudioAt !== undefined && now - handle.lastModelAudioAt < PROGRESS_QUIET_MS) return false;
    const line = this.#progressLine(handle);
    if (line === undefined) return false;
    try { handle.session.sendCommentary!({ text: line }); } catch { return false; }
    handle.progressSentAt = now;
    hostLogEvent({ event: 'commentary_sent', delegationKey: this.#delegationKey(handle), reason });
    return true;
  }

  /** The delegation a receipt names: this session window, which is the one delegation the host can speak for. */
  #delegationKey(handle: ActiveSession): string { return `${handle.liveSessionId}-${handle.generation}`; }

  #armProgress(handle: ActiveSession): void {
    handle.progressTimer?.cancel();
    handle.progressTimer = undefined;
    if (!this.#progressPath(handle)) return;
    handle.progressTimer = this.#schedule(() => this.#progressTick(handle), PROGRESS_FIRST_MS);
    handle.progressTimer.unref?.();
  }

  #progressTick(handle: ActiveSession): void {
    handle.progressTimer = undefined;
    if (this.#settled(handle) || handle.rebuilding) return;
    // A delegation is open while its calls run and until the answer's own audio arrives.
    if (handle.pendingCallIds.size === 0 && !handle.awaitingAnswer) return;
    this.#sendProgress(handle, 'dead_air');
    // The cadence is the interval, not the attempt, so a suppressed line is retried on the same 8 s beat.
    handle.progressTimer = this.#schedule(() => this.#progressTick(handle), PROGRESS_INTERVAL_MS);
    handle.progressTimer.unref?.();
  }

  #cancelProgress(handle: ActiveSession): void {
    handle.progressTimer?.cancel(); handle.progressTimer = undefined;
    handle.delegationTimer?.cancel(); handle.delegationTimer = undefined;
    handle.stalledNoRebuild = false;
  }

  #armDelegationDeadline(handle: ActiveSession): void {
    handle.delegationTimer?.cancel();
    handle.delegationTimer = undefined;
    if (this.#profile.provider !== 'openai') return;
    handle.delegationTimer = this.#schedule(() => this.#delegationDeadline(handle), DELEGATION_DEADLINE_MS);
    handle.delegationTimer.unref?.();
  }

  /** S4a: a delegation open past its deadline gets one receipt, one spoken line, and no session rebuild. */
  #delegationDeadline(handle: ActiveSession): void {
    handle.delegationTimer = undefined;
    if (this.#settled(handle) || handle.rebuilding || !handle.awaitingAnswer) return;
    // A nested response that finished the answer is a terminal event, so only silence past the answer is a stall.
    if (handle.lastModelAudioAt !== undefined && handle.lastModelAudioAt > (handle.answerAt ?? 0)) return;
    hostLogEvent({ event: 'gptlive_delegation_stalled', ms: Math.max(0, this.#now() - (handle.answerAt ?? this.#now())) });
    handle.stalledNoRebuild = true;
    this.#sendProgress(handle, 'stalled');
  }

  /** S4a: a bounded wait on tool work that resolves to `timeout` instead of running past the host ceiling. */
  #withCeiling<T>(work: Promise<T>): Promise<T | 'timeout'> {
    return new Promise<T | 'timeout'>((resolve, reject) => {
      const timer = this.#schedule(() => resolve('timeout'), TOOL_CEILING_MS);
      timer.unref?.();
      void work.then(
        value => { timer.cancel(); resolve(value); },
        error => { timer.cancel(); reject(error instanceof Error ? error : new Error('tool_failed')); },
      );
    });
  }

  /** D6: the adapter's 500 ms output-silence model reports waitingForInput between her sentences. That is
   *  presentation, not the end of the turn, so the orb holds SPEAKING until turnComplete or 1,500 ms of
   *  audible silence, whichever comes first (amendment D). */
  #holdSpeaking(handle: ActiveSession): void {
    this.#cancelSpeakingHold(handle);
    const audibleAt = handle.lastModelAudioAt;
    const due = audibleAt === undefined ? 0 : audibleAt + SPEAKING_HOLD_MS - this.#now();
    if (due <= 0) { handle.speaking = false; return; }
    const generation = handle.generation;
    handle.speakingHoldTimer = this.#schedule(() => {
      handle.speakingHoldTimer = undefined;
      if (this.#settled(handle) || generation !== handle.generation) return;
      handle.speaking = false;
      this.#noteState(handle, 'silence');
    }, due);
    handle.speakingHoldTimer.unref?.();
  }

  #cancelSpeakingHold(handle: ActiveSession): void { handle.speakingHoldTimer?.cancel(); handle.speakingHoldTimer = undefined; }

  /**
   * 3j: the response watchdog. A turn that owes a reply and delivers nothing is a stall even with a healthy
   * socket, which is why no transport deadline sees it. Only neutral port events arm, refresh and clear it.
   */
  #armWatchdog(handle: ActiveSession): void {
    if (this.#settled(handle) || handle.rebuilding) return;
    // A tool call in flight owns the silence through the dead-air path: never two timers on one silence.
    if (handle.pendingCallIds.size > 0) { this.#cancelWatchdog(handle); return; }
    // One record per phase change: a streaming reply refreshes the clock on every chunk and must not write a
    // receipt per chunk into the rotating host log.
    const wasArmed = handle.watchdogPhase === 'armed';
    handle.watchdogTimer?.cancel();
    handle.watchdogSince ??= this.#now();
    handle.watchdogPhase = 'armed';
    if (!wasArmed) hostLogEvent({ event: 'live_watchdog', phase: 'armed', turnAgeMs: this.#now() - handle.watchdogSince, generation: handle.generation });
    this.#scheduleWatchdog(handle, RESPONSE_WATCHDOG_NUDGE_MS, handle.generation, 'nudge');
  }

  #scheduleWatchdog(handle: ActiveSession, delayMs: number, generation: number, step: 'nudge' | 'recover'): void {
    handle.watchdogTimer = this.#schedule(() => {
      if (this.#settled(handle) || generation !== handle.generation) return;
      if (handle.pendingCallIds.size > 0) return;
      const turnAgeMs = this.#now() - (handle.watchdogSince ?? this.#now());
      if (step === 'nudge') {
        if (handle.watchdogPhase === 'nudged') return;
        // One stall receipt per nudged deadline: how long the answer has been owed and how long since any
        // audible output. Only the answer's own audio re-arms it, so a fill frame never writes a false healthy.
        // The owed answer is the tool result's own bookkeeping, so progress speech defers the clock without
        // erasing the obligation (amendment A).
        if (handle.answerAt !== undefined) {
          hostLogEvent({ event: 'live_dead_air', msSinceTool: Math.max(0, this.#now() - (handle.answerAt ?? this.#now())),
            msSinceAudible: handle.lastModelAudioAt === undefined ? null : Math.max(0, this.#now() - handle.lastModelAudioAt) });
          hostLogEvent({ event: 'live_dead_air_nudge', elapsedMs: DEAD_AIR_NUDGE_MS });
        }
        // S4a: on the GPT-Live path progress speech replaces the "Continue." user message, which under Responses
        // delegation would be a fake owner turn. Gemini keeps its nudge unchanged.
        if (this.#progressPath(handle)) this.#sendProgress(handle, 'dead_air');
        else { try { handle.session.sendText({ text: DEAD_AIR_NUDGE_TEXT }); } catch { return; } }
        handle.watchdogPhase = 'nudged';
        hostLogEvent({ event: 'live_watchdog', phase: 'nudged', turnAgeMs, generation });
        this.#scheduleWatchdog(handle, RESPONSE_WATCHDOG_RECOVERY_MS, generation, 'recover');
        return;
      }
      void this.#watchdogRecover(handle, generation, turnAgeMs).catch(() => { /* recovery settles its own failures */ });
    }, delayMs);
    handle.watchdogTimer.unref?.();
  }

  #cancelWatchdog(handle: ActiveSession): void {
    handle.watchdogTimer?.cancel(); handle.watchdogTimer = undefined;
    handle.watchdogSince = undefined; handle.watchdogPhase = undefined;
  }

  /** One neutral event either leaves a turn owing a reply (arm), refreshes the silence clock (re-arm) or clears it. */
  #watchdogEvent(handle: ActiveSession, event: LiveVoiceEvent): void {
    if (this.#settled(handle) || handle.rebuilding) return;
    const type = event.type;
    // D3: a fill frame is not output. The provider streams inaudible frames between sentences, so re-arming
    // on one would push the deadline out forever and no stall would ever be witnessed.
    if (type === 'audio' && event.audible === false) return;
    if (type === 'turnComplete' || type === 'interrupted' || type === 'toolCall' || type === 'toolCallCancellation') { this.#cancelWatchdog(handle); return; }
    // The owner's turn ended (a final transcription, or the provider's voice-activity end): a reply is owed.
    if (type === 'inputTranscription') { if (event.finished === true) this.#armWatchdog(handle); return; }
    if (type === 'waitingForInput') { if (event.value === false) this.#armWatchdog(handle); return; }
    if (type === 'modelTurnStarted') { this.#armWatchdog(handle); return; }
    if (type === 'audio' || type === 'outputTranscription' || type === 'modelText') {
      // Output arrived, so the clock restarts; the turn stays watched only while it is still open.
      if (handle.turnCompleteSeen) this.#cancelWatchdog(handle); else this.#armWatchdog(handle);
    }
  }

  async #watchdogRecover(handle: ActiveSession, generation: number, turnAgeMs: number): Promise<void> {
    if (this.#settled(handle) || generation !== handle.generation || handle.pendingCallIds.size > 0) return;
    const previous = handle.watchdogRecoveredAt;
    this.#cancelWatchdog(handle);
    if (previous !== undefined && this.#now() - previous < RESPONSE_WATCHDOG_WINDOW_MS) {
      // A second mute inside the window would loop on the same broken provider: end the call honestly.
      hostLogEvent({ event: 'live_watchdog', phase: 'settled', turnAgeMs, generation });
      this.#settle(handle, { state: 'failed', code: 'model_unresponsive' }, false, 'ended', null);
      return;
    }
    handle.watchdogRecoveredAt = this.#now();
    hostLogEvent({ event: 'live_watchdog', phase: 'recovered', turnAgeMs, generation });
    // S4a: a delegation still open when the watchdog fires is a stall, not a mute model, so the session is resumed
    // rather than rebuilt; the stall receipt at DELEGATION_DEADLINE_MS names it.
    const stalledDelegation = handle.awaitingAnswer || handle.pendingCallIds.size > 0;
    await this.#recoverFromDrop(handle, undefined, handle.stalledNoRebuild !== true && !stalledDelegation, 'model_mute');
    handle.stalledNoRebuild = false;
  }

  #continuity(handle: ActiveSession, event: 'rebuilding' | 'resumed', reason?: string): void {
    journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'continuity', state: event,
      ...(reason === undefined ? {} : { reason }) });
    const journalSequence = this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify({ event, ...(reason ? { reason } : {}) }) }, 'continuity');
    if (journalSequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', null); return; }
    this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'continuity', event, ...(reason ? { reason } : {}), sequence: null, journalSequence, text: null, finished: null, value: null } });
  }

  /** Build the seeded history for a fresh recovery from this session's journal, bounded to SEED_CHAR_LIMIT. */
  #seedHistory(liveSessionId: string, inputClass: DataClass): { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number } {
    const rows = this.#store.transaction(tx => tx.all(
      "SELECT kind,text,finished FROM live_journal WHERE live_session_id=? AND kind IN ('inputTranscription','outputTranscription') AND text IS NOT NULL ORDER BY journal_id",
      [liveSessionId]));
    const turns: { role: 'user' | 'model'; text: string }[] = [];
    let role: 'user' | 'model' | undefined; let pending = '';
    const flush = () => { if (role !== undefined && pending.trim().length) turns.push({ role, text: pending.trim() }); pending = ''; role = undefined; };
    for (const row of rows) {
      const next: 'user' | 'model' = String(row['kind']) === 'inputTranscription' ? 'user' : 'model';
      if (role !== undefined && role !== next) flush();
      role = next; pending += String(row['text'] ?? '');
      if (Number(row['finished']) === 1) flush();
    }
    flush();
    // Newest kept: drop whole oldest turns until the seed fits, then cap to the adapter's turn ceiling.
    let start = 0; let chars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    while (start < turns.length && chars > SEED_CHAR_LIMIT) { chars -= turns[start]!.text.length; start += 1; }
    const kept = turns.slice(start).slice(-128).map(turn => ({ role: turn.role, text: turn.text, dataClass: inputClass }));
    return { turns: kept, chars };
  }

  /** A provider session window ended: an attended call takes a fresh seeded window, an unattended one ends where it is. */
  #sessionWindowEnded(handle: ActiveSession): void {
    journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'deadline',
      name: 'provider_session', configuredMs: this.#profile.limits.sessionMs });
    if (this.#attended(handle)) { void this.#continueSession(handle); return; }
    this.#settle(handle, { state: 'failed', code: 'session_timeout' }, false, 'ended', null);
  }

  /** Only an attended call takes another provider window; a caller who already left never holds one open. */
  #attended(handle: ActiveSession): boolean { return !this.#settled(handle) && handle.consumerState === 'attached'; }

  #isSessionDeadline(outcome: LiveVoiceOutcome | undefined): boolean {
    return outcome !== undefined && (outcome.code === 'session_timeout' || outcome.code === 'deadline');
  }

  #delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => { const timer = this.#schedule(() => resolve(), Math.max(1, Math.ceil(ms))); (timer as { unref?: () => void }).unref?.(); });
  }

  /**
   * Open one recovery socket. `resume` reuses the saved handle; `fresh_seeded` opens a fresh setup whose
   * history is the journal seed and whose opening input is the pickup line. Returns false only on a
   * synchronous refusal; an asynchronous failure surfaces as rebuilding && !ready on the next loop pass.
   */
  #openRecovery(handle: ActiveSession, path: 'resume' | 'fresh_seeded', savedHandle: string | undefined, remaining: number, idle: number, window: number, seed: { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number }, reason: string | null): boolean {
    handle.sessionTimer?.cancel();
    handle.attempts += 1; handle.generation += 1; handle.rebuilding = true; handle.ready = false;
    this.#noteState(handle, 'rebuild');
    handle.lastRecoveryPath = path;
    this.#cancelSpeakingHold(handle);
    handle.thinking = false; handle.speaking = false;
    this.#store.transaction(tx => tx.run('UPDATE live_sessions SET connection_generation=? WHERE live_session_id=?', [handle.generation, handle.liveSessionId]));
    handle.consumer.dropAudio();
    // Fence before closing: neither iterator callbacks nor pending async tool work can cross the cut.
    handle.session.close();
    for (const id of handle.pendingCallIds) {
      const tool: LiveToolProjection = { callId: id, name: handle.pendingCalls.get(id) ?? 'unknown', status: 'error', code: 'tool_call_lost_on_resume', markdown: 'Tool call lost when the voice connection resumed.', sources: [] };
      const journalSequence = this.#persist(handle, { type: 'toolResult', sequence: 0, tool }, 'toolResult');
      if (journalSequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', null); return false; }
      this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'toolResult', sequence: null, journalSequence, text: null, finished: null, value: null, tool } });
    }
    handle.pendingCallIds.clear(); handle.pendingCalls.clear(); handle.bargeInCallIds.clear();
    this.#continuity(handle, 'rebuilding', reason ?? undefined);
    if (this.#settled(handle)) return false;
    handle.deadlineAt = this.#now() + remaining; handle.deadlineMs = Date.now() + remaining;
    const request = path === 'fresh_seeded'
      ? { ...structuredClone(handle.request), history: seed.turns, openingText: LIVE_RECOVERY_PICKUP }
      : { ...structuredClone(handle.request), resumptionHandle: savedHandle as string };
    try {
      handle.session = this.#voice.open(request, {
        signal: handle.abort.signal, deadlineMs: handle.deadlineMs, idleResetMs: this.#profile.limits.idleMs,
        limits: { ...this.#profile.limits, sessionMs: Math.ceil(remaining), idleMs: Math.ceil(idle), handshakeMs: Math.max(1, Math.ceil(Math.min(this.#profile.limits.handshakeMs, window, remaining, idle))) },
      });
      void handle.session.ready.catch(() => {}); void handle.session.done.catch(() => {});
      this.#observeDiagnostics(handle, handle.session);
      handle.goAwayUntil = undefined;
    } catch { return false; }
    handle.sessionTimer = this.#schedule(() => this.#sessionWindowEnded(handle), Math.max(1, Math.ceil(remaining)));
    return true;
  }

  /** Record one recovery attempt (metadata only): the path, the outcome code, close code and seed size. */
  #logRecovery(handle: ActiveSession, path: 'resume' | 'fresh_seeded', code: string, closeCode: number | null, reason: string | null, seed: { turns: unknown[]; chars: number }): void {
    hostLogEvent({ event: 'live_recovery', path, attempt: handle.recoveries + 1, code, closeCode, reason, seedTurns: seed.turns.length, seedChars: seed.chars });
    journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'recovery', path,
      attempt: handle.recoveries + 1, code, closeCode, reason, seedTurns: seed.turns.length, seedChars: seed.chars });
  }

  /**
   * Recover from a dropped connection (R1-R1): reuse the saved handle when it is reusable, else open a
   * fresh seeded setup; a failed resume falls through to one fresh seeded attempt. Each socket open counts
   * against the per-episode bound, backoff is 0/2/5 s, and the current session deadline does not move.
   */
  async #recoverFromDrop(handle: ActiveSession, outcome: LiveVoiceOutcome | undefined, forceFresh = false, reasonOverride?: string): Promise<boolean> {
    const now = this.#now();
    if (handle.lastHealthyAt !== undefined && now - handle.lastHealthyAt >= RECOVERY_HEALTHY_MS) handle.recoveries = 0;
    if (handle.recoveries >= RECOVERY_MAX_CONSECUTIVE) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
    const remaining = handle.deadlineAt - now, idle = handle.idleAt - now;
    const window = Math.min(10_000, handle.goAwayUntil === undefined ? 10_000 : handle.goAwayUntil - now);
    if (remaining <= 0 || idle <= 0 || window <= 0) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
    const backoff = RECOVERY_BACKOFF_MS[Math.min(handle.recoveries, RECOVERY_BACKOFF_MS.length - 1)]!;
    if (backoff > 0) await this.#delay(backoff);
    if (this.#settled(handle)) return false;
    const failedResume = handle.lastRecoveryPath === 'resume';
    const saved = this.#store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [handle.liveSessionId]));
    const savedHandle = saved?.['resumption_handle'];
    const hasHandle = typeof savedHandle === 'string' && savedHandle.length > 0;
    const seed = this.#seedHistory(handle.liveSessionId, handle.inputClass);
    const reuse = !forceFresh && this.#voice.capabilities.supportsResumption && hasHandle && handle.toolCalls < RESUMPTION_TOOL_CALL_LIMIT && !failedResume;
    const closeCode = outcome?.upstream?.closeCode ?? null;
    const reason = reasonOverride ?? outcome?.code ?? null;
    const path: 'resume' | 'fresh_seeded' = reuse ? 'resume' : 'fresh_seeded';
    let opened = this.#openRecovery(handle, path, path === 'resume' ? savedHandle as string : undefined, remaining, idle, window, seed, reason);
    if (!opened && path === 'resume') {
      this.#logRecovery(handle, 'resume', 'open_failed', closeCode, reason, seed);
      handle.recoveries += 1;
      if (handle.recoveries >= RECOVERY_MAX_CONSECUTIVE) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
      opened = this.#openRecovery(handle, 'fresh_seeded', undefined, remaining, idle, window, seed, reason);
    }
    if (opened) {
      // A failed resume leaves an unusable handle: clear it so the next drop goes straight to fresh seeded.
      if (failedResume) this.#store.transaction(tx => tx.run('UPDATE live_sessions SET resumption_handle=NULL WHERE live_session_id=?', [handle.liveSessionId]));
      this.#logRecovery(handle, path, 'opened', closeCode, reason, seed);
      return true;
    }
    handle.recoveries += 1;
    this.#logRecovery(handle, path, 'open_failed', closeCode, reason, seed);
    if (handle.recoveries >= RECOVERY_MAX_CONSECUTIVE) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
    // A synchronous refusal (rare) retries after the next backoff rather than ending the call.
    await this.#delay(RECOVERY_BACKOFF_MS[Math.min(handle.recoveries, RECOVERY_BACKOFF_MS.length - 1)]!);
    if (this.#settled(handle)) return false;
    return this.#recoverFromDrop(handle, outcome, forceFresh, reasonOverride);
  }

  /**
   * A provider session that reaches its own deadline is a planned continuation, not a failure: open a fresh
   * seeded setup in a new provider window, bounded by the total call ceiling. Only the ceiling ends the call.
   */
  async #continueSession(handle: ActiveSession): Promise<boolean> {
    if (this.#settled(handle) || handle.terminal) return false;
    const now = this.#now();
    const callRemaining = handle.callDeadlineAt - now;
    if (callRemaining <= 0) { this.#settle(handle, { state: 'failed', code: 'session_timeout' }, false, 'ended', null); return false; }
    const idle = handle.idleAt - now;
    if (idle <= 0) { this.#settle(handle, { state: 'failed', code: 'idle_timeout' }, false, 'ended', null); return false; }
    const remaining = Math.min(this.#profile.limits.sessionMs, callRemaining);
    const window = Math.min(10_000, Math.max(1, remaining));
    const seed = this.#seedHistory(handle.liveSessionId, handle.inputClass);
    handle.recoveries = 0; handle.lastRecoveryPath = 'fresh_seeded';
    const opened = this.#openRecovery(handle, 'fresh_seeded', undefined, remaining, idle, window, seed, 'session_deadline');
    if (!opened) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
    this.#logRecovery(handle, 'fresh_seeded', 'session_deadline', null, 'session_timeout', seed);
    return true;
  }

  /** Send operator-typed text into the newest active session as a user turn (W5-R4 item 2). */
  text(text: string): void {
    if (typeof text !== 'string' || !text.length || text.length > 4000) throw new LiveError('invalid_request');
    const handle = [...this.#active.values()].filter(candidate => !candidate.terminal).at(-1);
    if (!handle) throw new LiveError('not_found', 'No active Live session');
    this.#guardHandle(handle);
    const event = { type: 'inputTranscription' as const, sequence: 0, text, finished: true };
    handle.session.sendText({ text });
    this.#armIdle(handle, this.#profile.limits.idleMs);
    const journalSequence = this.#persist(handle, event, 'inputTranscription');
    if (journalSequence === 'overflow') return;
    this.#pushChunk(handle, { kind: 'marker', marker: markerOf(event, 'inputTranscription', journalSequence, ++handle.markerSequence) });
  }
  #sendAudio(handle: ActiveSession, pcm: Uint8Array): void {
    handle.ownerAudioCalls++; handle.ownerAudioBytes += pcm.byteLength;
    // A late mic frame after the session settled is dropped and counted, never thrown:
    // throwing here makes the HTTP layer close the socket generic 1002 before the typed terminal frame.
    if (handle.rebuilding || (handle.terminal && !handle.invalidated)) {
      handle.ownerRebuildingDropCalls++; handle.ownerRebuildingDropBytes += pcm.byteLength;
      // The settle diagnostics were already emitted, so a late drop is counted and reported here.
      if (handle.terminal) console.error(JSON.stringify({ event: 'live_late_frame_dropped', liveSessionId: handle.liveSessionId,
        dropCalls: handle.ownerRebuildingDropCalls, dropBytes: handle.ownerRebuildingDropBytes }));
      return;
    }
    this.#guardHandle(handle);
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 !== 0) throw new LiveError('invalid_audio');
    // 3j: a mic frame is not conversation. Idle measures silence, so frames keep flowing without resetting it.
    countAudio(handle, 'input', pcm.byteLength, this.#now());
    handle.session.sendAudio({ pcm, dataClass: handle.inputClass });
  }

  #observeDiagnostics(handle: ActiveSession, session: LiveVoiceSession): void {
    handle.diagnosticSnapshots.push(session.done.then(() => session.diagnostics?.(), () => session.diagnostics?.()));
  }

  #emitDiagnostics(handle: ActiveSession): void {
    if (handle.diagnosticsEmitted) return;
    handle.diagnosticsEmitted = true;
    void Promise.all(handle.diagnosticSnapshots).then(values => {
      const snapshots = values.filter((value): value is Readonly<LiveVoiceDiagnostics> => value !== undefined);
      const sum = (field: keyof LiveVoiceDiagnostics) => snapshots.reduce((total, value) => total + value[field], 0);
      const accent = this.#profile.overlay?.accent;
      // PV1: the head and the terminal anchors carry the accent block the session composed with, so both
      // are counted from the same composer the instruction used.
      const selection = currentLiveAccent();
      // The head block and the terminal anchor are serialised once, at composition, so their counts come
      // from the same composer the instruction used: the head block from the overlay accent, the terminal
      // anchor from the bare primary language (AC1) rather than the regional setup tag. The serialised
      // instruction must end with the terminal anchor; the fallback covers a locale with no primary.
      const bareLanguage = canonicalSpeechLanguage(this.#profile.language);
      const terminalAnchors = [bareLanguage, undefined].map(language => terminalAnchor(language, accent, selection));
      const terminalAnchorText = terminalAnchors
        .find(candidate => handle.request.system.text.endsWith(candidate)) ?? terminalAnchors[0]!;
      console.error(JSON.stringify({ event: 'live_session_diagnostics', terminalCode: handle.diagnosticTerminalCode,
        headVoiceChars: headAnchor(accent, selection)?.length ?? 0,
        terminalVoiceChars: terminalAnchorText.length,
        adapterGenerations: values.length, ownerAudioCalls: handle.ownerAudioCalls, ownerAudioBytes: handle.ownerAudioBytes,
        ownerRebuildingDropCalls: handle.ownerRebuildingDropCalls, ownerRebuildingDropBytes: handle.ownerRebuildingDropBytes,
        adapterAudioCalls: sum('audioCalls'), adapterAudioBytes: sum('audioBytes'),
        drainingDropCalls: sum('drainingDropCalls'), drainingDropBytes: sum('drainingDropBytes'),
        localWriteEnqueuedCalls: sum('localWriteEnqueuedCalls'), localWriteEnqueuedPCMBytes: sum('localWriteEnqueuedPCMBytes'),
        localWriteCallbackSuccessCalls: sum('localWriteCallbackSuccessCalls'), localWriteCallbackSuccessPCMBytes: sum('localWriteCallbackSuccessPCMBytes'),
        localWriteCallbackErrorCalls: sum('localWriteCallbackErrorCalls'), localWriteCallbackErrorPCMBytes: sum('localWriteCallbackErrorPCMBytes'),
        localWriteCallbackPendingCalls: sum('localWriteCallbackPendingCalls'), localWriteCallbackPendingPCMBytes: sum('localWriteCallbackPendingPCMBytes'),
        inputTranscriptionEvents: sum('inputTranscriptionEvents'), inputTranscriptionCharacters: sum('inputTranscriptionCharacters'),
        generationCompleteEvents: sum('generationCompleteEvents'), turnCompleteEvents: sum('turnCompleteEvents'),
        outputAudioFrames: sum('outputAudioFrames'), outputAudioPCMBytes: sum('outputAudioPCMBytes'),
        outputAudioAfterInitialTurnFrames: sum('outputAudioAfterInitialTurnFrames'), outputAudioAfterInitialTurnPCMBytes: sum('outputAudioAfterInitialTurnPCMBytes') }));
    });
  }

  /** Ordered output admission. Overflow is settled as a durable fact, never silently shed. */
  #pushChunk(handle: ActiveSession, chunk: LiveOutputChunk): void {
    if (handle.consumerState !== 'attached') return;
    if (handle.consumer?.push(chunk) === 'backpressure') {
      handle.consumerState = 'backpressure';
      this.#settle(handle, { state: 'consumer_backpressure' }, false, 'backpressure', null);
    }
  }

  #guardHandle(handle: ActiveSession): void {
    if (handle.invalidated || this.#invalidated || this.#revision !== handle.revision) throw new LiveError('invalidated');
    if (handle.terminal) throw new LiveError('terminal');
    if (!handle.ready) throw new LiveError('not_ready');
  }

  #detach(handle: ActiveSession): void {
    if (handle.consumerState !== 'attached') return;
    handle.consumerState = 'ended';
    handle.consumer?.discard();
    try { this.#store.transaction(tx => tx.run("UPDATE live_sessions SET consumer_state='ended', updated_at=? WHERE live_session_id=?", [this.#now(), handle.liveSessionId])); }
    catch (error) {
      // A failed detach write is logged, never swallowed; #snapshot reconciles the row against this handle.
      console.error(JSON.stringify({ event: 'live_detach_write_failed', liveSessionId: handle.liveSessionId,
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown' }));
    }
    // A session whose consumer stayed away is ended cleanly: the journal is kept, only the spend of talking to
    // nobody stops. A re-attach inside the window flips consumerState back and cancels this by its guard.
    const detachedAt = this.#now();
    // The socket that carried the conversation is gone and no Stop reached us: the session is over. One second is
    // the grace a re-attach needs; before it the app could only have been paused. The five second rule stays as the
    // last net, for a handle whose first timer could not settle it.
    this.#schedule(() => {
      if (handle.consumerState === 'attached') return;
      this.#endAway(handle, 'consumer_closed', Math.max(0, this.#now() - detachedAt));
    }, CONSUMER_CLOSED_MS);
    this.#schedule(() => {
      if (this.#settled(handle) || handle.consumerState === 'attached') return;
      hostLogEvent({ event: 'consumer_gone_end', detachedMs: Math.max(0, this.#now() - detachedAt) });
      this.#settle(handle, { state: 'cancelled', code: 'consumer_gone' }, true, 'ended', null);
    }, CONSUMER_GONE_MS);
  }

  /** One end, one receipt: the journal is kept and the host log names why the call stopped and how long it took. */
  #endAway(handle: ActiveSession, reason: 'consumer_closed' | 'user_stop', msAfterStop: number): void {
    if (this.#settled(handle)) return;
    this.#settle(handle, { state: 'cancelled', code: reason }, true, 'ended', null);
    hostLogEvent({ event: 'session_end', reason, msAfterStop });
  }

  /** The client's explicit Stop: the app released the microphone and wants the call over now, not in five seconds.
   * The owner ended it, so the state is a plain close and the code names the reason. */
  #stop(handle: ActiveSession): void {
    if (this.#settled(handle)) return;
    this.#settle(handle, { state: 'closed', code: 'user_stop' }, true, 'ended', null);
    hostLogEvent({ event: 'session_end', reason: 'user_stop', msAfterStop: 0 });
  }

  /**
   * #331: the consumer loop's handle is already in the caller's hands, so a rejection from the part of the loop
   * that runs after its own try/catch (a durable write against a store that closed underneath it, for example)
   * must not reject into the void. It is the same failed durable write the terminal path already answers: bounded
   * fields in the log, the reader closed, and done resolved with the in-memory outcome, never a fabricated one.
   */
  #consumeFailed(handle: ActiveSession, error: unknown): void {
    handle.persistFailure ??= error;
    console.error(JSON.stringify({ event: 'live_terminal_write_failed', liveSessionId: handle.liveSessionId,
      code: handle.diagnosticTerminalCode,
      class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown' }));
    handle.consumer?.close();
    handle.abort.abort();
    handle.resolveDone();
  }

  async #consume(handle: ActiveSession): Promise<void> {
    while (!this.#settled(handle)) {
    const session = handle.session, generation = handle.generation;
    let outcome: LiveVoiceOutcome | undefined;
    let ownerTurnOpen = false;
    try {
      for await (const event of session.events) {
        if (this.#settled(handle) || generation !== handle.generation) break;
        // 3j: the watchdog sees every port event before the per-type dispatch, because the arms sit on events
        // this loop handles early (modelTurnStarted) and on ones it consumes later.
        this.#watchdogEvent(handle, event);
        // D3: only audio the adapter measured as audible is output. A fill frame is forwarded to playback and
        // nothing else; it neither re-arms the deadline nor answers the obligation.
        const audible = event.type === 'audio' && event.audible !== false;
        // The answer's own audible audio is the one thing that clears the owed reply; progress text does not.
        if (audible || event.type === 'turnComplete') handle.awaitingAnswer = false;
        if (audible || event.type === 'turnComplete') this.#cancelProgress(handle);
        if (event.type === 'turnComplete') handle.answerAt = undefined;
        if (event.type === 'modelTurnStarted') {
          journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'turn_start', speaker: 'model' });
          resetTurnScript(handle);
          handle.firstAudioAt = undefined;
          this.#beginModelTurn(handle);
          // A generation start is the think time. gpt-live-1 sends none for a plain turn, so the adapter
          // synthesizes one when the owner's episode ends, and this is what puts the orb in THINKING.
          if (!handle.speaking) handle.thinking = true;
          handle.turnCompleteSeen = false;
          this.#noteState(handle, 'model_turn_start');
          continue;
        }
        if (event.type === 'resumptionHandle') {
          this.#store.transaction(tx => tx.run('UPDATE live_sessions SET resumption_handle=? WHERE live_session_id=?', [event.handle, handle.liveSessionId]));
          continue;
        }
        if (event.type === 'goAway') {
          handle.goAwayUntil = this.#now() + event.timeLeftMs;
          hostLogEvent({ event: 'live_go_away', timeLeftMs: event.timeLeftMs });
          journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'deadline',
            name: 'provider_go_away', configuredMs: event.timeLeftMs });
          outcome = { status: 'failed', code: 'go_away', recoverable: true };
          break;
        }
        if (event.type === 'contextUsage') {
          // The provider's own usage report, kept with the other numbers and never a payload.
          journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'context_usage',
            totalTokens: event.totalTokens,
            ...(event.promptTokens === undefined ? {} : { promptTokens: event.promptTokens }),
            ...(event.responseTokens === undefined ? {} : { responseTokens: event.responseTokens }) });
          hostLogEvent({ event: 'live_context_usage', totalTokens: event.totalTokens, ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}), ...(event.responseTokens !== undefined ? { responseTokens: event.responseTokens } : {}) });
          continue;
        }
        if (event.type === 'upstreamQueue') {
          hostLogEvent({ event: 'live_upstream_queue', bufferedBytes: event.bufferedBytes });
          continue;
        }
        if (event.type === 'ready') {
          handle.ready = true; handle.lastHealthyAt = this.#now();
          if (handle.rebuilding) { handle.rebuilding = false; this.#noteState(handle, 'rebuild'); this.#continuity(handle, 'resumed'); continue; }
        }
        if (IDLE_ACTIVITY.has(event.type)) this.#armIdle(handle, this.#profile.limits.idleMs);
        if (event.type === 'toolCall') {
          handle.toolCalls += event.calls.length;
          handle.turnAfterTool = true;
          handle.thinking = true;
          for (const call of event.calls) { handle.pendingCallIds.add(call.id); handle.pendingCalls.set(call.id, call.name); if (!handle.callStartedAt.has(call.id)) handle.callStartedAt.set(call.id, this.#now()); }
          this.#openSteps(handle, event.calls);
          this.#sendThinking(handle, event.calls);
          this.#armProgress(handle);
          // D5: the call itself enters THINKING, so the orb never says Listening while the lookup runs.
          this.#noteState(handle, 'tool');
          void this.#toolBatch(handle, event, generation).catch(() => {
            if (this.#settled(handle) || generation !== handle.generation) return;
            const responses = event.calls.filter(call => handle.pendingCallIds.has(call.id)).map(call => ({ id: call.id, name: call.name, response: { error: 'tool_processing_failed' } }));
            try { if (responses.length) handle.session.sendToolResponse({ responses }); } catch { /* transport may have terminated */ }
            for (const call of event.calls) handle.pendingCallIds.delete(call.id);
            if (responses.length) this.#armDeadAir(handle);
            handle.thinking = responses.length > 0 || handle.pendingCallIds.size > 0;
            this.#noteState(handle, 'tool');
          }); continue;
        }
        if (event.type === 'toolCallCancellation') {
          // A provider cancellation (after a barge-in) drops exactly the cancelled ids: their in-flight
          // reads are aborted and no response is sent for them. A plain interrupted is different: those
          // ids stay in pendingCallIds, so their response is still answered once, marked after_barge_in.
          for (const id of event.ids) {
            const started = handle.callStartedAt.get(id);
            hostLogEvent({ event: 'tool_cancelled', tool: handle.pendingCalls.get(id) ?? 'unknown', id, msInFlight: started === undefined ? null : Math.max(0, this.#now() - started) });
            handle.callAborts.get(id)?.abort();
            handle.pendingCallIds.delete(id);
          }
          handle.thinking = handle.pendingCallIds.size > 0;
          this.#noteState(handle, 'tool');
          continue;
        }
        if (event.type === 'interrupted') {
          for (const id of handle.pendingCallIds) handle.bargeInCallIds.add(id);
          handle.speaking = false;
          this.#cancelSpeakingHold(handle);
          // A barge-in ends the model's think time. A tool call in flight or an owed answer still reads as
          // THINKING through it, because that work is still open (D5, amendment C).
          handle.thinking = false;
          this.#noteState(handle, 'interrupted');
          handle.turnInterrupted = true;
          logTurnScript(handle);
          journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'interrupt',
            sinceLastModelAudioMs: handle.lastModelAudioAt === undefined ? null : this.#now() - handle.lastModelAudioAt });
          journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'audio_marker', marker: 'drain',
            outputBytes: audioTotals.get(handle) ?? 0 });
          // E1: one metadata-only host record per provider barge-in. Never audio, text or a provider payload.
          hostLogEvent({ event: 'live_interrupted', liveSessionId: handle.liveSessionId,
            turnCompleteSeen: handle.turnCompleteSeen,
            msSinceLastModelAudio: handle.lastModelAudioAt === undefined ? null : this.#now() - handle.lastModelAudioAt });
        }
        // generationComplete alone does not end SPEAKING: the orb holds it until the turn completes
        // and playback drains (F2).
        if (event.type === 'turnComplete') { journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'turn_end', speaker: 'model', reason: 'turn_complete', inaudibleMs: Math.round(handle.inaudibleMs) }); handle.speaking = false; this.#cancelSpeakingHold(handle); handle.turnCompleteSeen = true; handle.thinking = handle.pendingCallIds.size > 0;
          // The answer is done, so the turn's step lines retire here: a later question that reads nothing
          // must not show the previous turn's sources as if they were running (review finding F2).
          if (handle.pendingCallIds.size === 0) handle.liveSteps = [];
          logTurnScript(handle);
          this.#noteState(handle, 'turn_complete');
        }
        if (event.type === 'waitingForInput') { handle.thinking = !event.value; if (event.value) this.#holdSpeaking(handle); this.#noteState(handle, event.value ? 'silence' : 'input'); }
        if (event.type === 'audio') {
          countAudio(handle, 'output', event.pcm.byteLength, this.#now(), event.rmsDbfs);
          // Only audible speech is SPEAKING (release 3p): the provider streams output frames non-stop, so a frame
          // is model output only when the adapter measured it above the audible threshold.
          if (event.audible === false) {
            handle.inaudibleMs += event.pcm.byteLength / OUTPUT_PCM_BYTES_PER_MS;
            this.#pushChunk(handle, { kind: 'audio', pcm: event.pcm }); continue;
          }
          this.#cancelSpeakingHold(handle);
          handle.thinking = false; handle.speaking = true; handle.lastModelAudioAt = this.#now();
          this.#noteState(handle, 'audio');
          if (handle.firstAudioAt === undefined) {
            handle.firstAudioAt = this.#now();
            if (handle.inputFinalAt !== undefined) {
              hostLogEvent({ event: 'live_dead_air', deadAirMs: Math.max(0, handle.firstAudioAt - handle.inputFinalAt) });
              handle.inputFinalAt = undefined;
            }
          }
          this.#pushChunk(handle, { kind: 'audio', pcm: event.pcm }); continue;
        }
        if (event.type === 'outcome') { outcome = event.outcome; continue; }
        if (event.type === 'outputTranscription') countTurnScript(handle, event.text);
        // The journal keeps what was actually said, both sides, as each transcription finalises.
        if (event.type === 'outputTranscription' || event.type === 'inputTranscription') {
          journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'transcript',
            speaker: event.type === 'inputTranscription' ? 'owner' : 'model', text: event.text, final: event.finished === true });
        }
        if (event.type === 'inputTranscription') {
          if (!ownerTurnOpen) {
            ownerTurnOpen = true;
            journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'turn_start', speaker: 'owner' });
          }
          handle.inputFinalTimer?.cancel();
          handle.inputAt = this.#now();
          handle.inputFinal = event.finished === true;
          if (handle.inputFinal) {
            handle.inputFinalAt = handle.inputAt;
            if (ownerTurnOpen) {
              ownerTurnOpen = false;
              journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'turn_end', speaker: 'owner', reason: 'final' });
            }
          }
        }
        const kind = journalKind(event.type);
        if (kind === null) continue;
        const persisted = this.#persist(handle, event, kind);
        if (persisted === 'overflow') {
          this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind, sequence: event.sequence });
          break;
        }
        if (event.type === 'inputTranscription') {
          handle.inputJournalId = persisted;
          if (handle.inputFinal) for (const resolve of handle.inputFinalWaiters ?? []) resolve();
        }
        this.#pushChunk(handle, { kind: 'marker', marker: markerOf(event, kind, persisted, ++handle.markerSequence) });
      }
    } catch (error) {
      handle.persistFailure = error;
      journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'provider_error',
        message: error instanceof Error ? capJournalText(error.message) : 'unknown' });
    }
    if (!handle.terminal) {
      // A session-deadline continuation opens a new session from the timer; the ended one is superseded.
      if (generation !== handle.generation) continue;
      if (handle.persistFailure) { handle.abort.abort(); handle.done.reject(handle.persistFailure); }
      else {
        outcome ??= await session.done.catch(() => undefined);
        journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation, event: 'provider_close',
          status: outcome?.status ?? 'unknown', code: outcome?.code ?? 'unknown',
          closeCode: outcome?.upstream?.closeCode ?? null, reason: outcome?.upstream?.errorKind ?? null,
          recoverable: outcome?.recoverable === true });
        const failedRecovery = handle.rebuilding && !handle.ready;
        if (failedRecovery) handle.recoveries += 1;
        if (outcome?.recoverable || failedRecovery) {
          const rebuilt = await this.#recoverFromDrop(handle, outcome);
          if (outcome?.upstream) hostLogEvent({ event: 'live_upstream_drop', errorKind: outcome.upstream.errorKind, closeCode: outcome.upstream.closeCode, bufferedAmount: outcome.upstream.bufferedAmount, writesFailed: outcome.upstream.writesFailed, sessionMs: outcome.upstream.sessionMs, rebuilt });
          if (rebuilt) continue;
        } else if (this.#isSessionDeadline(outcome) && this.#attended(handle)) {
          // A provider session deadline continues in a new window; only the call ceiling or idle ends a call.
          if (await this.#continueSession(handle)) continue;
        }
        if (handle.terminal) break;
        if (outcome) this.#settle(handle, { state: outcome.status, code: outcome.code === 'deadline' ? 'session_timeout' : outcome.code }, outcome.status === 'closed', 'ended', null);
        else this.#settle(handle, { state: 'outcome_unknown' }, false, 'ended', null);
      }
    }
    break;
    }
    this.#emitDiagnostics(handle);
    this.#active.delete(handle.liveSessionId);
    handle.loopDone.resolve();
  }

  #beginModelTurn(handle: ActiveSession): void {
    if (handle.inputFinal || handle.inputAt === undefined || handle.inputJournalId === undefined) return;
    handle.inputFinalTimer?.cancel();
    const journalId = handle.inputJournalId, generation = handle.generation;
    handle.inputFinalTimer = this.#schedule(() => {
      if (this.#settled(handle) || handle.generation !== generation || handle.inputJournalId !== journalId) return;
      try {
        this.#store.transaction(tx => tx.run("UPDATE live_journal SET finished=1 WHERE journal_id=? AND live_session_id=? AND kind='inputTranscription'", [journalId, handle.liveSessionId]));
      } catch (error) {
        handle.persistFailure = error;
        handle.abort.abort();
        handle.done.reject(error);
        return;
      }
      handle.inputFinal = true;
      handle.inputFinalAt = this.#now();
      for (const resolve of handle.inputFinalWaiters ?? []) resolve();
    }, Math.max(0, 300 - (this.#now() - handle.inputAt)));
    handle.inputFinalTimer.unref();
  }

  async #waitForOwnerTranscript(handle: ActiveSession, sequence: number): Promise<void> {
    if (handle.inputFinal) return;
    const started = this.#now();
    await new Promise<void>(resolve => {
      const finish = () => {
        timer.cancel();
        handle.inputFinalWaiters?.delete(finish);
        handle.abort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = this.#schedule(finish, 1500);
      timer.unref();
      (handle.inputFinalWaiters ??= new Set()).add(finish);
      handle.abort.signal.addEventListener('abort', finish, { once: true });
    });
    if (!this.#settled(handle)) {
      const retained = this.#persist(handle, { type: 'remember_deferred', sequence, text: String(Math.max(0, this.#now() - started)) }, 'remember_deferred');
      if (retained === 'overflow') this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind: 'remember_deferred', sequence });
    }
  }

  #unreachableSources(): (ResearchSourceKind | UnavailableSource)[] {
    const sources: (ResearchSourceKind | UnavailableSource)[] = [];
    // P5-R5 (F3): the endpoint report carries why it is not connected, and the owner's reply names it.
    // Codes and closed enums only: never the free-text `error`, so no connector text can reach a reply.
    const endpoints = (this.#tools?.status?.().endpoints ?? []) as unknown as readonly {
      connector: string; state: string; reasonCode?: string; configurationError?: string; exception?: { code: string };
    }[];
    for (const endpoint of endpoints) {
      if (endpoint.state === 'connected') continue;
      const reason = endpoint.reasonCode ?? endpoint.configurationError ?? endpoint.exception?.code ?? endpoint.state;
      for (const source of researchSourcesForConnector(endpoint.connector)) {
        if (sources.some(entry => (typeof entry === 'string' ? entry : entry.source) === source)) continue;
        sources.push({ source, reason });
      }
    }
    return sources;
  }

  #researchSources(handle: ActiveSession): ResearchSourceKind[] {
    const names = new Set(handle.registry.map(tool => tool.name));
    const sources: ResearchSourceKind[] = [];
    if (names.has('search_knowledge')) sources.push('knowledge');
    // Outcome 3: detect a source by the tool its read actually uses, never a sibling, so a calendar
    // read is never advertised when the connection only grants the calendar-list sibling.
    if (names.has('gcal_list')) sources.push('calendar');
    if (names.has('gmail_list')) sources.push('mail');
    if (names.has('mattermost_search')) sources.push('chat');
    // Outcome 2: an approved connector that is down keeps its sources in the configured set, so the
    // reply can report them unreachable instead of silently narrowing to the sources still up.
    for (const endpoint of this.#tools?.status?.().endpoints ?? []) {
      if (endpoint.state === 'connected') continue;
      for (const source of researchSourcesForConnector(endpoint.connector)) {
        if (!sources.includes(source)) sources.push(source);
      }
    }
    return sources;
  }

  /** One BLOCKING research call runs its whole bounded loop; `interrupted` never aborts it. */
  async #researchBatch(handle: ActiveSession, event: Extract<LiveVoiceEvent, { type: 'toolCall' }>, generation: number, host: HostContext, allowed: boolean): Promise<{ responses: { id: string; name: string; response: JsonObject }[]; projections: LiveToolProjection[] }> {
    const configured = this.#researchSources(handle);
    const gateAuthority = { isCurrent: async (_host: HostContext, _tool: ToolDefinition, signal: AbortSignal) => allowed && !signal.aborted && generation === handle.generation && !this.#settled(handle) };
    const execute = async (subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]> => {
      // Q1-R3(d): a research run issues several execute batches (search, then hydrate/open/thread, then a
      // retry). They shared handle.toolStep, so executionId (`runId:step:index`) collided and the journal
      // refused the second batch as tool_intent_exists. Take a fresh step per batch.
      const step = handle.toolStep++;
      const calls = subs.map((sub, n) => ({ id: `r${step}~${n}~${sub.key}`, name: sub.name, args: sub.args }));
      const signalMap = new Map<string, AbortSignal>(calls.map(call => [call.id, signal]));
      const control = { signal, deadlineMs: handle.deadlineMs };
      const raw = await runToolCalls(this.#tools!.owner, calls, { registry: handle.registry, host, signals: signalMap, authority: gateAuthority, control, step, contentIndex: 0, seenIds: handle.seenIds, baseClasses: [handle.inputClass] });
      const authorized = (this.lookupAuthority(host.runId) || this.lookupJobAuthority(host.runId)) ? await authorizeToolBatch(this.#tools!.owner, raw, { host, control, baseClasses: [handle.inputClass] }) : raw;
      return calls.map(call => {
        const slot = authorized.bindings.findIndex(binding => binding.callId === call.id);
        const record = slot >= 0 ? authorized.tools[slot] : undefined;
        const accepted = authorized.accepted.find(result => result.binding.callId === call.id);
        const response = accepted?.response ?? {};
        const text = typeof response.text === 'string' ? response.text : '';
        const ok = record?.status === 'completed' && accepted !== undefined;
        // Q1-R3(d/e): a failed sub-call names its cause for the research_subcall log, never silently.
        // A sub-call that never dispatched reports its real reason (unknown_tool, grant_not_permitted,
        // invalid_arguments, round_deadline), never a bare refused.
        const code = ok ? undefined
          : typeof response.code === 'string' ? response.code
          : typeof response.reason === 'string' ? response.reason
          : record?.status === 'refused' ? refusalCode(record.reason)
          : record ? String(record.status) : 'refused';
        return { key: call.id, name: call.name, ok, text, originalCharacters: typeof response.originalCharacters === 'number' ? response.originalCharacters : text.length, omittedCharacters: typeof response.omittedCharacters === 'number' ? response.omittedCharacters : 0, ...(code ? { code } : {}) };
      });
    };
    const scheduler = handle.researchScheduler ??= new ResearchScheduler({
      now: () => this.#now(), configured, configuredNow: () => this.#researchSources(handle),
      // #351: a configured connector that is down settles `unavailable` at once instead of spending the
      // source deadline on reads that cannot reach it.
      unavailableNow: () => this.#unreachableSources(), selector: this.#research, execute,
      // K6: her own memory is local, so the routed `memory` layer reads it in process and never goes out.
      memory: query => this.#store.transaction(tx => memoryLookup(tx, query)),
      emit: progress => {
        hostLogEvent({ event: 'research_progress', ...progress });
        // U1: the voice lane sees the lookup as it runs, on the channel it already polls.
        if (!this.#settled(handle) && generation === handle.generation) {
          const view: ResearchProgressView = { researchId: progress.researchId, phase: progress.phase, sourcesDone: [...progress.sourcesDone], sourcesPending: [...progress.sourcesPending], elapsedMs: progress.elapsedMs };
          this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify(view) }, 'researchProgress');
        }
      },
      log: entry => hostLogEvent(entry), logJoined: researchId => hostLogEvent({ event: 'research_joined', researchId }), ledger: handle.researchLedger,
      // U-k3: each source's read opens and closes one line in the voice view while it runs.
      step: step => { if (this.#settled(handle) || generation !== handle.generation) return; this.#recordStep(handle, step); },
    });
    const responses: { id: string; name: string; response: JsonObject }[] = [];
    const projections: LiveToolProjection[] = [];
    // F6: every research call in one model message runs concurrently; the adapter bounds each source.
    const settled = await Promise.all(event.calls.map(async call => {
      let response: JsonObject;
      try {
        if (!validateResearch(call.args)) throw Error('invalid_research_arguments');
        response = await scheduler.call({ ...(call.args as object), callId: call.id } as ResearchCall, handle.abort.signal);
      } catch (error) { response = { error: error instanceof Error ? error.message : 'research_failed' }; }
      return { id: call.id, name: call.name, response };
    }));
    for (const entry of settled) {
      responses.push(entry);
      // F6-R1: the research reply carries no status field; a present `error` key is the failure shape.
      const completed = entry.response['error'] === undefined;
      const status: 'completed' | 'error' = completed ? 'completed' : 'error';
      projections.push({ name: entry.name, status, markdown: `research: ${status}`, sources: [] });
    }
    return { responses, projections };
  }

  /** S4a: one silent line per lookup turn, so "did you find it?" is answered truthfully without a backend round
   *  trip. It names only sources this turn is actually reading, and states the read-only fact at that moment. */
  #sendThinking(handle: ActiveSession, calls: readonly { name: string }[]): void {
    const typed = handle.session.sendThinking;
    if (typed === undefined) return;
    const sources = [...new Set(calls.filter(call => call.name !== RESEARCH_TOOL_NAME).map(call => stepSourceOf(call.name)))];
    if (!sources.length) return;
    const text = `Reading ${joinWords(sources)}. Nothing has been sent or booked while that runs.`;
    try { typed.call(handle.session, { text }); } catch { return; }
    hostLogEvent({ event: 'thinking_sent', chars: text.length });
  }

  /** A fresh turn of tool work: the step list restarts and every direct call opens its own line.
   *  A `research` call opens one line per source from inside the run instead. */
  #openSteps(handle: ActiveSession, calls: readonly { id: string; name: string; args: JsonObject }[]): void {
    handle.liveSteps = [];
    handle.liveStepItems = new Map();
    for (const call of calls) {
      if (call.name === RESEARCH_TOOL_NAME) continue;
      const subject = stepSubject(call.args);
      const step = { callId: call.id, stepId: `${call.id}:0`, source: stepSourceOf(call.name), action: stepActionOf(call.name), ...(subject !== undefined ? { subject } : {}), phase: 'start' as const };
      liveToolStep(step);
      this.#recordStep(handle, step);
    }
  }

  /** Keep one line per step: an end step replaces its own start line in place. */
  #recordStep(handle: ActiveSession, step: LiveToolStepBody): void {
    if (this.#settled(handle)) return;
    const index = handle.liveSteps.findIndex(entry => entry.stepId === step.stepId);
    if (index >= 0) { handle.liveSteps[index] = step; return; }
    handle.liveSteps.push(step);
    while (handle.liveSteps.length > LIVE_STEPS_MAX) handle.liveSteps.shift();
  }

  async #toolBatch(handle: ActiveSession, event: Extract<LiveVoiceEvent, { type: 'toolCall' }>, generation: number): Promise<void> {
    handle.thinking = true;
    const publish = (kind: 'toolCall' | 'toolResult', tool: LiveToolProjection) => {
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      const sequence = this.#persist(handle, { type: kind, sequence: event.sequence, tool }, kind);
      if (sequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind, sequence: event.sequence }); return; }
      this.#pushChunk(handle, { kind: 'marker', marker: { kind, sequence: event.sequence, journalSequence: sequence, text: null, finished: null, value: null, tool } });
    };
    for (const call of event.calls) publish('toolCall', { name: call.name, status: 'called', markdown: '', sources: [] });
    if ((this.#settled(handle) || generation !== handle.generation)) return;
    let responses = event.calls.map(call => ({ id: call.id, name: call.name, response: { error: 'Tool not granted' } as JsonObject }));
    let projections: LiveToolProjection[] = event.calls.map(call => ({ name: call.name, status: 'error', markdown: 'Tool not granted', sources: [] }));
    if (this.#tools && handle.host) {
      const authority = this.lookupAuthority(handle.host.runId);
      if (!authority) return;
      const dispatchGate = await this.#tools.owner.resultGate.authorize(handle.host, [], [handle.inputClass], handle.abort.signal);
      if (this.#settled(handle) || generation !== handle.generation) return;
      const host = structuredClone(handle.host), step = ++handle.toolStep;
      const jobAbort = new AbortController();
      const control = { signal: jobAbort.signal, deadlineMs: handle.deadlineMs };
      if (event.calls.some(call => call.name === 'remember_note')) await this.#waitForOwnerTranscript(handle, event.sequence);
      if (this.#settled(handle) || generation !== handle.generation) return;
      if (event.calls.every(call => call.name === RESEARCH_TOOL_NAME)) {
        const outcome = await this.#researchBatch(handle, event, generation, host, dispatchGate.state === 'allowed');
        if (this.#settled(handle) || generation !== handle.generation) return;
        responses = outcome.responses;
        projections = outcome.projections;
        const latency: { tool: string; ms: number }[] = [];
        for (const call of event.calls) { const started = handle.callStartedAt.get(call.id); if (started !== undefined) latency.push({ tool: call.name, ms: Math.max(0, this.#now() - started) }); handle.callStartedAt.delete(call.id); }
        hostLogEvent({ event: 'live_tool_turn', sequence: event.sequence, toolCallsThisTurn: event.calls.length, toolLatencyMs: latency, toolResponseWhileGenerating: handle.speaking });
      } else {
      // One model call fans out to one or more internal reads; a plain call maps to itself. An intent
      // is deliberately never cached: its sub-reads change per query or per minute.
      interface Unit { index: number; call: (typeof event.calls)[number]; intent: IntentToolName | undefined; subs: { key: string; name: string; args: JsonObject }[]; plan: ReturnType<typeof planIntent> | undefined }
      type Batch = Awaited<ReturnType<typeof runToolCalls>>;
      const units: Unit[] = event.calls.map((call, index) => {
        if (!isIntentTool(call.name)) return { index, call, intent: undefined, subs: [{ key: call.id, name: call.name, args: call.args as JsonObject }], plan: undefined };
        const plan = planIntent(call.name, call.args);
        return { index, call, intent: call.name, subs: plan.calls.map((sub, n) => ({ key: `${call.id}~${n}`, name: sub.name, args: sub.args })), plan };
      });
      const cache = handle.toolCache;
      const cached = new Map<number, { response: JsonObject; projection: LiveToolProjection }>();
      const pending: Unit[] = [];
      for (const unit of units) {
        const hit = unit.intent === undefined && cache.cacheable(unit.call.name) ? cache.get<{ response: JsonObject; projection: LiveToolProjection }>(unit.call.name, unit.call.args) : undefined;
        if (!hit) { pending.push(unit); continue; }
        hostLogEvent({ event: 'live_read_cache', tool: unit.call.name, cached: true });
        cached.set(unit.index, hit);
      }
      // One AbortController per model call; the batch stays a single dispatch so same-endpoint reads
      // keep their order, and a cancellation aborts exactly its own call. Each intent sub-read also
      // carries its own deadline, so one slow source never holds the whole turn.
      const signals = new Map<string, AbortSignal>();
      const registerSignals = (unit: Unit, subs: { key: string }[]): void => {
        const aborter = handle.callAborts.get(unit.call.id)!;
        const bounded = unit.intent === undefined ? aborter.signal : AbortSignal.any([aborter.signal, AbortSignal.timeout(INTENT_SUB_DEADLINE_MS)]);
        for (const sub of subs) signals.set(sub.key, bounded);
      };
      for (const unit of pending) {
        handle.callAborts.set(unit.call.id, new AbortController());
        handle.callStartedAt.set(unit.call.id, this.#now());
        registerSignals(unit, unit.subs);
      }
      const subCalls = pending.flatMap(unit => unit.subs.map(sub => ({ id: sub.key, name: sub.name, args: sub.args })));
      const offsets = new Map<number, number>();
      { let at = 0; for (const unit of pending) { offsets.set(unit.index, at); at += unit.subs.length; } }
      const runBatch = async (calls: { id: string; name: string; args: JsonObject }[], useStep: number): Promise<Batch | undefined> => {
        if (calls.length === 0) return undefined;
        if (this.#settled(handle) || generation !== handle.generation) throw new LiveError('invalidated');
        const raw = await runToolCalls(this.#tools!.owner, calls, { registry: handle.registry, host, signals,
          authority: { isCurrent: async (_host, _tool, signal) => dispatchGate.state === 'allowed' && !signal.aborted && generation === handle.generation && !this.#settled(handle) }, control,
          step: useStep, contentIndex: 0, seenIds: handle.seenIds, baseClasses: [handle.inputClass] });
        // Completion never sends to the old transport. With no active authority, retain references for pickup.
        if (!this.lookupAuthority(host.runId) && !this.lookupJobAuthority(host.runId)) return raw;
        return await authorizeToolBatch(this.#tools!.owner, raw, { host, control, baseClasses: [handle.inputClass] });
      };
      const readSub = (source: Batch | undefined, key: string, name: string): IntentSubResult => {
        const slot = source?.bindings.findIndex(binding => binding.callId === key) ?? -1;
        const record = slot >= 0 ? source!.tools[slot] : undefined;
        const accepted = source?.accepted.find(result => result.binding.callId === key);
        const response = accepted?.response ?? {};
        const text = typeof response.text === 'string' ? response.text : '';
        const ok = record?.status === 'completed' && accepted !== undefined;
        return { key, name, ok, text, originalCharacters: typeof response.originalCharacters === 'number' ? response.originalCharacters : text.length, omittedCharacters: typeof response.omittedCharacters === 'number' ? response.omittedCharacters : 0 };
      };
      const raced = await this.#withCeiling(runBatch(subCalls, step));
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      // S4a ceiling: a call still running at the host limit is answered as a timeout through the same
      // continuation owner, so the backend gets one output per call and one response.create for the batch.
      if (raced === 'timeout') {
        for (const unit of pending) {
          hostLogEvent({ event: 'tool_ceiling_hit', tool: unit.call.name, ms: TOOL_CEILING_MS });
          handle.callAborts.get(unit.call.id)?.abort();
        }
      }
      const batch: Batch | undefined = raced === 'timeout'
        ? { tools: [], bindings: [], responses: [], accepted: [], error: { status: 'deadline', reason: 'timeout' } }
        : raced;
      // Phase 2: calendar and brief enumerate their calendars first, then read a bounded event slice
      // per calendar id the shaped list carried, so the calendar intent covers every calendar.
      const followUps = new Map<number, IntentSubCall[]>();
      const phase2: { id: string; name: string; args: JsonObject }[] = [];
      for (const unit of pending) {
        if (unit.plan?.follow === undefined) continue;
        const phase1 = unit.subs.map(sub => readSub(batch, sub.key, sub.name));
        const extra = unit.plan.follow(phase1).map((call, n) => ({ key: `${unit.call.id}~f${n}`, name: call.name, args: call.args }));
        if (extra.length === 0) continue;
        followUps.set(unit.index, extra);
        registerSignals(unit, extra);
        phase2.push(...extra.map(sub => ({ id: sub.key, name: sub.name, args: sub.args })));
      }
      const followBatch = await runBatch(phase2, ++handle.toolStep);
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      for (const unit of pending) handle.callAborts.delete(unit.call.id);
      responses = event.calls.map((call, index) => {
        const hit = cached.get(index);
        if (hit) { projections[index] = hit.projection; return { id: call.id, name: call.name, response: hit.response }; }
        const unit = units[index]!;
        const base = offsets.get(index) ?? 0;
        const record = batch?.tools[base];
        const reason = batch?.error?.reason ?? record?.reason ?? 'tool_result_denied';
        if (unit.intent !== undefined && unit.plan !== undefined && batch) {
          const first = unit.subs.map(sub => readSub(batch, sub.key, sub.name));
          const second = (followUps.get(index) ?? []).map(sub => readSub(followBatch, sub.key, sub.name));
          const subResults = [...first, ...second];
          const digest = unit.plan.combine(subResults);
          const ok = subResults.some(result => result.ok);
          projections[index] = { name: call.name, status: ok ? 'completed' : 'error', markdown: noEmptyResult(digest.text), sources: [] };
          // The count the voice view shows is the items the source returned, never the citation count.
          if (ok && digest.itemCount !== undefined) handle.liveStepItems.set(call.id, digest.itemCount);
          return { id: call.id, name: call.name, response: ok ? intentResponse(digest, unit.intent) : { error: reason } };
        }
        const accepted = batch?.accepted.find(result => result.binding.callId === call.id && result.binding.name === call.name);
        const completed = accepted !== undefined && record?.status === 'completed';
        const markdown = completed ? noEmptyResult(typeof accepted.response.markdown === 'string' ? accepted.response.markdown : typeof accepted.response.text === 'string' ? accepted.response.text : reason) : reason;
        const sources = completed ? sourceCards({ text: accepted.response.text, markdown: accepted.response.markdown, sources: accepted.response.sources }, Infinity) : [];
        const projection: LiveToolProjection = { name: call.name, status: completed ? 'completed' : 'error', markdown, sources };
        projections[index] = projection;
        if (completed && cache.cacheable(call.name)) cache.set(call.name, call.args, { response: accepted.response, projection });
        return { id: call.id, name: call.name, response: completed ? accepted.response : { error: reason } };
      });
      // Per-turn metadata only: the traces the council requires before any playback fence.
      const latency: { tool: string; ms: number }[] = [];
      for (const unit of pending) {
        const started = handle.callStartedAt.get(unit.call.id);
        if (started !== undefined) latency.push({ tool: unit.call.name, ms: Math.max(0, this.#now() - started) });
        handle.callStartedAt.delete(unit.call.id);
      }
      // F6 diagnostics: the peak in-flight count per endpoint for this batch, endpoints and counts only.
      const peaks = new Map<string, number>();
      for (const sub of subCalls) {
        const endpoint = handle.registry.find(tool => tool.name === sub.name)?.endpointId;
        if (endpoint !== undefined) peaks.set(endpoint, (peaks.get(endpoint) ?? 0) + 1);
      }
      const peakInFlight = [...peaks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([endpoint, count]) => ({ endpoint, peak: count }));
      hostLogEvent({ event: 'live_tool_turn', sequence: event.sequence, toolCallsThisTurn: units.reduce((sum, unit) => sum + unit.subs.length + (followUps.get(unit.index)?.length ?? 0), 0), toolLatencyMs: latency, toolResponseWhileGenerating: handle.speaking, peakInFlight });
      }
    }
    if ((this.#settled(handle) || generation !== handle.generation)) return;
    for (const [index, projection] of projections.entries()) {
      const id = event.calls[index]!.id;
      if (handle.pendingCallIds.has(id)) publish('toolResult', handle.bargeInCallIds.has(id) ? { ...projection, code: 'after_barge_in' } : projection);
      const call = event.calls[index]!;
      if (call.name === RESEARCH_TOOL_NAME) continue;
      const started = handle.callStartedAt.get(call.id);
      // The count the source's own shape carried, never `sources.length`: those are citations, and a
      // capped source undercounted against them (review finding F5). A shape with no item count stays
      // uncounted rather than guessed, and the line reads "<source> answered".
      const items = handle.liveStepItems.get(call.id);
      this.#recordStep(handle, {
        callId: call.id, stepId: `${call.id}:0`, source: stepSourceOf(call.name), action: stepActionOf(call.name),
        phase: 'end', ok: projection.status === 'completed',
        ...(items !== undefined ? { resultCount: items } : {}),
        ...(started !== undefined ? { ms: Math.max(0, this.#now() - started) } : {}),
      });
    }
    responses = responses.filter(response => handle.pendingCallIds.has(response.id));
    // The call stops being pending the moment its output is sent (amendment C); from here the owed answer
    // carries THINKING, so the orb never flashes LISTENING between the tool and her speech (F1, D5).
    for (const call of event.calls) { handle.pendingCallIds.delete(call.id); handle.bargeInCallIds.delete(call.id); }
    if (!(this.#settled(handle) || generation !== handle.generation)) {
      try {
        if (responses.length) {
          handle.session.sendToolResponse({ responses });
          this.#armDeadAir(handle);
        }
      } catch { /* A cancelled provider batch or terminal transport cannot receive late answers. */ }
    }
    handle.thinking = responses.length > 0 || handle.pendingCallIds.size > 0;
    this.#noteState(handle, 'tool');
  }
  #persist(handle: ActiveSession, event: { type: 'continuity' | 'remember_deferred'; sequence: number; text: string } | LiveVoiceEvent | { type: 'toolCall' | 'toolResult'; sequence: number; tool: LiveToolProjection }, kind: JournalKind, transaction?: Transaction): number | 'overflow' {
    const text = 'text' in event ? event.text : null;
    const finished = 'finished' in event && event.finished !== undefined ? (event.finished ? 1 : 0) : null;
    const value = event.type === 'waitingForInput' ? (event.value ? 1 : 0) : null;
    const toolJSON = 'tool' in event ? JSON.stringify(event.tool) : null;
    const bytes = toolJSON ? Buffer.byteLength(toolJSON) : kind === 'continuity' ? Buffer.byteLength(text ?? '') : retainedBytes(kind, text);
    const limits = this.#profile.limits;
    if (handle.journalEvents + 1 > limits.journalMaxEvents || handle.journalBytes + bytes > limits.journalMaxBytes) return 'overflow';
    const now = this.#now();
    const events = handle.journalEvents + 1;
    const total = handle.journalBytes + bytes;
    const persist = (tx: Transaction) => {
      tx.run('INSERT INTO live_journal(live_session_id, provider_sequence, kind, text, finished, value, tool_json, terminal_outcome, rejected_kind, rejected_sequence, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)',
        [handle.liveSessionId, event.sequence, kind, text, finished, value, toolJSON, bytes, now]);
      tx.run('UPDATE live_sessions SET journal_events=?, journal_bytes=?, ready=CASE WHEN ?=1 THEN 1 ELSE ready END, updated_at=? WHERE live_session_id=?',
        [events, total, kind === 'ready' ? 1 : 0, now, handle.liveSessionId]);
      return Number(tx.get('SELECT journal_id FROM live_journal WHERE live_session_id=? ORDER BY journal_id DESC LIMIT 1', [handle.liveSessionId])!['journal_id']);
    };
    const journalSequence = transaction ? persist(transaction) : this.#store.transaction(persist);
    handle.journalEvents = events;
    handle.journalBytes = total;
    return journalSequence;
  }

  #settled(handle: ActiveSession): boolean { return handle.terminal || handle.invalidated; }

  #settle(handle: ActiveSession, outcome: LiveTerminalOutcome, complete: boolean, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): void {
    if (handle.terminal) return;
    // The journal's session end: the terminal code and who ended it, written before the row closes.
    journalRecord({ kind: 'live', sessionId: handle.liveSessionId, generation: handle.generation, event: 'session_end',
      code: 'code' in outcome ? outcome.code : outcome.state, by: consumerState, complete });
    handle.terminal = true;
    handle.terminalOutcome = outcome;
    handle.diagnosticTerminalCode = 'code' in outcome ? outcome.code : outcome.state;
    handle.sessionTimer?.cancel(); handle.callTimer?.cancel(); handle.idleTimer?.cancel();
    handle.session.close();
    let journalSequence: number;
    try {
      journalSequence = this.#store.transaction(tx => this.#terminalInTx(tx, handle.liveSessionId, outcome, complete, this.#now(), consumerState, rejected));
    } catch (error) {
      // The durable write failed, but the typed terminal fact must still reach the app. Log the failure
      // (bounded fields only) and resolve done with the in-memory outcome so the socket sends the real code.
      handle.persistFailure = error;
      console.error(JSON.stringify({ event: 'live_terminal_write_failed', liveSessionId: handle.liveSessionId,
        code: handle.diagnosticTerminalCode,
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown' }));
      handle.consumer?.close();
      handle.abort.abort();
      handle.resolveDone();
      return;
    }
    // The terminal projection is written as it happens: a session that ends with no web poll open still leaves
    // its last transition in host.log (GL2-R1).
    this.#observeState(handle, 'ended', 'settle');
    // The terminal fact is durable before it is emitted; committed markers stay queued on overflow.
    // Distillation is scheduled here, never awaited: close returns immediately.
    this.#onSessionTerminal?.(handle.liveSessionId);
    this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'terminal', sequence: null, journalSequence, text: null, finished: null, value: null } });
    handle.consumer?.close();
    handle.abort.abort();
    handle.resolveDone();
  }

  /** The transaction/lifecycle guard makes attach and every expiry observation share one winner. */
  #expireInTx(tx: Transaction, row: SQLRow, now: number): SQLRow {
    if (row['owner_assistant_id'] !== this.#store.assistantId || row['lifecycle'] !== 'accepted'
      || Number(row['dispatch_intent']) !== 0 || now - Number(row['created_at']) <= this.#profile.limits.unusedMs) return row;
    const id = String(row['live_session_id']);
    this.#terminalInTx(tx, id, { state: 'expired' }, false, now, 'detached', null);
    return tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [id])!;
  }

  #armExpiry(): void {
    if (this.#closed) return;
    const next = this.#store.transaction(tx => tx.get(
      "SELECT MIN(created_at) AS created_at FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0",
      [this.#store.assistantId])!['created_at']);
    this.#expiryTimer?.cancel();
    this.#expiryTimer = undefined;
    if (next === null) return;
    // Integer milliseconds preserve age > unusedMs, even at equality or after a trusted clock jump.
    // Node's maximum delay is capped to avoid its overflow-to-1ms behavior.
    const delay = Math.min(2_147_483_647, Math.max(1, Number(next) + this.#profile.limits.unusedMs + 1 - this.#now()));
    this.#expiryTimer = this.#schedule(() => {
      if (this.#closed) return;
      this.#expiryTimer = undefined;
      const now = this.#now();
      // Deliberately uncaught: Store rollback plus Node's fatal error seam, never silent retry/success.
      this.#store.transaction(tx => {
        const rows = tx.all("SELECT * FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0 AND created_at < ?",
          [this.#store.assistantId, now - this.#profile.limits.unusedMs]);
        for (const row of rows) this.#expireInTx(tx, row, now);
      });
      this.#armExpiry();
    }, delay);
    this.#expiryTimer.unref();
  }

  #terminalInTx(tx: Transaction, liveSessionId: string, outcome: LiveTerminalOutcome, complete: boolean, now: number, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): number {
    tx.run('INSERT INTO live_journal(live_session_id, provider_sequence, kind, text, finished, value, tool_json, terminal_outcome, rejected_kind, rejected_sequence, payload_bytes, arrived_at) VALUES (?,NULL,?,NULL,NULL,NULL,NULL,?,?,?,0,?)',
      [liveSessionId, 'terminal', JSON.stringify(outcome), rejected?.kind ?? null, rejected?.sequence ?? null, now]);
    tx.run("UPDATE live_sessions SET lifecycle='terminal', journal_complete=?, terminal_outcome=?, terminal_at=?, consumer_state=?, updated_at=? WHERE live_session_id=?",
      [complete ? 1 : 0, JSON.stringify(outcome), now, consumerState, now, liveSessionId]);
    return Number(tx.get('SELECT journal_id FROM live_journal WHERE live_session_id=? ORDER BY journal_id DESC LIMIT 1', [liveSessionId])!['journal_id']);
  }

  #contextShape(context: LiveContext): void {
    if (!context || typeof context !== 'object' || typeof context.clientId !== 'string' || !context.clientId.trim()
      || typeof context.auditId !== 'string' || !context.auditId.trim()
      || typeof context.authorityEpoch !== 'string' || !context.authorityEpoch.length) throw new LiveError('invalid_context');
  }

  #authorize(context: LiveContext): void {
    this.#contextShape(context);
    if (context.authorityEpoch !== this.#store.authorityEpoch) throw new LiveError('stale_authority');
  }

  #snapshot(tx: Transaction, row: SQLRow): LiveSessionSnapshot {
    const grant = tx.get('SELECT * FROM live_grants WHERE live_session_id=?', [String(row['live_session_id'])]);
    if (!grant) throw new LiveError('not_found');
    const limits = this.#profile.limits;
    return {
      memory: memoryProjection(row['memory_provenance']),
      liveSessionId: String(row['live_session_id']), assistantId: String(row['owner_assistant_id']),
      authorityEpoch: String(row['authority_epoch']), idempotencyKey: String(row['idempotency_key']),
      clientId: String(row['client_id']), auditId: String(row['audit_id']),
      lifecycle: String(row['lifecycle']) as LiveSessionSnapshot['lifecycle'],
      dispatchIntent: Number(row['dispatch_intent']) === 1, ready: Number(row['ready']) === 1,
      profileIdentity: String(row['profile_identity']), promptIdentity: String(row['prompt_identity']),
      grant: {
        grantId: String(grant['grant_id']), provider: this.#profile.provider, model: String(grant['model']), voice: String(grant['voice']),
        keyReference: String(grant['key_reference']), permittedClasses: JSON.parse(String(grant['permitted_classes'])) as DataClass[],
        chosenInputClass: String(grant['chosen_input_class']) as DataClass, revision: Number(grant['revision']), grantedAt: Number(grant['granted_at']),
      },
      consumerState: this.#consumerStateOf(row),
      journal: { events: Number(row['journal_events']), bytes: Number(row['journal_bytes']), maxEvents: limits.journalMaxEvents, maxBytes: limits.journalMaxBytes, complete: Number(row['journal_complete']) === 1 },
      terminal: parseTerminal(row['terminal_outcome']),
      createdAt: Number(row['created_at']), updatedAt: Number(row['updated_at']),
    };
  }

  #readSnapshot(liveSessionId: string): LiveSessionSnapshot {
    const snapshot = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [liveSessionId]);
      if (!row) throw new LiveError('not_found');
      return this.#snapshot(tx, row);
    });
    // A settle whose durable write failed still reports the real typed outcome to the caller.
    const override = this.#active.get(liveSessionId)?.terminalOutcome;
    return override && snapshot.terminal === null ? { ...snapshot, terminal: override } : snapshot;
  }

  /** A failed detach write leaves the row 'attached'; the in-memory handle is the truth on read. */
  #consumerStateOf(row: SQLRow): LiveSessionSnapshot['consumerState'] {
    const stored = String(row['consumer_state']) as LiveSessionSnapshot['consumerState'];
    if (stored !== 'attached') return stored;
    const handle = this.#active.get(String(row['live_session_id']));
    return handle && !this.#settled(handle) && handle.consumerState === 'attached' ? 'attached' : 'ended';
  }

  #guardOpen(): void { if (this.#closed) throw new LiveError('terminal', 'owner is shut down'); }
}

/** Factory composition: the host supplies the validated profile, the real LiveVoicePort and its credentials. */
export function createLiveSessionOwner(config: LiveOwnerConfig): LiveSessionOwner {
  return new LiveSessionOwner(config);
}

function memoryProjection(value: unknown): import('./types.js').LiveMemoryProjection {
  if (typeof value !== 'string') return { status: 'empty', selected: 0, omitted: 0 };
  const provenance = JSON.parse(value) as import('./types.js').LiveMemoryProvenance;
  return { status: provenance.status, selected: provenance.selectedIds.length, omitted: provenance.omitted.length };
}
