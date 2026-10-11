import Foundation
#if DIDI_OWNER_MODULE
import DidiOwner
#endif

private final class NativeLiveNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Uses the companion's current credential and connection guard, never a second credential store.
@MainActor struct NativePendingLiveJob: Decodable, Equatable, Sendable {
    let id: String
    let state: String
    let markdown: String
    var isReady: Bool { state == "completed" || state == "failed" || state == "unknown" }
}

final class NativeLiveOperatorHTTP: LiveOperatorHTTP, LiveAuthenticatedRequestFactory {
    private struct Envelope<T: Decodable>: Decodable { let data: T }
    private struct Host: Decodable { let assistantId: String; let authorityEpoch: String }
    private struct Profile: Decodable {
        let status: String
        let provider: String?
        let model: String?
        let voice: String?
        let profileIdentity: String?
        let dataClasses: [String]?
    }
    let origin: URL
    private let build: NativeLiveRequestBuilder
    private let pickupJobID: String?
    private let session: URLSession
    init(authority: (origin: URL, request: NativeLiveRequestBuilder), pickupJobID: String? = nil) {
        self.pickupJobID = pickupJobID
        origin = authority.origin
        build = authority.request
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCache = nil; config.urlCredentialStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8; config.timeoutIntervalForResource = 12
        session = URLSession(configuration: config, delegate: NativeLiveNoRedirect(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    private func fetch(_ path: String, epoch: String?, method: String = "GET", body: Data? = nil,
                       key: String? = nil, cursor: Int? = nil) async throws -> Data {
        var parts = URLComponents(url: origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if let cursor { parts.queryItems = [URLQueryItem(name: "cursor", value: String(cursor))] }
        var request = try build(parts.url!, epoch)
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url,
              data.count < 2 * 1024 * 1024 else { throw LiveClientError.transport }
        if response.statusCode == 409 { throw LiveClientError.conflict }
        guard (200..<300).contains(response.statusCode) else { throw LiveClientError.transport }
        return data
    }
    private func projection(epoch: String?) async throws -> LiveOperatorStatus {
        let host = try JSONDecoder().decode(Envelope<Host>.self, from: await fetch("/api/v1/status", epoch: epoch)).data
        let profile = try JSONDecoder().decode(Envelope<Profile>.self, from: await fetch("/api/v1/live/status", epoch: host.authorityEpoch)).data
        guard profile.status == "configured", let provider = profile.provider, let model = profile.model,
              let voice = profile.voice, let identity = profile.profileIdentity, let classes = profile.dataClasses,
              epoch == nil || epoch == host.authorityEpoch else { throw LiveClientError.unavailable }
        return LiveOperatorStatus(origin: origin, assistantID: host.assistantId, authorityEpoch: host.authorityEpoch,
                                  provider: provider, model: model, voice: voice, profileIdentity: identity, dataClasses: classes)
    }
    func beginIntent(inputClass: String = "ordinary") async throws -> LiveBeginIntent {
        let status = try await projection(epoch: nil)
        guard status.dataClasses.contains(inputClass) else { throw LiveClientError.grantMismatch }
        return LiveBeginIntent(origin: origin, assistantID: status.assistantID, authorityEpoch: status.authorityEpoch,
                               provider: status.provider, model: status.model, voice: status.voice,
                               profileIdentity: status.profileIdentity, inputClass: inputClass)
    }
    func status(for intent: LiveBeginIntent) async throws -> LiveOperatorStatus {
        guard intent.origin == origin else { throw LiveClientError.invalidIntent }
        return try await projection(epoch: intent.authorityEpoch)
    }
    private func path(_ id: String) throws -> String {
        guard UUID(uuidString: id) != nil, id.lowercased() == id else { throw LiveClientError.invalidIntent }
        return "/api/v1/live-sessions/" + id
    }
    func pendingCalls() async throws -> [NativePendingLiveJob] {
        let host = try JSONDecoder().decode(Envelope<Host>.self, from: await fetch("/api/v1/status", epoch: nil)).data
        return try JSONDecoder().decode(Envelope<[NativePendingLiveJob]>.self,
            from: await fetch("/api/v1/live/jobs/pending", epoch: host.authorityEpoch)).data
    }
    func create(for intent: LiveBeginIntent, key: String) async throws -> LiveSnapshot {
        guard intent.origin == origin else { throw LiveClientError.invalidIntent }
        var input = ["inputClass": intent.inputClass]
        if let pickupJobID { input["pickupJobId"] = pickupJobID }
        let body = try JSONEncoder().encode(input)
        return try JSONDecoder().decode(Envelope<LiveSnapshot>.self, from: await fetch("/api/v1/live-sessions", epoch: intent.authorityEpoch, method: "POST", body: body, key: key)).data
    }
    func snapshot(sessionID: String, for intent: LiveBeginIntent) async throws -> LiveSnapshot {
        return try JSONDecoder().decode(Envelope<LiveSnapshot>.self, from: await fetch(path(sessionID), epoch: intent.authorityEpoch)).data
    }
    func journal(sessionID: String, cursor: Int?, for intent: LiveBeginIntent) async throws -> LiveJournalPage {
        guard cursor == nil || cursor! >= 0 else { throw LiveClientError.invalidIntent }
        return try JSONDecoder().decode(Envelope<LiveJournalPage>.self, from: await fetch(path(sessionID) + "/journal", epoch: intent.authorityEpoch, cursor: cursor)).data
    }
    func revoke(sessionID: String, for intent: LiveBeginIntent) async throws {
        _ = try await fetch(path(sessionID) + "/revoke", epoch: intent.authorityEpoch, method: "POST", body: Data("{}".utf8))
    }
    func request(for binding: LiveSocketBinding) async throws -> URLRequest {
        guard binding.origin == origin else { throw LiveClientError.invalidIntent }
        try LiveSocketTransport.validate(binding)
        var request = try build(origin.appendingPathComponent(binding.audioPath), binding.authorityEpoch)
        var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        parts.scheme = "ws"; request.url = parts.url
        request.setValue(binding.profileIdentity, forHTTPHeaderField: "x-didi-live-profile")
        return request
    }
}
