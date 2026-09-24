import XCTest
import PDFKit
import UIKit
@testable import GammaIPad

final class GammaReadingPositionTests: XCTestCase {
    func testOptionalBridgePositionAndStrictNumbers() {
        var payload: [String: Any] = ["type": "openPDF", "pageID": "p", "docID": "d", "title": "Paper", "user": "u", "workspace": "w"]
        XCTAssertNotNil(GammaWebMessageValidator.openPDF(from: payload))
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: payload)?.viewport)
        let position: [String: Any] = ["pageIndex": 8, "anchorX": 0.25, "anchorY": 0.625]
        payload["viewport"] = position
        XCTAssertEqual(GammaWebMessageValidator.openPDF(from: payload)?.viewport?.pageIndex, 8)
        for key in ["anchorX", "anchorY"] {
            for bad in [Double.nan, Double.infinity, -0.1, 1.1, true, "0.2", NSNull()] as [Any] {
                var value = position; value[key] = bad; payload["viewport"] = value
                XCTAssertNil(GammaWebMessageValidator.openPDF(from: payload))
            }
        }
        for bad in [-1, 0.5, 1000000, true, "2"] as [Any] {
            var value = position; value["pageIndex"] = bad; payload["viewport"] = value
            XCTAssertNil(GammaWebMessageValidator.openPDF(from: payload))
        }
        payload["viewport"] = position; payload["workspace"] = ""
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: payload))
    }

    @MainActor
    func testCaptureTopPageAndLateRestoreDoesNotPublishInitialPosition() async throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 600, height: 800))
        let document = try XCTUnwrap(PDFDocument(data: renderer.pdfData { ctx in
            for _ in 0..<4 { ctx.beginPage() }
        }))
        let handle = GammaPDFViewportController()
        let view = InkPDFView(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
        view.displayMode = .singlePageContinuous; view.displayBox = .cropBox
        let coordinator = PDFInkView.Coordinator()
        coordinator.attach(view)
        var reports: [GammaReadingPosition] = []
        let requested = try XCTUnwrap(GammaReadingPosition(pageIndex: 2, anchorX: 0, anchorY: 0.4))
        let config = PDFInkView(document: document, loadDrawing: { _ in .init() }, saveDrawing: { _, _ in },
            onError: { XCTFail($0) }, isDrawing: false, requestedViewport: requested,
            viewportController: handle, onViewportChanged: { reports.append($0) })
        coordinator.update(from: config)
        XCTAssertNil(handle.capture(document: document), "Pending restore must not expose initial page zero")
        XCTAssertNil(handle.capture(document: PDFDocument()), "Handle must reject a stale document")
        await Task.yield()
        XCTAssertTrue(reports.isEmpty)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
        let host = UIViewController(); window.rootViewController = host
        host.view.addSubview(view); window.makeKeyAndVisible()
        coordinator.update(from: config)
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            MainActor.assumeIsolated { handle.capture(document: document)?.pageIndex == 2 }
        }, object: nil)
        await fulfillment(of: [restored], timeout: 3)
        XCTAssertEqual(handle.capture(document: document)?.pageIndex, 2)
        coordinator.dismantle()
        XCTAssertNil(handle.capture(document: document))
        window.isHidden = true
    }

    @MainActor
    func testCapturedDisplayedCropAnchorRoundTripsAllRotations() throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 600, height: 800))
        let document = try XCTUnwrap(PDFDocument(data: renderer.pdfData { ctx in
            for _ in 0..<3 { ctx.beginPage() }
        }))
        let view = PDFView(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
        view.displayMode = .singlePageContinuous; view.displayBox = .cropBox
        view.document = document; view.scaleFactor = 1.3
        for rotation in [0, 90, 180, 270] {
            let page = try XCTUnwrap(document.page(at: 1))
            page.setBounds(CGRect(x: 40, y: 60, width: 500, height: 650), for: .cropBox)
            page.rotation = rotation; view.layoutDocumentView()
            let desired = try XCTUnwrap(GammaReadingPosition(pageIndex: 1, anchorX: 0.1, anchorY: 0.35))
            let point = try XCTUnwrap(GammaPDFReadingPosition.point(desired, page: page, view: view))
            view.go(to: PDFDestination(page: page, at: point)); view.layoutIfNeeded()
            let captured = try XCTUnwrap(GammaPDFReadingPosition.capture(view: view))
            let capturedPage = try XCTUnwrap(document.page(at: captured.pageIndex))
            let rect = view.convert(capturedPage.bounds(for: .cropBox), from: capturedPage).standardized
            XCTAssertEqual(captured.anchorY, Double(max(0, min(1, (view.bounds.minY - rect.minY) / rect.height))), accuracy: 0.001)
            let topIndex = view.visiblePages.filter { view.convert($0.bounds(for: .cropBox), from: $0).maxY > view.bounds.minY }
                .map { document.index(for: $0) }.min()
            XCTAssertEqual(captured.pageIndex, topIndex)
        }
    }

    @MainActor
    func testDisplayedAnchorUsesPDFKitCropAndRotationConversion() throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 600, height: 800))
        let document = try XCTUnwrap(PDFDocument(data: renderer.pdfData { ctx in ctx.beginPage() }))
        let page = try XCTUnwrap(document.page(at: 0))
        page.setBounds(CGRect(x: 40, y: 60, width: 500, height: 650), for: .cropBox)
        let view = PDFView(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
        view.displayBox = .cropBox; view.document = document
        let position = try XCTUnwrap(GammaReadingPosition(pageIndex: 0, anchorX: 0.25, anchorY: 0.625))
        for rotation in [0, 90, 180, 270] {
            page.rotation = rotation
            view.layoutDocumentView()
            let point = try XCTUnwrap(GammaPDFReadingPosition.point(position, page: page, view: view))
            let rect = view.convert(page.bounds(for: .cropBox), from: page).standardized
            let displayed = view.convert(point, from: page)
            XCTAssertEqual((displayed.x - rect.minX) / rect.width, 0.25, accuracy: 0.0001)
            XCTAssertEqual((displayed.y - rect.minY) / rect.height, 0.625, accuracy: 0.0001)
        }
    }
}
