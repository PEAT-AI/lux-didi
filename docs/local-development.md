# Local development

How to build and run the host and web UI from source, for development. The installed app runs the same host, supervised by the Mac app; see [macos-install.md](macos-install.md) for that path. Commands here were read from the repository's scripts and manifests.

## What you are running

One process is the only writer. The host entry `server/dist/host/index.js` opens the SQLite store, composes the durable domain module, the chat service, the Live call core, the research layer and the connectors, serves the HTTP API and the built web client, all on the loopback interface. `scripts/run-local.sh` builds the web client and the service and then runs the host.

Without a voice profile and connectors, Live and connected chat are unavailable but local notes and memory work. With a profile validated locally, the host composes the voice provider adapter and the connectors named in the protected config directory. Audio capture and playback belong to the Mac app, not the host, so a host started by hand serves the web UI and API but has no microphone; use the installed app (or `scripts/smoke.sh`) for a real call.

## Prerequisites

- macOS. This is the only verified development host. The service code avoids Mac-only APIs and is intended to run on Linux, but the Linux path has not been exercised.
- Node 26.0.0 or newer, and npm. Both packages declare `"engines": {"node": ">=26.0.0"}`. Node is not bundled; you must install it yourself. The host used to write this page reported Node 26.8.2 and npm 11.19.1. The service relies on the built-in `node:sqlite`, which is release-candidate upstream, and on `node:http` for HTTP parsing, so there is no native add-on to compile.
- The Xcode Command Line Tools, only if you build the Mac shell. It is compiled with `xcrun swiftc` and ad-hoc signed with `codesign`.
- An installed Playwright Chromium and the managed-host `lux-browser-slot` lease tool, only for browser-backed checks. The lease tool is not an npm dependency. A public unmanaged browser-proof path is not implemented; see [browser proof prerequisites](#browser-proof-prerequisites-and-artifact-destinations). Neither prerequisite is needed to build or start the local host.

## Install

Install from the committed lock files only. Do not add dependencies to run this baseline.

```sh
npm --prefix server ci
npm --prefix web ci
```

Several checks install offline (`npm ci --offline`) from the npm cache. Warm it once with `bash scripts/warm-npm-cache.sh`, which fills the user cache (or the cache `npm_config_cache` points at) with every tarball locked in `server/package-lock.json` and `web/package-lock.json` and touches no `node_modules` in the repository.
Offline installs run through `scripts/npm-ci-offline.sh <dir>`: it runs the site's exact install, keeps npm's own output, exits non-zero, and never falls back to the network.
When that wrapper fails it prints one line naming the failing directory, npm's error code (for example `ENOTCACHED`), the missing `package@version` when npm names it, and the fix command `bash scripts/warm-npm-cache.sh`.

## Build

The supported build is the wrapper, which cleans this worktree's generated output and builds both packages with their canonical configuration.

```sh
bash scripts/run-local.sh --build-only
```

That removes `server/dist`, runs `npm --prefix web run build` (a `tsc --noEmit` type check followed by a Vite build) and then runs `server/node_modules/.bin/tsc -p server/tsconfig.json`.

The same steps are available directly in each package: `npm --prefix web run build`, `npm --prefix server run build` and `npm --prefix server run typecheck`.

The service build roots are enumerated in `server/tsconfig.json`: the runtime, HTTP, contracts, domain, host,
chat, config, prompt sources and the model and MCP adapters, the knowledge connectors and the live-voice adapter,
together with the test files those surfaces own (runtime, HTTP, MCP, host, chat, connected, knowledge-connector and
live-voice). The `server/chat` and `server/config` directories are build roots: the chat module owns the conversation
subscription and its durable accepted-turn schema, and the config module owns the provider profile the host validates
at startup.

## Start

Start the host in the foreground, against a private state directory of your choosing and the build you just produced:

```sh
DIDI_STATE_DIR="$PWD/.local-state"
DIDI_CONFIG_DIR="$PWD/.local-config"
bash scripts/run-local.sh --data-dir "$DIDI_STATE_DIR" --web-root "$PWD/web/dist" --port 0 --config-dir "$DIDI_CONFIG_DIR"
```

The wrapper builds and then runs, so it is safe on its own. For a two-stage launch that skips the rebuild:

```sh
bash scripts/run-local.sh --build-only
bash scripts/run-local.sh --run-built --data-dir "$DIDI_STATE_DIR" --web-root "$PWD/web/dist" --port 0 --config-dir "$DIDI_CONFIG_DIR"
```

`--run-built` reuses the previous build and does not check whether sources changed. After any source edit, use the
default path or repeat `--build-only`.

`--config-dir` (or `DIDI_CONFIG_DIR`) selects the provider profile directory; the portable default is
`<dataDir>/provider-config`. The host validates the profile at startup and fixes it for the process, so restart to
activate edits. The profile holds the provider, the model and a key reference; the key material lives in a separate owner-only
secret file (mode 0600) and is reread on each dispatch. The status line reports unconfigured, disabled, error (a safe code only), or
configured with provider and model. Configured means the profile is locally validated; this does not prove provider reachability. An unsupported adapter
model ID is a sanitized configuration error that never prevents the host from starting. With no profile the connected conversation stays unavailable.

The host prints its origin, then the availability line, for example that local memory and commitments are available and that notifications are not. The model line reports the profile state: unconfigured, disabled, or error with a safe code when no usable profile is present, and configured with the provider and model once a profile validates. To see the command line:

```sh
node server/dist/host/index.js --help
```

The low-level service entry, `npm --prefix server start`, runs `node dist/index.js`. That entry deliberately composes the service store and HTTP API without the domain module and reports that the domain is unavailable, so it is not the supported local path for memory or commitments. Use the host entry.

## Data, configuration and state

- `DIDI_STATE_DIR` or `--data-dir` selects the state directory. Without it, the host uses the platform application-data location: the `Lux Didi` subdirectory of the user's Application Support directory on macOS, `$XDG_DATA_HOME/lux-didi` on Linux, and the `Lux Didi` subdirectory of the user's local application data on Windows.
- `DIDI_WEB_ROOT` or `--web-root` selects the built web client; the default is a `web/dist` directory beside the checkout.
- `DIDI_PORT` or `--port` selects the port; the default is 8765, and `--port 0` asks the operating system for a free loopback port. Command-line options take precedence over the environment.
- `DIDI_DESCRIPTOR` or `--descriptor` selects the descriptor path.
- `DIDI_CONFIG_DIR` or `--config-dir` selects the provider profile directory; the portable default is
  `<dataDir>/provider-config`. See [provider configuration](provider-configuration.md) for the profile and key
  initialization and for the status values it reports.
- The store creates and uses a private `0700` data directory. The owner-only `admin-credential` file is `0600`, and the SQLite store keeps a single-writer lock. A competing writer fails loudly; there is no seed, reset or overwrite fallback.
- The host writes `host-runtime.json` (or the descriptor you named) as atomic `0600` metadata: `schemaVersion`, `origin`, `authorityEpoch`, `assistantId`, `pid` and `startedAt`. It contains no bearer. A descriptor may remain on disk after shutdown; it is not proof that the process is still running.

## Pairing a browser

The browser does not receive the admin credential. Pair it with a short-lived code instead, from a second terminal:

```sh
node server/dist/host/index.js pair --data-dir "$DIDI_STATE_DIR"
```

That command reads the existing owner-only credential at run time, checks the current service identity, and prints only a single-use pairing code. The code expires after five minutes. Open the exact origin the foreground host printed and enter the code into the pairing screen. The browser then holds an `HttpOnly`, `SameSite=Strict`, `path=/` session cookie, and keeps its CSRF token in memory rather than in persistent storage.

Never paste the admin credential into the browser, a URL, a shell command, a log or JavaScript. The host and service never print a bearer.

## Stop

Press Ctrl-C, or send SIGTERM, in the terminal that runs the host. The listener and the store close without deleting records. Restarting against the same state keeps authority, messages, commitment history and superseded reminder state.

## Checks

Every check is a script; [checks.md](checks.md) lists each one and what it covers. Run the ones that cover your change. `npm --prefix server test` is baseline runtime and HTTP coverage only. On a plain workstation the headless server and domain checks need only Node and the two `npm ci` steps above; browser-backed checks need the extras below.

### Browser proof prerequisites and artifact destinations

Browser-backed checks currently require installed Playwright Chromium and `lux-browser-slot`, the existing managed-host tool that serializes the shared GPU renderer. The connected, native-conversation and selected-memory producers retain that lease and their real screenshot assertions. Installing npm dependencies does not install the lease tool. An unmanaged public proof interface is future work; do not bypass the managed lease or assume a bare workstation can run these browser gates.

Those three proofs use the test-only `web/test/artifacts.mjs` helper. Optionally set the nonsecret `DIDI_ARTIFACT_DIR` to an **absolute directory path** before running a producer. The directory is created if absent, and each invocation creates a fresh `didi-proof-*` run directory underneath it, so even repeated checks of the same commit cannot overwrite prior evidence. With the variable absent, each invocation instead creates a new isolated run directory in the operating system's temporary directory. An empty, relative, malformed or unwritable supplied path fails loudly rather than silently falling back.

The helper prints the exact run root and screenshot directory before browser startup. Each proof retains its existing relative directory (`connected/screenshots`, `native-conversation-service/screenshots` or `memory-selection-ui/screenshots`) and commit-bound filenames. Screenshots and existing renderer metadata are retained for inspection; the helper never deletes a caller's existing root or prior evidence. Temporary storage may be reclaimed by the operating system, so choose an explicit root when durable retention is needed. This setting selects proof output only; it does not change application state or provider configuration.

The focused filesystem test is `node --test web/test/artifacts.test.mjs`. It verifies supplied/default root isolation and invalid/unwritable roots using only newly created test fixtures; it does not replace the real browser gates.

The historical planning validator is separate from product checks:

```sh
python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md
```

## Platform limitations

- macOS is the only verified platform. Linux shares the code path but is untested; there is no Windows package.
- Node must be installed to build and run from source. The built Mac app bundles its own Node 26; there is no notarized application, no cloud deployment and no mobile pairing.
- The Vite development server (`npm --prefix web run dev`) is useful for UI work, but it does not apply the production security headers, so use the host entry for real end-to-end behaviour.
- The host never touches audio devices; capture and playback are the Mac app's. It runs model inference only when a voice or chat profile is configured locally and the owner starts a call or grants a connected conversation.

## How this page was verified

Cross-checked against `scripts/run-local.sh`, `server/package.json`, `web/package.json`, `server/host/index.ts` and the `scripts/check-*.sh` producers at release 9 (6d60a00f).

### Companion gate failure evidence

Run `bash Tests/DidiCompanionTests/check-companion.sh` through the managed declared
check when working in a worker lane. The observer reports failing verification
guards to stderr with status values, not payloads or credentials. The gate always
exercises a no-launch forced-failure diagnostic before its real native checks.
On failure, `COMPANION FAILURE` and `REAL-HOST FAILURE` print retained work paths;
`PROOF-DIR` identifies the retained proof directory. Keep these directories while
reviewing `observer.json` and its named child logs. Successful runs remove their
disposable work as before. Failure status is propagated unchanged.

The companion gate selects Node from the accepted asset bundle, using the same
source as the native install gate and `build-macos-app.sh`. Without an existing
accepted asset input, the gate invokes the canonical asset producer. Its fixture
Node must satisfy the native build's self-contained dependency policy; the gate
never substitutes a PATH/Homebrew Node or patches loader references.

## Real-path smoke (`scripts/smoke.sh`)

`scripts/smoke.sh` runs the host exactly as the native app does (`--supervised`, the app's environment and
its config source) under the native stdout rule, then drives every configured connector, one real text turn
that must call tools, and one real Live turn that must call a tool and keep the session open; it prints one
PASS/FAIL line per probe and exits 0 only when all probes pass. Run it after every install and before every
release merge; one run makes at most two model turns, so never run it in a loop.

Before any probe it builds `server/dist` when the entry is missing or older than the newest source file under
`server/`, so a run never judges stale code. `SMOKE_LAUNCH_TIMEOUT_S` sets the host launch budget in seconds
(default 6); a launch that never readies prints `FAIL probe1-strict-supervisor launch=timeout after=<s> load=<1/5/15>` and the remaining probes `SKIP (no host)`.
