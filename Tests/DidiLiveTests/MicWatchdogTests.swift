import AVFoundation
import Foundation
import DidiOwner

/// C-MICWATCH: a started engine whose tap never delivers a buffer recovers once without voice
/// processing or fails by name; a normal start with buffers is untouched. Every case uses the fake
/// engine seam (engineFactoryForTesting and startForTesting): no engine is started, no microphone
/// or speaker is opened, and the buffers are synthetic tones appended to the real capture buffer.
@MainActor
enum MicWatchdogTests {
    static func run() async throws {
        // (c) runs first: tearing down a voice-processing engine makes CoreAudio post a configuration
        // change to the next voice-processing engine a few hundred ms later, which the existing route
        // logic logs as audio_route_change_ignored. The restarts in (a) and (b) would leak that line
        // into the happy-path journal; the line is not the watchdog's.
        try await checkNormalStartIsUnchanged()
        print("PASS (c) a normal start with buffers fires no watchdog and keeps voice processing on")
        try await checkStallRestartsWithoutVoiceProcessing()
        print("PASS (a) a start with no buffer fires the watchdog once, restarts without voice processing, and a buffer then goes live")
        try await checkStallTwiceFailsByName()
        print("PASS (b) no buffer in either mode ends the start with a named failure, no third start")
        try await checkConfigurationChangeDuringStartIsObserved()
        print("PASS (d) a configuration change posted during engine start is observed and handled")
        try checkConverterFollowsBufferFormat()
        print("PASS a buffer whose format differs from the prepared format rebuilds the converter from the buffer")
        try await checkStallFailureNeverAutoRestarts()
        print("PASS MW-R1 a dead-input failure shows failed with no automatic restart; any other capture failure still restarts once")
    }

    /// Short enough to keep the suite fast, long enough that a buffer appended right after start
    /// always lands inside it.
    private static let window: Duration = .milliseconds(150)

    private static func format() throws -> AVAudioFormat {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2,
                                         interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        return format
    }

    private static func owner() -> AudioOwner {
        AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mic-watchdog-\(UUID().uuidString)"))
    }

    private static func tone(_ format: AVAudioFormat, count: Int = 2048) throws -> AVAudioPCMBuffer {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channels = buffer.floatChannelData else { throw NativeLiveAudioError.allocationFailed }
        buffer.frameLength = AVAudioFrameCount(count)
        for channel in 0..<Int(format.channelCount) {
            for i in 0..<count { channels[channel][i] = Float(sin(Double(i) * 2 * .pi * 440 / format.sampleRate) * 0.25) }
        }
        return buffer
    }

    private static func waitUntil(_ what: String, seconds: Double = 3,
                                  _ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !(await condition()) {
            try audioRequire(ContinuousClock.now < deadline, "timed out waiting: \(what)")
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    private final class Counter {
        var starts = 0
        var captures: [NativeCaptureBuffer] = []
        var interruptions: [Error?] = []
    }

    private actor Sends {
        private(set) var count = 0
        func send(_ frame: Data) { count += 1 }
    }

    /// A device on built-in speakers with no other app holding the microphone, so the first start
    /// takes voice processing, exactly as the silent calls did.
    private static func makeDevice(_ journal: NativeAudioJournal, owner: AudioOwner, counter: Counter,
                                   window: Duration?) throws -> NativeLiveAudioDevice {
        let format = try format()
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                           owner: owner, journal: journal, deviceState: { _ in false },
                                           isBuiltInOutput: { true })
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in counter.starts += 1 }
        device.onCapturePrepared = { counter.captures.append($0) }
        device.onInterruption = { counter.interruptions.append($0) }
        device.firstBufferWindowForTesting = window
        return device
    }

    private static func stalled(_ journal: NativeAudioJournal) -> [NativeAudioEvent] {
        journal.events.filter { $0.name == "audio_input_stalled" }
    }

    /// (a) The engine starts but the tap never delivers. The watchdog fires once, logs metadata only,
    /// restarts without voice processing, and a buffer on the replacement capture makes the call live.
    private static func checkStallRestartsWithoutVoiceProcessing() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        let owner = owner()
        let counter = Counter()
        let device = try makeDevice(journal, owner: owner, counter: counter, window: window)
        let sends = Sends()
        try await device.start { await sends.send($0) }
        try audioRequire(device.isVoiceProcessingEnabledForTesting && counter.starts == 1,
                         "control: the first start takes voice processing")
        try await waitUntil("the watchdog restarts the engine") { counter.starts == 2 }
        guard let replacement = counter.captures.last, counter.captures.count == 2 else {
            throw NativeLiveAudioError.captureNotConfigured
        }
        replacement.append(try tone(format))
        try await waitUntil("the replacement capture sends frames") { await sends.count > 0 }
        // A further window passes with buffers flowing: the watchdog stays quiet.
        try await Task.sleep(for: window * 3)
        let stalls = stalled(journal)
        try audioRequire(stalls.count == 1, "the watchdog fires exactly once, got \(stalls.count)")
        let fields = stalls[0].fields
        try audioRequire(fields["voiceProcessing"] == "true" && fields["inputChannels"] == "2"
                            && fields["sampleRate"] == "44100"
                            && fields["action"] == "restart_without_voice_processing",
                         "the stall line carries the mode, the format and the action, got \(fields)")
        try audioRequire(Int(fields["waitedMs"] ?? "").map { $0 >= 150 } == true,
                         "the stall line says how long it waited, got \(fields["waitedMs"] ?? "-")")
        try audioRequire(Set(fields.keys) == ["voiceProcessing", "inputChannels", "sampleRate", "waitedMs", "action"],
                         "metadata only: no other field rides on the stall line, got \(fields.keys.sorted())")
        let started = journal.events.filter { $0.name == "audio_started" }.map { $0.fields["voiceProcessing"] ?? "-" }
        try audioRequire(started == ["true", "false"], "the restart is logged live with voiceProcessing false, got \(started)")
        try audioRequire(!device.isVoiceProcessingEnabledForTesting && counter.starts == 2,
                         "the replacement engine runs without voice processing, started once more")
        try audioRequire(counter.interruptions.isEmpty && device.isCapturing && device.hasEngine && owner.isOwned,
                         "the recovered call is live: capturing, holding the engine and the audio owner")
        device.stop()
        try audioRequire(!owner.isOwned, "stop releases the recovered engine")
    }

    /// (b) No buffer with or without voice processing: the start ends with a named failure the
    /// conversation already handles, the session is marked failed and no third engine starts.
    private static func checkStallTwiceFailsByName() async throws {
        let journal = NativeAudioJournal(fileURL: nil)
        let owner = owner()
        let counter = Counter()
        let device = try makeDevice(journal, owner: owner, counter: counter, window: window)
        try await device.start { _ in }
        try await waitUntil("the second stall ends the start") { counter.interruptions.count == 1 }
        try await Task.sleep(for: window * 3)
        try audioRequire(counter.starts == 2, "one start with and one without voice processing, never a third, got \(counter.starts)")
        let stalls = stalled(journal)
        try audioRequire(stalls.map { $0.fields["voiceProcessing"] ?? "-" } == ["true", "false"]
                            && stalls.map { $0.fields["action"] ?? "-" } == ["restart_without_voice_processing", "failed"],
                         "two stall lines, the second one says failed, got \(stalls.map(\.fields))")
        try audioRequire(counter.interruptions.count == 1, "exactly one interruption reaches the conversation")
        let failure = counter.interruptions[0] as? NativeLiveAudioError
        try audioRequire(failure?.rawValue == "engine_failed",
                         "the failure is the named engine_failed the conversation presents, got \(String(describing: counter.interruptions[0]))")
        try audioRequire(device.sessionFailedForTesting && !device.hasEngine && !device.isCapturing && !owner.isOwned,
                         "the failed start releases the engine, the capture and the audio owner")
        var refused = false
        do { try device.rebuildForTesting() } catch { refused = true }
        try audioRequire(refused && counter.starts == 2, "the circuit breaker refuses any further start in the session")
    }

    /// (c) The paired valid case: buffers flow from the first moment. No watchdog line, no restart,
    /// voice processing stays on and the start writes exactly what a start always wrote.
    private static func checkNormalStartIsUnchanged() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        let owner = owner()
        let counter = Counter()
        let device = try makeDevice(journal, owner: owner, counter: counter, window: window)
        let buffer = try tone(format)
        device.onCapturePrepared = { capture in counter.captures.append(capture); capture.append(buffer) }
        let sends = Sends()
        try await device.start { await sends.send($0) }
        let atStart = journal.events.map(\.name)
        try await waitUntil("frames flow") { await sends.count > 0 }
        try await Task.sleep(for: window * 3)
        try audioRequire(stalled(journal).isEmpty, "a start with buffers never logs audio_input_stalled")
        // The fake engine is a real voice-processing AVAudioEngine, and after earlier engines in this
        // process were torn down CoreAudio posts it configuration changes, off the main thread and a
        // few hundred ms after start (later than the old post-start observer too). A loaded host posts
        // more than one, so their count is not asserted; the route logic must ignore every one as
        // unchanged, never rebuild or stall.
        let after = journal.events.dropFirst(atStart.count)
        try audioRequire(after.allSatisfy {
                             $0.name == "audio_route_change_ignored" && $0.fields == ["reason": "unchanged"] },
                         "after start only ignored unchanged route changes may appear, got \(journal.events.map(\.name))")
        // #1101 adds one receipt between the start and the rate: the graph the start built.
        try audioRequire(atStart == ["audio_input_policy", "audio_owned", "audio_started", "audio_graph_built",
                                     "playback_rate"]
                            || atStart == ["audio_input_policy", "audio_started", "audio_graph_built", "playback_rate"],
                         "the start writes the same lines it always wrote, got \(atStart)")
        try audioRequire(counter.starts == 1 && counter.captures.count == 1 && device.isVoiceProcessingEnabledForTesting
                            && counter.interruptions.isEmpty,
                         "one start, one capture, voice processing on, no interruption")
        device.stop()
    }

    /// (d) A configuration change posted while the engine is starting (here: the output moved to a
    /// USB device) reaches the existing route logic, which rebuilds once on the new output.
    private static func checkConfigurationChangeDuringStartIsObserved() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        var output = (id: "builtin-out", name: "MacBook Speakers")
        var starts = 0
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                           owner: owner(), journal: journal, deviceState: { _ in false },
                                           isBuiltInOutput: { false },
                                           builtInInput: { (id: "synthetic-1", name: "Synthetic") },
                                           defaultOutput: { output },
                                           transport: { $0 == "usb-out" ? "USB" : "built-in" })
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { engine in
            starts += 1
            guard starts == 1 else { return }
            output = (id: "usb-out", name: "USB Speakers")
            NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
        }
        try await device.start { _ in }
        try await waitUntil("the change posted during start is handled") { starts == 2 }
        await device.finishRouteRecovery()
        let switched = journal.events.filter { $0.name == "audio_output_switched" }
        try audioRequire(switched.count == 1 && switched[0].fields["to"] == "USB",
                         "the existing route logic rebuilt onto the new output, got \(switched.map(\.fields))")
        try audioRequire(device.isCapturing && device.hasEngine, "the call keeps capturing after the rebuild")
        device.stop()
    }

    /// Item 3: the format read before start said three channels, the first buffer carries seven
    /// (the voice-processing format). The converter rebuilds from the buffer, so audio still flows.
    private static func checkConverterFollowsBufferFormat() throws {
        guard let three = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 3),
              let seven = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 7) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        let prepared = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, interleaved: false, channelLayout: three)
        let delivered = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, interleaved: false, channelLayout: seven)
        let capture = NativeCaptureBuffer(converter: try NativePCMConverter(input: prepared))
        for _ in 0..<4 { capture.append(try tone(delivered, count: 1024)) }
        let (frame, _, _, failed) = capture.next()
        let statistics = capture.stop()
        try audioRequire(!failed && statistics.convertFailures == 0,
                         "a seven-channel buffer on a three-channel converter never fails, got \(statistics.convertFailures) failures")
        try audioRequire(frame?.count == 640 && statistics.convertedBytes > 0, "the rebuilt converter produces frames")
        try audioRequire(statistics.inputChannels == 7 && statistics.inputSampleRate == 48000,
                         "the capture summary reports the format the buffers carried, got \(statistics.inputChannels)")
        // Paired control: a buffer in the prepared format keeps the converter it was built with.
        let control = NativeCaptureBuffer(converter: try NativePCMConverter(input: prepared))
        for _ in 0..<4 { control.append(try tone(prepared, count: 1024)) }
        let controlStatistics = control.stop()
        try audioRequire(controlStatistics.inputChannels == 3 && controlStatistics.convertFailures == 0,
                         "a matching buffer keeps the prepared format")
    }

    /// MW-R1: the watchdog's second stall ends the call failed, with no automatic restart and so no
    /// second connecting ring. The paired case: the same error value from any other capture failure
    /// keeps today's one automatic restart per 60 s.
    private static func checkStallFailureNeverAutoRestarts() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("didi-mic-watchdog-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let authority: (origin: URL, request: NativeLiveRequestBuilder) =
            (URL(string: "http://127.0.0.1:1")!, { _, _ in throw LiveClientError.unavailable })
        func events(_ name: String, in directory: URL) -> [[String: Any]] {
            guard let text = try? String(contentsOf: directory.appendingPathComponent("native-live.log"), encoding: .utf8) else { return [] }
            return text.split(separator: "\n").compactMap {
                try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
            }.filter { $0["event"] as? String == name }
        }
        func settled(_ conversation: NativeLiveConversation, _ what: String) async throws {
            try await waitUntil(what) { conversation.state == NativeLiveConversation.State.failed }
            try await Task.sleep(for: .milliseconds(50))
        }

        // The dead input: the conversation owns the device, the engine starts and never delivers.
        let deadDirectory = root.appendingPathComponent("dead")
        let counter = Counter()
        let dead = try makeDevice(NativeAudioJournal(fileURL: nil), owner: owner(), counter: counter, window: window)
        let deadConversation = NativeLiveConversation(authority: authority, dictationIsCapturing: { false },
                                                      logsDirectory: deadDirectory, audioDevice: dead)
        try await dead.start { _ in }
        try await settled(deadConversation, "the second stall fails the call")
        let interruptions = events("capture_interruption", in: deadDirectory)
        try audioRequire(interruptions.count == 1 && interruptions[0]["code"] as? String == "engine_failed",
                         "the dead input reaches the conversation once as engine_failed, got \(interruptions)")
        try audioRequire(events("live_restart", in: deadDirectory).isEmpty,
                         "a dead input never restarts the call, so no second connecting ring")
        try audioRequire(deadConversation.state == .failed && deadConversation.failure != nil && counter.starts == 2,
                         "the call shows failed after one start with and one without voice processing")

        // Paired case: the same named error from another capture failure still restarts once.
        let otherDirectory = root.appendingPathComponent("other")
        let other = try makeDevice(NativeAudioJournal(fileURL: nil), owner: owner(), counter: Counter(), window: nil)
        let otherConversation = NativeLiveConversation(authority: authority, dictationIsCapturing: { false },
                                                       logsDirectory: otherDirectory, audioDevice: other)
        await other.interruptForTesting(NativeLiveAudioError.engineFailed(code: 0))
        try await settled(otherConversation, "the other capture failure settles")
        try audioRequire(events("live_restart", in: otherDirectory).count == 1,
                         "any other capture failure keeps its one automatic restart")
    }
}
