import XCTest
import Foundation
@testable import GammaIPad

@MainActor
final class GammaLocalLibraryMigrationTests: XCTestCase {
    private let page = "10000000-0000-4000-8000-000000000001"
    private let ink = "10000000-0000-4000-8000-000000000002"
    private let note = "10000000-0000-4000-8000-000000000003"
    private let child = "10000000-0000-4000-8000-000000000004"

    private func fixture() -> GammaPageCache {
        GammaPageCache(pageID: page, docID: "0123456789abcdef01234567", workspace: "local-library", blocks: [
            GammaBlock(id: child, parentID: note, content: "nested", properties: GammaProperties(nativeNote: true)),
            GammaBlock(id: page, content: "Original title", properties: GammaProperties(docID: "0123456789abcdef01234567")),
            GammaBlock(id: note, parentID: ink, content: "original note", properties: GammaProperties(nativeNote: true)),
            GammaBlock(id: ink, parentID: page, content: "ink caption", properties: GammaProperties(type: "pdf_ink", pdfPage: 1))
        ])
    }

    func testTopologicalOrderPreservesIDsAndNoteRelationships() throws {
        let source = fixture()
        let ordered = try GammaLocalLibraryMigration.orderedBlocks(source)
        XCTAssertEqual(ordered.map(\.id), [page, ink, note, child])
        XCTAssertEqual(ordered.last?.parentID, note)
        XCTAssertEqual(ordered.last?.content, "nested")
        XCTAssertEqual(source.blocks.first?.id, child, "Validation must not rewrite the retained source")
    }

    func testCyclesMissingParentsDuplicateIDsAndMissingRootRefused() {
        var value = fixture()
        value.blocks[2].parentID = child
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
        value = fixture(); value.blocks[0].parentID = UUID().uuidString.lowercased()
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
        value = fixture(); value.blocks.append(value.blocks[0])
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
        value = fixture(); value.blocks.remove(at: 1)
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
    }

    func testUnrepresentedPrimaryDataAndBrowserInkRefusedRatherThanDropped() {
        var value = fixture(); value.drawings[UUID().uuidString.lowercased()] = Data([1, 2, 3])
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
        value = fixture(); value.blocks[3].properties.inkURL = "/api/uploads/0123456789abcdef01234567.ink"
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
        value = fixture(); value.blocks[2].properties.nativeNote = nil
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
    }

    func testOutboxMustBeFullyCoveredAndLocal() throws {
        var value = fixture()
        value.outbox = [GammaMutation(kind: .child, blockID: note, parentID: ink, content: "original note", workspace: "local-library")]
        XCTAssertEqual(try GammaLocalLibraryMigration.orderedBlocks(value).count, 4)
        value.outbox[0].content = "unsaved replacement"
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
        value.outbox[0].content = "original note"; value.outbox[0].workspace = "remote"
        XCTAssertThrowsError(try GammaLocalLibraryMigration.orderedBlocks(value))
    }

    func testReceiptComparisonIgnoresReadbackChildrenButNotEditsOrParents() {
        let original = fixture().blocks[2]
        var current = original; current.children = [fixture().blocks[0]]
        XCTAssertTrue(GammaLocalLibraryMigration.equivalent(original, current))
        current.content = "backend edit"
        XCTAssertFalse(GammaLocalLibraryMigration.equivalent(original, current))
        current = original; current.parentID = page
        XCTAssertFalse(GammaLocalLibraryMigration.equivalent(original, current))
        current = original; current.properties.noteRevision = 2
        XCTAssertFalse(GammaLocalLibraryMigration.equivalent(original, current))
    }

    func testRemoteTargetRefusedBeforeAnySourceMutation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = Data("retained".utf8)
        let sentinel = root.appendingPathComponent("library.json")
        try original.write(to: sentinel)
        let client = try GammaAPI(server: "https://example.invalid", workspace: "remote")
        defer { client.close() }
        let cache = try GammaCache(rootURL: root.appendingPathComponent("destination"),
            server: URL(string: "https://example.invalid")!, username: "owner", workspace: "remote")
        do {
            _ = try await GammaLocalLibraryMigration.run(sourceRoot: root, client: client, destination: cache)
            XCTFail("Remote destination must never receive retained local data")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("verified embedded workspace"))
        }
        XCTAssertEqual(try Data(contentsOf: sentinel), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.rootURL.appendingPathComponent("local-library-migration-v1.json").path))
    }
}
