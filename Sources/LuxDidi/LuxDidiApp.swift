import AppKit
import Combine
import SwiftUI
import Carbon
import Security

@MainActor final class AppModel: ObservableObject {
    @Published var draft = ""
    @Published var error: String?
    @Published var captureStatus: CaptureStatus = .idle
    @Published var notificationStatus: NotificationCapability = .unknown
    @Published var hotkeyStatus = "Registering…"
    @Published var shell: CompanionWeb?
    @Published var connecting = false
    let voice = NativeVoice()
    @Published private(set) var live: NativeLiveConversation?
    @Published private(set) var pendingLiveCalls: [NativePendingLiveJob] = []
    private var notifiedLiveJobs = Set<String>()
    private var checkingLiveCalls = false
    let notifications = NativeNotifications()
    private(set) var client: CompanionClient?
    private(set) var supervisor: NativeServiceSupervisor?
    private var submittedDraft: String?
    private(set) var installedProof: PreparedInstalledProof?
    private(set) var bootstrapFailureCode: String?
    init(proofRequest: InstalledProofRequest? = nil) {
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
                    owner.onUnavailable = { [weak self] in
                        self?.error = NativeServiceError.exited.localizedDescription
                        self?.shell?.clear()
                        self?.stopLive()
                    }
                    return
                }
            } catch { self.error = NativeServiceError.invalidRuntime.localizedDescription; return }
        }
        if proofRequest != nil { error = NativeServiceError.invalidRuntime.localizedDescription; return }
        do {
            let descriptor = try ServiceDescriptor.configured()
            shell = CompanionWeb(descriptor: descriptor)
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
                let allowed = { supervisor.isCurrent(connection) }
                let credential = { () throws -> String in
                    guard allowed() else { throw CompanionError.unavailable }
                    return try descriptor.credential()
                }
                if let client {
                    await client.rebind(descriptor: descriptor, credential: credential, expectedEpoch: connection.authorityEpoch, connectionGuard: allowed)
                } else {
                    client = CompanionClient(descriptor: descriptor, credential: credential, expectedEpoch: connection.authorityEpoch, connectionGuard: allowed)
                }
                if shell?.descriptor.origin != descriptor.origin { shell = CompanionWeb(descriptor: descriptor) }
            }
            guard let client, let shell else { throw CompanionError.invalidConfiguration }
            bootstrapFailureCode = nil
            await shell.load(cookie: try await client.bootstrap()); error = nil
        } catch {
            bootstrapFailureCode = supervisor?.startupFailureCode ?? "bootstrap/" + ((error as? CompanionError).map { String(describing: $0) } ?? "platformFailure")
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
    func refreshLiveCalls() async {
        guard !checkingLiveCalls, let client else { return }
        checkingLiveCalls = true; defer { checkingLiveCalls = false }
        do {
            let http = NativeLiveOperatorHTTP(authority: client.authenticatedRequestBuilder())
            let jobs = try await http.pendingCalls().filter(\.isReady)
            pendingLiveCalls = jobs
            live?.offerPendingCall(jobs.first)
            for job in jobs where !notifiedLiveJobs.contains(job.id) {
                notifiedLiveJobs.insert(job.id)
                _ = await notifications.submitLiveCall(jobID: job.id)
            }
        } catch { /* Retain the last known offer; never start audio on a poll or transport failure. */ }
    }
    func pickUpLiveCall(_ jobID: String? = nil) {
        let selected = jobID ?? pendingLiveCalls.first?.id
        Task { [weak self] in
            guard let self else { return }
            await self.live?.stop()
            self.live = nil
            self.startLive(pickupJobID: selected)
        }
    }
    func startLive(pickupJobID: String? = nil) {
        guard let client else { error = "Connect the local service before starting Live voice."; return }
        if live == nil {
            live = NativeLiveConversation(authority: client.authenticatedRequestBuilder(), dictationIsCapturing: { [weak self] in
                self?.voice.state.phase == .recording
            }, pickupJobID: pickupJobID)
        }
        live?.start()
    }
    func stopLive() {
        let conversation = live
        conversation?.device.stop()
        Task { await conversation?.stop() }
    }
    func startDictation() {
        guard live?.isCapturing != true else { error = "Stop Live voice before starting dictation."; return }
        voice.start()
    }
    func stopRecording(_ reason: String) {
        stopLive()
        let wasRecording = voice.state.phase == .recording
        voice.stop(reason: reason)
        if wasRecording && !voice.state.transcript.isEmpty { draft = voice.state.transcript }
    }
    func logout() async {
        stopRecording("Logout")
        await live?.stop(); live = nil
        await client?.revokePageSession(); shell?.clear()
    }
    func shutdown() async {
        await logout()
        await supervisor?.stop()
    }
}

struct NativeLiveControls: View {
    @ObservedObject var conversation: NativeLiveConversation
    @ObservedObject var device: NativeLiveAudioDevice
    var body: some View {
        VStack {
            Text("Live: " + conversation.state.rawValue).accessibilityLabel("Live voice lifecycle")
            ProgressView(value: conversation.state == .muted ? 0 : Double(device.inputLevel))
                .accessibilityLabel(conversation.state == .muted ? "Microphone muted" : "Live microphone input level")
            HStack {
                Button(conversation.state == .muted ? "Unmute" : "Mute") { conversation.toggleMute() }
                    .disabled(![.listening, .speaking, .muted].contains(conversation.state))
                Button("Stop Live voice") { Task { await conversation.stop() } }
            }
            if let failure = conversation.failure { Text(failure).font(.caption) }
        }
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: NativeVoice
    var body: some View {
        VStack(spacing: 0) {
            if let shell = model.shell {
                SharedServicePanel(shell: shell) { Task { await model.reconnect() } }
            } else {
                VStack(spacing: 16) {
                    Text("Connect Didi").font(.title)
                    Text("Start the Didi service, then connect this app.").multilineTextAlignment(.center)
                    Button(model.connecting ? "Starting…" : "Connect") { Task { await model.reconnect() } }
                        .disabled(model.connecting).accessibilityLabel("Connect Didi")
                }.padding(48).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("Native capture · \(model.hotkeyStatus)").font(.caption).foregroundStyle(.secondary)
                HStack {
                    TextField("User-entered or on-device transcribed text", text: $model.draft)
                    Button(model.captureStatus == .unknown ? "Retry Send" : "Send") { Task { await model.saveDraft() } }
                        .disabled(!Presentation.canSend(model.draft) || model.captureStatus == .sending || voice.state.phase == .recording)
                        .accessibilityLabel(model.captureStatus == .unknown ? "Retry same text capture" : "Send text")
                    Button("Start") { model.startDictation() }
                        .disabled(model.live?.isCapturing == true || voice.state.phase == .recording || voice.microphone != .granted || voice.speech != .granted || !voice.onDevice)
                        .accessibilityLabel("Start recording")
                    Button("Stop") { model.stopRecording("Stopped by user") }
                        .disabled(voice.state.phase != .recording).accessibilityLabel("Stop recording")
                    VStack {
                        Text("Live microphone audio leaves this device for the configured Live provider. Start only with your consent.").font(.caption)
                        if !model.pendingLiveCalls.isEmpty {
                            Button("Pick up Naya’s call") { model.pickUpLiveCall() }
                        }
                        Button("Start Live voice") { model.startLive() }
                            .disabled(model.live?.isCapturing == true || voice.state.phase == .recording)
                        if let live = model.live { NativeLiveControls(conversation: live, device: live.device) }
                    }
                    Menu("Settings") {
                        Button("Request microphone/speech permissions") { Task { await model.voice.requestPermissions() } }
                        Button("Reconnect service") { Task { await model.reconnect() } }
                        Button("Disconnect") { Task { await model.logout() } }
                        if let shell = model.shell {
                            Text("Service: \(shell.descriptor.origin)")
                            Text("Credential reference: \(shell.descriptor.credentialService)")
                        }
                        Button("Quit Didi") { NSApp.terminate(nil) }
                    }
                }
                Text(captureDetail).font(.caption)
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
                Text("Record locally, review the text, then send it. Closing Didi keeps your draft.").font(.caption2).foregroundStyle(.secondary)
            }.padding(12)
        }.frame(minWidth: 780, minHeight: 620)
    }
    private var captureDetail: String {
        switch model.captureStatus {
        case .saved: return "Saved to the service."
        case .unknown: return "Couldn’t confirm it was saved. Your draft is here; retry this send."
        case .cancelled: return "Cancelled before dispatch. Draft retained."
        case .sending: return "Saving…"
        case .failed: return "Not saved. Draft retained."
        case .idle: return "No native capture sent."
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model: AppModel
    private let proofRequest: InstalledProofRequest?
    init(proofRequest: InstalledProofRequest? = nil) {
        self.proofRequest = proofRequest; model = AppModel(proofRequest: proofRequest)
        super.init()
    }
    let hotkey = GlobalHotkey()
    private(set) var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var liveCallTimer: Timer?
    private var liveCallBadge: AnyCancellable?
    private var pickupMenuItem: NSMenuItem?
    private var keyboardMonitor: Any?
    private var terminationMonitor: NSObjectProtocol?
    private var hotkeyCode: OSStatus = noErr
    private var cleanQuit = false
    private var quitting = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        OwnedWindowReadiness.trace("app:didFinishLaunching-entry",
            ["activationPolicy": NSApp.activationPolicy().rawValue, "isActive": NSApp.isActive])
        NSApp.setActivationPolicy(.accessory)
        OwnedWindowReadiness.trace("app:setActivationPolicy-accessory",
            ["activationPolicy": NSApp.activationPolicy().rawValue])
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Didi"; window.center(); window.delegate = self
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: RootView(model: model, voice: model.voice))
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Didi")
        let menu = NSMenu()
        menu.addItem(withTitle: "Show Didi", action: #selector(show), keyEquivalent: "")
        let pickup = NSMenuItem(title: "Pick up Naya’s call", action: #selector(pickupLiveCall), keyEquivalent: "")
        pickup.isHidden = true; pickupMenuItem = pickup; menu.addItem(pickup)
        menu.addItem(withTitle: "Reveal logs", action: #selector(revealLogs), keyEquivalent: "")
        menu.addItem(withTitle: "Quit Didi", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }; statusItem.menu = menu
        hotkey.onToggle = { [weak self] in self?.toggle() }
        hotkeyCode = hotkey.register()
        model.hotkeyStatus = hotkeyCode == noErr ? "⌃ ⌥ Space · registered" : "Unavailable (OSStatus \(hotkeyCode)); use the menu bar"
        model.notifications.onOpen = { [weak self] _ in self?.show() }
        model.notifications.onLiveCall = { [weak self] jobID in
            self?.show(); self?.model.pickUpLiveCall(jobID)
        }
        liveCallBadge = model.$pendingLiveCalls.sink { [weak self] jobs in
            self?.statusItem.button?.title = jobs.isEmpty ? "" : "•"
            self?.statusItem.button?.toolTip = jobs.isEmpty ? "Didi" : "Naya is calling, pick up when you want"
            self?.pickupMenuItem?.isHidden = jobs.isEmpty
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
            show()
            OwnedWindowReadiness.trace("app:refresh-start")
            await model.refresh()
            OwnedWindowReadiness.trace("app:refresh-end", ["isActive": NSApp.isActive])
            if proofRequest != nil { await runInstalledProof(); return }
            if CommandLine.arguments.contains("--self-check") { await selfCheck(); return }
            if let index = CommandLine.arguments.firstIndex(of: "--ui-proof"), CommandLine.arguments.count > index + 1 {
                await uiProof(path: CommandLine.arguments[index + 1]); return
            }
            await model.reconnect()
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

    @objc func show() {
        OwnedWindowReadiness.trace("app:show-entry", ["windowExists": window != nil])
        OwnedWindowReadiness.trace("app:makeKeyAndOrderFront-before")
        window.makeKeyAndOrderFront(nil)
        OwnedWindowReadiness.trace("app:makeKeyAndOrderFront-after",
            ["isVisible": window.isVisible, "isKey": window.isKeyWindow, "isMain": window.isMainWindow])
        OwnedWindowReadiness.trace("app:activateIgnoringOtherApps-before", ["isActive": NSApp.isActive])
        NSApp.activate(ignoringOtherApps: true)
        OwnedWindowReadiness.trace("app:activateIgnoringOtherApps-after",
            ["isActive": NSApp.isActive, "isKey": window.isKeyWindow, "isMain": window.isMainWindow])
    }
    func toggle() { window.isVisible ? hide() : show() }
    func hide() { model.stopRecording("Didi hidden"); window.orderOut(nil) }
    func escape() { hide() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }
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
        liveCallTimer?.invalidate(); liveCallBadge?.cancel()
        model.stopRecording("Didi quit"); hotkey.unregister()
        if let keyboardMonitor { NSEvent.removeMonitor(keyboardMonitor) }
        if let terminationMonitor { NSWorkspace.shared.notificationCenter.removeObserver(terminationMonitor) }
    }
    func selfCheck() async {
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
        do {
            let url = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(nanoseconds: 100_000_000)
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
            print("MAC-UI PASS screenshot=\(path) close=retains-agent escape=hides draft=retained hotkeyCallback=show quit=clean-no-session voiceEffects=none notificationEffects=none")
            NSApp.terminate(nil)
        } catch { failProof("Screenshot could not be written") }
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
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
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
