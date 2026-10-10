# Local development (current baseline)

This page describes the supported developer path for the code that is on `main`. It is a source cross-check, not a freshly exercised walkthrough: every command below was read from the repository's own scripts and manifests at commit `ff4637c4b9fa84ea38ab58e32bf89198eb7feb2c`, observed on 2026-10-10, and the source files remain the authority if this page drifts.

It covers the service, the web client and the thin Mac shell. It does not describe a packaged installation, because there is none.

## What you are running

One process is the only writer. The host entry at `server/dist/host/index.js` opens the SQLite store, composes the durable domain module for memory and commitments, serves the HTTP API and serves the built web client, all on the loopback interface. The wrapper `scripts/run-local.sh` builds the web client and the service and then starts that host in the foreground.

The host does not wire model inference, MCP execution, notifications, audio or native web-view integration. Attempting to ask Didi a question therefore stays disabled until a model is configured, which this baseline does not do.

## Prerequisites

- macOS. This is the only verified development host. The service code avoids Mac-only APIs and is intended to run on Linux, but the Linux path has not been exercised.
- Node 26.0.0 or newer, and npm. Both packages declare `"engines": {"node": ">=26.0.0"}`. Node is not bundled; you must install it yourself. The host used to write this page reported Node 26.8.2 and npm 11.19.1. The service relies on the built-in `node:sqlite`, which is release-candidate upstream, and on `node:http` for HTTP parsing, so there is no native add-on to compile.
- The Xcode Command Line Tools, only if you build the Mac shell. It is compiled with `xcrun swiftc` and ad-hoc signed with `codesign`.
- An installed Playwright Chromium, only for the isolated web browser check. On the managed host that check runs through `lux-browser-slot`; on a plain workstation it needs the browser revision that the web lock file pins.

## Install

Install from the committed lock files only. Do not add dependencies to run this baseline.

```sh
npm --prefix server ci
npm --prefix web ci
```

## Build

The supported build is the wrapper, which cleans this worktree's generated output and builds both packages with their canonical configuration.

```sh
bash scripts/run-local.sh --build-only
```

That removes `server/dist`, runs `npm --prefix web run build` (a `tsc --noEmit` type check followed by a Vite build) and then runs `server/node_modules/.bin/tsc -p server/tsconfig.json`.

The same steps are available directly in each package: `npm --prefix web run build`, `npm --prefix server run build` and `npm --prefix server run typecheck`.

The service build roots are enumerated in `server/tsconfig.json`: the runtime, HTTP, contracts, domain, host, model and MCP adapters, and prompt modules, plus the runtime, HTTP, MCP and host tests. The `server/chat` and `server/config` directories exist in the tree but are outside that accepted build.

## Start

Start the host in the foreground, against a private state directory of your choosing and the build you just produced:

```sh
DIDI_STATE_DIR="$PWD/.local-state"
bash scripts/run-local.sh --data-dir "$DIDI_STATE_DIR" --web-root "$PWD/web/dist" --port 0
```

The wrapper builds and then runs, so it is safe on its own. For a two-stage launch that skips the rebuild:

```sh
bash scripts/run-local.sh --build-only
bash scripts/run-local.sh --run-built --data-dir "$DIDI_STATE_DIR" --web-root "$PWD/web/dist" --port 0
```

`--run-built` reuses the previous build and does not check whether sources changed. After any source edit, use the default path or repeat `--build-only`.

The host prints its origin, then the availability line, for example that local memory and commitments are available and that model and notifications are not. To see the command line:

```sh
node server/dist/host/index.js --help
```

The low-level service entry, `npm --prefix server start`, runs `node dist/index.js`. That entry deliberately composes the service store and HTTP API without the domain module and reports that the domain is unavailable, so it is not the supported local path for memory or commitments. Use the host entry.

## Data, configuration and state

- `DIDI_STATE_DIR` or `--data-dir` selects the state directory. Without it, the host uses the platform application-data location: the `Lux Didi` subdirectory of the user's Application Support directory on macOS, `$XDG_DATA_HOME/lux-didi` on Linux, and the `Lux Didi` subdirectory of the user's local application data on Windows.
- `DIDI_WEB_ROOT` or `--web-root` selects the built web client; the default is a `web/dist` directory beside the checkout.
- `DIDI_PORT` or `--port` selects the port; the default is 8765, and `--port 0` asks the operating system for a free loopback port. Command-line options take precedence over the environment.
- `DIDI_DESCRIPTOR` or `--descriptor` selects the descriptor path.
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

Each check lives under `scripts/` and names in its own comments what it covers:

- `scripts/check-service.sh`: type-checks, builds, then runs the selected runtime and HTTP tests.
- `scripts/check-host.sh`: exercises the documented build, then the host and HTTP tests, then the shipped UI against the real host under `lux-browser-slot`.
- `scripts/check-domain.sh`: rebuilds from source, then runs the focused domain and provenance tests against a temporary SQLite database.
- `scripts/check-prompt.sh`, `scripts/check-model.sh`, `scripts/check-provider-config.sh` and `scripts/check-mcp.sh`: compile the exact sources they cover into a disposable directory and run their focused tests. Some of them expect an installed TypeScript toolchain under `server/node_modules`.
- `scripts/check-chat.sh`: the affected HTTP boundary regression. Its own comments state that it deliberately excludes package-installation and CLI tests.
- `scripts/check-package.sh`: requires committed package source, then builds the service package from a clean `git archive` in a disposable directory.
- `Tests/DidiMacTests/check-mac.sh`: compiles the Mac shell into a disposable bundle in a temporary directory, signs it ad hoc, verifies the signature, and runs its self-check and an empty-app preview. Installation of a real app is owned by integration; the disposable bundle is proof, not an installed product.

On a managed host, lanes run their own declared checks through the controller; the browser-backed check needs `lux-browser-slot` on the host. On a plain workstation the service and domain checks need only Node and the two `npm ci` steps above.

The planning validator is separate from product checks:

```sh
python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md
```

## Platform limitations

- macOS is the only verified platform. Linux shares the code path but is untested; there is no Windows package.
- Node must already be installed. This baseline ships no bundled runtime, no installer, no notarized application, no cloud deployment and no mobile pairing.
- The Vite development server (`npm --prefix web run dev`) is useful for UI work, but it does not apply the production security headers, so use the host entry for real end-to-end behaviour.
- The host does not deliver reminder notifications, capture or play audio, or drive native web views, and it does not run inference. Those are open proofs, listed in [implementation-status.md](implementation-status.md).

## How this page was verified

Every command above was cross-checked against the current sources at the baseline commit: `scripts/run-local.sh`, `server/package.json`, `web/package.json`, `server/tsconfig.json`, `server/host/index.ts`, `server/host/runtime.ts`, `server/index.ts`, the `scripts/check-*.sh` producers, `Tests/DidiMacTests/check-mac.sh`, and the existing runtime records in [local-runtime.md](local-runtime.md) and [service-runtime.md](service-runtime.md). The commands were not re-executed for this document.
