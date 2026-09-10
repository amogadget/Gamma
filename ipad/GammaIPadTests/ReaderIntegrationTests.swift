import XCTest
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

/// In-process framework integration, NOT Apple Pencil/touch or PDFKit lifecycle automation.
/// Provider and canvas-delegate callbacks are explicitly driven for deterministic coverage.
/// Each async XCTest entry point is main-actor isolated; no blocking XCTest waits or sleeps.
final class ReaderIntegrationTests: XCTestCase {
    @MainActor
    private final class Reader {
        let document: PDFDocument
        let view = InkPDFView(frame: .zero)
        let coordinator = PDFInkView.Coordinator()
        var loads: [Int] = []
        var saves: [(page: Int, drawing: PKDrawing)] = []
        var errors: [String] = []
        var stored: [Int: PKDrawing] = [:]
        var corruptPages: Set<Int> = []

        init() throws {
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
            let data = renderer.pdfData { context in
                for _ in 0..<2 {
                    context.beginPage()
                    UIColor.white.setFill()
                    context.cgContext.fill(CGRect(x: 0, y: 0, width: 612, height: 792))
                }
            }
            document = try XCTUnwrap(PDFDocument(data: data))
            view.displayMode = .singlePageContinuous
            view.displayDirection = .vertical
            view.displayBox = .cropBox
            coordinator.attach(view)
            // Suppress automatic PDFKit requests: tests drive the same provider methods
            // directly, without depending on virtualization or private subview structure.
            view.pageOverlayViewProvider = nil
            update()
        }

        func update(isDrawing: Bool = true) {
            coordinator.update(from: PDFInkView(document: document, loadDrawing: { [unowned self] page in
                loads.append(page)
                if corruptPages.contains(page) {
                    // Exercise a real PencilKit decoding failure, not a blank fallback.
                    return try PKDrawing(data: Data("not a PencilKit archive".utf8))
                }
                return stored[page] ?? PKDrawing()
            }, saveDrawing: { [unowned self] page, drawing in
                saves.append((page, drawing))
                stored[page] = drawing
            }, onError: { [weak self] message in
                self?.errors.append(message)
            }, isDrawing: isDrawing))
        }

        func page(_ index: Int) throws -> PDFPage {
            try XCTUnwrap(document.page(at: index))
        }

        func overlay(_ index: Int) throws -> InkPageOverlay {
            try XCTUnwrap(coordinator.pdfView(view, overlayViewFor: page(index)) as? InkPageOverlay)
        }

        func display(_ overlay: InkPageOverlay, page index: Int) throws {
            coordinator.pdfView(view, willDisplayOverlayView: overlay, for: try page(index))
        }

        func endDisplay(_ overlay: InkPageOverlay, page index: Int) throws {
            coordinator.pdfView(view, willEndDisplayingOverlayView: overlay, for: try page(index))
        }
    }

    @MainActor
    private static func drawing(offset: CGFloat = 0) -> PKDrawing {
        let points = (0..<4).map { index in
            PKStrokePoint(location: CGPoint(x: 40 + CGFloat(index) * 16 + offset, y: 70 + offset),
                          timeOffset: Double(index) * 0.02, size: CGSize(width: 3, height: 3),
                          opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        let path = PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: 1))
        return PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black), path: path)])
    }

    /// Barrier for the coordinator's already-enqueued main-queue error notification.
    /// This does not wait for rendering or pretend to synchronize Pencil input.
    @MainActor
    private static func drainEnqueuedMainCallbacks() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    @MainActor
    func testExplicitOverlayLifecycleLoadsCachesSavesAndReloadsByPage() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        let original = Self.drawing()
        let edited = Self.drawing(offset: 24)
        reader.stored[1] = original

        let overlay = try reader.overlay(1)
        try reader.display(overlay, page: 1)
        XCTAssertTrue(try reader.overlay(1) === overlay)
        XCTAssertEqual(reader.loads, [1])
        XCTAssertEqual(overlay.canvas.drawing.dataRepresentation(), original.dataRepresentation())
        XCTAssertTrue(overlay.acceptsInk)
        XCTAssertEqual(overlay.canvas.drawingPolicy, .pencilOnly)
        reader.coordinator.canvasViewDrawingDidChange(overlay.canvas)
        XCTAssertTrue(reader.saves.isEmpty, "Loading ink must not write it back")

        overlay.canvas.drawing = edited
        reader.coordinator.canvasViewDrawingDidChange(overlay.canvas)
        XCTAssertEqual(reader.saves.count, 1)
        XCTAssertEqual(reader.saves.last?.page, 1)
        XCTAssertEqual(reader.saves.last?.drawing.dataRepresentation(), edited.dataRepresentation())
        reader.coordinator.canvasViewDidEndUsingTool(overlay.canvas)
        try reader.endDisplay(overlay, page: 1)
        XCTAssertEqual(reader.saves.count, 1, "Unchanged end-of-tool/lifecycle callbacks must not duplicate saves")
        XCTAssertNil(overlay.canvas.delegate)
        XCTAssertFalse(overlay.acceptsInk)

        // PDFKit may display the very same overlay again after clean eviction.
        try reader.display(overlay, page: 1)
        XCTAssertEqual(reader.loads, [1, 1])
        XCTAssertEqual(overlay.canvas.drawing.dataRepresentation(), edited.dataRepresentation())
        XCTAssertTrue(try reader.overlay(0).canvas.drawing.strokes.isEmpty)
        XCTAssertEqual(reader.loads, [1, 1, 0])
        XCTAssertNil(reader.stored[0], "Another page's missing ink must not be saved")
        await Self.drainEnqueuedMainCallbacks()
        XCTAssertTrue(reader.errors.isEmpty)
    }

    @MainActor
    func testExplicitEndDisplayCapturesDrawingAndBlankClearingIsSaved() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        let overlay = try reader.overlay(0)
        try reader.display(overlay, page: 0)
        // Suppress automatic delegate delivery to prove end-display itself captures edits.
        overlay.canvas.delegate = nil
        overlay.canvas.drawing = Self.drawing()
        try reader.endDisplay(overlay, page: 0)
        XCTAssertEqual(reader.saves.count, 1)
        XCTAssertEqual(reader.saves.last?.drawing.strokes.count, 1)

        let reopened = try reader.overlay(0)
        XCTAssertEqual(reopened.canvas.drawing.strokes.count, 1)
        reopened.canvas.drawing = PKDrawing()
        reader.coordinator.canvasViewDrawingDidChange(reopened.canvas)
        XCTAssertEqual(reader.saves.count, 2)
        XCTAssertEqual(reader.saves.last?.page, 0)
        XCTAssertTrue(try XCTUnwrap(reader.saves.last).drawing.strokes.isEmpty,
                      "Clearing all ink is a save, not a missing-file/no-op")
        try reader.endDisplay(reopened, page: 0)
        XCTAssertTrue(try reader.overlay(0).canvas.drawing.strokes.isEmpty)
        XCTAssertEqual(reader.saves.count, 2)
    }

    @MainActor
    func testCorruptLoadDisablesInkAndAllExplicitWritePaths() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        reader.corruptPages.insert(0)
        let overlay = try reader.overlay(0)
        try reader.display(overlay, page: 0)
        XCTAssertFalse(overlay.acceptsInk)
        XCTAssertTrue(overlay.canvas.drawing.strokes.isEmpty)
        // Even a programmatic mutation must not overwrite the unreadable sidecar.
        overlay.canvas.drawing = Self.drawing()
        reader.coordinator.canvasViewDrawingDidChange(overlay.canvas)
        reader.coordinator.canvasViewDidEndUsingTool(overlay.canvas)
        reader.update(isDrawing: false)
        reader.update(isDrawing: true)
        XCTAssertFalse(overlay.acceptsInk, "Toggling reader mode must not re-enable a failed load")
        try reader.endDisplay(overlay, page: 0)
        XCTAssertTrue(try reader.overlay(0) === overlay, "Keep failed-load state instead of retrying as blank")
        XCTAssertEqual(reader.loads, [0])
        reader.coordinator.dismantle()
        await Self.drainEnqueuedMainCallbacks()
        XCTAssertTrue(reader.saves.isEmpty)
        XCTAssertNil(reader.stored[0])
        XCTAssertEqual(reader.errors.count, 1)
        XCTAssertTrue(reader.errors.first?.contains("Could not load ink for page 1") == true)
    }

    @MainActor
    func testCanonicalDrawingSurvivesWindowLayoutAndPDFZoomWithoutSave() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        let original = Self.drawing()
        reader.stored[0] = original
        let overlay = try reader.overlay(0)
        let root = UIViewController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 900, height: 1100))
        window.rootViewController = root
        // No key-window takeover. A visible window is needed by updateGeometry's guard.
        window.isHidden = false
        defer {
            overlay.removeFromSuperview()
            reader.view.removeFromSuperview()
            window.isHidden = true
            window.rootViewController = nil
        }
        root.view.addSubview(reader.view)
        // Deliberately mount in a known UIKit hierarchy, not PDFKit's private page views.
        // Public PDFKit/UIKit coordinate conversion remains real; provider placement is not tested.
        root.view.addSubview(overlay)
        try reader.display(overlay, page: 0)
        reader.view.autoScales = false
        reader.view.minScaleFactor = 0.25
        reader.view.maxScaleFactor = 4
        var canvasSizes: [CGSize] = []
        for (size, zoom) in [(CGSize(width: 800, height: 1000), CGFloat(1)),
                             (CGSize(width: 650, height: 850), CGFloat(2)),
                             (CGSize(width: 800, height: 1000), CGFloat(0.75))] {
            reader.view.frame = CGRect(origin: .zero, size: size)
            overlay.frame = reader.view.frame
            reader.view.scaleFactor = zoom
            reader.view.setNeedsLayout()
            reader.view.layoutIfNeeded()
            overlay.setNeedsLayout()
            overlay.layoutIfNeeded()
            overlay.updateGeometry()
            XCTAssertNotNil(overlay.window)
            XCTAssertFalse(overlay.canvas.isHidden, "Geometry conversion must actually succeed")
            XCTAssertEqual(overlay.canvas.zoomScale, zoom, accuracy: 0.001)
            XCTAssertEqual(overlay.canvas.bounds.width, overlay.cropBox.width * zoom, accuracy: 0.01)
            canvasSizes.append(overlay.canvas.bounds.size)
            XCTAssertEqual(overlay.canvas.drawing.dataRepresentation(), original.dataRepresentation(),
                           "Layout must transform the canvas, never canonical PKDrawing coordinates")
            reader.coordinator.canvasViewDrawingDidChange(overlay.canvas)
        }
        XCTAssertNotEqual(canvasSizes[0], canvasSizes[1], "Exercise a real canvas geometry change")
        try reader.endDisplay(overlay, page: 0)
        await Self.drainEnqueuedMainCallbacks()
        XCTAssertTrue(reader.saves.isEmpty, "Zoom/layout must not dirty loaded ink")
        XCTAssertTrue(reader.errors.isEmpty)
    }

    @MainActor
    func testBackgroundAndOtherPagesNeverEnterSelectedBlockSave() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        var saved: [PKDrawing] = []
        let background = Self.drawing(offset: 100)
        reader.coordinator.update(from: PDFInkView(
            document: reader.document, loadDrawing: { _ in PKDrawing() },
            saveDrawing: { page, ink in XCTAssertEqual(page, 1); saved.append(ink) },
            onError: { XCTFail($0) }, backgroundDrawing: { _ in background }, editablePage: 1,
            contentRevision: 1))
        let otherPage = try reader.overlay(0)
        let selected = try reader.overlay(1)
        XCTAssertFalse(otherPage.acceptsInk)
        XCTAssertTrue(selected.acceptsInk)
        XCTAssertFalse(selected.backgroundCanvas.isUserInteractionEnabled)
        XCTAssertNil(selected.backgroundCanvas.delegate)
        otherPage.canvas.drawing = Self.drawing()
        reader.coordinator.canvasViewDrawingDidChange(otherPage.canvas)
        selected.backgroundCanvas.drawing = Self.drawing(offset: 200)
        reader.coordinator.canvasViewDrawingDidChange(selected.backgroundCanvas)
        XCTAssertTrue(saved.isEmpty)
        selected.canvas.drawing = Self.drawing(offset: 20)
        reader.coordinator.canvasViewDrawingDidChange(selected.canvas)
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved.first?.strokes.count, 1)
        XCTAssertEqual(selected.backgroundCanvas.drawing.strokes.count, 1)
    }

    @MainActor
    func testRevisionSwitchFlushesOldBlockBeforeLoadingNewBlock() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        var oldSaves = 0
        var newSaves = 0
        let newInk = Self.drawing(offset: 90)
        reader.coordinator.update(from: PDFInkView(
            document: reader.document, loadDrawing: { _ in PKDrawing() },
            saveDrawing: { _, ink in oldSaves += 1; XCTAssertEqual(ink.strokes.count, 1) },
            onError: { XCTFail($0) }, editablePage: 0, contentRevision: 1))
        let overlay = try reader.overlay(0)
        overlay.canvas.delegate = nil
        overlay.canvas.drawing = Self.drawing()
        reader.coordinator.update(from: PDFInkView(
            document: reader.document, loadDrawing: { _ in newInk },
            saveDrawing: { _, _ in newSaves += 1 }, onError: { XCTFail($0) },
            editablePage: 0, contentRevision: 2))
        XCTAssertEqual(oldSaves, 1)
        XCTAssertEqual(newSaves, 0)
        XCTAssertEqual(overlay.canvas.drawing.dataRepresentation(), newInk.dataRepresentation())
        overlay.canvas.drawing = PKDrawing()
        reader.coordinator.canvasViewDrawingDidChange(overlay.canvas)
        XCTAssertEqual(oldSaves, 1)
        XCTAssertEqual(newSaves, 1)
    }

    @MainActor
    func testFailedOldSaveRejectsSelectionSwitchAndRetainsCallback() async throws {
        enum DiskError: Error { case full }
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        var failing = true
        var oldSaves = 0
        var newSaves = 0
        reader.coordinator.update(from: PDFInkView(
            document: reader.document, loadDrawing: { _ in PKDrawing() },
            saveDrawing: { _, _ in if failing { throw DiskError.full }; oldSaves += 1 },
            onError: { _ in }, editablePage: 0, contentRevision: 1))
        let overlay = try reader.overlay(0)
        overlay.canvas.drawing = Self.drawing()
        reader.coordinator.canvasViewDrawingDidChange(overlay.canvas)
        let next = PDFInkView(document: reader.document, loadDrawing: { _ in PKDrawing() },
            saveDrawing: { _, _ in newSaves += 1 }, onError: { _ in },
            editablePage: 1, contentRevision: 2)
        reader.coordinator.update(from: next)
        XCTAssertTrue(overlay.acceptsInk)
        XCTAssertEqual(overlay.canvas.drawing.strokes.count, 1)
        XCTAssertEqual(newSaves, 0)
        failing = false
        reader.coordinator.update(from: next)
        XCTAssertEqual(oldSaves, 1)
        XCTAssertEqual(newSaves, 0)
        XCTAssertFalse(overlay.acceptsInk)
        await Self.drainEnqueuedMainCallbacks()
    }

    @MainActor
    func testReplayFramesNeverOverwriteFinalEditableInk() async throws {
        let reader = try Reader()
        defer { reader.coordinator.dismantle() }
        let final = Self.drawing()
        reader.stored[0] = final
        let overlay = try reader.overlay(0)
        try reader.display(overlay, page: 0)
        var saves = 0
        reader.coordinator.update(from: PDFInkView(document: reader.document, loadDrawing: { _ in final },
            saveDrawing: { _, _ in saves += 1 }, onError: { XCTFail($0) }, isDrawing: false,
            replayActive: true, replayDrawing: { _ in PKDrawing() }))
        XCTAssertTrue(overlay.isReplaying)
        XCTAssertTrue(overlay.replayCanvas.drawing.strokes.isEmpty)
        XCTAssertEqual(overlay.canvas.drawing.strokes.count, 1)
        XCTAssertFalse(overlay.acceptsInk)
        reader.coordinator.canvasViewDrawingDidChange(overlay.replayCanvas)
        reader.coordinator.update(from: PDFInkView(document: reader.document, loadDrawing: { _ in final },
            saveDrawing: { _, _ in saves += 1 }, onError: { XCTFail($0) }))
        XCTAssertFalse(overlay.isReplaying)
        XCTAssertEqual(overlay.canvas.drawing.strokes.count, 1)
        XCTAssertEqual(saves, 0)
    }
}
