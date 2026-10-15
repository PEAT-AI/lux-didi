import AVFoundation
import Foundation

/// The startup silent probe is deleted: a session starts exactly one engine, and a second
/// request is refused by the single owner. No real engine or device is touched here.
@main struct NativeLiveEngineProbe {
    @MainActor static func main() {
        let lockURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("a1-engine-probe-\(UUID().uuidString)")
        let owner = AudioOwner(lockFileURL: lockURL)
        let device = NativeLiveAudioDevice(owner: owner, deviceState: { _ in false })
        guard !device.hasEngine, !owner.isOwned else {
            print("NATIVE-AUDIO-ENGINE-PROBE FAIL code=construction_created_engine detail=none")
            exit(1)
        }
        let holder = ObjectIdentifier(device)
        do {
            try owner.acquire(holder: holder)
            owner.didStartEngine(holder: holder)
            var refused = false
            do { try owner.acquire(holder: ObjectIdentifier(NSObject())) }
            catch AudioOwnerError.alreadyOwned { refused = true } catch {}
            guard owner.engineStarts == 1, refused else {
                print("NATIVE-AUDIO-ENGINE-PROBE FAIL code=owner detail=none")
                exit(1)
            }
            owner.release(holder: holder)
            print("NATIVE-AUDIO-ENGINE-PROBE PASS probe-deleted=true one-engine-per-session=true second-refused=true")
        } catch {
            print("NATIVE-AUDIO-ENGINE-PROBE FAIL code=owner detail=none")
            exit(1)
        }
    }
}
