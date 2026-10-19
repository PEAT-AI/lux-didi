// The host log event API. Structured diagnostics travel this channel and never stdout: the native
// supervisor treats any supervised stdout byte after the ready frame as invalid output.
// Deliberately dependency-free so the tool layer can emit diagnostics without importing the host
// (which owns the file, HTTP and config modules).
export interface HostLogSink {
  event(raw: unknown): void;
}

const sinks = new Set<HostLogSink>();

/** Attach one host log sink; the returned function detaches it. */
export function attachHostLogSink(sink: HostLogSink): () => void {
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

/** Route one structured host diagnostic to every attached host log. Validation stays in the sink. */
export function hostLogEvent(raw: unknown): void {
  for (const sink of sinks) sink.event(raw);
}

/** One step of live tool work as the voice view shows it while it runs: which source, what action,
 *  on what. The subject is the owner-readable subject line, never a message body and never an id. */
export interface LiveToolStep {
  type: 'live_tool_step';
  /** The model call this step belongs to (direct tool or the one `research` call). */
  callId: string;
  /** Stable per source inside a call, so the end step replaces the start line in place. */
  stepId: string;
  source: string;
  action: string;
  subject?: string;
  phase: 'start' | 'end';
  resultCount?: number;
  ok?: boolean;
  errorCode?: 'failed' | 'timeout' | 'cancelled';
  ms?: number;
}

/** The step without its discriminator, as the tool layer and the Live owner pass it. */
export type LiveToolStepBody = Omit<LiveToolStep, 'type'>;

/** Publish one live tool step on the host event channel the Live owner forwards to the voice view. */
export function liveToolStep(step: LiveToolStepBody): void {
  hostLogEvent({ type: 'live_tool_step', ...step });
}

/** A step subject never runs longer than this. */
export const STEP_SUBJECT_CAP = 60;

/** Argument keys a subject may quote: what to look for, for whom, in which window. An id-shaped key
 *  (`channel`, any `*Id`), a body key and a text key are never read, so nothing private and no
 *  identifier can become a subject. */
const SUBJECT_KEYS: readonly string[] = ['query', 'q', 'search', 'terms', 'question', 'person', 'name', 'window', 'when', 'day', 'date'];
const WINDOWS: Record<string, string> = { today: 'today', tomorrow: 'tomorrow', week: 'last 7 days' };
/** A value that is an identifier rather than owner-readable words: a long hex run, a `type:value`
 *  token, a digit run, or a `prefix-…` slug with no space in it. */
const ID_SHAPED = /[0-9a-f]{8,}|^[a-z]{2,}[-_:][\w-]{4,}$|\d{5,}|^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Printable words only: ansi escapes and control or bidi characters never reach a subject. */
function readable(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipSubject(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

/** A short owner-readable subject built from tool arguments: the search words, a person, a channel
 *  or a time window ("week" reads "last 7 days"), at most `cap` characters. */
export function stepSubject(args: unknown, cap = STEP_SUBJECT_CAP): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SUBJECT_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const text = readable(value);
    if (!text || ID_SHAPED.test(text)) continue;
    const shown = key === 'window' || key === 'when'
      ? WINDOWS[text] ?? (/^\d{4}-\d{2}-\d{2}$/.test(text) ? `on ${text}` : text)
      : text;
    if (!parts.includes(shown)) parts.push(shown);
  }
  if (parts.length === 0) return undefined;
  return clipSubject(parts.join(', '), cap);
}
