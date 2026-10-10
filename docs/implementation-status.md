# Implementation status

Observed at commit `6a66898a392e052a31b59ef009dcae03b1c5aae8` on 2026-10-10 (UTC). This page is a source cross-check of the committed tree. It is not a claim that the product is installed, that any provider is configured, or that any end-to-end path was exercised while writing it.

It separates four things: the components that are implemented in the service, the web client and the thin Mac shell; the behaviour the host integrates end to end; the surfaces the host deliberately leaves uncomposed; and the proofs that are still unresolved.

## 1. Implemented and accepted on main

The service, the web client and the thin Mac shell all have committed, buildable code.

**Service (`server/`)**, TypeScript for Node 26 or newer, built with `tsc` into `dist/`:

- `server/runtime`: the SQLite store on `node:sqlite` and the durable outbox.
- `server/http`: the loopback HTTP server, routes and the static handler that serves the web build with the security headers.
- `server/contracts`: storage, domain and error contracts.
- `server/domain`: the durable domain module for memory and commitments, with its facade, schema, labels and DTOs.
- `server/host`: the host entry, its runtime composition and the supervision handshake.
- `server/prompt`: the pure prompt compiler.
- `server/adapters/model`: the Gemini adapter, the tool loop and its control types.
- `server/adapters/mcp`: the MCP port, registry, store and adapter, with the SDK licence notice.

The `server/chat` and `server/config` modules are build roots. `server/tsconfig.json` lists both, the chat module owns the conversation subscription and its durable accepted-turn schema, and the config module owns the provider profile the host validates at startup. The host applies the domain migrations and the additive chat migrations before it listens, and a dispatch interrupted by process loss is reported as outcome unknown rather than as a saved answer.

**Web client (`web/`)**, Vite and TypeScript, pinned in its own lock file:

- a same-origin progressive web app with `main.ts` for the shell and views, `api.ts` for the HTTP contract, `protocol.ts` for the wire types, `orb.ts` and `orb-classic.ts` for the canvas orb, and a generated service worker for the shell.
- a content security policy in both the served headers and the document, a web app manifest, and a bundled orb icon. No external font, image, analytics or CDN request.

**Mac shell (`Sources/LuxDidi/`)**, Swift, built with the Xcode Command Line Tools:

- an AppKit menu-bar agent that hosts SwiftUI, with a Carbon global hotkey, a native notification seam and a native voice seam.
- an `AppDomainPort` boundary that is deliberately supplied by `DisconnectedDomain`, so the shell shows an explicitly empty state rather than a simulated account. Drafts are ephemeral, and sending from the disconnected state reports failure.

**Planning (`planning/` and `scripts/`)**: the backlog of 120 nodes and the validator and renderer that check it for internal consistency. This is the plan, not product behaviour.

## 2. Integrated behaviour on current main

The host entry composes the accepted service, the durable domain module and the built web client, and serves them on `127.0.0.1` only. From that origin a user can:

- pair the browser with a single-use code, and hold an `HttpOnly`, `SameSite=Strict` session cookie with a CSRF token kept in memory;
- save a message, which is local capture into the service store;
- search Memory and recall source-backed records;
- create and edit commitments under Today, where a stale revision shows a conflict and loads the latest record for explicit review rather than overwriting;
- correct a record, where the store retains commitment history and superseded reminder state;
- restart against the same state and keep authority, messages, commitment history and superseded reminder state.

By default no provider profile exists, so the status the client reads reports the model as unconfigured and the old Ask Didi shortcut stays disabled, while saving messages and commitments still works. When a profile is validated locally the host also composes the real Gemini adapter for an explicitly granted connected conversation, which the web client starts through its own Start/Send flow; the grant pins the exact provider and model. Stored reminder needs that have no delivery path are persisted but never delivered.

The host does **not** integrate: MCP tool execution, notifications, audio capture or playback, native web-view hosting, or any calendar, mail, chat or transcript connector. Model inference is composed only inside an explicitly granted connected conversation with a locally validated profile; nothing else in the host performs inference, and the loopback interface remains the only listener. The service HTTP layer applies the content security policy and related headers to the shell and assets it serves.

## 3. What this tree does not contain

The following categories are not in this tree:

- a local install and package path, including `scripts/package-local.mjs`, `scripts/install-local.mjs`, an install
  check, install tests and a local-install document;
- deeper native companion integration, including companion web, supervision and installed-proof sources and their
  tests - `Sources/LuxDidi/CompanionClient.swift` is not in this tree.

The live-voice adapter (`server/adapters/live-voice`), the Lux Knowledge connector (`server/connectors`), the chat and
config modules, the host-entry producer, the provider configuration source and the pending-request store are all part
of this tree, each with its own document and check. Nothing outside this tree should be read as installed, released or
verified for the public.

## 4. Unresolved end-to-end proofs

- **Installation**: there is no packaged or notarized application on `main`, and Node must already be installed. No clean-machine installation has been proven.
- **Model**: with no provider profile the model is unconfigured and no inference is attempted. With a locally
  validated profile the host composes the Gemini adapter for an explicitly granted connected conversation, so
  inference is conditional on that configured, granted path and on nothing else. A configured profile has been validated locally, and that validation does not prove provider reachability; an unsupported adapter model ID is a sanitized configuration error rather
  than a startup failure.
- **Voice**: no audio capture or playback is wired by the host, and the Mac shell voice seam is not exercised end to end.
- **Accounts and connectors**: no Google account, calendar, mail, chat, transcript, email, Mattermost or harness connector runs on `main`. Those account and connector calls, and any transcript, email, chat, calendar or harness control, remain roadmap items until baseline code proves them.
- **Portability**: macOS is the only verified host. Linux shares the code path but is untested, and there is no Windows package. There is no cloud deployment and no mobile pairing.
- **Native surfaces**: Keychain setup, application lifecycle, notifications and web-view appearance remain the separate native installation gate; the disposable Mac check bundle is proof of compilation and an empty preview, not of an installed product.

## 5. What this does not claim

- No blanket claim of full computer autonomy. Tool execution is scoped to explicit grants and is not wired by the host today.
- No complete cross-session memory across devices. There is one canonical conversation and memory authority, the service store; adapters are optional, and no cloud or multi-device synchronisation is implemented.
- No claim that account access is simulated. Importing or connecting a real account is a setup step under explicit, revocable grants; this repository ships no fake demo data in its place.
- No claim that any future integration or roadmap milestone is present, installed or verified.

## How this page was verified

Statements were cross-checked against the committed sources of this tree at `6a66898a392e052a31b59ef009dcae03b1c5aae8`: the `server/` module list in `server/tsconfig.json`, `server/host/index.ts`, `server/host/runtime.ts`, `server/index.ts`, `server/package.json` and `web/package.json`, the runtime records in [local-runtime.md](local-runtime.md) and [service-runtime.md](service-runtime.md), the web and Mac records in [web-client.md](web-client.md) and [mac-experience.md](mac-experience.md). The build and run paths were not re-executed for this page.
