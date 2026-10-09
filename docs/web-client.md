# Didi web client

A responsive, same-origin PWA client of the authoritative Didi service. The
browser keeps **no private records, auth token, or mutation queue in persistent
storage**. Conversation captures, commitments, corrections and recall use real
HTTP. Model replies are disabled when the service says no model is configured.
The native Mac companion is a separate device client; a browser cannot control
it or grant its permissions.

## Local use

Requirements: Node 26+ for the service and the isolated SQLite browser fixture;
npm; installed Playwright Chromium; `lux-browser-slot` on the managed host.
Vite itself supports Node 20.19+/22.12+. Dependencies are pinned in the separate
`web/package-lock.json`. No external font, image, analytics, or CDN request.

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
npm --prefix web run build
npm --prefix web run check
```

`dev` binds only 127.0.0.1; its same-origin `/api` proxy targets the local service
at `http://127.0.0.1:4317`. The service must accept the browser's exact origin for
pairing and writes. Prefer serving `web/dist` from the service origin for real
use; the service pair owns static serving and permitted-origin configuration.
No tunnel, public deployment, or scheduled task is provided. Production requests
always go to same-origin `/api/v1`, never a hard-coded remote service.

Get a one-time code from your local operator service, then enter it into **Pair
this browser**. It is sent only in a JSON POST body, never a URL. The service
uses an HttpOnly SameSite=Strict cookie. The CSRF token stays in memory and is
restored via authenticated `/api/v1/auth/session` after reload. **Unpair this
browser** revokes the server session and clears this browser's in-memory view.
The browser never requests or stores the local admin bearer credential.

Auth paths follow service/API.md, contract source
`f640274fe8ea83bf7687f26d709c399a0961148e`: `POST /auth/pair`
`{pairingCode}` → `{csrfToken}`, `GET /auth/session` → `{csrfToken}`,
`POST /auth/logout`. Writes include `X-Didi-CSRF`, `Idempotency-Key`, and
`X-Didi-Authority-Epoch`. Record edits/transitions include `expectedRevision`.
A stale revision fetches the latest record and requires explicit review; it
never overwrites silently. An ambiguous network outcome retains the original
volatile idempotency key for the same request. A changed authority invalidates
loaded records. No offline writer exists.

## What you can do

- **Conversation:** save your own words, reopen conversations, make a
  source-linked commitment from a message. Ask Didi only when a model is
  configured. Stop waiting is not cancellation of an already sent server write
  or model job; the UI says so and preserves the unsent draft.
- **Today:** server-defined due/overdue and unscheduled commitments; correct a
  title, notes or date; complete, cancel or reopen; inspect service history.
  Recently completed/cancelled records remain visible during this visit.
- **Memory:** source-linked recall with explicit unavailable sources, no invented
  memory. Source links open the relevant service conversation.
- **Settings:** connection, model configuration, time zone, current browser
  notification status and honest Mac/microphone limitations. It does not claim
  browser notification delivery or microphone access.

Dates are displayed in the browser's IANA time zone and sent as UTC instants.
The service—not the client—decides plan membership, revision validity,
transitions, and reminder behavior. Pagination cursors are reported as partial
views; this first protocol provides no agreed cursor input to fetch next pages.
No private data is seeded at startup.

Status polls every 30 seconds, backs off up to 120 seconds on failures, and stops
while hidden. Each connection request times out after eight seconds; writes stop
waiting after 20 seconds. Model jobs poll at 2.5 seconds with a two-minute cap,
and pause when offline/hidden. Polls never create work or retry a mutation.

## PWA privacy

The build emits a service worker with an exact hashed app-shell asset allowlist.
It caches only `/`, `/index.html`, the manifest, the locally authored SVG icon,
and built `/assets/*` names. It never intercepts API requests, non-GETs,
queries, or another origin. No private response goes in CacheStorage.
Offline opening is not offline saving. Installation depends on the platform's
secure-context/install rules; responsive Android-sized browser proof is **not**
an actual Android device installation claim.

## Check and artifacts

`check` typechecks, builds, then takes the shared renderer lease
`lux-browser-slot run --priority worker --want 1 --wait 240`. One headless
GPU-enabled Chromium instance drives an isolated synthetic HTTP/SQLite server;
there is no browser route mock or private service storage. The fixture begins
empty and adds a visible **Demo test mode** banner only in its own served HTML.
The production shell never contains that marker or synthetic credentials.

Focused acceptance covers capture, failed send preserving the draft, stop
waiting, loading, stale revision, date correction, complete/reopen, source
recall, denied/offline behavior, CSRF/cookie transport, private cache isolation,
keyboard skip/focus/live regions, locally authored manifest/icon, and overflow
at 375px/768px. Artifacts default to the private assigned WEB report directory;
`DIDI_WEB_ARTIFACTS` can redirect artifacts on another local checkout. Actual
renderer and durations are recorded as JSON. Screenshots require coordinator
inspection. No CI workflow or paid CI is introduced.

The synthetic fixture is protocol evidence, **not actual service integration**.
The next runtime integration must serve these assets from the accepted service,
pair via its real operator-issued code, and repeat capture, correction/conflict,
complete/reopen, recall and cookie/CSRF/cache checks against its real database.
Do not infer that proof from matching DTOs or a green synthetic fixture.

## Canonical UI inside the Mac shell (WEB-R3)

The same built web assets are intended for the companion's WKWebView; there is
**no JavaScript native capability bridge, message handler, injected bearer,
remote microphone control or browser microphone fallback** in this client.
Native record controls and on-device speech remain companion-owned. Recognized
text reaches the service API; this page only reads the service state. Automatic
browser capture is intentionally absent, and permissions policy denies it.

The serving integration must apply `web/security-headers.json` to shell/assets.
It requires `frame-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self'`,
no remote/eval/inline scripts, and microphone/camera denial. A matching meta CSP
provides a shell fallback, but **frame-ancestors works only in an HTTP response
header**, not meta. The isolated fixture serves/asserts the real headers. The
service pair owns applying them to actual static serving; matching tests do not
prove accepted-service deployment. Native owns exact navigation allowlisting,
nonpersistent WKWebsiteDataStore, cookie bootstrap and window lifecycle.

## Familiar orb, honest voice state (WEB-R2 / WEB-R4)

`src/orb-classic.ts` reuses bounded first-party procedural drawing/helpers from
Vicuna/Naya at `f27bca7bcbc77a77e3401da2683abf2f1aaf023c`, explicitly authorized by
WEB-R4. `src/orb.ts` owns the framework-independent Canvas lifecycle and Didi
state adapter. Provenance, exact line ranges and deliberate adaptations are in
`src/orb-provenance.md`. No Angular, Sentry, persona, screenshot or private app
configuration was copied. It is a bounded classic renderer adaptation, not a
pixel-identical extraction of all visual effects or a new WebGL2 implementation.

The closure retains the classic noise-deformed layered core, luminous glow,
radial tentacles, current frame-delta clamp, asymmetric smoothing time constants,
and speaking activity/offset helpers. `simplex-noise` 4.0.3 supplies the isolated
noise function instead of the source's unprovenance inline noise class; its MIT
notice is in `public/third-party-notices.txt` and linked in Settings.

States separate connecting/thinking, idle/connected, listening, speaking and
quiet/error/disconnected. A latest normalized audio frame has
`level/low/mid/high/flux/timestamp`; processing with level above 0.01 has speaking
posture, otherwise thinking. Current production inputs are always silent; only
real service connection/request activity is mapped. The orb **never claims
listening or speaking** without actual audio. The caption says **Not listening**,
and points to the native Mac record control. No audio permission, record control
or fabricated microphone/FFT data is added to the web UI.

Animation uses clamped delta-corrected asymmetric smoothing, a 24fps idle/30fps
active draw budget, capped pixel ratio, no per-sample DOM rerender, and
requestAnimationFrame. Reduced-motion draws one static frame; hidden documents
stop animation. Teardown removes observers/listeners and cancels its frame. The
browser check pins actual paint, idle/not-listening, static reduced-motion frames
and actual normal-host idle draw cost against its frame budget, recorded to
`orb-frame-budget.json`. No synthetic load or audio capture is used. WKWebView
appearance/runtime and actual voice delivery remain companion integration work.
