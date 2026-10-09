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
`appendEntry`, trusted in-process `appendAssistantEntry`, `recall`. Commitment: `createCommitment`, `listCommitments`,
`getCommitment`, `updateCommitment`, `transitionCommitment`
(`complete|cancel|reopen`), `plan`. The domain owns no transport: the service
maps public operations onto `/api/v1` routes and injects ids/identity, never the body.
`appendAssistantEntry` and the routing-label methods below are not public HTTP bindings.

## Durable routing labels (Domain migration v2)

Domain owns one append-only `routing_labels` table. Its primary key is
`(subject_kind, subject_id, revision)`; subject kind, class and writer have SQLite
CHECK constraints, revisions are positive integers, and writer/class combinations
also obey the automatic-label policy. Migration v2 is additive: v1 tables and
rows are unchanged and there is **no legacy backfill**. The domain appends revisions;
there is no label UPDATE/DELETE path. Store remains the single SQLite database,
transaction manager and durable owner (`Store.assistantId`); no per-row owner is
stored. The composition host adds its actual Store owner to routing decisions.

Exact types exported by `server/contracts/domain.ts` (and type-reexported by
`server/domain/contract.ts`):

```ts
interface RoutingSubject { kind: 'session' | 'entry' | 'commitment'; id: string }
type RoutingDataClass = 'ordinary' | 'private' | 'sensitive';
type TrustedWriteLabel =
  | { writer: 'capture'; dataClass: 'private' }
  | { writer: 'model'; dataClass: 'private' | 'sensitive' };
interface RoutingLabel {
  subject: RoutingSubject;
  revision: number;
  dataClass: RoutingDataClass;
  writer: 'capture' | 'model' | 'owner_review';
  recordedAt: string;
}
type RoutingLabelLookup = RoutingLabel | {
  subject: RoutingSubject; revision: 0; dataClass: 'unknown';
  writer: null; recordedAt: null;
};
interface RoutingLabelCorrection {
  subject: RoutingSubject; expectedRevision: number; dataClass: RoutingDataClass;
}
```

The synchronous in-process port extends the existing generic execute signature:

```ts
execute<K extends DomainOperation>(
  tx: Transaction, operation: K, input: DomainOperations[K]['input'],
  context: DomainContext, writeLabel?: TrustedWriteLabel,
): DomainOperations[K]['output'];
getRoutingLabel(tx: Transaction, subject: RoutingSubject): RoutingLabelLookup;
getRoutingLabelHistory(tx: Transaction, subject: RoutingSubject): RoutingLabel[];
correctRoutingLabel(
  tx: Transaction, input: RoutingLabelCorrection, context: DomainContext,
): RoutingLabel;
```

- Only `createSession`, `appendEntry`, `appendAssistantEntry` and
  `createCommitment` accept the fifth argument. New subjects receive revision 1
  atomically with content and any reminder insert in the caller's Store transaction.
  Every existing four-argument call remains valid and creates **no label**.
- Capture can stamp **private only**. Model can stamp private or sensitive, never
  ordinary. User `appendEntry` requires capture; `appendAssistantEntry` requires
  model. Session/commitment creation accepts either. Unsupported operations,
  invalid classes/writers and inconsistent append writers are BAD_REQUEST before
  any mutation. `owner_review` is not a permitted automatic writer.
- Public input DTOs and `SourceRef` have no class/writer/owner additions. Body-like
  extra fields and descriptive source labels never select routing policy. A trusted
  fifth argument is a composition seam, **not a public authorization boundary**.
- Lookup and history validate subject kind/id and use owning domain readers to
  verify existence. Missing subjects throw NOT_FOUND; an existing unlabeled
  subject returns unknown/revision 0/null writer/null time (history `[]`). Stored
  labels include their revision, writer and ISO timestamp. History is oldest first.
  Recall is not a stored subject kind: classify its underlying entry/commitment ids.
- Correction is explicit trusted owner review. It validates subject and a
  nonnegative safe-integer `expectedRevision` (0 means no prior label), rejects a
  stale revision with CONFLICT, and appends prior+1 with writer `owner_review` and
  `context.now`. It allows raising or lowering to any stored class and retains
  prior history; it never rewrites content or reminders. Plain commitment updates
  and transitions never silently relabel.
- All calls use the caller's `Transaction`. A label-insert failure, later caller
  persistence failure or correction failure rolls back with the enclosing Store
  transaction. There is no second connection, implicit transaction or ambient
  provenance state. Consumer lookup/history goes through Domain, not raw SQL.

Labels are owner-controlled **routing policy**, not semantic sensitivity detection
or a privacy guarantee. Domain does not enforce external-provider consent, derive
an output class from model context, contact providers or authorize HTTP callers.
The trusted host must choose a model label with the required context floor.
Actual HTTP spoof rejection, connected CHAT consent/dispatch integration and
live-provider behavior require later integration evidence; these engine tests
make no such claims.

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
- **Local provenance is validated before any write.** A commitment's
  `sourceSessionId`/`sourceEntryId` must resolve in the local store, and an
  entry must belong to the named session; unknown ids are `NOT_FOUND` and a
  mismatched pair is `BAD_REQUEST`, with zero commitment/history/outbox writes.
  An external source explicitly recorded as unavailable stays distinct from a
  resolvable local link.
- **Complete listing.** The wire `listSessions` exposes no cursor input, so the
  domain returns the complete deterministic list; it never presents a truncated
  list as exhausted with `nextCursor:null`. Real pagination is a future
  continuation contract, not a silent coverage cap.
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
