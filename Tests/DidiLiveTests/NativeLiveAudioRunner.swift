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
        (URLError(.cannotConnectToHost), "service", "service_unreachable", nil),
        (LiveClientError.http(status: 503, code: "private description"), "service", "http", 503),
        (LiveClientError.socketClosed(code: 1006, reason: "private path"), "service", "socketClosed", 1006),
    ]
    for (index, status) in ([204, 429, nil] as [Int?]).enumerated() {
        for (error, failureClass, code, detail) in cases {
            let directory = root.appendingPathComponent("\(index)-\(code)")
            let conversation = NativeLiveConversation(authority: authority, dictationIsCapturing: { false }, logsDirectory: directory)
            DiagnosticLogHTTPFixture.reset(status: status)
            let presented = conversation.failure
            let task = conversation.logFailure(error, beforeCreate: true, diagnosticSession: session)
            var nativeLine = try JSONSerialization.data(withJSONObject: ["event": "live_precreate_failed", "failureClass": failureClass, "code": code], options: [.sortedKeys])
            nativeLine.append(10)
            let file = directory.appendingPathComponent("native-live.log")
            try audioRequire(try Data(contentsOf: file) == nativeLine, "native line exists immediately and retains exact JSONL format")
            await task?.value
            try audioRequire(try Data(contentsOf: file) == nativeLine, "429/transport does not alter or duplicate native log")
            try audioRequire(conversation.failure == presented, "diagnostic cannot change the owner's presentation")
            let requests = DiagnosticLogHTTPFixture.captured()
            try audioRequire(requests.count == 1, "one diagnostic from actual logFailure, no retry")
            var expected: [String: Any] = ["event": "live_precreate_failed", "failureClass": failureClass, "code": code]
            if let detail { expected["detail"] = detail }
            try audioRequire(requests[0].httpBody == JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys]), "native log boundary posts only the server vocabulary")
            DiagnosticLogHTTPFixture.reset(status: status)
            let suppressed = conversation.logFailure(error, beforeCreate: false, diagnosticSession: session)
            await suppressed?.value
            try audioRequire(DiagnosticLogHTTPFixture.captured().isEmpty, "post-CREATE failure posts nothing")
            try audioRequire(try Data(contentsOf: file) == nativeLine, "post-CREATE failure appends nothing")
            let fresh = root.appendingPathComponent("after-\(index)-\(code)")
            let postCreate = NativeLiveConversation(authority: authority, dictationIsCapturing: { false }, logsDirectory: fresh)
            await postCreate.logFailure(error, beforeCreate: false, diagnosticSession: session)?.value
            try audioRequire(!FileManager.default.fileExists(atPath: fresh.path), "post-CREATE failure creates no native log directory")
        }
    }
    print("PASS conversation pre-CREATE native JSONL and diagnostic HTTP, 429/transport unchanged, post-CREATE both suppressed")
    print("DURATION \(started.duration(to: .now)) conversation-diagnostics")
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
        do {
            for state in NativeLiveConversation.State.allCases {
                let presentation = state.presentation
                try expect(!presentation.text.isEmpty && !presentation.symbol.isEmpty, "every Live case has a sentence and icon")
                try expect(presentation.text != state.rawValue, "raw case never reaches Live presentation")
            }
        } catch { fatalError("Live presentation: \(error)") }
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
                rebuild: { throw NativeLiveAudioError.deviceUnavailable }, paused: { _ in }, failed: { failures += 1 })
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
            for i in 0..<10 { ring.push(Data(repeating: UInt8(i), count: 640)) }
            try audioRequire(ring.drops == 2 && ring.pop()?.first == 2, "eight-frame ring drops oldest and counts")
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
