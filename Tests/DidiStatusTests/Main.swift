import Foundation

/// Fake sinks only: no application, notification center, status item or window is created.
@main struct StatusQuietTests {
    @MainActor static func main() async {
        let ours = NativeHostRecord(pid: 42, identity: NativeHostIdentity(executable: "/bundle/node", startedSeconds: 10, startedMicroseconds: 1))
        let stale = HostProcessFake(record: ours)
        let recovered = NativeHostReaper.reap(record: ours, expectedExecutable: "/bundle/node",
            inspect: stale.inspect, alive: stale.alive, signal: stale.signal,
            pause: stale.pause, remove: stale.remove, confirmDeath: true)
        precondition(recovered == .reaped && stale.signals == [SIGTERM, SIGKILL] && stale.removed)
        let foreign = HostProcessFake(record: NativeHostRecord(pid: 42,
            identity: NativeHostIdentity(executable: "/foreign/process", startedSeconds: 20, startedMicroseconds: 0)))
        let foreignResult = NativeHostReaper.reap(record: ours, expectedExecutable: "/bundle/node",
            inspect: foreign.inspect, alive: foreign.alive, signal: foreign.signal,
            pause: foreign.pause, remove: foreign.remove, confirmDeath: true)
        precondition(foreignResult == .foreign && foreign.signals.isEmpty && !foreign.removed)
        let reused = HostProcessFake(record: NativeHostRecord(pid: 42,
            identity: NativeHostIdentity(executable: "/bundle/node", startedSeconds: 99, startedMicroseconds: 0)))
        precondition(NativeHostReaper.reap(record: ours, expectedExecutable: "/bundle/node",
            inspect: reused.inspect, alive: reused.alive, signal: reused.signal,
            pause: reused.pause, remove: reused.remove, confirmDeath: true) == .foreign)
        precondition(reused.signals.isEmpty && !reused.removed, "PID reuse must never signal another process")
        let forcedHost = HostProcessFake(record: ours)
        let quit = NativeQuitDeadline()
        let forced = QuitTestResults()
        var deadline: (@Sendable () -> Void)?
        var bound: Double = 0
        precondition(quit.request(schedule: { seconds, callback in bound = seconds; deadline = callback },
                                  forced: { stage in
                                      _ = NativeHostReaper.reap(record: ours, expectedExecutable: "/bundle/node",
                                          inspect: forcedHost.inspect, alive: forcedHost.alive, signal: forcedHost.signal,
                                          pause: forcedHost.pause, remove: {}, confirmDeath: false)
                                      forced.append(stage)
                                  }))
        precondition(bound == 2.5, "leave 300 ms for host cleanup inside the three-second bound")
        let hanging = HangingShutdownModel()
        let hangingTask = Task { await hanging.shutdown(); return quit.complete() }
        await hanging.waitUntilStarted()
        quit.stage(.logout)
        deadline?() // Advance the fake clock, never wait for real time.
        precondition(forced.values == [.logout], "deadline must exit despite suspended shutdown")
        precondition(forcedHost.signals == [SIGTERM, SIGKILL] && forcedHost.pauses == 1,
                     "forced exit must signal the owned host first")
        hanging.release()
        let late = await hangingTask.value
        precondition(!late, "late completion must not issue another exit")
        let fast = NativeQuitDeadline()
        var fastDeadline: (@Sendable () -> Void)?
        precondition(fast.request(schedule: { _, callback in fastDeadline = callback }, forced: { forced.append($0) }))
        precondition(fast.complete(), "fast shutdown should exit cleanly")
        precondition(forced.values == [.logout], "fast shutdown must take the clean exit path")
        // In production an exited process cannot run its timer. If final AppKit cleanup hangs,
        // the same deadline remains armed rather than losing the hard exit guarantee.
        fastDeadline?()
        precondition(forced.values == [.logout, .applicationExit])
        let repeated = NativeQuitDeadline()
        var timers = 0
        precondition(repeated.request(schedule: { _, _ in timers += 1 }, forced: { forced.append($0) }))
        precondition(!repeated.request(schedule: { _, _ in timers += 1 }, forced: { forced.append($0) }))
        precondition(timers == 1 && forced.values == [.logout, .applicationExit, .secondQuit], "second Quit exits immediately")
        var menu = StatusMenuTracking()
        var receipts: [(String, Int, Int)] = []
        for _ in 0..<20 { menu.requested { receipts.append(($0, $1, $2)) } }
        precondition(receipts.last?.0 == "menu_open_requested" && receipts.last?.1 == 20 && receipts.last?.2 == 0)
        menu.opened { receipts.append(($0, $1, $2)) }
        precondition(receipts.last?.0 == "menu_opened" && receipts.last?.1 == 20 && receipts.last?.2 == 1)
        let screen = CGRect(x: -1200, y: 0, width: 1200, height: 900)
        let safe = MiniOrbMenuSafety.availableFrame(screen: screen, visible: screen, menuBarHeight: 24)
        precondition(safe.maxY == 876 && safe.minX == -1200)
        let ordinary = CGRect(x: -1200, y: 50, width: 1200, height: 826)
        precondition(MiniOrbMenuSafety.availableFrame(screen: screen, visible: ordinary, menuBarHeight: 24) == ordinary)
        let placement = MiniOrbFrameRestore.resolve(CGRect(x: -300, y: 800, width: 220, height: 220), screens: [safe])
        precondition(placement.maxY <= safe.maxY, "orb cannot overlap menu strip even in fullscreen")
        var responses = 0
        let response = NonModalAlertResponse { _ in responses += 1 }
        response.answer(true)
        response.answer(false)
        precondition(responses == 1, "nonmodal alert completion must be one-shot")
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

private final class QuitTestResults: @unchecked Sendable {
    private let lock = NSLock()
    private var stages: [NativeQuitStage] = []
    var values: [NativeQuitStage] { lock.lock(); defer { lock.unlock() }; return stages }
    func append(_ stage: NativeQuitStage) { lock.lock(); defer { lock.unlock() }; stages.append(stage) }
}

@MainActor private final class HangingShutdownModel {
    private var shutdownContinuation: UnsafeContinuation<Void, Never>?
    private var startedContinuation: CheckedContinuation<Void, Never>?
    func shutdown() async {
        await withUnsafeContinuation { continuation in
            shutdownContinuation = continuation
            startedContinuation?.resume(); startedContinuation = nil
        }
    }
    func waitUntilStarted() async {
        if shutdownContinuation != nil { return }
        await withCheckedContinuation { startedContinuation = $0 }
    }
    func release() { shutdownContinuation?.resume(); shutdownContinuation = nil }
}

private final class HostProcessFake: @unchecked Sendable {
    private let lock = NSLock()
    private var process: NativeHostRecord?
    private var sent: [Int32] = []
    private var waits = 0
    private var fileRemoved = false
    init(record: NativeHostRecord) { process = record }
    var signals: [Int32] { lock.lock(); defer { lock.unlock() }; return sent }
    var pauses: Int { lock.lock(); defer { lock.unlock() }; return waits }
    var removed: Bool { lock.lock(); defer { lock.unlock() }; return fileRemoved }
    func inspect(_ pid: Int32) -> NativeHostIdentity? { lock.lock(); defer { lock.unlock() }; return process?.identity }
    func alive(_ pid: Int32) -> Bool { lock.lock(); defer { lock.unlock() }; return process != nil }
    func signal(_ pid: Int32, _ signal: Int32) { lock.lock(); defer { lock.unlock() }; sent.append(signal); if signal == SIGKILL { process = nil } }
    func pause() { lock.lock(); defer { lock.unlock() }; waits += 1 }
    func remove() { lock.lock(); defer { lock.unlock() }; fileRemoved = true }
}
