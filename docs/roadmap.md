# Roadmap and backlog

Status: proposed plan. The repository contains no application, and every capability described here is planned, not built. The structured plan is [planning/backlog.json](../planning/backlog.json): 119 nodes, one program tracker (P00), thirteen epics (E01 to E13) and one hundred and five work items (A, B, C, D and F leaves). When published, the same nodes are GitHub issues with stable IDs, labels and milestones; the mapping is recorded in `planning/issue-map.json`.

## Numbering

- P00: program tracker with the five lanes and the milestone entry points.
- E01 to E13: epics with outcomes and exit criteria, no direct work.
- A01 to A24: runtime and local execution and portable service leaves (master A).
- B01 to B18: evidence, memory and persona leaves (master B).
- C01 to C23: accounts, connectors, trust and channel leaves (master C).
- D01 to D18: commitments and proactivity leaves (master D).
- F01 to F22: native experience and client surface leaves (master E, prefix F so leaves never collide with epic IDs).

## Milestones

Milestones are delivery stages, not dates. No completion date or effort estimate is asserted; the order is a dependency order.

### M0, proof and contracts

Turn the open evidence and interface questions into contracts the other lanes can build against. The service stack itself is already decided. Entry points: A01 (service stack, client roles and licence boundary record, decided under PLAN-R1), A02 (versioned cross-track contracts and fixtures), A03, A04, B01 (evidence and source identity model), B07 (preference authority), B12 (persona specification), B17 (evidence classes), C01 (multi-account identity map), C02 (Google installed-app OAuth), C14 (tool capability registry), D01 (commitment lifecycle schema). Exit criteria: the service stack record is implemented by the loopback service seam (A19), the contract package and fixtures exist and are consumed by concrete storage, provider and domain contract consumers, and no task asserts a measured figure it has not recorded. MCP transport is deferred to M3 and is not part of this exit.

### M1, useful daily loop

Make one person's day work end to end without optional infrastructure. Entry points: A05 to A08 and A15 to A18 (durable tasks, receipts, tool turns, outbox, diagnostics and the integration gate); B02 to B05, B08 and B09, B11, B13 and B16; C03 to C05, C12 and C15 to C17; D02 to D10 and D17; F01, F02, F09, F10, F13 and the Stage A half of F15. A08 (action receipts) and C12 (grant broker) are first-loop prerequisites, not late hardening, and the essential source-injection, account-isolation, egress-denial and revocation cases (C16, C17) gate this milestone too. Exit criteria: the scenarios in [acceptance.md](acceptance.md) pass on the Stage A pilot with the real surfaces they name, and the first loop in that document works from a clean account with one Google account.

### M2, voice and proactive beta

Voice becomes the default conversational surface and proactive work earns trust. Entry points: F03, F04 and F06 to F08 (audio devices, duplex provider, barge-in, reconnect, voice character); B10, B14 and B15 (consolidation, persona learning, memory inspector); C07 to C10 (document resolution, chat and Trello reads); D11 to D14 and D18 (asynchronous investigation, replanning, follow-ups, advanced catch-up); and the extended adversarial corpus beyond the M1 essential cases. Exit criteria: a duplex voice loop with barge-in and honest cancellation, proactive reminders under the interruption policy, and the extended security tests passing.

### M3, controlled execution and integrations

Extend from reading and preparing to bounded, authorized action and optional integrations. Entry points: A09 to A13 and A14 (A14 is optional transport, deferred unless a first-slice dependency proves otherwise), B06 (optional knowledge adapter, deferred on the same rule), B18 (embedding and index portability), C06 (Calendar actions), C11 (Trello actions), C13 (company knowledge permissions), C18 (optional consultation adapter), D15 and D16 (external task reconciliation, calibration), F05 (alternate speech fallback), F11, F12, F16, F17 (review surfaces, computer control, pairing, companion). Exit criteria: every effect passes the broker with a receipt, revocation and unknown outcomes are handled, and the companion works as a controller without holding authority.

### M4, portability and polish

Close the seams that need evidence or a decision. Entry points: F14 (optional wake phrase, gated on a measured energy delta), F18 (Windows port seam and conformance guide). Exit criteria: the wake-word decision is recorded as enable or defer with numbers, and a conformance guide exists for a non-Mac host.

## Track map

An epic's phase is the milestone at which its stated outcome exits, not the earliest or the latest child leaf. A later extended or optional leaf can sit in a later milestone without moving the epic: E05 exits at M1 while its action leaves extend to M3, E09 exits at M2 with the minimal notification baseline pulled into M1, and E02 exits at M3 with its reliability baseline in M1.

- E01 Runtime and local execution (master A, phase M0, leaves A01 to A08): the service stack record, shared contracts, service, store, jobs, providers, tool turns and receipts.
- E02 Harness supervision and operational reliability (master A, phase M3, leaves A09 to A18): supervise existing harness sessions safely, plus diagnostics, the first daily-loop integration gate and measurement.
- E03 Evidence and durable recall (master B, phase M1, leaves B01 to B09): source identity, transcript originals and resolution, gists, recall, preferences, suppression, export and forget.
- E04 Evolving personality and memory quality (master B, phase M2, leaves B10 to B18): consolidation, context compilation, the public persona spec, private customization, learning with provenance and evaluation.
- E05 Accounts and work sources (master C, phase M1, leaves C01 to C11): the user's own accounts, with Google, chat and Trello read and prepare adapters.
- E06 Authority and optional company integrations (master C, phase M1, leaves C12 to C18): grants, the effect broker, egress policy, the capability registry, adverse tests, revocation and the optional company adapter.
- E07 Commitments and daily planning (master D, phase M1, leaves D01 to D09): commitments with evidence, prioritization, planning, reminders and conversation control.
- E08 Proactive follow-through (master D, phase M2, leaves D10 to D18): interruption policy, asynchronous progress, replanning, follow-ups, calibration, sleep and offline behavior.
- E09 Mac conversation surface (master E, phase M2, leaves F01 to F09): hotkey, text and voice conversation, barge-in, reconnection, voice character and notifications.
- E10 Installability, computer control and companion portability (master E, phase M3, leaves F10 to F18): onboarding and grants, review surfaces, computer control, lifecycle, wake word, packaging, companion and portability.
- E11 Portable assistant service and cloud deployment (master A, phase M4, leaves A19 to A24): the command, query and progress seam, the container and runbook, secret references, backup, restore and rehearsal, suite endpoints and the hosting boundary.
- E12 Channels, authority epochs and device grants (master C, phase M3, leaves C19 to C23): the channel inbox and outbox, channel identity separate from account identity, one active authority epoch, device grants with pulled intents, and revocation with offline delivery.
- E13 Responsive and mobile client surfaces (master E, phase M2, leaves F19 to F23): the responsive browser shell, the shared web UI host inside the Mac companion, the shell-only cache and offline policy, the Android access path and cross-breakpoint conformance.

Phase counts: M0 has 12 work items, M1 has 40, M2 has 17, M3 has 19, and M4 has 2.

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

The validator derives labels from node fields so the published issues cannot drift from the backlog: `kind:program`, `kind:epic` and `kind:task`; `master:A` to `master:E` on epics and leaves; `phase:M0` to `phase:M4`; `priority:P0` to `priority:P2`. Milestones carry the same five stage IDs with the descriptive titles above. The program tracker has no master label. Published totals are 119 roadmap issues plus one separate plan-delivery issue used only by the documentation pull request; the tracker `P00` is never auto-closed by it.

## Where to start

Read [the P00 program tracker](https://github.com/PEAT-AI/lux-didi/issues/1) first: its body names the five lanes and the entry point for each milestone. Then [parallel-masters.md](parallel-masters.md) for ownership and start packets, [architecture.md](architecture.md) for the invariants, and [decisions.md](decisions.md) for the choices already made and the questions still open. The stable-ID to issue-number mapping is in [planning/issue-map.json](../planning/issue-map.json). The separate first-night execution plan is [overnight-execution.md](overnight-execution.md); it is proposed and does not change the issue scope.

## Revision record

- PLAN-R1 (2026-10-09): the service stack is recorded as TypeScript on Node with SQLite, a Swift Mac
  companion and a responsive browser client, with the same service running on loopback now and on a
  Linux virtual machine later. New work: E11 portable assistant service and cloud deployment (A19 to
  A24), E12 channels, authority epochs and device grants (C19 to C23), E13 responsive and mobile client surfaces (F19 to F23). Existing IDs, titles where already published and every existing
  dependency edge are preserved. A01 now records the stack and the superseded Swift prototype instead
  of an open comparison. Totals move from 101 nodes to 119, from 10 epics to 13, and from 90 work
  items to 105. The validator derives those totals from the node set rather than from a literal, and
  V-14 proves the derived checks still reject a broken plan.

- PLAN-R3 (2026-10-09): the four review findings are adopted. Observed publication metadata and
  milestone identifiers are preserved while the staged projection stays separate; the phone proof is
  scoped to a phone-width laptop proof tonight with no physical-phone connectivity claim; an
  unavailable old host never triggers an automatic authority transfer, which now requires a
  demonstrated fence plus a separate-store partition and resume acceptance. The ruling also records
  first-party Naya reuse, one shared web UI hosted in a web view with a native-only control surface,
  and the concise source-linked context economy. New leaf: F23. Totals move to 120 nodes and 106 work
  items.
