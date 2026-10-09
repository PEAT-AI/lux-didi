import AppKit
import ScreenCaptureKit
import CryptoKit
import ApplicationServices

@MainActor enum OwnedWindowProof {
    private struct ConsumerResult: Sendable {
        var code: String
        var windowCount = 0
        var titleStatuses: [Int32] = []
        var titleMatches = 0
        var childCount = 0
        let queryOnMainThread: Bool
    }
    static func consumerTrace(_ window: NSWindow) async -> [String: Any] {
        guard NSApp.windows.contains(window), window.isVisible else { return ["code": "own-window-not-visible"] }
        // Capture primitive expected state on main; NSWindow/AX objects never cross actors.
        let pid = getpid(), expectedTitle = window.title
        let result = await Task.detached { consumerSnapshot(pid: pid, expectedTitle: expectedTitle) }.value
        return ["code": result.code, "windowCount": result.windowCount,
                "titleStatuses": result.titleStatuses, "titleMatches": result.titleMatches,
                "childCount": result.childCount, "queryOnMainThread": result.queryOnMainThread]
    }
    nonisolated private static func consumerSnapshot(pid: pid_t, expectedTitle: String) -> ConsumerResult {
        // Public consumer API, only our PID; never request trust or query another app.
        var result = ConsumerResult(code: "starting", queryOnMainThread: Thread.isMainThread)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
        result.code = String(status.rawValue)
        guard status == .success, let windows = value as? [AXUIElement] else { return result }
        result.windowCount = windows.count
        guard windows.count <= 8 else { result.code = "own-window-limit"; return result }
        let matching = windows.filter { element in
            var title: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
            result.titleStatuses.append(status.rawValue)
            return status == .success && title as? String == expectedTitle
        }
        result.titleMatches = matching.count
        guard matching.count == 1 else { result.code = "own-title-not-unique"; return result }
        let childStatus = AXUIElementCopyAttributeValue(matching[0], kAXChildrenAttribute as CFString, &value)
        result.code = String(childStatus.rawValue)
        result.childCount = (value as? [AXUIElement])?.count ?? 0
        return result
    }
    // Private diagnostic: own-tree types/roles and exact native-control matches only.
    // Never serialize arbitrary labels, text values, page content or credentials.
    static func accessibilityTrace(_ window: NSWindow) -> [[String: Any]] {
        var trace: [[String: Any]] = []
        let expected: Set<String> = ["Start recording", "Stop recording", "Send text"]
        func visit(_ value: Any, depth: Int) {
            guard depth < 16, trace.count < 64 else { return }
            let element = value as? NSAccessibilityProtocol
            trace.append(["depth": depth, "type": String(describing: type(of: value)),
                          "protocol": element != nil, "role": element?.accessibilityRole()?.rawValue ?? "none",
                          "childCount": element?.accessibilityChildren()?.count ?? 0,
                          "knownLabel": element?.accessibilityLabel().map { expected.contains($0) } ?? false,
                          "knownTitle": element?.accessibilityTitle().map { expected.contains($0) } ?? false])
            for child in element?.accessibilityChildren() ?? [] { visit(child, depth: depth + 1) }
        }
        visit(window, depth: 0)
        return trace
    }
    static func accessibility(_ window: NSWindow) -> [[String: Any]] {
        let expected: Set<String> = ["Start recording", "Stop recording", "Send text"]
        var found: [String: [String: Any]] = [:]
        var visited = 0
        func visit(_ value: Any, depth: Int) {
            guard depth < 16, visited < 512, let element = value as? NSAccessibilityProtocol else { return }
            visited += 1
            for name in [element.accessibilityLabel(), element.accessibilityTitle()].compactMap({ $0 }) where expected.contains(name) {
                let frame = element.accessibilityFrame()
                found[name] = ["name": name, "enabled": element.isAccessibilityEnabled(),
                               "visible": window.isVisible && frame.width > 0 && frame.height > 0 && window.frame.intersects(frame)]
            }
            for child in element.accessibilityChildren() ?? [] { visit(child, depth: depth + 1) }
        }
        visit(window, depth: 0)
        return found.keys.sorted().compactMap { found[$0] }
    }
    private static func bounded<T>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            var settled = false
            var deadline: Task<Void, Never>?
            let work = Task { @MainActor in
                do {
                    let value = try await operation()
                    guard !settled else { return }; settled = true; deadline?.cancel()
                    continuation.resume(returning: value)
                } catch {
                    guard !settled else { return }; settled = true; deadline?.cancel()
                    continuation.resume(throwing: error)
                }
            }
            deadline = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { return }
                guard !settled else { return }; settled = true; work.cancel()
                continuation.resume(throwing: InstalledProofError.captureRequired)
            }
        }
    }
    static func capture(_ window: NSWindow, to output: URL) async throws -> [String: Any] {
        guard #available(macOS 14.4, *), window.isVisible, window.windowNumber > 0 else { throw InstalledProofError.captureRequired }
        // The SDK explicitly limits currentProcess to content captureable without
        // TCC consent. Never enumerate general shareable content or request grants.
        let image = try await bounded {
        let content = try await SCShareableContent.currentProcess
        guard let owned = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else { throw InstalledProofError.captureRequired }
        let filter = SCContentFilter(desktopIndependentWindow: owned)
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width * 2); config.height = Int(window.frame.height * 2)
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        }
        guard window.isVisible, image.width > 0, image.height > 0, let bytes = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw InstalledProofError.captureRequired }
        // The output parent is the caller-owned private proof directory.
        try bytes.write(to: output, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        return ["method": "ScreenCaptureKit.currentProcess",
                "width": image.width, "height": image.height, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
                "path": output.path  ]
    }
}
