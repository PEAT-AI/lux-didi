import Foundation
import CoreFoundation

public enum LiveClientError: Error, Sendable, Equatable, LocalizedError {
    case invalidIntent, statusMismatch, grantMismatch, invalidDestination, forbiddenHeader
    case invalidFrame, invalidAudio, queueOverflow, staleOperation, unavailable, conflict, transport
    case http(status: Int, code: String?)
    case socketClosed(code: Int, reason: String?)

    public var rawValue: String {
        switch self {
        case .http: return "http"
        case .socketClosed: return "socketClosed"
        default: return String(describing: self)
        }
    }
    public var errorDescription: String? {
        switch self {
        case .http(let status, let code):
            return "Live service HTTP \(status)" + (code.map { ": " + $0 } ?? "") + "."
        case .socketClosed(let code, let reason):
            return "Live socket closed (\(code))" + (reason.map { ": " + $0 } ?? "") + "."
        default: return nil
        }
    }
    public static func boundedCode(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.utf8.count <= 107,
              value.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil else { return nil }
        return value
    }
    public static func boundedCloseReason(_ data: Data?) -> String? {
        guard let data, data.count <= 123, let text = String(data: data, encoding: .utf8),
              text.hasPrefix("attach_rejected:"), boundedCode(String(text.dropFirst(16))) != nil else { return nil }
        return text
    }
}

public struct LiveSocketBinding: Sendable, Equatable {
    public let origin: URL
    public let sessionID: String
    public let authorityEpoch: String
    public let profileIdentity: String
    public init(origin: URL, sessionID: String, authorityEpoch: String, profileIdentity: String) {
        self.origin = origin; self.sessionID = sessionID
        self.authorityEpoch = authorityEpoch; self.profileIdentity = profileIdentity
    }
    public var audioPath: String { "/api/v1/live-sessions/" + sessionID + "/audio" }
}

public protocol LiveAuthenticatedRequestFactory: Sendable {
    func request(for binding: LiveSocketBinding) async throws -> URLRequest
}

public enum LiveTerminalState: String, Codable, Sendable {
    case closed, failed, cancelled, deadline, not_started, outcome_unknown
    case journal_limit, consumer_backpressure, expired, revoked
}

public struct LiveTerminal: Codable, Sendable, Equatable {
    public let state: LiveTerminalState
    public let code: String?
    public init(state: LiveTerminalState, code: String? = nil) {
        self.state = state; self.code = LiveClientError.boundedCode(code)
    }
}

public enum LiveMarkerKind: String, Codable, Sendable {
    case ready, interrupted, generationComplete, turnComplete, waitingForInput
    case inputTranscription, outputTranscription
}

public struct LiveMarker: Sendable, Equatable {
    public let kind: LiveMarkerKind
    public let sequence: Int
    public let journalSequence: Int
    public let text: String?
    public let finished: Bool?
    public let value: Bool?
}

public enum LiveToolMarkerKind: String, Sendable { case toolCall, toolResult }
/// Validated progress only; tool authorization and durable results remain service-owned.
public struct LiveToolMarker: Sendable, Equatable {
    public let kind: LiveToolMarkerKind
    public let sequence: Int?
    public let journalSequence: Int
}

public enum LiveFrame: Sendable, Equatable {
    case pcm(Data)
    case marker(LiveMarker)
    case tool(LiveToolMarker)
    case terminal(LiveTerminal, complete: Bool)
    case continuity(event: String)
}

public enum LiveControl: String, Sendable {
    case endAudioStream, close
    /// The owner's mute, sent on the call's own socket: one frame each way, no payload.
    case inputMuted, inputLive
    public var json: String { "{\"type\":\"" + rawValue + "\"}" }
}

public protocol LiveSocket: Sendable {
    func receive() async throws -> LiveFrame
    func sendPCM(_ data: Data) async throws
    /// Z2: send one microphone frame and say whether it went out. `false` means the wire was held by a
    /// control frame or a playback receipt and the frame was shed: a gap of milliseconds in the
    /// microphone stream, never a failed call.
    func sendPCMReportingShed(_ data: Data) async throws -> Bool
    func sendControl(_ control: LiveControl) async throws
    /// O1b-N: one bounded playback receipt frame on the socket the call already holds.
    func sendReceipt(_ frame: String) async throws
    func cancel() async
}
public extension LiveSocket {
    /// A socket that holds no shared lane has nothing to shed: every frame it accepts went out.
    func sendPCMReportingShed(_ data: Data) async throws -> Bool { try await sendPCM(data); return true }
}
public protocol LiveSocketConnecting: Sendable {
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket
}

/// An authenticated request is injected by the accepted native authority owner, never reconstructed here.
public struct LiveSocketTransport: LiveSocketConnecting, Sendable {
    private let requests: any LiveAuthenticatedRequestFactory
    private let nativeActions: any NativeActionExecuting
    public init(requests: any LiveAuthenticatedRequestFactory, nativeActions: any NativeActionExecuting = NativeActions()) {
        self.requests = requests
        self.nativeActions = nativeActions
    }
    public func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket {
        try Self.validate(binding)
        let request: URLRequest
        do { request = try await requests.request(for: binding) }
        catch { throw LiveClientError.unavailable }
        try Self.validate(request, binding: binding)
        try Task.checkCancellation()
        return FoundationLiveSocket(request: request, nativeActions: nativeActions)
    }
    public static func validate(_ binding: LiveSocketBinding) throws {
        guard let parts = URLComponents(url: binding.origin, resolvingAgainstBaseURL: false),
              parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port,
              (1...65535).contains(port), parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              UUID(uuidString: binding.sessionID) != nil,
              !binding.authorityEpoch.isEmpty, !binding.profileIdentity.isEmpty else {
            throw LiveClientError.invalidDestination
        }
    }
    public static func validate(_ request: URLRequest, binding: LiveSocketBinding) throws {
        guard let url = request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "ws", parts.host == "127.0.0.1", parts.port == binding.origin.port,
              parts.percentEncodedPath == binding.audioPath, parts.query == nil, parts.fragment == nil,
              parts.user == nil, parts.password == nil, request.httpMethod == "GET", request.httpBody == nil,
              request.httpBodyStream == nil else { throw LiveClientError.invalidDestination }
        let headers = request.allHTTPHeaderFields ?? [:]
        let lowered = headers.map { ($0.key.lowercased(), $0.value) }
        for name in ["authorization", "host", "x-didi-authority-epoch", "x-didi-live-profile"] {
            guard lowered.filter({ $0.0 == name }).count == 1 else { throw LiveClientError.forbiddenHeader }
        }
        // URLRequest cannot represent repeated raw headers; also reject a folded Authorization value.
        guard let authorization = request.value(forHTTPHeaderField: "Authorization"),
              authorization.hasPrefix("Bearer "), authorization.count > 7,
              !authorization.contains(","), !authorization.contains("\r"), !authorization.contains("\n"),
              request.value(forHTTPHeaderField: "Host") == "127.0.0.1:" + String(binding.origin.port!),
              request.value(forHTTPHeaderField: "x-didi-authority-epoch") == binding.authorityEpoch,
              request.value(forHTTPHeaderField: "x-didi-live-profile") == binding.profileIdentity else {
            throw LiveClientError.forbiddenHeader
        }
        for name in ["cookie", "origin", "sec-websocket-protocol", "proxy-authorization"] {
            guard !lowered.contains(where: { $0.0 == name }) else { throw LiveClientError.forbiddenHeader }
        }
    }
    public static func validatePCM(_ data: Data) throws {
        guard !data.isEmpty, data.count.isMultiple(of: 2), data.count <= 65536 else { throw LiveClientError.invalidAudio }
    }
    public static func decode(_ message: URLSessionWebSocketTask.Message) throws -> LiveFrame {
        switch message {
        case .data(let data): try validatePCM(data); return .pcm(data)
        case .string(let string):
            guard string.utf8.count <= 65536,
                  let object = try? JSONSerialization.jsonObject(with: Data(string.utf8)) as? [String: Any],
                  let type = object["type"] as? String else { throw LiveClientError.invalidFrame }
            if type == "continuity" {
                guard Set(object.keys).isSubset(of: ["type", "sequence", "journalSequence", "event", "reason"]),
                      object["sequence"] is NSNull,
                      let journalSequence = integer(object["journalSequence"]), journalSequence > 0,
                      let event = object["event"] as? String, ["rebuilding", "resumed"].contains(event),
                      object["reason"] == nil || object["reason"] is String else { throw LiveClientError.invalidFrame }
                return .continuity(event: event)
            }
            if type == "terminal" {
                guard Set(object.keys) == Set(["type", "state", "code", "complete"]),
                      let raw = object["state"] as? String, let state = LiveTerminalState(rawValue: raw),
                      let complete = boolean(object["complete"]),
                      object["code"] is NSNull || object["code"] is String else { throw LiveClientError.invalidFrame }
                let code = object["code"] as? String
                guard code == nil || LiveClientError.boundedCode(code) != nil else { throw LiveClientError.invalidFrame }
                return .terminal(LiveTerminal(state: state, code: code), complete: complete)
            }
            if let kind = LiveToolMarkerKind(rawValue: type) {
                guard Set(object.keys) == Set(["type", "sequence", "journalSequence", "tool"]),
                      object["sequence"] is NSNull || integer(object["sequence"]).map({ $0 > 0 }) == true,
                      let journal = integer(object["journalSequence"]), journal > 0,
                      let tool = object["tool"] as? [String: Any],
                      let name = tool["name"] as? String, !name.isEmpty,
                      let status = tool["status"] as? String else { throw LiveClientError.invalidFrame }
                switch kind {
                case .toolCall:
                    guard Set(tool.keys) == Set(["name", "status"]), status == "called" else { throw LiveClientError.invalidFrame }
                case .toolResult:
                    guard Set(tool.keys) == Set(["name", "status", "markdown", "sources"]),
                          ["completed", "error"].contains(status), tool["markdown"] is String,
                          let sources = tool["sources"] as? [[String: Any]], sources.allSatisfy({ source in
                              Set(source.keys).isSubset(of: ["title", "url"]) && source["title"] is String
                                  && (source["url"] == nil || source["url"] is String)
                          }) else { throw LiveClientError.invalidFrame }
                }
                return .tool(LiveToolMarker(kind: kind, sequence: integer(object["sequence"]), journalSequence: journal))
            }
            guard let kind = LiveMarkerKind(rawValue: type),
                  Set(object.keys).isSubset(of: ["type", "sequence", "journalSequence", "text", "finished", "value"]),
                  let sequence = integer(object["sequence"]), sequence > 0,
                  let journal = integer(object["journalSequence"]), journal > 0 else { throw LiveClientError.invalidFrame }
            let text = object["text"] as? String
            let finished = boolean(object["finished"])
            let value = boolean(object["value"])
            switch kind {
            case .inputTranscription, .outputTranscription:
                guard text != nil, object["finished"] == nil || finished != nil,
                      object["value"] == nil else { throw LiveClientError.invalidFrame }
            case .waitingForInput:
                guard value != nil, object["text"] == nil, object["finished"] == nil else { throw LiveClientError.invalidFrame }
            default:
                guard object["text"] == nil, object["finished"] == nil, object["value"] == nil else { throw LiveClientError.invalidFrame }
            }
            return .marker(LiveMarker(kind: kind, sequence: sequence, journalSequence: journal, text: text, finished: finished, value: value))
        @unknown default: throw LiveClientError.invalidFrame
        }
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }
    private static func integer(_ value: Any?) -> Int? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
              value.doubleValue <= 9007199254740991, value.doubleValue >= 0 else { return nil }
        return value.intValue
    }
}

private final class BoundSessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// One send at a time on one socket. Audio that finds the wire busy gives up at once, which the caller already reads
/// as backpressure, but a control frame is never shed: it takes its turn as soon as the wire is free and is served
/// before any audio waiting behind it.
actor LiveSendQueue {
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func acquireControl() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func acquireAudio() -> Bool {
        if busy { return false }
        busy = true
        return true
    }
    func release() {
        if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
    }
}

private actor FoundationLiveSocket: LiveSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private let nativeActions: any NativeActionExecuting
    private let sends = LiveSendQueue()
    private var closed = false
    private var receiving = false
    init(request: URLRequest, nativeActions: any NativeActionExecuting) {
        self.nativeActions = nativeActions
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCache = nil; configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 3; configuration.timeoutIntervalForResource = 15
        session = URLSession(configuration: configuration, delegate: BoundSessionDelegate(), delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 65536
        task.resume()
    }
    func receive() async throws -> LiveFrame {
        guard !closed, !receiving else { throw LiveClientError.unavailable }
        receiving = true
        defer { receiving = false }
        do {
            while true {
                let message = try await task.receive()
                // A native action is a control frame, never a frame of the conversation.
                if case .string(let text) = message, let action = NativeActionFrame.control(text) {
                    let result = await nativeActions.perform(action.action, target: action.target)
                    guard !closed else { throw LiveClientError.staleOperation }
                    try await send(.string(NativeActionReply(id: action.id, result: result).json))
                    continue
                }
                let frame = try LiveSocketTransport.decode(message)
                guard !closed else { throw LiveClientError.staleOperation }
                return frame
            }
        } catch let error as LiveClientError { throw error }
        catch {
            if task.closeCode != .invalid {
                throw LiveClientError.socketClosed(code: task.closeCode.rawValue, reason: LiveClientError.boundedCloseReason(task.closeReason))
            }
            throw LiveClientError.transport
        }
    }
    func sendPCM(_ data: Data) async throws { _ = try await sendPCMReportingShed(data) }
    func sendPCMReportingShed(_ data: Data) async throws -> Bool {
        try LiveSocketTransport.validatePCM(data)
        guard await sends.acquireAudio() else { return false }
        do { try await send(.data(data)) } catch { await sends.release(); throw error }
        await sends.release()
        return true
    }
    /// O1b-N: one bounded playback receipt on the same socket. Like a control frame it is never shed:
    /// a receipt is tiny, and a dropped one is a hole the timeline would have to report.
    func sendReceipt(_ frame: String) async throws {
        guard frame.utf8.count <= 1_024 else { throw LiveClientError.invalidFrame }
        await sends.acquireControl()
        do { try await send(.string(frame)) }
        catch { await sends.release(); throw error }
        await sends.release()
    }
    /// A control frame is never shed: it waits for the wire and then goes ahead of any audio behind it, so a Stop
    /// that arrives while the microphone is sending still reaches the host.
    func sendControl(_ control: LiveControl) async throws {
        await sends.acquireControl()
        do { try await send(.string(control.json)) } catch { await sends.release(); throw error }
        await sends.release()
    }
    private func send(_ message: URLSessionWebSocketTask.Message) async throws {
        guard !closed else { throw LiveClientError.unavailable }
        do { try await task.send(message) }
        catch { throw LiveClientError.transport }
    }
    func cancel() {
        guard !closed else { return }
        closed = true
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}
