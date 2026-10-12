import Combine
import Foundation
#if DIDI_OWNER_MODULE
import DidiOwner
#endif

@MainActor final class NativeLiveConversation: ObservableObject {
    enum State: String { case idle, connecting, listening, speaking, muted, ended, failed, outcomeUnknown, rebuilding }
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
    var isCapturing: Bool { state == .connecting || device.isCapturing }
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), dictationIsCapturing: @escaping () -> Bool, pickupJobID: String? = nil, logsDirectory: URL? = nil) {
        self.logsDirectory = logsDirectory
        self.http = NativeLiveOperatorHTTP(authority: authority, pickupJobID: pickupJobID)
        self.dictationIsCapturing = dictationIsCapturing
        let device = NativeLiveAudioDevice(); self.device = device
        coordinator = LiveSessionCoordinator(http: http, sockets: LiveSocketTransport(requests: http), sink: device)
        device.onOutput = { [weak self] speaking in
            guard let self else { return }
            self.speaking = speaking
            if [.listening, .speaking, .muted].contains(self.state) {
                self.state = self.muted ? .muted : (speaking ? .speaking : .listening)
            }
        }
        device.onInterruption = { [weak self] in
            guard let self else { return }
            await self.stop()
            self.failure = "Live audio device or service interrupted. Start explicitly to try again."
            self.state = .failed
        }
    }
    // Presentation only: an offer never opens a session, an audio engine or the microphone.
    func offerPendingCall(_ job: NativePendingLiveJob?) { pendingCall = job }
    func start() {
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
                guard let self, self.generation == token, !Task.isCancelled else { return }
                guard current == event else { continue }
                switch event {
                case .rebuilding, .active:
                    self.speaking = false
                    self.state = Self.continuityPresentation(event, muted: self.muted)!
                case .terminal(let outcome):
                    if outcome.code == "resume_failed" {
                        self.failure = "Naya's connection could not be resumed. Start Live again."
                    } else if let sentence = NativeLivePresentation.ended(outcome.code, limits: self.limits) {
                        self.failure = sentence
                    } else if outcome.state == .failed {
                        self.failure = outcome.code.map { "Live service: " + $0 + "." } ?? "Live service failed."
                    }
                    self.device.stop()
                    self.state = outcome.state == .failed ? .failed : (outcome.state == .outcome_unknown ? .outcomeUnknown : .ended)
                case .failed(let reason):
                    self.device.stop(); self.state = .failed
                    self.failure = NativeLivePresentation.failure(reason)
                    self.logFailure(reason)
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
                // Prepare the single duplex engine before the socket can deliver model PCM.
                try await self?.device.start { frame in
                    if await coordinator.state == .active { try await coordinator.sendPCM(frame) }
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
                self.logFailure(error)
                self.state = .failed
            }
        }
    }
    private func logFailure(_ error: Error) {
        guard let logsDirectory else { return }
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
                guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return }
            }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.seekToEnd()
            var record = try JSONSerialization.data(withJSONObject: ["event": "live_precreate_failed", "failureClass": error is NativeLiveAudioError ? "audio" : "service", "code": code], options: [.sortedKeys])
            record.append(10); try handle.write(contentsOf: record)
        } catch { /* Logging must not change the failure or restart Live. */ }
    }
    func toggleMute() {
        guard [.listening, .speaking, .muted].contains(state) else { return }
        muted.toggle(); device.setMuted(muted)
        state = muted ? .muted : (speaking ? .speaking : .listening)
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
        await coordinator.close()
        let outcome = await coordinator.state
        if case .outcomeUnknown = outcome { state = .outcomeUnknown }
        else { state = .ended }
        muted = false; speaking = false
    }
}
