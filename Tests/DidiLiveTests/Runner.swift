import AudioToolbox
import Foundation
@testable import DidiOwner

// Session-local HTTP fixture, never installs a global URLProtocol or uses the network.
final class PendingCallsFixture: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var responses: [Result<Data, URLError>] = []
    static func load(_ values: [Result<Data, URLError>]) { lock.withLock { responses = values } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let result = Self.lock.withLock { Self.responses.isEmpty ? .failure(URLError(.badServerResponse)) : Self.responses.removeFirst() }
        switch result {
        case .failure(let error): client?.urlProtocol(self, didFailWithError: error)
        case .success(let data):
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

struct Envelope<Value: Decodable>: Decodable { let data: Value }
struct HostStatus: Decodable { let assistantId: String; let authorityEpoch: String }
struct StatusWire: Decodable {
    let status: String; let provider: String?; let model: String?; let voice: String?
    let profileIdentity: String?; let dataClasses: [String]?
}

// In-process HTTP fixture: captures the complete request, without a real timeout or server.
final class DiagnosticHTTPFixture: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: [URLRequest] = []
    nonisolated(unsafe) private static var status: Int? = 204
    static func reset(status: Int?) { lock.lock(); defer { lock.unlock() }; requests = []; self.status = status }
    static func captured() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "diagnostic.fixture" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var bytes = [UInt8](repeating: 0, count: 512)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }; data.append(contentsOf: bytes.prefix(count))
            }
            captured.httpBody = data
        }
        Self.lock.lock(); Self.requests.append(captured); let status = Self.status; Self.lock.unlock()
        if let status {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        } else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    }
    override func stopLoading() {}
}

@MainActor func checkClientDiagnostics() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [DiagnosticHTTPFixture.self]
    config.httpCookieStorage = nil; config.httpShouldSetCookies = false
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let origin = URL(string: "http://diagnostic.fixture")!
    let http = NativeLiveOperatorHTTP(authority: (origin, { url, _ in
        var request = URLRequest(url: url)
        request.setValue("Bearer synthetic-operator", forHTTPHeaderField: "Authorization")
        return request
    }))
    let cases: [(Error, String, String, Int?)] = [
        (NativeLiveAudioError.permissionDenied, "audio", "permissionDenied", nil),
        (NativeLiveAudioError.permissionRestricted, "audio", "permissionRestricted", nil),
        (NativeLiveAudioError.unsupportedFormat, "audio", "unsupportedFormat", nil),
        (NativeLiveAudioError.allocationFailed, "audio", "allocationFailed", nil),
        (NativeLiveAudioError.converterUnavailable, "audio", "converterUnavailable", nil),
        (NativeLiveAudioError.deviceMissing, "audio", "deviceUnavailable", nil),
        (NativeLiveAudioError.formatUnavailable, "audio", "unsupportedFormat", nil),
        (NativeLiveAudioError.captureNotConfigured, "audio", "deviceUnavailable", nil),
        (NativeLiveAudioError.voiceProcessingFailed(code: nil), "audio", "voiceProcessingUnavailable", nil),
        (NativeLiveAudioError.voiceProcessingFailed(code: -50), "audio", "voiceProcessingUnavailable", nil),
        (NativeLiveAudioError.engineFormatMismatch(code: -10868), "audio", "unsupportedFormat", nil),
        (NativeLiveAudioError.engineFailed(code: -10875), "audio", "deviceUnavailable", nil),
        (NativeLiveAudioError.engineFailed(code: -50), "audio", "deviceUnavailable", nil),
        (LiveClientError.invalidAudio, "service", "invalidAudio", nil),
        (URLError(.cannotConnectToHost), "service", "service_unreachable", nil),
        (LiveClientError.http(status: 503, code: "private text"), "service", "http", 503),
        (LiveClientError.socketClosed(code: 1006, reason: "private text"), "service", "socketClosed", 1006),
        (DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "private path")), "service", "unexpected_response", nil),
        (ProbeError.assertion("private error"), "service", "connection_refused", nil),
    ]
    // Exact server/http/routes.ts audio allowlist; the audio branch admits no detail key.
    let routeAudioCodes: Set<String> = ["unsupportedFormat", "allocationFailed", "converterUnavailable",
        "permissionDenied", "permissionRestricted", "voiceProcessingUnavailable", "deviceUnavailable"]
    for status in [204, 429, nil] as [Int?] {
        for (error, failureClass, code, detail) in cases {
            DiagnosticHTTPFixture.reset(status: status)
            let sentence = NativeLivePresentation.failure(error)
            await http.postPrecreateFailure(error, using: session)
            let requests = DiagnosticHTTPFixture.captured()
            try require(requests.count == 1, "diagnostic is attempted exactly once, including rate limit and transport failure")
            let request = requests[0]
            try require(request.url == origin.appendingPathComponent("api/v1/diagnostics/client") && request.httpMethod == "POST", "diagnostic route and method")
            try require(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-operator" && request.value(forHTTPHeaderField: "Cookie") == nil, "operator bearer without cookies")
            var expected: [String: Any] = ["event": "live_precreate_failed", "failureClass": failureClass, "code": code]
            if let detail { expected["detail"] = detail }
            let body = try JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys])
            if failureClass == "audio" {
                let payload = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                try require(Set(payload.keys) == ["event", "failureClass", "code"] && routeAudioCodes.contains(payload["code"] as? String ?? ""),
                            "every audio case produces exactly the route's accepted closed schema without detail")
            }
            try require(request.httpBody == body && body.count <= 512, "exact closed diagnostic body, no textual details")
            try require(NativeLivePresentation.failure(error) == sentence, "diagnostic failures cannot replace the typed sentence")
        }
    }
}

/// A one way flag a probe task sets when it has reached its point.
actor Flag {
    private(set) var set = false
    func mark() { set = true }
}

actor Gate {
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private(set) var arrivals = 0
    func wait() async { arrivals += 1; await withCheckedContinuation { continuations.append($0) } }
    func release() { let pending = continuations; continuations = []; for continuation in pending { continuation.resume() } }
}

actor TestHTTP: LiveOperatorHTTP {
    let fixture: Fixture
    let session = isolatedSession()
    var loseCreate = false
    var unreachableStatus = false
    func makeStatusUnreachable() { unreachableStatus = true }
    var wrongGrant = false
    var wrongEpoch = false
    var wrongStatus = false
    var wrongScope = false
    var failSnapshot = false
    var snapshotGate: Gate?
    var statusGate: Gate?
    var lastCreated: LiveSnapshot?
    private(set) var keys: [String] = []
    private(set) var requests = 0
    init(_ fixture: Fixture) { self.fixture = fixture }
    func configure(loss: Bool = false, grant: Bool = false, epoch: Bool = false, gate: Gate? = nil,
                   status: Bool = false, failRead: Bool = false, readGate: Gate? = nil, scope: Bool = false) {
        loseCreate = loss; wrongGrant = grant; wrongEpoch = epoch; statusGate = gate
        wrongStatus = status; failSnapshot = failRead; snapshotGate = readGate; wrongScope = scope
    }
    func finish() { session.invalidateAndCancel() }
    func raw(_ path: String, method: String = "GET", key: String? = nil, body: Data? = nil) async throws -> Data {
        requests += 1
        var request = URLRequest(url: URL(string: fixture.origin + path)!)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer " + fixture.token, forHTTPHeaderField: "Authorization")
        request.setValue(fixture.authorityEpoch, forHTTPHeaderField: "x-didi-authority-epoch")
        if let key { request.setValue(key, forHTTPHeaderField: "idempotency-key") }
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw LiveClientError.transport }
        if response.statusCode == 409 { throw LiveClientError.conflict }
        guard (200...299).contains(response.statusCode), data.count < 2 * 1024 * 1024 else { throw LiveClientError.unavailable }
        return data
    }
    func status(for intent: LiveBeginIntent) async throws -> LiveOperatorStatus {
        if unreachableStatus { throw URLError(.cannotConnectToHost) }
        let host = try JSONDecoder().decode(Envelope<HostStatus>.self, from: await raw("/api/v1/status")).data
        let live = try JSONDecoder().decode(Envelope<StatusWire>.self, from: await raw("/api/v1/live/status")).data
        guard live.status == "configured", let provider = live.provider, let model = live.model,
              let voice = live.voice, let profile = live.profileIdentity, let classes = live.dataClasses else { throw LiveClientError.unavailable }
        let gate = statusGate; statusGate = nil
        if let gate { await gate.wait() } // deliberately late response: generation fence must reject it
        return LiveOperatorStatus(origin: URL(string: fixture.origin)!, assistantID: host.assistantId,
                                  authorityEpoch: host.authorityEpoch, provider: provider, model: wrongStatus ? "wrong-model" : model, voice: voice,
                                  profileIdentity: profile, dataClasses: classes)
    }
    func create(for intent: LiveBeginIntent, key: String) async throws -> LiveSnapshot {
        keys.append(key)
        let body = try JSONEncoder().encode(["inputClass": intent.inputClass])
        let snapshot = try JSONDecoder().decode(Envelope<LiveSnapshot>.self, from: await raw("/api/v1/live-sessions", method: "POST", key: key, body: body)).data
        lastCreated = snapshot
        if loseCreate { loseCreate = false; throw LiveClientError.transport }
        let grant = snapshot.grant
        return LiveSnapshot(liveSessionId: snapshot.liveSessionId, assistantId: snapshot.assistantId,
                            authorityEpoch: wrongEpoch ? "wrong-epoch" : snapshot.authorityEpoch,
                            idempotencyKey: snapshot.idempotencyKey, profileIdentity: snapshot.profileIdentity,
                            grant: LiveGrant(provider: grant.provider, model: wrongGrant ? "wrong-model" : grant.model,
                                             voice: grant.voice, chosenInputClass: grant.chosenInputClass,
                                             permittedClasses: wrongScope ? grant.permittedClasses + ["sensitive"] : grant.permittedClasses, revision: grant.revision),
                            lifecycle: snapshot.lifecycle, dispatchIntent: snapshot.dispatchIntent,
                            consumerState: snapshot.consumerState, terminal: snapshot.terminal)
    }
    func snapshot(sessionID: String, for intent: LiveBeginIntent) async throws -> LiveSnapshot {
        if failSnapshot { throw LiveClientError.transport }
        let snapshot = try JSONDecoder().decode(Envelope<LiveSnapshot>.self, from: await raw("/api/v1/live-sessions/" + sessionID)).data
        let gate = snapshotGate; snapshotGate = nil
        if let gate { await gate.wait() }
        return snapshot
    }
    func journal(sessionID: String, cursor: Int?, for intent: LiveBeginIntent) async throws -> LiveJournalPage {
        let query = cursor.map { "?cursor=" + String($0) } ?? ""
        return try JSONDecoder().decode(Envelope<LiveJournalPage>.self, from: await raw("/api/v1/live-sessions/" + sessionID + "/journal" + query)).data
    }
    func revoke(sessionID: String, for intent: LiveBeginIntent) async throws {
        _ = try await raw("/api/v1/live-sessions/" + sessionID + "/revoke", method: "POST", body: Data("{}".utf8))
    }
}

struct TestRequests: LiveAuthenticatedRequestFactory {
    let fixture: Fixture
    let alteration: String
    func request(for binding: LiveSocketBinding) async throws -> URLRequest {
        var request = fixtureRequest(fixture, binding.sessionID)
        switch alteration {
        case "cookie": request.setValue("synthetic=1", forHTTPHeaderField: "Cookie")
        case "origin": request.setValue(fixture.origin, forHTTPHeaderField: "Origin")
        case "authority": request.setValue("wrong", forHTTPHeaderField: "x-didi-authority-epoch")
        case "profile": request.setValue("wrong", forHTTPHeaderField: "x-didi-live-profile")
        case "host": request.setValue("localhost", forHTTPHeaderField: "Host")
        case "duplicate": request.setValue("Bearer synthetic, Bearer synthetic", forHTTPHeaderField: "Authorization")
        case "destination": request.url = URL(string: "ws://127.0.0.1:1" + binding.audioPath)!
        case "path": request.url = URL(string: fixture.origin.replacingOccurrences(of: "http://", with: "ws://") + "/api/v1/status")!
        default: break
        }
        return request
    }
}

actor CountedSockets: LiveSocketConnecting {
    let transport: LiveSocketTransport
    private(set) var attempts = 0
    private(set) var current: (any LiveSocket)?
    init(_ fixture: Fixture, alteration: String = "") { transport = LiveSocketTransport(requests: TestRequests(fixture: fixture, alteration: alteration)) }
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket {
        attempts += 1
        let socket = try await transport.connect(binding); current = socket; return socket
    }
    func disconnect() async { await current?.cancel() }
}

actor SilentSink: LiveAudioSink {
    private(set) var events: [String] = []
    private(set) var queued: [Data] = []
    private var flushGate: Gate?
    func gateFlush(_ gate: Gate) { flushGate = gate }
    func write(_ pcm: Data) { events.append("pcm:" + String(pcm.first!)); queued.append(pcm) }
    func flush() async {
        let gate = flushGate; flushGate = nil
        if let gate { await gate.wait() }
        events.append("flush"); queued = []
    }
}

actor GatedSocket: LiveSocket {
    let underlying: any LiveSocket
    let gate: Gate
    private var closed = false
    init(_ underlying: any LiveSocket, _ gate: Gate) { self.underlying = underlying; self.gate = gate }
    func receive() async throws -> LiveFrame { try await underlying.receive() }
    func sendPCM(_ data: Data) async throws -> Bool {
        await gate.wait()
        guard !closed else { throw LiveClientError.unavailable }
        return try await underlying.sendPCM(data)
    }
    func sendControl(_ command: LiveControl) async throws { try await underlying.sendControl(command) }
    func sendReceipt(_ frame: String) async throws { try await underlying.sendReceipt(frame) }
    func cancel() async { closed = true; await underlying.cancel(); await gate.release() }
}
struct GatedSockets: LiveSocketConnecting {
    let underlying: any LiveSocketConnecting; let gate: Gate
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { try await GatedSocket(underlying.connect(binding), gate) }
}

/// 3p: a socket that serves queued frames, holds PCM so a Stop can be sent mid-send, and records the control frames a
/// stop put on the wire.
actor StopProbeSocket: LiveSocket {
    private var frames: [LiveFrame]
    private let gate: Gate
    private var waiter: CheckedContinuation<LiveFrame, Error>?
    private(set) var controls: [LiveControl] = []
    private(set) var receipts: [String] = []
    private var closed = false
    init(_ frames: [LiveFrame], _ gate: Gate) { self.frames = frames; self.gate = gate }
    func receive() async throws -> LiveFrame {
        if !frames.isEmpty { return frames.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func sendPCM(_ data: Data) async throws -> Bool {
        await gate.wait()
        guard !closed else { throw LiveClientError.unavailable }
        return true
    }
    func sendControl(_ command: LiveControl) throws {
        guard !closed else { throw LiveClientError.unavailable }
        controls.append(command)
    }
    func sendReceipt(_ frame: String) async throws { receipts.append(frame) }
    func cancel() async {
        closed = true
        waiter?.resume(throwing: LiveClientError.transport); waiter = nil
        await gate.release()
    }
}
struct ProbeSockets: LiveSocketConnecting {
    let socket: StopProbeSocket
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { socket }
}

/// Z2: a socket whose playback receipt send is held on a gate while the microphone keeps arriving.
actor BusyWireSocket: LiveSocket {
    private var frames: [LiveFrame]
    private let gate: Gate
    private var waiter: CheckedContinuation<LiveFrame, Error>?
    private(set) var inputs: [Data] = []
    private(set) var receipts: [String] = []
    private(set) var receiptEntered = 0
    private var closed = false
    init(_ frames: [LiveFrame], _ gate: Gate) { self.frames = frames; self.gate = gate }
    func receive() async throws -> LiveFrame {
        if !frames.isEmpty { return frames.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func sendPCM(_ data: Data) throws -> Bool {
        guard !closed else { throw LiveClientError.unavailable }
        inputs.append(data); return true
    }
    func sendControl(_ command: LiveControl) {}
    func sendReceipt(_ frame: String) async {
        receiptEntered += 1
        await gate.wait()
        receipts.append(frame)
    }
    func cancel() async {
        closed = true
        waiter?.resume(throwing: LiveClientError.transport); waiter = nil
        await gate.release()
    }
}
struct BusyWireSockets: LiveSocketConnecting {
    let socket: BusyWireSocket
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { socket }
}

/// Z2: every send yields once, so a receipt and a mic frame genuinely interleave, and none is held.
actor YieldingSocket: LiveSocket {
    private var frames: [LiveFrame]
    private var waiter: CheckedContinuation<LiveFrame, Error>?
    private(set) var inputs = 0, receipts = 0, controls = 0
    init(_ frames: [LiveFrame]) { self.frames = frames }
    func receive() async throws -> LiveFrame {
        if !frames.isEmpty { return frames.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func sendPCM(_ data: Data) async -> Bool { await Task.yield(); inputs += 1; return true }
    func sendControl(_ command: LiveControl) async { await Task.yield(); controls += 1 }
    func sendReceipt(_ frame: String) async { await Task.yield(); receipts += 1 }
    func cancel() async { waiter?.resume(throwing: LiveClientError.transport); waiter = nil }
}
struct YieldingSockets: LiveSocketConnecting {
    let socket: YieldingSocket
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { socket }
}

actor ContinuitySocket: LiveSocket, LiveSocketConnecting {
    private var frames: [LiveFrame] = []
    private var waiter: CheckedContinuation<LiveFrame, Error>?
    private(set) var inputs: [Data] = []
    private(set) var controls: [LiveControl] = []
    private(set) var receipts: [String] = []
    private(set) var connections = 0
    func connect(_ binding: LiveSocketBinding) -> any LiveSocket { connections += 1; return self }
    func push(_ frame: LiveFrame) {
        if let pending = waiter { waiter = nil; pending.resume(returning: frame) }
        else { frames.append(frame) }
    }
    func receive() async throws -> LiveFrame {
        if !frames.isEmpty { return frames.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func sendPCM(_ data: Data) -> Bool { inputs.append(data); return true }
    func sendControl(_ command: LiveControl) { controls.append(command) }
    func sendReceipt(_ frame: String) { receipts.append(frame) }
    func cancel() { waiter?.resume(throwing: LiveClientError.transport); waiter = nil }
}

actor ScriptedSocket: LiveSocket {
    private var frames: [LiveFrame]
    private(set) var inputs: [Data] = []
    init(_ frames: [LiveFrame]) { self.frames = frames }
    func receive() throws -> LiveFrame {
        guard !frames.isEmpty else { throw LiveClientError.transport }
        return frames.removeFirst()
    }
    func sendPCM(_ data: Data) -> Bool { inputs.append(data); return true }
    func sendControl(_ command: LiveControl) {}
    func sendReceipt(_ frame: String) {}
    func cancel() { frames = [] }
}
struct FixedSockets: LiveSocketConnecting {
    let socket: ScriptedSocket
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { socket }
}
actor GatedPlaybackSink: LiveAudioSink {
    let gate: Gate
    init(_ gate: Gate) { self.gate = gate }
    func write(_ data: Data) async { await gate.wait() }
    func flush() {}
}
struct ScriptedSockets: LiveSocketConnecting {
    let frames: [LiveFrame]
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { ScriptedSocket(frames) }
}

func until(_ condition: @escaping @Sendable () async -> Bool) async throws {
    let clock = ContinuousClock(); let deadline = clock.now + .seconds(3)
    while !(await condition()) {
        if clock.now >= deadline { throw ProbeError.assertion("controlled timeout") }
        try await Task.sleep(for: .milliseconds(2))
    }
}
func intent(_ fixture: Fixture, inputClass: String = "ordinary") -> LiveBeginIntent {
    LiveBeginIntent(origin: URL(string: fixture.origin)!, assistantID: fixture.assistantId, authorityEpoch: fixture.authorityEpoch,
                    provider: "gemini", model: "models/native-live-synthetic", voice: "SyntheticVoice",
                    profileIdentity: fixture.profileIdentity, inputClass: inputClass)
}

@main struct NativeLiveTests {
    static func main() async {
        do {
            try await checkClientDiagnostics()
            try require(NativeLivePresentation.failure(URLError(.cannotConnectToHost)) == "Live service is unreachable. Reconnect the service and try again.", "transport failure is actionable")
            try require(NativeLivePresentation.failure(LiveClientError.transport) == NativeLivePresentation.failure(URLError(.timedOut)), "coordinator preserves transport class")
            try require(NativeLivePresentation.failure(LiveClientError.unavailable) == "Live voice is not configured. Check the Live service settings.", "unconfigured failure is actionable")
            try require(NativeLivePresentation.failure(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "private"))) == "Live service returned an unexpected response. Reconnect the service and try again.", "decoding failure never leaks response")
            for event in ["rebuilding", "resumed"] {
                let wire = "{\"type\":\"continuity\",\"sequence\":null,\"journalSequence\":2,\"event\":\"\(event)\",\"reason\":\"go_away\"}"
                _ = try LiveSocketTransport.decode(.string(wire))
            }
            let oldProfile = try JSONDecoder().decode(NativeLiveOperatorHTTP.Profile.self, from: Data("{\"status\":\"unconfigured\"}".utf8))
            try require(oldProfile.limits == nil, "old status remains decodable")
            let limits = try JSONDecoder().decode(NativeLiveLimits.self, from: Data("{\"sessionMs\":900000,\"idleMs\":60000}".utf8))
            try require(NativeLivePresentation.ended("resume_failed", limits: nil) == "Naya's connection could not be resumed. Start Live again.", "resume_failed exact typed sentence")
            try require(limits.sentence == "Session limit 15 min, idle limit 1 min.", "configured limits are plain text")
            try require(NativeLivePresentation.ended("session_timeout", limits: limits) == "Session limit reached (15 min). Start again to continue.", "session limit explains next action")
            try require(NativeLivePresentation.ended("idle_timeout", limits: limits) == "Ended after 1 min without speech. Start again when ready.", "idle limit explains next action")
            let split: [(NativeLiveAudioError, String, String)] = [
                (.deviceMissing, "device_missing", "No microphone found: connect one or select it in System Settings, Sound, Input."),
                (.formatUnavailable, "format_unavailable", "Live audio format is unavailable; select a working microphone and output device."),
                (.captureNotConfigured, "capture_not_configured", "Live microphone capture is not configured; start Live again."),
                (.voiceProcessingFailed(code: -50), "voice_processing_failed", "Voice processing could not be enabled; check the microphone and output device."),
                (.engineFormatMismatch(code: -10868), "engine_format_mismatch", "Live audio could not start because the microphone and output formats do not match; select a working output device."),
                (.engineFailed(code: -50), "engine_failed", "Live audio engine could not start; check the microphone and output device.")
            ]
            for (audio, code, sentence) in split {
                try require(audio.rawValue == code && NativeLivePresentation.failure(audio) == sentence, "distinct step code and owner sentence")
            }
            try require(kAudioUnitErr_FailedInitialization == -10875 && kAudioUnitErr_FormatNotSupported == -10868,
                        "installed SDK keeps FailedInitialization distinct from FormatNotSupported")
            try require(NativeLiveAudioError.engineFailure(NSError(domain: "com.apple.coreaudio.avfaudio", code: -10868)).rawValue == "engine_format_mismatch", "exact AVFAudio unsupported-format status retains format diagnosis")
            try require(NativeLiveAudioError.engineFailure(NSError(domain: "com.apple.coreaudio.avfaudio", code: -10875)).rawValue == "engine_failed", "generic AVFAudio failed initialization is not guessed to be a format mismatch")
            let misleading = NSError(domain: "com.apple.coreaudio.avfaudio", code: -10875,
                userInfo: [NSLocalizedDescriptionKey: "client-side input and output formats do not match"])
            try require(NativeLiveAudioError.engineFailure(misleading).rawValue == "engine_failed", "localized format wording cannot override the exact status classification")
            try require(NativeLiveAudioError.engineFailure(NSError(domain: "unrelated", code: -10868)).rawValue == "engine_failed", "numeric coincidence outside AVFAudio is not a format diagnosis")
            try require(NativeLiveAudioError.engineFailure(NSError(domain: "other", code: -50)).rawValue == "engine_failed", "other start failures are not masked as format mismatch")
            for audio in [NativeLiveAudioError.permissionDenied, .permissionRestricted, .voiceProcessingFailed(code: nil), .deviceMissing, .unsupportedFormat, .allocationFailed, .converterUnavailable] {
                try require(NativeLivePresentation.failure(audio) == audio.errorDescription, "each real audio error keeps its typed sentence")
            }
            try require(NativeLivePresentation.failure(LiveClientError.http(status: 503, code: "not_ready")) == "Live service HTTP 503: not_ready.", "HTTP failure remains typed")
            let httpReason = LiveClientError.http(status: 403, code: "profile_denied")
            try require(httpReason.errorDescription == "Live service HTTP 403: profile_denied.", "HTTP status and typed code are visible")
            let closeReason = LiveClientError.socketClosed(code: 1008, reason: "attach_rejected:internal")
            try require(closeReason.errorDescription == "Live socket closed (1008): attach_rejected:internal.", "socket close reason is visible")
            try require(LiveClientError.boundedCloseReason(Data("attach_rejected:internal\nSECRET".utf8)) == nil, "unsafe multiline reason rejected")
            try require(LiveClientError.transport.errorDescription == nil, "unknown transport keeps generic fallback")

            let fixture = try JSONDecoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile())
            let pendingWire = Data("[{\"id\":\"job1\",\"state\":\"in_progress\",\"markdown\":\"Working\"},{\"id\":\"job2\",\"state\":\"failed\",\"markdown\":\"Actual failure\"}]".utf8)
            let pendingCalls = try JSONDecoder().decode([NativePendingLiveJob].self, from: pendingWire)
            try require(!pendingCalls[0].isReady && pendingCalls[1].isReady, "only a completed or failed job offers a quiet callback")
            try require(pendingCalls[1].markdown == "Actual failure", "native callback never turns a failure into success")

            if CommandLine.arguments.contains("--child-before-intent") || CommandLine.arguments.contains("--child-after-intent") {
                let http = TestHTTP(fixture)
                let client = LiveSessionCoordinator(http: http, sockets: CountedSockets(fixture), sink: SilentSink())
                let before = CommandLine.arguments.contains("--child-before-intent")
                if before { await http.configure(loss: true) }
                await client.begin(intent(fixture))
                if before { try require(await client.state == .createUnknown, "child before dispatch") }
                else { try await until { await client.state == .active } }
                guard let snapshot = await http.lastCreated else { throw ProbeError.assertion("child server identity") }
                let report = try JSONEncoder().encode(["id": snapshot.liveSessionId])
                FileHandle.standardOutput.write(report + Data("\n".utf8))
                await Gate().wait() // parent owns a bounded readiness/kill protocol, no autonomous client requests
                return
            }
            for code in ["provider_setup_rejected", "protocol_error"] {
                let frame = try LiveSocketTransport.decode(.string("{\"type\":\"terminal\",\"state\":\"failed\",\"code\":\"\(code)\",\"complete\":true}"))
                guard case .terminal(let terminal, _) = frame else { throw ProbeError.assertion("typed terminal frame") }
                try require(terminal.code == code, "provider terminal code retained")
            }
            if CommandLine.arguments.contains("--mutation") {
                // Compiled mutated transport only removes Cookie preflight. Behavioral check must catch that at the real host.
                let transport = LiveSocketTransport(requests: TestRequests(fixture: fixture, alteration: "cookie"))
                let http = TestHTTP(fixture)
                let snapshot = try await http.create(for: intent(fixture), key: "mutation-cookie-guard")
                var refusedBeforeTask = false
                do { _ = try await transport.connect(LiveSocketBinding(origin: URL(string: fixture.origin)!, sessionID: snapshot.liveSessionId,
                                                                       authorityEpoch: fixture.authorityEpoch, profileIdentity: fixture.profileIdentity)) }
                catch LiveClientError.forbiddenHeader { refusedBeforeTask = true }
                await http.finish()
                try require(refusedBeforeTask, "mutation sensitivity: cookie must be rejected before URLSession task")
                print("PASS cookie preflight sensitivity baseline")
                return
            }
            let unreachableHTTP = TestHTTP(fixture)
            await unreachableHTTP.makeStatusUnreachable()
            let unreachableSockets = CountedSockets(fixture)
            let unreachableClient = LiveSessionCoordinator(http: unreachableHTTP, sockets: unreachableSockets, sink: SilentSink())
            await unreachableClient.begin(intent(fixture))
            let unreachableState = await unreachableClient.state
            try require(unreachableState == .failed(.transport), "coordinator preserves unreachable status transport cause")
            guard case .failed(let unreachableReason) = unreachableState else {
                throw ProbeError.assertion("unreachable status must fail before CREATE")
            }
            try require(NativeLivePresentation.failure(unreachableReason) == "Live service is unreachable. Reconnect the service and try again.", "coordinator failure renders actionable transport sentence, not generic fallback")
            try require(await unreachableHTTP.requests == 0, "unreachable status issues no CREATE request")
            try require(await unreachableSockets.attempts == 0, "unreachable status opens no socket")
            await unreachableHTTP.finish()

            var previous = ContinuousClock.now
            var durations: [(String, Duration)] = []
            func record(_ name: String) {
                let now = ContinuousClock.now; durations.append((name, previous.duration(to: now))); previous = now
            }
            let frozen = intent(fixture)
            for alteration in ["cookie", "origin", "authority", "profile", "host", "duplicate", "destination", "path"] {
                let http = TestHTTP(fixture)
                let snapshot = try await http.create(for: frozen, key: "reject-client-" + alteration)
                let transport = LiveSocketTransport(requests: TestRequests(fixture: fixture, alteration: alteration))
                var refused = false
                do { _ = try await transport.connect(LiveSocketBinding(origin: frozen.origin, sessionID: snapshot.liveSessionId,
                                                                       authorityEpoch: frozen.authorityEpoch, profileIdentity: frozen.profileIdentity)) }
                catch LiveClientError.forbiddenHeader { refused = true }
                catch LiveClientError.invalidDestination { refused = true }
                try require(refused, "client destination/header guard")
                await http.finish()
            }
            print("PASS production transport eight local header/destination/path refusals with zero attach")
            record("guards")

            let (companion, nativeHTTP) = try await MainActor.run {
                let descriptor = try ServiceDescriptor(origin: fixture.origin, credentialService: "synthetic", credentialAccount: "fixture")
                let companion = CompanionClient(descriptor: descriptor, credential: { fixture.token }, expectedEpoch: fixture.authorityEpoch)
                return (companion, NativeLiveOperatorHTTP(authority: companion.authenticatedRequestBuilder()))
            }
            let callbackHTTP = await MainActor.run {
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [PendingCallsFixture.self]
                return NativeLiveOperatorHTTP(authority: companion.authenticatedRequestBuilder(), configuration: config)
            }
            let hostWire = try JSONSerialization.data(withJSONObject: ["data": ["assistantId": "naya", "authorityEpoch": fixture.authorityEpoch]])
            let callbackWire = Data("{\"data\":[{\"id\":\"ready-a\",\"state\":\"completed\",\"markdown\":\"private result\"},{\"id\":\"ready-b\",\"state\":\"failed\",\"markdown\":\"private failure\"}]}".utf8)
            PendingCallsFixture.load([.success(hostWire), .success(callbackWire), .failure(URLError(.notConnectedToInternet)), .success(hostWire), .success(Data("{\"data\":[]}".utf8))])
            let readyCallbacks = try await callbackHTTP.pendingCalls()
            try require(readyCallbacks.map(\.id) == ["ready-a", "ready-b"] && readyCallbacks.allSatisfy(\.isReady), "native HTTP fixture returns concurrent ready callbacks")
            do {
                _ = try await callbackHTTP.pendingCalls()
                try require(false, "callback HTTP poll must propagate offline, not stale data")
            } catch is URLError { }
            let goneCallbacks = try await callbackHTTP.pendingCalls()
            try require(goneCallbacks.isEmpty, "native HTTP fixture reconciles job gone after poll error")
            print("PASS native callback HTTP ready/error/gone fixture")
            record("callbacks")
            let nativeIntent = try await nativeHTTP.beginIntent()
            do {
                _ = try await nativeHTTP.snapshot(sessionID: "00000000-0000-4000-8000-000000000000", for: nativeIntent)
                throw ProbeError.assertion("missing native snapshot must fail")
            } catch let error as LiveClientError {
                try require(error == .http(status: 404, code: "NOT_FOUND"), "actual native HTTP preserves status and typed code")
            }

            let pickupID = "10000000-0000-4000-8000-000000000001"
            let pickedHTTP = await MainActor.run {
                NativeLiveOperatorHTTP(authority: companion.authenticatedRequestBuilder(), pickupJobID: pickupID)
            }
            let firstPickup = try JSONDecoder().decode([String: String].self, from: pickedHTTP.createBody(for: nativeIntent, key: "pickup-key"))
            let pickupRetry = try JSONDecoder().decode([String: String].self, from: pickedHTTP.createBody(for: nativeIntent, key: "pickup-key"))
            let laterStart = try JSONDecoder().decode([String: String].self, from: pickedHTTP.createBody(for: nativeIntent, key: "later-start-key"))
            try require(firstPickup["pickupJobId"] == pickupID && pickupRetry["pickupJobId"] == pickupID, "pickup and its idempotent retry select the same job")
            try require(laterStart["pickupJobId"] == nil && laterStart["inputClass"] == nativeIntent.inputClass, "a later Start cannot reuse the consumed pickup ID")
            let nativeStatus = try await nativeHTTP.status(for: nativeIntent)
            try require(nativeStatus.authorityEpoch == fixture.authorityEpoch, "native status freezes authority epoch")
            let nativeKey = UUID().uuidString.lowercased()
            let nativeSnapshot = try await nativeHTTP.create(for: nativeIntent, key: nativeKey)
            try require(nativeSnapshot.idempotencyKey == nativeKey, "native create idempotency envelope")
            _ = try await nativeHTTP.snapshot(sessionID: nativeSnapshot.liveSessionId, for: nativeIntent)
            _ = try await nativeHTTP.journal(sessionID: nativeSnapshot.liveSessionId, cursor: 0, for: nativeIntent)
            let nativeRequest = try await nativeHTTP.request(for: LiveSocketBinding(origin: nativeIntent.origin,
                sessionID: nativeSnapshot.liveSessionId, authorityEpoch: nativeIntent.authorityEpoch, profileIdentity: nativeIntent.profileIdentity))
            let nativeHeaders = Set((nativeRequest.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() })
            try require(nativeHeaders == ["authorization", "host", "x-didi-authority-epoch", "x-didi-live-profile"] && nativeRequest.url?.scheme == "ws", "native audio exactly four pinned headers")
            try LiveSocketTransport.validate(nativeRequest, binding: LiveSocketBinding(origin: nativeIntent.origin,
                sessionID: nativeSnapshot.liveSessionId, authorityEpoch: nativeIntent.authorityEpoch, profileIdentity: nativeIntent.profileIdentity))
            try await nativeHTTP.revoke(sessionID: nativeSnapshot.liveSessionId, for: nativeIntent)
            let nativeTerminal = try await nativeHTTP.snapshot(sessionID: nativeSnapshot.liveSessionId, for: nativeIntent)
            try require(nativeTerminal.terminal?.state == .revoked, "native revoke and snapshot routes")
            let builder = companion.authenticatedRequestBuilder().request
            var staleEpochRefused = false
            do { _ = try builder(nativeIntent.origin.appendingPathComponent("api/v1/status"), "stale") }
            catch { staleEpochRefused = true }
            try require(staleEpochRefused, "native builder refuses stale expected epoch")
            print("PASS native operator status/create/snapshot/journal/revoke envelopes and exactly pinned audio headers")

            let playbackGate = Gate(), duplexHTTP = TestHTTP(fixture)
            let duplexSocket = ScriptedSocket([
                .marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil)),
                .pcm(Data([1, 0]))
            ])
            let duplex = LiveSessionCoordinator(http: duplexHTTP, sockets: FixedSockets(socket: duplexSocket), sink: GatedPlaybackSink(playbackGate))
            await duplex.begin(frozen)
            try await until { await playbackGate.arrivals == 1 }
            let duplexID = await duplex.sessionID
            try await duplex.sendPCM(Data(repeating: 0, count: 640))
            try await duplex.sendPCM(Data(repeating: 1, count: 640))
            try require(await duplexSocket.inputs.count == 2, "capture PCM keeps flowing while playback write is suspended")
            try require(await duplex.sessionID == duplexID, "duplex capture uses the same session")
            await playbackGate.release(); await duplex.stop(); await duplexHTTP.finish()
            print("PASS full-duplex capture interleaves with suspended playback write")

            // Silent scripted output proves ordering, including invalidation on a terminal frame.
            let scriptedHTTP = TestHTTP(fixture), scriptedSink = SilentSink()
            let scripted = LiveSessionCoordinator(http: scriptedHTTP, sockets: ScriptedSockets(frames: [
                .marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil)),
                .pcm(Data([1, 0])), .pcm(Data([2, 0])),
                .marker(LiveMarker(kind: .interrupted, sequence: 2, journalSequence: 0, text: nil, finished: nil, value: nil)),
                .pcm(Data([3, 0])), .terminal(LiveTerminal(state: .closed), complete: true)
            ]), sink: scriptedSink)
            await scripted.begin(frozen)
            try await until { await scriptedSink.events.count == 6 }
            try require(await scriptedSink.events == ["flush", "pcm:1", "pcm:2", "flush", "pcm:3", "flush"],
                        "PCM, interrupted and terminal flush order")
            try require(await scriptedSink.queued.isEmpty, "terminal discards queued playback")
            await scripted.stop(); await scriptedHTTP.finish()
            print("PASS silent scripted PCM/interrupted/terminal output ordering")

            // R-SEC-5: admission is suspended before the final outbound epoch check.
            let muteHTTP = TestHTTP(fixture), muteSocket = ContinuitySocket(), admissionGate = Gate()
            let muteFence = LiveSessionCoordinator(http: muteHTTP, sockets: muteSocket, sink: SilentSink(), beforeCaptureSubmission: { await admissionGate.wait() })
            await muteSocket.push(.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil)))
            await muteFence.begin(frozen)
            try await until { await muteFence.state == .active }
            await muteFence.setCaptureMuted(false, epoch: 0, diagnosticOwner: 17)
            let staleCapture = Task { try await muteFence.sendPCM(Data([9, 0]), captureEpoch: 0) }
            try await until { await admissionGate.arrivals == 1 }
            let muteAcknowledged = Gate()
            let muteRequest = Task {
                await muteFence.setCaptureMuted(true, epoch: 1)
                await muteAcknowledged.wait()
            }
            try await until { await muteFence.captureEpoch == 1 }
            try require(await muteAcknowledged.arrivals == 0, "mute not acknowledged while admitted submission is suspended")
            await admissionGate.release()
            try await staleCapture.value
            try await until { await muteAcknowledged.arrivals == 1 }
            try require(await muteSocket.inputs.isEmpty, "old admitted capture never reaches transport after mute epoch")
            await muteAcknowledged.release(); await muteRequest.value
            await muteFence.setCaptureMuted(false, epoch: 2)
            try await muteFence.sendPCM(Data([9, 0]), captureEpoch: 0)
            try require(await muteSocket.inputs.isEmpty, "unmute cannot revive an older capture epoch")
            let freshCapture = Task { try await muteFence.sendPCM(Data([7, 0]), captureEpoch: 2) }
            try await until { await admissionGate.arrivals == 2 }
            await admissionGate.release(); try await freshCapture.value
            try require(await muteSocket.inputs == [Data([7, 0])], "new epoch sends normally after unmute")
            let muteMetrics = await muteFence.captureSummary(owner: 17)!
            try require(muteMetrics.counters.lateMutedDrops == 1 && muteMetrics.counters.epochDrops == 1
                && muteMetrics.counters.localSocketSendCompleted == 1 && muteMetrics.counters.sendErrors == 0,
                "actual suspended and fresh sends report exact closed branch counts")
            await muteFence.stop(); await muteHTTP.finish()
            print("PASS suspended capture mute epoch fence + delayed acknowledgement + unmute cannot revive stale PCM")

            // WFIX1-R4: bytes handed to a suspended transport may complete, but mute
            // rejects all post-request capture and withholds the UI acknowledgement.
            let transportMuteHTTP = TestHTTP(fixture), transportMuteSocket = ContinuitySocket(), transportGate = Gate()
            let transportMute = LiveSessionCoordinator(http: transportMuteHTTP,
                sockets: GatedSockets(underlying: transportMuteSocket, gate: transportGate), sink: SilentSink())
            await transportMuteSocket.push(.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil)))
            await transportMute.begin(frozen)
            try await until { await transportMute.state == .active }
            await transportMute.setCaptureMuted(false, epoch: 0, diagnosticOwner: 18)
            let consentedFrame = Task { try await transportMute.sendPCM(Data([3, 0]), captureEpoch: 0) }
            try await until { await transportGate.arrivals == 1 }
            let mutedUIAcknowledgement = Gate()
            let ownerMuteRequest = Task {
                await transportMute.setCaptureMuted(true, epoch: 1)
                // NativeLiveConversation updates its muted UI state only after this return.
                await mutedUIAcknowledgement.wait()
            }
            try await until { await transportMute.captureEpoch == 1 }
            try await transportMute.sendPCM(Data([5, 0]), captureEpoch: 1)
            try require(await transportGate.arrivals == 1, "post-request captured frame never enters transport")
            try require(await transportMuteSocket.inputs.isEmpty, "transport submission remains deterministically suspended")
            try require(await mutedUIAcknowledgement.arrivals == 0, "muted UI acknowledgement withheld while pre-request submission is suspended")
            await transportGate.release(); try await consentedFrame.value
            try await until { await mutedUIAcknowledgement.arrivals == 1 }
            try require(await transportMuteSocket.inputs == [Data([3, 0])], "only consented pre-request PCM may complete before muted acknowledgement")
            try await transportMute.sendPCM(Data([7, 0]), captureEpoch: 1)
            try require(await transportGate.arrivals == 1, "post-request capture remains rejected after muted acknowledgement")
            await mutedUIAcknowledgement.release(); await ownerMuteRequest.value
            await transportMute.stop(); await transportMuteHTTP.finish()
            print("PASS suspended transport mute: post-request capture rejected + pre-request send may complete + muted acknowledgement after drain")

            let continuityHTTP = TestHTTP(fixture), continuitySocket = ContinuitySocket(), continuitySink = SilentSink()
            let continuity = LiveSessionCoordinator(http: continuityHTTP, sockets: continuitySocket, sink: continuitySink)
            await continuitySocket.push(.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil)))
            await continuity.begin(frozen)
            try await until { await continuity.state == .active }
            let continuityID = await continuity.sessionID
            await continuitySocket.push(.pcm(Data([7, 0])))
            try await until { await continuitySink.queued.count == 1 }
            await continuitySocket.push(.continuity(event: "rebuilding"))
            try await until {
                let state = await continuity.state, empty = await continuitySink.queued.isEmpty
                return state == .rebuilding && empty
            }
            try await continuity.sendPCM(Data(repeating: 0, count: 640))
            try require(await continuitySocket.inputs.isEmpty, "rebuilding drops captured input")
            await continuitySocket.push(.continuity(event: "future_event"))
            await continuitySocket.push(.continuity(event: "resumed"))
            try await until { await continuity.state == .active }
            try require(await continuity.sessionID == continuityID, "resumed preserves session identity")
            try await continuity.sendPCM(Data(repeating: 0, count: 640))
            try require(await continuitySocket.inputs.count == 1, "resumed accepts input")
            await continuitySocket.push(.terminal(LiveTerminal(state: .failed, code: "resume_failed"), complete: true))
            try await until { await continuity.state == .terminal(LiveTerminal(state: .failed, code: "resume_failed")) }
            try require(await continuitySocket.connections == 1, "terminal resume failure never reconnects")
            print("PASS continuity rebuilding flush/drop/resume identity + unknown event + terminal no restart")

            // 3o: a rebuilt provider session counts its markers again. The Mac re-bases on the first marker after
            // `continuity resumed`, so the call keeps its mic and its playback instead of going outcomeUnknown.
            let rebaseHTTP = TestHTTP(fixture), rebaseSocket = ContinuitySocket(), rebaseSink = SilentSink()
            let rebase = LiveSessionCoordinator(http: rebaseHTTP, sockets: rebaseSocket, sink: rebaseSink)
            await rebaseSocket.push(.marker(LiveMarker(kind: .ready, sequence: 313, journalSequence: 0, text: nil, finished: nil, value: nil)))
            await rebase.begin(frozen)
            try await until { await rebase.state == .active }
            await rebaseSocket.push(.continuity(event: "rebuilding"))
            try await until { await rebase.state == .rebuilding }
            await rebaseSocket.push(.continuity(event: "resumed"))
            try await until { await rebase.state == .active }
            await rebaseSocket.push(.marker(LiveMarker(kind: .inputTranscription, sequence: 2, journalSequence: 0, text: "after the rebuild", finished: true, value: nil)))
            await rebaseSocket.push(.pcm(Data([8, 0])))
            try await until { await rebaseSink.queued.count == 1 }
            try require(await rebase.state == .active, "a lower sequence after continuity resumed re-bases instead of failing")
            try require(await rebase.frameRejection == nil, "a re-base is not a refused frame")
            try await rebase.sendPCM(Data(repeating: 0, count: 640))
            try require(await rebaseSocket.inputs.count == 1, "the mic keeps flowing after the re-base")
            try require(await rebaseSocket.controls.isEmpty, "a re-base never ends the host session")
            await rebase.stop(); await rebaseHTTP.finish()
            print("PASS a resumed rebuild re-bases the marker sequence and keeps mic and playback")

            // A frame the protocol genuinely refuses is recorded for the native log and ends the host session
            // through the 3p Stop path, so the provider never keeps talking to a Mac that stopped listening.
            let rejectHTTP = TestHTTP(fixture), rejectSocket = ContinuitySocket(), rejectSink = SilentSink()
            let rejectClient = LiveSessionCoordinator(http: rejectHTTP, sockets: rejectSocket, sink: rejectSink)
            await rejectSocket.push(.marker(LiveMarker(kind: .ready, sequence: 5, journalSequence: 0, text: nil, finished: nil, value: nil)))
            await rejectClient.begin(frozen)
            try await until { await rejectClient.state == .active }
            await rejectSocket.push(.marker(LiveMarker(kind: .turnComplete, sequence: 5, journalSequence: 0, text: nil, finished: nil, value: nil)))
            try await until { await rejectClient.frameRejection != nil }
            let rejection = await rejectClient.takeFrameRejection()
            try require(rejection == LiveFrameRejection(sequence: 5, previous: 5, kind: "turnComplete"),
                        "the refused frame is recorded with its sequence, its predecessor and its kind")
            try await until { await rejectSocket.controls.contains(.close) }
            // The close itself settles last, so the final state is the refusal, not the Stop's own closing state.
            try await until { await rejectClient.state == .outcomeUnknown(.invalidFrame) }
            try require(await rejectSocket.connections == 1, "a refused frame never reconnects")
            await rejectHTTP.finish()
            print("PASS a refused marker is recorded and ends the host session")

            // Fresh coordinator does zero work. Loss happens AFTER actual server commit; explicit retry keeps exact key/meaning.
            let http = TestHTTP(fixture); let sockets = CountedSockets(fixture); let sink = SilentSink()
            let client = LiveSessionCoordinator(http: http, sockets: sockets, sink: sink)
            await client.close(); await client.revoke()
            let initialState = await client.state
            try require(await http.requests == 0 && initialState == .idle, "restart and empty close/revoke are inert")
            await http.configure(loss: true)
            await client.begin(frozen)
            try require(await client.state == .createUnknown, "lost committed create response")
            try require(await sockets.attempts == 0, "no auto attach on lost response")
            let lost = await http.lastCreated!
            try await client.retryCreate()
            try await until { await client.state == .active }
            let keys = await http.keys
            try require(keys.count == 2 && keys[0] == keys[1], "retry exact same create key")
            try require(await client.sessionID == lost.liveSessionId, "one server row by identity")
            var conflict = false
            do { _ = try await http.create(for: intent(fixture, inputClass: "private"), key: keys[0]) }
            catch LiveClientError.conflict { conflict = true }
            try require(conflict, "changed meaning conflicts")
            for invalid in [Data(), Data([0]), Data(repeating: 0, count: 65538)] {
                var refused = false
                do { try await client.sendPCM(invalid) } catch LiveClientError.invalidAudio { refused = true }
                try require(refused, "invalid input rejected before wire")
            }
            try await client.sendPCM(Data([1, 0]))
            try await until { await sink.queued.last?.first == 1 }
            let interruptionGate = Gate()
            await sink.gateFlush(interruptionGate)
            try await client.sendPCM(Data([2, 0]))
            try await until { await interruptionGate.arrivals == 1 }
            try require(await sink.queued.last?.first != 3, "later PCM held until interrupted flush completes")
            await interruptionGate.release()
            try await until { await sink.queued.last?.first == 3 }
            let events = await sink.events
            guard let flush = events.lastIndex(of: "flush"), let newPCM = events.firstIndex(of: "pcm:3") else { throw ProbeError.assertion("interruption markers") }
            try require(events.firstIndex(of: "pcm:1")! < flush && flush < newPCM, "old queued audio exists and interruption awaits flush before new PCM")
            try require(await sink.queued.allSatisfy { $0.first == 3 }, "old queued PCM invalidated, new PCM valid")
            try await client.endAudioStream()
            await client.revoke()
            try require(await sink.queued.isEmpty, "revoke invalidates queued playback before returning")
            let terminal = try await client.readSnapshot()
            try require(terminal.terminal?.state == .revoked, "durable revoke")
            let page = try await client.readJournal()
            try require(page.terminal?.outcome.state == .revoked, "journal terminal fact")
            let afterJournal = try await client.readJournal(cursor: 100000)
            try require(afterJournal.fragments.isEmpty && afterJournal.terminal?.outcome.state == .revoked, "terminal row fact is not invented as a journal fragment")
            let rawJournal = try await http.raw("/api/v1/live-sessions/" + lost.liveSessionId + "/journal")
            let journalText = String(decoding: rawJournal, as: UTF8.self)
            try require(!page.fragments.contains { $0.kind == "generationComplete" }, "interrupted turn does not invent generationComplete")
            for forbidden in ["FORBIDDEN_PROVIDER_TEXT", "FORBIDDEN_THOUGHT_TEXT", fixture.token, "inlineData", "audio/pcm"] {
                try require(!journalText.contains(forbidden), "journal excludes PCM/thought/provider payload/token")
            }
            var unavailable = false
            do { try await client.sendPCM(Data([0, 0])) } catch LiveClientError.unavailable { unavailable = true }
            try require(unavailable, "no outbound after revoke")
            try require(await sockets.attempts == 1, "no automatic reattach")
            await client.stop(); await http.finish()
            print("PASS real create loss/retry same identity/key changed meaning conflict invalid input interruption flush revoke journal no autoattach")
            record("intent-retry-audio-revoke")

            // A replay whose accepted row was revoked externally is an outcome, never a fresh attachment.
            let consumedHTTP = TestHTTP(fixture); let consumedSockets = CountedSockets(fixture)
            let consumed = LiveSessionCoordinator(http: consumedHTTP, sockets: consumedSockets, sink: SilentSink())
            await consumedHTTP.configure(loss: true); await consumed.begin(frozen)
            let consumedID = await consumedHTTP.lastCreated!.liveSessionId
            try await consumedHTTP.revoke(sessionID: consumedID, for: frozen)
            try await consumed.retryCreate()
            try require(await consumed.state == .terminal(LiveTerminal(state: .revoked)), "terminal create replay truth")
            try require(await consumedSockets.attempts == 0, "terminal replay zero attach")
            await consumed.stop(); await consumedHTTP.finish()
            let activeHTTP = TestHTTP(fixture); let activeSockets = CountedSockets(fixture)
            let activeReplay = LiveSessionCoordinator(http: activeHTTP, sockets: activeSockets, sink: SilentSink())
            await activeHTTP.configure(loss: true); await activeReplay.begin(frozen)
            let activeSnapshot = await activeHTTP.lastCreated!
            let external = try await LiveSocketTransport(requests: TestRequests(fixture: fixture, alteration: "")).connect(
                LiveSocketBinding(origin: frozen.origin, sessionID: activeSnapshot.liveSessionId, authorityEpoch: frozen.authorityEpoch, profileIdentity: frozen.profileIdentity))
            guard case .marker(let externalReady) = try await external.receive(), externalReady.kind == .ready else { throw ProbeError.assertion("external consumed snapshot") }
            let duplicate = try await LiveSocketTransport(requests: TestRequests(fixture: fixture, alteration: "")).connect(
                LiveSocketBinding(origin: frozen.origin, sessionID: activeSnapshot.liveSessionId, authorityEpoch: frozen.authorityEpoch, profileIdentity: frozen.profileIdentity))
            do {
                _ = try await duplicate.receive()
                throw ProbeError.assertion("duplicate attach must close")
            } catch let error as LiveClientError {
                try require(error == .socketClosed(code: 1008, reason: "attach_rejected:already_attached"), "actual native socket preserves close reason")
            }
            await duplicate.cancel()
            try await activeReplay.retryCreate()
            try require(await activeReplay.state == .outcomeUnknown(.unavailable), "active consumed replay remains honest unknown")
            try require(await activeSockets.attempts == 0, "active consumed replay zero automatic attach")
            try await activeHTTP.revoke(sessionID: activeSnapshot.liveSessionId, for: frozen)
            await external.cancel(); await activeReplay.stop(); await activeHTTP.finish()
            print("PASS consumed/terminal and active replay zero coordinator attach")
            record("terminal-replay")

            for mismatch in ["grant", "epoch", "status", "scope"] {
                let badHTTP = TestHTTP(fixture); let badSockets = CountedSockets(fixture)
                let bad = LiveSessionCoordinator(http: badHTTP, sockets: badSockets, sink: SilentSink())
                await badHTTP.configure(grant: mismatch == "grant", epoch: mismatch == "epoch", status: mismatch == "status", scope: mismatch == "scope")
                await bad.begin(frozen)
                let expected: LiveClientState = mismatch == "status" ? .failed(.statusMismatch) : .outcomeUnknown(.grantMismatch)
                try require(await bad.state == expected, "frozen status/returned grant/epoch pin")
                if mismatch == "status" { try require(await badHTTP.keys.isEmpty, "status drift refuses even create") }
                try require(await badSockets.attempts == 0, "pin mismatch zero attach")
                await bad.stop(); await badHTTP.finish()
            }
            print("PASS status/profile + grant/epoch/scope mismatch zero real socket attempts")

            // N2 provider guard: the intent gate accepts any provider the host can report (OpenAI included) and
            // the host's own status still pins the value, so a second provider is never refused as a literal.
            for (provider, expected) in [("openai", LiveClientState.failed(.statusMismatch)),
                                          ("not-a-provider", LiveClientState.failed(.invalidIntent))] {
                let altHTTP = TestHTTP(fixture); let altSockets = CountedSockets(fixture)
                let alt = LiveSessionCoordinator(http: altHTTP, sockets: altSockets, sink: SilentSink())
                let other = LiveBeginIntent(origin: URL(string: fixture.origin)!, assistantID: fixture.assistantId,
                                            authorityEpoch: fixture.authorityEpoch, provider: provider,
                                            model: frozen.model, voice: frozen.voice,
                                            profileIdentity: fixture.profileIdentity, inputClass: "ordinary")
                await alt.begin(other)
                // openai passes the provider gate and is caught by the host status pin; an unknown name is
                // refused by the gate itself. Neither reaches a real socket.
                try require(await alt.state == expected, "provider gate \(provider) state")
                try require(await altSockets.attempts == 0, "provider gate mismatch zero attach")
                await alt.stop(); await altHTTP.finish()
            }
            print("PASS provider guard accepts a second provider and the host status pins it")
            record("pins")

            let lateHTTP = TestHTTP(fixture); let lateSockets = CountedSockets(fixture); let gate = Gate()
            let lateSink = SilentSink()
            let late = LiveSessionCoordinator(http: lateHTTP, sockets: lateSockets, sink: lateSink)
            await lateHTTP.configure(gate: gate)
            let old = Task { await late.begin(frozen) }
            try await until { await gate.arrivals == 1 }
            await late.begin(frozen)
            try await until { await late.state == .active }
            let newID = await late.sessionID
            await gate.release(); await old.value
            let lateState = await late.state
            try require(await late.sessionID == newID && lateState == .active, "late canceled operation cannot replace new explicit begin")
            try require(await lateSockets.attempts == 1, "old canceled begin has zero create/attach")
            // Seed the sink boundary without changing the parent fixture's exact wire-input budget.
            await lateSink.write(Data([1, 0]))
            await lateSockets.disconnect()
            try await until { if case .outcomeUnknown = await late.state { return true }; return false }
            try await until { await lateSink.queued.isEmpty }
            _ = try await late.readSnapshot()
            try require(await lateSockets.attempts == 1, "explicit snapshot recovery does not reattach")
            await lateHTTP.configure(failRead: true)
            await late.revoke()
            try require(await late.state == .outcomeUnknown(.unavailable), "failed revoke confirmation cannot invent a known terminal")
            await lateHTTP.configure()
            let recovered = try await late.readSnapshot()
            try require(recovered.terminal?.state == .revoked, "explicit read recovers server outcome without attachment")
            let readGate = Gate()
            await lateHTTP.configure(readGate: readGate)
            let oldRead = Task { try await late.readSnapshot() }
            try await until { await readGate.arrivals == 1 }
            await late.begin(frozen); try await until { await late.state == .active }
            let newestID = await late.sessionID
            await readGate.release()
            var staleRead = false
            do { _ = try await oldRead.value } catch LiveClientError.staleOperation { staleRead = true }
            try require(staleRead, "late explicit read after new begin is fenced")
            let newestState = await late.state
            try require(await late.sessionID == newestID && newestState == .active, "old terminal snapshot cannot overwrite new active generation")
            await lateSink.write(Data([1, 0]))
            await late.close()
            try require(await lateSink.queued.isEmpty, "close invalidates queued playback before returning")
            let closeState = await late.state
            switch closeState {
            case .terminal, .outcomeUnknown: break
            default: throw ProbeError.assertion("close retains terminal/unknown distinction")
            }
            await late.revoke()
            let known = try await late.readSnapshot()
            try require(known.terminal != nil, "close/revoke explicit server truth")
            let terminalRequests = await lateHTTP.requests
            await late.close(); await late.revoke()
            try require(await lateHTTP.requests == terminalRequests, "one terminal state, no outbound after known terminal")
            try require(await lateSockets.attempts == 2, "only the new explicit begin reattaches")
            await late.stop(); await lateHTTP.finish()
            print("PASS status/read stale callback fencing + socket loss/revoke confirmation errors + close/recovery single terminal no reconnect")
            record("generation-recovery")

            let queueHTTP = TestHTTP(fixture); let queueSockets = CountedSockets(fixture); let sendGate = Gate()
            let queue = LiveSessionCoordinator(http: queueHTTP, sockets: GatedSockets(underlying: queueSockets, gate: sendGate), sink: SilentSink())
            await queue.begin(frozen); try await until { await queue.state == .active }
            let first = Task { try? await queue.sendPCM(Data(repeating: 0, count: 65536)) }
            try await until { await sendGate.arrivals == 1 }
            let second = Task { try? await queue.sendPCM(Data(repeating: 0, count: 65536)) }
            try await until { await sendGate.arrivals == 2 }
            var overflow = false
            do { try await queue.sendPCM(Data([0, 0])) } catch LiveClientError.queueOverflow { overflow = true }
            try require(overflow, "bounded pending input explicit overflow")
            await first.value; await second.value
            try require(await queue.state == .outcomeUnknown(.queueOverflow), "single honest overflow outcome")
            await queue.stop(); await queueHTTP.finish()
            print("PASS bounded client admission overflow through real transport, no queued PCM sent")
            record("queue")

            for kind in ["ready", "interrupted", "generationComplete", "turnComplete"] {
                let frame = try LiveSocketTransport.decode(.string("{\"type\":\"" + kind + "\",\"sequence\":1,\"journalSequence\":1}"))
                guard case .marker(let marker) = frame else { throw ProbeError.assertion("marker grammar") }
                try require(marker.kind.rawValue == kind, "exact public marker")
            }
            _ = try LiveSocketTransport.decode(.string("{\"type\":\"waitingForInput\",\"sequence\":1,\"journalSequence\":1,\"value\":true}"))
            try require(LiveControl.endAudioStream.json == "{\"type\":\"endAudioStream\"}" && LiveControl.close.json == "{\"type\":\"close\"}", "strict control grammar")
            for invalid in ["{}", "{\"type\":\"marker\",\"kind\":\"ready\"}", "{\"type\":\"ready\",\"sequence\":true,\"journalSequence\":1}", String(repeating: "x", count: 65537)] {
                var refused = false
                do { _ = try LiveSocketTransport.decode(.string(invalid)) } catch LiveClientError.invalidFrame { refused = true }
                try require(refused, "bounded strict decode")
            }
            print("PASS exact marker/control grammar and bounded strict decode")
            record("grammar")

            // 3p: the wire is one send at a time; audio sheds under backpressure and a control frame is never shed.
            let wire = LiveSendQueue()
            try require(await wire.acquireAudio(), "audio takes a free wire")
            try require(!(await wire.acquireAudio()), "a second audio frame sheds instead of queueing")
            let acquired = Flag()
            let queuedControl = Task { await wire.acquireControl(); await acquired.mark() }
            await wire.release()
            await queuedControl.value
            try require(await acquired.set, "the control frame that found the wire busy was queued, never refused")
            try require(!(await wire.acquireAudio()), "the queued control holds the wire ahead of audio")
            await wire.release()
            try require(await wire.acquireAudio(), "the wire is free again once the control has gone")
            await wire.release()

            // 3p: a Stop during a send still reaches the host, and the receipt names what pressed it.
            let stopHTTP = TestHTTP(fixture), stopGate = Gate()
            let stopSocket = StopProbeSocket([.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil))], stopGate)
            let stop = LiveSessionCoordinator(http: stopHTTP, sockets: ProbeSockets(socket: stopSocket), sink: SilentSink())
            await stop.begin(frozen); try await until { await stop.state == .active }
            let inFlight = Task { try? await stop.sendPCM(Data([1, 0])) }
            try await until { await stopGate.arrivals == 1 }
            let receipt = await stop.close(trigger: .button)
            try require(receipt?.trigger == .button, "the stop receipt names the press")
            try require((receipt?.socketCloseSentMs ?? -1) >= 0, "the receipt measures the wire")
            try require(await stopSocket.controls.contains(.close), "the stop control reached the socket while audio was in flight")
            await inFlight.value
            await stopHTTP.finish()
            print("PASS stop control survives a busy send queue and its receipt names the press")
            record("stop-control")

            // Z2: a playback receipt holds the wire; the microphone sheds one frame and the call lives on.
            let shedHTTP = TestHTTP(fixture), receiptGate = Gate()
            let shedSocket = BusyWireSocket([.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil))], receiptGate)
            let shed = LiveSessionCoordinator(http: shedHTTP, sockets: BusyWireSockets(socket: shedSocket), sink: SilentSink())
            await shed.begin(frozen); try await until { await shed.state == .active }
            await shed.setCaptureMuted(false, epoch: 0, diagnosticOwner: 41)
            let heldReceipt = Task { await shed.sendPlaybackReceipt("{\"type\":\"playbackReceipt\"}") }
            try await until { await shedSocket.receiptEntered == 1 }
            try await shed.sendPCM(Data(repeating: 1, count: 640), captureEpoch: 0, diagnosticOwner: 41)
            try require(await shed.state == .active, "a busy wire never ends the call")
            let shedCounters = (await shed.captureSummary(owner: 41))!.counters
            try require(shedCounters.shedFrames == 1 && shedCounters.sendErrors == 0
                && shedCounters.localSocketSendCompleted == 0, "one shed mic frame, no send error, no completion")
            await receiptGate.release()
            await heldReceipt.value
            try await shed.sendPCM(Data(repeating: 1, count: 640), captureEpoch: 0, diagnosticOwner: 41)
            let afterShed = (await shed.captureSummary(owner: 41))!.counters
            try require(await shedSocket.inputs.count == 1 && afterShed.localSocketSendCompleted == 1
                && afterShed.entered == 2 && afterShed.shedFrames == 1, "the frame after the shed is sent")
            await shed.stop(); await shedHTTP.finish()
            print("PASS a receipt holding the wire sheds one mic frame and the next frame is sent")
            record("shed-frame")

            // Z2 soak: 10,000 alternating playback receipts and mic frames, no shed frame, no interruption.
            let soakHTTP = TestHTTP(fixture)
            let soakSocket = YieldingSocket([.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil))])
            let soak = LiveSessionCoordinator(http: soakHTTP, sockets: YieldingSockets(socket: soakSocket), sink: SilentSink())
            await soak.begin(frozen); try await until { await soak.state == .active }
            await soak.setCaptureMuted(false, epoch: 0, diagnosticOwner: 42)
            for index in 0..<10_000 {
                await soak.sendPlaybackReceipt("{\"type\":\"playbackReceipt\",\"index\":" + String(index) + "}")
                try await soak.sendPCM(Data(repeating: 1, count: 640), captureEpoch: 0, diagnosticOwner: 42)
            }
            let soakCounters = (await soak.captureSummary(owner: 42))!.counters
            try require(soakCounters.shedFrames == 0 && soakCounters.sendErrors == 0
                && soakCounters.localSocketSendCompleted == 10_000,
                "10,000 interleaved receipts never shed a mic frame and never end the call")
            try require(await soak.state == .active && await soakSocket.inputs == 10_000
                && await soakSocket.receipts == 10_000, "every receipt and every mic frame reached the wire")
            await soak.stop(); await soakHTTP.finish()
            print("PASS 10,000 interleaved playback receipts and mic frames with zero shed frames and no interruption")
            record("receipt-audio-soak")

            // Z2: the automatic restart is a new call, a new idempotency key, the same persona and voice.
            let keyHTTP = TestHTTP(fixture), keyGate = Gate()
            let ready = LiveFrame.marker(LiveMarker(kind: .ready, sequence: 1, journalSequence: 0, text: nil, finished: nil, value: nil))
            let keySocket = StopProbeSocket([ready, ready], keyGate)
            let keys = LiveSessionCoordinator(http: keyHTTP, sockets: ProbeSockets(socket: keySocket), sink: SilentSink())
            await keys.begin(frozen); try await until { await keys.state == .active }
            let firstCall = try await keys.readSnapshot()
            await keys.begin(frozen); try await until { await keys.state == .active }
            let restartedCall = try await keys.readSnapshot()
            let createKeys = await keyHTTP.keys
            try require(createKeys.count == 2 && createKeys[0] != createKeys[1],
                "the restart carries a new idempotency key")
            try require(firstCall.idempotencyKey == createKeys[0] && restartedCall.idempotencyKey == createKeys[1]
                && firstCall.liveSessionId != restartedCall.liveSessionId, "a new call, never the old one")
            try require(firstCall.grant.voice == restartedCall.grant.voice
                && firstCall.grant.model == restartedCall.grant.model
                && firstCall.assistantId == restartedCall.assistantId
                && firstCall.profileIdentity == restartedCall.profileIdentity,
                "same persona and voice on the restarted call")
            await keys.stop(); await keyHTTP.finish()
            print("PASS restart begins a new call with a new idempotency key and the same persona and voice")
            record("restart-key")
            if CommandLine.arguments.contains("--durations=10") {
                for (name, duration) in durations.sorted(by: { $0.1 > $1.1 }).prefix(10) {
                    let parts = duration.components
                    let seconds = Double(parts.seconds) + Double(parts.attoseconds) / 1e18
                    print(String(format: "DURATION %.3fs %@", seconds, name))
                }
            }
            print("NATIVE CLIENT PASS expectedAdditionalUpgrades=5")
        } catch {
            let message: String
            if case ProbeError.assertion(let text) = error { message = text }
            else if let safe = error as? LiveClientError { message = safe.rawValue }
            else { message = "controlled fixture/transport failure" }
            FileHandle.standardError.write(Data(("FAIL native live: " + message + "\n").utf8))
            exit(1)
        }
    }
}
