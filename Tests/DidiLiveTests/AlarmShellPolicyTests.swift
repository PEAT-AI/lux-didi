import AVFoundation
import Foundation
import UserNotifications

// C-ALARMSPEECH: the alarm-shell policy facts a spoken alarm now depends on.
//
// These live beside the other native fixtures rather than in Tests/DidiAlarmTests, because this contract's
// scope names Tests/DidiLiveTests. Tests/DidiAlarmTests/check-alarm-shell.sh keeps its own coverage of the
// main suite; scripts/check-installed-alarm.sh compiles the production sources with this file and runs it,
// so every assertion here executes on a host with no window, no audio device and no launched app.

/// Records chimes and stops in one order list, so a test can prove what came first.
@MainActor final class OrderingAlarmOutput: ConnectingRingOutput {
    private let record: (String) -> Void
    init(order: @escaping (String) -> Void) { record = order }
    func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool { false }
    func playChime(_ buffer: AVAudioPCMBuffer) -> Bool { record("chime"); return true }
    func stopOutput() { record("stop") }
    func rampDown(overMs: Int, after: (@MainActor () -> Void)?) { after?() }
}

@MainActor final class SyntheticSessionState {
    var state: NativeLiveConversation.State = .idle
}

/// A recorder instead of launchctl, so no test ever touches the real user domain.
final class SyntheticRelaunchRunner: AlarmRelaunchRunning {
    private(set) var invocations: [[String]] = []
    func run(_ arguments: [String]) throws -> Int32 { invocations.append(arguments); return 0 }
}

enum AlarmShellProbe {
    struct Failure: Error, CustomStringConvertible { let description: String }
}

@main struct AlarmSpeechPolicyMain {
    @MainActor static func main() {
        do { try run() ; print("ALARM SHELL POLICY: PASS") }
        catch { print("ALARM SHELL POLICY: FAIL \(error)"); exit(1) }
    }

    static func check(_ condition: Bool, _ detail: String) throws {
        if !condition { throw AlarmShellProbe.Failure(description: detail) }
    }

    @MainActor static func run() throws {
        // 1. A failed alarm is loud. The notification names the failure, never the label, carries its own
        // identifier so a ringing alarm cannot sweep it away, and asks for sound.
        let failed = NativeAlarmShell.speechFailedContent()
        try check(failed.body == "Naya could not start. Your alarm is still ringing.",
                  "the failure notification says what happened")
        try check(failed.sound != nil, "the failure notification is audible")
        try check(NativeAlarmShell.speechFailedIdentifier("synthetic-7") == "alarm-failed:synthetic-7",
                  "the failure notification outlives the alarm's own identifier")
        try check(NativeAlarmShell.notificationAuthorizationOptions.contains(.sound),
                  "alarm notifications are authorized with sound")

        // 1b. F-A: a refused alarm create is a `.failed(.conflict)`, not an unknown outcome, and that is the
        // branch a host 409 takes. It reports the same closed reason the host log accepts, once, and never
        // claims she could not start after she already spoke.
        try check(NativeLiveConversation.alarmSpeechFailure(.conflict, audible: false, alarm: true) == "create_refused",
                  "a refused alarm create reports create_refused")
        try check(NativeLiveConversation.alarmSpeechFailure(.grantMismatch, audible: false, alarm: true) == "snapshot_mismatch",
                  "a grant mismatch reports snapshot_mismatch")
        try check(NativeLiveConversation.alarmSpeechFailure(.socketClosed(code: 1006, reason: nil), audible: false, alarm: true) == "socket_lost",
                  "a lost socket reports socket_lost")
        try check(NativeLiveConversation.alarmSpeechFailure(.conflict, audible: true, alarm: true) == nil,
                  "an alarm that spoke never claims she could not start")
        try check(NativeLiveConversation.alarmSpeechFailure(.conflict, audible: false, alarm: false) == nil,
                  "a normal call never reports an alarm speech failure")

        // 2. The call opens before the first chime, so the microphone path is claimed before our own ring
        // and echo cancellation stays on built-in. And a failed alarm gets exactly one retry.
        let authority = (URL(string: "http://127.0.0.1:1/")!,
                         { (_: URL, _: String?) -> URLRequest in throw URLError(.unsupportedURL) })
        let dueAt = Int(Date().timeIntervalSince1970 * 1000) + 60_000
        func dueFrame(_ id: String) -> NativeAlarmShell.Frame {
            NativeAlarmShell.Frame(type: "alarm_due",
                alarm: ShellAlarm(id: id, fireAtUtc: dueAt, tz: "UTC", state: "ringing", ringDeadlineUtc: dueAt),
                alarms: nil)
        }
        var order: [String] = []
        let probe = OrderingAlarmOutput(order: { order.append($0) })
        let probeRing = ConnectingRing(output: probe, now: { 1000 }, deferStart: { $0() }, after: { _, _ in })
        let session = SyntheticSessionState()
        var starts = 0
        let shell = NativeAlarmShell(authority: authority, ring: probeRing, sessionState: { session.state },
                                     onDue: { _ in starts += 1; order.append("start") }, onCaption: { _ in })
        shell.receive(dueFrame("synthetic-order"))
        try check(order.first == "start" && order.contains("chime")
                  && order.firstIndex(of: "start")! < order.firstIndex(of: "chime")!,
                  "the alarm call opens before the first chime, got \(order)")
        try check(starts == 1, "one due alarm opens one conversation")
        shell.speechFailed("synthetic-order", reason: "snapshot_mismatch")
        try check(starts == 2, "a failed alarm is retried once")
        shell.speechFailed("synthetic-order", reason: "snapshot_mismatch")
        try check(starts == 2, "the retry never becomes a loop")

        // 3. The alarm opens through presence, so the machine reaches LIVE (the only thing that stops the
        // ring), the key acts on that call, and the alarm id is consumed by exactly one session.
        var opened: [UInt64] = []
        let effects = PresenceEffects(openSession: { opened.append($0) })
        let machine = NativePresence(effects: effects, now: { 1000 })
        machine.start(.alarm, alarmID: "synthetic-alarm")
        try check(machine.state == .connecting, "a cold alarm start opens presence")
        try check(machine.takeAlarmID() == "synthetic-alarm", "the alarm id reaches the session it opens")
        try check(machine.takeAlarmID() == nil, "the alarm id is consumed once")
        // F-C: an alarm start that does not connect leaves no id behind for the next session to inherit.
        let busy = NativePresence(effects: PresenceEffects(openSession: { _ in }), now: { 1000 })
        busy.start(.app)
        try check(busy.state == .connecting, "a cold start connects")
        busy.start(.alarm, alarmID: "synthetic-late-alarm")
        try check(busy.takeAlarmID() == nil, "a start that does not connect leaves no pending alarm id")
        machine.ready(opened.last ?? 0)
        try check(machine.state == .live, "the alarm call reaches LIVE, which is what stops the chime")
        machine.tap(.hotkey)
        try check(machine.state == .hotMuted, "the owner's key acts on the alarm call instead of failing")

        // 4. The relaunch agent's own reopen is logged as the alarm relaunch, once; a Dock click at any
        // other time stays a Dock click, and the launch kind shows nothing extra at launch.
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("didi-alarm-relaunch-policy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let writer = NativeAlarmRelaunchWriter(directory: directory, domain: "gui/9999-synthetic",
                                               runner: SyntheticRelaunchRunner(), appPath: { "/synthetic/Lux Didi.app" })
        let firstDue = 1_800_000_000_000
        writer.sync(pendingDueMs: [firstDue])
        let armed = writer.armedStartMs ?? 0
        try check(armed == firstDue - 60_000, "the agent fires a minute before the alarm")
        try check(writer.takeOwnStart(nowMs: armed), "the agent's own fire is recognised")
        try check(!writer.takeOwnStart(nowMs: armed), "the agent's own fire is consumed once")
        try check(!writer.takeOwnStart(nowMs: 0), "a reopen with no armed agent is a Dock click")
        try check(!LaunchKind.alarmRelaunch.presentsOrbAtLaunch && !LaunchKind.alarmRelaunch.presentsWindowAtLaunch,
                  "the relaunch shows nothing extra until the alarm is due")
    }
}
