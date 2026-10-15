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
    private let journal: NativeLiveJournal
    private var limits: NativeLiveLimits?
    private var muted = false, speaking = false
    /// One native-live end record per stop cycle; a repeated Stop is a no-op, like the capture summary.
    private var endRecorded = false
    private var muteTask: Task<Void, Never>?
    private var captureSummaryTask: Task<Void, Never>?
    private var captureDiagnosticOwner: UInt64?
    var isMuted: Bool { muted }
    var isCapturing: Bool { state == .connecting || state == .pausedForInput || device.isCapturing }
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), dictationIsCapturing: @escaping () -> Bool, pickupJobID: String? = nil, logsDirectory: URL? = nil, audioDevice: NativeLiveAudioDevice? = nil) {
        self.logsDirectory = logsDirectory
        self.journal = NativeLiveJournal(fileURL: logsDirectory?.appendingPathComponent("native-live.log"))
        self.http = NativeLiveOperatorHTTP(authority: authority, pickupJobID: pickupJobID)
        self.dictationIsCapturing = dictationIsCapturing
        // Production wiring: a real audio journal in the app's logs dir, shared by the owner
        // and the device so every lifecycle record lands in audio.log with a timestamp.
        let journal = logsDirectory.map { NativeAudioJournal(fileURL: $0.appendingPathComponent("audio.log")) }
        if let journal { AudioOwner.shared.adopt(journal: journal) }
        let device = audioDevice ?? NativeLiveAudioDevice(journal: journal); self.device = device
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
            self.journal.append(.routeChange)
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
            await self.stop(reason: .audioInterruption)
            guard self.generation == token else { return }
            self.failure = "Live audio could not recover. Capture released. Restart explicitly to try again."
            self.state = .failed
        }
        // E1: one native-live.log line per provider barge-in. Metadata only, read from the capture device.
        device.onLiveInterrupted = { [weak self] event in
            guard let self else { return }
            self.journal.appendInterruption(event, sessionID: await self.coordinator.sessionID ?? "unknown")
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
        failure = nil; state = .connecting; muted = false; speaking = false; endRecorded = false
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
                    switch outcome.code {
                    case "session_timeout": if !self.endRecorded { self.endRecorded = true; self.journal.append(.sessionLimit) }
                    case "idle_timeout": if !self.endRecorded { self.endRecorded = true; self.journal.append(.idleLimit) }
                    default: break
                    }
                    if let sentence = NativeLivePresentation.ended(outcome.code, limits: self.limits) {
                        self.failure = sentence
                    } else if outcome.state == .failed {
                        self.failure = outcome.code.map { "Live service: " + $0 + "." } ?? "Live service failed."
                    }
                    self.stopAudioAndSummarize()
                    self.state = outcome.state == .failed ? .failed : (outcome.state == .outcome_unknown ? .outcomeUnknown : .ended)
                case .failed(let reason):
                    self.stopAudioAndSummarize(); self.state = .failed
                    self.failure = NativeLivePresentation.failure(reason)
                    self.logFailure(reason, beforeCreate: beforeCreate)
                case .createUnknown:
                    self.stopAudioAndSummarize(); self.state = .outcomeUnknown
                    self.failure = "Live start outcome is unknown. Check the conversation before starting again."
                case .outcomeUnknown(let reason):
                    self.stopAudioAndSummarize(); self.state = .outcomeUnknown
                    if case .socketClosed(let code, _) = reason, !self.endRecorded { self.endRecorded = true; self.journal.append(.providerClosed, detail: NativeLiveEndDetail.providerClosed(closeCode: code)) }
                    self.failure = reason.errorDescription ?? "Live outcome is unknown. No automatic reconnect."
                default: break
                }
            }
        }
        startTask = Task { [weak self, coordinator, http] in
            do {
                // Reset capture authority before a new explicit start.
                guard let epoch = self?.device.captureEpoch else { return }
                await coordinator.setCaptureMuted(false, epoch: epoch, diagnosticOwner: token)
                try Task.checkCancellation()
                if self?.generation == token { self?.captureDiagnosticOwner = token }
                // Prepare the single duplex engine before the socket can deliver model PCM.
                try await self?.device.startFenced { frame, epoch in
                    if await coordinator.captureStateForSubmission(owner: token) == .active {
                        try await coordinator.sendPCM(frame, captureEpoch: epoch, diagnosticOwner: token)
                    }
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
                self.stopAudioAndSummarize(); await coordinator.close()
                guard self.generation == token else { return }
                self.failure = (error as? AudioOwnerError)?.errorDescription
                    ?? NativeLivePresentation.failure(error)
                self.logFailure(error, beforeCreate: true)
                self.state = .failed
            }
        }
    }
    @discardableResult
    func logFailure(_ error: Error, beforeCreate: Bool, diagnosticSession: URLSession? = nil) -> Task<Void, Never>? {
        guard beforeCreate else { return nil }
        let diagnostic = Task { [http] in await http.postPrecreateFailure(error, using: diagnosticSession) }
        guard logsDirectory != nil else { return diagnostic }
        let code: String
        if error is URLError { code = "service_unreachable" }
        else if error is DecodingError { code = "unexpected_response" }
        else if let reason = error as? LiveClientError { code = reason.rawValue }
        else if let owner = error as? AudioOwnerError { code = owner.rawValue }
        else if let audio = error as? NativeLiveAudioError { code = audio.rawValue }
        else { code = "connection_refused" }
        var fields: [String: Any] = ["event": "live_precreate_failed", "failureClass": error is NativeLiveAudioError ? "audio" : "service", "code": code,
                             "timestamp": ISO8601DateFormatter().string(from: Date())]
        if let audio = error as? NativeLiveAudioError, let detail = audio.diagnosticDetail { fields["detail"] = detail }
        appendLocalDiagnostic(fields)
        return diagnostic
    }
    private func appendLocalDiagnostic(_ fields: [String: Any]) {
        journal.append(fields)
    }
    private func stopAudioAndSummarize() {
        device.stop()
        guard let native = device.takeCaptureSummary(), let owner = captureDiagnosticOwner else { return }
        let nativeState = state.rawValue
        captureSummaryTask = Task { [coordinator] in
            let transport = await coordinator.captureSummary(owner: owner)
            let capture = native.capture
            var fields: [String: Any] = ["event": "native_capture_summary",
                "timestamp": ISO8601DateFormatter().string(from: Date()), "nativeState": nativeState,
                "tapBuffers": capture.tapBuffers, "convertedBytes": capture.convertedBytes,
                "convertFailures": capture.convertFailures, "maxRMS": capture.maxRMS,
                "ringDrops": capture.ringDrops, "drainFrames": native.drainFrames,
                "sentBytes": capture.sentBytes, "droppedBytes": capture.droppedBytes,
                "residualBytes": capture.residualBytes, "ledgerBalanced": capture.balances,
                "playbackUnderruns": native.playback.underruns, "lateAfterFlushChunks": native.playback.lateAfterFlush,
                "inputSampleRate": capture.inputSampleRate, "inputChannels": capture.inputChannels,
                "captureEpoch": native.captureEpoch, "captureGeneration": native.captureGeneration,
                "captureWasMuted": native.muted, "coordinatorSnapshotMatched": transport != nil]
            if let transport {
                let counts = transport.counters
                fields.merge(["outerEntered": counts.outerEntered, "outerNotActive": counts.outerNotActive,
                    "sendEntered": counts.entered, "mutedDrops": counts.mutedDrops, "epochDrops": counts.epochDrops,
                    "rebuildingDrops": counts.rebuildingDrops, "lateMutedDrops": counts.lateMutedDrops,
                    "lateEpochDrops": counts.lateEpochDrops, "lateInactiveDrops": counts.lateInactiveDrops,
                    "localSocketSendCompleted": counts.localSocketSendCompleted, "sendErrors": counts.sendErrors,
                    "coordinatorCaptureEpoch": transport.epoch, "coordinatorCaptureMuted": transport.muted,
                    "coordinatorState": transport.state, "pendingSendFrames": transport.pendingFrames],
                    uniquingKeysWith: { _, new in new })
            }
            self.appendLocalDiagnostic(fields)
        }
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
        stopAudioAndSummarize()
        state = .ended
    }
    func stop(reason: NativeLiveEndReason = .userStop) async {
        stopCapture()
        if !endRecorded { endRecorded = true; journal.append(reason) }
        let token = generation
        await coordinator.close()
        await captureSummaryTask?.value
        guard generation == token else { return }
        let outcome = await coordinator.state
        guard generation == token else { return }
        if case .outcomeUnknown = outcome { state = .outcomeUnknown }
        else { state = .ended }
        muted = false; speaking = false
    }
}
