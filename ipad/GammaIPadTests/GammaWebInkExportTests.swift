import XCTest
import PencilKit
import UIKit
import CryptoKit
@testable import GammaIPad

final class GammaWebInkExportTests: XCTestCase {
    private func stroke(_ x: CGFloat, birth: TimeInterval = 1) -> PKStroke {
        let points = (0..<4).map { index in
            PKStrokePoint(location: CGPoint(x: x + CGFloat(index) * 20, y: 40),
                          timeOffset: Double(index) * 0.1,
                          size: CGSize(width: 4, height: 6), opacity: 1, force: 1,
                          azimuth: 0, altitude: .pi / 2)
        }
        return PKStroke(ink: PKInk(.pen, color: .systemBlue),
                        path: PKStrokePath(controlPoints: points,
                                           creationDate: Date(timeIntervalSince1970: birth)))
    }

    func testTwoStrokeSchemaPNGsIDsAndSourceHash() throws {
        let first = stroke(20), second = stroke(120, birth: 2)
        let drawing = PKDrawing(strokes: [first, second])
        let original = drawing.dataRepresentation()
        let source = Data("the-original-source-bytes".utf8)
        let data = try GammaWebInkExport.encode(drawing: drawing, sourceData: source,
                                                pageSize: CGSize(width: 300, height: 200))
        XCTAssertLessThanOrEqual(data.count, 32 * 1024 * 1024)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["format"] as? String, "gamma-ink-replay-v1")
        XCTAssertEqual(object["width"] as? Double, 300)
        XCTAssertEqual(object["height"] as? Double, 200)
        let expectedHash = SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(object["source_sha256"] as? String, expectedHash)
        let strokes = try XCTUnwrap(object["strokes"] as? [[String: Any]])
        XCTAssertEqual(strokes.count, 2)
        XCTAssertEqual(strokes.map { $0["id"] as? String }, [GammaReplay.strokeID(first), GammaReplay.strokeID(second)])
        for item in strokes {
            let pngText = try XCTUnwrap(item["png"] as? String)
            XCTAssertFalse(pngText.hasPrefix("data:"))
            let png = try XCTUnwrap(Data(base64Encoded: pngText))
            XCTAssertEqual(try XCTUnwrap(UIImage(data: png)).size.width > 0, true)
            let bounds = try XCTUnwrap(item["bounds"] as? [String: Any])
            XCTAssertGreaterThan(try XCTUnwrap(bounds["width"] as? Double), 0)
            XCTAssertGreaterThan(try XCTUnwrap(bounds["height"] as? Double), 0)
            let points = try XCTUnwrap(item["points"] as? [[String: Any]])
            XCTAssertEqual(points.count, 4)
            XCTAssertTrue(points.allSatisfy { $0["x"] is Double && $0["y"] is Double && $0["t"] is Double && $0["radius"] is Double })
        }
        XCTAssertEqual(drawing.dataRepresentation(), original)
    }

    func testExportRealBrowserFixtures() throws {
        let drawing = PKDrawing(strokes: [stroke(20), stroke(120, birth: 2)])
        let original = drawing.dataRepresentation()
        for (name, size) in [("web-replay-page1", CGSize(width: 612, height: 792)), ("web-replay-page4", CGSize(width: 532, height: 672))] {
            let data = try GammaWebInkExport.encode(drawing: drawing, sourceData: original, pageSize: size)
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        let source = XCTAttachment(data: original, uniformTypeIdentifier: "public.data")
        source.name = "web-replay-source"; source.lifetime = .keepAlways; add(source)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: file) }
        try GammaRecordingTests.writeAudio(to: file)
        let audio = XCTAttachment(data: try Data(contentsOf: file), uniformTypeIdentifier: "public.mpeg-4-audio")
        audio.name = "web-replay-audio"; audio.lifetime = .keepAlways; add(audio)
    }
    func testStrokeLimitIsRejectedClearly() throws {
        let strokes = (0..<2001).map { stroke(CGFloat($0 % 100) * 3, birth: TimeInterval($0 + 1)) }
        XCTAssertThrowsError(try GammaWebInkExport.encode(drawing: PKDrawing(strokes: strokes), sourceData: Data(),
                                                           pageSize: CGSize(width: 400, height: 400))) { error in
            guard case GammaWebInkExport.ExportError.unsupportedLimit(let message) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertTrue(message.contains("2000"))
        }
    }

    func testInvalidPageSizeIsRejected() {
        XCTAssertThrowsError(try GammaWebInkExport.encode(drawing: PKDrawing(), sourceData: Data(),
                                                           pageSize: CGSize(width: 0, height: 100)))
    }
}
