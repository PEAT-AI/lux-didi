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

    /// What the surfaces render now.
    var posture: PresencePosture { PresencePosture(state: state, alwaysShow: alwaysShow, failed: failed) }

    /// The one tap path: Right Command, a click on the mini orb, the app's mic control.
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

    /// The app's explicit mute: LIVE goes hot-muted, anything else is a no-op.
    func mute(_ trigger: PresenceTrigger) {
        guard state == .live else { return }
        // The fence closes before the state says muted, so no frame outlives the receipt.
        effects.setCaptureMuted(true)
        move(to: .hotMuted, trigger: trigger)
        mutedAt = now()
        effects.cancelPlayback()
        effects.providerInputMute(true)
    }

    /// The app's explicit unmute: instant, the session was never closed.
    func unmute(_ trigger: PresenceTrigger) {
        guard state == .hotMuted else { return }
        mutedAt = nil
        effects.setCaptureMuted(false)
        move(to: .live, trigger: trigger)
        effects.providerInputMute(false)
    }

    /// The grace timer. A tick before the deadline changes nothing.
    func tick() {
        guard let deadline = dropDeadline, now() >= deadline else { return }
        teardown(.timer)
    }

    /// `NSWorkspace.willSleepNotification`: the session goes now and never reconnects on wake.
    func sleep() {
        guard state != .cold else { return }
        teardown(.sleep)
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
