import AppKit
import Foundation

/// #619 and #620: what a launch, a Dock reopen and a display change do to the app's surfaces.
/// Recording fakes count the full-window factory, the key call, activation and the orb order, so
/// "a reopen shows the orb only" is observed rather than inferred. No display is changed, no
/// window is shown and no app is launched.
@main struct WindowRoutingTests {
    /// The app's four surface calls, recorded. The orb order is the production mini show call,
    /// the window factory is the production full show call.
    @MainActor final class Surfaces {
        var orbOrders = 0
        var windowFactories = 0
        var keyAndFront = 0
        var activations = 0
        var visible: Set<String> = []
        var settingsOpens = 0
        var startLiveTaps = 0
        var muteTaps = 0
        let facts = MiniSurfaceFacts(frame: "{{1200, 700}, {220, 220}}", screen: "main",
                                     alpha: 1, occluded: false, pageState: "ready")
        lazy var coordinator = PresentationCoordinator(
            showFull: { [unowned self] activating in
                self.windowFactories += 1
                self.visible.insert("full")
                if activating { self.keyAndFront += 1; self.activations += 1 }
            },
            hideFull: { [unowned self] in self.visible.remove("full") },
            showMini: { [unowned self] _ in
                self.orbOrders += 1
                self.visible.insert("mini")
                return .shown(self.facts)
            },
            hideMini: { [unowned self] _ in self.visible.remove("mini") },
            liveIsRunning: { false })

        /// The launch opening the app runs when it becomes ready: the orb on every kind that
        /// shows UI, and a window only where that kind hosts one.
        func launch(_ kind: LaunchKind) {
            if kind.presentsOrbAtLaunch { _ = coordinator.presentMini(trigger: .other) }
            if kind.presentsWindowAtLaunch { coordinator.presentFull(activating: kind.activates) }
        }
    }

    @MainActor static func main() {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }

        // 1. The launch and reopen matrix. A login, a cold interactive launch and a reopen all
        // leave the window unbuilt; an install relaunch fronts the window without activating.
        let login = Surfaces()
        login.launch(.loginItem)
        check(login.orbOrders == 1 && login.visible == ["mini"],
              "a login launch shows the orb and no window")
        check(login.windowFactories == 0 && login.keyAndFront == 0 && login.activations == 0,
              "a login launch builds no window, makes nothing key and activates nothing")

        let cold = Surfaces()
        cold.launch(.interactive)
        check(cold.orbOrders == 1 && cold.visible == ["mini"],
              "a cold interactive launch shows the orb and no window")
        check(cold.windowFactories == 0 && cold.keyAndFront == 0 && cold.activations == 0,
              "a cold interactive launch builds no window, makes nothing key and activates nothing")

        let install = Surfaces()
        install.launch(.installRelaunch)
        check(install.orbOrders == 1 && install.windowFactories == 1 && install.visible == ["mini", "full"],
              "an install relaunch shows the orb and fronts the window")
        check(install.keyAndFront == 0 && install.activations == 0,
              "an install relaunch fronts the window without making it key or activating")

        // A warm reopen: the owner launched, opened the window, closed it (the orb stayed) and
        // then clicked the Dock.
        let reopen = Surfaces()
        reopen.launch(.interactive)
        reopen.coordinator.presentFull(activating: true)
        reopen.coordinator.closeFull()
        let windowsBefore = reopen.windowFactories
        let keysBefore = reopen.keyAndFront
        let activationsBefore = reopen.activations
        let orbBefore = reopen.orbOrders
        reopen.coordinator.presentOrbFromDock()
        check(reopen.windowFactories == windowsBefore && reopen.keyAndFront == keysBefore
            && reopen.activations == activationsBefore,
              "a warm Dock reopen builds no window, makes nothing key and activates nothing")
        check(reopen.orbOrders == orbBefore + 1,
              "a warm Dock reopen orders the orb front even when it is already on screen")
        check(reopen.visible == ["mini"], "a warm Dock reopen leaves the orb as the only surface")

        let duplicate = Surfaces()
        check(SingleInstanceGuard.shouldYield(kind: .interactive, otherInstanceRunning: true)
            && LaunchKind.interactive.duplicateInstanceExitCodeForYield == 0,
              "a duplicate launch yields to the live instance and exits without a surface")
        check(duplicate.orbOrders == 0 && duplicate.windowFactories == 0,
              "a duplicate launch opens no surface at all")

        // #619: the reopen is its own launch kind and its line says no window.
        let reopenRecord = LaunchKind.reopen.launchRecord
        check(reopenRecord["event"] as? String == "launch_kind"
            && reopenRecord["kind"] as? String == "reopen"
            && reopenRecord["windowShown"] as? Bool == false
            && reopenRecord["autoConnects"] as? Bool == false,
              "the reopen line names its own kind, no window and no connect")
        check(!LaunchKind.reopen.createsWindowAtLaunch && !LaunchKind.reopen.activates
            && LaunchKind.reopen.presentsOrbAtLaunch,
              "a reopen never creates a window or activates and always shows the orb")

        // 2. The grant alert and the Getting Started sheet wait for the owner's first open.
        var prompted: [DeferredPrompts.Prompt] = []
        var prompts = DeferredPrompts()
        let atLaunch = prompts.launchDecisions()
        check(atLaunch.count == DeferredPrompts.Prompt.allCases.count
            && atLaunch.allSatisfy { $0.1 == .deferred } && prompted.isEmpty,
              "a launch defers the grant alert and the Getting Started sheet and shows neither")
        let firstOpen = prompts.ownerOpenedWindow { prompt in prompted.append(prompt); return true }
        check(firstOpen.map(\.0) == [.grantAlert, .gettingStarted]
            && prompted == [.grantAlert, .gettingStarted],
              "the first explicit open shows the grant alert and the sheet")
        let secondOpen = prompts.ownerOpenedWindow { prompt in prompted.append(prompt); return true }
        check(secondOpen.isEmpty && prompted.count == 2, "a second open shows neither prompt again")
        var refused = DeferredPrompts()
        let skipped = refused.ownerOpenedWindow { _ in false }
        check(skipped.allSatisfy { $0.1 == .skipped },
              "a prompt whose own once-a-version gate refuses is recorded as skipped, never shown")

        // 3. A screen change re-places the orb on a visible screen and keeps the saved origin.
        let small = CGRect(x: 0, y: 0, width: 900, height: 600)
        let orb = CGRect(x: 1200, y: 660, width: 220, height: 220)
        let moved = MiniOrbFrameRestore.afterScreenChange(current: orb, saved: nil, screens: [small])
        check(moved.minX >= small.minX && moved.minY >= small.minY
            && moved.maxX <= small.maxX && moved.maxY <= small.maxY,
              "a smaller visible frame moves the orb inside it")
        check(moved.size == CGSize(width: 220, height: 220), "a screen change never resizes the orb")
        let unchanged = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let stayed = MiniOrbFrameRestore.afterScreenChange(current: orb, saved: orb, screens: [unchanged])
        check(stayed.origin == orb.origin, "an unchanged visible frame leaves the orb origin untouched")
        let savedOrigin = CGRect(x: 40, y: 40, width: 220, height: 220)
        let kept = MiniOrbFrameRestore.afterScreenChange(current: orb, saved: savedOrigin, screens: [small])
        check(kept.origin == savedOrigin.origin && small.maxX >= kept.maxX,
              "a saved origin that is still visible is preserved")

        // 4. #625: the Dock icon's own menu. Its four items are the menu bar's actions, and Open
        // Naya app is the one Dock interaction that opens the full window, by the activating path.
        let dock = Surfaces()
        dock.launch(.loginItem)
        let windowsBeforeDock = dock.windowFactories
        let dockMenu = DockMenu(
            show: { dock.coordinator.presentFull(activating: true) },
            openSettings: { dock.settingsOpens += 1 },
            startLive: { dock.startLiveTaps += 1 },
            mute: { dock.muteTaps += 1 })
        let menu = dockMenu.build(muted: false)
        check(menu.items.map(\.title) == ["Open Naya app", "Settings", "", "Start Live", "Mute"],
              "the Dock menu carries exactly Open Naya app, Settings, a separator, Start Live and Mute")
        check(menu.items.count == 5 && menu.items[2].isSeparatorItem,
              "the Dock menu separates the app actions from the call actions and adds nothing else")
        check(menu.items.filter { !$0.isSeparatorItem }.allSatisfy { $0.target === dockMenu },
              "every Dock menu item routes to the app's own actions")
        _ = menu.items[0].target?.perform(menu.items[0].action)
        check(dock.windowFactories == windowsBeforeDock + 1 && dock.keyAndFront == 1
            && dock.activations == 1,
              "Open Naya app from the Dock menu opens the full window and activates it once")
        check(dock.visible == ["mini", "full"],
              "Open Naya app from the Dock menu leaves the orb beside the window")
        let activationsBeforeReopen = dock.activations
        dock.coordinator.presentOrbFromDock()
        check(dock.windowFactories == windowsBeforeDock + 1 && dock.activations == activationsBeforeReopen,
              "a plain Dock reopen still opens no window and activates nothing")
        _ = menu.items[1].target?.perform(menu.items[1].action)
        check(dock.settingsOpens == 1,
              "Settings from the Dock menu runs the menu bar's Settings action")
        check(dockMenu.build(muted: true).items.last?.title == "Unmute",
              "the Dock menu's mute item carries the menu bar's own title for the current mute state")

        print(failures == 0 ? "WINDOW-ROUTING TESTS PASS" : "WINDOW-ROUTING TESTS FAILED \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}
