import Foundation
import Carbon

enum NativeNoteAction { static let label = "Save note" }
enum ShortcutStatus {
    static func describe(code: Int32) -> String {
        code == 0 ? "registered" : "Unavailable (OSStatus \(code)); use the menu bar"
    }
}
struct LiveStatusPresentation {
    let state: String
    let pendingCall: Bool
    init(state: String, pendingCall: Bool, dictationCapturing: Bool = false) {
        self.state = dictationCapturing ? "listening" : (["idle", "ended", "failed", "outcomeUnknown"].contains(state) ? "stopped" : state)
        self.pendingCall = pendingCall
    }
    var text: String {
        let label = state == "pausedForInput" ? "microphone changed; Resume required" : (state == "rebuilding" ? "Reconnecting" : state)
        return "Naya: \(label)" + (pendingCall ? "; Naya is calling" : "")
    }
    var symbol: String {
        switch state {
        case "listening": return "mic.fill"
        case "speaking": return "waveform"
        case "muted": return "mic.slash.fill"
        case "connecting", "rebuilding": return "ellipsis.circle"
        case "pausedForInput": return "pause.circle"
        default: return "mic.slash"
        }
    }
}
/// The same explicit owner actions serve menu and shortcuts. Show has no capture authority.
final class NativeSummonActions {
    private let showWindow: () -> Void
    private let isCapturing: () -> Bool
    private let startLive: () -> Void
    private let muteLive: () -> Void
    private let stopLive: () -> Void
    init(show: @escaping () -> Void, isCapturing: @escaping () -> Bool, start: @escaping () -> Void,
         mute: @escaping () -> Void, stop: @escaping () -> Void) {
        showWindow = show; self.isCapturing = isCapturing
        startLive = start; muteLive = mute; stopLive = stop
    }
    func show() { showWindow() }
    func start() { showWindow(); guard !isCapturing() else { return }; startLive() }
    func mute() { muteLive() }
    func stop() { stopLive() }
}
struct LiveShortcutRegistration {
    let startStatus: String
    let muteStatus: String
    init(register: (_ key: Int, _ id: UInt32) -> Int32) {
        startStatus = ShortcutStatus.describe(code: register(kVK_ANSI_L, 1))
        muteStatus = ShortcutStatus.describe(code: register(kVK_ANSI_M, 2))
    }
}
/// Control-Option-Shift-L starts/shows Live; Control-Option-Shift-M mutes.
/// Each registration and Carbon event identity is independent of Show/hide.
@MainActor final class NativeShortcuts {
    private var references: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    var onStart: (() -> Void)?
    var onMute: (() -> Void)?
    private(set) var startStatus = "Not registered"
    private(set) var muteStatus = "Not registered"
    func register() {
        var specification = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var identity = EventHotKeyID()
            guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                    MemoryLayout<EventHotKeyID>.size, nil, &identity) == noErr,
                  identity.signature == 0x4E415941 else { return OSStatus(eventNotHandledErr) }
            let id = identity.id
            DispatchQueue.main.async {
                let owner = Unmanaged<NativeShortcuts>.fromOpaque(context).takeUnretainedValue()
                if id == 1 { owner.onStart?() } else if id == 2 { owner.onMute?() }
            }
            return noErr
        }, 1, &specification, Unmanaged.passUnretained(self).toOpaque(), &handler)
        func registerKey(_ key: Int, _ id: UInt32) -> Int32 {
            guard installed == noErr else { return installed }
            var reference: EventHotKeyRef?
            let code = RegisterEventHotKey(UInt32(key), UInt32(controlKey | optionKey | shiftKey),
                EventHotKeyID(signature: 0x4E415941, id: id), GetApplicationEventTarget(), 0, &reference)
            if let reference { references.append(reference) }
            return code
        }
        let registration = LiveShortcutRegistration(register: registerKey)
        startStatus = registration.startStatus
        muteStatus = registration.muteStatus
    }
    func unregister() {
        for reference in references { UnregisterEventHotKey(reference) }
        references.removeAll()
        if let handler { RemoveEventHandler(handler) }; handler = nil
    }
}
