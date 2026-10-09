# Decisions and deferred questions

Status: accepted design directions with named owners. These decisions were taken during planning and are the defaults the implementation lanes start from. They are revisable when real source interfaces or measured evidence contradict them; the trigger for a revision is recorded with each item. Everything here is proposed behavior unless an implementation issue records evidence.

## Adjudicated choices

- D-01 One authoritative writer per entity or fact. Didi owns its operational sessions, jobs, action receipts, commitment lifecycle, notification state and voice transcript originals. External providers keep ownership of their originals; Didi's own caches and read models are projections, while an optional retrieval service or a company knowledge service keeps its own authoritative knowledge rather than becoming a projection of Didi. Database count is not a design objective. Owners: B01, C12.
- D-02 The core must install usefully alone, with local session recall and explicit preferences. An optional adapter exposes an external retrieval service without making a second authoritative copy. Typed explicit preferences always win in Didi behavior; a retrieved insight is evidence or history, never a second preference store. Owners: B06, B07.
- D-03 Every source reference carries provider, account, source identity, revision or hash where available, span where available, and coverage, freshness and availability. A cached authorized source is an explicitly versioned cache, never a new source authority. Owners: B01, B03.
- D-04 Resolved, cancelled and forgotten items are suppressed before planning, and background extraction cannot silently reopen them. Due dates are not deletion times. Correction and forgetting track derived projections and report pending propagation honestly; deleting a Didi memory does not claim deletion of an external source it does not own. Owners: B08, B09, D03.
- D-05 Storage origin (manual, user, automatic) is not factual authority. Explicit user statements, direct source observations and derived inferences are separate evidence classes, and an inferred item may enter a labelled queue under standing policy without an interrupt per item. Consequential external effects still require their own authorization. Owners: B17, D03.
- D-06 A host-owned deterministic action broker with per user, account, tool, action and resource grants, durable intents and receipts, credential references, and destination and data-class egress policy. Model or tool-discovery text creates no authority. Read, prepare and remind can run under standing grants; send, delete, pay and broad local execution need explicit user-granted capability. Outbound effects default to draft-only. Owners: C12, C15, A08.
- D-07 Cancellation is layered: stop playback, cancel a model turn, abort a running job, cancel queued jobs, end a session. Already-dispatched effects may have an unknown outcome and are reconciled. The product does not mark a possibly completed action as canceled or no-effect, does not blind-retry, does not promise exactly-once where the upstream lacks it, and treats undo as a separate compensating action. Owners: A05, A08.
- D-08 Mac sleep, closed and offline states are explicit product states. While the Mac is asleep nothing executes and nothing is sent. The product does not promise urgent alerts that bypass Focus without an entitlement it may not hold, and notification display is not proof the user saw anything. Owners: D10, D18, F09.
- D-09 Full transcripts are not assumed available from the private retrieval service; retrieval returns claims, spans and source metadata. Transcript originals are resolved through their providers when authorized, and missing coverage is reported rather than papered over with a summary. Owners: B03, B06.
- D-10 No model call on a blind heartbeat. Synchronization is incremental, due processing is event-driven or coalesced, and context is precomputed. Performance budgets are proposed targets to validate, never measured facts until a measurement issue records them. Owners: D07, A18.
- D-11 The existing harness owns delegated coding-worker lifecycle and admission. Didi owns simple durable product work queues and due timers, not a universal workflow engine. Ordinary calendar reads never route through a coding master. Owners: A09, A11, A12.
- D-12 No reuse assumption for any pre-existing private code, prompt or fixture. The public repository is not a licence grant. Any retained component carries a recorded licence and notice basis pinned to the release used, and review happens before reuse, not after. Owner: A01.
- D-13 MCP is an interoperability adapter, not the only internal API and not a permission system. Internal seams are local versioned contracts shared by host, core and adapters. A process split buys an authorization chokepoint, not isolation. Owners: A02, A14, C14.
- D-14 User interface belongs to the native experience lane. Other lanes expose services and view models. Shared contract changes are proposed to the runtime lane, which sequences migration files; other lanes use fixtures and never race a shared migration. Owners: E master, A02.
- D-15 Single safe model-call entry. No model call receives source content until its route policy resolves; the entry default-denies while policy is missing, and completion of source-content cloud paths waits for C15. Data handling must be decided before content moves, and availability is not a policy. Owners: A06, C15.
- D-16 Completion graph semantics. Every `depends_on` edge is a completion or integration prerequisite, never a prohibition on starting; lanes may begin against fixtures (see [parallel-masters.md](parallel-masters.md)), and there is exactly one graph. Owners: A02, A17.
- D-17 Shared mechanism ownership. A05 owns the durable task lifecycle, A08 owns action intent, receipt and reconciliation semantics, A15 owns the one transactional outbox, and D08 owns reminder intents and policy while consuming A15. No second retry queue exists. Owners: A05, A08, A15, D08.
- D-18 The quiet and urgency policy is a pure product contract with its baseline in M1 (D10), consumed by D07 and D08. F09 minimal native delivery and deep-linking is M1, and basic sleep catch-up belongs to the M1 baseline while advanced burst handling stays in D18. Owners: D10, D07, D08, F09.
- D-19 First daily-loop integration is owned by A17: the runnable end-to-end scenario, core restart, sleep, token expiry, egress refusal and unknown-effect cases, plus a lean local gate. No second test platform and no daily full-suite schedule. Owner: A17.

## Deferred proof questions

- Q-01 Which host shell wins: a thin native host with a local sidecar, a lighter web-shell host, or integrating the current pinned third-party host as a carrier? Owner A01, open; decided by the measured spike and the architecture decision record.
- Q-02 Is any third-party component retained, and under which licence and notice terms? Owner A01, open; per-component licence review before reuse.
- Q-03 Will the existing harness grant a scoped companion-controller contract for steer and cancel, or must a master delegate? Owner A11, blocked on that contract; observation-only until then.
- Q-04 Do persistent memory leaves declare their own storage dependency edges, or inherit coverage through the recall chain? Owners A04, B05. Resolved: persistent memory leaves now carry explicit A04 completion edges, and the integration validator checks phase order after the change.
- Q-05 Is a semantic embedding index needed at all, or is exact plus structured recall enough? Owner B18, open; measure before choosing.
- Q-06 Can an optional wake phrase meet the privacy and energy bar? Owner F14, deferred until a measured energy delta exists.
- Q-07 Who owns code signing, notarization and update identity for public distribution, and what does it cost? Owner F15 (Stage B), deferred; separate ownership and spending decision.
- Q-08 Is an optional always-on host offered, or only the local-first default? Owners F16, F17, open; no criterion may promise proactive work while the Mac sleeps until decided.
- Q-09 What data protection arrangements apply on each inference route? Owner C15, unverified; the operator verifies their own agreements, and the product claims nothing on their behalf.
- Q-10 Does the restricted-scope exemption reading hold for hosted inference routes? Owner C15, policy position held, not a verification outcome.
- Q-11 Does the transcript resolution leaf depend on the Drive resolver leaf, or do they meet at an interface? Owners B03, C07, open; interface-first is the recorded recommendation.
- Q-12 Is there exactly one suppression mechanism shared by commitments and memory? Owners D03, B08, open; a single mechanism is recommended.
- Q-13 Is a notification scheduled by an agent app delivered during sleep or only after wake? Owners F09, A18, unverified from documentation.
- Q-14 Is the critical-alerts entitlement available to a non-sandboxed Developer ID distribution? Owners D10, F09, unverified; the design must not depend on it.
- Q-15 Does the host own the provider socket, or does the sidecar? Owner A01, open; host owns microphone and playback with the sidecar owning session and jobs is the recommendation.
- Q-16 Is on-device speech recognition in the first release? Owner F05, open; the duplex provider already transcribes both directions.
- Q-17 Which urgency classes exist, and what may each one claim in copy? Owner D10, open; follows the interruption matrix.
- Q-18 Which identity and signing team should public builds use? Owner F15 (Stage B), open; affects shared permission grants and update trust.

## Options considered and rejected

- Real private mail or production traces in public fixtures. The plan uses messy synthetic fixtures shaped like provider data; an optional consented local replay stays private and is sanitized before any share. Historical model scores are not treated as modern performance ceilings, and no universal zero-hallucination claim is made.
- Cryptographic one-click approval buttons as a baseline notification prerequisite. Standing grants apply; a missing capability appears as a visible pending action with a review path, an operating-system notification click is not a grant, and there is no per-read confirmation or spam.
- Removing deferred M3 and M4 work from the roadmap. The complete future scope stays, clearly marked as deferred and not required for the first slice.
- Merging generic account identity with Google authorization. Other sources must install independently, so identity stays provider-neutral.
- Requiring a working prototype before publishing implementation issues. This session plans the work; proof tasks are explicit, and nothing is claimed complete.
- Treating a revised planning snapshot as a privacy incident or a proven defect. A revision requires a new review and hash, which is already part of the publication gate.

## Revisit trigger

Every decision above is revisited when a real source interface, a framework enforcement change or a measured result contradicts it. When a decision changes, the change is recorded here with the evidence that caused it, and the affected issue states what must be re-verified.
