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

- Append-only correction history (`commitment_revisions`; no code path issues
  UPDATE/DELETE, and `(commitment_id, revision)` is the primary key). A
  storage-level trigger is not usable here: the service runtime admits exactly
  one SQL statement per migration entry and a trigger body needs an inner `;`.
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

A reminder is a pending scheduling need, never an invented success. The host
injects a target resolver (`createDomainPort({ outbox, resolveTarget })`); the
resolver is host-owned and never read from a request body, model field or
browser `clientId`.

- **Bound target:** the resolver returns an authorized `{deviceId, grant}`, and
the event's `requiredGrant` is that scoped grant with the `deviceId` in the
payload, so the runtime `revalidate` can permit exactly that device.
- **No target:** the intent is registered under `native.notify.unbound`, a grant
no authorized device holds, so `revalidate` can never permit it and the need
stays non-dispatchable. It is an explicit scheduling need, not a delivery.
- **Revocation:** the resolver is consulted on every mutation, so when a target
is revoked a correction supersedes the bound intent and re-inserts a
non-dispatchable need.

Every event is bound to `authorityEpoch`, `entityId`, `entityRevision` and an
`expiresAt` (`REMINDER_TTL_MS` after due). The domain performs no effect itself
and `supersede`/`insert` share the domain transaction, so there is no second
queue. The route in the payload is the exact string `native.notify`.

## Time

Instants are stored as UTC epoch milliseconds and serialized as ISO8601 UTC
strings. `timeZone` is an IANA name. Daily-plan day boundaries are computed in
the requested zone (`localDayBounds`), not in UTC, so a plan for a local date
includes exactly that local day and flags items due before the local day start
as overdue. Completed and cancelled commitments never appear in a plan.

## Reuse from Naya (naya-reuse/MEMORY-REUSE.md, Llama@036a4bc) and gaps

This first slice reuses the verified generic conventions that fit a local
SQLite domain, and explicitly does not import the Naya service, its PostgreSQL
schema, its agricultural identity fields or any private rows/personas:

- **Commit-backed receipts, never optimistic.** A mutation and its reminder are
  one transaction; the domain returns its DTO only from committed state, so the
  service emits `saved` from the committed result, never from queue admission.
  In-memory facts never outrun committed facts. (The rollback test proves a
  failed transaction leaves neither commitment nor reminder.)
- **Provenance with stable source identity.** A source reference carries
  `provider`/`accountId`/`externalId`/`sourceTimestamp` and an explicit
  `availability`; an imported source that is absent is recorded `missing`, never
  implied present. A **failed lookup stays distinct from a confirmed absence**:
  both are `availability: "missing"`, and the `note` field records which it was
  (`lookup_failed` vs an accepted-absent reason). The domain never collapses the
  two and never invents content for a source it could not read.
- **Coverage honesty / no completeness cap disguised as retrieval.** Recall
  reports `totalMatches` and `truncated`; an empty or unseen query returns 0,
  never a fabricated hit.
- **No resurrection.** Completed and cancelled commitments never reappear in a
  plan because an older record mentioned them; reopen is explicit and keeps
  identity.

Deferred to a separate layered-memory follow-up (deliberately NOT built into
this slice):

1. `session_gists`: versioned session summaries with pending/complete/failed
   state, source version/count, bounded retry, claim ownership and closed-session
   sealing — a background pipeline, not a request path.
2. A pure `buildPromptMemory` selection with an explicit token/byte budget and
   coverage metadata, keeping the long-term store separate from the small
   selected prompt context (a ledger, never an all-history dump).
3. On-demand `readSource` that resolves an authorized original turn by stable id
   with unavailable/partial/truncated/complete coverage; FTS search results are
   leads, the source read grounds a quotation.
4. `memory_notes`: identity/preference versus time-limited state notes, with
   provenance, expiry, supersession and active status; corrections retire the
   previous active fact without losing the audit trail.
5. Owners/users and cross-owner denial, `recall_audit`, and a forget/reset path
   with a non-content tombstone and generation fencing so later summary jobs
   cannot resurrect forgotten memory; separately label remembered-facts reset
   versus transcript deletion versus all-local-data deletion.
6. SQLite FTS5 lexical search (cross-script/trigram parity is a separate,
   explicitly claimed feature).

No Naya database, credential, REST call or provider session is a dependency.

## Status and integration

The runtime (`server/runtime/`) and the wire fixtures come from the service
pair; the domain test uses the real `Store` and `Outbox` against a temporary
SQLite database. `fixtures/domain/` is synthetic (generic examples only), never
private context.

### Wiring the domain into the service

The domain is a sibling package with no database of its own. The service:

```ts
import { createDomainPort } from './domain/facade.js';
const domain = createDomainPort({ outbox: Outbox }); // runtime/outbox.js
const store = new Store(dataDir, domain.migrations); // runtime/store.js
// routes: store.transaction((tx) => domain.execute(tx, op, input, context))
```

`domain.migrations` are the contiguous domain owner versions the runtime
applies. `createDomainPort` closes over the runtime outbox, so a route runs the
mutation and the reminder insert/supersede in the one transaction the service
opened. `server/domain/tsconfig.build.json` compiles the domain into
`server/dist/domain` next to the service's own build output.

### Check-runtime note (integration decision for the service pair / root)

The declared domain check runs a `.ts` file directly, but the service runtime
cannot be loaded from TypeScript source: `runtime/store.ts` and
`contracts/errors.ts` use TypeScript parameter properties, which this Node
build's strip-only mode refuses (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and the
service's `.js` import specifiers do not resolve to `.ts`. So the domain test
loads the real runtime and the domain from the compiled output in `server/dist`
(the service package's own convention, where its tests run from `dist/` after
`npm run build`).

Reproduce the compiled run:

```sh
cd server
npm run build                    # service: contracts, runtime, http -> dist/
./node_modules/.bin/tsc -p domain/tsconfig.build.json   # domain -> dist/domain
cd ..
node --test server/test/domain.test.ts
```

The declared argv alone has no build step, so it passes only in a worktree where
`server/dist` is already built. Making the check self-building (a
`scripts/check-domain.sh` that runs the two builds, mirroring
`scripts/check-service.sh`) is the service/root decision, not a domain change.
