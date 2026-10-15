// Read-only presentation of the Interface 3 live projection (W-B provides the route).
// Pure mapping and markup only: no scheduling, no network, no fabricated state.
import { escapeHtml, renderMarkdown, sourcesFooter } from './markdown.ts';
import { toolConnector, toolPhrase, toolPhrases } from './tool-phrases.ts';
import type { VoiceState } from './orb.ts';
import type { LiveCurrent, LiveEntry, LiveSource, LiveState, LiveTool } from './protocol.ts';

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

/** 1 Hz while active, 4 s while idle or terminal, paused while the document is hidden. */
export function liveDelay(state: LiveState | undefined, hidden: boolean): number | undefined {
  if (hidden) return undefined;
  return state === undefined || state === 'idle' || state === 'ended' || state === 'error' ? 4000 : 1000;
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
      if (existing) existing.text += entry.text;
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
export function liveResult(live: LiveCurrent): LiveAnswer | undefined {
  const accepted = live.entries.filter(entry => entry.kind === 'toolResult' && entry.tool?.status !== 'error' && typeof entry.tool?.markdown === 'string' && entry.tool.markdown.length > 0);
  const latest = accepted[accepted.length - 1];
  return latest?.tool?.markdown ? { markdown: latest.tool.markdown, sources: latest.tool.sources ?? [] } : undefined;
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
    return `<article class="live-remember declined" data-result-seq="${seq}"><h2>Not remembered</h2><p class="muted">${escapeHtml(reason)}</p></article>`;
  }
  if (!text || REMEMBER_CODE.test(text)) {
    const detail = text ? ` (${escapeHtml(text)})` : '';
    return `<article class="live-remember" data-result-seq="${seq}"><h2>Memory</h2><p class="muted">Naya did not report whether the note was saved${detail}.</p>${link}</article>`;
  }
  return `<article class="live-remember" data-result-seq="${seq}"><h2>Remembered</h2><p class="live-remember-text">${escapeHtml(text)}</p>${link}</article>`;
}

/** Full section markup, id="live-panel" so the poller can replace it in place. */
export function liveMarkup(live: LiveCurrent | undefined, poll: LivePollState = {}, detailsOpen = false): string {
  const state = live?.state;
  const label = liveLabel(live);
  const lines = live ? liveTranscript(live) : [];
  const result = live ? liveResult(live) : undefined;
  const latestTurn = [...lines].reverse().find(line => line.role === 'naya') ?? lines.at(-1);
  const jobs = (live?.jobs ?? []).map(job => `<article class="live-job" data-job-id="${escapeHtml(job.id)}">
    <h2>${job.state === 'in_progress' ? 'Background task in progress' : 'Background task ' + escapeHtml(job.state)}</h2>
    ${renderMarkdown(job.markdown)}
    ${!job.delivered && job.state !== 'in_progress' ? '<p class="muted">Call Naya back: choose Start Live voice in the native app to pick up this result.</p>' : ''}
  </article>`).join('');
  const latest = live?.entries.at(-1);
  const restored = state !== 'rebuilding' && latest?.kind === 'continuity' && latest.event === 'resumed'
    ? `<p role="status" data-continuity-seq="${latest.seq}">Connection restored</p>` : '';
  const error = state === 'error' ? '<p class="muted" role="status">Naya reported an error. The live session has stopped.</p>' : '';
  const muted = live?.muted ? '<p class="muted live-muted" role="status">Microphone muted</p>' : '';
  const transcript = lines.length
    ? `<div class="entries live-transcript">${lines.map(line => `<article class="entry"><strong>${line.role === 'user' ? 'You' : 'Naya'}</strong><p>${escapeHtml(line.text)}</p></article>`).join('')}</div>`
    : '<div class="entries live-transcript empty"><p class="muted">No live transcription yet.</p></div>';
  return `<section class="panel live" id="live-panel" aria-label="Naya live conversation">
    <p class="live-state" role="status" aria-live="polite">${escapeHtml(label)}</p>
    ${muted}
    ${poll.stale ? `<p class="live-stale" role="status">Live view stale${poll.lastSuccess ? ' since ' + escapeHtml(poll.lastSuccess.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ', no successful poll yet'}, service unreachable</p>` : ''}
    ${error}${restored}
    ${result ? `<div class="live-result"><h2>Latest answer</h2>${renderMarkdown(result.markdown)}${sourcesMarkup(result.sources)}</div>` : ''}
    ${latestTurn ? `<article class="live-latest-turn"><span>${latestTurn.role === 'naya' ? 'Latest spoken answer' : 'Latest turn'}</span><p>${escapeHtml(latestTurn.text)}</p></article>` : ''}
    <details id="live-details" class="live-details"${detailsOpen ? ' open' : ''}>
      <summary>Conversation history and activity</summary>
      ${transcript}
      <div class="live-activity" aria-label="Live activity">
        ${(live?.entries ?? []).filter(entry => entry.kind === 'toolResult' && entry.tool?.name !== 'remember_note').map(entry => `<details class="live-tool-result" data-result-seq="${entry.seq}"><summary>${escapeHtml(toolPhrase(entry.tool?.name ?? ''))} (${escapeHtml(entry.tool?.status ?? 'unknown')})</summary>${entry.tool?.status !== 'error' && entry.tool?.markdown ? renderMarkdown(entry.tool.markdown) + sourcesMarkup(entry.tool.sources ?? []) : ''}</details>`).join('')}
        ${(live?.entries ?? []).filter(entry => entry.kind === 'toolResult' && entry.tool?.name === 'remember_note').map(remaining => rememberCardMarkup(remaining)).join('')}
        ${jobs}
      </div>
    </details>
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
        break;
    }
  }

  /** The only Start path. Without consent it opens the popover and sends nothing to native. */
  requestStart(): void {
    if (!startAvailable(this.#view)) return;
    if (!this.#view.consent) {
      this.#set({ consentOpen: true, pendingStart: true });
      return;
    }
    this.#post({ type: 'start' });
    this.#set({ state: 'starting', error: undefined, reason: undefined });
  }

  /** Stop is immediate and available the moment a session is starting, live or muted. */
  requestStop(): void {
    if (!stopAvailable(this.#view)) return;
    this.#post({ type: 'stop' });
    this.#set({ state: 'stopping' });
  }

  /** Allow: persist consent natively, then run a Start that was waiting on the popover. */
  grantConsent(): void {
    const start = this.#view.pendingStart;
    if (!this.#view.consent) this.#post({ type: 'consentGranted' });
    this.#set({ consent: true, consentOpen: false, pendingStart: false });
    if (start) {
      this.#post({ type: 'start' });
      this.#set({ state: 'starting' });
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
