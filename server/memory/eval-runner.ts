/**
 * The memory test (issue #912 part B): score, item by item, what a store copy
 * would have carried at a past moment, and what the first spoken answer was.
 *
 * Runs before every release with no human in the loop. It reads a copy of the
 * store and never writes to it: the only transaction it is given refuses every
 * write, so a harness bug cannot edit what it scores. Offline it never calls a
 * model: substring grading is the whole grade unless a verifier is passed in.
 *
 * Stages that no code on base can serve yet report `not_run` with a reason and
 * are counted as misses only under `--strict`: a live first-answer runner, the
 * class 7 restore tool, and the compiled start block of a future unit.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
import type { DataClass } from '../adapters/model/types.js';
import * as memory from '../domain/memory.js';
import * as summaries from '../domain/summaries.js';
import { createHistoryReader } from '../domain/history-reader.js';
import { HISTORY_CLASSES } from '../domain/history-lifecycle.js';
import { entryAndParentIn } from '../domain/labels.js';
import { loadLiveConfig } from '../config/live.js';
import { listStandingMemory } from '../memory/import.js';
import {
  NAYA_LIVE_BASE,
  TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
  composeLiveInstruction,
  composeLiveSessionInstruction,
} from '../prompt/live-persona.js';

export type MemoryEvalClass = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One golden line. Byte for byte the schema part A labels against. */
export interface GoldenItem {
  readonly id: string;
  readonly class: MemoryEvalClass;
  readonly query: string;
  readonly eval_at: string;
  readonly cutoff_session: string;
  readonly gold_turn_ids: readonly string[];
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
  readonly expect_in_start_block: boolean;
  readonly expect_search: boolean;
  readonly expect_abstain: boolean;
  readonly notes: string;
}

/** The bars. One place, so the owner confirms them in one place. */
export const BARS = Object.freeze({
  onDemandOverall: 0.95,
  onDemandPerClass: 0.9,
  startCoverage: 0.9,
  dateErrors: 0,
  falseMemory: 0,
  correctionMisses: 0,
  restoreMisses: 0,
});

/** Phrases that count as an abstention. Missing evidence is no negative fact. */
export const ABSTENTION_MARKERS: readonly string[] = Object.freeze([
  'found nothing', 'no record', 'nothing that says', 'cannot find', "can't find", 'i have nothing',
  "don't have anything", 'do not have anything',
]);

/** A configured verifier is one structured call, only after substring grading missed. */
export type Verifier = (input: {
  readonly item: GoldenItem;
  readonly stage: 'start' | 'answer';
  readonly text: string;
}) => Promise<{ matched_required: string[]; leaked_forbidden: string[]; denied_before_search: boolean }>;

/** A registered restore tool: identify the conversation a reference names, and hand it back. */
export interface RestoreTool {
  resolve(
    tx: Transaction,
    request: { reference: string; evalAt: number; cutoffMs: number },
  ): { sessionId: string } | null;
}

/**
 * The registration probe. Unit 6's restore tool is the thing that will register
 * itself here; until it exists nothing answers, and a class 7 item reports
 * not_run rather than a fidelity nobody measured.
 */
export function registeredRestoreTool(tx: Transaction): RestoreTool | null {
  void tx;
  return null;
}

/** One recorded first answer, from a runner that has already spoken. */
export interface RecordedAnswer {
  readonly id: string;
  readonly text: string;
  readonly searched: boolean;
  readonly finalToFirstAudioMs?: number;
}

export interface RecordedAnswersFile {
  readonly kind: 'recorded-first-answers';
  readonly model: string;
  readonly answers: readonly RecordedAnswer[];
}

interface StageOutcome {
  status: 'scored' | 'not_run';
  reason: string | null;
  matched: string[];
  missing: string[];
  leaked: string[];
  /** Whether this stage alone carried its needles, never the whole item: a search miss is not a start miss. */
  passed: boolean | null;
}

export interface ItemResult {
  id: string;
  class: MemoryEvalClass;
  cutoff: { session: string; at: string | null };
  start: StageOutcome & { earlierConversationsIncluded: boolean | null };
  search: { status: 'scored' | 'not_run'; reason: string | null; hits: string[]; gold: string[]; overlap: number | null };
  /** Turn one from the start block: did every required needle reach the block's text, memory on. */
  turnOne: { status: 'scored' | 'not_run'; reason: string | null; found: boolean };
  /** The same block with the memory removed: the arm the turn-one claim is measured against. */
  memoryOff: { status: 'scored' | 'not_run'; reason: string | null; found: boolean };
  answer: StageOutcome & { searched: boolean | null; abstained: boolean | null };
  restore: { status: 'scored' | 'not_run'; reason: string | null; fidelity: number | null };
  latency: { finalToFirstAudioMs: number | null };
  verdict: 'pass' | 'miss';
  misses: string[];
  notRun: string[];
}

export interface MemoryEvalReport {
  schemaVersion: 1;
  generatedAt: string;
  store: string;
  golden: string;
  strict: boolean;
  items: number;
  overall: {
    firstAnswer: { scored: number; passed: number; ratio: number | null };
    startCoverage: { scored: number; passed: number; ratio: number | null };
    recallAt5: number | null;
    foundBySearch: number | null;
    turnOneFromStartBlock: number | null;
    turnOneMemoryOff: number | null;
    dateErrors: number;
    falseMemory: number;
    restoreFidelity: number | null;
    latency: { count: number; p50: number | null; p90: number | null };
  };
  classes: Record<string, {
    scored: number; passed: number; ratio: number | null; notRun: number; misses: number;
    /** Gold calls reached by the history search, over the items that search. */
    foundBySearch: number | null;
    /** Items whose required needles all reached the start block at turn one. */
    turnOneFromStartBlock: number | null;
    /** The same measurement with the memory removed from that block. */
    turnOneMemoryOff: number | null;
  }>;
  notRun: Record<string, number>;
  bars: { id: string; bar: number; value: number | null; met: boolean }[];
  exitCode: 0 | 1;
  items_detail: ItemResult[];
}

export interface RunOptions {
  readonly store?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly golden: string;
  readonly out?: string | undefined;
  readonly strict?: boolean | undefined;
  readonly timeZone?: string | undefined;
  readonly answers?: RecordedAnswersFile | undefined;
  readonly verifier?: Verifier | undefined;
  /** The evaluated route's data classes; absent means the owner profile's own, as the live route reads them. */
  readonly classes?: readonly DataClass[] | undefined;
  /** A restore tool under test; absent means the registration probe decides. */
  readonly restoreTool?: RestoreTool | null | undefined;
  readonly now?: (() => number) | undefined;
}

const STATE_FILE = 'state.sqlite';
const DEFAULT_TIME_ZONE = 'UTC';
const TOP_K = 5;

/** A transaction over the copy that can only read: a write is a harness bug, not a state change. */
function readOnlyTransaction(db: DatabaseSync): Transaction {
  return {
    run(): number {
      throw new Error('memory_eval_read_only: the harness never writes to the store it reads');
    },
    all(sql: string, params?: readonly SQLValue[]): SQLRow[] {
      return db.prepare(sql).all(...(params ?? [])) as SQLRow[];
    },
    get(sql: string, params?: readonly SQLValue[]): SQLRow | undefined {
      return db.prepare(sql).get(...(params ?? [])) as SQLRow | undefined;
    },
  };
}

function storeStateFile(options: RunOptions): string {
  const candidates: string[] = [];
  if (options.store !== undefined) candidates.push(join(resolve(options.store), STATE_FILE));
  if (options.dataDir !== undefined) candidates.push(join(resolve(options.dataDir), STATE_FILE));
  if (candidates.length === 0) throw new Error('memory_eval_store_missing: pass --store <copy> or --data-dir <copy>');
  const found = candidates.find(path => existsSync(path));
  if (found === undefined) throw new Error(`memory_eval_store_unreadable: no ${STATE_FILE} under ${candidates.join(' or ')}`);
  return found;
}

/**
 * The data classes the evaluated route reads with. An explicit list wins; otherwise it is the live
 * owner route's own list, from the live.json the live host loads through `loadLiveConfig`, never an
 * ordinary-only constant. A copy with no live route keeps the old ordinary default.
 */
function routeClasses(options: RunOptions, ownerId: string, dataRoot: string): readonly DataClass[] {
  if (options.classes !== undefined) return [...options.classes];
  const loaded = loadLiveConfig({ configDir: join(dataRoot, 'provider-config'), ownerId });
  return loaded.status === 'configured' ? [...loaded.config.profile.route.dataClasses] : ['ordinary'];
}

/** `--classes` names the store's own classes; anything else is a usage error, never a quiet default. */
function parseClasses(value: string): readonly DataClass[] {
  const names = value.split(',').map(name => name.trim()).filter(name => name !== '');
  if (names.length === 0 || names.some(name => !HISTORY_CLASSES.includes(name as DataClass))) {
    throw new Error(`memory_eval_classes_invalid: ${value}; expected ${HISTORY_CLASSES.join(',')}`);
  }
  return [...new Set(names)] as DataClass[];
}

/** Parse the golden file: one JSON object per line, the schema part A writes. */
export function readGolden(path: string): GoldenItem[] {
  const text = readFileSync(path, 'utf8');
  const items: GoldenItem[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`memory_eval_golden_invalid: line ${index + 1} is not JSON`);
    }
    const item = parsed as Partial<GoldenItem>;
    const where = `line ${index + 1}`;
    if (typeof item.id !== 'string' || item.id === '') throw new Error(`memory_eval_golden_invalid: ${where} has no id`);
    if (seen.has(item.id)) throw new Error(`memory_eval_golden_invalid: duplicate id ${item.id}`);
    seen.add(item.id);
    if (!Number.isInteger(item.class) || Number(item.class) < 1 || Number(item.class) > 7) {
      throw new Error(`memory_eval_golden_invalid: ${item.id} has no class 1..7`);
    }
    if (typeof item.query !== 'string') throw new Error(`memory_eval_golden_invalid: ${item.id} has no query`);
    if (typeof item.eval_at !== 'string' || Number.isNaN(Date.parse(item.eval_at))) {
      throw new Error(`memory_eval_golden_invalid: ${item.id} has no parseable eval_at`);
    }
    if (typeof item.cutoff_session !== 'string' || item.cutoff_session === '') {
      throw new Error(`memory_eval_golden_invalid: ${item.id} has no cutoff_session`);
    }
    for (const key of ['required', 'forbidden'] as const) {
      const value = item[key];
      if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        throw new Error(`memory_eval_golden_invalid: ${item.id} has no string list ${key}`);
      }
    }
    // M17: the golden file writes turn ids as numbers; the store joins on their text form.
    const goldTurnIds = item['gold_turn_ids'];
    if (!Array.isArray(goldTurnIds) || goldTurnIds.some(entry => typeof entry !== 'string' && !Number.isInteger(entry))) {
      throw new Error(`memory_eval_golden_invalid: ${item.id} has no string list gold_turn_ids`);
    }
    for (const key of ['expect_in_start_block', 'expect_search', 'expect_abstain'] as const) {
      if (typeof item[key] !== 'boolean') throw new Error(`memory_eval_golden_invalid: ${item.id} has no ${key}`);
    }
    if (typeof item.notes !== 'string') throw new Error(`memory_eval_golden_invalid: ${item.id} has no notes`);
    items.push({ ...item, gold_turn_ids: goldTurnIds.map(entry => String(entry)) } as GoldenItem);
  });
  if (items.length === 0) throw new Error('memory_eval_golden_empty: no items');
  return items;
}

export function readAnswers(path: string): RecordedAnswersFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RecordedAnswersFile>;
  if (parsed.kind !== 'recorded-first-answers' || !Array.isArray(parsed.answers)) {
    throw new Error('memory_eval_answers_invalid: expected a recorded-first-answers file');
  }
  return { kind: 'recorded-first-answers', model: String(parsed.model ?? 'recorded'), answers: parsed.answers };
}

function has(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

/** Session end of the last call the memory may know: the cursor for every read below. */
function cutoffTime(tx: Transaction, sessionId: string): number | null {
  const row = tx.get('SELECT terminal_at, created_at FROM live_sessions WHERE live_session_id=?', [sessionId]);
  if (row === undefined) return null;
  const terminal = Number(row['terminal_at'] ?? 0);
  if (Number.isFinite(terminal) && terminal > 0) return terminal;
  const last = tx.get('SELECT MAX(at) AS at FROM history_turns WHERE live_session_id=?', [sessionId]);
  const at = Number(last?.['at'] ?? 0);
  if (Number.isFinite(at) && at > 0) return at;
  const created = Number(row['created_at'] ?? 0);
  return Number.isFinite(created) && created > 0 ? created : null;
}

/**
 * Compile the block an opening call would carry at `nowMs`: the memory notes and
 * the earlier-conversations section, through the composition the live start uses.
 * Nothing ending after the cutoff reaches it.
 */
export function startBlock(tx: Transaction, input: {
  nowMs: number; cutoffMs: number; timeZone: string; allowedClasses: readonly DataClass[];
  /** False builds the same block with no memory in it: the arm the turn-one claim is measured against. */
  memory?: boolean;
}): {
  text: string;
  earlierConversationsIncluded: boolean;
  records: number;
} {
  const allowedIds = tx
    .all(`SELECT e.id AS id, e.session_id AS session_id, s.ended_at AS ended_at
            FROM entries e JOIN sessions s ON s.id=e.session_id
           WHERE s.ended_at IS NOT NULL AND s.ended_at <= ?
           ORDER BY e.captured_at ASC, e.id ASC`, [input.cutoffMs])
    .filter(row => entryAndParentIn(tx, String(row['id']), String(row['session_id']), input.allowedClasses))
    .map(row => String(row['id']));
  const resolved: memory.ResolvedEntryRecord[] = [];
  for (let offset = 0; offset < allowedIds.length; offset += memory.MAX_RESOLVE_ENTRIES) {
    resolved.push(...memory.resolveEntries(tx, allowedIds.slice(offset, offset + memory.MAX_RESOLVE_ENTRIES)));
  }
  const standing = new Map(listStandingMemory(tx).filter(item => allowedIds.includes(item.id)).map(item => [item.id, item] as const));
  // Standing notes lead in rank order, then the plain entries; the prompt renders them as given.
  const records: { id: string; text: string; capturedAt: string; status: 'current' | 'dated' | 'open' | null }[] = [
    ...[...standing.values()].map(item => ({ id: item.id, text: item.text, capturedAt: item.capturedAt, status: item.status })),
    ...resolved.filter(record => !standing.has(record.entryId)).map(record => ({
      id: record.entryId, text: record.text, capturedAt: new Date(record.capturedAt).toISOString(), status: null,
    })),
  ];
  const earlier = {
    candidates: summaries.injectionCandidates(tx, input.allowedClasses).filter(candidate => candidate.endedAt <= input.cutoffMs),
  };
  const base = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' });
  // M11 owns the composer: the start block's earlier calls are the memory block's summaries, budgeted there.
  const composed = composeLiveSessionInstruction({
    text: base.text,
    tools: [],
    records: records.map(record => ({
      id: record.id,
      text: record.text,
      ...(record.status === null ? {} : { standing: { id: record.id, text: record.text, status: record.status, capturedAt: record.capturedAt } }),
    })),
    memoryBlockInput: {
      now: input.nowMs,
      timeZone: input.timeZone,
      clock: new Intl.DateTimeFormat('en-GB', { timeZone: input.timeZone, dateStyle: 'full', timeStyle: 'short' }).format(input.nowMs),
      items: [],
      entries: input.memory === false ? [] : records.map(record => ({
        id: record.id,
        text: record.text,
        ...(Number.isFinite(Date.parse(record.capturedAt)) ? { capturedAt: Date.parse(record.capturedAt) } : {}),
      })),
      sources: {},
      summaries: input.memory === false ? [] : earlier.candidates.map(candidate => ({ id: candidate.id, sessionId: candidate.liveSessionId, startedAt: candidate.endedAt, text: candidate.summary })),
    },
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    now: input.nowMs,
    timeZone: input.timeZone,
  });
  return { text: composed.text, earlierConversationsIncluded: composed.earlierConversationsIncluded, records: input.memory === false ? 0 : records.length };
}

/** The sessions that hold the gold turns, so a turn id is scored against a real hit. */
function sessionsOfTurns(tx: Transaction, turnIds: readonly string[]): string[] {
  if (turnIds.length === 0) return [];
  const marks = turnIds.map(() => '?').join(',');
  return tx
    .all(`SELECT live_session_id FROM history_turns WHERE id IN (${marks})`, turnIds.map(id => Number(id)))
    .map(row => String(row['live_session_id']));
}

async function gradeStage(input: {
  item: GoldenItem;
  stage: 'start' | 'answer';
  text: string;
  verifier?: Verifier | undefined;
}): Promise<{ matched: string[]; missing: string[]; leaked: string[]; error: string | null }> {
  const matched = input.item.required.filter(needle => has(input.text, needle));
  const leaked = input.item.forbidden.filter(needle => has(input.text, needle));
  if (matched.length === input.item.required.length || input.verifier === undefined) {
    return { matched, missing: input.item.required.filter(needle => !matched.includes(needle)), leaked, error: null };
  }
  // One structured call, only because no substring matched. A failure is a miss, never a pass.
  try {
    const verdict = await input.verifier({ item: input.item, stage: input.stage, text: input.text });
    const verified = input.item.required.filter(needle => verdict.matched_required.includes(needle));
    const leakedByVerifier = input.item.forbidden.filter(needle => verdict.leaked_forbidden.includes(needle));
    const union = [...new Set([...matched, ...verified])];
    return {
      matched: union,
      missing: [...input.item.required].filter(needle => !union.includes(needle)),
      leaked: [...new Set([...leaked, ...leakedByVerifier])],
      error: null,
    };
  } catch (error) {
    return { matched, missing: [...input.item.required], leaked, error: (error as Error).message };
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/** Score every item and return the report plus the release-gate exit code. */
export async function runEval(options: RunOptions): Promise<{ report: MemoryEvalReport; exitCode: 0 | 1 }> {
  const dbPath = storeStateFile(options);
  const golden = readGolden(options.golden);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const strict = options.strict === true;
  const clock = options.now ?? Date.now;
  const answers = new Map((options.answers?.answers ?? []).map(answer => [answer.id, answer] as const));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tx = readOnlyTransaction(db);
  const reader = createHistoryReader(clock);
  const details: ItemResult[] = [];
  const identity = {
    ownerId: String(tx.get('SELECT value FROM runtime_meta WHERE key=?', ['assistantId'])?.['value'] ?? ''),
    authorityEpoch: String(tx.get('SELECT value FROM runtime_meta WHERE key=?', ['authorityEpoch'])?.['value'] ?? ''),
  };
  const allowedClasses = routeClasses(options, identity.ownerId, dirname(dbPath));
  try {
    for (const item of golden) {
      const nowMs = Date.parse(item.eval_at);
      const cutoffMs = cutoffTime(tx, item.cutoff_session);
      const misses: string[] = [];
      const notRun: string[] = [];
      const cutoff = { session: item.cutoff_session, at: cutoffMs === null ? null : new Date(cutoffMs).toISOString() };

      const start: StageOutcome & { earlierConversationsIncluded: boolean | null } = {
        status: 'not_run', reason: null, matched: [], missing: [], leaked: [], passed: null, earlierConversationsIncluded: null,
      };
      const search: ItemResult['search'] = { status: 'not_run', reason: null, hits: [], gold: [], overlap: null };
      const turnOne: ItemResult['turnOne'] = { status: 'not_run', reason: null, found: false };
      const memoryOff: ItemResult['memoryOff'] = { status: 'not_run', reason: null, found: false };
      const answer: StageOutcome & { searched: boolean | null; abstained: boolean | null } = {
        status: 'not_run', reason: null, matched: [], missing: [], leaked: [], passed: null, searched: null, abstained: null,
      };
      const restore: ItemResult['restore'] = { status: 'not_run', reason: null, fidelity: null };
      let latency: number | null = null;

      if (cutoffMs === null) {
        start.reason = 'cutoff_session_missing';
        search.reason = 'cutoff_session_missing';
        answer.reason = 'cutoff_session_missing';
        misses.push('cutoff_session_missing');
      } else {
        // (b) the start block at eval_at, on the memory the cutoff allows.
        const block = startBlock(tx, { nowMs, cutoffMs, timeZone, allowedClasses });
        // Turn one, on the block's own text: the needle either reached the opening call or it did not.
        // Conservative by design, because a paraphrase a model could read is not what this number claims.
        if (item.required.length === 0) {
          turnOne.reason = 'no_required_needles';
          memoryOff.reason = 'no_required_needles';
        } else {
          turnOne.status = 'scored';
          turnOne.found = item.required.every(needle => has(block.text, needle));
          const arm = startBlock(tx, { nowMs, cutoffMs, timeZone, allowedClasses, memory: false });
          memoryOff.status = 'scored';
          memoryOff.found = item.required.every(needle => has(arm.text, needle));
        }
        if (item.expect_in_start_block) {
          const before = misses.length;
          const graded = await gradeStage({ item, stage: 'start', text: block.text, verifier: options.verifier });
          Object.assign(start, {
            status: 'scored', matched: graded.matched, missing: graded.missing, leaked: graded.leaked,
            earlierConversationsIncluded: block.earlierConversationsIncluded,
          });
          for (const needle of graded.missing) misses.push(`start_required:${needle}`);
          for (const needle of graded.leaked) misses.push(`start_forbidden:${needle}`);
          if (graded.error !== null) misses.push(`verifier_error:${graded.error}`);
          start.passed = misses.length === before;
        } else {
          start.reason = 'not_expected_in_start_block';
          notRun.push('start:not_expected_in_start_block');
        }

        // (c) the existing history search, scored on the gold turns it reached.
        if (item.expect_search) {
          const result = reader.read(tx, {
            ownerId: identity.ownerId,
            runId: `memory-eval:${item.id}`,
            routeIdentity: 'memory-eval',
            authorityEpoch: identity.authorityEpoch,
            revision: 1,
            allowedClasses: [...allowedClasses],
          }, { query: item.query, limit: TOP_K, from: new Date(0).toISOString(), to: new Date(cutoffMs).toISOString() });
          const hits = Array.isArray(result.response['hits'])
            ? (result.response['hits'] as { sessionId?: string }[]).map(hit => String(hit.sessionId ?? '')).filter(id => id !== '')
            : [];
          const gold = sessionsOfTurns(tx, item.gold_turn_ids);
          const reached = [...new Set(gold)].filter(session => hits.includes(session));
          search.status = 'scored';
          search.hits = hits.slice(0, TOP_K);
          search.gold = [...new Set(gold)];
          search.overlap = search.gold.length === 0 ? null : reached.length / search.gold.length;
          if (result.response['status'] !== 'ok') misses.push(`search_status:${String(result.response['status'])}`);
          if (search.overlap !== null && search.overlap < 1) misses.push('retrieval_miss');
        } else {
          search.reason = 'not_expected';
          notRun.push('search:not_expected');
        }

        // (d) the first answer: only a configured runner can be scored, never a live one on base.
        const recorded = answers.get(item.id);
        if (recorded === undefined) {
          answer.reason = 'no_runner';
          notRun.push('answer:no_runner');
        } else {
          const before = misses.length;
          const graded = await gradeStage({ item, stage: 'answer', text: recorded.text, verifier: options.verifier });
          const abstained = ABSTENTION_MARKERS.some(marker => has(recorded.text, marker));
          answer.status = 'scored';
          answer.matched = graded.matched;
          answer.missing = graded.missing;
          answer.leaked = graded.leaked;
          answer.searched = recorded.searched;
          answer.abstained = abstained;
          if (recorded.finalToFirstAudioMs !== undefined) latency = recorded.finalToFirstAudioMs;
          for (const needle of graded.missing) misses.push(`answer_required:${needle}`);
          for (const needle of graded.leaked) misses.push(`answer_forbidden:${needle}`);
          if (graded.error !== null) misses.push(`verifier_error:${graded.error}`);
          // Missing evidence is no negative fact: a denial before the search ran is the failure this scores.
          if (item.expect_search && !recorded.searched && abstained) misses.push('denial_before_search');
          if (item.expect_search && !recorded.searched && !abstained) misses.push('search_not_run');
          if (item.expect_abstain && !abstained) misses.push('no_abstention');
          answer.passed = misses.length === before;
        }

        // (e) class 7: call the restore tool when one is registered, else say so.
        if (item.class === 7) {
          const tool = options.restoreTool === undefined ? registeredRestoreTool(tx) : options.restoreTool;
          if (tool === null) {
            restore.reason = 'tool_missing';
            notRun.push('restore:tool_missing');
          } else {
            const found = tool.resolve(tx, { reference: item.query, evalAt: nowMs, cutoffMs });
            const gold = sessionsOfTurns(tx, item.gold_turn_ids);
            const wanted = [...new Set(gold)];
            const matched = found === null ? 0 : wanted.filter(session => session === found.sessionId).length;
            restore.status = 'scored';
            restore.fidelity = wanted.length === 0 ? (found === null ? 0 : 1) : matched / wanted.length;
            if (restore.fidelity < 1) misses.push('restore_miss');
          }
        }
      }

      // --strict buys the misses a missing stage would have produced, never a pass.
      if (strict) for (const stage of notRun) misses.push(`not_run:${stage}`);

      details.push({
        id: item.id,
        class: item.class,
        cutoff,
        start,
        search,
        turnOne,
        memoryOff,
        answer,
        restore,
        latency: { finalToFirstAudioMs: latency },
        verdict: misses.length === 0 ? 'pass' : 'miss',
        misses,
        notRun,
      });
    }
  } finally {
    db.close();
  }

  return finish(details, { golden: options.golden, store: dbPath, strict, now: clock() });
}

function ratio(passed: number, scored: number): number | null {
  return scored === 0 ? null : passed / scored;
}

/** The gold call reached by the history search, over the items that search at all. */
function foundBySearch(items: readonly ItemResult[]): number | null {
  return ratio(items.filter(item => item.search.overlap === 1).length, items.filter(item => item.search.status === 'scored').length);
}

/** Turn one, over the items whose needles were graded at turn one: memory on, or the memory-off arm. */
function foundAtTurnOne(items: readonly ItemResult[], stage: 'turnOne' | 'memoryOff'): number | null {
  const graded = items.filter(item => item[stage].status === 'scored');
  return ratio(graded.filter(item => item[stage].found).length, graded.length);
}

function finish(
  details: readonly ItemResult[],
  input: { golden: string; store: string; strict: boolean; now: number },
): { report: MemoryEvalReport; exitCode: 0 | 1 } {
  const strictMiss = (item: ItemResult): boolean => input.strict && item.notRun.length > 0;
  const itemMiss = (item: ItemResult): boolean => item.verdict === 'miss' || strictMiss(item);
  const startScored = details.filter(item => item.start.status === 'scored');
  const answerScored = details.filter(item => item.answer.status === 'scored');
  const classes: MemoryEvalReport['classes'] = {};
  for (let index = 1; index <= 7; index += 1) {
    const inClass = details.filter(item => item.class === index);
    const scored = inClass.filter(item => !strictMiss(item));
    classes[String(index)] = {
      scored: scored.length,
      passed: scored.filter(item => item.verdict === 'pass').length,
      ratio: ratio(scored.filter(item => item.verdict === 'pass').length, scored.length),
      notRun: inClass.filter(item => item.notRun.length > 0).length,
      misses: inClass.filter(item => item.verdict === 'miss').length,
      foundBySearch: foundBySearch(inClass),
      turnOneFromStartBlock: foundAtTurnOne(inClass, 'turnOne'),
      turnOneMemoryOff: foundAtTurnOne(inClass, 'memoryOff'),
    };
  }
  const notRun: Record<string, number> = {};
  for (const item of details) for (const stage of item.notRun) notRun[stage] = (notRun[stage] ?? 0) + 1;
  const latencies = details.map(item => item.latency.finalToFirstAudioMs).filter((value): value is number => value !== null);
  const restores = details.filter(item => item.restore.status === 'scored' && item.restore.fidelity !== null);
  const overall = {
    // Each stage is judged on its own outcome: a search miss is not a start miss, and the other way round.
    firstAnswer: {
      scored: answerScored.length,
      passed: answerScored.filter(item => item.answer.passed === true).length,
      ratio: ratio(answerScored.filter(item => item.answer.passed === true).length, answerScored.length),
    },
    startCoverage: {
      scored: startScored.length,
      passed: startScored.filter(item => item.start.passed === true).length,
      ratio: ratio(startScored.filter(item => item.start.passed === true).length, startScored.length),
    },
    recallAt5: average(details.map(item => item.search.overlap).filter((value): value is number => value !== null)),
    foundBySearch: foundBySearch(details),
    turnOneFromStartBlock: foundAtTurnOne(details, 'turnOne'),
    turnOneMemoryOff: foundAtTurnOne(details, 'memoryOff'),
    dateErrors: details.filter(item => item.class === 3 && itemMiss(item)).length,
    falseMemory: details.reduce((total, item) => total + item.start.leaked.length + item.answer.leaked.length, 0),
    restoreFidelity: restores.length === 0 ? null
      : restores.reduce((total, item) => total + Number(item.restore.fidelity), 0) / restores.length,
    latency: { count: latencies.length, p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) },
  };
  const perClassFloor = Math.min(
    ...Object.values(classes).filter(entry => entry.ratio !== null).map(entry => entry.ratio as number),
    Number.POSITIVE_INFINITY,
  );
  const bars: MemoryEvalReport['bars'] = [
    { id: 'onDemandOverall', bar: BARS.onDemandOverall, value: overall.firstAnswer.ratio, met: (overall.firstAnswer.ratio ?? 1) >= BARS.onDemandOverall },
    { id: 'onDemandPerClass', bar: BARS.onDemandPerClass, value: Number.isFinite(perClassFloor) ? perClassFloor : null,
      met: !Number.isFinite(perClassFloor) || perClassFloor >= BARS.onDemandPerClass },
    { id: 'startCoverage', bar: BARS.startCoverage, value: overall.startCoverage.ratio, met: (overall.startCoverage.ratio ?? 1) >= BARS.startCoverage },
    { id: 'dateErrors', bar: BARS.dateErrors, value: overall.dateErrors, met: overall.dateErrors <= BARS.dateErrors },
    { id: 'falseMemory', bar: BARS.falseMemory, value: overall.falseMemory, met: overall.falseMemory <= BARS.falseMemory },
    { id: 'correctionsGreen', bar: BARS.correctionMisses, value: classes['4']!.misses, met: classes['4']!.misses <= BARS.correctionMisses },
    { id: 'restoreGreen', bar: BARS.restoreMisses, value: classes['7']!.misses, met: classes['7']!.misses <= BARS.restoreMisses },
  ];
  const exitCode: 0 | 1 = bars.every(entry => entry.met) ? 0 : 1;
  return {
    exitCode,
    report: {
      schemaVersion: 1,
      generatedAt: new Date(input.now).toISOString(),
      store: input.store,
      golden: input.golden,
      strict: input.strict,
      items: details.length,
      overall,
      classes,
      notRun,
      bars,
      exitCode,
      items_detail: details as ItemResult[],
    },
  };
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

const USAGE = `usage: didi-memory-eval --store <copy> --golden <file> --out <json> [--strict]
                       [--data-dir <copy>] [--answers <recorded-first-answers.json>]
                       [--time-zone <zone>] [--verifier <openai-model>]
                       [--classes <ordinary|private|sensitive>[,<class>...]]

Scores the FIRST answer, never the eventual recovery. Reads the store copy and
never writes it. Without --answers the first-answer and latency stages report
not_run; without --verifier no model is called at all. --verifier needs
OPENAI_API_KEY and is never used by the offline check.`;

const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matched_required', 'leaked_forbidden', 'denied_before_search'],
  properties: {
    matched_required: { type: 'array', items: { type: 'string' } },
    leaked_forbidden: { type: 'array', items: { type: 'string' } },
    denied_before_search: { type: 'boolean' },
  },
} as const;

/**
 * The one structured grading call, at temperature 0 on the helper's OpenAI model.
 * Only reached when no substring matched; a transport error becomes an item miss.
 * The offline check never builds one, so no model is called without --verifier.
 */
export function openaiVerifier(options: {
  apiKey: string;
  model: string;
  endpoint?: string | undefined;
  transport?: typeof globalThis.fetch | undefined;
}): Verifier {
  const call = options.transport ?? globalThis.fetch;
  return async input => {
    const response = await call(options.endpoint ?? 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'memory_eval_verdict', strict: true, schema: VERIFIER_SCHEMA } },
        messages: [
          {
            role: 'system',
            content: 'You grade one memory-eval item. Answer only with the schema: the required substrings the text does carry, '
              + 'the forbidden substrings it leaks, and whether it denied for lack of memory before a search had run. Never guess.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              stage: input.stage, item: input.item.id, query: input.item.query,
              required: input.item.required, forbidden: input.item.forbidden, text: input.text,
            }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`verifier_http_${response.status}`);
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content === '') throw new Error('verifier_empty');
    const verdict = JSON.parse(content) as Record<string, unknown>;
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : [];
    if (!Array.isArray(verdict['matched_required']) || !Array.isArray(verdict['leaked_forbidden'])) {
      throw new Error('verifier_shape');
    }
    return {
      matched_required: strings(verdict['matched_required']),
      leaked_forbidden: strings(verdict['leaked_forbidden']),
      denied_before_search: verdict['denied_before_search'] === true,
    };
  };
}

const VALUE_FLAGS: readonly string[] = Object.freeze(['--store', '--data-dir', '--golden', '--out', '--answers', '--time-zone', '--verifier', '--classes']);
const BOOLEAN_FLAGS: readonly string[] = Object.freeze(['--strict']);

/** A release gate with no human in the loop refuses argv it does not understand. */
function validateArgv(argv: readonly string[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    if (!token.startsWith('--')) throw new Error(`unexpected_argument: ${token}`);
    if (seen.has(token)) throw new Error(`option_given_twice: ${token}`);
    seen.add(token);
    if (VALUE_FLAGS.includes(token)) { index += 2; continue; }
    if (BOOLEAN_FLAGS.includes(token)) { index += 1; continue; }
    throw new Error(`unknown_option: ${token}`);
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/** The CLI entry: exit 1 when any bar is missed. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    validateArgv(argv);
    const golden = flag(argv, '--golden');
    const out = flag(argv, '--out');
    if (golden === undefined || out === undefined) throw new Error('--golden and --out are required');
    const answersPath = flag(argv, '--answers');
    const verifierModel = flag(argv, '--verifier');
    let verifier: Verifier | undefined;
    if (verifierModel !== undefined) {
      const apiKey = process.env['OPENAI_API_KEY'];
      if (apiKey === undefined || apiKey === '') throw new Error('memory_eval_verifier_key_missing: set OPENAI_API_KEY or drop --verifier');
      verifier = openaiVerifier({ apiKey, model: verifierModel });
    }
    const classesFlag = flag(argv, '--classes');
    const result = await runEval({
      golden, out,
      ...(classesFlag === undefined ? {} : { classes: parseClasses(classesFlag) }),
      store: flag(argv, '--store'),
      dataDir: flag(argv, '--data-dir'),
      timeZone: flag(argv, '--time-zone'),
      strict: argv.includes('--strict'),
      ...(answersPath === undefined ? {} : { answers: readAnswers(answersPath) }),
      ...(verifier === undefined ? {} : { verifier }),
    });
    writeFileSync(out, `${JSON.stringify(result.report, null, 2)}\n`);
    report(result.report);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`didi-memory-eval: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
}

function report(summary: MemoryEvalReport): void {
  const open = summary.bars.filter(bar => !bar.met).map(bar => bar.id);
  // The 10.21 table: the same two numbers per class, and the arm with the memory removed. `n/a` is a
  // class with no graded item, never a zero.
  const score = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(2));
  const table = Object.entries(summary.classes).map(([id, entry]) =>
    `class ${id}  found_by_search@5 ${score(entry.foundBySearch)}  turn_one_from_start_block ${score(entry.turnOneFromStartBlock)}  turn_one_memory_off ${score(entry.turnOneMemoryOff)}`);
  table.push(`all      found_by_search@5 ${score(summary.overall.foundBySearch)}  turn_one_from_start_block ${score(summary.overall.turnOneFromStartBlock)}  turn_one_memory_off ${score(summary.overall.turnOneMemoryOff)}`);
  process.stdout.write(`${table.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({
    items: summary.items,
    exitCode: summary.exitCode,
    firstAnswer: summary.overall.firstAnswer,
    startCoverage: summary.overall.startCoverage,
    recallAt5: summary.overall.recallAt5,
    foundBySearch: summary.overall.foundBySearch,
    turnOneFromStartBlock: summary.overall.turnOneFromStartBlock,
    turnOneMemoryOff: summary.overall.turnOneMemoryOff,
    falseMemory: summary.overall.falseMemory,
    dateErrors: summary.overall.dateErrors,
    notRun: summary.notRun,
    missedBars: open.length === 0 ? null : open,
  })}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => { process.stderr.write(`didi-memory-eval: ${(error as Error).message}\n`); process.exitCode = 2; },
  );
}
