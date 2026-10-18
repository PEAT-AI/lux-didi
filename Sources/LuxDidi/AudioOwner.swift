import AVFoundation
import Darwin
import Foundation

/// Typed refusal from the single audio owner. A second request is refused, never queued
/// behind a running engine.
enum AudioOwnerError: Error, LocalizedError, Equatable {
    /// An engine is already live in this process.
    case alreadyOwned
    /// Another process holds the cross-process lock, or the lock could not be taken.
    case alreadyInUse

    var rawValue: String {
        switch self {
        case .alreadyOwned: return "audio_already_owned"
        case .alreadyInUse: return "audio_already_in_use"
        }
    }
    var errorDescription: String? {
        switch self {
        case .alreadyOwned: return "Live audio is already running. Stop it before starting again."
        case .alreadyInUse: return "Didi's audio is already in use."
        }
    }
    /// Local journal only: no OS or device detail.
    var diagnosticDetail: Int? { nil }
}

/// One timestamped, metadata-only audio lifecycle record. No device label, no PCM. Every
/// record carries a UTC timestamp, so the undated live_precreate_failed records of
/// 2026-10-15 cannot recur.
struct NativeAudioEvent: Equatable {
    let name: String
    /// When the event happened. The journal stamps the wall text, the wall ms and the monotonic ms
    /// from this one date, so a line never mixes two readings of the clock.
    let at: Date
    let fields: [String: String]

    init(name: String, fields: [String: String] = [:], at date: Date = Date()) {
        self.name = name
        self.fields = fields
        self.at = date
    }
}

/// Append-only JSON-lines journal for audio metadata, under the app support dir when a file
/// URL is given. A test can pass no URL and read `events` instead.
@MainActor final class NativeAudioJournal {
    private var file: NativeLogFile
    private(set) var events: [NativeAudioEvent] = []
    var observer: ((NativeAudioEvent) -> Void)?
    /// The live session this journal is inside, if any: every line written meanwhile carries its id.
    var sessionID: String?

    init(fileURL: URL?, limit: Int = NativeLogFile.limit) {
        self.file = NativeLogFile(fileURL, limit: limit)
    }

    func record(_ event: NativeAudioEvent) {
        events.append(event)
        observer?(event)
        var record = event.fields
        record["event"] = event.name
        if let sessionID, record["liveSessionId"] == nil { record["liveSessionId"] = sessionID }
        record.merge(NativeLogClock.shared.stamp("audio", at: event.at)) { current, _ in current }
        guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        file.append(data + Data([10]))
    }
}

/// Process-wide owner for every AVAudioEngine in the app. At most one engine is live at any
/// time: a second request is refused with a typed error, never queued. A non-blocking
/// flock(LOCK_EX | LOCK_NB) on a fixed lock file under the app support dir is taken before any
/// engine is created and released after teardown; the kernel drops it if the process is killed,
/// so a dead Didi can never wedge the Mac's audio.
@MainActor final class AudioOwner {
    static let shared = AudioOwner()

    private let lockFileURL: URL
    private let openLock: (URL) -> Int32
    private let flockFn: (Int32, Int32) -> Int32
    private let closeFn: (Int32) -> Int32
    private(set) var journal: NativeAudioJournal?

    private(set) var holder: ObjectIdentifier?
    private(set) var engineStarts = 0
    private(set) var refusals = 0
    private var lockDescriptor: Int32 = -1

    init(lockFileURL: URL? = nil, journal: NativeAudioJournal? = nil,
         openLock: ((URL) -> Int32)? = nil,
         flockFn: @escaping (Int32, Int32) -> Int32 = { flock($0, $1) },
         closeFn: @escaping (Int32) -> Int32 = { close($0) }) {
        self.lockFileURL = lockFileURL ?? Self.defaultLockFile()
        self.journal = journal
        self.openLock = openLock ?? { target in
            try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            // O_CREAT without a pre-create: FileManager.createFile would replace the inode
            // and leave another process's flock on the old file, so it must not run first.
            return target.path.withCString { open($0, O_RDWR | O_CREAT, mode_t(0o644)) }
        }
        self.flockFn = flockFn
        self.closeFn = closeFn
    }

    var isOwned: Bool { holder != nil }
    var crossProcessHeld: Bool { lockDescriptor >= 0 }
    var hasJournal: Bool { journal != nil }

    /// Production wiring: adopt the app's audio journal once, so every owner record is
    /// timestamped into the same log the device writes.
    func adopt(journal newJournal: NativeAudioJournal) {
        guard journal == nil else { return }
        journal = newJournal
    }

    /// Take the single owner slot and the cross-process lock before creating an engine.
    /// A second request throws instead of waiting behind the running engine.
    func acquire(holder newHolder: ObjectIdentifier) throws {
        if holder != nil {
            refusals += 1
            journal?.record(NativeAudioEvent(name: "audio_refused", fields: ["reason": "already_owned"]))
            throw AudioOwnerError.alreadyOwned
        }
        if lockDescriptor < 0 {
            let descriptor = openLock(lockFileURL)
            if descriptor < 0 || flockFn(descriptor, LOCK_EX | LOCK_NB) != 0 {
                if descriptor >= 0 { _ = closeFn(descriptor) }
                refusals += 1
                journal?.record(NativeAudioEvent(name: "audio_refused", fields: ["reason": "already_in_use"]))
                throw AudioOwnerError.alreadyInUse
            }
            lockDescriptor = descriptor
        }
        holder = newHolder
        journal?.record(NativeAudioEvent(name: "audio_owned"))
    }

    /// Record that the current holder started its one engine for this session.
    func didStartEngine(holder newHolder: ObjectIdentifier) {
        guard holder == newHolder else { return }
        engineStarts += 1
    }

    /// Release the slot and the cross-process lock. Safe to call when not held.
    func release(holder newHolder: ObjectIdentifier) {
        guard holder == newHolder else { return }
        holder = nil
        if lockDescriptor >= 0 { _ = closeFn(lockDescriptor); lockDescriptor = -1 }
        journal?.record(NativeAudioEvent(name: "audio_released"))
    }

    /// Force-release at app termination, regardless of holder.
    @discardableResult
    func releaseAll() -> Bool {
        let wasHeld = holder != nil || lockDescriptor >= 0
        holder = nil
        if lockDescriptor >= 0 { _ = closeFn(lockDescriptor); lockDescriptor = -1 }
        if wasHeld { journal?.record(NativeAudioEvent(name: "audio_released", fields: ["reason": "terminate"])) }
        return wasHeld
    }

    private static func defaultLockFile() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("LuxDidi", isDirectory: true)
            .appendingPathComponent("live-audio.lock")
    }
}
