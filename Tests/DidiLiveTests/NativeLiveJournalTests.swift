import Foundation

/// A two-party rendezvous: both test writers reach the append call at the same instant, so the
/// interleaving that a seek-then-write append cannot survive happens on every round.
final class TwoPartyBarrier: @unchecked Sendable {
    private let condition = NSCondition()
    private var arrived = 0
    private var generation = 0
    func wait() {
        condition.lock()
        let mine = generation
        arrived += 1
        if arrived >= 2 {
            generation &+= 1; arrived = 0; condition.broadcast()
        } else {
            while generation == mine { condition.wait() }
        }
        condition.unlock()
    }
}

/// Fake-seam proofs for the closed native-live end reasons, their timestamps, and the
/// diagnostics snapshot fields. No audio device, no supervisor and no network are started.
@main struct NativeLiveJournalTests {
    static func main() {
        var failures = 0
        func expect(_ condition: Bool, _ message: String) {
            if !condition { FileHandle.standardError.write(Data(("FAIL: " + message + "\n").utf8)); failures += 1 }
        }
        func jsonObject(_ line: String) -> [String: Any]? {
            guard let data = line.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return raw
        }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let clock = NativeLogClock.shared

        // 1. Every closed reason writes one live_end line with an ISO timestamp and a closed reason token.
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-live-journal-" + UUID().uuidString)
            let file = directory.appendingPathComponent("native-live.log")
            let journal = NativeLiveJournal(fileURL: file)
            let at = Date(timeIntervalSince1970: 1_761_076_800)
            for reason in NativeLiveEndReason.allCases { journal.append(reason, detail: [:], at: at) }
            guard let text = try? String(contentsOf: file, encoding: .utf8) else { fatalError("journal file missing") }
            let lines = text.split(separator: "\n").map(String.init)
            expect(lines.count == NativeLiveEndReason.allCases.count, "one line per reason, got \(lines.count)")
            for (index, reason) in NativeLiveEndReason.allCases.enumerated() {
                guard let object = jsonObject(lines[index]) else { expect(false, "line \(index) is not JSON"); continue }
                expect(object["event"] as? String == "live_end", "event is live_end for \(reason.rawValue)")
                expect(object["reason"] as? String == reason.rawValue, "reason token is \(reason.rawValue)")
                guard let stamp = object["timestamp"] as? String, let date = iso.date(from: stamp) else {
                    expect(false, "timestamp missing or not ISO8601 for \(reason.rawValue)"); continue
                }
                expect(abs(date.timeIntervalSince(at)) < 1, "timestamp round-trips for \(reason.rawValue)")
                // O1b-N: every line carries the launch identity, both clocks and a sequence.
                expect(Set(object.keys) == ["event", "reason", "timestamp", "wall_ms", "mono_ms", "source_instance_id", "source_seq"],
                    "no extra keys for \(reason.rawValue): \(object.keys.sorted())")
                expect(stamp.contains("."), "wall time keeps fractional seconds for \(reason.rawValue)")
                expect((object["mono_ms"] as? Int) != nil, "mono_ms is a number for \(reason.rawValue)")
                expect(object["source_instance_id"] as? String == clock.sourceInstanceID, "the launch identity is stamped")
                expect(object["source_seq"] as? Int == index + 1, "one sequence per line, strictly increasing")
            }
            try? FileManager.default.removeItem(at: directory)
        }

        // 2. Closed numeric detail only: byte count for invalid_output, status/signal for child_exit.
        do {
            expect(NSDictionary(dictionary: NativeLiveEndDetail.invalidOutput(bytes: 42)) == ["bytes": 42], "invalid_output carries bytes")
            let noSignal = NativeLiveEndDetail.childExit(status: 9, signal: nil)
            expect(NSDictionary(dictionary: noSignal) == ["status": 9], "child_exit carries exit status only")
            let signalled = NativeLiveEndDetail.childExit(status: 0, signal: 15)
            expect(NSDictionary(dictionary: signalled) == ["status": 0, "signal": 15], "child_exit carries status and signal")
        }

        // 2b. C-LIVE N-3: a host-initiated end is its own reason, never user_stop and never provider_closed. The socket
        // the app holds is the host's, so a close on it is host_closed with the code and a closed reason token.
        do {
            let tokens = Set(NativeLiveEndReason.allCases.map(\.rawValue))
            expect(tokens.contains("host_failed") && tokens.contains("host_closed"), "the host end reasons exist")
            expect(!tokens.contains("provider_closed"), "no close on the host socket is called a provider close")
            expect(NSDictionary(dictionary: NativeLiveEndDetail.hostClosed(closeCode: 1011, reason: "provider_recovery_exhausted"))
                == ["closeCode": 1011, "reason": "provider_recovery_exhausted"], "host_closed carries the code and the closed reason")
            expect(NSDictionary(dictionary: NativeLiveEndDetail.hostClosed(closeCode: 1008, reason: "attach_rejected:internal"))
                == ["closeCode": 1008, "reason": "attach_rejected:internal"], "an attach refusal keeps its typed reason")
            expect(NSDictionary(dictionary: NativeLiveEndDetail.hostClosed(closeCode: 1000, reason: "free text from somewhere"))
                == ["closeCode": 1000], "a reason outside the closed shape is dropped")
            expect(NSDictionary(dictionary: NativeLiveEndDetail.hostFailed(code: "resume_failed")) == ["code": "resume_failed"], "host_failed carries the host code")
            expect(NativeLiveEndDetail.hostFailed(code: "Not A Code").isEmpty, "a code outside the closed shape is dropped")
            expect(NativeLiveEndClassifier.terminal(state: "failed", code: "resume_failed") == .hostFailed, "a host failure is host_failed")
            expect(NativeLiveEndClassifier.terminal(state: "failed", code: "provider_recovery_exhausted") == .hostFailed, "an exhausted recovery is host_failed")
            expect(NativeLiveEndClassifier.terminal(state: "failed", code: "session_timeout") == .sessionLimit, "the session limit keeps its reason")
            expect(NativeLiveEndClassifier.terminal(state: "failed", code: "idle_timeout") == .idleLimit, "the idle limit keeps its reason")
            expect(NativeLiveEndClassifier.terminal(state: "closed", code: "voice_stop") == nil, "the owner's voice stop is recorded by the stop itself")
        }


        // 3. Snapshot: live state, audio route with voice processing, connector stage and the age of the last failure.
        do {
            let input = DiagnosticsSnapshotInput(
                appVersion: "1.2.3", releaseCommit: "abc", macOSVersion: "macOS", serviceState: "connected",
                serviceOrigin: "http://127.0.0.1:41231", liveState: "ended", sessionLimit: "30 min", idleLimit: "2 min",
                connections: ["mongoose: error (discovery_failed)"],
                audioRoute: "Input: built-in; Output: built-in", voiceProcessing: false,
                preCreateFailureClass: "audio", preCreateFailureCode: "deviceUnavailable", preCreateFailureAge: "49m",
                capturedAt: "2026-10-15T08:49:00Z")
            let text = NativeDiagnosticsSnapshot.render(input)
            for expected in ["Live: ended", "Voice processing: off", "Input: built-in", "Output: built-in",
                             "mongoose: error (discovery_failed)", "audio/deviceUnavailable", "49m"] {
                expect(text.contains(expected), "snapshot renders \(expected)")
            }
            let empty = NativeDiagnosticsSnapshot.render(DiagnosticsSnapshotInput())
            expect(empty.contains("Live: unknown"), "missing live state reads unknown")
            expect(empty.contains("Voice processing: unknown"), "missing voice processing reads unknown")
        }

        // 4. Age text is deterministic and bounded.
        do {
            let now = Date(timeIntervalSince1970: 1_761_076_800)
            expect(NativeDiagnosticsSnapshot.ageText(since: now.addingTimeInterval(-45), now: now) == "45s", "under a minute reads seconds")
            expect(NativeDiagnosticsSnapshot.ageText(since: now.addingTimeInterval(-2940), now: now) == "49m", "2940 seconds reads 49m")
            expect(NativeDiagnosticsSnapshot.ageText(since: now.addingTimeInterval(-7200), now: now) == "2h", "7200 seconds reads 2h")
            expect(NativeDiagnosticsSnapshot.ageText(since: now, now: now) == "0s", "zero age reads 0s")
        }

        // 5. preCreateFailure also returns the record timestamp so the snapshot can age it.
        do {
            let line = #"{"event":"live_precreate_failed","failureClass":"audio","code":"deviceUnavailable","timestamp":"2026-10-15T08:00:00Z"}"#
            guard let parsed = NativeDiagnosticsSnapshot.preCreateFailure(inLog: line) else { fatalError("preCreateFailure missed the line") }
            expect(parsed.failureClass == "audio", "failureClass parsed")
            expect(parsed.code == "deviceUnavailable", "code parsed")
            expect(parsed.at == "2026-10-15T08:00:00Z", "timestamp parsed")
        }

        // 6. A connector with no operator credential reads `not configured`, never `error` (X4-R2).
        do {
            expect(NativeDiagnosticsSnapshot.connectorLine(id: "mongoose", state: "error", reasonCode: "credential_missing") == "mongoose: not configured", "absent credential reads not configured")
            expect(NativeDiagnosticsSnapshot.connectorLine(id: "mongoose", state: "error", reasonCode: "discovery_failed") == "mongoose: error (discovery_failed)", "other failures keep the stage")
            expect(NativeDiagnosticsSnapshot.connectorLine(id: "calendar", state: "connected", reasonCode: nil) == "calendar: connected", "a healthy connector carries no stage")
        }

        // 7. E1: a provider interruption writes a metadata-only pre line and a post line, numbers only.
        do {
            func numeric(_ value: Any?) -> Bool {
                guard let number = value as? NSNumber else { return false }
                return CFGetTypeID(number) != CFBooleanGetTypeID()
            }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-live-interruption-" + UUID().uuidString)
            let file = directory.appendingPathComponent("native-live.log")
            let journal = NativeLiveJournal(fileURL: file)
            let at = Date(timeIntervalSince1970: 1_761_076_800)
            journal.appendInterruption(phase: .pre, sessionID: "session-abc", bufferedPlaybackMs: 2760,
                msSinceLastModelAudio: 5400, turnCompleteSeen: false,
                rms: NativeLiveRms(mean: 0.021, max: 0.34, speechBuffers: 6), at: at)
            journal.appendInterruption(phase: .post, sessionID: "session-abc", bufferedPlaybackMs: 2760,
                msSinceLastModelAudio: 5400, turnCompleteSeen: false,
                rms: NativeLiveRms(mean: 0.004, max: 0.09, speechBuffers: 1), at: at.addingTimeInterval(5))
            let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            let lines = text.split(separator: "\n").map(String.init)
            expect(lines.count == 2, "one pre line and one post line, got \(lines.count)")
            if lines.count == 2, let pre = jsonObject(lines[0]), let post = jsonObject(lines[1]) {
                expect(pre["event"] as? String == "live_interrupted", "pre line event token")
                expect(pre["liveSessionId"] as? String == "session-abc", "session id present")
                expect(pre["phase"] as? String == "pre", "pre phase token")
                expect(iso.date(from: pre["timestamp"] as? String ?? "") != nil, "pre timestamp is ISO8601")
                expect(numeric(pre["bufferedPlaybackMs"]), "bufferedPlaybackMs is a number")
                expect(numeric(pre["msSinceLastModelAudio"]), "msSinceLastModelAudio is a number")
                expect(pre["turnCompleteSeen"] as? Bool == false, "turnCompleteSeen is a boolean")
                if let rms = pre["preRms"] as? [String: Any] {
                    expect(numeric(rms["mean"]), "preRms.mean is a number")
                    expect(numeric(rms["max"]), "preRms.max is a number")
                    expect(numeric(rms["speechBuffers"]), "preRms.speechBuffers is a number")
                } else { expect(false, "preRms object present") }
                expect(!lines[0].contains("mid sentence") && !lines[0].contains("pcm") && !lines[0].contains("base64"),
                    "no audio or text is carried in the pre line")
                expect(post["event"] as? String == "live_interrupted", "post line event token")
                expect(post["phase"] as? String == "post", "post phase token")
                if let rms = post["postRms"] as? [String: Any] {
                    expect(numeric(rms["mean"]), "postRms.mean is a number")
                    expect(numeric(rms["max"]), "postRms.max is a number")
                    expect(numeric(rms["speechBuffers"]), "postRms.speechBuffers is a number")
                } else { expect(false, "postRms object present") }
            } else { expect(false, "interruption lines are valid JSON") }
        }

        // 4. O1b-N retention: both files rotate at the cap the host log uses, keeping two rotations.
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-live-rotate-" + UUID().uuidString)
            let file = directory.appendingPathComponent("native-live.log")
            let journal = NativeLiveJournal(fileURL: file, limit: 400)
            for index in 1...40 { journal.append(["event": "rotation_fixture", "index": index]) }
            let manager = FileManager.default
            expect(manager.fileExists(atPath: file.path), "the live file keeps the newest line")
            expect(manager.fileExists(atPath: file.path + ".1"), "one rotation is kept")
            expect(manager.fileExists(atPath: file.path + ".2"), "two rotations are kept")
            let sizes = [file.path, file.path + ".1", file.path + ".2"].map {
                (try? manager.attributesOfItem(atPath: $0)[.size] as? Int) ?? 0
            }
            expect(sizes.allSatisfy { $0 <= 400 }, "no file exceeds the cap, got \(sizes)")
            let lines = (try? String(contentsOf: file, encoding: .utf8))?.split(separator: "\n").map(String.init) ?? []
            let newest = lines.last.flatMap(jsonObject)
            expect(newest?["index"] as? Int == 40, "the newest record survives the last rotation")
            try? manager.removeItem(at: directory)
        }

        // 5. O1b-N identity: a line inside a call carries the session id, and the receipt frame is
        //    exactly the closed shape the host validates, with its own dense sequence.
        do {
            let journal = NativeLiveJournal(fileURL: nil)
            journal.sessionID = "session-abc"
            journal.append(["event": "inside_a_call"])
            expect(journal.events.last?["liveSessionId"] as? String == "session-abc", "a line inside a call carries its session id")
            var receipts: [NativePlaybackReceipt] = []
            let first = NativePlaybackReceipt(kind: .received, segmentSeq: 1, sourceInstanceID: clock.sourceInstanceID,
                sourceSeq: clock.nextSequence("receipt"), monoMs: clock.monoMs(), wallMs: NativeLogClock.wallMs(Date()), reason: nil)
            let second = NativePlaybackReceipt(kind: .interrupted, segmentSeq: 1, sourceInstanceID: clock.sourceInstanceID,
                sourceSeq: clock.nextSequence("receipt"), monoMs: clock.monoMs(), wallMs: NativeLogClock.wallMs(Date()), reason: "interrupted")
            receipts = [first, second]
            expect(receipts[1].sourceSeq == receipts[0].sourceSeq + 1, "the receipt stream is dense")
            let wire = jsonObject(receipts[1].json) ?? [:]
            expect(Set(wire.keys) == ["type", "receipt", "segment_seq", "source_instance_id", "source_seq", "mono_ms", "wall_ms", "reason"],
                "the receipt frame is the closed shape, got \(wire.keys.sorted())")
            expect(wire["receipt"] as? String == "interrupted", "the receipt names its moment")
            expect((jsonObject(first.json) ?? [:])["reason"] == nil, "no reason is invented for a plain receipt")
        }

        // 6. #477: two writers appending to one log produce whole lines: no torn record, none lost.
        // The barrier makes both writers seek at the same instant every round, which is exactly the
        // interleaving a seek-then-write append cannot survive and an O_APPEND append always does.
        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("native-journal-two-writers-\(UUID().uuidString)")
            let file = directory.appendingPathComponent("two-writers.log")
            let rounds = 200
            let barrier = TwoPartyBarrier()
            let done = DispatchGroup()
            for writer in 0..<2 {
                DispatchQueue.global().async(group: done) {
                    var log = NativeLogFile(file)
                    for index in 0..<rounds {
                        barrier.wait()
                        let record = ["writer": writer, "index": index,
                                      "pad": String(repeating: "p", count: 96)]
                        let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
                        log.append((data ?? Data()) + Data([10]))
                    }
                }
            }
            done.wait()
            let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            var parsed = Set<String>()
            var torn = 0
            for line in text.split(separator: "\n") {
                guard let object = jsonObject(String(line)), let writer = object["writer"] as? Int,
                      let index = object["index"] as? Int, object["pad"] as? String != nil else { torn += 1; continue }
                parsed.insert("\(writer):\(index)")
            }
            expect(text.split(separator: "\n").count == rounds * 2,
                   "two writers keep \(rounds * 2) lines, got \(text.split(separator: "\n").count)")
            expect(torn == 0, "every appended line is one whole JSON record, got \(torn) torn")
            expect(parsed.count == rounds * 2, "no record is overwritten, got \(parsed.count) distinct")
            try? FileManager.default.removeItem(at: directory)
        }

        if failures == 0 { print("NATIVE-LIVE-JOURNAL PASS") } else { print("NATIVE-LIVE-JOURNAL FAIL \(failures)") }
        exit(failures == 0 ? 0 : 1)
    }
}
