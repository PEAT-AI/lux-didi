// Read-only browser projection. Never interpolate provider error/config payloads.
import { escapeHtml } from './markdown.ts';
const REASONS: Record<string, [string, string]> = {
  configuration_error: ['Approval needed', 'approve the new tool list as the MCP configuration guide describes, then restart'],
  credential_missing: ['Credential missing', 'add the credential file under provider-config and restart'],
  not_signed_in: ['Signed out', 'sign in again with this connector\'s own credentials, then restart'],
  needs_sign_in: ['Sign-in needed', 'sign in with the button in Settings, then it reconnects on its own'],
  unreachable: ['Service unreachable', 'start the service, then restart Lux Didi'],
  discovery_failed: ['Tool discovery failed', 'check the service tool configuration, then restart Lux Didi'],
  handshake_failed: ['Handshake failed', 'check the service is ready, then restart Lux Didi'],
  unknown: ['Connection issue unknown', 'check the local service configuration, then restart Lux Didi'],
  identity_mismatch: ['Signed in as a different account', 'each connector must sign in as the owner account'],
};

/** The one identity sentence per connection: the owner's account, a mismatch, or unverified. */
export function connectionIdentity(identity: unknown): string | undefined {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
  const row = identity as Record<string, unknown>;
  if (typeof row.proven !== 'boolean') return undefined;
  const match = row.match;
  if (match !== null && typeof match !== 'boolean') return undefined;
  if (!row.proven) return 'Account not verified';
  if (match === false) return 'Signed in as a different account';
  const value = typeof row.value === 'string' && /^[\w.@+-]{1,254}$/.test(row.value) ? row.value : undefined;
  if (!value) return undefined;
  return match === true ? `Connected as ${value} \u2713` : `Connected as ${value}`;
}
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
    const identity = connectionIdentity(row.identity);
    const identityHtml = identity ? ` <span class="connection-identity">${escapeHtml(identity)}</span>` : '';
    return `<li><strong>${escapeHtml(id)}</strong>: ${state}, ${tools} tools <small>Last handshake: ${escapeHtml(time)}</small>${identityHtml}${issue ? `<p>${reason[0]}. ${reason[1]}</p>` : ''}</li>`;
  }).join('');
  return `<section id="connections-panel" class="panel connections-card" aria-label="Connections"><h2>Connections</h2>${stale ? '<p role="status" class="live-stale">Connections status unavailable; displayed values may be stale.</p>' : ''}<ul>${rows || '<li class="muted">No connections configured.</li>'}</ul></section>`;
}
