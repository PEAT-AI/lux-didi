# Mac experience

Naya's resting surface is the floating orb. The full window is optional: it shows the shared conversation, memory, Today and Settings interface without replacing the native audio and lifecycle owners. For installation and a first call, use [user-guide.md](user-guide.md).

## Launch is an explicit kind

`LaunchKind` in `Sources/LuxDidi/SingleInstanceGuard.swift` distinguishes interactive, login, installer, reopen and proof starts. `autoConnects` is true only for an interactive launch. A login or install relaunch must not unexpectedly open the microphone, and reopening an existing app is not another fresh auto-connect.

`PresentationCoordinator` in `Sources/LuxDidi/PresentationCoordinator.swift` owns which surfaces are shown. Closing a window is not a stop call. Keep this ownership rather than making each window infer the app's lifecycle independently.

## One presence machine

`PresenceState` in `Sources/LuxDidi/NativePresence.swift` defines `cold`, `connecting`, `live` and `hotMuted`. A tap starts from cold, can cancel connection, and toggles mute/resume while connected. The control should reflect the actual transition, not optimistically show a live microphone before the owner is ready.

Native audio belongs to `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift`. A muted icon without capture shutdown is not a successful mute; a system-wide audio change is not an acceptable implementation shortcut.

## Keys and menus

`Sources/LuxDidi/SingleKeyTrigger.swift` owns the bare Right Command gesture. Holding it or combining it with another key must not steal ordinary Command shortcuts. Input Monitoring is a macOS permission separate from microphone access, and the menu reports when the single-key path cannot run.

`Sources/LuxDidi/NativeShortcuts.swift` owns registered window and Live chords. The current controls include Control Option Space / Control Option Shift Space for the full window, Control Option Shift L for Live, and Control Option Shift M for mute. Keep menu labels and conflict reporting in sync with the registration owner; do not hardcode another shortcut table in a web component.

## Native and shared surfaces

Swift owns the menu, host connection, audio, approved native actions and presentation. `CompanionWeb` hosts shared web content and forwards typed messages through `NativeBridge`; it is not a duplicate business store. [Native app](native-app.md) owns navigation, confirmation and bridge boundaries; [web client](web-client.md) owns presentation modules.

A native draft's **Save note** is a local capture action. **Send to Naya** is connected conversation work and needs its own valid route/consent. Do not switch one action into the other based on whether a provider happens to be configured.

## Settings and recovery

Settings reports connector limitations and provides the supported sign-in actions. Mongoose is per endpoint, Trello is separate, and Google/Mattermost helpers retain their own setup requirements. [MCP configuration](mcp-configuration.md) owns those steps.

A connection-lost terminal state is not an owner stop or a completed answer. Native audio recovery, host supervision and provider recovery are different owners. Preserve that distinction in visible state and diagnostics; [live-call.md](live-call.md) and [debugging.md](debugging.md) explain it.

The orb's visual design is frozen unless explicitly authorized. Lifecycle or wording fixes are not permission to redesign motion, color, geometry or transparency. Existing producers in [checks.md](checks.md) cover native behavior; an offline screenshot does not prove a real microphone, account or audible call.
