import Foundation

private actor Probe {
    var opens = 0
    var connects = 0
    func opened() { opens += 1 }
    func connected() { connects += 1 }
}
private actor Socket: LiveSocket {
    func receive() async throws -> LiveFrame { throw LiveClientError.unavailable }
    func sendPCM(_ data: Data) async throws { fatalError("canary must not capture audio") }
    func sendPCMReportingShed(_ data: Data) async throws -> Bool { fatalError("canary must not capture audio") }
    func sendControl(_ control: LiveControl) async throws {}
    func sendControl(_ control: LiveControl, reason: String?) async throws {}
    func sendReceipt(_ frame: String) async throws {}
    func cancel() async {}
}
private struct Sockets: LiveSocketConnecting {
    let probe: Probe
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket {
        await probe.connected()
        return Socket()
    }
}
@main struct CanaryNativeProof {
    static func main() async throws {
        let probe = Probe()
        let actions = NativeActions(opener: { _, _ in await probe.opened(); return true })
        let wire = "{\"type\":\"native_action\",\"id\":\"canary-proof\",\"action\":\"canary_ack\",\"target\":\"https://example.com\"}"
        guard let frame = NativeActionFrame.control(wire) else { fatalError("canary frame rejected") }
        let result = await actions.perform(frame.action, target: frame.target)
        precondition(result.code == .opened)
        let opens = await probe.opens
        precondition(opens == 0, "canary must never call a workspace opener")
        let intent = LiveBeginIntent(origin: URL(string: "http://127.0.0.1:12345")!, assistantID: "synthetic", authorityEpoch: "epoch", provider: "gemini", model: "synthetic", voice: "synthetic", profileIdentity: "profile", inputClass: "ordinary")
        let grant = LiveGrant(provider: "gemini", model: "synthetic", voice: "synthetic", chosenInputClass: "ordinary", permittedClasses: ["ordinary"], revision: 1)
        func snapshot(_ key: String) -> LiveSnapshot {
            LiveSnapshot(liveSessionId: "11111111-1111-4111-8111-111111111111", assistantId: "synthetic", authorityEpoch: "epoch", idempotencyKey: key, profileIdentity: "profile", grant: grant, lifecycle: "accepted", dispatchIntent: false, consumerState: "unclaimed", terminal: nil)
        }
        _ = try await LiveSessionCoordinator.attachCanary(intent, snapshot: snapshot("canary:proof"), sockets: Sockets(probe: probe))
        let connects = await probe.connects
        precondition(connects == 1)
        do {
            _ = try await LiveSessionCoordinator.attachCanary(intent, snapshot: snapshot("ordinary"), sockets: Sockets(probe: probe))
            fatalError("ordinary snapshots cannot use canary attachment")
        } catch LiveClientError.invalidFrame {}
        let after = await probe.connects
        precondition(after == 1)
        print("CANARY NATIVE PASS ackWithoutOpen=true textOnlyAttachment=true ordinaryRejected=true")
    }
}
