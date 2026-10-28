import AVFoundation
import Foundation

/// Issue #529: the connecting ring. The pad's seamless loop, the arrival chime, the stale start a
/// stop outruns, a warm unmute that plays nothing and a host rebuild that rings again are all
/// asserted with no engine, no microphone and no audio device.
@main struct ConnectingRingTests {
    static func main() async {
        do {
            try run()
            try await MainActor.run { try runWiring() }
            print("PASS connecting ring: seamless pad, three note chime, stale start dropped, no ring for muted to live, chime after the ramp, rebuild rings, engine released when it ends")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func run() throws {
        // Example 1: connecting for 4.0 s then live. The loop repeats the pair every 1.8 s, so the
        // pairs land at 0, 1.8 and 3.6 s, and live ramps it out with 4000 ms on the record.
        var s = ConnectingRingDirector()
        try require(s.transition(to: .connecting, failed: false, atMs: 0) == .beginStart(1),
            "entering connecting asks for a start")
        try require(s.commitStart(1) == .play, "the current start plays the loop")
        try require(s.transition(to: .live, failed: false, atMs: 4000) == .rampDown(reason: "live", ms: 4000),
            "live stops the ring and the record carries the length")

        // Example 2: connecting then failure to cold stops the ring, named as the failure.
        var failed = ConnectingRingDirector()
        _ = failed.transition(to: .connecting, failed: false, atMs: 0)
        _ = failed.commitStart(1)
        try require(failed.transition(to: .cold, failed: true, atMs: 900) == .rampDown(reason: "failed", ms: 900),
            "a failed connect stops the ring")
        try require(failed.transition(to: .cold, failed: true, atMs: 1000) == .none,
            "a second cold transition has no ring to stop")

        // #589: the goodbye is the arrival chime turned around: descending, softer, about 600 ms, and it
        // plays once on the ring's own player, which then stops so no device is held.
        let goodbye = ConnectingGoodbyeTone.samples()
        try require(ConnectingGoodbyeTone.lengthMs == 600, "the goodbye lasts 600 ms")
        try require(goodbye.count == ConnectingGoodbyeTone.totalFrames, "the goodbye buffer is its own length")
        try require(goodbye.map { abs($0) }.max()! <= 0.12, "the goodbye peaks at or under 0.12")
        let goodbyeOnsets = ConnectingGoodbyeTone.onsetFrames
        try require(ConnectingGoodbyeTone.noteFrequencies == ConnectingGoodbyeTone.noteFrequencies.sorted(by: >),
            "the goodbye descends")
        let firstNote = magnitude(window(goodbye, from: goodbyeOnsets[0] + 240, frames: 960),
                                  at: ConnectingGoodbyeTone.noteFrequencies[0])
        let lastBeforeOnset = magnitude(window(goodbye, from: goodbyeOnsets[2] - 480, frames: 240),
                                        at: ConnectingGoodbyeTone.noteFrequencies[2])
        try require(firstNote > lastBeforeOnset * 3, "the first bell sounds before the last one")
        // Example 3: a stop that lands while the start is still preparing. The token that a stop
        // outran must never play, and a later connect starts a fresh generation.
        var stale = ConnectingRingDirector()
        let begun = stale.transition(to: .connecting, failed: false, atMs: 0)
        guard case .beginStart(let token) = begun else {
            throw NSError(domain: "connecting must ask for a start, got \(begun)", code: 1)
        }
        try require(stale.transition(to: .live, failed: false, atMs: 40) == .none,
            "nothing is audible yet, so there is nothing to ramp")
        try require(stale.commitStart(token) == .discard, "a start that a stop outran plays nothing")
        let again = stale.transition(to: .connecting, failed: false, atMs: 5000)
        guard case .beginStart(let freshToken) = again, freshToken != token else {
            throw NSError(domain: "a fresh connect must start a new generation, got \(again)", code: 1)
        }
        try require(stale.commitStart(freshToken) == .play, "the fresh start plays")

        // Example 4: a warm unmute from muted to live never went through connecting, so no ring.
        var warm = ConnectingRingDirector()
        try require(warm.transition(to: .hotMuted, failed: false, atMs: 0) == .none,
            "muting never starts the ring")
        try require(warm.transition(to: .live, failed: false, atMs: 100) == .none,
            "a warm unmute without connecting plays nothing")
        try require(warm.transition(to: .connecting, failed: false, atMs: 200) == .beginStart(1),
            "the first real connect still starts the ring")

        // Example 5: the rendered loop. An A open fifth in detuned pairs, a high partial that
        // wobbles and one sonar ping, 2400 ms long, peak under 0.10, every voice a whole number of
        // cycles so the looping player wraps without a click.
        let samples = ConnectingRingTone.samples()
        try require(ConnectingRingTone.sampleRate == 24000, "the sound stays at 24 kHz")
        try require(ConnectingRingTone.loopMs == 2400, "the loop is 2400 ms")
        try require(ConnectingRingTone.loopFrames == 57600,
            "the loop is 57600 frames, got \(ConnectingRingTone.loopFrames)")
        try require(samples.count == ConnectingRingTone.loopFrames,
            "the loop renders its own frame count, got \(samples.count)")
        try require(ConnectingRingTone.stopRampMs == 30, "the stop ramps down over 30 ms")

        // Example 2: the peak. At or under 0.10, with nothing near clipping.
        let peak = samples.map { abs($0) }.max() ?? 0
        try require(peak <= 0.10 + 0.0001, "the ring peak stays at or under 0.10, got \(peak)")
        try require(peak > 0.09, "the pad is not silent, got \(peak)")

        // Example 1: the seam. Every voice completes whole cycles in the loop and the breath holds
        // both ends at silence, so the wrap has no step.
        let loopSeconds = ConnectingRingTone.loopSeconds
        for frequency in ConnectingRingTone.padFrequencies + [ConnectingRingTone.sparkleFrequency] {
            let cycles = frequency * loopSeconds
            try require(abs(cycles - cycles.rounded()) < 0.000001,
                "every voice completes whole cycles per loop, \(frequency) Hz gives \(cycles)")
        }
        try require(abs(samples[0]) < 0.001 && abs(samples[samples.count - 1]) < 0.001,
            "the loop starts and ends quietly")
        try require(abs(samples[0] - samples[samples.count - 1]) < 0.01,
            "the loop seam differs by under 0.01, got \(abs(samples[0] - samples[samples.count - 1]))")

        // The pad itself: an A open fifth in pairs under 1 Hz apart, a high partial, an upward ping.
        try require(ConnectingRingTone.padFrequencies.count == 6, "the pad has three paired voices")
        for (base, first) in [(220.0, 0), (330.0, 2), (440.0, 4)] {
            try require(abs(ConnectingRingTone.padFrequencies[first] - base) < 0.001,
                "the pad holds \(base) Hz")
            let detune = ConnectingRingTone.padFrequencies[first + 1] - base
            try require(detune > 0 && detune < 1,
                "the \(base) Hz pair is detuned by under 1 Hz, got \(detune)")
        }
        try require(ConnectingRingTone.sparkleFrequency >= 1300
            && ConnectingRingTone.sparkleFrequency <= 1800, "the sparkle sits at 1.3 to 1.8 kHz")
        try require(ConnectingRingTone.pingEndHz > ConnectingRingTone.pingStartHz,
            "the sonar ping glides upward")
        try require(ConnectingRingTone.pingStartMs + ConnectingRingTone.pingMs < ConnectingRingTone.loopMs,
            "the ping is over before the loop wraps")

        // Example 3: no mud. Energy below 150 Hz stays under one percent of the whole.
        let ringLow = lowBandShare(samples)
        try require(ringLow < 0.01, "the ring has no energy below 150 Hz, share \(ringLow)")

        // Example 4: the arrival chime. Three ascending bells 80 ms apart, decaying to silence,
        // peak under 0.14.
        let chime = ConnectingChimeTone.samples()
        try require(chime.count == ConnectingChimeTone.totalFrames,
            "the chime renders its own frame count, got \(chime.count)")
        let chimeMs = Double(chime.count) / ConnectingChimeTone.sampleRate * 1000
        try require(chimeMs >= 600 && chimeMs <= 900, "the chime lasts 600 to 900 ms, got \(chimeMs)")
        try require(ConnectingChimeTone.lengthMs == 760 && ConnectingChimeTone.fadeMs == 40,
            "the chime's length and release are pinned")
        let chimePeak = chime.map { abs($0) }.max() ?? 0
        try require(chimePeak <= 0.14 + 0.0001, "the chime peak stays at or under 0.14, got \(chimePeak)")
        try require(chimePeak > 0.13, "the chime is not silent, got \(chimePeak)")
        let chimeTail = chime[(chime.count - 480)...].map { abs($0) }.max() ?? 0
        try require(chimeTail < 0.005, "the chime's last 20 ms stay under 0.005, got \(chimeTail)")
        try require(abs(chime[chime.count - 1]) < 0.001, "the chime ends at silence")
        try require(lowBandShare(chime) < 0.01, "the chime has no energy below 150 Hz")

        // Three onsets, ascending in pitch: each bell sounds from its own onset, and the notes ascend.
        let onsets = ConnectingChimeTone.onsetFrames
        let notes = ConnectingChimeTone.noteFrequencies
        try require(onsets.count == 3 && notes.count == 3, "the chime strikes three bells")
        try require(onsets[0] < onsets[1] && onsets[1] < onsets[2], "the bells are struck in order")
        try require(notes[0] < notes[1] && notes[1] < notes[2], "the bells ascend in pitch")
        for (index, note) in notes.enumerated() {
            let before = index == 0
                ? window(chime, from: chime.count - 960, frames: 960)
                : window(chime, from: onsets[index] - 960, frames: 960)
            let struck = magnitude(window(chime, from: onsets[index] + 240, frames: 960), at: note)
            try require(struck > magnitude(before, at: note) * 3,
                "bell \(index + 1) sounds only from its onset, at \(note) Hz")
        }

        // The one native record per ring.
        let record = ConnectingRingRecord(startedAt: 1_700_000_000_000,
                                          stoppedAt: 1_700_000_004_000, reason: "live",
                                          played: true, chime: true)
        try require(record.ms == 4000, "the record counts the ring's length, got \(record.ms)")
        try require(record.fields["played"] as? Bool == true && record.fields["chime"] as? Bool == true,
            "the record says the ring and the chime actually played")
        try require(record.fields["event"] as? String == "connecting_ring", "the record names itself")
        try require(record.fields["reason"] as? String == "live", "the record names the ending state")
        try require(record.fields["started_at"] as? Int == 1_700_000_000_000,
            "the record carries the start")
        try require(record.fields["stopped_at"] as? Int == 1_700_000_004_000,
            "the record carries the stop")
    }

    /// The same presence transitions through the real entry point, with a fake clock and a fake
    /// output, so the play, the ramp and the record are pinned and not just the director's return.
    @MainActor static func runWiring() throws {
        // Alarm policy has no OS calls in this fixture: power, notifications and audio are injected.
        var acquired = 0, released = 0
        var registered: [String] = [], removed: [String] = []
        let alarms = AlarmShellPolicy(acquire: { acquired += 1; return true }, release: { released += 1 },
            register: { registered.append($0.id) }, remove: { removed.append($0) })
        let pending = ShellAlarm(id: "synthetic", fireAtUtc: 60_000, tz: "UTC", state: "pending", ringDeadlineUtc: nil)
        alarms.apply([pending], notificationsAllowed: true)
        alarms.apply([pending], notificationsAllowed: true)
        try require(acquired == 1 && registered == ["synthetic"], "pending alarm acquires once and registers once")
        alarms.apply([ShellAlarm(id: "synthetic", fireAtUtc: 60_000, tz: "UTC", state: "ringing", ringDeadlineUtc: 660_000)], notificationsAllowed: true)
        try require(removed == ["synthetic"] && released == 0, "ringing removes notification but holds power assertion")
        alarms.apply([], notificationsAllowed: true)
        try require(released == 1, "last alarm releases power assertion")
        let alarmClock = TestClock()
        let alarmOutput = RecordingRingOutput()
        var alarmWaits: [(Int, @MainActor () -> Void)] = []
        let alarmRing = ConnectingRing(output: alarmOutput, now: { alarmClock.ms }, deferStart: { $0() }, after: { alarmWaits.append(($0, $1)) })
        alarmRing.startAlarm(deadlineMs: 600_000)
        alarmRing.startAlarm(deadlineMs: 600_000)
        try require(alarmOutput.chimes == 1, "duplicate due frames cannot stack chimes")
        alarmClock.ms = 45_000
        let repeatAlarm = alarmWaits.first { $0.0 == 45_000 }!
        repeatAlarm.1()
        try require(alarmOutput.chimes == 2, "alarm repeats through the same injected output without rebuilding engine")
        alarmRing.stopAlarm()
        let stoppedCount = alarmOutput.chimes
        alarmClock.ms = 90_000
        alarmWaits.last { $0.0 == 45_000 }?.1()
        try require(alarmOutput.chimes == stoppedCount, "stopped alarm cannot be restarted by stale repeat")
        // Example 1: connecting for 4.0 s then live plays once, ramps once over 30 ms, and leaves
        // one record with 4000 ms.
        let clock = TestClock()
        let output = RecordingRingOutput()
        var records: [[String: Any]] = []
        var pending: [@MainActor () -> Void] = []
        let ring = ConnectingRing(output: output, now: { clock.ms }, deferStart: { body in body() },
                                  after: { _, body in pending.append(body) })
        ring.receipt = { records.append($0) }
        ring.presenceChanged(.connecting, failed: false)
        try require(output.plays == 1, "connecting starts the loop once, got \(output.plays)")
        clock.ms = 4000
        ring.presenceChanged(.live, failed: false)
        try require(output.ramps == [ConnectingRingTone.stopRampMs],
            "live ramps the ring out over 30 ms, got \(output.ramps)")
        try require(records.count == 2, "a ring that chimed leaves its ring record and its chime receipt, got \(records.count)")
        try require(records[0]["event"] as? String == "connecting_ring", "the record names itself")
        try require(records[0]["ms"] as? Int == 4000,
            "the record counts 4000 ms, got \(String(describing: records[0]["ms"]))")
        try require(records[0]["reason"] as? String == "live", "the record names live")
        try require(records[0]["started_at"] as? Int == 0 && records[0]["stopped_at"] as? Int == 4000,
            "the record carries the start and the stop")
        try require(output.chimes == 1, "live plays the connected chime once, got \(output.chimes)")
        try require(output.order == ["ring", "ramp", "chime"],
            "the chime follows the ring's ramp, got \(output.order)")
        // F1: the chime's own stop is scheduled, and firing it releases the player and the engine.
        try require(pending.count == 1, "one chime stop is scheduled, got \(pending.count)")
        try require(output.engineRunning, "the chime holds the player while it plays")
        pending.removeFirst()()
        try require(output.stopCalls == 1 && !output.engineRunning,
            "the chime's stop runs once and the engine is released, got \(output.stopCalls) stop(s)")
        // A second call's call-start reading sees no Didi engine: the device is free again.
        let callStartBusy = output.engineRunning
        try require(!callStartBusy, "a second call's call-start reading sees the device free")
        try require(records[0]["played"] as? Bool == true, "the record says the ring played")
        try require(records[0]["chime"] as? Bool == true, "the record says the chime played")
        // L12c: the chime's own receipt, next to the ring's, so a quiet call can say whether it ever heard it.
        try require(records[1]["event"] as? String == "connecting_chime", "the chime leaves its own receipt")
        try require(records[1]["played"] as? Bool == true, "the receipt says the chime played")
        try require(records[1]["reason"] == nil, "a chime that played carries no refusal reason")
        try require(Set(records[1].keys) == ["event", "played"], "the played receipt is a closed shape")

        // Example 2: connecting then failure to cold ramps out with reason failed.
        let failedClock = TestClock()
        let failedOutput = RecordingRingOutput()
        var failedRecords: [[String: Any]] = []
        let failedRing = ConnectingRing(output: failedOutput, now: { failedClock.ms },
                                        deferStart: { body in body() })
        failedRing.receipt = { failedRecords.append($0) }
        failedRing.presenceChanged(.connecting, failed: false)
        failedClock.ms = 900
        failedRing.presenceChanged(.cold, failed: true)
        try require(failedOutput.ramps == [ConnectingRingTone.stopRampMs],
            "the failed connect ramps the ring out")
        try require(failedRecords.first?["reason"] as? String == "failed",
            "the record names the failure, got \(String(describing: failedRecords.first?["reason"]))")
        try require(failedRecords.first?["ms"] as? Int == 900, "the failed ring is 900 ms")
        try require(failedOutput.chimes == 0, "a failed connect plays no chime")
        try require(!failedOutput.engineRunning && failedOutput.stopCalls == 0,
            "a failed connect leaves no engine running and schedules no chime stop")
        try require(failedRecords.first?["chime"] as? Bool == false &&
                    failedRecords.first?["played"] as? Bool == true,
            "the failed ring played and chimed nothing")
        try require(failedRecords.count == 1, "a connect that never chimed leaves only its ring record")

        // A presence edge inside the ramp means the chime was never owed: it says so, and plays nothing.
        let movedOutput = RecordingRingOutput()
        movedOutput.completesRamp = false
        var movedRecords: [[String: Any]] = []
        let movedRing = ConnectingRing(output: movedOutput, now: { 0 }, deferStart: { body in body() },
                                        after: { _, _ in })
        movedRing.receipt = { movedRecords.append($0) }
        movedRing.presenceChanged(.connecting, failed: false)
        movedRing.presenceChanged(.live, failed: false)
        movedRing.presenceChanged(.connecting, failed: false)
        movedOutput.pendingRamp?()
        try require(movedOutput.chimes == 0, "the chime of a superseded ramp never plays")
        try require(movedRecords.count == 2 && movedRecords[1]["event"] as? String == "connecting_chime"
            && movedRecords[1]["played"] as? Bool == false
            && movedRecords[1]["reason"] as? String == "token_mismatch",
            "the superseded chime records played=false and token_mismatch, got \(movedRecords.map { $0["event"] as? String ?? "?" })")

        // Example 3: a stop that lands while the start is still preparing never reaches the output.
        let staleClock = TestClock()
        let staleOutput = RecordingRingOutput()
        var held: (@MainActor () -> Void)?
        var staleRecords: [[String: Any]] = []
        let staleRing = ConnectingRing(output: staleOutput, now: { staleClock.ms },
                                       deferStart: { body in held = body })
        staleRing.receipt = { staleRecords.append($0) }
        staleRing.presenceChanged(.connecting, failed: false)
        staleClock.ms = 40
        staleRing.presenceChanged(.live, failed: false)
        held?()
        try require(staleOutput.plays == 0, "a start that a stop outran never reaches the output")
        try require(staleOutput.ramps.isEmpty, "nothing was audible, so nothing ramps")
        try require(staleRecords.isEmpty, "a ring that never played leaves no record")

        // Example 4: muted to live never starts the ring and leaves no record.
        let warmClock = TestClock()
        let warmOutput = RecordingRingOutput()
        var warmRecords: [[String: Any]] = []
        let warmRing = ConnectingRing(output: warmOutput, now: { warmClock.ms },
                                      deferStart: { body in body() })
        warmRing.receipt = { warmRecords.append($0) }
        warmRing.presenceChanged(.hotMuted, failed: false)
        warmClock.ms = 100
        warmRing.presenceChanged(.live, failed: false)
        try require(warmOutput.plays == 0 && warmOutput.ramps.isEmpty, "a warm unmute plays nothing")
        try require(warmOutput.chimes == 0, "a warm unmute plays no connected chime")
        try require(!warmOutput.engineRunning && warmOutput.stopCalls == 0,
            "a warm unmute leaves no engine running and stops nothing")
        try require(warmRecords.isEmpty, "a warm unmute leaves no record")

        // Example 5: the ring's own player refuses to start, so the record says it never played.
        let deafClock = TestClock()
        let deafOutput = RecordingRingOutput()
        deafOutput.playResult = false
        var deafRecords: [[String: Any]] = []
        let deafRing = ConnectingRing(output: deafOutput, now: { deafClock.ms },
                                      deferStart: { body in body() })
        deafRing.receipt = { deafRecords.append($0) }
        deafRing.presenceChanged(.connecting, failed: false)
        deafClock.ms = 1200
        deafRing.presenceChanged(.live, failed: false)
        try require(deafRecords.count == 2 && deafRecords[0]["played"] as? Bool == false,
            "a ring whose player refused to start records played=false, got \(deafRecords.count) records")
        try require(deafOutput.chimes == 1 && deafRecords[0]["chime"] as? Bool == true,
            "the connected chime does not depend on the ring's own start")

        // Example 6: the chime's engine refuses to start, so the record says the chime did not play.
        let muteClock = TestClock()
        let muteOutput = RecordingRingOutput()
        muteOutput.chimeResult = false
        var muteRecords: [[String: Any]] = []
        var mutePending: [@MainActor () -> Void] = []
        let muteRing = ConnectingRing(output: muteOutput, now: { muteClock.ms },
                                      deferStart: { body in body() },
                                      after: { _, body in mutePending.append(body) })
        muteRing.receipt = { muteRecords.append($0) }
        muteRing.presenceChanged(.connecting, failed: false)
        muteClock.ms = 500
        muteRing.presenceChanged(.live, failed: false)
        try require(muteRecords.count == 2 && muteRecords[0]["chime"] as? Bool == true,
            "the record still names the connected chime this ring asked for")
        try require(mutePending.isEmpty && !muteOutput.engineRunning,
            "a chime that could not start schedules no stop and leaves no engine")
        try require(muteRecords.count == 2 && muteRecords[1]["event"] as? String == "connecting_chime"
            && muteRecords[1]["played"] as? Bool == false
            && muteRecords[1]["reason"] as? String == "output_refused",
            "L12c: a chime the player refused records played=false and output_refused, got \(String(describing: muteRecords.last))")
        try require(Set(muteRecords[1].keys) == ["event", "played", "reason"],
            "the refused receipt is a closed shape")

        // Example 7: a stop lands mid-chime. The chime's own stop still runs exactly once and the
        // player and engine are released, so Didi holds no output device between calls.
        let midClock = TestClock()
        let midOutput = RecordingRingOutput()
        var midRecords: [[String: Any]] = []
        var midPending: [@MainActor () -> Void] = []
        let midRing = ConnectingRing(output: midOutput, now: { midClock.ms },
                                     deferStart: { body in body() },
                                     after: { _, body in midPending.append(body) })
        midRing.receipt = { midRecords.append($0) }
        midRing.presenceChanged(.connecting, failed: false)
        midClock.ms = 600
        midRing.presenceChanged(.live, failed: false)
        try require(midOutput.engineRunning && midPending.count == 1,
            "the chime is playing with its stop pending")
        midClock.ms = 700
        midRing.presenceChanged(.cold, failed: false)
        midPending.removeFirst()()
        try require(midOutput.stopCalls == 1 && !midOutput.engineRunning,
            "a stop during the chime stops the pair once, got \(midOutput.stopCalls) stop(s)")
        try require(midOutput.order.filter { $0 == "chime" }.count == 1,
            "the chime plays once, got \(midOutput.order)")
        try require(midRecords.count == 2 && midRecords[0]["chime"] as? Bool == true,
            "the record still names the chime that played")
        try require(midRecords[1]["event"] as? String == "connecting_chime" && midRecords[1]["played"] as? Bool == true,
            "the chime's own receipt survives a stop that lands mid-chime")

        // F2: a presence edge inside the 30 ms ramp cancels the ramp's completion, and the record
        // must still land: it is written before the ramp starts, as it was before the chime existed.
        let bounceClock = TestClock()
        let bounceOutput = RecordingRingOutput()
        bounceOutput.completesRamp = false
        var bounceRecords: [[String: Any]] = []
        let bounceRing = ConnectingRing(output: bounceOutput, now: { bounceClock.ms },
                                        deferStart: { body in body() },
                                        after: { _, _ in })
        bounceRing.receipt = { bounceRecords.append($0) }
        bounceRing.presenceChanged(.connecting, failed: false)
        bounceClock.ms = 4000
        bounceRing.presenceChanged(.live, failed: false)
        try require(bounceRecords.count == 1 && bounceRecords[0]["reason"] as? String == "live"
            && bounceRecords[0]["ms"] as? Int == 4000,
            "the record lands even when the ramp never completes, got \(bounceRecords.count)")
        bounceRing.presenceChanged(.connecting, failed: false)

        // SOUND-R1: a dropped call the host rebuilds rings the reconnect, and the call going live
        // again plays the arrival chime. A mute and an unmute never ring.
        let rebuildClock = TestClock()
        let rebuildOutput = RecordingRingOutput()
        var rebuildRecords: [[String: Any]] = []
        var rebuildPending: [@MainActor () -> Void] = []
        let rebuildRing = ConnectingRing(output: rebuildOutput, now: { rebuildClock.ms },
                                         deferStart: { body in body() },
                                         after: { _, body in rebuildPending.append(body) })
        rebuildRing.receipt = { rebuildRecords.append($0) }
        rebuildRing.presenceChanged(.connecting, failed: false)
        rebuildClock.ms = 5700
        rebuildRing.presenceChanged(.live, failed: false)
        rebuildPending.removeFirst()()
        let playsBefore = rebuildOutput.plays
        let chimesBefore = rebuildOutput.chimes
        rebuildClock.ms = 60000
        rebuildRing.presenceChanged(.hotMuted, failed: false)
        rebuildRing.presenceChanged(.live, failed: false)
        try require(rebuildOutput.plays == playsBefore && rebuildOutput.chimes == chimesBefore,
            "a mute and an unmute never ring and never chime")

        // The drop: the host announces a rebuild, so the loop plays again from that moment.
        rebuildRing.rebuildStarted()
        try require(rebuildOutput.plays == playsBefore + 1,
            "a host rebuild rings again, got \(rebuildOutput.plays) plays")
        // The rebuild settles live: a 30 ms ramp, then the arrival chime behind it.
        let rampsBefore = rebuildOutput.ramps.count
        rebuildClock.ms = 63000
        rebuildRing.rebuildSettled()
        try require(rebuildOutput.ramps.count == rampsBefore + 1
            && rebuildOutput.ramps.last == ConnectingRingTone.stopRampMs,
            "a rebuilt ring ramps out over 30 ms, got \(rebuildOutput.ramps)")
        let settleRecord = rebuildRecords.last { $0["event"] as? String == "connecting_ring" }
        try require(settleRecord?["reason"] as? String == "live"
            && settleRecord?["ms"] as? Int == 3000,
            "the rebuild's record names the live ending and its 3000 ms")
        try require(rebuildOutput.chimes == chimesBefore + 1,
            "a rebuilt call that is live again plays the chime, got \(rebuildOutput.chimes)")
        try require(rebuildPending.count == 1, "the chime's own stop is queued behind it")
        rebuildPending.removeFirst()()

        // A rebuild that ends: the cold presence record ramps the ring out and owes no chime.
        rebuildClock.ms = 70000
        rebuildRing.rebuildStarted()
        let chimesAtEnd = rebuildOutput.chimes
        let rampsAtEnd = rebuildOutput.ramps.count
        rebuildClock.ms = 71500
        rebuildRing.presenceChanged(.cold, failed: false)
        try require(rebuildOutput.ramps.count == rampsAtEnd + 1 && rebuildPending.isEmpty,
            "an ended rebuild ramps out and schedules nothing after the ramp")
        try require(rebuildOutput.chimes == chimesAtEnd,
            "an ended rebuild plays no chime, got \(rebuildOutput.chimes)")
        let endRecord = rebuildRecords.last { $0["event"] as? String == "connecting_ring" }
        try require(endRecord?["reason"] as? String == "cold"
            && endRecord?["chime"] as? Bool == false,
            "the ended rebuild's record names the cold ending and no chime")



        // #589: the goodbye plays once on the ring's own player and then releases it.
        let goodbyeOutput = RecordingRingOutput()
        var goodbyeStops: [@MainActor () -> Void] = []
        let goodbyeRing = ConnectingRing(output: goodbyeOutput, now: { 0 }, deferStart: { body in body() },
                                         after: { _, body in goodbyeStops.append(body) })
        goodbyeRing.goodbye()
        try require(goodbyeOutput.chimes == 1, "the goodbye plays once, got \(goodbyeOutput.chimes)")
        try require(goodbyeOutput.plays == 0, "the goodbye is one shot, never the ring's loop")
        try require(goodbyeStops.count == 1, "one stop is scheduled past the goodbye")
        goodbyeStops.removeFirst()()
        try require(goodbyeOutput.stopCalls == 1 && !goodbyeOutput.engineRunning,
            "the goodbye releases the player and the engine when it ends")
    }

    /// Stands in for the ring's own player, so no engine and no audio device is started. It models
    /// the one thing the ruling cares about: whether the player and its engine are running.
    @MainActor final class RecordingRingOutput: ConnectingRingOutput {
        private(set) var plays = 0
        private(set) var chimes = 0
        private(set) var ramps: [Int] = []
        /// The player calls in order, so the chime is proven to follow the ring's ramp.
        private(set) var order: [String] = []
        /// The player and engine are running, as the device-busy reading would see them.
        private(set) var engineRunning = false
        /// The chime's own stop: `stopOutput` calls.
        private(set) var stopCalls = 0
        /// The ramp-down's own player.stop(); engine.stop() pair.
        private(set) var rampStops = 0
        var playResult = true
        var chimeResult = true
        /// False models a ramp that never completes, cancelled by a presence edge inside it.
        var completesRamp = true
        func playLoop(_ buffer: AVAudioPCMBuffer) -> Bool {
            plays += 1
            order.append("ring")
            if playResult { engineRunning = true }
            return playResult
        }
        func playChime(_ buffer: AVAudioPCMBuffer) -> Bool {
            chimes += 1
            order.append("chime")
            if chimeResult { engineRunning = true }
            return chimeResult
        }
        func stopOutput() {
            stopCalls += 1
            order.append("stop")
            engineRunning = false
        }
        func rampDown(overMs ms: Int, after: (@MainActor () -> Void)?) {
            ramps.append(ms)
            order.append("ramp")
            guard completesRamp else { pendingRamp = after; return }
            rampStops += 1
            engineRunning = false
            after?()
        }
        /// A ramp the test completes by hand, so a presence edge can land inside it.
        private(set) var pendingRamp: (@MainActor () -> Void)?
    }

    @MainActor final class TestClock { var ms = 0 }

    /// A window of samples, clamped to the buffer.
    static func window(_ samples: [Float], from start: Int, frames: Int) -> ArraySlice<Float> {
        let low = min(max(start, 0), samples.count)
        return samples[low..<min(low + frames, samples.count)]
    }

    /// One frequency's Hann windowed magnitude over a window: enough to prove an onset without a
    /// full transform.
    static func magnitude(_ slice: ArraySlice<Float>, at frequency: Double) -> Double {
        var real = 0.0
        var imaginary = 0.0
        for (offset, sample) in slice.enumerated() {
            let envelope = 0.5 - 0.5 * cos(2 * Double.pi * Double(offset) / Double(slice.count))
            let angle = 2 * Double.pi * frequency * Double(offset) / ConnectingRingTone.sampleRate
            real += Double(sample) * envelope * cos(angle)
            imaginary -= Double(sample) * envelope * sin(angle)
        }
        return (real * real + imaginary * imaginary).squareRoot()
    }

    /// The share of the sound's energy below `cutoff` Hz, over its first second. The signal is
    /// block averaged down to a 3 kHz rate first, which keeps the Goertzel sweep cheap and puts the
    /// band on a 1 Hz grid. A 60 Hz tone at 0.05 already reads 0.63.
    static func lowBandShare(_ samples: [Float], below cutoff: Double = 150) -> Double {
        let analysed = min(samples.count, Int(ConnectingRingTone.sampleRate))
        let block = 8
        var averaged: [Double] = []
        averaged.reserveCapacity(analysed / block)
        var index = 0
        while index + block <= analysed {
            var sum = 0.0
            for offset in 0..<block { sum += Double(samples[index + offset]) }
            averaged.append(sum / Double(block))
            index += block
        }
        let count = averaged.count
        var energy = 0.0
        for offset in 0..<count {
            let envelope = 0.5 - 0.5 * cos(2 * Double.pi * Double(offset) / Double(count))
            let value = averaged[offset] * envelope
            averaged[offset] = value
            energy += value * value
        }
        let total = Double(count) * energy
        let bins = Int(cutoff * Double(count) / (ConnectingRingTone.sampleRate / Double(block)))
        var low = 0.0
        for bin in 1...bins {
            let coefficient = 2 * cos(2 * Double.pi * Double(bin) / Double(count))
            var previous = 0.0
            var prior = 0.0
            for value in averaged {
                let current = value + coefficient * previous - prior
                prior = previous
                previous = current
            }
            low += previous * previous + prior * prior - coefficient * previous * prior
        }
        return 2 * low / total
    }

    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: message, code: 1) }
    }
}
