import AppKit
import WebKit

/// Toggle semantics for the floating mini orb, shared by the global hotkey,
/// the Escape key and the menu bar. Pure closures, so the behaviour is proven
/// in Tests/DidiMacTests/main.swift without launching AppKit or the app.
@MainActor
final class MiniOrbToggle {
    private let startLive: @MainActor () -> Void
    private let stopLive: @MainActor () -> Void
    private let liveIsRunning: @MainActor () -> Bool
    private let presentPanel: @MainActor () -> Void
    private let dismissPanel: @MainActor () -> Void
    private let expandToWindow: @MainActor () -> Void
    private(set) var isVisible = false

    init(startLive: @escaping @MainActor () -> Void, stopLive: @escaping @MainActor () -> Void,
         liveIsRunning: @escaping @MainActor () -> Bool, presentPanel: @escaping @MainActor () -> Void,
         dismissPanel: @escaping @MainActor () -> Void, expandToWindow: @escaping @MainActor () -> Void) {
        self.startLive = startLive; self.stopLive = stopLive; self.liveIsRunning = liveIsRunning
        self.presentPanel = presentPanel; self.dismissPanel = dismissPanel; self.expandToWindow = expandToWindow
    }

    func toggle() { isVisible ? hide() : show() }

    /// The chord or the menu item: show the orb and start Live when it is not
    /// already running.
    func show() {
        if !isVisible, !liveIsRunning() { startLive() }
        showSurface()
    }

    /// The explicit stop: hide the orb and stop Live.
    func hide() {
        guard isVisible else { return }
        hideSurface()
        stopLive()
    }

    /// A presentation switch that starts and stops nothing: the mini button and
    /// the close-during-Live path only move the surface, so a running session is
    /// never restarted and an idle app never opens one.
    func showSurface() {
        isVisible = true
        presentPanel()
    }

    func hideSurface() {
        guard isVisible else { return }
        isVisible = false
        dismissPanel()
    }

    /// A click on the orb: expand the full window and keep Live running.
    func expand() {
        guard isVisible else { return }
        isVisible = false
        dismissPanel()
        expandToWindow()
    }
}

/// Mini orb position, remembered like `WindowFrameRestore` but at 300x300 and
/// without the 980x760 window minimum, so a compact frame is never rejected.
/// A frame that is still partly on a screen is clamped into that screen rather
/// than discarded, so unplugging a display never throws the orb away.
enum MiniOrbFrameRestore {
    static let size = CGSize(width: 300, height: 300)
    static func resolve(_ saved: CGRect?, screens: [CGRect]) -> CGRect {
        let fallback = CGRect(x: 0, y: 0, width: 1440, height: 900)
        if let saved, saved.width >= 120, saved.height >= 120 {
            let screen = screens.first(where: { $0.intersects(saved) }) ?? screens.first ?? fallback
            let width = min(saved.width, screen.width), height = min(saved.height, screen.height)
            return clamp(CGRect(x: saved.minX, y: saved.minY, width: width, height: height), into: screen)
        }
        let screen = screens.first ?? fallback
        let width = min(size.width, screen.width), height = min(size.height, screen.height)
        return CGRect(x: screen.midX - width / 2, y: screen.midY - height / 2, width: width, height: height)
    }
    /// Shifts a rect inside `screen` without resizing it: the orb never lands
    /// under the menu bar, off an edge, or outside every Space it can join.
    static func clamp(_ rect: CGRect, into screen: CGRect) -> CGRect {
        let x = min(max(rect.minX, screen.minX), screen.maxX - rect.width)
        let y = min(max(rect.minY, screen.minY), screen.maxY - rect.height)
        return CGRect(x: x, y: y, width: rect.width, height: rect.height)
    }
}

/// The panel's presentation rules, kept as values so "the orb never becomes key,
/// never becomes main, floats over full-screen apps and stays out of the app
/// switcher" is asserted without creating a window (UI3A, decision file).
enum MiniOrbPanelPolicy {
    static let styleMask: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
    static let level: NSWindow.Level = .floating
    static let collectionBehavior: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    static let becomesKey = false
    static let becomesMain = false
}

/// Borderless, floating, non-activating panel that hosts the compact orb route.
/// A transparent overlay owns the whole surface: a drag moves the panel, a click
/// that did not move expands to the full window.
@MainActor
final class MiniOrbPanel: NSPanel, NSWindowDelegate {
    let webView: WKWebView
    private let frameKey: String
    private let overlay: MiniOrbHitView

    init(web: WKWebView, frameKey: String = "DidiMiniOrbFrame", onExpand: @escaping @MainActor () -> Void) {
        self.webView = web; self.frameKey = frameKey; self.overlay = MiniOrbHitView()
        super.init(contentRect: NSRect(origin: .zero, size: MiniOrbFrameRestore.size),
                   styleMask: MiniOrbPanelPolicy.styleMask, backing: .buffered, defer: false)
        isFloatingPanel = true
        level = MiniOrbPanelPolicy.level
        collectionBehavior = MiniOrbPanelPolicy.collectionBehavior
        isMovableByWindowBackground = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        overlay.onExpand = onExpand
        let container = NSView()
        container.wantsLayer = true
        container.layer?.cornerRadius = 28
        container.layer?.masksToBounds = true
        for view in [web, overlay] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
        }
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            web.topAnchor.constraint(equalTo: container.topAnchor),
            web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: container.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        contentView = container
        delegate = self
        restoreFrame()
        observeScreenChanges()
    }

    override var canBecomeKey: Bool { MiniOrbPanelPolicy.becomesKey }
    override var canBecomeMain: Bool { MiniOrbPanelPolicy.becomesMain }

    private func restoreFrame() {
        let saved = UserDefaults.standard.string(forKey: frameKey).map(NSRectFromString)
        setFrame(MiniOrbFrameRestore.resolve(saved, screens: NSScreen.screens.map(\.visibleFrame)), display: false)
    }
    /// A display that appears, sleeps or disappears re-clamps the remembered
    /// frame, so the orb is never stranded on a screen that is gone.
    private func observeScreenChanges() {
        NotificationCenter.default.addObserver(self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    @objc private func screenParametersChanged() { restoreFrame(); rememberFrame() }
    func windowDidMove(_ notification: Notification) { rememberFrame() }
    func windowDidResize(_ notification: Notification) { rememberFrame() }
    private func rememberFrame() { UserDefaults.standard.set(NSStringFromRect(frame), forKey: frameKey) }
}

/// Transparent drag-or-click surface above the web view. Deliberately captures
/// every mouse event, so the orb is not an interactive control; there is no
/// JavaScript-to-native handler.
@MainActor
final class MiniOrbHitView: NSView {
    var onExpand: (@MainActor () -> Void)?
    private var downPoint: NSPoint?
    private var dragged = false
    override func mouseDown(with event: NSEvent) { downPoint = event.locationInWindow; dragged = false }
    override func mouseDragged(with event: NSEvent) { dragged = true; window?.performDrag(with: event) }
    override func mouseUp(with event: NSEvent) {
        defer { downPoint = nil }
        guard !dragged, let start = downPoint else { return }
        let end = event.locationInWindow
        guard hypot(end.x - start.x, end.y - start.y) < 4 else { return }
        onExpand?()
    }
}
