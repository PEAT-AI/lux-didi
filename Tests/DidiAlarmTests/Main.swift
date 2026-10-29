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

@main struct AlarmShellMain {
    @MainActor static func main() {
        precondition(NativeAlarmShell.notificationContent().sound != nil, "fallback notification must have sound")
        precondition(!NativeAlarmShell.shouldChime(callLive: true), "never chime over a live call")
        precondition(NativeAlarmShell.shouldChime(callLive: false), "standalone alarm may chime")
        let output = SilentAlarmOutput()
        var callbacks: [@MainActor () -> Void] = []
        let ring = ConnectingRing(output: output, now: { 1000 }, deferStart: { $0() }, after: { _, body in callbacks.append(body) })
        precondition(ring.startAlarm(deadlineMs: 601000))
        precondition(output.chimes == 1)
        ring.presenceChanged(.live, failed: false)
        for callback in callbacks { callback() }
        precondition(output.chimes == 1, "queued alarm pulse cannot chime once the call is live")
        precondition(output.stops > 0)
        print("ALARM-SHELL PASS assertions=7 headless=true audio=false")
    }
}
