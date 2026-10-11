import AppKit
import Foundation

// Initial red checkpoint exercises the real native-to-host wire without requiring
// a not-yet-implemented Swift type to compile. Rendered form assertions follow
// once the independently reviewed editor interface is available.
@MainActor enum OwnerProfileEditorTests {
    private static func require(_ value: Bool, _ label: String) throws {
        guard value else { throw NSError(domain: "SyntheticPersonaEditor", code: 1,
            userInfo: [NSLocalizedDescriptionKey: label]) }
        print("PASS: persona editor \(label)")
    }
    static func run(node: String) async throws {
        guard let root = ProcessInfo.processInfo.environment["LUX_COMPANION_SOURCE_ROOT"] else {
            throw NSError(domain: "SyntheticPersonaEditorSetup", code: 1)
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-persona-synthetic-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = Pipe(), output = Pipe(), errors = Pipe(), host = Process()
        host.executableURL = URL(fileURLWithPath: node)
        host.arguments = [root + "/server/dist/host/index.js", "--supervised", "--data-dir", directory.appendingPathComponent("state").path,
                          "--web-root", root + "/web/dist", "--port", "0"]
        host.standardInput = input; host.standardOutput = output; host.standardError = errors
        try host.run()
        defer {
            try? input.fileHandleForWriting.close()
            if host.isRunning { host.terminate() }
            host.waitUntilExit()
        }
        let start = try JSONSerialization.data(withJSONObject: ["type": "start", "schemaVersion": 1, "nonce": UUID().uuidString])
        try input.fileHandleForWriting.write(contentsOf: start + Data([10]))
        var ready: [String: Any]?
        for try await line in output.fileHandleForReading.bytes.lines {
            ready = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            break
        }
        guard let origin = ready?["origin"] as? String else { throw NSError(domain: "SyntheticPersonaEditorSetup", code: 2) }
        let token = try String(contentsOf: directory.appendingPathComponent("state/admin-credential"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let descriptor = try ServiceDescriptor(origin: origin, credentialService: "synthetic", credentialAccount: "persona-fixture")
        guard let url = URL(string: origin + "/api/v1/owner-profile"), descriptor.allows(url) else {
            throw NSError(domain: "SyntheticPersonaEditorSetup", code: 3)
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try require((response as? HTTPURLResponse)?.statusCode == 200, "native bearer reads actual owner editor state")
        try require((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Cache-Control") == "no-store", "private response is no-store")
        let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let document = envelope?["data"] as? [String: Any]
        let active = document?["active"] as? [String: Any], profile = active?["profile"] as? [String: Any]
        try require(profile?["displayName"] as? String == "Lux Didi", "truthful active default remains Lux Didi")
        try require(document?["pendingActivation"] as? Bool == false, "initial state is not falsely pending")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        let (_, denied) = try await session.data(for: request)
        try require([401, 403].contains((denied as? HTTPURLResponse)?.statusCode ?? 0), "native profile rejects Origin even with bearer")
    }
}
