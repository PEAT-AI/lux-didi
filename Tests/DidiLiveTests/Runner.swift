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
    func sendPCM(_ data: Data) async throws {
        await gate.wait()
        guard !closed else { throw LiveClientError.unavailable }
        try await underlying.sendPCM(data)
    }
    func sendControl(_ command: LiveControl) async throws { try await underlying.sendControl(command) }
    func cancel() async { closed = true; await underlying.cancel(); await gate.release() }
}
struct GatedSockets: LiveSocketConnecting {
    let underlying: CountedSockets; let gate: Gate
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { try await GatedSocket(underlying.connect(binding), gate) }
}

actor ScriptedSocket: LiveSocket {
    private var frames: [LiveFrame]
    private(set) var inputs: [Data] = []
    init(_ frames: [LiveFrame]) { self.frames = frames }
    func receive() throws -> LiveFrame {
        guard !frames.isEmpty else { throw LiveClientError.transport }
        return frames.removeFirst()
    }
    func sendPCM(_ data: Data) { inputs.append(data) }
    func sendControl(_ command: LiveControl) {}
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
            try require(NativeLivePresentation.failure(URLError(.cannotConnectToHost)) == "Live service is unreachable. Reconnect the service and try again.", "transport failure is actionable")
            try require(NativeLivePresentation.failure(LiveClientError.transport) == NativeLivePresentation.failure(URLError(.timedOut)), "coordinator preserves transport class")
            try require(NativeLivePresentation.failure(LiveClientError.unavailable) == "Live voice is not configured. Check the Live service settings.", "unconfigured failure is actionable")
            try require(NativeLivePresentation.failure(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "private"))) == "Live service returned an unexpected response. Reconnect the service and try again.", "decoding failure never leaks response")
            let oldProfile = try JSONDecoder().decode(NativeLiveOperatorHTTP.Profile.self, from: Data("{\"status\":\"unconfigured\"}".utf8))
            try require(oldProfile.limits == nil, "old status remains decodable")
            let limits = try JSONDecoder().decode(NativeLiveLimits.self, from: Data("{\"sessionMs\":900000,\"idleMs\":60000}".utf8))
            try require(limits.sentence == "Session limit 15 min, idle limit 1 min.", "configured limits are plain text")
            try require(NativeLivePresentation.ended("session_timeout", limits: limits) == "Session limit reached (15 min). Start again to continue.", "session limit explains next action")
            try require(NativeLivePresentation.ended("idle_timeout", limits: limits) == "Ended after 1 min without speech. Start again when ready.", "idle limit explains next action")
            for audio in [NativeLiveAudioError.permissionDenied, .permissionRestricted, .voiceProcessingUnavailable, .deviceUnavailable, .unsupportedFormat, .allocationFailed, .converterUnavailable] {
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
            try require(nativeHeaders == ["authorization", "x-didi-authority-epoch", "x-didi-live-profile"] && nativeRequest.url?.scheme == "ws", "native audio exactly three pinned headers")
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
