import Foundation

// C-ALARMSPEECH F2: the real alarm route result fed to the real coordinator validator.
//
// Tests/DidiLiveTests/CanonicalFrames.swift fakes a host that always echoes the key, which is why the
// pair stayed green while a spoken alarm never attached. This test crosses the wire: the host body is
// encoded and decoded as JSON in the host's own field names, then handed to LiveSessionCoordinator.
// The released host answered an alarm create with `alarm:<id>`; a host that honours the caller key
// answers with the caller's own UUID. The only field that differs is the key, as ALARM.md's AlarmSpeechWireProbe A
// showed, so the control case proves the rest of the body already passes every other check.

/// The two host replies, built in the host's wire shape and decoded back through JSON.
private enum AlarmSpeechWireHostBody {
    static func snapshot(echoing key: String, intent: LiveBeginIntent) throws -> LiveSnapshot {
        let body = LiveSnapshot(liveSessionId: "6d1a2f70-8f4b-4c39-9c1e-2a5f0d6b7c81",
            assistantId: intent.assistantID, authorityEpoch: intent.authorityEpoch, idempotencyKey: key,
            profileIdentity: intent.profileIdentity,
            grant: LiveGrant(provider: intent.provider, model: intent.model, voice: intent.voice,
                chosenInputClass: intent.inputClass, permittedClasses: [intent.inputClass], revision: 1),
            lifecycle: "accepted", dispatchIntent: false, consumerState: "detached", terminal: nil)
        let wire = try JSONEncoder().encode(body)
        let fields = try JSONSerialization.jsonObject(with: wire) as? [String: Any] ?? [:]
        for name in ["liveSessionId", "assistantId", "authorityEpoch", "idempotencyKey", "profileIdentity",
                     "grant", "lifecycle", "dispatchIntent", "consumerState"] {
            guard fields[name] != nil else { throw AlarmSpeechWireProbe.Failure(description: "host body missing \(name)") }
        }
        return try JSONDecoder().decode(LiveSnapshot.self, from: wire)
    }
}

private enum AlarmSpeechWireProbe {
    struct Failure: Error, CustomStringConvertible { let description: String }
    static func check(_ condition: Bool, _ detail: String) throws { if !condition { throw Failure(description: detail) } }
}

private struct AlarmSpeechWireAlarmHTTP: LiveOperatorHTTP {
    let answer: @Sendable (LiveBeginIntent, String) throws -> LiveSnapshot
    func status(for intent: LiveBeginIntent) async throws -> LiveOperatorStatus {
        LiveOperatorStatus(origin: intent.origin, assistantID: intent.assistantID, authorityEpoch: intent.authorityEpoch,
            provider: intent.provider, model: intent.model, voice: intent.voice,
            profileIdentity: intent.profileIdentity, dataClasses: [intent.inputClass])
    }
    func create(for intent: LiveBeginIntent, key: String) async throws -> LiveSnapshot { try answer(intent, key) }
    func snapshot(sessionID: String, for intent: LiveBeginIntent) async throws -> LiveSnapshot { try answer(intent, sessionID) }
    func journal(sessionID: String, cursor: Int?, for intent: LiveBeginIntent) async throws -> LiveJournalPage {
        LiveJournalPage(liveSessionId: sessionID, fragments: [], nextCursor: nil, terminal: nil)
    }
    func revoke(sessionID: String, for intent: LiveBeginIntent) async throws {}
}

private actor AlarmSpeechWireProbeSocket: LiveSocket {
    private(set) var cancelled = false
    func receive() async throws -> LiveFrame { try await Task.sleep(for: .seconds(30)); throw LiveClientError.transport }
    func sendPCM(_ data: Data) async throws {}
    func sendControl(_ control: LiveControl) async throws {}
    func sendReceipt(_ frame: String) async throws {}
    func cancel() async { cancelled = true }
}

private final class AlarmSpeechWireSentKeys: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    func record(_ key: String) { lock.lock(); seen.append(key); lock.unlock() }
    var keys: [String] { lock.lock(); defer { lock.unlock() }; return seen }
}

private actor AlarmSpeechWireSockets: LiveSocketConnecting {
    private(set) var connects = 0
    let socket = AlarmSpeechWireProbeSocket()
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket { connects += 1; return socket }
}

private actor AlarmSpeechWireSink: LiveAudioSink {
    func write(_ pcm: Data) async throws {}
    func flush() async throws {}
}

@main struct AlarmSpeechWire {
    static func main() async {
        do { try await run(); print("ALARM SPEECH WIRE: PASS") }
        catch { print("ALARM SPEECH WIRE: FAIL \(error)"); exit(1) }
    }

    static func run() async throws {
        let intent = LiveBeginIntent(origin: URL(string: "http://127.0.0.1:9")!, assistantID: "synthetic-assistant",
            authorityEpoch: "synthetic-epoch", provider: "gemini", model: "models/synthetic", voice: "Synthetic",
            profileIdentity: "synthetic-profile", inputClass: "ordinary")

        // The released host named the alarm session itself, so its answer never carried the caller's key.
        let stale = AlarmSpeechWireSockets()
        let staleCoordinator = LiveSessionCoordinator(
            http: AlarmSpeechWireAlarmHTTP { intent, _ in try AlarmSpeechWireHostBody.snapshot(echoing: "alarm:synthetic-alarm-a", intent: intent) },
            sockets: stale, sink: AlarmSpeechWireSink())
        await staleCoordinator.begin(intent)
        let staleState = await staleCoordinator.state
        try AlarmSpeechWireProbe.check(staleState == .outcomeUnknown(.grantMismatch), "a host key that is not the caller's must be refused, got \(staleState)")
        let staleSession = await staleCoordinator.sessionID
        try AlarmSpeechWireProbe.check(staleSession == nil, "a refused snapshot must leave no session behind")
        let staleConnects = await stale.connects
        try AlarmSpeechWireProbe.check(staleConnects == 0, "a refused snapshot must never open a socket, got \(staleConnects)")

        // F-B: an alarm passes its occurrence key, so a retry of the same alarm presents the same key and the
        // host can replay the session it already opened rather than refusing a second one.
        let retrySockets = AlarmSpeechWireSockets()
        let sent = AlarmSpeechWireSentKeys()
        let retryCoordinator = LiveSessionCoordinator(
            http: AlarmSpeechWireAlarmHTTP { intent, key in sent.record(key); return try AlarmSpeechWireHostBody.snapshot(echoing: key, intent: intent) },
            sockets: retrySockets, sink: AlarmSpeechWireSink())
        await retryCoordinator.begin(intent, key: "alarm:synthetic-alarm-a")
        let retryState = await retryCoordinator.state
        try AlarmSpeechWireProbe.check(retryState == .attaching, "an alarm occurrence key reaches attaching, got \(retryState)")
        let retryKeys = sent.keys
        try AlarmSpeechWireProbe.check(retryKeys == ["alarm:synthetic-alarm-a"], "the alarm create carries its occurrence key, got \(retryKeys)")

        // A host that echoes the caller key reaches attach on the same body.
        let live = AlarmSpeechWireSockets()
        let coordinator = LiveSessionCoordinator(
            http: AlarmSpeechWireAlarmHTTP { intent, key in try AlarmSpeechWireHostBody.snapshot(echoing: key, intent: intent) },
            sockets: live, sink: AlarmSpeechWireSink())
        await coordinator.begin(intent)
        let state = await coordinator.state
        try AlarmSpeechWireProbe.check(state == .attaching, "an echoed key must reach attaching, got \(state)")
        let session = await coordinator.sessionID
        try AlarmSpeechWireProbe.check(session == "6d1a2f70-8f4b-4c39-9c1e-2a5f0d6b7c81", "the snapshot's own session is the one attached")
        let connects = await live.connects
        try AlarmSpeechWireProbe.check(connects == 1, "an attached alarm call opens exactly one socket, got \(connects)")
    }
}
