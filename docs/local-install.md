# Explicit local development install

This is a target-specific macOS development artifact, **not** a self-contained,
Developer ID signed, notarized or universal distribution. It requires an existing
Node **26** executable, including its installed dylibs. Node is not copied into the
bundle. Build and install never launch the application, provision secrets, request
OS permissions, contact providers, register login items or change global state.

## Prerequisites and current acceptance boundary

The accepted source must provide `server/host/index.ts` and COMPANION's installed
`didi-runtime.json` reader. Earlier descriptor-only native source is not sufficient.
An absent capability stops packaging explicitly; there is no standalone-service or
fake-native fallback. Capability detection is only a missing-input check, not a
substitute for real relocated native/service startup proof. Full acceptance awaits
the owning accepted noninteractive installed proof contract. The original base
without those capabilities cannot produce an accepted install.

Use a clean exact 40-hex source HEAD, existing Xcode command-line tools, explicit
Node 26, an explicit existing npm CLI script and an existing populated offline npm
cache. The producer uses committed `server/package-lock.json` and
`web/package-lock.json`, `npm ci --offline --ignore-scripts`, the actual TypeScript
and Vite compilers, and the existing native Swift/entitlement contract. Missing
cache entries or compiler failures are errors, not reasons to download or install
global dependencies. Service production dependencies alone are shipped; source,
source maps, tests, dotenv/private state and all symlinks are excluded/refused.

## Build outside the checkout

Substitute **existing absolute paths** for these placeholders. `--help` documents
both CLIs. `node` below is build/installer tooling, not the service runtime lookup.

```sh
node scripts/package-local.mjs --help
node scripts/install-local.mjs --help
node scripts/package-local.mjs --check-prerequisites --source-commit <clean-HEAD-40hex>
node scripts/package-local.mjs \
  --source-commit <clean-HEAD-40hex> \
  --node /absolute/existing/node26 \
  --npm-cli /absolute/existing/npm-cli.js \
  --npm-cache /absolute/existing/offline-cache \
  --output /outside/checkout/didi-artifact
```

The producer stages a git archive of the exact clean HEAD outside the checkout,
compiles there, copies only explicit outputs/production dependencies, probes Node
under a scrubbed environment (realpath, executable, actual version, SQLite query,
dylib linkage and executable hash), signs the complete bundle ad hoc with the
existing entitlements, and verifies `codesign --verify --strict`. Failure removes
only its owned staging directory and never overwrites an existing artifact.

Output contains `LuxDidi.app` and `artifact.json`. The sidecar records source SHA,
lock hashes, the external Node prerequisite/identity, ad-hoc signing identity and
an exact directory/file/mode/hash inventory including code-signature resources.
The generated `Contents/Resources/didi-runtime.json` is machine-specific, not a
public configuration or committed file. Schema 1 contains `schemaVersion`, UUID
`installId`, 40-hex `releaseCommit`, absolute `nodePath`, `nodeMajor: 26`,
`serverEntry: "server/dist/host/index.js"`, and `webRoot: "web/dist"`. Native platform
APIs, not the installer, own the durable appdata location and secret bootstrap.

## Install explicitly (not authorized to the user's Applications in a test lane)

```sh
node scripts/install-local.mjs \
  --artifact /outside/checkout/didi-artifact \
  --destination /explicit/disposable/LuxDidi.app
```

Omitting `--destination` chooses `Applications/LuxDidi.app` under the current
platform-discovered home. Do **not** omit it in a worker/test lane. Validation
checks exact artifact inventory, source/runtime identity, external Node identity,
actual host/web resources, native bundle identifier and strict ad-hoc signature.
An existing unrelated/unverifiable app or receipt is refused unchanged.

`LiveInstance` means explicitly Quit the owned Didi application and wait for its
owned service's clean stop, then retry. The installer never kills anything. An
owned sibling lock serializes installs; an unknown pre-existing lock is refused,
not deleted. Installation copies into an owned sibling stage, preserves the
previous install UUID on reinstall, resigns the staged bundle, validates it again,
then activates by rename. Staging/validation failure leaves the old bundle and
receipt unchanged. The old verified release **and** its receipt are retained in a
unique sibling rollback directory; the new `<destination>.receipt.json` records
the actual outcome, identity, inventory and previous release location.

The installer never opens, deletes, resets or reseeds appdata. A retained binary
is not authorization for a schema/data rollback. Unknown newer schema is an
owning-service error; no unattended rollback command is provided. Secret bootstrap
and service supervision remain native/runtime responsibilities.

## Verification

`bash scripts/check-install.sh` is the declared check. It runs real filesystem,
Node/SQLite/dylib and signed executable fixture tests with disposable roots,
including refusal, install-identity preservation and unrelated-neighbor survival cases. The neighbor sentinel is not real Didi appdata and does not prove durable-record preservation. The test fixture is **not** the accepted
Lux Didi app/service. The check fails explicitly on missing accepted HOST/native
capabilities; no passing test-only run should be described as full installed
integration. Same-state installed-proof/reinstall/relocation wiring is prepared in
`Tests/DidiInstallTests/installed-proof.mjs`. COMPANION-R8 declares the normal
executable proof arguments `--installed-proof --proof-state <absolute-owned-state>
--proof-report <absolute-owned-report.json>`, wrapped in the installed shared
`lux-browser-slot run --wait 120 -- ...` renderer slot. The driver runs the first
installed bundle, requires actual app/service stop, reinstalls an independently
built same-source artifact with a different incoming UUID, checks preserved
installId, moves the bundle/receipt, and runs the relocated app with the **same**
owned proof-state directory. It never clears or reseeds that directory and adds
no data argument/responsibility to the installer.

Full preservation acceptance requires the actual accepted native/service to
write durable synthetic records on the first run and reopen/read the exact prior
record IDs/text on the second run, then clean-stop. COMPANION's current API does
not yet specify the exact durable reread report fields; an opaque JSON report or
exit 0 is not enough. The prepared driver therefore returns a pending acceptance
state, never fixture/record-preservation success. Accepted HOST/COMPANION and the
owning durable-record reread report contract must arrive before that final gate
can be completed. If native proof clears/reseeds instead of reopening, that is
an owning-native defect to report, not an installer workaround. UI proof, if later
required, uses the shared renderer slot, silent only, with no microphone,
notifications or OS dialogs. First user installation remains an explicit later
root action after acceptance.
