import XCTest
import PencilKit
@testable import GammaIPad

final class GammaTimInkCacheTests: XCTestCase {
    private var root: URL!
    private let reference = "/api/uploads/0123456789abcdef01234567.ink"
    // Whitespace is intentional: the persisted source must NOT be re-encoded.
    private let bytes = Data("{ \"format\":\"gamma-ink\",\"version\":1,\"space\":{\"kind\":\"pdf-page\",\"page\":2,\"width\":612,\"height\":792},\"strokes\":[] }\n".utf8)

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func cache(user: String = "alice", server: String = "https://gamma.example", workspace: String = "ws-a") throws -> GammaCache {
        try GammaCache(rootURL: root, server: URL(string: server)!, username: user, workspace: workspace)
    }
    private func snapshot() -> GammaPageCache {
        var page = GammaPageCache(pageID: "page", docID: "doc")
        page.blocks = [GammaBlock(id: "web-ink", content: "", properties: GammaProperties(pdfPage: 2, inkURL: reference))]
        page.timInkSources = ["web-ink": GammaTimInkSource(inkURL: reference, data: bytes)]
        return page
    }

    func testPropertiesRoundTripAndRepresentationsStaySeparate() throws {
        let block = try XCTUnwrap(snapshot().blocks.first)
        let data = try JSONEncoder().encode(block)
        let decoded = try JSONDecoder().decode(GammaBlock.self, from: data)
        XCTAssertEqual(decoded.properties.inkURL, reference)
        XCTAssertTrue(decoded.isTimInk)
        XCTAssertFalse(decoded.isInk)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("ink_url"))
        let native = GammaBlock(id: "native", content: "", properties: GammaProperties(type: "pdf_ink"))
        XCTAssertTrue(native.isInk)
        XCTAssertFalse(native.isTimInk)
        var mixed = native
        mixed.properties.inkURL = ""
        XCTAssertTrue(mixed.isTimInk)
        XCTAssertFalse(mixed.isInk)
        mixed.properties.inkURL = reference
        XCTAssertTrue(mixed.isTimInk)
        XCTAssertFalse(mixed.isInk)
    }

    func testExactBytesColdReopenAndAllIdentityCoordinates() throws {
        try cache().savePage(snapshot())
        let reopened = try cache().loadPage(pageID: "page", docID: "doc")
        XCTAssertEqual(reopened.timInkSources?["web-ink"]?.data, bytes)
        XCTAssertEqual(try reopened.decodedTimInk(for: reopened.blocks[0]).space.page, 2)
        XCTAssertTrue(reopened.drawings.isEmpty)
        XCTAssertTrue(reopened.outbox.isEmpty)
        for other in [try cache(user: "bob"), try cache(server: "https://other.example"), try cache(workspace: "ws-b")] {
            XCTAssertNil(try other.loadPage(pageID: "page", docID: "doc").timInkSources)
        }
        XCTAssertNil(try cache().loadPage(pageID: "another-page", docID: "doc").timInkSources)
        XCTAssertThrowsError(try cache().loadPage(pageID: "page", docID: "different-doc"))
    }

    func testChangedURLNeverFallsBackToStaleBytes() throws {
        var page = snapshot()
        page.blocks[0].properties.inkURL = "/api/uploads/ffffffffffffffffffffffff.ink"
        XCTAssertThrowsError(try page.decodedTimInk(for: page.blocks[0]))
        try cache().savePage(page)
        let reopened = try cache().loadPage(pageID: "page", docID: "doc")
        XCTAssertNil(reopened.timInkSources?["web-ink"])
        XCTAssertThrowsError(try reopened.decodedTimInk(for: reopened.blocks[0]))
    }

    func testMalformedUnsupportedAndWrongPageRemainErrors() throws {
        var page = snapshot()
        page.timInkSources?["web-ink"]?.data = Data("<html>not ink</html>".utf8)
        XCTAssertThrowsError(try page.decodedTimInk(for: page.blocks[0]))
        page = snapshot()
        page.blocks[0].properties.pdfPage = 1
        XCTAssertThrowsError(try page.decodedTimInk(for: page.blocks[0]))
        page = snapshot()
        page.blocks[0].properties.inkURL = ""
        XCTAssertThrowsError(try page.decodedTimInk(for: page.blocks[0]))
        page = snapshot()
        page.timInkSources?["web-ink"]?.data = Data(String(decoding: bytes, as: UTF8.self).replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8)
        XCTAssertThrowsError(try page.decodedTimInk(for: page.blocks[0]))
    }

    func testOlderSnapshotStillDecodesWithoutTimSources() throws {
        let data = Data(#"{"pageID":"page","docID":"doc","blocks":[],"drawings":{},"outbox":[]}"#.utf8)
        let page = try JSONDecoder().decode(GammaPageCache.self, from: data)
        XCTAssertNil(page.timInkSources)
        XCTAssertNil(page.timInkErrors)
    }

    func testOnlyCanonicalUploadReferencesAreAccepted() throws {
        XCTAssertEqual(try GammaAPI.timInkPath(reference), String(reference.dropFirst()))
        for invalid in ["https://gamma.example" + reference, reference + "?ws=other", reference + "#fragment",
                        "/api/uploads/../file.ink", "/api/uploads/%2e%2e.ink", "/api/assets/0123456789abcdef01234567.ink",
                        "/api/uploads/0123456789abcdef01234567.pdf", "/api/uploads/ABCDEF0123456789abcdef01.ink",
                        "/api/uploads/short.ink", "//evil.example" + reference] {
            XCTAssertThrowsError(try GammaAPI.timInkPath(invalid), invalid)
        }
        let unbound = try GammaAPI(server: "https://gamma.example")
        defer { unbound.close() }
        XCTAssertThrowsError(try unbound.makeRequest(GammaAPI.timInkPath(reference)))
        let bound = try GammaAPI(server: "https://gamma.example", workspace: "ws-a")
        defer { bound.close() }
        let request = try bound.makeRequest(GammaAPI.timInkPath(reference))
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-Workspace"), "ws-a")
    }

    @MainActor
    func testMixedRepresentationCannotSaveNativeDrawing() throws {
        let storage = try cache()
        var mixed = snapshot()
        mixed.blocks[0].properties.type = "pdf_ink"
        mixed.drawings["web-ink"] = Data("retained-native-bytes".utf8)
        try storage.savePage(mixed)
        let workspace = GammaWorkspace(cache: storage)
        workspace.page = mixed
        try workspace.saveDrawing(blockID: "web-ink", pdfPage: 1, drawing: PKDrawing())
        XCTAssertThrowsError(try workspace.editContent(blockID: "web-ink", text: "must not write"))
        XCTAssertEqual(workspace.page?.blocks.first?.content, "")
        XCTAssertEqual(workspace.page?.drawings["web-ink"], Data("retained-native-bytes".utf8))
        XCTAssertTrue(workspace.page!.outbox.isEmpty)
        XCTAssertTrue(try storage.loadPage(pageID: "page", docID: "doc").outbox.isEmpty)
    }

    @MainActor
    func testOfflineWorkspaceShowsReadOnlyInkAndVisibleFailures() throws {
        let storage = try cache()
        let workspace = GammaWorkspace(cache: storage)
        workspace.page = snapshot()
        XCTAssertEqual(workspace.timInk(pdfPage: 1).count, 1)
        XCTAssertTrue(workspace.timInk(pdfPage: 0).isEmpty)
        XCTAssertTrue(workspace.timInk(pdfPage: -1).isEmpty)
        var noPageMetadata = snapshot()
        noPageMetadata.blocks[0].properties.pdfPage = nil
        workspace.page = noPageMetadata
        XCTAssertEqual(workspace.timInk(pdfPage: 1).count, 1) // Source space.page is authoritative when absent.
        XCTAssertNil(workspace.timInkErrorMessage)
        var invalid = snapshot()
        invalid.blocks[0].properties.inkURL = "/api/uploads/ffffffffffffffffffffffff.ink"
        workspace.page = invalid
        workspace.reportTimInkErrors(invalid)
        XCTAssertTrue(workspace.timInk(pdfPage: 1).isEmpty)
        XCTAssertNotNil(workspace.errorMessage)
        XCTAssertNotNil(workspace.timInkErrorMessage)
        workspace.errorMessage = nil // Another action succeeds; reader warning remains.
        XCTAssertNotNil(workspace.timInkErrorMessage)
        workspace.page = snapshot()
        XCTAssertNil(workspace.timInkErrorMessage)
        XCTAssertTrue(workspace.page!.outbox.isEmpty)
        XCTAssertTrue(workspace.page!.drawings.isEmpty)
    }
}
