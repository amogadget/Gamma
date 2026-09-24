import SwiftUI
import WebKit
import UIKit

public struct GammaWebOpenRequest: Equatable, Sendable {
    public let pageID: String
    public let docID: String
    public let title: String
    public let user: String
    /// The library the Web tab was working in. Verified against the live session
    /// before it is used; a handoff may not aim the native editor at another one.
    public let workspace: String
    public let viewport: GammaReadingPosition?

    public init(pageID: String, docID: String, title: String, user: String, workspace: String,
                viewport: GammaReadingPosition? = nil) {
        self.pageID = pageID; self.docID = docID; self.title = title; self.user = user; self.workspace = workspace
        self.viewport = viewport
    }
}

@MainActor
public final class GammaWebCommandController: ObservableObject {
    fileprivate weak var target: GammaWebViewController?
    private var attachmentCancellation = UUID()
    func attach(_ controller: GammaWebViewController) {
        if target !== controller {
            if target != nil { attachmentCancellation = UUID() }
            target?.invalidate()
        }
        target = controller
    }
    @Published public private(set) var lastFailure: String?
    public init() {}
    public func restorePosition(request: GammaWebOpenRequest, serverURL: URL, reload: Bool = false) async -> Bool {
        guard let target = await attachedTarget(serverURL: serverURL, workspace: request.workspace),
              target.permitsAccount(request.user),
              let viewport = request.viewport,
              [request.user, request.workspace, request.pageID, request.docID].allSatisfy({ GammaWebMessageValidator.bounded($0) != nil })
        else { lastFailure = "unavailable"; return false }
        guard let wireOrigin = target.trustedWireOrigin(serverURL) else { lastFailure = "unavailable"; return false }
        let payload: [String: Any] = ["server": wireOrigin, "user": request.user,
            "workspace": request.workspace, "pageID": request.pageID, "docID": request.docID,
            "requestID": UUID().uuidString, "viewport": ["pageIndex": viewport.pageIndex,
                "anchorX": viewport.anchorX, "anchorY": viewport.anchorY]]
        let result = await target.command("restorePosition", payload: payload, reload: reload)
        lastFailure = result.reason; return result.ok
    }
    private func attachedTarget(serverURL: URL, workspace: String) async -> GammaWebViewController? {
        // SwiftUI may create the WK controller on the next update after a native
        // return has just created webSession. Never fail that normal mount race,
        // or send a restore to an invalidated controller from an old library.
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(3))
        let epoch = attachmentCancellation
        while !Task.isCancelled && attachmentCancellation == epoch && clock.now < deadline {
            if let target, target.commandReady,
               target.matches(serverURL: serverURL, workspace: workspace) {
                return target
            }
            do { try await Task.sleep(for: .milliseconds(40)) } catch { return nil }
        }
        return nil
    }
    public var lastError: String? { lastFailure }
    public func prepareDisconnect() async -> GammaWebDisconnectResult {
        guard let target else { lastFailure = "unavailable"; return .init(ok: false, reason: "unavailable") }
        let result = await target.command("prepareDisconnect", payload: ["requestID": UUID().uuidString])
        lastFailure = result.reason
        return result
    }
    public func cancelDisconnect() async { _ = await perform("cancelDisconnect") }
    private func perform(_ method: String) async -> Bool {
        guard let target else { lastFailure = "unavailable"; return false }
        let result = await target.command(method, payload: [:])
        lastFailure = result.reason; return result.ok
    }
    public func detach() {
        attachmentCancellation = UUID()
        target?.invalidate(); target = nil
    }
}

@MainActor
public struct GammaWebWorkspace: UIViewControllerRepresentable {
    /// Server root; `workspace` is appended as `?ws=` so the Web app boots into the
    /// library the native side holds.
    public let serverURL: URL
    public let workspace: String
    public let cookies: [HTTPCookie]
    public let localServerAccess: GammaLocalServerAccess?
    public let sessionID: UUID
    public let reloadToken: UUID?
    public let commandController: GammaWebCommandController?
    public let onOpenPDF: (GammaWebOpenRequest, [HTTPCookie]) -> Void
    public let onError: (String) -> Void

    public init(serverURL: URL, workspace: String, cookies: [HTTPCookie], sessionID: UUID, reloadToken: UUID? = nil,
                commandController: GammaWebCommandController? = nil,
                localServerAccess: GammaLocalServerAccess? = nil,
                onOpenPDF: @escaping (GammaWebOpenRequest, [HTTPCookie]) -> Void,
                onError: @escaping (String) -> Void) {
        self.serverURL = serverURL; self.workspace = workspace; self.cookies = cookies
        self.sessionID = sessionID; self.reloadToken = reloadToken
        self.commandController = commandController
        self.localServerAccess = localServerAccess
        self.onOpenPDF = onOpenPDF; self.onError = onError
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }
    public func makeUIViewController(context: Context) -> GammaWebViewController {
        let controller = GammaWebViewController(configuration: context.coordinator.configuration,
                               serverURL: serverURL, workspace: workspace, cookies: cookies, reloadToken: reloadToken,
                               localServerAccess: localServerAccess, onOpenPDF: onOpenPDF, onError: onError)
        commandController?.attach(controller)
        return controller
    }
    public func updateUIViewController(_ controller: GammaWebViewController, context: Context) {
        guard controller.hasLocalEpoch(localServerAccess?.epoch) else {
            controller.invalidate()
            onError("Local Gamma session changed; reopen the workspace.")
            return
        }
        commandController?.attach(controller)
        controller.reloadIfNeeded(reloadToken)
    }

    public static func dismantleUIViewController(_ controller: GammaWebViewController, coordinator: Coordinator) {
        controller.invalidate()
    }

    /// Main-actor isolated, like the weak message handler below and like this
    /// struct itself: `WKWebViewConfiguration`, its `websiteDataStore` and its
    /// `userContentController` are all main-actor API, and building them from a
    /// nonisolated `init` is exactly what Xcode 26 now warns about.
    @MainActor
    public final class Coordinator: NSObject {
        fileprivate let configuration: WKWebViewConfiguration
        init(_ parent: GammaWebWorkspace) {
            configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let script = WKUserScript(source: "window.__GAMMA_IPAD__ = true;",
                                      injectionTime: .atDocumentStart, forMainFrameOnly: true)
            configuration.userContentController.addUserScript(script)
            super.init()
        }
    }
}

@MainActor
public final class GammaWebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
                                            WKScriptMessageHandler, WKDownloadDelegate {
    let webView: WKWebView
    private let serverURL: URL
    private let workspace: String
    private let startURL: URL
    private let origin: GammaWebOrigin
    private let localServerAccess: GammaLocalServerAccess?
    private var bootScript: String {
        let base = "window.__GAMMA_IPAD__ = true;"
        guard let access = localServerAccess else { return base }
        return base + " window.__GAMMA_LOCAL_ORIGIN__ = 'http://127.0.0.1:\(access.baseURL.port!)';"
    }
    fileprivate func matches(serverURL: URL, workspace: String) -> Bool {
        guard origin.isValidURL(serverURL), self.workspace == workspace else { return false }
        if let access = localServerAccess {
            return serverURL == self.serverURL && self.serverURL == access.baseURL && workspace == access.workspace
        }
        return origin == GammaWebOrigin(url: serverURL)
    }
    fileprivate func hasLocalEpoch(_ epoch: UUID?) -> Bool { localServerAccess?.epoch == epoch }
    fileprivate func permitsAccount(_ account: String) -> Bool {
        localServerAccess.map { $0.account == account } ?? true
    }
    fileprivate func trustedWireOrigin(_ url: URL) -> String? {
        guard matches(serverURL: url, workspace: workspace) else { return nil }
        return origin.trustedWireOrigin(url)
    }
    private let onOpenPDF: (GammaWebOpenRequest, [HTTPCookie]) -> Void
    private let onError: (String) -> Void
    private var reloadToken: UUID?
    private var pendingDownloads: [ObjectIdentifier: URL] = [:]
    private var didStart = false
    private var invalidated = false
    private var generation = UUID()
    private var commands: [UUID: (GammaWebDisconnectResult) -> Void] = [:]
    private var afterReload: (() -> Void)?
    private var commandReload = false
    fileprivate var commandOrigin: GammaWebOrigin { origin }
    fileprivate var commandWorkspace: String { workspace }
    fileprivate var commandReady: Bool {
        guard !invalidated, !webView.isLoading, let url = webView.url else { return false }
        return origin.isValidURL(url)
    }

    fileprivate func cancelCommands(reason: String) {
        generation = UUID()
        afterReload = nil
        commandReload = false
        resetBootScript()
        for id in commands.keys { cancelJavaScriptCommand(id) }
        let callbacks = Array(commands.values); commands.removeAll()
        callbacks.forEach { $0(.init(ok: false, reason: reason)) }
    }

    private func cancelJavaScriptCommand(_ id: UUID) {
        guard let url = webView.url, origin.isValidURL(url) else { return }
        webView.callAsyncJavaScript("window.__GAMMA_NATIVE_CANCELLED_REQUEST__ = token; if (window.__GAMMA_NATIVE_COMMAND_TOKEN__ === token) window.__GAMMA_NATIVE_COMMAND_TOKEN__ = null;",
            arguments: ["token": id.uuidString], in: nil, in: .page, completionHandler: nil)
    }

    func command(_ method: String, payload: [String: Any], reload: Bool = false) async -> GammaWebDisconnectResult {
        guard !invalidated, let url = webView.url, origin.isValidURL(url) else { return .init(ok: false, reason: "unavailable") }
        let id = UUID()
        var payload = payload
        // The boot invocation and Promise invocation share a cancellation identity.
        if method == "restorePosition" { payload["requestID"] = id.uuidString }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: .init(ok: false, reason: "cancelled")); return }
                // Only one transition may own the web surface at a time.
                cancelCommands(reason: "superseded")
                let epoch = generation
                let timeout = DispatchWorkItem { [weak self] in
                    guard let self, let done = self.commands.removeValue(forKey: id) else { return }
                    self.afterReload = nil
                    self.cancelJavaScriptCommand(id)
                    self.resetBootScript()
                    done(.init(ok: false, reason: "timeout"))
                }
                commands[id] = { result in timeout.cancel(); continuation.resume(returning: result) }
                // Restore includes authenticated navigation plus the Web viewer's
                // bounded 15-second layout wait; disconnect has a shorter budget.
                DispatchQueue.main.asyncAfter(deadline: .now() + (method == "restorePosition" ? 35 : 18), execute: timeout)
                let execute: () -> Void = { [weak self] in
                    guard let self, self.generation == epoch, !self.invalidated,
                          let url = self.webView.url, self.origin.isValidURL(url) else { return }
                    self.webView.callAsyncJavaScript("""
                        if (window !== window.top || location.origin !== new URL(expectedOrigin).origin) return {ok:false,reason:'origin'};
                        window.__GAMMA_NATIVE_COMMAND_TOKEN__ = token;
                        const deadline = Date.now() + 8000;
                        const active = () => window.__GAMMA_NATIVE_COMMAND_TOKEN__ === token;
                        // Readiness events wake immediately. A bounded timer also handles
                        // already-installed controls whose React identity is not ready yet.
                        const wait = () => new Promise(resolve => {
                            let timer;
                            const done = () => { clearTimeout(timer); window.removeEventListener('gamma:native-control-ready', done); resolve(); };
                            window.addEventListener('gamma:native-control-ready', done, {once:true});
                            timer = setTimeout(done, Math.max(0, Math.min(100, deadline - Date.now())));
                        });
                        while (active()) {
                            const control = window.__GAMMA_NATIVE_CONTROL__;
                            if (!control || control.version !== 1 || typeof control[method] !== 'function') {
                                if (waitForBoot && Date.now() < deadline) { await wait(); continue; }
                                return {ok:false,reason:'unsupported'};
                            }
                            const result = await control[method](payload);
                            if (!active()) return {ok:false,reason:'cancelled'};
                            if (method === 'restorePosition' && result?.ok === false && result.reason === 'not-ready' && Date.now() < deadline) {
                                await wait(); continue;
                            }
                            return result;
                        }
                        return {ok:false,reason:'cancelled'};
                        """, arguments: ["method": method, "payload": payload, "waitForBoot": reload, "token": id.uuidString,
                            "expectedOrigin": URLComponents(url: self.serverURL, resolvingAgainstBaseURL: false).map { components in
                                var base = components; base.path = ""; base.query = nil; base.fragment = nil
                                return base.string ?? ""
                            } ?? ""], in: nil, in: .page) { [weak self] result in
                        guard let self, self.generation == epoch, let done = self.commands.removeValue(forKey: id) else { return }
                        switch result {
                        case .success(let value):
                            let response = GammaWebCommandResult.parse(value)
                            done(.init(ok: response.ok, reason: response.reason, recovery: response.recovery))
                        case .failure: done(.init(ok: false, reason: "javascript"))
                        }
                    }
                }
                if reload {
                    // JSON serialization, not raw payload interpolation. Install at document start,
                    // before React's reading-position effects can win the startup race.
                    guard let data = try? JSONSerialization.data(withJSONObject: payload),
                          let json = String(data: data, encoding: .utf8) else {
                        commands.removeValue(forKey: id)?(.init(ok: false, reason: "payload")); return
                    }
                    let scripts = webView.configuration.userContentController
                    scripts.removeAllUserScripts()
                    scripts.addUserScript(WKUserScript(source: bootScript + " window.__GAMMA_NATIVE_RETURN__ = " + json + ";", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                    afterReload = execute
                    commandReload = true
                    webView.reload()
                } else { execute() }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                guard let self, let done = self.commands.removeValue(forKey: id) else { return }
                self.afterReload = nil; self.cancelJavaScriptCommand(id); self.resetBootScript()
                done(.init(ok: false, reason: "cancelled"))
            }
        }
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if commandReload { commandReload = false }
        else { cancelCommands(reason: "navigation") }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let execute = afterReload; afterReload = nil; execute?()
        resetBootScript()
    }

    private func resetBootScript() {
        // Pending boot data is one-navigation-only, never a permanent restore loop.
        let scripts = webView.configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: bootScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { cancelCommands(reason: "terminated") }

    init(configuration: WKWebViewConfiguration, serverURL: URL, workspace: String, cookies: [HTTPCookie], reloadToken: UUID?,
         localServerAccess: GammaLocalServerAccess? = nil,
         onOpenPDF: @escaping (GammaWebOpenRequest, [HTTPCookie]) -> Void,
         onError: @escaping (String) -> Void) {
        self.serverURL = serverURL
        self.workspace = workspace
        // `?ws=` is how the Web app itself names its library (the fetch wrapper
        // then sends X-Gamma-Workspace for it), so the tab and the native side are
        // pinned to the same one from the first paint.
        self.startURL = GammaWebSession.startURL(serverURL: serverURL, workspace: workspace)
        self.localServerAccess = localServerAccess
        self.origin = localServerAccess.map { GammaWebOrigin(access: $0) } ?? GammaWebOrigin(url: serverURL)
        self.onOpenPDF = onOpenPDF; self.onError = onError
        self.reloadToken = reloadToken
        self.cookies = localServerAccess?.cookies ?? cookies
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.configuration.userContentController.add(GammaWeakWebMessageHandler(target: self), name: "gammaNative")
        webView.isInspectable = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView.configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    }

    private let cookies: [HTTPCookie]
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    public override func loadView() { view = UIView(); view.backgroundColor = .systemBackground; view.addSubview(webView)
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: view.leadingAnchor), webView.trailingAnchor.constraint(equalTo: view.trailingAnchor), webView.topAnchor.constraint(equalTo: view.topAnchor), webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)]) }
    public override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); startIfNeeded() }

    func invalidate() {
        guard !invalidated else { return }
        invalidated = true
        cancelCommands(reason: "detached")
        webView.stopLoading()
        webView.navigationDelegate = nil; webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "gammaNative")
        // Each controller owns a nonpersistent store. On logout/replacement,
        // discard that controller's cookies without affecting the new session.
        let store = webView.configuration.websiteDataStore.httpCookieStore
        store.getAllCookies { cookies in
            for cookie in cookies { store.delete(cookie) }
        }
    }

    /// Reloads the existing web view only; its non-persistent store and cookies remain intact.
    func reloadIfNeeded(_ token: UUID?) {
        guard !invalidated, token != reloadToken else { return }
        reloadToken = token
        guard didStart else { return }
        webView.reload()
    }

    private func startIfNeeded() {
        guard !invalidated, !didStart else { return }; didStart = true
        guard matches(serverURL: serverURL, workspace: workspace) else {
            onError("Invalid Gamma server identity."); return
        }
        resetBootScript()
        guard let access = localServerAccess else { installCookiesAndLoad(); return }
        // Cookies have host but no port scope. Block every off-origin resource,
        // not just top-frame navigation, before installing either credential.
        // WebKit content blockers use a restricted regex grammar (no alternation).
        let authority = "127\\.0\\.0\\.1:\(access.baseURL.port!)/"
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
            ["trigger": ["url-filter": "^http://" + authority], "action": ["type": "ignore-previous-rules"]],
            ["trigger": ["url-filter": "^ws://" + authority], "action": ["type": "ignore-previous-rules"]],
            ["trigger": ["url-filter": "^data:"], "action": ["type": "ignore-previous-rules"]],
            ["trigger": ["url-filter": "^blob:http://" + NSRegularExpression.escapedPattern(for: "127.0.0.1:\(access.baseURL.port!)/")],
             "action": ["type": "ignore-previous-rules"]]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
              let json = String(data: data, encoding: .utf8) else { return }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "gamma-local-" + access.epoch.uuidString,
            encodedContentRuleList: json) { [weak self] list, _ in
                DispatchQueue.main.async {
                    guard let self, !self.invalidated else { return }
                    guard let list else { self.onError("Could not isolate local Gamma transport."); return }
                    self.webView.configuration.userContentController.add(list)
                    self.installCookiesAndLoad()
                }
            }
    }

    private func installCookiesAndLoad() {
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let group = DispatchGroup()
        for cookie in cookies { group.enter(); store.setCookie(cookie) { group.leave() } }
        group.notify(queue: .main) { [weak self] in
            guard let self, !self.invalidated else { return }
            guard self.origin.isValidURL(self.startURL), self.origin.isValidURL(self.serverURL) else {
                self.onError("Invalid Gamma server URL."); return
            }
            if let access = self.localServerAccess {
                guard let request = access.authorize(URLRequest(url: self.startURL)) else { return }
                self.webView.load(request)
            } else {
                self.webView.load(URLRequest(url: self.startURL))
            }
        }
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let security = message.frameInfo.securityOrigin
        let effectivePort = security.port == 0 ? GammaWebOrigin.defaultPort(for: security.protocol.lowercased()) : security.port
        guard security.protocol.lowercased() == origin.scheme, security.host.lowercased() == origin.host, effectivePort == origin.port,
              message.name == "gammaNative", let frame = message.frameInfo.request.url,
              message.frameInfo.isMainFrame, origin.isValidURL(frame),
              let request = GammaWebMessageValidator.openPDF(from: message.body) else { return }
        if localServerAccess != nil {
            // Workspace membership and document identity are verified by the
            // coordinator before an alternate local workspace is committed.
            guard !invalidated, permitsAccount(request.user),
                  let url = webView.url, origin.isValidURL(url) else { return }
            onOpenPDF(request, [])
            return
        }
        let epoch = generation
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            DispatchQueue.main.async {
                guard let self, !self.invalidated, self.generation == epoch,
                      let url = self.webView.url, self.origin.isValidURL(url) else { return }
                self.onOpenPDF(request, cookies)
            }
        }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        cancelCommands(reason: "navigation-failed")
        if (error as NSError).code != NSURLErrorCancelled { onError("Gamma Web could not load: \(error.localizedDescription)") }
    }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onError(error.localizedDescription) }
    }

    /// Only genuine link activations escape a local view. Script-only popups
    /// (including some OAuth flows) remain blocked until a user gesture can be
    /// verified; the ordinary external link path opens Safari without WK cookies.
    private func openExternalLink(_ action: WKNavigationAction) {
        guard let url = action.request.url else { return }
        if let access = localServerAccess {
            guard !invalidated, action.navigationType == .linkActivated,
                  action.sourceFrame.isMainFrame,
                  let source = action.sourceFrame.request.url, origin.isValidURL(source),
                  access.permitsExternalBrowserURL(url) else { return }
        } else {
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        }
        UIApplication.shared.open(url)
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if origin.isValidURL(url) { webView.load(navigationAction.request) }
        else { openExternalLink(navigationAction) }
        return nil
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if origin.isValidURL(url) { decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow); return }
        // Blob exports are generated by same-origin pages; permit only that narrow case.
        if url.scheme?.lowercased() == "blob",
           let source = navigationAction.sourceFrame.request.url, origin.isValidURL(source) {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow); return
        }
        openExternalLink(navigationAction)
        decisionHandler(.cancel)
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if localServerAccess != nil {
            guard let url = navigationResponse.response.url else { decisionHandler(.cancel); return }
            let blobOrigin = url.scheme == "blob" ? URL(string: String(url.absoluteString.dropFirst(5))) : nil
            guard origin.isValidURL(url) || blobOrigin.map({ origin.isValidURL($0) }) == true else {
                decisionHandler(.cancel); return
            }
        }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if navigationResponse.canShowMIMEType && !disposition.lowercased().contains("attachment") { decisionHandler(.allow) }
        else { decisionHandler(.download) }
    }
    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                        didBecome download: WKDownload) { download.delegate = self }
    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                        didBecome download: WKDownload) { download.delegate = self }

    public func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                         newRequest request: URLRequest,
                         decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let url = request.url, origin.isValidURL(url) else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    public func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                         suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let base = GammaWebFile.safeBasename(suggestedFilename)
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + base)
        pendingDownloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }
    public func downloadDidFinish(_ download: WKDownload) {
        guard let url = pendingDownloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url) }
        if let pop = share.popoverPresentationController { pop.sourceView = view; pop.sourceRect = view.bounds }
        present(share, animated: true)
    }
    public func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = pendingDownloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url) }
        onError(error.localizedDescription)
    }

    public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, let url = frame.request.url, origin.isValidURL(url) else { completionHandler(); return }
        presentJavaScript(title: origin.host, message: message, actions: [("OK", .default, { completionHandler() })])
    }
    public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, let url = frame.request.url, origin.isValidURL(url) else { completionHandler(false); return }
        presentJavaScript(title: origin.host, message: message, actions: [("Cancel", .cancel, { completionHandler(false) }), ("OK", .default, { completionHandler(true) })])
    }
    public func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                        defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping (String?) -> Void) {
        guard frame.isMainFrame, let url = frame.request.url, origin.isValidURL(url), presentedViewController == nil else { completionHandler(nil); return }
        let alert = UIAlertController(title: origin.host, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
    private func presentJavaScript(title: String?, message: String, actions: [(String, UIAlertAction.Style, () -> Void)]) {
        guard presentedViewController == nil else { actions.first?.2(); return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        actions.forEach { title, style, handler in alert.addAction(UIAlertAction(title: title, style: style) { _ in handler() }) }
        present(alert, animated: true)
    }
}

@MainActor
private final class GammaWeakWebMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: GammaWebViewController?
    init(target: GammaWebViewController) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

private enum GammaWebFile {
    static func safeBasename(_ name: String) -> String {
        let clean = name.replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: "/", with: "_")
            .filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" }
        return String(clean.prefix(160)).isEmpty ? "download" : String(clean.prefix(160))
    }
}
