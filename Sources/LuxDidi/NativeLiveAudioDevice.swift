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
    var underruns = 0, lateAfterFlush = 0
}
/// The scheduling decision for one arriving model chunk.
struct NativePlaybackArrival: Sendable, Equatable {
    /// The prebuffer just filled: the device calls the player's play().
    let start: Bool
    /// The queue was dry while playback was underway: an utterance starved.
    let underrun: Bool
    /// Audio that had been queued for the burst that ran dry, in ms.
    let queuedMs: Int
    /// Milliseconds since the previous chunk arrived, 0 for the first of a session.
    let sinceLastChunkMs: Int
}
/// Deterministic playback queue for model audio: an arrival schedule (timestamps and frame counts)
/// in, the two scheduling decisions out (whether to start the player, whether the arrival starved an
/// utterance). It touches no audio API, so a recorded schedule can be replayed in a test.
struct NativePlaybackQueue {
    /// ~80 ms of 24 kHz mono audio queued before a turn starts, so a bursty provider never begins
    /// playback on an empty queue and underruns mid-syllable.
    static let prebufferFrames = 1920
    static let frameRate = 24000
    /// A queue that stays dry at least this long was a pause or the end of a turn, not a dropout.
    /// Below it the utterance was continuous and the scheduler fell behind: a real underrun.
    static let pauseThresholdMs = 500

    private(set) var queuedBuffers = 0
    private(set) var scheduledFrames = 0
    private(set) var playing = false
    private var drainedFrames = 0
    private var drainedAtMs: Int?
    private var lastArrivalMs: Int?

    mutating func arrival(frames: Int, atMs: Int) -> NativePlaybackArrival {
        let sinceLastChunkMs = lastArrivalMs.map { atMs - $0 } ?? 0
        lastArrivalMs = atMs
        let starved = (drainedAtMs.map { atMs - $0 } ?? Int.max) < Self.pauseThresholdMs
        queuedBuffers += 1
        scheduledFrames += frames
        drainedAtMs = nil
        var start = false
        if !playing, scheduledFrames >= Self.prebufferFrames { playing = true; start = true }
        return NativePlaybackArrival(start: start, underrun: starved,
                                     queuedMs: starved ? Self.ms(drainedFrames) : 0,
                                     sinceLastChunkMs: sinceLastChunkMs)
    }

    /// A scheduled buffer finished playing back. Returns true when the queue is now dry: the player
    /// is stopped and the next arrival re-arms the prebuffer, so a pause is not a glitch.
    @discardableResult mutating func playedBack(atMs: Int) -> Bool {
        queuedBuffers -= 1
        guard queuedBuffers == 0 else { return false }
        playing = false
        drainedFrames = scheduledFrames
        scheduledFrames = 0
        drainedAtMs = atMs
        return true
    }

    mutating func flush() {
        queuedBuffers = 0; scheduledFrames = 0; playing = false
        drainedFrames = 0; drainedAtMs = nil; lastArrivalMs = nil
    }

    static func ms(_ frames: Int) -> Int { frames * 1000 / frameRate }
}
struct NativeAudioCaptureSummary: Sendable {
    let capture: NativeCaptureStatistics
    let drainFrames: Int
    let captureEpoch: UInt64
    let captureGeneration: UInt64
    let muted: Bool
    let playback: NativePlaybackStatistics
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
    /// One recorded underrun per starved arrival, for the native-live.log line.
    var onUnderrun: ((NativePlaybackArrival) -> Void)?
    var onInterruption: (() async -> Void)?
    var onInputChange: ((String) -> Void)?
    var onResume: (() -> Void)?
    @Published private(set) var route = ""
    private var muted = false
    private let captureInput: AVAudioFormat?
    private let inputDevice: () -> (id: String, name: String)
    private let owner: AudioOwner
    private let journal: NativeAudioJournal?
    private let deviceState: (Bool) -> Bool
    private let now: () -> Date
    private let isBuiltInOutput: () -> Bool
    /// Test seams: an engine/player/format factory and a start hook stand in for real hardware.
    var engineFactoryForTesting: (() -> (AVAudioEngine, AVAudioPlayerNode, AVAudioFormat))?
    var startForTesting: ((AVAudioEngine) throws -> Void)?
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
    var diagnosticsRoute: String {
        "Input: " + Self.routeClassification(input: true) + "; Output: " + Self.routeClassification(input: false)
    }
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
    private var outputGeneration: UInt64 = 0
    /// Bumped only by a barge-in flush, so a chunk whose turn was flushed in flight is dropped.
    private var turnGeneration: UInt64 = 0
    private var playback = NativePlaybackStatistics()
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
        sendFrame = send
        // A new session may try once: clear the per-session VPIO and circuit-breaker state.
        voiceProcessingFailed = false; sessionFailed = false; lastRebuildAt = nil
        do { try build(send: send); recovery.begin() }
        catch { sendFrame = nil; throw error }
    }
    /// Test with an attached mixer standing in for the output node, without opening hardware.
    static func connectPlayback(engine: AVAudioEngine, player: AVAudioPlayerNode,
                                outputNode: AVAudioNode, outputFormat: AVAudioFormat? = nil) throws {
        let hardwareOutput = outputFormat ?? outputNode.inputFormat(forBus: 0)
        guard hardwareOutput.sampleRate > 0, hardwareOutput.channelCount > 0 else {
            throw NativeLiveAudioError.formatUnavailable
        }
        guard let output = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: output)
        // VP output requires its input-bus format, not the player's 24 kHz mono client format.
        engine.connect(engine.mainMixerNode, to: outputNode, format: hardwareOutput)
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
                try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode)
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
                try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode)
            }
        } else {
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
                throw NativeLiveAudioError.formatUnavailable
            }
            try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode)
        }
        self.engine = engine; self.player = player
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
                        if failed { await self.interrupt(); return }
                        guard let frame else { break }
                        self.drainFrames += 1
                        let epoch = self.captureEpoch
                        do { try Task.checkCancellation(); try await send(frame, epoch) }
                        catch {
                            guard self.captureGeneration == token, !Task.isCancelled else { return }
                            await self.interrupt(); return
                        }
                    }
                }
            }
        onCapturePrepared?(capture)
    }
    func setMuted(_ muted: Bool) { if self.muted != muted { captureEpoch &+= 1 }; self.muted = muted; capture?.setMuted(muted); inputLevel = 0 }
    private func interrupt() async {
        stop()
        await onInterruption?()
    }
    private func nowMs() -> Int { Int(now().timeIntervalSince1970 * 1000) }
    func write(_ pcm: Data) async throws {
        // Paused/rebuilding output is discarded, never buffered or replayed on Resume.
        if recovery.awaitingResume || recovery.pending != nil { return }
        guard let player, let engine, engine.isRunning, pcm.count.isMultiple(of: 2) else { throw LiveClientError.unavailable }
        let entryTurn = turnGeneration
        if playbackQueue.queuedBuffers >= 24 { flushOutput() }
        // Barge-in flushed this chunk's turn while it was in flight: never schedule stale audio.
        guard turnGeneration == entryTurn else { playback.lateAfterFlush += 1; return }
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
        let arrival = playbackQueue.arrival(frames: Int(buffer.frameLength), atMs: nowMs())
        if arrival.underrun { playback.underruns += 1; onUnderrun?(arrival) }
        onOutput?(true); isPlayingOutput = true
        var sum: Double = 0
        pcm.withUnsafeBytes { bytes in
            for sample in bytes.bindMemory(to: Int16.self) {
                let value = Double(Int16(littleEndian: sample)) / 32768; sum += value * value
            }
        }
        outputLevel = pcm.isEmpty ? 0 : Float(min(1, sqrt(sum / Double(pcm.count / 2))))
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.outputGeneration == token else { return }
                if self.playbackQueue.playedBack(atMs: self.nowMs()) {
                    // The queue ran dry: this is a pause or the end of a turn, never a glitch. Stop the
                    // node so the next burst re-fills the prebuffer before playback restarts.
                    self.player?.stop()
                    self.onOutput?(false); self.isPlayingOutput = false; self.outputLevel = 0
                }
            }
        }
        if arrival.start { player.play() }
    }
    /// Barge-in: invalidate the queued turn so an in-flight chunk cannot be scheduled after the flush.
    func flush() async throws { flushOutput(); turnGeneration &+= 1 }
    private func flushOutput() {
        outputGeneration &+= 1; player?.stop(); playbackQueue.flush(); onOutput?(false); isPlayingOutput = false; outputLevel = 0
    }
    func stop() {
        let epoch = captureEpoch, captureToken = captureGeneration, wasMuted = muted
        captureEpoch &+= 1; recovery.stop(); sendFrame = nil; muted = false
        if captureLifetimeActive {
            terminalCaptureSummary = NativeAudioCaptureSummary(capture: captureStatistics,
                drainFrames: drainFrames, captureEpoch: epoch, captureGeneration: captureToken, muted: wasMuted,
                playback: playback)
            captureLifetimeActive = false
        }
    }
    private func releaseAudio() {
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
        audioReleaseCount += 1
        log("audio_released", ["reason": "release"])
    }
}
