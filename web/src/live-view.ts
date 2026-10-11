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

/** 1 Hz while the projection is active, 4 s while idle, paused while the document is hidden. */
export function liveDelay(state: LiveState | undefined, hidden: boolean): number | undefined {
  if (hidden) return undefined;
  return state === undefined || state === 'idle' ? 4000 : 1000;
}

/** Merge cursor paged entries by seq, newest value winning; a new snapshot replaces nothing. */
export function mergeLive(previous: LiveCurrent | undefined, next: LiveCurrent): LiveCurrent {
  if (!previous) return { ...next, entries: [...next.entries] };
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

/** Full section markup, id="live-panel" so the poller can replace it in place. */
export function liveMarkup(live: LiveCurrent | undefined): string {
  const state = live?.state;
  const label = state === 'thinking'
    ? (live && liveToolName(live) ? `Thinking (${liveToolName(live)})` : liveStateLabel('thinking'))
    : liveStateLabel(state ?? 'idle');
  const lines = live ? liveTranscript(live) : [];
  const result = live ? liveResult(live) : undefined;
  const error = state === 'error' ? '<p class="muted" role="status">Naya reported an error. The live session has stopped.</p>' : '';
  const muted = live?.muted ? '<p class="muted live-muted" role="status">Microphone muted</p>' : '';
  const transcript = lines.length
    ? lines.map(line => `<li class="entry"><strong>${line.role === 'user' ? 'You' : 'Naya'}</strong><p>${escapeHtml(line.text)}</p></li>`).join('')
    : '<li class="empty"><p class="muted">No live transcription yet.</p></li>';
  return `<section class="panel live" id="live-panel" aria-label="Naya live conversation">
    <p class="live-state" role="status" aria-live="polite">${escapeHtml(label)}</p>
    ${muted}
    <ol class="entries live-transcript">${transcript}</ol>
    ${error}
    ${result ? `<div class="live-result"><h2>Latest answer</h2>${renderMarkdown(result.markdown)}${sourcesMarkup(result.sources)}</div>` : ''}
  </section>`;
}
