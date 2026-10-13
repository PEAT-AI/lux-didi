# Selected local memory in the connected conversation (UI + HTTP)

This slice lets a person choose exact stored local notes for the **next** model message, see what
was actually used, and keep that evidence after reload. It reuses the existing local recall model,
the same Store and the existing Didi/Vicuna layout. It adds no automatic archive hydration, no
external tool call and no new grant.

## HTTP contract

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

## Web client

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

## Tests

- `server/test/selected-memory-ui.test.ts` — real Store + Domain + ChatService + HTTP: field
  passthrough, malformed/oversized/unknown/unclassified/over-grant refusals with no capture, body
  idempotency-key rejection, missing Origin/CSRF, one accepted cross-session note reaching the
  provider request with an unselected canary absent, normalized replay/conflict semantics, and
  source-backed metadata after a restart.
- `server/test/selected-memory-browser-fixture.ts` + `web/test/selected-memory-browser.mjs` — the
  synthetic note fixture and the real GPU browser proof (desktop 1440, mobile 390).

Run both through `scripts/check-selected-memory-ui.sh`.

## Owner deletion

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

### Live remember finalization

`remember_note` persists only the owner's verbatim transcription, never model output or a model paraphrase. An explicit provider input transcription `finished: true` finalizes the owner turn immediately. When that flag is absent, the provider's tool call or first model output establishes a model-turn boundary; the owner finalizes the latest input journal row only after 300 ms without a newer input transcription. A newer input frame invalidates that boundary and requires a new one. An admitted remember tool waits at most 1500 ms for finalization, journaling exactly one typed `remember_deferred` row with `waitedMs` for the wait. If no finalization occurs within that bound, the existing `owner_transcript_not_final` refusal remains. The 300 ms default is a quiet-window safeguard, not permission to derive text from model words.
