import Foundation
import Security
import LocalAuthentication
import Darwin

/// Holds this process's non-interactive keychain policy. A per-call LAContext and
/// the authentication-UI flags do not stop the legacy file keychain from showing
/// its authorization UI, so also set the deprecated process-global policy and
/// verify it. Establish before AppKit/WK work and never restore it.
/// MainActor confines OUR metadata, not framework threads or their SDK calls.
@MainActor enum NativeKeychainPolicy {
    private(set) static var installationStatus: OSStatus?
    private(set) static var context: LAContext?

    static func establish() -> OSStatus {
        if let status = installationStatus { return status }
        let status = evaluate(set: {
            let installed = LAContext()
            installed.interactionNotAllowed = true
            context = installed
            // The legacy keychain ignores the per-call UI flags, so withdraw it globally.
            let keychain = SecKeychainSetUserInteractionAllowed(false)
            guard keychain == errSecSuccess else { return keychain }
            return installed.interactionNotAllowed ? errSecSuccess : errSecInteractionNotAllowed
        }, get: readbackInteractionAllowed)
        if status != errSecSuccess {
            fputs("KEYCHAIN-POLICY: noninteractive legacy policy not established (\(status))\n", stderr)
        }
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
        return readback(get: readbackInteractionAllowed)
    }

    // Real readback of the process-global legacy flag together with the held
    // LAContext: the legacy keychain ignores per-call flags, so its own global must
    // read false. Interaction is reported allowed if EITHER seam still allows it.
    private static func readbackInteractionAllowed(_ allowed: UnsafeMutablePointer<DarwinBoolean>) -> OSStatus {
        var legacyAllowed = DarwinBoolean(true)
        let status = SecKeychainGetUserInteractionAllowed(&legacyAllowed)
        guard status == errSecSuccess else { return status }
        guard let installed = context else { return errSecNotAvailable }
        allowed.pointee = DarwinBoolean(legacyAllowed.boolValue || !installed.interactionNotAllowed)
        return errSecSuccess
    }
}
