import XCTest
import AVFAudio
@testable import GammaIPad

final class GammaAudioLiveTests: XCTestCase {
    @MainActor
    func testActualAACUploadsAndAudioBlockOutboxReopens() async throws {
#if GAMMA_LIVE_TEST
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoopbackGammaProtocol.self]
        let api = try GammaAPI(server: "https://gamma-integration.invalid", configuration: config)
        defer { api.close() }
        _ = try await api.login(username: "ipad-integration", password: "disposable-test-password")
        let papers = try await api.papers()
        let paper = try XCTUnwrap(papers.first)
        let docID = try XCTUnwrap(paper.properties.docID)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "ipad-integration")
        let workspace = GammaWorkspace(cache: cache, api: api)
        workspace.page = GammaPageCache(pageID: paper.id, docID: docID)
        var recording = GammaRecordingSession.new(pageID: paper.id)
        var sourceBytes: [String: Data] = [:]
        for _ in 0..<2 {
            let id = UUID().uuidString.lowercased()
            let file = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: id)
            try GammaRecordingTests.writeAudio(to: file)
            sourceBytes[id] = try Data(contentsOf: file)
            recording.segments.append(GammaAudioSegment(id: id, duration: try GammaRecordingController.validatedDuration(file)))
            try workspace.saveRecording(recording, pageID: paper.id, docID: docID)
        }
        recording.replayEvents = [
            GammaReplayEvent(kind: .page, segmentID: recording.segments[0].id, start: 0, end: 0, pdfPage: 1),
            GammaReplayEvent(kind: .page, segmentID: recording.segments[1].id, start: 0, end: 0, pdfPage: 2),
            GammaReplayEvent(kind: .stroke, segmentID: recording.segments[1].id, start: 0.05, end: 0.15,
                             pdfPage: 2, blockID: "weak-ink-reference", strokeID: "test-stroke")]
        recording.state = .stopped
        try workspace.saveRecording(recording, pageID: paper.id, docID: docID)
        await workspace.sync()
        XCTAssertNil(workspace.errorMessage)
        XCTAssertEqual(workspace.pendingCount, 0)
        let tree = try await api.subtree(paper.id)
        let block = try XCTUnwrap(tree.flattened.first(where: { $0.id == recording.id }))
        XCTAssertTrue(block.isAudio)
        XCTAssertEqual(block.properties.audioRevision, 1)
        XCTAssertEqual(block.properties.segments?.count, 2)
        XCTAssertEqual(block.properties.audioState, "stopped")
        XCTAssertEqual(block.properties.replayEvents, recording.replayEvents)
        XCTAssertEqual(GammaReplay.page(at: 0.01, events: block.properties.replayEvents ?? [], segments: block.properties.segments ?? []), 1)
        XCTAssertEqual(GammaReplay.page(at: recording.segments[0].duration + 0.1,
            events: block.properties.replayEvents ?? [], segments: block.properties.segments ?? []), 2)
        let segments = try XCTUnwrap(block.properties.segments)
        XCTAssertEqual(segments[1].startTime, segments[0].duration)
        for segment in segments {
            let asset = try XCTUnwrap(segment.asset)
            let restored = try await api.asset(asset)
            XCTAssertEqual(restored, sourceBytes[segment.id])
        }
        let retried = try await api.putAudio(id: block.id, parent: paper.id, revision: 0, state: "stopped", segments: segments)
        XCTAssertEqual(retried.properties.audioRevision, 1)
        let freshCache = try GammaCache(rootURL: root, server: api.baseURL, username: "ipad-integration")
        let reopened = try freshCache.loadPage(pageID: paper.id, docID: docID)
        XCTAssertEqual(reopened.recordings?[recording.id]?.segments.count, 2)
        XCTAssertEqual(reopened.recordings?[recording.id]?.revision, 1)
        XCTAssertEqual(reopened.recordings?[recording.id]?.replayEvents, recording.replayEvents)
        XCTAssertTrue(reopened.outbox.isEmpty)
#else
        throw XCTSkip("Opt-in audio API integration: use GAMMA_LIVE_TEST and the disposable loopback backend.")
#endif
    }
}
