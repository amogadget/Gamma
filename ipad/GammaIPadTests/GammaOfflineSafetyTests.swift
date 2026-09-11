import XCTest
@testable import GammaIPad

final class GammaOfflineSafetyTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    private func cache() throws -> GammaCache {
        try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "alice")
    }

    private func source(_ cache: GammaCache, docID: String = "doc") throws {
        let temporary = root.appendingPathComponent("source.pdf")
        try Data("pdf".utf8).write(to: temporary)
        try cache.preserveSource(from: temporary, docID: docID)
    }

    @MainActor
    func testPendingPageSharingDocumentProtectsSourcePDF() throws {
        let store = try cache(); try source(store)
        try store.savePage(GammaPageCache(pageID: "page-a", docID: "doc", outbox: [GammaMutation(kind: .content, blockID: "n", parentID: "page-a")]))
        try store.savePage(GammaPageCache(pageID: "page-b", docID: "doc"))
        let result = try store.removeRedownloadable(pageID: "page-b", docID: "doc")
        XCTAssertTrue(result.protected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.sourceURL(docID: "doc").path))
    }

    @MainActor
    func testCorruptUnrelatedPageFailsClosed() throws {
        let store = try cache(); try source(store)
        try store.savePage(GammaPageCache(pageID: "target", docID: "doc"))
        try Data("corrupt".utf8).write(to: store.rootURL.appendingPathComponent("page-\(GammaCache.key("unrelated")).json"))
        XCTAssertThrowsError(try store.removeRedownloadable(pageID: "target", docID: "doc"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.sourceURL(docID: "doc").path))
    }

    @MainActor
    func testEveryNonStoppedOrRecoveryRecordingStateProtects() throws {
        for state in [GammaRecordingSession.State.recording, .paused, .interrupted, .recoveryRequired] {
            let store = try cache(); try source(store)
            var page = GammaPageCache(pageID: "page", docID: "doc")
            let id = UUID().uuidString.lowercased()
            page.recordings = [id: GammaRecordingSession(id: id, pageID: page.pageID, state: state)]
            try store.savePage(page)
            XCTAssertTrue(try store.removeRedownloadable(pageID: page.pageID, docID: page.docID).protected, "state \(state)")
        }
    }

    @MainActor
    func testAudioBlockWithoutRecordingDictionaryProtects() throws {
        let store = try cache(); try source(store)
        let segment = GammaAudioSegment(id: UUID().uuidString.lowercased(), duration: 1, asset: "/api/assets/audio")
        var page = GammaPageCache(pageID: "page", docID: "doc")
        page.blocks = [GammaBlock(id: "audio", parentID: page.pageID, content: "", properties: GammaProperties(type: "audio", segments: [segment]))]
        try store.savePage(page)
        XCTAssertTrue(try store.removeRedownloadable(pageID: page.pageID, docID: page.docID).protected)
    }

    @MainActor
    func testConflictBackupProtectsLocalFiles() throws {
        let store = try cache(); try source(store)
        var page = GammaPageCache(pageID: "page", docID: "doc")
        page.drawings["audio-conflict-backup-recording"] = Data("archived local recording".utf8)
        try store.savePage(page)
        let result = try store.removeRedownloadable(pageID: page.pageID, docID: page.docID)
        XCTAssertTrue(result.protected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.sourceURL(docID: page.docID).path))
    }

    func testFailingInitialIdentityWriteIsReportedWithoutWritingIdentity() throws {
        enum DiskFailure: Error { case full }
        XCTAssertThrowsError(try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "alice", writeOverride: { _, _ in throw DiskFailure.full }))
        let account = root.appendingPathComponent(GammaCache.key("https://gamma.example\nalice"), isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: account.appendingPathComponent("identity.json").path))
    }
}
