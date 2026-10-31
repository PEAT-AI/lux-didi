import Foundation

/// #107: one user LaunchAgent brings Didi back for the next due alarm when the app was quit.
/// It fires a minute early, opens the app in the background (`open -g`, never stealing focus) with
/// `--alarm-relaunch`, and the host then fires the due alarm into the session the app opens.
/// Display sleep is fine. A closed lid or a manual sleep still blocks the wake-up (docs/alarm.md).
protocol AlarmRelaunchRunning: AnyObject {
    /// The launchctl exit status, so the schedule is reported only when launchd accepted it.
    func run(_ arguments: [String]) throws -> Int32
}

/// The one thing the host is told about the agent, each observed rather than assumed.
enum AlarmRelaunchEvent: Equatable {
    case scheduled(dueInS: Int)
    case removed
    case failed
}

/// The real launchd bridge. Tests inject a recorder instead, so no test touches the user domain.
final class LaunchctlRelaunchRunner: AlarmRelaunchRunning {
    func run(_ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

@MainActor final class NativeAlarmRelaunchWriter {
    nonisolated static let label = "ai.peat.lux-didi.alarm"
    nonisolated static let fileName = "ai.peat.lux-didi.alarm.plist"
    nonisolated static let launchArgument = "--alarm-relaunch"
    nonisolated static let leadMs = 60_000

    /// The write receipt of the last arm, or nil when nothing was pending.
    private(set) var armedStartMs: Int?
    var onEvent: ((AlarmRelaunchEvent) -> Void)?

    private let directory: URL
    private let domain: String
    private let runner: AlarmRelaunchRunning
    private let appPath: () -> String

    init(directory: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents"),
         domain: String = "gui/\(getuid())",
         runner: AlarmRelaunchRunning = LaunchctlRelaunchRunner(),
         appPath: @escaping () -> String = { Bundle.main.bundlePath }) {
        self.directory = directory; self.domain = domain; self.runner = runner; self.appPath = appPath
    }

    var plistURL: URL { directory.appendingPathComponent(Self.fileName) }

    /// The agent fires before the due time so app start, host start and provider connect are done.
    nonisolated static func startMs(dueMs: Int) -> Int { dueMs - leadMs }

    /// One agent for the earliest pending alarm, rewritten on every mutation, gone when nothing is pending.
    func sync(pendingDueMs: [Int], now: () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        guard let due = pendingDueMs.filter({ $0 > 0 }).min() else { return remove() }
        arm(startMs: Self.startMs(dueMs: due), dueMs: due, now: now())
    }

    /// Called on quit: the same rows that armed the agent keep it armed, so a quit never disarms it.
    func rewrite(pendingDueMs: [Int], now: () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        armedStartMs = nil
        sync(pendingDueMs: pendingDueMs, now: now)
    }

    func remove() {
        let loaded = armedStartMs != nil || FileManager.default.fileExists(atPath: plistURL.path)
        _ = try? runner.run(["bootout", "\(domain)/\(Self.label)"])
        try? FileManager.default.removeItem(at: plistURL)
        armedStartMs = nil
        if loaded { onEvent?(.removed) }
    }

    private func arm(startMs: Int, dueMs: Int, now: Int) {
        // The same due time needs no churn: a reconnect replays rows that are already armed.
        if armedStartMs == startMs, FileManager.default.fileExists(atPath: plistURL.path) { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let plist = Self.plist(startMs: startMs, label: Self.label, appPath: appPath())
        try? Data(plist.utf8).write(to: plistURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: plistURL.path)
        _ = try? runner.run(["bootout", "\(domain)/\(Self.label)"])
        // Only an accepted bootstrap is a schedule. A refusal is its own degraded signal, never a
        // scheduled event that claims an agent exists when launchd never loaded it.
        let bootstrapped = (try? runner.run(["bootstrap", domain, plistURL.path])) ?? -1
        guard bootstrapped == 0 else { armedStartMs = nil; onEvent?(.failed); return }
        armedStartMs = startMs
        onEvent?(.scheduled(dueInS: max(0, (dueMs - now) / 1000)))
    }

    /// One plist, closed fields, and the launch argument that makes the alarm the reason for the launch.
    nonisolated static func plist(startMs: Int, label: String, appPath: String, calendar: Calendar = .current) -> String {
        // launchd's StartCalendarInterval takes exactly Minute, Hour, Day, Weekday and Month.
        // No Year key exists: an agent that fires is rewritten or removed by the app that comes back.
        let parts = calendar.dateComponents([.month, .day, .hour, .minute],
                                            from: Date(timeIntervalSince1970: TimeInterval(startMs) / 1000))
        func escape(_ value: String) -> String {
            value.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>\(escape(label))</string>
          <key>ProgramArguments</key>
          <array>
            <string>/usr/bin/open</string>
            <string>-g</string>
            <string>-a</string>
            <string>\(escape(appPath))</string>
            <string>--args</string>
            <string>\(launchArgument)</string>
          </array>
          <key>StartCalendarInterval</key>
          <dict>
            <key>Month</key><integer>\(parts.month ?? 0)</integer>
            <key>Day</key><integer>\(parts.day ?? 0)</integer>
            <key>Hour</key><integer>\(parts.hour ?? 0)</integer>
            <key>Minute</key><integer>\(parts.minute ?? 0)</integer>
          </dict>
        </dict>
        </plist>

        """
    }

    /// A launch that carries the argument exists only to announce the alarm it was armed for.
    nonisolated static func present(arguments: [String]) -> Bool { arguments.contains(launchArgument) }
    nonisolated static var launchKind: String { "alarm_relaunch" }
}
