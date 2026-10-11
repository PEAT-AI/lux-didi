# Client and service contract

The portable service and browser client are implemented. The supported composed
host (`server/dist/host/index.js`) serves the browser and owns Store/Domain and
connected Chat; the supported standalone entry (`server/dist/index.js`) is a
runtime-only HTTP/Store CLI, without Domain, Chat or the browser shell. See
[service-runtime.md](service-runtime.md) and [web-client.md](web-client.md).

## Current browser wire contract

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

## Shape

One authoritative process serves every client. The Mac app is a companion that owns native
operating-system surfaces: global hotkey, microphone and playback, notifications, permission
dialogs. A responsive progressive web application is the portable client. Neither client owns
domain logic, and neither is the authority.

```
Mac companion ─┐
               ├── REST JSON commands and queries + server-sent progress ──> service (single writer)
Browser client ┘
```

## Commands, queries and progress

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

## The browser client

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

## Devices, grants and pulled intents

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

## Channels

Signal, email and Mattermost are channels and transports. They are not identity proof and they are
not an administrative bypass. A channel message arrives as a channel envelope (C19) carrying the
source account, the channel identity that carried it and a delivery state. A channel identity is
bound to a source account only by an explicit user action (C20); an unbound or mismatched identity
can be read but cannot act. A verified sender address, a workspace membership or a phone number is
never promoted into authority.

## Unavailable state

When the service is unreachable, clients say so and keep working only with what the contract
allows: the cached shell, the last read-only view the person already saw, and a clear notice that
private data is unavailable. A queued outbound item is either delivered once on reconnect or
expires with a report; it is never delivered twice.

## Conformance

A shared conformance suite (F22) covers envelope version negotiation, command acceptance, query
shape, progress ordering, error classes and reconnect at each breakpoint. A contract change updates
the suite before it updates a client, and a run reports each case rather than a single boolean.

## The shared interface and its native host

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
