import { persistHistoryTurns } from '../domain/history-turns.js';
import type { DataClass, ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';
import { deadlineAt } from '../adapters/model/types.js';
import type { StorePort, Transaction } from '../contracts/storage.js';
import { OPEN_TOOL_NAMES } from '../tools/open.js';
import { HISTORY_CLASSES, historyForgotten, historySessionEvidence } from '../domain/history-lifecycle.js';
import * as summaries from '../domain/summaries.js';

/**
 * Distil one finished Live conversation into a private summary (W13), off the
 * request path. The service owns the model call and the retry policy; the
 * domain owns the durable row.
 */

export const SUMMARY_PROMPT_VERSION = 'conversation-summary-v4';
/** The distiller uses the text model the host already configures for chat and tools, never the Live voice model. */
export const SUMMARY_TEMPERATURE = 0.2;
export const DISTILLATION_INPUT_MAX_CHARS = 24_000;
export const DISTILLATION_INPUT_HEAD_CHARS = 4_000;
export const DISTILLATION_INPUT_TAIL_CHARS = 20_000;
/** Up to two more attempts in the same host life, only for transport or provider errors. */
export const SUMMARY_MAX_RETRIES = 2;
/** The wall-clock wait before each in-life retry; the last value repeats if the budget ever grows. */
export const SUMMARY_RETRY_BACKOFF_MS: readonly number[] = [2_000, 10_000];
/** A failed summary is retried at the next host start only after the start-up window, when connectors and keys are up. */
export const SUMMARY_BOOT_REQUEUE_DELAY_MS = 30_000;
/** One session is attempted in at most this many host starts before the reason is closed for good. */
export const SUMMARY_HOST_START_LIMIT = 3;
/** A failed summary older than this is never retried. */
export const SUMMARY_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** The attempt budget across host starts; a start that could exceed it is not begun. */
export const SUMMARY_RETRY_MAX_ATTEMPTS = (SUMMARY_MAX_RETRIES + 1) * SUMMARY_HOST_START_LIMIT;
/** The default wall-clock budget, in milliseconds, for one distillation model call. */
export const SUMMARY_DEADLINE_BUDGET_MS = 30_000;
/** C-SUMMARY8: how long a host start waits for an unfinished call's summary before it serves a call.
 *  The native supervisor fails a launch that has no ready frame within 6 s (NativeServiceSupervisor
 *  `firstFrame(timeout:)`, 6_000_000_000 ns), and boot plus migration spends part of that, so this
 *  bound is the 2 s left over rather than the 30 s a model attempt may take. On expiry the opener
 *  plans without that call and the distillation finishes in the background. */
export const SUMMARY_START_SETTLE_BUDGET_MS = 2_000;
/** C-START10: a graceful host exit grants the pending summary its existing model budget.
 *  A forced supervisor kill can still interrupt it; the durable pending row is recovered at start
 *  without extending the start settle budget. */
export const SUMMARY_EXIT_SETTLE_BUDGET_MS = SUMMARY_DEADLINE_BUDGET_MS;
/** The newest retryable sessions a single host start re-queues; older ones wait for a later start. */
export const SUMMARY_RECOVERY_LIMIT = 30;
export const SUMMARY_MIN_OWNER_TURNS = 2;

/** How long the separate open-loop line may be; the prompt asks for the same bound. */
export const OPEN_LOOP_MAX_CHARS = 120;

/**
 * Architect-authored distillation prompt, v2. The assistant's display name is a parameter, so no persona name
 * is baked into the text; the rules of v1 (two to four attributed sentences, the bare-yes rule, the
 * injected-summary rule, the skip rule) are unchanged.
 */
export function distillationPrompt(assistantName: string): string {
  return `You write a short private summary of one finished voice conversation between the owner and the assistant, whose name is ${assistantName}, so the assistant can
recall it in a later conversation. Output JSON: {"skip": boolean, "summary": string, "openLoop": string | null}.

Write 2 to 4 plain sentences in the past tense: what the owner wanted, what was found or decided, and anything
the owner explicitly said was still to do. Attribute every claim: "the owner said", "${assistantName} found in the
calendar", "${assistantName} could not find". Never present something ${assistantName} said as a fact the owner confirmed; a short
"yes" or "okay" from the owner confirms nothing.

Tool outcomes come only from the Tool outcomes block below: name a failed or refused tool by the code that block
records, never by ${assistantName}'s spoken explanation of it.

Set openLoop to at most ${OPEN_LOOP_MAX_CHARS} characters naming only something the owner explicitly said was still to do,
or null when the owner named nothing. A request of his that failed or came back empty, an ask left unanswered, and a
complaint about the assistant's own voice, accent or answers are still to do, so each one belongs in openLoop.
Never infer a to-do the owner did not say, and never restate the summary.

The transcript is automatic speech recognition of an owner who speaks English as a second language: names and
numbers may be misheard. If a name looks garbled, describe the person or thing by role instead of guessing a
spelling. Do not repeat content that only came from the earlier summaries listed below unless the owner
discussed it again in this conversation. Leave out small talk, greetings, tests of the app and anything about
how the app or the assistant works. Set skip to true when nothing worth remembering happened.`;
}

export interface DistillationTurn { readonly speaker: 'owner' | 'assistant'; readonly text: string }

/** How many tool-call records the Tool outcomes block may show. */
export const TOOL_OUTCOME_MAX_LINES = 20;

/** One terminal tool call as the records hold it: never the assistant's spoken account of it. */
export interface ToolOutcome {
  readonly name: string;
  readonly outcome: 'succeeded' | 'refused' | 'failed' | 'outcome unknown';
  readonly code: string | null;
}

/** The call's terminal class and code, read from the record the tools layer sealed. */
function toolOutcomeOf(row: Record<string, unknown>): ToolOutcome | null {
  const name = row['name'];
  if (typeof name !== 'string' || !name) return null;
  const state = String(row['state']);
  const code = typeof row['code'] === 'string' && row['code'] ? row['code']
    : typeof row['reason'] === 'string' && row['reason'] ? row['reason'] : null;
  // A tool answers "not done" through the completed path, so the sealed response outranks the state: the note and
  // remember tools persist `{staged: false}` / `{remembered: false}`, the vault save `{saved: false}` (json_extract
  // gives integer 0 for JSON false), and the open tools any receipt code other than `opened`.
  const notDone = row['staged'] === 0 || row['remembered'] === 0 || row['saved'] === 0
    || (OPEN_TOOL_NAMES.has(name) && row['code'] !== 'opened');
  const outcome = state === 'failed' ? 'failed'
    : state === 'refused' || (state === 'completed' && notDone) ? (code === 'failed' ? 'failed' : 'refused')
    : state === 'completed' ? 'succeeded' : 'outcome unknown';
  return { name, outcome, code };
}

/** Keep the first 4 000 and the last 20 000 characters, marking the cut. */
export function capDistillationInput(text: string): { text: string; truncated: boolean } {
  if (text.length <= DISTILLATION_INPUT_MAX_CHARS) return { text, truncated: false };
  const head = text.slice(0, DISTILLATION_INPUT_HEAD_CHARS);
  const tail = text.slice(text.length - DISTILLATION_INPUT_TAIL_CHARS);
  return { text: `${head}\n[... transcript shortened ...]\n${tail}`, truncated: true };
}

function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone }).format(new Date(ms));
}

export function buildDistillationInput(input: {
  readonly assistantName: string;
  readonly turns: readonly DistillationTurn[];
  readonly toolNames: readonly string[];
  readonly toolOutcomes?: readonly ToolOutcome[];
  readonly dateMs: number;
  readonly timeZone: string;
  readonly injected: readonly { readonly id: string; readonly summary: string }[];
}): { readonly text: string; readonly truncated: boolean } {
  const parts: string[] = [`Session date: ${localDate(input.dateMs, input.timeZone)} (${input.timeZone})`];
  if (input.injected.length) {
    parts.push(`Summaries already shown to ${input.assistantName} in this conversation:`);
    for (const item of input.injected) parts.push(`- ${item.id}: ${item.summary}`);
  }
  if (input.toolNames.length) parts.push(`Tools ${input.assistantName} used: ${[...new Set(input.toolNames)].join(', ')}`);
  parts.push('Transcript:');
  for (const turn of input.turns) parts.push(`${turn.speaker === 'owner' ? 'Owner' : input.assistantName}: ${turn.text}`);
  const outcomes = input.toolOutcomes ?? [];
  if (outcomes.length) {
    parts.push('Tool outcomes:');
    for (const item of outcomes.slice(0, TOOL_OUTCOME_MAX_LINES)) {
      parts.push(`${item.name} ${item.outcome}${item.code && item.outcome !== 'succeeded' ? ` ${item.code}` : ''}`);
    }
  }
  return capDistillationInput(parts.join('\n'));
}

/** Read the session's tool calls, oldest first, as name, terminal class and code (never arguments or result bodies). */
export function readToolOutcomes(tx: Transaction, liveSessionId: string): readonly ToolOutcome[] {
  if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'", [])) return [];
  const rows = tx.all(`SELECT json_extract(intent_json,'$.toolName') AS name, state,
      json_extract(result_json,'$.response.code') AS code, json_extract(result_json,'$.response.reason') AS reason,
      json_extract(result_json,'$.response.staged') AS staged, json_extract(result_json,'$.response.remembered') AS remembered,
      json_extract(result_json,'$.response.saved') AS saved
    FROM tool_calls WHERE run_id=? ORDER BY created_at, execution_id`, [liveSessionId]);
  return rows.flatMap(row => toolOutcomeOf(row) ?? []);
}

export interface SessionTranscript {
  readonly turns: readonly DistillationTurn[];
  readonly toolNames: readonly string[];
  readonly ownerTurns: number;
  readonly endedAt: number | null;
  readonly createdAt: number;
}

/** Read finished owner and assistant turns in order, plus the tool names used (never tool results). */
export function readSessionTranscript(tx: Transaction, liveSessionId: string): SessionTranscript {
  const session = tx.get('SELECT created_at, terminal_at FROM live_sessions WHERE live_session_id=?', [liveSessionId]);
  const rows = tx.all('SELECT kind, text, tool_json, finished FROM live_journal WHERE live_session_id=? ORDER BY journal_id', [liveSessionId]);
  const turns: DistillationTurn[] = [];
  const toolNames: string[] = [];
  const pending: Record<'inputTranscription' | 'outputTranscription', string> = { inputTranscription: '', outputTranscription: '' };
  let ownerTurns = 0;
  const flush = (kind: 'inputTranscription' | 'outputTranscription') => {
    const text = pending[kind].trim();
    pending[kind] = '';
    if (!text) return;
    if (kind === 'inputTranscription') { ownerTurns += 1; turns.push({ speaker: 'owner', text }); }
    else turns.push({ speaker: 'assistant', text });
  };
  for (const row of rows) {
    const kind = String(row['kind']);
    if (kind === 'inputTranscription' || kind === 'outputTranscription') {
      pending[kind] += String(row['text'] ?? '');
      if (Number(row['finished']) === 1) flush(kind);
    } else if (kind === 'toolCall') {
      try {
        const tool = JSON.parse(String(row['tool_json'] ?? '{}')) as { name?: unknown };
        if (typeof tool.name === 'string' && tool.name) toolNames.push(tool.name);
      } catch { /* a malformed tool record never blocks distillation */ }
    }
  }
  flush('inputTranscription'); flush('outputTranscription');
  return { turns, toolNames, ownerTurns,
    endedAt: session && session['terminal_at'] !== null && session['terminal_at'] !== undefined ? Number(session['terminal_at']) : null,
    createdAt: session ? Number(session['created_at']) : Date.now() };
}

/** Parse the model's JSON, tolerating a fenced block. Returns null on a validation failure. */
export function parseDistillationResult(text: string): { skip: boolean; summary: string; openLoop: string | null } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[0]); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['skip'] !== 'boolean' || typeof record['summary'] !== 'string') return null;
  // The open loop is optional and separate: absent, null, empty or non-string reads as no open loop.
  const openLoop = typeof record['openLoop'] === 'string' ? record['openLoop'].trim().slice(0, OPEN_LOOP_MAX_CHARS).trim() : '';
  return { skip: record['skip'], summary: record['summary'].trim(), openLoop: openLoop === '' ? null : openLoop };
}

export interface SummarizerLogEvent { readonly event: string; readonly [key: string]: unknown }

export interface SummarizerOptions {
  readonly store: StorePort;
  /** Null when no text model is configured: the distiller writes a skipped row naming no_text_model, so the store shows why. */
  readonly model: ModelPort | null;
  readonly modelId: string;
  readonly modelAllowedClasses?: readonly DataClass[];
  /** The persona name the host already knows, used in the prompt and in the speaker tags; never a literal. */
  readonly assistantName: string;
  readonly timeZone: string;
  readonly now: () => number;
  readonly log: (event: SummarizerLogEvent) => void;
  /** A relative budget in milliseconds; the summarizer turns it into an absolute epoch. */
  readonly deadlineBudgetMs?: number;
  /** How the retry and boot waits pass; a test hands in a fake clock, the host leaves it out. */
  readonly delay?: (ms: number) => Promise<void>;
}

export interface Summarizer {
  /** Fire-and-forget from the Live terminal path; a non-forced exit waits for it through settleOnExit. */
  schedule(liveSessionId: string): void;
  /** Distil every ended session without a row, one at a time. */
  reconcile(phase?: SummaryPhase): Promise<void>;
  /** Host start: retry the newest transiently failed sessions whose journal survives, after the boot delay. */
  requeueFailed(): Promise<void>;
  distill(liveSessionId: string, options?: { deadHost?: boolean }): Promise<void>;
  /** Host start: finish every ended session whose summary a previous host did not write, bounded. */
  recoverAtStart(budgetMs?: number): Promise<SummarySettleOutcome>;
  /** Exit the app did not force: finish the summary this call already queued, bounded. */
  settleOnExit(budgetMs?: number): Promise<SummarySettleOutcome>;
}

const RETRYABLE: ReadonlySet<string> = new Set(['error', 'deadline', 'cancelled']);
/** C-SUMMARY8: which wait produced a conversation_summary_* line; the per-call schedule names no phase. */
export type SummaryPhase = 'at_start';
/** Whether a bounded wait finished the work or gave up on it. */
export type SummarySettleOutcome = 'done' | 'timeout';

/** The closed failure classes a row and the log may name, never the provider's own text. */
export type SummaryFailureCode = 'deadline' | 'cancelled' | 'network' | 'credential_unavailable' | 'provider'
  | 'provider_blocked' | 'route_denied' | 'invalid_output' | 'model_error' | 'retry_exhausted';

/** Adapter reason tokens that survive to this layer; anything else is a plain provider failure. */
const FAILURE_BY_REASON: Readonly<Record<string, SummaryFailureCode>> = {
  transport_error: 'network',
  credential_unavailable: 'credential_unavailable',
  provider_finish_error: 'provider',
  model_request_failed: 'provider',
};

function failureCode(result: ModelResult): SummaryFailureCode {
  if (result.status === 'deadline') return 'deadline';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'blocked') return 'provider_blocked';
  if (result.status === 'denied') return 'route_denied';
  return FAILURE_BY_REASON[result.reason] ?? 'provider';
}

const pause = (delay: SummarizerOptions['delay'], ms: number): Promise<void> =>
  ms > 0 ? (delay ? delay(ms) : new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); })) : Promise.resolve();

export function createSummarizer(options: SummarizerOptions): Summarizer {
  let chain: Promise<void> = Promise.resolve();
  const system = distillationPrompt(options.assistantName);
  const serialize = (work: () => Promise<void>): Promise<void> => {
    const guarded = async () => { try { await work(); } catch (error) { if (!(error instanceof Error && ['history_forgotten', 'history_source_changed'].includes(error.message))) throw error; } };
    chain = chain.then(guarded, guarded);
    return chain;
  };

  async function callModel(input: string, dataClass: DataClass, signal: AbortSignal): Promise<ModelResult> {
    const request: ModelRequest = {
      system,
      promptVersion: SUMMARY_PROMPT_VERSION,
      contents: [{ role: 'user', parts: [{ text: input }] }],
      dataClasses: [dataClass],
      context: { items: [], selectedIds: [], maxChars: 0 },
      temperature: SUMMARY_TEMPERATURE,
      responseMimeType: 'application/json',
    };
    return options.model!.generate(request, { signal, deadlineMs: deadlineAt(Date.now(), options.deadlineBudgetMs ?? SUMMARY_DEADLINE_BUDGET_MS) });
  }

  async function distill(liveSessionId: string, runOptions: { deadHost?: boolean; priorRetries?: number; phase?: SummaryPhase } = {}): Promise<void> {
    // C-SUMMARY8: the start-up pass names its phase, so a reader can tell a boot recovery from a call-end one.
    const emit = (event: SummarizerLogEvent): void => { options.log(runOptions.phase === undefined ? event : { ...event, phase: runOptions.phase }); };
    const prepared = options.store.transaction(tx => {
      if (historyForgotten(tx, liveSessionId)) return null;
      const existing = summaries.getBySession(tx, liveSessionId);
      // A row skipped only for a missing text model is not terminal: with a model configured now, the session is
      // distilled again. C-SUMMARY8: neither is the in-flight marker a host exited on, re-distilled from the
      // journal. Every other skip reason and every complete or failed row stays sealed.
      if (existing && !(options.model && (existing.status === 'failed' && existing.errorCode === summaries.PENDING_SUMMARY_ERROR_CODE
        ? summaries.removeFailed(tx, liveSessionId) : summaries.reopenNoModelSkip(tx, liveSessionId)))) return null;
      const transcript = readSessionTranscript(tx, liveSessionId);
      const toolOutcomes = readToolOutcomes(tx, liveSessionId);
      const source = historySessionEvidence(tx, liveSessionId);
      const injectedIds = summaries.injectedSummaryIdsForSession(tx, liveSessionId);
      const selected = source ? summaries.injectionCandidates(tx, HISTORY_CLASSES.filter(value => HISTORY_CLASSES.indexOf(value) <= HISTORY_CLASSES.indexOf(source.dataClass))) : [];
      const injected = injectedIds.flatMap(id => selected.filter(row => row.id === id).map(row => ({ id: row.id, summary: row.summary })));
      return { transcript, toolOutcomes, injected, source: injected.length === injectedIds.length ? source : null };
    });
    if (!prepared) return;
    const { transcript, toolOutcomes, injected, source } = prepared;
    const endedAt = transcript.endedAt ?? options.now();
    if (!source) {
      options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'skipped', skipReason: 'history_provenance_unavailable', endedAt, now: options.now() }));
      emit({ event: 'conversation_summary_skipped', liveSessionId, reason: 'history_provenance_unavailable' });
      return;
    }
    const provenance = { dataClass: source.dataClass, sourceRevision: source.revision };
    const sourceCurrent = () => options.store.transaction(tx => {
      const current = historySessionEvidence(tx, liveSessionId);
      return current?.revision === source.revision && current.dataClass === source.dataClass;
    });
    if (options.model && !options.modelAllowedClasses?.includes(source.dataClass)) {
      options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'skipped', skipReason: 'summary_route_class_denied', endedAt, now: options.now() }));
      emit({ event: 'conversation_summary_skipped', liveSessionId, reason: 'summary_route_class_denied' });
      return;
    }
    if (transcript.ownerTurns < SUMMARY_MIN_OWNER_TURNS) {
      options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'skipped', skipReason: 'too_few_turns', endedAt, inputTruncated: !!runOptions.deadHost, injectedSummaryIds: injected.map(i => i.id), now: options.now() }));
      emit({ event: 'conversation_summary_skipped', liveSessionId, reason: 'too_few_turns' });
      return;
    }
    // No text model configured: record the row and its reason, so the store shows why nothing was distilled.
    if (!options.model) {
      options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'skipped', skipReason: 'no_text_model', endedAt, inputTruncated: !!runOptions.deadHost, injectedSummaryIds: injected.map(i => i.id), now: options.now() }));
      emit({ event: 'conversation_summary_skipped', liveSessionId, reason: 'no_text_model' });
      return;
    }
    // The in-flight row: a host that exits during the model call leaves it for the next start to retry.
    options.store.transaction(tx => summaries.markSummaryPending(tx, liveSessionId, options.now(), provenance));
    const input = buildDistillationInput({ assistantName: options.assistantName, turns: transcript.turns, toolNames: transcript.toolNames, toolOutcomes, dateMs: endedAt, timeZone: options.timeZone, injected });
    const truncated = input.truncated || !!runOptions.deadHost;
    emit({ event: 'conversation_summary_started', liveSessionId, inputChars: input.text.length, truncated });
    const startedAt = options.now();
    const firstRetry = runOptions.priorRetries ?? 0;
    let retryCount = firstRetry;
    let lastError: SummaryFailureCode = 'model_error';
    for (;;) {
      let result: ModelResult | null = null;
      try {
        const controller = new AbortController();
        if (!sourceCurrent()) return;
        if (!options.modelAllowedClasses?.includes(source.dataClass)) {
          options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'skipped', skipReason: 'summary_route_class_denied', endedAt, now: options.now() }));
          return;
        }
        result = await callModel(input.text, source.dataClass, controller.signal);
      } catch (error) {
        // A port that surfaces the credential failure by throwing gets the same rule as one that returns it.
        lastError = error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'model_error';
      }
      if (result && !RETRYABLE.has(result.status)) {
        const parsed = parseDistillationResult(result.text);
        if (!parsed) {
          const sealed: SummaryFailureCode = result.status === 'blocked' || result.status === 'denied' ? failureCode(result) : 'invalid_output';
          options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'failed', promptVersion: SUMMARY_PROMPT_VERSION, endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, errorCode: sealed, now: options.now() }));
          emit({ event: 'conversation_summary_failed', liveSessionId, errorCode: sealed, retryCount });
          return;
        }
        if (parsed.skip || !parsed.summary) {
          options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'skipped', skipReason: 'model_skip', promptVersion: SUMMARY_PROMPT_VERSION, endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, now: options.now() }));
          emit({ event: 'conversation_summary_skipped', liveSessionId, reason: 'model_skip' });
          return;
        }
        options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'complete', summary: parsed.summary, openLoop: parsed.openLoop, promptVersion: SUMMARY_PROMPT_VERSION, endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, now: options.now() }));
        emit({ event: 'conversation_summary_completed', liveSessionId, inputChars: input.text.length, outputChars: parsed.summary.length, durationMs: options.now() - startedAt, truncated, retryCount });
        return;
      }
      lastError = result ? failureCode(result) : lastError;
      // #603: a missing or refused credential is not transient inside one call. Retrying waits the backoff and
      // spends the attempt budget on the same refusal, so this failure closes the row at once and leaves its
      // retry count for the next host start, which is when a credential is up (RETRYABLE_FAILURE_CODES).
      if (lastError === 'credential_unavailable') break;
      if (retryCount - firstRetry >= SUMMARY_MAX_RETRIES) break;
      await pause(options.delay, SUMMARY_RETRY_BACKOFF_MS[Math.min(retryCount - firstRetry, SUMMARY_RETRY_BACKOFF_MS.length - 1)] ?? 0);
      retryCount += 1;
    }
    options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, ...provenance, status: 'failed', promptVersion: SUMMARY_PROMPT_VERSION, endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, errorCode: lastError, now: options.now() }));
    emit({ event: 'conversation_summary_failed', liveSessionId, errorCode: lastError, retryCount });
  }

  /**
   * Host start: retry summaries that failed for a transient reason. When there is anything to retry, the pass
   * waits out the start-up window first, because connectors and credentials are not up in the first seconds
   * after a boot; with nothing to retry it never arms a timer. A row that already spent its attempt budget
   * across host starts, or is older than the age cap, is closed with a final reason instead of being retried.
   * Only the newest `SUMMARY_RECOVERY_LIMIT` are considered in one start.
   */
  async function requeueFailed(): Promise<void> {
    if (!options.model) return;
    const candidates = options.store.transaction(tx => summaries.failedRetryableSessionsWithJournal(tx, SUMMARY_RECOVERY_LIMIT));
    const total = options.store.transaction(tx => summaries.countFailedRetryableSessionsWithJournal(tx));
    if (candidates.length > 0) await pause(options.delay, SUMMARY_BOOT_REQUEUE_DELAY_MS);
    const now = options.now();
    let requeued = 0;
    let skipped = Math.max(0, total - candidates.length);
    for (const candidate of candidates) {
      const expired = candidate.endedAt !== null && now - candidate.endedAt > SUMMARY_RETRY_MAX_AGE_MS;
      const spent = candidate.retryCount + 1 + (SUMMARY_MAX_RETRIES + 1) > SUMMARY_RETRY_MAX_ATTEMPTS;
      if (expired || spent) {
        const closed = options.store.transaction(tx => summaries.closeFailedRetry(tx, candidate.liveSessionId));
        if (closed) options.log({ event: 'conversation_summary_failed', liveSessionId: candidate.liveSessionId, errorCode: 'retry_exhausted', retryCount: candidate.retryCount });
        skipped += 1;
        continue;
      }
      requeued += 1;
      await serialize(async () => {
        const removed = options.store.transaction(tx => summaries.removeFailed(tx, candidate.liveSessionId));
        if (removed) await distill(candidate.liveSessionId, { priorRetries: candidate.retryCount });
      });
    }
    options.log({ event: 'conversation_summary_recovery', requeued, skipped });
  }

  /** One bounded wait: resolves 'timeout' rather than rejecting when the budget runs out, and leaves the
   *  work it raced running, so a slow distillation still writes its row when it finishes. */
  function within(work: Promise<void>, budgetMs: number): Promise<SummarySettleOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<SummarySettleOutcome>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs); });
    return Promise.race([work.then(() => 'done' as const), deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  /** Distil every ended session without a row, one at a time, naming the phase when a start asked for it. */
  async function reconcilePending(phase?: SummaryPhase): Promise<void> {
    const pending = options.store.transaction(tx => summaries.endedSessionsWithoutSummary(tx));
    for (const session of pending) {
      await serialize(() => distill(session.liveSessionId, { deadHost: session.deadHost, ...(phase === undefined ? {} : { phase }) }));
    }
  }

  return {
    schedule(liveSessionId: string): void {
      options.store.transaction(tx => persistHistoryTurns(tx, liveSessionId));
      void serialize(() => distill(liveSessionId)).catch(() => { /* never surfaces on the close path */ });
    },
    reconcile: (phase?: SummaryPhase): Promise<void> => reconcilePending(phase),
    distill(liveSessionId: string, runOptions?: { deadHost?: boolean }): Promise<void> {
      return serialize(() => distill(liveSessionId, runOptions));
    },
    recoverAtStart(budgetMs: number = SUMMARY_START_SETTLE_BUDGET_MS): Promise<SummarySettleOutcome> {
      // C-SUMMARY8: the interrupted in-flight markers first, then the calls that never got one, both before
      // the listener serves a call and therefore before any opener plan is fixed.
      const work = (async () => {
        const now = options.now();
        const interrupted = options.store.transaction(tx => summaries.interruptedSessions(tx, SUMMARY_RECOVERY_LIMIT))
          .filter(session => session.endedAt === null || now - session.endedAt <= SUMMARY_RETRY_MAX_AGE_MS);
        for (const session of interrupted) {
          await serialize(() => distill(session.liveSessionId, { deadHost: session.deadHost, phase: 'at_start' }));
        }
        await reconcilePending('at_start');
      })();
      return within(work, budgetMs);
    },
    settleOnExit(budgetMs: number = SUMMARY_EXIT_SETTLE_BUDGET_MS): Promise<SummarySettleOutcome> {
      return within(chain, budgetMs);
    },
    requeueFailed,
  };
}
