# Roadmap

The first stable release is merged in [PR #683](https://github.com/PEAT-AI/lux-didi/pull/683). [Implementation status](implementation-status.md) describes what that source provides; this page separates follow-up work from shipped behavior. It is not a delivery schedule or a promise that every historical proposal will be built.

## Follow-up areas

| Area | Current boundary | What still needs its own evidence |
| --- | --- | --- |
| Voice resilience | `LiveSessionOwner` in `server/live/index.ts` includes recovery | Remaining provider-error and real-network failure cases need targeted evidence, not a blanket claim that recovery cannot fail |
| Installation and distribution | `scripts/build-macos-app.sh` and `scripts/install-macos-app.sh` build and install locally | Cross-Mac distribution, signing and notarization need a separately verified release path |
| Account onboarding | Existing connector setup and browser consent flows | A universal sign-in experience must not be claimed for helpers that still use their own account authorization commands |
| New effects | Read-only registry connectors, narrowly gated Trello and note writes | Sending mail, arbitrary computer control or additional remote writes require explicit authority design, implementation and tests |
| Portability | The current application is a Mac app | Other operating systems and multi-owner hosting require their own product and authority contracts |

These are boundaries for future decisions, not evidence that a feature exists. A new capability is documented as shipped only after its code and acceptance evidence are on the release branch.

## How to update this page

When a change ships, move its user-visible behavior to the owning guide and link it from [implementation-status.md](implementation-status.md). Keep setup instructions in [user-guide.md](user-guide.md), check routing in [checks.md](checks.md), and release mechanics in [releases.md](releases.md). Do not restore a second list of hardcoded release numbers, migration counts or tool schemas here.

The original milestone and track plans remain historical material under [history/](history/README.md). Their old planning identifiers and completion graph are not the current installation contract or a substitute for checking source.
