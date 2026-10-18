import Foundation

// Fixed instructions only. No provider payload can become a command or label.
struct NativeNextStep {
    let text: String
    let command: String?
    var guideURL: URL? = nil
}
enum NativeNextSteps {
    static let connectorIDs = ["lux-knowledge", "gmail", "calendar", "mattermost", "mongoose"]
    static let reasonCodes = ["credential_missing", "unreachable", "discovery_failed", "handshake_failed", "unknown"]
    static let credentialSteps: [String: NativeNextStep] = [
        "lux-knowledge": NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")),
        "gmail": NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")),
        "calendar": NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")),
        "mattermost": NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")),
        "mongoose": NativeNextStep(text: "Mongoose session expired, reconnect Mongoose: sign in once in your browser, then restart Lux Didi.", command: "mongoose-login", guideURL: URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup")),
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
            return table[id]?["credential_missing"] ?? NativeNextStep(text: "Configure this connector and its credentials in your explicitly selected protected configuration directory. Use the Setup guide, then restart Lux Didi.", command: nil, guideURL: URL(string: "https://github.com/PEAT-AI/lux-didi/blob/main/docs/user-guide.md#connector-setup"))
        }
        return table[id]?[reason ?? "unknown"] ?? failureStep
    }
}
