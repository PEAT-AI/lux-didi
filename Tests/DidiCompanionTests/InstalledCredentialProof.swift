import Foundation
import Darwin

private final class CredentialProofTransport: URLProtocol {
    private static let lock = NSLock()
    private static var epoch = ""
    private static var token = ""
    private static var dispatches = 0
    static func configure(epoch: String, token: String) {
        lock.lock(); defer { lock.unlock() }
        self.epoch = epoch; self.token = token; dispatches = 0
    }
    static var count: Int { lock.lock(); defer { lock.unlock() }; return dispatches }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.dispatches += 1
        let epoch = Self.epoch, token = Self.token
        Self.lock.unlock()
        let path = request.url!.path
        var data: [String: Any] = [:], headers = ["Content-Type": "application/json"]
        if path == "/api/v1/status" { data = ["authorityEpoch": epoch] }
        else if path == "/api/v1/auth/pairing" { data = ["pairingCode": "synthetic-pairing"] }
        else if path == "/api/v1/auth/pair" { headers["Set-Cookie"] = "didi_session=synthetic-cookie; Path=/; HttpOnly; SameSite=Strict" }
        else if path == "/api/v1/auth/session" { data = ["csrfToken": "synthetic-csrf"] }
        if path == "/api/v1/status" || path == "/api/v1/auth/pairing" {
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer " + token else {
                client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired)); return
            }
        }
        let bytes = try! JSONSerialization.data(withJSONObject: ["data": data])
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor enum InstalledCredentialProof {
    static func run(node: String, source: String, output: String) async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("didi-installed-credential-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var labels: [String] = []
        func check(_ condition: Bool, _ label: String) throws {
            guard condition else { throw NSError(domain: "InstalledCredentialProof", code: 1) }
            labels.append(label); print("PASS installed credential: " + label)
        }
        let state = root.appendingPathComponent("state")
        try NativeCredentialImport.prepareState(state)
        let file = state.appendingPathComponent("admin-credential")
        let token = Data(repeating: 65, count: 43)
        func write(_ bytes: Data) throws {
            try bytes.write(to: file)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        func refuses(_ label: String, _ operation: () throws -> Void) throws {
            do { try operation() }
            catch is NativeServiceError { try check(true, label); return }
            throw NSError(domain: "InstalledCredentialProof unexpected acceptance", code: 1)
        }
        do {
            try refuses("missing file") { _ = try NativeCredentialImport.readCredential(state: state) }
            for bytes in [token, token + Data([10])] {
                try write(bytes)
                try check(try NativeCredentialImport.readCredential(state: state) == token, "canonical framing")
            }
            for bytes in [Data(), Data([10]), token.dropLast(), Data(repeating: 65, count: 4097), token + Data([10, 10]), token + Data([13, 10]), Data([10]) + token, Data(repeating: 33, count: 43)] {
                try write(Data(bytes))
                try refuses("malformed or bounded token") { _ = try NativeCredentialImport.readCredential(state: state) }
            }
            try write(token)
            try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
            try refuses("file mode") { _ = try NativeCredentialImport.readCredential(state: state) }
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: state.path)
            try refuses("directory mode") { _ = try NativeCredentialImport.readCredential(state: state) }
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
            try fm.removeItem(at: file)
            try fm.createSymbolicLink(at: file, withDestinationURL: root.appendingPathComponent("absent"))
            try refuses("file symlink") { _ = try NativeCredentialImport.readCredential(state: state) }
            try fm.removeItem(at: file)
            try fm.createDirectory(at: file, withIntermediateDirectories: false)
            try refuses("file type") { _ = try NativeCredentialImport.readCredential(state: state) }
            try fm.removeItem(at: file)
            let alias = root.appendingPathComponent("state-alias")
            try fm.createSymbolicLink(at: alias, withDestinationURL: state)
            try refuses("directory symlink") { _ = try NativeCredentialImport.readCredential(state: alias) }
            try write(token)
            try refuses("wrong UID predicate seam, directory") {
                _ = try NativeCredentialImport.readCredential(state: state, inspect: { fd, info in
                    let status = fstat(fd, info); info.pointee.st_uid = geteuid() &+ 1; return status
                })
            }
            try refuses("wrong UID predicate seam, file") {
                _ = try NativeCredentialImport.readCredential(state: state, inspect: { fd, info in
                    let status = fstat(fd, info)
                    if info.pointee.st_mode & S_IFMT == S_IFREG { info.pointee.st_uid = geteuid() &+ 1 }
                    return status
                })
            }
            try refuses("short read seam") {
                _ = try NativeCredentialImport.readCredential(state: state, readBytes: { fd, bytes, count in Darwin.read(fd, bytes, count - 1) })
            }
            let resources = root.appendingPathComponent("bundle/Contents/Resources")
            let nodeTarget = root.appendingPathComponent("bundle/Contents/MacOS/node")
            try fm.createDirectory(at: nodeTarget.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.linkItem(atPath: node, toPath: nodeTarget.path)
            let entry = resources.appendingPathComponent("server/index.js")
            try fm.createDirectory(at: entry.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.createDirectory(at: resources.appendingPathComponent("web"), withIntermediateDirectories: true)
            try Data(contentsOf: URL(fileURLWithPath: source).appendingPathComponent("Tests/DidiCompanionTests/supervised-fixture.js")).write(to: entry)
            try Data("normal".utf8).write(to: entry.deletingLastPathComponent().appendingPathComponent("mode"))
            let manifest: [String: Any] = ["schemaVersion": 1, "installId": UUID().uuidString.lowercased(), "releaseCommit": String(repeating: "a", count: 40), "nodePath": "Contents/MacOS/node", "nodeMajor": 26, "serverEntry": "server/index.js", "webRoot": "web"]
            let manifestFile = resources.appendingPathComponent("didi-runtime.json")
            try JSONSerialization.data(withJSONObject: manifest).write(to: manifestFile)
            try check(try InstalledRuntime.load(resources: root) == nil, "absent manifest only permits external selection")
            var invalid = manifest; invalid["serverEntry"] = "../escape"
            try JSONSerialization.data(withJSONObject: invalid).write(to: manifestFile)
            try refuses("present invalid manifest blocks downgrade") { _ = try InstalledRuntime.load(resources: resources) }
            try JSONSerialization.data(withJSONObject: manifest).write(to: manifestFile)
            let runtime = try InstalledRuntime.load(resources: resources)!
            let owner = NativeServiceSupervisor(runtime: runtime, proofState: state, proofCredentialService: "synthetic-file-only")
            do {
                let connection = try await owner.start()
                try check(try Data(connection.credential().utf8) == token && owner.credentialValidated, "actual owned startup file provider")
                CredentialProofTransport.configure(epoch: connection.authorityEpoch, token: String(decoding: token, as: UTF8.self))
                let allowed = { owner.isCurrent(connection) && (try? connection.credential()) != nil }
                let client = CompanionClient(descriptor: connection.descriptor, credential: connection.credential, expectedEpoch: connection.authorityEpoch, connectionGuard: allowed, protocolClasses: [CredentialProofTransport.self])
                _ = try await client.bootstrap()
                try check(CredentialProofTransport.count == 4, "bootstrap actual source reaches four controlled Foundation dispatches")
                var failures = 0
                owner.onCredentialUnavailable = { _ in failures += 1 }
                try write(Data(repeating: 66, count: 43))
                let before = CredentialProofTransport.count
                await client.revokePageSession()
                try check(CredentialProofTransport.count == before && failures == 1 && owner.state == .unavailable, "page cookie mutation retires authority before dispatch")
                try write(token)
                try refuses("original file restoration cannot revive old provider") { _ = try connection.credential() }
                try check(!allowed(), "stale request guard remains closed")
                let model = AppModel(fixtureClient: client, fixtureOutbox: root.appendingPathComponent("outbox"))
                model.bindCredentialSupervisorForProof(owner)
                await model.refreshLiveDetails()
                model.error = nil
                try check(model.error?.contains("Reconnect") == true, "swallowed refresh and late clear preserve visible retired error")
                let fresh = try await owner.start()
                try check(fresh.pid != connection.pid && owner.isCurrent(fresh), "explicit reconnect creates fresh owned authority")
                try check(try Data(fresh.credential().utf8) == token, "explicit reconnect accepts restored valid canonical token")
                model.error = nil
                try check(model.error == nil, "explicit reconnect clears credential error without process latch")
                try refuses("old provider stays retired after reconnect") { _ = try connection.credential() }
                try write(Data(repeating: 67, count: 43))
                try refuses("held token rotation refuses current provider") { _ = try fresh.credential() }
                let rotated = try await owner.start()
                try check(try rotated.credential() == String(repeating: "C", count: 43), "new owned start accepts current file authority without historical pin")
                try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
                try refuses("held permission change retires authority") { _ = try rotated.credential() }
                try check(owner.state == .unavailable, "invalid canonical state does not auto-reconnect")
                await owner.stop()
                try check(owner.lastStop?["observedExited"] as? Bool == true, "owned child cleanup observed")
            } catch { await owner.stop(); throw error }
            for category in [StartupFailureDiagnostic.Category.unsafeState, .unsafeCredential, .credentialMismatch, .exited] {
                let diagnostic = StartupFailureDiagnostic(stage: .canonicalFile, category: category, operation: .none, status: nil)
                try check(NativeDiagnosticsSnapshot.startupFailure(diagnostic).contains("stage=canonical-file"), "closed canonical diagnostic category")
            }
            let invalidDiagnostic = StartupFailureDiagnostic(stage: .canonicalFile, category: .keychain, operation: .copyMatching, status: -25293)
            try check(NativeDiagnosticsSnapshot.startupFailure(invalidDiagnostic) == "unknown", "canonical file never reports a Keychain operation")
            try InstalledProofTests.run()
            let report: [String: Any] = ["type": "InstalledCredentialRuntimeProof", "success": true, "checks": labels, "wrongUIDEvidence": "predicate-seam-not-owner-fixture", "transportEvidence": "controlled-URLProtocol-dispatch-not-host-API-acceptance", "ownerDataTouched": false]
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: output))
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
            try fm.removeItem(at: root)
        } catch { print("INSTALLED-CREDENTIAL proof retained synthetic state"); throw error }
    }
}
