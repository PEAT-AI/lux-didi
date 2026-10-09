# Material risks

Status: proposed risk register for the plan. Each risk names a trigger that would make it real, the mitigation already built into the plan, and the issues that own it. None of these risks is a prediction; they are the failure modes the plan deliberately works against.

- R-01 The recorded service stack is not validated by measurement. Trigger: a later measurement contradicts the TypeScript on Node with SQLite service, or the Superseded Swift prototype turns out to hold a capability the companion cannot reach. Mitigation: A01 records the stack and the superseded prototype explicitly; A19 keeps the seam behind a versioned contract so a placement or runtime change is a seam change, not a rewrite; the companion keeps the native surfaces. Owners: A01, A19.
- R-02 Account mix-up: a read or draft silently uses a different account than the user chose. Trigger: tokens stored per tool rather than per account, or the account inferred from context. Mitigation: per-account OAuth with credential-store storage; explicit account for send and commit; account mix-up is a named adverse test. Owners: C01, C16, F10.
- R-03 Prompt injection through mail, chat or tool results causes an unauthorized effect. Trigger: untrusted content instructs the model to send, delete or change a grant. Mitigation: reasoning and tool text never create authority; draft-only default; the broker checks grants at dispatch; injection containment tests. Owners: C16, C12, A07.
- R-04 A dispatched action has an unknown outcome and is misreported as canceled or repeated. Trigger: cancellation after dispatch, or a timeout with no response. Mitigation: receipts, an explicit unknown-outcome state, reconciliation before any retry, and undo as a compensating action. Owners: A08, A05.
- R-05 A resolved, cancelled or forgotten item resurrects from stale retrieval. Trigger: background extraction or cache replay reopens a closed item. Mitigation: suppression overlays consulted before planning; correction and forgetting track projections; a stale-resurrection adverse test. Owners: B08, D03.
- R-06 Google OAuth policy blocks the intended distribution model. Trigger: verification requirements, the 100-user cap on unverified apps, restricted-scope assessment, or refresh-token expiry in testing status. Mitigation: a per-installation client in the user's own Cloud project is one option for a personal pilot, subject to the policy of the distribution chosen; it is not a preselected universal distribution exemption, and the chosen path is disclosed to the user. Owners: C02, C15, F10.
- R-07 Restricted-scope content reaches a hosted inference route without an assessment. Trigger: the egress rule is absent or over-permissive for a data class. Mitigation: route-class gate on first egress of a data class; the operator verifies provider terms; a local model does not settle the question by itself. Owners: C15, F10.
- R-08 An always-listening feature ships without honest energy or privacy evidence. Trigger: wake phrase or continuous capture enabled before measurement. Mitigation: F14 is gated on a measured energy delta under the proposed ceiling; no claim of Focus bypass or perfect privacy is made. Owners: F14, A18.
- R-09 The companion promises proactive work while the Mac sleeps. Trigger: copy or design implies overnight execution. Mitigation: nothing executes or sends while the Mac sleeps; the companion queues with an honest message; Q-08 keeps the always-on host open. Owners: F16, F17, D18.
- R-10 Public distribution stalls on signing, notarization or update identity. Trigger: Stage B needs an owner and a spending decision. Mitigation: the Stage A ad-hoc pilot is the M1 target and is explicitly not claimed as frictionless public installation; Stage B is a separate decision. Owner: F15.
- R-11 A provider change silently alters the egress or retention posture. Trigger: the provider or route changes after a grant. Mitigation: a provider change re-opens the egress gate for the affected class; A06 keeps providers replaceable and budgets configured. Owners: C15, A06.
- R-12 Harness integration overstates its authority. Trigger: the adapter tries to steer or cancel without a harness-granted contract. Mitigation: observation-only until a scoped contract exists; no direct state writes and no global override; A11 owns the boundary. Owner: A11.
- R-13 Same-user process isolation is overclaimed. Trigger: the risk surface is described as isolated because a helper process runs separately. Mitigation: the plan states that a process split is an authorization chokepoint, not isolation, and that broad local control carries residual risk. Owners: A13, F12.
- R-14 Private code, prompts or fixtures leak into the public repository. Trigger: reuse or copy without licence review, or residual personal data in examples. Mitigation: no reuse assumption; per-component licence and notice review; synthetic identities; the planning validator scans for private shapes and the reviewer judges content. Owners: A01, B12.
- R-15 Memory grows without bound or retention expectations are unstated. Trigger: consolidation and retention rules unmeasured. Mitigation: consolidation, retention and inspector work in B10 and B15; raw audio defaults to discard after transcript confirmation. Owners: B10, B15, B09.
- R-16 Performance and battery claims are made without measurement. Trigger: documentation or copy quotes the proposed budgets as achieved. Mitigation: budgets are labelled proposed; A18 builds the measurement harness and makes a breach visible; no figure is quoted as measured until recorded. Owner: A18.
- R-17 The plan drifts from the issues it publishes. Trigger: documents and backlog edited independently. Mitigation: the validator checks counts, IDs, graph, labels and links; the issue map ties stable IDs to published numbers; the reviewer checks the exact revision. Owner: P00.
- R-18 Optional integrations become hidden requirements. Trigger: a loop silently depends on Lux, the harness or Trello being configured. Mitigation: optional adapters degrade to not configured; the first-slice acceptance runs with none configured; standalone install is an acceptance scenario. Owners: B06, C13, D15, F10.
- R-19 Urgent interruption copy promises more than the platform allows. Trigger: UI or marketing text implies bypassing Focus or guaranteed delivery. Mitigation: the interruption policy owns the classes; copy claims are bounded by the entitlement actually available; display is not treated as seen. Owners: D10, F09.
- R-20 The first slice grows until it cannot ship. Trigger: scope pressure adds send, delete, wake word or public distribution to M1. Mitigation: the first slice is fixed in the roadmap and acceptance documents, with what it deliberately excludes named. Owners: P00, F10, D06.
- R-21 A model call reaches a provider before its route policy resolves. Trigger: a new data class, provider path or tool is added without passing the entry gate. Mitigation: A06 is the single safe model-call entry and default-denies while policy is missing; completion of source-content cloud paths waits for C15; egress refusal is an acceptance scenario. Owners: A06, C15.
- R-22 An expired or revoked grant leaves stale silent data or a dead account. Trigger: token expiry, user revocation, or a testing-status refresh-token expiry. Mitigation: C02 stops ingestion for the account and shows the coverage gap and reauthorization state; C17 propagates revocation; scenarios S11 and S12 cover it. Owners: C02, C17.

- R-23 Cloud and laptop both write at once. Trigger: an operator starts the virtual machine without
  transferring the authority epoch. Mitigation: an epoch token on every write path, a single-writer
  lock that makes a second instance refuse to start, and an explicit transfer procedure. Owners: C21,
  A20.
- R-24 A revoked device acts on a stale intent. Trigger: intents queued without expiry, or a replay
  accepted. Mitigation: scoped expiring intents with a nonce, a revocation epoch that expires queued
  items, and a device-side grant check before any effect. Owners: C22, C23.
- R-25 Private data cached on a shared or stolen browser. Trigger: a serviceworker caches a query
  result or a progress payload. Mitigation: shell-only cache policy, sign-out clears the partition,
  and a test that asserts zero cached private payloads. Owners: F20, F19.
- R-26 A cloud process acquires local authority by implication. Trigger: a deployment grants the
  service device or operating-system capability, or a channel message is read as authorization.
  Mitigation: the hosting boundary statement, device grants that are separate and device-enforced, and
  channel identities that cannot act unbound. Owners: A24, C22, C20.
- R-27 Credential sprawl on a host. Trigger: a secret value copied into an image, a configuration
  file, an environment dump or a log. Mitigation: references only, a resolver at call time, and image
  and log scans in the acceptance path. Owners: A21, C15.
- R-28 Hosting cost surprise. Trigger: a host left running or an egress loop that repeats. Mitigation:
  no host without an explicit authorization, a runbook that records teardown, and default-deny egress.
  Owners: A20, A24.
- R-29 A channel message is treated as identity proof. Trigger: a binding learned from conversation or
  a verified address promoted into authority. Mitigation: explicit binding only, and an unbound
  identity that can be read but cannot act. Owners: C20, C19.
