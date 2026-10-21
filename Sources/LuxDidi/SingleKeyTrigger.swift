import AppKit
import ApplicationServices
import CoreGraphics
import Security

/// One keyboard fact the single-key trigger cares about. The detector below is a
/// pure state machine over these, so a tap, a chord use (Cmd+C) and a long hold
/// are proven in Tests/DidiMacTests/main.swift without an event tap, a grant or a
/// real keyboard.
enum SingleKeyEvent: Equatable {
    case rightCommandDown
    case rightCommandUp
    /// Any other key went down, which makes the press a chord.
    case otherKeyDown
    /// A modifier other than Right Command changed; `held` says whether one is
    /// still down. A modifier held BEFORE the press is a chord too, so the
    /// detector has to know the state and not only the change.
    case otherModifiers(held: Bool)
}

/// MINI2, owner decision 10:45 IST: Right Command is Naya's single key. Right
/// Option belongs to SuperWhisper, so this detector never looks at it and the
/// event tap never swallows an event (a listen-only tap consumes nothing).
///
/// Q2, owner order 2026-10-18: the key works like Superwhisper's Right Option, so a
/// press released under the hold threshold is a tap and a press still down at the
/// threshold is push-to-talk. Both are gestures, and a press with another key or
/// modifier in it is neither: a chord use leaves the detector quiet.
struct RightCommandTapDetector {
    /// kVK_RightCommand.
    static let keyCode: UInt16 = 54
    /// A press still down this long is a hold, and a press released before it is a tap.
    static let holdThreshold: TimeInterval = 0.4
    /// `NX_DEVICERCMDKEYMASK`: the device bit that belongs to the RIGHT Command
    /// key alone, which tells its press from its release while the other Command
    /// key is down. `.maskCommand` alone cannot (review B3).
    static let rightCommandDeviceMask: UInt64 = 0x10
    /// `NX_DEVICELCMDKEYMASK`, the Left Command device bit.
    static let leftCommandDeviceMask: UInt64 = 0x08
    /// Shift, Control and Option.
    static let otherModifierMasks: UInt64 = CGEventFlags.maskShift.rawValue
        | CGEventFlags.maskControl.rawValue | CGEventFlags.maskAlternate.rawValue

    /// The system turns a tap off after a timeout or on user input; the callback
    /// must re-arm it or the key dies silently (review B6).
    static func shouldReArm(_ type: CGEventType) -> Bool {
        type == .tapDisabledByTimeout || type == .tapDisabledByUserInput
    }

    /// Whether the Right Command key itself is down, from its device bit.
    static func rightCommandIsDown(flagsRawValue: UInt64) -> Bool {
        flagsRawValue & rightCommandDeviceMask != 0
    }

    /// Whether a modifier other than Right Command is held: Shift, Control,
    /// Option or Left Command. Right Command's own bits are excluded, because it
    /// is the key being watched.
    static func otherModifiersHeld(flagsRawValue: UInt64) -> Bool {
        if flagsRawValue & otherModifierMasks != 0 { return true }
        if flagsRawValue & leftCommandDeviceMask != 0 { return true }
        // A command bit with no device bit at all is a modifier we cannot place,
        // so treat it as another modifier rather than as our own key.
        return flagsRawValue & CGEventFlags.maskCommand.rawValue != 0
            && flagsRawValue & (leftCommandDeviceMask | rightCommandDeviceMask) == 0
    }

    private var downAt: TimeInterval?
    private var chordUsed = false
    private var otherModifierHeld = false
    private var holdStarted = false
    /// The press was given up on, so its release is not a gesture. A chord sets it after
    /// ending a hold, and a tap disabled mid-press sets it through `abandonPress`.
    private var cancelled = false

    /// Whether a press is open right now, so the app can arm the hold timer once.
    var isPressing: Bool { downAt != nil }

    /// The gestures one event completes. A release completes a tap or ends a started hold,
    /// a chord reports itself once and cancels whatever press it lands in, and a press
    /// alone completes nothing.
    mutating func handle(_ event: SingleKeyEvent, at time: TimeInterval) -> [SingleKeyGesture] {
        switch event {
        case .rightCommandDown:
            // A second press before the release is one press, so a stuck or
            // repeated flag cannot fire twice.
            guard downAt == nil else { return [] }
            downAt = time
            holdStarted = false
            cancelled = false
            // A modifier already held turns the press into a chord: Shift plus
            // Right Command is not a tap (review B2).
            chordUsed = otherModifierHeld
            return []
        case .otherKeyDown:
            chordUsed = true
            return cancelHold()
        case .otherModifiers(let held):
            otherModifierHeld = held
            guard held else { return [] }
            chordUsed = true
            return cancelHold()
        case .rightCommandUp:
            guard let start = downAt else { return [] }
            let wasHold = holdStarted
            let wasChord = chordUsed
            let wasCancelled = cancelled
            downAt = nil
            holdStarted = false
            chordUsed = false
            cancelled = false
            // A cancelled press has already reported itself, so its release is silent.
            if wasCancelled { return [] }
            // A hold that still runs at the release ends here, whatever else arrived; the
            // chord that cancels one already ended it where the chord landed.
            if wasHold { return [.holdEnd] }
            if wasChord { return [.ignored("chord")] }
            // A late timer is not a lost gesture: the press was a hold all along.
            if time - start >= Self.holdThreshold { return [.holdStart, .holdEnd] }
            return [.tap]
        }
    }

    /// The hold timer, armed by the app at the press and fired at the threshold: a press
    /// still open and still uncancelled becomes a hold, exactly once.
    mutating func poll(at time: TimeInterval) -> [SingleKeyGesture] {
        guard let start = downAt, !holdStarted, !cancelled, !chordUsed,
              time - start >= Self.holdThreshold else { return [] }
        holdStarted = true
        return [.holdStart]
    }

    /// The rest of this press was lost to the system: an open hold ends now, so a fence
    /// no timer will close is never left closed. Nothing else about the press survives.
    mutating func abandonPress() -> [SingleKeyGesture] {
        let wasHold = holdStarted
        holdStarted = false
        cancelled = true
        return wasHold ? [.holdEnd] : []
    }

    /// A chord during a started hold cancels it where the chord lands: the fence closes at
    /// that moment and the rest of the press is inert, so the release is not a second
    /// gesture. A chord before the threshold ends nothing, because nothing opened.
    private mutating func cancelHold() -> [SingleKeyGesture] {
        guard holdStarted else { return [] }
        holdStarted = false
        cancelled = true
        return [.holdEnd]
    }
}

/// What an accepted press did, in the `single_key_tap` receipt's own words.
enum SingleKeyGesture: Equatable {
    /// A press released under the threshold: start when idle, stop when live.
    case tap
    /// A press still down at the threshold: the mic opens while it is held.
    case holdStart
    /// The release of that press: the fence closes and the answer may finish.
    case holdEnd
    /// A press a chord took over, with the reason in the receipt's words.
    case ignored(String)
}

/// What one accepted press did, in the `single_key_tap` receipt's own words.
enum SingleKeyTapAction: String, Equatable {
    case start, stop, mute, unmute, ignored
}

/// One tap's receipt, built from the presence machine's state on both sides of the
/// toggle, so the `single_key_tap` line can never disagree with the `presence_state`
/// line after it.
struct SingleKeyTapOutcome: Equatable {
    let action: SingleKeyTapAction
    let reason: String

    /// One bare tap starts her from cold, mutes her from live and lets her listen again
    /// from muted; a tap she did not move is ignored and names the state it stayed in.
    init(from before: PresenceState, to after: PresenceState) {
        reason = after.rawValue
        switch (before, after) {
        case _ where before == after: action = .ignored
        case (_, .cold): action = .stop
        case (_, .hotMuted): action = .mute
        case (.hotMuted, _): action = .unmute
        default: action = .start
        }
    }
}

/// The per-version grant ask (`#3p`). An ad-hoc signed install can lose its
/// Accessibility grant when the binary is replaced, so the request is made once per
/// app version and not once ever: the version that asked is remembered and a new
/// version asks once more. The same shape as the Mic Mode prompt (`#352`).
struct SingleKeyGrantPrompt {
    static let versionKey = "DidiSingleKeyGrantAskedVersion"
    var askedVersion: () -> String? = { UserDefaults.standard.string(forKey: versionKey) }
    var remember: (String) -> Void = { UserDefaults.standard.set($0, forKey: versionKey) }
    private var loaded = false
    private var asked: String?

    /// True at most once per app version, and only while the key is on and the grant is
    /// missing. A key that has its grant never asks, so an install that keeps the grant
    /// never nags; one that loses it is asked once at the next launch of that version.
    mutating func askOnce(enabled: Bool, trusted: Bool, version: String) -> Bool {
        guard enabled, !trusted else { return false }
        if !loaded { asked = askedVersion(); loaded = true }
        guard asked != version else { return false }
        asked = version
        remember(version)
        return true
    }
}

/// The event-tap half: watches Right Command and nothing else. A listen-only tap
/// needs the Accessibility / Input Monitoring grant; without it `start()` returns
/// false, the Control-Option-Space chord keeps working, and the settings view
/// says why this key is inactive.
@MainActor
final class SingleKeyTrigger {
    /// On by default; only an explicit `false` turns the single key off.
    static let enabledKey = "DidiSingleKeyTriggerEnabled"
    static let explanation = "A tap of the Right Command key mutes Naya and a second tap lets "
        + "her listen again. macOS needs Input Monitoring permission for that key; "
        + "Control-Option-Space keeps working without it."

    /// The grant and the tap itself, as two seams: a test proves the launch receipt and
    /// the tap receipt with a fake trust provider, no event tap, no TCC prompt and no
    /// keyboard. A nil `install` uses the real tap below.
    struct System {
        var grants: () -> Grants = { SingleKeyTrigger.currentGrants() }
        var install: (() -> Bool)?
    }

    var system = System()
    var onTap: (() -> Void)?
    /// Q2: the held press opened the mic, and its release closed the fence.
    /// The clock the hold threshold is measured on, the same monotonic clock the event
    /// tap stamps events with. Injected, so a seam test never waits for a real 400 ms.
    var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    /// The hold clock as a seam: the app arms one timer per press and a seam test fires
    /// it by hand, so no test sleeps through the threshold.
    var scheduleHold: (@escaping @MainActor () -> Void, TimeInterval) -> Void = { work, delay in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } }
    }
    /// The presence machine's state as a name, so a tap receipt can say which move the
    /// tap caused. Injected, so the receipts are proven without a presence machine.
    var presenceState: () -> PresenceState = { .cold }
    /// The receipts, one at launch and one per accepted press, into the native log.
    var onReceipt: (([String: Any]) -> Void)?
    /// Whether the listen-only tap is live. The launch receipt reports it, so a silent
    /// key can no longer be mistaken for a working one.
    private(set) var tapCreated = false

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var detector = RightCommandTapDetector()
    private var reportedGrants: Grants?
    private var reportedTap: Bool?
    private var reportedEnabled: Bool?
    /// Bumped on every press, so a hold timer left over from an earlier press is inert.
    private var holdToken = 0

    nonisolated static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// The two grants a listen-only tap can stand on (ruling HOTKEY-R2). Input Monitoring is
    /// the one the tap needs; Accessibility also works and older installs already have it.
    struct Grants: Equatable {
        let listenEvent: Bool
        let accessibility: Bool
        var any: Bool { listenEvent || accessibility }
    }

    /// The system's answer, as one value, so a test proves the gate with no TCC prompt.
    nonisolated static func currentGrants(listenEvent: Bool = CGPreflightListenEventAccess(),
                                         accessibility: Bool = AXIsProcessTrusted()) -> Grants {
        Grants(listenEvent: listenEvent, accessibility: accessibility)
    }

    nonisolated static var isGranted: Bool { currentGrants().any }

    /// The launch and change receipt: the facts that decide whether a silent key is silent,
    /// both grants reported apart (R2). `signing` is `adhoc`, `identity` or `unknown`.
    nonisolated static func stateReceipt(enabled: Bool, grants: Grants, tapCreated: Bool,
                                         signing: String) -> [String: Any] {
        ["event": "single_key_state", "enabled": enabled, "trusted": grants.any,
         "listenEvent": grants.listenEvent, "accessibility": grants.accessibility,
         "tapCreated": tapCreated, "signing": signing]
    }

    /// The pane the grant lives in, and the one address the off item opens.
    static let grantSettingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"

    /// The one line the status menu carries while the key cannot work, and nothing once the
    /// tap is live. It reads the grant and the tap, never the once-per-version prompt, so a
    /// dismissed prompt still leaves the owner a way in.
    static func grantNoticeTitle(enabled: Bool, tapped: Bool) -> String? {
        enabled && !tapped ? "Right Command is off: allow Input Monitoring for Naya" : nil
    }

    /// `adhoc`, `identity` or `unknown` for one set of code-signature flags. The
    /// ad-hoc flag is `kSecCodeSignatureAdhoc` (0x0002), which Swift does not
    /// import. A signature the system will not describe is never called
    /// `identity`, because that is the label that promises a grant survives.
    nonisolated static func signingLabel(codeFlags: () -> UInt32?) -> String {
        guard let flags = codeFlags() else { return "unknown" }
        return flags & 0x0002 != 0 ? "adhoc" : "identity"
    }

    /// `adhoc` or `identity`: the fact that decides whether a grant survives an install,
    /// read from the running code's signature. `unknown` when the system will not say,
    /// which includes an unsigned run.
    nonisolated static var signing: String { signingLabel(codeFlags: currentCodeFlags) }

    /// The flags of the running executable's own signature, or `nil` when the
    /// system will not describe it. The one place this file asks the system.
    nonisolated static func currentCodeFlags() -> UInt32? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation),
                                            &information) == errSecSuccess,
              let fields = information as? [String: Any],
              let flags = fields[kSecCodeInfoFlags as String] as? UInt32 else { return nil }
        return flags
    }

    /// Asked at most once per app version, on an interactive launch, with a one-line
    /// explanation, and never by an install, proof, smoke or verification launch.
    /// `trusted` and `prompt` are seams, so the per-version branch is proven in the
    /// seams without a modal alert or a TCC prompt (review B7).
    static func requestGrantIfNeeded(for kind: LaunchKind, version: String,
                                     defaults: UserDefaults = .standard,
                                     enabled: Bool = SingleKeyTrigger.isEnabled,
                                     granted: Bool = SingleKeyTrigger.isGranted,
                                     prompt: () -> Void = requestGrantNow) {
        guard kind == .interactive else { return }
        var store = SingleKeyGrantPrompt(
            askedVersion: { defaults.string(forKey: SingleKeyGrantPrompt.versionKey) },
            remember: { defaults.set($0, forKey: SingleKeyGrantPrompt.versionKey) })
        guard store.askOnce(enabled: enabled, trusted: granted, version: version) else { return }
        prompt()
    }

    /// The owner turning the key back on is a fresh ask, so the system prompt follows the
    /// explanation without waiting for another launch. R2: the tap is a listen-only tap, so
    /// the prompt is the Input Monitoring one, which adds Naya to that list by itself.
    static func requestGrantNow() {
        let alert = NSAlert()
        alert.messageText = "A Right Command tap mutes Naya"
        alert.informativeText = explanation
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Not now")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        requestListenEventAccess()
    }

    /// The system prompt for the grant a listen-only tap needs. False when nothing was granted.
    @discardableResult
    nonisolated static func requestListenEventAccess() -> Bool {
        CGRequestListenEventAccess()
    }

    /// Installs the listen-only tap. False when the key is off, the grant is missing or
    /// the system refused the tap, so the caller can say which. Safe to ask again: the app
    /// calls it on activation and on a slow timer, and the tap goes in the moment a grant
    /// that arrived after launch is there. Every change of trust or tap is one
    /// `single_key_state` receipt.
    @discardableResult
    func start() -> Bool {
        let live = installIfPossible()
        reportIfChanged()
        return live
    }

    private func installIfPossible() -> Bool {
        guard Self.isEnabled else { return false }
        guard tap == nil, !tapCreated else { return true }
        guard system.grants().any else { return false }
        guard system.install?() ?? installLiveTap() else { return false }
        tapCreated = true
        return true
    }

    /// One receipt per trust or tap change: the launch, the grant arriving, the owner
    /// turning the key off. A re-check that changes nothing writes nothing.
    private func reportIfChanged() {
        let grants = system.grants()
        let enabled = Self.isEnabled
        guard reportedGrants != grants || reportedTap != tapCreated || reportedEnabled != enabled
        else { return }
        reportedGrants = grants
        reportedTap = tapCreated
        reportedEnabled = enabled
        onReceipt?(Self.stateReceipt(enabled: enabled, grants: grants,
                                     tapCreated: tapCreated, signing: Self.signing))
    }

    /// The real tap: listen-only, on the session, never swallowing an event.
    private func installLiveTap() -> Bool {
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                           options: .listenOnly, eventsOfInterest: CGEventMask(mask),
                                           callback: singleKeyTapCallback,
                                           userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        tap = port
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    /// Re-arms the tap and drops any half-seen press, so a disabled tap resumes
    /// without carrying a stale down time into the next tap (review B6). The key-up can
    /// be one of the events the disable swallowed, so an open hold ends here rather than
    /// leaving the mic open with no timer left to close it (review B2).
    func reEnable() {
        guard let tap else { return }
        let lost = detector.abandonPress()
        detector = RightCommandTapDetector()
        holdToken &+= 1
        for gesture in lost { perform(gesture) }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        source = nil
        tap = nil
        tapCreated = false
        detector = RightCommandTapDetector()
        reportIfChanged()
    }

    /// Feeds one event to the detector on the main actor and performs the gestures it
    /// completes. A press arms the one hold timer, a release before the threshold taps,
    /// a timer at the threshold starts a hold, and the release of that hold ends it. Each
    /// gesture logs `single_key_tap`, with the move read from the presence machine on
    /// both sides, so the two log lines always agree.
    func receive(_ event: SingleKeyEvent, at time: TimeInterval) {
        let gestures = detector.handle(event, at: time)
        if event == .rightCommandDown, detector.isPressing { armHoldTimer() }
        for gesture in gestures { perform(gesture) }
    }

    /// One timer per press, at the hold threshold: the press becomes a hold while it is
    /// still down, which is what makes the mic open while the key is held.
    private func armHoldTimer() {
        holdToken &+= 1
        let token = holdToken
        scheduleHold({ [weak self] in
            guard let self, self.holdToken == token else { return }
            for gesture in self.detector.poll(at: self.now()) { self.perform(gesture) }
        }, RightCommandTapDetector.holdThreshold)
    }

    private func perform(_ gesture: SingleKeyGesture) {
        // Revised 2026-10-21: the bare tap is the one gesture. A held key and a chord
        // leave the machine where it is and say so.
        switch gesture {
        case .ignored(let reason):
            onReceipt?(["event": "single_key_tap", "action": SingleKeyTapAction.ignored.rawValue,
                        "reason": reason])
            return
        case .holdStart, .holdEnd:
            onReceipt?(["event": "single_key_tap", "action": SingleKeyTapAction.ignored.rawValue,
                        "reason": "hold"])
            return
        case .tap:
            break
        }
        let before = presenceState()
        onTap?()
        let outcome = SingleKeyTapOutcome(from: before, to: presenceState())
        onReceipt?(["event": "single_key_tap", "action": outcome.action.rawValue, "reason": outcome.reason])
    }
}


/// A C callback, so it captures nothing: the event is decoded here and the
/// decision runs on the main actor.
private let singleKeyTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon else { return Unmanaged.passUnretained(event) }
    if RightCommandTapDetector.shouldReArm(type) {
        DispatchQueue.main.async {
            Unmanaged<SingleKeyTrigger>.fromOpaque(refcon).takeUnretainedValue().reEnable()
        }
        return nil
    }
    let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
    let isRightCommand = keyCode == RightCommandTapDetector.keyCode
    let decoded: SingleKeyEvent
    switch type {
    case .keyDown:
        guard !isRightCommand else { return Unmanaged.passUnretained(event) }
        decoded = .otherKeyDown
    case .flagsChanged where isRightCommand:
        // The generic command bit is set while either Command key is down, so the
        // press/release comes from the device bit of the RIGHT Command key, never
        // from .maskCommand (review B3).
        decoded = RightCommandTapDetector.rightCommandIsDown(flagsRawValue: event.flags.rawValue)
            ? .rightCommandDown : .rightCommandUp
    case .flagsChanged:
        decoded = .otherModifiers(held: RightCommandTapDetector.otherModifiersHeld(flagsRawValue: event.flags.rawValue))
    default:
        return Unmanaged.passUnretained(event)
    }
    let time = ProcessInfo.processInfo.systemUptime
    DispatchQueue.main.async {
        let owner = Unmanaged<SingleKeyTrigger>.fromOpaque(refcon).takeUnretainedValue()
        owner.receive(decoded, at: time)
    }
    return Unmanaged.passUnretained(event)
}
