import AppKit
import WebKit
import CryptoKit

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
    private static var latestPageDiagnostics: [String: Any] = [:]
    private static func diagnosePage(_ shell: CompanionWeb) async {
        let web = shell.webView
        var value: [String: Any] = ["viewExists": true, "mounted": web.window != nil,
            "nonzeroFrame": web.bounds.width > 0 && web.bounds.height > 0,
            "state": String(describing: shell.state), "urlMatchesExpected": web.url == shell.descriptor.baseURL.appendingPathComponent("/"),
            "rootPageApproved": shell.descriptor.page(web.url), "actualPath": web.url?.path ?? "",
            "expectedPath": shell.descriptor.baseURL.appendingPathComponent("/").path, "navigationStarts": shell.proofNavigationStarts,
            "navigationFinishes": shell.proofNavigationFinishes, "mainFrameHTTPStatus": shell.proofMainFrameHTTPStatus as Any? ?? NSNull(),
            "navigationFailureCode": shell.proofNavigationFailureCode as Any? ?? NSNull()]
        do {
            let result = try await js(web, "({readyState:document.readyState,app:!!document.querySelector('#app'),canvas:!!document.querySelector('#didi-orb'),bodyNonempty:!!document.body&&document.body.innerText.length>0,scriptCount:document.scripts.length})")
            if let dom = result as? [String: Any] { value["dom"] = dom }
        } catch { value["jsErrorCode"] = (error as NSError).code }
        latestPageDiagnostics = value
    }
    private static func pageReady(_ model: AppModel) async throws -> WKWebView {
        guard let shell = model.shell else { throw InstalledProofError.missingUI }
        let until = Date().addingTimeInterval(8)
        while Date() < until {
            await diagnosePage(shell)
            if shell.state == .ready {
                guard shell.webView.url == shell.descriptor.baseURL.appendingPathComponent("/") else { throw InstalledProofError.missingUI }
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
    // Owned WK inspection is available only inside the existing marked synthetic
    // installed proof. No runtime JavaScript/native authority bridge is added.
    @MainActor private final class OrbObservation {
        weak var web: WKWebView?
        var continuation: CheckedContinuation<Any?, Error>?
        var timeout: DispatchWorkItem?
        var cancelled = false
        init(_ web: WKWebView) { self.web = web }
        func complete(_ result: Result<Any?, Error>, cleanup: Bool = false) {
            guard let continuation else { return }
            self.continuation = nil
            timeout?.cancel(); timeout = nil
            if cleanup { web?.evaluateJavaScript("globalThis.__didiOrbProofCancel?.(); true", completionHandler: nil) }
            continuation.resume(with: result)
        }
        func cancel() {
            cancelled = true
            complete(.failure(CancellationError()), cleanup: true)
        }
    }
    private static func orbJavaScript(_ web: WKWebView, _ script: String) async throws -> Any? {
        let observation = OrbObservation(web)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                observation.continuation = continuation
                if observation.cancelled || Task.isCancelled { observation.cancel(); return }
                // Native clock remains live when WK suppresses timers/RAF.
                let timeout = DispatchWorkItem { [weak observation] in
                    Task { @MainActor in
                        observation?.complete(.failure(InstalledProofError.missingUI), cleanup: true)
                    }
                }
                observation.timeout = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
                web.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) { [weak observation] result in
                    switch result {
                    case .success(let value): observation?.complete(.success(value))
                    case .failure(let error): observation?.complete(.failure(error), cleanup: true)
                    }
                }
            }
        }, onCancel: {
            Task { @MainActor in observation.cancel() }
        })
    }
    private static func orbEvidence(_ web: WKWebView, reportURL: URL) async throws -> [String: Any] {
        var frames: [[String: Any]] = []
        var previous = -1
        for index in 0..<3 {
            let script = """
            const canvas=document.querySelector('#didi-orb');
            if(!canvas||typeof canvas.didiFrameStats!=='function')throw Error('orb missing');
            await new Promise((resolve,reject)=>{
              let raf=0;
              const finish=error=>{clearTimeout(timer);cancelAnimationFrame(raf);delete globalThis.__didiOrbProofCancel;error?reject(error):resolve();};
              const timer=setTimeout(()=>finish(Error('orb frame observation expired')),8000);
              globalThis.__didiOrbProofCancel=()=>finish(Error('owned orb proof cancelled'));
              function check(){
                if(document.hidden){finish(Error('owned orb page hidden'));return;}
                if(canvas.didiFrameStats().frames>\(previous)){finish();return;}
                raf=requestAnimationFrame(check);
              }check();
            });
            const stats=canvas.didiFrameStats(),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            let paintedPixels=0;for(let i=3;i<data.length;i+=4)if(data[i])paintedPixels++;
            const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
            const pixelSha256=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
            const rect=canvas.getBoundingClientRect();
            return {stats,paintedPixels,pixelCount:canvas.width*canvas.height,pixelSha256,
              rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},visibility:document.visibilityState};
            """
            guard var measured = try await orbJavaScript(web, script) as? [String: Any],
                  let stats = measured["stats"] as? [String: Any], let count = stats["frames"] as? Int,
                  let pixels = measured["paintedPixels"] as? Int, pixels > 0,
                  stats["renderer"] as? String == "classic-eleven-f27bca7" else { throw InstalledProofError.missingUI }
            previous = count
            measured["snapshot"] = try await pageImage(web, to: reportURL.appendingPathExtension("orb-\(index).png"))
            frames.append(measured)
        }
        let timingScript = """
        const canvas=document.querySelector('#didi-orb'),start=performance.now(),before=canvas.didiFrameStats();
        await new Promise((resolve,reject)=>{
          const finish=error=>{clearTimeout(timer);delete globalThis.__didiOrbProofCancel;error?reject(error):resolve();};
          const timer=setTimeout(()=>finish(document.hidden?Error('owned orb page hidden'):undefined),2000);
          globalThis.__didiOrbProofCancel=()=>finish(Error('owned orb timing cancelled'));
          if(document.hidden)finish(Error('owned orb page hidden'));
        });
        const end=performance.now(),after=canvas.didiFrameStats();
        const indices=after.paintTimes.map((time,index)=>({time,index})).filter(v=>v.time>=start&&v.time<=end);
        return {method:'owned-WKWebView/Canvas2D normal-host observation',windowRequestedMs:2000,
          elapsedMs:end-start,refreshObservation:'owned cumulative draw counters and paint timestamps; timer-bounded wall-clock window',before,after,
          successfulPaints:after.frames-before.frames,failedDraws:after.failedDraws-before.failedDraws,
          attempts:(after.frames-before.frames)+(after.failedDraws-before.failedDraws),sampleCount:indices.length,
          paintTimes:indices.map(v=>v.time),drawMs:indices.map(v=>after.drawMs[v.index]),
          baseline:'source high-tier12idle60active; no artificial load, budget concession or frame dropping for proof'};
        """
        guard let timing = try await orbJavaScript(web, timingScript) as? [String: Any] else { throw InstalledProofError.missingUI }
        return ["frames": frames, "timing": timing, "renderer": "classic-eleven-f27bca7", "nativePid": Int(getpid())]
    }
    static func execute(model: AppModel, window: NSWindow) async -> Bool {
        guard let proof = model.installedProof, let owner = model.supervisor else {
            _ = await OwnedVerificationLaunchGate.perform(window: window) { _ in false }
            await Task { @MainActor in
                await model.shutdown()
                do { try model.installedProof?.cleanCredential() }
                catch { fputs("INSTALLED-PROOF FAILED: configuration credential cleanup\n", stderr) }
            }.value; fputs("INSTALLED-PROOF FAILED: configuration or ownership rejected\n", stderr); return false
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
        let gated = await OwnedVerificationLaunchGate.perform(window: window) { gate in
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
            try gate?.bindService(pid: connection.pid, executable: runtime.node.path, serviceNonce: connection.nonce)
            try Task.checkCancellation()
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
            var visual = report["visual"] as! [String: Any]
            visual["pageSnapshot"] = try await pageImage(fresh, to: proof.report.appendingPathExtension("web-page.png"))
            visual["orb"] = try await orbEvidence(fresh, reportURL: proof.report)
            report["visual"] = visual; report["observations"] = observations
            let readiness = await OwnedWindowReadiness.wait(window) {
                window.makeKeyAndOrderFront(nil)
            }
            let readinessTrace: [String: Any] = ["nativePid": Int(getpid()), "windowId": window.windowNumber,
                "ready": readiness.ready, "events": readiness.events, "diagnostics": readiness.diagnostics]
            report["axConsumer"] = ["stage": "before-connected-own-AX", "windowReadiness": readinessTrace]
            try proof.write(report)
            guard readiness.ready else { throw InstalledProofError.accessibility }
            let observation = OwnedWindowProof.observe(window)
            var consumerTrace = observation.trace
            consumerTrace["windowReadiness"] = readinessTrace
            report["axConsumer"] = consumerTrace
            let controls = observation.controls
            visual["accessibility"] = controls
            do { visual["nativeChrome"] = try await OwnedWindowProof.capture(window, to: proof.screenshot); visual["nativeChromeLimitation"] = "Own-process native chrome captured without requesting grants; root visual review required." }
            catch { visual["nativeChromeError"] = ["domain": (error as NSError).domain, "code": (error as NSError).code, "cause": (error as? OwnedWindowProof.CaptureFailure)?.rawValue ?? "sdk-or-bound", "stage": OwnedWindowProof.captureStage]; visual["nativeChromeLimitation"] = "Bounded own-process capture failed or unavailable; native chrome not visually verified. Actual WK page and own AX states are supplied." }
            report["axDirectTrace"] = OwnedWindowProof.accessibilityTrace(window)
            var consumer = report["axConsumer"] as! [String: Any]
            consumer["capture"] = OwnedWindowProof.captureEvidence
            report["axConsumer"] = consumer
            report["visual"] = visual
            guard Set(controls.compactMap({ $0["name"] as? String })) == ["Start recording", "Stop recording", "Send text"], controls.allSatisfy({ $0["visible"] as? Bool == true }) else { throw InstalledProofError.accessibility }
        } catch { failure = error }
        return failure == nil
        }
        if !gated { failure = failure ?? InstalledProofError.unavailable }
        observations["credentialImported"] = owner.credentialImported; report["observations"] = observations
        // Joined, cancellation-independent finalization on every work/gate outcome.
        await Task { @MainActor in
        await model.shutdown()
        if let stopped = owner.lastStop { report["serviceStop"] = stopped }
        if owner.credentialImported {
            do { try proof.cleanCredential(); report["credentialCleanup"] = ["scope": "synthetic-proof-only", "attempted": true, "cleaned": true, "errorCode": null] }
            catch { report["credentialCleanup"] = ["scope": "synthetic-proof-only", "attempted": true, "cleaned": false, "errorCode": code(error)]; failure = failure ?? error }
        }
        if failure == nil, owner.lastStop?["observedExited"] as? Bool != true { failure = InstalledProofError.unavailable }
        report["native"] = ["pid": Int(getpid()), "cleanQuitRequested": true, "exitEvidence": "external-driver-required"]
        }.value
        report["phase"] = failure == nil ? "complete" : "failed"; report["success"] = failure == nil
        report["wkDiagnostics"] = latestPageDiagnostics
        if let failure { report["error"] = ["code": model.bootstrapFailureCode ?? code(failure)] }
        do { try proof.write(report) } catch { fputs("INSTALLED-PROOF FAILED: report write refused\n", stderr); return false }
        return failure == nil
    }
}
