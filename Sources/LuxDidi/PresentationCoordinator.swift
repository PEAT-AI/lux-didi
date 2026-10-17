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
    /// Returns false when there is no page to host, so the coordinator can fall
    /// back to the window instead of leaving no surface at all.
    private let showMiniOrb: @MainActor () -> Bool
    private let hideMiniOrb: @MainActor () -> Void
    private let liveIsRunning: @MainActor () -> Bool

    init(showFull: @escaping @MainActor (Bool) -> Void, hideFull: @escaping @MainActor () -> Void,
         showMini: @escaping @MainActor () -> Bool, hideMini: @escaping @MainActor () -> Void,
         liveIsRunning: @escaping @MainActor () -> Bool) {
        self.showFullWindow = showFull
        self.hideFullWindow = hideFull
        self.showMiniOrb = showMini
        self.hideMiniOrb = hideMini
        self.liveIsRunning = liveIsRunning
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

    /// The mini button and the Dock-less switch: the orb, and never the window
    /// as well. A page that cannot be hosted falls back to the FULL window.
    @discardableResult
    func presentMini() -> Bool {
        hideFullWindow()
        guard showMiniOrb() else { return presentFull(activating: false) }
        mode = .mini
        return true
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
        if liveIsRunning() { presentMini() } else { hideAll() }
    }

    /// Ctrl-Opt-Shift-Space: hide the window, or bring it back.
    func toggleWindow(activating: Bool) {
        if mode == .full { hideAll() } else { presentFull(activating: activating) }
    }
}
