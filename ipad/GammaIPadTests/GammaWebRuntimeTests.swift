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
    func testWireServerOriginOmitsDeploymentPathAndDefaultPort() throws {
        XCTAssertEqual(GammaWebOrigin.wireOrigin(try XCTUnwrap(URL(string: "https://gamma.example:443/deploy/?ws=w#pdf"))), "https://gamma.example")
        XCTAssertEqual(GammaWebOrigin.wireOrigin(try XCTUnwrap(URL(string: "https://gamma.example:8443/deploy/"))), "https://gamma.example:8443")
        let scope = GammaWebOrigin(url: try XCTUnwrap(URL(string: "https://gamma.example/deploy/")))
        XCTAssertFalse(scope.isValidURL(try XCTUnwrap(URL(string: "https://gamma.example/other/"))))
    }

    func testCommandReplyTypesAndRecovery() throws {
        XCTAssertTrue(GammaWebCommandResult.parse(["ok": true]).ok)
        for invalid in ["true", 1, NSNull()] as [Any] {
            XCTAssertEqual(GammaWebCommandResult.parse(["ok": invalid]).reason, "invalid-response")
        }
        let failed = GammaWebCommandResult.parse(["ok": false, "reason": "flush-failed",
            "recovery": ["workspace": "w", "complete": true, "dirtyInk": ["stroke"], "collaboration": ["oldPage": ["ops": ["pending"]]] ]])
        XCTAssertFalse(failed.ok)
        let data = try XCTUnwrap(failed.recovery)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["workspace"] as? String, "w")
        XCTAssertNotNil(object["collaboration"])
        XCTAssertTrue(GammaWebDisconnectResult(ok: false, recovery: data).recoveryComplete)
        for marker in [false, 1, "true", NSNull()] as [Any] {
            let incomplete = try JSONSerialization.data(withJSONObject: ["complete": marker])
            XCTAssertFalse(GammaWebDisconnectResult(ok: false, recovery: incomplete).recoveryComplete)
        }
        XCTAssertFalse(GammaWebDisconnectResult(ok: false).recoveryComplete)
        XCTAssertEqual(GammaWebCommandResult.parse(["ok": false, "recovery": "not-json-object"]).reason, "invalid-recovery")
        XCTAssertEqual(GammaWebCommandResult.parse(["ok": false, "recovery": ["not-an-object"]]).reason, "invalid-recovery")
        XCTAssertEqual(GammaWebCommandResult.parse(["ok": false,
            "recovery": ["draft": String(repeating: "x", count: 32 * 1024 * 1024)]]).reason, "recovery-too-large")
    }

    @MainActor
    func testCommandAwaitsPromiseAndInvalidationCancelsPendingReply() async throws {
        let origin = URL(string: "https://gamma.example/")!
        let controller = GammaWebViewController(configuration: WKWebViewConfiguration(), serverURL: origin,
            workspace: "w", cookies: [], reloadToken: nil, onOpenPDF: { _, _ in }, onError: { _ in })
        defer { controller.invalidate() }
        controller.loadViewIfNeeded()
        let loaded = expectation(description: "Command fixture loaded")
        let delegate = LoadedPage(loaded); controller.webView.navigationDelegate = delegate
        controller.webView.loadHTMLString("<html><body>Gamma</body></html>", baseURL: origin)
        await fulfillment(of: [loaded], timeout: 10)
        _ = try await controller.webView.evaluateJavaScript("""
            window.__GAMMA_NATIVE_CONTROL__ = {version:1,
              prepareDisconnect: async () => { await new Promise(r => setTimeout(r, 25)); return {ok:false,reason:'flush-failed',recovery:{workspace:'w'}}; },
              restorePosition: () => new Promise(() => {})}; true
            """)
        let reply = await controller.command("prepareDisconnect", payload: [:])
        XCTAssertFalse(reply.ok); XCTAssertEqual(reply.reason, "flush-failed"); XCTAssertNotNil(reply.recovery)
        _ = try await controller.webView.evaluateJavaScript("""
            window.restoreCalls = 0;
            window.__GAMMA_NATIVE_CONTROL__.restorePosition = async payload => {
                window.restoreCalls++;
                if (window.restoreCalls === 1) {
                    setTimeout(() => window.dispatchEvent(new Event('gamma:native-control-ready')), 10);
                    return {ok:false, reason:'not-ready'};
                }
                window.receivedPayload = payload;
                return {ok:true};
            }; true
            """)
        let unsafeLookingID = "quote'\\\"; window.injected = true; //"
        let restored = await controller.command("restorePosition", payload: ["pageID": unsafeLookingID])
        XCTAssertTrue(restored.ok)
        let received = try await controller.webView.evaluateJavaScript("window.receivedPayload.pageID") as? String
        XCTAssertEqual(received, unsafeLookingID)
        let injected = try await controller.webView.evaluateJavaScript("window.injected === true") as? Bool
        XCTAssertEqual(injected, false)
        _ = try await controller.webView.evaluateJavaScript("delete window.__GAMMA_NATIVE_CONTROL__; true")
        let unsupported = await controller.command("prepareDisconnect", payload: [:])
        XCTAssertEqual(unsupported.reason, "unsupported")
        _ = try await controller.webView.evaluateJavaScript("window.__GAMMA_NATIVE_CONTROL__ = {version:1, restorePosition: () => new Promise(() => {})}; true")
        let pending = Task { await controller.command("restorePosition", payload: [:]) }
        await Task.yield()
        controller.invalidate()
        let cancelled = await pending.value
        XCTAssertFalse(cancelled.ok)
        XCTAssertTrue(["detached", "unavailable"].contains(cancelled.reason ?? ""))
    }

    @MainActor
    func testReturnWaitsForFreshControllerAttachmentAndPreservesWireOrigin() async throws {
        let origin = URL(string: "https://gamma.example:443/deploy/")!
        let view = GammaWebViewController(configuration: WKWebViewConfiguration(), serverURL: origin,
            workspace: "ws-alpha", cookies: [], reloadToken: nil, onOpenPDF: { _, _ in }, onError: { _ in })
        defer { view.invalidate() }
        view.loadViewIfNeeded()
        let loaded = expectation(description: "Delayed attachment fixture loaded")
        let delegate = LoadedPage(loaded); view.webView.navigationDelegate = delegate
        view.webView.loadHTMLString("<html><body>Gamma</body></html>", baseURL: origin)
        await fulfillment(of: [loaded], timeout: 10)
        _ = try await view.webView.evaluateJavaScript("window.__GAMMA_NATIVE_CONTROL__={version:1,restorePosition:async p=>{window.lastReturn=p;return {ok:true};}}; true")
        let commands = GammaWebCommandController()
        let request = GammaWebOpenRequest(pageID: "page-a", docID: "doc-a", title: "PDF", user: "alice", workspace: "ws-alpha",
            viewport: GammaReadingPosition(pageIndex: 3, anchorX: 0.1, anchorY: 0.625))
        let pending = Task { await commands.restorePosition(request: request, serverURL: origin) }
        try await Task.sleep(for: .milliseconds(80))
        commands.attach(view)
        let restored = await pending.value
        XCTAssertTrue(restored)
        let payload = try await view.webView.evaluateJavaScript("window.lastReturn") as? [String: Any]
        XCTAssertEqual(payload?["server"] as? String, "https://gamma.example")
        XCTAssertEqual((payload?["viewport"] as? [String: Any])?["anchorY"] as? Double, 0.625)
        commands.detach()
    }

    @MainActor
    func testDisconnectedCommandHandleFailsClosedWithoutPDFOrAccount() async {
        let controller = GammaWebCommandController()
        let result = await controller.prepareDisconnect()
        XCTAssertFalse(result.ok); XCTAssertEqual(result.reason, "unavailable")
        controller.detach()
        await controller.cancelDisconnect()
    }

    @MainActor
    func testDeployedGammaLoadsInActualWKWebView() async throws {
#if GAMMA_DEPLOYMENT_SMOKE
        guard let configuredURL = ProcessInfo.processInfo.environment["GAMMA_DEPLOYMENT_URL"],
              let server = URL(string: configuredURL),
              server.scheme?.lowercased() == "https",
              let host = server.host, !host.isEmpty,
              server.user == nil, server.password == nil,
              server.query == nil, server.fragment == nil,
              server.path.isEmpty || server.path == "/" else {
            throw XCTSkip("Set GAMMA_DEPLOYMENT_URL to an explicit HTTPS server origin")
        }
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source: "window.__GAMMA_IPAD__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let controller = GammaWebViewController(configuration: configuration, serverURL: server, workspace: "ws-live",
                                               cookies: [], reloadToken: nil,
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
        let controller = GammaWebViewController(configuration: config, serverURL: origin, workspace: "ws-alpha",
                                                cookies: [], reloadToken: nil,
            onOpenPDF: { request, _ in received.append(request); callback.fulfill() }, onError: { XCTFail($0) })
        defer { controller.invalidate() }
        controller.loadViewIfNeeded()
        let loaded = expectation(description: "Fixture loaded")
        let delegate = LoadedPage(loaded)
        controller.webView.navigationDelegate = delegate
        controller.webView.loadHTMLString("<html><body><h1>Gamma editor fixture</h1><iframe srcdoc='<p>frame</p>'></iframe></body></html>", baseURL: origin)
        await fulfillment(of: [loaded], timeout: 15)
        // The handoff names the library too; a message without one is ignored.
        let json = #"{type:'openPDF',pageID:'page',docID:'doc',title:'Paper',user:'alice',workspace:'ws-alpha'}"#
        let withoutWorkspace = #"{type:'openPDF',pageID:'page',docID:'doc',title:'Paper',user:'alice'}"#
        _ = try await controller.webView.evaluateJavaScript("window.frames[0].webkit?.messageHandlers?.gammaNative?.postMessage(\(json)); true")
        _ = try await controller.webView.evaluateJavaScript("window.webkit.messageHandlers.gammaNative.postMessage(\(withoutWorkspace)); true")
        _ = try await controller.webView.evaluateJavaScript("window.webkit.messageHandlers.gammaNative.postMessage(\(json)); true")
        await fulfillment(of: [callback], timeout: 10)
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first?.pageID, "page")
        XCTAssertEqual(received.first?.workspace, "ws-alpha")
        XCTAssertFalse(config.websiteDataStore.isPersistent)
    }
}
