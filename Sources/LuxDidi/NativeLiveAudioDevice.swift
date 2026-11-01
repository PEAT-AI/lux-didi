import AudioToolbox
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
    let input: AVAudioFormat
    let inputSampleRate: Double
    let inputChannels: Int
    private let converter: AVAudioConverter
    init(input: AVAudioFormat) throws {
        guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        guard let converter = AVAudioConverter(from: input, to: output) else { throw NativeLiveAudioError.converterUnavailable }
        converter.channelMap = [0]
        self.output = output; self.converter = converter; self.input = input
        inputSampleRate = input.sampleRate; inputChannels = Int(input.channelCount)
    }
    func append(_ input: AVAudioPCMBuffer) throws -> Data { try convert(input, ending: false) }
    /// C-MICWATCH 3: whether a buffer carries the format this converter was built for.
    func accepts(_ format: AVAudioFormat) -> Bool { Self.sameShape(format, input) }
    static func sameShape(_ a: AVAudioFormat, _ b: AVAudioFormat) -> Bool {
        a.channelCount == b.channelCount && a.sampleRate == b.sampleRate
            && a.commonFormat == b.commonFormat && a.isInterleaved == b.isInterleaved
    }
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
    var queuedWindows: Int { windows.count }

    mutating func append(_ pcm: Data) { windows.append(contentsOf: analyzer.analyze(pcm)) }
    /// The queue ran dry, was flushed or the audio was released: the next burst starts at zero.
    mutating func reset() {
        analyzer.reset(); windows.removeAll(keepingCapacity: true); consumed = 0
    }
    /// Positive presentation offsets look ahead from the rendered sample; no clock means silence.
    mutating func sample(renderedSample: Int64?, sampleRate: Double = Double(NativePlaybackQueue.frameRate), presentationOffsetMs: Double = 0) -> NativeOrbBands {
        guard let renderedSample, renderedSample >= 0, sampleRate.isFinite, sampleRate > 0, presentationOffsetMs.isFinite else { return .silent }
        let positionMs = Double(renderedSample) * 1000 / sampleRate + presentationOffsetMs
        guard positionMs >= 0, positionMs < Double(Int.max) else { return .silent }
        let index = Int(positionMs) / NativeOrbAnalyzer.windowMs - consumed
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
    private var converter: NativePCMConverter
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
                // C-MICWATCH 3: a format read before start that the buffers do not carry is replaced
                // by the buffer's own format, once, so the converter never fails on a settled graph.
                if !converter.accepts(input.format) {
                    converter = try NativePCMConverter(input: input.format)
                    statistics.inputSampleRate = converter.inputSampleRate; statistics.inputChannels = converter.inputChannels
                }
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
    /// C-MICWATCH 1: whether the tap has delivered at least one buffer.
    var hasReceivedBuffer: Bool {
        lock.lock(); defer { lock.unlock() }
        return statistics.tapBuffers > 0
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
    private let rebuild: @MainActor () async throws -> Void
    private let paused: (String) -> Void
    private let failed: () -> Void
    private var previousInput = ""
    private var generation: UInt64 = 0
    private(set) var authorized = false
    private(set) var awaitingResume = false
    private(set) var pending: Task<Void, Never>?
    init(input: @escaping () -> String, release: @escaping () -> Void,
         rebuild: @escaping @MainActor () async throws -> Void, paused: @escaping (String) -> Void,
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
            let current = self.input()
            guard !current.isEmpty else { self.stop(); self.failed(); return }
            if current != self.previousInput || self.awaitingResume {
                self.previousInput = current; self.awaitingResume = true; self.pending = nil
                self.paused(current)
            } else {
                // #1101: the rebuild is async, so `pending` stays set until it lands. A caller that
                // awaits it must not read a recovery as finished before its engine is built.
                await self.recover()
                self.pending = nil
            }
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
        awaitingResume = false
        // C-AUDIO 2: the rebuild is async now, because it waits the release settle out first.
        pending = Task { [weak self] in
            guard let self else { return }
            await self.recover()
            self.pending = nil
        }
    }
    private func recover() async {
        do { try await rebuild() }
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

/// One volume control on an output device. A device may publish a master (element 0) or one control
/// per channel (1 and 2), so a reader reports the set and never assumes one master exists.
struct NativeVolumeControl: Equatable, Sendable {
    let element: Int
    /// The scalar this control returned, or nil when the device refused that control.
    let scalar: Float?
}

/// What an output device says about itself and its level: the stable device id, how it is attached,
/// and every readable volume control. Read through CoreAudio getters only, never written.
struct NativeOutputVolumeSnapshot: Equatable, Sendable {
    let uid: String
    let transport: String
    let controls: [NativeVolumeControl]

    init(uid: String, transport: String, controls: [NativeVolumeControl]) {
        self.uid = uid
        self.transport = transport
        self.controls = controls
    }

    /// The journal fields every volume record carries: which device, how it is attached, what its
    /// controls read. An unreadable control is left out of the text and the count says how many are
    /// known, so a missing reading is never a zero.
    var fields: [String: String] {
        let readable = controls.filter { $0.scalar != nil }
        return ["outputUid": uid, "outputTransport": transport,
                "outputVolume": Self.volumeText(controls), "outputVolumeControls": String(readable.count)]
    }

    static func volumeText(_ controls: [NativeVolumeControl]) -> String {
        let readable = controls.compactMap { control in control.scalar.map { (control.element, $0) } }
            .sorted { $0.0 < $1.0 }
        guard !readable.isEmpty else { return "unknown" }
        return readable.map { "\($0.0)=\(String(format: "%.3f", min(1, max(0, $0.1))))" }.joined(separator: ",")
    }
}

/// One owner "mark this moment" record. Metadata only: the device and its volumes, the voice stage
/// and why it was bypassed, the engine generation and the last graph change, the ducking that was
/// asked for and read back, the recent playback counters and the load average. Never audio, never a
/// device name, never a person.
struct NativeDistortionMark: Sendable {
    var output: NativeOutputVolumeSnapshot
    var voiceProcessing: Bool
    var bypassReason: String
    var engineGeneration: Int
    var lastChange: String
    var duckingRequested: String
    var duckingReadBack: String
    var peakDb: String
    var rmsDb: String
    var overSamples: Int
    var flatTopRuns: Int
    var processorOverloads: Int
    var loadAverage: (Double, Double, Double)

    var record: [String: Any] {
        var fields: [String: Any] = [:]
        for (key, value) in output.fields { fields[key] = value }
        fields["event"] = "audio_distortion_mark"
        fields["voiceProcessing"] = voiceProcessing
        fields["voiceProcessingBypass"] = bypassReason
        fields["engineGeneration"] = engineGeneration
        fields["lastChange"] = lastChange
        fields["duckingRequested"] = duckingRequested
        fields["duckingReadBack"] = duckingReadBack
        fields["peakDb"] = peakDb
        fields["rmsDb"] = rmsDb
        fields["overSamples"] = overSamples
        fields["flatTopRuns"] = flatTopRuns
        fields["processorOverloads"] = processorOverloads
        fields["loadAverage"] = Self.loadText(loadAverage)
        return fields
    }

    static func loadText(_ load: (Double, Double, Double)) -> String {
        String(format: "%.2f,%.2f,%.2f", load.0, load.1, load.2)
    }

    /// The load average of this Mac right now, so a mark says whether the machine was busy.
    static func currentLoadAverage() -> (Double, Double, Double) {
        var averages = [Double](repeating: 0, count: 3)
        guard getloadavg(&averages, 3) == 3 else { return (0, 0, 0) }
        return (averages[0], averages[1], averages[2])
    }
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
    /// L12b: the audio Naya played in the current window, in decibels to one decimal once a window
    /// closes. The sums are taken where the host's frames arrive, before the player, on the main actor.
    private var playedPeak: Double = 0
    private var playedSumSquares: Double = 0
    private var playedFrames = 0
    /// C-AUDIOMARK 4: the diagnostic counters of the same window, taken in the same decode walk. A
    /// sample at or over -3 dBFS and a run of identical loud samples are counts only, never audio.
    private var playedOverSamples = 0
    private var playedFlatTopRuns = 0
    private var lastDecodedSample: Int16 = 0
    private var inFlatTop = false
    static let overSampleThreshold = 0.7079457843841379
    /// C-AUDIOMARK 3: processor overload notifications since this call's build, and the listener that
    /// counts them, replaced whenever the output device is re-chosen.
    private var processorOverloads = 0
    private var overloadListener: (device: AudioObjectID, block: AudioObjectPropertyListenerBlock)?
    /// C-AUDIOMARK 0b and 1: which build this is, and what last moved the graph, so a mark says which
    /// engine the owner was hearing. Never a device name, only a closed reason word.
    private(set) var engineGeneration = 0
    private(set) var lastChange = "none"
    private var duckingRequestedText = "none"
    private var duckingReadBackText = "none"
    private var playbackLevelTask: Task<Void, Never>?
    static let playbackLevelWindowMs = 5_000
    private static let silenceFloorDb = -120.0
    private var lastModelAudioAt: Date?
    private let captureInput: AVAudioFormat?
    private let inputDevice: () -> (id: String, name: String)
    /// C-HEADPHONES 1: the built-in microphone, or nil when the machine has none. Capture follows
    /// this device by id, never the system default input, so a headset that becomes the default
    /// input can never move the microphone the call records from.
    private let builtInInput: () -> (id: String, name: String)?
    private let outputDevice: () -> (id: String, name: String)
    /// The transport token of a device id (built_in, bluetooth, usb, ...), one word in the journal.
    private let transportOf: (String) -> String
    private let owner: AudioOwner
    /// The one audio journal this device writes into: the owner's adopted journal when one exists, so
    /// a second conversation can never open a second writer on audio.log (#477).
    let journal: NativeAudioJournal?
    private let deviceState: (Bool) -> Bool
    private let now: () -> Date
    private let isBuiltInOutput: () -> Bool
    private let outputLevelReading: () -> (volume: String, mute: String)
    /// C-AUDIOMARK 0b: the output device, transport and volume controls, read before preparation,
    /// after route selection and after teardown. Injectable so a test never opens a device.
    private let volumeReading: () -> NativeOutputVolumeSnapshot
    /// Test seams: an engine/player/format factory and a start hook stand in for real hardware.
    var engineFactoryForTesting: (() -> (AVAudioEngine, AVAudioPlayerNode, AVAudioFormat))?
    var startForTesting: ((AVAudioEngine) throws -> Void)?
    /// C-MICWATCH 1: the fake engine has no tap, so its tests opt in to the first-buffer watchdog
    /// with their own window. A real engine always runs it with `firstBufferWindowMs`.
    var firstBufferWindowForTesting: Duration?
    var playbackDriverForTesting: (any NativePlaybackDriver)?
    var sessionFailedForTesting: Bool { sessionFailed }
    var isVoiceProcessingEnabledForTesting: Bool { engine?.inputNode.isVoiceProcessingEnabled ?? false }
    private var tapInstalled = false
    /// A mute holds the microphone back until the unmute rebuild takes it again.
    private var muteHoldsMicrophone = false
    /// The injected-capture fixtures take the format-only path, where no engine is ever opened.
    private var opensHardware: Bool { captureInput == nil || engineFactoryForTesting != nil }
    private var mutedAt: Date?
    private var rebuilding = false
    private var lastRebuildAt: Date?
    private var resumeTask: Task<Void, Never>?
    private var startInputID = ""
    private var startOutputID = ""
    private var startInputRate: Double = 0
    private var startOutputRate: Double = 0
    /// C-HEADPHONES 2 and 5: the output switch a rebuild is carrying, from the transport it left
    /// and the clock it started, so `audio_output_switched` reports a measured switch.
    private var pendingOutputSwitch: (from: String, at: Date)?
    private var voiceProcessingFailed = false
    /// C-AUDIOMARK 1: why the voice stage is not on, as a closed word; `none` when it is on.
    private var voiceProcessingBypass = "none"
    /// C-MICWATCH 1: how long a started engine may run before its tap delivers the first buffer.
    static let firstBufferWindowMs = 1_000
    private var firstBufferWatchdog: Task<Void, Never>?
    /// C-MICWATCH 1: the one restart without voice processing a session may take after a stall.
    private var stallRestarted = false
    /// MW-R1: the session ended because the input stayed dead after the restart. The conversation
    /// reads it to skip its automatic restart, which would only ring into the same dead input.
    private(set) var inputStallFailed = false
    /// The device-busy reading taken at call start, before the connecting ring or the live engine
    /// can start: `kAudioDevicePropertyDeviceIsRunningSomewhere` counts Didi itself (#1022).
    private(set) var outsideBusyAtCallStart: Bool?
    /// Takes the one busy reading for this call: called from the synchronous prefix of
    /// `NativeLiveConversation.start`, before the connecting ring or any live engine starts.
    func noteOutsideDeviceBusy() { outsideBusyAtCallStart = deviceState(true) || deviceState(false) }
    /// Teardown clears the snapshot, so a stale reading never decides a later call.
    func clearOutsideDeviceBusy() { outsideBusyAtCallStart = nil }
    private var sessionFailed = false
    private(set) var audioReleaseCount = 0
    private(set) var engineResetCount = 0
    var hasConfigurationObserver: Bool { configurationObserver != nil }
    /// C-AUDIO 2: the settle interval a release holds its engine and player handles for. CoreAudio
    /// starts its teardown when the engine stops, and a build that lands inside that teardown is the
    /// 2026-10-15 "hardware DSP added while IO running, inconsistent state" wedge class.
    static let releaseSettleMs = 250
    /// C-AUDIO 2: an in-flight configuration change or default-device change is waited for, never
    /// longer than this.
    static let settleConfigWaitLimitMs = 1000
    static let settleConfigPollMs = 50
    /// C-AUDIO 2: the handles a release keeps alive until the settle completes.
    private var settledEngine: AVAudioEngine?
    private var settledPlayer: AVAudioPlayerNode?
    private var settleTask: Task<Void, Never>?
    private var settleGeneration: UInt64 = 0
    private var settling = false
    /// Set by the configuration observer while a settle runs: the change the settle waits out.
    private var configurationChangePending = false
    private var settleDeviceIDs = (input: "", output: "")
    /// C-AUDIO 4: what the last settle waited and whether a change was pending, as audio.log says it.
    private(set) var settleWaitedMs = 0
    private(set) var settledReleaseCount = 0
    /// C-AUDIO 1: one prepare per build. The fake-engine path records the step here instead of
    /// touching the device.
    var prepareForTesting: ((AVAudioEngine) -> Void)?
    /// C-AUDIO 2: every settle wait, so a test records it and never sleeps.
    var settleWaitForTesting: (@MainActor (Duration) async -> Void)?
    /// The unmute rebuilds in flight, keyed so each removes itself when it lands.
    private var resumeFromMuteTasks: [UInt64: Task<Void, Never>] = [:]
    private var nextResumeID: UInt64 = 0
    /// C-AUDIO 1 and 4: the graph steps of the last build and the engine starts inside this call.
    private(set) var graphBuildSteps: [String] = []
    private(set) var engineStartCount = 0
    private var starting = false
    private var configChangesDuringStart = 0
    // Receives the actual locked converter/buffer, never a substitute PCM implementation.
    var onCapturePrepared: ((NativeCaptureBuffer) -> Void)?
    /// C-HEADPHONES 2 and 5: an output-only rebuild that landed, so native-live.log carries the
    /// same truthful switch record audio.log does.
    var onOutputSwitched: ((String, String, Int) -> Void)?
    init(captureInput: AVAudioFormat? = nil, defaultInput: (() -> (id: String, name: String))? = nil,
         owner: AudioOwner = .shared, journal: NativeAudioJournal? = nil,
         deviceState: ((Bool) -> Bool)? = nil, now: (() -> Date)? = nil,
         isBuiltInOutput: (() -> Bool)? = nil,
         outputLevelReading: (() -> (volume: String, mute: String))? = nil,
         outputVolumeSnapshot: (() -> NativeOutputVolumeSnapshot)? = nil,
         builtInInput: (() -> (id: String, name: String)?)? = nil,
         defaultOutput: (() -> (id: String, name: String))? = nil,
         transport: ((String) -> String)? = nil) {
        self.captureInput = captureInput
        self.inputDevice = defaultInput ?? { Self.defaultDevice(input: true) }
        // An injected input resolver stands in for device enumeration entirely: the built-in
        // lookup is then only what the caller injects, so fixtures never read the host's hardware.
        self.builtInInput = builtInInput ?? (defaultInput == nil ? { Self.builtInMicrophone() } : { nil })
        self.outputDevice = defaultOutput ?? { Self.defaultDevice(input: false) }
        self.transportOf = transport ?? { Self.transportType(ofDeviceID: $0) }
        self.owner = owner
        self.journal = journal
        self.deviceState = deviceState ?? Self.defaultDeviceRunningSomewhere(input:)
        self.now = now ?? { Date() }
        self.isBuiltInOutput = isBuiltInOutput
            ?? { Self.isBuiltInSpeakers(outputID: (defaultOutput ?? { Self.defaultDevice(input: false) })().id) }
        self.outputLevelReading = outputLevelReading ?? { Self.defaultOutputLevel() }
        self.volumeReading = outputVolumeSnapshot ?? { Self.outputVolumeSnapshot() }
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

    /// C-AUDIOMARK 0b: one volume record at a lifecycle boundary, the device UID, its transport and
    /// every volume control together. Read only, never a device write, never a device name.
    func logOutputVolume(_ reason: String) {
        var fields = volumeReading().fields
        fields["reason"] = reason
        fields["voiceProcessing"] = voiceProcessingText
        fields["voiceProcessingBypass"] = voiceProcessingBypass
        fields["engineGeneration"] = String(engineGeneration)
        fields["processorOverloads"] = String(processorOverloads)
        fields["lastChange"] = lastChange
        log("output_volume", fields)
    }
    var voiceProcessingText: String { isVoiceProcessingEnabled ? "true" : "false" }

    /// C-AUDIOMARK 3: one processor overload notification on the current output, counted per call.
    func noteProcessorOverload() {
        processorOverloads += 1
        log("processor_overload", ["count": String(processorOverloads)])
    }
    /// Test seam: the listener body without CoreAudio.
    func noteProcessorOverloadForTesting() { noteProcessorOverload() }

    /// C-AUDIOMARK 3: a read-only overload listener on the device this call plays through. It is
    /// replaced whenever a build re-chooses the output, and removed with the engine.
    private func installOverloadListener() {
        removeOverloadListener()
        guard let id = AudioDeviceID(outputDevice().id), id != kAudioObjectUnknown else { return }
        var property = AudioObjectPropertyAddress(mSelector: kAudioDeviceProcessorOverload,
                                                 mScope: kAudioObjectPropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(id, &property) else { return }
        let block: AudioObjectPropertyListenerBlock = { @Sendable [weak self] _, _ in
            MainActor.assumeIsolated { self?.noteProcessorOverload() }
        }
        guard AudioObjectAddPropertyListenerBlock(id, &property, DispatchQueue.main, block) == noErr else { return }
        overloadListener = (id, block)
    }
    private func removeOverloadListener() {
        guard let listener = overloadListener else { return }
        var property = AudioObjectPropertyAddress(mSelector: kAudioDeviceProcessorOverload,
                                                 mScope: kAudioObjectPropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        AudioObjectRemovePropertyListenerBlock(listener.device, &property, DispatchQueue.main, listener.block)
        overloadListener = nil
    }

    /// C-AUDIOMARK 1: what a mark records from inside a call: the voice stage as it really is, the
    /// engine generation this mark belongs to, the last graph change, the ducking asked for and read
    /// back, the recent played window and the call's overload count.
    func distortionMark(loadAverage: (Double, Double, Double)) -> NativeDistortionMark {
        let window = playedFrames > 0
            ? (peak: playedPeak, rms: playedFrames > 0 ? (playedSumSquares / Double(playedFrames)).squareRoot() : 0,
               over: playedOverSamples, flatTops: playedFlatTopRuns)
            : nil
        return NativeDistortionMark(
            output: volumeReading(), voiceProcessing: isVoiceProcessingEnabled,
            bypassReason: isVoiceProcessingEnabled ? "none" : voiceProcessingBypass,
            engineGeneration: engineGeneration, lastChange: lastChange,
            duckingRequested: duckingRequestedText, duckingReadBack: duckingReadBackText,
            peakDb: window.map { Self.dB($0.peak) } ?? "unknown",
            rmsDb: window.map { Self.dB($0.rms) } ?? "unknown",
            overSamples: window?.over ?? 0, flatTopRuns: window?.flatTops ?? 0,
            processorOverloads: processorOverloads, loadAverage: loadAverage)
    }

    /// Test seam: close the open played window now, so the window arithmetic is provable without a
    /// five second wait. Production closes it from its own timer only.
    func flushPlaybackLevelForTesting() { flushPlaybackLevel() }
    /// L12b: one `playback_level` receipt per window of audio Naya actually played, off the audio path.
    /// A window with no frames has no level, so it leaves no line rather than a floor of silence.
    private func flushPlaybackLevel() {
        let frames = playedFrames, peak = playedPeak, sumSquares = playedSumSquares
        let over = playedOverSamples, flatTops = playedFlatTopRuns
        playedFrames = 0; playedPeak = 0; playedSumSquares = 0
        playedOverSamples = 0; playedFlatTopRuns = 0; resetFlatTopTracking()
        guard frames > 0 else { return }
        let volume = volumeReading().fields
        // C-AUDIOMARK 4: the same receipt now says what the slider read, whether the voice stage was
        // on, how many samples reached -3 dBFS and how many flat tops the decode walk saw.
        log("playback_level", ["peakDb": Self.dB(peak), "rmsDb": Self.dB((sumSquares / Double(frames)).squareRoot()),
                               "frames": String(frames), "outputVolume": volume["outputVolume"] ?? "unknown",
                               "voiceProcessing": voiceProcessingText,
                               "overSamples": String(over), "flatTopRuns": String(flatTops)])
    }
    /// A level as decibels, floored at the silence floor, so a digital zero reads as the floor and not as -inf.
    private static func dB(_ level: Double) -> String {
        let value = level > 0 ? 20 * log10(level) : silenceFloorDb
        return String(format: "%.1f", max(silenceFloorDb, value))
    }
    private func startPlaybackLevelWindow() {
        playbackLevelTask?.cancel()
        playbackLevelTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: UInt64(Self.playbackLevelWindowMs) * 1_000_000) }
                catch { return }
                guard let self, !Task.isCancelled else { return }
                self.flushPlaybackLevel()
            }
        }
    }
    private func stopPlaybackLevelWindow() {
        playbackLevelTask?.cancel(); playbackLevelTask = nil
        playedFrames = 0; playedPeak = 0; playedSumSquares = 0
        playedOverSamples = 0; playedFlatTopRuns = 0; resetFlatTopTracking()
    }
    /// C-AUDIOMARK 4: a flat top is a run of the same loud sample. The tracking is two scalars, so the
    /// decode walk that already runs allocates nothing and the audio thread stays free of locks.
    private func resetFlatTopTracking() { lastDecodedSample = 0; inFlatTop = false }
    private func trackFlatTop(_ sample: Int16, magnitude: Double) {
        let loud = magnitude >= Self.overSampleThreshold
        if loud { playedOverSamples += 1 }
        let continues = loud && sample == lastDecodedSample
        if continues && !inFlatTop { playedFlatTopRuns += 1; inFlatTop = true }
        if !continues { inFlatTop = false }
        lastDecodedSample = sample
    }
    /// C-HEADPHONES 1: the device this call captures from, chosen by id: the built-in microphone
    /// whenever the machine has one, else the system default input as an announced fallback.
    private var captureDevice: (id: String, name: String) { builtInInput() ?? inputDevice() }
    /// C-HEADPHONES 5: the capture policy this call runs under, as the two logs report it.
    var inputPolicy: String { builtInInput() == nil ? "fallback" : "built_in" }
    /// The microphone this call records from, so the owner's status text can name it.
    var captureName: String { captureDevice.name }
    var inputPolicyDetail: [String: String] {
        ["policy": inputPolicy, "reason": builtInInput() == nil ? "built_in_missing" : "built_in_available",
         "device": captureDevice.name]
    }
    /// C-HEADPHONES 1: the one status line the owner sees when no built-in microphone exists (lid
    /// closed, desktop Mac). Never silent: the call says which microphone carries it.
    static func inputPolicyNotice(_ name: String) -> String {
        "Using " + name + " microphone, built-in not available"
    }
    func routeChanged() {
        let input = captureDevice
        let output = outputDevice()
        route = "Microphone: " + input.name + " · Output: " + output.name
        // C-AUDIOMARK 1: the last graph change a mark will report, as a closed reason word.
        lastChange = "route_change"
        guard !rebuilding else {
            log("audio_route_change_ignored", ["reason": "busy"]); return
        }
        guard !muteHoldsMicrophone else {
            log("audio_route_change_ignored", ["reason": "muted"]); return
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
        // An output-only change moves playback and leaves capture on its own device (C-HEADPHONES 2).
        if output.id != startOutputID {
            pendingOutputSwitch = (from: transportOf(startOutputID), at: now())
        }
        recovery.changed()
        scheduleResume()
    }
    /// C-HEADPHONES 2 and 5: the rebuild landed on the new default output, so the switch is
    /// recorded with the transports it moved between and how long the rebuild took.
    private func finishOutputSwitch() {
        guard let pending = pendingOutputSwitch else { return }
        pendingOutputSwitch = nil
        let ms = Int(now().timeIntervalSince(pending.at) * 1000)
        let from = pending.from, to = transportOf(startOutputID)
        log("audio_output_switched", ["from": from, "to": to, "ms": String(ms)])
        onOutputSwitched?(from, to, ms)
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
    private func installConfigurationObserver(object: AVAudioEngine?, token: UInt64? = nil) {
        let token = token ?? captureGeneration
        // C-MICWATCH 2: a change posted during a start that then failed belongs to no engine.
        let engineID = object.map(ObjectIdentifier.init)
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: object, queue: nil) { [weak self] _ in
            Task { @MainActor in
                self?.noteConfigurationChange(engineID: engineID, token: token)
            }
        }
    }
    /// C-AUDIO 2 and 4: one notification. Inside a release settle it marks the change the settle must
    /// wait for; otherwise it counts the changes a start saw and routes them.
    private func noteConfigurationChange(engineID: ObjectIdentifier?, token: UInt64) {
        lastChange = "configuration_change"
        // A configuration change that lands inside a release settle is exactly what the settle waits
        // for, so nothing resets or builds on top of it.
        if settling {
            if engineID == nil || engineID == settledEngine.map(ObjectIdentifier.init) {
                configurationChangePending = true
            }
            return
        }
        guard captureGeneration == token,
              engineID == nil || engineID == engine.map(ObjectIdentifier.init) else { return }
        // How many of these the start itself saw.
        if starting { configChangesDuringStart += 1 }
        routeChanged()
    }
    /// A configuration change delivered through the same path the observer uses. Tests prove the
    /// bounded wait with it; no test waits on a real notification.
    func configurationChangeForTesting() {
        noteConfigurationChange(engineID: settledEngine.map(ObjectIdentifier.init), token: captureGeneration)
    }
    /// Waits for a route recovery in flight, and for the rebuild a resume schedules behind it (#1101:
    /// that rebuild is async now, because it waits the release settle out first).
    func finishRouteRecovery() async {
        for _ in 0..<4 {
            await recovery.pending?.value
            await resumeTask?.value
            await awaitSettle()
            if recovery.pending == nil { return }
        }
    }
    private var sendFrame: (@Sendable (Data, UInt64) async throws -> Void)?
    private(set) var captureEpoch: UInt64 = 0
    private lazy var recovery = NativeAudioRouteRecovery(
        input: { [unowned self] in self.captureDevice.id },
        release: { [weak self] in self?.releaseAudio() },
        rebuild: { [weak self] in
            guard let self, !self.muteHoldsMicrophone, let send = self.sendFrame else {
                throw NativeLiveAudioError.captureNotConfigured
            }
            // C-AUDIO 2: route recovery is a release-then-build path: the settle is waited out
            // first, so the new engine never opens while the old one's teardown is in flight.
            await self.awaitSettle()
            guard !self.muteHoldsMicrophone, self.sendFrame != nil else {
                throw NativeLiveAudioError.captureNotConfigured
            }
            try self.build(send: send)
            self.finishOutputSwitch()
        },
        paused: { [weak self] _ in guard let self else { return }; self.onInputChange?(self.captureDevice.name) },
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
        return transportLabel(transport)
    }
    /// The one transport vocabulary both the route line and the switch record use.
    nonisolated private static func transportLabel(_ transport: UInt32) -> String {
        switch transport {
        case kAudioDeviceTransportTypeBuiltIn: return "built-in"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "Bluetooth"
        case kAudioDeviceTransportTypeUSB: return "USB"
        case kAudioDeviceTransportTypePCI, kAudioDeviceTransportTypeFireWire, kAudioDeviceTransportTypeThunderbolt: return "external wired"
        default: return "unknown"
        }
    }
    /// C-HEADPHONES 5: the transport token of one device id, so a switch says what it moved to.
    static func transportType(ofDeviceID id: String) -> String {
        guard let device = UInt32(id), device != kAudioObjectUnknown else { return "injected" }
        var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var transport = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &transport) == noErr else { return "unknown" }
        return transportLabel(transport)
    }
    /// C-HEADPHONES 1: the built-in microphone this Mac has, or nil when it has none (lid closed,
    /// desktop Mac). Read by id and input scope only: a headset can never answer as built in.
    static func builtInMicrophone() -> (id: String, name: String)? {
        for device in deviceList() where deviceTransport(device) == kAudioDeviceTransportTypeBuiltIn
            && inputChannels(device) > 0 {
            return (String(device), deviceName(device))
        }
        return nil
    }
    private static func deviceList() -> [AudioDeviceID] {
        var property = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size) == noErr,
              size > 0 else { return [] }
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &devices) == noErr
        else { return [] }
        return devices
    }
    nonisolated private static func deviceTransport(_ device: AudioDeviceID) -> UInt32 {
        var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var transport = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &transport) == noErr else { return kAudioObjectUnknown }
        return transport
    }
    private static func inputChannels(_ device: AudioDeviceID) -> Int {
        var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(device, &property, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let list = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { list.deallocate() }
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, list) == noErr else { return 0 }
        let buffers = UnsafeMutableAudioBufferListPointer(list.assumingMemoryBound(to: AudioBufferList.self))
        return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
    }
    private static func deviceName(_ device: AudioDeviceID) -> String {
        var property = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &name) {
            AudioObjectGetPropertyData(device, &property, 0, nil, &size, $0)
        }
        guard status == noErr, let value = name?.takeRetainedValue() else { return "Built-in Microphone" }
        return value as String
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
    /// The default output's UID: a stable device identifier, never a person's name.
    static func defaultOutputUID() -> String {
        let device = defaultDeviceID(input: false)
        guard device != kAudioObjectUnknown else { return "unknown" }
        return deviceUID(device)
    }
    /// One device's UID, or `unknown` when it refuses the getter.
    nonisolated static func deviceUID(_ device: AudioDeviceID) -> String {
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var uid: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &uid) == noErr,
              let value = uid?.takeRetainedValue() else { return "unknown" }
        return value as String
    }
    /// C-AUDIOMARK 0b: the output device, its transport and every volume control it publishes, read
    /// through CoreAudio getters in one pass. Nothing here writes a device property, and a device with
    /// no master control still reports the controls it does have.
    nonisolated static func outputVolumeSnapshot(device: AudioDeviceID? = nil) -> NativeOutputVolumeSnapshot {
        let id = device ?? defaultDeviceID(input: false)
        guard id != kAudioObjectUnknown else {
            return NativeOutputVolumeSnapshot(uid: "unknown", transport: "unknown", controls: [])
        }
        let controls = [kAudioObjectPropertyElementMain, 1, 2].compactMap { element -> NativeVolumeControl? in
            var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                                     mScope: kAudioObjectPropertyScopeOutput, mElement: element)
            guard AudioObjectHasProperty(id, &property) else { return nil }
            return NativeVolumeControl(element: Int(element),
                                       scalar: outputScalar(id, kAudioDevicePropertyVolumeScalar, element: element))
        }
        return NativeOutputVolumeSnapshot(uid: deviceUID(id), transport: transportLabel(deviceTransport(id)),
                                          controls: controls)
    }
    func resumeInput() {
        guard !muteHoldsMicrophone else { return }
        recovery.resume()
        // #1101: the rebuild a resume starts waits the release settle out, so the owner hears about
        // the resume once the engine is really back, never before it exists.
        if let pending = recovery.pending {
            Task { @MainActor [weak self] in
                await pending.value
                await self?.awaitSettle()
                guard let self, !self.muteHoldsMicrophone, self.isCapturing else { return }
                self.onResume?()
            }
            return
        }
        if isCapturing { onResume?() }
    }

    /// L12a: the default output's volume scalar and mute flag as this release found them, read through
    /// CoreAudio getters on the output scope and never written. `unknown` when the device or a getter
    /// refuses, so a quiet call leaves a receipt instead of a guess about what it inherited.
    static func defaultOutputLevel() -> (volume: String, mute: String) {
        let device = defaultDeviceID(input: false)
        guard device != kAudioObjectUnknown else { return outputLevelText(volume: nil, mute: nil) }
        let virtualMain = outputScalar(device, kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
        let main = outputScalar(device, kAudioDevicePropertyVolumeScalar)
        let channels = [outputScalar(device, kAudioDevicePropertyVolumeScalar, element: 1),
                        outputScalar(device, kAudioDevicePropertyVolumeScalar, element: 2)].compactMap { $0 }
        let volume = virtualMain ?? main ?? (channels.isEmpty ? nil : channels.reduce(0, +) / Float(channels.count))
        let mute = outputFlag(device, kAudioDevicePropertyMute)
            ?? outputFlag(device, kAudioDevicePropertyMute, element: 1)
        return outputLevelText(volume: volume, mute: mute)
    }
    /// The closed text of one output reading: a scalar inside 0...1 to two decimals and a boolean mute,
    /// and `unknown` for whichever getter refused, so a missing reading is never a zero and never a crash.
    static func outputLevelText(volume: Float?, mute: UInt32?) -> (volume: String, mute: String) {
        (volume.map { String(format: "%.2f", min(1, max(0, $0))) } ?? "unknown",
         mute.map { $0 == 0 ? "false" : "true" } ?? "unknown")
    }
    nonisolated private static func outputScalar(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector,
                                     element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> Float? {
        var property = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeOutput,
                                                  mElement: element)
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }
    private static func outputFlag(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector,
                                   element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> UInt32? {
        var property = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeOutput,
                                                  mElement: element)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &property, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    /// A1-R2: true when the default input or output device is already running somewhere else.
    /// The reading is taken at call start, before Didi starts any engine, so it reflects other apps only.
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
    nonisolated static func defaultDeviceID(input: Bool) -> AudioDeviceID {
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
    /// Enables voice processing once, on the input node only, and returns with the mode in force on
    /// both IO nodes. AVAudioIONode.h: "Voice processing requires both input and output nodes to be
    /// in the voice processing mode. Enabling this mode on either of the IO nodes automatically
    /// enables it on the other IO node." Enabling the output node as well was a second graph change
    /// for a state change the input node had already made.
    ///
    /// The caller applies the ducking configuration first (`build`) so this enable is the last graph
    /// change before the player is attached.
    private static func enableVoiceProcessing(engine: AVAudioEngine) throws {
        do { try engine.inputNode.setVoiceProcessingEnabled(true) }
        catch { throw NativeLiveAudioError.voiceProcessingFailed(code: (error as NSError).code) }
        guard engine.inputNode.isVoiceProcessingEnabled, engine.outputNode.isVoiceProcessingEnabled else {
            throw NativeLiveAudioError.voiceProcessingFailed(code: nil)
        }
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
    /// C-AUDIOMARK 1: a ducking configuration in one closed word pair, so the requested and the
    /// read-back value sit side by side in a mark.
    static func duckingText(_ configuration: AVAudioVoiceProcessingOtherAudioDuckingConfiguration) -> String {
        let level: String
        switch configuration.duckingLevel {
        case .min: level = "min"
        case .mid: level = "mid"
        case .max: level = "max"
        default: level = "default"
        }
        return "advanced=\(configuration.enableAdvancedDucking.boolValue ? 1 : 0),level=\(level)"
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
    private(set) var captureGeneration: UInt64 = 0
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
        // C-AUDIO 2: a start is a release-then-build path too. It waits out any settle a release left
        // running, so the next engine never opens while the previous one is still held and still in
        // CoreAudio teardown (STAGE3-2).
        await awaitSettle()
        try Task.checkCancellation()
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
        voiceProcessingFailed = false; sessionFailed = false; lastRebuildAt = nil; stallRestarted = false; inputStallFailed = false
        // C-AUDIOMARK 0b and 3: the volume this call inherits, before any preparation, and the
        // overload count of the call that starts here.
        processorOverloads = 0; lastChange = "none"
        logOutputVolume("before_prepare")
        // C-AUDIO 4: engine starts are counted per call, so a rebuilt graph inside one call shows up.
        engineStartCount = 0; configChangesDuringStart = 0
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
    /// C-AUDIO 1: the playback graph as one recorded step. It is built after voice processing is
    /// enabled and ducked, so the attach and the connect never reconfigure the unit.
    private func connectPlaybackGraph(_ engine: AVAudioEngine, _ player: AVAudioPlayerNode)
        throws -> AVAudioUnitTimePitch? {
        let stretch = try Self.connectPlayback(engine: engine, player: player,
                                               outputNode: engine.outputNode, rate: sessionRate)
        graphBuildSteps.append("player_attached")
        return stretch
    }
    private func build(send: @escaping @Sendable (Data, UInt64) async throws -> Void) throws {
        let input = captureDevice
        guard !input.id.isEmpty else { throw NativeLiveAudioError.deviceMissing }
        startInputID = input.id
        startOutputID = outputDevice().id
        startInputRate = Self.nominalSampleRate(input: true)
        startOutputRate = Self.nominalSampleRate(input: false)
        // C-HEADPHONES 5: one line per build saying which microphone policy this capture runs under.
        log("audio_input_policy", inputPolicyDetail)
        if let captureInput, engineFactoryForTesting == nil {
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: captureInput))
            capture.setMuted(muted); self.capture = capture
            activateCapture(capture, send: send)
            installConfigurationObserver(object: nil)
            return
        }
        // Zero-retry circuit breaker: a failed start never rebuilds within the session.
        guard !sessionFailed else { throw NativeLiveAudioError.engineFailed(code: 0) }
        // A mute that landed before capture existed still holds the microphone: unmute opens the engine.
        guard !muteHoldsMicrophone else {
            isCapturing = true
            log("audio_muted_start_skipped", ["epoch": String(captureEpoch)])
            return
        }
        do { try owner.acquire(holder: ObjectIdentifier(self)) }
        catch let refusal as AudioOwnerError {
            log("audio_refused", ["reason": refusal.rawValue])
            throw refusal
        }
        var ready = false
        defer { if !ready { releaseAudio() } }

        // A1-R2: voice processing only on built-in speakers and only when no other app held the
        // device at call start. The snapshot is taken before the connecting ring starts its own
        // engine, so Didi's own ring never makes this reading look like another app (#1022).
        let builtInOutput = isBuiltInOutput()
        let deviceBusy = outsideBusyAtCallStart ?? (deviceState(true) || deviceState(false))
        let useVoiceProcessing = Self.shouldUseVoiceProcessing(
            outputIsBuiltInSpeakers: builtInOutput, deviceBusy: deviceBusy,
            voiceProcessingFailed: voiceProcessingFailed)
        if !useVoiceProcessing {
            voiceProcessingBypass = Self.vpioSkipReason(builtIn: builtInOutput, deviceBusy: deviceBusy,
                                                       voiceProcessingFailed: voiceProcessingFailed)
            log("audio_vpio_skipped", ["reason": voiceProcessingBypass])
        } else {
            voiceProcessingBypass = "none"
        }
        // C-AUDIOMARK 1: the ducking this build asks for, next to what CoreAudio reads back after the
        // enable, so a mark can say which of the two the owner was hearing.
        duckingRequestedText = useVoiceProcessing ? Self.duckingText(Self.minimumDuckingConfiguration()) : "none"
        duckingReadBackText = "none"
        // C-AUDIO 1 and 4: the steps of this build, in order, and the configuration changes seen
        // while it starts. Reset here so `audio_graph_built` reports one build, not a call history.
        graphBuildSteps = []; configChangesDuringStart = 0; starting = true
        var engine = AVAudioEngine(), player = AVAudioPlayerNode()
        var stretch: AVAudioUnitTimePitch?
        // C-HEADPHONES 1 and 6: capture is pinned to the chosen device by id before any format is
        // read, so a default-input change can never move the microphone mid-call and the headset
        // microphone is never opened. A refused pin is journaled, never silent.
        if engineFactoryForTesting == nil, let device = UInt32(input.id), device != kAudioObjectUnknown,
           Self.defaultDevice(input: true).id != input.id {
            do { try engine.inputNode.auAudioUnit.setDeviceID(device) }
            catch { log("audio_input_device_pin_failed", ["device": input.id]) }
        }
        var hardware = engine.inputNode.outputFormat(forBus: 0)
        if let factory = engineFactoryForTesting {
            (engine, player, hardware) = factory()
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                throw NativeLiveAudioError.formatUnavailable
            }
            if useVoiceProcessing {
                // C-AUDIO 1: ducking, then the one enable, then the player is attached and
                // connected. Nothing reconfigures the unit after the graph is built.
                Self.applyMinimumDucking(to: engine.inputNode)
                graphBuildSteps.append("ducking")
                try Self.enableVoiceProcessing(engine: engine)
                graphBuildSteps.append("voice_processing")
            }
            // The fake-engine seam builds the same playback graph the hardware path does, so a test
            // proves the order the real start uses instead of a shape only tests have.
            stretch = try connectPlaybackGraph(engine, player)
        } else if useVoiceProcessing {
            do {
                Self.applyMinimumDucking(to: engine.inputNode)
                graphBuildSteps.append("ducking")
                try Self.enableVoiceProcessing(engine: engine)
                graphBuildSteps.append("voice_processing")
                hardware = engine.inputNode.outputFormat(forBus: 0)
                guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                    throw NativeLiveAudioError.formatUnavailable
                }
                stretch = try connectPlaybackGraph(engine, player)
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
                stretch = try connectPlaybackGraph(engine, player)
            }
        } else {
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                throw NativeLiveAudioError.formatUnavailable
            }
            stretch = try connectPlaybackGraph(engine, player)
        }
        self.engine = engine; self.player = player; self.timePitch = stretch
        var capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: hardware))
        capture.setMuted(muted); self.capture = capture
        // Tap format is the input node's current output format at install time, never one
        // captured before voice processing was enabled.
        if engineFactoryForTesting == nil {
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware, block: capture.makeTap())
            tapInstalled = true
        }
        // C-AUDIO 1: exactly one prepare per build, before start. The fake-engine path records the
        // step through prepareForTesting and never touches the device.
        if engineFactoryForTesting == nil {
            engine.prepare()
            graphBuildSteps.append("prepare")
        } else if let prepareForTesting {
            prepareForTesting(engine)
            graphBuildSteps.append("prepare")
        }
        if engineFactoryForTesting == nil {
            // C-MICWATCH 3: the format is read again once the graph is prepared. Only a format that
            // settled differently replaces the tap and converter; an unchanged one touches nothing.
            let prepared = engine.inputNode.outputFormat(forBus: 0)
            if prepared.sampleRate > 0, prepared.channelCount > 0, !NativePCMConverter.sameShape(prepared, hardware) {
                log("audio_input_format_settled", ["fromChannels": String(hardware.channelCount),
                                                   "toChannels": String(prepared.channelCount),
                                                   "fromSampleRate": String(Int(hardware.sampleRate)),
                                                   "toSampleRate": String(Int(prepared.sampleRate))])
                engine.inputNode.removeTap(onBus: 0)
                hardware = prepared
                capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: hardware))
                capture.setMuted(muted); self.capture = capture
                engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware, block: capture.makeTap())
            }
        }
        // C-MICWATCH 2: observe configuration changes before the engine starts, so a change posted
        // during start reaches the route logic. The token is the generation activateCapture opens.
        installConfigurationObserver(object: engine, token: captureGeneration &+ 1)
        do {
            if let startForTesting { try startForTesting(engine) } else { try engine.start() }
        } catch {
            starting = false
            sessionFailed = true
            log("audio_start_failed", ["code": String((error as NSError).code)])
            throw (error as? NativeLiveAudioError) ?? NativeLiveAudioError.engineFailure(error as NSError)
        }
        engineStartCount += 1
        graphBuildSteps.append("start")
        owner.didStartEngine(holder: ObjectIdentifier(self))
        startPlaybackLevelWindow()
        // L12a: what the default output is set to, read only, next to the route it will play on.
        let reading = outputLevelReading()
        log("audio_started", ["voiceProcessing": useVoiceProcessing ? "true" : "false",
                              "busyAtCallStart": deviceBusy ? "true" : "false",
                              "outputTransport": Self.routeClassification(input: false),
                              "outputUID": Self.defaultOutputUID(),
                              "outputVolume": reading.volume,
                              "outputMute": reading.mute])
        // C-AUDIO 4: the graph this call actually built, in order, with the configuration-change
        // notifications seen inside the start. Owner evidence: one line proves or refutes a fix.
        log("audio_graph_built", ["steps": graphBuildSteps.joined(separator: ","),
                                  "voiceProcessing": useVoiceProcessing ? "true" : "false",
                                  "configChanges": String(configChangesDuringStart),
                                  "starts": String(engineStartCount)])
        starting = false
        // C-AUDIOMARK 0b and 1: the route is chosen, the voice stage is enabled and the engine runs,
        // so the device, its transport and its volumes are recorded here, and the ducking read back.
        engineGeneration += 1
        if useVoiceProcessing { duckingReadBackText = Self.duckingText(engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration) }
        installOverloadListener()
        logOutputVolume("after_route_selection")
        // One rate receipt per session accompanies the queue measurements.
        log("playback_rate", ["rate": NativePlaybackRate.label(sessionRate)])
        // Playback starts in write(_:) only after the prebuffer fills, never on an empty queue.
        route = "Microphone: " + input.name + " · Output: " + outputDevice().name
        activateCapture(capture, send: send)
        ready = true
        armFirstBufferWatchdog(capture, voiceProcessing: useVoiceProcessing, format: hardware)
    }
    /// C-MICWATCH 1: no tap buffer within the window after start means the graph is not running. The
    /// first stall restarts once without voice processing (the decision the throw fallback takes); a
    /// stall after that ends the start as a named engine failure, so the call fails visibly instead
    /// of presenting live with a dead microphone. A start with buffers only reads one counter.
    private func armFirstBufferWatchdog(_ capture: NativeCaptureBuffer, voiceProcessing: Bool, format: AVAudioFormat) {
        firstBufferWatchdog?.cancel(); firstBufferWatchdog = nil
        let window: Duration
        if engineFactoryForTesting == nil { window = .milliseconds(Self.firstBufferWindowMs) }
        else if let testing = firstBufferWindowForTesting { window = testing }
        else { return }
        let token = captureGeneration
        let armed = ContinuousClock.now
        firstBufferWatchdog = Task { [weak self] in
            try? await Task.sleep(for: window)
            guard !Task.isCancelled, let self, self.captureGeneration == token, !capture.hasReceivedBuffer else { return }
            // Detach this task from the device first, so the release below never cancels it mid-step.
            self.firstBufferWatchdog = nil
            await self.inputStalled(voiceProcessing: voiceProcessing, format: format,
                                    waitedMs: Int(armed.duration(to: .now) / .milliseconds(1)))
        }
    }
    private func inputStalled(voiceProcessing: Bool, format: AVAudioFormat, waitedMs: Int) async {
        let send = sendFrame
        let restart = !stallRestarted && send != nil
        log("audio_input_stalled", ["voiceProcessing": voiceProcessing ? "true" : "false",
                                    "inputChannels": String(format.channelCount),
                                    "sampleRate": String(Int(format.sampleRate)),
                                    "waitedMs": String(waitedMs),
                                    "action": restart ? "restart_without_voice_processing" : "failed"])
        if restart, let send {
            stallRestarted = true
            voiceProcessingFailed = true
            releaseAudio(keepingSlot: true)
            // C-AUDIO 2: the restart waits out the release settle before it builds again.
            let token = captureGeneration
            await awaitSettle()
            // The settle can outlive the engine it covered: a mute, a stop or a route change inside
            // that window owns the microphone now, and a late restart must not resurrect it.
            guard captureGeneration == token, !muted, engine == nil else { return }
            do { try build(send: send); return } catch { sessionFailed = true }
        }
        sessionFailed = true
        inputStallFailed = true
        sendFrame = nil
        let token = captureGeneration
        Task { @MainActor [weak self] in
            guard let self, self.captureGeneration == token else { return }
            await self.interrupt(NativeLiveAudioError.engineFailed(code: 0))
        }
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
        if muted {
            turnGeneration &+= 1; flushOutput()
            releaseCaptureForMute()
        } else {
            // C-AUDIO 2: the rebuild behind an unmute waits the release settle out, so it never
            // builds on top of CoreAudio's teardown of the engine the mute just stopped.
            let id = nextResumeID
            nextResumeID &+= 1
            resumeFromMuteTasks[id] = Task { @MainActor [weak self] in
                await self?.resumeCaptureFromMute()
                self?.resumeFromMuteTasks[id] = nil
            }
        }
    }
    /// Every unmute rebuild a setMuted(false) started, for a caller that must see them land.
    func finishMuteResumeForTesting() async {
        while !resumeFromMuteTasks.isEmpty {
            for task in Array(resumeFromMuteTasks.values) { await task.value }
        }
        await awaitSettle()
    }
    /// Muting hands the microphone back to the machine: another app must be able to run its own
    /// capture, so the engine, the tap and the voice-processing unit all go while the call stays warm.
    private func releaseCaptureForMute() {
        muteHoldsMicrophone = engine != nil || opensHardware
        mutedAt = now()
        guard engine != nil else { return }
        releaseAudio(keepingSlot: true)
        log("audio_muted_release", ["generation": String(captureGeneration),
                                    "epoch": String(captureEpoch)])
    }
    /// Unmute rebuilds capture alone: same conversation, same provider session, no ring, no reconnect.
    private func resumeCaptureFromMute() async {
        guard muteHoldsMicrophone, !muted else { return }
        muteHoldsMicrophone = false
        guard let send = sendFrame else {
            log("audio_muted_reacquire_skipped", ["reason": "no_send"]); return
        }
        let requested = now()
        await awaitSettle()
        guard !muted else { muteHoldsMicrophone = true; return }
        do { try build(send: send) }
        catch {
            log("audio_muted_reacquire_failed",
                ["reason": (error as? AudioOwnerError)?.rawValue ?? "build_failed"])
            sendFrame = nil
            Task { @MainActor [weak self] in await self?.interrupt(error) }
            return
        }
        let waited = mutedAt.map { Int(requested.timeIntervalSince($0) * 1000) } ?? 0
        let acquired = Int(now().timeIntervalSince(requested) * 1000)
        mutedAt = nil
        log("audio_muted_reacquire", ["generation": String(captureGeneration),
                                      "epoch": String(captureEpoch),
                                      "waitMs": String(waited), "acquireMs": String(acquired)])
    }
    /// #283: the orb frame for this instant: the owner's latest capture window (silent once older than
    /// 200 ms or while muted) and the model output window at the playback position.
    func orbBands() -> (input: NativeOrbBands, output: NativeOrbBands) {
        let now = nowMs()
        let input = !muted && now - inputBandsAtMs <= 200 ? inputBands : .silent
        let renderTime = player?.lastRenderTime
        let clock = renderTime.flatMap { player?.playerTime(forNodeTime: $0) }
        return (input, outputOrb.sample(renderedSample: clock?.sampleTime, sampleRate: clock?.sampleRate ?? Double(NativePlaybackQueue.frameRate)))
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
        var peak: Double = 0
        pcm.withUnsafeBytes { bytes in
            for sample in bytes.bindMemory(to: Int16.self) {
                let value = Double(Int16(littleEndian: sample)) / 32768; sum += value * value
                let magnitude = abs(value); if magnitude > peak { peak = magnitude }
                // C-AUDIOMARK 4: two counters on the same walk, no allocation, nothing stored.
                trackFlatTop(Int16(littleEndian: sample), magnitude: magnitude)
            }
        }
        // L12b: the same decode the level already walks feeds the played window, so the render thread
        // sees no new code: two sums and a count, no allocation and no lock.
        if frames > 0 { playedPeak = max(playedPeak, peak); playedSumSquares += sum; playedFrames += frames }
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
            emitReceipt(.started, segment: playbackSegment)
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
        // L12b: the window that was open at the end is reported before the call is gone.
        flushPlaybackLevel()
        stopPlaybackLevelWindow()
        // C-AUDIOMARK 0b and 3: the volume the call ended on and the call's overload count, written
        // before the graph is released, then the listener leaves with the device.
        logOutputVolume("after_teardown")
        removeOverloadListener()
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
    private func releaseAudio(keepingSlot: Bool = false) {
        cancelWaitCue(.interrupted(atMs: nowMs()), stopPlayer: true)
        rebuilding = true; defer { rebuilding = false }
        captureGeneration &+= 1
        firstBufferWatchdog?.cancel(); firstBufferWatchdog = nil
        if let capture { captureStatistics.add(capture.stop()) }
        drain?.cancel(); drain = nil; capture = nil
        flushOutput()
        if let engine {
            if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
            engine.stop()
        }
        // C-AUDIO 2: the engine and player handles stay alive for the settle interval, and the
        // configuration observer stays installed with them, so a change that lands inside CoreAudio's
        // own teardown is seen and waited for. Reset and release happen in `settleRelease`.
        // A second release inside the settle must never overwrite the parked handle with nil: the
        // settle that is already running still owns it (STAGE3-3).
        if engine != nil {
            settledEngine = engine; settledPlayer = player
            engine = nil; player = nil
        }
        // Only a settle holds the handles, and only a settle needs the observer. A release with nothing
        // to hold removes it here so it can never outlive the engine it watched.
        if settledEngine != nil { beginSettle() } else { removeConfigurationObserver() }
        // #476: the owner writes the one audio_released for the lease it held. A device line beside it
        // made every release two identical records in audio.log.
        owner.release(holder: ObjectIdentifier(self))
        isCapturing = keepingSlot; inputLevel = 0; outputLevel = 0; isPlayingOutput = false
        if !keepingSlot { muteHoldsMicrophone = false }
        inputBands = .silent; outputOrb.reset()
        audioReleaseCount += 1
    }
    /// C-AUDIO 2: keeps the released handles alive for the settle interval. Every release-then-build
    /// path awaits `awaitSettle()` first, so two engines are never alive at once.
    private func beginSettle() {
        // One settle owns the parked handle. A release that lands inside it leaves that settle to
        // finish, rather than racing a second one over the same engine (STAGE3-3).
        guard !settling else { return }
        settling = true
        configurationChangePending = false
        settleDeviceIDs = (inputDevice().id, outputDevice().id)
        settleGeneration &+= 1
        settleTask = Task { @MainActor [weak self] in await self?.settleRelease() }
    }
    /// Awaits the settle a release started. Returns at once when nothing is settling.
    func awaitSettle() async {
        while let task = settleTask {
            let generation = settleGeneration
            await task.value
            if settleGeneration == generation { return }
        }
    }
    func settleForTesting() async { await awaitSettle() }
    /// Whether a release settle is holding the engine handles right now.
    var isSettling: Bool { settling }
    /// Whether a released engine and player are still parked for the settle that owns them.
    var holdsSettledHandle: Bool { settledEngine != nil }
    private func settleRelease() async {
        guard settledEngine != nil else { settling = false; settleTask = nil; return }
        // C-AUDIO 2: start at 250 ms, then wait out an in-flight configuration change or a default
        // device that is still moving, bounded at one second so a release is never held forever.
        var waitedMs = Self.releaseSettleMs
        await settleWait(.milliseconds(Self.releaseSettleMs))
        while (configurationChangePending || defaultDeviceMoved()) && waitedMs < Self.settleConfigWaitLimitMs {
            configurationChangePending = false
            await settleWait(.milliseconds(Self.settleConfigPollMs))
            waitedMs += Self.settleConfigPollMs
        }
        let pending = configurationChangePending
        configurationChangePending = false
        settleWaitedMs = waitedMs
        settledEngine?.reset()
        engineResetCount += 1
        weak let retained = settledEngine
        settledEngine = nil; settledPlayer = nil
        removeConfigurationObserver()
        settling = false
        settleTask = nil
        settledReleaseCount += 1
        log("audio_release_settled", ["settleMs": String(waitedMs),
                                      "configChangePending": pending ? "true" : "false",
                                      "starts": String(engineStartCount)])
        if retained != nil { log("audio_release_leak", ["reason": "engine_retained"]) }
    }
    /// Drops the configuration observer. A release keeps it while a settle holds the engine, because a
    /// change that lands inside CoreAudio's teardown is exactly what the settle waits for.
    private func removeConfigurationObserver() {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
    }
    /// Every settle wait goes through one seam, so a test records it and never sleeps.
    private func settleWait(_ duration: Duration) async {
        if let settleWaitForTesting { await settleWaitForTesting(duration); return }
        try? await Task.sleep(for: duration)
    }
    /// True when the default input or output moved since the last poll: a device change in flight.
    private func defaultDeviceMoved() -> Bool {
        let current = (input: inputDevice().id, output: outputDevice().id)
        defer { settleDeviceIDs = current }
        return current != settleDeviceIDs
    }
}

/// C-AUDIOMARK 2: a read-only watcher of the current output device that runs whether or not a call
/// is. On every default-device change it records the new device, its transport and its volumes, and
/// it rebinds its volume listener to that device; on every volume property notification it records
/// the volumes it reads. A notification does not say who changed the value, so no record claims a
/// writer, and nothing here writes a device property.
///
/// Every listener block runs on the main queue, so this monitor's own state is only touched there.
/// It journals native-live.log: the owner hears distortion with no call running, so the mark and the
/// volume lines must not depend on a call's journal existing.
final class NativeOutputVolumeMonitor: @unchecked Sendable {
    private let journal: NativeLiveJournal?
    private let read: () -> NativeOutputVolumeSnapshot
    private var defaultListener: AudioObjectPropertyListenerBlock?
    private var volumeDevice: AudioObjectID?
    private var volumeListeners: [(element: AudioObjectPropertyElement, block: AudioObjectPropertyListenerBlock)] = []

    init(journal: NativeLiveJournal?, read: @escaping () -> NativeOutputVolumeSnapshot = { NativeLiveAudioDevice.outputVolumeSnapshot() }) {
        self.journal = journal
        self.read = read
    }

    deinit {
        if let listener = defaultListener {
            var property = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                     mScope: kAudioObjectPropertyScopeGlobal,
                                                     mElement: kAudioObjectPropertyElementMain)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &property,
                                                   DispatchQueue.main, listener)
        }
        removeVolumeListeners()
    }

    /// Install the default-device listener and bind the volume listener to the current output.
    func start() {
        guard defaultListener == nil else { return }
        var property = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.noteDefaultOutputChanged() }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &property,
                                               DispatchQueue.main, listener) == noErr {
            defaultListener = listener
        }
        bindVolumeListener(to: NativeLiveAudioDevice.defaultDeviceID(input: false))
    }

    /// C-AUDIOMARK 0b: the default output moved. The notification names no writer, so the record only
    /// says the default changed and what the new device reads.
    func noteDefaultOutputChanged() {
        let device = NativeLiveAudioDevice.defaultDeviceID(input: false)
        // Only a started monitor has listeners to rebind; an unstarted one only records the reading.
        if defaultListener != nil { bindVolumeListener(to: device) }
        var fields = read().fields
        fields["reason"] = "default_device_changed"
        fields["deviceId"] = String(device)
        journal?.append(Self.record(event: "output_volume", fields: fields))
    }

    /// C-AUDIOMARK 2: a volume property on the current output changed. Read only, and it never says
    /// who wrote it.
    func noteVolumeChanged() {
        journal?.append(Self.record(event: "output_volume_changed", fields: read().fields))
    }

    /// Test seams: the two notification bodies, reachable without CoreAudio.
    func noteVolumeChangedForTesting() { noteVolumeChanged() }
    func noteDefaultOutputChangedForTesting() { noteDefaultOutputChanged() }

    private static func record(event: String, fields: [String: String]) -> [String: Any] {
        var record: [String: Any] = ["event": event]
        for (key, value) in fields { record[key] = value }
        return record
    }

    /// A device may publish a master control, one per channel, or both, so the listener is added for
    /// every volume control the device actually has. A device with none is still watched for a default
    /// change, which is the only way its level could move under this app.
    private func bindVolumeListener(to device: AudioObjectID) {
        guard device != volumeDevice else { return }
        removeVolumeListeners()
        guard device != kAudioObjectUnknown else { return }
        volumeDevice = device
        for element in [kAudioObjectPropertyElementMain, 1, 2] {
            var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                                     mScope: kAudioObjectPropertyScopeOutput, mElement: element)
            guard AudioObjectHasProperty(device, &property) else { continue }
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.noteVolumeChanged() }
            if AudioObjectAddPropertyListenerBlock(device, &property, DispatchQueue.main, block) == noErr {
                volumeListeners.append((element, block))
            }
        }
    }

    private func removeVolumeListeners() {
        guard let device = volumeDevice else { return }
        for listener in volumeListeners {
            var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                                     mScope: kAudioObjectPropertyScopeOutput,
                                                     mElement: listener.element)
            AudioObjectRemovePropertyListenerBlock(device, &property, DispatchQueue.main, listener.block)
        }
        volumeListeners = []
        volumeDevice = nil
    }
}
