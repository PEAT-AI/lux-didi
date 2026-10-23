import AppKit

/// How a launch presents the app (UI3A-R1). The interactive, login-item and
/// install-relaunch launches are regular apps: a Dock tile, a Cmd-Tab entry and
/// a window that stays in front. The non-activating proof launches stay
/// accessory, so a check gains no Dock tile while it proves something else.
enum LaunchActivation: Equatable { case regular, accessory }

extension LaunchKind {
    var activation: LaunchActivation {
        switch self {
        case .interactive, .loginItem, .installRelaunch: return .regular
        case .installedProof, .selfCheck, .uiProof, .verification: return .accessory
        }
    }
    /// The policy for `NSApp.setActivationPolicy`, set once at launch and never
    /// switched at runtime (a runtime switch flashes the Dock and moves focus).
    var activationPolicy: NSApplication.ActivationPolicy {
        switch activation {
        case .regular: return .regular
        case .accessory: return .accessory
        }
    }
}

/// The one owner of which surfaces are visible: the FULL window, the MINI orb, or both.
/// A surface is a pair of closures, so every transition is proven in
/// Tests/DidiMacTests/main.swift without a window, a screen or a launch.
/// The coordinator never touches Live, so switching surfaces can never end a
/// session or open a second one.
@MainActor
final class PresentationCoordinator {
    enum Mode: Equatable { case hidden, full, mini }

    private(set) var mode: Mode = .hidden
    /// ORBFIRST: the two surfaces are independent. The orb is the resting surface, and the window
    /// comes and goes beside it, so neither show hides the other.
    private(set) var fullShown = false
    private(set) var miniShown = false
    private(set) var desired: Mode = .mini
    private(set) var generation: UInt64 = 0
    private(set) var explicitlyHidden = false
    private var pending: Mode?
    private var activation = false
    private var trigger: SurfaceTrigger = .other
    private let showFullWindow: @MainActor (Bool) -> Void
    private let hideFullWindow: @MainActor () -> Void
    private let showMiniOrb: @MainActor (SurfaceTrigger) -> MiniPresentOutcome
    private let hideMiniOrb: @MainActor (String) -> Void
    private let liveIsRunning: @MainActor () -> Bool
    private let log: @MainActor ([String: Any]) -> Void
    private let prepare: (@MainActor (Mode, UInt64) -> Void)?
    private let didCommit: @MainActor (Mode, UInt64) -> Void
    private let requestChanged: @MainActor () -> Void

    init(showFull: @escaping @MainActor (Bool) -> Void, hideFull: @escaping @MainActor () -> Void,
         showMini: @escaping @MainActor (SurfaceTrigger) -> MiniPresentOutcome,
         hideMini: @escaping @MainActor (String) -> Void,
         liveIsRunning: @escaping @MainActor () -> Bool,
         log: @escaping @MainActor ([String: Any]) -> Void = { _ in },
         prepare: (@MainActor (Mode, UInt64) -> Void)? = nil,
         didCommit: @escaping @MainActor (Mode, UInt64) -> Void = { _, _ in },
         requestChanged: @escaping @MainActor () -> Void = {}) {
        showFullWindow = showFull; hideFullWindow = hideFull
        showMiniOrb = showMini; hideMiniOrb = hideMini
        self.liveIsRunning = liveIsRunning; self.log = log
        self.prepare = prepare; self.didCommit = didCommit; self.requestChanged = requestChanged
    }

    /// Opening an already open window raises it instead of presenting the page again.
    @discardableResult
    func presentFull(activating: Bool) -> Bool {
        activation = activating
        requestChanged()
        explicitlyHidden = false
        desired = .full
        if fullShown, pending == nil { showFullWindow(activating); return true }
        generation &+= 1
        pending = .full
        if let prepare, !fullShown { prepare(.full, generation) }
        else { commitFull() }
        return true
    }

    /// ORBFIRST: a show of an orb that is already on screen does nothing. The hotkey, the menu
    /// item and the window's own button repeat it, and a second show cycle was the flicker.
    @discardableResult
    func presentMini(trigger: SurfaceTrigger = .other) -> MiniPresentOutcome {
        self.trigger = trigger
        if miniShown, pending == nil { return .alreadyPresented }
        requestChanged()
        explicitlyHidden = false
        desired = .mini
        generation &+= 1
        pending = .mini
        if let prepare {
            log(["event": "mini_present_deferred", "trigger": trigger.rawValue,
                 "reason": "awaiting_paint", "generation": generation])
            prepare(.mini, generation)
            return .deferred
        }
        return commitMini()
    }

    func prepared(_ target: Mode, generation token: UInt64, failure: String? = nil) {
        guard token == generation, pending == target, desired == target else { return }
        pending = nil
        if let failure {
            let deferred = failure == "page_not_ready"
            log(["event": target == .mini ? (deferred ? "mini_present_deferred" : "mini_present_failed") : "full_present_failed",
                 "trigger": trigger.rawValue, "reason": failure, "generation": token])
            return
        }
        if target == .full { commitFull() } else if target == .mini { _ = commitMini() }
    }

    /// The presence machine asks for the orb, never for the window: revealing the orb leaves an
    /// open window where it is.
    func requestPresence() {
        guard !explicitlyHidden, pending == nil, !miniShown else { return }
        _ = presentMini()
    }

    func allowPresenceReveal() {
        explicitlyHidden = false
        if !miniShown, desired != .full { _ = presentMini() }
    }

    /// The orb goes away and the window, if open, stays.
    func hideMiniSurface() {
        guard miniShown || pending == .mini else { return }
        requestChanged()
        generation &+= 1; pending = nil; miniShown = false
        hideMiniOrb("hide_mini")
        mode = fullShown ? .full : .hidden
        explicitlyHidden = !fullShown
        didCommit(mode, generation)
    }

    func hideAll() {
        requestChanged()
        generation &+= 1; desired = .hidden; pending = nil; explicitlyHidden = true
        fullShown = false; miniShown = false
        hideFullWindow(); hideMiniOrb("hide_all")
        mode = .hidden; didCommit(mode, generation)
    }

    /// Closing the window returns to orb only: it never quits and never ends a call.
    func closeFull() {
        guard fullShown || pending == .full else { return }
        requestChanged()
        generation &+= 1; pending = nil; fullShown = false
        hideFullWindow()
        log(["event": "window_closed", "live": liveIsRunning(), "orb": miniShown])
        if !miniShown { _ = presentMini(trigger: .other); return }
        mode = .mini; didCommit(mode, generation)
    }

    func toggleWindow(activating: Bool) {
        if fullShown { closeFull() } else { _ = presentFull(activating: activating) }
    }

    private func commitFull() {
        showFullWindow(activation)
        fullShown = true; pending = nil
        mode = .full
        didCommit(mode, generation)
    }

    private func commitMini() -> MiniPresentOutcome {
        let outcome = showMiniOrb(trigger)
        switch outcome {
        case .shown(let facts):
            miniShown = true; pending = nil
            if !fullShown { mode = .mini }
            log(["event": "mini_presented", "trigger": trigger.rawValue, "frame": facts.frame,
                 "screen": facts.screen, "alpha": facts.alpha, "occluded": facts.occluded,
                 "pageState": facts.pageState, "generation": generation])
            didCommit(mode, generation)
        case .alreadyPresented:
            pending = nil
        case .failed(let reason):
            pending = nil
            log(["event": reason == "page_not_ready" ? "mini_present_deferred" : "mini_present_failed",
                 "trigger": trigger.rawValue, "reason": reason, "generation": generation])
        case .deferred: break
        }
        return outcome
    }
}

/// The app's main menu (UI3A-R7). A hand-built NSApplication carries no AppKit
/// File menu, so Command-W had no binding at all and the window could only be
/// closed by its traffic light. File > Close Window sends the standard
/// `performClose:` to the window, so the key command and the close button travel
/// the same `windowShouldClose` path: hide when idle, switch to MINI during Live.
@MainActor
enum WindowMenu {
    static let closeTitle = "Close Window"
    static func build(appName: String = "Naya", closeTarget: AnyObject?) -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem(title: appName, action: nil, keyEquivalent: "")
        appItem.submenu = {
            let menu = NSMenu(title: appName)
            menu.addItem(withTitle: "Quit \(appName)",
                         action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            return menu
        }()
        main.addItem(appItem)
        let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        fileItem.submenu = {
            let menu = NSMenu(title: "File")
            let close = menu.addItem(withTitle: closeTitle,
                                     action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
            close.target = closeTarget
            return menu
        }()
        main.addItem(fileItem)
        return main
    }
}
