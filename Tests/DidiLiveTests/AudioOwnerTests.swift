import AVFoundation
import Foundation

/// Fake-seam proofs for the single audio owner: a second request is refused with a typed error,
/// the cross-process flock is non-blocking, and every lifecycle record is timestamped.
@main struct AudioOwnerTests {
    @MainActor static func main() async {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }
        func tempLockURL() -> URL {
            URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("a1-owner-\(UUID().uuidString)")
        }

        // 1. A second request is refused, never queued behind the running engine.
        do {
            let owner = AudioOwner(lockFileURL: tempLockURL())
            let first = ObjectIdentifier(NSObject())
            let second = ObjectIdentifier(NSObject())
            try owner.acquire(holder: first)
            check(owner.isOwned, "first acquire owns the single slot")
            var refused = false
            do { try owner.acquire(holder: second) }
            catch AudioOwnerError.alreadyOwned { refused = true } catch {}
            check(refused, "second acquire refused with the typed alreadyOwned error")
            check(owner.refusals == 1 && owner.holder == first, "refusal counted and first holder retained")
            owner.release(holder: first)
            check(!owner.isOwned && !owner.crossProcessHeld, "release frees the slot and the flock")
            try owner.acquire(holder: second)
            check(owner.holder == second, "a later request is admitted after release")
            owner.releaseAll()
        } catch { check(false, "same-process owner sequence threw \(error)") }

        // 2. Cross-process: a child process holding the flock refuses the owner. flock() is
        // per open file description, so a same-process second owner does not prove anything.
        if FileManager.default.isExecutableFile(atPath: "/usr/bin/env") {
            do {
                let lockURL = tempLockURL()
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                child.arguments = ["python3", "-c",
                    "import fcntl,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(30)",
                    lockURL.path]
                let pipe = Pipe()
                child.standardOutput = pipe
                child.standardError = FileHandle.nullDevice
                try child.run()
                // Block on the child's readiness line, never a clock.
                let ready = pipe.fileHandleForReading.readData(ofLength: 6)
                guard ready == Data("ready\n".utf8) else {
                    child.terminate(); child.waitUntilExit()
                    check(false, "flock child did not signal readiness")
                    exit(failures == 0 ? 0 : 1)
                }
                let owner = AudioOwner(lockFileURL: lockURL)
                var refused = false
                do { try owner.acquire(holder: ObjectIdentifier(NSObject())) }
                catch AudioOwnerError.alreadyInUse { refused = true } catch {}
                check(refused && !owner.isOwned, "a child process holding the flock refuses Didi's audio")
                child.terminate()
                child.waitUntilExit()
                // Once the child dies the kernel drops its lock and the owner is admitted.
                try owner.acquire(holder: ObjectIdentifier(NSObject()))
                check(owner.crossProcessHeld, "the flock is free once the holder process exits")
                owner.releaseAll()
            } catch { check(false, "cross-process flock sequence threw \(error)") }
        }

        // 3. The flock failure seam surfaces alreadyInUse without touching AVAudioEngine.
        do {
            let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: "/dev/null"),
                                   openLock: { _ in 7 }, flockFn: { _, _ in -1 }, closeFn: { _ in 0 })
            var refused = false
            do { try owner.acquire(holder: ObjectIdentifier(NSObject())) }
            catch AudioOwnerError.alreadyInUse { refused = true } catch {}
            check(refused && !owner.isOwned, "a denied flock refuses before any engine exists")
        }

        // 4. One engine start per lease and a timestamped journal entry for every event.
        do {
            let journal = NativeAudioJournal(fileURL: nil)
            let owner = AudioOwner(lockFileURL: tempLockURL(), journal: journal)
            // Both owners stay alive for the whole case: two temporary NSObjects can share an address,
            // which would make the stranger the same holder and quietly pass for the wrong reason.
            let holderObject = NSObject(), strangerObject = NSObject()
            let holder = ObjectIdentifier(holderObject)
            try owner.acquire(holder: holder)
            owner.didStartEngine(holder: holder)
            owner.didStartEngine(holder: ObjectIdentifier(strangerObject))
            check(owner.engineStarts == 1, "only the current holder may record an engine start")
            owner.release(holder: holder)
            let recorded = journal.events
            check(recorded.contains { $0.name == "audio_owned" }, "acquire records audio_owned")
            check(recorded.contains { $0.name == "audio_released" }, "release records audio_released")
            check(recorded.allSatisfy { $0.at.timeIntervalSince1970 > 0 },
                  "every lifecycle record is stamped with the clock time it happened")
        } catch { check(false, "journal sequence threw \(error)") }

        // 5. #477: one audio journal per process. A second adopt hands back the journal in use, so the
        // caller wires its device to that one instead of opening a second writer on audio.log.
        do {
            let directory = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("a1-adopt-\(UUID().uuidString)")
            let file = directory.appendingPathComponent("audio.log")
            let first = NativeAudioJournal(fileURL: file), second = NativeAudioJournal(fileURL: file)
            let owner = AudioOwner(lockFileURL: tempLockURL())
            check(owner.adopt(journal: first) === first, "the first journal is adopted")
            check(owner.adopt(journal: second) === first, "a second adopt returns the journal in use")
            check(owner.journal === first, "the second journal never becomes the owner's writer")
        }

        // 6. L12a/L12b: the output receipt and the played-level window, on fakes, with no device and
        // no wait. A regression in the reading text, the decibel math or the window arithmetic fails here.
        failures += await section_12()

        exit(failures == 0 ? 0 : 1)
    }

    /// One fake device per case: the reading seam and the journal are the only inputs either proof needs.
    @MainActor private static func section_12() async -> Int {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }

        // The closed text of one reading: two decimals inside 0...1, a boolean mute, unknown for a failed getter.
        let reading = NativeLiveAudioDevice.outputLevelText(volume: 0.4234, mute: 0)
        check(reading.volume == "0.42" && reading.mute == "false", "a reading rounds to two decimals and a boolean mute, got \(reading)")
        let loud = NativeLiveAudioDevice.outputLevelText(volume: 1.4, mute: 7)
        check(loud.volume == "1.00" && loud.mute == "true", "a scalar above one clamps and any nonzero mute is true, got \(loud)")
        let quiet = NativeLiveAudioDevice.outputLevelText(volume: -0.2, mute: 0)
        check(quiet.volume == "0.00", "a scalar below zero clamps to zero, got \(quiet)")
        let failed = NativeLiveAudioDevice.outputLevelText(volume: nil, mute: nil)
        check(failed.volume == "unknown" && failed.mute == "unknown", "a failed getter yields unknown, never a zero, got \(failed)")

        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else {
            check(false, "the synthetic capture format is unavailable"); exit(1)
        }
        let journal = NativeAudioJournal(fileURL: nil)
        let owner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("a1-l12-\(UUID().uuidString)"))
        let device = NativeLiveAudioDevice(captureInput: format,
                                          defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                          owner: owner, journal: journal, deviceState: { _ in false },
                                          isBuiltInOutput: { true },
                                          outputLevelReading: { NativeLiveAudioDevice.outputLevelText(volume: 0.42, mute: 0) })
        device.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        device.startForTesting = { _ in }
        device.playbackDriverForTesting = FakeDriver()
        do { try await device.startFenced { _, _ in } } catch {
            check(false, "the fake start threw \(error)"); exit(1)
        }
        let started = journal.events.filter { $0.name == "audio_started" }
        check(started.count == 1, "one audio_started record, got \(started.count)")
        check(started.first?.fields["outputVolume"] == "0.42", "audio_started carries the output volume the reader gave, got \(String(describing: started.first?.fields["outputVolume"]))")
        check(started.first?.fields["outputMute"] == "false", "audio_started carries the output mute the reader gave, got \(String(describing: started.first?.fields["outputMute"]))")

        // A known window: peak 16384/32768 and the RMS of the same samples.
        let window: [Int16] = [16384, 8192, 0, 0, 4096, 0, 0, 0]
        var pcm = Data()
        for sample in window { withUnsafeBytes(of: sample.littleEndian) { pcm.append(contentsOf: $0) } }
        do { try await device.write(pcm) } catch { check(false, "the fake write threw \(error)"); exit(1) }
        device.flushPlaybackLevelForTesting()
        let levels = journal.events.filter { $0.name == "playback_level" }
        check(levels.count == 1, "one flush logs one playback_level, got \(levels.count)")
        let values = window.map { Double($0) / 32768 }
        let expectedPeak = 20 * log10(abs(values.max() ?? 0))
        let expectedRms = 20 * log10((values.map { $0 * $0 }.reduce(0, +) / Double(values.count)).squareRoot())
        let loggedPeak = Double(levels.first?.fields["peakDb"] ?? "") ?? .nan
        let loggedRms = Double(levels.first?.fields["rmsDb"] ?? "") ?? .nan
        check(abs(loggedPeak - expectedPeak) <= 0.5, "peakDb within 0.5 dB of \(expectedPeak), got \(loggedPeak)")
        check(abs(loggedRms - expectedRms) <= 0.5, "rmsDb within 0.5 dB of \(expectedRms), got \(loggedRms)")
        check(levels.first?.fields["frames"] == "8", "the window counts the frames it covered, got \(String(describing: levels.first?.fields["frames"]))")
        check(NativeLiveAudioDevice.playbackLevelWindowMs == 5_000, "the window is five seconds")

        // A window with no frames has no level, so it leaves no line; a silent window still reports the floor.
        device.flushPlaybackLevelForTesting()
        check(journal.events.filter { $0.name == "playback_level" }.count == 1, "a window with no frames logs nothing")
        do { try await device.write(Data(count: 16)) } catch { check(false, "the silent write threw \(error)") }
        device.flushPlaybackLevelForTesting()
        let afterSilence = journal.events.filter { $0.name == "playback_level" }
        check(afterSilence.count == 2 && afterSilence.last?.fields["peakDb"] == "-120.0",
              "a window of digital silence reports the floor, got \(String(describing: afterSilence.last?.fields))")
        device.stop()

        // C-AUDIOMARK 0b, 2 and 3: one readout names the device, its transport and every volume
        // control the device publishes, never one assumed master.
        let snapshot = NativeOutputVolumeSnapshot(uid: "synthetic-output", transport: "built-in",
            controls: [NativeVolumeControl(element: 0, scalar: 0.42),
                       NativeVolumeControl(element: 1, scalar: 0.21),
                       NativeVolumeControl(element: 2, scalar: nil)])
        check(snapshot.fields["outputUid"] == "synthetic-output",
              "the readout names the device, got \(String(describing: snapshot.fields["outputUid"]))")
        check(snapshot.fields["outputTransport"] == "built-in",
              "the readout names the transport, got \(String(describing: snapshot.fields["outputTransport"]))")
        check(snapshot.fields["outputVolume"] == "0=0.420,1=0.210",
              "every control it has is reported, an unreadable one skipped, got \(String(describing: snapshot.fields["outputVolume"]))")
        check(snapshot.fields["outputVolumeControls"] == "2",
              "the readout counts the readable controls, got \(String(describing: snapshot.fields["outputVolumeControls"]))")
        let noControls = NativeOutputVolumeSnapshot(uid: "synthetic-output", transport: "Bluetooth", controls: [])
        check(noControls.fields["outputVolume"] == "unknown",
              "a device with no readable control says unknown, never a zero, got \(String(describing: noControls.fields["outputVolume"]))")

        let markJournal = NativeAudioJournal(fileURL: nil)
        let markOwner = AudioOwner(lockFileURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("a1-mark-\(UUID().uuidString)"))
        let volumeDevice = NativeLiveAudioDevice(captureInput: format,
                                                defaultInput: { (id: "synthetic-1", name: "Synthetic") },
                                                owner: markOwner, journal: markJournal, deviceState: { _ in false },
                                                isBuiltInOutput: { true },
                                                outputVolumeSnapshot: { snapshot })
        volumeDevice.engineFactoryForTesting = { (AVAudioEngine(), AVAudioPlayerNode(), format) }
        volumeDevice.startForTesting = { _ in }
        volumeDevice.playbackDriverForTesting = FakeDriver()
        do { try await volumeDevice.startFenced { _, _ in } } catch {
            check(false, "the fake start threw \(error)"); exit(1)
        }
        let volumes = markJournal.events.filter { $0.name == "output_volume" }
        check(volumes.map { $0.fields["reason"] ?? "" } == ["before_prepare", "after_route_selection"],
              "one volume record before preparation and one after route selection, got \(volumes.map { $0.fields["reason"] ?? "" })")
        check(volumes.first?.fields["outputUid"] == "synthetic-output" &&
              volumes.first?.fields["outputVolume"] == "0=0.420,1=0.210",
              "a volume record carries the device, transport and volumes together, got \(String(describing: volumes.first?.fields))")
        check(volumes.last?.fields["voiceProcessing"] == "true" && volumes.last?.fields["voiceProcessingBypass"] == "none",
              "the post-route record says the voice stage is on, got \(String(describing: volumes.last?.fields))")

        // C-AUDIOMARK 3: the overload listener counts per call and the count reaches the journal.
        volumeDevice.noteProcessorOverloadForTesting()
        volumeDevice.noteProcessorOverloadForTesting()
        check(markJournal.events.filter { $0.name == "processor_overload" }.last?.fields["count"] == "2",
              "two overload notifications count to two, got \(String(describing: markJournal.events.filter { $0.name == "processor_overload" }.last?.fields))")

        // C-AUDIOMARK 4: the played window now reports the volume, the voice flag, the samples at or
        // over -3 dBFS and the flat-top runs, on the decoded provider PCM.
        let loud: [Int16] = [23200, 23200, 23200, 0, 0, 0, 0, 0]
        var loudPCM = Data()
        for sample in loud { withUnsafeBytes(of: sample.littleEndian) { loudPCM.append(contentsOf: $0) } }
        do { try await volumeDevice.write(loudPCM) } catch { check(false, "the fake write threw \(error)"); exit(1) }
        volumeDevice.flushPlaybackLevelForTesting()
        let widened = markJournal.events.filter { $0.name == "playback_level" }.last?.fields
        check(widened?["overSamples"] == "3",
              "three samples at or over -3 dBFS are counted, got \(String(describing: widened?["overSamples"]))")
        check(widened?["flatTopRuns"] == "1",
              "one run of identical loud samples is one flat top, got \(String(describing: widened?["flatTopRuns"]))")
        check(widened?["outputVolume"] == "0=0.420,1=0.210",
              "the level carries the output volume, got \(String(describing: widened?["outputVolume"]))")
        check(widened?["voiceProcessing"] == "true",
              "the level carries the voice stage flag, got \(String(describing: widened?["voiceProcessing"]))")

        volumeDevice.stop()
        let afterStop = markJournal.events.filter { $0.name == "output_volume" }
        check(afterStop.last?.fields["reason"] == "after_teardown",
              "a teardown leaves a volume record, got \(String(describing: afterStop.last?.fields["reason"]))")
        check(afterStop.last?.fields["processorOverloads"] == "2",
              "the teardown record carries the call's overload count, got \(String(describing: afterStop.last?.fields["processorOverloads"]))")

        // C-AUDIOMARK 1: the mark is metadata only, and it names every fact a reader needs.
        let mark = NativeDistortionMark(output: snapshot, voiceProcessing: true, bypassReason: "none",
                                        engineGeneration: 3, lastChange: "route_change",
                                        duckingRequested: "advanced=0,level=min",
                                        duckingReadBack: "advanced=0,level=min",
                                        peakDb: "-3.1", rmsDb: "-12.4", overSamples: 12, flatTopRuns: 2,
                                        processorOverloads: 1, loadAverage: (1.5, 1.25, 1.0))
        let markRecord = mark.record
        check(markRecord["event"] as? String == "audio_distortion_mark",
              "the mark names its own event, got \(String(describing: markRecord["event"]))")
        check(markRecord["outputUid"] as? String == "synthetic-output" &&
              markRecord["outputVolume"] as? String == "0=0.420,1=0.210",
              "the mark carries the device and volumes, got \(markRecord)")
        check(markRecord["voiceProcessing"] as? Bool == true && markRecord["voiceProcessingBypass"] as? String == "none",
              "the mark carries the voice stage and its bypass reason")
        check(markRecord["engineGeneration"] as? Int == 3 && markRecord["lastChange"] as? String == "route_change",
              "the mark carries the engine generation and the last change")
        check(markRecord["duckingReadBack"] as? String == "advanced=0,level=min",
              "the mark carries the read-back ducking")
        check(markRecord["overSamples"] as? Int == 12 && markRecord["processorOverloads"] as? Int == 1,
              "the mark carries the overload counters")
        check(markRecord["loadAverage"] as? String == "1.50,1.25,1.00",
              "the mark carries the load average, got \(String(describing: markRecord["loadAverage"]))")

        // The same record on native-live.log: one line, the launch identity, both clocks, and the
        // call id exactly when a call is running.
        let liveJournal = NativeLiveJournal(fileURL: nil)
        liveJournal.append(markRecord)
        let noCall = liveJournal.events.last
        check(noCall?["liveSessionId"] == nil, "a mark with no call carries no call id, got \(String(describing: noCall?["liveSessionId"]))")
        check(noCall?["mono_ms"] != nil && noCall?["timestamp"] != nil,
              "a mark always carries the wall clock and the monotonic clock")
        liveJournal.sessionID = "synthetic-call"
        liveJournal.append(markRecord)
        check(liveJournal.events.last?["liveSessionId"] as? String == "synthetic-call",
              "a mark inside a call carries the call id, got \(String(describing: liveJournal.events.last?["liveSessionId"]))")

        // C-AUDIOMARK 2: the read-only listener records a volume change and a default-device change,
        // and a notification never claims who wrote the value.
        let monitorJournal = NativeLiveJournal(fileURL: nil)
        let monitor = NativeOutputVolumeMonitor(journal: monitorJournal, read: { snapshot })
        monitor.noteVolumeChangedForTesting()
        let changed = monitorJournal.events.last
        check(changed?["event"] as? String == "output_volume_changed",
              "a volume notification writes output_volume_changed, got \(String(describing: changed?["event"]))")
        check(changed?["outputVolume"] as? String == "0=0.420,1=0.210" && changed?["outputUid"] as? String == "synthetic-output",
              "the change record carries the device and volumes, got \(changed ?? [:])")
        check(changed?["changedBy"] == nil, "a notification never claims who changed the volume")
        monitor.noteDefaultOutputChangedForTesting()
        let moved = monitorJournal.events.last
        check(moved?["event"] as? String == "output_volume" && moved?["reason"] as? String == "default_device_changed",
              "a default-device change writes a volume record with its reason, got \(moved ?? [:])")
        check(moved?["outputUid"] as? String == "synthetic-output",
              "the default-device record names the device it rebound to")

        return failures
    }

    /// Stands in for the player so no engine is started: scheduling is all `write` needs.
    @MainActor final class FakeDriver: NativePlaybackDriver {
        func schedule(_ buffer: AVAudioPCMBuffer, completion: @escaping @Sendable () -> Void) {}
        func play() {}
        func stop() {}
    }
}
