import Foundation
import Darwin

// No NSApplication, windows, LaunchServices, Keychain, audio or installed-app initialization.
@main struct SupervisorGraceMain {
    @MainActor static func main() async {
        do {
            try await SupervisorGraceProof.run()
            print("SUPERVISOR-LIFECYCLE PASS assertions=3 headless=true")
        } catch {
            fputs("SUPERVISOR-LIFECYCLE FAIL: \(error)\n", stderr)
            exit(1)
        }
    }
}
