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

/// One playback receipt the app forwards to the host over the live socket the call already holds:
/// the six moments of one segment, each stamped with the process clock and the app's launch identity.
/// A closed vocabulary, ids and counts only: never audio, text, a device label or a provider payload.
struct NativePlaybackReceipt: Sendable, Equatable {
    enum Kind: String, Sendable, CaseIterable {
        case received, enqueued, started, drained, interrupted, terminated
    }
    let kind: Kind
    let segmentSeq: Int
    let sourceInstanceID: String
    let sourceSeq: Int
    let monoMs: Int
    let wallMs: Int
    /// Closed termination reason, present only on `interrupted` and `terminated`.
    let reason: String?

    /// The bounded wire frame the host validates. The keys are the O1a ingestion field names, and
    /// nothing is ever added to this object beyond them.
    var json: String {
        var frame: [String: Any] = [
            "type": "playback_receipt", "receipt": kind.rawValue, "segment_seq": segmentSeq,
            "source_instance_id": sourceInstanceID, "source_seq": sourceSeq,
            "mono_ms": monoMs, "wall_ms": wallMs,
        ]
        if let reason { frame["reason"] = reason }
        guard let data = try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// One process clock, one launch identity and one ordering sequence per stream. Every native line
/// carries all of them, so a native record joins a host record without a one-second guess and two
/// native records in the same second still order. Never subtract a native monotonic value from a
/// host one: they are separate clock domains.
final class NativeLogClock: @unchecked Sendable {
    static let shared = NativeLogClock()
    /// One id per app launch. The same id names every line both native journals write.
    let sourceInstanceID: String
    private let lock = NSLock()
    private var next: [String: Int] = [:]
    private let startedAt = DispatchTime.now().uptimeNanoseconds

    init(sourceInstanceID: String = UUID().uuidString.lowercased()) { self.sourceInstanceID = sourceInstanceID }

    /// Milliseconds on this process's monotonic clock, unaffected by a wall-clock adjustment.
    func monoMs() -> Int { Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000) }

    /// Strictly increasing per stream: the live journal, the audio journal and the forwarded receipt
    /// channel each count on their own, so a forwarded receipt sequence stays dense.
    func nextSequence(_ stream: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let value = (next[stream] ?? 0) + 1
        next[stream] = value
        return value
    }

    /// Wall ms with sub-second precision: `2026-10-18T16:19:05.123Z`.
    static func wallText(_ date: Date) -> String { iso.string(from: date) }
    static func wallMs(_ date: Date) -> Int { Int((date.timeIntervalSince1970 * 1000).rounded()) }
    /// ISO8601 formatting is documented thread-safe; one formatter is shared to keep a log line cheap.
    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// The identity and clock fields every native line carries, plus the next sequence for its stream.
    func stamp(_ stream: String, at date: Date = Date()) -> [String: Any] {
        ["timestamp": Self.wallText(date), "wall_ms": Self.wallMs(date), "mono_ms": monoMs(),
         "source_instance_id": sourceInstanceID, "source_seq": nextSequence(stream)]
    }
}

/// 5 MiB per file with two rotations, the shape host.log already uses: `<name>`, `<name>.1`,
/// `<name>.2`, and the oldest file is unlinked at the third rotation. A test can rotate by passing a
/// small `limit`. A write never throws into a call path and never changes capture or session state.
struct NativeLogFile {
    static let limit = 5 * 1024 * 1024
    private let fileURL: URL?
    private let limit: Int
    private var handle: FileHandle?

    init(_ fileURL: URL?, limit: Int = NativeLogFile.limit) {
        self.fileURL = fileURL
        self.limit = limit
    }

    mutating func append(_ data: Data) {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if handle == nil { handle = try Self.open(fileURL) }
            guard let open = handle else { return }
            if Int(try open.seekToEnd()) + data.count > limit {
                try open.close(); handle = nil
                try Self.rotate(fileURL)
                handle = try Self.open(fileURL)
            }
            try handle?.write(contentsOf: data)
        } catch { /* Logging never changes capture or session state. */ }
    }

    private static func open(_ url: URL) throws -> FileHandle {
        if !FileManager.default.fileExists(atPath: url.path) {
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown)
            }
        }
        return try FileHandle(forWritingTo: url)
    }

    private static func rotate(_ url: URL) throws {
        let manager = FileManager.default
        let older = url.appendingPathExtension("2"), previous = url.appendingPathExtension("1")
        if manager.fileExists(atPath: older.path) { try manager.removeItem(at: older) }
        if manager.fileExists(atPath: previous.path) { try manager.moveItem(at: previous, to: older) }
        try manager.moveItem(at: url, to: previous)
    }
}

/// Append-only JSON-lines writer for native-live.log. Every record carries a fractional wall time,
/// the process monotonic clock, the launch identity and a per-instance sequence, plus the closed
/// reason and its numeric detail. A test or a proof build can pass no URL and read `events` instead.
/// Writing never throws into a call path and never changes capture or session state.
final class NativeLiveJournal {
    private let now: () -> Date
    private var file: NativeLogFile
    private(set) var events: [[String: Any]] = []
    /// The live session this journal is inside, if any: every line written meanwhile carries its id.
    var sessionID: String?

    init(fileURL: URL?, now: @escaping () -> Date = Date.init, limit: Int = NativeLogFile.limit) {
        self.file = NativeLogFile(fileURL, limit: limit)
        self.now = now
    }

    func append(_ reason: NativeLiveEndReason, detail: [String: Any] = [:]) {
        append(reason, detail: detail, at: now())
    }

    func append(_ reason: NativeLiveEndReason, detail: [String: Any] = [:], at date: Date) {
        var record: [String: Any] = detail
        record["event"] = "live_end"
        record["reason"] = reason.rawValue
        append(record, at: date)
    }

    /// Append any existing native-live record, stamped now.
    func append(_ record: [String: Any]) { append(record, at: now()) }

    /// Append any existing native-live record. Every line gets the launch identity, both clocks, a
    /// sequence and, inside a call, the session id; a caller's own timestamp is kept. One line costs
    /// exactly one sequence number, so the range a reader sees has no free gaps.
    func append(_ record: [String: Any], at date: Date) {
        var fields = record
        var stamp = NativeLogClock.shared.stamp("native-live", at: date)
        if let sessionID, fields["liveSessionId"] == nil { fields["liveSessionId"] = sessionID }
        for (key, value) in fields { stamp[key] = value }
        events.append(stamp)
        write(stamp)
    }

    /// E1: one metadata-only `live_interrupted` line. Numbers, a boolean and the session id only,
    /// never audio, text, a device label or a provider payload.
    func appendInterruption(phase: NativeLiveInterruptionPhase, sessionID: String, bufferedPlaybackMs: Int,
                            msSinceLastModelAudio: Int, turnCompleteSeen: Bool, rms: NativeLiveRms, at date: Date) {
        var record: [String: Any] = [
            "event": "live_interrupted",
            "timestamp": NativeLogClock.wallText(date),
            "liveSessionId": sessionID,
            "phase": phase.rawValue,
            "bufferedPlaybackMs": bufferedPlaybackMs,
            "msSinceLastModelAudio": msSinceLastModelAudio,
            "turnCompleteSeen": turnCompleteSeen,
        ]
        record[phase == .pre ? "preRms" : "postRms"] =
            ["mean": Double(rms.mean), "max": Double(rms.max), "speechBuffers": rms.speechBuffers]
        append(record, at: date)
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
        guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        file.append(data + Data([10]))
    }
}
