# Domain contract

The domain owns local records and their invariants. It does not own HTTP, provider access or a database connection. The host composes it with the runtime through `createDomainPort` in `server/domain/facade.ts`.

## Source of truth

| Contract | Read |
| --- | --- |
| Port, operations and routing-label types | `server/contracts/domain.ts` |
| Transaction contract | `server/contracts/storage.ts` |
| Domain composition and operation dispatch | `server/domain/facade.ts` |
| Domain migrations | `domainMigrations` in `server/domain/schema.ts` |
| Sessions, entries and recall | `server/domain/memory.ts` |
| Commitments, revision guards and daily plans | `server/domain/commitments.ts` |
| Routing labels and corrections | `server/domain/labels.ts` |
| Conversation summaries | `server/domain/summaries.ts` |
| Transport serializers | `server/domain/dto.ts` |
| Database, transactions and migration application | `Store` in `server/runtime/store.ts` |

Use the migrations for the exact table inventory and the shared contract for the current operation shapes. Do not maintain a second schema or copied TypeScript interface here.

## Transactions and records

The caller supplies a `Transaction` to the domain port. Domain changes and their reminder outbox changes share that transaction; the domain must not open a second connection to make a mutation appear successful independently of its effects.

`createDomainPort` receives the outbox dependency from the host. A committed record is evidence of a local save, not evidence that a remote notification was delivered. [service.md](service.md) owns the transport mapping and [local-runtime.md](local-runtime.md) owns runtime authority.

Commitment changes use an expected revision to reject stale writers. Reopening a commitment preserves its identity; creating a different promise requires a new one. Local source references must resolve consistently before a write. Read the validation and transition logic in `server/domain/commitments.ts` before adding a mutation path.

## Routing policy is not content detection

`getRoutingLabel`, `getRoutingLabelHistory` and `correctRoutingLabel` in `server/domain/facade.ts` delegate to the label owner. Label corrections preserve revision history rather than silently changing the provenance of an earlier record.

Automatic labels come from trusted in-process context, not a request body or a descriptive source name. An unknown label is not an ordinary-data grant. The host still has to enforce provider route classes and owner consent; domain labels alone do not authorize external disclosure. See [privacy-and-authority.md](privacy-and-authority.md).

## Recall, summaries and time

Recall reads stored records through the domain rather than accepting model recollection as a source. Selected prompt context is a separate concern from the long-term store; see [selected-memory.md](selected-memory.md).

Conversation summaries have their own domain module and migrations. Do not treat an old planning proposal for session summaries as proof that summaries are absent from the current release.

`localDayBounds` in `server/domain/util.ts` computes a day's boundaries in the requested time zone. Daily plans must use those boundaries rather than substituting a UTC day. Serialization remains the DTO layer's job.

## Reminders

The host supplies `resolveTarget` to the domain composition. With a target, reminder intent is bound to that target's grant; without one, the `native.notify.unbound` grant leaves a scheduling need that cannot be dispatched as if delivery were authorized. `REMINDER_TTL_MS` in `server/domain/facade.ts` owns reminder expiry. A due date and an outbox row are not proof that Naya can call the owner back.

## Verification

`bash scripts/check-domain.sh` is the focused domain check. It uses the repository's compiled runtime and synthetic fixtures, not private account records. Follow [checks.md](checks.md) for check selection and [local-development.md](local-development.md) before running it. This documentation wagon does not claim to have rerun domain tests.
