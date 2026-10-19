import AVFoundation
import Speech
import Combine

@MainActor final class NativeVoice: ObservableObject {
    @Published private(set) var state = VoiceState()
    @Published private(set) var microphone: PermissionState = .notDetermined
    @Published private(set) var speech: PermissionState = .notDetermined
    @Published private(set) var onDevice = false
    private var engine: AVAudioEngine?
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var observer: NSObjectProtocol?
    private var generation = 0
    private var tapInstalled = false
    private let owner = AudioOwner.shared
    private let recognizer = SFSpeechRecognizer(locale: Locale.current)

    init() { refresh() }
    func refresh() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: microphone = .granted
        case .denied: microphone = .denied
        case .restricted: microphone = .restricted
        case .notDetermined: microphone = .notDetermined
        @unknown default: microphone = .unknown
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: speech = .granted
        case .denied: speech = .denied
        case .restricted: speech = .restricted
        case .notDetermined: speech = .notDetermined
        @unknown default: speech = .unknown
        }
        onDevice = recognizer?.supportsOnDeviceRecognition == true
    }
    func requestPermissions() async {
        // Explicit user action only; this does not start recording.
        _ = await AVCaptureDevice.requestAccess(for: .audio)
        _ = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        refresh()
    }
    func start() {
        guard state.phase != .recording else { return }
        refresh()
        guard state.start(microphone: microphone, speech: speech, onDevice: onDevice) else { return }
        guard let recognizer, recognizer.isAvailable else { state.fail("Speech recognizer is currently unavailable"); return }
        generation += 1
        let token = generation
        // The single audio owner refuses a second engine before one is ever created.
        do { try owner.acquire(holder: ObjectIdentifier(self)) }
        catch {
            state.fail((error as? AudioOwnerError)?.errorDescription ?? "Didi's audio is already in use.")
            return
        }
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.engine = engine; self.request = request
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { stop(reason: "No audio input device"); state.fail("No audio input device"); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        tapInstalled = true
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.interrupt("Audio device changed") }
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                if let result { self.state.receive(result.bestTranscription.formattedString) }
                if let error { self.interrupt(error.localizedDescription) }
                else if result?.isFinal == true { self.stop(reason: "Recognition finished") }
            }
        }
        do { engine.prepare(); try engine.start(); owner.didStartEngine(holder: ObjectIdentifier(self)) }
        catch { interrupt(error.localizedDescription) }
    }
    func stop(reason: String) {
        generation += 1
        if let engine { engine.stop(); if tapInstalled { engine.inputNode.removeTap(onBus: 0) } }
        tapInstalled = false
        request?.endAudio(); task?.cancel()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil; task = nil; request = nil; engine = nil
        owner.release(holder: ObjectIdentifier(self))
        state.stop(reason: reason)
    }
    func interrupt(_ detail: String) { stop(reason: detail); state.fail(detail) }
    // Preparation proof only: never call speak in the automated run.
    func preparedPlayback(_ text: String) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text); utterance.volume = 0; return utterance
    }
}

import WebKit

/// Feeds bounded local levels into the embedded web orb while a live session runs. Every tick
/// (60 Hz, one per display refresh) posts the orb band frame: the owner's latest capture window and
/// the model output window at the playback position (#283). One visible recipient owns the
/// latest-only publication; hidden surfaces suspend this clock. The renderer owns smoothing and
/// geometry; this publisher never touches capture, playback or transport authority.
@MainActor final class NativeOrbLevelPublisher {
    static let intervalNanos: UInt64 = 16_666_667
    /// While both sides are silent, one silent frame per 200 ms is enough to hold the renderer at
    /// rest (it treats a frame older than 500 ms as silence anyway).
    static let silentRepeatSeconds: TimeInterval = 0.2
    private let device: NativeLiveAudioDevice
    private let bridge: NativeBridge
    private var task: Task<Void, Never>?
    private var lastSilentAt: TimeInterval = 0
    private var requested = false
    init(device: NativeLiveAudioDevice, bridge: NativeBridge) {
        self.device = device; self.bridge = bridge
        bridge.orbPublication.onSelectionChanged = { [weak self] in self?.update() }
    }
    func start() { requested = true; update() }
    private func update() {
        guard requested, bridge.orbPublication.hasRecipient else { task?.cancel(); task = nil; return }
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self = self else { break }
                let now = Date().timeIntervalSince1970
                let bands = self.device.orbBands()
                let frame = BridgeOrbFrame(input: BridgeOrbBands(bands.input), output: BridgeOrbBands(bands.output))
                if !frame.isSilent || now - self.lastSilentAt >= Self.silentRepeatSeconds {
                    if frame.isSilent { self.lastSilentAt = now } else { self.lastSilentAt = 0 }
                    self.bridge.pushOrbFrame(frame)
                }
                try? await Task.sleep(nanoseconds: Self.intervalNanos)
            }
        }
    }
    func stop() { requested = false; task?.cancel(); task = nil }
}

extension BridgeOrbBands {
    init(_ bands: NativeOrbBands) {
        self.init(level: Double(bands.level), low: Double(bands.low), mid: Double(bands.mid), high: Double(bands.high), flux: Double(bands.flux))
    }
}
