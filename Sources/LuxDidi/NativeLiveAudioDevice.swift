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
    var captureDrain: Task<Void, Never>? { drain }
    var onOutput: ((Bool) -> Void)?
    var onInterruption: (() async -> Void)?
    var onInputChange: ((String) -> Void)?
    var onResume: (() -> Void)?
    @Published private(set) var route = ""
    private var muted = false
    private let captureInput: AVAudioFormat?
    private let inputDevice: () -> (id: String, name: String)
    // Receives the actual locked converter/buffer, never a substitute PCM implementation.
    var onCapturePrepared: ((NativeCaptureBuffer) -> Void)?
    init(captureInput: AVAudioFormat? = nil, defaultInput: (() -> (id: String, name: String))? = nil) {
        self.captureInput = captureInput
        self.inputDevice = defaultInput ?? { Self.defaultDevice(input: true) }
    }
    func routeChanged() {
        route = "Microphone: " + inputDevice().name + " · Output: " + Self.defaultDevice(input: false).name
        recovery.changed()
    }
    func finishRouteRecovery() async { await recovery.pending?.value }
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
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var capture: NativeCaptureBuffer?
    private var drain: Task<Void, Never>?
    private var configurationObserver: NSObjectProtocol?
    private var queuedOutput = 0
    private var outputGeneration: UInt64 = 0
    /// Bumped only by a barge-in flush, so a chunk whose turn was flushed in flight is dropped.
    private var turnGeneration: UInt64 = 0
    private var scheduledPlaybackFrames = 0
    private var playback = NativePlaybackStatistics()
    /// ~80 ms of 24 kHz mono audio (1920 frames) queued before a turn starts, so a bursty
    /// provider never begins playback on an empty queue and underruns mid-syllable.
    static let playbackPrebufferFrames = 1920
    private var captureGeneration: UInt64 = 0
    private var captureStatistics = NativeCaptureStatistics()
    private var drainFrames = 0
    private var captureLifetimeActive = false
    private var terminalCaptureSummary: NativeAudioCaptureSummary?
    func takeCaptureSummary() -> NativeAudioCaptureSummary? {
        defer { terminalCaptureSummary = nil }
        return terminalCaptureSummary
    }
    /// W10: non-consuming counters and resolved input configuration for the native audio events.
    func liveAudioFlowCounters() -> (underruns: Int, lateAfterFlush: Int) { (playback.underruns, playback.lateAfterFlush) }
    func liveAudioConfiguration() -> (sampleRate: Double, channels: Int, channelMap: [Int], voiceProcessing: Bool) {
        let format = captureInput ?? engine?.inputNode.inputFormat(forBus: 0)
        return (format?.sampleRate ?? 0, Int(format?.channelCount ?? 0), [0], engine?.inputNode.isVoiceProcessingEnabled ?? false)
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
    /// Starts and immediately stops the production voice-processing graph without capture or playback.
    static func startSilentEngineProbe() throws {
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        defer { engine.stop() }
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            try engine.outputNode.setVoiceProcessingEnabled(true)
        } catch { throw NativeLiveAudioError.voiceProcessingFailed(code: (error as NSError).code) }
        guard engine.inputNode.isVoiceProcessingEnabled, engine.outputNode.isVoiceProcessingEnabled else {
            throw NativeLiveAudioError.voiceProcessingFailed(code: nil)
        }
        let input = engine.inputNode.outputFormat(forBus: 0)
        guard input.sampleRate > 0, input.channelCount > 0 else { throw NativeLiveAudioError.formatUnavailable }
        try connectPlayback(engine: engine, player: player, outputNode: engine.outputNode)
        engine.prepare()
        do { try engine.start() }
        catch { throw NativeLiveAudioError.engineFailure(error as NSError) }
    }
    private func build(send: @escaping @Sendable (Data, UInt64) async throws -> Void) throws {
        guard !inputDevice().id.isEmpty else { throw NativeLiveAudioError.deviceMissing }
        if let captureInput {
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: captureInput))
            capture.setMuted(muted); self.capture = capture
            activateCapture(capture, send: send)
            return
        }
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        do {
            do {
                try engine.inputNode.setVoiceProcessingEnabled(true)
                try engine.outputNode.setVoiceProcessingEnabled(true)
            } catch { throw NativeLiveAudioError.voiceProcessingFailed(code: (error as NSError).code) }
            guard engine.inputNode.isVoiceProcessingEnabled, engine.outputNode.isVoiceProcessingEnabled else {
                throw NativeLiveAudioError.voiceProcessingFailed(code: nil)
            }
            let hardware = engine.inputNode.outputFormat(forBus: 0)
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else { throw NativeLiveAudioError.formatUnavailable }
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: hardware))
            capture.setMuted(muted)
            try Self.connectPlayback(engine: engine, player: player, outputNode: engine.outputNode)
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware, block: capture.makeTap())
            self.engine = engine; self.player = player; self.capture = capture
            engine.prepare()
            do { try engine.start() }
            catch { throw NativeLiveAudioError.engineFailure(error as NSError) }
            // Playback starts in write(_:) only after the prebuffer fills, never on an empty queue.
            route = "Microphone: " + Self.defaultDevice(input: true).name + " · Output: " + Self.defaultDevice(input: false).name
            activateCapture(capture, send: send)
            let token = captureGeneration
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.captureGeneration == token else { return }
                    self.routeChanged()
                }
            }
        } catch {
            if self.engine != nil { releaseAudio() }
            else { engine.stop() }
            throw (error as? NativeLiveAudioError) ?? NativeLiveAudioError.engineFailed(code: (error as NSError).code)
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
    func write(_ pcm: Data) async throws {
        // Paused/rebuilding output is discarded, never buffered or replayed on Resume.
        if recovery.awaitingResume || recovery.pending != nil { return }
        guard let player, let engine, engine.isRunning, pcm.count.isMultiple(of: 2) else { throw LiveClientError.unavailable }
        let entryTurn = turnGeneration
        if queuedOutput >= 24 { flushOutput() }
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
        if player.isPlaying && queuedOutput == 0 { playback.underruns += 1 }
        queuedOutput += 1; scheduledPlaybackFrames += Int(buffer.frameLength); onOutput?(true); isPlayingOutput = true
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
                self.queuedOutput -= 1
                if self.queuedOutput == 0 { self.onOutput?(false); self.isPlayingOutput = false; self.outputLevel = 0 }
            }
        }
        if !player.isPlaying && scheduledPlaybackFrames >= Self.playbackPrebufferFrames { player.play() }
    }
    /// Barge-in: invalidate the queued turn so an in-flight chunk cannot be scheduled after the flush.
    func flush() async throws { flushOutput(); turnGeneration &+= 1 }
    private func flushOutput() {
        outputGeneration &+= 1; player?.stop(); queuedOutput = 0; scheduledPlaybackFrames = 0; onOutput?(false); isPlayingOutput = false; outputLevel = 0
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
        captureGeneration &+= 1
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        if let capture { captureStatistics.add(capture.stop()) }
        drain?.cancel(); drain = nil; capture = nil
        flushOutput()
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        engine = nil; player = nil; isCapturing = false; inputLevel = 0; outputLevel = 0; isPlayingOutput = false
    }
}
