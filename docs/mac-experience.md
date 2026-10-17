# Mac companion experience

Naya is a regular Mac app: a Dock tile with the Naya icon, a Cmd-Tab entry and a
window that stays in front. It hosts the service's one shared responsive web UI in
WKWebView. Swift no longer duplicates Conversation/Today/Memory business screens
or owns a business store. A compact native Naya voice rail owns consent, lifecycle
and Start, Mute and Stop. Note capture and connection details remain native but
start collapsed below the shared conversation page. See
[companion protocol](companion-protocol.md) for trust and credential boundaries.

## Lifecycle

- Control–Option–Space shows the mini orb from either surface and brings the full
  window back from the orb, through the existing Carbon registration; a
  registration failure is visible and the menu bar remains usable.
- Cmd+W and the close button hide the window and keep the agent, editable draft
  and existing WKWebView; during an active Live session they switch to the mini
  orb instead and the session keeps running. A Dock click always brings the full
  window back. Neither hide/show rebuilds the page.
- Escape hides and stops recording.
- Explicit Quit stops recording, attempts scoped page-session logout, unregisters
  the hotkey and exits. It does not promise crash-time revocation.
- Service failure or WebContent termination becomes a native retry screen, not an
  endlessly blank view. Reconnect is explicit and reboots page authentication.
- Native saved/failed/cancelled/unknown outcomes are distinct; uncertain saves keep
  stable idempotency identity. Retrying does not silently save an edited draft as
  a second entry.

## Two presentation modes

Exactly one surface is visible at a time; a presentation coordinator owns the mode
and every entry point (Dock click, hotkey, orb click, the **mini** button in the
full window, close) goes through it.

- **FULL** is a standard window at the normal level that does not hide when the
  app deactivates. Its header carries a **mini** button with the accessible label
  "Show the mini orb".
- **MINI** is a borderless non-activating floating panel that can become neither
  key nor main, joins every Space, floats over full-screen apps, stays out of the
  window cycle, and moves by its background. It shows listening, thinking and
  talking only: no audio context, no microphone and no Live socket of its own. Its
  frame is remembered and clamped into a visible screen on restore and after a
  display change.
- Live is never started, stopped or restarted by a mode switch, so the session id
  survives every switch.

## Native permissions and effects

Permission requests are explicit native menu actions, separate from Record.
The preserved adapter requires on-device speech recognition and refuses missing
local support; only native Record starts the engine after the grants exist.
Escape, close, Quit, device reconfiguration and system sleep stop recording.
Generation guards discard cancelled session callbacks. The page has no authority
bridge and its media-capture delegate always denies grants. No automated test
requests OS permissions, captures live audio, speaks, sends a real notification,
installs the app or kills unrelated WebKit processes.

Notification adapter/seam checks remain preserved; OS acknowledgement is not
proof of delivery or reading, and Focus can silence it. Notification service
integration is not added in this companion slice. Automated playback proof only
constructs a zero-volume utterance, never starts synthesis. Live microphone and
notification delivery remain untested without explicit user authorization.

## Verification

Run `bash Tests/DidiCompanionTests/check-companion.sh` for disposable signed native
WebKit proof and the retained `Tests/DidiMacTests/check-mac.sh` checks. The producer
uses the installed shared `lux-browser-slot` renderer lease. Compilation and
bundling run before the lease is taken; only the single leased run phase does
the LaunchServices registration, native launch, UI/AX capture and browser work.
It has no role in
public app runtime. `LUX_DIDI_PROOF_DIR` may select the output directory for the
actual WKWebView screenshot; otherwise a portable, run-unique temporary proof
directory is printed as `PROOF-DIR` and retained for inspection. Remove that
artifact directory after inspection; disposable app bundles/servers are still
cleaned on producer exit.
The Mac proof still exercises close/Escape/hotkey callback retention and safe
voice/notification checks with the canonical changed setup UI.

A fixture screenshot is not accepted Naya/service integration, a global hotkey
keystroke proof, or GPU acceleration evidence. The shared web author owns the
Naya Canvas2D/DOM source/provenance. Root coordinates the accepted service+web
runtime gate before claiming a working standalone integrated local app. No local
app installation occurs in this task.

### Installed synthetic proof

`--installed-proof --proof-state /owned-private/state --proof-report /owned-private/result.json`
uses a marked isolated state directory and the actual installed HOST/shared UI.
Reopen preserves prior service records; the lifecycle marker contains identity
only. The report distinguishes observed functional persistence/accessibility
from native-chrome visual review, and leaves native exit to the external driver.
It first captures the actual production RootView with the secondary disclosures
collapsed, then opens note capture through its accessibility action before the
existing control assertion and expanded whole-window capture. The expected
accessible controls stay Start recording, Stop recording, Send to Naya and Save
note.
No real appdata, permission prompt, live microphone, playback or notification
is involved. See [the companion protocol](companion-protocol.md) for rejection,
reinstall/relocation and versioned reporting semantics.

## Protected operator configuration

An operator may select an existing absolute provider config directory and owner
profile file through the app executable's configure mode, which validates and
writes the per-user `ai.peat.lux-didi-operator` store (directory 0700, file
0600) using the same Swift validator the launch reads. Absent settings keep the
public default; a configured invalid store refuses before the host is spawned.
Launch only forwards the two existing host path flags. See
[building and installing the Mac app](macos-install.md).

The shared conversation page is always present, so the native window does not add
a second conversation control or transcript. Configured session and idle limits
appear in Connection details; a limit-ended session explains how to continue
explicitly. The read-only Connections card shows each connector's state and safe
reason, with ten-second refreshes only while its disclosure is open. Unavailable
connection status is shown explicitly. The app scopes Aqua appearance to its own
window and SwiftUI root.

## Live routes and local service recovery

The Live panel displays the current microphone and system output. Changing only the output rebuilds audio inside the same authorized session, preserving mute and discarding queued playback rather than replaying it. Changing the default microphone releases capture and asks “Microphone changed to <device name>. Resume?” Explicit Resume is required, and it rechecks the device identity. No valid microphone or a failed rebuild instead presents Restart with capture released. Hiding the window still stops capture; route recovery does not change that rule or the activation policy.

An owned local-service exit stops Live and displays persistent “Local service restarting” status. Replacements use a bounded three-attempt budget with 1/2/4-second backoff. Exhaustion asks for explicit Reconnect; Quit or disconnect cancels recovery. Wake reconciles child liveness and service health, while a network failure alone never causes child replacement. The restored service connection discards the old conversation and its stale authority, but does not restore microphone authorization: the owner must explicitly Start a fresh Live conversation using the replacement service authority. A wake health check with unchanged authority does not discard an active conversation.

Silent injected tests exercise the real audio converter, capture queue and device drain, including preserved mute and discarded stale frames. Lifecycle seams use injected scheduling, launch outcomes and wake events, never real timeout waits. Physical AirPods/USB transitions, voice-processing effectiveness and acoustic behavior remain human-device acceptance items.

### Summon and microphone availability

Control-Option-Space remains Show/hide and never starts capture. Explicit Start
Live in the menu or Control-Option-Shift-L shows the window and uses the same
guarded Live start. Control-Option-Shift-M toggles mute; menu controls also offer
Mute/Unmute and Stop. These three-modifier letter combinations avoid common
macOS defaults; custom user shortcuts can still conflict. Each Live shortcut's
registration result is visible in the menu, including its OSStatus on conflict.
Live is full duplex, not push-to-talk. Muting discards captured frames. Hide and
close still stop capture, and Show never resumes it.

The status icon, accessible label and menu describe stopped, connecting,
listening, speaking or muted. A pending-call dot is independent of microphone
state and never starts capture.

Open at login is opt-in in the menu (macOS 13 or later). Its text reflects the
system registration status, including approval required or unavailable, rather
than a saved preference. Login launch starts hidden and never captures audio.
The window frame is remembered; a frame no longer contained on a connected
screen falls back to a centered, screen-sized frame. Proof launches do not
change login registration or saved window preferences.

The native draft button is **Save note**: it saves a local note, not connected
chat. Retry uses the same local save path.

## Support snapshot

The status menu offers **Reveal logs** (opens the log directory) and **Copy
diagnostics**, which puts a plain-text snapshot on the clipboard for pasting to
an assistant: app version, installed release commit, macOS version, service
state (connected, restarting, stopped, connecting) with its origin port, the
current Live state, the session and idle limits when known, each connector id
with its state, the current audio route names, and the last typed pre-CREATE
failure class and code from `logs/native-live.log`. Missing inputs read
`unknown`. The snapshot never carries tokens, cookies, keys, bearer values,
file contents, transcripts, memory or persona text, mail, or any path inside
the owner's home; a value that looks like a credential is replaced by
`unknown`.
### Callback notification consent and fallback

Choose **Enable callback notifications** in the native voice controls to request
notification permission. If denied, the menu bar pending-call badge and pickup
menu remain available while the app runs, including with its window closed.
Callbacks never start the microphone automatically and notifications never include
result text. Offline polling clears stale offers and displays **Callbacks offline**.
A notification for a job that is no longer pending leaves any current conversation
running and explains that the callback is unavailable. Notification submission
retries are limited to three per job per launch; successful submission or pickup
prevents further submissions in that launch. Quitting the app stops polling.

## Getting started

The menu bar's **Getting started** sheet shows microphone and notification
permission states, the actual Open at login registration, global shortcut
defaults and current Connections status. It appears once for this onboarding
build after a normal launch. Proof and self-check launches do not consume the
flag. It never requests a permission automatically. Explicit setup buttons
request a not-yet-decided microphone permission, open the microphone privacy
pane for a denied permission, or use the existing notification permission
affordance. A denied notification permission links to Notifications settings.
Open at login reuses the existing opt-in toggle. Refresh status re-reads the
service without changing its settings.

Connector next steps are fixed, connector-specific instructions; **Copy command**
can only copy the calendar sign-in command. It never reads or copies a credential.
The page Settings panel shows the same fixed next steps. See [User guide](user-guide.md)
for daily use, deletion limits and the two operator setup steps.
### Separate note and connected actions

**Save note** still writes a local note. **Send to Naya** sends the draft to the
conversation selected in the embedded shared conversation view, using its existing
paired page authority. Enable connected chat in that view first; selecting a
conversation is not consent. The server resolves either conversation consent or a
valid standing consent. The native action never grants consent.

An uncertain send retains its original conversation, text and request key in the
local outbox. Return to that conversation to retry; reconnecting to a different
assistant or authority cannot retarget it. Edits made while a send is uncertain
remain in the draft after the original request is acknowledged. Results appear in
the shared conversation view, not a second native transcript.

The built application's existing `--self-check` path runs a silent synthetic
production-AppModel proof using an isolated URL transport fixture, without a real
model provider, microphone capture or installed application state.
The proof follows the run ID returned by the production action through the same
`GET /api/v1/chat/{runId}` route used by the shared conversation view. Its fixture
advances from accepted to terminal on bounded reads, then checks a nonempty final
answer and the selected conversation's matching session and latest run ID.
