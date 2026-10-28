import Foundation

// Fixed instructions only. No provider payload can become a command or label.
struct NativeNextStep {
    let text: String
    let command: String?
    var guideURL: URL? = nil
}
enum NativeNextSteps {
    // The eight connector rows the host can emit (the catalogue plus the Trello board, W7-R3) and the ten
    // reason codes it can return, matching web/src/next-steps.ts one for one
    // (web/test/next-steps.test.ts reads these two lines).
    static let connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose-knowledge", "mongoose-data", "mongoose-crm", "trello"]
    static let reasonCodes = ["configuration_error", "credential_missing", "needs_sign_in", "not_signed_in", "not_configured", "unreachable", "discovery_failed", "handshake_failed", "identity_mismatch", "unknown"]
    private static let setupGuide = URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")
    private static let mcpGuide = URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/mcp-configuration.md")
    private static let configureStep = NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: setupGuide)
    /// The three Mongoose endpoints, each its own OAuth resource with its own browser sign-in.
    private static let endpointLabels: [String: String] = [
        "mongoose-knowledge": "Mongoose knowledge", "mongoose-data": "Mongoose data", "mongoose-crm": "Mongoose CRM",
        "trello": "Trello",
    ]
    /// The Trello row's own sentence: the same import command the web row names, never a Sign in button.
    private static let trelloKeyStep = NativeNextStep(text: "Trello uses the API key and token you already have. If the Trello account behind this key is not Rob's, import the key and token of the member trello-board.json names with scripts/import-trello-key.sh, then reopen Settings.", command: nil, guideURL: setupGuide)
    /// D2-R5: the Trello board is connected by an imported API key, so no row offers a sign-in for it.
    private static let endpointSignInSteps: [String: NativeNextStep] = [:]
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
        NativeNextStep(text: "\(label) has no stored session. Use the Sign in button on its row in Settings once this endpoint is in your connector configuration.", command: nil, guideURL: setupGuide)
    }
    static let credentialSteps: [String: NativeNextStep] = [
        "lux-knowledge": configureStep, "gmail": configureStep, "calendar": configureStep, "mattermost": configureStep,
        "mongoose-knowledge": mongooseCredentialStep("Mongoose knowledge"),
        "mongoose-data": mongooseCredentialStep("Mongoose data"),
        "mongoose-crm": mongooseCredentialStep("Mongoose CRM"),
    ]
    /// The one command that approves a refused connector, verbatim from the CLI's own usage line.
    private static let approveCommand = "node server/dist/config/mcp-cli.js approve --config-dir <config dir> --data-dir <data dir> --owner-id <owner> --policy-input <policy file>"
    /// W2-R1 / F4: the sentence names the exact command and, when the host said which reads an approval
    /// would add, those reads too. Closed tool names only, so nothing a server published can reach it.
    private static func approvalStep(_ added: [String]) -> NativeNextStep {
        let named = added.filter { name in
            guard let first = name.first, first.isLetter, name.count <= 64 else { return false }
            return name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }
        }.prefix(64)
        let reads = named.isEmpty ? "" : " " + named.joined(separator: ", ")
        return NativeNextStep(text: "This connector's tool list changed and needs your approval. Run \(approveCommand) to approve\(reads), then restart Lux Didi.", command: approveCommand, guideURL: mcpGuide)
    }
    /// One fixed sentence per reason code, so no row with a known reason falls back to the failure text.
    private static let reasonSteps: [String: NativeNextStep] = [
        "configuration_error": approvalStep([]),
        "credential_missing": configureStep,
        "not_configured": NativeNextStep(text: "This connector has no configuration yet. Set it in your protected configuration directory, then reopen Settings. See the MCP configuration guide.", command: nil, guideURL: mcpGuide),
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
    static func lookup(id: String, state: String, reason: String?, added: [String] = []) -> NativeNextStep {
        if state == "connected" { return NativeNextStep(text: "no action needed", command: nil) }
        if state == "configured" { return NativeNextStep(text: "a Live session connects on demand", command: nil) }
        if let step = endpointSignInSteps[id], reason == "needs_sign_in" || reason == "not_signed_in" { return step }
        if id == "trello", ["not_configured", "not_signed_in", "needs_sign_in", "credential_revoked", "identity_mismatch"].contains(reason ?? "") { return trelloKeyStep }
        if let label = endpointLabels[id], reason == "needs_sign_in" || reason == "not_signed_in" { return signInStep(label) }
        if let label = endpointLabels[id], reason == "unreachable" { return unreachableStep(label) }
        if state == "missing" || reason == "credential_missing" {
            return credentialSteps[id] ?? configureStep
        }
        // W2-R1 / F4: a refused row names the reads its approval would add, so it cannot be a fixed entry.
        if reason == "configuration_error" { return approvalStep(added) }
        return reasonSteps[reason ?? "unknown"] ?? failureStep
    }
}
