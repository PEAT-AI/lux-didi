import AppKit
import ScreenCaptureKit
import CryptoKit

@MainActor enum OwnedWindowProof {
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
    static func capture(_ window: NSWindow, to output: URL) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess(), #available(macOS 14.4, *), window.isVisible, window.windowNumber > 0 else { throw InstalledProofError.captureRequired }
        // The SDK explicitly limits currentProcess to content captureable without
        // TCC consent. Never enumerate general shareable content or request grants.
        let content = try await SCShareableContent.currentProcess
        guard let owned = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else { throw InstalledProofError.captureRequired }
        let filter = SCContentFilter(desktopIndependentWindow: owned)
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width * 2); config.height = Int(window.frame.height * 2)
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard image.width > 0, image.height > 0, let bytes = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw InstalledProofError.captureRequired }
        // The output parent is the caller-owned private proof directory.
        try bytes.write(to: output, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        return ["method": "ScreenCaptureKit.currentProcess",
                "width": image.width, "height": image.height, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
                "path": output.path  ]
    }
}
