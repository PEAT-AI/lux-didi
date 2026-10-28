import AppKit
import Foundation
import os

/// The closed set of outcomes the host may learn; anything else is `failed`.
public enum NativeActionCode: String, Sendable, Equatable {
    case opened
    case notAllowed = "not_allowed"
    case notFound = "not_found"
    case failed
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

    private static let rejected = "(^|/)(url|redirect|export|download)(/|$)"

    public static func of(_ target: String, mattermostHost: String?) -> OpenDestination? {
        guard let parts = URLComponents(string: target), parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased(), !host.isEmpty, !matches(parts.percentEncodedPath, rejected)
        else { return nil }
        // The raw path, as the host reads it: a %2F never becomes a separator here.
        let path = parts.percentEncodedPath
        let items = parts.queryItems ?? []
        // C-OPENWEB8: exactly one shape carries `q`, a plain Google search. Every other shape refuses it
        // as before, so a search phrase cannot ride the last-line allowlist on a mail, docs or video link.
        let googleSearch = host == "www.google.com" && path == "/search" && names(items) == ["q"] && (value(items, "q") ?? "").isEmpty == false
        if !googleSearch && items.contains(where: { $0.name == "q" || $0.name == "redirect" || $0.name == "export" }) { return nil }
        let eid = items.contains { $0.name == "eid" }
        let video = items.first { $0.name == "v" }?.value?.isEmpty == false
        switch host {
        case "mail.google.com":
            guard parts.percentEncodedFragment == nil || parts.percentEncodedFragment == "" || matches(parts.percentEncodedFragment!, "^(all|inbox|sent)/[A-Za-z0-9_-]{1,256}$") else { return nil }
            return matches(path, "^/mail/u/([0-9]{1,2}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\\.[A-Za-z0-9-]{1,63})+)/?$") ? OpenDestination(kind: "gmail") : nil
        case "calendar.google.com":
            if path == "/" { return OpenDestination(kind: "calendar") }
            return matches(path, "^/(calendar/)?event/?$") && eid ? OpenDestination(kind: "calendar") : nil
        case "www.google.com":
            // The link the Calendar API returns for an event, and the three web surfaces open_web builds:
            // a maps search, directions and a plain Google search, each with exactly its own parameters.
            if path == "/calendar/event" && eid { return OpenDestination(kind: "calendar") }
            if googleSearch { return OpenDestination(kind: "web") }
            if path == "/maps/search/" && names(items) == ["api", "query"] && value(items, "api") == "1" { return OpenDestination(kind: "web") }
            if path == "/maps/dir/", value(items, "api") == "1",
               ["api", "destination", "origin"].contains(names(items)), value(items, "destination")?.isEmpty == false {
                return OpenDestination(kind: "web")
            }
            return nil
        case "docs.google.com":
            return matches(path, "^/(document|presentation|spreadsheets)/d/[A-Za-z0-9_-]{1,256}(/(edit|view))?/?$") ? OpenDestination(kind: "docs") : nil
        case "drive.google.com":
            return matches(path, "^/(file/d/[A-Za-z0-9_-]{1,256}|drive/folders/[A-Za-z0-9_-]{1,256})(/view)?/?$") ? OpenDestination(kind: "drive") : nil
        case "www.youtube.com", "youtube.com":
            return path == "/watch" && video ? OpenDestination(kind: "youtube") : nil
        case "youtu.be":
            return matches(path, "^/[A-Za-z0-9_-]{1,64}/?$") ? OpenDestination(kind: "youtube") : nil
        default:
            if let configured = mattermostHost?.lowercased(), host == configured {
                return matches(path, "^/(t/)?[A-Za-z0-9._-]{1,64}/(pl|channels)/[A-Za-z0-9._-]{1,64}/?$") ? OpenDestination(kind: "mattermost") : nil
            }
            // C-OPENWEB8: a site root and nothing else, on a host none of the cases above claims.
            return path == "/" && items.isEmpty && matches(host, "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
                ? OpenDestination(kind: "web") : nil
        }
    }

    private static func names(_ items: [URLQueryItem]) -> [String] {
        items.map { $0.name }.sorted()
    }

    private static func value(_ items: [URLQueryItem], _ name: String) -> String? {
        items.first { $0.name == name }?.value
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
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

/// The native boundary. It re-checks the allowlist itself and never trusts the host's argument shape.
public actor NativeActions: NativeActionExecuting {
    public typealias Opener = @Sendable (URL, Bool) async -> Bool

    public static let openLimit = 5
    public static let windowSeconds: TimeInterval = 60

    private let home: URL
    private let opener: Opener
    private let clock: @Sendable () -> Date
    private let log: Logger
    private var mattermostHost: String?
    private var opened: [Date] = []

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                opener: @escaping Opener = NativeActions.workspaceOpen,
                mattermostHost: String? = nil,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.home = home.resolvingSymlinksInPath().standardizedFileURL
        self.opener = opener
        self.mattermostHost = mattermostHost
        self.clock = clock
        self.log = Logger(subsystem: "ai.lux.didi", category: "native-actions")
    }

    /// C-OPEN 5: the browser a web destination opens in, named by bundle id and resolved by the workspace.
    public static let chromeBundleIdentifier = "com.google.Chrome"

    /// A web destination opens in Chrome when Chrome is installed and in the default browser otherwise; a
    /// file opens in its own app. No script, no profile flag, no keystroke: only the workspace open call.
    public static func browserOpener(_ workspace: BrowserWorkspace) -> Opener {
        { url, isApplication in
            if isApplication { return await workspace.openApplication(at: url) }
            guard url.scheme?.lowercased() == "https", let chrome = workspace.applicationURL(bundleIdentifier: chromeBundleIdentifier)
            else { return workspace.open(url) }
            return await workspace.open(url, withApplicationAt: chrome)
        }
    }

    /// `NSWorkspace` opening. Only the opened item comes forward; Naya's own window is never activated.
    public static let workspaceOpen: Opener = browserOpener(SystemWorkspace())

    /// OPEN2-R1: https, the host alone, no userinfo, no port and no path beyond the root. The first
    /// origin the host names is pinned for the life of this process; any other one is refused.
    public func adopt(mattermostOrigin raw: String) async -> Bool {
        guard let host = NativeActions.originHost(raw) else { return false }
        if let pinned = mattermostHost { return pinned == host }
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
        case .openURL:
            guard let destination = OpenDestination.of(target, mattermostHost: mattermostHost), let url = URL(string: target)
            else { return receipt(action, .notAllowed, "none") }
            return await open(url, isApplication: false, action: action, detail: destination.kind)
        case .openFile:
            guard let url = fileURL(target) else { return receipt(action, .notAllowed, extensionOf(target)) }
            guard FileManager.default.fileExists(atPath: url.path) else { return receipt(action, .notFound, extensionOf(target)) }
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
        guard !expanded.contains("/../") else { return nil }
        let resolved = URL(fileURLWithPath: expanded).resolvingSymlinksInPath().standardizedFileURL
        return isInsideHome(resolved) ? resolved : nil
    }

    /// A bundle inside one of the three application folders, by name only.
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
        return nil
    }

    private func isInsideHome(_ url: URL) -> Bool {
        url.path == home.path || url.path.hasPrefix(home.path + "/")
    }

    private func extensionOf(_ target: String) -> String {
        guard let name = target.split(separator: "/").last else { return "none" }
        let ext = (String(name) as NSString).pathExtension.lowercased()
        return ext.isEmpty || ext.utf8.count > 16 ? "none" : ext
    }

    private func open(_ url: URL, isApplication: Bool, action: NativeActionFrame.Action, detail: String) async -> NativeActionResult {
        let now = clock()
        opened = opened.filter { now.timeIntervalSince($0) < NativeActions.windowSeconds }
        guard opened.count < NativeActions.openLimit else { return receipt(action, .notAllowed, detail) }
        opened.append(now)
        let didOpen = await opener(url, isApplication)
        return receipt(action, didOpen ? .opened : .failed, detail)
    }

    /// A closed receipt: action, code and a scheme or extension, never a URL path or a file name.
    private func receipt(_ action: NativeActionFrame.Action, _ code: NativeActionCode, _ detail: String) -> NativeActionResult {
        log.notice("native action \(action.rawValue, privacy: .public) \(code.rawValue, privacy: .public) \(detail, privacy: .public)")
        return NativeActionResult(code: code)
    }
}
