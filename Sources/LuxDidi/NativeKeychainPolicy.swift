import Foundation
import Security

/// Legacy defaultKeychainUI ignores LAContext/per-call authentication UI flags.
/// This public (deprecated) policy lives in this process's Security.framework
/// Globals object. Establish it before AppKit/WK work and never restore it.
/// MainActor confines OUR metadata, not framework threads or their SDK calls.
@MainActor enum NativeKeychainPolicy {
    private(set) static var installationStatus: OSStatus?

    static func establish() -> OSStatus {
        if let status = installationStatus { return status }
        let status = evaluate(set: { SecKeychainSetUserInteractionAllowed(false) },
                              get: SecKeychainGetUserInteractionAllowed)
        installationStatus = status
        return status
    }

    // Pure failure seams: fake set/get results test handling, not SDK efficacy.
    static func evaluate(set: () -> OSStatus,
                         get: (UnsafeMutablePointer<DarwinBoolean>) -> OSStatus) -> OSStatus {
        let status = set()
        guard status == errSecSuccess else { return status }
        return readback(get: get)
    }

    static func readback(get: (UnsafeMutablePointer<DarwinBoolean>) -> OSStatus) -> OSStatus {
        var allowed = DarwinBoolean(true)
        let status = get(&allowed)
        guard status == errSecSuccess else { return status }
        return allowed.boolValue ? errSecInteractionNotAllowed : errSecSuccess
    }

    static func check() -> OSStatus {
        // Never lazily establish or silently repair a framework's policy change.
        guard installationStatus == errSecSuccess else {
            return installationStatus ?? errSecInteractionNotAllowed
        }
        return readback(get: SecKeychainGetUserInteractionAllowed)
    }
}
