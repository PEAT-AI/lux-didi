import AppKit

@main enum PresentationIntentRuntime {
    @MainActor static func main() async throws {
        setbuf(stdout, nil)
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
        if let origin = CommandLine.arguments.dropFirst().first {
            try await verifyAssignedPageState(origin: origin, model: model)
        }
        print("PRESENTATION-HANDOFF PASS source=retained failure=retained stale=ignored explicit-hide=persistent expansion=presentation-only publication=one-inflight-latest-only")
        print("PRESENTATION-INTENTS PASS actual=AppModel start=idempotent mute=fenced unmute=live stop=idempotent connecting=cancelled sockets=0 audio=0")
    }
    @MainActor static func verifyAssignedPageState(origin: String, model: AppModel) async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let descriptor = try ServiceDescriptor(origin: origin, credentialService: "synthetic", credentialAccount: "synthetic")
        let cookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "didi", .value: "test-only"])!
        let full = CompanionWeb(descriptor: descriptor), mini = CompanionWeb(descriptor: descriptor, route: .mini)
        full.webView.frame = CGRect(x: 0, y: 0, width: 980, height: 760)
        mini.webView.frame = CGRect(x: 0, y: 0, width: 220, height: 220)
        var fullEvents: [PageState] = [], miniEvents: [PageState] = []
        var currentMini: CompanionWeb? = mini
        let fullObserver = CompanionPageObservation(current: { model.shell }, changed: { shell in
            precondition(model.shell === shell)
            fullEvents.append(shell.state)
            shell.setSurfaceVisible(shell.state == .ready, generation: 9)
        })
        let miniObserver = CompanionPageObservation(current: { currentMini }, changed: { shell in
            miniEvents.append(shell.state)
            shell.setSurfaceVisible(shell.state == .ready, generation: 9)
        })
        model.onShellChanged = { fullObserver.bind(model.shell) }
        model.shell = full
        miniObserver.bind(mini)
        for shell in [full, mini] {
            await shell.load(cookie: cookie)
            let deadline = ContinuousClock.now + .seconds(6)
            while shell.state == .loading, ContinuousClock.now < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
            precondition(shell.state == .ready && shell.surfaceVisible)
            do { try await shell.prepareForPresentation(generation: 9) }
            catch {
                let proof = try? await shell.webView.evaluateJavaScript("JSON.stringify({type:typeof window.didiPrepareSurface,state:document.readyState,canvas:!!document.getElementById('didi-orb'),href:location.href})")
                print("PAGE-PREPARE-DIAGNOSTIC \(String(describing: proof))")
                throw error
            }
        }
        precondition(fullEvents.contains(.loading) && fullEvents.contains(.ready))
        precondition(miniEvents.contains(.loading) && miniEvents.contains(.ready))
        var accepted = 0
        for shell in [full, mini] {
            shell.publishOrb("window.fixturePublication=(window.fixturePublication||0)+1", generation: 9) { accepted += 1 }
        }
        while accepted != 2 { try await Task.sleep(nanoseconds: 10_000_000) }
        for shell in [full, mini] { let value = try await shell.webView.evaluateJavaScript("window.fixturePublication"); precondition(value as? Int == 1) }
        _ = try await full.webView.evaluateJavaScript("window.savedPaint=window.didiPrepareSurface;delete window.didiPrepareSurface;window.fixturePaintCalls=0")
        let cancelled = Task { try await full.prepareForPresentation(generation: 9) }
        try await Task.sleep(nanoseconds: 30_000_000)
        cancelled.cancel()
        do { try await cancelled.value; preconditionFailure("cancelled preparation must not paint") }
        catch is CancellationError {}
        _ = try await full.webView.evaluateJavaScript("window.didiPrepareSurface=g=>{window.fixturePaintCalls++;return window.savedPaint(g)};null")
        let calls = try await full.webView.evaluateJavaScript("window.fixturePaintCalls")
        precondition(calls as? Int == 0)
        full.clear(); mini.clear()
        precondition(!full.surfaceVisible && !mini.surfaceVisible)
        for shell in [full, mini] {
            await shell.load(cookie: cookie)
            let deadline = ContinuousClock.now + .seconds(6)
            while shell.state == .loading, ContinuousClock.now < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
            precondition(shell.state == .ready && shell.surfaceVisible)
        }
        let readyBefore = fullEvents.count
        model.shell = nil
        model.shell = full
        precondition(fullEvents.count == readyBefore + 1 && fullEvents.last == .ready)
        let replacement = CompanionWeb(descriptor: descriptor)
        model.shell = replacement
        currentMini = nil
        let fullBefore = fullEvents.count, miniBefore = miniEvents.count
        full.clear(); mini.clear()
        precondition(fullEvents.count == fullBefore && miniEvents.count == miniBefore)
        model.onShellChanged = nil; model.shell = nil
        print("PAGE-STATE-OWNER PASS actual=AppModel+CompanionWeb full=assigned-ready mini=assigned-ready reload=ready fail=stopped initial-ready=bound stale-shell=ignored native-publication=accepted cancellation=no-paint windows=0 audio=0")
        withExtendedLifetime((fullObserver, miniObserver)) {}
    }

}
