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
    let args = CommandLine.arguments
    var target: NSRunningApplication?
    var facts: ProbeIdentity?
    var record: [String: Any]?
    var watch: DispatchSourceFileSystemObject?
    var deadline: DispatchSourceTimer?
    var directory: Int32 = -1
    var kernel: Int32 = -1
    var released = false
    var settled = false
    var bundle: String { URL(fileURLWithPath: args[1]).resolvingSymlinksInPath().standardizedFileURL.path }
    var root: String { args[2] }
    var nonce: String { args[3] }
    func start() {
        guard args.count == 5 else { exit(1) }
        directory = open(root, O_EVTONLY)
        guard directory >= 0 else { fail("directory") ; return }
        watch = DispatchSource.makeFileSystemObjectSource(fileDescriptor: directory, eventMask: .write, queue: .main)
        watch?.setEventHandler { [self] in MainActor.assumeIsolated { handshake() } }
        watch?.resume()
        deadline = DispatchSource.makeTimerSource(queue: .main)
        deadline?.schedule(deadline: .now() + 12)
        deadline?.setEventHandler { [self] in MainActor.assumeIsolated { fail("deadline") } }
        deadline?.resume()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.promptsUserIfNeeded = false
        configuration.addsToRecentItems = false
        configuration.arguments = [root, nonce, args[4]]
        configuration.environment = ProcessInfo.processInfo.environment
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: bundle), configuration: configuration) { app, error in
            Task { @MainActor in
                guard !self.settled else { return }
                guard error == nil, let app, app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == self.bundle else { self.fail("own launch identity"); return }
                self.target = app
                do {
                    let (facts, record) = try identity(app.processIdentifier, nonce: self.nonce, bundle: self.bundle)
                    guard facts.uid == getuid(), record["executable"] as? String == self.bundle + "/Contents/MacOS/LaunchProbe" else { self.fail("own kernel identity"); return }
                    self.record = record
                    self.kernel = probe_register(app.processIdentifier)
                    guard self.kernel >= 0 else { self.fail("kernel registration errno=\(errno)"); return }
                    self.handshake()
                } catch { self.fail("kernel identity") }
            }
        }
    }
    func handshake() {
        guard !settled, !released, let target, let record, kernel >= 0,
              FileManager.default.fileExists(atPath: root + "/identity.json") else { return }
        do {
            let reported = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/identity.json"))) as! [String: Any]
            let (current, actual) = try identity(target.processIdentifier, nonce: nonce, bundle: bundle)
            guard NSDictionary(dictionary: reported).isEqual(to: record), NSDictionary(dictionary: actual).isEqual(to: record) else { fail("identity changed or nonce mismatch"); return }
            facts = current // Cleanup authority only after complete kernel + bundle + nonce identity.
            let fd = open(root + "/release.fifo", O_WRONLY | O_NONBLOCK)
            guard fd >= 0 else { fail("release gate"); return }
            released = true
            let bytes = Array(nonce.utf8)
            let count = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            close(fd)
            guard count == bytes.count else { fail("partial release"); return }
            let kernelFD = kernel
            DispatchQueue.global().async {
                var raw: Int64 = -1, flags: UInt32 = 0, filter: Int16 = 0
                let result = probe_wait(kernelFD, &raw, &flags, &filter)
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
    }
    func complete(_ raw: Int64, flags: UInt32, filter: Int16) {
        guard !settled, let record else { return }
        dispose()
        do {
            try atomic(["case": args[4], "bundleURL": bundle, "identity": record, "observerPid": Int(getpid()),
                "identityVerified": true, "registeredBeforeRelease": true, "released": released, "observerDisposed": true,
                "kernel": ["rawStatus": raw, "flags": flags, "filter": filter, "statusRequested": true]], to: root + "/observer.json")
            exit(0) // Only the validator decides whether the external raw status matches the requested case.
        } catch { fputs("probe report failure\n", stderr); exit(1) }
    }
    func fail(_ reason: String) {
        guard !settled else { return }
        if let facts { _ = probe_cleanup(facts, bundle + "/Contents/MacOS/LaunchProbe") }
        dispose()
        try? atomic(["error": reason, "released": released, "observerDisposed": true], to: root + "/observer.json")
        fputs("LaunchServices probe FAIL: \(reason)\n", stderr); exit(1)
    }
}
