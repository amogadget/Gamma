#if GAMMA_EMBEDDED_BACKEND
import XCTest
import PDFKit
import PencilKit
import WebKit
@testable import GammaIPad

@MainActor
final class GammaEmbeddedLocalIntegrationTests: XCTestCase {
    func testFullBackendAndPencilUseTheSameLocalPage() async throws {
        let workspace = GammaWorkspace()
        await workspace.enterLocalLibrary()
        XCTAssertTrue(workspace.isEmbeddedLocal, workspace.errorMessage ?? "No local backend")
        let api = try XCTUnwrap(workspace.api)
        XCTAssertNotNil(api.localServerAccess)
        XCTAssertNotNil(workspace.webSession?.localServerAccess)
        XCTAssertEqual(api.baseURL.host, "127.0.0.1")
        let id = UUID().uuidString.lowercased()
        var request = try api.makeRequest("api/blank-pdfs/\(id)")
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["title": "Embedded Pencil integration", "page_count": 2])
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        let paper = try JSONDecoder().decode(GammaPaper.self, from: data)
        await workspace.open(paper)
        XCTAssertEqual(workspace.document?.pageCount, 2, workspace.errorMessage ?? "")
        try workspace.newInk(pdfPage: 1)
        let inkID = try XCTUnwrap(workspace.selectedID)
        let point = PKStrokePoint(location: CGPoint(x: 35, y: 45), timeOffset: 0,
            size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
        try workspace.saveDrawing(blockID: inkID, pdfPage: 0, drawing: drawing)
        await workspace.sync()
        XCTAssertEqual(workspace.pendingCount, 0, workspace.errorMessage ?? "")
        let remote = try await api.subtree(paper.id)
        let block = try XCTUnwrap(remote.flattened.first { $0.id == inkID })
        XCTAssertTrue(block.isInk)
        let source = try XCTUnwrap(block.properties.inkAsset)
        let reopened = try PKDrawing(data: await api.asset(source))
        XCTAssertEqual(reopened.strokes.count, 1)
        XCTAssertEqual(reopened.strokes.first?.path.first?.location.x, 35)
        XCTAssertEqual(workspace.cache?.workspace, api.workspace)
        XCTAssertTrue(api.sessionCookies().isEmpty, "Local runtime credentials must not enter server persistence")

        // Load the actual bundled Full Gamma, not a mock page, using only the
        // runtime-issued cookies. Return to the exact native document/position.
        let access = try XCTUnwrap(api.localServerAccess)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let controller = GammaWebViewController(configuration: config, serverURL: api.baseURL,
            workspace: api.workspace, cookies: [], reloadToken: nil, localServerAccess: access,
            onOpenPDF: { _, cookies in XCTAssertTrue(cookies.isEmpty) }, onError: { message in XCTFail(message) })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1194, height: 834)
        window.rootViewController = controller; window.makeKeyAndVisible()
        defer { controller.invalidate(); window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
        controller.view.layoutIfNeeded()
        var ready = false
        for _ in 0..<200 {
            ready = (try? await controller.webView.evaluateJavaScript("window.__GAMMA_NATIVE_CONTROL__?.version === 1")) as? Bool == true
            if ready { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(ready, "Actual bundled local Full Gamma bridge never loaded")
        let commands = GammaWebCommandController(); commands.attach(controller)
        let restored = await commands.restorePosition(request: GammaWebOpenRequest(pageID: paper.id,
            docID: try XCTUnwrap(paper.properties.docID), title: paper.content, user: access.account,
            workspace: api.workspace, viewport: GammaReadingPosition(pageIndex: 1, anchorX: 0, anchorY: 0.3)),
            serverURL: api.baseURL)
        XCTAssertTrue(restored, commands.lastFailure ?? "Position restore failed")
        try await Task.sleep(for: .milliseconds(600))
        let position = try await controller.webView.evaluateJavaScript("""
            (() => { const s=document.querySelector('.pdfViewer'); if(!s)return null;
            const v=s.getBoundingClientRect(); const pages=[...s.querySelectorAll('.pdfPageWrap[data-page]')];
            const p=pages.find(p=>p.getBoundingClientRect().bottom>v.top+1); if(!p)return null;
            const b=p.getBoundingClientRect(); return {page:Number(p.dataset.page),y:(v.top-b.top)/b.height}; })()
            """) as? [String: Any]
        XCTAssertEqual(position?["page"] as? Int, 2, "Full Gamma must remain at the returned native page")
        XCTAssertEqual(try XCTUnwrap(position?["y"] as? Double), 0.3, accuracy: 0.02)
        let body = try await controller.webView.evaluateJavaScript("document.body.innerText") as? String ?? ""
        XCTAssertTrue(body.contains("Embedded Pencil integration"), body)
        XCTAssertTrue(body.contains("Pencil") || body.contains("Audio"), "Missing native controls in real local Full Gamma")
        let nativeInkVisible = try await controller.webView.evaluateJavaScript("!!document.querySelector('.nativeInkCard')") as? Bool
        XCTAssertEqual(nativeInkVisible, true, "Web must read the same native ink block from local backend")
        let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
            XCTAssertTrue(controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image); attachment.name = "Full-local-Gamma-shared-Pencil-PDF"
        attachment.lifetime = .keepAlways; add(attachment)
    }
}
#endif
