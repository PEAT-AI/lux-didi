// C-LOG-ENVELOPE: the one envelope every host.log line carries. A name says how bad a line is and, where
// the name itself says why, what caused it; the live call's context names the call on every line it emits;
// and a clock_sync line ties this process's monotonic clock to wall time. Ids, tokens and counts only:
// nothing here ever sees owner content.
//
// L2-R1: the context and both per-process counters live here, not on a HostLog instance, because one host
// process runs two HostLog instances (server/host/runtime.ts, server/http/server.ts) and both must stamp
// the same call and the same line sequence.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** L2-R1: why a line happened, closed, so a cause is never inferred from prose. A line whose name says
 *  nothing about its domain carries no cause at all. */
export type LogCause = 'tool' | 'provider' | 'owner' | 'network' | 'audio' | 'host' | 'connector' | 'config';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
export const LOG_CAUSES: readonly LogCause[] = ['tool', 'provider', 'owner', 'network', 'audio', 'host', 'connector', 'config'];

export interface Severity { level: LogLevel; cause?: LogCause }

/** The names whose severity and domain the name itself does not say. Everything else is info, and a
 *  failure suffix is a warn, so a new event is classified safely without editing this table. */
const NAMED: Readonly<Record<string, Severity>> = {
  host_error: { level: 'error', cause: 'host' },
  host_started: { level: 'info', cause: 'host' },
  host_exit: { level: 'info', cause: 'host' },
  clock_sync: { level: 'info', cause: 'host' },
  host_resources: { level: 'debug', cause: 'host' },
  config_seeded: { level: 'info', cause: 'config' },
  live_terminal: { level: 'info', cause: 'owner' },
  live_state: { level: 'debug', cause: 'owner' },
  live_idle_arm: { level: 'debug', cause: 'owner' },
  live_turn_open: { level: 'debug', cause: 'owner' },
  live_turn_script: { level: 'debug', cause: 'owner' },
  live_interrupted: { level: 'info', cause: 'owner' },
  live_mute: { level: 'info', cause: 'audio' },
  live_heard_silence: { level: 'info' },
  live_dead_air: { level: 'warn' },
  live_provider_error: { level: 'warn', cause: 'provider' },
  gptlive_setup_error: { level: 'warn', cause: 'provider' },
  live_stall: { level: 'warn', cause: 'network' },
  live_no_pong: { level: 'warn', cause: 'network' },
  live_upstream_drop: { level: 'warn', cause: 'network' },
  live_recovery: { level: 'warn' },
  live_rebuild: { level: 'warn' },
  live_attach_rejected: { level: 'warn', cause: 'network' },
  live_frame_rejected: { level: 'warn', cause: 'network' },
  live_trace_rejected: { level: 'warn', cause: 'network' },
  uplink_shed: { level: 'warn', cause: 'audio' },
  tool_ceiling_hit: { level: 'warn', cause: 'tool' },
  tool_arguments_rejected: { level: 'warn', cause: 'tool' },
  connector_failure: { level: 'warn', cause: 'connector' },
};

/** A degradation is a warn, an unclassified host_error is an error, and the rest is routine. */
const FAILURE_SUFFIX = /(?:^|_)(?:failed|failure|error|rejected|refused|unavailable|dropped|lost|timeout|stalled)$/;

export function severityOf(name: string): Severity {
  const named = NAMED[name];
  if (named) return named;
  if (FAILURE_SUFFIX.test(name)) return { level: 'warn' };
  return { level: 'info' };
}

/** The live call whose lines this process is writing. One live session is one call (L2-R1), and the
 *  generation names the provider session inside it. */
export interface LogContext {
  liveSessionId: string | null;
  generation: number | null;
  runId: string | null;
  researchId: string | null;
  endpointId: string | null;
  attempt: number | null;
}

const EMPTY: LogContext = { liveSessionId: null, generation: null, runId: null, researchId: null, endpointId: null, attempt: null };
let context: LogContext = { ...EMPTY };

/** Name the call the host is serving. Fields not patched keep their value, so a call patches its own ids. */
export function setLogContext(patch: Partial<LogContext>): void { context = { ...context, ...patch }; }

export function clearLogContext(): void { context = { ...EMPTY }; }

export function logContext(): LogContext { return { ...context }; }

// One line counter and one mono origin per process, like the native journal's: a lost rotation or a torn
// line is then countable, and no wall clock jump can reorder a call.
let lineSeq = 0;
const MONO_ORIGIN = process.hrtime.bigint();

export function nextSeq(): number { return ++lineSeq; }

/** Milliseconds since this process started, from the monotonic clock, never from the wall clock. */
export function monoMilliseconds(): number { return Number((process.hrtime.bigint() - MONO_ORIGIN) / 1_000_000n); }

// The same two shapes the allowlist already admits: an identifier token, and the live session's uuid.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SESSION = /^[0-9a-f-]{36}$/i;

/** The context fields as log fields, dropping anything that is not an identifier: a context can never
 *  widen the allowlist, so no content and no free text crosses here. */
export function envelopeContext(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const token = (key: 'liveSessionId' | 'runId' | 'researchId' | 'endpointId', pattern: RegExp): void => {
    const value = context[key];
    if (value !== null && pattern.test(value)) out[key] = value;
  };
  token('liveSessionId', SESSION);
  token('runId', TOKEN);
  token('researchId', TOKEN);
  token('endpointId', TOKEN);
  if (context.generation !== null && Number.isSafeInteger(context.generation) && context.generation >= 0) out.generation = context.generation;
  if (context.attempt !== null && Number.isSafeInteger(context.attempt) && context.attempt >= 1) out.attempt = context.attempt;
  return out;
}

/** The line that dates this process on both clocks: append adds the wall time and the monoMs. */
export function clockSync(reason: 'host_start' | 'call_open'): { event: 'clock_sync'; reason: 'host_start' | 'call_open' } {
  return { event: 'clock_sync', reason };
}
