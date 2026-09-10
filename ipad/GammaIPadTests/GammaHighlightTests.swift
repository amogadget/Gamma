import XCTest
import UIKit
@testable import GammaIPad

final class GammaHighlightTests: XCTestCase {
    func testDecodesExistingWebHighlightAndScalesViewportCoordinates() throws {
        let data = Data(#"{"id":"highlight-block","content":"My comment","properties":{"highlight_id":"h1","quote":"Quoted text","color":"rgba(255,226,143,0.65)","pdf_page":2,"pdf_position":{"pageNumber":2,"boundingRect":{"x1":10,"y1":20,"x2":30,"y2":40,"width":100,"height":200},"rects":[{"x1":10,"y1":20,"x2":30,"y2":40,"pageNumber":2}]}}}"#.utf8)
        let block = try JSONDecoder().decode(GammaBlock.self, from: data)
        XCTAssertTrue(block.isHighlight)
        XCTAssertEqual(block.pdfPage, 2)
        XCTAssertEqual(block.properties.quote, "Quoted text")
        let highlight = GammaPDFHighlight(id: block.id, position: try XCTUnwrap(block.properties.pdfPosition), color: block.properties.color, selected: false)
        let boxes = highlight.rectangles(in: CGRect(x: 5, y: 7, width: 200, height: 400), pageNumber: 2)
        XCTAssertEqual(boxes, [CGRect(x: 25, y: 47, width: 40, height: 40)])
        XCTAssertTrue(highlight.rectangles(in: CGRect(x: 0, y: 0, width: 200, height: 400), pageNumber: 1).isEmpty)
    }
    func testPageFallbackAndInvalidRectangles() throws {
        let data = Data(#"{"id":"h","content":"","properties":{"highlight_id":"h","pdf_position":{"pageNumber":3,"boundingRect":{"x1":0,"y1":0,"x2":10,"y2":10,"width":0,"height":100}}}}"#.utf8)
        let block = try JSONDecoder().decode(GammaBlock.self, from: data)
        XCTAssertEqual(block.pdfPage, 3)
        let highlight = GammaPDFHighlight(id: "h", position: try XCTUnwrap(block.properties.pdfPosition), color: nil, selected: false)
        XCTAssertTrue(highlight.rectangles(in: CGRect(x: 0, y: 0, width: 100, height: 100), pageNumber: 3).isEmpty)
    }
    func test405ExplainsMissingServerCapabilityRatherThanRetryingForever() throws {
        let api = try GammaAPI(server: "https://gamma.example")
        defer { api.close() }
        let response = HTTPURLResponse(url: URL(string: "https://gamma.example/api/assets")!, statusCode: 405, httpVersion: nil, headerFields: nil)!
        XCTAssertThrowsError(try api.validate(response)) { error in
            guard case GammaAPI.APIError.serverUpgradeRequired(let path) = error else { return XCTFail("Expected upgrade-required error") }
            XCTAssertEqual(path, "/api/assets")
            XCTAssertTrue(error.localizedDescription.contains("Automatic sync is paused"))
        }
    }
}
