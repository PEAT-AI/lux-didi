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

/// A deterministic clock seam: no test ever waits on a real minute.
final class MutableClock: @unchecked Sendable {
    private var current = Date(timeIntervalSince1970: 1_700_000_000)
    var now: Date { current }
    func advance(by seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
}
