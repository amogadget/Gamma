import XCTest
import PencilKit
@testable import GammaIPad

final class InkSelectionTests: XCTestCase {
    private func drawing(x: CGFloat, y: CGFloat) -> PKDrawing {
        let points = [0, 20].map { delta in
            PKStrokePoint(location: CGPoint(x: x + CGFloat(delta), y: y), timeOffset: Double(delta) / 100,
                          size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        return PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: points, creationDate: Date()))])
    }
    func testPencilHitSelectsExistingBlockWithoutMutatingDrawing() {
        let ink = drawing(x: 40, y: 50)
        let original = ink.dataRepresentation()
        XCTAssertEqual(InkSelection.target(at: CGPoint(x: 50, y: 50), drawings: [("existing", ink)], selectedID: nil, tolerance: 4), "existing")
        XCTAssertEqual(ink.dataRepresentation(), original)
    }
    func testCurrentBlockIsNotInterceptedAndBlankSpaceDoesNotSelect() {
        let ink = drawing(x: 40, y: 50)
        XCTAssertNil(InkSelection.target(at: CGPoint(x: 50, y: 50), drawings: [("existing", ink)], selectedID: "existing", tolerance: 4))
        XCTAssertNil(InkSelection.target(at: CGPoint(x: 300, y: 300), drawings: [("existing", ink)], selectedID: nil, tolerance: 4))
    }
    func testSeparateLineWhitespaceDoesNotSelectWholeNoteBounds() {
        let top = drawing(x: 40, y: 50), bottom = drawing(x: 40, y: 150)
        let ink = PKDrawing(strokes: top.strokes + bottom.strokes)
        XCTAssertNil(InkSelection.target(at: CGPoint(x: 50, y: 100), drawings: [("note", ink)], selectedID: nil, tolerance: 4))
    }
    func testOverlapPrefersActiveInkOtherwiseTopmostBlock() {
        let ink = drawing(x: 40, y: 50)
        let layers = [(id: "lower", drawing: ink), (id: "upper", drawing: ink)]
        XCTAssertEqual(InkSelection.target(at: CGPoint(x: 50, y: 50), drawings: layers, selectedID: nil, tolerance: 4), "upper")
        XCTAssertNil(InkSelection.target(at: CGPoint(x: 50, y: 50), drawings: layers, selectedID: "lower", tolerance: 4))
    }
}
