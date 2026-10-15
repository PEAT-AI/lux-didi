import AppKit
import Foundation

/// Fake-seam proofs for the native bridge contract: encode/decode, queue-until-ready, consent
/// persistence, the requestStart menu route, theme mapping, and the 20 Hz level cap. No window,
/// no web view, no audio device.
@main struct NativeBridgeTests {
    @MainActor static func main() {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }
        func contains(_ lines: [String], _ needle: String) -> Bool { lines.contains { $0.contains(needle) } }

        // 1. Outbound encode: the exact wire type names and payload shape.
        check(BridgeOutbound.requestStart.jsonString == "{\"type\":\"requestStart\"}", "encode requestStart")
        check(BridgeOutbound.requestStop.jsonString == "{\"type\":\"requestStop\"}", "encode requestStop")
        let levelLine = BridgeOutbound.levels(input: [0.1, 0.2], output: [0.3]).jsonString
        check(contains([levelLine], "\"type\":\"levels\"") && contains([levelLine], "\"input\":[") && contains([levelLine], "\"output\":["), "encode batched levels")
        let hydrateLine = BridgeOutbound.hydrate(BridgeHydrate(consent: true, mic: "granted",
            live: BridgeLiveState(state: "live", error: nil, reason: nil), route: BridgeRoute(input: "Mic", output: "Spk", voiceProcessing: false),
            theme: "dark", lastSessionEndedAt: nil, trafficLightsMaxX: 42.5)).jsonString
        check(contains([hydrateLine], "\"type\":\"hydrate\"") && contains([hydrateLine], "\"trafficLightsMaxX\":42.5")
            && contains([hydrateLine], "\"live\":{\"state\":\"live\"}"), "encode hydrate fields")

        // 2. Inbound decode: JSON object bodies and unknown types.
        check(BridgeInbound.decode(["type": "ready"]) == .ready, "decode ready")
        check(BridgeInbound.decode(["type": "start"]) == .start, "decode start")
        check(BridgeInbound.decode(["type": "consentGranted"]) == .consentGranted, "decode consentGranted")
        check(BridgeInbound.decode(["type": "theme", "mode": "light"]) == .theme("light"), "decode theme")
        check(BridgeInbound.decode(["type": "openExternal", "url": "https://example.test"]) == .openExternal("https://example.test"), "decode openExternal")
        check(BridgeInbound.decode(["type": "bogus"]) == .unknown("bogus"), "decode unknown type")
        check(BridgeInbound.decode("{\"type\":\"stop\"}") == .stop, "decode JSON string body")

        // 3. Queue until ready: nothing reaches the web before ready; flush then hydrate after.
        var emitted: [String] = []
        let queueBridge = NativeBridge(consent: ConsentStore(defaults: scratchDefaults("queue")))
        queueBridge.sendJS = { emitted.append($0) }
        queueBridge.hydrateProvider = { .empty }
        queueBridge.pushLiveState(BridgeLiveState(state: "starting", error: nil, reason: nil))
        queueBridge.requestStart()
        check(emitted.isEmpty, "pre-ready messages are queued, not sent")
        queueBridge.handle(["type": "ready"])
        check(emitted.count == 3, "ready flushes the two queued messages then hydrate")
        check(contains(emitted, "\"type\":\"liveState\"") && contains(emitted, "\"type\":\"requestStart\"") && contains(emitted, "\"type\":\"hydrate\""),
              "flush order and hydrate")
        let afterReady = emitted.count
        queueBridge.pushLiveState(BridgeLiveState(state: "live", error: nil, reason: nil))
        check(emitted.count == afterReady + 1, "post-ready messages go straight out")
        queueBridge.markReload()
        queueBridge.pushLiveState(BridgeLiveState(state: "idle", error: nil, reason: nil))
        check(emitted.count == afterReady + 1, "after reload, messages are held again")

        // 4. Consent persistence: consentGranted writes the UserDefaults key.
        let consentDefaults = scratchDefaults("consent")
        let consentBridge = NativeBridge(consent: ConsentStore(defaults: consentDefaults))
        check(consentBridge.consent.granted == false, "consent starts ungranted")
        consentBridge.handle(["type": "consentGranted"])
        check(consentDefaults.bool(forKey: "liveConsentGranted"), "consentGranted persists liveConsentGranted")
        check(ConsentStore(defaults: consentDefaults).granted, "persisted consent is readable")
        consentDefaults.removePersistentDomain(forName: scratchDefaultsSuite("consent"))

        // 5. The menu target emits requestStart and has no route to the capture path.
        var bridgeCommands: [BridgeInbound] = []
        let menuBridge = NativeBridge(consent: ConsentStore(defaults: scratchDefaults("menu")))
        var menuEmitted: [String] = []
        menuBridge.sendJS = { menuEmitted.append($0) }
        menuBridge.hydrateProvider = { .empty }
        menuBridge.onCommand = { bridgeCommands.append($0) }
        menuBridge.handle(["type": "ready"])
        menuEmitted.removeAll()
        bridgeCommands.removeAll()
        let menu = NativeMenuBridge(bridge: menuBridge)
        menu.start()
        check(contains(menuEmitted, "\"type\":\"requestStart\""), "menu Start emits requestStart")
        check(menuEmitted.count == 1, "menu Start emits only requestStart")
        check(bridgeCommands.isEmpty, "menu Start is not re-dispatched as a capture command")
        menuEmitted.removeAll()
        menu.stop()
        check(contains(menuEmitted, "\"type\":\"requestStop\"") && menuEmitted.count == 1, "menu Stop emits only requestStop")

        // 6. Theme maps to window appearance and background.
        check(BridgeTheme.dark.appearanceName == .darkAqua, "dark theme maps to darkAqua")
        check(BridgeTheme.light.appearanceName == .aqua, "light theme maps to aqua")
        check(BridgeTheme.dark.backgroundColor != BridgeTheme.light.backgroundColor, "themes differ in background")
        var themeEvents: [BridgeTheme] = []
        let themeBridge = NativeBridge(consent: ConsentStore(defaults: scratchDefaults("theme")))
        themeBridge.sendJS = { _ in }
        themeBridge.onTheme = { themeEvents.append($0) }
        themeBridge.handle(["type": "theme", "mode": "light"])
        check(themeEvents == [.light] && themeBridge.theme == .light, "web theme sets the native theme")

        // 7. Level cap: at most 20 batches per second, and samples accumulate instead of dropping.
        var batcher = LevelBatcher()
        var batches = 0
        for step in 0..<1000 {
            let now = Double(step) / 1000.0
            if batcher.offer(input: Double(step), output: Double(step), now: now) != nil { batches += 1 }
        }
        check(batches == 20, "1000 samples over one second yield 20 batches (got \(batches))")
        var batcher2 = LevelBatcher()
        let first = batcher2.offer(input: 1, output: 2, now: 0)
        let held = batcher2.offer(input: 3, output: 4, now: 0.01)
        let rest = batcher2.offer(input: 5, output: 6, now: 0.06)
        check(first?.input == [1] && first?.output == [2] && held == nil && rest?.input == [3, 5] && rest?.output == [4, 6],
              "samples batch into arrays without dropping")

        // 8. Conversation state maps onto the bridge vocabulary.
        check(BridgeLiveStateMapping.state(from: "connecting") == "starting", "connecting maps to starting")
        check(BridgeLiveStateMapping.state(from: "listening") == "live", "listening maps to live")
        check(BridgeLiveStateMapping.state(from: "muted") == "muted", "muted maps to muted")
        check(BridgeLiveStateMapping.state(from: "failed") == "error", "failed maps to error")
        check(BridgeLiveStateMapping.error(from: "failed") == "providerError", "failed carries providerError")

        // 9. Route sentence parses into input/output.
        let route = BridgeRoute.parse("Microphone: Studio Mic · Output: Built-in Speakers")
        check(route?.input == "Studio Mic" && route?.output == "Built-in Speakers", "route sentence parses")
        check(BridgeRoute.parse("") == nil, "empty route is nil")

        print(failures == 0 ? "NATIVE-BRIDGE TESTS PASS" : "NATIVE-BRIDGE TESTS FAILED \(failures)")
        exit(failures == 0 ? 0 : 1)
    }

    @MainActor static func scratchDefaultsSuite(_ name: String) -> String { "lux-didi-native-bridge-tests-\(name)" }
    @MainActor static func scratchDefaults(_ name: String) -> UserDefaults {
        let suite = scratchDefaultsSuite(name)
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }
}
