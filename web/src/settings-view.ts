// Read-only projection of the running Didi service settings. Pure mapping and markup only.
// Every rendered field is whitelisted and escaped by name; no provider, config or route payload is
// ever interpolated wholesale, so a secret-looking field cannot reach the page.
import { escapeHtml } from './markdown.ts';
import type { LiveSummary } from './api.ts';

/** Where each setting lives on disk, by file name under the operator config dir. Never file contents. */
const FILE_ROWS: [string, string][] = [
  ['Live model, voice and limits', 'live.json'],
  ['Conversation model and persona', 'profile.json'],
  ['Model credential reference', 'gemini-primary.json'],
  ['Connectors', 'provider-config/mcp.json'],
];

/** One-line next step per connector reason code. Fixed text, never a provider payload. */
const NEXT_STEP: Record<string, [string, string]> = {
  credential_missing: ['Credential missing', 'add the credential file under provider-config, then restart Lux Didi'],
  unreachable: ['Failed', 'start the service, then restart Lux Didi'],
  discovery_failed: ['Failed', 'check the service tool configuration, then restart Lux Didi'],
  handshake_failed: ['Failed', 'check the service is ready, then restart Lux Didi'],
  unknown: ['Failed', 'check the local service configuration, then restart Lux Didi'],
};

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
export function connectorState(value: unknown): { id: string; state: string; next: string } | undefined {
  const row = record(value);
  if (!row) return undefined;
  const id = typeof row.id === 'string' && /^[\w.-]{1,128}$/.test(row.id) ? row.id : undefined;
  if (!id) return undefined;
  const state = text(row.state);
  if (state === 'connected') return { id, state: 'Connected', next: 'no action needed' };
  if (state === 'configured') return { id, state: 'Configured', next: 'a Live session connects on demand' };
  const reason = typeof row.reasonCode === 'string' && Object.hasOwn(NEXT_STEP, row.reasonCode) ? row.reasonCode : 'unknown';
  const [label, next] = state === 'missing' ? NEXT_STEP.credential_missing! : NEXT_STEP[reason]!;
  return { id, state: label, next };
}

function liveRows(summary: unknown, summaryUnavailable: boolean): string {
  const row = summaryUnavailable ? undefined : record(summary);
  const unavailableRows = `<dt>Live model</dt><dd>${unavailable()}</dd>
<dt>Live voice</dt><dd>${unavailable()}</dd>
<dt>Session limit</dt><dd>${unavailable()}</dd>
<dt>Idle limit</dt><dd>${unavailable()}</dd>`;
  if (!row) return unavailableRows;
  if (row.profileEnabled !== true) return `<dt>Live profile</dt><dd>${unavailable('Live profile disabled')}</dd>`;
  const model = text(row.modelId, 120);
  const voice = text(row.voice, 60);
  const limits = record(row.limits);
  const session = limitMinutes(limits?.sessionMs);
  const idle = limitMinutes(limits?.idleMs);
  return `<dt>Live model</dt><dd>${model ? escapeHtml(model) : unavailable()}</dd>
<dt>Live voice</dt><dd>${voice ? escapeHtml(voice) : unavailable()}</dd>
<dt>Session limit</dt><dd>${session ?? unavailable()}</dd>
<dt>Idle limit</dt><dd>${idle ?? unavailable()}</dd>`;
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
  if (statusUnavailable) return `<dt>Persona name</dt><dd>${personaCell}</dd><dt>Conversation model</dt><dd>${unavailable()}</dd>`;
  const row = record(status);
  const model = record(row?.model);
  const modelLabel = model?.configured === true ? [text(model.provider, 60), text(model.model, 120)].filter(Boolean).join(' ') || 'Configured' : 'Not configured';
  return `<dt>Persona name</dt><dd>${personaCell}</dd>
<dt>Conversation model</dt><dd>${escapeHtml(modelLabel)}</dd>`;
}

function connectorsSection(connections: unknown, connectionsUnavailable: boolean): string {
  if (connectionsUnavailable) return `<h3>Connectors</h3><p role="status" class="settings-unavailable">Connections unavailable. No connector values are shown while the service cannot be reached.</p>`;
  const rows = (Array.isArray(connections) ? connections : []).map(connectorState).filter((row): row is NonNullable<ReturnType<typeof connectorState>> => row !== undefined);
  if (rows.length === 0) return '<h3>Connectors</h3><p class="muted">No connectors configured.</p>';
  return `<h3>Connectors</h3><ul class="settings-connectors">${rows.map(row => `<li><strong>${escapeHtml(row.id)}</strong>: ${escapeHtml(row.state)}. ${escapeHtml(row.next)}.</li>`).join('')}</ul>`;
}

export function settingsMarkup(input: SettingsInput): string {
  return `<section id="settings-summary" class="panel didi-settings" aria-label="Didi settings">
<h2>Didi settings</h2>
<p class="muted">Read-only summary of what this Didi is running with. Values come from the running service; this page cannot change them.</p>
<dl class="settings-facts">${liveRows(input.summary, input.summaryUnavailable === true)}${serviceRows(input.status, input.statusUnavailable === true, summaryPersona(input))}
<dt>Service mode</dt><dd>${input.statusUnavailable === true ? unavailable() : escapeHtml(text(record(input.status)?.serviceMode, 40) ?? 'loopback')}</dd></dl>
<section class="settings-section">${connectorsSection(input.connections, input.connectionsUnavailable === true)}</section>
<section class="settings-section"><h3>Where these settings live</h3>
<dl class="settings-files">${FILE_ROWS.map(([what, file]) => `<dt>${escapeHtml(what)}</dt><dd><code>${escapeHtml(file)}</code></dd>`).join('')}</dl>
<p class="settings-restart">Changes to these files need a restart of Lux Didi. This page is read-only.</p></section>
</section>`;
}
