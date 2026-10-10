import AppKit

@MainActor enum OwnedWindowReadiness {
    struct Outcome {
        let ready: Bool
        let events: [[String: Any]]
    }
    private static func state(_ window: NSWindow) -> [String: Bool] {
        ["owned": NSApp.windows.contains(where: { $0 === window }), "running": NSApp.isRunning,
         "active": NSApp.isActive, "visible": window.isVisible, "main": window.isMainWindow,
         "key": window.isKeyWindow, "unoccluded": window.occlusionState.contains(.visible)]
    }
    static func wait(_ window: NSWindow, timeout: UInt64 = 8_000_000_000,
                     request: () -> Void) async -> Outcome {
        let started = Date()
        return await withCheckedContinuation { continuation in
            var settled = false
            var events: [[String: Any]] = []
            var observers: [NSObjectProtocol] = []
            var deadline: Task<Void, Never>?
            @MainActor func finish(_ ready: Bool) {
                guard !settled else { return }; settled = true
                deadline?.cancel(); deadline = nil
                observers.forEach { NotificationCenter.default.removeObserver($0) }
                observers.removeAll()
                continuation.resume(returning: Outcome(ready: ready, events: events))
            }
            @MainActor func record(_ event: String, complete: Bool = true) {
                guard !settled else { return }
                let snapshot = state(window)
                events.append(["event": event, "elapsedSeconds": Date().timeIntervalSince(started), "state": snapshot,
                    "diagnostic": ["activationPolicy": NSApp.activationPolicy().rawValue, "hidden": NSApp.isHidden,
                        "onActiveSpace": window.isOnActiveSpace, "canBecomeKey": window.canBecomeKey,
                        "canBecomeMain": window.canBecomeMain]])
                if complete && snapshot.values.allSatisfy({ $0 }) { finish(true) }
            }
            // Observe only our application and this exact owned window. Register
            // BEFORE requesting activation, so synchronous notifications are not lost.
            let notifications: [(Notification.Name, AnyObject)] = [
                (NSApplication.didBecomeActiveNotification, NSApplication.shared),
                (NSWindow.didBecomeMainNotification, window),
                (NSWindow.didBecomeKeyNotification, window),
                (NSWindow.didChangeOcclusionStateNotification, window)
            ]
            for (name, object) in notifications {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { _ in
                    Task { @MainActor in record(name.rawValue) }
                })
            }
            // Cancellation-safe deadline only: readiness resumes from notifications,
            // never polling or waiting a fixed delay before inspecting AX.
            deadline = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: timeout) } catch { return }
                record("deadline", complete: false); finish(false)
            }
            record("initial")
            guard !settled else { return }
            request()
            record("after-request", complete: false)
        }
    }
}
