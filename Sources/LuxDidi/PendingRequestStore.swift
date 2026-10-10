import Foundation

public enum PendingRequestPhase: String, Codable, Sendable {
    case prepared
    case dispatchUnknown = "dispatch-unknown"
}
public struct PendingRequestIdentity: Sendable, Equatable {
    public let assistantId: String
    public let authorityEpoch: String
    public let sessionId: String
    public let idempotencyKey: String
    public init(assistantId: String, authorityEpoch: String, sessionId: String, idempotencyKey: String) {
        self.assistantId = assistantId
        self.authorityEpoch = authorityEpoch
        self.sessionId = sessionId
        self.idempotencyKey = idempotencyKey
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        zip([lhs.assistantId, lhs.authorityEpoch, lhs.sessionId, lhs.idempotencyKey],
            [rhs.assistantId, rhs.authorityEpoch, rhs.sessionId, rhs.idempotencyKey])
            .allSatisfy { $0.utf8.elementsEqual($1.utf8) }
    }
}
public struct PendingRequestEnvelope: Sendable, Equatable {
    public let version = 1
    public let identity: PendingRequestIdentity
    public let displayTitle: String
    public let frozenText: String
    public let retryOf: String?
    public let phase: PendingRequestPhase
    public init(identity: PendingRequestIdentity, displayTitle: String, frozenText: String,
                retryOf: String? = nil, phase: PendingRequestPhase = .prepared) {
        self.identity = identity
        self.displayTitle = displayTitle
        self.frozenText = frozenText
        self.retryOf = retryOf
        self.phase = phase
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.identity == rhs.identity && lhs.phase == rhs.phase
            && lhs.displayTitle.utf8.elementsEqual(rhs.displayTitle.utf8)
            && lhs.frozenText.utf8.elementsEqual(rhs.frozenText.utf8)
            && ((lhs.retryOf == nil && rhs.retryOf == nil)
                || (lhs.retryOf != nil && rhs.retryOf != nil && lhs.retryOf!.utf8.elementsEqual(rhs.retryOf!.utf8)))
    }
}
public enum PendingRequestLoad: Sendable, Equatable {
    case empty
    case current(PendingRequestEnvelope)
    case orphaned(PendingRequestEnvelope)
}
public enum PendingRequestError: String, Error, Sendable {
    case invalidDirectory, unsafeDirectory, unsafeFile, invalidEnvelope
    case tooLarge, conflict, wrongRequest, missingRequest, busy, io
}

// Test-first placeholder: deliberately lacks persistence. The first behavioral check must fail.
public actor PendingRequestStore {
    private let directory: String
    public init(directory: String) { self.directory = directory }
    public func prepare(_ envelope: PendingRequestEnvelope) throws -> PendingRequestEnvelope { envelope }
    public func load(assistantId: String, authorityEpoch: String) throws -> PendingRequestLoad { .empty }
    public func markDispatchUnknown(_ identity: PendingRequestIdentity) throws -> PendingRequestEnvelope {
        throw PendingRequestError.missingRequest
    }
    public func acknowledgeAccepted(_ identity: PendingRequestIdentity) throws {}
    public func discardByUser(_ identity: PendingRequestIdentity) throws {}
}
