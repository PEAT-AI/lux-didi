import AppKit
import Darwin

// Private disposable-verification transport only. No ordinary app/API authority.
@MainActor final class OwnedVerificationLaunchGate {
    let root: String, nonce: String, socketPath: String
    private var listener: DispatchSourceRead?, reader: DispatchSourceRead?, deadline: DispatchSourceTimer?
    private var listenFD: Int32 = -1, connectionFD: Int32 = -1
    private var release: CheckedContinuation<Bool, Never>?
    private var released = false, cancelled = false, disposed = false
    private var bytes = Data()
    private let cancellation: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    private weak var window: NSWindow?

    static func perform(window: NSWindow? = nil,
                        work: @escaping @MainActor (OwnedVerificationLaunchGate?) async -> Bool) async -> Bool {
        let env = ProcessInfo.processInfo.environment
        guard env["LUX_VERIFICATION_GATE_ROOT"] != nil || env["LUX_VERIFICATION_GATE_NONCE"] != nil else { return await work(nil) }
        do {
            let gate = try OwnedVerificationLaunchGate(environment: env, window: window)
            let result = await withTaskCancellationHandler {
                await withTaskGroup(of: Bool.self) { group in
                    group.addTask { @MainActor in
                        guard await gate.awaitRelease(), !Task.isCancelled else { return false }
                        return await work(gate) && !Task.isCancelled
                    }
                    group.addTask { @MainActor in
                        for await _ in gate.cancellation { return false }
                        return false
                    }
                    let first = await group.next() ?? false
                    group.cancelAll(); gate.endSignals()
                    return first
                }
            } onCancel: { Task { @MainActor in gate.cancel() } }
            gate.dispose()
            return result
        } catch { fputs("VERIFICATION-GATE FAILED\n", stderr); return false }
    }
    private init(environment: [String: String], window: NSWindow?) throws {
        guard let root = environment["LUX_VERIFICATION_GATE_ROOT"], let nonce = environment["LUX_VERIFICATION_GATE_NONCE"],
              UUID(uuidString: nonce) != nil,
              let marker = try? String(contentsOfFile: root + "/nonce", encoding: .utf8), marker == nonce else { throw CocoaError(.fileReadCorruptFile) }
        self.root = root; self.nonce = nonce; self.window = window
        socketPath = "/tmp/didi-verification-" + nonce + ".sock"
        (cancellation, signal) = AsyncStream.makeStream()
        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFD >= 0 else { throw CocoaError(.fileWriteUnknown) }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let path = Array(socketPath.utf8CString)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: 104) { buffer in
                path.withUnsafeBufferPointer { buffer.update(from: $0.baseAddress!, count: path.count) }
            }
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(socketPath, 0o600) == 0, Darwin.listen(listenFD, 1) == 0,
              fcntl(listenFD, F_SETFL, O_NONBLOCK) == 0 else { close(listenFD); unlink(socketPath); throw CocoaError(.fileWriteUnknown) }
        listener = DispatchSource.makeReadSource(fileDescriptor: listenFD, queue: .main)
        listener?.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.acceptDriver() } }
        listener?.resume()
        deadline = DispatchSource.makeTimerSource(queue: .main)
        deadline?.schedule(deadline: .now() + 8)
        deadline?.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.cancel() } }
        deadline?.resume()
        do { try write(["pid": Int(getpid()), "nonce": nonce, "bundleURL": Bundle.main.bundleURL.path], name: "identity.json") }
        catch { dispose(); throw error }
    }
    private func write(_ value: [String: Any], name: String) throws {
        let path = root + "/" + name
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic)
        guard chmod(path, 0o600) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    func bindService(pid: pid_t, executable: String) throws {
        try write(["pid": Int(pid), "executable": executable, "nonce": nonce], name: "service.json")
    }
    private func awaitRelease() async -> Bool {
        if cancelled || Task.isCancelled { return false }
        if released { return true }
        return await withCheckedContinuation { release = $0 }
    }
    private func acceptDriver() {
        guard connectionFD < 0, !disposed else { return }
        connectionFD = Darwin.accept(listenFD, nil, nil)
        guard connectionFD >= 0 else { cancel(); return }
        _ = fcntl(connectionFD, F_SETFL, O_NONBLOCK)
        reader = DispatchSource.makeReadSource(fileDescriptor: connectionFD, queue: .main)
        reader?.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.readDriver() } }
        reader?.resume()
    }
    private func readDriver() {
        var buffer = [UInt8](repeating: 0, count: 128)
        let count = Darwin.read(connectionFD, &buffer, buffer.count)
        if count < 0 && errno == EAGAIN { return }
        guard count > 0 else { cancel(); return } // EOF/driver loss shares normal cancellation.
        bytes.append(contentsOf: buffer.prefix(count))
        guard bytes.count <= 256 else { cancel(); return }
        while let newline = bytes.firstIndex(of: 10) {
            let frame = String(decoding: bytes.prefix(upTo: newline), as: UTF8.self)
            bytes.removeSubrange(...newline)
            guard frame.hasPrefix(nonce + ":") else { cancel(); return }
            if frame == nonce + ":release", !released, !cancelled {
                released = true
                let snapshot: [String: Any] = ["owned": window.map { NSApp.windows.contains($0) } ?? false,
                    "running": NSApp.isRunning, "active": NSApp.isActive, "visible": window?.isVisible ?? false,
                    "main": window?.isMainWindow ?? false, "key": window?.isKeyWindow ?? false,
                    "unoccluded": window?.occlusionState.contains(.visible) ?? false]
                do { try write(["nonce": nonce, "pid": Int(getpid()), "state": snapshot], name: "release.json") }
                catch { cancel(); return }
                deadline?.schedule(deadline: .now() + 120)
                release?.resume(returning: true); release = nil
            } else if frame == nonce + ":cancel" { cancel(); return }
            else { cancel(); return }
        }
    }
    private func cancel() {
        guard !cancelled, !disposed else { return }
        cancelled = true; release?.resume(returning: false); release = nil
        signal.yield(()); signal.finish()
    }
    private func endSignals() {
        release?.resume(returning: false); release = nil; signal.finish()
    }
    private func dispose() {
        guard !disposed else { return }; disposed = true; endSignals()
        listener?.cancel(); reader?.cancel(); deadline?.cancel()
        listener = nil; reader = nil; deadline = nil
        if listenFD >= 0 { close(listenFD); listenFD = -1 }
        if connectionFD >= 0 { close(connectionFD); connectionFD = -1 }
        unlink(socketPath)
        try? write(["pid": Int(getpid()), "nonce": nonce, "disposed": true], name: "native-disposed.json")
    }
}
