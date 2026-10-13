import Foundation
import UserNotifications

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

MainActor.assumeIsolated {
let recoveryTestStarted = Date()
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
print("DURATION service-recovery-seams=\(Date().timeIntervalSince(recoveryTestStarted))s")
}

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
for state in ["Listening", "Speaking", "Microphone muted", "Connecting", "Live voice stopped"] {
    expect(LiveStatusPresentation(presentation: (state, "mic.fill"), pendingCall: false).text.contains(state), "status exposes \(state)")
    expect(LiveStatusPresentation(presentation: (state, "mic.fill"), pendingCall: true).text.contains(state), "call badge preserves \(state)")
}
let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
let lost = CGRect(x: 9000, y: 9000, width: 980, height: 760)
expect(WindowFrameRestore.resolve(lost, screens: [screen]) != lost, "off-screen frame falls back")
let visible = CGRect(x: 100, y: 50, width: 980, height: 760)
expect(WindowFrameRestore.resolve(visible, screens: [screen]) == visible, "visible frame retained")
expect(NativeNoteAction.label == "Save note", "local note action is honest")
expect(NativeConnectedSend.label == "Send to Naya", "connected action is separately labelled")
expect(NativeConnectedSend.consentInstruction == "Enable connected chat in the conversation view.", "missing consent directs owner to shared conversation")

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

expect(LiveStatusPresentation(presentation: ("Live voice stopped", "mic.slash"), pendingCall: false).text == "Naya: Live voice stopped", "status item renders the mapped sentence")
expect(LiveStatusPresentation(presentation: ("Live voice stopped", "mic.slash"), pendingCall: false, dictationCapturing: true).text == "Naya: Dictating", "dictation microphone is not reported stopped")

let inputPausedPresentation = (text: "Microphone changed; Resume required", symbol: "pause.circle")
let inputPausedStatus = LiveStatusPresentation(presentation: inputPausedPresentation, pendingCall: false)
expect(inputPausedStatus.text == "Naya: " + inputPausedPresentation.text, "status item prefixes the mapped tuple sentence")
expect(inputPausedStatus.symbol == "pause.circle", "input pause status is not active recording")

// Actual app ownership seam plus actual authenticated request builders, no HTTP or audio.
try MainActor.assumeIsolated {
    let started = Date()
    typealias Authority = (origin: URL, request: NativeLiveRequestBuilder)
    let oldDescriptor = try ServiceDescriptor(origin: "http://127.0.0.1:41231", credentialService: "test", credentialAccount: "old")
    let newDescriptor = try ServiceDescriptor(origin: "http://127.0.0.1:41232", credentialService: "test", credentialAccount: "new")
    var currentNonce = "old"
    let oldClient = CompanionClient(descriptor: oldDescriptor, credential: { "old-proof-token" },
                                    expectedEpoch: "old-epoch", connectionGuard: { currentNonce == "old" })
    let newClient = CompanionClient(descriptor: newDescriptor, credential: { "new-proof-token" },
                                    expectedEpoch: "new-epoch", connectionGuard: { currentNonce == "new" })
    var creates = 0, captures = 0, releases = 0
    var presented: Authority?
    let owner = NativeLiveAuthorityOwner<Authority>(release: { _ in captures = 0; releases += 1 },
                                                   publish: { presented = $0 })
    owner.rebind("old")
    let oldLive = owner.ownerStart {
        creates += 1; captures += 1; return oldClient.authenticatedRequestBuilder()
    }
    _ = try oldLive.request(oldLive.origin.appendingPathComponent("api/live/status"), "old-epoch")
    owner.unavailable(); currentNonce = "new"
    expect(captures == 0 && creates == 1, "child exit releases capture without an automatic Start")
    owner.rebind("new")
    expect(captures == 0 && creates == 1, "successful service recovery never creates Live or capture")
    let replacementLive = owner.ownerStart {
        creates += 1; captures += 1; return newClient.authenticatedRequestBuilder()
    }
    expect(replacementLive.origin == newDescriptor.baseURL && creates == 2,
           "explicit Start after child recovery must use replacement Live authority")
    let request = try replacementLive.request(replacementLive.origin.appendingPathComponent("api/live/status"), "new-epoch")
    expect(request.url?.port == 41232 && request.value(forHTTPHeaderField: "Authorization") == "Bearer new-proof-token",
           "replacement Live request uses new origin and credential")
    owner.rebind("new")
    expect(captures == 1 && creates == 2 && presented?.origin == newDescriptor.baseURL,
           "wake health reconcile with same authority preserves the current Live owner")
    owner.unavailable()
    expect(captures == 0 && presented == nil && releases == 2, "lost replacement clears stale Live presentation")
    print("DURATION live-authority-recovery-seam=\(Date().timeIntervalSince(started))s")
}

// Copy diagnostics: pure snapshot seam, no AppKit, no pasteboard, no secrets.
let diagnosticsFixture = DiagnosticsSnapshotInput(
    appVersion: "1.2.3",
    releaseCommit: "0e11a5835643966ac8ea8cc532ebb16202803146",
    macOSVersion: "Version 14.5 (Build 23F79)",
    serviceState: "connected",
    serviceOrigin: "http://127.0.0.1:41231",
    liveState: "listening",
    sessionLimit: "30 min",
    idleLimit: "2 min",
    connections: ["filesystem: connected", "calendar: unreachable"],
    audioRoute: "Input: built-in; Output: built-in",
    preCreateFailureClass: "service",
    preCreateFailureCode: "connection_refused",
    capturedAt: "2026-10-12T07:00:00Z")
let diagnosticsText = NativeDiagnosticsSnapshot.render(diagnosticsFixture)
for field in ["1.2.3", "0e11a5835643966ac8ea8cc532ebb16202803146", "Version 14.5", "connected",
              "41231", "listening", "30 min", "2 min", "filesystem: connected",
              "calendar: unreachable", "Input: built-in", "Output: built-in",
              "service", "connection_refused", "2026-10-12T07:00:00Z"] {
    expect(diagnosticsText.contains(field), "diagnostics snapshot renders \(field)")
}
let diagnosticsEmpty = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput())
expect(diagnosticsEmpty.contains("unknown"), "missing diagnostics inputs render unknown")
let diagnosticsSecret = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput(
    appVersion: "Bearer abc.def.ghi",
    serviceState: "cookie=session%3Dxyz",
    connections: ["mail: key=deadbeef"],
    audioRoute: "api_key=sk-live-1234567890",
    preCreateFailureCode: "token=supersecret"))
for secret in ["Bearer", "abc.def.ghi", "cookie", "session%3Dxyz", "api_key", "sk-live",
               "deadbeef", "token=", "supersecret"] {
    expect(!diagnosticsSecret.contains(secret), "diagnostics snapshot never leaks \(secret)")
}
var diagnosticsWritten = ""
let diagnosticsAction = NativeDiagnosticsAction(makeInput: { diagnosticsFixture },
                                               write: { diagnosticsWritten = $0 })
expect(NativeDiagnosticsAction.itemTitle == "Copy diagnostics", "diagnostics menu item title")
diagnosticsAction.copy()
expect(diagnosticsWritten == diagnosticsText, "diagnostics menu action writes the builder output")
print("DURATION diagnostics-snapshot-seam=\(Date().timeIntervalSince(testStarted))s")
// Silent callbacks are attention only: the seam has no audio or conversation dependency.
var calls = NativeLiveCallDelivery()
calls.reconcile(["a", "b"])
expect(calls.beginAttempt("a", permitted: false) == false, "denied notifications retain the badge without submitting")
expect(calls.pendingIDs == ["a", "b"], "multiple pending calls remain independently visible")
expect(calls.beginAttempt("a", permitted: true), "first notification attempt")
calls.completeAttempt("a", result: .failed("transient"))
expect(!calls.notified.contains("a"), "failure is not notification acknowledgement")
expect(calls.beginAttempt("a", permitted: true), "transient failure retries")
calls.completeAttempt("a", result: .acknowledged)
expect(!calls.beginAttempt("a", permitted: true), "successful submission never repeats")
for _ in 0..<3 {
    expect(calls.beginAttempt("b", permitted: true), "bounded retry admitted")
    calls.completeAttempt("b", result: .failed("offline"))
}
expect(!calls.beginAttempt("b", permitted: true), "retry bound stops spam")
calls.reconcile(nil)
expect(!calls.isFresh && calls.pendingIDs.isEmpty, "poll error clears stale offers and marks offline")
calls.reconcile([])
expect(!calls.canPickUp("a"), "stale notification click cannot pick up")
calls.reconcile(["a"])
calls.acknowledge("a")
calls.reconcile(["a"])
expect(!calls.canPickUp("a") && !calls.beginAttempt("a", permitted: true), "acknowledged job never offers or notifies again")
var relaunched = NativeLiveCallDelivery()
relaunched.reconcile(["pending-at-launch"])
expect(relaunched.canPickUp("pending-at-launch"), "relaunch discovers durable pending job")

final class FakeNotificationCenter: NativeNotificationCenter {
    var permission: NotificationCapability = .denied
    var failOnce = false
    var requests: [UNNotificationRequest] = []
    var permissionRequests = 0
    func cancel(identifier: String) {}
    func capability() async -> NotificationCapability { permission }
    func requestPermission() async throws -> Bool {
        permissionRequests += 1
        return permission.canSchedule
    }
    func add(_ request: UNNotificationRequest) async throws {
        if failOnce { failOnce = false; throw NSError(domain: "fake-transient", code: 1) }
        requests.append(request)
    }
}
let fakeCenter = FakeNotificationCenter()
let notifications = NativeNotifications(center: fakeCenter)
let deniedResult = await notifications.submitLiveCall(jobID: "private-result-job")
expect(deniedResult != .acknowledged && fakeCenter.requests.isEmpty, "denied center receives no submission")
expect(fakeCenter.permissionRequests == 0, "delivery never requests permission automatically")
_ = await notifications.requestPermission()
expect(fakeCenter.permissionRequests == 1, "only explicit consent requests permission")
fakeCenter.permission = .authorized
fakeCenter.failOnce = true
var fakeDelivery = NativeLiveCallDelivery()
fakeDelivery.reconcile(["private-result-job"])
for _ in 0..<3 {
    if fakeDelivery.beginAttempt("private-result-job", permitted: true) {
        fakeDelivery.completeAttempt("private-result-job", result: await notifications.submitLiveCall(jobID: "private-result-job"))
    }
}
expect(fakeCenter.requests.count == 1 && fakeDelivery.notified.contains("private-result-job"), "fake center failure retries once then remembers success")
let quietRequest = fakeCenter.requests[0]
expect(quietRequest.content.sound == nil, "callback notification stays silent")
expect(quietRequest.content.body == "Your background task is ready. Pick up when you want.", "callback body contains no result text")
expect(quietRequest.content.userInfo["liveJobId"] as? String == "private-result-job", "callback carries only job identity for revalidation")

var conversationRunning = true
var stopCount = 0
var captureCount = 0
var pickupOrder: [String] = []
func stopConversation() async { stopCount += 1; conversationRunning = false; pickupOrder.append("stop") }
func startCapture() { captureCount += 1; pickupOrder.append("start") }
var polled = NativeLiveCallDelivery()
// Fake poll: ready job, transport error, then job gone.
polled.reconcile(["ready"])
expect(captureCount == 0 && stopCount == 0, "poll offer never starts capture or stops a conversation")
polled.reconcile(nil)
expect(captureCount == 0 && !polled.isFresh, "offline poll never starts capture")
polled.reconcile([])
let invalidPickup = try await NativeLiveCallPickup.perform(validate: {
    pickupOrder.append("validate")
    return polled.canPickUp("ready")
}, stop: stopConversation, start: startCapture)
expect(!invalidPickup && conversationRunning && stopCount == 0 && captureCount == 0, "invalid pickup during an active conversation keeps it running")
expect(pickupOrder == ["validate"], "stale click validates without stop or capture")
do {
    _ = try await NativeLiveCallPickup.perform(validate: {
        throw NSError(domain: "fake-poll-offline", code: 1)
    }, stop: stopConversation, start: startCapture)
    fatalError("offline pickup must throw")
} catch {
    expect(conversationRunning && stopCount == 0 && captureCount == 0, "pickup poll error preserves active conversation")
}
polled.reconcile(["ready"])
pickupOrder = []
let validPickup = try await NativeLiveCallPickup.perform(validate: {
    pickupOrder.append("validate")
    return polled.canPickUp("ready")
}, stop: stopConversation, start: startCapture)
expect(validPickup && stopCount == 1 && captureCount == 1, "explicit valid pickup is the only capture hook")
expect(pickupOrder == ["validate", "stop", "start"], "pickup validates before interrupting and starting capture")
print("MAC-CALLBACK-SEAMS PASS duration=\(String(format: "%.3f", Date().timeIntervalSince(testStarted)))s")

expect(LiveStatusPresentation(presentation: ("Reconnecting", "ellipsis.circle"), pendingCall: false).text == "Naya: Reconnecting", "continuity status is Reconnecting")

// R-SEC-3: ordinary owner/device labels are not safe support exports.
let personalRoute = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput(audioRoute: "Microphone: Alice Smith's AirPods · Output: Alice Smith's AirPods"))
expect(!personalRoute.contains("Alice") && !personalRoute.contains("AirPods"), "diagnostics excludes personal device names")
for capability in [NotificationCapability.notDetermined, .denied, .authorized, .provisional, .unknown] {
    expect(!capability.presentation.contains(capability.rawValue), "no raw notification case reaches a label")
}
