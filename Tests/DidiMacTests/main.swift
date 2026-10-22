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
// opens the full interface from its menu without changing Live or hiding before paint.
var liveStarted = 0, liveStopped = 0, presented = 0, dismissed = 0, expanded = 0
var liveRunning = false
let miniFacts = MiniSurfaceFacts(frame: "{{700, 860}, {64, 26}}", screen: "main", alpha: 1,
                                 occluded: false, pageState: "ready")
let miniOrb = MiniOrbToggle(
    startLive: { liveStarted += 1; liveRunning = true },
    stopLive: { liveStopped += 1; liveRunning = false },
    liveIsRunning: { liveRunning },
    presentPanel: { _ in presented += 1; return .shown(miniFacts) },
    dismissPanel: { dismissed += 1 },
    requestFullWindow: { expanded += 1 })
expect(!miniOrb.isVisible, "mini orb starts hidden")
miniOrb.toggle()
expect(miniOrb.isVisible && liveStarted == 1 && presented == 1, "mini orb chord shows and starts Live")
miniOrb.toggle()
expect(!miniOrb.isVisible && liveStopped == 1 && dismissed == 1, "mini orb chord hides and stops Live")
miniOrb.show()
expect(liveStarted == 2 && presented == 2, "mini orb show starts Live once")
miniOrb.openFullInterface()
expect(expanded == 1 && dismissed == 1 && liveStopped == 1 && miniOrb.isVisible, "mini orb menu requests full and retains its source")
miniOrb.show()
expect(liveStarted == 2 && presented == 3, "a running Live is not restarted by the mini orb")

// M3-R12: this build has one mini surface, and nothing hides it on microphone state.
// Presence owns its visibility and its opacity (cold 0.6, hot-muted 0.55, live 1.0), so the
// surface stays on screen in cold and in hot-muted, and only an explicit hide or expand
// takes it away.
var miniPresence = "cold"
var gateDismissals = 0
var gatePresents = 0
let surface = MiniOrbToggle(startLive: { miniPresence = "live" }, stopLive: { miniPresence = "cold" },
                            liveIsRunning: { miniPresence == "live" },
                            presentPanel: { _ in gatePresents += 1; return .shown(miniFacts) },
                            dismissPanel: { gateDismissals += 1 },
                            requestFullWindow: {})
surface.showSurface(trigger: .other)
expect(surface.isVisible && gatePresents == 1, "the surface is on screen")
miniPresence = "hot-muted"
expect(surface.isVisible && gateDismissals == 0, "hot-muted leaves the surface on screen")
miniPresence = "cold"
expect(surface.isVisible && gateDismissals == 0, "cold leaves the surface on screen")

// MINI2 / Q2 (owner order 2026-10-18): the single key. Right Command is Naya's key;
// Right Option belongs to SuperWhisper and is never watched. A tap fires, a chord use
// is ignored, and a press held to the hold threshold is push-to-talk, never dead.
expect(RightCommandTapDetector.keyCode == 54 && RightCommandTapDetector.holdThreshold == 0.4,
    "the single key is Right Command with a 400 ms hold threshold")
var singleKeyDetector = RightCommandTapDetector()
expect(singleKeyDetector.handle(.rightCommandDown, at: 10) == [], "a Right Command press alone is not a tap")
expect(singleKeyDetector.handle(.rightCommandUp, at: 10.12) == [.tap], "a short Right Command tap fires")
expect(singleKeyDetector.handle(.rightCommandUp, at: 11) == [], "a release without a press never fires")
_ = singleKeyDetector.handle(.rightCommandDown, at: 20)
_ = singleKeyDetector.handle(.otherKeyDown, at: 20.05)
expect(singleKeyDetector.handle(.rightCommandUp, at: 20.1) == [.ignored("chord")],
    "Right Command in a chord (Cmd+C) is ignored, not a tap")
_ = singleKeyDetector.handle(.rightCommandDown, at: 30)
_ = singleKeyDetector.handle(.otherModifiers(held: true), at: 30.02)
expect(singleKeyDetector.handle(.rightCommandUp, at: 30.1) == [.ignored("chord")],
    "a second modifier in the press makes it a chord")

// B2 regression: a modifier already held BEFORE Right Command is a chord too, so
// Shift (or the owner's Right Option) plus a Right Command tap never fires.
_ = singleKeyDetector.handle(.otherModifiers(held: true), at: 100)
_ = singleKeyDetector.handle(.rightCommandDown, at: 100.1)
expect(singleKeyDetector.handle(.rightCommandUp, at: 100.2) == [.ignored("chord")],
    "a modifier held before the press makes it a chord")
_ = singleKeyDetector.handle(.otherModifiers(held: false), at: 101)
_ = singleKeyDetector.handle(.rightCommandDown, at: 102)
expect(singleKeyDetector.handle(.rightCommandUp, at: 102.05) == [.tap],
    "a plain tap after the modifier is released still fires")

// B3 regression: with Left Command held the release is a release, so the next
// standalone tap is not swallowed.
_ = singleKeyDetector.handle(.otherModifiers(held: true), at: 110)
_ = singleKeyDetector.handle(.rightCommandDown, at: 110.1)
expect(singleKeyDetector.handle(.rightCommandUp, at: 110.2) == [.ignored("chord")],
    "Right Command released under Left Command never fires")
_ = singleKeyDetector.handle(.otherModifiers(held: false), at: 110.5)
_ = singleKeyDetector.handle(.rightCommandDown, at: 111)
expect(singleKeyDetector.handle(.rightCommandUp, at: 111.05) == [.tap],
    "the release under Left Command does not swallow the next tap")

// The decode itself: the device bits tell the two Command keys apart, which the
// shared .maskCommand bit cannot.
expect(RightCommandTapDetector.rightCommandIsDown(flagsRawValue: 0x10), "the Right Command device bit is a press")
expect(RightCommandTapDetector.rightCommandIsDown(flagsRawValue: 0x100008) == false, "Left Command plus the generic command bit is not a Right Command press")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x20000), "Shift is another modifier")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x100010) == false, "Right Command alone is not another modifier")
expect(RightCommandTapDetector.otherModifiersHeld(flagsRawValue: 0x100008), "Left Command is another modifier")

// Q2: the hold starts on the app's own hold timer at the threshold, never on the
// release, so the mic can open while the key is still down. A late timer is not a
// lost gesture: a release past the threshold completes the whole hold at once.
var holdDetector = RightCommandTapDetector()
_ = holdDetector.handle(.rightCommandDown, at: 40)
expect(holdDetector.poll(at: 40.39) == [], "a press under the hold threshold has no gesture yet")
expect(holdDetector.poll(at: 40.401) == [.holdStart], "the 400 ms threshold starts a hold")
expect(holdDetector.poll(at: 41) == [], "a hold starts once, however often the timer fires")
expect(holdDetector.handle(.rightCommandUp, at: 41.2) == [.holdEnd], "the release ends a started hold")
_ = holdDetector.handle(.rightCommandDown, at: 50)
_ = holdDetector.handle(.otherKeyDown, at: 50.1)
expect(holdDetector.poll(at: 50.5) == [], "a chord before the threshold never becomes a hold")
expect(holdDetector.handle(.rightCommandUp, at: 50.6) == [.ignored("chord")],
    "a cancelled press releases as a chord, not as a hold end")
_ = holdDetector.handle(.rightCommandDown, at: 60)
expect(holdDetector.handle(.rightCommandUp, at: 60.45) == [.holdStart, .holdEnd],
    "a release past the threshold with a late timer is still a hold")
_ = holdDetector.handle(.rightCommandDown, at: 70)
_ = holdDetector.handle(.rightCommandDown, at: 70.1)
expect(holdDetector.handle(.rightCommandUp, at: 70.2) == [.tap], "a repeated press is debounced into one tap")
_ = holdDetector.handle(.rightCommandDown, at: 80)
_ = holdDetector.handle(.otherKeyDown, at: 80.01)
_ = holdDetector.handle(.rightCommandUp, at: 80.02)
_ = holdDetector.handle(.rightCommandDown, at: 81)
expect(holdDetector.handle(.rightCommandUp, at: 81.05) == [.tap], "a tap after a chord fires again")
_ = holdDetector.handle(.otherKeyDown, at: 82)
expect(holdDetector.handle(.rightCommandUp, at: 83) == [], "a chord before any press never fires")

// Q2 review B1, contract outcome 3: a chord during a hold cancels the gesture there and
// then, so the microphone closes at the chord instead of staying open while Command is
// used, and the rest of that press is inert.
_ = holdDetector.handle(.rightCommandDown, at: 90)
expect(holdDetector.poll(at: 90.5) == [.holdStart], "a hold is open before the chord")
expect(holdDetector.handle(.otherKeyDown, at: 90.6) == [.holdEnd],
    "a key pressed during a hold ends the hold at that moment")
expect(holdDetector.poll(at: 91) == [], "an ended hold does not restart")
expect(holdDetector.handle(.rightCommandUp, at: 91.2) == [],
    "the release of a cancelled hold is not a second gesture")
_ = holdDetector.handle(.rightCommandDown, at: 92)
expect(holdDetector.poll(at: 92.5) == [.holdStart], "a second hold is open before the modifier")
expect(holdDetector.handle(.otherModifiers(held: true), at: 92.6) == [.holdEnd],
    "a modifier during a hold ends the hold at that moment")
expect(holdDetector.handle(.rightCommandUp, at: 93) == [],
    "the release after a cancelled hold logs nothing")
_ = holdDetector.handle(.otherModifiers(held: false), at: 93.1)
_ = holdDetector.handle(.rightCommandDown, at: 94)
expect(holdDetector.handle(.rightCommandUp, at: 94.05) == [.tap],
    "a tap is a tap again once the modifier is released")

// Q2 review B2: the system can disable the tap mid-press, and the key-up can be one of
// the events it swallows. A hold open at that moment ends, so no fence is left closed
// with no timer to close it.
_ = holdDetector.handle(.rightCommandDown, at: 95)
_ = holdDetector.poll(at: 95.5)
expect(holdDetector.abandonPress() == [.holdEnd], "a press lost to a disabled tap ends its open hold")
expect(holdDetector.handle(.rightCommandUp, at: 96) == [], "the lost press leaves nothing behind")
_ = holdDetector.handle(.rightCommandDown, at: 97)
expect(holdDetector.abandonPress() == [], "a press that had not reached the threshold ends nothing")
expect(holdDetector.handle(.rightCommandUp, at: 97.1) == [], "and its release adds nothing either")

// P1-R1 / Q2 (owner order 2026-10-18): the Right Command key is bound to the presence
// machine by the one function the app installs, not by a copy in the test. Right Option
// is SuperWhisper's: the detector has no case for it and never consumes an event.
var presenceSurfaces: [PresenceState] = []
let presence = NativePresence(effects: PresenceEffects(setCaptureMuted: { _ in },
    surface: { posture in presenceSurfaces.append(posture.state) }))
let wiredSingleKey = SingleKeyTrigger()
wiredSingleKey.scheduleHold = { _, _ in }
bindRightCommandKey(wiredSingleKey, to: presence)
expect(presence.state == .cold, "presence starts cold and silent")
var presenceTap = RightCommandTapDetector()
let presenceTapped = presenceTap.handle(.rightCommandDown, at: 200) == []
    && presenceTap.handle(.rightCommandUp, at: 200.1) == [.tap]
expect(presenceTapped, "a Right Command tap is the presence toggle")
if presenceTapped { wiredSingleKey.onTap?() }
expect(presence.state == .connecting, "the installed Right Command binding opens the presence session")
expect(presenceSurfaces.last == .connecting, "the tap renders the presence surface")
wiredSingleKey.onTap?()
expect(presence.state == .hotMuted, "a second tap while connecting mutes instead of leaving her half-open")
wiredSingleKey.onTap?()
expect(presence.state == .connecting, "a tap in MUTED opens the session again")
var rightOptionTap = RightCommandTapDetector()
expect(rightOptionTap.handle(.otherModifiers(held: true), at: 210) == [], "a Right Option press is never a tap")
expect(rightOptionTap.handle(.otherKeyDown, at: 210.05) == [], "a key pressed under Right Option is a chord")

// Q2 (owner order 2026-10-18): the whole key, through the shipped binding, with a fake
// clock and a fake hold timer. A tap starts when idle, mutes when live, and unmutes when muted
// through the Stop path; a press held to the threshold is push-to-talk.
@MainActor final class HotkeyKey {
    var opened = 0
    var cancelled = 0
    var closed = 0
    var fences: [Bool] = []
    var receipts: [[String: Any]] = []
    var clock: TimeInterval = 700
    var holdDelay: TimeInterval?
    var holdTimer: (() -> Void)?
    lazy var presence = NativePresence(effects: PresenceEffects(
        openSession: { _ in self.opened += 1 },
        cancelConnecting: { self.cancelled += 1 },
        closeSession: { self.closed += 1 },
        setCaptureMuted: { self.fences.append($0) }))
    lazy var key: SingleKeyTrigger = {
        let key = SingleKeyTrigger()
        key.now = { [weak self] in self?.clock ?? 0 }
        key.presenceState = { [weak self] in self?.presence.state ?? .cold }
        key.onReceipt = { [weak self] record in self?.receipts.append(record) }
        key.scheduleHold = { [weak self] work, delay in
            self?.holdDelay = delay
            self?.holdTimer = { work() }
        }
        bindRightCommandKey(key, to: presence)
        return key
    }()
    func press(at time: TimeInterval) { key.receive(.rightCommandDown, at: time) }
    func release(at time: TimeInterval) { key.receive(.rightCommandUp, at: time) }
    func fireHold() { holdTimer?() }
    func lastAction() -> String? { receipts.last?["action"] as? String }
    func lastReason() -> String? { receipts.last?["reason"] as? String }
}

let hotkey = HotkeyKey()
hotkey.press(at: hotkey.clock)
hotkey.release(at: hotkey.clock + 0.1)
expect(hotkey.presence.state == .connecting && hotkey.opened == 1, "an idle Right Command tap starts a session")
expect(hotkey.lastAction() == "start" && hotkey.lastReason() == "connecting", "the idle tap logs single_key_tap start")
hotkey.presence.ready(hotkey.presence.generation)
expect(hotkey.presence.state == .live && hotkey.fences.last == false, "readiness opens the mic")
let closedBeforeFirstMute = hotkey.closed
let openedBeforeFirstMute = hotkey.opened
hotkey.clock += 1
hotkey.press(at: hotkey.clock)
hotkey.release(at: hotkey.clock + 0.1)
expect(hotkey.presence.state == .hotMuted && hotkey.closed == closedBeforeFirstMute,
    "a live tap mutes her and keeps the provider session open for the warm window (R4)")
expect(hotkey.presence.mutedWarm, "the mute holds the session and its generation warm")
expect(hotkey.presence.posture.muted, "the mute is on the surface the orb reads, so it can go purple")
expect(hotkey.fences.last == true, "the mute closes Naya's own capture fence")
expect(hotkey.presence.mutedHeld && hotkey.presence.posture.muted,
    "the mute holds with no deadline of its own, so it lasts as long as the owner waits")
expect(hotkey.lastAction() == "mute" && hotkey.lastReason() == "hotMuted", "the live tap logs single_key_tap mute")
hotkey.clock += 1
hotkey.press(at: hotkey.clock)
hotkey.release(at: hotkey.clock + 0.1)
expect(hotkey.presence.state == .live && hotkey.opened == openedBeforeFirstMute && hotkey.closed == closedBeforeFirstMute,
    "a second tap inside the window listens again on the same session, with no reconnect")
expect(hotkey.fences.last == false, "the resume opens the capture fence again")
expect(hotkey.lastAction() == "unmute" && hotkey.lastReason() == "live",
    "the muted tap logs single_key_tap unmute straight to live")
hotkey.presence.ready(hotkey.presence.generation)
expect(hotkey.presence.state == .live && hotkey.fences.last == false && !hotkey.presence.posture.muted,
    "a late readiness from the kept session changes nothing, the mic is already open")

// Acceptance 2: muted past the host's cost cap. The host ends the kept session, the owner still
// sees MUTED (purple), and the next tap reconnects and opens the mic.
let closedBeforeMute = hotkey.closed
hotkey.clock += 1
hotkey.press(at: hotkey.clock)
hotkey.release(at: hotkey.clock + 0.1)
expect(hotkey.presence.state == .hotMuted, "the day's mute starts from a live session")
// Warm mute: the provider session and its generation stay open for the host's 180 s window, so a
// proactive or callback speech request still has nowhere to play and nothing reopens a session.
expect(hotkey.closed == closedBeforeMute && hotkey.fences.last == true,
    "the mute keeps the session, closes the fence and mutes the provider input")
expect(hotkey.presence.mutedWarm, "a live mute holds the session warm for the window")
let openedDuringMute = hotkey.opened
hotkey.presence.wake()
expect(hotkey.opened == openedDuringMute,
    "a wake while muted asks for no session, so no held speech can be spoken")
hotkey.presence.sessionEnded(hotkey.presence.generation)
hotkey.clock += 6 * 60
expect(hotkey.opened == openedDuringMute && hotkey.presence.posture.muted,
    "six minutes muted open nothing by themselves, they only keep her purple")
expect(hotkey.presence.state == .hotMuted && !hotkey.presence.mutedWarm && hotkey.presence.posture.muted,
    "the session the host ended on its cost cap leaves a held, cold mute that stays purple")
var openedBeforeLateTap = hotkey.opened
hotkey.clock += 1
hotkey.press(at: hotkey.clock)
hotkey.release(at: hotkey.clock + 0.1)
expect(hotkey.presence.state == .connecting && hotkey.opened == openedBeforeLateTap + 1,
    "the tapping owner reconnects her instead of starting a quiet session")
expect(hotkey.presence.state == .connecting && !hotkey.presence.posture.muted,
    "the reconnect shows the existing connecting look until the new session is ready (R4)")
hotkey.presence.ready(hotkey.presence.generation)
expect(hotkey.presence.state == .live && !hotkey.presence.posture.muted && hotkey.fences.last == false,
    "and readiness opens the mic, so she hears the owner again")
// The explicit Stop, and sleep, are the two things that end a mute.
hotkey.clock += 1
hotkey.presence.tap(.hotkey)
expect(hotkey.presence.posture.muted, "a tap from live mutes again")
hotkey.presence.stop(.app)
expect(hotkey.presence.state == .cold && !hotkey.presence.posture.muted,
    "an explicit stop ends the mute, so the orb is grey again")
hotkey.presence.tap(.hotkey)
hotkey.presence.ready(hotkey.presence.generation)
hotkey.presence.tap(.hotkey)
expect(hotkey.presence.posture.muted, "a mute is on before the sleep")
hotkey.presence.sleep()
expect(hotkey.presence.state == .cold && !hotkey.presence.posture.muted, "sleep ends the mute too")

// A held key does nothing: the press past the threshold is one ignored receipt and the
// machine does not move, which is the owner's spec of 2026-10-21.
hotkey.clock += 10
var openedBeforeHold = hotkey.opened
let stateBeforeHold = hotkey.presence.state
hotkey.press(at: hotkey.clock)
expect(hotkey.holdDelay == RightCommandTapDetector.holdThreshold, "the press still arms the 400 ms threshold, which tells a hold from a tap")
hotkey.clock += RightCommandTapDetector.holdThreshold + 0.001
hotkey.fireHold()
expect(hotkey.presence.state == stateBeforeHold && hotkey.opened == openedBeforeHold,
    "a held Right Command opens nothing")
expect(hotkey.lastAction() == "ignored" && hotkey.lastReason() == "hold", "the hold logs single_key_tap ignored, reason hold")
hotkey.release(at: hotkey.clock + 0.2)
expect(hotkey.presence.state == stateBeforeHold, "and its release moves nothing either")

// A Command chord during the press cancels the gesture: no start, no hold, one receipt.
var receiptsBeforeChord = hotkey.receipts.count
hotkey.clock += 1
let stateBeforeChord = hotkey.presence.state
hotkey.press(at: hotkey.clock)
hotkey.key.receive(.otherKeyDown, at: hotkey.clock + 0.05)
hotkey.clock += RightCommandTapDetector.holdThreshold + 0.001
hotkey.fireHold()
expect(hotkey.presence.state == stateBeforeChord, "a Cmd+C press opens nothing, even past the threshold")
expect(hotkey.receipts.count == receiptsBeforeChord, "a cancelled press logs no hold start")
hotkey.release(at: hotkey.clock + 0.1)
expect(hotkey.presence.state == stateBeforeChord, "a Cmd+C tap leaves the live session alone")
expect(hotkey.receipts.count == receiptsBeforeChord + 1, "a cancelled press leaves exactly one receipt")
expect(hotkey.lastAction() == "ignored" && hotkey.lastReason() == "chord",
    "a cancelled press logs single_key_tap ignored, reason chord")

// B6 regression: a tap the system disabled is re-armed, everything else is not.
expect(RightCommandTapDetector.shouldReArm(.tapDisabledByTimeout), "a timed out tap is re-armed")
expect(RightCommandTapDetector.shouldReArm(.tapDisabledByUserInput), "a user-disabled tap is re-armed")
expect(RightCommandTapDetector.shouldReArm(.keyDown) == false && RightCommandTapDetector.shouldReArm(.flagsChanged) == false, "a key event is never a re-arm")

// #3p / B7 regression: the grant is asked once per app version on an interactive
// launch and only while it is missing, proven through the prompt seam with no modal
// and no TCC prompt. An ad-hoc signed install can lose the grant, so a new version
// asks once more instead of staying silent for ever.
let grantSuite = "didi.single-key.test.\(UUID().uuidString)"
let grantDefaults = UserDefaults(suiteName: grantSuite)!
var prompts = 0
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, version: "3p", defaults: grantDefaults, enabled: true,
                                     granted: false, prompt: { prompts += 1 })
expect(prompts == 1, "an untrusted new version asks for the grant once")
expect(grantDefaults.string(forKey: SingleKeyGrantPrompt.versionKey) == "3p", "the asked version is the one remembered")
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, version: "3p", defaults: grantDefaults, enabled: true,
                                     granted: false, prompt: { prompts += 1 })
expect(prompts == 1, "the same version never asks again")
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, version: "3q", defaults: grantDefaults, enabled: true,
                                     granted: false, prompt: { prompts += 1 })
expect(prompts == 2, "a new version asks once more, which is the ad-hoc install's case")
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, version: "3r", defaults: grantDefaults, enabled: true,
                                     granted: true, prompt: { prompts += 1 })
expect(prompts == 2, "a key that has its grant is never asked for")
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, version: "3s", defaults: grantDefaults, enabled: false,
                                     granted: false, prompt: { prompts += 1 })
expect(prompts == 2, "a key that is turned off is never asked for")
for kind in [LaunchKind.installedProof, .selfCheck, .uiProof, .verification] {
    SingleKeyTrigger.requestGrantIfNeeded(for: kind, version: "3t", defaults: grantDefaults, enabled: true, granted: false)
    expect(grantDefaults.string(forKey: SingleKeyGrantPrompt.versionKey) != "3t", "a \(kind) launch never asks for the single-key grant")
}
expect(SingleKeyTrigger.explanation.contains("\n") == false && SingleKeyTrigger.explanation.count < 300, "the grant explanation is one line")
grantDefaults.removePersistentDomain(forName: grantSuite)

// #3p: the launch receipt and the tap receipt, proven with a fake trust provider and
// no event tap, so a silent Right Command can never again be a guess.
let singleKeyWasEnabled = SingleKeyTrigger.isEnabled
SingleKeyTrigger.isEnabled = true
var singleKeyReceipts: [[String: Any]] = []
let untrustedKey = SingleKeyTrigger()
untrustedKey.system = .init(grants: { .init(listenEvent: false, accessibility: false) }, install: { true })
untrustedKey.onReceipt = { singleKeyReceipts.append($0) }
expect(untrustedKey.start() == false && untrustedKey.tapCreated == false, "an untrusted launch creates no tap")
let untrustedState = SingleKeyTrigger.stateReceipt(enabled: true,
    grants: .init(listenEvent: false, accessibility: false), tapCreated: untrustedKey.tapCreated, signing: "adhoc")
expect(untrustedState["event"] as? String == "single_key_state" && untrustedState["tapCreated"] as? Bool == false
    && untrustedState["trusted"] as? Bool == false && untrustedState["signing"] as? String == "adhoc",
    "the launch receipt says the key has no grant and no tap")
let trustedKey = SingleKeyTrigger()
trustedKey.system = .init(grants: { .init(listenEvent: true, accessibility: false) }, install: { true })
trustedKey.onReceipt = { singleKeyReceipts.append($0) }
// No real hold timer here: each gesture is fired by the events this test sends.
trustedKey.scheduleHold = { _, _ in }
// R3: Input Monitoring alone is enough for the listen-only tap, with Accessibility denied.
expect(trustedKey.start() && trustedKey.tapCreated, "Input Monitoring granted, Accessibility denied, installs the tap")
let installReceipt = singleKeyReceipts.last
expect(installReceipt?["event"] as? String == "single_key_state" && installReceipt?["trusted"] as? Bool == true
    && installReceipt?["listenEvent"] as? Bool == true && installReceipt?["tapCreated"] as? Bool == true,
    "the launch that installs the tap writes one receipt naming the grant it used")
singleKeyReceipts.removeAll()
let trustedState = SingleKeyTrigger.stateReceipt(enabled: true,
    grants: .init(listenEvent: true, accessibility: false), tapCreated: trustedKey.tapCreated, signing: "identity")
expect(trustedState["tapCreated"] as? Bool == true && trustedState["signing"] as? String == "identity",
    "the launch receipt says the tap is live and what signed it")
expect(trustedState["listenEvent"] as? Bool == true && trustedState["accessibility"] as? Bool == false,
    "the receipt reports both grants apart, so the owner knows which toggle to flip (R2)")
expect(SingleKeyTrigger.stateReceipt(enabled: true, grants: .init(listenEvent: false, accessibility: true),
    tapCreated: true, signing: "identity")["trusted"] as? Bool == true,
    "either grant is enough for a listen-only tap")
var presenceAfterTap: [PresenceState] = [.connecting, .hotMuted, .connecting]
var singleKeyPresence = PresenceState.cold
trustedKey.presenceState = { singleKeyPresence }
trustedKey.onTap = { singleKeyPresence = presenceAfterTap.removeFirst() }
trustedKey.receive(.rightCommandDown, at: 300)
trustedKey.receive(.rightCommandUp, at: 300.1)
expect(singleKeyReceipts.count == 1 && singleKeyReceipts[0]["event"] as? String == "single_key_tap"
    && singleKeyReceipts[0]["action"] as? String == "start" && singleKeyReceipts[0]["reason"] as? String == "connecting",
    "a tap that starts Naya logs single_key_tap start")
trustedKey.receive(.rightCommandDown, at: 310)
trustedKey.receive(.rightCommandUp, at: 310.1)
expect(singleKeyReceipts.count == 2 && singleKeyReceipts[1]["action"] as? String == "mute"
    && singleKeyReceipts[1]["reason"] as? String == "hotMuted", "a tap that mutes her logs single_key_tap mute")
trustedKey.receive(.rightCommandDown, at: 320)
trustedKey.receive(.rightCommandUp, at: 320.1)
expect(singleKeyReceipts.count == 3 && singleKeyReceipts[2]["action"] as? String == "unmute"
    && singleKeyReceipts[2]["reason"] as? String == "connecting",
    "a tap that unmutes her logs single_key_tap unmute, never ignored and never start")
trustedKey.receive(.rightCommandDown, at: 330)
trustedKey.receive(.rightCommandUp, at: 331)
expect(singleKeyReceipts.count == 5 && singleKeyReceipts[3]["action"] as? String == "ignored"
    && singleKeyReceipts[3]["reason"] as? String == "hold" && singleKeyReceipts[4]["reason"] as? String == "hold",
    "a press held past the threshold logs ignored receipts, because a held key does nothing")
expect(SingleKeyTapOutcome(from: .live, to: .live).action == .ignored && SingleKeyTapOutcome(from: .live, to: .live).reason == "live",
    "a tap the machine does not move is a receipt naming the state, proven directly")
expect(SingleKeyTapOutcome(from: .hotMuted, to: .connecting).action == .unmute
    && SingleKeyTapOutcome(from: .live, to: .hotMuted).action == .mute
    && SingleKeyTapOutcome(from: .connecting, to: .cold).action == .stop,
    "a move out of a mute is an unmute, a mute is a mute, a move to cold stops")
expect(SingleKeyTrigger.signing == "adhoc" || SingleKeyTrigger.signing == "identity" || SingleKeyTrigger.signing == "unknown",
    "the signing fact is one of the three the receipt knows")
// The signing label is pure over the code-signature flags, so it is testable with
// an injected stub: an ad-hoc build can never report the label that promises a
// grant survives an install.
let adhocFlags: UInt32 = 0x0002
let developerIDFlags: UInt32 = 0x0000
expect(SingleKeyTrigger.signingLabel(codeFlags: { adhocFlags }) == "adhoc", "an ad-hoc signature reports adhoc, never identity")
expect(SingleKeyTrigger.signingLabel(codeFlags: { developerIDFlags }) == "identity", "a certificate-backed signature reports identity")
expect(SingleKeyTrigger.signingLabel(codeFlags: { nil }) == "unknown", "a signature the system will not describe is unknown, never identity")
expect(SingleKeyTrigger.signingLabel(codeFlags: { adhocFlags | developerIDFlags }) != "identity",
    "the injected stub cannot turn ad-hoc flags into identity")
SingleKeyTrigger.isEnabled = singleKeyWasEnabled

// #1021: the key can never be silently dead. The menu line that says why, the deep link
// behind it and the re-check that installs the tap when the grant arrives late are the
// three facts the seams prove without TCC, a real tap or a keyboard.
SingleKeyTrigger.isEnabled = true
expect(SingleKeyTrigger.grantNoticeTitle(enabled: true, tapped: false) == "Right Command is off: allow Input Monitoring for Naya",
    "a key with no tap carries one line that names the fix")
expect(SingleKeyTrigger.grantNoticeTitle(enabled: true, tapped: true) == nil,
    "the line is gone once the tap is live, so a working key never shows it")
expect(SingleKeyTrigger.grantNoticeTitle(enabled: false, tapped: false) == nil,
    "a key the owner turned off shows no grant line, because no grant would fix it")
expect(URL(string: SingleKeyTrigger.grantSettingsURL)?.scheme == "x-apple.systempreferences",
    "the notice opens the Accessibility pane, not a copy of its address")
// The launch is untrusted, the grant arrives while the app runs, and the next re-check
// installs the tap: no restart, and one receipt for the change (acceptance 1).
let lateGrantKey = SingleKeyTrigger()
var lateGrantTrusted = false
lateGrantKey.system = .init(grants: { .init(listenEvent: lateGrantTrusted, accessibility: false) }, install: { true })
var lateGrantReceipts: [[String: Any]] = []
lateGrantKey.onReceipt = { lateGrantReceipts.append($0) }
expect(lateGrantKey.start() == false && lateGrantKey.tapCreated == false, "an untrusted launch has no tap")
expect(lateGrantReceipts.count == 1 && lateGrantReceipts[0]["event"] as? String == "single_key_state"
    && lateGrantReceipts[0]["trusted"] as? Bool == false && lateGrantReceipts[0]["tapCreated"] as? Bool == false,
    "the untrusted launch writes one single_key_state receipt")
lateGrantTrusted = true
expect(lateGrantKey.start() && lateGrantKey.tapCreated, "the next re-check installs the tap the moment the grant is there")
expect(lateGrantReceipts.count == 2 && lateGrantReceipts[1]["event"] as? String == "single_key_state"
    && lateGrantReceipts[1]["trusted"] as? Bool == true && lateGrantReceipts[1]["tapCreated"] as? Bool == true,
    "the grant arriving writes one receipt that says the tap is live")
expect(lateGrantKey.start() && lateGrantReceipts.count == 2,
    "a re-check with the tap already live writes no second receipt")
// Turning the key off is a state change too, so it is one receipt and no live tap.
lateGrantKey.stop()
expect(lateGrantReceipts.count == 3 && lateGrantReceipts[2]["tapCreated"] as? Bool == false
    && lateGrantReceipts[2]["trusted"] as? Bool == true,
    "a tap that goes away writes one receipt, so a key that dies mid-run is visible")
SingleKeyTrigger.isEnabled = true
// F13 (#1021): the live re-check is pinned by one seam, so the app can never poll a working key
// and can never leave an untrusted one dead. Activation plus one slow timer, at most every 5 s.
let waitingPlan = SingleKeyTrigger.grantWatchPlan(enabled: true, tapped: false)
expect(waitingPlan.onActivation && waitingPlan.pollInterval != nil,
    "an enabled key with no tap is re-checked on activation and on a timer")
expect((waitingPlan.pollInterval ?? .infinity) <= 5,
    "the untrusted poll is cheap, at most every five seconds")
expect(SingleKeyTrigger.grantWatchPlan(enabled: true, tapped: true) == SingleKeyTrigger.grantWatchPlan(enabled: false, tapped: false)
    && SingleKeyTrigger.grantWatchPlan(enabled: true, tapped: true).pollInterval == nil,
    "a live tap and a key the owner turned off both owe no polling at all")
expect(!SingleKeyTrigger.grantWatchPlan(enabled: false, tapped: false).onActivation,
    "a key the owner turned off is never re-checked: no grant would turn it on")
// The once-per-version prompt never gates the line, so a missed or dismissed prompt still
// leaves the owner a way in (acceptance 3).
let noticeSuite = "didi.single-key-notice.\(UUID().uuidString)"
let noticeDefaults = UserDefaults(suiteName: noticeSuite)!
var noticePrompts = 0
SingleKeyTrigger.requestGrantIfNeeded(for: .interactive, version: "3t", defaults: noticeDefaults, enabled: true,
                                     granted: false, prompt: { noticePrompts += 1 })
expect(noticePrompts == 1, "the prompt still asks once for a version")
expect(SingleKeyTrigger.grantNoticeTitle(enabled: true, tapped: false) != nil,
    "a version that already asked keeps the line, so a missed prompt is not a dead key")
noticeDefaults.removePersistentDomain(forName: noticeSuite)
SingleKeyTrigger.isEnabled = singleKeyWasEnabled

let miniScreen = CGRect(x: 0, y: 0, width: 1440, height: 900)
// MINI2, owner spec 2026-10-21: the orb sits top right, just under the menu bar clock.
// The screens are visible frames, so on a notched display the menu bar carries the notch.
expect(MiniOrbFrameRestore.size == CGSize(width: 220, height: 220), "the floating orb is 220 square points")
expect(MiniOrbFrameRestore.resolve(nil, screens: [miniScreen]) == CGRect(x: 1196, y: 674, width: 220, height: 220), "default pill frame is top right, under the clock")
expect(MiniOrbFrameRestore.resolve(nil, screens: [miniScreen]).maxX == miniScreen.maxX - MiniOrbFrameRestore.rightMargin,
    "the default keeps one small margin from the screen's right edge")
let notched = CGRect(x: 0, y: 0, width: 1728, height: 1083)
let notchedPill = MiniOrbFrameRestore.resolve(nil, screens: [notched])
expect(notchedPill == CGRect(x: 1484, y: 857, width: 220, height: 220), "default pill frame is top right on a notched display")
expect(notchedPill.maxY == notched.maxY - MiniOrbFrameRestore.topMargin, "the pill keeps one menu-bar margin, never inside the notch")
let miniSaved = CGRect(x: 100, y: 120, width: 300, height: 300)
expect(MiniOrbFrameRestore.resolve(miniSaved, screens: [miniScreen]) == CGRect(x: 100, y: 120, width: 220, height: 220), "a remembered pill position is kept at the pill size")
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
    showMini: { _ in
        guard miniPageHostable else { return .failed("page_not_ready") }
        visibleSurfaces.remove("full"); visibleSurfaces.insert("mini"); return .shown(miniFacts) },
    hideMini: { _ in visibleSurfaces.remove("mini") },
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
// Q4-R1: a page that cannot be hosted fails loud; it never answers with the FULL window.
expect(coordinator.mode == .full && visibleSurfaces == ["full"], "an unready mini retains the usable FULL window")
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
expect(miniScreen.contains(offScreen) && offScreen.size == CGSize(width: 220, height: 220), "an off-screen pill frame is clamped into a visible screen at the pill size")
let halfOff = MiniOrbFrameRestore.resolve(CGRect(x: -120, y: 820, width: 300, height: 300), screens: [miniScreen])
expect(miniScreen.contains(halfOff) && halfOff.size == CGSize(width: 220, height: 220), "a partly off-screen pill frame is clamped, not resized")
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
// R6, obligation 1: the next-steps surface carries the same key line as the menu bar, with the
// pane that fixes it, so the owner has two ways to the one switch.
let keyOffStep = NativeNextSteps.singleKeyStep(enabled: true, tapped: false)
expect(keyOffStep.text == SingleKeyTrigger.grantNoticeTitle(enabled: true, tapped: false)
    && keyOffStep.text == "Right Command is off: allow Input Monitoring for Naya",
    "the next-steps row for the key says what to allow, in the same words as the menu bar")
expect(keyOffStep.guideURL?.absoluteString == SingleKeyTrigger.grantSettingsURL
    && keyOffStep.guideURL?.absoluteString.hasSuffix("Privacy_ListenEvent") == true,
    "and its button opens the Input Monitoring pane")
let keyOnStep = NativeNextSteps.singleKeyStep(enabled: true, tapped: true)
expect(keyOnStep.text != keyOffStep.text && keyOnStep.text.contains("mutes and unmutes"),
    "a key with a live tap gets the working line, never the warning")
let mongooseStep = NativeNextSteps.lookup(id: "mongoose", state: "missing", reason: nil)
expect(mongooseStep.command == "mongoose-login", "the Mongoose next step offers exactly the sign-in action id")
expect(mongooseStep.command != "cp" && !(mongooseStep.command ?? "").hasPrefix("cp ") && !(mongooseStep.command ?? "").contains("/"), "credential path is not a copy command")
let onboardingRows = NativeGettingStartedItems.rows(microphone: "denied", notifications: "denied", login: "off", connections: [("calendar", "missing", "credential_missing"), ("mongoose", "connected", nil)])
expect(onboardingRows.count == 7, "fixture includes permissions, login, shortcuts and every connection")
expect(onboardingRows.contains { $0.title == "calendar" && $0.detail == "missing: \(calendarStep.text)" && $0.command == nil }, "fixture projects exact connector next step")

// R-SEC-3: ordinary owner/device labels are not safe support exports.
let personalRoute = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput(audioRoute: "Microphone: Alice Smith's AirPods · Output: Alice Smith's AirPods"))
expect(!personalRoute.contains("Alice") && !personalRoute.contains("AirPods"), "diagnostics excludes personal device names")
for capability in [NotificationCapability.notDetermined, .denied, .authorized, .provisional, .unknown] {
    expect(!capability.presentation.contains(capability.rawValue), "no raw notification case reaches a label")
}

// W-Q4: the mini surface is there from launch, it says so when it cannot be, and every
// transition leaves a receipt. The launch-time surface request runs before the host
// connection exists, so it finds no descriptor; the page-ready edge asks again, a show with
// still no page fails loud instead of opening the FULL window nobody asked for, and the
// menu item only moves the surface (the hotkey, an orb press and Start keep starting Live).
expect(MiniOrbSurface.failure(host: nil, environment: nil) == "page_not_ready",
       "a surface request before the host connection has no page to host")
expect(MiniOrbSurface.failure(host: "http://127.0.0.1:6180", environment: nil) == nil,
       "the page-ready surface request yields the mini descriptor")
expect(MiniOrbSurface.failure(host: nil, environment: "http://127.0.0.1:6180") == nil,
       "a proof launch still hosts the mini page from its environment descriptor")

// The menu item and the full window's mode button are presentation only (Q4-R2).
var q4Starts = 0, q4Stops = 0, q4Shows = 0
var q4Receipts: [[String: Any]] = []
var q4Triggers: [SurfaceTrigger] = []
let q4Facts = MiniSurfaceFacts(frame: "{{100, 800}, {64, 26}}", screen: "main", alpha: 0.6,
                               occluded: false, pageState: "ready")
let q4Orb = MiniOrbToggle(
    startLive: { q4Starts += 1 }, stopLive: { q4Stops += 1 }, liveIsRunning: { false },
    presentPanel: { trigger in q4Triggers.append(trigger); q4Shows += 1; return .shown(q4Facts) },
    dismissPanel: {}, requestFullWindow: {}, receipt: { q4Receipts.append($0) })
// The status menu's own item, pressed through the selector and target it carries (Q4-R1).
var menuShows: [SurfaceTrigger] = [], menuStarts = 0, menuStops = 0
var menuReceipts: [[String: Any]] = []
let menuOrb = MiniOrbToggle(
    startLive: { menuStarts += 1 }, stopLive: { menuStops += 1 }, liveIsRunning: { false },
    presentPanel: { trigger in menuShows.append(trigger); return .shown(q4Facts) },
    dismissPanel: {}, requestFullWindow: {}, receipt: { menuReceipts.append($0) })
let statusMenuCommand = MiniOrbMenuCommand { trigger in menuOrb.showSurface(trigger: trigger) }
let showMiniOrbItem = statusMenuCommand.item()
expect(showMiniOrbItem.title == "Show mini orb", "the status menu carries a Show mini orb item")
expect(showMiniOrbItem.action == #selector(MiniOrbMenuCommand.press) && showMiniOrbItem.target === statusMenuCommand,
       "the Show mini orb item carries the presentation-only action, not the chord's toggle")
_ = (showMiniOrbItem.target as? NSObject)?.perform(showMiniOrbItem.action, with: showMiniOrbItem)
expect(menuOrb.isVisible && menuShows == [.menu] && menuStarts == 0 && menuStops == 0,
       "pressing the status menu item shows the mini surface and never starts Live")

q4Orb.showSurface(trigger: .menu)
expect(q4Orb.isVisible && q4Shows == 1 && q4Starts == 0 && q4Triggers == [.menu],
       "a menu-triggered show moves the surface and never starts Live")
q4Orb.hideSurface(caller: "presence")
expect(!q4Orb.isVisible && q4Receipts.last?["event"] as? String == "mini_hidden"
       && q4Receipts.last?["caller"] as? String == "presence",
       "a hide names its caller on the mini_hidden receipt")
q4Orb.show(trigger: .hotkey)
expect(q4Starts == 1, "the hotkey still starts Live")
expect(q4Receipts.contains { $0["event"] as? String == "mini_start" && $0["trigger"] as? String == "hotkey" },
       "a start receipt carries the trigger that started it")
q4Orb.hide(caller: "chord", trigger: .hotkey)
expect(q4Stops == 1, "the chord still stops Live")
expect(q4Receipts.contains { $0["event"] as? String == "mini_stop" && $0["trigger"] as? String == "hotkey" },
       "a stop receipt carries the trigger that stopped it")

// A show that cannot be hosted fails loud and never falls back (Q4-R1).
var q4FullShows = 0, q4MiniShows = 0
var q4Log: [[String: Any]] = []
let q4Failing = PresentationCoordinator(
    showFull: { _ in q4FullShows += 1 }, hideFull: {},
    showMini: { _ in q4MiniShows += 1; return .failed("page_not_ready") },
    hideMini: { _ in }, liveIsRunning: { false }, log: { q4Log.append($0) })
expect(q4Failing.presentMini(trigger: .menu) == .failed("page_not_ready") && q4MiniShows == 1 && q4FullShows == 0,
       "a mini show with no page never falls back to the FULL window")
expect(q4Failing.mode == .hidden && q4Log.last?["event"] as? String == "mini_present_deferred"
       && q4Log.last?["reason"] as? String == "page_not_ready",
       "an unready mini show logs a deferral with its reason")

q4Log = []
let q4Landing = PresentationCoordinator(
    showFull: { _ in }, hideFull: {},
    showMini: { _ in .shown(q4Facts) },
    hideMini: { _ in }, liveIsRunning: { false }, log: { q4Log.append($0) })
expect(q4Landing.presentMini(trigger: .button) == .shown(q4Facts) && q4Landing.mode == .mini,
       "a hosted mini show lands as the MINI surface")
expect(q4Log.last?["event"] as? String == "mini_presented" && q4Log.last?["trigger"] as? String == "button"
       && q4Log.last?["frame"] as? String == q4Facts.frame && q4Log.last?["screen"] as? String == "main"
       && q4Log.last?["alpha"] as? Double == 0.6 && q4Log.last?["occluded"] as? Bool == false
       && q4Log.last?["pageState"] as? String == "ready",
       "a show logs mini_presented with its frame, screen, alpha, occlusion, page state and trigger")

// Visual opacity belongs to the renderer; the native panel always has alpha one.
for state in [PresenceState.cold, .connecting, .hotMuted, .live] {
    expect(PresenceSurfaceState.shown(PresencePosture(state: state, alwaysShow: true, failed: false, muted: false)).opacity == 1,
           "native opacity stays one in every presence state")
}
let rememberedOrb = CGRect(x: 400, y: 300, width: 64, height: 26)
expect(MiniOrbFrameRestore.resolve(rememberedOrb, screens: [miniScreen]) == CGRect(x: 400, y: 300, width: 220, height: 220),
       "a valid remembered origin survives the larger orb surface")
expect(miniScreen.contains(MiniOrbFrameRestore.resolve(CGRect(x: 5000, y: 5000, width: 64, height: 26), screens: [miniScreen])),
       "a stranded orb is clamped into the visible screen")

// 338: a wake prewarms the host's warm context from the idle states only. COLD is exactly one
// prewarm, HOT_MUTED is one more, and a wake during a live call does nothing at all.
@MainActor final class WakePrewarmCounter { var calls = 0 }
let wakeCounter = WakePrewarmCounter()
let wakingPresence = NativePresence(effects: PresenceEffects(
    setCaptureMuted: { _ in },
    prewarm: { wakeCounter.calls += 1 }))
wakingPresence.wake()
expect(wakeCounter.calls == 1, "a wake while cold prewarms the warm context once")
wakingPresence.tap(.app)
wakingPresence.ready(wakingPresence.generation)
expect(wakingPresence.state == .live, "the machine reaches live through the shipped transitions")
wakingPresence.wake()
expect(wakeCounter.calls == 1, "a wake while live prewarms nothing")
wakingPresence.mute(.app)
expect(wakingPresence.state == .hotMuted, "the mute enters MUTED")
wakingPresence.wake()
expect(wakeCounter.calls == 2, "a wake inside MUTED prewarms once more")
