import Foundation

public struct ConnectedAuthority: Sendable, Equatable {
    public let assistantId: String
    public let authorityEpoch: String
    public init(assistantId: String, authorityEpoch: String) { self.assistantId = assistantId; self.authorityEpoch = authorityEpoch }
}
public struct ConnectedDestination: Sendable, Equatable {
    public let sessionId: String
    public let title: String
}
/// The existing authenticated page transport owns cookies, Origin, CSRF and finite HTTP behavior.
public protocol ConnectedConversationTransport: Sendable {
    func selection() async throws -> Data
    func send(_ request: ConnectedChatRequest) async throws -> Data
}
public struct ConnectedChatRequest: Sendable {
    public let sessionId: String
    public let text: String
    public let retryOf: String?
    public let idempotencyKey: String
    public let authorityEpoch: String
    public let body: Data
    init(_ envelope: PendingRequestEnvelope) throws {
        sessionId = envelope.identity.sessionId; text = envelope.frozenText; retryOf = envelope.retryOf
        idempotencyKey = envelope.identity.idempotencyKey; authorityEpoch = envelope.identity.authorityEpoch
        var dto = ["sessionId": sessionId, "text": text]
        if let retryOf { dto["retryOf"] = retryOf }
        body = try JSONSerialization.data(withJSONObject: dto, options: [.sortedKeys, .withoutEscapingSlashes])
    }
}
public enum ConnectedDraftState: String, Sendable {
    case idle, resolving, editable, unavailable, preparing, unknown, orphan, storageFailure, accepted
}

/// One draft and one canonical durable request. No transcript, credentials or HTTP implementation.
@MainActor public final class ConnectedDraft {
    public private(set) var state: ConnectedDraftState = .idle
    public private(set) var text = ""
    public private(set) var target: ConnectedDestination?
    public private(set) var pending: PendingRequestEnvelope?
    public private(set) var acceptedRunId: String?
    public var canRecord: Bool { state == .editable && pending == nil && transport != nil && !working && !restoring }
    private let store: PendingRequestStore
    private var authority: ConnectedAuthority?
    private var transport: (any ConnectedConversationTransport)?
    private var generation: UInt64 = 0
    private var resolution: UInt64 = 0
    private var working = false
    private var restoring = false
    private var storageBlocked = false

    public init(store: PendingRequestStore) { self.store = store }
    public func connect(authority: ConnectedAuthority, transport: any ConnectedConversationTransport) async {
        generation &+= 1; resolution &+= 1
        let ticket = generation
        if self.authority != authority { target = nil }
        self.authority = authority; self.transport = transport; restoring = true
        do {
            let loaded = try await store.load(assistantId: authority.assistantId, authorityEpoch: authority.authorityEpoch)
            guard ticket == generation else { return }
            storageBlocked = false; restoring = false
            switch loaded {
            case .empty:
                pending = nil; state = target == nil ? .idle : .editable
            case .current(let envelope): install(envelope); state = .unknown
            case .orphaned(let envelope): install(envelope); state = .orphan
            }
        } catch {
            guard ticket == generation else { return }
            restoring = false; storageBlocked = true; state = .storageFailure
        }
    }
    public func disconnect() {
        generation &+= 1; resolution &+= 1; transport = nil; restoring = false
        if pending == nil && !storageBlocked { state = .unavailable }
    }
    public func beginDraft() async {
        guard !working, !restoring, !storageBlocked, pending == nil else { return }
        resolution &+= 1; let ticket = resolution; let connection = generation
        target = nil; acceptedRunId = nil; state = .resolving
        guard let authority, let transport else { state = .unavailable; return }
        do {
            let data = try await transport.selection()
            guard ticket == resolution, connection == generation else { return }
            if Task.isCancelled { state = .idle; return }
            let wrapper = try JSONDecoder().decode(SelectionResponse.self, from: data)
            guard same(wrapper.authorityEpoch, authority.authorityEpoch), !wrapper.requestId.isEmpty else { state = .unavailable; return }
            guard let session = wrapper.data.sessionId, let title = wrapper.data.title,
                  uuid(session), !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 1000 else {
                state = .unavailable; return
            }
            target = ConnectedDestination(sessionId: session, title: title); text = ""; state = .editable
        } catch {
            guard ticket == resolution, connection == generation else { return }
            state = .unavailable
        }
    }
    public func cancelDraft() {
        guard !working, pending == nil, !storageBlocked else { return }
        resolution &+= 1; target = nil; text = ""; state = .idle
    }
    public func setText(_ value: String) {
        guard target != nil, pending == nil, !working, !restoring, !storageBlocked else { return }
        text = value; state = .editable
    }
    public func send(retryOf: String? = nil) async {
        guard !working, !restoring, !storageBlocked, pending == nil, let target, let authority, transport != nil else { return }
        working = true; defer { working = false }
        let connection = generation
        let frozen = PendingRequestEnvelope(identity: .init(assistantId: authority.assistantId, authorityEpoch: authority.authorityEpoch,
            sessionId: target.sessionId, idempotencyKey: UUID().uuidString), displayTitle: target.title, frozenText: text, retryOf: retryOf, phase: .prepared)
        state = .preparing
        do {
            let prepared = try await store.prepare(frozen)
            install(prepared)
            await dispatch(prepared, connection: connection)
        } catch { state = .storageFailure }
    }
    public func replay() async {
        guard !working, !restoring, !storageBlocked, let pending, matches(pending), transport != nil else { return }
        working = true; defer { working = false }
        await dispatch(pending, connection: generation)
    }
    public func discard(_ identity: PendingRequestIdentity) async {
        guard !working, !restoring, let pending, pending.identity == identity else { return }
        working = true; defer { working = false }
        do {
            try await store.discardByUser(identity)
            // A reconnect cannot authorize clearing a different in-memory identity.
            guard self.pending?.identity == identity else { return }
            self.pending = nil; target = nil; text = ""; state = .idle
        } catch { state = .storageFailure }
    }
    private func install(_ envelope: PendingRequestEnvelope) {
        pending = envelope; text = envelope.frozenText
        target = .init(sessionId: envelope.identity.sessionId, title: envelope.displayTitle)
    }
    private func matches(_ envelope: PendingRequestEnvelope) -> Bool {
        guard let authority else { return false }
        return same(authority.assistantId, envelope.identity.assistantId) && same(authority.authorityEpoch, envelope.identity.authorityEpoch)
    }
    private func dispatch(_ saved: PendingRequestEnvelope, connection: UInt64) async {
        do {
            let marked = try await store.markDispatchUnknown(saved.identity)
            install(marked)
            state = matches(marked) ? .unknown : .orphan
            guard connection == generation, matches(marked), !Task.isCancelled, let transport else { return }
            let request = try ConnectedChatRequest(marked)
            let data = try await transport.send(request)
            guard connection == generation, !Task.isCancelled, pending?.identity == marked.identity else { return }
            let run = try acceptedSnapshot(data, for: marked)
            try await store.acknowledgeAccepted(marked.identity)
            guard pending?.identity == marked.identity else { return }
            pending = nil; acceptedRunId = run.runId; state = .accepted
        } catch let error as PendingRequestError {
            // Typed persistence failures are not wire failures and must be visible.
            _ = error; state = .storageFailure
        } catch {
            // HTTP denial/loss/malformed acceptance is conservative: never replace the frozen request.
            state = pending.map { matches($0) ? .unknown : .orphan } ?? .storageFailure
        }
    }
}

private struct SelectionResponse: Decodable {
    struct Selection: Decodable { let sessionId: String?; let title: String? }
    let data: Selection; let requestId: String; let authorityEpoch: String
}
private struct RunResponse: Decodable {
    let data: RunSnapshot; let requestId: String; let authorityEpoch: String
}
private struct RunSnapshot: Decodable {
    let runId: String; let sessionId: String; let userEntryId: String; let finalEntryId: String?
    let finalText: String?; let retryOf: String?; let authorityEpoch: String; let provider: String; let model: String
    let promptVersion: String; let state: String; let outcome: String?; let sequence: Int; let partialText: String
    let partialTruncated: Bool; let acceptedAt: String; let intentAt: String?; let terminalAt: String?; let mayHaveBeenSent: Bool
}
private enum InvalidResponse: Error { case invalid }
private func same(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
private func uuid(_ value: String) -> Bool {
    value.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
}
private func acceptedSnapshot(_ data: Data, for envelope: PendingRequestEnvelope) throws -> RunSnapshot {
    // Optional fields are required JSON keys with nullable values in the accepted RunSnapshot wire.
    let keys: Set<String> = ["runId", "sessionId", "userEntryId", "finalEntryId", "finalText", "retryOf", "authorityEpoch", "provider", "model", "promptVersion", "state", "outcome", "sequence", "partialText", "partialTruncated", "acceptedAt", "intentAt", "terminalAt", "mayHaveBeenSent"]
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let raw = object["data"] as? [String: Any], keys.isSubset(of: Set(raw.keys)) else { throw InvalidResponse.invalid }
    let wrapper = try JSONDecoder().decode(RunResponse.self, from: data); let run = wrapper.data
    let outcomes: Set<String> = ["complete", "denied", "blocked", "error", "empty", "truncated", "cancelled", "deadline", "not_dispatched", "outcome_unknown", "unavailable", "input_too_large", "compile_failed", "persistence_failed"]
    let dates = ISO8601DateFormatter(); dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    func timestamp(_ value: String) -> Bool {
        if dates.date(from: value) != nil { return true }
        let plain = ISO8601DateFormatter(); return plain.date(from: value) != nil
    }
    guard !wrapper.requestId.isEmpty, same(wrapper.authorityEpoch, envelope.identity.authorityEpoch),
          same(run.authorityEpoch, envelope.identity.authorityEpoch), same(run.sessionId, envelope.identity.sessionId),
          (run.retryOf == nil && envelope.retryOf == nil) || (run.retryOf != nil && envelope.retryOf != nil && same(run.retryOf!, envelope.retryOf!)),
          uuid(run.runId), uuid(run.userEntryId), run.finalEntryId.map(uuid) ?? true,
          !run.provider.isEmpty, !run.model.isEmpty, !run.promptVersion.isEmpty, run.sequence >= 0,
          timestamp(run.acceptedAt), run.intentAt.map(timestamp) ?? true, run.terminalAt.map(timestamp) ?? true,
          ["accepted", "dispatch_intent", "terminal"].contains(run.state), run.outcome.map(outcomes.contains) ?? true,
          (run.state == "terminal" ? (run.outcome != nil && run.terminalAt != nil) : (run.outcome == nil && run.terminalAt == nil)),
          run.mayHaveBeenSent == (run.intentAt != nil),
          (run.state != "accepted" || run.intentAt == nil),
          (run.state != "dispatch_intent" || run.intentAt != nil),
          (run.finalEntryId == nil) == (run.finalText == nil) else { throw InvalidResponse.invalid }
    return run
}
