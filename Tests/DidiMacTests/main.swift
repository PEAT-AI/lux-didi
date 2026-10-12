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

// Pure lifecycle seam: no process, network, microphone or real-clock wait.
var queuedRestarts: [(Double, () -> Void)] = []
var launches: [UInt64] = [], lostServices = 0, reconciles = 0
let recovery = NativeServiceRecovery(
    schedule: { delay, action in queuedRestarts.append((delay, action)); return {} },
    launch: { launches.append($0) }, lost: { lostServices += 1 },
    reconcile: { reconciles += 1 })
let firstChild = recovery.activate()
recovery.childExited(firstChild)
precondition(queuedRestarts.map { $0.0 } == [1] && lostServices == 1)
queuedRestarts.removeFirst().1()
let replacementTicket = launches.last!
recovery.finished(replacementTicket, success: true)
recovery.childExited(firstChild)
precondition(queuedRestarts.isEmpty, "old child callback must be rejected")
recovery.wake(); precondition(reconciles == 1)
recovery.childExited(recovery.generation)
queuedRestarts.removeFirst().1(); recovery.finished(launches.last!, success: false)
precondition(queuedRestarts.first?.0 == 4, "backoff retains prior recovery attempts")
queuedRestarts.removeFirst().1(); recovery.finished(launches.last!, success: false)
precondition(queuedRestarts.isEmpty && recovery.exhausted, "retry cap")
_ = recovery.activate(); recovery.childExited(recovery.generation)
let cancelledRestart = queuedRestarts.removeFirst().1
recovery.stop(); cancelledRestart()
precondition(launches.count == 3, "Quit invalidates queued restart")
print("PASS service retry cap/backoff, Quit cancellation, stale child fencing and wake reconcile; no microphone seam")
