# Native Mac experience — first independent slice

This is an AppKit menu-bar agent hosting SwiftUI, built with Command Line Tools.
It is **not domain-integrated yet**: the `AppDomainPort` boundary is deliberately
supplied by `DisconnectedDomain`. No competing commitment store, account fixtures,
SQLite imports, network calls, retry queue or private character prompt live here.
Drafts are ephemeral and sending a disconnected draft reports failure without
clearing it. Today and Memory distinguish disconnected from an empty real account.

## Controls

- Control–Option–Space toggles Conversation through a registered Carbon hotkey;
  failure is visible in Settings, with menu-bar access as fallback.
- Command–1/2/3/4 select Conversation, Today, Memory, Settings.
- Command–Return sends a nonblank draft. Command–Shift–R records/stops.
- Escape stops recording and hides the window. Closing stops recording but keeps
  the menu-bar agent. Explicit **Quit Didi** terminates the process.
- Permission buttons are explicit, separate from Record. On-device-only speech
  refuses unavailable locales rather than uploading audio. Text remains usable.

## Adapter contracts

`NativeNotifications.submit` consumes a stable commitment/revision identifier and
returns acknowledged, failed or unknown (the last is reserved for integration
uncertainty). Acknowledged means the OS accepted the request, **not delivered or
read**. Notifications have no sound/critical override and respect Focus. The
payload links to Conversation with commitment identity and revision; a disconnected
core explicitly cannot verify current status. Core owns retries/cancellation policy.
No permission prompt or notification send happens on startup or in checks.

`NativeVoice` exposes microphone, speech and on-device capabilities separately.
Only Record starts the engine after both permissions are granted. It uses
`requiresOnDeviceRecognition`, displays partial text, and stops on Escape, close,
Quit, device reconfiguration or system sleep. Generation guards discard callbacks
from cancelled sessions. Playback proof constructs a zero-volume utterance; it
never invokes synthesis. Live microphone/recognition is **untested** without an
explicit user grant and recording session; API availability is not live proof.

## Local check and bundle proof

Run the declared controller check for `bash Tests/DidiMacTests/check-mac.sh` in a
managed lane. The script compiles **actual source**, runs presentation/state seams,
builds a native `.app`, ad-hoc signs/verifies it, and launches it twice with isolated
HOME/CFFIXED_USER_HOME. No Xcode, signing account, package edit or download is needed.
Temporary artifacts are removed on exit. The UI proof writes a rendered native
content-view PNG to the private report directory (override with
`LUX_MAC_SCREENSHOT`). It exercises a failed text submission, window-close survival,
Escape and the registered Carbon event route. Physical global keyboard injection
is not claimed; that needs manual outside-app confirmation. No Accessibility or
Screen Recording grant is requested: the image is a bitmap of the actual app view,
not a desktop capture. The master must inspect it before UI acceptance.

`--self-check` reports actual OS permission states and tests safe native preparation
and invalid notification refusal. `--ui-proof <png-path>` is an explicit synthetic,
empty-app runtime mode and exits after capture. Neither launches recording, sound,
notification authorization or cloud egress. A normal launch opens the same empty
preview without automatically quitting. Local installation is owned by integration;
this check's disposable bundle is proof, not a claim of installed product delivery.
