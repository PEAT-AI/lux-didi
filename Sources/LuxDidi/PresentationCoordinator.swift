import AppKit

/// How a launch presents the app (UI3A-R1). The interactive, login-item and
/// install-relaunch launches are regular apps: a Dock tile, a Cmd-Tab entry and
/// a window that stays in front. The non-activating proof launches stay
/// accessory, so a check gains no Dock tile while it proves something else.
enum LaunchActivation: Equatable { case regular, accessory }

extension LaunchKind {
    var activation: LaunchActivation {
        switch self {
        case .interactive, .loginItem, .installRelaunch, .reopen: return .regular
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
    func presentMini(trigger: SurfaceTrigger = .other, reorder: Bool = false) -> MiniPresentOutcome {
        self.trigger = trigger
        if miniShown, pending == nil {
            guard reorder else { return .alreadyPresented }
            return commitMini()
        }
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

    /// #619: a Dock reopen shows the orb alone. The orb is ordered front even when it is already
    /// on screen, and no window is created, raised or activated.
    @discardableResult
    func presentOrbFromDock() -> MiniPresentOutcome { presentMini(trigger: .other, reorder: true) }

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
        if miniShown { mode = .mini; didCommit(mode, generation); return }
        // Nothing is on screen until an orb that can be hosted commits, so the mode names that
        // truth instead of the window that just went away.
        mode = .hidden; didCommit(mode, generation)
        _ = presentMini(trigger: .other)
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

/// #620: the two prompts that wait for the owner. A launch defers them, so a login or cold start
/// shows no grant alert and no Getting Started sheet; the first explicit open of the FULL window
/// runs each once and every decision is a content-free enum.
struct DeferredPrompts {
    enum Prompt: String, CaseIterable, Equatable {
        case grantAlert = "grant_alert"
        case gettingStarted = "getting_started"
    }
    enum Decision: String, Equatable { case deferred, shown, skipped }

    private var pending = Set(Prompt.allCases)

    /// A launch shows neither prompt and records the wait instead.
    func launchDecisions() -> [(Prompt, Decision)] { Prompt.allCases.map { ($0, .deferred) } }

    /// The owner opened the window: each pending prompt runs once, and one whose own
    /// once-a-version gate refuses is recorded as skipped, never shown.
    mutating func ownerOpenedWindow(_ show: (Prompt) -> Bool) -> [(Prompt, Decision)] {
        let due = Prompt.allCases.filter { pending.contains($0) }
        pending.subtract(due)
        return due.map { ($0, show($0) ? .shown : .skipped) }
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

/// #625: the Dock icon's right-click menu. macOS supplies Quit itself; these four items are the
/// menu bar's own actions, and Open Naya app is the one Dock interaction that opens the full
/// window, by the same activating path as the menu item.
@MainActor
final class DockMenu: NSObject {
    static let openTitle = "Open Naya app"
    static let settingsTitle = "Settings"
    static let startLiveTitle = "Start Live"
    /// The menu bar's own Mute title is state dependent, so the Dock menu says the same word.
    static func muteTitle(muted: Bool) -> String { muted ? "Unmute" : "Mute" }

    private let show: @MainActor () -> Void
    private let openSettings: @MainActor () -> Void
    private let startLive: @MainActor () -> Void
    private let mute: @MainActor () -> Void

    init(show: @escaping @MainActor () -> Void, openSettings: @escaping @MainActor () -> Void,
         startLive: @escaping @MainActor () -> Void, mute: @escaping @MainActor () -> Void) {
        self.show = show; self.openSettings = openSettings
        self.startLive = startLive; self.mute = mute
    }

    @objc func dockShow() { show() }
    @objc func dockOpenSettings() { openSettings() }
    @objc func dockStartLive() { startLive() }
    @objc func dockMute() { mute() }

    func build(muted: Bool) -> NSMenu {
        let menu = NSMenu(title: "Dock")
        func add(_ title: String, _ action: Selector) {
            menu.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        add(Self.openTitle, #selector(dockShow))
        add(Self.settingsTitle, #selector(dockOpenSettings))
        menu.addItem(.separator())
        add(Self.startLiveTitle, #selector(dockStartLive))
        add(Self.muteTitle(muted: muted), #selector(dockMute))
        return menu
    }
}

/// Keep side effects out of an unchanged polling result. The setter runs only on a transition.
enum StatusQuiet {
    static func publish<Value: Equatable>(current: Value, next: Value, set: (Value) -> Void) {
        guard current != next else { return }
        set(next)
    }
}

/// Platform-free menu status diff, so polling can be tested without an NSStatusItem.
struct QuietStatusItem {
    private var imageKey: String?
    mutating func update(symbol: String, text: String, title: String,
                         currentTitle: String, currentToolTip: String?,
                         image: (String) -> Void, setTitle: (String) -> Void,
                         toolTip: (String?) -> Void) {
        let key = symbol + ":" + text
        StatusQuiet.publish(current: imageKey, next: Optional(key)) { _ in image(key) }
        imageKey = key
        StatusQuiet.publish(current: currentTitle, next: title, set: setTitle)
        StatusQuiet.publish(current: currentToolTip, next: Optional(text), set: toolTip)
    }
}

/// Count delivery separately from opening, without logging menu contents or activating the app.
struct StatusMenuTracking {
    private(set) var requests = 0
    private(set) var opens = 0
    mutating func requested(log: (String, Int, Int) -> Void) {
        requests += 1
        log("menu_open_requested", requests, opens)
    }
    mutating func opened(log: (String, Int, Int) -> Void) {
        opens += 1
        log("menu_opened", requests, opens)
    }
}

@MainActor final class NonModalAlertResponse {
    private var completion: ((Bool) -> Void)?
    init(_ completion: @escaping (Bool) -> Void) { self.completion = completion }
    func answer(_ accepted: Bool) {
        let callback = completion
        completion = nil
        callback?(accepted)
    }
}

/// Sheets are window-modal only. Without a parent, keep the normal alert window and buttons,
/// but do not enter an application-modal run loop that disables status menus on other Spaces.
@MainActor final class StatusSafeAlert: NSObject, NSWindowDelegate {
    private static var live: [UUID: StatusSafeAlert] = [:]
    private let id = UUID()
    private let alert: NSAlert
    private let response: NonModalAlertResponse

    private init(alert: NSAlert, completion: @escaping (Bool) -> Void) {
        self.alert = alert
        response = NonModalAlertResponse(completion)
    }
    static func present(_ alert: NSAlert, parent: NSWindow?, completion: @escaping (Bool) -> Void = { _ in }) {
        let session = StatusSafeAlert(alert: alert, completion: completion)
        live[session.id] = session
        if let parent, parent.isVisible, parent.attachedSheet == nil {
            alert.beginSheetModal(for: parent) { reply in session.finish(reply == .alertFirstButtonReturn) }
        } else {
            for (index, button) in alert.buttons.enumerated() {
                button.tag = index
                button.target = session
                button.action = #selector(chose(_:))
            }
            if alert.buttons.count > 1 { alert.buttons[1].keyEquivalent = "\u{1b}" }
            alert.window.delegate = session
            alert.window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            alert.window.makeKeyAndOrderFront(nil)
        }
    }
    @objc private func chose(_ button: NSButton) {
        alert.window.orderOut(nil)
        finish(button.tag == 0)
    }
    func windowWillClose(_ notification: Notification) { finish(false) }
    private func finish(_ accepted: Bool) {
        response.answer(accepted)
        Self.live[id] = nil
    }
}

/// The watchdog must remain runnable even if the application's MainActor is blocked.
enum NativeQuitStage: String, Sendable {
    case awaitingMainActor, audio, logout, webSession, host, applicationExit, secondQuit
}

/// C-QUIT 1: the four verbs the status item always carries, with the receipt each click writes. One
/// plan, so the app's menu and the test that proves it reachable cannot drift apart.
enum StatusMenuEntry: String, CaseIterable, Sendable {
    case quit, start, stop, mute, show
    var receipt: StatusSurfaceReceipt { StatusSurfaceReceipt(event: .menuItem, facts: ["item": .word(rawValue)]) }
}

struct StatusMenuPlan: Sendable {
    struct Item: Equatable, Sendable {
        let entry: StatusMenuEntry
        let title: String
        let selector: String
        let keyEquivalent: String
    }
    /// Assignment order at the top of the menu; Quit closes it, after the app's own extras.
    static let items: [Item] = [
        Item(entry: .start, title: "Start Live", selector: "startLiveFromMenu", keyEquivalent: ""),
        Item(entry: .mute, title: "Mute", selector: "muteLiveFromMenu", keyEquivalent: ""),
        Item(entry: .stop, title: "Stop", selector: "stopLiveFromMenu", keyEquivalent: ""),
        Item(entry: .quit, title: "Quit Naya", selector: "quit", keyEquivalent: "q"),
    ]
    static func item(_ entry: StatusMenuEntry) -> Item? { items.first { $0.entry == entry } }
    /// The item carries its target and action at build time, so a click needs no activation and no
    /// lazy menu work: the same call the app makes is the call the test makes.
    @discardableResult
    static func add(_ entry: StatusMenuEntry, to menu: NSMenu, target: AnyObject?) -> NSMenuItem? {
        guard let item = item(entry) else { return nil }
        let added = menu.addItem(withTitle: item.title, action: NSSelectorFromString(item.selector),
                                 keyEquivalent: item.keyEquivalent)
        added.target = target
        return added
    }
}

/// C-QUIT 1: a status item that is always clickable. `NSStatusItem.squareLength` is a sentinel, not a
/// width, and a symbol that resolves to nil leaves a blank item, so the title carries it instead.
enum StatusItemPresentation {
    static let length: CGFloat = 24
    static let fallbackTitle = "N"
    enum Image: String, Sendable { case ok, missing = "nil", fallback }
    struct Resolved: Equatable {
        let image: NSImage?
        let title: String
        let state: Image
    }
    static func resolve(symbol: NSImage?) -> Resolved {
        guard let symbol else { return Resolved(image: nil, title: fallbackTitle, state: .fallback) }
        return Resolved(image: symbol, title: "", state: .ok)
    }
    @MainActor static func state(button: NSStatusBarButton?) -> StatusSurfaceReceipt {
        guard let button else {
            return StatusSurfaceReceipt(event: .statusItemState,
                facts: ["visible": .flag(false), "length": .number(Int(length)), "image": .word(Image.missing.rawValue),
                        "frame_on_screen": .flag(false)])
        }
        let onScreen = button.window?.isVisible == true && !button.visibleRect.isEmpty
        let image: Image = button.image != nil ? .ok : (button.title.isEmpty ? .missing : .fallback)
        return StatusSurfaceReceipt(event: .statusItemState,
            facts: ["visible": .flag(onScreen), "length": .number(Int(button.frame.width)),
                    "image": .word(image.rawValue), "frame_on_screen": .flag(onScreen)])
    }
}

/// #644: the host writes `launch_kind` only after its own host_started, so a receipt posted before the
/// ready frame never lands. This relay is the whole deferral: keep the kind until a client is bound.
struct LaunchReceiptRelay: Equatable {
    private(set) var pending: LaunchKind?
    mutating func received(_ kind: LaunchKind, hostUp: Bool) -> LaunchKind? {
        guard !hostUp else { return kind }
        pending = kind
        return nil
    }
    /// Returns the kept kind once, and only once: a second ready frame posts nothing.
    mutating func hostUp() -> LaunchKind? { defer { pending = nil }; return pending }
}

final class NativeQuitDeadline: @unchecked Sendable {
    /// The safety net only: a bounded shutdown finishes well inside this, and a wedged stage ends here.
    static let deadline: Double = 3
    static let shared = NativeQuitDeadline()
    private let clock: () -> Double
    init(clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) { self.clock = clock }
    private var startedAt: Double = 0
    private var report: (@Sendable (StatusSurfaceReceipt) -> Void)?
    private var childPID: Int32?
    var ownedChildPID: Int32? { lock.lock(); defer { lock.unlock() }; return childPID }
    func setOwnedChildPID(_ pid: Int32) { lock.lock(); defer { lock.unlock() }; childPID = pid }
    func clearOwnedChildPID(_ pid: Int32) { lock.lock(); defer { lock.unlock() }; if childPID == pid { childPID = nil } }
    private enum State { case idle, running, exiting, forced }
    private let lock = NSLock()
    private var state: State = .idle
    private var currentStage: NativeQuitStage = .awaitingMainActor

    /// Returns true only for the first request. A second request forces exit immediately.
    func request(schedule: (Double, @escaping @Sendable () -> Void) -> Void,
                 forced: @escaping @Sendable (NativeQuitStage) -> Void,
                 report: @escaping @Sendable (StatusSurfaceReceipt) -> Void = { _ in }) -> Bool {
        lock.lock()
        guard state == .idle else {
            let forceAgain = state == .running || state == .exiting
            if forceAgain { state = .forced }
            let reporter = self.report
            lock.unlock()
            if forceAgain {
                reporter?(Self.forcedReceipt(.secondQuit))
                forced(.secondQuit)
            }
            return false
        }
        state = .running
        startedAt = clock()
        self.report = report
        lock.unlock()
        report(Self.stageReceipt(.awaitingMainActor, ms: 0))
        schedule(Self.deadline) { [self] in
            lock.lock()
            guard state == .running || state == .exiting else { lock.unlock(); return }
            state = .forced
            let stage = currentStage
            let reporter = self.report
            lock.unlock()
            reporter?(Self.forcedReceipt(stage))
            forced(stage)
        }
        return true
    }
    /// Every stage transition is written with its elapsed milliseconds, so a stall names its own stage.
    func stage(_ stage: NativeQuitStage) {
        lock.lock()
        guard state == .running else { lock.unlock(); return }
        currentStage = stage
        let reporter = report
        let elapsed = Self.ms(since: startedAt, now: clock())
        lock.unlock()
        reporter?(Self.stageReceipt(stage, ms: elapsed))
    }
    func complete() -> Bool {
        lock.lock()
        guard state == .running else { lock.unlock(); return false }
        // Keep the watchdog armed through AppKit/applicationWillTerminate cleanup.
        state = .exiting
        currentStage = .applicationExit
        let reporter = report
        let elapsed = Self.ms(since: startedAt, now: clock())
        lock.unlock()
        reporter?(Self.stageReceipt(.applicationExit, ms: elapsed))
        return true
    }
    static func ms(since start: Double, now: Double) -> Int { max(0, Int(((now - start) * 1000).rounded())) }
    static func stageReceipt(_ stage: NativeQuitStage, ms: Int) -> StatusSurfaceReceipt {
        StatusSurfaceReceipt(event: .quitStage, facts: ["stage": .word(stage.rawValue), "ms": .number(ms)])
    }
    static func forcedReceipt(_ stage: NativeQuitStage) -> StatusSurfaceReceipt {
        StatusSurfaceReceipt(event: .quitForced, facts: ["stage": .word(stage.rawValue)])
    }
}
