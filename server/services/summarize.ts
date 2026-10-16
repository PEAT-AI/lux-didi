import type { ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';
import { deadlineAt } from '../adapters/model/types.js';
import type { StorePort, Transaction } from '../contracts/storage.js';
import * as summaries from '../domain/summaries.js';

/**
 * Distil one finished Live conversation into a private summary (W13), off the
 * request path. The service owns the model call and the retry policy; the
 * domain owns the durable row.
 */

export const SUMMARY_PROMPT_VERSION = 'conversation-summary-v1';
/** The distiller uses the text model the host already configures for chat and tools, never the Live voice model. */
export const SUMMARY_TEMPERATURE = 0.2;
export const DISTILLATION_INPUT_MAX_CHARS = 24_000;
export const DISTILLATION_INPUT_HEAD_CHARS = 4_000;
export const DISTILLATION_INPUT_TAIL_CHARS = 20_000;
/** Up to two more attempts, only for transport or provider errors. */
export const SUMMARY_MAX_RETRIES = 2;
/** The default wall-clock budget, in milliseconds, for one distillation model call. */
export const SUMMARY_DEADLINE_BUDGET_MS = 30_000;
/** The newest failed-deadline sessions a single host start re-queues; older ones wait for a later start. */
export const SUMMARY_RECOVERY_LIMIT = 30;
export const SUMMARY_MIN_OWNER_TURNS = 2;

/** Architect-authored distillation prompt, copied verbatim. */
export const DISTILLATION_PROMPT = `You write a short private summary of one finished voice conversation between the owner and Naya, so Naya can
recall it in a later conversation. Output JSON: {"skip": boolean, "summary": string}.

Write 2 to 4 plain sentences in the past tense: what the owner wanted, what was found or decided, and anything
the owner explicitly said was still to do. Attribute every claim: "the owner said", "Naya found in the
calendar", "Naya could not find". Never present something Naya said as a fact the owner confirmed; a short
"yes" or "okay" from the owner confirms nothing.

The transcript is automatic speech recognition of an owner who speaks English as a second language: names and
numbers may be misheard. If a name looks garbled, describe the person or thing by role instead of guessing a
spelling. Do not repeat content that only came from the earlier summaries listed below unless the owner
discussed it again in this conversation. Leave out small talk, greetings, tests of the app and anything about
how the app or Naya works. Set skip to true when nothing worth remembering happened.`;

export interface DistillationTurn { readonly speaker: 'owner' | 'naya'; readonly text: string }

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
  readonly turns: readonly DistillationTurn[];
  readonly toolNames: readonly string[];
  readonly dateMs: number;
  readonly timeZone: string;
  readonly injected: readonly { readonly id: string; readonly summary: string }[];
}): { readonly text: string; readonly truncated: boolean } {
  const parts: string[] = [`Session date: ${localDate(input.dateMs, input.timeZone)} (${input.timeZone})`];
  if (input.injected.length) {
    parts.push('Summaries already shown to Naya in this conversation:');
    for (const item of input.injected) parts.push(`- ${item.id}: ${item.summary}`);
  }
  if (input.toolNames.length) parts.push(`Tools Naya used: ${[...new Set(input.toolNames)].join(', ')}`);
  parts.push('Transcript:');
  for (const turn of input.turns) parts.push(`${turn.speaker === 'owner' ? 'Owner' : 'Naya'}: ${turn.text}`);
  return capDistillationInput(parts.join('\n'));
}

export interface SessionTranscript {
  readonly turns: readonly DistillationTurn[];
  readonly toolNames: readonly string[];
  readonly ownerTurns: number;
  readonly endedAt: number | null;
  readonly createdAt: number;
}

/** Read finished owner and Naya turns in order, plus the tool names used (never tool results). */
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
    else turns.push({ speaker: 'naya', text });
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
export function parseDistillationResult(text: string): { skip: boolean; summary: string } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[0]); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['skip'] !== 'boolean' || typeof record['summary'] !== 'string') return null;
  return { skip: record['skip'], summary: record['summary'].trim() };
}

export interface SummarizerLogEvent { readonly event: string; readonly [key: string]: unknown }

export interface SummarizerOptions {
  readonly store: StorePort;
  /** Null when no text model is configured: no row is written, so a later start retries. */
  readonly model: ModelPort | null;
  readonly modelId: string;
  readonly timeZone: string;
  readonly now: () => number;
  readonly log: (event: SummarizerLogEvent) => void;
  /** A relative budget in milliseconds; the summarizer turns it into an absolute epoch. */
  readonly deadlineBudgetMs?: number;
}

export interface Summarizer {
  /** Fire-and-forget from the Live terminal path; never awaited by close. */
  schedule(liveSessionId: string): void;
  /** Distil every ended session without a row, one at a time. */
  reconcile(): Promise<void>;
  /** Host start: re-run distillation once for failed-deadline sessions whose journal survives, newest first. */
  requeueFailed(): Promise<void>;
  distill(liveSessionId: string, options?: { deadHost?: boolean }): Promise<void>;
}

const RETRYABLE: ReadonlySet<string> = new Set(['error', 'deadline', 'cancelled']);

export function createSummarizer(options: SummarizerOptions): Summarizer {
  let chain: Promise<void> = Promise.resolve();
  const serialize = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work, work);
    return chain;
  };

  async function callModel(input: string, signal: AbortSignal): Promise<ModelResult> {
    const request: ModelRequest = {
      system: DISTILLATION_PROMPT,
      promptVersion: SUMMARY_PROMPT_VERSION,
      contents: [{ role: 'user', parts: [{ text: input }] }],
      dataClasses: ['ordinary'],
      context: { items: [], selectedIds: [], maxChars: 0 },
      temperature: SUMMARY_TEMPERATURE,
      responseMimeType: 'application/json',
    };
    return options.model!.generate(request, { signal, deadlineMs: deadlineAt(Date.now(), options.deadlineBudgetMs ?? SUMMARY_DEADLINE_BUDGET_MS) });
  }

  async function distill(liveSessionId: string, runOptions: { deadHost?: boolean } = {}): Promise<void> {
    if (!options.model) return;
    const prepared = options.store.transaction(tx => {
      const existing = summaries.getBySession(tx, liveSessionId);
      if (existing) return null;
      const transcript = readSessionTranscript(tx, liveSessionId);
      const injectedIds = summaries.injectedSummaryIdsForSession(tx, liveSessionId);
      const injected = injectedIds
        .map(id => tx.get("SELECT id, summary FROM conversation_summaries WHERE id=? AND status='complete'", [id]))
        .filter((row): row is NonNullable<typeof row> => !!row && typeof row['summary'] === 'string')
        .map(row => ({ id: String(row['id']), summary: String(row['summary']) }));
      const grant = tx.get('SELECT chosen_input_class FROM live_grants WHERE live_session_id=?', [liveSessionId]);
      const dataClass = grant && typeof grant['chosen_input_class'] === 'string' ? String(grant['chosen_input_class']) : 'ordinary';
      return { transcript, injected, dataClass };
    });
    if (!prepared) return;
    const { transcript, injected } = prepared;
    const endedAt = transcript.endedAt ?? options.now();
    // Privacy: only ordinary-class Live sessions are distilled; anything else is sealed skipped,
    // mirroring the voice memory source which never lets a non-ordinary label leave the port.
    if (prepared.dataClass !== 'ordinary') {
      options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'skipped', endedAt, inputTruncated: !!runOptions.deadHost, injectedSummaryIds: injected.map(i => i.id), now: options.now() }));
      options.log({ event: 'conversation_summary_skipped', liveSessionId, reason: 'non_ordinary' });
      return;
    }
    if (transcript.ownerTurns < SUMMARY_MIN_OWNER_TURNS) {
      options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'skipped', endedAt, inputTruncated: !!runOptions.deadHost, injectedSummaryIds: injected.map(i => i.id), now: options.now() }));
      options.log({ event: 'conversation_summary_skipped', liveSessionId, reason: 'too_few_turns' });
      return;
    }
    const input = buildDistillationInput({ turns: transcript.turns, toolNames: transcript.toolNames, dateMs: endedAt, timeZone: options.timeZone, injected });
    const truncated = input.truncated || !!runOptions.deadHost;
    options.log({ event: 'conversation_summary_started', liveSessionId, inputChars: input.text.length, truncated });
    const startedAt = options.now();
    let retryCount = 0;
    let lastError = 'unknown';
    for (;;) {
      let result: ModelResult | null = null;
      try {
        const controller = new AbortController();
        result = await callModel(input.text, controller.signal);
      } catch (error) {
        lastError = error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.message) ? error.message : 'model_error';
      }
      if (result && !RETRYABLE.has(result.status)) {
        const parsed = parseDistillationResult(result.text);
        if (!parsed) {
          options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'failed', endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, errorCode: 'invalid_output', now: options.now() }));
          options.log({ event: 'conversation_summary_failed', liveSessionId, errorCode: 'invalid_output', retryCount });
          return;
        }
        if (parsed.skip || !parsed.summary) {
          options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'skipped', endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, now: options.now() }));
          options.log({ event: 'conversation_summary_skipped', liveSessionId, reason: 'model_skip' });
          return;
        }
        options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'complete', summary: parsed.summary, endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, now: options.now() }));
        options.log({ event: 'conversation_summary_completed', liveSessionId, inputChars: input.text.length, outputChars: parsed.summary.length, durationMs: options.now() - startedAt, truncated, retryCount });
        return;
      }
      lastError = result ? result.status : lastError;
      if (retryCount >= SUMMARY_MAX_RETRIES) break;
      retryCount += 1;
    }
    options.store.transaction(tx => summaries.insertSummary(tx, { liveSessionId, status: 'failed', endedAt, model: options.modelId, inputChars: input.text.length, inputTruncated: truncated, injectedSummaryIds: injected.map(i => i.id), retryCount, errorCode: lastError, now: options.now() }));
    options.log({ event: 'conversation_summary_failed', liveSessionId, errorCode: lastError, retryCount });
  }

  /**
   * Host start: recover summaries lost while the deadline bug was live. Failed-deadline rows whose
   * journal still exists are removed and distilled once more through the normal path; only the newest
   * `SUMMARY_RECOVERY_LIMIT` are retried, older ones are counted and left for a later start.
   */
  async function requeueFailed(): Promise<void> {
    if (!options.model) return;
    const candidates = options.store.transaction(tx => summaries.failedDeadlineSessionsWithJournal(tx, SUMMARY_RECOVERY_LIMIT));
    const total = options.store.transaction(tx => summaries.countFailedDeadlineSessionsWithJournal(tx));
    options.log({ event: 'conversation_summary_recovery', requeued: candidates.length, skipped: Math.max(0, total - candidates.length) });
    for (const candidate of candidates) {
      await serialize(async () => {
        const removed = options.store.transaction(tx => summaries.removeFailed(tx, candidate.liveSessionId));
        if (removed) await distill(candidate.liveSessionId);
      });
    }
  }

  return {
    schedule(liveSessionId: string): void {
      void serialize(() => distill(liveSessionId)).catch(() => { /* never surfaces on the close path */ });
    },
    async reconcile(): Promise<void> {
      const pending = options.store.transaction(tx => summaries.endedSessionsWithoutSummary(tx));
      for (const session of pending) {
        await serialize(() => distill(session.liveSessionId, { deadHost: session.deadHost }));
      }
    },
    distill(liveSessionId: string, runOptions?: { deadHost?: boolean }): Promise<void> {
      return serialize(() => distill(liveSessionId, runOptions));
    },
    requeueFailed,
  };
}
