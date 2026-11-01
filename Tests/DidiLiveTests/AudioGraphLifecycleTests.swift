import AVFoundation
import Foundation
import DidiOwner

/// #1101: the voice-processing graph is built once per start, and every release settles before the
/// next build. Every case uses the fake engine seams (engineFactoryForTesting, startForTesting,
/// prepareForTesting, firstBufferWindowForTesting, settleWaitForTesting): no engine is started, no
/// microphone or speaker is opened, and no case waits on a real interval.
@MainActor
enum AudioGraphLifecycleTests {
    static func run() async throws {
        try await checkStartBuildsTheGraphOnce()
        try await checkUnmuteWaitsForTheSettle()
        try await checkWatchdogRestartWaitsForTheSettle()
        try await checkReleaseWaitsForAPendingConfigurationChange()
        print("PASS audio lifecycle: one graph build per start, unmute and the mic watchdog wait the release settle, "
              + "a pending configuration change is waited for and bounded")
    }

    private final class Trace {
        var order: [String] = []
        var waits: [Int] = []
        var waited = 0
    }

    private static func milliseconds(_ duration: Duration) -> Int {
        Int(duration.components.seconds) * 1000 + Int(duration.components.attoseconds / 1_000_000_000_000_000)
    }

    private static func format() throws -> AVAudioFormat {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2,
                                         interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        return format
    }

    /// A device on built-in speakers with no other app holding the microphone, so the start takes
    /// voice processing, exactly as a silent call does. Every settle wait is recorded, never slept.
    private static func makeDevice(_ journal: NativeAudioJournal, _ trace: Trace) throws -> NativeLiveAudioDevice {
        let format = try format()
        let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("audio-graph-\(UUID().uuidString)"), journal: journal)
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                           owner: owner, journal: journal, deviceState: { _ in false },
                                           isBuiltInOutput: { true },
                                           defaultOutput: { (id: "synthetic-out", name: "Synthetic output") },
                                           transport: { _ in "BuiltIn" })
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.settleWaitForTesting = { duration in
            let ms = milliseconds(duration)
            trace.waits.append(ms)
            trace.waited += ms
            trace.order.append("settle")
        }
        return device
    }

    private static func waitUntil(_ what: String, seconds: Double = 2, _ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition() {
            try audioRequire(ContinuousClock.now < deadline, "timed out waiting: \(what)")
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    /// (#1101 a) The voice-processing graph is built once per start: ducking, then the one enable, then
    /// the player attach and connect, then one prepare, then start.
    private static func checkStartBuildsTheGraphOnce() async throws {
        let journal = NativeAudioJournal(fileURL: nil)
        let trace = Trace()
        let device = try makeDevice(journal, trace)
        device.prepareForTesting = { _ in trace.order.append("prepare") }
        device.startForTesting = { _ in trace.order.append("start") }
        try await device.start { _ in }

        let steps = device.graphBuildSteps
        try audioRequire(steps == ["ducking", "voice_processing", "player_attached", "prepare", "start"],
                         "the graph is built once, in one order: ducking, enable, attach and connect, prepare, start, got \(steps)")
        try audioRequire(device.engineStartCount == 1, "one engine start for the call, got \(device.engineStartCount)")
        try audioRequire(device.isVoiceProcessingEnabledForTesting, "voice processing is still on for the start")
        let built = journal.events.filter { $0.name == "audio_graph_built" }
        try audioRequire(built.count == 1, "one audio_graph_built per start, got \(built.count)")
        try audioRequire(built.first?.fields["steps"] == "ducking,voice_processing,player_attached,prepare,start",
                         "audio_graph_built carries the steps, got \(built.first?.fields["steps"] ?? "none")")
        try audioRequire(built.first?.fields["starts"] == "1" && built.first?.fields["voiceProcessing"] == "true",
                         "and the call's engine start count and voice-processing state")
        try audioRequire(built.first?.fields["configChanges"] != nil,
                         "and the configuration changes the start saw")

        device.releaseForTesting()
        await device.settleForTesting()
    }

    /// (#1101 b) An unmute is a release-then-build path: it waits the release settle out, then builds
    /// once, never in the same turn as the mute's release.
    private static func checkUnmuteWaitsForTheSettle() async throws {
        let journal = NativeAudioJournal(fileURL: nil)
        let trace = Trace()
        let device = try makeDevice(journal, trace)
        device.startForTesting = { _ in trace.order.append("build") }
        try await device.start { _ in }
        trace.order = []; trace.waits = []; trace.waited = 0

        device.setMuted(true)
        device.setMuted(false)
        try audioRequire(trace.order.isEmpty,
                         "the unmute rebuild does not run in the same turn as the mute release, got \(trace.order)")
        await device.finishMuteResumeForTesting()
        try audioRequire(trace.order == ["settle", "build"],
                         "the unmute waited the release settle, then built once, got \(trace.order)")
        try audioRequire(trace.waits == [NativeLiveAudioDevice.releaseSettleMs],
                         "and it waited exactly the named settle interval, got \(trace.waits)")
        try audioRequire(device.hasEngine && device.isCapturing, "the microphone is back after the settle")

        device.stop()
        await device.settleForTesting()
    }

    /// (#1101 c) A mic-watchdog restart is a release-then-build path too: it waits the settle of the
    /// engine it just stopped before it builds the next one.
    private static func checkWatchdogRestartWaitsForTheSettle() async throws {
        let journal = NativeAudioJournal(fileURL: nil)
        let trace = Trace()
        let device = try makeDevice(journal, trace)
        device.startForTesting = { _ in trace.order.append("build") }
        // No tap buffer ever arrives, so the first-buffer watchdog restarts the engine once.
        device.firstBufferWindowForTesting = .milliseconds(5)
        try await device.start { _ in }

        try await waitUntil("the watchdog restart builds again") {
            trace.order.filter { $0 == "build" }.count >= 2
        }
        try audioRequire(Array(trace.order.prefix(3)) == ["build", "settle", "build"],
                         "the restart waited the release settle before it built again, got \(trace.order)")
        try audioRequire(trace.waits.first == NativeLiveAudioDevice.releaseSettleMs,
                         "and the wait was the named settle interval, got \(trace.waits)")

        device.stop()
        await device.settleForTesting()
    }

    /// (#1101 d) A release with a configuration change in flight waits for it and stops at the bound:
    /// the reset, the dropped handles and the settled record all come after the wait.
    private static func checkReleaseWaitsForAPendingConfigurationChange() async throws {
        let journal = NativeAudioJournal(fileURL: nil)
        let trace = Trace()
        let device = try makeDevice(journal, trace)
        device.startForTesting = { _ in }
        try await device.start { _ in }

        // A configuration change lands inside every wait and the device never settles, so the wait
        // runs to its bound and no further. No real interval passes: this seam returns at once.
        device.settleWaitForTesting = { duration in
            trace.waits.append(milliseconds(duration))
            trace.waited += milliseconds(duration)
            device.configurationChangeForTesting()
        }
        device.releaseForTesting()
        await device.settleForTesting()

        let bound = NativeLiveAudioDevice.releaseSettleMs + NativeLiveAudioDevice.settleConfigWaitLimitMs
        try audioRequire(trace.waits.first == NativeLiveAudioDevice.releaseSettleMs,
                         "the settle starts at the named interval, got \(trace.waits.first ?? 0) ms")
        try audioRequire(trace.waited >= NativeLiveAudioDevice.settleConfigWaitLimitMs,
                         "the pending change is waited for, got \(trace.waited) ms")
        try audioRequire(trace.waited <= bound, "and never past the bound of \(bound) ms, got \(trace.waited) ms")
        let settled = journal.events.filter { $0.name == "audio_release_settled" }
        try audioRequire(settled.count == 1, "one audio_release_settled, got \(settled.count)")
        try audioRequire(settled[0].fields["settleMs"] == String(trace.waited)
                         && settled[0].fields["configChangePending"] == "true",
                         "audio_release_settled reports the settle it waited and that a change was pending")
        try audioRequire(device.settledReleaseCount == 1 && device.engineResetCount == 1,
                         "the handles are reset and dropped once, after the wait")
        try audioRequire(!device.hasConfigurationObserver, "and the configuration observer goes with them")
    }
}
