# Lux Didi

Lux Didi is the planning home for a Mac-first local assistant: a warm, direct and witty companion with a voice, durable private recall, proactive follow-through on the commitments a person actually makes, and authorized local control. It is designed to be useful when installed alone on one Mac with one Google account, and to become more useful, never dependent, when optional Lux or company integrations are connected.

## Status: planning repository

This repository holds a public plan, not a product. There is no application, no installable build, no dependency manifest and no workflow here yet. Every behavior described in these pages is proposed until an implementation issue records evidence for it.

The build plan lives in [planning/backlog.json](planning/backlog.json) as 101 nodes: one program tracker, ten epics and ninety work items across five implementation lanes. When the plan is published as GitHub issues, the same material is browsable with stable IDs, labels and milestones, and the program tracker `P00` is the entry point. The published mapping from stable IDs to issue numbers is recorded in `planning/issue-map.json`. The published totals are 101 roadmap issues plus one separate plan-delivery issue referenced only by the documentation pull request, so `P00` is never auto-closed by it.

The only executable artifact in this repository is the planning validator, which checks the backlog and the documents for internal consistency: unique IDs, acyclic dependencies, complete epic coverage, resolved relative links and publication hygiene.

    python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md

It validates the plan. It does not test a product, because none exists.

## Vision (short)

A Mac-first local assistant that:

- opens from a global hotkey and holds a voice or text conversation;
- remembers past sessions locally and can explain where a claim came from;
- turns calendar, mail, chat and transcript commitments into prepared, authorized follow-through;
- carries a specified, Naya-inspired character without copying any private persona or prompt;
- acts on the user's own accounts under explicit, revocable grants, and reports honest uncertainty when an effect may already have happened;
- treats model providers as replaceable ingredients, with Gemini preferred, not required;
- integrates optionally with Lux Knowledge, Mongoose, Lux Coworker, Trello, Mattermost and an existing harness.

Local data and local control are the default. Local does not mean offline: approved cloud inference is part of the design.

## First loop

The first real-user slice is deliberately small. A person installs an early build from a clean account (Stage A, an ad-hoc local pilot, at milestone M1), connects one Google account, presses the hotkey, and asks by text while voice is enabled as soon as the transport works. Didi reads the upcoming calendar, captures or infers one commitment with its evidence, schedules one useful reminder, opens the conversation from the notification, prepares an unsent reply, recalls the exchange in a later session, and, once resolved, never resurrects it. Lux, the harness and Trello are not required.

## Documents

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Proposed components, data flow and concrete invariants |
| [docs/roadmap.md](docs/roadmap.md) | Milestones, tracks, dependency order and the first slice |
| [docs/parallel-masters.md](docs/parallel-masters.md) | Lane ownership, start packets and the change protocol |
| [docs/research.md](docs/research.md) | Primary sources, options and evidence limits |
| [docs/privacy-and-authority.md](docs/privacy-and-authority.md) | Accounts, egress, tool trust and authority rules |
| [docs/acceptance.md](docs/acceptance.md) | Synthetic acceptance scenarios and explicitly proposed budgets |
| [docs/decisions.md](docs/decisions.md) | Adjudicated choices and deferred proof questions |
| [docs/risks.md](docs/risks.md) | Material risks with triggers, mitigations and owners |

## What this repository is not

- It is not a licence grant for any pre-existing private code. No private source, prompt or fixture is copied here, and any reuse decision carries its own licence and notice review first.
- It contains no credentials, no personal data, no private endpoints and no internal record identifiers.
- It does not promise that any advertised capability already exists. Claims are labelled as proposals, source claims or observations, and the research page states what has not been measured.
- It does not claim a frictionless public install. Public distribution (code signing and notarization) is a later stage with its own ownership and spending decision.

## Evidence discipline

The planning wave behind this repository used three labels: OBSERVED (evidence from a live system), SOURCE CLAIM (documentation or source of record) and PROPOSED (design intent). This repository repeats that discipline. Where a number appears, it is a target proposed for a later spike or measurement issue to falsify, never a measured result. See [docs/research.md](docs/research.md) for the sources and the open evidence gaps, and [docs/acceptance.md](docs/acceptance.md) for how the first loop will be judged once it is built.
