import AppKit
import WebKit
import CryptoKit

struct SyntheticProofRecord {
    let sessionId: String
    let entryId: String
    let text: String
    func report(visible: Bool) -> [String: Any] { ["sessionId": sessionId, "entryId": entryId, "text": text, "visibleInCanonicalUI": visible] }
}

@MainActor enum InstalledProofRun {
    private static func hash(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }
    private static func code(_ error: Error) -> String {
        if let value = error as? InstalledProofError { return String(describing: value) }
        if let value = error as? NativeServiceError { return String(describing: value) }
        if let value = error as? CompanionError { return String(describing: value) }
        return "platformFailure"
    }
    private static func js(_ web: WKWebView, _ script: String) async throws -> Any? {
        try await web.evaluateJavaScript(script)
    }
    private static func visible(_ record: SyntheticProofRecord, web: WKWebView) async throws -> Bool {
        let literal = String(data: try JSONSerialization.data(withJSONObject: record.text, options: [.fragmentsAllowed]), encoding: .utf8)!
        let check = "document.body.innerText.includes(\(literal))"
        if try await js(web, check) as? Bool == true { return true }
        // Ordinary visible navigation only. No privileged JS/API/command bridge.
        for tab in ["Conversation", "Conversations"] {
            _ = try await js(web, "Array.from(document.querySelectorAll('button,a,[role=button]')).find(e=>e.innerText.trim()==='\(tab)')?.click(); true")
        }
        let count = try await js(web, "Array.from(document.querySelectorAll('button,a,[role=button]')).filter(e=>e.innerText.includes('Native capture')&&e.getBoundingClientRect().width>0).length") as? Int ?? 0
        for index in 0..<min(count, 20) {
            _ = try await js(web, "Array.from(document.querySelectorAll('button,a,[role=button]')).filter(e=>e.innerText.includes('Native capture')&&e.getBoundingClientRect().width>0)[\(index)]?.click(); true")
            let until = Date().addingTimeInterval(0.5)
            while Date() < until {
                if try await js(web, check) as? Bool == true { return true }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        return false
    }
    private static func pageReady(_ model: AppModel) async throws -> WKWebView {
        guard let shell = model.shell else { throw InstalledProofError.missingUI }
        let until = Date().addingTimeInterval(8)
        while Date() < until {
            if shell.state == .ready {
                guard shell.webView.url == shell.descriptor.baseURL else { throw InstalledProofError.missingUI }
                // Actual shared Naya implementation is Canvas2D/DOM, not the fixture div.
                if try await js(shell.webView, "!!document.querySelector('canvas')&&document.body.innerText.length>0") as? Bool == true { return shell.webView }
            }
            if case .unavailable = shell.state { throw InstalledProofError.missingUI }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw InstalledProofError.missingUI
    }
    private static func pageImage(_ web: WKWebView, to output: URL) async throws -> [String: Any] {
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            web.takeSnapshot(with: nil) { image, error in
                if let image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: error ?? InstalledProofError.missingUI) }
            }
        }
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) else { throw InstalledProofError.missingUI }
        try data.write(to: output, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        return ["method": "actual-WKWebView.takeSnapshot", "path": output.path, "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh, "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()]
    }
    static func execute(model: AppModel, window: NSWindow) async -> Bool {
        guard let proof = model.installedProof, let owner = model.supervisor else {
            await model.shutdown(); fputs("INSTALLED-PROOF FAILED: configuration or ownership rejected\n", stderr); return false
        }
        let runtime = owner.runtime
        let permission = CGPreflightScreenCaptureAccess()
        var observations: [String: Any] = ["credentialImported": false, "bootstrap": false, "canonicalUIReady": false, "priorRecallComplete": false, "newSaved": false]
        let null = NSNull()
        var report: [String: Any] = ["phase": "running", "success": false, "runId": UUID().uuidString.lowercased(),
            "source": [:], "native": ["pid": Int(getpid()), "cleanQuitRequested": false, "exitEvidence": "external-driver-required"],
            "service": null, "priorRecords": [], "newRecord": null, "observations": observations,
            "visual": ["windowId": window.windowNumber > 0 ? window.windowNumber as Any : null, "screenCapturePermission": permission,
                       "pageSnapshot": null, "nativeChrome": null, "nativeChromeLimitation": "Native chrome not visually verified.", "accessibility": [], "rootVisualReviewRequired": true],
            "serviceStop": ["requested": false, "observedExited": false, "pid": null, "exitStatus": null, "terminationReason": null, "procedure": "private-stdin-close-and-bounded-owned-escalation"],
            "credentialCleanup": ["scope": "synthetic-proof-only", "attempted": false, "cleaned": false, "errorCode": null], "error": null]
        var failure: Error?
        do {
            let resources = Bundle.main.resourceURL!
            report["source"] = ["appIdentifier": Bundle.main.bundleIdentifier ?? "", "bundlePath": Bundle.main.bundleURL.path,
                "releaseCommit": runtime.releaseCommit, "nativeExecutableSHA256": try hash(Bundle.main.executableURL!),
                "manifestSHA256": try hash(resources.appendingPathComponent("didi-runtime.json")), "serverEntrySHA256": try hash(runtime.serverEntry),
                "nodePath": runtime.node.path, "serverEntry": String(runtime.serverEntry.path.dropFirst(resources.resolvingSymlinksInPath().path.count + 1)),
                "webRoot": String(runtime.webRoot.path.dropFirst(resources.resolvingSymlinksInPath().path.count + 1))]
            try proof.write(report)
            await model.reconnect()
            guard let connection = owner.currentConnection, let client = model.client else { throw InstalledProofError.unavailable }
            observations["credentialImported"] = owner.credentialImported; observations["bootstrap"] = true
            report["service"] = ["pid": Int(connection.pid), "nonce": connection.nonce, "origin": connection.descriptor.origin,
                                  "authorityEpoch": connection.authorityEpoch, "assistantId": connection.assistantId, "readyVerified": true]
            let web = try await pageReady(model); observations["canonicalUIReady"] = true
            let prior = try await client.proofRecords(prefix: proof.recordPrefix)
            observations["priorRecallComplete"] = true
            var priorResults: [[String: Any]] = []
            for record in prior {
                let shown = try await visible(record, web: web); priorResults.append(record.report(visible: shown))
                report["priorRecords"] = priorResults
                guard shown else { throw InstalledProofError.missingUI }
            }
            let text = proof.recordPrefix + "run " + (report["runId"] as! String)
            model.draft = text; await model.saveDraft()
            guard client.captureStatus == .saved, let saved = client.captureReceipt else { throw InstalledProofError.persistence }
            observations["newSaved"] = true
            // Fresh ordinary bootstrap/load observes service persistence, not local DOM insertion.
            await model.reconnect()
            let fresh = try await pageReady(model)
            let recalled = try await client.proofRecords(prefix: proof.recordPrefix)
            guard let record = recalled.first(where: { $0.entryId == saved.entryID && $0.sessionId == saved.sessionID && $0.text == text }) else { throw InstalledProofError.persistence }
            let shown = try await visible(record, web: fresh); report["newRecord"] = record.report(visible: shown)
            guard shown else { throw InstalledProofError.missingUI }
            let controls = OwnedWindowProof.accessibility(window)
            guard Set(controls.compactMap({ $0["name"] as? String })) == ["Start recording", "Stop recording", "Send text"], controls.allSatisfy({ $0["visible"] as? Bool == true }) else { throw InstalledProofError.accessibility }
            var visual = report["visual"] as! [String: Any]; visual["accessibility"] = controls
            visual["pageSnapshot"] = try await pageImage(fresh, to: proof.report.appendingPathExtension("web-page.png"))
            if permission {
                do { visual["nativeChrome"] = try await OwnedWindowProof.capture(window, to: proof.screenshot); visual["nativeChromeLimitation"] = "Native chrome captured; root visual review required." }
                catch { visual["nativeChromeLimitation"] = "Existing permission, but supported native-chrome capture failed; visual verification remains external." }
            } else { visual["nativeChromeLimitation"] = "Screen-capture permission unavailable; native chrome not visually verified. Actual WK page and own AX states are supplied." }
            report["visual"] = visual
        } catch { failure = error }
        observations["credentialImported"] = owner.credentialImported; report["observations"] = observations
        await model.shutdown()
        if let stopped = owner.lastStop { report["serviceStop"] = stopped }
        if owner.credentialImported {
            do { try proof.cleanCredential(); report["credentialCleanup"] = ["scope": "synthetic-proof-only", "attempted": true, "cleaned": true, "errorCode": null] }
            catch { report["credentialCleanup"] = ["scope": "synthetic-proof-only", "attempted": true, "cleaned": false, "errorCode": code(error)]; failure = failure ?? error }
        }
        if failure == nil, owner.lastStop?["observedExited"] as? Bool != true { failure = InstalledProofError.unavailable }
        report["native"] = ["pid": Int(getpid()), "cleanQuitRequested": true, "exitEvidence": "external-driver-required"]
        report["phase"] = failure == nil ? "complete" : "failed"; report["success"] = failure == nil
        if let failure { report["error"] = ["code": code(failure)] }
        do { try proof.write(report) } catch { fputs("INSTALLED-PROOF FAILED: report write refused\n", stderr); return false }
        return failure == nil
    }
}
