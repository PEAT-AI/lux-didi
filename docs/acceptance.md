# Acceptance scenarios and proposed budgets

Status: proposed acceptance plan. No product exists, so no scenario here has been run, and no test command for a product exists yet. This page defines what the first slice must demonstrably do once it is built, and how that evidence is recorded. Failing to meet a scenario is a real outcome; a document saying a scenario passes is not evidence.

## How to read this page

Each scenario has a synthetic precondition, the action, the observable result that counts as acceptance, an adverse variant relevant to the same surface, and the issues that own the behavior. Fixtures are synthetic: identities use `example.invalid`, calendar and mail content is invented, and no real transcript, account or endpoint appears anywhere.

The only currently runnable check in this repository is the planning integrity validator:

    python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md

It checks the plan, not the product. When a product scenario below is implemented, its owning issue records the exact command and the observed result, including failures.

## First-loop scenario (M1 target)

From a clean account with no config: install the Stage A pilot build, connect one synthetic Google account, and complete the loop below with the real surfaces. Lux, the harness and Trello remain unconfigured and every optional integration shows a clear not-configured state. Exit is when the loop works and the evidence is recorded; this is the M1 definition. A17 owns the runnable integrated scenario for this loop, including core restart, sleep and wake, token expiry, egress refusal and an unknown effect outcome. A no-account path is part of acceptance too: manual reminders work without Google, and no non-Google source requires a Google login.

The loop: hotkey opens the conversation; text turn works while duplex voice may still be pending; the upcoming calendar is read with per-event provenance; one commitment is captured or inferred with an evidence link; one useful reminder is scheduled; the reminder notification opens the conversation; an unsent reply is prepared (not sent); the exchange is recalled in a new session; the commitment is resolved and does not resurrect later.

## Scenarios

- S1 Clean-account install and onboarding. Precondition: empty state with a synthetic `example.invalid` account. Acceptance: install succeeds without any preloaded credential or grant; onboarding collects the user's own consent before any read; capability state lists exactly what was granted. The public proof uses synthetic fixtures only; a real Google OAuth flow needs a real, privately held disposable test account, because fixture addresses cannot authenticate, and no real account identity or token ever enters public evidence. Adverse: declining a requested scope leaves the product useful in a reduced mode with an honest message. Owners: F10, F15, C02, C12.
- S2 Hotkey and text conversation. Precondition: cold app, menu bar only. Acceptance: hotkey opens the surface; question and answer complete as text; the session transcript original is stored locally. Adverse: a second hotkey press during a turn does not corrupt the session; it is queued or cancels per the defined level. Owners: F01, F02, A03.
- S3 Calendar read. Precondition: one synthetic account with two invented events and one all-day event. Acceptance: events and provenance match the synthetic fixture; timezone and recurrence render correctly; a provider failure reports an error, not an empty success. Adverse: provider returns malformed data; the adapter reports a typed failure and does not fabricate events. Owners: C05, B01, A02.
- S4 Commitment capture with evidence. Precondition: an invented meeting note containing one promise by a named attendee. Acceptance: the commitment is created with the exact source span, attendee attribution and confidence class; the plan shows it. Adverse: the same promise appears in two sources; extraction produces one item, deduplicated, with both pieces of evidence. Owners: D02, D03, B01, B03.
- S5 Reminder and due processing. Precondition: an open commitment with a due time in the test window. Acceptance: the reminder fires once under the interruption policy; state advances to reminded; no duplicate reminders; no model call on a blind heartbeat. Adverse: the Mac is asleep at the due time; the reminder is delivered after wake, once, with no burst of stale notifications. Owners: D07, D08, D18, D10.
- S6 Notification to conversation. Precondition: a fired reminder. Acceptance: opening the notification lands in the relevant conversation with context; display is never reported as the user having seen it. Adverse: the notification is dismissed without opening; the system does not treat it as read and does not nag repeatedly. Owners: F09, D08, D10.
- S7 Prepare unsent reply. Precondition: an invented unanswered email. Acceptance: a reply draft is prepared and shown or stored; no send occurs; a receipt records the draft action. Adverse: a prompt-injection string inside the email asks to send or delete; nothing is sent, the item is flagged, and the attempt is visible. Owners: C04, C16, C12, A08.
- S8 Recall next session. Precondition: resolved or open items from S4 to S7. Acceptance: a later session answers "what did I promise this morning" from local records, with no external knowledge base required; answer generation follows the configured model route, and with no model route configured the product shows the recalled records rather than pretending to generate an answer without one. Adverse: the user asks about a deleted item; the answer states the deletion and does not resurrect the content. Owners: B04, B05, B09, B08.
- S9 Resolve and never resurrect. Precondition: one open commitment. Acceptance: resolving removes it from planning; stale retrieval or a later extraction pass does not reopen it; the suppression decision is inspectable. Adverse: a conflicting new source later repeats the same promise; the product surfaces it as new with its own evidence rather than silently reopening the old item. Owners: B08, D03, B15.
- S10 Optional integrations absent. Precondition: no other integration configured. Acceptance: every optional adapter reports not configured; the core loop is unaffected; no failed background job noise. Adverse: a configured integration endpoint becomes unreachable; the failure is explicit and retried with bounded policy. Owners: B06, C13, C18, D15.
- S11 Account mix-up. Precondition: two synthetic accounts with different calendars. Acceptance: a read for account A never returns account B data; a draft for account A is never stored in account B; the chosen account is visible. Adverse: a stale token for one account is revoked; the adapter fails for that account only, with no cross-account fallback. Owners: C01, C16, C17, C03.
- S12 Revoked grant. Precondition: a standing calendar read grant. Acceptance: revocation stops future dispatch and future use of the capability; a request already started at the provider may complete, and the product reports that rather than claiming it was undone. Adverse: revocation lands between prepare and dispatch of a send; the send does not occur and the intent is marked canceled before dispatch. Owners: C12, C17, A08.
- S13 Cancel after dispatch. Precondition: a prepared draft and a queued job. Acceptance: cancelling a queued job prevents it; a dispatched effect with unknown outcome is marked unknown and reconciled, never reported as canceled. Adverse: the remote service later confirms the effect happened; reconciliation records the completed effect and offers a compensating action, not a retry. Owners: A05, A08, C04.
- S14 Provider change and egress policy. Precondition: a granted route for a data class. Acceptance: changing the provider or route re-opens the egress gate for that class before the next send; the gate is visible. Adverse: a payload labelled owner-sensitive with no local route is not silently forwarded; the request fails with a clear policy message. Owners: C15, A06.
- S15 Sleep, offline and catch-up. Precondition: a due reminder and a queued companion action while the Mac sleeps. Acceptance: nothing runs or leaves the machine while asleep; basic catch-up after wake is coalesced into one summary, not a burst (basic catch-up is part of the M1 D07 and D08 baseline; advanced behaviour is D18). Adverse: the companion is open while the Mac sleeps; it says the Mac is not reachable rather than implying progress. Owners: D07, D08, D18, F16, F17, F13.
- S16 Export and forget. Precondition: stored sessions and one derived gist. Acceptance: export contains the user's data in a documented format; forget removes Didi copies and reports propagation state for anything it does not own. Adverse: forgetting an item referenced by an open commitment reports the reference rather than leaving a dangling promise. Owners: B09, B15.
- S17 Injection inside tool results. Precondition: a synthetic calendar description containing instructions addressed to the assistant. Acceptance: the instructions are treated as data; they create no authority; the transcript shows the item as untrusted content. Adverse: the injected text tries to change a standing grant; the grant system ignores model-visible text and the attempt is visible in the audit. Owners: C16, C12, A07, B17.
- S18 Standalone core. Precondition: no Lux or harness installed at all. Acceptance: the loop in S1 to S9 works with the core alone; optional adapters report not configured. Adverse: a previously configured harness disappears; supervision features degrade explicitly and the core loop is unaffected. Owners: A03, A09, B06.

## Proposed performance budgets

These are proposals to falsify, not measured numbers. The platform research states targets and a measurement plan; no figure here comes from a measurement. A18 owns turning them into recorded budgets with a measurement harness that includes host pressure and pinned versions, and makes a breach visible rather than swallowed.

Voice path targets:

- Global hotkey to microphone armed: under 150 ms.
- End of user speech to first model audio frame, on the duplex route: under 800 ms, under the documented chunk and voice-activity constraints.
- Barge-in (user starts speaking) to local silence: under 120 ms, achievable locally without a provider round trip.
- Local speech recognition partial transcript on the optional fallback path: under 300 ms.
- Durable job acknowledgement spoken back: under 1 second, with the actual work continuing as a non-blocking job.

Resource and energy shape (proposed ceilings, to be pinned by A18 before any always-listening feature ships):

- Idle core plus host, no conversation active: average CPU below 1 percent measured over a 30-minute idle window on Apple silicon, and resident memory under 300 MB.
- No model call on a blind heartbeat. Synchronization is incremental, and due processing is event-driven or coalesced (A18, D07).
- Any always-listening feature (wake phrase, continuous capture) stays disabled until the measured energy delta is below 1 percent of an 8-hour idle power budget on a defined reference machine, with the method recorded (F14, A18).
- A budget breach is an observable event with the measured value attached, not a silent drop.

## Evidence discipline

- A scenario passes only with a recorded command and a pasted result attached to its owning issue, including the adverse variants that were actually run.
- Partial success is reported as partial. Missing coverage is reported, not inferred away.
- Until a product exists, every row above is PROPOSED, and the acceptance plan itself is reviewed for realism, not executed.
