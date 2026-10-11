import AVFoundation
import Combine
import Foundation

enum NativeLiveAudioError: LocalizedError {
    case unsupportedFormat, allocationFailed, converterUnavailable, permissionDenied, voiceProcessingUnavailable, deviceUnavailable
    var errorDescription: String? {
        switch self {
        case .unsupportedFormat: return "Live audio format is unsupported."
        case .allocationFailed: return "Live audio buffer could not be allocated."
        case .converterUnavailable: return "Live microphone format could not be converted."
        case .permissionDenied: return "Microphone permission was denied."
        case .voiceProcessingUnavailable: return "Voice processing must be enabled on both microphone and output."
        case .deviceUnavailable: return "Live audio device is unavailable."
        }
    }
}

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
    private var frames: [Data] = []
    private(set) var drops = 0
    mutating func push(_ frame: Data) {
        precondition(frame.count == 640)
        if frames.count == 8 { frames.removeFirst(); drops += 1 }
        frames.append(frame)
    }
    mutating func pop() -> Data? { frames.isEmpty ? nil : frames.removeFirst() }
    mutating func clear() { frames.removeAll(keepingCapacity: true) }
}

/// One converter per capture lifetime. The input callback supplies each buffer exactly once.
final class NativePCMConverter {
    let output: AVAudioFormat
    private let converter: AVAudioConverter
    init(input: AVAudioFormat) throws {
        guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        guard let converter = AVAudioConverter(from: input, to: output) else { throw NativeLiveAudioError.converterUnavailable }
        self.output = output; self.converter = converter
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

/// The tap and drain task meet only through this locked eight-frame queue.
final class NativeCaptureBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let converter: NativePCMConverter
    private var assembler = NativePCMFrameAssembler()
    private var ring = NativePCMFrameRing()
    private var stopped = false, muted = false
    private var level: Float = 0
    private var failure = false
    let stream: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    init(converter: NativePCMConverter) {
        self.converter = converter
        (stream, signal) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
    }
    func append(_ input: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return }
        if !muted {
            do {
                let data = try converter.append(input)
                var sum: Double = 0
                data.withUnsafeBytes { bytes in
                    for sample in bytes.bindMemory(to: Int16.self) {
                        let value = Double(sample) / 32768; sum += value * value
                    }
                }
                level = data.isEmpty ? 0 : Float(sqrt(sum / Double(data.count / 2)))
                for frame in assembler.append(data) { ring.push(frame) }
            } catch { failure = true }
        }
        signal.yield(())
    }
    func next() -> (Data?, Float, Int, Bool) {
        lock.lock(); defer { lock.unlock() }
        return (ring.pop(), muted ? 0 : level, ring.drops, failure)
    }
    func setMuted(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        muted = value; ring.clear(); _ = assembler.discardPartial(); level = 0
    }
    func stop() {
        lock.lock(); defer { lock.unlock() }
        stopped = true; ring.clear(); _ = assembler.discardPartial(); signal.finish()
    }
}

@MainActor final class NativeLiveAudioDevice: ObservableObject, LiveAudioSink {
    @Published private(set) var inputLevel: Float = 0
    @Published private(set) var droppedFrames = 0
    @Published private(set) var isCapturing = false
    var hasEngine: Bool { engine != nil }
    var onOutput: ((Bool) -> Void)?
    var onInterruption: (() async -> Void)?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var capture: NativeCaptureBuffer?
    private var drain: Task<Void, Never>?
    private var configurationObserver: NSObjectProtocol?
    private var queuedOutput = 0
    private var outputGeneration: UInt64 = 0
    private var captureGeneration: UInt64 = 0

    func start(send: @escaping @Sendable (Data) async throws -> Void) async throws {
        guard engine == nil else { throw LiveClientError.unavailable }
        guard await AVCaptureDevice.requestAccess(for: .audio) else { throw NativeLiveAudioError.permissionDenied }
        try Task.checkCancellation()
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            try engine.outputNode.setVoiceProcessingEnabled(true)
            guard engine.inputNode.isVoiceProcessingEnabled, engine.outputNode.isVoiceProcessingEnabled else {
                throw NativeLiveAudioError.voiceProcessingUnavailable
            }
            let hardware = engine.inputNode.outputFormat(forBus: 0)
            guard hardware.sampleRate > 0, hardware.channelCount > 0 else { throw NativeLiveAudioError.deviceUnavailable }
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: hardware))
            guard let output = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
                throw NativeLiveAudioError.unsupportedFormat
            }
            engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: output)
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware) { buffer, _ in capture.append(buffer) }
            self.engine = engine; self.player = player; self.capture = capture
            engine.prepare(); try engine.start(); player.play()
            isCapturing = true; captureGeneration &+= 1
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
                        do { try await send(frame) }
                        catch { await self.interrupt(); return }
                    }
                }
            }
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                Task { @MainActor in await self?.interrupt() }
            }
        } catch {
            if self.engine != nil { stop() }
            else { engine.stop() }
            throw error
        }
    }
    func setMuted(_ muted: Bool) { capture?.setMuted(muted); inputLevel = 0 }
    private func interrupt() async {
        stop()
        await onInterruption?()
    }
    func write(_ pcm: Data) async throws {
        guard let player, let engine, engine.isRunning, pcm.count.isMultiple(of: 2) else { throw LiveClientError.unavailable }
        if queuedOutput >= 24 { try await flush() }
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
        queuedOutput += 1; onOutput?(true)
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.outputGeneration == token else { return }
                self.queuedOutput -= 1
                if self.queuedOutput == 0 { self.onOutput?(false) }
            }
        }
        if !player.isPlaying { player.play() }
    }
    func flush() async throws { flushOutput() }
    private func flushOutput() {
        outputGeneration &+= 1; player?.stop(); queuedOutput = 0; onOutput?(false)
    }
    func stop() {
        captureGeneration &+= 1
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        capture?.stop(); drain?.cancel(); drain = nil; capture = nil
        flushOutput()
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        engine = nil; player = nil; isCapturing = false; inputLevel = 0
    }
}
