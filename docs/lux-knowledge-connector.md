# Lux Knowledge connector

Naya's helper uses the owner's first-party Lux Knowledge endpoint for reading and owner-requested writes. Discovery is the protocol contract: there is no fixed read catalogue, parameter alias layer or old-name compatibility route.

## Discovery and admission

`luxToolAdmitted` is the single admission hook, shared with the trusted-endpoint rediscovery flow. A discovered `readOnlyHint: true` tool is readable unless destructive or explicitly owner-only. Safe mutations are selected by the small annotation/description policy composed into that hook. Archive, unarchive, purge, revert, expiry removal, checkpoint and review/resolution operations are never exposed to the helper.

The current mutation identities are `create_insight`, `update_insight`, `create_insight_link` and `record_search_feedback`. The host needs these identities for receipt interpretation, provenance and ledger operations, not as a replacement for discovery. All identities the host must recognize live in `server/connectors/lux-names.ts`; the independent discovery fixture and drift check guard against a server rename.

The reader exposes `call(tool, rawArguments, signal)`. It verifies the current grant, discovered schema, known wire keys and configured query/page/id bounds. An unknown key, missing tool or invalid shape is a hard refusal, never a dropped argument. Reads force sensitive inclusion when the discovered schema supports that parameter; Naya does not filter sensitive Lux rows. Search headers are rendered as complete opaque text for the helper, without parsing confidence or candidate fields out of them.

Helper read definitions use discovered names and input schemas unchanged. This includes revisions, meetings, context digests and new annotated read tools without another host declaration table. Listing open work uses the server's discovered follow-up and source-kind filters, not a special host search route.

## Helper writes

There are two helper mutation tools:

- `vault_save`: create a new insight using the discovered create schema.
- `vault_update`: correct an existing insight, close a follow-up, create a hub link or record search feedback, using the matching discovered mutation schema.

Both have the host envelope `{ requested_turn_id, payload }`. `payload` is the discovered input schema nested unchanged. The host selects exactly one currently granted mutation whose schema matches it; a model-provided tool name is not trusted. Ambiguous or missing schema matches are refused.

Naya saves when Rob asks or confirms her offer, updates when he corrects a stored fact, and reports the actual receipt. She sets the follow-up state to `open` when he leaves work for a later Claude session or next instance, and can close it through an update. Candidate matches are evidence for the helper to choose an update or a new create; neither host nor server silently merges them.

### Owner-turn boundary

The host verifies that the requested turn is persisted in the current call and has speaker `owner`. It uses the stored canonical turn id, so numeric aliases cannot reuse a confirmation. There is no additional semantic classifier or expiring consent phrase gate for these helper writes.

The existing write ledger enforces one authorized helper invocation per owner turn and ten per call, including after writer recreation. Payload schema and configured byte bounds are checked before a claim is inserted. The claim is committed before mutation dispatch, and the current grant is checked again after transport discovery and immediately before the mutation request.

A failed or uncertain dispatched attempt does not free its turn for an automatic retry. The helper must not turn an unresolved outcome into a save claim.

### Provenance mapping

| Operation | Lux-supported attribution | Host evidence |
| --- | --- | --- |
| Create | `source_kind: voice_call`; `source_ref` with app `lux-didi`, session, canonical turn range and spoken time; required idempotency key from session and turn range; supporting quote up to 600 characters | Ledger call id, owner turn, operation, frozen request and final state |
| Update | Revision source kind/reference and revision reason; owner/confidence attribution in corrected content or revision reason | Same insight id, owner turn and operation in the ledger |
| Hub link | `provenance_source: TRANSCRIPT`; the discovered link payload is otherwise retained | Full session/turn association in the ledger; no invented unsupported Lux fields |
| Search feedback | Supported note field carries the host attribution | Session, owner turn, operation and result in the ledger |

Speaker `owner` and confidence `1` describe the supporting owner request, not an independently verified truth score. They are text attribution in content/revision reason/feedback note, not new protocol fields. Caller fields are not stripped to make an incompatible server accept a write. If required source or idempotency fields are absent from discovery, the host refuses that create/update contract instead.

The helper can see create dispositions `created`, `duplicate_of` or `refused`, candidate rows and update/link/feedback receipts. A correction retains its insight id and Lux retains its revision. Content-rewrite guards such as the server's revision or timestamp check remain part of the discovered contract.

## Transport, deadlines and recovery

The existing `server/adapters/lux-write/client.ts` is the only write transport. The existing dictated-note feature remains separate from the helper tools but uses this same client/service, not a second write path. Its frozen owner content is retained in full; deterministic host attribution is added at dispatch.

Each transport operation owns its MCP session: initialize, initialized notification, discovery, schema validation and at most one mutation. The endpoint is HTTP loopback only, redirects are rejected and requests are bounded by a timeout. Optional bearer credentials are read at runtime and never logged. There is no mutation retry inside the client.

The helper's waiting lifetime is separate from an in-flight mutation. A pending receipt is not confirmation; the background outcome must be logged and settled in the ledger. After process interruption, dispatched rows become uncertain and helper mutations are not automatically replayed. The older dictated-note pre-dispatch recovery behavior is retained separately.

Migration `live/16` rebuilds the historical `vault_writes` operation check for the current create/update/link/feedback operations and preserves old receipts. Historical migration SQL bytes are unchanged. The frozen owner-payload digest includes the current create identity, so a protocol rename cannot reuse the old payload identity.

## Diagnostics and checks

Helper `vault_write` events contain only tool, outcome and an insight-id prefix. Request content, quotes, payloads and credentials are not accepted by the host-log whitelist. The local write ledger is application data, not a content-free log.

Dynamic Lux arguments use the diagnostic store's existing hash-only fallback rather than a hand-maintained query-field capture table. See [Diagnostic store](diagnostic-store.md).

`bash scripts/check-knowledge-connector.sh` runs the connector tests, durable helper-ledger tests, discovery drift tests and the source stray-name check. The latter imports the single identity module using the repository's Node 26 runtime. Tests use synthetic discovery and temporary stores, never the owner's Lux daemon or database.
