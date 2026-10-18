import Foundation

private struct Case: Decodable {
    let label: String
    let wire: String
    let partial: Bool?
}
private struct Input: Decodable { let canonical: [Case]; let malformed: [Case] }
private struct ConsumerHTTP: LiveOperatorHTTP {
    func status(for intent: LiveBeginIntent) async throws -> LiveOperatorStatus {
        LiveOperatorStatus(origin: intent.origin, assistantID: intent.assistantID, authorityEpoch: intent.authorityEpoch,
            provider: intent.provider, model: intent.model, voice: intent.voice, profileIdentity: intent.profileIdentity, dataClasses: ["ordinary"])
    }
    func create(for intent: LiveBeginIntent, key: String) async throws -> LiveSnapshot {
        LiveSnapshot(liveSessionId: UUID().uuidString.lowercased(), assistantId: intent.assistantID,
            authorityEpoch: intent.authorityEpoch, idempotencyKey: key, profileIdentity: intent.profileIdentity,
            grant: LiveGrant(provider: intent.provider, model: intent.model, voice: intent.voice,
                chosenInputClass: "ordinary", permittedClasses: ["ordinary"], revision: 1),
            lifecycle: "accepted", dispatchIntent: false, consumerState: "detached", terminal: nil)
    }
    func snapshot(sessionID: String, for intent: LiveBeginIntent) async throws -> LiveSnapshot { throw LiveClientError.unavailable }
    func journal(sessionID: String, cursor: Int?, for intent: LiveBeginIntent) async throws -> LiveJournalPage { throw LiveClientError.unavailable }
    func revoke(sessionID: String, for intent: LiveBeginIntent) async throws { throw LiveClientError.unavailable }
}
private actor ConsumerSocket: LiveSocket {
    let frames: [String]
    var index = 0
    private(set) var controls = 0
    private(set) var cancelled = false
    init(_ frames: [String]) { self.frames = frames }
    func receive() async throws -> LiveFrame {
        guard index < frames.count && !cancelled else { throw LiveClientError.invalidFrame }
        let wire = frames[index]; index += 1
        return try LiveSocketTransport.decode(.string(wire))
    }
    func sendPCM(_ data: Data) async throws { throw LiveClientError.invalidFrame }
    func sendControl(_ control: LiveControl) async throws { controls += 1 }
    func sendReceipt(_ frame: String) async throws {}
    func cancel() async { cancelled = true }
}
private struct ConsumerSockets: LiveSocketConnecting {
    let socket: ConsumerSocket
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { socket }
}
private actor ConsumerSink: LiveAudioSink {
    private(set) var writes = 0
    private(set) var interruptions = 0
    func write(_ pcm: Data) async throws { writes += 1 }
    func flush() async throws { }
    func interruption(turnCompleteSeen: Bool) async { interruptions += 1 }
}

@main struct CanonicalFrames {
    static func main() async throws {
        let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
        var rejected: [String] = [], malformedAccepted: [String] = []
        var partialStayedUnknown = true
        for item in input.canonical {
            do {
                let frame = try LiveSocketTransport.decode(.string(item.wire))
                if item.partial == true {
                    guard case .marker(let marker) = frame, marker.finished == nil else {
                        partialStayedUnknown = false; continue
                    }
                }
            } catch { rejected.append(item.label) }
        }
        for item in input.malformed {
            do { _ = try LiveSocketTransport.decode(.string(item.wire)); malformedAccepted.append(item.label) }
            catch LiveClientError.invalidFrame { }
        }
        var consumerClosed = false, toolCausedNoAction = false, toolBeforeReadyRefused = false
        if rejected.isEmpty && malformedAccepted.isEmpty && partialStayedUnknown {
            let frames = Array(input.canonical.prefix(while: { $0.label != "terminal-failed" })).map(\.wire)
            let socket = ConsumerSocket(frames), sink = ConsumerSink()
            let coordinator = LiveSessionCoordinator(http: ConsumerHTTP(), sockets: ConsumerSockets(socket: socket), sink: sink)
            await coordinator.begin(LiveBeginIntent(origin: URL(string: "http://127.0.0.1:8080")!, assistantID: "synthetic",
                authorityEpoch: "synthetic-epoch", provider: "gemini", model: "synthetic", voice: "synthetic",
                profileIdentity: "synthetic", inputClass: "ordinary"))
            let deadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < deadline {
                if case .terminal(let terminal) = await coordinator.state {
                    consumerClosed = terminal.state == .closed; break
                }
                if case .outcomeUnknown = await coordinator.state { break }
                try await Task.sleep(for: .milliseconds(2))
            }
            let controls = await socket.controls, writes = await sink.writes
            toolCausedNoAction = controls == 0 && writes == 0
            await socket.cancel()
            let premature = ConsumerSocket([input.canonical.first(where: { $0.label == "toolCall-null" })!.wire])
            let beforeReady = LiveSessionCoordinator(http: ConsumerHTTP(), sockets: ConsumerSockets(socket: premature), sink: ConsumerSink())
            await beforeReady.begin(LiveBeginIntent(origin: URL(string: "http://127.0.0.1:8080")!, assistantID: "synthetic",
                authorityEpoch: "synthetic-epoch", provider: "gemini", model: "synthetic", voice: "synthetic",
                profileIdentity: "synthetic", inputClass: "ordinary"))
            let prematureDeadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < prematureDeadline {
                if case .outcomeUnknown(.invalidFrame) = await beforeReady.state { toolBeforeReadyRefused = true; break }
                try await Task.sleep(for: .milliseconds(2))
            }
            await premature.cancel()
        }
        // H3 stays refuted: a local activity or completion marker never reaches the interruption
        // path; only the provider `interrupted` marker does. The capture level never travels this path.
        let beginIntent = LiveBeginIntent(origin: URL(string: "http://127.0.0.1:8080")!, assistantID: "synthetic",
            authorityEpoch: "synthetic-epoch", provider: "gemini", model: "synthetic", voice: "synthetic",
            profileIdentity: "synthetic", inputClass: "ordinary")
        func interruptionCount(_ labels: [String]) async -> Int {
            let wires = labels.compactMap { label in input.canonical.first(where: { $0.label == label })?.wire }
            let socket = ConsumerSocket(wires)
            let sink = ConsumerSink()
            let coordinator = LiveSessionCoordinator(http: ConsumerHTTP(), sockets: ConsumerSockets(socket: socket), sink: sink)
            await coordinator.begin(beginIntent)
            let deadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < deadline {
                if await sink.interruptions > 0 { break }
                switch await coordinator.state {
                case .terminal, .outcomeUnknown, .failed: break
                default:
                    try? await Task.sleep(for: .milliseconds(2))
                    continue
                }
                break
            }
            let count = await sink.interruptions
            await socket.cancel()
            return count
        }
        let activityOnly = await interruptionCount(["ready", "waitingForInput-true", "waitingForInput-false", "generationComplete", "turnComplete"])
        let providerInterruption = await interruptionCount(["ready", "interrupted"])
        let flushOnlyOnProviderInterrupted = activityOnly == 0 && providerInterruption == 1
        let pass = rejected.isEmpty && malformedAccepted.isEmpty && partialStayedUnknown && consumerClosed && toolCausedNoAction && toolBeforeReadyRefused && flushOnlyOnProviderInterrupted
        let receipt: [String: Any] = ["canonicalCount": input.canonical.count, "canonicalRejected": rejected,
            "malformedCount": input.malformed.count, "malformedAccepted": malformedAccepted,
            "partialStayedUnknown": partialStayedUnknown, "actualConsumerClosed": consumerClosed,
            "toolCausedNoAudioOrControl": toolCausedNoAction, "toolBeforeReadyRefused": toolBeforeReadyRefused,
            "flushOnlyOnProviderInterrupted": flushOnlyOnProviderInterrupted, "success": pass]
        try FileHandle.standardOutput.write(contentsOf: JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]))
        try FileHandle.standardOutput.write(contentsOf: Data([10]))
        exit(pass ? 0 : 1)
    }
}
