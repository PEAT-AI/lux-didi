import AppKit
import AVFoundation
import Foundation

/// The mechanism behind the 2026-11-01 crashes, as its own executable because a failure kills the
/// process: an Objective-C exception that Swift cannot catch unwinds the frame without the runtime's
/// job cleanup, so the thread local current executor keeps pointing at a dead stack frame and the
/// next `MainActor.assumeIsolated` jumps through it. Nothing here is a test assertion about the OS:
/// the check is that the timer keeps ticking after the guarded call fails, and it shows the slot as
/// evidence only. Slot 104 is an OS private detail and is never asserted on.
@main struct NativeExecutorMechanism {
    /// Touched only on the main thread, from the timer on the main run loop.
    final class Ticker: @unchecked Sendable {
        nonisolated(unsafe) var ticks = 0
        nonisolated(unsafe) var caught = false
        nonisolated(unsafe) var ticksAfterCall = 0
    }

    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let ticker = Ticker()
        let timer = Timer(timeInterval: 0.25, repeats: true) { _ in
            // Exactly what the orb liveness timer does: an isolated body from a non Swift job.
            MainActor.assumeIsolated {
                ticker.ticks += 1
                if ticker.caught { ticker.ticksAfterCall += 1 }
                if ticker.ticks == 2 {
                    // The guarded call runs in a real main actor job, as the build does.
                    Task { @MainActor in
                        // The raw boundary guard, the same C function the device calls.
                        let raised = DIDIAVFAudioGuard {
                            AVAudioMixerNode().installTap(onBus: 0, bufferSize: 1024, format: nil) { _, _ in }
                        }
                        ticker.caught = raised != nil
                    }
                }
                if ticker.caught && ticker.ticksAfterCall >= 4 { finish(ticker) }
                // A wedged run loop must fail the step, never hang the check: 40 ticks is 10 s.
                if ticker.ticks >= 40 { finish(ticker) }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        app.run()
        finish(ticker)
    }

    /// The verdict and the evidence, then the process ends: `NSApplication.stop` does not leave a
    /// run loop that was started outside a bundled app, so the step exits from the timer instead.
    static func finish(_ ticker: Ticker) -> Never {
        let slot = pthread_getspecific(104)
        print("slot104=\(slot.map { String(describing: $0) } ?? "nil") ticks=\(ticker.ticks) ticksAfterCall=\(ticker.ticksAfterCall)")
        if ticker.caught && ticker.ticksAfterCall >= 4 {
            print("NATIVE-EXECUTOR MECHANISM PASS the main actor timer survived the caught AVFAudio exception")
            exit(0)
        }
        print("NATIVE-EXECUTOR MECHANISM FAIL the timer stopped after the caught AVFAudio exception")
        exit(1)
    }
}
