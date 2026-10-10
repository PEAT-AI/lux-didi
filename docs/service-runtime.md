# Single-user Didi service runtime

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

## Requirements and local install

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

## Authentication and exact wire policy

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

## Durable state invariants

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

## Focused verification

```sh
bash scripts/check-service.sh
```

Managed workers invoke this only through their declared controller check.
It typechecks strict TS, compiles and runs only runtime/http tests, with a
zero-selected-tests failure gate. Real temp SQLite, separate processes, HTTP
port0, synthetic credentials, clock seams for expiry, offline package install
and production CLI prove this component. There is no claim of UI/browser
rendering, real-domain integration, Linux deployment or whole issue completion.
