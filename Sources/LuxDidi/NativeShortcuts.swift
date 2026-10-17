import Foundation
import Carbon

enum NativeNoteAction { static let label = "Save note" }
enum ShortcutStatus {
    static func describe(code: Int32) -> String {
        code == 0 ? "registered" : "Unavailable (OSStatus \(code)); use the menu bar"
    }
}
extension NotificationCapability {
    var presentation: String {
        switch self {
        case .notDetermined: return "Not asked yet"
        case .authorized, .provisional: return "Allowed"
        case .denied: return "Off: use the menu bar badge"
        case .unknown: return "Unavailable: use the menu bar badge"
        }
    }
}
struct LiveStatusPresentation {
    let pendingCall: Bool
    let text: String
    let symbol: String
    init(presentation: (text: String, symbol: String), pendingCall: Bool, dictationCapturing: Bool = false) {
        self.pendingCall = pendingCall
        text = "Naya: " + (dictationCapturing ? "Dictating" : presentation.text) + (pendingCall ? "; Naya is calling" : "")
        symbol = dictationCapturing ? "mic.fill" : presentation.symbol
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
    let windowStatus: String
    init(register: (_ key: Int, _ id: UInt32) -> Int32) {
        startStatus = ShortcutStatus.describe(code: register(kVK_ANSI_L, 1))
        muteStatus = ShortcutStatus.describe(code: register(kVK_ANSI_M, 2))
        windowStatus = ShortcutStatus.describe(code: register(kVK_Space, 3))
    }
}
/// Control-Option-Shift-L starts/shows Live; Control-Option-Shift-M mutes;
/// Control-Option-Shift-Space toggles the full window (Ctrl-Option-Space now
/// toggles the mini orb).
/// Each registration and Carbon event identity is independent of Show/hide.
@MainActor final class NativeShortcuts {
    private var references: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    var onStart: (() -> Void)?
    var onMute: (() -> Void)?
    var onWindow: (() -> Void)?
    private(set) var startStatus = "Not registered"
    private(set) var muteStatus = "Not registered"
    private(set) var windowStatus = "Not registered"
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
                if id == 1 { owner.onStart?() } else if id == 2 { owner.onMute?() } else if id == 3 { owner.onWindow?() }
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
        windowStatus = registration.windowStatus
    }
    func unregister() {
        for reference in references { UnregisterEventHotKey(reference) }
        references.removeAll()
        if let handler { RemoveEventHandler(handler) }; handler = nil
    }
}
