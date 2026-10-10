import Foundation
import Darwin

struct Failure: Error, CustomStringConvertible {
    let description: String
}
func expect(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failure(description: message) }
}
let owner = "11111111-1111-4111-8111-111111111111"
let epoch = "22222222-2222-4222-8222-222222222222"
let session = "33333333-3333-4333-8333-333333333333"
func identity(key: String = "synthetic-stable-key") -> PendingRequestIdentity {
    .init(assistantId: owner, authorityEpoch: epoch, sessionId: session, idempotencyKey: key)
}
func envelope(text: String = "Frozen synthetic request: café 🌙\nKeep exactly.",
              key: String = "synthetic-stable-key", retry: String? = nil,
              phase: PendingRequestPhase = .prepared) -> PendingRequestEnvelope {
    .init(identity: identity(key: key), displayTitle: "Pinned synthetic conversation",
          frozenText: text, retryOf: retry, phase: phase)
}
final class Fixture {
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
    var record: URL { URL(fileURLWithPath: directory).appendingPathComponent("pending-request.json") }
}
@main struct Runner {
    static func main() async {
        do {
            let fixture = try Fixture()
            let original = envelope()
            let store = PendingRequestStore(directory: fixture.directory)
            _ = try await store.prepare(original)
            let reopened = try await PendingRequestStore(directory: fixture.directory)
                .load(assistantId: owner, authorityEpoch: epoch)
            try expect(reopened == .current(original), "exact-envelope reopen: prepared request disappeared after store recreation")
            print("PASS exact-envelope reopen")
        } catch {
            print("FAIL \(error)")
            exit(1)
        }
    }
}
