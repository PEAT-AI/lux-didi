import AppKit
import ScreenCaptureKit
import CryptoKit
import ApplicationServices

@MainActor enum OwnedWindowProof {
    enum CaptureFailure: String, Error { case availability, notVisible, noWindowNumber, notInCurrentProcess }
    private struct Control: Sendable { let name: String; let enabled: Bool; let visible: Bool }
    private struct ConsumerResult: Sendable {
        var code: String
        var windowCount = 0
        var identifierStatuses: [Int32] = []
        var identifierMatches = 0
        var childCount = 0
        var controls: [Control] = []
        let queryOnMainThread: Bool
    }
    static func consumerTrace(_ window: NSWindow) async -> [String: Any] {
        guard NSApp.windows.contains(window), window.isVisible else { return ["code": "own-window-not-visible"] }
        // Capture primitive expected state on main; NSWindow/AX objects never cross actors.
        let pid = getpid(), expectedIdentifier = ownIdentifier(window)
        let result = await Task.detached { consumerSnapshot(pid: pid, expectedIdentifier: expectedIdentifier) }.value
        return ["code": result.code, "windowCount": result.windowCount,
                "identifierStatuses": result.identifierStatuses, "identifierMatches": result.identifierMatches,
                "childCount": result.childCount, "queryOnMainThread": result.queryOnMainThread]
    }
    nonisolated private static func consumerSnapshot(pid: pid_t, expectedIdentifier: String) -> ConsumerResult {
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
            let status = AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &title)
            result.identifierStatuses.append(status.rawValue)
            return status == .success && title as? String == expectedIdentifier
        }
        result.identifierMatches = matching.count
        guard matching.count == 1 else { result.code = "own-identifier-not-unique"; return result }
        let childStatus = AXUIElementCopyAttributeValue(matching[0], kAXChildrenAttribute as CFString, &value)
        result.code = String(childStatus.rawValue)
        result.childCount = (value as? [AXUIElement])?.count ?? 0
        let expected: Set<String> = ["Start recording", "Stop recording", "Send text"]
        func read(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
        }
        func rectangle(_ element: AXUIElement) -> CGRect? {
            guard let rawPosition = read(element, kAXPositionAttribute),
                  let rawSize = read(element, kAXSizeAttribute),
                  CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
            let position = rawPosition as! AXValue; let size = rawSize as! AXValue
            var point = CGPoint.zero; var dimensions = CGSize.zero
            guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
            return CGRect(origin: point, size: dimensions)
        }
        let windowFrame = rectangle(matching[0])
        var visited = 0; var found: [String: Control] = [:]
        func visit(_ element: AXUIElement, depth: Int) {
            guard depth < 16, visited < 512 else { return }; visited += 1
            let labels = [kAXTitleAttribute, kAXDescriptionAttribute].compactMap { read(element, $0) as? String }
            if let name = labels.first(where: expected.contains), let frame = rectangle(element) {
                let visible = frame.width > 0 && frame.height > 0 && (windowFrame?.intersects(frame) ?? false)
                found[name] = Control(name: name, enabled: (read(element, kAXEnabledAttribute) as? Bool) ?? false, visible: visible)
            }
            for child in (read(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { visit(child, depth: depth + 1) }
        }
        visit(matching[0], depth: 0)
        result.controls = found.keys.sorted().compactMap { found[$0] }

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
    private static func ownIdentifier(_ window: NSWindow) -> String {
        if let identifier = window.accessibilityIdentifier() { return identifier }
        let identifier = "didi-owned-window-" + UUID().uuidString
        window.setAccessibilityIdentifier(identifier)
        return identifier
    }
    static func accessibility(_ window: NSWindow) async -> [[String: Any]] {
        guard NSApp.windows.contains(window), window.isVisible else { return [] }
        let pid = getpid(), identifier = ownIdentifier(window)
        let result = await Task.detached { consumerSnapshot(pid: pid, expectedIdentifier: identifier) }.value
        return result.controls.map { ["name": $0.name, "enabled": $0.enabled, "visible": $0.visible, "source": "public-own-PID-AX"] }
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
        guard #available(macOS 14.4, *) else { throw CaptureFailure.availability }
        guard window.isVisible else { throw CaptureFailure.notVisible }
        guard window.windowNumber > 0 else { throw CaptureFailure.noWindowNumber }
        // The SDK explicitly limits currentProcess to content captureable without
        // TCC consent. Never enumerate general shareable content or request grants.
        let image = try await bounded {
        let content = try await SCShareableContent.currentProcess
        guard let owned = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else { throw CaptureFailure.notInCurrentProcess }
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
