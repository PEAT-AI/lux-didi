# Roadmap and backlog

Status: proposed plan. The repository contains no application, and every capability described here is planned, not built. The structured plan is [planning/backlog.json](../planning/backlog.json): 101 nodes, one program tracker (P00), ten epics (E01 to E10) and ninety work items (A, B, C, D and F leaves). When published, the same nodes are GitHub issues with stable IDs, labels and milestones; the mapping is recorded in `planning/issue-map.json`.

## Numbering

| Range | Meaning |
|---|---|
| P00 | Program tracker: five lanes plus milestone entry points |
| E01 to E10 | Epics: outcomes and exit criteria, no direct work |
| A01 to A18 | Runtime and local execution leaves (master A) |
| B01 to B18 | Evidence, memory and persona leaves (master B) |
| C01 to C18 | Accounts, connectors and trust leaves (master C) |
| D01 to D18 | Commitments and proactivity leaves (master D) |
| F01 to F18 | Native experience leaves (master E, prefix F so leaves never collide with epic IDs) |

## Milestones

Milestones are delivery stages, not dates. No completion date or effort estimate is asserted; the order is a dependency order.

### M0, proof and contracts

Turn the open host and evidence questions into contracts the other lanes can build against. Entry points: A01 (host and licence feasibility, with a measured spike and an architecture decision record), A02 (versioned cross-track contracts and fixtures), B01 (evidence and source identity model), C14 (tool capability registry), D01 (commitment lifecycle schema), C01 (multi-account identity map), C02 (Google installed-app OAuth). Exit criteria: the host is chosen by a measured spike and recorded in an ADR, the contract package and fixtures exist and are consumed by at least the storage, provider and MCP areas, and no task asserts a measured figure it has not recorded.

### M1, useful daily loop

Make one person's day work end to end without optional infrastructure. Entry points: A08 (action intents, receipts and unknown-outcome reconciliation), C12 (grants, allowlists and the effect broker, both first-loop prerequisites), A04 (store), A05 (durable jobs), A07 (tool turns), A15 (outbox and crash recovery), D02 (promise extraction) and D06 (realistic daily plan), D10 (quiet and urgency policy contract), B02 to B09 (transcript originals, resolution, recall, preferences, correction), C03 (Gmail ingestion) and C05 (Calendar), F01, F02, F09 (notification baseline), F10 and F13, the Stage A half of F15, and A17 as the first daily-loop integration owner. Exit criteria: the scenarios in [acceptance.md](acceptance.md) pass on the Stage A pilot with the real surfaces they name, and the first loop in that document works from a clean account with one Google account.

### M2, voice and proactive beta

Voice becomes the default conversational surface and proactive work earns trust. Entry points: F03 to F08 (audio devices, duplex provider, fallback, barge-in, reconnect, voice character), B10 (consolidation), B14 (gradual persona learning), B15 (memory inspector), C07 to C10 (document resolution, chat and Trello reads), C16 (injection and account isolation adverse tests), C17 (disconnect, revoke, cache propagation), D11 to D14 and D18 (asynchronous investigation, replanning, follow-ups, advanced catch-up). Exit criteria: a duplex voice loop with barge-in and honest cancellation, proactive reminders under the interruption policy, and the adverse security tests passing.

### M3, controlled execution and integrations

Extend from reading and preparing to bounded, authorized action and optional integrations. Entry points: A09 to A13 and A14 (A14 is optional transport, deferred unless a first-slice dependency proves otherwise), B06 (optional knowledge adapter, deferred on the same rule), B18 (embedding and index portability), C06 (Calendar actions), C11 (Trello actions), C13 (company knowledge permissions), C18 (optional consultation adapter), D15 and D16 (external task reconciliation, calibration), F11, F12, F16, F17 (review surfaces, computer control, pairing, companion). Exit criteria: every effect passes the broker with a receipt, revocation and unknown outcomes are handled, and the companion works as a controller without holding authority.

### M4, portability and polish

Close the seams that need evidence or a decision. Entry points: F14 (optional wake phrase, gated on a measured energy delta), F18 (Windows port seam and conformance guide). Exit criteria: the wake-word decision is recorded as enable or defer with numbers, and a conformance guide exists for a non-Mac host.

## Track map

| Epic | Master | Phase | Leaves | Goal |
|---|---|---|---|---|
| E01 Runtime and local execution | A | M0 | A01 to A08 | The host decision, shared contracts, service, store, jobs, providers, tool turns and receipts |
| E02 Harness supervision and operational reliability | A | M1 | A09 to A18 | Supervise existing harness sessions safely, plus diagnostics and measurement |
| E03 Evidence and durable recall | B | M0 | B01 to B09 | Source identity, transcript originals and resolution, gists, recall, preferences, suppression, export and forget |
| E04 Evolving personality and memory quality | B | M1 | B10 to B18 | Consolidation, context compilation, a public persona spec, private customization, learning with provenance, evaluation |
| E05 Accounts and work sources | C | M1 | C01 to C11 | The user's own accounts: Google, chat and Trello, with read and prepare adapters |
| E06 Authority and optional company integrations | C | M1 | C12 to C18 | Grants, the effect broker, egress policy, capability registry, adverse tests, revocation, optional company adapter |
| E07 Commitments and daily planning | D | M1 | D01 to D09 | Commitments with evidence, prioritization, planning, reminders and conversation control |
| E08 Proactive follow-through | D | M2 | D10 to D18 | Interruption policy, asynchronous progress, replanning, follow-ups, calibration, sleep and offline behavior |
| E09 Mac conversation surface | E | M2 | F01 to F09 | Hotkey, text and voice conversation, barge-in, reconnection, voice character, notifications |
| E10 Installability, computer control and companion portability | E | M3 | F10 to F18 | Onboarding and grants, review surfaces, computer control, lifecycle, wake word, packaging, companion, portability |

Phase counts: M0 has 12 work items, M1 has 38, M2 has 19, M3 has 19, and M4 has 2.

## First slice

The first real-user slice is the acceptance target for M1. Install as a clean-account Stage A pilot, connect one Google account, press the hotkey, converse by text (voice enabled as soon as the stream works), read the upcoming calendar, capture or infer one commitment with its evidence, schedule one useful reminder, open the conversation from the notification, prepare an unsent reply, recall it in the next session, then resolve it and never resurrect it. Lux, the harness and Trello are not required, and every optional integration degrades to a clear not-configured state.

What the first slice deliberately does not include: sending mail or messages, deleting anything, paid public distribution, wake word, computer control beyond an explicit grant, and proactive work while the Mac sleeps.

## Dependency order

The backlog is a directed acyclic graph. All edges live in one machine-readable field, `depends_on`, and every edge means a completion or integration prerequisite, not a prohibition on starting. A producer contract can be authored and tested against a consumer's fixtures before its own consumers finish, so lanes overlap deliberately; [parallel-masters.md](parallel-masters.md) names which leaves may start on fixture contracts. There is no second completion graph and no speculative universal engine.

Key cross-track edges (all genuine completion dependencies):

- Storage A04 is a completion prerequisite for the persistent memory leaves (B02 to B18 where the leaf writes or indexes local state) and for the account and connector leaves that persist state (C01, C03, C05, C08, C17).
- Receipts A08 and the broker C12 are first-loop prerequisites. A07 (tool turns) waits on both contracts, and the effect leaves (C04, C06, C09, C11) declare the broker edge explicitly.
- A single safe model-call entry (A06) refuses content until its route policy is resolved, and source-content cloud paths (A07, D02, B04, B11, D04, D05) cannot complete before C15. C15 may depend on the A06 interface, and A06 default-denies until policy is supplied, so the gate exists from the first loop without a cycle.
- Memory leaves declare only the storage edge they need; B06 (optional knowledge adapter) and C14 depend on the shared contract package A02; D01 and D05 cross into A02, B03 and C05.
- D10 is a pure quiet and urgency policy contract with its baseline in M1; D07 and D08 consume it, and D08 consumes the single A15 outbox rather than building a second retry queue.
- A17 owns the runnable first daily-loop integration across one account, from evidence-linked promise to closure with no resurrection, plus restart, sleep, token-expiry, egress-refusal and unknown-effect cases.
- No edge points from an earlier phase to a later phase requirement: every dependency is in the same or an earlier phase. The validator checks both acyclicity and phase order.

## Labels and milestones

The validator derives labels from node fields so the published issues cannot drift from the backlog: `kind:program`, `kind:epic` and `kind:task`; `master:A` to `master:E` on epics and leaves; `phase:M0` to `phase:M4`; `priority:P0` to `priority:P2`. Milestones carry the same five stage IDs with the descriptive titles above. The program tracker has no master label. Published totals are 101 roadmap issues plus one separate plan-delivery issue used only by the documentation pull request; the tracker `P00` is never auto-closed by it.

## Where to start

Read the program tracker P00 first: its body names the five lanes and the entry point for each milestone. Then [parallel-masters.md](parallel-masters.md) for ownership and start packets, [architecture.md](architecture.md) for the invariants, and [decisions.md](decisions.md) for the choices already made and the questions still open.
