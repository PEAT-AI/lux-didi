import AVFoundation
import Foundation

/// Issue #529: a soft sci-fi pad while a voice connection is being built, looping with no click.
enum ConnectingRingTone {
    static let sampleRate = 24000.0
    static let loopMs = 2400
    static let peak: Float = 0.10
    static let stopRampMs = 30
    /// One detune step is a whole cycle per loop, so each pair beats once per loop and the seam
    /// closes.
    static let detune: Double = 1 / (Double(loopMs) / 1000)
    /// An A open fifth in detuned pairs: A3, E4 and A4, with each voice shimmering against its twin.
    static let padFrequencies: [Double] = [220, 220 + detune, 330, 330 + detune, 440, 440 + detune]
    static let padGains: [Double] = [0.55, 0.55, 0.34, 0.34, 0.24, 0.24]
    static let sparkleFrequency = 1440.0
    static let sparkleGain = 0.10
    static let pingStartHz = 520.0
    static let pingEndHz = 880.0
    static let pingStartMs = 600
    static let pingMs = 1200
    static let pingDecayMs = 300.0
    static let pingGain = 0.5
    static let pingReleaseMs = 30

    static var loopFrames: Int { Int(sampleRate * Double(loopMs) / 1000) }
    static var loopSeconds: Double { Double(loopMs) / 1000 }

    /// One 2400 ms loop: the pad, a high partial that wobbles twice per loop and one sonar ping on
    /// an upward glide, all under a breath that starts and ends at silence so the loop begins
    /// quietly and wraps without a click.
    static func samples() -> [Float] {
        var out = [Float](repeating: 0, count: loopFrames)
        let loop = loopSeconds
        let pingStart = Int(sampleRate * Double(pingStartMs) / 1000)
        let pingFrames = Int(sampleRate * Double(pingMs) / 1000)
        let pingRelease = Int(sampleRate * Double(pingReleaseMs) / 1000)
        let glide = (pingEndHz - pingStartHz) / (Double(pingFrames) / sampleRate)
        for index in 0..<loopFrames {
            let time = Double(index) / sampleRate
            var value = 0.0
            for (frequency, gain) in zip(padFrequencies, padGains) {
                value += gain * sin(2 * Double.pi * frequency * time)
            }
            let wobble = 0.5 + 0.5 * cos(4 * Double.pi * time / loop)
            value += sparkleGain * wobble * sin(2 * Double.pi * sparkleFrequency * time)
            let pingIndex = index - pingStart
            if pingIndex >= 0 && pingIndex < pingFrames {
                let pingTime = Double(pingIndex) / sampleRate
                let phase = 2 * Double.pi
                    * (pingStartHz * pingTime + 0.5 * glide * pingTime * pingTime)
                let decay = exp(-pingTime / (pingDecayMs / 1000))
                let tail = pingFrames - 1 - pingIndex
                let release = tail < pingRelease
                    ? 0.5 - 0.5 * cos(Double.pi * Double(tail) / Double(pingRelease)) : 1
                value += pingGain * release * decay * sin(phase)
            }
            let breath = sin(Double.pi * time / loop)
            out[index] = Float(value * breath * breath)
        }
        return scaledToPeak(out)
    }

    /// Scaled just under the cap, so rounding and 16-bit quantization never exceed it.
    private static func scaledToPeak(_ samples: [Float]) -> [Float] {
        let top = samples.map { abs($0) }.max() ?? 0
        guard top > 0 else { return samples }
        let scale = peak * 0.98 / top
        return samples.map { $0 * scale }
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

/// The arrival chime after the ring: a friendly three note bell arpeggio, A5 then C#6 then E6,
/// on the ring's own player.
enum ConnectingChimeTone {
    static let sampleRate = 24000.0
    static let noteFrequencies: [Double] = [880, 1108.73, 1318.51]
    static let onsetMs: [Int] = [0, 80, 160]
    static let lengthMs = 760
    static let peak: Float = 0.14
    static let decayMs = 160.0
    static let attackMs = 6
    /// The closing release: the buffer ends at silence and the director waits this long past it.
    static let fadeMs = 40
    static let partialGains: [Double] = [1, 0.35, 0.12]
    static let partialDecays: [Double] = [1, 0.6, 0.4]

    static var totalFrames: Int { Int(sampleRate * Double(lengthMs) / 1000) }
    static var onsetFrames: [Int] { onsetMs.map { Int(sampleRate * Double($0) / 1000) } }

    /// One shot: three bells 80 ms apart, each a sine plus two quieter partials on exponential
    /// decays, all released to silence at the end.
    static func samples() -> [Float] {
        var out = [Float](repeating: 0, count: totalFrames)
        let attackFrames = Int(sampleRate * Double(attackMs) / 1000)
        let releaseFrames = Int(sampleRate * Double(fadeMs) / 1000)
        for (frequency, onset) in zip(noteFrequencies, onsetFrames) {
            for index in onset..<totalFrames {
                let time = Double(index - onset) / sampleRate
                var value = 0.0
                for partial in 0..<partialGains.count {
                    let multiple = Double(partial + 1)
                    let decay = decayMs / 1000 * partialDecays[partial]
                    value += partialGains[partial] * exp(-time / decay)
                        * sin(2 * Double.pi * frequency * multiple * time)
                }
                let head = index - onset
                let attack = head < attackFrames
                    ? 0.5 - 0.5 * cos(Double.pi * Double(head) / Double(attackFrames)) : 1
                let tail = totalFrames - 1 - index
                let release = tail < releaseFrames
                    ? 0.5 - 0.5 * cos(Double.pi * Double(tail) / Double(releaseFrames)) : 1
                out[index] += Float(value * attack * release)
            }
        }
        let top = out.map { abs($0) }.max() ?? 0
        guard top > 0 else { return out }
        let scale = peak * 0.98 / top
        return out.map { $0 * scale }
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

/// #589: the goodbye when the owner's own sentence ends the call: the arrival chime turned around and
/// softened, three bells descending over 600 ms under a lower peak, on the ring's own player.
enum ConnectingGoodbyeTone {
    static let sampleRate = 24000.0
    static let noteFrequencies: [Double] = [1318.51, 1108.73, 880]
    static let onsetMs: [Int] = [0, 130, 260]
    static let lengthMs = 600
    static let peak: Float = 0.12
    static let decayMs = 200.0
    static let attackMs = 8
    /// The closing release: the buffer ends at silence and the ring waits this long past it.
    static let fadeMs = 40
    static let partialGains: [Double] = [1, 0.3, 0.1]
    static let partialDecays: [Double] = [1.4, 0.9, 0.6]

    static var totalFrames: Int { Int(sampleRate * Double(lengthMs) / 1000) }
    static var onsetFrames: [Int] { onsetMs.map { Int(sampleRate * Double($0) / 1000) } }

    /// One shot on the arrival chime's synthesis, with the notes descending and a slower decay.
    static func samples() -> [Float] {
        var out = [Float](repeating: 0, count: totalFrames)
        let attackFrames = Int(sampleRate * Double(attackMs) / 1000)
        let releaseFrames = Int(sampleRate * Double(fadeMs) / 1000)
        for (frequency, onset) in zip(noteFrequencies, onsetFrames) {
            for index in onset..<totalFrames {
                let time = Double(index - onset) / sampleRate
                var value = 0.0
                for partial in 0..<partialGains.count {
                    let multiple = Double(partial + 1)
                    let decay = decayMs / 1000 * partialDecays[partial]
                    value += partialGains[partial] * exp(-time / decay)
                        * sin(2 * Double.pi * frequency * multiple * time)
                }
                let head = index - onset
                let attack = head < attackFrames
                    ? 0.5 - 0.5 * cos(Double.pi * Double(head) / Double(attackFrames)) : 1
                let tail = totalFrames - 1 - index
                let release = tail < releaseFrames
                    ? 0.5 - 0.5 * cos(Double.pi * Double(tail) / Double(releaseFrames)) : 1
                out[index] += Float(value * attack * release)
            }
        }
        let top = out.map { abs($0) }.max() ?? 0
        guard top > 0 else { return out }
        let scale = peak * 0.98 / top
        return out.map { $0 * scale }
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
    private var alarmDeadline: Int?

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

    func startAlarm(deadlineMs: Int) {
        let deadline = min(deadlineMs, now() + 600_000)
        guard deadline > now() else { return }
        if let current = alarmDeadline { alarmDeadline = max(current, deadline); return }
        alarmDeadline = deadline
        playToken &+= 1
        ringOutput().stopOutput()
        alarmPulse(token: playToken)
    }

    private func alarmPulse(token: UInt64) {
        guard token == playToken, let deadline = alarmDeadline else { return }
        guard now() < deadline else { stopAlarm(); return }
        if let buffer = ConnectingChimeTone.buffer() {
            outputRunning = ringOutput().playChime(buffer)
            after(ConnectingChimeTone.lengthMs + ConnectingChimeTone.fadeMs) { [weak self] in
                guard let self, token == self.playToken else { return }
                self.outputRunning = false
                self.output?.stopOutput()
            }
        }
        after(max(1, min(45_000, deadline - now()))) { [weak self] in self?.alarmPulse(token: token) }
    }

    func stopAlarm() {
        guard alarmDeadline != nil else { return }
        alarmDeadline = nil
        playToken &+= 1
        outputRunning = false
        output?.stopOutput()
    }

    func presenceChanged(_ next: PresenceState, failed: Bool) {
        guard alarmDeadline == nil else { return }
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

    /// SOUND-R1: the host is rebuilding a dropped call, so the ring sounds the reconnect while the
    /// presence the owner sees stays live. An ended rebuild ramps out through the ordinary cold or
    /// muted presence record, which plays no chime.
    func rebuildStarted() {
        guard alarmDeadline == nil else { return }
        presenceChanged(.connecting, failed: false)
    }

    /// SOUND-R1: the rebuilt call is live again, so the ring returns to live and plays the chime.
    func rebuildSettled() {
        presenceChanged(.live, failed: false)
    }

    /// #589: the owner's own words ended the call, so the same player says goodbye: one descending bell,
    /// then the output stops. Nothing here touches the live engine, whose microphone is already closed.
    func goodbye() {
        guard alarmDeadline == nil else { return }
        let output = ringOutput()
        // #613: the goodbye records played or refused in native-live.log, and the mic is already released.
        guard let buffer = ConnectingGoodbyeTone.buffer() else {
            receipt?(["event": "goodbye_tone", "played": false, "reason": "no_buffer"])
            return
        }
        guard output.playChime(buffer) else {
            receipt?(["event": "goodbye_tone", "played": false, "reason": "output_refused"])
            return
        }
        receipt?(["event": "goodbye_tone", "played": true])
        playToken &+= 1
        let token = playToken
        outputRunning = true
        after(ConnectingGoodbyeTone.lengthMs + ConnectingGoodbyeTone.fadeMs) { [weak self] in
            guard let self, token == self.playToken, self.outputRunning else { return }
            self.outputRunning = false
            output.stopOutput()
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

struct ShellAlarm: Codable, Equatable, Sendable {
    let id: String
    let fireAtUtc: Int
    let tz: String
    let state: String
    let ringDeadlineUtc: Int?
}

/// Pure ownership policy; native effects are injected so local tests never touch power or notifications.
@MainActor final class AlarmShellPolicy {
    private let acquire: () -> Bool
    private let release: () -> Void
    private let register: (ShellAlarm) -> Void
    private let remove: (String) -> Void
    private var held = false
    private var registered = Set<String>()
    private(set) var degraded = false
    private(set) var caption: String?
    var assertionHeld: Bool { held }
    init(acquire: @escaping () -> Bool, release: @escaping () -> Void,
         register: @escaping (ShellAlarm) -> Void, remove: @escaping (String) -> Void) {
        self.acquire = acquire; self.release = release; self.register = register; self.remove = remove
    }
    func apply(_ alarms: [ShellAlarm], notificationsAllowed: Bool) {
        let active = alarms.filter { $0.state == "pending" || $0.state == "ringing" }
        if !active.isEmpty && !held { held = acquire() }
        if active.isEmpty && held { release(); held = false }
        let pending = Set(active.filter { $0.state == "pending" }.map(\.id))
        for id in registered.subtracting(pending) { remove(id) }
        for alarm in active where pending.contains(alarm.id) && !registered.contains(alarm.id) { register(alarm) }
        registered = pending
        degraded = !active.isEmpty && (!held || !notificationsAllowed)
        if let next = active.min(by: { $0.fireAtUtc < $1.fireAtUtc }) {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: next.tz); formatter.dateFormat = "HH:mm"
            caption = "Alarm " + formatter.string(from: Date(timeIntervalSince1970: Double(next.fireAtUtc) / 1000)) + (degraded ? " !" : "")
        } else { caption = nil }
    }
    func refreshNotifications(_ alarms: [ShellAlarm], notificationsAllowed: Bool) {
        for id in registered { remove(id) }
        registered.removeAll()
        apply(alarms, notificationsAllowed: notificationsAllowed)
    }
    func stop() { apply([], notificationsAllowed: true) }
}
