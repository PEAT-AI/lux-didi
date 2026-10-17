import AppKit
import Combine
import SwiftUI
import Carbon
import Security
import WebKit

@MainActor final class AppModel: ObservableObject {
    @Published var draft = ""
    @Published var noteExpanded = false
    @Published var detailsExpanded = false
    @Published private var operationError: String?
    var error: String? {
        get {
            if supervisor?.state == .unavailable, supervisor?.startupFailureDiagnostic?.stage == .canonicalFile {
                return "Naya couldn’t verify its saved connection. Reconnect the service explicitly."
            }
            return operationError
        }
        set { operationError = newValue }
    }
    @Published var captureStatus: CaptureStatus = .idle
    @Published var notificationStatus: NotificationCapability = .unknown
    @Published var hotkeyStatus = "Registering…"
    @Published var shell: CompanionWeb?
    @Published private(set) var liveLimits: NativeLiveLimits?
    @Published private(set) var connections: [NativeLiveConnection] = []
    @Published private(set) var connectionsError: String?
    private var checkingConnections = false
    private let liveLogsDirectory: URL?
    /// Last Live state seen while a conversation existed, so the snapshot is not `unknown`
    /// immediately after a call tears the conversation down (#251).
    private(set) var lastLiveState: String?
    private lazy var liveJournal = NativeLiveJournal(fileURL: liveLogsDirectory?.appendingPathComponent("native-live.log"))
    @Published var connecting = false
    @Published private(set) var serviceRestarting = false
    let voice = NativeVoice()
    let bridge = NativeBridge()
    var bridgeTheme: BridgeTheme = .dark
    var trafficLightsMaxX: () -> Double = { 0 }
    @Published private(set) var live: NativeLiveConversation?
    private var orbLevels: NativeOrbLevelPublisher?
    private lazy var liveAuthorityOwner: NativeLiveAuthorityOwner<NativeLiveConversation> = NativeLiveAuthorityOwner(
        release: { conversation in
            conversation.stopCapture()
            Task { await conversation.stop() }
        },
        publish: { [weak self] conversation in
            guard let self else { return }
            if let conversation { self.live = conversation }
            else {
                if let previous = self.live { self.lastLiveState = previous.state.rawValue }
                self.live = nil
            }
        })
    @Published private(set) var pendingLiveCalls: [NativePendingLiveJob] = []
    private var liveCallDelivery = NativeLiveCallDelivery()
    @Published private(set) var liveCallsError: String?
    private var pickingUpLiveCall = false
    private var checkingLiveCalls = false
    let notifications = NativeNotifications()
    private(set) var client: CompanionClient?
    /// The one live page-session cookie, obtained once by `bootstrap()` and
    /// handed to every page view (full window and mini orb) so a second view
    /// never revokes the first session.
    private(set) var pageCookie: HTTPCookie?
    private(set) var supervisor: NativeServiceSupervisor?
    private var submittedDraft: String?
    @Published private(set) var sendingConnected = false
    private var connectedSender: NativeConnectedSend?
    private(set) var installedProof: PreparedInstalledProof?
    private(set) var bootstrapFailureCode: String?
    #if COMPANION_TEST
    func bindCredentialSupervisorForProof(_ owner: NativeServiceSupervisor) { supervisor = owner }
    #endif
    private(set) var bootstrapFailureDiagnostic: StartupFailureDiagnostic?
    init(proofRequest: InstalledProofRequest? = nil, fixtureClient: CompanionClient? = nil, fixtureOutbox: URL? = nil) {
        liveLogsDirectory = (proofRequest?.state ?? (try? InstalledRuntime.applicationState()))?.appendingPathComponent("logs", isDirectory: true)
        bridge.logFile = liveLogsDirectory?.appendingPathComponent("native-live.log")
        if let fixtureClient, let fixtureOutbox {
            client = fixtureClient; connectedSender = NativeConnectedSend(directory: fixtureOutbox)
            return
        }
        // A present but invalid installed resource is a blocker, never attach fallback.
        if let resources = Bundle.main.resourceURL {
            do {
                if let runtime = try InstalledRuntime.load(resources: resources) {
                    let prepared = try proofRequest?.prepare(installId: runtime.installId)
                    installedProof = prepared
                    let operatorSettings: OperatorSettings?
                    do {
                        if let prepared { operatorSettings = try OperatorSettings.load(directory: prepared.operatorSettingsDirectory) }
                        else { operatorSettings = try OperatorSettings.load() }
                    }
                    catch { self.error = NativeServiceError.invalidOperatorSettings.localizedDescription; return }
                    let owner = try NativeServiceSupervisor(runtime: runtime, proof: prepared, operatorSettings: operatorSettings)
                    supervisor = owner
                    owner.onRestartStatus = { [weak self, weak owner] restarting in
                        self?.serviceRestarting = restarting
                        if !restarting, owner?.isRunning == false {
                            self?.error = "Local service unavailable. Reconnect explicitly after bounded retries."
                        }
                    }
                    owner.onRecovered = { [weak self] in
                        Task { @MainActor in await self?.reconnect() }
                    }
                    owner.onUnavailable = { [weak self] in
                        self?.error = NativeServiceError.exited.localizedDescription
                        self?.shell?.clear()
                        self?.liveAuthorityOwner.unavailable()
                        self?.error = "Local service restarting. Lost Live requires an explicit Start."
                    }
                    owner.onEnd = { [weak self] reason, detail in self?.liveJournal.append(reason, detail: detail) }
                    owner.onCredentialUnavailable = { [weak self, weak owner] _ in
                        self?.shell?.clear()
                        self?.liveAuthorityOwner.unavailable()
                        self?.bootstrapFailureCode = owner?.startupFailureCode
                        self?.bootstrapFailureDiagnostic = owner?.startupFailureDiagnostic
                        self?.error = "Naya couldn’t verify its saved connection. Reconnect the service explicitly."
                    }
                    return
                }
            } catch { self.error = NativeServiceError.invalidRuntime.localizedDescription; return }
        }
        if proofRequest != nil { error = NativeServiceError.invalidRuntime.localizedDescription; return }
        do {
            let descriptor = try ServiceDescriptor.configured()
            shell = CompanionWeb(descriptor: descriptor, bridge: bridge)
            client = CompanionClient(descriptor: descriptor, credential: { try descriptor.credential() })
        } catch { self.error = CompanionError.invalidConfiguration.localizedDescription }
    }
    func refresh() async { voice.refresh(); notificationStatus = await notifications.capability() }
    func reconnect() async {
        guard !connecting else { return }
        connecting = true; defer { connecting = false }
        do {
            if let supervisor {
                let connection = try await supervisor.start()
                let descriptor = connection.descriptor
                let allowed = { () -> Bool in
                    guard supervisor.isCurrent(connection) else { return false }
                    return (try? connection.credential()) != nil
                }
                let credential = { () throws -> String in
                    return try connection.credential()
                }
                if let client {
                    await client.rebind(descriptor: descriptor, credential: credential, expectedEpoch: connection.authorityEpoch, connectionGuard: allowed)
                } else {
                    client = CompanionClient(descriptor: descriptor, credential: credential, expectedEpoch: connection.authorityEpoch, connectionGuard: allowed)
                }
                liveAuthorityOwner.rebind(connection.nonce)
                if shell?.descriptor.origin != descriptor.origin { shell = CompanionWeb(descriptor: descriptor, bridge: bridge) }
            }
            guard let client, let shell else { throw CompanionError.invalidConfiguration }
            bootstrapFailureCode = nil
            bootstrapFailureDiagnostic = nil
            let cookie = try await client.bootstrap()
            pageCookie = cookie
            await shell.load(cookie: cookie)
            await refreshLiveDetails(); error = nil
        } catch {
            bootstrapFailureCode = supervisor?.startupFailureCode ?? "bootstrap/" + ((error as? CompanionError).map { String(describing: $0) } ?? "platformFailure")
            if let diagnostic = supervisor?.startupFailureDiagnostic { bootstrapFailureDiagnostic = diagnostic }
            else {
                let category: StartupFailureDiagnostic.Category
                switch error as? CompanionError {
                case .invalidConfiguration: category = .invalidConfiguration
                case .credentialUnavailable: category = .credentialUnavailable
                case .unavailable: category = .unavailable
                case .authentication: category = .authentication
                case .invalidResponse: category = .invalidResponse
                case .rejected: category = .rejected
                case .unresolvedCapture: category = .unresolvedCapture
                case nil: category = .unknown
                }
                bootstrapFailureDiagnostic = StartupFailureDiagnostic(stage: .bootstrap, category: category, operation: .none, status: nil)
            }
            self.error = error.localizedDescription; shell?.clear()
        }
    }
    func saveDraft() async {
        guard captureStatus != .sending else { return }
        guard let client, Presentation.canSend(draft) else {
            error = CompanionError.invalidConfiguration.localizedDescription; captureStatus = .failed; return
        }
        captureStatus = .sending
        do {
            if submittedDraft != nil, client.captureStatus == .unknown || client.captureStatus == .cancelled {
                _ = try await client.retryCapture()
            } else {
                submittedDraft = draft
                _ = try await client.capture(text: draft, timeZone: TimeZone.current.identifier)
            }
            captureStatus = .saved; error = nil
            if draft == submittedDraft { draft = "" }
            submittedDraft = nil
        } catch {
            captureStatus = client.captureStatus == .idle ? .failed : client.captureStatus
            self.error = error.localizedDescription
        }
    }
    @discardableResult func sendToNaya() async -> String? {
        guard !sendingConnected, let client else { error = "Show the conversation and reconnect first."; return nil }
        sendingConnected = true; defer { sendingConnected = false }
        let submitted = draft
        do {
            if connectedSender == nil {
                connectedSender = NativeConnectedSend(directory: try InstalledRuntime.applicationState().appendingPathComponent("connected-outbox", isDirectory: true))
            }
            let sent = try await connectedSender!.send(text: submitted, client: client)
            guard self.client === client else { throw NativeConnectedSend.Failure.authority }
            if draft == sent.text { draft = "" }
            error = nil
            showConversation()
            return sent.run
        } catch { self.error = error.localizedDescription; return nil }
    }
    func showConversation() { shell?.focusConversation() }
    var livePanelVisible: Bool {
        guard let window = shell?.webView.window else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }
    func refreshLiveDetails() async {
        guard let client else { return }
        do { liveLimits = try await NativeLiveOperatorHTTP(authority: client.authenticatedRequestBuilder()).configuredLimits() }
        catch { liveLimits = nil }
        await refreshConnections()
    }
    func refreshConnections() async {
        guard livePanelVisible, !checkingConnections, let client else { return }
        checkingConnections = true; defer { checkingConnections = false }
        do { connections = try await client.liveConnections(); connectionsError = nil }
        catch { connections = []; connectionsError = "Connections unavailable. Reconnect the service to refresh." }
    }
    func refreshLiveCalls() async {
        guard !checkingLiveCalls, let client else { return }
        checkingLiveCalls = true; defer { checkingLiveCalls = false }
        do {
            let http = NativeLiveOperatorHTTP(authority: client.authenticatedRequestBuilder())
            let jobs = try await http.pendingCalls().filter(\.isReady)
            liveCallDelivery.reconcile(jobs.map(\.id))
            pendingLiveCalls = jobs.filter { liveCallDelivery.canPickUp($0.id) }
            liveCallsError = nil
            live?.offerPendingCall(pendingLiveCalls.first)
            notificationStatus = await notifications.capability()
            for job in pendingLiveCalls {
                guard liveCallDelivery.beginAttempt(job.id, permitted: notificationStatus.canSchedule) else { continue }
                let result = await notifications.submitLiveCall(jobID: job.id)
                liveCallDelivery.completeAttempt(job.id, result: result)
            }
        } catch {
            liveCallDelivery.reconcile(nil)
            pendingLiveCalls = []
            live?.offerPendingCall(nil)
            liveCallsError = "Callbacks offline. Pending calls will return when the local service reconnects."
        }
    }
    func requestNotificationPermission() async {
        _ = await notifications.requestPermission()
        notificationStatus = await notifications.capability()
        await refreshLiveCalls()
    }
    func pickUpLiveCall(_ jobID: String? = nil) {
        guard !pickingUpLiveCall, let selected = jobID ?? pendingLiveCalls.first?.id,
              let client else { return }
        pickingUpLiveCall = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.pickingUpLiveCall = false }
            do {
                let pickedUp = try await NativeLiveCallPickup.perform(validate: {
                    let jobs = try await NativeLiveOperatorHTTP(authority: client.authenticatedRequestBuilder()).pendingCalls().filter(\.isReady)
                    self.liveCallDelivery.reconcile(jobs.map(\.id))
                    self.pendingLiveCalls = jobs.filter { self.liveCallDelivery.canPickUp($0.id) }
                    self.liveCallsError = nil
                    self.live?.offerPendingCall(self.pendingLiveCalls.first)
                    return self.liveCallDelivery.canPickUp(selected)
                }, stop: {
                    self.liveCallDelivery.acknowledge(selected)
                    self.pendingLiveCalls.removeAll { $0.id == selected }
                    await self.live?.stop()
                    self.live = nil
                }, start: {
                    self.startLive(pickupJobID: selected)
                })
                if !pickedUp {
                    self.error = "This callback is no longer pending. Your current conversation was not changed."
                }
            } catch {
                self.liveCallDelivery.reconcile(nil)
                self.pendingLiveCalls = []
                self.live?.offerPendingCall(nil)
                self.liveCallsError = "Callbacks offline. Your current conversation was not changed."
                self.error = self.liveCallsError
            }
        }
    }
    func startLive(pickupJobID: String? = nil) {
        guard let client else { error = "Connect the local service before starting Live voice."; return }
        if live?.isCapturing == false { liveAuthorityOwner.clear() }
        let conversation = liveAuthorityOwner.ownerStart {
            NativeLiveConversation(authority: client.authenticatedRequestBuilder(), dictationIsCapturing: { [weak self] in
                self?.voice.state.phase == .recording
            }, pickupJobID: pickupJobID, logsDirectory: liveLogsDirectory)
        }
        conversation.start()
        orbLevels = NativeOrbLevelPublisher(device: conversation.device, bridge: bridge)
        orbLevels?.start()
    }
    func stopLive() {
        let conversation = live
        orbLevels?.stop(); orbLevels = nil
        conversation?.stopCapture()
        Task { await conversation?.stop() }
    }

    // MARK: - Native bridge (BRIDGE.md)

    func bridgeHydrate() -> BridgeHydrate {
        BridgeHydrate(consent: bridge.consent.granted, mic: Self.bridgeMic(voice.microphone),
                      live: bridgeLiveState(), route: bridgeRoute(), theme: bridgeTheme.rawValue,
                      lastSessionEndedAt: nil, trafficLightsMaxX: trafficLightsMaxX())
    }

    func bridgeLiveState() -> BridgeLiveState {
        let raw = live?.state.rawValue ?? "idle"
        return BridgeLiveState(state: BridgeLiveStateMapping.state(from: raw),
                               error: BridgeLiveStateMapping.error(from: raw), reason: nil)
    }

    func bridgeRoute() -> BridgeRoute? {
        guard let sentence = live?.device.route else { return nil }
        return BridgeRoute.parse(sentence, voiceProcessing: live?.device.isVoiceProcessingEnabledForTesting ?? false)
    }

    func publishBridgeLive() {
        bridge.pushLiveState(bridgeLiveState())
        if let route = bridgeRoute() { bridge.pushRoute(route) }
    }

    /// #311: the FULL window's mode button is a presentation switch, so the model
    /// forwards it to the app and never touches Live or audio itself.
    var onMiniMode: (() -> Void)?

    func handleBridgeCommand(_ message: BridgeInbound) {
        switch message {
        case .mini: onMiniMode?()
        case .start: startLive()
        case .stop: stopLive()
        case .mute: if live?.isMuted == false { live?.toggleMute() }
        case .unmute: if live?.isMuted == true { live?.toggleMute() }
        case .openExternal(let url): shell?.openExternal(url)
        case .ready, .consentGranted, .theme, .unknown: break
        }
    }

    private static func bridgeMic(_ state: PermissionState) -> String {
        switch state {
        case .granted: return "granted"
        case .denied: return "denied"
        case .notDetermined, .restricted, .unknown: return "undetermined"
        }
    }

    func startDictation() {
        guard live?.isCapturing != true else { error = "Stop Live voice before starting dictation."; return }
        voice.start()
    }
    func stopDictation(_ reason: String) {
        let wasRecording = voice.state.phase == .recording
        voice.stop(reason: reason)
        if wasRecording && !voice.state.transcript.isEmpty { draft = voice.state.transcript }
    }
    func stopRecording(_ reason: String) {
        stopLive()
        stopDictation(reason)
    }
    func logout() async {
        stopRecording("Logout")
        orbLevels?.stop(); orbLevels = nil
        await live?.stop(reason: .logout); liveAuthorityOwner.clear()
        await client?.revokePageSession(); shell?.clear()
    }
    func shutdown() async {
        await logout()
        await supervisor?.stop(reason: .shutdown)
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        ZStack {
            Color.black
            if let shell = model.shell {
                SharedServicePanel(shell: shell) { Task { await model.reconnect() } }
            } else {
                // Only on a failed configure, where there is no service page to show.
                VStack(spacing: 12) {
                    Text("Connect Naya").font(.title2)
                    Button("Connect") { Task { await model.reconnect() } }
                }.foregroundStyle(.white)
            }
        }
        .frame(minWidth: 780, minHeight: 620)
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    let model: AppModel
    private let proofRequest: InstalledProofRequest?
    init(proofRequest: InstalledProofRequest? = nil) {
        self.proofRequest = proofRequest; model = AppModel(proofRequest: proofRequest)
        super.init()
    }
    let hotkey = GlobalHotkey()
    let liveShortcuts = NativeShortcuts()
    private lazy var summonActions = NativeSummonActions(show: { [weak self] in self?.show() },
        isCapturing: { [weak self] in self?.model.live?.isCapturing == true },
        start: { [weak self] in self?.model.startLive() },
        mute: { [weak self] in self?.model.live?.toggleMute() },
        stop: { [weak self] in self?.model.stopLive() })
    // Menu and shortcut Start/Stop ask the web state machine, never the capture path.
    private lazy var menuBridge = NativeMenuBridge(bridge: model.bridge)
    private var miniShell: CompanionWeb?
    private var miniPanel: MiniOrbPanel?
    private var miniCookie: HTTPCookie?
    private lazy var miniOrb = MiniOrbToggle(
        startLive: { [weak self] in self?.model.startLive() },
        stopLive: { [weak self] in self?.model.stopLive() },
        liveIsRunning: { [weak self] in self?.model.live?.isCapturing == true },
        presentPanel: { [weak self] in self?.presentMiniThroughCoordinator() },
        dismissPanel: { [weak self] in self?.miniPanel?.orderOut(nil) },
        expandToWindow: { [weak self] in self?.expandThroughCoordinator() })
    /// MINI2: the Right Command tap toggles exactly like the chord. It stays off
    /// until the grant is present, and the settings view reads the state that
    /// `pushSingleKeyState` writes as `window.didiSingleKey`.
    private lazy var singleKey = SingleKeyTrigger()
    private var singleKeyMenuItem: NSMenuItem?
    private var pageReadyObservation: AnyCancellable?
    /// MINI2 review B5: the pill's level meter follows the microphone. The level
    /// is read from the live device, never written to it.
    private var pillLevelObservation: AnyCancellable?
    private var loginAvailability: LoginAvailability?
    private var liveObservation: AnyCancellable?
    private var dictationObservation: AnyCancellable?
    private var liveStateObservation: AnyCancellable?
    private var liveMenuItem: NSMenuItem?
    private var muteMenuItem: NSMenuItem?
    private var loginMenuItem: NSMenuItem?
    private var gettingStartedSheet: NSWindow?
    private(set) var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var liveCallTimer: Timer?
    private var liveCallBadge: AnyCancellable?
    private var liveCallHealth: AnyCancellable?
    private var pickupMenuItem: NSMenuItem?
    private var keyboardMonitor: Any?
    private var terminationMonitor: NSObjectProtocol?
    private var hotkeyCode: OSStatus = noErr
    private var loginLaunch = false
    private var launchKind: LaunchKind = .interactive
    private var cleanQuit = false
    private var quitting = false
    /// The one owner of the visible surface (#311). Every entry point (Dock
    /// click, hotkey, orb click, mode button, close) reports through it, so no
    /// sequence leaves two surfaces on screen.
    private(set) lazy var coordinator = PresentationCoordinator(
        showFull: { [weak self] activating in self?.presentWindow(activating: activating) },
        hideFull: { [weak self] in self?.orderOutFullWindow() },
        showMini: { [weak self] in self?.hostMiniSurface() ?? false },
        hideMini: { [weak self] in self?.dismissMiniSurface() },
        liveIsRunning: { [weak self] in self?.model.live?.isCapturing == true })
    func applicationDidFinishLaunching(_ notification: Notification) {
        loginLaunch = launchedAtLogin
        launchKind = LaunchKind.resolve(arguments: CommandLine.arguments,
            environment: ProcessInfo.processInfo.environment, loginLaunch: loginLaunch)
        OwnedWindowReadiness.trace("app:didFinishLaunching-entry",
            ["activationPolicy": NSApp.activationPolicy().rawValue, "isActive": NSApp.isActive])
        // UI3A-R1: a regular app for the interactive, login-item and install
        // relaunch kinds, accessory for the non-activating proof kinds. Set once,
        // never switched at runtime, and the launch itself never activates.
        NSApp.setActivationPolicy(launchKind.activationPolicy)
        OwnedWindowReadiness.trace("app:setActivationPolicy",
            ["activationPolicy": NSApp.activationPolicy().rawValue])
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        // One all-dark window: transparent hidden titlebar, traffic lights over the web rail.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        // UI3A: a standard window at the normal level that stays in front of a
        // normal window stack instead of vanishing when the app deactivates.
        window.level = .normal
        window.hidesOnDeactivate = false
        window.backgroundColor = BridgeTheme.dark.backgroundColor
        window.appearance = NSAppearance(named: BridgeTheme.dark.appearanceName)
        window.title = ""; window.center(); window.delegate = self
        if proofRequest == nil && !CommandLine.arguments.contains("--ui-proof") && !CommandLine.arguments.contains("--self-check") {
            let saved = UserDefaults.standard.string(forKey: "DidiWindowFrame").map(NSRectFromString)
            window.setFrame(WindowFrameRestore.resolve(saved, screens: NSScreen.screens.map(\.visibleFrame)), display: false)
            if #available(macOS 13.0, *) { loginAvailability = LoginAvailability(registration: SystemLoginRegistration()) }
        }
        window.isReleasedWhenClosed = false
        // UI3A-R7: a real File menu, so Command-W reaches the close path.
        NSApp.mainMenu = WindowMenu.build(appName: "Naya", closeTarget: window)
        window.contentView = makeRootContent()
        model.trafficLightsMaxX = { [weak self] in Double(self?.window?.standardWindowButton(.zoomButton)?.frame.maxX ?? 0) }
        model.bridge.hydrateProvider = { [weak model] in model?.bridgeHydrate() ?? .empty }
        model.bridge.onCommand = { [weak model] in model?.handleBridgeCommand($0) }
        model.onMiniMode = { [weak self] in self?.showMiniOrb() }
        model.bridge.onTheme = { [weak self] theme in self?.model.bridgeTheme = theme; self?.applyBridgeTheme(theme) }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Naya")
        let menu = NSMenu()
        menu.delegate = self
        liveMenuItem = menu.addItem(withTitle: "Naya: stopped", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Start Live", action: #selector(startLiveFromMenu), keyEquivalent: "")
        muteMenuItem = menu.addItem(withTitle: "Mute", action: #selector(muteLiveFromMenu), keyEquivalent: "")
        menu.addItem(withTitle: "Stop", action: #selector(stopLiveFromMenu), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        loginMenuItem = menu.addItem(withTitle: "Open at login", action: #selector(toggleLogin), keyEquivalent: "")
        menu.addItem(withTitle: "Getting started…", action: #selector(showGettingStarted), keyEquivalent: "")
        menu.addItem(withTitle: "Show Naya", action: #selector(show), keyEquivalent: "")
        menu.addItem(withTitle: "Show mini orb", action: #selector(toggleMiniOrb), keyEquivalent: "")
        singleKeyMenuItem = menu.addItem(withTitle: "Right Command tap", action: #selector(toggleSingleKey), keyEquivalent: "")
        singleKeyMenuItem?.state = SingleKeyTrigger.isEnabled ? .on : .off
        let pickup = NSMenuItem(title: "Pick up Naya’s call", action: #selector(pickupLiveCall), keyEquivalent: "")
        pickup.isHidden = true; pickupMenuItem = pickup; menu.addItem(pickup)
        menu.addItem(withTitle: "Reveal logs", action: #selector(revealLogs), keyEquivalent: "")
        menu.addItem(withTitle: NativeDiagnosticsAction.itemTitle, action: #selector(copyDiagnostics), keyEquivalent: "")
        menu.addItem(withTitle: "Quit Naya", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }; statusItem.menu = menu
        hotkey.onToggle = { [weak self] in self?.toggleMiniOrb() }
        hotkeyCode = hotkey.register()
        model.hotkeyStatus = hotkeyCode == noErr ? "⌃ ⌥ Space · mini orb" : "Unavailable (OSStatus \(hotkeyCode)); use the menu bar"
        liveShortcuts.onStart = { [weak self] in self?.startLiveFromMenu() }
        liveShortcuts.onMute = { [weak self] in self?.muteLiveFromMenu() }
        liveShortcuts.onWindow = { [weak self] in self?.toggle() }
        liveShortcuts.onPill = { [weak self] in self?.miniOrb.toggle() }
        liveShortcuts.register()
        // MINI2: the single key is the same toggle as the chord. The grant is
        // asked for once, on the first interactive launch only, and the chord
        // works whether or not the key does.
        singleKey.onTap = { [weak self] in self?.miniOrb.toggle() }
        SingleKeyTrigger.requestGrantIfNeeded(for: launchKind)
        singleKey.start()
        pageReadyObservation = model.$shell
            .compactMap { $0 }
            .flatMap { shell in shell.$state.map { state in (shell: shell, state: state) } }
            .sink { [weak self] pair in
                guard pair.state == .ready, self?.model.shell === pair.shell else { return }
                self?.pushSingleKeyState()
            }
        menu.addItem(withTitle: "Start Live ⌃ ⌥ ⇧ L: " + liveShortcuts.startStatus, action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Mute ⌃ ⌥ ⇧ M: " + liveShortcuts.muteStatus, action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Toggle Naya ⌃ ⌥ ⇧ Space: " + liveShortcuts.windowStatus, action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Naya pill ⌃ ⌥ Space: " + liveShortcuts.pillStatus, action: nil, keyEquivalent: "")
        // B5: the pill's five bars follow the live input level, throttled to about
        // ten pushes a second so the page is not evaluated on the audio cadence.
        pillLevelObservation = model.$live
            .flatMap { conversation -> AnyPublisher<Double, Never> in
                guard let conversation else { return Empty().eraseToAnyPublisher() }
                return conversation.device.$inputLevel
                    .map { Double($0) }
                    .throttle(for: .milliseconds(100), scheduler: RunLoop.main, latest: true)
                    .eraseToAnyPublisher()
            }
            .sink { [weak self] level in self?.pushPillLevel(level) }
        liveObservation = model.$live.sink { [weak self] conversation in
            guard let self else { return }
            liveStateObservation = conversation?.$state.sink { [weak self] state in
                guard let self else { return }
                updateLiveStatus(state: state)
                model.publishBridgeLive()
            }
            updateLiveStatus(state: conversation?.state ?? .idle)
            model.publishBridgeLive()
        }
        dictationObservation = model.voice.$state.sink { [weak self] state in
            self?.updateLiveStatus(dictationCapturing: state.phase == .recording)
        }
        model.notifications.onOpen = { [weak self] _ in self?.show() }
        model.notifications.onLiveCall = { [weak self] jobID in
            self?.show(); self?.model.pickUpLiveCall(jobID)
        }
        liveCallBadge = model.$pendingLiveCalls.sink { [weak self] jobs in
            self?.updateLiveStatus(pendingCall: !jobs.isEmpty)
            self?.pickupMenuItem?.isHidden = jobs.isEmpty
        }
        let health = NSMenuItem(title: "Callbacks offline", action: nil, keyEquivalent: "")
        health.isEnabled = false; health.isHidden = true; menu.addItem(health)
        liveCallHealth = model.$liveCallsError.sink { error in
            health.title = error ?? "Callbacks online"
            health.isHidden = error == nil
        }
        liveCallTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.model.refreshLiveCalls() }
        }
        keyboardMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == UInt16(kVK_Escape) { self?.escape(); return nil }; return event
        }
        terminationMonitor = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.model.stopRecording("Mac is going to sleep") }
        }
        Task {
            if launchKind.presentsWindowAtLaunch { show() }
            OwnedWindowReadiness.trace("app:refresh-start")
            await model.refresh()
            OwnedWindowReadiness.trace("app:refresh-end", ["isActive": NSApp.isActive])
            if proofRequest != nil { await runInstalledProof(); return }
            if CommandLine.arguments.contains("--self-check") { await selfCheck(); return }
            if let index = CommandLine.arguments.firstIndex(of: "--ui-proof"), CommandLine.arguments.count > index + 1 {
                await uiProof(path: CommandLine.arguments[index + 1]); return
            }
            await model.reconnect()
            if NativeGettingStartedOnce.consume(UserDefaults.standard) { showGettingStarted() }
        }
    }
    @objc private func revealLogs() {
        guard let directory = (proofRequest?.state ?? (try? InstalledRuntime.applicationState()))?.appendingPathComponent("logs", isDirectory: true) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            NSWorkspace.shared.open(directory)
        } catch {
            let alert = NSAlert(); alert.messageText = "Logs are unavailable."; alert.runModal()
        }
    }

    @objc private func copyDiagnostics() {
        let runtime = Bundle.main.resourceURL.flatMap { try? InstalledRuntime.load(resources: $0) } ?? nil
        let logs = (proofRequest?.state ?? (try? InstalledRuntime.applicationState()))?.appendingPathComponent("logs", isDirectory: true)
        let failure = NativeDiagnosticsSnapshot.preCreateFailure(logsDirectory: logs)
        let failureAge = failure?.at.flatMap { ISO8601DateFormatter().date(from: $0) }
            .map { NativeDiagnosticsSnapshot.ageText(since: $0, now: Date()) }
        let service: String
        if model.connecting { service = "connecting" }
        else if model.serviceRestarting { service = "restarting" }
        else if model.supervisor?.isRunning == true { service = "connected" }
        else if model.supervisor != nil { service = "stopped" }
        else { service = "unknown" }
        let action = NativeDiagnosticsAction(makeInput: {
            DiagnosticsSnapshotInput(
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                releaseCommit: runtime?.releaseCommit,
                macOSVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                serviceState: service,
                serviceOrigin: self.model.supervisor?.currentConnection?.descriptor.origin,
                liveState: self.model.live?.state.rawValue ?? self.model.lastLiveState,
                sessionLimit: self.model.liveLimits.map { NativeLiveLimits.duration($0.sessionMs) },
                idleLimit: self.model.liveLimits.map { NativeLiveLimits.duration($0.idleMs) },
                connections: self.model.connections.map { connection in
                    NativeDiagnosticsSnapshot.connectorLine(id: connection.id, state: connection.state, reasonCode: connection.reasonCode)
                },
                audioRoute: self.model.live?.device.diagnosticsRoute ?? NativeLiveAudioDevice.routeDiagnostics(),
                voiceProcessing: self.model.live?.device.isVoiceProcessingEnabled
                    ?? NativeDiagnosticsSnapshot.lastAudioVoiceProcessing(logsDirectory: logs),
                preCreateFailureClass: failure?.failureClass,
                preCreateFailureCode: failure?.code,
                preCreateFailureAge: failureAge,
                startupFailure: self.model.bootstrapFailureDiagnostic,
                capturedAt: ISO8601DateFormatter().string(from: Date()))
        }, write: { text in
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
        })
        action.copy()
    }

    /// The menu, the launch and the Dock all land on the FULL window and never
    /// leave the orb visible beside it.
    @objc func show() {
        coordinator.presentFull(activating: launchKind.activates)
    }
    /// Presents the window for the current launch kind. Only an interactive launch
    /// makes the window key and activates the app; every other launch orders the
    /// window front without taking focus.
    private func presentWindow(activating: Bool) {
        OwnedWindowReadiness.trace("app:show-entry", ["windowExists": window != nil, "activating": activating])
        if activating {
            OwnedWindowReadiness.trace("app:makeKeyAndOrderFront-before")
            window.makeKeyAndOrderFront(nil)
            OwnedWindowReadiness.trace("app:makeKeyAndOrderFront-after",
                ["isVisible": window.isVisible, "isKey": window.isKeyWindow, "isMain": window.isMainWindow])
            OwnedWindowReadiness.trace("app:activateIgnoringOtherApps-before", ["isActive": NSApp.isActive])
            NSApp.activate(ignoringOtherApps: true)
        } else {
            window.orderFront(nil)
        }
        OwnedWindowReadiness.trace("app:present-after",
            ["isVisible": window.isVisible, "isKey": window.isKeyWindow, "isMain": window.isMainWindow, "isActive": NSApp.isActive])
    }
    private var launchedAtLogin: Bool {
        NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }
    private func updateLiveStatus(state: NativeLiveConversation.State? = nil, pendingCall: Bool? = nil, dictationCapturing: Bool? = nil) {
        let liveState = state ?? model.live?.state ?? .idle
        let presentation = LiveStatusPresentation(presentation: liveState.presentation, pendingCall: pendingCall ?? !model.pendingLiveCalls.isEmpty,
            dictationCapturing: dictationCapturing ?? (model.voice.state.phase == .recording))
        statusItem.button?.image = NSImage(systemSymbolName: presentation.symbol, accessibilityDescription: presentation.text)
        statusItem.button?.title = presentation.pendingCall ? "•" : ""
        statusItem.button?.toolTip = presentation.text
        statusItem.button?.setAccessibilityLabel(presentation.text)
        liveMenuItem?.title = presentation.text
        muteMenuItem?.title = model.live?.isMuted == true ? "Unmute" : "Mute"
    }
    func menuWillOpen(_ menu: NSMenu) {
        updateLiveStatus()
        loginMenuItem?.title = loginAvailability?.text ?? "Open at login: unavailable in this launch"
        loginMenuItem?.state = loginAvailability?.status == .on ? .on : .off
        loginMenuItem?.isEnabled = loginAvailability != nil
    }
    @objc func startLiveFromMenu() { menuBridge.start() }
    @objc func muteLiveFromMenu() { summonActions.mute() }
    @objc func stopLiveFromMenu() { menuBridge.stop() }
    private var gettingStartedProofRows: [NativeGettingStartedItem]?
    @objc private func showGettingStarted() {
        show()
        guard gettingStartedSheet == nil else { return }
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 610),
            styleMask: [.titled], backing: .buffered, defer: false)
        sheet.title = "Getting started"
        sheet.isReleasedWhenClosed = false
        sheet.contentView = NSHostingView(rootView: NativeGettingStartedView(load: { [weak self] in
            guard let self else { return [] }
            if let rows = gettingStartedProofRows { return rows }
            await model.refresh()
            await model.refreshConnections()
            let login = loginAvailability.map { String(describing: $0.status) } ?? "Unavailable"
            var rows = NativeGettingStartedItems.rows(microphone: model.voice.microphone.rawValue,
                notifications: model.notificationStatus.rawValue, login: login,
                connections: model.connections.map { ($0.id, $0.state, $0.reasonCode) })
            if model.connectionsError != nil {
                rows.append(NativeGettingStartedItem(title: "Connections unavailable",
                    detail: "Refresh status after the service is ready; use Copy diagnostics if it still fails.", command: nil))
            }
            return rows
        }, microphone: { NativeGettingStartedPermissions.microphone() }, notifications: { [weak self] in
            guard let self else { return }
            if model.notificationStatus == .denied { NativeGettingStartedPermissions.notificationSettings() }
            else { Task { await self.model.requestNotificationPermission() } }
        }, login: { [weak self] in self?.toggleLogin() }, close: { [weak self] in
            guard let self, let sheet = gettingStartedSheet else { return }
            window.endSheet(sheet); gettingStartedSheet = nil
        }))
        gettingStartedSheet = sheet
        window.beginSheet(sheet)
    }
    @objc func toggleLogin() {
        guard let loginAvailability else { return }
        do { try loginAvailability.setEnabled(loginAvailability.status != .on) }
        catch { model.error = "Open at login: \(error.localizedDescription)" }
    }
    func windowDidMove(_ notification: Notification) { rememberFrame() }
    func windowDidResize(_ notification: Notification) { rememberFrame() }
    /// The dark web UI fills a plain container; the top-band drag strip is its sibling, because
    /// NSHostingView does not route mouse events to an AppKit subview added to it.
    private func makeRootContent() -> NSView {
        let container = NSView()
        let hosting = NSHostingView(rootView: RootView(model: model))
        hosting.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.topAnchor.constraint(equalTo: container.topAnchor),
            hosting.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            hosting.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        WindowDragBand.attach(to: container, afterTrafficLights: WindowDragBand.trafficLightInset(for: window))
        return container
    }
    private func applyBridgeTheme(_ theme: BridgeTheme) {
        window?.appearance = NSAppearance(named: theme.appearanceName)
        window?.backgroundColor = theme.backgroundColor
        model.shell?.applyTheme(theme)
    }
    private func rememberFrame() {
        guard proofRequest == nil, !CommandLine.arguments.contains("--ui-proof"), !CommandLine.arguments.contains("--self-check"), let window else { return }
        UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: "DidiWindowFrame")
    }
    func toggle() { coordinator.toggleWindow(activating: launchKind.activates) }
    /// Hiding the window stops dictation but never Live; Live is stopped only by
    /// an explicit action (menu, Ctrl-Opt-Shift-L, or hiding the mini orb).
    func hide() { coordinator.hideAll() }
    func escape() {
        if coordinator.mode == .mini { miniOrb.hide(); coordinator.hideMiniSurface() } else { hide() }
    }
    /// Ctrl-Opt-Space: the mini orb, and a second press brings the window back.
    @objc func toggleMiniOrb() {
        if coordinator.mode == .mini { _ = coordinator.presentFull(activating: launchKind.activates) } else { miniOrb.show() }
    }
    /// MINI2: the single key on or off. Turning it on asks for the grant again,
    /// because the owner just said yes to the key.
    @objc func toggleSingleKey() {
        let enabled = !SingleKeyTrigger.isEnabled
        SingleKeyTrigger.isEnabled = enabled
        if enabled {
            if !SingleKeyTrigger.isGranted { SingleKeyTrigger.requestGrantNow() }
            singleKey.start()
        } else {
            singleKey.stop()
        }
        singleKeyMenuItem?.state = enabled ? .on : .off
        pushSingleKeyState()
    }
    /// One level into the pill's own web view. Presentation only: the pill renders
    /// the number and never opens audio.
    private func pushPillLevel(_ level: Double) {
        guard let web = miniPanel?.webView, level.isFinite else { return }
        web.evaluateJavaScript("window.didiPillLevel && window.didiPillLevel(\(min(max(level, 0), 1)))",
                               completionHandler: nil)
    }
    /// The settings view reads this at render time: the app owns the state and the
    /// page owns the wording.
    private func pushSingleKeyState() {
        model.bridge.sendJS?("window.didiSingleKey={\"enabled\":\(SingleKeyTrigger.isEnabled),"
            + "\"granted\":\(SingleKeyTrigger.isGranted)}")
    }
    /// The FULL window's mode button (#311), and the same path the web button
    /// takes through the bridge. Presentation only: Live keeps running.
    @objc func showMiniOrb() {
        // M3-R2: presenting the pill starts the session it belongs to, the same way the
        // chord does, so the pill is never on screen with the microphone never live.
        if model.live?.isCapturing != true { model.startLive() }
        _ = coordinator.presentMini()
    }
    // The surface seam the two lazy properties share. Each step goes through a
    // method so neither lazy initializer has to mention the other.
    private func orderOutFullWindow() {
        model.stopDictation("Didi hidden")
        window?.orderOut(nil)
    }
    /// M3-R2: the one native toggle behind the orb click and the Right Command tap.
    /// P1 points both at `NativePresence.togglePresence`; until then the same three
    /// steps run through the existing bridge commands, so this is a thin call and no
    /// new audio code.
    private func applyPresenceStep(_ step: PresenceStep) {
        switch step {
        case .connect: if model.live?.isCapturing != true { model.handleBridgeCommand(.start) }
        case .hotMute: if model.live?.isMuted == false { model.handleBridgeCommand(.mute) }
        case .live: if model.live?.isMuted == true { model.handleBridgeCommand(.unmute) }
        }
        // M3-R5: muting takes the pill off the screen and unmuting brings it back.
    }

    private func hostMiniSurface() -> Bool { presentMiniPanel() }
    private func dismissMiniSurface() { miniOrb.hideSurface() }
    private func presentMiniThroughCoordinator() { _ = coordinator.presentMini() }
    private func expandThroughCoordinator() { _ = coordinator.presentFull(activating: true) }
    @discardableResult
    private func presentMiniPanel() -> Bool {
        guard let shell = miniShellForDisplay() else {
            // No page to host: the coordinator falls back to the FULL window.
            return false
        }
        let panel = miniPanel ?? MiniOrbPanel(web: shell.webView) { [weak self] step in self?.applyPresenceStep(step) }
        miniPanel = panel
        panel.orderFrontRegardless()
        if let cookie = model.pageCookie, shell.state != .ready || miniCookie != cookie {
            miniCookie = cookie
            Task { await shell.load(cookie: cookie) }
        }
        return true
    }
    /// The mini view reuses the one live page session: same service origin, same
    /// page cookie, never a second bootstrap (which would revoke the first view).
    private func miniShellForDisplay() -> CompanionWeb? {
        if let shell = miniShell, let origin = model.shell?.descriptor.origin, shell.descriptor.origin == origin { return shell }
        guard let descriptor = model.shell?.descriptor ?? (try? ServiceDescriptor.configured()) else { return nil }
        let shell = CompanionWeb(descriptor: descriptor, route: .mini)
        miniShell = shell
        miniPanel = nil
        return shell
    }
    /// UI3A-R2: Cmd+W and the close button. An active Live session switches to
    /// the mini orb and keeps running; otherwise the window hides and the app
    /// stays in the Dock.
    func windowShouldClose(_ sender: NSWindow) -> Bool { coordinator.closeFull(); return false }
    /// A Dock click always presents the FULL window and never leaves the orb
    /// beside it.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        coordinator.presentFull(activating: launchKind.activates)
        return false
    }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    private func runInstalledProof() async {
        let okay = await InstalledProofRun.execute(model: model, window: window)
        if !okay { exit(1) }
        // Existing asynchronous termination path owns actual clean native Quit.
        NSApplication.shared.terminate(self)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if cleanQuit { return .terminateNow }
        if !quitting {
            quitting = true
            model.stopRecording("Didi quit")
            // terminateLater enters a nested AppKit loop. A caller inside an
            // async MainActor job can hold that executor and starve cleanup.
            // Return first, then reissue clean termination after bounded logout.
            Task {
                await model.shutdown()
                cleanQuit = true
                sender.terminate(nil)
            }
        }
        return .terminateCancel
    }
    @objc private func pickupLiveCall() { show(); model.pickUpLiveCall() }
    func applicationWillTerminate(_ notification: Notification) {
        liveCallTimer?.invalidate(); liveCallBadge?.cancel(); liveCallHealth?.cancel()
        model.stopRecording("Didi quit"); hotkey.unregister(); liveShortcuts.unregister()
        if let keyboardMonitor { NSEvent.removeMonitor(keyboardMonitor) }
        if let terminationMonitor { NSWorkspace.shared.notificationCenter.removeObserver(terminationMonitor) }
    }
    func selfCheck() async {
        do { try await connectedSendProof() }
        catch { failProof("connected production action: " + error.localizedDescription); return }
        let result = await model.notifications.submit(ReminderEnvelope(commitmentID: "synthetic", revision: 1, title: "Synthetic", body: "Invalid date, never submitted"), at: .distantPast)
        guard case .failed = result, model.voice.state.phase == .idle,
              model.voice.preparedPlayback("Muted preparation only").volume == 0 else { failProof("safe runtime checks"); return }
        print("MAC-RUNTIME PASS pid=\(ProcessInfo.processInfo.processIdentifier) hotkey=\(hotkeyCode) notifications=\(model.notificationStatus.rawValue) microphone=\(model.voice.microphone.rawValue) speech=\(model.voice.speech.rawValue) onDevice=\(model.voice.onDevice) audioCapture=not-started playback=muted-preparation-only service=unconfigured")
        NSApp.terminate(nil)
    }
    func uiProof(path: String) async {
        model.draft = "Synthetic draft retained through close and Escape"
        guard !windowShouldClose(window), !window.isVisible else { failProof("close must retain agent"); return }
        hotkey.onToggle?()
        guard window.isVisible else { failProof("registered hotkey callback must show"); return }
        escape()
        guard !window.isVisible, model.draft.contains("retained"), !applicationShouldTerminateAfterLastWindowClosed(NSApp) else { failProof("Escape/lifecycle retention"); return }
        show()
        // UI3A-R7: the Command-W key equivalent a keystroke sends reaches the close
        // path and hides the window exactly like the traffic light.
        guard let closeItem = NSApp.mainMenu?.item(withTitle: "File")?.submenu?.items
                .first(where: { $0.action == #selector(NSWindow.performClose(_:)) }),
              closeItem.keyEquivalent == "w", closeItem.keyEquivalentModifierMask == .command,
              let keyDown = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
                  timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                  context: nil, characters: "w", charactersIgnoringModifiers: "w",
                  isARepeat: false, keyCode: UInt16(kVK_ANSI_W)),
              NSApp.mainMenu?.performKeyEquivalent(with: keyDown) == true, !window.isVisible
        else { failProof("Command-W must reach the close path"); return }
        show()
        do {
            let url = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            window.contentView?.layoutSubtreeIfNeeded()
            window.contentView?.displayIfNeeded()
            window.displayIfNeeded()
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let controls = await OwnedWindowProof.accessibility(window)
            let null = NSNull()
            var evidence: [String: Any] = ["type": "DidiNativeWindowEvidence", "schemaVersion": 1,
                "windowId": window.windowNumber, "screenCapturePermission": CGPreflightScreenCaptureAccess(),
                "accessibility": controls, "nativeChrome": null, "limitation": null, "timeoutSeconds": 4,
                "axRootProtocol": window is NSAccessibilityProtocol,
                "axRootChildren": window.accessibilityChildren()?.count ?? 0,
                "axTrace": OwnedWindowProof.accessibilityTrace(window),
                "axConsumer": await OwnedWindowProof.consumerTrace(window)]
            do { evidence["nativeChrome"] = try await OwnedWindowProof.capture(window, to: url) }
            catch {
                evidence["limitation"] = "Own-process capture unavailable (platform code \((error as NSError).code)); legacy cache artifact is NOT faithful native-chrome evidence."
                // Preserve the old PNG/lifecycle assertion, explicitly not visual proof.
                guard let view = window.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { failProof("render bitmap"); return }
                view.cacheDisplay(in: view.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { failProof("PNG encode"); return }
                try png.write(to: url)
            }
            try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]).write(to: url.appendingPathExtension("evidence.json"))
            window.setContentSize(NSSize(width: 780, height: 760))
            window.contentView?.layoutSubtreeIfNeeded()
            window.contentView?.displayIfNeeded(); window.displayIfNeeded()
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let narrowURL = url.deletingPathExtension().appendingPathExtension("780.png")
            _ = try await OwnedWindowProof.capture(window, to: narrowURL)
            gettingStartedProofRows = [NativeGettingStartedItem(title: "Synthetic UI proof", detail: "Isolated setup example; no permission or connection changes.", command: nil)] + NativeGettingStartedItems.rows(
                microphone: model.voice.microphone.rawValue, notifications: model.notificationStatus.rawValue,
                login: "Unavailable", connections: [("calendar", "missing", "credential_missing")])
            showGettingStarted()
            guard let sheet = gettingStartedSheet else { failProof("Getting started sheet missing"); return }
            sheet.contentView?.layoutSubtreeIfNeeded()
            sheet.contentView?.displayIfNeeded(); sheet.displayIfNeeded()
            try await Task.sleep(nanoseconds: 1_000_000_000)
            _ = try await OwnedWindowProof.capture(sheet, to: url.deletingPathExtension().appendingPathExtension("getting-started.png"))
            window.endSheet(sheet); gettingStartedSheet = nil; gettingStartedProofRows = nil
            print("MAC-UI PASS screenshot=\(path) close=retains-agent escape=hides draft=retained hotkeyCallback=show quit=clean-no-session voiceEffects=none notificationEffects=none")
            NSApp.terminate(nil)
        } catch { failProof("Screenshot could not be written: \(error)") }
    }
    func failProof(_ reason: String) { fputs("MAC-PROOF FAIL: \(reason)\n", stderr); exit(1) }
}

#if !COMPANION_TEST
@main enum LuxDidiApp {
    @MainActor static func main() {
        do {
            if let configure = try ConfigureRequest.parse(arguments: Array(CommandLine.arguments.dropFirst())) {
                exit(configure.run())
            }
        } catch { fputs("DIDI CONFIGURE: invalid arguments\n", stderr); exit(2) }
        let policy = NativeKeychainPolicy.establish()
        guard policy == errSecSuccess else {
            fputs("DIDI STARTUP: noninteractive credential policy unavailable (\(policy))\n", stderr); exit(2)
        }
        let proof: InstalledProofRequest?
        do { proof = try InstalledProofRequest.parse(arguments: Array(CommandLine.arguments.dropFirst())) }
        catch { fputs("INSTALLED-PROOF INVALID: unsafe or malformed arguments\n", stderr); exit(2) }
        // Every launch except the documented verification exemption yields to a live
        // instance, before a window, host or audio is built. A check that cannot open
        // its own window exits with a distinct code instead of reporting a false pass.
        let launchKind = LaunchKind.resolve(arguments: CommandLine.arguments,
            environment: ProcessInfo.processInfo.environment, loginLaunch: false)
        if SingleInstanceGuard.yieldToExistingInstance(verification: launchKind == .verification) {
            exit(launchKind.duplicateInstanceExitCodeForYield)
        }
        let app = NSApplication.shared
        let delegate = AppDelegate(proofRequest: proof); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
#endif
@MainActor final class GlobalHotkey {
    private var reference: EventHotKeyRef?
    private var handler: EventHandlerRef?
    var onToggle: (() -> Void)?
    func register() -> OSStatus {
        var specification = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            var identity = EventHotKeyID()
            guard let event, GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &identity) == noErr, identity.signature == 0x44494449, identity.id == 1 else { return OSStatus(eventNotHandledErr) }
            guard let context else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { Unmanaged<GlobalHotkey>.fromOpaque(context).takeUnretainedValue().onToggle?() }
            return noErr
        }, 1, &specification, context, &handler)
        guard installed == noErr else { return installed }
        return RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), EventHotKeyID(signature: 0x44494449, id: 1), GetApplicationEventTarget(), 0, &reference)
    }
    func unregister() { if let reference { UnregisterEventHotKey(reference) }; if let handler { RemoveEventHandler(handler) }; reference = nil; handler = nil }
    func exerciseNativeRoute() -> OSStatus {
        var event: EventRef?
        let result = CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kEventHotKeyPressed), 0, EventAttributes(0), &event)
        guard result == noErr, let event else { return result }
        defer { ReleaseEvent(event) }
        var identifier = EventHotKeyID(signature: 0x44494449, id: 1)
        let parameterResult = SetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &identifier)
        guard parameterResult == noErr else { return parameterResult }
        return SendEventToEventTarget(event, GetApplicationEventTarget())
    }
}

// Silent actual-app proof: production AppModel and CompanionClient, isolated URL transport only.
private final class ConnectedProofState: @unchecked Sendable {
    let lock = NSLock()
    let assistant = UUID().uuidString, originalEpoch = UUID().uuidString
    let originalSession = UUID().uuidString, run = UUID().uuidString
    let noteSession = UUID().uuidString, noteEntry = UUID().uuidString
    var epoch = "", session = ""
    var consent = true, loseReply = false
    var sends: [(String, String, String)] = []
    var resultReads = 0
    var notes: [String] = []
    init() { epoch = originalEpoch; session = originalSession }
}
private final class ConnectedProofTransport: URLProtocol, @unchecked Sendable {
    static let state = ConnectedProofState()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" && request.url?.port == 19997 }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let state = Self.state
        state.lock.lock(); defer { state.lock.unlock() }
        let path = request.url!.path
        // URLSession presents upload bytes as a stream to URLProtocol on macOS.
        var bodyData = request.httpBody ?? Data()
        if bodyData.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while bodyData.count < 16384 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                bodyData.append(contentsOf: buffer.prefix(count))
            }
        }
        let body = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any] ?? [:]
        var data: [String: Any] = [:]
        var status = 200
        var headers = ["Content-Type": "application/json"]
        switch path {
        case "/api/v1/status": data = ["assistantId": state.assistant, "authorityEpoch": state.epoch]
        case "/api/v1/auth/pairing": data = ["pairingCode": "synthetic"]
        case "/api/v1/auth/session": data = ["csrfToken": "synthetic-csrf"]
        case "/api/v1/auth/pair":
            data = ["csrfToken": "synthetic-csrf"]
            headers["Set-Cookie"] = "didi_session=synthetic-cookie; Path=/; HttpOnly; SameSite=Strict"
        case "/api/v1/conversation-selection": data = ["sessionId": state.session, "title": "Synthetic conversation"]
        case "/api/v1/conversations/" + state.session:
            if state.consent { data = ["state": "active", "sessionId": state.session,
                "latestRunId": state.sends.isEmpty ? NSNull() : state.run] }
            else { status = 403 }
        case "/api/v1/chat":
            guard request.httpMethod == "POST", Set(body.keys) == Set(["sessionId", "text"]),
                  request.value(forHTTPHeaderField: "Cookie") == "didi_session=synthetic-cookie",
                  request.value(forHTTPHeaderField: "X-Didi-CSRF") == "synthetic-csrf",
                  request.value(forHTTPHeaderField: "Authorization") == nil,
                  request.value(forHTTPHeaderField: "x-didi-authority-epoch") == state.epoch,
                  let key = request.value(forHTTPHeaderField: "Idempotency-Key"),
                  let session = body["sessionId"] as? String, let text = body["text"] as? String, !text.isEmpty else {
                client?.urlProtocol(self, didFailWithError: CompanionError.invalidResponse); return
            }
            state.sends.append((key, session, text))
            if state.loseReply {
                state.loseReply = false
                client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return
            }
            data = ["runId": state.run, "sessionId": session, "state": "accepted", "finalText": NSNull()]
        case "/api/v1/chat/" + state.run:
            guard request.httpMethod == "GET", let accepted = state.sends.last,
                  request.value(forHTTPHeaderField: "Cookie") == "didi_session=synthetic-cookie",
                  request.value(forHTTPHeaderField: "Authorization") == nil else {
                client?.urlProtocol(self, didFailWithError: CompanionError.invalidResponse); return
            }
            state.resultReads += 1
            let terminal = state.resultReads == 2
            data = ["runId": state.run, "sessionId": accepted.1,
                "state": terminal ? "terminal" : "accepted",
                "finalText": terminal ? "Synthetic Naya answer" : NSNull()]
        case "/api/v1/sessions": data = ["id": state.noteSession, "revision": 1]
        case "/api/v1/sessions/" + state.noteSession + "/entries":
            state.notes.append(body["text"] as? String ?? "")
            data = ["id": state.noteEntry, "sessionId": state.noteSession]
        default:
            client?.urlProtocol(self, didFailWithError: CompanionError.invalidConfiguration); return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["data": data]))
        client?.urlProtocolDidFinishLoading(self)
    }
}
@MainActor private func connectedSendProof() async throws {
    let root = URL(fileURLWithPath: "/private/tmp/wnat6-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let state = ConnectedProofTransport.state
    let descriptor = try ServiceDescriptor(origin: "http://127.0.0.1:19997", credentialService: "synthetic", credentialAccount: "synthetic")
    let client = CompanionClient(descriptor: descriptor, credential: { "synthetic-only" }, protocolClasses: [ConnectedProofTransport.self])
    _ = try await client.bootstrap()
    let model = AppModel(fixtureClient: client, fixtureOutbox: root.appendingPathComponent("outbox", isDirectory: true))
    func require(_ condition: Bool, line: Int = #line) throws {
        if !condition { throw NSError(domain: "ConnectedAppProof", code: line,
            userInfo: [NSLocalizedDescriptionKey: "Synthetic AppModel assertion failed at line \(line); model error: \(model.error ?? "none")"])
        }
    }
    state.lock.withLock { state.consent = false }
    model.draft = "Synthetic consent denied"
    await model.sendToNaya()
    try require(model.error == NativeConnectedSend.consentInstruction && state.lock.withLock { state.sends.isEmpty })
    state.lock.withLock { state.consent = true; state.loseReply = true }
    model.draft = "Synthetic pinned connected request"
    await model.sendToNaya()
    try require(model.error != nil && model.draft == "Synthetic pinned connected request")
    state.lock.withLock { state.session = UUID().uuidString }
    await model.sendToNaya()
    try require(state.lock.withLock { state.sends.count == 1 })
    state.lock.withLock { state.session = state.originalSession; state.epoch = UUID().uuidString }
    await model.sendToNaya()
    try require(state.lock.withLock { state.sends.count == 1 })
    state.lock.withLock { state.epoch = state.originalEpoch }
    model.draft = "Edited while uncertain"
    let returnedRunID = await model.sendToNaya()
    let sends = state.lock.withLock { state.sends }
    try require(model.error == nil && model.draft == "Edited while uncertain" && sends.count == 2 && sends[0].0 == sends[1].0 && sends[0].1 == state.originalSession && sends[0].2 == sends[1].2)
    try require(returnedRunID == state.run)
    // Same result-reading route used by the shared page, no native transcript.
    // The synthetic fixture advances on reads, never on a real clock.
    var terminal: [String: Any]?
    for index in 0..<2 {
        let run = try await client.connectedRead("api/v1/chat/" + returnedRunID!)
        try require(run["runId"] as? String == returnedRunID && run["sessionId"] as? String == state.originalSession)
        if index == 0 { try require(run["state"] as? String == "accepted" && run["finalText"] is NSNull) }
        if run["state"] as? String == "terminal" { terminal = run; break }
    }
    let conversation = try await client.connectedRead("api/v1/conversations/" + state.originalSession)
    try require(terminal?["runId"] as? String == returnedRunID &&
        terminal?["sessionId"] as? String == state.originalSession &&
        !(terminal?["finalText"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        conversation["sessionId"] as? String == state.originalSession &&
        conversation["latestRunId"] as? String == returnedRunID)
    model.draft = "Synthetic local note"
    await model.saveDraft()
    try require(model.captureStatus == .saved && state.lock.withLock { state.notes == ["Synthetic local note"] && state.sends.count == 2 })
    print("MAC-CONNECTED PASS production=AppModel consent=denied destination=pinned authority=fenced uncertain=same-key-and-text connected=terminal-nonempty-result resultRoute=shared-conversation-run note=local fixture=isolated")
}
