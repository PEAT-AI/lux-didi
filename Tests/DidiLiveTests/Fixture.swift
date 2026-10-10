import Foundation

struct Fixture: Decodable, Sendable {
    let origin: String
    let authorityEpoch: String
    let assistantId: String
    let token: String // synthetic fixture only; never a production coordinator field
    let profileIdentity: String
    let redirectSessionID: String
}

enum ProbeError: Error { case assertion(String) }
func require(_ value: Bool, _ message: String) throws {
    if !value { throw ProbeError.assertion(message) }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

func isolatedSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 3
    configuration.timeoutIntervalForResource = 5
    return URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
}

struct ProbeHTTP: Sendable {
    let fixture: Fixture
    let session: URLSession
    func json(_ path: String, method: String = "GET", key: String? = nil,
              body: [String: String]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: fixture.origin + path)!)
        request.httpMethod = method
        request.setValue("Bearer " + fixture.token, forHTTPHeaderField: "Authorization")
        request.setValue(fixture.authorityEpoch, forHTTPHeaderField: "x-didi-authority-epoch")
        if let key { request.setValue(key, forHTTPHeaderField: "idempotency-key") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        try require((response as? HTTPURLResponse)?.statusCode == 200 || (response as? HTTPURLResponse)?.statusCode == 201, "synthetic HTTP rejected")
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = envelope["data"] as? [String: Any] else { throw ProbeError.assertion("HTTP envelope") }
        return value
    }
    func create(_ key: String) async throws -> String {
        let value = try await json("/api/v1/live-sessions", method: "POST", key: key, body: ["inputClass": "ordinary"])
        guard let id = value["liveSessionId"] as? String else { throw ProbeError.assertion("session ID") }
        return id
    }
    func request(_ id: String) -> URLRequest { fixtureRequest(fixture, id) }
}

func fixtureRequest(_ fixture: Fixture, _ id: String) -> URLRequest {
        let origin = fixture.origin
        let url = URL(string: origin.replacingOccurrences(of: "http://", with: "ws://") + "/api/v1/live-sessions/" + id + "/audio")!
        var request = URLRequest(url: url)
        request.setValue(url.host! + ":" + String(url.port!), forHTTPHeaderField: "Host")
        request.setValue("Bearer " + fixture.token, forHTTPHeaderField: "Authorization")
        request.setValue(fixture.authorityEpoch, forHTTPHeaderField: "x-didi-authority-epoch")
        request.setValue(fixture.profileIdentity, forHTTPHeaderField: "x-didi-live-profile")
        return request
    }
