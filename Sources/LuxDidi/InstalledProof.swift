import Foundation
import Darwin
import Security
import LocalAuthentication

enum InstalledProofError: LocalizedError {
    case invalidArguments, unsafePath, invalidMarker, unavailable, missingUI, persistence, accessibility, captureRequired
    var errorDescription: String? { "Didi’s isolated proof could not complete safely (\(self))." }
}

struct InstalledProofRequest {
    let state: URL
    let report: URL
    static let markerName = "didi-installed-proof.json"
    static func parse(arguments: [String]) throws -> InstalledProofRequest? {
        let flags = ["--installed-proof", "--proof-state", "--proof-report"]
        guard arguments.contains(where: { flags.contains($0) }) else { return nil }
        guard arguments.count == 5, arguments.filter({ $0 == flags[0] }).count == 1,
              arguments.filter({ $0 == flags[1] }).count == 1, arguments.filter({ $0 == flags[2] }).count == 1 else { throw InstalledProofError.invalidArguments }
        func path(_ flag: String) throws -> URL {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { throw InstalledProofError.invalidArguments }
            let value = arguments[index + 1]
            guard value.hasPrefix("/"), !value.contains("\0"), !flags.contains(value) else { throw InstalledProofError.invalidArguments }
            let input = URL(fileURLWithPath: value).standardizedFileURL
            var info = stat()
            if lstat(input.path, &info) == 0, info.st_mode & S_IFMT == S_IFLNK { throw InstalledProofError.unsafePath }
            return input.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(input.lastPathComponent)
        }
        let state = try path(flags[1]); let report = try path(flags[2])
        let normal = try InstalledRuntime.applicationState().resolvingSymlinksInPath().standardizedFileURL.path
        guard state.path != normal, !state.path.hasPrefix(normal + "/"), !normal.hasPrefix(state.path + "/"),
              report.path != normal, !report.path.hasPrefix(normal + "/"), state != report,
              !report.path.hasPrefix(state.path + "/") else { throw InstalledProofError.unsafePath }
        try privateDirectory(state.deletingLastPathComponent())
        try privateDirectory(report.deletingLastPathComponent())
        return InstalledProofRequest(state: state, report: report)
    }
    private static func privateDirectory(_ url: URL) throws {
        let file = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard file >= 0 else { throw InstalledProofError.unsafePath }
        defer { close(file) }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700 else { throw InstalledProofError.unsafePath }
    }
    fileprivate static func privateData(_ url: URL) throws -> Data? {
        let file = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if file < 0 {
            if errno == ENOENT { return nil }
            throw InstalledProofError.unsafePath
        }
        defer { close(file) }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(),
              info.st_mode & 0o777 == 0o600, info.st_size > 0, info.st_size <= 65_536 else { throw InstalledProofError.unsafePath }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        let count = bytes.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
        guard count == bytes.count else { throw InstalledProofError.unsafePath }
        return Data(bytes)
    }
    func prepare(installId: String) throws -> PreparedInstalledProof {
        try NativeCredentialImport.prepareState(state)
        let marker = state.appendingPathComponent(Self.markerName)
        let proofId: String; let reopened: Bool
        if let data = try Self.privateData(marker) {
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(value.keys) == ["type", "schemaVersion", "installId", "proofId"],
                  value["type"] as? String == "didi-installed-proof-state", value["schemaVersion"] as? Int == 1,
                  value["installId"] as? String == installId, let identity = value["proofId"] as? String,
                  UUID(uuidString: identity) != nil else { throw InstalledProofError.invalidMarker }
            proofId = identity; reopened = true
        } else {
            guard try FileManager.default.contentsOfDirectory(atPath: state.path).isEmpty else { throw InstalledProofError.invalidMarker }
            proofId = UUID().uuidString.lowercased(); reopened = false
            let data = try JSONSerialization.data(withJSONObject: ["type": "didi-installed-proof-state", "schemaVersion": 1, "installId": installId, "proofId": proofId], options: [.sortedKeys])
            let file = open(marker.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else { throw InstalledProofError.unsafePath }
            defer { close(file) }
            let count = data.withUnsafeBytes { Darwin.write(file, $0.baseAddress, $0.count) }
            guard count == data.count else { throw InstalledProofError.unsafePath }
        }
        if let data = try Self.privateData(report) {
            guard let prior = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  prior["type"] as? String == "LuxDidiInstalledProof", prior["installId"] as? String == installId,
                  prior["proofId"] as? String == proofId else { throw InstalledProofError.unsafePath }
        }
        return PreparedInstalledProof(state: state, report: report, installId: installId, proofId: proofId, reopened: reopened)
    }
}

struct PreparedInstalledProof {
    let state: URL
    let report: URL
    let installId: String
    let proofId: String
    let reopened: Bool
    var credentialAccount: String { installId + ".proof." + proofId }
    var recordPrefix: String { "Didi installed proof " + proofId + " " }
    var screenshot: URL { report.appendingPathExtension("native-window.png") }
    func write(_ outcomes: [String: Any]) throws {
        var value = outcomes
        value["type"] = "LuxDidiInstalledProof"; value["schemaVersion"] = 1
        value["installId"] = installId; value["proofId"] = proofId; value["reopened"] = reopened
        // R10 has exact consumer key sets. Private diagnostics belong beside it,
        // with the same-run identity, never in the versioned consumer wire.
        var diagnostic: [String: Any] = ["type": "LuxDidiInstalledProofDiagnostics", "schemaVersion": 1,
            "installId": installId, "proofId": proofId, "runId": value["runId"] ?? NSNull(),
            "nativePid": (value["native"] as? [String: Any])?["pid"] ?? NSNull(),
            "windowId": (value["visual"] as? [String: Any])?["windowId"] ?? NSNull(),
            "sourceSHA": (value["source"] as? [String: Any])?["releaseCommit"] ?? NSNull(),
            "phase": value["phase"] ?? NSNull()]
        for key in ["axConsumer", "axDirectTrace", "wkDiagnostics"] {
            if let item = value.removeValue(forKey: key) { diagnostic[key] = item }
        }
        if var visual = value["visual"] as? [String: Any] {
            if let error = visual.removeValue(forKey: "nativeChromeError") { diagnostic["nativeChromeError"] = error }
            value["visual"] = visual
        }
        try writeJSON(diagnostic, to: report.appendingPathExtension("diagnostics.json"))
        try writeJSON(value, to: report)
    }
    private func writeJSON(_ value: [String: Any], to output: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        let parent = report.deletingLastPathComponent()
        let pending = parent.appendingPathComponent(".didi-proof-" + UUID().uuidString)
        let file = open(pending.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw InstalledProofError.unsafePath }
        defer { close(file); try? FileManager.default.removeItem(at: pending) }
        let count = data.withUnsafeBytes { Darwin.write(file, $0.baseAddress, $0.count) }
        guard count == data.count, fsync(file) == 0, rename(pending.path, output.path) == 0 else { throw InstalledProofError.unsafePath }
    }
    @MainActor func cleanCredential() throws {
        let policy = NativeKeychainPolicy.check()
        guard policy == errSecSuccess else { throw NativeServiceError.keychain(policy) }
        let context = LAContext(); context.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: NativeCredentialImport.service,
                                   kSecAttrAccount as String: credentialAccount, kSecUseAuthenticationContext as String: context,
                                   kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeServiceError.keychain(status) }
    }
}
