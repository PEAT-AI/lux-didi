import Foundation

enum NotificationCapability: String {
    case notDetermined, denied, authorized, provisional, unknown
    var canSchedule: Bool { self == .authorized || self == .provisional }
}
enum AdapterResult: Equatable { case acknowledged, failed(String), unknown(String) }
struct ReminderLink: Equatable { let commitmentID: String; let revision: Int }
struct ReminderEnvelope {
    let commitmentID: String
    let revision: Int
    let title: String
    let body: String
    var identifier: String { "commitment.\(commitmentID).r\(revision)" }
    var userInfo: [String: String] { ["commitmentID": commitmentID, "revision": String(revision), "destination": "conversation"] }
    static func decode(_ info: [String: String]) -> ReminderLink? {
        guard info["destination"] == "conversation", let id = info["commitmentID"], !id.isEmpty,
              let value = info["revision"], let revision = Int(value), revision > 0 else { return nil }
        return ReminderLink(commitmentID: id, revision: revision)
    }
}
enum PermissionState: String { case notDetermined, denied, granted, restricted, unknown }
enum RecordingPhase: String { case idle, recording, failed }
struct VoiceState {
    private(set) var phase: RecordingPhase = .idle
    private(set) var transcript = ""
    private(set) var detail = "Voice is off. Text is always available."
    mutating func start(microphone: PermissionState, speech: PermissionState, onDevice: Bool) -> Bool {
        guard microphone == .granted, speech == .granted else { fail("Microphone and speech permissions are required. Use Settings to enable them."); return false }
        guard onDevice else { fail("On-device recognition is unavailable for this locale. Audio will not be sent to the cloud."); return false }
        transcript = ""; phase = .recording; detail = "Recording on device · Escape or Stop to finish"
        return true
    }
    mutating func receive(_ text: String) { if phase == .recording { transcript = text } }
    mutating func stop(reason: String) { phase = .idle; detail = "Stopped: \(reason). Review the text before sending." }
    mutating func fail(_ reason: String) { phase = .failed; detail = reason }
}
enum Presentation {
    static func canSend(_ text: String) -> Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    static func notificationResult(_ result: AdapterResult) -> String {
        switch result {
        case .acknowledged: return "Accepted by macOS — not proof of delivery or that you read it. Focus may silence it."
        case .failed(let detail): return "Failed: \(detail)"
        case .unknown(let detail): return "Unknown: \(detail)"
        }
    }
}
