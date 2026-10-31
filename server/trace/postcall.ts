/**
 * Tier 3 post-call auto-review. After a call ends this reads the metadata-only host log for that session and
 * names what went wrong. It never reads owner words: every event it accepts is a closed host-log shape (a tool
 * name, a closed code, a count, a duration), an unrecognised key is dropped before it is looked at, and every
 * draft fixture it writes carries a tool name, an argument-key shape, an outcome code and a timing value only.
 *
 * docs/evals.md holds the tier map; this module is called by `scripts/didi-postcall-review` and, behind the
 * default-off `DIDI_POSTCALL_REVIEW=1` setting, from the host's live_end hook.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Who refused: the host before dispatch, the dispatcher, the connector, or the provider. */
export const POSTCALL_LAYERS = ['host', 'dispatch', 'connector', 'provider'] as const;
export type PostcallLayer = (typeof POSTCALL_LAYERS)[number];

/** The finding classes this review recognises. One draft fixture is written per class it finds. */
export const POSTCALL_FINDINGS = [
  'refusal', 'tool_failure', 'claim_without_receipt', 'dead_air', 'reconnect', 'no_provider_audio',
] as const;
export type PostcallFindingClass = (typeof POSTCALL_FINDINGS)[number];

/** A dead-air wait is a finding only past this bound: four seconds is the longest pause the owner is owed. */
export const DEAD_AIR_LIMIT_MS = 4_000;

/** Outcomes that mean the tool failed rather than answered. */
const FAILED_OUTCOMES = ['failed', 'timeout', 'aborted', 'cancelled'] as const;
const REFUSED_OUTCOMES = ['refused', 'blocked'] as const;

interface ToolOutcomeEvent { readonly event: 'tool_call_outcome'; readonly tool: string; readonly outcome: string; readonly code?: string; readonly ms?: number; readonly argKeys?: readonly string[] }
interface ToolRefusedEvent { readonly event: 'live_tool_refused'; readonly tool: string; readonly reason: string }
interface ClassifiedFailureEvent { readonly event: 'tool_classified_failure'; readonly connector: string; readonly code?: string }
interface ClaimEvent { readonly event: 'live_claim_without_call'; readonly ms: number }
interface DeadAirEvent { readonly event: 'live_dead_air'; readonly deadAirMs?: number; readonly msSinceTool?: number; readonly msSinceAudible?: number | null }
interface RecoveryEvent { readonly event: 'live_recovery'; readonly path: string; readonly attempt: number; readonly code: string }
interface TurnOpenEvent { readonly event: 'live_turn_open'; readonly msSinceLastModelAudio: number }

/** Every input this review understands. There is no free-text member, so there is no path that carries one. */
export type PostcallEvent =
  | ToolOutcomeEvent | ToolRefusedEvent | ClassifiedFailureEvent | ClaimEvent | DeadAirEvent
  | RecoveryEvent | TurnOpenEvent;

const TOKEN = /^[A-Za-z0-9_.-]{1,96}$/;
const ARG_KEY_LIMIT = 12;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const token = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);
/** Argument shapes are key names only: the names a call's arguments carried, never their values. */
const argKeys = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > ARG_KEY_LIMIT) return undefined;
  const keys = value.filter(token).map(String);
  return keys.length === value.length ? [...keys].sort() : undefined;
};

/**
 * Read one metadata event. Fields are copied one by one from a whitelist per event name, so an event that
 * carries a stray key (owner content, a provider payload) yields only the shapes named here, or nothing.
 */
export function readEvent(raw: unknown): PostcallEvent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  switch (value['event']) {
    case 'tool_call_outcome': {
      if (!token(value['tool']) || !token(value['outcome'])) return undefined;
      const code = token(value['refusalCode']) ? value['refusalCode'] as string : undefined;
      const ms = count(value['ms']) ? value['ms'] as number : undefined;
      const keys = argKeys(value['argKeys']);
      return { event: 'tool_call_outcome', tool: value['tool'], outcome: value['outcome'],
        ...(code === undefined ? {} : { code }), ...(ms === undefined ? {} : { ms }),
        ...(keys === undefined ? {} : { argKeys: keys }) };
    }
    case 'live_tool_refused':
      if (!token(value['tool']) || !token(value['reason'])) return undefined;
      return { event: 'live_tool_refused', tool: value['tool'], reason: value['reason'] };
    case 'tool_classified_failure': {
      if (!token(value['connector'])) return undefined;
      const code = token(value['code']) ? value['code'] as string : undefined;
      return { event: 'tool_classified_failure', connector: value['connector'], ...(code === undefined ? {} : { code }) };
    }
    case 'live_claim_without_call':
      if (!count(value['ms'])) return undefined;
      return { event: 'live_claim_without_call', ms: value['ms'] };
    case 'live_dead_air': {
      if (count(value['deadAirMs'])) return { event: 'live_dead_air', deadAirMs: value['deadAirMs'] };
      if (!count(value['msSinceTool'])) return undefined;
      const audible = count(value['msSinceAudible']) ? value['msSinceAudible'] as number : undefined;
      return { event: 'live_dead_air', msSinceTool: value['msSinceTool'], msSinceAudible: audible ?? null };
    }
    case 'live_recovery':
      if (!token(value['path']) || !count(value['attempt']) || !token(value['code'])) return undefined;
      return { event: 'live_recovery', path: value['path'], attempt: value['attempt'], code: value['code'] };
    case 'live_turn_open':
      if (!count(value['msSinceLastModelAudio'])) return undefined;
      return { event: 'live_turn_open', msSinceLastModelAudio: value['msSinceLastModelAudio'] };
    default: return undefined;
  }
}

/**
 * One capture, either a JSONL stream of metadata events or a fixture object with an `events` array. Both are
 * read through `readEvent`, so a capture that carries a stray key still yields only the closed shapes.
 */
export function readCapture(fileText: string): PostcallEvent[] {
  const trimmed = fileText.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return readEvents(fileText.split('\n')); }
    const events = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['events'] : undefined;
    if (!Array.isArray(events)) return readEvents(fileText.split('\n'));
    return events.flatMap((raw): PostcallEvent[] => { const event = readEvent(raw); return event === undefined ? [] : [event]; });
  }
  return readEvents(fileText.split('\n'));
}

/** The whole session's events, in order. A JSONL stream with one metadata event per line. */
export function readEvents(lines: Iterable<string>): PostcallEvent[] {
  const events: PostcallEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    const event = readEvent(raw);
    if (event) events.push(event);
  }
  return events;
}

export interface Finding {
  readonly class: PostcallFindingClass;
  readonly count: number;
  /** Metadata only: a tool name, a closed code, a layer, a duration, and an argument key shape. Never a word the
   * owner or the model said, and never an argument value. */
  readonly detail: string;
  readonly layer?: PostcallLayer;
  readonly code?: string;
  readonly tool?: string;
  readonly ms?: number;
  /** The names a call's arguments carried, sorted. A later wagon can build a fixture from this shape. */
  readonly argKeys?: readonly string[];
}

export interface PostcallReview {
  readonly sessionId: string | null;
  readonly events: number;
  readonly findings: readonly Finding[];
}

const deadAirMs = (event: DeadAirEvent): number => event.deadAirMs ?? event.msSinceTool ?? 0;

/** Classify the session. Grouping is by the pair that names a bug: who refused and with which code. */
export function reviewSession(events: readonly PostcallEvent[], sessionId: string | null = null): PostcallReview {
  const refusals = new Map<string, Finding>();
  const failures = new Map<string, Finding>();
  const findings: Finding[] = [];
  let claims = 0;
  let deadAir: number[] = [];
  let reconnects = 0;
  let reconnectCode: string | undefined;
  let silentTurns = 0;
  let silentMs = 0;

  const addRefusal = (layer: PostcallLayer, code: string, tool: string): void => {
    const key = `${layer}:${code}`;
    const seen = refusals.get(key);
    if (seen) refusals.set(key, { ...seen, count: seen.count + 1 });
    else refusals.set(key, { class: 'refusal', count: 1, detail: `${layer} refused ${tool} with ${code}`, layer, code, tool });
  };

  for (const event of events) {
    switch (event.event) {
      case 'live_tool_refused': addRefusal('host', event.reason, event.tool); break;
      case 'tool_classified_failure': addRefusal('connector', event.code ?? 'unclassified', event.connector); break;
      case 'tool_call_outcome': {
        const refused = (REFUSED_OUTCOMES as readonly string[]).includes(event.outcome);
        if (refused) addRefusal('dispatch', event.code ?? event.outcome, event.tool);
        if ((FAILED_OUTCOMES as readonly string[]).includes(event.outcome)) {
          const seen = failures.get(event.tool);
          const ms = event.ms ?? 0;
          if (seen) failures.set(event.tool, { ...seen, count: seen.count + 1, ms: Math.max(seen.ms ?? 0, ms) });
          else failures.set(event.tool, { class: 'tool_failure', count: 1,
            detail: `${event.tool} ${event.outcome}${event.code === undefined ? '' : ` (${event.code})`}`
              + `${event.argKeys === undefined ? '' : ` args {${event.argKeys.join(',')}}`}`,
            tool: event.tool, ms, ...(event.code === undefined ? {} : { code: event.code }),
            ...(event.argKeys === undefined ? {} : { argKeys: event.argKeys }) });
        }
        break;
      }
      case 'live_claim_without_call': claims += 1; break;
      case 'live_dead_air': {
        const ms = deadAirMs(event);
        if (ms > DEAD_AIR_LIMIT_MS) deadAir = [...deadAir, ms];
        break;
      }
      case 'live_recovery': reconnects += 1; reconnectCode = event.code; break;
      // A turn that opens is a turn the host served with no provider audio in front of it; the gap is the cost.
      case 'live_turn_open': silentTurns += 1; silentMs = Math.max(silentMs, event.msSinceLastModelAudio); break;
      default: break;
    }
  }

  findings.push(...refusals.values());
  findings.push(...failures.values());
  if (claims > 0) findings.push({ class: 'claim_without_receipt', count: claims,
    detail: `${claims} claim(s) with no call behind them`, ms: 0 });
  if (deadAir.length > 0) findings.push({ class: 'dead_air', count: deadAir.length,
    detail: `${deadAir.length} wait(s) over ${DEAD_AIR_LIMIT_MS} ms`, ms: Math.max(...deadAir) });
  if (reconnects > 0) findings.push({ class: 'reconnect', count: reconnects,
    detail: `${reconnects} reconnect(s)`, ...(reconnectCode === undefined ? {} : { code: reconnectCode }) });
  if (silentTurns > 0) findings.push({ class: 'no_provider_audio', count: silentTurns,
    detail: `${silentTurns} turn(s) opened with no provider audio`, ms: silentMs });
  return { sessionId, events: events.length, findings };
}

/** The short report a reader opens first. One line per finding, then a verdict line. */
export function renderReport(review: PostcallReview): string {
  const head = [`postcall review ${review.sessionId ?? '(unbound session)'}: ${review.events} metadata event(s)`,
    `findings: ${review.findings.length}`];
  const rows = review.findings.map(finding => `  ${finding.class} x${finding.count}: ${finding.detail}`);
  const verdict = review.findings.length === 0
    ? ['clean: nothing this review recognises went wrong']
    : ['review: these are drafts for a later wagon, nothing was changed'];
  return [...head, ...rows, ...verdict].join('\n') + '\n';
}

export interface DraftFixture {
  readonly class: PostcallFindingClass;
  readonly synthetic: true;
  readonly count: number;
  readonly rows: readonly Record<string, string | number>[];
}

/**
 * Draft fixtures for a later wagon. Every row is a closed metadata tuple; there is no text field, and the
 * shape is enforced by construction rather than by a later scrub.
 */
export function draftFixtures(review: PostcallReview): DraftFixture[] {
  const byClass = new Map<PostcallFindingClass, DraftFixture['rows']>();
  for (const finding of review.findings) {
    const row: Record<string, string | number> = { class: finding.class };
    if (finding.tool !== undefined) row['tool'] = finding.tool;
    if (finding.layer !== undefined) row['layer'] = finding.layer;
    if (finding.code !== undefined) row['code'] = finding.code;
    if (finding.ms !== undefined) row['ms'] = finding.ms;
    // An argument shape as key names, sorted, comma separated: a later wagon can rebuild the call's outline from
    // it without ever holding an argument value.
    if (finding.argKeys !== undefined && finding.argKeys.length > 0) row['argShape'] = [...finding.argKeys].sort().join(',');
    row['count'] = finding.count;
    byClass.set(finding.class, [...(byClass.get(finding.class) ?? []), row]);
  }
  return [...byClass.entries()].map(([findingClass, rows]) => ({ class: findingClass, synthetic: true as const,
    count: rows.reduce((sum, row) => sum + Number(row['count'] ?? 0), 0), rows }));
}

export interface WrittenReview { readonly report: string; readonly drafts: readonly string[] }

/** Write the report and one draft per finding class under `outDir`, which must live outside the repository. */
export function writeReview(review: PostcallReview, outDir: string): WrittenReview {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const report = join(outDir, 'postcall-report.txt');
  writeFileSync(report, renderReport(review), { mode: 0o600 });
  const drafts = draftFixtures(review).map(draft => {
    const path = join(outDir, `draft-${draft.class}.json`);
    writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
    return path;
  });
  return { report, drafts };
}

/** Every event line of the host log that belongs to `liveSessionId`. Read-only; the log is metadata only. */
export function sessionLines(logPath: string, liveSessionId: string): string[] {
  if (!existsSync(logPath)) return [];
  const lines: string[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(liveSessionId)) continue;
    lines.push(trimmed);
  }
  return lines;
}

export interface PostcallOptions { readonly logPath: string; readonly liveSessionId: string; readonly outDir: string }

/** Read one finished session's metadata from the host log and write its review. */
export function postcallReview(options: PostcallOptions): WrittenReview & { readonly review: PostcallReview } {
  const review = reviewSession(readEvents(sessionLines(options.logPath, options.liveSessionId)), options.liveSessionId);
  return { review, ...writeReview(review, options.outDir) };
}

/** The live_end hook. Default off: with `DIDI_POSTCALL_REVIEW` unset this returns at once and never throws. */
export function postcallOnLiveEnd(input: { dataDir: string; liveSessionId: string }): void {
  if (process.env['DIDI_POSTCALL_REVIEW'] !== '1') return;
  try {
    postcallReview({ logPath: join(input.dataDir, 'logs', 'host.log'), liveSessionId: input.liveSessionId,
      outDir: join(input.dataDir, 'postcall') });
  } catch { /* a review never fails a call that already ended */ }
}

const USAGE = `didi-postcall-review [--log <host.log> --session <id>] [--events <jsonl>] [--out <dir>] [--json]

  --log       the host log to read (default <DIDI_STATE_DIR or ~/.lux/didi>/logs/host.log)
  --session   the live session id whose metadata is reviewed
  --events    a metadata-only JSONL capture to review instead of the host log
  --out       where the report and draft fixtures go (default: a local, git-ignored folder)
  --json      print the review as JSON instead of the report
`;

function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

/** The by-hand entry point. Writes only under `--out`, never into the repository. */
export function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const outDir = argument(argv, '--out') ?? join(process.cwd(), 'postcall-drafts');
  const sessionId = argument(argv, '--session') ?? null;
  const eventsPath = argument(argv, '--events');
  const logPath = argument(argv, '--log');
  if (eventsPath === undefined && (logPath === undefined || sessionId === null)) {
    process.stderr.write(`didi-postcall-review: give --events, or --log and --session\n\n${USAGE}`);
    return 2;
  }
  const events = eventsPath !== undefined ? readCapture(readFileSync(eventsPath, 'utf8'))
    : readEvents(sessionLines(logPath as string, sessionId as string));
  const review = reviewSession(events, sessionId);
  const written = writeReview(review, outDir);
  process.stdout.write(argv.includes('--json')
    ? `${JSON.stringify({ ...review, report: written.report, drafts: written.drafts }, null, 2)}\n`
    : `${renderReport(review)}report: ${written.report}\ndrafts: ${written.drafts.length === 0 ? '(none)' : written.drafts.join(', ')}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
