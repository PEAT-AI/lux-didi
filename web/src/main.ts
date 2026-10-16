import './style.css';
import { memoryDeleteControl, deleteMemoryAndReload, attachMemoryDeleteControls, memoryListMarkup } from './memory-list';
import { deleteMemoryEntry } from './api';
import { ConnectedView } from './connected';
import { Orb, type VoiceState } from './orb';
import { ApiError, request, pair, demoMode, onAuthorityChanged, authorityVersion, assertAuthority, restoreSession, logout, fetchLive } from './api';
import { liveMarkup, liveSegments, liveLabel, liveVoiceState, liveDelay, pollLiveView, liveActivity, activityMarkup, liveTranscript, LiveMachine, LIVE_CONSENT, pillVisible, liveErrorText, startAvailable, stopAvailable, type LivePollState } from './live-view';
import { attachPin } from './autoscroll.ts';
import { defaultLayout, isNarrow, toggleRail, toggleLane, selectSegment, openSheet, closeSheet, withViewport, collapseControl, focusTargetAfterCollapse, type LaneId, type RouteId } from './layout';
import { installNativeBridge, type Bridge, type NativeLiveState } from './native-bridge';
import { connectionsMarkup } from './connector-status';
import { settingsMarkup } from './settings-view';
import { answerMarkup } from './markdown';
import { applyTheme, loadTheme, saveTheme, type Theme } from './theme';
import type { Session, Entry, Commitment, CommitmentDetail, Plan, Recall, Status, LiveCurrent, ResearchProgressView } from './protocol';

type Tab = 'Conversation' | 'Today' | 'Memory' | 'Settings';
// --- Three-lane layout, native bridge and the web Live state machine (#255) ---
let layout = defaultLayout(isNarrow(typeof window !== 'undefined' ? window.innerWidth : 1440));
let nativeBridge: Bridge | undefined;
let nativeFake: { requestStart(): void; requestStop(): void } | undefined;
let liveMachine = new LiveMachine(() => {});
const root = document.querySelector<HTMLDivElement>('#app')!;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tabs: Tab[] = ['Conversation', 'Today', 'Memory', 'Settings'];
let tab: Tab = 'Conversation';
let theme: Theme = 'dark';
let orb: Orb | undefined;
let transcriptPin: { repin(): void; stop(): void } | undefined;
let appliedOrbState: VoiceState | undefined;
let status: Status | undefined;
const connectedView = new ConnectedView(() => orb?.setState(orbState()));
let connection: 'Connecting' | 'Connected' | 'Disconnected' | 'Offline' | 'Pair this browser' = 'Connecting';
let sessions: Session[] = [], entries: Entry[] = [], session: Session | undefined;
let plan: Plan | undefined, recall: Recall | undefined;
let recent: Commitment[] = [], editing: Commitment | undefined, detail: CommitmentDetail | undefined;
let draftOwner: string | undefined;
let messageDraft = '', titleDraft = '', queryDraft = '', editTitle = '', editNotes = '', editDue = '', memoryFilter = '';
let notice = '', error = '', busy = false, readBusy = false, pairingBusy = false;
let pairingRequired = false, sessionMore = false, entriesMore = false;
let controller: AbortController | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined, backoff = 30000;
let live: LiveCurrent | undefined;
let livePoll: LivePollState = {};
let liveDetailsOpen = false;
let historyOpen = false;
let connections: unknown = [];
let connectionsStale = false;
let statusUnavailable = false;
let connectionsTimer: ReturnType<typeof setTimeout> | undefined;
let connectionsBusy = false;
let liveBusy = false;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let readGeneration = 0;
const e = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const datetime = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'No due date';
function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function localInput(value: string | null) { if (!value) return ''; const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function writable() { return connection === 'Connected' && !busy; }
const disabled = (condition: boolean) => condition ? 'disabled' : '';
function themeStorage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
function notify(message: string, failure = false) { notice = failure ? '' : message; error = failure ? message : ''; render(); }
function failure(err: unknown, mutation = false) {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Stopped waiting. A sent change may still have been saved. Refresh before trying again.';
  if (err instanceof ApiError) return err.message;
  connection = navigator.onLine ? 'Disconnected' : 'Offline';
  return mutation ? 'Could not confirm whether this was saved. Your draft is here. Reconnect and check before trying again.' : 'Didi can’t reach your service. Reconnect when you’re ready.';
}
function sourceMarkup(refs: Entry['sourceRefs']) { return refs.map(s => `<div class="source"><span>${e(s.label)}</span><small>${s.availability === 'missing' ? 'Source unavailable' : 'Source available'}${s.sourceTimestamp ? ` · ${e(datetime(s.sourceTimestamp))}` : ''}</small>${s.note ? `<p>${e(s.note)}</p>` : ''}</div>`).join(''); }
function entryMarkup(entry: Entry) { return `<article class="entry ${entry.role}"><header><strong>${entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Didi' : 'Update'}</strong><time datetime="${e(entry.capturedAt)}">${e(datetime(entry.capturedAt))}</time></header>${entry.role === 'assistant' ? answerMarkup(entry.text) : `<p>${e(entry.text)}</p>`}${sourceMarkup(entry.sourceRefs)}${memoryDeleteControl(entry.id, !writable() || busy || connectedView.active)}${entry.role === 'user' ? `<button class="quiet" data-capture="${e(entry.id)}" ${disabled(!writable() || !status?.capabilities.commitments)}>Make a commitment</button>` : ''}</article>`; }
function orbState(): VoiceState {
  if(connection==='Offline'||connection==='Disconnected'||pairingRequired)return 'DISCONNECTED';
  if(connection==='Connecting')return 'CONNECTING';
  if(live && live.state!=='idle')return liveVoiceState(live.state);
  if(busy||connectedView.active)return 'PROCESSING';
  if(error)return 'ERROR';
  return 'CONNECTED';
}
function orbLabel() {
  const state=orbState();
  return live?liveLabel(live):state==='PROCESSING'?'Working on your request':state==='CONNECTING'?'Connecting':state==='DISCONNECTED'?'Waiting for connection':state==='ERROR'?'Needs your attention':'Ready when you are';
}
// The honesty line is true only when the projection is idle, the native app reports muted, or there is no projection.
// The activity line shares one start clock: a slow call adds its elapsed seconds only after SLOW_TOOL_MS.
let activityStartedAt = 0, activityKey = '';
function activityLineMarkup() {
  const activity = liveActivity(live);
  const key = activity ? `${activity.kind}:${activity.text}` : '';
  if (key !== activityKey) { activityKey = key; activityStartedAt = Date.now(); }
  return activityMarkup(activity, activity ? Date.now() - activityStartedAt : 0);
}
// The lookup subtitle that stands in for the voice-lane status while Naya looks (U1).
const LOOKUP_SOURCE_WORDS: Record<string, string> = { knowledge: 'lux', calendar: 'calendar', mail: 'mail', chat: 'Mattermost' };
const SLOW_LOOKUP_MS = 6000;
function lookupLineMarkup(current: LiveCurrent | undefined): string {
  const entries = current?.entries ?? [];
  let progress: ResearchProgressView | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = entries[index]!;
    if (candidate.kind === 'researchProgress' && candidate.progress) { progress = candidate.progress; break; }
  }
  if (!progress || progress.phase === 'done' || progress.phase === 'stopped') return '';
  if (progress.elapsedMs >= SLOW_LOOKUP_MS) return 'Still looking';
  const done = new Set(progress.sourcesDone);
  const sources = [...progress.sourcesDone, ...progress.sourcesPending]
    .map(kind => done.has(kind) ? `${LOOKUP_SOURCE_WORDS[kind] ?? kind} <span class="lookup-check" aria-hidden="true">&#10003;</span>` : LOOKUP_SOURCE_WORDS[kind] ?? kind)
    .join(', ');
  return `Looking in ${sources}`;
}
// The voice lane is the orb stage above the transcript (V3 items 1-3): the stage holds the top
// third and never scrolls, the transcript owns the rest of the lane and scrolls on its own.
function orbStateLineMarkup(): string {
  const lookup = lookupLineMarkup(live);
  if (lookup) return lookup;
  return e(live ? liveLabel(live) : liveStateCopy(liveMachine.view.state));
}
function orbControlsMarkup(): string {
  const view = liveMachine.view;
  const active = view.state === 'live' || view.state === 'muted' || view.state === 'starting';
  const error = liveErrorText(view.error, view.reason);
  return `${active ? `<button id="voice-stop" class="stop-pill">Stop</button><button id="voice-mute" class="quiet">${view.state === 'muted' ? 'Unmute' : 'Mute'}</button>` : `<button id="voice-start" class="start-pill" ${startAvailable(view) ? '' : 'aria-disabled="true"'}>Start</button>`}${error ? `<p class="voice-error" role="alert">${e(error)}</p>` : ''}`;
}
function orbCaptionMarkup(): string {
  const idle = !live || live.state === 'idle';
  return `<p class="voice-state" id="voice-state" role="status" aria-live="polite">${orbStateLineMarkup()}</p>${activityLineMarkup()}${idle ? '<p class="voice-hint">Press Start or \u2318\u21e7Space to talk</p>' : ''}`;
}
function orbStageMarkup(): string {
  const glow = ['CONNECTED','LISTENING','SPEAKING','PROCESSING'].includes(orbState());
  return `<section class="orb-stage" id="orb-stage" data-state="${orbState()}" aria-label="Naya voice and activity"><div class="orb-holder"><div class="presence-glow${glow ? ' visible' : ''}" aria-hidden="true"></div><canvas id="didi-orb" width="440" height="440" aria-hidden="true"></canvas></div><div class="orb-caption">${orbCaptionMarkup()}</div><div class="orb-actions">${orbControlsMarkup()}</div></section>`;
}
function voiceBodyMarkup(): string {
  return `${orbStageMarkup()}<section class="transcript" id="transcript" aria-label="Naya live conversation">${liveMarkup(live, livePoll)}<button type="button" class="jump-pill" id="transcript-jump" hidden>Jump to latest</button></section>`;
}
function chatLane() {
  return `<div id="connected-panel"></div>`;
}
function diagnosticsMarkup() {
  const view = liveMachine.view;
  const rows: [string, string][] = [
    ['Connection', connection],
    ['Service address', `${location.origin} /api/v1`],
    ['Live state', view.state],
    ['Microphone', view.mic],
    ['Live error', view.error ? `${view.error}${view.reason ? ` (${view.reason})` : ''}` : 'none'],
    ['Input route', view.route ? view.route.input : 'none'],
    ['Output route', view.route ? view.route.output : 'none'],
    ['Voice processing', view.route ? String(view.route.voiceProcessing) : 'none'],
    ['Consent', String(view.consent)],
    ['Last session ended', view.lastSessionEndedAt ? e(datetime(view.lastSessionEndedAt)) : 'never'],
  ];
  return `<section class="panel diagnostics" aria-label="Diagnostics">
  <div class="section-heading"><h2>Diagnostics</h2><span class="tag">debug view</span></div>
  <p class="muted">The bridge and service state behind the standard UI. Not part of the day-to-day app.</p>
  <dl>${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>
  </section>`;
}
function commitmentMarkup(c: Commitment, overdue = false) {
  return `<article class="commitment"><div class="commitment-body"><span class="tag ${c.status === 'active' ? '' : 'completed'}">${c.status === 'completed' ? 'Completed' : c.status === 'cancelled' ? 'Cancelled' : overdue ? 'Overdue' : c.dueAt ? 'Planned' : 'Unscheduled'}</span><h3>${e(c.title)}</h3>${c.notes ? `<p>${e(c.notes)}</p>` : ''}<p class="muted">${e(datetime(c.dueAt))}${c.dueAt ? ` · ${e(c.timeZone)}` : ''}</p>${c.sourceSessionId ? `<button class="quiet" data-source="${e(c.sourceSessionId)}">Open conversation source</button>` : ''}</div><div class="commitment-actions">${c.status === 'active' ? `<button class="secondary" data-complete="${e(c.id)}" aria-label="Complete ${e(c.title)}" ${disabled(!writable())}>Complete</button><button class="quiet" data-edit="${e(c.id)}" aria-label="Edit ${e(c.title)}" ${disabled(busy)}>Edit</button><button class="quiet" data-cancel="${e(c.id)}" ${disabled(!writable())}>Cancel commitment</button>` : `<button class="secondary" data-reopen="${e(c.id)}" aria-label="Reopen ${e(c.title)}" ${disabled(!writable())}>Reopen</button>`}<button class="quiet" data-history="${e(c.id)}" ${disabled(readBusy)}>History</button></div></article>`;
}
function today() {
  const active = [...(plan?.items.map(i=>i.commitment) ?? []), ...(plan?.unscheduled ?? [])];
  const completed = recent.filter(c => c.status !== 'active');
  return `<section class="page-heading"><div><p class="eyebrow">ONE NEXT STEP</p><h1>Today, with room to breathe.</h1><p>${e(new Intl.DateTimeFormat(undefined,{dateStyle:'full'}).format(new Date()))} · ${e(zone)}</p></div><button id="refresh-plan" class="secondary" ${disabled(readBusy)}>Refresh</button></section>
  <div class="today-grid"><section class="panel"><div class="section-heading"><h2>Your commitments</h2><span class="count">${active.length}</span></div>${active.length ? `<div class="commitment-list">${plan?.items.map(i=>commitmentMarkup(i.commitment,i.isOverdue)).join('') ?? ''}${plan?.unscheduled.length ? '<h3 class="subheading">Without a due date</h3>' : ''}${plan?.unscheduled.map(c=>commitmentMarkup(c)).join('') ?? ''}</div>` : '<div class="empty"><h3>A clear slate.</h3><p>No commitments due today or waiting for a date.</p></div>'}${plan?.nextCursor ? '<p class="callout">More commitments are available. This view is incomplete; refresh does not load the next page.</p>' : ''}${completed.length ? `<h3 class="subheading">Recently updated in this visit</h3>${completed.map(c=>commitmentMarkup(c)).join('')}` : ''}</section>
  <aside class="panel capture"><p class="eyebrow">KEEP IT SIMPLE</p><h2>Make a commitment</h2><p class="muted">Something you want to follow through on.</p><form id="commitment-form"><label for="commitment-title">Commitment title</label><input id="commitment-title" maxlength="500" required value="${e(status ? titleDraft : '')}" placeholder="What’s the next step?"><button type="submit" ${disabled(!writable() || !status?.capabilities.commitments)}>Add commitment</button></form><div class="aside-note">Dates can be added or corrected after saving. Nothing is scheduled by this browser while offline.</div></aside></div>
  ${editing ? `<section class="panel editor" aria-labelledby="edit-heading"><h2 id="edit-heading">Adjust your commitment</h2><form id="edit-form"><label for="edit-title">Title</label><input id="edit-title" required maxlength="500" value="${e(editTitle)}"><label for="edit-notes">Notes</label><textarea id="edit-notes" rows="2">${e(editNotes)}</textarea><label for="edit-due">Due date and time</label><input id="edit-due" type="datetime-local" value="${e(editDue)}"><small>Shown in ${e(zone)}. Leave empty to remove the due date.</small><div class="button-row"><button type="submit" ${disabled(!writable())}>Save changes</button><button type="button" id="close-edit" class="secondary">Keep current date</button></div></form></section>` : ''}
  ${detail ? `<section class="panel editor"><h2>Commitment history</h2><p>${e(detail.commitment.title)}</p>${detail.history.length ? detail.history.map(h=>`<p>Revision ${h.revision} · ${e(h.operation)} · ${e(datetime(h.recordedAt))}<br>${e(h.title)} · ${e(datetime(h.dueAt))}</p>`).join('') : '<p class="muted">No history returned by the service.</p>'}<button id="close-history" class="quiet">Close history</button></section>` : ''}`;
}
function memory() {
  return `<section class="page-heading"><div><p class="eyebrow">REMEMBER, WITH CONTEXT</p><h1>Pick up the thread.</h1><p>Your words, connected to where they came from.</p></div></section>${memoryListMarkup(entries, { filter: status ? memoryFilter : '', disabled: !writable() || busy || connectedView.active })}<section class="panel recall"><form id="recall-form"><label for="recall-query">Search your memory</label><div class="search-row"><input id="recall-query" type="search" value="${e(status ? queryDraft : '')}" maxlength="500" placeholder="A phrase, a project, a thought…"><button ${disabled(connection !== 'Connected' || readBusy || !status?.capabilities.memory)}>Search</button></div></form>${recall ? `<p class="muted">${recall.totalMatches} ${recall.totalMatches === 1 ? 'match' : 'matches'}${recall.truncated || recall.nextCursor ? ' · Partial results; more are available in the service.' : ''}</p>${recall.hits.length ? recall.hits.map(hit=>`<article class="recall-hit"><p>${e(hit.snippet)}</p><small>${e(datetime(hit.sourceTimestamp))}</small>${sourceMarkup(hit.sourceRefs)}${hit.entryId ? memoryDeleteControl(hit.entryId, !writable() || busy || connectedView.active) : ''}<button class="quiet" data-source="${e(hit.sessionId)}">Open conversation source</button></article>`).join('') : '<div class="empty"><h3>No matches yet.</h3><p>Try a different phrase. Didi won’t invent a memory to fill the gap.</p></div>'}` : '<div class="empty"><span class="empty-icon" aria-hidden="true">↗</span><h3>Find the words you kept.</h3><p>Search saved conversations. Unavailable sources stay clearly marked.</p></div>'}</section>`;
}
function settingsInput() { return { status, statusUnavailable, connections, connectionsUnavailable: connectionsStale, theme, connected: { conversations: connectedView.history, remember: connectedView.remember, busy: connectedView.busy, standingRevoke: connectedView.standingRevoke, conversationState: connectedView.conversationState } }; }
function settings() {
  const permissions = typeof Notification === 'undefined' ? 'Not supported in this browser' : Notification.permission === 'granted' ? 'Allowed by this browser; no delivery is configured' : Notification.permission === 'denied' ? 'Blocked in browser settings' : 'Not requested';
  return `<section class="page-heading"><div><p class="eyebrow">YOUR SETUP, PLAINLY</p><h1>Make yourself at home.</h1><p>Know what’s connected. Choose what’s allowed.</p></div></section><div class="settings-grid">${settingsMarkup(settingsInput())}<section class="panel"><h2>Connection</h2><dl><dt>Service</dt><dd>${e(connection)}</dd><dt>Time zone</dt><dd>${e(zone)}</dd><dt>Privacy</dt><dd>Messages stay in your service. This browser keeps only the app shell for offline opening.</dd></dl><div class="button-row"><button id="reconnect" class="secondary" ${disabled(readBusy)}>Reconnect</button><button id="logout" class="quiet" ${disabled(!writable())}>Unpair this browser</button></div><p class="muted">Browser pairing uses a secure cookie, not a saved token. ${demoMode ? 'This is an isolated synthetic test service.' : 'Ask your local service for a one-time pairing code.'}</p></section>
  <section class="panel"><h2>Conversation model</h2><span class="tag">${status?.model.configured ? 'Connected' : 'No model connected'}</span><p>${status?.model.configured ? `${e(status.model.provider ?? '')} ${e(status.model.model ?? '')}` : 'Local Save never sends to a model. You can save thoughts, recall messages, and manage commitments. Replies need a model configured in your service.'}</p></section>
  <section class="panel"><h2>Permissions</h2><dl><dt>Notifications</dt><dd>${e(permissions)}</dd><dt>Delivery</dt><dd>${status?.capabilities.notifications ? 'Available through your service; browser delivery is not set up' : 'Not configured'}</dd><dt>Microphone</dt><dd>Not requested. Voice capture is not part of this browser version.</dd></dl><p class="muted">Nothing here listens in the background. Change denied permissions in your browser settings.</p></section><section class="panel companion"><span class="eyebrow">A HELPING HAND ON YOUR MAC</span><h2>Mac companion</h2><p>The native companion can provide local Mac notifications and device features when you allow them.</p><p class="muted">This browser cannot control your Mac, start its microphone, or grant permissions for it. Open the companion to manage those choices.</p><a class="credits" href="/third-party-notices.txt">Orb dependency notices</a></section></div>`;
}
function pairingReady() { return pairingRequired && connection==='Pair this browser' && !pairingBusy && navigator.onLine; }
function pairing() { return `<section class="panel pairing"><p class="eyebrow">A PRIVATE CONNECTION</p><h1>Hello. Let’s connect.</h1><p>Enter the one-time code shown by your local service. It stays out of the address bar and isn’t saved here.</p><form id="pair-form"><label for="pair-code">One-time pairing code</label><input id="pair-code" type="password" autocomplete="off" spellcheck="false" required ${disabled(!pairingReady())}><button ${disabled(!pairingReady())}>Pair this browser</button></form><p class="muted" role="status">${connection==='Connecting' ? 'Checking the local service. Wait for the check before entering a code.' : !navigator.onLine || connection==='Offline' ? 'You are offline. Check the connection after reconnecting before entering a code.' : connection==='Disconnected' ? 'Check the local service connection before entering a code.' : 'Enter the current one-time code to pair this browser.'}</p><p class="muted">Open your local service or Mac companion to get a code. Codes expire after five minutes and can only be used once.</p><button id="reconnect" class="quiet">Check connection again</button></section>`; }
const LIVE_COPY: Record<NativeLiveState, string> = { idle: 'Live is off', starting: 'Starting', live: 'Listening', muted: 'Muted', stopping: 'Stopping', error: 'Needs your attention' };
function liveStateCopy(state: NativeLiveState): string { return LIVE_COPY[state] ?? 'Live is off'; }
const RAIL_ICONS: Record<RouteId, string> = {
  // 20 px line icons, currentColor, no fill.
  today: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></svg>',
  memory: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 4.5h11.5v15L12 16l-5.5 3.5z"/></svg>',
  settings: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M2.8 12h2.6M18.6 12h2.6M4.5 19.5l1.8-1.8M17.7 6.3l1.8-1.8"/></svg>',
  diagnostics: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>',
};
function railMarkup() {
  const items: [RouteId, string][] = [['today', 'Today'], ['memory', 'Memory'], ['settings', 'Settings'], ['diagnostics', 'Diagnostics']];
  const tabName: Partial<Record<RouteId, string>> = { today: 'Today', memory: 'Memory', settings: 'Settings' };
  return `<nav class="rail" id="rail" aria-label="Program menu" data-rail="${layout.rail}">${items.map(([id, label]) => `<button class="rail-item" data-route="${id}"${tabName[id] ? ` data-tab="${tabName[id]}"` : ''} aria-expanded="${layout.sheet === id}" aria-controls="sheet" aria-label="${label}" title="${label}"><span class="rail-icon" aria-hidden="true">${RAIL_ICONS[id]}</span><span class="rail-label">${label}</span></button>`).join('')}</nav>`;
}
function sheetMarkup() {
  if (!layout.sheet) return '';
  const content = { today, memory, settings, diagnostics: diagnosticsMarkup }[layout.sheet]();
  const title = layout.sheet.charAt(0).toUpperCase() + layout.sheet.slice(1);
  return `<div class="sheet-scrim" data-close-sheet></div><aside class="sheet" id="sheet" role="dialog" aria-modal="true" aria-label="${title}"><header class="sheet-head"><h2>${title}</h2><button class="icon-button" id="sheet-close" aria-label="Close ${title}">\u2715</button></header><div class="sheet-body">${content}</div></aside>`;
}
function laneSwitcherMarkup() {
  return `<div class="lane-switch" role="tablist" aria-label="Voice or Chat">${(['voice', 'chat'] as LaneId[]).map(id => `<button role="tab" data-segment="${id}" aria-selected="${layout.segment === id}" class="seg${layout.segment === id ? ' active' : ''}">${id === 'voice' ? 'Voice' : 'Chat'}</button>`).join('')}</div>`;
}
function livePillMarkup() {
  const view = liveMachine.view;
  if (!pillVisible(view)) return '';
  const muted = view.state === 'muted';
  return `<div class="live-pill" id="live-pill" role="status" aria-label="Live session active"><span class="live-dot" aria-hidden="true"></span><span class="live-pill-label">${muted ? 'Muted' : 'Live'}</span>${muted ? '<button class="pill-button" id="pill-unmute">Unmute</button>' : '<button class="pill-button" id="pill-mute">Mute</button>'}<button class="pill-button danger" id="pill-stop">Stop</button></div>`;
}
function consentPopoverMarkup() {
  const view = liveMachine.view;
  if (!view.consentOpen) return '';
  return `<div class="consent-scrim"></div><section class="consent-popover" role="dialog" aria-modal="true" aria-label="${e(LIVE_CONSENT.title)}"><h2>${e(LIVE_CONSENT.title)}</h2><p>${e(LIVE_CONSENT.body)}</p><div class="consent-actions"><button id="consent-dismiss" class="quiet">${e(LIVE_CONSENT.dismiss)}</button><button id="consent-allow" class="primary">${e(LIVE_CONSENT.allow)}</button></div></section>`;
}
// The stage controls: the new-session "+" and, from the lane shell, the lane toggle (V3 item 1).
function voiceHeadMarkup() {
  return '<button id="new-conversation" class="icon-button" aria-label="New conversation" title="New conversation"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>';
}
function chatHeadMarkup() {
  return `<p class="lane-title">Chat</p>`;
}
function laneShell(id: LaneId, label: string, headerHtml: string, bodyHtml: string) {
  const state = layout[id];
  const control = collapseControl(layout, id);
  const verb = state === 'open' ? 'Hide' : 'Show';
  return `<section class="lane lane-${id}" id="lane-${id}" data-state="${state}" role="region" aria-label="${label}"><header class="lane-head">${headerHtml}<button class="lane-toggle" data-lane="${id}" aria-expanded="${control['aria-expanded']}" aria-controls="${control['aria-controls']}"${control['aria-disabled'] ? ' aria-disabled="true"' : ''} title="${verb} ${label.toLowerCase()}" aria-label="${verb} ${label.toLowerCase()}">${state === 'open' ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 9.5l-2.5 2.5 2.5 2.5"/></svg>' : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M12.5 9.5L15 12l-2.5 2.5"/></svg>'}</button></header><div class="lane-inner" id="lane-${id}-primary" tabindex="-1">${bodyHtml}</div></section>`;
}
const scrollAnchor = new WeakMap<HTMLElement, boolean>();
const scrollObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => { for (const entry of entries) { const el = entry.target as HTMLElement; if (scrollAnchor.get(el)) el.scrollTop = el.scrollHeight; } }) : undefined;
// Stick a transcript to the bottom only while the reader has not scrolled up. A scroll event (not a pixel
// threshold) decides, and a ResizeObserver compensates when the composer grows or a chip expands.
function bindScrollAnchors() {
  const targets = [document.getElementById('connected-entries'), document.querySelector<HTMLElement>('.live-transcript')].filter((el): el is HTMLElement => !!el);
  for (const el of targets) {
    if (!scrollAnchor.has(el)) {
      scrollAnchor.set(el, true);
      el.addEventListener('scroll', () => { scrollAnchor.set(el, el.scrollHeight - el.scrollTop - el.clientHeight <= 4); });
    }
    if (scrollAnchor.get(el)) el.scrollTop = el.scrollHeight;
    scrollObserver?.observe(el);
  }
}
function render() {
  // Keep cursor and unsent text stable across connection checks and action completion.
  const focus = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = focus?.id; const selection = focus && (focus.tagName === 'TEXTAREA' || ['text','search','password'].includes(focus.type)) ? [focus.selectionStart,focus.selectionEnd] : null;
  orb?.destroy();orb=undefined;transcriptPin?.stop();transcriptPin=undefined;
  root.innerHTML = `<a id="skip-to-content" class="skip" href="#main">Skip to content</a><div class="app-shell" data-rail="${layout.rail}" data-narrow="${layout.narrow}" data-segment="${layout.segment}" data-sheet="${layout.sheet ?? ''}"><header class="app-header">${pairingRequired ? '' : `<button id="rail-toggle" class="icon-button" aria-expanded="${layout.rail==='expanded'}" aria-controls="rail" aria-label="Program menu">☰</button>`}<a class="brand-mini" href="/" aria-label="Didi home"><img src="/icon.svg" alt="" width="22" height="22"><span>didi<span class="brand-dot">.</span></span></a>${pairingRequired ? '' : laneSwitcherMarkup()}${livePillMarkup()}<div class="connection"><span class="connection-dot ${connection==='Connected'?'online':''}"></span><span id="connection-state" role="status" aria-live="polite" aria-atomic="true">${e(connection)}</span><button id="reconnect-top" class="quiet" aria-label="Refresh connection">↻</button></div></header>${demoMode || status?.serviceMode==='synthetic-test' ? '<div class="demo-banner"><strong>Demo test mode</strong><span>Isolated synthetic data · not your personal service</span></div>' : ''}<div class="lane-row">${pairingRequired ? '' : railMarkup()}<main id="main" tabindex="-1" class="lanes">${error ? `<div class="alert" role="alert" aria-live="assertive">${e(error)}</div>` : ''}${notice ? `<div class="notice" role="status" aria-live="polite" aria-atomic="true">${e(notice)}</div>` : ''}${readBusy ? '<p class="loading" role="status" aria-live="polite" aria-atomic="true">Loading your records…</p>' : ''}${busy ? '<button id="cancel-request" class="quiet">Stop waiting</button>' : ''}${pairingRequired ? pairing() : `${laneShell('voice','Voice',voiceHeadMarkup(),voiceBodyMarkup())}${laneShell('chat','Chat',chatHeadMarkup(),chatLane())}`}</main></div>${sheetMarkup()}${consentPopoverMarkup()}</div>`;
  bind();
  bindScrollAnchors();
  connectedView.attach();
  bindTranscript();
  for(const id of ['commitment-title','recall-query','memory-filter']){const field=document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;if(field)field.disabled=!status;}
  attachMemoryDeleteControls(root, !writable() || busy || connectedView.active, id => void deleteMemory(id));
  const canvas=document.getElementById('didi-orb') as HTMLCanvasElement | null;
  if(canvas)orb=new Orb(canvas,appliedOrbState=orbState());
  if (focusId) { const next=document.getElementById(focusId) as HTMLInputElement | HTMLTextAreaElement | null; next?.focus({preventScroll:true}); if(selection && next && selection[0]!==null) next.setSelectionRange(selection[0],selection[1]); }
}
function button(id: string, action: () => void) { document.getElementById(id)?.addEventListener('click', action); }
function form(id: string, action: () => void) { document.getElementById(id)?.addEventListener('submit', ev => { ev.preventDefault(); action(); }); }
function input(id: string, action: (value: string) => void) { document.getElementById(id)?.addEventListener('input', ev=>action((ev.target as HTMLInputElement).value)); }
function findCommitment(id: string) { return [...(plan?.items.map(i=>i.commitment) ?? []), ...(plan?.unscheduled ?? []), ...recent].find(c=>c.id===id); }
// Attached by every full bind and after the periodic settings-summary re-render, which replaces the select.
function bindConnectedHistory() { document.getElementById('connected-history')?.addEventListener('change',ev=>{const next=(ev.target as HTMLSelectElement).value;if(next)void connectedView.select(next).catch(err=>{error=failure(err);render();});}); }
function bind() {
  document.getElementById('rail-toggle')?.addEventListener('click', () => { layout = toggleRail(layout); render(); });
  root.querySelectorAll<HTMLElement>('button[data-route]').forEach(el => el.onclick = () => { const route = el.dataset.route as RouteId; layout = openSheet(layout, route); if (route === 'today') { tab = 'Today'; void loadTab(); } else if (route === 'memory') { tab = 'Memory'; } notice = ''; error = ''; render(); });
  document.getElementById('sheet-close')?.addEventListener('click', () => { layout = closeSheet(layout); render(); });
  root.querySelector('.sheet-scrim')?.addEventListener('click', () => { layout = closeSheet(layout); render(); });
  root.querySelectorAll<HTMLElement>('button[data-lane]').forEach(el => el.onclick = () => { const id = el.dataset.lane as LaneId; layout = toggleLane(layout, id); render(); if (layout[id] === 'collapsed') document.getElementById(focusTargetAfterCollapse(id))?.focus(); });
  root.querySelectorAll<HTMLElement>('button[data-segment]').forEach(el => el.onclick = () => { const segment = el.dataset.segment as LaneId; layout = selectSegment(layout, segment); render(); document.getElementById(`lane-${segment}`)?.scrollIntoView({ block: 'start' }); });
  document.getElementById('voice-start')?.addEventListener('click', () => liveMachine.requestStart());
  document.getElementById('voice-stop')?.addEventListener('click', () => liveMachine.requestStop());
  document.getElementById('voice-mute')?.addEventListener('click', () => liveMachine.toggleMute());
  document.getElementById('pill-stop')?.addEventListener('click', () => liveMachine.requestStop());
  document.getElementById('pill-mute')?.addEventListener('click', () => liveMachine.toggleMute());
  document.getElementById('pill-unmute')?.addEventListener('click', () => liveMachine.toggleMute());
  document.getElementById('consent-allow')?.addEventListener('click', () => liveMachine.grantConsent());
  document.getElementById('consent-dismiss')?.addEventListener('click', () => liveMachine.dismissConsent());
  root.querySelectorAll<HTMLElement>('[data-session]').forEach(el=>el.onclick=()=>void openSession(el.dataset.session!));
  root.querySelectorAll<HTMLElement>('[data-source]').forEach(el=>el.onclick=()=>{tab='Conversation';void openSession(el.dataset.source!);});
  root.querySelectorAll<HTMLElement>('[data-edit]').forEach(el=>el.onclick=()=>{editing=findCommitment(el.dataset.edit!);if(editing){editTitle=editing.title;editNotes=editing.notes;editDue=localInput(editing.dueAt);}render();document.getElementById('edit-title')?.focus();});
  root.querySelectorAll<HTMLElement>('[data-history]').forEach(el=>el.onclick=()=>void loadHistory(el.dataset.history!));
  for(const action of ['complete','reopen','cancel'] as const) root.querySelectorAll<HTMLElement>(`[data-${action}]`).forEach(el=>el.onclick=()=>{const c=findCommitment(el.dataset[action]!);if(c) void changeCommitment(c,action);});
  root.querySelectorAll<HTMLElement>('[data-capture]').forEach(el=>el.onclick=()=>{const entry=entries.find(v=>v.id===el.dataset.capture);if(entry)void mutate(async (signal,version)=>{await request<Commitment>('/commitments',{method:'POST',body:{title:entry.text,notes:'',dueAt:null,timeZone:zone,sourceSessionId:entry.sessionId,sourceEntryId:entry.id},signal});assertAuthority(version);notice='Commitment saved. Find it in Today.';});});
  document.getElementById('conversation-select')?.addEventListener('change',ev=>{const id=(ev.target as HTMLSelectElement).value;if(id)void openSession(id);else{session=undefined;entries=[];render();}});
  const appearance = root.querySelector<HTMLSelectElement>('#appearance-theme');
  if(appearance) appearance.onchange=()=>{theme=appearance.value==='light'?'light':'dark';saveTheme(themeStorage(),theme);applyTheme(document.documentElement,theme);nativeBridge?.send({type:'theme',mode:theme});render();};
  bindLiveDisclosure();
  input('commitment-title',v=>titleDraft=v);input('recall-query',v=>queryDraft=v);input('edit-title',v=>editTitle=v);input('edit-notes',v=>editNotes=v);input('edit-due',v=>editDue=v);input('memory-filter',v=>{memoryFilter=v;render();});
  form('commitment-form',()=>{if(!titleDraft.trim())return;void mutate(async (signal,version)=>{await request<Commitment>('/commitments',{method:'POST',body:{title:titleDraft.trim(),dueAt:null,timeZone:zone},signal});assertAuthority(version);titleDraft='';await loadPlan();assertAuthority(version);notice='Commitment saved.';});});
  form('edit-form',()=>{if(!editing || !editTitle.trim())return;void changeCommitment(editing,'edit');});
  form('recall-form',()=>void searchRecall());
  form('pair-form',()=>{const code=(document.getElementById('pair-code') as HTMLInputElement).value;void pairBrowser(code);});
  button('new-conversation',()=>{session=undefined;entries=[];entriesMore=false;historyOpen=true;notice='';render();});
  button('close-edit',()=>{editing=undefined;render();});button('close-history',()=>{detail=undefined;render();});
  button('refresh-plan',()=>void loadTab()); button('reconnect',()=>void connect());button('reconnect-top',()=>void connect());
  button('logout',()=>void mutate(async()=>{await logout();}));
  button('cancel-request',()=>controller?.abort());
  document.getElementById('connected-remember')?.addEventListener('change',ev=>connectedView.setRemember((ev.target as HTMLInputElement).checked));
  bindConnectedHistory();
  document.getElementById('connected-standing-revoke')?.addEventListener('click',()=>void connectedView.revokeStanding());
  document.getElementById('connected-revoke')?.addEventListener('click',()=>void connectedView.revokeConversation());
  document.getElementById('connected-recover')?.addEventListener('click',()=>void connectedView.recoverHistory());
}
async function mutate(action: (signal: AbortSignal, version: AbortSignal) => Promise<void>) {
  if(!writable())return;
  const version=authorityVersion(), owned=new AbortController();
  busy=true;error='';notice='';controller=owned;render();
  const timeout=setTimeout(()=>owned.abort(),20000);
  try {await action(owned.signal,version);} catch(err){if(version===authorityVersion()&&controller===owned)error=failure(err,true);}
  finally{clearTimeout(timeout);if(version===authorityVersion()&&controller===owned){busy=false;controller=undefined;render();}}
}
async function changeCommitment(c: Commitment, action: 'edit'|'complete'|'reopen'|'cancel') {
  await mutate(async (signal,version)=>{
    try {
      const body=action==='edit'?{expectedRevision:c.revision,title:editTitle.trim(),notes:editNotes,dueAt:editDue?new Date(editDue).toISOString():null,timeZone:zone}:{expectedRevision:c.revision};
      const updated=await request<Commitment>(`/commitments/${encodeURIComponent(c.id)}${action==='edit'?'':`/${action}`}`,{method:action==='edit'?'PATCH':'POST',body,signal});
      assertAuthority(version);recent=[updated,...recent.filter(r=>r.id!==updated.id)];editing=undefined;
      await loadPlan();assertAuthority(version);notice=action==='edit'?'Due date updated.':action==='complete'?'Commitment completed.':action==='reopen'?'Commitment reopened.':'Commitment cancelled.';
    } catch(err) {
      if(version===authorityVersion() && err instanceof ApiError && err.status===409 && err.code==='CONFLICT'){
        const latest=await request<CommitmentDetail>(`/commitments/${encodeURIComponent(c.id)}`);
        assertAuthority(version);recent=[latest.commitment,...recent.filter(r=>r.id!==c.id)];await loadPlan();
        // Preserve correction draft, but require explicit review with the new revision.
        assertAuthority(version);if(action==='edit')editing=latest.commitment;
        throw new ApiError('REVISION_CONFLICT','This changed on another device. The latest version is loaded. Review it before trying again.',409);
      }
      throw err;
    }
  });
}
async function loadPlan() {
  const version=authorityVersion(), generation=readGeneration;
  const current=await request<Plan>(`/plan?date=${localDate()}&timeZone=${encodeURIComponent(zone)}`);
  if(version===authorityVersion()&&generation===readGeneration)plan=current;
}
async function loadTab() {
  if(connection!=='Connected')return;
  const version=authorityVersion(),generation=++readGeneration;readBusy=true;render();
  try {
    if(tab==='Today')await loadPlan();
    if(tab==='Conversation'){const list=await request<{items:Session[];nextCursor:string|null}>('/sessions');if(version===authorityVersion()&&generation===readGeneration){sessions=list.items;sessionMore=!!list.nextCursor;}}
  } catch(err){if(version===authorityVersion()&&generation===readGeneration)error=failure(err);}
  finally{if(version===authorityVersion()&&generation===readGeneration){readBusy=false;render();}}
}
async function openSession(id: string) {
  const version=authorityVersion(),generation=++readGeneration;readBusy=true;render();
  try {const data=await request<{session:Session;entries:Entry[];nextCursor:string|null}>(`/sessions/${encodeURIComponent(id)}`);if(version===authorityVersion()&&generation===readGeneration){session=data.session;entries=data.entries;entriesMore=!!data.nextCursor;historyOpen=true;tab='Conversation';notice='';error='';}}
  catch(err){if(version===authorityVersion()&&generation===readGeneration)error=failure(err);}
  finally{if(version===authorityVersion()&&generation===readGeneration){readBusy=false;render();}}
}
async function loadHistory(id: string){
  const version=authorityVersion(),generation=++readGeneration;readBusy=true;render();
  try{const current=await request<CommitmentDetail>(`/commitments/${encodeURIComponent(id)}`);if(version===authorityVersion()&&generation===readGeneration)detail=current;}
  catch(err){if(version===authorityVersion()&&generation===readGeneration)error=failure(err);}
  finally{if(version===authorityVersion()&&generation===readGeneration){readBusy=false;render();}}
}
async function searchRecall(){
  if(connection!=='Connected'||readBusy)return;
  const version=authorityVersion(),generation=++readGeneration;readBusy=true;error='';render();
  try{const current=await request<Recall>(`/recall?q=${encodeURIComponent(queryDraft.trim())}&limit=20`);if(version===authorityVersion()&&generation===readGeneration)recall=current;}
  catch(err){if(version===authorityVersion()&&generation===readGeneration)error=failure(err);}
  finally{if(version===authorityVersion()&&generation===readGeneration){readBusy=false;render();}}
}
async function pairBrowser(code: string){
  if(!pairingReady())return;
  const version=authorityVersion();pairingBusy=true;error='';render();
  try{await pair(code);assertAuthority(version);pairingRequired=false;await connect();}
  catch(err){if(version===authorityVersion())error=failure(err);}
  finally{if(version===authorityVersion()){pairingBusy=false;render();}}
}
function adoptOwner(current: Status){
  if(draftOwner && draftOwner!==current.assistantId){messageDraft='';titleDraft='';queryDraft='';memoryFilter='';}
  draftOwner=current.assistantId;
}
async function connect(background=false) {
  const version=authorityVersion(),populate=!status;
  if(!navigator.onLine){connection='Offline';render();schedulePoll();return;}
  if(!background){connection='Connecting';error='';render();}
  try {
    await restoreSession();assertAuthority(version);
    const current=await request<Status>('/status',{signal:AbortSignal.timeout(8000)});assertAuthority(version);
    adoptOwner(current);status=current;statusUnavailable=false;connection='Connected';pairingRequired=false;backoff=30000;
    if(!background||populate){await loadTab();assertAuthority(version);await connectedView.refresh(current.assistantId);assertAuthority(version);}
  } catch(err){if(version!==authorityVersion())return;error=failure(err);statusUnavailable=true;if(connection!=='Offline')connection=navigator.onLine?'Disconnected':'Offline';backoff=Math.min(backoff*2,120000);}
  if(version!==authorityVersion())return;
  render();schedulePoll();void pollLive();void pollConnections();
}
function schedulePoll(){if(pollTimer)clearTimeout(pollTimer);pollTimer=undefined;const version=authorityVersion();if(!document.hidden&&!pairingRequired)pollTimer=setTimeout(()=>{if(version===authorityVersion())void connect(true);},backoff);}
// Live projection poll: 1 Hz while active, 4 s while idle or terminal, paused while hidden. The route is W-B's;
// a missing or failed route leaves the last honest state and never fabricates one.
async function pollLive(){
  if(liveTimer)clearTimeout(liveTimer);
  liveTimer=undefined;
  if(document.hidden||pairingRequired||liveBusy)return;
  const version=authorityVersion();liveBusy=true;
  try{
    const prior=livePoll;
    const next=await pollLiveView(prior,cursor=>fetchLive(cursor,AbortSignal.timeout(8000)));
    if(version!==authorityVersion()||livePoll!==prior)return;
    livePoll=next;live=livePoll.live;paintLive();
  }
  finally{if(version===authorityVersion()){liveBusy=false;scheduleLive();}}
}
async function pollConnections(){
  if(connectionsTimer)clearTimeout(connectionsTimer);connectionsTimer=undefined;
  if(document.hidden||pairingRequired||connectionsBusy)return;
  const version=authorityVersion();connectionsBusy=true;
  try{const current=await request<unknown>('/live/connections',{signal:AbortSignal.timeout(8000)});if(version!==authorityVersion())return;connections=current;connectionsStale=false;}
  catch{if(version===authorityVersion())connectionsStale=true;}
  finally{
    if(version===authorityVersion()){
      connectionsBusy=false;
      const panel=document.getElementById('connections-panel');if(panel)panel.outerHTML=connectionsMarkup(connections,connectionsStale);
      const summary=document.getElementById('settings-summary');if(summary)summary.outerHTML=settingsMarkup(settingsInput());
      // The replaced summary carries a fresh #connected-history select; re-bind so the choice still publishes.
      bindConnectedHistory();
      if(!document.hidden&&!pairingRequired)connectionsTimer=setTimeout(()=>{if(version===authorityVersion())void pollConnections();},10000);
    }
  }
}
function bindLiveDisclosure(){document.querySelector<HTMLDetailsElement>('#live-details')?.addEventListener('toggle',event=>{liveDetailsOpen=(event.target as HTMLDetailsElement).open;});}
function scheduleLive(){
  if(liveTimer)clearTimeout(liveTimer);liveTimer=undefined;
  const version=authorityVersion();if(liveDelay(live?.state,document.hidden)!==undefined&&!pairingRequired)liveTimer=setTimeout(()=>{if(version===authorityVersion())void pollLive();},liveDelay(live?.state,document.hidden));
}
function renderTranscript(list: HTMLElement) {
  // Stable segment keys keep a streaming line in place: only lines that are new fade and rise in.
  const segments = liveSegments(live);
  const children = [...list.children] as HTMLElement[];
  if (children.length === segments.length && segments.every((segment, index) => children[index]!.dataset.seg === segment.key)) {
    segments.forEach((segment, index) => { const child = children[index]!; if (child.outerHTML !== segment.html) child.outerHTML = segment.html; });
    return;
  }
  const known = new Set(children.map(child => child.dataset.seg ?? ''));
  list.innerHTML = segments.map(segment => segment.html).join('') || '<p class="muted">No live transcription yet.</p>';
  for (const child of [...list.children] as HTMLElement[]) if (!known.has(child.dataset.seg ?? '')) child.classList.add('entry-new');
}
function bindTranscript() {
  transcriptPin?.stop(); transcriptPin = undefined;
  const list = document.querySelector<HTMLElement>('#transcript .live-turns');
  const pill = document.getElementById('transcript-jump');
  if (list && pill) transcriptPin = attachPin(list, pill);
}
function paintLive(){
  // A poll rewrites the state line and the transcript only, so the orb canvas and the controls keep
  // their listeners and the stage never moves (V3 item 8).
  const caption=document.querySelector('.orb-caption');const markup=orbCaptionMarkup();if(caption && caption.innerHTML!==markup)caption.innerHTML=markup;
  const list=document.querySelector<HTMLElement>('#transcript .live-turns');
  if(list)renderTranscript(list);
  const next=orbState();if(next!==appliedOrbState){appliedOrbState=next;orb?.setState(next);}
  if(liveMachine.view.state==='starting')transcriptPin?.repin();
}
onAuthorityChanged(reason=>{
  ++readGeneration;controller?.abort();controller=undefined;busy=false;readBusy=false;pairingBusy=false;connectionsBusy=false;liveBusy=false;
  for(const timer of [pollTimer,liveTimer,connectionsTimer])if(timer)clearTimeout(timer);
  pollTimer=undefined;liveTimer=undefined;connectionsTimer=undefined;
  connectedView.reset();live=undefined;livePoll={};connections=[];connectionsStale=false;
  statusUnavailable=false;status=undefined;sessions=[];entries=[];session=undefined;plan=undefined;recall=undefined;recent=[];
  detail=undefined;editing=undefined;editTitle='';editNotes='';editDue='';sessionMore=false;entriesMore=false;error='';notice='';
  if(reason==='logout'){draftOwner=undefined;messageDraft='';titleDraft='';queryDraft='';memoryFilter='';notice='This browser is unpaired.';}
  pairingRequired=reason==='unauthenticated'||reason==='logout';connection=pairingRequired?'Pair this browser':'Disconnected';
  render();if(reason==='changed'){backoff=30000;schedulePoll();}
});
window.addEventListener('offline',()=>{connectedView.detach();connection='Offline';livePoll={...livePoll,stale:true};connectionsStale=true;statusUnavailable=true;if(connectionsTimer)clearTimeout(connectionsTimer);if(pollTimer)clearTimeout(pollTimer);if(liveTimer)clearTimeout(liveTimer);render();});
window.addEventListener('online',()=>{if(!pairingRequired)void connect();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(connectionsTimer)clearTimeout(connectionsTimer);if(pollTimer)clearTimeout(pollTimer);if(liveTimer)clearTimeout(liveTimer);}else if(!pairingRequired){void connect(true);}});
if('serviceWorker' in navigator && import.meta.env.PROD)void navigator.serviceWorker.register('/sw.js').catch(()=>{ /* Shell availability is optional; never imply offline saving. */ });
theme=loadTheme(themeStorage());applyTheme(document.documentElement,theme);
const installed = installNativeBridge(window as unknown as Record<string, unknown>, (_kind, type) => { console.debug(`didi bridge: ignored unknown ${_kind} type ${type}`); });
nativeBridge = installed.bridge;
nativeFake = installed.fake;
liveMachine = new LiveMachine(message => nativeBridge!.send(message));
liveMachine.on(() => render());
nativeBridge.onNative(message => liveMachine.receive(message));
nativeBridge.send({ type: 'theme', mode: theme });
nativeBridge.send({ type: 'ready' });
// A viewport flip only changes the narrow breakpoint; update the attribute in place so the orb canvas is never
// torn down under a measurement (the frozen connected-browser smoke measures right after setViewportSize).
window.addEventListener('resize', () => { const next = withViewport(layout, window.innerWidth); if (next !== layout) { layout = next; root.querySelector('.app-shell')?.setAttribute('data-narrow', String(layout.narrow));
    root.querySelector('.app-shell')?.setAttribute('data-segment', layout.segment); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && layout.sheet) { layout = closeSheet(layout); render(); } });
render();void connect();


async function deleteMemory(id: string) {
  if (connectedView.active) return;
  await mutate(async (signal,version) => {
    const deleted = await deleteMemoryAndReload(id, {
      confirm: () => window.confirm('Delete this memory permanently? Earlier chat and voice transcripts are not rewritten.'),
      remove: entryId => deleteMemoryEntry(entryId, signal),
      deleted: message => {if(version===authorityVersion())notify(message);},
      reload: async () => {
        assertAuthority(version);
        const current = session ? await request<{session:Session;entries:Entry[];nextCursor:string|null}>(`/sessions/${encodeURIComponent(session.id)}`, { signal }) : undefined;
        assertAuthority(version);
        const results = recall ? await request<Recall>(`/recall?q=${encodeURIComponent(queryDraft)}&limit=50`, { signal }) : undefined;
        return { current, results };
      },
      apply: ({ current, results }) => {
        if(version!==authorityVersion())return;
        if (current) { session = current.session; entries = current.entries; entriesMore = !!current.nextCursor; }
        recall = results;
      },
    });
    if (!deleted || version!==authorityVersion()) return;
    // A successful owner deletion invalidates the frozen view's cached selections.
    // Refresh from the service, rather than filtering entry ids in the browser.
    connectedView.reset();
    if (status) await connectedView.refresh(status.assistantId);
  });
}
const memoryControlsObserver = new MutationObserver(() => attachMemoryDeleteControls(root, !writable() || busy || connectedView.active, id => void deleteMemory(id)));
memoryControlsObserver.observe(root, { childList: true, subtree: true });
