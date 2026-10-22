import AVFoundation
import Foundation

/// Issue #529: Vicuna's friendly ring while a voice connection is being built. The numbers are
/// copied from Vicuna's `earcon.service.ts` playConnecting, not retuned here.
enum ConnectingRingTone {
    static let sampleRate = 24000.0
    static let firstTone = 659.25
    static let secondTone = 880.0
    static let noteMs = 200
    static let gapMs = 120
    static let loopMs = 1800
    static let triangleMix = 0.10
    static let peak: Float = 0.12
    static let fadeMs = 20
    static let stopRampMs = 30

    static var noteFrames: Int { Int(sampleRate * Double(noteMs) / 1000) }
    static var gapFrames: Int { Int(sampleRate * Double(gapMs) / 1000) }
    static var fadeFrames: Int { Int(sampleRate * Double(fadeMs) / 1000) }
    static var loopFrames: Int { Int(sampleRate * Double(loopMs) / 1000) }
    static var secondOnset: Int { noteFrames + gapFrames }

    /// One 1800 ms loop: E5 at 0, A5 at 320 ms, then silence to the loop end, so a looping player
    /// puts the pair at 0, 1.8 and 3.6 s. Each note is a sine plus a triangle at 10 percent mix,
    /// scaled so the peak is 0.12, with 20 ms raised-cosine fades.
    static func samples() -> [Float] {
        var out = [Float](repeating: 0, count: loopFrames)
        let scale = peak / (1 + Float(triangleMix))
        for (onset, frequency) in [(0, firstTone), (secondOnset, secondTone)] {
            for index in 0..<noteFrames {
                let phase = 2 * Double.pi * frequency * Double(index) / sampleRate
                let sine = Float(sin(phase))
                let triangle = Float(2 / Double.pi * asin(sin(phase)))
                out[onset + index] = (sine + Float(triangleMix) * triangle) * scale * fade(index)
            }
        }
        return out
    }

    private static func fade(_ index: Int) -> Float {
        if index < fadeFrames {
            return Float(0.5 - 0.5 * cos(Double.pi * Double(index) / Double(fadeFrames)))
        }
        if index >= noteFrames - fadeFrames {
            let tail = noteFrames - 1 - index
            return Float(0.5 - 0.5 * cos(Double.pi * Double(tail) / Double(fadeFrames)))
        }
        return 1
    }

    /// Rendered once per ring, so playback never synthesizes on the audio thread.
    static func buffer() -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(loopFrames)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(loopFrames)
        for (index, value) in samples().enumerated() { channel[index] = value }
        return buffer
    }
}

/// The one `connecting_ring` native log record: when the ring started, when it stopped, how long
/// it played and the presence state that ended it.
struct ConnectingRingRecord: Equatable {
    let startedAt: Int
    let stoppedAt: Int
    let reason: String

    var ms: Int { stoppedAt - startedAt }

    var fields: [String: Any] {
        ["event": "connecting_ring", "started_at": startedAt, "stopped_at": stoppedAt,
         "ms": ms, "reason": reason]
    }
}

/// The presence-to-ring rule: start on connecting, stop on any other state, and a start that a
/// stop outran never plays. No clock, no engine, so the rule is testable on its own.
struct ConnectingRingDirector {
    enum Effect: Equatable {
        /// A start was asked for and is being prepared; the token must come back to `commitStart`.
        case beginStart(UInt64)
        /// The newest start is current, so the loop plays.
        case play
        /// The start a stop outran: play nothing.
        case discard
        /// The ring is audible; ramp it out and record the length and the ending state.
        case rampDown(reason: String, ms: Int)
        case none
    }

    private enum Phase: Equatable {
        case idle
        case preparing(UInt64)
        case playing
    }

    private var phase: Phase = .idle
    private var generation: UInt64 = 0
    private var startedAtMs = 0

    mutating func transition(to next: PresenceState, failed: Bool, atMs: Int) -> Effect {
        if next == .connecting {
            generation &+= 1
            phase = .preparing(generation)
            startedAtMs = atMs
            return .beginStart(generation)
        }
        switch phase {
        case .preparing:
            generation &+= 1
            phase = .idle
            return .none
        case .playing:
            generation &+= 1
            phase = .idle
            return .rampDown(reason: failed ? "failed" : next.rawValue, ms: atMs - startedAtMs)
        case .idle:
            return .none
        }
    }

    mutating func commitStart(_ token: UInt64) -> Effect {
        guard phase == .preparing(token) else { return .discard }
        phase = .playing
        return .play
    }
}

/// What the ring plays through. A test stands in for the player, so the schedule is pinned with no
/// audio device.
@MainActor
protocol ConnectingRingOutput: AnyObject {
    func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool
    func rampDown(overMs: Int)
}

/// The ring's own output path: a playback-only engine, separate from the live voice engine, so
/// the ring never starts, stops or reconfigures the live engine and never opens the microphone.
@MainActor
final class ConnectingRingPlayer: ConnectingRingOutput {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var connectedFormat: AVAudioFormat?
    private var rampTask: Task<Void, Never>?

    func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool {
        rampTask?.cancel()
        rampTask = nil
        if connectedFormat != buffer.format {
            if connectedFormat != nil { engine.disconnectNodeOutput(player) }
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
            connectedFormat = buffer.format
        }
        engine.prepare()
        do { try engine.start() } catch { return false }
        player.volume = 1
        player.scheduleBuffer(buffer, at: nil, options: .loops, completionHandler: nil)
        player.play()
        return true
    }

    /// A 30 ms fade then a stop; a second stop cancels the first.
    func rampDown(overMs ms: Int) {
        rampTask?.cancel()
        guard player.isPlaying else {
            engine.stop()
            return
        }
        let steps = 6
        let stepMs = max(1, ms / steps)
        rampTask = Task { @MainActor [weak self] in
            for step in 1...steps {
                guard let self, !Task.isCancelled else { return }
                self.player.volume = 1 - Float(step) / Float(steps)
                try? await Task.sleep(nanoseconds: UInt64(stepMs) * 1_000_000)
            }
            guard let self, !Task.isCancelled else { return }
            self.player.stop()
            self.engine.stop()
        }
    }
}

/// Owns the ring the presence machine drives. A ring only ever starts from connecting, where the
/// capture fence is closed, so it never plays over the live engine's microphone.
@MainActor
final class ConnectingRing {
    private var director = ConnectingRingDirector()
    private var output: ConnectingRingOutput?
    private var startedAt = 0

    private let now: @MainActor () -> Int
    /// One main-actor turn between the ask and the play, so a stop that lands in the same turn
    /// reaches the director before the player ever starts.
    private let deferStart: @MainActor (@escaping @MainActor () -> Void) -> Void

    /// The `connecting_ring` record goes through the existing presence receipt path.
    var receipt: (([String: Any]) -> Void)?

    init(output: ConnectingRingOutput? = nil,
         now: @escaping @MainActor () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         deferStart: @escaping @MainActor (@escaping @MainActor () -> Void) -> Void = { body in
             Task { @MainActor in body() }
         }) {
        self.output = output
        self.now = now
        self.deferStart = deferStart
    }

    func presenceChanged(_ next: PresenceState, failed: Bool) {
        let at = now()
        switch director.transition(to: next, failed: failed, atMs: at) {
        case .beginStart(let token):
            startedAt = at
            let output = ringOutput()
            deferStart { [weak self] in
                guard let self else { return }
                guard self.director.commitStart(token) == .play,
                      let buffer = ConnectingRingTone.buffer() else { return }
                _ = output.playLoop(buffer)
            }
        case .rampDown(let reason, let ms):
            output?.rampDown(overMs: ConnectingRingTone.stopRampMs)
            receipt?(ConnectingRingRecord(startedAt: startedAt, stoppedAt: startedAt + ms, reason: reason).fields)
        case .play, .discard, .none:
            break
        }
    }

    /// The player is only built once a ring is asked for.
    private func ringOutput() -> ConnectingRingOutput {
        if let output { return output }
        let made = ConnectingRingPlayer()
        output = made
        return made
    }
}
