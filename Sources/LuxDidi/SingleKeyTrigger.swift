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
/// A tap is a press and a release with nothing else in between and no hold
/// longer than 300 ms: a chord use, a long hold and a repeated press all leave
/// the detector quiet.
struct RightCommandTapDetector {
    /// kVK_RightCommand.
    static let keyCode: UInt16 = 54
    /// A longer press is a hold, not a tap.
    static let holdLimit: TimeInterval = 0.3
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

    /// Returns true on the release that completes a tap.
    mutating func handle(_ event: SingleKeyEvent, at time: TimeInterval) -> Bool {
        switch event {
        case .rightCommandDown:
            // A second press before the release is one press, so a stuck or
            // repeated flag cannot fire twice.
            guard downAt == nil else { return false }
            downAt = time
            // A modifier already held turns the press into a chord: Shift plus
            // Right Command is not a tap (review B2).
            chordUsed = otherModifierHeld
            return false
        case .otherKeyDown:
            chordUsed = true
            return false
        case .otherModifiers(let held):
            otherModifierHeld = held
            if held { chordUsed = true }
            return false
        case .rightCommandUp:
            guard let start = downAt else { return false }
            downAt = nil
            defer { chordUsed = false }
            return !chordUsed && time - start <= Self.holdLimit
        }
    }
}

/// What one accepted tap did, in the `single_key_tap` receipt's own words.
enum SingleKeyTapAction: String, Equatable { case start, stop, ignored }

/// One tap's receipt, built from the presence machine's state on both sides of the
/// toggle, so the `single_key_tap` line can never disagree with the `presence_state`
/// line after it.
struct SingleKeyTapOutcome: Equatable {
    let action: SingleKeyTapAction
    let reason: String

    /// A move to COLD or hot-muted stops Naya, any other move starts it, and a state
    /// that did not change is ignored and names the state it stayed in.
    init(from before: PresenceState, to after: PresenceState) {
        reason = after.rawValue
        guard before != after else { action = .ignored; return }
        action = after == .cold || after == .hotMuted ? .stop : .start
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
    static let explanation = "Naya can start and stop with a tap of the Right Command key. "
        + "macOS needs Accessibility (or Input Monitoring) permission for that key; "
        + "Control-Option-Space keeps working without it."

    /// The grant and the tap itself, as two seams: a test proves the launch receipt and
    /// the tap receipt with a fake trust provider, no event tap, no TCC prompt and no
    /// keyboard. A nil `install` uses the real tap below.
    struct System {
        var trusted: () -> Bool = { AXIsProcessTrusted() }
        var install: (() -> Bool)?
    }

    var system = System()
    var onTap: (() -> Void)?
    /// The presence machine's state as a name, so a tap receipt can say which move the
    /// tap caused. Injected, so the receipts are proven without a presence machine.
    var presenceState: () -> PresenceState = { .cold }
    /// The receipts, one at launch and one per accepted tap, into the native log.
    var onReceipt: (([String: Any]) -> Void)?
    /// Whether the listen-only tap is live. The launch receipt reports it, so a silent
    /// key can no longer be mistaken for a working one.
    private(set) var tapCreated = false

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var detector = RightCommandTapDetector()

    nonisolated static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// The Accessibility (or Input Monitoring) grant the tap needs.
    nonisolated static var isGranted: Bool { AXIsProcessTrusted() }

    /// The launch receipt: the three facts that decide whether a silent key is silent,
    /// so it can never again be a guess. `signing` is `adhoc`, `identity` or `unknown`.
    nonisolated static func stateReceipt(enabled: Bool, trusted: Bool, tapCreated: Bool,
                                         signing: String) -> [String: Any] {
        ["event": "single_key_state", "enabled": enabled, "trusted": trusted,
         "tapCreated": tapCreated, "signing": signing]
    }

    /// `adhoc` or `identity`: the fact that decides whether a grant survives an install,
    /// read from the running code's signature. `unknown` when the system will not say,
    /// which includes an unsigned run. The ad-hoc flag is `kSecCodeSignatureAdhoc`
    /// (0x0002), which Swift does not import.
    nonisolated static var signing: String {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return "unknown" }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return "unknown" }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation),
                                            &information) == errSecSuccess,
              let fields = information as? [String: Any],
              let flags = fields[kSecCodeInfoFlags as String] as? UInt32 else { return "unknown" }
        return flags & 0x0002 != 0 ? "adhoc" : "identity"
    }

    /// Asked at most once per app version, on an interactive launch, with a one-line
    /// explanation, and never by an install, proof, smoke or verification launch.
    /// `trusted` and `prompt` are seams, so the per-version branch is proven in the
    /// seams without a modal alert or a TCC prompt (review B7).
    static func requestGrantIfNeeded(for kind: LaunchKind, version: String,
                                     defaults: UserDefaults = .standard,
                                     enabled: Bool = SingleKeyTrigger.isEnabled,
                                     trusted: Bool = SingleKeyTrigger.isGranted,
                                     prompt: () -> Void = requestGrantNow) {
        guard kind == .interactive else { return }
        var store = SingleKeyGrantPrompt(
            askedVersion: { defaults.string(forKey: SingleKeyGrantPrompt.versionKey) },
            remember: { defaults.set($0, forKey: SingleKeyGrantPrompt.versionKey) })
        guard store.askOnce(enabled: enabled, trusted: trusted, version: version) else { return }
        prompt()
    }

    /// The owner turning the key back on is a fresh ask, so the system prompt
    /// follows the explanation without waiting for another launch.
    static func requestGrantNow() {
        let alert = NSAlert()
        alert.messageText = "A Right Command tap starts Naya"
        alert.informativeText = explanation
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Not now")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    /// Installs the listen-only tap. False when the key is off, the grant is missing or
    /// the system refused the tap, so the caller can say which.
    @discardableResult
    func start() -> Bool {
        guard Self.isEnabled else { return false }
        guard tap == nil, !tapCreated else { return true }
        guard system.trusted() else { return false }
        guard system.install?() ?? installLiveTap() else { return false }
        tapCreated = true
        return true
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
    /// without carrying a stale down time into the next tap (review B6).
    func reEnable() {
        guard let tap else { return }
        detector = RightCommandTapDetector()
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        source = nil
        tap = nil
        tapCreated = false
        detector = RightCommandTapDetector()
    }

    /// Feeds one event to the detector on the main actor, fires the toggle when the
    /// release completes a tap, and logs what that tap did. The move is read from the
    /// presence machine on both sides of the toggle, so the two log lines agree.
    func receive(_ event: SingleKeyEvent, at time: TimeInterval) {
        guard detector.handle(event, at: time) else { return }
        guard let onTap else { return }
        let before = presenceState()
        onTap()
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
