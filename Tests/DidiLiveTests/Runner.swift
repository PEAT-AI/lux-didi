import Foundation

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
            let fixture = try JSONDecoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile())
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
            let late = LiveSessionCoordinator(http: lateHTTP, sockets: lateSockets, sink: SilentSink())
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
            await lateSockets.disconnect()
            try await until { if case .outcomeUnknown = await late.state { return true }; return false }
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
            await late.close()
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
