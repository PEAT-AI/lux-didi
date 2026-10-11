import Foundation

public struct LiveBeginIntent: Sendable, Equatable {
    public let origin: URL
    public let assistantID: String
    public let authorityEpoch: String
    public let provider: String
    public let model: String
    public let voice: String
    public let profileIdentity: String
    public let inputClass: String
    public init(origin: URL, assistantID: String, authorityEpoch: String, provider: String,
                model: String, voice: String, profileIdentity: String, inputClass: String) {
        self.origin = origin; self.assistantID = assistantID; self.authorityEpoch = authorityEpoch
        self.provider = provider; self.model = model; self.voice = voice
        self.profileIdentity = profileIdentity; self.inputClass = inputClass
    }
}

/// Combined safe projections from the injected authority owner's operator status and Live status.
public struct LiveOperatorStatus: Sendable {
    public let origin: URL
    public let assistantID: String
    public let authorityEpoch: String
    public let provider: String
    public let model: String
    public let voice: String
    public let profileIdentity: String
    public let dataClasses: [String]
    public init(origin: URL, assistantID: String, authorityEpoch: String, provider: String, model: String,
                voice: String, profileIdentity: String, dataClasses: [String]) {
        self.origin = origin; self.assistantID = assistantID; self.authorityEpoch = authorityEpoch
        self.provider = provider; self.model = model; self.voice = voice
        self.profileIdentity = profileIdentity; self.dataClasses = dataClasses
    }
}

public struct LiveGrant: Codable, Sendable {
    public let provider: String
    public let model: String
    public let voice: String
    public let chosenInputClass: String
    public let permittedClasses: [String]
    public let revision: Int
    public init(provider: String, model: String, voice: String, chosenInputClass: String,
                permittedClasses: [String], revision: Int) {
        self.provider = provider; self.model = model; self.voice = voice
        self.chosenInputClass = chosenInputClass; self.permittedClasses = permittedClasses; self.revision = revision
    }
}
public struct LiveSnapshot: Codable, Sendable {
    public let liveSessionId: String
    public let assistantId: String
    public let authorityEpoch: String
    public let idempotencyKey: String
    public let profileIdentity: String
    public let grant: LiveGrant
    public let lifecycle: String
    public let dispatchIntent: Bool
    public let consumerState: String
    public let terminal: LiveTerminal?
    public init(liveSessionId: String, assistantId: String, authorityEpoch: String, idempotencyKey: String,
                profileIdentity: String, grant: LiveGrant, lifecycle: String, dispatchIntent: Bool,
                consumerState: String, terminal: LiveTerminal?) {
        self.liveSessionId = liveSessionId; self.assistantId = assistantId; self.authorityEpoch = authorityEpoch
        self.idempotencyKey = idempotencyKey; self.profileIdentity = profileIdentity; self.grant = grant
        self.lifecycle = lifecycle; self.dispatchIntent = dispatchIntent; self.consumerState = consumerState
        self.terminal = terminal
    }
}
public struct LiveJournalFragment: Codable, Sendable {
    public let journalSequence: Int
    public let kind: String
    public let text: String?
    public let finished: Bool?
    public let value: Bool?
}
public struct LiveJournalPage: Codable, Sendable {
    public struct TerminalFact: Codable, Sendable {
        public let outcome: LiveTerminal
        public let complete: Bool
    }
    public let liveSessionId: String
    public let fragments: [LiveJournalFragment]
    public let nextCursor: Int?
    public let terminal: TerminalFact?
}

public protocol LiveOperatorHTTP: Sendable {
    func status(for intent: LiveBeginIntent) async throws -> LiveOperatorStatus
    func create(for intent: LiveBeginIntent, key: String) async throws -> LiveSnapshot
    func snapshot(sessionID: String, for intent: LiveBeginIntent) async throws -> LiveSnapshot
    func journal(sessionID: String, cursor: Int?, for intent: LiveBeginIntent) async throws -> LiveJournalPage
    func revoke(sessionID: String, for intent: LiveBeginIntent) async throws
}

/// Implementations must honor cancellation; flush invalidates any previously queued audio before returning.
public protocol LiveAudioSink: Sendable {
    func write(_ pcm: Data) async throws
    func flush() async throws
}

public enum LiveClientState: Sendable, Equatable {
    case idle, checking, creating, createUnknown, attaching, active, closing
    case terminal(LiveTerminal)
    case outcomeUnknown(LiveClientError)
    case failed(LiveClientError)
}

/// No preference, native REST/bootstrap, credential owner, device, UI, persistence, or reconnect binding.
public actor LiveSessionCoordinator {
    public private(set) var state: LiveClientState = .idle
    public private(set) var generation: UInt64 = 0
    public private(set) var sessionID: String?
    private let http: any LiveOperatorHTTP
    private let sockets: any LiveSocketConnecting
    private let sink: any LiveAudioSink
    private var intent: LiveBeginIntent?
    private var createKey: String?
    private var grant: LiveGrant?
    private var socket: (any LiveSocket)?
    private var receiveTask: Task<Void, Never>?
    private var operationTask: Task<Void, Never>?
    private var operation: UInt64 = 0
    private var pendingBytes = 0
    private var pendingFrames = 0
    private let maxPendingBytes = 131072
    private let maxPendingFrames = 4
    private var inputEnded = false
    private var reading = false

    public init(http: any LiveOperatorHTTP, sockets: any LiveSocketConnecting, sink: any LiveAudioSink) {
        self.http = http; self.sockets = sockets; self.sink = sink
    }

    /// The only entry that generates a new key. Replaces the previous operation, never resurrects it.
    public func begin(_ frozen: LiveBeginIntent) async {
        generation &+= 1; operation &+= 1
        let token = generation, op = operation
        operationTask?.cancel(); receiveTask?.cancel()
        let oldSocket = socket; socket = nil
        intent = frozen; createKey = UUID().uuidString; sessionID = nil; grant = nil
        pendingBytes = 0; pendingFrames = 0; inputEnded = false; reading = false; state = .checking
        await oldSocket?.cancel()
        guard current(token, op) else { return }
        do { try await sink.flush() }
        catch { if current(token, op) { state = .failed(.unavailable) }; return }
        guard current(token, op) else { return }
        let task = Task { await self.performCreate(token, op) }
        operationTask = task
        await task.value
    }

    public func retryCreate() async throws {
        guard state == .createUnknown, intent != nil, createKey != nil else { throw LiveClientError.unavailable }
        operation &+= 1
        let token = generation, op = operation
        operationTask?.cancel(); state = .checking
        let task = Task { await self.performCreate(token, op) }
        operationTask = task
        await task.value
    }

    private func performCreate(_ token: UInt64, _ op: UInt64) async {
        guard current(token, op), let frozen = intent, let key = createKey else { return }
        let status: LiveOperatorStatus
        do {
            try validateIntent(frozen)
            status = try await http.status(for: frozen)
            guard current(token, op), !Task.isCancelled else { return }
            try validate(status, frozen)
        } catch {
            if current(token, op) { state = .failed(safe(error, fallback: .unavailable)) }
            return
        }
        guard current(token, op), !Task.isCancelled else { return }
        state = .creating
        let snapshot: LiveSnapshot
        do { snapshot = try await http.create(for: frozen, key: key) }
        catch {
            if current(token, op) {
                state = (error as? LiveClientError) == .conflict ? .failed(.conflict) : .createUnknown
            }
            return
        }
        guard current(token, op), !Task.isCancelled else { return }
        do {
            try validate(snapshot, frozen, key)
            guard snapshot.grant.permittedClasses.sorted() == status.dataClasses.sorted() else { throw LiveClientError.grantMismatch }
            sessionID = snapshot.liveSessionId; grant = snapshot.grant
            if let terminal = snapshot.terminal { state = .terminal(terminal); return }
            guard snapshot.lifecycle == "accepted", snapshot.consumerState == "detached", !snapshot.dispatchIntent else {
                state = .outcomeUnknown(.unavailable); return
            }
            state = .attaching
            let connection = try await sockets.connect(LiveSocketBinding(origin: frozen.origin, sessionID: snapshot.liveSessionId,
                                                                       authorityEpoch: frozen.authorityEpoch, profileIdentity: frozen.profileIdentity))
            guard current(token, op), !Task.isCancelled else { await connection.cancel(); return }
            socket = connection
            receiveTask = Task { await self.receive(connection, token: token) }
        } catch {
            if current(token, op) { state = .outcomeUnknown(safe(error, fallback: .transport)) }
        }
    }

    private func receive(_ connection: any LiveSocket, token: UInt64) async {
        var previousSequence = 0
        do {
            while !Task.isCancelled {
                let frame = try await connection.receive()
                guard generation == token, !Task.isCancelled, state == .attaching || state == .active else { return }
                switch frame {
                case .pcm(let pcm):
                    guard state == .active else { throw LiveClientError.invalidFrame }
                    try await sink.write(pcm)
                    guard generation == token, !Task.isCancelled else { return }
                case .marker(let marker):
                    guard marker.sequence > previousSequence else { throw LiveClientError.invalidFrame }
                    previousSequence = marker.sequence
                    if marker.kind == .ready {
                        guard state == .attaching else { throw LiveClientError.invalidFrame }
                        state = .active
                    } else {
                        guard state == .active else { throw LiveClientError.invalidFrame }
                        if marker.kind == .interrupted {
                            try await sink.flush()
                            guard generation == token, !Task.isCancelled else { return }
                        }
                    }
                case .terminal(let terminal, _):
                    state = .terminal(terminal)
                    socket = nil
                    await connection.cancel()
                    return
                }
            }
        } catch {
            guard generation == token, !Task.isCancelled, state == .attaching || state == .active else { return }
            state = .outcomeUnknown(safe(error, fallback: .transport)); socket = nil
            await connection.cancel()
        }
    }

    public func sendPCM(_ pcm: Data) async throws {
        try LiveSocketTransport.validatePCM(pcm)
        guard state == .active, !inputEnded, let connection = socket else { throw LiveClientError.unavailable }
        let token = generation
        guard pendingFrames < maxPendingFrames, pcm.count <= maxPendingBytes - pendingBytes else {
            state = .outcomeUnknown(.queueOverflow); socket = nil; receiveTask?.cancel()
            await connection.cancel()
            throw LiveClientError.queueOverflow
        }
        pendingFrames += 1; pendingBytes += pcm.count
        defer {
            if generation == token { pendingFrames -= 1; pendingBytes -= pcm.count }
        }
        do {
            try await connection.sendPCM(pcm)
            guard generation == token, state == .active else { throw LiveClientError.staleOperation }
        } catch {
            if generation == token, state == .active {
                state = .outcomeUnknown(safe(error, fallback: .transport)); socket = nil; receiveTask?.cancel()
                await connection.cancel()
            }
            throw safe(error, fallback: .transport)
        }
    }

    public func endAudioStream() async throws {
        guard state == .active, !inputEnded, let connection = socket else { throw LiveClientError.unavailable }
        let token = generation; inputEnded = true
        do { try await connection.sendControl(.endAudioStream) }
        catch {
            if generation == token, state == .active { state = .outcomeUnknown(.transport); socket = nil; receiveTask?.cancel(); await connection.cancel() }
            throw LiveClientError.transport
        }
    }

    public func close() async {
        guard state != .idle, !settled else { return }
        guard let frozen = intent, let id = sessionID else {
            operation &+= 1; operationTask?.cancel(); receiveTask?.cancel()
            state = .outcomeUnknown(.unavailable); return
        }
        operation &+= 1; operationTask?.cancel(); receiveTask?.cancel()
        let token = generation, op = operation
        let connection = socket; socket = nil; state = .closing
        do { try await connection?.sendControl(.close) } catch { /* snapshot remains authoritative */ }
        await connection?.cancel()
        guard current(token, op) else { return }
        do {
            let snapshot = try await http.snapshot(sessionID: id, for: frozen)
            guard current(token, op), let key = createKey else { return }
            try validate(snapshot, frozen, key)
            state = snapshot.terminal.map(LiveClientState.terminal) ?? .outcomeUnknown(.transport)
        } catch { if current(token, op) { state = .outcomeUnknown(.unavailable) } }
    }

    public func revoke() async {
        guard state != .idle, !settled else { return }
        operation &+= 1; operationTask?.cancel(); receiveTask?.cancel()
        let token = generation, op = operation
        let connection = socket; socket = nil; state = .closing
        await connection?.cancel()
        guard current(token, op) else { return }
        guard let frozen = intent, let id = sessionID else { state = .outcomeUnknown(.unavailable); return }
        do {
            try await http.revoke(sessionID: id, for: frozen)
            guard current(token, op), let key = createKey else { return }
            let snapshot = try await http.snapshot(sessionID: id, for: frozen)
            guard current(token, op) else { return }
            try validate(snapshot, frozen, key)
            guard let terminal = snapshot.terminal else { state = .outcomeUnknown(.unavailable); return }
            state = .terminal(terminal)
        } catch { if current(token, op) { state = .outcomeUnknown(.unavailable) } }
    }

    public func readSnapshot() async throws -> LiveSnapshot {
        guard !reading, state != .attaching, state != .closing, let frozen = intent, let id = sessionID, let key = createKey else { throw LiveClientError.unavailable }
        operation &+= 1
        let token = generation, op = operation
        reading = true
        defer { if generation == token { reading = false } }
        let snapshot = try await http.snapshot(sessionID: id, for: frozen)
        guard current(token, op) else { throw LiveClientError.staleOperation }
        try validate(snapshot, frozen, key)
        if let terminal = snapshot.terminal, !settled { state = .terminal(terminal); receiveTask?.cancel(); let connection = socket; socket = nil; await connection?.cancel() }
        return snapshot
    }

    public func readJournal(cursor: Int? = nil) async throws -> LiveJournalPage {
        guard !reading, state != .attaching, state != .closing, let frozen = intent, let id = sessionID, cursor == nil || cursor! >= 0 else { throw LiveClientError.unavailable }
        operation &+= 1
        let token = generation, op = operation
        reading = true
        defer { if generation == token { reading = false } }
        let page = try await http.journal(sessionID: id, cursor: cursor, for: frozen)
        guard current(token, op) else { throw LiveClientError.staleOperation }
        guard page.liveSessionId == id, page.fragments.count <= 1000 else { throw LiveClientError.invalidFrame }
        // A journal page's terminal fact is independent of whether its fragments contain a terminal marker.
        if let terminal = page.terminal, !settled { state = .terminal(terminal.outcome); receiveTask?.cancel(); let connection = socket; socket = nil; await connection?.cancel() }
        return page
    }

    /// Explicit stop forgets in-flight identity; constructing a fresh actor does zero work.
    public func stop() async {
        generation &+= 1; operation &+= 1
        operationTask?.cancel(); receiveTask?.cancel()
        operationTask = nil; receiveTask = nil
        let token = generation
        let connection = socket; socket = nil
        intent = nil; createKey = nil; sessionID = nil; grant = nil
        pendingBytes = 0; pendingFrames = 0; inputEnded = false; reading = false; state = .idle
        await connection?.cancel()
        if generation == token { try? await sink.flush() }
    }
    private var settled: Bool { if case .terminal = state { return true }; return false }
    private func current(_ token: UInt64, _ op: UInt64) -> Bool { generation == token && operation == op }
    private func safe(_ error: Error, fallback: LiveClientError) -> LiveClientError { (error as? LiveClientError) ?? fallback }
    private func validateIntent(_ frozen: LiveBeginIntent) throws {
        guard !frozen.assistantID.isEmpty, frozen.provider == "gemini", !frozen.model.isEmpty, !frozen.voice.isEmpty,
              ["ordinary", "private", "sensitive"].contains(frozen.inputClass) else { throw LiveClientError.invalidIntent }
        try LiveSocketTransport.validate(LiveSocketBinding(origin: frozen.origin, sessionID: UUID().uuidString,
                                                          authorityEpoch: frozen.authorityEpoch, profileIdentity: frozen.profileIdentity))
    }
    private func validate(_ status: LiveOperatorStatus, _ frozen: LiveBeginIntent) throws {
        guard status.origin == frozen.origin, status.assistantID == frozen.assistantID, status.authorityEpoch == frozen.authorityEpoch,
              status.provider == frozen.provider, status.model == frozen.model, status.voice == frozen.voice,
              status.profileIdentity == frozen.profileIdentity, status.dataClasses.contains(frozen.inputClass) else { throw LiveClientError.statusMismatch }
    }
    private func validate(_ snapshot: LiveSnapshot, _ frozen: LiveBeginIntent, _ key: String) throws {
        guard UUID(uuidString: snapshot.liveSessionId) != nil,
              snapshot.assistantId == frozen.assistantID, snapshot.authorityEpoch == frozen.authorityEpoch,
              snapshot.idempotencyKey == key, snapshot.profileIdentity == frozen.profileIdentity,
              snapshot.grant.provider == frozen.provider, snapshot.grant.model == frozen.model, snapshot.grant.voice == frozen.voice,
              snapshot.grant.chosenInputClass == frozen.inputClass, snapshot.grant.permittedClasses.contains(frozen.inputClass),
              snapshot.grant.revision > 0, ["accepted", "opening", "active", "terminal"].contains(snapshot.lifecycle),
              (snapshot.lifecycle == "terminal") == (snapshot.terminal != nil) else { throw LiveClientError.grantMismatch }
        if let grant {
            guard snapshot.grant.revision == grant.revision,
                  snapshot.grant.permittedClasses.sorted() == grant.permittedClasses.sorted() else { throw LiveClientError.grantMismatch }
        }
    }
}
