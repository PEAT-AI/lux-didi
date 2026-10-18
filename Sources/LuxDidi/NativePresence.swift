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
    /// Q2, owner order 2026-10-18: a hold's own grace. The release of a push-to-talk hold
    /// closes the capture fence while the answer already in flight may finish, so the
    /// session ends when that answer completes or after this many seconds of silence.
    static let holdReleaseGrace: TimeInterval = 30

    /// Why the capture fence is closed: the owner's mute, or the release of a hold.
    enum HotMuteKind: Equatable { case userMute, holdRelease }

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
    /// Why the fence is closed, which decides the grace that ends the session.
    private(set) var hotMuteKind: HotMuteKind?
    /// A hold is down and the mic is open while it is.
    private(set) var holding = false
    /// The state the hold started from, so its release restores what it interrupted.
    private var holdOrigin: PresenceState?

    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         effects: PresenceEffects = PresenceEffects()) {
        self.now = now
        self.effects = effects
    }

    /// When the hot-muted grace expires. The app schedules one timer from this and
    /// nothing else, and the test advances the injected clock instead.
    var dropDeadline: TimeInterval? {
        guard state == .hotMuted, let mutedAt else { return nil }
        let grace = hotMuteKind == .holdRelease ? Self.holdReleaseGrace : Self.hotMutedGrace
        return mutedAt + grace
    }

    /// What the surfaces render now.
    var posture: PresencePosture { PresencePosture(state: state, alwaysShow: alwaysShow, failed: failed) }

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

    /// Q2, owner order 2026-10-18: a Right Command tap starts Naya when idle and STOPS it
    /// when it is live, connecting or muted, through the same teardown the Stop button
    /// takes. The mute stays on the UI controls; it is no longer what the key does, so a
    /// tap never leaves the 5 minute grace behind.
    func tap(_ trigger: PresenceTrigger) {
        switch state {
        case .cold: connect(trigger)
        case .connecting: cancelConnecting(trigger)
        case .live, .hotMuted: teardown(trigger)
        }
    }

    /// The app's explicit mute: LIVE goes hot-muted, anything else is a no-op.
    func mute(_ trigger: PresenceTrigger) {
        guard state == .live else { return }
        // The fence closes before the state says muted, so no frame outlives the receipt.
        effects.setCaptureMuted(true)
        hotMuteKind = .userMute
        move(to: .hotMuted, trigger: trigger)
        mutedAt = now()
        effects.cancelPlayback()
        effects.providerInputMute(true)
    }

    /// The app's explicit unmute: instant, the session was never closed.
    func unmute(_ trigger: PresenceTrigger) {
        guard state == .hotMuted else { return }
        mutedAt = nil
        hotMuteKind = nil
        effects.setCaptureMuted(false)
        move(to: .live, trigger: trigger)
        effects.providerInputMute(false)
    }

    /// Q2: the Right Command press reached the hold threshold. The mic is open while the
    /// key is held: a cold or connecting machine opens the session, a muted one opens the
    /// fence again, and a live one keeps what it has.
    func holdStarted(_ trigger: PresenceTrigger) {
        guard !holding else { return }
        holding = true
        holdOrigin = state
        switch state {
        case .cold: connect(trigger)
        case .connecting: break
        case .live: break
        case .hotMuted: unmute(trigger)
        }
    }

    /// Q2: the hold was released. Held from cold, the fence closes while the answer may
    /// finish and the session ends then or after `holdReleaseGrace`; held while live, the
    /// mic never closed and nothing changes; held over a mute, the mute comes back.
    func holdEnded(_ trigger: PresenceTrigger) {
        guard holding else { return }
        holding = false
        let origin = holdOrigin ?? .cold
        holdOrigin = nil
        switch origin {
        case .live: return
        case .hotMuted:
            // The unmute opened the fence; the owner's mute goes back on, grace and all.
            mute(trigger)
        case .cold, .connecting:
            switch state {
            case .connecting: cancelConnecting(trigger)
            case .live, .hotMuted: closeFenceForAnswer(trigger)
            case .cold: break
            }
        }
    }

    /// Q2: the answer a hold release left in flight finished, so nothing is left to wait
    /// for and the session ends now. A mute the owner asked for is untouched.
    func answerCompleted() {
        guard state == .hotMuted, hotMuteKind == .holdRelease else { return }
        teardown(.app)
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

    /// `NSWorkspace.didWakeNotification` (issue 338): with no session running the wake changes no
    /// state, it only asks the host for one prewarm, because the warm context went stale asleep.
    /// A wake while LIVE belongs to the live session and does nothing here.
    func wake() {
        switch state {
        case .cold, .hotMuted: effects.prewarm()
        case .live: return
        }
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
        holding = false
        holdOrigin = nil
        hotMuteKind = nil
        move(to: .cold, trigger: trigger)
        mutedAt = nil
        effects.closeSession()
    }

    /// A hold's release: nothing new is captured, while the answer already in flight may
    /// finish. The session goes when that answer completes or the hold's own grace runs out.
    private func closeFenceForAnswer(_ trigger: PresenceTrigger) {
        effects.setCaptureMuted(true)
        hotMuteKind = .holdRelease
        move(to: .hotMuted, trigger: trigger)
        mutedAt = now()
    }

    private func move(to next: PresenceState, trigger: PresenceTrigger) {
        let from = state
        state = next
        effects.receipt(["event": "presence_state", "from": from.rawValue, "to": next.rawValue,
                         "trigger": trigger.rawValue, "failed": failed])
        effects.surface(posture)
    }
}
