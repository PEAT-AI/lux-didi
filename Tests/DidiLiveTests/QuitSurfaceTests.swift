import AppKit
import Foundation

/// C-QUIT: the status item is reachable and clickable from any app, and Quit finishes inside its
/// budget without the forced path. Synthetic only: no app is launched or activated, no window is
/// shown, no audio device is opened and no installed host is contacted.
@main struct QuitSurfaceTests {
    /// The virtual clock and scheduler the quit watchdog is driven by, so a 3 s net costs no wall time.
    final class FakeClock {
        var now: Double = 0
        private(set) var armed: [(seconds: Double, fire: @Sendable () -> Void)] = []
        func schedule(_ seconds: Double, _ fire: @escaping @Sendable () -> Void) { armed.append((seconds, fire)) }
        /// Advance to `target` seconds and fire every arm whose time has come, in order.
        func advance(to target: Double) {
            now = target
            for arm in armed where arm.seconds <= target { arm.fire() }
            armed.removeAll { $0.seconds <= target }
        }
    }

    final class FakeTarget: NSObject {
        var taps: [String] = []
        @objc func quit() { taps.append("quit") }
        @objc func startLiveFromMenu() { taps.append("start") }
        @objc func stopLiveFromMenu() { taps.append("stop") }
        @objc func muteLiveFromMenu() { taps.append("mute") }
    }

    /// The deadline reports from whichever queue it fires on, so the collected lines are locked.
    final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [StatusSurfaceReceipt] = []
        var receipts: [StatusSurfaceReceipt] { lock.lock(); defer { lock.unlock() }; return lines }
        func add(_ receipt: StatusSurfaceReceipt) { lock.lock(); lines.append(receipt); lock.unlock() }
    }

    @MainActor static func main() {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }

        // (a) The item is visible without the symbol, and the menu is built with its target and action
        // already set: nothing here activates the app or waits for one.
        let symbol = StatusItemPresentation.resolve(symbol: NSImage(size: NSSize(width: 16, height: 16)))
        check(symbol.image != nil && symbol.state == .ok && symbol.title.isEmpty,
              "a symbol image keeps the item an image and needs no title")
        let missing = StatusItemPresentation.resolve(symbol: nil)
        check(missing.image == nil && missing.state == .fallback && missing.title == StatusItemPresentation.fallbackTitle,
              "a nil symbol falls back to the text title instead of a blank, unclickable item")
        check(StatusItemPresentation.length > 0, "the status item length is a fixed positive width")
        let liveImage = NSImage(size: NSSize(width: 16, height: 16))
        check(StatusItemPresentation.title(preferred: "", image: liveImage).isEmpty,
              "with an image the item shows the image alone, no letter beside it")
        check(StatusItemPresentation.title(preferred: "", image: nil) == StatusItemPresentation.fallbackTitle,
              "a later live update with no image still carries the fallback letter instead of going blank")
        check(StatusItemPresentation.title(preferred: "\u{2022}", image: nil) == "\u{2022}",
              "an alarm caption or live badge outranks the fallback letter")

        let target = FakeTarget()
        let menu = NSMenu()
        for entry in [StatusMenuEntry.start, .mute, .stop, .quit] { StatusMenuPlan.add(entry, to: menu, target: target) }
        check(menu.items.map(\.title) == ["Start Live", "Mute", "Stop", "Quit Naya"],
              "the status item menu carries Start, Mute, Stop and Quit Naya")
        check(menu.items.allSatisfy { $0.target === target },
              "every action item carries its target at build time, so a click needs no activation")
        let quit = menu.items.first { $0.title == "Quit Naya" }
        check(quit?.action == NSSelectorFromString("quit"), "the Quit item carries the quit action")
        check(menu.items.first { $0.title == "Start Live" }?.action == NSSelectorFromString("startLiveFromMenu"),
              "the Start item carries the start action, so Start is reachable from the same menu")
        if let quit, let action = quit.action { _ = quit.target?.perform(action) }
        check(target.taps == ["quit"], "the Quit item runs its target without app activation")

        // (c) Every receipt reaches the native file log itself, not os Logger only.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("quit-surface-\(UUID().uuidString)")
        let url = directory.appendingPathComponent("native-live.log")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = NativeLiveJournal(fileURL: url)
        journal.appendSurfaceReceipt(StatusItemPresentation.state(button: nil))
        journal.appendSurfaceReceipt(StatusSurfaceReceipt(event: .statusClick, facts: ["hit": .word("button")]))
        journal.appendSurfaceReceipt(StatusSurfaceReceipt(event: .statusClick, facts: ["hit": .word("other")]))
        journal.appendSurfaceReceipt(StatusSurfaceReceipt(event: .menuOpenRequested, facts: [:]))
        journal.appendSurfaceReceipt(StatusSurfaceReceipt(event: .menuOpened, facts: [:]))
        journal.appendSurfaceReceipt(StatusMenuEntry.start.receipt)
        journal.appendSurfaceReceipt(StatusMenuEntry.quit.receipt)
        let lines = ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
        let events = lines.compactMap { $0["event"] as? String }
        check(events == ["status_item_state", "status_click", "status_click", "menu_open_requested", "menu_opened",
                         "menu_item", "menu_item"],
              "the status item's own receipts land in the native file log, in order")
        check(lines.first?["visible"] as? Bool == false && lines.first?["image"] as? String == "nil",
              "a status item with no button is written down as invisible rather than assumed present")
        check(lines[1]["hit"] as? String == "button" && lines[2]["hit"] as? String == "other",
              "each status click names whether it hit the button")
        check(lines.count == 7 && lines[6]["item"] as? String == "quit",
              "a menu click names its item, so Quit from the status item is on record")

        // (b) A host that answers the stop request finishes the whole quit well inside 1.5 s and
        // never reaches the forced path.
        let clock = FakeClock()
        let deadline = NativeQuitDeadline(clock: { clock.now })
        let collected = Collector()
        let forcedCalls = Collector()
        let first = deadline.request(schedule: { seconds, fire in clock.schedule(seconds, fire) },
                                     forced: { stage in
                                         forcedCalls.add(NativeQuitDeadline.forcedReceipt(stage))
                                     },
                                     report: { collected.add($0) })
        check(first && clock.armed.map(\.seconds) == [NativeQuitDeadline.deadline],
              "the safety net is armed once, at three seconds")
        // The ordered shutdown: audio, logout, page session, then a host that exits on stop.
        for stage in [NativeQuitStage.audio, .logout, .webSession, .host] {
            clock.now += 0.02
            deadline.stage(stage)
        }
        clock.now += 0.02
        let cleanAt = clock.now
        check(deadline.complete(), "a shutdown whose host exits completes cleanly")
        check(cleanAt < 1.5, "the shutdown finished inside the 1.5 s budget before the net came due")
        clock.advance(to: 1.5)
        let receipts = collected.receipts
        let stageReceipts = receipts.filter { $0.event == .quitStage }
        check(stageReceipts.count == 6,
              "every shutdown stage transition is written with its own line")
        check(stageReceipts.last?.facts["stage"] == .word("applicationExit"),
              "the clean quit ends on the applicationExit stage")
        check(stageReceipts.allSatisfy { $0.facts["ms"] != nil },
              "every stage line carries its elapsed milliseconds")
        check(!receipts.contains { $0.event == .quitForced } && forcedCalls.receipts.isEmpty,
              "a clean quit writes no quit_forced line and takes no forced path")

        // A host that never answers the stop request still ends at the net, with the line on record.
        let hungClock = FakeClock()
        let hung = NativeQuitDeadline(clock: { hungClock.now })
        let hungCollected = Collector()
        let hungForced = Collector()
        _ = hung.request(schedule: { seconds, fire in hungClock.schedule(seconds, fire) },
                         forced: { stage in hungForced.add(NativeQuitDeadline.forcedReceipt(stage)) },
                         report: { hungCollected.add($0) })
        for stage in [NativeQuitStage.audio, .logout, .webSession, .host] {
            hungClock.now += 0.02
            hung.stage(stage)
        }
        check(hungCollected.receipts.last?.facts["stage"] == .word("host"),
              "the stalled stage is named: the host stop")
        hungClock.advance(to: NativeQuitDeadline.deadline)
        check(hungForced.receipts.map { $0.facts["stage"] } == [.word("host")],
              "a hung host ends the quit through the forced path at the deadline")
        let hungForcedReceipts = hungCollected.receipts.filter { $0.event == .quitForced }
        check(hungForcedReceipts.count == 1 && hungForcedReceipts.first?.facts["stage"] == .word("host"),
              "the forced path writes quit_forced with the stage it gave up on, to the file log")
        check(NativeQuitDeadline.deadline == 3, "the forced path is the safety net, at three seconds, and no earlier")

        // (d) #644: a launch kind that arrives before the host is up is posted once it is, so
        // host.log holds a launch_kind line after its own host_started.
        var relay = LaunchReceiptRelay()
        check(relay.received(.loginItem, hostUp: false) == nil && relay.pending == .loginItem,
              "a launch receipt posted before the host is up is kept, not dropped")
        check(relay.hostUp() == .loginItem && relay.pending == nil,
              "the kept launch kind is posted once the host answers its ready frame")
        check(relay.hostUp() == nil, "a second ready frame posts the launch kind only once")
        check(relay.received(.reopen, hostUp: true) == .reopen && relay.pending == nil,
              "a launch kind that arrives with the host already up is posted at once")

        exit(failures == 0 ? 0 : 1)
    }
}
