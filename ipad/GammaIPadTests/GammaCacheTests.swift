import XCTest
import PencilKit
@testable import GammaIPad

final class GammaCacheTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func cache(user: String = "alice", server: String = "https://gamma.example") throws -> GammaCache {
        try GammaCache(rootURL: root, server: URL(string: server)!, username: user)
    }
    func testAccountAndServerIsolationAndTrailingSlashCanonicalization() throws {
        let a = try cache()
        XCTAssertEqual(a.rootURL, try cache(server: "https://gamma.example/").rootURL)
        XCTAssertNotEqual(a.rootURL, try cache(user: "bob").rootURL)
        XCTAssertNotEqual(a.rootURL, try cache(server: "https://other.example").rootURL)
        let page = GammaPageCache(pageID: "gamma-page", docID: "gamma-doc")
        try a.savePage(page)
        XCTAssertTrue(try cache(user: "bob").pendingPages().isEmpty)
    }
    func testAtomicSnapshotReopensInkAndOutboxWithServerIdentity() throws {
        let store = try cache()
        let source = PKDrawing().dataRepresentation()
        var page = GammaPageCache(pageID: "existing-server-page", docID: "existing-doc")
        page.drawings["annotation-id"] = source
        page.outbox = [GammaMutation(kind: .ink, blockID: "annotation-id", parentID: page.pageID,
                                    drawing: source, pdfPage: 2, revision: 3)]
        try store.savePage(page)
        let reopened = try cache().loadPage(pageID: page.pageID, docID: page.docID)
        XCTAssertEqual(reopened.pageID, "existing-server-page")
        XCTAssertEqual(reopened.drawings["annotation-id"], source)
        XCTAssertEqual(reopened.outbox, page.outbox)
        XCTAssertEqual(try store.pendingPages().count, 1)
        XCTAssertThrowsError(try store.loadPage(pageID: page.pageID, docID: "different-doc"))
    }
    func testSourceIsImmutable() throws {
        let store = try cache()
        let temp = root.appendingPathComponent("temporary.pdf")
        try Data("original".utf8).write(to: temp)
        try store.preserveSource(from: temp, docID: "doc")
        try Data("replacement".utf8).write(to: temp)
        try store.preserveSource(from: temp, docID: "doc")
        XCTAssertEqual(try Data(contentsOf: store.sourceURL(docID: "doc")), Data("original".utf8))
    }
    func testCorruptSnapshotThrowsInsteadOfBlankFallback() throws {
        let store = try cache()
        let path = store.rootURL.appendingPathComponent("page-\(GammaCache.key("page")).json")
        let corrupt = Data("broken".utf8)
        try corrupt.write(to: path)
        XCTAssertThrowsError(try store.loadPage(pageID: "page", docID: "doc"))
        XCTAssertEqual(try Data(contentsOf: path), corrupt)
    }
    func testConflictsSurviveRelaunchAndDoNotDeleteDrawing() throws {
        let store = try cache()
        var page = GammaPageCache(pageID: "page", docID: "doc")
        let drawing = PKDrawing().dataRepresentation()
        page.drawings["ink"] = drawing
        page.outbox = [GammaMutation(kind: .ink, blockID: "ink", parentID: "page", drawing: drawing,
                                    pdfPage: 1, revision: 2, conflict: true)]
        try store.savePage(page)
        let reopened = try store.loadPage(pageID: "page", docID: "doc")
        XCTAssertTrue(try XCTUnwrap(reopened.outbox.first).conflict)
        XCTAssertEqual(reopened.drawings["ink"], drawing)
    }
}
