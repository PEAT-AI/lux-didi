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
    private var captureGeneration: UInt64 = 0

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
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardware) { buffer, _ in capture.append(buffer) }
            self.engine = engine; self.player = player; self.capture = capture
            engine.prepare()
            do { try engine.start() }
            catch { throw NativeLiveAudioError.engineFailure(error as NSError) }
            player.play()
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
        captureEpoch &+= 1; recovery.stop(); sendFrame = nil; muted = false
    }
    private func releaseAudio() {
        captureGeneration &+= 1
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        capture?.stop(); drain?.cancel(); drain = nil; capture = nil
        flushOutput()
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        engine = nil; player = nil; isCapturing = false; inputLevel = 0
    }
}
