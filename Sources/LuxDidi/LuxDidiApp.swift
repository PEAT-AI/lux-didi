import AppKit
import SwiftUI
import Carbon

@MainActor final class AppModel: ObservableObject {
    enum Page: String, CaseIterable, Identifiable {
        case conversation = "Conversation", today = "Today", memory = "Memory", settings = "Settings"
        var id: String { rawValue }
        var icon: String { switch self { case .conversation: return "bubble.left.and.bubble.right"; case .today: return "sun.max"; case .memory: return "tray.full"; case .settings: return "slider.horizontal.3" } }
    }
    @Published var page: Page = .conversation
    @Published var draft = ""
    @Published var query = ""
    @Published var error: String?
    @Published var replies: [String] = []
    @Published var notificationStatus: NotificationCapability = .unknown
    @Published var hotkeyStatus = "Registering…"
    @Published var openedReminder: ReminderLink?
    let domain: any AppDomainPort
    let voice = NativeVoice()
    let notifications = NativeNotifications()
    init(domain: any AppDomainPort = DisconnectedDomain()) { self.domain = domain }
    func send() {
        guard Presentation.canSend(draft) else { return }
        do { replies.append(try domain.send(draft)); draft = ""; error = nil }
        catch { self.error = error.localizedDescription }
    }
    func refresh() async { voice.refresh(); notificationStatus = await notifications.capability() }
    func requestNotifications() async {
        error = Presentation.notificationResult(await notifications.requestPermission())
        await refresh()
    }
    func stopRecording(_ reason: String) {
        voice.stop(reason: reason)
        if !voice.state.transcript.isEmpty { draft = voice.state.transcript }
    }
}

struct DidiView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: NativeVoice
    @FocusState private var composerFocused: Bool
    private let accent = Color(red: 0.25, green: 0.46, blue: 0.40)
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 10) {
                    Image(systemName: "sparkle").font(.title).foregroundStyle(accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Didi").font(.system(size: 23, weight: .semibold, design: .rounded))
                        Text("A little clarity, locally.").font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(.top, 16)
                VStack(spacing: 6) {
                    ForEach(Array(AppModel.Page.allCases.enumerated()), id: \.element.id) { index, page in
                        Button { model.page = page } label: {
                            Label(page.rawValue, systemImage: page.icon).font(.system(size: 14, weight: model.page == page ? .semibold : .regular))
                                .frame(maxWidth: .infinity, alignment: .leading).padding(11)
                                .background(model.page == page ? accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 9))
                        }.buttonStyle(.plain).keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    }
                }
                Spacer()
                VStack(alignment: .leading, spacing: 7) {
                    Label("Local preview", systemImage: "lock.shield").font(.caption.weight(.semibold))
                    Text("No account connected.\nNo background recording.").font(.caption).foregroundStyle(.secondary)
                    Text("⌃ ⌥ Space to open").font(.caption2).foregroundStyle(.secondary)
                }.padding(.bottom, 12)
            }.padding(.horizontal, 20).frame(width: 205).background(accent.opacity(0.04))
            Divider()
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.page.rawValue).font(.system(size: 28, weight: .semibold, design: .rounded))
                        Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Label("On this Mac", systemImage: "desktopcomputer").font(.caption).foregroundStyle(accent)
                }
                switch model.page {
                case .conversation: conversation
                case .today: today
                case .memory: memory
                case .settings: settings
                }
                if let error = model.error {
                    HStack(alignment: .top) {
                        Image(systemName: "info.circle")
                        Text(error).font(.caption).textSelection(.enabled)
                        Spacer()
                        Button("Dismiss") { model.error = nil }.buttonStyle(.borderless)
                    }.padding(12).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                }
            }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
        }.frame(minWidth: 860, minHeight: 580).tint(accent)
            .background(Color(nsColor: .windowBackgroundColor))
            .preferredColorScheme(.light)
            .onChange(of: voice.state.transcript) { _, value in if !value.isEmpty { model.draft = value } }
            .onChange(of: model.page) { _, page in if page == .conversation { composerFocused = true } }
    }
    var subtitle: String {
        switch model.page {
        case .conversation: return "Make room for the next small thing."
        case .today: return "A plan that belongs to you, not another busy dashboard."
        case .memory: return "Recall should have a source."
        case .settings: return "You decide what Didi can access."
        }
    }
    var conversation: some View {
        VStack(alignment: .leading, spacing: 14) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Hi. What’s on your mind?").font(.title3.weight(.medium))
                    Text("You can draft here now. Saving, reminders and recall will become available when the local core is connected. I won’t pretend to remember what I haven’t saved.")
                        .foregroundStyle(.secondary).lineSpacing(5)
                    if let reminder = model.openedReminder {
                        Label("Reminder: \(reminder.commitmentID) · revision \(reminder.revision)", systemImage: "bell").font(.callout)
                        Text("The local core is not connected, so this reminder’s current status cannot be verified.").font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(Array(model.replies.enumerated()), id: \.offset) { _, reply in Text(reply).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
                    .background(accent.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
            }
            Spacer(minLength: 0)
            Label(model.domain.status, systemImage: "circle.dashed").font(.caption).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $model.draft).font(.body).scrollContentBackground(.hidden).frame(height: 82)
                    .focused($composerFocused).accessibilityLabel("Message draft")
                HStack {
                    Button { if voice.state.phase == .recording { model.stopRecording("Stop button") } else { voice.start() } } label: {
                        Label(voice.state.phase == .recording ? "Stop recording" : "Record", systemImage: voice.state.phase == .recording ? "stop.circle.fill" : "mic")
                    }.keyboardShortcut("r", modifiers: [.command, .shift])
                    if voice.state.phase == .recording { Label("Recording", systemImage: "record.circle.fill").foregroundStyle(.red).font(.caption) }
                    Spacer()
                    Button("Send draft") { model.send() }.keyboardShortcut(.return, modifiers: .command)
                        .buttonStyle(.borderedProminent).disabled(!Presentation.canSend(model.draft))
                }
            }.padding(14).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
            Text(voice.state.detail).font(.caption).foregroundStyle(.secondary)
            Text("⌘ Return to send · Escape to stop and hide · Drafts are not saved in this preview")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
    var today: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(model.domain.plan) { item in VStack(alignment: .leading) { Text(item.title); Text(item.detail).foregroundStyle(.secondary) } }
            if model.domain.plan.isEmpty { empty("No plan loaded", detail: "The local core is not connected. This is not a claim that your day is empty.", icon: "sun.horizon") }
            Spacer()
        }
    }
    var memory: some View {
        VStack(alignment: .leading, spacing: 18) {
            TextField("Search saved memories", text: $model.query).textFieldStyle(.roundedBorder).accessibilityLabel("Search saved memories")
            ForEach(model.domain.search(model.query)) { row in VStack(alignment: .leading) { Text(row.text); Text(row.source).font(.caption).foregroundStyle(.secondary) } }
            empty("Memory is not connected", detail: "No search has been sent to a provider. Once connected, recall will show where each result came from.", icon: "tray")
            Spacer()
        }
    }
    var settings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                status("Local core", value: model.domain.status)
                status("Global shortcut", value: model.hotkeyStatus)
                status("Notifications", value: model.notificationStatus.rawValue + " · macOS Focus is respected")
                Button("Enable notifications…") { Task { await model.requestNotifications() } }
                Divider()
                status("Microphone", value: voice.microphone.rawValue)
                status("Speech recognition", value: voice.speech.rawValue)
                status("On-device recognition", value: voice.onDevice ? "Supported for this locale; live capture untested" : "Unavailable; cloud fallback is disabled")
                Button("Enable microphone & speech…") { Task { await voice.requestPermissions() } }
                Text("Permission alone never starts recording. Press Record to begin, Stop or Escape to finish. Text works without either permission.").font(.caption).foregroundStyle(.secondary)
                Divider()
                status("Accounts & models", value: "Unconfigured · no network requests")
                Text("Closing the window leaves the menu-bar agent running. Quit stops the app and recording. This preview does not persist drafts.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Refresh permission status") { Task { await model.refresh() } }
                    Button("Open macOS Privacy Settings") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!)
                    }
                    Button("Quit Didi") { NSApp.terminate(nil) }
                }
            }
        }
    }
    func status(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(title).font(.subheadline.weight(.semibold)); Text(value).font(.caption).foregroundStyle(.secondary) }
    }
    func empty(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(accent)
            Text(title).font(.title3.weight(.medium))
            Text(detail).foregroundStyle(.secondary).lineSpacing(4)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            .background(accent.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
    }
}

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

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = AppModel()
    let hotkey = GlobalHotkey()
    private(set) var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var keyboardMonitor: Any?
    private var terminationMonitor: NSObjectProtocol?
    private var hotkeyCode: OSStatus = -1
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 660), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Lux Didi"; window.isReleasedWhenClosed = false; window.delegate = self
        window.contentView = NSHostingView(rootView: DidiView(model: model, voice: model.voice)); window.center()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Lux Didi")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Didi", action: #selector(show), keyEquivalent: "")
        menu.addItem(withTitle: "Settings…", action: #selector(settings), keyEquivalent: ",")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Didi", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }; statusItem.menu = menu
        hotkey.onToggle = { [weak self] in self?.toggle() }
        hotkeyCode = hotkey.register()
        model.hotkeyStatus = hotkeyCode == noErr ? "⌃ ⌥ Space · registered" : "Unavailable (OSStatus \(hotkeyCode)); use the menu bar"
        model.notifications.onOpen = { [weak self] link in
            self?.model.openedReminder = link; self?.model.page = .conversation; self?.show()
        }
        keyboardMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == UInt16(kVK_Escape) { self?.escape(); return nil }; return event
        }
        terminationMonitor = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.model.stopRecording("Mac is going to sleep") }
        }
        show()
        Task {
            await model.refresh()
            if CommandLine.arguments.contains("--self-check") { await selfCheck() }
            if let index = CommandLine.arguments.firstIndex(of: "--ui-proof"), CommandLine.arguments.count > index + 1 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.uiProof(path: CommandLine.arguments[index + 1]) }
            }
        }
    }
    @objc func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func settings() { model.page = .settings; show() }
    @objc func quit() { NSApp.terminate(nil) }
    func toggle() {
        model.page = .conversation
        if window.isVisible { model.stopRecording("Shortcut dismissed the window"); window.orderOut(nil) } else { show() }
    }
    func escape() { model.stopRecording("Escape"); window.orderOut(nil) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { model.stopRecording("Window closed"); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        model.stopRecording("Quit"); hotkey.unregister()
        if let keyboardMonitor { NSEvent.removeMonitor(keyboardMonitor) }
        if let terminationMonitor { NSWorkspace.shared.notificationCenter.removeObserver(terminationMonitor) }
    }
    func selfCheck() async {
        let result = await model.notifications.submit(ReminderEnvelope(commitmentID: "synthetic", revision: 1, title: "Synthetic", body: "Invalid date, never submitted"), at: .distantPast)
        guard case .failed = result, model.domain.plan.isEmpty, model.voice.state.phase == .idle,
              model.voice.preparedPlayback("Muted preparation only").volume == 0 else { failProof("safe runtime checks") ; return }
        print("MAC-RUNTIME PASS pid=\(ProcessInfo.processInfo.processIdentifier) hotkey=\(hotkeyCode) notifications=\(model.notificationStatus.rawValue) microphone=\(model.voice.microphone.rawValue) speech=\(model.voice.speech.rawValue) onDevice=\(model.voice.onDevice) audioCapture=not-started playback=muted-preparation-only domain=disconnected")
        NSApp.terminate(nil)
    }
    func uiProof(path: String) {
        // Exercise rendered app controls without accounts, grants, microphone or notification sends.
        model.draft = "Synthetic draft — nothing will be saved or sent."
        model.send()
        guard model.error != nil, !model.draft.isEmpty else { failProof("disconnected draft preserved"); return }
        model.error = nil; model.draft = ""
        window.performClose(nil)
        guard !window.isVisible, !applicationShouldTerminateAfterLastWindowClosed(NSApp) else { failProof("close retains menu agent"); return }
        show()
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: UInt16(kVK_Escape))!
        NSApp.sendEvent(event)
        guard !window.isVisible, model.voice.state.phase == .idle else { failProof("Escape stops and hides"); return }
        show()
        guard hotkeyCode == noErr, hotkey.exerciseNativeRoute() == noErr else { failProof("native global hotkey route"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            guard !self.window.isVisible else { self.failProof("hotkey toggle dispatched"); return }
            self.show()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.capture(path: path) }
        }
    }
    func capture(path: String) {
        guard let view = window.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { failProof("native screenshot bitmap"); return }
        view.displayIfNeeded(); view.cacheDisplay(in: view.bounds, to: bitmap)
        do {
            guard let png = bitmap.representation(using: .png, properties: [:]) else { failProof("PNG encoding"); return }
            try png.write(to: URL(fileURLWithPath: path))
            print("MAC-UI PASS pid=\(ProcessInfo.processInfo.processIdentifier) window=\(window.windowNumber) screenshot=\(path) close=retains-agent escape=stops-and-hides hotkey=native-event-route draft=failure-retains-text mode=empty-preview")
            NSApp.terminate(nil)
        } catch { failProof("Screenshot: \(error.localizedDescription)") }
    }
    func failProof(_ reason: String) { fputs("MAC-PROOF FAIL: \(reason)\n", stderr); exit(1) }
}

@main enum LuxDidiApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
