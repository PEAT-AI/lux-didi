import AppKit

@main enum PresentationIntentRuntime {
    @MainActor static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("didi-intents-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let descriptor = try ServiceDescriptor(origin: "http://127.0.0.1:19997", credentialService: "synthetic", credentialAccount: "synthetic")
        let client = CompanionClient(descriptor: descriptor, credential: { "synthetic-only" })
        let model = AppModel(fixtureClient: client, fixtureOutbox: directory)
        var opens = 0, closes = 0, fences: [Bool] = []
        let presence = NativePresence(effects: PresenceEffects(
            openSession: { opens += 1 }, cancelConnecting: { closes += 1 }, closeSession: { closes += 1 },
            setCaptureMuted: { fences.append($0) }))
        model.bindPresence(presence, start: { _ in presence.start(.app) })
        model.handleBridgeCommand(.start)
        model.handleBridgeCommand(.start)
        precondition(presence.state == .connecting && opens == 1)
        presence.ready()
        model.handleBridgeCommand(.mute)
        precondition(presence.state == .hotMuted && fences == [false, true])
        model.handleBridgeCommand(.unmute)
        precondition(presence.state == .live && fences == [false, true, false])
        model.handleBridgeCommand(.stop)
        model.handleBridgeCommand(.stop)
        precondition(presence.state == .cold && closes == 1)
        model.handleBridgeCommand(.start)
        model.handleBridgeCommand(.stop)
        precondition(presence.state == .cold && opens == 2 && closes == 2)
        print("PRESENTATION-INTENTS PASS actual=AppModel start=idempotent mute=fenced unmute=live stop=idempotent connecting=cancelled sockets=0 audio=0")
    }
}
