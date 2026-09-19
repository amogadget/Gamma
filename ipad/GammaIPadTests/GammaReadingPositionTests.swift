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
