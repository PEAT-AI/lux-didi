import AppKit
import Foundation

/// Mechanical boundary proofs. All opens use a recording fake, never a real workspace.
@main struct NativeActionsTests {
    static func main() async {
        var failures = 0
        func check(_ value: Bool, _ label: String) {
            print("\(value ? "PASS" : "FAIL") \(label)")
            if !value { failures += 1 }
        }
        let home = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("didi-open-\(UUID().uuidString)")
        let outside = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("didi-outside-\(UUID().uuidString).txt")
        try! FileManager.default.createDirectory(at: home.appendingPathComponent("Applications/Synthetic.app/Contents"), withIntermediateDirectories: true)
        try! Data("synthetic".utf8).write(to: outside)
        try! Data("synthetic".utf8).write(to: home.appendingPathComponent("Applications/Synthetic.app/Contents/Info.plist"))
        try! FileManager.default.createSymbolicLink(at: home.appendingPathComponent("link.txt"), withDestinationURL: outside)
        defer { try? FileManager.default.removeItem(at: home); try? FileManager.default.removeItem(at: outside) }
        let actions = NativeActions(home: home, opener: { _, _ in true }, browserState: { BrowserState(installed: true, running: false) })
        for target in ["https://example.org/any/path?q=words", "http://example.org:8080/download", "https://another.example.org/"] {
            let result = await actions.perform(.openURL, target: target)
            check(result.code == .opened, "web opens \(target)")
        }
        for target in ["https://user:pass@example.org/", "https://user@example.org/", "file:///tmp/example", "not a URL"] {
            let result = await actions.perform(.openURL, target: target)
            check(result.code == .notAllowed, "invalid URL refused \(target)")
        }
        for target in [outside.path, home.appendingPathComponent("link.txt").path] {
            let result = await actions.perform(.openFile, target: target)
            check(result.code == .opened, "readable path opens outside home including symlink")
        }
        let absent = await actions.perform(.openFile, target: outside.path + ".absent")
        check(absent.code == .notFound, "absent file is not_found")
        let app = await actions.perform(.openApp, target: "Synthetic")
        check(app.code == .opened, "installed app by name opens")
        let missingApp = await actions.perform(.openApp, target: "SyntheticMissing-\(UUID().uuidString)")
        check(missingApp.code == .notFound, "missing app is not_found")
        for _ in 0..<6 {
            let result = await actions.perform(.openURL, target: "https://example.org/")
            check(result.code == .opened, "no native policy rate gate")
        }
        let failed = NativeActions(home: home, opener: { _, _ in false })
        let failure = await failed.perform(.openURL, target: "https://example.org/")
        check(failure.code == .failed, "workspace failure never claims opened")
        let frame = NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"synthetic\",\"action\":\"open_url\",\"target\":\"https://example.org/\"}")
        check(frame?.action == .openURL, "canonical control frame parses")
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"synthetic\",\"action\":\"type\",\"target\":\"text\"}") == nil, "typing is not an action")
        let workspace = RecordingWorkspace()
        let open = NativeActions.browserOpener(workspace)
        let web = await open(URL(string: "https://example.org/")!, false)
        check(web && workspace.calls == ["default"], "system default browser opens even when Chrome is stopped")
        print(failures == 0 ? "NATIVE-ACTIONS TESTS PASS" : "NATIVE-ACTIONS TESTS FAILED \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}

final class RecordingWorkspace: BrowserWorkspace, @unchecked Sendable {
    private(set) var calls: [String] = []
    func applicationURL(bundleIdentifier: String) -> URL? { calls.append("lookup"); return nil }
    func open(_ url: URL) -> Bool { calls.append("default"); return true }
    func open(_ url: URL, withApplicationAt application: URL) async -> Bool { calls.append("explicit"); return true }
    func openApplication(at url: URL) async -> Bool { calls.append("app"); return true }
}
