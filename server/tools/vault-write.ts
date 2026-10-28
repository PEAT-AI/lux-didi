import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../adapters/model/types.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';

/** This identity belongs to the gateway, never to a remote MCP declaration. */
export const VAULT_WRITE_IDENTITY = { name: 'save_to_vault', accountId: 'gateway:live-voice', resourceId: 'owner-vault' } as const;
export const VAULT_WRITE_PARAMETERS = { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 2000, description: 'The note exactly as the owner dictated it, without the save phrase.' } }, required: ['content'], additionalProperties: false };
export function validateVaultSave(args: unknown): args is { content: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).length === 1 && typeof value.content === 'string' && value.content.length > 0 && value.content.length <= 2000;
}

/** The one remote tool a vault write may ever call, and the only arguments it is given. */
export const VAULT_REMOTE_TOOL = 'save_insight';
export const VAULT_INSIGHT_TYPE = 'UNCATEGORIZED';
export const VAULT_PROJECT = 'didi-voice';
/** Spoken guidance, never a save claim. */
export const VAULT_SAY_SAVE_PHRASE = 'say: save this to lux, then the note';
export const VAULT_SAY_UNKNOWN = 'I am not sure it landed, check the vault';
export const VAULT_SAY_FAILED = 'I could not confirm that the vault saved the note; do not retry it automatically';
export const VAULT_SAY_UNAVAILABLE = 'the vault is not reachable right now';

export type VaultCode = 'not_owner_requested' | 'write_failed' | 'outcome_unknown' | 'vault_unavailable';
export type VaultState = 'authorized' | 'dispatched' | 'confirmed' | 'failed' | 'uncertain';

export interface VaultReceipt {
  readonly saved: boolean;
  readonly code?: VaultCode;
  readonly insightId?: string;
  readonly guidance?: string;
}

export const VAULT_TRANSPORT_PHASES = ['initialize_http', 'initialize_transport', 'initialized_notify', 'endpoint_rejected', 'call_http', 'call_transport', 'schema_rejected'] as const;
export type VaultTransportPhase = (typeof VAULT_TRANSPORT_PHASES)[number];

export type VaultTransportResult =
  | { readonly outcome: 'inserted'; readonly insightId: string }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'failed' }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'unavailable' };

export interface VaultSaveArgs { readonly content: string; readonly title: string; readonly insightType: string; readonly project: string }

/** One MCP write attempt. The client owns the wire; nothing above it retries. */
export interface VaultTransport { save(args: VaultSaveArgs): Promise<VaultTransportResult> }

export type VaultClaim =
  | { readonly state: 'dispatch'; readonly opId: string; readonly content: string; readonly title: string }
  | { readonly state: 'settled'; readonly receipt: VaultReceipt };

export interface VaultStore { transaction<T>(body: (tx: Transaction) => T extends PromiseLike<unknown> ? never : T): T }

/** The one door the Live tool layer has to the write service: a claimed operation, and its receipt. */
export type VaultDispatchPort = (claim: { opId: string; content: string; title: string }) => Promise<VaultReceipt>;

const GUIDANCE: Readonly<Record<VaultCode, string>> = {
  not_owner_requested: VAULT_SAY_SAVE_PHRASE,
  write_failed: VAULT_SAY_FAILED,
  outcome_unknown: VAULT_SAY_UNKNOWN,
  vault_unavailable: VAULT_SAY_UNAVAILABLE,
};

const refusal = (code: VaultCode): VaultReceipt => ({ saved: false, code, guidance: GUIDANCE[code] });

/**
 * The one host line a save attempt may write: the closed outcome, the closed code, the vault's own
 * id on a confirmed save and the wire latency. The note never appears.
 */
export function vaultAttemptEvent(receipt: VaultReceipt, latencyMs: number): Record<string, unknown> {
  const state = receipt.saved ? 'confirmed' : receipt.code === 'vault_unavailable' ? 'unavailable' : receipt.code === 'outcome_unknown' ? 'uncertain' : 'failed';
  return { event: 'vault_write', state, ...(receipt.code === undefined ? {} : { code: receipt.code }), ...(receipt.insightId === undefined ? {} : { insightId: receipt.insightId }), latencyMs };
}

/** Case, whitespace and punctuation are not content: the proposal and the uttered note compare equal past them. */
export const vaultContentKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** An anchored owner ask: a save verb, his demonstrative or none, then lux, the knowledge base or the vault. */
const SAVE_COMMAND = /^(?:naya\s*,?\s+)?(?:please\s+)?(?:save|remember|put|store|note|write)\s+(?:(?:this|that|it|these|those|them)\s+)?(?:to|in|into)\s+(?:my\s+|the\s+)?(?:lux(?:\s+knowledge)?|knowledge\s+base|knowledge|vault)\b[^\p{L}\p{N}]*([\s\S]*)$/iu;

export type SaveCommand = { readonly content: string; readonly refers: boolean };

/**
 * His words after the ask are the note. A bare ask ("save this to lux") refers to the words he said
 * just before it, and the host resolves those from the journal: the grammar alone is not permission.
 */
export function parseSaveCommand(text: string): SaveCommand | undefined {
  const match = SAVE_COMMAND.exec(text.replace(/\s+/g, ' ').trim());
  if (!match) return undefined;
  const content = String(match[1] ?? '').replace(/\s+/g, ' ').trim();
  if (vaultContentKey(content).length >= 2) return { content, refers: false };
  return content === '' ? { content: '', refers: true } : undefined;
}

/**
 * A composed note authorizes its own ledger row only after the host confirmed the frozen payload: the
 * row is keyed by the stage, so a second settlement of the same stage inserts nothing and dispatches
 * nothing. Everything after this point is the one dictation path: claim, dispatch, settle.
 */
export function authorizeComposedWrite(tx: Transaction, options: { liveSessionId: string; stageId: string; content: string; title: string; now: number; externalContextPresent?: boolean; payloadSha?: string }): VaultClaim {
  tx.run('INSERT OR IGNORE INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomUUID(), options.liveSessionId, options.stageId, VAULT_REMOTE_TOOL, options.content, vaultContentKey(options.content), options.title, 'authorized', options.now]);
  tx.run('UPDATE vault_writes SET external_context_present=?,candidate_digest=? WHERE live_session_id=? AND utterance_id=? AND state=\'authorized\'', [options.externalContextPresent ? 1 : 0, options.payloadSha ?? null, options.liveSessionId, options.stageId]);
  const row = tx.get('SELECT * FROM vault_writes WHERE live_session_id=? AND utterance_id=?', [options.liveSessionId, options.stageId]);
  if (!row) return { state: 'settled', receipt: refusal('outcome_unknown') };
  return claimRow(tx, row);
}

/** The title is the host's, from the note's own first words. The model never writes it. */
export function vaultTitle(content: string): string {
  return content.split(/\s+/).slice(0, 8).join(' ').slice(0, 120).trim();
}

const INSIGHT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const validInsightId = (value: unknown): value is string => typeof value === 'string' && INSIGHT_ID.test(value);

/**
 * W5 (Q-05): the whole words of a request, none of it content. The transcriber split one ask across
 * two turns ("Can you, can you" then "store it in Lux Knowledge"), and the old rule took the first
 * half as the note. A turn built only from these words is a request fragment, never a referent.
 */
const REQUEST_WORDS = new Set(['can', 'could', 'would', 'will', 'you', 'please', 'naya', 'just', 'okay', 'ok', 'right', 'now',
  'so', 'and', 'then', 'uh', 'um', 'er', 'hey', 'hi', 'yes', 'no', 'let', 'us', 'we', 'go', 'ahead',
  'save', 'remember', 'put', 'add', 'write', 'store', 'note', 'keep', 'this', 'that', 'it', 'these', 'those', 'them',
  'to', 'in', 'into', 'my', 'the', 'for', 'me', 'lux', 'knowledge', 'base', 'vault', 'memory', 'didi']);
const requestFragment = (text: string): boolean => {
  const words = vaultContentKey(text).split(' ').filter(word => word.length > 0);
  return words.length === 0 || words.every(word => REQUEST_WORDS.has(word));
};

/** A final owner utterance minted this single-use authorization, or nothing at all. */
export function mintVaultAuthorization(tx: Transaction, options: { liveSessionId: string; utteranceId: string; text: string; priorText?: string; now: number }): string | undefined {
  const parsed = parseSaveCommand(options.text);
  if (!parsed) return undefined;
  const content = parsed.refers ? (options.priorText ?? '').replace(/\s+/g, ' ').trim() : parsed.content;
  // W5: a referential ask whose referent is itself part of the request authorizes nothing. The referent
  // is the answer she gave, which the composed-note path stages and reads back; the host never writes.
  if (parsed.refers && requestFragment(content)) return undefined;
  if (vaultContentKey(content).length < 2) return undefined;
  const opId = randomUUID();
  tx.run('INSERT OR IGNORE INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [opId, options.liveSessionId, options.utteranceId, VAULT_REMOTE_TOOL, content, vaultContentKey(content), vaultTitle(content), 'authorized', options.now]);
  const stored = tx.get('SELECT op_id FROM vault_writes WHERE live_session_id=? AND utterance_id=?', [options.liveSessionId, options.utteranceId]);
  return stored ? String(stored['op_id']) : undefined;
}

function receiptFromRow(row: SQLRow): VaultReceipt {
  const state = String(row['state']) as VaultState;
  const insightId = row['insight_id'] === null || row['insight_id'] === undefined ? undefined : String(row['insight_id']);
  if (state === 'confirmed' && validInsightId(insightId)) return { saved: true, insightId };
  if (state === 'failed') return refusal(row['code'] === 'vault_unavailable' ? 'vault_unavailable' : 'write_failed');
  return refusal('outcome_unknown');
}

/** The proposal is never permission: it must equal the content the owner's own final utterance authorized. */
export function claimVaultWrite(tx: Transaction, options: { liveSessionId: string; content: string }): VaultClaim {
  const row = tx.get('SELECT * FROM vault_writes WHERE live_session_id=? AND content_key=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [options.liveSessionId, vaultContentKey(options.content)]);
  if (!row) return { state: 'settled', receipt: refusal('not_owner_requested') };
  return claimRow(tx, row);
}

/** One ledger row is claimed once, atomically, whichever consent minted it. */
function claimRow(tx: Transaction, row: SQLRow): VaultClaim {
  if (String(row['state']) !== 'authorized') return { state: 'settled', receipt: receiptFromRow(row) };
  const opId = String(row['op_id']);
  const claimed = tx.run("UPDATE vault_writes SET state='dispatched' WHERE op_id=? AND state='authorized'", [opId]);
  if (claimed !== 1) {
    const replay = tx.get('SELECT * FROM vault_writes WHERE op_id=?', [opId]);
    return { state: 'settled', receipt: replay ? receiptFromRow(replay) : refusal('outcome_unknown') };
  }
  return { state: 'dispatch', opId, content: String(row['content']), title: String(row['title']) };
}

export interface VaultWriterOptions {
  readonly store: VaultStore;
  readonly transport: VaultTransport;
  readonly now: () => number;
  readonly log: (event: Record<string, unknown>) => void;
}

/** The voice-only write service: mint, atomic claim, one dispatch, one settlement, no retry anywhere. */
export class VaultWriter {
  readonly #store: VaultStore;
  readonly #transport: VaultTransport;
  readonly #now: () => number;
  readonly #log: (event: Record<string, unknown>) => void;

  constructor(options: VaultWriterOptions) {
    this.#store = options.store; this.#transport = options.transport; this.#now = options.now; this.#log = options.log;
    this.#store.transaction(tx => tx.run("UPDATE vault_writes SET state='uncertain' WHERE state='dispatched'"));
  }

  /** Called inside the journal transaction of a final owner transcription. */
  observe(tx: Transaction, liveSessionId: string, utteranceId: string, text: string, priorText?: string): void {
    mintVaultAuthorization(tx, { liveSessionId, utteranceId, text, ...(priorText === undefined ? {} : { priorText }), now: this.#now() });
  }

  claim(liveSessionId: string, content: string): VaultClaim {
    const claim = this.#store.transaction(tx => claimVaultWrite(tx, { liveSessionId, content }));
    if (claim.state === 'settled') this.#attempt(claim.receipt, 0);
    return claim;
  }

  /** One line per save attempt: the closed outcome and code, never the note. */
  #attempt(receipt: VaultReceipt, latencyMs: number): void {
    this.#log(vaultAttemptEvent(receipt, latencyMs));
  }

  async dispatch(claim: { opId: string; content: string; title: string }): Promise<VaultReceipt> {
    const started = this.#now();
    let result: VaultTransportResult;
    try { result = await this.#transport.save({ content: claim.content, title: claim.title, insightType: VAULT_INSIGHT_TYPE, project: VAULT_PROJECT }); }
    catch { result = { outcome: 'unknown' }; }
    return this.settle(claim.opId, result, Math.max(0, this.#now() - started));
  }

  settle(opId: string, result: VaultTransportResult, latencyMs: number): VaultReceipt {
    const state: VaultState = result.outcome === 'inserted' ? 'confirmed' : result.outcome === 'failed' || result.outcome === 'unavailable' ? 'failed' : result.outcome === 'duplicate' ? 'failed' : 'uncertain';
    const insightId = result.outcome === 'inserted' ? result.insightId : undefined;
    const code = result.outcome === 'inserted' ? undefined : result.outcome === 'unavailable' ? 'vault_unavailable' : result.outcome === 'failed' || result.outcome === 'duplicate' ? 'write_failed' : 'outcome_unknown';
    this.#store.transaction(tx => tx.run('UPDATE vault_writes SET state=?,insight_id=?,code=?,latency_ms=?,settled_at=? WHERE op_id=? AND state=?',
      [state, insightId ?? null, code ?? null, latencyMs, this.#now(), opId, 'dispatched']));
    const receipt = state === 'confirmed' && insightId ? { saved: true, insightId } : refusal(code === 'vault_unavailable' ? 'vault_unavailable' : code === 'write_failed' ? 'write_failed' : 'outcome_unknown');
    this.#attempt(receipt, latencyMs);
    return receipt;
  }
}

/** The tool's reply to the model: a true receipt or a closed code with words to say, never a save claim. */
export function vaultReceiptJson(receipt: VaultReceipt): JsonObject {
  return { saved: receipt.saved, ...(receipt.code === undefined ? {} : { code: receipt.code }), ...(receipt.insightId === undefined ? {} : { insightId: receipt.insightId }), ...(receipt.guidance === undefined ? {} : { guidance: receipt.guidance }) };
}
