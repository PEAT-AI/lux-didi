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
    /// #613: the shared owner-stop latch and session epoch, so recovery never outruns a stop.
    private let latch: OwnerStopLatch
    private let logsDirectory: URL?
    private let journal: NativeLiveJournal
    private var limits: NativeLiveLimits?
    private var muted = false, speaking = false
    /// One native-live end record per stop cycle; a repeated Stop is a no-op, like the capture summary.
    private var endRecorded = false
    /// #589: the host's terminal code was a voice stop, so presence closes the call as the owner's own.
    private(set) var hostVoiceStop = false
    /// Z2: when the one automatic restart after an unrequested capture interruption last ran.
    private var lastAutomaticRestartAt: Date?
    private var muteTask: Task<Void, Never>?
    /// The provider-input mute frames, in the owner's order.
    private var providerMuteTask: Task<Void, Never>?
    /// The mute request the owner made last: only it may clear the settled mute task.
    private var muteRequest: UInt64 = 0
    private var captureSummaryTask: Task<Void, Never>?
    private var captureDiagnosticOwner: UInt64?
    var isMuted: Bool { muted }
    var isCapturing: Bool { state == .connecting || state == .pausedForInput || device.isCapturing }
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), dictationIsCapturing: @escaping () -> Bool, pickupJobID: String? = nil, logsDirectory: URL? = nil, audioDevice: NativeLiveAudioDevice? = nil, latch: OwnerStopLatch = OwnerStopLatch()) {
        self.logsDirectory = logsDirectory
        self.latch = latch
        self.journal = NativeLiveJournal(fileURL: logsDirectory?.appendingPathComponent("native-live.log"))
        self.http = NativeLiveOperatorHTTP(authority: authority, pickupJobID: pickupJobID)
        self.dictationIsCapturing = dictationIsCapturing
        // Production wiring: a real audio journal in the app's logs dir, shared by the owner
        // and the device so every lifecycle record lands in audio.log with a timestamp. The owner keeps
        // the first journal, so a second conversation reuses it instead of opening a second writer.
        let journal = logsDirectory.map { NativeAudioJournal(fileURL: $0.appendingPathComponent("audio.log")) }
            .map { AudioOwner.shared.adopt(journal: $0) }
        let device = audioDevice ?? NativeLiveAudioDevice(journal: journal); self.device = device
        coordinator = LiveSessionCoordinator(http: http, sockets: LiveSocketTransport(requests: http), sink: device)
        device.onOutput = { [weak self] speaking in
            guard let self else { return }
            self.speaking = speaking
            if [.listening, .speaking, .muted].contains(self.state) {
                self.state = self.muted ? .muted : (speaking ? .speaking : .listening)
            }
        }
        // O1b-N: every playback receipt goes to the host over the socket this call already holds.
        device.onPlaybackReceipt = { [weak self] receipt in
            Task { await self?.coordinator.sendPlaybackReceipt(receipt.json) }
        }
        device.onSpeechGap = { [weak self] arrival in
            guard let self else { return }
            self.appendLocalDiagnostic(["event": "playback_speech_gap",
                "session": String(self.captureDiagnosticOwner ?? 0),
                "gapMs": arrival.dryGapMs, "burstMs": arrival.burstMs,
                "queuedMs": arrival.queuedMs, "sinceLastChunkMs": arrival.sinceLastChunkMs])
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
        device.onInterruption = { [weak self] failure in
            guard let self else { return }
            self.logCaptureInterruption(failure)
            // A stop cycle already recorded means the owner asked for it: never an automatic restart.
            let live = !self.endRecorded
            let token = self.generation &+ 1
            // #613: the epoch this recovery started under, re-read after the await below. A stop that
            // landed meanwhile voided it, so the restart never fires behind the owner's back.
            let seenEpoch = self.latch.epoch
            await self.stop(reason: .audioInterruption)
            guard self.generation == token, self.latch.allowsRestart(seenEpoch: seenEpoch) else { return }
            guard live, self.claimAutomaticRestart() else {
                self.failure = "Live audio could not recover. Capture released. Restart explicitly to try again."
                self.state = .failed
                return
            }
            self.appendLocalDiagnostic(["event": "live_restart", "reason": "capture_interruption"])
            self.start()
        }
        // E1: one native-live.log line per provider barge-in. Metadata only, read from the capture device.
        device.onLiveInterrupted = { [weak self] sample in
            guard let self else { return }
            self.journal.appendInterruption(phase: sample.isPostRms ? .post : .pre,
                sessionID: await self.coordinator.sessionID ?? "unknown",
                bufferedPlaybackMs: sample.bufferedPlaybackMs, msSinceLastModelAudio: sample.msSinceLastModelAudio,
                turnCompleteSeen: sample.turnCompleteSeen,
                rms: NativeLiveRms(mean: sample.rmsMean, max: sample.rmsMax, speechBuffers: sample.rmsSpeechBuffers),
                at: sample.at)
        }
        // P2-R1: one native-live.log line when the playback memory guard drops the queued turn.
        device.onPlaybackOverflow = { [weak self] queuedMs, buffers in
            guard let self else { return }
            self.journal.appendPlaybackOverflow(sessionID: await self.coordinator.sessionID ?? "unknown",
                                                queuedMs: queuedMs, buffers: buffers)
        }
        // Contract C1: one native-live.log line per soft wait cue played.
        device.onWaitCue = { [weak self] index, msSinceDrain in
            guard let self else { return }
            self.journal.appendWaitCue(sessionID: await self.coordinator.sessionID ?? "unknown",
                                       msSinceDrain: msSinceDrain, index: index)
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
        // #1022: the busy reading is taken here, in the synchronous prefix, before the connecting
        // ring (one main-actor hop after CONNECTING) or any live engine can start.
        device.noteOutsideDeviceBusy()
        // #613: this is the explicit start, the one thing that clears the owner-stop latch.
        latch.startRequested()
        generation &+= 1; let token = generation
        failure = nil; state = .connecting; muted = false; speaking = false; endRecorded = false
        hostVoiceStop = false
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
                case .active:
                    self.state = self.muted ? .muted : (self.speaking ? .speaking : .listening)
                    // Every native line written inside this call now carries its session id.
                    self.adoptSession(await coordinator.sessionID)
                case .rebuilding:
                    self.speaking = false
                    if self.state != .pausedForInput {
                        self.state = Self.continuityPresentation(event, muted: self.muted)!
                    }
                case .terminal(let outcome):
                    // #589: the host's voice stop is the owner's own sentence, so this end is presented as
                    // her stop. The app closes it through presence.stop(.voice), never as a session ending.
                    if outcome.code == "voice_stop" { self.hostVoiceStop = true; self.latch.ownerStopped() }
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
                    // #613: an unknown outcome is the owner's call to restart, never a recovery's.
                    if self.state == .outcomeUnknown { self.latch.ownerStopped() }
                case .failed(let reason):
                    self.stopAudioAndSummarize(); self.state = .failed
                    self.failure = NativeLivePresentation.failure(reason)
                    self.logFailure(reason, beforeCreate: beforeCreate)
                case .createUnknown:
                    self.stopAudioAndSummarize(); self.state = .outcomeUnknown
                    self.latch.ownerStopped()
                    self.failure = "Live start outcome is unknown. Check the conversation before starting again."
                case .outcomeUnknown(let reason):
                    // 3o: a refused frame is never a silent throw; the sequence, the one it had to exceed and the
                    // kind land in native-live.log before the presentation moves to outcomeUnknown.
                    if let rejection = await coordinator.takeFrameRejection() {
                        self.appendLocalDiagnostic(["event": "native_frame_rejected",
                            "sequence": rejection.sequence, "previous": rejection.previous, "kind": rejection.kind])
                    }
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
                // P3: the pace is read once, before the graph is built. A host that cannot answer plays
                // at 1.0, so a config read never keeps her from speaking.
                if let rate = (try? await http.configuredPlaybackRate()) ?? nil {
                    self?.device.playbackRate = rate
                }
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
    /// Z2: one automatic restart per 60 s. A second failure inside the window stays `.failed`.
    /// #613: a stop never waits on the host, so the mic is released here whatever the host does.
    static let stopConfirmNanos: UInt64 = 500_000_000
    private func closeOrDeadline(trigger: LiveStopTrigger) async -> LiveStopReceipt? {
        let coordinator = self.coordinator
        return await withTaskGroup(of: LiveStopReceipt?.self) { group in
            group.addTask { await coordinator.close(trigger: trigger) }
            group.addTask { try? await Task.sleep(nanoseconds: Self.stopConfirmNanos); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func claimAutomaticRestart(now: Date = Date()) -> Bool {
        if let last = lastAutomaticRestartAt, now.timeIntervalSince(last) < 60 { return false }
        lastAutomaticRestartAt = now
        return true
    }
    /// Z2: the class and code of the failure that released capture, never its message content.
    private func logCaptureInterruption(_ failure: Error?) {
        let failureClass = failure.map { String(describing: type(of: $0)) } ?? "none"
        appendLocalDiagnostic(["event": "capture_interruption", "failureClass": failureClass,
                               "code": failure.map(failureCode) ?? "unknown"])
    }
    private func failureCode(_ error: Error) -> String {
        if error is URLError { return "service_unreachable" }
        if error is DecodingError { return "unexpected_response" }
        if let reason = error as? LiveClientError { return reason.rawValue }
        if let owner = error as? AudioOwnerError { return owner.rawValue }
        if let audio = error as? NativeLiveAudioError { return audio.rawValue }
        return "connection_refused"
    }
    @discardableResult
    func logFailure(_ error: Error, beforeCreate: Bool, diagnosticSession: URLSession? = nil) -> Task<Void, Never>? {
        guard beforeCreate else { return nil }
        let diagnostic = Task { [http] in await http.postPrecreateFailure(error, using: diagnosticSession) }
        guard logsDirectory != nil else { return diagnostic }
        let code = failureCode(error)
        var fields: [String: Any] = ["event": "live_precreate_failed", "failureClass": error is NativeLiveAudioError ? "audio" : "service", "code": code]
        if let audio = error as? NativeLiveAudioError, let detail = audio.diagnosticDetail { fields["detail"] = detail }
        appendLocalDiagnostic(fields)
        return diagnostic
    }
    private func appendLocalDiagnostic(_ fields: [String: Any]) {
        journal.append(fields)
    }
    /// The live session both native journals are inside, so a line written mid-call is attributable.
    private func adoptSession(_ sessionID: String?) {
        journal.sessionID = sessionID
        AudioOwner.shared.journal?.sessionID = sessionID
    }
    private func stopAudioAndSummarize() {
        device.stop()
        device.clearOutsideDeviceBusy()
        guard let native = device.takeCaptureSummary(), let owner = captureDiagnosticOwner else { return }
        let nativeState = state.rawValue
        captureSummaryTask = Task { [coordinator] in
            let transport = await coordinator.captureSummary(owner: owner)
            let capture = native.capture
            var fields: [String: Any] = ["event": "native_capture_summary",
                "nativeState": nativeState,
                "tapBuffers": capture.tapBuffers, "convertedBytes": capture.convertedBytes,
                "convertFailures": capture.convertFailures, "maxRMS": capture.maxRMS,
                "ringDrops": capture.ringDrops, "drainFrames": native.drainFrames,
                "sentBytes": capture.sentBytes, "droppedBytes": capture.droppedBytes,
                "residualBytes": capture.residualBytes, "ledgerBalanced": capture.balances,
                "playbackQueueDrains": native.playback.queueDrains, "playbackSpeechGaps": native.playback.speechGaps,
                "lateAfterFlushChunks": native.playback.lateAfterFlush,
                "playbackRate": native.playback.rate, "playbackSpeechGapsPerMinute": native.playback.speechGapsPerMinute,
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
                    "shedFrames": counts.shedFrames,
                    "coordinatorCaptureEpoch": transport.epoch, "coordinatorCaptureMuted": transport.muted,
                    "coordinatorState": transport.state, "pendingSendFrames": transport.pendingFrames],
                    uniquingKeysWith: { _, new in new })
            }
            self.appendLocalDiagnostic(fields)
        }
    }
    func toggleMute() { setMuted(!muted) }
    /// The presence fence (council 2026-10-17, option C): the state machine names the
    /// target, the fence advances before the caller reports the mute, and muting drops
    /// the model speech already queued so silence is immediate.
    func setMuted(_ value: Bool) {
        guard [.listening, .speaking, .muted, .pausedForInput, .connecting].contains(state) else { return }
        guard value != muted else { return }
        muted = value; device.setMuted(muted)
        muteRequest &+= 1
        let request = muteRequest
        let epoch = device.captureEpoch, requestedMute = muted, token = generation
        let previous = muteTask
        muteTask = Task { [weak self, coordinator] in
            await previous?.value
            await coordinator.setCaptureMuted(requestedMute, epoch: epoch)
            guard let self else { return }
            if self.muteRequest == request { self.muteTask = nil }
            guard self.generation == token, self.state != .pausedForInput else { return }
            self.state = requestedMute ? .muted : (self.speaking ? .speaking : .listening)
        }
    }
    /// The provider-side half of the mute: one control frame on the call's own socket, so the host knows
    /// the owner is silent and never has to infer it from the uplink.
    func setProviderInputMuted(_ value: Bool) {
        guard [.listening, .speaking, .muted, .pausedForInput, .connecting].contains(state) else { return }
        let previous = providerMuteTask
        providerMuteTask = Task { [coordinator] in
            await previous?.value
            await coordinator.setInputMuted(value)
        }
    }
    /// Stop capture and presentation synchronously before asynchronous transport cleanup.
    func stopCapture() {
        generation &+= 1; startTask?.cancel(); startTask = nil
        observer?.cancel(); observer = nil
        stopAudioAndSummarize()
        state = .ended
    }
    func stop(reason: NativeLiveEndReason = .userStop, trigger: LiveStopTrigger = .other) async {
        stopCapture()
        // #613: the owner's own stop latches, so no recovery restarts this call behind him.
        if reason == .userStop { latch.ownerStopped() }
        if !endRecorded { endRecorded = true; journal.append(reason) }
        let token = generation
        let confirmed = await closeOrDeadline(trigger: trigger)
        if let receipt = confirmed {
            // 3p: the two native receipts that make a Stop readable: what pressed it, and when the wire closed behind it.
            journal.append(["event": "live_stop", "trigger": receipt.trigger.rawValue,
                            "stopRequestedAt": NativeLogClock.wallText(receipt.stopRequestedAt)])
            journal.append(["event": "socket_close_sent", "msAfterStop": receipt.socketCloseSentMs])
        } else {
            // #613: the host never confirmed, so the wire is cancelled here; the device was already stopped
            // by stopCapture, so the mic is released with no second capture summary.
            await coordinator.stop()
            state = .ended
        }
        journal.append(["event": "live_stop_outcome", "outcome": confirmed == nil ? "deadline" : "confirmed"])
        await captureSummaryTask?.value
        guard generation == token else { return }
        let outcome = await coordinator.state
        guard generation == token else { return }
        if case .outcomeUnknown = outcome, confirmed != nil { state = .outcomeUnknown }
        else { state = .ended }
        muted = false; speaking = false
        adoptSession(nil)
    }
}
