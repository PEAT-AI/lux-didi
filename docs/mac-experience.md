# Mac companion experience

Naya is a regular Mac app (Dock tile, Cmd-Tab entry, menu bar item) whose resting surface is a floating orb in the top right corner. The full window is optional and is created the first time it is asked for. Both surfaces host the service's one shared web UI in WKWebView. Swift does not duplicate Conversation, Today or Memory screens and owns no business store. A compact native voice rail owns consent, lifecycle and Start, Mute and Stop. Note capture and connection details stay native and start collapsed below the shared conversation page. See [companion protocol](native-app.md#native-companion-protocol-and-trust-boundary) for trust and credential boundaries and [architecture](architecture.md) for the whole picture.

## Launch

What a start may do is decided once, by `LaunchKind` in `SingleInstanceGuard.swift`:

- Owner opens the app: the orb appears and one call connects by itself, only when the host is up and the orb page can be shown. A refusal (denied microphone, refused audio owner) is final for that launch, so it never loops.
- Login item: the orb appears, nothing connects, no capture.
- Install relaunch (`--install-relaunch`): the orb appears, nothing connects.
- Dock reopen: the orb is ordered front and nothing else happens. It is its own launch kind, no full window is created, nothing becomes key and the app never activates, so the Dock cannot rearrange the owner's other windows.
- Proof and self-check launches: no orb, no connect, a window only where the proof drives one; a second instance exits with code 3 so a yielded proof can never read as a pass.

Every launch and every Dock reopen writes one content-free `launch_kind` line carrying the kind, `autoConnects` and `windowShown`, into `native-live.log` and to the host so `host.log` carries it too. A launch kind is never inferred from LaunchServices.

An interactive launch waits up to four seconds for the calendar connector to publish before it starts the call, so the opener composes with a digest; past the bound the call starts and the digest reads absent.

A stop is the owner's, so the native side never waits for the host to go cold: a local stop cancels the transport after 500 ms and records `live_stop_outcome` as `confirmed` or `deadline`, and a socket that closed without a terminal frame takes presence cold at once with no reconnect.

## Surfaces

The orb (MINI) and the window (FULL) are independent; a `PresentationCoordinator` owns which are visible and every entry point goes through it. It never touches Live, so no switch starts, ends or restarts a call.

- **MINI** is a borderless non-activating floating panel that can become neither key nor main, joins every Space, floats over full-screen apps and stays out of the window cycle. It defaults to the top right under the menu bar clock, moves by drag, and its frame is remembered and clamped onto a visible screen after a display change, heard from the panel's own init so an unplugged display cannot strand it. Clicks beside the orb reach the app underneath. It follows presence: grey and dim when cold, the connecting look while opening, colour while live, purple while muted. Showing an orb that is already on screen does nothing, which removed an old flicker; only a Dock reopen orders an orb that is already there front again.
- **FULL** is a standard window that does not hide when the app deactivates. Cmd+W and the close button hide it and keep the draft and the page; they never end a call. It opens only when the owner asks for it: the **Open Naya app** menu item, Control Option Space, the orb's expand, Settings, or an install relaunch. A Dock click shows the orb and no window.
- Control Option Space and Control Option Shift Space toggle the FULL window. Escape closes the window if it is open, otherwise hides the orb. Explicit Quit stops recording, attempts a scoped page-session logout, unregisters the hotkeys and exits.
- Service failure or WebContent termination becomes a native retry screen, not a blank view. Reconnect is explicit and reboots page authentication.
- Native saved, failed, cancelled and unknown outcomes are distinct; uncertain saves keep a stable idempotency identity.

Right-clicking the Dock icon offers the four menu bar actions as a Dock menu: **Open Naya app**, Settings, then Start Live and Mute (Mute reads Unmute while she is muted), and macOS adds Quit itself. The items carry the menu bar's own actions, so choosing **Open Naya app** there is the one Dock interaction that opens the FULL window and activates the app, exactly like the menu item; a plain Dock click still shows the orb alone.

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
is involved. See [the companion protocol](native-app.md#native-companion-protocol-and-trust-boundary) for rejection,
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

Control-Option-Space and Control-Option-Shift-Space toggle the full window and never start capture. Explicit Start Live in the menu or Control-Option-Shift-L shows the window and uses the same guarded Live start. Control-Option-Shift-M toggles mute; menu controls also offer Mute/Unmute and Stop, and a bare tap of Right Command drives start, mute and resume (see the [user guide](user-guide.md)). Each shortcut's registration result is visible in the menu, including its OSStatus on conflict. Live is full duplex, not push-to-talk. Muting discards captured frames and closes the capture fence at once.

The status icon, accessible label and menu describe stopped, connecting,
listening, speaking or muted. A pending-call dot is independent of microphone
state and never starts capture.

Open at login is opt-in in the menu (macOS 13 or later). Its text reflects the
system registration status, including approval required or unavailable, rather
than a saved preference. A login launch shows only the orb and never captures audio.
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
build, on the first time the owner opens the full window; a launch that shows only the orb shows
no sheet. Proof and self-check launches do not consume the
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
