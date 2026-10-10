import Foundation
import Security
import LocalAuthentication
import Darwin

// Real Security.framework calls in a separate, bounded test process. No global
// interaction-policy change and no default/search-list/keychain/ACL mutation.
@MainActor enum KeychainSDKProof {
    static func run(mode: String, state: URL, output: URL) throws -> Bool {
        guard mode == "missing" || mode == "inherited" else { throw NativeServiceError.invalidRuntime }
        let service = "ai.peat.lux-didi.sdk-proof." + UUID().uuidString
        let account = UUID().uuidString.lowercased() + ".proof.sdk"
        var report: [String: Any] = ["type": "RealKeychainSDKDiscriminator", "mode": mode, "pid": Int(getpid()),
            "stage": "starting", "success": false, "service": service, "account": account,
            "globalPolicyChanged": NativeKeychainPolicy.installationStatus == errSecSuccess,
                                     "policyInstallationStatus": Int(NativeKeychainPolicy.installationStatus ?? errSecInteractionNotAllowed), "bootstrapAttempted": false, "credentialReturned": false,
            "addCalls": 0, "addStatus": NSNull(), "typedRefusal": NSNull(), "equalReimport": false,
            "cleanupStatus": NSNull(), "absentStatus": NSNull()]
        func write() throws {
            let bytes = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try bytes.write(to: output, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        }
        var interaction = DarwinBoolean(true)
        let readback = SecKeychainGetUserInteractionAllowed(&interaction)
        report["policyReadbackStatus"] = Int(readback)
        report["policyReadbackAllowed"] = interaction.boolValue
        guard readback == errSecSuccess, !interaction.boolValue else {
            report["stage"] = "lifetime-policy-not-established"; try write(); return false
        }
        try NativeCredentialImport.prepareState(state)
        var random = [UInt8](repeating: 0, count: 32)
        let randomStatus = random.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
        guard randomStatus == errSecSuccess else { throw NativeServiceError.keychain(randomStatus) }
        let token = Data(random).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let file = state.appendingPathComponent("admin-credential")
        try Data((token + "\n").utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let context = LAContext(); context.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecUseAuthenticationContext as String: context,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var addCalls = 0
        let realAdd: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = { attributes, result in
            var item = attributes as! [String: Any]
            item[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
            addCalls += 1; report["addCalls"] = addCalls; report["stage"] = "before-real-SecItemAdd"
            do { try write() } catch {
                fputs("KEYCHAIN-SDK stage report write failed\n", stderr); return errSecIO
            }
            // The actual SDK operation, never an injected fixed result.
            let status = SecItemAdd(item as CFDictionary, result)
            report["addStatus"] = Int(status)
            return status
        }
        report["stage"] = "before-import"; try write()
        var outcome = false
        do {
            let reference = try NativeCredentialImport.importCredential(state: state, installId: account, service: service, add: realAdd)
            report["credentialReturned"] = true
            let descriptor = try ServiceDescriptor(origin: "http://127.0.0.1:1", credentialService: reference.service, credentialAccount: reference.account)
            let equal = try descriptor.credential() == token
            _ = try NativeCredentialImport.importCredential(state: state, installId: account, service: service, add: realAdd)
            let retained = try descriptor.credential()
            let equalReimport = equal && addCalls == 1 && retained == token
            report["equalReimport"] = equalReimport
            outcome = mode == "inherited" && equalReimport
        } catch NativeServiceError.keychain(let status) {
            report["typedRefusal"] = Int(status)
            outcome = mode == "missing" && addCalls == 1 && [errSecInteractionNotAllowed, errSecNoDefaultKeychain, errSecNotAvailable].contains(status)
        } catch {
            report["unexpectedError"] = "native-import-or-credential"
        }
        report["stage"] = "before-cleanup"; try write()
        let cleaned = SecItemDelete(query as CFDictionary)
        report["cleanupStatus"] = Int(cleaned)
        var absentQuery = query; absentQuery[kSecReturnData as String] = true
        var existing: CFTypeRef?
        let absent = SecItemCopyMatching(absentQuery as CFDictionary, &existing)
        report["absentStatus"] = Int(absent)
        // An unavailable keychain cannot prove no item; require actual not-found.
        outcome = outcome && (cleaned == errSecSuccess || cleaned == errSecItemNotFound) && absent == errSecItemNotFound && existing == nil
        report["stage"] = "complete"; report["success"] = outcome
        try write()
        return outcome
    }
}
