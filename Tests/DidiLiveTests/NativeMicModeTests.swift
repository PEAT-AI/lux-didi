import AVFoundation
import Foundation

/// Fake-seam proofs for the Mic Mode reader (`#352`, release 3o): the name mapping, the receipt shape and
/// the once-per-app-version prompt. No audio device, no capture session, no window and no clock.
@main struct NativeMicModeTests {
    @MainActor static func main() {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }
        func reading(_ preferred: Int, _ active: Int) -> MicModeReading {
            MicModeReading(preferred: MicMode(microphoneMode: preferred), active: MicMode(microphoneMode: active))
        }

        // 1. The mapping is the SDK's own raw values, and anything else is unknown rather than a guess.
        check(MicMode(microphoneMode: 0) == .standard, "0 is standard")
        check(MicMode(microphoneMode: 1) == .wideSpectrum, "1 is wide spectrum")
        check(MicMode(microphoneMode: 2) == .voiceIsolation, "2 is voice isolation")
        check(MicMode(microphoneMode: 3) == .unknown, "3 is unknown")
        check(MicMode(microphoneMode: -1) == .unknown, "a negative raw value is unknown")
        check(Set(MicMode.allCases.map(\.rawValue)) == ["standard", "wideSpectrum", "voiceIsolation", "unknown"],
              "the four names are the closed set")

        // 2. The receipt is names only. host.log gets exactly these three keys.
        let record = reading(2, 2).record
        check(Set(record.keys) == ["event", "preferred", "active"], "the receipt carries three keys")
        check(record["event"] as? String == "mic_mode", "the receipt names the event mic_mode")
        check(record["preferred"] as? String == "voiceIsolation", "the receipt carries the preferred name")
        check(record["active"] as? String == "voiceIsolation", "the receipt carries the active name")

        // 3. At a LIVE start the full app may ask once per app version, and only away from Voice Isolation.
        var prompt = MicModePrompt()
        check(!prompt.liveStart(reading(2, 2), version: "3.0"), "a Voice Isolation start never asks")
        check(prompt.liveStart(reading(0, 0), version: "3.0"), "a standard start asks")
        check(!prompt.liveStart(reading(0, 1), version: "3.0"), "the same version never asks twice")
        check(prompt.liveStart(reading(0, 0), version: "3.1"), "a new app version asks again")

        // 4. A return from Voice Isolation re-arms it inside the same version, and stays quiet afterwards.
        var rearmed = MicModePrompt()
        check(rearmed.liveStart(reading(0, 0), version: "3.0"), "first start asks")
        rearmed.modeChanged(reading(2, 2))
        check(!rearmed.liveStart(reading(2, 2), version: "3.0"), "a Voice Isolation start never asks")
        rearmed.modeChanged(reading(0, 0))
        check(rearmed.liveStart(reading(0, 0), version: "3.0"), "the mode changed back, so it asks once more")
        check(!rearmed.liveStart(reading(0, 0), version: "3.0"), "and then it is quiet for this version")

        // 5. A change to another non-Voice-Isolation mode is not a change back: no second ask.
        var steady = MicModePrompt()
        check(steady.liveStart(reading(0, 0), version: "3.0"), "first start asks")
        steady.modeChanged(reading(0, 1))
        check(!steady.liveStart(reading(0, 1), version: "3.0"), "standard to wide spectrum is not a change back")

        // 6. The shown version survives a relaunch: a second process in the same version stays quiet (VI1-F1).
        final class Store: @unchecked Sendable { var value: String? }
        let store = Store()
        var firstLaunch = MicModePrompt(shownVersion: { store.value }, setShownVersion: { store.value = $0 })
        check(firstLaunch.liveStart(reading(0, 0), version: "3.0"), "the first launch asks")
        check(store.value == "3.0", "the asked version is stored, so a relaunch can read it")
        var relaunch = MicModePrompt(shownVersion: { store.value }, setShownVersion: { store.value = $0 })
        check(!relaunch.liveStart(reading(0, 0), version: "3.0"), "a relaunch inside the same version stays quiet")
        check(relaunch.liveStart(reading(0, 0), version: "3.1"), "a new version asks again after a relaunch")
        relaunch.modeChanged(reading(2, 2))
        relaunch.modeChanged(reading(0, 0))
        check(store.value == nil, "a change back from Voice Isolation clears the stored version")
        check(relaunch.liveStart(reading(0, 0), version: "3.1"), "so the same version may ask once more after a change back")
        check(store.value == "3.1", "and the stored version follows")

        // The selected preference survives route teardown even while active processing returns to standard.
        let selectedStore = Store()
        var selected = MicModePrompt(shownVersion: { selectedStore.value }, setShownVersion: { selectedStore.value = $0 })
        check(selected.liveStart(reading(0, 0), version: "3.2"), "the selected-mode fixture records its first prompt")
        selected.modeChanged(reading(2, 2))
        selected.modeChanged(reading(2, 0))
        check(selectedStore.value == "3.2", "active teardown preserves the selected preference prompt history")
        check(!selected.liveStart(reading(2, 0), version: "3.2"), "selected Voice Isolation awaiting activation never asks again")
        check(!selected.liveStart(reading(2, 0), version: "3.3"), "a new version does not ask to reselect an existing preference")
        selected.modeChanged(reading(0, 2))
        check(selectedStore.value == nil, "an actual preferred change clears prompt history before active processing catches up")
        check(!selected.liveStart(reading(0, 2), version: "3.3"), "active Voice Isolation never asks while the selection change settles")
        selected.modeChanged(reading(0, 0))
        check(selected.liveStart(reading(0, 0), version: "3.3"), "actual preference change to standard rearms one prompt")
        check(!selected.liveStart(reading(0, 0), version: "3.3"), "the actual preference change prompts only once")

        print(failures == 0 ? "NATIVE-MIC-MODE TESTS PASS" : "NATIVE-MIC-MODE TESTS FAILED \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}
