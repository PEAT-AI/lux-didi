import Foundation
import Security
import LocalAuthentication
import Darwin

@MainActor enum LifecycleProof {
    static func expect(_ value: Bool, _ label: String) throws {
        guard value else { throw NSError(domain: "LifecycleProof: " + label, code: 1) }
        print("PASS: \(label)")
    }
    static func run(node: String) async throws {
        let started = Date()
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("didi-lifecycle-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let service = "ai.peat.lux-didi.proof." + UUID().uuidString
        var accounts: [String] = []
        var children: [NativeServiceSupervisor] = []
        defer {
            for account in accounts {
                let context = LAContext(); context.interactionNotAllowed = true
                SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecUseAuthenticationContext as String: context] as CFDictionary)
            }
            try? fm.removeItem(at: root)
        }
        func setup(_ mode: String, state: URL? = nil, changes: [String: Any] = [:]) throws -> (InstalledRuntime, URL) {
            let id = UUID().uuidString.lowercased()
            accounts.append(id)
            let resources = root.appendingPathComponent(id)
            let server = resources.appendingPathComponent("server/dist/host")
            try fm.createDirectory(at: server, withIntermediateDirectories: true)
            try fm.createDirectory(at: resources.appendingPathComponent("web/dist"), withIntermediateDirectories: true)
            try Data(contentsOf: URL(fileURLWithPath: "Tests/DidiCompanionTests/supervised-fixture.js")).write(to: server.appendingPathComponent("index.js"))
            try Data(mode.utf8).write(to: server.appendingPathComponent("mode"))
            var manifest: [String: Any] = ["schemaVersion": 1, "installId": id, "releaseCommit": String(repeating: "a", count: 40), "nodePath": node, "nodeMajor": 26, "serverEntry": "server/dist/host/index.js", "webRoot": "web/dist"]
            manifest.merge(changes) { _, new in new }
            try JSONSerialization.data(withJSONObject: manifest).write(to: resources.appendingPathComponent("didi-runtime.json"))
            let state = state ?? root.appendingPathComponent("state-" + id)
            return (try InstalledRuntime.load(resources: resources)!, state)
        }
        func supervisor(_ setup: (InstalledRuntime, URL)) -> NativeServiceSupervisor {
            let result = NativeServiceSupervisor(runtime: setup.0, proofState: setup.1, proofCredentialService: service)
            children.append(result)
            return result
        }
        func itemExists(_ account: String) -> Bool {
            let context = LAContext(); context.interactionNotAllowed = true
            let q = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecUseAuthenticationContext as String: context] as CFDictionary
            return SecItemCopyMatching(q, nil) == errSecSuccess
        }
        do {
            try expect(try InstalledRuntime.load(resources: root) == nil, "absent installed resource preserves explicit attach mode")
            for changes in [["serverEntry": "../escape.js"], ["webRoot": "../outside"], ["nodePath": "node"], ["nodeMajor": 25], ["releaseCommit": "invalid"], ["schemaVersion": 9]] as [[String: Any]] {
                do { _ = try setup("normal", changes: changes); try expect(false, "invalid runtime manifest must fail") }
                catch { try expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "invalid installed manifest refuses fallback") }
            }
            let escape = try setup("normal")
            try fm.removeItem(at: escape.0.webRoot)
            try fm.createSymbolicLink(at: escape.0.webRoot, withDestinationURL: root)
            do { _ = try InstalledRuntime.load(resources: escape.0.resources); try expect(false, "escaping resource symlink must fail") }
            catch { try expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "escaping resource symlink refused") }

            let marker = root.appendingPathComponent("injection-executed")
            let injection = root.appendingPathComponent("injection.cjs")
            try Data("require('node:fs').writeFileSync(\(String(data: try JSONSerialization.data(withJSONObject: marker.path, options: [.fragmentsAllowed]), encoding: .utf8)!), 'bad')".utf8).write(to: injection)
            let oldOptions = ProcessInfo.processInfo.environment["NODE_OPTIONS"]
            setenv("NODE_OPTIONS", ("--require=" + injection.path), 1)
            defer { if let oldOptions { setenv("NODE_OPTIONS", oldOptions, 1) } else { unsetenv("NODE_OPTIONS") } }
            let valid = try setup("normal")
            let owned = supervisor(valid)
            let first = try await owned.start()
            try expect(owned.isRunning && first.pid > 0, "actual owned live Node child and listener accepted")
            try expect(!fm.fileExists(atPath: marker.path), "ambient NODE_OPTIONS injection never executes")
            try expect(first.descriptor.credentialService == service && first.descriptor.credentialAccount == valid.0.installId, "credential reference derived from install identity")
            let canonical = try Data(contentsOf: valid.1.appendingPathComponent("admin-credential"))
            try expect(canonical.count == 44 && canonical.last == 10, "fixture matches canonical Store credential file framing")
            let token = Data(canonical.dropLast())
            try expect(Data(try first.descriptor.credential().utf8) == token, "actual noninteractive Keychain import matches canonical private token")
            // Store writes an owner-only base64url token followed by one LF.
            // Exercise canonical framing and retain the existing no-LF coverage too.
            let framed = try setup("normal")
            try NativeCredentialImport.prepareState(framed.1)
            let framedFile = framed.1.appendingPathComponent("admin-credential")
            try canonical.write(to: framedFile)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: framedFile.path)
            let reference = try NativeCredentialImport.importCredential(state: framed.1, installId: framed.0.installId, service: service)
            let descriptor = try ServiceDescriptor(origin: first.descriptor.origin, credentialService: reference.service, credentialAccount: reference.account)
            try expect(Data(try descriptor.credential().utf8) == token, "canonical Store credential LF framing never enters bearer or Keychain")
            _ = try NativeCredentialImport.importCredential(state: framed.1, installId: framed.0.installId, service: service)
            try token.write(to: framedFile)
            _ = try NativeCredentialImport.importCredential(state: framed.1, installId: framed.0.installId, service: service)
            try expect(Data(try descriptor.credential().utf8) == token, "unframed token imports identically without rotation")
            let suffixes: [Data] = [Data([10, 10]), Data([32]), Data([13, 10]), Data([65])]
            var malformed = suffixes.map { token + $0 }
            malformed.append(Data([10]))
            malformed.append(Data([10]) + token)
            malformed.append(Data(token.dropLast()))
            malformed.append(Data(repeating: 33, count: 43))
            for fileBytes in malformed {
                try fileBytes.write(to: framedFile)
                do {
                    _ = try NativeCredentialImport.importCredential(state: framed.1, installId: framed.0.installId, service: service)
                    try expect(false, "noncanonical credential framing or token must fail")
                } catch NativeServiceError.unsafeCredential {
                    print("PASS: noncanonical credential framing or token refused")
                }
            }
            let refused = try setup("normal")
            try NativeCredentialImport.prepareState(refused.1)
            let refusedFile = refused.1.appendingPathComponent("admin-credential")
            try canonical.write(to: refusedFile)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: refusedFile.path)
            var previousInteraction = DarwinBoolean(false)
            try expect(SecKeychainGetUserInteractionAllowed(&previousInteraction) == errSecSuccess && !previousInteraction.boolValue, "actual lifetime Keychain policy disables optional interaction")
            var creationWasNoninteractive = false
            do {
                _ = try NativeCredentialImport.importCredential(state: refused.1, installId: refused.0.installId, service: service, add: { _, _ in
                    var allowed = DarwinBoolean(true)
                    creationWasNoninteractive = SecKeychainGetUserInteractionAllowed(&allowed) == errSecSuccess && !allowed.boolValue
                    return errSecInteractionNotAllowed
                })
                try expect(false, "Keychain creation refusal must not succeed")
            } catch NativeServiceError.keychain(let status) {
                try expect(status == errSecInteractionNotAllowed, "Keychain creation refusal is explicit before credential dispatch")
            }
            try expect(creationWasNoninteractive, "legacy Keychain item creation cannot open login authorization UI")
            var restoredInteraction = DarwinBoolean(false)
            try expect(SecKeychainGetUserInteractionAllowed(&restoredInteraction) == errSecSuccess && !restoredInteraction.boolValue,
                       "Keychain refusal preserves lifetime policy without re-enabling interaction")
            try expect(!itemExists(refused.0.installId), "refused Keychain creation stores no item")
            let again = try await owned.start()
            try expect(again.pid == first.pid, "double Start retains one child")
            let second = supervisor(try setup("normal", state: valid.1))
            do { _ = try await second.start(); try expect(false, "second writer must fail") }
            catch { try expect(!second.isRunning, "actual second-writer rejection before authority") }
            try expect(owned.isRunning, "other child failure never terminates first owner")

            for mode in ["stale", "peer", "pid", "epoch", "malformed", "oversize", "extra", "exit", "silent"] {
                let bad = try setup(mode)
                let child = supervisor(bad)
                do { _ = try await child.start(); try expect(false, "invalid ready must fail: " + mode) }
                catch { try expect(!child.isRunning && !itemExists(bad.0.installId), "bad readiness gets no Keychain credential: " + mode) }
            }
            let invalidNode = supervisor(try setup("normal", changes: ["nodePath": "/usr/bin/false"]))
            do { _ = try await invalidNode.start(); try expect(false, "non-Node executable must fail") }
            catch { try expect(!invalidNode.isRunning, "actual Node/SQLite probe refuses wrong executable") }

            for kind in ["mode", "symlink", "directory"] {
                let bad = try setup("normal")
                try fm.createDirectory(at: bad.1, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let file = bad.1.appendingPathComponent("admin-credential")
                try Data("Synthetic-not-a-live-credential".utf8).write(to: file)
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                if kind == "mode" { try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path) }
                if kind == "directory" { try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bad.1.path) }
                if kind == "symlink" { try fm.removeItem(at: file); try fm.createSymbolicLink(at: file, withDestinationURL: injection) }
                let child = supervisor(bad)
                do { _ = try await child.start(); try expect(false, "unsafe credential boundary must fail") }
                catch { try expect(!child.isRunning && !itemExists(bad.0.installId), "unsafe credential " + kind + " blocked before import") }
            }
            owned.closeLivenessForProof()
            let eofDeadline = Date().addingTimeInterval(2)
            while owned.isRunning && Date() < eofDeadline { try await Task.sleep(nanoseconds: 20_000_000) }
            try expect(!owned.isRunning, "private supervision EOF exits actual child")
            var credentialReads = 0
            let staleClient = CompanionClient(descriptor: first.descriptor, credential: { credentialReads += 1; return try first.descriptor.credential() }, expectedEpoch: first.authorityEpoch, connectionGuard: { owned.isCurrent(first) })
            do { _ = try await staleClient.bootstrap(); try expect(false, "dead peer must not receive authentication") }
            catch { try expect(credentialReads == 0, "dead owned connection refuses before credential lookup/dispatch") }
            let restarted = try await owned.start()
            try expect(restarted.pid != first.pid && restarted.descriptor.origin != first.descriptor.origin, "explicit restart uses fresh child readiness not stale port")
            try expect(Data(try restarted.descriptor.credential().utf8) == token, "restart retains canonical credential without silent rotation")
            try expect(Data(contentsOf: valid.1.appendingPathComponent("admin-credential")) == canonical, "restart preserves canonical credential file bytes")
            await owned.stop()
            try expect(!owned.isRunning, "bounded clean stop releases own child")
            var changed = token; changed[0] = token[0] == 65 ? 66 : 65
            try (changed + Data([10])).write(to: valid.1.appendingPathComponent("admin-credential"))
            do { _ = try await owned.start(); try expect(false, "credential mismatch must not rotate Keychain") }
            catch NativeServiceError.credentialMismatch { try expect(!owned.isRunning && Data(try first.descriptor.credential().utf8) == token, "canonical mismatch leaves existing Keychain value untouched") }
            try canonical.write(to: valid.1.appendingPathComponent("admin-credential"))
            let stubborn = supervisor(try setup("stubborn"))
            _ = try await stubborn.start()
            let stoppedAt = Date()
            await stubborn.stop()
            try expect(!stubborn.isRunning && Date().timeIntervalSince(stoppedAt) < 3, "bounded termination escalation targets stubborn owned child only")
            try expect(itemExists(valid.0.installId), "unrelated owner credential survives other stops")
        } catch {
            // Only bounded nonsecret markers from this disposable fixture root.
            for state in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where state.lastPathComponent.hasPrefix("state-") {
                let marker = state.appendingPathComponent("fixture-ready.json")
                if let data = try? Data(contentsOf: marker), data.count <= 1024, let text = String(data: data, encoding: .utf8) {
                    print("LIFECYCLE-DIAGNOSTIC ready-write=\(text)")
                }
            }
            for child in children { await child.stop() }
            throw error
        }
        for child in children { await child.stop() }
        print("NATIVE-LIFECYCLE PASS duration=\(Date().timeIntervalSince(started))s ownedProcesses=cleaned canonicalCredential=retained Keychain=synthetic-only install=not-performed")
    }
}
