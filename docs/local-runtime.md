# Connected local runtime

This foreground Node 26+ process owns one SQLite Store and composes the accepted
service, durable domain and shipped Vite client on **127.0.0.1 only**. It supports
local capture, source-backed recall, commitments, corrections and Today without
a configured model. The optional connected conversation composes the real Gemini
adapter with explicitly granted per-conversation consent. MCP execution,
notifications, audio and native WK integration are **not** wired by this host. Browser pairing grants no device or
notification permission. Unbound reminder needs are persisted but never delivered.

## Setup and foreground use

From the checkout, install only the committed package locks:

```sh
npm --prefix server ci
npm --prefix web ci
```

Build exact sources and run the actual host (not Vite's development proxy). The wrapper uses the canonical `server/tsconfig.json`, shared with the service package build; its explicit production roots are service/runtime, HTTP, contracts, domain, host, model/MCP adapters and prompt, never unaccepted CHAT/config globs:

```sh
bash scripts/run-local.sh --data-dir "$DIDI_STATE_DIR" --web-root "$PWD/web/dist" --port 0
```

For a two-stage foreground launch (also exercised by the focused host check):

```sh
bash scripts/run-local.sh --build-only
bash scripts/run-local.sh --run-built --data-dir "$DIDI_STATE_DIR" --web-root "$PWD/web/dist" --port 0
```

`--run-built` consumes the preceding canonical build without rebuilding. It does not validate source freshness; after any source change, use the default build-and-run path or repeat `--build-only`. A missing compiled entry fails explicitly. Tests always clean and rebuild before this stage.

The leased browser proof defaults to headless GPU rendering. `DIDI_HOST_HEADED=1` requests a bounded headed GPU run for root visual inspection; `DIDI_HOST_ARTIFACTS` chooses the proof directory. Its `browser-proof.json` records the exact source commit, mode, runtime origin, compiled entry/web-index hashes and screenshot hashes, never a credential. The producer closes its browser and disposable service/state before returning.

Set `DIDI_STATE_DIR` to a private application-data directory first. Without
`--data-dir`, macOS uses the `Lux Didi` subdirectory of the user's Application
Support directory. Linux uses `$XDG_DATA_HOME/lux-didi`, or the `lux-didi`
subdirectory of the standard XDG user-data directory. Windows uses
`%LOCALAPPDATA%/Lux Didi`, with the user's standard local application-data
directory as fallback. Explicit paths keep the topology portable; this is not
a Windows package or remote-device install.
Default web root is the checkout/artifact's `web/dist`, port 8765. Environment
alternatives: `DIDI_STATE_DIR`, `DIDI_WEB_ROOT`, `DIDI_PORT`, `DIDI_DESCRIPTOR`.
CLI options take precedence. Port 0 requests an OS-assigned loopback port.

The producer uses the existing service TypeScript configuration/layout, builds
web, then starts `server/dist/host/index.js` in the foreground. It requires the
already installed packages; it never adds a dependency or downloads a browser.
It accepts `--build-only` for packaging/checks and passes other options to the host:

```sh
bash scripts/run-local.sh --build-only
node server/dist/host/index.js --help
```

## Pair the actual web UI

In another terminal, use the existing private state, not a token in argv:

```sh
node server/dist/host/index.js pair --data-dir "$DIDI_STATE_DIR"
```

This reads the existing owner-only admin credential at run time, authenticates
current service status, verifies descriptor assistant/authority identity, and
prints **only a single-use pairing code**. It does not open a Store or print the
bearer. The code expires after five minutes. Open the exact origin printed by the
foreground host and enter the code into **Pair this browser**. Never paste the
admin credential into the browser, URL, shell command, logs or JavaScript.

Capture with **Save message**, search **Memory**, add a commitment under **Today**,
and use **Edit** to correct its due date. Stale revisions display a conflict and
load the latest state for explicit review; no overwrite retry is automatic.
The old **Ask Didi** shortcut remains disabled; use the separate explicitly
disclosed connected Start/Send flow when a model is locally configured. Offline edits are
refused, not queued; reconnect restores current service state.

## State and shutdown

The Store creates/uses a private 0700 data directory and its existing SQLite
single-writer lock. `admin-credential` remains 0600. A competing writer fails
loudly; there is no seed/reset fallback. Ctrl-C or SIGTERM closes the listener and
Store without deleting records. Restart on the same state retains authority,
messages, commitment history and superseded reminder state.

The default `host-runtime.json` (or explicit `--descriptor PATH.json`) is atomic
0600 metadata: `{schemaVersion:1,origin,authorityEpoch,assistantId,pid,startedAt}`.
It contains no bearer. Startup derives a fresh descriptor from the actually
opened Store and bound listener; a stale file is never used to choose authority.
The local pairing command revalidates current authenticated service identity.
The descriptor may remain stale after shutdown; it is not proof of liveness.
Symlink descriptor targets are rejected, and it cannot be placed in the public
web build. Missing/invalid web build, configuration, SQLite/migration, descriptor
or listener errors are fatal; startup closes any opened Store/listener.

Only validated shell/manifest/icon/worker and asset paths are public, with the
accepted CSP/Permissions-Policy/security headers. Private source/state, encoded
path escapes and out-of-root symlinks are denied. API errors remain JSON, never
HTML fallback. There is no CORS, LAN binding or development proxy workaround.

## Optional app-owned supervision

INSTALL may directly spawn this compiled entry with an anonymous stdin pipe:

```text
<validated-node-26+> <artifact>/server/dist/host/index.js --supervised --data-dir <state> --web-root <web-dist> --port 0
```

Within five seconds, send exactly one UTF-8 JSON line, at most 1024 bytes including
LF, with exactly these fields:

```json
{"type":"start","schemaVersion":1,"nonce":"<16..128 base64url ASCII characters>"}
```

Keep stdin open for the lifetime. No further input is allowed. The nonce is
nonsecret rendezvous metadata, never authority. After actual Store/domain,
listener and descriptor readiness, stdout emits one bounded JSON line:

```json
{"type":"ready","schemaVersion":1,"nonce":"<same-nonce>","pid":12345,"origin":"http://127.0.0.1:<port>","authorityEpoch":"<actual-epoch>","assistantId":"<actual-id>"}
```

No bearer in either frame. Malformed, oversized or incomplete input fails before
ready; EOF shuts down the owned listener/Store. Standalone mode does not require
stdin. Fatal messages go to stderr. No launch agent or replacement lock/auth
scheme is installed. App lifecycle, Keychain setup and WK appearance/behavior
remain the separate native installation gate; browser proof does not satisfy it.

## Focused verification

```sh
bash scripts/check-host.sh
```

In a managed lane, run that producer only through its declared controller check.
It builds exact accepted service/domain/web sources, selects own actual HTTP /
SQLite / process / supervision tests and affected existing HTTP tests, then runs
the shipped UI against the canonical host under `lux-browser-slot`. It never
uses fixture routes or invokes unrelated component suites. Headless GPU output,
desktop/375px screenshots and meaningful wire proof are retained in the printed
artifact directory; `DIDI_HOST_ARTIFACTS` can specify a durable output directory.

## Explicitly connected conversations

The same canonical build includes CHAT and provider configuration. A single Store
applies the accepted Domain and additive CHAT migrations; pending runs recover
before listening. No pending turn is retried on restart. A dispatch interrupted by
process loss is reported as outcome unknown, never as a saved answer.

The host accepts `--config-dir PATH`; the portable default is
`<dataDir>/provider-config`. See [provider configuration](provider-configuration.md)
for the existing secure profile/key initialization. The validated profile is fixed
for the process; restart to activate edits. Keys retain their secure per-dispatch
read. Status is unconfigured, disabled, error (safe code only), or configured with
provider/model. Configured means the profile is locally validated; this does not prove provider reachability. An
unsupported adapter model ID is a sanitized configuration error and never prevents
local notes, Today, recall or supervisor readiness.

Start a new connected conversation explicitly. The UI names the actual provider
and model and explains that current and earlier selected conversation turns go
there. Existing local/imported sessions are never enrolled or relabeled. The route
grant pins exact provider/model, fixed Gemini endpoint/API version/key reference,
and class policy; edits to that identity pause old conversations on restart while
preserving readable history. New routes require a new disclosed conversation.

Connected Send atomically saves one private user entry and run. It does not use the
legacy local Save path first. Context contains only selected whole turns of that
session, compiled with the canonical persona/budgets; no recall, Today, other
sessions, local archive or tools. Unknown or sensitive participating material
blocks. Final answers appear only after atomic durable completion; partial text is
provisional. Explicit cancel/revoke can abort ongoing work but cannot retract sent
bytes. A may-have-been-sent status is deliberately conservative after dispatch
intent. A failed acceptance keeps the draft; recover saved history before choosing
to send again. Reconnect/focus/restart never sends or retries automatically.

`bash scripts/check-connected.sh` is the focused canonical build, affected engine
and host HTTP suite, real adapter over a controlled local transport, actual process
restart/crash, and shared browser proof. `bash scripts/check-package.sh` remains the
offline tarball gate. Neither proof makes live model, audio, OS permission or
installed native claims. Test transport/resolver controls exist only as trusted
in-process construction options, never as a public route, CLI or environment mode.
