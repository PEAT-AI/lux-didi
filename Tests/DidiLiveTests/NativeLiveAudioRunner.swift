import AVFoundation
import Foundation
import DidiOwner

func audioRequire(_ value: Bool, _ message: String) throws {
    if !value { throw NSError(domain: message, code: 1) }
}

@MainActor private final class DictationRefusalAuthority {
    private(set) var attempts = 0
    func request(_ url: URL, _ epoch: String?) throws -> URLRequest {
        attempts += 1
        throw LiveClientError.unavailable
    }
}

private actor NativeAudioSendProbe {
    nonisolated let frames: AsyncStream<Data>
    private let signal: AsyncStream<Data>.Continuation
    private(set) var count = 0
    init() { (frames, signal) = AsyncStream.makeStream() }
    func send(_ frame: Data) { count += 1; signal.yield(frame) }
}

private actor NativeAudioSendGate {
    nonisolated let entered: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    private var continuation: CheckedContinuation<Void, Error>?
    init() { (entered, signal) = AsyncStream.makeStream() }
    func send(_ frame: Data) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation; signal.yield(())
        }
    }
    func fail() {
        continuation?.resume(throwing: LiveClientError.unavailable); continuation = nil
    }
}

// In-process HTTP fixture: captures the complete request, without a real timeout or server.
final class DiagnosticLogHTTPFixture: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: [URLRequest] = []
    nonisolated(unsafe) private static var status: Int? = 204
    static func reset(status: Int?) { lock.lock(); defer { lock.unlock() }; requests = []; self.status = status }
    static func captured() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "diagnostic.fixture" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var bytes = [UInt8](repeating: 0, count: 512)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }; data.append(contentsOf: bytes.prefix(count))
            }
            captured.httpBody = data
        }
        Self.lock.lock(); Self.requests.append(captured); let status = Self.status; Self.lock.unlock()
        if let status {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        } else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    }
    override func stopLoading() {}
}

// W-DIAGC: exercise the actual conversation log boundary, without starting audio.
@MainActor private func checkConversationDiagnostics() async throws {
    let started = ContinuousClock.now
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("didi-diagnostic-log-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [DiagnosticLogHTTPFixture.self]
    config.httpCookieStorage = nil; config.httpShouldSetCookies = false
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let origin = URL(string: "http://diagnostic.fixture")!
    let authority: (origin: URL, request: NativeLiveRequestBuilder) = (origin, { url, _ in
        var request = URLRequest(url: url)
        request.setValue("Bearer synthetic-operator", forHTTPHeaderField: "Authorization")
        return request
    })
    let cases: [(Error, String, String, Int?)] = [
        (NativeLiveAudioError.permissionDenied, "audio", "permissionDenied", nil),
        (NativeLiveAudioError.deviceMissing, "audio", "device_missing", nil),
        (NativeLiveAudioError.formatUnavailable, "audio", "format_unavailable", nil),
        (NativeLiveAudioError.captureNotConfigured, "audio", "capture_not_configured", nil),
        (NativeLiveAudioError.voiceProcessingFailed(code: -50), "audio", "voice_processing_failed", -50),
        (NativeLiveAudioError.engineFormatMismatch(code: -10868), "audio", "engine_format_mismatch", -10868),
        (NativeLiveAudioError.engineFailed(code: -10875), "audio", "engine_failed", -10875),
        (NativeLiveAudioError.engineFailed(code: -50), "audio", "engine_failed", -50),
        (URLError(.cannotConnectToHost), "service", "service_unreachable", nil),
        (LiveClientError.http(status: 503, code: "private description"), "service", "http", 503),
        (LiveClientError.socketClosed(code: 1006, reason: "private path"), "service", "socketClosed", 1006),
    ]
    for (index, status) in ([204, 429, nil] as [Int?]).enumerated() {
        for (caseIndex, entry) in cases.enumerated() {
            let (error, failureClass, code, detail) = entry
            let directory = root.appendingPathComponent("\(index)-\(caseIndex)-\(code)")
            let conversation = NativeLiveConversation(authority: authority, dictationIsCapturing: { false }, logsDirectory: directory)
            DiagnosticLogHTTPFixture.reset(status: status)
            let presented = conversation.failure
            let task = conversation.logFailure(error, beforeCreate: true, diagnosticSession: session)
            let file = directory.appendingPathComponent("native-live.log")
            let nativeLine = try Data(contentsOf: file)
            let nativeRecord = try JSONSerialization.jsonObject(with: Data(nativeLine.dropLast())) as! [String: Any]
            // O1b-N: every native line also carries the launch identity, both clocks and a sequence.
            let identity: Set<String> = ["timestamp", "wall_ms", "mono_ms", "source_instance_id", "source_seq"]
            let body: Set<String> = error is NativeLiveAudioError && detail != nil
                ? ["event", "failureClass", "code", "detail"] : ["event", "failureClass", "code"]
            let expectedKeys: Set<String> = body.union(identity)
            try audioRequire(Set(nativeRecord.keys) == expectedKeys && nativeRecord["event"] as? String == "live_precreate_failed"
                && nativeRecord["failureClass"] as? String == failureClass && nativeRecord["code"] as? String == code,
                "native line has the exact typed JSONL schema plus timestamp")
            if error is NativeLiveAudioError, let detail {
                try audioRequire(nativeRecord["detail"] as? Int == detail, "native audio detail remains exact")
            }
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let timestamp = nativeRecord["timestamp"] as? String
            try audioRequire(timestamp != nil && fractional.date(from: timestamp!) != nil && timestamp!.contains("."),
                "native line timestamp is ISO 8601 with fractional seconds")
            try audioRequire(nativeRecord["mono_ms"] is Int && nativeRecord["source_seq"] is Int,
                "native line carries its monotonic clock and sequence")
            try audioRequire(nativeLine.last == 10, "native line retains JSONL newline")
            await task?.value
            try audioRequire(try Data(contentsOf: file) == nativeLine, "429/transport does not alter or duplicate native log")
            try audioRequire(conversation.failure == presented, "diagnostic cannot change the owner's presentation")
            let requests = DiagnosticLogHTTPFixture.captured()
            try audioRequire(requests.count == 1, "one diagnostic from actual logFailure, no retry")
            // HTTP stays compatible; the immediate local journal above remains precise.
            let legacyAudioCodes = ["device_missing": "deviceUnavailable", "capture_not_configured": "deviceUnavailable",
                "engine_failed": "deviceUnavailable", "format_unavailable": "unsupportedFormat",
                "engine_format_mismatch": "unsupportedFormat", "voice_processing_failed": "voiceProcessingUnavailable"]
            let httpCode = error is NativeLiveAudioError ? (legacyAudioCodes[code] ?? code) : code
            var expected: [String: Any] = ["event": "live_precreate_failed", "failureClass": failureClass, "code": httpCode]
            if !(error is NativeLiveAudioError), let detail { expected["detail"] = detail }
            try audioRequire(requests[0].httpBody == JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys]), "native log boundary posts only the server vocabulary")
            DiagnosticLogHTTPFixture.reset(status: status)
            let suppressed = conversation.logFailure(error, beforeCreate: false, diagnosticSession: session)
            await suppressed?.value
            try audioRequire(DiagnosticLogHTTPFixture.captured().isEmpty, "post-CREATE failure posts nothing")
            try audioRequire(try Data(contentsOf: file) == nativeLine, "post-CREATE failure appends nothing")
            let fresh = root.appendingPathComponent("after-\(index)-\(caseIndex)-\(code)")
            let postCreate = NativeLiveConversation(authority: authority, dictationIsCapturing: { false }, logsDirectory: fresh)
            await postCreate.logFailure(error, beforeCreate: false, diagnosticSession: session)?.value
            try audioRequire(!FileManager.default.fileExists(atPath: fresh.path), "post-CREATE failure creates no native log directory")
        }
    }
    print("PASS conversation pre-CREATE native JSONL and diagnostic HTTP, 429/transport unchanged, post-CREATE both suppressed")
    print("DURATION \(started.duration(to: .now)) conversation-diagnostics")
}

/// Z2: the conversation state machine. One unrequested capture interruption restarts the call once and one more
/// inside 60 s stays `.failed`; a user Stop never restarts.
@MainActor private func checkInterruptionRestart() async throws {
    let started = ContinuousClock.now
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("didi-interruption-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let authority: (origin: URL, request: NativeLiveRequestBuilder) =
        (URL(string: "http://127.0.0.1:1")!, { _, _ in throw LiveClientError.unavailable })
    func make(_ name: String) -> (NativeLiveConversation, NativeLiveAudioDevice) {
        let device = NativeLiveAudioDevice(captureInput: format,
            defaultInput: { (id: "synthetic", name: "Synthetic input") })
        let conversation = NativeLiveConversation(authority: authority, dictationIsCapturing: { false },
            logsDirectory: root.appendingPathComponent(name), audioDevice: device)
        return (conversation, device)
    }
    func event(_ name: String, in directory: URL) throws -> [[String: Any]] {
        let file = directory.appendingPathComponent("native-live.log")
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }.filter { $0["event"] as? String == name }
    }
    func settle(_ conversation: NativeLiveConversation) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        try await Task.sleep(for: .milliseconds(1))
        while conversation.state != .failed {
            try audioRequire(ContinuousClock.now < deadline, "an interruption settles the conversation")
            await Task.yield()
        }
    }
    let restartedDirectory = root.appendingPathComponent("restart")
    let (restarted, restartedDevice) = make("restart")
    await restartedDevice.interruptForTesting(LiveClientError.transport)
    try await settle(restarted)
    let interruptions = try event("capture_interruption", in: restartedDirectory)
    try audioRequire(interruptions.count == 1, "one native-live line per capture interruption, got \(interruptions.count)")
    try audioRequire(interruptions[0]["failureClass"] as? String == "LiveClientError"
        && interruptions[0]["code"] as? String == "transport", "the line names the error class and code, never content")
    try audioRequire(try event("live_restart", in: restartedDirectory).count == 1,
        "one unrequested interruption restarts the call exactly once")
    await restartedDevice.interruptForTesting(LiveClientError.transport)
    try await settle(restarted)
    try audioRequire(try event("capture_interruption", in: restartedDirectory).count == 2,
        "the second interruption is still recorded")
    try audioRequire(try event("live_restart", in: restartedDirectory).count == 1,
        "a second interruption within 60 s never restarts again")
    try audioRequire(restarted.state == .failed
        && restarted.failure == "Live audio could not recover. Capture released. Restart explicitly to try again.",
        "a second interruption inside the window keeps the existing failed text")
    let stoppedDirectory = root.appendingPathComponent("stop")
    let (stopped, stoppedDevice) = make("stop")
    stopped.start()
    await stopped.stop(reason: .userStop, trigger: .button)
    await stoppedDevice.interruptForTesting(LiveClientError.transport)
    try await settle(stopped)
    try audioRequire(try event("capture_interruption", in: stoppedDirectory).count >= 1,
        "an interruption after a user Stop is still recorded")
    try audioRequire(try event("live_restart", in: stoppedDirectory).isEmpty, "a user Stop never restarts the call")
    await stopped.stop()
    print("PASS one interruption restarts once, a second within 60 s stays failed, a user Stop never restarts")
    print("DURATION \(started.duration(to: .now)) interruption-restart")
}

/// #657: the stop the host said itself is an end it already announced, so the record names the host's
/// end; a native Stop the host never answers still names the deadline.
@MainActor private func checkStopOutcome() async throws {
    let started = ContinuousClock.now
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("didi-stop-outcome-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let authority: (origin: URL, request: NativeLiveRequestBuilder) =
        (URL(string: "http://127.0.0.1:1")!, { _, _ in throw LiveClientError.unavailable })
    func make(_ name: String, closeHook: @escaping NativeLiveConversation.CloseHook) -> (NativeLiveConversation, URL) {
        let directory = root.appendingPathComponent(name)
        let device = NativeLiveAudioDevice(captureInput: format,
            defaultInput: { (id: "synthetic", name: "Synthetic input") })
        return (NativeLiveConversation(authority: authority, dictationIsCapturing: { false },
            logsDirectory: directory, audioDevice: device, closeHook: closeHook), directory)
    }
    func outcome(_ directory: URL) throws -> String? {
        let text = (try? String(contentsOf: directory.appendingPathComponent("native-live.log"),
            encoding: .utf8)) ?? ""
        return text.split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }.first { $0["event"] as? String == "live_stop_outcome" }?["outcome"] as? String
    }
    // The host's own voice_stop closed this session, so the close that follows has no receipt to give;
    // the voice stop travels the Stop button's own teardown (NativePresence.swift:136 to 139).
    let (hostStopped, hostDirectory) = make("host") { _ in nil }
    hostStopped.noteHostVoiceStop()
    await hostStopped.stop(reason: .userStop, trigger: .button)
    try audioRequire(try outcome(hostDirectory) == "host_ended", "a stop the host announced names the host end")
    // A native Stop whose host never answers is the deadline, and it still never holds the stop open.
    let (silent, silentDirectory) = make("silent") { _ in
        try? await Task.sleep(nanoseconds: 60_000_000_000)
        return nil
    }
    await silent.stop(reason: .userStop, trigger: .button)
    try audioRequire(started.duration(to: .now) < .seconds(2), "a silent host never holds the stop open past the deadline")
    try audioRequire(try outcome(silentDirectory) == "deadline", "a stop the host never answered names the deadline")
    try audioRequire(silent.state == .ended && hostStopped.state == .ended, "both stops settle the conversation")
    print("PASS a host announced stop names host_ended, a stop the host never answered names the deadline")
    print("DURATION \(started.duration(to: .now)) stop-outcome")
}

@MainActor private func checkCaptureTapExecutor() async throws {
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let capture = NativeCaptureBuffer(converter: try NativePCMConverter(input: format))
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
    buffer.frameLength = 1024
    for index in 0..<1024 { buffer.floatChannelData![0][index] = 0.25 }
    for _ in 0..<4 {
        try audioRequire(DidiInvokeTapOffMain(capture.makeTap(), buffer), "Objective-C capture tap executes off main")
    }
    let frame = capture.next().0
    try audioRequire(frame?.count == 640 && frame!.contains(where: { $0 != 0 }), "actual off-main tap converts nonzero PCM16/16k")
    capture.setMuted(true)
    try audioRequire(DidiInvokeTapOffMain(capture.makeTap(), buffer) && capture.next().0 == nil, "muted callback emits no PCM")
    capture.setMuted(false)
    capture.stop()
    try audioRequire(DidiInvokeTapOffMain(capture.makeTap(), buffer) && capture.next().0 == nil, "stopped callback emits no PCM")
    print("PASS production capture callback off-main, nonzero 640-byte PCM, mute and stop fences; no audio engine")
}

// Synthetic 60 s capture through the real converter and ring with an injected 200 ms sender stall:
// every converted byte is either sent, dropped by overflow/clear, or the final residual partial frame.
@MainActor private func checkCaptureLedger() async throws {
    let started = ContinuousClock.now
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: format))
    let tapFrames = 1024, taps = 60 * 48000 / tapFrames
    let stallTaps = Int(0.2 * 48000 / Double(tapFrames)) // ~192 ms without a drain
    var sent = 0, phase = 0.0
    for tap in 0..<taps {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(tapFrames))!
        buffer.frameLength = AVAudioFrameCount(tapFrames)
        let samples = buffer.floatChannelData![0]
        for index in 0..<tapFrames { samples[index] = Float(sin(phase) * 0.25); phase += 2 * .pi * 440 / 48000 }
        capture.append(buffer)
        if !(tap >= 100 && tap < 100 + stallTaps) { while let frame = capture.next().0 { sent += frame.count } }
    }
    while let frame = capture.next().0 { sent += frame.count }
    let stats = capture.stop()
    try audioRequire(stats.ringDrops == 0 && stats.droppedBytes == 0, "a 200 ms sender stall drops no frame")
    try audioRequire(stats.sentBytes == sent && stats.convertedBytes == sent + stats.residualBytes, "the drain sends every whole converted frame")
    try audioRequire(stats.balances, "converted == sent + dropped + residual")
    try audioRequire(stats.residualBytes == stats.convertedBytes % 640, "residual is the final incomplete frame")
    print("PASS 60 s synthetic capture, 200 ms stall, zero loss; ledger balances (converted=\(stats.convertedBytes) residual=\(stats.residualBytes))")
    print("DURATION capture-ledger=\(started.duration(to: .now))s")
}

// A route change to a new hardware format rebuilds the converter for that format and keeps producing
// non-zero PCM; the replacement never reuses the stale channel map.
private func checkFormatChangeRebuild() throws {
    let first = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
    let second = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    func filled(_ format: AVAudioFormat, count: Int) -> AVAudioPCMBuffer {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
        buffer.frameLength = AVAudioFrameCount(count)
        for channel in 0..<Int(format.channelCount) {
            for index in 0..<count { buffer.floatChannelData![channel][index] = 0.25 }
        }
        return buffer
    }
    func channelMap(_ owner: NativePCMConverter) -> [NSNumber] {
        (Mirror(reflecting: owner).children.first(where: { $0.label == "converter" })!.value as! AVAudioConverter).channelMap
    }
    let before = try NativePCMConverter(input: first)
    var prior = try before.append(filled(first, count: 4096))
    prior.append(try before.finish())
    let after = try NativePCMConverter(input: second)
    var rebuilt = try after.append(filled(second, count: 4096))
    rebuilt.append(try after.finish())
    try audioRequire(!prior.isEmpty && prior.contains(where: { $0 != 0 }), "predecessor format keeps non-zero PCM")
    try audioRequire(!rebuilt.isEmpty && rebuilt.contains(where: { $0 != 0 }), "new-format converter produces non-zero PCM after a format change")
    try audioRequire(channelMap(before) == [0] && channelMap(after) == [0], "each format gets a fresh channel map, never a stale one")
    print("PASS format change rebuilds the converter for the new hardware format with a fresh channel map")
}

// S2-A: production construction wires a real audio journal into the device and the owner.
@MainActor private func checkProductionAudioJournal() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("a1-journal-" + UUID().uuidString)
    let origin = URL(string: "http://127.0.0.1:1")!
    let conversation = NativeLiveConversation(
        authority: (origin, { url, _ in URLRequest(url: url) }),
        dictationIsCapturing: { false }, logsDirectory: directory)
    try audioRequire(conversation.device.hasJournal, "production construction wires an audio journal into the device")
    try audioRequire(AudioOwner.shared.hasJournal, "production construction adopts the journal on the owner")
    conversation.device.log("audio_test_event", ["probe": "1"])
    let file = conversation.device.journal?.fileURL ?? directory.appendingPathComponent("audio.log")
    let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    try audioRequire(text.contains("audio_test_event") && text.contains("timestamp"),
                     "the audio journal writes a timestamped metadata line to audio.log")
    // #477: one audio journal per process. A second conversation over the same logs directory must not
    // open a second writer on audio.log, or two handles seek to the same end and tear each other's lines.
    let second = NativeLiveConversation(
        authority: (origin, { url, _ in URLRequest(url: url) }),
        dictationIsCapturing: { false }, logsDirectory: directory)
    try audioRequire(second.device.journal === conversation.device.journal,
                     "a second conversation's device writes into the one adopted audio journal")
    try audioRequire(second.device.journal === AudioOwner.shared.journal,
                     "the device journal is the journal the owner holds")
    print("PASS production construction records timestamped audio.log metadata")
}

// S2-B: ducking is minimum with advanced ducking off while VPIO is on.
@MainActor private func checkMinimumDucking() throws {
    let configuration = NativeLiveAudioDevice.minimumDuckingConfiguration()
    try audioRequire(!configuration.enableAdvancedDucking.boolValue && configuration.duckingLevel == .min,
                     "minimum ducking with advanced ducking off")
    if #available(macOS 14.0, *) {
        NativeLiveAudioDevice.applyMinimumDucking(to: AVAudioEngine().inputNode)
    }
    print("PASS other-audio ducking set to the minimum while voice processing is on")
}

// OUTCOME 3: the weak reference proves deallocation, else audio_release_leak is logged.
@MainActor private func checkReleaseLeakAndDeallocation() throws {
    let journal = NativeAudioJournal(fileURL: nil)
    let retained = NativeLiveAudioDevice(owner: AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("a1-leak-" + UUID().uuidString)),
                                         journal: journal, deviceState: { _ in false })
    var held: AVAudioEngine? = AVAudioEngine()
    retained.adoptEngineForTesting(held!, player: AVAudioPlayerNode())
    retained.releaseForTesting()
    try audioRequire(journal.events.contains { $0.name == "audio_release_leak" },
                     "a retained engine logs audio_release_leak on release")
    held = nil
    let cleanJournal = NativeAudioJournal(fileURL: nil)
    let clean = NativeLiveAudioDevice(journal: cleanJournal, deviceState: { _ in false })
    clean.adoptEngineForTesting(AVAudioEngine(), player: AVAudioPlayerNode())
    clean.releaseForTesting()
    try audioRequire(!cleanJournal.events.contains { $0.name == "audio_release_leak" },
                     "a deallocated engine does not log audio_release_leak")
    print("PASS weak-ref dealloc and audio_release_leak")
}

// #476/V10: one audio_released per audio_owned. One release is one line, never a device line beside
// the owner's line for the same release.
@MainActor private func checkOneReleaseRecord() throws {
    let journal = NativeAudioJournal(fileURL: nil)
    let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("a1-release-" + UUID().uuidString), journal: journal)
    let device = NativeLiveAudioDevice(owner: owner, journal: journal, deviceState: { _ in false })
    try owner.acquire(holder: ObjectIdentifier(device))
    device.releaseForTesting()
    let names = journal.events.map(\.name)
    try audioRequire(names.filter { $0 == "audio_owned" }.count == 1, "one audio_owned for the lease, got \(names)")
    try audioRequire(names.filter { $0 == "audio_released" }.count == 1,
                     "one audio_released per audio_owned, got \(names)")
    print("PASS one audio_released per audio_owned; hardware=false")
}

// OUTCOME 7: a start failure tears down, releases the flock, and never retries in session.
@MainActor private func checkStartFailureCircuitBreaker() async throws {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else {
        throw NativeLiveAudioError.unsupportedFormat
    }
    let journal = NativeAudioJournal(fileURL: nil)
    let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("a1-breaker-" + UUID().uuidString))
    let device = NativeLiveAudioDevice(captureInput: format, defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                       owner: owner, journal: journal, deviceState: { _ in false },
                                       isBuiltInOutput: { false })
    device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
    device.startForTesting = { _ in throw NSError(domain: "com.apple.coreaudio.avfaudio", code: 1937010544) }
    var threw = false
    do { try await device.start { _ in } } catch { threw = true }
    try audioRequire(threw && device.sessionFailedForTesting,
                     "a start failure surfaces once and marks the session failed")
    try audioRequire(!owner.isOwned && !owner.crossProcessHeld,
                     "a start failure releases the owner and the cross-process flock")
    try audioRequire(device.audioReleaseCount == 1 && !device.isCapturing,
                     "a start failure tears down through releaseAudio")
    try audioRequire(journal.events.filter { $0.name == "audio_start_failed" }.count == 1,
                     "one audio_start_failed status line")
    var retried = false
    do { try device.rebuildForTesting() } catch { retried = true }
    try audioRequire(retried && !owner.isOwned, "no in-session retry after a start failure")
    print("PASS start-failure circuit breaker tears down, releases the flock, never retries in session")
}

// A1-R2: a busy fake device-state provider skips VPIO through the device and logs device_busy.
@MainActor private func checkBusyDeviceSkipsVoiceProcessing() async throws {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else {
        throw NativeLiveAudioError.unsupportedFormat
    }
    let journal = NativeAudioJournal(fileURL: nil)
    let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("a1-busy-" + UUID().uuidString))
    let device = NativeLiveAudioDevice(captureInput: format, defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                       owner: owner, journal: journal, deviceState: { _ in true },
                                       isBuiltInOutput: { true })
    device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
    device.startForTesting = { _ in }
    try await device.start { _ in }
    let skips = journal.events.filter { $0.name == "audio_vpio_skipped" && $0.fields["reason"] == "device_busy" }
    try audioRequire(skips.count == 1 && !device.isVoiceProcessingEnabledForTesting,
                     "a busy device skips VPIO with reason=device_busy and no voice processing")
    device.stop()
    print("PASS busy device-state provider skips voice processing through the device")
}

@MainActor private func checkTerminalCaptureSummary() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("didi-capture-summary-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
    buffer.frameLength = 4800
    buffer.floatChannelData![0].initialize(repeating: 0.25, count: 4800)
    let device = NativeLiveAudioDevice(captureInput: format,
        defaultInput: { (id: "synthetic", name: "Synthetic input") })
    device.onCapturePrepared = { capture in capture.append(buffer) }
    let authority: (origin: URL, request: NativeLiveRequestBuilder) =
        (URL(string: "http://127.0.0.1:1")!, { _, _ in throw LiveClientError.unavailable })
    let conversation = NativeLiveConversation(authority: authority, dictationIsCapturing: { false },
        logsDirectory: directory, audioDevice: device)
    conversation.start()
    let deadline = ContinuousClock.now + .seconds(3)
    while conversation.state != .failed {
        try audioRequire(ContinuousClock.now < deadline, "actual start reaches refused HTTP failure")
        await Task.yield()
    }
    await conversation.stop()
    let file = directory.appendingPathComponent("native-live.log")
    let records = try String(contentsOf: file, encoding: .utf8).split(separator: "\n").map {
        try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
    }
    let summaries = records.filter { $0["event"] as? String == "native_capture_summary" }
    try audioRequire(summaries.count == 1, "one summary for actual capture lifetime on failure then repeated Stop")
    let summary = summaries[0]
    try audioRequire(summary["tapBuffers"] as? Int == 1 && (summary["convertedBytes"] as? Int ?? 0) > 0
        && summary["convertFailures"] as? Int == 0 && (summary["maxRMS"] as? Double ?? 0) > 0,
        "summary preserves locked capture counts before teardown")
    try audioRequire(summary["inputSampleRate"] as? Int == 48000 && summary["inputChannels"] as? Int == 1
        && summary["localSocketSendCompleted"] as? Int == 0 && summary["sendErrors"] as? Int == 0,
        "numeric format and zero local sends after refused authority")
    try audioRequire(summary["ledgerBalanced"] as? Bool == true && (summary["playbackSpeechGaps"] as? Int) == 0
        && (summary["lateAfterFlushChunks"] as? Int) == 0,
        "byte ledger balances at call end with no playback speech gaps")
    device.stop(); await conversation.stop()
    try audioRequire(try String(contentsOf: file, encoding: .utf8).split(separator: "\n").count == records.count,
        "duplicate Stop emits no duplicate summary")
    print("PASS actual NativeLiveConversation Start/failure/Stop content-free capture summary; no engine or request dispatch")
}

@MainActor private func checkCaptureDropCounters() async throws {
    let origin = URL(string: "http://127.0.0.1:1")!
    let http = NativeLiveOperatorHTTP(authority: (origin, { _, _ in throw LiveClientError.unavailable }))
    let sink = NativeLiveAudioDevice(captureInput: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!,
        defaultInput: { (id: "synthetic", name: "Synthetic") })
    let coordinator = LiveSessionCoordinator(http: http, sockets: LiveSocketTransport(requests: http), sink: sink)
    await coordinator.setCaptureMuted(false, epoch: 0, diagnosticOwner: 7)
    try audioRequire(await coordinator.captureStateForSubmission(owner: 7) == .idle, "counted outer getter preserves state")
    await coordinator.setCaptureMuted(true, epoch: 1)
    try await coordinator.sendPCM(Data(repeating: 1, count: 640), captureEpoch: 0, diagnosticOwner: 7)
    await coordinator.setCaptureMuted(false, epoch: 2)
    try await coordinator.sendPCM(Data(repeating: 1, count: 640), captureEpoch: 0, diagnosticOwner: 7)
    do {
        try await coordinator.sendPCM(Data(repeating: 1, count: 640), captureEpoch: 2, diagnosticOwner: 7)
        throw RefusalForCaptureSummary.failed
    } catch LiveClientError.unavailable { }
    await coordinator.close()
    let old = await coordinator.captureSummary(owner: 7)!
    try audioRequire(old.counters.outerEntered == 1 && old.counters.outerNotActive == 1
        && old.counters.entered == 3 && old.counters.mutedDrops == 1 && old.counters.epochDrops == 1
        && old.counters.localSocketSendCompleted == 0 && old.counters.sendErrors == 1,
        "actual mute/epoch/unavailable counter branches preserve original refusals")
    await coordinator.setCaptureMuted(false, epoch: 2, diagnosticOwner: 8)
    _ = await coordinator.captureStateForSubmission(owner: 7)
    let current = await coordinator.captureSummary(owner: 8)!
    let retained = await coordinator.captureSummary(owner: 7)!
    try audioRequire(current.counters.outerEntered == 0 && current.counters.entered == 0
        && retained.counters.entered == old.counters.entered,
        "old owner snapshot is retained without attributing it to replacement")
    try audioRequire(!sink.hasEngine && !sink.isCapturing, "counter proof opens no engine or capture")
    print("PASS closed capture drop counters and old-owner summary isolation; no engine or request dispatch")
}
private enum RefusalForCaptureSummary: Error { case failed }


private func sevenChannelBuffer(_ format: AVAudioFormat, active: Int?, offset: Int) -> AVAudioPCMBuffer {
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
    buffer.frameLength = 1024
    for channel in 0..<7 {
        for frame in 0..<1024 {
            buffer.floatChannelData![channel][frame] = channel == active
                ? Float(sin(Double(offset + frame) * 2 * .pi * 440 / 48000) * 0.25) : 0
        }
    }
    return buffer
}

private func checkSevenChannelConversion() throws {
    let layout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 7)!
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, interleaved: false, channelLayout: layout)
    var rows: [[String: Any]] = []
    for active in 0..<7 {
        for mode in ["default", "downmix", "explicit"] {
            let owner = try NativePCMConverter(input: format)
            let converter = Mirror(reflecting: owner).children.first(where: { $0.label == "converter" })!.value as! AVAudioConverter
            if mode == "downmix" { converter.downmix = true }
            if mode == "explicit" { converter.channelMap = [NSNumber(value: active)] }
            var pcm = Data()
            for index in 0..<8 { pcm.append(try owner.append(sevenChannelBuffer(format, active: active, offset: index * 1024))) }
            pcm.append(try owner.finish())
            let nonzero = pcm.withUnsafeBytes { $0.bindMemory(to: Int16.self).filter { $0 != 0 }.count }
            rows.append(["activeChannel": active, "mode": mode, "bytes": pcm.count, "nonzeroSamples": nonzero,
                         "downmix": converter.downmix, "channelMap": converter.channelMap])
            try audioRequire(!pcm.isEmpty, "seven-channel conversion produces samples")
            if mode == "explicit" { try audioRequire(nonzero > 0, "explicit input channel is a nonzero positive control") }
        }
        let capture = NativeCaptureBuffer(converter: try NativePCMConverter(input: format))
        for index in 0..<8 { capture.append(sevenChannelBuffer(format, active: active, offset: index * 1024)) }
        let statistics = capture.stop()
        rows.append(["activeChannel": active, "mode": "capture-owner", "bytes": statistics.convertedBytes,
                     "maxRMS": statistics.maxRMS, "tapBuffers": statistics.tapBuffers,
                     "convertFailures": statistics.convertFailures])
    }
    let record: [String: Any] = ["inputChannels": 7, "inputSampleRate": 48000, "interleaved": false,
                               "layoutTag": format.channelLayout?.layoutTag ?? 0, "rows": rows,
                               "hardware": false, "provider": false]
    let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
    let defaultLast = rows.first { $0["activeChannel"] as? Int == 6 && $0["mode"] as? String == "default" }!
    try audioRequire((defaultLast["nonzeroSamples"] as! Int) > 0,
                     "seven-channel processed input on channel six must survive current mono conversion")
}

private func checkPrimaryChannelConversion() throws {
    let layout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 7)!
    let multichannel = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, interleaved: false, channelLayout: layout)
    let mono = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    func converted(_ format: AVAudioFormat, scenario: String, explicit: Bool) throws -> (Data, [NSNumber]) {
        let owner = try NativePCMConverter(input: format)
        let converter = Mirror(reflecting: owner).children.first(where: { $0.label == "converter" })!.value as! AVAudioConverter
        if explicit { converter.channelMap = [0] }
        var pcm = Data()
        for index in 0..<8 {
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
            buffer.frameLength = 1024
            for channel in 0..<Int(format.channelCount) {
                for frame in 0..<1024 {
                    let position = Double(index * 1024 + frame)
                    let primary = Float(sin(position * 2 * .pi * 440 / 48000) * 0.25)
                    let value: Float
                    if channel == 0 || scenario == "uniform" { value = primary }
                    else if scenario == "unrelated" { value = Float(cos(position * 2 * .pi * Double(700 + channel * 100) / 48000) * 0.5) }
                    else { value = 0 }
                    buffer.floatChannelData![channel][frame] = value
                }
            }
            pcm.append(try owner.append(buffer))
        }
        pcm.append(try owner.finish())
        return (pcm, converter.channelMap)
    }
    let (monoCurrent, _) = try converted(mono, scenario: "primary", explicit: false)
    let (monoExplicit, _) = try converted(mono, scenario: "primary", explicit: true)
    try audioRequire(monoCurrent == monoExplicit && monoCurrent.contains { $0 != 0 }, "explicit first-channel map preserves mono bytes")
    var rows: [[String: Any]] = []
    let stereo = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let (stereoCurrent, _) = try converted(stereo, scenario: "unrelated", explicit: false)
    try audioRequire(stereoCurrent == monoCurrent, "actual stereo conversion selects primary bytes without mixing channel one")
    var currentPrimary: Data?, currentUniform: Data?
    for scenario in ["primary", "uniform", "unrelated"] {
        let (current, currentMap) = try converted(multichannel, scenario: scenario, explicit: false)
        let (candidate, candidateMap) = try converted(multichannel, scenario: scenario, explicit: true)
        try audioRequire(candidate == monoCurrent, "explicit first-channel map preserves primary PCM without mixing unrelated channels")
        try audioRequire(current == monoCurrent, "actual primary-channel conversion does not mix unrelated input channels")
        rows.append(["scenario": scenario, "currentMap": currentMap, "candidateMap": candidateMap,
                     "currentBytes": current.count, "currentNonzeroSamples": current.withUnsafeBytes { $0.bindMemory(to: Int16.self).filter { $0 != 0 }.count },
                     "candidateNonzeroSamples": candidate.withUnsafeBytes { $0.bindMemory(to: Int16.self).filter { $0 != 0 }.count },
                     "candidateEqualsMono": candidate == monoCurrent])
        if scenario == "primary" { currentPrimary = current }
        if scenario == "uniform" { currentUniform = current }
    }
    let record: [String: Any] = ["layoutTag": layout.layoutTag, "inputChannels": 7, "inputSampleRate": 48000,
                               "monoByteIdentity": monoCurrent == monoExplicit, "rows": rows, "hardware": false, "provider": false]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) + Data([10]))
    try audioRequire(currentPrimary == monoCurrent && currentUniform == monoCurrent,
                     "actual converter preserves first-channel input and observed uniform seven-channel input")
}

@MainActor private final class PlaybackDriverFixture: NativePlaybackDriver {
    var scheduled: [AVAudioPCMBuffer] = []
    var active: [AVAudioPCMBuffer] = []
    var completions: [@Sendable () -> Void] = []
    var plays = 0, stops = 0
    func schedule(_ buffer: AVAudioPCMBuffer, completion: @escaping @Sendable () -> Void) {
        scheduled.append(buffer); active.append(buffer); completions.append(completion)
    }
    func play() { plays += 1 }
    func stop() { stops += 1; active.removeAll() }
}

@MainActor private func checkPlaybackMuteFence() async throws {
    let driver = PlaybackDriverFixture(), device = NativeLiveAudioDevice()
    device.playbackDriverForTesting = driver
    var output: [Bool] = []
    device.onOutput = { output.append($0) }
    func pcm(_ sample: Int16) -> Data { [Int16](repeating: sample.littleEndian, count: 2400).withUnsafeBytes { Data($0) } }
    try await device.write(pcm(12000))
    try audioRequire(driver.scheduled.count == 1 && driver.plays == 1 && output.last == true,
                     "control: actual write schedules nonzero PCM and starts the fake player")
    let oldCompletion = driver.completions[0]
    device.setMuted(true)
    try audioRequire(driver.active.isEmpty && !device.isPlayingOutput,
                     "mute clears the actual scheduled tail and speaking state")
    try await device.write(pcm(12000))
    try audioRequire(driver.scheduled.count == 1, "muted actual write schedules no arriving PCM")
    device.setMuted(false)
    try await device.write(pcm(5000))
    try audioRequire(driver.scheduled.count == 2 && driver.active.count == 1,
                     "unmute schedules only new PCM, never the discarded tail")
    oldCompletion()
    for _ in 0..<8 { await Task.yield() }
    try audioRequire(device.isPlayingOutput && driver.active.count == 1,
                     "a stale pre-mute completion cannot drain post-unmute speech")
    driver.completions.last?()
    for _ in 0..<8 { await Task.yield() }
    try audioRequire(!device.isPlayingOutput && !device.hasEngine && !device.isCapturing,
                     "completion drains real device state without hardware or capture")
    print("PASS actual write control, hot-mute PCM fence, unmute tail and stale completion; hardware=false")
}

@MainActor private func checkPlaybackSilenceState() async throws {
    let driver = PlaybackDriverFixture(), device = NativeLiveAudioDevice()
    device.playbackDriverForTesting = driver
    var output: [Bool] = []
    device.onOutput = { output.append($0) }
    let quiet = Data(count: 4800)
    let speech = [Int16](repeating: 5000, count: 2400).withUnsafeBytes { Data($0) }
    try await device.write(quiet)
    try audioRequire(driver.scheduled.count == 1 && driver.plays == 1 && !device.isPlayingOutput && !output.contains(true),
                     "silent fill is scheduled but never claims speaking")
    try await device.write(speech)
    try audioRequire(!device.isPlayingOutput, "speech queued behind silence does not claim an early speaking state")
    driver.completions[0]()
    for _ in 0..<8 { await Task.yield() }
    try audioRequire(device.isPlayingOutput && device.outputLevel > 0,
                     "completion advances the actual queue head to audible speech")
    try await device.write(quiet)
    try audioRequire(device.isPlayingOutput && device.outputLevel > 0,
                     "arriving fill cannot hide speech still at the queue head")
    driver.completions[1]()
    for _ in 0..<8 { await Task.yield() }
    try audioRequire(!device.isPlayingOutput && device.outputLevel == 0,
                     "completion advances from speech to silent fill without a false speaking claim")
    driver.completions[2]()
    for _ in 0..<8 { await Task.yield() }
    let samples = driver.scheduled.flatMap { Array(UnsafeBufferPointer(start: $0.floatChannelData![0], count: Int($0.frameLength))) }
    try audioRequire(samples.count == 7200 && samples.prefix(2400).allSatisfy { $0 == 0 }
        && samples.dropFirst(2400).prefix(2400).allSatisfy { $0 == Float(5000) / 32768 }
        && samples.suffix(2400).allSatisfy { $0 == 0 }, "actual write preserves every speech and fill sample in order")
    try audioRequire(!device.hasEngine && !device.isCapturing, "state proof opens no engine or capture")
    print("PASS actual write silence/speech queue-head state and all timing PCM conserved; hardware=false")
}

// H13/V7 (#476): the receipt that says the owner actually heard her. The first chunk of an assistant
// playback segment that becomes audible sends one `playback.audible` for that segment, and only one.
@MainActor private func checkPlaybackAudibleReceipt() async throws {
    let driver = PlaybackDriverFixture(), device = NativeLiveAudioDevice()
    device.playbackDriverForTesting = driver
    var receipts: [NativePlaybackReceipt] = []
    device.onPlaybackReceipt = { receipts.append($0) }
    let quiet = Data(count: 4800)
    let speech = [Int16](repeating: 5000, count: 2400).withUnsafeBytes { Data($0) }
    try await device.write(quiet)
    try audioRequire(!receipts.contains { $0.kind == .audible },
                     "silence under the audibility threshold never claims playback.audible")
    try await device.write(speech)
    let audible = receipts.filter { $0.kind == .audible }
    try audioRequire(audible.count == 1, "the first audible chunk of a segment sends one playback.audible")
    try audioRequire(audible.first?.segmentSeq == receipts.first?.segmentSeq,
                     "the audible receipt names the segment the next receipts name")
    try await device.write(speech)
    try audioRequire(receipts.filter { $0.kind == .audible }.count == 1,
                     "one audible receipt per segment, never one per audible chunk")
    let wire = audible.first?.json ?? ""
    try audioRequire(wire.contains("\"receipt\":\"audible\"") && wire.contains("segment_seq"),
                     "the audible receipt is the closed receipt frame, ids only")
    try audioRequire(!wire.lowercased().contains("text") && !wire.contains("pcm"),
                     "the audible receipt carries no owner audio or text")
    print("PASS first audible chunk of a segment sends one playback.audible receipt; hardware=false")
}

@MainActor private func checkPlaybackOverflowContinuation() async throws {
    let full = Data(count: NativePlaybackQueue.overflowFrames * 2)
    for externalMute in [false, true] {
        let driver = PlaybackDriverFixture(), device = NativeLiveAudioDevice()
        device.playbackDriverForTesting = driver
        try await device.write(full)
        var overflows = 0
        device.onPlaybackOverflow = { _, _ in
            overflows += 1
            if externalMute { device.setMuted(true); device.setMuted(false) }
        }
        try await device.write(Data(count: 4800))
        try audioRequire(overflows == 1, "control reaches the unchanged playback memory guard")
        try audioRequire(driver.scheduled.count == (externalMute ? 1 : 2),
                         "memory guard keeps its new frame but an external mute invalidates the old in-flight frame")
    }
    print("PASS memory guard continuation retains current frame and rejects external mute generation; hardware=false")
}

@MainActor private func checkPlaybackGapMetrics() async throws {
    let scenarios: [(Int16, Int16, Int, Int)] = [
        (0, 0, 0, 0), (5000, 5000, 0, 0), (5000, 5000, 25, 1),
        (5000, 0, 25, 0), (0, 5000, 25, 0), (5000, 5000, 600, 0)
    ]
    for (before, after, delay, expected) in scenarios {
        var clock = Date(timeIntervalSince1970: 1000)
        let driver = PlaybackDriverFixture(), device = NativeLiveAudioDevice(now: { clock })
        device.playbackDriverForTesting = driver
        var gaps: [NativePlaybackArrival] = []
        device.onSpeechGap = { gaps.append($0) }
        func pcm(_ value: Int16) -> Data { [Int16](repeating: value, count: 2400).withUnsafeBytes { Data($0) } }
        try await device.write(pcm(before))
        clock = clock.addingTimeInterval(0.1)
        driver.completions[0]()
        for _ in 0..<8 { await Task.yield() }
        clock = clock.addingTimeInterval(Double(delay) / 1000)
        try await device.write(pcm(after))
        try audioRequire(gaps.count == expected,
                         "positive speech gaps only: before=\(before), after=\(after), gap=\(delay), expected=\(expected), actual=\(gaps.count)")
        try audioRequire(device.playbackStatisticsForTesting.queueDrains == 1
            && device.playbackStatisticsForTesting.speechGaps == expected, "raw drains and positive speech gaps remain separate")
        if expected > 0 { try audioRequire(gaps[0].dryGapMs == delay, "the gap receipt carries its measured positive duration") }
    }
    var clock = Date(timeIntervalSince1970: 1000)
    let driver = PlaybackDriverFixture(), device = NativeLiveAudioDevice(now: { clock })
    device.playbackDriverForTesting = driver
    for index in 0..<100 {
        try await device.write(Data(count: 4800))
        clock = clock.addingTimeInterval(0.1)
        driver.completions[index]()
        for _ in 0..<8 { await Task.yield() }
    }
    try audioRequire(device.playbackStatisticsForTesting.queueDrains == 100
        && device.playbackStatisticsForTesting.speechGaps == 0,
                     "ten seconds of perfect digital silence reports 100 raw drains and zero speech gaps")
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let sessionDriver = PlaybackDriverFixture()
    let session = NativeLiveAudioDevice(captureInput: format, defaultInput: { ("synthetic", "Synthetic input") }, now: { clock })
    session.playbackDriverForTesting = sessionDriver
    for _ in 0..<2 {
        try await session.startFenced { _, _ in }
        try await session.write(Data(count: 4800))
        clock = clock.addingTimeInterval(0.1)
        sessionDriver.completions.last?()
        for _ in 0..<8 { await Task.yield() }
        clock = clock.addingTimeInterval(0.9)
        session.stop()
        let summary = session.takeCaptureSummary()
        try audioRequire(summary?.playback.queueDrains == 1 && summary?.playback.speechGaps == 0
            && summary?.playback.sessionMs == 1000 && summary?.playback.rate == 1,
                         "each synthetic capture lifetime owns fresh playback counters and its full duration at 1.00")
    }
    print("PASS actual callback/arrival zero boundaries, silent fill, positive speech gap and long-pause controls; hardware=false")
}

@main struct NativeLiveAudioRunner {
    static func tone(_ format: AVAudioFormat, start: Int, count: Int) throws -> AVAudioPCMBuffer {
        guard format.channelCount == 2, format.commonFormat == .pcmFormatFloat32, !format.isInterleaved else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channels = buffer.floatChannelData else { throw NativeLiveAudioError.allocationFailed }
        buffer.frameLength = AVAudioFrameCount(count)
        for i in 0..<count {
            let sample = Float(sin(Double(start + i) * 2 * .pi * 440 / 44100) * 0.25)
            channels[0][i] = sample
            channels[1][i] = sample
        }
        return buffer
    }

    /// The owner mutes with Right Command and another app needs the microphone: the mute must stop
    /// the engine, drop the voice-processing unit and give the audio owner back, and unmute must
    /// rebuild capture alone (no reconnect, no ring).
    @MainActor static func checkMuteReleasesMicrophone() async throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100,
                                         channels: 2, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        let journal = NativeAudioJournal(fileURL: nil)
        let lockURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mute-release-" + UUID().uuidString)
        let owner = AudioOwner(lockFileURL: lockURL, journal: journal)
        let device = NativeLiveAudioDevice(captureInput: format,
                                          defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                          owner: owner, journal: journal,
                                          deviceState: { _ in false }, isBuiltInOutput: { true })
        var starts = 0
        var captures: [NativeCaptureBuffer] = []
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in starts += 1 }
        device.onCapturePrepared = { captures.append($0) }
        let sends = NativeAudioSendProbe()
        try await device.start { await sends.send($0) }
        try audioRequire(device.hasEngine && device.isCapturing && owner.isOwned,
                         "control: start holds the engine, the capture and the audio owner")
        try audioRequire(device.isVoiceProcessingEnabledForTesting,
                         "control: the built-in output route takes voice processing")
        let generation = device.captureGeneration, epoch = device.captureEpoch
        let releases = device.audioReleaseCount

        device.setMuted(true)
        try audioRequire(!device.hasEngine && device.isCapturing,
                         "mute stops the engine and drops the tap and voice-processing unit with it")
        try audioRequire(device.audioReleaseCount == releases + 1,
                         "mute tears the device down through the one release path")
        try audioRequire(!owner.isOwned && !owner.crossProcessHeld,
                         "mute releases the audio owner and the cross-process lock")
        let another = AudioOwner(lockFileURL: lockURL)
        try another.acquire(holder: ObjectIdentifier(another))
        another.release(holder: ObjectIdentifier(another))
        let released = journal.events.filter { $0.name == "audio_muted_release" }
        try audioRequire(released.count == 1, "one mute release record, got \(released.count)")
        try audioRequire(released[0].fields["generation"] == String(device.captureGeneration)
                            && released[0].fields["epoch"] == String(epoch + 1),
                         "the release record carries the closed tokens it ended")

        device.setMuted(false)
        try audioRequire(starts == 2, "unmute starts the engine exactly once, got \(starts - 1)")
        try audioRequire(device.hasEngine && device.isCapturing && owner.isOwned,
                         "unmute rebuilds capture and holds the owner again")
        try audioRequire(device.isVoiceProcessingEnabledForTesting,
                         "unmute takes the same voice-processing decision as at call start")
        try audioRequire(device.captureGeneration == generation + 2
                            && device.captureEpoch == epoch + 2,
                         "unmute opens a new capture generation and epoch")
        let acquired = journal.events.filter { $0.name == "audio_muted_reacquire" }
        try audioRequire(acquired.count == 1 && acquired[0].fields["generation"] == String(generation + 2)
                            && acquired[0].fields["epoch"] == String(epoch + 2)
                            && Int(acquired[0].fields["acquireMs"] ?? "") != nil,
                         "the re-acquire record carries its new tokens and its time in ms")
        let before = await sends.count
        guard let rebuilt = captures.last else { throw NativeLiveAudioError.captureNotConfigured }
        rebuilt.append(try tone(format, start: 4410, count: 1024))
        for _ in 0..<2000 {
            if await sends.count > before { break }
            await Task.yield()
        }
        try audioRequire(await sends.count > before,
                         "unmute delivers frames on the same send closure, so nothing reconnected")

        for _ in 0..<10 { device.setMuted(true); device.setMuted(false) }
        try audioRequire(device.hasEngine && device.isCapturing && owner.isOwned,
                         "ten fast toggles end with exactly one engine when unmuted")
        try audioRequire(!journal.events.contains { $0.name == "audio_release_leak" },
                         "no toggle retains an engine past its release")
        device.setMuted(true)
        try audioRequire(!device.hasEngine && !owner.isOwned,
                         "ten fast toggles end with no engine while muted")
        device.stop()
        deviceInputIsFree(lockURL: lockURL, "the mute never holds the microphone past a toggle")
        print("PASS mute releases the microphone: engine stopped, tap and voice processing dropped, "
              + "owner free for another app, one re-acquire and one generation per unmute")
    }

    /// A re-acquire that hits another app's hold fails loudly through the existing audio_refused
    /// record, never by capturing while another app owns the device.
    @MainActor static func checkMuteReacquireRefusal() async throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100,
                                         channels: 2, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        let journal = NativeAudioJournal(fileURL: nil)
        let lockURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mute-refused-" + UUID().uuidString)
        let owner = AudioOwner(lockFileURL: lockURL, journal: journal)
        let device = NativeLiveAudioDevice(captureInput: format,
                                          defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                          owner: owner, journal: journal,
                                          deviceState: { _ in false }, isBuiltInOutput: { true })
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in }
        try await device.start { _ in }
        device.setMuted(true)
        let taken = AudioOwner(lockFileURL: lockURL)
        try taken.acquire(holder: ObjectIdentifier(taken))
        device.setMuted(false)
        let refused = journal.events.filter { $0.name == "audio_refused" }
        try audioRequire(refused.map { $0.fields["reason"] } == ["already_in_use", "audio_already_in_use"],
                         "a refused re-acquire on unmute surfaces audio_refused, got \(refused.map { $0.fields["reason"] ?? "-" })")
        let failedReacquire = journal.events.filter { $0.name == "audio_muted_reacquire_failed" }
        try audioRequire(failedReacquire.count == 1
                            && failedReacquire[0].fields["reason"] == "audio_already_in_use",
                         "one re-acquire failure record carrying the refusal")
        try audioRequire(!device.hasEngine && !owner.isOwned,
                         "a refused re-acquire leaves no engine and no owner")
        taken.release(holder: ObjectIdentifier(taken))
        device.stop()
        print("PASS mute re-acquire refusal: another app's hold on the device surfaces audio_refused")
    }

    /// A mute and unmute on a device with no session leaves one closed record and no work.
    @MainActor static func checkMuteWithoutSession() async throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100,
                                         channels: 2, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        let journal = NativeAudioJournal(fileURL: nil)
        let device = NativeLiveAudioDevice(captureInput: format,
                                          defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                          journal: journal)
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in }
        device.setMuted(true)
        device.setMuted(false)
        let skipped = journal.events.filter { $0.name == "audio_muted_reacquire_skipped" }
        try audioRequire(skipped.count == 1 && skipped[0].fields["reason"] == "no_send",
                         "an unmute with no session says so in one record, never silently")
        try audioRequire(!device.hasEngine, "a device with no session opens no engine")
        print("PASS mute without a session: the skipped re-acquire leaves one record")
    }

    /// A mute that lands while the call is still connecting, before capture exists, must keep the
    /// microphone closed: the engine opens on unmute, never on start.
    @MainActor static func checkMuteBeforeCapture() async throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100,
                                         channels: 2, interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        let journal = NativeAudioJournal(fileURL: nil)
        let lockURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mute-connecting-" + UUID().uuidString)
        let owner = AudioOwner(lockFileURL: lockURL, journal: journal)
        let device = NativeLiveAudioDevice(captureInput: format,
                                          defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                          owner: owner, journal: journal,
                                          deviceState: { _ in false }, isBuiltInOutput: { true })
        var starts = 0
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in starts += 1 }
        let sends = NativeAudioSendProbe()
        device.setMuted(true)
        try await device.start { await sends.send($0) }
        try audioRequire(!device.hasEngine && !owner.isOwned && starts == 0,
                         "a mute before capture exists keeps the engine and the microphone closed")
        try audioRequire(journal.events.contains { $0.name == "audio_muted_start_skipped" },
                         "the start held back by the mute leaves one record")
        device.setMuted(false)
        try audioRequire(starts == 1 && device.hasEngine && owner.isOwned,
                         "unmute opens the one engine the mute held back")
        device.stop()
        print("PASS mute before capture: a connecting mute keeps the microphone closed until unmute")
    }

    @MainActor static func deviceInputIsFree(lockURL: URL, _ message: String) {
        let probe = AudioOwner(lockFileURL: lockURL)
        do { try probe.acquire(holder: ObjectIdentifier(probe)) } catch {
            print("FAIL \(message): the lock is still held")
            exit(1)
        }
        probe.release(holder: ObjectIdentifier(probe))
    }

    @MainActor static func main() async {
        if CommandLine.arguments.dropFirst().contains("--playback-metrics-only") {
            do { try await checkPlaybackGapMetrics() }
            catch { FileHandle.standardError.write(Data("Playback metrics: \(error)\n".utf8)); exit(1) }
            return
        }

        if CommandLine.arguments.dropFirst().contains("--playback-audible-only") {
            do { try await checkPlaybackAudibleReceipt() }
            catch { FileHandle.standardError.write(Data("Playback audible: \(error)\n".utf8)); exit(1) }
            return
        }

        if CommandLine.arguments.dropFirst().contains("--one-release-only") {
            do { try checkOneReleaseRecord() }
            catch { FileHandle.standardError.write(Data("One release record: \(error)\n".utf8)); exit(1) }
            return
        }

        if CommandLine.arguments.dropFirst().contains("--playback-state-only") {
            do { try await checkPlaybackSilenceState() }
            catch { FileHandle.standardError.write(Data("Playback state: \(error)\n".utf8)); exit(1) }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--playback-overflow-only") {
            do { try await checkPlaybackOverflowContinuation() }
            catch { FileHandle.standardError.write(Data("Playback overflow: \(error)\n".utf8)); exit(1) }
            return
        }

        if CommandLine.arguments.dropFirst().contains("--playback-fences-only") {
            do { try await checkPlaybackMuteFence() }
            catch { FileHandle.standardError.write(Data("Playback fence: \(error)\n".utf8)); exit(1) }
            return
        }

        if CommandLine.arguments.dropFirst().contains("--primary-channel-only") {
            do { try checkPrimaryChannelConversion() }
            catch { FileHandle.standardError.write(Data("Primary-channel conversion: \(error)\n".utf8)); exit(1) }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--seven-channel-only") {
            do { try checkSevenChannelConversion() }
            catch { FileHandle.standardError.write(Data("Seven-channel conversion: \(error)\n".utf8)); exit(1) }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--capture-summary-only") {
            do { try await checkTerminalCaptureSummary() }
            catch { fatalError("Capture summary: \(error)") }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--stop-outcome-only") {
            do { try await checkStopOutcome() }
            catch { fatalError("Stop outcome: \(error)") }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--capture-tap-only") {
            do { try await checkCaptureTapExecutor() }
            catch { fatalError("Capture tap: \(error)") }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--capture-ledger-only") {
            do { try await checkCaptureLedger() }
            catch { fatalError("Capture ledger: \(error)") }
            return
        }
        if CommandLine.arguments.dropFirst().contains("--format-change-only") {
            do { try checkFormatChangeRebuild() }
            catch { fatalError("Format change: \(error)") }
            return
        }
        do { try await checkPlaybackAudibleReceipt() }
        catch { FileHandle.standardError.write(Data("Playback audible: \(error)\n".utf8)); exit(1) }
        do { try checkOneReleaseRecord() }
        catch { FileHandle.standardError.write(Data("One release record: \(error)\n".utf8)); exit(1) }
        do { try await checkPlaybackSilenceState(); try await checkPlaybackOverflowContinuation(); try await checkPlaybackGapMetrics() }
        catch { FileHandle.standardError.write(Data("Playback state: \(error)\n".utf8)); exit(1) }
        do { try await checkPlaybackMuteFence() }
        catch { FileHandle.standardError.write(Data("Playback fence: \(error)\n".utf8)); exit(1) }
        do { try checkPrimaryChannelConversion() }
        catch { fatalError("Primary-channel conversion: \(error)") }
        do { try checkFormatChangeRebuild() }
        catch { fatalError("Format change: \(error)") }
        do {
            for state in NativeLiveConversation.State.allCases {
                let presentation = state.presentation
                try audioRequire(!presentation.text.isEmpty && !presentation.symbol.isEmpty, "every Live case has a sentence and icon")
                try audioRequire(presentation.text != state.rawValue, "raw case never reaches Live presentation")
            }
        } catch { fatalError("Live presentation: \(error)") }
        do {
            // An attached mixer stands in for the output node: no hardware, tap or engine start.
            let graph = AVAudioEngine(), player = AVAudioPlayerNode(), output = AVAudioMixerNode()
            graph.attach(output)
            let required = output.inputFormat(forBus: 0)
            try NativeLiveAudioDevice.connectPlayback(engine: graph, player: player, outputNode: output)
            let negotiated = graph.mainMixerNode.outputFormat(forBus: 0)
            try audioRequire(negotiated.sampleRate == required.sampleRate && negotiated.channelCount == required.channelCount,
                             "mixer output negotiates the output node input bus format")
            let converted = player.outputFormat(forBus: 0)
            try audioRequire(converted.sampleRate == 24000 && converted.channelCount == 1,
                             "player keeps 24 kHz mono conversion")
            let invalidGraph = AVAudioEngine(), invalidPlayer = AVAudioPlayerNode(), invalidOutput = AVAudioMixerNode()
            invalidGraph.attach(invalidOutput)
            do {
                try NativeLiveAudioDevice.connectPlayback(engine: invalidGraph, player: invalidPlayer,
                    outputNode: invalidOutput, outputFormat: AVAudioFormat(standardFormatWithSampleRate: 0, channels: 2)!)
                throw NSError(domain: "invalid output format accepted", code: 1)
            } catch NativeLiveAudioError.formatUnavailable { }
        } catch { fatalError("Playback negotiation: \(error)") }
        do {
            // P3: the same graph at 1.08x. The stretcher sits between the player and the mixer, her pitch
            // never moves, and the format the player emits is untouched.
            let graph = AVAudioEngine(), player = AVAudioPlayerNode(), output = AVAudioMixerNode()
            graph.attach(output)
            let required = output.inputFormat(forBus: 0)
            let unit = try NativeLiveAudioDevice.connectPlayback(engine: graph, player: player, outputNode: output, rate: 1.08)
            try audioRequire(unit?.rate == 1.08, "the stretcher plays at the configured rate")
            try audioRequire(unit?.pitch == 0, "the pitch never moves")
            let stretched = player.outputFormat(forBus: 0)
            try audioRequire(stretched.sampleRate == 24000 && stretched.channelCount == 1,
                             "the player still emits 24 kHz mono")
            let negotiated = graph.mainMixerNode.outputFormat(forBus: 0)
            try audioRequire(negotiated.sampleRate == required.sampleRate && negotiated.channelCount == required.channelCount,
                             "the output node still receives the bus format it negotiated")
            // Nothing is inserted at 1.0, so today's graph is byte for byte the two connections it was.
            let plainGraph = AVAudioEngine(), plainPlayer = AVAudioPlayerNode(), plainOutput = AVAudioMixerNode()
            plainGraph.attach(plainOutput)
            let inserted = try NativeLiveAudioDevice.connectPlayback(engine: plainGraph, player: plainPlayer, outputNode: plainOutput)
            try audioRequire(inserted == nil, "rate 1.0 inserts no unit")
            // P3: a drain at 1.08x is shorter than its source audio, so turn end follows audible time.
            try audioRequire(NativePlaybackQueue.ms(24000) == 1000, "rate 1.0 keeps today's integer milliseconds")
            let scaled = NativePlaybackQueue.ms(24000, rate: 1.08)
            try audioRequire(abs(scaled - Int((1000.0 / 1.08).rounded())) <= 50,
                             "a drained second of audio ends at the scaled duration, got \(scaled) ms")
            var queue = NativePlaybackQueue(); queue.rate = 1.08
            var starts = 0
            for index in 0..<10 {
                if queue.arrival(frames: 2400, atMs: index * 100).start { starts += 1 }
            }
            try audioRequire(starts == 1, "one second of source audio starts the player exactly once")
            try audioRequire(NativePlaybackQueue.ms(queue.scheduledFrames, rate: queue.rate) == scaled,
                             "the queue reports the same audible duration the turn ends on")
            // A barge-in clears the stretcher's tail too, so no syllable survives the flush.
            let device = NativeLiveAudioDevice()
            let stretcher = AVAudioUnitTimePitch(); stretcher.rate = 1.08
            device.adoptTimePitchForTesting(stretcher)
            try await device.flush()
            try audioRequire(device.timePitchTailFlushes == 1, "a barge-in flush resets the stretcher")
            let plainDevice = NativeLiveAudioDevice()
            try await plainDevice.flush()
            try audioRequire(plainDevice.timePitchTailFlushes == 0, "a 1.0 session has no stretcher to flush")
            // A rate outside the band is clamped to 1.0 here; the config layer refuses it before this point.
            try audioRequire(NativePlaybackRate.valid(1.08) == 1.08 && NativePlaybackRate.valid(1.2) == 1.2,
                             "the band is inclusive of both ends")
            try audioRequire(NativePlaybackRate.valid(1.3) == 1 && NativePlaybackRate.valid(0.9) == 1,
                             "a rate outside 1.0 to 1.2 falls back to today's speed")
            print("PASS pitch-preserving playback rate: 1.0 inserts no unit, 1.08 stretches between player and mixer with pitch 0, drain scales, flush clears the tail")
        } catch { fatalError("Playback rate: \(error)") }
        do {
            let routeTestStarted = Date()
            var builds = 0, releases = 0, paused = "", failures = 0
            var input = "Built-in microphone"
            let recovery = NativeAudioRouteRecovery(
                input: { input }, release: { releases += 1 },
                rebuild: { builds += 1 }, paused: { paused = $0 }, failed: { failures += 1 })
            recovery.begin()
            recovery.changed(); recovery.changed(); recovery.changed()
            await recovery.pending?.value
            try audioRequire(builds == 1 && releases == 1, "route storm must rebuild once")
            input = "USB microphone"
            recovery.changed(); await recovery.pending?.value
            try audioRequire(builds == 1 && paused == input && recovery.awaitingResume,
                             "input change needs owner Resume, not a new session")
            recovery.resume()
            try audioRequire(builds == 2 && !recovery.awaitingResume, "Resume rebuilds authorized capture")
            recovery.changed(); recovery.stop(); await recovery.pending?.value
            try audioRequire(builds == 2, "Stop fences queued recovery")
            let failedRecovery = NativeAudioRouteRecovery(input: { input }, release: { releases += 1 },
                rebuild: { throw NativeLiveAudioError.deviceMissing }, paused: { _ in }, failed: { failures += 1 })
            failedRecovery.begin(); failedRecovery.changed(); await failedRecovery.pending?.value
            try audioRequire(failures == 1 && !failedRecovery.authorized, "failed rebuild releases authorization")
            input = ""
            let missingInput = NativeAudioRouteRecovery(input: { input }, release: { releases += 1 },
                rebuild: { builds += 1 }, paused: { _ in paused = "invalid pause" }, failed: { failures += 1 })
            missingInput.begin(); missingInput.changed()
            try audioRequire(failures == 2 && !missingInput.authorized && missingInput.pending == nil,
                             "missing input immediately releases capture and requests Restart")
            try audioRequire(paused != "invalid pause", "missing input must never offer Resume")
            print("PASS route storm, input consent, Resume, Stop fencing, missing input and failed rebuild")
            try await checkTerminalCaptureSummary()
            try await checkCaptureDropCounters()
            try await checkCaptureTapExecutor()
            try await checkCaptureLedger()
            try await checkConversationDiagnostics()
            try await checkInterruptionRestart()
            try await checkStopOutcome()
            try checkProductionAudioJournal()
            try checkMinimumDucking()
            try checkReleaseLeakAndDeallocation()
            try await checkStartFailureCircuitBreaker()
            try await checkBusyDeviceSkipsVoiceProcessing()
            try await checkMuteReleasesMicrophone()
            try await checkMuteReacquireRefusal()
            try await checkMuteWithoutSession()
            try await checkMuteBeforeCapture()
            try await VoiceProcessingSnapshotTests.run()
            guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else {
                throw NativeLiveAudioError.unsupportedFormat
            }
            var deviceInput = (id: "builtin", name: "Built-in microphone")
            var testNow = Date()
            var captures: [NativeCaptureBuffer] = []
            let injectedDevice = NativeLiveAudioDevice(captureInput: format, defaultInput: { deviceInput },
                                                       now: { testNow })
            injectedDevice.onCapturePrepared = { captures.append($0) }
            let sends = NativeAudioSendProbe()
            try await injectedDevice.start { await sends.send($0) }
            try audioRequire(injectedDevice.hasConfigurationObserver,
                             "start installs the configuration observer that release removes")
            let originalCapture = captures[0]
            originalCapture.append(try tone(format, start: 0, count: 2000))
            // An unchanged default device never rebuilds, however many notifications arrive.
            injectedDevice.routeChanged(); injectedDevice.routeChanged(); injectedDevice.routeChanged()
            await injectedDevice.finishRouteRecovery()
            try audioRequire(captures.count == 1, "unchanged route storms are ignored, never rebuilt")
            // A real input change releases capture, then auto-resumes on the new device.
            testNow = testNow.addingTimeInterval(1)
            deviceInput = (id: "usb", name: "USB microphone")
            injectedDevice.routeChanged(); await injectedDevice.finishRouteRecovery()
            let oldSendCount = await sends.count
            try audioRequire(captures.count == 2 && oldSendCount == 0 && originalCapture.next().0 == nil,
                             "actual device drain must discard queued old-generation frames")
            originalCapture.append(try tone(format, start: 0, count: 2000))
            try audioRequire(originalCapture.next().0 == nil, "old tap must stay stopped after rebuild")
            injectedDevice.setMuted(true)
            testNow = testNow.addingTimeInterval(1)
            deviceInput = (id: "usb2", name: "USB microphone 2")
            injectedDevice.routeChanged(); await injectedDevice.finishRouteRecovery()
            captures.last!.append(try tone(format, start: 0, count: 2000))
            try audioRequire(captures.count == 3 && injectedDevice.isCapturing && captures.last!.next().0 == nil,
                             "actual rebuilt converter and drain preserve mute")
            injectedDevice.setMuted(false)
            var sentFrames = sends.frames.makeAsyncIterator()
            captures.last!.append(try tone(format, start: 2000, count: 1024))
            let delivered = await sentFrames.next()
            try audioRequire(delivered?.count == 640, "rebuilt device sends real converted frames after unmute")
            var changedName = ""
            injectedDevice.onInputChange = { changedName = $0 }
            testNow = testNow.addingTimeInterval(1)
            deviceInput = (id: "airpods", name: "AirPods")
            injectedDevice.routeChanged(); await injectedDevice.finishRouteRecovery()
            try audioRequire(changedName == "AirPods" && captures.count == 4 && injectedDevice.isCapturing,
                             "a paused route change auto-resumes on the new device without holding it")
            injectedDevice.routeChanged(); injectedDevice.stop(); await injectedDevice.finishRouteRecovery()
            try audioRequire(captures.count == 4 && !injectedDevice.isCapturing
                             && !injectedDevice.hasConfigurationObserver,
                             "stop releases capture and removes the configuration observer")
            print("PASS injected real device converter/drain: mute survives, queued/stale frames discarded, input consent rechecked")
            let gate = NativeAudioSendGate()
            var blockedCapture: NativeCaptureBuffer?
            let blockedDevice = NativeLiveAudioDevice(captureInput: format, defaultInput: { deviceInput })
            blockedDevice.onCapturePrepared = { blockedCapture = $0 }
            try await blockedDevice.start { try await gate.send($0) }
            let oldDrain = blockedDevice.captureDrain
            var enteredSend = gate.entered.makeAsyncIterator()
            blockedCapture?.append(try tone(format, start: 0, count: 1024))
            _ = await enteredSend.next()
            deviceInput = (id: "blocked", name: "Blocked microphone")
            blockedDevice.routeChanged(); await blockedDevice.finishRouteRecovery()
            await gate.fail(); await oldDrain?.value
            try audioRequire(blockedDevice.isCapturing, "stale send failure must not interrupt rebuilt capture")
            blockedDevice.stop()
            print("PASS stale in-flight send failure cannot interrupt replacement device")
            print("DURATION native-route-seams=\(Date().timeIntervalSince(routeTestStarted))s")
            let reference = try NativePCMConverter(input: format)
            var expected = try reference.append(tone(format, start: 0, count: 44100))
            expected.append(try reference.finish())
            let converter = try NativePCMConverter(input: format)
            var actual = Data(), offset = 0, index = 0
            let chunks = [127, 701, 11, 1024, 83]
            while offset < 44100 {
                let count = min(chunks[index % chunks.count], 44100 - offset)
                actual.append(try converter.append(tone(format, start: offset, count: count)))
                offset += count; index += 1
            }
            actual.append(try converter.finish())
            try audioRequire(converter.output.sampleRate == 16000 && converter.output.channelCount == 1 && converter.output.commonFormat == .pcmFormatInt16, "mono PCM16 16k output")
            try audioRequire(actual == expected, "streaming converter continuity against whole-input reference")
            var assembler = NativePCMFrameAssembler()
            let frames = assembler.append(actual)
            try audioRequire(!frames.isEmpty && frames.allSatisfy { $0.count == 640 }, "complete 640-byte frames")
            try audioRequire(frames.reduce(into: Data()) { $0.append($1) } == actual.prefix(frames.count * 640), "frame continuity")
            try audioRequire(assembler.discardPartial() == actual.count % 640, "final partial frame discarded, never padded")
            var partial = NativePCMFrameAssembler()
            _ = partial.append(Data(repeating: 7, count: 645))
            try audioRequire(partial.discardPartial() == 5, "discard rebases a consumed Data carry")
            try audioRequire(partial.append(Data(repeating: 9, count: 640)) == [Data(repeating: 9, count: 640)], "new frames exclude discarded carry")
            try audioRequire(partial.discardPartial() == 0 && partial.discardPartial() == 0, "empty consumed carry discard is idempotent")
            var ring = NativePCMFrameRing()
            for i in 0..<27 { ring.push(Data(repeating: UInt8(i), count: 640)) }
            try audioRequire(ring.drops == 2 && ring.pop()?.first == 2, "500 ms ring drops oldest only past 25 frames and counts")
            let capture = try NativeCaptureBuffer(converter: NativePCMConverter(input: format))
            try capture.append(tone(format, start: 0, count: 4410))
            try audioRequire(capture.next().0?.count == 640, "capture produces complete frames")
            capture.setMuted(true)
            try capture.append(tone(format, start: 4410, count: 4410))
            try audioRequire(capture.next().0 == nil, "mute discards queued frames and suppresses new frames")
            capture.setMuted(false)
            try capture.append(tone(format, start: 8820, count: 4410))
            try audioRequire(capture.next().0?.count == 640, "unmute resumes the same converter and capture buffer")
            capture.stop(); capture.stop()
            try capture.append(tone(format, start: 13230, count: 4410))
            try audioRequire(capture.next().0 == nil, "stopped capture produces no frames, including after hide's stop")
            guard let origin = URL(string: "http://127.0.0.1:1") else { throw LiveClientError.invalidIntent }
            for muted in [false, true] {
                var presentation: NativeLiveConversation.State = muted ? .muted : .listening
                presentation = NativeLiveConversation.continuityPresentation(.rebuilding, muted: muted)!
                try audioRequire(presentation == .rebuilding, "muted continuity enters rebuilding")
                presentation = NativeLiveConversation.continuityPresentation(.active, muted: muted)!
                try audioRequire(presentation == (muted ? .muted : .listening), "resumed presentation preserves mute")
            }
            try audioRequire(NativeLivePresentation.ended("resume_failed", limits: nil) == "Naya's connection could not be resumed. Start Live again.", "resume_failed exact typed sentence")
            let authority = DictationRefusalAuthority()
            let conversation = NativeLiveConversation(authority: (origin, { url, epoch in
                try authority.request(url, epoch)
            }), dictationIsCapturing: { true })
            conversation.offerPendingCall(NativePendingLiveJob(id: "job1", state: "completed", markdown: "Actual result"))
            try audioRequire(conversation.state == .idle && !conversation.device.hasEngine && !conversation.isCapturing,
                             "a quiet incoming call never starts audio or microphone capture")
            try audioRequire(authority.attempts == 0, "offering a call does not begin a Live session")
            conversation.start()
            try audioRequire(conversation.state == .failed && conversation.failure != nil, "active dictation visibly refuses Live Start")
            try audioRequire(!conversation.device.hasEngine && !conversation.isCapturing, "dictation refusal creates no engine or second capture")
            try audioRequire(authority.attempts == 0, "dictation refusal constructs no HTTP or socket request")
            print("PASS active dictation refuses Live Start with visible failure, no engine and zero authority/socket requests")
            let device = NativeLiveAudioDevice()
            try audioRequire(!device.hasEngine && !device.isCapturing, "construction does not create audio engine")
            device.stop(); device.stop()
            try audioRequire(!device.hasEngine, "teardown idempotent")
            try audioRequire(NativeLiveAudioDevice.shouldUseVoiceProcessing(
                outputIsBuiltInSpeakers: true, deviceBusy: false, voiceProcessingFailed: false),
                             "VPIO on built-in speakers when no device is busy")
            try audioRequire(!NativeLiveAudioDevice.shouldUseVoiceProcessing(
                outputIsBuiltInSpeakers: true, deviceBusy: true, voiceProcessingFailed: false),
                             "VPIO skipped while another app is running a device")
            try audioRequire(!NativeLiveAudioDevice.shouldUseVoiceProcessing(
                outputIsBuiltInSpeakers: false, deviceBusy: false, voiceProcessingFailed: false),
                             "VPIO skipped on a non-built-in output")
            try audioRequire(!NativeLiveAudioDevice.shouldUseVoiceProcessing(
                outputIsBuiltInSpeakers: true, deviceBusy: false, voiceProcessingFailed: true),
                             "VPIO never retried after one failure")
            try audioRequire(NativeLiveAudioDevice.vpioSkipReason(
                builtIn: true, deviceBusy: true, voiceProcessingFailed: false) == "device_busy",
                             "busy device logs audio_vpio_skipped reason=device_busy")
            print("PASS silent real AVAudioConverter irregular stereo tone, frame continuity, partial discard, ring overflow, lazy device")
            print("UNVERIFIED hardware: voice processing on both IO nodes and physical device loss; Start verifies both enabled flags")
        } catch { print("FAIL native audio: \(error)"); exit(1) }
    }
}
