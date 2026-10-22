import AVFoundation
import Foundation

/// Issue #529: Vicuna's gentle connecting ring. The pair timing, the 1.8 s repeat, the stale
/// start a stop outruns, and a warm unmute that plays nothing are all asserted with no engine,
/// no microphone and no audio device.
@main struct ConnectingRingTests {
    static func main() {
        do {
            try run()
            print("PASS connecting ring: E5/A5 pair, 1.8 s repeat, stale start dropped, no ring for muted to live")
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

        let first = pitch(samples, onset: 0)
        try require(abs(first - 659.25) < 3, "the first note is E5 659.25 Hz, got \(first)")
        let second = pitch(samples, onset: ConnectingRingTone.secondOnset)
        try require(abs(second - 880) < 3, "the second note is A5 880 Hz, got \(second)")

        // The one native record per ring.
        let record = ConnectingRingRecord(startedAt: 1_700_000_000_000,
                                          stoppedAt: 1_700_000_004_000, reason: "live")
        try require(record.ms == 4000, "the record counts the ring's length, got \(record.ms)")
        try require(record.fields["event"] as? String == "connecting_ring", "the record names itself")
        try require(record.fields["reason"] as? String == "live", "the record names the ending state")
        try require(record.fields["started_at"] as? Int == 1_700_000_000_000,
            "the record carries the start")
        try require(record.fields["stopped_at"] as? Int == 1_700_000_004_000,
            "the record carries the stop")
    }

    /// Positive-going zero crossings over the middle 100 ms of a note, which is its pitch.
    static func pitch(_ samples: [Float], onset: Int) -> Double {
        let start = onset + ConnectingRingTone.noteFrames / 4
        let frames = ConnectingRingTone.noteFrames / 2
        var crossings = 0
        var previous = samples[start]
        for index in (start + 1)..<(start + frames) {
            if previous <= 0, samples[index] > 0 { crossings += 1 }
            previous = samples[index]
        }
        return Double(crossings) / (Double(frames) / ConnectingRingTone.sampleRate)
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
