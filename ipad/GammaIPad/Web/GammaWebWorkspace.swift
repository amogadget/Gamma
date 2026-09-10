import SwiftUI
import WebKit
import UIKit

public struct GammaWebOpenRequest: Equatable, Sendable {
    public let pageID: String
    public let docID: String
    public let title: String
    public let user: String

    public init(pageID: String, docID: String, title: String, user: String) {
        self.pageID = pageID; self.docID = docID; self.title = title; self.user = user
    }
}

@MainActor
public struct GammaWebWorkspace: UIViewControllerRepresentable {
    public let serverURL: URL
    public let cookies: [HTTPCookie]
    public let sessionID: UUID
    public let reloadToken: UUID?
    public let onOpenPDF: (GammaWebOpenRequest, [HTTPCookie]) -> Void
    public let onError: (String) -> Void

    public init(serverURL: URL, cookies: [HTTPCookie], sessionID: UUID, reloadToken: UUID? = nil,
                onOpenPDF: @escaping (GammaWebOpenRequest, [HTTPCookie]) -> Void,
                onError: @escaping (String) -> Void) {
        self.serverURL = serverURL; self.cookies = cookies; self.sessionID = sessionID; self.reloadToken = reloadToken
        self.onOpenPDF = onOpenPDF; self.onError = onError
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }
    public func makeUIViewController(context: Context) -> GammaWebViewController {
        GammaWebViewController(configuration: context.coordinator.configuration,
                               serverURL: serverURL, cookies: cookies, reloadToken: reloadToken,
                               onOpenPDF: onOpenPDF, onError: onError)
    }
    public func updateUIViewController(_ controller: GammaWebViewController, context: Context) {
        controller.reloadIfNeeded(reloadToken)
    }

    public static func dismantleUIViewController(_ controller: GammaWebViewController, coordinator: Coordinator) {
        controller.invalidate()
    }

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
    private let origin: GammaWebOrigin
    private let onOpenPDF: (GammaWebOpenRequest, [HTTPCookie]) -> Void
    private let onError: (String) -> Void
    private var reloadToken: UUID?
    private var pendingDownloads: [ObjectIdentifier: URL] = [:]
    private var didStart = false

    init(configuration: WKWebViewConfiguration, serverURL: URL, cookies: [HTTPCookie], reloadToken: UUID?,
         onOpenPDF: @escaping (GammaWebOpenRequest, [HTTPCookie]) -> Void,
         onError: @escaping (String) -> Void) {
        self.serverURL = serverURL
        self.origin = GammaWebOrigin(url: serverURL)
        self.onOpenPDF = onOpenPDF; self.onError = onError
        self.reloadToken = reloadToken
        self.cookies = cookies
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
        webView.stopLoading()
        webView.navigationDelegate = nil; webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "gammaNative")
    }

    /// Reloads the existing web view only; its non-persistent store and cookies remain intact.
    func reloadIfNeeded(_ token: UUID?) {
        guard token != reloadToken else { return }
        reloadToken = token
        guard didStart else { return }
        webView.reload()
    }

    private func startIfNeeded() {
        guard !didStart else { return }; didStart = true
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let group = DispatchGroup()
        for cookie in cookies { group.enter(); store.setCookie(cookie) { group.leave() } }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            guard self.origin.isValidURL(self.serverURL) else { self.onError("Invalid Gamma server URL."); return }
            self.webView.load(URLRequest(url: self.serverURL))
        }
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let security = message.frameInfo.securityOrigin
        let effectivePort = security.port == 0 ? GammaWebOrigin.defaultPort(for: security.protocol.lowercased()) : security.port
        guard security.protocol.lowercased() == origin.scheme, security.host.lowercased() == origin.host, effectivePort == origin.port,
              message.name == "gammaNative", let frame = message.frameInfo.request.url,
              message.frameInfo.isMainFrame, origin.isValidURL(frame),
              let request = GammaWebMessageValidator.openPDF(from: message.body) else { return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }; DispatchQueue.main.async { self.onOpenPDF(request, cookies) }
        }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onError("Gamma Web could not load: \(error.localizedDescription)") }
    }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onError(error.localizedDescription) }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if origin.isValidURL(url) { webView.load(navigationAction.request) }
        else if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" { UIApplication.shared.open(url) }
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
        if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            UIApplication.shared.open(url); decisionHandler(.cancel)
        } else { decisionHandler(.cancel) }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if navigationResponse.canShowMIMEType && !disposition.lowercased().contains("attachment") { decisionHandler(.allow) }
        else { decisionHandler(.download) }
    }
    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                        didBecome download: WKDownload) { download.delegate = self }
    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                        didBecome download: WKDownload) { download.delegate = self }

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
