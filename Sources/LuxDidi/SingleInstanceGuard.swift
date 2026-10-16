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
enum LaunchKind: Equatable {
    case interactive
    case loginItem
    case installRelaunch
    case installedProof
    case selfCheck
    case uiProof
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

    /// A login launch starts with no window on screen; every other kind presents one.
    var presentsWindowAtLaunch: Bool { self != .loginItem }

    var duplicateInstanceExitCodeForYield: Int32 {
        switch self {
        case .interactive, .loginItem: return 0
        case .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification: return LaunchKind.duplicateInstanceExitCode
        }
    }
}
