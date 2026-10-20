import Foundation

/// Deterministic replay of a model-audio arrival schedule through the real playback queue.
/// Only timestamps and chunk sizes are fed in; no audio device is started and no capture runs.
struct PlaybackChunk {
    let atMs: Int
    let frames: Int
}

/// Drive `NativePlaybackQueue` with a schedule and report what the device would have counted.
/// A buffer's playback ends when its audio would have played out, so the last buffer of a burst
/// finishes (and drains the queue) before the next burst arrives.
func replay(_ schedule: [PlaybackChunk]) -> (speechGaps: Int, starts: Int, pauses: Int, gaps: [NativePlaybackArrival]) {
    var queue = NativePlaybackQueue()
    var ends: [Int] = []
    var speechGaps = 0, starts = 0, pauses = 0
    var gaps: [NativePlaybackArrival] = []
    let frameRate = NativePlaybackQueue.frameRate
    for chunk in schedule {
        while let first = ends.first, first <= chunk.atMs {
            ends.removeFirst()
            if queue.playedBack(atMs: first) { pauses += 1 }
        }
        let arrival = queue.arrival(frames: chunk.frames, atMs: chunk.atMs)
        if arrival.speechGap { speechGaps += 1; gaps.append(arrival) }
        if arrival.start { starts += 1 }
        let previous = ends.last ?? chunk.atMs
        ends.append(max(chunk.atMs, previous) + chunk.frames * 1000 / frameRate)
    }
    while let first = ends.first {
        ends.removeFirst()
        if queue.playedBack(atMs: first) { pauses += 1 }
    }
    return (speechGaps, starts, pauses, gaps)
}

/// P2-R1: replay the way `write()` schedules audio, flushing only when the queue reaches the
/// playback memory guard. Returns the flush count, the peak queued buffers and the frames
/// scheduled, so a schedule proves whether the guard ever dropped audio.
func replayMemoryGuard(_ schedule: [PlaybackChunk]) -> (flushes: Int, peakBuffers: Int, scheduledFrames: Int) {
    var queue = NativePlaybackQueue()
    var ends: [Int] = []
    var flushes = 0, peak = 0, scheduled = 0
    let frameRate = NativePlaybackQueue.frameRate
    for chunk in schedule {
        while let first = ends.first, first <= chunk.atMs {
            ends.removeFirst()
            _ = queue.playedBack(atMs: first)
        }
        if queue.overflowsMemoryGuard { flushes += 1; queue.flush(); ends.removeAll() }
        _ = queue.arrival(frames: chunk.frames, atMs: chunk.atMs)
        scheduled += chunk.frames
        peak = max(peak, queue.queuedBuffers)
        let previous = ends.last ?? chunk.atMs
        ends.append(max(chunk.atMs, previous) + chunk.frames * 1000 / frameRate)
    }
    return (flushes, peak, scheduled)
}

/// 16:04Z-shaped schedule: 28 turns of ~8 s of speech delivered in a fast burst, then a gap of
/// several seconds to the next turn (a tool wait or the user speaking). Three turns starve
/// mid-utterance: a 500 ms chunk drains, then the next arrives 100 ms later.
func recordedSchedule() -> (schedule: [PlaybackChunk], starvedTurns: Int) {
    var schedule: [PlaybackChunk] = []
    var starved = 0
    var turnStart = 0
    for turn in 0..<28 {
        if turn % 9 == 3 {
            schedule.append(PlaybackChunk(atMs: turnStart, frames: 12000))
            schedule.append(PlaybackChunk(atMs: turnStart + 600, frames: 12000))
            starved += 1
        } else {
            for offset in [0, 50, 100, 150] {
                schedule.append(PlaybackChunk(atMs: turnStart + offset, frames: 48000))
            }
        }
        turnStart += 12000
    }
    return (schedule, starved)
}

@main struct PlaybackSchedulingTests {
    static func main() {
        do {
            try run()
            print("PASS playback scheduling: mid-utterance starvation counted once, pauses and end-of-turn drains not, prebuffer re-armed")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func run() throws {
        let recorded = recordedSchedule()
        let result = replay(recorded.schedule)
        try require(result.speechGaps == recorded.starvedTurns,
            "recorded schedule counted \(result.speechGaps) speech gaps, expected \(recorded.starvedTurns)")
        // H23/V11 (#476): the playback_speech_gap line reports a measured interval, not a placeholder:
        // every counted gap is the real drain-to-arrival gap and the burst it interrupted had audio.
        try require(result.gaps.count == result.speechGaps && result.gaps.allSatisfy { $0.dryGapMs > 0 },
            "every counted speech gap carries a positive measured gap, got \(result.gaps.map(\.dryGapMs))")
        try require(result.gaps.allSatisfy { $0.burstMs > 0 && $0.queuedMs > 0 },
            "every counted gap names the burst that ran dry and the depth behind it")

        // Bursts with a real pause between them: the drain is a pause, not a glitch.
        let bursts = (0..<6).flatMap { turn in
            (0..<4).map { PlaybackChunk(atMs: turn * 12000 + $0 * 50, frames: 48000) }
        }
        let quiet = replay(bursts)
        try require(quiet.speechGaps == 0, "burst/pause schedule counted \(quiet.speechGaps) speech gaps")
        try require(quiet.pauses == 6, "burst/pause schedule drained \(quiet.pauses) times, expected 6")
        try require(quiet.starts == 6, "burst/pause schedule re-armed \(quiet.starts) times, expected once per burst")

        // A queue that ran dry and is refilled after a pause re-arms the prebuffer and is not a glitch.
        var queue = NativePlaybackQueue()
        let first = queue.arrival(frames: 48000, atMs: 0)
        try require(first.start && !first.speechGap, "first chunk must start playback, not starve it")
        try require(queue.playedBack(atMs: 2000), "the queue drains after the burst plays out")
        let paused = queue.arrival(frames: 48000, atMs: 8000)
        try require(paused.start, "a refill after a pause re-arms the prebuffer")
        try require(!paused.speechGap, "a refill after a pause is a pause, not a speech gap")
        try require(paused.sinceLastChunkMs == 8000, "chunk timing is recorded for the speech-gap line")

        // A refill within the pause threshold is a real starvation.
        var tight = NativePlaybackQueue()
        _ = tight.arrival(frames: 12000, atMs: 0)
        try require(tight.playedBack(atMs: 500), "the short chunk drains")
        let starved = tight.arrival(frames: 12000, atMs: 600)
        try require(starved.speechGap, "a refill within the pause threshold is a measured speech gap")
        try require(starved.burstMs == 500, "the drained burst length is recorded as burstMs, got \(starved.burstMs)")
        try require(starved.queuedMs == 500, "a refill states the depth it now holds, got \(starved.queuedMs)")

        // D12-4: the queue reports a real depth. It falls buffer by buffer while the answer plays,
        // never only at the drain, and it is 0 once the burst has drained.
        var live = NativePlaybackQueue()
        var depths: [Int] = []
        for index in 0..<4 {
            let arrival = live.arrival(frames: 24000, atMs: index * 50)   // 1 s of audio per buffer
            if index == 0 { try require(arrival.queuedMs == 1000, "the first chunk states a 1 s depth, got \(arrival.queuedMs)") }
            depths.append(arrival.queuedMs)
        }
        try require(depths == [1000, 2000, 3000, 4000], "the depth is the real backlog, got \(depths)")
        var falling: [Int] = []
        for second in 1...4 {
            falling.append(live.depthMs)
            _ = live.playedBack(atMs: second * 1000)
        }
        try require(falling == [4000, 3000, 2000, 1000], "the depth falls as buffers play, got \(falling)")
        try require(live.depthMs == 0, "the depth is 0 after the drain, got \(live.depthMs)")
        let drainedAfter = live.arrival(frames: 24000, atMs: 9000)
        try require(drainedAfter.queuedMs == 1000 && !drainedAfter.speechGap, "a refill after a pause starts a new depth, not a speech gap")

        // D12-5: every owner action names its own trigger; `other` stays for the app's own stops, and
        // a menu trigger armed for one Stop is consumed by exactly that Stop.
        var latch = LiveStopTriggerLatch()
        for trigger in [LiveStopTrigger.button, .hotkey, .menu] {
            try require(latch.take(trigger) == trigger, "\(trigger.rawValue) reaches the receipt unchanged")
            latch.arm(trigger)
            try require(latch.take(.other) == trigger, "an armed \(trigger.rawValue) is the one the Stop carries")
            try require(latch.take(.other) == .other, "an armed trigger is consumed once")
        }
        try require(LiveStopTrigger.allCases.map(\.rawValue) == ["button", "hotkey", "menu", "other"], "the trigger set is closed")

        // P2-R1: a 22 s answer delivered as 0.34 s host frames inside 2.5 s (Gemini's ~8x
        // realtime) must never reach the 120 s playback memory guard, and the old 24-buffer
        // count cap that dropped it mid-answer must be gone.
        let answer = (0..<65).map { PlaybackChunk(atMs: $0 * 2500 / 65, frames: 8160) }
        let guarded = replayMemoryGuard(answer)
        try require(guarded.flushes == 0, "a 22 s answer hit the memory guard \(guarded.flushes) times, expected 0")
        try require(guarded.scheduledFrames == 65 * 8160, "every frame must be scheduled, got \(guarded.scheduledFrames)")
        try require(guarded.peakBuffers > 24, "the burst must exceed 24 queued buffers, else it cannot prove the old cap dropped audio")
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
