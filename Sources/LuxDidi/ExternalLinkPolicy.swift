import Foundation
import WebKit

/// The decision for a single navigation action, kept free of WebKit so it is
/// unit-testable without a running web view.
enum ExternalLinkDecision: Equatable { case allow, cancel, openExternal }

/// Pure navigation policy for the companion WebView. A user-activated link to a
/// foreign http(s) origin is handed to the system browser; everything that is
/// not a same-origin main-frame navigation stays cancelled.
enum ExternalLinkPolicy {
    static func decide(url: URL?, navigationType: WKNavigationType, isMainFrame: Bool?, ownOrigin: String) -> ExternalLinkDecision {
        guard let url, let scheme = url.scheme?.lowercased(), let host = url.host, !host.isEmpty else { return .cancel }
        if isOwnOrigin(scheme: scheme, host: host, port: url.port, ownOrigin: ownOrigin) {
            return isMainFrame == true ? .allow : .cancel
        }
        guard navigationType == .linkActivated, scheme == "http" || scheme == "https", isMainFrame != false else { return .cancel }
        return .openExternal
    }

    private static func isOwnOrigin(scheme: String, host: String, port: Int?, ownOrigin: String) -> Bool {
        guard let own = URLComponents(string: ownOrigin) else { return false }
        return scheme == own.scheme && host == own.host && port == own.port
    }
}
