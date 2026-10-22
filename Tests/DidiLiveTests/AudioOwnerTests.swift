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
        return failures
    }

    /// Stands in for the player so no engine is started: scheduling is all `write` needs.
    @MainActor final class FakeDriver: NativePlaybackDriver {
        func schedule(_ buffer: AVAudioPCMBuffer, completion: @escaping @Sendable () -> Void) {}
        func play() {}
        func stop() {}
    }
}
