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
func replay(_ schedule: [PlaybackChunk]) -> (underruns: Int, starts: Int, pauses: Int) {
    var queue = NativePlaybackQueue()
    var ends: [Int] = []
    var underruns = 0, starts = 0, pauses = 0
    let frameRate = NativePlaybackQueue.frameRate
    for chunk in schedule {
        while let first = ends.first, first <= chunk.atMs {
            ends.removeFirst()
            if queue.playedBack(atMs: first) { pauses += 1 }
        }
        let arrival = queue.arrival(frames: chunk.frames, atMs: chunk.atMs)
        if arrival.underrun { underruns += 1 }
        if arrival.start { starts += 1 }
        let previous = ends.last ?? chunk.atMs
        ends.append(max(chunk.atMs, previous) + chunk.frames * 1000 / frameRate)
    }
    while let first = ends.first {
        ends.removeFirst()
        if queue.playedBack(atMs: first) { pauses += 1 }
    }
    return (underruns, starts, pauses)
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
        try require(result.underruns == recorded.starvedTurns,
            "recorded schedule counted \(result.underruns) underruns, expected \(recorded.starvedTurns)")

        // Bursts with a real pause between them: the drain is a pause, not a glitch.
        let bursts = (0..<6).flatMap { turn in
            (0..<4).map { PlaybackChunk(atMs: turn * 12000 + $0 * 50, frames: 48000) }
        }
        let quiet = replay(bursts)
        try require(quiet.underruns == 0, "burst/pause schedule counted \(quiet.underruns) underruns")
        try require(quiet.pauses == 6, "burst/pause schedule drained \(quiet.pauses) times, expected 6")
        try require(quiet.starts == 6, "burst/pause schedule re-armed \(quiet.starts) times, expected once per burst")

        // A queue that ran dry and is refilled after a pause re-arms the prebuffer and is not a glitch.
        var queue = NativePlaybackQueue()
        let first = queue.arrival(frames: 48000, atMs: 0)
        try require(first.start && !first.underrun, "first chunk must start playback, not starve it")
        try require(queue.playedBack(atMs: 2000), "the queue drains after the burst plays out")
        let paused = queue.arrival(frames: 48000, atMs: 8000)
        try require(paused.start, "a refill after a pause re-arms the prebuffer")
        try require(!paused.underrun, "a refill after a pause is a pause, not an underrun")
        try require(paused.sinceLastChunkMs == 8000, "chunk timing is recorded for the underrun line")

        // A refill within the pause threshold is a real starvation.
        var tight = NativePlaybackQueue()
        _ = tight.arrival(frames: 12000, atMs: 0)
        try require(tight.playedBack(atMs: 500), "the short chunk drains")
        let starved = tight.arrival(frames: 12000, atMs: 600)
        try require(starved.underrun, "a refill within the pause threshold is a real underrun")
        try require(starved.queuedMs == 500, "the drained burst length is recorded, got \(starved.queuedMs)")
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
