import XCTest
import PDFKit
import UIKit
@testable import GammaIPad

final class GammaNativeSelectionTests: XCTestCase {
    @MainActor
    func testPDFSelectionConvertsToWebHighlightAndQueuesOneBlock() throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
        let pdf = try XCTUnwrap(PDFDocument(data: renderer.pdfData { context in
            context.beginPage()
            ("Select this passage in Gamma" as NSString).draw(at: CGPoint(x: 40, y: 60), withAttributes: [.font: UIFont.systemFont(ofSize: 18)])
        }))
        let page = try XCTUnwrap(pdf.page(at: 0))
        let selection = try XCTUnwrap(page.selection(for: NSRange(location: 0, length: 11)))
        let view = PDFView(frame: CGRect(x: 0, y: 0, width: 612, height: 792))
        view.document = pdf; view.scaleFactor = 1; view.layoutIfNeeded()
        let selections = GammaTextSelection.highlights(from: selection, in: view)
        XCTAssertEqual(selections.count, 1)
        XCTAssertEqual(selections.first?.page, 1)
        XCTAssertFalse(try XCTUnwrap(selections.first).quote.isEmpty)
        let position = try XCTUnwrap(selections.first?.position)
        XCTAssertGreaterThan(try XCTUnwrap(position.boundingRect?.width), 0)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "alice")
        let workspace = GammaWorkspace(cache: cache); workspace.document = pdf
        workspace.page = GammaPageCache(pageID: "page", docID: "doc")
        try workspace.createHighlights(selections, color: "#ffe28f")
        let saved = try cache.loadPage(pageID: "page", docID: "doc")
        XCTAssertEqual(saved.blocks.count, 1)
        XCTAssertTrue(saved.blocks[0].isHighlight)
        XCTAssertEqual(saved.outbox.first?.kind, .highlight)
        XCTAssertEqual(saved.blocks[0].properties.highlightID, saved.blocks[0].id)
    }
}
