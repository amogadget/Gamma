import XCTest
import UIKit
@testable import GammaIPad

final class GammaTimInkTests: XCTestCase {
    private func data(strokes: [[String: Any]] = [["id": "s1", "pts": [100, 200]]],
                      space: [String: Any] = ["page": 3, "width": 612, "height": 792]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["format": "gamma-ink", "version": 1,
                                                    "space": space, "strokes": strokes])
    }

    func testBackendDefaultsAndMissingChannels() throws {
        let ink = try GammaTimInk.decode(data())
        XCTAssertEqual(ink.space.kind, "pdf-page")
        XCTAssertEqual(ink.space.page, 3)
        XCTAssertEqual(ink.space.width, 612)
        XCTAssertEqual(ink.space.height, 792)
        let s = try XCTUnwrap(ink.strokes.first)
        XCTAssertEqual(s.tool, "pen")
        XCTAssertEqual(s.color, "#1f1f1f")
        XCTAssertEqual(s.size, 1.6)
        XCTAssertEqual(s.opacity, 1)
        XCTAssertTrue(s.pen)
        XCTAssertNil(s.t0)
        XCTAssertEqual(s.ch, "xy")
        XCTAssertEqual(s.samples, [.init(x: 1, y: 2, p: 0.5, t: nil, a: nil, z: nil)])
        let empty = Data(#"{"format":"gamma-ink","version":1,"space":{"page":1,"width":10,"height":20}}"#.utf8)
        XCTAssertTrue(try GammaTimInk.decode(empty).strokes.isEmpty)
        let canvas = try GammaTimInk.decode(data(space: ["kind": "canvas", "width": 100, "height": 200]))
        XCTAssertNil(canvas.space.page)
    }

    func testAuthoritativeSharedSampleAndEveryChannelArePreserved() throws {
        let pts = [12040, 30512, 620, 0, 18, -3, 700, 8]
        let s = try GammaTimInk.decode(data(strokes: [["id": "k7Qm2x", "ch": "xypt", "pts": pts,
                                                      "t0": 1757760000000]])).strokes[0]
        XCTAssertEqual(s.pts, pts.map(Int64.init))
        XCTAssertEqual(s.samples[0].x, 120.4)
        XCTAssertEqual(s.samples[0].y, 305.12)
        XCTAssertEqual(s.samples[1].x, 120.58)
        XCTAssertEqual(s.samples[1].y, 305.09)
        XCTAssertEqual(s.samples[1].p, 0.7)
        XCTAssertEqual(s.samples[1].t, 8)
        XCTAssertEqual(s.t0, 1757760000000)

        // Optional channels need not use a canonical order. Only x/y/t are deltas.
        let all = [100, 200, 270, 1000, 35, 7, -50, 100, 90, -200, 40, -2]
        let full = try GammaTimInk.decode(data(strokes: [["id": "all", "ch": "xyzpat", "pts": all]])).strokes[0]
        XCTAssertEqual(full.pts, all.map(Int64.init))
        XCTAssertEqual(full.samples[0], .init(x: 1, y: 2, p: 1, t: 7, a: 35, z: 270))
        XCTAssertEqual(full.samples[1], .init(x: 0.5, y: 3, p: 0, t: 5, a: 40, z: 90))
        let clamped = try GammaTimInk.decode(data(strokes: [["id": "p", "ch": "xyp", "pts": [0, 0, 2000]]])).strokes[0]
        XCTAssertEqual(clamped.samples[0].p, 1)
        XCTAssertEqual(clamped.pts[2], 2000)
    }

    func testRejectsMalformedCodecAndUnknownFields() throws {
        let badStrokes: [[String: Any]] = [
            ["id": "", "pts": [0, 0]], ["id": "bad id", "pts": [0, 0]],
            ["id": String(repeating: "a", count: 33), "pts": [0, 0]],
            ["id": "s", "pts": []], ["id": "s"], ["id": "s", "pts": [0]],
            ["id": "s", "pts": [0.1, 0]], ["id": "s", "pts": [true, false]],
            ["id": "s", "pts": ["0", "0"]], ["id": "s", "pts": [0, 0], "size": 0],
            ["id": "s", "pts": [0, 0], "size": 101], ["id": "s", "pts": [0, 0], "size": true],
            ["id": "s", "pts": [0, 0], "opacity": 0], ["id": "s", "pts": [0, 0], "opacity": 1.1],
            ["id": "s", "pts": [0, 0], "pen": 1], ["id": "s", "pts": [0, 0], "t0": -1],
            ["id": "s", "pts": [0, 0], "tool": "eraser"],
            ["id": "s", "pts": [0, 0], "color": "red"],
            ["id": "s", "pts": [0, 0], "color": "rgba(1,2,3,0..2)"],
            ["id": "s", "pts": [0, 0], "unknown": 1],
            ["id": "s", "pts": [0, 0], "ch": NSNull()]
        ]
        for stroke in badStrokes {
            XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: [stroke])), "\(stroke)")
        }
        for ch in ["", "x", "yx", "xypp", "xyx", "xyq", "xyptazz"] {
            XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: [["id": "s", "ch": ch, "pts": [0, 0]]])), ch)
        }
        XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: [["id": "s", "pts": [0, 0]], ["id": "s", "pts": [0, 0]]])))
        for json in ["null", "[]", "{", #"{"format":"gamma-ink","version":2}"#,
                     #"{"format":"gamma-ink","version":true}"#,
                     #"{"format":"gamma-ink","version":1,"space":{"page":1,"width":NaN,"height":2}}"#] {
            XCTAssertThrowsError(try GammaTimInk.decode(Data(json.utf8)))
        }
        XCTAssertThrowsError(try GammaTimInk.decode(Data([0xff, 0xfe])))
        let extra = Data(#"{"format":"gamma-ink","version":1,"space":{"page":1,"width":10,"height":20},"future":true}"#.utf8)
        XCTAssertThrowsError(try GammaTimInk.decode(extra))
    }

    func testSpaceValidationAndFiniteLimits() throws {
        let spaces: [[String: Any]] = [
            ["width": 100, "height": 100], ["page": 0, "width": 100, "height": 100],
            ["page": true, "width": 100, "height": 100], ["page": 1.5, "width": 100, "height": 100],
            ["page": 1, "width": 0, "height": 100], ["page": 1, "width": 100001, "height": 100],
            ["page": 1, "width": 100, "height": -1], ["page": 1, "width": 100, "height": 100001],
            ["page": 1, "width": "100", "height": 100],
            ["page": 1, "width": 100, "height": 100, "kind": "unknown"],
            ["page": 1, "width": 100, "height": 100, "rotation": 90]
        ]
        for space in spaces {
            XCTAssertThrowsError(try GammaTimInk.decode(data(space: space)), "\(space)")
        }
        let huge = Data(#"{"format":"gamma-ink","version":1,"space":{"page":1,"width":1e999,"height":2}}"#.utf8)
        XCTAssertThrowsError(try GammaTimInk.decode(huge))
        XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: [["id": "s", "pts": [9_007_199_254_740_991, 0, 1, 0]]])))
    }

    func testBudgets() throws {
        XCTAssertThrowsError(try GammaTimInk.decode(Data(repeating: 32, count: GammaTimInk.maxBytes + 1)))
        let strokes: [[String: Any]] = (0...GammaTimInk.maxStrokes).map { ["id": "s\($0)", "pts": [0, 0]] }
        XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: strokes)))
        XCTAssertEqual(try GammaTimInk.decode(data(strokes: Array(strokes.dropLast()))).strokes.count, GammaTimInk.maxStrokes)
        let samples = Array(repeating: 0, count: (GammaTimInk.maxSamples + 1) * 2)
        let over = try data(strokes: [["id": "s", "pts": samples]])
        XCTAssertLessThan(over.count, GammaTimInk.maxBytes) // Exercise sample budget, not byte budget.
        XCTAssertThrowsError(try GammaTimInk.decode(over))
    }

    func testInverseRotationsReturnCropLocalNotPDFUserSpace() {
        // Same native point (60,160) in a 600x800 crop at a nonzero PDF origin.
        let crop = CGRect(x: 37, y: 91, width: 600, height: 800)
        let cases: [(Int, CGPoint, Double, Double)] = [
            (0, CGPoint(x: 60, y: 160), 600, 800),
            (90, CGPoint(x: 640, y: 60), 800, 600),
            (180, CGPoint(x: 540, y: 640), 600, 800),
            (270, CGPoint(x: 160, y: 540), 800, 600),
            (-90, CGPoint(x: 160, y: 540), 800, 600),
            (450, CGPoint(x: 640, y: 60), 800, 600)
        ]
        for (rotation, point, width, height) in cases {
            let result = GammaTimInk.nativePoint(viewport: point, cropBounds: crop, rotation: rotation,
                                                spaceWidth: width, spaceHeight: height)
            XCTAssertEqual(result.x, 60, accuracy: 0.000001)
            XCTAssertEqual(result.y, 160, accuracy: 0.000001)
            let zeroOrigin = GammaTimInk.nativePoint(viewport: point, cropBounds: CGRect(origin: .zero, size: crop.size),
                                                    rotation: rotation, spaceWidth: width, spaceHeight: height)
            XCTAssertEqual(result, zeroOrigin)
        }
        let scaled = GammaTimInk.nativePoint(viewport: CGPoint(x: 1280, y: 120), cropBounds: crop,
                                            rotation: 90, spaceWidth: 1600, spaceHeight: 1200)
        XCTAssertEqual(scaled.x, 60, accuracy: 0.000001)
        XCTAssertEqual(scaled.y, 160, accuracy: 0.000001)
    }

    func testMonolineKeepsPressureAndRawChannelsWithConstantWidth() throws {
        let pts = [100, 200, -200, 0, 18, -3, 2000, 8]
        let base: [String: Any] = ["id": "s", "size": 2, "ch": "xypt", "pts": pts]
        let legacy = try GammaTimInk.decode(data(strokes: [base])).strokes[0]
        var styled = base
        styled["brush"] = "monoline"
        let monoline = try GammaTimInk.decode(data(strokes: [styled])).strokes[0]
        XCTAssertEqual(monoline.brush, "monoline")
        XCTAssertTrue(monoline.pen)
        XCTAssertEqual(monoline.pts, pts.map(Int64.init))
        XCTAssertEqual(monoline.samples, legacy.samples)
        XCTAssertEqual(monoline.samples.map(\.p), [0, 1])
        XCTAssertEqual(monoline.samples.map { monoline.width(at: $0) }, [2, 2])
        XCTAssertNil(legacy.brush)
        XCTAssertEqual(legacy.samples.map { legacy.width(at: $0) }, [1.5, 2.5])
    }

    func testNullBrushRetainsLegacyPenAndHighlighterSemantics() throws {
        for tool in ["pen", "highlighter"] {
            let base: [String: Any] = ["id": "s", "tool": tool, "size": 2,
                                       "ch": "xyp", "pts": [0, 0, 0, 100, 100, 1000]]
            let legacy = try GammaTimInk.decode(data(strokes: [base])).strokes[0]
            var nullable = base
            nullable["brush"] = NSNull()
            let decoded = try GammaTimInk.decode(data(strokes: [nullable])).strokes[0]
            XCTAssertNil(decoded.brush)
            XCTAssertEqual(decoded.pts, legacy.pts)
            XCTAssertEqual(decoded.samples, legacy.samples)
            XCTAssertEqual(decoded.samples.map { decoded.width(at: $0) },
                           legacy.samples.map { legacy.width(at: $0) })
        }
    }

    func testRejectsUnknownBrushAndMonolineHighlighter() throws {
        let badBrushes: [Any] = ["unknown", "", "Monoline", true, 1, ["monoline"], ["name": "monoline"]]
        for brush in badBrushes {
            XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: [
                ["id": "s", "pts": [0, 0], "brush": brush]
            ])), "\(brush)")
        }
        XCTAssertThrowsError(try GammaTimInk.decode(data(strokes: [
            ["id": "s", "pts": [0, 0], "tool": "highlighter", "brush": "monoline"]
        ])))
    }

    func testPressureWidthAndMouseHighlighterConstants() throws {
        for (tool, pen, expected) in [("pen", true, 2.5), ("pen", false, 2.0), ("highlighter", true, 2.0)] {
            let s = try GammaTimInk.decode(data(strokes: [["id": "s", "tool": tool, "pen": pen,
                                                          "size": 2, "ch": "xyp", "pts": [100, 200, 1000]]])).strokes[0]
            XCTAssertEqual(s.width(at: s.samples[0]), expected)
        }
    }

    @MainActor
    func testVectorDotIsUnrotatedAndCropOriginDoesNotLeakIntoPath() throws {
        let ink = try GammaTimInk.decode(data(strokes: [["id": "dot", "pen": false, "size": 10,
                                                        "pts": [64000, 6000]]],
                                             space: ["page": 1, "width": 800, "height": 600]))
        let view = GammaTimInkView(frame: CGRect(x: 0, y: 0, width: 1200, height: 1600))
        view.cropBounds = CGRect(x: 37, y: 91, width: 600, height: 800)
        view.rotation = 90
        view.inks = [ink]
        view.layoutIfNeeded()
        let shape = try XCTUnwrap(view.layer.sublayers?.first as? CAShapeLayer)
        let box = try XCTUnwrap(shape.path).boundingBoxOfPath
        XCTAssertEqual(box.midX, 60, accuracy: 0.000001)
        XCTAssertEqual(box.midY, 160, accuracy: 0.000001)
        XCTAssertEqual(box.width, 10, accuracy: 0.000001)
        XCTAssertEqual(box.height, 10, accuracy: 0.000001)
        XCTAssertEqual(shape.affineTransform().a, 2)
        XCTAssertEqual(shape.affineTransform().d, 2)
    }

    @MainActor
    func testViewIsNoninteractiveAndHighlighterHasOneVectorOpacity() throws {
        let ink = try GammaTimInk.decode(data(strokes: [["id": "h", "tool": "highlighter", "size": 10,
                                                        "opacity": 0.6, "color": "rgba(255,226,143,0.8)",
                                                        "pts": [1000, 2000, 5000, 0, -5000, 0]]]))
        let view = GammaTimInkView(frame: CGRect(x: 0, y: 0, width: 612, height: 792))
        view.cropBounds = CGRect(x: 37, y: 91, width: 612, height: 792)
        view.inks = [ink]
        view.layoutIfNeeded()
        XCTAssertFalse(view.isUserInteractionEnabled)
        XCTAssertNil(view.hitTest(CGPoint(x: 10, y: 20), with: nil))
        let layers = try XCTUnwrap(view.layer.sublayers)
        XCTAssertEqual(layers.count, 1)
        let shape = try XCTUnwrap(layers.first as? CAShapeLayer)
        XCTAssertNotNil(shape.path)
        XCTAssertEqual(shape.opacity, 0.48, accuracy: 0.00001) // RGBA alpha × stroke opacity.
        XCTAssertEqual(shape.fillColor?.alpha, 1)
        XCTAssertNil(shape.compositingFilter) // Unsupported on iOS; never install a filter.
        view.inks = []
        XCTAssertTrue(view.layer.sublayers?.isEmpty ?? true)
    }
}
