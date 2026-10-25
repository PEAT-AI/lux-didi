# Local service and wire boundaries

The canonical application host is `server/dist/host/index.js`. It composes the domain, text and Live owners, tools, connectors and web shell over one local Store. The lower-level `server/dist/index.js` is not a substitute for that complete application composition. [Local development](local-development.md) owns run commands; [local runtime](local-runtime.md) owns process identity and supervision.

## Contract owners

| Concern | Source |
| --- | --- |
| Listener and HTTP orchestration | `listenService` in `server/http/server.ts` |
| Route mapping | `server/http/routes.ts` |
| Operator authentication and authority context | `operatorPrincipal`, `authorityContext` in `server/http/auth.ts` |
| Browser shell and asset restrictions | `server/http/static.ts` |
| Live WebSocket upgrade | `server/http/live-upgrade.ts` |
| Domain DTOs and operation types | `server/contracts/domain.ts` |
| Storage transaction seam | `server/contracts/storage.ts` |
| Typed errors | `server/contracts/errors.ts` |
| Persistent writer | `Store` in `server/runtime/store.ts` |
| Effect intent lifecycle | `server/runtime/outbox.ts` |

Read these owners for exact route, header, JSON and event shapes. Documentation is not a second wire-schema catalog.

## Authentication and browser pairing

The service listens on loopback, not the LAN. The protected operator bearer and a paired browser session are different principals. The browser obtains its session through a single-use pairing code, not by receiving the admin credential. Pairing commands are in [local-development.md](local-development.md).

Browser mutations require same-origin and CSRF validation. `rejectDuplicateSecurityHeaders` in `server/http/auth.ts` rejects ambiguous protected headers. An HTTP success without the intended authenticated state transition is not proof that the application feature works. Do not add permissive CORS or a development-proxy bypass to hide an origin/authentication defect.

The native web view is presentation, not an authority-granting RPC surface. Native audio and application actions remain native-owned; [native-app.md](native-app.md) describes that boundary.

## Mutations, replay and effects

Mutations use current authority and request identity; stale epochs and conflicting reuse must not become new writes. Domain operations run in the caller's transaction. A committed local record is different from an outbox intent, and an outbox intent is different from an acknowledged external effect.

`OutboxState` in `server/runtime/outbox.ts` preserves pending, claimed, acknowledged, failed, unknown and superseded states. A timeout or cancellation after dispatch is not proof of no effect. Never re-execute an uncertain write simply to manufacture a success receipt.

Memory deletion composes the domain change with retained context/cache redaction. `EntryDeletionResponse` in `server/http/server.ts` exposes whether an active provider still holds the note. [Privacy and authority](privacy-and-authority.md) owns that limit; deleting a local row is not remote or forensic erasure.

## Conversation surfaces

[Text chat](text-chat.md) owns durable text runs, subscriptions and consent. [Live calls](live-call.md) own call acceptance, voice transport and recovery. Both use host-owned tool boundaries; a renderer cannot approve a connector or infer a write from assistant prose.

The web shell is served under the service's security policy. API failures remain API failures, not HTML fallback. Read `server/http/static.ts` before changing asset handling or navigation assumptions; [web-client.md](web-client.md) owns the presentation contract.

## Packaging and verification

[Mac installation](macos-install.md) owns the application bundle and protected selector; [releases.md](releases.md) owns release mechanics. [Checks](checks.md) names the host, runtime, package and affected integration producers. A package build does not prove account sign-in, browser pairing or audible voice. Use [debugging.md](debugging.md) for safe evidence before changing a failing layer.
