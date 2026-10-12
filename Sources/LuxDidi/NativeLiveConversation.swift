import Combine
import Foundation
#if DIDI_OWNER_MODULE
import DidiOwner
#endif

@MainActor final class NativeLiveConversation: ObservableObject {
    enum State: String { case idle, connecting, listening, speaking, muted, ended, failed, outcomeUnknown }
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
    private var muted = false, speaking = false
    var isCapturing: Bool { state == .connecting || device.isCapturing }
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), dictationIsCapturing: @escaping () -> Bool, pickupJobID: String? = nil) {
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
                case .active: self.state = self.muted ? .muted : (self.speaking ? .speaking : .listening)
                case .terminal(let outcome):
                    self.device.stop()
                    self.state = outcome.state == .failed ? .failed : (outcome.state == .outcome_unknown ? .outcomeUnknown : .ended)
                case .failed(let reason):
                    self.device.stop(); self.state = .failed
                    self.failure = reason.errorDescription ?? "Live voice could not start. Check microphone permission, audio devices and configured Live service."
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
                try Task.checkCancellation()
                guard self.generation == token else { return }
                await coordinator.begin(intent)
            } catch {
                guard let self, self.generation == token else { return }
                self.device.stop(); await coordinator.close()
                guard self.generation == token else { return }
                self.failure = (error as? LiveClientError)?.errorDescription
                    ?? (error as? NativeLiveAudioError)?.errorDescription
                    ?? "Live voice could not start. Check microphone permission, audio devices and configured Live service."
                self.state = .failed
            }
        }
    }
    func toggleMute() {
        guard [.listening, .speaking, .muted].contains(state) else { return }
        muted.toggle(); device.setMuted(muted)
        state = muted ? .muted : (speaking ? .speaking : .listening)
    }
    func stop() async {
        generation &+= 1; startTask?.cancel(); startTask = nil
        observer?.cancel(); observer = nil
        device.stop()
        await coordinator.close()
        let outcome = await coordinator.state
        if case .outcomeUnknown = outcome { state = .outcomeUnknown }
        else { state = .ended }
        muted = false; speaking = false
    }
}
