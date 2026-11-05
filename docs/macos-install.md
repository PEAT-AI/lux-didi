# Build and install on macOS

Lux Didi's native application targets Apple silicon and macOS 26 or newer (`LSMinimumSystemVersion` in `Resources/Info.plist`). Building requires the Xcode Command Line Tools, Node 26 and npm. The installed application bundles its Node runtime; it does not depend on a terminal's PATH to start its host.

## Build a complete application

From a clean, committed checkout:

```sh
npm --prefix server ci
npm --prefix web ci
bash scripts/build-asset-bundle.sh /tmp/didi-assets
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
```

`build-asset-bundle.sh` builds the service and web assets and obtains the checksum-verified bundled Node. `build-macos-app.sh` is the canonical native producer; it signs nested executable code before signing and verifying the completed app. Its Swift compile goes through `scripts/with-compile-lock.sh`. Do not create a second compile path or add `COMPANION_TEST` to a production app.

The runtime descriptor, `Contents/Resources/didi-runtime.json`, binds the bundle to its service, web root and release source. An arbitrary successful Swift compile is not a complete installable product. Keep build output outside the source tree, and do not reuse an output path containing unrelated files.

The producer also accepts `--install-id`, `--release-commit` and `--cache`; consult its usage in `scripts/build-macos-app.sh` before constructing release automation. [Releases](releases.md) owns the release flow and installed-source verification.

## Local signing

To preserve a stable local code requirement across rebuilds, create the local identity once:

```sh
bash scripts/create-signing-identity.sh --dry-run
bash scripts/create-signing-identity.sh
```

The second command changes the owner's login keychain and prints the trust command the owner must review and run. It is an interactive owner step, not a test prerequisite to perform silently. The builder can fall back to ad-hoc signing with a warning; an ad-hoc code hash changes on rebuild and can invalidate macOS permission grants. Local signing is not notarization or proof of cross-Mac Gatekeeper acceptance.

## Install an already built app

```sh
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
```

The installer validates the app, preserves the previous app as a uniquely named rollback sibling, swaps the new bundle and restores the old bundle if post-swap validation fails. It does not delete or reseed the owner's state. It does not configure providers, install connector helpers or sign in to accounts.

## Build the checkout before running one installed check by itself

The installer then runs every `scripts/check-installed-*.sh` against the app it just installed, and one failure puts the previous app back. That sequence runs in file name order, so `scripts/check-installed-connectors.sh` runs before `scripts/check-installed-open-web.sh`, and the connectors check builds `server/dist` itself when `server/dist/host/mcp.js` is missing or older than the sources. A fresh checkout therefore reaches the compiled files before the check that imports them runs, so the installer does not need you to build first.

Running one of those checks by itself is different. `scripts/check-installed-open-web.sh <target>` imports `server/dist/test/live-voice-fixture.js` from your checkout, and in target mode it does not build. Build once first:

```sh
npm --prefix server ci
npm --prefix web ci
bash scripts/run-local.sh --build-only
```

Without that build the open-web check fails on the missing compiled fixture when you run it on its own. The same build also skips the slower automatic build the connectors check would otherwise do during an install.

Do not clear quarantine or use a force-install workaround to turn a failed validation into apparent success. Read the installer error and [debugging.md](debugging.md).

## Select protected configuration

Create and populate the owner's configuration outside the application bundle, then select the existing directory:

```sh
"$HOME/Applications/Lux Didi.app/Contents/MacOS/LuxDidi" --configure \
  --config-dir /absolute/private/config
```

The same command accepts `--owner-profile /absolute/private/profile.json`. `OperatorSettings` in `Sources/LuxDidi/OperatorSettings.swift` owns validation and the selection store. Targets must be explicit absolute paths of the right type, safely owned and outside an app bundle. A rejected target prints `DIDI CONFIGURE: invalid target` without echoing private content.

An omitted field is preserved: selecting a configuration directory must not silently drop an existing owner-profile selection. This selects paths; it does not generate credentials, repair unsafe files or enable network access. See [provider-configuration.md](provider-configuration.md), [mcp-configuration.md](mcp-configuration.md) and [owner-profile.md](owner-profile.md) for those inputs.

## First launch

An interactive Finder or Dock launch can start one call automatically. Login and installer relaunches do not. For automation that relaunches after an install, use the dedicated launch kind:

```sh
open -g -a "Lux Didi" --args --install-relaunch
```

That command is an owner or installer action, not permission for a worker to launch the installed app. [User guide](user-guide.md) covers permissions, sign-in and the first call. [Local runtime](local-runtime.md) owns state and log locations.

## Verification limits

[Checks](checks.md) documents the native and installer checks. Those checks exercise synthetic configuration and packaging boundaries; they do not prove real provider keys, microphone hardware, Google consent or a healthy installed account. A source release is not an assertion that every existing installation has already been upgraded.

### Required real-call receipt

A green install requires the real-call receipt in addition to the helper-provider
smoke. See [checks.md](checks.md#installed-real-provider-canary-paid-receipt-required).
Installed checks still run with the app down and report `canary=pending_after_relaunch`.
The initial installer phase emits PENDING, not final PASS. The installer lane then
relaunches the exact installed bundle and runs these two steps:

```bash
bash scripts/run-installed-canary.sh "$HOME/Applications/Lux Didi.app"
bash scripts/install-macos-app.sh --verify-canary "$HOME/Applications/Lux Didi.app"
```

The first step makes one real call, using only the owner's read-only opt-in asks
from `~/.lux/didi-canary/asks.json`. No hard-coded replacement ask is used. It writes
`~/.lux/didi-canary/receipt.json` atomically with metadata only. The artifact binds
the exact resolved bundle path plus `installId` and `releaseCommit` from that app's
`Contents/Resources/didi-runtime.json`; it cannot approve a different installed
build. A new canary attempt invalidates the old receipt before preflight.

The second step reads and verifies the artifact; it does not make another call.
Missing, stale and red receipts fail with `canary_receipt_missing`,
`canary_receipt_stale` and `canary_red`, respectively. Only a matching green receipt
allows `INSTALL-MACOS-APP PASS ... canary=task_tool_and_task_settled`. Neither script
launches the app. A provider turn or lifecycle completion without a task tool and
complete findings is red. Output is tool, outcome, reason code and milliseconds,
never owner words. The receipt names `canary_shutdown_timer` for expiry caused by
the canary's own timer, or `clean_close` for normal cleanup; revocation behavior is
unchanged.
