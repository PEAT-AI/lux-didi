# Native conversation: page selection and durable run discovery

Service/web protocol for the native conversation decision (root decision Lux88944). This document is
the repo-side protocol note for the increment implemented on accepted CONNECTED base
`fdb0ea20041cc29b733a095080395d473a0984a5`. The exact wire is in the task's `API.md`; this note records
the contract and its deliberate non-goals.

## Product rules

- The web page remains the only conversation selector. There is no native transcript list, dropdown,
  injected JavaScript or authority bridge.
- Selection is a temporary routing hint keyed by the paired browser principal. It is service memory, not
  a database row or token: it is bound by live authenticated principals, cleared on logout and lost on
  service restart. Choosing a destination grants no processing permission.
- Native reads the selection through the same page principal (cookie) it already uses; it never falls
  back to bearer. Selection writes require the browser cookie, exact Origin/CSRF and the current
  authority epoch; cookie and `Authorization` never combine.
- An externally accepted run becomes visible in the existing web transcript without a page refresh and
  without a second UI. The transcript, orb and layout stay shared and frozen.

## Durable discovery

A run notification stream (`POST /api/v1/conversations/:sessionId/events`) emits only durable run
identifiers. Events carry no transcript, model parts, prompts or credentials. A client:

1. registers the conversation subscription,
2. then reads the conversation's durable `latestRunId`,
3. then attaches the existing per-run stream, deduped by run id.

Reconnect repeats the durable read, so a frame missed while disconnected is found. The server keeps no
replay buffer; backpressure is bounded per subscriber and closes the subscription with
`resync_required`. Terminal states (`accepted`/`dispatch_intent`/`terminal` and the owning outcome, for
example `outcome_unknown` or `cancelled`) stay owned by durable CHAT; an external notification or a
local HTTP 200 is never a model-complete answer.

## Non-goals in this increment

No Swift change, installer, manifest/lock, SQLite schema/migration, model/MCP/provider, planning or CI
change. No change to the CHAT POST body, idempotency fingerprint, consent semantics, route identity or
persistent authority epoch. No new selection database or token, bearer fallback, native transcript
renderer, JavaScript authority bridge or generic polling loop. Draft persistence and the Send API are
unchanged: in-flight drafts are never retargeted, and reselecting a conversation recovers its saved run.
