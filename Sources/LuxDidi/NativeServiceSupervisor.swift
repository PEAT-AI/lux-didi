import Foundation
import Combine
import AppKit
import Darwin
import Security

// Probe failures retain a status-only cause while the service boundary still reports invalidNode.
enum NativeProbeFailure: String, Error {
    case timeout, eofBeforeFrame, readFailed, malformedFraming, nonJSON, invalidFields, other
    static func classify(_ error: Error, readErrno: Int32) -> Self {
        if let cause = error as? Self { return cause }
        switch error as? NativeServiceError {
        case .timeout: return .timeout
        case .exited: return readErrno == 0 ? .eofBeforeFrame : .readFailed
        case .invalidReady: return .malformedFraming
        default: return .other
        }
    }
}

// The owned child uses this escalation policy; virtual sleep keeps lifecycle proofs deterministic.
@MainActor enum NativeServiceStop {
    static func escalate(graceNanoseconds: UInt64 = 30_000_000_000, sleep: (UInt64) async throws -> Void,
                         isRunning: () -> Bool, terminate: () -> Void, forceKill: () -> Void) async throws {
        // Match the host summary deadline: stdin closure starts graceful completion, not termination.
        // A child that exits sooner cancels this task; only an unresponsive child reaches escalation.
        try await sleep(graceNanoseconds)
        guard isRunning() else { return }
        terminate()
        try await sleep(500_000_000)
        if isRunning() { forceKill() }
    }
}

// One process handle and private pipes. All signals target this live owned handle only.
@MainActor private final class OwnedServiceChild {
    let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var reader: Task<Void, Never>?
    private var frame: Data?
    private var failure: Error?
    // First-frame transport metadata only, never the bytes or inherited environment.
    private(set) var firstFrameBytes: Int?
    private(set) var firstFrameReadStatus = "pending"
    private(set) var firstFrameReadErrno: Int32 = 0
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
            var terminalReadErrno: Int32 = 0
            while !Task.isCancelled {
                var bytes = [UInt8](repeating: 0, count: 1025)
                let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { terminalReadErrno = count < 0 ? errno : 0; break }
                if delivered { await self?.invalidOutput(bytes: buffer.count + count); return }
                buffer.append(contentsOf: bytes.prefix(count))
                guard buffer.count <= 1024 else { await self?.invalidOutput(bytes: buffer.count); return }
                if let newline = buffer.firstIndex(of: 10) {
                    guard newline == buffer.index(before: buffer.endIndex) else { await self?.invalidOutput(bytes: buffer.count); return }
                    delivered = true
                    await self?.received(Data(buffer.dropLast()))
                }
            }
            await self?.endedOutput(bytes: buffer.count, readErrno: terminalReadErrno)
        }
    }
    func writeStart(_ data: Data) throws { try input.fileHandleForWriting.write(contentsOf: data) }
    func closeInput() { try? input.fileHandleForWriting.close() }
    private func received(_ data: Data) {
        guard failure == nil else { return }
        firstFrameBytes = data.count; firstFrameReadStatus = "frame"
        frame = data
        frameWaiter?.resume(returning: data); frameWaiter = nil
    }
    private func invalidOutput(bytes: Int? = nil) {
        if let bytes { firstFrameBytes = bytes }
        firstFrameReadStatus = "invalid-framing"
        failure = NativeServiceError.invalidReady
        frameWaiter?.resume(throwing: NativeServiceError.invalidReady); frameWaiter = nil
        if !stopping { onInvalidOutput?() }
    }
    private func endedOutput(bytes: Int, readErrno: Int32) {
        if frame == nil {
            firstFrameBytes = bytes; firstFrameReadErrno = readErrno
            firstFrameReadStatus = readErrno == 0 ? "eof" : "read-failed"
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
            self?.firstFrameReadStatus = "timeout"
            self?.failure = NativeServiceError.timeout
            self?.frameWaiter?.resume(throwing: NativeServiceError.timeout); self?.frameWaiter = nil
        }
        defer { deadline.cancel() }
        return try await withCheckedThrowingContinuation { frameWaiter = $0 }
    }
    func stop(graceful: Bool = false) async {
        stopping = true; closeInput()
        let escalation = Task { [weak self] in
            try? await NativeServiceStop.escalate(
                graceNanoseconds: graceful ? 30_000_000_000 : 500_000_000,
                sleep: { try await Task.sleep(nanoseconds: $0) },
                isRunning: { self?.isRunning == true },
                terminate: { self?.process.terminate() },
                forceKill: {
                    guard let self, self.isRunning && self.pid > 0 else { return }
                    _ = kill(self.pid, SIGKILL)
                })
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
    let credential: @MainActor () throws -> String
}

@MainActor final class NativeServiceSupervisor: ObservableObject {
    let runtime: InstalledRuntime
    private let operatorSettings: OperatorSettings?
    private let stateURL: URL
    private let credentialService: String
    private let credentialAccount: String
    private var child: OwnedServiceChild?
    private var connection: OwnedServiceConnection?
    private var operation: UUID?
    private(set) var credentialValidated = false
    private(set) var lastStop: [String: Any]?
    // Last startup stage reached by start(), for a privacy-safe exit record.
    private var lastStage = "state"
    private var hostRefusedCode: String?
    private(set) var startupFailureCode: String?
    private(set) var startupFailureDiagnostic: StartupFailureDiagnostic?
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
    /// One native-live.log end record per teardown: a closed reason and numeric-only detail.
    /// The app wires it to the live journal; the supervisor itself never touches a file.
    var onEnd: ((NativeLiveEndReason, [String: Any]) -> Void)?
    var onCredentialUnavailable: ((NativeServiceError) -> Void)?
    var onRecovered: (() -> Void)?
    var onRestartStatus: ((Bool) -> Void)?
    private var wakeObserver: NSObjectProtocol?
    private var restartTask: Task<Void, Never>?
    private lazy var recovery: NativeServiceRecovery = NativeServiceRecovery(
        schedule: { delay, action in
            let task = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                catch { return }
                guard !Task.isCancelled else { return }
                action()
            }
            return { task.cancel() }
        },
        launch: { [weak self] token in
            guard let self else { return }
            self.restartTask = Task { @MainActor in
                do {
                    _ = try await self.start(recovering: true)
                    guard !Task.isCancelled, self.recovery.generation == token else { return }
                    guard self.isRunning else {
                        self.recovery.finished(token, success: false); return
                    }
                    self.recovery.finished(token, success: true)
                    self.onRecovered?()
                } catch {
                    guard !Task.isCancelled else { return }
                    self.recovery.finished(token, success: false)
                }
            }
        },
        lost: { [weak self] in self?.onUnavailable?() },
        reconcile: { [weak self] in self?.reconcileAfterWake() },
        status: { [weak self] restarting in self?.onRestartStatus?(restarting) })
    private func reconcileAfterWake() {
        guard let child else { return }
        if !child.isRunning { unavailable(child) }
        else { onRecovered?() } // Reconnect probes health; network failure is not child death.
    }
    private func observeWake() {
        guard wakeObserver == nil else { return }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.recovery.wake() }
            }
    }
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
    static func validateProbeFrame(_ data: Data, major: Int) throws {
        guard let object = try? JSONSerialization.jsonObject(with: data) else { throw NativeProbeFailure.nonJSON }
        guard let value = object as? [String: Any],
              value["major"] as? Int == major, value["sqlite"] as? Bool == true else { throw NativeProbeFailure.invalidFields }
    }
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
            try Self.validateProbeFrame(data, major: runtime.nodeMajor)
            await probe.stop()
        } catch {
#if COMPANION_TEST
            Self.diagnosticSink?(["stage": "probe-failed", "failedAt": stage,
                "cause": NativeProbeFailure.classify(error, readErrno: probe.firstFrameReadErrno).rawValue,
                "readStatus": probe.firstFrameReadStatus, "readErrno": Int(probe.firstFrameReadErrno),
                "firstFrameBytes": probe.firstFrameBytes as Any? ?? NSNull(),
                "probeRunning": probe.isRunning,
                "probeExitStatus": stage == "probe-launch" || probe.isRunning ? NSNull() : probe.process.terminationStatus as Any,
                "probeExitReason": stage == "probe-launch" || probe.isRunning ? NSNull() : probe.process.terminationReason.rawValue as Any,
                "errorCode": (error as NSError).code])
#endif
            await probe.stop(); throw NativeServiceError.invalidNode
        }
    }
    private func unavailable(_ owner: OwnedServiceChild) {
        guard child === owner, state != .stopped else { return }
        state = .unavailable; connection = nil
        if !owner.isRunning {
            // The direct child is gone: record status-only exit diagnostics and drop a
            // descriptor that still names it, so no reader trusts a dead host.
            lastStop = ["requested": false, "observedExited": true, "pid": Int(owner.pid),
                        "exitStatus": Int(owner.process.terminationStatus),
                        "terminationReason": owner.process.terminationReason == .exit ? "exit" : "uncaughtSignal",
                        "stage": lastStage]
            removeStaleDescriptor(pid: owner.pid)
        }
        recovery.childExited(recovery.generation)
        Task { await owner.stop() }
    }
    // Remove host-runtime.json only while it still names this dead direct child.
    private func removeStaleDescriptor(pid: Int32) {
        let url = stateURL.appendingPathComponent("host-runtime.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let recorded = object["pid"] as? Int, recorded == Int(pid) else { return }
        try? FileManager.default.removeItem(at: url)
    }
    private func credential(owner: OwnedServiceChild, nonce: String, initial: Data) throws -> String {
        guard child === owner, owner.isRunning, state == .running, connection?.nonce == nonce else {
            throw NativeServiceError.exited
        }
        do {
            let current = try NativeCredentialImport.readCredential(state: stateURL)
            guard current == initial else { throw NativeServiceError.credentialMismatch }
            return String(decoding: current, as: UTF8.self)
        } catch {
            let failure = (error as? NativeServiceError) ?? .unsafeCredential
            recovery.stop(); restartTask?.cancel(); restartTask = nil
            if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
            wakeObserver = nil
            owner.onUnexpectedExit = nil; owner.onInvalidOutput = nil
            operation = nil; state = .unavailable; connection = nil; credentialValidated = false
            startupFailureCode = "canonical-file/" + String(describing: failure)
            let category: StartupFailureDiagnostic.Category
            switch failure {
            case .unsafeState: category = .unsafeState
            case .credentialMismatch: category = .credentialMismatch
            default: category = .unsafeCredential
            }
            startupFailureDiagnostic = StartupFailureDiagnostic(stage: .canonicalFile, category: category, operation: .none, status: nil)
            onCredentialUnavailable?(failure)
            Task {
                await owner.stop(); observeStop(owner)
                if child === owner { child = nil }
            }
            throw failure
        }
    }
    func start(recovering: Bool = false) async throws -> OwnedServiceConnection {
        if let connection, isCurrent(connection) { return connection }
        guard !Task.isCancelled else { throw NativeServiceError.exited }
        guard state != .starting else { throw NativeServiceError.alreadyStarting }
        let ticket = UUID(); operation = ticket
        var launched: OwnedServiceChild?
        lastStage = "state"
        var diagnosticStage: StartupFailureDiagnostic.Stage = .state
        hostRefusedCode = nil
        startupFailureCode = nil
        credentialValidated = false
        startupFailureDiagnostic = nil
        state = .starting; connection = nil
        if let child { await child.stop(); observeStop(child); self.child = nil }
        do {
            guard operation == ticket, state == .starting else { throw NativeServiceError.exited }
            try NativeCredentialImport.prepareState(stateURL)
            lastStage = "node-probe"
            diagnosticStage = .nodeProbe
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
            owned.onUnexpectedExit = { [weak self, weak owned] in
                guard let self, let owned else { return }
                let signalled = owned.process.terminationReason != .exit
                self.onEnd?(.childExit, NativeLiveEndDetail.childExit(status: owned.process.terminationStatus,
                    signal: signalled ? owned.process.terminationStatus : nil))
                self.unavailable(owned)
            }
            owned.onInvalidOutput = { [weak self, weak owned] in
                guard let self, let owned else { return }
                self.onEnd?(.invalidOutput, NativeLiveEndDetail.invalidOutput(bytes: owned.firstFrameBytes ?? 0))
                self.unavailable(owned)
            }
            lastStage = "spawn"
            diagnosticStage = .spawn
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
            lastStage = "ready-frame"
            diagnosticStage = .readyFrame
            let readyData = try await owned.firstFrame(timeout: 6_000_000_000)
            if let refusal = try? JSONSerialization.jsonObject(with: readyData) as? [String: Any],
               Set(refusal.keys) == ["type", "schemaVersion", "code"],
               refusal["type"] as? String == "error", refusal["schemaVersion"] as? Int == 1,
               let code = refusal["code"] as? String, (1...64).contains(code.count),
               code.allSatisfy({ $0.isUppercase || $0.isNumber || $0 == "_" }) {
                hostRefusedCode = code
                throw NativeServiceError.exited
            }
            guard let ready = try JSONSerialization.jsonObject(with: readyData) as? [String: Any],
                  Set(ready.keys) == ["type", "schemaVersion", "nonce", "pid", "origin", "authorityEpoch", "assistantId"],
                  ready["type"] as? String == "ready", ready["schemaVersion"] as? Int == 1, ready["nonce"] as? String == nonce,
                  ready["pid"] as? Int == Int(owned.pid), owned.isRunning, state == .starting,
                  let origin = ready["origin"] as? String, let epoch = ready["authorityEpoch"] as? String, UUID(uuidString: epoch) != nil,
                  let assistant = ready["assistantId"] as? String, UUID(uuidString: assistant) != nil else { throw NativeServiceError.invalidReady }
            _ = try ServiceDescriptor(origin: origin, credentialService: credentialService, credentialAccount: credentialAccount)
            lastStage = "canonical-file"
            diagnosticStage = .canonicalFile
            let initial = try NativeCredentialImport.readCredential(state: stateURL)
            credentialValidated = true
            guard owned.isRunning, state == .starting else { throw NativeServiceError.exited }
            let descriptor = try ServiceDescriptor(origin: origin, credentialService: credentialService, credentialAccount: credentialAccount)
            let result = OwnedServiceConnection(descriptor: descriptor, authorityEpoch: epoch, pid: owned.pid, nonce: nonce, assistantId: assistant,
                credential: { [weak self, weak owned] in
                    guard let self, let owned else { throw NativeServiceError.exited }
                    return try self.credential(owner: owned, nonce: nonce, initial: initial)
                })
            connection = result; state = .running; lastStage = "running"
            if !recovering { recovery.activate() }
            observeWake()
            return result
        } catch {
            startupFailureCode = lastStage + "/" + (hostRefusedCode ?? (error as? NativeServiceError).map { String(describing: $0) } ?? "platformFailure")
            let category: StartupFailureDiagnostic.Category
            var status: Int32?
            switch error as? NativeServiceError {
            case .invalidRuntime: category = .invalidRuntime
            case .invalidNode: category = .invalidNode
            case .invalidOperatorSettings: category = .invalidOperatorSettings
            case .unsafeState: category = .unsafeState
            case .unsafeCredential: category = .unsafeCredential
            case .credentialMismatch: category = .credentialMismatch
            case .keychain(let code):
                category = .keychain; status = code
            case .invalidReady: category = .invalidReady
            case .exited: category = .exited
            case .timeout: category = .timeout
            case .alreadyStarting: category = .alreadyStarting
            case nil: category = .unknown
            }
            startupFailureDiagnostic = StartupFailureDiagnostic(stage: diagnosticStage, category: category, operation: .none, status: status)
            if let launched { await launched.stop(); observeStop(launched) }
            if operation == ticket {
                child = nil; state = .unavailable; connection = nil
            }
            throw error
        }
    }
    func stop(reason: NativeLiveEndReason = .shutdown) async {
        recovery.stop(); restartTask?.cancel(); restartTask = nil
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        wakeObserver = nil
        operation = nil; state = .stopped; connection = nil
        onEnd?(reason, [:])
        if let child { await child.stop(graceful: reason == .shutdown); observeStop(child); self.child = nil }
    }
}
