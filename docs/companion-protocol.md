# Native companion protocol and trust boundary

The canonical business UI is the exact service-hosted page at `/`. Swift owns only
window/hotkey lifecycle, native draft/record controls, unavailable/retry state,
secure credential lookup and outbound REST. There is no Swift business database,
independent Conversation/Today/Memory screen, inbound JavaScript authority bridge,
script injection, custom command scheme, Node integration, or private WebKit KVC.

## Explicit local instance

Set `LUX_DIDI_DESCRIPTOR` to an operator-provided JSON file containing `origin`,
`credentialService`, and `credentialAccount`. `origin` must be precisely
`http://127.0.0.1:<explicit port>`, without credentials, path, query, or fragment.
The other fields reference an existing Keychain generic-password item. The file
contains no bearer. No default port is trusted. Keychain lookup disables user
interaction; missing access is an unavailable state rather than a prompt.

This first local slice refuses every remote origin. Future HTTPS support requires
explicit per-device pairing and credential scoping; merely changing the URL must
never forward a local bearer to a remote service. Bearer credentials are native
only; neither URL nor argv, logging, WebKit request, nor page script carries them.

## Network and page session

Native REST uses an ephemeral URLSession with no cookie/cache persistence and a
redirect-refusing task delegate. It reads authenticated status for the current
`authorityEpoch`; bootstrap requests a one-time pairing code with the bearer,
then exchanges that code with the exact configured `Origin`, without bearer.
The service's own HttpOnly, SameSite=Strict root cookie is validated and installed
in `WKHTTPCookieStore` before the first document load. Native logout reads CSRF
through the ordinary cookie-authenticated page API; the shared page independently
reads its own CSRF through that API. Nothing is injected into page JavaScript.
Native auth routes are `/api/v1/auth/pairing`, `/api/v1/auth/pair`,
`/api/v1/auth/session` and `/api/v1/auth/logout`; cookie-authenticated mutations
use `X-Didi-CSRF`. These match the published API and read-only accepted service
source at `821630133207ac021d022d51041f40eea8b32205`. Native parses actual
Set-Cookie rather than constructing its own independently named cookie. Fixtures
alone are not accepted production integration.

## Documented WebKit policies

`WKNavigationDelegate.decidePolicyFor navigationAction` accepts only main-frame
GET navigation from a main frame to the configured scheme+host+port and canonical
root path. Targetless popups, subframes, non-GET navigation, download actions,
other paths/origins/ports, credentials, queries and fragments are refused.
`decidePolicyFor navigationResponse` independently validates main-frame, exact
URL, HTTP 200, displayable `text/html`, and no Content-Disposition. Redirect
callbacks stop provisional loads rather than accepting an unexpected hop.
`WKUIDelegate.createWebViewWith` never creates a popup; media capture permission
is always denied via the documented delegate. Media requires user action.
The content controller has zero handlers and zero injected scripts; website data
is nonpersistent. These policies do not claim to make WebKit an OS sandbox or
prevent every same-origin page subresource; service CSP/Permissions-Policy and
trusted shared web code remain their owners' responsibilities.

Load failure, a bounded load deadline, rejected response, and simulated
WebContent termination yield a native unavailable/reconnect view. Reconnect is
explicit, never an automatic authentication or mutation loop. Hide/show retains
the same WKWebView, DOM and cookie store. Reconnect reboots a page session; it does
not silently replace unresolved native capture requests. Clean logout/quit makes
a best-effort revocation of the old scoped page session. Crash revocation is not
guaranteed. Native capture session and unsaved draft are process-memory only.

## Text capture

Explicit native Save posts `/api/v1/sessions` `{title,timeZone}`, then
`/api/v1/sessions/:id/entries` `{text,role:"user",timeZone}`. Each mutation has
its own UUID `Idempotency-Key` and the pinned current `X-Didi-Authority-Epoch`.
The service validates Session's positive revision; entry appends do not carry an
`expectedRevision` field in this API. Existing commitment updates do, but they
are not duplicated in native controls.

An uncertain result retains the immutable text, timezone, epoch, keys and
created session ID. Retry uses that same request, never a new key or edited draft.
A new capture is blocked until the uncertain one resolves. Saved clears the
matching draft only; edits made while an old request runs remain. Cancellation
before dispatch is distinguished from transport loss/cancellation after dispatch,
which is conservatively unknown. No automatic retry runs on expiry, reconnect,
hide/show, or WebContent recovery.

Recording is an explicit native user action with the preserved on-device speech
gate. Automated proof uses only synthetic text and never starts microphone,
playback, permission requests, notifications or broad process kills. This slice
adds no private audio/raw transcript egress or remote microphone authority.

## Evidence limits

`bash Tests/DidiCompanionTests/check-companion.sh` compiles/signs disposable proof
bundles, takes the shared installed `lux-browser-slot` lease, runs actual WebKit
against a bounded disposable HTTP fixture, and preserves the Mac seam/runtime
checks. The installed helper is development tooling, not a public app runtime
dependency. Snapshot proves actual native rendering, not GPU acceleration.
Canvas2D/DOM Naya rendering is owned by the shared web author; no WebGL2 or GPU
claim follows from the WKWebView class or a successful screenshot. Accepted
service+web integration and measurable hardware rendering are separate root gates.
