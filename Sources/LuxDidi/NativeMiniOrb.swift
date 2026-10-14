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
        if isVisible { presentPanel(); return }
        isVisible = true
        if !liveIsRunning() { startLive() }
        presentPanel()
    }

    /// The explicit stop: hide the orb and stop Live.
    func hide() {
        guard isVisible else { return }
        isVisible = false
        dismissPanel()
        stopLive()
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
enum MiniOrbFrameRestore {
    static let size = CGSize(width: 300, height: 300)
    static func resolve(_ saved: CGRect?, screens: [CGRect]) -> CGRect {
        let screen = screens.first ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(size.width, screen.width), height = min(size.height, screen.height)
        if let saved, saved.width >= 120, saved.height >= 120, screens.contains(where: { $0.contains(saved) }) {
            return saved
        }
        return CGRect(x: screen.midX - width / 2, y: screen.midY - height / 2, width: width, height: height)
    }
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
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
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
    }

    override var canBecomeKey: Bool { true }

    private func restoreFrame() {
        let saved = UserDefaults.standard.string(forKey: frameKey).map(NSRectFromString)
        setFrame(MiniOrbFrameRestore.resolve(saved, screens: NSScreen.screens.map(\.visibleFrame)), display: false)
    }
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
