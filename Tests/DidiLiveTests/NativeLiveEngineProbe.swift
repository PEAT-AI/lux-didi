import Foundation

@main struct NativeLiveEngineProbe {
    @MainActor static func main() {
        do {
            try NativeLiveAudioDevice.startSilentEngineProbe()
            print("NATIVE-AUDIO-ENGINE-PROBE PASS production-helper=true capture-tap=false queued-output=false")
        } catch let error as NativeLiveAudioError {
            let detail = error.diagnosticDetail.map(String.init) ?? "none"
            print("NATIVE-AUDIO-ENGINE-PROBE FAIL code=\(error.rawValue) detail=\(detail)")
            exit(1)
        } catch {
            print("NATIVE-AUDIO-ENGINE-PROBE FAIL code=unexpected detail=none")
            exit(1)
        }
    }
}
