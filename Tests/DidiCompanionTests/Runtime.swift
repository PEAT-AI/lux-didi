import AppKit
import WebKit
import Security

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
    @MainActor static func js(_ web: WKWebView, _ source: String) async throws -> Any? {
        try await web.evaluateJavaScript(source)
    }
    static func fixture(_ origin: String, _ path: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: origin + path)!)
        return (try JSONSerialization.jsonObject(with: data) as! [String: Any])["data"] as! [String: Any]
    }
    @MainActor static func main() {
        let policy = NativeKeychainPolicy.establish()
        guard policy == errSecSuccess else {
            fputs("COMPANION POLICY: unavailable (\(policy))\n", stderr); exit(2)
        }
        if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--keychain-sdk-child" {
            do {
                let passed = try KeychainSDKProof.run(mode: CommandLine.arguments[2], state: URL(fileURLWithPath: CommandLine.arguments[3]), output: URL(fileURLWithPath: CommandLine.arguments[4]))
                exit(passed ? 0 : 1)
            } catch { fputs("KEYCHAIN-SDK child failed before completion\n", stderr); exit(1) }
        }
        let app = NSApplication.shared
        // This foreground WK fixture needs regular activation semantics; the
        // actual companion remains an accessory/menu-bar app in its own proof.
        expect(app.setActivationPolicy(.regular), "foreground fixture activation policy accepted")
        // Publish the actual AppKit application/AX lifecycle, as production does.
        // An async CLI main alone leaves own-PID AXWindows NotImplemented.
        Task {
            let passed = await OwnedVerificationLaunchGate.perform { _ in await runFixtures() }
            exit(passed ? 0 : 1)
        }
        app.run()
    }
    @MainActor private static func runFixtures() async -> Bool {
        let started = Date()
        let ready = URL(fileURLWithPath: CommandLine.arguments[1])
        await waitFor("fixture ready") { FileManager.default.fileExists(atPath: ready.path) }
        do {
            try InstalledProofTests.run()
            try await LifecycleProof.run(node: CommandLine.arguments[3])
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
            NSApp.activate(ignoringOtherApps: true)
            expect(!shell.webView.configuration.websiteDataStore.isPersistent, "nonpersistent website store")
            let cookie = try await client.bootstrap()
            expect(cookie.isHTTPOnly, "service cookie is HttpOnly")
            await shell.load(cookie: cookie)
            await waitFor("authenticated service page rendered") { shell.state == .ready }
            expect(try await js(shell.webView, "document.body.dataset.authenticated") as? String == "yes", "cookie authenticated document request")
            expect(try await js(shell.webView, "document.cookie") as? String == "", "HttpOnly cookie invisible to document.cookie")
            // A connected WK subtree must never be consumed from a detached AX task:
            // WebKit aborts on its main-thread-only accessibility implementation.
            window.orderOut(nil)
            let unavailable = await OwnedWindowReadiness.wait(window, timeout: 20_000_000) {}
            expect(!unavailable.ready && unavailable.events.last?["event"] as? String == "deadline", "hidden owned window fails readiness at finite deadline")
            let loop = unavailable.diagnostics["runLoop"] as! [String: Any]
            expect((loop["count"] as? Int ?? 0) > 0 && loop["firstUptimeNanoseconds"] is UInt64 && loop["lastUptimeNanoseconds"] is UInt64,
                   "hidden-window deadline observes actual main run-loop liveness")
            expect(loop["disposed"] as? Bool == true, "deadline disposes readiness callbacks")
            let cancelledReadiness = Task { await OwnedWindowReadiness.wait(window) {} }
            cancelledReadiness.cancel()
            let cancellation = await cancelledReadiness.value
            expect(!cancellation.ready && cancellation.events.last?["event"] as? String == "cancelled" &&
                   (cancellation.diagnostics["runLoop"] as? [String: Any])?["disposed"] as? Bool == true,
                   "cancelled readiness disposes callbacks without claiming activation")
            let readiness = await OwnedWindowReadiness.wait(window) {
                window.makeKeyAndOrderFront(nil)
            }
            let readinessReport = URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("connected-wk-readiness.json")
            let readinessData = try JSONSerialization.data(withJSONObject: ["nativePid": Int(getpid()), "windowId": window.windowNumber,
                "ready": readiness.ready, "events": readiness.events, "diagnostics": readiness.diagnostics,
                "hiddenDeadline": unavailable.events, "hiddenDiagnostics": unavailable.diagnostics, "cancelDiagnostics": cancellation.diagnostics], options: [.prettyPrinted, .sortedKeys])
            try readinessData.write(to: readinessReport, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: readinessReport.path)
            expect(readiness.ready && NSApp.isActive && window.isMainWindow && window.isKeyWindow && window.isVisible && window.occlusionState.contains(.visible),
                   "owned connected fixture window active/main/key/unoccluded before AX")
            let connectedAX = await OwnedWindowProof.consumerTrace(window)
            // Retain the exact fixture observation even when its identity gate fails.
            let axReport = URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("connected-wk-ax.json")
            let axData = try JSONSerialization.data(withJSONObject: ["nativePid": Int(getpid()), "windowId": window.windowNumber, "axConsumer": connectedAX], options: [.prettyPrinted, .sortedKeys])
            try axData.write(to: axReport, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: axReport.path)
            expect(connectedAX["queryOnMainThread"] as? Bool == true, "connected own-window AX traversal stays on AppKit thread")
            expect(connectedAX["geometryMatches"] as? Int == 1, "connected WK window uniquely identified by public own-PID geometry")
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
            await client.rebind(descriptor: descriptor, credential: { config["credential"] as! String }, expectedEpoch: config["authorityEpoch"] as! String, connectionGuard: { true })
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
            await waitFor("unavailable service not blank forever") { bad.state == .unavailable }
            expect(bad.diagnosticEvents.contains(where: { $0.contains("did-finish-approved-false") }), "blocked-port internal completion is not accepted as service UI")
            let refreshed = try await client.bootstrap()
            _ = try await fixture(origin, "/fixture/mode/stall")
            let stalledAt = Date()
            await shell.load(cookie: refreshed)
            await waitFor("unresponsive service has finite unavailable state") { shell.state == .unavailable }
            expect(Date().timeIntervalSince(stalledAt) < CompanionWeb.loadTimeout + 1, "five-second product deadline bounds an unanswered HTTP response")
            expect(shell.diagnosticEvents.contains(where: { $0.contains("deadline-expired") }), "unanswered response exercises product timeout, not callback failure")
            // Reconnect is explicit; the fixture handles it independently of
            // the first withheld request. No automatic retry is introduced.
            await shell.load(cookie: try await client.bootstrap())
            await waitFor("finite timeout recovers explicitly") { shell.state == .ready }
            let model = AppModel()
            model.draft = "Synthetic draft retained"
            await model.saveDraft()
            expect(model.draft == "Synthetic draft retained" && model.captureStatus != .saved, "unconfigured save cannot pretend success")
            expect(model.voice.state.phase == .idle, "microphone not started")
            expect(model.voice.preparedPlayback("No playback").volume == 0, "playback preparation muted, never spoken")
            window.contentView = shell.webView
            await shell.load(cookie: try await client.bootstrap())
            await waitFor("screenshot document ready") { shell.state == .ready }
            let renderer = try await js(shell.webView, """
                (() => {
                    const canvas = document.createElement('canvas');
                    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                    if (!gl) return JSON.stringify({probe: 'WebGL diagnostic', available: false, canvas2DAcceleration: 'not measurable through public API'});
                    const info = gl.getExtension('WEBGL_debug_renderer_info');
                    const result = {probe: 'WebGL diagnostic only, not UI backend', available: true,
                        renderer: gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
                        vendor: gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
                        canvas2DAcceleration: 'not measurable through public API'};
                    gl.getExtension('WEBGL_lose_context')?.loseContext();
                    return JSON.stringify(result);
                })()
                """) as? String ?? "Renderer probe unavailable"
            print("COMPANION-RENDERER \(renderer)")
            try Data(renderer.utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("webkit-renderer.json"))
            let image = try await shell.webView.takeSnapshot(configuration: nil)
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "snapshot", code: 1) }
            try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("companion-webkit.png"))
            print("COMPANION-RUNTIME PASS duration=\(Date().timeIntervalSince(started))s renderer=actual-WKWebView snapshot=companion-webkit.png audioCapture=not-started playback=not-started notifications=not-sent")
            window.orderOut(nil)
            await client.revokePageSession()
            return true
        } catch {
            fputs("COMPANION FAIL: \(error)\n", stderr)
            return false
        }
    }
}
