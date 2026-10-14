import Foundation
import Security
import LocalAuthentication

/// Modern replacement for the deprecated process-global SecKeychain interaction
/// policy. SecKeychainSetUserInteractionAllowed/GetUserInteractionAllowed were
/// retired in favor of per-query authentication contexts, so hold one
/// non-interactive LAContext and consult it through the same set/get seam.
/// Establish it before AppKit/WK work and never restore it.
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
            return installed.interactionNotAllowed ? errSecSuccess : errSecInteractionNotAllowed
        }, get: { allowed in
            guard let installed = context else { return errSecNotAvailable }
            allowed.pointee = DarwinBoolean(!installed.interactionNotAllowed)
            return errSecSuccess
        })
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
        return readback(get: { allowed in
            guard let installed = context else { return errSecNotAvailable }
            allowed.pointee = DarwinBoolean(!installed.interactionNotAllowed)
            return errSecSuccess
        })
    }
}
