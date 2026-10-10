import Foundation

struct Fixture: Decodable {
    let origin: String
    let authorityEpoch: String
    let assistantId: String
    let token: String // synthetic fixture only; never a production coordinator field
    let profileIdentity: String
    let redirectOrigin: String
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

struct ProbeHTTP {
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
    func request(_ id: String, origin: String? = nil) -> URLRequest {
        let origin = origin ?? fixture.origin
        let url = URL(string: origin.replacingOccurrences(of: "http://", with: "ws://") + "/api/v1/live-sessions/" + id + "/audio")!
        var request = URLRequest(url: url)
        request.setValue(url.host! + ":" + String(url.port!), forHTTPHeaderField: "Host")
        request.setValue("Bearer " + fixture.token, forHTTPHeaderField: "Authorization")
        request.setValue(fixture.authorityEpoch, forHTTPHeaderField: "x-didi-authority-epoch")
        request.setValue(fixture.profileIdentity, forHTTPHeaderField: "x-didi-live-profile")
        return request
    }
}

@main struct Stage0 {
    static func main() async {
        var phase = "bootstrap"
        do {
            let fixture = try JSONDecoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile())
            let session = isolatedSession()
            defer { session.invalidateAndCancel() }
            let http = ProbeHTTP(fixture: fixture, session: session)
            for header in ["Cookie", "Origin", "Host", "x-didi-authority-epoch", "x-didi-live-profile"] {
                phase = "reject " + header
                let id = try await http.create("stage0-bad-" + header)
                var request = http.request(id)
                request.setValue("synthetic-invalid", forHTTPHeaderField: header)
                let socket = session.webSocketTask(with: request)
                socket.resume()
                var rejected = false
                do { _ = try await socket.receive() } catch { rejected = true }
                socket.cancel(with: .goingAway, reason: nil)
                try require(rejected, "bad header was not rejected")
            }
            phase = "valid attach"
            let id = try await http.create("stage0-good")
            let socket = session.webSocketTask(with: http.request(id))
            socket.resume()
            let frame = try await socket.receive()
            guard case .string(let marker) = frame else { throw ProbeError.assertion("expected ready marker") }
            let object = try JSONSerialization.jsonObject(with: Data(marker.utf8)) as? [String: Any]
            try require(object?["type"] as? String == "ready", "actual ready grammar")
            try await socket.send(.data(Data(repeating: 0, count: 8)))
            try await socket.send(.string("{\"type\":\"endAudioStream\"}"))
            try await socket.send(.string("{\"type\":\"close\"}"))
            socket.cancel(with: .normalClosure, reason: nil)
            print("PASS Stage0 actual URLSession request + five rejected headers")
            phase = "redirect"
            let redirectSocket = session.webSocketTask(with: http.request(id, origin: fixture.redirectOrigin))
            redirectSocket.resume()
            var redirectRejected = false
            do { _ = try await redirectSocket.receive() } catch { redirectRejected = true }
            redirectSocket.cancel(with: .goingAway, reason: nil)
            try require(redirectRejected, "redirect was followed")
            print("PASS Stage0 redirect rejected (trap counter verified by parent fixture)")
        } catch {
            // No raw URLSession/HTTP error or response payload is printed.
            let reason: String
            if case ProbeError.assertion(let message) = error { reason = message }
            else if let failure = error as? URLError { reason = "URLSession code " + String(failure.code.rawValue) }
            else { reason = "controlled transport failure" }
            FileHandle.standardError.write(Data(("FAIL Stage0 " + phase + ": " + reason + "\n").utf8))
            exit(1)
        }
    }
}
