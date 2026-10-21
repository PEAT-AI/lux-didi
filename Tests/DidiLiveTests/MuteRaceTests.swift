import Foundation

/// The mute race of 2026-10-22 (D5) replayed against a fake host: sessions open, become
/// ready, end and fail at pseudo-random delays, while the only input is the bare tap. The
/// clock and every delay are the test's own, so no socket, engine, panel or wait is involved.
@main struct MuteRaceTests {
    static func main() async {
        do {
            try await MainActor.run { try run() }
            print("PASS mute race: held mute, stale ended and ready fenced, current failure visible, "
                + "ten taps keep the parity")
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
            receipt: { [unowned self] record in self.receipts.append(record) }))

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

        // Acceptance 1: live, tap, and the mute holds for hours on the same conversation.
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "a cold tap opens a session")
        host.settle()
        try require(presence.state == .live, "readiness makes her live")
        let conversation = host.conversationId
        try require(host.opens.count == 1 && host.opens[0].conversationId == conversation,
            "the first session opens on the app's conversation")
        host.opens.removeAll(); host.closes = 0; host.fences.removeAll()
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted && presence.mutedHeld, "a tap from live holds the mute")
        try require(host.closes == 1, "the mute ends the provider session")
        try require(host.fences == [true], "the mute closes the audio fence, got \(host.fences)")
        try require(host.inputs.last == true, "the provider input is muted at the same instant")
        try require(host.opens.isEmpty, "the mute opens nothing")
        host.settle()
        try require(presence.state == .hotMuted && presence.mutedHeld,
            "the closed session's end never demotes the held mute")
        host.advance(to: host.now + 3 * 3600)
        try require(presence.state == .hotMuted, "three hours later the mute is still held, with no session")
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "a tap in MUTED goes to connecting")
        try require(host.opens.count == 1 && host.opens[0].conversationId == conversation,
            "the unmute opens exactly one session on the same conversation, got \(host.opens)")
        host.settle()
        try require(presence.state == .live && host.fences.last == false,
            "the new session's readiness opens the orb and the mic")

        // Acceptance 2: the old generation's end lands twice, synchronously and 50 ms later.
        host.opens.removeAll(); host.fences.removeAll(); host.minimumDelay = 0.2
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted, "the tap mutes")
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "the next tap reconnects")
        host.advance(to: host.now + 0.06)
        try require(presence.state == .connecting,
            "both ends of the old generation are ignored while the new one connects")
        host.settle()
        try require(presence.state == .live, "the new generation's readiness makes her live")
        host.minimumDelay = 0

        // Acceptance 3: a stale ready after a new mute never opens live.
        let staleReady = presence.generation
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted, "the tap mutes")
        presence.ready(staleReady)
        try require(presence.state == .hotMuted, "a ready from the generation the owner left opens nothing")

        // Acceptance 4: a current-generation failure fails visible, on the same held conversation.
        presence.tap(.hotkey)
        try require(presence.state == .connecting, "the tap reconnects")
        host.failNextSession()
        host.settle()
        try require(presence.state == .cold && presence.failed, "a genuine failure goes cold and says so")
        try require(host.receipts.last?["trigger"] as? String == "error", "the failure receipt names the error")

        // Acceptance 5: ten alternating taps, each with its own delay, keep the tap parity.
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
        try require(ten.opens.count == 6, "one open for the start and one per even tap, got \(ten.opens.count)")
        try require(ten.closes == 5, "one close per odd tap, got \(ten.closes)")
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
