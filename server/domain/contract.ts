// Domain/runtime boundary.
//
// The service owns node:sqlite, the sole-writer lock, migrations and the
// outbox (server/contracts/*.ts, published in
// reports/lux-didi-overnight-1009/service/API.md). The domain NEVER opens a
// database: every operation receives a Transaction and runs inside the
// caller's transaction. Shared types are imported type-only, so this module
// adds no second copy of the storage/domain contract.
import { ServiceError } from '../contracts/errors.js';

export type { Transaction, SQLValue, SQLRow, SchemaMigration } from '../contracts/storage.js';
export type {
  DomainPort,
  DomainOperations,
  DomainOperation,
  DomainContext,
} from '../contracts/domain.js';
export { ServiceError };

export function badRequest(message: string, details: Record<string, unknown> = {}): never {
  throw new ServiceError('BAD_REQUEST', message, 400, details);
}

export function notFound(message: string, details: Record<string, unknown> = {}): never {
  throw new ServiceError('NOT_FOUND', message, 404, details);
}

export function conflict(id: string, expected: number, stored: number): never {
  throw new ServiceError('CONFLICT', 'revision conflict', 409, { id, expected, stored });
}

// ---------------------------------------------------------------------------
// Reminder outbox port.
//
// Reminders are not a domain-owned queue: the runtime outbox stores the intent
// in the same transaction as the commitment write, and no external send adapter
// exists. The route is the exact grant string `native.notify`; whether an
// authorized device may claim it is the runtime AuthorityPolicy's decision, so
// an unauthorized/undefined target is a pending scheduling need, never a
// reported success.
export const REMINDER_ROUTE = 'native.notify' as const;

// Event shape mirrors runtime/outbox.ts OutboxEvent exactly.
export interface OutboxEvent {
  id: string;
  entityId: string;
  entityRevision: number;
  authorityEpoch: string;
  requiredGrant: string;
  payload: string;
  sourceTimeZone: string;
  dueAt: string;
  expiresAt: string;
}

// Structural subset of the runtime `Outbox` value the facade composes with.
export interface OutboxPort {
  insert(tx: import('../contracts/storage.js').Transaction, event: OutboxEvent): void;
  supersede(
    tx: import('../contracts/storage.js').Transaction,
    entityId: string,
    throughRevision: number,
  ): number;
}
