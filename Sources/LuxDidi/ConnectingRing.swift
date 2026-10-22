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

/// The connected chime after the ring, copied from Vicuna's `earcon.service.ts` playConnected:
/// 440 Hz then 550 Hz, 100 ms each with a 50 ms gap, peak 0.15 and a 15 ms linear fade. Parity with
/// the ring the owner asked for, on the ring's own player, so no third engine appears.
enum ConnectingChimeTone {
    static let sampleRate = 24000.0
    static let firstTone = 440.0
    static let secondTone = 550.0
    static let noteMs = 100
    static let gapMs = 50
    static let peak: Float = 0.15
    static let fadeMs = 15

    static var noteFrames: Int { Int(sampleRate * Double(noteMs) / 1000) }
    static var gapFrames: Int { Int(sampleRate * Double(gapMs) / 1000) }
    static var fadeFrames: Int { Int(sampleRate * Double(fadeMs) / 1000) }
    static var secondOnset: Int { noteFrames + gapFrames }
    static var totalFrames: Int { secondOnset + noteFrames }
    /// The chime's own length: two tones and the gap between them.
    static var lengthMs: Int { Int(Double(totalFrames) / sampleRate * 1000) }

    static func samples() -> [Float] {
        var out = [Float](repeating: 0, count: totalFrames)
        for (onset, frequency) in [(0, firstTone), (secondOnset, secondTone)] {
            for index in 0..<noteFrames {
                let phase = 2 * Double.pi * frequency * Double(index) / sampleRate
                out[onset + index] = Float(sin(phase)) * peak * fade(index)
            }
        }
        return out
    }

    /// A linear 15 ms fade in and out, as Vicuna's gain ramps are linear.
    private static func fade(_ index: Int) -> Float {
        if index < fadeFrames { return Float(index) / Float(fadeFrames) }
        if index >= noteFrames - fadeFrames {
            return Float(noteFrames - 1 - index) / Float(fadeFrames)
        }
        return 1
    }

    static func buffer() -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(totalFrames)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(totalFrames)
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
    /// The ring's own playLoop result: false when its engine refused to start.
    let played: Bool
    /// Whether this ring asked for the connected chime, which happens only on the move to live.
    let chime: Bool

    var ms: Int { stoppedAt - startedAt }

    var fields: [String: Any] {
        ["event": "connecting_ring", "started_at": startedAt, "stopped_at": stoppedAt,
         "ms": ms, "reason": reason, "played": played, "chime": chime]
    }
}

/// L12c: the one `connecting_chime` native log record. The connected chime used to be silent about
/// its own outcome, so a quiet call could not say whether she was ever greeted by it.
struct ConnectingChimeRecord: Equatable {
    let played: Bool
    /// One closed reason when nothing played: the presence moved on, the tone was not built, or the player refused.
    let reason: String?

    var fields: [String: Any] {
        var fields: [String: Any] = ["event": "connecting_chime", "played": played]
        if let reason { fields["reason"] = reason }
        return fields
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
    /// The connected chime: one shot on the same player, after the ring's ramp.
    func playChime(_ buffer: AVAudioPCMBuffer) -> Bool
    /// Stops the player and the engine: the same pair the ramp-down ends with, so Didi never holds
    /// the output device between calls.
    func stopOutput()
    /// A ramp then a stop; `after` runs once the player is silent, so a chime never plays over the ring.
    func rampDown(overMs: Int, after: (@MainActor () -> Void)?)
}

/// The ring's own output path: a playback-only engine, separate from the live voice engine, so
/// the ring never starts, stops or reconfigures the live engine and never opens the microphone.
@MainActor
final class ConnectingRingPlayer: ConnectingRingOutput {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var connectedFormat: AVAudioFormat?
    private var rampTask: Task<Void, Never>?

    func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool { play(buffer, loops: true) }

    func playChime(_ buffer: AVAudioPCMBuffer) -> Bool { play(buffer, loops: false) }

    private func play(_ buffer: AVAudioPCMBuffer, loops: Bool) -> Bool {
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
        player.scheduleBuffer(buffer, at: nil, options: loops ? .loops : [], completionHandler: nil)
        player.play()
        return true
    }

    func stopOutput() {
        player.stop()
        engine.stop()
    }

    /// A 30 ms fade then a stop; a second stop cancels the first, and `after` runs only once the
    /// player is silent, so the connected chime follows the ring instead of playing over it.
    func rampDown(overMs ms: Int, after: (@MainActor () -> Void)?) {
        rampTask?.cancel()
        guard player.isPlaying else {
            engine.stop()
            after?()
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
            after?()
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
    private var ringPlayed = false
    /// Bumped on every play, so a chime's stop can never land on a later sound.
    private var playToken: UInt64 = 0
    /// Whether the ring's player and engine are running right now.
    private var outputRunning = false

    private let now: @MainActor () -> Int
    /// One main-actor turn between the ask and the play, so a stop that lands in the same turn
    /// reaches the director before the player ever starts.
    private let deferStart: @MainActor (@escaping @MainActor () -> Void) -> Void
    /// A bounded wait, so the chime's stop lands after the chime even without a player callback.
    private let after: @MainActor (Int, @escaping @MainActor () -> Void) -> Void

    /// The `connecting_ring` record goes through the existing presence receipt path.
    var receipt: (([String: Any]) -> Void)?

    init(output: ConnectingRingOutput? = nil,
         now: @escaping @MainActor () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         deferStart: @escaping @MainActor (@escaping @MainActor () -> Void) -> Void = { body in
             Task { @MainActor in body() }
         },
         after: @escaping @MainActor (Int, @escaping @MainActor () -> Void) -> Void = { ms, body in
             Task { @MainActor in
                 try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                 body()
             }
         }) {
        self.output = output
        self.now = now
        self.deferStart = deferStart
        self.after = after
    }

    func presenceChanged(_ next: PresenceState, failed: Bool) {
        let at = now()
        switch director.transition(to: next, failed: failed, atMs: at) {
        case .beginStart(let token):
            startedAt = at
            ringPlayed = false
            playToken &+= 1
            let output = ringOutput()
            deferStart { [weak self] in
                guard let self else { return }
                guard self.director.commitStart(token) == .play,
                      let buffer = ConnectingRingTone.buffer() else { return }
                let played = output.playLoop(buffer)
                self.ringPlayed = played
                self.outputRunning = played
            }
        case .rampDown(let reason, let ms):
            let output = ringOutput()
            playToken &+= 1
            let token = playToken
            // The chime follows the ring only on the move to live: never on a warm unmute, never
            // on a failure. It plays after the ramp, on the ring's own player.
            let chimeRequested = reason == PresenceState.live.rawValue
            let chimeBuffer = chimeRequested ? ConnectingChimeTone.buffer() : nil
            // The record lands here, as it did before the chime existed, so a presence edge inside
            // the 30 ms ramp can never drop it. `chime` names the connected chime this ring asks for.
            receipt?(ConnectingRingRecord(startedAt: startedAt, stoppedAt: startedAt + ms, reason: reason,
                                          played: ringPlayed, chime: chimeRequested).fields)
            output.rampDown(overMs: ConnectingRingTone.stopRampMs) { [weak self, output] in
                guard let self else { return }
                // The ramp ended with the player and the engine stopped, like the no-chime path.
                outputRunning = false
                guard chimeRequested else { return }
                guard let chimeBuffer else {
                    self.receipt?(ConnectingChimeRecord(played: false, reason: "no_buffer").fields)
                    return
                }
                guard token == playToken else {
                    self.receipt?(ConnectingChimeRecord(played: false, reason: "token_mismatch").fields)
                    return
                }
                let played = output.playChime(chimeBuffer)
                self.receipt?(ConnectingChimeRecord(played: played, reason: played ? nil : "output_refused").fields)
                guard played else { return }
                outputRunning = true
                playToken &+= 1
                let chimeToken = playToken
                // The chime's length plus its fade: the moment it is over, the player and the engine
                // are stopped, so a stale stop can never cut a later sound.
                after(ConnectingChimeTone.lengthMs + ConnectingChimeTone.fadeMs) { [weak self] in
                    guard let self, chimeToken == playToken, outputRunning else { return }
                    outputRunning = false
                    output.stopOutput()
                }
            }
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
