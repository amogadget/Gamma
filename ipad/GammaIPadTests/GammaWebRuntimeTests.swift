import XCTest
import WebKit
@testable import GammaIPad

@MainActor
private final class LoadedPage: NSObject, WKNavigationDelegate {
    let loaded: XCTestExpectation
    init(_ loaded: XCTestExpectation) { self.loaded = loaded }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded.fulfill() }
}

final class GammaWebRuntimeTests: XCTestCase {
    @MainActor
    func testDeployedGammaLoadsInActualWKWebView() async throws {
#if GAMMA_DEPLOYMENT_SMOKE
        let server = URL(string: "https://annotation.amogadgetlab.com")!
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source: "window.__GAMMA_IPAD__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let controller = GammaWebViewController(configuration: configuration, serverURL: server, cookies: [], reloadToken: nil,
            onOpenPDF: { _, _ in XCTFail("No native handoff expected on the login page") }, onError: { XCTFail($0) })
        defer { controller.invalidate() }
        controller.loadViewIfNeeded()
        let loaded = expectation(description: "Live Gamma Web loaded")
        let delegate = LoadedPage(loaded); controller.webView.navigationDelegate = delegate
        controller.webView.load(URLRequest(url: server))
        await fulfillment(of: [loaded], timeout: 30)
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !controller.webView.isLoading }, object: nil)
        await fulfillment(of: [ready], timeout: 10)
        try await Task.sleep(for: .seconds(1)) // allow the React session check to complete
        let text = try await controller.webView.evaluateJavaScript("document.body.innerText") as? String ?? ""
        XCTAssertTrue(text.contains("Gamma"), text)
        let bridge = try await controller.webView.evaluateJavaScript("window.__GAMMA_IPAD__ === true && !!window.webkit.messageHandlers.gammaNative") as? Bool
        XCTAssertEqual(bridge, true)
#else
        throw XCTSkip("Opt-in readonly HTTPS deployment smoke test")
#endif
    }
    @MainActor
    func testRealWebKitBridgeAcceptsMainFrameAndIgnoresEmbeddedFrame() async throws {
        let origin = URL(string: "https://gamma.example/")!
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let callback = expectation(description: "Native PDF handoff")
        callback.assertForOverFulfill = true
        var received: [GammaWebOpenRequest] = []
        let controller = GammaWebViewController(configuration: config, serverURL: origin, cookies: [], reloadToken: nil,
            onOpenPDF: { request, _ in received.append(request); callback.fulfill() }, onError: { XCTFail($0) })
        defer { controller.invalidate() }
        controller.loadViewIfNeeded()
        let loaded = expectation(description: "Fixture loaded")
        let delegate = LoadedPage(loaded)
        controller.webView.navigationDelegate = delegate
        controller.webView.loadHTMLString("<html><body><h1>Gamma editor fixture</h1><iframe srcdoc='<p>frame</p>'></iframe></body></html>", baseURL: origin)
        await fulfillment(of: [loaded], timeout: 15)
        let json = #"{type:'openPDF',pageID:'page',docID:'doc',title:'Paper',user:'alice'}"#
        _ = try await controller.webView.evaluateJavaScript("window.frames[0].webkit?.messageHandlers?.gammaNative?.postMessage(\(json)); true")
        _ = try await controller.webView.evaluateJavaScript("window.webkit.messageHandlers.gammaNative.postMessage(\(json)); true")
        await fulfillment(of: [callback], timeout: 10)
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first?.pageID, "page")
        XCTAssertFalse(config.websiteDataStore.isPersistent)
    }
}
