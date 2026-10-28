import Foundation
#if DIDI_OWNER_MODULE
import DidiOwner
#endif

private final class NativeLiveNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Uses the companion's current credential and connection guard, never a second credential store.
struct NativePendingLiveJob: Decodable, Equatable, Sendable {
    let id: String
    let state: String
    let markdown: String
    var isReady: Bool { state == "completed" || state == "failed" || state == "unknown" }
}

@MainActor final class NativeLiveOperatorHTTP: LiveOperatorHTTP, LiveAuthenticatedRequestFactory {
    private struct Envelope<T: Decodable>: Decodable { let data: T }
    private struct Host: Decodable { let assistantId: String; let authorityEpoch: String }
    struct Profile: Decodable {
        let status: String
        let provider: String?
        let model: String?
        let voice: String?
        let profileIdentity: String?
        let dataClasses: [String]?
        let limits: NativeLiveLimits?
        let playbackRate: Double?
    }
    let origin: URL
    private let build: NativeLiveRequestBuilder
    private let pickupJobID: String?
    private let alarmID: String?
    private var pickupCreateKey: String?
    private let session: URLSession
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), pickupJobID: String? = nil, alarmID: String? = nil, configuration: URLSessionConfiguration? = nil) {
        self.pickupJobID = pickupJobID
        self.alarmID = alarmID
        origin = authority.origin
        build = authority.request
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCache = nil; config.urlCredentialStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8; config.timeoutIntervalForResource = 12
        session = URLSession(configuration: config, delegate: NativeLiveNoRedirect(), delegateQueue: nil)
    }
    /// Closed, non-textual telemetry only; the owner's native failure remains authoritative.
    func postPrecreateFailure(_ error: Error, using diagnosticSession: URLSession? = nil) async {
        let code: String
        if error is URLError { code = "service_unreachable" }
        else if error is DecodingError { code = "unexpected_response" }
        else if let reason = error as? LiveClientError { code = reason.rawValue }
        else if let audio = error as? NativeLiveAudioError { code = audio.httpDiagnosticCode }
        else { code = "connection_refused" }
        var body: [String: Any] = ["event": "live_precreate_failed",
                                   "failureClass": error is NativeLiveAudioError ? "audio" : "service", "code": code]
        if let reason = error as? LiveClientError {
            switch reason {
            case .http(let status, _): body["detail"] = status
            case .socketClosed(let code, _): body["detail"] = code
            default: break
            }
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            var request = try build(origin.appendingPathComponent("api/v1/diagnostics/client"), nil)
            request.httpMethod = "POST"; request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            _ = try await (diagnosticSession ?? session).data(for: request)
        } catch {
            // Best effort, including 429: no retry and no replacement of the native log or sentence.
        }
    }
    deinit { session.invalidateAndCancel() }
    private func fetch(_ path: String, epoch: String?, method: String = "GET", body: Data? = nil,
                       key: String? = nil, cursor: Int? = nil) async throws -> Data {
        var parts = URLComponents(url: origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if let cursor { parts.queryItems = [URLQueryItem(name: "cursor", value: String(cursor))] }
        var request = try build(parts.url!, epoch)
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url else { throw LiveClientError.transport }
        guard (200..<300).contains(response.statusCode) else {
            let object = data.count <= 4096 ? (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] : nil
            let error = object?["error"] as? [String: Any]
            throw LiveClientError.http(status: response.statusCode, code: LiveClientError.boundedCode(error?["code"] as? String))
        }
        guard data.count < 2 * 1024 * 1024 else { throw LiveClientError.transport }
        return data
    }
    private(set) var limits: NativeLiveLimits?
    /// P3: the live config's pitch-preserving pace, read beside the limits before the graph is built.
    private(set) var playbackRate: Double?
    func configuredLimits() async throws -> NativeLiveLimits? {
        _ = try await projection(epoch: nil)
        return limits
    }
    /// P3: the pace for the session that is about to start. A host that cannot answer leaves it nil,
    /// and the device plays at 1.0 rather than refusing to speak.
    func configuredPlaybackRate() async throws -> Double? {
        _ = try await projection(epoch: nil)
        return playbackRate
    }
    private func projection(epoch: String?) async throws -> LiveOperatorStatus {
        let host = try JSONDecoder().decode(Envelope<Host>.self, from: await fetch("/api/v1/status", epoch: epoch)).data
        let profile = try JSONDecoder().decode(Envelope<Profile>.self, from: await fetch("/api/v1/live/status", epoch: host.authorityEpoch)).data
        limits = profile.limits
        playbackRate = profile.playbackRate
        guard profile.status == "configured", let provider = profile.provider, let model = profile.model,
              let voice = profile.voice, let identity = profile.profileIdentity, let classes = profile.dataClasses,
              epoch == nil || epoch == host.authorityEpoch else { throw LiveClientError.unavailable }
        return LiveOperatorStatus(origin: origin, assistantID: host.assistantId, authorityEpoch: host.authorityEpoch,
                                  provider: provider, model: model, voice: voice, profileIdentity: identity, dataClasses: classes)
    }
    func beginIntent(inputClass: String = "ordinary") async throws -> LiveBeginIntent {
        let status = try await projection(epoch: nil)
        guard status.dataClasses.contains(inputClass) else { throw LiveClientError.grantMismatch }
        return LiveBeginIntent(origin: origin, assistantID: status.assistantID, authorityEpoch: status.authorityEpoch,
                               provider: status.provider, model: status.model, voice: status.voice,
                               profileIdentity: status.profileIdentity, inputClass: inputClass)
    }
    func status(for intent: LiveBeginIntent) async throws -> LiveOperatorStatus {
        guard intent.origin == origin else { throw LiveClientError.invalidIntent }
        return try await projection(epoch: intent.authorityEpoch)
    }
    private func path(_ id: String) throws -> String {
        guard UUID(uuidString: id) != nil, id.lowercased() == id else { throw LiveClientError.invalidIntent }
        return "/api/v1/live-sessions/" + id
    }
    func pendingCalls() async throws -> [NativePendingLiveJob] {
        let host = try JSONDecoder().decode(Envelope<Host>.self, from: await fetch("/api/v1/status", epoch: nil)).data
        return try JSONDecoder().decode(Envelope<[NativePendingLiveJob]>.self,
            from: await fetch("/api/v1/live/jobs/pending", epoch: host.authorityEpoch)).data
    }
    // Serialized create input is a testable boundary; authentication and transport stay in fetch.
    func createBody(for intent: LiveBeginIntent, key: String) throws -> Data {
        var input = ["inputClass": intent.inputClass]
        if let pickupJobID {
            if pickupCreateKey == nil { pickupCreateKey = key }
            if pickupCreateKey == key { input["pickupJobId"] = pickupJobID }
        }
        return try JSONEncoder().encode(input)
    }
    func create(for intent: LiveBeginIntent, key: String) async throws -> LiveSnapshot {
        guard intent.origin == origin else { throw LiveClientError.invalidIntent }
        let body = try alarmID.map { try JSONEncoder().encode(["id": $0, "ownerDisplayName": NSFullUserName()]) } ?? createBody(for: intent, key: key)
        return try JSONDecoder().decode(Envelope<LiveSnapshot>.self, from: await fetch(alarmID == nil ? "/api/v1/live-sessions" : "/api/v1/alarms/session", epoch: intent.authorityEpoch, method: "POST", body: body, key: key)).data
    }
    func snapshot(sessionID: String, for intent: LiveBeginIntent) async throws -> LiveSnapshot {
        return try JSONDecoder().decode(Envelope<LiveSnapshot>.self, from: await fetch(path(sessionID), epoch: intent.authorityEpoch)).data
    }
    func journal(sessionID: String, cursor: Int?, for intent: LiveBeginIntent) async throws -> LiveJournalPage {
        guard cursor == nil || cursor! >= 0 else { throw LiveClientError.invalidIntent }
        return try JSONDecoder().decode(Envelope<LiveJournalPage>.self, from: await fetch(path(sessionID) + "/journal", epoch: intent.authorityEpoch, cursor: cursor)).data
    }
    func revoke(sessionID: String, for intent: LiveBeginIntent) async throws {
        _ = try await fetch(path(sessionID) + "/revoke", epoch: intent.authorityEpoch, method: "POST", body: Data("{}".utf8))
    }
    func request(for binding: LiveSocketBinding) async throws -> URLRequest {
        guard binding.origin == origin else { throw LiveClientError.invalidIntent }
        try LiveSocketTransport.validate(binding)
        var request = try build(origin.appendingPathComponent(binding.audioPath), binding.authorityEpoch)
        var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        parts.scheme = "ws"; request.url = parts.url
        request.setValue("127.0.0.1:" + String(binding.origin.port!), forHTTPHeaderField: "Host")
        request.setValue(binding.profileIdentity, forHTTPHeaderField: "x-didi-live-profile")
        return request
    }
}

struct NativeLiveLimits: Decodable, Sendable {
    let sessionMs: Int
    let idleMs: Int
    static func duration(_ milliseconds: Int) -> String {
        milliseconds % 60_000 == 0 ? "\(milliseconds / 60_000) min" : "\(milliseconds / 1_000) sec"
    }
    var sentence: String { "Session limit \(Self.duration(sessionMs)), idle limit \(Self.duration(idleMs))." }
}

// One presentation boundary for both direct HTTP and coordinator failures.
enum NativeLivePresentation {
    static func failure(_ error: Error) -> String {
        if error is URLError { return "Live service is unreachable. Reconnect the service and try again." }
        if error is DecodingError { return "Live service returned an unexpected response. Reconnect the service and try again." }
        if let reason = error as? LiveClientError {
            switch reason {
            case .transport: return "Live service is unreachable. Reconnect the service and try again."
            case .unavailable, .grantMismatch, .statusMismatch, .invalidIntent:
                return "Live voice is not configured. Check the Live service settings."
            case .http, .socketClosed: return reason.errorDescription!
            case .conflict: return "Another Live session is already active. Stop it before starting again."
            case .invalidFrame: return "Live service returned an unexpected response. Reconnect the service and try again."
            case .invalidAudio: return "Live audio format is unsupported. Check the audio device."
            case .queueOverflow: return "Live audio could not keep up. Stop and start again."
            case .staleOperation: return "The Live request was superseded. Start again when ready."
            case .invalidDestination, .forbiddenHeader: return "The Live service connection was refused. Reconnect in Settings."
            }
        }
        // Device and owner errors have closed, locally authored descriptions.
        if let audio = error as? NativeLiveAudioError { return audio.errorDescription! }
        let name = String(describing: type(of: error))
        if name == "CompanionError",
           let text = (error as? LocalizedError)?.errorDescription { return text }
        return "Live voice could not start. Reconnect the service and try again."
    }
    static func ended(_ code: String?, limits: NativeLiveLimits?) -> String? {
        switch code {
        case "resume_failed":
            return "Naya's connection could not be resumed. Start Live again."
        case "provider_recovery_exhausted":
            return "Connection lost. Tap to reconnect."
        case "session_timeout":
            return "Session limit reached" + (limits.map { " (\(NativeLiveLimits.duration($0.sessionMs)))" } ?? "") + ". Start again to continue."
        case "idle_timeout":
            return "Ended after " + (limits.map { NativeLiveLimits.duration($0.idleMs) } ?? "the idle limit") + " without speech. Start again when ready."
        default: return nil
        }
    }
}

enum NativeLiveAudioError: LocalizedError {
    case unsupportedFormat, allocationFailed, converterUnavailable, permissionDenied, permissionRestricted
    case deviceMissing, formatUnavailable, captureNotConfigured
    case voiceProcessingFailed(code: Int?)
    case engineFormatMismatch(code: Int), engineFailed(code: Int)

    var rawValue: String {
        switch self {
        case .unsupportedFormat: return "unsupportedFormat"
        case .allocationFailed: return "allocationFailed"
        case .converterUnavailable: return "converterUnavailable"
        case .permissionDenied: return "permissionDenied"
        case .permissionRestricted: return "permissionRestricted"
        case .deviceMissing: return "device_missing"
        case .formatUnavailable: return "format_unavailable"
        case .captureNotConfigured: return "capture_not_configured"
        case .voiceProcessingFailed: return "voice_processing_failed"
        case .engineFormatMismatch: return "engine_format_mismatch"
        case .engineFailed: return "engine_failed"
        }
    }
    /// The service route has a fixed legacy vocabulary and admits no audio detail.
    /// Keep precise step/status in the local journal and typed owner presentation instead.
    var httpDiagnosticCode: String {
        switch self {
        case .formatUnavailable, .engineFormatMismatch: return "unsupportedFormat"
        case .voiceProcessingFailed: return "voiceProcessingUnavailable"
        case .deviceMissing, .captureNotConfigured, .engineFailed: return "deviceUnavailable"
        default: return rawValue
        }
    }
    /// Local journal only: a numeric OSStatus/NSError code, never an error or device label.
    var diagnosticDetail: Int? {
        switch self {
        case .voiceProcessingFailed(let code): return code
        case .engineFormatMismatch(let code), .engineFailed(let code): return code
        default: return nil
        }
    }
    static func engineFailure(_ error: NSError) -> NativeLiveAudioError {
        // FormatNotSupported is exact; FailedInitialization has multiple possible causes.
        if error.domain == "com.apple.coreaudio.avfaudio", error.code == -10868 {
            return .engineFormatMismatch(code: error.code)
        }
        return .engineFailed(code: error.code)
    }
    var errorDescription: String? {
        switch self {
        case .unsupportedFormat: return "Live audio format is unsupported."
        case .allocationFailed: return "Live audio buffer could not be allocated."
        case .converterUnavailable: return "Live microphone format could not be converted."
        case .permissionDenied: return "Microphone permission was denied. Allow microphone access in System Settings."
        case .permissionRestricted: return "Microphone access is restricted. Check this Mac’s privacy restrictions."
        case .deviceMissing: return "No microphone found: connect one or select it in System Settings, Sound, Input."
        case .formatUnavailable: return "Live audio format is unavailable; select a working microphone and output device."
        case .captureNotConfigured: return "Live microphone capture is not configured; start Live again."
        case .voiceProcessingFailed: return "Voice processing could not be enabled; check the microphone and output device."
        case .engineFormatMismatch: return "Live audio could not start because the microphone and output formats do not match; select a working output device."
        case .engineFailed: return "Live audio engine could not start; check the microphone and output device."
        }
    }
}
