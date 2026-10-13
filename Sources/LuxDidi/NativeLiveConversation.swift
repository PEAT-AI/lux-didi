import Combine
import Foundation
#if DIDI_OWNER_MODULE
import DidiOwner
#endif

@MainActor final class NativeLiveConversation: ObservableObject {
enum State: String, CaseIterable {
    case idle, connecting, listening, speaking, muted, ended, failed, outcomeUnknown, pausedForInput, rebuilding
    var sentence: String {
        switch self {
        case .idle: return "Ready for Live voice"
        case .connecting: return "Connecting"
        case .listening: return "Listening"
        case .speaking: return "Speaking"
        case .muted: return "Microphone muted"
        case .ended: return "Live voice stopped"
        case .failed: return "Live voice failed"
        case .outcomeUnknown: return "Live outcome unknown"
        case .pausedForInput: return "Microphone changed; Resume required"
        case .rebuilding: return "Reconnecting"
        }
    }
    var symbol: String {
        switch self {
        case .listening: return "mic.fill"
        case .speaking: return "waveform"
        case .muted: return "mic.slash.fill"
        case .connecting, .rebuilding: return "ellipsis.circle"
        case .pausedForInput: return "pause.circle"
        case .idle, .ended, .failed, .outcomeUnknown: return "mic.slash"
        }
    }
    var presentation: (text: String, symbol: String) { (sentence, symbol) }
}
    /// Continuity changes presentation, never the owner's mute choice or audio device.
    static func continuityPresentation(_ event: LiveClientState, muted: Bool) -> State? {
        switch event {
        case .rebuilding: return .rebuilding
        case .active: return muted ? .muted : .listening
        default: return nil
        }
    }
    @Published private(set) var state: State = .idle
    @Published private(set) var failure: String?
    @Published private(set) var pendingCall: NativePendingLiveJob?
    let device: NativeLiveAudioDevice
    private let coordinator: LiveSessionCoordinator
    private let http: NativeLiveOperatorHTTP
    private let dictationIsCapturing: () -> Bool
    private var observer: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var generation: UInt64 = 0
    private let logsDirectory: URL?
    private var limits: NativeLiveLimits?
    private var muted = false, speaking = false
    private var muteTask: Task<Void, Never>?
    var isMuted: Bool { muted }
    var isCapturing: Bool { state == .connecting || state == .pausedForInput || device.isCapturing }
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), dictationIsCapturing: @escaping () -> Bool, pickupJobID: String? = nil, logsDirectory: URL? = nil, audioDevice: NativeLiveAudioDevice? = nil) {
        self.logsDirectory = logsDirectory
        self.http = NativeLiveOperatorHTTP(authority: authority, pickupJobID: pickupJobID)
        self.dictationIsCapturing = dictationIsCapturing
        let device = audioDevice ?? NativeLiveAudioDevice(); self.device = device
        coordinator = LiveSessionCoordinator(http: http, sockets: LiveSocketTransport(requests: http), sink: device)
        device.onOutput = { [weak self] speaking in
            guard let self else { return }
            self.speaking = speaking
            if [.listening, .speaking, .muted].contains(self.state) {
                self.state = self.muted ? .muted : (speaking ? .speaking : .listening)
            }
        }
        device.onInputChange = { [weak self] name in
            guard let self else { return }
            self.state = .pausedForInput
            self.failure = "Microphone changed to " + name + ". Resume?"
        }
        device.onResume = { [weak self] in
            guard let self, self.state == .pausedForInput else { return }
            self.failure = nil
            self.state = self.muted ? .muted : (self.speaking ? .speaking : .listening)
        }
        device.onInterruption = { [weak self] in
            guard let self else { return }
            let token = self.generation &+ 1
            await self.stop()
            guard self.generation == token else { return }
            self.failure = "Live audio could not recover. Capture released. Restart explicitly to try again."
            self.state = .failed
        }
    }
    // Presentation only: an offer never opens a session, an audio engine or the microphone.
    func offerPendingCall(_ job: NativePendingLiveJob?) { pendingCall = job }
    func start() {
        if state == .pausedForInput { device.resumeInput(); return }
        guard !isCapturing else { return }
        guard !dictationIsCapturing() else {
            failure = "Stop dictation before starting Live voice."; state = .failed; return
        }
        generation &+= 1; let token = generation
        failure = nil; state = .connecting; muted = false; speaking = false
        observer?.cancel()
        observer = Task { [weak self, coordinator] in
            await self?.startTask?.value
            if self?.state == .failed { return }
            for await event in coordinator.events {
                let current = await coordinator.state
                let beforeCreate = await coordinator.sessionID == nil
                guard let self, self.generation == token, !Task.isCancelled else { return }
                guard current == event else { continue }
                switch event {
                case .active where self.state == .pausedForInput: break
                case .active: self.state = self.muted ? .muted : (self.speaking ? .speaking : .listening)
                case .rebuilding:
                    self.speaking = false
                    if self.state != .pausedForInput {
                        self.state = Self.continuityPresentation(event, muted: self.muted)!
                    }
                case .terminal(let outcome):
                    if let sentence = NativeLivePresentation.ended(outcome.code, limits: self.limits) {
                        self.failure = sentence
                    } else if outcome.state == .failed {
                        self.failure = outcome.code.map { "Live service: " + $0 + "." } ?? "Live service failed."
                    }
                    self.device.stop()
                    self.state = outcome.state == .failed ? .failed : (outcome.state == .outcome_unknown ? .outcomeUnknown : .ended)
                case .failed(let reason):
                    self.device.stop(); self.state = .failed
                    self.failure = NativeLivePresentation.failure(reason)
                    self.logFailure(reason, beforeCreate: beforeCreate)
                case .createUnknown:
                    self.device.stop(); self.state = .outcomeUnknown
                    self.failure = "Live start outcome is unknown. Check the conversation before starting again."
                case .outcomeUnknown(let reason):
                    self.device.stop(); self.state = .outcomeUnknown
                    self.failure = reason.errorDescription ?? "Live outcome is unknown. No automatic reconnect."
                default: break
                }
            }
        }
        startTask = Task { [weak self, coordinator, http] in
            do {
                // Reset capture authority before a new explicit start.
                guard let epoch = self?.device.captureEpoch else { return }
                await coordinator.setCaptureMuted(false, epoch: epoch)
                try Task.checkCancellation()
                // Prepare the single duplex engine before the socket can deliver model PCM.
                try await self?.device.startFenced { frame, epoch in
                    if await coordinator.state == .active { try await coordinator.sendPCM(frame, captureEpoch: epoch) }
                }
                try Task.checkCancellation()
                guard let self, self.generation == token else { return }
                let intent = try await http.beginIntent()
                self.limits = http.limits
                try Task.checkCancellation()
                guard self.generation == token else { return }
                await coordinator.begin(intent)
            } catch {
                guard let self, self.generation == token else { return }
                self.device.stop(); await coordinator.close()
                guard self.generation == token else { return }
                self.failure = NativeLivePresentation.failure(error)
                self.logFailure(error, beforeCreate: true)
                self.state = .failed
            }
        }
    }
    @discardableResult
    func logFailure(_ error: Error, beforeCreate: Bool, diagnosticSession: URLSession? = nil) -> Task<Void, Never>? {
        guard beforeCreate else { return nil }
        let diagnostic = Task { [http] in await http.postPrecreateFailure(error, using: diagnosticSession) }
        guard let logsDirectory else { return diagnostic }
        let code: String
        if error is URLError { code = "service_unreachable" }
        else if error is DecodingError { code = "unexpected_response" }
        else if let reason = error as? LiveClientError { code = reason.rawValue }
        else if let audio = error as? NativeLiveAudioError { code = audio.rawValue }
        else { code = "connection_refused" }
        do {
            try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = logsDirectory.appendingPathComponent("native-live.log")
            if !FileManager.default.fileExists(atPath: file.path) {
                guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return diagnostic }
            }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.seekToEnd()
            var fields: [String: Any] = ["event": "live_precreate_failed", "failureClass": error is NativeLiveAudioError ? "audio" : "service", "code": code,
                                         "timestamp": ISO8601DateFormatter().string(from: Date())]
            if let audio = error as? NativeLiveAudioError, let detail = audio.diagnosticDetail { fields["detail"] = detail }
            var record = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
            record.append(10); try handle.write(contentsOf: record)
        } catch { /* Logging must not change the failure or restart Live. */ }
        return diagnostic
    }
    func toggleMute() {
        guard [.listening, .speaking, .muted, .pausedForInput].contains(state) else { return }
        guard muteTask == nil else { return }
        muted.toggle(); device.setMuted(muted)
        let epoch = device.captureEpoch, requestedMute = muted, token = generation
        muteTask = Task { [weak self, coordinator] in
            await coordinator.setCaptureMuted(requestedMute, epoch: epoch)
            guard let self else { return }
            self.muteTask = nil
            guard self.generation == token, self.state != .pausedForInput else { return }
            self.state = requestedMute ? .muted : (self.speaking ? .speaking : .listening)
        }
    }
    /// Stop capture and presentation synchronously before asynchronous transport cleanup.
    func stopCapture() {
        generation &+= 1; startTask?.cancel(); startTask = nil
        observer?.cancel(); observer = nil
        device.stop()
        state = .ended
    }
    func stop() async {
        stopCapture()
        let token = generation
        await coordinator.close()
        guard generation == token else { return }
        let outcome = await coordinator.state
        guard generation == token else { return }
        if case .outcomeUnknown = outcome { state = .outcomeUnknown }
        else { state = .ended }
        muted = false; speaking = false
    }
}
