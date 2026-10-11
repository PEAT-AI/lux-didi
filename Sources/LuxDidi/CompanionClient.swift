import Foundation
import Security
import LocalAuthentication

struct ServiceDescriptor: Codable {
    let origin: String
    let credentialService: String
    let credentialAccount: String
    var baseURL: URL { URL(string: origin)! }
    init(origin: String, credentialService: String, credentialAccount: String) throws {
        guard let parts = URLComponents(string: origin), parts.scheme == "http", parts.host == "127.0.0.1",
              let port = parts.port, (1...65535).contains(port), parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              origin == "http://127.0.0.1:\(port)", !credentialService.isEmpty, !credentialAccount.isEmpty else {
            throw CompanionError.invalidConfiguration
        }
        self.origin = origin; self.credentialService = credentialService; self.credentialAccount = credentialAccount
    }
    static func configured() throws -> ServiceDescriptor {
        guard let path = ProcessInfo.processInfo.environment["LUX_DIDI_DESCRIPTOR"] else { throw CompanionError.invalidConfiguration }
        let decoded = try JSONDecoder().decode(ServiceDescriptor.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        // Codable synthesis is not a validation boundary: always revalidate operator-supplied config.
        return try ServiceDescriptor(origin: decoded.origin, credentialService: decoded.credentialService, credentialAccount: decoded.credentialAccount)
    }
    func allows(_ url: URL?) -> Bool {
        guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == baseURL.scheme && parts.host == baseURL.host && parts.port == baseURL.port && parts.user == nil && parts.password == nil
    }
    func page(_ url: URL?) -> Bool {
        allows(url) && url?.path == "/" && url?.query == nil && url?.fragment == nil
    }
    @MainActor func credential() throws -> String {
        guard NativeKeychainPolicy.check() == errSecSuccess else { throw CompanionError.credentialUnavailable }
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: credentialService, kSecAttrAccount as String: credentialAccount,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let token = String(data: data, encoding: .utf8), !token.isEmpty,
              !token.contains("\n"), !token.contains("\r") else { throw CompanionError.credentialUnavailable }
        return token
    }
}

enum CompanionError: LocalizedError {
    case invalidConfiguration, credentialUnavailable, unavailable, authentication, invalidResponse, rejected(Int), unresolvedCapture
    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "Didi isn’t connected. Start the Didi service, then connect this app."
        case .credentialUnavailable: return "Didi couldn’t access its saved connection. Check Settings, then try again."
        case .unavailable: return "Service unavailable. Retry explicitly; your draft is retained."
        case .authentication: return "Authentication expired. Reconnect explicitly before retrying the same capture."
        case .invalidResponse: return "The service response was not accepted. Your draft is retained."
        case .rejected(let status): return "Service refused the request (HTTP \(status)). Your draft is retained."
        case .unresolvedCapture: return "A previous capture has an unknown outcome. Retry that same capture before starting another."
        }
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct SyntheticProofRecord {
    let sessionId: String
    let entryId: String
    let text: String
    func report(visible: Bool) -> [String: Any] { ["sessionId": sessionId, "entryId": entryId, "text": text, "visibleInCanonicalUI": visible] }
}

struct CaptureReceipt { let entryID: String; let sessionID: String }
enum CaptureStatus: Equatable { case idle, sending, saved, cancelled, unknown, failed }

@MainActor final class CompanionClient {
    private(set) var descriptor: ServiceDescriptor
    private var credential: () throws -> String
    private var connectionGuard: () -> Bool
    private var expectedEpoch: String?
    private let session: URLSession
    private var epoch: String?
    private var cookie: HTTPCookie?
    private var csrf: String?
    private var sessionID: String?
    private struct Capture {
        let text: String
        let timeZone: String
        let epoch: String
        let sessionKey = UUID().uuidString
        let entryKey = UUID().uuidString
        var sessionID: String?
        var receipt: CaptureReceipt?
    }
    private var pending: Capture?
    private(set) var captureStatus: CaptureStatus = .idle
    var captureReceipt: CaptureReceipt? { pending?.receipt }
    init(descriptor: ServiceDescriptor, credential: @escaping () throws -> String, expectedEpoch: String? = nil, connectionGuard: @escaping () -> Bool = { true }) {
        self.descriptor = descriptor; self.credential = credential
        self.expectedEpoch = expectedEpoch; self.connectionGuard = connectionGuard
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8; config.timeoutIntervalForResource = 12
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    // Only after new owned readiness. Keep pending UUID/body/epoch on restart;
    // transport replacement must never silently turn an uncertain send into a new one.
    func rebind(descriptor: ServiceDescriptor, credential: @escaping () throws -> String, expectedEpoch: String, connectionGuard: @escaping () -> Bool) async {
        if self.connectionGuard() { await revokePageSession() }
        self.descriptor = descriptor; self.credential = credential
        self.expectedEpoch = expectedEpoch; self.connectionGuard = connectionGuard
        cookie = nil; csrf = nil
    }
    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, query: [URLQueryItem] = [],
                         bearer: Bool = true, page: Bool = false, key: String? = nil, authority: String? = nil) async throws -> ([String: Any], HTTPURLResponse) {
        guard connectionGuard() else { throw CompanionError.unavailable }
        var parts = URLComponents(url: descriptor.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query }
        guard let url = parts.url, descriptor.allows(url) else { throw CompanionError.invalidConfiguration }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if bearer { request.setValue("Bearer " + (try credential()), forHTTPHeaderField: "Authorization") }
        if page {
            request.setValue(descriptor.origin, forHTTPHeaderField: "Origin")
            if let cookie { request.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie") }
            if method != "GET", let csrf { request.setValue(csrf, forHTTPHeaderField: "X-Didi-CSRF") }
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if let authority { request.setValue(authority, forHTTPHeaderField: "X-Didi-Authority-Epoch") }
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw CompanionError.unavailable }
        guard let http = response as? HTTPURLResponse, descriptor.allows(http.url) else { throw CompanionError.invalidResponse }
        if http.statusCode == 401 { throw CompanionError.authentication }
        guard (200...299).contains(http.statusCode) else { throw CompanionError.rejected(http.statusCode) }
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = envelope["data"] as? [String: Any] else { throw CompanionError.invalidResponse }
        return (value, http)
    }
    func bootstrap() async throws -> HTTPCookie {
        // Only explicitly requested reconnect. No auto auth or mutation retry loop.
        await revokePageSession()
        let (status, _) = try await request("api/v1/status")
        guard let current = status["authorityEpoch"] as? String, UUID(uuidString: current) != nil, expectedEpoch == nil || expectedEpoch == current else { throw CompanionError.invalidResponse }
        if epoch != current { sessionID = nil }
        epoch = current
        let (pairing, _) = try await request("api/v1/auth/pairing", method: "POST", body: [:])
        guard let code = pairing["pairingCode"] as? String, !code.isEmpty else { throw CompanionError.invalidResponse }
        let (_, response) = try await request("api/v1/auth/pair", method: "POST", body: ["pairingCode": code], bearer: false, page: true)
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { if let key = $1.key as? String, let value = $1.value as? String { $0[key] = value } }
        guard let header = response.value(forHTTPHeaderField: "Set-Cookie"), header.lowercased().contains("samesite=strict"),
              let scoped = HTTPCookie.cookies(withResponseHeaderFields: headers, for: descriptor.baseURL).first,
              scoped.isHTTPOnly, scoped.domain == "127.0.0.1", scoped.path == "/" else { throw CompanionError.invalidResponse }
        cookie = scoped
        // Normal HTTP page API, never injected into JS. The page fetches its own CSRF token too.
        let (csrfData, _) = try await request("api/v1/auth/session", bearer: false, page: true)
        guard let token = csrfData["csrfToken"] as? String, !token.isEmpty else { throw CompanionError.invalidResponse }
        csrf = token
        return scoped
    }
    // Installed-proof observations use the authoritative APIs, never native SQL/state.
    func proofRecords(prefix: String) async throws -> [SyntheticProofRecord] {
        let (recall, _) = try await request("api/v1/recall", query: [URLQueryItem(name: "q", value: prefix), URLQueryItem(name: "limit", value: "20")])
        guard recall["truncated"] as? Bool == false, let hits = recall["hits"] as? [[String: Any]] else { throw CompanionError.invalidResponse }
        var records: [SyntheticProofRecord] = []
        var seen = Set<String>()
        for hit in hits {
            guard let sessionId = hit["sessionId"] as? String, let entryId = hit["entryId"] as? String,
                  UUID(uuidString: sessionId) != nil, UUID(uuidString: entryId) != nil else { throw CompanionError.invalidResponse }
            if !seen.insert(entryId).inserted { continue }
            let (detail, _) = try await request("api/v1/sessions/" + sessionId)
            guard let entries = detail["entries"] as? [[String: Any]], let entry = entries.first(where: { $0["id"] as? String == entryId }),
                  entry["role"] as? String == "user", let text = entry["text"] as? String, text.hasPrefix(prefix) else { throw CompanionError.invalidResponse }
            records.append(SyntheticProofRecord(sessionId: sessionId, entryId: entryId, text: text))
        }
        return records.sorted { $0.entryId < $1.entryId }
    }
    func revokePageSession() async {
        if cookie != nil, csrf != nil { _ = try? await request("api/v1/auth/logout", method: "POST", body: [:], bearer: false, page: true) }
        cookie = nil; csrf = nil
    }
    func capture(text: String, timeZone: String) async throws -> CaptureReceipt {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, TimeZone(identifier: timeZone) != nil,
              let epoch else { throw CompanionError.invalidConfiguration }
        if let pending, pending.receipt == nil { throw CompanionError.unresolvedCapture }
        pending = Capture(text: text, timeZone: timeZone, epoch: epoch, sessionID: sessionID)
        return try await retryCapture()
    }
    func retryCapture() async throws -> CaptureReceipt {
        guard var capture = pending else { throw CompanionError.invalidConfiguration }
        if Task.isCancelled { captureStatus = .cancelled; throw CancellationError() }
        captureStatus = .sending
        do {
            if capture.sessionID == nil {
                let (value, _) = try await request("api/v1/sessions", method: "POST", body: ["title": "Native capture", "timeZone": capture.timeZone], key: capture.sessionKey, authority: capture.epoch)
                guard let id = value["id"] as? String, UUID(uuidString: id) != nil, let revision = value["revision"] as? Int, revision > 0 else { throw CompanionError.invalidResponse }
                capture.sessionID = id; pending = capture; sessionID = id
            }
            let (entry, _) = try await request("api/v1/sessions/\(capture.sessionID!)/entries", method: "POST", body: ["text": capture.text, "role": "user", "timeZone": capture.timeZone], key: capture.entryKey, authority: capture.epoch)
            guard let id = entry["id"] as? String, UUID(uuidString: id) != nil, entry["sessionId"] as? String == capture.sessionID else { throw CompanionError.invalidResponse }
            let receipt = CaptureReceipt(entryID: id, sessionID: capture.sessionID!)
            capture.receipt = receipt; pending = capture; captureStatus = .saved
            return receipt
        } catch {
            // Transport loss, malformed success, cancellation after dispatch: may already have saved.
            // Even a later definitive rejection cannot erase an earlier unknown result.
            captureStatus = .unknown
            throw error
        }
    }
}
