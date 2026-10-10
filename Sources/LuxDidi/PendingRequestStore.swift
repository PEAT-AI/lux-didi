import Foundation
import Darwin

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

/// A single local outbox identity, not a transcript or transport. Await from MainActor.
/// File operations execute on this actor; flock rejects other cooperative writers.
public actor PendingRequestStore {
    private static let record = "pending-request.json"
    private static let temporary = ".pending-request.next"
    private static let lock = ".pending-request.lock"
    private static let maximumBytes = 128 * 1024
    private let directory: String

    #if PENDING_REQUEST_TESTING
    enum Checkpoint: String, Sendable { case tempCreated, tempSynced, committed }
    private let checkpoint: @Sendable (Checkpoint) throws -> Void
    init(directory: String, checkpoint: @escaping @Sendable (Checkpoint) throws -> Void) {
        self.directory = directory
        self.checkpoint = checkpoint
    }
    #endif

    public init(directory: String) {
        self.directory = directory
        #if PENDING_REQUEST_TESTING
        self.checkpoint = { _ in }
        #endif
    }

    public func prepare(_ envelope: PendingRequestEnvelope) throws -> PendingRequestEnvelope {
        try Self.validate(envelope)
        return try locked { fd in
            if let existing = try readRecord(fd) {
                guard existing == envelope else { throw PendingRequestError.conflict }
                return existing
            }
            guard envelope.phase == .prepared else { throw PendingRequestError.invalidEnvelope }
            try replace(envelope, in: fd)
            return envelope
        }
    }

    public func load(assistantId: String, authorityEpoch: String) throws -> PendingRequestLoad {
        guard Self.uuid(assistantId), Self.uuid(authorityEpoch) else { throw PendingRequestError.invalidEnvelope }
        return try locked { fd in
            guard let envelope = try readRecord(fd) else { return .empty }
            return envelope.identity.assistantId.utf8.elementsEqual(assistantId.utf8)
                && envelope.identity.authorityEpoch.utf8.elementsEqual(authorityEpoch.utf8)
                ? .current(envelope) : .orphaned(envelope)
        }
    }

    public func markDispatchUnknown(_ identity: PendingRequestIdentity) throws -> PendingRequestEnvelope {
        try Self.validate(identity)
        return try locked { fd in
            guard let existing = try readRecord(fd) else { throw PendingRequestError.missingRequest }
            guard existing.identity == identity else { throw PendingRequestError.wrongRequest }
            if existing.phase == .dispatchUnknown { return existing }
            let next = PendingRequestEnvelope(identity: existing.identity, displayTitle: existing.displayTitle,
                frozenText: existing.frozenText, retryOf: existing.retryOf, phase: .dispatchUnknown)
            try replace(next, in: fd)
            return next
        }
    }

    /// Caller must already possess valid durable CHAT acceptance. This does not establish it.
    public func acknowledgeAccepted(_ identity: PendingRequestIdentity) throws { try clear(identity) }
    /// Explicit user-authorized local discard, never an automatic failure recovery path.
    public func discardByUser(_ identity: PendingRequestIdentity) throws { try clear(identity) }

    private func clear(_ identity: PendingRequestIdentity) throws {
        try Self.validate(identity)
        try locked { fd in
            guard let existing = try readRecord(fd) else { return }
            guard existing.identity == identity else { throw PendingRequestError.wrongRequest }
            guard unlinkat(fd, Self.record, 0) == 0 else { throw PendingRequestError.io }
        }
    }

    private static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && value.range(
            of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            options: [.regularExpression, .caseInsensitive]) != nil
    }
    private static func text(_ value: String, maximum: Int) -> Bool {
        value.utf16.count <= maximum && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private static func validate(_ identity: PendingRequestIdentity) throws {
        guard uuid(identity.assistantId), uuid(identity.authorityEpoch), uuid(identity.sessionId),
              text(identity.idempotencyKey, maximum: 128) else { throw PendingRequestError.invalidEnvelope }
    }
    private static func validate(_ envelope: PendingRequestEnvelope) throws {
        try validate(envelope.identity)
        guard text(envelope.displayTitle, maximum: 1000), text(envelope.frozenText, maximum: 16000),
              envelope.retryOf.map(uuid) ?? true else { throw PendingRequestError.invalidEnvelope }
    }

    // Descriptors anchor each component: no realpath-then-open race or symlink following.
    private func openDirectory() throws -> Int32 {
        let parts = directory.split(separator: "/", omittingEmptySubsequences: false)
        guard directory.hasPrefix("/"), parts.count > 1, !directory.utf8.contains(0),
              parts.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
        else { throw PendingRequestError.invalidDirectory }
        var fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw PendingRequestError.io }
        do {
            for (index, part) in parts.dropFirst().enumerated() {
                let final = index == parts.count - 2
                let name = String(part)
                var next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0 && errno == ENOENT && final {
                    guard mkdirat(fd, name, 0o700) == 0 || errno == EEXIST else { throw PendingRequestError.io }
                    next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard next >= 0 else { throw PendingRequestError.unsafeDirectory }
                close(fd)
                fd = next
                var info = stat()
                guard fstat(fd, &info) == 0 else { throw PendingRequestError.io }
                let mode = info.st_mode & 0o7777
                if final {
                    guard info.st_uid == geteuid(), mode == 0o700 else { throw PendingRequestError.unsafeDirectory }
                } else {
                    // Root-owned sticky system temp is safe to traverse; final root remains private.
                    let stickySystem = info.st_uid == 0 && mode & 0o1000 != 0
                    guard (info.st_uid == 0 || info.st_uid == geteuid()),
                          mode & 0o022 == 0 || stickySystem else { throw PendingRequestError.unsafeDirectory }
                }
            }
            return fd
        } catch {
            close(fd)
            throw error
        }
    }

    private func validateFile(_ fd: Int32) throws -> stat {
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw PendingRequestError.io }
        try Self.validateFileMetadata(info)
        return info
    }
    // Internal seam permits an unprivileged test to exercise foreign-UID metadata denial.
    // All actual file opens always obtain this metadata from fstat, never from a caller.
    static func validateFileMetadata(_ info: stat) throws {
        guard info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o7777 == 0o600,
              info.st_uid == geteuid(), info.st_nlink == 1 else { throw PendingRequestError.unsafeFile }
        guard info.st_size >= 0, info.st_size <= Int64(Self.maximumBytes) else { throw PendingRequestError.tooLarge }
    }
    private func openFile(_ name: String, in directoryFD: Int32) throws -> Int32? {
        let fd = openat(directoryFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw PendingRequestError.unsafeFile
        }
        do { _ = try validateFile(fd); return fd }
        catch { close(fd); throw error }
    }
    private func locked<T>(_ operation: (Int32) throws -> T) throws -> T {
        do {
            let fd = try openDirectory()
            defer { close(fd) }
            let lockFD = openat(fd, Self.lock, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            guard lockFD >= 0 else { throw PendingRequestError.unsafeFile }
            defer { close(lockFD) }
            _ = try validateFile(lockFD)
            guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
                throw errno == EWOULDBLOCK ? PendingRequestError.busy : PendingRequestError.io
            }
            defer { _ = flock(lockFD, LOCK_UN) }
            // Only the reserved, validated one-link private write-ahead file is recovered.
            if let stale = try openFile(Self.temporary, in: fd) {
                close(stale)
                guard unlinkat(fd, Self.temporary, 0) == 0 else { throw PendingRequestError.io }
            }
            return try operation(fd)
        } catch let error as PendingRequestError { throw error }
        catch { throw PendingRequestError.io }
    }

    private func readRecord(_ directoryFD: Int32) throws -> PendingRequestEnvelope? {
        guard let fd = try openFile(Self.record, in: directoryFD) else { return nil }
        defer { close(fd) }
        var bytes = [UInt8](repeating: 0, count: Self.maximumBytes + 1)
        var count = 0
        while count < bytes.count {
            let received = bytes.withUnsafeMutableBytes {
                Darwin.read(fd, $0.baseAddress!.advanced(by: count), $0.count - count)
            }
            if received < 0 && errno == EINTR { continue }
            guard received >= 0 else { throw PendingRequestError.io }
            if received == 0 { break }
            count += received
        }
        guard count <= Self.maximumBytes else { throw PendingRequestError.tooLarge }
        _ = try validateFile(fd)
        return try Self.decode(Data(bytes.prefix(count)))
    }

    private func replace(_ envelope: PendingRequestEnvelope, in directoryFD: Int32) throws {
        var object: [String: Any] = ["version": 1, "assistantId": envelope.identity.assistantId,
            "authorityEpoch": envelope.identity.authorityEpoch, "sessionId": envelope.identity.sessionId,
            "idempotencyKey": envelope.identity.idempotencyKey, "displayTitle": envelope.displayTitle,
            "frozenText": envelope.frozenText, "phase": envelope.phase.rawValue]
        if let retry = envelope.retryOf { object["retryOf"] = retry }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count <= Self.maximumBytes else { throw PendingRequestError.tooLarge }
        let fd = openat(directoryFD, Self.temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw PendingRequestError.io }
        var openFD = true
        var committed = false
        defer {
            if openFD { close(fd) }
            if !committed { _ = unlinkat(directoryFD, Self.temporary, 0) }
        }
        _ = try validateFile(fd)
        #if PENDING_REQUEST_TESTING
        try checkpoint(.tempCreated)
        #endif
        try data.withUnsafeBytes { buffer in
            var written = 0
            while written < buffer.count {
                let result = Darwin.write(fd, buffer.baseAddress!.advanced(by: written), buffer.count - written)
                if result < 0 && errno == EINTR { continue }
                guard result > 0 else { throw PendingRequestError.io }
                written += result
            }
        }
        guard fsync(fd) == 0 else { throw PendingRequestError.io }
        #if PENDING_REQUEST_TESTING
        try checkpoint(.tempSynced)
        #endif
        openFD = false // close failure must not cause a second close on a reused descriptor.
        guard close(fd) == 0 else { throw PendingRequestError.io }
        guard renameat(directoryFD, Self.temporary, directoryFD, Self.record) == 0 else { throw PendingRequestError.io }
        committed = true // No fallible production operation follows the rename commit point.
        #if PENDING_REQUEST_TESTING
        try? checkpoint(.committed)
        #endif
    }

    // Flat scalar DTO parser. Foundation dictionary decoding alone silently accepts duplicate keys.
    // Strings use the real JSON decoder; the small grammar rejects duplicate/extra/null/nested fields.
    private static func decode(_ data: Data) throws -> PendingRequestEnvelope {
        var parser = FlatJSON(data: data)
        let fields = try parser.parse()
        let required: Set<String> = ["version", "assistantId", "authorityEpoch", "sessionId",
            "idempotencyKey", "displayTitle", "frozenText", "phase"]
        guard Set(fields.keys).subtracting(["retryOf"]) == required, fields["version"] == "1",
              let phase = PendingRequestPhase(rawValue: fields["phase"]!) else { throw PendingRequestError.invalidEnvelope }
        let result = PendingRequestEnvelope(identity: .init(assistantId: fields["assistantId"]!,
            authorityEpoch: fields["authorityEpoch"]!, sessionId: fields["sessionId"]!,
            idempotencyKey: fields["idempotencyKey"]!), displayTitle: fields["displayTitle"]!,
            frozenText: fields["frozenText"]!, retryOf: fields["retryOf"], phase: phase)
        try validate(result)
        return result
    }
}

private struct FlatJSON {
    let bytes: [UInt8]
    var index = 0
    init(data: Data) { bytes = Array(data) }
    mutating func whitespace() {
        while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
    }
    mutating func take(_ byte: UInt8) -> Bool {
        whitespace()
        guard index < bytes.count, bytes[index] == byte else { return false }
        index += 1
        return true
    }
    mutating func string() throws -> String {
        whitespace()
        let start = index
        guard take(34) else { throw PendingRequestError.invalidEnvelope }
        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            if byte == 92 {
                guard index < bytes.count else { break }
                index += 1
            } else if byte == 34 {
                do { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<index])) }
                catch { throw PendingRequestError.invalidEnvelope }
            }
        }
        throw PendingRequestError.invalidEnvelope
    }
    mutating func parse() throws -> [String: String] {
        guard take(123) else { throw PendingRequestError.invalidEnvelope }
        var fields: [String: String] = [:]
        repeat {
            let key = try string()
            guard fields[key] == nil, take(58) else { throw PendingRequestError.invalidEnvelope }
            if key == "version" {
                guard take(49) else { throw PendingRequestError.invalidEnvelope }
                fields[key] = "1"
            } else { fields[key] = try string() }
            if take(125) { break }
            guard take(44) else { throw PendingRequestError.invalidEnvelope }
        } while true
        whitespace()
        guard index == bytes.count else { throw PendingRequestError.invalidEnvelope }
        return fields
    }
}
