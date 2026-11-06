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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SQLRow, SQLValue, Transaction } from '../contracts/storage.js';
import * as memory from '../domain/memory.js';
import * as summaries from '../domain/summaries.js';
import { createHistoryReader } from '../domain/history-reader.js';
import { entryAndParentOrdinary } from '../domain/labels.js';
import { listStandingMemory } from '../memory/import.js';
import {
  NAYA_LIVE_BASE,
  TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
  buildEarlierConversationsSection,
  composeLiveInstruction,
  composeLiveSessionInstruction,
  earlierConversationsBudget,
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
});

/** Phrases that count as an abstention. Missing evidence is no negative fact. */
export const ABSTENTION_MARKERS: readonly string[] = Object.freeze([
  'found nothing', 'no record', 'nothing that says', 'cannot find', "can't find", 'i have nothing',
]);

/** A configured verifier is one structured call, only after substring grading missed. */
export type Verifier = (input: {
  readonly item: GoldenItem;
  readonly stage: 'start' | 'answer';
  readonly text: string;
}) => Promise<{ matched_required: string[]; leaked_forbidden: string[]; denied_before_search: boolean }>;

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
}

export interface ItemResult {
  id: string;
  class: MemoryEvalClass;
  cutoff: { session: string; at: string | null };
  start: StageOutcome & { earlierConversationsIncluded: boolean | null };
  search: { status: 'scored' | 'not_run'; reason: string | null; hits: string[]; gold: string[]; overlap: number | null };
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
    dateErrors: number;
    falseMemory: number;
    restoreFidelity: number | null;
    latency: { count: number; p50: number | null; p90: number | null };
  };
  classes: Record<string, { scored: number; passed: number; ratio: number | null; notRun: number; misses: number }>;
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
    for (const key of ['gold_turn_ids', 'required', 'forbidden'] as const) {
      const value = item[key];
      if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        throw new Error(`memory_eval_golden_invalid: ${item.id} has no string list ${key}`);
      }
    }
    for (const key of ['expect_in_start_block', 'expect_search', 'expect_abstain'] as const) {
      if (typeof item[key] !== 'boolean') throw new Error(`memory_eval_golden_invalid: ${item.id} has no ${key}`);
    }
    if (typeof item.notes !== 'string') throw new Error(`memory_eval_golden_invalid: ${item.id} has no notes`);
    items.push(item as GoldenItem);
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
export function startBlock(tx: Transaction, input: { nowMs: number; cutoffMs: number; timeZone: string }): {
  text: string;
  earlierConversationsIncluded: boolean;
  records: number;
} {
  const allowedIds = tx
    .all(`SELECT e.id AS id, e.session_id AS session_id, s.ended_at AS ended_at
            FROM entries e JOIN sessions s ON s.id=e.session_id
           WHERE s.ended_at IS NOT NULL AND s.ended_at <= ?
           ORDER BY e.captured_at ASC, e.id ASC`, [input.cutoffMs])
    .filter(row => entryAndParentOrdinary(tx, String(row['id']), String(row['session_id'])))
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
  const earlier = buildEarlierConversationsSection(
    summaries.injectionCandidates(tx).filter(candidate => candidate.endedAt <= input.cutoffMs),
    { now: input.nowMs, timeZone: input.timeZone, maxChars: earlierConversationsBudget(0) },
  );
  const base = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' });
  const composed = composeLiveSessionInstruction({
    text: base.text,
    tools: [],
    records: records.map(record => ({
      id: record.id,
      text: record.text,
      ...(record.status === null ? {} : { standing: { id: record.id, text: record.text, status: record.status, capturedAt: record.capturedAt } }),
    })),
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    ...(earlier.section === '' ? {} : { earlierConversations: earlier.section }),
    now: input.nowMs,
    timeZone: input.timeZone,
  });
  return { text: composed.text, earlierConversationsIncluded: composed.earlierConversationsIncluded, records: records.length };
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
  try {
    for (const item of golden) {
      const nowMs = Date.parse(item.eval_at);
      const cutoffMs = cutoffTime(tx, item.cutoff_session);
      const misses: string[] = [];
      const notRun: string[] = [];
      const cutoff = { session: item.cutoff_session, at: cutoffMs === null ? null : new Date(cutoffMs).toISOString() };

      const start: StageOutcome & { earlierConversationsIncluded: boolean | null } = {
        status: 'not_run', reason: null, matched: [], missing: [], leaked: [], earlierConversationsIncluded: null,
      };
      const search: ItemResult['search'] = { status: 'not_run', reason: null, hits: [], gold: [], overlap: null };
      const answer: StageOutcome & { searched: boolean | null; abstained: boolean | null } = {
        status: 'not_run', reason: null, matched: [], missing: [], leaked: [], searched: null, abstained: null,
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
        if (item.expect_in_start_block) {
          const block = startBlock(tx, { nowMs, cutoffMs, timeZone });
          const graded = await gradeStage({ item, stage: 'start', text: block.text, verifier: options.verifier });
          Object.assign(start, {
            status: 'scored', matched: graded.matched, missing: graded.missing, leaked: graded.leaked,
            earlierConversationsIncluded: block.earlierConversationsIncluded,
          });
          for (const needle of graded.missing) misses.push(`start_required:${needle}`);
          for (const needle of graded.leaked) misses.push(`start_forbidden:${needle}`);
          if (graded.error !== null) misses.push(`verifier_error:${graded.error}`);
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
            allowedClasses: ['ordinary'],
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
        }

        // (e) class 7: the restore tool is not registered on base.
        if (item.class === 7) {
          restore.reason = 'tool_missing';
          notRun.push('restore:tool_missing');
        }
      }

      details.push({
        id: item.id,
        class: item.class,
        cutoff,
        start,
        search,
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
    };
  }
  const notRun: Record<string, number> = {};
  for (const item of details) for (const stage of item.notRun) notRun[stage] = (notRun[stage] ?? 0) + 1;
  const latencies = details.map(item => item.latency.finalToFirstAudioMs).filter((value): value is number => value !== null);
  const restores = details.filter(item => item.restore.status === 'scored' && item.restore.fidelity !== null);
  const overall = {
    firstAnswer: {
      scored: answerScored.length,
      passed: answerScored.filter(item => item.verdict === 'pass').length,
      ratio: ratio(answerScored.filter(item => item.verdict === 'pass').length, answerScored.length),
    },
    startCoverage: {
      scored: startScored.length,
      passed: startScored.filter(item => item.verdict === 'pass').length,
      ratio: ratio(startScored.filter(item => item.verdict === 'pass').length, startScored.length),
    },
    recallAt5: average(details.map(item => item.search.overlap).filter((value): value is number => value !== null)),
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
    { id: 'correctionsGreen', bar: 0, value: classes['4']!.misses, met: classes['4']!.misses === 0 },
    { id: 'restoreGreen', bar: 0, value: classes['7']!.misses, met: classes['7']!.misses === 0 },
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
                       [--time-zone <zone>] [--verifier]

Scores the FIRST answer, never the eventual recovery. Reads the store copy and
never writes it. Without --answers the first-answer and latency stages report
not_run; without --verifier no model is called at all.`;

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
    const golden = flag(argv, '--golden');
    const out = flag(argv, '--out');
    if (golden === undefined || out === undefined) throw new Error('--golden and --out are required');
    const answersPath = flag(argv, '--answers');
    const result = await runEval({
      golden, out,
      store: flag(argv, '--store'),
      dataDir: flag(argv, '--data-dir'),
      timeZone: flag(argv, '--time-zone'),
      strict: argv.includes('--strict'),
      ...(answersPath === undefined ? {} : { answers: readAnswers(answersPath) }),
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
  process.stdout.write(`${JSON.stringify({
    items: summary.items,
    exitCode: summary.exitCode,
    firstAnswer: summary.overall.firstAnswer,
    startCoverage: summary.overall.startCoverage,
    recallAt5: summary.overall.recallAt5,
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
