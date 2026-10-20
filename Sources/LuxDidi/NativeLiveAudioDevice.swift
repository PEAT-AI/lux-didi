import AVFoundation
import Combine
import CoreAudio
import Foundation


struct NativePCMFrameAssembler {
    private var carry = Data()
    mutating func append(_ data: Data) -> [Data] {
        carry.append(data)
        var frames: [Data] = []
        while carry.count >= 640 {
            frames.append(Data(carry.prefix(640))); carry.removeFirst(640)
        }
        return frames
    }
    /// Stop/mute drops the final incomplete 20 ms frame; never pad or send a short frame.
    mutating func discardPartial() -> Int {
        let count = carry.count; carry = Data(); return count
    }
}
struct NativePCMFrameRing {
    /// 25 frames of 640 bytes (20 ms at 16 kHz) hold 500 ms of audio, so a sender stall up to
    /// half a second drains without dropping a single converted frame.
    static let capacityForSenderStall = 25
    private var frames: [Data] = []
    private let capacity: Int
    private(set) var drops = 0
    init(capacity: Int = NativePCMFrameRing.capacityForSenderStall) { self.capacity = capacity }
    mutating func push(_ frame: Data) {
        precondition(frame.count == 640)
        if frames.count == capacity { frames.removeFirst(); drops += 1 }
        frames.append(frame)
    }
    mutating func pop() -> Data? { frames.isEmpty ? nil : frames.removeFirst() }
    var count: Int { frames.count }
    /// Returns how many still-buffered frames the clear discarded, so the ledger counts them.
    mutating func clear() -> Int { let discarded = frames.count; frames.removeAll(keepingCapacity: true); return discarded }
}

/// One converter per capture lifetime. The input callback supplies each buffer exactly once.
final class NativePCMConverter {
    let output: AVAudioFormat
    let inputSampleRate: Double
    let inputChannels: Int
    private let converter: AVAudioConverter
    init(input: AVAudioFormat) throws {
        guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        guard let converter = AVAudioConverter(from: input, to: output) else { throw NativeLiveAudioError.converterUnavailable }
        converter.channelMap = [0]
        self.output = output; self.converter = converter
        inputSampleRate = input.sampleRate; inputChannels = Int(input.channelCount)
    }
    func append(_ input: AVAudioPCMBuffer) throws -> Data { try convert(input, ending: false) }
    func finish() throws -> Data { try convert(nil, ending: true) }
    private func convert(_ input: AVAudioPCMBuffer?, ending: Bool) throws -> Data {
        var supplied = false, result = Data()
        while true {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 4096) else {
                throw NativeLiveAudioError.allocationFailed
            }
            var error: NSError?
            let status = converter.convert(to: buffer, error: &error) { _, state in
                if let input, !supplied { supplied = true; state.pointee = .haveData; return input }
                state.pointee = ending ? .endOfStream : .noDataNow
                return nil
            }
            if let error { throw error }
            guard status != .error else { throw LiveClientError.unavailable }
            if buffer.frameLength > 0 {
                guard let channels = buffer.int16ChannelData else { throw NativeLiveAudioError.unsupportedFormat }
                result.append(Data(bytes: channels[0], count: Int(buffer.frameLength) * 2))
            }
            if status == .inputRanDry || status == .endOfStream { return result }
        }
    }
}

struct NativeCaptureStatistics: Sendable {
    var tapBuffers = 0, convertedBytes = 0, convertFailures = 0, ringDrops = 0
    var maxRMS: Double = 0, inputSampleRate: Double = 0
    var inputChannels = 0
    // Byte conservation ledger: convertedBytes == sentBytes + droppedBytes + residualBytes.
    var sentBytes = 0, droppedBytes = 0, residualBytes = 0
    var balances: Bool { convertedBytes == sentBytes + droppedBytes + residualBytes }
    mutating func add(_ other: NativeCaptureStatistics) {
        tapBuffers += other.tapBuffers; convertedBytes += other.convertedBytes
        convertFailures += other.convertFailures; ringDrops += other.ringDrops
        sentBytes += other.sentBytes; droppedBytes += other.droppedBytes; residualBytes += other.residualBytes
        maxRMS = max(maxRMS, other.maxRMS)
        inputSampleRate = other.inputSampleRate; inputChannels = other.inputChannels
    }
}
struct NativePlaybackStatistics: Sendable {
    var queueDrains = 0, speechGaps = 0, lateAfterFlush = 0
    /// P3: the pitch-preserving rate this session played at, and how long it ran, so a session with
    /// more chunks per second can be read per minute rather than per session.
    var rate: Double = 1, sessionMs: Int = 0
    /// Positive short gaps between audible buffers per minute of the whole session.
    var speechGapsPerMinute: Int {
        guard sessionMs > 0 else { return speechGaps }
        return Int((Double(speechGaps) * 60_000 / Double(sessionMs)).rounded())
    }
}
/// P3: the pitch-preserving speech rate band. The live config refuses anything outside it; the device
/// clamps rather than throws, because a bad number must never keep her silent.
enum NativePlaybackRate {
    static let minimum = 1.0
    static let maximum = 1.2

    static func valid(_ value: Double) -> Double {
        guard value.isFinite, value > minimum, value <= maximum else { return minimum }
        return value
    }
    /// The string the journal and the receipt carry: `1.00`, `1.08`.
    static func label(_ value: Double) -> String { String(format: "%.2f", value) }
}
/// The scheduling decision for one arriving model chunk.
struct NativePlaybackArrival: Sendable, Equatable {
    /// The prebuffer just filled: the device calls the player's play().
    let start: Bool
    /// A positive short queue gap between audible buffers; not proof of an audible glitch.
    let speechGap: Bool
    let dryGapMs: Int
    /// The burst that just ran dry had held this much audio, in ms (0 when the queue never drained).
    let burstMs: Int
    /// The queue depth now, after this chunk arrived: the real length still to play, in ms.
    let queuedMs: Int
    /// Milliseconds since the previous chunk arrived, 0 for the first of a session.
    let sinceLastChunkMs: Int
}
/// Model PCM arrivals and completion times determine playback starts and measured queue gaps.
/// This queue touches no audio API, so schedules can be replayed without hardware.
struct NativePlaybackQueue {
    /// Keep 80 ms of 24 kHz mono audio queued before a stretch starts to absorb arrival jitter.
    static let prebufferFrames = 1920
    static let frameRate = 24000
    /// Longer gaps are classified as pauses; a shorter measured gap still is not proof of a glitch.
    static let pauseThresholdMs = 500
    /// P2-R1: the playback memory guard. 120 s of queued audio is far beyond any real answer, so a
    /// flush here only protects memory; the old 24-buffer count cap dropped audio mid-answer
    /// because host frames arrive far faster than realtime.
    static let overflowFrames = frameRate * 120

    /// P3: the rate the whole session plays at. Audible time is source time divided by it, so a
    /// drain at 1.08x is shorter than the frames it holds. Set once at session start.
    var rate: Double = 1
    private(set) var queuedBuffers = 0
    private(set) var scheduledFrames = 0
    /// P2-R1: the queue holds so much audio that the device flushes instead of growing.
    var overflowsMemoryGuard: Bool { scheduledFrames >= Self.overflowFrames }
    private(set) var playing = false
    private var drainedFrames = 0
    private var burstFrames = 0
    /// One entry per scheduled buffer, in play order: the depth falls as each buffer finishes.
    private struct Buffer { let frames: Int; let audible: Bool; let level: Float }
    private var queuedFrames: [Buffer] = []
    var playingSpeech: Bool { playing && queuedFrames.first?.audible == true }
    var playingLevel: Float { playing ? queuedFrames.first?.level ?? 0 : 0 }
    private var drainedAtMs: Int?
    private var drainedWasAudible = false
    private var lastArrivalMs: Int?

    /// The queue depth: the audio still to play, in ms of audible time. It falls buffer by buffer,
    /// never only at the drain, so a receipt taken mid-burst states the real backlog.
    var depthMs: Int { Self.ms(scheduledFrames, rate: rate) }

    mutating func arrival(frames: Int, atMs: Int, audible: Bool = true, level: Float = 0) -> NativePlaybackArrival {
        let sinceLastChunkMs = lastArrivalMs.map { atMs - $0 } ?? 0
        lastArrivalMs = atMs
        let gap = max(0, drainedAtMs.map { atMs - $0 } ?? 0)
        let starved = gap > 0 && gap < Self.pauseThresholdMs && drainedWasAudible && audible
        // A chunk that arrives on an empty queue begins a new burst.
        if scheduledFrames <= 0 { burstFrames = 0 }
        burstFrames += frames
        queuedBuffers += 1
        scheduledFrames += frames
        queuedFrames.append(Buffer(frames: frames, audible: audible, level: level))
        drainedAtMs = nil
        var start = false
        if !playing, scheduledFrames >= Self.prebufferFrames { playing = true; start = true }
        return NativePlaybackArrival(start: start, speechGap: starved, dryGapMs: gap,
                                     burstMs: starved ? Self.ms(drainedFrames, rate: rate) : 0,
                                     queuedMs: depthMs,
                                     sinceLastChunkMs: sinceLastChunkMs)
    }

    /// A scheduled buffer finished playing back. Returns true when the queue is now dry: the player
    /// is stopped and the next arrival re-arms the prebuffer, so a pause is not a glitch. The frames
    /// that played leave the depth, so `depthMs` falls while the answer is still playing.
    @discardableResult mutating func playedBack(atMs: Int) -> Bool {
        let finished = queuedFrames.isEmpty ? nil : queuedFrames.removeFirst()
        if let finished { scheduledFrames = max(0, scheduledFrames - finished.frames) }
        queuedBuffers = max(0, queuedBuffers - 1)
        guard queuedBuffers == 0 else { return false }
        playing = false
        drainedFrames = burstFrames
        burstFrames = 0
        scheduledFrames = 0
        drainedAtMs = atMs; drainedWasAudible = finished?.audible ?? false
        return true
    }

    mutating func flush() {
        queuedBuffers = 0; scheduledFrames = 0; playing = false
        queuedFrames.removeAll()
        drainedFrames = 0; burstFrames = 0; drainedAtMs = nil; drainedWasAudible = false; lastArrivalMs = nil
    }

    /// Audible milliseconds for a frame count. At rate 1.0 this is the integer arithmetic it always
    /// was, so today's numbers stay byte-identical.
    static func ms(_ frames: Int, rate: Double = 1) -> Int {
        if rate == 1 { return frames * 1000 / frameRate }
        let sourceMs = Double(frames) * 1000.0 / Double(frameRate)
        return Int((sourceMs / rate).rounded())
    }
}
/// Contract C1: deterministic wait-cue scheduler. A tool marker and the playback queue's drain
/// (plus model audio and barge-ins) go in as timestamped events; the absolute times at which the
/// soft cue may play come out. It touches no clock and no audio API, so a recorded event sequence
/// can be replayed in a test.
struct NativeWaitCueScheduler {
    /// Argon rounds 3 and 4: 4.0 s of real silence measured from the drain, so a cue never competes
    /// with the acknowledgement audio that may still be playing, then at most three cues 6 s apart.
    static let silenceBeforeFirstCueMs = 4000
    static let cueSpacingMs = 6000
    static let maximumCues = 3

    enum Event: Equatable {
        case toolMarker(atMs: Int)
        case drained(atMs: Int)
        case modelAudio(atMs: Int)
        case interrupted(atMs: Int)
    }

    private var armed = false

    /// The cue times this event makes due, in absolute milliseconds. A tool marker arms the wait; a
    /// drain schedules up to three cues; model audio or a barge-in disarms and cancels the rest.
    mutating func apply(_ event: Event) -> [Int] {
        switch event {
        case .toolMarker:
            armed = true
            return []
        case .drained(let atMs):
            guard armed else { return [] }
            armed = false
            return (0..<Self.maximumCues).map {
                atMs + Self.silenceBeforeFirstCueMs + $0 * Self.cueSpacingMs
            }
        case .modelAudio, .interrupted:
            armed = false
            return []
        }
    }
}
/// Contract C1: the non-verbal "still working" cue, generated in code so no asset ships and no
/// second synthetic voice is heard next to Naya's. Two short sine notes, 24 kHz mono, 20 ms
/// raised-cosine fades, about -26 dBFS.
enum NativeWaitCue {
    static let sampleRate = 24000.0
    static let noteFrames = 3360
    static let gapFrames = 1680
    static let totalFrames = noteFrames * 2 + gapFrames
    static let fadeFrames = 480
    static let amplitude: Float = 0.05
    static let firstTone = 660.0
    static let secondTone = 880.0

    /// The two notes as one mono sample array, so the shape is testable without an audio device.
    static func samples() -> [Float] {
        var out = [Float](repeating: 0, count: totalFrames)
        for i in 0..<noteFrames {
            let phase = Double(i) / sampleRate
            let envelope = fade(i)
            out[i] = Float(sin(2 * Double.pi * firstTone * phase)) * amplitude * envelope
            out[gapFrames + noteFrames + i] =
                Float(sin(2 * Double.pi * secondTone * phase)) * amplitude * envelope
        }
        return out
    }

    /// The cue as a 24 kHz mono buffer for the existing player node.
    static func buffer() -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(totalFrames)),
              let channels = buffer.floatChannelData else { return nil }
        buffer.frameLength = buffer.frameCapacity
        let samples = samples()
        for index in 0..<samples.count { channels[0][index] = samples[index] }
        return buffer
    }

    /// Schedule the cue, then start the player, in that order. The schedule is synchronous and its
    /// empty handler touches nothing: it never awaits playback completion, which on the node P2
    /// stops at drain would never return and would deadlock the cue.
    static func emit(_ buffer: AVAudioPCMBuffer, on output: NativeWaitCueOutput) {
        output.scheduleCue(buffer)
        output.startCue()
    }

    /// 20 ms raised-cosine fade in and out, so the cue never clicks.
    private static func fade(_ index: Int) -> Float {
        if index < fadeFrames { return Float(0.5 - 0.5 * cos(Double.pi * Double(index) / Double(fadeFrames))) }
        if index >= noteFrames - fadeFrames {
            let tail = noteFrames - 1 - index
            return Float(0.5 - 0.5 * cos(Double.pi * Double(tail) / Double(fadeFrames)))
        }
        return 1
    }
}
/// The two player calls the wait cue makes, in order. A test stands in for the node, so the
/// schedule-then-play order is pinned with no audio device.
protocol NativeWaitCueOutput: AnyObject {
    func scheduleCue(_ buffer: AVAudioPCMBuffer)
    func startCue()
}
extension AVAudioPlayerNode: NativeWaitCueOutput {
    func scheduleCue(_ buffer: AVAudioPCMBuffer) { scheduleBuffer(buffer, at: nil, options: []) { } }
    func startCue() { play() }
}
struct NativeAudioCaptureSummary: Sendable {
    let capture: NativeCaptureStatistics
    let drainFrames: Int
    let captureEpoch: UInt64
    let captureGeneration: UInt64
    let muted: Bool
    let playback: NativePlaybackStatistics
}

/// One orb analysis window (#283): linear RMS of the whole signal and of three bands, plus the
/// half-wave rectified rise of the band levels (an onset, 0...1). Numbers only.
struct NativeOrbBands: Equatable, Sendable {
    var level: Float = 0, low: Float = 0, mid: Float = 0, high: Float = 0, flux: Float = 0
    static let silent = NativeOrbBands()
}

/// Splits mono Int16 PCM into the orb's bands with two one-pole low-passes: low below ~300 Hz (the
/// vowel body), mid ~300 Hz to 2 kHz, high above ~2 kHz (consonants), one band set per 10 ms window.
/// It runs on the main actor over PCM the device already holds (the drained capture frame and the
/// received model chunk), never on the tap or render thread, and it never touches the audio itself.
struct NativeOrbAnalyzer {
    static let windowMs = 10
    let sampleRate: Double
    let windowFrames: Int
    private let lowAlpha: Float, midAlpha: Float
    private var lowPass: Float = 0, midPass: Float = 0
    private var sumAll: Float = 0, sumLow: Float = 0, sumMid: Float = 0, sumHigh: Float = 0
    private var count = 0
    private var previous: (Float, Float, Float) = (-60, -60, -60)

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        windowFrames = max(1, Int(sampleRate) * Self.windowMs / 1000)
        lowAlpha = Float(1 - exp(-2 * Double.pi * 300 / sampleRate))
        midAlpha = Float(1 - exp(-2 * Double.pi * 2000 / sampleRate))
    }

    /// Little-endian Int16 mono samples in, one band set per completed 10 ms window out.
    mutating func analyze(_ pcm: Data) -> [NativeOrbBands] {
        let samples = pcm.count / 2
        guard samples > 0 else { return [] }
        var windows: [NativeOrbBands] = []
        windows.reserveCapacity(samples / windowFrames + 1)
        pcm.withUnsafeBytes { raw in
            for index in 0..<samples {
                let x = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
                lowPass += lowAlpha * (x - lowPass)
                midPass += midAlpha * (x - midPass)
                let low = lowPass, mid = midPass - lowPass, high = x - midPass
                sumAll += x * x; sumLow += low * low; sumMid += mid * mid; sumHigh += high * high
                count += 1
                if count == windowFrames { windows.append(closeWindow()) }
            }
        }
        return windows
    }

    static func decibels(_ rms: Float) -> Float { max(-60, 20 * log10(max(rms, 1e-6))) }

    private mutating func closeWindow() -> NativeOrbBands {
        let n = Float(count)
        func rms(_ sum: Float) -> Float { min(1, (sum / n).squareRoot()) }
        var bands = NativeOrbBands(level: rms(sumAll), low: rms(sumLow), mid: rms(sumMid), high: rms(sumHigh))
        let now = (Self.decibels(bands.low), Self.decibels(bands.mid), Self.decibels(bands.high))
        let rise = max(0, now.0 - previous.0) + max(0, now.1 - previous.1) + max(0, now.2 - previous.2)
        bands.flux = min(1, rise / 30)
        previous = now
        sumAll = 0; sumLow = 0; sumMid = 0; sumHigh = 0; count = 0
        return bands
    }

    mutating func reset() { self = NativeOrbAnalyzer(sampleRate: sampleRate) }
}

/// Model output for the orb, aligned with what is audible: windows are appended as chunks are
/// scheduled and read back at the playback position (milliseconds since the player started), so
/// the orb follows the voice the owner hears, not the chunk that just arrived ahead of it.
struct NativeOrbTimeline {
    private var analyzer = NativeOrbAnalyzer(sampleRate: Double(NativePlaybackQueue.frameRate))
    private var windows: [NativeOrbBands] = []
    private var consumed = 0
    private var startedAtMs: Int?
    var queuedWindows: Int { windows.count }

    mutating func append(_ pcm: Data) { windows.append(contentsOf: analyzer.analyze(pcm)) }
    /// The player started: position zero is the first window appended since the last reset.
    mutating func started(atMs: Int) { if startedAtMs == nil { startedAtMs = atMs } }
    /// The queue ran dry, was flushed or the audio was released: the next burst starts at zero.
    mutating func reset() {
        analyzer.reset(); windows.removeAll(keepingCapacity: true); consumed = 0; startedAtMs = nil
    }
    /// The window playing at `atMs`; silent before the player starts and past the scheduled audio.
    mutating func sample(atMs: Int) -> NativeOrbBands {
        guard let start = startedAtMs, atMs >= start else { return .silent }
        let index = (atMs - start) / NativeOrbAnalyzer.windowMs - consumed
        guard index >= 0, index < windows.count else { return .silent }
        if index > 256 {
            // Drop played windows in blocks, so reads stay O(1) and memory follows the queue.
            windows.removeFirst(index); consumed += index
            return windows[0]
        }
        return windows[index]
    }
}

/// The tap and drain task meet only through this locked eight-frame queue.
final class NativeCaptureBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let converter: NativePCMConverter
    private var assembler = NativePCMFrameAssembler()
    private var ring = NativePCMFrameRing()
    private var stopped = false, muted = false
    private var level: Float = 0
    private var failure = false
    private var statistics = NativeCaptureStatistics()
    let stream: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    init(converter: NativePCMConverter) {
        self.converter = converter
        statistics.inputSampleRate = converter.inputSampleRate; statistics.inputChannels = converter.inputChannels
        (stream, signal) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
    }
    func makeTap() -> AVAudioNodeTapBlock {
        { [self] buffer, _ in append(buffer) }
    }
    func append(_ input: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return }
        statistics.tapBuffers += 1
        if !muted {
            do {
                let data = try converter.append(input)
                statistics.convertedBytes += data.count
                var sum: Double = 0
                data.withUnsafeBytes { bytes in
                    for sample in bytes.bindMemory(to: Int16.self) {
                        let value = Double(sample) / 32768; sum += value * value
                    }
                }
                level = data.isEmpty ? 0 : Float(sqrt(sum / Double(data.count / 2)))
                statistics.maxRMS = max(statistics.maxRMS, Double(level))
                let priorDrops = ring.drops
                for frame in assembler.append(data) { ring.push(frame) }
                statistics.ringDrops = ring.drops
                statistics.droppedBytes += (ring.drops - priorDrops) * 640
            } catch { failure = true; statistics.convertFailures += 1 }
        }
        signal.yield(())
    }
    func next() -> (Data?, Float, Int, Bool) {
        lock.lock(); defer { lock.unlock() }
        let frame = ring.pop()
        if let frame { statistics.sentBytes += frame.count }
        return (frame, muted ? 0 : level, ring.drops, failure)
    }
    func setMuted(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        muted = value
        statistics.droppedBytes += ring.clear() * 640 + assembler.discardPartial()
        level = 0
    }
    @discardableResult func stop() -> NativeCaptureStatistics {
        lock.lock(); defer { lock.unlock() }
        statistics.ringDrops = ring.drops
        statistics.droppedBytes += ring.clear() * 640
        statistics.residualBytes = assembler.discardPartial()
        let snapshot = statistics
        stopped = true; signal.finish()
        return snapshot
    }
}

/// Owns only recovery permission, never session creation. Notifications coalesce before rebuild.
@MainActor final class NativeAudioRouteRecovery {
    private let input: () -> String
    private let release: () -> Void
    private let rebuild: () throws -> Void
    private let paused: (String) -> Void
    private let failed: () -> Void
    private var previousInput = ""
    private var generation: UInt64 = 0
    private(set) var authorized = false
    private(set) var awaitingResume = false
    private(set) var pending: Task<Void, Never>?
    init(input: @escaping () -> String, release: @escaping () -> Void,
         rebuild: @escaping () throws -> Void, paused: @escaping (String) -> Void,
         failed: @escaping () -> Void) {
        self.input = input; self.release = release; self.rebuild = rebuild
        self.paused = paused; self.failed = failed
    }
    func begin() { authorized = true; awaitingResume = false; previousInput = input() }
    func changed() {
        guard authorized, pending == nil else { return }
        // Release synchronously, before any old tap/drain/player can deliver more audio.
        release()
        guard !input().isEmpty else { stop(); failed(); return }
        let token = generation
        pending = Task { [weak self] in
            await Task.yield()
            guard let self, self.authorized, self.generation == token, !Task.isCancelled else { return }
            self.pending = nil
            let current = self.input()
            guard !current.isEmpty else { self.stop(); self.failed(); return }
            if current != self.previousInput || self.awaitingResume {
                self.previousInput = current; self.awaitingResume = true; self.paused(current)
            } else { self.recover() }
        }
    }
    func resume() {
        guard authorized, awaitingResume else { return }
        pending?.cancel(); pending = nil; generation &+= 1
        let current = input()
        guard !current.isEmpty else { stop(); failed(); return }
        guard current == previousInput else {
            previousInput = current; paused(current); return
        }
        awaitingResume = false; recover()
    }
    private func recover() {
        do { try rebuild() }
        catch { stop(); failed() }
    }
    func stop() {
        authorized = false; awaitingResume = false; generation &+= 1
        pending?.cancel(); pending = nil; release()
    }
}

struct NativeLiveInterruptionSample: Sendable {
    let isPostRms: Bool
    let bufferedPlaybackMs: Int
    let msSinceLastModelAudio: Int
    let turnCompleteSeen: Bool
    let rmsMean: Float
    let rmsMax: Float
    let rmsSpeechBuffers: Int
    let at: Date
}

@MainActor protocol NativePlaybackDriver: AnyObject {
    func schedule(_ buffer: AVAudioPCMBuffer, completion: @escaping @Sendable () -> Void)
    func play()
    func stop()
}

@MainActor final class NativeLiveAudioDevice: ObservableObject, LiveAudioSink {
    @Published private(set) var inputLevel: Float = 0
    @Published private(set) var outputLevel: Float = 0
    @Published private(set) var isPlayingOutput = false
    @Published private(set) var droppedFrames = 0
    @Published private(set) var isCapturing = false
    var hasEngine: Bool { engine != nil }
    var ownerIsHeld: Bool { owner.isOwned }
    var captureDrain: Task<Void, Never>? { drain }
    var onOutput: ((Bool) -> Void)?
    /// One playback receipt per segment moment, forwarded to the host over the live socket.
    var onPlaybackReceipt: ((NativePlaybackReceipt) -> Void)?
    /// The segment the app is reporting: one playback run, from the first chunk to its drain or flush.
    private var playbackSegment = 0
    private var segmentActive = false
    /// One `playback.audible` per segment: the first chunk that crosses the audibility threshold.
    private var segmentAudible = false
    private var terminatedSegment = 0
    /// One positive short gap between audible buffers, for the native-live.log line.
    var onSpeechGap: ((NativePlaybackArrival) -> Void)?
    /// Z2: capture was released. Carries the failure that did it (class and code only reach the log).
    var onInterruption: ((Error?) async -> Void)?
    var onInputChange: ((String) -> Void)?
    var onResume: (() -> Void)?
    /// E1: called once per provider barge-in with the pre facts, then again after `interruptionPostRmsDelayNanos` with postRms.
    var onLiveInterrupted: (@MainActor (NativeLiveInterruptionSample) async -> Void)?
    /// P2-R1: the playback memory guard dropped the queued turn. The conversation records one
    /// `playback_overflow_flush` native-live.log line, because it holds the session id.
    var onPlaybackOverflow: (@MainActor (Int, Int) async -> Void)?
    /// Contract C1: one recorded cue play, index 1...3 and milliseconds since the queue drained. The
    /// conversation records one `wait_cue` native-live.log line, because it holds the session id.
    var onWaitCue: (@MainActor (Int, Int) async -> Void)?
    /// E1 test seam: the delay before the postRms line. Production is five seconds.
    var interruptionPostRmsDelayNanos: UInt64 = 5_000_000_000
    /// The orb renders this RMS and above as speech (web/src/orb.ts `audible`); telemetry counts buffers above it.
    static let meterSpeechThreshold: Float = 0.01
    @Published private(set) var route = ""
    /// #283: the orb's band frames. Input is the latest drained capture window, output is read at the
    /// playback position. Computed on the main actor from PCM already in hand; never fed back to audio.
    private var inputOrb = NativeOrbAnalyzer(sampleRate: 16000)
    private var inputBands = NativeOrbBands.silent
    private var inputBandsAtMs = 0
    private var outputOrb = NativeOrbTimeline()
    private var muted = false
    /// E1: the last few seconds of the per-buffer input levels the meter already computes. Numbers only,
    /// appended where `inputLevel` is published; never read on the audio path and never fed back to the engine.
    private var levelRing: [(at: Date, level: Float)] = []
    private static let levelRingCapacity = 256
    private var lastModelAudioAt: Date?
    private let captureInput: AVAudioFormat?
    private let inputDevice: () -> (id: String, name: String)
    private let owner: AudioOwner
    /// The one audio journal this device writes into: the owner's adopted journal when one exists, so
    /// a second conversation can never open a second writer on audio.log (#477).
    let journal: NativeAudioJournal?
    private let deviceState: (Bool) -> Bool
    private let now: () -> Date
    private let isBuiltInOutput: () -> Bool
    /// Test seams: an engine/player/format factory and a start hook stand in for real hardware.
    var engineFactoryForTesting: (() -> (AVAudioEngine, AVAudioPlayerNode, AVAudioFormat))?
    var startForTesting: ((AVAudioEngine) throws -> Void)?
    var playbackDriverForTesting: (any NativePlaybackDriver)?
    var sessionFailedForTesting: Bool { sessionFailed }
    var isVoiceProcessingEnabledForTesting: Bool { engine?.inputNode.isVoiceProcessingEnabled ?? false }
    private var tapInstalled = false
    private var rebuilding = false
    private var lastRebuildAt: Date?
    private var resumeTask: Task<Void, Never>?
    private var startInputID = ""
    private var startOutputID = ""
    private var startInputRate: Double = 0
    private var startOutputRate: Double = 0
    private var voiceProcessingFailed = false
    private var sessionFailed = false
    private(set) var audioReleaseCount = 0
    private(set) var engineResetCount = 0
    var hasConfigurationObserver: Bool { configurationObserver != nil }
    // Receives the actual locked converter/buffer, never a substitute PCM implementation.
    var onCapturePrepared: ((NativeCaptureBuffer) -> Void)?
    init(captureInput: AVAudioFormat? = nil, defaultInput: (() -> (id: String, name: String))? = nil,
         owner: AudioOwner = .shared, journal: NativeAudioJournal? = nil,
         deviceState: ((Bool) -> Bool)? = nil, now: (() -> Date)? = nil,
         isBuiltInOutput: (() -> Bool)? = nil) {
        self.captureInput = captureInput
        self.inputDevice = defaultInput ?? { Self.defaultDevice(input: true) }
        self.owner = owner
        self.journal = journal
        self.deviceState = deviceState ?? Self.defaultDeviceRunningSomewhere(input:)
        self.now = now ?? { Date() }
        self.isBuiltInOutput = isBuiltInOutput ?? { Self.isBuiltInSpeakers(outputID: Self.defaultDevice(input: false).id) }
    }
    var hasJournal: Bool { journal != nil }
    /// Test seam: adopt the stretcher the running graph would own, then flush it, without opening hardware.
    func adoptTimePitchForTesting(_ unit: AVAudioUnitTimePitch?) { timePitch = unit }

    /// Test seam: adopt an engine/player without starting hardware, then release it.
    func adoptEngineForTesting(_ engine: AVAudioEngine, player: AVAudioPlayerNode) {
        self.engine = engine; self.player = player
    }
    func releaseForTesting() { releaseAudio() }
    func rebuildForTesting() throws { try build { _, _ in } }
    func log(_ name: String, _ fields: [String: String] = [:]) {
        journal?.record(NativeAudioEvent(name: name, fields: fields))
    }
    func routeChanged() {
        let input = inputDevice()
        let output = Self.defaultDevice(input: false)
        route = "Microphone: " + input.name + " · Output: " + output.name
        guard !rebuilding else {
            log("audio_route_change_ignored", ["reason": "busy"]); return
        }
        // Rebuild only for a real change of default input/output device or nominal sample rate.
        let inputRate = Self.nominalSampleRate(input: true)
        let outputRate = Self.nominalSampleRate(input: false)
        guard input.id != startInputID || output.id != startOutputID
            || inputRate != startInputRate || outputRate != startOutputRate else {
            log("audio_route_change_ignored", ["reason": "unchanged"]); return
        }
        if let last = lastRebuildAt, now().timeIntervalSince(last) < 0.5 {
            log("audio_route_change_ignored", ["reason": "debounced"]); return
        }
        lastRebuildAt = now()
        recovery.changed()
        scheduleResume()
    }
    /// R8: a paused route-change auto-resumes on the same input device, time-bound so a paused
    /// Didi never holds the device. The engine and flock are already released by recovery.changed().
    private func scheduleResume() {
        resumeTask?.cancel()
        resumeTask = Task { [weak self] in
            guard let self else { return }
            await self.recovery.pending?.value
            if self.recovery.awaitingResume { self.resumeInput() }
            // Time-bound poll for a route that is still settling; never holds the device.
            let deadline = Date().addingTimeInterval(20)
            while !Task.isCancelled, Date() < deadline, self.recovery.awaitingResume {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if self.recovery.awaitingResume { self.resumeInput() }
            }
        }
    }
    private func installConfigurationObserver(object: AVAudioEngine?) {
        let token = captureGeneration
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: object, queue: nil) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.captureGeneration == token else { return }
                self.routeChanged()
            }
        }
    }
    func finishRouteRecovery() async { await recovery.pending?.value; await resumeTask?.value }
    private var sendFrame: (@Sendable (Data, UInt64) async throws -> Void)?
    private(set) var captureEpoch: UInt64 = 0
    private lazy var recovery = NativeAudioRouteRecovery(
        input: { [unowned self] in self.inputDevice().id },
        release: { [weak self] in self?.releaseAudio() },
        rebuild: { [weak self] in
            guard let self, let send = self.sendFrame else { throw NativeLiveAudioError.captureNotConfigured }
            try self.build(send: send)
        },
        paused: { [weak self] _ in guard let self else { return }; self.onInputChange?(self.inputDevice().name) },
        failed: { [weak self] in
            guard let self else { return }
            self.sendFrame = nil
            let token = self.captureGeneration
            Task { @MainActor in
                guard self.captureGeneration == token else { return }
                await self.interrupt()
            }
        })
    /// Support exports use CoreAudio transport classes, never the local device name.
    var diagnosticsRoute: String { Self.routeDiagnostics() }
    /// A read-only snapshot of the system's current default route, usable with no live engine.
    static func routeDiagnostics() -> String {
        "Input: " + routeClassification(input: true) + "; Output: " + routeClassification(input: false)
    }
    /// Whether the current engine has VoiceProcessingIO enabled, read-only.
    var isVoiceProcessingEnabled: Bool { engine?.inputNode.isVoiceProcessingEnabled ?? false }
    private static func routeClassification(input: Bool) -> String {
        var property = AudioObjectPropertyAddress(
            mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &device) == noErr,
              device != kAudioObjectUnknown else { return "unknown" }
        property.mSelector = kAudioDevicePropertyTransportType
        var transport = UInt32(0)
        size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &transport) == noErr else { return "unknown" }
        switch transport {
        case kAudioDeviceTransportTypeBuiltIn: return "built-in"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "Bluetooth"
        case kAudioDeviceTransportTypeUSB: return "USB"
        case kAudioDeviceTransportTypePCI, kAudioDeviceTransportTypeFireWire, kAudioDeviceTransportTypeThunderbolt: return "external wired"
        default: return "unknown"
        }
    }
    private static func defaultDevice(input: Bool) -> (id: String, name: String) {
        var property = AudioObjectPropertyAddress(
            mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &device) == noErr,
              device != kAudioObjectUnknown else { return ("", "No microphone") }
        property.mSelector = kAudioObjectPropertyName
        var name: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &name) {
            AudioObjectGetPropertyData(device, &property, 0, nil, &size, $0)
        }
        return (String(device), status == noErr ? (name?.takeRetainedValue() as String? ?? "Unknown device") : "Unknown device")
    }
    func resumeInput() { recovery.resume(); if isCapturing { onResume?() } }

    /// A1-R2: true when the default input or output device is already running somewhere else,
    /// read read-only and before Didi starts any engine so it reflects other apps only.
    static func defaultDeviceRunningSomewhere(input: Bool) -> Bool {
        let device = defaultDeviceID(input: input)
        guard device != kAudioObjectUnknown else { return false }
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var running: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &running) == noErr else { return false }
        return running != 0
    }
    static func defaultDeviceID(input: Bool) -> AudioDeviceID {
        var property = AudioObjectPropertyAddress(
            mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &device) == noErr,
              device != kAudioObjectUnknown else { return kAudioObjectUnknown }
        return device
    }
    static func nominalSampleRate(input: Bool) -> Double {
        let device = defaultDeviceID(input: input)
        guard device != kAudioObjectUnknown else { return 0 }
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var rate: Double = 0, size = UInt32(MemoryLayout<Double>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &rate) == noErr else { return 0 }
        return rate
    }
    static func isBuiltInSpeakers(outputID: String) -> Bool {
        guard let device = AudioDeviceID(outputID), device != kAudioObjectUnknown else { return false }
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var transport: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &transport) == noErr else { return false }
        return transport == kAudioDeviceTransportTypeBuiltIn
    }
    static func shouldUseVoiceProcessing(outputIsBuiltInSpeakers: Bool, deviceBusy: Bool,
                                         voiceProcessingFailed: Bool) -> Bool {
        outputIsBuiltInSpeakers && !deviceBusy && !voiceProcessingFailed
    }
    static func vpioSkipReason(builtIn: Bool, deviceBusy: Bool, voiceProcessingFailed: Bool) -> String {
        if voiceProcessingFailed { return "vpio_failed" }
        if !builtIn { return "output_not_builtin" }
        return deviceBusy ? "device_busy" : "unknown"
    }
    private static func enableVoiceProcessing(engine: AVAudioEngine) throws {
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            try engine.outputNode.setVoiceProcessingEnabled(true)
        } catch { throw NativeLiveAudioError.voiceProcessingFailed(code: (error as NSError).code) }
        guard engine.inputNode.isVoiceProcessingEnabled, engine.outputNode.isVoiceProcessingEnabled else {
            throw NativeLiveAudioError.voiceProcessingFailed(code: nil)
        }
        // Other-audio ducking to the minimum while VPIO is on: never degrade the Mac's audio.
        applyMinimumDucking(to: engine.inputNode)
    }
    /// Minimum other-audio ducking, guarded by OS availability.
    static func applyMinimumDucking(to node: AVAudioInputNode) {
        guard #available(macOS 14.0, *) else { return }
        node.voiceProcessingOtherAudioDuckingConfiguration = minimumDuckingConfiguration()
    }
    static func minimumDuckingConfiguration() -> AVAudioVoiceProcessingOtherAudioDuckingConfiguration {
        var configuration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration()
        configuration.enableAdvancedDucking = false
        configuration.duckingLevel = .min
        return configuration
    }
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var capture: NativeCaptureBuffer?
    private var drain: Task<Void, Never>?
    private var configurationObserver: NSObjectProtocol?
    private var playbackQueue = NativePlaybackQueue()
    /// P3: the pitch-preserving rate for the next session start, set from the live config before
    /// startFenced. Read once, so nothing that arrives mid-utterance ever retunes her.
    var playbackRate: Double = NativePlaybackRate.minimum
    /// The rate the running session committed to: the graph, the drain math and the receipt all use it.
    private(set) var sessionRate: Double = NativePlaybackRate.minimum
    private var timePitch: AVAudioUnitTimePitch?
    /// P3: how many barge-in flushes actually cleared a stretcher's tail. Observability for the test that
    /// proves a flush drops the unit's held audio and not only the player's queue.
    private(set) var timePitchTailFlushes = 0
    private var sessionStartedAt: Date?
    private var outputGeneration: UInt64 = 0
    /// Advanced by barge-in and mute, so an in-flight chunk cannot cross either playback fence.
    private var turnGeneration: UInt64 = 0
    private var playback = NativePlaybackStatistics()
    var playbackStatisticsForTesting: NativePlaybackStatistics { playback }
    /// Contract C1: the wait-cue scheduler, its timer task and a token that cancels a stale task.
    private var waitCue = NativeWaitCueScheduler()
    private var cueTask: Task<Void, Never>?
    private var cueGeneration: UInt64 = 0
    private var captureGeneration: UInt64 = 0
    private var captureStatistics = NativeCaptureStatistics()
    private var drainFrames = 0
    private var captureLifetimeActive = false
    private var terminalCaptureSummary: NativeAudioCaptureSummary?
    func takeCaptureSummary() -> NativeAudioCaptureSummary? {
        defer { terminalCaptureSummary = nil }
        return terminalCaptureSummary
    }

    func start(send: @escaping @Sendable (Data) async throws -> Void) async throws {
        try await startFenced { data, _ in try await send(data) }
    }
    func startFenced(send: @escaping @Sendable (Data, UInt64) async throws -> Void) async throws {
        guard engine == nil, !isCapturing else { throw LiveClientError.unavailable }
        if captureInput == nil {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .restricted: throw NativeLiveAudioError.permissionRestricted
        case .denied: throw NativeLiveAudioError.permissionDenied
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw NativeLiveAudioError.permissionDenied }
        case .authorized: break
        @unknown default: throw NativeLiveAudioError.permissionRestricted
        }
        try Task.checkCancellation()
        }
        captureStatistics = NativeCaptureStatistics(); drainFrames = 0
        // P3: one rate per session, decided here and never changed while she speaks.
        sessionRate = NativePlaybackRate.valid(playbackRate)
        playbackQueue.rate = sessionRate
        playback = NativePlaybackStatistics(rate: sessionRate)
        sessionStartedAt = now()
        sendFrame = send
        // A new session may try once: clear the per-session VPIO and circuit-breaker state.
        voiceProcessingFailed = false; sessionFailed = false; lastRebuildAt = nil
        do { try build(send: send); recovery.begin() }
        catch { sendFrame = nil; throw error }
    }
    /// P3: the single playback graph builder. `rate` is the pitch-preserving speed for the whole
    /// utterance. At 1.0 the graph is exactly the two connections it always was: no unit is inserted,
    /// so no unit's latency or tail can touch the answer. Above 1.0 the stretch sits between the player
    /// and the mixer, so everything downstream (the mixer, the voice-processing output node and any
    /// echo reference the output node derives from its own input bus) sees post-stretch audio.
    @discardableResult
    static func connectPlayback(engine: AVAudioEngine, player: AVAudioPlayerNode,
                                outputNode: AVAudioNode, outputFormat: AVAudioFormat? = nil,
                                rate: Double = 1) throws -> AVAudioUnitTimePitch? {
        let hardwareOutput = outputFormat ?? outputNode.inputFormat(forBus: 0)
        guard hardwareOutput.sampleRate > 0, hardwareOutput.channelCount > 0 else {
            throw NativeLiveAudioError.formatUnavailable
        }
        guard let output = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        engine.attach(player)
        var stretch: AVAudioUnitTimePitch?
        if rate == 1 {
            engine.connect(player, to: engine.mainMixerNode, format: output)
        } else {
            let unit = AVAudioUnitTimePitch()
            unit.rate = Float(rate)
            // Her voice is the voice: only the pace moves, never the pitch.
            unit.pitch = 0
            engine.attach(unit)
            engine.connect(player, to: unit, format: output)
            engine.connect(unit, to: engine.mainMixerNode, format: output)
            stretch = unit
        }
        // VP output requires its input-bus format, not the player's 24 kHz mono client format.
        engine.connect(engine.mainMixerNode, to: outputNode, format: hardwareOutput)
        return stretch
    }
    private func build(send: @escaping @Sendable (Data, UInt64) async throws -> Void) throws {
        let input = inputDevice()
        guard !input.id.isEmpty else { throw NativeLiveAudioError.deviceMissing }
        startInputID = input.id
        startOutputID = Self.defaultDevice(input: false).id
        startInputRate = Self.nominalSampleRate(input: true)
        startOutputRate = Self.nominalSampleRate(input: false)
        if let captureInput, engineFactoryForTesting == nil {
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: captureInput))
            capture.setMuted(muted); self.capture = capture
            activateCapture(capture, send: send)
            installConfigurationObserver(object: nil)
            return
        }
        // Zero-retry circuit breaker: a failed start never rebuilds within the session.
        guard !sessionFailed else { throw NativeLiveAudioError.engineFailed(code: 0) }
        do { try owner.acquire(holder: ObjectIdentifier(self)) }
        catch let refusal as AudioOwnerError {
            log("audio_refused", ["reason": refusal.rawValue])
            throw refusal
        }
        var ready = false
        defer { if !ready { releaseAudio() } }

        // A1-R2: voice processing only on built-in speakers and only when no device is busy.
        let builtInOutput = isBuiltInOutput()
        let deviceBusy = deviceState(true) || deviceState(false)
        let useVoiceProcessing = Self.shouldUseVoiceProcessing(
            outputIsBuiltInSpeakers: builtInOutput, deviceBusy: deviceBusy,
            voiceProcessingFailed: voiceProcessingFailed)
        if !useVoiceProcessing {
            log("audio_vpio_skipped", ["reason": Self.vpioSkipReason(builtIn: builtInOutput,
                                                                     deviceBusy: deviceBusy,
                                                                     voiceProcessingFailed: voiceProcessingFailed)])
        }
        var engine = AVAudioEngine(), player = AVAudioPlayerNode()
        var stretch: AVAudioUnitTimePitch?
        var hardware = engine.inputNode.outputFormat(forBus: 0)
        if let factory = engineFactoryForTesting {
            (engine, player, hardware) = factory()
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                throw NativeLiveAudioError.formatUnavailable
            }
            if useVoiceProcessing { try Self.enableVoiceProcessing(engine: engine) }
        } else if useVoiceProcessing {
            do {
                try Self.enableVoiceProcessing(engine: engine)
                hardware = engine.inputNode.outputFormat(forBus: 0)
                guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                    throw NativeLiveAudioError.formatUnavailable
                }
                stretch = try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode,
                                                   rate: sessionRate)
            } catch {
                // One VPIO attempt per session, then plain capture: never a second VPIO attempt.
                voiceProcessingFailed = true
                log("audio_vpio_skipped", ["reason": "build_failed"])
                engine.stop(); engine.reset()
                engine = AVAudioEngine(); player = AVAudioPlayerNode()
                hardware = engine.inputNode.outputFormat(forBus: 0)
                guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                    throw NativeLiveAudioError.formatUnavailable
                }
                stretch = try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode,
                                                   rate: sessionRate)
            }
        } else {
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                throw NativeLiveAudioError.formatUnavailable
            }
            stretch = try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode,
                                               rate: sessionRate)
        }
        self.engine = engine; self.player = player; self.timePitch = stretch
        let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: hardware))
        capture.setMuted(muted); self.capture = capture
        // Tap format is the input node's current output format at install time, never one
        // captured before voice processing was enabled.
        if engineFactoryForTesting == nil {
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware, block: capture.makeTap())
            tapInstalled = true
            engine.prepare()
        }
        do {
            if let startForTesting { try startForTesting(engine) } else { try engine.start() }
        } catch {
            sessionFailed = true
            log("audio_start_failed", ["code": String((error as NSError).code)])
            throw (error as? NativeLiveAudioError) ?? NativeLiveAudioError.engineFailure(error as NSError)
        }
        owner.didStartEngine(holder: ObjectIdentifier(self))
        log("audio_started", ["voiceProcessing": useVoiceProcessing ? "true" : "false"])
        // One rate receipt per session accompanies the queue measurements.
        log("playback_rate", ["rate": NativePlaybackRate.label(sessionRate)])
        // Playback starts in write(_:) only after the prebuffer fills, never on an empty queue.
        route = "Microphone: " + input.name + " · Output: " + Self.defaultDevice(input: false).name
        activateCapture(capture, send: send)
        installConfigurationObserver(object: engine)
        ready = true
    }
    private func activateCapture(_ capture: NativeCaptureBuffer, send: @escaping @Sendable (Data, UInt64) async throws -> Void) {
        isCapturing = true; captureGeneration &+= 1; captureLifetimeActive = true
        let token = captureGeneration
        // Exactly one drain task. Playback never owns or pauses the capture path.
        drain = Task { [weak self] in
                for await _ in capture.stream {
                    while !Task.isCancelled {
                        let (frame, level, drops, failed) = capture.next()
                        guard let self, self.captureGeneration == token else { return }
                        self.inputLevel = level; self.droppedFrames = drops
                        self.recordLevel(level)
                        if failed { await self.interrupt(); return }
                        guard let frame else { break }
                        if let bands = self.inputOrb.analyze(frame).last { self.inputBands = bands; self.inputBandsAtMs = self.nowMs() }
                        self.drainFrames += 1
                        let epoch = self.captureEpoch
                        do { try Task.checkCancellation(); try await send(frame, epoch) }
                        catch {
                            guard self.captureGeneration == token, !Task.isCancelled else { return }
                            await self.interrupt(error); return
                        }
                    }
                }
            }
        onCapturePrepared?(capture)
    }
    func setMuted(_ muted: Bool) {
        if self.muted != muted { captureEpoch &+= 1 }
        self.muted = muted; capture?.setMuted(muted); inputLevel = 0; inputBands = .silent
        if muted { turnGeneration &+= 1; flushOutput() }
    }
    /// #283: the orb frame for this instant: the owner's latest capture window (silent once older than
    /// 200 ms or while muted) and the model output window at the playback position.
    func orbBands() -> (input: NativeOrbBands, output: NativeOrbBands) {
        let now = nowMs()
        let input = !muted && now - inputBandsAtMs <= 200 ? inputBands : .silent
        return (input, outputOrb.sample(atMs: now))
    }
    /// E1: append one already-computed meter level to a small bounded ring. Stores the number only.
    private func recordLevel(_ value: Float) {
        levelRing.append((at: now(), level: value))
        if levelRing.count > Self.levelRingCapacity { levelRing.removeFirst(levelRing.count - Self.levelRingCapacity) }
    }
    /// E1: mean, max and speech-buffer count of the stored levels inside [from, to]. Numbers only.
    private func rmsWindow(from: Date, to: Date) -> (mean: Float, max: Float, speechBuffers: Int) {
        let window = levelRing.filter { $0.at >= from && $0.at <= to }
        guard !window.isEmpty else { return (0, 0, 0) }
        let sum = window.reduce(Float(0)) { $0 + $1.level }
        return (sum / Float(window.count), window.map(\.level).max() ?? 0,
                window.filter { $0.level > Self.meterSpeechThreshold }.count)
    }
    /// E1: gather the barge-in facts the capture and playback paths already hold, then postRms after the delay.
    func interruption(turnCompleteSeen: Bool) async {
        // Contract C1: a barge-in cancels the waiting cue before the flush does.
        cancelWaitCue(.interrupted(atMs: nowMs()), stopPlayer: true)
        let at = now()
        let bufferedPlaybackMs = playbackQueue.scheduledFrames <= 0 ? 0
            : NativePlaybackQueue.ms(playbackQueue.scheduledFrames, rate: playbackQueue.rate)
        let sinceAudio = lastModelAudioAt.map { max(0, Int(at.timeIntervalSince($0) * 1000)) } ?? -1
        let pre = rmsWindow(from: at.addingTimeInterval(-1), to: at)
        await onLiveInterrupted?(NativeLiveInterruptionSample(isPostRms: false, bufferedPlaybackMs: bufferedPlaybackMs,
            msSinceLastModelAudio: sinceAudio, turnCompleteSeen: turnCompleteSeen,
            rmsMean: pre.mean, rmsMax: pre.max, rmsSpeechBuffers: pre.speechBuffers, at: at))
        let delay = interruptionPostRmsDelayNanos
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self else { return }
            let after = self.now()
            let post = self.rmsWindow(from: at, to: after)
            await self.onLiveInterrupted?(NativeLiveInterruptionSample(isPostRms: true, bufferedPlaybackMs: bufferedPlaybackMs,
                msSinceLastModelAudio: sinceAudio, turnCompleteSeen: turnCompleteSeen,
                rmsMean: post.mean, rmsMax: post.max, rmsSpeechBuffers: post.speechBuffers, at: after))
        }
    }
    private func interrupt(_ failure: Error? = nil) async {
        stop()
        await onInterruption?(failure)
    }
    /// Test seam: release capture exactly as a real interruption does, without opening hardware.
    func interruptForTesting(_ failure: Error? = nil) async { await interrupt(failure) }
    // MARK: Wait cue (contract C1)

    /// A tool marker for the current turn arms the wait. If the queue is already dry (the
    /// acknowledgement played before the marker arrived) the wait starts now.
    func toolMarker() async {
        _ = waitCue.apply(.toolMarker(atMs: nowMs()))
        if !playbackQueue.playing, playbackQueue.scheduledFrames <= 0 { startWaitCue() }
    }

    /// The queue ran dry after a tool marker: schedule at most three cues, 4 s then every 6 s.
    private func startWaitCue() {
        guard cueTask == nil else { return }
        let drainMs = nowMs()
        let times = waitCue.apply(.drained(atMs: drainMs))
        guard !times.isEmpty else { return }
        cueGeneration &+= 1
        let token = cueGeneration
        cueTask = Task { @MainActor in
            var index = 0
            for atMs in times {
                index += 1
                let delay = atMs - self.nowMs()
                if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000) }
                guard !Task.isCancelled, self.cueGeneration == token else { return }
                await self.playWaitCue(index: index, sinceDrainMs: self.nowMs() - drainMs)
            }
            if self.cueGeneration == token { self.cueTask = nil }
        }
    }

    /// Play one soft cue on the existing player. A cue never plays while model audio is queued or
    /// playing, and it touches none of the model-audio telemetry.
    private func playWaitCue(index: Int, sinceDrainMs: Int) async {
        guard !muted, !rebuilding, !playbackQueue.playing, playbackQueue.scheduledFrames <= 0,
              let player, let engine, engine.isRunning, let buffer = NativeWaitCue.buffer() else { return }
        NativeWaitCue.emit(buffer, on: player)
        await onWaitCue?(index, max(0, sinceDrainMs))
    }

    /// Cancel the wait on model audio, a barge-in, a mute, a rebuild or a session end. `stopPlayer`
    /// stops the cue buffer only, never the answer: write() schedules the answer immediately after.
    private func cancelWaitCue(_ event: NativeWaitCueScheduler.Event, stopPlayer: Bool) {
        _ = waitCue.apply(event)
        guard cueTask != nil else { return }
        cueGeneration &+= 1
        cueTask?.cancel(); cueTask = nil
        if stopPlayer { stopPlaybackNode() }
    }
    private func nowMs() -> Int { Int(now().timeIntervalSince1970 * 1000) }
    /// One playback receipt for a segment, stamped with the process clock and the launch identity.
    /// The receipt sequence is its own stream, so a forwarded receipt range stays dense.
    private func emitReceipt(_ kind: NativePlaybackReceipt.Kind, segment: Int, reason: String? = nil) {
        guard segment > 0, onPlaybackReceipt != nil else { return }
        let clock = NativeLogClock.shared
        onPlaybackReceipt?(NativePlaybackReceipt(kind: kind, segmentSeq: segment,
            sourceInstanceID: clock.sourceInstanceID, sourceSeq: clock.nextSequence("receipt"),
            monoMs: clock.monoMs(), wallMs: NativeLogClock.wallMs(Date()), reason: reason))
    }
    private func stopPlaybackNode() {
        if let driver = playbackDriverForTesting { driver.stop() } else { player?.stop() }
    }
    func write(_ pcm: Data) async throws {
        guard !muted else { return }
        // Contract C1: model audio has arrived, so stop any waiting or playing cue. It stops the cue
        // only; the answer is scheduled normally below, delayed by nothing.
        cancelWaitCue(.modelAudio(atMs: nowMs()), stopPlayer: true)
        // Paused/rebuilding output is discarded, never buffered or replayed on Resume.
        if recovery.awaitingResume || recovery.pending != nil { return }
        guard pcm.count.isMultiple(of: 2), playbackDriverForTesting != nil || (player != nil && engine?.isRunning == true) else { throw LiveClientError.unavailable }
        let entryTurn = turnGeneration, entryOutput = outputGeneration
        if playbackQueue.overflowsMemoryGuard {
            // P2-R1: log the dropped turn before the flush resets the queue.
            await onPlaybackOverflow?(NativePlaybackQueue.ms(playbackQueue.scheduledFrames), playbackQueue.queuedBuffers)
            guard !muted, turnGeneration == entryTurn, outputGeneration == entryOutput else { playback.lateAfterFlush += 1; return }
            flushOutput()
        }
        guard !muted, turnGeneration == entryTurn else { playback.lateAfterFlush += 1; return }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)) else {
            throw NativeLiveAudioError.allocationFailed
        }
        guard let channels = buffer.floatChannelData else { throw NativeLiveAudioError.unsupportedFormat }
        buffer.frameLength = buffer.frameCapacity
        pcm.withUnsafeBytes { bytes in
            for (index, sample) in bytes.bindMemory(to: Int16.self).enumerated() {
                channels[0][index] = Float(Int16(littleEndian: sample)) / 32768
            }
        }
        let token = outputGeneration
        let frames = Int(buffer.frameLength)
        // A chunk that lands on a dry queue is the first of a new segment.
        let newSegment = !playbackQueue.playing && playbackQueue.scheduledFrames <= 0
        var sum: Double = 0
        pcm.withUnsafeBytes { bytes in
            for sample in bytes.bindMemory(to: Int16.self) {
                let value = Double(Int16(littleEndian: sample)) / 32768; sum += value * value
            }
        }
        let level = pcm.isEmpty ? 0 : Float(min(1, sqrt(sum / Double(pcm.count / 2))))
        let audible = level >= 0.00316227766
        let arrival = playbackQueue.arrival(frames: frames, atMs: nowMs(), audible: audible, level: level)
        if newSegment {
            playbackSegment += 1; segmentActive = true; segmentAudible = false
            emitReceipt(.received, segment: playbackSegment)
        }
        if audible, !segmentAudible { segmentAudible = true; emitReceipt(.audible, segment: playbackSegment) }
        if arrival.speechGap { playback.speechGaps += 1; onSpeechGap?(arrival) }
        outputOrb.append(pcm)
        if audible { lastModelAudioAt = now() }
        let completion: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in
                guard let self, self.outputGeneration == token else { return }
                if self.playbackQueue.playedBack(atMs: self.nowMs()) {
                    self.playback.queueDrains += 1
                    // The queue ran dry: this is a pause or the end of a turn, never a glitch. Stop the
                    // node so the next burst re-fills the prebuffer before playback restarts.
                    self.emitReceipt(.drained, segment: self.playbackSegment)
                    self.segmentActive = false
                    self.stopPlaybackNode()
                    self.onOutput?(false); self.isPlayingOutput = false; self.outputLevel = 0
                    self.outputOrb.reset()
                    self.startWaitCue()
                } else { self.publishPlaybackState() }
            }
        }
        if let driver = playbackDriverForTesting { driver.schedule(buffer, completion: completion) }
        else if let player { player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in completion() } }
        else { throw LiveClientError.unavailable }
        if newSegment { emitReceipt(.enqueued, segment: playbackSegment) }
        if arrival.start {
            if let driver = playbackDriverForTesting { driver.play() } else { player?.play() }
            emitReceipt(.started, segment: playbackSegment); outputOrb.started(atMs: nowMs())
        }
        publishPlaybackState()
    }
    private func publishPlaybackState() {
        let speaking = playbackQueue.playingSpeech
        if isPlayingOutput != speaking { isPlayingOutput = speaking; onOutput?(speaking) }
        outputLevel = playbackQueue.playingLevel
    }
    /// Barge-in: invalidate the queued turn so an in-flight chunk cannot be scheduled after the flush.
    func flush() async throws { flushOutput(); turnGeneration &+= 1 }
    /// Presence hot-mute (council-presence-1017): drop the queued model speech now. The muted
    /// flag already refuses every new chunk, so this only stops what is scheduled.
    func cancelPlayback() {
        guard playbackQueue.playing || playbackQueue.scheduledFrames > 0 else { return }
        flushOutput()
    }
    private func flushOutput() {
        // Contract C1: a barge-in, a rebuild or a session end tears down the wait cue with the turn.
        cancelWaitCue(.interrupted(atMs: nowMs()), stopPlayer: true)
        // A barge-in closes the segment it interrupts; the flush below drops exactly that audio.
        if segmentActive { emitReceipt(.interrupted, segment: playbackSegment, reason: "interrupted"); segmentActive = false }
        outputGeneration &+= 1; stopPlaybackNode(); playbackQueue.flush(); onOutput?(false); isPlayingOutput = false; outputLevel = 0
        // P3: stopping the player empties only the player. The stretcher holds its own tail, so reset
        // the unit: no syllable of a flushed turn may play after the flush.
        if let timePitch { timePitch.auAudioUnit.reset(); timePitchTailFlushes += 1 }
        outputOrb.reset()
    }
    func stop() {
        // The call is over: the last played segment gets one terminal receipt, whichever stop it was.
        if playbackSegment > terminatedSegment {
            emitReceipt(.terminated, segment: playbackSegment, reason: "session_end")
            terminatedSegment = playbackSegment
        }
        cancelWaitCue(.interrupted(atMs: nowMs()), stopPlayer: true)
        let epoch = captureEpoch, captureToken = captureGeneration, wasMuted = muted
        playback.sessionMs = sessionStartedAt.map { max(0, Int(now().timeIntervalSince($0) * 1000)) } ?? 0
        captureEpoch &+= 1; recovery.stop(); sendFrame = nil; muted = false
        if captureLifetimeActive {
            terminalCaptureSummary = NativeAudioCaptureSummary(capture: captureStatistics,
                drainFrames: drainFrames, captureEpoch: epoch, captureGeneration: captureToken, muted: wasMuted,
                playback: playback)
            captureLifetimeActive = false
        }
    }
    private func releaseAudio() {
        cancelWaitCue(.interrupted(atMs: nowMs()), stopPlayer: true)
        rebuilding = true; defer { rebuilding = false }
        captureGeneration &+= 1
        // Release order: observer first, then player/tap, then stop, reset and drop the engine.
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        if let capture { captureStatistics.add(capture.stop()) }
        drain?.cancel(); drain = nil; capture = nil
        flushOutput()
        weak let weakEngine = engine
        if let engine {
            if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
            engine.stop()
            engine.reset()
            engineResetCount += 1
        }
        engine = nil; player = nil
        if weakEngine != nil { log("audio_release_leak", ["reason": "engine_retained"]) }
        owner.release(holder: ObjectIdentifier(self))
        isCapturing = false; inputLevel = 0; outputLevel = 0; isPlayingOutput = false
        inputBands = .silent; outputOrb.reset()
        audioReleaseCount += 1
        log("audio_released", ["reason": "release"])
    }
}
