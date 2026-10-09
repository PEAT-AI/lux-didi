# Parallel masters: ownership, start packets and the change protocol

Status: proposed working agreement for the build. Five implementation lanes are planned, matching the five masters in the backlog. This document describes how they start, what each one owns, and how changes cross lane boundaries. It describes intended process, not a running organization.

## Lanes and ownership

- A runtime and portable service (E01, E02, E11) owns the service stack record, versioned contracts and fixtures, the loopback command, query and progress contract, deployment artifacts and runbooks, local service lifecycle, application store and migrations, durable jobs, model providers and budgets, tool-turn orchestration, action receipts, harness adapters, MCP transport, outbox, diagnostics, first daily-loop integration and measurement. It does not own voice character, memory semantics, account connectors, commitments or the user interface. Proposed paths: core/runtime, core/storage, core/jobs, adapters/harness, adapters/mcp-transport, contracts.
- B memory and persona (E03, E04) owns evidence and source identity, transcript originals, external resolution, recall, preferences, correction and suppression, consolidation, context compilation, the public persona specification, private customization and learning, the memory inspector and recall evaluation. It does not own account authorization, commitment planning, the companion surface or the browser client. Proposed paths: core/memory, core/persona, adapters/lux-knowledge, evals/memory, evals/persona.
- C accounts and trust (E05, E06, E12) owns account identity, channel inbox and outbox, channel identity binding, the authority epoch, device grants and offline delivery, OAuth and credential references, the Google, chat, Trello and company adapters, grants and the effect broker, the capability registry, egress policy, adverse security testing and revocation. It does not own commitment semantics, memory tables or the user interface. Proposed paths: core/policy, core/identity, adapters/google, adapters/mattermost, adapters/trello, adapters/mongoose, adapters/coworker, evals/security.
- D commitments and proactivity (E07, E08) owns the commitment lifecycle, extraction and attribution, deduplication and suppression integration, prioritization, planning, reminders and notification intents, interruption policy, follow-up, calibration and follow-through evaluation. It does not own notification rendering, memory storage or connector authorization. Proposed paths: core/commitments, core/planning, core/proactivity, evals/follow-through.
- E native experience and client surfaces (E09, E10, E13) owns the Mac companion, the responsive browser client, the shell-only cache policy, hotkey and menu bar, text and voice surfaces, audio devices, notifications, onboarding and grants review, computer control, lifecycle, packaging, companion pairing and portability. It does not own core storage, broker policy or commitment semantics. Proposed paths: apps/macos, adapters/voice, clients/mobile, platform.

Directories are proposed ownership seams, not a claim that the tree exists.

## Start packets

Each lane starts with the leaves that have no blocking dependency, then follows the graph. Every dependency edge is a completion or integration prerequisite, not a prohibition on starting: a lane may begin against another lane's fixtures, and the producer can be finished and tested against a consumer's fixtures in the meantime. A start packet is what a lane reads and does first; it is not permission to skip the contracts.

- Master A starts with A01 (service stack, client roles and licence boundary record) and A02 (versioned contracts and fixtures) in parallel. Read [research.md](research.md) and [architecture.md](architecture.md) before starting. A03, A04 and A06 may proceed side by side once the host decision or the contracts land. A08 and C12 are the first-loop prerequisites named by the program, so A schedules them early in M1 rather than as late hardening. A17 owns the first daily-loop integration and the lean validation gate, and it is the one place the whole slice is exercised together; no second test platform is created.
- Master B starts with B01 (evidence model), B12 (persona specification) and B17 (evidence classes), which are contracts and documents. B07 (preference authority) follows B01. Persistence work follows the store question: either explicit A04 edges or the recorded ruling described in [decisions.md](decisions.md).
- Master C starts with C01 (identity map) and C02 (OAuth foundations) while C14 (capability registry contract) defines the shared manifest. C12 (broker) is a first-loop prerequisite and is scheduled with A08, not deferred.
- Master D starts with D01 (lifecycle schema). Extraction (D02) follows the provider contract. Evaluation work (D17) uses fixtures and can run early.
- Master E starts with F01 (hotkey and menu bar shell) and the Stage A pilot path (F10 onboarding, F15 local install). Voice leaves follow the provider contract A06 and the voice adapter landed by A and E together.

## Change protocol

1. One writer per entity. Shared contracts are proposed to A, which owns their versioning and sequences migration files; other lanes work against fixtures and do not race shared migrations.
2. Schema changes are proposed by the owning lane; A sequences the migration file order. No lane writes another lane's tables or files.
3. Interface changes follow the contract package: a change is proposed as an issue (or a patch to the contract), reviewed by A and the affected lane, then versioned. Fixtures move with the contract.
4. A dependency change is an argument, not a preference. Add an edge only when a genuine blocking completion or integration deliverable exists; remove one only with evidence that completion no longer requires it. Starting work early against fixtures never removes the edge. The integration validator must stay green after either. All edges remain in the single `depends_on` graph.
5. The existing harness stays the only coding-worker scheduler. Didi adapters observe and, where a harness-granted contract exists, steer or cancel; they never write harness state directly.
6. User interface belongs to E. Other lanes expose services and view models, not screens.
7. Every implementation pull request carries its evidence: the command, the observed result and the limits. Documentation and issue bodies never claim a passing test that has not run.
8. No private code, prompt, fixture or endpoint moves into the public repository. Any reuse starts with a recorded licence and ownership review; a proprietary component stays a private dependency.
9. No credentials are committed, and no personal data appears in issues. Synthetic identities use `example.invalid`.
10. Issues are the unit of progress, and the program tracker P00 is the index. Reviewers do not approve their own work; the independent reviewer for the planning package is separate from the author.

## Integration cadence

- The planning validator in `scripts/backlog_validate.py` is the integrity gate for this package. It runs locally: `python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md`. Remote CI does not exist and is not added during planning.
- During implementation, each lane keeps its own tests green, and the train ring is the consolidated gate. Nothing in this repository adds a workflow to enforce that.
- Escalation: a lane that needs a decision records the question with two options and a default, and proceeds on the default unless the question changes user-visible authority. Deferred questions are listed in [decisions.md](decisions.md), each with an owner issue.

## Boundaries for everyone

- Work that touches the client shells waits for the service stack record in A01; the placement question (loopback or virtual machine) is settled too, so nothing waits on a further decision. Independent domain contracts, evaluations and adapter fixtures proceed in parallel against the A02 contracts, and nothing requires the chosen host in order to start.
- No promise of proactive work while the Mac sleeps. The companion queues with an honest message.
- No same-user process isolation claims; broad local control is an explicit capability with residual risk stated.
- No unilateral licence assumption; see [decisions.md](decisions.md) and the licence boundary in [research.md](research.md).
- No user mentions with the at sign, and no notifications to humans outside ordinary GitHub behavior.
