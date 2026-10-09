# Domain contract

Owner: domain pair. Change only by coordinated root ruling. Read
`TOPOLOGY-DECISION.md` and `SERVICE-CONTRACT.md` first; the wire shapes are the
service's, not ours.

## Boundary

The service runtime owns `node:sqlite`, the sole-writer lock, migrations and the
outbox. **The domain never opens a database.** Every operation receives the
service `Transaction` (`server/contracts/storage.ts`) and runs inside the
caller's transaction. The domain imports the shared contract types type-only, so
it adds no second copy of the storage or domain contract.

- `server/domain/schema.ts` — `domainMigrations` (contiguous owner versions).
  The runtime applies them; the domain only declares them.
- `server/domain/memory.ts` — sessions, entries, source references, preferences,
  deterministic recall.
- `server/domain/commitments.ts` — commitments, append-only history, revision
  guard, daily plan.
- `server/domain/dto.ts` — transport-blind serializers to the SERVICE-CONTRACT
  wire shapes (ISO8601 UTC strings, UUID ids, positive revision, IANA zone).
- `server/domain/facade.ts` — `createDomainPort({ outbox })`, the `DomainPort`
  the service injects. It composes every mutation with its reminder/outbox
  insert or supersession inside the ONE transaction the service opened.

## Operations (`createDomainPort(...).execute(tx, operation, input, context)`)

Session/entry/memory: `createSession`, `listSessions`, `getSession`,
`appendEntry`, `recall`. Commitment: `createCommitment`, `listCommitments`,
`getCommitment`, `updateCommitment`, `transitionCommitment`
(`complete|cancel|reopen`), `plan`. The domain owns no transport: the service
maps these onto `/api/v1` routes and injects ids/identity, never the body.

## Invariants

- Append-only correction history (`commitment_revisions`; UPDATE/DELETE are
  refused by storage triggers as well as by code).
- `expectedRevision` guard: a stale writer gets a typed `CONFLICT` carrying
  `{id, expected, stored}`; nothing else changes.
- A correction, completion, cancellation or reopen supersedes the pending
  reminder and (where due) inserts the new one **in the same transaction**, so a
  rollback leaves neither commitment nor reminder.
- A genuinely new promise gets a new identity; reopen keeps identity.
- Honest recall: empty/whitespace query ⇒ 0 hits, 0 matches; an unseen term ⇒ 0
  hits; `totalMatches` counts every match and `truncated` is honest about the
  `limit`. Matching is case- and diacritic-insensitive and deterministic
  (keyword score, then recency).
- An imported source that is absent is recorded `availability: "missing"`, never
  implied present; the original text is stored locally.
- Boundaries only: empty required text, `limit <= 0`, an unparsable date or an
  unknown id are typed `BAD_REQUEST`/`NOT_FOUND` errors, not empty successes.

## Reminders

A reminder is a pending scheduling need, never an invented success. The facade
inserts an outbox event with the exact grant `native.notify`, bound to
`authorityEpoch`, `entityId` and `entityRevision`, with a `dueAt` and an
`expiresAt` (`REMINDER_TTL_MS` after due). Whether an authorized device may
claim it is the runtime `AuthorityPolicy` decision; with no authorized device
the event simply stays pending. The domain performs no effect itself and
`supersede`/`insert` share the domain transaction, so there is no second queue.

## Time

Instants are stored as UTC epoch milliseconds and serialized as ISO8601 UTC
strings. `timeZone` is an IANA name. Daily-plan day boundaries are computed in
the requested zone (`localDayBounds`), not in UTC, so a plan for a local date
includes exactly that local day and flags items due before the local day start
as overdue. Completed and cancelled commitments never appear in a plan.

## Status and integration

The runtime (`server/runtime/`) and the wire fixtures come from the service
pair; the domain test uses the real `Store` and `Outbox` against a temporary
SQLite database. `fixtures/domain/` is synthetic (generic examples only), never
private context.
