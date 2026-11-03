import AppKit
import Foundation
import os

/// The closed set of outcomes the host may learn; anything else is `failed`.
public enum NativeActionCode: String, Sendable, Equatable {
    case opened
    case notAllowed = "not_allowed"
    case notFound = "not_found"
    case failed
    /// F6b: the browser this open would use is installed but not running. Nothing was launched.
    case browserNotRunning = "browser_not_running"
}

public struct NativeActionResult: Sendable, Equatable {
    public let code: NativeActionCode
    public var ok: Bool { code == .opened }
    public init(code: NativeActionCode) { self.code = code }
}

/// One typed control frame from the host. The shape is exact: four keys, plus `origin` on an open_url
/// frame that names the one Mattermost origin the host learned (OPEN2-R1).
public struct NativeActionFrame: Sendable, Equatable {
    public enum Action: String, Sendable, CaseIterable {
        case openURL = "open_url"
        case openFile = "open_file"
        case openApp = "open_app"
        // Only the host canary-session transport emits this action, never a model tool.
        case canaryAcknowledgement = "canary_ack"
    }
    public let id: String
    public let action: Action
    public let target: String
    public let origin: String?

    public init(id: String, action: Action, target: String, origin: String? = nil) {
        self.id = id; self.action = action; self.target = target; self.origin = origin
    }

    /// Parse a text frame; any other frame, including audio-free host chatter, is not an action.
    public static func control(_ text: String) -> NativeActionFrame? {
        guard text.utf8.count <= 4096, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["type"] as? String == "native_action",
              let id = object["id"] as? String, !id.isEmpty, id.utf8.count <= 64,
              let rawAction = object["action"] as? String, let action = Action(rawValue: rawAction),
              let target = object["target"] as? String, !target.isEmpty, target.utf8.count <= 1024
        else { return nil }
        // `origin` is an optional fifth key, and only an open_url frame may carry it.
        let hasOrigin = object.index(forKey: "origin") != nil
        guard object.count == (hasOrigin ? 5 : 4) else { return nil }
        var origin: String?
        if hasOrigin {
            guard action == .openURL, let named = object["origin"] as? String, !named.isEmpty, named.utf8.count <= 300 else { return nil }
            origin = named
        }
        return NativeActionFrame(id: id, action: action, target: target, origin: origin)
    }
}

/// The one ack frame: id, ok and a closed code.
public struct NativeActionReply: Sendable, Equatable {
    public let id: String
    public let result: NativeActionResult
    public init(id: String, result: NativeActionResult) { self.id = id; self.result = result }

    public var json: String {
        let escaped = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "{\"type\":\"native_action_result\",\"id\":\"\(escaped)\",\"ok\":\(result.ok),\"code\":\"\(result.code.rawValue)\"}"
    }
}

public protocol NativeActionExecuting: Sendable {
    func perform(_ action: NativeActionFrame.Action, target: String) async -> NativeActionResult
    /// OPEN2-R1: pin the one Mattermost origin the host named; a different one is refused by `perform`.
    func adopt(mattermostOrigin: String) async -> Bool
}

/// The viewer destinations the native side accepts on its own: an exact host and a viewer path, never a
/// string prefix, so a destination the host should never have sent is still refused here.
public struct OpenDestination: Sendable, Equatable {
    public let kind: String
    public init(kind: String) { self.kind = kind }

    public static func of(_ target: String, mattermostHost: String?) -> OpenDestination? {
        guard let parts = URLComponents(string: target),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil,
              let host = parts.host, !host.isEmpty, parts.url != nil else { return nil }
        return OpenDestination(kind: "web")
    }
}

/// The workspace calls the opener makes, so a test can prove which browser a destination goes to.
public protocol BrowserWorkspace: Sendable {
    func applicationURL(bundleIdentifier: String) -> URL?
    func open(_ url: URL, withApplicationAt application: URL) async -> Bool
    func open(_ url: URL) -> Bool
    func openApplication(at url: URL) async -> Bool
}

/// The real workspace: `NSWorkspace` only.
public struct SystemWorkspace: BrowserWorkspace {
    public init() {}
    public func applicationURL(bundleIdentifier: String) -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
    }
    public func open(_ url: URL, withApplicationAt application: URL) async -> Bool {
        let configuration = NSWorkspace.OpenConfiguration()
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.open([url], withApplicationAt: application, configuration: configuration) { _, error in
                continuation.resume(returning: error == nil)
            }
        }
    }
    public func open(_ url: URL) -> Bool { NSWorkspace.shared.open(url) }
    public func openApplication(at url: URL) async -> Bool {
        let configuration = NSWorkspace.OpenConfiguration()
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                continuation.resume(returning: error == nil)
            }
        }
    }
}

/// F6b: whether the browser an https open would use is installed, and whether it is already running.
public struct BrowserState: Sendable, Equatable {
    public let installed: Bool
    public let running: Bool
    public init(installed: Bool, running: Bool) { self.installed = installed; self.running = running }
}

/// Mechanical native opening boundary. Task authority belongs to the host.
public actor NativeActions: NativeActionExecuting {
    public typealias Opener = @Sendable (URL, Bool) async -> Bool
    public typealias AppSearch = @Sendable (String) -> [URL]

    public static let openLimit = 5
    public static let windowSeconds: TimeInterval = 60

    private let home: URL
    private let opener: Opener
    private let appSearch: AppSearch
    private let browserState: @Sendable () -> BrowserState
    private let clock: @Sendable () -> Date
    private let log: Logger
    private var mattermostHost: String?
    private var opened: [Date] = []

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                opener: @escaping Opener = NativeActions.workspaceOpen,
                browserState: @escaping @Sendable () -> BrowserState = NativeActions.systemBrowserState,
                mattermostHost: String? = nil,
                clock: @escaping @Sendable () -> Date = { Date() },
                appSearch: @escaping AppSearch = NativeActions.spotlightApps) {
        self.home = home.resolvingSymlinksInPath().standardizedFileURL
        self.opener = opener
        self.appSearch = appSearch
        self.browserState = browserState
        self.mattermostHost = mattermostHost
        self.clock = clock
        self.log = Logger(subsystem: "ai.lux.didi", category: "native-actions")
    }

    /// C-OPEN 5: the browser a web destination opens in, named by bundle id and resolved by the workspace.
    public static let chromeBundleIdentifier = "com.google.Chrome"

    /// F6b: the line she says when the link needed a browser that is not running. The owner's own name comes
    /// from the account this Mac is signed in to, never a literal in the source.
    public static var browserNotRunningGuidance: String { guidance(for: NSFullUserName()) }

    /// The same line for a name that was already read, so a test never depends on who is logged in.
    public static func guidance(for fullName: String) -> String {
        let name = fullName.split(separator: " ").first.map(String.init) ?? "there"
        return "\(name), Chrome is not open, could you open it for me?"
    }

    /// F6b: whether the browser an https open would use is installed, and whether it is already running.
    public static let systemBrowserState: @Sendable () -> BrowserState = {
        let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: chromeBundleIdentifier)
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundleIdentifier).isEmpty
        return BrowserState(installed: application != nil, running: running)
    }

    /// A web destination opens in Chrome when Chrome is installed and in the default browser otherwise; a
    /// file opens in its own app. No script, no profile flag, no keystroke: only the workspace open call.
    public static func browserOpener(_ workspace: BrowserWorkspace) -> Opener {
        { url, isApplication in
            if isApplication { return await workspace.openApplication(at: url) }
            return workspace.open(url)
        }
    }

    /// `NSWorkspace` opening. Only the opened item comes forward; Naya's own window is never activated.
    public static let workspaceOpen: Opener = browserOpener(SystemWorkspace())

    /// OPEN2-R1: https, the host alone, no userinfo, no port and no path beyond the root. The first
    /// origin the host names is pinned for the life of this process; any other one is refused.
    public func adopt(mattermostOrigin raw: String) async -> Bool {
        guard let host = NativeActions.originHost(raw) else { return false }
        mattermostHost = host
        return true
    }

    static func originHost(_ raw: String) -> String? {
        guard let parts = URLComponents(string: raw), parts.scheme == "https",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let host = parts.host?.lowercased(), !host.isEmpty, host.utf8.count <= 253
        else { return nil }
        return host
    }

    public func perform(_ action: NativeActionFrame.Action, target: String) async -> NativeActionResult {
        switch action {
        case .canaryAcknowledgement:
            // Deliberately before URL resolution, workspace calls and focus-changing code.
            return receipt(action, .opened, "canary_ack")
        case .openURL:
            guard let parts = URLComponents(string: target),
                  ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
                  parts.user == nil, parts.password == nil,
                  let host = parts.host, !host.isEmpty, let url = parts.url
            else { return receipt(action, .notAllowed, "none") }
            return await open(url, isApplication: false, action: action, detail: "web")
        case .openFile:
            guard let url = fileURL(target) else { return receipt(action, .notAllowed, extensionOf(target)) }
            guard FileManager.default.isReadableFile(atPath: url.path) else { return receipt(action, .notFound, extensionOf(target)) }
            return await open(url, isApplication: false, action: action, detail: extensionOf(target))
        case .openApp:
            guard let url = appURL(target) else { return receipt(action, target.contains("/") ? .notAllowed : .notFound, "app") }
            return await open(url, isApplication: true, action: action, detail: "app")
        }
    }

    /// Same-origin file under the owner's home folder, canonicalized so no symlink escapes it.
    public func fileURL(_ target: String) -> URL? {
        let expanded: String
        if target == "~" { expanded = home.path }
        else if target.hasPrefix("~/") { expanded = home.path + String(target.dropFirst(1)) }
        else if target.hasPrefix("/") { expanded = target }
        else { return nil }
        let resolved = URL(fileURLWithPath: expanded).resolvingSymlinksInPath().standardizedFileURL
        return resolved
    }

    /// Installed application by name through Launch Services, with standard-folder fallback.
    public func appURL(_ target: String) -> URL? {
        let name = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else { return nil }
        let base = name.hasSuffix(".app") ? String(name.dropLast(4)) : name
        guard !base.isEmpty else { return nil }
        for folder in [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications"), URL(fileURLWithPath: "/System/Applications")] {
            let candidate = folder.appendingPathComponent(base + ".app").resolvingSymlinksInPath().standardizedFileURL
            guard candidate.path.hasPrefix(folder.resolvingSymlinksInPath().standardizedFileURL.path + "/") else { continue }
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("Contents/Info.plist").path) { return candidate }
        }
        // Launch Services has no supported name lookup. Spotlight finds other installed locations.
        let escaped = base.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let query = "kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == \"\(escaped).app\"cd"
        return appSearch(query).first
    }

    public static func spotlightApps(_ query: String) -> [URL] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = ["-0", query]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            if process.terminationStatus == 0, let paths = String(data: data, encoding: .utf8) {
                return paths.split(separator: "\0").map { URL(fileURLWithPath: String($0)) }
            }
        } catch { return [] }
        return []
    }

    private func extensionOf(_ target: String) -> String {
        guard let name = target.split(separator: "/").last else { return "none" }
        let ext = (String(name) as NSString).pathExtension.lowercased()
        return ext.isEmpty || ext.utf8.count > 16 ? "none" : ext
    }

    private func open(_ url: URL, isApplication: Bool, action: NativeActionFrame.Action, detail: String) async -> NativeActionResult {
        let didOpen = await opener(url, isApplication)
        return receipt(action, didOpen ? .opened : .failed, detail)
    }

    /// A closed receipt: action, code and a scheme or extension, never a URL path or a file name.
    private func receipt(_ action: NativeActionFrame.Action, _ code: NativeActionCode, _ detail: String) -> NativeActionResult {
        log.notice("native action \(action.rawValue, privacy: .public) \(code.rawValue, privacy: .public) \(detail, privacy: .public)")
        return NativeActionResult(code: code)
    }
}
