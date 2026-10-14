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
            let expectedKeys: Set<String> = error is NativeLiveAudioError && detail != nil
                ? ["event", "failureClass", "code", "detail", "ts", "mono", "level", "process", "launchId"]
                : ["event", "failureClass", "code", "ts", "mono", "level", "process", "launchId"]
            try audioRequire(Set(nativeRecord.keys) == expectedKeys && nativeRecord["event"] as? String == "live_precreate_failed"
                && nativeRecord["failureClass"] as? String == failureClass && nativeRecord["code"] as? String == code,
                "native line has the exact typed JSONL schema plus timestamp")
            if error is NativeLiveAudioError, let detail {
                try audioRequire(nativeRecord["detail"] as? Int == detail, "native audio detail remains exact")
            }
            let tsFormatter = ISO8601DateFormatter()
            tsFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let timestamp = nativeRecord["ts"] as? String
            try audioRequire(timestamp != nil && timestamp!.contains(".") && tsFormatter.date(from: timestamp!) != nil,
                "native line ts is ISO 8601 with milliseconds")
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
    let configs = records.filter { $0["event"] as? String == "audio.config" }
    try audioRequire(!configs.isEmpty, "capture start writes an audio.config record")
    let flows = records.filter { $0["event"] as? String == "audio.flow" }
    try audioRequire(flows.contains { $0["final"] as? Bool == true }, "stop writes a FINAL audio.flow record")
    try audioRequire(summary["tapBuffers"] as? Int == 1 && (summary["convertedBytes"] as? Int ?? 0) > 0
        && summary["convertFailures"] as? Int == 0 && (summary["maxRMS"] as? Double ?? 0) > 0,
        "summary preserves locked capture counts before teardown")
    try audioRequire(summary["inputSampleRate"] as? Int == 48000 && summary["inputChannels"] as? Int == 1
        && summary["localSocketSendCompleted"] as? Int == 0 && summary["sendErrors"] as? Int == 0,
        "numeric format and zero local sends after refused authority")
    try audioRequire(summary["ledgerBalanced"] as? Bool == true && (summary["playbackUnderruns"] as? Int) == 0
        && (summary["lateAfterFlushChunks"] as? Int) == 0,
        "byte ledger balances at call end with no playback underruns")
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
    @MainActor static func main() async {
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
            guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else {
                throw NativeLiveAudioError.unsupportedFormat
            }
            var deviceInput = (id: "builtin", name: "Built-in microphone")
            var captures: [NativeCaptureBuffer] = []
            let injectedDevice = NativeLiveAudioDevice(captureInput: format, defaultInput: { deviceInput })
            injectedDevice.onCapturePrepared = { captures.append($0) }
            let sends = NativeAudioSendProbe()
            try await injectedDevice.start { await sends.send($0) }
            let originalCapture = captures[0]
            originalCapture.append(try tone(format, start: 0, count: 2000))
            injectedDevice.routeChanged(); injectedDevice.routeChanged(); injectedDevice.routeChanged()
            await injectedDevice.finishRouteRecovery()
            let oldSendCount = await sends.count
            try audioRequire(captures.count == 2 && oldSendCount == 0 && originalCapture.next().0 == nil,
                             "actual device drain must discard queued old-generation frames")
            originalCapture.append(try tone(format, start: 0, count: 2000))
            try audioRequire(originalCapture.next().0 == nil, "old tap must stay stopped after rebuild")
            injectedDevice.setMuted(true)
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
            deviceInput = (id: "usb", name: "USB microphone")
            injectedDevice.routeChanged(); await injectedDevice.finishRouteRecovery()
            try audioRequire(!injectedDevice.isCapturing && changedName == "USB microphone" && captures.count == 3,
                             "input change releases real capture until Resume")
            deviceInput = (id: "airpods", name: "AirPods")
            injectedDevice.resumeInput()
            try audioRequire(changedName == "AirPods" && captures.count == 3, "Resume rechecks device consent identity")
            injectedDevice.resumeInput()
            try audioRequire(captures.count == 4 && injectedDevice.isCapturing, "explicit Resume rebuilds device")
            injectedDevice.routeChanged(); injectedDevice.stop(); await injectedDevice.finishRouteRecovery()
            try audioRequire(captures.count == 4 && !injectedDevice.isCapturing, "Stop wins against device recovery")
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
            print("PASS silent real AVAudioConverter irregular stereo tone, frame continuity, partial discard, ring overflow, lazy device")
            print("UNVERIFIED hardware: voice processing on both IO nodes and physical device loss; Start verifies both enabled flags")
        } catch { print("FAIL native audio: \(error)"); exit(1) }
    }
}
