import Foundation
import Darwin
import Security
import LocalAuthentication

enum NativeServiceError: LocalizedError {
    case invalidRuntime, invalidNode, unsafeState, unsafeCredential, credentialMismatch, keychain(OSStatus), invalidReady, exited, timeout, alreadyStarting
    var errorDescription: String? {
        switch self {
        case .invalidRuntime, .invalidNode: return "Didi’s service files need attention. Check Settings, then try again."
        case .unsafeState, .unsafeCredential, .credentialMismatch: return "Didi couldn’t securely connect. Check Settings, then try again."
        case .keychain: return "Didi couldn’t access its saved connection. Check Settings, then try again."
        case .invalidReady: return "Didi couldn’t verify its service. Try connecting again."
        case .exited: return "Didi’s service stopped. Connect again to continue."
        case .timeout: return "Didi’s service did not start in time. Try connecting again."
        case .alreadyStarting: return "Didi is already starting."
        }
    }
}

struct InstalledRuntime {
    let resources: URL
    let installId: String
    let releaseCommit: String
    let node: URL
    let nodeMajor: Int
    let serverEntry: URL
    let webRoot: URL
    private struct Manifest: Decodable {
        let schemaVersion: Int
        let installId: String
        let releaseCommit: String
        let nodePath: String
        let nodeMajor: Int
        let serverEntry: String
        let webRoot: String
    }
    static func load(resources: URL) throws -> InstalledRuntime? {
        let root = resources.resolvingSymlinksInPath().standardizedFileURL
        let file = root.appendingPathComponent("didi-runtime.json")
        var info = stat()
        if lstat(file.path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw NativeServiceError.invalidRuntime
        }
        guard info.st_size <= 16_384 else { throw NativeServiceError.invalidRuntime }
        let resolved = file.resolvingSymlinksInPath()
        guard resolved.path.hasPrefix(root.path + "/") else { throw NativeServiceError.invalidRuntime }
        let data = try Data(contentsOf: resolved)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["schemaVersion", "installId", "releaseCommit", "nodePath", "nodeMajor", "serverEntry", "webRoot"] else { throw NativeServiceError.invalidRuntime }
        let value = try JSONDecoder().decode(Manifest.self, from: data)
        guard value.schemaVersion == 1, let install = UUID(uuidString: value.installId), value.nodeMajor == 26,
              value.releaseCommit.count == 40, value.releaseCommit.lowercased().allSatisfy({ "0123456789abcdef".contains($0) }),
              value.nodePath.hasPrefix("/"), !value.nodePath.contains("\0") else { throw NativeServiceError.invalidRuntime }
        func resource(_ relative: String, directory: Bool) throws -> URL {
            let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
            guard !parts.isEmpty, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }), !relative.contains("\0") else { throw NativeServiceError.invalidRuntime }
            let url = root.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
            var entry = stat()
            guard url.path.hasPrefix(root.path + "/"), stat(url.path, &entry) == 0,
                  entry.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG), entry.st_mode & 0o022 == 0 else { throw NativeServiceError.invalidRuntime }
            return url
        }
        let node = URL(fileURLWithPath: value.nodePath).resolvingSymlinksInPath()
        var executable = stat()
        guard stat(node.path, &executable) == 0, executable.st_mode & S_IFMT == S_IFREG,
              executable.st_mode & 0o022 == 0, FileManager.default.isExecutableFile(atPath: node.path) else { throw NativeServiceError.invalidNode }
        return InstalledRuntime(resources: root, installId: install.uuidString.lowercased(), releaseCommit: value.releaseCommit.lowercased(), node: node,
                                nodeMajor: value.nodeMajor, serverEntry: try resource(value.serverEntry, directory: false), webRoot: try resource(value.webRoot, directory: true))
    }
    static func applicationState() throws -> URL {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw NativeServiceError.unsafeState }
        return support.appendingPathComponent("ai.peat.lux-didi", isDirectory: true)
    }
}

struct NativeCredentialReference { let service: String; let account: String }

enum NativeCredentialImport {
    static let service = "ai.peat.lux-didi.admin"
    static func prepareState(_ state: URL) throws {
        var info = stat()
        if lstat(state.path, &info) != 0 {
            guard errno == ENOENT else { throw NativeServiceError.unsafeState }
            try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let fd = open(state.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeServiceError.unsafeState }
        defer { close(fd) }
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700 else { throw NativeServiceError.unsafeState }
    }
    @MainActor static func importCredential(state: URL, installId: String, service: String = NativeCredentialImport.service,
                                 add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemAdd,
                                 policyCheck: @MainActor () -> OSStatus = NativeKeychainPolicy.check) throws -> NativeCredentialReference {
        let policy = policyCheck()
        guard policy == errSecSuccess else { throw NativeServiceError.keychain(policy) }
        let directory = open(state.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw NativeServiceError.unsafeState }
        defer { close(directory) }
        var info = stat()
        guard fstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700 else { throw NativeServiceError.unsafeState }
        let file = openat(directory, "admin-credential", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard file >= 0 else { throw NativeServiceError.unsafeCredential }
        defer { close(file) }
        guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o600,
              info.st_size > 0, info.st_size <= 4096 else { throw NativeServiceError.unsafeCredential }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        let count = bytes.withUnsafeMutableBytes { read(file, $0.baseAddress, $0.count) }
        guard count == bytes.count else { throw NativeServiceError.unsafeCredential }
        // Canonical Store serializes its token with one terminal LF, not bearer data.
        if bytes.last == 10 { bytes.removeLast() }
        guard bytes.count == 43, bytes.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) ||
            (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { throw NativeServiceError.unsafeCredential }
        let data = Data(bytes)
        let context = LAContext(); context.interactionNotAllowed = true
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrAccount as String: installId, kSecUseAuthenticationContext as String: context,
                                        kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var query = base
        query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var existing: CFTypeRef?
        let readPolicy = policyCheck()
        guard readPolicy == errSecSuccess else { throw NativeServiceError.keychain(readPolicy) }
        let status = SecItemCopyMatching(query as CFDictionary, &existing)
        if status == errSecSuccess {
            guard existing as? Data == data else { throw NativeServiceError.credentialMismatch }
        } else if status == errSecItemNotFound {
            var item = base
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let addPolicy = policyCheck()
            guard addPolicy == errSecSuccess else { throw NativeServiceError.keychain(addPolicy) }
            let added = add(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw NativeServiceError.keychain(added) }
        } else { throw NativeServiceError.keychain(status) }
        return NativeCredentialReference(service: service, account: installId)
    }
}
