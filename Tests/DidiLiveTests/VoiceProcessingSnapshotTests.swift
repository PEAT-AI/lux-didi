import AVFoundation
import Foundation
import DidiOwner

/// #1022: the device-busy reading is taken once, in the synchronous prefix of
/// `NativeLiveConversation.start`, before the connecting ring or the live engine can start, because
/// `kAudioDevicePropertyDeviceIsRunningSomewhere` counts Didi itself. No engine and no device: every
/// device-state read is a fake.
enum VoiceProcessingSnapshotTests {
    @MainActor static func run() async throws {
        try await checkSnapshotBeforeEngineStart()
        try await checkBusyAtCallStartStillFallsBack()
        print("PASS voice processing: busy snapshot taken at call start, external holder still falls back, teardown clears it")
    }

    /// Acceptance 1: the device is idle at call start and busy by the time the live engine starts
    /// (the ring is running). The snapshot decides, so voice processing stays on.
    @MainActor private static func checkSnapshotBeforeEngineStart() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("didi-vpio-snapshot-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = NativeAudioJournal(fileURL: nil)
        var deviceBusy = false
        let device = makeDevice(journal: journal, deviceState: { _ in deviceBusy })
        let conversation = makeConversation(directory: directory, device: device)

        conversation.start()
        try audioRequire(device.outsideBusyAtCallStart == false,
                         "start takes the busy reading in its synchronous prefix")
        deviceBusy = true  // the connecting ring's own engine starts one main-actor hop later

        try await fail(conversation)
        let started = journal.events.filter { $0.name == "audio_started" }
        let skips = journal.events.filter { $0.name == "audio_vpio_skipped" }
        try audioRequire(started.count == 1, "one audio_started record, got \(started.count)")
        try audioRequire(skips.isEmpty, "no voice-processing skip while only Didi holds the device")
        try audioRequire(device.isVoiceProcessingEnabledForTesting,
                         "voice processing stays on although the device is busy at engine start")
        let record = started[0].fields
        try audioRequire(record["voiceProcessing"] == "true", "the record says voice processing was on")
        try audioRequire(record["busyAtCallStart"] == "false",
                         "the record carries the call-start reading, got \(String(describing: record["busyAtCallStart"]))")
        try audioRequire(record["outputTransport"] != nil && record["outputTransport"] != "",
                         "the record names the output transport")
        try audioRequire(record["outputUID"] != nil && record["outputUID"] != "",
                         "the record carries the output device id")
        try audioRequire(device.outsideBusyAtCallStart == nil, "teardown clears the snapshot")
        await conversation.stop()
        print("PASS voice processing: an idle device at call start keeps voice processing on")
    }

    /// Acceptance 2: another app already held the device at call start, so the existing non-VPIO
    /// fallback runs and names its reason.
    @MainActor private static func checkBusyAtCallStartStillFallsBack() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("didi-vpio-busy-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = NativeAudioJournal(fileURL: nil)
        let device = makeDevice(journal: journal, deviceState: { _ in true })
        let conversation = makeConversation(directory: directory, device: device)

        conversation.start()
        try audioRequire(device.outsideBusyAtCallStart == true, "call start records the busy device")
        try await fail(conversation)
        let skips = journal.events.filter { $0.name == "audio_vpio_skipped" && $0.fields["reason"] == "device_busy" }
        let started = journal.events.filter { $0.name == "audio_started" }
        try audioRequire(skips.count == 1, "exactly one device_busy skip, got \(skips.count)")
        try audioRequire(!device.isVoiceProcessingEnabledForTesting,
                         "a device busy at call start still takes the non-VPIO fallback")
        try audioRequire(started.count == 1 && started[0].fields["busyAtCallStart"] == "true",
                         "the record carries the busy call-start reading")
        await conversation.stop()
        print("PASS voice processing: a device busy at call start still falls back to device_busy")
    }

    @MainActor private static func makeDevice(journal: NativeAudioJournal,
                                              deviceState: @escaping (Bool) -> Bool) -> NativeLiveAudioDevice {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100,
                                         channels: 2, interleaved: false) else {
            fatalError("the synthetic capture format is unavailable")
        }
        let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vpio-snapshot-" + UUID().uuidString))
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                           owner: owner, journal: journal, deviceState: deviceState,
                                           isBuiltInOutput: { true })
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in }
        return device
    }

    @MainActor private static func makeConversation(directory: URL,
                                                    device: NativeLiveAudioDevice) -> NativeLiveConversation {
        let authority: (origin: URL, request: NativeLiveRequestBuilder) =
            (URL(string: "http://127.0.0.1:1")!, { _, _ in throw LiveClientError.unavailable })
        return NativeLiveConversation(authority: authority, dictationIsCapturing: { false },
                                      logsDirectory: directory, audioDevice: device)
    }

    /// The refused HTTP authority ends the call, which is where the device teardown runs.
    @MainActor private static func fail(_ conversation: NativeLiveConversation) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while conversation.state != .failed {
            try audioRequire(ContinuousClock.now < deadline, "the refused authority ends the call")
            await Task.yield()
        }
    }
}
