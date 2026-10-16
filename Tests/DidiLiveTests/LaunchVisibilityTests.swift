import AppKit
import Foundation

/// Windowless proofs for the launch-visibility decision, the single-instance guard
/// decision and the window drag-band geometry. No NSWindow is created or shown: the
/// drag band is exercised through a plain NSView hierarchy.
@main struct LaunchVisibilityTests {
    private static let allKinds: [LaunchKind] = [
        .interactive, .loginItem, .installRelaunch, .installedProof, .selfCheck, .uiProof, .verification
    ]

    @MainActor static func main() {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }
        let noEnv: [String: String] = [:]

        // 1. resolve() reads only the arguments, the environment and the login event.
        check(LaunchKind.resolve(arguments: ["/app"], environment: noEnv, loginLaunch: false) == .interactive,
              "a plain launch is interactive")
        check(LaunchKind.resolve(arguments: ["/app"], environment: noEnv, loginLaunch: true) == .loginItem,
              "the login Apple Event is a login launch")
        check(LaunchKind.resolve(arguments: ["/app", "--install-relaunch"], environment: noEnv, loginLaunch: false) == .installRelaunch,
              "the install relaunch argument is its own launch kind")
        check(LaunchKind.resolve(arguments: ["/app", "--installed-proof", "--proof-state", "/a", "--proof-report", "/b"],
              environment: noEnv, loginLaunch: false) == .installedProof,
              "the installed proof argument is its own launch kind")
        check(LaunchKind.resolve(arguments: ["/app", "--self-check"], environment: noEnv, loginLaunch: false) == .selfCheck,
              "the self-check argument is its own launch kind")
        check(LaunchKind.resolve(arguments: ["/app", "--ui-proof", "/tmp/out"], environment: noEnv, loginLaunch: false) == .uiProof,
              "the ui-proof argument is its own launch kind")
        check(LaunchKind.resolve(arguments: ["/app", "--installed-proof"], environment: ["LUX_VERIFICATION_GATE_ROOT": "/r"],
              loginLaunch: false) == .verification,
              "the verification environment wins over a proof argument")

        // 2. Visibility: only an interactive launch activates.
        for kind in allKinds {
            let expectedActivates = (kind == .interactive || kind == .loginItem)
            check(kind.activates == expectedActivates, "activates for \(kind)")
            check(kind.presentsWindowAtLaunch == (kind != .loginItem), "presents window at launch for \(kind)")
        }
        check(!LaunchKind.installRelaunch.activates && LaunchKind.installRelaunch.presentsWindowAtLaunch,
              "an install relaunch presents the window front without activation")
        check(!LaunchKind.uiProof.activates && !LaunchKind.selfCheck.activates && !LaunchKind.installedProof.activates,
              "proof, self-check and ui-proof never activate")

        // 3. The guard decision holds for every launch kind.
        for kind in allKinds {
            let expectedYield = (kind != .verification)
            check(SingleInstanceGuard.shouldYield(kind: kind, otherInstanceRunning: true) == expectedYield,
                  "guard decision with a live instance for \(kind)")
            check(!SingleInstanceGuard.shouldYield(kind: kind, otherInstanceRunning: false),
                  "guard decision with no live instance for \(kind)")
        }
        check(LaunchKind.interactive.duplicateInstanceExitCodeForYield == 0, "an interactive duplicate exits zero")
        check(LaunchKind.installedProof.duplicateInstanceExitCodeForYield != 0,
              "a yielded proof launch exits with a distinct code")
        check(LaunchKind.selfCheck.duplicateInstanceExitCodeForYield != 0 && LaunchKind.uiProof.duplicateInstanceExitCodeForYield != 0,
              "yielded self-check and ui-proof launches exit with a distinct code")

        // 4. Drag band geometry: the traffic-light zone is never claimed.
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let band = WindowDragBand.attach(to: container, afterTrafficLights: WindowDragBand.trafficLightReserve)
        container.layoutSubtreeIfNeeded()
        check(WindowDragBandView.bandHeight == 28, "the drag band is 28 points high")
        check(container.hitTest(NSPoint(x: 10, y: 590)) !== band, "the traffic-light zone receives its own clicks")
        check(container.hitTest(NSPoint(x: 400, y: 590)) === band, "the top band after the traffic lights drags the window")
        check(container.hitTest(NSPoint(x: 400, y: 300)) !== band, "content below the band does not hit the drag band")
        check(WindowDragBand.trafficLightInset(for: nil) == WindowDragBand.trafficLightReserve,
              "the traffic-light inset falls back to the reserve when buttons are unavailable")

        print(failures == 0 ? "LAUNCH-VISIBILITY TESTS PASS" : "LAUNCH-VISIBILITY TESTS FAILED \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}
