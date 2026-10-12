import Foundation

/// The local outbox owns only request identity; the service and shared page own chat.
@MainActor final class NativeConnectedSend {
    static let label = "Send to Naya"
    static let consentInstruction = "Enable connected chat in the conversation view."
    enum Failure: LocalizedError {
        case consent, destination, authority
        var errorDescription: String? {
            switch self {
            case .consent: return NativeConnectedSend.consentInstruction
            case .destination: return "Return to the original conversation before retrying this send."
            case .authority: return "Reconnect to the original service before retrying this send."
            }
        }
    }
    private let store: PendingRequestStore
    init(directory: URL) { store = PendingRequestStore(directory: directory.path) }

    func send(text: String, client: CompanionClient) async throws -> (run: String, text: String) {
        let status = try await client.connectedRead("api/v1/status")
        guard let assistant = status["assistantId"] as? String,
              let epoch = status["authorityEpoch"] as? String else { throw CompanionError.invalidResponse }
        let selection = try await client.connectedRead("api/v1/conversation-selection")
        guard let session = selection["sessionId"] as? String, UUID(uuidString: session) != nil,
              let title = selection["title"] as? String else { throw Failure.destination }
        // This read resolves conversation OR valid standing consent on the server.
        let consent: [String: Any]
        do { consent = try await client.connectedRead("api/v1/conversations/" + session) }
        catch CompanionError.rejected { throw Failure.consent }
        guard consent["state"] as? String == "active" else { throw Failure.consent }
        let envelope: PendingRequestEnvelope
        switch try await store.load(assistantId: assistant, authorityEpoch: epoch) {
        case .orphaned: throw Failure.authority
        case .current(let pending):
            guard pending.identity.sessionId == session else { throw Failure.destination }
            envelope = pending
        case .empty:
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CompanionError.invalidConfiguration }
            envelope = try await store.prepare(PendingRequestEnvelope(
                identity: PendingRequestIdentity(assistantId: assistant, authorityEpoch: epoch,
                    sessionId: session, idempotencyKey: UUID().uuidString),
                displayTitle: title, frozenText: text))
        }
        // Persist uncertainty BEFORE crossing the transport boundary; retries retain frozen bytes/key.
        _ = try await store.markDispatchUnknown(envelope.identity)
        let result = try await client.connectedAccept(envelope)
        guard let run = result["runId"] as? String, UUID(uuidString: run) != nil,
              result["sessionId"] as? String == session else { throw CompanionError.invalidResponse }
        try await store.acknowledgeAccepted(envelope.identity)
        return (run, envelope.frozenText)
    }
}
