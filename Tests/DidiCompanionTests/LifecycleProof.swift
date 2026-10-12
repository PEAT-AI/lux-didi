import Foundation
import Security
import LocalAuthentication
import Darwin

@MainActor enum LifecycleProof {
    static func expect(_ value: Bool, _ label: String) throws {
        guard value else { throw NSError(domain: "LifecycleProof: " + label, code: 1) }
        print("PASS: \(label)")
    }
    // R60 synthetic companion-only diagnostic. One JSONL record per validation stage, written into the
    // retained proof directory (argv[2]) so a failing fixture records which stage rejected the node and
    // the record survives fixture cleanup. Synthetic case labels, relative node path, nodeMajor, node
    // kind/mode booleans and stage status only: no environment, no stdout content, no credentials and no
    // path outside the owned fixture. Diagnostic only: it changes no error, timing, guard or child argv.
    static let diagnosticURL: URL? = CommandLine.arguments.count > 2
        ? URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("companion-diagnostic.jsonl") : nil
    static func diagnose(_ stage: String, _ extra: [String: Any] = [:]) {
        guard let url = diagnosticURL,
              let data = try? JSONSerialization.data(withJSONObject: extra.merging(["stage": stage]) { _, new in new },
                                                     options: [.sortedKeys]) else { return }
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        handle.seekToEndOfFile(); handle.write(data); handle.write(Data("\n".utf8)); try? handle.close()
    }
    static func run(node: String) async throws {
        let started = Date()
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("didi-lifecycle-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let service = "ai.peat.lux-didi.proof." + UUID().uuidString
#if COMPANION_TEST
        NativeServiceSupervisor.diagnosticSink = { record in diagnose("supervisor:probe", record) }
#endif
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
            let bundle = root.appendingPathComponent(id)
            let resources = bundle.appendingPathComponent("Contents/Resources")
            let macos = bundle.appendingPathComponent("Contents/MacOS")
            let server = resources.appendingPathComponent("server/dist/host")
            try fm.createDirectory(at: server, withIntermediateDirectories: true)
            try fm.createDirectory(at: resources.appendingPathComponent("web/dist"), withIntermediateDirectories: true)
            try fm.createDirectory(at: macos, withIntermediateDirectories: true)
            // Production nodePath is Contents/MacOS/node: a regular owner-executable in
            // the real bundle-relative layout, never the old absolute form.
            let realNode = URL(fileURLWithPath: node).resolvingSymlinksInPath()
            let bundledNode = macos.appendingPathComponent("node")
            do { try fm.linkItem(atPath: realNode.path, toPath: bundledNode.path) }
            catch { try fm.copyItem(atPath: realNode.path, toPath: bundledNode.path) }
            var staged = stat()
            let stagedStatOK = lstat(bundledNode.path, &staged) == 0
            diagnose("fixture:node-staged", ["case": mode, "relativeNodePath": "Contents/MacOS/node", "nodeMajor": 26,
                "statOK": stagedStatOK, "isSymlink": stagedStatOK && (staged.st_mode & S_IFMT) == S_IFLNK,
                "isRegular": stagedStatOK && (staged.st_mode & S_IFMT) == S_IFREG,
                "ownerExecutable": stagedStatOK && (staged.st_mode & 0o100) != 0,
                "groupOrWorldWritable": stagedStatOK && (staged.st_mode & 0o022) != 0])
            // The verification launch runs with cwd /, so resolve the fixture from
            // the source root the producer publishes rather than the process cwd.
            // A missing root is a clear verification failure, not a silent fallback.
            guard let sourceRoot = ProcessInfo.processInfo.environment["LUX_COMPANION_SOURCE_ROOT"], !sourceRoot.isEmpty else {
                throw NSError(domain: "LifecycleProof: producer must publish LUX_COMPANION_SOURCE_ROOT", code: 1)
            }
            let fixtureJS = URL(fileURLWithPath: sourceRoot).appendingPathComponent("Tests/DidiCompanionTests/supervised-fixture.js")
            try Data(contentsOf: fixtureJS).write(to: server.appendingPathComponent("index.js"))
            try Data(mode.utf8).write(to: server.appendingPathComponent("mode"))
            var manifest: [String: Any] = ["schemaVersion": 1, "installId": id, "releaseCommit": String(repeating: "a", count: 40), "nodePath": "Contents/MacOS/node", "nodeMajor": 26, "serverEntry": "server/dist/host/index.js", "webRoot": "web/dist"]
            manifest.merge(changes) { _, new in new }
            try JSONSerialization.data(withJSONObject: manifest).write(to: resources.appendingPathComponent("didi-runtime.json"))
            let state = state ?? root.appendingPathComponent("state-" + id)
            do {
                let loaded = try InstalledRuntime.load(resources: resources)
                diagnose("fixture:runtime-load", ["case": mode, "loaded": loaded != nil])
                return (loaded!, state)
            } catch {
                diagnose("fixture:runtime-load", ["case": mode, "loaded": false])
                throw error
            }
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
            for changes in [["serverEntry": "../escape.js"], ["webRoot": "../outside"], ["nodePath": "node"], ["nodePath": "/usr/bin/node"], ["nodePath": "../node"], ["nodeMajor": 25], ["releaseCommit": "invalid"], ["schemaVersion": 9]] as [[String: Any]] {
                do { _ = try setup("normal", changes: changes); try expect(false, "invalid runtime manifest must fail") }
                catch { try expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "invalid installed manifest refuses fallback") }
            }
            let escape = try setup("normal")
            try fm.removeItem(at: escape.0.webRoot)
            try fm.createSymbolicLink(at: escape.0.webRoot, withDestinationURL: root)
            do { _ = try InstalledRuntime.load(resources: escape.0.resources); try expect(false, "escaping resource symlink must fail") }
            catch { try expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "escaping resource symlink refused") }
            let linked = try setup("normal")
            try fm.removeItem(at: linked.0.node)
            try fm.createSymbolicLink(at: linked.0.node, withDestinationURL: URL(fileURLWithPath: node).resolvingSymlinksInPath())
            do { _ = try InstalledRuntime.load(resources: linked.0.resources); try expect(false, "symlinked node must fail") }
            catch { try expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "symlinked node refused") }
            try OperatorSettingsProof.run()

            let marker = root.appendingPathComponent("injection-executed")
            let injection = root.appendingPathComponent("injection.cjs")
            try Data("require('node:fs').writeFileSync(\(String(data: try JSONSerialization.data(withJSONObject: marker.path, options: [.fragmentsAllowed]), encoding: .utf8)!), 'bad')".utf8).write(to: injection)
            let oldOptions = ProcessInfo.processInfo.environment["NODE_OPTIONS"]
            setenv("NODE_OPTIONS", ("--require=" + injection.path), 1)
            defer { if let oldOptions { setenv("NODE_OPTIONS", oldOptions, 1) } else { unsetenv("NODE_OPTIONS") } }
            let valid = try setup("normal")
            let owned = supervisor(valid)
            let first = try await owned.start()
            let diagnostics = valid.1.appendingPathComponent("logs/supervisor.log")
            let diagnosticText = try String(contentsOf: diagnostics, encoding: .utf8)
            try expect(diagnosticText.contains("spawn") && diagnosticText.contains("config_dir"), "supervisor lifecycle persists")
            let permissions = try fm.attributesOfItem(atPath: diagnostics.path)[.posixPermissions] as? NSNumber
            try expect(permissions?.intValue == 0o600, "supervisor diagnostics are private")
            try expect(!diagnosticText.contains("credentialService"), "ready frame is not persisted")

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
            // Fake statuses prove failure handling only, never real SDK efficacy.
            var getCalls = 0
            let setterFailure = NativeKeychainPolicy.evaluate(set: { errSecNotAvailable }, get: { _ in
                getCalls += 1; return errSecSuccess
            })
            try expect(setterFailure == errSecNotAvailable && getCalls == 0, "failed policy setter never proceeds to readback")
            let getterFailure = NativeKeychainPolicy.evaluate(set: { errSecSuccess }, get: { _ in errSecNotAvailable })
            let enabledReadback = NativeKeychainPolicy.evaluate(set: { errSecSuccess }, get: { value in
                value.pointee = DarwinBoolean(true); return errSecSuccess
            })
            for failure in [setterFailure, getterFailure, enabledReadback] {
                let blocked = try setup("normal")
                var addCalls = 0
                do {
                    _ = try NativeCredentialImport.importCredential(state: blocked.1, installId: blocked.0.installId,
                        add: { _, _ in addCalls += 1; return errSecSuccess }, policyCheck: { failure })
                    try expect(false, "failed establishment/readback must refuse import")
                } catch NativeServiceError.keychain(let status) {
                    try expect(status == failure && addCalls == 0 && !itemExists(blocked.0.installId),
                               "policy failure refuses before token/SDK add dispatch and stores no item")
                }
            }
            print("PASS: test-only policy failure injection, not SDK proof")
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
