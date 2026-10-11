import Foundation
import Darwin

/// Synthetic proof for the protected operator settings validator and the explicit
/// configure entry. Runs under an isolated HOME; it never touches a real user's
/// settings store and never claims real provider/Google/voice parity.
@MainActor enum OperatorSettingsProof {
    static func run() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("didi-operator-settings-" + UUID().uuidString)
        try fm.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: base) }

        func refuses(_ label: String, _ body: () throws -> Void) throws {
            do { try body(); try LifecycleProof.expect(false, label) }
            catch let error as NativeServiceError {
                guard case .invalidOperatorSettings = error else { throw error }
                try LifecycleProof.expect(error.localizedDescription == NativeServiceError.invalidOperatorSettings.localizedDescription, label)
            }
        }

        let configDir = base.appendingPathComponent("provider-config")
        try fm.createDirectory(at: configDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let profile = base.appendingPathComponent("owner-profile.json")
        try Data("{}\n".utf8).write(to: profile)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: profile.path)

        // Correct types and modes are accepted.
        _ = try OperatorSettings.validatedTarget(configDir.path, directory: true)
        _ = try OperatorSettings.validatedTarget(profile.path, directory: false)
        print("PASS: valid operator targets accepted")

        // Wrong types fail closed.
        try refuses("file rejected as configDir") { _ = try OperatorSettings.validatedTarget(profile.path, directory: true) }
        try refuses("directory rejected as profile") { _ = try OperatorSettings.validatedTarget(configDir.path, directory: false) }

        // Relative, escaping and nonexistent targets fail closed.
        try refuses("relative target refused") { _ = try OperatorSettings.validatedTarget("relative/path", directory: true) }
        try refuses("nonexistent target refused") { _ = try OperatorSettings.validatedTarget(base.appendingPathComponent("absent").path, directory: true) }

        // A symlinked target is refused even when it resolves to a valid directory.
        let link = base.appendingPathComponent("linked-config")
        try fm.createSymbolicLink(at: link, withDestinationURL: configDir)
        try refuses("symlink target refused") { _ = try OperatorSettings.validatedTarget(link.path, directory: true) }

        // Group/world writable targets fail closed, then restore.
        try fm.setAttributes([.posixPermissions: 0o777], ofItemAtPath: configDir.path)
        try refuses("group/world writable target refused") { _ = try OperatorSettings.validatedTarget(configDir.path, directory: true) }
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: configDir.path)

        // Any target inside any .app bundle is refused, not only the running one.
        let foreignApp = base.appendingPathComponent("Synthetic.app/Contents/Resources")
        try fm.createDirectory(at: foreignApp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try refuses("target inside a foreign .app refused") { _ = try OperatorSettings.validatedTarget(foreignApp.path, directory: true) }
        let runningApp = Bundle.main.bundleURL.appendingPathComponent("Contents/operator-probe")
        try refuses("target inside the running .app refused") { _ = try OperatorSettings.validatedTarget(runningApp.path, directory: true) }

        // Configure argv grammar.
        try LifecycleProof.expect(try ConfigureRequest.parse(arguments: ["--self-check"]) == nil, "ordinary flags do not activate configure mode")
        try refuses("bare configure refused") { _ = try ConfigureRequest.parse(arguments: ["--configure"]) }
        try refuses("relative configure value refused") { _ = try ConfigureRequest.parse(arguments: ["--configure", "--config-dir", "relative"]) }
        try refuses("unknown configure flag refused") { _ = try ConfigureRequest.parse(arguments: ["--configure", "--bogus", base.path]) }
        try refuses("duplicate configure refused") { _ = try ConfigureRequest.parse(arguments: ["--configure", "--configure", "--config-dir", configDir.path]) }
        try LifecycleProof.expect(try ConfigureRequest.parse(arguments: ["--configure", "--config-dir", configDir.path]) != nil, "valid configure argv parsed")

        // Store round-trip under an isolated HOME only.
        let isolated = base.appendingPathComponent("home")
        try fm.createDirectory(at: isolated, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let savedHome = getenv("HOME").map { String(cString: $0) }
        let savedFixed = getenv("CFFIXED_USER_HOME").map { String(cString: $0) }
        setenv("HOME", isolated.path, 1); setenv("CFFIXED_USER_HOME", isolated.path, 1)
        defer {
            if let savedHome { setenv("HOME", savedHome, 1) } else { unsetenv("HOME") }
            if let savedFixed { setenv("CFFIXED_USER_HOME", savedFixed, 1) } else { unsetenv("CFFIXED_USER_HOME") }
        }
        let store = try OperatorSettings.directory()
        try LifecycleProof.expect(store.path.hasPrefix(isolated.path), "settings store follows the isolated home")
        try LifecycleProof.expect(try OperatorSettings.load() == nil, "absent operator settings preserve the public default")
        try OperatorSettings.update(configDir: configDir, ownerProfilePath: profile)
        let loaded = try OperatorSettings.load()
        let canonicalConfig = configDir.resolvingSymlinksInPath().standardizedFileURL.path
        let canonicalProfile = profile.resolvingSymlinksInPath().standardizedFileURL.path
        try LifecycleProof.expect(loaded?.configDir?.path == canonicalConfig && loaded?.ownerProfilePath?.path == canonicalProfile, "written operator settings reload identically")
        // Update, not replacement: a configDir-only update keeps the owner profile.
        let second = base.appendingPathComponent("provider-config-2")
        try fm.createDirectory(at: second, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let merged = try OperatorSettings.update(configDir: second, ownerProfilePath: nil)
        try LifecycleProof.expect(merged.ownerProfilePath?.path == canonicalProfile, "configDir-only update preserves the configured owner profile")
        try OperatorSettings.update(configDir: configDir, ownerProfilePath: profile)
        var storeInfo = stat()
        try LifecycleProof.expect(lstat(store.path, &storeInfo) == 0 && storeInfo.st_mode & 0o777 == 0o700, "settings directory is 0700")
        let storeFile = store.appendingPathComponent(OperatorSettings.fileName)
        try LifecycleProof.expect(lstat(storeFile.path, &storeInfo) == 0 && storeInfo.st_mode & 0o777 == 0o600, "settings file is 0600")
        print("PASS: isolated operator settings round-trip")

        // A closed store with an extra key, or the wrong mode, fails closed with the
        // actual thrown safe error, whose message carries neither a path nor a value.
        try Data("{\"schemaVersion\":1,\"configDir\":\"\(configDir.path)\",\"extra\":true}\n".utf8).write(to: storeFile)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storeFile.path)
        try refuses("extra key refused") { _ = try OperatorSettings.load() }
        do { _ = try OperatorSettings.load(); try LifecycleProof.expect(false, "extra key must fail") }
        catch let error as NativeServiceError {
            guard case .invalidOperatorSettings = error else { throw error }
            let message = error.localizedDescription
            try LifecycleProof.expect(message == NativeServiceError.invalidOperatorSettings.localizedDescription
                                      && !message.contains(configDir.path) && !message.contains(isolated.path),
                                      "safe operator error exposes no private path")
        }
        try Data("{\"schemaVersion\":9}\n".utf8).write(to: storeFile)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storeFile.path)
        try refuses("wrong schemaVersion refused") { _ = try OperatorSettings.load() }
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: storeFile.path)
        try refuses("group/world readable settings file refused") { _ = try OperatorSettings.load() }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storeFile.path)
        let safe = NativeServiceError.invalidOperatorSettings.localizedDescription
        try LifecycleProof.expect(!safe.contains(isolated.path) && !safe.contains(configDir.path), "safe operator error exposes no private path")
        print("PASS: closed-key/mode settings fail closed with a safe error")
    }
}
