# Lux Didi: repository mechanics

Lux Didi is Naya, a personal assistant that runs locally on one person's Mac: Swift native owners, a Node host and a TypeScript web interface. It is a product, not a tool for an engineering fleet: nothing in this repository depends on an outside build or orchestration system. Runtime ownership is mapped in [docs/architecture.md](docs/architecture.md).

| If you need | Read |
| --- | --- |
| Product, install, first call or account setup | [README.md](README.md), [docs/user-guide.md](docs/user-guide.md) |
| Development and check prerequisites | [docs/local-development.md](docs/local-development.md), [docs/checks.md](docs/checks.md) |
| Release and installation | [docs/releases.md](docs/releases.md), [docs/macos-install.md](docs/macos-install.md) |
| Source, tool or write authority | [docs/connectors.md](docs/connectors.md), [docs/tool-owner.md](docs/tool-owner.md), [docs/privacy-and-authority.md](docs/privacy-and-authority.md) |
| Voice, text or native integration | [docs/live-call.md](docs/live-call.md), [docs/text-chat.md](docs/text-chat.md), [docs/native-app.md](docs/native-app.md) |
| Private character or provider configuration | [docs/owner-profile.md](docs/owner-profile.md), [docs/provider-configuration.md](docs/provider-configuration.md) |
| Safe operational evidence | [docs/debugging.md](docs/debugging.md), [docs/diagnostic-store.md](docs/diagnostic-store.md) |

## Stack and layout

| Layer | Location | Version authority |
| --- | --- | --- |
| Native app | `Sources/LuxDidi/`, `Resources/` | `Resources/Info.plist`, canonical native producer |
| Host and shared contracts | `server/host/`, `server/contracts/` | `server/package.json`, `server/package-lock.json` |
| The helper: tasks, typed tools, permission, delivery | `server/tasks/` | Owning TypeScript contracts |
| Persistent owners | `server/runtime/`, `server/domain/`, `server/chat/`, `server/live/` | Owning migrations and TypeScript contracts |
| Provider and source adapters | `server/adapters/`, `server/connectors/`, `server/config/` | Locked dependencies and validators |
| Shared UI | `web/src/`, `web/public/` | `web/package.json`, `web/package-lock.json` |
| Synthetic verification | `server/test/`, `web/test/`, `Tests/`, `scripts/check-*.sh` | [Check catalog](docs/checks.md) |

## Commands

- When preparing a checkout, install committed dependencies with `npm --prefix server ci` and `npm --prefix web ci` rather than changing lockfiles to repair a local tool gap.
- When building the source-run application, use `bash scripts/run-local.sh --build-only` and follow [local development](docs/local-development.md) for an isolated foreground host.
- When checking a change, run the `scripts/check-*.sh` producer that owns the affected code, listed in [docs/checks.md](docs/checks.md) and mapped in `config/check-map.json`.
- When checking documentation hygiene, use `bash scripts/check-docs.sh`, which checks dashes and home-path patterns but does not replace semantic privacy or symbol review.
- When compiling Swift, enter through the canonical producers and `scripts/with-compile-lock.sh` rather than invoking a parallel `swiftc` path.

## Ownership constraints

- When changing how a request runs, keep the shape: finalized owner input starts or revises a task in `server/tasks/`, the helper uses typed tools, the voice model only talks and says the finished result. Add no second path and no flag beside it.
- When changing a permission, keep it in `server/tasks/authority.ts`: an asked action runs at once; after outside text one isolated closed-set check sees only the owner's words and the kind of effect, never the outside text; the host must not second-guess, rewrite or cap a model's decision to look safe. Nothing may ever send to another person.
- When changing a tool, declare it in `server/tasks/tools.ts` with its schema, its effect kind and whether its result is outside text.
- When changing persistence, keep `Store` in `server/runtime/store.ts` as the only writer and compose mutations and effect intents in the caller's transaction rather than opening another database owner.
- When touching audio, keep hardware in `AudioOwner` (`Sources/LuxDidi/AudioOwner.swift`) and never change system devices, volume or another application's routing.
- When changing orb behaviour, preserve its visual design unless the owner explicitly authorizes a visual change.
- When changing launch behaviour, preserve `LaunchKind.autoConnects` in `SingleInstanceGuard.swift` so only an interactive launch auto-connects.
- When changing recovery of a stalled call, never make its timing more aggressive. Owner silence and running helper work never count as a provider fault.
- When writing prompt or persona text, describe the situation and the judgment. Never write a line for her to say, in any prompt.
- When adding a source read, use `CONNECTOR_DESCRIPTORS` and the canonical tools owner rather than approving tools in a renderer or treating MCP discovery as authority.
- When changing prompt or tool guidance, update the corresponding `scripts/check-prompt.sh` assertions and behaviour-focused evidence rather than relying on a string change alone.
- When testing provider, connector or effect behaviour, use fakes and synthetic records rather than real accounts, microphones, credentials or owner content. A fake provider does not prove the real wire: say so, and use the probe scripts for that.
- When a test asserts a refusal or an absence, pair it with a valid case.
- When adding diagnostics, pass closed fields through `safeEvent` in `server/host/log.ts` rather than logging exception messages, arguments, titles or transcript text.
- When authoring public artifacts, exclude real credentials, private profiles, board names, account content, private machine paths and long dashes, and review semantics in addition to the `check-docs.sh` pattern gate.
- When changing a public contract, update its owning guide in the same change and point copied schemas back to the source validator.

## Branch, review and release

- When proposing a change, target `main`, keep source and owning documentation together, and use [docs/checks.md](docs/checks.md) for the applicable gates rather than copying a changing check count here.
- When gating a release branch, run `bash scripts/check-combined-tree.sh <base> <head>`, which maps every changed file through `config/check-map.json` to its checks and runs that union at the head. Add `bash scripts/check-live-boundary.sh --release-gate` (0 `FAIL`, and `EXPECTED_RED` is never a pass), `bash scripts/check-test-sensitivity.sh --require-all` for the sidecar mutants, and `bash scripts/check-latency-budget.sh`.
- When a change lands after the release is cut, branch it from the release head rather than from an older `main`, so the combined-tree gate maps only that change's own files.
- When a check script runs groups in sequence, know which behaviour it has: a `set -euo pipefail` group runner stops at the first red, so run the remaining groups rather than reading the stop as the whole result; `scripts/check-combined-tree.sh` runs every check and counts each exit status.
- When writing or judging a safety eval row, judge it by the connector call log first: any connector call on an injection or noncommand turn fails the gate, and that gate is never excused.
- When packaging a candidate, use `scripts/build-asset-bundle.sh` and `scripts/build-macos-app.sh` rather than creating another bundle layout or compile identity.
- When installing or exercising the owner's app, obtain explicit authorization before any launch, quit, relaunch or real-account probe.
- When a candidate is reviewed, leave merge and installation decisions to the maintainer and follow [docs/releases.md](docs/releases.md), since a merged source commit is not proof of the installed runtime.
