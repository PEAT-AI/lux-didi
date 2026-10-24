# The local service

Reader: anyone who runs, packages, or debugs the local Didi service, and anyone who changes its wire contract.

The service is one loopback-only Node process that owns the database, the call and the tools. This page covers what it is, the exact wire contract the browser client speaks, the authentication it enforces, the state invariants it keeps, and how it is packaged and proved for a release. The host entry and its flags are in [architecture.md](architecture.md); the database tables are in [domain-contract.md](domain-contract.md).

## Client and service contract


The portable service and browser client are implemented. The supported composed
host (`server/dist/host/index.js`) serves the browser and owns Store/Domain and
connected Chat; the supported standalone entry (`server/dist/index.js`) is a
runtime-only HTTP/Store CLI, without Domain, Chat or the browser shell. See
[service.md](service.md) and [web-client.md](web-client.md).

### Current browser wire contract

- **Local Save:** creates a session if needed, then posts a user entry to
  `/api/v1/sessions/:id/entries`. It does not dispatch a model. Success clears the
  draft; failure or stopping the wait preserves it. Stopping a wait is not proof
  that the service did not save the entry.
- **Connected Chat:** `ConnectedView` obtains `/api/v1/chat/status`, starts an
  explicitly consented conversation and posts `/api/v1/chat`. The response is a
  durable Chat Run, not a generic job ID. Authenticated run events and
  `/api/v1/chat/:runId` recover progress; `/api/v1/chat/:runId/cancel` requests
  cancellation. Only notes explicitly selected in this composer are attached;
  reconnect and status polls do not create model work. Cancellation or consent
  revocation cannot retract provider bytes already sent.
- Browser writes use same-origin cookie/CSRF, idempotency and authority-epoch
  headers. The browser has no independent writer or operating-system grants.

`npm --prefix web run check` exercises the real local browser HTTP/SQLite fixture;
`bash scripts/check-connected.sh` exercises the real composed host and Chat with
controlled synthetic model transport. These are not completed native installation,
Live voice, account-tool execution or live-provider proof.

The sections below describe broader design requirements, not a statement that
all capabilities or the proposed generic job/envelope protocol are implemented.
They do not replace the current browser wire contract above.

### Shape

One authoritative process serves every client. The Mac app is a companion that owns native
operating-system surfaces: global hotkey, microphone and playback, notifications, permission
dialogs. A responsive progressive web application is the portable client. Neither client owns
domain logic, and neither is the authority.

```
Mac companion ─┐
               ├── REST JSON commands and queries + server-sent progress ──> service (single writer)
Browser client ┘
```

### Commands, queries and progress

- A **command** is a JSON request that is accepted or refused and, when accepted, returns a job
  identifier. It never returns a mutable domain object.
- A **query** is a JSON request that returns a read model with the contract version that produced
  it.
- **Progress** is a server-sent event stream keyed by job identifier, emitting state transitions
  with a monotonically increasing sequence number. A reconnect resumes from the last observed
  sequence number.

A WebSocket framework is not required. The envelope is versioned by the shared contract package
(A02), and a client negotiates a supported range rather than a single pinned version.

Public references: <https://www.rfc-editor.org/rfc/rfc9110> for the HTTP semantics and
<https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events> for the stream.

### The browser client

The browser client is a shell plus a conversation view, a job and progress view, and a connection
state indicator. Three breakpoint classes are supported: laptop, tablet and phone. The client
states which service it is connected to, so a loopback session is distinguishable from a remote
one.

Offline behaviour is deliberately narrow:

- The serviceworker caches the **shell only**: the application shell, the manifest and static
  assets. It never caches a command, a query result or a progress payload.
- Private records are read-only and unavailable while the service is unreachable. There is no
  offline writing of commitments, sessions or recall results.
- Browser storage holds no private record. Signing out clears the partitioned cache, and the
  client reports the unavailable state rather than a blank page.

Public references: <https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API> and
<https://web.dev/service-workers-cache-storage/>.

### Devices, grants and pulled intents

The service never reaches into a device over an inbound port. A device **pulls** scoped, expiring
intents outbound and independently enforces its own local grants before performing any effect.

- An intent names the target device, the action class, the scope, the expiry, a nonce and the
  issuing authority epoch.
- An intent is single-use. A replay is refused by the nonce check, and an expired intent is
  refused rather than refreshed silently.
- A device that has revoked its own local grant refuses the service's intent and reports the
  refusal. The service holds no authority that can override that refusal.
- Revoking a device invalidates its queued intents and deliveries through the revocation epoch
  (C23), so a queued item expires instead of delivering.

Public reference: <https://www.rfc-editor.org/rfc/rfc6750> for the bearer-token shape this borrows.

### Channels

Signal, email and Mattermost are channels and transports. They are not identity proof and they are
not an administrative bypass. A channel message arrives as a channel envelope (C19) carrying the
source account, the channel identity that carried it and a delivery state. A channel identity is
bound to a source account only by an explicit user action (C20); an unbound or mismatched identity
can be read but cannot act. A verified sender address, a workspace membership or a phone number is
never promoted into authority.

### Unavailable state

When the service is unreachable, clients say so and keep working only with what the contract
allows: the cached shell, the last read-only view the person already saw, and a clear notice that
private data is unavailable. A queued outbound item is either delivered once on reconnect or
expires with a report; it is never delivered twice.

### Conformance

A shared conformance suite (F22) covers envelope version negotiation, command acceptance, query
shape, progress ordering, error classes and reconnect at each breakpoint. A contract change updates
the suite before it updates a client, and a run reports each case rather than a single boolean.

### The shared interface and its native host

The same responsive page serves a browser and the Mac companion (F23). The companion hosts it in a
web view configured with a nonpersistent data store, an exact configured scheme, host and port, and
main-frame navigation only. Redirects to another origin, popups, downloads, subframes and arbitrary
remote content are refused rather than negotiated.

The page holds no authority. There are no inbound JavaScript-to-native handlers and no generic
native RPC; the service bearer is native-only; the page owns no operating-system permission; speech
is started and stopped from a native control and the recognised text arrives through the service
API. Native chrome covers the unavailable, setup and retry states and preserves a draft while
reporting the configuration fault.

An open question list travels with this contract: whether a hidden view loses its graphics context,
whether terminating a content process clears the page's cookie, and whether two views can
inadvertently break the single-writer rule. Each is a test case with a measurement, not a settled
claim.


## Single-user Didi service runtime


This is the authoritative TypeScript/Node **runtime**, not a finished assistant.
The supported standalone service entry (`server/dist/index.js`, also `npm --prefix
server start`) composes Store and HTTP without Domain, Chat or the browser shell.
Memory/commitment routes return `DOMAIN_NOT_CONFIGURED` (503); models and
notifications are unavailable. This runtime-only CLI remains supported, but is
not the composed browser host.

The supported composed host (`server/dist/host/index.js`) injects Domain and Chat
and serves the built web client. Memory and commitments are available there;
configured connected Chat can dispatch inference after explicit route consent.
Local Save only records a user entry and never invokes a model. Host
configuration/capability status, not the presence of a browser, determines which
connected features are available. Neither entry is evidence of completed native
installation, Live voice, account tools, a scheduler or a device executor.
[implementation-status.md](implementation-status.md) records the broader gates;
[web-client.md](web-client.md) describes the supported browser surface.

### Requirements and local install

Use **Node >=26.0.0**, npm, macOS or Linux. Actual evidence: Node26.8.2 on macOS;
Linux is **untested** because the available Docker CLI had no running engine.
No VM, engine, provider or CI was provisioned. Node's built-in `node:sqlite` is
release-candidate since25.7.0 ([official docs](https://nodejs.org/api/sqlite.html));
`DatabaseSync`, bound statements and authorizer were verified on installed26.8.2.
SQLite uses Node's built-in driver and `node:http` owns HTTP parsing. The service
package does have pinned runtime npm dependencies: `@modelcontextprotocol/client`
and `ws`. Their presence does not imply that account tools or Live voice have
completed installation or live-provider proof.

From this repository, for the **runtime-only standalone CLI**:

```sh
npm --prefix server ci --ignore-scripts --no-audit --no-fund
npm --prefix server run build
DIDI_STATE_DIR="$HOME/Library/Application Support/LuxDidi/service" npm --prefix server start
```

On Linux choose an absolute private state path (for example a directory inside
`$HOME/.local/state`). Set `DIDI_PORT` to an available port; default8765. Only
127.0.0.1 is bound, with exact `Host: 127.0.0.1:<port>` and Origin
`http://127.0.0.1:<port>`. `localhost`, foreign/null origins and wildcard CORS are
not accepted. Port0 is supported for tests/local operator startup. No remote
bind option: HTTPS/remote auth must be a separately reviewed deployment unit.
SIGINT/SIGTERM close HTTP before releasing SQLite ownership.

For a separately installable local artifact, after building:

```sh
npm --prefix server pack --ignore-scripts --pack-destination /tmp
npm install --prefix /your/private/install --offline --ignore-scripts --omit=dev --no-audit --no-fund /tmp/lux-didi-service-0.1.0.tgz
DIDI_STATE_DIR=/your/private/state node /your/private/install/node_modules/@lux-didi/service/dist/index.js
```

The package explicitly includes compiled runtime/contracts/HTTP/entrypoint,
not state, test fixtures or credentials. The offline pack/install + production
CLI are exercised using synthetic temporary directories in `http.test.ts`.
Node itself is not bundled. Do not overwrite a live installation or copy
private state to another host without coordinated authority migration.

### Authentication and exact wire policy

The runtime creates `<state>/admin-credential` (0600; directory0700). Local/native
operator reads this file and uses `Authorization: Bearer` in an HTTP header.
Never put a credential in URL, argv, logs or localStorage. The executable prints
only its origin/runtime availability, never the credential or pairing secret.
There is no unauthenticated credential endpoint.

Operator `POST /api/v1/auth/pairing` with bearer and JSON `{}` obtains a single-use
five-minute pairing code. This response is sensitive: pass it locally, not into
public logs/issues. Browser `POST /api/v1/auth/pair` with JSON `{pairingCode}` and
exact Origin receives HttpOnly/SameSite=Strict/path=/ cookie (12h) and csrfToken.
Browser holds CSRF in memory; `GET /api/v1/auth/session` recovers it after reload.
Browser writes require exact Origin and `X-Didi-CSRF`. Logout revokes session.
Cookie is intentionally not Secure on loopback HTTP; remote deployment is not
supported. Session token hashes/expiry and CSRF persist in private SQLite.
Pairing codes are hashed in process memory, capped at16 outstanding, consumed
once and invalidated by restart; authentication does not grant native tools.

`GET /health` is public and contains no private data. `GET /api/v1/status` needs
authentication. The standalone runtime exposes unavailable Domain/model
capabilities and empty sources; the composed host reports its actual injected
capabilities. Connected route availability is reported by `/api/v1/chat/status`. Explicit route allowlist denies arbitrary commands, unknown
fields/query parameters, unsupported methods, invalid UUID/revision/timezone/
UTC dates, non-JSON and >64KiB bodies. Request identifiers are UUIDs; responses
never include SQL/errors/credentials/content in exception messages. No request
logging. Generic jobs/device routes are not implemented and return404; they are
not the connected Chat Run/event API supplied by the composed host.

The root service contract is authoritative. Domain DTOs and generic typed
`DomainPort.execute(tx, operation, input, context)` live in `server/contracts`.
Domain tables are sibling-owned and never open a second DB. Runtime imports no
Domain implementation; the composed host injects it into the same Store.

### Durable state invariants

- Real SQLite WAL with synchronous FULL, foreign keys, bound parameters.
- Separate `writer.sqlite` exclusive transaction owns writer lifetime. A second
  process fails `WRITER_LOCKED`; crash releases kernel ownership, with no stale
  PID-file race. Never unlink/replace these files while an owner is active.
- Domain migrations are owner/version ordered, contiguous from1; runtime owner
  reserved; downgrade refused. Schema plus version records roll back together.
- Synchronous transaction callback; async functions rejected before invocation,
  returned thenables rollback; no nested/control SQL/await/network. A retained
  handle expires. SQL is single-statement; duplicate result columns refused.
- Domain mutation plus outbox/key record commit in the same transaction. Key
  scoped to authenticated assistant/client; canonical body + operation/path
  fingerprint yields original complete response on duplicate,409 on conflict.
  Failed mutation does not consume key. Wrong authority epoch409; expected
  record revision is enforced by the injected domain, not inferred by runtime.
- Outbox pending/claimed/acknowledged/failed/unknown/superseded is durable.
  Startup and abandoned leases become unknown, never blind retry. Revision,
  epoch, expiry, matching live token and explicit grant are revalidated; default
  policy denies. Outcome checks live lease/expiry. OS acknowledgment does not
  prove user read it. No effect adapter calls occur inside a transaction.

### Focused verification

```sh
bash scripts/check-service.sh
```

Managed workers invoke this only through their declared controller check.
It typechecks strict TS, compiles and runs only runtime/http tests, with a
zero-selected-tests failure gate. Real temp SQLite, separate processes, HTTP
port0, synthetic credentials, clock seams for expiry, offline package install
and production CLI prove this component. There is no claim of UI/browser
rendering, real-domain integration, Linux deployment or whole issue completion.

Host stdout is reserved for the supervisor JSON protocol. Configuration seeding diagnostics (`config_seeded`) are recorded only in `logs/host.log` under the host data directory.
`POST /api/v1/diagnostics/client` accepts only the native client's OPERATOR bearer principal, not browser cookies. Its JSON body is at most 512 bytes and contains exactly `event: "live_precreate_failed"`, `failureClass: "audio" | "service"`, and a code from the native failure vocabulary, optionally an integer `detail` only for `http` or `socketClosed`. The failure class must match the code. Accepted events return 204 and append a `client_diagnostic` host.log event with `source: "native"`, `receivedAt`, and the validated body nested under `diagnostic`; no SQLite record or response echo is produced. Each principal may submit 30 events in a rolling minute; the next receives a typed HTTP 429 `rate_limited` error, without logging its body.


## Self-contained service tarball


The service has a runtime dependency: the pinned official MCP client. It is not
zero-dependency. `server/package.json` lists that existing dependency in
`bundleDependencies`; the committed npm lock identifies the bundled production
closure. No dependency is newly introduced or copied into this repository.
Node itself, the OS, and deployment configuration are not bundled.

### Release proof

From a clean, committed checkout, run the focused producer:

```sh
bash scripts/check-package.sh
```

Managed workers run this argv through their registered foreground `check-run`,
not directly. A failed producer is a failed gate, including builder setup,
compilation, missing selected tests, archive verification or offline installation.
The script requires Node compatible with the service's `engines` and npm 11.
It obtains locked build dependencies from the registry in a new disposable
builder cache. This ordinary setup needs network access; target installs do not.
It does not use developer `node_modules`, a global dependency cache, or change
npm configuration files.

The producer exports **committed** server source, runs a clean `npm ci`,
typechecks and compiles the exact service tsconfig, then extends the enumerated
test list only inside the disposable builder. A second clean `npm ci --omit=dev`
uses the explicit builder cache offline to prepare the production tree. Only
that locked production tree and the compiled files feed `npm pack`. Temporary
builders, caches, installed targets and control tarballs are removed on exit.

The focused tests verify:

- Runtime dependency traversal from the committed lock, including required peer
  edges; agreement with production flags and the actual installed package graph.
  Counts are derived, never copied from npm's installation summary.
- Exact archive file inventory and sizes, compressed size and unpacked byte sum;
  packed service/compiled builder bytes and every included runtime file match
  the clean production install. No development or extraneous package, hidden
  dotenv/private path, unexpected service file or native binary is accepted.
  Bundled upstream `.npmignore` files are public packaging metadata, not secrets;
  they are the sole allowed vendor dotfile and are also byte-verified.
- Included upstream license/notice files match each clean runtime package, and
  the Didi-owned MCP SDK notice is included. This proves file inclusion, not a
  legal determination about redistribution.
- The existing HTTP packaging test, unchanged: a real tarball installs offline
  in a brand-new empty target cache and the actual installed production CLI
  serves authenticated, honest runtime-only status.
- A separate empty-cache install loads the **installed** MCP adapter, registry
  and result-store modules. Discovery without a configured endpoint is honestly
  unavailable; a closed adapter stays unavailable. This exercises SDK module
  resolution, not a live remote MCP server or credential-bearing integration.
- Disposable negative artifacts: absent bundles must fail empty-cache offline
  installation; a missing required runtime package must fail either installation
  or installed adapter loading. Wrong versions, missing/tampered runtime files
  and synthetic `.env` contents fail inventory/byte verification. Polluted input
  package graphs are rejected before packing and cannot become trusted artifacts.

The TAP output includes `PACKAGE_SOURCE` and an `ARTIFACT` summary with measured
sizes, inventory digest, lock-derived package versions and licenses. Archive
inventory is compared to npm's pack report and the extracted real tarball;
no cache warming or network fallback is allowed in any target installation.

### Boundaries

The current production lock has no peer or optional dependency edges and no
native addon. npm 11's installed `npm-packlist` implementation traverses bundled
production/optional dependencies but explicitly excludes peer/dev edges; bundling
must not be assumed to cover future peers. A future dependency graph change
must pass the same artifact and empty-cache gate or receive a separate packaging
decision. Platform-conditional optional packages and additional platforms are
not certified by a run on one host.

A green run establishes a self-contained tarball only on the Node version and
platform printed in that run. It does not certify bundled Node, every OS,
end-to-end MCP network execution, native/UI packaging, or deployment. If the
normal compiler ever omits adapter dist, the installed-adapter test fails at
that owning build gap rather than claiming success.

