import AVFoundation
import Foundation

/// #613: a stop is the owner's, and a session nobody can vouch for is cold. The latch, the epoch and
/// every effect are injected, so each recovery race replays here with no socket, no host and no mic.
@main struct NativeStopLatchTests {
    static func main() async {
        do {
            try await MainActor.run { try await run() }
            print("PASS native stop latch: an uncertain session goes cold with no reconnect, a voice stop "
                + "keeps the generation fence, the latch clears only on an explicit Start, the calendar wait is "
                + "bounded, a refused goodbye is recorded")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    @MainActor final class Recorder {
        var calls: [String] = []
        var muted: [Bool] = []
        var opened: [UInt64] = []
        var receipts: [[String: Any]] = []
        var clock: Double = 0
    }

    @MainActor static func run() async throws {
        try uncertainGoesCold()
        try voiceStopKeepsTheGenerationFence()
        try theLatchIsTheOwnerStart()
        try await theCalendarWaitIsBounded()
        try aRefusedGoodbyeIsRecorded()
    }

    /// Acceptance 1: a socket that closed without a terminal frame ends cold, with the capture fence
    /// cut, the mic released and no reconnect of any kind.
    @MainActor static func uncertainGoesCold() throws {
        let record = Recorder()
        let presence = NativePresence(effects: effects(record), now: { record.clock })
        presence.start(.app)
        presence.ready(presence.generation)
        try require(presence.state == .live, "the session is live before the socket goes quiet")
        let generation = presence.generation
        record.calls.removeAll(); record.muted.removeAll(); record.opened.removeAll()

        presence.sessionUncertain(generation)

        try require(presence.state == .cold, "an uncertain session is cold, never left live")
        try require(!presence.mutedHeld, "the warm mute is cleared with the session")
        try require(record.opened.isEmpty, "nothing reconnects to resolve the uncertainty")
        try require(record.muted == [true], "the capture fence is cut exactly once")
        try require(record.calls.contains("close"), "the session is closed")
        try require(record.calls.last == "close", "the fence and the close are the whole teardown")
        let receipt = record.receipts.last
        try require(receipt?["to"] as? String == "cold", "the receipt names the cold move")

        // A stale generation is another session's, so it never touches this one.
        let live = NativePresence(effects: effects(record), now: { record.clock })
        live.start(.app)
        live.ready(live.generation)
        let stale = live.generation &+ 7
        live.sessionUncertain(stale)
        try require(live.state == .live, "an uncertainty from a generation the owner left changes nothing")
    }

    /// N3: the voice stop branch carries the same generation fence the generic branch has.
    @MainActor static func voiceStopKeepsTheGenerationFence() throws {
        let record = Recorder()
        let presence = NativePresence(effects: effects(record), now: { record.clock })
        presence.start(.app)
        presence.ready(presence.generation)
        let generation = presence.generation
        record.calls.removeAll()

        presence.endAfterHostTerminal(voiceStop: true, generation: generation &+ 3)
        try require(presence.state == .live, "a stale voice stop never ends a live session")
        try require(!record.calls.contains("goodbye"), "a stale voice stop never sounds the goodbye")

        presence.endAfterHostTerminal(voiceStop: true, generation: generation)
        try require(record.calls.contains("goodbye"), "the current voice stop sounds the goodbye")
        try require(presence.state == .cold, "the current voice stop ends cold")
    }

    /// Fix 2, the latch contract the conversation's interruption recovery re-checks after its await.
    @MainActor static func theLatchIsTheOwnerStart() throws {
        let latch = OwnerStopLatch()
        let seen = latch.epoch
        try require(latch.epoch == 0 && !latch.latched, "a fresh latch is open")
        try require(latch.allowsRestart(seenEpoch: seen), "a recovery with no stop behind it may restart")

        // A recovery that captured the epoch before its await and resumes after a stop.
        latch.ownerStopped()
        try require(latch.latched, "an owner stop latches")
        try require(latch.epoch == 1, "an owner stop moves the epoch")
        try require(!latch.allowsRestart(seenEpoch: seen), "a stop inside the await voids the restart")
        try require(!latch.allowsRestart(seenEpoch: latch.epoch), "the latch alone refuses every restart")

        latch.startRequested()
        try require(!latch.latched, "only the explicit Start clears the latch")
        try require(!latch.allowsRestart(seenEpoch: seen), "the epoch a stale recovery saw is still its past")
        try require(latch.allowsRestart(seenEpoch: latch.epoch), "a recovery starting now may restart")

        // A voice stop through the presence machine latches the same shared object.
        let record = Recorder()
        let shared = OwnerStopLatch()
        let presence = NativePresence(effects: effects(record), latch: shared, now: { record.clock })
        presence.start(.app)
        presence.ready(presence.generation)
        presence.stop(.voice)
        try require(shared.latched, "a voice stop latches the shared latch")
        try require(shared.epoch == 1, "a voice stop moves the shared epoch")
        presence.start(.app)
        try require(!shared.latched, "the next explicit Start clears the latch")
    }


    /// Acceptance 6: the auto-connected launch waits for the calendar connector, bounded at four seconds.
    @MainActor static func theCalendarWaitIsBounded() async throws {
        var elapsed = 0
        let early = await OrbFirstAutoConnect.waitForCalendar(
            published: { elapsed >= 2000 }, sleep: { ms in elapsed += ms })
        try require(early, "a connector that publishes after 2 s is waited for")
        try require(elapsed == 2000, "the wait costs exactly the publish time")

        var late = 0
        let expired = await OrbFirstAutoConnect.waitForCalendar(
            published: { late >= 6000 }, sleep: { ms in late += ms })
        try require(!expired, "a connector that publishes after 6 s is not waited for forever")
        try require(late == OrbFirstAutoConnect.calendarBoundMs,
            "the wait stops at the four second bound")
        try require(OrbFirstAutoConnect.calendarBoundMs == 4000, "the bound is four seconds")
    }

    /// Acceptance 4: a goodbye the device refuses is recorded, and the mic release is not delayed.
    @MainActor static func aRefusedGoodbyeIsRecorded() throws {
        final class RefusingOutput: ConnectingRingOutput {
            func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool { false }
            func playChime(_ buffer: AVAudioPCMBuffer) -> Bool { false }
            func stopOutput() {}
            func rampDown(overMs: Int, after: (@MainActor () -> Void)?) { after?() }
        }
        var records: [[String: Any]] = []
        let ring = ConnectingRing(output: RefusingOutput(), after: { _, _ in })
        ring.receipt = { records.append($0) }

        ring.goodbye()

        try require(records.count == 1, "a refusal records exactly one line")
        try require(records[0]["event"] as? String == "goodbye_tone", "the record is the goodbye")
        try require(records[0]["played"] as? Bool == false, "a refused goodbye did not play")
        try require(records[0]["reason"] as? String == "output_refused", "the reason names the player")
    }

    @MainActor static func effects(_ record: Recorder) -> PresenceEffects {
        PresenceEffects(
            openSession: { generation in record.opened.append(generation); record.calls.append("open") },
            cancelConnecting: { record.calls.append("cancelConnecting") },
            closeSession: { record.calls.append("close") },
            setCaptureMuted: { muted in record.calls.append("fence"); record.muted.append(muted) },
            cancelPlayback: { record.calls.append("cancelPlayback") },
            providerInputMute: { muted in record.calls.append("inputMute:\(muted)") },
            receipt: { record.receipts.append($0) },
            goodbyeTone: { record.calls.append("goodbye") },
            surface: { _ in })
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
