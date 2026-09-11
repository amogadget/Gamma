import XCTest
import AVFAudio
import PDFKit
@testable import GammaIPad

final class GammaOfflineLiveTests: XCTestCase {
    @MainActor
    func testOfflinePreparationDownloadsRemoteAudioReusesLocalAudioAndSyncsEdits() async throws {
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
        try cache.saveLibrary([paper])

        // URLSession download tasks are intentionally not claimed by the loopback
        // protocol. Seed the immutable source exactly as the download path would.
        let pdfConfig = URLSessionConfiguration.ephemeral
        pdfConfig.protocolClasses = [LoopbackGammaProtocol.self]
        let pdfSession = URLSession(configuration: pdfConfig)
        defer { pdfSession.invalidateAndCancel() }
        let (pdfData, pdfResponse) = try await pdfSession.data(for: api.makeRequest("api/uploads/\(docID).pdf"))
        XCTAssertEqual((pdfResponse as? HTTPURLResponse)?.statusCode, 200)
        let pdfFixture = root.appendingPathComponent("source.pdf")
        try pdfData.write(to: pdfFixture)
        try cache.preserveSource(from: pdfFixture, docID: docID)

        let workspace = GammaWorkspace(cache: cache, api: api)
        workspace.papers = [paper]
        await workspace.open(paper)
        XCTAssertEqual(workspace.paper?.id, paper.id)
        XCTAssertNotNil(workspace.document)

        // Create a real remote audio block. Keep the first segment local and
        // remove only the second one below, proving reuse and remote acquisition.
        var recording = GammaRecordingSession.new(pageID: paper.id)
        var localBytes: Data?
        var missingSegmentID: String?
        for index in 0..<2 {
            let segmentID = UUID().uuidString.lowercased()
            let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: segmentID)
            try GammaRecordingTests.writeAudio(to: url)
            let bytes = try Data(contentsOf: url)
            if index == 0 { localBytes = bytes } else { missingSegmentID = segmentID }
            recording.segments.append(GammaAudioSegment(id: segmentID, duration: try GammaRecordingController.validatedDuration(url)))
        }
        recording.state = .stopped
        try workspace.saveRecording(recording, pageID: paper.id, docID: docID)
        await workspace.sync()
        XCTAssertEqual(workspace.pendingCount, 0, workspace.errorMessage ?? "audio should upload")

        let remote = try await api.subtree(paper.id)
        let remoteAudio = try XCTUnwrap(remote.flattened.first(where: { $0.id == recording.id && $0.isAudio }))
        XCTAssertEqual(remoteAudio.properties.segments?.count, 2)

        let reusableURL = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id,
                                                       segmentID: recording.segments[0].id)
        let missingURL = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id,
                                                      segmentID: try XCTUnwrap(missingSegmentID))
        let expectedLocalBytes = try XCTUnwrap(localBytes)
        XCTAssertEqual(try Data(contentsOf: reusableURL), expectedLocalBytes)
        try FileManager.default.removeItem(at: missingURL)

        // Queue preparation while the reader is open. It must not switch the
        // current document, page, selection, or mutate the reader's in-memory page.
        let selectedBefore = workspace.selectedID
        workspace.enqueueDownloads([paper])
        let deadline = Date().addingTimeInterval(30)
        var prepared = false
        while Date() < deadline {
            let entries = try cache.loadOfflineEntries()
            if entries[paper.id]?.state == .ready {
                prepared = true
                break
            }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertTrue(prepared, "offline preparation did not reach ready")
        XCTAssertEqual(workspace.paper?.id, paper.id)
        XCTAssertEqual(workspace.selectedID, selectedBefore)
        XCTAssertEqual(workspace.page?.pageID, paper.id)
        XCTAssertEqual(try Data(contentsOf: reusableURL), expectedLocalBytes)
        XCTAssertGreaterThan(try GammaRecordingController.validatedDuration(missingURL), 0)

        // Reopen the same account cache without an API session and verify the
        // prepared PDF/audio are usable locally.
        let offline = GammaWorkspace(cache: cache)
        offline.papers = [paper]
        await offline.open(paper)
        XCTAssertEqual(offline.paper?.id, paper.id)
        XCTAssertNotNil(offline.document)
        XCTAssertEqual(offline.page?.recordings?[recording.id]?.segments.count, 2)

        // Make an offline edit, then inject the authenticated workspace and
        // sync it back to the same server account.
        try offline.newInk(pdfPage: 1)
        let inkID = try XCTUnwrap(offline.selectedID)
        try offline.editContent(blockID: inkID, text: "offline live note")
        let authenticated = GammaWorkspace(cache: cache, api: api)
        authenticated.papers = [paper]
        await authenticated.open(paper)
        await authenticated.sync()
        XCTAssertEqual(authenticated.pendingCount, 0, authenticated.errorMessage ?? "offline edit should sync")
        let final = try await api.subtree(paper.id)
        XCTAssertEqual(final.flattened.first(where: { $0.id == inkID })?.content, "offline live note")
#else
        throw XCTSkip("Opt-in live backend test: use GAMMA_LIVE_TEST and the disposable loopback backend.")
#endif
    }
}
