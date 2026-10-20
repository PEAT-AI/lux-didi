import AVFoundation
import Foundation

/// Fake-seam proofs for the single audio owner: a second request is refused with a typed error,
/// the cross-process flock is non-blocking, and every lifecycle record is timestamped.
@main struct AudioOwnerTests {
    @MainActor static func main() {
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
            let holder = ObjectIdentifier(NSObject())
            try owner.acquire(holder: holder)
            owner.didStartEngine(holder: holder)
            owner.didStartEngine(holder: ObjectIdentifier(NSObject()))
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

        exit(failures == 0 ? 0 : 1)
    }
}
