import AppKit
import WebKit
import SwiftUI

enum PageState: Equatable { case loading, ready, unavailable }

@MainActor final class CompanionWeb: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let descriptor: ServiceDescriptor
    let bridge: NativeBridge?
    func focusConversation() {
        guard let window = webView.window else { return }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
    }
    /// A web-requested external open. It reuses the same U2 policy as a clicked link, so a foreign
    /// http(s) URL opens in the system browser and a same-origin or unsafe URL is ignored.
    func openExternal(_ urlString: String) {
        guard let url = URL(string: urlString),
              ExternalLinkPolicy.decide(url: url, navigationType: .linkActivated, isMainFrame: true, ownOrigin: descriptor.origin) == .openExternal
        else { return }
        NSWorkspace.shared.open(url)
    }
    /// Keeps the web view's under-page colour with the window when the web changes theme.
    func applyTheme(_ theme: BridgeTheme) { webView.underPageBackgroundColor = theme.backgroundColor }
    let webView: WKWebView
    @Published private(set) var state: PageState = .unavailable
    @Published private(set) var detail = "Connect to the approved service."
    private(set) var deniedNavigations = 0
    private(set) var deniedPopups = 0
    static let loadTimeout: TimeInterval = 5
    private var deadline: Task<Void, Never>?
    private var attempt = 0
    private var approvedResponse = false
    private(set) var proofNavigationStarts = 0
    private(set) var proofNavigationFinishes = 0
    private(set) var proofNavigationFailureCode: Int?
    private(set) var proofMainFrameHTTPStatus: Int?
    private var activeNavigation: WKNavigation?
    #if COMPANION_TEST
    private let diagnosticStart = Date()
    private(set) var diagnosticEvents: [String] = []
    #endif
    private func trace(_ event: String) {
        #if COMPANION_TEST
        let line = "\(event) t=\(String(format: "%.3f", Date().timeIntervalSince(diagnosticStart))) state=\(state)"
        diagnosticEvents.append(line)
        print("COMPANION-WK \(line)")
        #endif
    }
    init(descriptor: ServiceDescriptor, bridge: NativeBridge? = nil) {
        self.descriptor = descriptor
        self.bridge = bridge
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = WKUserContentController() // Deliberately zero handlers/scripts.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        // Dark before first paint: no white flash while the page loads.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = BridgeTheme.dark.backgroundColor
        if let bridge {
            webView.configuration.userContentController.add(self, name: "didi")
            bridge.sendJS = { [weak self] script in self?.webView.evaluateJavaScript(script, completionHandler: nil) }
        }
    }

    // Native side of BRIDGE.md: decode the web's didi messages, never act on them here.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "didi" else { return }
        bridge?.handle(message.body)
    }
    private func startDeadline() {
        deadline?.cancel()
        let current = attempt
        trace("deadline-armed-5s")
        deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(Self.loadTimeout * 1_000_000_000)) }
            catch { self?.trace("deadline-cancelled"); return }
            guard let self, self.attempt == current, self.state == .loading else { return }
            self.trace("deadline-expired")
            self.fail("Service did not deliver an approved page within five seconds. Retry explicitly.")
        }
    }
    func load(cookie: HTTPCookie) async {
        attempt += 1
        let current = attempt
        activeNavigation = nil; approvedResponse = false
        webView.stopLoading()
        state = .loading; detail = "Connecting to shared UI…"
        trace("load-start")
        // Deadline owns the entire attempt, including asynchronous cookie preparation.
        startDeadline()
        await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        guard attempt == current, state == .loading else { return }
        trace("cookie-installed")
        var request = URLRequest(url: descriptor.baseURL.appendingPathComponent("/"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        activeNavigation = webView.load(request)
        if activeNavigation == nil { fail("Service navigation could not start. Retry explicitly.") }
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
        trace("fail")
        attempt += 1; activeNavigation = nil; approvedResponse = false
        deadline?.cancel(); deadline = nil; webView.stopLoading()
        state = .unavailable; detail = message
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let decision = ExternalLinkPolicy.decide(url: action.request.url, navigationType: action.navigationType,
                                                 isMainFrame: action.targetFrame?.isMainFrame, ownOrigin: descriptor.origin)
        var allowed = false
        switch decision {
        case .allow:
            allowed = action.sourceFrame.isMainFrame && action.request.httpMethod == "GET" &&
                descriptor.page(action.request.url) && !action.shouldPerformDownload
        case .openExternal:
            // Only a user-activated link, never a programmatic navigation, reaches here.
            if action.sourceFrame.isMainFrame, let url = action.request.url { NSWorkspace.shared.open(url) }
        case .cancel:
            allowed = false
        }
        if !allowed { deniedNavigations += 1 }
        trace("action-\(allowed ? "allow" : "deny")")
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = response.response as? HTTPURLResponse
        if response.isForMainFrame { proofMainFrameHTTPStatus = http?.statusCode }
        trace("response-\(http?.statusCode ?? 0)")
        let allowed = response.isForMainFrame && descriptor.page(response.response.url) && response.canShowMIMEType &&
            response.response.mimeType == "text/html" && http?.statusCode == 200 &&
            http?.value(forHTTPHeaderField: "Content-Disposition") == nil
        if !allowed { deniedNavigations += 1; fail("Service page response refused. Reconnect explicitly.") }
        else { approvedResponse = true }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        fail("Unexpected service redirect refused. Reconnect explicitly.")
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        proofNavigationStarts += 1
        if state == .ready {
            // A reload is a fresh page: hold outbound messages until it posts ready again.
            bridge?.markReload()
            attempt += 1; approvedResponse = false; activeNavigation = navigation
            state = .loading
            startDeadline()
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        proofNavigationFinishes += 1
        trace("did-finish-approved-\(approvedResponse)-page-\(descriptor.page(webView.url))")
        guard state == .loading, navigation === activeNavigation else { return }
        guard approvedResponse, descriptor.page(webView.url) else {
            // WebKit can finish an internal error document (e.g. a prohibited port)
            // without delivering an HTTP response. That is not a successful UI load.
            fail("Service did not deliver the approved page. Retry explicitly.")
            return
        }
        deadline?.cancel(); deadline = nil
        webView.isHidden = false; state = .ready; detail = "Shared service UI"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        proofNavigationFailureCode = (error as NSError).code
        trace("provisional-error-\((error as NSError).domain)-\((error as NSError).code)")
        // Cancelled hostile navigations do not replace a valid current page with an error screen.
        if state == .loading, navigation === activeNavigation { fail("Service unavailable. Your draft is retained; retry explicitly.") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        proofNavigationFailureCode = (error as NSError).code
        trace("committed-error-\((error as NSError).domain)-\((error as NSError).code)")
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
