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

    func testOfflineManifestRoundTripsAndIdentityDiscovery() throws {
        let store = try cache()
        let paper = GammaPaper(id: "paper", parentID: nil, content: "Paper", properties: GammaProperties(docID: "doc"), children: nil, updatedAt: nil)
        let entry = GammaOfflineEntry(pageID: "paper", paper: paper, state: .ready, pdfReady: true, snapshotReady: true, audioReady: true, error: nil)
        try store.saveOfflineEntry(entry)
        XCTAssertEqual(try store.loadOfflineEntry(pageID: "paper"), entry)
        XCTAssertEqual(try GammaCache.discoverOfflineIdentities(rootURL: root), [GammaOfflineIdentity(server: "https://gamma.example", username: "alice")])
    }

    @MainActor
    func testRemovalProtectsPendingSnapshotAndRemovesOnlySafeFiles() throws {
        let store = try cache()
        let pdf = root.appendingPathComponent("download.pdf")
        try Data("pdf".utf8).write(to: pdf)
        try store.preserveSource(from: pdf, docID: "doc")
        var page = GammaPageCache(pageID: "paper", docID: "doc")
        let recordingID = UUID().uuidString.lowercased()
        let segmentID = UUID().uuidString.lowercased()
        page.recordings = [recordingID: GammaRecordingSession(id: recordingID, pageID: "paper", state: .stopped,
                                                               segments: [GammaAudioSegment(id: segmentID, duration: 1, asset: "/api/assets/a")])]
        page.blocks = [GammaBlock(id: recordingID, parentID: "paper", content: "Audio",
            properties: GammaProperties(type: "audio", audioState: "stopped", segments: page.recordings?[recordingID]?.segments))]
        try store.savePage(page)
        let audio = try GammaRecordingFiles.url(root: store.rootURL, recordingID: recordingID, segmentID: segmentID)
        try FileManager.default.createDirectory(at: audio.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: audio)
        let result = try store.removeRedownloadable(pageID: "paper", docID: "doc")
        XCTAssertFalse(result.protected); XCTAssertTrue(result.pdfRemoved); XCTAssertEqual(result.audioFilesRemoved, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.rootURL.appendingPathComponent("page-\(GammaCache.key("paper")).json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.sourceURL(docID: "doc").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: audio.path))
    }

    @MainActor
    func testRemovalProtectsUnuploadedRecordingAndCorruptSnapshot() throws {
        let store = try cache()
        let pdf = root.appendingPathComponent("download.pdf"); try Data("pdf".utf8).write(to: pdf); try store.preserveSource(from: pdf, docID: "doc")
        var page = GammaPageCache(pageID: "paper", docID: "doc")
        page.recordings = ["bad": GammaRecordingSession(id: "bad", pageID: "paper", state: .stopped, segments: [GammaAudioSegment(id: UUID().uuidString.lowercased(), duration: 1, asset: nil)])]
        try store.savePage(page)
        XCTAssertTrue(try store.removeRedownloadable(pageID: "paper", docID: "doc").protected)
        try Data("broken".utf8).write(to: store.rootURL.appendingPathComponent("page-\(GammaCache.key("paper")).json"))
        XCTAssertThrowsError(try store.removeRedownloadable(pageID: "paper", docID: "doc"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.sourceURL(docID: "doc").path))
    }

    func testDiskUsageIncludesNestedFiles() throws {
        let store = try cache(); try Data(repeating: 1, count: 7).write(to: store.rootURL.appendingPathComponent("one"))
        XCTAssertGreaterThanOrEqual(try store.diskUsage().bytes, 7)
    }

    func testManifestRejectsKeyOrPaperIdentityMismatch() throws {
        let store = try cache()
        let paper = GammaPaper(id: "paper", parentID: nil, content: "Paper", properties: GammaProperties(docID: "doc"), children: nil, updatedAt: nil)
        let entry = GammaOfflineEntry(pageID: "paper", paper: paper)
        let data = try JSONEncoder().encode(["wrong": entry])
        try data.write(to: store.rootURL.appendingPathComponent("offline.json"))
        XCTAssertThrowsError(try store.loadOfflineEntries())
    }

    func testExistingIdentityMismatchIsNotOverwritten() throws {
        let store = try cache()
        let identityURL = store.rootURL.appendingPathComponent("identity.json")
        let wrong = GammaOfflineIdentity(server: "https://other.example", username: "alice")
        try JSONEncoder().encode(wrong).write(to: identityURL)
        XCTAssertThrowsError(try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "alice"))
        XCTAssertEqual(try JSONDecoder().decode(GammaOfflineIdentity.self, from: Data(contentsOf: identityURL)), wrong)
    }
}
