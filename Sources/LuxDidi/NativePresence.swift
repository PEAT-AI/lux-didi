import Foundation

/// Council 2026-10-17, option C (the always-there presence model): one native-owned
/// state machine behind Right Command, the mini orb's click and the full app's mic
/// control, so the three surfaces can never disagree about whether Naya is listening.
enum PresenceState: String, Equatable, Sendable {
    /// No Live session. The orb is still there, transparent grey and silent.
    case cold
    /// A fresh session is opening; nothing captures before the provider is ready.
    case connecting
    /// Mic open, the conversation runs, and the notch pill is shown.
    case live
    /// The session stays open, the capture fence is closed and queued speech is dropped.
    case hotMuted
}

/// The receipt's `trigger` field: what asked the machine to move.
enum PresenceTrigger: String, Equatable, Sendable {
    case hotkey, click, app, timer, sleep, error
}

/// Everything a surface needs to render one presence state: the state, the setting
/// over the orb, and whether the last teardown failed loud, which is the error posture.
struct PresencePosture: Equatable {
    let state: PresenceState
    let alwaysShow: Bool
    let failed: Bool
    /// The owner muted Naya and has not tapped again: purple, whatever the session does.
    let muted: Bool
}

/// The effects the machine drives. Every one is injected, so the transition test
/// runs with no socket, no mic, no panel and an injected clock.
struct PresenceEffects {
    var openSession: @MainActor () -> Void = {}
    var cancelConnecting: @MainActor () -> Void = {}
    var closeSession: @MainActor () -> Void = {}
    var setCaptureMuted: @MainActor (Bool) -> Void = { _ in }
    var cancelPlayback: @MainActor () -> Void = {}
    var providerInputMute: @MainActor (Bool) -> Void = { _ in }
    var receipt: @MainActor ([String: Any]) -> Void = { _ in }
    var surface: @MainActor (PresencePosture) -> Void = { _ in }
    /// 338: the Mac woke with no session running, so the host rebuilds its warm context once.
    var prewarm: @MainActor () -> Void = {}
}

/// The presence machine, in the one place a state can change. `now` is monotonic
/// (the owner's uptime, never wall time), so a clock change can neither stretch
/// nor shorten the hot-muted grace.
@MainActor
final class NativePresence {
    /// The named constant of the design: five minutes of hot-muted grace, then COLD.
    static let hotMutedGrace: TimeInterval = 300

    private let now: () -> TimeInterval
    private let effects: PresenceEffects
    private(set) var state: PresenceState = .cold
    private(set) var mutedAt: TimeInterval?
    /// "Always show Naya": on by default, and the only switch over the presence orb.
    private(set) var alwaysShow = true
    /// The last teardown failed loud, so the orb carries an error posture until the next connect.
    private(set) var failed = false
    /// The trigger that opened CONNECTING, so the readiness receipt names the tap.
    private var connectingTrigger: PresenceTrigger?
    /// The owner muted her, and that outlives the session: the 5 minute grace may drop to
    /// cold, but the surface stays muted until the next tap or an explicit stop.
    private(set) var mutedHeld = false

    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         effects: PresenceEffects = PresenceEffects()) {
        self.now = now
        self.effects = effects
    }

    /// When the hot-muted grace expires. The app schedules one timer from this and
    /// nothing else, and the test advances the injected clock instead.
    var dropDeadline: TimeInterval? {
        guard state == .hotMuted, let mutedAt else { return nil }
        return mutedAt + Self.hotMutedGrace
    }

    /// What the surfaces render now. `muted` is the owner's own mute, which stays purple
    /// after the session's grace drops it to cold.
    var posture: PresencePosture {
        PresencePosture(state: state, alwaysShow: alwaysShow, failed: failed, muted: mutedHeld)
    }

    func start(_ trigger: PresenceTrigger) {
        guard state == .cold else { return }
        connect(trigger)
    }

    func stop(_ trigger: PresenceTrigger) {
        if state == .cold {
            guard mutedHeld else { return }
            mutedHeld = false
            effects.surface(posture)
            return
        }
        mutedHeld = false
        if state == .connecting { cancelConnecting(trigger) } else { teardown(trigger) }
    }

    func sessionEnded() {
        guard state != .cold else { return }
        connectingTrigger = nil
        mutedAt = nil
        move(to: .cold, trigger: .app)
    }

    /// The mute toggle the UI controls keep: LIVE mutes and hot-muted listens again. Q2
    /// took the Right Command key off this path, so a tap stops instead (see `tap`), and
    /// the native-presence ring keeps the mute transitions proven through it.
    func toggle(_ trigger: PresenceTrigger) {
        switch state {
        case .cold: connect(trigger)
        case .connecting: cancelConnecting(trigger)
        case .live: mute(trigger)
        case .hotMuted: unmute(trigger)
        }
    }

    /// The guarded readiness barrier: LIVE, and only now does the capture fence open.
    func ready() {
        guard state == .connecting else { return }
        let trigger = connectingTrigger ?? .app
        connectingTrigger = nil
        effects.setCaptureMuted(false)
        move(to: .live, trigger: trigger)
    }

    /// The bare Right Command tap is the owner's one toggle (revised 2026-10-21): cold
    /// starts her, live mutes her, muted lets her listen again. A held key and a chord are
    /// not a toggle and do nothing. The mute outlives the session's grace, so a tap on a
    /// muted machine that already dropped to cold reconnects with the mic opening at
    /// `ready()`, and the owner sees the muted purple until that tap.
    func tap(_ trigger: PresenceTrigger) {
        if mutedHeld {
            mutedHeld = false
            switch state {
            case .hotMuted: unmute(trigger)
            case .cold: connect(trigger)
            case .connecting, .live: effects.surface(posture)
            }
            return
        }
        switch state {
        case .cold: connect(trigger)
        case .connecting: cancelConnecting(trigger)
        case .live: mute(trigger)
        case .hotMuted: unmute(trigger)
        }
    }

    /// The owner's mute (R4): the fence closes, queued speech goes, and the provider session
    /// ends at once, so nothing is sent while she waits. The mute itself is what stays: purple
    /// until the next tap, however long, and the next tap reconnects and opens the mic.
    func mute(_ trigger: PresenceTrigger) {
        guard state == .live else { return }
        // The fence closes before the state says muted, so no frame outlives the receipt.
        effects.setCaptureMuted(true)
        mutedHeld = true
        move(to: .hotMuted, trigger: trigger)
        mutedAt = now()
        effects.cancelPlayback()
        effects.providerInputMute(true)
        connectingTrigger = nil
        effects.closeSession()
    }

    /// The app's explicit unmute: instant, the session was never closed.
    func unmute(_ trigger: PresenceTrigger) {
        guard state == .hotMuted else { return }
        mutedAt = nil
        mutedHeld = false
        effects.setCaptureMuted(false)
        move(to: .live, trigger: trigger)
        effects.providerInputMute(false)
    }

    /// The grace timer. R4 ends the provider session at the mute itself, so a muted tick has
    /// nothing left to end; any other hot-muted state (an app mute the key did not make) still
    /// drops the session here.
    func tick() {
        guard let deadline = dropDeadline, now() >= deadline else { return }
        if mutedHeld { mutedAt = nil; return }
        teardown(.timer)
    }

    /// `NSWorkspace.willSleepNotification`: the session goes now and never reconnects on wake,
    /// and a mute ends with it, because COLD is what the orb shows after sleep.
    func sleep() {
        guard state != .cold || mutedHeld else { return }
        mutedHeld = false
        guard state != .cold else { effects.surface(posture); return }
        teardown(.sleep)
    }

    /// `NSWorkspace.didWakeNotification` (issue 338): with no session running the wake changes no
    /// state, it only asks the host for one prewarm, because the warm context went stale asleep.
    /// A wake while LIVE belongs to the live session and does nothing here.
    func wake() {
        guard state == .cold || state == .hotMuted else { return }
        effects.prewarm()
    }

    /// An audio route or engine failure while live fails loud: error posture, session closed,
    /// never a silent reconfiguration of another application's audio.
    func fail() {
        failed = true
        guard state != .cold else { effects.surface(posture); return }
        teardown(.error)
    }

    /// "Always show Naya". Only the surface changes; the state machine is untouched.
    func setAlwaysShow(_ value: Bool) {
        guard alwaysShow != value else { return }
        alwaysShow = value
        effects.surface(posture)
    }

    func setSurfaces() { effects.surface(posture) }

    private func connect(_ trigger: PresenceTrigger) {
        connectingTrigger = trigger
        failed = false
        move(to: .connecting, trigger: trigger)
        // No capture, no buffering: the mic opens at `ready()`, not here.
        effects.openSession()
    }

    private func cancelConnecting(_ trigger: PresenceTrigger) {
        connectingTrigger = nil
        effects.setCaptureMuted(true)
        move(to: .cold, trigger: trigger)
        effects.cancelConnecting()
    }

    private func teardown(_ trigger: PresenceTrigger) {
        if state != .connecting { effects.setCaptureMuted(true) }
        connectingTrigger = nil
        move(to: .cold, trigger: trigger)
        mutedAt = nil
        effects.closeSession()
    }

    private func move(to next: PresenceState, trigger: PresenceTrigger) {
        let from = state
        state = next
        effects.receipt(["event": "presence_state", "from": from.rawValue, "to": next.rawValue,
                         "trigger": trigger.rawValue, "failed": failed])
        effects.surface(posture)
    }
}
