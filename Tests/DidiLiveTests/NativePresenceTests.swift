import Foundation

/// Presence model, council 2026-10-17 and the warm mute of 2026-10-22: the state machine
/// behind Right Command, the orb click and the app's mic control. Injected effects only, so
/// every transition is replayed here with no socket, no engine, no panel and no waiting.
@main struct NativePresenceTests {
    static func main() async {
        do {
            try await MainActor.run { try run() }
            print("PASS native presence: every transition, cancel while connecting, the held mute, "
                + "the generation fence, warm mute and resume, muted cold, sleep teardown, no capture before ready, receipts")
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
        var surfaces: [(PresenceState, Bool)] = []
        var clock: Double = 0
    }

    @MainActor static func run() throws {
        let record = Recorder()
        let presence = NativePresence(effects: PresenceEffects(
            openSession: { generation in record.opened.append(generation); record.calls.append("open") },
            cancelConnecting: { record.calls.append("cancelConnecting") },
            closeSession: { record.calls.append("close") },
            setCaptureMuted: { muted in record.calls.append("fence"); record.muted.append(muted) },
            cancelPlayback: { record.calls.append("cancelPlayback") },
            providerInputMute: { muted in record.calls.append("inputMute:\(muted)") },
            receipt: { record.receipts.append($0) },
            surface: { posture in record.surfaces.append((posture.state, posture.alwaysShow)) }), now: { record.clock })

        // COLD at start, with the presence orb the only surface.
        try require(presence.state == .cold && !presence.mutedHeld, "a fresh machine is cold and unmuted")

        // COLD -> CONNECTING, and nothing captures before the provider is ready.
        presence.toggle(.hotkey)
        try require(presence.state == .connecting, "a Right Command tap opens a session")
        try require(record.calls == ["open"], "opening captures nothing: no fence call before readiness")
        try require(record.muted.isEmpty, "no mic frame can be admitted while connecting")
        try require(record.opened == [presence.generation], "the session opens under the current generation")
        try require(record.receipts.last?["trigger"] as? String == "hotkey", "the receipt names the tap")

        // CONNECTING -> LIVE on readiness, and only now does the fence open.
        presence.ready(presence.generation)
        try require(presence.state == .live, "provider readiness moves connecting to live")
        try require(record.muted == [false], "the fence opens exactly once, at readiness")
        try require(record.receipts.last?["from"] as? String == "connecting"
            && record.receipts.last?["to"] as? String == "live", "the readiness receipt is complete")

        // A ready from any other generation opens nothing.
        presence.ready(presence.generation &- 1)
        try require(presence.state == .live && record.muted == [false], "a stale ready changes nothing")

        // LIVE -> MUTED: fence first, then the queued speech and the provider input, and the session stays.
        record.calls.removeAll()
        let warmGeneration = presence.generation
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted && presence.mutedHeld, "a second tap mutes")
        try require(record.calls == ["fence", "cancelPlayback", "inputMute:true"],
            "the fence closes first and the session is kept warm, got \(record.calls)")
        try require(record.muted == [false, true], "muting closes the fence")
        try require(presence.generation == warmGeneration && presence.mutedWarm,
            "a warm mute holds the generation and the session")

        // The end of a session the owner already left is stale: it never demotes the held mute.
        presence.sessionEnded(warmGeneration &- 1)
        try require(presence.state == .hotMuted && presence.mutedHeld,
            "the session's end after a mute keeps the owner on MUTED")

        // MUTED -> LIVE without connecting: the same session and generation listen again.
        record.calls.removeAll()
        let before = record.opened.count
        presence.tap(.click)
        try require(presence.state == .live && !record.calls.contains("open"),
            "an unmute inside the window resumes the same session, got \(record.calls)")
        try require(record.calls == ["fence", "inputMute:false"],
            "the resume opens the fence and lifts the provider input mute, got \(record.calls)")
        try require(record.muted.last == false && record.opened.count == before,
            "the mic opens again on the session that was kept")
        try require(presence.generation == warmGeneration, "the resume keeps the generation")

        // A mute older than the host's window never resumes: the tap connects.
        record.clock += NativePresence.warmWindow + 1
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted && presence.mutedWarm, "the third tap mutes warm again")
        record.clock += NativePresence.warmWindow + 1
        record.calls.removeAll()
        presence.tap(.hotkey)
        try require(presence.state == .connecting && !presence.mutedWarm,
            "a tap past the host's window connects instead of resuming a session nobody holds")
        try require(record.calls == ["open"], "the expired window opens exactly one session, got \(record.calls)")
        presence.ready(presence.generation)
        try require(presence.state == .live, "the new session's readiness opens the mic")

        // A warm mute, then the session dies while muted: muted cold, never an error.
        presence.tap(.hotkey)
        try require(presence.state == .hotMuted && presence.mutedWarm, "the fourth tap mutes warm again")
        record.calls.removeAll()
        presence.sessionEnded(presence.generation)
        try require(presence.state == .hotMuted && presence.mutedHeld && !presence.mutedWarm,
            "the session's own end while muted leaves the owner on a held, cold mute")
        try require(!presence.failed && record.calls.isEmpty,
            "a muted-cold session closes nothing and shows no error, got \(record.calls)")

        // MUTED-COLD -> CONNECTING: the next tap opens a new session, it never restores one that ended.
        record.calls.removeAll()
        let beforeCold = record.opened.count
        presence.tap(.click)
        try require(presence.state == .connecting, "a tap in MUTED opens a new session")
        try require(!presence.mutedHeld && record.calls == ["open"],
            "the muted tap opens a session and touches no fence yet, got \(record.calls)")
        try require(record.opened.count == beforeCold + 1 && record.opened.last == presence.generation,
            "the new session opens under the new generation")
        presence.ready(presence.generation)
        try require(presence.state == .live && record.muted.last == false, "readiness opens the mic again")

        // A stale failure names nothing: only the current generation can fail visibly.
        let live = presence.generation
        presence.fail(live &- 1)
        try require(presence.state == .live && !presence.failed, "a stale failure is ignored")
        presence.fail(live)
        try require(presence.state == .cold && presence.failed, "a current failure closes the session")
        try require(record.receipts.last?["trigger"] as? String == "error", "the failure receipt names the error")
        try require(presence.posture.failed, "the orb carries the error posture")

        // Cancel while connecting returns to COLD without ever opening the mic.
        record.muted.removeAll()
        presence.toggle(.click)
        try require(presence.state == .connecting, "a click opens a session from cold")
        presence.toggle(.click)
        try require(presence.state == .cold, "a tap while connecting cancels")
        try require(record.muted == [true], "a cancelled connect leaves the fence closed")
        try require(record.receipts.last?["trigger"] as? String == "click", "the cancel receipt names the click")

        // Sleep tears down from LIVE at once and never reconnects.
        presence.toggle(.hotkey)
        presence.ready(presence.generation)
        record.calls.removeAll()
        presence.sleep()
        try require(presence.state == .cold, "sleep tears the session down immediately")
        try require(record.calls == ["fence", "close"], "sleep closes the fence then the session, got \(record.calls)")
        try require(record.receipts.last?["trigger"] as? String == "sleep", "the sleep receipt names sleep")
        presence.sleep()
        try require(presence.state == .cold && record.calls.count == 2, "a second sleep changes nothing")

        // Sleep while connecting cancels the pending open.
        presence.toggle(.hotkey)
        record.calls.removeAll()
        presence.sleep()
        try require(presence.state == .cold, "sleep while connecting goes cold")
        try require(record.calls == ["close"], "sleep while connecting closes without touching the fence, got \(record.calls)")

        // The app's explicit mute and unmute only apply in the matching state.
        presence.mute(.app)
        try require(presence.state == .cold, "muting a cold machine changes nothing")
        presence.toggle(.hotkey)
        presence.ready(presence.generation)
        presence.unmute(.app)
        try require(presence.state == .live, "unmuting a live machine changes nothing")

        // "Always show Naya" is the only switch over the orb and never touches the state.
        record.surfaces.removeAll()
        presence.setAlwaysShow(false)
        try require(record.surfaces.count == 1 && record.surfaces[0].0 == .live && record.surfaces[0].1 == false,
            "hiding the orb re-renders the surface and never moves the state")

        for receipt in record.receipts {
            try require(receipt["event"] as? String == "presence_state", "every receipt is a presence_state event")
            try require(receipt["from"] is String && receipt["to"] is String && receipt["trigger"] is String,
                "every receipt carries from, to and trigger")
        }
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
