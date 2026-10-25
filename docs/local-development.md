# Local development

Use the host entry for a complete local service: it composes the store, domain, conversation owners, tools and connectors, then serves the built web interface. The Mac app supervises that same host when installed. It alone owns audio capture and playback; a browser-only host run is not a voice-hardware test.

## Prerequisites

Install Node 26 or newer and npm; the exact engine constraints live in `server/package.json` and `web/package.json`. Native work also needs the Xcode Command Line Tools. For the application build, see [macos-install.md](macos-install.md).

From the checkout root:

```sh
npm --prefix server ci
npm --prefix web ci
bash scripts/run-local.sh --build-only
```

`run-local.sh` builds web assets and service output. `--build-only` stops there. `--run-built` skips compilation and deliberately does not check source freshness, so rebuild after editing source.

## Run an isolated development host

Keep development data separate from the installed application's state. Choose a new private directory and let the operating system assign a free port:

```sh
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/didi-dev.XXXXXX")"
bash scripts/run-local.sh --run-built \
  --data-dir "$state_dir" --web-root "$PWD/web/dist" --port 0
```

Read the exact origin the foreground host prints. An unconfigured provider is a visible local status, not a request to reuse the installed owner's credentials. Add `--config-dir /absolute/private/config` only for configuration you are authorized to use. Do not use a real-account smoke as a synthetic test.

`server/host/index.ts` owns the flags. `--data-dir`, `--web-root`, `--port` and `--descriptor` override their corresponding `DIDI_STATE_DIR`, `DIDI_WEB_ROOT`, `DIDI_PORT` and `DIDI_DESCRIPTOR` environment values. For the full supported grammar:

```sh
node server/dist/host/index.js --help
```

`npm --prefix server start` is the low-level service entry, not this complete host composition. Do not use it to judge whether the domain or local memory works.

## Pair a browser

In a second terminal, with the same state directory:

```sh
node server/dist/host/index.js pair --data-dir "$state_dir"
```

Open the host's exact origin and enter the single-use pairing code. Never paste the `admin-credential` file into a URL, page, shell argument or diagnostic message. The host owns authentication; [service.md](service.md) owns the API contract and [web-client.md](web-client.md) owns the browser surface.

Stop the foreground host with Ctrl-C. Keep the same state directory to inspect restart persistence; do not remove a directory containing records merely to hide a startup failure. [Local runtime](local-runtime.md) explains writer locks, descriptors and authority.

## Select checks, do not invent another build path

[Checks](checks.md) is the check catalog and [releases](releases.md) owns release gates. Run the checks that cover the changed owner and its affected integration. In a managed worker, use the declared controller check rather than invoking its producer directly. Swift compilation must use `scripts/with-compile-lock.sh` through the canonical producers.

Browser-backed proofs can require installed Playwright browsers and the managed `lux-browser-slot` lease tool. npm dependency installation does not install that host tool, and a missing lease is not permission to bypass it. Read the selected producer's prerequisites before scheduling it.

`createArtifactDir` in `web/test/artifacts.mjs` supports `DIDI_ARTIFACT_DIR` as an absolute evidence-output root. Each invocation gets an isolated proof directory; invalid supplied roots fail rather than silently falling back. Choose durable storage when screenshots must outlive operating-system temporary cleanup. This setting changes proof output, not application state or provider configuration.

## Real-account and installed-app work

`scripts/smoke.sh` is a real-path probe, not an offline unit check: it can exercise configured connectors and model turns. It requires explicit owner authorization and the appropriate declared check in a managed run. Do not run it repeatedly, against private accounts without approval, or as a substitute for focused tests.

Never launch, quit or relaunch an installed owner app merely to verify a documentation change. The docs hygiene gate is `bash scripts/check-docs.sh`; it proves only the patterns it checks, not runtime behavior. [Debugging](debugging.md) explains how to collect safe operational evidence.
