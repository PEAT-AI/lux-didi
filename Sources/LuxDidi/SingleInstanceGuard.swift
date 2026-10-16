import AppKit

// Desktop single-instance authority. A second launch of the same bundle id
// activates the already-running instance and exits before building any window,
// host or audio. Disposable verification launches (`OwnedVerificationLaunchGate`,
// identified by its gate environment) are exempt, because the launch probe
// deliberately starts fresh instances to prove identity and exit behavior.
@MainActor
enum SingleInstanceGuard {
    static func otherRunningInstance(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier
    ) -> NSRunningApplication? {
        guard let bundleIdentifier else { return nil }
        let me = getpid()
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .first { $0.processIdentifier != me && !$0.isTerminated }
    }

    // Returns true when this launch must yield to an existing instance. No
    // `.activateIgnoringOtherApps`: surface the live instance without stealing focus.
    @discardableResult
    static func yieldToExistingInstance(verification: Bool) -> Bool {
        guard !verification, let other = otherRunningInstance() else { return false }
        other.activate(options: [])
        return true
    }
}
