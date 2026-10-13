# Lux Didi

Lux Didi is a Mac-first local assistant in early development: a warm, direct and witty companion with a voice, durable private recall, proactive follow-through on the commitments a person actually makes, and authorized local control. It is designed to be useful when installed alone on one Mac with one Google account, and to become more useful, never dependent, when optional Lux or company integrations are connected.

## Status: local Mac prerelease

This tree contains a locally packaged, ad-hoc-signed Mac app with bundled Node,
the authoritative TypeScript service and the shared web client. It is an early
prerelease, with synthetic checks and separate real-account and hardware gates.
It is not a notarized public release or a proven clean-machine installation.

- `server/` owns the SQLite store, local notes, memory and commitments. It serves
  the web client on loopback and composes connected chat, MCP tools and Live when
  their profiles and required authority are configured.
- `web/` contains the same-origin client, connected conversations, tool evidence,
  memory controls and read-only Settings. It stores no private records in browser
  storage and makes no external font, analytics or CDN requests.
- `Sources/LuxDidi/` contains the menu-bar app, service supervision, native web
  view, local Save note and Send to Naya actions, microphone/audio integration,
  Getting started, shortcuts, notifications and protected operator settings.

Installation owns the application bundle only. It preserves existing owner
configuration and creates no provider profiles, connector catalogs or network
grants. A fresh unconfigured app can save local notes and memory; connected chat
and Live need explicit setup. Model and connector configuration is selected using
the existing protected `--configure --config-dir` command.

See [the user guide](docs/user-guide.md), [Mac installation](docs/macos-install.md),
[implementation status](docs/implementation-status.md) and
[local development](docs/local-development.md). The repository has no hosted CI
workflow; canonical checks are in `scripts/`.

## Package boundaries

The service is the only store writer. The native and web clients use its local
API. `server/` is an ESM TypeScript package requiring Node 26 or newer, with the
MCP dependency bundled. The Mac producer bundles Node, service and web assets
into one app. The native sources compile with the Xcode Command Line Tools.

## Reuse and provenance

Reuse in this tree is bounded and recorded. It is not a claim about future reuse.

- `web/src/orb-classic.ts` retains a bounded set of first-party procedural drawing helpers adapted from the public PEAT-AI/Vicuna repository at an immutable revision, under an explicit reuse ruling. The exact source line ranges, the deliberate adaptations and the exclusions are recorded in `web/src/orb-provenance.md`. That note records provenance, not an invented public licence for the original repository.
- `server/prompt/index.ts` implements stable section order, local hashes and whole-record selection adapted from verified Naya compiler mechanics. Its public persona content is new generic Didi content, not a copy of a private persona, profile or lore.
- Third-party notices live in `web/public/third-party-notices.txt` and `server/adapters/mcp/SDK-LICENSE.txt`.

## Vision (direction, not current state)

A Mac-first local assistant that:

- opens from a global hotkey and holds a voice or text conversation;
- remembers past sessions locally and can explain where a claim came from;
- turns calendar, mail, chat and transcript commitments into prepared, authorized follow-through;
- carries a specified, Naya-inspired character without copying any private persona or prompt;
- acts on the user's own accounts under explicit, revocable grants, and reports honest uncertainty when an effect may already have happened;
- treats model providers as replaceable ingredients, with Gemini preferred, not required;
- integrates optionally with Lux Knowledge, Mongoose, Lux Coworker, Trello and Mattermost, and with an existing harness only later, as an optional bridge.

Local data and local control are the default. Local does not mean offline: approved cloud inference is part of the design.

One authority per assistant is the rule behind that list. There is a single canonical conversation and memory authority, the service store; adapters such as model providers and MCP tools are optional and never required; account and resource access is scoped to explicit grants. Only the first of those shapes is implemented today.

## First loop (target, not current state)

The first real-user slice is the acceptance target for milestone M1. A person installs an early build from a clean account (Stage A, an ad-hoc local pilot), connects one Google account, presses the hotkey, and asks by text while voice is enabled as soon as the transport works. Didi reads the upcoming calendar, captures or infers one commitment with its evidence, schedules one useful reminder, opens the conversation from the notification, prepares an unsent reply, recalls the exchange in a later session, and, once resolved, never resurrects it. Lux, the harness and Trello are not required. **The first release is this local Mac app with its optional connection set** - the native companion, Lux Knowledge, and the mail and other providers each user chooses to connect - while the **harness bridge is optional and comes later**, after a usable app. There is **no web-only release**: no web-only tag and no web-only publication.

None of that loop is complete on `main`. The part that runs today is the local store and commitment loop described in [docs/implementation-status.md](docs/implementation-status.md).

## Roadmap and backlog

The structured plan is [planning/backlog.json](planning/backlog.json): 120 nodes, one program tracker (P00), thirteen epics (E01 to E13) and one hundred and six work items (A, B, C, D and F leaves) across five implementation lanes. The plan is published as GitHub issues with stable IDs, labels, milestones and dependency links, and the mapping is recorded in [planning/issue-map.json](planning/issue-map.json). The narrative plan is [docs/roadmap.md](docs/roadmap.md).

The only executable artifact for the plan itself is the planning validator, which checks the backlog and its documents for internal consistency: unique IDs, acyclic dependencies, complete epic coverage, resolved relative links and publication hygiene.

```sh
python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md
```

It validates the plan. It does not test the product; product verification is carried by the service, web and host checks named in [docs/local-development.md](docs/local-development.md).

## Documents

- [docs/implementation-status.md](docs/implementation-status.md): what is implemented on `main`, what current `main` integrates, what is only on branches, and what is unresolved.
- [docs/local-development.md](docs/local-development.md): prerequisites and the exact build, start, data, pairing, check and stop commands for the current baseline.
- [docs/architecture.md](docs/architecture.md): the decided stack plus the proposed components, data flow and concrete invariants.
- [docs/roadmap.md](docs/roadmap.md): milestones, tracks, dependency order and the first slice.
- [docs/parallel-masters.md](docs/parallel-masters.md): lane ownership, start packets and the change protocol.
- [docs/research.md](docs/research.md): primary sources, options and evidence limits.
- [docs/privacy-and-authority.md](docs/privacy-and-authority.md): accounts, egress, tool trust and authority rules.
- [docs/acceptance.md](docs/acceptance.md): synthetic acceptance scenarios and explicitly proposed budgets.
- [docs/decisions.md](docs/decisions.md): adjudicated choices and deferred proof questions.
- [docs/risks.md](docs/risks.md): material risks with triggers, mitigations and owners.
- [docs/overnight-execution.md](docs/overnight-execution.md): the reviewed first-night execution plan (proposed; target selection pending).
- [docs/cloud-deployment.md](docs/cloud-deployment.md): the designed path from the loopback service to a Linux virtual machine, with runbook, credential, backup and hosting-boundary rules.
- [docs/client-service-contract.md](docs/client-service-contract.md): the contract the Mac companion, the browser client and the channel adapters share.

## Run the local developer baseline

Prerequisites: Node **26 or newer** and npm installed on macOS (the currently verified development host). From the repository root, install the locked dependencies, build the service and web client, and start the composed product host in the foreground:

```sh
npm --prefix server ci && npm --prefix web ci && bash scripts/run-local.sh --port 0
```

The existing wrapper builds both packages before starting one loopback host on an available port. It prints the origin and availability status; use the local pairing flow in [local development](docs/local-development.md) to open the web client. That page also covers explicit state/config directories, separate builds, baseline versus feature checks, and stopping the host with Ctrl-C. `npm --prefix server start` remains the supported lower-level standalone service, not this composed product bootstrap.

This is a source-checked developer command, not a freshly exercised clean-install walkthrough or an installed application. It does not bundle Node, configure a model/provider, grant OS permissions or install a Mac app. With no provider profile, inference remains disabled. See [provider configuration](docs/provider-configuration.md) for the separately authorized setup.

Build/runtime do not require the managed browser harness. Browser-backed feature proofs currently require an installed Playwright Chromium **and the managed-host `lux-browser-slot` lease tool**; npm dependencies alone do not provide that tool. An unmanaged public browser-proof alternative is future work, not an implemented fallback. See [browser proof prerequisites and artifact destinations](docs/local-development.md#browser-proof-prerequisites-and-artifact-destinations).

## If you have five minutes

Start with the developer baseline above, then [the P00 program tracker](https://github.com/PEAT-AI/lux-didi/issues/1) and [docs/roadmap.md](docs/roadmap.md). The detail of any single work item lives in its issue, and the backlog file is the machine-readable source.

## What this repository is not

- It is not a licence grant for any pre-existing private code. No private source, prompt or fixture is copied here, and any reuse decision carries its own licence and notice review first.
- It contains no credentials, no personal data, no private endpoints and no internal record identifiers.
- It does not promise that any advertised capability already exists. Claims are labelled as proposals, source claims or observations, and the research page states what has not been measured.
- It is not an installed product. There is no installer, no notarized application, no cloud deployment and no mobile pairing here. The current local Mac development path has an explicit Node 26 prerequisite, because Node is not bundled.

## Evidence discipline

The planning wave behind this repository used three labels: OBSERVED (evidence from a live system), SOURCE CLAIM (documentation or source of record) and PROPOSED (design intent). This repository repeats that discipline. Where a number appears, it is a target proposed for a later spike or measurement issue to falsify, never a measured result. The status and development pages state plainly which statements are source cross-checks and which are still unproven, and [docs/research.md](docs/research.md) lists the sources and the open evidence gaps while [docs/acceptance.md](docs/acceptance.md) says how the first loop will be judged once it is built.
