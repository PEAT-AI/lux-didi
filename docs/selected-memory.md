/tmp/intro-memory.md

## Explicit selected local memory (backend)


This slice makes a Chat request able to carry an **explicit, bounded selection of already-stored
local records** for that turn. It is a trusted in-process contract on `ChatService`; it is not
archive hydration, not automatic recall and not a model tool. There is no UI or HTTP control in
this slice.

### Trusted input

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

### Idempotency

The fingerprint object stays `{ sessionId, text, retryOf }`, and the key
`selectedMemoryEntryIds` is added **only when the canonical list is non-empty**. Old empty-selection
hashes are therefore unchanged. Same key + reordered/duplicate-equal selection replays the same
run; same key + a different canonical selection is `idempotency_conflict`. `retryOf` never inherits
a selection — an explicit retry must resupply it.

### Domain resolution

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

### Accept transaction

Resolution, classification and freezing happen inside the **same synchronous accept transaction**,
before the user entry and run writes. A resolved record is admissible only when **both** its entry
label and its parent-session label are known, owned by `store.assistantId`, permitted by the
sending conversation's live consent and allowed by the route; an unknown entry or parent label
blocks (`unavailable`). The outgoing class for the record is `max(entryClass, parentClass)`
(ordinary < private < sensitive) — a label is never lowered.

### Frozen context and snapshot

`server/chat/schema.ts` adds chat migration **v3**, `chat_run_context`
(`run_id`, `schema_version`, `requested_ids`, `resolved_records`). It is inserted only for a
non-empty selection, in the same transaction. The frozen JSON is bounded by serialized **UTF-8
bytes** (`Buffer.byteLength(...) <= 100000`); a larger selection is refused
(`selection_too_large`), never silently capped. A run with no row — including every pre-v3 run —
means empty selection.

`RunSnapshot.memorySelection` exposes safe metadata only (requested/used/omitted ids, counts and
compiler omit reasons, and whether the prompt has frozen) — never record text, and no whole-archive
claim.

### Dispatch

Dispatch reads the frozen records back and emits one `Evidence` per record
(`id = "selected:<entryId>"`, `provenance = "memory.selection"`, priority 1, text = the frozen
record). Classification uses stored `entry`/`session` labels only — never text and never the host's
`recall -> null` rule; capability tool declarations stay `[]`. Both `#checkPolicy` gates remain:
pre-dispatch (all requested) and pre-generate (only the records actually included after the prompt
freezes). Correcting an included entry or parent — or revoking the sending grant — aborts before
egress or aborts in-flight generation, with no final answer committed; an omitted-only correction
continues. Already-sent bytes stay `mayHaveBeenSent`.

### Names in scope (files)

`server/contracts/domain.ts`, `server/domain/{contract,memory,dto,facade}.ts`,
`server/chat/{types,schema,index,context,memorySelection}.ts`,
`server/test/memory-context.{test,process}.ts`, `server/tsconfig.json`,
`scripts/check-memory-context.sh`, this file. HTTP, web, Swift, installer, manifests, prompt/persona
and the model adapter are untouched.

### Index (Domain v3)

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

#### Voice memory writes and frozen prompts

The built-in Live `remember_note` writes only an explicitly requested, finalized owner utterance as ordinary memory. It does not change the running session's accepted prompt snapshot or prompt identity. A later CREATE selects and recalls the note using the ordinary memory section. Live-voice entries have no deletion control yet; removing a note from the selected-memory picker only removes that local selection, not the durable entry. Private or sensitive voice classification is refused, not downgraded. See [tool-owner.md](tool-owner.md) for the built-in authorization and provenance rule.


### Owner deletion and retained selections

Owner memory deletion replaces matching chat_run_context.resolved_records with
content-free tombstone references in the same transaction as the canonical entry
delete. The original requested IDs remain as selection provenance, not text.
Before dispatch, frozen records are revalidated through the domain resolver;
deleted entries are omitted even when a domain deletion bypassed the HTTP
composition. Surviving accepted records retain their frozen content and routing
checks. Deleted entry labels no longer gate a future dispatch that omits them.

Live's accepted prompt snapshot and runtime's idempotent response cache are also
redacted by their respective owners within that delete transaction. Cached
responses retain fingerprints and replay a content-free NOT_FOUND result rather
than rerunning a mutation. Quoted conversation output and transcriptions are not
selected memory copies and are removed with the conversation instead.


## Selected local memory in the connected conversation (UI + HTTP)


This slice lets a person choose exact stored local notes for the **next** model message, see what
was actually used, and keep that evidence after reload. It reuses the existing local recall model,
the same Store and the existing Didi/Vicuna layout. It adds no automatic archive hydration, no
external tool call and no new grant.

### HTTP contract

`POST /api/v1/chat` (the connected accept route) gains one optional body field:

```json
{ "sessionId": "<uuid>", "text": "…", "selectedMemoryEntryIds": ["<stored note id>", "…"] }
```

- The field passes through **both** exact HTTP allowlists: the `fields(...)` allowlist in
  `server/http/routes.ts` and the explicit `chat.accept({…})` construction in
  `server/http/server.ts`. `ChatService.accept` stays the sole fingerprint owner.
- Absent or `[]` means an empty selection and is byte-identical to the existing canonical request
  (the fingerprint key is added only for a non-empty canonical list), so old hashes stay valid.
- The HTTP layer shape-checks the field before any capture: an array of at most 32 strings matching
  `^[A-Za-z0-9_-]{1,128}$`; anything else is `400` with a message naming selected notes. The
  server then validates the exact ids and the stored entry/parent policy at acceptance.
- The `Idempotency-Key` **header** remains the only idempotency key; a body `idempotencyKey` is
  refused `400`. Cookie/`Origin`/CSRF/authority-epoch protections are unchanged.

Refusals are decided by the accepted MEMORY backend: an unknown-but-well-formed id is `404`; an
entry or parent session with no stored classification, or a class outside the configured
route/consent grant, is refused before any capture (no user entry, no run, no provider call). The
mapping in `server/http/server.ts` is unchanged.

### Web client

A compact expandable **Selected notes** section lives inside the existing connected panel
(`web/src/connected.ts`), styled by `web/src/style.css` and responsive down to 390px.

- "Find notes" searches **local recall only** (`GET /api/v1/recall`). Only hits that carry a stored
  note id can be selected; a hit without one is shown as not selectable. No pretend results.
- Selecting shows the stored excerpt and date where available, a selected count, and Remove/Clear
  controls. Removing a note only leaves it out of the next message; the panel never says a note was
  erased, forgotten or deleted.
- On Send the message is frozen: conversation, draft, normalized sorted-unique selected ids and the
  idempotency key. Editing the draft or the selection afterwards affects only a future message; a
  failed or uncertain request keeps its key and target and is never silently retargeted.
- An empty selection omits the field entirely, so the canonical request is unchanged.
- A refused selection shows a plain local explanation and no captured turn.

After a final or recovered run the panel shows **canonical** `RunSnapshot.memorySelection`
metadata: requested, used and omitted ids with counts and reasons. Omitted notes are never shown as
used. No note text is copied into a URL, localStorage, analytics or an error message.

### Tests

- `server/test/selected-memory-ui.test.ts` — real Store + Domain + ChatService + HTTP: field
  passthrough, malformed/oversized/unknown/unclassified/over-grant refusals with no capture, body
  idempotency-key rejection, missing Origin/CSRF, one accepted cross-session note reaching the
  provider request with an unselected canary absent, normalized replay/conflict semantics, and
  source-backed metadata after a restart.
- `server/test/selected-memory-browser-fixture.ts` + `web/test/selected-memory-browser.mjs` — the
  synthetic note fixture and the real GPU browser proof (desktop 1440, mobile 390).

Run both through `scripts/check-selected-memory-ui.sh`.

### Owner deletion

Every entry shown in the local conversation, recall results, or selected-note picker has a
Delete memory control with one confirmation. The browser calls authenticated
`DELETE /api/v1/entries/:id` with an empty JSON object, then reloads the conversation and recall payloads from the
service. It does not optimistically filter records. Failed deletes leave the previous
payload visible; a failed reload reports an error rather than claiming a fresh list.
Deletion is unavailable while a connected generation is active. Successful deletion
invalidates the picker's cached selection and refreshes it from the service.

The owner physically removes the entry and its source references in one transaction,
and retains only entry id, deletion time, browser actor, and `owner_request` in a
domain tombstone, with a content-free Live session/turn dedup key when applicable. A repeated remember_note for that voice turn returns already_remembered and writes nothing. Repeating deletion returns that same tombstone; unknown ids return
NOT_FOUND. New recall and Live CREATE selection cannot resolve the removed entry.
Historical chat context snapshots and Live transcripts are not rewritten. In particular,
a previously accepted chat run can still compose its frozen resolved-record snapshot;
that read-back is a separate follow-up and is not covered by this deletion boundary.

#### Live remember finalization

`remember_note` persists only the owner's verbatim transcription, never model output or a model paraphrase. An explicit provider input transcription `finished: true` finalizes the owner turn immediately. When that flag is absent, the provider's tool call or first model output establishes a model-turn boundary; the owner finalizes the latest input journal row only after 300 ms without a newer input transcription. A newer input frame invalidates that boundary and requires a new one. An admitted remember tool waits at most 1500 ms for finalization, journaling exactly one typed `remember_deferred` row with `waitedMs` for the wait. If no finalization occurs within that bound, the existing `owner_transcript_not_final` refusal remains. The 300 ms default is a quiet-window safeguard, not permission to derive text from model words.

### Memory list (web)

The Memory tab renders an at-a-glance list of the current conversation's stored entries, newest
first, from the existing owner list route (`GET /api/v1/sessions/:id`, which returns `{ session, entries }`). No route shape changes.

- `web/src/memory-list.ts` owns the list. Each item shows its kind, its origin and the local
  created time. The domain now derives both once in `server/domain/memory.ts` and returns them on
  every entry: `kind` is `fact`, `preference` or `task` when the Live `remember_note` source note
  recorded one and `note` otherwise; `origin` is `live-voice`, `chat`, `page` or `unknown`, read from
  the entry's stored source reference (`unknown` when it records none). The badge renders only for a
  real kind (`note` shows none, W-FIX2), and the origin line renders for every entry.
- The writers record that reference: Live `remember_note` writes `provider: live-voice`
  (`server/live/index.ts`), the page saver posts `provider: page` (`saveLocalNote` in `web/src/main.ts`,
  ruling WKIND-R1), and the connected chat writes `provider: chat` on both entries of a run, keyed by
  the conversation id (`server/chat/index.ts`, ruling WKIND-R2). Entries from any other writer read
  `origin: unknown` honestly.
- The filter box narrows the already-fetched list in the browser by text, case-insensitively, across
  the text, kind and origin. Nothing is sent to the service and no new request is made.
- The list shows its count and an honest empty state ("Didi remembers nothing yet.") and never
  invents a memory it did not receive.
- Deletion keeps W-X's confirm-and-server-confirmation behaviour: the same `Delete memory` control
  and `deleteMemoryAndReload` helper, so a cancelled or failed delete leaves the displayed list
  untouched.

The Memory tab mounts the list from `memory()` in `web/src/main.ts` (ruling WMEM2-R1 grants that file for the mount only): it calls `memoryListMarkup(entries, { filter: memoryFilter, disabled })` and binds the `#memory-filter` input to a client-side re-render. Nothing else in that file changes.

