import Foundation

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
                expect(Set(object.keys) == ["event", "reason", "timestamp"], "no extra keys for \(reason.rawValue): \(object.keys.sorted())")
            }
            try? FileManager.default.removeItem(at: directory)
        }

        // 2. Closed numeric detail only: byte count for invalid_output, status/signal for child_exit, close code for provider_closed.
        do {
            expect(NSDictionary(dictionary: NativeLiveEndDetail.invalidOutput(bytes: 42)) == ["bytes": 42], "invalid_output carries bytes")
            let noSignal = NativeLiveEndDetail.childExit(status: 9, signal: nil)
            expect(NSDictionary(dictionary: noSignal) == ["status": 9], "child_exit carries exit status only")
            let signalled = NativeLiveEndDetail.childExit(status: 0, signal: 15)
            expect(NSDictionary(dictionary: signalled) == ["status": 0, "signal": 15], "child_exit carries status and signal")
            expect(NSDictionary(dictionary: NativeLiveEndDetail.providerClosed(closeCode: 1013)) == ["closeCode": 1013], "provider_closed carries the numeric close code")
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

        if failures == 0 { print("NATIVE-LIVE-JOURNAL PASS") } else { print("NATIVE-LIVE-JOURNAL FAIL \(failures)") }
        exit(failures == 0 ? 0 : 1)
    }
}
