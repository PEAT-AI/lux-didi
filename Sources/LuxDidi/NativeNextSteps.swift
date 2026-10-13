import Foundation

// Fixed instructions only. No provider payload can become a command or label.
struct NativeNextStep {
    let text: String
    let command: String?
}
enum NativeNextSteps {
    static let connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose"]
    static let reasonCodes = ["credential_missing", "unreachable", "discovery_failed", "handshake_failed", "unknown"]
    static let credentialSteps: [String: NativeNextStep] = [
        "lux-knowledge": NativeNextStep(text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi.", command: nil),
        "gmail": NativeNextStep(text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi.", command: nil),
        "calendar": NativeNextStep(text: "In /Users/rob/GitHub/lux-cli run uv run --package lux-gcal gcal --auth, finish browser sign-in, then restart Lux Didi.", command: "cd /Users/rob/GitHub/lux-cli && uv run --package lux-gcal gcal --auth"),
        "mattermost": NativeNextStep(text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi.", command: nil),
        "mongoose": NativeNextStep(text: "Add ~/Library/Application Support/ai.peat.lux-didi/provider-38/mongoose-mcp.json; see RUNBOOK-connectors.md (RUNBOOK), then restart Lux Didi.", command: nil),
    ]
    static let failureStep = NativeNextStep(text: "Check the connector service, then use Copy diagnostics from the Lux Didi menu.", command: nil)
    static let table: [String: [String: NativeNextStep]] = Dictionary(uniqueKeysWithValues: connectorIDs.map { id in
        (id, Dictionary(uniqueKeysWithValues: reasonCodes.map { reason in
            (reason, reason == "credential_missing" ? credentialSteps[id]! : failureStep)
        }))
    })
    static func lookup(id: String, state: String, reason: String?) -> NativeNextStep {
        if state == "connected" { return NativeNextStep(text: "no action needed", command: nil) }
        if state == "configured" { return NativeNextStep(text: "a Live session connects on demand", command: nil) }
        if state == "missing" || reason == "credential_missing" {
            return table[id]?["credential_missing"] ?? NativeNextStep(text: "Add the connector credential under the effective data directory; see RUNBOOK, then restart Lux Didi.", command: nil)
        }
        return table[id]?[reason ?? "unknown"] ?? failureStep
    }
}
