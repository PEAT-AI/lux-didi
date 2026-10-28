import AppKit
import Foundation

/// Fake-seam proofs for the native open boundary: the control frame shape, the https-only rule,
/// the home-folder containment with symlink escape, app resolution in the three folders and the
/// five-a-minute limit. Every proof injects the opener, so nothing is ever opened.
@main struct NativeActionsTests {
    static func main() async {
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if condition { print("PASS \(label)") } else { print("FAIL \(label)"); failures += 1 }
        }
        let home = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("didi-native-actions-\(UUID().uuidString)")
        let outside = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("didi-native-actions-outside-\(UUID().uuidString)")
        for folder in [home, home.appendingPathComponent("Documents"), outside] {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        let document = home.appendingPathComponent("Documents/plan.md")
        FileManager.default.createFile(atPath: document.path, contents: Data("x".utf8))
        let escape = home.appendingPathComponent("Documents/escape.txt")
        let secret = outside.appendingPathComponent("secret.txt")
        FileManager.default.createFile(atPath: secret.path, contents: Data("x".utf8))
        try? FileManager.default.createSymbolicLink(at: escape, withDestinationURL: secret)

        actor Counter {
            private(set) var urls: [URL] = []
            func open(_ url: URL, _ isApplication: Bool) -> Bool { urls.append(url); return true }
            var count: Int { urls.count }
        }
        let counter = Counter()
        let opened = NativeActions(home: home, opener: { url, isApplication in await counter.open(url, isApplication) })
        defer { try? FileManager.default.removeItem(at: home); try? FileManager.default.removeItem(at: outside) }

        // 1. The control frame is exact; anything else is not an action.
        let frame = NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a1\",\"action\":\"open_url\",\"target\":\"https://example.test/a\"}")
        check(frame == NativeActionFrame(id: "a1", action: .openURL, target: "https://example.test/a"), "parse a native_action frame")
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a1\",\"action\":\"open_url\"}") == nil, "a short frame is refused")
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a1\",\"action\":\"open_url\",\"target\":\"https://x\",\"extra\":1}") == nil, "an extra key is refused")
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a1\",\"action\":\"run_shell\",\"target\":\"x\"}") == nil, "an unknown action is refused")
        check(NativeActionFrame.control("{\"type\":\"ready\"}") == nil, "a conversation frame is not an action")
        check(NativeActionReply(id: "a1", result: NativeActionResult(code: .opened)).json == "{\"type\":\"native_action_result\",\"id\":\"a1\",\"ok\":true,\"code\":\"opened\"}", "encode the ack frame")
        check(NativeActionReply(id: "a1", result: NativeActionResult(code: .notAllowed)).json.contains("\"ok\":false"), "a refusal is an unsuccessful ack")

        // 2. Viewer destinations only: an exact host and a viewer path, parsed and never prefix matched.
        check(await opened.perform(.openURL, target: "https://mail.google.com/mail/u/0/#inbox/19c").code == .opened, "a gmail thread opens")
        check(await opened.perform(.openURL, target: "https://example.test/private/plan.pdf").code == .notAllowed, "a host outside the policy is refused")
        check(await opened.perform(.openURL, target: "http://docs.google.com/document/d/ABC").code == .notAllowed, "http is refused")
        check(await opened.perform(.openURL, target: "file:///etc/passwd").code == .notAllowed, "a file URL is refused")
        check(await opened.perform(.openURL, target: "https://docs.google.com.evil.example/document/d/ABC").code == .notAllowed, "a lookalike host is refused")
        check(await opened.perform(.openURL, target: "https://user:pw@docs.google.com/document/d/ABC").code == .notAllowed, "user info is refused")
        check(await opened.perform(.openURL, target: "https://docs.google.com:8443/document/d/ABC").code == .notAllowed, "an explicit port is refused")
        check(await opened.perform(.openURL, target: "https://docs.google.com/url?q=https://evil.example").code == .notAllowed, "a redirect route is refused")
        check(await opened.perform(.openURL, target: "https://chat.example.invalid/t/harbour/pl/p2").code == .notAllowed, "an unconfigured mattermost host is refused")
        check(await opened.perform(.openURL, target: "https://docs.google.com/presentation/d/ABC/edit").code == .opened, "a slides deck opens")
        let scoped = NativeActions(home: home, opener: { _, _ in true }, mattermostHost: "chat.example.invalid")
        check(await scoped.perform(.openURL, target: "https://chat.example.invalid/t/harbour/pl/p2").code == .opened, "the configured mattermost host opens a post permalink")
        check(await scoped.perform(.openURL, target: "https://chat.example.invalid/harbour/channels/town-square").code == .opened, "the configured mattermost host opens a channel")
        check(await scoped.perform(.openURL, target: "https://mail.google.com/mail/u/0/").code == .opened, "the gmail home page opens")
        check(await scoped.perform(.openURL, target: "https://calendar.google.com/").code == .opened, "the calendar home page opens")
        check(await scoped.perform(.openURL, target: "https://calendar.google.com/calendar/export?eid=e1").code == .notAllowed, "a calendar export route is refused")

        // OPEN2-R1: the host names one Mattermost origin per frame; the first one is pinned for good.
        let pinned = NativeActions(home: home, opener: { _, _ in true })
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a1\",\"action\":\"open_url\",\"target\":\"https://chat.example.invalid/t/harbour/pl/p1\",\"origin\":\"https://chat.example.invalid\"}")?.origin == "https://chat.example.invalid", "an open_url frame carries the origin the host named")
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a2\",\"action\":\"open_file\",\"target\":\"/tmp/x\",\"origin\":\"https://chat.example.invalid\"}") == nil, "only an open_url frame may carry an origin")
        check(NativeActionFrame.control("{\"type\":\"native_action\",\"id\":\"a3\",\"action\":\"open_url\",\"target\":\"https://chat.example.invalid/t/harbour/pl/p1\",\"origin\":\"https://chat.example.invalid\",\"extra\":1}") == nil, "a sixth key is refused")
        check(await pinned.adopt(mattermostOrigin: "http://chat.example.invalid") == false, "an http origin is refused")
        check(await pinned.adopt(mattermostOrigin: "https://user:pw@chat.example.invalid") == false, "an origin with user info is refused")
        check(await pinned.adopt(mattermostOrigin: "https://chat.example.invalid:8443") == false, "an origin with a port is refused")
        check(await pinned.adopt(mattermostOrigin: "https://chat.example.invalid/team") == false, "an origin with a path is refused")
        check(await pinned.perform(.openURL, target: "https://chat.example.invalid/t/harbour/pl/p1").code == .notAllowed, "nothing opens before an origin is pinned")
        check(await pinned.adopt(mattermostOrigin: "https://chat.example.invalid") == true, "the first origin pins")
        check(await pinned.perform(.openURL, target: "https://chat.example.invalid/t/harbour/pl/p1").code == .opened, "the pinned origin opens its viewer links")
        check(await pinned.perform(.openURL, target: "https://other.example.invalid/t/harbour/pl/p1").code == .notAllowed, "a second mattermost host is still refused")
        check(await pinned.adopt(mattermostOrigin: "https://other.example.invalid") == false, "a second origin is refused")
        check(await pinned.perform(.openURL, target: "https://other.example.invalid/t/harbour/pl/p1").code == .notAllowed, "the refused origin never opens")
        check(OpenDestination.of("https://youtu.be/abc", mattermostHost: nil)?.kind == "youtube", "a short video link is a video")
        check(OpenDestination.of("https://www.youtube.com/watch?v=abc", mattermostHost: nil)?.kind == "youtube", "a watch link is a video")
        check(OpenDestination.of("https://drive.google.com/file/d/ABC/view", mattermostHost: nil)?.kind == "drive", "a drive file is a drive file")
        check(OpenDestination.of("https://docs.google.com/document/d/ABC/export", mattermostHost: nil) == nil, "a docs export route is refused")

        // C-OPENWEB8: the three web surfaces open_web builds, and a site root with nothing else on it.
        check(OpenDestination.of("https://www.google.com/search?q=odemira", mattermostHost: nil)?.kind == "web", "a google search opens")
        check(OpenDestination.of("https://www.google.com/search?q=odemira&hl=en", mattermostHost: nil) == nil, "a search with an extra parameter is refused")
        check(OpenDestination.of("https://www.google.com/search?q=a&q=b", mattermostHost: nil) == nil, "a repeated search parameter is refused")
        check(OpenDestination.of("https://www.google.com/maps/search/?api=1&query=Odemira", mattermostHost: nil)?.kind == "web", "a maps search opens")
        check(OpenDestination.of("https://www.google.com/maps/dir/?api=1&destination=Lisbon&origin=Odemira", mattermostHost: nil)?.kind == "web", "directions open")
        check(OpenDestination.of("https://www.google.com/maps/dir/?api=1&destination=Lisbon", mattermostHost: nil)?.kind == "web", "directions without an origin open")
        check(OpenDestination.of("https://www.google.com/maps/dir/?api=1&origin=Odemira", mattermostHost: nil) == nil, "directions without a destination are refused")
        check(OpenDestination.of("https://www.google.com/maps/search/?api=2&query=Odemira", mattermostHost: nil) == nil, "a maps search without api 1 is refused")
        check(OpenDestination.of("https://plantix.net/", mattermostHost: nil)?.kind == "web", "a site root opens")
        check(OpenDestination.of("https://www.plantix.net/", mattermostHost: nil)?.kind == "web", "a www site root opens")
        check(OpenDestination.of("https://plantix.net/?q=secret", mattermostHost: nil) == nil, "a site root with a query is refused")
        check(OpenDestination.of("https://plantix.net/private", mattermostHost: nil) == nil, "a site path is refused")
        check(OpenDestination.of("http://plantix.net/", mattermostHost: nil) == nil, "a site over http is refused")
        check(OpenDestination.of("https://plantix.net:8443/", mattermostHost: nil) == nil, "a site with a port is refused")
        check(OpenDestination.of("https://user:pw@plantix.net/", mattermostHost: nil) == nil, "a site with user info is refused")
        check(OpenDestination.of("https://plantix.net", mattermostHost: nil) == nil, "a site address without its slash is not the root the host builds")
        // Its own instance: the five-a-minute window above is already spent on the scoped actions.
        let web = NativeActions(home: home, opener: { _, _ in true })
        check(await web.perform(.openURL, target: "https://www.google.com/search?q=odemira").code == .opened, "a search reaches the opener as a web destination")
        check(await web.perform(.openURL, target: "https://plantix.net/private").code == .notAllowed, "a site path never reaches the opener")

        // C-OPEN 1: the native list answers the same table the host test reads, row for row.
        if let data = FileManager.default.contents(atPath: "server/test/fixtures/open-destinations.json"),
           let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let cases = root["cases"] as? [[String: Any]], cases.count >= 40 {
            for row in cases {
                let url = row["url"] as? String ?? ""
                check(OpenDestination.of(url, mattermostHost: nil)?.kind == row["kind"] as? String, "shared table: \(url)")
            }
        } else {
            check(false, "the shared destination table is readable from the repository root")
        }

        // C-OPEN 5: a web destination opens in Chrome when Chrome is installed, else in the default browser.
        check(NativeActions.chromeBundleIdentifier == "com.google.Chrome", "Chrome is named by its bundle id")
        let withChrome = FakeWorkspace(chrome: URL(fileURLWithPath: "/Applications/Google Chrome.app"))
        let chromeActions = NativeActions(home: home, opener: NativeActions.browserOpener(withChrome))
        check(await chromeActions.perform(.openURL, target: "https://docs.google.com/presentation/d/SyntheticDeck01/edit").code == .opened, "a deck opens through the workspace port")
        check(withChrome.calls == ["lookup com.google.Chrome", "app Google Chrome.app https://docs.google.com/presentation/d/SyntheticDeck01/edit"], "Chrome opens the deck when it is installed: \(withChrome.calls)")
        let noChrome = FakeWorkspace(chrome: nil)
        let defaultActions = NativeActions(home: home, opener: NativeActions.browserOpener(noChrome))
        check(await defaultActions.perform(.openURL, target: "https://www.google.com/calendar/event?eid=c3ludGhldGljLWV2ZW50").code == .opened, "a real-shaped event link opens")
        check(noChrome.calls == ["lookup com.google.Chrome", "default https://www.google.com/calendar/event?eid=c3ludGhldGljLWV2ZW50"], "the default browser opens it when Chrome is absent: \(noChrome.calls)")
        let fileChrome = FakeWorkspace(chrome: URL(fileURLWithPath: "/Applications/Google Chrome.app"))
        let fileActions = NativeActions(home: home, opener: NativeActions.browserOpener(fileChrome))
        check(await fileActions.perform(.openFile, target: "~/Documents/plan.md").code == .opened, "a home file still opens")
        check(fileChrome.calls.count == 1 && fileChrome.calls[0].hasPrefix("default file://"), "a file opens in its own app, never in Chrome: \(fileChrome.calls)")
        check(await withChrome.openApplicationProbe(), "the application path stays the workspace launch")

        // 3. Files: inside the home folder only, canonicalized, existing.
        check(await opened.perform(.openFile, target: "~/Documents/plan.md").code == .opened, "a home file opens")
        check(await opened.perform(.openFile, target: home.appendingPathComponent("Documents").path).code == .opened, "a home folder opens")
        check(await opened.perform(.openFile, target: secret.path).code == .notAllowed, "a path outside home is refused")
        check(await opened.perform(.openFile, target: "~/Documents/escape.txt").code == .notAllowed, "a symlink escape is refused")
        check(await opened.perform(.openFile, target: "~/Documents/missing.md").code == .notFound, "a missing file is not_found")
        check(await opened.perform(.openFile, target: "Documents/plan.md").code == .notAllowed, "a relative path is refused")

        // 4. Apps resolve only inside the three application folders.
        check(await opened.perform(.openApp, target: "DefinitelyNotAnApp").code == .notFound, "an unknown app is not_found")
        check(await opened.perform(.openApp, target: "/tmp/Evil.app").code == .notAllowed, "a path is not an app name")
        check(await opened.appURL("DefinitelyNotAnApp") == nil, "no bundle resolves for an unknown name")

        // 5. At most five opens a minute.
        let clock = MutableClock()
        let limited = NativeActions(home: home, opener: { _, _ in true }, clock: { clock.now })
        var codes: [NativeActionCode] = []
        for _ in 0..<6 { codes.append(await limited.perform(.openURL, target: "https://mail.google.com/mail/u/0/#inbox/limit").code) }
        check(codes.prefix(5).allSatisfy { $0 == .opened }, "the first five opens pass")
        check(codes.last == .notAllowed, "the sixth open in a minute is refused")
        clock.advance(by: 61)
        check(await limited.perform(.openURL, target: "https://mail.google.com/mail/u/0/#inbox/limit").code == .opened, "the window slides")

        let openedCount = await counter.count
        check(openedCount >= 3, "the injected opener saw the allowed opens only")
        print(failures == 0 ? "NATIVE-ACTIONS TESTS PASS" : "NATIVE-ACTIONS TESTS FAILED \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}

/// A recording workspace: it opens nothing and names every call it was asked to make.
final class FakeWorkspace: BrowserWorkspace, @unchecked Sendable {
    private let lock = NSLock()
    private let chrome: URL?
    private var recorded: [String] = []
    init(chrome: URL?) { self.chrome = chrome }
    var calls: [String] { lock.withLock { recorded } }
    private func record(_ line: String) { lock.withLock { recorded.append(line) } }
    func applicationURL(bundleIdentifier: String) -> URL? { record("lookup \(bundleIdentifier)"); return chrome }
    func open(_ url: URL, withApplicationAt application: URL) async -> Bool { record("app \(application.lastPathComponent) \(url.absoluteString)"); return true }
    func open(_ url: URL) -> Bool { record("default \(url.absoluteString)"); return true }
    func openApplication(at url: URL) async -> Bool { record("launch \(url.lastPathComponent)"); return true }
    func openApplicationProbe() async -> Bool {
        let before = calls.count
        let opened = await NativeActions.browserOpener(self)(URL(fileURLWithPath: "/Applications/Synthetic.app"), true)
        return opened && calls.dropFirst(before) == ["launch Synthetic.app"]
    }
}

/// A deterministic clock seam: no test ever waits on a real minute.
final class MutableClock: @unchecked Sendable {
    private var current = Date(timeIntervalSince1970: 1_700_000_000)
    var now: Date { current }
    func advance(by seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
}
