import type { Identity } from '../tasks/authority.js';
import { freezeNote } from './lux-note.js';
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
export const VAULT_SAY_NO_ASK = 'nothing in this session asked for that save, so nothing was stored';
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
export interface VaultWriteResult {
  disposition: string;
  insight_id?: number;
  candidates?: unknown[];
  reason?: string;
  [key: string]: unknown;
}
export interface VaultTransport {
  write?(tool: string, args: Record<string, unknown>): Promise<VaultWriteResult>;
  save(args: VaultSaveArgs): Promise<VaultTransportResult>;
  backoff?(milliseconds: number): Promise<void>;
}

export type VaultClaim =
  | { readonly state: 'dispatch'; readonly opId: string; readonly content: string; readonly title: string }
  | { readonly state: 'settled'; readonly receipt: VaultReceipt };

export interface VaultStore { transaction<T>(body: (tx: Transaction) => T extends PromiseLike<unknown> ? never : T): T }

/** The one door the Live tool layer has to the write service: a claimed operation, and its receipt. */
export type VaultDispatchPort = (claim: { opId: string; content: string; title: string }) => Promise<VaultReceipt>;

const GUIDANCE: Readonly<Record<VaultCode, string>> = {
  not_owner_requested: VAULT_SAY_NO_ASK,
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

export type SaveCommand = { readonly content: string; readonly refers: boolean };

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

function receiptFromRow(row: SQLRow): VaultReceipt {
  const state = String(row['state']) as VaultState;
  const insightId = row['insight_id'] === null || row['insight_id'] === undefined ? undefined : String(row['insight_id']);
  if (state === 'confirmed' && validInsightId(insightId)) return { saved: true, insightId };
  if (state === 'failed') return refusal(row['code'] === 'vault_unavailable' ? 'vault_unavailable' : 'write_failed');
  return refusal('outcome_unknown');
}

/** One ledger row is claimed once, atomically, whichever consent minted it. */
function claimRow(tx: Transaction, row: SQLRow, content?: string): VaultClaim {
  if (String(row['state']) !== 'authorized') return { state: 'settled', receipt: receiptFromRow(row) };
  const opId = String(row['op_id']);
  const claimed = tx.run("UPDATE vault_writes SET state='dispatched' WHERE op_id=? AND state='authorized'", [opId]);
  if (claimed !== 1) {
    const replay = tx.get('SELECT * FROM vault_writes WHERE op_id=?', [opId]);
    return { state: 'settled', receipt: replay ? receiptFromRow(replay) : refusal('outcome_unknown') };
  }
  return { state: 'dispatch', opId, content: content ?? String(row['content']), title: content ? vaultTitle(content) : String(row['title']) };
}

export interface VaultWriterOptions {
  readonly store: VaultStore;
  readonly transport: VaultTransport;
  readonly now: () => number;
  readonly log: (event: Record<string, unknown>) => void;
  readonly backoff?: (milliseconds: number) => Promise<void>;
}

/** The voice-only write service: mint, atomic claim, one dispatch, one settlement, no retry anywhere. */
export class VaultWriter {
  readonly #store: VaultStore;
  readonly #transport: VaultTransport;
  readonly #backoff: (milliseconds: number) => Promise<void>;
  readonly recovery: Promise<void>;
  readonly #now: () => number;
  readonly #log: (event: Record<string, unknown>) => void;

  constructor(options: VaultWriterOptions) {
    this.#store = options.store; this.#transport = options.transport; this.#now = options.now; this.#log = options.log;
    this.#backoff = options.backoff ?? options.transport.backoff?.bind(options.transport) ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const claims = this.#store.transaction(tx => {
      // A dispatched row may have reached lux. Never replay it without a remote receipt.
      tx.run("UPDATE vault_writes SET state='uncertain' WHERE state='dispatched'");
      // Authorized means the execution never crossed the dispatch boundary. Claim by op_id,
      // not by content, so recovery cannot bind to another authorization for the same note.
      return tx.all("SELECT * FROM vault_writes WHERE state='authorized' OR (state='failed' AND code='vault_unavailable' AND retry_count=0)").map(row => {
        const retry = row.state === 'failed';
        if (retry) tx.run("UPDATE vault_writes SET state='authorized',retry_count=1 WHERE op_id=? AND state='failed' AND retry_count=0", [String(row.op_id)]);
        return { claim: claimRow(tx, retry ? { ...row, state: 'authorized' } : row), retry };
      });
    });
    this.recovery = Promise.all(claims.map(async ({ claim, retry }) => {
      if (claim.state === 'dispatch') {
        if (retry) await this.#backoff(250);
        await this.dispatch(claim);
      }
    })).then(() => {});
  }

  /** Task admission is owned by Authority; this boundary only validates and atomically claims its exact payload. */
  async saveTask(input: { sessionId: string; identity: Identity; content: string; title: string; outsideTextSeen: boolean }): Promise<VaultReceipt> {
    const frozen = freezeNote({ title: input.title, body: input.content, externalContextPresent: input.outsideTextSeen });
    if (frozen.state !== 'frozen') return { saved: false, code: 'write_failed', guidance: 'The note payload was invalid. Nothing was written.' };
    const claim = this.#store.transaction(tx => authorizeComposedWrite(tx, { liveSessionId: input.sessionId,
      stageId: `task:${input.identity.task_id}:${input.identity.operation_id}`, content: input.content.trim(), title: input.title.trim(),
      externalContextPresent: input.outsideTextSeen, payloadSha: frozen.payloadSha, now: this.#now() }));
    if (claim.state === 'dispatch') return this.dispatch(claim);
    this.#attempt(claim.receipt, 0); return claim.receipt;
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
    let retried = false;
    if (result.outcome === 'unavailable') {
      // Unavailable is a pre-dispatch failure. Unknown/failed/duplicate never retry.
      const retry = this.#store.transaction(tx => tx.run(
        "UPDATE vault_writes SET retry_count=1 WHERE op_id=? AND state='dispatched' AND retry_count=0", [claim.opId]));
      if (retry === 1) {
        retried = true;
        await this.#backoff(250);
        try { result = await this.#transport.save({ content: claim.content, title: claim.title, insightType: VAULT_INSIGHT_TYPE, project: VAULT_PROJECT }); }
        catch { result = { outcome: 'unknown' }; }
      }
    }
    const receipt = this.settle(claim.opId, result, Math.max(0, this.#now() - started));
    return retried ? { ...receipt, guidance: receipt.saved
      ? `Retried when lux became reachable; saved to lux as ${claim.title}.`
      : `Retried lux once. ${receipt.guidance ?? 'The note was not saved.'}` } : receipt;
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
  if (receipt.saved) return { saved: true, insightId: receipt.insightId ?? '', guidance: receipt.guidance ?? 'Saved to lux.' };
  return { saved: receipt.saved, ...(receipt.code === undefined ? {} : { code: receipt.code }), ...(receipt.insightId === undefined ? {} : { insightId: receipt.insightId }), ...(receipt.guidance === undefined ? {} : { guidance: receipt.guidance }) };
}
