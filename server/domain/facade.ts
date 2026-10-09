import type { DomainContext, DomainOperation, DomainOperations, DomainPort, Transaction } from './contract.ts';
import { REMINDER_ROUTE } from './contract.ts';
import type { OutboxEvent, OutboxPort } from './contract.ts';
import * as memory from './memory.ts';
import type { Clock } from './memory.ts';
import * as commitments from './commitments.ts';
import type { CommitmentRecord } from './commitments.ts';
import * as dto from './dto.ts';
import { domainMigrations } from './schema.ts';

// The facade IS the DomainPort the service injects. Every method runs the
// domain mutation and its reminder/outbox insert or supersession inside the ONE
// transaction the service opened for it, so a failure rolls back the
// commitment, its append-only history and the reminder together. The domain
// performs no side effect itself.
//
// A reminder is a pending scheduling need, never an invented success: it is
// inserted with the exact grant `native.notify`, and only an authorized device
// that claims it can act.

/** A reminder stops being useful a day after its due instant. */
export const REMINDER_TTL_MS = 24 * 60 * 60 * 1000;

export interface DomainDeps {
  outbox: OutboxPort;
}

function clockAt(context: DomainContext): Clock {
  const ms = Date.parse(context.now);
  if (Number.isNaN(ms)) throw new Error(`invalid context.now: ${context.now}`);
  return { now: () => ms };
}

function isoToMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid instant: ${value}`);
  return ms;
}

class Domain implements DomainPort {
  readonly migrations = domainMigrations;
  readonly #outbox: OutboxPort;

  constructor(outbox: OutboxPort) {
    this.#outbox = outbox;
  }

  execute<K extends DomainOperation>(
    tx: Transaction,
    operation: K,
    input: DomainOperations[K]['input'],
    context: DomainContext,
  ): DomainOperations[K]['output'] {
    const op = operation as DomainOperation;
    switch (op) {
      case 'createSession': {
        const i = input as DomainOperations['createSession']['input'];
        const clock = clockAt(context);
        const session = memory.createSession(
          tx,
          { title: i.title, startedAt: clock.now(), timeZone: i.timeZone },
          clock,
        );
        return dto.toSessionDTO(session) as DomainOperations[K]['output'];
      }
      case 'listSessions': {
        const sessions = memory.listSessions(tx).map(dto.toSessionDTO);
        return { items: sessions, nextCursor: null } as DomainOperations[K]['output'];
      }
      case 'getSession': {
        const i = input as DomainOperations['getSession']['input'];
        const session = memory.readSession(tx, i.id);
        const entries = memory
          .entries(tx, i.id)
          .map((e) => dto.toEntryDTO(e, memory.sourceReferences(tx, e.id)));
        return {
          session: dto.toSessionDTO(session),
          entries,
          nextCursor: null,
        } as DomainOperations[K]['output'];
      }
      case 'appendEntry': {
        const i = input as DomainOperations['appendEntry']['input'];
        const clock = clockAt(context);
        const source = i.sourceRef
          ? {
              id: i.sourceRef.id,
              label: i.sourceRef.label,
              provider: i.sourceRef.provider,
              accountId: i.sourceRef.accountId,
              externalId: i.sourceRef.externalId,
              sourceTimestamp: isoToMs(i.sourceRef.sourceTimestamp),
              availability: i.sourceRef.availability,
              note: i.sourceRef.note,
            }
          : undefined;
        const entry = memory.appendEntry(
          tx,
          {
            sessionId: i.sessionId,
            text: i.text,
            capturedAt: clock.now(),
            timeZone: i.timeZone,
            role: i.role,
            source,
          },
          clock,
        );
        return dto.toEntryDTO(entry, memory.sourceReferences(tx, entry.id)) as DomainOperations[K]['output'];
      }
      case 'recall': {
        const i = input as DomainOperations['recall']['input'];
        return dto.toRecallDTO(memory.recall(tx, i.q, i.limit)) as DomainOperations[K]['output'];
      }
      case 'createCommitment': {
        const i = input as DomainOperations['createCommitment']['input'];
        const clock = clockAt(context);
        const c = commitments.captureCommitment(
          tx,
          {
            title: i.title,
            notes: i.notes,
            dueAt: isoToMs(i.dueAt),
            timeZone: i.timeZone,
            sourceSessionId: i.sourceSessionId,
            sourceEntryId: i.sourceEntryId,
          },
          clock,
        );
        if (c.dueAt !== null) this.#outbox.insert(tx, this.#reminder(c, context));
        return dto.toCommitmentDTO(c) as DomainOperations[K]['output'];
      }
      case 'listCommitments': {
        const i = input as DomainOperations['listCommitments']['input'];
        return {
          items: commitments.listCommitments(tx, i.status).map(dto.toCommitmentDTO),
          nextCursor: null,
        } as DomainOperations[K]['output'];
      }
      case 'getCommitment': {
        const i = input as DomainOperations['getCommitment']['input'];
        return {
          commitment: dto.toCommitmentDTO(commitments.readCommitment(tx, i.id)),
          history: commitments.commitmentHistory(tx, i.id).map(dto.toHistoryDTO),
        } as DomainOperations[K]['output'];
      }
      case 'updateCommitment': {
        const i = input as DomainOperations['updateCommitment']['input'];
        const clock = clockAt(context);
        const c = commitments.correctCommitment(
          tx,
          i.id,
          i.expectedRevision,
          {
            title: i.title,
            notes: i.notes,
            dueAt: i.dueAt === undefined ? undefined : isoToMs(i.dueAt),
            timeZone: i.timeZone,
          },
          clock,
        );
        // A correction replaces the pending reminder atomically, in this tx.
        this.#outbox.supersede(tx, i.id, c.revision);
        if (c.dueAt !== null) this.#outbox.insert(tx, this.#reminder(c, context));
        return dto.toCommitmentDTO(c) as DomainOperations[K]['output'];
      }
      case 'transitionCommitment': {
        const i = input as DomainOperations['transitionCommitment']['input'];
        const clock = clockAt(context);
        const c =
          i.operation === 'complete'
            ? commitments.completeCommitment(tx, i.id, i.expectedRevision, clock)
            : i.operation === 'cancel'
              ? commitments.cancelCommitment(tx, i.id, i.expectedRevision, clock)
              : commitments.reopenCommitment(tx, i.id, i.expectedRevision, clock);
        this.#outbox.supersede(tx, i.id, c.revision);
        if (i.operation === 'reopen' && c.dueAt !== null) {
          this.#outbox.insert(tx, this.#reminder(c, context));
        }
        return dto.toCommitmentDTO(c) as DomainOperations[K]['output'];
      }
      case 'plan': {
        const i = input as DomainOperations['plan']['input'];
        return dto.toPlanDTO(commitments.dailyPlan(tx, i.date, i.timeZone)) as DomainOperations[K]['output'];
      }
      default: {
        throw new Error(`unknown domain operation: ${String(op)}`);
      }
    }
  }

  #reminder(c: CommitmentRecord, context: DomainContext): OutboxEvent {
    const dueAtMs = c.dueAt as number;
    const dueAt = new Date(dueAtMs).toISOString();
    const timeZone = c.dueTimeZone ?? 'UTC';
    return {
      id: `${c.id}:${c.revision}`,
      entityId: c.id,
      entityRevision: c.revision,
      authorityEpoch: context.authorityEpoch,
      requiredGrant: REMINDER_ROUTE,
      payload: JSON.stringify({
        route: REMINDER_ROUTE,
        commitmentId: c.id,
        revision: c.revision,
        title: c.title,
        notes: c.notes,
        dueAt,
        timeZone,
      }),
      sourceTimeZone: timeZone,
      dueAt,
      expiresAt: new Date(dueAtMs + REMINDER_TTL_MS).toISOString(),
    };
  }
}

export function createDomainPort(deps: DomainDeps): DomainPort {
  return new Domain(deps.outbox);
}
