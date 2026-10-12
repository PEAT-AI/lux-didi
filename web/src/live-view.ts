// Read-only presentation of the Interface 3 live projection (W-B provides the route).
// Pure mapping and markup only: no scheduling, no network, no fabricated state.
import { escapeHtml, renderMarkdown } from './markdown.ts';
import type { VoiceState } from './orb.ts';
import type { LiveCurrent, LiveEntry, LiveSource, LiveState } from './protocol.ts';

const LABELS: Record<LiveState, string> = {
  idle: 'Ready when you are',
  listening: 'Listening',
  speaking: 'Speaking',
  thinking: 'Thinking',
  ended: 'Session ended',
  error: 'Something went wrong',
};
export function liveStateLabel(state: LiveState): string { return LABELS[state] ?? LABELS.idle; }

const VOICE: Record<LiveState, VoiceState> = {
  idle: 'CONNECTED', listening: 'LISTENING', speaking: 'SPEAKING',
  thinking: 'PROCESSING', ended: 'DISCONNECTED', error: 'ERROR',
};
export function liveVoiceState(state: LiveState): VoiceState { return VOICE[state] ?? 'CONNECTED'; }

/** The tool whose call is in flight, so the thinking label can name it. */
export function liveToolName(live: LiveCurrent): string | undefined {
  for (let index = live.entries.length - 1; index >= 0; index--) {
    const entry = live.entries[index]!;
    if (entry.kind === 'toolCall' && entry.tool?.name) return entry.tool.name;
  }
  return undefined;
}

/** The one visible state label, including the tool name while thinking.
 * main.ts and liveMarkup share it so the orb caption and the panel never disagree. */
export function liveLabel(live: LiveCurrent | undefined): string {
  const past = live?.pastSession;
  if (past) {
    const time = new Date(past.endedAt ?? past.lastObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (past.outcome === 'unknown' || past.outcome === 'outcome_unknown') return `Last Live session has an unknown end (last seen at ${time})`;
    if (past.endedAt === null) return `Last Live session has an unknown end (last seen at ${time})`;
    const normal = ['closed', 'cancelled', 'revoked', 'expired'].includes(past.outcome);
    return `Last Live session ended${normal ? '' : ' with an error'} at ${time}`;
  }
  const state = live?.state;
  if (state === 'thinking') {
    const tool = live ? liveToolName(live) : undefined;
    return tool ? `Thinking (${tool})` : liveStateLabel('thinking');
  }
  return liveStateLabel(state ?? 'idle');
}

/** 1 Hz while the projection is active, 4 s while idle, paused while the document is hidden. */
export function liveDelay(state: LiveState | undefined, hidden: boolean): number | undefined {
  if (hidden) return undefined;
  return state === undefined || state === 'idle' ? 4000 : 1000;
}

/** Merge cursor paged entries by seq, newest value winning; a changed session start replaces the accumulated transcript. */
export function mergeLive(previous: LiveCurrent | undefined, next: LiveCurrent): LiveCurrent {
  if (!previous || previous.since !== next.since) return { ...next, entries: [...next.entries] };
  const bySeq = new Map<number, LiveEntry>();
  for (const entry of previous.entries) bySeq.set(entry.seq, entry);
  for (const entry of next.entries) bySeq.set(entry.seq, entry);
  return { ...next, entries: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}

export interface LiveLine { role: 'user' | 'naya'; text: string }
export function liveTranscript(live: LiveCurrent): LiveLine[] {
  const lines: LiveLine[] = [];
  for (const entry of live.entries) {
    if (entry.kind === 'inputTranscription' && entry.text) lines.push({ role: 'user', text: entry.text });
    if (entry.kind === 'outputTranscription' && entry.text) lines.push({ role: 'naya', text: entry.text });
  }
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

function safeUrl(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}
function sourcesMarkup(sources: LiveSource[]): string {
  if (!sources.length) return '';
  return `<ul class="sources">${sources.map(source => {
    const label = escapeHtml(source.title);
    const url = safeUrl(source.url);
    return `<li class="source">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}</li>`;
  }).join('')}</ul>`;
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
/** The Live projection carries only name/status/markdown/sources, so a note is shown as saved only
 * when the projected text is not a typed decline code. The server owns the missing kind/time fields. */
function rememberCardMarkup(entry: LiveEntry): string {
  const text = entry.tool?.markdown ?? '';
  const code = REMEMBER_CODE.test(text) ? text : undefined;
  if (entry.tool?.status === 'error' || code) {
    const reason = REMEMBER_DECLINES[code ?? text] ?? (code ? `Naya did not save the note (${code}).` : 'The note was not saved.');
    return `<article class="live-remember declined" data-result-seq="${entry.seq}"><h2>Not remembered</h2><p class="muted">${escapeHtml(reason)}</p></article>`;
  }
  return `<article class="live-remember" data-result-seq="${entry.seq}"><h2>Remembered</h2><p class="live-remember-text">${escapeHtml(text)}</p><a class="live-remember-link" href="#recall-form">Open your memory list</a></article>`;
}

/** Full section markup, id="live-panel" so the poller can replace it in place. */
export function liveMarkup(live: LiveCurrent | undefined, poll: LivePollState = {}): string {
  const state = live?.state;
  const label = liveLabel(live);
  const lines = live ? liveTranscript(live) : [];
  const result = live ? liveResult(live) : undefined;
  const jobs = (live?.jobs ?? []).map(job => `<article class="live-job" data-job-id="${escapeHtml(job.id)}">
    <h2>${job.state === 'in_progress' ? 'Background task in progress' : 'Background task ' + escapeHtml(job.state)}</h2>
    ${renderMarkdown(job.markdown)}
    ${!job.delivered && job.state !== 'in_progress' ? '<p class="muted">Call Naya back: choose Start Live voice in the native app to pick up this result.</p>' : ''}
  </article>`).join('');
  const error = state === 'error' ? '<p class="muted" role="status">Naya reported an error. The live session has stopped.</p>' : '';
  const muted = live?.muted ? '<p class="muted live-muted" role="status">Microphone muted</p>' : '';
  const transcript = lines.length
    ? lines.map(line => `<li class="entry"><strong>${line.role === 'user' ? 'You' : 'Naya'}</strong><p>${escapeHtml(line.text)}</p></li>`).join('')
    : '<li class="empty"><p class="muted">No live transcription yet.</p></li>';
  return `<section class="panel live" id="live-panel" aria-label="Naya live conversation">
    <p class="live-state" role="status" aria-live="polite">${escapeHtml(label)}</p>
    ${muted}
    ${poll.stale ? `<p class="live-stale" role="status">Live view stale${poll.lastSuccess ? ' since ' + escapeHtml(poll.lastSuccess.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ', no successful poll yet'}, service unreachable</p>` : ''}
    <ol class="entries live-transcript">${transcript}</ol>
    ${error}
    ${(live?.entries ?? []).filter(entry => entry.kind === 'toolResult' && entry.tool?.name !== 'remember_note').map(entry => `<details class="live-tool-result" data-result-seq="${entry.seq}"><summary>${escapeHtml(entry.tool?.name ?? 'Tool result')} (${escapeHtml(entry.tool?.status ?? 'unknown')})</summary>${entry.tool?.status !== 'error' && entry.tool?.markdown ? renderMarkdown(entry.tool.markdown) + sourcesMarkup(entry.tool.sources ?? []) : ''}</details>`).join('')}
    ${(live?.entries ?? []).filter(entry => entry.kind === 'toolResult' && entry.tool?.name === 'remember_note').map(remaining => rememberCardMarkup(remaining)).join('')}
    ${jobs}
    ${result ? `<div class="live-result"><h2>Latest answer</h2>${renderMarkdown(result.markdown)}${sourcesMarkup(result.sources)}</div>` : ''}
  </section>`;
}
