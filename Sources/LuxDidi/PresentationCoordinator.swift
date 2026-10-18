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
    private let showFullWindow: @MainActor (Bool) -> Void
    private let hideFullWindow: @MainActor () -> Void
    /// The show answer: the panel's own facts when the surface landed, or the reason it could
    /// not be hosted (Q4-R1).
    private let showMiniOrb: @MainActor (SurfaceTrigger) -> MiniPresentOutcome
    private let hideMiniOrb: @MainActor () -> Void
    private let liveIsRunning: @MainActor () -> Bool
    /// Every surface transition leaves a receipt, so a pill that went away has a named caller.
    private let log: @MainActor ([String: Any]) -> Void

    init(showFull: @escaping @MainActor (Bool) -> Void, hideFull: @escaping @MainActor () -> Void,
         showMini: @escaping @MainActor (SurfaceTrigger) -> MiniPresentOutcome,
         hideMini: @escaping @MainActor () -> Void,
         liveIsRunning: @escaping @MainActor () -> Bool,
         log: @escaping @MainActor ([String: Any]) -> Void = { _ in }) {
        self.showFullWindow = showFull
        self.hideFullWindow = hideFull
        self.showMiniOrb = showMini
        self.hideMiniOrb = hideMini
        self.liveIsRunning = liveIsRunning
        self.log = log
    }

    /// The Dock click, the orb click, the menu and the mode button all end here:
    /// the FULL window, and never the orb as well.
    @discardableResult
    func presentFull(activating: Bool) -> Bool {
        hideMiniOrb()
        showFullWindow(activating)
        mode = .full
        return true
    }

    /// The mini button and the Dock-less switch: the orb, and never the window as well. A page
    /// that cannot be hosted fails loud (Q4-R1): the owner asked for the orb, so quietly opening
    /// the FULL window answers a question nobody asked, and leaves no trace of why the orb is
    /// missing. The page-ready edge asks again once the host connection exists.
    @discardableResult
    func presentMini(trigger: SurfaceTrigger = .other) -> MiniPresentOutcome {
        hideFullWindow()
        let outcome = showMiniOrb(trigger)
        switch outcome {
        case .shown(let facts):
            mode = .mini
            log(["event": "mini_presented", "trigger": trigger.rawValue, "frame": facts.frame,
                 "screen": facts.screen, "alpha": facts.alpha, "occluded": facts.occluded,
                 "pageState": facts.pageState])
        case .failed(let reason):
            mode = .hidden
            log(["event": "mini_present_failed", "trigger": trigger.rawValue, "reason": reason])
        }
        return outcome
    }

    /// The orb is gone from screen without any window taking its place.
    func hideMiniSurface() {
        hideMiniOrb()
        if mode == .mini { mode = .hidden }
    }

    /// Nothing on screen: Cmd+W while no Live session runs.
    func hideAll() {
        hideFullWindow()
        hideMiniOrb()
        mode = .hidden
    }

    /// The close button and Cmd+W (UI3A-R2). An active Live session keeps
    /// running in the orb; without one the window simply hides and the app
    /// stays in the Dock.
    func closeFull() {
        switch Self.closeOutcome(liveIsRunning: liveIsRunning()) {
        case .mini: presentMini()
        case .hidden: hideAll()
        }
    }

    /// What a close does (UI3A-R2, UI3A-R7). Pure, so both outcomes are asserted
    /// without a session, and the key command cannot drift from the close button.
    static func closeOutcome(liveIsRunning: Bool) -> CloseOutcome {
        liveIsRunning ? .mini : .hidden
    }

    /// Ctrl-Opt-Shift-Space: hide the window, or bring it back.
    func toggleWindow(activating: Bool) {
        if mode == .full { hideAll() } else { presentFull(activating: activating) }
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
