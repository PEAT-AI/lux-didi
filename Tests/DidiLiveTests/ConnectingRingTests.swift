import AVFoundation
import Foundation

/// Issue #529: Vicuna's gentle connecting ring. The pair timing, the 1.8 s repeat, the stale
/// start a stop outruns, and a warm unmute that plays nothing are all asserted with no engine,
/// no microphone and no audio device.
@main struct ConnectingRingTests {
    static func main() async {
        do {
            try run()
            try await MainActor.run { try runWiring() }
            print("PASS connecting ring: E5/A5 pair, 1.8 s repeat, stale start dropped, no ring for muted to live, connected chime after the ramp")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func run() throws {
        // Example 1: connecting for 4.0 s then live. The loop repeats the pair every 1.8 s, so the
        // pairs land at 0, 1.8 and 3.6 s, and live ramps it out with 4000 ms on the record.
        var s = ConnectingRingDirector()
        try require(s.transition(to: .connecting, failed: false, atMs: 0) == .beginStart(1),
            "entering connecting asks for a start")
        try require(s.commitStart(1) == .play, "the current start plays the loop")
        try require(s.transition(to: .live, failed: false, atMs: 4000) == .rampDown(reason: "live", ms: 4000),
            "live stops the ring and the record carries the length")

        // Example 2: connecting then failure to cold stops the ring, named as the failure.
        var failed = ConnectingRingDirector()
        _ = failed.transition(to: .connecting, failed: false, atMs: 0)
        _ = failed.commitStart(1)
        try require(failed.transition(to: .cold, failed: true, atMs: 900) == .rampDown(reason: "failed", ms: 900),
            "a failed connect stops the ring")
        try require(failed.transition(to: .cold, failed: true, atMs: 1000) == .none,
            "a second cold transition has no ring to stop")

        // Example 3: a stop that lands while the start is still preparing. The token that a stop
        // outran must never play, and a later connect starts a fresh generation.
        var stale = ConnectingRingDirector()
        let begun = stale.transition(to: .connecting, failed: false, atMs: 0)
        guard case .beginStart(let token) = begun else {
            throw NSError(domain: "connecting must ask for a start, got \(begun)", code: 1)
        }
        try require(stale.transition(to: .live, failed: false, atMs: 40) == .none,
            "nothing is audible yet, so there is nothing to ramp")
        try require(stale.commitStart(token) == .discard, "a start that a stop outran plays nothing")
        let again = stale.transition(to: .connecting, failed: false, atMs: 5000)
        guard case .beginStart(let freshToken) = again, freshToken != token else {
            throw NSError(domain: "a fresh connect must start a new generation, got \(again)", code: 1)
        }
        try require(stale.commitStart(freshToken) == .play, "the fresh start plays")

        // Example 4: a warm unmute from muted to live never went through connecting, so no ring.
        var warm = ConnectingRingDirector()
        try require(warm.transition(to: .hotMuted, failed: false, atMs: 0) == .none,
            "muting never starts the ring")
        try require(warm.transition(to: .live, failed: false, atMs: 100) == .none,
            "a warm unmute without connecting plays nothing")
        try require(warm.transition(to: .connecting, failed: false, atMs: 200) == .beginStart(1),
            "the first real connect still starts the ring")

        // Example 5: the rendered loop. Two notes of 200 ms at 659.25 and 880 Hz, a 120 ms gap,
        // sine plus a triangle at 10 percent, peak at most 0.12.
        let samples = ConnectingRingTone.samples()
        try require(samples.count == ConnectingRingTone.loopFrames, "the loop is 1800 ms at 24 kHz, got \(samples.count)")
        try require(ConnectingRingTone.loopMs == 1800, "the pair repeats every 1800 ms")
        try require(ConnectingRingTone.noteFrames == 4800 && ConnectingRingTone.gapFrames == 2880,
            "each note is 200 ms and the gap is 120 ms")
        try require(ConnectingRingTone.secondOnset == 7680, "the second note starts 320 ms in")

        let peak = samples.map { abs($0) }.max() ?? 0
        try require(peak <= 0.12 + 0.0001, "the peak stays at or under 0.12, got \(peak)")
        try require(abs(samples[0]) < 0.001, "the first note fades in from silence")
        try require(abs(samples[ConnectingRingTone.noteFrames - 1]) < 0.001, "the first note fades out to silence")

        let gap = samples[ConnectingRingTone.noteFrames..<ConnectingRingTone.secondOnset]
        try require((gap.map { abs($0) }.max() ?? 0) < 0.0001, "the 120 ms gap is silent")

        let tail = samples[(ConnectingRingTone.secondOnset + ConnectingRingTone.noteFrames)...]
        try require((tail.map { abs($0) }.max() ?? 0) < 0.0001, "the rest of the loop is silent")

        // The exact constants, so the numbers are pinned even if a buffer gained tolerance.
        try require(ConnectingRingTone.firstTone == 659.25, "the first note is exactly E5 659.25 Hz")
        try require(ConnectingRingTone.secondTone == 880, "the second note is exactly A5 880 Hz")
        try require(ConnectingRingTone.triangleMix == 0.10, "the triangle mixes in at 10 percent")
        try require(ConnectingRingTone.stopRampMs == 30, "the stop ramps down over 30 ms")

        let first = pitch(samples, onset: 0)
        try require(abs(first - 659.25) < 0.5, "the first note is E5 659.25 Hz, got \(first)")
        let second = pitch(samples, onset: ConnectingRingTone.secondOnset)
        try require(abs(second - 880) < 0.5, "the second note is A5 880 Hz, got \(second)")

        // The connected chime, copied from Vicuna's playConnected: 440 then 550 Hz, 100 ms each
        // with a 50 ms gap, peak 0.15 and a 15 ms linear fade.
        let chime = ConnectingChimeTone.samples()
        try require(chime.count == 6000, "the chime is 250 ms at 24 kHz, got \(chime.count)")
        try require(ConnectingChimeTone.firstTone == 440 && ConnectingChimeTone.secondTone == 550,
            "the chime notes are exactly 440 and 550 Hz")
        try require(ConnectingChimeTone.noteMs == 100 && ConnectingChimeTone.gapMs == 50,
            "each tone is 100 ms and the gap is 50 ms")
        try require(ConnectingChimeTone.peak == 0.15 && ConnectingChimeTone.fadeMs == 15,
            "the chime gain is 0.15 with a 15 ms fade")
        try require(ConnectingChimeTone.noteFrames == 2400 && ConnectingChimeTone.gapFrames == 1200
            && ConnectingChimeTone.secondOnset == 3600, "the chime timing in frames is pinned")
        let chimePeak = chime.map { abs($0) }.max() ?? 0
        try require(chimePeak <= 0.15 + 0.0001 && chimePeak > 0.14,
            "the chime peak stays at 0.15, got \(chimePeak)")
        let chimeGap = chime[ConnectingChimeTone.noteFrames..<ConnectingChimeTone.secondOnset]
        try require((chimeGap.map { abs($0) }.max() ?? 0) < 0.0001, "the 50 ms gap is silent")
        try require(abs(chime[0]) < 0.0001, "the chime starts at zero, so it cannot click")
        let early = chime[0..<(ConnectingChimeTone.fadeFrames / 2)].map { abs($0) }.max() ?? 0
        try require(early <= ConnectingChimeTone.peak * 0.5 + 0.0001,
            "the 15 ms fade in holds the first half-fade under half the peak, got \(early)")
        try require(abs(chime[ConnectingChimeTone.noteFrames - 1]) < 0.0001,
            "each tone ends at zero, so it cannot click")
        try require(abs(chime[ConnectingChimeTone.totalFrames - 1]) < 0.0001,
            "the chime ends silent")
        let chimeFirst = pitch(chime, onset: 0, frames: ConnectingChimeTone.noteFrames)
        try require(abs(chimeFirst - 440) < 0.5, "the first chime tone is 440 Hz, got \(chimeFirst)")
        let chimeSecond = pitch(chime, onset: ConnectingChimeTone.secondOnset,
                                frames: ConnectingChimeTone.noteFrames)
        try require(abs(chimeSecond - 550) < 0.5, "the second chime tone is 550 Hz, got \(chimeSecond)")

        // The one native record per ring.
        let record = ConnectingRingRecord(startedAt: 1_700_000_000_000,
                                          stoppedAt: 1_700_000_004_000, reason: "live",
                                          played: true, chime: true)
        try require(record.ms == 4000, "the record counts the ring's length, got \(record.ms)")
        try require(record.fields["played"] as? Bool == true && record.fields["chime"] as? Bool == true,
            "the record says the ring and the chime actually played")
        try require(record.fields["event"] as? String == "connecting_ring", "the record names itself")
        try require(record.fields["reason"] as? String == "live", "the record names the ending state")
        try require(record.fields["started_at"] as? Int == 1_700_000_000_000,
            "the record carries the start")
        try require(record.fields["stopped_at"] as? Int == 1_700_000_004_000,
            "the record carries the stop")
    }

    /// The same presence transitions through the real entry point, with a fake clock and a fake
    /// output, so the play, the ramp and the record are pinned and not just the director's return.
    @MainActor static func runWiring() throws {
        // Example 1: connecting for 4.0 s then live plays once, ramps once over 30 ms, and leaves
        // one record with 4000 ms.
        let clock = TestClock()
        let output = RecordingRingOutput()
        var records: [[String: Any]] = []
        let ring = ConnectingRing(output: output, now: { clock.ms }, deferStart: { body in body() })
        ring.receipt = { records.append($0) }
        ring.presenceChanged(.connecting, failed: false)
        try require(output.plays == 1, "connecting starts the loop once, got \(output.plays)")
        clock.ms = 4000
        ring.presenceChanged(.live, failed: false)
        try require(output.ramps == [ConnectingRingTone.stopRampMs],
            "live ramps the ring out over 30 ms, got \(output.ramps)")
        try require(records.count == 1, "one ring leaves one record, got \(records.count)")
        try require(records[0]["event"] as? String == "connecting_ring", "the record names itself")
        try require(records[0]["ms"] as? Int == 4000,
            "the record counts 4000 ms, got \(String(describing: records[0]["ms"]))")
        try require(records[0]["reason"] as? String == "live", "the record names live")
        try require(records[0]["started_at"] as? Int == 0 && records[0]["stopped_at"] as? Int == 4000,
            "the record carries the start and the stop")
        try require(output.chimes == 1, "live plays the connected chime once, got \(output.chimes)")
        try require(output.order == ["ring", "ramp", "chime"],
            "the chime follows the ring's ramp, got \(output.order)")
        try require(records[0]["played"] as? Bool == true, "the record says the ring played")
        try require(records[0]["chime"] as? Bool == true, "the record says the chime played")

        // Example 2: connecting then failure to cold ramps out with reason failed.
        let failedClock = TestClock()
        let failedOutput = RecordingRingOutput()
        var failedRecords: [[String: Any]] = []
        let failedRing = ConnectingRing(output: failedOutput, now: { failedClock.ms },
                                        deferStart: { body in body() })
        failedRing.receipt = { failedRecords.append($0) }
        failedRing.presenceChanged(.connecting, failed: false)
        failedClock.ms = 900
        failedRing.presenceChanged(.cold, failed: true)
        try require(failedOutput.ramps == [ConnectingRingTone.stopRampMs],
            "the failed connect ramps the ring out")
        try require(failedRecords.first?["reason"] as? String == "failed",
            "the record names the failure, got \(String(describing: failedRecords.first?["reason"]))")
        try require(failedRecords.first?["ms"] as? Int == 900, "the failed ring is 900 ms")
        try require(failedOutput.chimes == 0, "a failed connect plays no chime")
        try require(failedRecords.first?["chime"] as? Bool == false &&
                    failedRecords.first?["played"] as? Bool == true,
            "the failed ring played and chimed nothing")

        // Example 3: a stop that lands while the start is still preparing never reaches the output.
        let staleClock = TestClock()
        let staleOutput = RecordingRingOutput()
        var held: (@MainActor () -> Void)?
        var staleRecords: [[String: Any]] = []
        let staleRing = ConnectingRing(output: staleOutput, now: { staleClock.ms },
                                       deferStart: { body in held = body })
        staleRing.receipt = { staleRecords.append($0) }
        staleRing.presenceChanged(.connecting, failed: false)
        staleClock.ms = 40
        staleRing.presenceChanged(.live, failed: false)
        held?()
        try require(staleOutput.plays == 0, "a start that a stop outran never reaches the output")
        try require(staleOutput.ramps.isEmpty, "nothing was audible, so nothing ramps")
        try require(staleRecords.isEmpty, "a ring that never played leaves no record")

        // Example 4: muted to live never starts the ring and leaves no record.
        let warmClock = TestClock()
        let warmOutput = RecordingRingOutput()
        var warmRecords: [[String: Any]] = []
        let warmRing = ConnectingRing(output: warmOutput, now: { warmClock.ms },
                                      deferStart: { body in body() })
        warmRing.receipt = { warmRecords.append($0) }
        warmRing.presenceChanged(.hotMuted, failed: false)
        warmClock.ms = 100
        warmRing.presenceChanged(.live, failed: false)
        try require(warmOutput.plays == 0 && warmOutput.ramps.isEmpty, "a warm unmute plays nothing")
        try require(warmOutput.chimes == 0, "a warm unmute plays no connected chime")
        try require(warmRecords.isEmpty, "a warm unmute leaves no record")

        // Example 5: the ring's own player refuses to start, so the record says it never played.
        let deafClock = TestClock()
        let deafOutput = RecordingRingOutput()
        deafOutput.playResult = false
        var deafRecords: [[String: Any]] = []
        let deafRing = ConnectingRing(output: deafOutput, now: { deafClock.ms },
                                      deferStart: { body in body() })
        deafRing.receipt = { deafRecords.append($0) }
        deafRing.presenceChanged(.connecting, failed: false)
        deafClock.ms = 1200
        deafRing.presenceChanged(.live, failed: false)
        try require(deafRecords.count == 1 && deafRecords[0]["played"] as? Bool == false,
            "a ring whose player refused to start records played=false")
        try require(deafOutput.chimes == 1 && deafRecords[0]["chime"] as? Bool == true,
            "the connected chime does not depend on the ring's own start")

        // Example 6: the chime's engine refuses to start, so the record says the chime did not play.
        let muteClock = TestClock()
        let muteOutput = RecordingRingOutput()
        muteOutput.chimeResult = false
        var muteRecords: [[String: Any]] = []
        let muteRing = ConnectingRing(output: muteOutput, now: { muteClock.ms },
                                      deferStart: { body in body() })
        muteRing.receipt = { muteRecords.append($0) }
        muteRing.presenceChanged(.connecting, failed: false)
        muteClock.ms = 500
        muteRing.presenceChanged(.live, failed: false)
        try require(muteRecords.count == 1 && muteRecords[0]["chime"] as? Bool == false,
            "a chime that could not play records chime=false")
    }

    /// Stands in for the ring's own player, so no engine and no audio device is started.
    @MainActor final class RecordingRingOutput: ConnectingRingOutput {
        private(set) var plays = 0
        private(set) var chimes = 0
        private(set) var ramps: [Int] = []
        /// The player calls in order, so the chime is proven to follow the ring's ramp.
        private(set) var order: [String] = []
        var playResult = true
        var chimeResult = true
        func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool {
            plays += 1
            order.append("ring")
            return playResult
        }
        func playChime(_ buffer: AVAudioPCMBuffer) -> Bool {
            chimes += 1
            order.append("chime")
            return chimeResult
        }
        func rampDown(overMs ms: Int, after: (@MainActor () -> Void)?) {
            ramps.append(ms)
            order.append("ramp")
            after?()
        }
    }

    @MainActor final class TestClock { var ms = 0 }

    /// The note's pitch from its first and last positive zero crossing, each time interpolated
    /// between the two samples that bracket it, so the estimate is not quantized to 10 Hz.
    static func pitch(_ samples: [Float], onset: Int,
                      frames: Int = ConnectingRingTone.noteFrames) -> Double {
        let end = onset + frames
        var crossings = 0
        var first = 0.0
        var last = 0.0
        var previous = samples[onset]
        for index in (onset + 1)..<end {
            let current = samples[index]
            if previous <= 0, current > 0 {
                let at = Double(index - 1) + Double(-previous) / Double(current - previous)
                crossings += 1
                if crossings == 1 { first = at }
                last = at
            }
            previous = current
        }
        guard crossings > 1, last > first else { return 0 }
        return Double(crossings - 1) / ((last - first) / ConnectingRingTone.sampleRate)
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
