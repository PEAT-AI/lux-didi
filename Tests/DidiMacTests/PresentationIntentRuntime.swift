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
        var visible = Set<String>(), requests: [(PresentationCoordinator.Mode, UInt64)] = []
        let facts = MiniSurfaceFacts(frame: "synthetic", screen: "synthetic", alpha: 1, occluded: false, pageState: "ready")
        let presentation = PresentationCoordinator(showFull: { _ in visible.insert("full") }, hideFull: { visible.remove("full") },
            showMini: { _ in visible.insert("mini"); return .shown(facts) }, hideMini: { _ in visible.remove("mini") },
            liveIsRunning: { false }, prepare: { requests.append(($0, $1)) })
        presentation.presentFull(activating: true)
        presentation.prepared(.full, generation: presentation.generation)
        let fullGeneration = presentation.generation
        presentation.presentMini(trigger: .button)
        precondition(visible == ["full"] && presentation.mode == .full && presentation.desired == .mini)
        presentation.prepared(.mini, generation: presentation.generation, failure: "paint_unavailable")
        precondition(visible == ["full"])
        presentation.presentMini(trigger: .button)
        let staleMini = presentation.generation
        presentation.presentFull(activating: true)
        presentation.prepared(.mini, generation: staleMini)
        precondition(visible == ["full"] && presentation.mode == .full && presentation.generation > fullGeneration)
        presentation.hideAll()
        let count = requests.count
        presentation.requestPresence()
        presentation.prepared(.mini, generation: staleMini)
        precondition(visible.isEmpty && presentation.explicitlyHidden && requests.count == count)
        presentation.allowPresenceReveal()
        presentation.prepared(.full, generation: presentation.generation)
        precondition(visible == ["full"] && presentation.desired == .full)
        presentation.presentMini(trigger: .button)
        presentation.prepared(.mini, generation: presentation.generation)
        precondition(visible == ["mini"] && presentation.mode == .mini)
        let hit = MiniOrbHitView()
        var expansions = 0
        hit.onClick = { presence.toggle(.click) }
        hit.onExpand = { expansions += 1; presentation.presentFull(activating: true) }
        let item = hit.fullInterfaceItem()
        _ = (item.target as? NSObject)?.perform(item.action)
        precondition(expansions == 1 && visible == ["mini"] && opens == 2 && closes == 2)
        presentation.prepared(.full, generation: presentation.generation)
        precondition(visible == ["full"])
        let publication = OrbFramePublication(), recipientA = NSObject(), recipientB = NSObject()
        var sent: [String] = [], completions: [@MainActor () -> Void] = []
        let evaluate: OrbFramePublication.Evaluate = { script, completion in sent.append(script); completions.append(completion) }
        publication.select(ObjectIdentifier(recipientA), generation: 1, evaluate: evaluate)
        publication.offer("first"); publication.offer("discarded"); publication.offer("latest")
        precondition(sent == ["first"])
        completions.removeFirst()()
        precondition(sent == ["first", "latest"])
        publication.select(ObjectIdentifier(recipientB), generation: 2, evaluate: evaluate)
        publication.offer("fresh-recipient")
        precondition(sent.count == 2)
        completions.removeFirst()()
        precondition(sent == ["first", "latest", "fresh-recipient"])
        publication.select(nil, generation: 3, evaluate: nil)
        publication.offer("hidden-discarded")
        completions.removeFirst()()
        precondition(sent.count == 3 && !publication.hasRecipient)
        print("PRESENTATION-HANDOFF PASS source=retained failure=retained stale=ignored explicit-hide=persistent expansion=presentation-only publication=one-inflight-latest-only")
        print("PRESENTATION-INTENTS PASS actual=AppModel start=idempotent mute=fenced unmute=live stop=idempotent connecting=cancelled sockets=0 audio=0")
    }
}
