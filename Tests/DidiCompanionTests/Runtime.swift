import AppKit
import WebKit

@main enum CompanionRuntime {
    @MainActor static func expect(_ value: Bool, _ label: String) {
        guard value else { fputs("COMPANION FAIL: \(label)\n", stderr); exit(1) }
        print("PASS: \(label)")
    }
    @MainActor static func waitFor(_ label: String, _ predicate: () -> Bool) async {
        let deadline = Date().addingTimeInterval(8)
        while !predicate() && Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        expect(predicate(), label)
    }
    @MainActor static func js(_ web: WKWebView, _ source: String) async throws -> Any {
        try await web.evaluateJavaScript(source)
    }
    static func fixture(_ origin: String, _ path: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: origin + path)!)
        return (try JSONSerialization.jsonObject(with: data) as! [String: Any])["data"] as! [String: Any]
    }
    @MainActor static func main() async {
        let started = Date()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let ready = URL(fileURLWithPath: CommandLine.arguments[1])
        await waitFor("fixture ready") { FileManager.default.fileExists(atPath: ready.path) }
        do {
            let config = try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as! [String: Any]
            let origin = "http://127.0.0.1:\(config["port"] as! Int)"
            let descriptor = try ServiceDescriptor(origin: origin, credentialService: "synthetic", credentialAccount: "fixture")
            for bad in ["http://localhost:1234", "https://example.com:443", "http://127.0.0.1", origin + "/other", origin + "?token=secret", "http://user@127.0.0.1:1234"] {
                expect((try? ServiceDescriptor(origin: bad, credentialService: "test", credentialAccount: "test")) == nil, "invalid/unpaired origin refused")
            }
            let client = CompanionClient(descriptor: descriptor, credential: { config["credential"] as! String })
            let shell = CompanionWeb(descriptor: descriptor)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 700), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.contentView = shell.webView
            window.makeKeyAndOrderFront(nil)
            expect(!shell.webView.configuration.websiteDataStore.isPersistent, "nonpersistent website store")
            let cookie = try await client.bootstrap()
            expect(cookie.isHTTPOnly, "service cookie is HttpOnly")
            await shell.load(cookie: cookie)
            await waitFor("authenticated service page rendered") { shell.state == .ready }
            expect(try await js(shell.webView, "document.body.dataset.authenticated") as? String == "yes", "cookie authenticated document request")
            expect(try await js(shell.webView, "document.cookie") as? String == "", "HttpOnly cookie invisible to document.cookie")
            expect(try await js(shell.webView, "typeof window.webkit?.messageHandlers") as? String == "undefined", "zero JavaScript authority handlers")
            expect(try await shell.webView.callAsyncJavaScript("const r = await fetch('/api/v1/auth/session'); const x = await r.json(); return Boolean(x.data.csrfToken)", arguments: [:], in: nil, contentWorld: .page) as? Bool == true, "page reads CSRF through normal API")
            let initial = try await js(shell.webView, "document.body.dataset.instance") as? String
            window.orderOut(nil); window.makeKeyAndOrderFront(nil)
            expect(try await js(shell.webView, "document.body.dataset.instance") as? String == initial, "hide/show preserves exact page session")
            expect(try await js(shell.webView, "window.open('/','evil') === null") as? Bool == true, "programmatic popup refused")
            _ = try await js(shell.webView, "let f=document.createElement('iframe'); f.src='/frame'; document.body.appendChild(f); 'attempted'")
            await waitFor("subframe denied") { shell.deniedNavigations > 0 }
            for url in ["http://127.0.0.1:1/", "http://localhost:\(config["port"] as! Int)/", origin + "/download"] {
                let before = shell.deniedNavigations
                shell.webView.load(URLRequest(url: URL(string: url)!))
                await waitFor("unexpected navigation denied") { shell.deniedNavigations > before }
                expect(shell.webView.url?.absoluteString == origin + "/", "origin/port/path restriction retains canonical document")
            }
            shell.simulateTermination()
            expect(shell.state == .unavailable, "WebContent termination surfaces retry")
            await shell.load(cookie: try await client.bootstrap())
            await waitFor("explicit recovery rendered") { shell.state == .ready }
            for mode in ["redirect", "download"] {
                let refreshed = try await client.bootstrap()
                _ = try await fixture(origin, "/fixture/mode/" + mode)
                await shell.load(cookie: refreshed)
                await waitFor("server \(mode) response refused") { shell.state == .unavailable }
                await shell.load(cookie: try await client.bootstrap())
                await waitFor("response rejection recovers explicitly") { shell.state == .ready }
            }
            _ = try await fixture(origin, "/fixture/expire")
            await shell.load(cookie: cookie)
            await waitFor("authentication expiry becomes unavailable") { shell.state == .unavailable }
            await shell.load(cookie: try await client.bootstrap())
            await waitFor("authentication expiry rebootstrap rendered") { shell.state == .ready }
            do {
                _ = try await client.capture(text: "Synthetic native capture", timeZone: "UTC")
                expect(false, "fixture drops first saved response")
            } catch { expect(client.captureStatus == .unknown, "lost reply yields unknown, not false failure or success") }
            let receipt = try await client.retryCapture()
            expect(!receipt.entryID.isEmpty, "authenticated native synthetic capture saved")
            let replay = try await client.retryCapture()
            expect(replay.entryID == receipt.entryID, "stable idempotency identity prevents duplicate capture")
            let counts = try await fixture(origin, "/fixture/counts") as! [String: Int]
            expect(counts["entries"] == 1 && counts["frames"] == 0, "one business entry and zero subframe requests")
            let cancelled = Task { try await client.capture(text: "Cancelled synthetic", timeZone: "UTC") }
            cancelled.cancel()
            do { _ = try await cancelled.value; expect(false, "cancelled capture did not dispatch") }
            catch { expect(client.captureStatus == .cancelled, "cancellation before dispatch distinguished") }
            await client.revokePageSession()
            shell.clear()
            expect(shell.state == .unavailable, "clean logout clears scoped page")
            let bad = CompanionWeb(descriptor: try ServiceDescriptor(origin: "http://127.0.0.1:1", credentialService: "test", credentialAccount: "test"))
            await bad.load(cookie: cookie)
            // Temporary R3 observation: original assertion deadline is 8s; observe
            // the unchanged 12s product timer, then intentionally stop this red stage.
            try await Task.sleep(nanoseconds: 8_000_000_000)
            print("R3-DIAGNOSTIC at-original-8s state=\(bad.state) events=\(bad.diagnosticEvents)")
            try await Task.sleep(nanoseconds: 5_000_000_000)
            print("R3-DIAGNOSTIC after-product-12s state=\(bad.state) events=\(bad.diagnosticEvents)")
            expect(false, "R3 diagnosis intentionally red; unavailable contract not fixed")
            let model = AppModel()
            model.draft = "Synthetic draft retained"
            await model.saveDraft()
            expect(model.draft == "Synthetic draft retained" && model.captureStatus != .saved, "unconfigured save cannot pretend success")
            expect(model.voice.state.phase == .idle, "microphone not started")
            expect(model.voice.preparedPlayback("No playback").volume == 0, "playback preparation muted, never spoken")
            window.contentView = shell.webView
            await shell.load(cookie: try await client.bootstrap())
            await waitFor("screenshot document ready") { shell.state == .ready }
            let image = try await shell.webView.takeSnapshot(configuration: nil)
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "snapshot", code: 1) }
            try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("companion-webkit.png"))
            print("COMPANION-RUNTIME PASS duration=\(Date().timeIntervalSince(started))s renderer=actual-WKWebView snapshot=companion-webkit.png audioCapture=not-started playback=not-started notifications=not-sent")
            window.orderOut(nil)
            await client.revokePageSession()
            exit(0)
        } catch {
            fputs("COMPANION FAIL: \(error)\n", stderr)
            exit(1)
        }
    }
}
