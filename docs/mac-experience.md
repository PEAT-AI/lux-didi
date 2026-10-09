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
uses the installed shared `lux-browser-slot` renderer lease. It has no role in
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
