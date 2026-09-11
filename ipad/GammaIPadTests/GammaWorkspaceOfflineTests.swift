import XCTest
import UIKit
import PDFKit
@testable import GammaIPad

final class GammaWorkspaceOfflineTests: XCTestCase {
    func testOfflineIdentityIsDistinctPerServerAndUser() {
        let a = GammaOfflineIdentity(server: "https://one.example", username: "alice")
        let b = GammaOfflineIdentity(server: "https://two.example", username: "alice")
        let c = GammaOfflineIdentity(server: "https://one.example", username: "bob")
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertNotEqual(a.id, c.id)
    }

    func testOfflineEntryRequiresAllAssetsForReadyState() {
        let paper = GammaPaper(id: "p", parentID: "root", content: "Paper", properties: GammaProperties(docID: "d"))
        let entry = GammaOfflineEntry(pageID: paper.id, paper: paper, state: .failed,
                                      pdfReady: true, snapshotReady: true, audioReady: false)
        XCTAssertFalse(entry.pdfReady && entry.snapshotReady && entry.audioReady)
        XCTAssertEqual(entry.state, .failed)
    }
    @MainActor
    func testColdLocalEntryOpensPDFAndPlaysLocalUnuploadedAudio() async throws {
        let user = "offline-fixture-" + UUID().uuidString.lowercased()
        let server = URL(string: "https://offline-entry.invalid")!
        let cache = try GammaCache.application(server: server, username: user)
        defer { try? FileManager.default.removeItem(at: cache.rootURL) }
        let paper = GammaPaper(id: "page", parentID: "root", content: "Local PDF", properties: GammaProperties(docID: "doc"))
        try cache.saveLibrary([paper])
        let temporary = cache.rootURL.appendingPathComponent("fixture.pdf")
        try UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).writePDF(to: temporary) { $0.beginPage() }
        try cache.preserveSource(from: temporary, docID: "doc")
        var recording = GammaRecordingSession.new(pageID: paper.id)
        let segment = GammaAudioSegment(id: UUID().uuidString.lowercased(), duration: 0.25)
        recording.state = .stopped; recording.segments = [segment]
        let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: segment.id)
        try GammaRecordingTests.writeAudio(to: url)
        var snapshot = GammaPageCache(pageID: paper.id, docID: "doc", blocks: [paper])
        snapshot.blocks.append(GammaBlock(id: recording.id, parentID: paper.id, content: "Local audio",
            properties: GammaProperties(type: "audio", segments: [segment])))
        snapshot.recordings = [recording.id: recording]
        snapshot.outbox = [GammaMutation(kind: .audio, blockID: recording.id, parentID: paper.id, audioSession: recording)]
        try cache.savePage(snapshot)
        let workspace = GammaWorkspace()
        workspace.enterOffline(GammaOfflineIdentity(server: server.absoluteString, username: user))
        XCTAssertTrue(workspace.isOffline); XCTAssertNil(workspace.api); XCTAssertNil(workspace.webSession)
        XCTAssertEqual(workspace.papers.map(\.id), [paper.id])
        await workspace.open(paper)
        XCTAssertNotNil(workspace.document)
        await workspace.playRecording(recording.id)
        XCTAssertEqual(workspace.recorder.playbackRecordingID, recording.id)
        workspace.recorder.stopPlayback()
        await workspace.sync()
        XCTAssertEqual(try cache.loadPage(pageID: paper.id, docID: "doc").outbox.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    @MainActor
    func testCorruptSnapshotInvalidatesVisibleReadinessWithoutOverwritingBytes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: URL(string: "https://offline.test")!, username: "alice")
        let paper = GammaPaper(id: "page", parentID: "root", content: "PDF", properties: GammaProperties(docID: "doc"))
        try cache.savePage(GammaPageCache(pageID: paper.id, docID: "doc", blocks: [paper]))
        let entry = GammaOfflineEntry(pageID: paper.id, paper: paper, state: .ready, pdfReady: true, snapshotReady: true, audioReady: true)
        try cache.saveOfflineEntry(entry)
        let workspace = GammaWorkspace(cache: cache)
        workspace.offlineEntries[paper.id] = entry
        let path = cache.rootURL.appendingPathComponent("page-\(GammaCache.key(paper.id)).json")
        let corrupt = Data("broken".utf8); try corrupt.write(to: path)
        workspace.refreshOfflineStatus()
        XCTAssertEqual(workspace.offlineEntries[paper.id]?.state, .failed)
        XCTAssertEqual(workspace.offlineEntries[paper.id]?.snapshotReady, false)
        XCTAssertEqual(try Data(contentsOf: path), corrupt)
    }

}
