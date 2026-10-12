# Mac companion experience

The Mac menu-bar/hotkey shell hosts the service's one shared responsive web UI in
WKWebView. Swift no longer duplicates Conversation/Today/Memory business screens
or owns a business store. Local native controls remain a narrow draft/record/save
strip and service setup/unavailable/reconnect state. See
[companion protocol](companion-protocol.md) for trust and credential boundaries.

## Lifecycle

- Control–Option–Space toggles the window through the existing Carbon registration;
  a registration failure is visible and the menu bar remains usable.
- Escape hides and stops recording. Window close also hides, retains the agent,
  editable draft and existing WKWebView. Neither hide/show rebuilds the page.
- Explicit Quit stops recording, attempts scoped page-session logout, unregisters
  the hotkey and exits. It does not promise crash-time revocation.
- Service failure or WebContent termination becomes a native retry screen, not an
  endlessly blank view. Reconnect is explicit and reboots page authentication.
- Native saved/failed/cancelled/unknown outcomes are distinct; uncertain saves keep
  stable idempotency identity. Retrying does not silently save an edited draft as
  a second entry.

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

The Live panel includes Show conversation, which focuses its embedded conversation
rather than opening a browser. Configured session and idle limits appear beside
Start; a limit-ended session explains how to continue explicitly. The read-only
Connections card shows each connector's state and safe reason, with ten-second
refreshes only while visible. Unavailable connection status is shown explicitly.

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
