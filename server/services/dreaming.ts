/**
 * The dreaming pass (M9, #914): after a finished owner call, read its turns and summary, ask the
 * helper's text model for typed memory operations with turn provenance, validate them here and
 * commit them to `memory_items` in one transaction under the current generation.
 *
 * The host lives for one call (the app closes its stdin at every call end, server/host/runtime.ts),
 * so the pass runs from two places and never from a nightly timer: right after that call's summary
 * settles, and as a bounded backlog batch at every host start once the listener serves.
 *
 * Nothing here is on the voice path: the opener, the audio and the call start never wait for a job.
 */
import type { DataClass, ModelPort, ModelRequest, ModelResult } from '../adapters/model/types.js';
import { deadlineAt } from '../adapters/model/types.js';
import type { StorePort, Transaction } from '../contracts/storage.js';
import { historySessionEvidence, ownerMemorySession, ownerMemorySessionSql } from '../domain/history-lifecycle.js';
import {
  activeItems, claimJob, completeJob, failJob, generationNow, insertItem, invalidateItem, job, supersedeItem,
  type MemoryItem,
} from '../domain/memory-items.js';
import { getBySession as summaryForSession } from '../domain/summaries.js';
import { DREAMING_PROMPT_VERSION, dreamingExtractorPrompt } from '../prompt/dreaming-extractor.js';

export const DREAMING_EXTRACTOR_VERSION = 'dreaming-v1';
/** One model request at a time, and at most this many substantive sessions per host start. */
export const DREAMING_BACKLOG_LIMIT = 12;
/** A call below this floor carries nothing to remember: it is marked done without a model request. */
export const DREAMING_FLOOR_MIN_OWNER_TURNS = 2;
export const DREAMING_FLOOR_MIN_OWNER_CHARS = 60;
/** A job that failed this often is left alone: the backlog never spends the same call forever. */
export const DREAMING_MAX_ATTEMPTS = 2;
/** A transient state carries a validity date unless the call stated one. */
export const DREAMING_TRANSIENT_VALIDITY_DAYS = 30;
export const DREAMING_DEADLINE_BUDGET_MS = 60_000;
export const DREAMING_MAX_OPERATIONS = 24;
export const DREAMING_TEXT_MAX_CHARS = 400;
/** Active items offered to the extractor: ranked by term overlap with the call's own words. */
export const DREAMING_RELATED_ITEMS = 10;
const DREAMING_CANDIDATE_SCAN = 400;

export const MEMORY_KINDS = ['durable_fact', 'preference', 'person_role', 'transient_state', 'plan', 'promise',
  'open_question', 'correction', 'decision'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export interface MemoryBody {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly subject: string;
  /** 0 to 3, evidence based: 3 when he said it matters, 0 when incidental. */
  readonly salience: number;
  readonly eventText: string | null;
  readonly eventAt: number | null;
  readonly eventTz: string | null;
  readonly place: string | null;
  readonly validUntil: number | null;
}

export type DreamingOperation =
  | { readonly op: 'add'; readonly item: MemoryBody; readonly turnStartId: number; readonly turnEndId: number }
  | { readonly op: 'supersede'; readonly oldId: string; readonly item: MemoryBody; readonly turnStartId: number; readonly turnEndId: number }
  | { readonly op: 'invalidate'; readonly id: string; readonly reason: string; readonly turnStartId: number; readonly turnEndId: number }
  | { readonly op: 'noop'; readonly reason: string };

export interface RejectedOperation { readonly op: string; readonly reason: string; readonly turnStartId?: number }
export interface OperationContext {
  readonly turnIds: ReadonlySet<number>;
  /** Owner turns that read as the owner correcting something; only these may touch an explicit item. */
  readonly correctionTurnIds: ReadonlySet<number>;
  readonly items: readonly MemoryItem[];
  readonly now: number;
}
export interface ValidatedOperations { readonly accepted: readonly DreamingOperation[]; readonly rejected: readonly RejectedOperation[] }

const SUBJECT_PATTERN = /^[a-z0-9][a-z0-9:_./ -]{0,63}$/i;
const CORRECTION_CUE = /\b(actually|no,|not anymore|correction|i said|it'?s not|instead|scrap that|forget that)\b/i;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
function epochOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
function turnIdOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseBody(raw: Record<string, unknown>): MemoryBody | string {
  const kind = text(raw['kind']);
  if (kind === null || !(MEMORY_KINDS as readonly string[]).includes(kind)) return 'unknown_kind';
  const body = text(raw['text']);
  if (body === null) return 'empty_text';
  if (body.length > DREAMING_TEXT_MAX_CHARS) return 'text_too_long';
  const subject = text(raw['subject']);
  if (subject === null || !SUBJECT_PATTERN.test(subject)) return 'unknown_subject';
  const salience = raw['salience'];
  if (salience === undefined || salience === null) return 'missing_salience';
  if (typeof salience !== 'number' || !Number.isInteger(salience) || salience < 0 || salience > 3) return 'invalid_salience';
  const eventAt = epochOrNull(raw['event_at']);
  if (eventAt === undefined) return 'unparsable_event_at';
  const validUntil = epochOrNull(raw['valid_until']);
  if (validUntil === undefined) return 'unparsable_valid_until';
  return { kind: kind as MemoryKind, text: body, subject: subject.toLowerCase(), salience,
    eventText: text(raw['event_text']), eventAt, eventTz: text(raw['event_tz']), place: text(raw['place']), validUntil };
}

/** Read the model's JSON into operations; a malformed element is rejected and named, never written. */
export function parseExtraction(raw: string): { readonly operations: readonly DreamingOperation[]; readonly rejected: readonly RejectedOperation[] } {
  const operations: DreamingOperation[] = [];
  const rejected: RejectedOperation[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { operations, rejected: [{ op: 'document', reason: 'invalid_json' }] }; }
  const list = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['operations'] : undefined;
  if (!Array.isArray(list)) return { operations, rejected: [{ op: 'document', reason: 'missing_operations' }] };
  for (const element of list.slice(0, DREAMING_MAX_OPERATIONS)) {
    if (element === null || typeof element !== 'object') { rejected.push({ op: 'unknown', reason: 'not_an_object' }); continue; }
    const op = element as Record<string, unknown>;
    const name = text(op['op']) ?? 'unknown';
    if (name === 'noop') { operations.push({ op: 'noop', reason: text(op['reason']) ?? 'model_noop' }); continue; }
    const start = turnIdOf(op['turn_start_id']);
    const end = turnIdOf(op['turn_end_id']);
    if (start === null || end === null) { rejected.push({ op: name, reason: 'missing_turn_ids' }); continue; }
    if (name === 'invalidate') {
      const id = text(op['id']);
      if (id === null) { rejected.push({ op: name, reason: 'missing_target', turnStartId: start }); continue; }
      operations.push({ op: 'invalidate', id, reason: text(op['reason']) ?? 'invalidated', turnStartId: start, turnEndId: end });
      continue;
    }
    if (name !== 'add' && name !== 'supersede') { rejected.push({ op: name, reason: 'unknown_operation', turnStartId: start }); continue; }
    const body = parseBody(op);
    if (typeof body === 'string') { rejected.push({ op: name, reason: body, turnStartId: start }); continue; }
    if (name === 'add') { operations.push({ op: 'add', item: body, turnStartId: start, turnEndId: end }); continue; }
    const oldId = text(op['old_id']);
    if (oldId === null) { rejected.push({ op: name, reason: 'missing_target', turnStartId: start }); continue; }
    operations.push({ op: 'supersede', oldId, item: body, turnStartId: start, turnEndId: end });
  }
  if (list.length > DREAMING_MAX_OPERATIONS) {
    for (let index = DREAMING_MAX_OPERATIONS; index < list.length; index += 1) rejected.push({ op: 'document', reason: 'over_cap' });
  }
  return { operations, rejected };
}

function normalizeForDuplicate(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
}

/** The owner's own turns that read as a correction: the only licence to touch an `explicit_owner` item. */
export function ownerCorrectionTurnIds(turns: readonly { readonly id: number; readonly role: string; readonly text: string }[]): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const turn of turns) if (turn.role === 'owner' && CORRECTION_CUE.test(turn.text)) ids.add(turn.id);
  return ids;
}

/**
 * The TypeScript gate between the model and the store: every op cites a turn of this session, an
 * `explicit_owner` item is untouchable without a cited owner correction turn, a duplicate becomes a
 * noop, and a transient state gets a validity date.
 */
export function validateOperations(operations: readonly DreamingOperation[], context: OperationContext): ValidatedOperations {
  const accepted: DreamingOperation[] = [];
  const rejected: RejectedOperation[] = [];
  const targets = new Map(context.items.map(item => [item.id, item]));
  const known = new Set(context.items.map(item => `${item.subject}\u0000${normalizeForDuplicate(item.text)}`));
  const cites = (start: number, end: number): boolean => context.turnIds.has(start) && context.turnIds.has(end) && start <= end;
  const touchable = (target: MemoryItem, start: number, end: number): boolean => target.authority === 'derived'
    || [...context.correctionTurnIds].some(id => id >= start && id <= end);
  const admit = (operation: { readonly item: MemoryBody; readonly turnStartId: number; readonly turnEndId: number; readonly op: 'add' | 'supersede'; readonly oldId?: string }): void => {
    const body = operation.item;
    const key = `${body.subject}\u0000${normalizeForDuplicate(body.text)}`;
    if (known.has(key)) { accepted.push({ op: 'noop', reason: 'duplicate' }); return; }
    known.add(key);
    const validUntil = body.kind === 'transient_state' && body.validUntil === null
      ? context.now + DREAMING_TRANSIENT_VALIDITY_DAYS * 24 * 60 * 60 * 1_000 : body.validUntil;
    const withValidity: MemoryBody = validUntil === body.validUntil ? body : { ...body, validUntil };
    accepted.push(operation.op === 'add'
      ? { op: 'add', item: withValidity, turnStartId: operation.turnStartId, turnEndId: operation.turnEndId }
      : { op: 'supersede', oldId: String(operation.oldId), item: withValidity, turnStartId: operation.turnStartId, turnEndId: operation.turnEndId });
  };
  for (const operation of operations) {
    if (operation.op === 'noop') { accepted.push(operation); continue; }
    if (!cites(operation.turnStartId, operation.turnEndId)) {
      rejected.push({ op: operation.op, reason: 'turn_outside_session', turnStartId: operation.turnStartId });
      continue;
    }
    if (operation.op === 'add') { admit(operation); continue; }
    const targetId = operation.op === 'supersede' ? operation.oldId : operation.id;
    const target = targets.get(targetId);
    if (target === undefined) { rejected.push({ op: operation.op, reason: 'unknown_target', turnStartId: operation.turnStartId }); continue; }
    if (!touchable(target, operation.turnStartId, operation.turnEndId)) {
      rejected.push({ op: operation.op, reason: 'explicit_owner_protected', turnStartId: operation.turnStartId });
      continue;
    }
    if (operation.op === 'invalidate') { accepted.push(operation); continue; }
    admit(operation);
  }
  return { accepted, rejected };
}

export interface DreamingTurn { readonly id: number; readonly role: 'owner' | 'assistant'; readonly text: string; readonly at: number }
export interface DreamingSession {
  readonly id: string;
  readonly turns: readonly DreamingTurn[];
  readonly summary: string | null;
  readonly timeZone: string;
  readonly dataClass: DataClass | null;
  /** Journal finals that never reached `history_turns`: what the pass cannot see (lux 99329). */
  readonly coverageGap: number;
}

function sessionTimeZone(tx: Transaction, liveSessionId: string, fallback: string): string {
  const row = tx.get('SELECT time_zone FROM sessions WHERE id=?', [liveSessionId]);
  const zone = row === undefined ? null : String(row['time_zone']);
  return zone !== null && zone.length > 0 ? zone : fallback;
}

function coverageGapOf(tx: Transaction, liveSessionId: string): number {
  const finals = tx.all(`SELECT kind,text FROM live_journal WHERE live_session_id=? AND finished=1
      AND kind IN ('inputTranscription','outputTranscription')`, [liveSessionId]);
  if (finals.length === 0) return 0;
  const logged = new Set(tx.all('SELECT role,text FROM history_turns WHERE live_session_id=?', [liveSessionId])
    .map(row => `${String(row['role'])}\u0000${String(row['text']).trim()}`));
  let gap = 0;
  for (const row of finals) {
    const role = String(row['kind']) === 'inputTranscription' ? 'owner' : 'assistant';
    if (!logged.has(`${role}\u0000${String(row['text']).trim()}`)) gap += 1;
  }
  return gap;
}

export function readDreamingSession(store: StorePort, liveSessionId: string, fallbackTimeZone: string): DreamingSession {
  return store.transaction(tx => {
    const turns = tx.all('SELECT id,role,text,at FROM history_turns WHERE live_session_id=? ORDER BY id', [liveSessionId])
      .map(row => ({ id: Number(row['id']), role: String(row['role']) === 'owner' ? 'owner' as const : 'assistant' as const,
        text: String(row['text']), at: Number(row['at']) }));
    const summary = summaryForSession(tx, liveSessionId);
    const evidence = historySessionEvidence(tx, liveSessionId);
    return { id: liveSessionId, turns, summary: summary?.summary ?? null,
      timeZone: sessionTimeZone(tx, liveSessionId, fallbackTimeZone),
      dataClass: evidence === null ? null : evidence.dataClass, coverageGap: coverageGapOf(tx, liveSessionId) };
  });
}

/** A call earns the extractor's request only when its owner said something twice, and at some length. */
function belowSubstantiveFloor(turns: readonly DreamingTurn[]): boolean {
  const owner = turns.filter(turn => turn.role === 'owner');
  const chars = owner.reduce((total, turn) => total + turn.text.trim().length, 0);
  return owner.length < DREAMING_FLOOR_MIN_OWNER_TURNS || chars < DREAMING_FLOOR_MIN_OWNER_CHARS;
}

function localStamp(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(ms));
}

/** The extraction request: the call's clock, its turns with ids and local times, its summary, the items it may touch. */
export function buildDreamingInput(input: {
  readonly assistantName: string; readonly session: DreamingSession; readonly items: readonly MemoryItem[];
}): string {
  const parts: string[] = [
    `Call (${input.session.timeZone}), last turn at ${localStamp(input.session.turns.at(-1)?.at ?? 0, input.session.timeZone)}`,
    'Transcript, one line per turn:',
  ];
  for (const turn of input.session.turns) {
    parts.push(`#${turn.id} ${turn.role === 'owner' ? 'Owner' : input.assistantName} (${localStamp(turn.at, input.session.timeZone)}): ${turn.text}`);
  }
  parts.push(input.session.summary === null
    ? 'The call has no summary row; the turns are the only evidence.'
    : `Summary of this call: ${input.session.summary}`);
  parts.push(input.items.length === 0 ? 'Memory items she holds on these subjects: none.'
    : `Memory items she holds on these subjects (supersede or invalidate only by id): ${input.items.map(item => `${item.id} [${item.authority}] ${item.subject}: ${item.text}`).join(' | ')}`);
  return parts.join('\n');
}

function terms(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 4))];
}

/** The active items whose subject or text shares a word with this call, newest first, bounded. */
function relatedItems(tx: Transaction, call: string): readonly MemoryItem[] {
  const wanted = new Set(terms(call));
  const scored = activeItems(tx, { limit: DREAMING_CANDIDATE_SCAN })
    .map(item => ({ item, score: terms(`${item.subject} ${item.text}`).filter(word => wanted.has(word)).length }))
    .filter(entry => entry.score > 0);
  scored.sort((left, right) => right.score - left.score || right.item.createdAt - left.item.createdAt);
  return scored.slice(0, DREAMING_RELATED_ITEMS).map(entry => entry.item);
}

export interface DreamingOutcome {
  readonly status: 'done' | 'skipped' | 'failed' | 'already_done';
  readonly reason?: string;
  readonly ops: Readonly<Record<string, number>>;
  readonly rejected: number;
  readonly coverageGap: number;
  readonly elapsedMs: number;
}
export interface DreamingBatchOutcome {
  readonly processed: number;
  readonly remaining: number;
  readonly ops: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
}

export interface DreamingOptions {
  readonly store: StorePort;
  /** Null when no text model is configured: every job then records why it could not run. */
  readonly model: ModelPort | null;
  readonly modelId: string;
  readonly modelAllowedClasses?: readonly DataClass[];
  readonly assistantName: string;
  readonly timeZone: string;
  readonly now: () => number;
  readonly log: (event: { readonly event: string } & Record<string, unknown>) => void;
  readonly deadlineBudgetMs?: number;
}

export interface Dreaming {
  /** Fire-and-forget: the call's summary has settled, so its turns are ready. Never awaited by the voice path. */
  schedule(liveSessionId: string): void;
  runSession(liveSessionId: string): Promise<DreamingOutcome>;
  /** Newest unprocessed owner sessions, one model request at a time, at most `limit` per host start. */
  backlogBatch(limit?: number): Promise<DreamingBatchOutcome>;
  /** The host is closing: a queued job settles as skipped instead of touching a closed store. */
  stop(): void;
}

const NO_OPS: Readonly<Record<string, number>> = Object.freeze({});

/** Counts by operation as `add:1 supersede:2`: what the log line carries, never the item's words. */
function opsLine(ops: Readonly<Record<string, number>>): string {
  return Object.keys(ops).sort().map(name => `${name}:${ops[name]}`).join(' ');
}

function countOps(operations: readonly DreamingOperation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const operation of operations) counts[operation.op] = (counts[operation.op] ?? 0) + 1;
  return counts;
}

export function createDreaming(options: DreamingOptions): Dreaming {
  const system = dreamingExtractorPrompt(options.assistantName);
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  async function callModel(input: string, dataClass: DataClass): Promise<ModelResult> {
    const request: ModelRequest = {
      system, promptVersion: DREAMING_PROMPT_VERSION,
      contents: [{ role: 'user', parts: [{ text: input }] }],
      dataClasses: [dataClass],
      context: { items: [], selectedIds: [], maxChars: 0 },
      temperature: 0.1,
      responseMimeType: 'application/json',
    };
    return options.model!.generate(request, { signal: new AbortController().signal,
      deadlineMs: deadlineAt(options.now(), options.deadlineBudgetMs ?? DREAMING_DEADLINE_BUDGET_MS) });
  }

  function applyOperation(tx: Transaction, operation: DreamingOperation, session: DreamingSession): void {
    if (operation.op === 'noop') return;
    const now = options.now();
    if (operation.op === 'invalidate') { invalidateItem(tx, operation.id, operation.reason); return; }
    const body = operation.item;
    const created = insertItem(tx, { kind: body.kind, text: body.text, subject: body.subject, salience: body.salience,
      authority: 'derived', eventAt: body.eventAt, eventTz: body.eventTz, eventText: body.eventText, place: body.place,
      validFrom: session.turns.find(turn => turn.id === operation.turnStartId)?.at ?? now, validUntil: body.validUntil,
      createdAt: now, createdBy: `dreaming:${DREAMING_EXTRACTOR_VERSION}`,
      sources: [{ sessionId: session.id, turnStartId: operation.turnStartId, turnEndId: operation.turnEndId }] });
    if (operation.op === 'supersede') supersedeItem(tx, operation.oldId, created.id, now);
  }

  async function runSession(liveSessionId: string): Promise<DreamingOutcome> {
    const startedAt = options.now();
    if (closed) return { status: 'skipped', reason: 'host_closed', ops: NO_OPS, rejected: 0, coverageGap: 0, elapsedMs: 0 };
    const session = readDreamingSession(options.store, liveSessionId, options.timeZone);
    const skipped = (reason: string): DreamingOutcome => ({ status: 'skipped', reason, ops: NO_OPS, rejected: 0,
      coverageGap: session.coverageGap, elapsedMs: options.now() - startedAt });
    if (!options.store.transaction(tx => ownerMemorySession(tx, liveSessionId))) return skipped('not_owner_session');
    if (session.turns.length === 0) return skipped('no_turns');
    if (session.dataClass === null) return skipped('history_provenance_unavailable');
    if (options.model === null || !(options.modelAllowedClasses ?? []).includes(session.dataClass)) return skipped('no_text_model');
    const existing = options.store.transaction(tx => job(tx, liveSessionId, DREAMING_EXTRACTOR_VERSION));
    if (existing !== null && existing.state === 'done') {
      return { status: 'already_done', ops: NO_OPS, rejected: 0, coverageGap: session.coverageGap, elapsedMs: options.now() - startedAt };
    }
    if (belowSubstantiveFloor(session.turns)) {
      const floor = options.store.transaction(tx => claimJob(tx, liveSessionId, DREAMING_EXTRACTOR_VERSION, startedAt));
      options.store.transaction(tx => completeJob(tx, floor.id, session.turns.at(-1)?.id ?? 0, options.now()));
      options.log({ event: 'dreaming_done', liveSessionId, jobId: floor.id, outcome: 'skipped_below_floor', ops: opsLine(NO_OPS),
        rejected: 0, coverageGap: session.coverageGap, elapsedMs: options.now() - startedAt });
      return skipped('skipped_below_floor');
    }
    if (existing !== null && existing.state === 'failed' && existing.attempts >= DREAMING_MAX_ATTEMPTS) return skipped('attempts_exhausted');
    const claim = options.store.transaction(tx => claimJob(tx, liveSessionId, DREAMING_EXTRACTOR_VERSION, startedAt));
    const items = options.store.transaction(tx => relatedItems(tx, `${session.turns.map(turn => turn.text).join(' ')} ${session.summary ?? ''}`));
    const result = await callModel(buildDreamingInput({ assistantName: options.assistantName, session, items }), session.dataClass);
    if (result.status !== 'complete') {
      const reason = `model_${result.status === 'empty' ? 'empty_output' : String(result.reason || result.status)}`.slice(0, 120);
      options.store.transaction(tx => failJob(tx, claim.id, reason, options.now()));
      options.log({ event: 'dreaming_failed', liveSessionId, jobId: claim.id, reason });
      return { status: 'failed', reason, ops: NO_OPS, rejected: 0, coverageGap: session.coverageGap, elapsedMs: options.now() - startedAt };
    }
    const parsed = parseExtraction(result.text);
    const validated = validateOperations(parsed.operations, { turnIds: new Set(session.turns.map(turn => turn.id)),
      correctionTurnIds: ownerCorrectionTurnIds(session.turns), items, now: options.now() });
    const rejected = [...parsed.rejected, ...validated.rejected];
    for (const rejection of rejected) options.log({ event: 'dreaming_op_rejected', liveSessionId, op: rejection.op, reason: rejection.reason });
    const ops = countOps(validated.accepted);
    const commit: { failure: string | null } = { failure: null };
    try {
      options.store.transaction(tx => {
        if (generationNow(tx) !== claim.generation) throw new Error('generation_stale');
        for (const operation of validated.accepted) applyOperation(tx, operation, session);
        if (!completeJob(tx, claim.id, session.turns.at(-1)?.id ?? 0, options.now())) throw new Error('generation_stale');
      });
    } catch (error) {
      commit.failure = (error instanceof Error ? error.message : 'write_failed').slice(0, 120);
      options.store.transaction(tx => failJob(tx, claim.id, String(commit.failure), options.now()));
    }
    const elapsedMs = options.now() - startedAt;
    if (commit.failure !== null) {
      options.log({ event: 'dreaming_failed', liveSessionId, jobId: claim.id, reason: commit.failure });
      return { status: 'failed', reason: commit.failure, ops: NO_OPS, rejected: rejected.length, coverageGap: session.coverageGap, elapsedMs };
    }
    options.log({ event: 'dreaming_done', liveSessionId, jobId: claim.id, ops: opsLine(ops), rejected: rejected.length,
      coverageGap: session.coverageGap, elapsedMs });
    return { status: 'done', ops, rejected: rejected.length, coverageGap: session.coverageGap, elapsedMs };
  }

  /** Ended owner sessions with turns of their own, newest first, minus the ones whose job is spent. */
  function candidates(limit: number): readonly string[] {
    return options.store.transaction(tx => tx.all(
      `SELECT s.live_session_id AS id
         FROM live_sessions s
        WHERE s.lifecycle='terminal' AND s.journal_complete=1 AND ${ownerMemorySessionSql('s')}
          AND NOT EXISTS (SELECT 1 FROM history_exclusions h WHERE h.source_kind='live' AND h.source_id=s.live_session_id)
          AND EXISTS (SELECT 1 FROM history_turns t WHERE t.live_session_id=s.live_session_id)
          AND NOT EXISTS (SELECT 1 FROM memory_jobs j WHERE j.session_id=s.live_session_id
                            AND j.extractor_version=? AND j.state='failed' AND j.attempts>=?)
        ORDER BY (s.terminal_at IS NULL), s.terminal_at DESC, s.created_at DESC
        LIMIT ?`, [DREAMING_EXTRACTOR_VERSION, DREAMING_MAX_ATTEMPTS, limit]).map(row => String(row['id'])));
  }

  return {
    schedule(liveSessionId: string): void {
      chain = chain.then(() => runSession(liveSessionId).then(() => undefined), () => undefined);
    },
    stop(): void { closed = true; },
    runSession(liveSessionId: string): Promise<DreamingOutcome> {
      const next = chain.then(() => runSession(liveSessionId), () => runSession(liveSessionId));
      chain = next.then(() => undefined, () => undefined);
      return next;
    },
    async backlogBatch(limit: number = DREAMING_BACKLOG_LIMIT): Promise<DreamingBatchOutcome> {
      const startedAt = options.now();
      const pending = candidates(DREAMING_CANDIDATE_SCAN)
        .filter(id => options.store.transaction(tx => job(tx, id, DREAMING_EXTRACTOR_VERSION))?.state !== 'done');
      const ops: Record<string, number> = {};
      let processed = 0;
      let skippedBelowFloor = 0;
      for (const id of pending) {
        if (processed >= limit) break;
        const outcome = await runSession(id);
        if (outcome.reason === 'skipped_below_floor') { skippedBelowFloor += 1; continue; }
        processed += 1;
        for (const [name, count] of Object.entries(outcome.ops)) ops[name] = (ops[name] ?? 0) + count;
      }
      const remaining = Math.max(0, pending.length - processed - skippedBelowFloor);
      const elapsedMs = options.now() - startedAt;
      options.log({ event: 'dreaming_backlog', sessionsProcessed: processed, sessionsSkipped: skippedBelowFloor,
        sessionsRemaining: remaining, ops: opsLine(ops), elapsedMs });
      return { processed, remaining, ops, elapsedMs };
    },
  };
}
