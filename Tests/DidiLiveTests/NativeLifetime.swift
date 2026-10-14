import AVFoundation
import Foundation
@testable import DidiOwner

@MainActor private final class LifetimeAuthority {
    let companion: CompanionClient
    var refuseSocket = true
    init(_ fixture: Fixture) throws {
        companion = CompanionClient(descriptor: try ServiceDescriptor(origin: fixture.origin,
            credentialService: "synthetic", credentialAccount: "fixture"),
            credential: { fixture.token }, expectedEpoch: fixture.authorityEpoch)
    }
    func request(_ url: URL, _ epoch: String?) throws -> URLRequest {
        var request = try companion.authenticatedRequestBuilder().request(url, epoch)
        if refuseSocket && url.path.hasSuffix("/audio") {
            request.setValue("synthetic=refused", forHTTPHeaderField: "Cookie")
        }
        return request
    }
}

@MainActor private func coordinator(_ conversation: NativeLiveConversation) throws -> LiveSessionCoordinator {
    guard let value = Mirror(reflecting: conversation).children.first(where: { $0.label == "coordinator" })?.value
        as? LiveSessionCoordinator else { throw ProbeError.assertion("actual coordinator unavailable") }
    return value
}

private func observeUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(3)
    while !(await condition()) {
        if ContinuousClock.now >= deadline { throw ProbeError.assertion("actual lifecycle deadline") }
        try await Task.sleep(for: .milliseconds(2))
    }
}

@main struct NativeLifetimeProbe {
    @MainActor static func main() async {
        var stage = "setup"
        do {
            let fixture = try JSONDecoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile())
            let authority = try LifetimeAuthority(fixture)
            let origin = URL(string: fixture.origin)!
            let requests: NativeLiveRequestBuilder = { url, epoch in try authority.request(url, epoch) }
            if CommandLine.arguments.contains("--production-native-request") {
                authority.refuseSocket = false
                let http = NativeLiveOperatorHTTP(authority: (origin, requests))
                stage = "begin-intent"
                let intent = try await http.beginIntent()
                stage = "create"
                let snapshot = try await http.create(for: intent, key: UUID().uuidString)
                let binding = LiveSocketBinding(origin: origin, sessionID: snapshot.liveSessionId,
                    authorityEpoch: intent.authorityEpoch, profileIdentity: intent.profileIdentity)
                stage = "request-validation"
                let request = try await http.request(for: binding)
                try LiveSocketTransport.validate(request, binding: binding)
                stage = "socket-ready"
                let socket = try await LiveSocketTransport(requests: http).connect(binding)
                guard case .marker(let ready) = try await socket.receive(), ready.kind == .ready else {
                    throw ProbeError.assertion("actual ready frame")
                }
                stage = "provider-pcm"
                try await socket.sendPCM(Data([1, 0]))
                guard case .pcm(let pcm) = try await socket.receive(), !pcm.isEmpty else {
                    throw ProbeError.assertion("actual returned provider PCM")
                }
                stage = "terminal-close"
                try await socket.sendControl(.close)
                do {
                    guard case .terminal(let terminal, complete: true) = try await socket.receive(), terminal.state == .closed else {
                        throw ProbeError.assertion("actual terminal closure")
                    }
                } catch LiveClientError.socketClosed { }
                await socket.cancel()
                let closed = try await http.snapshot(sessionID: snapshot.liveSessionId, for: intent)
                try require(closed.liveSessionId == snapshot.liveSessionId && closed.terminal?.state == .closed,
                            "authoritative actual closed snapshot")
                stage = "provider-journal"
                let journal = try await http.journal(sessionID: snapshot.liveSessionId, cursor: nil, for: intent)
                try require(journal.liveSessionId == snapshot.liveSessionId && journal.terminal?.complete == true
                    && journal.terminal?.outcome.state == .closed
                    && journal.fragments.contains(where: { $0.kind == "ready" }), "actual provider readiness and complete journal")
                print("PRODUCTION NATIVE ATTACH PASS ready=true returnedPCMBytes=\(pcm.count) closed=true providerJournalReady=true")
                return
            }
            let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
            if CommandLine.arguments.contains("--native-listening-hold") {
                authority.refuseSocket = false
                var capture: NativeCaptureBuffer?
                let device = NativeLiveAudioDevice(captureInput: format,
                    defaultInput: { (id: "synthetic-1", name: "Synthetic input") })
                device.onCapturePrepared = { capture = $0 }
                let conversation = NativeLiveConversation(authority: (origin, requests),
                    dictationIsCapturing: { false }, audioDevice: device)
                conversation.start()
                let actual = try coordinator(conversation)
                stage = "active-capture"
                try await observeUntil { await actual.state == .active }
                try await observeUntil { await MainActor.run { conversation.state == .listening } }
                try require(!device.hasEngine && device.isCapturing && capture != nil, "synthetic capture has no engine")
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
                buffer.frameLength = buffer.frameCapacity
                buffer.floatChannelData![0].initialize(repeating: 0.1, count: Int(buffer.frameLength))
                capture!.append(buffer)
                try FileHandle.standardOutput.write(contentsOf: Data("NATIVE LISTENING INJECTED\n".utf8))
                stage = "persistent-socket-hold"
                let started = ContinuousClock.now
                try await Task.sleep(for: .seconds(18))
                let state = await actual.state
                let attached = state == .active
                let nativeListening = conversation.state == .listening
                let captureActive = device.isCapturing
                let enginePresent = device.hasEngine
                let elapsed = started.duration(to: .now)
                print("NATIVE LISTENING OBSERVED coordinator=\(state) native=\(conversation.state.rawValue) capture=\(captureActive) engine=\(enginePresent) elapsed=\(elapsed)")
                conversation.stopCapture()
                capture!.append(buffer)
                let stoppedFence = capture!.next().0 == nil && !device.isCapturing && !device.hasEngine
                await conversation.stop()
                print("NATIVE LISTENING CLEANUP stoppedBufferFence=\(stoppedFence) capture=\(device.isCapturing) engine=\(device.hasEngine)")
                try require(stoppedFence, "stopped capture buffer fence")
                try require(attached && nativeListening && captureActive && !enginePresent,
                            "valid persistent socket survives beyond fifteen seconds")
                print("NATIVE LISTENING HOLD PASS")
                return
            }
            var inputID = "synthetic-1"
            var published: NativeLiveConversation?
            var released: [NativeLiveConversation] = []
            var captures: [NativeCaptureBuffer] = []
            let owner = NativeLiveAuthorityOwner<NativeLiveConversation>(release: {
                $0.stopCapture(); released.append($0)
            }, publish: { published = $0 })
            owner.rebind("synthetic-authority")
            func make() -> NativeLiveConversation {
                let device = NativeLiveAudioDevice(captureInput: format,
                    defaultInput: { (id: inputID, name: "Synthetic input") })
                device.onCapturePrepared = { captures.append($0) }
                return NativeLiveConversation(authority: (origin, requests), dictationIsCapturing: { false }, audioDevice: device)
            }
            let retainStopped = CommandLine.arguments.contains("--native-lifetime-retained")
            func start() -> NativeLiveConversation {
                if !retainStopped && published?.isCapturing == false { owner.clear() }
                let conversation = owner.ownerStart(make: make)
                conversation.start()
                return conversation
            }
            let first = start()
            try require(first.state == .connecting && owner.ownerStart(make: make) === first,
                        "connecting retains the actual conversation")
            try await observeUntil { await MainActor.run { first.state == .outcomeUnknown } }
            try require(!first.isCapturing && !first.device.hasEngine, "failed attach releases capture")
            authority.refuseSocket = false
            let retry = start()
            let retryCoordinator = try coordinator(retry)
            try await observeUntil { await retryCoordinator.state == .active }
            if retainStopped {
                guard let wrapped = Mirror(reflecting: retry).children.first(where: { $0.label == "observer" })?.value
                    as? Task<Void, Never>?, let observer = wrapped else { throw ProbeError.assertion("actual observer unavailable") }
                await observer.value
                try require(retry === first && retry.state == .connecting && retry.device.isCapturing,
                            "retained lifetime stream loses actual active presentation")
                retry.stopCapture(); await retry.stop()
                print("NATIVE LIFETIME RED retained=true serviceActive=true presentationConnecting=true")
                exit(1)
            }
            try await observeUntil { await MainActor.run { retry.state == .listening } }
            try require(retry !== first && published === retry, "retry publishes a fresh actual conversation")
            try require(owner.ownerStart(make: make) === retry && retry.isCapturing, "active capture preserves ownership")
            inputID = "synthetic-2"
            retry.device.routeChanged(); await retry.device.finishRouteRecovery()
            try require(retry.state == .pausedForInput && retry.isCapturing && !retry.device.isCapturing,
                        "input pause remains owned after capture release")
            try require(start() === retry && retry.device.isCapturing, "Resume reuses the paused conversation")
            let oldCapture = captures.last!
            retry.stopCapture()
            let stale = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2560)!
            stale.frameLength = stale.frameCapacity
            stale.floatChannelData![0].initialize(repeating: 0.1, count: Int(stale.frameLength))
            oldCapture.append(stale)
            try require(!retry.device.isCapturing && !retry.device.hasEngine && oldCapture.next().0 == nil,
                        "Stop synchronously releases the actual converter and drain")
            let restarted = start()
            try await observeUntil { await MainActor.run { restarted.state == .listening } }
            try require(restarted !== retry && published === restarted, "ordinary restart publishes a fresh conversation")
            try FileHandle.standardOutput.write(contentsOf: Data("NATIVE LIFETIME OLD RELEASED\n".utf8))
            try await observeUntil { await retryCoordinator.state != .active }
            retry.device.onOutput?(true)
            do { try await retry.device.write(Data([1, 0])); throw ProbeError.assertion("released device accepted late PCM") }
            catch LiveClientError.unavailable { }
            try require(!retry.device.isCapturing && !retry.device.hasEngine && restarted.state == .listening
                && published === restarted, "late old audio and callback cannot affect the new owner")
            owner.clear()
            for conversation in released { await conversation.stop() }
            print("NATIVE LIFETIME PASS failedRetry=true stopRestart=true ownedBusyStates=true oldCaptureReleased=true lateOldIsolated=true")
        } catch {
            let code = (error as? LiveClientError)?.rawValue ?? "fixture-assertion"
            print("NATIVE LIFETIME FAIL stage=\(stage) class=\(type(of: error)) code=\(code)"); exit(2)
        }
    }
}
