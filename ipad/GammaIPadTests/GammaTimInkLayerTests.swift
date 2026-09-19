import XCTest
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

final class GammaTimInkLayerTests: XCTestCase {
    @MainActor
    func testBrowserLayerIsSeparateReadOnlyAndSurvivesReplay() throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
        let document = try XCTUnwrap(PDFDocument(data: renderer.pdfData { $0.beginPage() }))
        let page = try XCTUnwrap(document.page(at: 0))
        let view = InkPDFView()
        let coordinator = PDFInkView.Coordinator()
        coordinator.attach(view)
        view.pageOverlayViewProvider = nil
        defer { coordinator.dismantle() }
        let bytes = Data(#"{"format":"gamma-ink","version":1,"space":{"kind":"pdf-page","page":1,"width":612,"height":792},"strokes":[{"id":"browser","ch":"xypt","pts":[1000,2000,400,0,200,300,800,8]}]}"#.utf8)
        let ink = try GammaTimInk.decode(bytes)
        var saves = 0
        var configuration = PDFInkView(document: document, loadDrawing: { _ in PKDrawing() },
            saveDrawing: { _, _ in saves += 1 }, onError: { XCTFail($0) },
            timInk: { $0 == 0 ? [ink] : [] })
        coordinator.update(from: configuration)
        let overlay = try XCTUnwrap(coordinator.pdfView(view, overlayViewFor: page) as? InkPageOverlay)
        coordinator.pdfView(view, willDisplayOverlayView: overlay, for: page)
        XCTAssertEqual(overlay.timInkScene?.candidates(for: page).count, 1)
        XCTAssertFalse(overlay.timInkLayer.isUserInteractionEnabled)
        XCTAssertTrue(overlay.canvas.drawing.strokes.isEmpty)
        XCTAssertTrue(overlay.backgroundCanvas.drawing.strokes.isEmpty)
        XCTAssertTrue(overlay.subviews.firstIndex(of: overlay.timCrossPageLayer)! < overlay.subviews.firstIndex(of: overlay.canvas)!)
        XCTAssertTrue(overlay.subviews.firstIndex(of: overlay.highlightLayer)! < overlay.subviews.firstIndex(of: overlay.timCrossPageLayer)!)
        configuration.replayActive = true
        coordinator.update(from: configuration)
        XCTAssertTrue(overlay.isReplaying)
        XCTAssertNotNil(overlay.timInkScene)
        XCTAssertFalse(overlay.timCrossPageLayer.isUserInteractionEnabled)
        XCTAssertEqual(overlay.timInkScene?.candidates(for: page).count, 1)
        XCTAssertEqual(saves, 0, "Displaying browser ink must never enter native save callbacks")
        configuration.contentRevision += 1
        configuration.timInk = { _ in [] }
        coordinator.update(from: configuration)
        XCTAssertEqual(overlay.timInkScene?.candidates(for: page).count, 0, "Removed or replaced ink_url cannot leave stale geometry")
        XCTAssertEqual(saves, 0)
    }

    @MainActor
    func testLegacyStandaloneOverflowIsNotCrossPageProof() throws {
        let bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        let pdf = try XCTUnwrap(PDFDocument(data: UIGraphicsPDFRenderer(bounds: bounds).pdfData { $0.beginPage() }))
        let page = try XCTUnwrap(pdf.page(at: 0))
        let pdfView = PDFView()
        let overlay = InkPageOverlay(page: page, pdfView: pdfView)
        overlay.frame = CGRect(x: 10, y: 40, width: 100, height: 100)
        overlay.timInkLayer.frame = bounds
        let ink = try GammaTimInk.decode(Data(##"{"format":"gamma-ink","version":1,"space":{"kind":"pdf-page","page":1,"width":100,"height":100},"strokes":[{"id":"cross-edge","color":"#ff0000","size":4,"ch":"xy","pts":[5000,-1000,0,3000]}]}"##.utf8))
        overlay.timInkLayer.inks = [ink]
        overlay.timInkLayer.layoutIfNeeded()
        XCTAssertFalse(overlay.clipsToBounds)
        XCTAssertFalse(overlay.timInkLayer.clipsToBounds)
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 120, height: 160))
        host.backgroundColor = .white
        host.addSubview(overlay)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true; format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(bounds: host.bounds, format: format).image { ctx in
            UIColor.white.setFill(); ctx.fill(host.bounds)
            host.layer.render(in: ctx.cgContext)
        }
        let cg = try XCTUnwrap(image.cgImage)
        let pixels = try XCTUnwrap(cg.dataProvider?.data) as Data
        var abovePagePixels = 0
        for y in 20..<40 {
            for x in 40..<80 {
                let offset = y * cg.bytesPerRow + x * 4
                if min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 180 { abovePagePixels += 1 }
            }
        }
        XCTAssertGreaterThan(abovePagePixels, 15, "Negative-Y browser points must remain visible above the PDF edge")
    }

    @MainActor
    private final class DestinationOnlyProvider: NSObject, PDFPageOverlayViewProvider {
        let destination: PDFPage
        let scene: GammaTimInkScene
        var overlay: InkPageOverlay?
        init(destination: PDFPage, scene: GammaTimInkScene) {
            self.destination = destination; self.scene = scene
        }
        func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
            // Source-page overlay NEVER exists: overflow must not depend on it.
            guard page === destination else { return nil }
            if let overlay { return overlay }
            let result = InkPageOverlay(page: page, pdfView: view)
            result.timInkScene = scene
            overlay = result
            return result
        }
    }

    @MainActor
    func testOpaquePDFKitSiblingCompositorOwnsNegativeYOnPrecedingPage() async throws {
        let windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = windowScene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: windowScene)
        let host = UIViewController(); window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; oldKey?.makeKeyAndVisible() }
        // Real PDF pages with explicit opaque fills, not transparent UIView mocks.
        let media = CGRect(x: 0, y: 0, width: 700, height: 900)
        let bytes = UIGraphicsPDFRenderer(bounds: media).pdfData { context in
            for _ in 0..<2 {
                context.beginPage()
                UIColor.white.setFill(); context.cgContext.fill(media)
            }
        }
        for rotation in [0, 90, 180, 270] {
            let document = try XCTUnwrap(PDFDocument(data: bytes))
            let previous = try XCTUnwrap(document.page(at: 0)), source = try XCTUnwrap(document.page(at: 1))
            previous.setBounds(CGRect(x: 10, y: 20, width: 640, height: 800), for: .cropBox)
            source.setBounds(CGRect(x: 17, y: 23, width: 593.972, height: 756), for: .cropBox)
            source.rotation = rotation
            // Live-file extent: circle's top lies at y = -14.43 in tim space.
            // Rotation is intentionally different from the destination page.
            let width = rotation % 180 == 0 ? 593.972 : 756.0
            let height = rotation % 180 == 0 ? 756.0 : 593.972
            var pts: [Int] = [], oldX = 0, oldY = 0
            for step in 0...80 {
                let angle = Double(step) * 2 * .pi / 80
                let x = Int(((100 + 19.43 * cos(angle)) * 100).rounded())
                let y = Int(((5 + 19.43 * sin(angle)) * 100).rounded())
                pts += [x - oldX, y - oldY]; oldX = x; oldY = y
            }
            let json: [String: Any] = ["format": "gamma-ink", "version": 1,
                "space": ["kind": "pdf-page", "page": 2, "width": width, "height": height],
                "strokes": [["id": "black-circle", "color": "#000000", "size": 4, "pen": false, "ch": "xy", "pts": pts]]]
            let ink = try GammaTimInk.decode(JSONSerialization.data(withJSONObject: json))
            var loads: [Int] = []
            let scene = GammaTimInkScene(document: document) { index in
                loads.append(index); return index == 1 ? [ink] : []
            }
            XCTAssertEqual(loads, [0, 1], "Snapshot must load nonvisible sources exactly once")
            let provider = DestinationOnlyProvider(destination: previous, scene: scene)
            let view = PDFView(frame: CGRect(x: 0, y: 0, width: 680, height: 880))
            view.displayMode = .singlePageContinuous; view.displayDirection = .vertical; view.displayBox = .cropBox
            view.displaysPageBreaks = false; view.pageBreakMargins = .zero
            view.pageOverlayViewProvider = provider
            host.view.addSubview(view)
            view.document = document; view.autoScales = false; view.scaleFactor = 0.6
            view.go(to: previous)
            host.view.layoutIfNeeded(); view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            let overlay = try XCTUnwrap(provider.overlay)
            overlay.updateGeometry(); overlay.layoutIfNeeded()
            XCTAssertGreaterThan(overlay.timCrossPageLayer.renderedStrokeCount, 0)
            let sourceRect = view.convert(source.bounds(for: .cropBox), from: source)
            let previousRect = view.convert(previous.bounds(for: .cropBox), from: previous)
            XCTAssertEqual(sourceRect.minY, previousRect.maxY, accuracy: 0.5)
            // First verify the actual stacked compositor, then shrink the viewport
            // just above the seam so the source PDF page itself is no longer visible.
            for sourceOffscreen in [false, true] {
                if sourceOffscreen {
                    // Removing vertical centering can move the seam after the
                    // first resize (especially with a rotated, shorter source).
                    for _ in 0..<2 {
                        let seam = view.convert(source.bounds(for: .cropBox), from: source).minY
                        view.frame.size.height = seam - 1
                        view.layoutIfNeeded()
                        try await Task.sleep(for: .milliseconds(100))
                    }
                    overlay.updateGeometry()
                    let sourceAfterResize = view.convert(source.bounds(for: .cropBox), from: source)
                    let visibleIntersection = sourceAfterResize.intersection(view.bounds)
                    XCTAssertTrue(visibleIntersection.isNull || visibleIntersection.isEmpty,
                                  "Source geometry still intersects viewport: source=\(sourceAfterResize), viewport=\(view.bounds), rotation=\(rotation)")
                    // PDFKit conservatively lists a nearby page even when its
                    // converted crop rectangle is outside the viewport. The
                    // geometric assertion above plus source-overlay refusal
                    // establish the actual rendering precondition.
                }
                for zoom in (sourceOffscreen ? [0.6] : [0.6, 0.8]) {
                    if !sourceOffscreen { view.scaleFactor = zoom; view.layoutIfNeeded(); overlay.updateGeometry() }
                    let native = GammaTimInk.nativePoint(viewport: CGPoint(x: 100, y: -14.43),
                        cropBounds: source.bounds(for: .cropBox), rotation: rotation, spaceWidth: width, spaceHeight: height)
                    let crop = source.bounds(for: .cropBox)
                    let point = view.convert(CGPoint(x: crop.minX + native.x, y: crop.maxY - native.y), from: source)
                    let format = UIGraphicsImageRendererFormat(); format.scale = 2; format.opaque = true; format.preferredRange = .standard
                    let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
                        UIColor.white.setFill(); context.fill(view.bounds)
                        view.layer.render(in: context.cgContext)
                    }
                    let cg = try XCTUnwrap(image.cgImage)
                    let pixels = try XCTUnwrap(cg.dataProvider?.data) as Data
                    var black = 0
                    let px = Int(point.x * 2), py = Int(point.y * 2)
                    let top = max(0, py - 3), bottom = min(cg.height, py + 4)
                    let left = max(0, px - 3), right = min(cg.width, px + 4)
                    if top < bottom && left < right {
                        for y in top..<bottom {
                            for x in left..<right {
                                let offset = y * cg.bytesPerRow + x * 4
                                if max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 100 { black += 1 }
                            }
                        }
                    }
                    XCTAssertGreaterThan(black, 2, "Upper circle must paint ON opaque preceding page; rotation=\(rotation) zoom=\(zoom) sourceOffscreen=\(sourceOffscreen)")
                }
                if !sourceOffscreen { view.scaleFactor = 0.6; view.layoutIfNeeded(); overlay.updateGeometry() }
            }
            view.pageOverlayViewProvider = nil; view.removeFromSuperview()
        }
    }

    @MainActor
    func testContinuousPDFPagesHaveNoDecorativeGap() async throws {
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 400)
        let data = UIGraphicsPDFRenderer(bounds: bounds).pdfData { ctx in
            ctx.beginPage(); ctx.beginPage()
        }
        let document = try XCTUnwrap(PDFDocument(data: data))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let host = UIViewController(); window.rootViewController = host; window.makeKeyAndVisible()
        let view = InkPDFView(frame: host.view.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.displayMode = .singlePageContinuous; view.displayDirection = .vertical; view.displayBox = .cropBox
        host.view.addSubview(view)
        let coordinator = PDFInkView.Coordinator(); coordinator.attach(view)
        defer { coordinator.dismantle(); window.isHidden = true; oldKey?.makeKeyAndVisible() }
        coordinator.update(from: PDFInkView(document: document, loadDrawing: { _ in PKDrawing() },
            saveDrawing: { _, _ in }, onError: { XCTFail($0) }, isDrawing: false))
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(250))
        view.layoutIfNeeded()
        XCTAssertFalse(view.displaysPageBreaks)
        XCTAssertEqual(view.pageBreakMargins, .zero)
        let first = try XCTUnwrap(document.page(at: 0)), second = try XCTUnwrap(document.page(at: 1))
        let a = view.convert(first.bounds(for: .cropBox), from: first)
        let b = view.convert(second.bounds(for: .cropBox), from: second)
        XCTAssertEqual(b.minY, a.maxY, accuracy: 0.5, "Adjacent PDF pages must meet with no inserted gap")
    }
}
