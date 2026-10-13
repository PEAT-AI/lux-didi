// Read-only browser projection. Never interpolate provider error/config payloads.
import { escapeHtml } from './markdown.ts';
const REASONS: Record<string, [string, string]> = {
  credential_missing: ['Credential missing', 'add the credential file under provider-config and restart'],
  unreachable: ['Service unreachable', 'start the service, then restart Lux Didi'],
  discovery_failed: ['Tool discovery failed', 'check the service tool configuration, then restart Lux Didi'],
  handshake_failed: ['Handshake failed', 'check the service is ready, then restart Lux Didi'],
  unknown: ['Connection issue unknown', 'check the local service configuration, then restart Lux Didi'],
};
export function connectionsMarkup(endpoints: unknown, stale = false): string {
  const rows = (Array.isArray(endpoints) ? endpoints : []).map(value => {
    if (!value || typeof value !== 'object') return '';
    const row = value as Record<string, unknown>;
    const id = typeof row.id === 'string' && /^[\w.-]{1,128}$/.test(row.id) ? row.id : 'Unknown connection';
    const state = ['missing', 'configured', 'connected', 'error'].includes(String(row.state)) ? String(row.state) : 'error';
    const tools = typeof row.tools === 'number' && Number.isSafeInteger(row.tools) && row.tools >= 0 ? row.tools : 0;
    const time = typeof row.lastHandshakeAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.lastHandshakeAt) && Number.isFinite(Date.parse(row.lastHandshakeAt)) ? row.lastHandshakeAt : 'Never';
    const reason = typeof row.reasonCode === 'string' && Object.hasOwn(REASONS, row.reasonCode) ? REASONS[row.reasonCode] : REASONS.unknown;
    const issue = row.reasonCode !== null || state === 'missing' || state === 'error';
    return `<li><strong>${escapeHtml(id)}</strong>: ${state}, ${tools} tools <small>Last handshake: ${escapeHtml(time)}</small>${issue ? `<p>${reason[0]}. ${reason[1]}</p>` : ''}</li>`;
  }).join('');
  return `<section id="connections-panel" class="panel connections-card" aria-label="Connections"><h2>Connections</h2>${stale ? '<p role="status" class="live-stale">Connections status unavailable; displayed values may be stale.</p>' : ''}<ul>${rows || '<li class="muted">No connections configured.</li>'}</ul></section>`;
}
