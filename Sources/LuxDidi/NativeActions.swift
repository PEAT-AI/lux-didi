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

/// One typed control frame from the host. The shape is exact: four keys, nothing else.
public struct NativeActionFrame: Sendable, Equatable {
    public enum Action: String, Sendable, CaseIterable {
        case openURL = "open_url"
        case openFile = "open_file"
        case openApp = "open_app"
    }
    public let id: String
    public let action: Action
    public let target: String

    public init(id: String, action: Action, target: String) {
        self.id = id; self.action = action; self.target = target
    }

    /// Parse a text frame; any other frame, including audio-free host chatter, is not an action.
    public static func control(_ text: String) -> NativeActionFrame? {
        guard text.utf8.count <= 4096, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object.count == 4, object["type"] as? String == "native_action",
              let id = object["id"] as? String, !id.isEmpty, id.utf8.count <= 64,
              let rawAction = object["action"] as? String, let action = Action(rawValue: rawAction),
              let target = object["target"] as? String, !target.isEmpty, target.utf8.count <= 1024
        else { return nil }
        return NativeActionFrame(id: id, action: action, target: target)
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
              let host = parts.host?.lowercased(), !host.isEmpty, !matches(parts.path, rejected),
              !(parts.queryItems ?? []).contains(where: { $0.name == "q" || $0.name == "redirect" })
        else { return nil }
        let path = parts.path
        let eid = (parts.queryItems ?? []).contains { $0.name == "eid" }
        let video = (parts.queryItems ?? []).first { $0.name == "v" }?.value?.isEmpty == false
        switch host {
        case "mail.google.com":
            return matches(path, "^/mail/u/[0-9]+/?$") ? OpenDestination(kind: "gmail") : nil
        case "calendar.google.com":
            if path == "/" { return OpenDestination(kind: "calendar") }
            return matches(path, "^/(calendar/)?event/?$") && eid ? OpenDestination(kind: "calendar") : nil
        case "docs.google.com":
            return matches(path, "^/(document|presentation|spreadsheets)/d/[A-Za-z0-9_-]{1,256}(/(edit|view))?/?$") ? OpenDestination(kind: "docs") : nil
        case "drive.google.com":
            return matches(path, "^/(file/d/[A-Za-z0-9_-]{1,256}|drive/folders/[A-Za-z0-9_-]{1,256})(/view)?/?$") ? OpenDestination(kind: "drive") : nil
        case "www.youtube.com", "youtube.com":
            return path == "/watch" && video ? OpenDestination(kind: "youtube") : nil
        case "youtu.be":
            return matches(path, "^/[A-Za-z0-9_-]{1,64}/?$") ? OpenDestination(kind: "youtube") : nil
        default:
            guard let configured = mattermostHost?.lowercased(), host == configured,
                  matches(path, "^/(t/)?[A-Za-z0-9._-]{1,64}/(pl|channels)/[A-Za-z0-9._-]{1,64}/?$") else { return nil }
            return OpenDestination(kind: "mattermost")
        }
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
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
    private let mattermostHost: String?
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

    /// `NSWorkspace` opening. Only the opened item comes forward; Naya's own window is never activated.
    public static let workspaceOpen: Opener = { url, isApplication in
        guard isApplication else { return NSWorkspace.shared.open(url) }
        let configuration = NSWorkspace.OpenConfiguration()
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                continuation.resume(returning: error == nil)
            }
        }
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
