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
/// runs with no socket, no mic and no panel.
struct PresenceEffects {
    var openSession: @MainActor (UInt64) -> Void = { _ in }
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

/// The presence machine, in the one place a state can change. `generation` fences the
/// session lifecycle: it moves whenever the machine opens or leaves a session, and a
/// callback carrying any other generation changes nothing.
@MainActor
final class NativePresence {
    private let effects: PresenceEffects
    private(set) var state: PresenceState = .cold
    private(set) var generation: UInt64 = 0
    /// "Always show Naya": on by default, and the only switch over the presence orb.
    private(set) var alwaysShow = true
    /// The last teardown failed loud, so the orb carries an error posture until the next connect.
    private(set) var failed = false
    /// The trigger that opened CONNECTING, so the readiness receipt names the tap.
    private var connectingTrigger: PresenceTrigger?
    /// The owner muted her: MUTED is the mute, and it holds until the next tap, a Stop or
    /// sleep. Nothing time-based ends it, so the session stays closed for as long as she waits.
    var mutedHeld: Bool { state == .hotMuted }

    init(effects: PresenceEffects = PresenceEffects()) {
        self.effects = effects
    }

    /// What the surfaces render now. `muted` is the owner's own mute, and it stays purple
    /// for as long as the state holds it.
    var posture: PresencePosture {
        PresencePosture(state: state, alwaysShow: alwaysShow, failed: failed, muted: mutedHeld)
    }

    func start(_ trigger: PresenceTrigger) {
        guard state == .cold else { return }
        connect(trigger)
    }

    func stop(_ trigger: PresenceTrigger) {
        guard state != .cold else { return }
        if state == .connecting { cancelConnecting(trigger) } else { teardown(trigger) }
    }

    /// The session that carried this generation ended. A stale generation is the session
    /// the owner already left, so it never touches the state.
    func sessionEnded(_ generation: UInt64) {
        guard generation == self.generation, state != .cold else { return }
        connectingTrigger = nil
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
    func ready(_ generation: UInt64) {
        guard generation == self.generation, state == .connecting else { return }
        let trigger = connectingTrigger ?? .app
        connectingTrigger = nil
        effects.setCaptureMuted(false)
        move(to: .live, trigger: trigger)
    }

    /// The bare Right Command tap is the owner's one toggle: cold starts her, live mutes her,
    /// muted lets her listen again, and a tap while connecting mutes instead of leaving her
    /// half-open. A held key and a chord are not a toggle and do nothing. The parity holds
    /// whatever the session is doing, so a tap always answers the one before it.
    func tap(_ trigger: PresenceTrigger) {
        switch state {
        case .cold: connect(trigger)
        case .connecting, .live: mute(trigger)
        case .hotMuted: unmute(trigger)
        }
    }

    /// The owner's mute (R4): the fence closes, queued speech goes, and the provider session
    /// ends at once, so nothing is sent while she waits. The mute itself is what stays: purple
    /// until the next tap, however long, and the next tap reconnects and opens the mic.
    /// The generation moves first, so the session this misses is already the owner's past.
    func mute(_ trigger: PresenceTrigger) {
        guard state == .live || state == .connecting else { return }
        generation &+= 1
        // The fence closes before the state says muted, so no frame outlives the receipt.
        if state == .live { effects.setCaptureMuted(true) }
        move(to: .hotMuted, trigger: trigger)
        effects.cancelPlayback()
        effects.providerInputMute(true)
        connectingTrigger = nil
        effects.closeSession()
    }

    /// The unmute: the session the mute ended is gone, so this opens a new one, on the same
    /// app conversation, and readiness opens the mic. It never restores a session that ended.
    func unmute(_ trigger: PresenceTrigger) {
        guard state == .hotMuted else { return }
        connect(trigger)
    }

    /// `NSWorkspace.willSleepNotification`: the session goes now and never reconnects on wake,
    /// and a mute ends with it, because COLD is what the orb shows after sleep.
    func sleep() {
        guard state != .cold else { return }
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
    /// never a silent reconfiguration of another application's audio. A failure from a
    /// generation the owner already left is the past session's, and it changes nothing.
    func fail(_ generation: UInt64) {
        guard generation == self.generation else { return }
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
        generation &+= 1
        connectingTrigger = trigger
        failed = false
        move(to: .connecting, trigger: trigger)
        // No capture, no buffering: the mic opens at `ready()`, not here.
        effects.openSession(generation)
    }

    private func cancelConnecting(_ trigger: PresenceTrigger) {
        generation &+= 1
        connectingTrigger = nil
        effects.setCaptureMuted(true)
        move(to: .cold, trigger: trigger)
        effects.cancelConnecting()
    }

    private func teardown(_ trigger: PresenceTrigger) {
        generation &+= 1
        if state != .connecting { effects.setCaptureMuted(true) }
        connectingTrigger = nil
        move(to: .cold, trigger: trigger)
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
