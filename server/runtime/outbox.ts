import { randomUUID } from 'node:crypto';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import { ServiceError } from '../contracts/errors.js';
export type OutboxState = 'pending' | 'claimed' | 'acknowledged' | 'failed' | 'unknown' | 'superseded';
export interface OutboxEvent { id: string; entityId: string; entityRevision: number; authorityEpoch: string; requiredGrant: string; payload: string; sourceTimeZone: string; dueAt: string; expiresAt: string }
export interface OutboxClaim { event: OutboxEvent; token: string }
export interface AuthorityPolicy { permits(grant: string): boolean }
export const denyAll: AuthorityPolicy = Object.freeze({ permits: () => false });
function instant(value: string): number { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error('Invalid instant'); return result; }
function fromRow(row: SQLRow): OutboxEvent {
  return { id: String(row.id), entityId: String(row.entity_id), entityRevision: Number(row.entity_revision), authorityEpoch: String(row.authority_epoch), requiredGrant: String(row.required_grant), payload: String(row.payload), sourceTimeZone: String(row.source_timezone), dueAt: new Date(Number(row.due_at)).toISOString(), expiresAt: new Date(Number(row.expires_at)).toISOString() };
}
export const Outbox = {
  insert(tx: Transaction, event: OutboxEvent): void {
    if (!Number.isSafeInteger(event.entityRevision) || event.entityRevision < 1 || instant(event.expiresAt) <= instant(event.dueAt)) throw new Error('Invalid outbox revision/expiry');
    tx.run("INSERT INTO runtime_outbox(id,entity_id,entity_revision,authority_epoch,required_grant,payload,source_timezone,due_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,'pending')", [event.id, event.entityId, event.entityRevision, event.authorityEpoch, event.requiredGrant, event.payload, event.sourceTimeZone, instant(event.dueAt), instant(event.expiresAt)]);
  },
  supersede(tx: Transaction, entityId: string, throughRevision: number): number {
    return tx.run("UPDATE runtime_outbox SET state='superseded',claim_token=NULL,lease_until=NULL WHERE entity_id=? AND entity_revision<=? AND state IN ('pending','claimed')", [entityId, throughRevision]);
  },
  claim(tx: Transaction, now: string, leaseMs: number): OutboxClaim | undefined {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid claim lease');
    const time = instant(now);
    tx.run("UPDATE runtime_outbox SET state='unknown',claim_token=NULL,lease_until=NULL WHERE state='claimed' AND lease_until<=?", [time]);
    tx.run("UPDATE runtime_outbox SET state='failed' WHERE state='pending' AND expires_at<=?", [time]);
    const row = tx.get("SELECT * FROM runtime_outbox WHERE state='pending' AND due_at<=? AND expires_at>? ORDER BY due_at,id LIMIT 1", [time, time]);
    if (!row) return undefined;
    const token = randomUUID();
    tx.run("UPDATE runtime_outbox SET state='claimed',claim_token=?,lease_until=? WHERE id=? AND state='pending'", [token, time + leaseMs, row.id!]);
    return { event: fromRow(row), token };
  },
  revalidate(tx: Transaction, claim: OutboxClaim, currentEpoch: string, currentRevision: number | null, now: string, policy: AuthorityPolicy = denyAll): boolean {
    const row = tx.get("SELECT * FROM runtime_outbox WHERE id=? AND state='claimed' AND claim_token=?", [claim.event.id, claim.token]);
    if (!row) return false;
    const time = instant(now);
    const original = fromRow(row);
    const unchanged = (Object.keys(original) as (keyof OutboxEvent)[]).every(key => original[key] === claim.event[key]);
    return unchanged && Number(row.lease_until) > time && Number(row.expires_at) > time && row.authority_epoch === currentEpoch && Number(row.entity_revision) === currentRevision && policy.permits(String(row.required_grant));
  },
  recordOutcome(tx: Transaction, claim: OutboxClaim, outcome: 'acknowledged' | 'failed' | 'unknown', now: string = new Date().toISOString()): void {
    if (!['acknowledged', 'failed', 'unknown'].includes(outcome)) throw new Error('Invalid delivery outcome');
    if (tx.run("UPDATE runtime_outbox SET state=?,claim_token=NULL,lease_until=NULL WHERE id=? AND state='claimed' AND claim_token=? AND lease_until>? AND expires_at>?", [outcome, claim.event.id, claim.token, instant(now), instant(now)]) !== 1) throw new ServiceError('CONFLICT', 'Outbox claim is no longer live', 409);
  },
  state(tx: Transaction, id: string): OutboxState | undefined { return tx.get('SELECT state FROM runtime_outbox WHERE id=?', [id])?.state as OutboxState | undefined; },
};
