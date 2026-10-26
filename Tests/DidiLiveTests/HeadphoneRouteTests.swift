import AVFoundation
import Foundation

/// C-HEADPHONES: a call survives headphones. Capture is chosen by device id (the built-in
/// microphone whenever one exists), so the system default input moving to a headset never pauses
/// or ends a call; playback follows the default output through the existing route-change rebuild.
/// Every case here uses the injected-capture path: no engine, no tap, no permission request.
@MainActor
enum HeadphoneRouteTests {
    static func run() async throws {
        try await checkDefaultInputChangeDoesNotPause()
        print("PASS a default input change to a headset never pauses or reopens capture")
        try await checkOutputChangeRebuildsPlayback()
        print("PASS an output change rebuilds playback in the same call and journals the switch")
        try await checkNoBuiltInMicFallsBackWithNotice()
        print("PASS no built-in microphone is an announced fallback, never a silent one")
        try await checkCaptureLossStillPauses()
        print("PASS a lost capture device still pauses the call and names the new microphone")
    }

    private static func format() throws -> AVAudioFormat {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2,
                                         interleaved: false) else {
            throw NativeLiveAudioError.unsupportedFormat
        }
        return format
    }

    private static func owner() -> AudioOwner {
        AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("headphone-route-\(UUID().uuidString)"))
    }

    /// Rule 1 and 2: the default input becomes a Bluetooth headset mid-call. The built-in
    /// microphone still carries the call, nothing pauses, nothing ends, no capture is rebuilt.
    private static func checkDefaultInputChangeDoesNotPause() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        var defaultInput = (id: "built-in", name: "Built-in Microphone")
        var captures: [NativeCaptureBuffer] = []
        var paused: [String] = []
        let device = NativeLiveAudioDevice(captureInput: format, defaultInput: { defaultInput },
                                           owner: owner(), journal: journal,
                                           builtInInput: { (id: "built-in", name: "Built-in Microphone") },
                                           defaultOutput: { (id: "builtin-out", name: "MacBook Speakers") },
                                           transport: { $0 == "builtin-out" ? "built-in" : "Bluetooth" })
        device.onCapturePrepared = { captures.append($0) }
        device.onInputChange = { paused.append($0) }
        try await device.start { _ in }
        try audioRequire(captures.count == 1 && device.isCapturing, "the call starts on the built-in microphone")
        defaultInput = (id: "bluetooth-in", name: "AirPods Pro")
        device.routeChanged()
        await device.finishRouteRecovery()
        try audioRequire(paused.isEmpty, "a default input change to a headset never pauses the call")
        try audioRequire(captures.count == 1, "capture is not torn down while the built-in microphone exists")
        try audioRequire(device.isCapturing, "the same call keeps capturing after the input default moved")
        try audioRequire(!journal.events.contains { $0.name == "audio_output_switched" },
                         "no output changed, so no switch is claimed")
        device.stop()
    }

    /// Rule 2 and 5: headphones connect, so the default output moves. Playback is rebuilt on the
    /// new output inside the same call and the switch is journaled with its transports and duration.
    private static func checkOutputChangeRebuildsPlayback() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        var output = (id: "builtin-out", name: "MacBook Speakers")
        var captures: [NativeCaptureBuffer] = []
        var paused: [String] = []
        var switches: [(String, String, Int)] = []
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "built-in", name: "Built-in Microphone") },
                                           owner: owner(), journal: journal,
                                           builtInInput: { (id: "built-in", name: "Built-in Microphone") },
                                           defaultOutput: { output },
                                           transport: { $0 == "bluetooth-out" ? "Bluetooth" : "built-in" })
        device.onCapturePrepared = { captures.append($0) }
        device.onInputChange = { paused.append($0) }
        device.onOutputSwitched = { switches.append(($0, $1, $2)) }
        try await device.start { _ in }
        output = (id: "bluetooth-out", name: "AirPods Pro")
        device.routeChanged()
        await device.finishRouteRecovery()
        try audioRequire(paused.isEmpty, "an output change never pauses the call")
        try audioRequire(device.isCapturing, "the same call continues on the new output")
        try audioRequire(captures.count == 2, "the rebuild prepared capture again for the moved output")
        try audioRequire(switches.count == 1 && switches[0].0 == "built-in" && switches[0].1 == "Bluetooth",
                         "the switch reports the transports it moved between")
        let switched = journal.events.first { $0.name == "audio_output_switched" }
        try audioRequire(switched?.fields["from"] == "built-in" && switched?.fields["to"] == "Bluetooth"
                         && Int(switched?.fields["ms"] ?? "") != nil,
                         "audio.log writes audio_output_switched with from, to and ms")
        device.stop()
    }

    /// Rule 1: no built-in microphone (lid closed, desktop Mac). The system default input carries
    /// the call and the status line says so, once, instead of moving silently.
    private static func checkNoBuiltInMicFallsBackWithNotice() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        var captures: [NativeCaptureBuffer] = []
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "usb-in", name: "USB Microphone") },
                                           owner: owner(), journal: journal,
                                           builtInInput: { nil },
                                           defaultOutput: { (id: "builtin-out", name: "MacBook Speakers") })
        device.onCapturePrepared = { captures.append($0) }
        try await device.start { _ in }
        try audioRequire(device.inputPolicy == "fallback" && device.captureName == "USB Microphone",
                         "without a built-in microphone the default input is the announced fallback")
        let policy = journal.events.first { $0.name == "audio_input_policy" }
        try audioRequire(policy?.fields["policy"] == "fallback"
                         && policy?.fields["reason"] == "built_in_missing",
                         "audio.log writes audio_input_policy with its reason")
        try audioRequire(NativeLiveAudioDevice.inputPolicyNotice("USB Microphone")
                         == "Using USB Microphone microphone, built-in not available",
                         "the owner's status text names the microphone carrying the call")
        device.stop()
    }

    /// Rule 4: the built-in microphone disappears mid-call. That is the one route change that still
    /// pauses, and the status text names the microphone that took over.
    private static func checkCaptureLossStillPauses() async throws {
        let format = try format()
        let journal = NativeAudioJournal(fileURL: nil)
        var builtIn: (id: String, name: String)? = (id: "built-in", name: "Built-in Microphone")
        var paused: [String] = []
        let device = NativeLiveAudioDevice(captureInput: format,
                                           defaultInput: { (id: "usb-in", name: "USB Microphone") },
                                           owner: owner(), journal: journal,
                                           builtInInput: { builtIn },
                                           defaultOutput: { (id: "builtin-out", name: "MacBook Speakers") })
        device.onInputChange = { paused.append($0) }
        try await device.start { _ in }
        builtIn = nil
        device.routeChanged()
        await device.finishRouteRecovery()
        try audioRequire(paused == ["USB Microphone"], "losing the capture device pauses and names the new one")
        device.stop()
    }
}
