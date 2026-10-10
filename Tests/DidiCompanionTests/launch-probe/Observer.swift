import AppKit

@main @MainActor struct ProbeObserver {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let observer = Observer()
        observer.start()
        app.run()
    }
}
@MainActor final class Observer {
    let original = CommandLine.arguments
    var verification: Bool { original.count > 1 && original[1] == "--verification" }
    var args: [String] { verification ? [original[0]] + Array(original.dropFirst(2)) : original }
    var target: NSRunningApplication?
    var facts: ProbeIdentity?
    var record: [String: Any]?
    var watch: DispatchSourceFileSystemObject?
    var deadline: DispatchSourceTimer?
    var directory: Int32 = -1
    var kernel: Int32 = -1
    var failureIdentity: [String: Any] = [:]
    var control: Int32 = -1
    // eof-pre closes the control socket on purpose (control = -1). Dialling is
    // therefore tracked separately so a later directory write can never re-dial
    // a gate that has already served its connection.
    var dialed = false
    var serviceFD: Int32 = -1
    var serviceFacts: ProbeIdentity?
    var serviceRecord: [String: Any]?
    var nativeResult: [String: Any]?
    var pidReuseRefused = false, driverMixupRefused = false
    var cancelSent = false
    var forced = false
    var released = false
    var settled = false
    var bundle: String { physicalPath(args[1]) }
    var expectedExecutable: String { bundle + "/Contents/MacOS/" + (verification ? "LuxDidi" : "LaunchProbe") }
    var root: String { args[2] }
    var nonce: String { args[3] }
    func start() {
        guard verification ? args.count >= 5 : args.count == 5 else { exit(1) }
        if verification {
            do { try Data(nonce.utf8).write(to: URL(fileURLWithPath: root + "/nonce")); chmod(root + "/nonce", 0o600) }
            catch { fail("nonce marker"); return }
        }
        directory = open(root, O_EVTONLY)
        guard directory >= 0 else { fail("directory") ; return }
        watch = DispatchSource.makeFileSystemObjectSource(fileDescriptor: directory, eventMask: .write, queue: .main)
        watch?.setEventHandler { [self] in MainActor.assumeIsolated { handshake(); bindServiceIfReady() } }
        watch?.resume()
        deadline = DispatchSource.makeTimerSource(queue: .main)
        deadline?.schedule(deadline: .now() + (verification ? 8 : 12))
        deadline?.setEventHandler { [self] in MainActor.assumeIsolated { timeout() } }
        deadline?.resume()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.promptsUserIfNeeded = false
        configuration.addsToRecentItems = false
        configuration.arguments = verification ? Array(args.dropFirst(5)) : [root, nonce, args[4]]
        var environment = ProcessInfo.processInfo.environment
        if verification { environment["LUX_VERIFICATION_GATE_ROOT"] = root; environment["LUX_VERIFICATION_GATE_NONCE"] = nonce }
        configuration.environment = environment
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: bundle), configuration: configuration) { app, error in
            Task { @MainActor in
                guard !self.settled else { return }
                guard error == nil, let app, app.bundleURL.map({ physicalPath($0.path) }) == self.bundle else { self.fail("own launch identity"); return }
                self.target = app
                do {
                    let (facts, record) = try identity(app.processIdentifier, nonce: self.nonce, bundle: self.bundle)
                    self.failureIdentity = ["observed": record, "expectedUID": Int(getuid()),
                        "expectedExecutable": self.expectedExecutable,
                        "returnedPID": Int(app.processIdentifier), "returnedBundle": self.bundle]
                    guard facts.uid == getuid(), record["executable"] as? String == self.expectedExecutable else { self.fail("own kernel identity"); return }
                    self.record = record
                    self.kernel = probe_register(app.processIdentifier)
                    guard self.kernel >= 0 else { self.fail("kernel registration errno=\(errno)"); return }
                    self.handshake()
                } catch { self.fail("kernel identity") }
            }
        }
    }
    func handshake() {
        // The app's gate listens as soon as it writes identity.json. The
        // pre-release cancellation modes must reach that gate even when the
        // LaunchServices completion callback (which sets target/record/kernel)
        // arrives after the app's own gate window, so they connect from here.
        let preRelease = ["cancel-pre", "eof-pre", "bad-nonce"].contains(args[4])
        guard !settled, !released, !dialed,
              FileManager.default.fileExists(atPath: root + "/identity.json"),
              (kernel >= 0 && record != nil) || preRelease else { return }
        do {
            let reported = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/identity.json"))) as! [String: Any]
            let reportedPID = target.map { Int($0.processIdentifier) } ?? (reported["pid"] as? Int ?? 0)
            guard reportedPID > 0, reported["nonce"] as? String == nonce,
                  physicalPath(reported["bundleURL"] as? String ?? "") == bundle,
                  target == nil || Int(target!.processIdentifier) == reportedPID else { fail("identity changed or nonce mismatch"); return }
            let (current, actual) = try identity(pid_t(reportedPID), nonce: nonce, bundle: bundle)
            guard current.uid == getuid(), actual["executable"] as? String == expectedExecutable,
                  record.map({ NSDictionary(dictionary: actual).isEqual(to: $0) }) ?? true,
                  verification || (record.map({ NSDictionary(dictionary: reported).isEqual(to: $0) }) ?? false) else { fail("identity changed or nonce mismatch"); return }
            if verification {
                var reused = current; reused.microseconds ^= 1
                var mixed = current; mixed.pid = getpid()
                pidReuseRefused = probe_cleanup(reused, expectedExecutable) != 0
                driverMixupRefused = probe_cleanup(mixed, expectedExecutable) != 0
                guard pidReuseRefused, driverMixupRefused else { fail("cleanup identity negative controls"); return }
            }
            facts = current // Cleanup authority only after complete kernel + bundle + nonce identity.
            if verification {
                control = probe_connect("/tmp/didi-verification-" + nonce + ".sock")
                guard control >= 0 else { fail("control connection errno=\(errno)"); return }
                dialed = true
                if args[4] == "cancel-pre" { send("cancel") }
                else if args[4] == "eof-pre" { close(control); control = -1 }
                else if args[4] == "bad-nonce" { send("release", nonce: UUID().uuidString) }
                else { send("release"); released = true }
                deadline?.schedule(deadline: .now() + 120)
            } else {
                let fd = open(root + "/release.fifo", O_WRONLY | O_NONBLOCK)
                guard fd >= 0 else { fail("release gate"); return }
                let bytes = Array(nonce.utf8)
                let count = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
                close(fd)
                guard count == bytes.count else { fail("partial release"); return }
                released = true
            }
            let kernelFD = kernel
            let waitSeconds: Int32 = verification ? 130 : 10
            DispatchQueue.global().async {
                var raw: Int64 = -1, flags: UInt32 = 0, filter: Int16 = 0
                let result = probe_wait(kernelFD, waitSeconds, &raw, &flags, &filter)
                let error = errno
                Task { @MainActor in
                    guard result == 0 else { self.fail("kernel event errno=\(error)"); return }
                    self.complete(raw, flags: flags, filter: filter)
                }
            }
        } catch { fail("identity record") }
    }
    func dispose() {
        settled = true; deadline?.cancel(); watch?.cancel()
        if directory >= 0 { close(directory); directory = -1 }
        if kernel >= 0 { close(kernel); kernel = -1 }
        if serviceFD >= 0 { close(serviceFD); serviceFD = -1 }
        if control >= 0 { close(control); control = -1 }
    }
    func complete(_ raw: Int64, flags: UInt32, filter: Int16) {
        guard !settled, let record else { return }
        var serviceKernel: [String: Any] = [:]
        if verification, serviceFD >= 0 {
            var status: Int64 = -1, serviceFlags: UInt32 = 0, serviceFilter: Int16 = 0
            guard probe_wait(serviceFD, 10, &status, &serviceFlags, &serviceFilter) == 0 else { fail("service kernel exit"); return }
            serviceKernel = ["rawStatus": status, "flags": serviceFlags, "filter": serviceFilter, "statusRequested": true]
        }
        let release = (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/release.json")))) as? [String: Any]
        let nativeDisposition = (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/native-disposed.json")))) as? [String: Any]
        settled = true; dispose()
        do {
            var output: [String: Any] = ["case": args[4], "bundleURL": bundle, "identity": record, "observerPid": Int(getpid()),
                "identityVerified": true, "registeredBeforeRelease": true, "released": released, "observerDisposed": true,
                "kernel": ["rawStatus": raw, "flags": flags, "filter": filter, "statusRequested": true]]
            if verification {
                output["serviceIdentity"] = serviceRecord as Any? ?? NSNull(); output["serviceKernel"] = serviceKernel
                output["pidReuseRefused"] = pidReuseRefused; output["driverMixupRefused"] = driverMixupRefused
                output["forced"] = forced; output["cancelSent"] = cancelSent
                output["releaseState"] = release?["state"] as Any? ?? [:]
                output["nativeDisposed"] = nativeDisposition?["disposed"] as? Bool == true
            }
            try atomic(output, to: root + "/observer.json")
            if verification {
                let expected = args[4] == "run" ? raw == 0 : raw == 256
                guard expected, !forced, nativeDisposition?["disposed"] as? Bool == true else { exit(1) }
            }
            exit(0)
        } catch { fputs("probe report failure\n", stderr); exit(1) }
    }
    func send(_ token: String, nonce: String? = nil) {
        guard control >= 0 else { return }
        let bytes = Array(((nonce ?? self.nonce) + ":" + token + "\n").utf8)
        let count = bytes.withUnsafeBytes { write(control, $0.baseAddress, $0.count) }
        if token == "cancel" { cancelSent = true }
        if count != bytes.count { fail("control write"); }
    }
    func bindServiceIfReady() {
        guard verification, serviceFD < 0, !settled,
              FileManager.default.fileExists(atPath: root + "/service.json") else { return }
        do {
            let bound = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/service.json"))) as! [String: Any]
            guard bound["nonce"] as? String == nonce, let pid = bound["pid"] as? Int, pid > 0,
                  pid != Int(target?.processIdentifier ?? -1), pid != Int(getpid()), let path = bound["executable"] as? String else { fail("service association"); return }
            let (facts, actual) = try identity(pid_t(pid), nonce: nonce, bundle: bundle)
            guard facts.uid == getuid(), facts.parent == target?.processIdentifier, actual["executable"] as? String == physicalPath(path) else { fail("service identity"); return }
            serviceFacts = facts; serviceRecord = actual; serviceRecord?["serviceNonce"] = bound["serviceNonce"]; serviceFD = probe_register(pid_t(pid))
            guard serviceFD >= 0 else { fail("service registration"); return }
            if args[4] == "cancel-service" { send("cancel") }
            if args[4] == "eof-service" { close(control); control = -1 }
        } catch { fail("service binding") }
    }
    func timeout() {
        guard verification, !cancelSent else { fail("cleanup deadline"); return }
        send("cancel"); deadline?.schedule(deadline: .now() + 10)
    }
    func fail(_ reason: String) {
        guard !settled else { return }; settled = true
        if verification, let nativeFacts = facts, kernel >= 0 {
            // Normal nonce cancellation first; only bound, rechecked owned identities may be forced.
            send("cancel")
            let nativeFD = kernel, nodeFD = serviceFD, nodeFacts = serviceFacts
            let nativePath = expectedExecutable, nodePath = serviceRecord?["executable"] as? String
            let nativeAlreadyObserved = nativeResult != nil
            DispatchQueue.global().async { [self] in
                var nativeStatus: Int64 = -1, nativeFlags: UInt32 = 0, nativeFilter: Int16 = 0
                var nodeStatus: Int64 = -1, nodeFlags: UInt32 = 0, nodeFilter: Int16 = 0
                var forced = false
                var nativeObserved = nativeAlreadyObserved || probe_wait(nativeFD, 6, &nativeStatus, &nativeFlags, &nativeFilter) == 0
                if !nativeObserved {
                    forced = true
                    _ = probe_cleanup(nativeFacts, nativePath)
                    nativeObserved = probe_wait(nativeFD, 2, &nativeStatus, &nativeFlags, &nativeFilter) == 0
                }
                var nodeObserved = nodeFD < 0
                if nodeFD >= 0 {
                    nodeObserved = probe_wait(nodeFD, 1, &nodeStatus, &nodeFlags, &nodeFilter) == 0
                    if !nodeObserved, let nodeFacts, let nodePath {
                        forced = true; _ = probe_cleanup(nodeFacts, nodePath)
                        nodeObserved = probe_wait(nodeFD, 1, &nodeStatus, &nodeFlags, &nodeFilter) == 0
                    }
                }
                Task { @MainActor in
                    self.forced = forced; self.dispose()
                    self.writeFailure(reason, extra: ["forced": forced, "cleanupNativeObserved": nativeObserved,
                        "cleanupNativeRawStatus": nativeStatus, "cleanupNodeObserved": nodeObserved,
                        "cleanupNodeRawStatus": nodeStatus, "serviceIdentity": self.serviceRecord as Any? ?? NSNull()])
                }
            }
        } else {
            dispose()
            if let facts { _ = probe_cleanup(facts, expectedExecutable) }
            writeFailure(reason, extra: ["forced": facts != nil, "cleanupObserved": false])
        }
    }
    func writeFailure(_ reason: String, extra: [String: Any]) {
        var output: [String: Any] = ["case": args.count > 4 ? args[4] : "invalid", "bundleURL": bundle, "error": reason,
            "observerDisposed": true, "released": released, "cancelSent": cancelSent, "kernel": nativeResult as Any? ?? NSNull(),
            "expectedExecutable": expectedExecutable, "observedIdentity": record as Any? ?? NSNull(), "expectedUid": Int(getuid())]
        output.merge(extra) { _, new in new }
        try? atomic(output, to: root + "/observer.json")
        fputs("LaunchServices probe FAIL: " + reason + "\n", stderr); exit(1)
    }

}
