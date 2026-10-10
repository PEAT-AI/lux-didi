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
