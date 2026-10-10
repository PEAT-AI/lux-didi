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

A local page attempt has a five-second deadline covering cookie preparation and
document load. Ready requires an approved HTTP response AND canonical URL; a
WebKit internal error document completing without a response is unavailable, not
ready and not left loading. Withheld responses hit the finite deadline. Explicit
reconnect starts a fresh attempt; stale navigation callbacks cannot finish it.
Load failure, this bounded deadline, rejected response, and simulated
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

## App-owned installed service (native extension; combined proof still required)

A build-generated `Contents/Resources/didi-runtime.json` selects installed mode.
The native schema uses `schemaVersion: 1`, installId UUID, releaseCommit40hex,
absolute nodePath, nodeMajor26 and resource-relative serverEntry/webRoot. The
installer owns the actual machine path and release identity; no machine paths or
runtime credentials are committed. A present invalid manifest never falls back
to explicit attach mode. Relative paths cannot traverse or escape resources by
symlink. State derives from macOS Application Support/ai.peat.lux-didi with
current-owner0700 directory; proof executables alone have explicit test overrides.

Native launches verified Node directly with a scrubbed environment (no shell,
PATH fallback, NODE_OPTIONS/NODE_PATH/DYLD injection). A bounded probe checks the
actual major and built-in SQLite. The service argv is exactly serverEntry,
`--supervised --data-dir <state> --web-root <webRoot> --port 0`. Only one owned
child is started. Private stdin carries one HOST-R3 `{type:"start",schemaVersion:1,
nonce}` line and remains open for liveness. One stdout ready line, at most1024
bytes, must match schema/type/fresh nonce/live owned PID, exact127.0.0.1 origin,
UUID authorityEpoch and assistantId. Stale disk descriptors never select a port.
The ready frame does not include a release commit; native does not invent one or
claim signed/notarized provenance from it. Installer validation supplies the
manifest/resource release boundary; same-UID malicious code is not a sandbox claim.

Only after readiness, native opens canonical admin-credential relative to a
validated private directory FD using O_NOFOLLOW, checking regular/current-owner
0600 and bounded/header-safe bytes. Store's single terminal LF is file framing:
native removes that LF before validation, Keychain comparison/import and bearer
use; only the canonical 43-character base64url token is accepted. Interior or
repeated LF, CR, whitespace and malformed tokens remain rejected. An unframed
canonical token remains compatible. It imports via noninteractive Keychain API to
fixed service ai.peat.lux-didi.admin/account lowercase installId. A differing
existing item is an explicit blocker, never silent credential rotation/deletion
or ACL broadening. The canonical service file remains. Synthetic unique Keychain
services exist only in proof builds and are removed by their test owner.

Every installed native REST request checks current owned-child identity before
credential lookup/dispatch. Explicit restart rebinds only after fresh readiness,
retaining unresolved text/UUID/epoch rather than silently saving a new request.
Bootstrap checks the readiness epoch against authenticated status. Unexpected
child exit clears the page and requires explicit reconnect; there is no automatic
restart/retry loop. Hide/close retains the child. Quit first awaits bounded scoped
logout, then closes stdin, then applies bounded TERM/owned-PID KILL only if needed.
The actual HOST's supervised EOF contract owns crash cleanup; protocol fixtures
are not combined HOST/web installation proof. No launchd or installation effect
is added by these native sources.

## Isolated installed executable proof

The ordinary installed executable accepts exactly:

```sh
Contents/MacOS/LuxDidi --installed-proof --proof-state /owned-private/state --proof-report /owned-private/result.json
```

This is an explicit synthetic-only mode, not an attach shortcut. Missing,
duplicate, relative or mixed flags fail before normal startup. State must be
outside normal appdata (including its ancestors/descendants), with an owned0700
parent/directory. New state must be empty; existing state must carry the exact
owned0600 `didi-installed-proof.json` lifecycle marker with type
`didi-installed-proof-state`, schemaVersion1, installId and stable proofId.
No business records are stored in the marker, and reopening never deletes or
reseeds service data. The real installed manifest, verified owned HOST process,
canonical private credential file, noninteractive synthetic-scoped Keychain
account and normal bootstrap/client/UI paths are used; there is no fixture HOST
fallback. Normal install credentials are not read or changed.

Version1 JSON reports use type `LuxDidiInstalledProof`, schemaVersion1,
phase (`running`, `complete`, `failed`), success, runId, installId, proofId,
reopened, source, native, service, priorRecords, newRecord, observations, visual,
serviceStop, credentialCleanup and error. Record fields are exact sessionId,
entryId, full synthetic text and visibleInCanonicalUI. Previous records come
from authoritative untruncated recall/session APIs and are verified in the
canonical UI before one new native synthetic save. Source identity records the
manifest releaseCommit and actual executable/manifest/server-entry SHA256s;
the external build driver must pin them to accepted source. Readiness reports
live owned PID/nonce/origin/epoch/assistantId without secrets. serviceStop
records observed owned exit/status/reason after private stdin/bounded stop.
Native pid/cleanQuitRequested are reported, **not native exit**: the external
driver must observe native exit0 and reject stale/running reports. Early
argument/ownership/config rejection can exit without a new report; never read
a previous successful report after a nonzero invocation.

CGPreflightScreenCaptureAccess is probed, never requested. SDK14.4 explicitly permits `SCShareableContent.currentProcess` content capture
without TCC consent: only that API and the exact live own window are used,
under a four-second one-shot deadline, even when the preflight is false.
Failure/unavailability yields actual WK page snapshot and actual own
accessibility names/enabled/visible states with an explicit native-chrome
visual limitation; late results cannot create claimed artifacts. Missing capture
permission does not block functional proof. Native chrome remains a separate
visual review; an NSView cache image is not faithful evidence. The external
producer owns the shared rendererlease; the public app does not depend on
private harness tooling. No microphone, playback, notifications, model calls
or OS grant prompts are introduced by proof mode.
