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
    /// #619: the Dock click on a running instance. Its own kind, so native-live.log says that a
    /// reopen shows the orb and no window.
    case reopen
    /// #107: the alarm relaunch agent brought the app back. It shows nothing and takes no focus,
    /// and the only call it opens is the due alarm's own.
    case alarmRelaunch = "alarm_relaunch"

    /// A check that cannot open its own window exits with this code so a yielded
    /// proof launch can never be mistaken for a pass.
    static let duplicateInstanceExitCode: Int32 = 3

    static func resolve(arguments: [String], environment: [String: String], loginLaunch: Bool) -> LaunchKind {
        if environment["LUX_VERIFICATION_GATE_ROOT"] != nil || environment["LUX_VERIFICATION_GATE_NONCE"] != nil { return .verification }
        if arguments.contains("--installed-proof") { return .installedProof }
        if arguments.contains("--self-check") { return .selfCheck }
        if arguments.contains("--ui-proof") { return .uiProof }
        if arguments.contains(NativeAlarmRelaunchWriter.launchArgument) { return .alarmRelaunch }
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
        case .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification, .reopen, .alarmRelaunch: return false
        }
    }

    /// ORBFIRST: the orb is the resting surface, so every launch that shows any UI shows the orb,
    /// and only the kinds that host a window for a reason of their own present one at launch.
    var presentsOrbAtLaunch: Bool {
        switch self {
        case .interactive, .loginItem, .installRelaunch, .reopen: return true
        case .installedProof, .selfCheck, .uiProof, .verification, .alarmRelaunch: return false
        }
    }

    /// An install relaunch and a proof launch host the window they must drive; an interactive or
    /// login launch creates the window the first time the owner opens the app.
    var presentsWindowAtLaunch: Bool {
        switch self {
        case .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification: return true
        case .interactive, .loginItem, .reopen, .alarmRelaunch: return false
        }
    }

    var createsWindowAtLaunch: Bool { presentsWindowAtLaunch }

    /// The owner started the app: the one launch kind that connects on its own.
    var autoConnects: Bool { self == .interactive }

    var duplicateInstanceExitCodeForYield: Int32 {
        switch self {
        case .interactive, .loginItem, .reopen, .alarmRelaunch: return 0
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

/// F6: the call start marker. Written synchronously before a call starts with the pid, the wall time
/// and the output transport, and cleared once the call has proved it works in both directions or
/// ends cleanly. A marker left behind means that call never got there, so the next launch reads it
/// and does not auto connect. Content free: no audio, no text, no account.
enum CallStartMarker {
    /// A start older than this is not a loop any more.
    static let window: TimeInterval = 120
    static let fileName = "call-start.json"

    struct Record: Equatable {
        let pid: Int32
        let startedAt: Date
        let transport: String
    }

    static func url(in logsDirectory: URL) -> URL { logsDirectory.appendingPathComponent(fileName) }

    /// Writes the record, replacing any older one. A marker that cannot be written is reported and
    /// never thrown: it must not stop a call the owner asked for.
    @discardableResult
    static func write(_ record: Record, to url: URL) -> Bool {
        let fields: [String: Any] = ["pid": Int(record.pid),
                                     "startedAt": record.startedAt.timeIntervalSince1970,
                                     "transport": record.transport]
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else {
            return false
        }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    static func read(_ url: URL) -> Record? {
        guard let data = try? Data(contentsOf: url),
              let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = fields["pid"] as? Int,
              let startedAt = fields["startedAt"] as? TimeInterval else { return nil }
        return Record(pid: Int32(pid), startedAt: Date(timeIntervalSince1970: startedAt),
                      transport: fields["transport"] as? String ?? "unknown")
    }

    static func clear(_ url: URL) { try? FileManager.default.removeItem(at: url) }

    /// The marker another process left inside the window, or nil when there is nothing to refuse.
    static func previousStartDied(_ url: URL, now: Date,
                                  pid: Int32 = Int32(ProcessInfo.processInfo.processIdentifier)) -> Record? {
        guard let record = read(url), record.pid != pid else { return nil }
        let age = now.timeIntervalSince(record.startedAt)
        guard age >= 0, age < window else { return nil }
        return record
    }
}

/// ORBFIRST: whether a launch opens a session by itself. A launch connects once, only when the
/// host is up and the orb page is hostable, and a refusal is final for that launch so a denied
/// microphone or a refused audio owner never loops.
enum OrbFirstAutoConnect {
    enum Action: Equatable { case connect, wait, never }

    /// F6: `previousStartDied` is the crash-loop guard. A launch that finds a call start younger
    /// than two minutes from another pid never auto connects, because three crashes in 35 s each
    /// launched straight back into the same native fault. The owner's own press still starts a call.
    static func decide(kind: LaunchKind, serviceReady: Bool, pageHostable: Bool, attempted: Bool,
                       previousStartDied: Bool = false) -> Action {
        guard kind.autoConnects, !attempted, !previousStartDied else { return .never }
        return serviceReady && pageHostable ? .connect : .wait
    }

    /// #613: an auto-connected launch waits for the calendar connector to publish, so the opener composes
    /// with a digest instead of racing it. Four seconds, then the call starts and the digest reads absent.
    static let calendarBoundMs = 4000
    static let calendarStepMs = 200

    /// The probe and the clock are injected, so the bound is provable with no host and no waiting.
    @MainActor static func waitForCalendar(published: () async -> Bool,
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
