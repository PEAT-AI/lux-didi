import AppKit
import WebKit

/// Q4-R5: where a start, a stop or a mini show came from. The word is on every receipt, so a
/// session that begins by itself names its caller instead of leaving one to guess.
enum SurfaceTrigger: String, Equatable, Sendable {
    case button, hotkey, menu, orb, other
}

/// Q4-R3: what the panel reports about itself when a show lands, so `mini_presented` carries
/// facts and not only the word "presented". These are the facts that were wrong in call
/// e283ef09, where the page reported visible and un-occluded while the owner saw nothing.
struct MiniSurfaceFacts: Equatable {
    let frame: String
    let screen: String
    let alpha: Double
    let occluded: Bool
    let pageState: String
}

/// Q4-R1: the answer to a show. A page that cannot be hosted is a reason the caller logs,
/// never a silent switch to the FULL window nobody asked for.
enum MiniPresentOutcome: Equatable {
    case shown(MiniSurfaceFacts)
    case failed(String)
    case deferred
    /// ORBFIRST: the orb is already on screen, so the show did nothing at all.
    case alreadyPresented
}

/// Q4-R1: the mini page's service origin. The host connection publishes the descriptor when
/// the page is ready, and that is the only source a normal launch has: the environment file
/// serves the proof launches, which never connect. A launch-time request therefore has no page
/// (`page_not_ready`), which is why the page-ready edge asks for the surfaces again.
enum MiniOrbSurface {
    static func origin(host: String?, environment: String?) -> String? { host ?? environment }
    /// nil when the page can be hosted, else the reason the show fails loud with.
    static func failure(host: String?, environment: String?) -> String? {
        origin(host: host, environment: environment) == nil ? "page_not_ready" : nil
    }
}

/// Toggle semantics for the floating mini orb, shared by the global hotkey,
/// the Escape key and the menu bar. Pure closures, so the behaviour is proven
/// in Tests/DidiMacTests/main.swift without launching AppKit or the app.
@MainActor
final class MiniOrbToggle {
    private let startLive: @MainActor () -> Void
    private let stopLive: @MainActor () -> Void
    private let liveIsRunning: @MainActor () -> Bool
    private let presentPanel: @MainActor (SurfaceTrigger) -> MiniPresentOutcome
    private let dismissPanel: @MainActor () -> Void
    private let requestFullWindow: @MainActor () -> Void
    private let present: @MainActor (PresencePosture) -> Void
    private let receipt: @MainActor ([String: Any]) -> Void
    private(set) var isVisible = false

    init(startLive: @escaping @MainActor () -> Void, stopLive: @escaping @MainActor () -> Void,
         liveIsRunning: @escaping @MainActor () -> Bool,
         presentPanel: @escaping @MainActor (SurfaceTrigger) -> MiniPresentOutcome,
         dismissPanel: @escaping @MainActor () -> Void, requestFullWindow: @escaping @MainActor () -> Void,
         present: @escaping @MainActor (PresencePosture) -> Void = { _ in },
         receipt: @escaping @MainActor ([String: Any]) -> Void = { _ in }) {
        self.startLive = startLive; self.stopLive = stopLive; self.liveIsRunning = liveIsRunning
        self.presentPanel = presentPanel; self.dismissPanel = dismissPanel; self.requestFullWindow = requestFullWindow
        self.present = present; self.receipt = receipt
    }

    /// Presence updates visual posture; the presentation coordinator owns visibility.
    func applyPresence(_ posture: PresencePosture) {
        present(posture)
    }

    func toggle() { isVisible ? hide() : show() }


    func presentationCommitted(visible: Bool) { isVisible = visible }

    /// The chord: show the orb and start Live when it is not already running. The chord, an
    /// orb press and Start are the only starts; the menu item only moves the surface (Q4-R2).
    func show(trigger: SurfaceTrigger = .hotkey) {
        if !isVisible, !liveIsRunning() {
            startLive()
            receipt(["event": "mini_start", "trigger": trigger.rawValue])
        }
        showSurface(trigger: trigger)
    }

    /// The explicit stop: hide the orb and stop Live.
    func hide(caller: String = "chord", trigger: SurfaceTrigger = .hotkey) {
        guard isVisible else { return }
        hideSurface(caller: caller)
        stopLive()
        receipt(["event": "mini_stop", "trigger": trigger.rawValue])
    }

    /// A presentation switch that starts and stops nothing: the menu item, the mini button and
    /// the close-during-Live path only move the surface, so a running session is never
    /// restarted and an idle app never opens one. A show that cannot be hosted is not a show.
    func showSurface(trigger: SurfaceTrigger) {
        guard case .shown = presentPanel(trigger) else { return }
        isVisible = true
    }

    /// Q4-R3: every hide names its caller, so the receipt says who took the pill away and a
    /// stray hide has nowhere to hide. There is no callerless hide.
    func hideSurface(caller: String) {
        guard isVisible else { return }
        isVisible = false
        dismissPanel()
        receipt(["event": "mini_hidden", "caller": caller])
    }

    func openFullInterface() {
        guard isVisible else { return }
        requestFullWindow()
    }

}

/// Q4-R2: the status menu's "Show mini orb" item. Its action is presentation only, so pressing the
/// menu never opens a live microphone. The item is built here, next to the toggle it drives, so the
/// seam test presses the same item the status menu carries instead of a helper nothing calls.
@MainActor
final class MiniOrbMenuCommand: NSObject {
    static let title = "Show mini orb"
    private let show: @MainActor (SurfaceTrigger) -> Void

    init(show: @escaping @MainActor (SurfaceTrigger) -> Void) { self.show = show }

    /// The item the status menu adds. It carries its own target and action, so the menu's default
    /// target pass must not claim it.
    func item() -> NSMenuItem {
        let item = NSMenuItem(title: Self.title, action: #selector(press), keyEquivalent: "")
        item.target = self
        return item
    }

    @objc func press() { show(.menu) }
}

/// Native presentation stays opaque; canvas and glow own state opacity.
struct PresenceSurfaceState: Equatable {
    let visible: Bool
    let opacity: CGFloat
    let pill: Bool
    let error: Bool

    static func shown(_ posture: PresencePosture) -> PresenceSurfaceState {
        PresenceSurfaceState(visible: posture.alwaysShow, opacity: 1,
            pill: posture.state == .live, error: posture.failed)
    }
}

/// ORBFIRST: where the orb's frame is remembered. A drag is the only thing that writes it,
/// because a clamped or system-moved frame is the system's answer to a screen that changed and
/// not the owner's choice. The one-time reset retires the pre-orb-first saved frame so the new
/// top-right default is seen once.
enum MiniOrbFrameStore {
    static let key = "DidiMiniOrbFrame.orbFirst"
    static let legacyKey = "DidiMiniOrbFrame"
    static let resetKey = "DidiMiniOrbFrameReset.orbFirst"

    static func persistsFrame(userDragging: Bool) -> Bool { userDragging }

    @discardableResult
    static func resetSavedFrameOnce(_ defaults: UserDefaults) -> Bool {
        guard !defaults.bool(forKey: resetKey) else { return false }
        defaults.set(true, forKey: resetKey)
        defaults.removeObject(forKey: legacyKey)
        return true
    }
}

/// ORBFIRST: which points of the floating surface belong to the orb. The panel is square and the
/// orb is the circle inscribed in it, so the four transparent corners are not the orb's to take.
/// A point outside the circle is handed to the app below; a point on it stays a click or a drag.
enum MiniOrbClickThrough {
    static func radius(in frame: CGRect) -> CGFloat { min(frame.width, frame.height) / 2 }

    static func keepsClick(at point: CGPoint, in frame: CGRect) -> Bool {
        let center = CGPoint(x: frame.midX, y: frame.midY)
        return hypot(point.x - center.x, point.y - center.y) <= radius(in: frame)
    }
}

enum MiniOrbFrameRestore {
    /// The canonical floating orb keeps a 220-point transparent surface.
    static let size = CGSize(width: 220, height: 220)
    /// The gap between the menu bar and the top of the pill.
    static let topMargin: CGFloat = 6
    /// The gap between the orb's right edge and the screen's, so it sits under the clock.
    static let rightMargin: CGFloat = 24
    /// The default: top right, just below the menu bar clock (owner spec 2026-10-21).
    static func defaultFrame(in visible: CGRect) -> CGRect {
        let width = min(size.width, visible.width), height = min(size.height, visible.height)
        return clamp(CGRect(x: visible.maxX - width - rightMargin, y: visible.maxY - height - topMargin,
                            width: width, height: height), into: visible)
    }

    /// A remembered position wins over the default one; a remembered size never
    /// does, because the floating orb has one size. Preserve the saved origin and
    /// clamp its new rectangle into a visible screen.
    static func resolve(_ saved: CGRect?, screens: [CGRect]) -> CGRect {
        let fallback = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let primary = screens.first ?? fallback
        guard let saved, saved.width > 0, saved.height > 0 else { return defaultFrame(in: primary) }
        let screen = screens.first(where: { $0.contains(CGPoint(x: saved.midX, y: saved.midY)) })
            ?? screens.first(where: { $0.intersects(saved) }) ?? primary
        let width = min(size.width, screen.width), height = min(size.height, screen.height)
        return clamp(CGRect(x: saved.minX, y: saved.minY, width: width, height: height), into: screen)
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

/// M3-R2: one press on the orb, three steps. The orb click and the Right Command tap
/// are the same press, so both ask this one table and the app runs one toggle:
/// nothing live connects, a live orb mutes the microphone hot, a hot muted orb
/// brings the microphone back. The names match the page's own answer.
enum PresenceStep: String, Equatable {
    case connect
    case hotMute = "hot-mute"
    case live
}

/// Borderless, floating, non-activating panel that hosts the compact orb route.
/// A transparent overlay owns the whole surface: a drag moves the panel, a click
/// that did not move asks the orb what the press means.
@MainActor
final class MiniOrbPanel: NSPanel, NSWindowDelegate {
    let webView: WKWebView
    /// #1021: the owner's mute outlives the session, so the mini page is told the fact directly
    /// instead of reading it off a live state that is already gone.
    /// ORB-1023: the same push carries the presence state, so the mini orb leaves the grey
    /// connecting look the moment the machine says LIVE, whether or not Naya has spoken.
    func pushPresence(_ state: PresenceState, muted: Bool) {
        webView.evaluateJavaScript(PresencePush.js(state: state, muted: muted), completionHandler: nil)
    }
    var onVisibilityChanged: (() -> Void)?
    private let frameKey: String
    private let overlay: MiniOrbHitView
    /// ORBFIRST: a drag is the only source of a remembered frame, so the panel has to know one is
    /// in flight. The click-through follow takes the panel out of hit testing outside the circle.
    private var userDragging = false
    private var clickThroughFollow: Timer?
    private var wakeMonitor: NSObjectProtocol?
    var onReceipt: (@MainActor ([String: Any]) -> Void)?

    private let onStep: @MainActor (PresenceStep) -> Void

    init(web: WKWebView, frameKey: String = MiniOrbFrameStore.key, onStep: @escaping @MainActor (PresenceStep) -> Void,
         onExpand: @escaping @MainActor () -> Void = {},
         onReceipt: @escaping @MainActor ([String: Any]) -> Void = { _ in }) {
        self.webView = web; self.frameKey = frameKey; self.overlay = MiniOrbHitView(); self.onStep = onStep
        self.onReceipt = onReceipt
        super.init(contentRect: NSRect(origin: .zero, size: MiniOrbFrameRestore.size),
                   styleMask: MiniOrbPanelPolicy.styleMask, backing: .buffered, defer: false)
        isFloatingPanel = true
        level = MiniOrbPanelPolicy.level
        collectionBehavior = MiniOrbPanelPolicy.collectionBehavior
        isMovableByWindowBackground = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        overlay.onClick = { [weak self] in self?.press() }
        overlay.onExpand = onExpand
        let contextMenu = NSMenu()
        contextMenu.addItem(overlay.fullInterfaceItem())
        overlay.menu = contextMenu
        let container = NSView()
        container.wantsLayer = true
        container.layer?.masksToBounds = false
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
        MiniOrbFrameStore.resetSavedFrameOnce(.standard)
        restoreFrame()
        observeAppearance()
        followCursor()
    }

    override var canBecomeKey: Bool { MiniOrbPanelPolicy.becomesKey }
    override var canBecomeMain: Bool { MiniOrbPanelPolicy.becomesMain }

    private func observeAppearance() {
        NotificationCenter.default.addObserver(self, selector: #selector(activeSpaceChanged),
                                               name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        wakeMonitor = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.didWake() }
            }
    }

    /// ORBFIRST: WindowServer hands a click to the window under the cursor only when that window
    /// takes part in hit testing. Clearing `ignoresMouseEvents` outside the drawn circle takes the
    /// panel out of it, so the click reaches the app below; the flag follows the cursor at 30 Hz,
    /// which needs no Accessibility or Input Monitoring grant.
    private func followCursor() {
        let timer = Timer(timeInterval: 0.03, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateClickThrough() }
        }
        RunLoop.main.add(timer, forMode: .common)
        clickThroughFollow = timer
    }

    private func updateClickThrough() {
        guard isVisible else { ignoresMouseEvents = false; return }
        ignoresMouseEvents = !MiniOrbClickThrough.keepsClick(at: NSEvent.mouseLocation, in: frame)
    }

    func dragBegan() { userDragging = true }

    func dragEnded() {
        userDragging = false
        rememberFrameIfDragged()
    }

    private func rememberFrameIfDragged() {
        guard MiniOrbFrameStore.persistsFrame(userDragging: userDragging) else { return }
        rememberFrame()
    }

    private func restoreFrame() {
        let defaults = UserDefaults.standard
        let saved = defaults.string(forKey: frameKey).map(NSRectFromString)
        setFrame(MiniOrbFrameRestore.resolve(saved, screens: NSScreen.screens.map(\.visibleFrame)), display: false)
    }
    /// A display that appears, sleeps or disappears re-clamps the remembered
    /// frame, so the orb is never stranded on a screen that is gone.
    private func observeScreenChanges() {
        NotificationCenter.default.addObserver(self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    /// A screen change re-places the orb and writes nothing: the saved frame belongs to the owner's
    /// drag, so unplugging a display can never overwrite the position it returns to.
    @objc private func screenParametersChanged() {
        restoreFrame()
        onReceipt?(["event": "orb_screen_parameters", "screens": NSScreen.screens.count,
                    "orbScreen": orbScreenToken])
    }
    @objc private func activeSpaceChanged() { onReceipt?(["event": "orb_space_changed", "visible": isVisible]) }
    @objc private func didWake() { onReceipt?(["event": "orb_wake", "visible": isVisible, "orbScreen": orbScreenToken]) }
    func windowDidChangeOcclusionState(_ notification: Notification) {
        onReceipt?(["event": "orb_occlusion", "occluded": !occlusionState.contains(.visible),
                    "orbScreen": orbScreenToken])
        onVisibilityChanged?()
    }
    func windowDidMove(_ notification: Notification) { rememberFrameIfDragged() }
    func windowDidResize(_ notification: Notification) { rememberFrameIfDragged() }
    /// One closed token names the screen the orb sits on, never a rectangle the owner's layout owns.
    private var orbScreenToken: String {
        guard let screen = screen ?? NSScreen.main else { return "none" }
        return screen == NSScreen.screens.first ? "main" : "other"
    }
    /// Ask the page which of the three steps this press means. A page that is not ready
    /// yet still gets a press that does something: connect is the step with nothing live,
    /// and it never guesses a mute the owner did not ask for.
    private func press() {
        Task { [weak self] in
            guard let self else { return }
            let answer = try? await self.webView.evaluateJavaScript("window.didiClickStep ? window.didiClickStep() : null")
            let step = (answer as? String).flatMap(PresenceStep.init(rawValue:)) ?? .connect
            self.onStep(step)
        }
    }

    private func rememberFrame() { UserDefaults.standard.set(NSStringFromRect(frame), forKey: frameKey) }
}

/// Transparent drag-or-click surface above the web view. It captures every mouse
/// event, so the orb never takes focus; a press that did not drag is a press on
/// the orb (M3-R2).
@MainActor
final class MiniOrbHitView: NSView {
    var onClick: (@MainActor () -> Void)?
    var onExpand: (@MainActor () -> Void)?

    func fullInterfaceItem() -> NSMenuItem {
        let item = NSMenuItem(title: "Open full interface", action: #selector(openFullInterface), keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func openFullInterface() { onExpand?() }

    /// M3-R2: first mouse. The pill is a non-activating panel, so its first click
    /// must reach the orb without activating the app or its window.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var downPoint: NSPoint?
    private var dragged = false
    override func mouseDown(with event: NSEvent) { downPoint = event.locationInWindow; dragged = false }
    override func mouseDragged(with event: NSEvent) {
        dragged = true
        let panel = window as? MiniOrbPanel
        panel?.dragBegan()
        window?.performDrag(with: event)
        panel?.dragEnded()
    }
    override func mouseUp(with event: NSEvent) {
        defer { downPoint = nil }
        guard !dragged, let start = downPoint else { return }
        let end = event.locationInWindow
        guard hypot(end.x - start.x, end.y - start.y) < 4 else { return }
        onClick?()
    }
}
