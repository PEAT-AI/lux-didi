import Foundation
import Combine
import Darwin
import Security

// The ready frame is never a diagnostic: it contains private protocol material.
final class SupervisorLog: @unchecked Sendable {
    private let path: URL
    private let lock = NSLock()
    private let limit: Int
    init(state: URL, limit: Int = 5 * 1024 * 1024) throws {
        let directory = state.appendingPathComponent("logs", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw NativeServiceError.invalidRuntime }
        self.path = directory.appendingPathComponent("supervisor.log"); self.limit = limit
    }
    func event(_ name: String, pid: Int32 = getpid(), fields: [String: Any] = [:]) {
        lock.lock(); defer { lock.unlock() }
        var record = fields
        record["event"] = name; record["pid"] = Int(pid)
        record["timestamp"] = ISO8601DateFormatter().string(from: Date())
        guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        data.append(10)
        guard data.count <= limit else { return }
        var fd = Darwin.open(path.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return }
        defer { if fd >= 0 { Darwin.close(fd) } }
        guard fchmod(fd, 0o600) == 0 else { return }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return }
        if Int(info.st_size) + data.count > limit {
            Darwin.close(fd); fd = -1
            let fm = FileManager.default
            let second = URL(fileURLWithPath: path.path + ".2")
            let first = URL(fileURLWithPath: path.path + ".1")
            do {
                if fm.fileExists(atPath: second.path) { try fm.removeItem(at: second) }
                if fm.fileExists(atPath: first.path) { try fm.moveItem(at: first, to: second) }
                try fm.moveItem(at: path, to: first)
            } catch { return }
            fd = Darwin.open(path.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0, fchmod(fd, 0o600) == 0 else { return }
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        try? handle.write(contentsOf: data)
    }
    // Return true only for a known diagnostic. Ready/unknown stdout still belongs to the protocol parser.
    func childLine(_ data: Data, pid: Int32, stderr: Bool) -> Bool {
        if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let name = object["event"] as? String {
            if name == "live_attach_rejected", let code = object["code"] as? String,
               !code.isEmpty, code.utf8.count <= 107, code.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil {
                var fields: [String: Any] = ["code": code, "stream": stderr ? "stderr" : "stdout"]
                if let session = object["liveSessionId"] as? String, UUID(uuidString: session) != nil { fields["liveSessionId"] = session }
                event(name, pid: pid, fields: fields); return true
            }
        }
        if let text = String(data: data, encoding: .utf8),
           ["live.json", "mcp.json"].contains(where: { text == "config_seeded file=\($0) from=provider-config" }) {
            event("config_seeded", pid: pid, fields: ["stream": stderr ? "stderr" : "stdout"]); return true
        }
        if stderr { event("host_error", pid: pid, fields: ["class": "Error", "stream": "stderr"]); return true }
        return false
    }
}

// One process handle and private pipes. All signals target this live owned handle only.
@MainActor private final class OwnedServiceChild {
    let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var errorReader: Task<Void, Never>?
    var log: SupervisorLog?
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
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        for handle in [input.fileHandleForWriting, input.fileHandleForReading, output.fileHandleForReading, output.fileHandleForWriting, errors.fileHandleForReading, errors.fileHandleForWriting] {
            guard fcntl(handle.fileDescriptor, F_SETFD, FD_CLOEXEC) != -1 else { throw NativeServiceError.invalidRuntime }
        }
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else { throw NativeServiceError.invalidRuntime }
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.didExit() } }
        try process.run()
        try input.fileHandleForReading.close(); try output.fileHandleForWriting.close(); try errors.fileHandleForWriting.close()
        log?.event("spawn", pid: pid)
        let childPID = pid
        let diagnostics = log
        let errorStream = errors.fileHandleForReading
        errorReader = Task.detached {
            defer { try? errorStream.close() }
            var buffer = Data()
            while !Task.isCancelled {
                var bytes = [UInt8](repeating: 0, count: 1024)
                let count = bytes.withUnsafeMutableBytes { Darwin.read(errorStream.fileDescriptor, $0.baseAddress, $0.count) }
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                buffer.append(contentsOf: bytes.prefix(count))
                while let newline = buffer.firstIndex(of: 10) {
                    _ = diagnostics?.childLine(Data(buffer[..<newline]), pid: childPID, stderr: true)
                    buffer.removeSubrange(...newline)
                }
                if buffer.count > 4096 { diagnostics?.event("host_error", pid: childPID, fields: ["class": "Error", "stream": "stderr"]); buffer.removeAll() }
            }
            if !buffer.isEmpty { _ = diagnostics?.childLine(buffer, pid: childPID, stderr: true) }
        }
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
                buffer.append(contentsOf: bytes.prefix(count))
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                    if diagnostics?.childLine(line, pid: childPID, stderr: false) == true { continue }
                    guard !delivered, line.count <= 1024 else { await self?.invalidOutput(); return }
                    delivered = true
                    await self?.received(line)
                }
                guard buffer.count <= 4096 else { await self?.invalidOutput(); return }
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
        log?.event("exit", pid: pid, fields: ["exit_code": Int(process.terminationStatus), "restart": stopping ? "stopped" : "explicit_start_required"])
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
    private let operatorSettings: OperatorSettings?
    var logsURL: URL { stateURL.appendingPathComponent("logs", isDirectory: true) }
    private let stateURL: URL
    private let credentialService: String
    private let credentialAccount: String
    private var child: OwnedServiceChild?
    private var connection: OwnedServiceConnection?
    private var operation: UUID?
    private(set) var credentialImported = false
    private(set) var lastStop: [String: Any]?
    private(set) var startupFailureCode: String?
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
    init(runtime: InstalledRuntime, proof: PreparedInstalledProof? = nil, operatorSettings: OperatorSettings? = nil) throws {
        self.runtime = runtime; self.operatorSettings = operatorSettings
        stateURL = try proof?.state ?? InstalledRuntime.applicationState()
        credentialService = NativeCredentialImport.service; credentialAccount = proof?.credentialAccount ?? runtime.installId
    }
    #if COMPANION_TEST
    init(runtime: InstalledRuntime, proofState: URL, proofCredentialService: String) {
        self.runtime = runtime; operatorSettings = nil; stateURL = proofState; credentialService = proofCredentialService; credentialAccount = runtime.installId
    }
    func closeLivenessForProof() { child?.closeInput() }
    #endif
    func isCurrent(_ candidate: OwnedServiceConnection) -> Bool {
        isRunning && connection?.nonce == candidate.nonce && child?.pid == candidate.pid
    }
#if COMPANION_TEST
    // R60 synthetic companion-only diagnostic sink. Present only in the companion fixture build
    // (-D COMPANION_TEST). It records probe stage labels and booleans and changes no public error,
    // timing, guard, child argument, resource ownership or release path. No environment, no stdout
    // content, no credentials and no path outside the owned fixture are recorded.
    static var diagnosticSink: (([String: Any]) -> Void)?
#endif
    private func probeNode() async throws {
        let probe = OwnedServiceChild()
#if COMPANION_TEST
        var stage = "probe-launch"
#endif
        do {
            try probe.launch(executable: runtime.node, arguments: ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close(); process.stdout.write(JSON.stringify({major:Number(process.versions.node.split('.')[0]),sqlite:true})+'\\n');"])
#if COMPANION_TEST
            stage = "probe-first-frame"
#endif
            let data = try await probe.firstFrame(timeout: 3_000_000_000)
#if COMPANION_TEST
            let parsedObject = try? JSONSerialization.jsonObject(with: data)
            let parsed = parsedObject as? [String: Any]
            Self.diagnosticSink?(["stage": "probe-first-frame", "bytes": data.count, "parsed": parsed != nil,
                "majorMatches": (parsed?["major"] as? Int) == runtime.nodeMajor,
                "sqliteTrue": (parsed?["sqlite"] as? Bool) == true])
            stage = "probe-guard"
#endif
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  value["major"] as? Int == runtime.nodeMajor, value["sqlite"] as? Bool == true else { throw NativeServiceError.invalidNode }
            await probe.stop()
        } catch {
#if COMPANION_TEST
            Self.diagnosticSink?(["stage": "probe-failed", "failedAt": stage])
#endif
            await probe.stop(); throw NativeServiceError.invalidNode
        }
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
        var stage = "state"
        startupFailureCode = nil
        state = .starting; connection = nil
        if let child { await child.stop(); observeStop(child); self.child = nil }
        do {
            guard operation == ticket, state == .starting else { throw NativeServiceError.exited }
            try NativeCredentialImport.prepareState(stateURL)
            let diagnostics = try SupervisorLog(state: stateURL)
            diagnostics.event("config_dir", fields: ["directory": operatorSettings?.configDir?.path ?? stateURL.appendingPathComponent("provider-config").path])
            stage = "node-probe"
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
            owned.log = diagnostics
            owned.onUnexpectedExit = { [weak self, weak owned] in if let owned { self?.unavailable(owned) } }
            owned.onInvalidOutput = { [weak self, weak owned] in if let owned { self?.unavailable(owned) } }
            stage = "spawn"
            // Native forwards only the two existing host path flags; the host entry
            // owns credential/profile validation, snapshots and policy.
            var hostArguments = [runtime.serverEntry.path, "--supervised", "--data-dir", stateURL.path, "--web-root", runtime.webRoot.path, "--port", "0"]
            if let settings = operatorSettings {
                if let configDir = settings.configDir { hostArguments.append(contentsOf: ["--config-dir", configDir.path]) }
                if let ownerProfilePath = settings.ownerProfilePath { hostArguments.append(contentsOf: ["--owner-profile", ownerProfilePath.path]) }
            }
            try owned.launch(executable: runtime.node, arguments: hostArguments)
            var start = try JSONSerialization.data(withJSONObject: ["type": "start", "schemaVersion": 1, "nonce": nonce])
            start.append(10); try owned.writeStart(start)
            stage = "ready-frame"
            let readyData = try await owned.firstFrame(timeout: 6_000_000_000)
            guard let ready = try JSONSerialization.jsonObject(with: readyData) as? [String: Any],
                  Set(ready.keys) == ["type", "schemaVersion", "nonce", "pid", "origin", "authorityEpoch", "assistantId"],
                  ready["type"] as? String == "ready", ready["schemaVersion"] as? Int == 1, ready["nonce"] as? String == nonce,
                  ready["pid"] as? Int == Int(owned.pid), owned.isRunning, state == .starting,
                  let origin = ready["origin"] as? String, let epoch = ready["authorityEpoch"] as? String, UUID(uuidString: epoch) != nil,
                  let assistant = ready["assistantId"] as? String, UUID(uuidString: assistant) != nil else { throw NativeServiceError.invalidReady }
            _ = try ServiceDescriptor(origin: origin, credentialService: credentialService, credentialAccount: credentialAccount)
            stage = "canonical-file-and-import"
            let reference = try NativeCredentialImport.importCredential(state: stateURL, installId: credentialAccount, service: credentialService)
            credentialImported = true
            guard owned.isRunning, state == .starting else { throw NativeServiceError.exited }
            let descriptor = try ServiceDescriptor(origin: origin, credentialService: reference.service, credentialAccount: reference.account)
            let result = OwnedServiceConnection(descriptor: descriptor, authorityEpoch: epoch, pid: owned.pid, nonce: nonce, assistantId: assistant)
            connection = result; state = .running
            return result
        } catch {
            startupFailureCode = stage + "/" + ((error as? NativeServiceError).map { String(describing: $0) } ?? "platformFailure")
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
