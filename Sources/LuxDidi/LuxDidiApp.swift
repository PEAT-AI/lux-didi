import AppKit
import Darwin
import OSLog
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
    var onShellChanged: (() -> Void)?
    @Published var shell: CompanionWeb? { didSet { onShellChanged?() } }
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
    // MARK: - Mic Mode (#352, release 3o)
    /// The Mac's Mic Mode as last read. Read and observed only: nothing here writes an audio setting,
    /// selects a mode or touches the gear.
    private(set) lazy var micMode = SystemMicMode.read()
    /// The asked version is stored in the app's defaults, because "once per app version" outlives a relaunch.
    private static let micModeShownVersionKey = "DidiMicModePromptVersion"
    private lazy var micModePrompt = MicModePrompt(
        shownVersion: { UserDefaults.standard.string(forKey: AppModel.micModeShownVersionKey) },
        setShownVersion: { version in
            if let version { UserDefaults.standard.set(version, forKey: AppModel.micModeShownVersionKey) }
            else { UserDefaults.standard.removeObject(forKey: AppModel.micModeShownVersionKey) }
        })
    private lazy var micModeObserver = MicModeObserver { [weak self] reading in
        Task { @MainActor in self?.micModeChanged(reading) }
    }
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
    @Published private(set) var alarmCaption: String?
    private var alarmShell: NativeAlarmShell?
    private(set) var client: CompanionClient? { didSet { bindAlarmShell() } }
    private func bindAlarmShell() {
        alarmShell?.stop(); alarmShell = nil
        guard let client else { return }
        let shell = NativeAlarmShell(authority: client.authenticatedRequestBuilder(), ring: connectingRing,
            onDue: { [weak self] id in
                guard let self else { return }
                if self.live?.isCapturing == true { self.alarmShell?.noteLiveSession(id) }
                else { _ = self.startLive(alarmID: id) }
            }, onCaption: { [weak self] caption in self?.alarmCaption = caption })
        alarmShell = shell; shell.start()
    }
    func stopAlarms() { alarmShell?.stop(); alarmShell = nil }
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
    func refresh() async { voice.refresh() }
    private lazy var notificationCapability = NativeNotificationCapabilityState(source: { [notifications] in
        await notifications.capability()
    })
    func refreshNotificationCapability(for event: NativeNotificationCapabilityState.Event) async {
        let next = await notificationCapability.refresh(for: event)
        StatusQuiet.publish(current: notificationStatus, next: next) { notificationStatus = $0 }
    }
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
        await refreshNotificationCapability(for: .poll)
        do {
            let http = NativeLiveOperatorHTTP(authority: client.authenticatedRequestBuilder())
            let jobs = try await http.pendingCalls().filter(\.isReady)
            liveCallDelivery.reconcile(jobs.map(\.id))
            StatusQuiet.publish(current: pendingLiveCalls, next: jobs.filter { liveCallDelivery.canPickUp($0.id) }) { pendingLiveCalls = $0 }
            StatusQuiet.publish(current: liveCallsError, next: nil) { liveCallsError = $0 }
            live?.offerPendingCall(pendingLiveCalls.first)
            for job in pendingLiveCalls {
                guard liveCallDelivery.beginAttempt(job.id, permitted: notificationStatus.canSchedule) else { continue }
                let result = await notifications.submitLiveCall(jobID: job.id)
                liveCallDelivery.completeAttempt(job.id, result: result)
            }
        } catch {
            liveCallDelivery.reconcile(nil)
            StatusQuiet.publish(current: pendingLiveCalls, next: []) { pendingLiveCalls = $0 }
            live?.offerPendingCall(nil)
            StatusQuiet.publish(current: liveCallsError, next: "Callbacks offline. Pending calls will return when the local service reconnects.") { liveCallsError = $0 }
        }
    }
    func requestNotificationPermission() async {
        _ = await notifications.requestPermission()
        await refreshNotificationCapability(for: .permissionChanged)
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
                    StatusQuiet.publish(current: self.pendingLiveCalls, next: jobs.filter { self.liveCallDelivery.canPickUp($0.id) }) { self.pendingLiveCalls = $0 }
                    StatusQuiet.publish(current: self.liveCallsError, next: nil) { self.liveCallsError = $0 }
                    self.live?.offerPendingCall(self.pendingLiveCalls.first)
                    return self.liveCallDelivery.canPickUp(selected)
                }, stop: {
                    self.liveCallDelivery.acknowledge(selected)
                    self.pendingLiveCalls.removeAll { $0.id == selected }
                    await self.live?.stop()
                    self.live = nil
                }, start: {
                    self.onPresenceStart?(selected)
                })
                if !pickedUp {
                    self.error = "This callback is no longer pending. Your current conversation was not changed."
                }
            } catch {
                self.liveCallDelivery.reconcile(nil)
                StatusQuiet.publish(current: self.pendingLiveCalls, next: []) { self.pendingLiveCalls = $0 }
                self.live?.offerPendingCall(nil)
                StatusQuiet.publish(current: self.liveCallsError, next: "Callbacks offline. Your current conversation was not changed.") { self.liveCallsError = $0 }
                self.error = self.liveCallsError
            }
        }
    }
    /// #613: the launch receipt the host records, best effort: a host that is down leaves the local line only.
    func forwardLaunchReceipt(_ kind: LaunchKind) {
        guard let client else { return }
        Task { _ = try? await client.launchReceipt(kind: kind.rawValue,
            autoConnects: kind.autoConnects, windowShown: kind.presentsWindowAtLaunch) }
    }
    /// #613: the one latch and session epoch presence and the conversation share.
    let ownerStopLatch = OwnerStopLatch()
    @discardableResult
    func startLive(pickupJobID: String? = nil, alarmID: String? = nil) -> Bool {
        guard let client else { error = "Connect the local service before starting Live voice."; return false }
        stopTrigger.clear()
        if live?.isCapturing == false { liveAuthorityOwner.clear() }
        micModeReceiptAtLiveStart()
        let conversation = liveAuthorityOwner.ownerStart {
            NativeLiveConversation(authority: client.authenticatedRequestBuilder(), dictationIsCapturing: { [weak self] in
                self?.voice.state.phase == .recording
            }, pickupJobID: pickupJobID, alarmID: alarmID, logsDirectory: liveLogsDirectory, latch: ownerStopLatch)
        }
        conversation.start()
        orbLevels = NativeOrbLevelPublisher(device: conversation.device, bridge: bridge)
        orbLevels?.start()
        return true
    }
    /// D12-5: the Stop receipt names what pressed it. A stop the app makes itself stays `other`.
    /// The status menu's item travels through the web state machine and comes back as a bridge
    /// command, so its trigger is armed here and consumed by exactly that one Stop.
    var stopTrigger = LiveStopTriggerLatch()
    func stopLive(trigger: LiveStopTrigger = .other) {
        let named = stopTrigger.take(trigger)
        let conversation = live
        orbLevels?.stop(); orbLevels = nil
        conversation?.stopCapture()
        Task { await conversation?.stop(trigger: named) }
    }

    // MARK: - Presence effects (council 2026-10-17, option C)
    /// The one fence the presence machine drives: the same coordinator fence the app's
    /// mic control has always used, now named by state instead of toggled.
    func setPresenceCaptureMuted(_ muted: Bool) { live?.setMuted(muted) }
    /// Queued model speech goes the instant the machine mutes.
    func cancelPresencePlayback() { live?.device.cancelPlayback() }
    /// The provider learns about the mute over the control channel the call already holds, so the host
    /// stops forwarding and holds any answer that arrives while the owner is silent.
    func setPresenceProviderInputMute(_ muted: Bool) { live?.setProviderInputMuted(muted) }
    /// The presence receipt: a `presence_state` record in the native log, never audio or text.
    /// The connecting ring (#529) rides the same record, so its start and stop are presence facts.
    func appendPresenceReceipt(_ record: [String: Any]) {
        if record["event"] as? String == "presence_state",
           let to = record["to"] as? String, let next = PresenceState(rawValue: to) {
            connectingRing.presenceChanged(next, failed: record["failed"] as? Bool ?? false)
        }
        liveJournal.append(record)
    }
    /// SOUND-R1: a dropped call the host is rebuilding rings the reconnect while presence stays live.
    func ringRebuildStarted() { connectingRing.rebuildStarted() }
    /// SOUND-R1: the rebuilt call is live again, so a reconnect ring ends with the arrival chime.
    func ringRebuildSettled() { connectingRing.rebuildSettled() }
    /// #589: the one descending goodbye the owner hears when her own words end the call, on the ring's
    /// own player, so it never touches the live engine or the audio slot the conversation holds.
    func playGoodbyeTone() { connectingRing.goodbye() }
    /// The gentle ring while a connection is built (#529): its `connecting_ring` record goes back
    /// through the presence receipt path above.
    private lazy var connectingRing: ConnectingRing = {
        let ring = ConnectingRing()
        ring.receipt = { [weak self] fields in self?.appendPresenceReceipt(fields) }
        return ring
    }()
    /// The surface receipts of this launch. `mini_present_failed` and `mini_presented` name the
    /// reason and the panel's own facts, so a pill that is not there leaves a trace instead of
    /// an absence; the copy in memory lets the UI proof assert the record without reading a file.
    private(set) var surfaceReceipts: [[String: Any]] = []
    func recordSurfaceReceipt(_ record: [String: Any]) {
        surfaceReceipts.append(record)
        appendPresenceReceipt(record)
    }
    /// 338: the Mac woke with no session running, so the host rebuilds its warm context once. The
    /// instruction is best effort and never blocks the wake path: a host that is down, unpaired or
    /// older than this release leaves `ok: false` and the next session start assembles as it did.
    func prewarmWarmContext() {
        guard let client else { return }
        Task { [weak self] in
            let ok = (try? await client.prewarm()) != nil
            self?.appendPresenceReceipt(["type": "presence_prewarm", "ok": ok])
        }
    }

    // MARK: - Mic Mode (#352)
    /// The observer's wiring. KVO over the two class properties, and nothing else.
    func startMicModeWatching() { micModeObserver.start() }

    /// Every change: the native log gets the names, and the full app repaints its read-only row and line.
    func micModeChanged(_ reading: MicModeReading) {
        micMode = reading
        micModePrompt.modeChanged(reading)
        liveJournal.append(reading.record)
        bridge.pushMicMode(BridgeMicMode(reading, prompt: false))
        forwardMicModeReceipt(reading)
    }

    /// Every LIVE start: the receipt in the native log and in host.log, plus at most one quiet line for the
    /// full app. It reads the mode; it never selects one.
    func micModeReceiptAtLiveStart() {
        let reading = SystemMicMode.read()
        micMode = reading
        let prompt = micModePrompt.liveStart(reading, version: appVersion)
        liveJournal.append(reading.record)
        bridge.pushMicMode(BridgeMicMode(reading, prompt: prompt))
        forwardMicModeReceipt(reading)
    }

    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    }

    var shortcutGrantVersion: String {
        guard let resources = Bundle.main.resourceURL,
              let runtime = try? InstalledRuntime.load(resources: resources) else { return appVersion }
        return runtime.releaseCommit
    }

    /// The receipt's one hop to the host, so host.log says what the Mac's Mic Mode was. Names only, best
    /// effort: a diagnostic never changes what the owner hears.
    private func forwardMicModeReceipt(_ reading: MicModeReading) {
        guard let client, let body = try? JSONSerialization.data(withJSONObject: reading.record, options: [.sortedKeys]) else { return }
        let authority = client.authenticatedRequestBuilder()
        guard var request = try? authority.request(authority.origin.appendingPathComponent("api/v1/diagnostics/client"), nil) else { return }
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        Task { _ = try? await URLSession.shared.data(for: request) }
    }

    // MARK: - Native bridge (BRIDGE.md)

    func bridgeHydrate() -> BridgeHydrate {
        BridgeHydrate(consent: bridge.consent.granted, mic: Self.bridgeMic(voice.microphone),
                      live: bridgeLiveState(), route: bridgeRoute(), theme: bridgeTheme.rawValue,
                      lastSessionEndedAt: nil, trafficLightsMaxX: trafficLightsMaxX(),
                      micMode: BridgeMicMode(micMode, prompt: false))
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
    /// Council 2026-10-17: the app's mic control asks the presence machine, so the
    /// button, Right Command and the orb click can never disagree.
    var onPresenceMute: ((Bool) -> Void)?
    var onPresenceStart: ((String?) -> Void)?
    var onPresenceStop: (() -> Void)?

    func bindPresence(_ presence: NativePresence, start: @escaping (String?) -> Void) {
        onPresenceStart = start
        onPresenceStop = { [weak presence] in presence?.stop(.app) }
        onPresenceMute = { [weak presence] muted in
            if muted { presence?.mute(.app) } else { presence?.unmute(.app) }
        }
    }

    func handleBridgeCommand(_ message: BridgeInbound) {
        switch message {
        case .mini: onMiniMode?()
        case .start: onPresenceStart?(nil)
        case .stop: onPresenceStop?()
        case .mute: onPresenceMute?(true)
        case .unmute: onPresenceMute?(false)
        case .openExternal(let url): shell?.openExternal(url)
        case .showMicrophoneModes: SystemMicMode.showPicker()
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
        // A programmatic stop (logout, dictation hand-off, window close) keeps the `other` trigger.
        stopLive()
        stopDictation(reason)
    }
    func logout() async {
        stopRecording("Logout")
        orbLevels?.stop(); orbLevels = nil
        await live?.stop(reason: .logout); liveAuthorityOwner.clear()
        await client?.revokePageSession(); shell?.clear()
    }
    func shutdown(stage: (NativeQuitStage) -> Void = { _ in }) async {
        stage(.audio)
        stopVoiceForQuit()
        // Start host EOF/drain independently of page logout, which may never answer.
        let stopHost = Task { await supervisor?.stop(reason: .shutdown) }
        stage(.logout)
        await client?.revokePageSession()
        stage(.webSession)
        shell?.clear()
        liveAuthorityOwner.clear()
        stage(.host)
        await stopHost.value
    }

    /// Quit ends the call with its own reason: capture stops at once, the journal names app_quit, and the
    /// session is left for the host to name app_quit when the supervisor stops it. A Quit is never a Stop.
    func stopVoiceForQuit() {
        if let conversation = live {
            conversation.stopCapture()
            liveJournal.append(.appQuit)
            live = nil
        }
        stopDictation("Quit")
        orbLevels?.stop(); orbLevels = nil
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
        start: { [weak self] in self?.startPresence() },
        mute: { [weak self] in self?.presence.mute(.app) },
        stop: { [weak self] in self?.model.stopTrigger.arm(.hotkey); self?.presence.stop(.hotkey) })
    // Menu and shortcut Start/Stop ask the web state machine, never the capture path.
    private lazy var menuBridge = NativeMenuBridge(bridge: model.bridge)
    /// Q4-R2: the status menu's "Show mini orb" is presentation only.
    private lazy var miniOrbMenu = MiniOrbMenuCommand { [weak self] trigger in self?.miniOrb.showSurface(trigger: trigger) }
    private var miniShell: CompanionWeb?
    private var miniPanel: MiniOrbPanel?
    private var miniCookie: HTTPCookie?
    private lazy var miniPageObservation = CompanionPageObservation(current: { [weak self] in self?.miniShell },
        changed: { [weak self] _ in self?.syncPresentedSurface() })
    private var presentationTask: Task<Void, Never>?
    private lazy var miniOrb = MiniOrbToggle(
        startLive: { [weak self] in self?.startPresence() },
        stopLive: { [weak self] in self?.stopPresence() },
        liveIsRunning: { [weak self] in self?.model.live?.isCapturing == true },
        presentPanel: { [weak self] trigger in self?.presentMiniThroughCoordinator(trigger: trigger) ?? .failed("no_app") },
        dismissPanel: { [weak self] in self?.miniPanel?.orderOut(nil) },
        requestFullWindow: { [weak self] in self?.expandThroughCoordinator() },
        present: { [weak self] posture in self?.applyPresenceSurface(PresenceSurfaceState.shown(posture)) },
        receipt: { [weak self] record in self?.model.recordSurfaceReceipt(record) })
    /// Council 2026-10-17 (option C, `council-presence-1017.md`): one state machine
    /// behind Right Command, a click on the mini orb and the app's mic control. The
    /// coordinator's mute fence, the device's playback cancel and the provider's
    /// input mute are effects of the same transitions.
    private lazy var presence = NativePresence(effects: PresenceEffects(
        openSession: { [weak self] generation in self?.openPresenceSession(generation) },
        cancelConnecting: { [weak self] in self?.model.stopLive(trigger: .button) },
        closeSession: { [weak self] in self?.model.stopLive(trigger: .button) },
        setCaptureMuted: { [weak self] muted in self?.model.setPresenceCaptureMuted(muted) },
        cancelPlayback: { [weak self] in self?.model.cancelPresencePlayback() },
        providerInputMute: { [weak self] muted in self?.model.setPresenceProviderInputMute(muted) },
        receipt: { [weak self] record in self?.model.appendPresenceReceipt(record) },
        goodbyeTone: { [weak self] in self?.model.playGoodbyeTone() },
        surface: { [weak self] posture in self?.miniOrb.applyPresence(posture) },
        prewarm: { [weak self] in self?.model.prewarmWarmContext() }),
        latch: model.ownerStopLatch)
    private var presencePickupJobID: String?
    /// The presence generation the conversation now on the wire was opened under, so a
    /// callback from any other conversation is stale by construction.
    private var liveGeneration: UInt64 = 0
    /// ORBFIRST: the launch makes one auto-connect attempt, and the menu's Settings item hands the
    /// window a route to open once its page is ready.
    private var autoConnectAttempted = false
    private var pendingFullRoute: String?
    private var presenceMenuItem: NSMenuItem?
    /// MINI2, Q2: the Right Command key taps to start and stop and holds to talk. It stays
    /// off until the grant is present, and the settings view reads the state that
    /// `pushSingleKeyState` writes as `window.didiSingleKey`.
    private lazy var singleKey = SingleKeyTrigger()
    private var singleKeyMenuItem: NSMenuItem?
    private lazy var fullPageObservation = CompanionPageObservation(current: { [weak self] in self?.model.shell },
        changed: { [weak self] shell in
            guard let self else { return }
            if shell.state == .ready {
                pushSingleKeyState()
                presence.setSurfaces()
            }
            syncPresentedSurface()
        })
    private var loginAvailability: LoginAvailability?
    private var liveObservation: AnyCancellable?
    private var dictationObservation: AnyCancellable?
    private var liveStateObservation: AnyCancellable?
    private var liveMenuItem: NSMenuItem?
    private var muteMenuItem: NSMenuItem?
    private var loginMenuItem: NSMenuItem?
    private var gettingStartedSheet: NSWindow?
    /// #620: the grant alert and the Getting Started sheet wait for the owner to open the window.
    private var deferredPrompts = DeferredPrompts()
    private(set) var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var liveCallTimer: Timer?
    private var liveCallBadge: AnyCancellable?
    private var liveCallHealth: AnyCancellable?
    private var alarmObservation: AnyCancellable?
    private var pickupMenuItem: NSMenuItem?
    private var singleKeyGrantItem: NSMenuItem?
    private var singleKeyGrantTimer: Timer?
    private var singleKeyGrantMonitor: NSObjectProtocol?
    private var keyboardMonitor: Any?
    private var statusClickMonitor: Any?
    private var menuTracking = StatusMenuTracking()
    private let menuLogger = Logger(subsystem: "LuxDidi", category: "menu")
    private var terminationMonitor: NSObjectProtocol?
    /// 338: the wake observer, paired with the sleep one above so the warm context is refreshed
    /// exactly when the Mac comes back and no session is running.
    private var wakeMonitor: NSObjectProtocol?
    private var hotkeyCode: OSStatus = noErr
    private var loginLaunch = false
    private var launchKind: LaunchKind = .interactive
    private var cleanQuit = false
    private let quitDeadline = NativeQuitDeadline.shared
    /// The one owner of the visible surface (#311). Every entry point (Dock
    /// click, hotkey, orb click, mode button, close) reports through it, so no
    /// sequence leaves two surfaces on screen.
    private(set) lazy var coordinator = PresentationCoordinator(
        showFull: { [weak self] activating in self?.presentWindow(activating: activating) },
        hideFull: { [weak self] in self?.orderOutFullWindow() },
        showMini: { [weak self] _ in self?.presentMiniPanel() ?? .failed("no_app") },
        hideMini: { [weak self] caller in self?.miniOrb.hideSurface(caller: caller) },
        liveIsRunning: { [weak self] in self?.model.live?.isCapturing == true },
        log: { [weak self] record in self?.model.recordSurfaceReceipt(record) },
        prepare: { [weak self] target, generation in self?.preparePresentation(target, generation: generation) },
        didCommit: { [weak self] mode, _ in self?.presentationCommitted(mode) },
        requestChanged: { [weak self] in self?.cancelPresentationPreparation() })
    /// #625: the Dock icon's menu reuses the menu bar's own actions; Open Naya app is the same
    /// selector the menu item sends, so the Dock opens the window by that one path.
    private(set) lazy var dockMenu = DockMenu(
        show: { [weak self] in self?.show() },
        openSettings: { [weak self] in self?.openSettingsFromMenu() },
        startLive: { [weak self] in self?.startLiveFromMenu() },
        mute: { [weak self] in self?.muteLiveFromMenu() })
    /// ORBFIRST: the app window is built the first time the owner opens it, so a launch that shows
    /// only the orb builds the web host and no window at all.
    @discardableResult
    private func ensureFullWindow() -> NSWindow {
        if let window { return window }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
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
        }
        window.isReleasedWhenClosed = false
        window.contentView = makeRootContent()
        self.window = window
        model.trafficLightsMaxX = { [weak self] in Double(self?.window?.standardWindowButton(.zoomButton)?.frame.maxX ?? 0) }
        return window
    }

    private func establishLoginAvailability() {
        if #available(macOS 13.0, *), loginAvailability == nil {
            loginAvailability = LoginAvailability(registration: SystemLoginRegistration())
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { await model.refreshNotificationCapability(for: .didBecomeActive) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        loginLaunch = launchedAtLogin
        launchKind = LaunchKind.resolve(arguments: CommandLine.arguments,
            environment: ProcessInfo.processInfo.environment, loginLaunch: loginLaunch)
        model.appendPresenceReceipt(launchKind.launchRecord)
        // #613: the same fields reach the host, so host.log carries the launch kind too.
        model.forwardLaunchReceipt(launchKind)
        recordPrompts(deferredPrompts.launchDecisions())
        OwnedWindowReadiness.trace("app:didFinishLaunching-entry",
            ["activationPolicy": NSApp.activationPolicy().rawValue, "isActive": NSApp.isActive])
        // UI3A-R1: a regular app for the interactive, login-item and install
        // relaunch kinds, accessory for the non-activating proof kinds. Set once,
        // never switched at runtime, and the launch itself never activates.
        NSApp.setActivationPolicy(launchKind.activationPolicy)
        OwnedWindowReadiness.trace("app:setActivationPolicy",
            ["activationPolicy": NSApp.activationPolicy().rawValue])
        // ORBFIRST: the window exists only where a launch needs one. An interactive or login
        // launch shows the orb and creates the window the first time the owner opens the app.
        if launchKind.createsWindowAtLaunch { ensureFullWindow() } else { establishLoginAvailability() }
        // UI3A-R7: a real File menu, so Command-W reaches the close path.
        NSApp.mainMenu = WindowMenu.build(appName: "Naya", closeTarget: window)
        model.bridge.hydrateProvider = { [weak model] in model?.bridgeHydrate() ?? .empty }
        model.bridge.onCommand = { [weak model] in model?.handleBridgeCommand($0) }
        // #352: the Mic Mode observer is KVO over two class properties. It reads; it never sets a mode.
        model.startMicModeWatching()
        model.onMiniMode = { [weak self] in self?.showMiniOrb() }
        model.bindPresence(presence, start: { [weak self] job in self?.startPresence(pickupJobID: job) })
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
        menu.addItem(withTitle: "Open Naya app", action: #selector(show), keyEquivalent: "")
        menu.addItem(withTitle: "Settings", action: #selector(openSettingsFromMenu), keyEquivalent: "")
        singleKeyMenuItem = menu.addItem(withTitle: "Right Command tap", action: #selector(toggleSingleKey), keyEquivalent: "")
        singleKeyMenuItem?.state = SingleKeyTrigger.isEnabled ? .on : .off
        // #3p: the one line that says why a silent key is silent, in the status menu the
        // owner already opens, with a button to the pane that fixes it. Hidden while the
        // grant is there, and no window of its own.
        singleKeyGrantItem = menu.addItem(withTitle: "", action: #selector(openInputMonitoringSettings), keyEquivalent: "")
        singleKeyGrantItem?.isHidden = true
        let pickup = NSMenuItem(title: "Pick up Naya’s call", action: #selector(pickupLiveCall), keyEquivalent: "")
        pickup.isHidden = true; pickupMenuItem = pickup; menu.addItem(pickup)
        menu.addItem(withTitle: "Reveal logs", action: #selector(revealLogs), keyEquivalent: "")
        menu.addItem(withTitle: NativeDiagnosticsAction.itemTitle, action: #selector(copyDiagnostics), keyEquivalent: "")
        menu.addItem(withTitle: "Quit Naya", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        // Q4-R2: "Show mini orb" is presentation only and carries its own target, so it joins the
        // menu after the default target pass. A menu item never opens a live microphone.
        menu.addItem(miniOrbMenu.item())
        statusItem.menu = menu
        statusClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            MainActor.assumeIsolated {
                if let self, let button = self.statusItem.button, event.window === button.window,
                   button.bounds.contains(button.convert(event.locationInWindow, from: nil)) {
                    self.menuTracking.requested { event, requests, opens in
                        self.menuLogger.info("\(event, privacy: .public) requested=\(requests) opened=\(opens)")
                    }
                }
            }
            return event
        }
        hotkey.onToggle = { [weak self] in self?.toggleMiniOrb() }
        hotkeyCode = hotkey.register()
        model.hotkeyStatus = hotkeyCode == noErr ? "⌃ ⌥ Space · Naya window" : "Unavailable (OSStatus \(hotkeyCode)); use the menu bar"
        liveShortcuts.onStart = { [weak self] in self?.startLiveFromMenu() }
        liveShortcuts.onMute = { [weak self] in self?.muteLiveFromMenu() }
        liveShortcuts.onWindow = { [weak self] in self?.toggle() }
        liveShortcuts.onPill = { [weak self] in self?.miniOrb.toggle() }
        liveShortcuts.register()
        // Council 2026-10-17: "Always show Naya" is the only switch over the presence orb.
        presenceMenuItem = menu.addItem(withTitle: "Always show Naya", action: #selector(toggleAlwaysShowNaya), keyEquivalent: "")
        presenceMenuItem?.state = presence.alwaysShow ? .on : .off
        // The orb is there from app start, grey and silent, and it never takes focus.
        presence.setSurfaces()
        // MINI2, Q2: the single key taps to start and stop and holds to talk. The grant
        // is asked for once per app version (#3p: an ad-hoc install can lose it), on an
        // interactive launch only, and the chord works whether or not the key does.
        // Every launch then leaves a receipt, so a key that never fires is visible.
        bindRightCommandKey(singleKey, to: presence, present: { [weak self] in self?.presentShortcutMini() })
        singleKey.presenceState = { [weak presence] in presence?.state ?? .cold }
        singleKey.onReceipt = { [weak self] record in self?.model.appendPresenceReceipt(record) }
        // #620: the grant alert waits for the owner to open the full window, so a launch that
        // shows only the orb asks nothing.
        singleKey.start()
        syncSingleKeyGrantWatch()
        model.onShellChanged = { [weak self] in
            guard let self else { return }
            fullPageObservation.bind(model.shell)
            if model.shell == nil { syncPresentedSurface() }
        }
        fullPageObservation.bind(model.shell)
        menu.addItem(withTitle: "Start Live ⌃ ⌥ ⇧ L: " + liveShortcuts.startStatus, action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Mute ⌃ ⌥ ⇧ M: " + liveShortcuts.muteStatus, action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Toggle Naya ⌃ ⌥ ⇧ Space: " + liveShortcuts.windowStatus, action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Naya pill ⌃ ⌥ Space: " + liveShortcuts.pillStatus, action: nil, keyEquivalent: "")
        liveObservation = model.$live.sink { [weak self] conversation in
            guard let self else { return }
            let generation = self.liveGeneration
            liveStateObservation = conversation?.$state.sink { [weak self] state in
                guard let self else { return }
                updateLiveStatus(state: state)
                model.publishBridgeLive()
                presenceTransitioned(state, generation: generation)
            }
            updateLiveStatus(state: conversation?.state ?? .idle)
            model.publishBridgeLive()
            presenceTransitioned(conversation?.state ?? .idle, generation: generation)
        }
        dictationObservation = model.voice.$state.sink { [weak self] state in
            self?.updateLiveStatus(dictationCapturing: state.phase == .recording)
        }
        model.notifications.onOpen = { [weak self] _ in self?.show() }
        model.notifications.onLiveCall = { [weak self] jobID in
            self?.show(); self?.model.pickUpLiveCall(jobID)
        }
        alarmObservation = model.$alarmCaption.sink { [weak self] caption in
            guard let self else { return }
            self.statusItem.button?.title = AlarmShellPolicy.menuTitle(alarmCaption: caption, pendingCall: !self.model.pendingLiveCalls.isEmpty)
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
            Task { @MainActor in
                // Council 2026-10-17: sleep is a hard teardown of the presence session,
                // and wake never reconnects on its own.
                self?.presence.sleep()
                self?.model.stopRecording("Mac is going to sleep")
            }
        }
        wakeMonitor = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                // 338: only the idle states prewarm; a wake during a live call belongs to that call.
                self?.presence.wake()
            }
        }
        Task {
            if launchKind.presentsOrbAtLaunch { _ = coordinator.presentMini(trigger: .other) }
            if launchKind.presentsWindowAtLaunch { coordinator.presentFull(activating: launchKind.activates) }
            await model.refreshNotificationCapability(for: .launch)
            OwnedWindowReadiness.trace("app:refresh-start")
            await model.refresh()
            OwnedWindowReadiness.trace("app:refresh-end", ["isActive": NSApp.isActive])
            if proofRequest != nil { await runInstalledProof(); return }
            if CommandLine.arguments.contains("--self-check") { await selfCheck(); return }
            if let index = CommandLine.arguments.firstIndex(of: "--ui-proof"), CommandLine.arguments.count > index + 1 {
                await uiProof(path: CommandLine.arguments[index + 1]); return
            }
            await model.reconnect()
            // The orb page is hostable only once the host is connected, so the launch show is
            // retried here and the auto-connect waits for the same two facts.
            if launchKind.presentsOrbAtLaunch, !coordinator.miniShown { _ = coordinator.presentMini(trigger: .other) }
            autoConnectIfReady()
        }
    }
    @objc private func revealLogs() {
        guard let directory = (proofRequest?.state ?? (try? InstalledRuntime.applicationState()))?.appendingPathComponent("logs", isDirectory: true) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            NSWorkspace.shared.open(directory)
        } catch {
            let alert = NSAlert(); alert.messageText = "Logs are unavailable."
            alert.addButton(withTitle: "OK")
            StatusSafeAlert.present(alert, parent: window)
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
        coordinator.presentFull(activating: true)
    }
    /// ORBFIRST: an interactive launch connects by itself, once, and only after the host is
    /// connected and the orb page is hostable. A denied microphone or a refused audio owner is
    /// final for the launch: the orb shows its error look and nothing retries.
    private func autoConnectIfReady() {
        let pageHostable = coordinator.miniShown || miniShell?.state == .ready
        switch OrbFirstAutoConnect.decide(kind: launchKind, serviceReady: model.shell != nil,
                                          pageHostable: pageHostable, attempted: autoConnectAttempted) {
        case .connect:
            autoConnectAttempted = true
            Task { [weak self] in
                guard let self else { return }
                // #613: the calendar connector publishes a moment after the host is up, so this launch
                // waits a bounded four seconds for it and starts the call either way.
                _ = await OrbFirstAutoConnect.waitForCalendar(
                    published: { await self.calendarPublished() },
                    sleep: { ms in try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) })
                self.startPresence()
            }
        case .wait, .never:
            break
        }
    }

    /// #613: the calendar connector is published when the host's tools status names it ready.
    private func calendarPublished() async -> Bool {
        guard let client = model.client,
              let value = try? await client.connectedRead("api/v1/tools/status"),
              let endpoints = value["endpoints"] as? [[String: Any]] else { return false }
        return endpoints.contains {
            $0["connector"] as? String == "calendar" && $0["state"] as? String == "ready"
        }
    }

    /// ORBFIRST: the app window is created on demand, so presenting it may be the first time it
    /// exists. Only an interactive launch makes the window key and activates the app.
    private func presentWindow(activating: Bool) {
        _ = ensureFullWindow()
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
        // #620: only the owner's own open runs the prompts a launch deferred.
        if activating { showDeferredPrompts() }
    }
    private var launchedAtLogin: Bool {
        NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }
    private var statusImages: [String: NSImage] = [:]
    private var quietStatusItem = QuietStatusItem()
    private func updateLiveStatus(state: NativeLiveConversation.State? = nil, pendingCall: Bool? = nil, dictationCapturing: Bool? = nil) {
        let liveState = state ?? model.live?.state ?? .idle
        let presentation = LiveStatusPresentation(presentation: liveState.presentation, pendingCall: pendingCall ?? !model.pendingLiveCalls.isEmpty,
            dictationCapturing: dictationCapturing ?? (model.voice.state.phase == .recording))
        if let button = statusItem.button {
            quietStatusItem.update(symbol: presentation.symbol, text: presentation.text,
                title: AlarmShellPolicy.menuTitle(alarmCaption: model.alarmCaption, pendingCall: presentation.pendingCall),
                currentTitle: button.title, currentToolTip: button.toolTip,
                image: { key in
                    if statusImages[key] == nil {
                        statusImages[key] = NSImage(systemSymbolName: presentation.symbol, accessibilityDescription: presentation.text)
                    }
                    button.image = statusImages[key]
                }, setTitle: { button.title = $0 }, toolTip: {
                    button.toolTip = $0
                    button.setAccessibilityLabel($0)
                })
        }
        liveMenuItem?.title = presentation.text
        muteMenuItem?.title = model.live?.isMuted == true ? "Unmute" : "Mute"
    }
    func menuWillOpen(_ menu: NSMenu) {
        updateLiveStatus()
        loginMenuItem?.title = loginAvailability?.text ?? "Open at login: unavailable in this launch"
        loginMenuItem?.state = loginAvailability?.status == .on ? .on : .off
        loginMenuItem?.isEnabled = loginAvailability != nil
        // Never query TCC, install event taps or run modal work inside menu tracking.
        // Activation and the existing grant timer refresh the cached grant notice instead.
        menuTracking.opened { event, requests, opens in
            menuLogger.info("\(event, privacy: .public) requested=\(requests) opened=\(opens)")
        }
    }
    /// #3p, R2: the notice's button. The owner's one explicit click asks for the Input
    /// Monitoring grant, which puts Naya in that list by itself, and opens the pane so the
    /// owner only flips a toggle.
    @objc private func openInputMonitoringSettings() {
        if !SingleKeyTrigger.currentGrants().any { SingleKeyTrigger.requestListenEventAccess() }
        if let url = URL(string: SingleKeyTrigger.grantSettingsURL) { NSWorkspace.shared.open(url) }
    }
    /// #1021: the line while the key cannot work, nothing once the tap is live, and the
    /// one-shot grant prompt never decides this.
    private func refreshAccessibilityNotice() {
        guard let title = SingleKeyTrigger.grantNoticeTitle(enabled: SingleKeyTrigger.isEnabled,
                                                           tapped: singleKey.tapCreated) else {
            singleKeyGrantItem?.isHidden = true
            return
        }
        singleKeyGrantItem?.title = title
        singleKeyGrantItem?.isHidden = false
    }
    /// #1021: a grant can arrive without a relaunch, so the key re-checks on activation and
    /// on a slow timer while it has no tap. Nothing here prompts; the polling stops the
    /// moment the tap is live.
    private func syncSingleKeyGrantWatch() {
        let plan = SingleKeyTrigger.grantWatchPlan(enabled: SingleKeyTrigger.isEnabled,
                                                  tapped: singleKey.tapCreated)
        guard plan.onActivation, let interval = plan.pollInterval else { stopSingleKeyGrantWatch(); return }
        guard singleKeyGrantTimer == nil else { return }
        singleKeyGrantTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.scheduleSingleKeyGrantRecheck() }
        }
        singleKeyGrantMonitor = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.scheduleSingleKeyGrantRecheck() }
        }
    }
    private func stopSingleKeyGrantWatch() {
        singleKeyGrantTimer?.invalidate()
        singleKeyGrantTimer = nil
        if let monitor = singleKeyGrantMonitor { NotificationCenter.default.removeObserver(monitor) }
        singleKeyGrantMonitor = nil
    }
    /// The tap goes in the moment the grant is there, one receipt says so, and the line that
    /// said the key was off goes with it.
    private var singleKeyRecheckScheduled = false
    private func scheduleSingleKeyGrantRecheck() {
        guard !singleKeyRecheckScheduled else { return }
        singleKeyRecheckScheduled = true
        RunLoop.main.perform(inModes: [.default]) { [weak self] in
            MainActor.assumeIsolated {
                self?.singleKeyRecheckScheduled = false
                self?.recheckSingleKeyGrant()
            }
        }
    }
    private func recheckSingleKeyGrant() {
        let wasTapped = singleKey.tapCreated
        singleKey.start()
        refreshAccessibilityNotice()
        guard singleKey.tapCreated != wasTapped else { return }
        singleKeyMenuItem?.state = SingleKeyTrigger.isEnabled ? .on : .off
        pushSingleKeyState()
        syncSingleKeyGrantWatch()
    }
    @objc func startLiveFromMenu() { menuBridge.start() }
    @objc func muteLiveFromMenu() { summonActions.mute() }
    @objc func stopLiveFromMenu() { model.stopTrigger.arm(.menu); menuBridge.stop() }
    private var gettingStartedProofRows: [NativeGettingStartedItem]?

    /// #620: a prompt that is not shown at launch, and the decision the owner moment reached, are
    /// one content-free line in native-live.log.
    private func recordPrompts(_ decisions: [(DeferredPrompts.Prompt, DeferredPrompts.Decision)]) {
        for (prompt, decision) in decisions {
            model.recordSurfaceReceipt(["event": "startup_prompt", "prompt": prompt.rawValue,
                                        "decision": decision.rawValue])
        }
    }

    /// #620: the owner opened the full window. The grant alert is asked exactly where it was asked
    /// before (once per app version, interactive launches only) and the sheet appears once.
    private func showSingleKeyGrantExplanation() {
        let alert = NSAlert()
        alert.messageText = "A Right Command tap mutes Naya"
        alert.informativeText = SingleKeyTrigger.explanation
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Not now")
        StatusSafeAlert.present(alert, parent: window) { [weak self] accepted in
            guard accepted else { return }
            SingleKeyTrigger.requestListenEventAccess()
            self?.scheduleSingleKeyGrantRecheck()
        }
    }

    private func showDeferredPrompts() {
        recordPrompts(deferredPrompts.ownerOpenedWindow { prompt in
            switch prompt {
            case .grantAlert:
                guard launchKind == .interactive else { return false }
                SingleKeyTrigger.requestGrantIfNeeded(for: launchKind, version: model.shortcutGrantVersion,
                    prompt: { [weak self] in self?.showSingleKeyGrantExplanation() })
                return true
            case .gettingStarted:
                guard window != nil, NativeGettingStartedOnce.consume(UserDefaults.standard) else { return false }
                showGettingStarted()
                return true
            }
        })
    }
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
                connections: model.connections.map { ($0.id, $0.state, $0.reasonCode, $0.addedToolNames ?? []) })
            let keyStep = NativeNextSteps.singleKeyStep(enabled: SingleKeyTrigger.isEnabled, tapped: singleKey.tapCreated)
            rows.append(NativeGettingStartedItem(title: "Right Command", detail: keyStep.text, command: nil,
                                                guideURL: keyStep.guideURL))
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
    func toggle() { coordinator.toggleWindow(activating: true) }
    /// Hiding the window stops dictation but never Live; Live is stopped only by
    /// an explicit action (menu, Ctrl-Opt-Shift-L, or hiding the mini orb).
    func hide() { coordinator.hideAll() }
    func escape() {
        if coordinator.fullShown { coordinator.closeFull() }
        else { miniOrb.hide(caller: "escape"); coordinator.hideMiniSurface() }
    }
    /// Ctrl-Opt-Space: the mini orb and a second press brings the window back. The chord starts Live
    /// when nothing runs, exactly as before; the status menu's item is the presentation-only path.
    @objc func toggleMiniOrb() {
        if coordinator.fullShown { coordinator.closeFull() } else { coordinator.presentFull(activating: true) }
    }
    /// MINI2: the single key on or off. Turning it on asks for the grant again,
    /// because the owner just said yes to the key.
    @objc func toggleSingleKey() {
        let enabled = !SingleKeyTrigger.isEnabled
        SingleKeyTrigger.isEnabled = enabled
        if enabled {
            if !SingleKeyTrigger.isGranted { showSingleKeyGrantExplanation() }
            singleKey.start()
        } else {
            singleKey.stop()
        }
        singleKeyMenuItem?.state = enabled ? .on : .off
        refreshAccessibilityNotice()
        syncSingleKeyGrantWatch()
        pushSingleKeyState()
    }
    /// The settings view reads this at render time: the app owns the state and the
    /// page owns the wording.
    private func pushSingleKeyState() {
        model.bridge.sendJS?("window.didiSingleKey={\"enabled\":\(SingleKeyTrigger.isEnabled),"
            + "\"granted\":\(SingleKeyTrigger.isGranted)}")
        pushPresenceState()
    }
    /// Council 2026-10-17 (option C): the host owns "Always show Naya" and the presence
    /// state; the settings page owns the wording, exactly like the single key above.
    private func pushPresenceState() {
        let surface = PresenceSurfaceState.shown(presence.posture)
        model.bridge.sendJS?("window.didiPresence={\"alwaysShow\":\(presence.alwaysShow),"
            + "\"state\":\"\(presence.state.rawValue)\"," + "\"error\":\(surface.error),"
            + "\"muted\":\(presence.mutedHeld)}")
    }
    /// Presence surfaces: the orb is there in every state, grey while Naya is silent, and
    /// the notch pill is the live-only privacy indicator. Nothing here takes focus.
    /// Q4-R1: the presence surface never takes the screen from a FULL window the owner opened.
    /// One coordinator, one visible surface (D-30): a posture change while the window is up must
    /// not hide it, which is the hide/show cycle call e283ef09 recorded 10 times with no owner
    /// action. The page-ready edge re-asks for the surfaces once the mini page can be hosted.
    private func applyPresenceSurface(_ surface: PresenceSurfaceState) {
        if !surface.visible { coordinator.hideMiniSurface() } else { coordinator.requestPresence() }
        miniPanel?.alphaValue = 1
        miniPanel?.pushPresence(presence.state, muted: presence.mutedHeld)
        pushPresenceState()
    }
    @objc func toggleAlwaysShowNaya() {
        if !presence.alwaysShow { coordinator.allowPresenceReveal() }
        presence.setAlwaysShow(!presence.alwaysShow)
        presenceMenuItem?.state = presence.alwaysShow ? .on : .off
        pushPresenceState()
    }
    /// Council 2026-10-17 (P1-R1): the two facts the presence machine cannot observe for
    /// itself. Provider readiness is the guarded barrier that opens LIVE, and a failed
    /// session is the fail-loud teardown. `.pausedForInput` keeps its existing meaning.
    private func presentShortcutMini() {
        if window?.isKeyWindow == true, NSApp.isActive { return }
        miniOrb.showSurface(trigger: .hotkey)
    }

    private func stopPresence() { presence.stop(.app) }

    private func startPresence(pickupJobID: String? = nil) {
        coordinator.allowPresenceReveal()
        if model.live == nil { presence.sessionEnded(presence.generation) }
        presencePickupJobID = pickupJobID
        presence.start(.app)
    }

    private func openPresenceSession(_ generation: UInt64) {
        let job = presencePickupJobID
        presencePickupJobID = nil
        liveGeneration = generation
        if !model.startLive(pickupJobID: job) { presence.fail(generation) }
    }

    private func presenceTransitioned(_ state: NativeLiveConversation.State, generation: UInt64) {
        // SOUND-R1: a dropped call the host rebuilds rings the reconnect, and the call going live
        // again plays the arrival chime. Neither is a presence move, and a muted call never rings.
        switch state {
        case .rebuilding: if presence.state == .live { model.ringRebuildStarted() }
        case .listening, .speaking, .muted: model.ringRebuildSettled()
        default: break
        }
        switch state.presenceMove {
        case .ready: presence.ready(generation)
        case .failed: presence.fail(generation)
        case .ended:
            // #589: the owner's own sentence ended this call, so presence closes it as her voice stop and the
            // goodbye sounds. Any other ending is a session that ended, which presence records as it always has.
            presence.endAfterHostTerminal(voiceStop: model.live?.hostVoiceStop == true,
                                          lostCall: model.live?.hostTerminalCode == "provider_recovery_exhausted",
                                          generation: generation)
        case .uncertain:
            // #613: a socket that closed without a terminal frame leaves no live microphone, so presence
            // goes cold now. It never reconnects to find out what the host thinks.
            presence.sessionUncertain(generation)
        case .none: break
        }
    }
    /// The FULL window's "Show the mini orb" button (#311): the page asks through the bridge and
    /// this only moves the surface. Live keeps running and is never opened here; only the chord,
    /// an orb press and Start open a session (Q4-R2: a presentation command that started a live
    /// microphone was a privacy surprise).
    @objc func showMiniOrb() { miniOrb.showSurface(trigger: .button) }
    // The surface seam the two lazy properties share. Each step goes through a
    // method so neither lazy initializer has to mention the other.
    private func orderOutFullWindow() {
        window?.orderOut(nil)
    }
    /// M3-R2: the one native toggle behind the orb click and the Right Command tap.
    /// P1 points both at `NativePresence.togglePresence`; until then the same three
    /// steps run through the existing bridge commands, so this is a thin call and no
    /// new audio code.
    private func applyPresenceStep(_ step: PresenceStep) {
        switch step {
        case .connect: if model.live?.isCapturing != true {
            // Q4-R5: an orb press starts the session, so the receipt names `orb` and not a chord.
            model.recordSurfaceReceipt(["event": "mini_start", "trigger": SurfaceTrigger.orb.rawValue])
            model.handleBridgeCommand(.start)
        }
        case .hotMute: if model.live?.isMuted == false { model.handleBridgeCommand(.mute) }
        case .live: if model.live?.isMuted == true { model.handleBridgeCommand(.unmute) }
        }
        // M3-R5: muting takes the pill off the screen and unmuting brings it back.
    }

    private func presentMiniThroughCoordinator(trigger: SurfaceTrigger) -> MiniPresentOutcome {
        coordinator.presentMini(trigger: trigger)
    }
    private func expandThroughCoordinator() { _ = coordinator.presentFull(activating: true) }
    private func cancelPresentationPreparation() {
        presentationTask?.cancel()
        presentationTask = nil
    }

    private func preparePresentation(_ target: PresentationCoordinator.Mode, generation: UInt64) {
        presentationTask = Task { [weak self] in
            guard let self else { return }
            if target == .full, !coordinator.fullShown, model.shell?.state != .ready {
                coordinator.prepared(target, generation: generation)
                return
            }
            do {
                let shell: CompanionWeb
                if target == .mini {
                    guard let mini = miniShellForDisplay(), let cookie = model.pageCookie else {
                        coordinator.prepared(target, generation: generation, failure: "page_not_ready")
                        return
                    }
                    shell = mini
                    if miniPanel == nil {
                        miniPanel = MiniOrbPanel(web: mini.webView, onStep: { [weak self] step in self?.applyPresenceStep(step) },
                            onExpand: { [weak self] in self?.miniOrb.openFullInterface() },
                            onReceipt: { [weak self] record in self?.model.appendPresenceReceipt(record) })
                        miniPanel?.pushPresence(presence.state, muted: presence.mutedHeld)
                    }
                    miniPanel?.onVisibilityChanged = { [weak self] in self?.syncPresentedSurface() }
                    miniPanel?.contentView?.layoutSubtreeIfNeeded()
                    if shell.state != .ready || miniCookie != cookie {
                        miniCookie = cookie
                        await shell.load(cookie: cookie)
                    }
                } else {
                    guard let full = model.shell else { throw CompanionError.unavailable }
                    shell = full
                    window?.contentView?.layoutSubtreeIfNeeded()
                }
                try await shell.prepareForPresentation(generation: generation)
                guard !Task.isCancelled else { return }
                if target == .mini {
                    guard miniCookie == model.pageCookie, shell.descriptor.origin == model.shell?.descriptor.origin else {
                        throw CompanionError.unavailable
                    }
                } else if model.shell !== shell { throw CompanionError.unavailable }
                coordinator.prepared(target, generation: generation)
            } catch is CancellationError { return }
            catch { coordinator.prepared(target, generation: generation, failure: "paint_unavailable") }
        }
    }

    func windowDidChangeOcclusionState(_ notification: Notification) { syncPresentedSurface() }
    func windowDidMiniaturize(_ notification: Notification) { syncPresentedSurface() }
    func windowDidDeminiaturize(_ notification: Notification) { syncPresentedSurface() }

    /// ORBFIRST: every commit of a surface runs here. The orb's first landing is also the launch's
    /// auto-connect gate, and a route the menu asked for opens the moment its page is up.
    private func presentationCommitted(_ mode: PresentationCoordinator.Mode) {
        syncPresentedSurface()
        if coordinator.miniShown { autoConnectIfReady() }
        if coordinator.fullShown, let route = pendingFullRoute {
            pendingFullRoute = nil
            openFullRoute(route)
        }
    }

    /// The one entry the page exposes for a native-opened route; a page that is not ready answers
    /// nothing and the window still opens.
    private func openFullRoute(_ route: String) {
        guard let web = model.shell?.webView else { return }
        web.evaluateJavaScript("window.didiOpenRoute ? window.didiOpenRoute('\(route)') : null",
                               completionHandler: nil)
    }

    /// ORBFIRST: Settings opens the window on the page's Settings tab, creating the window the
    /// first time this asks for it.
    @objc private func openSettingsFromMenu() {
        pendingFullRoute = "settings"
        coordinator.presentFull(activating: true)
        if coordinator.fullShown { presentationCommitted(.full) }
    }

    private func syncPresentedSurface() {
        let generation = coordinator.generation
        let fullVisible = coordinator.fullShown && window?.isVisible == true && window?.isMiniaturized == false
        let miniVisible = coordinator.miniShown && miniPanel?.isVisible == true
        miniOrb.presentationCommitted(visible: miniVisible)
        model.shell?.setSurfaceVisible(fullVisible, generation: generation)
        miniShell?.setSurfaceVisible(miniVisible, generation: generation)
        let recipient = fullVisible ? model.shell : miniVisible ? miniShell : nil
        if let recipient, recipient.state == .ready {
            model.bridge.orbPublication.select(ObjectIdentifier(recipient), generation: generation,
                evaluate: { [weak recipient] script, completion in
                    guard let recipient else { completion(); return }
                    recipient.publishOrb(script, generation: generation, completion: completion)
                })
        } else { model.bridge.orbPublication.select(nil, generation: generation, evaluate: nil) }
    }

    @discardableResult
    private func presentMiniPanel() -> MiniPresentOutcome {
        guard let shell = miniShell, shell.state == .ready, let panel = miniPanel else {
            return .failed("page_not_ready")
        }
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        return .shown(MiniSurfaceFacts(frame: NSStringFromRect(panel.frame),
            screen: panel.screen.map { NSStringFromRect($0.frame) } ?? "none",
            alpha: Double(panel.alphaValue), occluded: !panel.occlusionState.contains(.visible), pageState: "ready"))
    }
    /// The mini view reuses the one live page session: same service origin, same
    /// page cookie, never a second bootstrap (which would revoke the first view).
    private func miniShellForDisplay() -> CompanionWeb? {
        if let shell = miniShell, let origin = model.shell?.descriptor.origin, shell.descriptor.origin == origin { return shell }
        guard let descriptor = model.shell?.descriptor ?? (try? ServiceDescriptor.configured()) else { return nil }
        let shell = CompanionWeb(descriptor: descriptor, route: .mini)
        miniShell = shell
        miniPageObservation.bind(shell)
        miniPanel = nil
        return shell
    }
    /// UI3A-R2: Cmd+W and the close button. An active Live session switches to
    /// the mini orb and keeps running; otherwise the window hides and the app
    /// stays in the Dock.
    func windowShouldClose(_ sender: NSWindow) -> Bool { coordinator.closeFull(); return false }
    /// #619: a Dock click shows the orb. It is its own launch kind with no window, so no window is
    /// created, nothing becomes key and the app never activates; the menu item, the hotkey and an
    /// install relaunch still open the full window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        model.appendPresenceReceipt(LaunchKind.reopen.launchRecord)
        model.forwardLaunchReceipt(LaunchKind.reopen)
        _ = coordinator.presentOrbFromDock()
        return false
    }
    /// #625: right-clicking the Dock icon offers the menu bar's four actions, so the owner can
    /// open the full app from the Dock itself without a second icon or process.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        dockMenu.build(muted: model.live?.isMuted == true)
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
        let logger = Logger(subsystem: "LuxDidi", category: "quit")
        let first = quitDeadline.request(schedule: { seconds, fire in
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds, execute: fire)
        }, forced: { stage in
            NativeHostProcessRegistry.shared.forceStop(pid: NativeQuitDeadline.shared.ownedChildPID)
            logger.error("quit_forced stage=\(stage.rawValue, privacy: .public)")
            // No MainActor hop or AppKit callback: even a wedged executor cannot hold Quit.
            // The owned host has received bounded TERM/KILL; the OS releases native audio.
            Darwin._exit(EXIT_SUCCESS)
        })
        if first {
            Task {
                await model.shutdown(stage: { quitDeadline.stage($0) })
                guard quitDeadline.complete() else { return }
                cleanQuit = true
                sender.terminate(nil)
            }
        }
        // terminateLater would enter an AppKit nested loop and can starve actor cleanup.
        return .terminateCancel
    }
    @objc private func pickupLiveCall() { show(); model.pickUpLiveCall() }
    func applicationWillTerminate(_ notification: Notification) {
        alarmObservation?.cancel(); model.stopAlarms()
        liveCallTimer?.invalidate(); liveCallBadge?.cancel(); liveCallHealth?.cancel()
        model.stopRecording("Didi quit"); hotkey.unregister(); liveShortcuts.unregister()
        if let keyboardMonitor { NSEvent.removeMonitor(keyboardMonitor) }
        if let statusClickMonitor { NSEvent.removeMonitor(statusClickMonitor) }
        if let terminationMonitor { NSWorkspace.shared.notificationCenter.removeObserver(terminationMonitor) }
        if let wakeMonitor { NSWorkspace.shared.notificationCenter.removeObserver(wakeMonitor) }
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
        // Q4-R1: this launch has no service descriptor, so the mini page cannot be hosted. The
        // registered callback still runs, and the show fails loud on the record instead of
        // opening the FULL window the owner did not ask for; no surface pretends to be there.
        guard !window.isVisible, coordinator.mode == .hidden, !miniOrb.isVisible,
              model.surfaceReceipts.contains(where: {
                  $0["event"] as? String == "mini_present_deferred" && $0["reason"] as? String == "page_not_ready"
              })
        else { failProof("registered hotkey callback must report the mini surface"); return }
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
                login: "Unavailable", connections: [("calendar", "missing", "credential_missing", [])])
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
