// Read-only projection of the running Didi service settings. Pure mapping and markup only.
// Every rendered field is whitelisted and escaped by name; no provider, config or route payload is
// ever interpolated wholesale, so a secret-looking field cannot reach the page.
import { nextStep, reasonCodes } from './next-steps.ts';
import { escapeHtml } from './markdown.ts';
import { connectionIdentity } from './connector-status.ts';
import type { Theme } from './theme.ts';
import type { LiveSummary } from './api.ts';

/** Where each setting lives on disk, by file name under the operator config dir. Never file contents. */
const FILE_ROWS: [string, string][] = [
  ['Live model, voice and limits', 'live.json'],
  ['Text chat model and persona', 'profile.json'],
  ['Text model credential reference', 'gemini-primary.json'],
  ['OpenAI Live credential reference', 'openai-primary.json'],
  ['Connectors', 'provider-config/mcp.json'],
];

/** The selectable voice providers, in switch order, with the first voice of each list as its default. */
export const LIVE_PROVIDERS: readonly { provider: string; label: string; voices: readonly string[] }[] = [
  // OV1-R6: the gpt-live-1 English voice table, in its own order, marin first as the default. Cedar is a
  // Realtime voice and is deliberately absent; nira is never listed.
  { provider: 'openai', label: 'OpenAI GPT-Live', voices: [
    'marin', 'vesper', 'ripple', 'willow', 'gleam', 'meridian', 'stone', 'quartz', 'beacon', 'delta', 'cinder',
  ] },
  { provider: 'gemini', label: 'Gemini 3.8 Live', voices: ['Aoede'] },
];
/**
 * The accent selections the host composes with, in order, with the value an absent setting means. The
 * labels are the owner's words for the three choices; the server validates the values.
 */
export const LIVE_ACCENTS: readonly { value: string; label: string }[] = [
  { value: 'indian-strong', label: 'Indian English, strong' },
  { value: 'indian-light', label: 'Indian English, light' },
  { value: 'voice-default', label: 'The voice’s own' },
];
function accentLabel(value: string | undefined): string | undefined {
  return LIVE_ACCENTS.find(choice => choice.value === value)?.label;
}
function providerLabel(value: string | undefined): string | undefined {
  return LIVE_PROVIDERS.find(choice => choice.provider === value)?.label;
}
function voicesOf(value: string | undefined): readonly string[] {
  return LIVE_PROVIDERS.find(choice => choice.provider === value)?.voices ?? LIVE_PROVIDERS[0]!.voices;
}
/** The voices the switch offers for a provider, so the page and the server refuse the same pairs. */
export function providerVoices(provider: string | undefined): readonly string[] { return voicesOf(provider); }
/** A provider's default voice: the first of its own list, never another provider's. */
export function providerDefaultVoice(provider: string | undefined): string { return voicesOf(provider)[0]!; }

export interface SettingsInput {
  /** Envelope data from GET /api/v1/status. */
  status?: unknown;
  statusUnavailable?: boolean;
  /** Envelope data from GET /api/v1/live/connections. */
  connections?: unknown;
  connectionsUnavailable?: boolean;
  /** Envelope data from GET /api/v1/live/summary, when the browser could read it. */
  summary?: LiveSummary;
  summaryUnavailable?: boolean;
  /** #352: the Mac's Mic Mode names from the bridge; absent in a plain browser. */
  micMode?: MicModeState;
  /** The owner's saved Live choice, when this session saved one: it applies at the next start. */
  saved?: { provider: string; voice: string; accent?: string; appliesAt?: string };
  /** Connected-conversation settings owned by the chat surface: the stay-connected switch and saved conversations. */
  connected?: {
    conversations: { title: string; sessionId: string; model?: string; state?: string; active?: boolean }[];
    remember: boolean;
    busy?: boolean;
    standingRevoke?: boolean;
    conversationState?: string;
  };
  /** The appearance the owner has chosen, so the control shows the active option. */
  theme?: Theme;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}
function unavailable(label = 'Unavailable'): string { return `<span class="settings-unavailable">${label}</span>`; }

/** Render a millisecond limit in whole minutes; undefined for anything that is not a safe non-negative integer. */
export function limitMinutes(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return `${Math.round(value / 60000)} min`;
}

/** Whitelist one connection row: id, state and reasonCode, mapped to a fixed state name and next step. */
export function connectorState(value: unknown): { id: string; state: string; next: string; identity?: string; guideUrl?: string } | undefined {
  const row = record(value);
  if (!row) return undefined;
  const id = typeof row.id === 'string' && /^[\w.-]{1,128}$/.test(row.id) ? row.id : undefined;
  if (!id) return undefined;
  const state = text(row.state) ?? 'unknown';
  const identity = connectionIdentity(row.identity);
  const withIdentity = <T extends { id: string; state: string; next: string }>(rowValue: T): T & { identity?: string } => (identity ? { ...rowValue, identity } : rowValue);
  if (state === 'connected') return withIdentity({ id, state: 'Connected', next: nextStep(id, state).text });
  if (state === 'configured') return withIdentity({ id, state: 'Configured', next: nextStep(id, state).text });
  const reason = typeof row.reasonCode === 'string' && reasonCodes.some(reason => reason === row.reasonCode) ? row.reasonCode : 'unknown';
  const label = state === 'missing' || reason === 'credential_missing' ? 'Credential missing' : 'Failed';
  const step = nextStep(id, state, reason);
  return { id, state: label, next: step.text, ...(step.guideUrl ? { guideUrl: step.guideUrl } : {}) };
}

function liveRows(summary: unknown, summaryUnavailable: boolean, saved?: SettingsInput['saved']): string {
  const row = summaryUnavailable ? undefined : record(summary);
  const unavailableRows = `<dt>Live model</dt><dd>${unavailable()}</dd>
<dt>Live voice</dt><dd>${unavailable()}</dd>
<dt>Session limit</dt><dd>${unavailable()}</dd>
<dt>Idle limit</dt><dd>${unavailable()}</dd>`;
  if (!row) return `<dt>Live provider</dt><dd>${unavailable()}</dd>${unavailableRows}`;
  if (row.profileEnabled !== true) return `<dt>Live profile</dt><dd>${unavailable('Live profile disabled')}</dd>`;
  const model = text(row.modelId, 120);
  const voice = text(row.voice, 60);
  const accent = text(row.accent, 40);
  const limits = record(row.limits);
  const session = limitMinutes(limits?.sessionMs);
  const idle = limitMinutes(limits?.idleMs);
  const provider = text(row.provider, 40);
  // The delegation backend exists only on the OpenAI adapter, so the row appears only there.
  const delegation = provider === 'openai' ? text(row.delegationModel, 120) : undefined;
  const delegationRow = provider === 'openai'
    ? `<dt>Voice delegation model</dt><dd>${delegation ? escapeHtml(delegation) : unavailable()}</dd>` : '';
  // The saved choice is the one the next start will use; naming it makes a pending change visible.
  const savedProvider = text(saved?.provider, 40);
  const savedVoice = text(saved?.voice, 64);
  const savedAccent = text(saved?.accent, 40);
  const accentPending = savedAccent !== undefined && savedAccent !== accent;
  const pendingNote = savedProvider !== undefined && savedVoice !== undefined && (savedProvider !== provider || savedVoice !== voice || accentPending)
    ? `<p class="muted" role="status">Saved: ${escapeHtml(savedProvider)}/${escapeHtml(savedVoice)}${accentPending ? `, accent ${escapeHtml(accentLabel(savedAccent) ?? savedAccent)}` : ''}, applies on next start</p>` : '';
  return `<dt>Live provider</dt><dd>${provider ? escapeHtml(providerLabel(provider) ?? provider) : unavailable()}</dd>
<dt>Live model</dt><dd>${model ? escapeHtml(model) : unavailable()}</dd>
<dt>Live voice</dt><dd>${voice ? escapeHtml(voice) : unavailable()}</dd>
<dt>Accent for the next call</dt><dd>${accent ? escapeHtml(accentLabel(accent) ?? accent) : unavailable()}</dd>${delegationRow}
<dt>Session limit</dt><dd>${session ?? unavailable()}</dd>
<dt>Idle limit</dt><dd>${idle ?? unavailable()}</dd>${pendingNote}`;
}

/** The persona display name the Live summary carries, only while the Live profile is enabled. */
function summaryPersona(input: SettingsInput): string | undefined {
  if (input.summaryUnavailable === true) return undefined;
  const row = record(input.summary);
  return row?.profileEnabled === true ? text(row.personaName, 120) : undefined;
}

function serviceRows(status: unknown, statusUnavailable: boolean, summaryName?: string): string {
  const persona = summaryName ?? (statusUnavailable ? undefined : text(record(record(status)?.ownerProfile)?.displayName, 120));
  const personaCell = persona ? escapeHtml(persona) : unavailable(statusUnavailable ? 'Unavailable' : 'Not reported');
  if (statusUnavailable) return `<dt>Persona name</dt><dd>${personaCell}</dd><dt>Text chat and research model</dt><dd>${unavailable()}</dd>`;
  const row = record(status);
  const model = record(row?.model);
  const modelLabel = model?.configured === true ? [text(model.provider, 60), text(model.model, 120)].filter(Boolean).join(' ') || 'Configured' : 'Not configured';
  return `<dt>Persona name</dt><dd>${personaCell}</dd>
<dt>Text chat and research model</dt><dd>${escapeHtml(modelLabel)}</dd>`;
}

function connectorsSection(connections: unknown, connectionsUnavailable: boolean): string {
  if (connectionsUnavailable) return `<h3>Connectors</h3><p role="status" class="settings-unavailable">Connections unavailable. No connector values are shown while the service cannot be reached.</p>`;
  const rows = (Array.isArray(connections) ? connections : []).map(connectorState).filter((row): row is NonNullable<ReturnType<typeof connectorState>> => row !== undefined);
  if (rows.length === 0) return '<h3>Connectors</h3><p class="muted">No connectors configured.</p>';
  return `<h3>Connectors</h3><ul class="settings-connectors">${rows.map(row => `<li><strong>${escapeHtml(row.id)}</strong>: ${escapeHtml(row.state)}.${row.identity ? ` ${escapeHtml(row.identity)}.` : ''} ${escapeHtml(row.next)}${row.guideUrl ? ` <a href="${escapeHtml(row.guideUrl)}" target="_blank" rel="noopener noreferrer">Setup guide</a>` : ''}</li>`).join('')}</ul>`;
}

function connectedSection(connected: SettingsInput['connected']): string {
  if (!connected) return '';
  const options = connected.conversations.map(item => `<option value="${escapeHtml(item.sessionId)}" ${item.active ? 'selected' : ''}>${escapeHtml(item.title)}${item.model ? ` · ${escapeHtml(item.model)}` : ''}${item.state ? ` · ${escapeHtml(item.state)}` : ''}</option>`).join('');
  return `<section class="settings-section"><h3>Naya’s text conversations</h3>
<label class="connected-consent" for="connected-remember"><input type="checkbox" id="connected-remember" ${connected.remember ? 'checked' : ''} ${connected.busy ? 'disabled' : ''}> Keep Naya’s text conversations across sessions</label>
${connected.conversations.length ? `<label for="connected-history">Connected history</label><select id="connected-history" ${connected.busy ? 'disabled' : ''}>${options}</select>` : '<p class="muted">No past connected conversations yet.</p>'}
<div class="button-row"><button type="button" id="connected-recover" class="secondary">Recover saved history</button>${connected.standingRevoke ? '<button type="button" id="connected-standing-revoke" class="secondary">Revoke standing consent</button>' : ''}${connected.conversationState ? `<button type="button" id="connected-revoke" class="secondary" ${connected.conversationState === 'revoked' || connected.busy ? 'disabled' : ''}>Revoke conversation consent</button>` : ''}</div></section>`;
}

/**

/**

 * The one writable setting: which voice provider and voice the next Live session uses. The choice is stored in
 * live.json, so it applies at the next start of the service and never interrupts a call in flight.
 */
function liveSwitch(summary: unknown, summaryUnavailable: boolean, saved?: SettingsInput['saved']): string {
  const row = summaryUnavailable ? undefined : record(summary);
  // A failed read never falls back to a default that would look like the saved choice.
  if (!row) return `<p role="status" class="settings-unavailable">Live provider unavailable. No provider or voice is shown while the running service cannot be read.</p>`;
  // The switch shows the saved choice when there is one, because that is what the next start will use;
  // the running values above it say what a call in flight actually ran with.
  const current = text(saved?.provider, 40) ?? text(row?.provider, 40) ?? LIVE_PROVIDERS[0]!.provider;
  const voice = text(saved?.voice, 64) ?? text(row?.voice, 64) ?? voicesOf(current)[0]!;
  // The accent applies from the next session start, so the running summary already names what will run.
  const accent = text(saved?.accent, 40) ?? text(row?.accent, 40) ?? LIVE_ACCENTS[0]!.value;
  const accentOptions = LIVE_ACCENTS.map(choice =>
    `<option value="${escapeHtml(choice.value)}"${choice.value === accent ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`).join('');
  const options = LIVE_PROVIDERS.map(choice =>
    `<option value="${escapeHtml(choice.provider)}"${choice.provider === current ? ' selected' : ''}>${escapeHtml(choice.label)}</option>`).join('');
  const voices = [...new Set([...voicesOf(current), voice])].map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  return `<form id="live-settings-form" class="live-settings">
<label for="live-provider">Provider</label>
<select id="live-provider" name="provider">${options}</select>
<label for="live-voice">Voice</label>
<input id="live-voice" name="voice" value="${escapeHtml(voice)}" list="live-voices" autocomplete="off">
<datalist id="live-voices">${voices}</datalist>
<label for="live-accent">Accent</label>
<select id="live-accent" name="accent">${accentOptions}</select>
<p class="muted">Saved to <code>live.json</code>. It applies when Lux Didi next starts; the accent applies from the next call. A call in progress is never switched.</p>
<div class="button-row"><button type="submit">Save provider</button></div></form>`;
}

/**
 * MINI2: the single key. The app owns the state, because only the app can watch a
 * key, and pushes it to the page as `window.didiSingleKey`; a browser preview or
 * a test has no push and reads the default (on, and inactive until a grant).
 * Right Option is never part of this: it belongs to SuperWhisper.
 */
export interface SingleKeyState { enabled: boolean; granted: boolean }

export function singleKeyState(source: unknown = (globalThis as { didiSingleKey?: unknown }).didiSingleKey): SingleKeyState {
  const row = record(source);
  return { enabled: row?.enabled !== false, granted: row?.granted === true };
}

export function singleKeyRow(state: SingleKeyState): string {
  const why = !state.enabled
    ? 'Off. Turn it back on in the Naya menu bar menu.'
    : state.granted
      ? 'Active: a tap starts and stops Naya exactly like Control Option Space.'
      : 'Inactive: macOS has not granted Accessibility (or Input Monitoring) for this key. '
        + 'Control Option Space still works, and the Naya menu bar menu asks for the grant again.';
  return `<p><strong>Right Command tap</strong> ${escapeHtml(state.enabled ? 'on' : 'off')}. ${escapeHtml(why)}</p>`
    + '<p class="settings-restart">Right Option belongs to SuperWhisper and is never used.</p>';

}

/**
 * Council 2026-10-17, option C: Naya is always there in the orb, and "Always show
 * Naya" is the only switch over it. The app owns the state and pushes it as
 * `window.didiPresence`; a preview or a test reads the default (on).
 */
export interface PresenceState { alwaysShow: boolean; listening: boolean }

export function presenceState(source: unknown = (globalThis as { didiPresence?: unknown }).didiPresence): PresenceState {
  const row = record(source);
  return { alwaysShow: row?.alwaysShow !== false, listening: row?.state === 'live' };
}

export function presenceRow(state: PresenceState): string {
  const why = !state.alwaysShow
    ? 'Off. Turn it back on in the Naya menu bar menu.'
    : state.listening
      ? 'On, and Naya is listening now: a Right Command tap mutes her.'
      : 'On. Naya is there in the orb, quiet until a Right Command tap.';
  return `<p><strong>Always show Naya</strong> ${escapeHtml(state.alwaysShow ? 'on' : 'off')}. ${escapeHtml(why)}</p>`;

}

/**
 * #352 (release 3o): the Mac's Mic Mode, as the native app reads it. An app cannot set it, so this is a
 * read-only row and a button that opens the system picker; nothing here selects a mode.
 */
export interface MicModeState { preferred: string; active: string }

const MIC_MODE_LABELS: Record<string, string> = {
  standard: 'Standard',
  wideSpectrum: 'Wide Spectrum',
  voiceIsolation: 'Voice Isolation',
  unknown: 'Unknown',
};

export function micModeLabel(mode: string | undefined): string { return MIC_MODE_LABELS[mode ?? ''] ?? 'Unknown'; }

/** The one line's sentence, and the only message either control sends. */
export const MIC_MODE_SENTENCE = 'Voice Isolation keeps other voices out. Turn it on';

export interface MicModeMessage { type: 'showMicrophoneModes' }

export function micModePromptMessage(): MicModeMessage { return { type: 'showMicrophoneModes' }; }

/** The button's one action, kept where a test calls it without a window: it asks the native picker. */
export function micModePicker(send: ((message: MicModeMessage) => void) | undefined): void { send?.(micModePromptMessage()); }

/**
 * The full app's one quiet line. The native app decides whether it may show at a LIVE start (once per app
 * version), so this paints what it is told and never opens the picker by itself.
 */
export function micModePromptMarkup(prompt: boolean): string {
  if (!prompt) return '';
  return `<div class="mic-mode-prompt" role="status"><span>${escapeHtml(MIC_MODE_SENTENCE)}</span>`
    + `<button type="button" id="mic-mode-turn-on" data-mic-mode="picker">Turn it on</button>`
    + '<button type="button" id="mic-mode-dismiss" class="quiet" aria-label="Dismiss this line">Dismiss</button></div>';
}

/**
 * The Mic Mode a native message carries: `micMode` at a change or a LIVE start, and inside `hydrate` on a
 * reload (a reload never shows the line). Undefined for every other message, so a caller can pass them all.
 */
export function micModeState(message: unknown): { preferred: string; active: string; prompt: boolean } | undefined {
  const envelope = message as { type?: unknown; micMode?: { preferred?: unknown; active?: unknown; prompt?: unknown } } | undefined;
  if (!envelope || typeof envelope !== 'object') return undefined;
  if (envelope.type !== 'micMode' && envelope.type !== 'hydrate') return undefined;
  const mode = envelope.micMode;
  if (!mode || typeof mode !== 'object') return undefined;
  const preferred = typeof mode.preferred === 'string' ? mode.preferred : 'unknown';
  const active = typeof mode.active === 'string' ? mode.active : 'unknown';
  return { preferred, active, prompt: mode.prompt === true && active !== 'voiceIsolation' };
}

/** The read-only settings row: the active mode, and the same button as the line. */
export function micModeRow(state: MicModeState | undefined): string {
  return `<dt>Mic Mode</dt><dd>${escapeHtml(micModeLabel(state?.active))}. `
    + '<button type="button" id="mic-mode-open" class="quiet" data-mic-mode="picker">Open the Mic Mode picker</button></dd>';
}

export function settingsMarkup(input: SettingsInput): string {
  return `<section id="settings-summary" class="panel didi-settings" aria-label="Didi settings">
<h2>Didi settings</h2>
<p class="muted">Summary of what this Didi is running with. Only the Live voice provider below can be changed here; everything else is read-only.</p>
<dl class="settings-facts">${liveRows(input.summary, input.summaryUnavailable === true, input.saved)}${serviceRows(input.status, input.statusUnavailable === true, summaryPersona(input))}
<dt>Service mode</dt><dd>${input.statusUnavailable === true ? unavailable() : escapeHtml(text(record(input.status)?.serviceMode, 40) ?? 'loopback')}</dd>${micModeRow(input.micMode)}</dl>
<section class="settings-section">${connectorsSection(input.connections, input.connectionsUnavailable === true)}</section>
${connectedSection(input.connected)}
<section class="settings-section"><h3>Live voice provider</h3>${liveSwitch(input.summary, input.summaryUnavailable === true, input.saved)}</section>
<section class="settings-section"><h3>Appearance</h3>
<label for="appearance-theme">Appearance</label>
<select id="appearance-theme" name="appearance-theme"><option value="dark"${input.theme === 'light' ? '' : ' selected'}>Dark</option><option value="light"${input.theme === 'light' ? ' selected' : ''}>Light</option></select>
<p class="muted">Dark is the default. Your choice is saved on this device.</p></section>
<section class="settings-section"><h3>Single key</h3>${singleKeyRow(singleKeyState())}</section>
<section class="settings-section"><h3>Presence</h3>${presenceRow(presenceState())}</section>
<section class="settings-section"><h3>Where these settings live</h3>
<dl class="settings-files">${FILE_ROWS.map(([what, file]) => `<dt>${escapeHtml(what)}</dt><dd><code>${escapeHtml(file)}</code></dd>`).join('')}</dl>
<p class="settings-restart">Changes to these files need a restart of Lux Didi. Only the Live voice provider can be changed here.</p></section>
</section>`;
}
