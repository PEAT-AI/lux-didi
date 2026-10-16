import Foundation

/// Closed reason enum for every native-live.log end record. A teardown never writes free text,
/// so each ended call is readable from the log alone. Tests assert the tokens match `allCases`.
enum NativeLiveEndReason: String, CaseIterable {
    case invalidOutput = "invalid_output"
    case childExit = "child_exit"
    case logout
    case shutdown
    case userStop = "user_stop"
    case idleLimit = "idle_limit"
    case sessionLimit = "session_limit"
    case providerClosed = "provider_closed"
    case audioInterruption = "audio_interruption"
    case routeChange = "route_change"
}

/// Closed, privacy-safe detail for one end record: byte counts and OS status only, never content,
/// device labels, credentials or remote text.
enum NativeLiveEndDetail {
    /// `invalid_output` carries the byte count of the offending stdout, never a byte of it.
    static func invalidOutput(bytes: Int) -> [String: Any] { ["bytes": bytes] }
    /// `child_exit` carries the process exit status and, when signalled, the signal number.
    static func childExit(status: Int32, signal: Int32?) -> [String: Any] {
        var detail: [String: Any] = ["status": Int(status)]
        if let signal { detail["signal"] = Int(signal) }
        return detail
    }
    /// `provider_closed` carries the provider's numeric WebSocket close code.
    static func providerClosed(closeCode: Int) -> [String: Any] { ["closeCode": closeCode] }
}

/// One meter RMS window: numbers only, computed from the per-buffer levels the capture path already holds.
struct NativeLiveRms: Sendable {
    let mean: Float
    let max: Float
    let speechBuffers: Int
}

/// E1 interruption phase: `pre` is the second before the barge-in, `post` the five seconds after it.
enum NativeLiveInterruptionPhase: String, Sendable { case pre, post }

/// Append-only JSON-lines writer for native-live.log. Every record carries an ISO8601 timestamp,
/// the closed reason and its numeric detail. A test or a proof build can pass no URL and read
/// `events` instead. Writing never throws into a call path and never changes capture or session
/// state.
final class NativeLiveJournal {
    private let fileURL: URL?
    private let now: () -> Date
    private var handle: FileHandle?
    private(set) var events: [[String: Any]] = []

    init(fileURL: URL?, now: @escaping () -> Date = Date.init) {
        self.fileURL = fileURL
        self.now = now
    }

    func append(_ reason: NativeLiveEndReason, detail: [String: Any] = [:]) {
        append(reason, detail: detail, at: now())
    }

    func append(_ reason: NativeLiveEndReason, detail: [String: Any] = [:], at date: Date) {
        var record: [String: Any] = detail
        record["event"] = "live_end"
        record["reason"] = reason.rawValue
        record["timestamp"] = ISO8601DateFormatter().string(from: date)
        append(record)
    }

    /// Append any existing native-live record. A timestamp is added only when the caller's record
    /// has none, so every line carries an ISO timestamp without rewriting an existing one.
    func append(_ record: [String: Any]) {
        var fields = record
        if fields["timestamp"] == nil { fields["timestamp"] = ISO8601DateFormatter().string(from: now()) }
        events.append(fields)
        write(fields)
    }

    /// E1: one metadata-only `live_interrupted` line. Numbers, a boolean and the session id only,
    /// never audio, text, a device label or a provider payload.
    func appendInterruption(phase: NativeLiveInterruptionPhase, sessionID: String, bufferedPlaybackMs: Int,
                            msSinceLastModelAudio: Int, turnCompleteSeen: Bool, rms: NativeLiveRms, at date: Date) {
        var record: [String: Any] = [
            "event": "live_interrupted",
            "timestamp": ISO8601DateFormatter().string(from: date),
            "liveSessionId": sessionID,
            "phase": phase.rawValue,
            "bufferedPlaybackMs": bufferedPlaybackMs,
            "msSinceLastModelAudio": msSinceLastModelAudio,
            "turnCompleteSeen": turnCompleteSeen,
        ]
        record[phase == .pre ? "preRms" : "postRms"] =
            ["mean": Double(rms.mean), "max": Double(rms.max), "speechBuffers": rms.speechBuffers]
        append(record)
    }

    /// P2-R1: one metadata-only `playback_overflow_flush` line: the playback memory guard dropped
    /// the queued turn. Numbers and the session id only, never audio, text or a device label.
    func appendPlaybackOverflow(sessionID: String, queuedMs: Int, buffers: Int) {
        append([
            "event": "playback_overflow_flush",
            "liveSessionId": sessionID,
            "queuedMs": queuedMs,
            "buffers": buffers,
        ])
    }

    /// Contract C1: one metadata-only `wait_cue` line per cue played: ISO time (added by `append`),
    /// session id, milliseconds since the queue drained and the cue index 1...3. Numbers only.
    func appendWaitCue(sessionID: String, msSinceDrain: Int, index: Int) {
        append([
            "event": "wait_cue",
            "liveSessionId": sessionID,
            "msSinceDrain": msSinceDrain,
            "index": index,
        ])
    }

    private func write(_ record: [String: Any]) {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if handle == nil {
                if !FileManager.default.fileExists(atPath: fileURL.path) {
                    guard FileManager.default.createFile(atPath: fileURL.path, contents: nil,
                        attributes: [.posixPermissions: 0o600]) else { return }
                }
                handle = try FileHandle(forWritingTo: fileURL)
            }
            guard let handle else { return }
            try handle.seekToEnd()
            var line = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            line.append(10)
            try handle.write(contentsOf: line)
        } catch { /* Logging must never change capture or session state. */ }
    }
}
