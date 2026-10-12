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
    var text: String { "Naya: \(state)" + (pendingCall ? "; Naya is calling" : "") }
    var symbol: String {
        switch state {
        case "listening": return "mic.fill"
        case "speaking": return "waveform"
        case "muted": return "mic.slash.fill"
        case "connecting": return "ellipsis.circle"
        default: return "mic.slash"
        }
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
        func registerKey(_ key: Int, id: UInt32) -> String {
            guard installed == noErr else { return ShortcutStatus.describe(code: installed) }
            var reference: EventHotKeyRef?
            let code = RegisterEventHotKey(UInt32(key), UInt32(controlKey | optionKey | shiftKey),
                EventHotKeyID(signature: 0x4E415941, id: id), GetApplicationEventTarget(), 0, &reference)
            if let reference { references.append(reference) }
            return ShortcutStatus.describe(code: code)
        }
        startStatus = registerKey(kVK_ANSI_L, id: 1)
        muteStatus = registerKey(kVK_ANSI_M, id: 2)
    }
    func unregister() {
        for reference in references { UnregisterEventHotKey(reference) }
        references.removeAll()
        if let handler { RemoveEventHandler(handler) }; handler = nil
    }
}
