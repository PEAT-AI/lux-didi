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

/// The close command's two outcomes: an active Live session keeps running in the
/// mini orb, otherwise the window hides.
enum CloseOutcome: Equatable { case mini, hidden }

/// The one owner of which surface is visible: the FULL window or the MINI orb.
/// A surface is a pair of closures, so every transition is proven in
/// Tests/DidiMacTests/main.swift without a window, a screen or a launch.
/// The coordinator never touches Live, so switching modes can never end a
/// session or open a second one.
@MainActor
final class PresentationCoordinator {
    enum Mode: Equatable { case hidden, full, mini }

    private(set) var mode: Mode = .hidden
    private(set) var desired: Mode = .full
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

    @discardableResult
    func presentFull(activating: Bool) -> Bool {
        begin(.full)
        activation = activating
        if let prepare, mode != .full { prepare(.full, generation) }
        else { commitFull() }
        return true
    }

    @discardableResult
    func presentMini(trigger: SurfaceTrigger = .other) -> MiniPresentOutcome {
        begin(.mini)
        self.trigger = trigger
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

    func requestPresence() {
        guard !explicitlyHidden, desired == .mini, mode != .full, pending == nil else { return }
        if mode != .mini { _ = presentMini() }
    }

    func allowPresenceReveal() {
        explicitlyHidden = false
        if desired == .hidden { _ = presentFull(activating: true) }
        else { requestPresence() }
    }

    func hideMiniSurface() { hideAll() }

    func hideAll() {
        requestChanged()
        generation &+= 1; desired = .hidden; pending = nil; explicitlyHidden = true
        hideFullWindow(); hideMiniOrb("hide_all")
        mode = .hidden; didCommit(mode, generation)
    }

    func closeFull() {
        if Self.closeOutcome(liveIsRunning: liveIsRunning()) == .mini { _ = presentMini() }
        else { hideAll() }
    }

    static func closeOutcome(liveIsRunning: Bool) -> CloseOutcome { liveIsRunning ? .mini : .hidden }

    func toggleWindow(activating: Bool) {
        if desired == .full { hideAll() } else { _ = presentFull(activating: activating) }
    }

    private func begin(_ target: Mode) {
        requestChanged()
        generation &+= 1; desired = target; pending = target; explicitlyHidden = false
    }

    private func commitFull() {
        showFullWindow(activation)
        hideMiniOrb("present_full")
        mode = .full; pending = nil
        didCommit(mode, generation)
    }

    private func commitMini() -> MiniPresentOutcome {
        let outcome = showMiniOrb(trigger)
        switch outcome {
        case .shown(let facts):
            hideFullWindow()
            mode = .mini; pending = nil
            log(["event": "mini_presented", "trigger": trigger.rawValue, "frame": facts.frame,
                 "screen": facts.screen, "alpha": facts.alpha, "occluded": facts.occluded,
                 "pageState": facts.pageState, "generation": generation])
            didCommit(mode, generation)
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
