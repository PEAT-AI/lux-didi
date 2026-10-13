import Foundation

/// Plain inputs for the "Copy diagnostics" support snapshot.
///
/// Audio routes admit only closed classifications, never device or owner labels.
/// Other values are short support labels. Nothing here is read
/// from secrets, keychain items, cookies, tokens, transcripts, memory, persona
/// text, mail or file contents; a value that still looks like a credential is
/// replaced by `unknown` before it reaches the clipboard.
struct DiagnosticsSnapshotInput {
    var appVersion: String?
    var releaseCommit: String?
    var macOSVersion: String?
    var serviceState: String?
    var serviceOrigin: String?
    var liveState: String?
    var sessionLimit: String?
    var idleLimit: String?
    var connections: [String]?
    var audioRoute: String?
    var preCreateFailureClass: String?
    var preCreateFailureCode: String?
    var capturedAt: String?
}

/// Renders the clipboard text for the "Copy diagnostics" status-menu item.
///
/// Pure and AppKit-free, so a seam test can prove every field renders, prove
/// missing inputs read `unknown`, and prove no secret-looking value survives.
enum NativeDiagnosticsSnapshot {
    static let unknown = "unknown"
    private static let secretMarkers = ["bearer", "cookie", "key=", "token", "secret", "password", "authorization", "private key", "-----begin"]

    /// Returns a safe label, or `unknown` when absent or credential-shaped.
    static func scrub(_ value: String?) -> String {
        guard let value else { return unknown }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return unknown }
        guard !secretMarkers.contains(where: trimmed.lowercased().contains) else { return unknown }
        return trimmed
    }

    /// The port of a service origin, which is the only part of the origin we show.
    static func port(_ origin: String?) -> String? {
        guard let origin, let port = URLComponents(string: origin)?.port else { return nil }
        return String(port)
    }

    static func render(_ input: DiagnosticsSnapshotInput) -> String {
        var lines: [String] = ["Didi diagnostics"]
        lines.append("Captured: " + scrub(input.capturedAt))
        lines.append("App version: " + scrub(input.appVersion))
        lines.append("Release commit: " + scrub(input.releaseCommit))
        lines.append("macOS: " + scrub(input.macOSVersion))
        lines.append("Service: " + scrub(input.serviceState) + " (origin port " + scrub(port(input.serviceOrigin)) + ")")
        lines.append("Live: " + scrub(input.liveState))
        lines.append("Limits: session " + scrub(input.sessionLimit) + ", idle " + scrub(input.idleLimit))
        let connectors = (input.connections ?? []).map(scrub)
        lines.append("Connectors: " + (connectors.isEmpty ? "none" : ""))
        lines.append(contentsOf: connectors.map { "  - " + $0 })
        let classifications = ["built-in", "external wired", "Bluetooth", "USB", "unknown"]
        let routes = classifications.flatMap { input in classifications.map { "Input: " + input + "; Output: " + $0 } }
        lines.append("Audio route: " + (routes.contains(input.audioRoute ?? "") ? input.audioRoute! : "Input: unknown; Output: unknown"))
        lines.append("Last pre-CREATE failure: " + scrub(input.preCreateFailureClass) + "/" + scrub(input.preCreateFailureCode))
        return lines.joined(separator: "\n") + "\n"
    }

    /// The last typed pre-CREATE failure recorded by `logFailure`. Only the
    /// whitelisted `failureClass` and `code` leave the log, never a message.
    static func preCreateFailure(inLog text: String) -> (failureClass: String, code: String)? {
        var result: (failureClass: String, code: String)?
        for line in text.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data),
                  let object = raw as? [String: Any],
                  object["event"] as? String == "live_precreate_failed",
                  let failureClass = object["failureClass"] as? String,
                  let code = object["code"] as? String else { continue }
            result = (failureClass, code)
        }
        return result
    }

    static func preCreateFailure(logsDirectory: URL?) -> (failureClass: String, code: String)? {
        guard let url = logsDirectory?.appendingPathComponent("native-live.log"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return preCreateFailure(inLog: text)
    }
}

/// Menu wiring seam: the status item's action builds the snapshot and hands it
/// to the pasteboard. A test injects recording closures, never the real
/// clipboard or the installed app.
struct NativeDiagnosticsAction {
    static let itemTitle = "Copy diagnostics"
    private let makeInput: () -> DiagnosticsSnapshotInput
    private let write: (String) -> Void

    init(makeInput: @escaping () -> DiagnosticsSnapshotInput, write: @escaping (String) -> Void) {
        self.makeInput = makeInput
        self.write = write
    }

    func copy() { write(NativeDiagnosticsSnapshot.render(makeInput())) }
}
