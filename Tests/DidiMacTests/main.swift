import Foundation

let testStarted = Date()

func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else { fatalError("FAIL: \(label)") }
    print("PASS: \(label)")
}

let reminder = ReminderEnvelope(commitmentID: "promise-7", revision: 3, title: "A reminder", body: "Review the plan")
expect(reminder.identifier == "commitment.promise-7.r3", "stable notification identity")
expect(reminder.userInfo["commitmentID"] == "promise-7", "deep link promise identity")
expect(reminder.userInfo["revision"] == "3", "deep link revision")
expect(ReminderEnvelope.decode(reminder.userInfo) == ReminderLink(commitmentID: "promise-7", revision: 3), "notification link roundtrip")
expect(ReminderEnvelope.decode(["commitmentID": "", "revision": "bad"]) == nil, "malformed deep link rejected")
expect(NotificationCapability.notDetermined.canSchedule == false, "no implicit permission")
expect(NotificationCapability.denied.canSchedule == false, "denial blocks delivery")
expect(NotificationCapability.authorized.canSchedule, "OS permission supports submission, not read proof")

var voice = VoiceState()
expect(voice.phase == .idle, "microphone idle by default")
expect(!voice.start(microphone: .denied, speech: .granted, onDevice: true), "denied microphone blocks recording")
expect(!voice.start(microphone: .granted, speech: .granted, onDevice: false), "cloud-only speech refused")
expect(voice.start(microphone: .granted, speech: .granted, onDevice: true), "local recording can start with both grants")
voice.receive("Remember tomorrow")
expect(voice.transcript == "Remember tomorrow", "transcript visible")
voice.stop(reason: "Escape")
expect(voice.phase == .idle && voice.transcript == "Remember tomorrow", "stop retains editable text")
voice.fail("Interrupted")
expect(voice.phase == .failed && voice.detail == "Interrupted", "interruption remains visible")

do {
    _ = try ServiceDescriptor(origin: "http://localhost:1234", credentialService: "synthetic", credentialAccount: "test")
    fatalError("Unconfigured localhost must not become trusted")
} catch { print("PASS: unapproved service descriptor rejected") }
expect(Presentation.canSend("  hello\n") && !Presentation.canSend(" \n"), "text input boundary")
expect(Presentation.notificationResult(.acknowledged).contains("not proof"), "accepted is not read")
print("MAC-SEAMS PASS duration=\(Date().timeIntervalSince(testStarted))s file=Tests/DidiMacTests/main.swift")

let connectionRows = try JSONDecoder().decode([NativeLiveConnection].self, from: Data("[{\"id\":\"calendar\",\"state\":\"error\",\"reasonCode\":\"credential_missing\"}]".utf8))
expect(connectionRows[0].id == "calendar" && connectionRows[0].state == "error", "Connections card decodes connector state")
expect(connectionRows[0].reason == "Credential missing or invalid", "Connections card explains missing credentials")

// These seams never instantiate the system login registrar or Carbon hotkeys.
final class FakeLogin: LoginRegistration {
    var status: LoginStatus = .off
    var calls = 0
    func setEnabled(_ enabled: Bool) throws { calls += 1; status = enabled ? .on : .off }
}
let fakeLogin = FakeLogin()
let login = LoginAvailability(registration: fakeLogin)
try login.setEnabled(true)
expect(login.status == .on && fakeLogin.calls == 1, "login opt-in uses fake registration")
try login.setEnabled(false)
expect(login.status == .off && fakeLogin.calls == 2, "login opt-out uses fake registration")
fakeLogin.status = .revoked
expect(login.status == .revoked, "login revoked status reflects registrar, not preference")
expect(ShortcutStatus.describe(code: -9878).contains("Unavailable"), "shortcut conflict is visible")
expect(ShortcutStatus.describe(code: 0).contains("registered"), "shortcut success is visible")
for state in ["listening", "speaking", "muted", "connecting", "stopped"] {
    expect(LiveStatusPresentation(state: state, pendingCall: false).text.contains(state), "status exposes \(state)")
    expect(LiveStatusPresentation(state: state, pendingCall: true).text.contains(state), "call badge preserves \(state)")
}
let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
let lost = CGRect(x: 9000, y: 9000, width: 980, height: 760)
expect(WindowFrameRestore.resolve(lost, screens: [screen]) != lost, "off-screen frame falls back")
let visible = CGRect(x: 100, y: 50, width: 980, height: 760)
expect(WindowFrameRestore.resolve(visible, screens: [screen]) == visible, "visible frame retained")
expect(NativeNoteAction.label == "Save note", "local note action is honest")

var registeredKeys: [UInt32] = []
let shortcutRegistration = LiveShortcutRegistration { _, id in
    registeredKeys.append(id)
    return id == 1 ? -9878 : 0
}
expect(registeredKeys == [1, 2], "shortcut registrations are separate even when Start conflicts")
expect(shortcutRegistration.startStatus.contains("Unavailable") && shortcutRegistration.muteStatus == "registered", "conflict does not hide independent mute registration")
var shown = 0, started = 0, muted = 0, stopped = 0
var active = false
let actions = NativeSummonActions(show: { shown += 1 }, isCapturing: { active }, start: {
    active = true; started += 1
}, mute: { muted += 1 }, stop: { active = false; stopped += 1 })
actions.show()
expect(shown == 1 && started == 0, "Show never starts capture")
actions.start(); actions.start()
expect(shown == 3 && started == 1, "menu and shortcut share the guarded start under repeats")
actions.mute(); actions.stop()
expect(muted == 1 && stopped == 1 && !active, "mute and stop route without starting")
expect(NativeLaunchVisibility.shouldShow(loginLaunch: true) == false, "login launch stays hidden")
expect(NativeLaunchVisibility.shouldShow(loginLaunch: false), "ordinary launch shows window without starting")

for state in ["idle", "ended", "failed", "outcomeUnknown"] {
    expect(LiveStatusPresentation(state: state, pendingCall: false).text == "Naya: stopped", "inactive status \(state) is stopped")
}
expect(LiveStatusPresentation(state: "ended", pendingCall: false, dictationCapturing: true).state == "listening", "dictation microphone is not reported stopped")
