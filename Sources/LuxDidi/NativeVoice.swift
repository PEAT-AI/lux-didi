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

/// Feeds bounded local levels into the embedded web orb while a live session runs: playback
/// levels while Naya speaks, microphone levels while listening. The renderer owns smoothing and
/// geometry; this publisher never touches capture or transport authority.
@MainActor final class NativeOrbLevelPublisher {
    private let device: NativeLiveAudioDevice
    private weak var web: WKWebView?
    private var task: Task<Void, Never>?
    init(device: NativeLiveAudioDevice, web: WKWebView?) { self.device = device; self.web = web }
    func start() {
        guard task == nil, let web = self.web else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self = self, let web = self.web, web.window != nil else { break }
                let sample = self.device.isPlayingOutput ? Double(self.device.outputLevel) : Double(self.device.inputLevel)
                _ = try? await web.evaluateJavaScript("window.didiOrbLevel&&window.didiOrbLevel({level:\(sample)})")
                try? await Task.sleep(nanoseconds: 66_000_000)
            }
        }
    }
    func stop() { task?.cancel(); task = nil }
}
