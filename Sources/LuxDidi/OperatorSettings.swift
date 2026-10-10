import Foundation
import Darwin

/// Closed, optional operator-selected local references. Absence is deliberate and
/// preserves the public default. The native launch only *reads* this value and
/// forwards the two paths to the existing host entry; it never reads profile
/// contents and the server keeps credential/profile policy, snapshots and grants.
struct OperatorSettings: Equatable {
    static let schemaVersion = 1
    static let directoryName = "ai.peat.lux-didi-operator"
    static let fileName = "settings.json"
    let configDir: URL?
    let ownerProfilePath: URL?

    private struct Document: Codable, Equatable {
        let schemaVersion: Int
        let configDir: String?
        let ownerProfilePath: String?
    }

    private static let closedKeys: Set<Set<String>> = [
        ["schemaVersion"],
        ["schemaVersion", "configDir"],
        ["schemaVersion", "ownerProfilePath"],
        ["schemaVersion", "configDir", "ownerProfilePath"]
    ]

    /// Per-user app-support sibling directory of the existing `ai.peat.lux-didi`
    /// state directory. Never inside the bundle, never shared between users.
    static func directory() throws -> URL {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw NativeServiceError.invalidOperatorSettings
        }
        return support.appendingPathComponent(directoryName, isDirectory: true)
    }

    /// `nil` means deliberately absent: the launch keeps the public default.
    /// A present but invalid store throws before any child is spawned.
    static func load() throws -> OperatorSettings? {
        let dir = try directory()
        var dirInfo = stat()
        if lstat(dir.path, &dirInfo) != 0 {
            if errno == ENOENT { return nil }
            throw NativeServiceError.invalidOperatorSettings
        }
        guard dirInfo.st_mode & S_IFMT == S_IFDIR, dirInfo.st_uid == geteuid(), dirInfo.st_mode & 0o777 == 0o700 else {
            throw NativeServiceError.invalidOperatorSettings
        }
        let canonicalDir = dir.resolvingSymlinksInPath().standardizedFileURL
        let file = dir.appendingPathComponent(fileName)
        var info = stat()
        if lstat(file.path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw NativeServiceError.invalidOperatorSettings
        }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o600,
              info.st_size > 0, info.st_size <= 16_384 else { throw NativeServiceError.invalidOperatorSettings }
        let resolved = file.resolvingSymlinksInPath().standardizedFileURL
        guard resolved.path.hasPrefix(canonicalDir.path + "/"), resolved.path.hasSuffix("/" + fileName) else {
            throw NativeServiceError.invalidOperatorSettings
        }
        let data = try Data(contentsOf: resolved)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              closedKeys.contains(Set(object.keys)) else { throw NativeServiceError.invalidOperatorSettings }
        let document = try JSONDecoder().decode(Document.self, from: data)
        guard document.schemaVersion == schemaVersion else { throw NativeServiceError.invalidOperatorSettings }
        return OperatorSettings(
            configDir: try document.configDir.map { try validatedTarget($0, directory: true) },
            ownerProfilePath: try document.ownerProfilePath.map { try validatedTarget($0, directory: false) })
    }

    /// Update semantics: an omitted field is preserved, never silently dropped.
    /// A configured owner profile survives a configDir-only update and vice versa.
    /// There is no clear grammar in this prerelease; the store is never replaced
    /// wholesale. Validates the merged result before writing atomically.
    static func update(configDir: URL?, ownerProfilePath: URL?) throws -> OperatorSettings {
        let existing = try load()
        let resolvedConfig = try configDir.map { try validatedTarget($0.path, directory: true) } ?? existing?.configDir
        let resolvedProfile = try ownerProfilePath.map { try validatedTarget($0.path, directory: false) } ?? existing?.ownerProfilePath
        try store(configDir: resolvedConfig, ownerProfilePath: resolvedProfile)
        return OperatorSettings(configDir: resolvedConfig, ownerProfilePath: resolvedProfile)
    }

    private static func store(configDir: URL?, ownerProfilePath: URL?) throws {
        let dir = try directory()
        try prepareDirectory(dir)
        let document = Document(schemaVersion: schemaVersion, configDir: configDir?.path, ownerProfilePath: ownerProfilePath?.path)
        var data = try JSONEncoder().encode(document)
        data.append(10)
        let temporary = dir.appendingPathComponent(".\(fileName).\(UUID().uuidString).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeServiceError.invalidOperatorSettings }
        var wrote = false
        defer { close(fd); if !wrote { unlink(temporary.path) } }
        let bytes = [UInt8](data)
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeBytes { write(fd, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw NativeServiceError.invalidOperatorSettings }
            offset += count
        }
        guard fsync(fd) == 0 else { throw NativeServiceError.invalidOperatorSettings }
        wrote = true
        guard rename(temporary.path, dir.appendingPathComponent(fileName).path) == 0 else { throw NativeServiceError.invalidOperatorSettings }
    }

    /// Absolute, correct type, owned by the current user, never group/world
    /// writable, outside *any* .app bundle, and not a symlink at the final
    /// component. Ownership is checked on the target itself only: system-owned
    /// ancestors such as /Users are never required to belong to the user.
    /// Any refusal is a single safe error: no path or content is surfaced.
    static func validatedTarget(_ path: String, directory: Bool) throws -> URL {
        guard path.hasPrefix("/"), !path.contains("\0"), !path.isEmpty else { throw NativeServiceError.invalidOperatorSettings }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        var linkInfo = stat()
        guard lstat(url.path, &linkInfo) == 0, linkInfo.st_mode & S_IFMT != S_IFLNK else { throw NativeServiceError.invalidOperatorSettings }
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL
        guard !insideAnyApp(resolved) else { throw NativeServiceError.invalidOperatorSettings }
        var info = stat()
        guard stat(resolved.path, &info) == 0, info.st_uid == geteuid(), info.st_mode & 0o022 == 0 else {
            throw NativeServiceError.invalidOperatorSettings
        }
        guard info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) else { throw NativeServiceError.invalidOperatorSettings }
        return resolved
    }

    /// Any ancestor or final component named *.app is refused, not only the
    /// running bundle, so a target can never live inside any app bundle.
    private static func insideAnyApp(_ url: URL) -> Bool {
        return url.pathComponents.contains { $0.hasSuffix(".app") }
    }

    private static func prepareDirectory(_ dir: URL) throws {
        if mkdir(dir.path, 0o700) != 0 && errno != EEXIST { throw NativeServiceError.invalidOperatorSettings }
        let fd = open(dir.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeServiceError.invalidOperatorSettings }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700 else {
            throw NativeServiceError.invalidOperatorSettings
        }
    }
}

/// Explicit configure entry on the existing native executable. Validates and
/// atomically writes settings using the same Swift validator, then returns before
/// any AppKit, host, browser or audio work. No second writer or toolchain.
struct ConfigureRequest: Equatable {
    let configDir: String?
    let ownerProfilePath: String?

    static func parse(arguments: [String]) throws -> ConfigureRequest? {
        guard arguments.contains("--configure") else { return nil }
        var configDir: String?
        var ownerProfilePath: String?
        var sawConfigure = false
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--configure":
                guard !sawConfigure else { throw NativeServiceError.invalidOperatorSettings }
                sawConfigure = true
                index += 1
            case "--config-dir", "--owner-profile":
                let key = arguments[index]
                guard index + 1 < arguments.count else { throw NativeServiceError.invalidOperatorSettings }
                let value = arguments[index + 1]
                guard !value.hasPrefix("--"), value.hasPrefix("/") else { throw NativeServiceError.invalidOperatorSettings }
                if key == "--config-dir" {
                    guard configDir == nil else { throw NativeServiceError.invalidOperatorSettings }
                    configDir = value
                } else {
                    guard ownerProfilePath == nil else { throw NativeServiceError.invalidOperatorSettings }
                    ownerProfilePath = value
                }
                index += 2
            default:
                throw NativeServiceError.invalidOperatorSettings
            }
        }
        guard sawConfigure, configDir != nil || ownerProfilePath != nil else { throw NativeServiceError.invalidOperatorSettings }
        return ConfigureRequest(configDir: configDir, ownerProfilePath: ownerProfilePath)
    }

    /// 0 saved, 2 refused. Both messages are safe: no path or content.
    func run() -> Int32 {
        do {
            try OperatorSettings.update(configDir: configDir.map { URL(fileURLWithPath: $0) },
                                        ownerProfilePath: ownerProfilePath.map { URL(fileURLWithPath: $0) })
            print("DIDI CONFIGURE: saved")
            return 0
        } catch {
            fputs("DIDI CONFIGURE: invalid target\n", stderr)
            return 2
        }
    }
}
