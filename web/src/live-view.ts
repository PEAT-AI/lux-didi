// Read-only presentation of the Interface 3 live projection (W-B provides the route).
// Pure mapping and markup only: no scheduling, no network, no fabricated state.
import { escapeHtml, renderMarkdown, sourcesFooter, TRANSCRIPT_MARKDOWN } from './markdown.ts';
import { toolConnector, toolPhrase, toolPhrases } from './tool-phrases.ts';
import type { VoiceState } from './orb.ts';
import { levelPeak, playbackPeak } from './orb-level.ts';
import type { LiveCurrent, LiveEntry, LiveJob, LiveSource, LiveState, LiveTool } from './protocol.ts';

const LABELS: Record<LiveState, string> = {
  idle: 'Ready when you are',
  listening: 'Listening',
  speaking: 'Speaking',
  thinking: 'Thinking',
  rebuilding: 'Reconnecting to the voice service',
  ended: 'Session ended',
  error: 'Something went wrong',
};
export function liveStateLabel(state: LiveState): string { return LABELS[state] ?? LABELS.idle; }

const VOICE: Record<LiveState, VoiceState> = {
  idle: 'CONNECTED', listening: 'LISTENING', speaking: 'SPEAKING',
  thinking: 'PROCESSING', rebuilding: 'RECONNECTING', ended: 'DISCONNECTED', error: 'ERROR',
};
export function liveVoiceState(state: LiveState): VoiceState { return VOICE[state] ?? 'CONNECTED'; }

/** Tool names whose call is in flight: the calls after the last tool result.
 * A batch of several calls is one set, so the activity line reads as one line. */
export function pendingToolNames(live: LiveCurrent): string[] {
  let lastResult = -1;
  for (let index = live.entries.length - 1; index >= 0; index--) {
    if (live.entries[index]!.kind === 'toolResult') { lastResult = index; break; }
  }
  const names: string[] = [];
  for (let index = lastResult + 1; index < live.entries.length; index++) {
    const entry = live.entries[index]!;
    if (entry.kind === 'toolCall' && entry.tool?.name) names.push(entry.tool.name);
  }
  return names;
}

/** The one visible state label. A tool name is never folded into it; the
 * activity line owns the phrase. Shared so the orb caption and panel agree. */
export function liveLabel(live: LiveCurrent | undefined): string {
  const past = live?.pastSession;
  if (past) {
    const time = new Date(past.endedAt ?? past.lastObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (past.outcome === 'unknown' || past.outcome === 'outcome_unknown') return `Last Live session has an unknown end (last seen at ${time})`;
    if (past.endedAt === null) return `Last Live session has an unknown end (last seen at ${time})`;
    const normal = ['closed', 'cancelled', 'revoked', 'expired'].includes(past.outcome);
    return `Last Live session ended${normal ? '' : ' with an error'} at ${time}`;
  }
  return liveStateLabel(live?.state ?? 'idle');
}

/** After this long a pending call adds its elapsed seconds to the activity line. */
export const SLOW_TOOL_MS = 4000;

export type LiveActivityKind = 'thinking' | 'tools' | 'done' | 'failed';
export interface LiveActivity { kind: LiveActivityKind; text: string }

/** The tool result's own sentence, or a calm connector sentence when the
 * projection carries only a reason code. Never the raw code. */
function failureSentence(tool: LiveTool): string {
  const markdown = (tool.markdown ?? '').trim();
  const code = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
  if (markdown && /\s/.test(markdown) && !code.test(markdown)) return markdown;
  return `${toolConnector(tool.name)} did not answer`;
}

/** What Naya is doing right now, as one human line, or undefined when there is
 * no activity to show (listening, speaking, idle). */
export function liveActivity(live: LiveCurrent | undefined): LiveActivity | undefined {
  if (!live) return undefined;
  const pending = pendingToolNames(live);
  if (pending.length) return { kind: 'tools', text: toolPhrases(pending) };
  const last = live.entries.at(-1);
  if (last?.kind === 'toolResult' && last.tool) {
    // W3 records a batch the user barged in on as disposition 'after_barge_in'. The
    // result still reached Naya, so it is a quiet done, never a failure.
    const tool = last.tool as LiveTool & { disposition?: string };
    if (tool.disposition === 'after_barge_in') return { kind: 'done', text: 'Found it, ask if you want it' };
    if (tool.status === 'error') return { kind: 'failed', text: failureSentence(tool) };
    return { kind: 'done', text: 'Done' };
  }
  if (live.state === 'thinking') return { kind: 'thinking', text: 'Thinking' };
  return undefined;
}

/** The activity line under the orb. A slow pending call appends its elapsed
 * seconds only after SLOW_TOOL_MS, so the line stays calm while it waits. */
export function activityMarkup(activity: LiveActivity | undefined, elapsedMs = 0): string {
  if (!activity) return '';
  const slow = activity.kind === 'tools' && elapsedMs >= SLOW_TOOL_MS;
  const text = slow ? `${activity.text} (${Math.floor(elapsedMs / 1000)}s)` : activity.text;
  const indicator = activity.kind === 'done'
    ? '<span class="activity-mark" aria-hidden="true">&#10003;</span>'
    : '<span class="activity-indicator" aria-hidden="true"></span>';
  return `<p class="activity-line activity-${activity.kind}" role="status" aria-live="polite">${indicator}<span class="activity-text">${escapeHtml(text)}</span></p>`;
}

/** 250 ms while a session is not idle, 4 s while idle or terminal, paused while the document is hidden.
 *  The faster active cadence learns a state change within 250 ms (F3). */
export function liveDelay(state: LiveState | undefined, hidden: boolean): number | undefined {
  if (hidden) return undefined;
  return state === undefined || state === 'idle' || state === 'ended' || state === 'error' ? 4000 : 250;
}

/** Merge cursor paged entries by seq, newest value winning; a changed session start replaces the accumulated transcript. */
export function mergeLive(previous: LiveCurrent | undefined, next: LiveCurrent): LiveCurrent {
  if (!previous || previous.since !== next.since) return { ...next, entries: [...next.entries] };
  if (!next.entries.length) {
    if (JSON.stringify({ ...previous, entries: undefined }) === JSON.stringify({ ...next, entries: undefined })) return previous;
    return { ...next, entries: previous.entries };
  }
  const bySeq = new Map<number, LiveEntry>();
  for (const entry of previous.entries) bySeq.set(entry.seq, entry);
  for (const entry of next.entries) bySeq.set(entry.seq, entry);
  return { ...next, entries: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}

export interface LiveLine { role: 'user' | 'naya'; text: string }
/** One rendered transcript block with the key that keeps it stable across polls: a growing line keeps
 * its key and is updated in place, a new line only ever appends (V3 item 2). */
export interface LiveSegment { key: string; html: string }
// Provider chunks can split mid-word, so only a sentence boundary earns a separator; otherwise the
// fragments are concatenated verbatim. See V2-R2 item 1.
export function joinChunk(previous: string, next: string): string {
  return /[.!?]["')\]]?\s*$/.test(previous) && /^[A-Za-z0-9]/.test(next) ? previous + ' ' + next : previous + next;
}

export function liveTranscript(live: LiveCurrent): LiveLine[] {
  const lines: LiveLine[] = [];
  // One provider turn can interleave a typed user turn with its streamed Naya fragments, so a
  // segment accumulates one line per role and emits them in first-appearance (journal) order.
  // A turnComplete/interrupted/terminal closes the segment.
  let segment = new Map<'user' | 'naya', LiveLine>();
  const flush = () => { for (const line of segment.values()) lines.push(line); segment = new Map(); };
  for (const entry of live.entries) {
    const role = entry.kind === 'inputTranscription' ? 'user' : entry.kind === 'outputTranscription' ? 'naya' : undefined;
    if (role && entry.text) {
      const existing = segment.get(role);
      if (existing) existing.text = joinChunk(existing.text, entry.text);
      else segment.set(role, { role, text: entry.text });
    }
    if (entry.kind === 'turnComplete' || entry.kind === 'interrupted' || entry.kind === 'terminal') flush();
  }
  flush();
  return lines;
}

export interface LivePollState { live?: LiveCurrent; lastSuccess?: Date; stale?: boolean }
/** The polling boundary preserves the last projection on failure, never raw errors. */
export async function pollLiveView(previous: LivePollState, fetch: (cursor?: string | number) => Promise<LiveCurrent>, now: () => Date = () => new Date()): Promise<LivePollState> {
  try {
    let next = await fetch(previous.live?.cursor);
    // A cursor belongs to a session: reload its first page when the latest session changes.
    if (previous.live && previous.live.since !== next.since) next = await fetch();
    return { live: mergeLive(previous.live, next), lastSuccess: now(), stale: false };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return { lastSuccess: now(), stale: false };
    return { ...previous, stale: true };
  }
}

export interface LiveAnswer { markdown: string; sources: LiveSource[] }
/** The Latest answer card shows the model's own output transcript, never a tool result's body. The
 * named source chips still come from the newest accepted tool result that carried any. */
export function liveResult(live: LiveCurrent): LiveAnswer | undefined {
  const answer = [...liveTranscript(live)].reverse().find(line => line.role === 'naya');
  if (!answer?.text) return undefined;
  const latest = [...live.entries].reverse().find(entry => entry.kind === 'toolResult' && entry.tool?.status !== 'error' && (entry.tool?.sources?.length ?? 0) > 0);
  return { markdown: answer.text, sources: latest?.tool?.sources ?? [] };
}

function sourcesMarkup(sources: LiveSource[]): string {
  return sourcesFooter(sources);
}

/** A typed remember_note result code is a snake_case token; the saved note is the owner's spoken words. */
const REMEMBER_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const REMEMBER_DECLINES: Record<string, string> = {
  already_remembered: 'Naya already had this note saved.',
  private_memory_unsupported: 'Private or sensitive notes are not saved in memory.',
  owner_transcript_not_final: 'The note was not saved because your spoken words were not final.',
  owner_text_mismatch: 'The note was not saved because it did not match your spoken words.',
  tool_result_denied: 'The note was not saved.',
  tool_refused: 'The note was not saved.',
};
/** The Live projection carries only name/status/markdown/sources. A saved note is claimed only when
 * the projected text is the owner's words; a bare result code is neither those words nor a typed
 * decline the card knows, so the outcome stays unconfirmed. The server owns kind/time and the codes. */
function rememberCardMarkup(entry: LiveEntry): string {
  const text = entry.tool?.markdown ?? '';
  const seq = entry.seq;
  const link = '<a class="live-remember-link" href="#recall-form">Open your memory list</a>';
  const known = REMEMBER_DECLINES[text];
  if (entry.tool?.status === 'error' || known) {
    const reason = known ?? (text || 'The note was not saved.');
    return `<article class="live-remember declined" data-result-seq="${seq}" data-seg="remember:${seq}"><h2>Not remembered</h2><p class="muted">${escapeHtml(reason)}</p></article>`;
  }
  if (!text || REMEMBER_CODE.test(text)) {
    const detail = text ? ` (${escapeHtml(text)})` : '';
    return `<article class="live-remember" data-result-seq="${seq}" data-seg="remember:${seq}"><h2>Memory</h2><p class="muted">Naya did not report whether the note was saved${detail}.</p>${link}</article>`;
  }
  return `<article class="live-remember" data-result-seq="${seq}" data-seg="remember:${seq}"><h2>Remembered</h2><p class="live-remember-text">${escapeHtml(text)}</p>${link}</article>`;
}

/** Full section markup, id="live-panel" so the poller can replace it in place. */
// A one-line chip that still lets the reader inspect the result: collapsed it is a single muted line
// between turns, expanded it shows the accepted markdown and source chips.
function toolChipMarkup(entry: LiveEntry): string {
  const phrase = escapeHtml(toolPhrase(entry.tool?.name ?? '') + (entry.tool?.status ? ` (${entry.tool.status})` : ''));
  const body = entry.tool?.status === 'error' ? '' : `${renderMarkdown(entry.tool?.markdown ?? '', TRANSCRIPT_MARKDOWN)}${sourcesMarkup(entry.tool?.sources ?? [])}`;
  return `<details class="live-tool-result" data-result-seq="${entry.seq}" data-seg="tool:${entry.seq}"><summary>${phrase}</summary>${body}</details>`;
}

/** One transcript line: the owner's words in the shared right-aligned chat bubble, Naya's words as
 * plain markdown, never a speaker label (V3 item 2). */
export function liveLineMarkup(line: LiveLine, seg = ''): string {
  const key = seg ? ` data-seg="${seg}"` : '';
  return line.role === 'user'
    ? `<article class="entry user"${key}><p class="bubble">${escapeHtml(line.text)}</p></article>`
    : `<article class="entry assistant"${key}><div class="markdown">${renderMarkdown(line.text, TRANSCRIPT_MARKDOWN)}</div></article>`;
}

/** The transcript IS the lane: turns flow on the lane background, with a one-line tool chip where a
 * tool result landed. No card, no duplicate latest-answer block, no history disclosure (V2-R2 item 4).
 * Segments are keyed by the seq of the entry that opened them, so a streaming line updates in place. */
export function liveSegments(live: LiveCurrent | undefined): LiveSegment[] {
  const segments: LiveSegment[] = [];
  let pending: (LiveLine & { seq: number })[] = [];
  const flush = () => { for (const line of pending) { const key = `${line.role}:${line.seq}`; segments.push({ key, html: liveLineMarkup(line, key) }); } pending = []; };
  for (const entry of live?.entries ?? []) {
    const role = entry.kind === 'inputTranscription' ? 'user' : entry.kind === 'outputTranscription' ? 'naya' : undefined;
    if (role && entry.text) {
      const existing = pending.find(line => line.role === role);
      if (existing) existing.text = joinChunk(existing.text, entry.text);
      else pending.push({ role, text: entry.text, seq: entry.seq });
    }
    if (entry.kind === 'turnComplete' || entry.kind === 'interrupted' || entry.kind === 'terminal') flush();
    if (entry.kind === 'toolResult' && entry.tool?.name === 'remember_note') { flush(); segments.push({ key: `remember:${entry.seq}`, html: rememberCardMarkup(entry) }); }
    else if (entry.kind === 'toolResult') { flush(); segments.push({ key: `tool:${entry.seq}`, html: toolChipMarkup(entry) }); }
  }
  flush();
  return segments;
}

/** A job's raw state word shown as a plain human sentence; the enum token never reaches the panel. */
export function jobStateLabel(state: LiveJob['state']): string {
  switch (state) {
    case 'in_progress': return 'Background task in progress';
    case 'completed': return 'Background task finished';
    case 'failed': return 'Background task failed';
    case 'unknown': return 'Background task was interrupted before its result was known';
  }
}

export function liveMarkup(live: LiveCurrent | undefined, poll: LivePollState = {}): string {
  const state = live?.state;
  const jobs = (live?.jobs ?? []).map(job => `<article class="live-job" data-job-id="${escapeHtml(job.id)}"><p class="live-tool-chip">${escapeHtml(jobStateLabel(job.state))}</p>${renderMarkdown(job.markdown, TRANSCRIPT_MARKDOWN)}${!job.delivered && job.state !== 'in_progress' ? '<p class="muted">Call Naya back: choose Start Live voice in the native app to pick up this result.</p>' : ''}</article>`).join('');
  const latest = live?.entries.at(-1);
  const restored = state !== 'rebuilding' && latest?.kind === 'continuity' && latest.event === 'resumed'
    ? `<p role="status" data-continuity-seq="${latest.seq}">Connection restored</p>` : '';
  const error = state === 'error' ? '<p class="muted" role="status">Naya reported an error. The live session has stopped.</p>' : '';
  const muted = live?.muted ? '<p class="muted live-muted" role="status">Microphone muted</p>' : '';
  const stale = poll.stale ? `<p class="live-stale" role="status">Live view stale${poll.lastSuccess ? ' since ' + escapeHtml(poll.lastSuccess.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ', no successful poll yet'}, service unreachable</p>` : '';
  const flow = liveSegments(live).map(segment => segment.html);
  return `<section class="lane-convo live" id="live-panel" aria-label="Naya live conversation">
    ${muted}${stale}${error}${restored}
    <div class="live-turns">${flow.join('') || '<p class="transcript-placeholder muted">Press Start or \u2318\u21e7Space to talk</p>'}</div>
    ${jobs}
  </section>`;
}

// --- Web Live state machine (issue #255 item 2). The web owns the consent gate: every Start path
// (the Voice-lane pill, the keyboard shortcut, or a native menu requestStart) goes through requestStart,
// so capture can never begin before the one-time consent popover is answered.
import type {
  MicStatus,
  NativeLiveError,
  NativeLiveState,
  NativeToWeb,
  Route,
  ThemeMode,
  WebToNative,
} from './native-bridge.ts';

export interface LiveConsentCopy {
  title: string;
  body: string;
  allow: string;
  dismiss: string;
}

/** The one-time first-run consent popover (dark, no permanent banner). */
export const LIVE_CONSENT: LiveConsentCopy = {
  title: 'Turn on Live?',
  body: 'Audio goes to the Live provider while Live is on.',
  allow: 'Allow',
  dismiss: 'Not now',
};

export interface LiveView {
  state: NativeLiveState;
  error?: NativeLiveError;
  reason?: string;
  consent: boolean;
  mic: MicStatus;
  route: Route | null;
  theme: ThemeMode;
  lastSessionEndedAt: string | null;
  /** The one-time consent popover is open. */
  consentOpen: boolean;
  /** A Start was asked before consent; it runs as soon as Allow is pressed. */
  pendingStart: boolean;
}

export function initialLiveView(seed: Partial<LiveView> = {}): LiveView {
  return {
    state: 'idle',
    consent: false,
    mic: 'undetermined',
    route: null,
    theme: 'dark',
    lastSessionEndedAt: null,
    consentOpen: false,
    pendingStart: false,
    ...seed,
  };
}

/** A clear error line for every explicit native error state; undefined when there is nothing to say. */
export function liveErrorText(error: NativeLiveError | undefined, reason?: string): string | undefined {
  switch (error) {
    case 'micDenied':
      return 'Microphone access is blocked. Allow it in System Settings, then press Start again.';
    case 'deviceUnavailable':
      return 'No microphone is available. Connect one, then press Start again.';
    case 'providerError':
      return reason ? `The Live provider reported a problem: ${reason}` : 'The Live provider reported a problem.';
    case 'ended':
      return reason ? `The Live session ended: ${reason}` : 'The Live session ended.';
    default:
      return undefined;
  }
}

/** The global live pill is shown while live or muted, and never hidden by a collapse, sheet or switcher. */
export function pillVisible(view: LiveView): boolean {
  return view.state === 'live' || view.state === 'muted';
}

export function stopAvailable(view: LiveView): boolean {
  return view.state === 'live' || view.state === 'muted' || view.state === 'starting';
}

/** Start is offered whenever the machine is not already busy; after an error the button is live again. */
export function startAvailable(view: LiveView): boolean {
  return view.state === 'idle' || view.state === 'error';
}

export const START_PATHS = ['button', 'shortcut', 'native'] as const;
export type StartPath = (typeof START_PATHS)[number];

export class LiveMachine {
  #view: LiveView;
  #post: (message: WebToNative) => void;
  #listeners = new Set<(view: LiveView) => void>();

  constructor(post: (message: WebToNative) => void, seed: Partial<LiveView> = {}) {
    this.#post = post;
    this.#view = initialLiveView(seed);
  }

  get view(): LiveView {
    return this.#view;
  }

  on(listener: (view: LiveView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(next: Partial<LiveView>): void {
    this.#view = { ...this.#view, ...next };
    for (const listener of this.#listeners) listener(this.#view);
  }

  receive(message: NativeToWeb): void {
    switch (message.type) {
      case 'hydrate':
        this.#set({
          consent: message.consent,
          mic: message.mic,
          state: message.live.state,
          error: message.live.error,
          reason: message.live.reason,
          route: message.route,
          theme: message.theme,
          lastSessionEndedAt: message.lastSessionEndedAt,
          consentOpen: false,
          pendingStart: false,
        });
        break;
      case 'liveState':
        this.#set({ state: message.state, error: message.error, reason: message.reason });
        break;
      case 'route':
        this.#set({ route: { input: message.input, output: message.output, voiceProcessing: message.voiceProcessing } });
        break;
      case 'requestStart':
        this.requestStart();
        break;
      case 'requestStop':
        this.requestStop();
        break;
      case 'levels':
        this.#forwardLevels(message.input, message.output);
        break;
    }
  }

  /** Native taps post the owner's capture and Naya's playback levels; the orb answers the louder
   * side, so it animates for whoever is speaking (V3 item 1). The renderer owns smoothing. */
  #forwardLevels(input: number[], output: number[]): void {
    const peak = levelPeak(input, output);
    if (peak === undefined) return;
    (globalThis as unknown as { didiOrbLevel?: (sample: { level: number; playback: number }) => void }).didiOrbLevel?.({ level: peak, playback: playbackPeak(output) ?? 0 });
  }

  /** The only Start path. Without consent it opens the popover and sends nothing to native. */
  requestStart(): void {
    if (!startAvailable(this.#view)) return;
    if (!this.#view.consent) {
      this.#set({ consentOpen: true, pendingStart: true });
      return;
    }
    // Optimistic state first: a synchronous native reply then wins, never gets clobbered.
    this.#set({ state: 'starting', error: undefined, reason: undefined });
    this.#post({ type: 'start' });
  }

  /** Stop is immediate and available the moment a session is starting, live or muted. */
  requestStop(): void {
    if (!stopAvailable(this.#view)) return;
    this.#set({ state: 'stopping' });
    this.#post({ type: 'stop' });
  }

  /** Allow: persist consent natively, then run a Start that was waiting on the popover. */
  grantConsent(): void {
    const start = this.#view.pendingStart;
    const wasConsent = this.#view.consent;
    this.#set({ consent: true, consentOpen: false, pendingStart: false });
    if (!wasConsent) this.#post({ type: 'consentGranted' });
    if (start) {
      this.#set({ state: 'starting' });
      this.#post({ type: 'start' });
    }
  }

  dismissConsent(): void {
    if (this.#view.consentOpen) this.#set({ consentOpen: false, pendingStart: false });
  }

  toggleMute(): void {
    if (this.#view.state === 'live') this.#post({ type: 'mute' });
    else if (this.#view.state === 'muted') this.#post({ type: 'unmute' });
  }
}
