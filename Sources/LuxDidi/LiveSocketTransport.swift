import Foundation
import CoreFoundation

public enum LiveClientError: String, Error, Sendable {
    case invalidIntent, statusMismatch, grantMismatch, invalidDestination, forbiddenHeader
    case invalidFrame, invalidAudio, queueOverflow, staleOperation, unavailable, conflict, transport
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
    public init(state: LiveTerminalState) { self.state = state }
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

public enum LiveFrame: Sendable, Equatable {
    case pcm(Data)
    case marker(LiveMarker)
    case terminal(LiveTerminal, complete: Bool)
}

public enum LiveControl: String, Sendable {
    case endAudioStream, close
    public var json: String { "{\"type\":\"" + rawValue + "\"}" }
}

public protocol LiveSocket: Sendable {
    func receive() async throws -> LiveFrame
    func sendPCM(_ data: Data) async throws
    func sendControl(_ control: LiveControl) async throws
    func cancel() async
}
public protocol LiveSocketConnecting: Sendable {
    func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket
}

/// An authenticated request is injected by the accepted native authority owner, never reconstructed here.
public struct LiveSocketTransport: LiveSocketConnecting, Sendable {
    private let requests: any LiveAuthenticatedRequestFactory
    public init(requests: any LiveAuthenticatedRequestFactory) { self.requests = requests }
    public func connect(_ binding: LiveSocketBinding) async throws -> any LiveSocket {
        try Self.validate(binding)
        let request: URLRequest
        do { request = try await requests.request(for: binding) }
        catch { throw LiveClientError.unavailable }
        try Self.validate(request, binding: binding)
        try Task.checkCancellation()
        return FoundationLiveSocket(request: request)
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
            if type == "terminal" {
                guard Set(object.keys) == Set(["type", "state", "code", "complete"]),
                      let raw = object["state"] as? String, let state = LiveTerminalState(rawValue: raw),
                      let complete = boolean(object["complete"]),
                      object["code"] is NSNull || object["code"] is String else { throw LiveClientError.invalidFrame }
                // Do not retain/copy the provider code field. Only the closed terminal-state enum is public here.
                return .terminal(LiveTerminal(state: state), complete: complete)
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
                guard text != nil, finished != nil, object["value"] == nil else { throw LiveClientError.invalidFrame }
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

private actor FoundationLiveSocket: LiveSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private var closed = false
    private var receiving = false
    private var sending = false
    init(request: URLRequest) {
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
            let frame = try await LiveSocketTransport.decode(task.receive())
            guard !closed else { throw LiveClientError.staleOperation }
            return frame
        } catch let error as LiveClientError { throw error }
        catch { throw LiveClientError.transport }
    }
    func sendPCM(_ data: Data) async throws {
        try LiveSocketTransport.validatePCM(data)
        try await send(.data(data))
    }
    func sendControl(_ control: LiveControl) async throws { try await send(.string(control.json)) }
    private func send(_ message: URLSessionWebSocketTask.Message) async throws {
        guard !closed else { throw LiveClientError.unavailable }
        guard !sending else { throw LiveClientError.queueOverflow }
        sending = true
        defer { sending = false }
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
