import { sourceCards } from '../tools/source-cards.js';
import { noEmptyResult, type CalendarPage, type CalendarScope, type MailPage } from '../tools/live-shape.js';
import * as memory from '../domain/memory.js';
import { recordHistorySession, historySessionEvidence, recordHistoryDependency } from '../domain/history-lifecycle.js';
import * as summaries from '../domain/summaries.js';
import * as labels from '../domain/labels.js';
import { definitionsInTransaction } from '../tools/index.js';
import { OPEN_TOOL_NAMES, clearOpenLedger, exposeToolResults, noteModelOutput, noteOwnerWords, noteOwnerPartial, noteSpoken, openClaimCorrection, useWebSearchPort } from '../tools/open.js';
import { LiveToolJobs, type JobTimer, type ToolJob } from '../tools/jobs.js';
import { type VaultReceipt, VaultWriter, authorizeComposedWrite } from '../tools/vault-write.js';
import { TRELLO_TOOL_NAMES } from '../tools/trello.js';
import { NoteRequestGate, noteKey, noteReadbackText, readbackMatches, freezeNote, markCommitted, noteOwnerFragment, noteOwnerUtterance, noteSegmentSignal, noteSettle, openNote, saveNoteState, stageComposedNote, type PlaybackSignalKind } from '../tools/lux-note.js';
import { createLuxWriteTransport, luxWriteEndpoint } from '../adapters/lux-write/client.js';
import { runToolCalls, authorizeToolBatch, invalidArgumentsResponse } from '../tools/declarations.js';
import { INTENT_TOOL_NAMES, isIntentTool, planIntent, intentResponse, type IntentToolName, type IntentSubCall, type IntentSubResult } from '../tools/intent.js';
import { WEB_SEARCH_ACTION, type WebSearchPort } from '../tools/web-search.js';
import { findingCount, admissionBlocked, pagesCurrentRun, RESEARCH, RESEARCH_OPERATION, RESEARCH_TOOL_NAME, ResearchAdmission, ResearchLedger, ResearchScheduler, knownReply, configuredSourcesForEndpoints, markCalendarReply, refusedResearchRunLog, researchArgumentShape, refusalCode, parseResearch, researchRepair, type ResearchLateFindings, type SourceKind as ResearchSourceKind, type ConfiguredEndpointStatus, type UnavailableSource, researchSourcesFromToolNames, researchLedgerOf, researchRebuildDue, researchRebuildStep, retainedAfterSend, type ResearchBoundary, type ResearchRetention, capVoiceReply, ResearchLedgerLog, VoiceReplyBook } from '../tools/research.js';
import { HISTORY_IDENTITY } from '../tools/history.js';
import { LiveToolCache, LIVE_CACHE_TTL_MS } from './tool-cache.js';
import { ConnectorNotes, WarmContextCache, signInNote, type CalendarDigestSnapshot, type CalendarDigestState, type WarmContextSections } from './warm-context.js';
import type { RunAcceptance, LiveAuthority } from '../tools/types.js';
import { isToolFailureCode } from '../adapters/model/types.js';
import type { ToolDefinition, HostContext, JsonObject, ToolResultBinding } from '../adapters/model/types.js';
import type { LiveToolsComposition, LivePageProjection, LiveToolProjection, ResearchProgressView } from './types.js';

import { CONVERSATION_RECALL_COVERAGE_NOTE, publicOwnerProfile, PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, buildRuntimeContext, buildEarlierConversationsSection, earlierConversationsBudget, buildOpeningOptions, EARLIER_CONVERSATIONS_WINDOW_MS, openingOptionsTopics, LIVE_INSTRUCTION_TARGET_CHARS, composeLiveSessionInstruction, toolGroupNames, type OpeningOption, type OpeningOptionKind, CLAIM_WITHOUT_CALL_LINE } from '../prompt/index.js';
import { IngestReject, parsePlaybackReceipt, playbackKeyOf, recordPlaybackReceipt, type NativePlaybackReceipt } from '../trace/ingest.js';
import { liveTracePort, record, recordCallLink, recordCallResult, recordQueryShape, recordResearchText, recordSourceRead, scopedTraceKey, TraceRecordError, type LiveTracePort, type TraceDetailMap, type TraceEventIds } from '../trace/record.js';
import { markDiagnosticLoss, type DiagnosticLoss } from '../trace/coverage.js';
import { hostClockDomain, hostMonotonicMs } from '../trace/clock.js';
import type { TraceEventKind, TurnCloseReason, TurnOutcome } from '../trace/kinds.js';

import { clockSync, hostLogEvent, LIVE_REBUILD_TRIGGERS, LIVE_STATE_CAUSES, NATIVE_END_REASONS, setLogContext } from '../host/log.js';
import { liveToolStep, stepSubject, type LiveToolStepBody } from '../tools/host-events.js';
import { validateAcceptedPrompt } from './config.js';
import { VoiceProfileMeter } from './voice-profile.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DataClass, LiveVoiceDiagnostics, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceSession, LiveVoiceRequest, LiveToolResponse, LiveToolSendOutcome, TurnFailedReason } from '../adapters/live-voice/index.js';
import type { DebtPhase, DebtReason } from '../trace/kinds.js';
import { headAnchor, terminalAnchor, canonicalSpeechLanguage, effectiveLanguageCode, LIVE_RECOVERY_PICKUP, LIVE_MUTE_PICKUP } from '../prompt/live-persona.js';
import { currentLiveAccent } from '../config/live.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import { liveProfileIdentity, validateLiveProfile } from './config.js';
import { parseTerminal, persistedKinds, readFragmentPage, retainedBytes } from './journal.js';
import { normalizeStopSpeech, stopNameId, stopPhrase, STOP_WORD_LIMIT } from './stop-phrase.js';
import {
  LiveError,
  type CreateLiveSession, type JournalKind, type LiveAttachment, type LiveConsumerState, type LiveContext,
  type LiveFragmentPage, type LiveInvalidationReason, type LiveOutputChunk, type LiveOwnerConfig,
  type AcceptedPromptSnapshot, type LiveProfile, type LiveProfileProjection, type LivePublicMarker, type LiveSessionSnapshot, type LiveStorePort,
  type LiveTerminalOutcome,
} from './types.js';

const pickupInstruction = 'The user has just picked up. Deliver the pending job result first, in your own words, then resume the conversation. If the outcome failed or is unknown, state that truthfully.';
/** Q5-R4: the most the earlier calls' opening lines may add to a start instruction. */
export const OPENER_CONTEXT_CHARS = 450;

/**
 * Q5-R4: the previous calls' openers as "do not repeat" context, under 450 chars and absent when no
 * earlier call exists. Three calls are named so the note carries a subject as well as words. The journal
 * text stays owner-local: this string is composed into the start instruction and is never written to
 * host.log.
 */
export function openersNote(openers: readonly string[], topics: readonly (string | undefined)[] = []): string | undefined {
  if (!openers.length) return undefined;
  const classes = openers.slice(0, 3).map((opener, index) => {
    const topic = topics[index] ?? opener;
    if (/tool[_ -]failure|(?:tool|mail|calendar|web|search|chat|knowledge|connector).*(?:fail|broken|unavailable|offline|timeout|approval)|(?:fail|broken).*tool/i.test(topic ?? '')) return 'tool_failure';
    if (/calendar|meeting|schedule/i.test(topic ?? '')) return 'calendar';
    if (/open.loop|commitment|unfinished/i.test(topic ?? '')) return 'open_loop';
    return 'recent_thread';
  });
  if (!classes.length) classes.push('recent_thread');
  return `Earlier opener topic classes, closed for this call: ${[...new Set(classes)].join(', ')}. Never open on tool_failure.`;
}

/** Host instructions are never owner words, including on adapters with only a user text channel. */
export const hostNote = (text: string): string => `[host note, not the owner] ${text}`;

/** The most of a recorded option's topic the note names, so a long fragment stays one clause. */


/**
 * Q5-R4: one earlier call's opening utterance: its ordered transcription fragments up to the first
 * finished fragment or turn boundary. A streamed fragment of a few characters carries no subject,
 * which is why the first row alone was almost nothing to avoid.
 */
export function openerFromJournal(rows: readonly { readonly kind: string; readonly text: string | null; readonly finished: number | null }[]): string {
  let utterance = '';
  for (const row of rows) {
    if (row.kind !== 'outputTranscription') {
      if (utterance !== '') break;
      continue;
    }
    utterance += row.text ?? '';
    if (row.finished === 1) break;
  }
  return utterance.trim();
}

/**
 * Release 3u: the topic an earlier call's opener came from, read off the plan that call's own start
 * recorded. The words the opener shares with an option decide it, so a topic is never guessed: an
 * opener whose subject the plan does not name is reported without one.
 */
function openerTopicOf(opener: string, recorded: readonly OpeningOption[]): string | undefined {
  const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter(word => word.length >= 4));
  const spoken = words(opener);
  let best: { topic: string; shared: number } | undefined;
  for (const option of recorded) {
    const shared = [...words(option.topic)].filter(word => spoken.has(word)).length;
    if (shared > 0 && (best === undefined || shared > best.shared)) best = { topic: option.topic, shared };
  }
  return best?.topic;
}

/** The options an earlier call's start instruction recorded, from its own accepted-prompt snapshot. */
function recordedOptions(snapshot: unknown): readonly OpeningOption[] {
  if (typeof snapshot !== 'string') return [];
  try {
    const parsed = JSON.parse(snapshot) as { system?: unknown };
    return typeof parsed.system === 'string' ? openingOptionsTopics(parsed.system) : [];
  } catch {
    return [];
  }
}

/**
 * Release 7 W5: the open-loop topics a past call's own start plan offered, read off the plan that start
 * recorded in its accepted prompt snapshot. An open loop offered as one call's opener stays in the earlier
 * conversations as context and never opens another call; only the owner can raise it again. The record is the
 * plan, so the comparison is the option's own topic, never a match on words the model chose later.
 * W5-R2: `openedAt` is the latest start that offered any open-loop option, because the distillation re-words a
 * loop between calls and the topic rule cannot see through that.
 */
function offeredOpenLoops(tx: Transaction, assistantId: string, allowedClasses: readonly DataClass[], now: number): { topics: readonly string[]; openedAt: number | undefined } {
  const topics: string[] = [];
  let openedAt: number | undefined;
  const eligibility = new Map<string, ReturnType<typeof historySessionEvidence>>();
  for (const row of tx.all("SELECT live_session_id, created_at, accepted_prompt_snapshot FROM live_sessions WHERE owner_assistant_id=? AND created_at>=? ORDER BY created_at DESC, rowid DESC", [assistantId, now - EARLIER_CONVERSATIONS_WINDOW_MS])) {
    const source = historySessionEvidence(tx, String(row['live_session_id']), eligibility);
    if (!source || !allowedClasses.includes(source.dataClass)) continue;
    const loops = recordedOptions(row['accepted_prompt_snapshot']).filter(option => option.kind === 'open-loop');
    if (loops.length === 0) continue;
    for (const option of loops) topics.push(option.topic);
    const startedAt = Number(row['created_at']);
    if (openedAt === undefined || startedAt > openedAt) openedAt = startedAt;
  }
  return { topics, openedAt };
}

/** W5-R2: after a call offered an open loop, no start inside this window offers the kind at all, because the
 *  re-worded loop a call's summary stores would otherwise walk straight past the exact-topic rule. */
const OPEN_LOOP_OPENER_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Q5-R4: the three most recent earlier calls' opening utterances, read from the owner-local journal.
 * Release 3u: each one carries the topic its own start plan offered, so the anti-repeat note names a
 * subject as well as words. Nothing here reaches host.log.
 */
function previousOpeners(tx: Transaction, assistantId: string, allowedClasses: readonly DataClass[]): { readonly text: string; readonly topic?: string; readonly sessionId: string; readonly dataClass: DataClass; readonly kinds: readonly OpeningOptionKind[] }[] {
  const sessions = tx.all("SELECT live_session_id, accepted_prompt_snapshot FROM live_sessions WHERE owner_assistant_id=? ORDER BY created_at DESC, rowid DESC", [assistantId]);
  const previous: ReturnType<typeof previousOpeners> = [];
  const eligibility = new Map<string, ReturnType<typeof historySessionEvidence>>();
  for (const row of sessions) {
    const source = historySessionEvidence(tx, String(row.live_session_id), eligibility);
    if (!source || !allowedClasses.includes(source.dataClass)) continue;
    const text = openerFromJournal(tx.all("SELECT kind, text, finished FROM live_journal WHERE live_session_id=? AND (kind='outputTranscription' OR kind IN ('generationComplete','turnComplete','interrupted')) ORDER BY journal_id", [String(row['live_session_id'])]).map(entry => ({
      kind: String(entry['kind']),
      text: entry['text'] === null || entry['text'] === undefined ? null : String(entry['text']),
      finished: entry['finished'] === null || entry['finished'] === undefined ? null : Number(entry['finished']),
    })));
    if (text === '') continue;
    const recorded = recordedOptions(row['accepted_prompt_snapshot']);
    const topic = openerTopicOf(text, recorded);
    // Contract 1023 N8: the plan this call offered, so the next start never leads with the same subject twice.
    previous.push({ text, sessionId: String(row.live_session_id), dataClass: source.dataClass, kinds: recorded.map(option => option.kind),
      ...(topic === undefined ? {} : { topic }) });
    if (previous.length === 3) break;
  }
  return previous;
}
/** Contract 1023 N8: how recent the call that just ended must be for its own words to seed the opener. */
const FRESH_THREAD_WINDOW_MS = 2 * 60 * 1000;
/** The closed set of past calls the open-loop option may draw on, newest first. */
const OPEN_LOOP_SOURCES = 3;

/** W5 (Q-06): the calls whose model note was refused for not matching the owner's words. A refusal
 *  closed that loop, so the call start must not offer it again: only the owner can raise it. */
export function staleRefusedNoteSessions(tx: Transaction, ownerId: string): ReadonlySet<string> {
  if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'", [])) return new Set();
  return new Set(tx.all(`SELECT DISTINCT run_id FROM tool_calls WHERE owner_id=?
    AND json_extract(intent_json,'$.toolName')='remember_note'
    AND json_extract(result_json,'$.response.code')='owner_text_mismatch'`, [ownerId]).map(row => String(row['run_id'])));
}

/** Contract 1023 N8: the stored open_loop column of the eligible past calls, newest first. The summary text is
 *  never mined for a cue word, so a call whose distillation stored no loop offers none. */
export function storedOpenLoops(tx: Transaction, allowedClasses: readonly DataClass[], now: number, refused: ReadonlySet<string> = new Set()): { text: string; lastSeenAt: number }[] {
  const rows = tx.all(`SELECT s.live_session_id AS id, s.open_loop AS loop, s.ended_at AS seen_at FROM conversation_summaries s
    WHERE s.status='complete' AND s.open_loop IS NOT NULL AND s.ended_at IS NOT NULL AND s.ended_at<=? AND s.ended_at>=?
    ORDER BY s.ended_at DESC,s.rowid DESC LIMIT 12`, [now, now - EARLIER_CONVERSATIONS_WINDOW_MS]);
  const eligibility = new Map<string, ReturnType<typeof historySessionEvidence>>();
  const loops: { text: string; lastSeenAt: number }[] = [];
  for (const row of rows) {
    // W5 (Q-06): a call whose note was refused is never offered as an open loop again.
    if (refused.has(String(row['id']))) continue;
    const source = historySessionEvidence(tx, String(row['id']), eligibility);
    if (!source || !allowedClasses.includes(source.dataClass)) continue;
    loops.push({ text: String(row['loop']), lastSeenAt: Number(row['seen_at']) });
    if (loops.length === OPEN_LOOP_SOURCES) break;
  }
  return loops;
}

/** Contract 1023 N8: the call that ended under two minutes ago has no summary yet, so its last owner words carry
 *  the newest thread instead of the start waiting for the distillation. */
function freshOwnerThread(tx: Transaction, assistantId: string, allowedClasses: readonly DataClass[], now: number): string | undefined {
  const prior = tx.get(`SELECT live_session_id AS id, terminal_at AS endedAt FROM live_sessions
    WHERE owner_assistant_id=? AND terminal_at IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1`, [assistantId]);
  if (prior === undefined) return undefined;
  const endedAt = Number(prior['endedAt']);
  if (!Number.isSafeInteger(endedAt) || now < endedAt || now - endedAt >= FRESH_THREAD_WINDOW_MS) return undefined;
  const sessionId = String(prior['id']);
  const summary = tx.get('SELECT status FROM conversation_summaries WHERE live_session_id=?', [sessionId]);
  if (summary !== undefined && String(summary['status']) === 'complete') return undefined;
  const source = historySessionEvidence(tx, sessionId, new Map<string, ReturnType<typeof historySessionEvidence>>());
  if (!source || !allowedClasses.includes(source.dataClass)) return undefined;
  const text = tx.all("SELECT text FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND text IS NOT NULL ORDER BY journal_id", [sessionId])
    .map(row => String(row['text'])).join('').trim();
  return text === '' ? undefined : text;
}

// Issue 1014: a session past this many tool calls starts a fresh setup instead of resuming into
// drifted audio; a session under it still reuses the saved resumption handle.
const RESUMPTION_TOOL_CALL_LIMIT = 5;
/** L19: how long after a dead call the next one still opens by naming the drop. */
const DEAD_LINE_WINDOW_MS = 10 * 60 * 1000;
/** L19: the codes that mean the previous call was lost, not ended by the owner. */
const DEAD_LINE_CODES: ReadonlySet<string> = new Set(['resume_failed', 'transport_error', 'provider_closed', 'network']);
/** L19: what the seed hears after a dead call's last answer, so the new call never repeats it. */
export const LIVE_DROPPED_LINE_MARK = 'The line dropped before that answer reached me, and I am back. Do not repeat that answer: say in one short sentence that the line dropped, then offer to continue.';
// Release 3g-c recovery policy (R1-R1), time-budgeted (L18): stalls come in episodes, so the bound is the
// episode's age, not a count: the call keeps reopening until RECOVERY_BUDGET_MS has passed since the
// episode's first drop, and a session that stayed healthy for RECOVERY_HEALTHY_MS starts a fresh episode.
// Backoff between attempts is 0, 2, 4, 8, then 8 s, and the call's own deadline and idle limits still bound it.
const RECOVERY_BUDGET_MS = 60_000;
const RECOVERY_HEALTHY_MS = 60_000;
const RECOVERY_BACKOFF_MS = [0, 2_000, 4_000, 8_000] as const;
/** C-LIVE R2: the short wait before the one fresh open that follows a refused recovery open. */
const RECOVERY_REFUSED_BACKOFF_MS = 1_000;
/** C-LIVE R2: an exception's class when it is a bare identifier, never its text. */
function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Unknown';
}
/** C-LIVE R2: a message that is itself a closed key (snake case) is kept; any other text is `unrecognized`. */
function messageKeyOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'unrecognized';
}
/** The wait before attempt `index` (0-based): 0, 2, 4, 8, then 8 s. */
function recoveryBackoffMs(index: number): number { return RECOVERY_BACKOFF_MS[Math.min(index, RECOVERY_BACKOFF_MS.length - 1)]!; }
/** C-RECOVERY (d): the closed words that acknowledge a turn instead of asking one. A bare acknowledgement owes the
 *  model no reply, so the watchdog must never rebuild a call because the owner said one. */
const ACKNOWLEDGEMENT_WORDS = new Set([
  'okay', 'ok', 'okey', 'mhm', 'mm', 'hmm', 'right', 'yeah', 'yep', 'yup', 'sure', 'all', 'alright', 'cool', 'thanks',
  'thank', 'you', 'got', 'it', 'then', 'bye', 'great', 'nice', 'perfect',
]);
/** C-RECOVERY (d): up to three words, every one of them an acknowledgement, and never a question. */
export function isBareAcknowledgement(text: string): boolean {
  if (text.includes('?')) return false;
  const words = text.toLowerCase().replace(/[.,!\u2026\u2019']/g, ' ').split(/\s+/).filter(word => word.length > 0);
  if (words.length === 0 || words.length > 3) return false;
  return words.every(word => ACKNOWLEDGEMENT_WORDS.has(word));
}
/** C-REBUILD8: the fillers a model says while it is stalling instead of answering. A response made only of these
 *  answers nothing, so the silence after it is a model mute and not a turn that was served. */
const ACK_RESPONSE_PHRASES = new Set([
  'one second', 'one sec', 'one moment', 'one minute', 'a second', 'a sec', 'a moment', 'just a second',
  'just a moment', 'just one second', 'hold on', 'hold', 'let me check', 'let me see', 'let me look',
  'let me check that', 'let me look that up', 'checking', 'checking now', 'looking', 'looking now', 'searching',
]);
/** C-REBUILD8: the single words a stalling response may be built from, all already acknowledgements. */
const ACK_RESPONSE_WORDS = new Set([...ACKNOWLEDGEMENT_WORDS, 'second', 'sec', 'moment', 'minute', 'hold', 'on', 'just',
  'a', 'let', 'me', 'check', 'checking', 'see', 'look', 'looking', 'now', 'searching', 'so']);
/** C-REBUILD8: the bound a whole filler response fits in; a real answer is longer than this. */
export const ACK_RESPONSE_CHAR_LIMIT = 40;
/** C-REBUILD8: whether a whole model response filed a filler and nothing else ("One second."). It takes no
 *  question mark and never a full sentence with content, so a real answer can never be read as a filler. */
export function isAckOnlyResponse(text: string): boolean {
  const trimmed = stripNonLexicalTags(text).trim();
  if (trimmed.length === 0 || trimmed.length > ACK_RESPONSE_CHAR_LIMIT || trimmed.includes('?')) return false;
  const words = trimmed.toLowerCase().replace(/[.,!\u2026\u2019']/g, ' ').split(/\s+/).filter(word => word.length > 0);
  if (words.length === 0) return false;
  if (ACK_RESPONSE_PHRASES.has(words.join(' '))) return true;
  return words.every(word => ACK_RESPONSE_WORDS.has(word));
}
/** The seeded history is bounded by dropping whole oldest turns until it fits this many characters. */
/** GL2-R1: the closed set of reasons a projected state changes, shared with the host log whitelist. */
type LiveStateCause = (typeof LIVE_STATE_CAUSES)[number];
export const SEED_CHAR_LIMIT = 8_000;
/** C-RECOVERY (a): the adapter's session.input ceiling is 128 messages, and every seeded open appends one
 *  line after the history (the pickup or the opener), so the history itself owns at most 127 of them. */
export const SEED_MESSAGE_LIMIT = 127;
/** C-RECOVERY (a): the adapter's documented 8,192-token proxy, quoted in its own four characters per token. */
export const SEED_TOKEN_PROXY_LIMIT = 8_192;
export const SEED_TOKEN_PROXY_CHARS = SEED_TOKEN_PROXY_LIMIT * 4;
interface SeedTurnLike { role: 'user' | 'model'; text: string }
/** C-RECOVERY (a): the one bound every seeded open passes through. The seed is grouped into exchanges at
 *  finished-turn boundaries, the oldest whole exchange goes first, the latest exchange is never dropped, and the
 *  history plus every appended turn stays inside the adapter's message ceiling and its token proxy, so a large
 *  conversation shrinks instead of being refused. */
export function fitSeedTurns<T extends SeedTurnLike>(transcript: readonly T[], appended: readonly T[] = []): { turns: T[]; chars: number; condensed: boolean } {
  const exchanges: T[][] = [];
  for (const turn of [...transcript, ...appended]) {
    if (turn.role === 'user' || exchanges.length === 0) exchanges.push([turn]);
    else exchanges[exchanges.length - 1]!.push(turn);
  }
  const count = (groups: readonly T[][]): number => groups.reduce((sum, group) => sum + group.length, 0);
  const total = (groups: readonly T[][]): number => groups.reduce((sum, group) => sum + group.reduce((chars, turn) => chars + turn.text.length, 0), 0);
  let kept = exchanges;
  let condensed = false;
  while (kept.length > 1 && (count(kept) > SEED_MESSAGE_LIMIT || total(kept) > SEED_CHAR_LIMIT)) { kept = kept.slice(1); condensed = true; }
  let turns = kept.flat();
  // One exchange larger than the message ceiling still has to fit it, so the ceiling wins over the pairing.
  if (turns.length > SEED_MESSAGE_LIMIT) { turns = turns.slice(turns.length - SEED_MESSAGE_LIMIT); condensed = true; }
  if (turns.length > 0 && total([turns]) > SEED_CHAR_LIMIT) {
    const last = turns[turns.length - 1]!;
    const roomLeft = Math.max(0, SEED_CHAR_LIMIT - (total([turns]) - last.text.length));
    const keep = Math.max(roomLeft - 3, 0);
    turns = [...turns.slice(0, -1), { ...last, text: keep > 0 ? `...${last.text.slice(last.text.length - keep)}` : '...' }];
    condensed = true;
  }
  return { turns, chars: total([turns]), condensed };
}
/**
 * C-CONTINUITY item 3: the header the research ledger rides under. The ledger is the host's own extractive
 * record of what it delivered, so it says who is speaking and never reads as something the owner said.
 */
export const HOST_LEDGER_HEADER = '[host note, not the owner\u2019s words] research this call already delivered:';
/** The cost cap on a mute: past this the muted session closes benignly, so a long mute costs no provider time. */
export const MUTE_WARM_MS = 180_000;
/** After an unmute with an answer held, this much owner silence earns her one short offer of it. */
export const MUTED_OFFER_SILENCE_MS = 2_000;
/** How many silence windows a held answer is offered in: one, plus one retry after a skip. */
const MUTED_OFFER_ATTEMPTS = 2;
const MUTED_OFFER_TEXT = 'An answer to my earlier question arrived while I was muted. Tell me in one sentence.';
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
const CONSUMER_CLOSED_MS = 1_000;
/** S5: the one honest line after a backend turn failed. It owns the failure and offers the retry, and it never
 *  invents a reason the provider did not give. */
export const TURN_FAILED_LINE = 'I lost the thread there. Say that again, or ask me to try once more?';
/** #660: the bounded one item a fresh session accepts where a retired call's tool output cannot go. */
const UNSPOKEN_DELIVERY_PREFIX = 'Your lookup already returned this; tell the owner now: ';
const UNSPOKEN_REPLY_LIMIT = 1_200;
/** #660: the host's own answer to a status question while nothing runs, paraphrased aloud by the voice model. */
export const NO_LOOKUP_RUNNING_NOTE = 'No lookup is running and no result is waiting. Say plainly that nothing is searching, and never say you are still looking.';
/**
 * #667: the closed facts of a call that just arrived, never the owner's words: the declared action, whether a
 * research id came with it, how long the question was, and how many lookups the batch carries.
 */
const researchCallFacts = (calls: { name: string; args: JsonObject }[]):
{ action: 'start' | 'continue' | 'stop' | 'other'; researchIdPresent: boolean; questionChars: number; lookups: number } => {
  const call = calls.find(entry => entry.name === RESEARCH_TOOL_NAME) ?? calls[0];
  const args = call?.args;
  const action = args?.['action'];
  return {
    action: action === 'start' || action === 'continue' || action === 'stop' ? action : 'other',
    researchIdPresent: typeof args?.['researchId'] === 'string' && String(args['researchId']).length > 0,
    questionChars: typeof args?.['question'] === 'string' ? String(args['question']).length : 0,
    lookups: Array.isArray(args?.['lookups']) ? args['lookups'].length : 0,
  };
};
/** #660: the text of one tool result batch, bounded for the one item a fresh session accepts. */
const unspokenReply = (outputs: LiveToolResponse[]): string | undefined => {
  const reply = outputs.map(output => JSON.stringify(output.response)).join('\n').slice(0, UNSPOKEN_REPLY_LIMIT);
  return reply.length === 0 ? undefined : reply;
};
/** S5: how long her own line has to become audible before the turn is settled failed instead of left owing. */
export const TURN_FAILED_GRACE_MS = 1_000;
// 3j response watchdog. A healthy socket proves nothing about a model that stopped generating: an owner turn
// that ended, or a model turn left open, owes a reply, and only a deadline on that debt recovers it. One nudge
// at RESPONSE_WATCHDOG_NUDGE_MS, then the fresh-seeded recovery at RESPONSE_WATCHDOG_RECOVERY_MS after it.
export const RESPONSE_WATCHDOG_NUDGE_MS = 8_000;
export const RESPONSE_WATCHDOG_RECOVERY_MS = 7_000;
/** At most one watchdog recovery per window; a second mute inside it ends the call honestly instead of looping. */
export const RESPONSE_WATCHDOG_WINDOW_MS = 120_000;
/** #538: the audible debt rung. The clock is non-sliding: the first rung lands 8 s after the model began owing audio,
 *  whatever text it wrote in between. The rebuild rung is seven seconds later, which is AUDIBLE_DEBT_REBUILD_MS.
 *  C-DEADAIR: the rung stays at 8 s because the fastest rescue is the response's own end (see #deliverAfterSilentText),
 *  and shortening the rung on top of that broke the replay invariants that guard against double speaking. */
export const AUDIBLE_DEBT_RUNG_MS = 8_000;
/** L-04: a response the provider announced but has not made audible is not progress the owner can hear, so it buys
 *  the rung one short grace and no more. Seven seconds of it was the C-DEADAIR 15 s wait. */
export const DEAD_AIR_RESPONSE_GRACE_MS = 500;
/** L-04: the shortest silence worth a `live_heard_silence` record. Below it the wait is the ordinary latency of one
 *  model turn, and reporting every such pause would bury the waits the owner actually sits through. */
export const HEARD_SILENCE_MIN_MS = 1_000;
export const AUDIBLE_DEBT_REBUILD_MS = AUDIBLE_DEBT_RUNG_MS + RESPONSE_WATCHDOG_RECOVERY_MS;
/** #656: owner audio that arrives while a rebuild is open is held for the new session, newest last. The cap is three
 *  seconds of the 16 kHz s16 mono uplink (32 bytes per millisecond); past it the oldest held frame is the one dropped. */
export const REBUILD_AUDIO_HOLD_MS = 3_000;
export const REBUILD_AUDIO_HOLD_BYTES = REBUILD_AUDIO_HOLD_MS * 32;

/** The write tools the Live model may decline or call, and the resource each one is pinned to. */
const OWNER_WRITE_RESOURCES = new Map([['remember_note', 'owner-memory'], ['save_to_vault', 'owner-vault'], ['trello_write', 'owner-trello'], ['stage_lux_note', 'owner-vault']]);
/** #592: the closed set of causes an idle arm may name, in the host log and in the arm itself. */
export const IDLE_RESET_CAUSES = ['opened', 'unmuted', 'tool_result', 'turn_failed', 'typed', 'owner_speech', 'model_audio'] as const;
/** #592: idle is conversational silence: a finalized owner transcript with content, or model audio. */
type IdleResetCause = typeof IDLE_RESET_CAUSES[number];
/** #592: an owner transcript only counts once it closed carrying the text that was spoken. */
function idleResetCause(handle: ActiveSession, event: LiveVoiceEvent): 'owner_speech' | 'model_audio' | undefined {
  // C-LIVE N-2: a provider frame of digital silence (below the adapter's audible level) is not conversation.
  if (event.type === 'audio') return event.audible === false ? undefined : 'model_audio';
  if (event.type !== 'inputTranscription') return undefined;
  if (event.text.trim() !== '') handle.ownerSpeechPending = true;
  if (event.finished !== true || handle.ownerSpeechPending !== true) return undefined;
  handle.ownerSpeechPending = false;
  return 'owner_speech';
}
/** C-LIVE behaviour 1: an owner turn is finalized once its transcript closed carrying the words that were spoken. */
function ownerTurnFinalized(handle: ActiveSession, event: LiveVoiceEvent): boolean {
  if (event.type !== 'inputTranscription' || event.finalOrigin === 'typed') return false;
  if (event.text.trim() !== '') handle.admissionSpeechPending = true;
  if (event.finished !== true || handle.admissionSpeechPending !== true) return false;
  handle.admissionSpeechPending = false;
  return true;
}
/**
 * C-LIVE behaviour 4 (W5-R3): the run a host deadline reply may answer from. A continue keeps the run it named; a
 * start may name only a run this call created, so the ledger's last run from an earlier call is never handed to
 * the model as this call's findings. `''` is knownReply's answer for "no run of mine is known".
 */
export function deadlineResearchId(call: { researchId?: string | undefined }, priorRunId: string | undefined, currentRunId: string | undefined): string {
  if (call.researchId !== undefined) return call.researchId;
  return currentRunId !== undefined && currentRunId !== priorRunId ? currentRunId : '';
}
/** Every job row is written with a one day expiry (server/tools/jobs.ts); past it the row is stale data. */
const JOB_EXPIRY_MS = 86_400_000;
/** One intent sub-read deadline: a slow source never holds the whole turn past this. */
const INTENT_SUB_DEADLINE_MS = 8_000;
/**
 * #451 Q8: one status definition for a tool call, taken from the result the model was handed and never
 * from a second place that could drift from it. `error` means the result itself is an error: this layer
 * calls no reply failed for any other reason, which is what keeps the journal and the result agreeing.
 */
export function journalToolStatus(response: JsonObject): 'completed' | 'error' {
  return response['error'] === undefined ? 'completed' : 'error';
}

/** S4a ceiling on one non-research tool call: past it the host answers the call itself with a timeout output. */
export const TOOL_CEILING_MS = 12_000;

/**
 * #656: the hard ceiling the mute ladder waits out for one call the model issued. A research run has its own
 * published deadlines in RESEARCH and outlives the plain tool ceiling, so it holds the silence for the longest of
 * them; every other call keeps TOOL_CEILING_MS.
 */
export function callCeilingMs(toolName: string | undefined): number {
  // C-LIVE behaviour 4: an admitted research operation owns the silence only to its deadline and the host's grace.
  return toolName === RESEARCH_TOOL_NAME ? RESEARCH_OPERATION.deadlineMs + RESEARCH_OPERATION.hostGraceMs : TOOL_CEILING_MS;
}
/** R6: how recent the model's own audio must be to hold a late line back. */
const ANSWER_AUDIO_HOLD_MS = 3_000;
/**
 * C-TURN8: how long an announced lookup has to start its call before the host corrects it. Three seconds,
 * the same one beat this file already treats as a turn's pause (ANSWER_AUDIO_HOLD_MS), so a claim followed
 * by a call in the same breath is never corrected.
 */
const CLAIM_WITHOUT_CALL_MS = 3_000;
/**
 * C-TURN8, C-CLAIMS9 outcome 1: the class of first-person lookup announcements, not a list of exact sentences.
 * "let me", "let's", "I'll", "I'm going to" or "I'm" plus a lookup verb is a promise to act, and so is the
 * "give me a moment" form. Past tense ("I checked"), another person ("you can check") and "let me know" are
 * not her own lookup, and "I'll see you" is a farewell, so bare "see" waits for a question word.
 */
const LOOKUP_VERBS = 'look|check|find|search|dig|try|take a look|pull (?:up|(?:that|this|it) up)';
const LOOKUP_CLAIM = new RegExp([
  `\\blet me (?:${LOOKUP_VERBS}|see)\\b`,
  `\\blet'?s (?:${LOOKUP_VERBS}|see)\\b`,
  `\\bi(?:'?ll| will) (?:${LOOKUP_VERBS})\\b`,
  `\\bi(?:'?ll| will) see (?:if|what|whether)\\b`,
  `\\bi(?:'?m| am) going to (?:${LOOKUP_VERBS}|see (?:if|what|whether))\\b`,
  `\\bi(?:'?m| am) (?:looking|checking|finding|searching|digging|trying to (?:look|check|find|search|dig)|pulling (?:up|(?:that|this|it) up))\\b`,
  `\\bgive me (?:a|one) (?:moment|second|minute) to (?:${LOOKUP_VERBS})\\b`,
  '\\bchecking (?:that|this|it)\\b',
  '\\bworking on (?:that|it)\\b',
  '\\blooking (?:that|this|it) up\\b',
].join('|'), 'iu');

/**
 * Whether the response announced a lookup of her own, so the host can hold it to the call it promised. The
 * transcript may omit the apostrophe or carry the typographic one, and the base detector tolerated both, so
 * the text is folded to the straight apostrophe before it is read.
 */
export function announcesLookup(text: string): boolean {
  return LOOKUP_CLAIM.test(text.replace(/[\u2018\u2019\u02bc]/gu, "'"));
}
/**
 * C-TURN8: every tool that reads or writes the owner's own data (Trello, research, mail, calendar, chat,
 * knowledge, conversation history, saves). None of them runs before his first word: research keeps its own
 * gate in `#researchBatch`, and every other name here, reads and saves alike, is refused by `#toolBatch`
 * with the same shape and reason. Saves keep their own later gates once he has spoken
 * (`not_owner_requested` in the vault tool, `owner_transcript_not_final` / `owner_text_mismatch` in the note
 * provenance path); this gate only answers the case where he has not spoken at all. The `open_*` tools stay
 * open: they read no owner record and the opener never calls them.
 */
const OWNER_DATA_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...INTENT_TOOL_NAMES, RESEARCH_TOOL_NAME, ...TRELLO_TOOL_NAMES,
  'conversation_history', 'remember_note', 'save_to_vault', 'stage_lux_note',
]);
/** S4a: a delegation still open this long after its last call was answered, with no terminal nested event, is
 *  stalled: the receipt names it, and the S2 recovery resumes instead of rebuilding. */
export const DELEGATION_DEADLINE_MS = 25_000;
/** R6 late findings: a source that settles this long after the first answer is still silent context for the
 *  model, but it is no longer spoken, because the owner has moved on. */
const LATE_WINDOW_MS = 20_000;
/** R5: a sound this short is not a new question, so the late findings still land: the owner's filler, not an ask. */
const FILLER_WORDS = 3;
/** R6: how much of that block a spoken line carries, so the owner hears one sentence and not a report. */
const LATE_SPOKEN_CHARS = 280;
export function lateFindingsText(source: string, items: readonly string[]): string {
  const label = source === 'mail' ? 'your mail' : source === 'web' ? 'the web' : `your ${source}`;
  const prefix = 'Late findings from your lookup, not supplied by the owner:\n';
  const perItem = Math.max(0, Math.floor((LATE_SPOKEN_CHARS - prefix.length) / Math.max(1, items.length)) - `from ${label}: `.length - 1);
  return prefix + items.map(item => `from ${label}: ${item.slice(0, perItem)}`).join('\n');
}


/** R5: what the late-commentary rule reads, so the owner's patience is pinned by a test and not by a transport. */
export interface LateCommentaryState {
  now: number; answeredAt: number; alreadySpoken: boolean;
  inputAt?: number | undefined; ownerWords: number; lastModelAudioAt?: number | undefined;
  /**
   * #1028 behaviour 4: when a newer research operation started, or a newer tool call was made, after the
   * answer. A question the host acted on is that; a raw owner input is not, because room speech arrives as
   * one and used to park a finding the owner had asked for.
   */
  newerWorkAt?: number | undefined;
}

/**
 * R5 (call 01c4bd89): why a late block stays silent, or null when the turn is quiet enough to say one line aloud.
 * A filler sound (a couple of words, or speech inside the speaking hold) is not a new question, so the findings
 * still land; only an owner question begun after the answer parks them, and the owner's own voice and the answer's
 * audio are separate holds.
 */
export function lateCommentarySilence(state: LateCommentaryState): string | null {
  if (state.alreadySpoken) return 'already_spoken';
  if (state.now - state.answeredAt >= LATE_WINDOW_MS) return 'window_elapsed';
  const filler = state.ownerWords > 0 && state.ownerWords <= FILLER_WORDS;
  const immediate = state.inputAt !== undefined && state.inputAt - state.answeredAt < SPEAKING_HOLD_MS;
  // #1028 behaviour 4: a new question is one the host acted on, a research operation it started or a tool call
  // it made after the answer. Without that evidence the owner's input is room speech, and the finding lands.
  const askedAgain = state.newerWorkAt !== undefined
    ? state.newerWorkAt > state.answeredAt
    : state.inputAt !== undefined && state.inputAt > state.answeredAt && !filler && !immediate;
  if (askedAgain) return 'new_question';
  if (state.inputAt !== undefined && state.now - state.inputAt < SPEAKING_HOLD_MS) return 'owner_speaking';
  if (state.lastModelAudioAt !== undefined && state.now - state.lastModelAudioAt < ANSWER_AUDIO_HOLD_MS) return 'answer_playing';
  return null;
}

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

/** S4a-R2 (e): the one execution state a call of this turn has, and the only vocabulary an execution receipt names. */
type ExecStatus = 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled';
/** #1020: how much of what was sent a settled research projection may record, so the journal line stays short. */
const RESEARCH_PROJECTION_CHARS = 240;

/**
 * #1020 behaviour 4: the settled projection records what the provider was sent, in plain words, bounded:
 * the sources that answered, then the note the model was told to voice. A failure names its reason code
 * and a refusal names its reason, so a journal line is never a bare `research: error`.
 */
export function researchProjection(response: JsonObject, status: 'completed' | 'error'): string {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  const detail = (): string => {
    if (response['status'] === 'blocked') return `refused:${text(response['code']) ?? text(response['reason']) ?? 'unknown'}`;
    if (status === 'error') {
      const reason = text(response['reason']) ?? text(response['error']) ?? 'failed';
      return text(response['state']) === 'refused' ? `refused (${reason})` : `error (${reason})`;
    }
    const findings = Array.isArray(response['findings']) ? response['findings'] as JsonObject[] : [];
    const sources = [...new Set(findings.map(finding => text(finding['source'])).filter((source): source is string => source !== undefined))];
    const note = text(response['note']);
    const count = findings.reduce((n, finding) => n + findingCount(finding), 0);
    const head = count > 0 ? `findings from ${sources.join(', ')}; ${count} delivered items` : 'no findings';
    return `completed, ${note === undefined ? head : `${head}; ${note}`}`;
  };
  const line = `research: ${detail()}`;
  return line.length <= RESEARCH_PROJECTION_CHARS ? line : `${line.slice(0, RESEARCH_PROJECTION_CHARS - 3)}...`;
}
/** S4a-R2 (a, e): a call that can change the world. Nothing may claim "nothing changed" around one of these. */
function isReadOnlyTool(name: string): boolean { return name !== 'stage_lux_note' && !/^(remember|open)_?/.test(name); }


/** The action word a direct tool asks its source for. */
function stepActionOf(name: string): string {
  const suffix = name.split('_').slice(1).join('_');
  if (/search|list|find/.test(suffix)) return 'search';
  if (/note|remember|save/.test(suffix)) return 'save';
  return 'read';
}

interface ActiveSession {
  inputFinal?: boolean;
  stopWords?: string[];
  stopInputAt?: number | undefined;
  stopFinalJournalId?: number | undefined;
  stopAfterJournalId?: number;
  stopGeneration?: number;
  inputAt?: number;
  lookupBridgeForInput?: string;
  lookupAckAt?: number | undefined;
  /** #720: the anchor is the owner's last finished fragment of the turn, not the first. */
  inputFinalAt: number | undefined;
  /** First model audio of the current turn; reset at each model turn start. */
  firstAudioAt: number | undefined;
  /** L-04: the end of the last audible frame, owner speech end or model audio end, whichever came later, and whether
   *  the wait that followed began after a tool result. The wait to the next model audio is the silence the owner heard. */
  heardSince?: number | undefined; heardAfterTool: boolean;
  /** L-04: the end of the last audible model frame of the current turn, cleared at the owner's utterance boundary and at
   *  every model turn start, so a tool turn that spoke no preamble cannot inherit an earlier turn's frame. */
  turnAudioAt?: number | undefined;
  /** Spoken output script codes of the current turn, counted and then reported as counts only. */
  turnLatin: number; turnDevanagari: number; turnChars: number;
  /** C-REBUILD8: the words this turn's response spoke, kept so a filler-only answer is recognisable. Bounded. */
  turnSpoken?: string | undefined;
  /** Whether this turn followed tool work and whether the owner cut it off. */
  turnAfterTool: boolean; turnInterrupted: boolean;
  /** C-TURN8: what she said this response, the timer watching it, and the owner turn's own correction budget. */
  claimText: string; claimTimer?: { cancel: () => void } | undefined;
  claimToolSeen: boolean; claimCorrected: boolean;
  inputJournalId?: number;
  inputFinalTimer?: ReturnType<JobTimer>;
  /** W6: the composed-note settle window runs on its own timer, so a late fragment can still cancel. */
  noteSettleTimer?: ReturnType<JobTimer> | undefined;
  inputFinalWaiters?: Set<() => void>;
  generation: number; attempts: number; rebuilding: boolean;
  /** #591: a rebuild nothing asked for stays quiet: no reconnect marker, no pickup, no instruction to open. */
  quietRebuild: boolean;
  /** C-PICKUP: the pickup the last recovery attempt opened with, so the receipt names what was sent. */
  recoveryPickup?: 'none' | 'quiet' | 'mute' | 'connection' | undefined;
  /** #591: model text or an output transcript since this turn opened, so a turn that spoke is never called ambient. */
  modelTextSinceOpen: boolean;
  /** #451: when this connection generation's provider socket was opened, and when the provider said ready. */
  openedAt?: number | undefined; readyAt?: number | undefined;
  request: LiveVoiceRequest; deadlineMs: number; deadlineAt: number; callDeadlineAt: number; idleAt: number; goAwayUntil: number | undefined;
  /** Consecutive failed recoveries in the current episode; reset after RECOVERY_HEALTHY_MS of health. */
  recoveries: number; lastHealthyAt?: number | undefined; lastRecoveryPath?: 'resume' | 'fresh_seeded';
  /** The first drop of the current episode: the recovery time budget is measured from it. */
  dropEpisodeAt?: number | undefined;
  /** A recovery open that threw synchronously: a config or auth refusal, which ends the call at once. */
  recoveryRefused?: boolean | undefined;
  /** C-LIVE R2: consecutive refused recovery opens; the second one ends the call. */
  recoveryRefusals?: number | undefined;
  /** One outstanding answer per user request: set when a tool result is sent, cleared only by the answer's
   *  own audible audio or an ended turn. Inaudible fill never clears it (D3, amendment C). */
  awaitingAnswer: boolean; answerAt: number | undefined;
  /** The owner muted: the provider stays open on the host's cost cap, no audio goes up or comes down. */
  muted: boolean; mutedAt: number | undefined; muteTimer?: ReturnType<JobTimer> | undefined;
  /** An answer that arrived while muted: its audio was dropped, never played later, and it is offered on unmute. */
  heldAnswer: boolean; mutedOfferTimer?: ReturnType<JobTimer> | undefined; mutedOfferAttempts: number;
  /** L7: a response that began under the mute is never played at unmute; its frames are dropped until the turn ends. */
  dropResponse: boolean;
  /** L7: some of this response arrived under the mute, so it is stale at unmute even if it is still streaming. */
  mutedResponse: boolean;
  /** L19: whether this turn's reply has an output transcript row; a spoken turn without one is receipted. */
  outputJournalled: boolean;
  /** L19: this turn produced audible speech, which survives the trailing modelTurnStarted of the same batch. */
  spokenThisTurn: boolean;
  /** R7: this call opened with the dropped-line opener, which the owner's first words may still cancel. */
  dropOpener: boolean;
  /** L7: the muted time inside this turn, so `live_dead_air` measures the wait the owner actually heard. */
  mutedMs: number;
  /** S4a: the delegation deadline that outlives the S2 watchdog window. */
  delegationTimer?: ReturnType<JobTimer> | undefined;
  /** R6: when this call's first answer went out with sources still reading, and which call spoke a late line. */
  researchAnsweredAt?: number | undefined; lateCommentaryFor?: string | undefined;
  /**
   * #1028 behaviour 4: the last research start and the last tool call this turn made, so a late finding is
   * parked by work the host actually did after the answer and never by a raw owner input.
   */
  researchStartedAt?: number | undefined; lastToolCallAt?: number | undefined;
  /** #1028: the one delayed re-offer of a late finding a hold postponed, so a hold never discards it. */
  lateHoldTimer?: ReturnType<JobTimer> | undefined;
  /** R6: the research this turn may collect once without a new owner turn, and how many sources it still reads. */
  pendingResearch?: { id: string; count: number } | undefined;
  /** R5: the word count of the owner's last finished utterance, so a filler sound is not read as a new question. */
  ownerLastWords: number;
  /** C-DEPTH item 5 (W10-R12): the research text this call holds in the provider conversation, and the payload
   *  the rebuild will seed when it is due. C-CONTINUITY item 4: the ledger is cumulative, so it is the whole call's
   *  extractive record, not the one batch that crossed the threshold. */
  researchRetention: ResearchRetention; researchRebuildSeed?: string | undefined;
  /** C-CONTINUITY item 4: every delivered research batch of this call, oldest evicted first. */
  researchLedgerLog: ResearchLedgerLog;
  /** C-CONTINUITY item 5: every research payload this call put in the conversation, refusals included. */
  contextToolChars: number;
  /** C-CONTINUITY T-11: the full research replies the voice cap paged, kept for this call only. */
  voicePages: VoiceReplyBook;
  /** S4a-R2 (e): one execution receipt per call of this turn, the only source a late line may name. */
  exec: Map<string, { source: string; status: ExecStatus }>;
  progressCallIds: Set<string>;
  /** 3j response watchdog: the silence clock of the turn that owes a reply, and the last watchdog recovery. */
  watchdogTimer?: ReturnType<JobTimer> | undefined; watchdogSince?: number | undefined;
  watchdogPhase?: 'armed' | 'nudged' | undefined; watchdogRecoveredAt?: number | undefined;
  /** C-WATCH: the wait this silence is judged on began at a tool result, not at an owner turn. */
  watchdogSinceTool?: boolean | undefined;
  /** C-WATCH: when the last tool result was handed to the model, so a mute can be told from a wait it never had. */
  lastToolResultAt?: number | undefined;
  /** #656: the rung stood down for a tool call in flight, so the clock re-anchors on that call's own output. */
  debtHeldForTool?: boolean | undefined;
  /** #656: owner audio held across a rebuild, oldest first, bounded by REBUILD_AUDIO_HOLD_BYTES. */
  rebuildAudio: Uint8Array[]; rebuildAudioBytes: number;
  /** #538: the audible debt clock, the debt the owner can hear is unanswered. It is non-sliding: it starts when the
   *  model begins owing audio and only an audible frame, an owner barge-in or the turn's end clears it. `debtOutputs`
   *  is the batch a recreate re-queues exactly once. */
  debtSince?: number | undefined; debtTimer?: ReturnType<JobTimer> | undefined;
  debtStep?: 'rung' | 'rebuild' | undefined;
  debtOutputs?: LiveToolResponse[] | undefined; debtBargeIn?: boolean | undefined;
  /** #660: the reply text of a result that returned but was never said, so a replaced session can still speak it,
   *  and whether the session now open has already been handed it. */
  unspoken?: string | undefined; unspokenDelivered?: boolean | undefined; unspokenResults?: number | undefined;
  /** #660: a stalled delegation with nothing in flight makes the owner's next status answer the host's to give. */
  hostStatusNote?: boolean | undefined;
  /** #538 R4: the provider has announced a response since the debt started, and that response is still in progress.
   *  The rung never cuts off an answer the owner can hear; it grants it one short grace. */
  responseInProgress?: boolean | undefined; debtDeferred?: boolean | undefined;
  /** C-DEADAIR: when the provider announced the response that owes this turn's answer, for the latency record. */
  responseCreatedAt?: number | undefined;
  /** C-DEADAIR: when the debt rung last named this silence, so the sliding watchdog does not name it a second time. */
  deadAirNudgedAt?: number | undefined;
  /** C-DEADAIR: the provider wrote text for this owed answer and the owner heard none of it. */
  debtTextSeen?: boolean | undefined;
  /** C-PITCH: the per-response voice meter over the output PCM already forwarded to playback, and how many
   *  responses it has closed, which is the closed id its two events carry. */
  voiceProfile?: VoiceProfileMeter | undefined; voiceResponses?: number | undefined;
  /** D6: an open model turn holds SPEAKING until turnComplete or 1,500 ms of audible silence. */
  speakingHoldTimer?: ReturnType<JobTimer> | undefined;
  sessionTimer: ReturnType<JobTimer> | undefined; callTimer: ReturnType<JobTimer> | undefined; idleTimer: ReturnType<JobTimer> | undefined;
  /** O1b-A: this socket's trace epoch, its open turn and the session's turn counter. A rebuilt socket gets a
   *  fresh object, so a receipt from the socket it replaced can no longer name the epoch it was opened under. */
  connection: { seq: number; epoch: string; turnId: string | undefined; turnIndex: number };
  pendingCalls: Map<string, string>;
  toolCache: LiveToolCache;
  connectorRecovery?: Promise<void> | undefined;
  researchLedger: ResearchLedger;
  /** C-LIVE behaviour 1: one research operation per finalized owner turn, for the whole session across generations. */
  researchAdmission: ResearchAdmission;
  researchQueryContext?: string;
  /** C-LIVE: owner words seen since the last finalized owner turn, for admission (independent of the idle clock). */
  admissionSpeechPending?: boolean;
  /** C-LIVE N-2: the idle cause last written to host.log, so live_idle_arm is a state change only. */
  idleArmLogged?: string;
  researchScheduler?: ResearchScheduler | undefined;
  /** #1022 F1: the latest research batch's delivery gate answer. The scheduler reads it, never a captured copy. */
  researchAllowed: boolean;
  /** #1022 F1: the generation `researchScheduler` was built for. A rebuild makes a fresh one. */
  researchSchedulerGeneration?: number | undefined;
  registry: readonly ToolDefinition[];
  host: HostContext | undefined;
  toolStep: number;
  /** The live tool steps of the turn in flight, oldest first; never journalled. */
  liveSteps: LiveToolStepBody[];
  /** How many items each call of this turn returned, so its end step counts items and not citations. */
  liveStepItems: Map<string, number>;
  toolCalls: number;
  seenIds: Set<string>;
  /** The invalid-arguments count of the owner turn in flight, so the retry suffix never survives a turn. */
  invalidAttempts: Map<string, number>;
  thinking: boolean;
  pendingCallIds: Set<string>;
  bargeInCallIds: Set<string>;
  /** In-flight abort handle per model call id, so a provider cancellation aborts exactly that call. */
  callAborts: Map<string, AbortController>;
  /** #451 V7/Q6: the turn and response a playback segment was first heard in, by playback key. */
  playbackTurns: Map<string, { turnId?: string; responseKey?: string }>;
  /** Wall-clock start per model call id, for tool_cancelled ms-in-flight and per-turn latency. */
  callStartedAt: Map<string, number>;
  speaking: boolean;
  /** L8-11: owner words heard while she was audible this owner turn, and whether the turn's overlap receipt is written. */
  overlapWords?: number;
  overlapReceipted?: boolean;
  /** Output audio that arrived below the audible threshold this turn, in playback milliseconds. */
  inaudibleMs: number;
  // E1 interruption telemetry: provider-side facts for the last turn only, never audio or text.
  lastModelAudioAt?: number;
  turnCompleteSeen: boolean;
  /** #592: the owner text joined since the last finalization, so an empty finalization is not speech. */
  ownerSpeechPending?: boolean;
  /** #595: the owner zone this call was composed in; the call's date math never re-resolves it. */
  timeZone: string;
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
  pendingDiagnosticLoss?: boolean;
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
 * The warm-context hook wired through the same composition seam: today's calendar digest, owned by the
 * host as a cache read off the request path (1015). Never accepted from transport, and absent means
 * the slot stays out of the assembly (issue 339).
 */
type WarmHooks = { calendarDigest?: CalendarDigestOwner };

/** The host's digest owner as this owner sees it: what a start uses, and a refresh it may ask for. */
export type CalendarDigestOwner = {
  /** The cached digest as it stands, waiting at most for a read already in flight. Never a whole read. */
  forStart(): Promise<CalendarDigestSnapshot>;
  /** A fresh read off the request path; the wake prewarm asks for one. */
  refresh(): void;
};

/**
 * R7: what a wake prewarm can assemble before any session has run. The persona is the frozen prompt and
 * the digest is the read it just made; memory and the conversation summary belong to a start's own store
 * read, which is the one warm input a wake does not touch.
 */
function sourceSections(persona: string, calendar: string | undefined): WarmContextSections {
  return { persona, memory: [], summary: undefined, summaryIds: [], summaryOmitted: [], calendar };
}

/** R7: how many events a digest carries, counted from its `HH:MM` stamps; the receipt never carries their text. */
function digestItems(digest: string | undefined): number {
  return digest === undefined ? 0 : (digest.match(/(?:^|, )\d{2}:\d{2} /g) ?? []).length;
}

/** The receipt one forced prewarm returns, and the host logs (issue 338, R7). */
export type WarmPrewarmReceipt = { readonly ageBeforeMs: number | null; readonly ageAfterMs: number | null; readonly assembled: boolean;
  /** Which source the assembly came from: a start's own sections, this owner's sources, or nothing that fit. */
  readonly reason: 'sections' | 'sources' | 'too_large' | 'unconfigured' };

/** L14: a breath is not a word. The provider's non-lexical tags never reach the journal or the script count;
 *  a closed list only, so any other bracketed text is the owner's own and stays untouched. */
const NON_LEXICAL_TAG = /\[(?:breath|inhale|exhale|laugh|laughs|laughter|chuckle|chuckles|giggle|giggles|smile|smiles|sigh|cough|noise|music|silence)\b[^\]\n]*\]?/gi;
export function stripNonLexicalTags(text: string): string { return text.replace(NON_LEXICAL_TAG, ''); }

/** R7: the dropped-line opener is cancellable only until its own audio has started. */
/** L8-11: how many owner words over her audible answer make an overlap worth a receipt. */
export const OVERLAP_RECEIPT_WORDS = 2;
export function openerCancelled(dropOpener: boolean, openerSpoken: boolean): boolean { return dropOpener && !openerSpoken; }

function identity(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function journalKind(type: string): JournalKind | null { return (persistedKinds as readonly string[]).includes(type) ? type as JournalKind : null; }

/**
 * The script of what the model actually spoke this turn, counted from the output transcript.
 * Counters only: live_turn_script reports buckets and code-point counts, never any spoken text.
 */
function countTurnScript(handle: ActiveSession, text: string): void {
  noteSpoken(handle.liveSessionId, text);
  // C-REBUILD8: the response's own words, bounded at four hundred characters; a longer answer keeps its head,
  // which is never a filler, so the bound can only ever make the check say "not a filler".
  handle.turnSpoken = `${handle.turnSpoken ?? ''} ${text}`.slice(0, 400);
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    handle.turnChars += 1;
    if (/[\u0900-\u097F]/u.test(character)) handle.turnDevanagari += 1;
    else if (/[A-Za-z]/u.test(character)) handle.turnLatin += 1;
  }
}

function resetTurnScript(handle: ActiveSession): void {
  handle.turnLatin = 0; handle.turnDevanagari = 0; handle.turnChars = 0;
  handle.turnAfterTool = false; handle.turnInterrupted = false; handle.inaudibleMs = 0; handle.turnSpoken = '';
}

/** One metadata-only record per turn. A turn with no spoken output reports nothing. */
function logTurnScript(handle: ActiveSession): void {
  if (handle.turnChars === 0) { resetTurnScript(handle); return; }
  const script = handle.turnLatin > 0 && handle.turnDevanagari > 0 ? 'mixed' : handle.turnDevanagari > 0 ? 'devanagari' : 'latin';
  hostLogEvent({ event: 'live_turn_script', liveSessionId: handle.liveSessionId, script, latinChars: handle.turnLatin, devanagariChars: handle.turnDevanagari, afterTool: handle.turnAfterTool, interrupted: handle.turnInterrupted });
  resetTurnScript(handle);
}

/**
 * Open2: one correction after a response completes when she claimed an open the turn did not make.
 * The ledger consumes its own buffer, so a second call in the same turn has nothing to read, and the
 * owner's own speech silences it.
 */
function correctOpenClaim(handle: ActiveSession): void {
  if (handle.inputFinal === false || handle.muted) return;
  const correction = openClaimCorrection(handle.liveSessionId);
  if (correction === undefined) return;
  hostLogEvent({ event: 'open_claim_corrected', reason: correction.reason });
  try { handle.session.sendText({ text: hostNote(correction.text) }); } catch { /* a closed transport settles on its own */ }
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
/** The note's own half of its source identity: the same note twice hashes the same, a different note does not. */
const noteDiscriminator = (text: string) => createHash('sha256').update(normalized(text)).digest('hex').slice(0, 8);
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
// Third-person framing is not note content: "Rob prefers", "he wants" and "the owner" say who the
// note is about, and the owner never speaks their own name. Only the SUBJECT is dropped: the verb stays
// a content word, because the verb is the word that says which way the owner feels.
const MEMORY_FRAMING_WORDS = new Set(['owner', 'said', 'says']);
const MEMORY_FRAMING_LEAD = /^\s*(?:the\s+owner|[a-z]+(?:'s)?)\s+(?=(?:prefers?|likes?|loves?|wants?|needs?|hates?|dislikes?|enjoys?|said|says)\b)/i;
// Which way a clause feels, so a paraphrase of a preference cannot become its opposite.
/** The provider's deltas joined up to the closing boundary of one journal kind: never one fragment. */
function finishedUtterance(tx: Transaction, liveSessionId: string, kind: 'inputTranscription' | 'outputTranscription'): string {
  const rows = tx.all('SELECT text,finished FROM live_journal WHERE live_session_id=? AND kind=? ORDER BY journal_id', [liveSessionId, kind]);
  let pending = '', closed = '';
  for (const row of rows) {
    pending += String(row['text'] ?? '');
    if (Number(row['finished']) === 1) { closed = pending.trim(); pending = ''; }
  }
  return closed;
}

/** The owner turn that just closed: the provider's deltas joined up to the finished boundary, never one fragment. */
function finishedOwnerTurn(tx: Transaction, liveSessionId: string): string {
  return finishedUtterance(tx, liveSessionId, 'inputTranscription');
}

const MEMORY_AFFIRM = new Set(['love', 'loves', 'like', 'likes', 'prefer', 'prefers', 'preferred', 'enjoy', 'enjoys',
  'want', 'wants', 'need', 'needs', 'keen', 'best', 'favorite', 'favourite']);
const MEMORY_DENY = new Set(['not', 'never', 'no', 'none', 'nothing', 'cannot', 'cant', 'dont', 'doesnt', 'didnt', 'isnt', 'arent',
  'wasnt', 'wont', 'without', 'dislike', 'dislikes', 'hate', 'hates']);
/** Affirms or denies; undefined when the clause says neither, so an ordinary note is never refused. */
function feel(text: string): 'affirm' | 'deny' | undefined {
  const words = tokens(text);
  if (words.some(word => MEMORY_DENY.has(word))) return 'deny';
  if (words.some(word => MEMORY_AFFIRM.has(word))) return 'affirm';
  return undefined;
}
// Support must be ONE ask: the turns carrying the note's words have to be adjacent, because a note
// stitched from two turns apart is nobody's sentence. Three turns is one ask, a question and its
// clarification; a wider span is a different topic.
const MEMORY_SPAN_TURNS = 3;
// A contraction is one word: "don't" must read as the negator it is, so apostrophes go before tokens.
const tokens = (text: string): string[] => text.toLowerCase().replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
// Polarity belongs to the clause that carries the note's words, not to the whole turn: the same turn can
// affirm "short answers in the morning" and then say "no meetings before nine".
const MEMORY_CLAUSE_BREAK = /[.;!?,]|\b(?:and|but|because|so|then|while)\b/i;
/** The clause carrying most of the note's words: that clause is the claim the note restates. */
function dominantClause(text: string, words: ReadonlySet<string>): string {
  const hits = (part: string): number => tokens(part).filter(word => words.has(word)).length;
  const parts = text.split(MEMORY_CLAUSE_BREAK).map(part => part.trim()).filter(Boolean);
  let best = parts[0] ?? text;
  for (const part of parts.slice(1)) if (hits(part) > hits(best)) best = part;
  return best;
}
/** The note's content words: lower-cased tokens without stop words, framing or two-letter noise.
 * The preference and polarity verbs are excluded on purpose: they decide direction through feel(),
 * and counting them in the ratio refused a short honest note whose ask used another tense. */
const contentWords = (text: string): string[] => tokens(text)
  .filter(word => word.length >= 3 && !MEMORY_STOP_WORDS.has(word) && !MEMORY_FRAMING_WORDS.has(word)
    && !MEMORY_AFFIRM.has(word) && !MEMORY_DENY.has(word));
/** What she must say when a note did not reach memory: plain English, persona-independent, actionable. */
const REFUSAL_GUIDANCE: Readonly<Record<string, string>> = {
  already_remembered: 'That note is already saved, so nothing new was stored. Tell the owner it is already in memory.',
  owner_text_mismatch: 'The note was not saved: it did not match what the owner said. Tell the owner the note was not saved and ask them to say it in one sentence.',
  owner_transcript_not_final: 'The note was not saved: the end of what the owner said never arrived. Tell the owner the note was not saved and ask them to say it in one sentence.',
  private_memory_unsupported: 'The note was not saved. Tell the owner the note was not saved and ask them to say it in one sentence, on its own, if they want it kept.',
};
const DEFAULT_REFUSAL_GUIDANCE = 'The note was not saved. Tell the owner the note was not saved and ask them to say it in one sentence.';
/** A note keeping less than this share of the owner's ask is a fragment, and she says which fragment was kept. */
const MEMORY_PARTIAL_RATIO = 0.2;
/** All reads and the write share the tool owner's transaction: duplicate calls cannot race. */
export function rememberOwnerNote(tx: Transaction, liveSessionId: string, args: { text: string; kind: 'fact' | 'preference' | 'task' }, now: number): JsonObject {
  // The note is the model's clean paraphrase; the owner's own words are only the support for it.
  const noteText = String(args.text).replace(command, '').replace(/\s+/g, ' ').trim();
  const words = contentWords(noteText.replace(MEMORY_FRAMING_LEAD, ''));
  // A bounded journal window, assembled into owner turns, not provider/model arguments.
  const rows = tx.all("SELECT journal_id,text,finished FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND arrived_at>=? ORDER BY journal_id DESC LIMIT ?", [liveSessionId, now - MEMORY_WINDOW_MS, MEMORY_WINDOW_ROWS]).reverse();
  const turns: { seq: number; text: string }[] = [];
  let pending = '', pendingSeq = 0;
  for (const row of rows) {
    pending += String(row.text ?? ''); pendingSeq = Number(row.journal_id);
    if (Number(row.finished) === 1) { turns.push({ seq: pendingSeq, text: stripNonLexicalTags(pending) }); pending = ''; }
  }
  // The model's tool call is the intent: the latest partial turn is owner speech too, because the
  // provider may never set the finished flag before the call arrives.
  if (pending.trim().length) turns.push({ seq: pendingSeq, text: stripNonLexicalTags(pending) });
  // The window's own support, for a refusal that has no ask to report: how much of the note any turn
  // in the window carries at all.
  const windowSpoken = new Set(turns.flatMap(turn => tokens(turn.text)));
  const windowSupported = words.filter(word => windowSpoken.has(word));
  const windowRatio = words.length ? windowSupported.length / words.length : 0;
  // One ask: the narrowest span of ADJACENT turns, latest first, that carries the note's words.
  const wordSet = new Set(words);
  const turnTokens = turns.map(turn => new Set(tokens(turn.text)));
  let ask: { turn: { seq: number; text: string }; ratio: number; supported: number; feels: 'affirm' | 'deny' | undefined; request: string } | undefined;
  for (let end = turns.length - 1; end >= 0 && !ask; end--) {
    for (let width = 1; width <= MEMORY_SPAN_TURNS && end - width + 1 >= 0; width++) {
      const first = end - width + 1;
      const spoken = new Set<string>();
      for (let index = first; index <= end; index++) for (const word of turnTokens[index]!) spoken.add(word);
      const supported = words.filter(word => spoken.has(word));
      const ratio = words.length ? supported.length / words.length : 0;
      if (ratio < MEMORY_SUPPORT_RATIO) continue;
      ask = { turn: turns[end]!, ratio, supported: supported.length,
        request: turns.slice(first, end + 1).map(turn => turn.text).join(' '),
        feels: feel(dominantClause(turns.slice(first, end + 1).map(turn => turn.text).join(' '), wordSet)) };
      break;
    }
  }
  const receipt = (result: JsonObject, metrics = { ratio: windowRatio, supported: windowSupported.length }): JsonObject => {
    hostLogEvent({ event: 'memory_note', remembered: result.remembered === true, code: String(result.code ?? 'remembered'),
      words: words.length, supported: metrics.supported, supportRatio: Math.round(metrics.ratio * 1000) / 1000, turns: turns.length });
    // A refusal is never silent: the model is told what to say, so the owner hears that nothing was kept.
    if (result.remembered === true) return result;
    const code = String(result.code ?? '');
    return { ...result, guidance: REFUSAL_GUIDANCE[code] ?? DEFAULT_REFUSAL_GUIDANCE };
  };
  const pointer = normalized(noteText);
  if (!pointer) return receipt({ remembered: false, code: 'owner_text_mismatch' });
  // A note copied word for word from one utterance names that utterance, whatever the span search found.
  for (let index = turns.length - 1; index >= 0; index--) {
    if (!normalized(turns[index]!.text).includes(pointer)) continue;
    ask = { turn: turns[index]!, ratio: 1, supported: words.length, request: turns[index]!.text, feels: feel(dominantClause(turns[index]!.text, wordSet)) };
    break;
  }
  if (!ask) {
    // An older turn is outside the window rather than unfinished; only a session with no owner
    // speech at all reports that the transcript was never final.
    const speech = tx.get("SELECT journal_id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' LIMIT 1", [liveSessionId]);
    return receipt({ remembered: false, code: speech ? 'owner_text_mismatch' : 'owner_transcript_not_final' });
  }
  const metrics = { ratio: ask.ratio, supported: ask.supported };
  // Every content word spoken still says nothing about polarity: "does not want" against "wants", or
  // "hates" against "love", is the opposite claim. One side denying where the other does not is a flip,
  // in either direction, and it is refused with the same code and supportRatio 1 that makes it visible.
  const noteFeels = feel(dominantClause(noteText.replace(MEMORY_FRAMING_LEAD, ''), wordSet));
  if (noteFeels !== ask.feels && (noteFeels === 'deny' || ask.feels === 'deny')) return receipt({ remembered: false, code: 'owner_text_mismatch' }, metrics);
  const utterance = ask.turn.text.trim();
  if (classified.test(utterance.replace(command, '').trim()) || classified.test(noteText)) return receipt({ remembered: false, code: 'private_memory_unsupported' }, metrics);
  // One entry per note: the source identity is the canonical `session:journal-sequence` plus a
  // discriminator over the note's own normalised text, so two different notes supported by the same
  // owner turn are both kept while the same note said twice is refused. The deletion tombstone matches
  // exactly this shape, so a forgotten note stays forgotten without touching its sibling.
  const externalId = `${liveSessionId}:${ask.turn.seq}:${noteDiscriminator(noteText)}`;
  const existing = memory.rememberedLiveEntry(tx, externalId);
  if (existing) return receipt({ remembered: false, code: 'already_remembered', entryId: existing }, metrics);
  const clock = { now: () => now };
  const session = memory.createSession(tx, { title: 'Live voice memory', startedAt: now, timeZone: 'UTC' }, clock);
  labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  const entry = memory.appendEntry(tx, { sessionId: session.id, text: noteText, capturedAt: now, timeZone: 'UTC',
    source: { label: `live-voice ${liveSessionId}`, provider: 'live-voice', accountId: liveSessionId, externalId, sourceTimestamp: now, availability: 'present', note: `kind:${args.kind}` } }, clock);
  labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  // A fragment kept is a partial memory, never a silent one: she says which words were saved.
  const requestWords = contentWords(ask.request);
  if (requestWords.length > 0 && words.length / requestWords.length < MEMORY_PARTIAL_RATIO) {
    return receipt({ remembered: true, entryId: entry.id, status: 'partial',
      guidance: `Only part of that was saved: "${noteText}". Tell the owner what was saved and ask for the rest in one sentence.` }, metrics);
  }
  return receipt({ remembered: true, entryId: entry.id }, metrics);
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
  if (bucket.output > 0) audioTotals.set(handle, (audioTotals.get(handle) ?? 0) + bucket.output);
  // A stall marker needs a speaking second followed by three with no playback at all.
  if (bucket.output === 0 && handle.speaking) bucket.silent += 1; else bucket.silent = 0;
  if (bucket.silent === 3) {
  }
  audioBuckets.set(handle, { second, input: channel === 'input' ? bytes : 0, output: channel === 'output' ? bytes : 0, silent: bucket.silent, rmsMax: rmsDbfs ?? -Infinity, rmsPower: rmsDbfs === undefined ? 0 : 10 ** (rmsDbfs / 10), rmsChunks: rmsDbfs === undefined ? 0 : 1 });
}

export function feedJobs(jobs: readonly ToolJob[], liveSessionId: string, now: number): import('./types.js').PendingLiveJob[] {
  return jobs.filter(job => job.deferred
    && (job.deliverySessionId ?? job.originSessionId) === liveSessionId
    && !(job.delivered && job.createdAt + JOB_EXPIRY_MS <= now))
    .map(jobRow);
}

/** E4 (#611): one accepted batch answer as the sub-result research shapes, one place for both live paths. */
export function subResultOf(key: string, name: string, response: Record<string, unknown>, ok: boolean): IntentSubResult {
  const text = typeof response['text'] === 'string' ? response['text'] : '';
  return { key, name, ok, text, originalCharacters: typeof response['originalCharacters'] === 'number' ? response['originalCharacters'] : text.length, omittedCharacters: typeof response['omittedCharacters'] === 'number' ? response['omittedCharacters'] : 0,
    // E4 (#611): the ranker's confidence was dropped here only, so the scheduled read lost the hedge.
    ...(ok && response['knowledgeConfidence'] ? { knowledgeConfidence: response['knowledgeConfidence'] as { confidence: string; top?: string; candidates?: string } } : {}),
    // LOGS.md L-01: the tool layer's closed code for a projection that only carries the owner's own refusal
    // line, kept as evidence so the reader classifies the read by the code and never by its words.
    ...(ok && typeof response['classified'] === 'string' ? { classified: response['classified'] } : {}) } as IntentSubResult;
}

export class LiveSessionOwner {
  readonly #jobs: LiveToolJobs;
  readonly #tools: LiveToolsComposition | undefined;
  readonly #onSessionTerminal: ((liveSessionId: string) => void) | undefined;
  readonly #summaryLog: ((event: { event: string } & Record<string, unknown>) => void) | undefined;
  readonly #memorySource: LiveOwnerConfig['memorySource'];
  /** W10-R20: the rebuild threshold, the config value or the shipped constant. */
  readonly #rebuildThresholdChars: number;
  readonly #store: LiveStorePort;
  readonly #vault: VaultWriter;
  /** W6: the same one lux endpoint the vault writer uses, kept for the exporter's near-duplicate probe. */
  readonly #luxWrite: ReturnType<typeof createLuxWriteTransport>;
  /** W6: sessions that have staged a composed note, so no other session pays a query per owner turn. */
  readonly #noteSessions = new Set<string>();
  /** W6-R2 B2/C1: the one segment carrying each stage's read-back, keyed by session and bound to the stage. */
  readonly #noteRequests = new Map<string, NoteRequestGate>();
  readonly #noteOnset = new Map<string, number>();
  readonly #noteSpeech = new Map<string, { stageId: string; text: string; matched: boolean; drainedAt?: number }>();
  readonly #noteReadback = new Map<string, { readonly stageId: string; readonly key: string }>();
  readonly #voice: LiveVoicePort;
  readonly #profile: LiveProfile;
  readonly #now: () => number;
  readonly #timeZonePin: string | undefined;
  readonly #schedule: NonNullable<LiveOwnerConfig['schedule']>;
  readonly #researchWeb: WebSearchPort | undefined;
  /** The local, model-free block a silent Naya keeps ready (council-presence-1017, item 4). */
  #warm: WarmContextCache;
  /** The digest the host built at the last prewarm; absent leaves the calendar slot out (issue 339). */
  #calendar: string | undefined;
  /** R7: what the last read reached, so a suppressed or failed digest is a line and not a silence. */
  #calendarState: CalendarDigestState;
  /** R7: when that read finished, so the receipt can say how old the digest was at hello. */
  #calendarAt: number | undefined;
  /** The sections the last start used, so a forced prewarm refreshes without reading the store again. */
  #sections: WarmContextSections | undefined;
  readonly #calendarDigest: CalendarDigestOwner | undefined;
  #expiryTimer: ReturnType<NonNullable<LiveOwnerConfig['schedule']>> | undefined;
  readonly #profileIdentity: string;
  readonly #active = new Map<string, ActiveSession>();
  #revision = 1;
  #invalidated = false;
  #providerMemory = new WeakMap<ActiveSession, Map<string, number>>();
  #closed = false;
  /** The last state projected to the web, so one host-log live_state fires per change (F7). */
  #lastProjectedState: LivePageProjection['state'] | undefined;
  /** W3: the last uplink measurement shown to the web, kept so the ended page can still say why it ended. */
  #uplink: LivePageProjection['connection'] = undefined;

  constructor(config: LiveOwnerConfig & { vaultTransport?: ReturnType<typeof createLuxWriteTransport> }) {
    if (!config || typeof config !== 'object' || !config.store || !config.voice) throw new LiveError('invalid_config');
    this.#tools = config.tools;
    const summaryHooks = config.tools as unknown as SummaryHooks | undefined;
    this.#onSessionTerminal = summaryHooks?.onSessionTerminal;
    this.#summaryLog = summaryHooks?.log;
    this.#memorySource = config.memorySource;
    this.#rebuildThresholdChars = config.rebuildThresholdChars ?? RESEARCH.rebuildThresholdChars;
    // The digest hook rides the composition seam; a test may also pass it on the config directly.
    this.#calendarDigest = (config as unknown as WarmHooks).calendarDigest ?? (config.tools as unknown as WarmHooks | undefined)?.calendarDigest;
    this.#calendarState = this.#calendarDigest === undefined ? 'unconfigured' : 'empty';
    this.#warm = new WarmContextCache({ budget: LIVE_INSTRUCTION_TARGET_CHARS, now: () => this.#now() });
    this.#store = config.store;
    this.#voice = config.voice;
    this.#researchWeb = config.researchWeb;
    // C-OPENWEB8: a site he names but does not spell out is found with the one web search this host owns.
    useWebSearchPort(() => this.#researchWeb);
    this.#profile = validateLiveProfile(config.profile);
    this.#timeZonePin = config.timeZone;
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
    this.#luxWrite = config.vaultTransport ?? createLuxWriteTransport(luxWriteEndpoint());
    this.#vault = new VaultWriter({ store: this.#store, transport: this.#luxWrite, now: this.#now, log: event => hostLogEvent(event) });
    this.#jobs = new LiveToolJobs(this.#store, this.#now);
    this.#profileIdentity = liveProfileIdentity(this.#profile);
    memoryOwners.set(this.#store, this);
    this.recover();
  }

  get revision(): number { return this.#revision; }

  /** #595: the owner zone now, so a call composed after the owner moved carries his new zone. */
  #ownerTimeZone(): string {
    return this.#timeZonePin ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Host-generated runtime context: host clock and timezone, plus the groups this session can reach. */
  /** The per-call memory of which Mongoose endpoints were already announced (C-SIGNIN-LIVE). */
  readonly #connectorNotes = new ConnectorNotes();

  #liveRuntimeContext(toolNames: readonly string[], timeZone: string): string {
    const connected = toolGroupNames(this.#researchWeb === undefined ? toolNames : [...toolNames, WEB_SEARCH_ACTION]);
    const endpoints = this.#tools?.status?.().endpoints ?? [];
    const context = buildRuntimeContext({ now: new Date(this.#now()), timeZone, connected,
      vault: { dictation: true, composed: this.#composedNotes() }, connectors: endpoints });
    const signIn = signInNote(endpoints);
    // C-SIGNIN-LIVE: the one sentence about a connector that just came up, said on this call only.
    const note = this.#connectorNotes.take(endpoints);
    const said = [signIn, note].filter((line): line is string => line !== undefined).join('\n\n');
    return said.length > 0 ? `${context}\n\n${said}` : context;
  }

  /** Safe operator-visible identity. Never carries key bytes or prompt text. */
  get profileIdentity(): string { return this.#profileIdentity; }

  /**
   * R3-R5: the calendar digest belongs to every warm assembly, so the caller that is about to assemble
   * asks for it first: one bounded primary-calendar read, never on the voice turn path. Unconfigured,
   * failed or empty leaves the slot out; nothing here can fail the assembly.
   */
  /**
   * R3-R5, 1015: the calendar digest belongs to every warm assembly, so the caller that is about to
   * assemble asks for it first. The host's cache answers from the digest it already holds and waits at
   * most 1,500 ms for a read in flight, so a start never waits on a connector read. The state the read
   * reached is honest: `failed` and `timeout` are never reported as an empty day, and nothing here can
   * fail the assembly. Returns that state for a caller that wants it.
   */
  async prepareCalendar(): Promise<CalendarDigestSnapshot> {
    const owner = this.#calendarDigest;
    if (owner === undefined) { this.#calendar = undefined; this.#calendarState = 'unconfigured'; return { state: 'unconfigured', text: undefined, items: 0, fetchedAt: this.#now() }; }
    let snapshot: CalendarDigestSnapshot;
    try { snapshot = await owner.forStart(); }
    catch { snapshot = { state: 'failed', text: undefined, items: 0, fetchedAt: this.#now() }; }
    this.#calendar = snapshot.text;
    this.#calendarState = snapshot.state;
    this.#calendarAt = snapshot.fetchedAt;
    return snapshot;
  }

  /** Refresh cached calendar context without renewing previously selected conversation summaries. */
  async prewarm(): Promise<WarmPrewarmReceipt> {
    const ageBeforeMs = this.#warm.ageMs ?? null;
    await this.prepareCalendar();
    const previous = this.#sections;
    const refreshed = this.#warm.adopt(sourceSections(this.#profile.prompt.text, this.#calendar));
    if (refreshed !== undefined) this.#sections = refreshed.sections;
    const receipt: WarmPrewarmReceipt = { ageBeforeMs, ageAfterMs: this.#warm.ageMs ?? null, assembled: refreshed !== undefined,
      reason: refreshed === undefined ? 'too_large' : previous === undefined ? 'sources' : 'sections' };
    // One closed metadata line per instruction, whichever route asked for it. The log keeps the 338 shape
    // (two ages and the flag); the closed reason is on the receipt the caller holds.
    this.#summaryLog?.({ event: 'warm_prewarm', ageBeforeMs: receipt.ageBeforeMs, ageAfterMs: receipt.ageAfterMs, assembled: receipt.assembled });
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
        tx.run("UPDATE live_sessions SET diagnostic_metadata_state='unknown',diagnostic_content_state='unknown',native_receipt_state=CASE WHEN native_receipt_state='partial' THEN 'partial' ELSE 'unknown' END,diagnostic_last_reason='host_terminated' WHERE live_session_id=?", [String(row['live_session_id'])]);
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
    // #595: the owner travels, so the zone is read when this call is composed, never at host start.
    const timeZone = this.#ownerTimeZone();
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
          allowedClasses: [...this.#profile.route.dataClasses], connectionIds: this.#connectionIds(tx) };
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
      const earlierOpeners = previousOpeners(tx, assistantId, this.#profile.route.dataClasses);
      const openers = openersNote(earlierOpeners.map(early => early.text), earlierOpeners.map(early => early.topic));
      // Release 3u: the plan this start offers. The persisted start counter is the row count for the
      // owner, so consecutive calls walk the stored open loops even when no summary was written between
      // them; the warm calendar digest supplies the first option when the host built one.
      const summarySelection = summaries.summarySelection(tx, this.#profile.route.dataClasses);
      const storedSummaries = summarySelection.candidates;
      const summaryGap = Object.values(summarySelection.coverage).some(count => count > 0);
      const freshThread = freshOwnerThread(tx, assistantId, this.#profile.route.dataClasses, now);
      const offered = offeredOpenLoops(tx, assistantId, this.#profile.route.dataClasses, now);
      // W5-R2: a start inside the cooldown offers no open-loop option at all, because a summary that re-words
      // the loop would otherwise walk past the exact-topic rule. The other opener kinds are unaffected.
      const openLoopCooling = offered.openedAt !== undefined && now - offered.openedAt <= OPEN_LOOP_OPENER_COOLDOWN_MS;
      const openerPlan = buildOpeningOptions({ candidates: storedSummaries, now, timeZone,
        ...(this.#calendar === undefined ? {} : { calendar: this.#calendar }),
        openLoops: openLoopCooling ? [] : storedOpenLoops(tx, this.#profile.route.dataClasses, now, staleRefusedNoteSessions(tx, assistantId)),
        alreadyOffered: offered.topics,
        ...(freshThread === undefined ? {} : { freshThread }),
        ...(earlierOpeners[0] === undefined ? {} : { previousKinds: earlierOpeners[0].kinds }),
        rotation: Number(tx.get('SELECT COUNT(*) AS starts FROM live_sessions WHERE owner_assistant_id=?', [assistantId])?.['starts'] ?? 0) });
      const composeSession = (earlierSection: string | undefined, calendar: string | undefined) => composeLiveSessionInstruction({ text: configuredPrompt.system, tools: toolNames,
        // The delegated backend executes the tools on the OpenAI path; a direct-tool provider keeps the full conduct.
        delegatedBackend: this.#profile.provider === 'openai',
        accentSelection: currentLiveAccent(),
        runtimeContext: this.#liveRuntimeContext(toolNames, timeZone),
        records: records.filter(record => record.dataClass === 'ordinary'), trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
        now, timeZone,
        ...(calendar ? { calendar } : {}),
        ...((earlierSection || summaryGap) ? { earlierConversations: [earlierSection, summaryGap ? CONVERSATION_RECALL_COVERAGE_NOTE : undefined].filter(Boolean).join('\n') } : {}),
        ...(this.#profile.overlay ? { overlay: this.#profile.overlay } : {}),
        ...(pickup ? { pickupNote: pickupInstruction } : {}), ...(openers !== undefined ? { openersNote: openers } : {}),
        ...(openerPlan.section.length ? { openingOptions: openerPlan.section } : {}) });
      // Memory is frozen at CREATE and fresh at the next CREATE (R1F/R1G), so it is always read here.
      try { records = this.#memorySource?.(tx) ?? []; }
      catch { throw new LiveError('memory_unavailable'); }
      const compose = (): ReturnType<typeof composeLiveSessionInstruction> => {
        const basis = composeSession(undefined, this.#calendar);
        earlier = buildEarlierConversationsSection(storedSummaries,
          { now, timeZone, maxChars: earlierConversationsBudget(basis.text.length) });
        this.#sections = { persona: configuredPrompt.system, memory: [],
          summary: earlier.section || undefined, summaryIds: [...earlier.selectedIds],
          summaryOmitted: [...earlier.omitted], calendar: this.#calendar };
        this.#warm.adopt(this.#sections);
        return earlier.section ? composeSession(earlier.section, this.#calendar) : basis;
      };
      let composed: ReturnType<typeof composeLiveSessionInstruction>;
      try { composed = compose(); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'instruction_too_large') throw new LiveError('instruction_too_large'); throw error; }
      console.error(JSON.stringify({ event: 'live_instruction_sizes', total: composed.text.length, sections: Object.fromEntries(composed.sections.map(section => [section.id, section.chars])), languageCode: this.#profile.language === undefined ? 'unset' : effectiveLanguageCode(this.#profile.language), voice: this.#profile.voice }));
      // M2: what the standing section did with its own budget, once per build, including the build that
      // selected nothing: that zero is the line a "my memory did not reach the call" report needs.
      hostLogEvent({ event: 'standing_memory_selection', selected: composed.standing.selected,
        omitted: composed.standing.omitted, chars: composed.standing.chars });
      // R7: the digest's own state, so a suppressed or failed read is a line and not a silence. Metadata
      // only: the state it reached, how many events rode it and how old it was at this start.
      this.#summaryLog?.({ event: 'calendar_digest', state: this.#calendarState, items: digestItems(this.#calendar),
        ageMs: this.#calendarAt === undefined ? 0 : Math.max(0, now - this.#calendarAt) });
      // M1's plan receipt after O1b-A: the journal is gone, so the plan rides the host log beside the sizes.
      // Metadata only, the kinds offered and the start counter that chose them, never the owner's text.
      hostLogEvent({ event: 'opener_plan', kinds: openerPlan.options.map(option => option.kind), rotation: openerPlan.rotation });
      const memory = { status: composed.omitted.length ? composed.selectedIds.length ? 'partial' : 'omitted' : composed.selectedIds.length ? 'selected' : 'empty',
        selectedIds: composed.selectedIds, omitted: composed.omitted };
      const injectedSummaryIds = [...new Set([...(composed.earlierConversationsIncluded ? earlier.selectedIds : []),
        ...(composed.sections.some(section => section.id === 'opening-options') ? openerPlan.options.flatMap(option => option.sourceId ? [option.sourceId] : []) : [])])];
      const injectedOpeners = composed.sections.some(section => section.id === 'previous-openers') ? earlierOpeners : [];
      const summaryClasses = storedSummaries.filter(row => injectedSummaryIds.includes(row.id)).map(row => row.dataClass);
      const selectedClasses = new Set([...configuredPrompt.dataClasses, ...summaryClasses, ...injectedOpeners.map(row => row.dataClass), ...(composed.selectedIds.length ? ['ordinary' as const] : [])]);
      if (injectedSummaryIds.length || earlier.omitted.length) this.#summaryLog?.({ event: 'conversation_summary_injection', injected: injectedSummaryIds.length, omitted: earlier.omitted.length, chars: composed.sections.find(section => section.id === 'earlier-conversations')?.chars ?? 0 });
      const acceptedPrompt = validateAcceptedPrompt({ ...configuredPrompt, system: composed.text, dataClasses: classes.filter(value => selectedClasses.has(value)), memory, ...(pickup ? { pickup } : {}) }, assistantId);
      const promptIdentity = identity({ text: acceptedPrompt.system, dataClass: this.#profile.prompt.dataClass });
      const fingerprint = fingerprintFor(promptIdentity);
      tx.run('INSERT INTO live_sessions(live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint, client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,?,NULL,NULL,?,?)',
        [liveSessionId, assistantId, context.authorityEpoch, input.idempotencyKey, fingerprint, context.clientId, context.auditId, this.#profileIdentity, promptIdentity, 'accepted', 'detached', now, now]);
      tx.run("UPDATE live_sessions SET diagnostic_metadata_state='in_progress',diagnostic_content_state='in_progress',native_receipt_state='unknown',diagnostic_failures=0,diagnostic_unattributed_transcripts=0,diagnostic_clock_domain=? WHERE live_session_id=?", [hostClockDomain,liveSessionId]);
      tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=?,memory_provenance=? WHERE live_session_id=?', [JSON.stringify(acceptedPrompt), JSON.stringify({ ...memory, injectedSummaryIds, summaryCoverage: summarySelection.coverage, openerSessionIds: injectedOpeners.map(row => row.sessionId) }), liveSessionId]);
      tx.run('INSERT OR IGNORE INTO live_session_conversations(live_session_id,conversation_id) VALUES(?,?)', [liveSessionId, this.#conversationInTx(tx, assistantId)]);
      recordHistorySession(tx, liveSessionId, assistantId, this.#profile.route.dataClasses, injectedSummaryIds, now);
      for (const opener of injectedOpeners) recordHistoryDependency(tx, liveSessionId, opener.sessionId);
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
    if (this.#invalidated) return null;
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
      const row = tx.get('SELECT live_session_id,lifecycle,created_at,updated_at,terminal_at,terminal_outcome,memory_provenance,(SELECT provider FROM live_grants WHERE live_grants.live_session_id=live_sessions.live_session_id LIMIT 1) AS provider FROM live_sessions WHERE owner_assistant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [this.#store.assistantId]);
      // A fresh origin or session restart opens on a blank voice view: an idle page carries no job rows,
      // and a live page carries only the rows of its own session (UI3b).
      const jobs = row ? this.#feedJobs(tx, String(row.live_session_id)) : [];
      if (!row) return { state: 'idle', since: null, ...(jobs.length ? { jobs } : {}), entries: [], cursor };
      handle = this.#active.get(String(row.live_session_id));
      const terminal = parseTerminal(row.terminal_outcome);
      const pastSession: LivePageProjection['pastSession'] = terminal || !handle
        ? { outcome: terminal?.state ?? 'unknown', endedAt: terminal ? Number(row.terminal_at) : null, lastObservedAt: Number(row.updated_at) } : undefined;
      const state: LivePageProjection['state'] = pastSession ? (!terminal && row.lifecycle === 'accepted' ? 'idle' : 'ended') : handle ? this.#handleState(handle) : 'idle';
      const rows = tx.all('SELECT journal_id,kind,text,tool_json,finished FROM live_journal WHERE live_session_id=? AND journal_id>? ORDER BY journal_id LIMIT 100', [String(row.live_session_id), cursor]);
      const entries: LivePageProjection['entries'] = [];
      for (const item of rows) {
        const seq = Number(item.journal_id), kind = String(item.kind);
        if (kind === 'inputTranscription' || kind === 'outputTranscription') entries.push({ seq, kind, text: String(item.text ?? ''), textJoin: row.provider === 'openai' ? 'append' : 'words',
          ...(item.finished === null ? {} : { finished: Number(item.finished) === 1 }) });
        else if (kind === 'toolCall' || kind === 'toolResult') {
          const tool = JSON.parse(String(item.tool_json)) as LiveToolProjection;
          entries.push({ seq, kind, tool: kind === 'toolCall' ? { name: tool.name, status: 'called' } : { name: tool.name, status: tool.status, markdown: tool.markdown, sources: tool.sources.map(source => ({ title: source.title, ...(source.url ? { url: source.url } : {}) })) } });
        } else if (kind === 'continuity') entries.push({ seq, kind, ...JSON.parse(String(item.text)) });
        else if (kind === 'researchProgress') { const p = JSON.parse(String(item.text)) as ResearchProgressView; entries.push({ seq, kind, progress: { researchId: p.researchId, phase: p.phase, sourcesDone: p.sourcesDone, sourcesPending: p.sourcesPending, elapsedMs: p.elapsedMs } }); }
        else if (kind === 'interrupted' || kind === 'turnComplete' || kind === 'terminal') entries.push({ seq, kind });
      }
      const steps = handle !== undefined ? handle.liveSteps.map(step => ({ ...step })) : [];
      // W3: the adapter's own uplink measurement, the one source behind the caption and the terminal code.
      const measured = handle?.session.diagnostics?.()?.connection;
      if (measured) this.#uplink = { quality: measured.quality, uploadKbps: measured.uploadKbps };
      const starved = terminal?.state === 'failed' && terminal.code === 'uplink_starved';
      const connection: LivePageProjection['connection'] = starved
        ? { quality: this.#uplink?.quality ?? 'weak', ...(this.#uplink?.uploadKbps === undefined ? {} : { uploadKbps: this.#uplink.uploadKbps }), endedCode: 'uplink_starved' }
        : this.#uplink;
      return { state, ...(pastSession ? { pastSession } : {}), ...(connection ? { connection } : {}), since: Number(row.created_at), memory: memoryProjection(row['memory_provenance']), ...(jobs.length ? { jobs } : {}), entries, ...(steps.length ? { steps } : {}), cursor: rows.length ? Number(rows[rows.length - 1]!.journal_id) : cursor };
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
    hostLogEvent({ event: 'live_state', state, ...(from === undefined ? {} : { from }), cause, at: this.#now(),
      ...(handle === undefined ? {} : { liveSessionId: handle.liveSessionId, generation: handle.generation }) });
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
      // The app quit with the call still live: the session ends here, named apart from the Stop button.
      if (!this.#settled(handle)) {
        this.#settle(handle, { state: 'closed', code: 'app_quit' }, true, 'ended', null);
        hostLogEvent({ event: 'session_end', reason: 'app_quit', msAfterStop: 0 });
      }
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
    // W6-R2 B1: the stage needs this session's turn facts, so the closure resolves the handle lazily.
    let stageHandle: ActiveSession | undefined;
    if (this.#tools) {
      const saved = this.#store.transaction(tx => tx.get('SELECT acceptance_json FROM live_tool_acceptances WHERE live_session_id=?', [liveSessionId]));
      if (!saved) throw new LiveError('invalidated');
      registry = Object.freeze(this.#tools.owner.liveDefinitions(liveSessionId, (tx, id, args) => rememberOwnerNote(tx, id, args, this.#now()), claim => this.#vault.dispatch(claim), (tx, id, args) => this.#stageComposedNote(tx, id, args, stageHandle), this.#composedNotes()).map(tool => Object.freeze({ ...tool, parameters: structuredClone(tool.parameters) })));
      host = { runId: liveSessionId, actorId: context.clientId, authorityEpoch: context.authorityEpoch, revision,
        grants: registry.filter(tool => tool.effect === 'read' || this.#tools!.owner.liveRememberApproved() && OWNER_WRITE_RESOURCES.get(tool.name) === tool.resourceId && tool.accountId === 'gateway:live-voice').map(tool => ({ tool: tool.name, effect: tool.effect, accountId: tool.accountId, resourceId: tool.resourceId })) };
    }
    const deadLine = this.#deadLineBefore(liveSessionId);
    const seed = this.#seedHistory(liveSessionId, inputClass, deadLine);
    // C-RECOVERY (a): an open is bounded exactly like a rebuild, so a long conversation cannot seed an
    // over-ceiling request here either. The dropped-line opener keeps the one slot SEED_MESSAGE_LIMIT reserves.
    const history = fitSeedTurns(seed.turns, this.#jobHistory(liveSessionId, inputClass) ?? []).turns;
    // Only the coarse intent tools (and remember) are declared to the model; the connector reads stay
    // dispatchable through the registry so the intent fan-out and the session cache keep working.
const modelFacing = registry.filter(tool => tool.name === RESEARCH_TOOL_NAME || tool.name === 'remember_note' || tool.name === 'save_to_vault' || tool.name === 'stage_lux_note' || OPEN_TOOL_NAMES.has(tool.name) || TRELLO_TOOL_NAMES.has(tool.name));
    // The port carries the original JSON schemas; each adapter builds its own provider dialect.
    const declarations = modelFacing.map(tool => ({ name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) }));
    const system = acceptedPrompt.system;
    // L19 opener: a fresh call after a dead one opens by naming the drop when the owner has not spoken yet;
    // once the owner has said something, the seeded history already carries his words as the last turn.
    const silentStart = deadLine && !this.#ownerSpoke(liveSessionId);
    const request: LiveVoiceRequest = { opening: 'model_first',
      system: { text: system, dataClass: dataClasses[dataClasses.length - 1]! }, history: history ?? [], dataClasses,
      ...(silentStart ? { openingText: LIVE_DROPPED_LINE_MARK } : {}),
      ...(this.#profile.language !== undefined ? { languageCode: this.#profile.language } : {}),
      ...(declarations.length ? { tools: declarations } : {}) };
    const sessionMs = Math.min(this.#profile.limits.sessionMs, this.#profile.limits.callMaxMs);
    const deadlineMs = Date.now() + sessionMs;
    const deadlineAt = this.#now() + sessionMs;
    const callDeadlineAt = this.#now() + this.#profile.limits.callMaxMs;
    let session: LiveVoiceSession;
    // O1b-A: the connection object exists before the handle, because the adapter is handed its receipt door at open
    // and the receipts it writes must name this connection's epoch from the first frame onward.
    const connection: ActiveSession['connection'] = { seq: 0, epoch: 'e0', turnId: undefined, turnIndex: 0 };
    const openedAt = this.#now();
    try {
      // Absolute wall clock for the adapter; the injected clock is the owner's own durable order.
      session = this.#voice.open(request, { signal: abort.signal, deadlineMs, limits: this.#profile.limits, trace: this.#tracePort(liveSessionId, connection) });
      hostLogEvent({ event: 'live_provider_open', liveSessionId, generation: 0, instructionChars: request.system.text.length,
        seedChars: (request.history ?? []).reduce((sum, turn) => sum + turn.text.length, 0), tools: request.tools?.length ?? 0 });
    } catch (error) {
      this.#store.transaction(tx => this.#terminalInTx(tx, liveSessionId, { state: 'not_started' }, false, this.#now(), 'ended', null));
      throw error;
    }
    // C-LOG-ENVELOPE: the call is open, so name it once. One live session is one call (L2-R1), and every
    // line the host emits until the next call opens carries this id and the provider generation inside it.
    setLogContext({ liveSessionId, generation: 0 });
    hostLogEvent(clockSync('call_open'));
    this.#store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='active', updated_at=? WHERE live_session_id=?", [this.#now(), liveSessionId]));
    const handle: ActiveSession = {
      generation: 0, attempts: 0, rebuilding: false, quietRebuild: false, modelTextSinceOpen: false, request: structuredClone(request),
      deadlineMs, deadlineAt, callDeadlineAt, idleAt: this.#now() + this.#profile.limits.idleMs, goAwayUntil: undefined,
      timeZone: this.#ownerTimeZone(),
      recoveries: 0, awaitingAnswer: false, answerAt: undefined, muted: false, mutedAt: undefined, heldAnswer: false, dropResponse: false, mutedResponse: false, outputJournalled: false, spokenThisTurn: false, dropOpener: silentStart, mutedMs: 0, researchAllowed: false, mutedOfferAttempts: 0,
      sessionTimer: undefined, callTimer: undefined, idleTimer: undefined, pendingCalls: new Map(),
      connection,
      toolCache: new LiveToolCache(LIVE_CACHE_TTL_MS, () => this.#now()),
      researchLedger: new ResearchLedger(bindings => this.#tools?.owner.releaseEvidence(liveSessionId, bindings)),
      researchAdmission: new ResearchAdmission(), researchRetention: { retainedChars: 0, rebuilds: 0 },
      researchLedgerLog: new ResearchLedgerLog(), voicePages: new VoiceReplyBook(), contextToolChars: 0,
      claimText: '', claimToolSeen: false, claimCorrected: false,
      registry, host, toolStep: 0, liveSteps: [], liveStepItems: new Map(), exec: new Map(), progressCallIds: new Set(), toolCalls: 0, seenIds: new Set(), invalidAttempts: new Map(), thinking: false, speaking: false, inaudibleMs: 0, pendingCallIds: new Set(), bargeInCallIds: new Set(), turnCompleteSeen: false, callAborts: new Map(), playbackTurns: new Map(), callStartedAt: new Map(), inputFinalAt: undefined, firstAudioAt: undefined, heardSince: undefined, heardAfterTool: false, ownerLastWords: 0, turnAudioAt: undefined, turnLatin: 0, turnDevanagari: 0, turnChars: 0, turnAfterTool: false, turnInterrupted: false,
      liveSessionId, session, abort, revision, inputClass, ready: false, invalidated: false, terminal: false,
      consumer: new OutputChannel(this.#profile.limits.consumerQueueEvents, this.#profile.limits.consumerQueueBytes),
      consumerState: 'attached', journalEvents: 0, journalBytes: 0, markerSequence: 0, adapterOutcome: undefined,
      rebuildAudio: [], rebuildAudioBytes: 0,
      diagnosticSnapshots: [], ownerAudioCalls: 0, ownerAudioBytes: 0, ownerRebuildingDropCalls: 0, ownerRebuildingDropBytes: 0, terminalOutcome: null,
      diagnosticTerminalCode: 'outcome_unknown', diagnosticsEmitted: false,
      loopDone: deferred<void>(), done: deferred<LiveSessionSnapshot>(), resolveDone: () => {}, persistFailure: undefined,
    };
    stageHandle = handle;
    const initialSnapshot = this.#readSnapshot(liveSessionId);
    handle.resolveDone = () => {
      try { handle.done.resolve(this.#readSnapshot(liveSessionId)); }
      catch (error) {
        if (!handle.terminalOutcome) { handle.done.reject(error); return; }
        handle.persistFailure ??= error;
        handle.done.resolve({ ...initialSnapshot, ready: handle.ready, terminal: handle.terminalOutcome,
          consumerState: 'ended', journal: { ...initialSnapshot.journal, complete: false } });
      }
    };
    session.ready.then(() => {
      if (handle.generation !== 0 || this.#settled(handle)) return;
      handle.ready = true;
      const job = this.#jobs.forSession(liveSessionId);
      if (job) { job.delivered = true; this.#jobs.save(job); }
    }, () => {});
    session.done.catch(() => {});
    this.#observeDiagnostics(handle, session);
    this.#active.set(liveSessionId, handle);
    this.#noteRequests.set(liveSessionId, new NoteRequestGate());
    handle.openedAt = openedAt;
    this.#noteState(handle, 'created');
    void handle.done.promise.catch(() => {});
    // Two named deadlines: the provider session window continues an attended call in a fresh seeded window,
    // the owner call ceiling ends the call for time exactly as before. Neither is the other.
    handle.sessionTimer = this.#schedule(() => this.#sessionWindowEnded(handle), sessionMs);
    handle.callTimer = this.#schedule(() => {
      this.#settle(handle, { state: 'failed', code: 'session_timeout' }, false, 'ended', null); }, this.#profile.limits.callMaxMs);
    this.#armIdle(handle, this.#profile.limits.idleMs, 'opened');
    void this.#consume(handle).catch(error => this.#consumeFailed(handle, error));
    const ready = session.ready.then(() => this.#readSnapshot(liveSessionId));
    void ready.catch(() => {});
    return {
      liveSessionId,
      ready,
      output: handle.consumer,
      done: handle.done.promise,
      sendAudio: ({ pcm }) => this.#sendAudio(handle, pcm),
      setInputMuted: (muted: boolean) => this.#setInputMuted(handle, muted),
      playbackReceipt: frame => this.#playbackReceipt(handle, frame),
      endAudioStream: () => { if (handle.rebuilding) return; this.#guardHandle(handle); handle.session.endAudioStream(); },
      close: (nativeReason?: string) => this.#stop(handle, nativeReason),
      detach: () => this.#detach(handle),
      overflow: () => {
        if (handle.terminal) return;
        handle.consumerState = 'backpressure';
        this.#settle(handle, { state: 'consumer_backpressure' }, false, 'backpressure', null);
      },
    };
  }

  /** Conversation saves are available unless the owner explicitly disables them. */
  #composedNotes(): boolean { return this.#profile.features?.composedNotes !== false; }

  /** W6 item 12: the notes exporter's own switch, on unless live.json turns it off. */

  /** The composed stage itself is `stageComposedNote`; this keeps the session's own note bookkeeping. */
  #stageComposedNote(tx: Transaction, liveSessionId: string, args: { title: string; body: string; evidenceRefs: string[] }, handle: ActiveSession | undefined): JsonObject {
    const gate = this.#noteRequests.get(liveSessionId);
    const request = gate?.claim();
    if (!request) return { staged: false, code: 'authorization_missing', guidance: 'It was not saved: a fresh owner save request is required.' };
    const result = stageComposedNote(tx, liveSessionId, args,
      { inputAt: handle?.inputAt, inputFinal: handle?.inputFinal === true, heldEvidence: gate?.heldEvidence ?? new Set() }, this.#now(), this.#composedNotes(), request, gate?.externalContextPresent === true);
    if (result['staged'] === true) {
      this.#noteSessions.add(liveSessionId);
      this.#noteReadback.delete(liveSessionId);
      this.#noteOnset.delete(liveSessionId);
      this.#noteSpeech.set(liveSessionId, { stageId: String(result['stageId']), text: '', matched: false });
    }
    return result;
  }

  /** W6 item 5: only the app's own drained receipt arms the confirmation; an interruption kills the stage. */
  #notePlayback(handle: ActiveSession, receipt: NativePlaybackReceipt): void {
    if (!this.#noteSessions.has(handle.liveSessionId)) return;
    const note = this.#store.transaction(tx => openNote(tx, handle.liveSessionId));
    if (!note) return;
    // W6-R2 B2: the read-back is one segment; its own drain arms, its own cut kills, and a segment
    // that began before the stage does neither.
    const key = `${receipt.sourceInstanceId}:${receipt.segmentSeq}`;
    const read = noteSegmentSignal(note, this.#noteReadback.get(handle.liveSessionId), { receipt: receipt.receipt as PlaybackSignalKind, key, wallMs: receipt.wallMs });
    if (read.binding === undefined) this.#noteReadback.delete(handle.liveSessionId);
    else this.#noteReadback.set(handle.liveSessionId, read.binding);
    if (read.note.state === 'armed' && note.state === 'staged') {
      const speech = this.#noteSpeech.get(handle.liveSessionId);
      if (!speech || speech.stageId !== note.stageId) return;
      speech.drainedAt = receipt.wallMs;
      if (!speech.matched) return;
    }
    if (read.note === note) return;
    this.#store.transaction(tx => saveNoteState(tx, read.note));
    hostLogEvent({ event: 'lux_note_readback', state: read.note.state, code: read.note.code ?? receipt.receipt });
  }

  #noteNotSaved(handle: ActiveSession, code: string): void {
    if (this.#settled(handle)) return;
    try { handle.session.sendText({ text: hostNote(`The note was not saved (${code}). Say plainly that it was not saved.`) }); } catch { /* closed transport */ }
  }

  #noteOutput(handle: ActiveSession, kind: string, text: string): void {
    const speech = this.#noteSpeech.get(handle.liveSessionId);
    if (!speech) return;
    const note = this.#store.transaction(tx => openNote(tx, handle.liveSessionId));
    if (!note || note.stageId !== speech.stageId || note.state !== 'staged') return;
    if (kind === 'outputTranscription') {
      speech.text += this.#profile.provider === 'openai' ? text : ` ${text}`;
      return;
    }
    if (!speech.text.trim()) return;
    speech.matched = readbackMatches(noteReadbackText(note), speech.text);
    if (!speech.matched) {
      this.#store.transaction(tx => saveNoteState(tx, { ...note, state: 'invalidated', code: 'readback_mismatch' }));
      this.#noteSpeech.delete(handle.liveSessionId);
      this.#noteNotSaved(handle, 'readback_mismatch');
    } else if (speech.drainedAt !== undefined) {
      const armedAt = speech.drainedAt;
      this.#store.transaction(tx => saveNoteState(tx, { ...note, state: 'armed', armedAt }));
    }
  }

  /** W6 item 6: the next finalized owner turn decides, and the settle window runs on its own timer. */
  #noteOwnerTurn(handle: ActiveSession, text: string): void {
    if (!this.#noteSessions.has(handle.liveSessionId)) return;
    const open = this.#store.transaction(tx => openNote(tx, handle.liveSessionId));
    if (!open) return;
    const onsetAt = this.#noteOnset.get(handle.liveSessionId) ?? handle.inputAt ?? this.#now();
    if (!this.#noteOnset.has(handle.liveSessionId)) this.#noteOnset.set(handle.liveSessionId, onsetAt);
    if (open.state === 'armed' && noteKey(text) === 'read it all' && onsetAt >= (open.armedAt ?? Infinity)) {
      const next = { ...open, state: 'staged' as const, fullReadback: true, confirmationText: '' };
      this.#store.transaction(tx => saveNoteState(tx, next));
      this.#noteReadback.delete(handle.liveSessionId);
      this.#noteSpeech.set(handle.liveSessionId, { stageId: open.stageId, text: '', matched: false });
      this.#noteOnset.delete(handle.liveSessionId);
      return;
    }
    const next = noteOwnerUtterance(open, { text, now: this.#now(), onsetAt });
    if (next === open) return;
    this.#store.transaction(tx => saveNoteState(tx, next));
    hostLogEvent({ event: 'lux_note_confirm', state: next.state, code: next.code ?? '' });
    if (next.state !== 'settling') { this.#noteOnset.delete(handle.liveSessionId); this.#noteReadback.delete(handle.liveSessionId); this.#noteNotSaved(handle, next.code ?? 'not_affirmative'); return; }
    handle.noteSettleTimer?.cancel();
    handle.noteSettleTimer = this.#schedule(() => { void this.#noteSettle(handle); }, Math.max(0, (next.settleAt ?? 0) - this.#now()));
    handle.noteSettleTimer.unref();
  }

  /** W6 item 6: any owner fragment inside the settle window cancels, so a VAD split never commits. */
  #noteFragment(handle: ActiveSession): void {
    if (!this.#noteSessions.has(handle.liveSessionId)) return;
    const open = this.#store.transaction(tx => openNote(tx, handle.liveSessionId));
    if (!open) return;
    if (!this.#noteOnset.has(handle.liveSessionId)) this.#noteOnset.set(handle.liveSessionId, handle.inputAt ?? this.#now());
    if (open.state !== 'settling') return;
    const next = noteOwnerFragment(open, this.#now());
    if (next === open) return;
    handle.noteSettleTimer?.cancel(); handle.noteSettleTimer = undefined;
    this.#store.transaction(tx => saveNoteState(tx, next));
    hostLogEvent({ event: 'lux_note_confirm', state: next.state, code: next.code ?? '' });
    this.#noteReadback.delete(handle.liveSessionId);
  }

  /** W6 item 7: the dispatcher claims the frozen payload and dispatches it once through the vault writer. */
  async #noteSettle(handle: ActiveSession): Promise<void> {
    handle.noteSettleTimer = undefined;
    const open = this.#store.transaction(tx => openNote(tx, handle.liveSessionId));
    if (!open || open.state !== 'settling') return;
    const settled = noteSettle(open, this.#now());
    if (settled.state !== 'committed') {
      if (settled !== open) { this.#noteOnset.delete(handle.liveSessionId); this.#store.transaction(tx => saveNoteState(tx, settled)); this.#noteNotSaved(handle, settled.code ?? 'not_affirmative'); }
      return;
    }
    // The digest frozen at stage time is the only payload that may ever be sent.
    const frozen = freezeNote({ title: settled.title, body: settled.body, externalContextPresent: settled.externalContextPresent === true });
    if (frozen.state !== 'frozen' || frozen.payloadSha !== settled.payloadSha) {
      const invalid = { ...settled, state: 'invalidated' as const, code: 'payload_changed' };
      this.#store.transaction(tx => saveNoteState(tx, invalid));
      hostLogEvent({ event: 'lux_note_saved', saved: false, code: 'payload_changed' });
      return;
    }
    this.#store.transaction(tx => saveNoteState(tx, settled));
    const claim = this.#store.transaction(tx => authorizeComposedWrite(tx, { liveSessionId: handle.liveSessionId, stageId: settled.stageId, content: settled.body, title: settled.title, now: this.#now(), externalContextPresent: settled.externalContextPresent === true, payloadSha: settled.payloadSha }));
    let receipt: VaultReceipt;
    try { receipt = claim.state === 'dispatch' ? await this.#vault.dispatch(claim) : claim.receipt; }
    catch { receipt = { saved: false, code: 'outcome_unknown' }; }
    this.#store.transaction(tx => markCommitted(tx, settled.stageId, receipt.insightId));
    this.#noteReadback.delete(handle.liveSessionId);
    this.#noteOnset.delete(handle.liveSessionId);
    hostLogEvent({ event: 'lux_note_saved', saved: receipt.saved, code: receipt.code ?? 'inserted' });
    if (this.#settled(handle)) return;
    const line = receipt.saved
      ? `The vault returned insight ${receipt.insightId}. Say: Saved ${JSON.stringify(settled.title)} in Lux.`
      : `The vault did not confirm the save (${receipt.code ?? 'unknown'}). Say that plainly; do not claim success or retry it.`;
    try { handle.session.sendText({ text: hostNote(line) }); } catch { /* a closed transport settles on its own */ }
  }

  /**
   * W6 item 12: the session-end flush of remember_note facts and preferences. One row per note, the
   * same vault client, no spoken confirmation, and a log event that carries counts only.
   */

  /**
   * O1b-N: one native playback receipt, validated against the O1a ingestion types and recorded as a
   * native trace event plus its playback summary row. A refusal is a typed code in the debug journal
   * and never changes session state: a malformed frame cannot end or wedge a call.
   */
  #playbackReceipt(handle: ActiveSession, frame: string): void {
    try {
      const receipt = parsePlaybackReceipt(frame);
      recordPlaybackReceipt(this.#store, handle.liveSessionId, receipt, this.#playbackAttribution(handle, receipt));
      this.#notePlayback(handle, receipt);
    } catch (error) {
      const code = error instanceof IngestReject || error instanceof TraceRecordError ? error.code : 'record_failed';
      hostLogEvent({ event: 'live_trace_rejected', kind: 'playback.received', code });
      this.#diagnosticFailure(handle,'native_receipt_rejected');
    }
  }

  /**
   * #451 H14: the result content of one call, in the content table the diagnostic timeline reads, written
   * on the same path that wrote tool_calls.result_json. One call, one row; trace retention prunes it.
   */
  #callResult(handle: ActiveSession, callId: string, response: JsonObject | undefined, markdown: string | undefined): void {
    const text = response === undefined || Object.keys(response).length === 0 ? markdown ?? '' : JSON.stringify(response);
    if (text.length === 0) return;
    try {
      recordCallResult(this.#store, { callKey: scopedTraceKey(handle.liveSessionId, handle.connection.epoch, 'call', callId), text });
    } catch (error) {
      hostLogEvent({ event: 'live_trace_rejected', kind: 'call.output_written', code: error instanceof TraceRecordError ? error.code : 'record_failed' });
      this.#diagnosticFailure(handle, 'trace_write_failed');
    }
  }

  /**
   * #451 V7/Q6 (W6-R1 W6-2): a playback segment is tied to the turn and the response that were open when
   * its FIRST receipt arrived, and every later receipt of the same segment reuses that attribution. A
   * segment that starts before a close and drains after it is still read against the answer it played,
   * and a receipt that lands during the next turn cannot be attributed to it. The response is the trace
   * row recorded for that turn; when no turn is open nothing is guessed.
   */
  #playbackAttribution(handle: ActiveSession, receipt: NativePlaybackReceipt): { turnId?: string; responseKey?: string } {
    const key = playbackKeyOf(handle.liveSessionId, receipt.sourceInstanceId, receipt.segmentSeq);
    const known = handle.playbackTurns.get(key);
    if (known !== undefined) return known;
    const turnId = handle.connection.turnId;
    if (turnId === undefined) return {};
    const row = this.#store.transaction(tx => tx.get(
      'SELECT response_key FROM trace_response WHERE live_session_id=? AND turn_id=? ORDER BY created_at DESC, response_key DESC LIMIT 1',
      [handle.liveSessionId, turnId]));
    const responseKey = row?.['response_key'];
    const attribution = { turnId, ...(typeof responseKey === 'string' ? { responseKey } : {}) };
    handle.playbackTurns.set(key, attribution);
    return attribution;
  }

  /**
   * The owner's mute, over the call's own control channel. The provider session stays open for MUTE_WARM_MS
   * so an unmute inside the window resumes it with no handshake, and the cost cap closes it benignly after.
   * While muted the response watchdog and the idle clock are suspended, and an answer that arrives is held.
   */
  #setInputMuted(handle: ActiveSession, muted: boolean): void {
    if (this.#settled(handle) || handle.muted === muted) return;
    const now = this.#now();
    handle.muted = muted;
    if (muted) {
      handle.mutedAt = now;
      // A mute drops the answer debt: the clock and the phase go with it, and the unmute starts no new one.
      this.#cancelWatchdog(handle);
      handle.idleTimer?.cancel(); handle.idleTimer = undefined;
      handle.muteTimer?.cancel();
      handle.muteTimer = this.#schedule(() => {
        handle.muteTimer = undefined;
        if (this.#settled(handle) || !handle.muted) return;
        hostLogEvent({ event: 'live_mute', liveSessionId: handle.liveSessionId, generation: handle.generation,
          muted: true, warm: false, msSinceMute: Math.max(0, this.#now() - (handle.mutedAt ?? this.#now())) });
        this.#settle(handle, { state: 'closed', code: 'muted_expired' }, false, 'ended', null);
      }, MUTE_WARM_MS);
      handle.muteTimer.unref?.();
    } else {
      handle.muteTimer?.cancel(); handle.muteTimer = undefined;
      this.#armIdle(handle, this.#profile.limits.idleMs, 'unmuted');
      // L7: the muted time is not dead air the owner heard, and a response that began under the mute is not
      // played at unmute: the owner speaks next, and the held-answer offer names it in one sentence.
      // #720: only the muted time inside the dead-air span counts, so a mute that opened before the owner's last
      // fragment is trimmed to that fragment instead of being subtracted from a wait it never made longer.
      handle.mutedMs += Math.max(0, now - Math.max(handle.mutedAt ?? now, handle.inputFinalAt ?? now));
      // A response whose first audio arrived under the mute is cancelled at once; if in doubt, it is dropped.
      handle.dropResponse = handle.mutedResponse;
      // The held answer offer owns the reply the mute deferred; only the next owner turn or provider
      // output arms the watchdog again, so an unmute can never nudge or reopen on the dropped debt.
      this.#armMutedOffer(handle);
    }
    hostLogEvent({ event: 'live_mute', liveSessionId: handle.liveSessionId, generation: handle.generation,
      muted, warm: !this.#settled(handle), msSinceMute: muted ? 0 : Math.max(0, now - (handle.mutedAt ?? now)) });
  }

  /**
   * An answer that finished while the owner was muted was never played, and it is never played late: on the
   * unmute she gets one short item saying it arrived, and only when the owner stays silent that long.
   */
  #armMutedOffer(handle: ActiveSession): void {
    if (!handle.heldAnswer) return;
    handle.mutedOfferAttempts = 0;
    this.#scheduleMutedOffer(handle);
  }

  /** One offer window. The held answer goes out only into owner silence, and a window it misses is
   *  receipted and retried once, so a held answer is never dropped without a record of why. */
  #scheduleMutedOffer(handle: ActiveSession): void {
    const since = this.#now();
    handle.mutedOfferTimer?.cancel();
    handle.mutedOfferTimer = this.#schedule(() => {
      handle.mutedOfferTimer = undefined;
      if (this.#settled(handle) || handle.muted || !handle.heldAnswer) return;
      const ownerSpoke = handle.inputAt !== undefined && handle.inputAt >= since;
      if (ownerSpoke) { this.#mutedOfferSkipped(handle, 'owner_spoke'); return; }
      try { handle.session.sendText({ text: MUTED_OFFER_TEXT }); handle.heldAnswer = false; }
      catch { this.#mutedOfferSkipped(handle, 'send_failed'); }
    }, MUTED_OFFER_SILENCE_MS);
    handle.mutedOfferTimer.unref?.();
  }

  /** The skip is a receipt and a retry: the answer stays held, so a later window or a later unmute
   *  still carries it, and the log names the reason this window could not. */
  #mutedOfferSkipped(handle: ActiveSession, reason: 'owner_spoke' | 'send_failed'): void {
    const now = this.#now();
    hostLogEvent({ event: 'live_mute', liveSessionId: handle.liveSessionId, generation: handle.generation,
      muted: handle.muted, warm: !this.#settled(handle), msSinceMute: Math.max(0, now - (handle.mutedAt ?? now)),
      offer: 'offer_skipped', reason });
    handle.mutedOfferAttempts += 1;
    if (handle.mutedOfferAttempts < MUTED_OFFER_ATTEMPTS) this.#scheduleMutedOffer(handle);
  }

  #armIdle(handle: ActiveSession, remainingMs: number, resetBy: IdleResetCause): void {
    if (this.#settled(handle)) return;
    handle.idleTimer?.cancel();
    handle.idleAt = this.#now() + remainingMs;
    // #592 / C-LIVE N-2: one record per change of cause, so the log testifies what restarted the clock without one
    // line per audio frame.
    if (handle.idleArmLogged !== resetBy) { handle.idleArmLogged = resetBy; hostLogEvent({ event: 'live_idle_arm', resetBy, idleMs: remainingMs }); }
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
   * #538: what the adapter reported for the write decides the start. A failed write is already a lost answer, so the
   * recovery opens at once; sent and deferred both leave the model owing audio, which starts the audible debt clock.
   */
  #armDeadAir(handle: ActiveSession, outputs: LiveToolResponse[], outcome: LiveToolSendOutcome): void {
    if (this.#settled(handle)) return;
    // 3j: the tool result is conversational activity, so the idle clock restarts here rather than on mic frames.
    // A muted session suspends that clock as well, so research finishing while muted cannot time the call out.
    if (!handle.muted) this.#armIdle(handle, this.#profile.limits.idleMs, 'tool_result');
    handle.awaitingAnswer = true;
    handle.answerAt = this.#now();
    this.#armDelegationDeadline(handle);
    // #660: the result is owed until the model's own audio proves it said it, so its text travels with the debt
    // and the session that replaces this one can still speak it.
    const reply = unspokenReply(outputs);
    if (reply !== undefined) { handle.unspoken = reply; handle.unspokenDelivered = false; handle.unspokenResults = outputs.length; }
    // L-04: the wait that ends the next time she speaks followed a tool, which the heard-silence record names.
    handle.heardAfterTool = true;
    this.#armDebt(handle, outputs, 'tool_output');
    // C-WATCH: the wait from here began at this result, so every record of it says so and a reader never mistakes a
    // post-tool wait for the owner's turn. The terminal decision needs the time itself.
    handle.watchdogSinceTool = true;
    handle.lastToolResultAt = this.#now();
    if (outcome === 'failed') void this.#recreateForDeadAir(handle, 'send_failed').catch(() => { /* the recreate names its own failure */ });
  }

  /**
   * #538: the audible debt clock. It starts when the model began owing audio and it never slides: model text, a model
   * turn start and output transcription are not audio the owner heard, so they leave its deadline exactly where it
   * was. Only the first audible frame, an owner barge-in or the turn's end clears it, and while it runs the response
   * watchdog stays out of its silence so one silence never has two timers on it.
   */
  #armDebt(handle: ActiveSession, outputs: LiveToolResponse[], reason: 'tool_output' | 'recreate'): void {
    if (this.#settled(handle)) return;
    handle.debtOutputs = outputs;
    // #656: a clock that stood down for a tool call in flight re-anchors on that call's own output, so the model gets
    // the same eight seconds to speak its result as any other tool output. Every other output leaves a running clock
    // exactly where it was (#538: the deadline never slides).
    if (handle.debtSince !== undefined && (handle.debtHeldForTool !== true || handle.muted)) return;
    if (handle.debtSince !== undefined) { handle.debtTimer?.cancel(); handle.debtTimer = undefined; }
    // A muted session hears nothing, so nothing is owed to it while the mute holds.
    if (handle.muted) return;
    // L-04: the clock is anchored at the last thing the owner heard, not at the tool output, so a slow lookup's
    // provider time is part of the same silence. C-DEADAIR: the rung itself is four seconds, and the wait the owner
    // actually sat through is recorded apart from the provider's share in `live_response_latency`.
    const lastAudible = handle.turnAudioAt ?? this.#now();
    handle.debtSince = lastAudible;
    handle.debtBargeIn = false;
    handle.debtDeferred = false;
    handle.debtHeldForTool = false;
    handle.responseInProgress = false;
    handle.responseCreatedAt = undefined;
    handle.deadAirNudgedAt = undefined;
    handle.debtTextSeen = false;
    // One silence, one clock: the sliding watchdog stands down for the silence the debt clock now owns.
    this.#cancelWatchdog(handle);
    this.#noteDebt(handle, 'start', reason);
    this.#scheduleDebt(handle, Math.max(1, AUDIBLE_DEBT_RUNG_MS - (this.#now() - lastAudible)), 'rung');
  }

  #scheduleDebt(handle: ActiveSession, delayMs: number, step: 'rung' | 'rebuild'): void {
    handle.debtTimer?.cancel();
    handle.debtStep = step;
    const generation = handle.generation;
    handle.debtTimer = this.#schedule(() => { void this.#debtRung(handle, generation, step).catch(() => { /* the rung settles its own failure */ }); }, delayMs);
    handle.debtTimer.unref?.();
  }

  #clearDebt(handle: ActiveSession, reason: 'audible' | 'owner_barge_in' | 'turn_end'): void {
    // #660: only her own audio proves the result was said, and only an ended turn retires an answer she never gave.
    if (reason !== 'owner_barge_in') { handle.unspoken = undefined; handle.unspokenDelivered = false; }
    if (handle.debtSince === undefined) return;
    handle.debtTimer?.cancel(); handle.debtTimer = undefined;
    handle.debtSince = undefined; handle.debtStep = undefined; handle.debtOutputs = undefined;
    handle.debtDeferred = false; handle.debtHeldForTool = false;
    this.#noteDebt(handle, 'clear', reason);
  }

  /**
   * #660: hand the unspoken result to the session that is open now. A session the host replaced cannot accept the
   * retired call ids of the one it replaced, so the result travels as the one input a fresh session does accept: a
   * bounded text item, sent once the session is ready. One retry, then the turn ends with its closed reason.
   */
  async #deliverUnspoken(handle: ActiveSession): Promise<boolean> {
    if (handle.unspoken === undefined || handle.unspokenDelivered === true) return true;
    const text = `${UNSPOKEN_DELIVERY_PREFIX}${handle.unspoken}`;
    const session = handle.session;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await session.ready.catch(() => {});
      if (this.#settled(handle) || handle.session !== session) return false;
      try {
        session.sendText({ text: hostNote(text) });
        handle.unspokenDelivered = true;
        // #667: the recreate names how many unspoken results reached the session that replaced the old one.
        hostLogEvent({ event: 'live_unspoken_delivered', liveSessionId: handle.liveSessionId,
          generation: handle.generation, results: handle.unspokenResults ?? 1, attempt: attempt + 1 });
        return true;
      } catch { /* a refused send is the one retry: the next pass awaits readiness again, then gives up */ }
    }
    // #660: a result the host cannot put in front of the model is not swallowed, it ends the turn with its reason.
    this.#turnFailed(handle, handle.generation, 'send_failed');
    return false;
  }

  /** #538 R4: the held rung fires the moment the response that held it ends without audio. */
  #fireDeferredRung(handle: ActiveSession): void {
    if (handle.debtDeferred !== true) return;
    handle.debtDeferred = false;
    handle.debtTimer?.cancel(); handle.debtTimer = undefined;
    void this.#debtRung(handle, handle.generation, 'rung').catch(() => { /* the rung settles its own failure */ });
  }

  /** #538: one debt phase change, as the same content-free enums in the host log and in the trace timeline. */
  #noteDebt(handle: ActiveSession, phase: DebtPhase, reason: DebtReason): void {
    hostLogEvent({ event: 'live_debt', phase, reason });
    this.#receipt(handle, 'live.debt', {}, { phase, reason, at: this.#now() });
  }

  /**
   * #538: one rung of the audible debt clock. The 8 s rung is per provider: gpt-live-1 has no response.cancel and no
   * truncate, so the only move is to close the provider session and recreate it; Gemini keeps its one neutral
   * continuation input. The rebuild rung seven seconds later is the existing fresh-seeded recovery, so a second mute
   * inside the window keeps its model_unresponsive and uplink_starved classification.
   */
  /**
   * #656: whether a tool call the model issued still owns the silence. The call's own arrival time is the clock and
   * its own ceiling is the bound, so a call older than that has run past the point where it answers and the ladder
   * stops waiting for it. Any pending call inside its ceiling holds the silence.
   */
  #toolOwnsSilence(handle: ActiveSession): boolean {
    if (handle.pendingCallIds.size === 0) return false;
    for (const id of handle.pendingCallIds) {
      const started = handle.callStartedAt.get(id);
      if (started === undefined || this.#now() - started < this.#callCeiling(handle, id)) return true;
    }
    return false;
  }

  /** #656: the ceiling the ladder waits out for the call it holds, by the tool the model called. */
  #callCeiling(handle: ActiveSession, callId: string): number {
    return callCeilingMs(handle.pendingCalls.get(callId));
  }

  async #debtRung(handle: ActiveSession, generation: number, step: 'rung' | 'rebuild'): Promise<void> {
    if (this.#settled(handle) || generation !== handle.generation || handle.debtSince === undefined) return;
    handle.debtTimer = undefined;
    if (handle.debtBargeIn) return;
    // C-REBUILD8: the speaking hold the sliding watchdog keeps, at the layer that owns the dead-air nudge. The
    // 2026-10-28 N12 nudge came from here (`live_debt phase=rung reason=dead_air` then `live_dead_air_nudge`), so a
    // sentence still being spoken holds the rung and its rebuild back; the ladder re-anchors and judges the
    // silence from his final fragment. No timer value changes.
    if (handle.inputFinal !== true && handle.inputAt !== undefined && this.#now() - handle.inputAt < SPEAKING_HOLD_MS) {
      this.#scheduleDebt(handle, SPEAKING_HOLD_MS, step);
      return;
    }
    const turnAgeMs = Math.max(0, this.#now() - handle.debtSince);
    // #656: a tool call the model issued owns the silence through the dead-air path (#538 speaks progress while a call
    // runs), so the ladder never nudges or rebuilds over it: it stands down and #armDebt re-anchors the clock on that
    // call's own output. The call's own ceiling (a research run's deadline, else TOOL_CEILING_MS) bounds the wait, so
    // a call that has run past it no longer owns the silence and a truly wedged call still recovers.
    if (this.#toolOwnsSilence(handle)) {
      handle.debtHeldForTool = true;
      this.#scheduleDebt(handle, AUDIBLE_DEBT_RUNG_MS, 'rung');
      return;
    }
    // #538 R4: an answer in flight is never the ladder's to lose, but a response the owner cannot hear is not an
    // answer she is listening to. It buys the rung DEAD_AIR_RESPONSE_GRACE_MS and no more: a response that produced
    // no audio buys nothing, and a response that did has already cleared this debt.
    if (step === 'rung' && handle.responseInProgress === true && handle.debtDeferred !== true) {
      handle.debtDeferred = true;
      this.#scheduleDebt(handle, DEAD_AIR_RESPONSE_GRACE_MS, 'rung');
      return;
    }
    this.#noteDebt(handle, 'rung', step === 'rung' ? 'dead_air' : 'rebuild');
    if (step === 'rebuild') { await this.#watchdogRecover(handle, generation, turnAgeMs); return; }
    // The receipts the dead-air nudge has always written, whichever provider answers the rung.
    hostLogEvent({ event: 'live_dead_air', msSinceTool: turnAgeMs,
      msSinceAudible: handle.lastModelAudioAt === undefined ? null : Math.max(0, this.#now() - handle.lastModelAudioAt) });
    hostLogEvent({ event: 'live_dead_air_nudge', elapsedMs: AUDIBLE_DEBT_RUNG_MS });
    // One silence earns one nudge: the sliding watchdog's own receipt stays for the silences the debt clock never named.
    handle.deadAirNudgedAt = this.#now();
    const stalledTurn = handle.connection.turnId;
    if (stalledTurn !== undefined) {
      this.#receipt(handle, 'live.dead_air_stalled', { turnId: stalledTurn }, {
        stalledAt: this.#now(), turnAgeMs, anyAudio: handle.firstAudioAt !== undefined, inaudibleMs: Math.round(handle.inaudibleMs),
      });
    }
    // C-LIVE behaviour 4: no synthetic "Continue." owner text on any provider; it is a fake owner turn that can
    // revive research. Gemini waits for the rebuild rung; GPT-Live delivers the unspoken result or recreates.
    if (this.#profile.provider !== 'openai') {
      this.#scheduleDebt(handle, RESPONSE_WATCHDOG_RECOVERY_MS, 'rebuild');
      return;
    }
    // #660: the rebuild exists because a wedged response cannot be nudged, not because the result is unsayable. An
    // unspoken result goes to the live session first and only a model still mute seven seconds later is rebuilt, so
    // the answer the owner asked for is not made to wait for two provider recreates.
    if (handle.unspoken !== undefined && handle.unspokenDelivered !== true) {
      if (!(await this.#deliverUnspoken(handle))) return;
      this.#scheduleDebt(handle, RESPONSE_WATCHDOG_RECOVERY_MS, 'rebuild');
      return;
    }
    const recreated = await this.#recreateForDeadAir(handle, 'dead_air');
    if (!recreated) return;
  }

  /**
   * #538: the OpenAI recovery rung. gpt-live-1 cannot cancel or truncate a response, so the host closes the provider
   * session and recreates it with the conversation seed, then hands the pending tool outputs to the new response
   * exactly once. An owner barge-in in flight owns the turn: nothing is recreated under it.
   */
  async #recreateForDeadAir(handle: ActiveSession, reason: 'send_failed' | 'dead_air'): Promise<boolean> {
    if (this.#settled(handle) || handle.debtBargeIn) return false;
    if (reason === 'send_failed') this.#noteDebt(handle, 'rung', 'send_failed');
    const outputs = handle.debtOutputs ?? [];
    // #660: the recovery hands the unspoken result to the session it opens, as the one input a fresh session
    // accepts. The retired call ids are never re-sent to a session that never delegated them.
    const opened = await this.#recoverFromDrop(handle, undefined, true, 'model_mute');
    // F3: a recreate that could not open is the speakable failure, whichever rung started the ladder.
    if (!opened || this.#settled(handle)) { this.#turnFailed(handle, handle.generation, 'recreate_failed'); return false; }
    this.#armDebt(handle, outputs, 'recreate');
    this.#scheduleDebt(handle, RESPONSE_WATCHDOG_RECOVERY_MS, 'rebuild');
    return true;
  }

  /** The delegation a receipt names: this session window, which is the one delegation the host can speak for. */
  #delegationKey(handle: ActiveSession): string { return `${handle.liveSessionId}-${handle.generation}`; }

  /**
   * S5: the honest end of a backend turn. One typed disposition, `turn_failed` with the provider's own code, and
   * the open calls of the turn closed, so no ledger entry and no orb state keeps owing a reply the backend will
   * not send. She then says one honest line through the progress-speech path. A backend turn failure is not a
   * transport failure, so nothing is rebuilt; if her line never becomes audible, the turn is settled failed
   * rather than left owing, and the owner's S2 recovery starts the retry.
   */
  #turnFailed(handle: ActiveSession, generation: number, reason: TurnFailedReason): void {
    if (this.#settled(handle) || generation !== handle.generation) return;
    const failedAt = this.#now();
    hostLogEvent({ event: 'turn_failed', reason });
    // The turn is over: every call it left open is closed here, never still in flight in the projection.
    for (const id of [...handle.pendingCallIds]) {
      handle.callAborts.get(id)?.abort();
      handle.callAborts.delete(id);
      handle.pendingCallIds.delete(id);
      handle.pendingCalls.delete(id);
      handle.callStartedAt.delete(id);
      handle.exec.delete(id);
    }
    handle.thinking = false;
    handle.awaitingAnswer = false;
    handle.answerAt = undefined;
    this.#cancelTimers(handle);
    // C-TURN8: a failed turn earns no correction for what it never said.
    this.#resetClaimCheck(handle);
    this.#cancelWatchdog(handle);
    this.#noteState(handle, 'tool');
    if (typeof handle.session.sendCommentary === 'function') {
      try { handle.session.sendCommentary!({ text: TURN_FAILED_LINE }); } catch { /* an ended transport settles below */ }
    }
    this.#armIdle(handle, this.#profile.limits.idleMs, 'turn_failed');
    this.#schedule(() => {
      if (this.#settled(handle) || generation !== handle.generation) return;
      // She spoke the line: the turn is answered, and the session carries on from it.
      if (handle.lastModelAudioAt !== undefined && handle.lastModelAudioAt >= failedAt) return;
      this.#settle(handle, { state: 'failed', code: 'backend_failed' }, false, 'ended', null);
    }, TURN_FAILED_GRACE_MS);
  }

  #cancelTimers(handle: ActiveSession): void {
    handle.delegationTimer?.cancel(); handle.delegationTimer = undefined;
  }

  /** C-TURN8: a turn boundary carries no claim over, spends no correction and leaves no timer armed. */
  #resetClaimCheck(handle: ActiveSession): void {
    handle.claimTimer?.cancel(); handle.claimTimer = undefined;
    handle.claimText = ''; handle.claimToolSeen = false; handle.claimCorrected = false;
  }

  /**
   * C-TURN8: a response that announced a lookup completes, so its call has CLAIM_WITHOUT_CALL_MS to start. A
   * call anywhere in this owner turn silences it, as does a correction already sent, the mute, and the
   * owner's own speech. The ledger of what she said is consumed here, so a response is judged once.
   */
  #armClaimCheck(handle: ActiveSession, sequence: number): void {
    const claim = announcesLookup(handle.claimText) || /^\s*(?:checking|on it|one sec)[.!…]*\s*$/iu.test(handle.claimText);
    handle.claimText = '';
    handle.claimTimer?.cancel(); handle.claimTimer = undefined;
    if (!claim || handle.claimCorrected || handle.claimToolSeen || handle.muted) return;
    handle.claimTimer = this.#schedule(() => {
      handle.claimTimer = undefined;
      if (this.#settled(handle) || handle.claimToolSeen || handle.inputFinal === false || handle.muted) return;
      handle.claimCorrected = true;
      hostLogEvent({ event: 'live_claim_without_call', sequence, ms: CLAIM_WITHOUT_CALL_MS });
      try { handle.session.sendText({ text: hostNote(CLAIM_WITHOUT_CALL_LINE) }); } catch { /* a closed transport settles on its own */ }
    }, CLAIM_WITHOUT_CALL_MS);
  }

  #armDelegationDeadline(handle: ActiveSession): void {
    handle.delegationTimer?.cancel();
    handle.delegationTimer = undefined;
    if (this.#profile.provider !== 'openai') return;
    handle.delegationTimer = this.#schedule(() => this.#delegationDeadline(handle), DELEGATION_DEADLINE_MS);
    handle.delegationTimer.unref?.();
  }

  /** S4a: a delegation open past its deadline gets one receipt and no session rebuild. */
  #delegationDeadline(handle: ActiveSession): void {
    handle.delegationTimer = undefined;
    if (this.#settled(handle) || handle.rebuilding || !handle.awaitingAnswer) return;
    // A nested response that finished the answer is a terminal event, so only silence past the answer is a stall.
    if (handle.lastModelAudioAt !== undefined && handle.lastModelAudioAt > (handle.answerAt ?? 0)) return;
    // S4a-R2 (b): diagnosis only, escalation stays S2's.
    hostLogEvent({ event: 'gptlive_delegation_stalled', ms: Math.max(0, this.#now() - (handle.answerAt ?? this.#now())) });
    if (handle.pendingCallIds.size > 0) return;
    // #660: a stall with no call in flight is a result the model never said, which the host hands it once, or
    // nothing at all, which makes the owner's next status answer the host's to give rather than the model's belief.
    if (handle.unspoken !== undefined && handle.unspokenDelivered !== true) { void this.#deliverUnspoken(handle); return; }
    handle.hostStatusNote = true;
  }

  /** S4a: a bounded wait on tool work that resolves to `timeout` instead of running past the host ceiling.
   *  `late` hears a callback that landed after the settlement, which is a receipt and never a second output. */
  #withCeiling<T>(work: Promise<T>, late: (outcome: 'completed' | 'failed') => void): Promise<T | 'timeout'> {
    return new Promise<T | 'timeout'>((resolve, reject) => {
      let settled = false;
      const timer = this.#schedule(() => { settled = true; resolve('timeout'); }, TOOL_CEILING_MS);
      timer.unref?.();
      void work.then(
        value => { timer.cancel(); if (settled) late('completed'); else resolve(value); },
        error => { timer.cancel(); if (settled) late('failed'); else reject(error instanceof Error ? error : new Error('tool_failed')); },
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
    // The owner's mute suspends the debt: an answer owed to a muted session is not a stall.
    if (handle.muted) { this.#cancelWatchdog(handle); return; }
    // A tool call in flight owns the silence through the dead-air path: never two timers on one silence.
    if (handle.pendingCallIds.size > 0) { this.#cancelWatchdog(handle); return; }
    // #538: the audible debt clock owns an owed answer that a tool output started. Its clock never slides, so the
    // sliding watchdog stands down for exactly that silence and takes no second timer on it.
    if (handle.debtSince !== undefined) { this.#cancelWatchdog(handle); return; }
    // One record per phase change: a streaming reply refreshes the clock on every chunk and must not write a
    // receipt per chunk into the rotating host log.
    const wasArmed = handle.watchdogPhase === 'armed';
    handle.watchdogTimer?.cancel();
    if (handle.watchdogSince === undefined) { handle.watchdogSince = this.#now(); handle.watchdogSinceTool = false; }
    handle.watchdogPhase = 'armed';
    if (!wasArmed) hostLogEvent({ event: 'live_watchdog', phase: 'armed', turnAgeMs: this.#now() - handle.watchdogSince, generation: handle.generation, sinceTool: handle.watchdogSinceTool === true });
    this.#scheduleWatchdog(handle, RESPONSE_WATCHDOG_NUDGE_MS, handle.generation, 'nudge');
  }

  #scheduleWatchdog(handle: ActiveSession, delayMs: number, generation: number, step: 'nudge' | 'recover'): void {
    handle.watchdogTimer = this.#schedule(() => {
      if (this.#settled(handle) || generation !== handle.generation) return;
      if (handle.pendingCallIds.size > 0) return;
      // C-REBUILD8: a sentence still being spoken owns the silence. A non-final transcript younger than the
      // speaking hold means his words are not finished, so neither the dead-air rung nor the recovery speaks or
      // rebuilds inside that sentence; the clock restarts at his final fragment (the final transcription arms
      // this watchdog again). No timer value moves: only the moment the silence begins is judged.
      if (handle.inputFinal !== true && handle.inputAt !== undefined && this.#now() - handle.inputAt < SPEAKING_HOLD_MS) {
        this.#scheduleWatchdog(handle, delayMs, generation, step);
        return;
      }
      const turnAgeMs = this.#now() - (handle.watchdogSince ?? this.#now());
      const sinceTool = handle.watchdogSinceTool === true;
      if (step === 'nudge') {
        if (handle.watchdogPhase === 'nudged') return;
        // C-RECOVERY (d): the owner's last words were "Okay", not a question, so the silence after them is the
        // call being done talking, not a stalled answer. The turn closes and the watchdog never spends a rebuild.
        if (this.#bareAcknowledgement(handle.liveSessionId)) {
          this.#closeTurn(handle, 'completed', 'silent');
          this.#cancelWatchdog(handle);
          hostLogEvent({ event: 'live_watchdog', phase: 'closed', turnAgeMs, generation, sinceTool });
          return;
        }
        // #591: no tool result, no model output (audible or written) and no owner words since the model last
        // spoke means nothing asked for this turn, so the watchdog closes it and leaves the session listening
        // instead of nudging a reply nobody asked for.
        if (handle.answerAt === undefined && handle.firstAudioAt === undefined && !handle.modelTextSinceOpen
          && !this.#ownerWordsSinceModelOutput(handle.liveSessionId)) {
          this.#closeTurn(handle, 'completed', 'silent');
          this.#cancelWatchdog(handle);
          hostLogEvent({ event: 'live_watchdog', phase: 'closed', turnAgeMs, generation, sinceTool });
          return;
        }
        // One stall receipt per nudged deadline: how long the answer has been owed and how long since any
        // audible output. Only the answer's own audio re-arms it, so a fill frame never writes a false healthy.
        // The owed answer is the tool result's own bookkeeping, so progress speech defers the clock without
        // erasing the obligation (amendment A).
        const rungNamedThisSilence = handle.deadAirNudgedAt !== undefined
          && this.#now() - handle.deadAirNudgedAt < RESPONSE_WATCHDOG_NUDGE_MS;
        if (handle.answerAt !== undefined && handle.debtSince === undefined && !rungNamedThisSilence) {
          // C-DEADAIR: while the audible death clock owns this silence (#armDebt stands the sliding watchdog down),
          // the debt rung is the one nudge. A second one here named the same wait twice and made the owner's first
          // audible recovery look like two.
          hostLogEvent({ event: 'live_dead_air', msSinceTool: Math.max(0, this.#now() - (handle.answerAt ?? this.#now())),
            msSinceAudible: handle.lastModelAudioAt === undefined ? null : Math.max(0, this.#now() - handle.lastModelAudioAt) });
          hostLogEvent({ event: 'live_dead_air_nudge', elapsedMs: DEAD_AIR_NUDGE_MS });
          // O1b-A (D12-3): a turn that never became audible is a typed stall, with the age it reached and what the
          // watchdog could see of it, so it is a receipt instead of an absence.
          const stalledTurn = handle.connection.turnId;
          if (stalledTurn !== undefined) {
            this.#receipt(handle, 'live.dead_air_stalled', { turnId: stalledTurn }, {
              stalledAt: this.#now(), turnAgeMs, anyAudio: handle.firstAudioAt !== undefined, inaudibleMs: Math.round(handle.inaudibleMs),
            });
          }
        }
        // VOICE-R4 / C-LIVE: dead air stays silent on every provider: a "Continue." user message is a fake owner turn.
        handle.watchdogPhase = 'nudged';
        hostLogEvent({ event: 'live_watchdog', phase: 'nudged', turnAgeMs, generation, sinceTool });
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
    // #538 R4: the response the provider has announced, from the events it already surfaces. An announced response
    // holds the debt rung so an answer in flight is never closed under it.
    if (type === 'modelTurnStarted' || type === 'modelText' || type === 'outputTranscription' || type === 'audio') {
      // C-DEADAIR: the provider's own latency is out of the host's hands, so it is measured apart from the wait the
      // owner hears: the first announced response after an owed answer stamps owner final to response to first audio.
      if (handle.responseInProgress !== true) handle.responseCreatedAt = this.#now();
      handle.responseInProgress = true;
      // C-DEADAIR: text the owner cannot hear, written while an answer is owed, is what the response-end rescue reads.
      if (handle.debtSince !== undefined && (type === 'modelText' || type === 'outputTranscription')) handle.debtTextSeen = true;
    }
    // #538: the audible debt clock clears on what the owner heard or did, never on what the model typed.
    if (type === 'audio') this.#clearDebt(handle, 'audible');
    if (type === 'interrupted') { handle.responseInProgress = false; handle.debtBargeIn = true; this.#clearDebt(handle, 'owner_barge_in'); }
    if (type === 'inputTranscription' && event.finished === true) {
      handle.debtBargeIn = true; this.#clearDebt(handle, 'owner_barge_in');
      // #660: the owner is asking where it stands and a stalled delegation left nothing running, so the host's own
      // truth goes in front of the model through the one note channel the voice session already has.
      if (handle.hostStatusNote === true && handle.pendingCallIds.size === 0) {
        // A refused note leaves the flag armed, so the owner's next question tries the host's truth again; a
        // transport with no commentary channel cannot carry it at all, and the flag retires there.
        let refused = false;
        try {
          const note = handle.session.sendCommentary;
          refused = typeof note === 'function' && note.call(handle.session, { text: NO_LOOKUP_RUNNING_NOTE }) === false;
        } catch { refused = true; }
        handle.hostStatusNote = refused;
      }
    }
    if (type === 'turnComplete' || type === 'turnFailed') {
      handle.responseInProgress = false;
      // C-DEPTH item 5 (W10-R13): the response just ended, which is the first boundary a rebuild may use.
      void this.#researchRebuildAtBoundary(handle);
      // The response ended: an answer that was heard ends the debt, and one that ended without audio fires the rung
      // the deferral held, which is the ruling's own order.
      if (handle.debtSince !== undefined) {
        if (handle.lastModelAudioAt !== undefined && handle.lastModelAudioAt >= handle.debtSince) this.#clearDebt(handle, 'turn_end');
        // C-DEADAIR: a response that ended after writing text and never made a sound is the 2026-10-27 shape (112
        // response tokens, nothing above -120 dB on the Mac). The model has nothing more to say in that response, so
        // the held result goes out now instead of waiting out the ladder.
        else if (handle.debtTextSeen === true) void this.#deliverUnspoken(handle).catch(() => { /* the rung settles its own failure */ });
        else this.#fireDeferredRung(handle);
      }
    }
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

  /**
   * C-WATCH: the model has not had the rung's silence after a tool result yet, so a mute now is not a mute. A result
   * handed back and judged inside the eight seconds any other tool output gets is a wait it never had.
   */
  #toolWaitUnjudged(handle: ActiveSession): boolean {
    return handle.lastToolResultAt !== undefined && this.#now() - handle.lastToolResultAt < AUDIBLE_DEBT_RUNG_MS;
  }

  async #watchdogRecover(handle: ActiveSession, generation: number, turnAgeMs: number): Promise<void> {
    if (this.#settled(handle) || generation !== handle.generation || handle.pendingCallIds.size > 0) return;
    const previous = handle.watchdogRecoveredAt;
    // W3: the wait being judged started here, so a weak spell before it cannot relabel this timeout.
    const waitSince = handle.watchdogSince;
    // C-WATCH: which wait this was survives the cancel below, so the receipt can say it.
    const waitedAfterTool = handle.watchdogSinceTool === true;
    this.#cancelWatchdog(handle);
    // W4-R1: a second mute inside the window may end the call only when the model had the rung's silence after the
    // last tool result. Otherwise the step is a rebuild, exactly the first-mute path, and the call keeps going.
    if (previous !== undefined && this.#now() - previous < RESPONSE_WATCHDOG_WINDOW_MS && !this.#toolWaitUnjudged(handle)) {
      // A second mute inside the window would loop on the same broken provider: end the call honestly. When the
      // link was weak during this wait it is the internet, not the model, and the owner is told so.
      const weakAt = handle.session.diagnostics?.()?.connection?.weakAt;
      const starved = weakAt !== undefined && waitSince !== undefined && weakAt >= waitSince;
      hostLogEvent({ event: 'live_watchdog', phase: 'settled', turnAgeMs, generation, sinceTool: waitedAfterTool,
        ...(handle.lastToolResultAt === undefined ? {} : { msSinceToolResult: Math.max(0, this.#now() - handle.lastToolResultAt) }) });
      this.#settle(handle, { state: 'failed', code: starved ? 'uplink_starved' : 'model_unresponsive' }, false, 'ended', null);
      return;
    }
    // C-CONTINUITY R-10: the phase names what really happened, so `recovering` is written before the reopen and
    // `recovered` only once the provider says the new session is live.
    hostLogEvent({ event: 'live_watchdog', phase: 'recovering', turnAgeMs, generation, sinceTool: waitedAfterTool });
    if (await this.#recoverFromDrop(handle, undefined, true, 'model_mute')) {
      hostLogEvent({ event: 'live_watchdog', phase: 'recovered', turnAgeMs, generation, sinceTool: waitedAfterTool });
    }
  }

  /**
   * O1b-A: the receipt door an adapter is handed. It binds the session, this connection's epoch and the turn the
   * host has open, so the adapter names only its own response and call keys.
   */
  #tracePort(liveSessionId: string, connection: ActiveSession['connection']): LiveTracePort {
    return liveTracePort({
      port: this.#store, liveSessionId, connectionEpoch: connection.epoch,
      turnId: () => connection.turnId,
      onReject: (code, kind) => {
        hostLogEvent({ event: 'live_trace_rejected', kind, code });
        const handle = this.#active.get(liveSessionId);
        if (handle) this.#diagnosticFailure(handle,'trace_write_failed');
      },
    });
  }

  /** O1b-A: one host receipt. A refusal is a typed host.log line, never an exception in the turn that wrote it. */
  #receipt<K extends TraceEventKind>(handle: ActiveSession, kind: K, ids: Omit<TraceEventIds, 'liveSessionId' | 'connectionEpoch'>, detail: TraceDetailMap[K]): void {
    try {
      record(this.#store, kind, { ...ids,...(ids.callKey === undefined ? {} : { callKey: scopedTraceKey(handle.liveSessionId,handle.connection.epoch,'call',ids.callKey) }),liveSessionId: handle.liveSessionId,connectionEpoch: handle.connection.epoch }, detail);
    } catch (error) {
      hostLogEvent({ event: 'live_trace_rejected', kind, code: error instanceof TraceRecordError ? error.code : 'record_failed' });
      this.#diagnosticFailure(handle,'trace_write_failed');
    }
  }

  #diagnosticFailure(handle: ActiveSession, reason: DiagnosticLoss): void {
    try { this.#store.transaction(tx => markDiagnosticLoss(tx,handle.liveSessionId,reason)); }
    catch { handle.pendingDiagnosticLoss = true; }
  }

  /** The turn opens at the owner-utterance boundary O1a defined: the first transcription of what she said. */
  #openTurn(handle: ActiveSession): void {
    // A fresh owner turn restarts the invalid-argument count, so an earlier turn's repeats never shorten this one.
    handle.invalidAttempts = new Map();
    handle.lookupAckAt = undefined;
    // R7/R8: the owner spoke before the dropped-line opener became audible, so it is cancelled; the
    // provider's barge-in (interrupted) or its turn end frees the answer, never a late opener frame.
    if (handle.dropOpener) { if (openerCancelled(true, handle.spokenThisTurn)) handle.dropResponse = true; handle.dropOpener = false; }
    const connection = handle.connection;
    // #451 H12: a second owner utterance arrives before the provider's turnComplete, so the turn it
    // replaces is closed here rather than orphaned open forever. Only a killed session leaves one open.
    const supersedes = connection.turnId;
    if (supersedes !== undefined) this.#closeTurn(handle, 'superseded');
    handle.modelTextSinceOpen = false;
    // L-04: her own words restart the silence, so no earlier model frame of this turn anchors the debt clock.
    handle.turnAudioAt = undefined;
    this.#cancelTimers(handle);
    // C-TURN8: a new owner turn is a fresh correction budget.
    this.#resetClaimCheck(handle);
    handle.progressCallIds.clear();
    handle.exec.clear();
    handle.liveSteps = [];
    handle.liveStepItems.clear();
    connection.turnIndex += 1;
    const turnId = `${handle.liveSessionId}:t${connection.turnIndex}`;
    connection.turnId = turnId;
    this.#receipt(handle, 'turn.opened', { turnId }, {
      origin: 'owner', turnIndex: connection.turnIndex, openedAt: this.#now(), monoMs: hostMonotonicMs(),
      ...(supersedes === undefined ? {} : { supersedesTurnId: supersedes }),
      ...(connection.turnIndex > 1 ? { attributionUncertain: true } : {}),
    });
  }

  /** L8-11: one content-free receipt per owner turn when two of his words land over her audible answer. The
   *  provider owns barge-in and the host never cuts her (lux 90488, ruling W1-R1), so `cut` is false. */
  #noteOverlap(handle: ActiveSession, text: string): void {
    if (handle.overlapReceipted === true) return;
    handle.overlapWords = (handle.overlapWords ?? 0) + text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
    if (handle.overlapWords < OVERLAP_RECEIPT_WORDS) return;
    const turnId = handle.connection.turnId;
    if (turnId === undefined) return;
    handle.overlapReceipted = true;
    const at = this.#now();
    this.#receipt(handle, 'owner.overlap', { turnId }, { at, words: handle.overlapWords,
      msSinceAudible: handle.lastModelAudioAt === undefined ? 0 : Math.max(0, at - handle.lastModelAudioAt), cut: false });
  }

  /** L8-Q01/Q05: the store-side link of one research call. Owner text goes to the content table only. */
  #linkResearchCall(handle: ActiveSession, host: HostContext, callId: string, question: string | undefined, response: JsonObject, firstStep: number | undefined): void {
    const researchId = typeof response['researchId'] === 'string' && response['researchId'].length > 0 ? response['researchId'] : undefined;
    const callKey = scopedTraceKey(handle.liveSessionId, handle.connection.epoch, 'call', callId);
    try {
      recordCallLink(this.#store, { callKey, ...(researchId === undefined ? {} : { researchId }),
        ...(firstStep === undefined ? {} : { canonicalRunId: host.runId, canonicalExecutionId: `${host.runId}:${firstStep}:0` }) });
      if (researchId !== undefined && question !== undefined && question.trim().length > 0) recordResearchText(this.#store, { researchId, callKey, kind: 'question', text: question }, this.#now());
    } catch (error) {
      hostLogEvent({ event: 'live_trace_rejected', kind: 'call.linked', code: error instanceof TraceRecordError ? error.code : 'unknown' });
      this.#diagnosticFailure(handle, 'trace_write_failed');
    }
  }

  /** C-PITCH: close the voice meter for the response that just ended, whether the provider completed the turn or
   *  the owner barged in on it. An interrupted response played audio, so it is measured too, with its own closed
   *  id, and its samples never roll into the next response. */
  #logVoiceProfile(handle: ActiveSession, generation: number): void {
    const voice = handle.voiceProfile?.finish();
    if (!voice) return;
    handle.voiceResponses = (handle.voiceResponses ?? 0) + 1;
    const responseId = `resp-${handle.voiceResponses}`;
    const { profile, shift } = voice;
    hostLogEvent({ event: 'live_voice_profile', liveSessionId: handle.liveSessionId, generation, responseId,
      audibleMs: profile.audibleMs, f0Hz: profile.f0Hz, f0P10Hz: profile.f0P10Hz, f0P90Hz: profile.f0P90Hz,
      voicedRatio: profile.voicedRatio, rmsDbfs: profile.rmsDbfs });
    if (shift) hostLogEvent({ event: 'live_voice_shift', liveSessionId: handle.liveSessionId, generation, responseId,
      ratio: shift.ratio, medianHz: shift.medianHz, sessionMedianHz: shift.sessionMedianHz });
  }

  #closeTurn(handle: ActiveSession, closeReason: TurnCloseReason, outcome?: TurnOutcome): void {
    const turnId = handle.connection.turnId;
    if (turnId === undefined) return;
    handle.connection.turnId = undefined;
    this.#receipt(handle, 'turn.closed', { turnId }, {
      closedAt: this.#now(), closeReason, ...(outcome === undefined ? {} : { outcome }),
    });
  }

  /** The words Naya had produced but the owner never heard: kept apart, so a later turn can offer to finish. */
  #keepUnheard(handle: ActiveSession, tx: Transaction): void {
    const row = tx.get(
      "SELECT group_concat(text,'') AS text FROM live_journal WHERE live_session_id=? AND kind='outputTranscription' AND journal_id > COALESCE((SELECT MAX(journal_id) FROM live_journal WHERE live_session_id=? AND kind='outputTranscription' AND finished=1),0)",
      [handle.liveSessionId, handle.liveSessionId]);
    const text = String(row?.['text'] ?? '').trim();
    if (!text.length) return;
    this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify({ event: 'unheard', text }) }, 'continuity', tx);
  }

  #continuity(handle: ActiveSession, event: 'rebuilding' | 'resumed', reason?: string): void {
    const journalSequence = this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify({ event, ...(reason ? { reason } : {}) }) }, 'continuity');
    if (journalSequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', null); return; }
    this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'continuity', event, ...(reason ? { reason } : {}), sequence: null, journalSequence, text: null, finished: null, value: null } });
  }

  /** The conversation this owner is in: app owned, persisted, and unmoved by mute, expiry, restart or midnight. */
  #conversationInTx(tx: Transaction, assistantId: string): string {
    const row = tx.get('SELECT conversation_id FROM live_conversations WHERE owner_assistant_id=?', [assistantId]);
    if (row) return String(row['conversation_id']);
    const previous = tx.get('SELECT c.conversation_id AS conversation_id FROM live_session_conversations c JOIN live_sessions s ON s.live_session_id=c.live_session_id WHERE s.owner_assistant_id=? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1', [assistantId]);
    const conversationId = previous ? String(previous['conversation_id']) : randomUUID();
    tx.run('INSERT INTO live_conversations(owner_assistant_id,conversation_id,started_at) VALUES(?,?,?)', [assistantId, conversationId, this.#now()]);
    return conversationId;
  }

  /** An explicit new conversation. Nothing ordinary does this, so a topic change keeps the same id. */
  newConversation(): string {
    this.#guardOpen();
    const conversationId = randomUUID();
    this.#store.transaction(tx => tx.run(
      'INSERT INTO live_conversations(owner_assistant_id,conversation_id,started_at) VALUES(?,?,?) ON CONFLICT(owner_assistant_id) DO UPDATE SET conversation_id=excluded.conversation_id,started_at=excluded.started_at',
      [this.#store.assistantId, conversationId, this.#now()]));
    return conversationId;
  }

  /** The conversation a persisted session belongs to; a session older than the table joins the current one. */
  #conversationOf(liveSessionId: string): string {
    return this.#store.transaction(tx => {
      const row = tx.get('SELECT conversation_id FROM live_session_conversations WHERE live_session_id=?', [liveSessionId]);
      if (row) return String(row['conversation_id']);
      const conversationId = this.#conversationInTx(tx, this.#store.assistantId);
      tx.run('INSERT OR IGNORE INTO live_session_conversations(live_session_id,conversation_id) VALUES(?,?)', [liveSessionId, conversationId]);
      return conversationId;
    });
  }

  /** Seed for a new provider session: the conversation's recent exchanges, never half an exchange. */
  /** L19: the previous call in this conversation ended in a drop inside the window, so its last answer was never heard. */
  #deadLineBefore(liveSessionId: string): boolean {
    const now = this.#now();
    const conversationId = this.#conversationOf(liveSessionId);
    return this.#store.transaction(tx => {
      const row = tx.get(
        `SELECT s.terminal_at AS at,s.terminal_outcome AS outcome FROM live_sessions s
           JOIN live_session_conversations c ON c.live_session_id=s.live_session_id
          WHERE c.conversation_id=? AND s.live_session_id<>? AND s.lifecycle='terminal' AND s.terminal_at IS NOT NULL
          ORDER BY s.terminal_at DESC,s.rowid DESC LIMIT 1`, [conversationId, liveSessionId]);
      if (!row || row['at'] === null || row['at'] === undefined) return false;
      if (now - Number(row['at']) > DEAD_LINE_WINDOW_MS) return false;
      try {
        const outcome = JSON.parse(String(row['outcome'])) as { state?: unknown; code?: unknown };
        return outcome.state === 'failed' && DEAD_LINE_CODES.has(String(outcome.code));
      } catch { return false; }
    });
  }

  /** Whether this session already carries owner speech, which the opener answers instead of the drop line. */
  #ownerSpoke(liveSessionId: string): boolean {
    return this.#store.transaction(tx => !!tx.get("SELECT journal_id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' LIMIT 1", [liveSessionId]));
  }

  /** #591: whether the owner said words since the model last spoke. Ambient sound and VAD edges say nothing, so a
   *  finalized transcript with no text in it is not a question and owes no answer. */
  #ownerWordsSinceModelOutput(liveSessionId: string): boolean {
    return this.#store.transaction(tx => !!tx.get(
      "SELECT journal_id FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND TRIM(COALESCE(text,''))<>''"
      + " AND journal_id > COALESCE((SELECT MAX(journal_id) FROM live_journal WHERE live_session_id=? AND kind='outputTranscription'),0) LIMIT 1",
      [liveSessionId, liveSessionId]));
  }

  /** C-RECOVERY (d): whether the owner's latest words since the model last spoke are a bare acknowledgement. Such
   *  a turn answers nothing, so the silence after it is not a stalled answer and no rebuild may be spent on it. */
  #bareAcknowledgement(liveSessionId: string): boolean {
    const row = this.#store.transaction(tx => tx.get(
      "SELECT text FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND TRIM(COALESCE(text,''))<>''"
      + " AND journal_id > COALESCE((SELECT MAX(journal_id) FROM live_journal WHERE live_session_id=? AND kind='outputTranscription'),0)"
      + " ORDER BY journal_id DESC LIMIT 1", [liveSessionId, liveSessionId]));
    return isBareAcknowledgement(typeof row?.['text'] === 'string' ? String(row['text']) : '');
  }

  /** C-REBUILD8: whether the model's own last response was a filler the owner already heard before it went mute
   *  ("One second."). Such a response answers the turn it acknowledged no more than the owner's "Okay" does, so
   *  the silence after it is a model mute on the question underneath and never the ambient case. */
  #ackAnsweredOwner(liveSessionId: string): boolean {
    const rows = this.#store.transaction(tx => tx.all(
      "SELECT kind,text FROM live_journal WHERE live_session_id=? AND kind IN ('inputTranscription','outputTranscription')"
      + ' ORDER BY journal_id DESC LIMIT 400', [liveSessionId]));
    // The model's newest run of speech, the way the seed reads a turn: every fragment back to the owner's words.
    let index = 0;
    const said: string[] = [];
    while (index < rows.length && String(rows[index]!['kind']) === 'outputTranscription') { said.unshift(String(rows[index]!['text'] ?? '')); index += 1; }
    if (said.length === 0 || !isAckOnlyResponse(said.join(' '))) return false;
    // The owner spoke before it, so that turn is the question this filler never answered.
    for (; index < rows.length && String(rows[index]!['kind']) === 'inputTranscription'; index += 1) {
      if (String(rows[index]!['text'] ?? '').trim() !== '') return true;
    }
    return false;
  }

  #seedHistory(liveSessionId: string, inputClass: DataClass, deadLine = false): { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number } {
    const conversationId = this.#conversationOf(liveSessionId);
    const rows = this.#store.transaction(tx => tx.all(
      "SELECT j.kind AS kind,j.text AS text,j.finished AS finished FROM live_journal j JOIN live_sessions s ON s.live_session_id=j.live_session_id JOIN live_session_conversations c ON c.live_session_id=s.live_session_id WHERE c.conversation_id=? AND j.kind IN ('inputTranscription','outputTranscription') AND j.text IS NOT NULL ORDER BY s.created_at, s.rowid, j.journal_id",
      [conversationId]));
    const runs: { role: 'user' | 'model'; text: string }[] = [];
    let role: 'user' | 'model' | undefined; let pending = '';
    // L14/LIVE2-R6 F4: a tag can split across deltas, so the assembled run is stripped once more.
    const flush = () => { const text = stripNonLexicalTags(pending).trim(); if (role !== undefined && text.length) runs.push({ role, text }); pending = ''; role = undefined; };
    for (const row of rows) {
      const next: 'user' | 'model' = String(row['kind']) === 'inputTranscription' ? 'user' : 'model';
      if (role !== undefined && role !== next) flush();
      role = next; pending += String(row['text'] ?? '');
      if (Number(row['finished']) === 1) flush();
    }
    // An unfinished model run is speech the owner never heard, so it never becomes history here.
    if (role === 'model') pending = '';
    flush();
    // C-RECOVERY (a): a seed turn is one side of a finished-turn boundary, so two runs that the finished marks
    // left in the same role are one turn, never two adjacent messages of the same role.
    const merged: { role: 'user' | 'model'; text: string }[] = [];
    for (const run of runs) {
      const previous = merged[merged.length - 1];
      if (previous === undefined || previous.role !== run.role) { merged.push({ role: run.role, text: run.text }); continue; }
      previous.text = `${previous.text} ${run.text}`;
    }
    const turns = merged.map(run => ({ role: run.role, text: run.text, dataClass: inputClass }));
    // L19: the dead call's last answer was never heard, so the seed closes it as heard instead of leaving it open.
    if (deadLine && turns.length > 0 && turns[turns.length - 1]!.role === 'model') turns.push({ role: 'user', text: LIVE_DROPPED_LINE_MARK, dataClass: inputClass });
    return { turns, chars: turns.reduce((sum, turn) => sum + turn.text.length, 0) };
  }

  /**
   * C-CONTINUITY item 3: the one seed every `fresh_seeded` open uses. The transcript is the call's own history
   * under `SEED_CHAR_LIMIT`, and the cumulative research ledger rides as a distinct host section after it, so a
   * rebuild keeps the conversation instead of replacing it with the one batch that crossed the threshold.
   */
  #seedWithLedger(liveSessionId: string, inputClass: DataClass, ledger: string | undefined, deadLine = false, transcript = true): {
    turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number;
    transcriptChars: number; ledgerChars: number; condensed: boolean } {
    const seed: { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number } = transcript
      ? this.#seedHistory(liveSessionId, inputClass, deadLine) : { turns: [], chars: 0 };
    const body = typeof ledger === 'string' ? ledger.trim() : '';
    const text = body === '' ? undefined : `${HOST_LEDGER_HEADER}\n${body}`;
    const appended = text === undefined ? [] : [{ role: 'user' as const, text, dataClass: inputClass }];
    const fitted = fitSeedTurns(seed.turns, appended);
    return { turns: fitted.turns, chars: fitted.chars, transcriptChars: seed.chars, ledgerChars: body.length, condensed: fitted.condensed };
  }

  /** A provider session window ended: an attended call takes a fresh seeded window, an unattended one ends where it is. */
  #sessionWindowEnded(handle: ActiveSession): void {
    if (this.#attended(handle)) { void this.#continueSession(handle); return; }
    this.#settle(handle, { state: 'failed', code: 'session_timeout' }, false, 'ended', null);
  }

  /** Only an attended call takes another provider window; a caller who already left never holds one open. */
  /** C-DEPTH item 5: the last research question of a call, so the rebuild ledger can name the entities asked. */
  readonly #lastResearchQuestion = new Map<string, string>();

  /**
   * C-DEPTH item 5 (W10-R13): the rebuild is spent at the response boundary and never from the batch that filled
   * the conversation. It is deferred, never dropped: while the assistant is streaming, a response is pending, a
   * barge in is open or a recovery is in flight, the seed waits for the next boundary. The rebuild itself is the
   * existing fresh_seeded recovery, with the extractive ledger as one turn instead of the raw tool items.
   */
  async #researchRebuildAtBoundary(handle: ActiveSession): Promise<void> {
    const ledger = handle.researchRebuildSeed;
    if (ledger === undefined) return;
    if (handle.rebuilding || handle.responseInProgress || handle.debtBargeIn || handle.pendingCallIds.size > 0) return;
    if (this.#settled(handle)) return;
    const now = this.#now();
    const boundary: ResearchBoundary = {
      // W10-R27/Z4: the real speaking fact, never a literal, so a rebuild never cuts audio.
      assistantAudioStreaming: handle.speaking, responsePending: Boolean(handle.responseInProgress),
      bargeIn: Boolean(handle.debtBargeIn), toolInFlight: handle.pendingCallIds.size > 0,
    };
    // W10-R15 P2: the decision is one function, so a deferral keeps both the seed and the count for the next
    // boundary and only the branch that really rebuilds resets them.
    const step = researchRebuildStep(handle.researchRetention, ledger.length, boundary,
      handle.deadlineAt - now, handle.idleAt - now);
    if (step.action !== 'rebuild') return;
    const prior = handle.researchRetention;
    handle.researchRebuildSeed = undefined;
    handle.researchRetention = step.retention;
    const seed = this.#seedWithLedger(handle.liveSessionId, handle.inputClass, ledger);
    hostLogEvent({ event: 'research_context_rebuild', retainedChars: prior.retainedChars, ledgerChars: seed.ledgerChars,
      seedTranscriptChars: seed.transcriptChars, rebuilds: step.retention.rebuilds,
      totalContextChars: handle.request.system.text.length + seed.chars + handle.contextToolChars });
    const remaining = handle.deadlineAt - now;
    const idle = handle.idleAt - now;
    await this.#openRecovery(handle, 'fresh_seeded', undefined, remaining, idle, remaining, seed, 'research_context');
  }

  /**
   * C-CONTINUITY R-01: the closed trigger a rebuild names. `line_dropped` is no longer the arm everything falls
   * into: a reason this method does not know is a typed error, so a planned rebuild can never be logged as a
   * network one again.
   */
  #rebuildTrigger(handle: ActiveSession, reason: string | null): (typeof LIVE_REBUILD_TRIGGERS)[number] {
    if (reason === 'model_mute') return this.#ownerWordsSinceModelOutput(handle.liveSessionId) || this.#ackAnsweredOwner(handle.liveSessionId) ? 'no_output_after_owner' : 'no_output_after_ambient';
    if (reason === 'research_context') return 'research_context';
    if (reason === 'session_deadline' || reason === 'deadline' || reason === 'session_timeout' || reason === 'idle_timeout'
      || reason === 'handshake_timeout') return 'session_window';
    if (reason === 'line_dropped' || reason === 'transport_error' || reason === 'remote_closed' || reason === 'protocol_error'
      || reason === 'provider_setup_rejected' || reason === 'unsupported_provider' || reason === 'go_away'
      || reason === 'backpressure' || reason === 'event_limit' || reason === 'incoming_limit' || reason === 'outgoing_limit'
      || reason === 'provider_error' || reason === 'closed') return 'line_dropped';
    // A reason outside the adapter's own closed error set is a typed error, never a guess that blames the network.
    throw new TypeError(`live_rebuild_reason_unknown:${String(reason)}`);
  }

  /**
   * C-CONTINUITY R-02/R-10: the cause a rebuild or recovery line carries, always read off the outcome: `network`
   * only when the adapter left a transport receipt, `host` when the host itself chose to rebuild, `provider`
   * otherwise, which is what a mute is.
   */
  #upstreamCause(handle: ActiveSession, reason: string | null): 'host' | 'network' | 'provider' {
    if (reason === 'research_context') return 'host';
    return handle.adapterOutcome?.upstream === undefined ? 'provider' : 'network';
  }

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
  async #openRecovery(handle: ActiveSession, path: 'resume' | 'fresh_seeded', savedHandle: string | undefined, remaining: number, idle: number, window: number, seed: { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number }, reason: string | null, awaitReady = true): Promise<boolean> {
    handle.sessionTimer?.cancel();
    handle.attempts += 1; handle.generation += 1; handle.rebuilding = true; handle.ready = false;
    // C-LOG-ENVELOPE F1: the rebuild opens a new provider session inside the same call, so every later
    // line names the generation it really belongs to instead of the open-time zero.
    setLogContext({ liveSessionId: handle.liveSessionId, generation: handle.generation });
    handle.recoveryRefused = false;
    // #1022 F1: the scheduler this handle carried answered for the generation that just ended.
    handle.researchScheduler = undefined; handle.researchSchedulerGeneration = undefined;
    // #527: a new socket is not the old socket's health. Clearing it here makes the three-strike ceiling
    // count consecutive dead sessions instead of one healthy episode followed by endless retries.
    handle.lastHealthyAt = undefined;
    this.#noteState(handle, 'rebuild');
    handle.lastRecoveryPath = path;
    // #591: a model mute with nothing asked for since the model last spoke rebuilds quietly: no reconnect
    // marker (which is what makes the native shell ring and chime) and no pickup instruction to answer.
    // C-CONTINUITY R-01/R-02: the trigger is the outcome's, never a default arm, and the cause is read off the
    // outcome too: `network` only when a transport receipt exists, `host` for a planned research rebuild, and
    // `provider` for a model that went quiet. A close code and its sanitized reason ride along when there is one.
    const trigger = this.#rebuildTrigger(handle, reason);
    const upstream = handle.adapterOutcome?.upstream;
    const cause = this.#upstreamCause(handle, reason);
    handle.quietRebuild = trigger === 'no_output_after_ambient';
    hostLogEvent({ event: 'live_rebuild', trigger, cause, liveSessionId: handle.liveSessionId, generation: handle.generation,
      ...(upstream === undefined ? {} : { closeCode: upstream.closeCode, closeReason: upstream.closeReason }) });
    this.#cancelSpeakingHold(handle);
    handle.thinking = false; handle.speaking = false;
    this.#store.transaction(tx => tx.run('UPDATE live_sessions SET connection_generation=? WHERE live_session_id=?', [handle.generation, handle.liveSessionId]));
    handle.consumer.dropAudio();
    // C-RECOVERY (c): the old session is closed only once the new one opened, so a provider that refuses the
    // rebuild leaves the call on the session it already had instead of on none.
    const previousSession = handle.session;
    for (const id of handle.pendingCallIds) {
      const tool: LiveToolProjection = { callId: id, name: handle.pendingCalls.get(id) ?? 'unknown', status: 'error', code: 'tool_call_lost_on_resume', markdown: 'Tool call lost when the voice connection resumed.', sources: [] };
      const journalSequence = this.#persist(handle, { type: 'toolResult', sequence: 0, tool }, 'toolResult');
      if (journalSequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', null); return false; }
      this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'toolResult', sequence: null, journalSequence, text: null, finished: null, value: null, tool } });
    }
    handle.pendingCallIds.clear(); handle.pendingCalls.clear(); handle.bargeInCallIds.clear();
    if (!handle.quietRebuild) this.#continuity(handle, 'rebuilding', reason ?? undefined);
    if (this.#settled(handle)) return false;
    // O1b-A: a rebuilt socket is a new connection epoch. Receipts the socket it replaces still emits carry the old
    // epoch and are refused by the store, which is what "a reconnect rejects stale-epoch receipts" means here.
    // L8-Q03: the turn the dead socket was answering is closed under its own epoch, never left open forever.
    if (handle.connection.turnId !== undefined) this.#closeTurn(handle, 'recovered');
    handle.connection = { seq: handle.connection.seq + 1, epoch: `e${handle.connection.seq + 1}`, turnId: undefined, turnIndex: handle.connection.turnIndex };
    handle.deadlineAt = this.#now() + remaining; handle.deadlineMs = Date.now() + remaining;
    // #660: a result that returned unspoken is why this window exists, so the new session opens model-first and
    // speaks as soon as the delivery below lands, instead of waiting for the owner to ask again.
    const unspokenOpening = handle.unspoken !== undefined;
    // C-PICKUP: a model mute is not a dropped line, so a rebuild that owes the owner an answer is told the
    // model went quiet instead of the call coming back. A quiet rebuild owes nothing and keeps its base shape.
    const muteRebuild = reason === 'model_mute' && !handle.quietRebuild;
    // C-REBUILD8: the filler the model filed before it went mute is not the last word the new session inherits.
    // The owner's question under it is, so the pickup answers that question instead of continuing a stale line. A
    // quiet rebuild has no such turn to drop, so its seed is byte-identical.
    if (muteRebuild) {
      const tail = seed.turns.at(-1);
      if (tail !== undefined && tail.role === 'model' && seed.turns.length > 1 && isAckOnlyResponse(tail.text)) {
        seed.turns.pop(); seed.chars = Math.max(0, seed.chars - tail.text.length);
      }
    }
    // C-REBUILD8: a rebuild inherits the conversation, never the call's own opener line. The opener belongs to
    // the session that spoke it, so a stale one is never sent again as new output; the request is rebuilt from a
    // base that carries no line of its own.
    const base = structuredClone(handle.request);
    delete base.openingText;
    const request = path === 'fresh_seeded'
      ? { ...base, history: seed.turns, ...(unspokenOpening
        ? { opening: 'model_first' as const }
        : handle.quietRebuild ? { opening: 'user_first' as const }
          : { openingText: muteRebuild ? LIVE_MUTE_PICKUP : LIVE_RECOVERY_PICKUP }) }
      : { ...base, resumptionHandle: savedHandle as string };
    // #591: a quiet rebuild asks for nothing, so an opener line the call inherited (a silent start after a lost
    // line) is cleared as well as the pickup that was never set.
    if (handle.quietRebuild && !unspokenOpening) delete request.openingText;
    // C-PICKUP: the recovery line names the pickup this request really opens with, never the one its reason
    // implies. A quiet rebuild with nothing asked for sends none, and a mute names the silence.
    handle.recoveryPickup = path === 'resume' ? 'none' : muteRebuild ? 'mute'
      : handle.quietRebuild && !unspokenOpening ? 'quiet' : unspokenOpening ? 'none' : 'connection';
    try {
      handle.session = this.#voice.open(request, {
        signal: handle.abort.signal, deadlineMs: handle.deadlineMs, idleResetMs: this.#profile.limits.idleMs,
        limits: { ...this.#profile.limits, sessionMs: Math.ceil(remaining), idleMs: Math.ceil(idle), handshakeMs: Math.max(1, Math.ceil(Math.min(this.#profile.limits.handshakeMs, window, remaining, idle))) },
        trace: this.#tracePort(handle.liveSessionId, handle.connection),
      });
      handle.openedAt = this.#now(); handle.readyAt = undefined;
      hostLogEvent({ event: 'live_provider_open', liveSessionId: handle.liveSessionId, generation: handle.generation,
        instructionChars: request.system.text.length, seedChars: seed.chars, tools: request.tools?.length ?? 0 });
      void handle.session.ready.catch(() => {}); void handle.session.done.catch(() => {});
      // #660: this session has not been handed the unspoken result yet; the recovery delivers it once ready.
      handle.unspokenDelivered = false;
      this.#observeDiagnostics(handle, handle.session);
      handle.goAwayUntil = undefined;
      // C-RECOVERY (c): the new session exists, so the old one can be closed without ever leaving the call open on none.
      previousSession.close();
    } catch (error) {
      // C-LIVE R2: a synchronous refusal is never swallowed. Its class and a closed message key are logged with the
      // mode and the cause, and the caller decides on the one fresh retry.
      handle.recoveryRefused = true;
      handle.recoveryRefusals = (handle.recoveryRefusals ?? 0) + 1;
      hostLogEvent({ event: 'live_recovery_failed', liveSessionId: handle.liveSessionId, generation: handle.generation, mode: path,
        cause: reason ?? 'none', errorClass: errorClassOf(error), messageKey: messageKeyOf(error), attempt: handle.recoveryRefusals });
      return false;
    }
    handle.sessionTimer = this.#schedule(() => this.#sessionWindowEnded(handle), Math.max(1, Math.ceil(remaining)));
    // #525: a recovery is opened only when the provider says the session is live. A socket that dies before
    // its ready event is a failed attempt that pays its backoff, never an opening that re-enters the loop.
    // A planned window switch is not a recovery, so it keeps the plain open and lets the ready event follow.
    if (!awaitReady) return true;
    const opened = await this.#awaitProviderReady(handle, handle.session);
    if (!opened) return false;
    handle.ready = true;
    // C-CONTINUITY item 6: the new session holds no research payload, so the counter starts again and a seed the
    // previous session never needed is dropped. Only here, after the provider says the session is live: a failed
    // open changes nothing, so the call cannot lose the rebuild it still owes.
    handle.researchRetention = { retainedChars: 0, rebuilds: handle.researchRetention.rebuilds };
    handle.researchRebuildSeed = undefined;
    return true;
  }

  /** The provider's own ready event, or false when this socket died, was refused, or the call settled first. */
  async #awaitProviderReady(handle: ActiveSession, session: LiveVoiceSession): Promise<boolean> {
    const aborted = new Promise<boolean>(resolve => { handle.abort.signal.addEventListener('abort', () => resolve(false), { once: true }); });
    const ready = session.ready.then(() => true, () => false);
    const done = session.done.then(() => false, () => false);
    const verdict = await Promise.race([ready, done, aborted]);
    if (!verdict) return false;
    return !this.#settled(handle) && handle.session === session;
  }

  /** Record one recovery attempt (metadata only): the path, the outcome code, close code and seed size. */
  #logRecovery(handle: ActiveSession, path: 'resume' | 'fresh_seeded', code: string, closeCode: number | null, reason: string | null, seed: { turns: unknown[]; chars: number }): void {
    // C-CONTINUITY R-09: the socket close code and its sanitized reason ride on the recovery line, so the next
    // reader knows how the previous session really ended instead of inferring it from the outcome code alone.
    const closeReason = handle.adapterOutcome?.upstream?.closeReason ?? '';
    hostLogEvent({ event: 'live_recovery', path, attempt: handle.recoveries + 1, code, cause: this.#upstreamCause(handle, reason), closeCode, closeReason, reason, seedTurns: seed.turns.length, seedChars: seed.chars,
      // C-PICKUP: which pickup the rebuilt session was opened with, read off the request that was sent, so a mute
      // is never logged as a drop and a pickup that was never sent is never logged as mute.
      pickup: handle.recoveryPickup ?? 'none',
      msSinceDrop: handle.dropEpisodeAt === undefined ? 0 : Math.max(0, this.#now() - handle.dropEpisodeAt),
      liveSessionId: handle.liveSessionId, generation: handle.generation });
  }

  /**
   * Recover from a dropped connection (R1-R1): reuse the saved handle when it is reusable, else open a
   * fresh seeded setup; a failed resume falls through to one fresh seeded attempt. The bound is the
   * episode's time budget, backoff is 0/2/4/8 s, and the current session deadline does not move.
   */
  async #recoverFromDrop(handle: ActiveSession, outcome: LiveVoiceOutcome | undefined, forceFresh = false, reasonOverride?: string): Promise<boolean> {
    // C-CONTINUITY R-02/R-08/R-09: the outcome this recovery is for is kept on the handle, so the rebuild and
    // recovery lines read their cause and their socket close code and reason off a receipt instead of a guess. A
    // reopen with no outcome behind it (a mute, a provider window) clears a spent one rather than inheriting it.
    handle.adapterOutcome = outcome;
    const now = this.#now();
    // #656: one model-mute rebuild per recovery window, on the same watchdogRecoveredAt stamp and
    // RESPONSE_WATCHDOG_WINDOW_MS the sliding watchdog keeps. Every model-mute route passes this door, so a model
    // still mute under the new session is ended honestly instead of rebuilt a second time inside one research run.
    if (reasonOverride === 'model_mute') {
      const previous = handle.watchdogRecoveredAt;
      // W4-R1: the same exemption here, because this door is the rebuild too: a mute judged inside a tool wait it
      // never had settles nothing.
      if (previous !== undefined && now - previous < RESPONSE_WATCHDOG_WINDOW_MS && !this.#toolWaitUnjudged(handle)) {
        this.#settle(handle, { state: 'failed', code: 'model_unresponsive' }, false, 'ended', null);
        return false;
      }
      handle.watchdogRecoveredAt = now;
    }
    // #527: the healthy-episode reset is judged once per drop, then the stamp is cleared, so a dead session
    // that follows a healthy one starts its own episode instead of inheriting the reset.
    if (handle.lastHealthyAt !== undefined && now - handle.lastHealthyAt >= RECOVERY_HEALTHY_MS) { handle.recoveries = 0; handle.dropEpisodeAt = undefined; }
    handle.lastHealthyAt = undefined;
    if (handle.dropEpisodeAt === undefined) handle.dropEpisodeAt = now;
    // The episode's budget, not its attempt count: the network may come back well inside a minute.
    if (now - handle.dropEpisodeAt >= RECOVERY_BUDGET_MS) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
    const remaining = handle.deadlineAt - now, idle = handle.idleAt - now;
    const window = Math.min(10_000, handle.goAwayUntil === undefined ? 10_000 : handle.goAwayUntil - now);
    if (remaining <= 0 || idle <= 0 || window <= 0) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
    const backoff = recoveryBackoffMs(handle.recoveries);
    if (backoff > 0) await this.#delay(backoff);
    if (this.#settled(handle)) return false;
    const failedResume = handle.lastRecoveryPath === 'resume';
    const saved = this.#store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [handle.liveSessionId]));
    const savedHandle = saved?.['resumption_handle'];
    const hasHandle = typeof savedHandle === 'string' && savedHandle.length > 0;
    const seed = this.#seedWithLedger(handle.liveSessionId, handle.inputClass, handle.researchLedgerLog.text());
    const reuse = !forceFresh && this.#voice.capabilities.supportsResumption && hasHandle && handle.toolCalls < RESUMPTION_TOOL_CALL_LIMIT && !failedResume;
    const closeCode = outcome?.upstream?.closeCode ?? null;
    const reason = reasonOverride ?? outcome?.code ?? null;
    const path: 'resume' | 'fresh_seeded' = reuse ? 'resume' : 'fresh_seeded';
    let opened = await this.#openRecovery(handle, path, path === 'resume' ? savedHandle as string : undefined, remaining, idle, window, seed, reason);
    if (!opened && handle.recoveryRefused) return this.#retryRefusedOpen(handle, remaining, window, seed, reason, closeCode, path);
    if (!opened && path === 'resume') {
      this.#logRecovery(handle, 'resume', 'open_failed', closeCode, reason, seed);
      handle.recoveries += 1;
      opened = await this.#openRecovery(handle, 'fresh_seeded', undefined, remaining, idle, window, seed, reason);
      if (!opened && handle.recoveryRefused) return this.#retryRefusedOpen(handle, remaining, window, seed, reason, closeCode, 'fresh_seeded');
    }
    if (opened) {
      // A failed resume leaves an unusable handle: clear it so the next drop goes straight to fresh seeded.
      if (failedResume) this.#store.transaction(tx => tx.run('UPDATE live_sessions SET resumption_handle=NULL WHERE live_session_id=?', [handle.liveSessionId]));
      this.#logRecovery(handle, path, 'opened', closeCode, reason, seed);
      // #660: the session that replaced the one a result came back on cannot accept its retired call ids, so the
      // result goes to it as the one input a fresh session accepts. A refused delivery has already ended the turn.
      await this.#deliverUnspoken(handle);
      return true;
    }
    // A call that ended while an attempt was waiting for its ready event owes no further attempt.
    if (this.#settled(handle)) return false;
    this.#logRecovery(handle, path, 'open_failed', closeCode, reason, seed);
    handle.recoveries += 1;
    // A refusal pays its own backoff before the next attempt rather than ending the call.
    await this.#delay(recoveryBackoffMs(handle.recoveries));
    if (this.#settled(handle)) return false;
    return this.#recoverFromDrop(handle, outcome, forceFresh, reasonOverride);
  }

  /**
   * C-LIVE R2: an open the provider refused gets a fresh seeded open after a short backoff, never a repeat of the
   * failed resume, and C-RECOVERY (b) shrinks that seed on each refusal: the newest half of the conversation first,
   * then a plain open with only the summary context. If those fail as well, the call ends as
   * `provider_recovery_exhausted`: no audio is attempted, the
   * client receives the terminal and the next call starts clean. The generation moved on each attempt, so callbacks
   * of the old provider sessions are already fenced out.
   */
  async #retryRefusedOpen(handle: ActiveSession, remaining: number, window: number, seed: { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number }, reason: string | null, closeCode: number | null, path: 'resume' | 'fresh_seeded'): Promise<boolean> {
    const exhausted = (): false => { this.#settle(handle, { state: 'failed', code: 'provider_recovery_exhausted' }, false, 'ended', null); return false; };
    // C-RECOVERY (b): a locally refused seed is never resent unchanged. The first retry carries the newest half
    // of the same conversation, and the last attempt is a plain open with only the summary context.
    const shrink = (from: { turns: { role: 'user' | 'model'; text: string; dataClass: DataClass }[]; chars: number }) => {
      const turns = from.turns.slice(-Math.max(1, Math.ceil(from.turns.length / 2)));
      return { turns, chars: turns.reduce((sum, turn) => sum + turn.text.length, 0) };
    };
    // The attempt that brought the ladder here was refused on its own path, so that is a true receipt.
    this.#logRecovery(handle, path, 'open_refused', closeCode, reason, seed);
    let attempt = seed;
    // C-RECOVERY (b): the ladder is bounded by its own rung count, never by a counter that only a synchronous
    // refusal moves: an open whose socket dies before its ready event is not a refusal, and it must still advance
    // to the plain summary open and then to the typed end instead of stalling the loop.
    for (let rung = 1; rung <= 2; rung += 1) {
      await this.#delay(RECOVERY_REFUSED_BACKOFF_MS);
      if (this.#settled(handle)) return false;
      // The call's own budget still bounds the retry: an exhausted session or idle window is not a provider refusal.
      const now = this.#now();
      const left = handle.deadlineAt - now, idleLeft = handle.idleAt - now;
      if (left <= 0 || idleLeft <= 0 || remaining <= 0) { this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null); return false; }
      attempt = rung === 1
        ? shrink(attempt)
        : this.#seedWithLedger(handle.liveSessionId, handle.inputClass, handle.researchLedgerLog.text(), false, false);
      handle.recoveryRefused = false;
      const opened = await this.#openRecovery(handle, 'fresh_seeded', undefined, Math.min(remaining, left), idleLeft, window, attempt, reason);
      if (opened) {
        handle.recoveryRefusals = 0;
        this.#logRecovery(handle, 'fresh_seeded', 'opened', closeCode, reason, attempt);
        await this.#deliverUnspoken(handle);
        return true;
      }
      if (this.#settled(handle)) return false;
      // The receipt names what actually ended the attempt, so a dead socket is never written up as a refusal.
      this.#logRecovery(handle, 'fresh_seeded', handle.recoveryRefused ? 'open_refused' : 'open_failed', closeCode, reason, attempt);
    }
    return exhausted();
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
    const seed = this.#seedWithLedger(handle.liveSessionId, handle.inputClass, handle.researchLedgerLog.text());
    handle.recoveries = 0; handle.lastRecoveryPath = 'fresh_seeded'; handle.dropEpisodeAt = undefined;
    const opened = await this.#openRecovery(handle, 'fresh_seeded', undefined, remaining, idle, window, seed, 'session_deadline', false);
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
    const event = { type: 'inputTranscription' as const, sequence: 0, text, finished: true, finalOrigin: 'typed' as const };
    handle.connectorRecovery = this.#tools?.recover?.();
    handle.session.sendText({ text });
    handle.researchAdmission.ownerTurn();
    // O1b-A: typed text is an owner utterance at the same boundary as a spoken one, so it opens a turn.
    if (handle.connection.turnId === undefined) this.#openTurn(handle);
    // Same rule as provider activity: the owner's mute suspends the idle clock until the unmute.
    if (!handle.muted) this.#armIdle(handle, this.#profile.limits.idleMs, 'typed');
    const journalSequence = this.#persist(handle, event, 'inputTranscription');
    if (journalSequence === 'overflow') return;
    this.#pushChunk(handle, { kind: 'marker', marker: markerOf(event, 'inputTranscription', journalSequence, ++handle.markerSequence) });
  }
  #sendAudio(handle: ActiveSession, pcm: Uint8Array): void {
    handle.ownerAudioCalls++; handle.ownerAudioBytes += pcm.byteLength;
    // A late mic frame after the session settled is dropped and counted, never thrown:
    // throwing here makes the HTTP layer close the socket generic 1002 before the typed terminal frame.
    if (handle.rebuilding || (handle.terminal && !handle.invalidated)) {
      // #656: a rebuild is a gap in the session, not in the owner's words. His audio is held for the new session up to
      // REBUILD_AUDIO_HOLD_BYTES; past the cap the oldest held frame is what is dropped, and the counter records it.
      if (handle.rebuilding && !handle.terminal && this.#holdRebuildAudio(handle, pcm)) return;
      handle.ownerRebuildingDropCalls++; handle.ownerRebuildingDropBytes += pcm.byteLength;
      // The settle diagnostics were already emitted, so a late drop is counted and reported here.
      if (handle.terminal) console.error(JSON.stringify({ event: 'live_late_frame_dropped', liveSessionId: handle.liveSessionId,
        dropCalls: handle.ownerRebuildingDropCalls, dropBytes: handle.ownerRebuildingDropBytes }));
      return;
    }
    this.#guardHandle(handle);
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 !== 0) throw new LiveError('invalid_audio');
    // #656: audio held across the rebuild goes out first, in the order he spoke it.
    this.#flushRebuildAudio(handle);
    // 3j: a mic frame is not conversation. Idle measures silence, so frames keep flowing without resetting it.
    countAudio(handle, 'input', pcm.byteLength, this.#now());
    // The uplink carries zero frames while muted, so a mic that outlives the fence uploads nothing.
    if (handle.muted) return;
    handle.session.sendAudio({ pcm, dataClass: handle.inputClass });
  }

  /** #656: hold one owner frame across a rebuild. False when the frame cannot be held, so the caller counts the drop. */
  #holdRebuildAudio(handle: ActiveSession, pcm: Uint8Array): boolean {
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 !== 0) return false;
    while (handle.rebuildAudio.length > 0 && handle.rebuildAudioBytes + pcm.byteLength > REBUILD_AUDIO_HOLD_BYTES) {
      const dropped = handle.rebuildAudio.shift() as Uint8Array;
      handle.rebuildAudioBytes -= dropped.byteLength;
      handle.ownerRebuildingDropCalls++; handle.ownerRebuildingDropBytes += dropped.byteLength;
    }
    if (handle.rebuildAudioBytes + pcm.byteLength > REBUILD_AUDIO_HOLD_BYTES) return false;
    handle.rebuildAudio.push(pcm); handle.rebuildAudioBytes += pcm.byteLength;
    return true;
  }

  /**
   * #656: deliver the audio the owner sent into the rebuild gap, in the order he spoke it. A socket that answers
   * not_ready keeps its frames held for the next opportunity, so nothing is lost to a race with the adapter setup.
   */
  #flushRebuildAudio(handle: ActiveSession): void {
    if (handle.rebuildAudio.length === 0 || handle.muted) return;
    while (handle.rebuildAudio.length > 0) {
      const pcm = handle.rebuildAudio[0] as Uint8Array;
      try { handle.session.sendAudio({ pcm, dataClass: handle.inputClass }); }
      catch { return; }
      handle.rebuildAudio.shift(); handle.rebuildAudioBytes -= pcm.byteLength;
      countAudio(handle, 'input', pcm.byteLength, this.#now());
    }
  }

  #observeDiagnostics(handle: ActiveSession, session: LiveVoiceSession): void {
    handle.diagnosticSnapshots.push(session.done.then(() => session.diagnostics?.(), () => session.diagnostics?.()));
  }

  #emitDiagnostics(handle: ActiveSession): void {
    if (handle.diagnosticsEmitted) return;
    // C-RECOVERY (e): the one diagnostics line for a call is written once the call settled, so its terminalCode is
    // the live_sessions terminal outcome and never the field default a superseded generation's loop end saw.
    if (!handle.terminal) return;
    handle.diagnosticsEmitted = true;
    void Promise.all(handle.diagnosticSnapshots).then(values => {
      const snapshots = values.filter((value): value is Readonly<LiveVoiceDiagnostics> => value !== undefined);
      const sum = (field: keyof Omit<LiveVoiceDiagnostics, 'connection'>) => snapshots.reduce((total, value) => total + value[field], 0);
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
    // One host line per call, before the guard: call 1019 could not tell a detach that landed from one that
    // found the handle already past 'attached', and an open response is exactly what a late detach must not lose.
    hostLogEvent({ event: 'consumer_detach', consumerState: handle.consumerState, awaitingAnswer: handle.awaitingAnswer, openCalls: handle.pendingCallIds.size });
    if (handle.consumerState !== 'attached') return;
    handle.consumerState = 'ended';
    handle.consumer?.discard();
    try { this.#store.transaction(tx => tx.run("UPDATE live_sessions SET consumer_state='ended', updated_at=? WHERE live_session_id=?", [this.#now(), handle.liveSessionId])); }
    catch (error) {
      // A failed detach write is logged to the host log, never swallowed; #snapshot reconciles the row against this handle.
      hostLogEvent({ event: 'live_detach_write_failed', liveSessionId: handle.liveSessionId,
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown' });
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
  #stop(handle: ActiveSession, nativeReason?: string): void {
    if (this.#settled(handle)) return;
    // C-HEADPHONES 5: the app's own `live_end` reason travels with the Stop and the host log repeats
    // it unchanged, so a route change is never recorded as the owner's stop. An unknown word stays
    // user_stop: the log never invents a reason it was not told.
    const reason = nativeReason && (NATIVE_END_REASONS as readonly string[]).includes(nativeReason)
      ? nativeReason : 'user_stop';
    this.#settle(handle, { state: 'closed', code: 'user_stop' }, true, 'ended', null);
    hostLogEvent({ event: 'session_end', reason, msAfterStop: 0 });
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
        this.#voiceStopGate(handle, event, generation);
        if (handle.terminal) break;
        if ((event.type === 'audio' && event.audible !== false) || event.type === 'outputTranscription' || event.type === 'modelText') {
          handle.stopWords = []; handle.stopInputAt = undefined;
        }
        this.#watchdogEvent(handle, event);
        if (event.type === 'modelText' || event.type === 'outputTranscription') handle.modelTextSinceOpen = true;
        // D3: only audio the adapter measured as audible is output. A fill frame is forwarded to playback and
        // nothing else; it neither re-arms the deadline nor answers the obligation.
        const audible = event.type === 'audio' && event.audible !== false;
        // The answer's own audible audio is the one thing that clears the owed reply; tool text does not.
        if (audible || event.type === 'turnComplete') handle.awaitingAnswer = false;
        if (audible || event.type === 'turnComplete') {
          this.#cancelTimers(handle);
        }
        // A held answer stays for the offer. A cancelled opener stops applying on a barge-in as well as a
        // turn end (LIVE2-R8), so the answer to the owner's words is never silenced by it.
        if (event.type === 'turnComplete' || event.type === 'interrupted') { handle.mutedResponse = false; handle.dropResponse = false; }
        if (event.type === 'audio' || (event.type === 'outputTranscription' && event.text.trim())) noteModelOutput(handle.liveSessionId);
        if (event.type === 'turnComplete') handle.answerAt = undefined;
        if (event.type === 'modelTurnStarted') {
          // A trailing modelTurnStarted of the same batch never reopens a cancelled response (LIVE2-R6 F1).
          if (handle.turnCompleteSeen) { handle.dropResponse = false; handle.outputJournalled = false; handle.turnCompleteSeen = false; }
          if (handle.muted) handle.mutedResponse = true;
          resetTurnScript(handle);
          handle.firstAudioAt = undefined; handle.turnAudioAt = undefined;
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
          outcome = { status: 'failed', code: 'go_away', recoverable: true };
          break;
        }
        if (event.type === 'turnFailed') {
          // S5: a backend response that ended failed, incomplete or errored is a typed turn failure, never a
          // silent stall and never a rebuild: the session is healthy, the turn is not.
          this.#turnFailed(handle, generation, 'provider_error');
          continue;
        }
        if (event.type === 'contextUsage') {
          // The provider's own usage report, kept with the other numbers and never a payload.
          hostLogEvent({ event: 'live_context_usage', totalTokens: event.totalTokens, ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}), ...(event.responseTokens !== undefined ? { responseTokens: event.responseTokens } : {}) });
          continue;
        }
        if (event.type === 'upstreamQueue') {
          hostLogEvent({ event: 'live_upstream_queue', bufferedBytes: event.bufferedBytes });
          continue;
        }
        if (event.type === 'ready') {
          handle.ready = true; handle.lastHealthyAt = this.#now(); handle.readyAt = this.#now();
          // #451: the provider ack is the number every handshake report is measured against.
          hostLogEvent({ event: 'live_provider_ready', liveSessionId: handle.liveSessionId, generation,
            msSinceOpen: handle.openedAt === undefined ? 0 : Math.max(0, this.#now() - handle.openedAt), closeCode: null });
          this.#noteState(handle, 'ready');
          if (handle.rebuilding) {
            handle.rebuilding = false; this.#noteState(handle, 'rebuild');
            // #656: the held owner audio is delivered once the adapter has finished its setup, so a frame is never
            // handed to a session that is still opening.
            void Promise.resolve().then(() => { if (!handle.terminal && !handle.invalidated) this.#flushRebuildAudio(handle); });
            if (!handle.quietRebuild) this.#continuity(handle, 'resumed');
            continue;
          }
        }
        // Provider activity restarts the idle clock everywhere except under the owner's mute, which
        // suspends that clock until the unmute re-arms it.
        if (!handle.muted) {
          const resetBy = idleResetCause(handle, event);
          if (resetBy !== undefined) this.#armIdle(handle, this.#profile.limits.idleMs, resetBy);
        }
        if (ownerTurnFinalized(handle, event)) handle.researchAdmission.ownerTurn();
        if (event.type === 'toolCall') {
          handle.toolCalls += event.calls.length;
          // L3: a call in flight is exactly the state the stalled status note denied, so it retires here.
          handle.hostStatusNote = false;
          hostLogEvent({ event: 'research_call_arrived', liveSessionId: handle.liveSessionId, generation, calls: event.calls.length,
            ...researchCallFacts(event.calls) });
          handle.turnAfterTool = true;
          // C-TURN8: the call arrived, so the announcement before it answered for itself.
          handle.claimToolSeen = true;
          handle.claimTimer?.cancel(); handle.claimTimer = undefined;
          handle.claimText = '';
          handle.thinking = true;
          for (const call of event.calls) { handle.pendingCallIds.add(call.id); handle.pendingCalls.set(call.id, call.name); if (!handle.callStartedAt.has(call.id)) handle.callStartedAt.set(call.id, this.#now()); }
          for (const call of event.calls) if (/^(?:research$|search_|list_|read_)/u.test(call.name)) this.#armStillSearching(handle, call.id);
          this.#openSteps(handle, event.calls);
                // D5: the call itself enters THINKING, so the orb never says Listening while the lookup runs.
          this.#noteState(handle, 'tool');
          void this.#toolBatch(handle, event, generation).catch(() => {
            if (this.#settled(handle) || generation !== handle.generation) return;
            const responses = event.calls.filter(call => handle.pendingCallIds.has(call.id)).map(call => ({ id: call.id, name: call.name, response: { error: 'tool_processing_failed' } }));
            let outcome: LiveToolSendOutcome = 'failed';
            try { if (responses.length) { exposeToolResults(responses); outcome = handle.session.sendToolResponse({ responses }); } } catch { /* transport may have terminated */ }
            for (const call of event.calls) handle.pendingCallIds.delete(call.id);
            if (responses.length) this.#armDeadAir(handle, responses, outcome);
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
          this.#closeTurn(handle, 'interrupted', 'silent');
          // C-PITCH: a barge-in ends a response that already played audio, so it is measured and closed here
          // rather than folded into whatever the next response says.
          this.#logVoiceProfile(handle, generation);
          this.#noteState(handle, 'interrupted');
          handle.turnInterrupted = true;
          logTurnScript(handle);
          clearOpenLedger(handle.liveSessionId);
          // C-TURN8: the owner cut her off, so no claim of hers outlives the turn he interrupted.
          this.#resetClaimCheck(handle);
          // E1: one metadata-only host record per provider barge-in. Never audio, text or a provider payload.
          hostLogEvent({ event: 'live_interrupted', liveSessionId: handle.liveSessionId,
            turnCompleteSeen: handle.turnCompleteSeen,
            msSinceLastModelAudio: handle.lastModelAudioAt === undefined ? null : this.#now() - handle.lastModelAudioAt });
        }
        // generationComplete alone does not end SPEAKING: the orb holds it until the turn completes
        // and playback drains (F2).
        if (event.type === 'turnComplete') {
          // C-PITCH: one closed measurement per response that played audio, and the shift receipt when this
          // response's median F0 sits beyond the ratio from the session's running median (a voice change).
          this.#logVoiceProfile(handle, generation);
          // L19 second clause: a reply that was spoken with no transcript row is receipted, never silent.
          if (handle.spokenThisTurn && !handle.outputJournalled)
            hostLogEvent({ event: 'live_reply_unjournalled', liveSessionId: handle.liveSessionId, generation: handle.generation });
          handle.spokenThisTurn = false; handle.dropResponse = false;
          handle.speaking = false; this.#cancelSpeakingHold(handle); handle.turnCompleteSeen = true; handle.thinking = handle.pendingCallIds.size > 0;
          // The answer is done, so the turn's step lines retire here: a later question that reads nothing
          // must not show the previous turn's sources as if they were running (review finding F2).
          if (handle.pendingCallIds.size === 0) handle.liveSteps = [];
          correctOpenClaim(handle);
          // C-REBUILD8: a response that only filed a filler ("One second.") answered nothing, so it never spends
          // the turn's answer: a start that follows it is not the orphan run the admission refuses by name.
          if (isAckOnlyResponse(handle.turnSpoken ?? '')) handle.researchAdmission.acknowledgedOnly();
          logTurnScript(handle);
          this.#noteState(handle, 'turn_complete');
          // O1b-A: the answer is over. A turn that produced no audible output is closed as silent, which is the
          // fact the timeline reads instead of inferring one from a missing receipt (D12-3).
          this.#closeTurn(handle, 'completed', handle.firstAudioAt === undefined ? 'no_response' : 'answered');
        }
        if (event.type === 'waitingForInput') { handle.thinking = !event.value; if (event.value) this.#holdSpeaking(handle); this.#noteState(handle, event.value ? 'silence' : 'input'); }
        if (event.type === 'audio') {
          countAudio(handle, 'output', event.pcm.byteLength, this.#now(), event.rmsDbfs);
          // A muted owner hears nothing: the frame is dropped and the answer is marked held for the offer.
          if (handle.muted) {
            if (event.audible !== false) { handle.heldAnswer = true; handle.mutedResponse = true; handle.awaitingAnswer = false; }
            continue;
          }
          // L7: a response that began under the mute is never played late; its frames are dropped until the turn ends.
          if (handle.dropResponse) { if (event.audible !== false) handle.awaitingAnswer = false; continue; }
          // Only audible speech is SPEAKING (release 3p): the provider streams output frames non-stop, so a frame
          // is model output only when the adapter measured it above the audible threshold.
          if (event.audible === false) {
            handle.inaudibleMs += event.pcm.byteLength / OUTPUT_PCM_BYTES_PER_MS;
            this.#pushChunk(handle, { kind: 'audio', pcm: event.pcm }); continue;
          }
          this.#cancelSpeakingHold(handle);
          handle.thinking = false; handle.speaking = true; handle.lastModelAudioAt = this.#now();
          // C-RESEARCH-CONTRACT Q-08: audible words after this turn's research result are the answer to that turn,
          // so a start that follows them is the orphan run the admission refuses by name.
          handle.researchAdmission.answered();
          handle.turnAudioAt = handle.lastModelAudioAt;
          this.#noteState(handle, 'audio');
          if (handle.firstAudioAt === undefined) {
            handle.firstAudioAt = this.#now();
            // #451: the first audible frame of a turn, measured from the provider open and its ready event.
            const sinceOpen = handle.openedAt === undefined ? 0 : Math.max(0, handle.firstAudioAt - handle.openedAt);
            const sinceReady = handle.readyAt === undefined ? 0 : Math.max(0, handle.firstAudioAt - handle.readyAt);
            const answer = handle.researchAnsweredAt !== undefined;
            handle.spokenThisTurn = true;
            hostLogEvent({ event: answer ? 'live_answer_audio' : 'live_first_audio', liveSessionId: handle.liveSessionId, generation, msSinceReady: sinceReady, msSinceOpen: sinceOpen });
            if (handle.inputFinalAt !== undefined) {
              hostLogEvent({ event: 'live_dead_air', deadAirMs: Math.max(0, handle.firstAudioAt - handle.inputFinalAt - handle.mutedMs) });
              // C-DEADAIR: the provider's share of the wait, kept apart from the host's. Owner final words to the
              // announced response is model latency, announced response to first audio is the provider's time to
              // speak, and the tool-output offset is what the host's own ladder is measured against.
              hostLogEvent({ event: 'live_response_latency', liveSessionId: handle.liveSessionId, generation,
                msSinceOwnerFinal: Math.max(0, handle.firstAudioAt - handle.inputFinalAt - handle.mutedMs),
                msSinceResponseCreated: handle.responseCreatedAt === undefined ? null : Math.max(0, handle.firstAudioAt - handle.responseCreatedAt),
                msSinceToolOutput: handle.answerAt === undefined ? null : Math.max(0, handle.firstAudioAt - handle.answerAt) });
              handle.inputFinalAt = undefined;
            }
            // L-04: the wait the owner heard, measured from the last audible frame rather than from her turn's
            // end, so a preamble that satisfied the dead-air receipt no longer hides the answer's real silence.
            if (handle.heardSince !== undefined && this.#now() - handle.heardSince >= HEARD_SILENCE_MIN_MS) {
              hostLogEvent({ event: 'live_heard_silence', ms: Math.max(0, this.#now() - handle.heardSince),
                silence: this.#silenceOwner(handle) });
            }
          }
          // L-04: this frame is the newest thing the owner heard, and the next wait starts at its end.
          handle.heardSince = this.#now(); handle.heardAfterTool = false;
          // C-PITCH: the meter reads this frame just before it is queued, at about one percent of audio duration.
          (handle.voiceProfile ??= new VoiceProfileMeter()).push(event.pcm, event.rate);
          this.#pushChunk(handle, { kind: 'audio', pcm: event.pcm }); continue;
        }
        if (event.type === 'outcome') { outcome = event.outcome; continue; }
        if (event.type === 'outputTranscription') {
          const said = stripNonLexicalTags(event.text);
          if (said.trim() && handle.pendingCallIds.size === 0) handle.lookupAckAt = this.#now();
          countTurnScript(handle, said);
          handle.researchQueryContext = `${handle.researchQueryContext ?? ''} ${said}`.slice(-12000);
          handle.claimText = `${handle.claimText} ${said}`.slice(-300);
          // C-TURN8: the response's transcript is complete, so an announced lookup has its beat from here.
          if (event.finished === true) this.#armClaimCheck(handle, event.sequence);
        }
        if (event.type === 'inputTranscription') {
          if (!ownerTurnOpen) {
            ownerTurnOpen = true;
            handle.connectorRecovery = this.#tools?.recover?.();
            this.#openTurn(handle);
            handle.overlapWords = 0; handle.overlapReceipted = false;
          }
          if (handle.speaking) this.#noteOverlap(handle, event.text);
          handle.inputFinalTimer?.cancel();
          handle.inputAt = this.#now();
          handle.inputFinal = event.finished === true;
          if (handle.inputFinal && typeof event.text === 'string') handle.researchQueryContext = `${handle.researchQueryContext ?? ''} ${event.text}`.slice(-12000);
          if (handle.inputFinal) handle.ownerLastWords = typeof event.text === 'string' && event.text.trim() !== '' ? event.text.trim().split(/\s+/u).length : 0;
          if (handle.inputFinal) {
            // L-05: the provider sends the finished fragments of one utterance one after another, and the dead-air
            // receipt is owed one measurement per utterance, so it is armed once and written once per span.
            // #720: the span runs from the owner's LAST fragment, not the first, so the anchor moves with every one.
            handle.inputFinalAt = handle.inputAt;
            // L-04: her speech is audible, so the wait the owner hears starts at its last fragment.
            handle.heardSince = handle.inputAt; handle.mutedMs = 0;
            if (ownerTurnOpen) {
              ownerTurnOpen = false;
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
        if (event.type === 'inputTranscription' && event.finished === true) this.#finalizeOwnerInput(handle, generation, event.finalOrigin);
      }
    } catch (error) {
      // C-RECOVERY (f): a failed write is a closed class of its own, so the host's host_error names the journal
      // write instead of a bare Error, and the rejection the host logs carries that code too.
      handle.persistFailure = error instanceof LiveError ? error : new LiveError('persistence_failed');
      this.#diagnosticFailure(handle,'journal_write_failed');
    }
    if (!handle.terminal) {
      // A session-deadline continuation opens a new session from the timer; the ended one is superseded.
      if (generation !== handle.generation) continue;
      if (handle.persistFailure) { handle.abort.abort(); handle.done.reject(handle.persistFailure); }
      else {
        outcome ??= await session.done.catch(() => undefined);
        const failedRecovery = handle.rebuilding && !handle.ready;
        if (failedRecovery) handle.recoveries += 1;
        if (outcome?.recoverable || failedRecovery) {
          // A drop under the owner's mute is muted cold: no reconnect is attempted until the owner unmutes.
          if (handle.muted) {
            hostLogEvent({ event: 'live_mute', liveSessionId: handle.liveSessionId, generation: handle.generation,
              muted: true, warm: false, msSinceMute: Math.max(0, this.#now() - (handle.mutedAt ?? this.#now())) });
            this.#settle(handle, { state: 'closed', code: 'muted_drop' }, false, 'ended', null);
            break;
          }
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
      this.#finalizeOwnerInput(handle, generation, 'app_model_start');
      if (handle.terminal) return;
      try {
        this.#store.transaction(tx => tx.run("UPDATE live_journal SET finished=1,final_origin='app_model_start',finalized_at=?,finalized_mono_ms=? WHERE journal_id=? AND live_session_id=? AND kind='inputTranscription'", [this.#now(), hostMonotonicMs(), journalId, handle.liveSessionId]));
      } catch (error) {
        handle.persistFailure = error;
        handle.abort.abort();
        handle.done.reject(error);
        return;
      }
      handle.inputFinal = true;
      // L-05: the quiet-timer finalization of one utterance is the same utterance the provider already ended.
      // #720: it is also the owner's last word of the turn so far, so the dead-air anchor moves to it.
      handle.inputFinalAt = this.#now();
      handle.heardSince = this.#now(); handle.mutedMs = 0;
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

  #configuredEndpoints(): readonly ConfiguredEndpointStatus[] {
    return (this.#tools?.status?.().endpoints ?? []) as unknown as readonly ConfiguredEndpointStatus[];
  }

  /**
   * W10 behaviour 1: the run freezes its connections at acceptance. Naming only the connectors that
   * have already finished their handshake drops a slow one (Google stdio, Mongoose HTTP, a source that
   * connects just after host start) for the whole call, so the durable policies this owner has already
   * published are part of the set and the source is there when the transport comes up.
   */
  #connectionIds(tx: import('../contracts/storage.js').Transaction): string[] {
    const durable = this.#tools?.owner.durableConnectionIds?.(tx) ?? [];
    return [...new Set([...this.#tools!.connectionIds(), ...durable])];
  }

  #unreachableSources(handle: ActiveSession): (ResearchSourceKind | UnavailableSource)[] {
    // P5-R5 (F3) / W9-R3 / W9-B1 / W10: the endpoint report carries why this session cannot read a
    // source, and the owner's reply names it. Codes and closed enums only: never the free-text `error`,
    // so no connector text can reach a reply. One owner for the endpoint-to-source naming, in
    // research.ts, where a connected endpoint whose read grant has not published into this session is
    // named too, never silently narrowed away.
    return configuredSourcesForEndpoints(this.#configuredEndpoints(), handle.registry.map(tool => tool.name));
  }

  #researchSources(handle: ActiveSession): ResearchSourceKind[] {
    // Outcome 3: a source is detected by the tool its read actually uses, never a sibling, so a
    // calendar read is never advertised when the connection only grants the calendar-list sibling.
    const sources = researchSourcesFromToolNames(handle.registry.map(tool => tool.name));
    // Outcome 2: an approved connector that is down, or up without a usable read grant, keeps its
    // sources in the configured set, so the reply reports them unreachable instead of narrowing.
    for (const entry of this.#unreachableSources(handle)) {
      const source = typeof entry === 'string' ? entry : entry.source;
      if (!sources.includes(source)) sources.push(source);
    }
    return sources;
  }

  /** One BLOCKING research call runs its whole bounded loop; `interrupted` never aborts it. */
  async #researchBatch(handle: ActiveSession, event: Extract<LiveVoiceEvent, { type: 'toolCall' }>, generation: number, host: HostContext, allowed: boolean): Promise<{ responses: { id: string; name: string; response: JsonObject }[]; projections: LiveToolProjection[] }> {
    // #1022 F1: the gate answer belongs to the handle, so a batch never inherits a refused one from the batch
    // that built this session's scheduler.
    handle.researchAllowed = allowed;
    // #451/RECON-RESEARCH Q6: a lookup started before the owner has spoken spends the greeting on a source
    // nobody asked for, and the opener cancels its own six calls. The first start is answered at once, no
    // source runs, and the model is told to ask again after the owner speaks.
    if (handle.inputAt === undefined) {
      // C-ENTITY: this gate refused before any read, and its reason is a closed code on the refusal line too.
      for (const call of event.calls) hostLogEvent({ event: 'research_refused', state: 'refused', sequence: event.sequence, reason: 'no_owner_input', ...researchArgumentShape(call.args) });
      hostLogEvent(refusedResearchRunLog());
      const gated: JsonObject = { error: 'opener_not_fetched', state: 'refused', reason: 'no_owner_input',
        guidance: 'Nothing fetched yet. Do not retry before the owner speaks; ask this lookup again after their first turn.' };
      return {
        responses: event.calls.map(call => ({ id: call.id, name: call.name, response: gated })),
        projections: event.calls.map(call => ({ name: call.name, status: 'error' as const, markdown: researchProjection(gated, 'error'), sources: [] })),
      };
    }
    const configured = this.#researchSources(handle);
    const gateAuthority = { isCurrent: async (_host: HostContext, _tool: ToolDefinition, signal: AbortSignal) =>
      handle.researchAllowed && !signal.aborted && generation === handle.generation && !this.#settled(handle) };
    const execute = async (subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]> => {
      // Q1-R3(d): a research run issues several execute batches (search, then hydrate/open/thread, then a
      // retry). They shared handle.toolStep, so executionId (`runId:step:index`) collided and the journal
      // refused the second batch as tool_intent_exists. Take a fresh step per batch.
      const step = handle.toolStep++;
      const calls = subs.map((sub, n) => ({ id: `r${step}~${n}~${sub.key}`, name: sub.name, args: sub.args }));
      const signalMap = new Map<string, AbortSignal>(calls.map(call => [call.id, signal]));
      const control = { signal, deadlineMs: handle.deadlineMs };
      const raw = await runToolCalls(this.#tools!.owner, calls, { registry: handle.registry, host, signals: signalMap, authority: gateAuthority, control, step, contentIndex: 0, seenIds: handle.seenIds, invalidAttempts: handle.invalidAttempts, baseClasses: [handle.inputClass] });
      const authorized = (this.lookupAuthority(host.runId) || this.lookupJobAuthority(host.runId)) ? await authorizeToolBatch(this.#tools!.owner, raw, { host, control, baseClasses: [handle.inputClass] }) : raw;
      if (signal.aborted || generation !== handle.generation || this.#settled(handle)) {
        this.#tools!.owner.releaseEvidence(host.runId, [...raw.bindings, ...authorized.bindings]);
        return calls.map(call => ({ key: call.id, name: call.name, ok: false, text: '', originalCharacters: 0, omittedCharacters: 0, code: 'round_cancelled' }));
      }
      return calls.map(call => {
        const slot = authorized.bindings.findIndex(binding => binding.callId === call.id);
        // #651 FAILREASON-R1: a read that was interrupted by its deadline or ended unknown is fatal to the
        // batch, so it carries no binding; its own record is still on the batch and is found by call id.
        const record = slot >= 0 ? authorized.tools[slot] : authorized.tools.find(entry => entry.callId === call.id);
        const accepted = authorized.accepted.find(result => result.binding.callId === call.id);
        const response = accepted?.response ?? {};
        const text = typeof response.text === 'string' ? response.text : '';
        const ok = record?.status === 'completed' && accepted !== undefined;
        const consumed = ok && accepted ? this.#tools!.owner.consumeEvidence(host, accepted.binding, this.lookupAuthority(host.runId) ?? this.lookupJobAuthority(host.runId), signal) : undefined;
        // Q1-R3(d/e): a failed sub-call names its cause for the research_subcall log, never silently.
        // A sub-call that never dispatched reports its real reason (unknown_tool, grant_not_permitted,
        // invalid_arguments, round_deadline), never a bare refused.
        // #651 FAILREASON-R1: a read that did not complete keeps its own closed reason (a timeout, a
        // cancellation, a refused channel), so the reply says why instead of falling back to a bare status.
        const closed = record !== undefined && record.status !== 'completed' && typeof record.reason === 'string'
          && isToolFailureCode(record.reason) ? record.reason : undefined;
        const code = ok ? undefined
          : typeof response.code === 'string' ? response.code
          : typeof response.reason === 'string' ? response.reason
          : closed ?? (record?.status === 'refused' ? refusalCode(record.reason)
          : record ? String(record.status) : 'refused');
        return { key: call.id, name: call.name, ok, text,
          ...(consumed?.state === 'allowed' && consumed.evidence.kind === 'remote-body' ? { hostEvidence: consumed.evidence } : {}),
          ...(ok && call.name === HISTORY_IDENTITY.name ? { historyPage: response } : {}), ...(ok && accepted ? { binding: accepted.binding } : {}),
          ...(ok && call.name === 'gmail_search_messages' && response['mailPage'] ? { mailPage: response['mailPage'] as unknown as MailPage } : {}),
          ...(ok && call.name === 'calendar_list_events' && response['calendarPage'] ? { calendarPage: response['calendarPage'] as CalendarPage } : {}),
          ...(ok && call.name === 'calendar_list_calendars' && response['calendarScope'] ? { calendarScope: response['calendarScope'] as CalendarScope } : {}), ...(ok && response['knowledgeConfidence'] ? { knowledgeConfidence: response['knowledgeConfidence'] as { confidence: string; top?: string; candidates?: string } } : {}), originalCharacters: typeof response.originalCharacters === 'number' ? response.originalCharacters : text.length, omittedCharacters: typeof response.omittedCharacters === 'number' ? response.omittedCharacters : 0, ...(code ? { code } : {}) };
      });
    };
    // #1022 F1: the scheduler's closures name one generation, so a rebuilt session builds its own.
    if (handle.researchSchedulerGeneration !== handle.generation) handle.researchScheduler = undefined;
    const scheduler = handle.researchScheduler ??= new ResearchScheduler({
      now: () => this.#now(), timeZone: handle.timeZone, liveSessionId: handle.liveSessionId,
      authorizeEvidence: (bindings, signal) => !signal.aborted && generation === handle.generation && !this.#settled(handle)
        && this.#tools!.owner.authorizeDelivery(host, bindings, [handle.inputClass], this.lookupAuthority(host.runId), signal).state === 'allowed',
      configured, configuredNow: () => this.#researchSources(handle),
      // #1028 behaviour 1: the digest this host already read is where the names of the owner's own
      // organisations live, so a misheard one is resolved before any source reads.
      calendarDigest: () => this.#calendar,
      queryContext: () => handle.researchQueryContext ?? '',
      // #351: a configured connector that is down settles `unavailable` at once instead of spending the
      // source deadline on reads that cannot reach it.
      unavailableNow: () => this.#unreachableSources(handle), execute,
      // C-CONTINUITY T-11: the call's page book, so a reply cursor reads the stored answer, never a new search.
      voicePages: handle.voicePages,
      // WEB-1021: the selector carries the public web read built from the same Gemini binding it uses.
      ...(this.#researchWeb === undefined ? {} : { web: this.#researchWeb }),
      emit: progress => {
        hostLogEvent({ event: 'research_progress', ...progress });
        // U1: the voice lane sees the lookup as it runs, on the channel it already polls.
        if (!this.#settled(handle) && generation === handle.generation) {
          const view: ResearchProgressView = { researchId: progress.researchId, phase: progress.phase, sourcesDone: [...progress.sourcesDone], sourcesPending: [...progress.sourcesPending], elapsedMs: progress.elapsedMs };
          this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify(view) }, 'researchProgress');
        }
      },
      log: entry => hostLogEvent(entry), logJoined: (researchId, research_branch) => hostLogEvent({ event: 'research_joined', researchId, research_branch }), ledger: handle.researchLedger,
      // #565: one trace row per source call's query shape. A refused write is a diagnostic failure, never
      // the answer: the owner's read has already succeeded by the time this lands.
      queryShape: shape => {
        try { recordQueryShape(this.#store, shape, shape.at, shape.researchId); } catch (error) {
          hostLogEvent({ event: 'live_trace_rejected', kind: 'query.shape_written', code: error instanceof TraceRecordError ? error.code : 'unknown' });
          this.#diagnosticFailure(handle, 'trace_write_failed');
        }
      },
      // L8-Q06: a web read leaves its own row (the web has no canonical dispatch), its query in the content table.
      sourceRead: read => {
        try {
          recordSourceRead(this.#store, { source: read.source, outcome: read.outcome, ms: read.ms, results: read.results, ...(read.reason === undefined ? {} : { reason: read.reason }) }, read.at, read.researchId);
          if (read.query.trim().length > 0) recordResearchText(this.#store, { researchId: read.researchId, kind: 'web_query', text: read.query }, read.at);
        } catch (error) {
          hostLogEvent({ event: 'live_trace_rejected', kind: 'source.read_written', code: error instanceof TraceRecordError ? error.code : 'unknown' });
          this.#diagnosticFailure(handle, 'trace_write_failed');
        }
      },
      // R6: the loop's own clocks (the first answer point, the dead-air beat) run on the owner's scheduler,
      // so a test drives whole seconds instead of sleeping through them.
      schedule: this.#schedule,
      // U-k3: each source's read opens and closes one line in the voice view while it runs.
      step: step => {
        if (this.#settled(handle) || generation !== handle.generation || !handle.progressCallIds.has(step.callId)) return;
        this.#recordStep(handle, step);
        // Review F1 (S4A-R2 (e)): the research fan-out is the lookup the model actually makes, so each source's
        // start and end is an execution receipt too, and a progress line can name what is really running.
        handle.exec.set(step.stepId, { source: step.source, status: step.phase === 'end' ? (step.errorCode === 'timeout' ? 'timeout' : step.errorCode === 'cancelled' ? 'cancelled' : step.ok === false ? 'failed' : 'done') : 'running' });
      },
      // R6: a source that settles after the first answer. The host owns the block and the delivery rule.
      late: event => this.#lateFindings(handle, generation, event),
    });
    handle.researchSchedulerGeneration = handle.generation;
    const responses: { id: string; name: string; response: JsonObject }[] = [];
    const projections: LiveToolProjection[] = [];
    // C-LIVE behaviour 1: admission is decided in call order before anything runs, so a second start in one
    // message is refused exactly like a second start in one owner turn.
    const parsedCalls = event.calls.map(call => {
      const parsed = parseResearch(call.args);
      // C-RESEARCH-CONTRACT T-03: a continue that names the run this session already answered from only pages or
      // narrows it, so it spends that run's grant instead of needing an owner turn of its own.
      // C-CONTINUITY T-11: reading the next page of an answer this call already has is not a new search, so it
      // spends no admission turn and cannot be refused for want of a fresh owner turn.
      const sameRun = parsed.ok && parsed.call.action === 'continue' && pagesCurrentRun(parsed.call) && parsed.call.researchId === handle.researchAdmission.currentRun();
      const pages = parsed.ok && parsed.call.pageCursor !== undefined && handle.voicePages.holds(parsed.call.pageCursor);
      const verdict = parsed.ok && !pages ? handle.researchAdmission.admit(parsed.call.action, this.#ownPendingResults(handle, parsed.call.action, parsed.call.researchId), sameRun, parsed.call.question ?? '') : undefined;
      // #1028 behaviour 4: an admitted start is the work that makes a later late finding a new question.
      if (verdict?.admitted === true && parsed.ok && parsed.call.action === 'start') handle.researchStartedAt = this.#now();
      return { call, parsed, verdict };
    });
    // F6: every research call in one model message runs concurrently; the adapter bounds each source.
    const settled = await Promise.all(parsedCalls.map(async ({ call, parsed, verdict }) => {
      let response: JsonObject;
      if (!parsed.ok) {
        hostLogEvent({ event: 'research_refused', state: 'refused', sequence: event.sequence, reason: parsed.reason, ...parsed.shape });
        // R9/W0-R1: the refused call leaves its run receipt too, so a refusal is never invisible in the run log.
        hostLogEvent(refusedResearchRunLog());
        response = researchRepair(parsed.reason);
      } else if (verdict !== undefined && !verdict.admitted) {
        hostLogEvent({ event: 'research_blocked', liveSessionId: handle.liveSessionId, generation, action: parsed.call.action, reason: verdict.reason });
        response = admissionBlocked(verdict.reason, parsed.call.action === 'continue' ? handle.researchAdmission.deliveredReply() : undefined);
      } else {
        const firstStep = handle.toolStep;
        // C-CONVO9: the event-level lookup bridge does not alter research admission or its result.
        try {
          const priorRunId = handle.researchLedger.last()?.researchId;
          response = await this.#boundedResearch(handle, scheduler.call({ ...parsed.call, callId: call.id }, handle.abort.signal), parsed.call, configured, generation, priorRunId);
        } catch (error) { response = { error: error instanceof Error ? error.message : 'research_failed' }; }
        // L8-Q01/Q05: the run this call started or continued, its question, and its first canonical execution
        // (only when this call ran alone, so a batch step is never credited to the wrong call).
        this.#linkResearchCall(handle, host, call.id, parsed.call.question, response, event.calls.length === 1 && handle.toolStep > firstStep ? firstStep : undefined);
        if (response['error'] === undefined && parsed.call.action !== 'stop' && generation === handle.generation) {
          handle.researchAdmission.deliveredReply(response);
          handle.researchAdmission.delivered(typeof response['researchId'] === 'string' ? response['researchId'] : parsed.call.researchId);
        }
      }
      // R6: a reply that names sources still reading is the call's first answer point, so the late-findings
      // window and the one late commentary of this call both count from here.
      const asked = call.args?.['question'];
      if (typeof asked === 'string' && asked.trim() !== '') this.#lastResearchQuestion.set(handle.liveSessionId, asked);
      const pending = response['pending'];
      if (Array.isArray(pending) && pending.length > 0) { handle.researchAnsweredAt = this.#now(); handle.lateCommentaryFor = undefined; }
      // R6: the one research this turn may still collect from, and whether it still has sources reading.
      const answeredId = typeof response['researchId'] === 'string' ? response['researchId'] : '';
      handle.pendingResearch = Array.isArray(pending) && pending.length > 0 && answeredId !== '' ? { id: answeredId, count: pending.length } : undefined;
      // C-CONTINUITY T-11: every research result enters this voice session here, so the reply cap is applied
      // once, centrally, after the envelope is final: a deadline partial and a resumed run obey it too.
      response = capVoiceReply(response, handle.voicePages);
      return { id: call.id, name: call.name, response };
    }));
    for (const entry of settled) {
      responses.push(entry);
      // Research failures carry `error`; partial, stopped and retained replies may complete successfully.
      const completed = entry.response['error'] === undefined;
      const status: 'completed' | 'error' = completed ? 'completed' : 'error';
      projections.push({ name: entry.name, status, markdown: entry.name === RESEARCH_TOOL_NAME ? researchProjection(entry.response, status) : `research: ${status}`, sources: [] });
    }
    // C-DEPTH item 5 (W10-R12): count exactly the research text the provider now holds, so the rebuild is due
    // when the call has really retained that much. C-CONTINUITY item 5: a refused or failed result adds nothing to
    // that counter, and the same batch still counts in the total context figure the rebuild line carries.
    const research = responses.filter(entry => entry.name === RESEARCH_TOOL_NAME).map(entry => entry.response);
    const deliveredReplies = research.filter(reply => reply['error'] === undefined);
    const answerChars = deliveredReplies.reduce((sum, reply) => sum + JSON.stringify(reply).length, 0);
    handle.researchRetention = retainedAfterSend(handle.researchRetention, answerChars);
    // C-CONTINUITY item 4: the ledger takes one record per delivered batch, so a later refusal can never replace
    // what the owner already heard with an empty header, and the threshold is read against the whole call.
    for (const reply of deliveredReplies) {
      const findings = Array.isArray(reply['findings']) ? (reply['findings'] as { source?: string; text?: string }[]) : [];
      handle.researchLedgerLog.add(researchLedgerOf({
        question: this.#lastResearchQuestion.get(handle.liveSessionId) ?? '', findings,
        cursors: String(reply['nextCursor'] ?? '') === '' ? [] : [String(reply['nextCursor'])],
      }));
    }
    if (researchRebuildDue(handle.researchRetention, this.#rebuildThresholdChars) && handle.researchRebuildSeed === undefined) {
      handle.researchRebuildSeed = handle.researchLedgerLog.text();
    }
    return { responses, projections };
  }

  /**
   * C-CONVO9: one short bridge per owner ask, three quiet seconds after its acknowledgement. It rides the speakable-progress
   * channel (#538), the host's only input to the model while a tool call is pending, so the call is neither ended
   * nor re-issued. An adapter without that channel leaves the wait silent and the receipt says `spoken: false`,
   * which is the honest record instead of a claim the owner heard it.
   */
  #armStillSearching(handle: ActiveSession, callId: string): { cancel: () => void } {
    const ackAt = handle.lookupAckAt;
    if (ackAt === undefined) return { cancel: () => {} };
    const ownerAt = handle.inputAt;
    const ask = handle.connection.turnId ?? 'opener';
    const timer = this.#schedule(() => {
      if (this.#settled(handle) || !handle.pendingCallIds.has(callId)) return;
      if (handle.lookupBridgeForInput === ask || handle.inputAt !== ownerAt || (handle.connection.turnId ?? 'opener') !== ask) return;
      // Audio can finish after its transcript; the bridge owes three quiet seconds after the acknowledgement.
      const quietAt = Math.max(ackAt, handle.lastModelAudioAt ?? ackAt) + 3_000;
      if (this.#now() < quietAt) { this.#armStillSearching(handle, callId); return; }
      if (handle.speaking) return;
      handle.lookupBridgeForInput = ask;
      const researchId = handle.researchLedger.last()?.researchId ?? '';
      let spoken = false;
      try {
        const speak = handle.session.sendCommentary;
        spoken = typeof speak === 'function' && speak.call(handle.session, { text: 'Still looking, give me a moment.' }) !== false;
      } catch { spoken = false; }
      hostLogEvent({ event: 'research_still_searching', researchId, elapsedMs: this.#now() - ackAt, spoken });
    }, Math.max(0, Math.max(ackAt, handle.lastModelAudioAt ?? ackAt) + 3_000 - this.#now()));
    timer.unref?.();
    return timer;
  }

  /**
   * R6: the model asking for the pending results of the research this same live turn started. That is not a new
   * question: it names the research this session answered from, and that research still has sources reading.
   */
  #ownPendingResults(handle: ActiveSession, action: string, researchId: string | undefined): boolean {
    if (action !== 'continue' || researchId === undefined) return false;
    const pending = handle.pendingResearch;
    return pending !== undefined && pending.count > 0 && pending.id === researchId;
  }

  /**
   * C-LIVE behaviour 4: the host's own bound on an admitted operation. The loop answers by its deadline; if it has
   * not, `hostGraceMs` later the host answers with what the ledger holds, so the in-flight state clears even when a
   * downstream cancellation is slow, and the model is asked to answer from that.
   */
  async #boundedResearch(handle: ActiveSession, work: Promise<JsonObject>, call: { action: string; researchId?: string | undefined }, configured: readonly ResearchSourceKind[], generation: number, priorRunId: string | undefined): Promise<JsonObject> {
    if (call.action === 'stop') return work;
    let timer: { cancel(): void } | undefined;
    const startedAt = this.#now();
    const bound = new Promise<'deadline'>(resolve => { timer = this.#schedule(() => resolve('deadline'), RESEARCH_OPERATION.deadlineMs + RESEARCH_OPERATION.hostGraceMs); });
    const outcome = await Promise.race([work, bound]);
    timer?.cancel();
    if (outcome !== 'deadline') return outcome;
    hostLogEvent({ event: 'research_operation_deadline', liveSessionId: handle.liveSessionId, generation, ms: Math.max(0, this.#now() - startedAt) });
    const researchId = deadlineResearchId(call, priorRunId, handle.researchLedger.last()?.researchId);
    return { ...knownReply(handle.researchLedger, researchId, configured, 'partial'), operationStop: 'deadline' };
  }

  /**
   * R6: what a source found after the call had already answered. The block is always silent context for the
   * model, so "what else did you find?" is answered truthfully, and it is spoken only when the turn is quiet:
   * the owner is not talking, no answer audio is playing, no new question has started, and the answer is young.
   * One late line per call, and one delivery per source, so a slow source is never reported twice.
   */
  #lateFindings(handle: ActiveSession, generation: number, event: ResearchLateFindings): void {
    const receipt = { event: 'research_late_findings', researchId: event.researchId, source: event.source, ms: event.ms, items: event.items.length };
    const drop = (reason: string): void => { hostLogEvent({ ...receipt, destination: 'dropped', reason }); };
    if (this.#settled(handle) || generation !== handle.generation) return drop('session_closed');
    // #472: a cut run's empty late event is a cut, not a source failure, and the receipt must say so.
    if (event.items.length === 0) return drop(event.cut === true ? 'run_cut' : event.ok ? 'no_new_findings' : 'source_failed');
    {
      // #472: a run cancelled after it answered is still this session's run, and the answer's own evidence is
      // the authority that matters. The lifecycle state is not a second permission gate, so a late source is
      // ruled out only by `authorizeDelivery` below, which is the check that can actually refuse it.
      if (handle.researchLedger.find(event.researchId) === undefined || (event.runId !== undefined && handle.researchLedger.find(event.researchId)?.runId !== event.runId) || !this.#tools || !handle.host) return drop('result_denied');
      try {
        if (this.#tools.owner.authorizeDelivery(handle.host, handle.researchLedger.evidenceBindings(event.researchId), [handle.inputClass], this.lookupAuthority(handle.host.runId), handle.abort.signal).state !== 'allowed') return drop('result_denied');
      } catch { return drop('result_denied'); }
    }
    // #516/#438: the provider has no silent append the live wire accepts (session.thinking.append is logged
    // as an unknown frame and a commentary append is refused on delegation_id), so a late finding is either
    // spoken once through the response channel or kept in the ledger for the next continuation. Never a
    // provider frame the wire refuses.
    const reason = this.#lateCommentaryReason(handle, event);
    // #1028 behaviour 4: a hold postpones the line, it never discards the finding, so a block held by room
    // speech is offered once the hold is over. A new question, a closed turn or a spoken line still ends it.
    if (reason === 'owner_speaking') {
      handle.lateHoldTimer?.cancel();
      handle.lateHoldTimer = this.#schedule(() => {
        handle.lateHoldTimer = undefined;
        if (this.#settled(handle) || generation !== handle.generation) return;
        this.#lateFindings(handle, generation, event);
      }, SPEAKING_HOLD_MS);
    }
    if (reason !== null) return hostLogEvent({ ...receipt, destination: 'ledger', reason });
    const line = lateFindingsText(event.source, event.items);
    try { handle.session.sendText({ text: hostNote(line) }); } catch { return hostLogEvent({ ...receipt, destination: 'ledger', reason: 'send_failed' }); }
    if (event.source === 'calendar') handle.researchLedger.delivered(event.researchId, event.runId ?? -1, (event.calendarKeys ?? []).filter((_, index) => line.includes(event.items[index] ?? '\u0000')));
    if (event.mailKeys) {
      const keys = event.items.flatMap((item, index) => (event.mailKeys![index] && line.includes(item) ? [event.mailKeys![index]!] : []));
      handle.researchLedger.deliveredMail({ researchId: event.researchId, runId: event.runId ?? -1, keys });
    }
    handle.lateCommentaryFor = event.researchId;
    hostLogEvent({ event: 'late_findings_sent', delegationKey: this.#delegationKey(handle), reason: 'late_findings' });
    hostLogEvent({ ...receipt, destination: 'response', reason: 'quiet' });
  }

  /**
   * R7 (H-02): what really owned the silence the owner just heard. A tool call actually in flight is `tool`; a
   * provider that is only generating an answer is `provider`; anything else is the owner's own turn, `owner`.
   */
  #silenceOwner(handle: ActiveSession): 'tool' | 'provider' | 'owner' {
    if (handle.pendingCallIds.size > 0) return 'tool';
    // A wait that began after a tool result and has no call pending is the provider owing its answer, which is the
    // case the old boolean mislabelled as a busy tool.
    if (handle.heardAfterTool || handle.thinking || handle.awaitingAnswer) return 'provider';
    return 'owner';
  }

  /** Why a late block stays silent, or null when the turn is quiet enough to say one line aloud. */
  #lateCommentaryReason(handle: ActiveSession, event: ResearchLateFindings): string | null {
    return lateCommentarySilence({
      now: this.#now(),
      answeredAt: handle.researchAnsweredAt ?? this.#now(),
      alreadySpoken: handle.lateCommentaryFor === event.researchId,
      inputAt: handle.inputAt,
      ownerWords: handle.ownerLastWords,
      lastModelAudioAt: handle.lastModelAudioAt,
      newerWorkAt: Math.max(handle.researchStartedAt ?? 0, handle.lastToolCallAt ?? 0),
    });
  }

  /** A fresh turn of tool work: the step list restarts and every direct call opens its own line.
   *  A `research` call opens one line per source from inside the run instead. */
  #openSteps(handle: ActiveSession, calls: readonly { id: string; name: string; args: JsonObject }[]): void {
    // #1028 behaviour 4: a tool call the owner's new ask made holds a late finding back; a continue of the run
    // already reading is that run's own work, not a new question.
    if (calls.some(call => call.name !== RESEARCH_TOOL_NAME)) handle.lastToolCallAt = this.#now();
    const running = new Set([...handle.exec].filter(([, entry]) => entry.status === 'running').map(([id]) => id));
    handle.liveSteps = handle.liveSteps.filter(step => running.has(step.stepId) || running.has(step.callId));
    handle.liveStepItems = new Map();
    handle.exec = new Map([...handle.exec].filter(([id]) => running.has(id)));
    for (const call of calls) {
      handle.progressCallIds.add(call.id);
      // S4a-R2 (e): queued is the only status a call has until the tool owner is handed it.
      if (call.name === RESEARCH_TOOL_NAME) continue;
      handle.exec.set(call.id, { source: stepSourceOf(call.name), status: 'queued' });
      const subject = stepSubject(call.args);
      const step = { callId: call.id, stepId: `${call.id}:0`, source: stepSourceOf(call.name), action: stepActionOf(call.name), ...(subject !== undefined ? { subject } : {}), phase: 'start' as const };
      liveToolStep(step);
      this.#recordStep(handle, step);
    }
  }

  /** Keep one line per step: an end step replaces its own start line in place. */
  #recordStep(handle: ActiveSession, step: LiveToolStepBody): void {
    if (this.#settled(handle) || !handle.progressCallIds.has(step.callId)) return;
    const index = handle.liveSteps.findIndex(entry => entry.stepId === step.stepId);
    if (index >= 0) { handle.liveSteps[index] = step; return; }
    handle.liveSteps.push(step);
    while (handle.liveSteps.length > LIVE_STEPS_MAX) handle.liveSteps.shift();
  }

  async #toolBatch(handle: ActiveSession, event: Extract<LiveVoiceEvent, { type: 'toolCall' }>, generation: number): Promise<void> {
    handle.thinking = true;
    // #1022 F5/F3: the per-turn latency loops delete this clock, so the arrival time is read once, here.
    const arrivedAt = new Map(event.calls.flatMap(call => { const at = handle.callStartedAt.get(call.id); return at === undefined ? [] : [[call.id, at] as const]; }));
    const publish = (kind: 'toolCall' | 'toolResult', tool: LiveToolProjection) => {
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      const sequence = this.#persist(handle, { type: kind, sequence: event.sequence, tool }, kind);
      if (sequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind, sequence: event.sequence }); return; }
      this.#pushChunk(handle, { kind: 'marker', marker: { kind, sequence: event.sequence, journalSequence: sequence, text: null, finished: null, value: null, tool } });
    };
    for (const call of event.calls) publish('toolCall', { name: call.name, status: 'called', markdown: '', sources: [] });
    if ((this.#settled(handle) || generation !== handle.generation)) return;
    const cachedDeliveryBindings = new Map<number, ToolResultBinding>();
    let responses = event.calls.map(call => ({ id: call.id, name: call.name, response: { error: 'Tool not granted' } as JsonObject }));
    let projections: LiveToolProjection[] = event.calls.map(call => ({ name: call.name, status: 'error', markdown: 'Tool not granted', sources: [] }));
    // C-TURN8: no owner-data tool runs before the owner's first word. Research keeps its own gate inside
    // `#researchBatch` (answered at once, no source reached); every other owner-data name is refused here,
    // before any argument check, with the same shape and the same closed reason.
    const beforeOwner = handle.inputAt === undefined
      && event.calls.some(call => call.name !== RESEARCH_TOOL_NAME && OWNER_DATA_TOOL_NAMES.has(call.name));
    if (beforeOwner) {
      const refusal: JsonObject = { error: 'opener_not_fetched', state: 'refused', reason: 'no_owner_input',
        guidance: 'Nothing read yet. Do not retry before the owner speaks; make this call again after their first turn.' };
      for (const call of event.calls) hostLogEvent({ event: 'live_tool_refused', sequence: event.sequence, tool: call.name, reason: 'no_owner_input' });
      responses = event.calls.map(call => ({ id: call.id, name: call.name, response: refusal }));
      projections = event.calls.map(call => ({ name: call.name, status: 'error' as const, markdown: `${call.name}: refused (no_owner_input)`, sources: [] }));
    }
    if (!beforeOwner && this.#tools && handle.host) {
      await handle.connectorRecovery;
      if (this.#settled(handle) || generation !== handle.generation) return;
      const authority = this.lookupAuthority(handle.host.runId);
      if (!authority) return;
      const dispatchGate = await this.#tools.owner.resultGate.authorize(handle.host, [], [handle.inputClass], handle.abort.signal);
      if (this.#settled(handle) || generation !== handle.generation) return;
      const host = structuredClone(handle.host), step = ++handle.toolStep;
      const jobAbort = new AbortController();
      const control = { signal: jobAbort.signal, deadlineMs: handle.deadlineMs };
if (event.calls.some(call => call.name === 'remember_note' || call.name === 'save_to_vault' || call.name === 'trello_write' || call.name === 'stage_lux_note')) await this.#waitForOwnerTranscript(handle, event.sequence);
      if (this.#settled(handle) || generation !== handle.generation) return;
      if (dispatchGate.state === 'allowed' && event.calls.some(call => !['stage_lux_note', 'remember_note', 'save_to_vault', 'trello_write'].includes(call.name))) this.#noteRequests.get(handle.liveSessionId)?.externalRead();
      if (event.calls.every(call => call.name === RESEARCH_TOOL_NAME)) {
        const outcome = await this.#researchBatch(handle, event, generation, host, dispatchGate.state === 'allowed');
        if (this.#settled(handle) || generation !== handle.generation) return;
        responses = outcome.responses;
        projections = outcome.projections;
        const latency: { tool: string; ms: number }[] = [];
        for (const call of event.calls) { const started = arrivedAt.get(call.id); if (started !== undefined) latency.push({ tool: call.name, ms: Math.max(0, this.#now() - started) }); handle.callStartedAt.delete(call.id); }
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
      type CachedRead = { response: JsonObject; projection: LiveToolProjection; binding: ToolResultBinding };
      const cached = new Map<number, CachedRead>();
      const pending: Unit[] = [];
      for (const unit of units) {
        const hit = unit.intent === undefined && cache.cacheable(unit.call.name) ? cache.get<CachedRead>(unit.call.name, unit.call.args) : undefined;
        if (!hit) { pending.push(unit); continue; }
        const gate = await this.#tools.owner.resultGate.authorize(host, [hit.binding], [handle.inputClass], handle.abort.signal);
        if (this.#settled(handle) || generation !== handle.generation) return;
        if (gate.state !== 'allowed') { pending.push(unit); continue; }
        hostLogEvent({ event: 'live_read_cache', tool: unit.call.name, cached: true });
        cached.set(unit.index, hit);
        cachedDeliveryBindings.set(unit.index, hit.binding);
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
        if (handle.progressCallIds.has(unit.call.id)) handle.exec.set(unit.call.id, { source: stepSourceOf(unit.call.name), status: 'running' });
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
          step: useStep, contentIndex: 0, seenIds: handle.seenIds, invalidAttempts: handle.invalidAttempts, baseClasses: [handle.inputClass] });
        // Completion never sends to the old transport. With no active authority, retain references for pickup.
        if (!this.lookupAuthority(host.runId) && !this.lookupJobAuthority(host.runId)) return raw;
        return await authorizeToolBatch(this.#tools!.owner, raw, { host, control, baseClasses: [handle.inputClass] });
      };
      const readSub = (source: Batch | undefined, key: string, name: string): IntentSubResult => {
        const slot = source?.bindings.findIndex(binding => binding.callId === key) ?? -1;
        const record = slot >= 0 ? source!.tools[slot] : undefined;
        const accepted = source?.accepted.find(result => result.binding.callId === key);
        const ok = record?.status === 'completed' && accepted !== undefined;
        return subResultOf(key, name, accepted?.response ?? {}, ok);
      };
      const raced = await this.#withCeiling(runBatch(subCalls, step), outcome => {
        for (const unit of pending) hostLogEvent({ event: 'tool_ceiling_late', tool: unit.call.name, outcome });
      });
      // L8-Q01: each direct call's first canonical execution, `runId:step:offset`, the id its dispatch rows carry.
      for (const unit of pending) {
        if (unit.subs.length === 0) continue;
        try {
          recordCallLink(this.#store, { callKey: scopedTraceKey(handle.liveSessionId, handle.connection.epoch, 'call', unit.call.id),
            canonicalRunId: host.runId, canonicalExecutionId: `${host.runId}:${step}:${offsets.get(unit.index) ?? 0}` });
        } catch (error) {
          hostLogEvent({ event: 'live_trace_rejected', kind: 'call.linked', code: error instanceof TraceRecordError ? error.code : 'unknown' });
          this.#diagnosticFailure(handle, 'trace_write_failed');
        }
      }
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      // S4a ceiling: a call still running at the host limit is answered as a timeout through the same
      // continuation owner, so the backend gets one output per call and one response.create for the batch.
      if (raced === 'timeout') {
        for (const unit of pending) {
          // S4a-R2 (a): a cancelled call never reaches this branch (its own `tool_cancelled` receipt covers it and
          // it is owed no answer), so the ceiling settles a read as a timeout and a write as uncertain.
          const outcome = isReadOnlyTool(unit.call.name) ? 'timeout' : 'uncertain';
          hostLogEvent({ event: 'tool_ceiling_hit', tool: unit.call.name, ms: TOOL_CEILING_MS, outcome });
          if (handle.progressCallIds.has(unit.call.id)) handle.exec.set(unit.call.id, { source: stepSourceOf(unit.call.name), status: 'timeout' });
        }
        // The ceiling settles the call locally: this abort asks the tool owner to stop, and proves nothing about
        // the remote side, so a write settles as uncertain unless its cancellation came from somewhere else.
        for (const unit of pending) handle.callAborts.get(unit.call.id)?.abort();
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
      // C-REFUSAL8: an invalid-arguments refusal answers with the fix marked not for speech and one fixed
      // spoken line, so the model can never read the host's guidance aloud; every other refusal stays a code.
      const refusalResponse = (why: string): JsonObject => invalidArgumentsResponse(why) ?? { error: why };
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
          projections[index] = { name: call.name, status: ok ? 'completed' : 'error', markdown: noEmptyResult(digest.text, call.name, typeof call.args['query'] === 'string' ? call.args['query'] : undefined), sources: [] };
          // The count the voice view shows is the items the source returned, never the citation count.
          if (ok && digest.itemCount !== undefined) handle.liveStepItems.set(call.id, digest.itemCount);
          return { id: call.id, name: call.name, response: ok ? intentResponse(digest, unit.intent) : refusalResponse(reason) };
        }
        const accepted = batch?.accepted.find(result => result.binding.callId === call.id && result.binding.name === call.name);
        const completed = accepted !== undefined && record?.status === 'completed';
        const markdown = completed ? noEmptyResult(typeof accepted.response.markdown === 'string' ? accepted.response.markdown : typeof accepted.response.text === 'string' ? accepted.response.text : reason, call.name, typeof call.args['query'] === 'string' ? call.args['query'] : undefined) : reason;
        const sources = completed ? sourceCards({ text: accepted.response.text, markdown: accepted.response.markdown, sources: accepted.response.sources }, Infinity) : [];
        const projection: LiveToolProjection = { name: call.name, status: completed ? 'completed' : 'error', markdown, sources };
        projections[index] = projection;
        if (completed && cache.cacheable(call.name)) cache.set(call.name, call.args, { response: accepted.response, projection, binding: accepted.binding });
        return { id: call.id, name: call.name, response: completed ? accepted.response : refusalResponse(reason) };
      });
      // Per-turn metadata only: the traces the council requires before any playback fence.
      const latency: { tool: string; ms: number }[] = [];
      for (const unit of pending) {
        const started = arrivedAt.get(unit.call.id);
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
    const researchDeliveryBindings = new Map<number, ToolResultBinding[]>();
    for (const [index, entry] of responses.entries()) if (entry.name === RESEARCH_TOOL_NAME && (entry.response['calendarCoverage'] || entry.response['historyPages'] || handle.researchLedger.evidenceBindings(String(entry.response['researchId'] ?? '')).length > 0)) {
      const id = String(entry.response['researchId'] ?? '');
      if (!handle.researchLedger.evidenceCurrent(id)) {
        responses[index] = { id: entry.id, name: entry.name, response: { error: 'tool_result_denied' } };
        projections[index] = { name: entry.name, status: 'error', markdown: 'tool_result_denied', sources: [] };
      } else researchDeliveryBindings.set(index, handle.researchLedger.evidenceBindings(id));
    }
    if (researchDeliveryBindings.size > 0 && this.#tools && handle.host) {
      for (const [index, bindings] of researchDeliveryBindings) {
        let allowed = false;
        try { allowed = this.#tools.owner.authorizeDelivery(handle.host, bindings, [handle.inputClass], this.lookupAuthority(handle.host.runId), handle.abort.signal).state === 'allowed'; } catch { allowed = false; }
        if (!allowed) {
          const entry = responses[index]!;
          handle.researchLedger.stop(String(entry.response['researchId'] ?? ''));
          responses[index] = { id: entry.id, name: entry.name, response: { error: 'tool_result_denied' } };
          projections[index] = { name: entry.name, status: 'error', markdown: 'tool_result_denied', sources: [] };
        }
      }
    }
    if (cachedDeliveryBindings.size > 0 && this.#tools && handle.host) {
      let allowed = false;
      try {
        allowed = this.#tools.owner.authorizeDelivery(handle.host, [...cachedDeliveryBindings.values()], [handle.inputClass],
          this.lookupAuthority(handle.host.runId), handle.abort.signal).state === 'allowed';
      } catch { allowed = false; }
      if (!allowed) for (const index of cachedDeliveryBindings.keys()) {
        const call = event.calls[index]!;
        responses[index] = { id: call.id, name: call.name, response: { error: 'tool_result_denied' } };
        projections[index] = { name: call.name, status: 'error', markdown: 'tool_result_denied', sources: [] };
      }
    }
    for (const [index, projection] of projections.entries()) {
      const id = event.calls[index]!.id;
      // #451 Q8: the status the journal carries is the one definition of how the result settled, so a
      // call whose result carries content can never be described as failed.
      const status = journalToolStatus(responses[index]?.response ?? {});
      // S4a-R2 (e): the settled status of a call is an execution receipt. A call
      // the ceiling settled keeps that status, because "timed out" is what happened and "failed" would hide it.
      if (handle.exec.has(id) && handle.exec.get(id)?.status !== 'timeout') {
        if (handle.progressCallIds.has(id)) handle.exec.set(id, { source: stepSourceOf(event.calls[index]!.name), status: status === 'completed' ? 'done' : 'failed' });
      }
      if (handle.pendingCallIds.has(id)) publish('toolResult', { ...projection, status, ...(handle.bargeInCallIds.has(id) ? { code: 'after_barge_in' } : {}) });
      this.#callResult(handle, id, responses[index]?.response, projection.markdown);
      const call = event.calls[index]!;
      if (call.name === RESEARCH_TOOL_NAME) continue;
      const started = arrivedAt.get(call.id);
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
    // S4a-R2 (a): a read that ran past the ceiling settles as a timeout and a write as uncertain. A late callback
    // never rewrites either, and a provider-cancelled call is owed no answer at all (3r).
    responses = responses.map(response => {
      const call = event.calls.find(candidate => candidate.id === response.id);
      if (call === undefined || handle.exec.get(call.id)?.status !== 'timeout' || isReadOnlyTool(call.name)) return response;
      return { ...response, response: { error: 'outcome_uncertain' } };
    });
    // The call stops being pending the moment its output is sent (amendment C); from here the owed answer
    // carries THINKING, so the orb never flashes LISTENING between the tool and her speech (F1, D5).
    for (const call of event.calls) { handle.pendingCallIds.delete(call.id); handle.bargeInCallIds.delete(call.id); }
    if (!(this.#settled(handle) || generation !== handle.generation)) {
      try {
        if (responses.length) {
          // OPEN2-R4: the one exposure point, on the text these results deliver after every trim.
          if (event.calls.some(call => !['stage_lux_note', 'remember_note', 'save_to_vault', 'trello_write'].includes(call.name))) this.#noteRequests.get(handle.liveSessionId)?.externalResult(event.calls.filter(call => !['stage_lux_note', 'remember_note', 'save_to_vault', 'trello_write'].includes(call.name)).map(call => `tool:${call.id}`));
          exposeToolResults(responses);
          // C-CONTINUITY item 5: the total-context figure counts every tool payload this call hands the provider,
          // research and intent alike, refusals and errors included, so the number it reports is really the total.
          handle.contextToolChars += responses.reduce((sum, entry) => sum + JSON.stringify(entry.response ?? {}).length, 0);
          responses = responses.map(entry => ['remember_note', 'save_to_vault'].includes(entry.name) ? { ...entry, response: { saved: false, code: 'tool_retired', guidance: 'Use stage_lux_note for a new owner-requested save.' } } : entry);
          // #538: what the write did is the host's to read, not a receipt to log and then forget.
          const outcome = handle.session.sendToolResponse({ responses });
          handle.researchQueryContext = `${handle.researchQueryContext ?? ''} ${responses.map(entry => JSON.stringify(entry.response)).join(' ')}`.slice(-12000);
          // #451: the function_call_output write itself, measured from the frame that asked for it.
          const askedAt = event.calls.map(call => arrivedAt.get(call.id)).find(started => started !== undefined);
          hostLogEvent({ event: 'tool_output_sent', liveSessionId: handle.liveSessionId, generation, tools: responses.length, outcome,
            msSinceArrived: askedAt === undefined ? 0 : Math.max(0, this.#now() - askedAt) });
          for (const entry of responses) if (entry.name === RESEARCH_TOOL_NAME) markCalendarReply(handle.researchLedger, entry.response);
          this.#armDeadAir(handle, responses, outcome);
        }
      } catch { /* A cancelled provider batch or terminal transport cannot receive late answers. */ }
    }
    handle.thinking = responses.length > 0 || handle.pendingCallIds.size > 0;
    this.#noteState(handle, 'tool');
  }
  #persist(handle: ActiveSession, event: { type: 'continuity' | 'remember_deferred'; sequence: number; text: string } | LiveVoiceEvent | { type: 'toolCall' | 'toolResult'; sequence: number; tool: LiveToolProjection }, kind: JournalKind, transaction?: Transaction): number | 'overflow' {
    const raw = 'text' in event ? event.text : null;
    const isTranscript = event.type === 'inputTranscription' || event.type === 'outputTranscription';
    const text = raw !== null && isTranscript ? stripNonLexicalTags(raw) : raw;
    if (event.type === 'outputTranscription') handle.outputJournalled = true;
    const finished = 'finished' in event && event.finished !== undefined ? (event.finished ? 1 : 0) : null;
    const value = event.type === 'waitingForInput' ? (event.value ? 1 : 0) : null;
    const toolJSON = 'tool' in event ? JSON.stringify(event.tool) : null;
    const bytes = toolJSON ? Buffer.byteLength(toolJSON) : kind === 'continuity' ? Buffer.byteLength(text ?? '') : retainedBytes(kind, text);
    const limits = this.#profile.limits;
    if (handle.journalEvents + 1 > limits.journalMaxEvents || handle.journalBytes + bytes > limits.journalMaxBytes) return 'overflow';
    const now = this.#now();
    const events = handle.journalEvents + 1;
    const total = handle.journalBytes + bytes;
    // W6 item 6: the composed note acts on the persisted turn, so the hook never nests a transaction.
    let pendingOwnerText: string | undefined;
    const pendingOwnerFragment = event.type === 'inputTranscription' && event.finished !== true && event.finalOrigin !== 'typed' && (text ?? '').length > 0;
    const persist = (tx: Transaction) => {
      const transcription = event.type === 'inputTranscription' || event.type === 'outputTranscription' ? event : undefined;
      if (event.type === 'inputTranscription' && !event.finished && text) noteOwnerPartial(handle.liveSessionId, text);
      const mono = hostMonotonicMs();
      tx.run('INSERT INTO live_journal(live_session_id,provider_sequence,kind,text,finished,value,tool_json,terminal_outcome,rejected_kind,rejected_sequence,payload_bytes,arrived_at,connection_epoch,provider_event_id,provider_start_ms,provider_end_ms,received_mono_ms,clock_domain,final_origin,finalized_at,finalized_mono_ms) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?)',
        [handle.liveSessionId,event.sequence,kind,text,finished,value,toolJSON,bytes,now,handle.connection.epoch,
          transcription?.providerEventId ?? null,transcription?.providerStartMs ?? null,transcription?.providerEndMs ?? null,mono,hostClockDomain,
          finished === 1 ? transcription?.finalOrigin ?? (this.#profile.provider === 'gemini' ? 'provider' : 'unknown') : null,
          finished === 1 ? now : null,finished === 1 ? mono : null]);
      tx.run('UPDATE live_sessions SET journal_events=?, journal_bytes=?, ready=CASE WHEN ?=1 THEN 1 ELSE ready END, updated_at=? WHERE live_session_id=?',
        [events, total, kind === 'ready' ? 1 : 0, now, handle.liveSessionId]);
      const journalId = Number(tx.get('SELECT journal_id FROM live_journal WHERE live_session_id=? ORDER BY journal_id DESC LIMIT 1', [handle.liveSessionId])!['journal_id']);
      if (handle.pendingDiagnosticLoss) tx.run("UPDATE live_sessions SET diagnostic_metadata_state='partial',diagnostic_content_state='partial',diagnostic_failures=MAX(COALESCE(diagnostic_failures,0),1),diagnostic_last_reason='store_unavailable' WHERE live_session_id=?", [handle.liveSessionId]);
      if (transcription) {
        const turnId = handle.connection.turnId;
        if (turnId !== undefined) {
          // L2-R1: live_journal keeps its fragments and its empty closing row; the audit row is where the
          // assembled utterance belongs, so trace_utterance final=1 answers "what was said".
          const said = finished === 1 && !text?.length ? finishedUtterance(tx, handle.liveSessionId, transcription.type) : text ?? '';
          try { tx.run('INSERT INTO trace_utterance(turn_id,role,at,final,text,journal_id) VALUES (?,?,?,?,?,?)', [turnId,transcription.type === 'inputTranscription' ? 'owner' : 'model',now,finished === 1 ? 1 : 0,said,journalId]); }
          catch { markDiagnosticLoss(tx,handle.liveSessionId,'trace_write_failed'); hostLogEvent({ event: 'live_trace_rejected',kind: 'turn.opened',code: 'record_failed' }); }
        } else if (text?.length) tx.run('UPDATE live_sessions SET diagnostic_unattributed_transcripts=COALESCE(diagnostic_unattributed_transcripts,0)+1 WHERE live_session_id=?', [handle.liveSessionId]);
      }
      if (kind === 'inputTranscription' && finished === 1) {
        const ownerTurn = finishedOwnerTurn(tx, handle.liveSessionId);
        // #573: the open tools are checked against the owner's words since the model last spoke, so a
        // provider that finalizes one utterance as two turns still carries the whole ask.
        if (ownerTurn) noteOwnerWords(handle.liveSessionId, ownerTurn);
        // W6 item 6: the composed note listens to the same finalized owner turn, and to nothing else.
        if (ownerTurn && transcription?.finalOrigin !== 'typed') pendingOwnerText = ownerTurn;
      }
      return journalId;
    };
    const journalSequence = transaction ? persist(transaction) : this.#store.transaction(persist);
    if (!transaction && kind === 'inputTranscription') {
      if (pendingOwnerFragment) this.#noteFragment(handle);
      if (pendingOwnerText !== undefined) {
        const block = this.#store.transaction(tx => Number(tx.get("SELECT MAX(journal_id) AS id FROM live_journal WHERE live_session_id=? AND kind='outputTranscription'", [handle.liveSessionId])?.['id'] ?? 0));
        this.#noteRequests.get(handle.liveSessionId)?.observeOwner(block, Number(journalSequence), pendingOwnerText);
        this.#noteOwnerTurn(handle, pendingOwnerText);
      }
    }
    if (!transaction && (kind === 'outputTranscription' || kind === 'turnComplete')) this.#noteOutput(handle, kind, text ?? '');
    if (!transaction) handle.pendingDiagnosticLoss = false;
    handle.journalEvents = events;
    handle.journalBytes = total;
    return journalSequence;
  }

  #settled(handle: ActiveSession): boolean { return handle.terminal || handle.invalidated; }

  #settle(handle: ActiveSession, outcome: LiveTerminalOutcome, complete: boolean, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): void {
    this.#noteRequests.get(handle.liveSessionId)?.disconnect();
    this.#noteRequests.delete(handle.liveSessionId);
    this.#noteSpeech.delete(handle.liveSessionId);
    this.#noteOnset.delete(handle.liveSessionId);
    this.#noteSessions.delete(handle.liveSessionId);
    this.#noteReadback.delete(handle.liveSessionId);
    if (handle.terminal) return;
    // Fence input and output before any operation that can fail or reenter.
    handle.terminal = true;
    handle.terminalOutcome = outcome;
    handle.diagnosticTerminalCode = 'code' in outcome ? outcome.code : outcome.state;
    const attempt = (action: () => void): void => {
      try { action(); } catch (error) { handle.persistFailure ??= error; }
    };
    let journalSequence: number | undefined;
    try {
      attempt(() => this.#store.transaction(tx => tx.run("UPDATE lux_note_stages SET state='invalidated',code='disconnected' WHERE live_session_id=? AND state IN ('staged','armed','settling')", [handle.liveSessionId])));
      attempt(() => handle.abort.abort());
      attempt(() => handle.researchLedger.close());
      attempt(() => handle.consumer.dropAudio());
      attempt(() => handle.session.close());
    } finally {
      attempt(() => this.#closeTurn(handle, 'session_end'));
      attempt(() => this.#tools?.owner.releaseEvidence(handle.liveSessionId));
      attempt(() => { handle.sessionTimer?.cancel(); handle.callTimer?.cancel(); handle.idleTimer?.cancel();
        handle.muteTimer?.cancel(); handle.mutedOfferTimer?.cancel(); handle.inputFinalTimer?.cancel(); });
      attempt(() => {
        journalSequence = this.#store.transaction(tx => {
          if (outcome.state === 'closed') this.#keepUnheard(handle, tx);
          if (handle.pendingDiagnosticLoss) tx.run("UPDATE live_sessions SET diagnostic_metadata_state='partial',diagnostic_content_state='partial',diagnostic_failures=MAX(COALESCE(diagnostic_failures,0),1),diagnostic_last_reason='store_unavailable' WHERE live_session_id=?", [handle.liveSessionId]);
          return this.#terminalInTx(tx, handle.liveSessionId, outcome, complete, this.#now(), consumerState, rejected);
        });
      });
      attempt(() => this.#observeState(handle, 'ended', 'settle'));
      attempt(() => this.#onSessionTerminal?.(handle.liveSessionId));
      if (journalSequence !== undefined) attempt(() => this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'terminal', sequence: null, journalSequence: journalSequence!, text: null, finished: null, value: null } }));
      attempt(() => handle.consumer.close());
      handle.resolveDone();
    }
    this.#emitDiagnostics(handle);
    if (handle.persistFailure) console.error(JSON.stringify({ event: 'live_terminal_write_failed', liveSessionId: handle.liveSessionId,
      code: handle.diagnosticTerminalCode, class: 'Error' }));
  }

  /**
   * #589: the owner's own finalized sentence, with her name at an edge, ends the call. The gate is the
   * host's, so no model turn, tool or generation stands in the stop path; settling closes the provider
   * session (cancelling any answer in flight), drops every later mic frame and sends the one end frame
   * native acts on, the session's own terminal.
   */
  #finalizeOwnerInput(handle: ActiveSession, generation: number, finalOrigin?: string): void {
    if (handle.stopFinalJournalId === handle.inputJournalId || handle.terminal || generation !== handle.generation) return;
    handle.stopFinalJournalId = handle.inputJournalId;
    if (handle.stopInputAt === undefined || this.#now() - handle.stopInputAt >= 3_000) return;
    // A fallback can finalize the last text row rather than writing an empty final marker.
    const text = this.#store.transaction(tx => {
      const rows = tx.all("SELECT text,finished FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' AND journal_id>? ORDER BY journal_id DESC", [handle.liveSessionId, handle.stopAfterJournalId ?? 0]);
      const pending: string[] = [];
      for (const [i, row] of rows.entries()) {
        if (i > 0 && Number(row['finished']) === 1) break;
        pending.unshift(String(row['text'] ?? ''));
      }
      return pending.join('');
    });
    this.#voiceStopGate(handle, { type: 'inputTranscription', text, finished: true, finalOrigin } as LiveVoiceEvent, generation, true);
  }

  #voiceStopGate(handle: ActiveSession, event: LiveVoiceEvent, generation: number, final = false): void {
    if (event.type !== 'inputTranscription') return;
    if (handle.muted || handle.terminal || generation !== handle.generation || event.finalOrigin === 'typed') return;
    const now = this.#now();
    if (handle.stopGeneration !== generation || handle.stopInputAt === undefined || now - handle.stopInputAt >= 3_000) {
      handle.stopWords = [];
      handle.stopAfterJournalId = handle.inputJournalId ?? 0;
      handle.stopGeneration = generation;
    }
    const words = normalizeStopSpeech(event.text).split(' ').filter(Boolean);
    const window = final ? words.slice(-STOP_WORD_LIMIT) : [...(handle.stopWords ?? []), ...words].slice(-STOP_WORD_LIMIT);
    if (!final && words.length) { handle.stopWords = window; handle.stopInputAt = now; }
    const aliasId = window.map(stopNameId).find(id => id >= 0);
    const matched = stopPhrase(window.join(' ')) !== null;
    if (matched) this.#settle(handle, { state: 'closed', code: 'voice_stop' }, true, 'ended', null);
    if (aliasId !== undefined) hostLogEvent({ event: 'voice_stop_candidate', aliasId, windowWords: window.length, matched, finished: event.finished === true });
    if (matched) hostLogEvent({ event: 'voice_stop' });
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
    tx.run("UPDATE live_sessions SET diagnostic_metadata_state=CASE WHEN diagnostic_metadata_state='in_progress' THEN 'complete' ELSE diagnostic_metadata_state END,diagnostic_content_state=CASE WHEN diagnostic_content_state='in_progress' THEN 'complete' ELSE diagnostic_content_state END WHERE live_session_id=?", [liveSessionId]);
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
export function createLiveSessionOwner(config: LiveOwnerConfig & { vaultTransport?: ReturnType<typeof createLuxWriteTransport> }): LiveSessionOwner {
  return new LiveSessionOwner(config);
}

function memoryProjection(value: unknown): import('./types.js').LiveMemoryProjection {
  if (typeof value !== 'string') return { status: 'empty', selected: 0, omitted: 0 };
  const provenance = JSON.parse(value) as import('./types.js').LiveMemoryProvenance;
  return { status: provenance.status, selected: provenance.selectedIds.length, omitted: provenance.omitted.length };
}
