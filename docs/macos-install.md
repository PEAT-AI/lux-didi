# Building and installing the Mac app

Requirements: Apple silicon, macOS 26 or newer (`LSMinimumSystemVersion`), the Xcode Command Line Tools, and Node 26 plus npm to build. The app bundles its own Node 26 (default 26.8.2, checksum-verified). Every check named here is described in [checks.md](checks.md).

One canonical producer builds the native shell and, optionally, composes an
accepted asset bundle into a single `.app`. Production is built **without**
`COMPANION_TEST`. The build and the install are separate steps.

## Build

```
scripts/build-macos-app.sh "<output>/Lux Didi.app" \
  [--assets DIR] [--install-id UUID] [--release-commit 40hex] [--cache DIR]
```

- The native compile identity (flags, `-parse-as-library Sources/LuxDidi/*.swift`,
  `Resources/Info.plist`, entitlements) is fixed in this producer and reused by
  `Tests/DidiMacTests/check-mac.sh`; there is no second compile/identity path and
  no duplicate `Info.plist`, entitlements or launcher. `Resources/AppIcon.icns` is
  copied to `Contents/Resources/AppIcon.icns` and named by `CFBundleIconFile`, so
  the Dock tile and the app switcher show the Naya icon.
- `--assets DIR` composes the output of `scripts/build-asset-bundle.sh`:
  - `DIR/Resources/node/bin/node` goes to `Contents/MacOS/node`
  - `DIR/server/node_modules/@lux-didi/service` goes to
    `Contents/Resources/server/node_modules/@lux-didi/service`
  - `DIR/Resources/web/dist` goes to `Contents/Resources/web/dist`
  - `Contents/Resources/didi-runtime.json` is written with `nodePath`
    `Contents/MacOS/node` (bundle-relative), `serverEntry`
    `server/node_modules/@lux-didi/service/dist/host/index.js`, `webRoot`
    `web/dist`, `schemaVersion` 1, and the real bundled Node major. The app
    validates it on every launch.
- Nested Mach-O code (bundled Node and any `.node`/`.dylib`) is signed first and
  the completed bundle last, then `codesign --verify --deep --strict`.

## Install

```
scripts/install-macos-app.sh "<built>/Lux Didi.app" --to "$HOME/Applications"
```

Installs an already built and verified app into an explicit user-local
Applications target. It validates before swap, preserves the prior app as a
uniquely named `Lux Didi.app.rollback-<UTC>` and restores it if post-swap
validation fails. It never deletes or reseeds user data, never uses `--force`,
and never touches an unrelated application. It does not create or migrate MCP or Live configuration, install connector servers,
or grant network access. Existing configuration files and symlinks remain untouched.

### Exact install command

```
scripts/install-macos-app.sh "/path/to/Lux Didi.app" --to "$HOME/Applications"
```

## First launch after an install

An installer or script that relaunches the app should pass `--install-relaunch` (for example `open -g -a "Lux Didi" --args --install-relaunch`). That launch shows the orb, takes no focus and never connects a call, so an install can never open the microphone. A launch by hand from Finder or the Dock is the interactive kind and connects once by itself. App state lives in `~/Library/Application Support/ai.peat.lux-didi` and the selected configuration directory is recorded in `ai.peat.lux-didi-operator`.

## Protected operator configuration

Configure the existing native executable; there is no second writer language,
no new UI and no in-app editor.

```
"$HOME/Applications/Lux Didi.app/Contents/MacOS/LuxDidi" --configure \
  [--config-dir /abs/dir] [--owner-profile /abs/file.json]
```

- Store: `~/Library/Application Support/ai.peat.lux-didi-operator/settings.json`,
  directory `0700`, file `0600`, closed key schema
  (`schemaVersion`, optional `configDir`, optional `ownerProfilePath`).
- Rules: absolute targets, correct type (dir/file), owned by the current user,
  not group/world writable, outside any `.app` bundle, no symlink at the target.
  A refusal prints `DIDI CONFIGURE: invalid target` and exits `2`, with no path
  or content in the message.
- **Update semantics**: an omitted field is preserved. Changing only
  `--config-dir` never drops a configured owner profile, and vice versa. There is
  no clear/reset grammar yet.
- Launch reads the store only: absent keeps the public default, valid forwards
  `--config-dir`/`--owner-profile` to the existing host entry, invalid refuses
  before any child is spawned. No ambient discovery, no hot reload, no secrets in
  argv. The server keeps credential/profile validation, snapshots and policy.

## Checks

- `scripts/check-macos-install.sh`: composes the real app and drives it through
  LaunchServices (no external descriptor, bundled Node only), plus signatures,
  artifact hygiene, the configure matrix and install/rollback.
  Status and P1/P2 replay assertions remain in the installer script. A private,
  nonce/PID/service/stage-bound observation holds the same owned host until those
  actual authenticated requests succeed; only then does the observer forward
  completion. Failed requests/assertions cancel and join cleanup without losing
  their exit status. Runtime negatives exercise the real native gate, including
  post-release premature acknowledgement, wrong/stale/duplicate acknowledgement,
  cancellation/EOF and an actual HTTP assertion failure. This adds no public
  endpoint, ordinary-launch hold, configuration authority or longer deadline.
- `Tests/DidiMacTests/check-mac.sh`: native shell proof.
- `Tests/DidiCompanionTests/check-companion.sh`,
  `Tests/DidiCompanionTests/check-launch-services-probe.sh`: companion and
  LaunchServices proofs.

## Limits

Owned installed connections use the existing strict private host credential file
directly, so native rebuilds do not depend on a Keychain item's code-hash permission.
Each native request validates the same live owned connection and file bytes.
An unsafe or changed file retires that connection and requires explicit Reconnect;
a new owned start accepts the current valid file. External descriptor connections
retain their Keychain authority. Existing Keychain items are not migrated or changed.
The schema2 installed proof records the actual canonical-file source and validation,
with observed child cleanup rather than an invented Keychain import/cleanup claim.
Changed-executable upgrade acceptance requires two meaningful fresh-process runs
with preserved installId, config and state; a signature check alone does not prove it.

The first artifact is a local, ad-hoc-signed prerelease. Same-Mac relocation is
not cross-Mac Gatekeeper acceptance; quarantine is never cleared and paid
signing/notarization are later work. Real provider/Google/voice parity is
unproven and not claimed by the synthetic fixtures.
