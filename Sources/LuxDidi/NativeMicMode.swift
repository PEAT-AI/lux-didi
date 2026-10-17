import AVFoundation
import Foundation

/// The macOS Mic Mode (`#352`, release 3o). An app cannot set it: the owner picks it in Control Center,
/// so everything here only reads and observes. Nothing in this file writes an audio setting, starts a
/// capture session or reaches the audio engine or a device.
public enum MicMode: String, Sendable, CaseIterable {
    case standard, wideSpectrum, voiceIsolation, unknown

    /// The SDK's `AVCaptureMicrophoneMode` raw values, taken as an Int so a proof needs no device:
    /// Standard 0, WideSpectrum 1, VoiceIsolation 2, and anything else is unknown rather than a guess.
    public init(microphoneMode rawValue: Int) {
        switch rawValue {
        case 0: self = .standard
        case 1: self = .wideSpectrum
        case 2: self = .voiceIsolation
        default: self = .unknown
        }
    }
}

/// What the Mac reports at one moment: the mode the owner picked, and the mode the route actually gives us.
public struct MicModeReading: Sendable, Equatable {
    public let preferred: MicMode
    public let active: MicMode

    public init(preferred: MicMode, active: MicMode) {
        self.preferred = preferred
        self.active = active
    }

    /// The receipt: the two names and nothing else, so host.log can say what the Mac was doing at a LIVE start.
    public var record: [String: Any] {
        ["event": "mic_mode", "preferred": preferred.rawValue, "active": active.rawValue]
    }
}

/// The two class properties, read where the app is awake. No capture session, no device, no route change.
public enum SystemMicMode {
    public static func read() -> MicModeReading {
        MicModeReading(preferred: MicMode(microphoneMode: AVCaptureDevice.preferredMicrophoneMode.rawValue),
                       active: MicMode(microphoneMode: AVCaptureDevice.activeMicrophoneMode.rawValue))
    }

    /// The button's action, and the only thing here that shows anything: the system's Mic Mode picker.
    /// Non-blocking, and it selects no mode by itself; the owner still chooses.
    @MainActor public static func showPicker() { AVCaptureDevice.showSystemUserInterface(.microphoneModes) }
}

/// KVO over the two class properties, which Apple documents as key-value observable. A change reports the
/// new reading and nothing else.
public final class MicModeObserver: NSObject, @unchecked Sendable {
    private static let keyPaths = [#keyPath(AVCaptureDevice.preferredMicrophoneMode), #keyPath(AVCaptureDevice.activeMicrophoneMode)]
    private let onChange: @Sendable (MicModeReading) -> Void
    /// The class object, which is where a class property is observed.
    private let deviceClass = AVCaptureDevice.self as AnyObject as? NSObject
    private var observing = false

    public init(onChange: @escaping @Sendable (MicModeReading) -> Void) { self.onChange = onChange }

    deinit { stop() }

    public func start() {
        guard !observing, let deviceClass else { return }
        for keyPath in Self.keyPaths { deviceClass.addObserver(self, forKeyPath: keyPath, options: [.new], context: nil) }
        observing = true
    }

    public func stop() {
        guard observing, let deviceClass else { return }
        for keyPath in Self.keyPaths { deviceClass.removeObserver(self, forKeyPath: keyPath) }
        observing = false
    }

    public override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        guard Self.keyPaths.contains(keyPath ?? "") else { return }
        onChange(SystemMicMode.read())
    }
}

/// The full app's one quiet line, at most once per app version (`#352`). Pure and injected: the caller
/// passes the reading and the version, so the proof needs no window, no device and no clock.
public struct MicModePrompt: Sendable, Equatable {
    private var shownVersion: String?
    private var lastActive: MicMode?

    public init() {}

    /// A LIVE start asks. True at most once per app version, and again only after the mode went back
    /// from Voice Isolation to another mode.
    public mutating func liveStart(_ reading: MicModeReading, version: String) -> Bool {
        note(reading)
        guard reading.active != .voiceIsolation, shownVersion != version else { return false }
        shownVersion = version
        return true
    }

    /// A change notices the return from Voice Isolation, so a later LIVE start may ask again.
    public mutating func modeChanged(_ reading: MicModeReading) { note(reading) }

    private mutating func note(_ reading: MicModeReading) {
        if reading.active != .voiceIsolation, lastActive == .voiceIsolation { shownVersion = nil }
        lastActive = reading.active
    }
}
