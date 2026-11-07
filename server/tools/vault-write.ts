import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { LUX_TOOLS, LUX_PARAMS as P, LUX_WRITE_TOOLS } from '../connectors/lux-names.js';
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

export interface VaultSaveArgs { readonly content: string; readonly title: string; readonly insightType: string; readonly project: string; readonly source?: Record<string, unknown> }

/** One MCP write attempt. The client owns the wire; nothing above it retries. */
export interface VaultWriteResult {
  disposition: string;
  [P.insightId]?: number;
  candidates?: unknown[];
  reason?: string;
  [key: string]: unknown;
}
export interface VaultTransport {
  write?(tool: string, args: Record<string, unknown>, authorized?: () => boolean): Promise<VaultWriteResult>;
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
export function authorizeComposedWrite(tx: Transaction, options: { liveSessionId: string; stageId: string; content: string; title: string; now: number; externalContextPresent?: boolean; payloadSha?: string; operation?: string }): VaultClaim {
  tx.run('INSERT OR IGNORE INTO vault_writes(op_id,live_session_id,utterance_id,operation,content,content_key,title,state,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomUUID(), options.liveSessionId, options.stageId, options.operation ?? LUX_TOOLS.create, options.content, vaultContentKey(options.content), options.title, 'authorized', options.now]);
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
  const insightId = row[P.insightId] === null || row[P.insightId] === undefined ? undefined : String(row[P.insightId]);
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
      // Helper claims require their active call and grant. Never replay them after a process restart.
      tx.run("UPDATE vault_writes SET state='failed',code='write_failed' WHERE state='authorized' AND utterance_id LIKE 'helper:%'");
      // A dispatched row may have reached lux. Never replay it without a remote receipt.
      tx.run("UPDATE vault_writes SET state='uncertain' WHERE state='dispatched'");
      // Authorized means the execution never crossed the dispatch boundary. Claim by op_id,
      // not by content, so recovery cannot bind to another authorization for the same note.
      return tx.all("SELECT * FROM vault_writes WHERE utterance_id NOT LIKE 'helper:%' AND (state='authorized' OR (state='failed' AND code='vault_unavailable' AND retry_count=0))").map(row => {
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

  readonly #validator = new AjvJsonSchemaValidator();

  /** The host selects an operation by discovered schema; the model supplies only the nested payload. */
  async writeTask(input: {
    sessionId: string; tool: 'vault_save' | 'vault_update'; operation: string;
    inputSchema: Record<string, unknown>; maxPayloadBytes: number; authorized: () => boolean;
    args: Record<string, unknown>; externalContextPresent?: boolean;
  }): Promise<VaultWriteResult> {
    const emit = (receipt: VaultWriteResult): VaultWriteResult => {
      this.#log({ event: 'vault_write', tool: (LUX_WRITE_TOOLS as readonly string[]).includes(input.operation) ? input.operation : input.tool,
        outcome: receipt.disposition, insight_id_prefix: Number.isSafeInteger(receipt[P.insightId]) ? String(receipt[P.insightId]).slice(0, 8) : '' });
      return receipt;
    };
    const refuse = (reason: string): VaultWriteResult => ({ disposition: 'refused', reason });
    if (!(LUX_WRITE_TOOLS as readonly string[]).includes(input.operation)) return emit(refuse('write_operation_not_supported'));
    if (!input.authorized()) return emit(refuse('write_grant_revoked'));
    const raw = input.args.payload;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emit(refuse('payload must match the discovered write schema'));
    const payload = structuredClone(raw) as Record<string, unknown>;
    const properties = input.inputSchema.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(payload).some(key => !Object.hasOwn(properties, key))) return emit(refuse('unknown_wire_parameter'));
    const authorized = this.#store.transaction(tx => {
      const turn = tx.get("SELECT journal_id AS id,'owner' AS role,text,arrived_at AS at FROM live_journal WHERE live_session_id=? AND journal_id=? AND kind='inputTranscription' AND finished=1", [input.sessionId, String(input.args.requested_turn_id ?? '')]);
      if (!turn || turn.role !== 'owner') return { refused: refuse('requested_turn_id must name a persisted owner turn in this call') };
      // Canonicalize the stored id: SQL aliases such as 01 must not mint another authorization.
      const turnId = String(turn.id), stageId = `helper:${turnId}`;
      if (tx.get('SELECT op_id FROM vault_writes WHERE live_session_id=? AND utterance_id=?', [input.sessionId, stageId])) return { refused: refuse('one write per owner turn') };
      const count = tx.get("SELECT count(*) AS n FROM vault_writes WHERE live_session_id=? AND utterance_id LIKE 'helper:%'", [input.sessionId]);
      if (Number(count?.n) >= 10) return { refused: refuse('ten writes per call') };
      if (!this.#transport.write) return { refused: refuse('vault write transport unavailable') };
      const provenance = `\n\nProvenance: lux-didi; speaker=owner; confidence=1; session=${input.sessionId}; requested_turn_id=${turnId}.`;
      if (input.operation === LUX_TOOLS.create || input.operation === LUX_TOOLS.update) {
        if (!Object.hasOwn(properties, P.sourceKind) || !Object.hasOwn(properties, P.sourceRef)) return { refused: refuse('provenance_schema_missing') };
        payload[P.sourceKind] = 'voice_call';
        payload[P.sourceRef] = { app: 'lux-didi', session_id: input.sessionId, turn_start_id: turnId, turn_end_id: turnId, spoken_at: new Date(Number(turn.at)).toISOString(), speaker: turn.role };
        if (typeof payload[P.content] === 'string') payload[P.content] = String(payload[P.content]) + provenance;
        if (input.operation === LUX_TOOLS.create) {
          if (!Object.hasOwn(properties, P.idempotencyKey)) return { refused: refuse('idempotency_schema_missing') };
          payload[P.idempotencyKey] = `${input.sessionId}:${turnId}:${turnId}`;
          if (payload[P.quote] === undefined && Object.hasOwn(properties, P.quote)) payload[P.quote] = String(turn.text).slice(0, 600);
        } else if (Object.hasOwn(properties, P.revisionReason)) payload[P.revisionReason] = String(payload[P.revisionReason] ?? '') + provenance;
      } else if (input.operation === LUX_TOOLS.link && Object.hasOwn(properties, P.provenanceSource)) {
        payload[P.provenanceSource] = 'TRANSCRIPT';
      } else if (input.operation === LUX_TOOLS.feedback && Object.hasOwn(properties, P.note)) {
        payload[P.note] = String(payload[P.note] ?? '') + provenance;
      }
      if (!this.#validator.getValidator(input.inputSchema)(payload).valid) return { refused: refuse('invalid_arguments_after_host_provenance') };
      const content = JSON.stringify(payload);
      if (Buffer.byteLength(content, 'utf8') > input.maxPayloadBytes) return { refused: refuse('request_bound_exceeded') };
      const claim = authorizeComposedWrite(tx, { liveSessionId: input.sessionId, stageId, operation: input.operation, content, title: input.operation, now: this.#now(), externalContextPresent: input.externalContextPresent ?? false });
      return { claim };
    });
    if (!authorized.claim) return emit(authorized.refused!);
    const claim = authorized.claim;
    if (claim.state !== 'dispatch') return emit(refuse('outcome_unknown'));
    const started = this.#now();
    let receipt: VaultWriteResult;
    try { receipt = await this.#transport.write!(input.operation, payload, input.authorized); }
    catch { receipt = refuse('outcome_unknown'); }
    const successful = ['created', 'duplicate_of', 'updated', 'linked', 'recorded'].includes(receipt.disposition);
    const uncertain = receipt.reason === 'outcome_unknown';
    const insightId = receipt[P.insightId] ?? payload[P.insightId] ?? payload[P.sourceInsightId];
    this.#store.transaction(tx => tx.run(`UPDATE vault_writes SET state=?,${P.insightId}=?,code=?,latency_ms=?,settled_at=? WHERE op_id=? AND state='dispatched'`, [
      successful ? 'confirmed' : uncertain ? 'uncertain' : 'failed', Number.isSafeInteger(insightId) ? String(insightId) : null,
      successful ? null : uncertain ? 'outcome_unknown' : 'write_failed', Math.max(0, this.#now() - started), this.#now(), claim.opId,
    ]));
    return emit(receipt);
  }

  #attempt(receipt: VaultReceipt, latencyMs: number): void {
    this.#log(vaultAttemptEvent(receipt, latencyMs));
  }

  async dispatch(claim: { opId: string; content: string; title: string }): Promise<VaultReceipt> {
    const sourceRow = this.#store.transaction(tx => tx.get('SELECT live_session_id,utterance_id,created_at FROM vault_writes WHERE op_id=?', [claim.opId]));
    const source = sourceRow ? { [P.sourceKind]: 'voice_call', [P.sourceRef]: { app: 'lux-didi', session_id: String(sourceRow.live_session_id), turn_start_id: String(sourceRow.utterance_id), turn_end_id: String(sourceRow.utterance_id), spoken_at: new Date(Number(sourceRow.created_at)).toISOString() }, [P.idempotencyKey]: `${String(sourceRow.live_session_id)}:${String(sourceRow.utterance_id)}:${String(sourceRow.utterance_id)}` } : undefined;

    const content = sourceRow ? `${claim.content}\n\nProvenance: lux-didi; speaker=owner; confidence=1; session=${String(sourceRow.live_session_id)}; requested_turn_id=${String(sourceRow.utterance_id)}.` : claim.content;
    const started = this.#now();
    let result: VaultTransportResult;
    try { result = await this.#transport.save({ content, title: claim.title, insightType: VAULT_INSIGHT_TYPE, project: VAULT_PROJECT, ...(source ? { source } : {}) }); }
    catch { result = { outcome: 'unknown' }; }
    let retried = false;
    if (result.outcome === 'unavailable') {
      // Unavailable is a pre-dispatch failure. Unknown/failed/duplicate never retry.
      const retry = this.#store.transaction(tx => tx.run(
        "UPDATE vault_writes SET retry_count=1 WHERE op_id=? AND state='dispatched' AND retry_count=0", [claim.opId]));
      if (retry === 1) {
        retried = true;
        await this.#backoff(250);
        try { result = await this.#transport.save({ content, title: claim.title, insightType: VAULT_INSIGHT_TYPE, project: VAULT_PROJECT, ...(source ? { source } : {}) }); }
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
    this.#store.transaction(tx => tx.run(`UPDATE vault_writes SET state=?,${P.insightId}=?,code=?,latency_ms=?,settled_at=? WHERE op_id=? AND state=?`,
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
