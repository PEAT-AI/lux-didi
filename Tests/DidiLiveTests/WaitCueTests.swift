import Foundation

/// Contract C1: replay a wait-cue event sequence through the pure scheduler. Only timestamps are
/// fed in; no clock, no engine and no audio device is started.
@main struct WaitCueTests {
    static func main() {
        do {
            try run()
            print("PASS wait cue: fires 4 s after drain, 6 s apart, max 3, cancelled by audio, barge-in or a fresh turn")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func run() throws {
        // A tool marker arms the wait; the cue only becomes due once the playback queue has drained.
        var s = NativeWaitCueScheduler()
        try require(s.apply(.toolMarker(atMs: 0)).isEmpty, "a tool marker alone must not schedule a cue")
        try require(s.apply(.drained(atMs: 1000)) == [5000, 11000, 17000],
            "cues must fire at drain + 4 s then every 6 s, max 3")

        // Never before the drain, and never before drain + 4 s.
        var early = NativeWaitCueScheduler()
        _ = early.apply(.toolMarker(atMs: 0))
        let times = early.apply(.drained(atMs: 4000))
        try require(times.allSatisfy { $0 >= 8000 }, "no cue may fire before drain + 4 s, got \(times)")

        // Model audio at 3.9 s cancels the waiting cue.
        var cancelled = NativeWaitCueScheduler()
        _ = cancelled.apply(.toolMarker(atMs: 0))
        _ = cancelled.apply(.drained(atMs: 0))
        try require(cancelled.apply(.modelAudio(atMs: 3900)).isEmpty, "model audio at 3.9 s must cancel the cue")
        try require(cancelled.apply(.drained(atMs: 20000)).isEmpty,
            "a later drain must not cue again without a fresh tool marker")

        // A barge-in cancels the wait.
        var barge = NativeWaitCueScheduler()
        _ = barge.apply(.toolMarker(atMs: 0))
        _ = barge.apply(.drained(atMs: 0))
        try require(barge.apply(.interrupted(atMs: 2500)).isEmpty, "a barge-in must cancel the cue")

        // The answer arriving during a playing cue stops the cue only: no further cues, and the
        // three permitted times were capped at three with 6 s spacing.
        var playing = NativeWaitCueScheduler()
        _ = playing.apply(.toolMarker(atMs: 0))
        let scheduled = playing.apply(.drained(atMs: 0))
        try require(scheduled == [4000, 10000, 16000], "a wait schedules exactly three cues 6 s apart, got \(scheduled)")
        try require(scheduled.count == NativeWaitCueScheduler.maximumCues, "the wait caps at three cues")
        try require(playing.apply(.modelAudio(atMs: 4200)).isEmpty, "the answer stopping a playing cue must not reschedule it")

        // A fresh tool marker after cancellation re-arms the wait.
        var rearmed = NativeWaitCueScheduler()
        _ = rearmed.apply(.modelAudio(atMs: 0))
        _ = rearmed.apply(.toolMarker(atMs: 1000))
        try require(rearmed.apply(.drained(atMs: 2000)) == [6000, 12000, 18000],
            "a fresh tool marker re-arms the wait")

        // The cue itself: two short notes, about 350 ms, 20 ms fades, about -26 dBFS, 24 kHz mono.
        let samples = NativeWaitCue.samples()
        try require(samples.count == NativeWaitCue.totalFrames, "the cue is 350 ms at 24 kHz, got \(samples.count)")
        try require(abs((samples.max() ?? 0) - NativeWaitCue.amplitude) < 0.005,
            "the cue peaks near -26 dBFS (\(NativeWaitCue.amplitude))")
        try require(abs(samples[0]) < 0.001 && abs(samples[samples.count - 1]) < 0.001,
            "the cue starts and ends in a fade at silence")
        try require(abs(samples[NativeWaitCue.noteFrames / 2]) > 0.01, "the first note carries the cue")
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
