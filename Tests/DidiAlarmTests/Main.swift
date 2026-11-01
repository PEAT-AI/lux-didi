import AVFoundation
import Foundation
import UserNotifications

@MainActor final class SilentAlarmOutput: ConnectingRingOutput {
    var chimes = 0
    var stops = 0
    func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool { false }
    func playChime(_ buffer: AVAudioPCMBuffer) -> Bool { chimes += 1; return true }
    func stopOutput() { stops += 1 }
    func rampDown(overMs: Int, after: (@MainActor () -> Void)?) { after?() }
}

/// C-ALARMSPEECH: records chimes and stops in one order list, so a test can prove what came first.
@MainActor final class OrderingAlarmOutput: ConnectingRingOutput {
    private let record: (String) -> Void
    init(order: @escaping (String) -> Void) { record = order }
    func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool { false }
    func playChime(_ buffer: AVAudioPCMBuffer) -> Bool { record("chime"); return true }
    func stopOutput() { record("stop") }
    func rampDown(overMs: Int, after: (@MainActor () -> Void)?) { after?() }
}

/// #107: a recorder instead of launchctl, so no test ever touches the real user domain.
final class RecordingRelaunchRunner: AlarmRelaunchRunning {
    private(set) var invocations: [[String]] = []
    /// What launchctl answers: 0 accepted, anything else refused.
    var status: Int32 = 0
    func run(_ arguments: [String]) throws -> Int32 { invocations.append(arguments); return status }
}

final class RefusedEvents {
    private(set) var values: [AlarmRelaunchEvent] = []
    func record(_ event: AlarmRelaunchEvent) { values.append(event) }
}

@MainActor final class SyntheticSessionState {
    var state: NativeLiveConversation.State = .idle
}

@main struct AlarmShellMain {
    @MainActor static func main() {
        precondition(NativeAlarmShell.notificationContent().sound != nil, "fallback notification must have sound")
        let output = SilentAlarmOutput()
        var callbacks: [@MainActor () -> Void] = []
        let ring = ConnectingRing(output: output, now: { 1000 }, deferStart: { $0() }, after: { _, body in callbacks.append(body) })
        precondition(ring.startAlarm(deadlineMs: 601000))
        precondition(output.chimes == 1)
        ring.presenceChanged(.live, failed: false)
        for callback in callbacks { callback() }
        precondition(output.chimes == 1, "queued alarm pulse cannot chime once the call is live")
        precondition(output.stops > 0)

        // 1. Alarm routing reads the session state: a live call gets the host note and no chime,
        // and only an app with no session opens a conversation for the alarm.
        let authority = (URL(string: "http://127.0.0.1:1/")!, { (_: URL, _: String?) -> URLRequest in throw URLError(.unsupportedURL) })
        let dueAt = Int(Date().timeIntervalSince1970 * 1000) + 60_000
        func dueFrame(_ id: String) -> NativeAlarmShell.Frame {
            NativeAlarmShell.Frame(type: "alarm_due",
                alarm: ShellAlarm(id: id, fireAtUtc: dueAt, tz: "UTC", state: "ringing", ringDeadlineUtc: dueAt),
                alarms: nil)
        }
        /// One occurrence on one conversation state: the chime and the conversations it opened.
        func routing(_ state: NativeLiveConversation.State) -> (chimes: Int, opened: Int) {
            let probe = SilentAlarmOutput()
            let probeRing = ConnectingRing(output: probe, now: { 1000 }, deferStart: { $0() }, after: { _, _ in })
            let session = SyntheticSessionState(); session.state = state
            var opened: [String] = []
            let probeShell = NativeAlarmShell(authority: authority, ring: probeRing, sessionState: { session.state },
                                              onDue: { opened.append($0) }, onCaption: { _ in })
            probeShell.receive(dueFrame("synthetic-\(state.rawValue)"))
            probeShell.receive(dueFrame("synthetic-\(state.rawValue)"))
            return (probe.chimes, opened.count)
        }
        for state in [NativeLiveConversation.State.connecting, .listening, .speaking, .muted,
                      .outcomeUnknown, .pausedForInput, .rebuilding] {
            precondition(NativeAlarmShell.sessionIsLive(state), "\(state) is a live session")
            let heard = routing(state)
            precondition(heard.chimes == 0, "\(state) never chimes into the call")
            precondition(heard.opened == 0, "\(state) never opens a second conversation")
        }
        for state in [NativeLiveConversation.State.idle, .ended, .failed] {
            precondition(!NativeAlarmShell.sessionIsLive(state), "\(state) is not a live session")
            let heard = routing(state)
            precondition(heard.chimes == 1, "\(state) may chime")
            precondition(heard.opened == 1, "\(state) opens the alarm conversation once")
        }
        // C-ALARMSPEECH: the call opens before the first chime, so the microphone path is claimed before our
        // own ring and echo cancellation stays on built-in. And a failed alarm gets exactly one retry,
        // only while the ring deadline is open.
        do {
            var order: [String] = []
            let probe = OrderingAlarmOutput(order: { order.append($0) })
            let probeRing = ConnectingRing(output: probe, now: { 1000 }, deferStart: { $0() }, after: { _, _ in })
            let session = SyntheticSessionState()
            var starts = 0
            let probeShell = NativeAlarmShell(authority: authority, ring: probeRing, sessionState: { session.state },
                                              onDue: { _ in starts += 1; order.append("start") }, onCaption: { _ in })
            probeShell.receive(dueFrame("synthetic-order"))
            precondition(order.first == "start" && order.contains("chime")
                         && order.firstIndex(of: "start")! < order.firstIndex(of: "chime")!,
                         "the alarm call opens before the first chime, got \(order)")
            precondition(starts == 1, "one due alarm opens one conversation")
            // One retry, while the deadline is open; the second failure is final.
            probeShell.speechFailed("synthetic-order", reason: "snapshot_mismatch")
            precondition(starts == 2, "a failed alarm is retried once")
            probeShell.speechFailed("synthetic-order", reason: "snapshot_mismatch")
            precondition(starts == 2, "the retry never becomes a loop")
        }


        // 2. The notification permission is reported only after it resolved.
        precondition(NativeAlarmShell.NotificationPermission.notAsked.rawValue == "not_asked")
        precondition(NativeAlarmShell.permissionState(authorized: true) == .allowed)
        precondition(NativeAlarmShell.permissionState(authorized: false) == .denied)
        let before = NativeAlarmShell.shellReport(assertion: true, notificationsAllowed: false, state: .notAsked)
        precondition(before["notificationState"] as? String == "not_asked", "an unresolved request is not denied")
        let after = NativeAlarmShell.shellReport(assertion: true, notificationsAllowed: false, state: .denied)
        precondition(after["notificationState"] as? String == "denied")

        // C-ALARMSPEECH: a failed alarm is loud. The notification names the failure, never the label,
        // carries its own identifier so a ringing alarm cannot sweep it away, and asks for sound.
        let failed = NativeAlarmShell.speechFailedContent()
        precondition(failed.body == "Naya could not start. Your alarm is still ringing.",
                     "the failure notification says what happened")
        precondition(failed.sound != nil, "the failure notification is audible")
        precondition(NativeAlarmShell.speechFailedIdentifier("synthetic-7") == "alarm-failed:synthetic-7",
                     "the failure notification outlives the alarm's own identifier")
        precondition(NativeAlarmShell.notificationAuthorizationOptions.contains(.sound),
                     "alarm notifications are authorized with sound")

        // C-ALARMSPEECH: the alarm opens through presence, so the machine reaches LIVE (the only thing that
        // stops the ring), the key acts on that call, and the alarm id is consumed by exactly one session.
        do {
            var opened: [UInt64] = []
            let effects = PresenceEffects(openSession: { opened.append($0) })
            let machine = NativePresence(effects: effects, now: { 1000 })
            machine.start(.alarm, alarmID: "synthetic-alarm")
            precondition(machine.state == .connecting, "a cold alarm start opens presence")
            precondition(machine.takeAlarmID() == "synthetic-alarm", "the alarm id reaches the session it opens")
            precondition(machine.takeAlarmID() == nil, "the alarm id is consumed once")
            let generation = opened.last ?? 0
            machine.ready(generation)
            precondition(machine.state == .live, "the alarm call reaches LIVE, which is what stops the chime")
            machine.tap(.hotkey)
            precondition(machine.state == .hotMuted, "the owner's key acts on the alarm call instead of failing")
        }

        // 3. One LaunchAgent for the next due alarm, rewritten on mutation, removed when empty,
        // and driven through an injected runner inside a temp domain.
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("didi-alarm-relaunch-\(UUID().uuidString)")
        let runner = RecordingRelaunchRunner()
        let writer = NativeAlarmRelaunchWriter(directory: directory, domain: "gui/9999-synthetic",
                                               runner: runner, appPath: { "/synthetic/Lux Didi.app" })
        var events: [AlarmRelaunchEvent] = []
        writer.onEvent = { events.append($0) }
        writer.sync(pendingDueMs: [])
        precondition(!FileManager.default.fileExists(atPath: writer.plistURL.path), "no pending alarm means no agent")
        let firstDue = 1_800_000_000_000
        writer.sync(pendingDueMs: [firstDue + 60_000, firstDue])
        precondition(writer.armedStartMs == firstDue - 60_000, "the agent fires one minute before the next due time")
        let written = (try? String(contentsOf: writer.plistURL, encoding: .utf8)) ?? ""
        precondition(written.contains("<string>ai.peat.lux-didi.alarm</string>"), "one label")
        precondition(written.contains("<string>-g</string>") && written.contains("/synthetic/Lux Didi.app"),
                     "the agent opens the app in the background")
        precondition(written.contains("<string>--args</string>") && written.contains("--alarm-relaunch"),
                     "the launch carries the alarm argument")
        precondition(written.contains("StartCalendarInterval"), "the agent is timed")
        // C-ALARMSPEECH: the agent's own reopen is logged as the alarm relaunch, once, and a Dock click
        // at any other time stays a Dock click. The launch kind never shows extra UI at launch.
        precondition(writer.takeOwnStart(nowMs: writer.armedStartMs!), "the agent's own fire is recognised")
        precondition(!writer.takeOwnStart(nowMs: writer.armedStartMs ?? firstDue - 60_000),
                     "the agent's own fire is consumed once")
        precondition(!writer.takeOwnStart(nowMs: 0), "a reopen with no armed agent is a Dock click")
        precondition(!LaunchKind.alarmRelaunch.presentsOrbAtLaunch && !LaunchKind.alarmRelaunch.presentsWindowAtLaunch,
                     "the relaunch shows nothing extra until the alarm is due")
        // The interval is launchd's own: Minute, Hour, Day and Month, and no key launchd rejects.
        precondition(!written.contains("<key>Year</key>"), "launchd has no Year key")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        func intervalKeys(_ start: Int, _ calendar: Calendar = .current) -> [String] {
            let parts = calendar.dateComponents([.month, .day, .hour, .minute],
                                                from: Date(timeIntervalSince1970: TimeInterval(start) / 1000))
            let pairs: [(String, Int?)] = [("Month", parts.month), ("Day", parts.day),
                                           ("Hour", parts.hour), ("Minute", parts.minute)]
            return pairs.map { "<key>\($0.0)</key><integer>\($0.1!)</integer>" }
        }
        for key in intervalKeys(firstDue - 60_000) { precondition(written.contains(key), "the interval pins \(key)") }
        // A due time just after midnight arms the agent at 23:59 the evening before.
        let midnightDue = Int(ISO8601DateFormatter().date(from: "2026-11-01T00:00:30Z")!.timeIntervalSince1970 * 1000)
        let midnight = NativeAlarmRelaunchWriter.plist(startMs: NativeAlarmRelaunchWriter.startMs(dueMs: midnightDue),
                                                       label: NativeAlarmRelaunchWriter.label,
                                                       appPath: "/synthetic/Lux Didi.app", calendar: utc)
        for key in intervalKeys(midnightDue - 60_000, utc) { precondition(midnight.contains(key), "the minute before midnight pins \(key)") }
        precondition(midnight.contains("<key>Day</key><integer>31</integer>"), "the day before, never the due day")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        precondition(files == [NativeAlarmRelaunchWriter.fileName], "exactly one plist")
        writer.sync(pendingDueMs: [firstDue + 3_600_000])
        precondition(writer.armedStartMs == firstDue + 3_600_000 - 60_000, "a mutation rewrites the time")
        precondition(runner.invocations.contains(["bootstrap", "gui/9999-synthetic", writer.plistURL.path]),
                     "the agent is bootstrapped in the injected domain")
        precondition(runner.invocations.contains(["bootout", "gui/9999-synthetic/ai.peat.lux-didi.alarm"]),
                     "the agent is booted out before it is replaced")
        precondition(runner.invocations.allSatisfy { $0.first != "gui/\(getuid())" && !$0.contains("gui/\(getuid())") },
                     "no runner call touches the real user domain")
        writer.sync(pendingDueMs: [])
        precondition(!FileManager.default.fileExists(atPath: writer.plistURL.path), "nothing pending removes the agent")
        precondition(events.filter { if case .scheduled = $0 { return true } else { return false } }.count == 2,
                     "two observed schedules")
        precondition(events.last == .removed, "removal is observed")
        // A refused bootstrap is a degraded signal, never a scheduled event.
        let refused = RecordingRelaunchRunner(); refused.status = 1
        let refusedEvents = RefusedEvents()
        let refusedWriter = NativeAlarmRelaunchWriter(directory: directory.appendingPathComponent("refused"),
                                                      domain: "gui/9999-synthetic", runner: refused,
                                                      appPath: { "/synthetic/Lux Didi.app" })
        refusedWriter.onEvent = { refusedEvents.record($0) }
        refusedWriter.sync(pendingDueMs: [firstDue])
        precondition(refusedWriter.armedStartMs == nil, "a refused bootstrap arms nothing")
        precondition(refusedEvents.values == [.failed], "a refusal is its own degraded event")

        // 4. A launch with the alarm argument names itself and takes no focus.
        let relaunch = LaunchKind.resolve(arguments: ["/app", "--alarm-relaunch"], environment: [:], loginLaunch: false)
        precondition(relaunch == .alarmRelaunch)
        precondition(relaunch.launchRecord["kind"] as? String == "alarm_relaunch", "the launch kind is logged")
        precondition(!relaunch.activates && !relaunch.presentsWindowAtLaunch && !relaunch.presentsOrbAtLaunch,
                     "a relaunch never steals focus and shows nothing")
        print("ALARM-SHELL PASS assertions=38 headless=true audio=false")
    }
}
