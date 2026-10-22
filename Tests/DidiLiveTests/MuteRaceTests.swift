import Foundation

/// The mute race of 2026-10-22 (D5) replayed against a fake host: sessions open, become
/// ready, end and fail at pseudo-random delays, while the only input is the bare tap. The
/// clock and every delay are the test's own, so no socket, engine, panel or wait is involved.
@main struct MuteRaceTests {
    static func main() async {
        do {
            try await MainActor.run { try run() }
            print("PASS mute race: warm mute held open, resume without a reconnect, muted cold after the "
                + "session ends, stale callbacks fenced, current failure visible, ten taps keep the parity")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    /// One fake host: it owns the conversation id, opens and closes sessions, and delivers
    /// every lifecycle callback later, never at the instant the machine asks for it.
    @MainActor final class Host {
        enum Kind { case ready, ended, failed }
        struct Event { let time: Double; let generation: UInt64; let kind: Kind; let order: Int }

        let conversationId = "conversation-1"
        var now: Double = 0
        var minimumDelay: Double = 0
        var delaySpan: Double = 0.3
        var opens: [(generation: UInt64, conversationId: String)] = []
        var closes = 0
        var fences: [Bool] = []
        var inputs: [Bool] = []
        var receipts: [[String: Any]] = []
        var pending: [Event] = []
        private var openGeneration: UInt64 = 0
        private var order = 0
        private var seed: UInt64 = 0x2545F4914F6CDD1D
        lazy var presence: NativePresence = NativePresence(effects: PresenceEffects(
            openSession: { [unowned self] generation in self.opened(generation) },
            cancelConnecting: { [unowned self] in self.closedSession() },
            closeSession: { [unowned self] in self.closedSession() },
            setCaptureMuted: { [unowned self] muted in self.fences.append(muted) },
            cancelPlayback: {},
            providerInputMute: { [unowned self] muted in self.inputs.append(muted) },
            receipt: { [unowned self] record in self.receipts.append(record) }),
            now: { [unowned self] in self.now })

        private func randomDelay() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return minimumDelay + Double(seed >> 33) / 4294967296.0 * delaySpan
        }
        private func opened(_ generation: UInt64) {
            opens.append((generation, conversationId))
            openGeneration = generation
            queue(.ready, generation: generation, at: now + randomDelay())
        }
        /// One close is seen by the app twice, as the live app sees it: at the stop and again
        /// when the socket teardown lands. Both carry the generation the session opened under.
        private func closedSession() {
            closes += 1
            let generation = openGeneration
            openGeneration = 0
            queue(.ended, generation: generation, at: now)
            queue(.ended, generation: generation, at: now + 0.05)
        }
        private func queue(_ kind: Kind, generation: UInt64, at time: Double) {
            pending.append(Event(time: time, generation: generation, kind: kind, order: order))
            order += 1
        }
        /// The host ends the open session itself, the way a 180 s mute expiry or a provider drop does:
        /// one ended callback, delivered late like every other.
        func endSession() {
            guard openGeneration != 0 else { return }
            queue(.ended, generation: openGeneration, at: now + randomDelay())
            openGeneration = 0
        }
        func failNextSession() {
            guard !opens.isEmpty else { return }
            pending.removeAll { $0.kind == .ready }
            queue(.failed, generation: openGeneration, at: now + randomDelay())
        }
        /// Every event due by the given time, delivered in time order.
        func advance(to time: Double) {
            now = time
            while true {
                pending.sort { ($0.time, $0.order) < ($1.time, $1.order) }
                guard let next = pending.first, next.time <= now else { return }
                pending.removeFirst()
                switch next.kind {
                case .ready: presence.ready(next.generation)
                case .ended: presence.sessionEnded(next.generation)
                case .failed: presence.fail(next.generation)
                }
            }
        }
        /// Deliver everything still queued, in its own order, however late.
        func settle() {
            while let next = pending.min(by: { ($0.time, $0.order) < ($1.time, $1.order) }) {
                advance(to: next.time)
            }
        }
    }

    @MainActor static func run() throws {
        let host = Host()
        let presence = host.presence

        // Acceptance 1: live, tap, and the mute holds the same session warm for the whole window.
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "a cold tap opens a session")
        host.settle()
        try require(presence.state == .live, "readiness makes her live")
        let conversation = host.conversationId
        try require(host.opens.count == 1 && host.opens[0].conversationId == conversation,
            "the first session opens on the app's conversation")
        let warmGeneration = presence.generation
        host.opens.removeAll(); host.closes = 0; host.fences.removeAll(); host.inputs.removeAll()
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted && presence.mutedHeld, "a tap from live holds the mute")
        try require(host.closes == 0, "the mute keeps the provider session open, got \(host.closes) closes")
        try require(host.fences == [true], "the mute closes the audio fence, got \(host.fences)")
        try require(host.inputs == [true], "the provider input is muted at the same instant, got \(host.inputs)")
        try require(host.opens.isEmpty, "the mute opens nothing")
        host.settle()
        try require(presence.state == .hotMuted && presence.mutedHeld && presence.mutedWarm,
            "the kept session's own callbacks never demote the warm mute")
        host.advance(to: host.now + 60)
        try require(presence.state == .hotMuted && host.closes == 0,
            "a minute muted changes nothing and closes nothing")
        // The unmute inside the window: live again on the same session, no provider call at all.
        host.fences.removeAll(); host.inputs.removeAll()
        presence.tap(.hotkey)
        try require(presence.state == .live && presence.generation == warmGeneration,
            "an unmute inside the window is live on the same session and generation")
        try require(host.opens.isEmpty, "the resume opens no provider session, got \(host.opens.count)")
        try require(host.fences == [false] && host.inputs == [false],
            "the resume opens the fence and lifts the provider input mute, got \(host.fences) \(host.inputs)")
        try require(!presence.mutedWarm, "a resumed session is no longer on the held mute")

        // Acceptance 2: the host expires the mute at 180 s. The session ends, the mute stays held and
        // cold, and the next tap opens exactly one new session on the same conversation.
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted && presence.mutedWarm, "the tap mutes warm again")
        host.advance(to: host.now + NativePresence.warmWindow + 1)
        host.endSession()
        host.settle()
        try require(presence.state == .hotMuted && presence.mutedHeld && !presence.mutedWarm,
            "the ended session leaves a held, cold mute")
        try require(presence.posture.muted, "a muted-cold owner still sees the purple mute")
        host.opens.removeAll()
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "a tap in a muted-cold state connects")
        try require(host.opens.count == 1 && host.opens[0].conversationId == conversation,
            "the reconnect opens exactly one session on the same conversation, got \(host.opens)")
        host.settle()
        try require(presence.state == .live, "the new session's readiness makes her live")

        // Acceptance 6: a stale ready or ended from an earlier generation changes nothing.
        host.minimumDelay = 0.2
        let stale = presence.generation
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted, "the tap mutes")
        host.advance(to: host.now + 0.06)
        host.minimumDelay = 0
        try require(presence.state == .hotMuted,
            "the earlier generation's callbacks never move the held mute")

        // A genuine failure of the session that opens from a muted tap still goes cold and says so.
        host.advance(to: host.now + NativePresence.warmWindow + 1)
        host.endSession()
        host.settle()
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "the tap reconnects")
        host.failNextSession()
        host.settle()
        try require(presence.state == .cold && presence.failed, "a genuine failure goes cold and says so")
        try require(host.receipts.last?["trigger"] as? String == "error", "the failure receipt names the error")
        try require(stale != 0, "the fenced generation is real")

        // Acceptance 5: ten alternating taps, each with its own delay, end on the parity state with one session.
        let ten = Host()
        let machine = ten.presence
        machine.tap(.hotkey)
        ten.settle()
        try require(machine.state == .live, "the run starts live")
        var seen: [PresenceState] = []
        for _ in 1...10 {
            ten.advance(to: ten.now + 0.1)
            machine.tap(.hotkey)
            seen.append(machine.state)
        }
        ten.settle()
        try require(!seen.contains(.cold), "no tap in the run leaves her cold, saw \(seen)")
        try require(machine.state == .live, "ten taps end live, the parity of the last one")
        try require(ten.opens.count == 1, "one open for the start and none for any warm tap, got \(ten.opens.count)")
        try require(ten.closes == 0, "no warm tap closes a session, got \(ten.closes)")
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
