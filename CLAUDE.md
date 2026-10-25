# Lux Didi: repository mechanics

Lux Didi is Naya's local Mac application: Swift native owners, a Node host and a TypeScript web interface; this public repository's runtime ownership is mapped in [docs/architecture.md](docs/architecture.md).

| If you need | Read |
| --- | --- |
| Product, install or first call | [README.md](README.md), [docs/user-guide.md](docs/user-guide.md) |
| Development and check prerequisites | [docs/local-development.md](docs/local-development.md), [docs/checks.md](docs/checks.md) |
| Release and installation | [docs/releases.md](docs/releases.md), [docs/macos-install.md](docs/macos-install.md) |
| Source/tool or write authority | [docs/connectors.md](docs/connectors.md), [docs/tool-owner.md](docs/tool-owner.md), [docs/privacy-and-authority.md](docs/privacy-and-authority.md) |
| Voice, text or native integration | [docs/live-call.md](docs/live-call.md), [docs/text-chat.md](docs/text-chat.md), [docs/native-app.md](docs/native-app.md) |
| Private character or provider configuration | [docs/owner-profile.md](docs/owner-profile.md), [docs/provider-configuration.md](docs/provider-configuration.md) |
| Safe operational evidence | [docs/debugging.md](docs/debugging.md), [docs/diagnostic-store.md](docs/diagnostic-store.md) |

## Stack and layout

| Layer | Location | Version authority |
| --- | --- | --- |
| Native app | `Sources/LuxDidi/`, `Resources/` | `Resources/Info.plist`, canonical native producer |
| Host and shared contracts | `server/host/`, `server/contracts/` | `server/package.json`, `server/package-lock.json` |
| Persistent owners | `server/runtime/`, `server/domain/`, `server/chat/`, `server/live/`, `server/tools/` | Owning migrations and TypeScript contracts |
| Provider and source adapters | `server/adapters/`, `server/connectors/`, `server/config/` | Locked dependencies and validators |
| Shared UI | `web/src/`, `web/public/` | `web/package.json`, `web/package-lock.json` |
| Synthetic verification | `server/test/`, `web/test/`, `Tests/`, `scripts/check-*.sh` | [Check catalog](docs/checks.md) |

## Commands and routing

- When preparing a checkout, install committed dependencies with `npm --prefix server ci` and `npm --prefix web ci` rather than changing lockfiles to repair a local tool gap.
- When building the source-run application, use `bash scripts/run-local.sh --build-only` and follow [local development](docs/local-development.md) for an isolated foreground host.
- When checking a managed change, run the declared controller check for the affected owner rather than bypassing it with a direct producer or unrelated suite.
- When checking current documentation hygiene, use `bash scripts/check-docs.sh`, which checks dashes and home-path patterns but does not replace semantic privacy or symbol review.
- When compiling Swift, enter through the canonical producers and `scripts/with-compile-lock.sh` rather than invoking a parallel `swiftc` path.
- When running browser-backed proofs, satisfy the selected producer's installed-browser and `lux-browser-slot` prerequisites rather than downloading a browser or bypassing its lease.

## Ownership constraints

- When changing persistence, keep `Store` in `server/runtime/store.ts` as the writer and compose mutations/effect intents in the caller's transaction rather than opening another database owner.
- When touching audio, keep hardware in `AudioOwner` (`Sources/LuxDidi/AudioOwner.swift`) and never change system devices, volume or another application's routing.
- When changing orb behavior, preserve its visual design unless the owner explicitly authorizes a visual change.
- When changing launch behavior, preserve `LaunchKind.autoConnects` in `SingleInstanceGuard.swift` so only an interactive launch auto-connects.
- When adding a source read, use `CONNECTOR_DESCRIPTORS` and the canonical tools owner rather than approving tools in a renderer or treating MCP discovery as authority.
- When changing a write path, preserve the separate local-memory, dictated-note, confirmed composed-note and board-scoped Trello gates described in [tool owner](docs/tool-owner.md) rather than granting generic remote-write authority.
- When changing prompt or tool guidance, update the corresponding `scripts/check-prompt.sh` assertions and behavior-focused evidence rather than relying on a string change alone.
- When testing provider, connector or effect behavior, use fakes and synthetic records rather than real accounts, microphones, credentials or owner content.
- When adding diagnostics, pass closed fields through `safeEvent` in `server/host/log.ts` rather than logging exception messages, arguments, titles or transcript text.
- When authoring public artifacts, exclude real credentials, private profiles, board names, account content, private machine paths and long dashes, and review semantics in addition to the `check-docs.sh` pattern gate.
- When changing a public contract, update its owning guide in the same change and point copied schemas back to the source validator.

## Branch, review and release

- When proposing a change, target `main`, keep source and owning documentation together, and use [docs/checks.md](docs/checks.md) for the applicable gates rather than copying a changing check count here.
- When packaging a candidate, use `scripts/build-asset-bundle.sh` and `scripts/build-macos-app.sh` rather than creating another bundle layout or compile identity.
- When installing or exercising the owner's app, obtain explicit authorization before any launch, quit, relaunch or real-account probe.
- When a candidate is reviewed, leave merge and installation decisions to the maintainer and follow [docs/releases.md](docs/releases.md), since a merged source commit is not proof of the installed runtime.
