import AppKit

// Desktop single-instance authority. A second launch of the same bundle id yields
// to the already-running instance and exits, before building any window, host or
// audio, without activating anything. Disposable verification launches
// (`OwnedVerificationLaunchGate`, identified by its gate environment) are exempt,
// because the launch probe deliberately starts fresh instances to prove identity
// and exit behavior.
@MainActor
enum SingleInstanceGuard {
    static func otherRunningInstance(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier
    ) -> NSRunningApplication? {
        guard let bundleIdentifier else { return nil }
        let me = getpid()
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .first { $0.processIdentifier != me && !$0.isTerminated }
    }

    // Pure guard decision: a launch yields to a live instance of the same bundle
    // except a disposable verification launch, which is documented as exempt
    // because the launch probe starts fresh instances deliberately.
    static func shouldYield(kind: LaunchKind, otherInstanceRunning: Bool) -> Bool {
        guard kind != .verification else { return false }
        return otherInstanceRunning
    }

    // Returns true when this launch must yield to an existing instance. The caller
    // exits silently before building anything. Nothing is activated: a background or
    // forced duplicate must not pull Didi in front of the owner's work.
    @discardableResult
    static func yieldToExistingInstance(verification: Bool) -> Bool {
        let kind: LaunchKind = verification ? .verification : .interactive
        guard shouldYield(kind: kind, otherInstanceRunning: true), let other = otherRunningInstance() else { return false }
        fputs("SINGLE-INSTANCE: yielding to running pid \(other.processIdentifier)\n", stderr)
        return true
    }
}

/// The launch paths that decide whether Didi may appear and take focus. A pure
/// value: `resolve` reads only the arguments, the environment and the login Apple
/// Event, so the presentation decision is provable without a window.
enum LaunchKind: String {
    case interactive
    case loginItem = "login_item"
    case installRelaunch = "install_relaunch"
    case installedProof = "installed_proof"
    case selfCheck = "self_check"
    case uiProof = "ui_proof"
    case verification

    /// A check that cannot open its own window exits with this code so a yielded
    /// proof launch can never be mistaken for a pass.
    static let duplicateInstanceExitCode: Int32 = 3

    static func resolve(arguments: [String], environment: [String: String], loginLaunch: Bool) -> LaunchKind {
        if environment["LUX_VERIFICATION_GATE_ROOT"] != nil || environment["LUX_VERIFICATION_GATE_NONCE"] != nil { return .verification }
        if arguments.contains("--installed-proof") { return .installedProof }
        if arguments.contains("--self-check") { return .selfCheck }
        if arguments.contains("--ui-proof") { return .uiProof }
        if loginLaunch { return .loginItem }
        if arguments.contains("--install-relaunch") { return .installRelaunch }
        return .interactive
    }

    /// Only an interactive launch brings the app to the front and takes focus. A
    /// login launch starts hidden and only activates when the owner later opens it
    /// from the menu or hotkey, so it keeps today's activation behaviour.
    var activates: Bool {
        switch self {
        case .interactive, .loginItem: return true
        case .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification: return false
        }
    }

    /// ORBFIRST: the orb is the resting surface, so every launch that shows any UI shows the orb,
    /// and only the kinds that host a window for a reason of their own present one at launch.
    var presentsOrbAtLaunch: Bool {
        switch self {
        case .interactive, .loginItem, .installRelaunch: return true
        case .installedProof, .selfCheck, .uiProof, .verification: return false
        }
    }

    /// An install relaunch and a proof launch host the window they must drive; an interactive or
    /// login launch creates the window the first time the owner opens the app.
    var presentsWindowAtLaunch: Bool {
        switch self {
        case .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification: return true
        case .interactive, .loginItem: return false
        }
    }

    var createsWindowAtLaunch: Bool { presentsWindowAtLaunch }

    /// The owner started the app: the one launch kind that connects on its own.
    var autoConnects: Bool { self == .interactive }

    var duplicateInstanceExitCodeForYield: Int32 {
        switch self {
        case .interactive, .loginItem: return 0
        case .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification: return LaunchKind.duplicateInstanceExitCode
        }
    }
}

/// #613: the one content-free launch record, so a launch kind is never inferred from LaunchServices.
extension LaunchKind {
    var launchRecord: [String: Any] {
        ["event": "launch_kind", "kind": rawValue,
         "autoConnects": autoConnects, "windowShown": presentsWindowAtLaunch]
    }
}

/// ORBFIRST: whether a launch opens a session by itself. A launch connects once, only when the
/// host is up and the orb page is hostable, and a refusal is final for that launch so a denied
/// microphone or a refused audio owner never loops.
enum OrbFirstAutoConnect {
    enum Action: Equatable { case connect, wait, never }

    static func decide(kind: LaunchKind, serviceReady: Bool, pageHostable: Bool, attempted: Bool) -> Action {
        guard kind.autoConnects, !attempted else { return .never }
        return serviceReady && pageHostable ? .connect : .wait
    }

    /// #613: an auto-connected launch waits for the calendar connector to publish, so the opener composes
    /// with a digest instead of racing it. Four seconds, then the call starts and the digest reads absent.
    static let calendarBoundMs = 4000
    static let calendarStepMs = 200

    /// The probe and the clock are injected, so the bound is provable with no host and no waiting.
    static func waitForCalendar(published: () async -> Bool,
                                sleep: (Int) async -> Void,
                                boundMs: Int = calendarBoundMs,
                                stepMs: Int = calendarStepMs) async -> Bool {
        var waited = 0
        while true {
            if await published() { return true }
            if waited >= boundMs { return false }
            await sleep(stepMs)
            waited += stepMs
        }
    }
}
