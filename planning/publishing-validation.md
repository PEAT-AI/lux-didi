# Observed roadmap publication validation

Observed UTC: `2026-10-09T19:38:08.527975+00:00`.
Accepted source ancestor: `a74ff1e955bb6ad3b7e29470e85f79c2d73f6cda`.

## Authorization and scope

Root explicitly authorized the accepted manifest's 19 creates, 20 updates and81 unchanged nodes on public `PEAT-AI/lux-didi`. Only publication metadata changes here; canonical bodies, renderer, validator, runtime, native and web source remain unchanged. No main push, settings changes, human messages or implementation-status changes.

## Full observed readback

| Evidence | Observed result |
| --- | --- |
| Roadmap nodes, exact titles/rendered body hashes/labels/milestones |120, zero mismatches |
| Existing roadmap identities preserved |101 |
| New unique stable-marker identities |19 |
| Tracker issues, excluding PRs |121 (including unchanged closed102) |
| Exact parent-child links |106 (90 retained,16 added) |
| Existing approved updates |20 |
| Unchanged baseline nodes |81 |
| New-body rerenders after actual numbering |11 |
| Labels / milestones |All reused; no new labels or milestones |

The accepted renderer generated all dependency/epic/child links from actual returned issue numbers, without string replacement. Exact complete body hashes verify the dependency trailers and links as well as canonical content. Parent lists were fetched for every epic and their complete pair set matched all106 expected links. Every mutation was individually re-read; a final paginated read fetched all issue/PR identifiers and all parent lists. Every original issue state was retained; closed102 remained closed with exact original title/body/labels/milestone. Existing comments were not changed.

## Observed identifiers

| Stable ID | Issue |
| --- | --- |
|A19 |[#104](https://github.com/PEAT-AI/lux-didi/issues/104) |
|A20 |[#105](https://github.com/PEAT-AI/lux-didi/issues/105) |
|A21 |[#106](https://github.com/PEAT-AI/lux-didi/issues/106) |
|A22 |[#107](https://github.com/PEAT-AI/lux-didi/issues/107) |
|A23 |[#108](https://github.com/PEAT-AI/lux-didi/issues/108) |
|A24 |[#109](https://github.com/PEAT-AI/lux-didi/issues/109) |
|C19 |[#110](https://github.com/PEAT-AI/lux-didi/issues/110) |
|C20 |[#111](https://github.com/PEAT-AI/lux-didi/issues/111) |
|C21 |[#112](https://github.com/PEAT-AI/lux-didi/issues/112) |
|C22 |[#113](https://github.com/PEAT-AI/lux-didi/issues/113) |
|C23 |[#114](https://github.com/PEAT-AI/lux-didi/issues/114) |
|E11 |[#115](https://github.com/PEAT-AI/lux-didi/issues/115) |
|E12 |[#116](https://github.com/PEAT-AI/lux-didi/issues/116) |
|E13 |[#117](https://github.com/PEAT-AI/lux-didi/issues/117) |
|F19 |[#118](https://github.com/PEAT-AI/lux-didi/issues/118) |
|F20 |[#119](https://github.com/PEAT-AI/lux-didi/issues/119) |
|F21 |[#120](https://github.com/PEAT-AI/lux-didi/issues/120) |
|F22 |[#121](https://github.com/PEAT-AI/lux-didi/issues/121) |
|F23 |[#122](https://github.com/PEAT-AI/lux-didi/issues/122) |

Actual numbers occupy104..122, but per-ID assignments differ from the prospective projection. All current map numbers/URLs/rendered hashes use actual identities. The historical projection remains explicitly historical. Per-node `observed` snapshots remain immutable pre-expansion rollback evidence; `publication_readback` records current state. The accepted renderer calls IDs absent from the old baseline “staged”; that is its historical comparison bucket, not an assertion that these published issues remain staged.

## Hash domains and rollback

Canonical SHA256 hashes describe accepted assembled node bodies. Rendered SHA256 hashes describe complete re-read published bodies rendered with observed identities (CRLF normalized to LF). Original per-node baseline snapshots were preserved byte-for-byte as JSON values. Full before bodies/metadata and before/after parent lists are retained at the root publication desk for rollback reporting; no deletion or automatic rollback was performed.

## Repository authority observations

The repository is public, under `PEAT-AI`, and the authenticated session has admin/push authority. Collaborator summary:23 total,6 admin and17 read. All103 baseline issue/PR identifiers were authored by Rob-van-B. Classic main protection GET returned404 “Branch not protected”; rulesets, including inherited rules, were empty. No protection or ownership settings were changed.

## Verification procedure and evidence location

Declared acceptance: `python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md`, executed only through the managed controller at the metadata commit. Its receipt/result is recorded in the external publication report; any generated report delta must be disclosed rather than committed outside scope.

Root release desk evidence: `observed-publication.json`, `before-snapshot.json`, `after-snapshot.json` and `report.md` in the assigned publishing report directory. Those snapshots record real command timestamps, actual API argv/statuses, durable create responses and zero final readback mismatches. No credential values or private content are included.

## Milestone counts (roadmap only)

- Controlled execution and integrations: 26
- Portability and polish: 9
- Proof and contracts: 14
- Useful daily loop: 45
- Voice and proactive beta: 26
