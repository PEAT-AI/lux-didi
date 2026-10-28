// Read-only browser projection. Never interpolate provider error/config payloads.
import { escapeHtml } from './markdown.ts';
/**
 * W2-R1: the one command that approves a refused connector's tool list, verbatim from the CLI's own usage
 * line (server/config/mcp-cli.ts). There is no Settings control for it, so the row states the command.
 */
export const APPROVE_COMMAND = 'node server/dist/config/mcp-cli.js approve --config-dir <config dir> --data-dir <data dir> --owner-id <owner> --policy-input <policy file>';
/** The added reads a refusal names, as closed tool names only. */
const addedReads = (row: Record<string, unknown>): string[] => Array.isArray(row['addedToolNames'])
  ? row['addedToolNames'].filter((name): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
  : [];
const approvalHint = (added: readonly string[]): string => `approve the added read tools with ${APPROVE_COMMAND}, then restart${added.length ? ` (added: ${added.join(', ')})` : ''}`;
const REASONS: Record<string, [string, string]> = {
  // W2-R1: no Settings control approves a connector, so a refusal states the command and the added names.
  configuration_error: ['Approval needed', 'approve the added read tools with the approve command, then restart'],
  credential_missing: ['Credential missing', 'add the credential file under provider-config and restart'],
  not_signed_in: ['Signed out', 'sign in again with this connector\'s own credentials, then restart'],
  needs_sign_in: ['Sign-in needed', 'sign in with the button in Settings, then it reconnects on its own'],
  unreachable: ['Service unreachable', 'start the service, then restart Lux Didi'],
  discovery_failed: ['Tool discovery failed', 'check the service tool configuration, then restart Lux Didi'],
  handshake_failed: ['Handshake failed', 'check the service is ready, then restart Lux Didi'],
  unknown: ['Connection issue unknown', 'check the local service configuration, then restart Lux Didi'],
  identity_mismatch: ['Signed in as a different account', 'each connector must sign in as the owner account'],
  // W14 (LOGS.md L-02): Drive's read consent is its own gate, and it is shown before the first read.
  scope_missing: ['Needs consent', 'run lux-google-mcp authorize --family drive with the configured token and account, a one-time step, then restart Lux Didi'],
};

/** W14: a consent probe's own code, so its row never reads as an unverified account. */
const CONSENT_NEEDED = 'scope_missing';

/** The one identity sentence per connection: the owner's account, a mismatch, or unverified. */
export function connectionIdentity(identity: unknown): string | undefined {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
  const row = identity as Record<string, unknown>;
  if (typeof row.proven !== 'boolean') return undefined;
  const match = row.match;
  if (match !== null && typeof match !== 'boolean') return undefined;
  // W14 (LOGS.md L-02): Drive reports no own account, so a refused consent probe is the owner's own
  // one-time step, never "Account not verified" for an account that is perfectly fine.
  if (!row.proven && row['code'] === CONSENT_NEEDED) return 'Needs consent';
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
    // W14 (LOGS.md L-02): the identity proof's own closed code is the more specific reason, so a
    // refused consent probe says "Needs consent" even when the row's reason code only knows the
    // generic identity refusal.
    const proofCode = typeof (row.identity as Record<string, unknown> | undefined)?.['code'] === 'string'
      ? String((row.identity as Record<string, unknown>)['code']) : undefined;
    const reasonKey = proofCode !== undefined && Object.hasOwn(REASONS, proofCode) ? proofCode : typeof row.reasonCode === 'string' && Object.hasOwn(REASONS, row.reasonCode) ? row.reasonCode : 'unknown';
    const reason: [string, string] = reasonKey === 'configuration_error' ? ['Approval needed', approvalHint(addedReads(row))] : REASONS[reasonKey] ?? REASONS.unknown!;
    const issue = row.reasonCode !== null || state === 'missing' || state === 'error' || proofCode !== undefined;
    const identity = connectionIdentity(row.identity);
    const identityHtml = identity ? ` <span class="connection-identity">${escapeHtml(identity)}</span>` : '';
    return `<li><strong>${escapeHtml(id)}</strong>: ${state}, ${tools} tools <small>Last handshake: ${escapeHtml(time)}</small>${identityHtml}${issue ? `<p>${reason[0]}. ${reason[1]}</p>` : ''}</li>`;
  }).join('');
  return `<section id="connections-panel" class="panel connections-card" aria-label="Connections"><h2>Connections</h2>${stale ? '<p role="status" class="live-stale">Connections status unavailable; displayed values may be stale.</p>' : ''}<ul>${rows || '<li class="muted">No connections configured.</li>'}</ul></section>`;
}
