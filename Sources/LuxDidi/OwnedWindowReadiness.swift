import AppKit

@MainActor enum OwnedWindowReadiness {
    struct Outcome {
        let ready: Bool
        let events: [[String: Any]]
        let diagnostics: [String: Any]
    }
    @MainActor private final class Cancellation {
        var action: (() -> Void)?
    }
    private static func state(_ window: NSWindow) -> [String: Bool] {
        ["owned": NSApp.windows.contains(where: { $0 === window }), "running": NSApp.isRunning,
         "active": NSApp.isActive, "visible": window.isVisible, "main": window.isMainWindow,
         "key": window.isKeyWindow, "unoccluded": window.occlusionState.contains(.visible)]
    }
    static func wait(_ window: NSWindow, timeout: UInt64 = 8_000_000_000,
                     request: () -> Void) async -> Outcome {
        let started = Date()
        let cancellation = Cancellation()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                var settled = false
                var events: [[String: Any]] = []
                var observers: [NSObjectProtocol] = []
                var deadline: Task<Void, Never>?
                var loopObserver: CFRunLoopObserver?
                var loopCount = 0
                var firstUptime: UInt64?
                var lastUptime: UInt64?
                var attempted = false
                var requestSent: Bool?
                @MainActor func finish(_ ready: Bool) {
                    guard !settled else { return }; settled = true
                    deadline?.cancel(); deadline = nil
                    observers.forEach { NotificationCenter.default.removeObserver($0) }
                    observers.removeAll()
                    if let observer = loopObserver {
                        CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
                        CFRunLoopObserverInvalidate(observer)
                    }
                    loopObserver = nil
                    cancellation.action = nil
                    let diagnostics: [String: Any] = [
                        "activation": ["api": "NSRunningApplication.activate(options:[])", "attempted": attempted,
                            "requestSent": requestSent as Any? ?? NSNull(), "semantics": "request-sent-not-readiness"],
                        "runLoop": ["count": loopCount, "firstUptimeNanoseconds": firstUptime as Any? ?? NSNull(),
                            "lastUptimeNanoseconds": lastUptime as Any? ?? NSNull(), "disposed": true],
                        "context": ["parentPid": Int(getppid()),
                            "frontmostIsSelf": NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()]
                    ]
                    continuation.resume(returning: Outcome(ready: ready, events: events, diagnostics: diagnostics))
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
                cancellation.action = { record("cancelled", complete: false); finish(false) }
                guard !Task.isCancelled else { cancellation.action?(); return }
                // Only the main run loop is observed; no pumping, timer or sleep is
                // introduced for liveness. Count/monotonic bounds stay private.
                loopObserver = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault,
                    CFRunLoopActivity.beforeWaiting.rawValue | CFRunLoopActivity.afterWaiting.rawValue, true, 0) { _, _ in
                    MainActor.assumeIsolated {
                        guard !settled else { return }
                        let now = DispatchTime.now().uptimeNanoseconds
                        loopCount += 1; firstUptime = firstUptime ?? now; lastUptime = now
                    }
                }
                CFRunLoopAddObserver(CFRunLoopGetMain(), loopObserver, .commonModes)
                // Register exact own objects BEFORE ordering/activation.
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
                // Deadline only, unchanged: BOOL reports dispatch, NEVER readiness
                // or immediate refusal. Actual state still settles on notifications.
                deadline = Task { @MainActor in
                    do { try await Task.sleep(nanoseconds: timeout) } catch { return }
                    record("deadline", complete: false); finish(false)
                }
                record("initial")
                guard !settled else { return }
                request()
                if window.isVisible {
                    attempted = true
                    requestSent = NSRunningApplication.current.activate(options: [])
                }
                record("after-request", complete: false)
            }
        } onCancel: {
            Task { @MainActor in cancellation.action?() }
        }
    }
}
