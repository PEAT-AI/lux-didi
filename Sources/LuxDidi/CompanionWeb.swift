import AppKit
import WebKit
import SwiftUI

enum PageState: Equatable { case loading, ready, unavailable }

@MainActor final class CompanionWeb: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let descriptor: ServiceDescriptor
    let webView: WKWebView
    @Published private(set) var state: PageState = .unavailable
    @Published private(set) var detail = "Connect to the approved service."
    private(set) var deniedNavigations = 0
    private(set) var deniedPopups = 0
    private var deadline: Task<Void, Never>?
    init(descriptor: ServiceDescriptor) {
        self.descriptor = descriptor
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = WKUserContentController() // Deliberately zero handlers/scripts.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserAction = .all
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
    }
    func load(cookie: HTTPCookie) async {
        deadline?.cancel(); webView.stopLoading()
        state = .loading; detail = "Connecting to shared UI…"
        await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        var request = URLRequest(url: descriptor.baseURL.appendingPathComponent("/"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        webView.load(request)
        deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 12_000_000_000) } catch { return }
            self?.fail("Service did not finish loading. Retry explicitly.")
        }
    }
    func clear() {
        fail("Disconnected. Reconnect explicitly.")
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            for cookie in cookies { self.webView.configuration.websiteDataStore.httpCookieStore.delete(cookie) }
        }
        // Do not leave private page content visible after logout.
        webView.isHidden = true
    }
    private func fail(_ message: String) {
        deadline?.cancel(); deadline = nil; webView.stopLoading()
        state = .unavailable; detail = message
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = action.targetFrame?.isMainFrame == true && action.sourceFrame.isMainFrame &&
            action.request.httpMethod == "GET" && descriptor.page(action.request.url) && !action.shouldPerformDownload
        if !allowed { deniedNavigations += 1 }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = response.response as? HTTPURLResponse
        let allowed = response.isForMainFrame && descriptor.page(response.response.url) && response.canShowMIMEType &&
            response.response.mimeType == "text/html" && http?.statusCode == 200 &&
            http?.value(forHTTPHeaderField: "Content-Disposition") == nil
        if !allowed { deniedNavigations += 1; fail("Service page response refused. Reconnect explicitly.") }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        fail("Unexpected service redirect refused. Reconnect explicitly.")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard descriptor.page(webView.url), state == .loading else { return }
        deadline?.cancel(); deadline = nil
        webView.isHidden = false; state = .ready; detail = "Shared service UI"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Cancelled hostile navigations do not replace a valid current page with an error screen.
        if state == .loading { fail("Service unavailable. Your draft is retained; retry explicitly.") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("Shared page failed. Your draft is retained; retry explicitly.")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { simulateTermination() }
    func simulateTermination() { fail("Web content stopped. Reconnect explicitly to recover the current service session.") }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        deniedPopups += 1
        return nil
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}

struct SharedServiceView: NSViewRepresentable {
    let shell: CompanionWeb
    func makeNSView(context: Context) -> WKWebView { shell.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct SharedServicePanel: View {
    @ObservedObject var shell: CompanionWeb
    let reconnect: () -> Void
    var body: some View {
        ZStack {
            SharedServiceView(shell: shell).opacity(shell.state == .ready ? 1 : 0)
            if shell.state != .ready {
                VStack(spacing: 16) {
                    Text(shell.state == .loading ? "Connecting…" : "Didi service unavailable").font(.title2)
                    Text(shell.detail).multilineTextAlignment(.center)
                    if shell.state != .loading { Button("Reconnect", action: reconnect) }
                }.padding(32)
            }
        }
    }
}
