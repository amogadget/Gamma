import XCTest
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

final class NoteStoreTests: XCTestCase {
    private var temporary: URL!
    private var store: NoteStore!
    private var input: URL!

    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        store = try NoteStore(rootURL: temporary.appendingPathComponent("Notes"))
        input = temporary.appendingPathComponent("sample.pdf")
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
        try renderer.writePDF(to: input) { context in
            for page in 0..<3 {
                context.beginPage()
                ("Page \(page + 1)" as NSString).draw(at: CGPoint(x: 40, y: 40), withAttributes: nil)
            }
        }
    }

    override func tearDownWithError() throws {
        if let temporary { try FileManager.default.removeItem(at: temporary) }
        store = nil
        temporary = nil
        input = nil
    }

    private func drawing(offset: CGFloat = 0) -> PKDrawing {
        let points = (0..<4).map { index in
            PKStrokePoint(location: CGPoint(x: 10 + CGFloat(index) * 12 + offset, y: 30 + offset),
                          timeOffset: Double(index) * 0.02, size: CGSize(width: 3, height: 3),
                          opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        let path = PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: 1))
        return PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black), path: path)])
    }

    private func drawingURL(_ note: Note, _ page: Int) -> URL {
        store.bundleURL(for: note.id).appendingPathComponent("drawings/page-\(page).drawing")
    }

    func testImportCreatesIndependentImmutableSourceAndReopens() throws {
        let original = try Data(contentsOf: input)
        let note = try store.importPDF(from: input)
        try Data("external file changed".utf8).write(to: input)
        let reopened = try NoteStore(rootURL: store.rootURL)
        XCTAssertEqual(try reopened.library().notes, [note])
        XCTAssertEqual(try reopened.document(for: note).pageCount, 3)
        XCTAssertEqual(try Data(contentsOf: store.bundleURL(for: note.id).appendingPathComponent("source.pdf")), original)
        XCTAssertEqual(note.title, "sample")
    }

    func testDuplicateImportGetsDistinctBundles() throws {
        let a = try store.importPDF(from: input)
        let b = try store.importPDF(from: input)
        XCTAssertNotEqual(a.id, b.id)
        try store.saveDrawing(noteID: a.id, page: 0, drawing: drawing())
        XCTAssertTrue(try store.loadDrawing(noteID: b.id, page: 0).strokes.isEmpty)
        XCTAssertEqual(try store.library().notes.count, 2)
    }

    func testDrawingSurvivesReopenAndPagesStayIsolated() throws {
        let note = try store.importPDF(from: input)
        try store.saveDrawing(noteID: note.id, page: 0, drawing: drawing())
        try store.saveDrawing(noteID: note.id, page: 2, drawing: drawing(offset: 80))
        let firstBytes = try Data(contentsOf: drawingURL(note, 0))
        let reopened = try NoteStore(rootURL: store.rootURL)
        XCTAssertEqual(try reopened.loadDrawing(noteID: note.id, page: 0).strokes.count, 1)
        XCTAssertTrue(try reopened.loadDrawing(noteID: note.id, page: 1).strokes.isEmpty)
        XCTAssertEqual(try reopened.loadDrawing(noteID: note.id, page: 2).strokes.first?.path.first?.location.x, 90)
        try reopened.saveDrawing(noteID: note.id, page: 2, drawing: PKDrawing())
        XCTAssertEqual(try Data(contentsOf: drawingURL(note, 0)), firstBytes)
        XCTAssertTrue(try reopened.loadDrawing(noteID: note.id, page: 2).strokes.isEmpty)
    }

    func testMissingDrawingIsBlankButDoesNotCreateFile() throws {
        let note = try store.importPDF(from: input)
        XCTAssertTrue(try store.loadDrawing(noteID: note.id, page: 1).strokes.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: drawingURL(note, 1).path))
    }

    func testCorruptDrawingNeverBecomesBlankOrOverwritten() throws {
        let note = try store.importPDF(from: input)
        let bad = Data("not a PencilKit archive".utf8)
        try bad.write(to: drawingURL(note, 0))
        let reopened = try NoteStore(rootURL: store.rootURL)
        XCTAssertThrowsError(try reopened.loadDrawing(noteID: note.id, page: 0))
        XCTAssertThrowsError(try reopened.saveDrawing(noteID: note.id, page: 0, drawing: PKDrawing()))
        XCTAssertThrowsError(try reopened.saveDrawing(noteID: note.id, page: 0, drawing: drawing()))
        XCTAssertEqual(try Data(contentsOf: drawingURL(note, 0)), bad)
        try reopened.saveDrawing(noteID: note.id, page: 1, drawing: drawing())
        XCTAssertEqual(try reopened.loadDrawing(noteID: note.id, page: 1).strokes.count, 1)
    }

    func testZeroByteDrawingIsCorruption() throws {
        let note = try store.importPDF(from: input)
        try Data().write(to: drawingURL(note, 0))
        XCTAssertThrowsError(try store.loadDrawing(noteID: note.id, page: 0))
        XCTAssertThrowsError(try store.saveDrawing(noteID: note.id, page: 0, drawing: drawing()))
        XCTAssertEqual(try Data(contentsOf: drawingURL(note, 0)).count, 0)
    }

    func testOutOfRangePagesAreRejected() throws {
        let note = try store.importPDF(from: input)
        for page in [-1, 3, Int.max] {
            XCTAssertThrowsError(try store.loadDrawing(noteID: note.id, page: page))
            XCTAssertThrowsError(try store.saveDrawing(noteID: note.id, page: page, drawing: drawing()))
        }
    }

    func testBadImportDoesNotPublishOrLeaveStaging() throws {
        try Data("not PDF".utf8).write(to: input)
        XCTAssertThrowsError(try store.importPDF(from: input))
        XCTAssertTrue(try store.library().notes.isEmpty)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: store.rootURL.path).isEmpty)
    }

    func testMissingImportDoesNotLeaveStaging() throws {
        try FileManager.default.removeItem(at: input)
        XCTAssertThrowsError(try store.importPDF(from: input))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: store.rootURL.path).isEmpty)
    }

    func testCorruptMetadataIsSurfacedAndPreserved() throws {
        let note = try store.importPDF(from: input)
        let url = store.bundleURL(for: note.id).appendingPathComponent("note.json")
        let bad = Data("broken json".utf8)
        try bad.write(to: url)
        let snapshot = try store.library()
        XCTAssertTrue(snapshot.notes.isEmpty)
        XCTAssertEqual(snapshot.issues.count, 1)
        XCTAssertThrowsError(try store.loadDrawing(noteID: note.id, page: 0))
        XCTAssertThrowsError(try store.saveDrawing(noteID: note.id, page: 0, drawing: PKDrawing()))
        XCTAssertEqual(try Data(contentsOf: url), bad)
    }

    func testMetadataIdentityAndVersionAreValidated() throws {
        let note = try store.importPDF(from: input)
        let url = store.bundleURL(for: note.id).appendingPathComponent("note.json")
        for invalid in [Note(id: UUID(), title: note.title, createdAt: note.createdAt, pageCount: 3, schemaVersion: 1),
                        Note(id: note.id, title: note.title, createdAt: note.createdAt, pageCount: 3, schemaVersion: 99),
                        Note(id: note.id, title: note.title, createdAt: note.createdAt, pageCount: 0, schemaVersion: 1)] {
            try JSONEncoder().encode(invalid).write(to: url)
            XCTAssertThrowsError(try store.readNote(id: note.id))
        }
    }

    func testMissingAndCorruptSourceAreSurfacedWithoutTouchingInk() throws {
        let note = try store.importPDF(from: input)
        try store.saveDrawing(noteID: note.id, page: 0, drawing: drawing())
        let ink = try Data(contentsOf: drawingURL(note, 0))
        let source = store.bundleURL(for: note.id).appendingPathComponent("source.pdf")
        try Data("bad PDF".utf8).write(to: source)
        XCTAssertThrowsError(try store.document(for: note))
        XCTAssertEqual(try store.library().issues.count, 1)
        try FileManager.default.removeItem(at: source)
        XCTAssertThrowsError(try store.document(for: note))
        XCTAssertEqual(try Data(contentsOf: drawingURL(note, 0)), ink)
    }

    func testMissingDrawingDirectoryIsNotBlank() throws {
        let note = try store.importPDF(from: input)
        try FileManager.default.removeItem(at: drawingURL(note, 0).deletingLastPathComponent())
        XCTAssertThrowsError(try store.loadDrawing(noteID: note.id, page: 0))
        XCTAssertThrowsError(try store.saveDrawing(noteID: note.id, page: 0, drawing: PKDrawing()))
    }

    func testRepeatedAtomicReplacementKeepsValidLatestPageAndOriginalPDF() throws {
        let note = try store.importPDF(from: input)
        let original = try Data(contentsOf: input)
        for index in 0..<20 {
            try store.saveDrawing(noteID: note.id, page: 0, drawing: drawing(offset: CGFloat(index)))
            let reopened = try NoteStore(rootURL: store.rootURL)
            XCTAssertEqual(try reopened.loadDrawing(noteID: note.id, page: 0).strokes.first?.path.first?.location.x,
                           CGFloat(10 + index))
        }
        XCTAssertEqual(try Data(contentsOf: store.bundleURL(for: note.id).appendingPathComponent("source.pdf")), original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: drawingURL(note, 0).deletingLastPathComponent().path),
                       ["page-0.drawing"])
    }

    func testInterruptedStagingIsNotPublished() throws {
        let staging = store.rootURL.appendingPathComponent(".import-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
        XCTAssertTrue(try store.library().notes.isEmpty)
        XCTAssertTrue(try store.library().issues.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: staging.path))
    }
}
