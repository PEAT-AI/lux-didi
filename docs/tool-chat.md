# Tool chat

Compose the accepted tools owner into an actual conversation: a chat run may select configured MCP
connections, and the model-facing evidence it receives is bound to the run that was accepted.

## Composition seam
`composeChat(store, domain, configDir, testing, now, ownerProfile, assembly)`:

- the **sixth** argument is the accepted persona `ownerProfile` and must keep its existing semantics;
- the **seventh** is the explicit `ToolChatAssembly` (`{ registry, port, connections }`). It is a separate
  parameter on purpose: the assembly is never inferred from the shape of the persona argument.

`ChatToolComposition` (host-owned, in `server/host/connected.ts`) is the only seam Chat sees: `accept`,
`definitions`, `receipts`, `runner`.

## One owner, one source of truth for receipts
- `ToolsOwner.receipts(tx, runId)` projects the owner's **immutable** completed calls: the result
  reference (`id`, `sha256`), the call/intent association, and the validated bound-connection provenance.
  It is read inside the **caller's** transaction, because `Store.transaction` forbids nesting.
- `ToolsOwner.acceptedRun(runId)` returns the immutable acceptance plus its hash, so callers (including the
  Host egress wrapper) never run raw SQL against the owner's `tool_runs`.
- Chat persists **no** copy of receipts. `chat_run_tools` (chat migration v5) holds only Chat's own
  run-to-tool association (`binding_hash`, `credential_json`); the durable evidence itself lives in the
  owner's tables, which are trigger-protected against update/delete.

Provider entity identifiers are **unknown** by design: `sourceIds`/`toolReferences` carry the owner-minted
result hash and the connection that supplied the evidence, never an id parsed from model text. A
`lux-knowledge:<requestedId>`-style value is never manufactured.

## Connection readiness (optional integrations never fake "connected")
`ConnectionStatus[]` is projected from the durable `tool_connections` policy plus the registry's current
grant, through the owner API (`ToolsOwner.connections()`), never by raw SQL from downstream modules.
States are `ready`, `needs_setup` and `unavailable`:

- a current grant is approval/discovery evidence, **not** transport liveness, so a granted connection is
  reported as `ready` with `lastKnown` ("last checked") and is never claimed `connected`;
- a durable but unapproved connection is `needs_setup`; a locally disabled one is `unavailable`.

The projection carries a safe label only — never a credential, an account payload, a secret path or a live
tool catalog.

## Selection is explicit and per accepted run
A run selects the connections it may use; the selection is part of that run's acceptance. Disabled or
unconfigured connections are never auto-selected, and selecting one never widens a grant: the executor and
the result gate re-check the accepted policy on every step. A connection disabled after acceptance stops
further egress for that run (the host egress wrapper re-reads the accepted connection ids before the lower
transport).

## Checks
- `scripts/check-tool-chat.sh` — compiles the focused roots, runs the conversation scenarios, builds the
  real web client and runs the browser phase through the browser slot.
- `scripts/check-tool-owner.sh` — the owner's own suite (grants, receipts, connection policy).
Both need the shared dependency root (`DIDI_TYPESCRIPT_ROOT` / the paths pinned inside each script); the
repo itself carries no `node_modules`.

## Invariants
- No new schema or authorization boundary for the composition; no ModelPort widening.
- Persona snapshots, class/disclosure behaviour and deadlines are preserved.
- Nothing in this path may be inferred from model text or from a configured URL.
