import Foundation

/// Presence model, council 2026-10-17 (option C): the state machine behind Right
/// Command, the orb click and the app's mic control. An injected clock and injected
/// effects only, so every transition is replayed here with no socket, no engine,
/// no panel and no waiting.
@main struct NativePresenceTests {
    static func main() async {
        do {
            try await MainActor.run { try run() }
            print("PASS native presence: every transition, cancel while connecting, the 5 minute drop, "
                + "sleep teardown, no capture before ready, receipts")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    @MainActor final class Clock: @unchecked Sendable { var t: TimeInterval = 100 }

    @MainActor final class Recorder {
        var calls: [String] = []
        var muted: [Bool] = []
        var receipts: [[String: Any]] = []
        var surfaces: [(PresenceState, Bool)] = []
    }

    @MainActor static func run() throws {
        let clock = Clock()
        let record = Recorder()
        let presence = NativePresence(now: { clock.t }, effects: PresenceEffects(
            openSession: { record.calls.append("open") },
            cancelConnecting: { record.calls.append("cancelConnecting") },
            closeSession: { record.calls.append("close") },
            setCaptureMuted: { muted in record.calls.append("fence"); record.muted.append(muted) },
            cancelPlayback: { record.calls.append("cancelPlayback") },
            providerInputMute: { muted in record.calls.append("inputMute:\(muted)") },
            receipt: { record.receipts.append($0) },
            surface: { posture in record.surfaces.append((posture.state, posture.alwaysShow)) }))

        // COLD at start, with the presence orb shown.
        try require(presence.state == .cold, "the machine starts cold")
        try require(presence.alwaysShow, "Always show Naya is on by default")
        try require(presence.dropDeadline == nil, "no grace deadline while cold")

        // COLD -> CONNECTING, and nothing captures before the provider is ready.
        presence.toggle(.hotkey)
        try require(presence.state == .connecting, "a Right Command tap opens a session")
        try require(record.calls == ["open"], "opening captures nothing: no fence call before readiness")
        try require(record.muted.isEmpty, "no mic frame can be admitted while connecting")
        try require(record.receipts.last?["trigger"] as? String == "hotkey", "the receipt names the tap")

        // CONNECTING -> LIVE on readiness, and only now does the fence open.
        presence.ready()
        try require(presence.state == .live, "provider readiness moves connecting to live")
        try require(record.muted == [false], "the fence opens exactly once, at readiness")
        try require(record.receipts.last?["from"] as? String == "connecting"
            && record.receipts.last?["to"] as? String == "live", "the readiness receipt is complete")

        // LIVE -> HOT_MUTED: fence first, then the queued speech is dropped and the provider is told.
        record.calls.removeAll()
        presence.toggle(.hotkey)
        try require(presence.state == .hotMuted, "a second tap mutes")
        try require(record.calls == ["fence", "cancelPlayback", "inputMute:true"],
            "the fence closes before playback is cancelled, got \(record.calls)")
        try require(record.muted == [false, true], "muting closes the fence")
        try require(presence.dropDeadline == clock.t + NativePresence.hotMutedGrace,
            "the drop deadline is the monotonic grace from the mute instant")

        // HOT_MUTED -> LIVE: instant, and the session was never closed.
        record.calls.removeAll()
        presence.toggle(.click)
        try require(presence.state == .live, "the third tap listens again")
        try require(record.calls == ["fence", "inputMute:false"], "unmuting opens the fence at once, got \(record.calls)")
        try require(!record.calls.contains("open") && !record.calls.contains("close"),
            "a hot-muted session is never reopened")
        try require(presence.dropDeadline == nil, "listening clears the grace deadline")

        // The five minute drop, on the injected clock.
        presence.mute(.app)
        clock.t += NativePresence.hotMutedGrace - 1
        presence.tick()
        try require(presence.state == .hotMuted, "one second short of five minutes stays hot-muted")
        clock.t += 1
        record.calls.removeAll()
        presence.tick()
        try require(presence.state == .cold, "five minutes of silence drops the session to cold")
        try require(record.calls == ["fence", "close"], "the grace teardown closes the fence then the session, got \(record.calls)")
        try require(record.receipts.last?["trigger"] as? String == "timer", "the drop receipt names the timer")

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
        presence.ready()
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

        // A route failure while live fails loud: error posture, session closed.
        presence.toggle(.hotkey)
        presence.ready()
        presence.fail()
        try require(presence.state == .cold, "a route failure closes the session rather than re-routing")
        try require(record.receipts.last?["trigger"] as? String == "error", "the failure receipt names the error")

        // The app's explicit mute and unmute only apply in the matching state.
        presence.mute(.app)
        try require(presence.state == .cold, "muting a cold machine changes nothing")
        presence.toggle(.hotkey)
        presence.ready()
        presence.unmute(.app)
        try require(presence.state == .live, "unmuting a live machine changes nothing")

        // "Always show Naya" is the only switch over the orb and never touches the state.
        record.surfaces.removeAll()
        presence.setAlwaysShow(false)
        try require(record.surfaces.count == 1 && record.surfaces[0].0 == .live && record.surfaces[0].1 == false,
            "hiding the orb re-renders the surface without a transition")
        presence.setAlwaysShow(false)
        try require(record.surfaces.count == 1, "an unchanged setting re-renders nothing")
        presence.setAlwaysShow(true)
        try require(presence.state == .live, "the setting never changes the state")

        // Every receipt is the same shape: a native-owned presence_state event.
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
