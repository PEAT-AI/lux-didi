import AppKit
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

// W15 mini orb: show starts Live, the same chord hides and stops it, a click
// expands to the full window and keeps Live running, and the frame is remembered.
var liveStarted = 0, liveStopped = 0, presented = 0, dismissed = 0, expanded = 0
var liveRunning = false
let miniOrb = MiniOrbToggle(
    startLive: { liveStarted += 1; liveRunning = true },
    stopLive: { liveStopped += 1; liveRunning = false },
    liveIsRunning: { liveRunning },
    presentPanel: { presented += 1 },
    dismissPanel: { dismissed += 1 },
    expandToWindow: { expanded += 1 })
expect(!miniOrb.isVisible, "mini orb starts hidden")
miniOrb.toggle()
expect(miniOrb.isVisible && liveStarted == 1 && presented == 1, "mini orb chord shows and starts Live")
miniOrb.toggle()
expect(!miniOrb.isVisible && liveStopped == 1 && dismissed == 1, "mini orb chord hides and stops Live")
miniOrb.show()
expect(liveStarted == 2 && presented == 2, "mini orb show starts Live once")
miniOrb.expand()
expect(expanded == 1 && dismissed == 2 && liveStopped == 1 && !miniOrb.isVisible, "mini orb click expands and keeps Live")
miniOrb.show()
expect(liveStarted == 2 && presented == 3, "a running Live is not restarted by the mini orb")

// MINI2: the single key. Right Command is Naya's key; Right Option belongs to
// SuperWhisper and is never watched. A tap fires, a chord use and a long hold do
// not, and a repeated press is still one press.
expect(RightCommandTapDetector.keyCode == 54 && RightCommandTapDetector.holdLimit == 0.3, "the single key is Right Command with a 300 ms hold limit")
var singleKeyDetector = RightCommandTapDetector()
expect(singleKeyDetector.handle(.rightCommandDown, at: 10) == false, "a Right Command press alone is not a tap")
expect(singleKeyDetector.handle(.rightCommandUp, at: 10.12), "a short Right Command tap fires")
expect(singleKeyDetector.handle(.rightCommandUp, at: 11) == false, "a release without a press never fires")
_ = singleKeyDetector.handle(.rightCommandDown, at: 20)
_ = singleKeyDetector.handle(.otherKeyDown, at: 20.05)
expect(singleKeyDetector.handle(.rightCommandUp, at: 20.1) == false, "Right Command in a chord (Cmd+C) never fires")
_ = singleKeyDetector.handle(.rightCommandDown, at: 30)
_ = singleKeyDetector.handle(.otherModifiers(held: true), at: 30.02)
expect(singleKeyDetector.handle(.rightCommandUp, at: 30.1) == false, "a second modifier in the press makes it a chord")

// B2 regression: a modifier already held BEFORE Right Command is a chord too, so
// Shift (or the owner's Right Option) plus a Right Command tap never fires.
_ = singleKeyDetector.handle(.otherModifiers(held: true), at: 100)
_ = singleKeyDetector.handle(.rightCommandDown, at: 100.1)
expect(singleKeyDetector.handle(.rightCommandUp, at: 100.2) == false, "a modifier held before the press makes it a chord")
_ = singleKeyDetector.handle(.otherModifiers(held: false), at: 101)
_ = singleKeyDetector.handle(.rightCommandDown, at: 102)
expect(singleKeyDetector.handle(.rightCommandUp, at: 102.05), "a plain tap after the modifier is released still fires")

// B3 regression: with Left Command held the release is a release, so the next
// standalone tap is not swallowed.
_ = singleKeyDetector.handle(.otherModifiers(held: true), at: 110)
_ = singleKeyDetector.handle(.rightCommandDown, at: 110.1)
expect(singleKeyDetector.handle(.rightCommandUp, at: 110.2) == false, "Right Command released under Left Command never fires")
_ = singleKeyDetector.handle(.otherModifiers(held: false), at: 110.5)
_ = singleKeyDetector.handle(.rightCommandDown, at: 111)
expect(singleKeyDetector.handle(.rightCommandUp, at: 111.05), "the release under Left Command does not swallow the next tap")

// The decode itself: the device bits tell the two Command keys apart, which the
// shared .maskCommand bit cannot.
expect(RightCommandTapDetector.rightCommandIsDown(flagsRawValue: 0x10), "the Right Command device bit is a press")
expect(RightCommandTapDetector.rightCommandIsDown(flagsRawValue: 0x100008) == false, "Left Command plus the generic command bit is not a Right Command press")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x20000), "Shift is another modifier")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x100010) == false, "Right Command alone is not another modifier")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x100008), "Left Command is another modifier")
_ = singleKeyDetector.handle(.rightCommandDown, at: 40)
expect(singleKeyDetector.handle(.rightCommandUp, at: 40.31) == false, "a hold longer than 300 ms is not a tap")
_ = singleKeyDetector.handle(.rightCommandDown, at: 50)
_ = singleKeyDetector.handle(.rightCommandDown, at: 50.1)
expect(singleKeyDetector.handle(.rightCommandUp, at: 50.2), "a repeated press is debounced into one tap")
_ = singleKeyDetector.handle(.rightCommandDown, at: 60)
_ = singleKeyDetector.handle(.otherKeyDown, at: 60.01)
_ = singleKeyDetector.handle(.rightCommandUp, at: 60.02)
_ = singleKeyDetector.handle(.rightCommandDown, at: 61)
expect(singleKeyDetector.handle(.rightCommandUp, at: 61.05), "a tap after a chord fires again")
_ = singleKeyDetector.handle(.otherKeyDown, at: 62)
expect(singleKeyDetector.handle(.rightCommandUp, at: 63) == false, "a chord before any press never fires")

// P1-R1: the Right Command tap the detector fires is the one presence toggle, and Right
// Option is SuperWhisper's: the detector has no case for it and never consumes an event.
var presenceTap = RightCommandTapDetector()
let presenceTapped = presenceTap.handle(.rightCommandDown, at: 200) == false
    && presenceTap.handle(.rightCommandUp, at: 200.1)
expect(presenceTapped, "a Right Command tap is the presence toggle")
var presenceSurfaces: [PresenceState] = []
let presence = NativePresence(effects: PresenceEffects(setCaptureMuted: { _ in },
    surface: { state, _ in presenceSurfaces.append(state) }))
expect(presence.state == .cold, "presence starts cold and silent")
if presenceTapped { presence.toggle(.hotkey) }
expect(presence.state == .connecting, "the Right Command tap opens the presence session")
expect(presenceSurfaces.last == .connecting, "the tap renders the presence surface")
presence.toggle(.hotkey)
expect(presence.state == .cold, "a second tap while connecting returns to cold")
var rightOptionTap = RightCommandTapDetector()
expect(rightOptionTap.handle(.otherModifiers(held: true), at: 210) == false, "a Right Option press is never a tap")
expect(rightOptionTap.handle(.otherKeyDown, at: 210.05) == false, "a key pressed under Right Option is a chord")
expect(RightCommandTapDetector.rightCommandIsDown(flagsRawValue: 0x40) == false, "the Right Option device bit is never a Right Command press")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x80040), "a Right Option press is another modifier, so a press under it is a chord")

// B7 regression: the positive branch, asked once on the first interactive launch
// and never again, proven through the prompt seam with no modal and no TCC.
let positiveSuite = "didi.single-key.positive.\(UUID().uuidString)"
let positiveDefaults = UserDefaults(suiteName: positiveSuite)!
var prompts = 0
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, defaults: positiveDefaults, granted: false, prompt: { prompts += 1 })
expect(prompts == 1 && positiveDefaults.bool(forKey: SingleKeyTrigger.askedKey), "the first interactive launch asks for the grant once")
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, defaults: positiveDefaults, granted: false, prompt: { prompts += 1 })
expect(prompts == 1, "the grant is asked once, ever")
let grantedSuite = "didi.single-key.granted.\(UUID().uuidString)"
let grantedDefaults = UserDefaults(suiteName: grantedSuite)!
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, defaults: grantedDefaults, granted: true, prompt: { prompts += 1 })
expect(prompts == 1, "a present grant is never asked for")
positiveDefaults.removePersistentDomain(forName: positiveSuite)
grantedDefaults.removePersistentDomain(forName: grantedSuite)

// B6 regression: a tap the system disabled is re-armed, everything else is not.
expect(RightCommandTapDetector.shouldReArm(.tapDisabledByTimeout), "a timed out tap is re-armed")
expect(RightCommandTapDetector.shouldReArm(.tapDisabledByUserInput), "a user-disabled tap is re-armed")
expect(RightCommandTapDetector.shouldReArm(.keyDown) == false && RightCommandTapDetector.shouldReArm(.flagsChanged) == false, "a key event is never a re-arm")

// The grant is asked for once, on the first interactive launch only, so no
// install, proof or smoke launch can open a permission prompt.
let grantSuite = "didi.single-key.test.\(UUID().uuidString)"
let grantDefaults = UserDefaults(suiteName: grantSuite)!
for kind in [LaunchKind.installedProof, .selfCheck, .uiProof, .verification] {
    SingleKeyTrigger.requestGrantIfNeeded(for: kind, defaults: grantDefaults)
    expect(grantDefaults.bool(forKey: SingleKeyTrigger.askedKey) == false, "a \(kind) launch never asks for the single-key grant")
}
expect(SingleKeyTrigger.explanation.contains("\n") == false && SingleKeyTrigger.explanation.count < 300, "the grant explanation is one line")
grantDefaults.removePersistentDomain(forName: grantSuite)

let miniScreen = CGRect(x: 0, y: 0, width: 1440, height: 900)
// MINI2: the pill is 64x26, sits top-center just below the menu bar (the screens
// are visible frames, so on a notched display the menu bar carries the notch).
expect(MiniOrbFrameRestore.size == CGSize(width: 64, height: 26), "the pill is 64x26 pt")
expect(MiniOrbPanelPolicy.cornerRadius == 13 && MiniOrbPanelPolicy.cornerRadius == MiniOrbFrameRestore.size.height / 2, "the capsule radius is half the pill height")
expect(MiniOrbFrameRestore.resolve(nil, screens: [miniScreen]) == CGRect(x: 688, y: 868, width: 64, height: 26), "default pill frame is top-center just below the menu bar")
let notched = CGRect(x: 0, y: 0, width: 1728, height: 1083)
let notchedPill = MiniOrbFrameRestore.resolve(nil, screens: [notched])
expect(notchedPill == CGRect(x: 832, y: 1051, width: 64, height: 26), "default pill frame is top-center on a notched display")
expect(notchedPill.maxY == notched.maxY - MiniOrbFrameRestore.topMargin, "the pill keeps one menu-bar margin, never inside the notch")
let miniSaved = CGRect(x: 100, y: 120, width: 300, height: 300)
expect(MiniOrbFrameRestore.resolve(miniSaved, screens: [miniScreen]) == CGRect(x: 100, y: 120, width: 64, height: 26), "a remembered pill position is kept at the pill size")
expect(MiniOrbFrameRestore.resolve(CGRect(x: 5000, y: 5000, width: 300, height: 300), screens: [miniScreen]) != CGRect(x: 5000, y: 5000, width: 300, height: 300), "an off-screen pill frame is replaced")
// UI3A-R1: the activation policy per launch kind. The interactive, login-item and
// install-relaunch kinds are regular apps (Dock tile, Cmd-Tab); the four
// non-activating proof kinds stay accessory so a check never gains either.
expect(LaunchKind.interactive.activation == .regular && LaunchKind.interactive.activationPolicy == .regular, "an interactive launch is a regular app")
expect(LaunchKind.loginItem.activation == .regular && LaunchKind.loginItem.activationPolicy == .regular, "a login-item launch is a regular app")
expect(LaunchKind.installRelaunch.activation == .regular && LaunchKind.installRelaunch.activationPolicy == .regular, "an install relaunch is a regular app")
for kind in [LaunchKind.installedProof, .selfCheck, .uiProof, .verification] {
    expect(kind.activation == .accessory && kind.activationPolicy == .accessory, "a non-activating proof launch stays accessory: \(kind)")
}
expect(LaunchKind.installedProof.presentsWindowAtLaunch && LaunchKind.loginItem.presentsWindowAtLaunch == false, "the mini work keeps the launch window policy")

// UI3A: the presentation coordinator owns the one visible surface. A Dock reopen
// always presents FULL, a close during an active Live session switches to MINI and
// keeps the session, and no sequence of switches leaves two surfaces or touches Live.
var visibleSurfaces: Set<String> = []
var miniPageHostable = true
var liveActive = false
let liveSession = "live-session-42"
let coordinator = PresentationCoordinator(
    showFull: { _ in visibleSurfaces.remove("mini"); visibleSurfaces.insert("full") },
    hideFull: { visibleSurfaces.remove("full") },
    showMini: { visibleSurfaces.remove("full"); visibleSurfaces.insert("mini"); return miniPageHostable },
    hideMini: { visibleSurfaces.remove("mini") },
    liveIsRunning: { liveActive })
expect(coordinator.mode == .hidden && visibleSurfaces.isEmpty, "the coordinator starts with no surface")
coordinator.presentFull(activating: true)
expect(coordinator.mode == .full && visibleSurfaces == ["full"], "a FULL presentation shows the window alone")
coordinator.presentMini()
expect(coordinator.mode == .mini && visibleSurfaces == ["mini"], "a MINI presentation shows the orb alone")
coordinator.presentFull(activating: true)
expect(coordinator.mode == .full && visibleSurfaces == ["full"], "a Dock reopen presents FULL from MINI")
liveActive = true
coordinator.closeFull()
expect(coordinator.mode == .mini && visibleSurfaces == ["mini"], "a close during an active Live session switches to MINI")
expect(liveActive && liveSession == "live-session-42", "the Live session survives the switch to MINI with its id")
coordinator.presentFull(activating: true)
liveActive = false
coordinator.closeFull()
expect(coordinator.mode == .hidden && visibleSurfaces.isEmpty, "a close while idle hides every surface")
coordinator.presentFull(activating: true)
coordinator.toggleWindow(activating: true)
expect(coordinator.mode == .hidden && visibleSurfaces.isEmpty, "the window shortcut hides a visible window")
coordinator.toggleWindow(activating: true)
expect(coordinator.mode == .full && visibleSurfaces == ["full"], "the window shortcut brings the window back")
for _ in 0..<20 { coordinator.presentMini(); coordinator.presentFull(activating: false); coordinator.presentMini() }
expect(visibleSurfaces.count == 1 && coordinator.mode == .mini, "rapid switching ends with exactly one surface")

// UI3A-R2 / UI3A-R7: Command-W is a real binding in the app menu, and the close
// command has two outcomes. Both are asserted on the same values the app runs, so
// the key path cannot drift from the close button.
let mainMenu = WindowMenu.build(appName: "Naya", closeTarget: nil)
let fileMenu = mainMenu.item(withTitle: "File")?.submenu
let closeItem = fileMenu?.items.first { $0.action == #selector(NSWindow.performClose(_:)) }
expect(closeItem?.title == "Close Window", "the File menu carries a Close Window item")
expect(closeItem?.keyEquivalent == "w", "Close Window carries the Command-W key equivalent")
expect(closeItem?.keyEquivalentModifierMask == .command, "the Close Window equivalent is Command, not Control or Option")
expect(mainMenu.items.first?.submenu?.items.contains { $0.keyEquivalent == "q" } == true, "the app menu keeps Quit")
expect(PresentationCoordinator.closeOutcome(liveIsRunning: true) == .mini, "a close during an active Live session goes to MINI")
expect(PresentationCoordinator.closeOutcome(liveIsRunning: false) == .hidden, "a close while idle hides the window")
liveActive = true
coordinator.presentFull(activating: true)
coordinator.closeFull()
expect(coordinator.mode == .mini && visibleSurfaces == ["mini"], "the close command with Live running shows only the orb")
coordinator.presentFull(activating: true)
liveActive = false
coordinator.closeFull()
expect(coordinator.mode == .hidden && visibleSurfaces.isEmpty, "the close command while idle leaves no surface")
miniPageHostable = false
coordinator.presentFull(activating: false)
coordinator.presentMini()
expect(coordinator.mode == .full && visibleSurfaces == ["full"], "a mini orb with no page falls back to the FULL window")
miniPageHostable = true

// UI3A: the orb never becomes key or main, floats above normal windows over every
// Space, and stays out of the app switcher.
expect(MiniOrbPanelPolicy.becomesKey == false && MiniOrbPanelPolicy.becomesMain == false, "the mini panel can become neither key nor main")
expect(MiniOrbPanelPolicy.styleMask.contains(.nonactivatingPanel) && MiniOrbPanelPolicy.styleMask.contains(.borderless), "the mini panel is borderless and never activates the app")
expect(MiniOrbPanelPolicy.level == .floating, "the mini panel floats above normal windows")
let behavior = MiniOrbPanelPolicy.collectionBehavior
expect(behavior.contains(.canJoinAllSpaces) && behavior.contains(.fullScreenAuxiliary) && behavior.contains(.ignoresCycle), "the mini panel joins every Space, floats over full screen and stays out of the window cycle")
expect(behavior.contains(.stationary) == false, "the mini panel moves with its Space")

// UI3A: a remembered frame is clamped into a visible screen, on restore and after a
// display disappears, never discarded and never resized.
let offScreen = MiniOrbFrameRestore.resolve(CGRect(x: 5000, y: 5000, width: 300, height: 300), screens: [miniScreen])
expect(miniScreen.contains(offScreen) && offScreen.size == CGSize(width: 64, height: 26), "an off-screen pill frame is clamped into a visible screen at the pill size")
let halfOff = MiniOrbFrameRestore.resolve(CGRect(x: -120, y: 820, width: 300, height: 300), screens: [miniScreen])
expect(miniScreen.contains(halfOff) && halfOff.size == CGSize(width: 64, height: 26), "a partly off-screen pill frame is clamped, not resized")
let goneDisplay = MiniOrbFrameRestore.resolve(CGRect(x: 1600, y: 100, width: 300, height: 300), screens: [miniScreen])
expect(miniScreen.contains(goneDisplay), "a frame left on a removed display is clamped into the remaining screen")

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
var registeredModifiers: [Int] = []
let shortcutRegistration = LiveShortcutRegistration { _, id, modifiers in
    registeredKeys.append(id)
    registeredModifiers.append(modifiers)
    return id == 1 ? -9878 : 0
}
expect(registeredKeys == [1, 2, 3, 4], "shortcut registrations are separate even when Start conflicts")
expect(shortcutRegistration.startStatus.contains("Unavailable") && shortcutRegistration.muteStatus == "registered" && shortcutRegistration.windowStatus == "registered" && shortcutRegistration.pillStatus == "registered", "conflict does not hide independent mute or pill registration")
// MINI2: the pill is Control-Option-Space, a different mask from the window's
// Control-Option-Shift-Space, so both keys can be live at once.
expect(registeredModifiers[3] == ShortcutModifiers.pill && registeredModifiers[2] == ShortcutModifiers.window, "the pill chord carries its own modifier mask")
expect(ShortcutModifiers.pill != ShortcutModifiers.window, "the pill chord is not the window chord")
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
for operation in [StartupFailureDiagnostic.Operation.policyRecheck, .copyMatching, .add] {
    for status in [Int32.min, -25308, Int32.max] {
        let failure = StartupFailureDiagnostic(stage: .canonicalImport, category: .keychain, operation: operation, status: status)
        let text = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput(startupFailure: failure))
        expect(text.contains("category=keychain operation=" + operation.rawValue + " status=" + String(status)), "closed startup operation and Int32 status render")
    }
}
for failure in [StartupFailureDiagnostic(stage: .unknown, category: .keychain, operation: .copyMatching, status: -25308),
                StartupFailureDiagnostic(stage: .canonicalImport, category: .unknown, operation: .none, status: nil),
                StartupFailureDiagnostic(stage: .canonicalImport, category: .keychain, operation: .copyMatching, status: nil),
                StartupFailureDiagnostic(stage: .bootstrap, category: .authentication, operation: .add, status: -1),
                StartupFailureDiagnostic(stage: .state, category: .authentication, operation: .none, status: nil),
                StartupFailureDiagnostic(stage: .bootstrap, category: .invalidNode, operation: .none, status: nil),
                StartupFailureDiagnostic(stage: .readyFrame, category: .keychain, operation: .copyMatching, status: -25308),
                StartupFailureDiagnostic(stage: .canonicalImport, category: .keychain, operation: .none, status: -25308),
                StartupFailureDiagnostic(stage: .canonicalImport, category: .keychain, operation: .copyMatching, status: 0)] {
    expect(NativeDiagnosticsSnapshot.startupFailure(failure) == "unknown", "invalid or unknown startup diagnostic maps to fixed unknown")
}
expect(NativeDiagnosticsSnapshot.startupFailure(nil) == "unknown", "success has no stale startup failure")
for (stage, category) in [(StartupFailureDiagnostic.Stage.state, .unsafeState), (.nodeProbe, .invalidNode), (.nodeProbe, .invalidReady),
                          (.spawn, .invalidRuntime), (.readyFrame, .timeout), (.canonicalImport, .credentialMismatch), (.bootstrap, .authentication)] as [(StartupFailureDiagnostic.Stage, StartupFailureDiagnostic.Category)] {
    let failure = StartupFailureDiagnostic(stage: stage, category: category, operation: .none, status: nil)
    expect(NativeDiagnosticsSnapshot.startupFailure(failure).contains("stage=" + stage.rawValue + " category=" + category.rawValue), "reachable startup pair is retained")
}
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

// Getting started uses fixture values and public setup instructions.
let onboardingDefaults = UserDefaults(suiteName: "DidiGettingStartedTests")!
onboardingDefaults.removePersistentDomain(forName: "DidiGettingStartedTests")
expect(NativeGettingStartedOnce.consume(onboardingDefaults), "first build launch presents setup")
expect(!NativeGettingStartedOnce.consume(onboardingDefaults), "setup never auto-presents twice")
onboardingDefaults.removePersistentDomain(forName: "DidiGettingStartedTests")
for id in NativeNextSteps.connectorIDs {
    for reason in NativeNextSteps.reasonCodes {
        expect(!NativeNextSteps.lookup(id: id, state: "error", reason: reason).text.isEmpty, "every next step is mapped")
    }
}
let calendarStep = NativeNextSteps.lookup(id: "calendar", state: "missing", reason: "credential_missing")
expect(calendarStep.command == nil && calendarStep.guideURL?.absoluteString == "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup", "portable calendar instructions link the public guide without a copy command")
expect(NativeNextSteps.lookup(id: "mongoose", state: "missing", reason: nil).command == nil, "credential path is not a copy command")
let onboardingRows = NativeGettingStartedItems.rows(microphone: "denied", notifications: "denied", login: "off", connections: [("calendar", "missing", "credential_missing"), ("mongoose", "connected", nil)])
expect(onboardingRows.count == 7, "fixture includes permissions, login, shortcuts and every connection")
expect(onboardingRows.contains { $0.title == "calendar" && $0.detail == "missing: \(calendarStep.text)" && $0.command == nil }, "fixture projects exact connector next step")

// R-SEC-3: ordinary owner/device labels are not safe support exports.
let personalRoute = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput(audioRoute: "Microphone: Alice Smith's AirPods · Output: Alice Smith's AirPods"))
expect(!personalRoute.contains("Alice") && !personalRoute.contains("AirPods"), "diagnostics excludes personal device names")
for capability in [NotificationCapability.notDetermined, .denied, .authorized, .provisional, .unknown] {
    expect(!capability.presentation.contains(capability.rawValue), "no raw notification case reaches a label")
}
