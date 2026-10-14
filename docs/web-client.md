# Didi web client

A responsive, same-origin PWA client of the authoritative Didi service. The
browser keeps **no private records, auth token, or mutation queue in persistent
storage**. Conversation captures, commitments, corrections and recall use real
HTTP. Model replies are disabled when the service says no model is configured.
The native Mac companion is a separate device client; a browser cannot control
it or grant its permissions.

## Local use

Requirements: Node 26+ for this package, the service, and the isolated SQLite browser fixture;
npm; installed Playwright Chromium; `lux-browser-slot` on the managed host.
Vite itself has a lower upstream floor, but Didi supports Node 26+ consistently
for installation, development, builds, and checks. Dependencies are pinned in the separate
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
The supported composed host is `server/dist/host/index.js`: it injects Domain
and Chat and serves the built browser shell. The supported standalone
`server/dist/index.js` / `npm --prefix server start` is runtime-only and does not
supply that shell or those Domain/Chat capabilities. See
[service-runtime.md](service-runtime.md); the two entries are not interchangeable.
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
  source-linked commitment from a message. Local Save posts a user entry to
  `/api/v1/sessions/:id/entries`, creating a session if needed; it never sends to
  a model. A successful Save clears the draft; failure or Stop waiting retains
  it without claiming that an ambiguous request was not saved.
  **Ask Didi** scrolls to the separate connected composer; it does not send the
  local-note draft. Connected Start/Send uses `/api/v1/chat` and a durable Chat
  Run, not a generic job ID or `/jobs/:id` polling. It requires explicit route consent; its
  Cancel model run action cancels durable work, not merely subscription waiting.
  Neither cancel nor revoke can retract bytes already sent.
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
waiting after 20 seconds. Connected runs use authenticated fetch SSE and durable
GET recovery rather than legacy model-job polling. Polls, reconnect and focus
never create model work or retry a mutation.

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

Focused acceptance covers local Save without model dispatch, failed Save preserving the draft, stop
waiting, loading, stale revision, date correction, complete/reopen, source
recall, denied/offline behavior, CSRF/cookie transport, private cache isolation,
keyboard skip/focus/live regions, locally authored manifest/icon, and overflow
at 375px/768px. Artifacts default to the ignored, repository-relative
`web/test-artifacts/` directory. `DIDI_WEB_ARTIFACTS` overrides that directory;
managed check configuration supplies an explicit private review output path.
The check logs its resolved output directory. No developer home path is baked
into the client or test source. Actual
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
WEB-R4. `src/orb.ts` owns the framework-independent Canvas lifecycle and Naya voice
state adapter. Durable assistant records still use the generic Didi identity.
Provenance, exact line ranges and deliberate adaptations are in
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

## Connected Naya conversation

The shared orb and existing layout remain. Local **Save message** is a local note,
not a model send; the old undisclosed Ask action is disabled. The separate
**Start connected conversation** action requires agreeing to the named, locally
validated provider/model and its disclosure. Only this conversation's current and
selected earlier whole turns are sent. Local notes, Today, recall, other sessions
and tools are not part of model context.

Connected history is recovered through authenticated actual service routes. The
browser uses fetch SSE with the existing cookie, CSRF and current authority epoch;
no URL token, native bridge, request interception or product fixture mode is used.
Provisional chunks, a saved answer and a terminal failure render distinctly.
Disconnect only detaches a subscriber. Recovery fetches saved state and never
resends; cancellation and conversation revocation are explicit actions. Failed
acceptance preserves the draft and stable request key across rebootstrap. Editing
and explicitly sending a different message uses a new key. A changed route pauses
the old conversation while preserving its history; start a newly disclosed one.

The focused proof is `bash scripts/check-connected.sh`. It uses the real shared
browser/host/SQLite/compiler/Gemini adapter with synthetic ordinary input and a
trusted controlled transport, not live Gemini. Hardware-GPU desktop and 375px
captures are acceptance artifacts, not native/audio or production reachability
claims.

## Live Naya surface in the shared page (WEB-D / issues #85, #91)

The shared page keeps the Vicuna-derived default orb visible in every conversation
state and now reflects the read-only live projection. `src/live-view.ts` renders a
truthful state label in an `aria-live` region (idle, listening, speaking,
thinking, ended, error) and never says "recording"; the thinking label names
the tool in flight, for example "Thinking (search)", and a muted indicator
appears only when the projection reports it. The page has no record button and
no mute control: there is nothing to press, the orb reflects listening, speaking
and thinking continuously, and typing stays the secondary input. The orb
caption's own label follows the same live state (they never disagree), and its
"Not listening" note appears only when the projection is not in an active turn.
The section folds adjacent transcription fragments from the same role into one
visible turn until a role change, `turnComplete`, `interrupted` or terminal event.
Fragment text is concatenated exactly, without adding spaces or removing repeated
text. The newest accepted `toolResult` is the prominent Latest answer, and the
latest spoken Naya turn stays readable beneath it. The full transcript and tool
activity remain reachable from a labelled disclosure on the same Conversation
page, with sanitized Markdown and clickable source links. The disclosure keeps
the user's open or closed choice across live polling.
The label never claims that speech was heard or a task finished beyond what the
projection says; an error state says only that Naya reported an error.

`src/markdown.ts` is a dependency-free renderer for headings, paragraphs, bold,
italics, lists, code spans/blocks and links. Every model string is HTML-escaped,
only `http:` and `https:` links become anchors (`target="_blank"`,
`rel="noopener noreferrer"`), and no raw HTML passes through. `src/api.ts` and
`src/protocol.ts` add the typed client for `GET /api/v1/live/current[?cursor=n]`
(same-origin cookie, no bearer). `src/main.ts` polls at 1 Hz while the projection
is active and every 4 s while idle, and pauses while the document is hidden; the
orb maps listening/thinking/speaking to its listening/thinking/speaking postures
through the existing orb API and honours `prefers-reduced-motion`.

The projection route is provided by the live service wagon. Until it exists the
route 404s and the page keeps its last honest state rather than inventing one.
The unit tests are `node --test test/markdown.test.ts test/live-view.test.ts`, run
by `npm --prefix web run check` before the shared-renderer browser pass, which adds
a fixture-served Interface 3 payload asserting the orb is in speaking mode and a
rendered source anchor exists.

## Live view freshness

A failed Live poll shows a stale banner with the last successful poll time while
keeping the transcript visible. The next successful poll clears the banner;
a 404 still means no session, not an unreachable service.

## Conversation boundaries

A changed projection `since` starts a fresh transcript. Pages with the same
session start accumulate by sequence number; a cursor from the old session is
not reused for the new conversation.

## Inspecting tool answers

Every tool result has an expandable card with its status, markdown and sources.
Error results show their status without markdown. The Latest answer summary
continues to show the newest accepted answer.

A `remember_note` result is different: it renders as an evidence card (`web/src/live-view.ts`). A successful result shows **Remembered** with the saved words; a named decline code (`already_remembered`, `private_memory_unsupported`, `owner_transcript_not_final`, `owner_text_mismatch`, or a tool refusal) shows **Not remembered** with a one-line honest reason; any other bare result code, including the service's `handler_outcome` (which at this revision covers both a saved and a declined note), shows a neutral **Memory** card that reports the outcome was not given. Cards link to the memory list. The Live projection carries only name, status, markdown and sources (`server/live/types.ts`), so the card never invents the note's kind or time; it renders the result text the service projects.

## Connections

The read-only Connections card polls `/api/v1/live/connections` every 10 seconds
while the page is visible, using its existing browser cookie. Each row shows the
endpoint id, state, tool count, last handshake and a fixed repair hint for a
sanitized reason code. Raw diagnostics, credentials and configuration are never
rendered. Failed polls mark the displayed connection values as stale.

## Live summary

The read-only Live summary reads `GET /api/v1/live/summary` with the existing
browser cookie (the operator bearer is accepted too); the operator-only
`/api/v1/live/status` still refuses the cookie. The response is a closed
whitelist, `{modelId, voice, personaName, limits: {sessionMs, idleMs},
profileEnabled}`, carrying the configured model and voice, the persona display
name and the session and idle limits, and nothing else: no key reference, no
endpoint, no provider credential and no persona or system prompt text. When Live
is unconfigured or disabled the route still answers 200 with `profileEnabled`
false and the other fields null.
## Didi settings summary

The Settings tab carries one read-only "Didi settings" panel so the owner can see
what this Didi is running with without opening a file or a terminal. It renders
only fields the page already fetches: the persona name, conversation model and
service mode from `GET /api/v1/status`, and every configured connector from
`GET /api/v1/live/connections` with a fixed state name (`Configured`,
`Connected`, `Failed`, `Credential missing`) and a one-line next step. Session and
idle limits are shown in whole minutes when a Live status payload carries them.

The panel also names, by file name only, where each setting lives on disk under
the operator config dir (`live.json`, `profile.json`, `gemini-primary.json`,
`provider-config/mcp.json`) and labels them "changes need a restart of Lux Didi".
File contents are never read or shown. The view whitelists and escapes each field
by name, so a secret-looking field on a route payload cannot reach the page. A
failed route shows "Unavailable" for that group rather than stale values.

`GET /api/v1/live/status` is operator-bearer-only, so the page instead reads the
browser-safe `GET /api/v1/live/summary` for the Live model, voice, persona name and
the session and idle limits, shown in whole minutes. When the route answers with
`profileEnabled` false the panel shows "Live profile disabled" rather than invent
a model or voice. A failed or forbidden summary leaves the connector rows intact
and shows "Unavailable" for those Live rows only, never a stale value; the panel
renders only the whitelisted keys `modelId`, `voice`, `personaName`,
`limits.sessionMs`, `limits.idleMs` and `profileEnabled`.


## Live summary

The read-only Live summary reads `GET /api/v1/live/summary` with the existing
browser cookie (the operator bearer is accepted too); the operator-only
`/api/v1/live/status` still refuses the cookie. The response is a closed
whitelist, `{modelId, voice, personaName, limits: {sessionMs, idleMs},
profileEnabled}`, carrying the configured model and voice, the persona display
name and the session and idle limits, and nothing else: no key reference, no
endpoint, no provider credential and no persona or system prompt text. When Live
is unconfigured or disabled the route still answers 200 with `profileEnabled`
false and the other fields null.

The Live page projection may include optional `pastSession` metadata. Past sessions render as the last Live session, not a current error. `endedAt` is the persisted terminal timestamp; an orphan has null `endedAt` and an unknown outcome, with `lastObservedAt` shown explicitly as last seen. Active session labels are unchanged.
