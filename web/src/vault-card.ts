import type { LiveCurrent, LiveEntry } from './protocol.ts';
import { escapeHtml } from './markdown.ts';

export interface VaultCard { state: 'saved' | 'refused' | 'failed' | 'unknown'; insightId?: string }

interface VaultReceiptView { saved?: unknown; code?: unknown; insightId?: unknown }

const CODE_STATES: Readonly<Record<string, VaultCard['state']>> = {
  not_owner_requested: 'refused',
  write_failed: 'failed',
  vault_unavailable: 'failed',
  outcome_unknown: 'unknown',
};

const LABELS: Readonly<Record<VaultCard['state'], string>> = {
  saved: 'Saved to your vault',
  refused: 'Not saved: say the save phrase first',
  failed: 'Not saved: the vault did not take it',
  unknown: 'Not sure it landed: check the vault',
};

function receiptOf(entry: LiveEntry | undefined): VaultReceiptView | undefined {
  const tool = entry?.tool;
  if (!tool || tool.name !== 'save_to_vault' || tool.status !== 'completed' || typeof tool.markdown !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(tool.markdown);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as VaultReceiptView : undefined;
  } catch { return undefined; }
}

/** The latest vault write receipt in the live projection, or nothing when nothing was written. */
export function vaultCardState(live: LiveCurrent | undefined): VaultCard | undefined {
  const entry = [...(live?.entries ?? [])].reverse().find(candidate => candidate.tool?.name === 'save_to_vault');
  const receipt = receiptOf(entry);
  if (!receipt) return undefined;
  if (receipt.saved === true && typeof receipt.insightId === 'string') return { state: 'saved', insightId: receipt.insightId };
  if (receipt.saved !== false) return undefined;
  const state = typeof receipt.code === 'string' ? CODE_STATES[receipt.code] : undefined;
  return state ? { state } : undefined;
}

/** The small vault card: the status, and the vault's own insight id when the save landed. */
export function vaultCardMarkup(card: VaultCard | undefined): string {
  if (!card) return '';
  const id = card.insightId === undefined ? '' : `<span class="vault-card-id">${escapeHtml(card.insightId)}</span>`;
  return `<div class="vault-card" data-vault="${card.state}">${escapeHtml(LABELS[card.state])}${id}</div>`;
}
