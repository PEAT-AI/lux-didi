import Foundation

struct StartupFailureDiagnostic {
    enum Stage: String { case state, nodeProbe = "node-probe", spawn, readyFrame = "ready-frame", canonicalImport = "canonical-file-and-import", canonicalFile = "canonical-file", bootstrap, unknown }
    enum Category: String {
        case invalidRuntime, invalidNode, invalidOperatorSettings, unsafeState, unsafeCredential, credentialMismatch, keychain, invalidReady, exited, timeout, alreadyStarting
        case invalidConfiguration, credentialUnavailable, unavailable, authentication, invalidResponse, rejected, unresolvedCapture, unknown
    }
    enum Operation: String { case policyRecheck, copyMatching, add, none }
    let stage: Stage
    let category: Category
    let operation: Operation
    let status: Int32?
}

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
    var voiceProcessing: Bool?
    var preCreateFailureClass: String?
    var preCreateFailureCode: String?
    var preCreateFailureAge: String?
    var startupFailure: StartupFailureDiagnostic?
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

    static func voiceProcessing(_ value: Bool?) -> String {
        switch value {
        case .some(true): return "on"
        case .some(false): return "off"
        case nil: return unknown
        }
    }

    /// The age of the last pre-CREATE failure, only when a real failure and an age are both present.
    static func ageSuffix(_ input: DiagnosticsSnapshotInput) -> String {
        guard let age = input.preCreateFailureAge, input.preCreateFailureClass != nil, input.preCreateFailureCode != nil else { return "" }
        return " (age " + scrub(age) + ")"
    }

    /// A bounded, deterministic age label: seconds under a minute, else minutes, else hours.
    static func ageText(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h"
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
        lines.append("Voice processing: " + voiceProcessing(input.voiceProcessing))
        lines.append("Last pre-CREATE failure: " + scrub(input.preCreateFailureClass) + "/" + scrub(input.preCreateFailureCode) + ageSuffix(input))
        lines.append("Last startup failure: " + startupFailure(input.startupFailure))
        return lines.joined(separator: "\n") + "\n"
    }

    static func startupFailure(_ value: StartupFailureDiagnostic?) -> String {
        guard let value, value.stage != .unknown, value.category != .unknown else { return unknown }
        let allowed: [StartupFailureDiagnostic.Category]
        switch value.stage {
        case .state: allowed = [.unsafeState, .exited]
        case .nodeProbe: allowed = [.invalidNode, .invalidRuntime, .invalidReady, .exited]
        case .spawn: allowed = [.invalidRuntime]
        case .readyFrame: allowed = [.invalidReady, .exited, .timeout]
        case .canonicalImport: allowed = [.unsafeState, .unsafeCredential, .credentialMismatch, .keychain, .exited]
        case .canonicalFile: allowed = [.unsafeState, .unsafeCredential, .credentialMismatch, .exited]
        case .bootstrap: allowed = [.invalidConfiguration, .credentialUnavailable, .unavailable, .authentication, .invalidResponse, .rejected, .unresolvedCapture]
        case .unknown: return unknown
        }
        guard allowed.contains(value.category) else { return unknown }
        if value.category == .keychain {
            guard let status = value.status, status != 0, value.operation != .none else { return unknown }
            return "stage=" + value.stage.rawValue + " category=keychain operation=" + value.operation.rawValue + " status=" + String(status)
        }
        guard value.status == nil, value.operation == .none else { return unknown }
        return "stage=" + value.stage.rawValue + " category=" + value.category.rawValue + " operation=none status=unknown"
    }

    /// The last typed pre-CREATE failure recorded by `logFailure`. Only the
    /// whitelisted `failureClass` and `code` leave the log, never a message.
    static func preCreateFailure(inLog text: String) -> (failureClass: String, code: String, at: String?)? {
        var result: (failureClass: String, code: String, at: String?)?
        for line in text.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data),
                  let object = raw as? [String: Any],
                  object["event"] as? String == "live_precreate_failed",
                  let failureClass = object["failureClass"] as? String,
                  let code = object["code"] as? String else { continue }
            result = (failureClass, code, object["timestamp"] as? String)
        }
        return result
    }

    static func preCreateFailure(logsDirectory: URL?) -> (failureClass: String, code: String, at: String?)? {
        guard let url = logsDirectory?.appendingPathComponent("native-live.log"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return preCreateFailure(inLog: text)
    }

    /// The voice-processing choice of the last `audio_started` record in audio.log: the release 2b
    /// audio owner's recorded choice, read-only, so the snapshot survives a torn-down conversation.
    static func lastAudioVoiceProcessing(inLog text: String) -> Bool? {
        var result: Bool?
        for line in text.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data),
                  let object = raw as? [String: Any],
                  object["event"] as? String == "audio_started",
                  let value = object["voiceProcessing"] as? String else { continue }
            result = value == "true"
        }
        return result
    }

    static func lastAudioVoiceProcessing(logsDirectory: URL?) -> Bool? {
        guard let url = logsDirectory?.appendingPathComponent("audio.log"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return lastAudioVoiceProcessing(inLog: text)
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
