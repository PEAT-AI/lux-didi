import Foundation

// Fixed instructions only. No provider payload can become a command or label.
struct NativeNextStep {
    let text: String
    let command: String?
    var guideURL: URL? = nil
}
enum NativeNextSteps {
    // The seven connector rows the host can emit and the nine reason codes it can return, matching
    // web/src/next-steps.ts one for one (web/test/next-steps.test.ts reads these two lines).
    static let connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose-knowledge", "mongoose-data", "mongoose-crm"]
    static let reasonCodes = ["configuration_error", "credential_missing", "needs_sign_in", "not_signed_in", "unreachable", "discovery_failed", "handshake_failed", "identity_mismatch", "unknown"]
    private static let setupGuide = URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")
    private static let mcpGuide = URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/mcp-configuration.md")
    private static let configureStep = NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: setupGuide)
    /// The three Mongoose endpoints, each its own OAuth resource with its own browser sign-in.
    private static let endpointLabels: [String: String] = [
        "mongoose-knowledge": "Mongoose knowledge", "mongoose-data": "Mongoose data", "mongoose-crm": "Mongoose CRM",
    ]
    private static let endpointNames: [String: String] = [
        "mongoose-knowledge": "knowledge", "mongoose-data": "data", "mongoose-crm": "crm",
    ]
    /// The endpoint name a row signs in, or nil: only these three rows can be signed in.
    static func endpointName(_ id: String) -> String? { endpointNames[id] }
    static func signInStep(_ label: String) -> NativeNextStep {
        NativeNextStep(text: "Sign in to \(label) in Settings: the Sign in button is on the \(label) row, and the connector reconnects by itself when you finish.", command: nil, guideURL: setupGuide)
    }
    private static func unreachableStep(_ label: String) -> NativeNextStep {
        NativeNextStep(text: "\(label) is not reachable right now. Naya retries in the background and reconnects by itself when Mongoose answers.", command: nil)
    }
    private static func mongooseCredentialStep(_ label: String) -> NativeNextStep {
        NativeNextStep(text: "\(label) has no stored session. Run mongoose-login, or use the Sign in button in Settings once this endpoint is configured.", command: "mongoose-login", guideURL: setupGuide)
    }
    static let credentialSteps: [String: NativeNextStep] = [
        "lux-knowledge": configureStep, "gmail": configureStep, "calendar": configureStep, "mattermost": configureStep,
        "mongoose-knowledge": mongooseCredentialStep("Mongoose knowledge"),
        "mongoose-data": mongooseCredentialStep("Mongoose data"),
        "mongoose-crm": mongooseCredentialStep("Mongoose CRM"),
    ]
    /// One fixed sentence per reason code, so no row with a known reason falls back to the failure text.
    private static let reasonSteps: [String: NativeNextStep] = [
        "configuration_error": NativeNextStep(text: "This connector's tool list changed and needs your approval. Approve the new tool list with the approve command the MCP configuration guide describes, then restart Lux Didi.", command: nil, guideURL: mcpGuide),
        "credential_missing": configureStep,
        "needs_sign_in": NativeNextStep(text: "This connector needs a fresh sign-in with its own credentials. Sign in with its own command, then restart Lux Didi.", command: nil, guideURL: setupGuide),
        "not_signed_in": NativeNextStep(text: "This connector has no active session. Sign in again with its own credentials, then restart Lux Didi.", command: nil, guideURL: setupGuide),
        "unreachable": NativeNextStep(text: "The connector service is not reachable right now. Start it, then restart Lux Didi.", command: nil, guideURL: setupGuide),
        "discovery_failed": NativeNextStep(text: "Tool discovery failed for this connector. Check its service tool configuration, then restart Lux Didi.", command: nil),
        "handshake_failed": NativeNextStep(text: "This connector's handshake failed. Check that its service is ready, then restart Lux Didi.", command: nil),
        "identity_mismatch": NativeNextStep(text: "This connector is signed in as a different account. Sign in again with the account your configuration names, then restart Lux Didi.", command: nil),
    ]
    static let failureStep = NativeNextStep(text: "Check the connector service, then use Copy diagnostics from the Lux Didi menu.", command: nil)
    @MainActor static func singleKeyStep(enabled: Bool, tapped: Bool) -> NativeNextStep {
        NativeNextStep(text: SingleKeyTrigger.grantNoticeTitle(enabled: enabled, tapped: tapped)
                        ?? "On: a bare Right Command tap mutes and unmutes her.",
                       command: nil,
                       guideURL: URL(string: SingleKeyTrigger.grantSettingsURL))
    }
    static func lookup(id: String, state: String, reason: String?) -> NativeNextStep {
        if state == "connected" { return NativeNextStep(text: "no action needed", command: nil) }
        if state == "configured" { return NativeNextStep(text: "a Live session connects on demand", command: nil) }
        if let label = endpointLabels[id], reason == "needs_sign_in" || reason == "not_signed_in" { return signInStep(label) }
        if let label = endpointLabels[id], reason == "unreachable" { return unreachableStep(label) }
        if state == "missing" || reason == "credential_missing" {
            return credentialSteps[id] ?? configureStep
        }
        return reasonSteps[reason ?? "unknown"] ?? failureStep
    }
}
