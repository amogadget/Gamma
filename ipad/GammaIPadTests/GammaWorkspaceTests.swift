import XCTest
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

@MainActor
final class GammaWorkspaceTests: XCTestCase {
    private func withWorkspace(_ test: (GammaWorkspace, GammaCache) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "alice")
        let workspace = GammaWorkspace(cache: cache)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 400)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 300, height: 400))
        }
        let pdf = PDFDocument(); pdf.insert(PDFPage(image: image)!, at: 0); pdf.insert(PDFPage(image: image)!, at: 1)
        workspace.document = pdf
        workspace.page = GammaPageCache(pageID: "server-page", docID: "server-doc")
        try test(workspace, cache)
    }
    private func drawing() -> PKDrawing {
        let point = PKStrokePoint(location: CGPoint(x: 20, y: 30), timeOffset: 0, size: CGSize(width: 2, height: 2),
                                  opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        return PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
                                           path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
    }
    func testNewInkIsOneBlockAndMultipleSavesCoalesce() throws {
        try withWorkspace { workspace, cache in
            try workspace.newInk(pdfPage: 2)
            let id = try XCTUnwrap(workspace.selectedID)
            try workspace.saveDrawing(blockID: id, pdfPage: 1, drawing: drawing())
            try workspace.saveDrawing(blockID: id, pdfPage: 1, drawing: drawing())
            let snapshot = try cache.loadPage(pageID: "server-page", docID: "server-doc")
            XCTAssertEqual(snapshot.blocks.count, 1)
            XCTAssertEqual(snapshot.blocks.first?.parentID, "server-page")
            XCTAssertEqual(snapshot.blocks.first?.properties.pdfPage, 2)
            XCTAssertEqual(snapshot.outbox.count, 1)
            XCTAssertEqual(snapshot.outbox.first?.blockID, id)
        }
    }
    func testDelayedFlushUsesCapturedAnnotationNotMutableSelection() throws {
        try withWorkspace { workspace, cache in
            try workspace.newInk(pdfPage: 1)
            let first = try XCTUnwrap(workspace.selectedID)
            try workspace.newInk(pdfPage: 1)
            let second = try XCTUnwrap(workspace.selectedID)
            let ink = drawing()
            try workspace.saveDrawing(blockID: first, pdfPage: 0, drawing: ink)
            XCTAssertEqual(try workspace.drawing(blockID: first, pdfPage: 0).strokes.count, 1)
            XCTAssertEqual(try workspace.drawing(blockID: second, pdfPage: 0).strokes.count, 0)
            workspace.closeReader()
            try workspace.saveDrawing(blockID: first, pdfPage: 0, drawing: PKDrawing(),
                                      pageID: "server-page", docID: "server-doc")
            let reopened = try cache.loadPage(pageID: "server-page", docID: "server-doc")
            XCTAssertEqual(try PKDrawing(data: XCTUnwrap(reopened.drawings[first])).strokes.count, 0)
        }
    }
    func testOwnContentAndOrdinaryChildNotePersist() throws {
        try withWorkspace { workspace, cache in
            try workspace.newInk(pdfPage: 1)
            let ink = try XCTUnwrap(workspace.selectedID)
            try workspace.editContent(blockID: ink, text: "Annotation note")
            try workspace.addChild(parentID: ink)
            let child = try XCTUnwrap(workspace.selectedID)
            try workspace.editContent(blockID: child, text: "Normal child")
            let snapshot = try cache.loadPage(pageID: "server-page", docID: "server-doc")
            XCTAssertEqual(snapshot.blocks.first(where: { $0.id == ink })?.content, "Annotation note")
            XCTAssertEqual(snapshot.blocks.first(where: { $0.id == child })?.parentID, ink)
            XCTAssertFalse(try XCTUnwrap(snapshot.blocks.first(where: { $0.id == child })).isInk)
            XCTAssertEqual(snapshot.outbox.first(where: { $0.kind == .child })?.content, "Normal child")
        }
    }
    func testCoalescedParentEditStillSyncsBeforeNestedChild() throws {
        try withWorkspace { workspace, cache in
            try workspace.newInk(pdfPage: 1)
            let ink = try XCTUnwrap(workspace.selectedID)
            try workspace.addChild(parentID: ink)
            let parent = try XCTUnwrap(workspace.selectedID)
            try workspace.addChild(parentID: parent)
            let nested = try XCTUnwrap(workspace.selectedID)
            try workspace.editContent(blockID: parent, text: "Parent edited last")
            let snapshot = try cache.loadPage(pageID: "server-page", docID: "server-doc")
            XCTAssertEqual(GammaWorkspace.orderedOperations(snapshot).map(\.blockID), [ink, parent, nested])
            XCTAssertNotNil(UUID(uuidString: parent))
            XCTAssertNotNil(UUID(uuidString: nested))
        }
    }
}
