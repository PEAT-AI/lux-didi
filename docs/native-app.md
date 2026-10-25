# Native application

The Swift application owns native audio, presence, windows, shortcuts, host supervision and approved native actions. Durable conversation records and source/tool policy remain host-owned. The web view presents shared content; neither side should duplicate the other's authority or lifecycle state machine.

## Source map

| Concern | Source |
| --- | --- |
| App composition and menus | `Sources/LuxDidi/LuxDidiApp.swift` |
| Launch classification and single instance | `Sources/LuxDidi/SingleInstanceGuard.swift` |
| Window/orb presentation | `Sources/LuxDidi/PresentationCoordinator.swift` |
| Presence state and triggers | `Sources/LuxDidi/NativePresence.swift` |
| Audio hardware | `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` |
| Live protocol coordination | `Sources/LuxDidi/LiveSessionCoordinator.swift` |
| Live socket transport | `Sources/LuxDidi/LiveSocketTransport.swift` |
| Native audio recovery | `Sources/LuxDidi/NativeLiveAudioDevice.swift` |
| Host startup and observation | `NativeServiceSupervisor` in `Sources/LuxDidi/NativeServiceSupervisor.swift` |
| Descriptor/authenticated connection | `CompanionClient` in `Sources/LuxDidi/CompanionClient.swift` |
| Web view and navigation | `CompanionWeb` in `Sources/LuxDidi/CompanionWeb.swift` |
| Typed web/native messages | `NativeBridge` in `Sources/LuxDidi/NativeBridge.swift` |
| Open destinations | `Sources/LuxDidi/NativeActions.swift` |

Read these owners before changing a callback or adding another parser. Exact protocol unions and frame limits belong in their source contracts, not copied examples here.

## Launch and presence

`LaunchKind.autoConnects` is true only for an interactive launch. Login, proof and installer relaunch kinds must not unexpectedly connect a call. A Dock reopen is not the same as a fresh interactive start. [Mac experience](mac-experience.md) owns user-visible controls; [Mac installation](macos-install.md) owns packaging and the protected configuration selector.

Presence and call state must remain coherent across orb clicks, bare Right Command, menu actions and host terminal events. Closing a window is not a call stop. A host-initiated failure must not be relabeled as an owner stop to make the UI appear orderly.

## Audio and recovery

`AudioOwner` is the hardware owner. Do not change system input/output, volume or another app's routing to repair a Naya failure. A mute that changes only presentation is not a mute; capture and playback have real lifecycle consequences.

Native device/engine recovery and host provider recovery are different boundaries. An exception during audio rebuild is not evidence that a provider token expired; a provider drop is not permission to recreate unrelated audio devices. [Live call](live-call.md) owns host recovery and accepted authority; [debugging.md](debugging.md) explains the discriminating evidence.

## The web/native boundary

`CompanionWeb` uses a nonpersistent web data store and validates navigation against the configured service route. It implements `WKUIDelegate` confirmation so a web confirmation, such as memory deletion, has an actual native OK/Cancel result.

The current code **does** receive typed `didi` script messages: `userContentController` forwards them to `NativeBridge.handle`. Do not repeat the historical claim that no inbound JavaScript handler exists. The bridge must validate its closed message contract and leave capability/authority checks with their owners; its existence is not a general native RPC or arbitrary command grant.

Native open uses the allowed destination/action path in `NativeActions.swift`. Chrome preference and default-browser fallback do not authorize AppleScript, profile manipulation or keystroke automation. A successful native receipt, not assistant prose, proves an open was attempted successfully.

## Host lifetime and credentials

The installed app starts its own supervised host and validates readiness and connection identity. It must not attach to an arbitrary process merely because a stale descriptor names a familiar port. Keep credential bytes out of arguments, logs, web messages and support snapshots. [Local runtime](local-runtime.md) owns supervision and [service.md](service.md) owns HTTP authority.

## Verification

Use the native, companion and installer producers in [checks.md](checks.md). Their canonical Swift producer uses `scripts/with-compile-lock.sh`; do not create an alternate compile/identity path. Synthetic protocol tests and screenshots do not prove real microphone permission, audible hardware, provider availability or a healthy installed account.

No documentation change authorizes launching, quitting or relaunching the owner's installed app. Keep orb visuals unchanged unless explicitly requested, and use synthetic content in screenshots or diagnostics intended for this public repository.
