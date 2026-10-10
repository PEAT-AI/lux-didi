import Foundation
import Darwin

struct Failure: Error, CustomStringConvertible { let description: String }
func expect(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failure(description: message) }
}
func denied(_ code: PendingRequestError, _ operation: () async throws -> Void) async throws {
    do { try await operation(); throw Failure(description: "expected denial: \(code.rawValue)") }
    catch let error as PendingRequestError {
        try expect(error == code, "denial code \(error.rawValue), expected \(code.rawValue)")
        try expect(!String(describing: error).contains("CANARY"), "error disclosed synthetic payload")
    }
}
let owner = "11111111-1111-4111-8111-111111111111"
let epoch = "22222222-2222-4222-8222-222222222222"
let session = "33333333-3333-4333-8333-333333333333"
let other = "44444444-4444-4444-8444-444444444444"
func identity(key: String = "synthetic-stable-key", assistant: String = owner,
              authority: String = epoch, target: String = session) -> PendingRequestIdentity {
    .init(assistantId: assistant, authorityEpoch: authority, sessionId: target, idempotencyKey: key)
}
func envelope(text: String = "Frozen synthetic request: café 🌙\nKeep exactly.",
              key: String = "synthetic-stable-key", retry: String? = nil,
              phase: PendingRequestPhase = .prepared) -> PendingRequestEnvelope {
    .init(identity: identity(key: key), displayTitle: "Pinned synthetic conversation",
          frozenText: text, retryOf: retry, phase: phase)
}
final class Fixture: @unchecked Sendable {
    let root: URL
    let directory: String
    init() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("didi-pending-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        directory = root.appendingPathComponent("pending").path
    }
    deinit { try? FileManager.default.removeItem(at: root) }
    var record: URL { file("pending-request.json") }
    func file(_ name: String) -> URL { URL(fileURLWithPath: directory).appendingPathComponent(name) }
    func seed(_ value: PendingRequestEnvelope = envelope()) async throws -> PendingRequestStore {
        let store = PendingRequestStore(directory: directory)
        _ = try await store.prepare(value)
        return store
    }
    func bytes() throws -> Data { try Data(contentsOf: record) }
    func replace(_ data: Data) throws { try data.write(to: record) }
    func object() throws -> [String: Any] { try JSONSerialization.jsonObject(with: bytes()) as! [String: Any] }
}
func mode(_ path: String) throws -> mode_t {
    var info = stat()
    guard lstat(path, &info) == 0 else { throw Failure(description: "fixture stat failed") }
    return info.st_mode & 0o7777
}
func load(_ fixture: Fixture) async throws -> PendingRequestLoad {
    try await PendingRequestStore(directory: fixture.directory).load(assistantId: owner, authorityEpoch: epoch)
}

func reopen() async throws {
    let f = try Fixture()
    let original = envelope()
    _ = try await f.seed(original)
    try expect(try await load(f) == .current(original), "exact-envelope reopen: prepared request disappeared after store recreation")
    let object = try f.object()
    try expect(object["retryOf"] == nil, "absent retryOf must be omitted, not null")
    try expect(object.count == 8 && object["version"] as? Int == 1, "exact flat DTO")
    try expect(try mode(f.directory) == 0o700 && mode(f.record.path) == 0o600, "private filesystem modes")
    try expect(try mode(f.file(".pending-request.lock").path) == 0o600, "private lock")
}
func conflictsAndTransitions() async throws {
    let f = try Fixture()
    let initial = envelope(text: "é", retry: other)
    let store = try await f.seed(initial)
    let before = try f.bytes()
    try expect(try await store.prepare(initial) == initial, "exact prepare replay")
    let variants = [envelope(text: "e\u{301}", retry: other), envelope(text: "é", key: "different", retry: other),
        envelope(text: "é"), envelope(text: "é", retry: other, phase: .dispatchUnknown),
        PendingRequestEnvelope(identity: identity(assistant: other), displayTitle: initial.displayTitle, frozenText: "é", retryOf: other),
        PendingRequestEnvelope(identity: identity(authority: other), displayTitle: initial.displayTitle, frozenText: "é", retryOf: other),
        PendingRequestEnvelope(identity: identity(target: other), displayTitle: initial.displayTitle, frozenText: "é", retryOf: other),
        PendingRequestEnvelope(identity: initial.identity, displayTitle: "Other title", frozenText: "é", retryOf: other)]
    for variant in variants {
        try await denied(.conflict) { _ = try await store.prepare(variant) }
        try expect(try f.bytes() == before, "conflict overwrote unresolved envelope")
    }
    try await denied(.wrongRequest) { _ = try await store.markDispatchUnknown(identity(key: "other")) }
    let next = try await store.markDispatchUnknown(initial.identity)
    try expect(next.phase == .dispatchUnknown && next.identity == initial.identity
        && next.frozenText.utf8.elementsEqual(initial.frozenText.utf8) && next.retryOf == other
        && next.displayTitle == initial.displayTitle, "transition changed frozen fields")
    try expect(try await load(f) == .current(next), "transition reopen")
    try expect(try await store.markDispatchUnknown(initial.identity) == next, "transition replay")
    try expect(try await store.prepare(next) == next, "exact unknown replay")
    try await denied(.conflict) { _ = try await store.prepare(initial) }
    let empty = try Fixture()
    try await denied(.invalidEnvelope) { _ = try await PendingRequestStore(directory: empty.directory).prepare(next) }
    try await denied(.missingRequest) { _ = try await PendingRequestStore(directory: empty.directory).markDispatchUnknown(identity()) }
}
func identityClassification() async throws {
    let f = try Fixture()
    let store = try await f.seed()
    let original = try f.bytes()
    try expect(try await store.load(assistantId: owner, authorityEpoch: epoch) == .current(envelope()), "current identity")
    try expect(try await store.load(assistantId: other, authorityEpoch: epoch) == .orphaned(envelope()), "orphan owner")
    try expect(try await store.load(assistantId: owner, authorityEpoch: other) == .orphaned(envelope()), "orphan epoch")
    try expect(try f.bytes() == original, "orphan load rewrote identity")
    try await denied(.invalidEnvelope) { _ = try await store.load(assistantId: "", authorityEpoch: epoch) }
}
func exactValidation() async throws {
    let f = try Fixture()
    _ = try await f.seed(envelope(retry: other))
    try expect(try f.object()["retryOf"] as? String == other, "present retry UUID")
    let original = try f.bytes()
    let object = try f.object()
    var malformed: [Data] = [Data(), Data("{broken CANARY_SECRET".utf8), Data([0xff, 0xfe])]
    for (key, value) in [("retryOf", NSNull()), ("version", true), ("version", 1.0),
                         ("version", 2), ("frozenText", 42), ("phase", "accepted"),
                         ("sessionId", ""), ("authorityEpoch", "not-a-uuid"),
                         ("retryOf", "not-a-uuid"), ("credential", "CANARY_SECRET"),
                         ("frozenText", ["extension": "CANARY_SECRET"])] as [(String, Any)] {
        var changed = object
        changed[key] = value
        // JSONSerialization normalizes Double(1.0) to 1; lexical 1.0 is tested below.
        if key == "version", value is Double { continue }
        malformed.append(try JSONSerialization.data(withJSONObject: changed))
    }
    for key in object.keys {
        var missing = object
        missing.removeValue(forKey: key)
        if key != "retryOf" { malformed.append(try JSONSerialization.data(withJSONObject: missing)) }
    }
    let string = String(decoding: original, as: UTF8.self)
    malformed.append(Data(("{\"version\":1," + string.dropFirst()).utf8)) // duplicate key
    malformed.append(Data(string.replacingOccurrences(of: "\"version\":1", with: "\"version\":1.0").utf8))
    malformed.append(Data((string + "CANARY_SECRET").utf8))
    for data in malformed {
        try f.replace(data)
        try await denied(.invalidEnvelope) { _ = try await load(f) }
        try expect(try f.bytes() == data, "malformed file was reset instead of preserved")
        try await denied(.invalidEnvelope) { try await PendingRequestStore(directory: f.directory).discardByUser(identity()) }
    }
    try f.replace(Data(repeating: 32, count: 128 * 1024 + 1))
    try await denied(.tooLarge) { _ = try await load(f) }
    try expect(try f.bytes().count == 128 * 1024 + 1, "oversize preserved")
    let maxFixture = try Fixture()
    let maximum = PendingRequestEnvelope(identity: identity(key: String(repeating: "k", count: 128)),
        displayTitle: String(repeating: "t", count: 1000), frozenText: String(repeating: "🌙", count: 8000))
    _ = try await maxFixture.seed(maximum)
    try expect(try await load(maxFixture) == .current(maximum), "accepted UTF16 upper bounds")
    let escapedFixture = try Fixture()
    let escaped = envelope(text: String(repeating: "\u{0001}", count: 16000))
    _ = try await escapedFixture.seed(escaped)
    try expect(try await load(escapedFixture) == .current(escaped), "escaping fits explicit envelope byte bound")
    let invalid = [envelope(text: String(repeating: "a", count: 16001)), envelope(text: " \n"),
        envelope(key: String(repeating: "k", count: 129)), envelope(key: ""), envelope(retry: ""),
        PendingRequestEnvelope(identity: identity(assistant: ""), displayTitle: "title", frozenText: "text"),
        PendingRequestEnvelope(identity: identity(target: "00000000-0000-0000-0000-000000000000"), displayTitle: "title", frozenText: "text"),
        PendingRequestEnvelope(identity: identity(), displayTitle: String(repeating: "t", count: 1001), frozenText: "text")]
    for value in invalid {
        let empty = try Fixture()
        try await denied(.invalidEnvelope) { _ = try await PendingRequestStore(directory: empty.directory).prepare(value) }
        try expect(!FileManager.default.fileExists(atPath: empty.record.path), "invalid DTO manufactured record")
    }
}
func unsafePaths() async throws {
    let f = try Fixture()
    _ = try await f.seed()
    let original = try f.bytes()
    for path in ["relative/path", f.directory + "/../pending", f.directory + "/", f.directory + "\0escape"] {
        try await denied(.invalidDirectory) { _ = try await PendingRequestStore(directory: path).load(assistantId: owner, authorityEpoch: epoch) }
    }
    let alias = f.root.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: f.directory)
    try await denied(.unsafeDirectory) { _ = try await PendingRequestStore(directory: alias.path).load(assistantId: owner, authorityEpoch: epoch) }
    try await denied(.unsafeDirectory) { _ = try await PendingRequestStore(directory: alias.appendingPathComponent("child").path).prepare(envelope()) }
    try expect(!FileManager.default.fileExists(atPath: f.file("child").path), "ancestor symlink followed")
    guard chmod(f.directory, 0o755) == 0 else { throw Failure(description: "fixture chmod") }
    try await denied(.unsafeDirectory) { _ = try await load(f) }
    guard chmod(f.directory, 0o700) == 0 else { throw Failure(description: "fixture chmod") }
    for permissions in [mode_t(0o644), mode_t(0o400), mode_t(0o1600)] {
        guard chmod(f.record.path, permissions) == 0 else { throw Failure(description: "fixture chmod") }
        try await denied(.unsafeFile) { _ = try await load(f) }
        try expect(try f.bytes() == original, "unsafe mode modified record")
    }
    guard chmod(f.record.path, 0o600) == 0 else { throw Failure(description: "fixture chmod") }
    let linked = f.root.appendingPathComponent("hard-linked")
    guard link(f.record.path, linked.path) == 0 else { throw Failure(description: "fixture hard link") }
    try await denied(.unsafeFile) { _ = try await load(f) }
    try FileManager.default.removeItem(at: linked)
    let moved = f.root.appendingPathComponent("preserved")
    try FileManager.default.moveItem(at: f.record, to: moved)
    try FileManager.default.createSymbolicLink(atPath: f.record.path, withDestinationPath: moved.path)
    try await denied(.unsafeFile) { _ = try await load(f) }
    try expect(try Data(contentsOf: moved) == original, "symlink target changed")
    try FileManager.default.removeItem(at: f.record)
    guard mkfifo(f.record.path, 0o600) == 0 else { throw Failure(description: "fixture fifo") }
    try await denied(.unsafeFile) { _ = try await load(f) }
    try FileManager.default.removeItem(at: f.record)
    try FileManager.default.moveItem(at: moved, to: f.record)
    for name in [".pending-request.lock", ".pending-request.next"] {
        let path = f.file(name)
        if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
        try FileManager.default.createSymbolicLink(atPath: path.path, withDestinationPath: f.record.path)
        try await denied(.unsafeFile) { _ = try await load(f) }
        try expect(try f.bytes() == original, "unsafe internal path changed record")
        try FileManager.default.removeItem(at: path)
    }
}
func foreignOwner() async throws {
    let f = try Fixture()
    _ = try await f.seed()
    let original = try f.bytes()
    // Unprivileged macOS cannot chown fixtures to another UID. Exercise the exact
    // production metadata validator with fstat from a real private file and one changed UID.
    let fd = open(f.record.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw Failure(description: "fixture owner open") }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw Failure(description: "fixture owner stat") }
    info.st_uid = geteuid() == 0 ? 1 : 0
    do {
        try PendingRequestStore.validateFileMetadata(info)
        throw Failure(description: "foreign-owner metadata accepted")
    } catch let error as PendingRequestError {
        try expect(error == .unsafeFile, "foreign-owner metadata denial")
    }
    // Real foreign-owned system temporary directory is opened read-only and rejected
    // before any lock/record creation. No system files are linked, copied, or changed.
    if geteuid() != 0 {
        try await denied(.unsafeDirectory) {
            _ = try await PendingRequestStore(directory: "/private/tmp").load(assistantId: owner, authorityEpoch: epoch)
        }
    }
    try expect(try f.bytes() == original, "owner denial modified fixture")
}
func clearActions() async throws {
    let f = try Fixture()
    let store = try await f.seed()
    let original = try f.bytes()
    for wrong in [identity(key: "wrong"), identity(assistant: other), identity(authority: other), identity(target: other)] {
        try await denied(.wrongRequest) { try await store.acknowledgeAccepted(wrong) }
        try await denied(.wrongRequest) { try await store.discardByUser(wrong) }
        try expect(try f.bytes() == original, "wrong-request clear changed file")
    }
    try await store.acknowledgeAccepted(identity())
    try await store.acknowledgeAccepted(identity())
    try expect(try await load(f) == .empty, "matching acknowledge didn't clear")
    _ = try await store.prepare(envelope(key: "next"))
    try await denied(.wrongRequest) { try await store.acknowledgeAccepted(identity()) }
    try await store.discardByUser(identity(key: "next"))
    try await store.discardByUser(identity(key: "next"))
    try expect(try await load(f) == .empty, "explicit discard didn't clear")
}
func writeFailure() async throws {
    for stage in [PendingRequestStore.Checkpoint.tempCreated, .tempSynced] {
        let f = try Fixture()
        _ = try await f.seed()
        let original = try f.bytes()
        let faulty = PendingRequestStore(directory: f.directory) { point in
            if point == stage { throw Failure(description: "CANARY_SECRET underlying write failure") }
        }
        try await denied(.io) { _ = try await faulty.markDispatchUnknown(identity()) }
        try expect(try f.bytes() == original, "failed write lost old envelope")
        try expect(!FileManager.default.fileExists(atPath: f.file(".pending-request.next").path), "failed write leaked temp")
        let empty = try Fixture()
        let failedPrepare = PendingRequestStore(directory: empty.directory) { point in
            if point == stage { throw Failure(description: "CANARY_SECRET initial write failure") }
        }
        try await denied(.io) { _ = try await failedPrepare.prepare(envelope()) }
        try expect(try await load(empty) == .empty, "initial write failure reported/retained success")
    }
    let f = try Fixture()
    _ = try await f.seed()
    let original = try f.bytes()
    // Actual rename failure, not just injected exception: the target becomes a directory.
    let saved = f.root.appendingPathComponent("saved")
    let faulty = PendingRequestStore(directory: f.directory) { point in
        if point == .tempSynced {
            guard rename(f.record.path, saved.path) == 0, mkdir(f.record.path, 0o700) == 0 else {
                throw Failure(description: "fixture rename failure setup")
            }
        }
    }
    try await denied(.io) { _ = try await faulty.markDispatchUnknown(identity()) }
    try expect(try Data(contentsOf: saved) == original, "rename failure destroyed prior bytes")
    try FileManager.default.removeItem(at: f.record)
    try FileManager.default.moveItem(at: saved, to: f.record)
    try expect(try await load(f) == .current(envelope()), "rename failure restoration")
}

final class Child {
    let process = Process()
    let output = Pipe()
    let input = Pipe()
    init(directory: String, operation: String, checkpoint: String) throws {
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = ["--child", directory, operation, checkpoint]
        process.standardOutput = output
        process.standardInput = input
        process.standardError = FileHandle.standardError
        try process.run()
        let marker = output.fileHandleForReading.readData(ofLength: 1)
        try expect(marker == Data([33]), "child failed before deterministic checkpoint")
    }
    func terminate() {
        if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }
    deinit { terminate() }
}
func child(operation: String, directory: String, stage: String) async throws {
    let store = PendingRequestStore(directory: directory) { checkpoint in
        if checkpoint.rawValue == stage {
            var marker: UInt8 = 33
            guard Darwin.write(STDOUT_FILENO, &marker, 1) == 1 else { throw PendingRequestError.io }
            var byte: UInt8 = 0
            _ = Darwin.read(STDIN_FILENO, &byte, 1) // parent kills only after observing checkpoint.
        }
    }
    if operation == "prepare" { _ = try await store.prepare(envelope()) }
    else { _ = try await store.markDispatchUnknown(identity()) }
}
func processDeathAndContention() async throws {
    for operation in ["prepare", "transition"] {
        for stage in ["tempCreated", "tempSynced", "committed"] {
            let f = try Fixture()
            if operation == "transition" { _ = try await f.seed() }
            let child = try Child(directory: f.directory, operation: operation, checkpoint: stage)
            let competitor = PendingRequestStore(directory: f.directory)
            try await denied(.busy) { _ = try await competitor.prepare(envelope(key: "competitor")) }
            try await denied(.busy) { try await competitor.acknowledgeAccepted(identity()) }
            child.terminate()
            let actual = try await load(f)
            let expected: PendingRequestLoad = operation == "prepare"
                ? (stage == "committed" ? .current(envelope()) : .empty)
                : .current(envelope(phase: stage == "committed" ? .dispatchUnknown : .prepared))
            try expect(actual == expected, "killed \(operation)/\(stage) reopened inconsistent request")
            try expect(!FileManager.default.fileExists(atPath: f.file(".pending-request.next").path), "kill recovery leaked temp")
            if actual == .empty { _ = try await competitor.prepare(envelope(key: "competitor")) }
            else { try await denied(.conflict) { _ = try await competitor.prepare(envelope(key: "competitor")) } }
        }
    }
}

@main struct Runner {
    static func main() async {
        alarm(120) // bounded deadlock guard, not a scheduling assumption or artificial load.
        do {
            if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--child" {
                try await child(operation: CommandLine.arguments[3], directory: CommandLine.arguments[2], stage: CommandLine.arguments[4])
                return
            }
            let tests: [(String, () async throws -> Void)] = [
                ("exact-envelope reopen", reopen), ("immutable conflicts and transitions", conflictsAndTransitions),
                ("current vs orphaned identity", identityClassification), ("exact DTO validation and size bounds", exactValidation),
                ("unsafe paths modes links and internal files", unsafePaths), ("foreign-owner denial", foreignOwner),
                ("matching acknowledge and explicit discard", clearActions), ("write failures preserve previous request", writeFailure),
                ("real process death and competing writers", processDeathAndContention)]
            var durations: [(String, TimeInterval)] = []
            for (name, test) in tests {
                let start = Date()
                try await test()
                durations.append((name, Date().timeIntervalSince(start)))
                print("PASS \(name)")
            }
            if CommandLine.arguments.contains("--durations=10") {
                for (name, seconds) in durations.sorted(by: { $0.1 > $1.1 }).prefix(10) {
                    print(String(format: "DURATION %.3fs %@", seconds, name))
                }
            }
            print("PASS \(tests.count) scenarios; real Foundation/POSIX files and child process fixtures")
        } catch {
            // Expected file/IO failures are asserted as sanitized typed codes, never printed payloads.
            print("FAIL \(error)")
            exit(1)
        }
    }
}
