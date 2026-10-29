import Foundation

/// Fake sinks only: no application, notification center, status item or window is created.
@main struct StatusQuietTests {
    @MainActor static func main() async {
        let source = FakeCapabilitySource()
        let capability = NativeNotificationCapabilityState(source: { await source.read() })
        _ = await capability.refresh(for: .launch)
        precondition(source.queries == 1)
        for _ in 0..<20 {
            let value = await capability.refresh(for: .poll)
            precondition(value == .authorized)
        }
        precondition(source.queries == 1, "polls must not query notification settings")
        source.value = .denied
        let activated = await capability.refresh(for: .didBecomeActive)
        precondition(source.queries == 2 && activated == .denied)
        for _ in 0..<20 { _ = await capability.refresh(for: .poll) }
        precondition(source.queries == 2)
        _ = await capability.refresh(for: .didBecomeActive)
        precondition(source.queries == 3, "each activation refreshes exactly once")
        _ = await capability.refresh(for: .permissionChanged)
        precondition(source.queries == 4)
        var jobs: [NativePendingLiveJob] = []
        var error: String?
        var publishes = 0
        let ready = NativePendingLiveJob(id: "fake-call", state: "completed", markdown: "ready")
        func poll(_ next: [NativePendingLiveJob], _ nextError: String?) {
            StatusQuiet.publish(current: jobs, next: next) { jobs = $0; publishes += 1 }
            StatusQuiet.publish(current: error, next: nextError) { error = $0; publishes += 1 }
        }
        poll([ready], nil)
        precondition(publishes == 1)
        for _ in 0..<20 { poll([ready], nil) }
        precondition(publishes == 1, "identical results must not publish")
        poll([NativePendingLiveJob(id: ready.id, state: ready.state, markdown: "changed")], nil)
        precondition(publishes == 2, "compare all call fields, not just IDs")
        poll([], "offline")
        precondition(publishes == 4)
        for _ in 0..<20 { poll([], "offline") }
        precondition(publishes == 4, "identical errors must not publish")
        poll([], nil)
        precondition(publishes == 5, "recovery must publish")

        var item = QuietStatusItem()
        var title = ""
        var tip: String?
        var imageWrites = 0, titleWrites = 0, tipWrites = 0
        func render(_ symbol: String = "mic", _ text: String = "Ready", _ nextTitle: String = "Didi") {
            item.update(symbol: symbol, text: text, title: nextTitle,
                        currentTitle: title, currentToolTip: tip,
                        image: { _ in imageWrites += 1 },
                        setTitle: { title = $0; titleWrites += 1 },
                        toolTip: { tip = $0; tipWrites += 1 })
        }
        render()
        precondition(imageWrites == 1 && titleWrites == 1 && tipWrites == 1)
        for _ in 0..<20 { render() }
        precondition(imageWrites == 1 && titleWrites == 1 && tipWrites == 1,
                     "identical ticks must not touch the status button")
        render("mic", "Ready", "Callback")
        precondition(imageWrites == 1 && titleWrites == 2 && tipWrites == 1)
        render("mic.fill", "Ready", "Callback")
        precondition(imageWrites == 2 && titleWrites == 2 && tipWrites == 1)
        render("mic.fill", "Listening", "Callback")
        precondition(imageWrites == 3 && titleWrites == 2 && tipWrites == 2)

        var ignores = false
        var orbWrites = 0
        let frame = CGRect(x: 100, y: 100, width: 220, height: 220)
        func hover(_ point: CGPoint, visible: Bool = true) {
            let next = MiniOrbClickThrough.ignoresMouse(isVisible: visible, at: point, in: frame)
            StatusQuiet.publish(current: ignores, next: next) { ignores = $0; orbWrites += 1 }
        }
        for _ in 0..<20 { hover(CGPoint(x: 210, y: 210)) }
        precondition(orbWrites == 0, "identical inside hover events must not write")
        hover(CGPoint(x: 101, y: 101))
        precondition(orbWrites == 1 && ignores)
        for _ in 0..<20 { hover(CGPoint(x: 101, y: 101)) }
        precondition(orbWrites == 1, "identical outside hover events must not write")
        hover(CGPoint(x: 210, y: 210))
        precondition(orbWrites == 2 && !ignores)
        hover(CGPoint(x: 101, y: 101))
        hover(CGPoint(x: 101, y: 101), visible: false)
        precondition(orbWrites == 4 && !ignores, "hidden panel resets click-through once")
        print("STATUS-QUIET PASS identicalTicks=20 fieldChanges=true errors=true orb=true headless=true")
    }
}

@MainActor private final class FakeCapabilitySource {
    var queries = 0
    var value: NotificationCapability = .authorized
    func read() async -> NotificationCapability { queries += 1; return value }
}
