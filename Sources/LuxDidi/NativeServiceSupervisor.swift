import Foundation
import Combine
import Darwin
import Security

// One process handle and private pipes. All signals target this live owned handle only.
@MainActor private final class OwnedServiceChild {
    let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var reader: Task<Void, Never>?
    private var frame: Data?
    private var failure: Error?
    private var frameWaiter: CheckedContinuation<Data, Error>?
    private var exitWaiters: [CheckedContinuation<Void, Never>] = []
    private var stopping = false
    var onUnexpectedExit: (() -> Void)?
    var onInvalidOutput: (() -> Void)?
    var isRunning: Bool { process.isRunning }
    var pid: Int32 { process.processIdentifier }
    func launch(executable: URL, arguments: [String]) throws {
        process.executableURL = executable; process.arguments = arguments
        // No inherited Node/loader/search-path/auth environment. Executable is explicit.
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "LANG": "en_US.UTF-8"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        for handle in [input.fileHandleForWriting, input.fileHandleForReading, output.fileHandleForReading, output.fileHandleForWriting] {
            guard fcntl(handle.fileDescriptor, F_SETFD, FD_CLOEXEC) != -1 else { throw NativeServiceError.invalidRuntime }
        }
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else { throw NativeServiceError.invalidRuntime }
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.didExit() } }
        try process.run()
        try input.fileHandleForReading.close(); try output.fileHandleForWriting.close()
        let stream = output.fileHandleForReading
        let descriptor = stream.fileDescriptor
        reader = Task.detached { [weak self] in
            // The reader owns closing this FD: cancelling must not race a new
            // process reusing a descriptor while this thread is still reading.
            defer { try? stream.close() }
            var buffer = Data()
            var delivered = false
            while !Task.isCancelled {
                var bytes = [UInt8](repeating: 0, count: 1025)
                let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                if delivered { await self?.invalidOutput(); return }
                buffer.append(contentsOf: bytes.prefix(count))
                guard buffer.count <= 1024 else { await self?.invalidOutput(); return }
                if let newline = buffer.firstIndex(of: 10) {
                    guard newline == buffer.index(before: buffer.endIndex) else { await self?.invalidOutput(); return }
                    delivered = true
                    await self?.received(Data(buffer.dropLast()))
                }
            }
            await self?.endedOutput()
        }
    }
    func writeStart(_ data: Data) throws { try input.fileHandleForWriting.write(contentsOf: data) }
    func closeInput() { try? input.fileHandleForWriting.close() }
    private func received(_ data: Data) {
        guard failure == nil else { return }
        frame = data
        frameWaiter?.resume(returning: data); frameWaiter = nil
    }
    private func invalidOutput() {
        failure = NativeServiceError.invalidReady
        frameWaiter?.resume(throwing: NativeServiceError.invalidReady); frameWaiter = nil
        if !stopping { onInvalidOutput?() }
    }
    private func endedOutput() {
        if frame == nil {
            failure = NativeServiceError.exited
            frameWaiter?.resume(throwing: NativeServiceError.exited); frameWaiter = nil
        } else if isRunning && !stopping { invalidOutput() }
    }
    private func didExit() {
        for waiter in exitWaiters { waiter.resume() }; exitWaiters.removeAll()
        if !stopping { onUnexpectedExit?() }
        // Drain stdout before deciding frame failure; a short Node probe can exit
        // before the actor receives its valid output. EOF reader owns that decision.
    }
    func firstFrame(timeout: UInt64) async throws -> Data {
        if let failure { throw failure }
        if let frame { return frame }
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: timeout) } catch { return }
            self?.failure = NativeServiceError.timeout
            self?.frameWaiter?.resume(throwing: NativeServiceError.timeout); self?.frameWaiter = nil
        }
        defer { deadline.cancel() }
        return try await withCheckedThrowingContinuation { frameWaiter = $0 }
    }
    func stop() async {
        stopping = true; closeInput()
        let escalation = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 500_000_000)
                guard let self else { return }
                if self.isRunning { self.process.terminate() }
                try await Task.sleep(nanoseconds: 500_000_000)
                if self.isRunning && self.pid > 0 { _ = kill(self.pid, SIGKILL) }
            } catch {}
        }
        await withCheckedContinuation { continuation in
            if !isRunning { continuation.resume() } else { exitWaiters.append(continuation) }
        }
        escalation.cancel(); reader?.cancel()
        frameWaiter?.resume(throwing: NativeServiceError.exited); frameWaiter = nil
    }
}

enum NativeServiceState: Equatable { case stopped, starting, running, unavailable }
struct OwnedServiceConnection {
    let descriptor: ServiceDescriptor
    let authorityEpoch: String
    let pid: Int32
    let nonce: String
    let assistantId: String
}

@MainActor final class NativeServiceSupervisor: ObservableObject {
    let runtime: InstalledRuntime
    private let stateURL: URL
    private let credentialService: String
    private let credentialAccount: String
    private var child: OwnedServiceChild?
    private var connection: OwnedServiceConnection?
    private var operation: UUID?
    private(set) var credentialImported = false
    private(set) var lastStop: [String: Any]?
    var currentConnection: OwnedServiceConnection? {
        guard let connection, isCurrent(connection) else { return nil }; return connection
    }
    private func observeStop(_ owned: OwnedServiceChild) {
        guard owned.pid > 0, !owned.isRunning else { return }
        lastStop = ["requested": true, "observedExited": true, "pid": Int(owned.pid),
                    "exitStatus": Int(owned.process.terminationStatus),
                    "terminationReason": owned.process.terminationReason == .exit ? "exit" : "uncaughtSignal",
                    "procedure": "private-stdin-close-and-bounded-owned-escalation"]
    }
    @Published private(set) var state: NativeServiceState = .stopped
    var onUnavailable: (() -> Void)?
    var isRunning: Bool { state == .running && child?.isRunning == true }
    init(runtime: InstalledRuntime, proof: PreparedInstalledProof? = nil) throws {
        self.runtime = runtime; stateURL = try proof?.state ?? InstalledRuntime.applicationState()
        credentialService = NativeCredentialImport.service; credentialAccount = proof?.credentialAccount ?? runtime.installId
    }
    #if COMPANION_TEST
    init(runtime: InstalledRuntime, proofState: URL, proofCredentialService: String) {
        self.runtime = runtime; stateURL = proofState; credentialService = proofCredentialService; credentialAccount = runtime.installId
    }
    func closeLivenessForProof() { child?.closeInput() }
    #endif
    func isCurrent(_ candidate: OwnedServiceConnection) -> Bool {
        isRunning && connection?.nonce == candidate.nonce && child?.pid == candidate.pid
    }
    private func probeNode() async throws {
        let probe = OwnedServiceChild()
        do {
            try probe.launch(executable: runtime.node, arguments: ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close(); process.stdout.write(JSON.stringify({major:Number(process.versions.node.split('.')[0]),sqlite:true})+'\\n');"])
            let data = try await probe.firstFrame(timeout: 3_000_000_000)
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  value["major"] as? Int == runtime.nodeMajor, value["sqlite"] as? Bool == true else { throw NativeServiceError.invalidNode }
            await probe.stop()
        } catch { await probe.stop(); throw NativeServiceError.invalidNode }
    }
    private func unavailable(_ owner: OwnedServiceChild) {
        guard child === owner, state != .stopped else { return }
        state = .unavailable; connection = nil; onUnavailable?()
        Task { await owner.stop() }
    }
    func start() async throws -> OwnedServiceConnection {
        if let connection, isCurrent(connection) { return connection }
        guard !Task.isCancelled else { throw NativeServiceError.exited }
        guard state != .starting else { throw NativeServiceError.alreadyStarting }
        let ticket = UUID(); operation = ticket
        var launched: OwnedServiceChild?
        state = .starting; connection = nil
        if let child { await child.stop(); observeStop(child); self.child = nil }
        do {
            guard operation == ticket, state == .starting else { throw NativeServiceError.exited }
            try NativeCredentialImport.prepareState(stateURL)
            try await probeNode()
            guard operation == ticket, state == .starting, !Task.isCancelled else { throw NativeServiceError.exited }
            // Revalidate selected artifacts after the await; never attach a cached descriptor.
            guard let current = try InstalledRuntime.load(resources: runtime.resources), current.installId == runtime.installId,
                  current.releaseCommit == runtime.releaseCommit, current.node == runtime.node,
                  current.serverEntry == runtime.serverEntry, current.webRoot == runtime.webRoot else { throw NativeServiceError.invalidRuntime }
            var random = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw NativeServiceError.invalidReady }
            let nonce = Data(random).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let owned = OwnedServiceChild(); child = owned; launched = owned
            owned.onUnexpectedExit = { [weak self, weak owned] in if let owned { self?.unavailable(owned) } }
            owned.onInvalidOutput = { [weak self, weak owned] in if let owned { self?.unavailable(owned) } }
            try owned.launch(executable: runtime.node, arguments: [runtime.serverEntry.path, "--supervised", "--data-dir", stateURL.path, "--web-root", runtime.webRoot.path, "--port", "0"])
            var start = try JSONSerialization.data(withJSONObject: ["type": "start", "schemaVersion": 1, "nonce": nonce])
            start.append(10); try owned.writeStart(start)
            let readyData = try await owned.firstFrame(timeout: 6_000_000_000)
            guard let ready = try JSONSerialization.jsonObject(with: readyData) as? [String: Any],
                  Set(ready.keys) == ["type", "schemaVersion", "nonce", "pid", "origin", "authorityEpoch", "assistantId"],
                  ready["type"] as? String == "ready", ready["schemaVersion"] as? Int == 1, ready["nonce"] as? String == nonce,
                  ready["pid"] as? Int == Int(owned.pid), owned.isRunning, state == .starting,
                  let origin = ready["origin"] as? String, let epoch = ready["authorityEpoch"] as? String, UUID(uuidString: epoch) != nil,
                  let assistant = ready["assistantId"] as? String, UUID(uuidString: assistant) != nil else { throw NativeServiceError.invalidReady }
            _ = try ServiceDescriptor(origin: origin, credentialService: credentialService, credentialAccount: credentialAccount)
            let reference = try NativeCredentialImport.importCredential(state: stateURL, installId: credentialAccount, service: credentialService)
            credentialImported = true
            guard owned.isRunning, state == .starting else { throw NativeServiceError.exited }
            let descriptor = try ServiceDescriptor(origin: origin, credentialService: reference.service, credentialAccount: reference.account)
            let result = OwnedServiceConnection(descriptor: descriptor, authorityEpoch: epoch, pid: owned.pid, nonce: nonce, assistantId: assistant)
            connection = result; state = .running
            return result
        } catch {
            if let launched { await launched.stop(); observeStop(launched) }
            if operation == ticket {
                child = nil; state = .unavailable; connection = nil
            }
            throw error
        }
    }
    func stop() async {
        operation = nil; state = .stopped; connection = nil
        if let child { await child.stop(); observeStop(child); self.child = nil }
    }
}
