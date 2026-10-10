# Explicit selected local memory (backend)

This slice makes a Chat request able to carry an **explicit, bounded selection of already-stored
local records** for that turn. It is a trusted in-process contract on `ChatService`; it is not
archive hydration, not automatic recall and not a model tool. There is no UI or HTTP control in
this slice.

## Trusted input

`server/chat/types.ts` adds one optional field to `AcceptInput`:

```ts
selectedMemoryEntryIds?: readonly string[]   // trusted in-process only
```

- Absent and `[]` both mean **empty selection**; nothing from memory is captured.
- At most **32** values; each a canonical entry id matching `^[A-Za-z0-9_-]{1,128}$`.
  An invalid shape (`ChatError('invalid_input')`), an unknown id or an over-policy label fails
  **before any capture**, so neither the new user entry nor the run is saved.
- Duplicates are **coalesced**, and the canonical value is the sorted set — so a reordered or
  duplicated equal selection has one identical meaning.

The accept allowlist is widened for this trusted field only. HTTP's exact-key body allowlist is
untouched, so `/api/v1/chat` still refuses the field until a later integration slice.

## Idempotency

The fingerprint object stays `{ sessionId, text, retryOf }`, and the key
`selectedMemoryEntryIds` is added **only when the canonical list is non-empty**. Old empty-selection
hashes are therefore unchanged. Same key + reordered/duplicate-equal selection replays the same
run; same key + a different canonical selection is `idempotency_conflict`. `retryOf` never inherits
a selection — an explicit retry must resupply it.

## Domain resolution

`server/contracts/domain.ts` adds `resolveEntries`:

```ts
resolveEntries: { input: { entryIds: string[] }; output: { records: ResolvedEntry[] } }
```

`ResolvedEntry` carries `entryId`, `sessionId` (the parent session), `text`, `role`, `capturedAt`
and the exact `sourceRefs`; `sourceTimestamp` is always `null` because the Domain owns no single
source timestamp (an earliest-ref aggregate would be invented). One record per requested id, in
order; an unknown entry id or missing parent session is a typed `NOT_FOUND`. It is one `IN` read
of `entries` (PK-indexed), one `IN` read of `sessions` and one `IN` read of `source_references`
with a fixed `owner_kind='entry'` predicate — never a full table scan of `entries`, never a
per-record transaction loop, and never cross-owner-kind mixing.

## Accept transaction

Resolution, classification and freezing happen inside the **same synchronous accept transaction**,
before the user entry and run writes. A resolved record is admissible only when **both** its entry
label and its parent-session label are known, owned by `store.assistantId`, permitted by the
sending conversation's live consent and allowed by the route; an unknown entry or parent label
blocks (`unavailable`). The outgoing class for the record is `max(entryClass, parentClass)`
(ordinary < private < sensitive) — a label is never lowered.

## Frozen context and snapshot

`server/chat/schema.ts` adds chat migration **v3**, `chat_run_context`
(`run_id`, `schema_version`, `requested_ids`, `resolved_records`). It is inserted only for a
non-empty selection, in the same transaction. The frozen JSON is bounded by serialized **UTF-8
bytes** (`Buffer.byteLength(...) <= 100000`); a larger selection is refused
(`selection_too_large`), never silently capped. A run with no row — including every pre-v3 run —
means empty selection.

`RunSnapshot.memorySelection` exposes safe metadata only (requested/used/omitted ids, counts and
compiler omit reasons, and whether the prompt has frozen) — never record text, and no whole-archive
claim.

## Dispatch

Dispatch reads the frozen records back and emits one `Evidence` per record
(`id = "selected:<entryId>"`, `provenance = "memory.selection"`, priority 1, text = the frozen
record). Classification uses stored `entry`/`session` labels only — never text and never the host's
`recall -> null` rule; capability tool declarations stay `[]`. Both `#checkPolicy` gates remain:
pre-dispatch (all requested) and pre-generate (only the records actually included after the prompt
freezes). Correcting an included entry or parent — or revoking the sending grant — aborts before
egress or aborts in-flight generation, with no final answer committed; an omitted-only correction
continues. Already-sent bytes stay `mayHaveBeenSent`.

## Names in scope (files)

`server/contracts/domain.ts`, `server/domain/{contract,memory,dto,facade}.ts`,
`server/chat/{types,schema,index,context,memorySelection}.ts`,
`server/test/memory-context.{test,process}.ts`, `server/tsconfig.json`,
`scripts/check-memory-context.sh`, this file. HTTP, web, Swift, installer, manifests, prompt/persona
and the model adapter are untouched.

## Index (Domain v3)

The `source_references` reads are indexed. Domain migration **v3** adds
`CREATE INDEX ix_source_references_owner ON source_references(owner_id, owner_kind)`: the leading
`owner_id` serves the existing generic owner-only `sourceReferences` helper and the trailing
`owner_kind` serves the selected-entry batch resolver's fixed `owner_kind='entry'` predicate.
Bounded EXPLAIN QUERY PLAN over 5000 synthetic refs shows `SEARCH source_references USING INDEX
ix_source_references_owner` for the helper (`owner_id=?`) and the batch resolver
(`owner_id=? AND owner_kind=?`) at IN size 1 and 32 (a temporary B-tree for `ORDER BY id` is
expected). The upgrade is additive on the populated v1+v2 schema: rows, source refs and prior
table bytes are unchanged, `index_info` is exactly `[owner_id, owner_kind]`, `integrity_check` is
`ok`, reopen is idempotent, and a name collision rolls back with no partial metadata.
