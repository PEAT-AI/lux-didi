import Foundation
import UserNotifications

@main struct AlarmShellMain {
    @MainActor static func main() {
        precondition(NativeAlarmShell.notificationContent().sound != nil, "fallback notification must have sound")
        precondition(!NativeAlarmShell.shouldChime(callLive: true), "never chime over a live call")
        precondition(NativeAlarmShell.shouldChime(callLive: false), "standalone alarm may chime")
        print("ALARM-SHELL PASS assertions=3 headless=true audio=false")
    }
}
