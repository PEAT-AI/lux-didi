import Foundation

/// #283: the orb band analyzer and the playback-aligned output timeline, fed synthetic PCM only.
/// No engine, no tap, no audio device and no clock.
@main struct OrbEnvelopeTests {
    static func main() {
        do {
            try run()
            print("PASS orb envelope: 10 ms windows, low/mid/high split, onset flux, playback-aligned output, reset")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func pcm(rate: Double, ms: Int, tones: [(hz: Double, amplitude: Double)]) -> Data {
        let count = Int(rate) * ms / 1000
        var data = Data(capacity: count * 2)
        for index in 0..<count {
            let t = Double(index) / rate
            let value = tones.reduce(0) { $0 + $1.amplitude * sin(2 * Double.pi * $1.hz * t) }
            let sample = Int16(max(-32768, min(32767, value * 32767))).littleEndian
            withUnsafeBytes(of: sample) { data.append(contentsOf: $0) }
        }
        return data
    }

    static func run() throws {
        // Windows: 10 ms each, carried across calls (a 20 ms capture frame is two windows).
        var input = NativeOrbAnalyzer(sampleRate: 16000)
        try require(input.windowFrames == 160, "16 kHz windows must be 160 frames, got \(input.windowFrames)")
        try require(input.analyze(pcm(rate: 16000, ms: 20, tones: [(150, 0.3)])).count == 2, "a 20 ms frame must yield two windows")
        var carry = NativeOrbAnalyzer(sampleRate: 24000)
        let half = pcm(rate: 24000, ms: 5, tones: [(150, 0.3)])
        try require(carry.analyze(half).isEmpty && carry.analyze(half).count == 1, "a window must complete across two 5 ms chunks")

        // A 150 Hz vowel-like tone lands in the low band; a 4 kHz sibilant-like tone in the high band.
        var vowel = NativeOrbAnalyzer(sampleRate: 24000)
        let v = vowel.analyze(pcm(rate: 24000, ms: 200, tones: [(150, 0.3)])).last!
        try require(v.low > 3 * v.high && v.low > v.mid, "150 Hz must be low-band dominant, got \(v)")
        try require(abs(v.level - Float(0.3 / 2.0.squareRoot())) < 0.02, "broadband RMS of a 0.3 sine must be ~0.212, got \(v.level)")
        var sibilant = NativeOrbAnalyzer(sampleRate: 24000)
        let s = sibilant.analyze(pcm(rate: 24000, ms: 200, tones: [(4000, 0.3)])).last!
        try require(s.high > 4 * s.low && s.high > s.mid, "4 kHz must be high-band dominant, got \(s)")

        // Flux: an onset after silence rises, a steady tone does not.
        var onset = NativeOrbAnalyzer(sampleRate: 24000)
        _ = onset.analyze(pcm(rate: 24000, ms: 50, tones: []))
        let rise = onset.analyze(pcm(rate: 24000, ms: 10, tones: [(150, 0.3), (1000, 0.1)])).last!
        let steady = onset.analyze(pcm(rate: 24000, ms: 100, tones: [(150, 0.3), (1000, 0.1)])).last!
        try require(rise.flux > 0.5, "an onset after silence must carry flux, got \(rise.flux)")
        try require(steady.flux < 0.05, "a steady tone must carry no flux, got \(steady.flux)")
        let silence = onset.analyze(pcm(rate: 24000, ms: 30, tones: [])).last!
        try require(silence.flux == 0 && silence.level == 0, "silence must be zero, got \(silence)")

        // Timeline: silent before the player starts, the window at the playback position after.
        var timeline = NativeOrbTimeline()
        timeline.append(pcm(rate: 24000, ms: 100, tones: [(150, 0.3)]))
        timeline.append(pcm(rate: 24000, ms: 100, tones: [(4000, 0.3)]))
        try require(timeline.queuedWindows == 20, "200 ms must queue 20 windows, got \(timeline.queuedWindows)")
        try require(timeline.sample(renderedSample: nil) == .silent, "nothing is audible before the player starts")
        var playerClock: Int64? = nil
        try require(timeline.sample(renderedSample: playerClock) == .silent, "a delayed render start stays silent")
        playerClock = 1200
        let early = timeline.sample(renderedSample: 1200)
        try require(timeline.sample(renderedSample: playerClock) == early, "a stalled player clock must not advance bands")
        try require(timeline.sample(renderedSample: 7200, sampleRate: 48000).high > early.high, "player clock uses its own sample rate")
        try require(timeline.sample(renderedSample: 1200, presentationOffsetMs: 100).high > early.high, "presentation offset shifts the rendered position")
        let late = timeline.sample(renderedSample: 3600)
        try require(early.low > early.high, "at 50 ms the vowel chunk is playing, got \(early)")
        try require(late.high > late.low, "at 150 ms the sibilant chunk is playing (render time, not elapsed wall time), got \(late)")
        try require(timeline.sample(renderedSample: 6000) == .silent, "past the scheduled audio the output is silent")
        timeline.reset()
        try require(timeline.sample(renderedSample: 1200) == .silent && timeline.queuedWindows == 0, "reset clears the burst")

        timeline.append(pcm(rate: 24000, ms: 20, tones: [(150, 0.3)]))
        try require(timeline.sample(renderedSample: nil) == .silent, "drain waits for a new render clock")
        try require(timeline.sample(renderedSample: 0).level > 0, "a new burst begins at rendered sample zero")

        // Long bursts: played windows are dropped in blocks and positions stay exact.
        var long = NativeOrbTimeline()
        for chunk in 0..<50 { long.append(pcm(rate: 24000, ms: 100, tones: chunk % 2 == 0 ? [(150, 0.3)] : [(4000, 0.3)])) }
        let atThree = long.sample(renderedSample: 73200)
        try require(long.queuedWindows < 500, "played windows must be dropped, \(long.queuedWindows) still queued")
        let atThreeOne = long.sample(renderedSample: 75600)
        try require(atThree.low > atThree.high && atThreeOne.high > atThreeOne.low,
            "after compaction the 3.0 s chunk is the vowel and 3.1 s the sibilant, got \(atThree) then \(atThreeOne)")
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
